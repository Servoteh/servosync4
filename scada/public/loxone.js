// Nova zgrada (Loxone) — frontend. Koristi WS "live" (state-UUID -> vrednost) za
// sobne temperature/brzine/režim; komande preko /api/loxone/write.
let D = { tags: [], values: {}, live: {} };
const byKey = {};

async function init() {
  D = await (await fetch('/api/loxone')).json();
  D.tags.forEach(t => byKey[t.key] = t);
  document.getElementById('hostinfo').textContent = 'Loxone Miniserver · ' + (D.host || '');
  render();
  connectWS(); tick(); setInterval(tick, 1000);
}

// --- helpers za vrednosti ---
const live = u => (u != null ? D.live[u] : undefined);
const ctrl = k => { const s = D.values[k]; return s ? s.value : undefined; };
function st(tag, name) {                       // state preko WS, fallback control-vrednost
  const u = tag.states && tag.states[name];
  const v = live(u);
  return v !== undefined ? v : undefined;
}
const num = (v, d = 1) => (v == null || isNaN(v)) ? null : Number(v).toFixed(d);
function onOf(tag) {                            // da li je switch uključen
  const a = st(tag, 'active'); if (a !== undefined) return a > 0;
  return parseFloat(ctrl(tag.key)) > 0;
}

const PLANT = 'Tehnicka soba', YARD = 'Dvoriste';

// CILJ logika za sobu: tempTarget ako >0; inače aktivni komfor (hlađenje ako je toplo).
function roomCalc(rc) {
  const ta = st(rc, 'tempActual'), tt = st(rc, 'tempTarget');
  const ch = st(rc, 'comfortTemperature'), cc = st(rc, 'comfortTemperatureCool');
  // tempTarget>0 => aktivno grejanje (cilj = tempTarget); =0 => hlađenje (cilj = komfor hlađenja)
  const heat = !!(tt && tt > 0);
  const cilj = heat ? tt : cc;
  return { ta, tt, cilj, cooling: !heat, ch, cc, mode: heat ? 'heat' : 'cool' };
}
async function roomTemp(key, mode, value) {
  const r = await fetch('/api/loxone/roomtemp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, mode, value }) });
  if (!r.ok) alert('Greska: ' + (await r.json()).error);
}

function render() {
  const rooms = {};
  for (const t of D.tags) (rooms[t.room] || (rooms[t.room] = [])).push(t);

  // PROSTORIJE — agregovana pločica po sobi
  const rEl = document.getElementById('rooms'); rEl.innerHTML = '';
  for (const room of Object.keys(rooms).sort()) {
    if (room === PLANT || room === YARD) continue;
    rEl.appendChild(roomTile(room, rooms[room]));
  }
  // POSTROJENJE + DVORIŠTE — lista kontrola
  renderList('plant', rooms[PLANT] || []);
  renderList('yard', rooms[YARD] || []);
  paint();
}

function roomTile(room, tags) {
  const rc = tags.find(t => t.type === 'IRoomControllerV2');
  const klima = tags.find(t => t.type === 'Switch');
  const fan = tags.find(t => t.type === 'ValueSelector');
  const el = document.createElement('div'); el.className = 'tile glass';
  let h = `<h3>${room}</h3>`;
  if (rc) {
    h += `<div class="rtop">
        <div class="seg" data-room="${rc.key}" data-f="tempActual">--<span class="u">°C</span></div>
        <div class="rmeta">
          <span class="badge2" data-badge="${rc.key}">—</span>
          <div class="cilj">CILJ
            <button class="stepbtn sm" data-rt="${rc.key}" data-d="-0.5">−</button>
            <b data-cilj="${rc.key}">--</b><span class="cu">°C</span>
            <button class="stepbtn sm" data-rt="${rc.key}" data-d="0.5">+</button></div>
          <div class="cmode" data-cmode-lbl="${rc.key}"></div>
        </div></div>`;
  }
  if (klima) h += `<div class="lxrow"><span class="ln">Klimatizacija</span>
      <span class="tgl off" data-key="${klima.key}" data-keep="1"><span class="knob"></span></span></div>`;
  if (fan) {
    const max = Math.round(st(fan, 'max') ?? 3);
    let btns = '';
    for (let n = 0; n <= max; n++) btns += `<button class="stepbtn" data-fan="${fan.key}" data-n="${n}">${n}</button>`;
    h += `<div class="lxrow"><span class="ln">Ventilator (brzina)</span><span class="steps" data-steps="${fan.key}">${btns}</span></div>`;
  }
  el.innerHTML = h; return el;
}

function renderList(elId, tags) {
  const root = document.getElementById(elId); root.innerHTML = '';
  for (const t of tags) {
    let w;
    if (t.kind === 'switch') w = `<span class="tgl off" data-key="${t.key}" data-keep="1"><span class="knob"></span></span>`;
    else if (t.type === 'ValueSelector') {
      const max = st(t, 'max') ?? 0;
      if (max && max <= 5) {                    // mali opseg (npr. brzina) -> dugmad
        let b = ''; for (let n = 0; n <= Math.round(max); n++) b += `<button class="stepbtn" data-fan="${t.key}" data-n="${n}">${n}</button>`;
        w = `<span class="steps" data-steps="${t.key}">${b}</span>`;
      } else w = `<span class="vset"><b data-v="${t.key}" data-f="value">--</b><input type="number" step="1" id="i_${t.key}"><button data-set="${t.key}">OK</button></span>`;
    }
    else w = `<b class="vread" data-v="${t.key}" data-f="${t.type === 'Heatmixer' ? 'tempActual' : 'value'}">--</b>`;
    const el = document.createElement('div'); el.className = 'tile glass';
    el.innerHTML = `<div class="lxrow"><span class="ln">${t.name}</span>${w}</div>`;
    root.appendChild(el);
  }
}

function fmtVal(s) {
  if (s == null) return '--';
  const x = String(s); const m = x.match(/^(-?\d+)\.0+$/); if (m) return m[1];
  return x;
}

function paint() {
  // sobne temperature (WS state)
  document.querySelectorAll('[data-room]').forEach(el => {
    const t = byKey[el.dataset.room]; const v = st(t, el.dataset.f);
    el.childNodes[0].nodeValue = v != null ? num(v) : '--';
  });
  // CILJ (nikad 0) + badge + oznaka režima
  document.querySelectorAll('[data-cilj]').forEach(el => {
    const c = roomCalc(byKey[el.dataset.cilj]); el.textContent = c.cilj != null ? num(c.cilj) : '--';
  });
  document.querySelectorAll('[data-cmode-lbl]').forEach(el => {
    const c = roomCalc(byKey[el.dataset.cmodeLbl]); el.textContent = c.cooling ? '❄ hlađenje' : '🔥 grejanje';
  });
  document.querySelectorAll('[data-badge]').forEach(el => {
    const c = roomCalc(byKey[el.dataset.badge]);
    el.classList.remove('b-cool', 'b-heat', 'b-ok');
    if (c.cooling) { el.textContent = 'HLAĐENJE'; el.classList.add('b-cool'); }
    else { el.textContent = 'GREJANJE'; el.classList.add('b-heat'); }
  });
  // read vrednosti (Heatmixer/analog/value)
  document.querySelectorAll('[data-v]').forEach(el => {
    const t = byKey[el.dataset.v]; let v = st(t, el.dataset.f);
    if (v === undefined) v = ctrl(t.key);
    el.textContent = fmtVal(v != null ? (typeof v === 'number' ? num(v, 1) : v) : null);
  });
  // value inputi (ne diraj dok korisnik kuca)
  document.querySelectorAll('[id^="i_"]').forEach(inp => {
    const t = byKey[inp.id.slice(2)]; let v = st(t, 'value'); if (v === undefined) v = parseFloat(ctrl(t.key));
    if (document.activeElement !== inp && v != null && !isNaN(v)) inp.value = Math.round(v);
  });
  // switch toggle
  document.querySelectorAll('[data-key]').forEach(el => {
    const on = onOf(byKey[el.dataset.key]); el.classList.toggle('on', !!on); el.classList.toggle('off', !on);
  });
  // fan step dugmad — aktivni nivo
  document.querySelectorAll('[data-steps]').forEach(box => {
    const t = byKey[box.dataset.steps]; let v = st(t, 'value'); if (v === undefined) v = parseFloat(ctrl(t.key));
    v = Math.round(v || 0);
    box.querySelectorAll('.stepbtn').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === v));
  });
}

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'loxone') { D.values = m.values || {}; D.live = m.live || {}; setBadge(m.wsReady ? 'online' : 'sim', m.wsReady ? 'LOXONE ONLINE' : 'LOXONE (HTTP)'); paint(); }
  };
  ws.onclose = () => { setBadge('offline', 'VEZA PREKINUTA'); setTimeout(connectWS, 2000); };
}
function setBadge(c, t) { const b = document.getElementById('conn'); b.className = 'badge ' + c; b.textContent = t; }

async function write(key, value) {
  const r = await fetch('/api/loxone/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
  if (!r.ok) alert('Greska: ' + (await r.json()).error);
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-key],[data-set],[data-fan],[data-rt]'); if (!el) return;
  if (el.dataset.rt) {                          // CILJ temperatura sobe ±0.5
    const rc = byKey[el.dataset.rt], c = roomCalc(rc);
    if (c.cilj == null) return;
    const nv = Math.round((c.cilj + Number(el.dataset.d)) * 2) / 2;
    if (confirm(`${rc.name}: ${c.mode === 'cool' ? 'hlađenje' : 'grejanje'} CILJ → ${nv}°C?\n(menja Loxone UZIVO)`)) roomTemp(rc.key, c.mode, nv);
    return;
  }
  if (el.dataset.fan) {                         // brzina 0/1/2/3
    const t = byKey[el.dataset.fan], n = Number(el.dataset.n);
    if (confirm(`${t.name}: brzina ${n}?`)) write(el.dataset.fan, n);
  } else if (el.dataset.key) {                  // switch on/off
    const t = byKey[el.dataset.key], on = el.classList.contains('on');
    if (confirm(`${t.name}: ${on ? 'ISKLJUCITI' : 'UKLJUCITI'}?\n(menja Loxone UZIVO)`)) write(el.dataset.key, on ? 0 : 1);
  } else if (el.dataset.set) {                  // value selector (veci opseg)
    const t = byKey[el.dataset.set], inp = document.getElementById('i_' + el.dataset.set);
    const v = parseInt(inp.value, 10); if (isNaN(v)) return;
    if (confirm(`Postaviti ${t.name} = ${v}?`)) write(el.dataset.set, v);
  }
});
function tick() { const c = document.getElementById('clock'); if (c) c.textContent = new Date().toLocaleString('sr-RS'); }
init();

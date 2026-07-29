// Hala 5 (Siemens S7-1200, AWP web most) — frontend
let S = null;   // poslednji snapshot

async function init() {
  try { S = await (await fetch('/api/s7')).json(); } catch (e) { S = { online: false, error: 'fetch' }; }
  document.getElementById('hostinfo').textContent = 'Siemens S7-1200 · ' + (S.host || 'nije konfigurisan');
  render();
  connectWS(); tick(); setInterval(tick, 1000);
}

function setBadge(c, t) { const b = document.getElementById('conn'); b.className = 'badge ' + c; b.textContent = t; }
function fmt(v) { return v == null ? '--' : (Math.round(v * 10) / 10).toLocaleString('sr-RS'); }

// ---- jedan toggle (komanda bool) ----
function toggleBtn(label, on, tag, onVal, offVal, color) {
  const val = on ? offVal : onVal;   // klik invertuje
  return `<button class="modebtn ${on ? 'active' : ''}" data-tag="${tag}" data-val="${val}"
            data-label="${label} → ${on ? 'ISKLJUČITI' : 'UKLJUČITI'}">${label}</button>`;
}

function renderModes(m) {
  const host = document.getElementById('modes');
  const card = (title, inner) => `<div class="zone glass"><div class="zname">${title}</div>${inner}</div>`;
  host.innerHTML =
    card('Rad', `<div class="modebtns">
        <button class="modebtn ${m.auto ? 'active' : ''}" data-tag="Web_Automatski_Rezim" data-val="1" data-label="Prebaciti na AUTOMATSKI">AUTO</button>
        <button class="modebtn ${m.manual ? 'active' : ''}" data-tag="Web_Automatski_Rezim" data-val="0" data-label="Prebaciti na RUČNI">RUČNI</button>
      </div>`) +
    card('Grejanje / Hlađenje', `<div class="modebtns">
        <button class="modebtn ${m.heating ? 'active' : ''}" data-tag="Web_Grejanje" data-val="1" data-label="Prebaciti na GREJANJE" style="--ac:#ff8a3c">GREJANJE</button>
        <button class="modebtn ${m.cooling ? 'active' : ''}" data-tag="Web_Grejanje" data-val="0" data-label="Prebaciti na HLAĐENJE" style="--ac:#3aa0ff">HLAĐENJE</button>
      </div>`) +
    card('Kotao', `<div class="modebtns">${toggleBtn(m.boiler ? 'KOTAO RADI' : 'KOTAO STOJI', m.boiler, 'Web_Ukljucenje_kotla_rucno', 1, 0)}</div>`) +
    card('E-STOP', `<div class="zval"><b style="font-size:1.1rem;color:${m.estopOk ? 'var(--grn)' : 'var(--red)'}">${m.estopOk ? 'OK' : 'AKTIVAN'}</b></div>
        <div class="sub">web e-stop: ${m.webEstop ? 'uključen' : 'isključen'}</div>`);
}

function renderTemps(temps, setpoint) {
  const host = document.getElementById('temps');
  let h = temps.map(t => `<div class="zone glass">
      <div class="zname">${t.label}</div>
      <div class="zval">${t.fault ? '<b style="font-size:1rem;color:var(--amb)">senzor u kvaru</b>'
        : `<b>${fmt(t.value)}</b><span class="zu">°C</span>`}</div>
    </div>`).join('');
  // setpoint sa -/+ i OK
  h += `<div class="zone glass">
      <div class="zname">Željena temperatura</div>
      <div class="zval"><b id="sp">${setpoint}</b><span class="zu">°C</span></div>
      <div class="modebtns">
        <button class="modebtn" data-sp="-1">−</button>
        <button class="modebtn" data-sp="1">+</button>
        <button class="modebtn" id="spok" data-spok="1">OK</button>
      </div></div>`;
  host.innerHTML = h;
}

function renderPumps(pumps) {
  document.getElementById('pumps').innerHTML = pumps.map(p => {
    const cmd = p.cmd
      ? `<button class="modebtn ${p.on ? 'active' : ''}" data-tag="${p.cmd}" data-val="${p.on ? 0 : 1}"
           data-label="${p.label} → ${p.on ? 'ISKLJUČITI' : 'UKLJUČITI'}">${p.on ? 'ISKLJUČI' : 'UKLJUČI'}</button>`
      : '';
    const sub = [];
    if (p.confirm != null) sub.push('potvrda: ' + (p.confirm ? '✓' : '—'));
    if (p.timer) sub.push('⏱ ručni tajmer');
    return `<div class="zone glass">
        <div class="zname">${p.label} <span class="led ${p.on ? 'on' : 'off'}"></span></div>
        <div class="zval"><b style="font-size:1.1rem;color:${p.on ? 'var(--grn)' : 'var(--mut)'}">${p.on ? 'RADI' : 'STOJI'}</b></div>
        <div class="sub">${sub.join(' · ') || '&nbsp;'}</div>
        <div class="modebtns">${cmd}</div>
      </div>`;
  }).join('');
}

function renderKal(kal) {
  document.getElementById('kal').innerHTML = kal.map(k => `
    <div class="kalcell glass ${k.on ? 'on' : ''}" data-tag="${k.cmd}" data-val="${k.on ? 0 : 1}"
         data-label="${k.label} → ${k.on ? 'ISKLJUČITI' : 'UKLJUČITI'}" title="${k.label} (klik = ${k.on ? 'isključi' : 'uključi'})">
      <span class="kln">${k.key}</span>
      <span class="led ${k.on ? 'on' : 'off'}"></span>
      <span class="klc">${k.confirm ? '✓' : ''}</span>
    </div>`).join('');
}

function renderAlarms(alarms) {
  const host = document.getElementById('alarms');
  const bar = document.getElementById('alarmbar');
  const reds = alarms.filter(a => a.sev === 'alarm');
  if (reds.length) { bar.classList.remove('hidden'); bar.textContent = `⚠ ${reds.length} aktivnih alarma`; }
  else bar.classList.add('hidden');
  if (!alarms.length) { host.innerHTML = '<div class="panel glass"><div class="sub">Nema aktivnih alarma ✓</div></div>'; return; }
  host.innerHTML = '<div class="panel glass">' + alarms.map(a => {
    const col = a.sev === 'warn' ? 'var(--orange)' : a.sev === 'info' ? 'var(--blue)' : 'var(--red)';
    const rst = a.reset ? `<button class="modebtn" data-tag="${a.reset}" data-val="1" data-label="RESET: ${a.text}">RESET</button>` : '';
    return `<div class="row"><span><span class="stxt" style="background:${col}22;color:${col}">${a.word}.${a.bit}</span> ${a.text}</span>${rst}</div>`;
  }).join('') + '</div>';
}

// RASPORED: po hali Početak/Kraj sat (−/+ pa OK piše Vreme_Poc/Kraj_Hn)
function schedField(kind, h, val, wvar) {
  const id = `${kind}_${h}`;
  return `<div class="schedrow2">
      <span class="sl">${kind === 'poc' ? 'Početak' : 'Kraj'}</span>
      <button class="modebtn sm" data-sched="${kind}" data-h="${h}" data-d="-1">−</button>
      <b id="${id}">${val}</b><span class="zu">h</span>
      <button class="modebtn sm" data-sched="${kind}" data-h="${h}" data-d="1">+</button>
      <button class="modebtn sm" data-schedok="${id}" data-var="${wvar}" data-hala="${h}" data-kind="${kind}">OK</button>
    </div>`;
}
function renderSched(sched) {
  document.getElementById('sched').innerHTML = (sched || []).map(s => `
    <div class="zone glass">
      <div class="zname">Hala ${s.hala}</div>
      ${schedField('poc', s.hala, s.start, s.pocVar)}
      ${schedField('kraj', s.hala, s.end, s.krajVar)}
    </div>`).join('');
}

function render() {
  setBadge(S.online ? 'online' : 'offline', S.online ? 'HALA 5 ONLINE' : (S.error ? 'GREŠKA' : 'OFFLINE'));
  if (!S.temps) { document.getElementById('temps').innerHTML = `<div class="zone glass"><div class="sub">${S.error || 'nema podataka — proveri S7_HOST u .env'}</div></div>`; return; }
  renderModes(S.modes); renderTemps(S.temps, S.setpoint);
  renderPumps(S.pumps); renderKal(S.kaloriferi); renderSched(S.schedule); renderAlarms(S.alarms);
}

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 's7') { S = m; render(); } };
  ws.onclose = () => { setBadge('offline', 'VEZA PREKINUTA'); setTimeout(connectWS, 2000); };
}

async function write(tag, value) {
  const r = await fetch('/api/s7/write', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag, value }),
  });
  if (!r.ok) alert('Greška: ' + ((await r.json()).error || r.status));
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-tag],[data-sp],[data-spok],[data-sched],[data-schedok]');
  if (!el) return;
  if (el.dataset.tag) {                       // komanda / toggle / reset
    const msg = (el.dataset.label || ('Komanda ' + el.dataset.tag)) + '\n(menja postrojenje UŽIVO)';
    if (confirm(msg + ' — potvrditi?')) write(el.dataset.tag, Number(el.dataset.val));
  } else if (el.dataset.sp) {                  // setpoint -/+
    const sp = document.getElementById('sp');
    let v = (parseInt(sp.textContent, 10) || 20) + Number(el.dataset.sp);
    v = Math.max(10, Math.min(30, v)); sp.textContent = v;
  } else if (el.dataset.spok) {                // setpoint OK
    const v = parseInt(document.getElementById('sp').textContent, 10);
    if (confirm(`Postaviti željenu temperaturu = ${v}°C?\n(menja postrojenje UŽIVO)`)) write('Zeljena_temperatura', v);
  } else if (el.dataset.sched) {               // raspored -/+
    const b = document.getElementById(`${el.dataset.sched}_${el.dataset.h}`);
    let v = (parseInt(b.textContent, 10) || 0) + Number(el.dataset.d);
    b.textContent = Math.max(0, Math.min(23, v));
  } else if (el.dataset.schedok) {             // raspored OK -> upis Vreme_Poc/Kraj_Hn
    const v = parseInt(document.getElementById(el.dataset.schedok).textContent, 10);
    const kind = el.dataset.kind === 'poc' ? 'POČETAK' : 'KRAJ';
    if (confirm(`Hala ${el.dataset.hala}: postaviti ${kind} rada = ${v}:00 h?\n(menja postrojenje UŽIVO)`)) write(el.dataset.var, v);
  }
});
function tick() { const c = document.getElementById('clock'); if (c) c.textContent = new Date().toLocaleString('sr-RS'); }
init();

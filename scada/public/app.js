// Kotlarnica SCADA — frontend (moderni glassmorphism)
let TAGS = [], ZONES = [], LAST = {};
const byName = {};
const tagsOf = p => TAGS.filter(p);

async function init() {
  const meta = await (await fetch('/api/tags')).json();
  TAGS = meta.tags; ZONES = meta.zones;
  TAGS.forEach(t => byName[t.name] = t);
  buildModebar(); buildPlant(); buildZones(); buildSched(); buildStatus(); buildManual();
  connectWS(); tick(); setInterval(tick, 1000);
  loadTrends(); setInterval(loadTrends, 60000);
}

/* ---------- TRENDOVI ---------- */
const TREND_COLORS = ['#3fe0d8','#ff8a3c','#3aa0ff','#2ee27a','#f2b53c','#ff5a5a','#b07cff','#7ad1ff'];
async function loadTrends() {
  let d; try { d = await (await fetch('/api/history')).json(); } catch (e) { return; }
  const temps = d.tags.filter(t => t.kind === 'temp');
  const cv = document.getElementById('trend'); if (!cv) return;
  const w = cv.width = cv.clientWidth || 800, h = cv.height;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, w, h);
  const pad = { l: 38, r: 10, t: 10, b: 20 };
  // opseg
  let min = Infinity, max = -Infinity, tmin = Infinity, tmax = -Infinity, any = false;
  for (const t of temps) for (const p of (d.series[t.name] || [])) { any = true; if (p.v < min) min = p.v; if (p.v > max) max = p.v; if (p.t < tmin) tmin = p.t; if (p.t > tmax) tmax = p.t; }
  if (!any) { ctx.fillStyle = '#93a6bb'; ctx.font = '13px Segoe UI'; ctx.fillText('Nema podataka još (skuplja se 1 uzorak/min)…', pad.l, h / 2); return; }
  if (min === max) { min -= 1; max += 1; }
  const X = t => pad.l + (w - pad.l - pad.r) * (tmax === tmin ? 0.5 : (t - tmin) / (tmax - tmin));
  const Y = v => pad.t + (h - pad.t - pad.b) * (1 - (v - min) / (max - min));
  // grid + ose
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.fillStyle = '#93a6bb'; ctx.font = '10px Consolas';
  for (let i = 0; i <= 4; i++) { const v = min + (max - min) * i / 4, y = Y(v); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke(); ctx.fillText(v.toFixed(1), 4, y + 3); }
  // linije
  temps.forEach((t, i) => {
    const pts = d.series[t.name] || []; if (!pts.length) return;
    ctx.strokeStyle = TREND_COLORS[i % TREND_COLORS.length]; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, j) => { const x = X(p.t), y = Y(p.v); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  });
  document.getElementById('trendleg').innerHTML = temps.map((t, i) =>
    `<span class="lg"><i style="background:${TREND_COLORS[i % TREND_COLORS.length]}"></i>${t.label}</span>`).join('');
}

const tgl = (attr, name) => `<span class="tgl off" ${attr}="${name}" data-keep="1"><span class="knob"></span></span>`;

/* ---------- MODE BAR ---------- */
function buildModebar() {
  document.getElementById('modebar').innerHTML = `
    <div class="modecard glass">
      <div class="mc-icon" id="grej_icon">🔥</div>
      <div class="mc-mid"><div class="mc-label">REZIM RADA · MB26</div><div class="mc-value" id="grej_val">—</div></div>
      <div class="mtoggle"><span class="mt-l">GREJ</span>
        <span class="tgl mgrej off" data-cmode="GREJ_HLAD" data-keep="1"><span class="knob"></span></span>
        <span class="mt-r">HLAD</span></div>
    </div>
    <div class="modecard glass">
      <div class="mc-icon" id="auto_icon">⚙</div>
      <div class="mc-mid"><div class="mc-label">UPRAVLJANJE · MB14</div><div class="mc-value" id="auto_val">—</div></div>
      <div class="mtoggle"><span class="mt-l">RUC</span>
        <span class="tgl off" data-cmode="AUTO_MAN" data-keep="1"><span class="knob"></span></span>
        <span class="mt-r">AUTO</span></div>
    </div>`;
}

/* ---------- PLANT SYNOPTIC ---------- */
function buildPlant() {
  const led = (x, y, n) => `<circle cx="${x}" cy="${y}" r="6" data-svgled="${n}" fill="rgba(255,255,255,.12)"/>`;
  const pump = (x, y, n, lbl) => `<g>
      <circle cx="${x}" cy="${y}" r="16" class="p-box"/>
      <path d="M${x - 7},${y} L${x + 6},${y - 7} L${x + 6},${y + 7} Z" fill="#6f8aa6"/>
      ${led(x + 14, y - 12, n)}
      <text x="${x}" y="${y + 31}" text-anchor="middle" class="p-lbl">${lbl}</text></g>`;
  const el = document.getElementById('plant'); el.className = 'plant glass';
  el.innerHTML = `
  <svg viewBox="0 0 820 250">
    <path class="p-pipe flow" d="M140,110 H190"/>
    <path class="p-pipe flow" d="M320,110 H372"/>
    <path class="p-pipe flow" d="M462,110 H540"/>
    <path class="p-pipe" d="M620,110 H660 V40 H800"/>
    <path class="p-pipe" d="M620,110 H660 V110 H800"/>
    <path class="p-pipe" d="M620,110 H660 V180 H800"/>
    <rect x="20" y="65" width="120" height="90" rx="10" class="p-box"/>
    <text x="80" y="90" text-anchor="middle" class="p-lbl">KOTAO</text>
    <text x="80" y="120" text-anchor="middle" id="kot_icon" style="font-size:26px">🔥</text>
    ${led(128, 78, 'KOTAO_RAD')}
    <rect x="190" y="65" width="130" height="90" rx="10" class="p-box"/>
    <text x="255" y="92" text-anchor="middle" class="p-lbl">TOPLOTNA</text>
    <text x="255" y="108" text-anchor="middle" class="p-lbl">PUMPA</text>
    ${led(308, 78, 'TOPLOTNA_PUMPA')}
    <text x="255" y="140" text-anchor="middle" class="p-lbl" style="font-size:10px;fill:#93a6bb">VFD</text>
    ${led(232, 134, 'FREKVENTNI_RUN')}
    <rect x="372" y="50" width="90" height="120" rx="12" class="p-box"/>
    <text x="417" y="44" text-anchor="middle" class="p-lbl">SUD / HAP FLUID</text>
    <text x="417" y="118" text-anchor="middle" class="p-val" data-val="T_SUDA" style="font-size:22px">--</text>
    <text x="417" y="138" text-anchor="middle" class="p-lbl" style="font-size:10px;fill:#93a6bb">°C</text>
    ${pump(560, 70, 'P1', 'P1')}${pump(610, 70, 'P2', 'P2')}
    ${pump(560, 150, 'P3', 'P3')}${pump(610, 150, 'P4', 'P4')}
    <text x="585" y="205" text-anchor="middle" class="p-lbl" style="fill:#93a6bb">PUMPE</text>
    <text x="805" y="34" text-anchor="end" class="p-lbl" style="fill:#3fe0d8">→ ZONE</text>
  </svg>`;
}

/* ---------- ZONE TILES ---------- */
function buildZones() {
  const root = document.getElementById('zones'); root.innerHTML = '';
  for (const z of ZONES) {
    const temps = tagsOf(t => t.zone === z.key && t.kind === 'temp');
    const sps   = tagsOf(t => t.zone === z.key && t.kind === 'setpoint');
    const devs  = tagsOf(t => t.zone === z.key && t.kind === 'device');
    if (!temps.length && !sps.length && !devs.length) continue;
    let h = `<h3>${z.title}</h3>`;
    if (temps.length) {
      h += `<div class="seg"><span data-val="${temps[0].name}">--</span><span class="u">°C</span></div>`;
      if (temps[1]) h += `<div class="sub">${temps[1].label}: <b data-val="${temps[1].name}">--</b> °C</div>`;
    } else h += `<div class="seg">—</div>`;
    for (const sp of sps) h += `<div class="spbox"><label>${sp.label}</label>
        <input type="number" step="0.1" id="in_${sp.name}"><button data-apply="${sp.name}">OK</button></div>`;
    for (const d of devs) h += `<div class="devrow">${fanSVG(d.name)}
        <span class="dn">${d.label}</span>
        <span class="dst off" data-stxt="${d.name}">—</span>
        ${d.manual ? tgl('data-toggle', d.manual) : ''}
        ${d.sw ? `<span class="swled">prek.<span class="led" data-led="${d.sw}"></span></span>` : ''}</div>`;
    const el = document.createElement('div'); el.className = 'tile glass'; el.innerHTML = h; root.appendChild(el);
  }
}
function fanSVG(name) {
  return `<svg class="fan off" data-fan="${name}" viewBox="0 0 40 40">
    <circle cx="20" cy="20" r="16" class="ring"/>
    <g class="blades">
      <ellipse class="bl" cx="20" cy="10" rx="3.5" ry="8.5"/><ellipse class="bl" cx="20" cy="30" rx="3.5" ry="8.5"/>
      <ellipse class="bl" cx="10" cy="20" rx="8.5" ry="3.5"/><ellipse class="bl" cx="30" cy="20" rx="8.5" ry="3.5"/>
    </g><circle cx="20" cy="20" r="3" fill="#eef4fb"/></svg>`;
}

/* ---------- SCHEDULE ---------- */
function buildSched() {
  const times = tagsOf(t => t.kind === 'schedtime'), days = tagsOf(t => t.kind === 'schedday');
  const wins = [...new Set(times.map(t => t.window))];
  let h = `<div class="panel glass">`;
  for (const w of wins) {
    const on = times.find(t => t.window === w && t.edge === 'ON');
    const off = times.find(t => t.window === w && t.edge === 'OFF');
    h += `<div class="schedrow"><span class="swin">${w}</span>
        <span class="stime">⏻ paljenje <input type="time" id="in_${on.name}"><button data-apply="${on.name}">OK</button></span>
        <span class="stime">⭘ gasenje <input type="time" id="in_${off.name}"><button data-apply="${off.name}">OK</button></span></div>`;
  }
  h += `<div class="daystrip"><span class="dlab">Aktivni dani:</span>`;
  for (const d of days) h += `<button class="daybtn off" data-toggle="${d.name}" data-keep="1">${d.label}</button>`;
  h += `</div></div>`;
  document.getElementById('sched').innerHTML = h;
}

/* ---------- STATUS & ALARMS ---------- */
function buildStatus() {
  const st = tagsOf(t => t.kind === 'status'), al = tagsOf(t => t.kind === 'alarm');
  const row = t => `<div class="row"><span>${t.label}</span><span class="right">
      <span class="stxt off" data-stxt="${t.name}">—</span><span class="led" data-led="${t.name}"></span></span></div>`;
  let h = `<div class="panel glass"><h3>STATUS POSTROJENJA (uživo)</h3>`;
  for (const t of st) h += row(t);
  h += `<h3 style="margin-top:14px">ALARMI</h3>`;
  for (const t of al) h += row(t);
  h += `<div class="row" style="border:none"><span>Reset greske VFD</span><button class="btn-cmd" data-cmd="RESET_VFD">RESET</button></div></div>`;
  document.getElementById('statusbox').innerHTML = h;
}

/* ---------- MANUAL OVERVIEW ---------- */
function buildManual() {
  const m = tagsOf(t => t.kind === 'manual');
  let h = `<div class="panel glass"><div class="switchgrid">`;
  for (const t of m) h += `<div class="swcell">${tgl('data-toggle', t.name)}
     <span class="swlbl">${t.label}<br><small>${t.op}</small></span></div>`;
  h += `</div></div>`;
  document.getElementById('manual').innerHTML = h;
}

/* ---------- LIVE ---------- */
function connectWS() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'state') render(m); };
  ws.onclose = () => { badge('offline', 'VEZA PREKINUTA'); setTimeout(connectWS, 2000); };
}
function render(msg) {
  const v = msg.values; LAST = {}; for (const k in v) LAST[k] = v[k].value;
  if (msg.simulate) badge('sim', 'SIMULACIJA'); else badge(msg.online ? 'online' : 'offline', msg.online ? 'PLC ONLINE' : 'PLC OFFLINE');

  const gh = v.GREJ_HLAD && v.GREJ_HLAD.value;     // 1=hladjenje
  setText('grej_val', gh ? 'HLADJENJE' : 'GREJANJE'); cls('grej_val', 'mc-value ' + (gh ? 'hlad' : 'grej'));
  setText('grej_icon', gh ? '❄' : '🔥'); setText('kot_icon', gh ? '❄' : '🔥');
  const am = v.AUTO_MAN && v.AUTO_MAN.value;
  setText('auto_val', am ? 'AUTOMATSKI' : 'RUCNO'); cls('auto_val', 'mc-value ' + (am ? 'auto' : 'man'));
  document.querySelectorAll('.p-pipe.flow').forEach(p => p.classList.toggle('heat', !gh));

  document.querySelectorAll('[data-val]').forEach(el => {
    const t = byName[el.dataset.val], s = v[el.dataset.val];
    el.textContent = (s && s.value !== null) ? fmt(s.value, t) : '--';
  });
  tagsOf(t => t.kind === 'setpoint' || t.kind === 'schedtime').forEach(t => {
    const i = document.getElementById('in_' + t.name);
    if (i && document.activeElement !== i && v[t.name] && v[t.name].value !== null) i.value = v[t.name].value;
  });
  document.querySelectorAll('[data-fan]').forEach(el => {
    const on = v[el.dataset.fan] && v[el.dataset.fan].value;
    el.classList.toggle('on', !!on); el.classList.toggle('off', !on);
  });
  document.querySelectorAll('[data-led]').forEach(el => ledHtml(el, byName[el.dataset.led], v[el.dataset.led]));
  document.querySelectorAll('[data-svgled]').forEach(el => {
    const on = v[el.dataset.svgled] && v[el.dataset.svgled].value;
    el.setAttribute('fill', on ? '#2ee27a' : 'rgba(255,255,255,.12)');
  });
  document.querySelectorAll('[data-stxt]').forEach(el => {
    const t = byName[el.dataset.stxt], s = v[el.dataset.stxt], on = s && s.value;
    el.classList.remove('on', 'off', 'alarm');
    if (t && t.kind === 'alarm') { el.textContent = on ? 'ALARM' : 'OK'; el.classList.add(on ? 'alarm' : 'off'); }
    else { el.textContent = on ? 'RADI' : 'STOJI'; el.classList.add(on ? 'on' : 'off'); }
  });
  document.querySelectorAll('[data-toggle]').forEach(el => {
    const on = v[el.dataset.toggle] && v[el.dataset.toggle].value;
    el.classList.toggle('on', !!on); el.classList.toggle('off', !on);
    if (!el.dataset.keep) el.textContent = on ? 'UKLJ' : 'ISK';
  });
  document.querySelectorAll('[data-cmode]').forEach(el => {
    const on = v[el.dataset.cmode] && v[el.dataset.cmode].value;
    el.classList.toggle('on', !!on); el.classList.toggle('off', !on);
  });

  const act = tagsOf(t => t.kind === 'alarm' && v[t.name] && v[t.name].value).map(t => t.label);
  const bar = document.getElementById('alarmbar');
  if (act.length) { bar.textContent = '⚠ ALARM: ' + act.join('   |   '); bar.classList.remove('hidden'); }
  else bar.classList.add('hidden');
  setText('modeinfo', msg.simulate ? 'simulacija' : (msg.online ? 'PLC povezan' : 'PLC nije povezan'));
}
function ledHtml(el, t, s) {
  const on = s && s.value; el.classList.remove('on', 'off', 'alarm');
  if (t && t.kind === 'alarm') el.classList.add(on ? 'alarm' : 'off'); else el.classList.add(on ? 'on' : 'off');
}
function fmt(val, t) { return (t && (t.kind === 'temp' || t.kind === 'setpoint')) ? Number(val).toFixed(1) : val; }
function setText(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; }
function cls(id, c) { const e = document.getElementById(id); if (e) e.className = c; }
function badge(c, t) { const b = document.getElementById('conn'); b.className = 'badge ' + c; b.textContent = t; }

/* ---------- WRITE (uz potvrdu) ---------- */
async function write(name, value) {
  const r = await fetch('/api/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, value }) });
  if (!r.ok) alert('Greska pri upisu: ' + (await r.json()).error);
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-apply],[data-toggle],[data-cmd],[data-cmode]'); if (!el) return;
  if (el.dataset.cmode) {
    const n = el.dataset.cmode, cur = Number(LAST[n]) || 0, nv = cur ? 0 : 1;
    const human = n === 'GREJ_HLAD' ? (nv ? 'HLADJENJE' : 'GREJANJE') : (nv ? 'AUTOMATSKI' : 'RUCNO');
    if (confirm(`Promeniti na: ${human}?\n(menja PLC UZIVO)`)) write(n, nv);
  } else if (el.dataset.apply) {
    const n = el.dataset.apply, t = byName[n], i = document.getElementById('in_' + n);
    const val = t.kind === 'schedtime' ? i.value : parseFloat(i.value);
    if (val === '' || val == null || (t.kind !== 'schedtime' && isNaN(val))) return;
    if (confirm(`Upisati ${t.label} = ${val}?\n(menja PLC UZIVO)`)) write(n, val);
  } else if (el.dataset.toggle) {
    const n = el.dataset.toggle, t = byName[n], cur = el.classList.contains('on');
    if (confirm(`${t.label}: ${cur ? 'ISKLJUCITI' : 'UKLJUCITI'}?\n(menja PLC UZIVO)`)) write(n, cur ? 0 : 1);
  } else if (el.dataset.cmd) {
    const t = byName[el.dataset.cmd];
    if (confirm(`${t.label}?\n(salje impuls PLC-u)`)) write(el.dataset.cmd, 1);
  }
});
function tick() { setText('clock', new Date().toLocaleString('sr-RS')); }
init();

// Kotlarnica 1 (Unitronics) — HP-HMI sinoptik. Crta SVG + veže /api/state uživo.
function applyTheme(t){document.documentElement.dataset.theme=t;localStorage.setItem('theme',t);
  const b=document.getElementById('themeBtn');if(b)b.textContent=t==='light'?'☀ Svetla':'☾ Tamna';}
applyTheme(localStorage.getItem('theme')||'dark');
document.getElementById('themeBtn').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');

// zone (desna kolona): naziv, merena temp, setpoint, kalorifer/izlaz
const ZONES = [
  { name:'CNC RADIONICA', temp:'T_CNC',        sp:'SP_CNC',        fan:'K4' },
  { name:'HIDRAULIKA',     temp:'T_HIDRAULIKA', sp:'SP_HIDRAULIKA', fan:'K5' },
  { name:'MONTAŽA',        temp:'T_MONTAZA1',   sp:'SP_MONTAZA',    fan:'K1' },
  { name:'ZAVARIVANJE',    temp:'T_ZAVAR',      sp:'SP_ZAVAR',      fan:'P2' },
];
const PUMPS = [['P1','P1'],['P2','P2'],['P3','P3'],['P4','P4']];

// === KOMANDE (vraćeno) — preko /api/write {name,value} ===
const SP = [['SP_SPOLJA','Spolja'],['SP_SUDA_H','Sud H'],['SP_SUDA_L','Sud L'],['SP_CNC','CNC'],['SP_HIDRAULIKA','Hidraulika'],['SP_MONTAZA','Montaža'],['SP_ZAVAR','Zavarivanje']];
const MAN = [['RK_K1','K1'],['RK_K2','K2'],['RK_K3','K3'],['RK_K4','K4'],['RK_K5','K5'],['RK_P1','P1'],['RK_P2','P2'],['RK_P3','P3'],['RK_P4','P4']];
const SCHEDT = [['T_PONPET_ON','PON-PET paljenje'],['T_PONPET_OFF','PON-PET gašenje'],['T_SUBNED_ON','SUB-NED paljenje'],['T_SUBNED_OFF','SUB-NED gašenje']];
const DAYS = [['D_PON','Pon'],['D_UTO','Uto'],['D_SRE','Sre'],['D_CET','Cet'],['D_PET','Pet'],['D_SUB','Sub'],['D_NED','Ned']];

// === META iz /api/tags (vraćeno: dinamički uređaji/statusi/alarmi/izlazi) ===
let TAGS = [], ZMETA = [], byName = {};
const tagsOf = p => TAGS.filter(p);

let LASTS = {};
const LV = k => LASTS[k] ? LASTS[k].value : null;
async function uWrite(name, value){
  const r = await fetch('/api/write', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name,value}) });
  if(!r.ok) alert('Greška: ' + (await r.json()).error);
}
let _ctrlBuilt = false;
function buildControls(){
  if(_ctrlBuilt) return; _ctrlBuilt = true;
  document.getElementById('setpoints').innerHTML = SP.map(([n,l]) =>
    `<div class="rrow"><span class="rl">${l}</span><button class="cstep sm" data-sp="${n}" data-d="-0.5">−</button><b data-spv="${n}" style="font-family:Consolas;min-width:46px;text-align:center">—</b><span class="u" style="font-size:11px;color:var(--muted)">°C</span><button class="cstep sm" data-sp="${n}" data-d="0.5">+</button></div>`).join('');
  document.getElementById('manual').innerHTML = MAN.map(([n,l]) => `<button class="cbtn" data-man="${n}">${l}</button>`).join('');
  document.getElementById('sched').innerHTML =
    SCHEDT.map(([n,l]) => `<div class="rrow"><span class="rl">${l}</span><input type="time" id="t_${n}" style="background:var(--panel-2);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:4px 6px"><button class="cbtn sm" data-sptime="${n}">OK</button></div>`).join('') +
    `<div class="rrow" style="flex-wrap:wrap;gap:6px"><span class="rl">Dani</span>${DAYS.map(([n,l]) => `<button class="cbtn" data-day="${n}">${l}</button>`).join('')}</div>`;
}
function updateControls(){
  document.querySelectorAll('[data-spv]').forEach(el => { const v = LV(el.dataset.spv); el.textContent = (v==null||isNaN(v))?'—':Number(v).toFixed(1); });
  document.querySelectorAll('[data-man]').forEach(el => el.classList.toggle('on', LV(el.dataset.man) > 0));
  document.querySelectorAll('[data-day]').forEach(el => el.classList.toggle('on', LV(el.dataset.day) > 0));
  SCHEDT.forEach(([n]) => { const i = document.getElementById('t_'+n); const v = LV(n); if(i && document.activeElement !== i && v) i.value = v; });
}

// === UREĐAJI PO ZONI (kalorifer/pumpa: status RADI/STOJI + fizički "RAD PREKIDAČ" LED) ===
function buildDevZones(){
  const devs = tagsOf(t => t.kind === 'device');
  if(!devs.length){ document.getElementById('devzones').innerHTML = '<div class="empty">—</div>'; return; }
  document.getElementById('devzones').innerHTML = devs.map(d => {
    const zt = (ZMETA.find(z => z.key === d.zone) || {}).title || d.zone || '';
    const sw = d.sw ? `<span class="swled">RAD PREKIDAČ <i class="dot" data-swled="${d.sw}"></i></span>` : '<span class="swled" style="opacity:.4">bez prekidača</span>';
    return `<div class="rtile devtile">
      <div class="top"><span class="dn">${d.label}</span><span class="dz">${zt}</span></div>
      <div class="dbot"><span class="pill" data-devst="${d.name}">—</span>${sw}</div>
    </div>`;
  }).join('');
}
function updateDevZones(){
  document.querySelectorAll('[data-devst]').forEach(el => {
    const on = LV(el.dataset.devst);
    el.classList.toggle('ok', !!on); el.textContent = on ? 'RADI' : 'STOJI';
  });
  document.querySelectorAll('[data-swled]').forEach(el => el.classList.toggle('run', !!LV(el.dataset.swled)));
}

// === IZLAZI GREJANJA PO ZONI T1–T7 (kind=zoneout) ===
function buildZoneOuts(){
  const outs = tagsOf(t => t.kind === 'zoneout');
  const host = document.getElementById('zoneouts');
  if(!outs.length){ host.innerHTML = '<div class="empty">—</div>'; return; }
  host.innerHTML = outs.map(o => {
    const zt = (ZMETA.find(z => z.key === o.zone) || {}).title || o.zone || '';
    return `<span class="pill" data-zout="${o.name}" title="${zt}">${o.label}</span>`;
  }).join('');
}
function updateZoneOuts(){
  document.querySelectorAll('[data-zout]').forEach(el => el.classList.toggle('ok', !!LV(el.dataset.zout)));
}

// === STATUS POSTROJENJA (kotao, toplotna pumpa, frekventni, ON/OFF prekidač) ===
function buildStatusPanel(){
  const st = tagsOf(t => t.kind === 'status');
  const host = document.getElementById('status');
  if(!st.length){ host.innerHTML = '<div class="empty">—</div>'; return; }
  host.innerHTML = st.map(t =>
    `<div class="crow2"><span>${t.label}</span><span class="right"><span class="pill" data-statled="${t.name}">—</span></span></div>`
  ).join('');
}
function updateStatusPanel(){
  document.querySelectorAll('[data-statled]').forEach(el => {
    const on = LV(el.dataset.statled);
    el.classList.toggle('ok', !!on); el.textContent = on ? 'RADI' : 'STOJI';
  });
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-sp],[data-man],[data-day],[data-sptime],[data-umode],[data-ucmd]'); if(!el) return;
  const c = (msg, fn) => { if(confirm(msg + '\n(menja PLC UŽIVO)')) fn(); };
  if(el.dataset.sp){ const cur = Number(LV(el.dataset.sp)) || 20; const nv = Math.round((cur + Number(el.dataset.d)) * 2) / 2; c(`${el.dataset.sp} → ${nv}°C?`, () => uWrite(el.dataset.sp, nv)); }
  else if(el.dataset.man){ const on = el.classList.contains('on'); c(`${el.dataset.man}: ${on?'ISKLJUČITI':'UKLJUČITI'}?`, () => uWrite(el.dataset.man, on?0:1)); }
  else if(el.dataset.day){ const on = el.classList.contains('on'); c(`${el.dataset.day}: ${on?'isključiti':'uključiti'}?`, () => uWrite(el.dataset.day, on?0:1)); }
  else if(el.dataset.sptime){ const i = document.getElementById('t_'+el.dataset.sptime); if(i && i.value) c(`${el.dataset.sptime} → ${i.value}?`, () => uWrite(el.dataset.sptime, i.value)); }
  else if(el.dataset.umode){ const cur = Number(LV(el.dataset.umode)) || 0; const human = el.dataset.umode==='GREJ_HLAD' ? (cur?'GREJANJE':'HLAĐENJE') : (cur?'RUČNO':'AUTO'); c(`Prebaciti na ${human}?`, () => uWrite(el.dataset.umode, cur?0:1)); }
  else if(el.dataset.ucmd){ c('Reset greške frekventnog regulatora?', () => uWrite('RESET_VFD', 1)); }
});

function fanSVG(x, y, key) {
  return `<g transform="translate(${x},${y})"><g class="sy-fan" data-fan="${key}">
    <circle r="14" fill="none" stroke="var(--border)" stroke-width="1.5"/>
    <g class="bl">
      <ellipse cx="0" cy="-7" rx="2.6" ry="6"/><ellipse cx="0" cy="7" rx="2.6" ry="6"/>
      <ellipse cx="-7" cy="0" rx="6" ry="2.6"/><ellipse cx="7" cy="0" rx="6" ry="2.6"/>
    </g><circle r="2.4" fill="var(--text)"/></g></g>`;
}
function buildSyn() {
  let z = '';
  ZONES.forEach((zo, i) => {
    const y = 44 + i * 116, cy = y + 52;
    z += `<path class="sy-pipe pipe-flow dir" d="M560,${cy} H620"/>
      <rect class="sy-box" x="620" y="${y}" width="340" height="104" rx="10"/>
      <text class="sy-lbl" x="638" y="${y + 30}">${zo.name}</text>
      <text class="sy-sub" x="638" y="${y + 54}">cilj <tspan class="sy-val" style="font-size:13px" data-spval="${zo.sp}">--</tspan> °C</text>
      <text class="sy-badge off" x="638" y="${y + 78}" data-zbadge="${zo.temp}|${zo.sp}">—</text>
      ${fanSVG(770, y + 52, zo.fan)}
      <text class="sy-val big" x="880" y="${y + 50}" text-anchor="middle" data-temp="${zo.temp}">--</text>
      <text class="sy-unit" x="880" y="${y + 70}" text-anchor="middle">°C</text>`;
  });
  let pumps = '';
  PUMPS.forEach((p, i) => {
    const x = 40 + i * 38;
    // pumpSym emituje data-run="${p[0]}" na grupi i data-led="${p[0]}" na LED-u —
    // identično prethodnom crtežu, pa [data-run]/[data-led] toggle u refresh() radi i dalje.
    pumps += pumpSym(x, 356, 15, p[0], p[1]);
  });
  document.getElementById('syn').innerHTML = `
  <svg class="syn" viewBox="0 0 1000 520">
    ${hmiDefs()}
    <!-- cevi izvor -> SUD (smer: ka sudu) -->
    <path class="sy-pipe pipe-flow dir" d="M174,90 H250"/>
    <path class="sy-pipe pipe-flow dir" d="M174,195 H210 V90"/>
    <!-- distribucija SUD -> manifold -> zone (smer: ka razvodu/zonama) -->
    <path class="sy-pipe pipe-flow dir" d="M334,90 H560 V392"/>

    <!-- KOTAO -->
    <rect class="sy-box" x="24" y="44" width="150" height="92" rx="8" data-run="KOTAO_RAD"/>
    <text class="sy-lbl" x="99" y="70" text-anchor="middle">KOTAO</text>
    <text id="kot_icon" x="99" y="110" text-anchor="middle" style="font-size:26px">🔥</text>
    <circle cx="160" cy="58" r="6" class="sy-led off" data-led="KOTAO_RAD"/>
    <text class="sy-badge off" x="99" y="128" text-anchor="middle" data-badge="KOTAO_RAD">STOJI</text>
    <!-- TOPLOTNA PUMPA -->
    <rect class="sy-box" x="24" y="156" width="150" height="74" rx="8" data-run="TOPLOTNA_PUMPA"/>
    <text class="sy-lbl" x="99" y="186" text-anchor="middle">TOPLOTNA</text>
    <text class="sy-lbl" x="99" y="204" text-anchor="middle">PUMPA</text>
    <circle cx="160" cy="170" r="6" class="sy-led off" data-led="TOPLOTNA_PUMPA"/>
    <!-- FREKVENTNI -->
    <rect class="sy-box" x="24" y="250" width="150" height="60" rx="8" data-run="FREKVENTNI_RUN"/>
    <text class="sy-lbl" x="99" y="276" text-anchor="middle" style="font-size:12px">FREKVENTNI</text>
    <text class="sy-sub" x="99" y="293" text-anchor="middle">regulator</text>
    <circle cx="160" cy="262" r="6" class="sy-led off" data-led="FREKVENTNI_RUN"/>

    <!-- SUD / BUFFER (premium tank) -->
    ${tankSVG(250, 60, 84, 200, { label:'SUD / BUFFER', attr:'data-temp', val:'T_SUDA' })}

    <text class="sy-sub" x="40" y="336">PUMPE</text>
    ${pumps}
    ${z}
  </svg>`;
}

const V = (s, k) => (s && s.values && s.values[k]) ? s.values[k].value : null;
const f1 = v => (v == null || isNaN(v)) ? '--' : Number(v).toFixed(1);

async function loadMeta(){
  let m; try { m = await (await fetch('/api/tags')).json(); } catch(e){ return; }
  TAGS = m.tags || []; ZMETA = m.zones || [];
  byName = {}; TAGS.forEach(t => byName[t.name] = t);
  buildDevZones(); buildZoneOuts(); buildStatusPanel();
}

async function refresh() {
  let s = null; try { s = await (await fetch('/api/state')).json(); } catch (e) {}
  LASTS = (s && s.values) || {};
  const online = !!(s && s.online);
  const gh = V(s, 'GREJ_HLAD'); // 1=hladjenje, 0=grejanje
  const cool = gh === 1;

  // statstrip
  const am = V(s, 'AUTO_MAN');
  const alarms = [];
  if (online) {
    if (V(s, 'ALARM_PUMPE')) alarms.push('Alarm toplotne pumpe');
    if (V(s, 'ALARM_ZASTITE')) alarms.push('Zaštita');
    if (V(s, 'ALARM_OUT')) alarms.push('Alarm (izlaz)');
  }
  document.getElementById('strip').innerHTML = `
    <span class="badge ${online ? 'online' : 'offline'}">${online ? 'PLC ONLINE' : 'PLC OFFLINE'}</span>
    <span class="modetag ${cool ? 'cool' : 'heat'}">${online ? (cool ? '❄ HLAĐENJE' : '🔥 GREJANJE') : 'REŽIM —'}</span>
    <div class="item"><span class="v">${online ? (am ? 'AUTO' : 'RUČNO') : '—'}</span><span class="l">Upravljanje</span></div>
    <div class="item"><span class="v">${online ? (V(s,'PREKIDAC_ONOFF') ? 'ON' : 'OFF') : '—'}</span><span class="l">OFF/ON prekidač</span></div>
    <div class="item"><span class="v seg">${f1(V(s, 'T_SPOLJA'))}<small> °C</small></span><span class="l">Spolja</span></div>
    <div class="item"><span class="v seg">${f1(V(s, 'T_SUDA'))}<small> °C</small></span><span class="l">Sud</span></div>
    <div class="item"><span class="v ${alarms.length ? 's-alarm' : 's-ok'}">${alarms.length}</span><span class="l">Alarmi</span></div>`;

  // KOMANDE traka (režim / auto-ručno / reset)
  document.getElementById('cmdbar').innerHTML = !online
    ? `<span style="color:var(--muted);font-size:12px">Komande nedostupne — PLC offline (čeka reset Jazz modula)</span>`
    : `<span style="font-size:11px;color:var(--muted);font-weight:800;letter-spacing:1px">KOMANDE</span>
       <button class="cbtn ${!cool?'on-h':'on-c'}" data-umode="GREJ_HLAD">${cool?'❄ HLAĐENJE':'🔥 GREJANJE'}</button>
       <button class="cbtn ${am?'on':''}" data-umode="AUTO_MAN">${am?'AUTO':'RUČNO'}</button>
       <button class="cbtn" data-ucmd="reset">⟳ RESET VFD</button>`;
  buildControls(); updateControls();
  updateDevZones(); updateZoneOuts(); updateStatusPanel();

  // SVG bindings
  document.getElementById('kot_icon').textContent = cool ? '❄' : '🔥';
  document.querySelectorAll('.pipe-flow').forEach(p => {
    p.classList.toggle('flow', online); p.classList.toggle('heat', online && !cool); p.classList.toggle('cool', online && cool);
  });
  document.querySelectorAll('[data-run]').forEach(el => {
    const on = V(s, el.dataset.run); el.classList.toggle('run', !!on);
  });
  document.querySelectorAll('[data-led]').forEach(el => {
    const on = V(s, el.dataset.led); el.classList.remove('run', 'off'); el.classList.add(on ? 'run' : 'off');
  });
  document.querySelectorAll('[data-badge]').forEach(el => {
    const on = V(s, el.dataset.badge); el.classList.remove('run', 'off'); el.classList.add(on ? 'run' : 'off');
    el.textContent = on ? 'RADI' : 'STOJI';
  });
  document.querySelectorAll('[data-fan]').forEach(el => {
    const on = V(s, el.dataset.fan); el.classList.toggle('run', !!on);
  });
  document.querySelectorAll('[data-temp]').forEach(el => el.textContent = f1(V(s, el.dataset.temp)));
  document.querySelectorAll('[data-spval]').forEach(el => el.textContent = f1(V(s, el.dataset.spval)));
  document.querySelectorAll('[data-zbadge]').forEach(el => {
    const [tk, sk] = el.dataset.zbadge.split('|'); const ta = V(s, tk), tt = V(s, sk);
    el.classList.remove('run', 'off', 'fault');
    if (ta == null || tt == null) { el.textContent = '—'; el.classList.add('off'); return; }
    if (ta < tt - 0.3) { el.textContent = cool ? 'ISPOD' : 'GREJANJE'; el.classList.add('run'); }
    else if (ta > tt + 0.3) { el.textContent = cool ? 'HLAĐENJE' : 'IZNAD'; el.classList.add('run'); }
    else { el.textContent = 'U OPSEGU'; el.classList.add('off'); }
  });

  // zone panel
  document.getElementById('zones').innerHTML = ZONES.map(z => {
    const ta = V(s, z.temp), tt = V(s, z.sp), fan = V(s, z.fan);
    return `<div class="crow2"><span>${z.name}</span>
      <span class="right"><b>${f1(ta)}°C</b><span class="sy-sub" style="font-size:11px">cilj ${f1(tt)}</span>
      <span class="pill ${fan ? 'ok' : ''}">${fan ? 'GREJE' : 'MIR'}</span></span></div>`;
  }).join('');

  // alarmi panel
  const ab = document.getElementById('alarms');
  const rows = [];
  if (!online) rows.push(['p3', 'PLC offline — prekid komunikacije']);
  alarms.forEach(a => rows.push(['p2', a]));
  ab.innerHTML = rows.length
    ? rows.map(r => `<div class="alrow"><span class="prio ${r[0]}"></span><span>${r[1]}</span><span class="at">${new Date().toLocaleTimeString('sr-RS')}</span></div>`).join('')
    : `<div class="empty">Nema aktivnih alarma.</div>`;
}

/* ---------- TRENDOVI (24h, canvas iz /api/history) ---------- */
const TREND_COLORS = ['#4C9AFF','#E0B84F','#6DBA75','#E5534B','#A855F7','#4FD1C5','#F08C3A','#7AA2FF'];
async function loadTrends() {
  let d; try { d = await (await fetch('/api/history')).json(); } catch (e) { return; }
  const temps = (d.tags || []).filter(t => t.kind === 'temp');
  const cv = document.getElementById('trend'); if (!cv) return;
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#91A0AF';
  const border = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#263545';
  const w = cv.width = cv.clientWidth || 800, h = cv.height;
  const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, w, h);
  const pad = { l: 40, r: 12, t: 12, b: 22 };
  let min = Infinity, max = -Infinity, tmin = Infinity, tmax = -Infinity, any = false;
  for (const t of temps) for (const p of (d.series[t.name] || [])) { any = true; if (p.v < min) min = p.v; if (p.v > max) max = p.v; if (p.t < tmin) tmin = p.t; if (p.t > tmax) tmax = p.t; }
  if (!any) { ctx.fillStyle = muted; ctx.font = '13px Segoe UI'; ctx.fillText('Nema podataka još (skuplja se 1 uzorak/min)…', pad.l, h / 2); document.getElementById('trendleg').innerHTML = ''; return; }
  if (min === max) { min -= 1; max += 1; }
  const X = t => pad.l + (w - pad.l - pad.r) * (tmax === tmin ? 0.5 : (t - tmin) / (tmax - tmin));
  const Y = v => pad.t + (h - pad.t - pad.b) * (1 - (v - min) / (max - min));
  ctx.strokeStyle = border; ctx.fillStyle = muted; ctx.font = '10px Consolas';
  for (let i = 0; i <= 4; i++) { const v = min + (max - min) * i / 4, y = Y(v); ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke(); ctx.fillText(v.toFixed(1), 4, y + 3); }
  temps.forEach((t, i) => {
    const pts = d.series[t.name] || []; if (!pts.length) return;
    ctx.strokeStyle = TREND_COLORS[i % TREND_COLORS.length]; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, j) => { const x = X(p.t), y = Y(p.v); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  });
  document.getElementById('trendleg').innerHTML = temps.map((t, i) =>
    `<span class="lg"><i style="background:${TREND_COLORS[i % TREND_COLORS.length]}"></i>${t.label}</span>`).join('');
}

function clock() { document.getElementById('clock').textContent = new Date().toLocaleString('sr-RS'); }
buildSyn(); clock(); setInterval(clock, 1000);
loadMeta().then(refresh);
setInterval(refresh, 2000);
loadTrends(); setInterval(loadTrends, 60000);

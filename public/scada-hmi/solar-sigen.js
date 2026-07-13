// Solar Sigenergy (cloud) — HP-HMI energy-flow sinoptik. Crta SVG + veže /api/sigen uživo.
function applyTheme(t){document.documentElement.dataset.theme=t;localStorage.setItem('theme',t);
  const b=document.getElementById('themeBtn');if(b)b.textContent=t==='light'?'☀ Svetla':'☾ Tamna';}
applyTheme(localStorage.getItem('theme')||'dark');
document.getElementById('themeBtn').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');

// ---- multi-sistem: /api/sigen.values = { [systemId]: { key:{value} } }; CUR = izabrani ----
let CUR = null, LAST = null, TAGS = [], MODES = [], CONTROL = false;
const V = (s, k) => { const sv = (s && s.values && CUR) ? s.values[CUR] : null; return (sv && sv[k] && sv[k].value != null) ? sv[k].value : null; };
// vrednost odredjenog tag-a za PROIZVOLJAN systemId (za zbirni/po-sistemu prikaz)
const VS = (s, id, k) => { const sv = (s && s.values) ? s.values[id] : null; return (sv && sv[k] && sv[k].value != null) ? sv[k].value : null; };
document.addEventListener('click', e => { const b = e.target.closest('[data-sys]'); if (b) { CUR = b.dataset.sys; render(LAST); } });
const f1 = v => (v == null || isNaN(Number(v))) ? '—' : Number(v).toFixed(1);
// znak snage uz mali prag da se mir ne tretira kao protok
const SGN = v => (v == null || isNaN(Number(v))) ? 0 : (Number(v) > 0.05 ? 1 : (Number(v) < -0.05 ? -1 : 0));

// ---- ime režima: iz MODES (cloud), inače lokalni fallback — nikad sirov broj ako znamo ime ----
const SIGEN_MODE_NAMES = { 0:'Maksimalna samopotrošnja', 5:'Pun izvoz u mrežu', 6:'VPP', 8:'Northbound', 9:'Samopotrošnja (prilagođeni profil)' };
const modeName = v => {
  if (v == null) return null;
  if (isNaN(Number(v))) return String(v);   // cloud već vratio ime
  const m = (MODES || []).find(x => Number(x.value) === Number(v));
  return (m && m.name) || SIGEN_MODE_NAMES[Number(v)] || null;
};

// ---- statički SVG energy-flow dijagram (PV -> Inverter -> čvor -> Potrošnja/Mreža/Baterija) ----
function buildSyn() {
  document.getElementById('syn').innerHTML = `
  <svg class="syn" viewBox="0 0 1000 520">
    ${hmiDefs()}
    <!-- cevi: PV -> Inverter (smer uvek od PV ka inverteru) -->
    <path id="p_pv"   class="sy-pipe dir" d="M174,110 H300"/>
    <!-- Inverter -> čvor (smer ka sabirnici) -->
    <path id="p_inv"  class="sy-pipe dir" d="M474,110 H560"/>
    <!-- magistrala čvora (vertikala, smer ka granama) -->
    <path id="p_bus"  class="sy-pipe dir" d="M560,110 V430"/>
    <!-- čvor -> grane (smer ka potrošaču uvek; mreža/baterija po znaku u refresh) -->
    <path id="p_load" class="sy-pipe dir" d="M560,170 H760"/>
    <path id="p_grid" class="sy-pipe" d="M560,300 H760"/>
    <path id="p_batt" class="sy-pipe" d="M560,430 H760"/>

    <!-- flow čipovi (kW vrednosti na sredini linija; refresh upisuje broj u data-atribut) -->
    ${flowChip(237, 100, 'data-flowpv',   'pvPower',      'PV kW')}
    ${flowChip(660, 160, 'data-flowload', 'loadPower',    'POTROŠNJA kW')}
    ${flowChip(660, 290, 'data-flowgrid', 'gridPower',    'MREŽA ± kW')}
    ${flowChip(660, 420, 'data-flowbatt', 'batteryPower', 'BATERIJA kW')}

    <!-- PV -->
    <rect class="sy-box" x="24" y="62" width="150" height="96" rx="10" data-act="pvPower"/>
    <text class="sy-lbl" x="99" y="90" text-anchor="middle">PV POLJE</text>
    ${sunSVG(99, 114, 11)}
    <text class="sy-val big" x="99" y="150" text-anchor="middle" data-temp="pvPower">—</text>
    <text class="sy-unit" x="142" y="150">kW</text>

    <!-- Inverter -->
    <rect class="sy-box" x="300" y="62" width="174" height="96" rx="10" data-act="pvPower"/>
    <text class="sy-lbl" x="387" y="90" text-anchor="middle">INVERTER</text>
    <text class="sy-sub" x="387" y="110" text-anchor="middle">Sigenergy</text>
    <circle cx="460" cy="78" r="6" class="sy-led off" data-led="pvPower"/>
    <text class="sy-val big" x="387" y="142" text-anchor="middle" data-temp="pvPower">—</text>

    <!-- čvor (sabirnica) -->
    <circle cx="560" cy="110" r="7" class="sy-box"/>
    <text class="sy-sub" x="560" y="92" text-anchor="middle">SABIRNICA</text>

    <!-- Potrošnja -->
    <rect class="sy-box" x="760" y="128" width="216" height="84" rx="10" data-act="loadPower"/>
    <text class="sy-lbl" x="778" y="156">POTROŠNJA</text>
    <text x="952" y="160" text-anchor="end" style="font-size:18px">🏭</text>
    <text class="sy-val big" x="778" y="192" data-temp="loadPower">—</text>
    <text class="sy-unit" x="868" y="192">kW</text>

    <!-- Mreža -->
    <rect class="sy-box" x="760" y="258" width="216" height="84" rx="10" data-act="gridPower"/>
    <text class="sy-lbl" x="778" y="286">MREŽA ±</text>
    <text class="sy-badge off" x="952" y="282" text-anchor="end" data-gridtag>—</text>
    <text class="sy-val big" x="778" y="322" data-temp="gridPower">—</text>
    <text class="sy-unit" x="868" y="322">kW</text>

    <!-- Baterija -->
    <rect class="sy-box" x="760" y="388" width="216" height="84" rx="10" data-act="batteryPower"/>
    <text class="sy-lbl" x="778" y="416">BATERIJA</text>
    <text class="sy-badge off" x="952" y="412" text-anchor="end" data-batttag>—</text>
    <text class="sy-val big" x="778" y="452" data-temp="batteryPower">—</text>
    <text class="sy-unit" x="868" y="452">kW</text>
    <text class="sy-sub" x="888" y="452">Baterija <tspan class="sy-val" style="font-size:13px" data-temp="batterySoc">—</tspan>%</text>
  </svg>`;
}

// obojí + animira cev prema protoku. dir: 1 = ka grani (export/charge/load), -1 = ka čvoru (import/discharge/pv)
function setPipe(id, active, hot) {
  const p = document.getElementById(id);
  if (!p) return;
  p.classList.toggle('flow', !!active);
  p.classList.toggle('heat', !!active && !!hot);   // toplo = aktivni dotok energije
  p.classList.toggle('cool', !!active && !hot);    // hladno = odvod/export
}

// strelica smera na cevi po znaku: dir 1 = napred (ka grani), -1 = nazad (ka čvoru), 0 = bez strelice.
// path je nacrtan od čvora ka grani, pa marker-end gleda ka grani; marker-start (auto-start-reverse) gleda ka čvoru.
function setArrow(id, dir) {
  const p = document.getElementById(id);
  if (!p) return;
  p.classList.remove('dir');                 // class .dir bi forsirala statični marker-end; ovde upravljamo ručno
  p.removeAttribute('marker-end');
  p.removeAttribute('marker-start');
  if (dir > 0) p.setAttribute('marker-end', 'url(#flowArrow)');
  else if (dir < 0) p.setAttribute('marker-start', 'url(#flowArrow)');
}

async function refresh() {
  let s = null; try { s = await (await fetch('/api/sigen')).json(); } catch (e) {}
  render(s);
}

function render(s) {
  LAST = s;
  TAGS = (s && s.tags) || TAGS;
  MODES = (s && s.modes) || MODES;
  CONTROL = !!(s && s.control);
  const online = !!(s && s.online);
  const err = s && s.error ? String(s.error) : '';
  const systems = (s && s.systems) || [];
  if (systems.length && (!CUR || !systems.some(x => x.systemId === CUR))) CUR = systems[0].systemId;

  const pv   = V(s, 'pvPower');
  const load = V(s, 'loadPower');
  const grid = V(s, 'gridPower');     // >0 import iz mreže, <0 export u mrežu
  const batt = V(s, 'batteryPower');  // >0 punjenje, <0 pražnjenje
  const soc  = V(s, 'batterySoc');
  const mode = V(s, 'operatingMode');

  const ev   = V(s, 'evPower');
  const hp   = V(s, 'heatPumpPower');

  const daily    = V(s, 'dailyPowerGeneration');
  const monthly  = V(s, 'monthlyPowerGeneration');
  const annual   = V(s, 'annualPowerGeneration');
  const lifetime = V(s, 'lifetimePowerGeneration');

  // ---- statstrip (sa selektorom sistema) ----
  const sysSel = systems.map(sy => `<button class="syspill ${sy.systemId === CUR ? 'on' : ''}" data-sys="${sy.systemId}">${sy.name || sy.systemId}</button>`).join('');
  document.getElementById('strip').innerHTML = `
    ${systems.length ? `<div class="sysbar">${sysSel}</div>` : ''}
    <span class="badge ${online ? 'online' : 'offline'}">${online ? 'SIGEN ONLINE' : 'SIGEN OFFLINE'}</span>
    <div class="item"><span class="v seg">${f1(pv)}<small> kW</small></span><span class="l">PV</span></div>
    <div class="item"><span class="v seg">${f1(daily)}<small> kWh</small></span><span class="l">Danas</span></div>
    <div class="item"><span class="v seg">${soc == null ? '—' : f1(soc)}<small> %</small></span><span class="l">Baterija</span></div>
    <div class="item"><span class="v">${online && mode != null ? (modeName(mode) || ('Režim ' + mode)) : '—'}</span><span class="l">Režim</span></div>`;

  // ---- vrednosti u SVG ----
  document.querySelectorAll('[data-temp]').forEach(el => el.textContent = f1(V(s, el.dataset.temp)));

  // inverter LED + "aktivni" okviri (boja samo kad ima protoka)
  document.querySelectorAll('[data-led]').forEach(el => {
    const on = online && SGN(V(s, el.dataset.led)) !== 0;
    el.classList.remove('run', 'off'); el.classList.add(on ? 'run' : 'off');
  });
  document.querySelectorAll('[data-act]').forEach(el => {
    el.classList.toggle('run', online && SGN(V(s, el.dataset.act)) !== 0);
  });

  // ---- protok cevi po znaku snage ----
  const pvSgn = SGN(pv), gridSgn = SGN(grid), battSgn = SGN(batt), loadSgn = SGN(load);
  // PV -> inverter -> sabirnica: topao dotok kada PV proizvodi
  setPipe('p_pv',  online && pvSgn !== 0, true);
  setPipe('p_inv', online && pvSgn !== 0, true);
  // magistrala aktivna ako se bilo gde troši/puni/razmenjuje
  setPipe('p_bus', online && (loadSgn !== 0 || gridSgn !== 0 || battSgn !== 0), true);
  // potrošnja: uvek dotok energije ka potrošaču (toplo) kad postoji
  setPipe('p_load', online && loadSgn !== 0, true);
  // mreža: import (grid>0) = dotok (toplo); export (grid<0) = odvod (hladno)
  setPipe('p_grid', online && gridSgn !== 0, gridSgn > 0);
  // baterija: punjenje (batt>0) = odvod ka bateriji (hladno); pražnjenje (<0) = dotok (toplo)
  setPipe('p_batt', online && battSgn !== 0, battSgn < 0);

  // ---- strelice smera koje zavise od znaka (mreža ±, baterija puni/prazni) ----
  // mreža: import (grid>0) = energija ULAZI ka sabirnici → ka čvoru (-1); export (<0) = ka mreži (grani, +1)
  setArrow('p_grid', !online ? 0 : (gridSgn > 0 ? -1 : (gridSgn < 0 ? 1 : 0)));
  // baterija: punjenje (batt>0) = ka bateriji (grani, +1); pražnjenje (<0) = ka sabirnici (čvoru, -1)
  setArrow('p_batt', !online ? 0 : (battSgn > 0 ? 1 : (battSgn < 0 ? -1 : 0)));

  // ---- flow čipovi: kW vrednosti na sredini linija (mreža i baterija sa ± znakom) ----
  const fp  = el => document.querySelector(`[${el}]`);
  const sgnNum = v => (v == null || isNaN(Number(v))) ? '—' : (Number(v) > 0 ? '+' : '') + Number(v).toFixed(1);
  if (fp('data-flowpv'))   fp('data-flowpv').textContent   = f1(pv);
  if (fp('data-flowload')) fp('data-flowload').textContent = f1(load);
  if (fp('data-flowgrid')) fp('data-flowgrid').textContent = sgnNum(grid);
  if (fp('data-flowbatt')) fp('data-flowbatt').textContent = sgnNum(batt);

  // badge tekstovi za smer
  const gt = document.querySelector('[data-gridtag]');
  gt.classList.remove('run', 'off', 'fault');
  if (!online || grid == null) { gt.textContent = '—'; gt.classList.add('off'); }
  else if (gridSgn > 0) { gt.textContent = 'IMPORT'; gt.classList.add('fault'); }
  else if (gridSgn < 0) { gt.textContent = 'EXPORT'; gt.classList.add('run'); }
  else { gt.textContent = 'MIR'; gt.classList.add('off'); }

  const bt = document.querySelector('[data-batttag]');
  bt.classList.remove('run', 'off', 'fault');
  if (!online || batt == null) { bt.textContent = '—'; bt.classList.add('off'); }
  else if (battSgn > 0) { bt.textContent = 'PUNJENJE'; bt.classList.add('run'); }
  else if (battSgn < 0) { bt.textContent = 'PRAŽNJENJE'; bt.classList.add('off'); }
  else { bt.textContent = 'MIR'; bt.classList.add('off'); }

  // ---- desni panel: Proizvodnja ----
  document.getElementById('prod').innerHTML = `
    <div class="crow2"><span>Danas</span><span class="right"><b>${f1(daily)} kWh</b></span></div>
    <div class="crow2"><span>Mesec</span><span class="right"><b>${f1(monthly)} kWh</b></span></div>
    <div class="crow2"><span>Godina</span><span class="right"><b>${f1(annual)} kWh</b></span></div>
    <div class="crow2"><span>Ukupno (lifetime)</span><span class="right"><b>${f1(lifetime)} kWh</b></span></div>
    <div class="crow2"><span>Nivo baterije</span><span class="right"><b>${soc == null ? '—' : f1(soc) + ' %'}</b></span></div>`;

  // ---- desni panel: Snaga (svi tokovi, uključujući EV i toplotnu pumpu) ----
  const pw = [
    ['PV proizvodnja', pv], ['Potrošnja', load], ['Mreža (±)', grid],
    ['Baterija (±)', batt], ['EV punjač', ev], ['Toplotna pumpa', hp],
  ];
  document.getElementById('power').innerHTML = pw
    .map(([n, v]) => `<div class="crow2"><span>${n}</span><span class="right"><b>${f1(v)} kW</b></span></div>`).join('');

  // ---- desni panel: Režim i status (alarmi) ----
  const ab = document.getElementById('alarms');
  const modeRow = `<div class="crow2"><span>Režim rada</span>
    <span class="right"><span class="pill ${online && mode != null ? 'ok' : 'off'}">${online && mode != null ? (modeName(mode) || ('Režim ' + mode)) : '—'}</span></span></div>`;
  // raw mod (broj) za isticanje aktivnog dugmeta — iz _modeRaw kao u staroj strani
  const rawMode = V(s, '_modeRaw');
  // kontrola režima — vidljiva SAMO ako cloud dozvoljava (control=true). Inače read-only tekst gore.
  const ctrlRow = (CONTROL && MODES.length && CUR)
    ? `<div class="csteps" style="margin:8px 0 2px;flex-wrap:wrap">${MODES.map(m =>
        `<button class="cbtn ${Number(m.value) === Number(rawMode) ? 'on' : ''}" data-mode="${m.value}" data-modename="${m.name}">${m.name}</button>`).join('')}</div>`
    : (online ? `<div class="empty">Promena režima je zaključana (cloud bez kontrolnih endpointa).</div>` : '');
  const rows = [];
  if (!online) rows.push(['p3', err ? ('Sigen offline — ' + err) : 'Sigen offline — prekid veze sa cloud-om']);
  else if (s && s.values == null) rows.push(['p4', 'Nema svežih vrednosti (cloud rate-limit ~5 min)']);
  else if (err) rows.push(['p4', err]);
  ab.innerHTML = modeRow + ctrlRow + (rows.length
    ? rows.map(r => `<div class="alrow"><span class="prio ${r[0]}"></span><span>${r[1]}</span><span class="at">${new Date().toLocaleTimeString('sr-RS')}</span></div>`).join('')
    : `<div class="empty">Nema aktivnih alarma.</div>`);

  sgUpdate(s, online);
  renderAggregate(s, systems, online);
  renderSystemList(s, systems, online);
}

// ===== Sigen-stil: Power Metrics grafik + Režim/Baterija kartice =====
const SG_SERIES = [
  { k:'pv', label:'Solar',     color:'#F2994A' },
  { k:'ba', label:'Baterija',  color:'#2DD4BF' },
  { k:'gr', label:'Mreža',     color:'#4C9AFF' },
  { k:'lo', label:'Potrošnja', color:'#A855F7' },
];
let SG_EN = (() => { try { return JSON.parse(localStorage.getItem('sgSeries')) || {}; } catch(_) { return {}; } })();
SG_SERIES.forEach(s => { if (SG_EN[s.k] === undefined) SG_EN[s.k] = true; });
let SG_SRV = {};   // server istorija po sistemu (/api/sigen/history)

function sgHistKey(){ return 'sgHist_' + CUR; }
function sgLoadLocal(){ try { return JSON.parse(localStorage.getItem(sgHistKey()) || '[]'); } catch(_) { return []; } }
function sgPush(s){
  if (!CUR) return;
  const arr = sgLoadLocal(), now = Date.now(), last = arr[arr.length - 1];
  if (last && now - last.t < 90000) return;          // ne gušće od ~90s
  arr.push({ t: now, pv: V(s,'pvPower'), lo: V(s,'loadPower'), gr: V(s,'gridPower'), ba: V(s,'batteryPower'), soc: V(s,'batterySoc') });
  while (arr.length > 400) arr.shift();
  try { localStorage.setItem(sgHistKey(), JSON.stringify(arr)); } catch(_){}
}
async function sgFetchSrv(){
  if (!CUR) return;
  try { const j = await (await fetch('/api/sigen/history?system=' + encodeURIComponent(CUR))).json(); SG_SRV[CUR] = j.samples || []; sgDraw(); } catch(_){}
}
function sgSamples(){ const sv = SG_SRV[CUR] || [], lo = sgLoadLocal(); return sv.length >= lo.length ? sv : lo; }
function sgLegend(){
  const host = document.getElementById('sgLegend'); if (!host) return;
  host.innerHTML = SG_SERIES.map(s =>
    `<span class="sg-chip ${SG_EN[s.k] ? '' : 'off'}" data-series="${s.k}"><span class="dot" style="background:${s.color}"></span>${s.label}</span>`).join('');
}
function sgDraw(){
  const cv = document.getElementById('sgChart'); if (!cv) return;
  const wrap = cv.parentElement, W = wrap.clientWidth, H = wrap.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,W,H);
  const data = sgSamples(), empty = document.getElementById('sgEmpty');
  const enabled = SG_SERIES.filter(s => SG_EN[s.k]);
  if (data.length < 2 || !enabled.length){
    if (empty){ empty.textContent = data.length < 2 ? 'Prikupljam podatke — grafik se puni tokom dana (Sigen uzorkuje ~5 min).' : 'Uključi bar jednu seriju.'; empty.style.display = 'flex'; }
    return;
  }
  if (empty) empty.style.display = 'none';
  const css = getComputedStyle(document.documentElement);
  const muted = (css.getPropertyValue('--muted').trim()) || '#888';
  const border = (css.getPropertyValue('--border').trim()) || '#333';
  const padL = 42, padR = 12, padT = 12, padB = 22;
  const t0 = data[0].t, t1 = data[data.length-1].t, tSpan = Math.max(1, t1 - t0);
  let mn = 0, mx = 0;
  data.forEach(d => enabled.forEach(s => { const v = d[s.k]; if (v != null && !isNaN(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }));
  if (mx - mn < 1) mx = mn + 1;
  const padv = (mx - mn) * 0.08; mn -= padv; mx += padv;
  const X = t => padL + (t - t0) / tSpan * (W - padL - padR);
  const Y = v => padT + (mx - v) / (mx - mn) * (H - padT - padB);
  ctx.font = '10px "IBM Plex Mono",monospace'; ctx.textBaseline = 'middle';
  const ticks = 4;
  for (let i = 0; i <= ticks; i++){
    const v = mn + (mx - mn) * i / ticks, y = Y(v), zero = Math.abs(v) < (mx - mn) * 0.02;
    ctx.strokeStyle = zero ? muted : border; ctx.globalAlpha = zero ? .55 : .22;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = muted; ctx.textAlign = 'right'; ctx.fillText(v.toFixed(0), padL - 6, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  [0, .5, 1].forEach(p => { const t = t0 + tSpan * p;
    ctx.fillStyle = muted; ctx.fillText(new Date(t).toLocaleTimeString('sr-RS', { hour:'2-digit', minute:'2-digit' }), X(t), H - padB + 5); });
  enabled.forEach(s => {
    const pts = data.map(d => ({ x: X(d.t), v: d[s.k] })).filter(p => p.v != null && !isNaN(p.v));
    if (pts.length < 2) return;
    const y0 = Y(0);
    ctx.beginPath(); ctx.moveTo(pts[0].x, y0); pts.forEach(p => ctx.lineTo(p.x, Y(p.v)));
    ctx.lineTo(pts[pts.length-1].x, y0); ctx.closePath();
    ctx.fillStyle = s.color; ctx.globalAlpha = .14; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath(); pts.forEach((p,i) => i ? ctx.lineTo(p.x, Y(p.v)) : ctx.moveTo(p.x, Y(p.v)));
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  });
}
function sgUpdate(s, online){
  const mode = V(s,'operatingMode');
  const mEl = document.getElementById('sgMode'); if (mEl) mEl.textContent = online ? (modeName(mode) || (mode != null ? ('Režim ' + mode) : '—')) : '—';
  const cur = (LAST && LAST.systems || []).find(x => x.systemId === CUR);
  const subEl = document.getElementById('sgModeSub'); if (subEl) subEl.textContent = (cur && cur.name) ? cur.name : 'Sigenergy';
  const soc = V(s,'batterySoc');
  const socEl = document.getElementById('sgSoc'); if (socEl) socEl.textContent = soc == null ? '—' : Math.round(soc);
  const on = soc == null ? 0 : Math.round(soc / 10);
  const barEl = document.getElementById('sgBar'); if (barEl) barEl.innerHTML = Array.from({length:10}, (_,i) => `<span class="sg-seg ${i < on ? 'on' : ''}"></span>`).join('');
  if (online) sgPush(s);
  if (CUR && SG_SRV[CUR] === undefined) { SG_SRV[CUR] = []; sgFetchSrv(); }
  sgDraw();
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-series]'); if (!c) return;
  const k = c.dataset.series; SG_EN[k] = !SG_EN[k];
  try { localStorage.setItem('sgSeries', JSON.stringify(SG_EN)); } catch(_){}
  sgLegend(); sgDraw();
});
window.addEventListener('resize', () => sgDraw());

// ---- Zbirni KPI svih sistema (sumira PV/potrošnju/proizvodnju preko svih elektrana) ----
function renderAggregate(s, systems, online) {
  const host = document.getElementById('agg'); if (!host) return;
  if (!systems.length) { host.innerHTML = `<div class="empty">Nema konfigurisanih sistema.</div>`; return; }
  const sum = k => { let t = null; for (const sy of systems) { const v = VS(s, sy.systemId, k); if (v != null && !isNaN(Number(v))) t = (t || 0) + Number(v); } return t; };
  // prosečan SOC po sistemima koji imaju vrednost
  let socT = 0, socN = 0;
  for (const sy of systems) { const v = VS(s, sy.systemId, 'batterySoc'); if (v != null && !isNaN(Number(v))) { socT += Number(v); socN++; } }
  const socAvg = socN ? socT / socN : null;
  const kpis = [
    ['PV', sum('pvPower'), 'kW'], ['Potrošnja', sum('loadPower'), 'kW'],
    ['Mreža (±)', sum('gridPower'), 'kW'], ['Baterija (±)', sum('batteryPower'), 'kW'],
    ['Nivo baterije (prosek)', socAvg, '%'],
    ['Danas', sum('dailyPowerGeneration'), 'kWh'], ['Mesec', sum('monthlyPowerGeneration'), 'kWh'],
    ['Godina', sum('annualPowerGeneration'), 'kWh'], ['Ukupno', sum('lifetimePowerGeneration'), 'kWh'],
  ];
  host.innerHTML = `<div class="gstat" style="border:0;padding:0;background:transparent">
    <div class="big">${systems.length} elektran${systems.length === 1 ? 'a' : 'e'} ${online ? '' : '· offline'}</div>
    ${kpis.map(([n, v, u]) => `<div class="kpi"><span class="v">${f1(v)}<small style="font-size:11px;color:var(--muted)"> ${u}</small></span><span class="l">${n}</span></div>`).join('')}
  </div>`;
}

// ---- Lista svih sistema (po elektrani) — kao stara strana: svi vidljivi odjednom ----
function renderSystemList(s, systems, online) {
  const host = document.getElementById('syslist'); if (!host) return;
  if (!systems.length) { host.innerHTML = `<div class="empty">Nema konfigurisanih sistema — upiši SIGEN_SYSTEM_ID u app/.env</div>`; return; }
  host.innerHTML = systems.map(sy => {
    const id = sy.systemId;
    const md = VS(s, id, 'operatingMode');
    const rows = (TAGS.length ? TAGS : []).filter(t => t.kind !== 'mode').map(t => {
      const v = VS(s, id, t.key);
      if (v == null) return '';   // preskoči prazne (npr. EV/toplotna koje sistem nema)
      return `<div class="crow"><span class="k">${t.name}</span><span class="vv">${f1(v)} ${t.unit || ''}</span></div>`;
    }).join('');
    const cls = (id === CUR) ? 'card st-ok' : 'card' + (online ? '' : ' st-off');
    return `<a class="${cls}" data-sys="${id}">
      <span class="halo"></span>
      <h3>☀ ${sy.name || id}</h3>
      <div class="ctype">režim: ${online && md != null ? (modeName(md) || md) : '—'}</div>
      ${rows || `<div class="empty">nema podataka (čeka osvežavanje ~5 min)</div>`}
    </a>`;
  }).join('');
}

// ---- komanda za promenu režima (samo ako je control=true) — uz obavezan confirm ----
async function setMode(systemId, mode) {
  try {
    const r = await fetch('/api/sigen/write', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemId, mode }),
    });
    if (!r.ok) { let e = {}; try { e = await r.json(); } catch (_) {} alert('Greška: ' + (e.error || r.status)); return; }
  } catch (e) { alert('Greška: ' + e.message); return; }
  refresh();
}
document.addEventListener('click', e => {
  const b = e.target.closest('.cbtn[data-mode]'); if (!b) return;
  const mode = Number(b.dataset.mode), name = b.dataset.modename || b.textContent;
  const sys = ((LAST && LAST.systems || []).find(x => x.systemId === CUR) || {}).name || CUR;
  window.__scadaConfirm(`[${sys}] Prebaciti režim rada na "${name}"?`).then(ok => { if (ok) setMode(CUR, mode); });
});

function clock() { document.getElementById('clock').textContent = new Date().toLocaleString('sr-RS'); }

// WebSocket push (kao stara strana) — server šalje {type:'sigen', ...snapshot} na svaki poll
function connectWS() {
  let ws;
  try { ws = new WebSocket(`ws://${location.host}`); } catch (e) { return; }
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.type !== 'sigen') return;
    render(m);
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

buildSyn(); sgLegend(); clock(); setInterval(clock, 1000);
refresh(); setInterval(refresh, 5000); setInterval(sgFetchSrv, 60000); connectWS();

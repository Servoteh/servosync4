// Solar KACO (meteocontrol blue'Log / FNE) — HP-HMI sinoptik.
// Single-line: [PV polje] -> [6 invertora] -> [AC sabirnica] -> [Mreža]. Veže /api/bluelog na 5s.
function applyTheme(t){document.documentElement.dataset.theme=t;localStorage.setItem('theme',t);
  const b=document.getElementById('themeBtn');if(b)b.textContent=t==='light'?'☀ Svetla':'☾ Tamna';}
applyTheme(localStorage.getItem('theme')||'dark');
document.getElementById('themeBtn').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');

const HOT = 75;            // prag pregrevanja invertora (°C)
const SLOTS = 6;           // fiksan broj redova invertora u sinoptiku

const f1 = v => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(1);
const f0 = v => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(0);
const f2 = v => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(2);
const f3 = v => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(3);
const kw = w => (w == null || isNaN(w)) ? '—' : (Number(w)/1000).toFixed(1);   // W -> kW
const kwh = wh => (wh == null || isNaN(wh)) ? '—' : (Number(wh)/1000).toFixed(1); // Wh -> kWh
const tri = a => (a && a.length ? a.map(f0).join(' / ') : '—');                   // [x,y,z] -> "x / y / z"
const invLabel = inv => 'INV ' + (inv.address != null ? inv.address : (inv.name || '?'));

// Crta single-line dijagram: PV polje -> N invertora -> AC sabirnica -> Mreža.
function buildSyn() {
  let inv = '';
  for (let i = 0; i < SLOTS; i++) {
    const y = 44 + i * 72, cy = y + 26;
    inv += `
      <path class="sy-pipe seg-pv dir" data-slot="${i}" d="M174,${cy} H250"/>
      <rect class="sy-box" x="250" y="${y}" width="250" height="52" rx="8" data-slotbox="${i}"/>
      <circle cx="266" cy="${y + 16}" r="5" class="sy-led off" data-slotled="${i}"/>
      <text class="sy-lbl" x="282" y="${y + 21}" data-slotlbl="${i}">INV —</text>
      <text class="sy-sub" x="282" y="${y + 39}" data-slotsub="${i}">— kW · — kWh · — °C</text>
      <text class="sy-val" x="490" y="${y + 21}" text-anchor="end" data-slotkw="${i}">—</text>
      <text class="sy-unit" x="490" y="${y + 39}" text-anchor="end">kW</text>
      <path class="sy-pipe seg-bus dir" data-slot="${i}" d="M500,${cy} H560"/>`;
  }
  document.getElementById('syn').innerHTML = `
  <svg class="syn" viewBox="0 0 1000 480">
    ${hmiDefs()}
    <!-- PV POLJE -->
    <rect class="sy-box" x="24" y="160" width="150" height="120" rx="10"/>
    <text class="sy-lbl" x="99" y="184" text-anchor="middle">PV POLJE</text>
    ${sunSVG(99, 226, 18)}
    <text class="sy-sub" x="99" y="270" text-anchor="middle">FNE Servoteh</text>

    <!-- AC SABIRNICA (vertikalni bus) -->
    <path class="sy-pipe seg-busbar" d="M560,60 V476"/>
    <text class="sy-sub" x="560" y="48" text-anchor="middle">AC SABIRNICA</text>

    <!-- ukupna PV snaga (PV -> sabirnica) -->
    ${flowChip(530, 446, 'data-pvflow', '—', 'kW')}

    <!-- veza sabirnica -> mreža -->
    <path class="sy-pipe seg-grid dir" d="M560,268 H660"/>
    ${flowChip(610, 256, 'data-gridflow', '—', 'kW')}

    <!-- MREŽA -->
    <rect class="sy-box" x="660" y="208" width="150" height="120" rx="10"/>
    <text class="sy-lbl" x="735" y="238" text-anchor="middle">MREŽA</text>
    <text x="735" y="280" text-anchor="middle" style="font-size:28px">🗲</text>
    <text class="sy-val big" x="735" y="312" text-anchor="middle" data-gridkw>—</text>
    <text class="sy-unit" x="735" y="328" text-anchor="middle" style="font-size:9px">kW</text>
    <text class="sy-sub" x="735" y="346" text-anchor="middle" data-griddir>—</text>

    <!-- INVERTORI -->
    <text class="sy-sub" x="250" y="38">INVERTORI</text>
    ${inv}
  </svg>`;
}

function setFlow(on) {
  document.querySelectorAll('.sy-pipe').forEach(p => {
    p.classList.toggle('flow', on); p.classList.toggle('heat', on);
  });
}

async function refresh() {
  let d = null; try { d = await (await fetch('/api/bluelog')).json(); } catch (e) {}
  const online = !!(d && d.online);
  const plant = (d && d.plant) || {};
  const list = (d && d.inverters) || [];
  const meter = (d && d.meter) || null;
  const flowing = online && Number(plant.kw) > 0;

  // ---- statstrip (veliki KPI) ----
  const active = plant.activeInverters, count = plant.count;
  const offCount = list.filter(x => !x.online).length;
  const hotCount = list.filter(x => x.temp != null && x.temp > HOT).length;
  const alarmN = online ? (offCount + hotCount) : 0;
  document.getElementById('strip').innerHTML = `
    <span class="badge ${online ? 'online' : 'offline'}">${online ? 'FNE ONLINE' : 'FNE OFFLINE'}</span>
    <div class="item"><span class="v seg">${online ? f1(plant.kw) : '—'}<small> kW</small></span><span class="l">Trenutna snaga</span></div>
    <div class="item"><span class="v seg">${online ? f1(plant.kwhDay) : '—'}<small> kWh</small></span><span class="l">Danas</span></div>
    <div class="item"><span class="v">${online && active != null && count != null ? active + '/' + count : '—'}</span><span class="l">Inverteri</span></div>
    <div class="item"><span class="v ${alarmN ? 's-alarm' : 's-ok'}">${alarmN}</span><span class="l">Alarmi</span></div>`;

  // ---- sinoptik: protok + mreža ----
  setFlow(flowing);
  const gridVal = (online && meter && meter.pActive != null) ? kw(Math.abs(meter.pActive)) : f1(plant.kw);
  const gridEl = document.querySelector('[data-gridkw]');
  if (gridEl) gridEl.textContent = gridVal;
  // čipovi protoka energije na sinoptiku
  const pvFlowEl = document.querySelector('[data-pvflow]');
  if (pvFlowEl) pvFlowEl.textContent = online
    ? (plant.pAc != null ? kw(plant.pAc) : f1(plant.kw)) : '—';
  const gridFlowEl = document.querySelector('[data-gridflow]');
  if (gridFlowEl) gridFlowEl.textContent = online ? gridVal : '—';
  const gridDir = document.querySelector('[data-griddir]');
  if (gridDir) gridDir.textContent = (online && meter && meter.pActive != null)
    ? (meter.pActive < 0 ? 'predaja u mrežu' : 'preuzimanje') : (online ? 'predaja u mrežu' : '—');

  // popuni N slotova invertora
  for (let i = 0; i < SLOTS; i++) {
    const inv = list[i] || null;
    const box = document.querySelector(`[data-slotbox="${i}"]`);
    const led = document.querySelector(`[data-slotled="${i}"]`);
    const lbl = document.querySelector(`[data-slotlbl="${i}"]`);
    const sub = document.querySelector(`[data-slotsub="${i}"]`);
    const kwt = document.querySelector(`[data-slotkw="${i}"]`);
    const pvSeg = document.querySelector(`.seg-pv[data-slot="${i}"]`);
    const busSeg = document.querySelector(`.seg-bus[data-slot="${i}"]`);
    if (!inv) {
      if (box) box.style.opacity = '.35';
      if (led) { led.classList.remove('run', 'fault'); led.classList.add('off'); }
      if (lbl) lbl.textContent = 'INV —';
      if (sub) sub.textContent = '— kW · — kWh · — °C';
      if (kwt) kwt.textContent = '—';
      [pvSeg, busSeg].forEach(p => { if (p) p.classList.remove('flow', 'heat'); });
      continue;
    }
    const hot = inv.temp != null && inv.temp > HOT;
    const off = !inv.online;
    if (box) box.style.opacity = off ? '.55' : '1';
    if (led) {
      led.classList.remove('run', 'off', 'fault');
      led.classList.add(off || hot ? 'fault' : (online ? 'run' : 'off'));
    }
    if (lbl) lbl.textContent = invLabel(inv);
    if (sub) sub.textContent = `${kw(inv.pDc)} kW DC · ${kwh(inv.eDay)} kWh · ${f1(inv.temp)} °C${hot ? ' ⚠' : ''}`;
    if (kwt) kwt.textContent = off ? '—' : kw(inv.pAc);
    // protok kroz red samo kad invertor predaje snagu
    const segOn = online && !off && Number(inv.pAc) > 0;
    [pvSeg, busSeg].forEach(p => { if (p) { p.classList.toggle('flow', segOn); p.classList.toggle('heat', segOn); } });
  }

  // ---- desni: kartice po invertoru ----
  const cardsEl = document.getElementById('cards');
  cardsEl.innerHTML = list.length ? list.map(inv => {
    const hot = inv.temp != null && inv.temp > HOT;
    const off = !inv.online;
    const st = off ? 'st-off' : (hot ? 'st-alarm' : 'st-ok');
    return `<a class="card ${st}">
      <span class="halo"></span>
      <h3>${invLabel(inv)}</h3>
      <div class="ctype">${inv.model || 'invertor'}</div>
      <div class="cbig">${off ? '—' : kw(inv.pAc)}<span class="u">kW</span></div>
      <div class="crow"><span class="k">Danas</span><span class="vv">${kwh(inv.eDay)} kWh</span></div>
      <div class="crow"><span class="k">DC snaga</span><span class="vv">${kw(inv.pDc)} kW</span></div>
      <div class="crow"><span class="k">Temperatura</span><span class="vv ${hot ? 's-alarm' : ''}">${f1(inv.temp)} °C</span></div>
      <div class="crow"><span class="k">Status</span><span class="vv ${off ? 's-off' : (hot ? 's-alarm' : 's-ok')}">${off ? 'OFFLINE' : (hot ? 'PREGREVANJE' : 'RADI')}</span></div>
    </a>`;
  }).join('') : `<div class="empty">Nema podataka o invertorima.</div>`;

  // ---- desni: mreža / brojilo Janitza UMG 96RM ----
  const mEl = document.getElementById('meter');
  if (!meter) {
    mEl.innerHTML = `<div class="empty">Brojilo nije mapirano.</div>`;
  } else {
    const mOn = online && meter.online;
    const flowTxt = (mOn && meter.pActive != null)
      ? (meter.pActive < 0 ? 'predaja u mrežu' : 'preuzimanje iz mreže') : '—';
    mEl.innerHTML = `
      <div class="crow2"><span>Aktivna snaga</span><span class="right"><b>${mOn ? kw(meter.pActive) : '—'} kW</b> <span class="modetag ${meter.pActive != null && meter.pActive < 0 ? 'cool' : 'heat'}">${flowTxt}</span></span></div>
      <div class="crow2"><span>Reaktivna snaga</span><span class="right"><b>${mOn ? kw(meter.pReactive) : '—'} kvar</b></span></div>
      <div class="crow2"><span>Prividna snaga</span><span class="right"><b>${mOn ? kw(meter.pApparent) : '—'} kVA</b></span></div>
      <div class="crow2"><span>Faktor snage (cosφ)</span><span class="right"><b>${mOn ? f3(meter.pf) : '—'}</b></span></div>
      <div class="crow2"><span>Frekvencija</span><span class="right"><b>${mOn ? f2(meter.freq) : '—'} Hz</b></span></div>
      <div class="crow2"><span>Naponi L1/L2/L3</span><span class="right"><b>${mOn ? tri(meter.u) : '—'}</b> V</span></div>
      <div class="crow2"><span>Struje L1/L2/L3</span><span class="right"><b>${mOn ? tri(meter.i) : '—'}</b> A</span></div>
      <div class="crow2"><span>Energija predata</span><span class="right"><b>${mOn ? kwh(meter.eExp) : '—'} kWh</b></span></div>
      <div class="crow2"><span>Energija primljena</span><span class="right"><b>${mOn ? kwh(meter.eImp) : '—'} kWh</b></span></div>
      <div class="crow2"><span>Brojilo</span><span class="right">${[meter.name, meter.model].filter(Boolean).join(' · ') || '—'}</span></div>`;
  }

  // ---- desni: rezime postrojenja ----
  const reporting = plant.reportingInverters, pAcPlant = plant.pAc;
  const tsAny = (list.find(x => x.ts) || (meter && meter.ts ? { ts: meter.ts } : null));
  const tsTxt = tsAny ? new Date(tsAny.ts).toLocaleString('sr-RS') : '—';
  document.getElementById('summary').innerHTML = `
    <div class="crow2"><span>Trenutna snaga</span><span class="right"><b>${online ? f1(plant.kw) : '—'} kW</b></span></div>
    <div class="crow2"><span>Proizvodnja danas</span><span class="right"><b>${online ? f1(plant.kwhDay) : '—'} kWh</b></span></div>
    <div class="crow2"><span>Aktivni invertori</span><span class="right"><b>${online && active != null && count != null ? active + '/' + count : '—'}</b></span></div>
    <div class="crow2"><span>Invertori javljaju</span><span class="right"><b>${online && reporting != null && count != null ? reporting + '/' + count : '—'}</b></span></div>
    <div class="crow2"><span>Postrojenje</span><span class="right">${(d && (d.plantName || d.model)) ? [d.plantName, d.model].filter(Boolean).join(' · ') : '—'}</span></div>
    <div class="crow2"><span>Logger</span><span class="right">${(d && d.host) ? "blue'Log @ " + d.host : "blue'Log"}</span></div>
    <div class="crow2"><span>Podaci osveženi</span><span class="right">${online ? tsTxt : (d && d.error ? d.error : '—')}</span></div>`;

  // ---- desni: alarmi ----
  const rows = [];
  if (!online) rows.push(['p3', "blue'Log offline — prekid komunikacije" + (d && d.error ? ' (' + d.error + ')' : '')]);
  else {
    list.forEach(inv => { if (!inv.online) rows.push(['p3', invLabel(inv) + ' — offline']); });
    list.forEach(inv => { if (inv.online && inv.temp != null && inv.temp > HOT) rows.push(['p2', invLabel(inv) + ' — pregrevanje ' + f1(inv.temp) + ' °C']); });
    if (meter && !meter.online) rows.push(['p3', 'Brojilo (Janitza) — nema podataka']);
  }
  document.getElementById('alarms').innerHTML = rows.length
    ? rows.map(r => `<div class="alrow"><span class="prio ${r[0]}"></span><span>${r[1]}</span><span class="at">${new Date().toLocaleTimeString('sr-RS')}</span></div>`).join('')
    : `<div class="empty">Nema aktivnih alarma.</div>`;

  skUpdate(plant, meter, online);
}

// ===== Power Metrics grafik (PV kriva dana) — hmiChart + lokalni/serverski buffer =====
const SK_SERIES = [
  { k:'pv', label:'Solar (PV)',       color:'#F2994A' },
  { k:'gr', label:'Brojilo (mreža ±)', color:'#4C9AFF' },
];
let SK_EN = (() => { try { return JSON.parse(localStorage.getItem('skSeries')) || {}; } catch(_) { return {}; } })();
SK_SERIES.forEach(s => { if (SK_EN[s.k] === undefined) SK_EN[s.k] = true; });
let SK_SRV = [];
function skLoadLocal(){ try { return JSON.parse(localStorage.getItem('skHist') || '[]'); } catch(_) { return []; } }
function skPush(plant, meter, online){
  if (!online) return;
  const arr = skLoadLocal(), now = Date.now(), last = arr[arr.length - 1];
  if (last && now - last.t < 55000) return;
  arr.push({ t: now, pv: (plant && plant.kw != null) ? Number(plant.kw) : null, gr: (meter && meter.pActive != null) ? meter.pActive / 1000 : null });
  while (arr.length > 800) arr.shift();
  try { localStorage.setItem('skHist', JSON.stringify(arr)); } catch(_){}
}
async function skFetchSrv(){ try { const j = await (await fetch('/api/bluelog/history')).json(); SK_SRV = j.samples || []; skDraw(); } catch(_){} }
function skSamples(){ const lo = skLoadLocal(); return SK_SRV.length >= lo.length ? SK_SRV : lo; }
function skLegend(){
  const h = document.getElementById('skLegend'); if (!h) return;
  h.innerHTML = SK_SERIES.map(s => `<span class="sg-chip ${SK_EN[s.k] ? '' : 'off'}" data-skseries="${s.k}"><span class="dot" style="background:${s.color}"></span>${s.label}</span>`).join('');
}
function skDraw(){
  const drawn = hmiChart(document.getElementById('skChart'), skSamples(), SK_SERIES, SK_EN);
  const empty = document.getElementById('skEmpty');
  if (empty){ empty.style.display = drawn ? 'none' : 'flex';
    if (!drawn) empty.textContent = skSamples().length < 2 ? 'Prikupljam podatke — grafik se puni tokom dana (uzorak ~1 min).' : 'Uključi bar jednu seriju.'; }
}
function skUpdate(plant, meter, online){ skPush(plant, meter, online); skDraw(); }
document.addEventListener('click', e => {
  const c = e.target.closest('[data-skseries]'); if (!c) return;
  const k = c.dataset.skseries; SK_EN[k] = !SK_EN[k];
  try { localStorage.setItem('skSeries', JSON.stringify(SK_EN)); } catch(_){}
  skLegend(); skDraw();
});
window.addEventListener('resize', () => skDraw());

function clock() { document.getElementById('clock').textContent = new Date().toLocaleString('sr-RS'); }
buildSyn(); skLegend(); clock(); setInterval(clock, 1000);
refresh(); setInterval(refresh, 5000); skFetchSrv(); setInterval(skFetchSrv, 60000);

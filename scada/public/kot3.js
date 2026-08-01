// Kotlarnica 3 (Loxone, Nova zgrada) — HP-HMI sinoptik "Tehnička soba".
// Crta SVG programski + veže /api/loxone uživo (WS live state + control values).
function applyTheme(t){document.documentElement.dataset.theme=t;localStorage.setItem('theme',t);
  const b=document.getElementById('themeBtn');if(b)b.textContent=t==='light'?'☀ Svetla':'☾ Tamna';}
applyTheme(localStorage.getItem('theme')||'dark');
document.getElementById('themeBtn').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');

const PLANT = 'Tehnicka soba';

// === stanje sa servera ===
let D = { tags: [], values: {}, live: {}, wsReady: false, host: null };
const byName = {};   // name -> tag (samo postrojenje + opšte)
const byKey  = {};   // key  -> tag

// === helperi ===
// živo stanje preko WS: st(tag,name) => live[tag.states[name]]
function st(tag, name){
  if(!tag || !tag.states) return undefined;
  const u = tag.states[name];
  const v = (u != null) ? D.live[u] : undefined;
  return v;
}
// control-vrednost (HTTP poll fallback)
const ctrl = k => { const s = D.values[k]; return s ? s.value : undefined; };
// number -> 1 decimala, fali => "—"
const f1 = v => (v == null || v === '' || isNaN(v)) ? '—' : Number(v).toFixed(1);
// da li switch radi: state 'active' > 0 (fallback na control vrednost)
function isOn(tag){
  if(!tag) return false;
  let a = st(tag, 'active');
  if(a === undefined) a = parseFloat(ctrl(tag.key));
  return Number(a) > 0;
}
// tag iz postrojenja po imenu
const plant = n => byName[n];

// === SINOPTIK: "TEHNIČKA SOBA" (postrojenje) ===
// Izvori toplote levo, mešanja u sredini, BUFFER tank, pumpe dole.
function ledRow(x, y, label, name){
  return `<rect class="sy-box" x="${x}" y="${y}" width="150" height="58" rx="8" data-onbox="${name}"/>
    <text class="sy-lbl" x="${x+16}" y="${y+26}" style="font-size:12px">${label}</text>
    <circle cx="${x+134}" cy="${y+18}" r="6" class="sy-led off" data-onled="${name}"/>
    <text class="sy-badge off" x="${x+16}" y="${y+46}" data-onbadge="${name}">STOJI</text>`;
}
// Centrifugalna pumpa (P&ID, hmi.js): grupa .sy-pump data-run="name" (vrti/zeleno kad radi)
// + LED data-led="name". refresh() toggluje .run na [data-run] i LED preko istog isOn boolean.
function pumpC(x, y, label, name){
  return pumpSym(x, y, 13, name, label);
}
function mixBox(x, y, label, name){
  return `<rect class="sy-box" x="${x}" y="${y}" width="180" height="70" rx="10"/>
    <text class="sy-lbl" x="${x+16}" y="${y+27}" style="font-size:12px">${label}</text>
    <text class="sy-sub" x="${x+16}" y="${y+48}">izlaz vode</text>
    <text class="sy-val big" x="${x+164}" y="${y+38}" text-anchor="end" data-mix="${name}">—</text>
    <text class="sy-unit" x="${x+164}" y="${y+58}" text-anchor="end">°C</text>`;
}

function buildSyn(){
  const svg = `
  <svg class="syn" viewBox="0 0 1000 520">
    ${hmiDefs()}
    <!-- izvori -> kolektor (strelice smera: dir) -->
    <path class="sy-pipe pipe-flow dir" data-pipe="src" d="M174,73 H250"/>
    <path class="sy-pipe pipe-flow dir" data-pipe="src" d="M174,165 H210 V73"/>
    <!-- kolektor -> tank -> mešanja (strelice smera: dir) -->
    <path class="sy-pipe pipe-flow dir" data-pipe="src" d="M250,73 H500"/>
    <path class="sy-pipe dir" d="M458,140 V250"/>
    <path class="sy-pipe pipe-flow dir" data-pipe="mix" d="M500,150 H740"/>
    <path class="sy-pipe pipe-flow dir" data-pipe="mix" d="M500,250 H740"/>

    <!-- IZVORI TOPLOTE -->
    <text class="sy-sub" x="24" y="40">IZVORI</text>
    ${ledRow(24, 44, 'GASNI KOTAO', 'Gasni kotao za buffer')}
    ${ledRow(24, 136, 'TOPLOTNA PUMPA', 'Toplotna pumpa')}

    <!-- BUFFER TANK (premium) -->
    ${tankSVG(416, 70, 84, 170, { label:'BUFFER TANK', attr:'data-tank', val:'Temperatura BUFFER tank' })}

    <!-- MEŠANJA VODE -->
    <text class="sy-sub" x="740" y="110">MEŠANJE VODE</text>
    ${mixBox(740, 116, 'PODNO', 'Podno mesanje vode')}
    ${mixBox(740, 216, 'ZIDNO', 'Zidno mesanje vode')}

    <!-- PUMPE -->
    <text class="sy-sub" x="24" y="356">PUMPE</text>
    ${pumpC(60,  392, 'FC prizemlje', 'Pumpa Fan Coil prizemlje')}
    ${pumpC(200, 392, 'FC sprat',     'Pumpa Fan Coil sprat')}
    ${pumpC(340, 392, 'Podno',        'Pumpa Podno grejanje')}
    ${pumpC(480, 392, 'Zidno',        'Pumpa Zidno grejanje')}
  </svg>`;
  document.getElementById('syn').innerHTML = svg;
}

// === sobni regulator: cilj + režim (kao loxone.js roomCalc) ===
function roomCalc(rc){
  const ta = st(rc, 'tempActual');
  const tt = st(rc, 'tempTarget');
  const cc = st(rc, 'comfortTemperatureCool');
  // tempTarget>0 => grejanje (cilj=tempTarget); ==0 => hlađenje (cilj=comfortTemperatureCool)
  const heat = !!(tt && tt > 0);
  const cilj = heat ? tt : cc;
  return { ta, cilj, cooling: !heat };
}

// === SOBE — UPRAVLJANJE (vraćeno: CILJ, ventilator 0–3, klima) ===
const roomKlima = room => D.tags.find(t => t.type === 'Switch' && t.room === room && /Klimatizacija/i.test(t.name));
const roomFan   = room => D.tags.find(t => t.type === 'ValueSelector' && t.room === room);
async function lxWrite(key, value){
  const r = await fetch('/api/loxone/write', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key,value}) });
  if(!r.ok) alert('Greška: ' + (await r.json()).error);
}
async function lxRoomTemp(key, mode, value){
  const r = await fetch('/api/loxone/roomtemp', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({key,mode,value}) });
  if(!r.ok) alert('Greška: ' + (await r.json()).error);
}
let _gridKeys = '';
function ensureRoomTiles(rcs){
  const keys = rcs.map(r => r.key).join(',');
  if(keys === _gridKeys) return; _gridKeys = keys;          // gradi samo kad se skup soba promeni
  const grid = document.getElementById('roomgrid'); if(!grid) return;
  grid.innerHTML = rcs.map(rc => {
    const klima = roomKlima(rc.room), fan = roomFan(rc.room);
    const maxFan = Math.round(st(fan, 'max') ?? 3);
    let fb = ''; if(fan){ for(let n=0;n<=maxFan;n++) fb += `<button class="cstep" data-lxfan="${fan.key}" data-n="${n}">${n}</button>`; }
    return `<div class="rtile">
      <h3>${rc.room}</h3>
      <div class="rtop2">
        <div class="rseg"><span data-rtemp="${rc.key}">—</span><span class="u">°C</span></div>
        <div>
          <div class="rcilj">CILJ <button class="cstep sm" data-rt="${rc.key}" data-d="-0.5">−</button>
            <b data-rcilj="${rc.key}">—</b><span class="u" style="font-size:11px">°C</span>
            <button class="cstep sm" data-rt="${rc.key}" data-d="0.5">+</button></div>
          <div class="rmode" data-rmode="${rc.key}"></div>
        </div>
      </div>
      ${klima ? `<div class="rrow"><span class="rl">Klimatizacija</span><span class="ctgl" data-lxtgl="${klima.key}"><span class="kn"></span></span></div>` : ''}
      ${fan ? `<div class="rrow"><span class="rl">Ventilator (0–${maxFan})</span><span class="csteps" data-fanbox="${fan.key}">${fb}</span></div>` : ''}
    </div>`;
  }).join('');
}
function updateRoomTiles(){
  document.querySelectorAll('[data-rtemp]').forEach(el => el.textContent = f1(st(byKey[el.dataset.rtemp], 'tempActual')));
  document.querySelectorAll('[data-rcilj]').forEach(el => el.textContent = f1(roomCalc(byKey[el.dataset.rcilj]).cilj));
  document.querySelectorAll('[data-rmode]').forEach(el => { const c = roomCalc(byKey[el.dataset.rmode]); el.textContent = c.cooling ? '❄ hlađenje' : '🔥 grejanje'; });
  document.querySelectorAll('[data-lxtgl]').forEach(el => el.classList.toggle('on', isOn(byKey[el.dataset.lxtgl])));
  document.querySelectorAll('[data-fanbox]').forEach(box => {
    const fan = byKey[box.dataset.fanbox]; let v = st(fan, 'value'); if(v === undefined) v = parseFloat(ctrl(fan.key)); v = Math.round(v || 0);
    box.querySelectorAll('.cstep').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === v));
  });
}
// === POSTROJENJE — KOMANDE (vraćeno iz stare loxone.js renderList) ===
// Switch (kotao/TP/pumpe) -> On/Off toggle; ValueSelector -> setpoint (broj+OK ili
// dugmad za mali opseg); Radio (Rezim mešanja) -> read-only vrednost; Heatmixer/analog -> read.
const PLANT_NAME = 'Tehnicka soba', YARD_NAME = 'Dvoriste';
// red komande: vrednost (čita value state, fallback control-vrednost)
function ctrlVal(t){ let v = st(t, 'value'); if(v === undefined) v = ctrl(t.key); return v; }
function fmtVal(s){ if(s == null || s === '' || isNaN(s)) return '—'; const x = String(Number(s)); return x; }

// Gradi jednu komandnu pločicu (jedan tag = jedan red) — koristi postojeće HP-HMI klase.
function plantRowHtml(t){
  if(t.kind === 'switch'){
    return `<div class="pcmd"><span class="pl">${t.name}</span>
      <span class="ctgl" data-lxsw="${t.key}"><span class="kn"></span></span></div>`;
  }
  if(t.type === 'ValueSelector'){
    const max = st(t, 'max');
    if(max != null && max <= 5){                      // mali opseg -> step dugmad
      let b = ''; for(let n=0;n<=Math.round(max);n++) b += `<button class="cstep" data-lxstep="${t.key}" data-n="${n}">${n}</button>`;
      return `<div class="pcmd"><span class="pl">${t.name}</span><span class="csteps" data-lxstepbox="${t.key}">${b}</span></div>`;
    }
    return `<div class="pcmd"><span class="pl">${t.name}</span>
      <span class="pset"><b class="pv" data-lxread="${t.key}">—</b>
        <input type="number" step="1" id="ps_${t.key}">
        <button class="cbtn sm" data-lxset="${t.key}">OK</button></span></div>`;
  }
  // Radio / Heatmixer / InfoOnlyAnalog / ostalo -> read-only
  const f = (t.type === 'Heatmixer') ? 'tempActual' : 'value';
  return `<div class="pcmd"><span class="pl">${t.name}</span>
    <b class="pv" data-lxread="${t.key}" data-f="${f}">—<span class="u">${t.type === 'Heatmixer' ? '°C' : ''}</span></b></div>`;
}

let _plantKeys = '', _yardKeys = '';
function buildCmdGrid(elId, tags, cacheSet){
  const el = document.getElementById(elId); if(!el) return cacheSet;
  const keys = tags.map(t => t.key).join(',');
  if(keys === cacheSet) return cacheSet;               // rebuild samo kad se skup tagova promeni
  el.innerHTML = tags.length
    ? `<div class="rtile">${tags.map(plantRowHtml).join('')}</div>`
    : `<div class="empty">Nema kontrola.</div>`;
  return keys;
}
function updateCmdGrids(){
  // switch toggle (On/Off) — kotao/TP/pumpe/rasveta/noćni režim
  document.querySelectorAll('[data-lxsw]').forEach(el => el.classList.toggle('on', isOn(byKey[el.dataset.lxsw])));
  // read vrednosti (Radio activeOutput, Heatmixer tempActual, analog, trenutni setpoint)
  document.querySelectorAll('[data-lxread]').forEach(el => {
    const t = byKey[el.dataset.lxread];
    let v;
    if(el.dataset.f) v = st(t, el.dataset.f);
    if(v === undefined) v = ctrlVal(t);
    const u = el.querySelector('.u');
    el.textContent = fmtVal(v);
    if(u) el.appendChild(u);
  });
  // setpoint inputi — ne diraj dok korisnik kuca
  document.querySelectorAll('[id^="ps_"]').forEach(inp => {
    const t = byKey[inp.id.slice(3)]; let v = ctrlVal(t);
    if(document.activeElement !== inp && v != null && !isNaN(v)) inp.value = Math.round(v);
  });
  // step dugmad (mali ValueSelector) — aktivni nivo
  document.querySelectorAll('[data-lxstepbox]').forEach(box => {
    const t = byKey[box.dataset.lxstepbox]; let v = ctrlVal(t); v = Math.round(v || 0);
    box.querySelectorAll('.cstep').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === v));
  });
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-rt],[data-lxfan],[data-lxtgl],[data-lxsw],[data-lxset],[data-lxstep]'); if(!el) return;
  if(el.dataset.rt){
    const rc = byKey[el.dataset.rt], c = roomCalc(rc); if(c.cilj == null) return;
    const mode = c.cooling ? 'cool' : 'heat', nv = Math.round((c.cilj + Number(el.dataset.d)) * 2) / 2;
    if(confirm(`${rc.room}: ${mode === 'cool' ? 'hlađenje' : 'grejanje'} CILJ → ${nv}°C?\n(menja Loxone UŽIVO)`)) lxRoomTemp(rc.key, mode, nv);
  } else if(el.dataset.lxfan){
    const t = byKey[el.dataset.lxfan], n = Number(el.dataset.n);
    if(confirm(`${t.room || t.name}: ventilator brzina ${n}?\n(menja Loxone UŽIVO)`)) lxWrite(el.dataset.lxfan, n);
  } else if(el.dataset.lxtgl){
    const t = byKey[el.dataset.lxtgl], on = el.classList.contains('on');
    if(confirm(`${t.room || 'Klima'}: klimatizacija ${on ? 'ISKLJUČITI' : 'UKLJUČITI'}?\n(menja Loxone UŽIVO)`)) lxWrite(el.dataset.lxtgl, on ? 0 : 1);
  } else if(el.dataset.lxsw){                          // postrojenje/dvorište switch On/Off
    const t = byKey[el.dataset.lxsw], on = el.classList.contains('on');
    if(confirm(`${t.name}: ${on ? 'ISKLJUČITI' : 'UKLJUČITI'}?\n(menja Loxone UŽIVO)`)) lxWrite(el.dataset.lxsw, on ? 0 : 1);
  } else if(el.dataset.lxstep){                        // mali ValueSelector (dugmad)
    const t = byKey[el.dataset.lxstep], n = Number(el.dataset.n);
    if(confirm(`${t.name}: postaviti ${n}?\n(menja Loxone UŽIVO)`)) lxWrite(el.dataset.lxstep, n);
  } else if(el.dataset.lxset){                         // ValueSelector setpoint (broj+OK)
    const t = byKey[el.dataset.lxset], inp = document.getElementById('ps_' + el.dataset.lxset);
    const v = parseInt(inp.value, 10); if(isNaN(v)) return;
    if(confirm(`Postaviti ${t.name} = ${v}?\n(menja Loxone UŽIVO)`)) lxWrite(el.dataset.lxset, v);
  }
});

function refresh(){
  // --- SINOPTIK: izvori/pumpe (active) ---
  const kotaoOn = isOn(plant('Gasni kotao za buffer'));
  const tpOn    = isOn(plant('Toplotna pumpa'));
  document.querySelectorAll('[data-onbox]').forEach(el=>{
    el.classList.toggle('run', isOn(byName[el.dataset.onbox]));
  });
  document.querySelectorAll('[data-onled]').forEach(el=>{
    const on = isOn(byName[el.dataset.onled]);
    el.classList.remove('run','off'); el.classList.add(on ? 'run' : 'off');
  });
  document.querySelectorAll('[data-onbadge]').forEach(el=>{
    const on = isOn(byName[el.dataset.onbadge]);
    el.classList.remove('run','off'); el.classList.add(on ? 'run' : 'off');
    el.textContent = on ? 'RADI' : 'STOJI';
  });
  // pumpe (pumpSym): grupa .sy-pump dobija .run (vrti+zeleno), LED dobija .run/.off
  document.querySelectorAll('.sy-pump[data-run]').forEach(g=>{
    g.classList.toggle('run', isOn(byName[g.dataset.run]));
  });
  document.querySelectorAll('.sy-pump [data-led]').forEach(el=>{
    const on = isOn(byName[el.dataset.led]);
    el.classList.remove('run','off'); el.classList.add(on ? 'run' : 'off');
  });
  // mešanja (Heatmixer tempActual) i tank (InfoOnlyAnalog value)
  document.querySelectorAll('[data-mix]').forEach(el=>{
    el.textContent = f1(st(byName[el.dataset.mix], 'tempActual'));
  });
  document.querySelectorAll('[data-tank]').forEach(el=>{
    el.textContent = f1(st(byName[el.dataset.tank], 'value'));
  });
  // cevi: animiraj kad kotao ili TP rade (toplo => heat)
  const flowing = kotaoOn || tpOn;
  document.querySelectorAll('.pipe-flow').forEach(p=>{
    p.classList.toggle('flow', flowing);
    p.classList.toggle('heat', flowing);
  });

  // --- SOBE (IRoomControllerV2) ---
  const rcs = D.tags.filter(t => t.type === 'IRoomControllerV2');
  let sum = 0, cnt = 0;
  const roomsHtml = rcs.map(rc=>{
    const c = roomCalc(rc);
    if(c.ta != null && !isNaN(c.ta)){ sum += Number(c.ta); cnt++; }
    let badge = '—', cls = 'off';
    if(c.ta != null && c.cilj != null && !isNaN(c.ta) && !isNaN(c.cilj)){
      if(c.cooling){ badge = 'HLAĐENJE'; cls = (c.ta > c.cilj + 0.3) ? 'run' : 'ok'; }
      else if(c.ta < c.cilj - 0.3){ badge = 'GREJANJE'; cls = 'run'; }
      else { badge = 'U OPSEGU'; cls = 'ok'; }
    }
    return `<div class="crow2"><span>${rc.room}</span>
      <span class="right"><b>${f1(c.ta)}°C</b>
      <span class="sy-sub" style="font-size:11px">cilj ${f1(c.cilj)}</span>
      <span class="pill ${cls}">${badge}</span></span></div>`;
  }).join('');
  document.getElementById('rooms').innerHTML = roomsHtml ||
    `<div class="empty">Nema sobnih regulatora.</div>`;
  ensureRoomTiles(rcs); updateRoomTiles();   // interaktivne pločice (CILJ/ventilator/klima)
  const avg = cnt ? (sum / cnt) : null;

  // --- POSTROJENJE — KOMANDE + DVORIŠTE (vraćeno iz stare loxone.js) ---
  const plantTags = D.tags.filter(t => t.room === PLANT_NAME);
  const yardTags  = D.tags.filter(t => t.room === YARD_NAME);
  _plantKeys = buildCmdGrid('plantgrid', plantTags, _plantKeys);
  _yardKeys  = buildCmdGrid('yardgrid',  yardTags,  _yardKeys);
  updateCmdGrids();

  // broj uključenih "Klimatizacija"
  const klimaOn = D.tags.filter(t => t.type === 'Switch' && t.name === 'Klimatizacija' && isOn(t)).length;

  // --- STATSTRIP ---
  const online = !!D.wsReady;
  document.getElementById('strip').innerHTML = `
    <span class="badge ${online ? 'online' : 'offline'}">${online ? 'LOXONE ONLINE' : 'LOXONE OFFLINE'}</span>
    <div class="item"><span class="v">${cnt || '—'}</span><span class="l">Sobe</span></div>
    <div class="item"><span class="v seg">${f1(avg)}<small> °C</small></span><span class="l">Prosečna temp soba</span></div>
    <div class="item"><span class="v ${klimaOn ? 's-ok' : ''}">${klimaOn}</span><span class="l">Klimatizacija ON</span></div>
    <div class="item"><span class="v seg">${f1(st(plant('Temperatura BUFFER tank'),'value'))}<small> °C</small></span><span class="l">Buffer tank</span></div>`;

  // --- ALARMI / STATUS ---
  const rows = [];
  if(!online) rows.push(['p3', 'Loxone offline — WebSocket veza nije spremna']);
  const ab = document.getElementById('alarms');
  ab.innerHTML = rows.length
    ? rows.map(r=>`<div class="alrow"><span class="prio ${r[0]}"></span><span>${r[1]}</span><span class="at">${new Date().toLocaleTimeString('sr-RS')}</span></div>`).join('')
    : `<div class="empty">Nema aktivnih alarma.</div>`;
}

async function load(){
  try{
    D = await (await fetch('/api/loxone')).json();
    D.tags = D.tags || []; D.values = D.values || {}; D.live = D.live || {};
    D.tags.forEach(t=>{ byKey[t.key] = t; byName[t.name] = t; });
  }catch(e){ /* zadrži poslednje stanje; refresh prikazuje "—" */ }
  refresh();
}

function clock(){ document.getElementById('clock').textContent = new Date().toLocaleString('sr-RS'); }
buildSyn(); clock(); setInterval(clock, 1000);
load(); setInterval(load, 2000);

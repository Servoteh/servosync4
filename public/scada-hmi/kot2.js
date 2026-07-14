// Kotlarnica 2 (Siemens S7-1200, Hala 3/4/5) — ŽIVI HP-HMI sinoptik. /api/s7 (AWP web most).
function applyTheme(t){document.documentElement.dataset.theme=t;localStorage.setItem('theme',t);
  const b=document.getElementById('themeBtn');if(b)b.textContent=t==='light'?'☀ Svetla':'☾ Tamna';}
applyTheme(localStorage.getItem('theme')||'dark');
document.getElementById('themeBtn').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');

const f1 = v => (v == null || isNaN(Number(v))) ? '—' : Number(v).toFixed(1);
const HALLS = [['Temp_Hala_3','HALA 3'],['Temp_Hala_4','HALA 4'],['Temp_Hala_5','HALA 5']];
const KALS = Array.from({length:10}, (_,i)=>'K'+(i+1));
const PUMPS = ['P1','P2','P3','P4','TP1','TP2'];
let S7 = null;
async function s7Write(tag, value){
  const r = await fetch('/api/s7/write', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({tag,value}) });
  if(!r.ok) alert('Greška: ' + (await r.json()).error);
}
// lokalni nacrt rasporeda (sat koji se uređuje pre OK upisa)
const schDraft = {};
document.addEventListener('click', e => {
  // raspored ± (lokalno) ne zahteva S7 snapshot odmah, ali svi ostali zahtevaju
  const stepEl = e.target.closest('[data-sched]');
  if(stepEl){
    const id = stepEl.dataset.sched;            // npr "poc_3"
    const b = document.getElementById('sd_'+id);
    if(b){ let v = (parseInt(b.textContent,10)||0) + Number(stepEl.dataset.d); v = Math.max(0,Math.min(23,v)); b.textContent = v; schDraft[id] = v; }
    return;
  }
  const el = e.target.closest('[data-s7grej],[data-s7hlad],[data-s7auto],[data-s7man],[data-s7sp],[data-kal],[data-pump],[data-pumpbox],[data-s7boiler],[data-s7estop],[data-schedok],[data-areset]');
  if(!el || !S7) return;
  const w = (tag, val, msg) => { window.__scadaConfirm(msg).then(ok => { if(ok) s7Write(tag, val); }); };
  if(el.hasAttribute('data-s7grej')) w('Web_Grejanje', true, 'Prebaciti na GREJANJE?');
  else if(el.hasAttribute('data-s7hlad')) w('Web_Hladjenje', true, 'Prebaciti na HLAĐENJE?');
  else if(el.hasAttribute('data-s7auto')) w('Web_Automatski_Rezim', true, 'Prebaciti na AUTOMATSKI režim?');
  else if(el.hasAttribute('data-s7man')) w('Web_Rucni_Rezim', true, 'Prebaciti na RUČNI režim?');
  else if(el.dataset.s7sp){ const cur = (S7.setpoint != null ? S7.setpoint : 20); const nv = Math.max(10, Math.min(30, cur + Number(el.dataset.s7sp))); w('Zeljena_temperatura', nv, `Zadata temperatura → ${nv}°C?`); }
  else if(el.hasAttribute('data-s7boiler')){ const on = !!((S7.modes||{}).boiler); w('Web_Ukljucenje_kotla_rucno', !on, on ? 'ISKLJUČITI kotao (ručno)?' : 'UKLJUČITI kotao (ručno)?'); }
  else if(el.hasAttribute('data-s7estop')){ const on = !!((S7.modes||{}).webEstop); w('Web_Estop', !on, on ? 'DEAKTIVIRATI web E-STOP?' : '⚠ AKTIVIRATI E-STOP — zaustavlja postrojenje?'); }
  else if(el.dataset.schedok){ const id = el.dataset.schedok; const b = document.getElementById('sd_'+id); const v = parseInt((b?b.textContent:'0'),10)||0; const kind = el.dataset.kind === 'poc' ? 'POČETAK' : 'KRAJ'; const wvar = el.dataset.var; window.__scadaConfirm(`Hala ${el.dataset.hala}: ${kind} rada → ${v}:00 h?`).then(ok => { if(ok){ s7Write(wvar, v); delete schDraft[id]; } }); }
  else if(el.dataset.areset){ w(el.dataset.areset, 1, `RESET alarma:\n${el.dataset.atext||el.dataset.areset}?`); }
  else if(el.dataset.kal){ const k = (S7.kaloriferi||[]).find(x => x.key === el.dataset.kal); if(k && k.cmd) w(k.cmd, !k.on, `${k.label}: ${k.on ? 'ISKLJUČITI' : 'UKLJUČITI'}?`); }
  else { const pk = el.dataset.pump || el.dataset.pumpbox; const p = (S7.pumps||[]).find(x => x.key === pk); if(p && p.cmd) w(p.cmd, !p.on, `${p.label}: ${p.on ? 'ISKLJUČITI' : 'UKLJUČITI'}?`); }
});

function fanSVG(x,y,key){
  return `<g transform="translate(${x},${y})"><g class="sy-fan" data-kal="${key}" style="cursor:pointer">
    <title>Klik = uklj/isklj</title>
    <circle r="13" fill="none" stroke="var(--border)" stroke-width="1.5"/>
    <g class="bl"><ellipse cx="0" cy="-6.5" rx="2.4" ry="5.5"/><ellipse cx="0" cy="6.5" rx="2.4" ry="5.5"/>
    <ellipse cx="-6.5" cy="0" rx="5.5" ry="2.4"/><ellipse cx="6.5" cy="0" rx="5.5" ry="2.4"/></g>
    <circle r="2.2" fill="var(--text)"/></g>
    <text class="sy-sub" x="0" y="26" text-anchor="middle">${key}</text></g>`;
}
function buildSyn(){
  // hala kartice (gore)
  let halls='';
  HALLS.forEach((h,i)=>{ const x=360+i*210;
    halls += `<rect class="sy-box" x="${x}" y="44" width="190" height="96" rx="10"/>
      <text class="sy-lbl" x="${x+16}" y="72">${h[1]}</text>
      <text class="sy-val big" x="${x+95}" y="116" text-anchor="middle" data-temp="${h[0]}">—</text>
      <text class="sy-unit" x="${x+95}" y="134" text-anchor="middle">°C</text>`;
  });
  // pumpe (red) — premium pumpSym; data-pump na grupi za klik/komandu (toggle preko /api/s7/write)
  let pumps=''; PUMPS.forEach((p,i)=>{ const x=52+i*64;
    pumps += pumpSym(x, 256, 16, p, p)
      .replace('class="sy-pump"', `class="sy-pump" data-pump="${p}" style="cursor:pointer"`)
      .replace('<rect class="sy-volute"', '<title>Klik = uklj/isklj</title><rect class="sy-volute"');
  });
  // kaloriferi (2x5 grid dole)
  let kals=''; KALS.forEach((k,i)=>{ const x=380+(i%5)*120, y=340+Math.floor(i/5)*100; kals+=fanSVG(x,y,k); });

  document.getElementById('syn').innerHTML = `
  <svg class="syn" viewBox="0 0 1000 470">
    ${hmiDefs()}
    <path class="sy-pipe pipe-flow dir" d="M174,90 H210"/>
    <path class="sy-pipe pipe-flow dir" d="M294,90 H340"/>
    <!-- KOTAO -->
    <rect class="sy-box" x="24" y="46" width="150" height="92" rx="8" data-boilerbox>
    </rect>
    <text class="sy-lbl" x="99" y="72" text-anchor="middle">KOTAO</text>
    <text id="kot_icon" x="99" y="112" text-anchor="middle" style="font-size:26px">🔥</text>
    <circle cx="160" cy="60" r="6" class="sy-led off" data-boiler></circle>
    <!-- SUD / BUFFER (premium tank) -->
    ${tankSVG(210, 48, 84, 150, { label:'SUD / BUFFER', attr:'data-temp', val:'Temp_suda' })}
    <text class="sy-sub" x="40" y="232">PUMPE</text>
    ${pumps}
    ${halls}
    <text class="sy-sub" x="380" y="316">KALORIFERI K1–K10</text>
    ${kals}
  </svg>`;
}

// prava vremena alarma — keš raised_at po kodu (npr "W1.6") iz /api/alarmmeta (osvežava se na 30 s)
let ALARM_META = {};
async function alarmMetaFetch(){
  try{
    const j = await (await fetch('/api/alarmmeta?site=kot2')).json();
    const m = {};
    (j.alarms||[]).forEach(a => { if(a.active && a.code && m[a.code] === undefined) m[a.code] = a.raised_at; });
    ALARM_META = m;
  }catch(e){}
}

async function refresh(){
  let s=null; try{ s=await (await fetch('/api/s7')).json(); }catch(e){}
  S7=s;
  const online=!!(s&&s.online);
  const m=(s&&s.modes)||{};
  const cool=!!m.cooling, heat=!!m.heating;
  const tempByKey={}; (s&&s.temps||[]).forEach(t=>tempByKey[t.key]=t);
  const get=k=>tempByKey[k];

  // statstrip
  const estopBad = online && (m.webEstop || m.estopOk===false);
  const alarms=(s&&s.alarms)||[];
  document.getElementById('strip').innerHTML = `
    <span class="badge ${online?'online':'offline'}">${online?'SIEMENS ONLINE':'OFFLINE'}</span>
    <span class="modetag ${cool?'cool':'heat'}">${!online?'REŽIM —':(cool?'❄ HLAĐENJE':(heat?'🔥 GREJANJE':'MIR'))}</span>
    <div class="item"><span class="v">${!online?'—':(m.auto?'AUTO':'RUČNO')}</span><span class="l">Upravljanje</span></div>
    <div class="item"><span class="v ${estopBad?'s-alarm':''}">${!online?'—':(estopBad?'E-STOP':'OK')}</span><span class="l">E-stop</span></div>
    <div class="item"><span class="v seg">${f1(get('Temp_spoljasnja')&&get('Temp_spoljasnja').value)}<small> °C</small></span><span class="l">Spolja</span></div>
    <div class="item"><span class="v seg">${f1(get('Temp_suda')&&get('Temp_suda').value)}<small> °C</small></span><span class="l">Sud</span></div>
    <div class="item"><span class="v seg">${s&&s.setpoint!=null?f1(s.setpoint):'—'}<small> °C</small></span><span class="l">Zadata</span></div>
    <div class="item"><span class="v ${alarms.length?'s-alarm':'s-ok'}">${alarms.length}</span><span class="l">Alarmi</span></div>`;

  // KOMANDE (Siemens) — režim / auto-ručno / zadata
  const sp = (s && s.setpoint != null) ? s.setpoint : null;
  document.getElementById('cmdbar').innerHTML = !online
    ? `<span style="color:var(--muted);font-size:12px">Komande nedostupne — Siemens offline</span>`
    : `<span style="font-size:11px;color:var(--muted);font-weight:800;letter-spacing:1px">KOMANDE</span>
       <button class="cbtn ${heat?'on-h':''}" data-s7grej>🔥 GREJANJE</button>
       <button class="cbtn ${cool?'on-c':''}" data-s7hlad>❄ HLAĐENJE</button>
       <button class="cbtn ${m.auto?'on':''}" data-s7auto>AUTO</button>
       <button class="cbtn ${m.manual?'on':''}" data-s7man>RUČNO</button>
       <span style="font-size:11px;color:var(--muted);margin-left:6px">ZADATA</span>
       <button class="cbtn sm" data-s7sp="-1">−</button><b style="font-family:Consolas;min-width:48px;text-align:center">${sp!=null?sp+'°C':'—'}</b><button class="cbtn sm" data-s7sp="1">+</button>
       <span style="margin-left:auto;font-size:11px;color:var(--muted)">klik na kalorifer/pumpu = ručno uklj/isklj</span>`;

  // SVG bindings
  document.getElementById('kot_icon').textContent = cool?'❄':'🔥';
  document.querySelectorAll('.pipe-flow').forEach(p=>{ p.classList.toggle('flow',online); p.classList.toggle('heat',online&&!cool); p.classList.toggle('cool',online&&cool); });
  // temperature (+ fault crveno)
  document.querySelectorAll('[data-temp]').forEach(el=>{
    const t=get(el.dataset.temp); el.style.fill='';
    if(!t||t.value==null){ el.textContent='—'; if(t&&t.fault) el.style.fill='var(--alarm)'; }
    else el.textContent=f1(t.value);
  });
  // kotao
  const bl=document.querySelector('[data-boiler]'); if(bl){ bl.classList.remove('run','off'); bl.classList.add(m.boiler?'run':'off'); }
  const bb=document.querySelector('[data-boilerbox]'); if(bb) bb.classList.toggle('run',!!m.boiler);
  // pumpe — .run/.off na .sy-pump grupi (data-pump) i na LED-u (data-led), isti pump.on boolean
  const pumpOn={}; (s&&s.pumps||[]).forEach(p=>pumpOn[p.key]=p.on);
  document.querySelectorAll('[data-pump]').forEach(el=>{ const on=!!pumpOn[el.dataset.pump]; el.classList.remove('off'); el.classList.toggle('run',on);
    const led=el.querySelector('[data-led]'); if(led){ led.classList.remove('off'); led.classList.toggle('run',on); } });
  // kaloriferi
  const kalOn={}; (s&&s.kaloriferi||[]).forEach(k=>kalOn[k.key]=k.on);
  document.querySelectorAll('[data-kal]').forEach(el=>el.classList.toggle('run',!!kalOn[el.dataset.kal]));

  // desni panel: KOTAO + E-STOP (komande, confirm) — HP-HMI
  const sf = document.getElementById('safety');
  if(!online){ sf.innerHTML = `<div class="empty">Komande nedostupne — Siemens offline.</div>`; }
  else {
    sf.innerHTML =
      `<div class="crow2"><span>Kotao (ručno)</span><span class="right">
         <span class="pill ${m.boiler?'ok':''}" style="margin-right:8px">${m.boiler?'RADI':'STOJI'}</span>
         <button class="cbtn ${m.boiler?'on':''}" data-s7boiler>${m.boiler?'ISKLJUČI':'UKLJUČI'}</button></span></div>` +
      `<div class="crow2" style="border-bottom:none"><span>E-STOP</span><span class="right">
         <span class="pill ${estopBad?'alarm':'ok'}" style="margin-right:8px">${estopBad?'AKTIVAN':'OK'}</span>
         <button class="cbtn ${m.webEstop?'on-c':''}" data-s7estop style="${m.webEstop?'':'border-color:var(--alarm);color:var(--alarm)'}">${m.webEstop?'DEAKTIVIRAJ':'⛔ E-STOP'}</button></span></div>`;
  }

  // desni panel: RASPORED · satnice (uređivanje po hali — Vreme_Poc/Kraj_Hn, 0–23 h, ± pa OK)
  const sd = document.getElementById('sched');
  const schAll = (s&&s.schedule)||[];
  if(!online){ sd.innerHTML = `<div class="empty">Raspored nedostupan — Siemens offline.</div>`; }
  else if(!schAll.length){ sd.innerHTML = `<div class="empty">Nema rasporeda.</div>`; }
  else {
    const fld = (kind,h,val,wvar)=>{
      const id = `${kind}_${h}`;
      if(schDraft.hasOwnProperty(id)) val = schDraft[id];   // sačuvaj korisnikov nacrt preko osvežavanja
      return `<div class="crow2" style="border:none;padding:3px 0;gap:6px">
          <span class="rl" style="flex:1;color:var(--muted)">${kind==='poc'?'Početak':'Kraj'}</span>
          <button class="cstep sm" data-sched="${id}" data-d="-1">−</button>
          <b id="sd_${id}" style="font-family:Consolas;min-width:24px;text-align:center">${val}</b><span class="sy-unit" style="color:var(--muted)">h</span>
          <button class="cstep sm" data-sched="${id}" data-d="1">+</button>
          <button class="cbtn sm" data-schedok="${id}" data-var="${wvar}" data-hala="${h}" data-kind="${kind}">OK</button>
        </div>`;
    };
    sd.innerHTML = schAll.map(x=>
      `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
         <div class="rl" style="font-weight:700;color:var(--text);margin-bottom:2px">Hala ${x.hala}</div>
         ${fld('poc', x.hala, x.start, x.pocVar)}
         ${fld('kraj', x.hala, x.end, x.krajVar)}
       </div>`).join('');
  }

  // desni panel: oprema (rezime)
  const onCnt=(arr)=> (arr||[]).filter(x=>x.on).length;
  document.getElementById('info').innerHTML =
    `<div class="crow2"><span>Kaloriferi (rade)</span><span class="right"><span class="pill ${onCnt(s&&s.kaloriferi)?'ok':''}">${onCnt(s&&s.kaloriferi)}/${(s&&s.kaloriferi||[]).length}</span></span></div>` +
    `<div class="crow2" style="border-bottom:none"><span>Pumpe (rade)</span><span class="right"><span class="pill ${onCnt(s&&s.pumps)?'ok':''}">${onCnt(s&&s.pumps)}/${(s&&s.pumps||[]).length}</span></span></div>`;

  // alarmi — pun spisak sa tekstom + RESET dugme (gde alarm dozvoljava reset)
  const ab=document.getElementById('alarms');
  if(!online){
    ab.innerHTML = `<div class="alrow"><span class="prio p3"></span><span>Siemens offline — prekid komunikacije</span><span></span></div>`;
  } else if(!alarms.length){
    ab.innerHTML = `<div class="empty">Nema aktivnih alarma.</div>`;
  } else {
    ab.innerHTML = alarms.map(a=>{
      const prio = a.sev==='warn' ? 'p3' : a.sev==='info' ? 'p4' : 'p2';
      const code = `${a.word}.${a.bit}`;
      const ra = ALARM_META[code];
      const at = ra ? `<span class="at">${new Date(ra).toLocaleTimeString('sr-RS',{hour:'2-digit',minute:'2-digit'})}</span>` : '';
      const rst = a.reset
        ? `<button class="cbtn sm" data-areset="${a.reset}" data-atext="${(a.text||'').replace(/"/g,'&quot;')}">RESET</button>`
        : '';
      return `<div class="alrow" title="${code}"><span class="prio ${prio}"></span>
          <span>${a.text}</span>
          <span style="display:flex;align-items:center;gap:8px">${at}${rst}</span></div>`;
    }).join('');
  }
}

// ===== Trend (24h) — hmiChart + /api/s7/history (pattern kao solar-kaco skDraw/skLegend) =====
const K2_SERIES = [
  { k:'Temp_suda',       label:'Sud',    color:'#E8523A' },
  { k:'Temp_Hala_3',     label:'Hala 3', color:'#4C8DFF' },
  { k:'Temp_Hala_4',     label:'Hala 4', color:'#27AE60' },
  { k:'Temp_Hala_5',     label:'Hala 5', color:'#C9A91A' },
  { k:'Temp_spoljasnja', label:'Spolja', color:'#9B59B6' },
  { k:'setpoint',        label:'Zadata', color:'#95A5A6' },
];
let K2_EN = (() => { try { return JSON.parse(localStorage.getItem('k2Series')) || {}; } catch(_) { return {}; } })();
K2_SERIES.forEach(s => { if (K2_EN[s.k] === undefined) K2_EN[s.k] = true; });
let K2_SRV = [];
async function k2FetchSrv(){ try { const j = await (await fetch('/api/s7/history')).json(); K2_SRV = j.samples || []; k2Draw(); } catch(_){} }
function k2Legend(){
  const h = document.getElementById('k2Legend'); if (!h) return;
  h.innerHTML = K2_SERIES.map(s => `<span class="sg-chip ${K2_EN[s.k] ? '' : 'off'}" data-k2series="${s.k}"><span class="dot" style="background:${s.color}"></span>${s.label}</span>`).join('');
}
function k2Draw(){
  const drawn = hmiChart(document.getElementById('k2Chart'), K2_SRV, K2_SERIES, K2_EN);
  const empty = document.getElementById('k2Empty');
  if (empty){ empty.style.display = drawn ? 'none' : 'flex';
    if (!drawn) empty.textContent = K2_SRV.length < 2 ? 'Prikupljam podatke — grafik se puni tokom dana (uzorak ~1 min).' : 'Uključi bar jednu seriju.'; }
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-k2series]'); if (!c) return;
  const k = c.dataset.k2series; K2_EN[k] = !K2_EN[k];
  try { localStorage.setItem('k2Series', JSON.stringify(K2_EN)); } catch(_){}
  k2Legend(); k2Draw();
});
window.addEventListener('resize', () => k2Draw());

function clock(){ document.getElementById('clock').textContent=new Date().toLocaleString('sr-RS'); }
buildSyn(); k2Legend(); clock(); setInterval(clock,1000);
refresh(); setInterval(refresh,5000);
alarmMetaFetch(); setInterval(alarmMetaFetch,30000);
k2FetchSrv(); setInterval(k2FetchSrv,60000);

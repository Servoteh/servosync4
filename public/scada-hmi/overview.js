// Servoteh Control Center — Level 1 Overview (agregira sve sisteme uživo).
// High-Performance HMI: boja samo za upozorenje/alarm/offline.

// ---- tema (dark/light, pamti u localStorage) ----
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('theme', t);
  const b = document.getElementById('themeBtn');
  if (b) b.textContent = t === 'light' ? '☀ Svetla' : '☾ Tamna';
}
applyTheme(localStorage.getItem('theme') || 'dark');
document.getElementById('themeBtn').onclick = () =>
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');

const N = (v, d = 0) => (v == null || v === '' || isNaN(Number(v))) ? null : Number(Number(v).toFixed(d));
async function getJSON(u) { try { const r = await fetch(u); return r.ok ? await r.json() : null; } catch (e) { return null; } }

async function refresh() {
  const [plc, lox, sig, blu, s7] = await Promise.all([
    getJSON('/api/state'), getJSON('/api/loxone'), getJSON('/api/sigen'), getJSON('/api/bluelog'), getJSON('/api/s7'),
  ]);
  const sys = [
    kotlarnica(plc), kotlarnica2Siemens(s7), novaZgrada(lox), solarKaco(blu), solarSigen(sig),
  ];
  // svežina snapshot-a po sistemu (most ubacuje _ageMs u svaki payload)
  [plc, s7, lox, blu, sig].forEach((p, i) => { sys[i].ageMs = (p && p._ageMs != null && !isNaN(Number(p._ageMs))) ? Number(p._ageMs) : null; });
  renderCards(sys);
  renderGlobal(sys, blu, sig);
  renderComms(sys);
  renderAlarms(sys);
}

// ---- po sistemu vrati {name,type,route,status,halo,big,rows[],comms,alarms[]} ----
function val(o, k) { return o && o.values && o.values[k] ? o.values[k].value : undefined; }

function kotlarnica(s) {
  const online = !!(s && s.online);
  const al = [];
  if (online) {
    if (val(s, 'ALARM_PUMPE')) al.push({ p: 2, t: 'Kotlarnica — alarm toplotne pumpe' });
    if (val(s, 'ALARM_ZASTITE')) al.push({ p: 2, t: 'Kotlarnica — zaštita' });
  } else al.push({ p: 3, t: 'Kotlarnica (Unitronics) — prekid komunikacije' });
  const grej = val(s, 'GREJ_HLAD');
  return {
    name: 'Kotlarnica 1', type: 'Unitronics PLC', route: '/kot1.html', commsName: 'Unitronics PLC',
    online, alarms: al,
    status: !online ? 'off' : (al.length ? 'alarm' : 'ok'),
    big: (online && val(s, 'T_SUDA') != null) ? { v: N(val(s, 'T_SUDA'), 1), u: '°C' } : null, bigLabel: 'sud / buffer',
    rows: online ? [
      ['Režim', grej == null ? '—' : (grej ? 'Hlađenje' : 'Grejanje')],
      ['Kotao', val(s, 'KOTAO_RAD') ? 'RADI' : 'STOJI'],
      ['Toplotna pumpa', val(s, 'TOPLOTNA_PUMPA') ? 'RADI' : 'STOJI'],
      ['Frekventni', val(s, 'FREKVENTNI_RUN') ? 'RADI' : 'STOJI'],
    ] : [['Stanje', 'PLC offline']],
  };
}

function novaZgrada(s) {
  const online = !!(s && s.wsReady);
  const live = (s && s.live) || {};
  let sum = 0, n = 0, klima = 0;
  if (s && s.tags) for (const t of s.tags) {
    if (t.type === 'IRoomControllerV2') { const v = live[t.states.tempActual]; if (v > 0) { sum += v; n++; } }
    if (t.type === 'Switch' && t.room !== 'Tehnicka soba' && t.room !== 'Dvoriste') { if (live[t.states.active] > 0) klima++; }
  }
  const avg = n ? (sum / n) : null;
  const al = online ? [] : [{ p: 3, t: 'Nova zgrada (Loxone) — prekid komunikacije' }];
  return {
    name: 'Kotlarnica 3', type: 'Loxone · Nova zgrada', route: '/kot3.html', commsName: 'Kotlarnica 3 (Loxone)',
    online, alarms: al, status: !online ? 'off' : 'ok',
    big: avg != null ? { v: N(avg, 1), u: '°C' } : null, bigLabel: 'prosečna temp.',
    rows: [
      ['Prostorija', n ? (n + ' soba') : '—'],
      ['Klima uključeno', klima + (s && s.tags ? '/' + s.tags.filter(t => t.type === 'IRoomControllerV2').length : '')],
    ],
  };
}

function solarKaco(s) {
  const online = !!(s && s.online); const p = (s && s.plant) || {};
  const invOk = p.activeInverters != null && p.count != null && p.activeInverters < p.count;
  const al = [];
  if (!online) al.push({ p: 3, t: 'Solar KACO (blue’Log) — prekid komunikacije' });
  else if (invOk) al.push({ p: 3, t: `Solar KACO — invertor offline (${p.activeInverters}/${p.count})` });
  return {
    name: 'Solar KACO', type: 'blue’Log · ' + (p.count || '?') + '× KACO', route: '/solar-kaco.html', commsName: 'blue’Log',
    online, alarms: al, status: !online ? 'off' : (invOk ? 'warn' : 'ok'),
    big: online ? { v: N(p.kw, 1), u: 'kW' } : null, bigLabel: 'trenutna snaga',
    rows: online ? [
      ['Danas', (N(p.kwhDay, 0) ?? '—') + ' kWh'],
      ['Inverteri', (p.activeInverters ?? '?') + '/' + (p.count ?? '?')],
    ] : [['Stanje', 'offline']],
  };
}

function solarSigen(s) {
  const online = !!(s && s.online);
  // multi-sistem: values = { [systemId]: { pvPower:{value}, ... } }
  const sv = (s && s.values) || {};
  const ids = Object.keys(sv);
  let pv = 0, day = 0, n = 0;
  for (const id of ids) {
    const v = sv[id] || {};
    if (v.pvPower && v.pvPower.value != null) { pv += Number(v.pvPower.value); n++; }
    if (v.dailyPowerGeneration && v.dailyPowerGeneration.value != null) day += Number(v.dailyPowerGeneration.value);
  }
  const al = online ? [] : [{ p: 3, t: 'Solar Sigenergy — nije dostupan' }];
  return {
    name: 'Solar Sigenergy', type: 'Sigenergy · ' + (ids.length || '?') + ' sistema', route: '/solar-sigen.html', commsName: 'Sigenergy',
    online, alarms: al, status: !online ? 'off' : 'ok',
    big: n ? { v: N(pv, 1), u: 'kW' } : null, bigLabel: 'PV ukupno',
    rows: [
      ['Danas', day ? N(day, 0) + ' kWh' : '—'],
      ['Sistema', ids.length || '—'],
    ],
  };
}

function kotlarnica2Siemens(s) {   // 2. kotlarnica = Siemens S7-1200 (Hala 3/4/5), živo preko /api/s7
  const online = !!(s && s.online);
  const m = (s && s.modes) || {};
  const sud = (s && s.temps || []).find(t => t.key === 'Temp_suda');
  const kalOn = (s && s.kaloriferi || []).filter(k => k.on).length;
  const al = (s && s.alarms || []).map(a => ({ p: a.sev === 'warn' ? 3 : 2, t: 'Kotlarnica 2 — ' + a.text }));
  if (!online) al.push({ p: 3, t: 'Kotlarnica 2 (Siemens) — prekid komunikacije' });
  return {
    name: 'Kotlarnica 2', type: 'Siemens · Hala 3/4/5', route: '/kot2.html', commsName: 'Kotlarnica 2 (Siemens)',
    online, alarms: al, status: !online ? 'off' : (al.length ? 'alarm' : 'ok'),
    big: (sud && sud.value != null) ? { v: N(sud.value, 1), u: '°C' } : null, bigLabel: 'sud / buffer',
    rows: online ? [
      ['Režim', m.cooling ? 'Hlađenje' : (m.heating ? 'Grejanje' : 'Mir')],
      ['Upravljanje', m.auto ? 'AUTO' : 'RUČNO'],
      ['Kaloriferi', kalOn + '/' + (s.kaloriferi || []).length],
    ] : [['Stanje', 'offline']],
  };
}

// ---- render ----
// svežina snapshot-a: "⟳ pre Xs" (<90s) odnosno "⟳ pre Xmin"; bez _ageMs — ništa
function fmtAge(ms) {
  if (ms == null || isNaN(Number(ms))) return '';
  const sec = Math.round(Number(ms) / 1000);
  const txt = sec < 90 ? sec + 's' : Math.round(sec / 60) + 'min';
  return `<div style="font-size:10px;color:var(--muted);margin-top:6px">⟳ pre ${txt}</div>`;
}
function renderCards(sys) {
  document.getElementById('cards').innerHTML = sys.map(s => `
    <a class="card st-${s.status}" href="${s.route}">
      <span class="halo"></span>
      <h3>${s.name}</h3><div class="ctype">${s.type}</div>
      ${s.big ? `<div class="cbig">${s.big.v ?? '—'}<span class="u">${s.big.u}</span></div>
        <div class="ctype" style="margin-top:-4px">${s.bigLabel || ''}</div>` : ''}
      ${s.rows.map(r => `<div class="crow"><span class="k">${r[0]}</span><span class="vv">${r[1]}</span></div>`).join('')}
      ${fmtAge(s.ageMs)}
    </a>`).join('');
}
function renderGlobal(sys, blu, sig) {
  const commsOnline = sys.filter(s => s.online).length;
  const alarms = sys.flatMap(s => s.alarms);
  const crit = alarms.filter(a => a.p <= 2).length, warn = alarms.filter(a => a.p >= 3).length;
  let sigPv = 0;
  if (sig && sig.values) for (const id in sig.values) { const v = sig.values[id]; if (v && v.pvPower && v.pvPower.value != null) sigPv += Number(v.pvPower.value); }
  const pvTot = (blu && blu.plant ? (blu.plant.kw || 0) : 0) + sigPv;
  const statTxt = crit ? `<span class="s-alarm">${crit} ALARM</span>`
    : warn ? `<span class="s-warn">${warn} upozorenje</span>` : `<span class="s-ok">SISTEM NORMALAN</span>`;
  document.getElementById('gstat').innerHTML = `
    <div class="big">${statTxt}</div>
    <div class="kpi"><span class="v">${N(pvTot, 1) ?? '—'} kW</span><span class="l">PV ukupno</span></div>
    <div class="kpi"><span class="v">${commsOnline}/${sys.length}</span><span class="l">Komunikacija</span></div>
    <div class="kpi"><span class="v">${alarms.length}</span><span class="l">Aktivni alarmi</span></div>`;
}
function renderComms(sys) {
  document.getElementById('comms').innerHTML = sys.map(s => {
    const pill = `<span class="pill ${s.online ? 'ok' : 'off'}">${s.online ? 'ONLINE' : 'OFFLINE'}</span>`;
    return `<div class="crow2"><span>${s.commsName}</span>${pill}</div>`;
  }).join('');
}
function renderAlarms(sys) {
  const al = sys.flatMap(s => s.alarms).sort((a, b) => a.p - b.p);
  const box = document.getElementById('alarms');
  if (!al.length) { box.innerHTML = `<div class="empty">Nema aktivnih alarma.</div>`; return; }
  const t = new Date().toLocaleTimeString('sr-RS');
  box.innerHTML = al.map(a => `<div class="alrow"><span class="prio p${a.p}"></span><span>${a.t}</span><span class="at">${t}</span></div>`).join('');
}

function clock() { document.getElementById('clock').textContent = new Date().toLocaleString('sr-RS'); }
clock(); setInterval(clock, 1000);
refresh(); setInterval(refresh, 5000);

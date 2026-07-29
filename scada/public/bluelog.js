// Solarna elektrana FNE (meteocontrol blue'Log) — frontend (read-only)
// Podaci: GET /api/bluelog (init) + WebSocket type:'bluelog'. Oblik = blSnapshot() sa servera.

function fmt(n, d = 1) {
  if (n == null || n === '' || (typeof n === 'number' && isNaN(n))) return '--';
  const x = Number(n);
  return isNaN(x) ? String(n) : x.toLocaleString('sr-RS', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const kW = (w) => (w == null ? '--' : fmt(w / 1000, 1));
const kWh = (wh) => (wh == null ? '--' : fmt(wh / 1000, 1));

const card = (name, value, unit, sub, cls = '') => `<div class="zone glass ${cls}">
    <div class="zname">${name}</div>
    <div class="zval"><b>${value}</b><span class="zu">${unit || ''}</span></div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  </div>`;

function renderPlant(p) {
  if (!p) { document.getElementById('plant').innerHTML = card('Snaga', '--', 'kW'); return; }
  document.getElementById('plant').innerHTML = [
    card('Trenutna snaga', fmt(p.kw, 1), 'kW', `${p.reportingInverters}/${p.count} invertora javlja`),
    card('Proizvodnja danas', fmt(p.kwhDay, 1), 'kWh', 'zbir E_DAY invertora'),
    card('Aktivni invertori', `${p.activeInverters}`, `/ ${p.count}`, p.activeInverters === p.count ? 'svi rade' : 'proveri offline'),
  ].join('');
}

function renderMeter(m) {
  const el = document.getElementById('meter');
  if (!m) { el.innerHTML = card('Brojilo', 'n/a', '', 'nije mapirano'); return; }
  const u = m.u || [], i = m.i || [];
  el.innerHTML = [
    card('Aktivna snaga', kW(m.pActive), 'kW', m.pActive != null && m.pActive < 0 ? 'predaja u mrežu' : 'preuzimanje'),
    card('Reaktivna', kW(m.pReactive), 'kvar', `prividna ${kW(m.pApparent)} kVA`),
    card('Faktor snage', fmt(m.pf, 3), 'cosφ', `f = ${fmt(m.freq, 2)} Hz`),
    card('Naponi', `${fmt(u[0], 0)}/${fmt(u[1], 0)}/${fmt(u[2], 0)}`, 'V', `struje ${fmt(i[0], 0)}/${fmt(i[1], 0)}/${fmt(i[2], 0)} A`),
    card('Brojači energije', `${kWh(m.eExp)}`, 'kWh pred.', `primljeno ${kWh(m.eImp)} kWh`),
  ].join('');
}

function renderInverters(list) {
  const el = document.getElementById('inverters');
  if (!list || !list.length) { el.innerHTML = card('Invertori', '--', ''); return; }
  el.innerHTML = list.map(inv => {
    const hot = inv.temp != null && inv.temp >= 70;
    const off = !inv.online;
    const sub = `Danas ${kWh(inv.eDay)} kWh · DC ${kW(inv.pDc)} kW · ${fmt(inv.temp, 1)} °C${hot ? ' ⚠️' : ''}`;
    return card(`#${inv.address} · ${inv.model || 'invertor'}`, off ? '—' : fmt(inv.pAc / 1000, 1), 'kW', sub, off ? 'dim' : '');
  }).join('');
}

function setBadge(c, t) { const b = document.getElementById('conn'); b.className = 'badge ' + c; b.textContent = t; }

function render(d) {
  if (!d) return;
  setBadge(d.online ? 'online' : 'offline', d.online ? 'FNE ONLINE' : (d.error ? 'GREŠKA' : 'OFFLINE'));
  document.getElementById('hostinfo').textContent =
    `meteocontrol blue'Log ${d.model || ''} @ ${d.host || ''} · ${d.plantName || ''}`;
  const ts = (d.inverters && d.inverters.find(x => x.ts)) || (d.meter && d.meter.ts ? { ts: d.meter.ts } : null);
  document.getElementById('tsinfo').textContent = ts ? 'podaci: ' + new Date(ts.ts).toLocaleString('sr-RS') : (d.error || '');
  renderPlant(d.plant); renderMeter(d.meter); renderInverters(d.inverters);
}

async function init() {
  try { render(await (await fetch('/api/bluelog')).json()); }
  catch (e) { setBadge('offline', 'GREŠKA'); }
  connectWS(); tick(); setInterval(tick, 1000);
}
function connectWS() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'bluelog') render(m); };
  ws.onclose = () => { setBadge('offline', 'VEZA PREKINUTA'); setTimeout(connectWS, 2000); };
}
function tick() { const c = document.getElementById('clock'); if (c) c.textContent = new Date().toLocaleString('sr-RS'); }
init();

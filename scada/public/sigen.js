// Solarna elektrana (Sigenergy) — frontend. SVI SISTEMI ODJEDNOM (panel po sistemu).
let TAGS = [], MODES = [], SYSTEMS = [], CONTROL = false, STATES = {};

async function init() {
  try {
    const d = await (await fetch('/api/sigen')).json();
    TAGS = d.tags || []; MODES = d.modes || []; SYSTEMS = d.systems || [];
    CONTROL = !!d.control; STATES = d.values || {};
    setStatus(d); render();
  } catch (e) { setBadge('offline', 'GREŠKA'); }
  connectWS(); tick(); setInterval(tick, 1000);
}

function fmt(v) {
  if (v == null || v === '') return '--';
  const n = Number(v);
  return isNaN(n) ? String(v) : (Math.round(n * 10) / 10).toLocaleString('sr-RS');
}
const cardHtml = (name, val, unit) => `<div class="zone glass">
    <div class="zname">${name}</div>
    <div class="zval"><b>${val}</b><span class="zu">${unit || ''}</span></div>
  </div>`;

function sysBlock(s) {
  const st = STATES[s.systemId] || {};
  const modeTxt = (st.operatingMode && st.operatingMode.value != null) ? st.operatingMode.value : '—';
  const raw = st._modeRaw ? Number(st._modeRaw.value) : null;
  const cards = TAGS.filter(t => t.kind !== 'mode').map(t => {
    const cell = st[t.key];
    if (!cell || cell.value == null) return '';        // preskoči prazne (npr. EV/toplotna)
    return cardHtml(t.name, fmt(cell.value), t.unit);
  }).join('');
  const ctrl = CONTROL
    ? `<div class="modebtns">${MODES.map(m => `<button class="modebtn ${Number(m.value) === raw ? 'active' : ''}" data-system="${s.systemId}" data-mode="${m.value}">${m.name}</button>`).join('')}</div>`
    : '';
  return `<div class="sysblock glass">
      <div class="syshead">
        <span class="sysn">☀️ ${s.name}</span>
        <span class="sysmode">režim: ${modeTxt}</span>
      </div>
      <div class="zones">${cards || '<div class="sub">nema podataka (čeka osvežavanje ~5 min)</div>'}</div>
      ${ctrl}
    </div>`;
}

function render() {
  const host = document.getElementById('systems');
  if (!SYSTEMS.length) {
    host.innerHTML = `<div class="sysblock glass"><div class="sub">Nema konfigurisanih sistema — upiši SIGEN_SYSTEM_ID u app/.env</div></div>`;
    return;
  }
  host.innerHTML = SYSTEMS.map(sysBlock).join('');
}

function setStatus(d) {
  setBadge(d.online ? 'online' : 'offline', d.online ? 'SIGEN ONLINE' : (d.error ? 'GREŠKA' : 'OFFLINE'));
  document.getElementById('hostinfo').textContent =
    'Sigenergy Cloud OpenAPI · ' + (SYSTEMS.length ? SYSTEMS.length + ' sistem(a)' : 'nije konfigurisan');
  document.getElementById('modeinfo').textContent = d.error || '';
}

function connectWS() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type !== 'sigen') return;
    if (m.systems && m.systems.length) SYSTEMS = m.systems;
    STATES = m.values || STATES;
    setStatus(m); render();
  };
  ws.onclose = () => { setBadge('offline', 'VEZA PREKINUTA'); setTimeout(connectWS, 2000); };
}
function setBadge(c, t) { const b = document.getElementById('conn'); b.className = 'badge ' + c; b.textContent = t; }

async function setMode(systemId, mode) {
  const r = await fetch('/api/sigen/write', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemId, mode }),
  });
  if (!r.ok) alert('Greška: ' + ((await r.json()).error || r.status));
}
document.addEventListener('click', e => {
  const b = e.target.closest('.modebtn'); if (!b) return;
  const systemId = b.dataset.system, mode = Number(b.dataset.mode), name = b.textContent;
  const sys = (SYSTEMS.find(s => s.systemId === systemId) || {}).name || systemId;
  if (confirm(`[${sys}] Prebaciti režim rada na "${name}"?\n(menja solarnu elektranu UŽIVO)`)) setMode(systemId, mode);
});
function tick() { const c = document.getElementById('clock'); if (c) c.textContent = new Date().toLocaleString('sr-RS'); }
init();

// Kotlarnica SCADA - backend (Unitronics PCOM/TCP master + REST + WebSocket)
// Pokretanje:  npm install  &&  npm start
// Env:
//   PLC_IP   (default 192.168.75.25)  PLC_PORT (502)  PLC_UNIT (1)
//   SIMULATE ("false" = pravi PLC, "true" = lazni podaci)   HTTP_PORT (3000)

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Pcom } = require('./pcom');
const { TAGS, ZONES } = require('./tags');
const history = require('./history');
const notifier = require('./notifier');
const fs = require('fs');
const { Loxone } = require('./loxone/loxone');
const { buildLoxoneTags, loxCommand } = require('./loxone/loxtags');
const { LoxWS } = require('./loxone/loxws');
const { Sigen, SigenRateLimit, SigenTransient, SWITCHABLE_MODES } = require('./sigen/sigen');
const { SIG_TAGS, flattenSigen, modeOptions } = require('./sigen/sigtags');
const { BlueLog } = require('./bluelog/bluelog');
const { buildBlueLogTags, normalize: blNormalize } = require('./bluelog/bluelogtags');
const { S7Web } = require('./s7/s7web');
const { flattenS7, validateWrite } = require('./s7/s7tags');

// minimalni .env loader (bez dependency-ja) — postavi env samo ako nije već zadat
try {
  require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* nema .env — koristi env/podrazumevane */ }

const CFG = {
  plcIp:   process.env.PLC_IP   || '192.168.75.25',
  plcPort: parseInt(process.env.PLC_PORT || '502', 10),
  plcUnit: parseInt(process.env.PLC_UNIT || '1', 10),
  simulate: (process.env.SIMULATE || 'false').toLowerCase() === 'true',
  httpPort: parseInt(process.env.HTTP_PORT || '3000', 10),
  pollMs: 1000,
};

const state = {};
let plcOnline = false;
let plc = null;

let plcConnecting = false, plcNextTry = 0;
async function ensureConnected() {
  if (CFG.simulate) return false;
  if (plc && plc.connected) return true;
  if (plcConnecting || Date.now() < plcNextTry) return false;  // jedan pokušaj odjednom + backoff
  plcConnecting = true;
  try {
    plc = new Pcom(CFG.plcIp, CFG.plcPort, CFG.plcUnit);
    await plc.connect();
    plcOnline = true;
    console.log(`[PLC] PCOM povezan na ${CFG.plcIp}:${CFG.plcPort}`);
    return true;
  } catch (e) {
    plcOnline = false;
    plcNextTry = Date.now() + 8000;  // sačekaj 8s pre sledećeg pokušaja (ne gušiti Jazz)
    console.warn(`[PLC] veza neuspesna: ${e.message}`);
    return false;
  } finally {
    plcConnecting = false;
  }
}

function setRaw(t, raw) {
  const value = (t.scale && raw !== null) ? raw / t.scale : raw;
  state[t.name] = { value, raw, ts: Date.now() };
}
// satnice su BCD u 16-bit registru: high byte = sati (BCD), low byte = minuti (BCD)
function bcdToHHMM(raw) {
  const h = ((raw >> 12) & 0xf) * 10 + ((raw >> 8) & 0xf);
  const m = ((raw >> 4) & 0xf) * 10 + (raw & 0xf);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function hhmmToBcd(s) {
  const [h, m] = String(s).split(':').map(x => parseInt(x, 10) || 0);
  return ((Math.floor(h / 10) & 0xf) << 12) | ((h % 10) << 8) | ((Math.floor(m / 10) & 0xf) << 4) | (m % 10);
}
function setSchedTime(t, raw) { state[t.name] = { value: bcdToHHMM(raw), raw, ts: Date.now() }; }

// ---------- ZIVO citanje (PCOM batch) ----------
async function readLive() {
  const mi = await plc.readWords(20, 44);        // MI20..63
  const mb = await plc.readBits('RB', 0, 27);    // MB0..26
  const di = await plc.readBits('RE', 0, 16);    // I0..15
  const ou = await plc.readBits('RA', 0, 19);    // O0..18
  for (const t of TAGS) {
    let raw = null;
    if (t.type === 'MI') raw = (t.addr >= 20 && t.addr <= 63) ? mi[t.addr - 20] : null;
    else if (t.type === 'MB') raw = mb[t.addr];
    else if (t.type === 'I')  raw = di[t.addr];
    else if (t.type === 'O')  raw = ou[t.addr];
    if (raw !== undefined && raw !== null) {
      if (t.kind === 'schedtime') setSchedTime(t, raw);
      else setRaw(t, raw);
    }
  }
}

async function writeTag(t, value) {
  if (CFG.simulate) {
    if (t.kind === 'schedtime') setSchedTime(t, hhmmToBcd(value));
    else setRaw(t, value);
    if (t.kind === 'cmd') setTimeout(() => setRaw(t, 0), 600);
    return;
  }
  if (!(await ensureConnected())) throw new Error('PLC nije dostupan');
  if (t.type === 'MI') {
    if (t.kind === 'schedtime') await plc.writeWord(t.addr, hhmmToBcd(value));
    else await plc.writeWord(t.addr, Math.round(value));
  } else if (t.type === 'MB') {
    await plc.writeBit('SB', t.addr, value);
  } else if (t.type === 'O') {
    await plc.writeBit('SA', t.addr, value);
    if (t.kind === 'cmd') setTimeout(() => plc.writeBit('SA', t.addr, 0).catch(() => {}), 600);
  }
}

// ---------- Simulacija ----------
const sim = { tick: 0 };
function heatDemand(zone) {
  const tt = tempFor(zone);
  const sp = state[setpointFor(zone)]?.value ?? 22;
  return tt !== null && tt < sp - 0.3 ? 1 : 0;
}
function simulateAll() {
  sim.tick++;
  for (const t of TAGS) {
    if (t.kind === 'setpoint' || t.kind === 'mode' || t.kind === 'manual' || t.kind === 'schedday') {
      if (state[t.name] === undefined) setRaw(t, defaultVal(t));
      continue;
    }
    if (t.kind === 'schedtime') {
      if (state[t.name] === undefined) setSchedTime(t, defaultSched(t));
      continue;
    }
    if (t.kind === 'temp') {
      const sp = state[setpointFor(t.zone)]?.value ?? 22;
      const wobble = Math.sin((sim.tick + t.addr) / 12) * 1.5;
      const v = (t.zone === 'SPOLJA') ? 8 + Math.sin(sim.tick / 30) * 4 : sp + wobble;
      setRaw(t, Math.round(v * t.scale));
    } else if (t.kind === 'device' || t.kind === 'zoneout') {
      setRaw(t, heatDemand(t.zone));
    } else if (t.kind === 'alarm') {
      setRaw(t, 0);
    } else if (t.kind === 'cmd') {
      if (state[t.name] === undefined) setRaw(t, 0);
    } else if (t.kind === 'swinput') {
      setRaw(t, 1);
    } else {
      setRaw(t, ['KOTAO_RAD','TOPLOTNA_PUMPA','FREKVENTNI_RUN','PREKIDAC_ONOFF'].includes(t.name) ? 1 : 0);
    }
  }
}
function defaultVal(t) {
  if (t.kind === 'mode')     return (t.name === 'AUTO_MAN' || t.name === 'GREJ_HLAD') ? 1 : 0;
  if (t.kind === 'manual')   return 0;
  if (t.kind === 'schedday') return 1;
  const d = { SP_SPOLJA:18, SP_SUDA_H:80, SP_SUDA_L:60, SP_HIDRAULIKA:21,
              SP_CNC:20, SP_ZAVAR:19, SP_MONTAZA:21 };
  return (d[t.name] ?? 21) * (t.scale || 1);
}
function defaultSched(t) {
  const d = { T_PONPET_ON:0x0600, T_PONPET_OFF:0x1800, T_SUBNED_ON:0x0700, T_SUBNED_OFF:0x2200 };
  return d[t.name] ?? 0x0600;
}
function setpointFor(zone) {
  const m = { SPOLJA:'SP_SPOLJA', SUDA:'SP_SUDA_H', HIDRAULIKA:'SP_HIDRAULIKA',
              CNC:'SP_CNC', ZAVARIVANJE:'SP_ZAVAR', MONTAZA:'SP_MONTAZA' };
  return m[zone];
}
function tempFor(zone) {
  const t = TAGS.find(x => x.zone === zone && x.kind === 'temp');
  return t ? (state[t.name]?.value ?? null) : null;
}

// ---------- Poll ----------
const prevAlarm = {};
function checkAlarms() {
  for (const t of TAGS) {
    if (t.kind !== 'alarm') continue;
    const on = !!(state[t.name] && state[t.name].value);
    if (on && !prevAlarm[t.name]) notifier.alarm(t.name, t.label);  // edge 0->1
    prevAlarm[t.name] = on;
  }
}

async function poll() {
  if (CFG.simulate) { simulateAll(); }
  else if (await ensureConnected()) {
    try { await readLive(); plcOnline = true; }
    catch (e) { plcOnline = false; console.warn('[PLC] greska citanja: ' + e.message); plc && plc.close(); }
  }
  history.record(TAGS, state);
  checkAlarms();
  broadcast();
}

// ---------- HTTP + WS ----------
const app = express();
app.use(express.json());
// Overview je početna; Kotlarnica (stari index.html) na /kotlarnica. (mora PRE static)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overview.html')));
app.get('/kotlarnica', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/tags', (req, res) => res.json({ tags: TAGS, zones: ZONES, online: plcOnline, simulate: CFG.simulate }));
app.get('/api/state', (req, res) => res.json(snapshot()));
app.get('/api/history', (req, res) => res.json({
  tags: TAGS.filter(t => t.kind === 'temp' || t.kind === 'setpoint')
            .map(t => ({ name: t.name, label: t.label, kind: t.kind, zone: t.zone })),
  series: history.get(),
}));
app.post('/api/write', async (req, res) => {
  const { name, value } = req.body || {};
  const t = TAGS.find(x => x.name === name);
  if (!t) return res.status(404).json({ error: 'nepoznat tag' });
  if (t.access !== 'rw') return res.status(403).json({ error: 'tag je samo za citanje' });
  try {
    const raw = t.scale ? Math.round(value * t.scale) : value;
    await writeTag(t, raw);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function snapshot() {
  const out = {};
  for (const t of TAGS) out[t.name] = state[t.name] || { value: null, raw: null };
  return { values: out, online: CFG.simulate ? true : plcOnline, simulate: CFG.simulate };
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
function broadcast() {
  const msg = JSON.stringify({ type: 'state', ...snapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'state', ...snapshot() }));
  if (lox) ws.send(JSON.stringify({ type: 'loxone', ...loxSnapshot() }));
  if (sigen) ws.send(JSON.stringify({ type: 'sigen', ...sigSnapshot() }));
  if (bl) ws.send(JSON.stringify({ type: 'bluelog', ...blSnapshot() }));
  if (s7) ws.send(JSON.stringify({ type: 's7', ...s7Snapshot() }));
});

// ---------- LOXONE (Nova zgrada) — opciono, ako je LOXONE_HOST zadat ----------
let lox = null, loxTags = [], loxState = {}, loxws = null;
function loxInit() {
  if (!process.env.LOXONE_HOST) return;
  lox = new Loxone(process.env.LOXONE_HOST, process.env.LOXONE_USER, process.env.LOXONE_PASS);
  try {
    const struct = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'loxone-structure.json'), 'utf8'));
    loxTags = buildLoxoneTags(struct);
    console.log(`[Loxone] ${loxTags.length} tagova @ ${process.env.LOXONE_HOST}`);
  } catch (e) {
    console.warn('[Loxone] nema strukture (pokreni: npm run loxone:discover): ' + e.message);
  }
  // WebSocket za ŽIVO stanje svih state-UUID-eva (temp, brzina, režim po sobi)
  loxws = new LoxWS(process.env.LOXONE_HOST, process.env.LOXONE_USER, process.env.LOXONE_PASS);
  loxws.start();
}
async function loxPoll() {
  if (!lox || !loxTags.length) return;
  for (let i = 0; i < loxTags.length; i += 8) {            // u grupama po 8 (paralelno)
    await Promise.all(loxTags.slice(i, i + 8).map(async t => {
      try { loxState[t.key] = { value: await lox.state(t.uuid), ts: Date.now() }; } catch (e) {}
    }));
  }
  const msg = JSON.stringify({ type: 'loxone', ...loxSnapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function loxSnapshot() {
  return {
    tags: loxTags, values: loxState,
    live: loxws ? loxws.values : {},        // uuid(state) -> vrednost (WebSocket, živo)
    wsReady: loxws ? loxws.ready : false,
    host: process.env.LOXONE_HOST || null,
  };
}

// ---------- SIGENERGY (solarna elektrana, Cloud OpenAPI) — opciono, VIŠE SISTEMA ----------
// Lista sistema se PREUZIMA SA CLOUD-a i osvežava periodično — Sigenergy ume da podeli ili doda
// sistem (06.07.2026. je "Servoteh_110" razdvojen na dva: 135 kWp + novi 110 kWp), a fiksna lista
// u .env je novi sistem ostavila nevidljivim ~3 nedelje (~970 kWh/dan van evidencije).
//   SIGEN_SYSTEM_ID   opciono: seed dok discovery ne stigne + fallback ako cloud lista padne
//   SIGEN_SYSTEM_LOCK true = čitaj ISKLJUČIVO ID-jeve iz .env (ne uzimaj nove sa naloga)
// Rate-limit: 1 zahtev po endpointu/5min -> poll na SIGEN_POLL_MS (default 300000).
// Po sistemu 3 endpointa; svaki systemId je zaseban put pa se limit broji odvojeno.
let sigen = null, sigSystemIds = [], sigSystems = [], sigStates = {}, sig_lastRaw = {};
let sigEnvIds = [], sigLock = false, sigDiscoveredAt = 0;
let sigHist = {};   // ring buffer dnevne krive po sistemu: [{t,pv,lo,gr,ba,soc}] (Power Metrics grafik)
let sigOnline = false, sigErr = null;
// Po sistemu: vreme poslednjeg USPEŠNOG energyFlow-a (ms) i broj uzastopnih grešaka.
// Meka greška (rate-limit/transient) zadrži STARE vrednosti pa UI izgleda "online" a podaci su zamrznuti;
// ovo omogućava UI-u da prikaže "⚠ ZASTARELO" umesto da lažne brojeve crta kao aktuelne.
let sigFlowSeen = {}, sigFlowFail = {};
// Kontrola je default ISKLJUČENA: njihov OpenAPI katalog trenutno nema kontrolne
// endpointe (Control = prazno). Kad Sigenergy odobri kontrolu -> SIGEN_CONTROL=true.
const sigControl = (process.env.SIGEN_CONTROL || 'false').toLowerCase() === 'true';
function sigInit() {
  sigEnvIds = (process.env.SIGEN_SYSTEM_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  sigLock = (process.env.SIGEN_SYSTEM_LOCK || 'false').toLowerCase() === 'true';
  const haveKey = process.env.SIGEN_APP_KEY && process.env.SIGEN_APP_SECRET;
  const havePass = process.env.SIGEN_USER && process.env.SIGEN_PASS;
  if (!haveKey && !havePass) return;                 // bez kredencijala nema ničega
  sigen = new Sigen({
    region: process.env.SIGEN_REGION || 'eu',
    authMethod: haveKey ? 'key' : 'password',
    appKey: process.env.SIGEN_APP_KEY,
    appSecret: process.env.SIGEN_APP_SECRET,
    username: process.env.SIGEN_USER,
    password: process.env.SIGEN_PASS,
  });
  sigSystemIds = sigEnvIds.slice();                  // radi odmah, do prvog discovery-ja
  sigSystems = sigSystemIds.map(id => ({ systemId: id, name: id }));
  console.log(`[Sigen] OpenAPI (${process.env.SIGEN_REGION || 'eu'}), poll ${sigPollMs() / 1000}s, lista sa naloga${sigLock ? ' (LOCK: samo .env)' : ''}`);
  sigRefreshSystems(true).catch(() => {});
}
// Lista sistema sa naloga -> sigSystemIds. Ne ruši rad ako cloud ne odgovori (ostaje prethodna lista).
async function sigRefreshSystems(first = false) {
  if (!sigen) return;
  let list;
  try { list = await sigen.getSystemList(); }
  catch (e) {
    console.warn('[Sigen] lista sistema: ' + e.message + (sigSystemIds.length ? ' — zadržavam prethodnu' : ''));
    return;
  }
  const found = list
    .map(s => ({ systemId: s.systemId || s.id || s.installationId, name: s.systemName || s.name || null }))
    .filter(s => s.systemId);
  const keep = (sigLock && sigEnvIds.length) ? found.filter(s => sigEnvIds.includes(s.systemId)) : found;
  // ID iz .env koji se ne pojavi u listi (npr. Installation ID sa portala) ipak zadrži
  for (const id of sigEnvIds) if (!keep.some(s => s.systemId === id)) keep.push({ systemId: id, name: id });

  const prev = new Set(sigSystemIds);
  sigSystems = keep.map(s => ({ systemId: s.systemId, name: s.name || s.systemId }));
  sigSystemIds = sigSystems.map(s => s.systemId);
  sigDiscoveredAt = Date.now();

  const nova = sigSystems.filter(s => !prev.has(s.systemId));
  const nestali = [...prev].filter(id => !sigSystemIds.includes(id));
  console.log(`[Sigen] ${sigSystemIds.length} sistem(a): ${sigSystems.map(s => `${s.name} (${s.systemId})`).join(', ')}`);
  if (prev.size && nova.length) {                    // na praznom startu ne spamuj — tad je "novo" sve
    const txt = nova.map(s => `${s.name} (${s.systemId})`).join(', ');
    console.log('[Sigen] NOVI SISTEM na nalogu: ' + txt);
    notifier.send(`ℹ️ SIGENERGY — nov sistem na nalogu: ${txt}\nDodat je u očitavanje automatski.`);
  }
  if (nestali.length) console.warn('[Sigen] sistem više nije na nalogu: ' + nestali.join(', '));
  // Očitaj odmah SAMO nove sisteme (da ne čekaju pun ciklus). Stare NE diramo — tek su
  // pollovani, pa bi ponovni zahtev udario u rate-limit (1/endpoint/5min) i lažno ih
  // obeležio kao "zastarele" (sigFlowFail).
  if (nova.length) {
    Promise.all(nova.map(s => sigPollOne(s.systemId).catch(() => {}))).then(() => {
      const msg = JSON.stringify({ type: 'sigen', ...sigSnapshot() });
      wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    });
  }
}
function sigPollMs() { return Math.max(60000, parseInt(process.env.SIGEN_POLL_MS || '300000', 10)); }
function sigDiscoverMs() { return Math.max(15 * 60000, parseInt(process.env.SIGEN_DISCOVER_MS || String(6 * 3600 * 1000), 10)); }
async function sigPollOne(id) {
  const prev = sig_lastRaw[id] || { flow: {}, sum: {}, mode: null };
  // kreni od prethodnih vrednosti -> rate-limit/transient prirodno zadrži poslednje dobre
  const out = { flow: prev.flow || {}, sum: prev.sum || {}, mode: prev.mode ?? null };
  const soft = e => (e instanceof SigenTransient) || (e instanceof SigenRateLimit);
  let flowFresh = false;
  try { out.flow = await sigen.getEnergyFlow(id); flowFresh = true; }
  catch (e) {
    if (!soft(e)) sigErr = e.message;
    // Meka greška NE ruši UI ali zadržava STARE vrednosti (energyFlow zamrznut). Ranije bilo
    // potpuno tiho -> zamrznuće nevidljivo satima. Sada loguj i broji uzastopne (staleness u snapshot-u).
    const n = (sigFlowFail[id] = (sigFlowFail[id] || 0) + 1);
    console.warn(`[Sigen] ${id} energyFlow ${soft(e) ? 'meka greška' : 'greška'}: ${e.message} (uzastopno ${n}) — zadržavam prethodne vrednosti`);
  }
  if (flowFresh) { sigFlowSeen[id] = Date.now(); sigFlowFail[id] = 0; }
  try { out.sum = await sigen.getSummary(id); }     catch (e) { if (!soft(e)) sigErr = e.message; }
  try { out.mode = await sigen.getOperatingMode(id); } catch (e) { if (!soft(e)) sigErr = e.message; }
  const has = Object.keys(out.flow).length > 0 || Object.keys(out.sum).length > 0 || out.mode != null;
  if (has) {
    sigStates[id] = flattenSigen(out); sig_lastRaw[id] = out;
    const v = sigStates[id], h = (sigHist[id] = sigHist[id] || []);
    // sigStates drži {value,ts} po tag-u -> u istoriju idu GOLI brojevi (grafik očekuje broj, ne objekat)
    const num = k => (v[k] && v[k].value != null) ? v[k].value : null;
    h.push({ t: Date.now(), pv: num('pvPower'), lo: num('loadPower'), gr: num('gridPower'), ba: num('batteryPower'), soc: num('batterySoc') });
    if (h.length > 600) h.shift();   // ~50h pri 5-min pollu
  }
  return has;
}
async function sigPoll() {
  if (!sigen || !sigSystemIds.length) return;
  let okAny = false;
  for (const id of sigSystemIds) { if (await sigPollOne(id)) okAny = true; }
  sigOnline = okAny;
  if (okAny) sigErr = null;
  const msg = JSON.stringify({ type: 'sigen', ...sigSnapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function sigSnapshot() {
  // po sistemu: svežina realtime (energyFlow) bloka. stale = nije uspešno osvežen > 2.5 poll ciklusa.
  const now = Date.now(), pollMs = sigPollMs(), staleMs = pollMs * 2.5;
  const flow = {};
  for (const id of sigSystemIds) {
    const seen = sigFlowSeen[id] || null, fails = sigFlowFail[id] || 0;
    // stale = viđen ali star > 2.5 ciklusa, ILI nikad viđen a ≥2 uzastopne greške (npr. cloud 502 od starta)
    flow[id] = { seen, ageMs: seen ? (now - seen) : null,
                 stale: seen ? (now - seen) > staleMs : (fails >= 2), fails };
  }
  return { tags: SIG_TAGS, modes: modeOptions(), systems: sigSystems,
           values: sigStates, online: sigOnline, error: sigErr, control: sigControl,
           pollMs, flow, discoveredAt: sigDiscoveredAt || null };
}

app.get('/api/sigen', (req, res) => res.json(sigSnapshot()));
app.get('/api/sigen/history', (req, res) => {
  const sys = req.query.system;
  res.json({ samples: sys ? (sigHist[sys] || []) : sigHist, pollMs: sigPollMs() });
});
app.post('/api/sigen/write', async (req, res) => {
  if (!sigen) return res.status(503).json({ error: 'Sigenergy nije konfigurisan' });
  if (!sigControl) return res.status(403).json({ error: 'kontrola je isključena (SIGEN_CONTROL=false) — cloud nema kontrolne endpointe' });
  const { systemId, mode } = req.body || {};
  const id = systemId || sigSystemIds[0];
  if (!sigSystemIds.includes(id)) return res.status(404).json({ error: 'nepoznat systemId' });
  if (!(Number(mode) in SWITCHABLE_MODES)) return res.status(400).json({ error: 'nedozvoljen režim (samo 0 ili 5)' });
  try {
    await sigen.setOperatingMode(id, Number(mode));
    sigStates[id] = flattenSigen({ ...(sig_lastRaw[id] || {}), mode: Number(mode) });
    if (sig_lastRaw[id]) sig_lastRaw[id].mode = Number(mode);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/loxone', (req, res) => res.json(loxSnapshot()));
app.post('/api/loxone/write', async (req, res) => {
  const { key, value } = req.body || {};
  const t = loxTags.find(x => x.key === key);
  if (!t) return res.status(404).json({ error: 'nepoznat tag' });
  if (!t.writable) return res.status(403).json({ error: 'read-only' });
  try { const r = await lox.command(t.uuid, loxCommand(t, value)); res.json({ ok: true, code: r.Code }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Zadavanje CILJ temperature u sobi (IRoomControllerV2): mode 'heat'|'cool'
app.post('/api/loxone/roomtemp', async (req, res) => {
  const { key, mode, value } = req.body || {};
  const t = loxTags.find(x => x.key === key && x.type === 'IRoomControllerV2');
  if (!t) return res.status(404).json({ error: 'nije sobni regulator' });
  const v = Number(value);
  if (!(v >= 5 && v <= 35)) return res.status(400).json({ error: 'temperatura van opsega 5–35' });
  const cmd = (mode === 'cool' ? 'setComfortTemperatureCool' : 'setComfortTemperature') + '/' + v;
  try { const r = await lox.command(t.uuid, cmd); res.json({ ok: true, code: r.Code }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- blue'Log (Solarna elektrana FNE SERVOTEH, meteocontrol X-Control) — opciono, ako je BLUELOG_HOST zadat ----------
// Lokalni REST koji koristi web "cockpit" (NEZVANIČAN privatni API; vidi bluelog/bluelog.js). Read-only.
// Prijava: POST /login {username, password:MD5}. Žive vrednosti: POST /device/values (1-min rezolucija).
// Snaga postrojenja = suma P_AC svih invertora. Pri firmware update-u proveri: npm run bluelog:discover.
let bl = null, blMap = null, blState = {}, blInfo = null, blOnline = false, blErr = null;
let blHist = [];   // ring buffer PV krive dana (Power Metrics grafik)
// --- alarmi i dojava (nauceno 29.07.2026: 5 invertora je 19h bilo van magistrale a niko nije znao) ---
let blAlarms = [], blOverview = null, blAlarmAt = 0;
let blSeenAlarm = new Map();   // "deviceId:code" -> opis (za edge-detekciju i "alarm prosao")
let blLastSeenTs = {};         // deviceId -> poslednji trenutak sa podatkom (za "ne javlja" mrezu bezbednosti)
let blDownSince = null;        // otkad je logger nedostupan
const FNE = 'FNE SERVOTEH';
function blPollMs() { return Math.max(15000, parseInt(process.env.BLUELOG_POLL_MS || '30000', 10)); }
function blAlarmPollMs() { return Math.max(30000, parseInt(process.env.BLUELOG_ALARM_POLL_MS || '120000', 10)); }
function blOfflineMs() { return Math.max(5, parseInt(process.env.BLUELOG_OFFLINE_MIN || '15', 10)) * 60000; }
// --- Uzak spisak za MEJL. Sve ostalo ide samo na Telegram. ---
// Mereno 30.07.2026: zastitne sklopke kot2 podizu se ~68x dnevno po kodu — zato mejl
// NIKAD ne ide po kodu koji nije ovde, i nikad pre nego sto kvar potraje.
function blMailCodes() { return (process.env.ALERT_MAIL_CODES || 'NOCOMM_RS485').split(',').map(s => s.trim()).filter(Boolean); }
function blMailAfterMs() { return Math.max(1, parseInt(process.env.ALERT_MAIL_AFTER_MIN || '10', 10)) * 60000; }
function blHotC() { return parseFloat(process.env.BLUELOG_HOT_C || '75'); }
let blHotSince = {};   // deviceId -> otkad je invertor iznad praga (da trenutni skok ne salje mejl)
function blInit() {
  if (!process.env.BLUELOG_HOST) return;
  if (!process.env.BLUELOG_USER || !process.env.BLUELOG_PASS) {
    console.warn("[blue'Log] BLUELOG_HOST zadat ali fali BLUELOG_USER/PASS — preskačem.");
    return;
  }
  bl = new BlueLog(process.env.BLUELOG_HOST, process.env.BLUELOG_USER, process.env.BLUELOG_PASS);
  console.log(`[blue'Log] @ ${process.env.BLUELOG_HOST}, poll ${blPollMs() / 1000}s`);
}
async function blPoll() {
  if (!bl) return;
  try {
    if (!bl.loggedIn) { await bl.login(); blInfo = await bl.info().catch(() => null); console.log("[blue'Log] prijavljen"); }
    if (!blMap || !blMap.inverterIds.length) {                      // jednom: lista uređaja
      blMap = buildBlueLogTags(await bl.getDevices());
      console.log(`[blue'Log] ${blMap.inverters.length} invertora${blMap.meter ? ' + brojilo' : ''}`);
    }
    const latestInv = await bl.latestValues(blMap.inverterIds, blMap.inverterAbbrs, { minutes: 15 });
    const latestMeter = blMap.meter ? await bl.latestValues([blMap.meter.id], blMap.meterAbbrs, { minutes: 15 }) : {};
    if (Date.now() - blAlarmAt >= blAlarmPollMs()) {          // alarmi se menjaju retko — redji poll
      blAlarmAt = Date.now();
      try { blAlarms = await bl.getAlarms({ days: 14 }); }
      catch (e) { console.warn("[blue'Log] alarmi: " + e.message); }
      try { blOverview = await bl.overview(); } catch (e) { /* pregled je dodatak, ne ruši poll */ }
    }
    blState = blNormalize(blMap, latestInv, latestMeter, { alarms: blAlarms, overview: blOverview });
    blOnline = true; blErr = null;
    if (blDownSince) { notifier.clear('bl:logger', 'logger je ponovo dostupan', FNE); blDownSince = null; }
    blCheckAlarms(blState);
    const bp = blState.plant || {}, bm = blState.meter || {}, bnow = Date.now(), blast = blHist[blHist.length - 1];
    if (!blast || bnow - blast.t >= 55000) {
      blHist.push({ t: bnow, pv: bp.kw ?? null, gr: (bm.pActive != null ? bm.pActive / 1000 : null) });
      if (blHist.length > 2000) blHist.shift();
    }
  } catch (e) {
    blOnline = false; blErr = e.message;
    if (!blDownSince) blDownSince = Date.now();
    else if (Date.now() - blDownSince > blOfflineMs()) notifier.alarm('bl:logger', `logger ${process.env.BLUELOG_HOST} nedostupan (${e.message})`, FNE);
    console.warn("[blue'Log] " + e.message);
  }
  const msg = JSON.stringify({ type: 'bluelog', ...blSnapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// Dojava za solarnu elektranu. Dva izvora, bez dupliranja:
//   1) alarmi koje javlja sam logger (autoritativno — ima kod, poruku i tacan pocetak)
//   2) mreza bezbednosti: invertor bez ijedne vrednosti duze od BLUELOG_OFFLINE_MIN,
//      a logger za njega NE javlja alarm (npr. otkaze i sama lista alarma)
function blCheckAlarms(st) {
  const now = Date.now();
  const activeAlarms = (st.alarms || []).filter(a => a.active);
  const seen = new Map();
  for (const a of activeAlarms) {
    const key = `${a.deviceId}:${a.code}`;
    const what = `${a.deviceName || a.deviceId} — ${a.message || a.code}${a.port ? ` [${a.port}]` : ''}`;
    seen.set(key, what);
    if (!blSeenAlarm.has(key)) notifier.alarm('bl:' + key, what, FNE);
  }
  for (const [key, what] of blSeenAlarm) if (!seen.has(key)) notifier.clear('bl:' + key, what, FNE);
  blSeenAlarm = seen;

  const alarmed = new Set(activeAlarms.map(a => a.deviceId));
  for (const inv of st.inverters || []) {
    const key = 'bl:nodata:' + inv.id;
    const label = `INV ${inv.address != null ? inv.address : inv.id} ne javlja podatke`;
    if (inv.ts) blLastSeenTs[inv.id] = inv.ts;
    if (inv.online) { notifier.clear(key, label, FNE); continue; }
    const last = blLastSeenTs[inv.id];
    if (last && now - last > blOfflineMs() && !alarmed.has(inv.id)) {
      notifier.alarm(key, `${label} ${Math.round((now - last) / 60000)} min`, FNE);
    }
  }

  // ---- KRITICNO → MEJL (uzak spisak + kvar mora POTRAJATI) ----
  const p = st.plant || {};
  for (const a of activeAlarms) {
    if (!blMailCodes().includes(a.code)) continue;              // nije na spisku → nikad mejl
    if (!a.start || now - a.start < blMailAfterMs()) continue;  // trepće → ne šalji
    const who = a.address != null ? `INV ${a.address}` : (a.deviceName || a.deviceId);
    notifier.critical(`bl:crit:${a.deviceId}:${a.code}`,
      `FNE Servoteh — ${who} ne radi`,
      [`Uređaj: ${a.deviceName || a.deviceId}`,
       `Greška: ${a.message || a.code}${a.port ? ` [${a.port}]` : ''}`,
       `Traje od: ${new Date(a.start).toLocaleString('sr-RS')} (${Math.round((now - a.start) / 60000)} min)`,
       `Invertora javlja: ${p.reportingInverters}/${p.count}`,
       `Proizvodnja danas: ${p.kwhDay} kWh`], FNE);
  }

  // ---- TEMPERATURNA ANOMALIJA: invertor iznad praga, održano ----
  for (const inv of st.inverters || []) {
    if (inv.temp == null || inv.temp <= blHotC()) { delete blHotSince[inv.id]; continue; }
    if (!blHotSince[inv.id]) blHotSince[inv.id] = now;
    if (now - blHotSince[inv.id] < blMailAfterMs()) continue;
    notifier.critical(`bl:hot:${inv.id}`,
      `FNE Servoteh — invertor INV ${inv.address} pregrejan (${inv.temp} °C)`,
      [`Uređaj: ${inv.name || inv.id}`,
       `Temperatura: ${inv.temp} °C (prag ${blHotC()} °C)`,
       `Iznad praga: ${Math.round((now - blHotSince[inv.id]) / 60000)} min`,
       `Trenutna snaga: ${inv.pAc != null ? (inv.pAc / 1000).toFixed(1) + ' kW' : '—'}`,
       `Proizvodnja danas: ${inv.eDay != null ? (inv.eDay / 1000).toFixed(1) + ' kWh' : '—'}`], FNE);
  }
}

function blSnapshot() {
  return { online: blOnline, error: blErr, host: process.env.BLUELOG_HOST || null,
           plantName: blInfo && blInfo.loggerName, model: blInfo && blInfo.model,
           alarmsAt: blAlarmAt || null,
           ...blState };
}
app.get('/api/bluelog', (req, res) => res.json(blSnapshot()));
app.get('/api/bluelog/history', (req, res) => res.json({ samples: blHist, pollMs: blPollMs() }));

// ---------- SIEMENS HALA 5 (S7-1200, AWP web most) — opciono ----------
// Aktivira se ako je S7_HOST zadat. READ svakih S7_POLL_MS (default 5s) preko web servera;
// WRITE preko /api/s7/write (whitelist). Bez izmena na PLC-u (Faza 1).
let s7 = null, s7State = {}, s7Online = false, s7Err = null;
function s7PollMs() { return Math.max(2000, parseInt(process.env.S7_POLL_MS || '5000', 10)); }
function s7Init() {
  if (!process.env.S7_HOST) return;
  s7 = new S7Web(process.env.S7_HOST, process.env.S7_USER || 'admin', process.env.S7_PASS || 'admin');
  console.log(`[S7 Hala5] AWP web @ ${process.env.S7_HOST}, poll ${s7PollMs() / 1000}s`);
}
async function s7Poll() {
  if (!s7) return;
  try {
    s7State = flattenS7(await s7.readAll());
    s7Online = true; s7Err = null;
  } catch (e) { s7Online = false; s7Err = e.message; }
  const msg = JSON.stringify({ type: 's7', ...s7Snapshot() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function s7Snapshot() {
  return { host: process.env.S7_HOST || null, online: s7Online, error: s7Err, ...s7State };
}
app.get('/api/s7', (req, res) => res.json(s7Snapshot()));
app.post('/api/s7/write', async (req, res) => {
  if (!s7) return res.status(503).json({ error: 'Hala 5 (S7) nije konfigurisana' });
  const { tag, value } = req.body || {};
  let cmd;
  try { cmd = validateWrite(tag, value); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    await s7.write(cmd.tag, cmd.value);
    setTimeout(() => { s7Poll().catch(() => {}); }, 700);   // brzo osveži stanje posle upisa
    res.json({ ok: true, tag: cmd.tag, value: cmd.value });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

server.listen(CFG.httpPort, () => {
  console.log(`\n  KOTLARNICA SCADA -> http://localhost:${CFG.httpPort}`);
  console.log(`  Mod: ${CFG.simulate ? 'SIMULACIJA' : `PRAVI PLC (PCOM) ${CFG.plcIp}:${CFG.plcPort}`}`);
  console.log(`  Telegram alarmi: ${notifier.configured() ? 'aktivni' : 'isključeni (nema tokena)'}\n`);
  history.load();
  setInterval(poll, CFG.pollMs);
  poll();
  setInterval(() => history.save(), 5 * 60 * 1000);  // periodični upis istorije
  loxInit();
  if (lox) { loxPoll(); setInterval(loxPoll, 8000); console.log('[Loxone] poll svakih 8s'); }
  sigInit();
  if (sigen) {
    sigPoll(); setInterval(sigPoll, sigPollMs());
    setInterval(() => { sigRefreshSystems().catch(() => {}); }, sigDiscoverMs());   // nov/podeljen sistem sam uđe
  }
  blInit();
  if (bl) { blPoll(); setInterval(blPoll, blPollMs()); console.log(`[blue'Log] poll svakih ${blPollMs() / 1000}s`); }
  s7Init();
  if (s7) { s7Poll(); setInterval(s7Poll, s7PollMs()); }
});
function shutdown() { try { history.save(); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

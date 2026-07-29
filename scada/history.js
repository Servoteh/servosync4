// Lokalna istorija/trendovi — bez baze, bez native modula. Cuva uzorke u memoriji
// (poslednja 24h, rezolucija 1 min) i periodicno upisuje u data/history.json.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'history.json');
const MAX = 1440;            // 24h @ 1 min
const EVERY_MS = 60 * 1000;  // uzorak svakih 60s
let series = {};
let lastRec = 0;

function load() {
  try { series = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (e) { series = {}; }
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(series));
  } catch (e) { /* ignore */ }
}
// Belezi temp + setpoint vrednosti; poziva se na svaki poll, sam ogranicava na 1/min.
function record(tags, state) {
  const now = Date.now();
  if (now - lastRec < EVERY_MS) return;
  lastRec = now;
  for (const t of tags) {
    if (t.kind !== 'temp' && t.kind !== 'setpoint') continue;
    const s = state[t.name];
    if (!s || s.value == null) continue;
    (series[t.name] || (series[t.name] = [])).push({ t: now, v: s.value });
    if (series[t.name].length > MAX) series[t.name].shift();
  }
}
function get() { return series; }

module.exports = { load, save, record, get };

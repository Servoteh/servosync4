// Loxone discovery — POKRENI NA MREŽI KOJA VIDI MINISERVER (VM ili PC u Novoj zgradi):
//   node loxone/discover.js
// Izvuče svu konfiguraciju (sobe/kontrole/UUID), ispiše je i snimi u
// data/loxone-structure.json. Iz toga pravimo tačnu Loxone tag-mapu.
const fs = require('fs');
const path = require('path');
const { Loxone } = require('./loxone');

// mini .env loader (učita app/.env)
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) {}

const HOST = process.env.LOXONE_HOST || '192.168.75.130';
const USER = process.env.LOXONE_USER || 'admin';
const PASS = process.env.LOXONE_PASS || '';

(async () => {
  const lx = new Loxone(HOST, USER, PASS);
  console.log(`Loxone @ ${HOST} (user ${USER}) …`);
  try {
    const app = await lx.structure();
    const rooms = app.rooms || {}, cats = app.cats || {}, controls = app.controls || {};
    const ms = app.msInfo || {};
    console.log(`\nMiniserver: ${ms.msName || '?'} | SN ${ms.serialNr || '?'} | fw ${ms.swVersion || '?'}`);
    console.log(`Kontrola: ${Object.keys(controls).length}, soba: ${Object.keys(rooms).length}\n`);

    const list = Object.entries(controls).map(([uuid, c]) => ({
      uuid, name: c.name, type: c.type,
      room: rooms[c.room] && rooms[c.room].name,
      cat: cats[c.cat] && cats[c.cat].name,
      states: c.states || {},
    }));
    // ispis grupisano po sobi
    const byRoom = {};
    for (const c of list) (byRoom[c.room || '—'] || (byRoom[c.room || '—'] = [])).push(c);
    for (const room of Object.keys(byRoom).sort()) {
      console.log(`### ${room}`);
      for (const c of byRoom[room]) {
        console.log(`  • ${c.name}  [${c.type}]  states: ${Object.keys(c.states).join(', ') || '-'}`);
      }
    }
    const out = path.join(__dirname, '..', 'data', 'loxone-structure.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ msInfo: ms, controls: list }, null, 2));
    console.log(`\n✅ Snimljeno: ${out}  — pošalji mi taj fajl (ili gornji ispis) da napravim tag-mapu.`);
  } catch (e) {
    console.error('\n❌ ' + e.message);
    if (/401/.test(e.message)) console.error('→ Javi mi: treba token auth (dodajem ga). Reci i firmware (Loxone Config → About).');
    else console.error('→ Proveri: da li mašina vidi ' + HOST + ' (ping / Test-NetConnection -Port 80) i kredencijale u .env.');
    process.exit(1);
  }
})();

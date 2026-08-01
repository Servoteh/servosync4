// blue'Log discovery — POKRENI NA MREŽI KOJA VIDI LOGGER (VM ili PC koji vidi 192.168.75.15):
//   node bluelog/discover.js
// Prijavi se na blue'Log i izvuče živu konfiguraciju + oblike podataka (koje endpoint vraća šta),
// ispiše sažetak i snimi SVE u data/bluelog-structure.json. Iz toga pravimo tačnu tag-mapu i poller.
//
// Bez ovog koraka ne znamo tačan JSON oblik /device/values, /overview/system-overview, /plant …
// (svi su iza prijave — vraćaju 403 bez sesije).

const fs = require('fs');
const path = require('path');
const { BlueLog } = require('./bluelog');

// mini .env loader (učita app/.env)
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) {}

const HOST = process.env.BLUELOG_HOST || '192.168.75.15';
const USER = process.env.BLUELOG_USER || '';
const PASS = process.env.BLUELOG_PASS || '';

// GET endpointi koje pokušavamo da pročitamo (rute izvučene iz aplikacije v30.x).
// Neki traže query param (npr. /devices?...) ili su POST — beležimo status svakako, pa se vidi šta radi.
const PROBES = [
  '/system/information',
  '/current-user',
  '/logger-name',
  '/system/licence',
  '/overview/system-overview',
  '/plant',
  '/plant/scada',
  '/plant/scada-get-devices',
  '/devices',
  '/device/values',
  '/device/status',
  '/device/energy-meter',
  '/power-display',
  '/alarm/alarms',
];

function preview(body, n = 600) {
  if (body === null || body === undefined) return '(prazno)';
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  return s.length > n ? s.slice(0, n) + ` … (+${s.length - n} char)` : s;
}

(async () => {
  if (!USER || !PASS) {
    console.error('❌ Nedostaju BLUELOG_USER / BLUELOG_PASS u app/.env');
    process.exit(2);
  }
  const bl = new BlueLog(HOST, USER, PASS);
  console.log(`blue'Log @ ${HOST} (user ${USER}) …`);
  try {
    const me = await bl.login();
    console.log(`✅ Prijava OK — user="${me && me.username || '?'}", accessLevel=${me && me.accessLevel}\n`);
  } catch (e) {
    console.error('❌ Prijava nije uspela: ' + e.message);
    if (e.status === 401) {
      console.error('→ 401 = pogrešno korisničko ime/lozinka za LOKALNU prijavu na logger (NE VCOM portal).');
      console.error('  Mehanizam je potvrđen ispravan (MD5 lozinka + CSRF); fali samo tačan lokalni login.');
      console.error('  Otvori http://' + HOST + ' u browseru i potvrdi tačno ime/lozinku, pa ih upiši u app/.env.');
    } else {
      console.error('→ Proveri da mašina vidi ' + HOST + ' (Test-NetConnection -Port 80) i kredencijale u .env.');
    }
    process.exit(1);
  }

  const out = { host: HOST, user: USER, fetchedAt: new Date().toISOString(), endpoints: {} };
  for (const ep of PROBES) {
    try {
      const r = await bl.get(ep);
      out.endpoints[ep] = { status: r.status, contentType: r.contentType, body: r.body };
      const tag = r.status === 200 ? '✅' : (r.status === 404 || r.status === 405 ? '·' : '⚠️');
      console.log(`${tag} ${String(r.status).padEnd(3)} GET ${ep}`);
      if (r.status === 200) console.log('      ' + preview(r.body));
    } catch (e) {
      out.endpoints[ep] = { error: e.message };
      console.log(`✖ ERR  GET ${ep}  — ${e.message}`);
    }
  }

  const file = path.join(__dirname, '..', 'data', 'bluelog-structure.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n✅ Snimljeno: ${file}`);
  console.log('   Pošalji mi taj fajl (ili gornji ispis) da finalizujem tag-mapu i poller za solarnu elektranu.');
})();

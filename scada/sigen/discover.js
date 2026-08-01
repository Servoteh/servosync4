// Sigenergy discovery — POKRENI POSLE UNOSA KREDENCIJALA U app/.env:
//   npm run sigen:discover
// Autentifikuje na Sigen Cloud OpenAPI, ispiše sve sisteme (systemId + ime),
// pokaže živi snapshot (PV/baterija/mreža) kao dokaz da čitanje radi, i ispiše
// tačne .env linije za nalepiti. Snima sve u data/sigen-systems.json.
//
// Kredencijali (u app/.env): SIGEN_REGION + (SIGEN_APP_KEY+SIGEN_APP_SECRET) ILI (SIGEN_USER+SIGEN_PASS).

const fs = require('fs');
const path = require('path');
const { Sigen, SigenAuthError, SigenRateLimit, OPERATING_MODES } = require('./sigen');

// mini .env loader (učita app/.env)
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) {}

const REGION = process.env.SIGEN_REGION || 'eu';
const haveKey = process.env.SIGEN_APP_KEY && process.env.SIGEN_APP_SECRET;
const havePass = process.env.SIGEN_USER && process.env.SIGEN_PASS;

function num(v) { return (v == null || isNaN(Number(v))) ? v : Number(v); }

(async () => {
  if (!haveKey && !havePass) {
    console.error('❌ Nedostaju kredencijali u app/.env.');
    console.error('   Upiši ILI:  SIGEN_APP_KEY + SIGEN_APP_SECRET   (preporuka, sa Developer Portala)');
    console.error('   ILI:        SIGEN_USER + SIGEN_PASS            (mySigen nalog)');
    process.exit(2);
  }
  const sg = new Sigen({
    region: REGION,
    authMethod: haveKey ? 'key' : 'password',
    appKey: process.env.SIGEN_APP_KEY,
    appSecret: process.env.SIGEN_APP_SECRET,
    username: process.env.SIGEN_USER,
    password: process.env.SIGEN_PASS,
  });
  console.log(`Sigen Cloud OpenAPI · region=${REGION} · base=${sg.base} · auth=${haveKey ? 'AppKey' : 'nalog'}\n`);

  // 1) Auth
  try {
    await sg.authenticate();
    console.log('✅ Autentikacija OK — token dobijen.\n');
  } catch (e) {
    console.error('❌ Autentikacija nije uspela: ' + e.message);
    if (e instanceof SigenAuthError) {
      if (e.code === 11002) console.error('→ 11002: nalog/AppKey nije pronađen u OVOM regionu. Proveri SIGEN_REGION (Srbija=eu) ili region naloga.');
      else if (e.code === 11003) console.error('→ 11003: pogrešna lozinka/secret.');
      else console.error('→ Proveri AppKey/AppSecret (ili user/pass) i region.');
    } else if (e instanceof SigenRateLimit) {
      console.error('→ Previše pokušaja — sačekaj par minuta (rate limit).');
    } else {
      console.error('→ Proveri internet i da je nalog/app aktiviran na developer.sigencloud.com.');
    }
    process.exit(1);
  }

  // 2) Lista sistema
  let systems = [];
  try {
    systems = await sg.getSystemList();
  } catch (e) {
    console.error('⚠️  /openapi/system nije vratio listu: ' + e.message);
    console.error('   (Ako koristiš AppKey, možda sistem još nije autorizovan/onboardovan na tvoju aplikaciju,');
    console.error('    ili Installation ID treba uzeti direktno sa Developer Portala i upisati u SIGEN_SYSTEM_ID.)');
  }

  if (!systems.length) {
    console.log('\nℹ️  Nema sistema sa /openapi/system. Ako na Portalu vidiš "Installation ID",');
    console.log('   upiši ga ručno u app/.env kao SIGEN_SYSTEM_ID i ponovi (discover će ga onda testirati).');
    const manual = process.env.SIGEN_SYSTEM_ID;
    if (manual) { console.log(`\n   Probam zadati SIGEN_SYSTEM_ID=${manual} …`); systems = [{ systemId: manual, systemName: '(iz .env)' }]; }
    else process.exit(0);
  }

  console.log(`\n=== SISTEMI (${systems.length}) ===`);
  const out = { region: REGION, base: sg.base, fetchedAt: new Date().toISOString(), systems: [] };
  for (const s of systems) {
    const id = s.systemId || s.id || s.installationId;
    console.log(`\n• systemId = ${id}   "${s.systemName || s.name || '?'}"`);
    if (s.batteryCapacity != null) console.log(`  baterija kapacitet: ${s.batteryCapacity} kWh`);
    const rec = { systemId: id, raw: s, energyFlow: null, summary: null, mode: null };
    // živi snapshot (dokaz da čitanje radi)
    try {
      const f = await sg.getEnergyFlow(id); rec.energyFlow = f;
      console.log(`  ⚡ PV=${num(f.pvPower)}kW  baterija=${num(f.batteryPower)}kW (SOC ${num(f.batterySoc)}%)  mreža=${num(f.gridPower)}kW  potrošnja=${num(f.loadPower)}kW`);
    } catch (e) { console.log('  (energyFlow: ' + e.message + ')'); }
    try {
      const sm = await sg.getSummary(id); rec.summary = sm;
      console.log(`  📈 danas=${num(sm.dailyPowerGeneration)}kWh  ukupno=${num(sm.lifetimePowerGeneration)}kWh`);
    } catch (e) { console.log('  (summary: ' + e.message + ')'); }
    try {
      const m = await sg.getOperatingMode(id); rec.mode = m;
      console.log(`  ⚙️  režim=${m} (${OPERATING_MODES[m] ?? '?'})`);
    } catch (e) { console.log('  (mode: ' + e.message + ')'); }
    out.systems.push(rec);
  }

  const file = path.join(__dirname, '..', 'data', 'sigen-systems.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n✅ Snimljeno: ${file}`);

  const svi = out.systems.map(s => s.systemId).filter(Boolean);
  if (svi.length) {
    console.log('\nℹ️  Server od 29.07.2026. SAM preuzima listu sistema sa naloga (osvežava na');
    console.log('   SIGEN_DISCOVER_MS, podrazumevano 6h) — .env ne mora da se dira kad Sigenergy');
    console.log('   doda ili podeli sistem. SIGEN_SYSTEM_ID je samo seed/fallback:');
    console.log(`   SIGEN_SYSTEM_ID=${svi.join(',')}`);
    console.log('   (SIGEN_SYSTEM_LOCK=true ako hoćeš da se čita ISKLJUČIVO ta lista.)');
  }
})();

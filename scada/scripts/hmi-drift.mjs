#!/usr/bin/env node
// Čuvar HMI ekrana: poredi IZVOR (scada/public) sa ERP kopijom (frontend/public/scada-hmi).
//
// Zašto postoji: isti ekrani žive u dve kopije jer ERP ljuska traži drugačije ponašanje
// (async modal umesto confirm, prikaz svežine snapshot-a, veće dodirne mete). Kopije su se
// već tiho razišle — badge „⚠ ZASTARELO" mesecima je postojao samo u jednoj (PLAN_PARITET
// §Energetika). Ovaj alat NE spaja ništa; on samo viče kad se pojavi NOVO razilaženje.
//
//   node scada/scripts/hmi-drift.mjs           # izveštaj
//   node scada/scripts/hmi-drift.mjs --check   # izlaz 1 ako ima neočekivanog razilaženja (CI)
//
// Kad namerno raziđeš još jedan fajl, upiši ga u FORKED sa razlogom — inače CI pada.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'scada', 'public');
const ERP = join(ROOT, 'frontend', 'public', 'scada-hmi');

// ERP ekrani učitavaju shim koji preusmerava /api/* na scada_snapshots iz baze.
// To je jedina MEHANIČKA razlika u HTML-u i ne broji se kao razilaženje.
const SHIM = '<script src="scada-bridge-shim.js"></script>';

// Namerno razdvojeni fajlovi — svaki mora imati razlog.
const FORKED = {
  'kot1.js': 'ERP: window.__scadaConfirm (async modal) umesto confirm(); formulacija za menadžment',
  'kot2.js': 'ERP: __scadaConfirm + trend grafik (Power Metrics) kojeg LAN verzija nema',
  'kot2.html': 'ERP: <style> blok za trend grafik',
  'kot3.js': 'ERP: __scadaConfirm + trend grafik',
  'kot3.html': 'ERP: <style> blok za trend grafik',
  'overview.js': 'ERP: prikaz svežine snapshot-a (_ageMs koji ubacuje most) — nema smisla na LAN-u',
};

// Ekrani koji postoje samo lokalno (nisu portovani u ERP) i samo u ERP-u.
const SRC_ONLY = ['app.js', 'bluelog.html', 'bluelog.js', 'hala5.html', 'hala5.js',
                  'index.html', 'loxone.html', 'loxone.js', 'sigen.html', 'sigen.js'];
const ERP_ONLY = ['scada-bridge-shim.js', 'kot1-tags.json'];

const norm = (s) => s.replace(/\r\n/g, '\n');
const listFiles = (d) => readdirSync(d).filter((f) => statSync(join(d, f)).isFile());

// HTML se poredi BEZ shim linije (ERP je uvek ima, izvor nikad).
function readForCompare(dir, file, isErp) {
  let t = norm(readFileSync(join(dir, file), 'utf8'));
  if (isErp && extname(file) === '.html') {
    t = t.split('\n').filter((l) => l.trim() !== SHIM).join('\n');
  }
  return t;
}

const srcFiles = listFiles(SRC);
const erpFiles = listFiles(ERP);
const rows = [];
let unexpected = 0;

for (const f of srcFiles) {
  if (SRC_ONLY.includes(f)) { rows.push(['—', f, 'samo LAN (nije portovan u ERP)']); continue; }
  if (!erpFiles.includes(f)) { rows.push(['⚠', f, 'postoji u izvoru, NEMA ga u ERP kopiji']); unexpected++; continue; }
  const same = readForCompare(SRC, f, false) === readForCompare(ERP, f, true);
  if (same) rows.push(['=', f, 'identično']);
  else if (FORKED[f]) rows.push(['⑂', f, FORKED[f]]);
  else { rows.push(['✗', f, 'RAZIŠLO SE — nije u FORKED spisku']); unexpected++; }
}
for (const f of erpFiles) {
  if (ERP_ONLY.includes(f) || srcFiles.includes(f)) continue;
  rows.push(['⚠', f, 'postoji samo u ERP kopiji, a nije u ERP_ONLY']);
  unexpected++;
}

const w = Math.max(...rows.map((r) => r[1].length));
for (const [mark, file, note] of rows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))) {
  console.log(`${mark}  ${file.padEnd(w)}  ${note}`);
}
console.log(`\n= identično · ⑂ namerno razdvojeno · — samo LAN · ✗/⚠ problem`);
console.log(`ukupno ${rows.length}, neočekivanih ${unexpected}`);

if (process.argv.includes('--check') && unexpected > 0) {
  console.error('\nHMI ekrani su se razišli. Ili poravnaj kopije, ili upiši fajl u FORKED sa razlogom.');
  process.exit(1);
}

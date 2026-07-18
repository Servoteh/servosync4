// Sažetak net-zero probe-ova (Nivo 2). Pokreni: node summarize-netzero.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NDJSON = path.resolve(__dirname, 'report/netzero.ndjson');

if (!fs.existsSync(NDJSON)) {
  console.error('Nema report/netzero.ndjson — prvo pokreni net-zero probe.');
  process.exit(1);
}

const rows = fs
  .readFileSync(NDJSON, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const icon = (s) => (s === 'PASS' ? '🟢 PASS' : s === 'RESIDUE' ? '🟠 REZIDUA' : '🔴 FAIL');

let out = '# Net-zero probe izveštaj (Nivo 2)\n\n';
out += `| Modul | Probe | Tip | Upis dokazan | Vraćeno | Net-zero | Status | Rezidua |\n`;
out += `|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  out += `| ${r.module} | ${r.probe} | ${r.kind} | ${r.writeVerified ? '✔' : '—'} | ${r.reverted ? '✔' : '—'} | ${r.verifiedGone ? '✔' : '—'} | ${icon(r.status)} | ${r.residue || '—'} |\n`;
}

out += `\n## Detalji\n\n`;
for (const r of rows) {
  out += `### ${icon(r.status)} — ${r.module}: ${r.probe}\n`;
  out += `- Mutacioni zahtevi: ${r.writes.length ? r.writes.join(' · ') : '(nijedan uhvaćen)'}\n`;
  if (r.notes?.length) out += `- Napomene: ${r.notes.join(' | ')}\n`;
  if (r.residue) out += `- ⚠️ **REZIDUA (ručno očistiti):** ${r.residue}\n`;
  out += `\n`;
}

const residue = rows.filter((r) => r.status === 'RESIDUE' || r.residue);
if (residue.length) {
  out += `\n> ⚠️ ${residue.length} probe ostavilo trag na produkciji — vidi „REZIDUA" iznad.\n`;
} else {
  out += `\n> ✅ Nula rezidua — sve probe vraćene, produkcija netaknuta.\n`;
}

fs.writeFileSync(path.resolve(__dirname, 'report/IZVESTAJ-netzero.md'), out);
process.stdout.write(out);

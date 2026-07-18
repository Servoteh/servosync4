// Čita report/modules.ndjson (jedan red po modulu) i ispisuje per-modul izveštaj
// (markdown tabela + zbir po statusu). Pokreni: npm run summary
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NDJSON = path.resolve(__dirname, 'report/modules.ndjson');

if (!fs.existsSync(NDJSON)) {
  console.error('Nema report/modules.ndjson — prvo pokreni `npm test`.');
  process.exit(1);
}

const rows = fs
  .readFileSync(NDJSON, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const icon = (s) => (s === 'PASS' ? '🟢 PASS' : s === 'WARN' ? '🟡 WARN' : '🔴 FAIL');
const counts = { PASS: 0, WARN: 0, FAIL: 0 };
rows.forEach((r) => (counts[r.status] = (counts[r.status] || 0) + 1));

let out = '';
out += `# Klik-test izveštaj — ${rows.length} modula\n\n`;
out += `🟢 PASS: ${counts.PASS}   🟡 WARN: ${counts.WARN}   🔴 FAIL: ${counts.FAIL}\n\n`;
out += `| Modul | Ruta | Status | Heading | Tabovi | console.err | 4xx | 5xx | Napomena |\n`;
out += `|---|---|---|---|---|---|---|---|---|\n`;
for (const r of rows) {
  const note = [
    r.redirectedToLogin ? '→/login' : '',
    r.accessDenied ? 'pristup odbijen' : '',
    r.pageErrors ? `JS crash×${r.pageErrors}` : '',
    r.heading === '' && r.status !== 'FAIL' ? 'prazan heading' : '',
  ]
    .filter(Boolean)
    .join('; ');
  out += `| ${r.name} | \`${r.route}\` | ${icon(r.status)} | ${r.heading || '—'} | ${r.tabs} | ${r.consoleErrors} | ${r.client4xx} | ${r.server5xx} | ${note || '—'} |\n`;
}

// Detalji za sve što nije čist PASS
const problems = rows.filter((r) => r.status !== 'PASS');
if (problems.length) {
  out += `\n## Detalji (WARN/FAIL)\n\n`;
  for (const r of problems) {
    out += `### ${icon(r.status)} — ${r.name} (\`${r.route}\`)\n`;
    if (r.samples.pageErr?.length) out += `- **JS crash:** ${r.samples.pageErr.join(' | ')}\n`;
    if (r.samples.http5xx?.length) out += `- **5xx:** ${r.samples.http5xx.join(' | ')}\n`;
    if (r.samples.http4xx?.length) out += `- **4xx:** ${r.samples.http4xx.join(' | ')}\n`;
    if (r.samples.console?.length) out += `- **console.error:** ${r.samples.console.join(' | ')}\n`;
    if (r.accessDenied) out += `- pristup odbijen (403/„nemate pristup")\n`;
    out += `\n`;
  }
}

out += `\n_Screenshotovi: report/shots/<key>.png · HTML izveštaj: npm run report_\n`;

fs.writeFileSync(path.resolve(__dirname, 'report/IZVESTAJ.md'), out);
process.stdout.write(out);

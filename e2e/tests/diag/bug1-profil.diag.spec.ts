import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../report/diag');

test('DIAG BUG1: /profil → Moj tim → član → tools crash', async ({ page }) => {
  const errors: string[] = [];
  let toolsResp = '';
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.replace(/\s+/g, ' ').slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().replace(/\s+/g, ' ').slice(0, 300));
  });
  page.on('response', (r) => {
    if (/\/profile\/team\/[^/]+\/tools/.test(r.url())) toolsResp = `${r.status()} ${new URL(r.url()).pathname}`;
  });

  await page.goto('/profil', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(800);
  const teamBtn = page.getByRole('button', { name: /Moj tim/ }).first();
  await teamBtn.scrollIntoViewIfNeeded().catch(() => {});
  await teamBtn.click().catch(() => {});
  await page.waitForTimeout(1500);

  // Roster tima = PRVA tabela odmah posle naslova „Moj tim" (accordion sadržaj).
  const teamTable = page.getByText(/Moj tim/).first().locator('xpath=following::table[1]');
  await teamTable.scrollIntoViewIfNeeded().catch(() => {});
  const trs = (await teamTable.count())
    ? teamTable.locator('tbody tr')
    : page.locator('table').last().locator('tbody tr');
  const n = Math.min(await trs.count().catch(() => 0), 10);
  for (let i = 0; i < n && !toolsResp; i++) {
    await trs.nth(i).click().catch(() => {});
    await page.waitForTimeout(1400);
  }
  await page.waitForTimeout(800);

  const body = (await page.locator('body').innerText().catch(() => '')) || '';
  const crashed =
    errors.some((e) => /map is not a function|is not a function/.test(e)) ||
    /couldn.?t load|Reload to try again|nije moguće učitati/i.test(body);

  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'bug1-profil.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(OUT, 'bug1.json'), JSON.stringify({ toolsResp, crashed, errors }, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    `\n===== BUG1 /profil tim drill =====\ntoolsResp: ${toolsResp}\nCRASHED: ${crashed}\nERRORS: ${JSON.stringify(errors)}\n`,
  );
});

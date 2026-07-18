import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../report/diag');

async function dump(page: import('@playwright/test').Page, route: string, name: string) {
  const errors: string[] = [];
  const bad: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().replace(/\s+/g, ' ').slice(0, 300));
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.replace(/\s+/g, ' ').slice(0, 300)));
  page.on('response', async (r) => {
    if (r.status() < 400) return;
    const u = r.url();
    if (/favicon|_next\/static|\.map/.test(u)) return;
    let b = '';
    try {
      b = (await r.text()).replace(/\s+/g, ' ').slice(0, 500);
    } catch {
      /* ignore */
    }
    bad.push(`${r.status()} ${r.request().method()} ${new URL(u).pathname} :: ${b}`);
  });

  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  const links = await page
    .$$eval('a[href]', (els) =>
      els
        .slice(0, 60)
        .map((e) => ({ t: (e.textContent || '').trim().slice(0, 40), h: e.getAttribute('href') }))
        .filter((x) => x.t),
    )
    .catch(() => []);
  const buttons = await page
    .$$eval('button', (els) => [
      ...new Set(els.map((e) => (e.textContent || '').trim().slice(0, 30)).filter(Boolean)),
    ])
    .catch(() => []);
  const rows = await page.locator('table tbody tr').count().catch(() => 0);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, name + '.json'),
    JSON.stringify({ route, errors, bad, rows, buttons: buttons.slice(0, 60), links: links.slice(0, 40) }, null, 2),
  );
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }).catch(() => {});

  // eslint-disable-next-line no-console
  console.log(
    `\n===== [${name}] ${route} =====\nERRORS(${errors.length}): ${JSON.stringify(errors)}\nBAD(${bad.length}): ${JSON.stringify(bad)}\nROWS: ${rows}\nBUTTONS: ${JSON.stringify(buttons.slice(0, 40))}\nLINKS: ${JSON.stringify(links.slice(0, 25))}\n`,
  );
}

test('DIAG dump /profil', async ({ page }) => dump(page, '/profil', 'profil'));
test('DIAG dump /pb', async ({ page }) => dump(page, '/pb', 'pb'));

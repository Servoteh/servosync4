import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../report/diag');

function attach(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  const bad: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().replace(/\s+/g, ' ').slice(0, 400));
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.replace(/\s+/g, ' ').slice(0, 400)));
  page.on('response', async (r) => {
    if (r.status() < 400) return;
    const u = r.url();
    if (/favicon|_next\/static|\.map/.test(u)) return;
    let b = '';
    try {
      b = (await r.text()).replace(/\s+/g, ' ').slice(0, 700);
    } catch {
      /* ignore */
    }
    bad.push(`${r.status()} ${r.request().method()} ${new URL(u).pathname} :: ${b}`);
  });
  return { errors, bad };
}

test('DIAG /profil → Moj tim → otvori zaposlenog (crash?)', async ({ page }) => {
  const { errors, bad } = attach(page);
  await page.goto('/profil', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByRole('button', { name: /Moj tim/ }).click();
  await page.waitForTimeout(1500);

  // šta se pojavilo (lista zaposlenih)
  const rowsBefore = await page.locator('table tbody tr').count().catch(() => 0);
  const memberBtns = await page
    .$$eval('table tbody tr, [role="row"], li, .cursor-pointer', (els) =>
      els.slice(0, 25).map((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)).filter(Boolean),
    )
    .catch(() => []);

  const errBefore = errors.length;
  const badBefore = bad.length;

  // klikni prvog "zaposlenog" iz tima
  let clicked = '';
  const firstRow = page.locator('table tbody tr').first();
  if (await firstRow.count()) {
    clicked = ((await firstRow.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 60);
    await firstRow.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  await page.screenshot({ path: path.join(OUT, 'profil-tim-open.png'), fullPage: true }).catch(() => {});
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'profil-repro.json'),
    JSON.stringify(
      { rowsBefore, memberSample: memberBtns, clicked, newErrors: errors.slice(errBefore), newBad: bad.slice(badBefore), allErrors: errors, allBad: bad },
      null,
      2,
    ),
  );
  // eslint-disable-next-line no-console
  console.log(
    `\n===== /profil Moj tim =====\nrows: ${rowsBefore} · clicked: "${clicked}"\nNEW ERRORS: ${JSON.stringify(errors.slice(errBefore))}\nNEW BAD: ${JSON.stringify(bad.slice(badBefore))}\nmembers: ${JSON.stringify(memberBtns.slice(0, 8))}\n`,
  );
});

test('DIAG /pb → otvori zadatak → Snimi (bez izmene) → response', async ({ page }) => {
  const { errors, bad } = attach(page);
  const saveResp: string[] = [];
  page.on('response', async (r) => {
    const m = r.request().method();
    if (!['POST', 'PATCH', 'PUT'].includes(m)) return;
    if (!/task|zadat|pb\//i.test(r.url())) return;
    let b = '';
    try {
      b = (await r.text()).replace(/\s+/g, ' ').slice(0, 700);
    } catch {
      /* ignore */
    }
    saveResp.push(`${r.status()} ${m} ${new URL(r.url()).pathname} :: ${b}`);
  });

  await page.goto('/pb', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1000);

  // otvori prvi zadatak (red tabele) → traži "Izmena zadatka" modal
  await page.locator('table tbody tr').first().click().catch(() => {});
  await page.waitForTimeout(1200);
  let modal = page.getByRole('dialog').filter({ hasText: /Izmena zadatka/i });
  if ((await modal.count()) === 0) {
    // možda treba dvoklik ili dugme "Izmeni"
    await page.locator('table tbody tr').first().dblclick().catch(() => {});
    await page.waitForTimeout(800);
    const editBtn = page.getByRole('button', { name: /Izmeni|Uredi/i }).first();
    if (await editBtn.count()) await editBtn.click().catch(() => {});
    await page.waitForTimeout(800);
    modal = page.getByRole('dialog').filter({ hasText: /Izmena zadatka/i });
  }

  const modalOpen = (await modal.count()) > 0;
  let statusVal = '';
  if (modalOpen) {
    statusVal = ((await modal.locator('select').filter({ has: page.locator('option', { hasText: /Završeno|U radu|Planirano/ }) }).first().inputValue().catch(() => '')) || '');
    // Snimi BEZ ikakve izmene (net-zero) — samo da vidimo response
    await modal.getByRole('button', { name: /^Snimi$/ }).click().catch(() => {});
    await page.waitForTimeout(1800);
  }

  await page.screenshot({ path: path.join(OUT, 'pb-izmena.png'), fullPage: true }).catch(() => {});
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'pb-repro.json'),
    JSON.stringify({ modalOpen, statusVal, saveResp, errors, bad }, null, 2),
  );
  // eslint-disable-next-line no-console
  console.log(
    `\n===== /pb Izmena → Snimi =====\nmodalOpen: ${modalOpen} · status: ${statusVal}\nSAVE RESP: ${JSON.stringify(saveResp)}\nERRORS: ${JSON.stringify(errors)}\nBAD: ${JSON.stringify(bad)}\n`,
  );
});

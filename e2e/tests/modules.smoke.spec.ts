import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODULES } from '../utils/modules';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NDJSON = path.resolve(__dirname, '../report/modules.ndjson');

function short(u: string): string {
  try {
    const url = new URL(u);
    return url.host.replace('api.', '') + url.pathname + (url.search ? '?…' : '');
  } catch {
    return u;
  }
}

test.beforeAll(() => {
  fs.mkdirSync(path.dirname(NDJSON), { recursive: true });
  fs.writeFileSync(NDJSON, ''); // truncate za svež izveštaj
});

for (const m of MODULES) {
  test(`${m.group} › ${m.name} (${m.route})`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const bad: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().replace(/\s+/g, ' ').slice(0, 200));
    });
    page.on('pageerror', (err) => pageErrors.push(err.message.replace(/\s+/g, ' ').slice(0, 200)));
    page.on('response', (res) => {
      const s = res.status();
      if (s < 400) return;
      const u = res.url();
      if (/favicon|\.map(\?|$)|_next\/static|\/config\.js|\/version\.json/.test(u)) return;
      bad.push(`${s} ${res.request().method()} ${short(u)}`);
    });

    // --- navigacija ---
    await page.goto(m.route, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(900); // klijentski render/hook-ovi

    const finalPath = new URL(page.url()).pathname;
    const redirectedToLogin = finalPath.startsWith('/login');

    const bodyText = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 20_000);
    const errorBoundary =
      /(nešto je pošlo naopako|došlo je do greške|something went wrong|application error|internal server error|nije moguće učitati)/i.test(
        bodyText,
      );
    const accessDenied =
      /(nemate\s+(pristup|dozvol|prava)|pristup\s+odbijen|forbidden|niste\s+ovlašćeni|403)/i.test(bodyText);
    const heading =
      ((await page.locator('main h1, main h2, h1, h2').first().innerText({ timeout: 2000 }).catch(() => '')) || '')
        .replace(/\s+/g, ' ')
        .slice(0, 100);

    // --- interakcija: klik po tab/segment kontrolama (hvata greške po tabu) ---
    let tabsClicked = 0;
    const tabLoc = page.locator(
      '[role="tab"]:visible, [data-slot="tabs-trigger"]:visible, [role="tablist"] button:visible',
    );
    const tabCount = Math.min(await tabLoc.count().catch(() => 0), 8);
    for (let i = 0; i < tabCount; i++) {
      try {
        await tabLoc.nth(i).click({ timeout: 3000 });
        await page.waitForTimeout(350);
        tabsClicked++;
      } catch {
        /* tab nije klikabilan/nestao */
      }
    }

    const server5xx = bad.filter((b) => /^5\d\d /.test(b));
    const client4xx = bad.filter((b) => /^4\d\d /.test(b));

    // --- klasifikacija (nezavisna od Playwright pass/fail) ---
    const broken = redirectedToLogin || pageErrors.length > 0 || server5xx.length > 0 || errorBoundary;
    const warn = !broken && (consoleErrors.length > 0 || client4xx.length > 0 || accessDenied || heading === '');
    const status = broken ? 'FAIL' : warn ? 'WARN' : 'PASS';

    const record = {
      key: m.key,
      group: m.group,
      name: m.name,
      route: m.route,
      status,
      finalPath,
      redirectedToLogin,
      accessDenied,
      heading,
      tabs: `${tabsClicked}/${tabCount}`,
      consoleErrors: consoleErrors.length,
      client4xx: client4xx.length,
      server5xx: server5xx.length,
      pageErrors: pageErrors.length,
      screenshot: `${m.key}.png`,
      samples: {
        console: consoleErrors.slice(0, 4),
        http4xx: client4xx.slice(0, 6),
        http5xx: server5xx.slice(0, 6),
        pageErr: pageErrors.slice(0, 3),
      },
    };
    fs.appendFileSync(NDJSON, JSON.stringify(record) + '\n');

    // trajni screenshot po modulu (pored auto-attach-a)
    await page
      .screenshot({ path: path.resolve(__dirname, `../report/shots/${m.key}.png`), fullPage: true })
      .catch(() => {});
    await testInfo.attach('modul-summary', {
      body: JSON.stringify(record, null, 2),
      contentType: 'application/json',
    });

    // --- TVRDE asercije: padaju samo kad je modul stvarno pokvaren ---
    expect(redirectedToLogin, 'preusmeren na /login (sesija pala / nije autorizovan)').toBeFalsy();
    expect(pageErrors, `JS crash: ${pageErrors.join(' | ')}`).toHaveLength(0);
    expect(server5xx, `5xx odgovori: ${server5xx.join(' | ')}`).toHaveLength(0);
    expect(errorBoundary, 'error-boundary tekst na stranici').toBeFalsy();
    // consoleErrors / 4xx / accessDenied se NE tretiraju kao pad — vode se kao WARN u izveštaju.
  });
}

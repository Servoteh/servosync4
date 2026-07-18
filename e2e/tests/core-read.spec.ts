import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachSignals,
  settle,
  readBody,
  firstHeading,
  findFirstRow,
  classify,
  recordCoreRead,
  resetCoreReadLog,
  RE_ERROR_BOUNDARY,
  RE_ACCESS_DENIED,
  type CoreReadResult,
} from '../utils/core-read';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Native core READ-ONLY drill-down. Dopuna modules.smoke (index render) —
// otvara STVARAN zapis i potvrđuje da detalj GET + relacije ne pucaju 500.
// STROGO read-only: nijedan submit/save/delete; klik samo na red/tab/link.

interface DrillFlow {
  key: string;
  name: string;
  route: string;
  kind: 'drill';
}
interface SurfaceFlow {
  key: string;
  name: string;
  route: string;
  kind: 'surface';
  // selektor primarnog panela koji MORA da se renderuje (npr. scan polje, MRP tabela)
  panel: string;
  panelDesc: string;
}
type Flow = DrillFlow | SurfaceFlow;

const FLOWS: Flow[] = [
  { key: 'rn-detail', name: 'RN — otvori nalog', route: '/work-orders', kind: 'drill' },
  { key: 'tp-detail', name: 'TP — otvori postupak', route: '/tech-processes', kind: 'drill' },
  { key: 'kvalitet-detail', name: 'Kvalitet — otvori prijavu', route: '/kvalitet', kind: 'drill' },
  {
    key: 'kiosk-surface',
    name: 'Kiosk — skener površina',
    route: '/kiosk',
    kind: 'surface',
    panel: 'input:visible, [inputmode]:visible, [role="textbox"]:visible, main',
    panelDesc: 'skener/unos polje',
  },
  {
    key: 'mrp-surface',
    name: 'MRP — materijali/potrebe',
    route: '/mrp',
    kind: 'surface',
    // MRP prazan na prvi ulaz (traži filter) i renderuje van <main> — dovoljno je
    // da se primarni okvir/naslov iscrta bez 5xx.
    panel: 'table, [role="table"], [role="grid"], main h1, main h2, h1, h2',
    panelDesc: 'MRP okvir/naslov',
  },
];

test.beforeAll(() => resetCoreReadLog());

for (const flow of FLOWS) {
  test(`core-read › ${flow.name} (${flow.route})`, async ({ page }, testInfo) => {
    const s = attachSignals(page);
    const notes: string[] = [];

    // --- index / površina ---
    await page.goto(flow.route, { waitUntil: 'domcontentloaded' });
    await settle(page);

    let finalPath = new URL(page.url()).pathname;
    let redirectedToLogin = finalPath.startsWith('/login');
    let opened = false;
    let detail = '';
    let rows = 0;

    if (!redirectedToLogin && flow.kind === 'drill') {
      const headingBefore = await firstHeading(page);
      const urlBefore = page.url();
      const getsBefore = s.okGets.length; // detalj-fetch = novi API GET posle klika
      const found = await findFirstRow(page, flow.route);
      rows = found.count;

      if (found.count === 0 || !found.locator) {
        notes.push('index bez redova — nema šta da se otvori (prazan modul / filter)');
      } else {
        // otvori prvi red — read-only (klik ne mutira; detalj je GET)
        await found.locator.scrollIntoViewIfNeeded().catch(() => {});
        await found.locator.click({ timeout: 8000 }).catch((e) => notes.push(`klik reda pao: ${String(e).slice(0, 80)}`));
        await settle(page);

        const urlAfter = page.url();
        const dialog = page.locator('[role="dialog"]:visible, [data-slot="dialog-content"]:visible').first();
        const dialogOpen = (await dialog.count().catch(() => 0)) > 0;
        const headingAfter = await firstHeading(page);
        const newGets = s.okGets.slice(getsBefore);
        // inline-expand ne menja URL — najpouzdaniji dokaz „detalj učitan" je NOVI
        // API GET (po numeričkom id-u ili modul-stem-u) koji je 2xx (5xx bi već pao).
        const stem = flow.route.replace(/^\//, '');
        const detailGet = newGets.find((g) => /\/\d+(\/|$|\?|…)/.test(g) || g.includes(stem));

        if (detailGet) {
          opened = true;
          detail = `detail-GET ${detailGet}`;
        } else if (urlAfter !== urlBefore && !urlAfter.includes('/login')) {
          opened = true;
          detail = `url→ ${new URL(urlAfter).pathname}`;
        } else if (dialogOpen) {
          opened = true;
          detail = 'dialog';
        } else if (headingAfter && headingAfter !== headingBefore) {
          opened = true;
          detail = `heading→ ${headingAfter}`;
        } else if (newGets.length > 0) {
          opened = true;
          detail = `fetch ${newGets[newGets.length - 1]}`;
        } else {
          notes.push(`red kliknut (${found.how}) ali detalj nije potvrđen (nema novog GET/url/dialog)`);
          detail = `klik:${found.how}`;
        }
      }
    }

    if (!redirectedToLogin && flow.kind === 'surface') {
      const panel = page.locator(flow.panel).first();
      const panelOk = (await panel.count().catch(() => 0)) > 0 && (await panel.isVisible().catch(() => false));
      opened = panelOk;
      detail = panelOk ? `panel: ${flow.panelDesc}` : '';
      if (!panelOk) notes.push(`primarni panel (${flow.panelDesc}) nije nađen/vidljiv`);
    }

    // re-evaluacija posle drill-a (klik je mogao da preusmeri)
    finalPath = new URL(page.url()).pathname;
    redirectedToLogin = finalPath.startsWith('/login');

    const bodyText = await readBody(page);
    const errorBoundary = RE_ERROR_BOUNDARY.test(bodyText);
    const accessDenied = RE_ACCESS_DENIED.test(bodyText);
    const heading = await firstHeading(page);

    // surface (kiosk) legitimno nema h1/h2 — otvoren panel je dovoljan dokaz render-a,
    // pa prazan heading ne obara u WARN.
    const headingForClass = flow.kind === 'surface' && opened ? heading || 'surface' : heading;
    const { status, server5xx, client4xx } = classify(s, redirectedToLogin, errorBoundary, accessDenied, headingForClass);

    const record: CoreReadResult = {
      key: flow.key,
      name: flow.name,
      route: flow.route,
      kind: flow.kind,
      status,
      opened,
      detail,
      heading,
      rows,
      redirectedToLogin,
      accessDenied,
      consoleErrors: s.consoleErrors.length,
      client4xx: client4xx.length,
      server5xx: server5xx.length,
      pageErrors: s.pageErrors.length,
      notes,
      samples: {
        console: s.consoleErrors.slice(0, 4),
        http4xx: client4xx.slice(0, 6),
        http5xx: server5xx.slice(0, 6),
        pageErr: s.pageErrors.slice(0, 3),
      },
    };
    recordCoreRead(record);

    await page
      .screenshot({ path: path.resolve(__dirname, `../report/shots/core-${flow.key}.png`), fullPage: true })
      .catch(() => {});
    await testInfo.attach('core-read-summary', {
      body: JSON.stringify(record, null, 2),
      contentType: 'application/json',
    });

    // --- TVRDE asercije: padaju samo na pravi kvar (isti prag kao smoke) ---
    expect(redirectedToLogin, 'preusmeren na /login (sesija pala / nije autorizovan)').toBeFalsy();
    expect(s.pageErrors, `JS crash: ${s.pageErrors.join(' | ')}`).toHaveLength(0);
    expect(server5xx, `5xx na detalj GET-u (kandidat za orphan-FK JOIN 500): ${server5xx.join(' | ')}`).toHaveLength(0);
    expect(errorBoundary, 'error-boundary tekst na stranici').toBeFalsy();
    // opened/rows/console/4xx se vode kao WARN u core-read.ndjson (ne obaraju test).
  });
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Locator } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CORE_READ_NDJSON = path.resolve(__dirname, '../report/core-read.ndjson');

// ---------------------------------------------------------------------------
// Native core READ-ONLY drill-down (Nivo 1.5). Smoke (modules.smoke) pokriva
// render+tab na INDEX nivou; ovaj sloj otvara STVARAN zapis (RN/TP/Kvalitet)
// i potvrđuje da detalj GET + batch-resolve relacija ne pukne 500 — tačno tamo
// gde legacy orphan-FK required-JOIN pravi 500 (common/relations.ts obrazac).
// STROGO read-only: navigacija + otvaranje reda; NIKAD submit/save/delete.
// ---------------------------------------------------------------------------

export interface CoreReadResult {
  key: string;
  name: string;
  route: string;
  kind: 'drill' | 'surface';
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
  opened: boolean; // drill: red otvoren · surface: primarni panel nađen
  detail: string; // kako je detalj potvrđen (url-change / dialog / heading / panel)
  heading: string;
  rows: number; // koliko redova/stavki nađeno na indexu (0 → SKIP za drill)
  redirectedToLogin: boolean;
  accessDenied: boolean;
  consoleErrors: number;
  client4xx: number;
  server5xx: number;
  pageErrors: number;
  notes: string[];
  samples: { console: string[]; http4xx: string[]; http5xx: string[]; pageErr: string[] };
}

export function resetCoreReadLog(): void {
  fs.mkdirSync(path.dirname(CORE_READ_NDJSON), { recursive: true });
  fs.writeFileSync(CORE_READ_NDJSON, '');
}

export function recordCoreRead(r: CoreReadResult): void {
  fs.mkdirSync(path.dirname(CORE_READ_NDJSON), { recursive: true });
  fs.appendFileSync(CORE_READ_NDJSON, JSON.stringify(r) + '\n');
}

/** Signali stranice — isti izvori kao modules.smoke (console/pageerror/HTTP). */
export interface Signals {
  consoleErrors: string[];
  pageErrors: string[];
  bad: string[]; // "STATUS METHOD host+path"
  okGets: string[]; // 2xx GET-ovi (dokaz da je detalj STVARNO učitan posle klika)
}

function short(u: string): string {
  try {
    const url = new URL(u);
    return url.host.replace('api.', '') + url.pathname + (url.search ? '?…' : '');
  } catch {
    return u;
  }
}

const NOISE = /favicon|\.map(\?|$)|_next\/static|\/config\.js|\/version\.json|\/auth\/(login|refresh|me|sso)/;

/** Zakači slušače PRE navigacije; vraća žive nizove koje test čita na kraju. */
export function attachSignals(page: Page): Signals {
  const s: Signals = { consoleErrors: [], pageErrors: [], bad: [], okGets: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') s.consoleErrors.push(msg.text().replace(/\s+/g, ' ').slice(0, 200));
  });
  page.on('pageerror', (err) => s.pageErrors.push(err.message.replace(/\s+/g, ' ').slice(0, 200)));
  page.on('response', (res) => {
    const st = res.status();
    const u = res.url();
    if (NOISE.test(u)) return;
    if (st >= 400) {
      s.bad.push(`${st} ${res.request().method()} ${short(u)}`);
    } else if (st < 300 && res.request().method() === 'GET' && /\/api\//.test(u)) {
      // samo API GET-ovi (ne _next/statika) — dokaz da je klik pokrenuo detalj-fetch
      s.okGets.push(short(u));
    }
  });
  return s;
}

/** Sačekaj da se mreža/klijentski render slegnu (isti tajming kao smoke). */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
}

export async function readBody(page: Page): Promise<string> {
  return ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 20_000);
}

export async function firstHeading(page: Page): Promise<string> {
  return (
    (await page
      .locator('main h1, main h2, h1, h2')
      .first()
      .innerText({ timeout: 2000 })
      .catch(() => '')) || ''
  )
    .replace(/\s+/g, ' ')
    .slice(0, 100);
}

export const RE_ERROR_BOUNDARY =
  /(nešto je pošlo naopako|došlo je do greške|something went wrong|application error|internal server error|nije moguće učitati)/i;
// NB: goli „403" NAMERNO izostavljen — lažno pogađa brojeve RN-a/crteža u listi
// (npr. „9400/3/403"). Oslanjamo se na tekstualne fraze + eksplicitni „HTTP 403".
export const RE_ACCESS_DENIED =
  /(nemate\s+(pristup|dozvol|prava)|pristup\s+odbijen|zabranjen\s+pristup|forbidden|niste\s+ovlašćeni|HTTP\s*403\b|status\s*403\b)/i;

/**
 * Nađi prvi „otvorivi" red podataka u glavnom sadržaju, redom strategija:
 *   1) klikabilan red tabele (tbody tr sa <a> ili role=button/link)
 *   2) prvi <a href> ka detalju (isti modul u putanji)
 *   3) prva lista-stavka (li) sa linkom
 * Vraća {locator, how, count} ili count=0 kad nema podataka (→ SKIP, ne FAIL).
 */
export async function findFirstRow(
  page: Page,
  routeStem: string,
): Promise<{ locator: Locator | null; how: string; count: number }> {
  // 1) redovi tabele — najčešći master-lista obrazac (DS §4). NIJE scope-ovano na
  // `main` (neke liste su van <main>) i ČEKA se vidljivost (lista se učitava async;
  // prerano brojanje = 0 lažno). Prazna lista → waitFor istekne → count 0 → SKIP.
  const bodyRows = page.locator('table tbody tr:visible');
  await bodyRows
    .first()
    .waitFor({ state: 'visible', timeout: 12_000 })
    .catch(() => {});
  const rowCount = await bodyRows.count().catch(() => 0);
  if (rowCount > 0) {
    // preferiraj link/dugme unutar prvog reda; fallback = ceo red (klik po ćeliji,
    // inline-expand detalj — obrazac iz work-orders.probe)
    const first = bodyRows.first();
    const rowLink = first.locator('a[href], [role="link"], button:not([disabled])').first();
    if ((await rowLink.count().catch(() => 0)) > 0) return { locator: rowLink, how: 'table-row-link', count: rowCount };
    return { locator: first, how: 'table-row', count: rowCount };
  }

  // 2) direktan link ka detalju modula (npr. /work-orders/123)
  const stem = routeStem.replace(/^\//, '').split('/')[0];
  const detailLink = page.locator(`a[href*="/${stem}/"]:visible`).first();
  if ((await detailLink.count().catch(() => 0)) > 0) return { locator: detailLink, how: 'detail-link', count: 1 };

  // 3) lista-stavke sa linkom (kartice/redovi bez <table>)
  const listItem = page.locator('li a[href]:visible, [role="listitem"] a[href]:visible').first();
  if ((await listItem.count().catch(() => 0)) > 0) return { locator: listItem, how: 'list-item', count: 1 };

  return { locator: null, how: 'none', count: 0 };
}

/** Klasifikuj rezultat identično smoke logici (hard-fail samo za pravi kvar). */
export function classify(s: Signals, redirectedToLogin: boolean, errorBoundary: boolean, accessDenied: boolean, heading: string) {
  const server5xx = s.bad.filter((b) => /^5\d\d /.test(b));
  const client4xx = s.bad.filter((b) => /^4\d\d /.test(b));
  const broken = redirectedToLogin || s.pageErrors.length > 0 || server5xx.length > 0 || errorBoundary;
  const warn = !broken && (s.consoleErrors.length > 0 || client4xx.length > 0 || accessDenied || heading === '');
  const status: CoreReadResult['status'] = broken ? 'FAIL' : warn ? 'WARN' : 'PASS';
  return { status, server5xx, client4xx };
}

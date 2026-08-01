/**
 * DOKAZ ZA `ui-kit/escape-layer.ts` — pravi Chromium, ne rasuđivanje.
 * ===========================================================================
 * Regresija V11 (nezavisan pregled 28.07.2026) dokazana je Playwright-om, pa se
 * i popravka dokazuje istim alatom i istim merenjem: REDOSLED OKIDANJA.
 *
 * Meri se topologija slušalaca kakva stvarno postoji u aplikaciji:
 *   • EKRAN   — `window`, bubble faza („Esc = nazad na listu")
 *   • DIALOG  — modalni sloj
 *   • INNER   — ugnežđena kartica potvrde, otvara se POSLE dijaloga
 *
 * Poredi se STARO ponašanje (svaki sloj sam kači capture-slušalac na `window` i
 * zove `stopPropagation`) sa NOVIM (jedan deljeni slušalac + stek slojeva).
 *
 * Jezgro NOVOG ponašanja se NE prepisuje ovde — čita se iz pravog izvora
 * `src/components/ui-kit/escape-layer.ts` i samo mu se skidaju TS anotacije, pa
 * se u pretraživaču izvršava isti kod koji ide u proizvodnju. Skript proverava
 * da su ključne naredbe preživele skidanje tipova; ako nisu, pada.
 *
 * POKRETANJE (Playwright je instaliran u `e2e/` glavnog repoa):
 *   node frontend/scripts/escape-layer.proof.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..');
const REPO = resolve(FRONTEND, '..');
const SOURCE = join(FRONTEND, 'src', 'components', 'ui-kit', 'escape-layer.ts');

// ── Playwright se traži i u ovom stablu i u glavnom repou ───────────────────
async function loadChromium() {
  const candidates = [
    join(REPO, 'e2e'),
    join(REPO, '..', 'servosync4', 'e2e'),
    resolve(REPO, '..', '..', 'Documents', 'GitHub', 'servosync4', 'e2e'),
  ];
  for (const base of candidates) {
    try {
      const req = createRequire(pathToFileURL(join(base, 'package.json')));
      // CJS paket kroz `import()` završi pod `default`; uzmi šta god od toga postoji.
      const mod = await import(pathToFileURL(req.resolve('@playwright/test')).href);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (!chromium) continue;
      return { chromium, base };
    } catch {
      /* probaj sledeći */
    }
  }
  throw new Error(
    'Playwright nije nađen. Traženo u: ' + candidates.join(' | ') +
      '\nInstaliraj ga u e2e/ ili pokreni dokaz iz glavnog repoa.',
  );
}

// ── Jezgro iz pravog izvora, bez TS anotacija ──────────────────────────────
function coreAsBrowserJs() {
  const ts = readFileSync(SOURCE, 'utf8');

  const body = ts
    // skini React deo — u dokazu se stek koristi direktno
    .replace(/^import[\s\S]*?from 'react';$/m, '')
    .replace(/export function useEscapeLayer[\s\S]*?\n}\n/m, '')
    // TS-only konstrukcije
    .replace(/^export type EscapeHandler[\s\S]*?;$/m, '')
    .replace(/^interface EscapeLayerEntry \{[\s\S]*?^\}$/m, '')
    .replace(/const stack: EscapeLayerEntry\[\]/, 'const stack')
    .replace(/const entry: EscapeLayerEntry =/, 'const entry =')
    .replace(/function handleKeyDown\(e: KeyboardEvent\): void/, 'function handleKeyDown(e)')
    .replace(/export function pushEscapeLayer\(onEscape: EscapeHandler\): \(\) => void/, 'function pushEscapeLayer(onEscape)')
    .replace(/export function escapeLayerDepth\(\): number/, 'function escapeLayerDepth()')
    .replace(/^'use client';$/m, '')
    .replace(/^export /gm, '');

  // Brana: ako je skidanje tipova pojelo suštinu, dokaz je bezvredan.
  const mora = [
    'e.stopPropagation();',
    'e.stopImmediatePropagation();',
    'top.onEscape(e);',
    "window.addEventListener('keydown', handleKeyDown, true)",
    'stack[stack.length - 1]',
  ];
  for (const m of mora) {
    if (!body.includes(m)) {
      throw new Error(`Jezgro je izgubilo ključnu naredbu posle skidanja tipova: ${m}`);
    }
  }
  if (/:\s*(KeyboardEvent|EscapeHandler|EscapeLayerEntry|boolean|number)\b/.test(body)) {
    throw new Error('U jezgru su ostale TS anotacije — pretraživač bi pukao.');
  }
  return body;
}

/**
 * Stranica nosi polje unutar panela, jer se Esc MORA slati sa fokusiranog
 * elementa. Slanje direktno na `window` daje drugu putanju događaja (window
 * postaje meta, pa nema ni capture ni bubble faze nad njim) i merenje bi bilo
 * bezvredno — na tome je prva verzija ovog dokaza pala.
 */
const PAGE = `<!doctype html><html><body><div id="panel"><input id="polje"></div></body></html>`;

async function main() {
  const { chromium, base } = await loadChromium();
  const core = coreAsBrowserJs();

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(PAGE);
  await page.addScriptTag({ content: core });

  // ── SCENARIO A: staro ponašanje (svaki sloj sam, capture + stopPropagation)
  const staro = await page.evaluate(() => {
    const red = [];
    const posaljiEsc = () => {
      document.getElementById('polje').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    };
    const dialog = (e) => {
      if (e.key !== 'Escape') return;
      red.push('DIALOG');
      e.stopPropagation();
    };
    const inner = (e) => {
      if (e.key !== 'Escape') return;
      red.push('INNER');
      e.stopPropagation();
    };
    const ekran = (e) => {
      if (e.key === 'Escape') red.push('EKRAN');
    };
    window.addEventListener('keydown', dialog, true);
    window.addEventListener('keydown', inner, true); // kartica se otvara posle
    window.addEventListener('keydown', ekran); // bubble, „nazad na listu"
    posaljiEsc();
    window.removeEventListener('keydown', dialog, true);
    window.removeEventListener('keydown', inner, true);
    window.removeEventListener('keydown', ekran);
    return red;
  });

  // ── SCENARIO B: novo ponašanje (deljeni slušalac + stek) ───────────────────
  const novo = await page.evaluate(() => {
    const red = [];
    const posaljiEsc = () => {
      document.getElementById('polje').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    };
    const ekran = (e) => {
      if (e.key === 'Escape') red.push('EKRAN');
    };
    window.addEventListener('keydown', ekran);

    const skiniDialog = pushEscapeLayer(() => red.push('DIALOG'));
    const skiniInner = pushEscapeLayer(() => red.push('INNER')); // kartica, posle
    const dubina = escapeLayerDepth();

    posaljiEsc();
    const poslePrvog = red.slice();

    skiniInner(); // kartica zatvorena → Esc se vraća dijalogu
    posaljiEsc();
    const posleDrugog = red.slice();

    skiniDialog(); // sve zatvoreno → Esc pripada ekranu
    posaljiEsc();

    window.removeEventListener('keydown', ekran);
    return { dubina, poslePrvog, posleDrugog, kraj: red, dubinaNaKraju: escapeLayerDepth() };
  });

  await browser.close();

  // ── Ocena ──────────────────────────────────────────────────────────────────
  const provere = [
    ['STARO: okidaju se OBA sloja (to je regresija V11)', JSON.stringify(staro) === JSON.stringify(['DIALOG', 'INNER'])],
    ['NOVO: Esc dobija SAMO najgornji sloj (kartica)', JSON.stringify(novo.poslePrvog) === JSON.stringify(['INNER'])],
    ['NOVO: ekran ispod se NE okida dok sloj postoji', !novo.kraj.slice(0, 2).includes('EKRAN')],
    ['NOVO: kad se kartica zatvori, Esc pripada dijalogu', JSON.stringify(novo.posleDrugog) === JSON.stringify(['INNER', 'DIALOG'])],
    ['NOVO: kad se sve zatvori, Esc pripada ekranu', JSON.stringify(novo.kraj) === JSON.stringify(['INNER', 'DIALOG', 'EKRAN'])],
    ['NOVO: stek se uredno prazni', novo.dubina === 2 && novo.dubinaNaKraju === 0],
  ];

  console.log(`Playwright iz: ${base}`);
  console.log(`STARO redosled: ${JSON.stringify(staro)}`);
  console.log(`NOVO  redosled: ${JSON.stringify(novo.kraj)}  (dubina steka 2 → 0)\n`);

  let pao = 0;
  for (const [naziv, ok] of provere) {
    console.log(`${ok ? '🟢' : '🔴'} ${naziv}`);
    if (!ok) pao++;
  }
  console.log(`\n${pao === 0 ? '🟢 DOKAZ PROŠAO' : `🔴 PALO ${pao} od ${provere.length}`}`);
  process.exit(pao === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('🔴 Dokaz nije mogao da se izvede:', e.message);
  process.exit(2);
});

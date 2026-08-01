'use client';

/**
 * ESCAPE-LAYER — jedan Esc pripada JEDNOM sloju, i to najgornjem.
 * ===========================================================================
 * ZAŠTO POSTOJI (regresija V11, nezavisan pregled 28.07.2026)
 * ---------------------------------------------------------------------------
 * Do sada je svaki modalni sloj sam kačio `keydown` u CAPTURE fazi na `window`
 * i zvao `stopPropagation()`. To rešava sukob sa ekranom ISPOD (koji takođe
 * sluša Esc za „Nazad na listu"), ali stvara gori problem čim se slojevi
 * ugnezde: `stopPropagation` NE zaustavlja druge slušaoce na ISTOM čvoru, pa se
 * na `window` okidaju SVI registrovani slojevi odjednom.
 *
 * Merena posledica (Reversi → „Brzi povraćaj" → skeniraj → kartica potvrde →
 * Esc): okidali su se i `Dialog` i unutrašnja kartica, pa se umesto same
 * potvrde zatvarao ceo tok skeniranja. Isti oblik greške čekao je u
 * `scan-overlay`, `maint-scan-overlay` i `help-mode`.
 *
 * KAKO SE REŠAVA
 * ---------------------------------------------------------------------------
 * Svi slojevi dele JEDAN slušalac na `window` (capture) i uredan stek. Na Esc:
 *   1. uzima se SAMO najgornji sloj (poslednji koji se otvorio);
 *   2. `stopPropagation` + `stopImmediatePropagation` — događaj ne ide dalje
 *      ni nadole (ekran ispod), ni ka ostalim slušaocima na `window`;
 *   3. poziva se obrađivač tog jednog sloja.
 * Sloj koji nije na vrhu ne radi ništa. Time Esc zatvara tačno ono što je
 * korisnik poslednje otvorio — pravilo koje važi u svakom pretraživaču i
 * svakom drugom programu.
 *
 * NE ZAVISI OD FOKUSA. Druga razmatrana varijanta (bubble nad panelom uz
 * autofocus) bi otkazala kad fokus nije unutar panela — npr. posle skeniranja,
 * gde fokus drži skener a ne polje. Stek radi bez obzira gde je fokus.
 *
 * REDOSLED. Vrh steka = sloj koji se POSLEDNJI otvorio. U praksi se ugnežđeni
 * sloj (kartica potvrde) uvek otvara posle svog roditelja (dijaloga), pa je
 * redosled tačan. Jedini izuzetak bio bi dijalog koji se montira sa već
 * otvorenim ugnežđenim dijalogom u istom renderu — React tad pokreće efekat
 * deteta PRE roditelja, pa bi roditelj završio na vrhu. Takav slučaj u ovom
 * kodu ne postoji; ako se pojavi, unutrašnji sloj treba otvarati u sledećem
 * ciklusu (`open` iz stanja), ne u istom.
 *
 * `help-mode.tsx` NAMERNO OSTAJE VAN STEKA. On već ima sopstvenu slojevitost
 * (tura → objašnjenje → režim) i već izričito ustupa Esc otvorenom dijalogu
 * (`document.querySelector('[role="dialog"][aria-modal="true"]')`), a njegov
 * slušalac hvata i druge tastere. Dok je bilo koji sloj otvoren, stek proguta
 * Esc pre njega — što je i željeno ponašanje; kad steka nema, ovaj modul ne radi
 * ništa i pomoć se ponaša tačno kao pre.
 *
 * DOKAZ: `frontend/src/components/ui-kit/escape-layer.proof.mjs` — pokreće
 * pravi Chromium (Playwright) i meri redosled okidanja pre i posle popravke.
 */

import { useEffect, useRef } from 'react';

export type EscapeHandler = (e: KeyboardEvent) => void;

interface EscapeLayerEntry {
  onEscape: EscapeHandler;
}

/** Stek otvorenih modalnih slojeva; poslednji element = najgornji sloj. */
const stack: EscapeLayerEntry[] = [];
/** Jedan jedini slušalac za sve slojeve — kači se lenjo, skida kad stek opusti. */
let listening = false;

function handleKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (!top) return;

  // Redosled je bitan: prvo ugasi svaki dalji put događaja, pa tek onda pozovi
  // obrađivač. Obrnuto bi obrađivač mogao (posredno) da otvori nov sloj i da se
  // gašenje primeni na pogrešno stanje.
  e.stopPropagation();
  e.stopImmediatePropagation();
  top.onEscape(e);
}

/**
 * Ubacuje sloj na vrh steka. Vraća funkciju za uklanjanje — vezati je za
 * čišćenje efekta, inače zatvoren sloj i dalje jede Esc.
 */
export function pushEscapeLayer(onEscape: EscapeHandler): () => void {
  const entry: EscapeLayerEntry = { onEscape };
  stack.push(entry);

  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeyDown, true);
    listening = true;
  }

  return () => {
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
    if (listening && stack.length === 0 && typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleKeyDown, true);
      listening = false;
    }
  };
}

/**
 * React omotač: dok je `active`, komponenta drži sloj na steku.
 *
 * `onEscape` se čita kroz ref, pa se stek NE preuređuje na svaki render —
 * inače bi obična izmena stanja roditelja gurnula roditeljski dijalog iznad
 * ugnežđene kartice i vratila tačno onaj kvar zbog kog ovaj modul postoji.
 */
export function useEscapeLayer(active: boolean, onEscape: EscapeHandler): void {
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    return pushEscapeLayer((e) => handlerRef.current(e));
  }, [active]);
}

/** Broj otvorenih slojeva — za testove i dijagnostiku. */
export function escapeLayerDepth(): number {
  return stack.length;
}

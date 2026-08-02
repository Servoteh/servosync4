'use client';

import { useEffect, useRef } from 'react';

/**
 * `useHidScanBuffer` — LOKALNI HID („keyboard wedge") bafer unutar punoekranskog skenera.
 *
 * ZAŠTO (regresija 02.08.2026, Android/kiosk): dok je skener otvoren, sken sa
 * Bluetooth/USB čitača nije imao gde da padne.
 *  1. Polje ručnog unosa u ljuskama ima `autoFocus` pod gardom
 *     `!matchMedia('(pointer: coarse)')` — na SVAKOM telefonu i tabletu je to `false`,
 *     pa polje nije fokusirano. (Gard je namerno i OSTAJE: programatski fokus na
 *     telefonu diže soft tastaturu PREKO kadra pre svakog skena.)
 *  2. Globalni HID hvatač radnog stola (`lib/reversi-global-scanner.ts:55`) namerno
 *     ćuti dok postoji `[role="dialog"][aria-modal="true"]` — a skener overlay je baš
 *     takav element, jer se pretpostavljalo da „UI sam preuzima sken".
 * Zbir to dvoje: karakteri sa čitača odu u `document.body` i nestanu. Radnik pritisne
 * okidač, čuje bip čitača i ne dobije ništa.
 *
 * Algoritam je isti kao u `reversi-global-scanner.ts` (koji je port 1.0 `globalScanner.js`):
 * akumuliraj `keydown` u capture fazi, resetuj bafer na pauzu dužu od 80 ms (čovek koji
 * kuca nikad ne napravi 4+ znaka sa razmakom < 80 ms), na `Enter` predaj kod od bar 4
 * znaka i utišaj isti kod 1,5 s (dupli okidač čitača).
 *
 * Ćuti dok je fokus U POLJU (input/select/textarea/contentEditable) — tada kucanje i
 * `Enter` pripadaju formi ljuske (ručni unos), pa bi bafer poslao kod DVA puta.
 *
 * @param enabled  Isključi kad skener ne prima kod (npr. iOS blokada kamere je bez veze
 *                 sa ovim — HID tada i dalje treba; koristi `false` samo za pravu pauzu).
 * @param onCode   Prima očišćen kod; ljuska ga vodi kroz svoj `resolve` (isti put kao
 *                 kamera i ručni unos, uključujući normalizaciju i anti-dupli gard).
 */
export function useHidScanBuffer(enabled: boolean, onCode: (code: string) => void): void {
  // Callback je inline literal (nov identitet po renderu) — u ref-u, da se slušalac ne
  // skida i ne vezuje na svaki render ljuske (a time i ne gubi bafer usred skena).
  const cbRef = useRef(onCode);
  useEffect(() => {
    cbRef.current = onCode;
  });

  useEffect(() => {
    if (!enabled) return;
    if (typeof document === 'undefined') return;

    const RESET_MS = 80; // gap između karaktera HID čitača < ~80 ms
    const MIN_LENGTH = 4; // ignoriši kratke „slučajne" sekvence
    const THROTTLE_MS = 1500; // dupli Enter / ponovljen okidač

    let buffer = '';
    let lastKeyAt = 0;
    let lastCode = '';
    let lastAt = 0;

    const focusInField = (): boolean => {
      const ae = document.activeElement;
      if (!ae) return false;
      const tag = ae.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
      return (ae as HTMLElement).isContentEditable === true;
    };

    const onKeydown = (ev: KeyboardEvent) => {
      if (focusInField()) {
        buffer = '';
        return;
      }
      const now = Date.now();
      if (now - lastKeyAt > RESET_MS) buffer = '';
      lastKeyAt = now;

      if (ev.key === 'Enter') {
        const code = buffer.trim();
        buffer = '';
        if (code.length < MIN_LENGTH) return;
        if (code === lastCode && now - lastAt < THROTTLE_MS) return;
        lastCode = code;
        lastAt = now;
        // Enter sa čitača ne sme da „klikne" fokusirano dugme ljuske ni da procuri
        // na sloj ispod (escape-layer/dijalog) — sken je naš od ovog trenutka.
        ev.preventDefault();
        ev.stopPropagation();
        cbRef.current(code);
        return;
      }
      if (ev.key && ev.key.length === 1) buffer += ev.key;
    };

    document.addEventListener('keydown', onKeydown, true);
    return () => document.removeEventListener('keydown', onKeydown, true);
  }, [enabled]);
}

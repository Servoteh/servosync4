'use client';

import { useEffect, useRef } from 'react';
import { lookupBarcode, type BarcodeResult } from '@/api/reversi';

/**
 * Globalni („always-on") HID skener na nivou Reversi radnog stola — paritet 1.0
 * `globalScanner.js`. Hardver skener emituje karaktere kao tastatura sa Enter na kraju;
 * hook akumulira `keydown` (capture faza) dok fokus NIJE u input/select/textarea/
 * contentEditable i dok nije otvoren modal/skener overlay (tada UI sam preuzima sken).
 * Na Enter parsira bafer (min 4 znaka), razrešava barkod (`lookupBarcode`) i rutira
 * po tipu. Isti kod u prozoru od 1500 ms se ignoriše (dupli Enter / re-skeniranje).
 *
 * Ignoriše dok je otvoren bilo koji modal (`[role="dialog"][aria-modal="true"]`) —
 * to pokriva i ScanOverlay i Dialog-e koje sam hook otvori (posle rutinga sken ćuti
 * dok korisnik ne zatvori dijalog).
 */
export function useGlobalScanner(opts: {
  enabled: boolean;
  onEmployee: (r: BarcodeResult) => void;
  onHand: (r: BarcodeResult) => void;
  onCutting: (r: BarcodeResult) => void;
  onUnknown: (r: BarcodeResult) => void;
}): void {
  // Callback-i su inline literali (nov identitet po renderu) — držimo ih u ref-u da se
  // listener ne skida/vezuje na svaki render roditelja.
  const cbRef = useRef(opts);
  useEffect(() => {
    cbRef.current = opts;
  });

  const enabled = opts.enabled;

  useEffect(() => {
    if (!enabled) return;
    const RESET_MS = 80; // gap između karaktera HID skenera < ~80ms
    const MIN_LENGTH = 4; // ignoriši kratke „slučajne" sekvence
    const THROTTLE_MS = 1500; // ignoriši isti skan (dupli Enter / re-skeniranje)

    let buffer = '';
    let lastKeyAt = 0;
    let lastCode = '';
    let lastAt = 0;
    let detached = false;

    function shouldIgnore(): boolean {
      const ae = document.activeElement;
      if (ae) {
        const tag = ae.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
        if ((ae as HTMLElement).isContentEditable) return true;
      }
      // Otvoren modal / skener overlay (Dialog i ScanOverlay oba nose ovaj marker) —
      // tada drugi UI preuzima skeniranje; ne otimaj skan.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true;
      return false;
    }

    async function dispatch(code: string) {
      const now = Date.now();
      if (code === lastCode && now - lastAt < THROTTLE_MS) return;
      lastCode = code;
      lastAt = now;
      try {
        const { data } = await lookupBarcode(code);
        // Re-proveri posle await-a: modal/input je mogao da se otvori dok je trajao
        // resolve, pa bi skan procurio u pogrešan kontekst.
        if (detached || shouldIgnore()) return;
        switch (data.kind) {
          case 'EMPLOYEE':
            cbRef.current.onEmployee(data);
            break;
          case 'HAND':
            cbRef.current.onHand(data);
            break;
          case 'CUTTING':
            cbRef.current.onCutting(data);
            break;
          default:
            cbRef.current.onUnknown(data);
            break;
        }
      } catch {
        /* swallow — skener ignoriše parser/mrežne greške */
      }
    }

    function onKeydown(ev: KeyboardEvent) {
      if (detached) return;
      if (shouldIgnore()) {
        buffer = '';
        return;
      }
      const now = Date.now();
      if (now - lastKeyAt > RESET_MS) buffer = '';
      lastKeyAt = now;

      if (ev.key === 'Enter') {
        const code = buffer.trim();
        buffer = '';
        if (code.length >= MIN_LENGTH) {
          ev.preventDefault();
          ev.stopPropagation();
          void dispatch(code);
        }
        return;
      }
      if (ev.key && ev.key.length === 1) buffer += ev.key;
    }

    document.addEventListener('keydown', onKeydown, true);
    return () => {
      detached = true;
      document.removeEventListener('keydown', onKeydown, true);
    };
  }, [enabled]);
}

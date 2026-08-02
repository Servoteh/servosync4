'use client';

import { useEffect, type RefObject } from 'react';

/**
 * `useVisualViewportFix` — veže punoekranski skener overlay na **visual** viewport.
 *
 * ZAŠTO (1.0 lekcija, `plan-montaze/src/ui/lokacije/scanModal.js:52-94`
 * `bindVisualViewportFix` + `src/ui/reversi/scanOverlay.js:38-60`):
 * `position:fixed; inset:0` prati **layout** viewport — a to je na mobilnom Safari-ju
 * i Samsung Internet-u prostor KOJI UKLJUČUJE i skrivenu URL traku. Živa slika kamere
 * prati **visual** viewport (ono što se stvarno vidi). Razlika je desetak procenata
 * visine: nišan crtan na `top:50%` layout-a se prevali ISPOD sredine vidljivog kadra,
 * pa radnik mora da spusti barkod ~3 cm ispod nišana da bi se dekodovao. Prijavljeno
 * na iPhone-u (A17) i na Samsung Internet-u; u 1.0 je zato overlay ručno dimenzionisan
 * po `window.visualViewport` i praćen kroz `resize`/`scroll`.
 *
 * 3.0 je ovo do 02.08.2026 imao SAMO u lokacijskoj ljusci (inline u kamera-efektu),
 * dok su reversi, mobilno Održavanje i montažna kartica ostajale sa istim bagom.
 * Ovde je izvučeno u zajednički hook — svaka punoekranska skener ljuska ga zove.
 *
 * Hook NE dira kameru ni dekoder: samo upisuje `top/left/width/height` na dati
 * element i uredno ih skida pri unmount-u. Bez `visualViewport` API-ja (stariji
 * Android WebView, desktop Firefox) je no-op — `fixed inset-0` je tamo tačan.
 *
 * @param ref      Koren overlay-a (`position:fixed` element koji pokriva ekran).
 * @param enabled  Isključi kad overlay nije montiran/aktivan. Default `true`.
 */
export function useVisualViewportFix(
  ref: RefObject<HTMLElement | null>,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    const el = ref.current;
    if (!vv || !el) return;

    const apply = () => {
      el.style.position = 'fixed';
      el.style.top = `${vv.offsetTop}px`;
      el.style.left = `${vv.offsetLeft}px`;
      el.style.width = `${vv.width}px`;
      el.style.height = `${vv.height}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      for (const k of ['top', 'left', 'width', 'height', 'right', 'bottom'] as const)
        el.style.removeProperty(k);
    };
  }, [ref, enabled]);
}

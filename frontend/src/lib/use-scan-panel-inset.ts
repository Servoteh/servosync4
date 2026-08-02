'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * `useScanPanelInset` — meri visinu PLUTAJUĆEG donjeg panela skenera, da nišan može
 * da se centrira u onome što je od kadra STVARNO slobodno.
 *
 * ZAŠTO (regresija na Androidu posle iPhone paketa, 02.08.2026): od prelaska na
 * full-bleed kadar donji panel LEBDI preko `<video>`-a (`absolute bottom-0 z-10`), a
 * nišan je ostao `absolute inset-0 grid place-items-center` — centriran u CELOM ekranu
 * i bez z-index-a, pa ga panel prekriva. Na 360×640 telefonu u „neprekidnom" režimu sa
 * otvorenom listom skeniranog panel počinje na y≈251, a nišan zauzima 278–382: radnik
 * cilja u okvir koji ne vidi, a laser (linija „poravnaj barkod") je potpuno pokriven.
 * iPhone 390×844 to nije pokazao jer je tamo panel relativno niži.
 *
 * Fiksni procenat („nišan na 35% visine") ovde ne radi — panel raste i pada uživo:
 * zoom klizač postoji samo gde uređaj izlaže capability, status ume da bude 1–3 reda,
 * hint se gasi posle prvog skena, lista skeniranog raste. Zato se visina MERI
 * (`ResizeObserver`) i predaje nišanu kao donji odmak; nišan tako uvek stoji na sredini
 * vidljivog dela kadra, na svakom uređaju i u svakom stanju panela.
 *
 * Bez `ResizeObserver` (stariji Android WebView) ostaje jednokratno merenje na mount —
 * i dalje bolje od nule, a nišan se u najgorem slučaju ponaša kao pre.
 *
 * @returns `[ref, inset]` — `ref` ide na plutajući panel, `inset` (px) na `ScanReticle`.
 */
export function useScanPanelInset<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let last = -1;
    const measure = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      // Zaokruženo na piksel + poređenje sa poslednjom vrednošću: bez ovoga bi
      // subpiksel oscilacija (tekst statusa, animacija) vrtela render petlju.
      if (h !== last) {
        last = h;
        setInset(h);
      }
    };
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, inset];
}

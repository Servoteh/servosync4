'use client';

import { useEffect } from 'react';

/**
 * Registracija service worker-a mobilne 3.0 aplikacije — MONTIRA SE SAMO POD `/mob`
 * (`app/mob/layout.tsx`), nikad na desktop rutama.
 *
 * ZAŠTO UOPŠTE: Chrome za Android nudi „Instaliraj aplikaciju" tek kad origin ima
 * manifest + service worker sa stvarnim `fetch` rukovaocem koji kontroliše `start_url`.
 * Manifest (`public/mob.webmanifest`) i ikone su živi od 02.08.2026 — SW je bio jedini
 * preostali uslov.
 *
 * 🔴 SCOPE `/mob`, NE `/`:
 *  · root prostor je 1.0-in — njen Workbox pri svakom startu registruje `/sw.js`
 *    (`worker/index.ts` proksira `/m`, `/m/*`, `/assets/*`, `/icons/*`,
 *    `/manifest.webmanifest` na staru mobilnu). Uži scope po specifikaciji NE otima
 *    tuđu registraciju; za URL u oba scope-a pobeđuje DUŽI, pa 1.0 ostaje netaknuta.
 *  · `/mob` je BEZ kose crte namerno: scope `/mob/` NE bi pokrio samu početnu `/mob`
 *    (poređenje je prefiks nad stringom), pa ni `start_url` iz manifesta ne bi bio pod
 *    kontrolom SW-a — Chrome tada NE nudi instalaciju. Uz `output: "export"` i
 *    `trailingSlash: false`, `/mob/` se k tome preusmerava na `/mob`. Prefiks `/mob`
 *    hvata i `/mob`, i `/mob/…`, i `/mob-offline` — a `/m`, `/m/*` i ostatak 1.0
 *    prostora NE hvata (ništa od toga ne počinje sa „/mob").
 *
 * TOLERANTNA JE NAMERNO: bez `serviceWorker`-a (stari WebView), van secure context-a
 * (LAN `http://<host>:3000` — tamo SW nije ni dozvoljen) ili na grešku registracije
 * tiho odustaje. Ekran tada radi tačno kao pre uvođenja SW-a.
 */
export function MobSwRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // LAN preko http-a nije secure context → register() bi bacio; pogon tamo radi online.
    if (!window.isSecureContext) return;

    const registruj = () => {
      navigator.serviceWorker.register('/mob-sw.js', { scope: '/mob' }).catch(() => {
        /* privatni režim, blokiran SW, stari pregledač — bez posledica po ekran */
      });
    };

    // Posle `load`: prvi ekran (i kamera skenera) ne dele propusni opseg sa preuzimanjem
    // SW-a i offline ljuske.
    if (document.readyState === 'complete') {
      registruj();
      return;
    }
    window.addEventListener('load', registruj, { once: true });
    return () => window.removeEventListener('load', registruj);
  }, []);

  return null;
}

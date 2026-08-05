// Sunset service worker root prostora (v3, 05.08.2026 — cutover 1.0).
//
// Uloga 1 (sunset, od 17.07): pregledači sa zaostalim 1.0 Workbox SW-om pri
// update-proveri /sw.js dobiju ovaj skript → očisti SVOJE keševe i preuzme
// kontrolu, pa sadržaj ide direktno sa mreže.
// Uloga 2 (od 20.07): dok je proxy 1.0 bio uključen, 1.0 se servirala
// same-origin i njen Workbox je AKTIVNO registrovao /sw.js pri svakom startu.
// ⚠️ ZATO OVDE NEMA `unregister() + navigate()` kao u staroj kill verziji —
// 1.0 bi ga odmah ponovo registrovala i upala u beskonačnu petlju reload-ova
// (incident 21.07.2026). Dok god `PROXY_1_0_AKTIVAN` u worker/index.ts može
// da vrati 1.0, ovaj skript OSTAJE „očisti svoje, claim, propuštaj".
// Stanje od 05.08.2026: proxy je isključen, /m* servira 3.0 static export koji
// preusmerava na /mob/*. Ovaj SW i dalje samo čisti zaostalu 1.0 kešriznicu.
//
// 🔴 ČUVANI PREFIKSI (bug do 05.08.2026): raniji `activate` je brisao SVE
// keševe, pa i `ss3-mob-*` keš instalirane 3.0 PWA (/mob, od 02.08). Radnik
// koji jednom svrati na /m izgubio bi 3.0 offline rezervu baš u pogonu gde
// mreža ume da otkaže. Brišu se samo keševi koji NISU 3.0.

/** Keševi koji pripadaju ServoSync 3.0 — ovaj SW ih ne sme dirati. */
const CUVANI_PREFIKSI = ['ss3-', 'servosync3-'];

/** @param {string} name */
function jeNasKes(name) {
  return CUVANI_PREFIKSI.some((p) => name.startsWith(p));
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(
          names.filter((n) => !jeNasKes(n)).map((n) => caches.delete(n)),
        );
      } catch {
        /* caches nedostupan — nastavi */
      }
      try {
        await self.clients.claim();
      } catch {
        /* ignore */
      }
    })(),
  );
});

// Bez presretanja: sve ide direktno na mrežu. Offline rezervu za /mob drži
// zaseban public/mob-sw.js sa scope-om /mob — ovaj SW mu se ne meša u posao.
self.addEventListener('fetch', () => {});

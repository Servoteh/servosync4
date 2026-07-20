// Sunset + kapija service worker (v2, 20.07.2026).
//
// Uloga 1 (sunset, od 17.07): pregledači sa zaostalim 1.0 Workbox SW-om pri
// update-proveri /sw.js dobiju ovaj skript → očisti keševe i preuzme kontrolu,
// pa sadržaj ide direktno sa mreže.
// Uloga 2 (od 20.07, /m kapija): stara 1.0 mobilna se ponovo servira
// same-origin (worker/index.ts proxy) i njen Workbox AKTIVNO registruje
// /sw.js pri svakom startu. Zato NEMA unregister() + navigate() kao u staroj
// kill verziji — 1.0 bi ga odmah ponovo registrovala i upala u beskonačnu
// petlju reload-ova. Ovde: očisti keševe, claim-uj klijente, propuštaj mrežu.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
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

// Bez presretanja: sve ide direktno na mrežu (a /m* i /assets/* na mreži
// servira worker proxy ka staroj 1.0).
self.addEventListener('fetch', () => {});

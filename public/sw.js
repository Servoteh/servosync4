// „Kill" / sunset service worker (cutover 1.0 → 2.0, 17.07.2026).
//
// ServoSync 1.0 (Vite + Workbox) je registrovao service worker na /sw.js, scope /.
// Posle prebacivanja domena servosync.servoteh.com na 2.0, pregledači koji su koristili
// 1.0 i dalje serviraju KEŠIRANU 1.0 iz tog SW-a. 2.0 sam NE registruje service worker,
// ali serviranjem OVOG /sw.js starijem SW-u (koji pri navigaciji radi update-proveru
// istog URL-a) dajemo nov skript: on se instalira, obriše sve keševe, odregistruje se i
// osveži otvorene prozore → pregledač dobija svežu 2.0. Jednokratno, sam se demontira.
//
// Fresh 2.0 korisnici NIKAD ne stignu ovde (2.0 ne poziva navigator.serviceWorker.register),
// pa ovo utiče ISKLJUČIVO na zaostale 1.0 SW-ove.

self.addEventListener('install', () => {
  // Preskoči „waiting" — odmah pređi u aktivaciju (menja stari 1.0 SW bez čekanja).
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 1) Obriši sve keševe (stari 1.0 Workbox precache).
      try {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      } catch {
        /* caches nedostupan — nastavi */
      }
      // 2) Odregistruj OVAJ (i time poslednji) service worker.
      try {
        await self.registration.unregister();
      } catch {
        /* ignore */
      }
      // 3) Osveži otvorene prozore da povuku svežu 2.0 (bez SW-a). Reload je jednokratan:
      //    posle unregister-a nema SW-a da se ponovo okine, pa nema petlje.
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
          client.navigate(client.url).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    })(),
  );
});

// Ne presreći fetch — dok se ne aktivira/odregistruje, mreža ide direktno (nema keša 2.0).
self.addEventListener('fetch', () => {});

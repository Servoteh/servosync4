'use client';

/**
 * `hardResetApp` — „Osveži app" / „Ažuriraj app" iz punoekranskog skenera.
 *
 * 🔴 ZATEČEN BAG (nađen 02.08.2026): ranije verzije ove funkcije (dupla, u
 * `lokacije/_components/scan-overlay.tsx` i `reversi/_components/scan-overlay.tsx`)
 * radile su `getRegistrations()` → `unregister()` nad SVIM registracijama i
 * `caches.keys()` → `caches.delete()` nad SVIM keševima origin-a. Na
 * `servosync.servoteh.com` origin NIJE samo 3.0: Cloudflare worker
 * (`frontend/worker/index.ts`, `run_worker_first`) proksira staru **1.0** mobilnu na
 * `/m`, `/m/*`, `/assets/*`, `/icons/*`, `/manifest.webmanifest`, a 1.0 Workbox pri
 * SVAKOM startu registruje `/sw.js` (root scope) i drži svoju offline ljusku u Cache
 * Storage-u. Jedan tap radnika na „Osveži app" u 3.0 skeneru je time brisao 1.0-inu
 * registraciju i 1.0-in offline keš — radnik u pogonu ostane bez 1.0 ljuske, a
 * pravilo „ne smemo poremetiti 1.0" je najtvrđe pravilo ovog repoa.
 *
 * OD SADA:
 *  • **Registracije** — 1.0 teritorija se preskače (v. `belongsToLegacyApp`): skripta
 *    `/sw.js` (to je `frontend/public/sw.js`, sunset+kapija shim koji 1.0 registruje) i
 *    sve sa script/scope putanjom u `/m` prostoru. Ostalo (buduć 3.0 SW pod SVOJIM
 *    imenom) se i dalje odjavljuje.
 *  • **Keševi** — brišu se SAMO keševi sa 3.0 prefiksom (`SS3_CACHE_PREFIXES`). 3.0
 *    danas nema service worker pa nema ni svoje keševe; sve što u Cache Storage-u
 *    postoji pripada 1.0 i ne sme da se dira. Denylist („obriši sve što ne liči na
 *    workbox") bi promašio 1.0 runtime keševe sa proizvoljnim imenima — allowlist ne
 *    može da promaši.
 *
 * Ono zbog čega radnik i pritiska dugme — svež HTML/bundle umesto keširanog — nosi
 * cache-bust reload ispod (`?_r=<ts>` + `location.replace`), ne brisanje tuđih keševa.
 */

/** Prefiksi keševa koje 3.0 sme da obriše. Sve ostalo na origin-u pripada 1.0. */
const SS3_CACHE_PREFIXES = ['ss3-', 'servosync3-'];

/**
 * Da li registracija pripada staroj 1.0 (proksiranoj) aplikaciji.
 *
 * `/sw.js` je rezervisan za 1.0 na isti način kao `/icons/*` i `/manifest.webmanifest`
 * (v. `app/layout.tsx` i `worker/index.ts`): nov 3.0 service worker MORA da nosi drugo
 * ime, inače ovde ne može da se razlikuje od 1.0-inog.
 */
function belongsToLegacyApp(reg: ServiceWorkerRegistration): boolean {
  const scriptUrl =
    reg.active?.scriptURL || reg.waiting?.scriptURL || reg.installing?.scriptURL || '';
  const pathOf = (u: string): string => {
    try {
      return new URL(u, window.location.href).pathname;
    } catch {
      return '';
    }
  };
  const script = pathOf(scriptUrl);
  const scope = pathOf(reg.scope || '');
  const inLegacySpace = (p: string) => p === '/m' || p.startsWith('/m/');
  // Prazan `script` (registracija bez ijednog radnika) = ne znamo čija je → ne diramo.
  if (!script) return true;
  return script === '/sw.js' || inLegacySpace(script) || inLegacySpace(scope);
}

/**
 * Odjavi SAMO 3.0 service worker-e, obriši SAMO 3.0 keševe i učitaj stranicu ponovo
 * sa cache-bust parametrom. Nikad ne baca — pozivalac sme da je pozove i „na slepo".
 */
export async function hardResetApp(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        regs
          .filter((r) => !belongsToLegacyApp(r))
          .map((r) => r.unregister().catch(() => false)),
      );
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => SS3_CACHE_PREFIXES.some((p) => n.startsWith(p)))
          .map((n) => caches.delete(n).catch(() => false)),
      );
    }
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href);
  url.searchParams.set('_r', String(Date.now()));
  window.location.replace(url.toString());
}

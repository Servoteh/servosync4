/*
 * mob-sw.js — service worker MOBILNE 3.0 APLIKACIJE (`/mob`).
 *
 * ZAŠTO POSTOJI: Chrome za Android nudi „Instaliraj aplikaciju" samo ako origin ima
 * manifest + service worker SA STVARNIM `fetch` rukovaocem (prazan listener Chrome ne
 * priznaje) koji kontroliše `start_url` iz manifesta. `mob.webmanifest` i ikone su živi
 * od 02.08.2026; ovo je bio jedini preostali uslov. (iOS ne traži SW — tamo PWA radi i
 * bez ovoga, pa ovaj fajl na iPhone-u ništa ne menja osim offline ljuske.)
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * 🔴 ZAŠTO JE SCOPE UZAK (`/mob`) I ŠTA SE NIKAD NE SME PROŠIRITI
 * ══════════════════════════════════════════════════════════════════════════════════
 * Origin `servosync.servoteh.com` NIJE samo 3.0. Cloudflare worker (`worker/index.ts`,
 * `run_worker_first: true`) proksira STARU 1.0 mobilnu (`servoteh-plan-montaze.pages.dev`)
 * na: `/m`, `/m/*`, `/assets/*`, `/icons/*`, `/manifest.webmanifest`. Ta 1.0 je živa
 * pogonska aplikacija (Capacitor APK ljuska) i njen Workbox pri SVAKOM startu registruje
 * `/sw.js` u ROOT scope-u, sa sopstvenom offline ljuskom u Cache Storage-u.
 *
 * Zato ovaj SW:
 *   • se registruje sa `{ scope: '/mob' }` (v. `app/mob/_components/mob-sw-register.tsx`).
 *     Uži scope po specifikaciji NE otima tuđu registraciju: 1.0-in `/sw.js` ostaje
 *     jedini vlasnik root prostora, a za URL koji padne u OBA scope-a pobeđuje DUŽI —
 *     dakle naš samo za `/mob…`, 1.0-in za sve ostalo, uključujući ceo `/m` prostor.
 *   • ne dodiruje nijednu 1.0 putanju čak ni kad je zahtev stigao do njega
 *     (`jeProstor1_0()` — doslovna kopija pravila iz `worker/index.ts` + `/sw.js`).
 *   • u `install`/`activate` NE briše tuđe keševe ni registracije: čisti isključivo
 *     SVOJE keševe (prefiks `ss3-mob-`). Suprotno je već jednom oborilo 1.0 offline
 *     ljusku u pogonu (v. `src/lib/app-hard-reset.ts`).
 *   • NIKAD ne čita kroz globalni `caches.match()` — uvek `caches.open(NAŠ).match()`.
 *     Globalna pretraga bi umela da vrati 1.0-in keširani odgovor za deljenu putanju.
 *
 * NE SME DA SE PROŠIRI:
 *   ✗ scope `/` ili `/m…` — otima root/1.0 prostor;
 *   ✗ keširanje bilo čega iz `jeProstor1_0()`;
 *   ✗ brisanje keševa/registracija bez `ss3-mob-` prefiksa;
 *   ✗ preimenovanje skripta u `/sw.js` (to ime je 1.0-ino i `app-hard-reset.ts` po
 *     njemu razlikuje čije je šta).
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * ŠTA RADI (i šta namerno NE radi)
 * ══════════════════════════════════════════════════════════════════════════════════
 *  • Navigacije (`/mob…`): MREŽA PRVA, keš kao rezerva, pa offline ekran (`/mob-offline`,
 *    fajl `public/mob-offline.html`). Mreža prva = radnik posle deploy-a uvek dobije
 *    svež HTML; keš se koristi tek kad veze nema (pogon, hala, lift).
 *  • Statika sa sadržajnim hešom (`/_next/static/*`) + `/fonts/*` + `/mob-icons/*`:
 *    KEŠ PRVI. Ime nosi heš, pa keširana kopija ne može da zastari.
 *  • API se NE kešira — ni na tunelu (drugi origin, ni ne presrećemo) ni na LAN-u
 *    (`http://<host>:3000/api`, isti origin → eksplicitno izuzet). Svežina podataka je
 *    posao `api/query-provider.tsx`; SW koji kešira API tiho vraća jučerašnje stanje
 *    magacina, a to je gore od greške.
 *  • `/version.json` i `/config.js` se NE kešira — prvi je detektor nove verzije
 *    (`components/update-notifier.tsx`), drugi runtime override API adrese.
 *
 * ══════════════════════════════════════════════════════════════════════════════════
 * ZAŠTO NEMA `skipWaiting()` U `install`
 * ══════════════════════════════════════════════════════════════════════════════════
 * Nova verzija ostaje u `waiting` dok su otvorene `/mob` strane. Da odmah preuzme
 * kontrolu, presrela bi zahteve strane koja je učitana sa STARIM chunk-ovima — usred
 * skeniranja (`ScanOverlay` drži kameru i nezavršen unos) to je izgubljen posao.
 * Prelazak na novu verziju rade dva postojeća, KORISNIKOVA poteza:
 *   1. „Resetuj aplikaciju" u skener ljusci (`lib/app-hard-reset.ts` → odjava 3.0 SW-a,
 *      brisanje `ss3-` keševa, cache-bust reload), i
 *   2. baner „dostupna je nova verzija" (`UpdateNotifier`) → obično osvežavanje.
 * `clients.claim()` u `activate` JESTE tu, ali je bezopasan baš zato što nema
 * `skipWaiting()`: aktivacija nadogradnje čeka da se sve stare strane zatvore, pa
 * „preuzimanje" pogađa samo prvu instalaciju (gde kontrolora ionako nije bilo).
 *
 * Za ručno preuzimanje bez reload-a postoji poruka `ss3-mob-skip-waiting` (danas je
 * niko ne šalje — kuka za buduće dugme „primeni novu verziju").
 */

/**
 * Diže se RUČNO pri svakoj izmeni ovog fajla — menja imena keševa = čist start.
 * v2 (02.08.2026): OBAVEZAN podizak — v1 je u `ss3-mob-static-v1` mogao da drži offline
 * ekran dobavljen preko preusmerenja (v. `OFFLINE_URL` i `bezPreusmerenja()`); takav
 * keširan odgovor ostaje pokvaren dok se keš ne preimenuje, pa ga `activate` sad briše.
 */
const VERZIJA = 'v2';

/** 🔴 Prefiks `ss3-` je ugovor sa `src/lib/app-hard-reset.ts` (SS3_CACHE_PREFIXES). */
const KES_STATIKA = `ss3-mob-static-${VERZIJA}`;
const KES_STRANE = `ss3-mob-pages-${VERZIJA}`;
/**
 * Offline ekran ima SVOJ keš, ne deli ga sa statikom. U `KES_STATIKA` bi bio prvi
 * upisani ključ, a sečenje viška (`upisiUKes`) briše baš sa POČETKA — posle nekoliko
 * deploy-eva (svaki donese nov skup `/_next/static/*`) ispao bi iz keša i offline
 * rezerva bi nestala tiho, bez ijedne greške. Ovde je sam i nikad se ne seče.
 */
const KES_LJUSKA = `ss3-mob-shell-${VERZIJA}`;
const NASI_KESEVI = [KES_STATIKA, KES_STRANE, KES_LJUSKA];
/** Sve što počinje ovim je NAŠE i sme da se briše. Ništa drugo. */
const NAS_PREFIKS = 'ss3-mob-';

/**
 * 🔴 BEZ `.html`! Cloudflare Pages servira „clean URLs": `/mob-offline.html` vraća
 * **307 na `/mob-offline`** (izmereno na produ 02.08.2026), a 200 daje tek putanja bez
 * nastavka. Isto važi za svaku stranu iz `output: "export"` (`/mob.html` → `/mob`), i
 * poklapa se sa `trailingSlash: false` iz `next.config.ts`.
 *
 * Zašto to nije kozmetika: `fetch` podrazumevano PRATI preusmerenje, pa bi odgovor koji
 * upišemo u keš nosio `response.redirected === true`. Odgovor sa tim flagom servisni
 * radnik NE SME da vrati na NAVIGACIONI zahtev — pregledač obara navigaciju greškom
 * „Response served by service worker has redirections". Offline rezerva bi, dakle, bila
 * pokvarena tačno u trenutku kad zatreba (radnik bez mreže), i to nevidljivo dok se ne
 * desi. Fajl `public/mob-offline.html` ostaje kako jeste — menja se samo URL kojim mu
 * prilazimo. Putanja i dalje počinje sa `/mob`, pa je unutar scope-a SW-a i instalirane
 * aplikacije (v. `mob-sw-register.tsx`).
 */
const OFFLINE_URL = '/mob-offline';

/** Doslovna kopija `jeStaraMobilna()` iz `worker/index.ts` + 1.0-in `/sw.js`. */
function jeProstor1_0(p) {
  return (
    p === '/m' ||
    p.startsWith('/m/') ||
    p.startsWith('/assets/') ||
    p.startsWith('/icons/') ||
    p === '/manifest.webmanifest' ||
    p === '/sw.js'
  );
}

/** Nikad iz keša: API, detektor verzije, runtime config, sam SW, SCADA iframe. */
function nikadKes(p) {
  return (
    p.startsWith('/api/') ||
    p === '/version.json' ||
    p === '/config.js' ||
    p === '/mob-sw.js' ||
    p.startsWith('/scada-hmi/') ||
    p.startsWith('/tesseract/')
  );
}

/** Nepromenljivi resursi (heš u imenu ili stabilan fajl) — keš prvi. */
const STATIKA_PREFIKSI = ['/_next/static/', '/fonts/', '/mob-icons/'];

/**
 * Gornja granica broja unosa po kešu. Imena `/_next/static/*` nose heš, pa SVAKI deploy
 * donosi nov skup — bez granice bi keš rastao neograničeno (stari chunk-ovi se nikad ne
 * traže ponovo). Cache API drži ključeve redom upisa, pa se višak seče sa POČETKA.
 */
const MAX_UNOSA = { [KES_STATIKA]: 300, [KES_STRANE]: 40 };

/**
 * 🔴 POJAS UZ TREGERE: skida `redirected` flag pre upisa u keš.
 *
 * Ako je odgovor stigao kroz preusmerenje, `response.redirected` je `true` i taj flag
 * PREŽIVLJAVA Cache Storage (uz odgovor se čuva lista URL-ova kroz koje je prošao).
 * Vraćen na navigacioni zahtev, obara navigaciju („Response served by service worker
 * has redirections") — i to trajno, dok se keš ne preimenuje preko `VERZIJA`.
 *
 * Prepakivanje tela u nov `Response` zadržava sadržaj, status i zaglavlja, a flag gubi
 * (nov odgovor nema listu URL-ova). Time smo zaštićeni i ako se pravila na Cloudflare
 * strani sutra promene — ne oslanjamo se samo na to što `OFFLINE_URL` danas vraća 200.
 */
async function bezPreusmerenja(res) {
  if (!res.redirected) return res;
  // 204/205 nemaju telo — `new Response(telo, { status })` bi bacio, a takav odgovor
  // ionako nema šta da posluži offline. Ne keširamo ga.
  if (res.status === 204 || res.status === 205) return null;
  return new Response(await res.blob(), {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

async function upisiUKes(imeKesa, req, res) {
  const zaUpis = await bezPreusmerenja(res);
  if (!zaUpis) return;
  const kes = await caches.open(imeKesa);
  await kes.put(req, zaUpis);
  const kljucevi = await kes.keys();
  const visak = kljucevi.length - (MAX_UNOSA[imeKesa] ?? 300);
  for (let i = 0; i < visak; i++) await kes.delete(kljucevi[i]);
}

self.addEventListener('install', (event) => {
  // Bez skipWaiting (v. zaglavlje). `cache: 'reload'` = uzmi offline ekran sa mreže,
  // ne iz HTTP keša.
  //
  // 🔴 NAMERNO TOLERANTNO — spoljni `catch` mora da ostane. Odbijen `waitUntil` obara
  // CELU instalaciju service worker-a, a bez registrovanog SW-a Chrome za Android ne
  // nudi „Instaliraj aplikaciju" (v. zaglavlje) — tj. neuspelo keširanje jednog ekrana
  // oduzelo bi aplikaciji instalabilnost. Razlozi za pad su svakodnevni: instalacija
  // bez veze, popunjena kvota, privatni režim. SW bez offline ekrana i dalje radi:
  // navigacija pada na keširanu stranu, pa na 503 poruku iz `navigacija()`.
  //
  // NE koristimo `cache.add()`: on interno fetch-uje sa `redirect: 'follow'` i upisao
  // bi odgovor sa podignutim `redirected` flagom (v. `bezPreusmerenja()`).
  event.waitUntil(
    (async () => {
      const res = await fetch(new Request(OFFLINE_URL, { cache: 'reload' }));
      if (!res || !res.ok) return; // 404/500 → bez offline ekrana, ali SW ostaje živ
      const zaUpis = await bezPreusmerenja(res);
      if (!zaUpis) return;
      const kes = await caches.open(KES_LJUSKA);
      await kes.put(OFFLINE_URL, zaUpis);
    })().catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const imena = await caches.keys();
        await Promise.all(
          imena
            // 🔴 SAMO naši keševi (`ss3-mob-`) i to samo stare verzije. Sve ostalo na
            // origin-u pripada 1.0 i ne sme ni da se dodirne.
            .filter((n) => n.startsWith(NAS_PREFIKS) && !NASI_KESEVI.includes(n))
            .map((n) => caches.delete(n).catch(() => false)),
        );
      } catch {
        /* Cache Storage nedostupan — nastavi */
      }
      try {
        await self.clients.claim();
      } catch {
        /* ignore */
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'ss3-mob-skip-waiting') self.skipWaiting();
});

/** Mreža prva; bez veze → keširana ista strana → offline ekran. */
async function navigacija(event, req) {
  try {
    const res = await fetch(req);
    // Samo uspešni odgovori sa NAŠEG origina idu u keš. `type !== 'basic'` isključuje
    // i `opaqueredirect` (navigacija ima `redirect: 'manual'`, pa preusmerenje stiže
    // kao takav odgovor koji se prosleđuje pregledaču, ali se NE kešira).
    if (res && res.ok && res.type === 'basic') {
      const kopija = res.clone();
      // `waitUntil` — upis sme da traje i pošto je odgovor otišao strani; bez toga
      // pregledač sme da ubije SW usred pisanja.
      event.waitUntil(upisiUKes(KES_STRANE, req, kopija).catch(() => undefined));
    }
    return res;
  } catch {
    // `ignoreSearch` — reload iz „Resetuj aplikaciju" nosi `?_r=<ts>`, a to je ista strana.
    const kes = await caches.open(KES_STRANE);
    let keširano = await kes.match(req, { ignoreSearch: true });
    // `trailingSlash: false` (next.config.ts) + Cloudflare Pages: online je `/mob/` 307
    // na `/mob`, pa u kešu postoji SAMO oblik bez kose crte. Radnik koji je stranu
    // otvorio (ili prečicu sačuvao) sa kosom crtom bi bez ovog koraka offline dobio
    // offline ekran umesto svoje keširane strane.
    if (!keširano) {
      try {
        const u = new URL(req.url);
        if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
          u.pathname = u.pathname.replace(/\/+$/, '');
          keširano = await kes.match(u.href, { ignoreSearch: true });
        }
      } catch {
        /* neispravan URL — pravo na offline ekran */
      }
    }
    if (keširano) return keširano;
    const kesLjuske = await caches.open(KES_LJUSKA);
    const offline = await kesLjuske.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response('Nema veze sa mrežom.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/** Keš prvi (resursi sa hešom u imenu ne mogu da zastare). */
async function statika(event, req) {
  // 🔴 `caches.open(NAŠ).match()`, nikad globalni `caches.match()`: globalni pretražuje
  // SVE keševe origin-a, uključujući 1.0-ine — ni čitanje tuđeg keša nije naš posao.
  const kes = await caches.open(KES_STATIKA);
  const keširano = await kes.match(req);
  if (keširano) return keširano;
  const res = await fetch(req);
  if (res && res.ok && res.type === 'basic') {
    const kopija = res.clone();
    event.waitUntil(upisiUKes(KES_STATIKA, req, kopija).catch(() => undefined));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Ne diramo: mutacije (POST/PUT/DELETE), tuđe origine (API na tunelu, Supabase,
  // sy15), delimične zahteve (video/audio Range) — sve ide direktno na mrežu.
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  const p = url.pathname;
  if (jeProstor1_0(p)) return; // 🔴 1.0 teritorija — nikad
  if (nikadKes(p)) return;

  if (req.mode === 'navigate') {
    event.respondWith(navigacija(event, req));
    return;
  }
  if (STATIKA_PREFIKSI.some((pref) => p.startsWith(pref))) {
    event.respondWith(statika(event, req));
    return;
  }
  // Sve ostalo (npr. `/logo-servoteh.jpg`, ad-hoc fetch strane): bez presretanja.
});

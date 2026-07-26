# PLAN — ServoSync 3.0 mobilna aplikacija (`/mob`)

**Datum:** 25.07.2026 · **Odluka:** Nenad (posle istraživanja stanja) · **Status:** Faza 0 u izradi

## 1. Odluka

**`/mob/*` je kanonski prostor 3.0 mobilne aplikacije.** Gradi se paralelno sa 1.0 mobilnom,
koja do potpunog pariteta ostaje netaknuta na `/m/*` (Cloudflare Worker proxy na
`servoteh-plan-montaze.pages.dev`; APK ljuska zavisi od njega). Nikakav rad na `/mob` ne sme
da dodirne rutiranje `/m/*`.

Zašto `/mob` a ne `/m`: Worker sa `run_worker_first: true` presreće **sve** `/m/*` zahteve na
javnom domenu i šalje ih na 1.0 — 3.0 stranice pod `/m/*` su tamo nedostižne (bile su dostupne
samo na LAN `:3000` bake-u). `/mob` je isti origin kao `/m`, pa APK WebView pri prelazu
1.0 → 3.0 ekran **ne ispada iz ljuske** (native plugini ostaju živi), a SSO most prenosi sesiju.

## 2. Arhitektura tranzicije

- **Worker** ([frontend/worker/index.ts](../frontend/worker/index.ts) +
  [wrangler.jsonc](../frontend/wrangler.jsonc)): `/m`, `/m/*`, `/assets/*`, `/icons/*`,
  `/manifest.webmanifest` → 1.0 pages.dev; sve ostalo (uklj. `/mob/*`) → 3.0 ASSETS.
- **APK** = Capacitor ljuska 1.0 repoa, `server.url = https://servosync.servoteh.com/m` —
  tanka ljuska nad živim webom; web izmene stižu bez novog APK-a.
- **SSO most 1.0 → 3.0** (živ obrazac, prečica „Prisustvo uživo" iz 1.0 Kadrovske):
  1.0 doda `#ss_token=<GoTrue>&entry=<ruta>` → 3.0 `auth-context` razmeni na `POST /auth/sso`
  (HS256 deljeni `SY15_JWT_SECRET`, JIT provisioning) i obriše token iz URL-a/istorije.
- **Skener**: svi 3.0 ekrani kroz `frontend/src/lib/barcode-decoder.ts` (radi u Android
  WebView i na iPhone Safari-ju; gejt = `getUserMedia`, nikad `BarcodeDetector`).
- **Offline**: `frontend/src/lib/offlineQueue.ts` (idempotencija `client_event_uuid`).

## 3. Zaštitna pravila (tvrdo)

1. **Ne dirati bez `[worker-change]` markera u commit poruci** (mašinski guard u
   `deploy-frontend.yml`): `frontend/worker/index.ts`, `frontend/wrangler.jsonc`,
   `frontend/public/sw.js` (1.0 registruje `/sw.js` na svakom startu — kill-switch verzija
   pravi reload petlju u APK-u!).
2. **Smoke posle svakog FE deploy-a** (korak u `deploy-frontend.yml`): `/m`, `/m/montaza`,
   `/m/odrzavanje` moraju vraćati 1.0 („Servosync V1.0") + `/login` mora vraćati 3.0.
3. Prefiksi `/assets/*`, `/icons/*`, `/manifest.webmanifest` pripadaju 1.0 dok proxy živi —
   buduća 3.0 PWA ide na druge putanje (npr. `/mob-manifest.webmanifest`).
4. FE-only push **ne osvežava LAN `:3000`** — nove `/mob` rute traže i backend deploy
   (`deploy-backend` workflow_dispatch) za LAN korisnike.
5. Static export: `/mob` ekrani bez `[id]` ruta — detalji kroz `?id=N`.

## 4. Faze

| Faza | Sadržaj | Status |
|---|---|---|
| **0** | `/mob` hub (kartice po pravima) + seoba 9 gotovih 3.0 ekrana sa `/m/*` na `/mob/*` (stari `/m/*` = redirect stubovi za LAN) | u izradi |
| **1** | Prečice sa 1.0 huba na `/mob` ekrane sa `#ss_token` (obrazac Kadrovska → `/mob/prisustvo`); modul po modul, trenutno reverzibilno. Prioritet: **praćenje** (1.0 `/m/pracenje` čita zamrznute sy15 podatke — plan F5 O8) | **ŽIVA 25.07** — 1.0 `9de4d6f`: hub kartica „ServoSync 3.0" (svi) + `/m/pracenje` auto-forward na `/mob/pracenje` (`location.replace`, ručno dugme fallback, beg `localStorage ss2_cutover='off'`); deploy verifikovan na pages.dev i kroz `/m` proxy |
| **2** | Popuna pariteta: odsustva/GO, za-mene, profil, sati, odobravanja, onboarding, reversi, kadrovska, projektovanje, magacin ekstre (batch/lookup/istorija), sastanci write dopune, app-lock | plan |
| **3** | Nova Capacitor ljuska za 3.0 (`server.url → /mob`), push (FCM), pa flip `/m` → redirect na `/mob` i gašenje pages.dev (poklapa se sa RADNI_PLAN Blok B4 + Blok D) | kraj |

## 5. Mapa modula: 1.0 `/m` → 3.0 `/mob`

| 1.0 ruta | Šta radi | 3.0 ruta | Status |
|---|---|---|---|
| `/m` (hub) | kartice + donja traka | `/mob` | **Faza 0 — novo** |
| `/m/magacin`, `/m/scan`, `/m/manual` | sken/ručni unos → premeštanje | `/mob/lokacije` | ✅ živo 23.07 |
| `/m/batch`, `/m/lookup`, `/m/history` | batch mod, pretraga crteža, istorija | dopune `/mob/lokacije` | Faza 2 |
| — (1.0 nema; SSO prečica) | prisustvo uživo (kadrovska) | `/mob/prisustvo` | ✅ živo 25.07 |
| — (3.0 G6) | moje prisustvo + korekcije | `/mob/moje-prisustvo` | Faza 0 (seoba sa `/m/prisustvo`; **preimenovano** zbog sudara sa pregledom uživo) |
| `/m/montaza` | plan montaže + izveštaji + neusaglašenosti | `/mob/montaza` | Faza 0 (seoba) |
| `/m/izvestaj` | AI izveštaj montera (tekst+fotke→PDF) | `/mob/izvestaj` | Faza 0 (seoba) |
| `/m/odrzavanje` | karton sredstva, prijava kvara, QR sken | `/mob/odrzavanje` | Faza 0 (seoba) |
| `/m/pracenje` | override statusa pozicija | `/mob/pracenje` | Faza 0 (seoba) — **O8 meta postaje `/mob/pracenje`** |
| `/m/proizvodnja` | red operacija po mašini | `/mob/proizvodnja` | Faza 0 (seoba) |
| `/m/sastanci` | pregled + RSVP/status akcija | `/mob/sastanci` | Faza 0 (seoba; write dopune = Faza 2) |
| `/m/energetika` | SCADA nadzor + touch komande | `/mob/energetika` | Faza 0 (seoba) |
| `/m/ai` | AI asistent | `/mob/ai` | Faza 0 (seoba) |
| `/m/odsustva` | GO: saldo, zahtevi, PDF | `/mob/odsustva` | Faza 2 |
| `/m/sati` | mesečni sati + primedba | `/mob/sati` | Faza 2 |
| `/m/odobravanja` | šef odobrava GO | `/mob/odobravanja` | Faza 2 |
| `/m/onboarding` | čeklista uvođenja | `/mob/onboarding` | Faza 2 |
| `/m/za-mene` | moje akcije/sastanci/predlozi | `/mob/za-mene` | Faza 2 |
| `/m/profil` | nalog, GO saldo, tim, podešavanja | `/mob/profil` | Faza 2 |
| `/m/reversi` | zaduženja, izdavanje/vraćanje | `/mob/reversi` | Faza 2 |
| `/m/kadrovska` | HR read-only pregled | `/mob/kadrovska` | Faza 2 |
| `/m/lokacije` | read-only pregled predmeta/TP + smeštaj | odluka u Fazi 2 (deo `/mob/lokacije`?) | Faza 2 |
| `/m/projektovanje` | PB zadaci + progres | `/mob/projektovanje` | Faza 2 |
| app-lock (PIN/biometrija), push | lokalna brava, notifikacije | ljuska | Faza 3 |

Obim 1.0 mobilnog (popis 25.07): 25 ruta, ~9.400 LOC ekrana + ~1.900 CSS + ~950 mobilnih
servisa; **bez sopstvenog backenda** (sve reuse desktop servisa) — zato je 3.0 mobilni ekran
po pravilu tanak omotač nad postojećim komponentama (dokaz: `/m/montaza` = 61 linija).

## 5a. Deploy 1.0 (naučeno u Fazi 1, 25.07)

- **Živa produkcijska grana 1.0 repoa = `cutover/front-repoint`** (main je zastareo i divergiran
  — 210/148 komita razlike; NE spajati bez posebne odluke).
- Push na cutover granu pravi samo **preview** deployment (branch alias). **Produkcija
  pages.dev** = GH workflow **„Deploy Cloudflare Pages"** `workflow_dispatch` nad
  `cutover/front-repoint` sa input-om **`promote_to_production=true`** (dodato `9e77b51`;
  dodaje `--branch=main` wrangler-u).
- ⚠️ **Nikad lokalni `vite build` + wrangler deploy za 1.0**: lokalni `.env` i dalje pokazuje
  na ugašeni cloud Supabase — samo CI build sa GH secrets.
- SSO prelaz 1.0→3.0: `src/lib/ss2Go.js` (klon `goLivePrisustvo`); auto-forward UVEK sa
  `replace: true` (back-petlja).

## 6. Otvorena pitanja

- Redosled modula u Fazi 2 (predlog: odsustva → odobravanja → reversi → za-mene/profil →
  ostalo) — potvrda Nenada.
- 1.0 `/m/lokacije` (read-only pregled predmeta) — zaseban `/mob` ekran ili tab u postojećem?
- Push: web-push u 3.0 čeka odobrenje zavisnosti; FCM tek uz novu ljusku (Faza 3).
- e2e smoke za `/mob` rute (follow-up posle Faze 0).

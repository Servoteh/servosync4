# ServoSync — Roadmap digitalizacije Servoteha (1.0 → 4.0)

> Autoritativni plan verzija. Cilj: od razdvojenih legacy sistema (Access/VBA BigBit, MS SQL QBigTehn, Supabase plan-montaže) do **jednog ERP + MES rešenja** na sopstvenom serveru.
> **Vizuelni prikaz:** [ROADMAP.html](ROADMAP.html) — otvoriti lokalno u browseru (snapshot 4.7.2026; izvor istine ostaje ovaj fajl).
> Prateće analize: [migration/README.md](migration/README.md) · [00-comparison](migration/00-comparison-qbigtehn-vs-planmontaze.md) · [01-qbigtehn-architecture](migration/01-qbigtehn-architecture-analysis.md) · [02-scope](migration/02-qbigtehn-scope-triage.md) · [03-planmontaze](migration/03-planmontaze-complexity-profile.md) · [05-sqlserver-logic](migration/05-qbigtehn-sqlserver-logic.md).

---

## Pregled na jednom mestu

| Verzija | Šta je | Stack | Status | Rezultat |
|---|---|---|---|---|
| **1.0** | Web moduli koje Nesa razvija (kadrovska, lokacije, održavanje, sastanci, reversi, plan montaže…) | Vite + vanilla JS · **Supabase** (PG cloud) → **self-host on-prem (međukorak)** | **Živ, u produkciji** (razvoj zaključan ~1.5.2026); **međukorak odobren 4.7.2026** | Operativna MES-nadgradnja preko BigTehn-a |
| **2.0** | 1:1 (minimum) prerada **QBigTehn** (Access + MS SQL, Negovanov sistem) — proizvodnja/tehnologija | **NestJS + Prisma + PostgreSQL** on-prem | **Praktično završen (12.7.2026):** modul „Tehnologija" živ, spojen u 1.5 na `servosync.servoteh.com/tehnologija`; tehnolog tok (P0–P5), auto-uvoz PDM XML, RBAC enforced. Ostaje kozmetika. | Proizvodni core: RN, TP, PDM/BOM, MRP, primopredaje, lokacije |
| **3.0** | Prebacivanje **1.0 → stack 2.0** (Postgres + NestJS + Next) i integracija u **jednu aplikaciju** | isti kao 2.0 | Planirano | Objedinjen MES: proizvodnja (2.0) + operativni moduli (1.0) |
| **4.0** | Integracija **BigBit ERP** (Access/VBA, komercijala: GK/PDV/fakture/magacin) u 3.0 | isti kao 2.0 | Planirano | **Kompletan ERP + MES** — jedna platforma za ceo Servoteh |

**Vodeći princip kroz sve faze:** on-prem PostgreSQL, jedan izvor istine po tabeli, `legacy_*` mapping sloj, **overlay-never-touch-cache** (sync sme da menja samo cache tabele; lokalna polja su u overlay-u). Front na Cloudflare, backend on-prem — spolja dostupan **isključivo kroz Cloudflare Tunnel** (odluka 4.7.2026, umesto WireGuard VPN-a: javna adresa aplikacije ostaje **ista kao postojeća**, server se ne izlaže direktno, bez VPN aplikacija na uređajima).

> **Napomena o terminologiji:** Lukini dizajn dokumenti (`ARCHITECTURE.md`) i claude.ai Project koriste „Faza 1 / Faza 2". Mapiranje: „Faza 1" = **ServoSync 1.0** (plan-montaže), „Faza 2" = **ServoSync 2.0** (ovaj repo). 3.0 i 4.0 su nove, dalje faze.

---

## ServoSync 1.0 — operativni web moduli (Supabase)

**Repo:** `servoteh-plan-montaze` · **Autor:** Nesa (uz Cursor/Claude) · **Rok zaključavanja razvoja:** ~1. maj 2026.

### Kako je pisano (struktura)
- **Frontend:** Vite + **vanilla JavaScript** (bez framework-a), imperativni DOM. ~151.000 linija JS / 342 fajla + ~29.000 linija CSS. ~19 UI modula.
- **State:** 8 store-ova (`src/state/`). **lib:** 66 fajlova (PDF, format, helperi).
- **Data-access:** `src/services/` — 83 fajla / ~25.900 linija; tanak `sbReq*` wrapper (`supabase.js`) nad Supabase REST-om; ~753 poziva. supabase-js SDK samo u 2 fajla (realtime, passkeys).
- **Backend = Supabase (BaaS):** PostgreSQL + **RLS** (293 žive politike = jedini authz sloj) + **238 SECURITY DEFINER** funkcija + PostgREST auto-API + GoTrue Auth + Storage + Realtime + Edge Functions (12 Deno fn) + pg_cron (17–26) + 5 outbox tabela.
- **Baza:** 140 tabela, 67 view-ova, 337 migracija.
- **Mobilno:** Capacitor (Android/iOS) + PWA; `server.url` → web izmene žive bez novog APK-a.
- **Testovi:** 61 vitest (čiste domenske funkcije) + 29 pgTAP (RLS/security).

### Moduli
kadrovska (HR) · lokacije delova · održavanje mašina · sastanci · plan montaže · plan proizvodnje · praćenje proizvodnje · projektni biro (PB) · reversi · moj profil · podešavanja/RBAC · energetika-SCADA · štampa nalepnica · mobilni.

### Uloga u roadmap-u
1.0 je **izvor poslovnih pravila, UX tokova, RLS/audit obrazaca i delimičnog SQL modela**. Ostaje živ dok se u 3.0 ne prebaci na stack 2.0. Za neke tabele (npr. `zaposleni`) **1.0/Supabase je izvor istine** i tokom tranzicije se sinhronizuje sa 2.0 (vidi „Sync tokom tranzicije").

### Međukorak — 1.0 sa Supabase clouda na on-prem (ODOBRENO 2026-07-04)

**Odluka (Nenad, 4.7.2026):** 1.0 se **pre 3.0** seli sa Supabase clouda na naš Ubuntu server kao
self-hosted stack: **PostgreSQL + PostgREST + GoTrue** (open-source komponente uz PG — nije Supabase
cloud). Kod aplikacije, sve RLS politike i način rada ostaju netaknuti; u frontu se menja samo API
URL + ključevi (sav data-access ide kroz `sbReq` wrapper, pa je promena u jednom config mestu).

- **Faza 1 (2–3 nedelje):** infra prelaz — puna nezavisnost od Supabase clouda. Obavezan obuhvat:
  storage (fajlovi), 12 edge funkcija i pg_cron ekvivalenti — ne samo PostgREST+GoTrue; **pinned
  verzije** komponenti (bez auto-update); pristup: **Cloudflare Tunnel (ODLUČENO 4.7.2026)** —
  javna adresa aplikacije ostaje **ista kao postojeća**, server se ne izlaže direktno u internet,
  bez VPN aplikacija na uređajima (ključno za mobilne telefone radnika).
- **Faza 2 = postojeći 3.0 plan** (strangler-fig): NestJS preuzima modul po modul **nad istom bazom**;
  svaka komponenta ima **sunset kriterijum** — gasi se tek kad poslednji modul koji je koristi pređe
  na NestJS.
- **Posledice po 3.0:** migracija podataka Supabase→on-prem **nestaje kao poseban posao** (podaci su
  posle međukoraka već na on-prem PG; NestJS se u 3.0 kači na istu bazu koju služi PostgREST); auth
  paritet (GoTrue → NestJS JWT) ostaje prvi korak 3.0; NestJS DB konekcija mora imati definisan odnos
  prema RLS politikama (svoj DB user koji ih zaobilazi + guardovi u aplikaciji — da ne nastane dupla,
  konfliktna autorizacija).

---

## ServoSync 2.0 — proizvodni core iz QBigTehn (ovaj repo)

**Repo:** ovaj (`Servosync 2.0/backend`) · **Autor:** Nesa + **Luka Tasić** · **Izvor:** QBigTehn (MS Access front-end + MS SQL Server backend, Negovanov sistem).

### Cilj
**1:1 minimum** onoga što QBigTehn danas radi za proizvodnju/tehnologiju — ali na modernom stack-u (NestJS + Prisma + PostgreSQL 16, on-prem). Ne kopira se ceo legacy, nego **proizvodni podskup** (scope potvrđen analizom: ~44% legacy koda je realno jezgro, 26% je bloat — POS/knjigovodstvo/tuđi klijenti).

### Domen (9 modula, scope V1)
PDM/crteži/BOM · Nacrti · Primopredaje · Radni nalozi (RN) · Tehnološki postupci (TP)/Proizvodnja · Lokacije delova · Proizvodne strukture (radnici/mašine/operacije) · MRP/Nabavka (uvid) · Komitenti/Predmeti (pregled).
**Van scope-a 2.0:** knjigovodstvo, PDV/KEPU, fakturisanje, fiskalizacija, POS — ostaje u BigBit-u (dolazi u 4.0).

### ✅ Checkpoint 2026-07-13 — probe na produkciji + dorade (ODLUKE #33–#36)

Isporuke 12–13.07 (detaljno: [MODUL_TEHNOLOGIJA.md](MODUL_TEHNOLOGIJA.md) +
[design/KOMENTARI_TEHNOLOGIJA_2026-07-12_TRIJAZA.md](design/KOMENTARI_TEHNOLOGIJA_2026-07-12_TRIJAZA.md)):

- **Nacrti/Primopredaje razdvojeni** (ODLUKE #33): `/nacrti` (gate `primopredaje.write`, projektanti)
  vs `/handovers` (gate `primopredaje.approve`, tehnolozi); tehnolog+menadzment dobili
  `primopredaje.approve` (menadzment PRIVREMENO).
- **Paket A** (#34): `users.worker_id` vezani za 5 tehnologa (Miljan→13, Nikola→43, Aleksandar→77,
  Stefan→181, Dragan→2226); **HITNO** flag (`drawing_handovers.is_urgent`, migracija
  `20260712180000`; postavlja approve, briše return-to-pending; badge svuda + crveni „HITNO" na RN
  štampi); Realizacija: kolona „Radnik" (kucao) + nova „Tehnolog"; dugme „PDF crteža" u detalju
  primopredaje; tab „Na pisanju" + `GET /handovers/writing-stats`.
- **Paket B** (#35): `work_orders.parent_work_order_id` (migracija `20260712200000`; `rework()`
  upisuje, enrich vraća `parentWorkOrder`+`reworkChildren`, filter `?reworkOnly=true`);
  `locations[{positionCode,quantity}]` (neto `part_locations` SUM) u listi RN + kolona Lokacija na
  `/completed-orders`; **NOVI modul `cnc-programs`** + tabela `cnc_programs` (migracija
  `20260712210000`): GET lista pozicija (`usesPriority` RC — 17.0/17.1 CAM Programiranje) + PATCH
  `{isDone,note?}` sa auditom iz JWT-a; nav „CAM programiranje".
- **2.0 sidebar:** stavke „Kucanje (pogon)"/„Kontrola (pogon)" UKLONJENE — ulaz = direktan URL
  `/kiosk` ili 1.0 HUB pločice.
- **E2E simulacija toka na produ 13.07 + bug fix `b064a96`:** native `drawing_handovers.id` kolizija
  sa legacy `work_orders.drawing_handover_id` (nosi ID NACRTA iz tRN, 1..3446, 3349 RN-ova) → launch
  409 na tuđem RN-u; `submit()` sekvenca sada floor `GREATEST(MAX(id), MAX(legacy ref), 9999)` →
  native primopredaje od 10000+ do cutover remapa.
- **Login parnost 1.0→2.0:** svi 1.0 korisnici imaju 2.0 nalog sa ISTOM 1.0 lozinkom (27 update + 31
  insert po SSO JIT mapiranju; backup `users_pwhash_backup_20260713` u prod bazi; servisni nalozi
  netaknuti). +17 biro naloga (Milorad Jerotić=`projektant_vodja`, ostali `inzenjer`, svi
  worker-linked); dejan.cirkovic i jovan.blagojevic nemaju 1.0 nalog → privremena lozinka.
- **Proba runda 1:** `GET /handovers/engineers` (aktivni „Inženjeri"); `designerId` OPCION (default =
  JWT worker; mora AKTIVAN — 422); projektant ComboBox + prefill; **AUTO-BOM** (izbor glavnog sklopa
  automatski izlistava pozicije iz sastavnice; nabavni tiho preskočeni, neodobreni uz upozorenje);
  labela „Predato tehnologu" → **„Predao (projektant)"**.
- **Proba runda 2** (#36): `approve-batch`/`reject-batch` — grupno odobravanje/odbijanje CELE
  primopredaje po broju nacrta (best-effort `{approved, skipped[]}`; legacy paritet
  `spPromeniStatusPrimopredaje`; **lansiranje ostaje pojedinačno**); `GET /tech-processes/worker/open`
  (kiosk „Moji otvoreni", zatvaranje bez ponovnog skeniranja); CAM lista filtrira otkucane CNC
  glodanje/struganje i završnu kontrolu → **549→271** pozicija; dimenzija materijala u RN štampi;
  kvalitet badge Dorada/Škart/„Redovan".
- **PDF gap:** deo odobrenih crteža bez PDF-a (istorija pre pdm-bridge-a) — analiza i plan u
  [design/PDF_GAP_2026-07-13.md](design/PDF_GAP_2026-07-13.md).

### ✅ Checkpoint 2026-07-12 — modul „Tehnologija" praktično završen + BigBit sync otvoren

Od 8.7. do danas (detaljno: [PREOSTALE_FAZE.md](PREOSTALE_FAZE.md) + [MODUL_TEHNOLOGIJA.md](MODUL_TEHNOLOGIJA.md)):
- **Tehnolog tok (P0–P5) živ:** dodela tehnologa pri **odobravanju** primopredaje, „Otkucaj TP" iz
  primopredaje, undo odobrenih, pretraga po tehnologu, notifikacije dorade; RBAC `AUTHZ_ENFORCE=true`.
- **Automatski uvoz PDM XML — ŽIV:** `pdm-bridge` na ubuntu serveru (systemd timer, CIFS mount) →
  `POST /pdm/import`; PDF crtež se ne briše. Usput: hotfix „P2002 sequence bomba" (`alignIdSequence`).
- **1.5 merge:** 2.0 dostupan na `servosync.servoteh.com/tehnologija` (ne više `servosync2`).
- **BigBit → 2.0 sync (nova radna linija):** BB_T_26 snapshot (ceo BigBit ERP, 207 tabela) analiziran;
  **Faza 1 živa** (3 šifarnika artikala → nazivi grupa/porekla), **Faza 2 matične tabele pripremljene
  ali gated do cutover-a** (Magacini živo; customers/projects/items/Cenovnik čekaju). Izvor sync-a
  **izmenjen: ubuntu + `mdb-tools` (drop share), NE XML export** (vidi §Sync B ispod). Alat:
  [`tools/bigbit-bridge/`](../tools/bigbit-bridge/); plan: [migration/BB_T_26_ANALIZA_I_PLAN.md](migration/BB_T_26_ANALIZA_I_PLAN.md).
- **Feedback tehnologije (Miljan, „Komentari V2.0") — Paketi A+B ISPORUČENI 12.07:** 10 komentara
  ukršteno sa kodom ([design/KOMENTARI_TEHNOLOGIJA_2026-07-12_TRIJAZA.md](design/KOMENTARI_TEHNOLOGIJA_2026-07-12_TRIJAZA.md)).
  **Paket A** (ODLUKE #34): tehnolozi vezani na radnike (`users.worker_id`), HITNO flag
  (`is_urgent` + badge/RN-štampa), Radnik/Tehnolog kolone u Realizaciji, PDF crteža iz primopredaje,
  tab „Na pisanju" + `writing-stats`. **Paket B** (ODLUKE #35): poreklo dorada/škart RN-a
  (`work_orders.parent_work_order_id`), lokacija u završenim nalozima, CAM modul (`cnc_programs`,
  ekran „CAM programiranje" sa audit-om). **Paket C (t.4/6b/8) ODLOŽEN za 3.0** — vidi §3.0 dole.
- **Preostalo za 2.0 = kozmetika** (UI dorade, sitni bugfix) — nema više velikih modula.

### Trenutno stanje repo-a (checkpoint 2026-07-08)
- `prisma/schema.prisma`: ~90 modela (**1:1 plosnat port cele BigBit MSSQL šeme**) — vidi [ERD mapu](../../_analiza/servosync-schema.html).
- **Sync: generički map-driven syncer za sve mapirane tabele (62 entiteta)** — **prvi full sync SA SERVERA
  ✅ 8.7.2026: 531.977 redova, 11m33s** (produkcijsko jezgro puno: work_order_operations 214K, tech_processes
  98K, items 92K, work_orders 41K). Ostaje: cron raspored (A.6) + backup (A.4).
- **Auth V1 delimično:** JWT login modul + `JwtAuthGuard` na sync endpointima (`TODO(auth)` zatvoren).
  Nedostaju: refresh rotacija (§7), `/api/v1` verzionisanje, no-op RolesGuard/permisije.
- **Front:** login + Sinhronizacije ekrani na ui-kit-u; dizajn sistem KONAČAN (v1.0, 6.7.2026).
- **🚀 DEPLOY ŽIV (8.7.2026):** backend na ubuntusrv u Docker-u (`servosync-pg` Postgres 18 + `servosync-backend`
  NestJS, `restart: unless-stopped`); front kao **git-povezan Cloudflare Worker** `servosync2`
  (static assets) → **`https://servosync2.servoteh.com`**, **push na `main` = auto-deploy**; API kroz
  **Cloudflare Tunnel** `api.servosync2.servoteh.com` → `server:3000` (Total TLS aktivan za 3. nivo).
  **Login potvrđen kraj-do-kraja** (front→Tunnel→NestJS auth, 401 na loše / token na dobre). Cela procedura:
  [../../frontend/docs/DEPLOY.md](../../frontend/docs/DEPLOY.md).
- **🧩 DOMENSKI MODULI (talasi 0–2 ŽIVI na produkciji, 8.7.2026):** 10 modula kraj-do-kraja (API + ekran)
  na `servosync2.servoteh.com`:
  **Radni nalozi** (lista/filteri/kreiranje/workflow odobri-lansiraj), **Tehnološki postupci** (kartica,
  kritični, performanse), **PDM/Crteži** (rekurzivni BOM/where-used CTE + anti-ciklus), **Proizvodne
  strukture** (radnici/RJ/operacije/tipovi/pristup mašinama), **Komitenti**, **Predmeti**, **Nacrti +
  Primopredaje** (nacrti + stanje odobri/odbij/lansiraj), **Lokacije delova** (ledger uvid), **MRP/Nabavka**
  (potražnja/zalihe/slobodno, uvid). Sve read-putanje kroz **batch-resolve** (orphan-FK pravilo §, obavezno).
  `/api/v1` verzionisanje + audit interceptor + no-op PermissionsGuard aktivni.
- **⏳ TALAS 3 (u izradi, sve na Opus multiagentima):** submit tok primopredaje (nacrt→primopredaja→odobri→
  lansira RN), copy/clone RN (kopiranje stavki, dorada/škart child, bulk-clone predmeta sa koeficijentom),
  lokacije mutacije (unos/prenos/trebovanje — signed-quantity ledger, neto stanje), barkod kiosk za pogon
  (touch UI + 2-barkod prijava rada). Seed `handover_statuses` (0–3) primenjen migracijom 8.7.2026 —
  FK-ovi za submit/approve/launch/„Novi RN" rade. Otvoreno: firmer FK za launch→RN kontekst
  (drawing_handovers nema project_id/quantity — sad heuristika).
- App-owned sloj: `users`, `refresh_tokens`, `audit_log`, `bb_sync_log/state`.

### Plan rada ka aplikaciji 2.0 (ažurirano 2026-07-07)

**Faza A — server (ništa je ne blokira, kreće odmah):**
1. ~~PostgreSQL + backend na ubuntusrv (Docker: `db` + `api`), `prisma migrate deploy`~~ ✅ 8.7.2026
   (`servosync-pg` Postgres 18 + `servosync-backend` NestJS žive, `restart: unless-stopped`).
2. ~~Mrežna provera ka `vasa-SQL:5765`~~ ✅ 6.7.2026 (TCP otvoren, 1.3ms, isti segment).
3. ~~Prvi sync run **sa servera** (`bridge_reader` + full sync)~~ ✅ 8.7.2026 — ALL 62 entiteta,
   **531.977 redova, 11m33s**, manual. Server preuzeo ulogu sync mašine. NB: BigBit-komercijalne master
   tabele stigle prazne iz QBigTehn izvora (`tax_rates`, `warehouses`, `price_list_entries`,
   `goods_documents`, `payment_accounts`, `document_types`…) — verovatno očekivano (dolaze kroz **Sync B**,
   direktan BigBit), ali **potvrditi opseg sa Negovanom/Vasom** da nije propuštena veza.
4. Backup od prvog dana: `pg_dump` cron na drugu lokaciju.
5. ~~**Cloudflare Tunnel za API + repoint fronta**~~ ✅ 8.7.2026 — tunel `servosync2`,
   `api.servosync2.servoteh.com` → `server:3000` (Total TLS), front živ na `servosync2.servoteh.com`,
   login E2E. Svi mutirajući endpointi iza auth guarda; DB port se NE izlaže kroz Tunnel. Vidi
   [../../frontend/docs/DEPLOY.md](../../frontend/docs/DEPLOY.md).
6. Cron sync (`@nestjs/schedule`): noćni full + češći inkrementalni; e-mail/alert na `failed`.

**Faza B — dovršetak auth/RBAC temelja (Luka, paralelno sa A):**
1. Refresh tokeni sa rotacijom (§7 — tabela već postoji; access 24h + refresh 30d).
2. `/api/v1` verzionisanje (`enableVersioning`) — **obavezno pre prvog domenskog endpointa**
   (BACKEND_RULES §5); postojeći `sync/*` i `health` se sele pod `v1`.
3. No-op `RolesGuard` + `@RequirePermission()` + katalog permisija iz
   [RBAC_RLS_PREDLOG.md](design/RBAC_RLS_PREDLOG.md); skelet audit interceptora (§8).
4. **Sastanak Negovan/Nesa (zakazuje Nenad — jedino što kod ne rešava):** 4 odluke §11 +
   6 RBAC pitanja. Kritični put za sve mutacije u modulima.

**Faza C — pilot modul: TEHNOLOGIJA (TP):**
1. **Read-only prvo:** TP lista + master–detalj (postupak, operacije, dokumentacija) — API + ekran.
   Može i PRE §11 odluka jer ništa ne piše; odmah upotrebljivo tehnolozima.
2. RN read-only pregled (isti šablon, mala dodatna cena).
3. Mutacije TP — **tek posle §11.1** (cache/overlay) i potvrde RBAC predloga.

**Faza D — ostali moduli + V2 RBAC:**
1. ~~Redosled: RN → PDM/Crteži → Primopredaje → Lokacije → Strukture → MRP (uvid) → Komitenti (pregled);
   svaki kraj-do-kraja po šablonu iz pilota.~~ ✅ 8.7.2026 — svih 10 modula (talasi 0–2) živo; talas 3
   (submit/copy-clone/lokacije-mutacije/kiosk) u završnici. Multiagentni build (Workflow), read-putanje
   batch-resolve. `handover_statuses` seed primenjen (8.7.2026). Otvoreno: firmer FK za launch→RN kontekst (Luka).
2. V2 RBAC aktivacija (seed rola TEHNOLOG, CNC_PROGRAMER, SEF…) kad su 2–3 modula živa —
   guardovi već postoje kao no-op, pa je to konfiguracija.
3. e2e permission matrica (rola × endpoint) raste uz svaki modul.

**Definicija „imamo aplikaciju 2.0":** server kod nas + noćni sync + login + **TP i RN moduli u
dnevnoj upotrebi**. Sve posle toga je širenje, ne izgradnja.

### Ključne otvorene odluke (blokiraju razvoj — POTVRDITI sa Negovanom)
1. **Šema:** 1:1 plosnato (trenutno) vs **hibrid** (legacy-cache + overlay, preporuka) vs čist kanonski. Vidi [01-architecture §5](migration/01-qbigtehn-architecture-analysis.md).
2. **Sync:** BigBit-wins upsert vs legacy insert-only; delete-propagacija; single-tenant potvrda.
3. **Poslovna logika iz MS SQL-a** (BOM/MRP/RN procedure) — replicirati preko `WITH RECURSIVE` (vidi [05-sqlserver-logic](migration/05-qbigtehn-sqlserver-logic.md)); pažnja na anti-ciklus guard (PG bez njega **visi**).

### Spoljni izvori podataka — RAZJAŠNJENO 2026-07-07 (Nenad)

**Tri odvojena sync-a** (vidi [BACKEND_RULES §3 + §11](BACKEND_RULES.md)):

- **Sync A — QBigTehn MSSQL (`vasa-SQL:5765`): PRIVREMEN.** Proba + jednokratni završni uvoz proizvodnje,
  pa se gasi. ServoSync PG postaje jedini izvor istine za proizvodnju/tehnologiju.
- **Sync B — BigBit matični podaci: TRAJAN do 4.0. ✅ IZVOR REŠEN (Nenad 11.7.2026).** Komitenti, artikli,
  predmeti, prodavci, magacini, cenovnik (+ tarife, grupe/porekla). **Mehanizam: ubuntu server čita BigBit
  `.mdb` `mdb-tools`-om (ignoriše Access ULS, bez lozinke) i piše direktno u PG** — NE XML export, NE preko
  NestJS sync modula (menja stariju §11.2a „export" odluku). BigBit noćni izvoz stiže na SMB drop share
  `\\192.168.64.28\bigbit-incoming`; dnevni `INSERT … ON CONFLICT DO UPDATE`. Alat: [`tools/bigbit-bridge/`](../tools/bigbit-bridge/).
  ID-prostor rešen (opcija A): `items.id` = QBigTehn ključ, BigBit preko `items.external_item_id`
  ([migration/BB_T_26_ANALIZA_I_PLAN.md §7.6](migration/BB_T_26_ANALIZA_I_PLAN.md)).
- **Sync C — PDM (SolidWorks, MS SQL): TRAJAN, jednosmeran.** Sklopovi (BOM), crteži, dokumentacija.
  **Preporuka: XML ugovor (postojeći `POST /pdm/import` + `PDMXMLParser`) uz automatizovan handoff** —
  interna SolidWorks SQL šema je krhka za direktno čitanje BOM-a. Šema već ima `drawing_import_log`.

Detalji Sync-a B (legacy mehanizam koji nasleđuje):

- **Sync A — QBigTehn MSSQL (`vasa-SQL:5765`), privremen.** Trenutni sync (62 entiteta) je **proba +
  jednokratni završni uvoz** proizvodnih podataka. Posle cutover-a se **gasi**, QBigTehn MSSQL se više
  ne koristi, ServoSync PG je jedini izvor istine za proizvodnju/tehnologiju (tehnolog piše direktno).
- **Sync B — BigBit matični podaci, trajan do 4.0.** Komitenti, artikli, predmeti, prodavci (+ tarife,
  grupe, magacini) ostaju read-only cache; BigBit je izvor istine dok se u 4.0 ne apsorbuje.

**Legacy mehanizam** koji Sync B nasleđuje: dugme **„Preuzmi iz BB"** (`RibbonModule.PreuzmiIzBB()`) u
QMegaTeh-u, preko `EXT_*` ODBC linkova, **INSERT-only** (samo novi redovi; bez update-a i brisanja — 4
poznata buga u [ServoSync-specification.md](ServoSync-specification.md)). 2.0 to menja u UPSERT.

**✅ Blokada §11.2a REŠENA (11.7.2026):** pitanje „kako se `bigbit-sync` kači direktno na BigBit kad se
QBigTehn ugasi" je zatvoreno — **ubuntu server čita BigBit Access `.mdb` preko `mdb-tools`** (drop share
sa BigBit noćnog izvoza). Nije potreban ni SQL Server upsizing ni XML ugovor; ULS se zaobilazi na nivou
čitača. Faza 1 (šifarnici) je već živa; matične tabele su pripremljene i čekaju cutover (da ne prepisuju
živi Sync A). Detalji i preostali koraci: [PREOSTALE_FAZE.md](PREOSTALE_FAZE.md).

---

## ServoSync 3.0 — objedinjavanje (1.0 → stack 2.0)

**Cilj:** prebaciti ServoSync 1.0 (Supabase moduli) na **PostgreSQL + NestJS backend + Next.js front** aplikacije 2.0, i sve spojiti u **jednu aplikaciju**. Rezultat: jedan MES koji pokriva i proizvodnju/tehnologiju (iz 2.0) i operativne module (iz 1.0: kadrovska, lokacije, održavanje, sastanci, reversi…).

### Šta se radi (i zašto je najveći obim, vidi [03-planmontaze](migration/03-planmontaze-complexity-profile.md))
- **Frontend:** UI logika 1.0 se prenosi (ostaje na Cloudflare); data-access sloj (83 servisa, ~753 poziva) se **repointuje** sa Supabase REST-a na NestJS API. UI izgled uglavnom preživljava; menja se svaki poziv podataka.
- **Autorizacija (najteži deo):** 293 RLS politike + 238 SECURITY DEFINER funkcije → **NestJS guardovi + eksplicitno query-scoping** (Prisma nema nativni RLS). Bezbednosno kritičan rewrite; model je rola × per-projekat × managed_departments × override flagovi.
- **Poslovna logika u bazi:** transakcioni RPC-ovi (reversi inventar, payroll, loc premeštanja) + 473 RAISE EXCEPTION → NestJS servisi ili `$queryRaw`.
- **Supabase-native supstrat bez drop-in zamene:** GoTrue Auth → NestJS/Passport JWT; Storage → MinIO/S3; Realtime → WS gateway ili LISTEN/NOTIFY; pg_cron/pg_net/Vault → NestJS scheduler + BullMQ/pg-boss + outbox; push (Web Push/FCM/APNs).
- **Podaci:** rešeno **međukorakom** (vidi 1.0) — podaci su već na on-prem PG; NestJS se kači na istu bazu koju služi PostgREST, pa posebne migracije podataka nema.

### Mobilna aplikacija (Capacitor) — kontrolna lista za preradu fronta
Capacitor ljuska i native plugini **preživljavaju** — `server.url` u APK-u pokazuje na web, a javna
adresa ostaje ista (Tunnel odluka), pa **novi APK treba samo ako se adresa promeni**. Prevodi se 5
veza sa Supabase-om, ne aplikacija:
1. **Offline queue** (~424 LOC) — čuva PostgREST putanje i replay-uje ih; prepisati na NestJS ugovor
   uz očuvanje idempotencije (`client_event_uuid`). Najopasnija tačka: greška = tihi duplikati u magacinu.
2. **Auth tok** — GoTrue PKCE/refresh/**passkeys** utkani u `sbReq` → NestJS JWT refresh + WebAuthn iznova.
3. **Push** — FCM v1 / APNs / Web Push VAPID dispatch prelazi sa Supabase edge sloja u NestJS; native plugin ostaje.
4. **Realtime** (`work_hours`) — `postgres_changes` → WS gateway ili LISTEN/NOTIFY.
5. **Service worker / PWA keš** — Workbox regex ima hardkodovane Supabase URL-ove; ažurirati na nove API putanje.

Mobilni UI ekrani (~7.3K LOC `mobile my*`) idu kroz istu preradu kao desktop ekrani — nisu poseban trošak.

### Zahtevi tehnologije (Miljan) koji čekaju 3.0 — Paket C

Tri tačke iz feedback-a tehnologije („Komentari V2.0", trijaža:
[design/KOMENTARI_TEHNOLOGIJA_2026-07-12_TRIJAZA.md](design/KOMENTARI_TEHNOLOGIJA_2026-07-12_TRIJAZA.md))
su **namerno odložene za 3.0** (odluka Nenad 12.07.2026) jer se svaka preseca sa 3.0 poslom —
raditi ih u 2.0 sada značilo bi dupli posao i konflikte sa 3.0 rewrite-om:

- **t.4 — Jedinstvena statusna mapa pozicije kroz ceo tok.** Miljan traži jasan sled statusa:
  *U PROJEKTOVANJU → NA ODOBRENJU VODEĆEG PROJEKTANTA → NA ODOBRENJU ZA PISANJE TEHNOLOGIJE →
  NA PISANJU TEHNOLOGIJE → LANSIRAN U PROIZVODNJU → LANSIRAN A NIJE ZAPOČETA PROIZVODNJA
  (nema materijala…) → U TOKU PROIZVODNJA → ZAVRŠEN I NA NEKOJ LOKACIJI.*
  Pristup: **IZVEDENA (derived) statusna mapa**, ne nova status kolona — spaja postojeće izvore
  (drawing State → nacrt → primopredaja 0/1/2/3 → RN/TP → kucanja → lokacija) u jedan „Tok pozicije"
  ekran. **Zašto 3.0:** mapa preseca ceo lifecycle kroz module koji u 3.0 tek dolaze u isti stack
  (projektni biro/projektovanje iz 1.0) + oslanja se na **integraciju lokacija** (3.0 tema); prvi
  koraci (U PROJEKTOVANJU / odobrenje vodećeg projektanta) žive u PB modulu koji se seli u 3.0.
  Traži zaseban spec kad PB i lokacije budu u istom stack-u.

- **t.6b — Modul „Praćenje i planiranje proizvodnje" + izbaciti „Realizaciju" iz Tehnologije.**
  Miljan traži da se planiranje/praćenje izdvoji kao poseban modul u domenu Proizvodnja, a „Realizacija"
  (kucanja) skloni iz Tehnologije. **Zašto 3.0:** ceo 2.0 postaje jedan modul „Tehnologija" u 3.0 i
  tada se moduli **preraspodeljuju po MES domenima** (isti posao kao HUB restrukturiranje već urađeno
  u 1.0). Praviti novi modul + seliti ekrane sada = dupli rad koji se u 3.0 reorg-u ionako ponavlja.
  U 3.0 se rešava zajedno sa preraspodelom domena Proizvodnja.

- **t.8 — Mobilna „Evidencija radnih naloga" za radnike u proizvodnji/kontroli.** (Pogonski ekrani
  „Kucanje/Kontrola (pogon)" su VEĆ premešteni u 1.0 HUB pločice — ODLUKE #33 nastavak — pa je taj deo
  t.8 gotov.) Preostaje **mobilni pregled/evidencija RN** vidljiv radnicima. **Zašto 3.0:** mobilna
  aplikacija (Capacitor) se u 3.0 prerađuje kao celina (vidi „Mobilna aplikacija" gore — offline queue,
  auth, push, realtime, SW keš); dodavati nov mobilni ekran pre te prerade znači graditi na sloju koji
  se menja. Priprema postoji od 2.0 (čist REST/JWT + telefon-čitljiv RNZ barkod, ODLUKE #18 Faza 2).

Kad 3.0 krene, ove tačke ulaze u odgovarajuće korake sekvence (t.6b uz preraspodelu domena Proizvodnja,
t.4 kad PB+lokacije budu u istom stack-u, t.8 uz mobilnu preradu). **Do tada se NE diraju u 2.0.**

### Sekvenca
Strangler-fig, modul po modul: prvo auth + RBAC parnost, pa jedan modul kraj-do-kraja (npr. Lokacije ili Reversi kao pilot za merenje tempa), pa ostali; Supabase se gasi tek kad poslednji modul pređe.

### Tokom tranzicije 2.0 ↔ 1.0 (pre nego što 3.0 završi) — vidi „Sync tokom tranzicije".

---

## ServoSync 4.0 — integracija BigBit ERP-a (komercijala)

**Cilj:** apsorbovati **BigBit** (trenutno Access/VBA „SERVOTEH 2019/2024", Rev 9.6.1, baza `.MDB` po
poslovnoj godini + eksterni magacin `BB_T_2x.MDB`, komercijalni ERP: glavna knjiga, PDV/POPDV, fakture,
robna dokumenta, magacin, nabavka, uvoz/carina, banke, SEF) u ServoSync 3.0 → **kompletan ERP + MES** na
jednoj platformi.

> **Napomena o tempu (Nenad, 2026-07-07):** 4.0 **nema rok i pokreće se trigerima, ne kalendarom** —
> PDV/knjigovodstvo/fiskalizacija je najrizičniji domen, a BigBit ga danas radi pouzdano. Legitimno
> stabilno stanje je **duži period na 3.0 + BigBit na SQL Server-u** (vidi „Spoljni izvori", Sync B
> varijanta B — usput olakšava i samu 4.0 kad dođe). Trigeri za 4.0: prestanak vendor podrške,
> regulatorne promene (SEF i sl.), ili poslovna potreba za objedinjenim izveštavanjem.

### Šta to znači
- BigBit prestaje da bude eksterni „izvor istine" — njegove funkcije (komitenti, artikli, cenovnik, robna dokumenta, GK, PDV, fakturisanje, nabavka, uvoz, banke, SEF) se **rebuild-uju** u ServoSync domene (`masters`, `tax`, `finance`/GL, `inventory`, `procurement`, `sales`, `sef`, `banking`).
- Ukida se `bigbit-sync` most (iz 2.0) — matični podaci više ne dolaze spolja, nego su izvorni (prelaz je **preimenovanje vlasnika**, ne migracija — do 4.0 su isti podaci već cache/overlay).
- Ovo je efektivno **Faza 3** iz Nesa-ne originalne podele (pun ERP: GK, PDV, AP/AR, obračun) — najveći regulatorni/računovodstveni domen (fiskalizacija RS, SEF eFaktura, PDV/POPDV, KEPU).

### Izvor analize (dva ugla, oba gotova)

4.0 je **već analiziran** iz dva komplementarna ugla — nije potrebna nova „velika" analiza, nego
konsolidacija i potvrde:

1. **Ugao koda (VBA reverse-eng):** [09-bigbit-online-domain-map.md](migration/09-bigbit-online-domain-map.md)
   — 824 komponente OnLine BigBit-a mapirane na 10 domena, sa regulatornim pravilima (§11), procenom
   obima (§12) i **redosledom za 4.0** (§13). Dopune: [06 „Preuzmi iz BB"](migration/06-bigbit-preuzmi-iz-bb.md),
   [07 SEF](migration/07-bigbit-sef-efaktura.md), [10 glavni meni](migration/10-bigbit-glavni-meni.md).
2. **Ugao korisnika (radna uputstva + screenshotovi):** analiza tri zvanična uputstva (Tatjana/knjigovodstvo, jun 2023) —
   [12 master uputstvo](migration/12-bigbit-uputstvo-master.md) (ceo knjigovodstveni ciklus, 20 poglavlja,
   40 screenshotova), [13 Nabavka](migration/13-bigbit-nabavka.md) (RFQ→PO→prijem, 16 screenshotova),
   [14 Carina](migration/14-bigbit-carina.md) (uvoz/izvoz, zavisni troškovi, 9 screenshotova). Ovaj ugao
   daje **stvarne dnevne tokove i ne-sistemske zavisnosti** koje kod ne pokazuje.

### Stvarni poslovni tokovi koje 4.0 mora da reprodukuje (iz korisničkih uputstava)

Ceo komercijalni tok je **dokument-vođen** i vezan kroz polje **Predmet/RN** od ponude do naplate. Šest
glavnih lanaca (detalji + kontni plan u [12](migration/12-bigbit-uputstvo-master.md) §2, §4):

| # | Tok | Lanac dokumenata |
|---|---|---|
| A | **Prodaja robe** | Zahtev za ponudu → PON/profaktura → Predmet(+RN) → Porudžbenica dobavljaču (NARUČIVANJE) → prijem UFROB → **IFR** → SEF → knjiženje (2040) → naplata (IZVOD) |
| B | **Usluga** | (avans → AVR + 4300/4720) → **IFUSL** (RN + *Zapisnik* umesto otpremnice) → ručno knjiženje 2040/4703/6140 → SEF (avans → iznos 0) |
| C | **Gotov proizvod** | Predmet+RN → REZM/REZR (rezervacija) → TREB/TREB1 (**pravilo: trebovanje = 50% vrednosti GP**) → ULGP → **IFGP** (+veza sa avansom) → SEF → knjiženje (klasa 9: 9020/9800) |
| D | **Nabavka/ulaz** | Porudžbenica → faktura (SEF/mail) → nabavka overava (RN+PO, potpis) → razvrstavanje (TROŠ/BPDV/UFROB/UFMAT) → robni Ulaz (proknjiži iz PO) → rezervacija na RN → finansijski nalog |
| E | **Uvoz** | ino faktura + JCI/carina + špediter → Ulaz **UVOZ** + kalkulacija zavisnih troškova (*„preračunaj ponovo"*) → nalog UVOZ (4630/4350/2740/2700/1320 + kursne razlike 5630/6630) → dalja prodaja/lager/rezervacija |
| F | **Mesečni PDV ciklus** | brisanje+reknjiženje auto naloga → provere robno↔finansijski (RuC=0) → USLRO/TREB/ULGP kontrole → **slaganje SEF↔BB** (×16,66667%) → obračun `47 − 27 − 2790` |

**Model dokumenata (vrste):** robno — PON/PROF, OTP, REZR/REZM, NARUČIVANJE, UFROB/UFMAT, UVOZ, TREB/TREB1,
ULGP, IFR/IFUSL/IFGP, AVR, USLRO/USLMA. Finansijski nalozi — isti + TROS, BPDV, IZVOD, RAZNO. **Automatski**
(iz robnog „po šemi"): IFR, IFGP, UFROB/UFMAT, TREB/TREB1, USLRO/USLMA, ULGP. **Ručni:** IFUSL, IZVOD, AVR,
BPDV, TROS, RAZNO, UVOZ. → 4.0: jedan dokument-model sa tipom + **šeme za kontiranje** (posting rules) kao
podatak; kontni plan (klase 1/2/4/5/6/9) je poznat i mapiran u [12](migration/12-bigbit-uputstvo-master.md) §4.4.

### Nabavka (`procurement`) — tok i pravila (iz [13](migration/13-bigbit-nabavka.md))

Danas: `Specifikacija (projektant) → Zahtev ka dobavljaču (RFQ) → Ponuda → Porudžbenica → [Profaktura+avans]
→ Prijem + kontrola → Knjiženje/ulaz → Praćenje`. Statusi RFQ-a su **editabilan šifarnik** (Poslat upit →
Prosleđen inicijatoru → Poručen/Odustali). Pravila koja se prenose (🔴 = ne-pregovarački):

- 🔴 **Odobravanje inicijatora** (projektanta) = gate pre porudžbenice; prihvaćena ponuda mora imati **prilog**.
- 🔴 **Prag Direktora > 1.000 EUR** na predračunima (potpis pre plaćanja); **obavezni watcheri (CC)** na plaćanjima → modelirati kao approvers/notifikacije, ne kao mail.
- 🔴 **3-way match:** Porudžbenica ⇄ Ulazna faktura ⇄ Otpremnica (količina+cena) pre knjiženja; broj PO na fakturi = preduslov knjiženja.
- 🔴 **Avansni tok:** avans se knjiži na avans (ne na dobavljača); za INO obavezni IBAN/SWIFT na proformi; SWIFT potvrda = trigger nastavka isporuke.
- **Parcijalne isporuke** = povezane (parent/child) porudžbenice; rešiti čisto preko „isporučene količine" (ne legacy brisanjem stavki).
- **Šifra Proizvođača vs Dobavljača** (Siemens uvek pod Siemens šifrom, Konvex sa ponude, VITa Elko/Enel → proizvođač) — mapiranje artikal ↔ {proizvođačka, dobavljačke šifre}.
- Auto-numeracija PO (poseban brojač za pneumatiku); roba **na projekat vs na stanje** (izbor po prijemu).

### Carina / uvoz (`customs`) — korigovan scope (iz [14](migration/14-bigbit-carina.md))

**Ključni nalaz koji menja obim:** **carinski obračun (JCI, obračun carine i PDV-a na uvoz) NE radi se u
BigBit-u — radi ga špedicija.** BigBit se koristi samo za **Ino profakturu, normativ (sa tarifnim brojevima)
i izjave** koji se šalju špediciji/carini. Zato `customs` u 4.0 nije pun carinski modul nego:

- **Evidencija carinskog predmeta** (tip: redovan uvoz / privremeni uvoz / **aktivno oplemenjivanje** „UV 5" / redovan izvoz), vezan na Predmet/RN i nabavnu porudžbinu; unos/uvoz **eksternog JCI** (broj, carinarnica, rok zatvaranja, razduženje).
- **Normativ/BOM za carinu** (kataloški + **tarifni broj** + srpski/ino naziv + količina) — spona artikla ka carinskoj tarifi; obavezan **ino naziv artikla** (za dvojezične reporte).
- **Dokaz porekla** (EUR1 / EU statement / tursko poreklo) sa pravilom **praga 6.000 EUR** (ispod → izjava na fakturi; iznad → EUR1 + ulazne fakture).
- 🔴 **Landed cost (zavisni troškovi → nabavna cena):** carina + transport + špedicija + lučki + SWIFT **ulaze** u nabavnu cenu; **PDV NE ulazi** (samo poreska obaveza). Kurs sa JCI-a (stavka 22/23). **⚠️ OTVORENO:** ključ raspodele ZT na artikle (po vrednosti / težini / stavci) **nije dokumentovan** — mora se izvući intervjuom sa referentom (Tatjana) pre implementacije kalkulacije.
- Dokumentacija se danas čuva na `\\SRV\SHARES\Predmeti\godina\kupac` — u 4.0 prilozi vezani direktno za carinski predmet.

### Ne-sistemske zavisnosti koje 4.0 gasi (kritično — iz [12](migration/12-bigbit-uputstvo-master.md)/[13](migration/13-bigbit-nabavka.md))

Deo poslovne logike danas živi **van ERP-a** i mora se digitalizovati:

- 🔴 **„Crvena sveska"** = fizička Knjiga izlaznih faktura (izvor sledećeg broja IFR/IFUSL/IFGP) → **DB sekvence po (vrsta, godina)**.
- 🔴 **Ručni SEF unos + pojedinačna/zbirna evidencija PDV** (kad export iz BB ne prolazi) → **native SEF API** (izlazne/ulazne, kategorije S20/Z, osnov 24-1-5 za BMTS, avansni račun = 0, storno, Sales/Purchase ID).
- **Odluke u mailu i nazivima fajlova** (avans, potpis Direktora, statusi plaćanja) → strukturirana polja/prilozi + approvals + audit.
- **Fizički registratori i potpisi** (Nenad/Nevena) → uloge/odobrenja u sistemu.

### Domeni 4.0 i redosled — odozdo naviše (potvrđeno oba ugla, vidi [09 §13](migration/09-bigbit-online-domain-map.md))

Svaki gornji sloj troši pravila iz donjeg, pa se ide temelj→dokumenti→izveštaji:

1. **Matični podaci + config** (`masters`) — komitenti (ključ PIB, JBKJS, >1 tekući račun), artikli (grupe/porekla, kat. broj + ino naziv), cenovnik (STDCN, kurs po kupcu), magacini, prodavci. U 2.0 su već cache/overlay → prelaz je postupan.
2. **Poreski/knjigovodstveni šifarnici** — 🔴 **poreske stope (effective-dated)**, vrste dokumenata + **šeme za kontiranje** + kontni plan. Feed-uju sve ostalo.
3. **Glavna knjiga / posting engine** (`finance`/GL) — jedan atomski, idempotentan posting servis (konsolidovati automatsko + ručno knjiženje); OS, bilansi/ZR (APR).
4. **Magacin / robna dokumenta** (`inventory`) — kalkulacija, 🔴 prosečna ponderisana cena, nivelacija, popis, komadna evidencija (ploče — Servoteh); hrani KEPU + GK. 🔴 pravilo **Mag.VP = Nab. cena (RuC=0)**.
5. **Fakturisanje** (`sales`) + **SEF outbox/inbox** (`sef`) — najveći domen; naslanja se na tax+GK+inventory; SEF-inbox nosi **auto-prijem ulazne fakture u zalihe** (nije izolovan).
6. **PDV knjige (KIF/KUF/PPPDV) + POPDV** (`tax`) — derivišu iz faktura/GK; 🔴 **POPDV se gradi od nule** (u BigBit-u je eksterna `.mdb`).
7. **Banke / plaćanja** (`banking`) — izvodi (auto 2040/4350, uparivanje po TR), virmani (state machine), 🔴 konformna kamata, MOD97/11; formati → ISO 20022.
8. **Nabavka + Carina/uvoz** (`procurement`/`customs`) — RFQ→PO→prijem (3-way match), landed cost; naslanja se na inventory+sales+banking+SEF.
9. **Kasa / POS + e-fiskalizacija** (ESIR/L-PFR) — **uslovno**, samo ako se koristi; poseban regulatorni sistem (piše se iznova, ne portuje), može paralelno.

### Preduslovi i otvorene odluke (za sastanak Negovan/Nesa)

- 🔴 **Korak 0 — ekstrakcija Access imenovanih upita** (`NSK_*`, `PDV_Uknjizi*`, `ProknjiziUKEPU*`, `Sema za kontiranje`, `CEN_*`, `PREB_*`…) iz `.accdb`/`.mdb`: tamo živi **većina poslovnih pravila** koja NIJE u VBA izvozu. Bez ovoga posting/regulatorni domeni nemaju izvor. Vidi [09 §12 napomenu](migration/09-bigbit-online-domain-map.md).
- **POPDV** — potvrditi gde je logika eksterne `BigBit_APL_2010.mdb` (ili graditi od nule iz poreskih kategorija + PDV totala po stopama).
- **Carina** — ključ raspodele zavisnih troškova na nabavnu cenu (intervju sa referentom uvoza); da li 4.0 interno računa carinu/PDV ili samo evidentira eksterne troškove špedicije.
- **POS/fiskalizacija** — potvrditi da li se uopšte koristi (nije na glavnom meniju BigBit-a → verovatno van osnovnog scope-a).
- **Izveštaji** — trijaža na top ~30 kritičnih (BigBit ima 496 izveštaja / 2.412 upita — ne portuje se sve).

### Šta je već pripremljeno u 2.0 šemi (temelj za 4.0)

Deo komercijalnog skeleta već postoji kao mirror/overlay u [prisma/schema.prisma](../prisma/schema.prisma):
`Customer` (Komitenti), `Item`/`ItemGroup`/`ItemSubgroup`/`ItemOrigin` (artikli), `PriceListEntry` (Cenovnik),
`TaxRate` (R_Tarife), `DocumentType`/`OrderType` (vrste dok./naloga), `GoodsDocument(Item)` +
`GoodsDocument(Item)Mirror` (T_Robna dokumenta/stavke), `PaymentAccount` (UplatniRacuni), `Company`
(Radni_fajlovi), `Warehouse` (Magacini), `Project`/`Salesperson`. U 4.0 ovi prelaze iz **cache → vlasništvo**;
nedostaju domeni GL/posting, PDV knjige/POPDV, SEF outbox/inbox, banking, nabavka i carina (novi entiteti).

---

## Sync tokom tranzicije (privremeni mostovi)

Dok sve ne postane jedna aplikacija (3.0), neki podaci se dele između Supabase (1.0) i on-prem PG (2.0), i QBigTehn/BigBit izvora. Pravila:

- **Jedan izvor istine po tabeli, jednosmerno po tabeli.** „Oba smera" = više jednosmernih tokova, nikad dvosmerno na istim redovima (izbegava konflikt-pakao).
- **Sync worker živi on-prem** i zove Supabase/izvore **odlazno** — on-prem se ne izlaže direktno (jedini ulaz spolja je Cloudflare Tunnel).
- **Postgres↔Postgres je lako** (obe strane PG): opcija A — reuse `bb-sync` framework sa novim `SourceConnector` (Supabase); opcija B — `postgres_fdw`; opcija C — logička replikacija.
- **Primer `workers`:** Supabase `zaposleni` = izvor istine → jednosmerno pull u 2.0 `workers` (read-only cache + overlay za proizvodna polja). Ako 2.0 vraća nešto HR-u (npr. sati) → zaseban push, druga tabela.
- **Stabilan ključ mapiranja** (šifra radnika kao `legacy_*` na obe strane) i **delete/tombstone** strategija su jedini pravi trošak; za matične podatke (stotine redova) je mali.
- **⚠️ Most za 1.0 Lokacije (`loc_*`) — kritičan pri gašenju QBigTehn-a.** 1.0 loc modul **ZAVISI od žive
  QBigTehn baze u OBA smera**: (1) auto-ingest gde je deo na mašini iz **`tTehPostupak`** (preko bridge cache),
  (2) šalje ručne pokrete nazad u QBigTehn (`sp_ApplyLocationEvent`). Pošto 2.0 preuzima proizvodnju kao vlasnik
  (`tTehPostupak → tech_processes`), pri cutover-u QBigTehn-a **1.0 loc ingest se mora repointovati sa QBigTehn
  cache-a na ServoSync `tech_processes`**, a outbound (`sp_ApplyLocationEvent`) se gasi/preusmerava na 2.0. Detalji:
  [MODULE_SPEC_lokacije §8](design/MODULE_SPEC_lokacije.md). **Ne gasiti QBigTehn dok ovaj most nije prebačen.**
- Svaki most ima **„sunset" datum** — umire čim se modul integriše u 3.0.

Detalji i procena: postojeća analiza „Supabase↔PG sync" (dani do par nedelja po mostu, nizak rizik uz disciplinu).

---

## Zavisnosti i sekvenca (zašto ovim redom)

```
1.0 (živ; međukorak → self-host on-prem) ──┐
                       ├─►  3.0 (objedini 1.0 na stack 2.0)  ──►  4.0 (+ BigBit ERP)
2.0 (QBigTehn core) ───┘
        ▲
   BigBit sync (privremeno, do 4.0)
```

1. **2.0 prvo** — temelj/izvor podataka za proizvodnju, gated Negovanom (znanje je vremenski osetljivo usko grlo). Uži je nego što deluje (~44% legacy scope).
2. **3.0 posle 2.0** — treba gotov 2.0 stack (auth, API, domeni) da bi 1.0 moduli imali gde da se presele.
3. **4.0 poslednje** — najveći regulatorni domen; ima smisla tek kad postoji stabilna 3.0 platforma; do tada BigBit ostaje read-only izvor preko mosta.

---

## Rizici po fazi (kratko)

| Faza | Glavni rizik | Ublažavanje |
|---|---|---|
| 2.0 | Negovan = usko grlo domenskog znanja; SP/UDF tela; anti-ciklus u BOM/MRP (PG visi) | Rana ekstrakcija logike (već urađeno, [05](migration/05-qbigtehn-sqlserver-logic.md)); guard u `WITH RECURSIVE`; potvrde sa Negovanom |
| 3.0 | 293 RLS + 238 DEFINER bez drop-in zamene; Supabase-native supstrat | Strangler-fig; pilot modul za merenje; RLS→guard parnost sa test suite-om |
| Tranzicija | Dvosmerni sync konflikti; ID mapiranje | Jedan vlasnik/tabeli; stabilan `legacy_*` ključ; sunset datumi |
| 4.0 | Fiskalizacija/PDV/SEF regulatorni domen | Tek posle stabilne 3.0; posebna analiza BigBit-a (materijal spreman) |

---

*Poslednji update: 2026-07-12 — **modul „Tehnologija" (2.0) praktično završen**: tehnolog tok P0–P5,
auto-uvoz PDM XML (bridge na ubuntu), RBAC enforced, spojen u 1.5 na `servosync.servoteh.com/tehnologija`;
ostaje kozmetika. **Otvorena BigBit → 2.0 sync radna linija** (Faza 1 živa, Faza 2 gated do cutover-a);
izvor Sync-a B rešen = ubuntu + `mdb-tools` (drop share), NE XML — vidi [PREOSTALE_FAZE.md](PREOSTALE_FAZE.md).*

*Ranije 2026-07-08 — **deploy 2.0 živ**: backend on-prem (Docker: Postgres 18 + NestJS) + front kao git-povezan Cloudflare Worker (`servosync2.servoteh.com`, auto-deploy na push na `main`) + API kroz Cloudflare Tunnel (`api.servosync2.servoteh.com`, Total TLS), **login potvrđen kraj-do-kraja** (procedura: [../../frontend/docs/DEPLOY.md](../../frontend/docs/DEPLOY.md)). Takođe: **proširen §4.0** (BigBit apsorpcija) na osnovu analize tri zvanična korisnička uputstva (master/knjigovodstvo, Nabavka, Carina — [migration/12–14](migration/README.md)): stvarni dokument-vođeni tokovi (A–F), nabavka (RFQ→PO→3-way match), korigovan carinski scope (JCI radi špedicija), ne-sistemske zavisnosti, domeni + redosled odozdo-naviše, preduslovi za sastanak. Ranije (2026-07-07): checkpoint stanja (sync 62 entiteta ✅, JWT auth ✅, front ekrani ✅, mreža ka vasa-SQL ✅) + plan rada ka aplikaciji 2.0 (faze A–D); odobren međukorak (1.0 self-host: PostgreSQL + PostgREST + GoTrue), Cloudflare Tunnel umesto WireGuard-a. Implementaciju radi Luka uz potvrde Nesa/Negovan.*

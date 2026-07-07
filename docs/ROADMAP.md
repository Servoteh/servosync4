# ServoSync — Roadmap digitalizacije Servoteha (1.0 → 4.0)

> Autoritativni plan verzija. Cilj: od razdvojenih legacy sistema (Access/VBA BigBit, MS SQL QBigTehn, Supabase plan-montaže) do **jednog ERP + MES rešenja** na sopstvenom serveru.
> **Vizuelni prikaz:** [ROADMAP.html](ROADMAP.html) — otvoriti lokalno u browseru (snapshot 4.7.2026; izvor istine ostaje ovaj fajl).
> Prateće analize: [migration/README.md](migration/README.md) · [00-comparison](migration/00-comparison-qbigtehn-vs-planmontaze.md) · [01-qbigtehn-architecture](migration/01-qbigtehn-architecture-analysis.md) · [02-scope](migration/02-qbigtehn-scope-triage.md) · [03-planmontaze](migration/03-planmontaze-complexity-profile.md) · [05-sqlserver-logic](migration/05-qbigtehn-sqlserver-logic.md).

---

## Pregled na jednom mestu

| Verzija | Šta je | Stack | Status | Rezultat |
|---|---|---|---|---|
| **1.0** | Web moduli koje Nesa razvija (kadrovska, lokacije, održavanje, sastanci, reversi, plan montaže…) | Vite + vanilla JS · **Supabase** (PG cloud) → **self-host on-prem (međukorak)** | **Živ, u produkciji** (razvoj zaključan ~1.5.2026); **međukorak odobren 4.7.2026** | Operativna MES-nadgradnja preko BigTehn-a |
| **2.0** | 1:1 (minimum) prerada **QBigTehn** (Access + MS SQL, Negovanov sistem) — proizvodnja/tehnologija | **NestJS + Prisma + PostgreSQL** on-prem | **Kreće sa Lukom Tasićem** (ovaj repo) | Proizvodni core: RN, TP, PDM/BOM, MRP, primopredaje, lokacije |
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

### Trenutno stanje repo-a (checkpoint 2026-07-07)
- `prisma/schema.prisma`: ~90 modela (**1:1 plosnat port cele BigBit MSSQL šeme**) — vidi [ERD mapu](../../_analiza/servosync-schema.html).
- **Sync: generički map-driven syncer za sve mapirane tabele (62 entiteta, ~520K redova)** — verifikovan
  kod Luke na Docker PG; sledi prelazak na ubuntusrv (mrežni preduslov proveren 6.7: `vasa-SQL:5765` dostupan).
- **Auth V1 delimično:** JWT login modul + `JwtAuthGuard` na sync endpointima (`TODO(auth)` zatvoren).
  Nedostaju: refresh rotacija (§7), `/api/v1` verzionisanje, no-op RolesGuard/permisije.
- **Front:** login + Sinhronizacije ekrani na ui-kit-u; dizajn sistem KONAČAN (v1.0, 6.7.2026).
- App-owned sloj: `users`, `refresh_tokens`, `audit_log`, `bb_sync_log/state`.

### Plan rada ka aplikaciji 2.0 (ažurirano 2026-07-07)

**Faza A — server (ništa je ne blokira, kreće odmah):**
1. PostgreSQL 16 + backend na ubuntusrv (Docker compose: `db` + `api`), `.env` po `.env.example`,
   `prisma migrate deploy`.
2. ~~Mrežna provera ka `vasa-SQL:5765`~~ ✅ 6.7.2026 (TCP otvoren, 1.3ms, isti segment).
3. Prvi sync run **sa servera** (login test `bridge_reader` + full sync) — server preuzima ulogu
   Lukinog laptopa kao sync mašina.
4. Backup od prvog dana: `pg_dump` cron na drugu lokaciju.
5. **Cloudflare Tunnel za API + repoint fronta** — sme tek kad su svi mutirajući endpointi iza
   auth guarda (za sync jeste ✅); DB port se NIKAD ne izlaže kroz Tunnel.
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
1. Redosled: RN → PDM/Crteži → Primopredaje → Lokacije → Strukture → MRP (uvid) → Komitenti (pregled);
   svaki kraj-do-kraja po šablonu iz pilota.
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
- **Sync B — BigBit matični podaci: TRAJAN do 4.0.** Komitenti, artikli, predmeti, prodavci (+ tarife,
  grupe, magacini). **Preferirani izvor: BigBit prelazi na SQL Server** (upsizing na postojeću `vasa-SQL`
  instancu — Vasa voljan; postojeći `mssql` konektor + inkrementalni sync); **plan B: export (XML/CSV) +
  UPSERT**; ručni unos samo kao rezerva. Ne živi ODBC na `.MDB`. Vidi [BACKEND_RULES §11.2a](BACKEND_RULES.md).
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

**⚠️ Otvorena blokada (§11.2a):** danas BigBit podaci stižu iz druge ruke (BigBit → QBigTehn MSSQL →
ServoSync). Kad se QBigTehn ugasi, `bigbit-sync` mora da se kači **direktno na BigBit** — a nije potvrđeno
da li je to BigBit SQL Server, Access `.MDB`, ili export fajl. Bez toga Sync B ostaje bez izvora.

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

### Sekvenca
Strangler-fig, modul po modul: prvo auth + RBAC parnost, pa jedan modul kraj-do-kraja (npr. Lokacije ili Reversi kao pilot za merenje tempa), pa ostali; Supabase se gasi tek kad poslednji modul pređe.

### Tokom tranzicije 2.0 ↔ 1.0 (pre nego što 3.0 završi) — vidi „Sync tokom tranzicije".

---

## ServoSync 4.0 — integracija BigBit ERP-a (komercijala)

**Cilj:** apsorbovati **BigBit** (trenutno Access/VBA + eksterni magacin `BB_T_25.MDB`, komercijalni ERP: glavna knjiga, PDV/POPDV, fakture, robna dokumenta, magacin, banke, SEF) u ServoSync 3.0 → **kompletan ERP + MES** na jednoj platformi.

> **Napomena o tempu (Nenad, 2026-07-07):** 4.0 **nema rok i pokreće se trigerima, ne kalendarom** —
> PDV/knjigovodstvo/fiskalizacija je najrizičniji domen, a BigBit ga danas radi pouzdano. Legitimno
> stabilno stanje je **duži period na 3.0 + BigBit na SQL Server-u** (vidi „Spoljni izvori", Sync B
> varijanta B — usput olakšava i samu 4.0 kad dođe). Trigeri za 4.0: prestanak vendor podrške,
> regulatorne promene (SEF i sl.), ili poslovna potreba za objedinjenim izveštavanjem.

### Šta to znači
- BigBit prestaje da bude eksterni „izvor istine" — njegove funkcije (komitenti, artikli, cenovnik, robna dokumenta, GK, PDV, fakturisanje) se **rebuild-uju** u ServoSync domene (`inventory`, `finance`/GL, `sales`, `procurement`, `sef`).
- Ukida se `bigbit-sync` most (iz 2.0) — podaci više ne dolaze споља, nego su izvorni.
- Ovo je efektivno **Faza 3** iz Nesa-ne originalne podele (pun ERP: GK, PDV, AP/AR, obračun) — najveći regulatorni/računovodstveni domen (fiskalizacija RS, SEF eFaktura).

### Materijal koji već imamo za BigBit (za kasniju analizu i planiranje)
U `BigbitRaznoNenad/` (van gita): `BB_T_25.MDB` (297M, eksterni magacin, 201 tabela, ~88k artikala), `BigBit_APL_2010.MDB`, `OnLine_BigBit_APL.MDB`, `MojaBIgBitBaza.accdb` (241M, 201 tabela), config/workgroup fajlovi. VBA/forme već izvučeni u `_analiza/izvoz/`. → Kad krenemo 4.0, radi se ista analiza kao za QBigTehn (scope-triage + logic-extraction + schema-map).

---

## Sync tokom tranzicije (privremeni mostovi)

Dok sve ne postane jedna aplikacija (3.0), neki podaci se dele između Supabase (1.0) i on-prem PG (2.0), i QBigTehn/BigBit izvora. Pravila:

- **Jedan izvor istine po tabeli, jednosmerno po tabeli.** „Oba smera" = više jednosmernih tokova, nikad dvosmerno na istim redovima (izbegava konflikt-pakao).
- **Sync worker živi on-prem** i zove Supabase/izvore **odlazno** — on-prem se ne izlaže direktno (jedini ulaz spolja je Cloudflare Tunnel).
- **Postgres↔Postgres je lako** (obe strane PG): opcija A — reuse `bb-sync` framework sa novim `SourceConnector` (Supabase); opcija B — `postgres_fdw`; opcija C — logička replikacija.
- **Primer `workers`:** Supabase `zaposleni` = izvor istine → jednosmerno pull u 2.0 `workers` (read-only cache + overlay za proizvodna polja). Ako 2.0 vraća nešto HR-u (npr. sati) → zaseban push, druga tabela.
- **Stabilan ključ mapiranja** (šifra radnika kao `legacy_*` na obe strane) i **delete/tombstone** strategija su jedini pravi trošak; za matične podatke (stotine redova) je mali.
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

*Poslednji update: 2026-07-07 — checkpoint stanja (sync 62 entiteta ✅, JWT auth ✅, front ekrani ✅, mreža ka vasa-SQL ✅) + **plan rada ka aplikaciji 2.0** (faze A–D u sekciji 2.0). Ranije: odobren međukorak (1.0 self-host: PostgreSQL + PostgREST + GoTrue), Cloudflare Tunnel umesto WireGuard-a, mobilna kontrolna lista za 3.0. Implementaciju radi Luka uz potvrde Nesa/Negovan.*

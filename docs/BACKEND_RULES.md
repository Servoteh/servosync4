# ServoSync backend — pravila rada (v0.1)

> **Autoritativna operativna pravila za backend.** Svaki modul, migracija i endpoint — pisao ga Luka, Nesa
> ili AI — mora proći po ovim pravilima.
>
> **Redosled važenja kad se dokumenti ne slažu:**
> 1. ovaj dokument + **postojeći kod** (konvencije koje kod već sprovodi),
> 2. [ROADMAP.md](ROADMAP.md) (šta se gradi i kojim redom),
> 3. Lukin [ARCHITECTURE.md](design/ARCHITECTURE.md) (strateška vizija, maj 2026 — draft).
>
> ARCHITECTURE.md je odličan i dalje važi za sve što ovde nije pokriveno, ali kod je od njegovog pisanja
> **svesno odstupio** na mestima pobrojanim u §2 — ta odstupanja su sada pravilo, ne greška.
>
> **Kako se menja ovaj dokument:** pravilo se menja izmenom ovog fajla, uz zapis u §12. Dok izmena nije
> ovde, ne postoji. Odluke iz §11 (otvorena pitanja) niko ne "presuđuje" u kodu pre potvrde.

---

## 1. Stack (stvarno stanje)

| Sloj | Izbor | Napomena |
|---|---|---|
| Runtime | Node.js 20+ | |
| Framework | **NestJS 11** | moduli u `src/modules/<domen>/` |
| ORM | **Prisma 6.19.3** — verzija zakucana kroz `overrides` u package.json | ne dizati verziju bez dogovora |
| Baza | **PostgreSQL 16** (dev: Docker, port 5435; prod: on-prem Ubuntu server) | |
| Izvor legacy podataka | **QBigTehn MSSQL** (`Vasa-SQL,5765`) preko `mssql` paketa, login `bridge_reader` | strogo read-only |
| Testovi | Jest (`*.spec.ts` uz kod) + supertest e2e u `test/` | |
| Lint/format | ESLint (typeChecked) + Prettier — `npm run lint` mora biti čist | |

**Planirano po ARCHITECTURE.md, još neinstalirano** (dodaje se tek sa modulom koji to koristi, ne unapred):
`class-validator`/`class-transformer` (uz prvi pravi DTO), `@nestjs/schedule` (uz cron sync), Swagger
(`@nestjs/swagger`, uz prvi domenski modul), Passport/JWT (uz auth modul), pino (uz common logging sloj).

## 2. Zvanična odstupanja od ARCHITECTURE.md drafta

Ovde je draft **pregažen stvarnošću koda** — ovo su pravila:

1. **ID-jevi NISU UUID.** Legacy tabele zadržavaju **legacy ključ kao `id`** (npr. `Komitenti.Sifra` → `customers.id Int`).
   Nema surogat `legacy_*` kolone tamo gde je legacy šifra već ključ. App-owned tabele: `Int @default(autoincrement())`.
2. **Statusi/role su `String`, ne Prisma enum** — namerno, da se izbegne migracija za svaku novu vrednost.
   Dozvoljene vrednosti se dokumentuju u `///` komentaru polja. Infra statusi malim slovima
   (`running` / `success` / `partial` / `failed`), role velikim (`ADMIN`, `USER`).
3. **Vremena su `@db.Timestamp(6)`** (bez timezone) — cela šema je tako portovana; ne mešati sa `Timestamptz`
   u novim tabelama bez odluke u §11.
4. **Sync modul se zove `sync`** (`src/modules/sync/`), tabele `bb_sync_log` / `bb_sync_state` — ne
   `bigbit-sync` / `bigbit_sync_log` iz drafta.
5. **Šema je 1:1 plosnat port** cele legacy šeme (~90 modela) sa engleskim imenima — ne "kanonski redizajn"
   iz drafta. Hibrid (cache + overlay) je otvorena odluka (§11.1).

## 3. Baza podataka

### Imenovanje (sprovodi ga postojeća šema)
- DB tabele: `snake_case`, **plural** (`customers`, `work_orders`); DB kolone: `snake_case`.
- Prisma modeli: `PascalCase` **singular** (`Customer`, `WorkOrder`); polja: `camelCase`.
- Constraints **uvek eksplicitno imenovani**: `pk_<table>`, `fk_<table>_<ref>`, `uq_<table>_<cols>`, `idx_<table>_<cols>`.
- Svaki model portovan iz legacy-ja ima `/// Was: <StaroIme>` komentar; pun spisak starih ↔ novih imena je
  **[schema-rename-map.md](schema-rename-map.md) — jedini izvor istine za mapiranje**. Nova tabela iz legacy-ja =
  obavezan novi red u mapi.
- Legacy prefiksi (`BB`, `CFG_`, `MRP_`, `PDM_`, `R_`, `T_`) se **ne prenose** u nova imena.

### Tipovi
- Novac/količine/procenti: `Decimal` — **nikad Float**. Kratki kodovi `VarChar(10–50)`, nazivi `VarChar(255)`,
  slobodan tekst `Text`, strukturirani metadata `Json` (JSONB).
- `entityId` u logovima/auditu je `String` (prima i numeričke i composite ključeve).

### Migracije
- Svaka izmena šeme = `npm run migrate:dev` → nova migracija u `prisma/migrations/`. **Primenjena migracija se
  nikad ne edituje.** Problematičan lokalni DB: `npm run docker:db:fresh` + `npm run setup`.
- Izmena šeme bez ažuriranja rename-mape (ako dira legacy tabelu) ili bez `///` komentara = nepotpun posao.

### Vlasništvo tabela (ključno pravilo iz ROADMAP-a) — RAZJAŠNJENO 2026-07-07 (Nenad)

Dve sasvim različite vrste sync-a, ne mešati:

- **Proizvodne/tehnološke tabele su VLASNIŠTVO ServoSync-a** (`tech_processes`, `work_orders`,
  `operations`, `work_order_operations`, vreme rada, broj operacija, lokacije delova, primopredaje…).
  QBigTehn MSSQL sync (`vasa-SQL:5765`) je **privremen — proba + jednokratni završni uvoz**, pa se
  **GASI**. Od prve stvarne upotrebe tehnolog piše direktno u ove tabele; **nema cache/overlay problema**,
  nema sync-a koji ih prepisuje. (QBigTehn MSSQL se posle cutover-a više ne koristi.)
- **BigBit matični podaci su read-only cache** (`customers`, `projects`, `salespeople`, `items`,
  `warehouses`, `tax_rates`, `item_groups`, `item_subgroups`). BigBit ostaje izvor istine **do 4.0**;
  ove tabele piše samo `bigbit-sync`, aplikacija ih **samo referencira**, ne dopunjuje ih.
  **Cache/overlay pitanje (§11.1) važi SAMO za ovu grupu**, ne za proizvodne tabele.
- App-owned tabele (`users`, `refresh_tokens`, `audit_log`, `bb_sync_log`, `bb_sync_state`) su naše i sync ih ne dira.

## 4. Sync sa QBigTehn/BigBit-om (obrazac je zakucan postojećim kodom)

1. **Jedan `EntitySyncer` po izvornoj tabeli** u `src/modules/sync/syncers/`, implementira interfejs iz
   `sync.types.ts`; `entity` ključ = ime ciljne PG tabele (npr. `customers`). Registruje se u `SyncService`
   konstruktoru.
2. **Strategije:** `incremental` (watermark `PoslednjaIzmena` u JSON kursoru u `bb_sync_state`) ili
   `full_refresh`. Default po syncer-u.
3. **Upsert po legacy ključu** (`Sifra` → `id`), mapiranje kolona **iscrpno** (sve izvorne kolone), helperi
   `num/str/bool/date` za null-safe konverziju.
4. **FK-ovi se razrešavaju unapred** — nepostojeće reference se **null-uju**, red se ne odbacuje zbog toga
   (lookup tabela možda još nije sync-ovana).
5. **Greška na redu = skip + log, nikad pad celog run-a.** Max 20 poruka o greškama po run-u u rezultatu;
   `rowsSkipped` se broji. Run status: `success` / `partial` / `failed`.
6. **Svaki run = red u `bb_sync_log`** (append-only) sa per-entity metadata; kursor napreduje u `bb_sync_state`
   samo posle uspeha tog entiteta.
7. **MSSQL strana: isključivo SELECT**, parametrizovano (`@param`), kolone sa razmacima u `[zagradama]`.
   U MSSQL se **nikada ne piše** — ni "privremeno", ni "samo jedan UPDATE".
8. Paralelni run-ovi su blokirani in-process guard-om; ostaje tako dok je deployment single-instance.
9. Novi entitet za sync: syncer + registracija + red u rename-mapi + red u [SYNC-SETUP.md](../SYNC-SETUP.md) ako
   traži novu dozvolu na izvoru.

## 5. Struktura modula i API

- Svaki domen = NestJS modul u `src/modules/<domen>/`: `<domen>.module.ts`, `<domen>.controller.ts`,
  `<domen>.service.ts`, `dto/`, po potrebi pod-servisi. Fajlovi `kebab-case`.
- Zajednički kod ide u `src/common/` (decorators/filters/interceptors/pipes) — pravi se kad zatreba prvi put,
  po strukturi iz ARCHITECTURE.md §4.
- **REST konvencije** (usvojeno iz ARCHITECTURE.md §9): resursi plural kebab-case (`/work-orders`,
  `/process-routings`); glagoli standardni (GET/POST/PUT/PATCH/DELETE); statusi 200/201/204/400/401/403/404/409/422/500;
  brisanje je **soft delete** gde domen to traži.
- Globalni prefiks je `/api`. **Pre prvog domenskog endpointa uvodi se URI verzionisanje `/api/v1`**
  (Nest `enableVersioning`) — postojeći `sync/*` i `health` endpointi se tada premeštaju pod `v1`.
- **Response envelope** za domenske endpointe: `{ "data": ..., "meta": { ... } }`; greške
  `{ "error": { "code", "message", "details", "trace_id" } }` sa kodovima iz centralnog `ErrorCode` enuma
  (`src/common/error-codes.enum.ts` — pravi se uz prvi domenski modul). Datumi ISO 8601; `Decimal` vrednosti
  kao **stringovi** u JSON-u; paginacija cursor-based za velike liste.

## 6. Validacija i greške

- Globalni `ValidationPipe` + `class-validator` DTO-i za svaki request body — uvodi se uz prvi pravi DTO;
  do tada ručne provere kao u `sync.controller.ts` su prihvatljive samo za interne endpointe.
- Poslovne greške = custom `BusinessException` klase mapirane na 404/409/422 — **500 je rezervisan za
  neočekivane greške** i uvek se loguje sa trace ID.
- Globalni `AllExceptionsFilter` (uz prvi domenski modul) — konzistentan error envelope.

## 7. Auth (V1)

- Tabele su spremne (`users`, `refresh_tokens` sa rotacijom — `tokenHash`, nikad sirovi token u bazi).
- V1: email + lozinka (bcrypt, 12 rundi), JWT access 24h + refresh 30 dana sa rotacijom; jedna aktivna rola
  `ADMIN` (svi korisnici), `USER` postoji u šemi. RBAC je V2 — `@Roles()`/`RolesGuard` se prave kao no-op odmah.
- **Otvoreni dug:** `TODO(auth)` u `sync.controller.ts` — `POST /sync/run` mora dobiti ADMIN guard čim auth
  modul postoji. Svaki novi mutirajući endpoint pre auth modula dobija isti TODO marker.

## 8. Logging i audit

- App log: NestJS `Logger` po klasi (postojeći obrazac); struktuirani pino se uvodi sa common slojem — ne mešati
  `console.log`.
- **Audit:** svaka mutirajuća operacija domenskih modula upisuje u `audit_log` (append-only; `beforeData`/`afterData`
  JSON; `actorUsername` denormalizovan namerno). Implementacija kroz interceptor kad krene prvi domenski modul.
- `bb_sync_log` je audit sync-a i ne meša se sa `audit_log`.

## 9. Testovi i kvalitet

- Unit: `*.spec.ts` pored koda (Jest `rootDir: src`); cilj 80%+ na service sloju domenskih modula.
- Integration/e2e: `test/` sa supertest-om protiv test DB-a (odvojen Docker volume).
- Syncer bez testa mapiranja (bar: null-ovanje FK, konverzije tipova, kursor napredovanje) = nezavršen.
- `npm run lint` čist; `no-floating-promises` upozorenja se tretiraju kao greške u review-u (svaki `async` poziv
  se `await`-uje ili eksplicitno obrađuje).
- Git: **Conventional Commits** (`feat(sync): ...`, `fix(prisma): ...`); scope = ime modula.

## 10. Jezik i okruženje

- **Kod, komentari, imena, commit poruke: engleski. Dokumentacija u `docs/`: srpski.** (Postojeća praksa.)
- Legacy fajlovi (`legacy/`, `ServoSync-specification.md`) ostaju na srpskom — opisuju izvorni sistem, ne diraju se.
- Env promenljive: `SCREAMING_SNAKE`, grupisane prefiksom (`BIGBIT_DB_*`). **Nova env promenljiva bez reda u
  `.env.example` ne postoji.** Tajne se ne komituju (`.env` je van gita).
- Setup na novoj mašini: `npm run bootstrap` (vidi [README](../README.md)) — taj put mora uvek raditi; ko ga
  pokvari, popravlja ga odmah.

## 11. Otvorene odluke — BLOKIRAJU, potvrda sa Negovanom/Nesom

Niko (ni AI sesija) ne implementira ove stvari pre zapisane odluke ovde:

1. **Cache/overlay mehanizam — SAMO za BigBit matične tabele.** Razjašnjeno 2026-07-07 (§3): proizvodne
   tabele su ServoSync vlasništvo (nema pitanja), a QBigTehn MSSQL sync se gasi posle cutover-a. Otvoreno
   ostaje samo: kako se drže lokalni dodaci na ~8 BigBit cache tabela (`customers`/`items`/`projects`…) —
   ako ikad zatreba lokalno polje na njima (npr. proizvodni atribut artikla), ide u overlay tabelu, ne u
   cache. Vidi [01-qbigtehn-architecture-analysis §5](migration/01-qbigtehn-architecture-analysis.md).
2. **BigBit sync semantika:**
   a) **Konekcija posle gašenja QBigTehn-a (NOVO, blokira `bigbit-sync`):** danas BigBit podaci stižu
      iz druge ruke (BigBit → QBigTehn MSSQL → ServoSync). Kad QBigTehn nestane, na šta se `bigbit-sync`
      kači direktno — BigBit SQL Server (spec [MODULE_SPEC_bigbit_sync §1](design/MODULE_SPEC_bigbit_sync.md))
      ili Access `.MDB` (ROADMAP opis) ili export fajl? Bez odgovora Sync B nema izvor.
   b) BigBit-wins **UPSERT** vs legacy insert-only (legacy `PreuzmiIzBB` je INSERT-only, vidi
      [ServoSync-specification.md](../ServoSync-specification.md)); propagacija brisanja (tombstone?);
      PIB drift / šifra prodavca=0 popravke; potvrda single-tenant.
3. **Poslovna logika iz MS SQL procedura** (BOM/MRP/RN): replikacija kroz `WITH RECURSIVE` — **obavezan
   anti-ciklus guard** (PG bez njega visi na cikličnim BOM podacima; vidi
   [05-qbigtehn-sqlserver-logic](migration/05-qbigtehn-sqlserver-logic.md)).
4. **Timestamp politika za nove app-owned tabele** (`Timestamp(6)` kao legacy port vs `Timestamptz`).

## 12. Promene ovog dokumenta

| Verzija | Datum | Šta |
|---|---|---|
| 0.1 | 2026-07-04 | Prva verzija — kodifikovana stvarna praksa iz koda + usvojene konvencije iz ARCHITECTURE.md drafta; popisana odstupanja (§2) i otvorene odluke (§11). |
| 0.2 | 2026-07-07 | Razjašnjeno vlasništvo tabela (§3, Nenad): proizvodne tabele = ServoSync vlasništvo (QBigTehn MSSQL sync je privremen, gasi se); cache/overlay (§11.1) suženo samo na BigBit matične podatke. §11.2 dopunjen novom blokadom: kako se `bigbit-sync` kači na BigBit posle gašenja QBigTehn-a. |

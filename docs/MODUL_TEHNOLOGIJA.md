# ServoSync 2.0 — Modul „Tehnologija" (master dokumentacija)

> **Šta je ovo:** iscrpna, kod-verifikovana dokumentacija celog modula Tehnologija (ServoSync 2.0) —
> šta radi, kako radi, koje rute/modeli/tokovi postoje, kako je deployovan, i šta je isporučeno kroz
> talase P0–P4 + dorade + audit. Publika: novi developer, vlasnik (Nenad), budući integrator u 3.0.
>
> **Nastanak:** generisano 2026-07-11 iz STVARNOG koda (5 paralelnih kod-čitača + sinteza). Autoritativni
> izvor ostaje kod; ovaj dokument je mapa. Za dublje odluke vidi `docs/design/` (PLAN_*, P4_SPEC_*,
> AUDIT_*, MODULE_SPEC_*) i `docs/migration/17-cutover-runbook.md`.
>
> **Kontekst:** 2.0 je 1:1 prerada QBigTehn proizvodnog jezgra (Access + MS SQL); u 3.0 ceo 2.0 postaje
> jedan modul „Tehnologija". Nazivi ekrana/dugmadi su namerno preuzeti iz QBigTehn-a (RN, TP, primopredaja,
> nacrt, kucanje). Živi na `servosync.servoteh.com/tehnologija`.

## Sadržaj

1. [Pregled, arhitektura, deploy, uloge i permisije](#deo-1--pregled-arhitektura-deploy-uloge-i-permisije)
2. [PDM / Crteži: katalog, BOM, XML/PDF uvoz, bridge, štampa](#deo-2--pdm--crtezi)
3. [Nacrti i Primopredaje: tok tehnologa](#deo-3--nacrti-i-primopredaje)
4. [Radni nalozi, Tehnološki postupak, Realizacija (kucanje), Kontrola, Kiosk](#deo-4--radni-nalozi-i-tp)
5. [Strukture, Notifikacije, Sync/Cutover, Istorijat, Otvorene odluke](#deo-5--strukture-notifikacije-sync-istorijat)

---

<a id="deo-1--pregled-arhitektura-deploy-uloge-i-permisije"></a>
# DEO 1 — Pregled, arhitektura, deploy, uloge i permisije

## Šta je modul Tehnologija

Modul „Tehnologija" je **ServoSync 2.0** — prerada proizvodnog jezgra (core) legacy sistema
**QBigTehn** na moderan stack (NestJS + Prisma + PostgreSQL na backendu, Next.js na frontu). Pokriva
put jednog dela kroz proizvodnju: od crteža/BOM-a (PDM) i primopredaje nacrta, preko pisanja
tehnološkog postupka (TP) i operacija, do radnog naloga (RN), kucanja/prijave rada na pogonu, kontrole
i evidencije lokacija napravljenih delova.

**Glavni tok jednom rečenicom:** projektni biro preda nacrt → tehnolog napiše TP sa operacijama → šef
odobri i lansira RN → pogon (kiosk) skenira barkod i prijavi rad → kontrolor validira → deo dobije
lokaciju.

**Ko ga koristi:**

| Uloga (osoba) | Šta radi u modulu |
|---|---|
| Miljan (šef tehnologije/proizvodnje) | odobrava i lansira RN, piše strukture i plan proizvodnje |
| Tehnolozi | autor i potpis TP; operacije, dokumentacija, šifarnici |
| CNC programeri | TP sa fokusom na CNC programe |
| Projektni biro (inženjer / projektant vođa) | kreira i uređuje nacrte primopredaje pre cutover-a |
| Kontrolori | primopredaje, dorada/škart, finalna kontrola završenog TP, kucanje prijema kooperacije |
| Pogon / kiosk (proizvodni radnik) | skenira RN barkod, START/STOP prijava rada na svojim mašinama |

> Napomena za 3.0: ceo današnji 2.0 postaje **jedan modul „Tehnologija"** unutar objedinjenog
> ServoSync 3.0 stack-a; nazivi ekrana i dugmadi namerno prate QBigTehn (RN, TP, primopredaja, nacrt,
> kucanje) radi prepoznatljivosti kod korisnika.

---

## Arhitektura

### Backend (NestJS)

NestJS **11** (`@nestjs/core ^11.0.1`), paket `servosync-api`. Root modul
`src/app.module.ts` registruje 12 domenskih modula + infrastrukturne module i jedan globalni
interceptor:

- **ConfigModule** (globalan), **PrismaModule** (DB pristup), **AuthzModule** (RBAC — guard + scope).
- Globalni `AuditInterceptor` (`APP_INTERCEPTOR`) — svaka mutacija ide u `audit_log`
  (BACKEND_RULES §8), `app.module.ts:44`.

Domenski moduli (svaki iz `src/modules/`, sa svrhom u jednoj rečenici):

| Modul | Prefiks rute | Svrha |
|---|---|---|
| `auth` | `/api/auth` | Prijava, JWT (`@nestjs/jwt`, 7d), `GET /auth/me/permissions`, SSO handoff `POST /auth/sso`. |
| `sync` | `/api/sync` | Privremeni uvoz iz QBigTehn MSSQL u PG keš (po-entitetski „synceri"); gasi se na cutover-u. |
| `tech-processes` | `/api/v1/tech-processes` | TP i operacije, kartica dela, kritični, dnevnik proizvodnje (A-4 sesije), barkod kucanje/`finish`. |
| `work-orders` | `/api/v1/work-orders` | Radni nalozi (RN): numeracija + štampa RN dokumenta sa per-operacija barkodom. |
| `lookups` | `/api/v1/lookups` | Lookup/šifarnik liste za forme. |
| `structures` | `/api/v1/structures/*` | Proizvodne strukture — 5 šifarnika: radnici, radne jedinice, operacije, vrste poslova, matrica radnik × mašina (`machine-access`). |
| `pdm` | `/api/v1/pdm` | PDM crteži/BOM + nativni XML/PDF intake (import). |
| `directory` | `/api/v1/directory` | Šifarnici komitenti/predmeti (read). |
| `handovers` | `/api/v1/handovers` + `/api/v1/handover-drafts` | Nacrti + Primopredaje: CRUD nacrta, approve/reject/launch primopredaje, spojena PDF štampa crteža. |
| `part-locations` | `/api/v1/part-locations` + `/positions` | Lokacije napravljenih delova (ledger sa predznakom + neto stanje) + pozicije/police. |
| `mrp` | `/api/v1/mrp` | MRP / Nabavka — READ-ONLY uvid u v1 (BOM eksplozija/planiranje čekaju dizajn). |
| `notifications` | `/api/v1/notifications` | In-app notifikacije (inbox/unread/mark-read) + `notifyWorkers()` kao jedina write tačka za domenske emit-ove. |

Pored njih, **`documents`** je zajednički (shared) modul — nije direktno u `app.module.ts`, već ga
uvozi `work-orders`: `BarcodeService` (Code 128 SVG, bwip-js) + `PdfService` (pdfmake) za štampu RN
dokumenta, nalepnica i kartica.

**Globalna konfiguracija (`src/main.ts`):** globalni prefiks `api`, URI-versioning sa
`defaultVersion: VERSION_NEUTRAL`. Domenski kontroleri nose `version: "1"` → rute su
`/api/v1/...`; `auth` i `sync` su version-neutral → ostaju na `/api/auth` i `/api/sync`. CORS je
`origin: true, credentials: true`.

### Prisma / PostgreSQL

Prisma **6.19.3** (`prisma` + `@prisma/client`) nad PostgreSQL 18. Šema se menja **isključivo kroz
Prisma migracije** (`prisma migrate deploy`) — nikad ručnim DDL-om na produ (BACKEND_RULES §3).

### Frontend (Next.js)

Next.js **16.2.10** + React **19.2.4**, konfigurisan kao **statički export**
(`next.config.*`: `output: "export"`, `images.unoptimized: true`) → čist `out/` bez Workers
runtime-a. Zajednički **ui-kit** (`frontend/src/components/ui-kit/`): `app-shell`, `button`,
`combo-box`, `data-table`, `dialog`, `empty-state`, `form-field`, `page-header`, `pager`,
`search-box`, `status-badge`. Rute (`frontend/src/app/`): `tech-processes`, `work-orders`,
`handovers`, `pdm`, `structures`, `part-locations`, `mrp`, `customers`, `projects`, `kiosk`,
`reversi`, `operations-queue`, `production-log`, `session-analytics`, `syncs`, `completed-orders`.

### Konvencije koje moraš znati

**1. Envelope `{ data, meta }` / `{ error }`.** Domenski endpointi vraćaju uspeh kao
`{ "data": ..., "meta": { ... } }`; paginacija je standardni `meta.pagination` blok
(`src/common/pagination.ts` — `pageMeta(page, pageSize, total)`), npr.
`tech-processes.service.ts:343` vraća `{ data, meta: pageMeta(...) }`. Za greške BACKEND_RULES §5/§6
propisuju `{ "error": { code, message, details, trace_id } }` sa kodovima iz centralnog `ErrorCode`
enum-a i globalnim `AllExceptionsFilter`. **Stanje u kodu:** taj error-envelope i enum još **nisu
implementirani** (`src/common/error-codes.enum.ts` i `AllExceptionsFilter` ne postoje); trenutno se
bacaju Nest-ove ugrađene `HttpException` klase sa srpskim porukama (`BadRequestException` → 400 itd.,
npr. `tech-processes/barcode.ts:64`), pa je error-oblik zasad Nest-ov podrazumevani `{ statusCode,
message, error }`.

**2. Batch-resolve umesto obaveznog JOIN-a.** Legacy 1:1 podaci imaju „orphan" FK-ove (npr.
`worker_id = 0` bez radnika 0). Prisma `include`/`select` nad **obaveznom** relacijom baca
`Inconsistent query result: Field is required...` → **500**. Zato se FK-ovi razrešavaju zasebnim
upitima i mapiraju (null ako fali). Helperi su u `src/common/relations.ts`: `byId(rows)` (mapa po
id-u) i `uniqueIds(ids)` (jedinstveni pozitivni id-jevi za `WHERE id IN (...)`, izbaci 0/null).

**3. `alignIdSequence` (db-sequences).** Sync/import upisuju eksplicitne legacy id-jeve, pa bi
autoincrement kolidirao. `src/common/db-sequences.ts` poravnava identity sekvencu sa `MAX(id)` pre
inserta, **obavezno 3-arg `setval`** sa `is_called = EXISTS(rows)` — na praznoj tabeli sledeći
`nextval` = 1 (stari 2-arg `setval(seq, 0)` puca SQLSTATE 22003 → 500 na svežoj bazi). Argument
`table` je uvek literal iz koda, nikad korisnički unos.

---

## Deploy i infrastruktura

Referenca: `backend/docs/infra/INFRASTRUKTURA.md` (verifikovano 2026-07-08).

### Ubuntu server (on-prem)

- `192.168.64.28`, alias **`ubuntusrv`** (SSH nalog `admnenad`, u `sudo` grupi). Ubuntu 24.04 LTS,
  Docker.
- **Prod baza:** Docker kontejner **`servosync-pg`** (`postgres:18`) — nije nativni servis. Port
  **5435** na hostu → `5432` u kontejneru, dostupan sa celog LAN-a. Baza/user `servosync`/`servosync`.
  Prod lozinka ≠ dev (`servosync_dev` je samo za lokalni docker-compose).
- **Backend API** sluša na `localhost:3000`.

### Auto-deploy (push na `main`)

Backend se deploy-uje automatski preko **GitHub Actions self-hosted runner-a koji živi NA serveru**
(outbound-only; ništa se ne izlaže spolja):

```
push main → GitHub Actions runner (na serveru)
          → rsync source u ~/servosync/backend
          → docker compose build backend
          → docker compose run --rm backend npx prisma migrate deploy   (idempotentno)
          → docker compose up -d backend
          → health check: curl localhost:3000/api
```

Docs-only push se ignoriše (paths filter `src/**`). Isti workflow ugrađuje frontend `out/` u backend
image (LAN front — vidi dole).

### Cloudflare (javni pristup)

| Deo | Javni hostname | Put |
|---|---|---|
| Front | `servosync2.servoteh.com` | Cloudflare Workers, projekat `servosync2` (git-povezan auto-deploy) |
| Backend API | `api.servosync2.servoteh.com` | Cloudflare Tunnel `servosync2` → `localhost:3000` na serveru |

Zona `servoteh.com` je na Cloudflare nalogu `nenad.jarakovic@servoteh.com`. Nula direktno izloženih
portova na internet — sve javno ide kroz Cloudflare; na LAN-u su portovi 5435/3000/22 otvoreni jer je
mreža interna.

### LAN front na :3000 (isti origin, offline fallback)

Kad Cloudflare/internet padne, backend može da servira i sam front (Next static export) na svom portu
— **isti origin, bez CORS-a i bez drugog kontejnera**. Uključuje ga env `FRONTEND_STATIC_DIR`; u CI
deploy-u se `out/` **baked** u backend image na `/app/frontend-static`, pa svaki push na `main` osveži
i LAN front. Logika je u `src/main.ts` (clean-URL rewrite `/login` → `/login.html` pre
`express.static`; front runtime-resolve API na istom hostu:portu). Zamka (iz memorije konteksta):
prazan `frontend/out` override maskira baked front → 404.

### „1.5" spajanje na 1.0 shell

2.0 je **ŽIVO na produ od 10.07.2026** ugrađen kao **iframe modul** u ServoSync 1.0 shell:
`servosync.servoteh.com` → HUB kartica „📐 Tehnologija" → ruta `/tehnologija` → iframe ka
`https://servosync2.servoteh.com` (ceo naš front). SSO je postMessage handoff — korisnik se loguje
jednom u 1.0, ulazi bez kucanja ako ima **aktivan 2.0 nalog sa istim email-om**; backend proverava 1.0
GoTrue JWT (`SY15_JWT_SECRET`) u `auth.service.ts` → `ssoLogin()` i potpiše naš token. Role/permisije
ostaju naše (`users.role`). Detalji: `backend/docs/SSO_TEHNOLOGIJA.md`.

---

## Uloge i permisije (RBAC)

Izvor istine: `src/common/authz/` — `roles.ts` (katalog uloga), `permissions.ts` (katalog permisija),
`role-permissions.ts` (mapa uloga → permisije), `permissions.guard.ts` (guard) i `scope.service.ts`
(row-scope).

### Katalog uloga

Ključ role je **lowercase snake_case** (odluka 2026-07-08). Princip: **uloga ≠ radno mesto** (titula
bravar/monter živi u sistematizaciji, ne ovde). Uloge imaju „tier" aktivacije: `v1` (samo `admin`),
`v2` (aktivne sa proizvodnim jezgrom 2.0), `3.0` (ime rezervisano), `deferred` (čeka svoj modul),
`prelazno`. Aktivne u 2.0 su `v1 + v2`.

### Katalog permisija (`permissions.ts`)

Ključ = `modul.akcija`: `tehnologija.{read,write,approve,report_work}`, `rn.{read,write,approve,launch}`,
`pdm.{read,import}`, `strukture.{read,write}`, `primopredaje.{read,write,approve}`,
`lokacije.{read,write}`, `mrp.read`, `directory.read`, `sync.{run,read}`. Frontend zrcali iste
string-vrednosti u `frontend/src/lib/permissions.ts` (+ `reversi.*` za 3.0 pilot).

### Matrica uloga × ključne permisije (`role-permissions.ts`)

Legenda: `R`=read, `W`=write, `A`=approve, `rw`=report_work, `L`=launch, `I`=import; `—`=nema.

| Uloga | tehnologija | rn | pdm | strukture | primopredaje | lokacije | mrp | directory | sync |
|---|---|---|---|---|---|---|---|---|---|
| `admin` | sve | sve | sve | sve | sve | sve | R | R | run+read |
| `sef` | R W A rw | R W A L | R I | R W | R W A | R W | R | R | R |
| `tehnolog` | R W A rw | R W A L | R | R W | R W | R | R | R | — |
| `cnc_programer` | R W A rw | R | R | R | R | R | R | R | — |
| `kontrolor` | R A rw | R | R | R | R W | R | — | R | — |
| `magacioner` | R | R | R | R | R | R W | R | R | — |
| `proizvodni_radnik` | R rw | R | — | R (own) | — | R | — | — | — |
| `nabavka_view` | R | R | R | — | — | — | R | R | — |
| `menadzment` | R A | R W | R | R W | R W | R W | R | R | R |
| `inzenjer` (biro) | R | R | R | — | R W | — | — | R | — |
| `projektant_vodja` (biro) | R | R | R | — | R W | — | — | R | — |
| `viewer` | R | R | R | — | — | — | — | R | — |

Sitnice koje se lako promaše (sve iz koda):
- `kontrolor` ima `tehnologija.approve` + `report_work`, **ali NE `tehnologija.write`** — validira
  završen TP finalnom kontrolom i kuca prijem kooperacije/kiosk, bez punog uređivanja TP-a
  (`role-permissions.ts:94`).
- `tehnolog`/`menadzment` dobili `strukture.write` odlukom Nenada 10.07.2026 (ranije samo admin/sef).
- `menadzment` **nema** `primopredaje.approve` — finalno odobrenje ide per-user override
  (`finalni_potpisnik`) ili sef/admin, ne blanket menadžmentu.
- biro role `inzenjer`/`projektant_vodja` su u katalogu tier „3.0", ali imaju **ranu** 2.0 aktivaciju
  (`primopredaje.write`) da bi projektanti radili u 2.0 pre cutover-a — bez toga bi na produ dobili 403.

### Dvoslojna autorizacija (rola = MOGUĆNOST, flag = OVLAŠĆENJE)

Autorizacija ima **dva sloja koja se OBA proveravaju**:

1. **Rola → permisija (capability).** `PermissionsGuard` proverava da li korisnikova rola u mapi
   sadrži deklarisanu permisiju. Bez nje guard odbija **pre** servisa.
2. **Worker flag (ovlašćenje).** Za osetljive akcije servis dodatno proverava flag na `Worker`
   zapisu: `rn.launch` traži `Worker.definesLaunch = true`, `rn.approve` traži
   `Worker.definesApproval = true`. Dakle akcija pada i sa validnom permisijom ako fali flag
   (`role-permissions.ts:9-16`, `63-65`).

Per-user izuzeci idu kroz `UserPermissionOverride` (prioritet **deny > grant > rola**) — guard ih mora
konsultovati posle rola-sloja (planirano uz `user_roles` podatke).

### Guard i enforcement (`permissions.guard.ts`)

`@RequirePermission(...)` dekorator (`require-permission.decorator.ts`) obeleži endpoint; guard čita
metapodatak i poziva `roleHasPermission(user.role, required)`. Ponašanje kontroliše env
**`AUTHZ_ENFORCE`**:

- `false` (default) → **SHADOW MODE**: izračuna odluku, loguje „would-deny", ali **propušta**.
- `true` → **ENFORCE**: nedostatak permisije = **403**. Rollback = flip env + restart (bez deploy-a).

**Na produ je `AUTHZ_ENFORCE=true` ŽIVO** (postavljeno u `backend.env`; rollback = obriši red +
`compose up`). Zato mapa iz `role-permissions.ts` mora tačno pokrivati svaku ulogu — inače korisnik
dobije 403 na sve. `normaliseRole()` radi `lower(role)` (odbrana od legacy „ADMIN"/„USER" vrednosti,
da aktivacija guarda ne zaključa admina).

### Row-scope (`scope.service.ts`) — uvek uključen

Za razliku od guarda (shadow-able), `ScopeService` **uvek** filtrira rezultate upita. Trenutno je
jedina ograničena uloga `proizvodni_radnik`: vidi samo TP na svojim radnim centrima
(`machine_access`), prazan skup = ne vidi ništa (fail-closed). Sve ostale već read-ovlašćene role
(`admin`/`sef`/`tehnolog`/`cnc_programer`/`kontrolor`/`menadzment`/`magacioner`) vide pun modul.
`workerMachineViolation()` je „unseeded-safe": radnik bez ijednog `machine_access` reda tretira se kao
neograničen (da nepotpuni podaci ne blokiraju pogon). Isti predikati će u 3.0 postati RLS politike
(`app_*` funkcije) — jedan izvor istine.

### Frontend `Can()`

Front koristi isti izvor: `GET /auth/me/permissions` vraća `permissionsForRoles([role])`
(`auth.controller.ts:58`). Komponenta `<Can permission="strukture.write">…</Can>` i hook `useCan()`
(`frontend/src/lib/can.tsx`) skrivaju UI afordanse (fail-closed dok se permisije učitavaju). To je
**samo UX**, ne bezbednosna granica — granica je backend guard.

### Kriterijum „tehnolog"

Za notifikacije, take-over i validaciju TP-a, „tehnolog" **nije** rola već proizvodni radnik:
**aktivan `Worker` čija `worker_types.name` odgovara `'Tehnolog'` (case-insensitive,
`mode: "insensitive"`)**. Matching je po **imenu**, ne po hard-kodovanom id-u, da reseed lookup tabele
i dalje radi; svi tipovi koji se poklapaju se uključuju. Izvor istine je
`src/common/workers/technologist-criteria.ts` (`TECHNOLOGIST_TYPE_NAME = "Tehnolog"`,
`resolveTechnologistTypeIds`, `technologistWorkerWhere`, `resolveTechnologistWorkerIds`). Bitno:
`defines_approval` **nije** deo ovog kriterijuma — to je zaseban RN approve/launch gate.


---

<a id="deo-2--pdm--crtezi"></a>
# DEO 2 — PDM / Crteži

## 2. PDM / Crteži: katalog, BOM, XML/PDF uvoz, bridge, štampa

PDM (Projektna dokumentacija / „crteži") je READ-ONLY katalog crteža izveden iz
QBigTehn legacy tabela `PDM*`, plus nativni intake koji na cutover-u zamenjuje
legacy 10-min skripte. Kod živi u `src/modules/pdm/` (controller + dva servisa +
čist XML parser), a operativni deo u `tools/pdm-bridge/` (isporuka fajlova sa
share-ova) i `tools/cutover-verify/` (verifikacija pariteta pri cutover-u).

Sav kod pod `pdm/` je vezan za NestJS modul `PdmModule`
(`src/modules/pdm/pdm.module.ts`): `imports: [PrismaModule]`, controller
`PdmController`, provajderi `PdmService` (read) i `PdmImportService` (write/intake).

---

## 2.1 PDM katalog crteža — modeli i read rute

### Modeli (prisma/schema.prisma, blok „DRAWINGS (was PDM*)")

Svi modeli su legacy tabele: ključ je `id` (Int autoincrement), i svaki nosi
`/// Was: <legacy ime>` komentar (BACKEND_RULES §1). Tabele su snake_case plural.

| Model | Tabela | `/// Was:` | schema.prisma |
|---|---|---|---|
| `Drawing` | `drawings` | `PDMCrtezi` (central drawing master) | :246 |
| `DrawingComponent` | `drawing_components` | `KomponentePDMCrteza` | :234 |
| `DrawingPdf` | `drawing_pdfs` | `PDM_PDFCrtezi` | :302 |
| `DrawingImportLog` | `drawing_import_log` | `PDMXMLImportLog` | :289 |
| `DrawingStatus` | `drawing_statuses` | `StatusiCrteza` | :376 |
| `DrawingAssembly` | `drawing_assemblies` | `SklopoviPDMCrteza` | :364 |

**`Drawing`** (`drawings`) — matična tabela crteža. Ključna polja:

| Polje | Tip / kolona | Značenje |
|---|---|---|
| `id` | Int PK | legacy `IDCrtez` |
| `externalId` | VarChar(20) `external_id` | PDM interni id (`document/@pdmweid`) |
| `drawingNumber` | VarChar(20) `drawing_number` | broj crteža (`document/@id`); string, ume nenumerički |
| `revision` | VarChar(3) `revision`, default `"A"` | revizija |
| `catalogNumber` | VarChar(50) `catalog_number` | Bb kataloški broj |
| `name` | VarChar(255) `name` | naziv |
| `material` | VarChar(255)? | materijal |
| `dimensions` | VarChar(255)? | dimenzije |
| `marking` | VarChar(20) `marking` | Oznaka (osnov za `isProcurement`) |
| `weight` | Float? | težina (paritet: `""`→0, nenumerički→−1) |
| `isProcurement` | Boolean, default false | kupovni deo (nabavka) vs proizveden |
| `pdmStatus` | VarChar(20) `pdm_status` | PDM `State` (npr. „Odobreno") |
| `statusId` | Int, default 0 `status_id` | FK ka `drawing_statuses` |
| `designedBy` / `approvedBy` | VarChar(50)? | projektant / odobrio |
| `designDate` / `approvedDate` | Timestamp? | best-effort parsirani datumi |
| `fileName` | VarChar(500)? | ime izvornog fajla (`Name` atribut) |
| `workOrderRef` | VarChar(20)? `work_order_ref` | RN referenca |
| `projectName` | VarChar(255)? `project_name` | naziv projekta |
| `createdAt` | Timestamp? | vreme prvog upisa (UPDATE ga ne dira) |
| `signature` | VarChar(50)? | ko je uvezao (email) |

Uniqueness: `@@unique([drawingNumber, revision])` (`uq_drawings_drawing_number_revision`,
schema.prisma:284) — (broj, revizija) je poslovni ključ svuda u intake toku.

**`DrawingComponent`** (`drawing_components`) — jedna BOM ivica: `parentDrawingId`
→ `childDrawingId` sa `requiredQuantity` (Int, default 1). Sve FK relacije su
`onDelete: NoAction, onUpdate: NoAction` (legacy meke reference). BOM se gradi
**isključivo** nad ovom tabelom (~12.426 redova u sync-u).

**`DrawingPdf`** (`drawing_pdfs`) — binarni PDF crteža. **Kompozitni PK
`@@id([drawingNumber, revision])`** (`pk_drawing_pdfs`), bez FK ka `drawings` —
PDF sme postojati bez crteža. Kolone: `pdfBinary` (Bytes, bytea), `fileName`,
`sizeKb`, `uploadedAt`, `uploadedBy`. Napomena širine: `drawing_number` je ovde
VarChar(100), `revision` VarChar(10) — šire nego u `drawings`.

**`DrawingStatus`** (`drawing_statuses`) — šifarnik statusa (`id`, `name`).
Napomena orphan FK: `Drawing.statusId` je default 0, a red 0 u `drawing_statuses`
ne mora postojati — zato se status NIKAD ne učitava kroz `include`, već
batch-resolve (`resolveStatuses`, pdm.service.ts:608).

**`DrawingAssembly`** (`drawing_assemblies`) — postoji u šemi (paritet legacy
`SklopoviPDMCrteza`), ali je u sync-u **PRAZNA i namerno se ignoriše**: semantika
tabele nije razjašnjena (MODULE_SPEC_pdm Q1), BOM koristi samo `drawing_components`
(vidi komentar pdm.service.ts:96-98).

### Read rute (PdmController)

Kontroler: `@Controller({ path: "pdm", version: "1" })`, klasni guard
`@UseGuards(JwtAuthGuard, PermissionsGuard)` + klasna permisija
`@RequirePermission(PERMISSIONS.PDM_READ)` (pdm.controller.ts:49-51). Permisije:
`pdm.read` (permissions.ts:21) i `pdm.import` (:22). `PermissionsGuard` koristi
`getAllAndOverride([handler, class])` pa metodna permisija pobeđuje klasnu — zato
import rute traže `PDM_IMPORT` iako je klasa `PDM_READ`.

| Metoda | Ruta | Permisija | Šta radi |
|---|---|---|---|
| GET | `/api/v1/pdm/drawings` | `pdm.read` | Lista crteža, paginirana; filteri `q`, `revision`, `material`, `designedBy`, `statusId`, `isProcurement` |
| GET | `/api/v1/pdm/drawings/:id` | `pdm.read` | Detalj crteža + status + PDF metapodaci + poslednjih 5 import logova + broj komponenti / where-used |
| GET | `/api/v1/pdm/drawings/:id/pdf/content` | `pdm.read` | Stream PDF-a iz `drawing_pdfs`; `?download=true` → attachment, inače inline |
| GET | `/api/v1/pdm/drawings/:id/bom` | `pdm.read` | Rekurzivna sastavnica; `?depth=1..20`, `?expandAll=true` (samo flat) |
| GET | `/api/v1/pdm/drawings/:id/where-used` | `pdm.read` | Obrnuta sastavnica; `?recursive=true` → tranzitivni parent-i |
| GET | `/api/v1/pdm/import-log` | `pdm.read` | Istorija uvoza; `?success=`, `?isCritical=` |
| GET | `/api/v1/pdm/lookups` | `pdm.read` | Statusi + distinct materijali + distinct projektanti (za UI filtere) |
| POST | `/api/v1/pdm/import` | `pdm.import` | Nativni XML uvoz (multipart `file` + `sourcePath?`) — vidi §2.2 |
| POST | `/api/v1/pdm/pdf-import` | `pdm.import` | PDF uvoz (multipart `file` + `drawingNumber?`/`revision?`/`sourcePath?`) — vidi §2.3 |

Sve read rute vraćaju envelope `{ data, meta }` (liste) odn. `{ data }` (detalj).

**Lista** (`listDrawings`, pdm.service.ts:110): `q` pretražuje po `drawingNumber` /
`catalogNumber` / `name` (contains, case-insensitive); ostali filteri su exact
(revision) ili contains; `isProcurement` prima `"true"`/`"false"`. Sortiranje:
`createdAt desc nulls last`, pa `id desc`. Status se batch-razrešava posle upita.

**Detalj** (`findDrawing`, :187): pored kolona crteža vraća `status`, `pdf`
(metapodaci bez binarnog sadržaja — raw upit sa `pdf_binary IS NOT NULL AS
has_binary` da se blob NIKAD ne učita), `importLog` (poslednjih 5; **heuristika**
`fileName startsWith drawingNumber` jer log nema FK ka crtežu — XML fajlovi su
imenovani po broju, npr. `1086951_B.xml`), `componentCount`, `whereUsedCount`.

**PDF stream** (`pdfContent` u controller-u + `getPdfContent`, :255): učitava
`drawing_pdfs.pdf_binary` po (broj, revizija); 404 ako crtež ne postoji ili nema
binarnog sadržaja. Ime fajla sa dijakriticima se šalje dvojno: ASCII fallback u
`filename=` + RFC 5987 `filename*=UTF-8''…` (Node `setHeader` odbija znakove van
latin1 → inače 500).

### BOM — rekurzivni CTE + anti-ciklus guard

`bom(id, query)` (pdm.service.ts:291) gradi sastavnicu preko WITH RECURSIVE nad
`drawing_components` (`queryDescendants`, :371). Guard je OBAVEZAN
(BACKEND_RULES §11.4) i sastoji se od tri sloja:

- **`path` array** — `ARRAY[parent, child]`, u rekurziji `path || child`;
- **`is_cycle` flag** — `child_drawing_id = ANY(b.path)`; grana sa ciklusom se
  seče (`WHERE NOT b.is_cycle`), označava i **ne ulazi u flat agregat**;
- **tvrdi limit dubine** `MAX_BOM_DEPTH = 20` (pdm.service.ts:12), u WHERE
  `b.depth < ${maxDepth}`.

Količine se množe kroz nivoe u **bigint** (`total_quantity`) da množenje ne
prekorači int4. `?depth` se klampuje na 1..20 (`clampDepth`, :572, default 20);
`?expandAll=true` preskače gradnju ugnježdenog stabla i vraća samo flat listu.

Odgovor: `{ data: { drawing, tree, flat }, meta: { depth, expandAll,
componentRows, cyclesDetected, truncated } }`. `tree` je ugnježdeno (čvor po CTE
redu, ključ = `path.join(">")`), `flat` je agregirano po crtežu
(`totalQuantity`, `occurrences`, `minDepth`), sortirano po broju crteža.
`truncated` (`isTruncatedAtDepth`, :579) proverava da li listovi max nivoa još
imaju decu (stablo presečeno na dubini).

### Where-used — obrnuta sastavnica

`whereUsed(id, query)` (:414) koristi isti CTE naopako (JOIN
`dc.child_drawing_id = u.parent_drawing_id`), isti anti-ciklus guard. Default
samo direktni parent-i (`maxDepth=1`); `?recursive=true` → tranzitivni
(`maxDepth=20`). Agregacija po parent crtežu; svaki red nosi `isDirect`
(`minDepth===1`) i `isTopLevel` (parent se nigde ne pojavljuje kao child —
`findNonTopLevel`, :620). `totalQuantity` = proizvod količina duž putanje,
sumirano po parent-u.

### Lookups

`lookups()` (:540) vraća `{ statuses, materials, designers }`: svi
`drawing_statuses`, distinct ne-prazni `material`, distinct ne-prazni
`designedBy` — za popunjavanje UI filtera.

---

## 2.2 Nativni XML uvoz — `POST /pdm/import`

Nativni intake (P4 cutover) zamenjuje legacy 10-min skripte + Access
`UveziPDM_XMLFajl`. Poslovni ugovor: **poslovna greška → HTTP 200 +
`success:false`** (bridge i UI čitaju flag); `400` samo bez fajla / pogrešan tip;
`413` preko multer limita (10 MB, pdm.controller.ts:66).

### Parser (`pdm-xml-parser.ts`) — čist, bez Nest importa

Parser je izdvojen i testabilan (`parseImportXml(xml: string)`), koristi biblioteku
`xmldoc`. Kontrakt je POTVRĐEN na stvarnom fajlu (uzorak
`_analiza/pdm-xml-primeri/1126982_B.xml`, PLAN_primopredaja §2.8):

- **UTF-8 BEZ XML deklaracije i BEZ BOM-a** — pozivalac dekodira
  `buffer.toString("utf8")` eksplicitno; eventualni BOM (U+FEFF) se defanzivno
  skida u servisu (pdm-import.service.ts:149-150) jer bi sax pukao na njemu.
- Root mora biti `<xml>`; `<transactions>` → `<transaction>` filtrirani po
  `type="wf_export_document_attributes"` (trim + case-insensitive,
  parser :193-196). Nema takve transakcije → `PdmXmlStructureError`.
- `transaction/@date` = epoch sekundi → `Date`; nevalidan/odsutan → `null`.
- Rekurzivno `<document>` / `<configuration>` / `<attribute name value/>` +
  `<references>` (`walkDocument`, :212).
- **Imena atributa SA RAZMACIMA** („Approved by", „Reference Count") čitaju se kao
  obični Record ključevi.
- `document/@id` (broj crteža) je **uvek string** — ume biti nenumerički (K00693,
  EGE2).
- `State` mešano ODOBRENO/Odobreno → poređenje trim + lowercase.
  `APPROVED_PDM_STATES = { "odobreno", "izmena bez revizije" }` (:77) — JEDAN izvor
  istine za „crtež je odobren" (isti skup koristi i preduslov stavke nacrta
  primopredaje).
- **Revizija prazna → `"A"`** (`normalizeRevision`, :93). Vrednosti sa ugrađenim
  newline (npr. `ZiliS="S&#xA;"`) → sve vrednosti se trim-uju.
- Težina (`parseWeight`, :99): `""`→0, nenumerički→−1 (legacy `IsNumeric`).
- Količina (`parseQuantity`, :107): `round("Reference Count")`, min 1, nevalidno→1.
- Datumi (`parsePdmDate`, :133): best-effort, formati viđeni u ISTOM fajlu —
  `10.07.2026`, `7.6.2024.` (`d.M.yyyy` sa završnom tačkom), `24-Nov-23`,
  `7/15/2025` (`M/d/yyyy`); preliv (npr. 31.02.) se odbacuje; **NIKAD ne baca
  izuzetak**, neuspeh → `null`.
- NABAVKA (`isProcurementMarking`, :169): paritet legacy `Like "*[!0-9]*"` —
  `Oznaka` sadrži BILO KOJI ne-cifra znak → kupovni deo. Atribut `MakeOrBuy` je
  nepouzdan i **namerno se ignoriše** (§2.8, potvrda Negovan).

**Validacija — SVE-ILI-NIŠTA (`validateParsedFile`, :265)**, paritet legacy
`ProveriXMLFajl` (PDM_Common.bas l.603+): jedna greška = ceo fajl odbijen, ništa
se ne upisuje. Proverava po dokumentu:

1. obavezno (posle trim): `docId`, `Oznaka`, `Reference Count`;
2. `State` ∈ approved skup (case-insensitive);
3. dužine: `docId ≤ 20`, `Oznaka ≤ 20`, `Revision ≤ 3` (širine kolona `drawings`
   — bez ove provere revizija bi se tiho sekla `clipRequired`-om pa dve različite
   revizije sa istim prefiksom pale na uq constraint kao 500 umesto poruke);
4. **„četvrti uslov"** — duplikati po `(Oznaka, Revision normalizovan,
   parentRowIndex)`. Opseg roditelja je **POJAVA** (`parentRowIndex`), ne docId:
   isti deo dva puta u ISTOM `<references>` bloku = greška; ponovljeno CELO
   podstablo pod drugim roditeljem je legalno (stvarni fajl K16725 sa decom pod 6
   roditelja — legacy ga uspešno uvozi).

Strukturni problem (nevalidan XML, pogrešan root, bez transakcije/redova) →
`PdmXmlStructureError` (poslovna greška, ne 500).

### Tok upisa (`importXml` + `runUpsert`, pdm-import.service.ts)

1. Nema fajla → `BadRequestException` (400).
2. `decodeOriginalName` (:87) sanira mojibake: multer/busboy latin1-dekodira
   `originalname` bez UTF-8 flag-a, pa se š/đ/č re-dekodira latin1→utf8 (čist
   ASCII i već ispravan UTF-8 prolaze netaknuti; nevalidna sekvenca zadržava sirovo
   ime). `filePath` = `sourcePath` (od bridge-a) ili `upload:<email>`.
3. Parse → `PdmXmlStructureError` → `failXml` (200, `success:false`, **kritičan**
   log). Validacija → greške → `failXml`.
4. **Root dedup** (paritet `UveziPDM_XMLFajl` l.100-105): ako root (broj,
   revizija) već postoji u `drawings` → **CEO FAJL SKIP**, uspešan **ne-kritičan**
   log, `skippedExisting:true`.
5. `runUpsert` u **JEDNOJ transakciji po fajlu** (`timeout: 120_000`,
   `maxWait: 10_000`); log ide VAN transakcije.
6. `P2002` u transakciji = konkurentan uvoz ISTOG novog fajla (bridge run + ručni
   upload; root dedup je van transakcije) → tretira se kao „već postoji", ne 500.
   Ostala neočekivana greška → kritičan log + `throw` (500, BACKEND_RULES §6).

**`runUpsert` (redosled, :262):**

- `alignIdSequence(tx, "drawings")` + `alignIdSequence(tx, "drawing_components")`
  **PRE upisa**. Razlog (viđeno uživo 11.07): sync puni tabele EKSPLICITNIM legacy
  id-jevima, pa autoincrement bez poravnanja kolidira (P2002 → 500) na prvom
  nativnom insert-u.
- (1) dedup dokumenata po `(docId, revizija)` — prva pojava nosi atribute;
- (2)+(3) upsert po dokumentu: UPDATE **ne dira `createdAt`**, CREATE ga postavlja
  na `now`;
- (4) **§6.6 delete/recreate BOM-a** samo za dokumente koji su u OVOM fajlu
  roditelji (`hasReferences`) — listovi ne diraju postojeći BOM;
- (6) insert ivica — **dedup po `(parentDocId, docId, revizija)`** jer se celo
  podstablo ponavlja pod svakim roditeljem (prva pojava nosi količinu);
  nerazrešiv par → `errors[]` bez aborta reda;
- (5) **relink starih revizija** (port `ZameniIDCrtezaStareRevizijeUKomponentama`
  l.786+): za svaki upserted crtež nađi starije revizije istog broja i prevezi
  BOM ivice sa njih na novu reviziju (uz brisanje duplikata); matching revizija
  svuda normalizovan prazan→"A" (svesna ispravka legacy nedoslednosti).

**Mapiranje atributa → kolone (`drawingData`, :404)** — paritet
`UpisiPDMSklopoveUTabeluCrtezi`:

| Kolona `drawings` | Izvor (PDM atribut) | Napomena |
|---|---|---|
| `externalId` | `document/@pdmweid` | clip 20 |
| `drawingNumber` | `document/@id` | — |
| `revision` | `Revision` (norm. prazan→A) | clip 3 |
| `catalogNumber` | `Bb_Kataloski_broj` | clip 50 |
| `name` | `Naziv` (prazno → „NEMA PODATAK") | clip 255 |
| `material` / `dimensions` | `Materijal` / `Dimenzije` | clip 255 |
| `marking` | `Oznaka` | clip 20 |
| `weight` | `Weight` | `""`→0, nenum.→−1 |
| `pdmStatus` | `State` | clip 20 |
| `designedBy` / `approvedBy` | `DesignBy` / `Approved by` | clip 50 |
| `designDate` / `approvedDate` | `DesignDate` / `ApprovedDate` | best-effort |
| `workOrderRef` | `RN` | clip 20 |
| `fileName` | `Name` | clip 500 |
| `projectName` | `Naziv_projekta` | clip 255 |
| `comment` / `whereUsed` | `Comment` / `WhereUsed` | clip 255 |
| `signature` | `user.email` | ko je uvezao |
| `statusId` | `0` | fiksno |
| `isProcurement` | `Oznaka` sadrži ne-cifru | — |

> NABAVKA flag se izračunava i upisuje, ali se **NE upisuje u artikle** — to je
> otvorena odluka (BACKEND_RULES §11.1).

**Odgovor:** `{ data: { importId, fileName, success, statusMessage, stats } }`,
gde `stats` (`PdmImportStats`) nosi `documentsInFile`, `drawingsCreated/Updated/
Skipped`, `bomEdgesCreated`, `oldRevisionRelinks`, `skippedExisting`, `errors[]`.
`importId` je id reda u `drawing_import_log`.

### Log (`writeLog`, :565)

Red se upisuje VAN transakcije, UVEK (i za PDF, prefiks `"PDF: "` u
`statusMessage`). Kolone su generičke: `fileName`, `filePath`, `success`,
`statusMessage` (VarChar(1000), spojeni razlozi se seku da upis nikad ne pukne),
`isCritical`. `alignIdSequence(prisma, "drawing_import_log")` pre svakog upisa —
ista P2002 bomba (prod 500, 11.07).

---

## 2.3 PDF uvoz — `POST /pdm/pdf-import`

`importPdf` (pdm-import.service.ts:459). Multer limit 50 MB
(pdm.controller.ts:83). Tok:

1. Nema fajla → 400.
2. **Magic bytes**: `file.buffer.subarray(0,5) === "%PDF-"` (:473); inače 400 —
   sadržaj mora biti PDF bez obzira na ekstenziju/mimetype.
3. **Ključ (broj, revizija)** iz imena fajla (`parsePdfFileName`, :54):
   `{Broj}_{Rev}.pdf` — sufiks posle POSLEDNJEG `_` sa 1-3 znaka = revizija; inače
   ceo naziv = broj, revizija `"A"`. Eksplicitna form polja
   (`drawingNumber`/`revision`) imaju PREDNOST nad imenom.
4. Dužinski guardovi: broj ≤ 100, revizija ≤ 10 (širine `drawing_pdfs`).
5. **Upsert u `drawing_pdfs`** po kompozitnom ključu `(drawingNumber, revision)`;
   `pdfBinary` je `new Uint8Array(file.buffer)` (Prisma 6 Bytes traži
   ArrayBuffer-backed Uint8Array).
6. **Crtež NE MORA postojati** — PDF sme stići pre XML-a (paritet legacy
   `PDM_PDFCrtezi`); u odgovoru `drawingExists` (informativno) i `replaced`
   (da li je postojeći PDF prepisan).

Odgovor: `{ data: { importId, fileName, success, statusMessage, drawingNumber,
revision, sizeKb, replaced, drawingExists } }`. `success:true` je ugovor koji
bridge (`data.success === true`) i UI (`!r.success`) ZAHTEVAJU — bez njega bi se
svaki uspešan PDF uvoz tretirao kao odbijen.

---

## 2.4 pdm-bridge (P4c) — isporuka sa share-ova

`tools/pdm-bridge/pdm-bridge.mjs` — zero-dependency Node skripta (built-in
`fetch`/`FormData`/`Blob` + `node:fs`/`node:crypto`/`node:path`), Node ≥ 20.6
(preporuka 22 LTS). **Single-shot**: jedan prolaz pa izlaz — periodiku daje
raspoređivač (Task Scheduler / systemd timer), ne rezidentni servis.

### Kako radi

- **Faze redom: XML pa PDF** (`phases`, :112). XML →
  `POST {API_BASE}/v1/pdm/import`, PDF → `POST {API_BASE}/v1/pdm/pdf-import`
  (`API_BASE` sadrži `/api`, npr. `http://192.168.64.28:3000/api`). Login na
  početku svakog run-a: `POST {API_BASE}/auth/login` → `accessToken`.
- **Pasivni mod (`PDM_BRIDGE_MODE=passive`, default, OBAVEZAN dok legacy živi):**
  fajlove NIKAD ne pomera ni ne briše — legacy 10-min skripte i dalje vlasnički
  nose foldere. Duplikat-slanje sprečava lokalni state.
- **Aktivni mod (`active`, TEK na cutover):** posle DEFINITIVNOG odgovora fajl se
  premešta — `success:true` → `Importovano\`, odbijeno → `Neuspelo\` (paritet
  legacy `PremestiXMLFile`; kolizija imena → sufiks `_yyyyMMdd_HHmmss`).
  Privremene greške (mreža/5xx) se NE premeštaju.
- **sha256 state dedup (`pdm-bridge.state.json`):** ključ = puna putanja →
  `{ size, mtimeMs, sha256, sentAt, result, statusMessage, transient? }`. Isti
  `(size, mtime)` settled zapisa → skip bez čitanja; isti `sha256` → skip (osveži
  otisak); **izmenjen sadržaj (novi re-export) → šalje ponovo**. Poslovno odbijen
  fajl (`success:false`) se za isti sadržaj NE šalje ponovo (isti bi opet pao).
  State se snima atomično (tmp + rename) posle SVAKOG fajla; zapisi za nestale
  fajlove se čiste na kraju run-a, ali samo pod folderima koji su ovaj run
  uspešno skenirani (offline share ne sme obrisati svoju polovinu state-a).
- **Coexistence sa legacy 10-min skriptama:** u pasivnom modu obe skripte gledaju
  iste foldere; fajl koji legacy skloni između skena i slanja daje `ENOENT` koji
  bridge tretira kao normalan `„nestao tokom run-a"` (skip, ne greška).
- **Auth greška prekida ceo run:** ponovljen `401` (posle jednog re-login-a) ili
  `403` → `AuthError` → **exit 2**, i NIJEDAN fajl se ne settle-uje u state
  (`sendWithRetry`, :309) — auth ishod nije svojstvo sadržaja fajla; kasnija
  dodela permisije mora sve ponovo poslati.

**Retry (`sendWithRetry`):** mreža/5xx → do 3 pokušaja (backoff 2s/8s/30s), pa
`transient` neuspeh (sledeći run ponavlja); `401` → jedan re-login pa ponovi
fajl; ostali 4xx → definitivan neuspeh za taj fajl (run nastavlja); `2xx` →
`data.success` odlučuje.

**Exit kodovi:** `0` OK · `1` bar jedan fajl pao / folder nedostupan · `2`
login/permisija (403 bez `pdm.import`) · `3` konfiguracija neispravna.

**Smoke test** (`node pdm-bridge.mjs --smoke`): dry-run nad generisanim fixture
folderom, lažni transport, bez mreže/baze/`.env`. 7 prolaza pokrivaju: sve se
šalje → dedup → touch bez izmene → izmenjen sadržaj → aktivni mod premeštanje →
403 prekid bez settle-a → `sendWithRetry` nad stvarnim oblikom PDF odgovora.

### Kako je pušten (11.07)

Bridge je u pogon pušten na **Ubuntu serveru** (`ubuntusrv`, 192.168.64.28), NE na
Windows mašini, kao kontejnerizovan single-shot:

- **systemd timer na 5 min** (paritet P4 kadence uz legacy 10-min skripte)
  pokreće `docker run` sa `node:22` slikom koja izvršava `pdm-bridge.mjs`.
- Share-ovi su montirani na host kao **CIFS**, `read-only`:
  `//192.168.64.14/PDMExport/XML` → `PDM_BRIDGE_XML_DIR` i
  `//192.168.64.26/VASADATA` → `PDM_BRIDGE_PDF_DIR`, sa
  `sec=ntlmssp`, nalog `Bojan.PDM`, `ro`.
- Servisni nalog za API je **`pdm-bridge@servoteh.com`** sa rolom **`sef`** —
  minimalna ne-admin rola koja nosi `pdm.import` (`admin` i `sef`;
  role-permissions.ts:40-43). ⚠️ Namenska mini-rola samo `pdm.import` + `pdm.read`
  je otvorena odluka (P4_SPEC §8 #10), NIJE implementirana.

> **`ro` mount = de facto pasivni mod.** Pošto su oba CIFS mounta read-only,
> premeštanje u aktivnom modu bi ionako palo — `moveProcessed` (:450) hvata grešku
> upisa i ostavlja fajl na mestu uz WARN, a state čuva idempotenciju. Zato bridge
> na ovoj postavci radi pasivno i oslanja se isključivo na sha256 state dedup.

**PDF lifecycle napomena.** Legacy sweep-uje samo XML folder (fajlovi se sele u
`Importovano`/`Neuspelo`), dok se PDF share (`VASADATA`) **ne prazni** — PDF-ovi se
akumuliraju. U kombinaciji sa `ro` mount-om to znači: PDF-ove niko ne uklanja niti
ih bridge pomera, pa je jedini garant protiv ponovnog slanja **state dedup po
sadržaju** (sha256). Backend je i inače idempotentan (PDF = upsert po (broj,
revizija)), pa reset state fajla samo pravi nepotreban saobraćaj, ne duplikate.

### Instalacione skripte (Windows varijanta)

Za klasičnu Windows postavku (Task Scheduler) folder nosi tri PowerShell skripte
(PS 5.1 kompatibilne, ništa se ne provizionira daljinski):

| Skripta | Uloga |
|---|---|
| `smoke-check.ps1` | Pre-flight BEZ slanja fajla: Node ≥ 20.6; `.env` kompletan + `mode=passive`; vidljivost share-ova; upisivost foldera; `GET /health` (baza „up"); login; **proba `pdm.import`** — `POST /v1/pdm/import` bez `file` → očekivano 400 („Nedostaje XML fajl", guard prošao, log red se NE piše); 403 = rola nema permisiju |
| `install-task.ps1` | Registruje task `„ServoSync PDM Bridge"` (`Register-ScheduledTask`): action `node --env-file=.env pdm-bridge.mjs` + `WorkingDirectory` (rešava schtasks „Start in" problem), trigger svakih N min (default 5), `Do not start a new instance`, stop posle 1h, `Run whether user is logged on or not`. Lozinku unosi ČOVEK interaktivno (nigde se ne čuva). Idempotentno (`-Force`). Traži admin + `Log on as a batch job` (greška `0x80070569`) |
| `uninstall-task.ps1` | Rollback: `-DisableOnly` pauzira task, bez parametra ga uklanja. Bezbedno u pasivnom modu (ništa nije pomereno); state fajl se namerno ZADRŽAVA |

`.env.example` nabraja sve promenljive (`PDM_BRIDGE_API_BASE`, `_EMAIL`,
`_PASSWORD`, `_XML_DIR`, `_PDF_DIR`, `_MODE`, `_IMPORTED_DIR`, `_FAILED_DIR`,
`_MIN_AGE_S` default 30, `_MAX_MB` default 50, `_STATE_FILE`, `_LOG_FILE`).

---

## 2.5 Štampa svih crteža (print-bundle, P3)

`src/modules/handovers/print-bundle.service.ts` — spajanje svih PDF crteža
nacrta/primopredaje u JEDAN dokument (`pdf-lib`), za štampu odjednom. Zajednički
helper za oba nivoa. Rute (klasna permisija `PRIMOPREDAJE_READ` na oba
kontrolera):

| Metoda | Ruta | Šta radi |
|---|---|---|
| GET | `/api/v1/handover-drafts/:id/print-bundle` | Pregled crteža nacrta za štampu: `hasPdf`, `sizeKb`, `pageFormat` + grupe po formatu |
| GET | `/api/v1/handover-drafts/:id/print-bundle/pdf` | JEDAN spojen PDF (`?format=A4` ILI `?drawingIds=1,2,3`; bez oba = svi) |
| GET | `/api/v1/handovers/:id/print-bundle` | Isti pregled, za JEDAN crtež te primopredaje |
| GET | `/api/v1/handovers/:id/print-bundle/pdf` | PDF crteža te primopredaje (per-RN štampa) |

**Detekcija formata po ISO A papiru.** `ISO_A_FORMATS` A0-A4 u mm
(print-bundle.service.ts:16); `PT_TO_MM = 25.4/72`; tolerancija
`FORMAT_TOLERANCE_MM = 6` (±6 mm, realni crteži odstupaju). Format prve strane =
`MediaBox` (`getSize`) + `Rotate`, orijentaciono-agnostično (portret/pejzaž isto);
nečitljiv/nevalidan PDF → `custom`. Redosled grupa: A0→A1→A2→A3→A4→custom
(legacy: EPSON SC-T2100 ploter za A0-A2, HP LaserJet za A3/A4; izbor štampača je
na browseru). Odgovor `summarize`: `{ items, groups, missingCount }`.

**Draft vs primopredaja nivo:** nacrt (`handover_drafts`) uzima SVE ne-isključene
stavke, **dedup po crtežu** (isključene ostaju u listi sa `excluded:true` da ih UI
prikaže; ako je bar jedna pojava crteža ne-isključena, štampa se); primopredaja je
PO JEDNOM crtežu (`drawing_handovers.drawingId`).

**Memorija i 200 MB guard.** Metapodaci (`hasPdf`/`sizeKb`) idu kroz raw SQL sa
`octet_length(pdf_binary)` — **blob se NIKAD ne učita za spisak**. Blobovi se pri
detekciji i spajanju učitavaju SEKVENCIJALNO (jedan po jedan, referenca se pušta
odmah). `MERGE_MAX_TOTAL_KB = 200 * 1024` (200 MB, :42): zbir `sizeKb` izabranih
crteža se proverava PRE učitavanja ijednog bloba — prekoračenje → 422 sa uputstvom
da se štampa u manjim grupama. Spajanje: `pdf-lib` `copyPages`, redosled kao u
`items`.

**Query:** `?format` XOR `?drawingIds` (oba navedena → 422); dupliran parametar
(Express ga parsira kao niz) → 422 umesto 500; nepoznat format / nevalidan
`drawingIds` / crtež van skupa / bez PDF-a → 422.

**FE:** rezultat je `application/pdf`, `Content-Disposition: inline` (streamovan
`StreamableFile`); front ga otvara u modalu / iframe-u i poziva print dijalog
browsera (biranje štampača je na browseru).

---

## 2.6 cutover-verify alat

`tools/cutover-verify/cutover-verify.mjs` — verifikacioni report (P4 spec §7.3,
runbook 17 korak 4). Poredi QBigTehn lanac tabela između legacy MSSQL-a i
ServoSync 2.0 Postgres-a POSLE finalnog force/full sync-a. **Bez novih
zavisnosti** — reuse `mssql` + `@prisma/client` koje backend već ima; konekciona
env je ista kao backend (`DATABASE_URL` + `BIGBIT_DB_*`). Izlaz je Markdown na
stdout. **Exit:** `0` paritet · `1` odstupanja u striktnim sekcijama · `2` greška
izvršavanja.

Report proverava (sekcije A-F):

| Sekcija | Provera |
|---|---|
| **A** | `COUNT(*)` + `MAX(id)` po tabeli lanca, legacy vs 2.0 (1:1 id politika). PDM tabele su tu; neke su `info` (paritet se NE očekuje): `drawing_import_log` (nativni 2.0 intake piše sopstvene redove), `drawing_pdfs` (nativni upload → 2.0 ≥ legacy, kompozitni PK bez `MAX(id)`) |
| **B** | Derivirane `drawing_handovers`: legacy `tRN.IDPrimopredaje > 0` vs 2.0 `legacy_rn_id IS NOT NULL`; nativni redovi (`legacy_rn_id IS NULL`) su info |
| **C** | MAX RN ordinal po predmetu (`IdentBroj` deo posle poslednjeg `/`) — provera da nativna numeracija nastavlja legacy niz |
| **D** | Meki-FK orfani na 2.0 strani (batch-resolve lanac; za PDM: `drawing_components.parent/child_drawing_id → drawings`, `drawing_plan_items → drawings/drawing_plans` itd.). Orfani NE obaraju exit kod (istorijski postoje) |
| **E** | PDF blobovi: `PDM_PDFCrtezi` vs `drawing_pdfs` — 2.0 mora imati **≥** blobova od legacy-ja (nativni upload dodaje); MANJE = DIFF (finalni PDF uvoz nepotpun) |
| **F** | Statusna distribucija primopredaja 0/1/2/3 (U obradi/Saglasan/Odbijeno/Lansiran), legacy `tRN` vs 2.0 derivirano |

`CHAIN_TABLES` (cutover-verify.mjs:64) pokriva ceo lanac (PDM, RN, TP, nalepnice,
šifarnici); `info:true` znači „paritet nije očekivan — prijavi, ne obaraj run".
Zaključak reporta: paritet 1:1 → nastavak runbook-a; N striktnih odstupanja →
rešiti PRE cutover-a.


---

<a id="deo-3--nacrti-i-primopredaje"></a>
# DEO 3 — Nacrti i Primopredaje

## Nacrti i Primopredaje: tok tehnologa

Modul „Primopredaja" pokriva ceo lanac od **nacrta primopredaje** (projektant grupiše crteže
jednog predmeta) preko **primopredaje crteža** (svaki crtež zasebno čeka odobravanje šefa
tehnologije) do **radnog naloga (RN)** koji tehnolog kuca i lansira. Backend je podeljen na dva
servisa/kontrolera u istom NestJS modulu `src/modules/handovers/`:

- `HandoverDraftsService` / `HandoverDraftsController` — nacrti (`handover_drafts` +
  `handover_draft_items`): unos, izmena, brisanje, odluke o spornim stavkama, **submit** (predaja
  u primopredaju).
- `HandoversService` / `HandoversController` — primopredaje (`drawing_handovers`): pregled +
  workflow (approve / reject / launch / return-to-pending / prepare-work-order / take-over).

Frontend je jedan ekran sa četiri taba (`frontend/src/app/handovers/page.tsx:39-52`): **Nacrti**,
**Na čekanju**, **Odobrene**, **Sve primopredaje** — svaki tab mapira na jedan pod-resurs gore.

### Terminologija (QBigTehn → 2.0)

| QBigTehn (legacy) | 2.0 model | 2.0 tabela |
|---|---|---|
| `NacrtPrimopredaje` | `HandoverDraft` | `handover_drafts` |
| `NacrtPrimopredajeStavke` | `HandoverDraftItem` | `handover_draft_items` |
| `PrimopredajaCrteza` | `DrawingHandover` | `drawing_handovers` |
| `StatusiNacrtaPrimopredaje` | `HandoverDraftStatus` | `handover_draft_statuses` |
| `StatusiPrimopredaje` | `HandoverStatus` | `handover_statuses` |
| `PrimopredajaPDFCrteza` | `DrawingHandoverPdf` | `drawing_handover_pdfs` |
| „kucanje TP" | prepare-work-order → `work_orders` red | — |

---

## Modeli

Svi modeli su definisani u `backend/prisma/schema.prisma` (blok „HANDOVER (Primopredaja)",
`schema.prisma:495-631`). Nose `/// Was: <StaroIme>` komentar (BACKEND_RULES §1 — legacy tabele).

### HandoverDraft (`handover_drafts`, `schema.prisma:500-522`)

Zaglavlje nacrta — jedan projektant, jedan predmet, N crteža-stavki.

| Polje | Tip | Značenje |
|---|---|---|
| `id` | Int, autoincrement | PK |
| `designerId` | Int (`designer_id`) | projektant (FK `workers`) — kreator nacrta |
| `draftDate` | DateTime (`draft_date`) | datum nacrta (default `now()`) |
| `projectId` | Int (`project_id`) | predmet (FK `projects`) — tačka dodele crteža predmetu |
| `pieceCount` | Int (`piece_count`) | broj komada sklopa za proizvodnju |
| `statusId` | Int (`status_id`, default 0) | FK `handover_draft_statuses` |
| `draftNumber` | String(30) (`draft_number`) | broj nacrta — **generiše server** (`DraftNumberingService`) |
| `isLocked` | Boolean? (`is_locked`, default false) | zaključan posle predaje (`submit`) |
| `draftType` | SmallInt (`draft_type`, default 0) | tip nacrta 0/1/2 (vidi „tip nacrta" niže) |
| `mainDrawingId` | Int? (`main_drawing_id`) | glavni crtež sklopa (FK `drawings`, opciono) |
| `note` | String(250)? | napomena |
| `createdAt`/`updatedAt` | DateTime? | audit |

Relacije: `mainDrawing`, `project`, `designer`, `status` (sve `onDelete: NoAction`), `items[]`.

### HandoverDraftItem (`handover_draft_items`, `schema.prisma:525-547`)

Stavka nacrta = jedan crtež koji ulazi u primopredaju.

| Polje | Tip | Značenje |
|---|---|---|
| `id` | Int, autoincrement | PK |
| `draftId` | Int (`draft_id`) | FK `handover_drafts` (`fk_handover_draft_items_draft`, `onDelete: NoAction`) |
| `drawingId` | Int (`drawing_id`) | crtež stavke — **NEMA DB FK** (legacy obrazac; validira se u servisu, `handover-drafts.service.ts:308-326`) |
| `quantityToProduce` | Int (`quantity_to_produce`, default 1) | količina za izradu |
| `mainDrawingId` | Int? (`main_drawing_id`) | vodeći sklop stavke (za poređenje sa PDM sastavnicom) |
| `isMain` | Boolean (`is_main`) | da li je stavka glavni crtež |
| `preCheckDuplicate` | Boolean (`pre_check_duplicate`) | §6.5.4 — crtež je ranije puštan (sporna stavka) |
| `preCheckDraftId` | Int? (`pre_check_draft_id`) | provenance: raniji nacrt istog crteža na istom predmetu |
| `preCheckWorkOrderId` | Int? (`pre_check_work_order_id`) | provenance: raniji RN istog crteža na istom predmetu |
| `excludeFromHandover` | Boolean (`exclude_from_handover`) | odluka 1=Isključi → stavka ne ide u predaju |
| `decisionAction` | SmallInt (`decision_action`, default 0) | odluka projektanta: 0=nerešeno, 1/2/3 |
| `decisionDateTime` | DateTime? (`decision_date_time`) | kada je odluka doneta |
| `quantityDefinedInDrawing` | Int? (`quantity_defined_in_drawing`) | količina definisana u crtežu (prikaz) |
| `note` | String(250)? | napomena stavke |

### DrawingHandover (`drawing_handovers`, `schema.prisma:559-609`)

Primopredaja **jednog** crteža — jezgro workflow-a. Kreira se u `submit()` (jedan red po
ne-isključenoj stavci nacrta) ili se derivira iz legacy `tRN`-a (vidi „Derivacija" niže).

| Polje | Tip | Značenje |
|---|---|---|
| `id` | Int, autoincrement | PK |
| `drawingId` | Int (`drawing_id`) | crtež — **IMA DB FK** `fk_drawing_handovers_drawing` (za razliku od stavke) |
| `handoverDate` | DateTime (`handover_date`) | datum predaje |
| `handoverWorkerId` | Int (`handover_worker_id`) | „predato tehnologu"; NOT NULL, bez FK — u `submit()` = `designerId` nacrta (fallback 0), `handover-drafts.service.ts:901` |
| `statusId` | Int (`status_id`, default 0) | FK `handover_statuses` — 0/1/2/3 (statusna mašina niže) |
| `statusChangedAt` / `statusChangedById` / `statusChangeComment` | DateTime? / Int? / String(250)? | audit poslednjeg prelaza + komentar/razlog |
| `launchedAt` / `launchedById` | DateTime? / Int? | audit lansiranja |
| `isLocked` | Boolean? (`is_locked`, default false) | zaključava se pri lansiranju |
| `note` | String(250)? | napomena |
| `createdAt`/`updatedAt` | DateTime? | audit |

**App-only kolone (dokumentovana devijacija).** `DrawingHandover` je legacy-oblikovana
(sync-ovana) tabela, ali je legacy `PrimopredajaCrteza` **prazna** čak i na živom MSSQL-u, a
tabela **postaje ServoSync-vlasništvo na cutover-u**. Zato je proširena aplikativnim kolonama —
svesno odstupanje od pravila „sync tabele su cache" (BACKEND_RULES §4), izričito dokumentovano u
`///` komentarima uz svaku kolonu:

| Kolona | Tip | Zašto app-only |
|---|---|---|
| `technologistId` (`technologist_id`, default 0) | Int | tehnolog koji piše TP — bira ga šef tehnologije pri odobravanju; **nema legacy izvora**. `0` = nije dodeljen. `schema.prisma:575-580` |
| `legacyRnId` (`legacy_rn_id`, **@unique**) | Int? | provenance: `tRN.IDRN` izvornog legacy reda (legacy primopredaja živi kao atributi `tRN` reda). `NULL` = nativni 2.0 red; ključ po kom derivacioni syncer radi idempotentan upsert. `schema.prisma:581-586` |
| `technologistAssignedAt` (`technologist_assigned_at`) | DateTime? | audit: kada je **tekući** tehnolog dodeljen — piše ga i `approve()` i take-over; briše ga return-to-pending. `schema.prisma:587-593` |
| `technologistAssignedById` (`technologist_assigned_by_id`) | Int? | audit: ko je izveo dodelu (approve = šef; take-over = sam preuzimalac). `schema.prisma:594-597` |
| `productionDeadline` (`production_deadline`) | DateTime? | §6.5.1 — rok izrade koji unosi **onaj ko odobrava** (ne onaj ko lansira); propagira se u `work_orders.production_deadline`. `schema.prisma:598-603` |

`Timestamp(6)` (ne `Timestamptz`) je namerno — nove kolone prate tip susednih legacy kolona iste
tabele (BACKEND_RULES Timestamptz pravilo važi samo za NOVE tabele).

### HandoverStatus (`handover_statuses`, `schema.prisma:624-631`)

Lookup 0/1/2/3. **Istu tabelu deli i `work_orders.handoverStatusId`** (relacije
`drawingHandovers[]` i `workOrders[]`) — zato su statusi primopredaje i radnog naloga 1:1 istih
vrednosti (`HandoversService.HANDOVER_STATUS` ≡ `WorkOrdersService.WO_STATUS`).

### HandoverDraftStatus (`handover_draft_statuses`, `schema.prisma:550-556`)

Lookup statusa nacrta. Seed **nije potvrđen** — kod se ponaša odbrambeno: `create()` upisuje
`statusId: 0` bez lookup provere, a `submit()` postavlja „Predat" (`DRAFT_STATUS_SUBMITTED = 2`,
`handover-drafts.service.ts:54`) **samo ako taj red postoji**, inače nacrt samo zaključava bez FK
500 (`handover-drafts.service.ts:920-928`). Frontend zato boji status heuristikom po nazivu, ne po
fiksnom id-u (`common.tsx:199-208`).

---

## Statusna mašina primopredaje

Status je `drawing_handovers.status_id` (FK `handover_statuses`). Vrednosti (`handovers.service.ts:36-41`):

| id | Konstanta | Labela (UI `common.tsx:175-180`) | Značenje |
|---|---|---|---|
| 0 | `PENDING` | „U obradi" (neutral) | na čekanju odobravanja (tehnolog inbox) |
| 1 | `APPROVED` | „Saglasan" (success) | odobreno, dodeljen tehnolog — kuca se TP |
| 2 | `REJECTED` | „Odbijeno" (danger) | odbijeno (terminalno) |
| 3 | `LAUNCHED` | „Lansiran" (info) | RN lansiran, primopredaja zaključana (terminalno) |

### Dozvoljeni prelazi

```
                      submit (iz nacrta)
                             │
                             ▼
                     ┌──────────────┐
        reject ◄─────┤  0 U OBRADI  ├─────► approve (+ tehnolog + rok)
       (razlog       └──────────────┘         │
        OBAVEZAN)          ▲                   ▼
             │             │           ┌──────────────┐
             ▼             │  return-  │  1 SAGLASAN   │
      ┌────────────┐       └───────────┤  (undo)       │
      │ 2 ODBIJENO │        1→0 BLOKIRAN└──────────────┘
      │ (terminal) │        ako RN postoji  │       │
      └────────────┘                        │       │  prepare-work-order
                              launch        │       │  „Otkucaj TP"
                              (SAGLASAN →    │       │  (RN, status OSTAJE 1)
                               LANSIRAN)     │       │  take-over
                                             ▼       │  „Preuzmi izradu"
                                     ┌──────────────┐│  (status OSTAJE 1)
                                     │ 3 LANSIRAN   │◄┘
                                     │ + isLocked   │
                                     │ (terminal,   │
                                     │  zaključano) │
                                     └──────────────┘
```

Pravila (sva u `handovers.service.ts`):

- **approve / reject → samo iz 0 (U OBRADI).** Guard `from: PENDING` u `transition()`
  (`:313-329`, `:342-349`). approve dodatno dodeljuje tehnologa i (opciono) rok.
- **prepare / launch / take-over → samo iz 1 (SAGLASAN).** Preduslov `statusId !== APPROVED`
  → 409 (`:666-669`, `:741-744`, `:480-483`).
- **prepare i take-over NE menjaju status** — primopredaja ostaje SAGLASAN; menja se tek na
  launch.
- **launch → LANSIRAN + `isLocked=true`** (`:849-862`). Lansirano je terminalno: svaki dalji
  prelaz pada na guard `isLocked` (422 „Primopredaja je zaključana") ili `statusId != APPROVED`
  (409).
- **return-to-pending: 1 → 0** (undo odobravanja) — **BLOKIRAN (409) ako za primopredaju već
  postoji RN** (prepare/launch tok). Poruka upućuje da se RN prvo obriše/razreši (storniranje RN-a
  je otvorena odluka). `returnToPending()` `:389-393`.
- **Konkurentnost:** svaki prelaz je uslovni `updateMany` sa `where` po from-statusu — dva
  konkurentna prelaza (npr. approve vs reject u READ COMMITTED) oba prođu guard iznad, ali drugi
  dobija `count === 0` → 409 umesto tihog pregaza (`transition()` `:620-634`).
- **Legacy redovi** (`legacyRnId != null`) su blokirani na SVAKOM prelazu dok je guard aktivan —
  vidi „HANDOVER_LEGACY_GUARD" niže.

---

## Rute

Svi kontroleri traže JWT (`JwtAuthGuard`) + `PermissionsGuard`; podrazumevana permisija na klasi je
`PRIMOPREDAJE_READ`, mutacije je nadjačavaju. Ključevi permisija: `primopredaje.read` /
`.write` / `.approve` i `rn.write` (`backend/src/common/authz/permissions.ts:17,27-29`).

### Nacrti — `HandoverDraftsController` (`handover-drafts.controller.ts`)

| Metoda | Ruta | Permisija | Šta radi / uslovi / greške |
|---|---|---|---|
| GET | `/v1/handover-drafts` | `primopredaje.read` | lista (filteri: `q`, `statusId`, `designerId`, `projectId`, `isLocked`, `from`, `to`) |
| GET | `/v1/handover-drafts/:id` | read | detalj (zaglavlje + stavke); 404 ako ne postoji |
| GET | `/v1/handover-drafts/:id/items` | read | samo stavke |
| GET | `/v1/handover-drafts/:id/print-bundle` | read | P3: pregled crteža za štampu |
| GET | `/v1/handover-drafts/:id/print-bundle/pdf` | read | P3: spojen PDF |
| POST | `/v1/handover-drafts` | `primopredaje.write` | kreiranje (zaglavlje + stavke); **preduslovi stavke**: ne-odobren PDM → 422 (hard), PDF/revizija → `meta.warnings` (soft); pre-check duplikata → `pre_check_*` + warning. 422 ako projektant/predmet/crtež ne postoje |
| PATCH | `/v1/handover-drafts/:id` | write | izmena zaglavlja; 422 ako je zaključan; predmet se ne može menjati ako nacrt već ima stavke (`:731-747`) |
| DELETE | `/v1/handover-drafts/:id` | write | **hard delete** (nema `deleted_at` u šemi); 422 ako je zaključan; briše stavke pa zaglavlje u transakciji (`remove()` `:793-809`) |
| POST | `/v1/handover-drafts/:id/submit` | write | **predaja u primopredaju** (§6.3): zaključa nacrt, kreira `drawing_handovers` red (status 0) po ne-isključenoj stavci; **422 gate** dok postoji sporna stavka bez odluke; 409 ako je već predat |
| POST | `/v1/handover-drafts/:id/items/:itemId/decision` | write | odluka nad spornom stavkom: 1=Isključi / 2=Predaj ponovo / 3=Dopuni (+`newQuantity`); 422 za zaključan nacrt ili ne-spornu stavku; 404 za tuđu/nepostojeću stavku |

### Primopredaje — `HandoversController` (`handovers.controller.ts`)

| Metoda | Ruta | Permisija | Šta radi / uslovi / greške |
|---|---|---|---|
| GET | `/v1/handovers` | `primopredaje.read` | lista (filteri: `statusId`, `drawingNumber`, `projectId`, `handoverWorkerId`, **`technologistId`**, `from`, `to`) |
| GET | `/v1/handovers/lookups` | read | draft statusi + handover statusi |
| GET | `/v1/handovers/technologists` | read | aktivni radnici vrste „Tehnolog" (id/fullName/username) |
| GET | `/v1/handovers/pending-approval` | read | tehnolog inbox = lista sa `statusId=0` |
| GET | `/v1/handovers/:id` | read | detalj; 404 ako ne postoji |
| GET | `/v1/handovers/:id/print-bundle` (+`/pdf`) | read | P3: crtež te primopredaje za štampu |
| POST | `/v1/handovers/:id/approve` | `primopredaje.approve` | odobri (0→1) + dodeli tehnologa (**OBAVEZAN**) + opcioni rok; 422 ako tehnolog fali/nije aktivan tehnolog/rok nevalidan/komentar >250; 409 ako nije U OBRADI |
| POST | `/v1/handovers/:id/reject` | approve | odbij (0→2); `reason` **OBAVEZAN** (422 bez njega ili >250) |
| POST | `/v1/handovers/:id/return-to-pending` | approve | undo (1→0) + čišćenje tehnologa/roka/audita; `reason` opcion; **409 ako RN postoji**; 422 ako nije SAGLASAN/zaključana |
| POST | `/v1/handovers/:id/take-over` | `primopredaje.write` **+ worker-type gate** | „Preuzmi izradu": aktivan tehnolog preuzima zaduženje; 422 ako akter nije aktivan tehnolog / nalog bez radnika; 409 ako nije SAGLASAN/zaključana; idempotentno (`alreadyOwner`) |
| POST | `/v1/handovers/:id/prepare-work-order` | **`rn.write`** | „Otkucaj TP": kreira RN bez lansiranja (idempotentno); 409 ako nije SAGLASAN; 422 ako je zaključana / nema podataka za RN |
| POST | `/v1/handovers/:id/launch` | approve | lansiraj (1→3); reuse pripremljenog RN-a; opcioni `comment`/`dueDate`; 409 ako nije SAGLASAN ili je postojeći RN odbijen/zaključan |

**Napomena o permisijama (dizajn odluka, `handovers.controller.ts:47-54`):** `return-to-pending`
traži `approve` (isti nivo kao approve — WRITE role, npr. kontrolor/menadžment, ne smeju poništiti
šefovo odobrenje); `take-over` traži `write` + poseban servisni gate „aktivan tehnolog" (namerno
NE nova permisija — KONTROLOR/MENADZMENT imaju WRITE pa je drugi gate obavezan);
`prepare-work-order` traži `rn.write` jer kreira `work_orders` red (isti gate kao POST
`/work-orders` — kontrolor bez RN_WRITE ne sme ovuda kreirati RN).

---

## Ključne funkcionalnosti detaljno

### (a) approve — Miljan (šef tehnologije) bira tehnologa + opcioni rok

`approve(id, dto, actor)` `handovers.service.ts:279-331`. Pri odobravanju je **obavezno** birati
tehnologa koji piše TP (`dto.technologistId`, `approve-handover.dto.ts`). Kriterijum tehnologa je
jedinstven izvor istine u `common/workers/technologist-criteria.ts`: **aktivan radnik čija je
vrsta (`worker_types.name`) „Tehnolog"** (case-insensitive po imenu, ne po hard-kodovanom id-u;
legacy paritet `tRadnici.IDVrsteRadnika=1`). `defines_approval` je **napušten** za ovaj kriterijum.

Validacije (redom): `technologistId` mora biti pozitivan ceo broj (422); komentar ≤250 (422 pre
Prisma P2000); `dueDate` mora biti validan ISO datum (`parseDateParam` — inače Invalid Date → 500);
tehnolog mora postojati (422) i biti aktivan tehnolog (`isActiveTechnologist`, 422). Tek onda
`transition(0→1)` atomično upisuje `technologistId` + `technologistAssignedAt` +
`technologistAssignedById = actor.workerId` + `productionDeadline = dueDate ?? null`. Rok se piše
`?? null` (ne `undefined`) jer je approve **autoritativan** za rok — odobravanje bez roka mora da
obriše eventualni stari rok.

Isti kriterijum pokreće i `GET /handovers/technologists` (`technologists()` `:255-264`), pa je lista
u dijalogu identična backend validaciji. FE: `ApproveHandoverDialog` (`workflow-dialogs.tsx:51-148`)
— dugme „Odobri" je disabled dok tehnolog nije izabran; rok je opcion (dok Miljan ne potvrdi
obaveznost, spec §8 #8).

### (b) prepare-work-order — „Otkucaj TP"

`prepareWorkOrder(id, actor)` `:647-715`. Kreira `work_orders` red iz odobrene primopredaje **bez
lansiranja**, da tehnolog može kucati tehnološki postupak. Ključne osobine:

- **Idempotentno:** ako RN za ovu primopredaju već postoji (prepare ili launch tok), vraća njega
  (`existing: true`) umesto duplikata. Brzi izlaz je van transakcije (`:654-662`), a race pokriva
  advisory lock unutar transakcije.
- **RN u statusu SAGLASAN, ne LANSIRAN** (`handoverStatusId: HANDOVER_STATUS.APPROVED`, `:704`),
  bez launch reda, primopredaja OSTAJE SAGLASAN. Kasniji launch podiže oba na LANSIRAN.
- **Advisory lock po primopredaji** (`lockHandoverWorkOrder` = `pg_advisory_xact_lock(hashtext("drawing_handover_wo:<id>"))`,
  `:1040-1045`) serijalizuje prepare/launch/take-over/return za istu primopredaju — guard protiv
  duplog RN-a. Posle lock-a se čita **sveže** stanje (status, isLocked, legacy guard) pa ponovo
  proverava „RN već postoji".
- Zaglavlje RN-a gradi zajednički helper `createHandoverWorkOrder` (`:958-1013`): predmet/količina
  iz povezane `handover_draft_items` stavke (`resolveDraftContext` — best-effort veza jer
  `drawing_handovers` nema FK ka nacrtu), numeracija sa advisory lock-om po predmetu
  (`nextWorkOrderIdent`). **`work_orders.workerId` = TEHNOLOG** (`handover.technologistId`), ne
  kreator. Nedostaju li podaci (crtež/predmet/količina) → 422, RN se ne kreira (`loadWorkOrderContext`
  `:904-946`).

FE: dugme „Otkucaj TP" (`approved-tab.tsx:131-141`, `handover-detail.tsx:190-204`) → na uspeh
router preusmeri na `/work-orders?open=<workOrderId>`.

### (c) launch — reuse pripremljenog RN-a

`launch(id, dto, actor)` `:725-871`. Preduslov SAGLASAN. Dva podslučaja u istoj transakciji (pod
advisory lock-om):

- **RN već postoji (prepare tok):** ne kreira se dupli — postojećem se podiže `handoverStatusId`
  na LANSIRAN (`:774-820`). Guard: RN-level approve/reject/lock ne dira primopredaju, pa postojeći
  RN može biti ODBIJEN/zaključan iako je primopredaja SAGLASAN → 409 („razrešite ga na Radnim
  nalozima pre lansiranja"). Uslovni `updateMany` sa `OR: [{isLocked:false},{isLocked:null}]`
  (legacy sync ostavlja `is_locked` NULL).
- **RN ne postoji:** kreira se preko `createHandoverWorkOrder` sa `handoverStatusId = LANSIRAN`.

U oba slučaja: kreira se `work_order_launches` red (`isLaunched: true`, `alignIdSequence` pre
insert-a) i primopredaja prelazi na LANSIRAN + `isLocked=true` (`:849-862`). Rok RN-a
(§6.5.1, override redosled u `createHandoverWorkOrder:1004-1006`): **eksplicitni launch `dueDate` >
rok primopredaje (`productionDeadline`) > NULL**.

FE: `LaunchHandoverDialog` (`workflow-dialogs.tsx:156-289`) — posle uspeha NE zatvara se odmah;
success ekran nudi „Otvori RN" i „Štampaj RN"; invalidacija cache-a tek pri zatvaranju da red (i
dijalog) ne nestane pre klika.

### (d) take-over — „Preuzmi izradu"

`takeOver(id, actor)` `:435-538`. Bilo koji aktivan tehnolog preuzima zaduženje na SAGLASNOJ,
nezaključanoj, ne-legacy primopredaji (legacy paritet: `UPDATE tRN SET SifraRadnika` — „tehnolozi
jedni drugima imaju pravo da pomažu"). Tok:

- Akter mora imati vezanog radnika (`actor.workerId`, 422 inače) koji je aktivan tehnolog (422).
- Pod advisory lock-om: 409 ako zaključana (posledica lansiranja) ili nije SAGLASAN.
- **Ako je zaduženje već akterovo → 200 `{ alreadyOwner: true }` bez upisa** (idempotentno).
- Inače `updateMany` **prepiše** `technologistId` na aktera (prvobitno dodeljeni se ne pamti) +
  `technologistAssignedAt/ById = actorWorkerId` (self-assign). Uslovni `where` (status APPROVED,
  isLocked false) → gubitnik race-a pada na 409.
- **Ako postoji pripremljen RN koji nije lansiran/zaključan, i `work_orders.worker_id` prelazi na
  preuzimaoca** (`:514-528`; bez toga bi kartica RN-a pokazivala starog tehnologa). Lansiran/
  zaključan RN se NE dira. `where` OR hvata i `is_locked IS NULL` (legacy).
- **Notifikacija** prethodnom tehnologu („NN je preuzeo izradu…") — POSLE transakcije,
  best-effort (pad notifikacije ne obara preuzimanje, `notifyTakeOver` `:545-572`).

**Odstupanje od envelope ugovora (svesno):** `alreadyOwner` je top-level ključ pored `data` —
doslovna forma iz spec §6.4, van `{ data, meta }` (BACKEND_RULES §5); FE tip je vezan za ovaj
oblik (`api/handovers.ts:533`). FE: `TakeOverButton` (`take-over-button.tsx`) — dugme se **samo
krije** kad primopredaja nije SAGLASAN, jeste legacy/zaključana, akter nije tehnolog ili je
zaduženje već njegovo (`:52-62`); `alreadyOwner` (moguće samo uz stale listu) → info poruka.

### (e) return-to-pending — „Vrati na čekanje" (undo)

`returnToPending(id, dto, actor)` `:360-415`. Undo odobravanja (1→0): pod advisory lock-om čita
sveže stanje, 422 ako zaključana / nije SAGLASAN, **409 ako za primopredaju postoji RN** (poruka
nosi `identNumber` + uput da se RN prvo obriše/razreši). Na uspeh: status na 0, `technologistId=0`,
i **prazne se** `technologistAssignedAt/ById` i `productionDeadline` (sledeći approve upisuje svež
rok). `reason` (opcion) ide u `statusChangeComment` (`?? null` — briše prethodni approve komentar).

### (f) Preduslovi stavke nacrta (§6.5.3)

`checkItemPreconditions(drawingIds)` `handover-drafts.service.ts:409-491`. Pri `create()`
(i svakom budućem add-item putu):

- **Ne-odobren `pdm_status` → HARD 422** — u nacrt ulaze samo ODOBRENI crteži (isti kriterijum kao
  XML uvoz: `isApprovedPdmState`). Nacrt se NE kreira.
- **Nedostajući PDF → SOFT warning** (`type: "missing_pdf"`) — PDF ume da kasni za XML-om.
- **Ne-poslednja revizija → SOFT warning** (`type: "not_latest_revision"`; MAX(revision) po
  `drawing_number`, normalizovano prazan→"A").

Soft upozorenja se vraćaju u `meta.warnings` **bez blokade** — nacrt JESTE kreiran
(`create()` `:392-393`). FE prikaže listu upozorenja na „success ekranu" dijaloga
(`drafts-tab.tsx:256-282`).

### (g) OdlukePredProvera — sporne stavke (§6.5.4)

Legacy `viewOdlukePredProvera`. `preCheckItems(ctx, items)` `handover-drafts.service.ts:509-650`
traži RANIJE puštanje istog crteža na ISTOM predmetu — dva batch upita (bez required JOIN-a):

1. Raniji **RN** istog crteža na istom predmetu (`work_orders` po `projectId` + `drawingId`,
   fallback `drawingNumber` jer synced RN umeju imati `drawing_id=0`).
2. Stavke **ranijih nacrta** istog predmeta (isključene ne broje).

Pogodak → `pre_check_duplicate=true` + `preCheckDraftId`/`preCheckWorkOrderId` (provenance) +
warning. Uz to se tražena količina poredi sa **PDM sastavnicom** (`drawing_components.required_quantity
× pieceCount` za parent iz nacrta) i neslaganje ulazi u razlog. Nabavni crteži (`isProcurement`) su
izuzeti (legacy `WHERE ISNULL(Nabavka,0)=0`).

**Odluka projektanta** — `decideItem(draftId, itemId, dto)` `:663-714` (POST
`…/items/:itemId/decision`): `DRAFT_ITEM_DECISION` (`decide-draft-item.dto.ts`):
- **1 = Isključi** → `excludeFromHandover=true` (stavka ne ide u predaju).
- **2 = Predaj ponovo** → svesno prihvata duplikat (količina ostaje); vraća isključenu stavku.
- **3 = Dopuni** → koriguje `quantityToProduce = newQuantity` (`newQuantity` obavezno, 422 inače).

Upisuje `decisionAction` + `decisionDateTime`. Re-odluka je dozvoljena dok nacrt nije zaključan
(422 za zaključan); 422 ako stavka nije sporna.

**Gate na submit** — `submit()` `:854-865`: dok postoji ne-isključena stavka
`pre_check_duplicate=true` sa `decisionAction=0` (nerešeno) → **422**. FE blokira dugme „Predaj u
primopredaju" po istom kriterijumu (`isUnresolvedDisputedItem`, `common.tsx:238-244`) + badge
„Sporna" na stavci dok nema odluke.

### (h) Tip nacrta (`draft_type`)

`handover_drafts.draft_type` (SmallInt 0/1/2). Vrednosti dolaze iz DTO-a; **labele su radne** dok
biro ne potvrdi mapiranje (§8 #6) — jedan izvor u `common.tsx:217-228`:

| draft_type | Radna labela |
|---|---|
| 0 | Glavni sklop |
| 1 | Parcijalna predaja — delovi |
| 2 | Parcijalna predaja — podsklopovi |

Korekcija labele ide SAMO u `DRAFT_TYPE_LABEL` — select „Tip nacrta" izvodi opcije iz iste
konstante.

---

## Oba toka lansiranja

Postoje **dva ulaza** u lansiranje iste primopredaje/RN-a; oba završavaju sa primopredajom u
LANSIRAN + zaključanom i RN-om u LANSIRAN, i oba dele **isti advisory lock**
(`drawing_handover_wo:<handoverId>`) pa se međusobno serijalizuju.

### Tok A — sa strane Dokumenta primopredaje

Tehnolog radi iz taba „Odobrene" / detalja primopredaje:

```
approve (0→1) ──► [opciono] prepare-work-order „Otkucaj TP"  (RN u SAGLASAN, primopredaja OSTAJE 1)
                              │
                              ▼
                  launch (POST /handovers/:id/launch)
                    ├─ RN postoji → podigni ga na LANSIRAN (409 ako je odbijen/zaključan)
                    └─ RN ne postoji → kreiraj RN direktno u LANSIRAN
                              │
                              ▼
                  + work_order_launches red
                  + primopredaja → LANSIRAN, isLocked=true
```

Kod: `HandoversService.launch()` `handovers.service.ts:725-871`.

### Tok B — sa strane Radnog naloga (propagacija na primopredaju)

RN nastao iz primopredaje (`prepare-work-order`) ima `drawing_handover_id > 0`. Kad se **taj RN
lansira sa Radnih naloga** (`WorkOrdersService.launch()` `work-orders.service.ts:788-890`),
propagacija u istoj transakciji podiže i primopredaju:

```
POST /work-orders/:id/launch  (RN mora biti SAGLASAN)
        │  (drawing_handover_id > 0 → uzmi isti advisory lock)
        ▼
  RN → LANSIRAN  +  work_order_launches red
        │
        ▼
  ako je RN „original" za primopredaju (najmanji id — klonovi dele FK):
     drawing_handovers → LANSIRAN + isLocked=true  (statusChangedBy/launchedBy = actor)
```

Detalji (`work-orders.service.ts:848-887`): propagira **samo „original"** RN (najmanji id;
rework/bulk-clone child ne sme prepisati `launchedAt/By` primopredaje); `updateMany` (ne `update`)
jer FK nema DB constraint (orphan ne sme oboriti launch); guard `statusId != LANSIRAN` čuva
postojeći audit; a dok je `HANDOVER_LEGACY_GUARD` aktivan, `where` dodaje `legacyRnId: null` — na
derivirane legacy redove se **ne propagira** (QBigTehn ih i dalje vodi). Lansiranje RN-a prolazi;
propagacija se tiho preskače kroz `updateMany` filter.

Neto rezultat: bez obzira da li tehnolog lansira „iz primopredaje" (Tok A) ili „iz radnog naloga"
(Tok B), stavka nestaje iz taba „Odobrene" i oba entiteta su konzistentno LANSIRANA.

---

## Derivacija iz legacy + HANDOVER_LEGACY_GUARD

### Zašto se tabovi pune iz `tRN`

Legacy „primopredaja" **ne živi u `PrimopredajaCrteza`** (prazna čak i na živom MSSQL-u) — živi kao
**atributi `tRN` reda** (~3.4k redova sa `IDPrimopredaje > 0`). Da bi tabovi „Na čekanju"/„Odobrene"/
„Sve primopredaje" imali podatke pre cutover-a, `HandoverDerivationSyncer`
(`sync/syncers/handover-derivation.syncer.ts`) derivira **jedan `drawing_handovers` red po takvom
`tRN` redu**.

Ključne odluke syncera (`handover-derivation.syncer.ts:37-71`):

- **ID politika:** derivirani red dobija **nativni autoincrement `id`**; ključ derivacije je
  jedinstvena kolona `legacy_rn_id` (= `tRN.IDRN`), pa je upsert idempotentan i ne može se sudariti
  sa nativnim 2.0 redovima. (`id = IDRN` je **odbijeno** — posle `setval(MAX(IDRN))` nativni submit
  i legacy identitet oba kreću od MAX+1 → sledeći run bi tiho pregazio nativni red.)
- Registruje se POSLE generičke petlje u `SyncService` i **zamenjuje** generičko
  `PrimopredajaCrteza` mapiranje (čiji je izvor prazan). Svaki run je pun prolaz (kursor se ignoriše).
- `update` namerno **prepisuje** derivirane redove (legacy je izvor istine do cutover-a); nativni
  redovi (`legacy_rn_id IS NULL`) su strukturno nedostižni upsertom; `deleteMany` se nikad ne zove.
- **Status mapiranje** iz `tRN.IDStatusPrimopredaje` je 1:1 na `handover_statuses` 0/1/2/3; tehnolog
  (`SifraRadnika`) se preuzima samo za APPROVED/LAUNCHED redove (`:204-213`).
- **Post-korak:** remap `work_orders.drawing_handover_id` — generičko `tRN` mapiranje je tamo
  upisalo `tRN.IDPrimopredaje` (id NACRT grupe, semantički pogrešno); syncer to ispravlja na
  deriviran handover id (`remapWorkOrders` `:250-281`). Runbook: force re-import `work_orders` mora
  ići sa `["work_orders","drawing_handovers"]` da remap prođe POSLE re-importa.

Tabela je u `OWNED_PRODUCTION_TABLES` (`sync/table-ownership.ts:44`) — zaštićena od generičkog full
refresh brisanja. Backend enrich postavlja `isLegacy = (legacyRnId != null)` na svakom redu
(`handovers.service.ts:1164`), a FE prikaže neutralni bedž „Legacy" (`common.tsx:160-166`).

### Guard 409 nad deriviranim redovima

`assertNotLegacyGuarded(h)` `handovers.service.ts:583-588`: dok je derivirani red (`legacyRnId != null`)
i `HANDOVER_LEGACY_GUARD !== "false"`, **svaka mutacija** (approve/reject/launch/return/prepare/
take-over) baca **409** — do cutover-a se te radnje rade u QBigTehn-u (Miljan), a izmena ovde bi bila
pregažena sledećim derivacionim sync-om. Guard se poziva u `transition()`, `returnToPending()`,
`takeOver()`, `prepareWorkOrder()` i `launch()` — uvek **dvaput** kod prepare/launch/return:
jednom pre transakcije i **ponovo posle advisory lock-a** (sveže stanje — derivacioni sync je mogao
označiti red u međuvremenu, `:689`, `:768`).

**Ukidanje na cutover-u:** `HANDOVER_LEGACY_GUARD=false` u `backend.env` + `compose up` (isti
rollback obrazac kao `AUTHZ_ENFORCE`, bez deploy-a). Kolona `legacy_rn_id` ostaje kao provenance.
Nativni redovi (`legacyRnId == null`, nastali kroz `submit()`) nikad nisu blokirani.

### Advisory lock disciplina (rezime)

Svi tokovi koji diraju vezu primopredaja↔RN dele isti ključ
`pg_advisory_xact_lock(hashtext("drawing_handover_wo:<handoverId>"))`:

- `HandoversService`: `lockHandoverWorkOrder` u `prepareWorkOrder`, `launch`, `returnToPending`,
  `takeOver` (`handovers.service.ts:1040-1045`).
- `WorkOrdersService.launch` uzima **isti** ključ kad RN ima `drawing_handover_id > 0`
  (`work-orders.service.ts:816`).

Time su Tok A i Tok B, take-over i return-to-pending međusobno serijalizovani nad istom
primopredajom — guard protiv duplog RN-a i protiv pregaza launch audita. `submit()` koristi
zaseban ključ `handover_draft_submit:<draftId>` (`handover-drafts.service.ts:883`) da serijalizuje
konkurentne predaje istog nacrta.


---

<a id="deo-4--radni-nalozi-i-tp"></a>
# DEO 4 — Radni nalozi, TP, Realizacija, Kontrola, Kiosk

## Radni nalozi, Tehnološki postupak, Realizacija (kucanje), Kontrola, Kiosk

Ova sekcija pokriva proizvodno jezgro modula „Tehnologija": kreiranje i vođenje
**radnih naloga (RN)**, pisanje **tehnološkog postupka (TP)** kroz operacije naloga,
**realizaciju** (kucanje otkucanog rada), **završnu kontrolu** i **kiosk** za pogon,
plus **evidenciju vremena (A-4)**. Backend živi u
`backend/src/modules/work-orders/**` i `backend/src/modules/tech-processes/**`;
frontend u `frontend/src/app/work-orders/`, `frontend/src/app/tech-processes/`,
`frontend/src/app/operations-queue/` i `frontend/src/app/kiosk/`.

Terminologija je namerno iz QBigTehn-a: RN = radni nalog (legacy `tRN`), TP =
tehnološki postupak, „kucanje" = prijava otkucanog rada, „primopredaja",
„nacrt/crtež", „varijanta". Prisma modeli nose `/// Was: <StaroIme>` komentar koji
mapira na legacy Access tabelu.

---

### 1. Radni nalozi (RN)

#### 1.1 Model `WorkOrder` i pridružene tabele

`WorkOrder` (`/// Was: tRN`, tabela `work_orders`) je matična tabela naloga.
Definicija: `backend/prisma/schema.prisma:1487`.

| Polje | Tip | Značenje |
|---|---|---|
| `id` | Int (PK, autoincrement) | Legacy Int ključ (ne UUID). |
| `projectId` | Int (default 0) | Predmet (FK `projects`). |
| `identNumber` | String(50) | Broj RN-a, format `<projectNumber>/<ordinal>` (npr. `1234/5`). |
| `variant` | Int (default 0) | Varijanta iste kombinacije predmet/crtež/revizija. |
| `externalCustomerId` | Int | Komitent (BigBit cache). |
| `externalProjectName` | String? | Naziv predmeta „spolja". |
| `pieceCount` | Int (default 1) | Planirana količina (komada). |
| `drawingNumber` | String(100) | Broj crteža. |
| `partName` | String(250) | Naziv pozicije/dela. |
| `material`, `materialDimension` | String | Materijal + dimenzija (tekst). |
| `unit` | String(50) | Jedinica mere (default „kom"). |
| `revision` | String(3) (default „A") | Revizija — **verzioni pečat** koji ide u barkod (§4). |
| `qualityTypeId` | Int (default 0) | 0=dobar / 1=dorada / 2=škart (FK `part_quality_types`). |
| `workerId` | Int (default 0) | **Tehnolog autor** TP-a (FK `workers`). |
| `handoverStatusId` | Int (DDL default 3) | Radni status naloga (vidi WO_STATUS niže). |
| `status` | Boolean? (default false) | „RN završen" — sve značajne operacije gotove (§3). |
| `isLocked` | Boolean? | Zaključan RN (legacy `Zakljucano`; sync može ostaviti NULL). |
| `productionDeadline` | DateTime? | Rok izrade. |
| `drawingHandoverId` | Int (default 0) | FK ka primopredaji iz koje je RN nastao (0 = nativan). |
| `drawingId` | Int (default 0) | FK ka crtežu. |
| `enteredAt` | DateTime | Datum otvaranja. |
| `processedPartWeight` / `unprocessedPartWeight` | Float? | Težine (mapiraju se 1:1 pri klonu — §1.7). |

**Poslovni identitet** naloga je **trojka** `(projectId, identNumber, variant)` —
na nju se vezuju `tech_processes` kucanja i RNZ barkod. DB mreža je unique
constraint `uq_work_orders_project_ident_variant`
(`schema.prisma:1538`), koji čuva `cloneVariant` MAX+1 od trka/duplikata.

Pridružene stavke (sve FK relacije su `onDelete: NoAction` — brisanje je
eksplicitno u servisu):

| Model | `/// Was:` | Tabela | Uloga |
|---|---|---|---|
| `WorkOrderOperation` | tStavkeRN | `work_order_operations` | Operacije TP-a (RC + norme + opis). |
| `WorkOrderOperationImage` | tStavkeRNSlike | `work_order_operation_images` | Skice po operaciji. |
| `WorkOrderMachinedPart` | tPDM | `work_order_machined_parts` | Obrađeni delovi. |
| `WorkOrderBlank` | tPLP | `work_order_blanks` | Pripremci / poluproizvodi. |
| `WorkOrderNonstandardPart` | tPND | `work_order_nonstandard_parts` | Nestandardni delovi. |
| `WorkOrderComponent` | tRNKomponente | `work_order_components` | RN→RN veze. |
| `WorkOrderItemComponent` | tRNNDKomponente | `work_order_item_components` | RN→artikal veze. |
| `WorkOrderApproval` | tSaglasanRN | `work_order_approvals` | Audit odobravanja. |
| `WorkOrderLaunch` | — | `work_order_launches` | Audit lansiranja. |

#### 1.2 Radni statusi (WO_STATUS)

Konstanta u `work-orders.service.ts:40`:

```
IN_PROGRESS = 0  // U OBRADI
APPROVED    = 1  // SAGLASAN
REJECTED    = 2  // ODBIJENO
LAUNCHED    = 3  // LANSIRAN
```

Vrednost živi na `work_orders.handoverStatusId`. **Zamka:** DDL default kolone je
`3`, ali `create()` eksplicitno upisuje `IN_PROGRESS (0)` (`work-orders.service.ts:415`),
da nov ručno unet RN ne ispadne odmah „lansiran".

#### 1.3 Rute (controller `work-orders.controller.ts`)

Sve rute traže JWT (`@UseGuards(JwtAuthGuard)`); mutacije dodatno nose
`PermissionsGuard` + `@RequirePermission`. Bazni put `/api/v1/work-orders`.

| Metoda | Ruta | Permisija | Šta radi |
|---|---|---|---|
| GET | `/` | (samo JWT) | Lista + filteri (§1.4). |
| GET | `/operations/queue` | (samo JWT) | Planska tabla operacija po prioritetu (§2.3). Mora pre `:id`. |
| GET | `/:id` | (samo JWT) | Detalj: operacije, sve 4 vrste stavki, odobravanja, lansiranja. |
| GET | `/:id/print` | (samo JWT) | PDF RN dokumenta (`rRN`); `?variant=bez-barkoda`. |
| POST | `/` | `rn.write` | Kreiranje blanko RN-a (server generiše broj). |
| PATCH | `/:id` | `rn.write` | Izmena zaglavlja (samo poslata polja). |
| POST | `/:id/operations` | `rn.write` | Dodaj operaciju TP-a. |
| PATCH | `/:id/operations/:opId` | `rn.write` | Izmena operacije. |
| PATCH | `/operations/:opId/priority` | `tehnologija.write` | CAM prioritet (§2.2). |
| DELETE | `/:id/operations/:opId` | `rn.write` | Brisanje operacije (+ skice). |
| DELETE | `/:id` | `rn.write` | Brisanje kompletnog RN-a (cascade, guard). |
| POST | `/:id/approve` | `rn.approve` | Odobri/odbij `{ approve?: boolean }`. |
| POST | `/:id/launch` | `rn.launch` | Lansiraj (mora biti SAGLASAN). |
| POST | `/:id/lock` | `rn.write` | Zaključaj/otključaj `{ locked?: boolean }`. |
| POST | `/:id/copy-from/:sourceId` | `rn.write` | „Kopiraj iz naloga" — prepiši stavke u prazan cilj. |
| POST | `/:id/clone-variant` | `rn.write` | „Prepiši isti postupak" — klon kao MAX+1 varijanta. |
| POST | `/:id/rework` | `rn.write` | Dorada/škart child (`-D`/`-S`). |
| POST | `/projects/:projectId/bulk-clone` | `rn.write` | „Kloniraj predmet" — svi nalozi u prazan predmet. |

Napomena o auth-u (docstring kontrolera `work-orders.controller.ts:38`): drugi gate
za approve/launch (`Worker.definesApproval` / `Worker.definesLaunch`) je V2 —
označen `TODO(auth)` u servisu; V1 guard je permission-based.

#### 1.4 Lista i filteri

`list()` (`work-orders.service.ts:88`) paginira `work_orders`, sortira
`enteredAt desc, id desc`. Filteri (query): `q` (ident/naziv pozicije/crtež,
case-insensitive), `statusId` (handoverStatusId), `projectId`, `workerId`,
`customerId` (→ `externalCustomerId`), `from`/`to` (opseg `enteredAt`),
`completed` ('true'/'false' → `status`). Relacije (radnik, kvalitet, status) se
razrešavaju **batch-resolverima**, ne Prisma required-JOIN-om — legacy orphan FK
bi inače oborio 500 (memorija „legacy-read: batch-resolve").

#### 1.5 Numeracija `identNumber` i varijanta

`WorkOrderNumberingService.next()` (`work-order-numbering.service.ts`) radi
UNUTAR transakcije:

1. `pg_advisory_xact_lock(projectId)` — serijalizuje konkurentne unose za isti
   predmet (nema race, nema legacy string-DMax logike).
2. `identNumber = <project.projectNumber>/<MAX(ordinal)+1>` (ordinal = poslednji
   deo posle `/`).
3. V1: prva varijanta = **0**.

`create()` (`work-orders.service.ts:379`) pre insert-a poziva `alignSeq('work_orders')`
(poravnanje identity sekvence sa MAX(id)) — jer sync uvozi eksplicitne legacy
id-jeve, pa autoincrement inače kolidira.

#### 1.6 Odobravanje, lansiranje, zaključavanje

- **approve** (`work-orders.service.ts:734`): postavlja `handoverStatusId` na
  APPROVED/REJECTED i piše `WorkOrderApproval` audit red. Guard: zaključan RN →
  422; odobravanje bez ijedne operacije → 422. Autor = JWT `workerId`.
- **launch** (`work-orders.service.ts:788`): preduslov je **SAGLASAN**
  (`handoverStatusId === APPROVED`), inače 422. Koristi uslovni `updateMany`
  (samo prvi konkurentni launch prolazi, drugi dobija 409) i, ako je RN vezan za
  primopredaju (`drawingHandoverId > 0`) i „original" je (najmanji id među
  klonovima), u istoj transakciji podiže i primopredaju na LANSIRAN + zaključava.
  Advisory lock `drawing_handover_wo:<id>` serijalizuje RN-level i handover-level
  launch. `where` hvata i `isLocked: null` (legacy NULL = otključan).
  `HANDOVER_LEGACY_GUARD` (env, default aktivan) preskače propagaciju na
  derivirane legacy redove (`legacyRnId != null`).
- **setLock** (`work-orders.service.ts:893`): prosto `isLocked` toggle.

#### 1.7 Kopiranje / kloniranje / dorada

Zajednički helper `cloneItems()` (`work-orders.service.ts:1282`) kopira sve 4
vrste stavki; količine PDM/PLP se skaliraju `Math.round(q × coef)` (celobrojno),
PND ostaje decimalan (Float), norme operacija se **ne** skaliraju. `buildCloneHeader()`
(`work-orders.service.ts:1234`) mapira zaglavlje 1:1 — s eksplicitnim upozorenjem
da `processedPartWeight`/`unprocessedPartWeight` idu svaki u svoje polje (legacy
bug se NE reprodukuje).

- **copyFrom** („Kopiraj iz naloga", `work-orders.service.ts:916`): prepiše stavke
  iz `sourceId` u **prazan** `targetId`. Preduslovi: cilj postoji, nije
  zaključan/lansiran, i prazan je (nijedna od 4 tabele) — inače 409. Prioritet
  operacija se REGENERIŠE (100 ako RC `usesPriority`, inače 255).
- **cloneVariant** („Prepiši isti postupak", `work-orders.service.ts:975`):
  klon RN-a kao NOVI red sa **istim** `identNumber` i `variant = MAX+1`. MAX se
  računa kao **veći od dva** aggregate-a — po legacy trojci
  (projectId, drawingNumber, revision) i po (projectId, identNumber) — jer
  `updateHeader` može promeniti crtež/reviziju postojećoj varijanti. Advisory lock
  po predmetu; DB mreža je uq constraint. `drawingHandoverId` se NE kopira (nova
  varijanta nije vezana za staru primopredaju). Vraća
  `{ data: { workOrderId, identNumber, variant } }`. Ovim „oživljava" kiosk
  staleWorkOrder guard za native naloge.
- **rework** (Dorada/Škart, `work-orders.service.ts:1043`): child RN u istom
  predmetu, `identNumber` = izvor + sufiks `-D`n (dorada, `qualityTypeId=1`) ili
  `-S`n (škart, `qualityTypeId=2`); `n` = prvi slobodan redni broj. `pieceCount`
  = zadata količina, status = U OBRADI.
- **bulkClone** („Kloniraj predmet", `work-orders.service.ts:1106`): svi (ili
  izabrani `workOrderIds`) nalozi izvornog predmeta u **prazan** ciljni predmet;
  `coefficient` množi količine; `identNumber` zadržava redni broj, menja prefiks
  predmeta. Sve u jednoj transakciji (rollback svega pri bilo kojoj grešci).

#### 1.8 Brisanje RN-a

`remove()` (`work-orders.service.ts:673`) briše kompletan RN uz kaskadu (dubina
prvo, u jednoj transakciji, jer su FK-ovi NoAction). **Guardovi:** zaključan RN →
422; „proizvodnja započeta" (postoji ijedan `tech_processes` red po trojci) → 422.
Namerno **ne dira** `tech_processes` (kao legacy `spObrisiKompletanNalog`).

#### 1.9 Štampa RN dokumenta (rRN)

`WorkOrderPrintService.buildRnPdf()` (`work-order-print.service.ts`) gradi PDF
preko `pdfmake`: zaglavlje (logo Servoteh + `RNZ` barkod), info tabela
(komitent/predmet/crtež/materijal/rok/tehnolog/revizija) i tabela operacija
(Op. · Radni centar · Opis rada · Tpz · Tk · Alat/pribor · **Barkod**). Svaka
operacija dobija svoj `S` barkod; sva polja barkoda nose `revision` naloga —
isti kod generiše barkod za štampu i za kiosk-dekoder (`formatOrderBarcode` /
`formatOperationBarcode` iz `tech-processes/barcode.ts`). Varijanta
`?variant=bez-barkoda` izostavlja kolonu barkoda. Naziv fajla:
`RN-<ident>-rev-<revision>.pdf`. Frontend ga otvara dugmetom „Štampaj RN"
(`work-orders/page.tsx:152`).

---

### 2. Tehnološki postupak (TP) — unos operacija

TP = skup operacija na RN-u, tj. redovi `WorkOrderOperation`
(`/// Was: tStavkeRN`, `schema.prisma:1638`). Ovo je **TP-authoring** (legacy
`Form_UnosStavkiRN`), NE realizacija/kucanje (to je §3).

#### 2.1 Model `WorkOrderOperation`

| Polje | Tip | Značenje |
|---|---|---|
| `id` | Int (PK) | — |
| `workOrderId` | Int | FK ka `work_orders`. |
| `operationNumber` | Int (default 0) | Redni broj operacije (10, 20…). |
| `workCenterCode` | String(5) | Radni centar / RC (RJgrupaRC) — FK ka `operations`. |
| `workDescription` | String | Opis rada (obavezno). |
| `toolsFixtures` | String(50)? | Alat/pribor. |
| `setupTime` | **Float?** (default 0) | Priprema-završno vreme Tpz. |
| `cycleTime` | **Float?** (default 0) | Vreme po komadu Tk. |
| `toolWeight` | Float? (default 0) | Težina TO. |
| `priority` | Int (default 100) | CAM prioritet (0–255; 255 = bez prioriteta). |
| `workerId` | Int (default 0) | Tehnolog/autor stavke. |

> **Napomena o tipu normi:** Tpz/Tk su u šemi **Float** (legacy tabela), ne
> Prisma `Decimal`. To je izuzetak od opšteg pravila „količine = Decimal", jer je
> `work_order_operations` sync-ovana legacy tabela.

Šifarnik radnih centara je `Operation` (`/// Was: tOperacije`, `schema.prisma:1367`),
ključ `workCenterCode` (unique). Relevantna polja: `workCenterName`, `workUnitCode`
(radna jedinica), `usesPriority` (određuje default prioritet), `significantForFinishing`
(= završna kontrola → grana kiosk u KONTROLA režim, §4), `withoutProcess`,
`isSkippable`.

#### 2.2 Unos operacije (backend)

`addOperation()` (`work-orders.service.ts:483`):

- `workCenterCode` mora postojati u šifarniku `operations`, inače 422.
- `operationNumber` izostavljen → **auto `MAX(operationNumber)+10`** po nalogu.
- `priority` izostavljen → iz `operations.usesPriority` (**100** ako koristi
  prioritet, inače **255**).
- `workerId` = DTO ako je poslat, inače radnik iz JWT-a (bez fallback-a bi sve
  nove operacije imale workerId=0; UI ne šalje).
- Guard: zaključan RN → 422 (`assertEditable`).

`updateOperation()` (`work-orders.service.ts:537`) menja samo poslata polja;
promena RC-a re-izvodi prioritet iz `usesPriority` ako `priority` nije zadat.
`deleteOperation()` briše skice (`work_order_operation_images`) pa red.

DTO + ručna validacija u `dto/work-order-operation.dto.ts` (class-validator još
nije uveden — BACKEND_RULES §6).

**Frontend (unos):** dijalog `OperationDialog` (`work-orders/page.tsx:784`) u
expand-panelu RN-a. Polje „Prioritet" je namerno UKLONJENO (D7): default dolazi
iz RC-a na backendu, a CAM prioritet se zadaje na zasebnoj stranici (§2.3).
RC se bira `ComboBox`-om nad `useOperations`; „Broj operacije" ima hint
„prazno → auto (MAX+10)".

#### 2.3 CAM prioritet (inline) i stranica „Operacije po prioritetu"

CAM programer prioritizuje operacije, ali **nema `rn.write`**. Zato postoji
namenski endpoint iza `tehnologija.write`:

```
PATCH /api/v1/work-orders/operations/:opId/priority   { priority }   → tehnologija.write
```

`setOperationPriority()` (`work-orders.service.ts:601`): opseg **0–255** (ceo broj,
255 = dno planske table), inače 400. Dozvoljeno i na **lansiranom** RN-u
(prioritet je pogonska odluka, ne izmena TP-a); zaključan RN → 422. Orphan
operacija (RN ne postoji) nema lock guard.

Planska tabla se čita preko `GET /operations/queue` → `operationQueue()`
(`work-orders.service.ts:286`): operacije **nezavršenih** naloga
(`workOrder.status != true`), sortirane po `priority asc, workOrderId asc,
operationNumber asc`. Filteri: `q`, `workCenterCode`, `onlyPrioritized`
(samo `priority < 255`).

**Frontend:** `frontend/src/app/operations-queue/page.tsx` — „Operacije po
prioritetu". Kolona „Prioritet" je inline-editabilna (`PriorityCell`): klik →
number input 0–255, Enter/blur snima kroz `useSetOperationPriority`, Esc
otkazuje; bez `tehnologija.write` prikazuje samo vrednost (StatusBadge
danger < 100, warn inače, „—" za 255). Zaključan RN → 422 poruka ispod ćelije.

---

### 3. Realizacija (kucanje) — model `TechProcess`

Frontend stranicu čini `frontend/src/app/tech-processes/page.tsx` sa naslovom
**„Realizacija"** (bivši „Tehnološki postupci"). Backend je
`tech-processes` modul (`tech-processes.controller.ts`, `.service.ts`).

#### 3.1 Model `TechProcess`

`TechProcess` (`/// Was: tTehPostupak`, tabela `tech_processes`,
`schema.prisma:1672`). **Red = jedno kucanje** (jedna prijava rada za jednu
operaciju). Ključna polja:

| Polje | Tip | Značenje |
|---|---|---|
| `id` | Int (PK) | — |
| `workerId` | Int | Radnik koji je prijavio rad (audit; legacy `SifraRadnika`). |
| `projectId`, `identNumber`, `variant` | Int/String/Int | Trojka RN-a. |
| `operationNumber` | Int | Broj operacije. |
| `workCenterCode` | String(5) | Radni centar (FK `operations`). |
| `identMark` | String(50) | Toznaka (legacy; u 2.0 obično „0"). |
| `pieceCount` | Int | **Akumulirani** napravljeni komadi na redu. |
| `qualityTypeId` | Int (default 0) | 0=dobar / 1=dorada / 2=škart. |
| `isProcessFinished` | Boolean? | Operacija zatvorena. |
| `enteredAt` / `finishedAt` | DateTime | Uneto / završeno (vreme je IZVEDENO — tabela nema kolonu radnog vremena). |
| `workOrderId` | Int (default 0) | FK ka RN-u (često 0 kod legacy — veza kroz trojku). |
| `note` | String? | Napomena (npr. STORNO). |

**KOM=0 = sesija-samo-vreme:** red sa `pieceCount=0` postoji da bi se merilo
vreme (A-4) bez knjiženja komada; komadi se akumuliraju tek na STOP/scan.

Konstanta `PART_QUALITY = { GOOD: 0, REWORK: 1, SCRAP: 2 }`
(`tech-processes.service.ts:46`).

#### 3.2 Rute (controller `tech-processes.controller.ts`)

Ceo kontroler traži JWT + `PermissionsGuard`; klasni default je
`@RequirePermission(tehnologija.read)`, pojedine rute ga pooštravaju.
Bazni put `/api/v1/tech-processes`.

| Metoda | Ruta | Permisija | Šta radi |
|---|---|---|---|
| GET | `/` | `tehnologija.read` | Lista kucanja (row-scope: radnik → svoje mašine). |
| GET | `/card` | `tehnologija.read` | „Kartica TP" — redovi trojke + sume (§3.3). |
| GET | `/critical` | `tehnologija.read` | Kritični postupci (severity 1/2/3 po roku). |
| GET | `/worker-performance` | `tehnologija.read` | Učinak po radniku (from/to). |
| GET | `/rn-progress` | `tehnologija.read` | „Gotovost RN" — planirano vs napravljeno. |
| GET | `/sessions/daily` \| `/summary` \| `/hourly` \| `/poorly-recorded` | `tehnologija.read` | A-4 analitika sesija (§5). |
| GET | `/worker?card=` | `tehnologija.read` | Radnik iz ID kartice (kiosk login). |
| GET | `/worker/me` | `tehnologija.read` | Radnik vezan za JWT nalog (`users.worker_id`). |
| GET | `/label?workOrderId=&quantity=` | `tehnologija.read` | Podaci za nalepnicu (RNZ). |
| GET | `/work/open` | `tehnologija.report_work` | Stanje sesije za (radnik, operacija) — vodi START/STOP. |
| GET | `/:id` | `tehnologija.read` | Jedan TP + radnik + dokumentacija. |
| POST | `/barcode/decode` | `tehnologija.read` | Parsira/validira JEDAN barkod (§4). |
| POST | `/scan` | `tehnologija.report_work` | Barkod prijava rada (§4). |
| POST | `/:id/finish` | `tehnologija.report_work` | Zatvaranje postupka. |
| POST | `/control` | `tehnologija.approve` | ZAVRŠNA KONTROLA (create-on-scan, §4). |
| POST | `/work/start` | `tehnologija.report_work` | START skena (§5). |
| POST | `/work/stop` | `tehnologija.report_work` | STOP skena (§5). |
| POST | `/work/auto-close` | `tehnologija.write` | Auto-close otvorenih sesija (eksterni cron). |
| POST | `/labels/print` | `tehnologija.report_work` | RAW TSPL2 → mrežni termalni štampač. |
| POST | `/:id/storno` | `tehnologija.write` | Storno (kontra-red). |
| DELETE | `/:id` | `tehnologija.write` | Audited brisanje kucanja (snapshot → audit_log). |

Gejtovanje je poravnato sa navigacijom: Kucanje = `report_work`
(radnik/tehnolog/CNC/šef), Kontrola = `approve` (kontrolor/šef/menadžment).
`decode` je namerno `read` (treba i kontroloru i menadžmentu, čist parse bez
upisa). Mutacije su odobrene (ODLUKE 2026-07-08: proizvodne tabele = ServoSync
vlasništvo); sve idu kroz `$transaction`.

#### 3.3 „Kartica TP" (`GET /card`)

`card()` (`tech-processes.service.ts:359`) uzima **jedan postupak** identifikovan
trojkom (`projectId`, `identNumber`, `variant`; obavezni query, `variant` default 0)
i vraća redove + API-side sume (spec §3 pravilo 6: SUM na DB/API, ne u UI).

Redovi se sortiraju `operationNumber asc, workCenterCode asc, id asc` (grupe su
kontiguozne). Za svaku **operaciju** = grupa po `(operationNumber, workCenterCode)`
gradi se agregat (`CardOperationAcc`, akumulator `tech-processes.service.ts:103`):

- `entryCount` — broj kucanja (redova) grupe (KOM=0 sesije ulaze u broj, ne u komade);
- `pieces` = `{ total, good, rework, scrap }` — Σ `pieceCount`; `total` svi redovi,
  ostali po `qualityTypeId` 0/1/2. **Storno se prirodno netuje** (negativan
  `pieceCount` kontra-reda umanjuje sumu);
- `isFinished` — bar jedan red grupe zatvoren;
- `elapsedMinutes` — Σ (`finishedAt − enteredAt`) po redovima koji imaju oba
  vremena, u minutima (null dok nijedan nije zatvoren).

Header brojevi (`data`): `operationCount` = broj DISTINCT (OP, RC) parova,
`finishedCount` = parovi sa bar jednim zatvorenim redom, `summary.entryCount` =
ukupan broj redova, `summary.totalPieces` / `piecesByQuality` / `totalElapsedMinutes`.
`data.operations[]` = agregati po grupi, `data.rows[]` = pojedinačna kucanja.

**Frontend:** expand kartica `TechProcessCardDetail` (`tech-processes/page.tsx:303`)
prikazuje `SumTile` pločice (Ukupno kom / Dobar / Dorada / Škart / Ukupno vreme /
Varijanta) i tabelu kucanja sa **injektovanim grupnim header redovima**
(`CardGroupHeaderRow`) — UI ništa ne sabira, koristi `operations[]` iz API-ja.
Grupni header: „OP N · RC" + „Σ total kom (good dobar · rework dorada · scrap
škart) · entryCount kucanja".

#### 3.4 Tabovi stranice „Realizacija"

`TABS` (`tech-processes/page.tsx:99`): **Kucanja** (`list`), **Kritični**
(`critical`), **Učinak radnika** (`worker`), **Gotovost RN** (`rn`).

- **Kucanja** — paginirana lista `tech_processes` (`list()`), expand otvara
  Karticu TP.
- **Kritični** — `critical()` (`tech-processes.service.ts:502`): nezavršeni
  postupci čiji RN rok (`production_deadline`, čitan sa `work_orders` preko
  trojke — `tech_processes` nema sopstveni rok) ističe. severity:
  **3** crvena (rok prošao), **2** narandžasta (≤2 dana), **1** žuta (≤7 dana);
  pragovi `CRITICAL_ORANGE_MAX_DAYS=2`, `CRITICAL_YELLOW_MAX_DAYS=7`. Meta nosi
  `severityCounts`.
- **Učinak radnika** — `workerPerformance()`: agregacija komada (po kvalitetu) i
  izvedenog vremena po `worker_id`, filtar `entered_at` (from/to).
- **Gotovost RN** — `rnProgress()`: po RN-u planirano vs napravljeno (%).
  „Napravljeno" = **DOBAR** komadi (kvalitet 0); prednost operacijama
  `significantForFinishing`, fallback na MAX dobar preko svih operacija.

---

### 4. Kontrola i kiosk

#### 4.1 Barkod format (dva barkoda)

Definicija i parser: `tech-processes/barcode.ts`. **Dva** barkoda, svaki 5 polja
(4 separatora `:`):

```
nalog      RNZ:projectId:identNumber:variant:revision
operacija  S:operationNumber:workCenterCode:0:revision
```

- **Polje 5 = `revision`** RN-a (verzioni pečat). Nalog i sve njegove operacije
  dele istu reviziju. Služi dvostruko: (1) „isti otisak" — operacioni barkod mora
  imati istu reviziju kao nalog; (2) detekcija **zastarelog otiska** (poređenje sa
  tekućom `work_orders.revision`, §4.4).
- **Istorija:** legacy QBigTehn je u polju 5 imao `PrnTimer` (`CLng(Timer)`,
  sekunde od ponoći); 2.0 to menja u `revision` (bez reseta i sudara). Polje 4
  operacije = literal `0` (`identMark`; verno legacy `rRN`).
- **Tolerancija skenera** (`parseBarcode`, `barcode.ts:93`, iz prod logova
  2026-07-10): normalizacija `;`→`:` (skener ne stigne da drži Shift) i marker/
  revizija se uppercase-uju (nestabilan CapsLock). Nevalidan ulaz → 400 sa
  prikazom očitanog sadržaja (dijagnostika: pogrešan papir, presečen sken…).

Enkoderi `formatOrderBarcode` / `formatOperationBarcode` su round-trip
kompatibilni sa parserom i koriste se u štampi RN-a i nalepnice.

`POST /barcode/decode` → `decodeBarcode()` (`tech-processes.service.ts:784`):
za **operaciju** razrešava `workCenterName` + `significantForFinishing` (kiosk
grana u KONTROLA režim); za **nalog** razrešava RN + broj operacija u TP-u +
**routing** (`work_order_operations`) — kiosk zna da je operacija „u nalogu" i
kad `tech_processes` red još ne postoji (create-on-scan).

#### 4.2 Prijava rada (`POST /scan`) i create-on-scan

`scan()` (`tech-processes.service.ts:884`):

1. Parsira oba barkoda; `orderBarcode` mora biti nalog, `operationBarcode`
   operacija; revizije se moraju poklapati (isti otisak), inače 400.
2. Machine-access (spec §3.4): identifikovani radnik radi samo na svojim
   mašinama. Poštuje `AUTHZ_ENFORCE` kao guard — enforce → 403; shadow →
   upozorenje `machineAccessWarning` (rad dozvoljen). Test radnici
   (`AUTHZ_TEST_WORKER_IDS`, ODLUKE #32) preskaču proveru.
3. U transakciji: `findOrOpenRoutingTp()` (`tech-processes.service.ts:2503`) —
   **CREATE-ON-SCAN**: nađe red na TEKUĆOJ varijanti RN-a (najviša varijanta,
   `findCurrentWorkOrder`) ili ga OTVORI, pošto validira operaciju protiv routinga
   (`work_order_operations`). 404 ako RN ne postoji; 422 ako operacija nije u
   routingu. Zatvoren red → 422.
4. **Akumulira** `pieceCount += dto.pieceCount`. Ako je dosegnut plan RN-a
   (`newPieceCount >= planned`) → `isProcessFinished=true` + `finishedAt`, i
   `priority=255` na odgovarajućim `work_order_operations` (operacija „skinuta sa
   prioriteta").
5. Ako su SVE značajne operacije završene → `markWorkOrderIfComplete()` označi RN
   (`work_orders.status=true`).

`tech_processes` NEMA kolonu radnog vremena — vreme ostaje izvedeno; scan ne
upisuje vreme.

`finish()` (`POST /:id/finish`) zatvara postupak: `dto.pieceCount ?? postojeći`
ne sme premašiti plan (→ 422), postavlja `isProcessFinished/finishedAt`,
`priority=255`, i eventualno označi RN.

#### 4.3 Završna kontrola (`POST /control`)

`control()` (`tech-processes.service.ts:1787`) je za operacije čiji RC ima
`significantForFinishing=true`. Kontrolor skenira nalog + operaciju + **ID
karticu** (`workerCard` → `workers.cardId`; obavezan audit ko+kada, ODLUKE #14).

- **A-5 provere** (poštuju `AUTHZ_ENFORCE`; enforce → 403, shadow →
  `controllerWarnings`): (1) osoba mora biti **ovlašćen kontrolor**
  (`workerType.additionalPrivileges`); (2) **razdvajanje dužnosti** — ne sme da
  radi završnu nad delom na kome je evidentirao PROIZVODNI rad
  (`selfControlViolation`; kontrolne operacije se ne računaju). Test radnici
  preskaču.
- Operacija mora biti u routingu RN-a i završna kontrola, inače 422.
- 🔴 `ProveriDefinisneKolicine`: zbir `locations[].quantity` = `pieceCount`
  (validacija u DTO); premašaj plana → 422.
- Knjiži `part_locations` (+quantity placement) sa `qualityTypeId` i kontrolorom
  kao izvršiocem.
- **Create-on-scan** (legacy `SacuvajRNSIzUnosaBarKoda`): red kontrole obično ne
  postoji — nađe otvoren ili ga OTVORI; zatvara ga (`isProcessFinished`,
  `finishedAt`, `qualityTypeId`, `workerId`).
- Završna kontrola **implicitno potvrđuje** sve ostale neotkucane/otvorene
  operacije RN-a koje NISU druge značajne (odluka Nesa 2026-07-10): deo koji je
  prošao završnu prošao je i prethodne — one dobijaju `isProcessFinished/finishedAt`,
  bez diranja komada/radnika. Ceo RN silazi sa prioriteta.
- **DORADA/ŠKART** (kvalitet 1/2): knjiži se, ali child RN (`-D`/`-S`) je P2 →
  odgovor nosi `childOrderPending: true`. Posle transakcije, best-effort in-app
  notifikacija tehnolozima + projektantu crteža (`notifyQualityIssue`, D8;
  pad notifikacije NE obara kontrolu).
- Vraća i `label` (podaci za RNZ nalepnicu — front štampa preko proxy-ja).

#### 4.4 staleWorkOrder guard (verzija otiska)

Posle „Prepiši isti postupak" (D5 klon), tekući RN ima veću varijantu od one na
starom odštampanom otisku. Rad se knjiži na TEKUĆU varijantu (red je PINOVAN),
a skenirana varijanta služi samo za guard: `staleWorkOrder = scannedVariant <
currentVariant` (`tech-processes.service.ts:963`). To je **UPOZORENJE, ne
blokada** (memorija „RN barkod verzioni guard"; MODULE_SPEC_stampa §5) — rad se
svejedno evidentira. Vraća se u `scan`/`start`/`stop` odgovoru
(`printedVariant`, `currentVariant`).

#### 4.5 Storno i audited-delete

- **storno** (`POST /:id/storno`, `tech-processes.service.ts:2223`): upisuje
  **KONTRA-red** sa `pieceCount = -n` (radnik ostaje izvorni; neto se poništava),
  guard `n ≤ evidentirano`. Ne briše ništa. Audit u `audit_log` (`action: STORNO`,
  `beforeData` = snapshot izvornog reda).
- **deleteEntry** (`DELETE /:id`, `tech-processes.service.ts:2280`): snapshot reda
  (+ dokumenata) u `audit_log.beforeData`, pa brisanje (red je povratljiv).

#### 4.6 Kiosk (pogon)

`frontend/src/app/kiosk/` — full-screen touch panel, NAMERNO bez AppShell
sidebar-a (poseban obrazac ekrana). Od 12.07.2026 kiosk NEMA nav stavke u 2.0
sidebaru („Kucanje (pogon)"/„Kontrola (pogon)" uklonjene) — ulaz je direktan
URL na terminalima ili 1.0 HUB pločice u oblasti Proizvodnja (iframe deep-link
na `/kiosk`). Glavna komponenta `KioskScanner`
(`_components/kiosk-scanner.tsx`). Tok u 3 koraka:

1. **Prijava** — ID karticom (`onCardScan` → `useIdentifyWorker`) ILI
   auto-prijava iz LIČNOG naloga (`useWorkerMe` → `worker/me`; deljeni nalozi
   `kontrola@`/`tehnologija@` vraćaju null → kartica ostaje obavezna, odluka
   Nesa 2026-07-09).
2. **Skeniraj NALOG** (`onOrderScan` → `decode`): očekuje `RNZ:…`; učitava RN +
   routing.
3. **Skeniraj OPERACIJU** (`onOperationScan` → `decode`): očekuje `S:…`, provera
   revizije protiv naloga. Ako je RC `significantForFinishing` → **KONTROLA**
   režim (`ControlPanel`), inače **prijava rada** (`WorkPanel`).

`WorkPanel` (`_components/work-panel.tsx`) ima dva režima vođena stanjem sesije
(`GET /work/open`): **START** (dugme „Započni rad" → `startWork`; ili „brza
prijava" bez merenja vremena → `scan`) i **STOP** (živi tajmer + stepper komada
→ „Završi rad" → `stopWork`). Dugme „Zatvori operaciju" (→ `finish`) uz potvrdu.
`missing` (operacija van routinga) prikazuje crveno upozorenje.

`ControlPanel` (`_components/control-panel.tsx`): broj iskontrolisanih komada +
kvalitet (Dobar/Dorada/Škart) + raspored po policama (`ComboBox` nad
`usePositions`); indikator „Raspoređeno X / Y" mora biti jednak (klijentska
provera pre `ProveriDefinisneKolicine`). „Završi kontrolu i štampaj nalepnice"
→ `control` + `printControlLabels` (jedna nalepnica po komadu). Ako je kontrola
već urađena → `ReprintPanel` (samo doštampavanje, bez diranja evidencije).

Kiosk feedback (`BigMessage`) ističe: dostignut plan, RN završen, star otisak
(staleWorkOrder), multitasking upozorenje, A-5 upozorenja kontrolora.

---

### 5. Evidencija vremena (A-4)

„Dva skena" (START + STOP) dekomponuje legacy
`tTehPostupak.DatumIVremeUnosa/Zavrsetka` u append-only ledger
`WorkTimeEntry` (`schema.prisma:1705`, tabela `work_time_entries`, NOVA u 2.0):

| Polje | Tip | Značenje |
|---|---|---|
| `id` | Int (PK) | — |
| `techProcessId` | Int | FK ka `tech_processes` (na koji red se knjiži). |
| `workOrderId` | Int? | FK ka RN-u. |
| `projectId`/`identNumber`/`variant`/`operationNumber`/`workCenterCode` | — | Denormalizovan kontekst. |
| `workerId` | Int | Radnik. |
| `startedAt` | Timestamptz | START. |
| `stoppedAt` | Timestamptz? | STOP (NULL = otvorena sesija). |
| `pieceCount` | Int (default 0) | Doprinos komada tog STOP-a. |
| `autoClosed` | Boolean (default false) | Sesija zatvorena cron-om (§5.3). |

- **start** (`POST /work/start`, `tech-processes.service.ts:1402`): otvara sesiju
  (`stopped_at=NULL`) za radnika + operaciju (create-on-scan RN reda). Parcijalni
  unique indeks garantuje najviše jednu otvorenu sesiju po (radnik, operacija) —
  duplikat → 409 (P2002). Otvorena sesija na drugoj operaciji = samo upozorenje
  (`multitaskingWarning`; hard-block je P2). NE dira `tech_processes` (komadi tek
  na STOP).
- **stop** (`POST /work/stop`, `tech-processes.service.ts:1514`): zatvara otvorenu
  sesiju (`stopped_at`, `piece_count`, note) i **akumulira komade na
  `tech_processes`** (isti efekat kao `scan`) + eventualno zatvaranje
  operacije/RN-a. Bez otvorene sesije → single-shot fallback
  (`started_at = stopped_at`).
- **openSession** (`GET /work/open`): vodi kiosk — postoji otvorena sesija → STOP
  režim, inače START.

#### 5.1 View `v_work_sessions` i analitika

Analitika sesija čita **`v_work_sessions`** (view koji ujedinjuje nativne
`work_time_entries` i grublje legacy vreme; `source = 'entry'` = nativni red).
Kalendarske/satne kante kastuju `Timestamptz AT TIME ZONE 'Europe/Belgrade'`
(`SHOP_TZ`, `tech-processes.service.ts:67`) da smena 08–16 ne ispadne „preko
dana".

- **sessionsDaily** — po danu: broj sesija/radnika/komada, utrošeno vreme
  (samo `source='entry'` sa validnim STOP-om), otvoreno.
- **sessionsSummary** — po operaciji: utrošeno vreme (Σ stop−start) vs
  **normirano** (`Tpz + Tk × kom`, iz `work_order_operations`).
- **sessionsHourly** — iskorišćenost po satu.
- **sessionsPoorlyRecorded** — „loše evidentirani": sesije bez ispravnog para
  START/STOP (bez stopa / negativno trajanje / auto-zatvorene / start i stop u
  različitim danima). Čita SAMO nativne `work_time_entries` (legacy „otvoreni"
  postupci su normala).

#### 5.2 Auto-close

`POST /work/auto-close` → `autoCloseOpenSessions()` (`tech-processes.service.ts:1749`):
zatvara sesije `stopped_at IS NULL` starije od `olderThanHours` (default 12h),
postavlja `stopped_at=now`, `auto_closed=true`; komadi ostaju (0 ako nije bilo
STOP-a). Poziva ga **eksterni cron/systemd** (bez nove zavisnosti). NE dira
`tech_processes`. (Memorija „A-4 evidencija vremena": auto-close cron JOŠ nije
zakačen na prod-u.)

---

**Reference (istorija/kontekst, ne prepisivati):**
`backend/docs/design/MODULE_SPEC_radni_nalozi.md`, `MODULE_SPEC_kontrola.md`,
`MODULE_SPEC_stampa.md`, `PLAN_dorade_2026-07-10.md`,
`AUDIT_tehnologija_2026-07-11.md`; memorije „RN barkod verzioni guard",
„A-4 evidencija vremena", „A-5 kontrolor rola".


---

<a id="deo-5--strukture-notifikacije-sync-istorijat"></a>
# DEO 5 — Strukture, Notifikacije, Sync/Cutover, Istorijat, Otvorene odluke

## Proizvodne strukture

Modul **`StructuresModule`** (`src/modules/structures/structures.module.ts`) drži pet
proizvodnih šifarnika iz QBigTehn-a. Registrovan je u `app.module.ts:32`
(`imports`), a svaki šifarnik je zaseban controller + service par:

| Tab (QBigTehn) | Model / tabela | Controller | Prirodni ključ |
|---|---|---|---|
| Radnici | `Worker` / `workers` | `WorkersController` | `id` (Int) |
| Radne jedinice | `WorkUnit` / `work_units` | `WorkUnitsController` | `id`, poslovni ključ `code` |
| Operacije (RC) | `Operation` / `operations` | `OperationsController` | `workCenterCode` (String, `@unique`) |
| Vrste poslova | `WorkerType` / `worker_types` | `WorkerTypesController` | `id` (Int) |
| Radnici po mašinama | `MachineAccess` / `machine_access` | `MachineAccessController` | `id` (par `workerId × workCenterCode`) |

### Ko sme

Svi controlleri stoje iza `JwtAuthGuard + PermissionsGuard`; klasa je označena
`@RequirePermission(PERMISSIONS.STRUKTURE_READ)` za čitanje, a svaka mutaciona
ruta pojedinačno `@RequirePermission(PERMISSIONS.STRUKTURE_WRITE)`
(npr. `workers.controller.ts:50`). Permisija `strukture.write`
(`common/authz/permissions.ts:25`) je u `role-permissions.ts` dodeljena rolama
**`admin`, `sef`, `tehnolog`, `menadzment`** — TEHNOLOG i MENADZMENT su dodati
odlukom Nenad 10.07.2026 (PLAN_dorade §D1, komentar u `role-permissions.ts:69-72`
i `:147-151`) čime se prevazišlo „samo R" iz RBAC matrice. `strukture.read`
imaju gotovo sve role (i CNC programer, kontrolor, magacioner, radnik — kod
radnika/proizvodnog radnika je predviđen row-scope „samo svoj red" preko
`ScopeService`, `role-permissions.ts:127`). AUTHZ_ENFORCE=true je živ na prod-u,
pa nalog bez odgovarajuće role dobija 403 — ako na ekranu nema dugmadi „Nova/Novi…",
prvo se proverava rola naloga (PLAN_dorade, „Ključno otkriće").

### Radnici — CRUD

Rute (`workers.controller.ts`, prefiks `/api/v1/structures/workers`):

| Metoda | Ruta | Permisija | Šta radi |
|---|---|---|---|
| GET | `/workers` | `strukture.read` | lista sa filterima `q`, `workUnitCode`, `workerTypeId`, `active` |
| GET | `/workers/:id` | `strukture.read` | detalj + `machineAccess` (matrica operacija) |
| POST | `/workers` | `strukture.write` | kreiranje |
| PATCH | `/workers/:id` | `strukture.write` | izmena (i reaktivacija `{active:true}`) |
| POST | `/workers/:id/deactivate` | `strukture.write` | soft-delete (`active=false`) |
| DELETE | `/workers/:id` | `strukture.write` | tvrdo brisanje SAMO bez ijedne reference (inače 409) |

Filter `active` (`workers.service.ts:80-82`): default = samo aktivni; `false` =
neaktivni; `all` = svi. Lista je paginirana i po `fullName asc, id asc`.

**Bezbednosno:** `WORKER_SELECT` (`workers.service.ts:22-37`) NIKAD ne vraća ni
prima `password` / `workerPassword` (spec §5.5 — sva auth ide kroz
`users.password_hash`); DTO ta polja uopšte ni nema, servis ih ignoriše. Na
`create` se `password=null`, `workerPassword=""` upisuju kao prazni jer je
`worker_password` NOT NULL bez default-a.

Polja `Worker` (relevantna za autorizaciju; puna šema `schema.prisma:1587`):

| Polje | Tip | Značenje |
|---|---|---|
| `username` | VarChar(50), obavezno | korisničko / skraćeno ime |
| `fullName` | VarChar(50)? | ime i prezime |
| `idNumber` | VarChar(20)? | legacy šifra radnika |
| `cardId` | VarChar(50) | bar-kod ID kartice (kiosk) |
| `loginAccount` | VarChar(50)? | web login account |
| `workUnitCode` | VarChar(5) `@default("0")` | FK-po-vrednosti ka `work_units.code` (bez tvrdog FK) |
| `workerTypeId` | Int `@default(0)` | FK-po-vrednosti ka `worker_types.id` (bez tvrdog FK) |
| `signatureImage` | VarChar(150)? | putanja do slike potpisa |
| `definesApproval` | Boolean? `@default(false)` | „može odobravati primopredaje / saglasnost na RN" |
| `definesLaunch` | Boolean? `@default(false)` | „može lansirati RN" |
| `multiAccount` | Boolean? `@default(false)` | sme više login account-a |
| `commissionPercent` | Float? `@default(0)` | legacy procenat provizije |
| `active` | Boolean? `@default(true)` | soft-delete flag |

**Poslovna pravila permission flag-ova** (`workers.service.ts:327-351`,
`validateFlags`, spec §7.3):
- `definesLaunch=true` zahteva `definesApproval=true` (inače 422).
- `definesApproval=true` dozvoljen SAMO ako naziv vrste posla sadrži „Tehnolog"
  ili „Inžinjer/Inženjer" (inače 422).

Ovi flag-ovi su drugi sloj dvoslojne autorizacije (RBAC §3.2: rola daje
mogućnost `rn.launch`/`rn.approve`, `Worker` flag daje ovlašćenje — oba se
proveravaju u servisu RN-a).

**Reference-guard na DELETE** (`workers.service.ts:250-317`): tvrdo brisanje je
dozvoljeno SAMO za radnika bez IJEDNE reference (čišćenje typo-unosa, PLAN_dorade
odluka #7). Pre-check je iscrpan preko `count`-ova nad 17 relacija (tech_processes,
work_time_entries, work_order_operations, work_orders autor+primopredaja,
machine_access, part_locations, machined/blank/nonstandard parts, handover_drafts
designer, users, drawing_handovers, work_order_launches, work_order_approvals,
drawing_plans, mrp_demand). Ijedan `>0` → **409** „Radnik ima istoriju — deaktiviraj
umesto brisanja." Izuzetak: `app_notifications` (bez FK-a) se NE broji nego se
BRIŠE u istoj transakciji zajedno sa radnikom (orphan inbox bi nasledio sledeći
radnik sa istim id-em). P2003 iz trke se mapira u isti 409.

### Vrste poslova — CRUD i „Ovlašćeni kontrolor"

Rute (`worker-types.controller.ts`, `/api/v1/structures/worker-types`): GET lista
(`q`), POST, PATCH `:id`, DELETE `:id`.

`WorkerType` ima samo `name` (VarChar(50)) i **`additionalPrivileges`** (Boolean).
`additionalPrivileges` je u legacy-ju bio „dodatna prava"; u 2.0 je preimenovan i
tretiran kao signal **„Ovlašćeni kontrolor"** za A-5 završnu kontrolu / kiosk
(`worker-type.dto.ts:6-11`, PLAN_dorade §D1 t.1). Kolona „Dodatna prava" je u UI
sakrivena, ali checkbox u formi ostaje sa novim labelom. (Napomena: 5 imenovanih
kontrolora iz ODLUKE #25 vezuje se na vrstu posla „Kontrola" sa ovim flagom.)

**Brisanje** (`worker-types.service.ts:83-105`): `id=0` („NN") je sistemski zapis
→ 409; 409 i ako ijedan radnik (UKLJUČUJUĆI neaktivne) referiše vrstu
(`workers.workerTypeId` nema FK, pa bi se istorija orphan-ovala).

### Radne jedinice — CRUD

Rute (`work-units.controller.ts`, `/api/v1/structures/work-units`): GET (`q`),
POST, PATCH `:id`, DELETE `:id`. **Brisanje** (`work-units.service.ts:83-106`):
`code="0"` je sistemski default (`workers.workUnitCode @default("0")`) → 409; 409
ako je referišu `operations.workUnitCode` ili `workers.workUnitCode` (nijedno nema
FK — count pre-check je jedini guard). Poruka nabraja brojače.

### Operacije (RC) — CRUD

Prirodni ključ je `workCenterCode`, pa rute idu po šifri
(`operations.controller.ts`, `/api/v1/structures/operations`):

| Metoda | Ruta | Permisija | Šta radi |
|---|---|---|---|
| GET | `/operations` | `strukture.read` | lista (`q`, `workUnitCode`) + broj radnika sa pristupom |
| POST | `/operations` | `strukture.write` | kreiranje (409 na duplu šifru) |
| PATCH | `/operations/:workCenterCode` | `strukture.write` | izmena naziva/RJ/napomene + 4 flag polja |
| DELETE | `/operations/:workCenterCode` | `strukture.write` | brisanje (409 ako je referencirana) |

Četiri flag polja operacije (`schema.prisma:1367`): `withoutProcess`,
`significantForFinishing`, `usesPriority`, `isSkippable`. **Brisanje**
(`operations.service.ts:148-188`): 409 ako je referišu `work_order_operations`,
`machine_access` (FK), ili `tech_processes` / `work_time_entries` (BEZ FK ka
operations → count pre-check da se istorija kucanja ne orphan-uje, PLAN_dorade §D1
t.2). P2003 (bilo koja druga FK referenca) se mapira u isti 409.

### Radnici po mašinama (matrica)

Rute (`machine-access.controller.ts`, `/api/v1/structures/machine-access`):

| Metoda | Ruta | Permisija | Šta radi |
|---|---|---|---|
| GET | `/machine-access` | `strukture.read` | lista (`workerId` ili `workCenterCode`) |
| POST | `/machine-access` | `strukture.write` | dodaj par (409 na duplikat, 404/422 ako radnik/operacija ne postoje) |
| POST | `/machine-access/batch` | `strukture.write` | atomarno `{workerId, add[], remove[]}` (UI matrica) |
| DELETE | `/machine-access/:id` | `strukture.write` | ukloni par |

`batch` (`machine-access.service.ts:158-210`) validira sve `add` kodove protiv
`operations` (422 na nepostojeće), briše `remove`, ne duplira postojeće — sve u
jednoj transakciji. Ova matrica je osnov kiosk enforcement-a (radnik sme da kuca
samo operacije za koje ima `machine_access`).

> Napomena o sekvencama: svaki `create`/`createMany` u strukturama poziva
> `alignIdSequence(tx, "<tabela>")` PRE inserta (npr. `workers.service.ts:154`) —
> jer sync ubacuje eksplicitne legacy id-jeve, pa Postgres sekvenca mora da se
> poravna na MAX(id) da nativni upis ne pukne P2002.

---

## Notifikacije

Modul **`NotificationsModule`** (`app.module.ts:38`) implementira in-app
notifikacije („zvonce", D8 prva faza) nad tabelom **`app_notifications`**
(`schema.prisma:1983`, ručna app-owned migracija):

| Polje | Tip | Značenje |
|---|---|---|
| `id` | Int PK | |
| `type` | VarChar(40) | vrsta: `kontrola.skart` \| `kontrola.dorada` \| `primopredaja.nova` \| `primopredaja.preuzeta` (String, ne enum — BACKEND_RULES §2) |
| `message` | VarChar(500) | ceo srpski tekst, renderovan pri emit-u (seče se na 500) |
| `refTable` | VarChar(40)? | tabela za UI navigaciju (`work_orders` \| `handover_drafts` \| `drawing_handovers`) |
| `refId` | Int? | id referenciranog reda |
| `recipientWorkerId` | Int | primalac = `workers.id` (bez tvrdog FK) |
| `createdAt` | Timestamptz | |
| `readAt` | Timestamptz? | `null` = nepročitana |

Index `idx_app_notifications_recipient_read_created` (`recipientWorkerId, readAt,
createdAt desc`) pokriva i inbox listu i unread-count.

### REST (čitanje / mark-read)

Controller (`notifications.controller.ts`) traži SAMO `JwtAuthGuard`, **bez
posebne permisije** (odluka D4): svako vidi ISKLJUČIVO svoje notifikacije, filter
po `request.user.workerId` (`users.worker_id` most). Nalog bez vezanog radnika
(deljeni terminali `kontrola@`, `tehnologija@`) ima prazan inbox — nije greška.

| Metoda | Ruta | Šta radi |
|---|---|---|
| GET | `/api/v1/notifications` | inbox radnika (`unreadOnly`, `limit` default 30, cap 100) |
| GET | `/api/v1/notifications/unread-count` | broj nepročitanih (badge; cilj polling 30 s) |
| POST | `/api/v1/notifications/:id/read` | označi pročitanu (403 ako je tuđa; idempotentno) |
| POST | `/api/v1/notifications/read-all` | označi sve svoje kao pročitane |

Frontend zvonce u AppShell-u radi React Query polling na `/unread-count` na 30 s.

### Emit tačke

Jedina write-tačka je `NotificationsService.notifyWorkers(workerIds, payload)`
(`notifications.service.ts:52-69`): dedup primalaca, izbacuje 0/null, jedan red po
primaocu, seče poruku na 500. **Svako emit mesto je OBAVEZNO u try/catch** — pad
notifikacije ne sme oboriti poslovnu mutaciju uz koju ide (PLAN_dorade §D8). Sve
se poziva POSLE uspešne transakcije (best-effort van transakcije).

Tri logička emita (+ take-over):

1. **Kontrola: škart / dorada** — `tech-processes.service.ts:2570-2602`
   (`notifyQualityIssue`). Kada završna kontrola knjiži kvalitet ≠ dobar, šalje se
   `kontrola.skart` (ili `kontrola.dorada`) sa porukom „ŠKART/DORADA na RN … op …
   — kontrolor …, N kom", `refTable="work_orders"`. Primaoci: **grupa TEHNOLOG**
   (`resolveTechnologistWorkerIds`) **+ best-effort projektant crteža**
   (`resolveWorkOrderDesignerId`, `:2613`) — lanac work_order → drawingHandoverId →
   drawing_handovers.drawingId → stavka nacrta → `handover_drafts.designerId`, uz
   fallback na `drawings.designedBy` string ↔ `workers.fullName`. Legacy je
   notifikovao I doradu I škart (odluka Nenad, PLAN_dorade §6 t.6).

2. **Nova primopredaja** — `handover-drafts.service.ts:969-999` (`notifySubmitted`,
   poziva se iz `submit()` na `:959`). Poruka „Kreirana nova primopredaja
   {draftNumber} — {N} stavki (projektant {ime})", `type="primopredaja.nova"`,
   `refTable="handover_drafts"`. Primaoci: **grupa TEHNOLOG**.

3. **Preuzimanje izrade (take-over)** — `handovers.service.ts:545-572`
   (`notifyTakeOver`). Kada tehnolog preuzme tuđu primopredaju, prethodnom
   tehnologu ide `primopredaja.preuzeta` „NN je preuzeo izradu za primopredaju X",
   `refTable="drawing_handovers"`.

**Kriterijum „grupa TEHNOLOG"** je jedan izvor istine
(`common/workers/technologist-criteria.ts`): aktivni radnici čija je vrsta posla
po NAZIVU „Tehnolog" (case-insensitive, ne hard-kodiran id — prod id 1). Isti
helper koristi `GET /handovers/technologists`, validacija u `approve()` i
take-over gate. `defines_approval` NAMERNO nije deo ovog kriterijuma (ostaje
zaseban RN-level gate). Dva batch upita bez required JOIN-a (legacy-read pravilo —
orphan `workerTypeId` ne sme 500).

### D8-v2 backlog (email)

Druga faza (PLAN_dorade §„D8-v2 BACKLOG", Nenad „veoma korisna opcija") još NIJE
implementirana:
- **Odmah po škartu** (naročito totalnom): email na `proizvodnja@servoteh.com` +
  `uprava@servoteh.com` sa sumiranim brojem utrošenih sati za taj komad (Σ vremena
  iz `tech_processes`).
- **Nedeljni izveštaj**: ukupan škart + troškovi (troškovi = sati × cena sata —
  satnice još ne postoje).
- Preduslov: **SMTP/mail infrastruktura** (nova zavisnost — odluka gde šalje:
  backend direktno ili firmina infrastruktura). Nije deo prve faze (in-app zvonce).

---

## Sync i Cutover

Modul **`SyncModule`** (`app.module.ts:28`) radi „na dugme" sync matičnih
podataka iz QBigTehn (MSSQL) u Postgres. Vodeći princip (ODLUKE 2026-07-08,
memorija „QBigTehn sync privremen, BigBit trajan"): **QBigTehn sync je PRIVREMEN
(proba + jednokratni finalni uvoz, pa se gasi); BigBit matični sync (vasa-SQL)
je TRAJAN.** Od prve realne upotrebe tehnolog piše direktno u proizvodne tabele,
pa ponovni sync NE SME da pregazi ručno unete redove.

### Registracija syncera i redosled

`SyncService` konstruktor (`sync.service.ts:39-81`) registruje syncere u
namernom redosledu (`register` radi delete-then-set → pomera entitet na KRAJ
insertion order-a Mape):
1. Ručni `CustomerSyncer` (bespoke FK logika) — prvi.
2. `GenericSyncer` za svaki maprani entitet iz `sync-map.generated.ts`.
3. `HandoverDerivationSyncer` — POSLE generic petlje (zamenjuje generic
   `PrimopredajaCrteza` mapiranje, čiji je izvor prazan; mora posle `work_orders`
   re-importa zbog remap-a).
4. Šest §5.3 chain-item syncera — POSLEDNJI (svi parent-i uvezeni pre njih).

Kontroler (`sync.controller.ts`): `POST /sync/run` (`sync.run`, praktično
admin-only), a `GET /sync/state`, `/state/:entity`, `/log`, `/log/:id`, `/health`
iza `sync.read`. `POST /sync/run` prima `{entities?, strategy?, force?}`; jedan
`bb_sync_log` red po pokretanju, `bb_sync_state` kursor po entitetu; in-process
guard sprečava preklapanje dva run-a.

### Derivacioni syncer (tRN → drawing_handovers)

`HandoverDerivationSyncer` (`syncers/handover-derivation.syncer.ts`): legacy
primopredaja NE živi u `PrimopredajaCrteza` (prazna i na živom MSSQL) nego kao
atributi `tRN` reda (~3.4k redova sa `IDPrimopredaje > 0`). Syncer izvodi po jedan
`drawing_handovers` red iz svakog takvog `tRN` reda (JOIN na `tSaglasanRN` /
`tLansiranRN` za saglasnost/lansiranje) da tabovi Na čekanju/Odobrene/Sve imaju
podatke pre cutover-a.

**ID politika (namerna):** derivirani red dobija NATIVNI autoincrement `id`;
ključ derivacije je `uq legacy_rn_id` (= `tRN.IDRN`), pa je upsert idempotentan i
strukturno NE MOŽE pregaziti nativne 2.0 redove (`id = IDRN` je odbačen). Post-korak
remap-uje `work_orders.drawing_handover_id` (generic tRN mapiranje je tu upisalo
`IDPrimopredaje` = id NACRT grupe, semantički pogrešno) u pravi izvedeni handover
id. Zato force re-import `work_orders` MORA ići kao
`entities:["work_orders","drawing_handovers"]` da remap ide POSLE re-importa.

### Zaštita ServoSync-owned tabela

`table-ownership.ts` deli svet na dva skupa:

- **`OWNED_PRODUCTION_TABLES`** (`table-ownership.ts:13`) — ~30 proizvodnih/tehnoloških
  tabela u vlasništvu ServoSync-a (work_orders*, tech_processes*, operations,
  workers, worker_types, machine_access, handover_drafts*, drawing_handovers,
  drawing_plan_items, planner_*, positions, part_locations…). `GenericSyncer`
  (`generic.syncer.ts:55-68`): za full-refresh nad ovakvom tabelom koja VEĆ ima
  redove, run se **preskače** (nema delete) osim ako je `force:true` — vraća note
  „Preskočeno (zaštita)…". Time seed sync ne briše ručno unete redove.

- **`QBIGTEHN_CHAIN_ENTITIES`** (`table-ownership.ts:81`) — PRIVREMENI deo lanca
  (PDM crteži/BOM/PDF, nacrti/primopredaje, RN + stavke, TP, nalepnice/lokacije,
  jednokratno seed-ovani proizvodni šifarnici, planer). Sve ostalo u
  `sync-map.generated.ts` što NIJE u ovom skupu = TRAJNI BigBit matični sync
  (komitenti, predmeti, artikli, magacini, MRP_*, cenovnik, robni dokumenti,
  registri/CFG…). Na cutover-u se ceo ovaj skup UKLANJA IZ REGISTRACIJE (ne
  runtime „skip" flag — mrtav kod se briše).

### §5.3 chain-item synceri (SAMO force:true)

Šest tabela nema generisano mapiranje pa ih pokriva `LegacyChainItemSyncer`
(`syncers/legacy-chain-item.syncer.ts`) + 6 izvedenih:

| QBigTehn izvor | Postgres cilj |
|---|---|
| `tPDM` | `work_order_machined_parts` |
| `tPLP` | `work_order_blanks` |
| `tPND` | `work_order_nonstandard_parts` |
| `tSaglasanRN` | `work_order_approvals` |
| `PDM_PlaniranjeStavke` | `drawing_plan_items` |
| `PrimopredajaPDFCrteza` | `drawing_handover_pdfs` |

Dve namerne razlike od generic-a (`legacy-chain-item.syncer.ts:108-182`): (a) rade
**ISKLJUČIVO uz `force:true`** — bez force su no-op čak i nad PRAZNOM tabelom
(strože od owned-table pravila; sprečava da običan „all entities" run uvuče celu
legacy istoriju pre cutover freeze-a); (b) forsiran run prvo radi `deleteMany`
(sve su LEAF tabele) → rezultat je TAČNA kopija legacy-ja i verifikacioni report
sme da traži COUNT/MAX(id) paritet; uklanja i id-koliziju sa nativnim
autoincrement redovima. Redovi se upisuju jedan po jedan sa UKLJUČENIM FK
constraint-ima (red sa nedostajućim parent-om se PRESKAČE i prijavi, ne ubacuje
kao orphan). Posle uvoza syncer sam poravna sekvencu (`alignIdSequence`, `:171`).

### Cutover — redosled (runbook 17)

`docs/migration/17-cutover-runbook.md`. Redosled je NEPREGOVARAN — ponovni sync
posle nativnih upisa TIHO GAZI 2.0 redove:

```
1. FREEZE legacy         — revoke write za APL naloge na QBigTehn (niko više ne unosi)
2. Poslednji ciklus      — sačekati 10-min XML/PDF skripte + ručni uvoz zaostalih fajlova
3. FINALNI sync u 2.0    — force/full refresh (reset kursora u bb_sync_state); §5.3
                           synceri uvoze SAMO u ovom force run-u, pa poravnaju sekvence
4. VERIFIKACIJA          — node tools/cutover-verify/cutover-verify.mjs (exit 0 OBAVEZAN;
                           COUNT/MAX(id), derivacija, MAX RN ordinal, soft-FK orfani, PDF blobovi)
5. SETVAL poravnanje     — alignIdSequence za sve tabele lanca
6. GAŠENJE sync-a lanca  — izbaciti qbigtehn tabele iz sync mape (split trajni/privremeni),
                           obrisati derivacioni + §5.3 synceri; deploy backenda
7. OTKLJUČAVANJE         — HANDOVER_LEGACY_GUARD=false (env, isti rollback obrazac kao
                           AUTHZ_ENFORCE); bridge u AKTIVNI mod; ugasiti legacy 10-min skripte
8. SMOKE OBA TOKA        — Tok A (primopredaja): XML → crtež → nacrt → submit → approve →
                           Otkucaj TP → štampa → lansiraj → kucanje na kiosku → kartica TP
                           Tok B (blanko RN): POST /work-orders → operacije → approve → launch;
                           za RN vezan za primopredaju: izvor prelazi na status 3 (LANSIRAN) + is_locked
```

Do koraka 6 rollback je trivijalan (vratiti write legacy nalozima, 2.0 podaci od
freeze-a se odbacuju force sync-om). Posle koraka 7 rollback traži ručno vraćanje
nativno unetih podataka — zato smoke test (korak 8) ide ISTOG dana.

**Tranzicioni guard `HANDOVER_LEGACY_GUARD`** (`handovers.service.ts:583-588`):
do cutover-a se derivirane primopredaje (`legacyRnId != null`) NE smeju
odobravati/odbijati/lansirati u 2.0 (409) — to se radi u QBigTehn-u (Miljan), inače
bi mutaciju pregazio sledeći sync. Skida se env flag-om na cutover-u; kolona
`legacy_rn_id` ostaje kao provenance.

### Rizici

- **Ponovni (ne-force) sync gazi nativne redove** — ublaženo `OWNED_PRODUCTION_TABLES`
  zaštitom (preskače full-refresh sa redovima) i §5.3 „samo force" no-op-om; ipak,
  `force:true` je destruktivan i rezervisan za cutover freeze.
- **Redosled entiteta** kod force re-importa `work_orders` bez `drawing_handovers`
  u istom pozivu ostavlja pogrešan `drawing_handover_id` (remap ne bi otišao).
- **Per-row greške se ne persistiraju** (AUDIT nalaz #7) — kursor preskače
  preskočene redove; verifikacioni report je mreža za paritet.

---

## Istorijat razvoja (talasi)

Hronologija (grana `feat/wave-3`, `git log origin/main`; datumi iz ODLUKE.md /
PLAN docova). Ranije faze P0–P3 su isporučene do 10.07, P4 lanac i dorade
10–11.07.

| Faza / datum | Ključni commit-i | Isporučeno |
|---|---|---|
| **P0/P1 — tok tehnologa** (10.07) | `c35b72d` technologist workflow — approve assignment, TP typing flow, undo | Odobravanje primopredaje + dodela tehnologa, „Otkucaj TP" tok, undo; osnov toka A |
| **P1 kiosk / kontrola** (09–10.07) | `b16580e` create-on-scan za sve operacije + final control confirms, `afe6a3f`/`4ecb8c6` server-side label print + kiosk unblock, `95dea2e` test nalog | Kiosk create-on-scan, završna kontrola zatvara neotkucane operacije, štampa nalepnica kroz backend (TSPL2 → 9100) |
| **P2 — kartica TP (agregat)** (10.07) | `30facb7` per-operation aggregates on TP card | Zbir po operaciji na kartici tehnološkog postupka |
| **P3 — print-bundle** (10.07) | `4c27965` print-bundle — merged drawing PDFs grouped by paper format | Spojeni PDF crteži grupisani po formatu papira (bolje od legacy „print na default štampač") |
| **P4a — XML/PDF intake + derivacija + bridge** (10.07) | `7d42f24` native XML+PDF import (`POST /pdm/import`, `/pdm/pdf-import`), `cc90f50` derive drawing_handovers from legacy tRN + transition guard, `bd40b87` pdm-bridge folder watcher + cutover runbook + dorade plan | Nativni PDM uvoz (bez SQL sync-a), derivacioni tRN→drawing_handovers syncer + HANDOVER_LEGACY_GUARD, pasivni bridge + runbook 17 |
| **D8 notifikacije** (10.07) | `26d3538` in-app notifications for scrap/rework and new handovers | `app_notifications` + zvonce, emit škart/dorada i nova primopredaja |
| **Dorade 10 tačaka** (10–11.07) | `65f6f70` structures delete + activate + wider write, `72922bc` clone-variant + CAM priority + project customer lookup | D1–D4 (DELETE/aktivacija struktura + strukture.write za tehnolog/menadzment), D5 clone-variant (MAX+1, oživljava kiosk stale-guard), D7 CAM prioritet, D9 komitent iz predmeta, D10 preimenovanja („Realizacija") |
| **Dubinski audit** (11.07) | `4753f80` apply verified deep-audit findings, `b55281e` deep-audit report | 12-agentni audit: **49 nalaza, 47 primenjeno** (trke/statusna mašina, validacija 400 umesto 500, NUL-bajt higijena, 7 setval → `alignIdSequence`, frontend `Can()` na 6 mesta, landing `/syncs`→`/work-orders`); 205→219 testova |
| **P4b/c/d — cutover priprema** (11.07) | `033ea9d` technologist by worker type + take-over + approval deadline, `98f8329` bureau roles + draft item preconditions + disputed-items engine, `792da67` qbigtehn chain split + one-time chain-item syncers + cutover verify, `b687709` pdm-bridge commissioning package (P4c), `6ca57cc` align id sequences before native import | Tehnolog-kriterijum (jedan izvor istine), take-over primopredaje, rok odobravanja; biro role (`inzenjer`/`projektant_vodja` rana aktivacija), preduslovi stavki nacrta, engine spornih stavki; split trajni/privremeni sync + 6 §5.3 syncera + `cutover-verify.mjs`; bridge commissioning + poravnanje sekvenci |

---

## Otvorene odluke i backlog

Nalazi koji TRAŽE odluku pre / oko cutover-a (AUDIT_tehnologija_2026-07-11 §3–§4,
runbook 17 §1, ODLUKE.md). „Ko odlučuje" je iz izvornih docova.

| Tema | Status / opis | Ko odlučuje |
|---|---|---|
| **ODLUKE #3/#12 revizija** | Docovi i dalje kažu „PDM = direktan SQL", a isporučen je (i deployovan) nativni XML+PDF intake — formalizovati reviziju | Negovan (potpis; preduslov runbook §1) |
| **`draft_id` kolona** | Dodati `drawing_handovers.draft_id` kao zamenu za `resolveDraftContext` heuristiku (lanac bez FK-a) | Negovan (preduslov runbook §1) |
| **Brisanje lansiranog RN-a** | Ostavlja primopredaju trajno zaključanu u LANSIRAN bez RN-a (ćorsokak, nema recovery) — zabraniti brisanje ili uvesti recovery akciju | Miljan / Negovan (AUDIT #1) |
| **Semantika undo kad RN postoji** | Storno RN-a ili blokada? | Miljan / Negovan (runbook §1) |
| **Kontrola knjiži na skeniranu varijantu** | `control()` knjiži na SKENIRANU, scan/start/stop na TEKUĆU varijantu → stari papir tiho zatvara staru varijantu bez upozorenja. Treba li kontrola isti `staleWorkOrder` tok kao kucanje? | Negovan (AUDIT #2) |
| **`lookups` rute bez permisije** | Zaobilaze `DIRECTORY_READ` uz živ enforce — potvrditi pa dodati guard (koordinacija sa paralelnom sesijom) | potvrda + fix (AUDIT #3) |
| **Default rola `user` bez permisija** | Uz `AUTHZ_ENFORCE=true` nema nijednu permisiju (komentar obećava mapiranje u `viewer`) — treba odluka + migracija rola | Nesa / Luka (AUDIT #5) |
| **PDF aktivni-mod handling** | Bridge posle cutover-a prelazi u aktivni mod (move u Importovano/Neuspelo) — potvrditi ponašanje na greškama uvoza | operativa (runbook §7, §4) |
| **D8-v2 email** | Email škarta na `proizvodnja@`/`uprava@` + nedeljni izveštaj — traži SMTP/mail infrastrukturu (nova zavisnost, gde šalje) | Nenad + odluka o infrastrukturi |
| **Magacin alata** | Uvezati magacin alata da tehnolozi vide dostupnost pri pisanju TP (posle cutover-a; pitati gde alat danas živi) | backlog (memorija) |
| **Sync gubi per-row greške** | Ne persistiraju se, kursor preskače preko preskočenih redova — dizajn za cutover verifikaciju | dizajn (AUDIT #7) |

**Gap ka cutover-u — svesni jazovi vs QBigTehn** (AUDIT §4, na kritičnom putu):

| Jaz | Stanje | Potrebno |
|---|---|---|
| **PND/PDM/PLP stavke TP-a** | backend samo kopira (`copy-from`); nema CRUD ni UI (legacy tabovi Stavke/PND/PDM/PLP) | CRUD + UI |
| **Skice operacija** | model postoji, endpoint/UI ne | endpoint + UI |
| **BOM auto-populate nacrta** | legacy izbor sklopa auto-ubacuje sve delove sa preračunom količina | engine + UI |
| **OdlukePredProvera** | decision engine (duplikati + Isključi/Predaj ponovo/Dopuni + gate pre lansiranja) | engine (delom pokriven `disputed-items` u `98f8329`) |
| **Tier B-5 pregledi** | „Evidencija u proizvodnji" (Zbir/ZbirGrupno) — preduslov A-4 isporučen | pregledi |
| **Sitno** | nabavni deo iz XML-a se ne upisuje u artikle (svesno, §11.1 overlay); PDF filename heuristika za crteže sa `_`; drawing status → PREDAT na submit; reject-notifikacija projektantu | inkrementalno |

> Kontekst odlučivanja: „dok je 2.0 razvojna, gura se direktno na `main`"; poslovnu/podatkovnu
> semantiku (undo, brisanje lansiranog, kontrola-varijanta, magacin) potvrđuje **Negovan/Miljan**,
> tehničke sitnice (rola `user`, timestamp politika) **Nesa/Luka**, a obim/prioritete **Nenad**.

# Servosync — Backend Architecture v1

| | |
|---|---|
| **Verzija** | 1.1 |
| **Datum** | maj 2026 |
| **Status** | Draft za prvu implementaciju (V1) |
| **Skop** | Zamena proizvodnog dela QMegaTeh sistema |
| **Tip projekta** | Internal enterprise application |
| **Vlasnik** | Servoteh d.o.o. |

---

## 0. Predgovor — kako koristiti ovaj dokument

Ovo je **strateški referentni dokument** za sve developere koji rade na projektu Servosync. Sadrži arhitektonske odluke, naming conventions, stack izbor, modularnu strukturu, plan po fazama i sve ostalo što developer treba da zna pre prvog `git commit`-a.

**Pre nego što napišete bilo koji kod — pročitajte ovaj dokument do kraja.**

Pravilo: ako neka tehnička odluka **NIJE** opisana ovde, raspravlja se sa arhitekt-om i dodaje u sledeću verziju ovog dokumenta. Ne donositi ad-hoc odluke koje će kasnije biti težak refaktor.

Pratiće ga:
- `SCHEMA_PLAN.md` — kompletna Prisma šema sa svim tabelama
- `MODULES_SPEC.md` — specifikacija svakog poslovnog modula (PDM, RN, MRP, ...)
- `CURSOR_INSTRUCTIONS_SPRINT_*.md` — konkretni zadaci za Cursor agenta po sprintu

---

## 1. Cilj projekta

Zameniti proizvodni deo postojećeg QMegaTeh sistema (Microsoft Access front-end + SQL Server backend) modernim web-baziranim sistemom koji:

- Pokriva **9 funkcionalnih modula** koje Servoteh aktivno koristi (PDM, Nacrti, Primopredaje, Radni nalozi, Proizvodnja, Lokacije delova, Proizvodne strukture, Nabavka uvid, Komitenti pregled)
- Drži se istih poslovnih pravila kao postojeći QMegaTeh (zato da prelazak korisnika bude minimalan)
- Eliminiše tehnički dug nasleđenog Access okruženja (deprecated tehnologija, single-machine bottleneck, ULS security model, hardkodirana imena)
- Daje **moderan UX**: web/mobilni pristup, real-time updates, performance, scalability
- Otvara prostor za buduće funkcionalnosti (AI asistencija, OCR, mobilna app za radnike, BI dashboardi)

**NIJE u skopu V1:**

- Knjigovodstvo, fakturisanje, PDV, KEPU, POPDV, fiskalizacija — sve to ostaje u BigBit-u
- AI funkcionalnosti (OCR, auto-knjiženje) — kasnije
- Bar-kod stanice za radnike na operacijama — TBD na osnovu user feedback-a (možda V2)
- Mobilna app — V2+
- Power BI dashboardi — V2+

---

## 2. Tehnološki stack

### Backend
- **Runtime:** Node.js 22 LTS
- **Framework:** NestJS 10+
- **ORM:** Prisma 5+
- **Database:** PostgreSQL 16
- **Validation:** class-validator + class-transformer
- **API docs:** Swagger / OpenAPI (auto-generated)
- **Testing:** Jest + supertest
- **Job scheduler:** `@nestjs/schedule` (za BigBit sync cron)
- **External DB driver:** `mssql` paket (za BigBit SQL Server konekciju)

### Frontend
- **Framework:** Next.js 14+ (App Router) sa React 18+
- **Stilovi:** Tailwind CSS
- **State management:** TanStack Query (server state) + Zustand (client state)
- **Forms:** React Hook Form + Zod validacija
- **UI library:** shadcn/ui (Radix-based komponente, copy-paste model — nije npm dependency)
- **Tabele:** TanStack Table (za sve grid-ove proizvodnje, MRP-a, izveštaja)
- **Type sharing sa backend-om:** auto-generisani TypeScript tipovi iz Swagger spec-a kroz `openapi-typescript` alat (ne shared paket — vidi sekciju 4)

### Infrastruktura (V1 — dev)
- **Containerization:** Docker + Docker Compose
- **Local dev:** Postgres u Docker-u (port 5435 — već podignuto)
- **Source control:** Git + GitHub/GitLab (TBD)
- **CI/CD:** GitHub Actions ili GitLab CI (TBD)

### Infrastruktura (V2 — prod)

**Preporučeno: Servoteh on-prem Linux server** (vidi razloge u nastavku):

- **Server:** Servoteh interni Linux server (Ubuntu 24.04 LTS preferred)
- **OS hardening:** standardno (firewall, SSH key auth, automatic security updates)
- **Reverse proxy:** Caddy (auto-HTTPS sa Let's Encrypt) — preferred zbog jednostavnosti, alternativa je Nginx
- **Database:** PostgreSQL 16 native install (ne Docker u prod)
- **Backup:** `pg_dump` cron + rsync na drugi Servoteh server / NAS
- **Monitoring:** TBD (preporuka: Grafana + Prometheus, ili Datadog)
- **DNS:** internal Servoteh DNS + opcionalno external DNS (`servosync.servoteh.rs` ili sl.) za pristup van firme
- **VPN:** OpenVPN ili WireGuard za eksterni pristup (radnici van firme)
- **UPS:** uninterruptible power supply (verovatno već postoji)

**Razlozi za on-prem (ne cloud) u V1:**

1. **BigBit konekcija** — sync sa BigBit SQL Server-om (`Vasa-SQL,5765`) radi preko interne LAN mreže (gigabit, 1ms latency). Cloud bi zahtevao VPN tunel sa Servoteh mrežom, što unosi failure point
2. **Performance** — sync 50.000+ artikla iz BigBit-a na LAN traje minute, preko interneta sat vremena
3. **Suverenitet podataka** — proizvodne podatke ne hostuje treća strana
4. **TCO 5+ godina** — jednokratni hardware (~$2-3K) je jeftiniji od $30-50/mesec cloud-a
5. **Jednostavnost** — `docker-compose up -d`, jedan server, jedan deployment

**Cloud (DigitalOcean ili Hetzner) može biti razmotren u V2 ako:**

- Servoteh otvori novu lokaciju i treba multi-site pristup
- Pravimo SaaS proizvod od ovog sistema za prodaju drugim firmama
- Servoteh ne ima (ili ne želi) sopstvenu IT operaciju za održavanje servera

### External integracije
- **BigBit SQL Server** (`Vasa-SQL,5765`, baza `QBigTehn`) — **read-only** sync za master data
- **SolidWorks PDM** — XML import za PDM crteže (file-drop watcher ili API integration TBD)
- **Email** — SMTP za notifikacije (TBD koja servis: Servoteh sopstveni mail server, SendGrid, Postmark)
- **AD/Entra ID** — V2, opcionalno za SSO

---

## 3. Visoka arhitektura

### Modular Monolith pattern

Sistem se gradi kao **modularni monolit** — jedan deployable artefakt sa jasno odvojenim modulima. **Ne mikroservisi** (suviše složeno za tim od 3 čoveka, suviše operativnog overhead-a).

NestJS prirodno podržava modularnu organizaciju kroz `@Module()` dekorator. Svaki poslovni domen (PDM, RN, Proizvodnja, ...) je zaseban NestJS modul sa sopstvenim controller/service/dto/entity slojem.

### Visok-nivo dijagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    Frontend (TBD framework)                      │
│                  Web browser, eventually mobile                  │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTP/JSON
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│              NestJS Backend (Modular Monolith)                   │
│                                                                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌────────┐  │
│  │  auth   │  │partners │  │projects │  │ workers │  │  ...   │  │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └────────┘  │
│                                                                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌────────┐  │
│  │drawings │  │handovers│  │work_ord │  │production│ │locations│ │
│  │  (PDM)  │  │ (primop)│  │  (RN)   │  │           │  │       │ │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └────────┘  │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  bigbit_sync (cron + on-demand)                             │ │
│  │  Connects to QBigTehn via mssql, pulls master data daily    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Common: prisma, audit, exceptions, validation, logging         │
└──────────────────────────┬───────────────────────────────────────┘
                           │
              ┌────────────┴───────────────┐
              ▼                            ▼
   ┌────────────────────┐         ┌────────────────────┐
   │  Postgres 16       │         │  BigBit SQL Server │
   │  servosync DB      │ <───────│  Vasa-SQL,5765     │
   │  (own data)        │  sync   │  QBigTehn          │
   │                    │  one-way │  (read-only)       │
   └────────────────────┘         └────────────────────┘
```

### Tok podataka

**Read flow (korisnik gleda RN):**
1. FE šalje GET /api/v1/work-orders/:id sa JWT u Authorization header-u
2. NestJS auth guard validira JWT
3. Controller poziva service
4. Service kroz Prisma query povlači work_order + relation-e (komitent, predmet, stavke, postupci)
5. DTO mapper transformiše Prisma model u response shape
6. Response ide nazad sa svim potrebnim podacima

**Write flow (korisnik kreira RN):**
1. FE šalje POST /api/v1/work-orders sa request body
2. Auth guard validira
3. ValidationPipe (class-validator) validira shape
4. Service izvršava biznis logiku u Prisma transaction-u (insert work_order + insert process routing iz template-a + audit log)
5. Domain event se emituje (WorkOrderCreatedEvent) — listeneri reaguju (npr. notification service šalje email tehnologu)
6. Response sa kreiranim entity-jem

**Sync flow (BigBit → Servosync):**
1. Cron triger u 02:00 svake noći
2. `BigbitSyncService` se konektuje na BigBit SQL Server preko `mssql` paketa
3. Poziva read query-je: `SELECT * FROM Komitenti WHERE LastModified > :cursor`
4. Za svaki batch: upsert u Servosync Postgres (`partners` tabela)
5. Audit log u `sync_log`: koliko zapisa, vreme, greške
6. Email notifikacija admin-u ako sync padne

---

## 4. Repo strategija i folderska struktura

### Dva odvojena repo-a

Projekat se gradi kao **dva nezavisna Git repo-a**:

- **`servosync-backend`** — NestJS aplikacija
- **`servosync-frontend`** — Next.js aplikacija

**Razlozi za dva repo-a (umesto monorepo-a):**
- Jednostavnija deployment pipeline-a — svaki repo ima sopstveni GitHub Actions workflow, sopstvene tagove, sopstvene release-ove
- Različiti developeri mogu da rade nezavisno (BE dev ne vidi FE kod, FE dev ne vidi BE kod)
- Manji repo-i, brži CI, manje konflikte na merge-u
- Jasna granica vlasništva — BE tim odgovara za `servosync-backend`, FE tim za `servosync-frontend`

### Type sharing između BE i FE

Pošto nemamo monorepo sa shared paketom, TypeScript tipove sinhronizujemo kroz **OpenAPI spec auto-generaciju**:

1. NestJS automatski generiše OpenAPI/Swagger spec iz DTO-ova i kontroler dekoratera (`@ApiProperty`, itd.)
2. Spec je dostupan na `/api/docs-json` endpoint-u backend-a
3. Frontend repo ima script (`pnpm gen:api-types`) koji koristi `openapi-typescript` alat za generisanje TypeScript tipova iz tog spec-a
4. Generated types fajl ide u `src/types/api.ts` u FE repo-u (gitignored, regeneriše se pri build-u)
5. CI proverava da generated types match commit-ovani fajl — sprečava da neko zaboravi da regeneriše

```bash
# u frontend repo-u
pnpm gen:api-types
# generiše src/types/api.ts iz http://localhost:3000/api/docs-json
```

### Backend repo struktura (`servosync-backend`)

```
servosync-backend/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.module.ts
│   │   │   ├── auth.controller.ts
│   │   │   ├── auth.service.ts
│   │   │   ├── strategies/
│   │   │   │   └── jwt.strategy.ts
│   │   │   ├── guards/
│   │   │   │   └── jwt-auth.guard.ts
│   │   │   └── dto/
│   │   │       ├── login.dto.ts
│   │   │       └── register.dto.ts
│   │   ├── users/
│   │   ├── partners/                    ← komitenti
│   │   ├── projects/                    ← predmeti
│   │   ├── workers/                     ← radnici
│   │   ├── work-units/                  ← radne jedinice (RJ)
│   │   ├── work-centers/                ← radni centri (RC)
│   │   ├── operations/                  ← operacije po radnim jedinicama
│   │   ├── job-types/                   ← vrste poslova
│   │   ├── worker-machines/             ← matrica radnik × mašina
│   │   ├── drawings/                    ← PDM crteži
│   │   ├── boms/                        ← sastavnice
│   │   ├── drafts/                      ← nacrti
│   │   ├── handovers/                   ← primopredaje
│   │   ├── work-orders/                 ← radni nalozi (RN)
│   │   ├── process-routings/            ← tehnološki postupci
│   │   ├── operation-logs/              ← kartica tehnoloskog postupka
│   │   ├── production/                  ← pregled, dinamika izrade, analiza dnevnih aktivnosti
│   │   ├── locations/                   ← lokacije delova
│   │   ├── mrp/                         ← planiranje materijala
│   │   ├── procurement-view/            ← nabavka uvid
│   │   └── bigbit-sync/                 ← sync sa BigBit-om
│   ├── common/
│   │   ├── decorators/
│   │   │   └── current-user.decorator.ts
│   │   ├── filters/
│   │   │   └── all-exceptions.filter.ts
│   │   ├── interceptors/
│   │   │   └── audit-log.interceptor.ts
│   │   ├── pipes/
│   │   │   └── validation.pipe.ts
│   │   └── utils/
│   ├── prisma/
│   │   ├── prisma.module.ts
│   │   └── prisma.service.ts
│   └── config/
│       ├── app.config.ts
│       ├── database.config.ts
│       └── bigbit.config.ts
├── prisma/
│   ├── schema.prisma             ← single source of truth za schema
│   ├── migrations/
│   └── seed.ts                   ← seed data (test korisnici, vrste poslova, ...)
├── test/
│   ├── e2e/
│   └── fixtures/
├── docs/
│   ├── ARCHITECTURE.md            ← ovaj dokument (kopija u oba repo-a ili samo BE)
│   ├── SCHEMA_PLAN.md
│   ├── MODULES_SPEC.md
│   ├── BIGBIT_SYNC.md
│   ├── API_CONVENTIONS.md
│   └── legacy/
│       └── QMegaTeh_Reference.md
├── docker-compose.yml             ← Postgres + backend za local dev
├── Dockerfile
├── .env
├── .env.example
├── package.json
├── tsconfig.json
├── nest-cli.json
├── eslint.config.mjs
├── .github/workflows/
│   ├── ci.yml                     ← test, lint, build na svaki PR
│   └── deploy.yml                 ← deploy na prod kad se merge-uje main
└── README.md
```

### Frontend repo struktura (`servosync-frontend`)

```
servosync-frontend/
├── src/
│   ├── app/                       ← Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx               ← dashboard (root)
│   │   ├── login/
│   │   │   └── page.tsx
│   │   ├── work-orders/           ← radni nalozi
│   │   │   ├── page.tsx           ← lista
│   │   │   ├── [id]/
│   │   │   │   ├── page.tsx       ← detalj
│   │   │   │   └── edit/
│   │   │   │       └── page.tsx
│   │   │   └── new/
│   │   │       └── page.tsx
│   │   ├── pdm/                   ← PDM moduli
│   │   ├── nacrti/
│   │   ├── primopredaje/
│   │   ├── proizvodnja/
│   │   ├── lokacije/
│   │   ├── mrp/
│   │   └── api/                   ← Next.js API routes (samo za auth callbacks ako bude trebalo)
│   ├── components/
│   │   ├── ui/                    ← shadcn/ui komponente (copy-paste)
│   │   ├── layout/
│   │   │   ├── Header.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── Footer.tsx
│   │   ├── work-orders/
│   │   │   ├── WorkOrderForm.tsx
│   │   │   ├── WorkOrderList.tsx
│   │   │   └── WorkOrderDetail.tsx
│   │   ├── shared/
│   │   │   ├── DataTable.tsx
│   │   │   ├── DateRangePicker.tsx
│   │   │   └── ConfirmDialog.tsx
│   │   └── ...
│   ├── lib/
│   │   ├── api-client.ts          ← fetch wrapper sa auth header-om
│   │   ├── auth.ts                ← JWT handling, refresh logic
│   │   ├── query-client.ts        ← TanStack Query setup
│   │   └── utils.ts
│   ├── hooks/
│   │   ├── use-work-orders.ts     ← TanStack Query hooks po modulu
│   │   ├── use-partners.ts
│   │   └── ...
│   ├── store/                     ← Zustand stores
│   │   ├── auth-store.ts
│   │   └── ui-store.ts
│   └── types/
│       └── api.ts                 ← auto-generated iz Swagger spec-a (gitignored)
├── public/
├── tailwind.config.ts
├── next.config.js
├── tsconfig.json
├── package.json
├── .env.local
├── .env.example
├── .github/workflows/
│   ├── ci.yml
│   └── deploy.yml
└── README.md
```

### Lokalni dev setup

Developer u svom radnom okruženju kloniruje **oba repo-a** rame uz rame:

```
~/dev/servoteh/
├── servosync-backend/
└── servosync-frontend/
```

Backend startuje na `localhost:3000`, frontend na `localhost:3001`. Frontend `.env.local` ima `NEXT_PUBLIC_API_URL=http://localhost:3000`.

### Atomic deployment

Pošto su repo-i odvojeni, "atomic" deployment BE+FE promene radi se kroz:
- Jasno commit message-ove sa cross-reference (`servosync-frontend#42` u BE PR-u)
- BE deploy uvek prvi (BE mora biti backward-kompatibilan), FE deploy posle
- API versioning (`/api/v1`, `/api/v2`) — kad menjamo BE breakage way, FE prelazi na novu verziju kad je gotov

### Documentation lokacija

Glavni dokumenti (`ARCHITECTURE.md`, `SCHEMA_PLAN.md`, `MODULES_SPEC.md`) **žive u backend repo-u** (`servosync-backend/docs/`). Frontend repo ima samo svoju specifičnu dokumentaciju (FE arhitektura, komponente, dizajn sistem).

---

## 5. Naming conventions

### Database (Postgres)

- **Tabele:** `snake_case`, plural, engleski. Primeri: `partners`, `work_orders`, `process_routings`, `operation_logs`
- **Kolone:** `snake_case`, engleski. Primeri: `created_at`, `updated_at`, `partner_code`, `pib`
- **Primary key:** uvek `id` (UUID)
- **Foreign key:** `<parent_table_singular>_id`. Primeri: `partner_id`, `work_order_id`
- **Indeksi:** `idx_<table>_<columns>`. Primeri: `idx_work_orders_status_created_at`
- **Unique constraints:** `uq_<table>_<columns>`. Primeri: `uq_partners_pib`
- **Check constraints:** `chk_<table>_<rule>`. Primeri: `chk_work_orders_quantity_positive`

### Mapiranje na stara srpska imena

Svaka tabela ima Prisma komentar koji mapira na staro QMegaTeh ime:

```prisma
/// QMegaTeh: Komitenti (BigBit master, sync ka nama)
model Partner {
  id           String  @id @default(uuid()) @db.Uuid
  partnerCode  String  @unique @map("partner_code")  // legacy: Sifra
  name         String  @map("name")                   // legacy: Naziv
  // ...
  @@map("partners")
}
```

**Razlog:** developer koji čita VBA referencu vidi staro ime, ali kod je u modernom standardu. Glossary svih starih ↔ novih imena je u `MODULES_SPEC.md`.

### TypeScript / NestJS

- **Klase:** `PascalCase`. Primeri: `WorkOrderService`, `CreateWorkOrderDto`, `WorkOrderEntity`
- **Funkcije/metode:** `camelCase`. Primeri: `findAll`, `createWorkOrder`, `syncFromBigbit`
- **Varijable:** `camelCase`. Primeri: `workOrderId`, `partnerName`
- **Konstante:** `SCREAMING_SNAKE_CASE`. Primeri: `MAX_QUANTITY`, `SYNC_INTERVAL_MS`
- **Enums:** `PascalCase` (klasa) + `SCREAMING_SNAKE_CASE` (vrednosti):
  ```typescript
  enum WorkOrderStatus {
    DRAFT = 'DRAFT',
    APPROVED = 'APPROVED',
    LAUNCHED = 'LAUNCHED',
    COMPLETED = 'COMPLETED',
    CANCELED = 'CANCELED',
  }
  ```
- **Files:** `kebab-case`. Primeri: `work-order.service.ts`, `create-work-order.dto.ts`

### REST API URL-ovi

- **Plural resource names:** `/api/v1/work-orders`, `/api/v1/partners`
- **Lowercase, kebab-case:** `/api/v1/process-routings`, ne `/processRoutings`
- **Versioned:** uvek `/api/v1/...` prefix
- **Standard HTTP verbs:** GET (read), POST (create), PUT (update full), PATCH (update partial), DELETE (soft delete)

### Git commit messages

Konvencija: **Conventional Commits**

```
<type>(<scope>): <subject>

<optional body>
```

Primeri:
- `feat(work-orders): add bulk status update endpoint`
- `fix(bigbit-sync): handle missing PIB column gracefully`
- `refactor(prisma): extract shared audit fields to base model`
- `docs(architecture): clarify monorepo structure`

Tipovi: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`

---

## 6. Database design principles

### Univerzalna pravila

**1. UUID primary keys umesto auto-increment integer-a.**
Razlozi:
- Bezbednije API URLs (ne otkrivaju koliko entity-ja postoji)
- Lakša replikacija ako bude trebalo distribuirano
- Globalno jedinstveni — nema sukoba pri merge-u sa drugim sistemima
- Generišu se na klijent strani, što ubrzava insert-e

```prisma
id String @id @default(uuid()) @db.Uuid
```

**2. Audit polja na svakoj tabeli (osim lookup-ova):**

```prisma
createdAt DateTime  @default(now())  @map("created_at")
updatedAt DateTime  @updatedAt        @map("updated_at")
createdBy String?   @map("created_by") @db.Uuid
updatedBy String?   @map("updated_by") @db.Uuid
```

**3. Soft delete umesto hard delete:**

```prisma
deletedAt DateTime? @map("deleted_at")
```

Prisma middleware automatski filtrira soft-deleted recordsove iz svih query-ja osim eksplicitno označenih.

**4. Foreign keys eksplicitno, ne implicitno:**

```prisma
partner   Partner @relation(fields: [partnerId], references: [id])
partnerId String  @map("partner_id") @db.Uuid
```

Postgres-FK sa `ON DELETE RESTRICT` (default) — sprečava brisanje parent reda ako ima children.

**5. Indeksi gde god se često filtrira:**

Svaka FK kolona automatski dobija indeks. Plus eksplicitni za:
- Kolone u WHERE klauzulama (status, datum_kreiranja)
- Kolone u ORDER BY
- Composite za najčešće query patterne

**6. Numerički tipovi:**

- Kolicine, cene, težine: `Decimal(precision, scale)` — NIKAD float (gubi se preciznost za novac)
- Brojači, ID-jevi: `Int` ili `BigInt`
- Procenti: `Decimal(5, 2)` (npr. 99.99%)

**7. Datumi:**

- Uvek `DateTime` (Prisma) → `TIMESTAMPTZ` (Postgres). Sa timezone-om.
- Datum bez vremena: `@db.Date`
- Vreme bez datuma: izbegavati, koristi `DateTime` sa fiksnim datumom

**8. Tekst:**

- Kratke labele, kodovi: `String @db.VarChar(50)`
- Imena, opisi: `String @db.VarChar(255)`
- Napomene, dugačak tekst: `String @db.Text`
- Strukturirani metadata: `Json` (JSONB u Postgres-u)

### Spec za naše domene

**`partners` tabela** (komitenti):
- `id` UUID PK
- `legacy_sifra` VarChar(20) — original Sifra iz BigBit-a, jedinstveno (za sync mapiranje)
- `name` VarChar(255)
- `pib` VarChar(20) — može biti NULL
- `address`, `city`, `postal_code`, `country` itd.
- `is_customer` Boolean — kupac
- `is_supplier` Boolean — dobavljač
- `is_active` Boolean
- audit polja
- soft delete

**`work_orders` tabela** (radni nalozi):
- `id` UUID PK
- `wo_number` VarChar(20) — broj radnog naloga (auto-generated, format `YYYY/NNNN/M` slično starom)
- `project_id` FK → `projects`
- `partner_id` FK → `partners`
- `drawing_number` VarChar(50)
- `revision` VarChar(10)
- `quantity` Decimal(12,4)
- `material_id` FK → `items` (artikli iz BigBit-a)
- `material_dimensions` VarChar(255)
- `tehnolog_id` FK → `users`
- `status` Enum (DRAFT, APPROVED, LAUNCHED, IN_PROGRESS, COMPLETED, CANCELED)
- `due_date` Date
- `created_at`, `updated_at`, ...

(Detaljna spec ide u `SCHEMA_PLAN.md`.)

---

## 7. Auth & Authorization (V1)

### V1 — minimalni auth

**Single role:** svi korisnici se loguju kao `admin`. Nema RBAC u V1. Cilj je da krene rad što pre, RBAC dolazi kasnije.

**Mehanizam:**
- Email + password registracija/login
- Password čuva se kao bcrypt hash (12 rounds)
- JWT token sa 24h expiry, refresh token sa 30 dana
- JWT u Authorization header (`Bearer <token>`)
- Logout = brisanje tokena na klijentu (refresh token blacklist u tabeli `revoked_tokens`)

**Tabele:**

```prisma
model User {
  id            String    @id @default(uuid()) @db.Uuid
  email         String    @unique
  passwordHash  String    @map("password_hash")
  fullName      String    @map("full_name")
  role          UserRole  @default(ADMIN)         // V1: svi admin, V2: pravi RBAC
  isActive      Boolean   @default(true)          @map("is_active")
  createdAt     DateTime  @default(now())         @map("created_at")
  updatedAt     DateTime  @updatedAt               @map("updated_at")
  
  @@map("users")
}

enum UserRole {
  ADMIN
  // V2: PROJEKTNI_BIRO, TEHNOLOG, KONTROLOR, MAGACIONER, RADNIK, NABAVKA_VIEW, MENADZMENT
}
```

**JWT payload (V1):**
```json
{
  "sub": "<user_uuid>",
  "email": "user@servoteh.rs",
  "role": "ADMIN",
  "iat": 1715000000,
  "exp": 1715086400
}
```

### V2+ — pravi RBAC

Pripremamo strukturu već u V1 da bismo lakše dodali RBAC kasnije:

- `UserRole` enum sa svim role-ovima (samo `ADMIN` aktivan u V1)
- `@Roles()` dekorator postoji ali je no-op u V1
- `RolesGuard` postoji ali pušta sve u V1
- `@CurrentUser()` dekorator vraća autentifikovanog korisnika

Kada V2 dođe — samo pravimo `RolesGuard` aktivnim i počinjemo da dodeljujemo prave role.

---

## 8. Sync sa BigBit-om

Kompletan dokument o sync-u biće u `BIGBIT_SYNC.md`. Ovde samo high-level.

### Mehanizam

**Tehnologija:** NestJS modul `bigbit-sync` koji koristi `mssql` Node paket za konekciju ka SQL Server-u.

**Strategija:**

1. **Read-only sa BigBit strane** — Servosync **ne piše** u BigBit. Sync je jednosmeran.
2. **Master entiteti koji se sync-uju:**
   - Komitenti (Komitenti → partners)
   - Predmeti (Predmeti → projects)
   - Artikli (R_Artikli → items)
   - Magacini (Magacini → warehouses)
   - PDV tarife (R_Tarife → tax_rates)
   - Grupe artikala (R_Grupa → item_groups)
3. **Cron schedule:** svako jutro u 02:00 (mali saobraćaj na BigBit-u)
4. **On-demand:** dugme "Sync from BigBit" u UI, dostupno admin-u
5. **Inkrementalni sync:** koristimo `LastModified` ili neku timestamp kolonu ako postoji u BigBit-u; ako ne postoji, full sync sa upsert pattern-om

### Šema sync-a

```prisma
model Partner {
  id              String   @id @default(uuid()) @db.Uuid
  legacySifra     String   @unique @map("legacy_sifra")    // BigBit-ova Sifra
  name            String
  // ...
  syncedFromBigbit Boolean @default(false) @map("synced_from_bigbit")
  lastSyncedAt    DateTime? @map("last_synced_at")
  
  @@map("partners")
}
```

### Konflikt rezolucija

**Pravilo:** za polja koja se sync-uju iz BigBit-a, **BigBit pobeđuje** uvek. Lokalna izmena je opisana u UI-u kao "Ovo polje se sync-uje iz BigBit-a, izmena će biti pregažena pri sledećem sync-u". Korisnik tu nema šta da menja.

Polja koja **ne dolaze** iz BigBit-a (proizvodno-specifična, npr. `default_technologist_id`, `internal_notes`) — ostaju lokalne, sync ih ne dira.

### Audit log

Tabela `bigbit_sync_log`:

```prisma
model BigbitSyncLog {
  id           String      @id @default(uuid()) @db.Uuid
  startedAt    DateTime    @map("started_at")
  finishedAt   DateTime?   @map("finished_at")
  status       SyncStatus  // SUCCESS, FAILED, PARTIAL
  entityType   String      @map("entity_type")        // 'partners', 'projects', ...
  recordsRead  Int         @default(0) @map("records_read")
  recordsUpserted Int      @default(0) @map("records_upserted")
  errors       Json?
  triggeredBy  String?     @map("triggered_by")       // 'cron' or user UUID
  
  @@map("bigbit_sync_log")
}

enum SyncStatus { SUCCESS FAILED PARTIAL }
```

---

## 9. API design

### Konvencije

- **Base URL:** `/api/v1`
- **Format:** JSON
- **Auth:** JWT u Authorization header
- **Datumi:** ISO 8601 sa timezone (`2026-05-08T14:23:00+02:00`)
- **UUIDs:** kao stringovi
- **Decimals:** kao stringovi (da se izbegne JS float greška) — frontend parsira sa libom kao `decimal.js`
- **Paginacija:** cursor-based za velike liste (`?cursor=<id>&limit=50`), offset-based za male
- **Filteri:** query params (`?status=APPROVED&partner_id=<uuid>`)
- **Sort:** query param (`?sort=-created_at` za desc, `?sort=name` za asc)

### Response envelope

```json
{
  "data": { ... } ili [ ... ],
  "meta": {
    "pagination": { "next_cursor": "...", "has_more": true },
    "total_count": 123
  }
}
```

Error response:

```json
{
  "error": {
    "code": "WORK_ORDER_NOT_FOUND",
    "message": "Work order with ID xyz not found",
    "details": { ... },
    "trace_id": "abc-123"
  }
}
```

### Statuskodovi

- 200 OK — uspešan GET/PUT/PATCH
- 201 Created — uspešan POST (kreiran resurs)
- 204 No Content — uspešan DELETE
- 400 Bad Request — validacija failed
- 401 Unauthorized — nema JWT-a ili je istekao
- 403 Forbidden — autentifikovan ali nema permission (V2)
- 404 Not Found
- 409 Conflict — npr. unique constraint violation
- 422 Unprocessable Entity — semantička greška (npr. "ne možeš lansirati RN koji nije saglasan")
- 500 Internal Server Error — neočekivana greška, log-uje se sa trace ID

### Error catalog

Svi error code-ovi su definisani na jednom mestu (`error-codes.enum.ts`) i konzistentno se koriste:

```typescript
enum ErrorCode {
  // Generic
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  
  // Domain-specific
  WORK_ORDER_NOT_FOUND = 'WORK_ORDER_NOT_FOUND',
  WORK_ORDER_INVALID_STATUS_TRANSITION = 'WORK_ORDER_INVALID_STATUS_TRANSITION',
  PARTNER_NOT_FOUND = 'PARTNER_NOT_FOUND',
  BIGBIT_SYNC_IN_PROGRESS = 'BIGBIT_SYNC_IN_PROGRESS',
  // ...
}
```

### Swagger / OpenAPI

Auto-generated iz NestJS DTO-ova i dekoratera. Dostupan na `/api/docs` u dev environment-u, isključen u prod (osim za interne admin-e).

---

## 10. Validation & error handling

### Validation

Sve request body-jeve validira **class-validator** + **class-transformer** preko global `ValidationPipe`:

```typescript
export class CreateWorkOrderDto {
  @IsUUID()
  projectId: string;
  
  @IsUUID()
  partnerId: string;
  
  @IsString()
  @MaxLength(50)
  drawingNumber: string;
  
  @IsString()
  @Matches(/^[A-Z]$/)
  revision: string;
  
  @IsNumber()
  @Min(0.0001)
  quantity: number;
  
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
```

### Global exception filter

Centralni `AllExceptionsFilter` hvata sve neuhvaćene greške, log-uje sa trace ID, vraća konzistentan error envelope.

### Domain exceptions

Custom exception klase za poslovne greške:

```typescript
class WorkOrderNotFoundException extends BusinessException {
  constructor(id: string) {
    super(ErrorCode.WORK_ORDER_NOT_FOUND, `Work order ${id} not found`);
  }
}
```

`BusinessException` se mapira na 404/422 u zavisnosti od tipa, nikad na 500 (500 je samo za stvarne neočekivane greške).

---

## 11. Logging & monitoring

### Logging (V1)

- **Library:** `pino` ili NestJS built-in Logger (verovatno pino za structured JSON output)
- **Log levels:** TRACE, DEBUG, INFO, WARN, ERROR, FATAL
- **Format:** JSON, jedan log po liniji
- **Output:** stdout u dev, file (rotated) u prod
- **Required fields:** timestamp, level, message, trace_id, user_id (ako autentifikovan)
- **Audit log:** zaseban (vidi sledeću sekciju), ne meša se sa app log-om

### Audit log

Svaka write operacija (POST/PUT/PATCH/DELETE) ide u `audit_log` tabelu:

```prisma
model AuditLog {
  id          String   @id @default(uuid()) @db.Uuid
  userId      String?  @map("user_id") @db.Uuid
  entityType  String   @map("entity_type")    // 'work_order', 'partner', ...
  entityId    String   @map("entity_id")
  action      String                          // 'CREATE', 'UPDATE', 'DELETE', 'STATUS_CHANGE'
  before      Json?
  after       Json?
  ipAddress   String?  @map("ip_address")
  userAgent   String?  @map("user_agent")
  createdAt   DateTime @default(now()) @map("created_at")
  
  @@index([entityType, entityId])
  @@index([userId, createdAt])
  @@map("audit_log")
}
```

Implementacija preko NestJS interceptor-a — automatski hvata sve mutirajuće operacije.

### Monitoring (V2)

V1 — samo file log + `tail -f`. V2 — Grafana, Prometheus, alerts. Kasnije.

---

## 12. Testing strategija

### Piramida

```
       /\
      /E2E\          5-10 critical paths
     /------\
    /  Int   \       30-50 integration tests
   /----------\
  /    Unit    \     200+ unit tests
 /--------------\
```

### Unit testovi

- Coverage target: 80%+ za service sloj
- Mock-uju Prisma kroz `prisma-mock` ili `jest.mock()`
- Testiraju jednu funkciju u izolaciji
- Brzi (<1s svaki)

### Integration testovi

- Testiraju ceo modul (controller + service + Prisma protiv real test DB-a)
- Test DB je odvojeni Docker container, briše se i seed-uje pre svakog test runa
- Pokriveni glavni flow-ovi: kreiranje, izmena, brisanje, listing sa filterima

### E2E testovi

- Testiraju kompletne user journey-je preko HTTP
- `supertest` šalje pravi HTTP request na test server
- Pokriveni samo kritični paths:
  - Login → kreiranje RN-a → odobravanje → lansiranje → kompletiranje
  - Sync iz BigBit-a sa mock SQL Server-om
  - Workflow primopredaje od početka do kraja

### CI

Svi testovi se vrte na svaki PR. Merge u main blokiran ako testovi padaju.

---

## 13. Plan po fazama

Sledi gruba podela vremena. Konkretni Cursor zadaci po sprintu idu u zasebne `CURSOR_INSTRUCTIONS_SPRINT_*.md` fajlove.

### Sprint 0 — Foundation (Nedelja 1-2)

**Cilj:** raditi backend skelet, Postgres šema, auth, prvi endpoint.

- NestJS aplikacija setup
- Prisma šema sa svim tabelama (one-time migracija)
- Modul `auth` (login, register, JWT, password hash)
- Modul `users` (CRUD)
- Health check endpoint (`GET /api/v1/health`)
- Swagger docs setup
- Global exception filter
- Audit log interceptor
- Seed data (admin user, test podaci)
- Docker Compose za local dev

**Definicija "Done":**
- `npm run start:dev` startuje aplikaciju
- POST /api/v1/auth/login vraća JWT
- GET /api/v1/users/me sa JWT vraća current user
- Swagger UI radi na `/api/docs`
- Sve postavljeno u Git repo

### Sprint 1 — BigBit sync foundation (Nedelja 3-4)

**Cilj:** read-only konekcija ka BigBit-u, sync osnovnih master entiteta.

- Modul `bigbit-sync` sa `mssql` paketom
- Konekcija pool za BigBit SQL Server
- Sync servisi za: partners (komitenti), projects (predmeti), items (artikli), warehouses (magacini), tax_rates (R_Tarife), item_groups (R_Grupa)
- Cron job (svako jutro 02:00)
- On-demand sync endpoint (POST /api/v1/bigbit-sync/run)
- `bigbit_sync_log` tabela + endpoint za pregled
- Read-only API endpoints za sync-ovane entitete (samo GET)

### Sprint 2 — Production structures (Nedelja 5-6)

**Cilj:** sve "static" master data za proizvodnju.

- Modul `workers` (radnici) — CRUD
- Modul `work-units` (radne jedinice / RJ) — CRUD
- Modul `operations` (operacije po radnim jedinicama) — CRUD
- Modul `job-types` (vrste poslova) — CRUD
- Modul `worker-machines` (matrica radnik × mašina) — CRUD

### Sprint 3 — PDM & BOM (Nedelja 7-9)

**Cilj:** PDM modul kompletno.

- Modul `drawings` (PDM crteži) — CRUD + filteri
- Modul `boms` (sastavnice) — CRUD + hijerarhijski upiti
- Where-used queries
- XML import endpoint (file upload)
- BOM expansion (rekurzivno)

### Sprint 4 — Drafts & Handovers (Nedelja 10-11)

**Cilj:** primopredaje workflow.

- Modul `drafts` (nacrti) — CRUD
- Modul `handovers` (primopredaje) — workflow
- Status flow: DRAFT → PENDING_APPROVAL → APPROVED → LAUNCHED ili REJECTED
- Tehnolog assignment dialog
- Bulk operations

### Sprint 5 — Work Orders (Nedelja 12-15)

**Cilj:** najveći modul — radni nalozi.

- Modul `work-orders` (RN) — CRUD
- Modul `process-routings` (tehnološki postupci) — CRUD
- Modul `operation-logs` (kartica tehnoloskog postupka)
- Copy-from-existing workflow (kreiranje za novi predmet)
- Status transitions sa biznis pravilima

### Sprint 6 — Production overview (Nedelja 16-18)

**Cilj:** module za praćenje proizvodnje.

- Modul `production`:
  - Pregled tehnoloških postupaka sa filterima
  - Kartica tehnoloskog postupka
  - Detaljan pregled (statusi gotovosti)
  - Dinamika izrade sklopova (matrica statusa)
  - Analiza dnevnih aktivnosti (po radniku, po satu)

### Sprint 7 — Locations (Nedelja 19-20)

**Cilj:** lokacije delova.

- Modul `locations`:
  - Master data raspoloživih lokacija
  - Pregled završenih delova po lokacijama
  - Premestanje delova između lokacija
  - Istrebovanje (čišćenje police)

### Sprint 8 — MRP (Nedelja 21-23)

**Cilj:** planiranje materijala.

- Modul `mrp`:
  - BOM expansion + agregacija potreba
  - Stock check vs BigBit
  - Planiraj iz sklopnog crteža
  - Planiraj pre crteža
  - Specifikacije za nabavku
- Modul `procurement-view`:
  - Read-only pregled statusa nabavke
  - Realizacija i analiza nabavki

### Sprint 9 — Testing + paralelni rad (Nedelja 24-26)

- E2E testing sa pilot user-ima iz proizvodnje
- Bug fixing
- Performance optimization
- Bezbedonosna revizija
- Dokumentacija za korisnike

### Sprint 10 — Cutover (Nedelja 27-28)

- Migracija realnih podataka iz QBigTehn SQL Server-a
- Final user training
- Go-live
- Stabilizacija — 24/7 monitoring prvih 2 nedelje
- Gašenje QMegaTeh-a

---

## 14. Rizici i mitigacija

| Rizik | Verovatnoća | Uticaj | Mitigacija |
|---|---|---|---|
| Sync sa BigBit-om ne radi pouzdano | srednja | visok | Retry logika, dead letter queue, alert na sync padove |
| Performance problemi na velikim BOM-ovima | visoka | srednji | Materialized views, query optimizacija, caching |
| Korisnici se opiru promeni | visoka | visok | Pilot u jednoj fazi, paralelni rad sa starim sistemom 6+ nedelja |
| Vendor BigBit-a promeni šemu BigBit-a | niska | visok | Sync layer apstrahuje šemu, mapiranje na jednom mestu |
| Bug u biznis logici otkriven u produkciji | srednja | visok | Audit log omogućava forensic analizu i rollback |
| Tim se rasipa (neko ode) | srednja | visok | Dobra dokumentacija, code review obavezan, dobre commit poruke |
| Skop se širi (scope creep) | visoka | visok | Sve van V1 skopa se vraća kao "V2 backlog", ne ide odmah |
| Frontend kasni — backend čeka | srednja | srednji | API se razvija na osnovu Swagger spec-a, FE i BE paralelno |

---

## 15. Reference

- `SCHEMA_PLAN.md` — kompletna Prisma šema
- `MODULES_SPEC.md` — specifikacija svakog modula
- `BIGBIT_SYNC.md` — detaljan opis sync mehanizma
- `API_CONVENTIONS.md` — REST design u detalje
- `legacy/QMegaTeh_Reference.md` — stara dokumentacija kao referenca
- `legacy/tables.txt` — inventar svih tabela iz BigBit + QMegaTeh sistema
- `legacy/queries.sql` — sve postojeće SQL upite iz QMegaTeh-a kao referenca

---

## 16. Promene ovog dokumenta

| Verzija | Datum | Šta se promenilo |
|---|---|---|
| 1.0 | maj 2026 | Inicijalna verzija — V1 plan |
| 1.1 | maj 2026 | Frontend potvrđen kao Next.js + React (umesto TBD); promena iz monorepo-a u dva odvojena repo-a (`servosync-backend` + `servosync-frontend`); type sharing kroz auto-generisani Swagger spec umesto shared paketa; on-prem prod deployment kao primarna preporuka sa cloud (DigitalOcean/Hetzner) kao alternativa za V2 |

Sve buduće promene se logovaju ovde sa kratkim opisom šta je promenjeno i zašto.

---

*Kraj ARCHITECTURE.md v1*

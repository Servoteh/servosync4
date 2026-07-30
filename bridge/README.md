# Servoteh Bridge

Read-only Node.js servis koji sinhronizuje BigTehn (SQL Server `QBigTehn`) → Supabase cache. Deploy: Windows Service na firma serveru gde je BigTehn SQL.

**Faza 1B + B.1 + B.2.1 + B.2.2 + B.2.3 (trenutno):** Sinhronizuje **8 kataloga** svako jutro u 06:00 (sektori, mašine, komitenti, vrste radnika, radnici, vrste kvaliteta, pozicije/police, predmeti) **+ production tracking + kretanje delova svakih 15 minuta** (radni nalozi, operacije, lansiranja, saglasnosti, transfer delova kroz police — incremental po watermark-u). Ne menja ni jedan red u BigTehn-u.

> **Locations isključen.** `BIGTEHN_DATA_MAP.md` je pretpostavio da je `tLokacijeDelova` katalog polica (K-A1, K-S=škart…), ali je `discover:columns` 2026-04-18 pokazao da je to **transakcioni log kretanja delova** (IDRN, IDPredmet, IDPozicija, SifraRadnika, Datum, Kolicina, IDVrstaKvaliteta). Pravi katalog polica je `tPozicije` (sad sinhronizovan kao `positions`), a `tLokacijeDelova` ide u Fazu 2 kao incremental transakcioni sync. `syncLocations.js` je sada disabled stub koji eksplicitno odbija da se pokrene.

Pun arhitekturni opis: vidi [`BIGTEHN_DATA_MAP.md`](https://github.com/Servoteh/servoteh-plan-montaze/blob/main/docs/BIGTEHN_DATA_MAP.md) (u `servoteh-plan-montaze` repo-u).

---

## Šta radi

| Job | SQL Server izvor | Supabase cilj | Frekvencija | Polja |
|---|---|---|---|---|
| `departments` | `tRadneJedinice` | `bigtehn_departments_cache` | dnevno 06:00 | id, name |
| `machines`    | `tOperacije`     | `bigtehn_machines_cache`    | dnevno 06:00 | rj_code, name, department_id, no_procedure, … |
| `customers`   | `Komitenti`      | `bigtehn_customers_cache`   | dnevno 06:00 | id, name, short_name, city, tax_id |
| `workers`     | `tRadnici`       | `bigtehn_workers_cache`     | dnevno 06:00 | id, full_name, short_name, department_id, card_id, is_active **(BEZ Password kolona — vidi sekciju 6.6 BIGTEHN_DATA_MAP.md)** |
| `worker_types`  | `tVrsteRadnika`        | `bigtehn_worker_types_cache`  | dnevno 06:00 | id, name, has_extra_auth |
| `quality_types` | `tVrsteKvalitetaDelova`| `bigtehn_quality_types_cache` | dnevno 06:00 | id, name |
| `positions`     | `tPozicije`            | `bigtehn_positions_cache`     | dnevno 06:00 | id, code, description (police K-A1, K-S=škart…) |
| `items`         | `Predmeti`             | `bigtehn_items_cache`         | dnevno 06:00 | id, broj_predmeta, naziv_predmeta, status, customer_id, datumi (~10k+ redova) |
| ~~`locations`~~ | ~~`tLokacijeDelova`~~ | — | **DISABLED** | Premešteno u Fazu 2 (transakcioni sync). |
| `work_orders`     | `tRN`          | `bigtehn_work_orders_cache`            | **15 min** (delta) | id, ident_broj, item_id, customer_id, broj_crteza, naziv_dela, status_rn, rok_izrade, … |
| `lines`           | `tStavkeRN`    | `bigtehn_work_order_lines_cache`       | **15 min** (delta) | id, work_order_id, operacija, machine_code, opis_rada, tpz, tk, prioritet |
| `launches`        | `tLansiranRN`  | `bigtehn_work_order_launches_cache`    | **15 min** (delta) | id, work_order_id, lansiran, author/modifier worker + potpis |
| `approvals`       | `tSaglasanRN`  | `bigtehn_work_order_approvals_cache`   | **15 min** (delta) | id, work_order_id, saglasan, author/modifier worker + potpis |
| `part_movements`  | `tLokacijeDelova` | `bigtehn_part_movements_cache`      | **15 min** (delta) | id, work_order_id, item_id, position_id, worker_id, quality_type_id, datum, kolicina (transfer delova kroz police, ~10k+ redova) |
| `tech_routing`    | `tTehPostupak` | `bigtehn_tech_routing_cache`           | **15 min** (delta) | id, work_order_id, item_id, worker_id, operacija, machine_code, komada, **prn_timer_seconds (stvarno vreme)**, started_at, finished_at, **is_completed** (autoritativni signal "operacija završena", napomena, ident_broj) |

**Watermark logika (Sprint B.2.2 + B.2.3 + F.1):** Svih 6 production jobova čitaju zadnji uspešan `started_at` iz `bridge_sync_log` (sa 60s safety overlap-om) i povlače samo redove sa `DIVIspravke[RN] > watermark` (4 RN tabele), `COALESCE(DatumIVremeUnosa, Datum) > watermark` (kretanje delova), odnosno `COALESCE(DatumIVremeZavrsetka, DatumIVremeUnosa) > watermark` (tehnološki postupak — hvata i nove prijave i kompletiranje postojećih). Prvi run koristi fallback od 30 dana. UPSERT je idempotentan, pa duplikati od overlap-a ne prave problem.

Svaki run loguje u `bridge_sync_log` tabelu (i u composite `catalogs_daily` / `production_15min` red).

**Pre-deploy SQL migracije** (u Supabase SQL Editor, redom):
1. `sql/migrations/001_bridge_catalogs_phase1b.sql` — bridge_sync_log + 4 osnovna cache-a (Faza 1B)
2. `sql/migrations/002_bridge_b1_micro_catalogs.sql` — 3 mala kataloga (Sprint B.1)
3. `sql/migrations/003_bridge_b21_items.sql` — predmeti (Sprint B.2.1)
4. `sql/migrations/004_bridge_b22_production.sql` — 4 production cache tabele + RLS (Sprint B.2.2)
5. `sql/migrations/005_bridge_b23_part_movements.sql` — kretanje delova + RLS (Sprint B.2.3)
6. `sql/migrations/006_bridge_f1_tech_routing.sql` — tehnološki postupak (tTehPostupak) + RLS (Sprint F.1, podrška za Plan Proizvodnje)

---

## Preduslovi

### Na Bridge serveru (Windows)

- **Node.js 20 ili 22** (`node --version`)
- Mrežni pristup do `Vasa-SQL:5765`
- Mrežni pristup do `*.supabase.co` (HTTPS 443)
- Za Katze job (evidencija prisustva): mrežni pristup do `192.168.64.10:1433`
- **SQL Server čitalac** — preporuka: kreirati zaseban login `bridge_reader` sa SELECT pravima na (Faza 1B + B.1 + B.2.1 + B.2.2 + B.2.3 + F.1): `tRadneJedinice`, `tOperacije`, `Komitenti`, `tRadnici`, `tVrsteRadnika`, `tVrsteKvalitetaDelova`, `tPozicije`, `Predmeti`, `tRN`, `tStavkeRN`, `tLansiranRN`, `tSaglasanRN`, `tLokacijeDelova`, **`tTehPostupak`**.
- Za servis instalaciju: **PowerShell pokrenut kao Administrator**

### Uključivanje Katze joba (evidencija prisustva) na bridge mašini

Job `syncKatze` čita prolaze iz Katze/CardWare SQL-a (`192.168.64.10`, baza
**`Servoteh`** — živa; `KR7_Calc` je kopija za proračun, ne čitati iz nje) i
upisuje u `attendance_events`. Inkrementalan po `IDReg`, na 10 min.

1. U `.env` na bridge mašini dodaj (vrednosti prepiši iz `bridge/.env` na
   razvojnoj mašini — nalog je `servosync_ro`, samo čitanje):
   ```ini
   ENABLE_JOB_KATZE=true
   KATZE_SQL_SERVER=192.168.64.10
   KATZE_SQL_PORT=1433
   KATZE_SQL_DATABASE=Servoteh
   KATZE_SQL_USER=servosync_ro
   KATZE_SQL_PASSWORD=<iz bridge/.env na razvojnoj mašini>
   ```
2. Test: `npm run sync:katze` (one-shot; radi i bez restarta servisa).
3. Restartuj bridge servis da scheduler registruje job (`*/10 * * * *`,
   menja se preko `SCHEDULE_KATZE_CRON`).

### U Supabase-u (PRE prvog run-a Bridge servisa)

Sledeće tabele MORAJU postojati. Run u Supabase SQL Editor-u:

```sql
-- 1) bridge_sync_log (audit trail)
CREATE TABLE IF NOT EXISTS bridge_sync_log (
  id BIGSERIAL PRIMARY KEY,
  sync_job TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running',
  rows_inserted INT DEFAULT 0,
  rows_updated INT DEFAULT 0,
  rows_deleted INT DEFAULT 0,
  error_message TEXT,
  duration_ms INT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_job ON bridge_sync_log(sync_job, started_at DESC);

-- 2) bigtehn_departments_cache
CREATE TABLE IF NOT EXISTS bigtehn_departments_cache (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) bigtehn_machines_cache
CREATE TABLE IF NOT EXISTS bigtehn_machines_cache (
  rj_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department_id TEXT REFERENCES bigtehn_departments_cache(id),
  operation_id INT,
  note TEXT,
  no_procedure BOOLEAN DEFAULT FALSE,
  significant_for_completion BOOLEAN DEFAULT FALSE,
  uses_priority BOOLEAN DEFAULT FALSE,
  skippable BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bigtehn_machines_dept ON bigtehn_machines_cache(department_id);

-- 4) bigtehn_customers_cache
CREATE TABLE IF NOT EXISTS bigtehn_customers_cache (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT,
  city TEXT,
  tax_id TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5) bigtehn_workers_cache
CREATE TABLE IF NOT EXISTS bigtehn_workers_cache (
  id INT PRIMARY KEY,
  full_name TEXT NOT NULL,
  short_name TEXT,
  department_id TEXT REFERENCES bigtehn_departments_cache(id),
  card_id TEXT,
  worker_type_id INT,
  is_active BOOLEAN DEFAULT TRUE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6) bigtehn_locations_cache — NAMERNO IZOSTAVLJENO U FAZI 1B.
--    Vidi NOTE u src/jobs/syncLocations.js. tLokacijeDelova nije katalog.
--    Tabela će biti redefinisana u Fazi 2 (kao bigtehn_quality_locations_cache
--    + bigtehn_part_movements transakciono).

-- 7) RLS — Bridge koristi SERVICE_ROLE key (bypass RLS).
--    Za read iz aplikacije, dodati read-only policy:
ALTER TABLE bigtehn_departments_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_machines_cache    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_customers_cache   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_workers_cache     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridge_sync_log           ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read" ON bigtehn_departments_cache FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_machines_cache    FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_customers_cache   FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_workers_cache     FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bridge_sync_log           FOR SELECT TO authenticated USING (true);
```

Ovaj SQL će kasnije biti deo formalne migracije u `servoteh-plan-montaze` repo-u (Faza 1C-1D), za sada ručno run-ovati u Supabase SQL Editor-u.

---

## Lokalni development (macOS / Windows / Linux)

```bash
git clone https://github.com/Servoteh/servoteh-bridge.git
cd servoteh-bridge

cp .env.example .env
# popuni .env sa stvarnim vrednostima

npm install

# 1) test konekcije
npm run test:connection

# 2) ručno pokrenuti pojedinačni job
npm run sync:departments
npm run sync:machines
npm run sync:customers
npm run sync:workers
npm run sync:worker-types
npm run sync:quality-types
npm run sync:positions
npm run sync:items
# napomena: `npm run sync:locations` namerno baca grešku (disabled stub)

# 3) ručno pokrenuti svih 8 kataloga odjednom
npm run sync:catalogs

# 4) production tracking (Sprint B.2.2 + B.2.3) — incremental po watermark-u
npm run sync:work-orders
npm run sync:lines
npm run sync:launches
npm run sync:approvals
npm run sync:part-movements
npm run sync:tech-routing
# ili svih 6 odjednom:
npm run sync:production

# 4b) Backfill Planiranja proizvodnje (puno skeniranje po ID, bez 30d prozora):
#  - tRN, tStavkeRN, tTehPostupak -> cache tabele
#  - tTehPostupak (kvalitet 1/2) -> bigtehn_rework_scrap_cache (G4)
#  - posle sync-a `tech` poziva Supabase RPC mark_in_progress_from_tech_routing (G6)
# Preduslov: u Supabase primenjene migracije iz servoteh-plan-montaze
# (add_production_g4_rework_scrap_cache.sql, add_production_g6_auto_in_progress.sql).
npm run backfill:production:dry
npm run backfill:production
# Ili samo G4: node scripts/backfill-production-cache.js --tables=rework-scrap --scope=open

# (debug) — otkrij stvarne kolone neke BigTehn tabele:
npm run discover:columns -- tVrsteKvalitetaDelova
npm run discover:columns -- tRN

# 5) idle režim sa scheduler-om (čeka 06:00 za kataloge i */15 min za production)
npm start
```

`LOG_PRETTY=true` u `.env` daje obojen output u terminalu.

---

## Production deployment (Windows Service) — checklist

> Pretpostavlja se Windows Server (ili Windows 10/11 Pro) gde je BigTehn SQL Server. Bridge mora biti na istoj LAN-u (ili mašini).
>
> Ovaj checklist je **idempotentan** — možeš ga pokrenuti više puta bez štete. Svaki korak ima jasan kriterijum uspeha.

### Korak 1 — Preduslovi na serveru

```powershell
# Node.js 20+ (LTS preporuka 20 ili 22)
node --version    # >= v20.0.0

# Git
git --version

# PowerShell mora biti Administrator za Korak 5 (servis install)
```

Ako Node nije instaliran: <https://nodejs.org/en/download/>

### Korak 2 — Supabase migracije (jednom, sa lokalnog kompa ili u browseru)

U Supabase SQL Editor, **redom**:
1. `sql/migrations/001_bridge_catalogs_phase1b.sql`
2. `sql/migrations/002_bridge_b1_micro_catalogs.sql`
3. `sql/migrations/003_bridge_b21_items.sql`
4. `sql/migrations/004_bridge_b22_production.sql`
5. `sql/migrations/005_bridge_b23_part_movements.sql`
6. `sql/migrations/006_bridge_f1_tech_routing.sql`

Provera: `SELECT count(*) FROM bridge_sync_log;` mora vratiti `0` (ili više ako si već runovao Bridge).

### Korak 3 — GRANT na BigTehn (jednom, u SSMS na SQL Server-u kao admin)

> **Ažuriranje 2026-07-06:** `bridge_reader` je dodat u `db_datareader` rolu
> (`ALTER ROLE db_datareader ADD MEMBER bridge_reader;`) — čita **sve** tabele i view-ove
> u `QBigTehn`, uključujući i buduće. I dalje strogo read-only. Pojedinačni grantovi ispod
> su istorijat i više nisu potrebni za nove tabele.

```sql
USE QBigTehn;
GRANT SELECT ON dbo.tRadneJedinice         TO bridge_reader;
GRANT SELECT ON dbo.tOperacije             TO bridge_reader;
GRANT SELECT ON dbo.Komitenti              TO bridge_reader;
GRANT SELECT ON dbo.tRadnici               TO bridge_reader;
GRANT SELECT ON dbo.tVrsteRadnika          TO bridge_reader;
GRANT SELECT ON dbo.tVrsteKvalitetaDelova  TO bridge_reader;
GRANT SELECT ON dbo.tPozicije              TO bridge_reader;
GRANT SELECT ON dbo.Predmeti               TO bridge_reader;
GRANT SELECT ON dbo.tRN                    TO bridge_reader;
GRANT SELECT ON dbo.tStavkeRN              TO bridge_reader;
GRANT SELECT ON dbo.tLansiranRN            TO bridge_reader;
GRANT SELECT ON dbo.tSaglasanRN            TO bridge_reader;
GRANT SELECT ON dbo.tLokacijeDelova        TO bridge_reader;
GRANT SELECT ON dbo.tTehPostupak           TO bridge_reader;

-- Prosirenje za ServoSync 2.0 Sprint 1 syncere (izvrseno 2026-07-06):
GRANT SELECT ON dbo.Prodavci               TO bridge_reader;  -- salespeople
GRANT SELECT ON dbo.R_Artikli              TO bridge_reader;  -- items
GRANT SELECT ON dbo.Magacini               TO bridge_reader;  -- warehouses
GRANT SELECT ON dbo.R_Tarife               TO bridge_reader;  -- tax_rates
GRANT SELECT ON dbo.R_Grupa                TO bridge_reader;  -- item_groups
GRANT SELECT ON dbo.R_Podgrupa             TO bridge_reader;  -- item_subgroups
GRANT SELECT ON dbo.tPristupMasini         TO bridge_reader;  -- machine_access
```

### Korak 4 — Klon + install + `.env`

```powershell
# Folder po standardu Servoteh deploymenata:
mkdir C:\Servoteh -ErrorAction SilentlyContinue
cd C:\Servoteh

# Klon (ako vec postoji folder — `cd servoteh-bridge; git pull`)
git clone https://github.com/Servoteh/servoteh-bridge.git
cd servoteh-bridge

# .env iz template-a (NE komitovati!)
if (-not (Test-Path .env)) { copy .env.example .env }
notepad .env
# Obavezno popuni:
#   BIGTEHN_SQL_*  (server, port, user, password)
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
#   BRIDGE_INSTANCE_NAME=servoteh-bridge-prod
#   LOG_PRETTY=false   (na produkciji)
# Opciono (ali preporuka):
#   ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID  (vidi sekciju "Alerting")

# Install (bez dev dependencies)
npm install --omit=dev
```

### Korak 5 — Smoke test (PRE servis install-a!)

```powershell
# 1. Konekcija ka SQL Server-u i Supabase-u
npm run test:connection
# Mora videti 2 zelena reda. Ako padne — fix .env i grants pre nastavka.

# 2. Sva 8 kataloga
npm run sync:catalogs
# Mora završiti bez greške, videti "all 8 catalogs done" + brojeve.

# 3. Svih 6 production jobova
npm run sync:production
# Mora završiti bez greške, videti breakdown po 6 sub-jobs-a.

# Provera u Supabase Table Editor:
#   bigtehn_workers_cache (>50 redova)
#   bigtehn_work_orders_cache (>0 redova)
#   bridge_sync_log (svi runs status='success')
```

### Korak 6 — Instalacija kao Windows Service

**WAŽNO: PowerShell mora biti pokrenut kao Administrator.**

```powershell
npm run service:install
```

Servis se zove `Servoteh Bridge`, auto-startuje na boot.

```powershell
# Provera statusa
Get-Service "Servoteh Bridge"   # mora biti Status: Running

# Ili kroz GUI: services.msc → "Servoteh Bridge"
```

### Korak 7 — Provera da scheduler radi

```powershell
# Real-time tail logova (Ctrl+C za izlaz)
Get-Content .\logs\bridge-$(Get-Date -Format yyyy-MM-dd).log -Tail 50 -Wait

# U logovima moras videti:
#   "scheduler] catalogs job registered"  (cron 0 6 * * *)
#   "scheduler] production job registered" (cron */15 * * * *)

# Sledeci 15-min tick (ako je 14:23 sad, sledeci ce biti u 14:30):
#   "[scheduler] production_15min start" + 5 sub-job log redova
```

### Korak 8 — Log rotacija (jednom, kao Administrator)

Brisanje logova starijih od 30 dana, svaki dan u 03:00:

```powershell
Register-ScheduledTask `
  -TaskName "Servoteh Bridge - rotate logs" `
  -Action (New-ScheduledTaskAction `
             -Execute "powershell.exe" `
             -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\Servoteh\servoteh-bridge\scripts\rotate-logs.ps1") `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 3am) `
  -User "SYSTEM" `
  -RunLevel Highest

# Test (rucno):
Start-ScheduledTask "Servoteh Bridge - rotate logs"
```

### Korak 9 — Verifikacija u Supabase (10 minuta posle service install-a)

```sql
-- Skoro proizvedeni runs (treba bar 1 production_15min uspesan)
SELECT sync_job, status, started_at, duration_ms, rows_updated
FROM bridge_sync_log
ORDER BY started_at DESC
LIMIT 20;
```

Ako su svi `status='success'` i `production_15min` se ponavlja na svakih 15 min → **deploy je uspesan**.

### Update koda (kad nove faze stignu)

```powershell
Stop-Service "Servoteh Bridge"
cd C:\Servoteh\servoteh-bridge
git pull
npm install --omit=dev
# Pokreni nove SQL migracije ako ih ima (vidi commit log za xxx_bridge_*.sql)
Start-Service "Servoteh Bridge"
```

### Uninstall (ako treba premestiti na drugi server)

```powershell
Stop-Service "Servoteh Bridge"
npm run service:uninstall
Unregister-ScheduledTask "Servoteh Bridge - rotate logs" -Confirm:$false
```

---

## Alerting (Telegram + generic webhook)

Bridge može da te obavesti odmah kad neki sync padne. Kanali su opcioni — ako su prazni, nema poruka.

### Telegram (preporuka — najlakše setupovati)

1. Otvori [@BotFather](https://t.me/BotFather) u Telegramu, pošalji `/newbot`, kopiraj **TOKEN** (npr. `7123456789:AAH...`).
2. Kreiraj **grupu** "Servoteh Bridge alerts" (ili koristi private chat sa botom). Dodaj bota u grupu.
3. Pošalji bilo koju poruku u chat (da bot može da je vidi). Onda otvori u browseru:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Kopiraj `chat.id` (npr. `123456789` za 1-na-1 ili `-1001234567890` za grupu).
4. U `.env`:
   ```env
   ALERT_TELEGRAM_BOT_TOKEN=7123456789:AAH...
   ALERT_TELEGRAM_CHAT_ID=-1001234567890
   ```
5. Restart service: `Restart-Service "Servoteh Bridge"`.

Test (forsiraj grešku da vidiš poruku):
```powershell
# Privremeno postavi pogresan SQL user u .env i pokreni:
npm run sync:departments
# Telegram chat treba da dobije "🚨 Servoteh Bridge — sync greška".
# NE ZABORAVI vratiti pravi user u .env!
```

### Generic webhook (Slack / Discord / Teams / Mattermost)

```env
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../...
# ili Discord:
# ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
```

Bridge POST-uje JSON sa `text`, `content`, `level`, `job`, `error_message`, `stack`. Slack i Mattermost čitaju `text`, Discord čita `content`.

### Throttling

Notifier ima ugrađen rate limit od **1h po istom job-u**. Znači: ako `production_work_orders` pukne svakih 15 min, dobijaš 1 poruku po satu, ne 4. To sprečava spam — i dalje vidiš puni audit u `bridge_sync_log`.

---

## Troubleshooting

### `ConnectionError: Failed to connect to Vasa-SQL:5765`
- Proveri sa Bridge servera: `Test-NetConnection Vasa-SQL -Port 5765`
- Proveri firewall (i na Bridge serveru i na SQL serveru)
- Da li SQL Server ima TCP/IP enabled? (SQL Server Configuration Manager → Protocols → TCP/IP → Enabled)
- Da li `bridge_reader` login ima pristup do `QBigTehn` baze?

### `[supabase] upsert ... failed: relation "bigtehn_..._cache" does not exist`
- Supabase tabele nisu kreirane. Vidi sekciju "Preduslovi → U Supabase-u" iznad.

### `RequestError: Invalid column name 'X'.`
- Pretpostavljena shema u nekom `sync*.js` fajlu ne odgovara stvarnoj BigTehn tabeli. Pokreni:
  ```powershell
  npm run discover:columns -- <NazivTabele>
  ```
- Output ti pokazuje sve kolone + sample TOP 5 redova. Ažuriraj SQL na vrhu odgovarajućeg `src/jobs/sync*.js` fajla, a po potrebi i mapiranje u `mapRow()`. Ako se poklope nazivi → ažuriraj i Supabase shemu odgovarajuće cache tabele.

### `[supabase] ... permission denied`
- Bridge koristi `SUPABASE_SERVICE_ROLE_KEY` (bypassuje RLS). Ako vidiš permission denied, koristi `SERVICE_ROLE` key, ne `ANON` key. Provera: `dashboard.supabase.com → Project Settings → API → Service role key` (NE Anon public).

### Servis se ne startuje (Event Viewer pokazuje grešku)
- Logovi: `Event Viewer → Windows Logs → Application` (filter source = "Servoteh Bridge")
- Najčešće: `.env` fajl nedostupan. node-windows servis NE čita `.env` automatski sa workingDirectory u svim slučajevima — alternativa je staviti env vars u **System Environment Variables** (`Edit the system environment variables` → Environment Variables → System variables).

### Logovi previše rastu
- Trenutna verzija pravi 1 fajl po danu (`bridge-YYYY-MM-DD.log`). Setup automatske rotacije je u sekciji "Production deployment → Korak 8" (PowerShell scheduled task koji svaki dan u 03:00 pokreće `scripts/rotate-logs.ps1` i briše fajlove starije od 30 dana).
- Manuelni run: `.\scripts\rotate-logs.ps1` ili sa custom RetentionDays: `.\scripts\rotate-logs.ps1 -RetentionDays 14`.

### Telegram alert ne stiže iako je `.env` popunjen
- Provera u logu: traži `alert channels active` na startup-u. Ako vidiš `no alert channels configured`, env vars nisu pročitani — restart service.
- Provera tokena: otvori `https://api.telegram.org/bot<TOKEN>/getMe` u browseru. Mora vratiti JSON sa `"ok":true`. Ako ne, token je pogrešan.
- Provera `chat_id`: pošalji testnu poruku botu u tom chat-u, pa otvori `https://api.telegram.org/bot<TOKEN>/getUpdates`. `result[0].message.chat.id` je tvoj `chat_id`. **Grupe imaju negativne ID-eve** (npr. `-1001234567890`) — uključi minus znak.
- Ako bot je u grupi sa "privacy mode" ON, neće videti poruke. Setup: `/setprivacy` u BotFather-u → izaberi bota → Disable.

---

## Sigurnosna napomena

- `.env` je u `.gitignore` — **nikad ga ne commit-uj**.
- `SUPABASE_SERVICE_ROLE_KEY` daje pun pristup bazi (bypass RLS). Drži ga samo na serveru gde Bridge radi.
- `tRadnici.Password` i `PasswordRadnika` su **plaintext** u BigTehn-u. Bridge ih EKSPLICITNO ne čita (vidi `src/jobs/syncWorkers.js` SQL — kolone su izostavljene).
- Preporuka: SQL Server login `bridge_reader` neka ima samo `SELECT` privilegije na ograničen skup tabela (ne `db_owner`, ne `sysadmin`).

---

## Sledeće faze (van scope-a 1B + B.2.2 + B.2.3)

- **B.2.4** — sync `tTehPostupak` (template operacija po crtežu) — read-only katalog/template, dnevno
- **1D** — overlays + upload crteža u Supabase
- **1E** — write-back (lansiran/saglasan/tehpostupak/StatusRN)

Plan: `BIGTEHN_DATA_MAP.md`, sekcija 8 (uz korekciju za sekciju 5/3.1 koja je netačno opisivala `tLokacijeDelova`).

---

## SCADA relay (Energetika) — 2026-07

Bridge od 2026-07 ima i **SCADA relay** za nadzor/upravljanje kotlarnicama i
solarima: čita lokalni HTTP API SCADA aplikacije (`scada-app/`, ista mašina) i
upisuje `scada_snapshots` / `scada_history` / `scada_alarms` u Supabase +
izvršava `scada_commands` (allowlist + rate-limit + audit).

- Kod: `src/scada/*` (client, normalize, allowlist, loop) + `src/jobs/scadaSnapshot.js`, `src/jobs/scadaCommands.js`
- Uključivanje: `SCADA_ENABLED=true` u `.env` (vidi `.env.example`, SCADA sekcija)
- Per-mašina profil: `ENABLE_JOB_CATALOGS` / `ENABLE_JOB_PRODUCTION` (BigTehn server: true/true; SCADA VM: false/false + `SCADA_ENABLED=true`)
- One-shot testovi: `npm run sync:scada`, `npm run sync:scada-commands`
- Kompletno uputstvo: `docs/scada/bridge-scada-install.md` (repo root)

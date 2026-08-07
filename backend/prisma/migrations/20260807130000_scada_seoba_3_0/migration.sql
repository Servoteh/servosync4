-- Seoba sy15 -> 3.0, KORAK 5: ENERGETIKA / SCADA (07.08.2026)
-- Merenje i runbook: docs/SEOBA_SCADA_2026-08-07.md
-- Plan: docs/PLAN_GASENJA_SY15_2026-08-03.md (korak 5, SCADA/bridge).
--
-- Generisano OFFLINE: `prisma migrate diff` datamodel->datamodel (origin/main schema
-- -> ova grana), po BACKEND_RULES §12 v0.7. `migrate dev` na produkciji je zabranjen;
-- primenjuje se ISKLJUCIVO `migrate:prod` (deploy) uz prethodni `migrate status`.
--
-- ┌─ 🔴 ISTORIJA SE NE PRENOSI ─────────────────────────────────────────────────┐
-- │ Odluka vlasnika 07.08.2026, doslovno: „ne hajemo za stare podatke",         │
-- │ „ostati bez te istorije cak i od dva meseca, ne treba nam".                 │
-- │                                                                            │
-- │ Zato NEMA skripte za prenos podataka i NEMA je ni u planu. Izmereno u sy15  │
-- │ 07.08.2026 i namerno OSTAVLJENO DA UMRE sa tom bazom:                       │
-- │     scada_history       2.549.847 redova  (02.07.-07.08.2026, ~3.540/h)     │
-- │     scada_alarms           13.204 redova                                    │
-- │     scada_commands             29 redova                                    │
-- │     scada_snapshots             5 redova  (relej ih prepise za ~5 s)        │
-- │     scada_notify_prefs          0 redova                                    │
-- │                                                                            │
-- │ Tabele posle ove migracije STOJE PRAZNE. To je ocekivano i ispravno stanje: │
-- │ relej (servoteh-bridge-scada) ih puni od trenutka preklopa `SCADA_IZVOR`.   │
-- │ Trend-ekrani su prazni dok se prozor ne napuni (~24 h za pun dnevni grafik).│
-- └────────────────────────────────────────────────────────────────────────────┘
--
-- IZUZETAK — `scada_sites` (5 redova) SE SEEDUJE na dnu ovog fajla. To NIJE istorija
-- nego KONFIGURACIJA, i bez nje seoba ne radi uopste: `scada_sites.key` je FK roditelj
-- svim ostalim tabelama, a relej sistem samo UPDATE-uje (`online`/`last_seen`) i nikad
-- ga ne insertuje. Bez seeda bi PRVI upis snapshota pao na FK gresci.
--
-- Redosled `migrate diff`-a postuje FK; SQL-only dodaci (CHECK-ovi, parcijalni indeksi,
-- seed) idu na kraj fajla jer ih Prisma schema ne ume da izrazi.
-- CreateTable
CREATE TABLE "scada_sites" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "protocol" TEXT,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "last_seen" TIMESTAMPTZ(6),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "pk_scada_sites" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "scada_snapshots" (
    "site_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_scada_snapshots" PRIMARY KEY ("site_key")
);

-- CreateTable
CREATE TABLE "scada_history" (
    "site_key" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "value" DOUBLE PRECISION,

    CONSTRAINT "pk_scada_history" PRIMARY KEY ("site_key","metric","ts")
);

-- CreateTable
CREATE TABLE "scada_alarms" (
    "id" BIGSERIAL NOT NULL,
    "site_key" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" SMALLINT NOT NULL DEFAULT 3,
    "text" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleared_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_scada_alarms" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scada_commands" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_key" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "op" TEXT NOT NULL DEFAULT 'set',
    "value" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "applied_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL DEFAULT (now() + '00:02:00'::interval),
    "idempotency_key" TEXT,
    "result" JSONB,

    CONSTRAINT "pk_scada_commands" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scada_notify_prefs" (
    "user_email" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "min_severity" SMALLINT NOT NULL DEFAULT 3,
    "sites" TEXT[],
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_scada_notify_prefs" PRIMARY KEY ("user_email")
);

-- CreateIndex
CREATE INDEX "idx_scada_history_lookup" ON "scada_history"("site_key", "metric", "ts" DESC);

-- CreateIndex
CREATE INDEX "idx_scada_alarms_active" ON "scada_alarms"("site_key", "active");

-- CreateIndex
CREATE INDEX "idx_scada_commands_recent" ON "scada_commands"("site_key", "requested_at" DESC);

-- AddForeignKey
ALTER TABLE "scada_snapshots" ADD CONSTRAINT "fk_scada_snapshots_site" FOREIGN KEY ("site_key") REFERENCES "scada_sites"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scada_history" ADD CONSTRAINT "fk_scada_history_site" FOREIGN KEY ("site_key") REFERENCES "scada_sites"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scada_alarms" ADD CONSTRAINT "fk_scada_alarms_site" FOREIGN KEY ("site_key") REFERENCES "scada_sites"("key") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scada_commands" ADD CONSTRAINT "fk_scada_commands_site" FOREIGN KEY ("site_key") REFERENCES "scada_sites"("key") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- SQL-only dodaci (Prisma schema ih ne ume izraziti) — preslikani sa zive sy15
-- strukture (`\d public.scada_*`, mereno 07.08.2026).
-- ============================================================================

-- CHECK-ovi: isti kao u sy15 (`scada_sites_kind_check`, `scada_commands_status_check`).
-- Vrednosti se NE prosiruju u ovoj migraciji — svako novo `kind`/`status` je odluka
-- domena, ne posledica seobe.
ALTER TABLE "scada_sites"
  ADD CONSTRAINT "scada_sites_kind_check" CHECK ("kind" IN ('kotlarnica', 'fne'));

ALTER TABLE "scada_commands"
  ADD CONSTRAINT "scada_commands_status_check"
  CHECK ("status" IN ('pending', 'claimed', 'applied', 'failed', 'expired', 'rejected'));

-- Parcijalni UNIQUE: isti alarm ne sme da postoji dvaput kao AKTIVAN. Ovo je brana
-- koja drzi diff-sync releja idempotentnim — bez nje bi restart releja usred prolaza
-- mogao da udvoji aktivan alarm i korisnik bi isti kvar video dva puta.
CREATE UNIQUE INDEX "scada_alarms_one_active"
  ON "scada_alarms" ("site_key", "code") WHERE "active";

-- Parcijalni UNIQUE nad `idempotency_key`: dupli klik u UI-ju → 23505 → 409,
-- umesto dva ista upisa na PLC. NULL kljucevi se ne sudaraju (WHERE NOT NULL).
CREATE UNIQUE INDEX "scada_commands_idem"
  ON "scada_commands" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;

-- Poll releja gadja iskljucivo `pending` — parcijalni indeks drzi taj upit na
-- nekoliko redova umesto na celoj tabeli komandi (koja se NIKAD ne brise).
CREATE INDEX "scada_commands_pending"
  ON "scada_commands" ("status", "site_key") WHERE "status" = 'pending';

-- ============================================================================
-- SEED: 5 nadziranih sistema (KONFIGURACIJA, ne istorija — v. zaglavlje)
-- ============================================================================
-- Preslikano 1:1 sa zive sy15 `scada_sites` (07.08.2026). `online`/`last_seen` se
-- NAMERNO ne seeduju: to je heartbeat koji relej upise pri prvom prolazu, a lazan
-- `online=true` pre prvog prolaza bi na ekranu prikazao sistem kao ispravan iako se
-- jos niko nije javio. Default `online=false` je istinit dok relej ne kaze drugacije.
--
-- `ON CONFLICT DO NOTHING` — migracija sme da se primeni na bazu u kojoj sistemi vec
-- postoje (npr. ponovljen `migrate deploy` na probnoj bazi) bez gazenja podesavanja.
INSERT INTO "scada_sites" ("key", "name", "kind", "protocol", "sort_order", "meta") VALUES
  ('kot1',        'Kotlarnica 1 (Unitronics)',          'kotlarnica', 'pcom',    1, '{"api": "/api/state"}'),
  ('kot2',        'Kotlarnica 2 — Hala 5 (Siemens S7)', 'kotlarnica', 's7',      2, '{"api": "/api/s7"}'),
  ('kot3',        'Kotlarnica 3 — Nova zgrada (Loxone)','kotlarnica', 'loxone',  3, '{"api": "/api/loxone"}'),
  ('solar-kaco',  'FNE Servoteh (KACO blue''Log)',      'fne',        'bluelog', 4, '{"api": "/api/bluelog"}'),
  ('solar-sigen', 'Solar Sigenergy (cloud)',            'fne',        'sigen',   5, '{"api": "/api/sigen"}')
ON CONFLICT ("key") DO NOTHING;

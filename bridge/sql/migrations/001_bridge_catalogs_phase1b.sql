-- =====================================================================
-- Servoteh Bridge — Faza 1B Supabase shema
--
-- Run JEDNOM u Supabase SQL Editor (https://supabase.com/dashboard ->
-- tvoj projekat -> SQL Editor -> New query -> paste -> Run).
--
-- Kreira:
--   1. bridge_sync_log              (audit trail svih sync runova)
--   2. bigtehn_departments_cache    (sektori)
--   3. bigtehn_machines_cache       (mašine / radni centri)
--   4. bigtehn_customers_cache      (komitenti)
--   5. bigtehn_workers_cache        (radnici BigTehn-a, BEZ Password kolona)
--   6. bigtehn_locations_cache      (lokacije/police, pretpostavljena shema)
--   + RLS politike (read za authenticated; Bridge piše preko SERVICE_ROLE
--     koji ionako bypassuje RLS).
-- =====================================================================

-- 1) bridge_sync_log
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
CREATE INDEX IF NOT EXISTS idx_sync_log_job
  ON bridge_sync_log(sync_job, started_at DESC);

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
CREATE INDEX IF NOT EXISTS idx_bigtehn_machines_dept
  ON bigtehn_machines_cache(department_id);

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
--    NAPOMENA: NIKAD ne dodavati Password / PasswordRadnika kolone.
--    Bridge ih eksplicitno ne čita iz BigTehn-a (vidi src/jobs/syncWorkers.js).
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

-- 6) bigtehn_locations_cache  (PRETPOSTAVLJENA SHEMA)
--    Ako prvi `npm run sync:locations` padne sa "Invalid column name":
--      npm run discover:columns -- tLokacijeDelova
--    pa ažuriraj ovu shemu i src/jobs/syncLocations.js.
CREATE TABLE IF NOT EXISTS bigtehn_locations_cache (
  id INT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT,
  department_id TEXT REFERENCES bigtehn_departments_cache(id),
  is_active BOOLEAN DEFAULT TRUE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bigtehn_locations_dept
  ON bigtehn_locations_cache(department_id);

-- =====================================================================
-- RLS — Bridge koristi SERVICE_ROLE key i bypassuje RLS automatski.
-- Aplikaciji (authenticated useri) damo SAMO read.
-- =====================================================================

ALTER TABLE bigtehn_departments_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_machines_cache    ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_customers_cache   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_workers_cache     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_locations_cache   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridge_sync_log           ENABLE ROW LEVEL SECURITY;

-- DROP IF EXISTS pa CREATE — idempotentno (možeš da pokreneš ovaj fajl više puta).
DROP POLICY IF EXISTS "authenticated_read" ON bigtehn_departments_cache;
DROP POLICY IF EXISTS "authenticated_read" ON bigtehn_machines_cache;
DROP POLICY IF EXISTS "authenticated_read" ON bigtehn_customers_cache;
DROP POLICY IF EXISTS "authenticated_read" ON bigtehn_workers_cache;
DROP POLICY IF EXISTS "authenticated_read" ON bigtehn_locations_cache;
DROP POLICY IF EXISTS "authenticated_read" ON bridge_sync_log;

CREATE POLICY "authenticated_read" ON bigtehn_departments_cache
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_machines_cache
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_customers_cache
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_workers_cache
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bigtehn_locations_cache
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON bridge_sync_log
  FOR SELECT TO authenticated USING (true);

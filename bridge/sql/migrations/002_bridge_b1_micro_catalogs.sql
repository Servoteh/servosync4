-- =====================================================================
-- Servoteh Bridge — Faza 1B dopuna (Sprint B.1)
--
-- Run JEDNOM u Supabase SQL Editor (https://supabase.com/dashboard ->
-- tvoj projekat -> SQL Editor -> New query -> paste -> Run).
--
-- Kreira 3 mala kataloga (~5 + ~10 + ~50 redova):
--   1. bigtehn_worker_types_cache    (tVrsteRadnika  — vrste radnika)
--   2. bigtehn_quality_types_cache   (tVrsteKvalitetaDelova — vrste
--                                     kvaliteta delova: OK, ŠKART…)
--   3. bigtehn_positions_cache       (tPozicije — police K-A1, K-S=škart…
--                                     ovo je PRAVI katalog "lokacija"
--                                     delova; tLokacijeDelova je
--                                     transakcioni log, ide u Fazu 2)
-- + RLS politike (read za authenticated; Bridge piše preko SERVICE_ROLE
--   koji ionako bypassuje RLS).
--
-- Idempotent: koristi IF NOT EXISTS i DROP/CREATE POLICY IF EXISTS.
-- =====================================================================

-- 1) bigtehn_worker_types_cache
CREATE TABLE IF NOT EXISTS bigtehn_worker_types_cache (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  has_extra_auth BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2) bigtehn_quality_types_cache
CREATE TABLE IF NOT EXISTS bigtehn_quality_types_cache (
  id INT PRIMARY KEY,
  name TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3) bigtehn_positions_cache (police: K-A1, K-S=škart…)
CREATE TABLE IF NOT EXISTS bigtehn_positions_cache (
  id INT PRIMARY KEY,
  code TEXT NOT NULL,
  description TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bigtehn_positions_code
  ON bigtehn_positions_cache(code);

-- ---------------------------------------------------------------------
-- RLS — Bridge koristi SERVICE_ROLE key (bypass RLS).
-- Aplikacija (authenticated users) ima samo read pristup.
-- ---------------------------------------------------------------------
ALTER TABLE bigtehn_worker_types_cache  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_quality_types_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE bigtehn_positions_cache     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON bigtehn_worker_types_cache;
CREATE POLICY "authenticated_read" ON bigtehn_worker_types_cache
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_read" ON bigtehn_quality_types_cache;
CREATE POLICY "authenticated_read" ON bigtehn_quality_types_cache
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "authenticated_read" ON bigtehn_positions_cache;
CREATE POLICY "authenticated_read" ON bigtehn_positions_cache
  FOR SELECT TO authenticated USING (true);

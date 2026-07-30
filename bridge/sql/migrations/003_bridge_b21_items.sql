-- =====================================================================
-- Servoteh Bridge — Sprint B.2.1: Items (Predmeti)
--
-- Run JEDNOM u Supabase SQL Editor (https://supabase.com/dashboard ->
-- tvoj projekat -> SQL Editor -> New query -> paste -> Run).
--
-- Kreira:
--   bigtehn_items_cache  (Predmeti — proizvodni "predmeti"/projekti
--                         iz BigTehn-a, ~10k+ redova).
--
-- "Predmet" je kontejner za radne naloge (jedan predmet ima više tRN-ova).
-- Status: 'OTVOREN' / 'GOTOVO' / itd.
--
-- + RLS politike (read za authenticated; Bridge piše preko SERVICE_ROLE
--   koji ionako bypassuje RLS).
--
-- Idempotent: koristi IF NOT EXISTS i DROP/CREATE POLICY IF EXISTS.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bigtehn_items_cache (
  id INT PRIMARY KEY,
  broj_predmeta TEXT NOT NULL,
  naziv_predmeta TEXT,
  opis TEXT,
  status TEXT,
  customer_id INT,           -- nije FK na bigtehn_customers_cache jer dozvoljava NULL i obrisane
  seller_id INT,
  work_type_id INT,
  department_code TEXT,
  broj_ugovora TEXT,
  broj_narudzbenice TEXT,
  datum_otvaranja TIMESTAMPTZ,
  datum_zakljucenja TIMESTAMPTZ,
  rok_zavrsetka TIMESTAMPTZ,
  datum_ugovora TIMESTAMPTZ,
  datum_narudzbenice TIMESTAMPTZ,
  modified_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indeksi za najčešće upite iz aplikacije (filter po komitentu, statusu,
-- datumu otvaranja DESC za najnovije, broju predmeta za search).
CREATE INDEX IF NOT EXISTS idx_bigtehn_items_customer
  ON bigtehn_items_cache(customer_id);

CREATE INDEX IF NOT EXISTS idx_bigtehn_items_status
  ON bigtehn_items_cache(status);

CREATE INDEX IF NOT EXISTS idx_bigtehn_items_datum_otvaranja
  ON bigtehn_items_cache(datum_otvaranja DESC);

CREATE INDEX IF NOT EXISTS idx_bigtehn_items_broj
  ON bigtehn_items_cache(broj_predmeta);

CREATE INDEX IF NOT EXISTS idx_bigtehn_items_modified
  ON bigtehn_items_cache(modified_at DESC);

-- ---------------------------------------------------------------------
-- RLS — Bridge koristi SERVICE_ROLE key (bypass RLS).
-- Aplikacija (authenticated users) ima samo read pristup.
-- ---------------------------------------------------------------------
ALTER TABLE bigtehn_items_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_read" ON bigtehn_items_cache;
CREATE POLICY "authenticated_read" ON bigtehn_items_cache
  FOR SELECT TO authenticated USING (true);

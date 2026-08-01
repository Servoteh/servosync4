-- ============================================================================
-- Bridge: SPRINT B.2.3 — Kretanje delova (transakcioni log)
-- ============================================================================
-- Pokreni JEDNOM u Supabase SQL Editoru.
--
-- Šta dodaje:
--   - bigtehn_part_movements_cache  (tLokacijeDelova, transakcioni log)
--
-- Sync strategija: WATERMARK (incremental po COALESCE(DatumIVremeUnosa, Datum)).
-- Cron: */15 minuta (deo syncProduction composite-a). Service role piše,
-- anon role čita (RLS).
--
-- Šema BigTehn izvora (potvrđeno discover-om 2026-04-19):
--   IDLokacije        int    NO    PK
--   IDRN              int    NO    -- "0" = bez RN-a
--   IDPredmet         int    NO    -- "0" = bez predmeta
--   IDVrstaKvaliteta  int    NO    -- "0" = neodređeno
--   IDPozicija        int    NO    -- "0" = bez police
--   SifraRadnika      int    NO    -- "0" = sistem
--   Datum             datetime NO     -- datum kretanja
--   Kolicina          int    NO
--   DatumIVremeUnosa  datetime YES    -- watermark (može biti NULL)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bigtehn_part_movements_cache (
  id                bigint PRIMARY KEY,                       -- IDLokacije
  work_order_id     bigint,                                   -- IDRN -> bigtehn_work_orders_cache(id), NULL ako 0
  item_id           bigint,                                   -- IDPredmet -> bigtehn_items_cache(id), NULL ako 0
  quality_type_id   bigint,                                   -- IDVrstaKvaliteta -> bigtehn_quality_types_cache(id), NULL ako 0
  position_id       bigint,                                   -- IDPozicija -> bigtehn_positions_cache(id), NULL ako 0
  worker_id         bigint,                                   -- SifraRadnika -> bigtehn_workers_cache(id), NULL ako 0
  datum             timestamptz,                              -- Datum (datum transfera, vreme = 00:00)
  kolicina          integer NOT NULL DEFAULT 0,
  created_at        timestamptz,                              -- DatumIVremeUnosa (može biti NULL u starim redovima)
  synced_at         timestamptz NOT NULL DEFAULT now()
);

-- Indeksi za UI use-case-ove:
CREATE INDEX IF NOT EXISTS bigtehn_pm_cache_wo_idx
  ON public.bigtehn_part_movements_cache (work_order_id);
CREATE INDEX IF NOT EXISTS bigtehn_pm_cache_item_idx
  ON public.bigtehn_part_movements_cache (item_id);
CREATE INDEX IF NOT EXISTS bigtehn_pm_cache_position_idx
  ON public.bigtehn_part_movements_cache (position_id);
CREATE INDEX IF NOT EXISTS bigtehn_pm_cache_worker_idx
  ON public.bigtehn_part_movements_cache (worker_id);
CREATE INDEX IF NOT EXISTS bigtehn_pm_cache_quality_idx
  ON public.bigtehn_part_movements_cache (quality_type_id);
CREATE INDEX IF NOT EXISTS bigtehn_pm_cache_created_idx
  ON public.bigtehn_part_movements_cache (created_at DESC);
-- Compound za "istorija po RN-u":
CREATE INDEX IF NOT EXISTS bigtehn_pm_cache_wo_datum_idx
  ON public.bigtehn_part_movements_cache (work_order_id, datum DESC);

-- ============================================================================
-- RLS — read za authenticated, write samo service_role
-- ============================================================================
ALTER TABLE public.bigtehn_part_movements_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "part movements cache: read for authenticated"
  ON public.bigtehn_part_movements_cache;
CREATE POLICY "part movements cache: read for authenticated"
  ON public.bigtehn_part_movements_cache FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- Hint: Service role (Bridge) pristupa kroz REST sa SUPABASE_SERVICE_ROLE_KEY
-- i automatski bypass-uje sve RLS politike. Nije potrebna posebna policy.
-- ============================================================================

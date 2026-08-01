-- ============================================================================
-- Bridge: SPRINT B.2.2 — Production tracking (4 incremental cache tabele)
-- ============================================================================
-- Pokreni JEDNOM u Supabase SQL Editoru.
--
-- Šta dodaje:
--   1) bigtehn_work_orders_cache            (tRN, ~30k+ redova)
--   2) bigtehn_work_order_lines_cache       (tStavkeRN, ~100k+ redova)
--   3) bigtehn_work_order_launches_cache    (tLansiranRN)
--   4) bigtehn_work_order_approvals_cache   (tSaglasanRN)
--
-- Sync strategija: WATERMARK (incremental po DIVIspravkeRN/DIVIspravke).
-- Cron: */15 minuta. Service role piše, anon role čita (RLS).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) bigtehn_work_orders_cache  (parent — radni nalozi)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bigtehn_work_orders_cache (
  id                    bigint PRIMARY KEY,                    -- IDRN
  item_id               bigint,                                -- IDPredmet -> bigtehn_items_cache(id)
  customer_id           bigint,                                -- BBIDKomitent -> bigtehn_customers_cache(id)
  ident_broj            text NOT NULL,                         -- "1839/10-1"
  varijanta             integer NOT NULL DEFAULT 0,
  broj_crteza           text,
  naziv_dela            text,
  materijal             text,
  dimenzija_materijala  text,
  jedinica_mere         text,
  komada                integer NOT NULL DEFAULT 0,
  tezina_neobr          double precision NOT NULL DEFAULT 0,
  tezina_obr            double precision NOT NULL DEFAULT 0,
  status_rn             boolean NOT NULL DEFAULT false,        -- false = u radu, true = završen
  zakljucano            boolean NOT NULL DEFAULT false,
  revizija              text,
  quality_type_id       bigint,                                -- -> bigtehn_quality_types_cache(id)
  handover_status_id    integer,
  napomena              text,
  rok_izrade            timestamptz,
  datum_unosa           timestamptz,
  created_at            timestamptz,
  modified_at           timestamptz,                           -- DIVIspravkeRN (watermark izvor)
  author_worker_id      bigint,                                -- -> bigtehn_workers_cache(id)
  synced_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bigtehn_wo_cache_item_idx
  ON public.bigtehn_work_orders_cache (item_id);
CREATE INDEX IF NOT EXISTS bigtehn_wo_cache_customer_idx
  ON public.bigtehn_work_orders_cache (customer_id);
CREATE INDEX IF NOT EXISTS bigtehn_wo_cache_ident_idx
  ON public.bigtehn_work_orders_cache (ident_broj);
CREATE INDEX IF NOT EXISTS bigtehn_wo_cache_status_idx
  ON public.bigtehn_work_orders_cache (status_rn);
CREATE INDEX IF NOT EXISTS bigtehn_wo_cache_modified_idx
  ON public.bigtehn_work_orders_cache (modified_at DESC);

-- ----------------------------------------------------------------------------
-- 2) bigtehn_work_order_lines_cache  (operacije po RN-u)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bigtehn_work_order_lines_cache (
  id                bigint PRIMARY KEY,                        -- IDStavkeRN
  work_order_id     bigint NOT NULL,                           -- IDRN -> bigtehn_work_orders_cache(id)
  operacija         integer NOT NULL DEFAULT 0,                -- 5, 10, 15...
  machine_code      text,                                      -- RJgrupaRC ("8.3", "10.1")
  opis_rada         text,
  alat_pribor       text,
  tpz               double precision NOT NULL DEFAULT 0,       -- pripremno-završno vreme
  tk                double precision NOT NULL DEFAULT 0,       -- komadno vreme
  tezina_to         double precision NOT NULL DEFAULT 0,
  author_worker_id  bigint,
  created_at        timestamptz,
  modified_at       timestamptz,                               -- DIVIspravke (watermark izvor)
  prioritet         integer NOT NULL DEFAULT 100,
  synced_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bigtehn_wo_lines_wo_idx
  ON public.bigtehn_work_order_lines_cache (work_order_id);
CREATE INDEX IF NOT EXISTS bigtehn_wo_lines_machine_idx
  ON public.bigtehn_work_order_lines_cache (machine_code);
CREATE INDEX IF NOT EXISTS bigtehn_wo_lines_modified_idx
  ON public.bigtehn_work_order_lines_cache (modified_at DESC);
CREATE INDEX IF NOT EXISTS bigtehn_wo_lines_wo_op_idx
  ON public.bigtehn_work_order_lines_cache (work_order_id, operacija);

-- ----------------------------------------------------------------------------
-- 3) bigtehn_work_order_launches_cache  (audit ko je lansirao RN)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bigtehn_work_order_launches_cache (
  id                  bigint PRIMARY KEY,                      -- IDLansiran
  work_order_id       bigint NOT NULL,                         -- IDRN
  lansiran            boolean NOT NULL DEFAULT false,
  datum_unosa         timestamptz,
  created_at          timestamptz,                             -- DIVUnos
  author_worker_id    bigint,
  potpis_unos         text,
  modified_at         timestamptz,                             -- DIVIspravke (watermark izvor)
  modifier_worker_id  bigint,
  potpis_ispravka     text,
  synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bigtehn_wo_launches_wo_idx
  ON public.bigtehn_work_order_launches_cache (work_order_id);
CREATE INDEX IF NOT EXISTS bigtehn_wo_launches_modified_idx
  ON public.bigtehn_work_order_launches_cache (modified_at DESC);

-- ----------------------------------------------------------------------------
-- 4) bigtehn_work_order_approvals_cache  (audit ko je dao saglasnost)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bigtehn_work_order_approvals_cache (
  id                  bigint PRIMARY KEY,                      -- IDSaglasan
  work_order_id       bigint NOT NULL,                         -- IDRN
  saglasan            boolean NOT NULL DEFAULT false,
  datum_unosa         timestamptz,
  created_at          timestamptz,                             -- DIVUnos
  author_worker_id    bigint,
  potpis_unos         text,
  modified_at         timestamptz,                             -- DIVIspravke (watermark izvor)
  modifier_worker_id  bigint,
  potpis_ispravka     text,
  synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bigtehn_wo_approvals_wo_idx
  ON public.bigtehn_work_order_approvals_cache (work_order_id);
CREATE INDEX IF NOT EXISTS bigtehn_wo_approvals_modified_idx
  ON public.bigtehn_work_order_approvals_cache (modified_at DESC);

-- ============================================================================
-- RLS — read za sve autentifikovane korisnike, write samo service_role
-- ============================================================================
ALTER TABLE public.bigtehn_work_orders_cache            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bigtehn_work_order_lines_cache       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bigtehn_work_order_launches_cache    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bigtehn_work_order_approvals_cache   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wo cache: read for authenticated" ON public.bigtehn_work_orders_cache;
CREATE POLICY "wo cache: read for authenticated"
  ON public.bigtehn_work_orders_cache FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "wo lines cache: read for authenticated" ON public.bigtehn_work_order_lines_cache;
CREATE POLICY "wo lines cache: read for authenticated"
  ON public.bigtehn_work_order_lines_cache FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "wo launches cache: read for authenticated" ON public.bigtehn_work_order_launches_cache;
CREATE POLICY "wo launches cache: read for authenticated"
  ON public.bigtehn_work_order_launches_cache FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "wo approvals cache: read for authenticated" ON public.bigtehn_work_order_approvals_cache;
CREATE POLICY "wo approvals cache: read for authenticated"
  ON public.bigtehn_work_order_approvals_cache FOR SELECT
  TO authenticated
  USING (true);

-- ============================================================================
-- Hint: Service role (Bridge) pristupa kroz REST sa SUPABASE_SERVICE_ROLE_KEY
-- i automatski bypass-uje sve RLS politike. Nije potrebna posebna policy.
-- ============================================================================

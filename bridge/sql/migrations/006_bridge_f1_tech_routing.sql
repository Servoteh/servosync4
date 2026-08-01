-- ============================================================================
-- Bridge: SPRINT F.1 — Tech Routing (tTehPostupak)
-- ============================================================================
-- Pokreni JEDNOM u Supabase SQL Editoru.
--
-- Šta dodaje:
--   - bigtehn_tech_routing_cache  (tTehPostupak — prijave rada po operaciji)
--
-- Sync strategija: WATERMARK (incremental po
--   COALESCE(DatumIVremeZavrsetka, DatumIVremeUnosa)).
-- Cron: */15 minuta (dodaje se u syncProduction composite).
--
-- Service role piše, anon role čita (RLS).
--
-- BigTehn izvor (potvrđeno discover-om 2026-04-19):
--   IDPostupka            int       NO    PK
--   SifraRadnika          int       NO          -- radnik koji je radio
--   IDPredmet             int       NO    (0)   -- deo koji se obrađuje
--   IdentBroj             nvarchar(50) NO
--   Varijanta             int       NO    (0)
--   PrnTimer              int       YES   (0)   -- STVARNO VREME u sekundama
--   DatumIVremeUnosa      datetime  NO    getdate()
--   Operacija             int       NO          -- 5, 10, 15... usklađeno sa tStavkeRN.Operacija
--   RJgrupaRC             nvarchar(5)  NO       -- mašina (kod, npr. "8.2")
--   Toznaka               nvarchar(50) NO
--   Komada                int       NO          -- koliko komada je urađeno u ovoj prijavi
--   Potpis                nvarchar(50) YES
--   SimbolRadnik          bit       YES   (0)
--   SimbolPostupak        bit       YES   (0)
--   SimbolOperacija       bit       YES   (0)
--   DatumIVremeZavrsetka  datetime  YES         -- kad je završeno
--   ZavrsenPostupak       bit       YES   (0)   -- ← AUTORITATIVNI SIGNAL "operacija gotova"
--   Napomena              ntext     YES
--   IDRN                  int       NO    (0)   -- FK -> bigtehn_work_orders_cache
--   IDVrstaKvaliteta      int       NO    (0)
--   DoradaOperacije       int       YES   (0)   -- broj dorada
--
-- Veza sa bigtehn_work_order_lines_cache:
--   JOIN ON (tech_routing.work_order_id = lines.work_order_id
--            AND tech_routing.operacija = lines.operacija)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bigtehn_tech_routing_cache (
  id                    BIGINT PRIMARY KEY,                    -- IDPostupka

  -- FK logički
  work_order_id         BIGINT,                                -- IDRN, NULL ako 0
  item_id               BIGINT,                                -- IDPredmet, NULL ako 0
  worker_id             BIGINT,                                -- SifraRadnika, NULL ako 0
  quality_type_id       BIGINT,                                -- IDVrstaKvaliteta, NULL ako 0

  -- Veza sa stavkom RN-a (operacijom): JOIN po (work_order_id, operacija)
  operacija             INTEGER NOT NULL,                      -- 5, 10, 15...
  machine_code          TEXT,                                  -- RJgrupaRC ("8.2")

  -- Količina + STVARNO VREME (ključno za workload statistiku)
  komada                INTEGER NOT NULL DEFAULT 0,
  prn_timer_seconds     INTEGER,                               -- stvarno vreme rada u sekundama

  -- Vremena
  started_at            TIMESTAMPTZ,                           -- DatumIVremeUnosa
  finished_at           TIMESTAMPTZ,                           -- DatumIVremeZavrsetka (NULL ako nije završeno)
  is_completed          BOOLEAN NOT NULL DEFAULT FALSE,        -- ZavrsenPostupak

  -- Dodatno
  ident_broj            TEXT,
  varijanta             INTEGER NOT NULL DEFAULT 0,
  toznaka               TEXT,
  potpis                TEXT,
  napomena              TEXT,                                  -- ntext, može biti dugačko
  dorada_operacije      INTEGER NOT NULL DEFAULT 0,

  synced_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- Indeksi za UI use-case-ove
-- ----------------------------------------------------------------------------
-- "Lista prijava po RN-u":
CREATE INDEX IF NOT EXISTS bigtehn_tr_cache_wo_idx
  ON public.bigtehn_tech_routing_cache (work_order_id);

-- "Da li je operacija X za RN Y završena?" (najčešći query za detekciju):
CREATE INDEX IF NOT EXISTS bigtehn_tr_cache_wo_op_idx
  ON public.bigtehn_tech_routing_cache (work_order_id, operacija);

-- "Završene operacije po mašini" (workload summary, stvarno vreme):
CREATE INDEX IF NOT EXISTS bigtehn_tr_cache_machine_completed_idx
  ON public.bigtehn_tech_routing_cache (machine_code, finished_at DESC)
  WHERE is_completed = TRUE;

-- "Istorija dela po mašinama" (forensic, stvarno vreme po komadu):
CREATE INDEX IF NOT EXISTS bigtehn_tr_cache_item_machine_idx
  ON public.bigtehn_tech_routing_cache (item_id, machine_code);

-- "Audit po radniku":
CREATE INDEX IF NOT EXISTS bigtehn_tr_cache_worker_idx
  ON public.bigtehn_tech_routing_cache (worker_id);

-- "Watermark / pretraga po datumu":
CREATE INDEX IF NOT EXISTS bigtehn_tr_cache_finished_idx
  ON public.bigtehn_tech_routing_cache (finished_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS bigtehn_tr_cache_started_idx
  ON public.bigtehn_tech_routing_cache (started_at DESC);

-- "Otvorene prijave" (in-progress, nije završeno):
CREATE INDEX IF NOT EXISTS bigtehn_tr_cache_in_progress_idx
  ON public.bigtehn_tech_routing_cache (machine_code, started_at DESC)
  WHERE is_completed = FALSE;

-- ============================================================================
-- RLS — read za authenticated, write samo service_role (Bridge)
-- ============================================================================
ALTER TABLE public.bigtehn_tech_routing_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tech routing cache: read for authenticated"
  ON public.bigtehn_tech_routing_cache;
CREATE POLICY "tech routing cache: read for authenticated"
  ON public.bigtehn_tech_routing_cache FOR SELECT
  TO authenticated
  USING (TRUE);

-- ============================================================================
-- Hint: Service role (Bridge) pristupa kroz REST sa SUPABASE_SERVICE_ROLE_KEY
-- i automatski bypass-uje sve RLS politike. Nije potrebna posebna policy.
-- ============================================================================

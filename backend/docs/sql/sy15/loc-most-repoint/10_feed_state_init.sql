-- B1 loc-most repoint — KORAK 1: feed state tabela (sy15). Preduslov za feed-run.
-- Izvršiti na sy15: psql -h 127.0.0.1 -p 5436 -U supabase_admin -d postgres
--
-- ZAŠTO SOPSTVENI WATERMARK (verify B1-OPS-1, blocker):
-- Legacy bridge watermark = started_at poslednjeg SUCCESS runa iz bridge_sync_log,
-- a bridge upisuje success i za PRAZAN run (tTehPostupak frozen → 0 redova) svakih
-- 15 min. Da feeder čitao odatle, prvi watermark bi bio „pre par minuta" i backlog
-- od 14.07 se NIKAD ne bi pokupio. Feeder zato ima svoj state; u bridge_sync_log i
-- dalje UPISUJE runove pod legacy imenima (monitoring paritet), ali odatle ne čita.

CREATE TABLE IF NOT EXISTS public.loc_tp_feed_state (
  id                     SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton
  last_tp_id             BIGINT      NOT NULL,  -- id watermark tech_processes → cache
  last_wo_modified_at    TIMESTAMPTZ NOT NULL,  -- work_orders.updated_at watermark
  last_line_modified_at  TIMESTAMPTZ NOT NULL,  -- work_order_operations.updated_at
  last_run_at            TIMESTAMPTZ,
  last_run_summary       JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.loc_tp_feed_state IS
  'B1 loc-most: watermark feeder-a 2.0 tech_processes/work_orders → bigtehn_*_cache. '
  'Namerno ODVOJEN od bridge_sync_log (prazni bridge success runovi bi progutali backlog).';

-- RLS paritet sa ostalim loc_* / bridge tabelama: čitanje samo prijavljenima;
-- piše ga isključivo backend konekciona rola (BYPASSRLS), kao bridge cache tabele.
ALTER TABLE public.loc_tp_feed_state ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname='public' AND tablename='loc_tp_feed_state'
       AND policyname='loc_tp_feed_state_read'
  ) THEN
    CREATE POLICY loc_tp_feed_state_read ON public.loc_tp_feed_state
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- SEED (jednokratno). Vrednosti se biraju po ODLUCI iz runbook koraka 1:
--
--  (a) BACKFILL od cutover-a (default, preporučeno): watermark = poslednje stanje
--      koje je legacy bridge stvarno sinhronizovao, tj. max(id) u cache-u i
--      max(modified_at) — sve što je 2.0 napravio posle toga ulazi u cache.
--      NAPOMENA: ingest sme da ih pretvori u pokrete tek kad se ARM-uje (korak 7);
--      do tada je dry-run. Odluka o tome da li backlog SME da postane pokret
--      donosi se u koraku 6 (04_advance_watermark.sql).
--
--  (b) START „OD SADA": zameni izraze konkretnim vrednostima iz preflight (F)/(G).
-- ---------------------------------------------------------------------------
INSERT INTO public.loc_tp_feed_state
  (id, last_tp_id, last_wo_modified_at, last_line_modified_at)
SELECT 1,
       COALESCE((SELECT max(id) FROM public.bigtehn_tech_routing_cache), 0),
       COALESCE((SELECT max(modified_at) FROM public.bigtehn_work_orders_cache),
                now() - INTERVAL '30 days'),
       COALESCE((SELECT max(modified_at) FROM public.bigtehn_work_order_lines_cache),
                now() - INTERVAL '30 days')
ON CONFLICT (id) DO NOTHING;

-- Kontrola:
SELECT * FROM public.loc_tp_feed_state;

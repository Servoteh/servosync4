-- B1 loc-most repoint — KORAK 3: relaksacija `skip_zero_qty` gate-a u ingest fn (sy15).
--
-- PROBLEM (verify B1-DATA-1, BLOCKER — bez ovoga se transferi SISTEMATSKI gube):
-- 2.0 kreira `tech_processes` red na START-sken sa piece_count = 0 (kumulativ raste
-- tek na STOP-sken/kontrolu). Feeder hvata red dok je komada=0 (radna sesija traje
-- minutima/satima), a `loc_bigtehn_ingest_run` u TRANSFER grani radi:
--     IF COALESCE(v_signal.komada, 0) = 0 THEN v_action := 'skip_zero_qty'; EXIT;
-- Signal je time TRAJNO potrošen (id-watermark ide napred, red se ne reprocessira),
-- pa se pokret M1→M2 gubi ZAUVEK — a upravo chain/shelf transferi su glavna vrednost
-- auto-ingesta. Kasniji rast komada ne vraća signal (isti id, watermark je prošao).
--
-- ZAŠTO JE RELAKSACIJA ISPRAVNA, A NE ZAOBILAZNICA:
-- `komada` iz signala se u TRANSFER grani NE koristi za količinu — količina je
-- `v_transfer_qty := v_current_qty` (zatečeno stanje placement-a). Gate je bio čist
-- filter „prijava bez učinka" iz legacy sveta gde je svaki red već nosio Komada.
-- U 2.0 semantici START-sken JESTE dokaz da je deo fizički na toj mašini.
-- Negativan `komada` (storno kontra-red) NE ulazi u cache — feeder ga odbacuje
-- (verify B1-DATA-6), pa ovde ne treba dodatna zaštita; gate ostaje samo za NULL.
--
-- KAKO: hirurški patch nad ŽIVOM definicijom (fn je ~320 linija; prepisivanje celog
-- tela iz snapshot-a od 12.07 bi rizikovalo gubitak kasnijih izmena). Skripta sama
-- verifikuje da postoji TAČNO JEDNA pojava obrasca — inače puca bez izmene.

\set ON_ERROR_STOP on

DO $patch$
DECLARE
  v_src     TEXT;
  v_new     TEXT;
  v_needle  TEXT := 'IF COALESCE(v_signal.komada, 0) = 0 THEN';
  v_repl    TEXT := 'IF v_signal.komada IS NULL THEN';
  v_hits    INT;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'loc_bigtehn_ingest_run';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'loc_bigtehn_ingest_run ne postoji u public šemi — STOP.';
  END IF;

  v_hits := (length(v_src) - length(replace(v_src, v_needle, ''))) / length(v_needle);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION
      'Očekivana TAČNO 1 pojava zero-qty gate-a, nađeno %. Živa definicija se razlikuje od analizirane — STOP, ručni pregled.',
      v_hits;
  END IF;

  v_new := replace(v_src, v_needle, v_repl);
  EXECUTE v_new;
  RAISE NOTICE 'loc_bigtehn_ingest_run: zero-qty gate relaksiran (komada=0 više ne preskače transfer).';
END
$patch$;

-- Kontrola (mora vratiti 1 red sa novim uslovom, 0 sa starim):
SELECT count(*) FILTER (WHERE pg_get_functiondef(p.oid) LIKE '%IF v_signal.komada IS NULL THEN%') AS patched,
       count(*) FILTER (WHERE pg_get_functiondef(p.oid) LIKE '%COALESCE(v_signal.komada, 0) = 0%') AS still_old
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'loc_bigtehn_ingest_run';

-- ROLLBACK: 01_originals_backup.sql (snimljen u koraku 1) vraća zatečenu definiciju.
-- NAPOMENA: brojač `skip_zero_qty` u last_run_summary ostaje u fn (sada broji samo
-- NULL slučajeve) — namerno, da se poređenje sa istorijskim runovima ne razbije.

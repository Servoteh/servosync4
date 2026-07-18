-- B1 loc-most repoint — ROLLBACK MATERIJAL (izvlačenje zatečenih definicija).
--
-- ⚠️ OVA SKRIPTA SE NE PRIMENJUJE — ona GENERIŠE rollback fajl. Izvršiti PRE bilo
-- koje izmene (runbook korak 1), a izlaz snimiti kao `01_originals_LIVE_<datum>.sql`
-- pored ove skripte (i commit-ovati u repo — dokaz zatečenog stanja).
--
-- Snapshot od 12.07 (docs/design/authz-snapshots/lokacije-fn-defs-2026-07-12.sql) je
-- iz ZAMRZNUTOG cloud izvora — živa sy15 može odstupati, zato se rollback materijal
-- uvek vadi iz ŽIVE baze, ne iz snapshot-a.
--
-- Upotreba (ubuntusrv):
--   psql -h 127.0.0.1 -p 5436 -U supabase_admin -d postgres -At \
--        -f 01_originals_backup.sql > 01_originals_LIVE_$(date +%F).sql
--
-- Vraćanje (rollback): psql ... -f 01_originals_LIVE_<datum>.sql

SELECT pg_get_functiondef(p.oid) || E';\n'
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'loc_after_movement_insert',   -- 40_: uklanja se outbound enqueue grana
     'loc_bigtehn_ingest_run'       -- 30_: relaksira se zero-qty gate
   )
 ORDER BY p.proname;

-- B1 loc-most repoint — KORAK 0: PRE-FLIGHT (READ-ONLY, ništa ne menja).
-- Izvršava se psql-om na OBE baze (vidi RUNBOOK_LOC_MOST_REPOINT.md §Korak 0):
--   sy15:  psql -h 127.0.0.1 -p 5436 -U supabase_admin -d postgres
--   2.0:   psql -h 127.0.0.1 -p 5435 -U <app user> -d servosync
-- Snimiti KOMPLETAN izlaz u dosije prelaza (rollback/forenzika baseline).

-- ============================================================================
-- (A) sy15 — ingest stanje: očekivano armed=FALSE (dry-run od 11.07)
-- ============================================================================
SELECT worker_id, armed, last_processed_signal_id, last_run_at
  FROM loc_bigtehn_ingest_state;

-- ============================================================================
-- (B) sy15 — pg_cron jobovi: koji su aktivni (očekivano: loc_bigtehn_ingest_5min,
--     loc_sync_health_check_hourly, loc_purge_synced_daily)
-- ============================================================================
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;

-- ============================================================================
-- (C) sy15 — outbound queue forenzika (verify B1-OPS-5: dokaz da je outbound
--     MRTAV mora biti potpun, ne samo PENDING count):
--     * očekivano ~1274 PENDING sa attempts=0 (od 28.04)
--     * NE SME postojati SYNCED/IN_PROGRESS red NOVIJEG datuma niti attempts>0
--     Ako (C2) vrati redove → outbound NIJE mrtav → STOP, koordinacija sa
--     Negovanom pre koraka gašenja (02 skripta se NE primenjuje).
-- ============================================================================
SELECT status, count(*), min(created_at), max(created_at), max(attempts)
  FROM loc_sync_outbound_events GROUP BY status ORDER BY status;          -- (C1)
SELECT id, status, attempts, created_at, synced_at, last_error
  FROM loc_sync_outbound_events
 WHERE status IN ('SYNCED','IN_PROGRESS') OR attempts > 0
 ORDER BY created_at DESC LIMIT 20;                                       -- (C2)

-- ============================================================================
-- (D) sy15 — heartbeat redovi (postoji li loc-sync-mssql red za 03 cleanup?)
-- ============================================================================
SELECT worker_id, last_seen, now() - last_seen AS age FROM loc_sync_worker_heartbeat;

-- ============================================================================
-- (E) sy15 — bridge_sync_log: DOKAZ watermark problema (verify B1-OPS-1):
--     poslednji run sa rows_updated>0 (očekivano ~14.07, kad je tTehPostupak
--     frozen) vs poslednji success run (očekivano „pre par minuta").
--     Feeder zato vodi SOPSTVENI watermark (loc_tp_feed_state) — ovo je baseline.
-- ============================================================================
SELECT sync_job,
       max(started_at) FILTER (WHERE status='success')                    AS last_success,
       max(started_at) FILTER (WHERE status='success' AND rows_updated>0) AS last_success_with_rows
  FROM bridge_sync_log
 WHERE sync_job IN ('production_tech_routing','production_work_orders',
                    'production_work_order_lines','catalog_items')
 GROUP BY sync_job ORDER BY sync_job;

-- ============================================================================
-- (F) sy15 — id kontinuitet cache-a (baseline za feed state seed):
-- ============================================================================
SELECT max(id) AS cache_max_tp_id,  max(synced_at) AS cache_last_synced
  FROM bigtehn_tech_routing_cache;
SELECT max(modified_at) AS cache_max_wo_modified FROM bigtehn_work_orders_cache;
SELECT max(modified_at) AS cache_max_line_modified FROM bigtehn_work_order_lines_cache;

-- ============================================================================
-- (G) 2.0 baza — id kontinuitet + backlog obim od 14.07 (uporedi sa (F):
--     mora biti max(tech_processes.id) >= cache_max_tp_id; broj novih redova =
--     obim backfill odluke). ⚠️ Ako postoje 2.0 redovi sa id <= cache_max_tp_id
--     nastali POSLE 14.07 (eksplicitni id insert ispod watermarka) → STOP,
--     redizajn (rizik „monotonost id-ja" iz dizajna).
-- ============================================================================
SELECT max(id) AS tp_max_id, count(*) FILTER (WHERE entered_at >= '2026-07-14') AS rows_since_cutover
  FROM tech_processes;
SELECT count(*) AS wo_changed_since_cutover FROM work_orders    WHERE updated_at >= '2026-07-14';
SELECT count(*) AS lines_changed_since_cutover FROM work_order_operations WHERE updated_at >= '2026-07-14';

-- ============================================================================
-- (H) 2.0 baza — pokrivenost MACHINE lokacija: svaki aktivan work_center_code
--     novih TP redova mora imati MACHINE red u sy15 loc_locations (uporedi ručno
--     sa (H-sy15) ispod; nepokriveni kodovi → trajni no_machine_loc skip).
-- ============================================================================
SELECT DISTINCT BTRIM(work_center_code) AS wc
  FROM tech_processes WHERE entered_at >= '2026-07-14' ORDER BY 1;
-- (H-sy15):
-- SELECT location_code FROM loc_locations
--  WHERE location_type='MACHINE' AND is_active ORDER BY 1;

-- ============================================================================
-- (I) 2.0 baza — parser preduslov: projects.status mora sadržati 'U TOKU'
--     (loc_bigtehn_parse_ident Pass 1 filter je doslovni string).
-- ============================================================================
SELECT status, count(*) FROM projects GROUP BY status ORDER BY 2 DESC;

-- ============================================================================
-- (J) TZ paritet (verify B1-DATA-8): isti id u cache vs 2.0 — started_at mora
--     biti IDENTIČAN trenutak (razlika 0, ne ±2h). Uzmi 3 id-ja iz (F) opsega:
-- ============================================================================
-- sy15: SELECT id, started_at, finished_at FROM bigtehn_tech_routing_cache
--        WHERE id IN (<id1>,<id2>,<id3>);
-- 2.0:  SELECT id, entered_at,  finished_at FROM tech_processes
--        WHERE id IN (<id1>,<id2>,<id3>);

-- ============================================================================
-- (K) Van SQL-a (runbook korak 0, OBAVEZNO pre bilo koje izmene):
--   * bridge VM 192.168.64.24 (C:\servoteh\servoteh-bridge) — proveriti da NIJEDAN
--     loc-sync-mssql proces ne radi; ako postoji → stop + disable + zapisati.
--     (Verify B1-OPS-5: pomereno iz koraka 8 u korak 0.)
--   * DRY=1 ./monitor-sy15.sh na ubuntusrv — snimiti baseline izlaz (šta je VEĆ
--     u alarmu pre prelaza, da se novi šum razlikuje od zatečenog).
--   * Negovan: potvrda da NIKO ne čita lokacijske podatke iz ServoTehERP (MSSQL)
--     — target sp_ApplyLocationEvent je bio ServoTehERP, NE QBigTehn.

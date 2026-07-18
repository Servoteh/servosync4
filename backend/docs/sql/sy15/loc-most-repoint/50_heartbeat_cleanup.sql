-- B1 loc-most repoint — KORAK 8b: uklanjanje heartbeat reda penzionisanog outbound
-- worker-a (sy15). Bez ovoga `loc_sync_health_check_hourly` zauvek diže worker_down
-- alert za mrtvog 'loc-sync-mssql' (is_alive=false), a monitor-sy15.sh heartbeat
-- proveru (max(last_seen) preko SVIH redova) drži u alarmu.
--
-- Backend strana je već pokrivena kodom (`syncHealth` izbacuje loc-sync-mssql iz
-- workerHealthy računice) — ovo čisti DB stranu i mejl alerte.
-- Izvršiti TEK posle 40_ (enqueue ugašen), da red ne bude ponovo kreiran.

\set ON_ERROR_STOP on

-- Šta se briše (snimiti izlaz pre brisanja):
SELECT * FROM loc_sync_worker_heartbeat WHERE worker_id = 'loc-sync-mssql';

DELETE FROM loc_sync_worker_heartbeat WHERE worker_id = 'loc-sync-mssql';

-- Kontrola: ostaje SAMO ingest worker.
SELECT worker_id, last_seen, now() - last_seen AS age FROM loc_sync_worker_heartbeat;

-- ROLLBACK: red se ne restaurira (worker je bio mrtav od 28.04; njegovo postojanje
-- je bilo šum, ne signal). Ako bi outbound ikad oživeo, worker sam upisuje heartbeat.

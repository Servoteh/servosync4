-- B1 loc-most repoint — KORAK 2: PAUZA ingest cron-a (sy15), PRE prvog feed-a.
--
-- ZAŠTO (verify B1-OPS-2, major): `loc_bigtehn_ingest_run` pomera
-- `last_processed_signal_id` BEZUSLOVNO — i u dry-run režimu. pg_cron
-- `loc_bigtehn_ingest_5min` radi svakih 5 min, pa bi u roku od 5 minuta od prvog
-- feed-a POJEO ceo backlog u dry-run-u: do trenutka ARM-a (korak 7) svi signali bi
-- već bili „processed" i nikada se ne bi izvršili kao pokreti. Zato se cron pauzira
-- za vreme feed/verifikacija, a vraća tek POSLE odluke o watermarku i ARM-a.
--
-- CENA PAUZE (verify B1-OPS-7): dok cron ne radi, ingest heartbeat stari →
-- `loc_sync_health_check_hourly` posle 10 min diže worker_down alert za
-- 'loc-bigtehn-ingest', a monitor-sy15.sh diže heartbeat alarm posle 15 min.
-- OČEKIVANO je i najavljeno u runbook-u — ne gasiti health check zbog toga.
-- Pauza treba da traje sate, ne dane.

-- Pauza (zapiši jobid iz preflight (B) pre izvršavanja):
UPDATE cron.job SET active = false WHERE jobname = 'loc_bigtehn_ingest_5min';

-- Kontrola:
SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobname;

-- ---------------------------------------------------------------------------
-- VRAĆANJE (korak 7, POSLE odluke o watermarku i ARM-a) — ista skripta, obrnuto:
--   UPDATE cron.job SET active = true WHERE jobname = 'loc_bigtehn_ingest_5min';
-- Posle vraćanja proveriti da heartbeat ponovo napreduje:
--   SELECT worker_id, last_seen, now()-last_seen AS age FROM loc_sync_worker_heartbeat;
-- ---------------------------------------------------------------------------

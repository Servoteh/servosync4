-- Sastanci — životni ciklus (FAZA 4, paketi S1/S2/S3) — KORAK 0: PREFLIGHT (READ-ONLY).
--
-- KONTEKST: sy15 (1.0 Supabase) je ŽIVA PRODUKCIJA. Ove izmene su odobrene kao
-- „male aditivne" (docs/PLAN_IZMENE_KORISNIKA_2026-07.md, odluka #4, Nenad 18.07.2026):
-- nova DEFINER funkcija za otkazivanje + nova housekeeping funkcija + pg_cron posao +
-- jedno jednokratno čišćenje. NIŠTA postojeće se ne menja i ne briše.
--
-- KO PRIMENJUJE: vlasnik (Nenad), ručno, u glavnoj sesiji nad sy15. Agenti/kod NE
-- izvršavaju ove skripte. Doktrina §A.6: DDL i GRANT-ovi na sy15 idu kao
-- `supabase_admin` (sy15 `postgres` NIJE superuser — grant kao postgres je tihi
-- no-op uz WARNING).
--
-- REDOSLED: 00 (ovaj, read-only) → 10 (cancel fn) → 20 (auto-close fn + cron) →
--           30 (jednokratno čišćenje; TEK POSLE prenosa otvorenih akcija kroz UI).
--
-- ⚠️ FAZA 4 ima JOŠ JEDNU sy15 skriptu, van ovog foldera (paket S5, druga sesija):
--    backend/docs/sql/sy15/sastanci-lifecycle-2026-07-18/40_sastanci_template_id.sql
--    (aditivna kolona `sastanci.template_id` + backfill). Nezavisna je od ovih —
--    može pre ili posle. Dva foldera su artefakt paralelnog rada; pri sređivanju
--    spojiti pod `backend/docs/sql/sy15/` (postojeća konvencija, vidi
--    `backend/docs/sql/sy15/loc-most-repoint/`).
--
-- Ovaj fajl NE menja ništa — samo SELECT-i. Sačuvati izlaz pre koraka 10/20/30.
-- ============================================================================

-- (A) Postoji li već nešto pod tim imenima? (očekivano: 0 redova za sastanci_cancel_sastanak
--     i sast_auto_zatvori_stale; 1 red za sast_enqueue_cancel i sast_zakljucaj_sastanak)
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef                               AS security_definer,
       pg_get_userbyid(p.proowner)               AS owner
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
WHERE  n.nspname = 'public'
  AND  p.proname IN ('sastanci_cancel_sastanak',
                     'sast_auto_zatvori_stale',
                     'sast_enqueue_cancel',
                     'sast_zakljucaj_sastanak',
                     'sast_auto_create_weekly')
ORDER  BY p.proname;

-- (B) Postojeći GRANT-ovi na sast_enqueue_cancel — MORA ostati bez `authenticated`
--     (otkazivanje se poziva ISKLJUČIVO kroz novu DEFINER fn, nikad direktno iz fronta).
SELECT p.proname,
       r.rolname,
       has_function_privilege(r.oid, p.oid, 'EXECUTE') AS moze_execute
FROM   pg_proc p
JOIN   pg_namespace n ON n.oid = p.pronamespace
CROSS  JOIN pg_roles r
WHERE  n.nspname = 'public'
  AND  p.proname IN ('sast_enqueue_cancel', 'sast_zakljucaj_sastanak')
  AND  r.rolname IN ('anon', 'authenticated', 'service_role', 'servosync2_app')
ORDER  BY p.proname, r.rolname;

-- (C) Živi pg_cron poslovi — zapisati jobid/jobname/schedule PRE koraka 20.
--     Očekivano (snimak 12.07.2026): sast_weekly_auto_create_a/b (0 6|7 * * 5),
--     sast_action_reminders_daily (0 7 * * *), sast_meeting_reminders_30min (*/30),
--     sast_notify_dispatch_every_2_min (*/2).
SELECT jobid, jobname, schedule, active, command
FROM   cron.job
WHERE  jobname LIKE 'sast%'
ORDER  BY jobname;

-- (D) Obim jednokratnog čišćenja (korak 30) — koliko redova bi bilo otkazano i koliko
--     otvorenih akcija visi na njima. AKO je broj akcija > 0, PRVO uraditi prenos
--     kroz UI (POST /v1/sastanci/:id/prenos na tekući sedmični), pa tek onda korak 30.
SELECT s.status,
       count(*)                                   AS sastanaka,
       min(s.datum)                               AS najstariji,
       max(s.datum)                               AS najnoviji
FROM   public.sastanci s
WHERE  s.status IN ('planiran', 'u_toku')
  AND  s.datum < current_date - INTERVAL '7 days'
GROUP  BY s.status
ORDER  BY s.status;

SELECT s.id, s.datum, s.naslov, s.status,
       count(a.id) FILTER (WHERE a.status IN ('otvoren', 'u_toku')) AS otvorenih_akcija
FROM   public.sastanci s
LEFT   JOIN public.akcioni_plan a ON a.sastanak_id = s.id
WHERE  s.status IN ('planiran', 'u_toku')
  AND  s.datum < current_date - INTERVAL '7 days'
GROUP  BY s.id, s.datum, s.naslov, s.status
ORDER  BY s.datum;

-- (E) Kontrolna tačka za korak 20: koliko bi redova auto-close dirao DANAS
--     (isti WHERE kao fn; pokrenuti i posle prve noći da se vidi da je pao na 0).
SELECT count(*) FILTER (WHERE status = 'planiran') AS bi_otkazano,
       count(*) FILTER (WHERE status = 'u_toku')   AS bi_zavrseno
FROM   public.sastanci
WHERE  status IN ('planiran', 'u_toku')
  AND  datum < current_date - 7;

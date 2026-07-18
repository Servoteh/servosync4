-- Sastanci S3 — KORAK 2: auto-zatvaranje zastarelih sastanaka (fn + pg_cron), sy15.
--
-- ZAŠTO: sastanci ostaju u `planiran`/`u_toku` mesecima posle svog datuma (niko ih
-- ne zatvara ručno) — liste, „Predstoji (14 d)" metrika i dashboard brojači se
-- zagađuju. Jednokratno čišćenje (korak 30) rešava zatečeno stanje; ovaj cron
-- sprečava da se ponovi.
--
-- ODOBRIO: Nenad, 18.07.2026 — docs/PLAN_IZMENE_KORISNIKA_2026-07.md, odluka #1
-- („ubuduće auto-pravilo: planiran→otkazan, u_toku→zavrsen, 7 dana posle datuma")
-- + odluka #4 (aditivne sy15 izmene) + paket S3.
--
-- PRAVILA (tvrda — ne menjati bez nove odluke):
--   1. NIKAD `zakljucan`. Zaključavanje ide ISKLJUČIVO kroz `sast_zakljucaj_sastanak`
--      (snapshot u `sastanak_arhiva` + obavezni mejlovi 'meeting_locked'). Automat
--      koji bi „zaključao" sastanak napravio bi praznu arhivu i lažan zapisnik.
--   2. BEZ mejlova. Ovo je tiho održavanje — `sast_enqueue_cancel` se NE poziva
--      (odluka #1: „zastareli → otkazan, bez mejlova"). Obaveštavanje učesnika
--      postoji samo na ručnom otkazivanju (korak 10, `sastanci_cancel_sastanak`).
--   3. Samo `planiran`/`u_toku` u WHERE — time trigger `sast_check_not_locked`
--      (puca na UPDATE reda sa OLD.status='zakljucan' van mgmt konteksta) nikad
--      ne dolazi u igru. Ne dirati taj trigger.
--
-- ŠABLON: `sast_auto_create_weekly` — SECURITY DEFINER, `SET search_path TO
-- 'public','pg_temp'`, bez oslanjanja na `auth.jwt()` (u cron kontekstu nema JWT-a,
-- pa fn ne sme da zove `has_edit_role`/`current_user_is_management`), pozvana iz
-- pg_cron-a jednom linijom.
--
-- KAKO SE PRIMENJUJE (ručno, vlasnik): kao `supabase_admin` nad ŽIVOM sy15
-- (doktrina §A.6). Fajl je idempotentan (CREATE OR REPLACE; `cron.schedule` sa
-- imenom radi upsert na pg_cron ≥ 1.4). Pre puštanja proći korak 00 (preflight),
-- posebno tačku (C) — zapisati postojeće jobid-jeve.
--
-- PREPORUČEN REDOSLED U ODNOSU NA KORAK 30: prvo pustiti fn (bez cron-a), pozvati
-- je ručno u transakciji koja se ROLLBACK-uje da se vidi broj, pa tek onda cron:
--   BEGIN; SELECT public.sast_auto_zatvori_stale(7); ROLLBACK;
--
-- ROLLBACK: na dnu fajla (unschedule + drop). Podaci se ne vraćaju automatski —
-- ako treba, statuse vratiti ručno po `updated_at` prozoru (upit na dnu).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sast_auto_zatvori_stale(p_days int DEFAULT 7)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cutoff    date := current_date - GREATEST(COALESCE(p_days, 7), 1);
  v_now       timestamptz := now();
  v_otkazano  int := 0;
  v_zavrseno  int := 0;
BEGIN
  -- planiran → otkazan (sastanak se nije ni održao)
  UPDATE public.sastanci
     SET status = 'otkazan',
         updated_at = v_now
   WHERE status = 'planiran'
     AND datum < v_cutoff;
  GET DIAGNOSTICS v_otkazano = ROW_COUNT;

  -- u_toku → zavrsen (održan, samo nikad zatvoren; NE `zakljucan` — vidi pravilo 1)
  UPDATE public.sastanci
     SET status = 'zavrsen',
         updated_at = v_now
   WHERE status = 'u_toku'
     AND datum < v_cutoff;
  GET DIAGNOSTICS v_zavrseno = ROW_COUNT;

  IF v_otkazano + v_zavrseno > 0 THEN
    RAISE NOTICE 'sast_auto_zatvori_stale(%): otkazano=%, zavrseno=% (datum < %)',
      p_days, v_otkazano, v_zavrseno, v_cutoff;
  END IF;

  RETURN v_otkazano + v_zavrseno;
END;
$function$;

-- Bez grant-a na `authenticated` — ovo je POZADINSKA fn (pg_cron/service_role),
-- kao `sast_auto_create_weekly`. Front je ne poziva.
REVOKE ALL ON FUNCTION public.sast_auto_zatvori_stale(int) FROM PUBLIC;

-- pg_cron: dnevno u 03:30 UTC (≈ 05:30 Beograd ljeti / 04:30 zimi). Posao je
-- datum-baziran, pa DST ne utiče (za razliku od `sast_weekly_auto_create_a/b`,
-- koji su zato i udvojeni na 06/07 UTC uz lokalni guard u samoj fn).
-- Termin je namerno van 07:00 UTC — tada radi `sast_action_reminders_daily`.
SELECT cron.schedule(
  'sast_auto_zatvori_stale_daily',
  '30 3 * * *',
  $$SELECT public.sast_auto_zatvori_stale(7);$$
);

-- ---------------------------------------------------------------------------
-- VERIFIKACIJA (posle primene; read-only):
--
--   -- posao je zaveden i aktivan:
--   SELECT jobid, jobname, schedule, active, command
--   FROM   cron.job WHERE jobname = 'sast_auto_zatvori_stale_daily';
--
--   -- prvo izvršavanje (sutradan) — status i poruka:
--   SELECT jobid, status, return_message, start_time, end_time
--   FROM   cron.job_run_details
--   WHERE  jobid = (SELECT jobid FROM cron.job WHERE jobname = 'sast_auto_zatvori_stale_daily')
--   ORDER  BY start_time DESC LIMIT 5;
--
--   -- posle prve noći ovo mora biti 0/0 (nema više zastarelih):
--   SELECT count(*) FILTER (WHERE status = 'planiran') AS bi_otkazano,
--          count(*) FILTER (WHERE status = 'u_toku')   AS bi_zavrseno
--   FROM   public.sastanci
--   WHERE  status IN ('planiran','u_toku') AND datum < current_date - 7;
--
--   -- kontrola pravila 1 i 2: automat NIJE ništa zaključao niti poslao mejl
--   SELECT count(*) FROM public.sastanci
--    WHERE status = 'zakljucan' AND zakljucan_by_email IS NULL;   -- očekivano: 0
--   SELECT count(*) FROM public.sastanci_notification_log
--    WHERE kind = 'meeting_cancel' AND created_at > current_date; -- samo ručna otkazivanja
--
-- ROLLBACK:
--   SELECT cron.unschedule('sast_auto_zatvori_stale_daily');
--   DROP FUNCTION IF EXISTS public.sast_auto_zatvori_stale(int);
--   -- (opciono) pregled šta je automat dirao u zadnja 24h, za ručno vraćanje:
--   -- SELECT id, naslov, datum, status, updated_at FROM public.sastanci
--   --  WHERE updated_at > now() - INTERVAL '24 hours' AND status IN ('otkazan','zavrsen')
--   --  ORDER BY updated_at DESC;
-- ---------------------------------------------------------------------------

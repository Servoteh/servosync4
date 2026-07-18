-- Sastanci S2 — KORAK 1: nova DEFINER fn `sastanci_cancel_sastanak(uuid)` (sy15).
--
-- ZAŠTO: 1.0/2.0 danas nemaju „otkaži sastanak sa obaveštenjem". Otkazivanje kroz
-- običan PATCH (`status='otkazan'`) prolazi, ali NE šalje ništa učesnicima — ljudi
-- dolaze na otkazan sastanak. Jedini put koji šalje `meeting_cancel` mejl je
-- `sast_weekly_odlozi` i to samo za SEDMIČNI. Ova fn generalizuje taj tok na bilo
-- koji sastanak, sa istim guard-om kao zaključavanje.
--
-- ODOBRIO: Nenad, 18.07.2026 — docs/PLAN_IZMENE_KORISNIKA_2026-07.md, odluka #4
-- („sy15: dozvoljene male aditivne izmene — cancel funkcija + pg_cron auto-close,
-- po šablonu postojećih sast_* funkcija") + paket S2.
--
-- ŠABLON: `sast_zakljucaj_sastanak` (SECURITY DEFINER, search_path public+pg_temp,
-- email iz `auth.jwt()`, `SELECT … FOR UPDATE`, 42501/P0002 kodovi, jsonb odgovor
-- sa `ok`/`reason`) + `sast_weekly_odlozi` (UPDATE status='otkazan' → PERFORM
-- `sast_enqueue_cancel`). Namerne razlike od lock-a:
--   * dodat `has_edit_role()` u guard (lock ga izostavlja; RLS UPDATE politika na
--     `sastanci` ga ima, a DEFINER fn zaobilazi RLS — bez njega bi otkazivanje bilo
--     ŠIRE od običnog PATCH-a). Efektivni guard = `has_edit_role() ∧ (mgmt ∨ trio)`.
--   * nema arhive/PDF-a — otkazan sastanak se ne zaključava i ne arhivira.
--
-- MEJLOVI: `sast_enqueue_cancel` puni `sastanci_notification_log` šablonom
-- 'meeting_cancel' za SVE učesnike sa `pozvan = true`; isporuku radi postojeći
-- pg_cron `sast_notify_dispatch_every_2_min` → edge `sastanci-notify-dispatch`.
-- `sast_enqueue_cancel` OSTAJE bez `authenticated` grant-a (pozadinska fn) — front
-- do njega dolazi ISKLJUČIVO kroz ovu DEFINER fn. Ne dodavati mu grantove.
--
-- POZIVA: 2.0 backend, `POST /v1/sastanci/:id/cancel` → `SastanciService.cancel()`
-- kroz `Sy15Service.runIdempotentRls` (GUC claims + `SET LOCAL ROLE authenticated`),
-- zato je grant na `authenticated`.
--
-- KAKO SE PRIMENJUJE (ručno, vlasnik): psql/SQL editor nad ŽIVOM sy15, kao
-- `supabase_admin` (doktrina §A.6 — kao `postgres` GRANT je tihi no-op uz WARNING).
-- Ceo fajl je idempotentan (CREATE OR REPLACE + REVOKE/GRANT) — sme da se pusti dvaput.
-- Pre puštanja proći korak 00 (preflight).
--
-- ROLLBACK (na dnu fajla, zakomentarisano): DROP FUNCTION. Nema promene podataka
-- ni šeme — fn je jedini artefakt, pa je rollback čist.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.sastanci_cancel_sastanak(p_sastanak_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email      TEXT := lower(COALESCE(auth.jwt() ->> 'email', ''));
  v_status     TEXT;
  v_now        TIMESTAMPTZ := now();
  v_authorized BOOLEAN;
  v_poslato    INT := 0;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'Nemate pravo da otkažete ovaj sastanak.'
      USING ERRCODE = '42501';
  END IF;

  SELECT s.status,
         (
           public.has_edit_role()
           AND (
             public.current_user_is_management()
             OR LOWER(COALESCE(s.vodio_email, '')) = v_email
             OR LOWER(COALESCE(s.zapisnicar_email, '')) = v_email
             OR LOWER(COALESCE(s.created_by_email, '')) = v_email
           )
         )
    INTO v_status, v_authorized
  FROM public.sastanci s
  WHERE s.id = p_sastanak_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sastanak nije pronađen.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Nemate pravo da otkažete ovaj sastanak.'
      USING ERRCODE = '42501';
  END IF;

  -- Zaključan sastanak se ne otkazuje (arhiva je već poslata; put nazad je
  -- reopen pa otkazivanje). Isti „meki" odgovor kao lock na already_locked —
  -- BE ga vraća kao 200 sa ok:false, ne kao grešku.
  IF v_status = 'zakljucan' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'locked',
      'sastanak_id', p_sastanak_id
    );
  END IF;

  IF v_status = 'otkazan' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'already_cancelled',
      'sastanak_id', p_sastanak_id
    );
  END IF;

  UPDATE public.sastanci
     SET status = 'otkazan',
         updated_at = v_now
   WHERE id = p_sastanak_id;

  -- Obaveštenje SVIM pozvanim učesnicima ('meeting_cancel'). Isti redosled kao
  -- sast_weekly_odlozi: prvo status, pa enqueue (mejl nosi već otkazano stanje).
  v_poslato := public.sast_enqueue_cancel(p_sastanak_id);

  RETURN jsonb_build_object(
    'ok', true,
    'sastanak_id', p_sastanak_id,
    'otkazan_at', v_now,
    'obavesteno', v_poslato
  );
END;
$function$;

-- Grant: samo `authenticated` (2.0 backend se pod withUserRls prebacuje u tu rolu,
-- 1.0 PostgREST je ionako koristi). REVOKE FROM PUBLIC je obavezan — Postgres na
-- CREATE FUNCTION daje EXECUTE PUBLIC-u, što bi značilo i `anon`.
REVOKE ALL ON FUNCTION public.sastanci_cancel_sastanak(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sastanci_cancel_sastanak(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFIKACIJA (posle primene; read-only):
--
--   -- fn postoji, DEFINER, ispravni grantovi (authenticated = t, anon = f):
--   SELECT p.proname, p.prosecdef,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
--          has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_exec
--   FROM   pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE  n.nspname = 'public' AND p.proname = 'sastanci_cancel_sastanak';
--
--   -- sast_enqueue_cancel i dalje NIJE dostupan frontu (očekivano: f):
--   SELECT has_function_privilege('authenticated', 'public.sast_enqueue_cancel(uuid)', 'EXECUTE');
--
--   -- posle prvog otkazivanja iz UI: red u outbox-u za svakog pozvanog učesnika
--   SELECT kind, status, count(*)
--   FROM   public.sastanci_notification_log
--   WHERE  related_sastanak_id = '<uuid otkazanog sastanka>'
--   GROUP  BY kind, status;
--
-- ROLLBACK (samo ako se odustane; 2.0 endpoint /cancel tada vraća grešku):
--   DROP FUNCTION IF EXISTS public.sastanci_cancel_sastanak(uuid);
-- ---------------------------------------------------------------------------

-- =============================================================================
-- sy15 (živa 1.0 baza) — „ZAPISNIK NOSI DATUM ODRŽAVANJA"
-- Zahtev 014/26 (Zoran) + presuda vlasnika (Nenad, 25.07.2026):
--   „datum o zapisniku nek bude onaj sa zaključavanja, ali da može da se promeni;
--    ukoliko datum zaključavanja sastanka nije isti kao [datum] sastanka, da se
--    ponudi taj datum održavanja i da se to namesti."
--
-- ŠTA OVAJ SKRIPT RADI
--   1) `sastanci.zapisnik_datum date NULL` — datum koji nosi ZAPISNIK (PDF, mejl,
--      naziv priloga). NULL = nije poseban → koristi se `sastanci.datum` (zakazani
--      termin), tako da svi postojeći sastanci rade nepromenjeno.
--   2) `sast_zakljucaj_sastanak` dobija 4. parametar `p_zapisnik_datum date DEFAULT NULL`
--      i upisuje ga U ISTOM `UPDATE`-u koji postavlja `status='zakljucan'`.
--      ⚠️ Datum MORA ući u taj isti UPDATE: `sast_notif_meeting_locked` je
--      `AFTER UPDATE OF status` triger koji odmah gradi payload mejla iz `NEW.*`.
--      Zaseban naknadni UPDATE bi zakasnio — mejl bi već otišao sa starim datumom.
--      Zato je izabrano proširenje postojećeg RPC-a, a NE dodatni „post-lock" RPC.
--   3) `sast_trg_meeting_locked` + `sastanci_resend_meeting_locked` stavljaju
--      `COALESCE(zapisnik_datum, datum)` u `payload.datum`. Edge dispatcher
--      (`sastanci-notify-dispatch`) iz TOG polja gradi i telo mejla (`tMeetingLocked`)
--      i naziv priloga (`Zapisnik-<datum>.pdf`) — dakle bez izmene edge funkcije
--      i mejl i prilog automatski nose datum zapisnika.
--   4) Nova `sast_set_zapisnik_datum(uuid, date)` — ISPRAVKA POSLE ZAKLJUČAVANJA.
--      Direktan UPDATE zaključanog reda obara `sast_check_not_locked` (23514) svima
--      osim rukovodstvu; fn je SECURITY DEFINER i sama traži `current_user_is_management()`
--      (isti krug kao „Pošalji ponovo" / `sastanci_resend_meeting_locked`), pa guard
--      triger prolazi legitimno — bez ikakvog dodirivanja samog guard trigera.
--
-- IDEMPOTENTNO: `ADD COLUMN IF NOT EXISTS`, `DROP FUNCTION IF EXISTS`,
-- `CREATE OR REPLACE`. Ponovno puštanje je bezopasno.
--
-- BACKUP definicija PRE izmene:
--   backend/docs/design/authz-snapshots/sastanci-zapisnik-datum-BACKUP-2026-07-25.sql
--
-- PRIMENA (redosled: prvo BEGIN…ROLLBACK proba, pa BEGIN…COMMIT):
--   ssh ubuntusrv 'docker exec -i sy15-db psql -U supabase_admin -d postgres' < ovaj_fajl
--   (postgres korisnik NIJE vlasnik ovih funkcija — mora supabase_admin)
-- =============================================================================

BEGIN;

-- ── 1) Kolona ────────────────────────────────────────────────────────────────
ALTER TABLE public.sastanci
  ADD COLUMN IF NOT EXISTS zapisnik_datum date;

COMMENT ON COLUMN public.sastanci.zapisnik_datum IS
  'Datum ODRŽAVANJA koji nosi zapisnik (PDF, mejl, naziv priloga). Podrazumevano se '
  'upisuje pri zaključavanju (dan zaključavanja), a rukovodstvo ga posle sme ispraviti '
  'kroz sast_set_zapisnik_datum. NULL = nije poseban → koristi se sastanci.datum '
  '(zakazani termin). Zahtev 014/26 + presuda vlasnika 25.07.2026.';

-- ── 2) Lock RPC: 3-arg → 4-arg (stari pozivaoci rade preko DEFAULT-ova) ──────
-- Stara (uuid,text,text) verzija se DROP-uje: da su obe prisutne, poziv sa 3
-- argumenta bi bio dvosmislen (42725 „function is not unique"). Nova verzija ima
-- DEFAULT na argumentima 2–4, pa pozivi sa 1, 2 ili 3 argumenta rade identično kao
-- pre (BE `sastanci.service.ts` i 1.0 PostgREST poziv po imenima parametara).
DROP FUNCTION IF EXISTS public.sast_zakljucaj_sastanak(uuid, text, text);

CREATE OR REPLACE FUNCTION public.sast_zakljucaj_sastanak(
  p_sastanak_id uuid,
  p_pdf_url text DEFAULT NULL::text,
  p_pdf_storage_path text DEFAULT NULL::text,
  p_zapisnik_datum date DEFAULT NULL::date
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email      TEXT := lower(COALESCE(auth.jwt() ->> 'email', ''));
  v_status     TEXT;
  v_now        TIMESTAMPTZ := now();
  v_pdf_path   TEXT := COALESCE(NULLIF(p_pdf_storage_path, ''), NULLIF(p_pdf_url, ''));
  v_authorized BOOLEAN;
  v_snapshot   JSONB;
  v_sastanak   JSONB;
  v_zap_datum  DATE;
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'Nemate pravo da zaključite ovaj sastanak.'
      USING ERRCODE = '42501';
  END IF;

  SELECT s.status,
         s.zapisnik_datum,
         (
           public.current_user_is_management()
           OR LOWER(COALESCE(s.vodio_email, '')) = v_email
           OR LOWER(COALESCE(s.zapisnicar_email, '')) = v_email
           OR LOWER(COALESCE(s.created_by_email, '')) = v_email
         )
    INTO v_status, v_zap_datum, v_authorized
  FROM public.sastanci s
  WHERE s.id = p_sastanak_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sastanak nije pronađen.'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Nemate pravo da zaključite ovaj sastanak.'
      USING ERRCODE = '42501';
  END IF;

  -- Prosleđeni datum ima prednost; bez njega ostaje ono što je red već imao
  -- (po pravilu NULL → PDF/mejl padaju na `sastanci.datum`, ponašanje kao pre).
  v_zap_datum := COALESCE(p_zapisnik_datum, v_zap_datum);

  SELECT to_jsonb(s)
    INTO v_sastanak
  FROM public.sastanci s
  WHERE s.id = p_sastanak_id;

  -- Snapshot se pravi PRE UPDATE-a (postojeće ponašanje), pa mu ručno ušivamo
  -- razrešeni datum zapisnika — inače bi štampa iz arhiva-snapshota nosila staru
  -- (pred-lock) vrednost dok PDF i mejl nose novu.
  v_sastanak := v_sastanak || jsonb_build_object('zapisnik_datum', v_zap_datum);

  SELECT jsonb_build_object(
           'schemaVersion', 2,
           'snapshotAt', v_now,
           'sastanak', v_sastanak,
           'ucesnici', COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'email', email,
                 'label', label,
                 'prisutan', prisutan,
                 'pozvan', pozvan,
                 'napomena', napomena
               )
               ORDER BY label NULLS LAST, email
             ),
             '[]'::jsonb
           ),
           'pmTeme', '[]'::jsonb,
           'akcije', '[]'::jsonb,
           'aktivnosti', '[]'::jsonb,
           'slike', '[]'::jsonb
         )
    INTO v_snapshot
  FROM public.sastanak_ucesnici
  WHERE sastanak_id = p_sastanak_id;

  IF v_status = 'zakljucan' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'already_locked',
      'sastanak_id', p_sastanak_id
    );
  END IF;

  INSERT INTO public.sastanak_arhiva (
    sastanak_id,
    snapshot,
    zapisnik_storage_path,
    zapisnik_generated_at,
    arhivirao_email,
    arhivirao_label,
    arhivirano_at
  ) VALUES (
    p_sastanak_id,
    v_snapshot,
    v_pdf_path,
    CASE WHEN v_pdf_path IS NOT NULL THEN v_now ELSE NULL END,
    v_email,
    v_email,
    v_now
  )
  ON CONFLICT (sastanak_id) DO UPDATE
    SET snapshot = EXCLUDED.snapshot,
        zapisnik_storage_path = COALESCE(EXCLUDED.zapisnik_storage_path, public.sastanak_arhiva.zapisnik_storage_path),
        zapisnik_generated_at = COALESCE(EXCLUDED.zapisnik_generated_at, public.sastanak_arhiva.zapisnik_generated_at),
        arhivirao_email = EXCLUDED.arhivirao_email,
        arhivirao_label = EXCLUDED.arhivirao_label,
        arhivirano_at = EXCLUDED.arhivirano_at;

  -- `zapisnik_datum` ulazi u ISTI UPDATE kao status: AFTER UPDATE OF status triger
  -- `sast_notif_meeting_locked` odmah čita NEW.* za payload mejla (§ zaglavlje t.2).
  UPDATE public.sastanci
     SET status = 'zakljucan',
         zakljucan_at = v_now,
         zakljucan_by_email = v_email,
         zapisnik_datum = v_zap_datum,
         updated_at = v_now
   WHERE id = p_sastanak_id;

  RETURN jsonb_build_object(
    'ok', true,
    'sastanak_id', p_sastanak_id,
    'zakljucan_at', v_now,
    'zapisnik_datum', v_zap_datum
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sast_zakljucaj_sastanak(uuid, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sast_zakljucaj_sastanak(uuid, text, text, date)
  TO postgres, anon, authenticated, service_role;

-- ── 3) Mejl „meeting_locked" nosi datum zapisnika (payload.datum) ────────────
-- Edge `sastanci-notify-dispatch` iz `payload.datum` gradi i meta red u telu mejla
-- i naziv priloga `Zapisnik-<datum>.pdf` — jedna izmena pokriva oboje.
CREATE OR REPLACE FUNCTION public.sast_trg_meeting_locked()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec RECORD;
BEGIN
  IF NOT (OLD.status <> 'zakljucan' AND NEW.status = 'zakljucan') THEN
    RETURN NEW;
  END IF;

  -- Očisti prethodne locked-notifikacije za ovaj sastanak da (re)lock pošalje iznova.
  DELETE FROM public.sastanci_notification_log
   WHERE kind = 'meeting_locked'
     AND related_sastanak_id = NEW.id
     AND related_akcija_id IS NULL;

  FOR v_rec IN
    SELECT email, label FROM public.sastanak_ucesnici WHERE sastanak_id = NEW.id
  LOOP
    PERFORM public.sastanci_enqueue_notification(
      'meeting_locked', 'email', v_rec.email, v_rec.label,
      format('Zapisnik: %s', NEW.naslov), NULL, NULL, NEW.id, NULL,
      jsonb_build_object(
        'sastanak_id', NEW.id, 'naslov', NEW.naslov,
        'datum', COALESCE(NEW.zapisnik_datum, NEW.datum)::TEXT,
        'vreme', CASE WHEN NEW.vreme IS NOT NULL THEN left(NEW.vreme::TEXT, 5) ELSE NULL END,
        'tip', NEW.tip, 'zakljucan_at', NEW.zakljucan_at, 'zakljucan_by', NEW.zakljucan_by_email,
        'organizator', COALESCE(NEW.vodio_email, NEW.created_by_email)
      ),
      NEW.zakljucan_by_email
    );
  END LOOP;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sastanci_resend_meeting_locked(p_sastanak_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_s   RECORD;
  v_rec RECORD;
  v_cnt INT := 0;
BEGIN
  IF NOT public.current_user_is_management() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_s FROM public.sastanci WHERE id = p_sastanak_id;
  IF NOT FOUND OR v_s.status <> 'zakljucan' THEN
    RETURN 0;
  END IF;

  DELETE FROM public.sastanci_notification_log
   WHERE kind = 'meeting_locked'
     AND related_sastanak_id = p_sastanak_id
     AND related_akcija_id IS NULL;

  FOR v_rec IN
    SELECT email, label FROM public.sastanak_ucesnici WHERE sastanak_id = p_sastanak_id
  LOOP
    PERFORM public.sastanci_enqueue_notification(
      'meeting_locked', 'email', v_rec.email, v_rec.label,
      format('Zapisnik: %s', v_s.naslov), NULL, NULL, p_sastanak_id, NULL,
      jsonb_build_object(
        'sastanak_id', p_sastanak_id, 'naslov', v_s.naslov,
        'datum', COALESCE(v_s.zapisnik_datum, v_s.datum)::TEXT,
        'vreme', CASE WHEN v_s.vreme IS NOT NULL THEN left(v_s.vreme::TEXT, 5) ELSE NULL END,
        'tip', v_s.tip, 'zakljucan_at', v_s.zakljucan_at, 'zakljucan_by', v_s.zakljucan_by_email,
        'organizator', COALESCE(v_s.vodio_email, v_s.created_by_email)
      ),
      v_s.zakljucan_by_email
    );
    v_cnt := v_cnt + 1;
  END LOOP;

  RETURN v_cnt;
END;
$function$;

-- ── 4) Ispravka datuma POSLE zaključavanja (rukovodstvo) ─────────────────────
-- Zoranova primedba 014/26: zaključan zapisnik sa pogrešnim datumom mora da se
-- ispravi bez „Otvori ponovo". `sast_check_not_locked` (BEFORE UPDATE) pušta
-- rukovodstvo, a fn tu istu proveru radi eksplicitno pre UPDATE-a — greška je
-- 42501 (→ 403), a ne 23514 (→ 422) sa nejasnom porukom.
-- NAPOMENA: NE dira `status`, pa `sast_notif_meeting_locked` (AFTER UPDATE OF status)
-- ne okida — ispravka datuma NE šalje mejlove. Ponovno slanje ostaje svestan klik
-- („Pošalji ponovo" → sastanci_resend_meeting_locked, koji čita novi datum).
CREATE OR REPLACE FUNCTION public.sast_set_zapisnik_datum(
  p_sastanak_id uuid,
  p_zapisnik_datum date
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email TEXT := lower(COALESCE(auth.jwt() ->> 'email', ''));
  v_exists BOOLEAN;
BEGIN
  IF v_email = '' OR NOT public.current_user_is_management() THEN
    RAISE EXCEPTION 'Nemate pravo da menjate datum zapisnika.'
      USING ERRCODE = '42501';
  END IF;

  SELECT TRUE INTO v_exists FROM public.sastanci WHERE id = p_sastanak_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sastanak nije pronađen.'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.sastanci
     SET zapisnik_datum = p_zapisnik_datum
   WHERE id = p_sastanak_id;

  RETURN jsonb_build_object(
    'ok', true,
    'sastanak_id', p_sastanak_id,
    'zapisnik_datum', p_zapisnik_datum
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.sast_set_zapisnik_datum(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sast_set_zapisnik_datum(uuid, date)
  TO postgres, anon, authenticated, service_role;

COMMIT;

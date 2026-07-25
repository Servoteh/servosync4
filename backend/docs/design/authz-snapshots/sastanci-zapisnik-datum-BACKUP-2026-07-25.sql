-- =============================================================================
-- BACKUP (pre-change) — sy15 `public` funkcije koje dira paket
-- „zapisnik nosi datum održavanja" (zahtev 014/26, presuda vlasnika 25.07.2026).
--
-- Snimljeno: 2026-07-25, `pg_get_functiondef` sa žive sy15 baze
--            (ssh ubuntusrv → docker exec sy15-db psql -U supabase_admin -d postgres).
--
-- ⚠️ OVAJ FAJL JE IZVRŠAN ROLLBACK — pusti ga CEO, ne parče po parče:
--     ssh ubuntusrv 'docker exec -i sy15-db psql -U supabase_admin -d postgres' < ovaj_fajl
--   Sve je u jednoj transakciji (BEGIN…COMMIT), pa ili prođe celo ili ništa.
--
--   Prvi `DROP` (4-arg) je OBAVEZAN i mora PRE `CREATE`-a 3-arg verzije: bez njega
--   bi u bazi ostala DVA overload-a (`uuid,text,text` i `uuid,text,text,date`), pa bi
--   SVAKI poziv sa 3 argumenta pao na 42725 „function ... is not unique" — a tako
--   zovu i 3.0 backend i 1.0 (`sastanciArhiva.js`), tj. zaključavanje bi stalo u
--   OBE aplikacije. (Nalaz adversarijalnog review-a 25.07.2026, tačka A1.)
--
-- REDOSLED POVLAČENJA PAKETA — PRVO KOD, PA BAZA:
--   1) Vrati/deploy-uj kod koji NE šalje 4. argument i ne zove `sast_set_zapisnik_datum`
--      (3.0 backend + 3.0 frontend; u 1.0 nema izmene koja bi to zvala).
--   2) Tek onda pusti ovaj fajl.
--   Obrnut redosled ostavlja živ kod koji zove fn koja više ne postoji (42883).
--
-- KOLONA SME DA OSTANE: `sastanci.zapisnik_datum` je NULL na svim redovima koje ovaj
--   rollback dotiče, a NULL = „koristi `datum`", tj. ponašanje pre paketa. Brisanje
--   samo ako se paket povlači u celosti i trajno:
--     ALTER TABLE public.sastanci DROP COLUMN IF EXISTS zapisnik_datum;
--   (Ako se kolona obriše, gornji `sast_trg_meeting_locked`/`sastanci_resend_meeting_locked`
--    ispod su već stare verzije koje je NE pominju — redosled je i tu: prvo ovaj fajl,
--    pa DROP COLUMN.)
--
-- ACL zatečen na `sast_zakljucaj_sastanak(uuid,text,text)`:
--   supabase_admin=X/supabase_admin, postgres=X/supabase_admin,
--   anon=X/supabase_admin, authenticated=X/supabase_admin, service_role=X/supabase_admin
--   (PUBLIC nema EXECUTE — REVOKE je već bio odrađen; vlasnik = supabase_admin)
-- ACL zatečen na `sastanci_resend_meeting_locked(uuid)`:
--   =X/supabase_admin (PUBLIC), supabase_admin, postgres, anon, authenticated, service_role
-- =============================================================================

BEGIN;

-- ── 0) UKLONI 4-arg verziju PRE nego što vratiš 3-arg ────────────────────────
-- Bez ovoga dobijaš dva overload-a i 42725 na svaki poziv sa 3 argumenta (v. zaglavlje).
DROP FUNCTION IF EXISTS public.sast_zakljucaj_sastanak(uuid, text, text, date);

-- ── 1) sast_zakljucaj_sastanak(uuid, text, text) — 3-arg verzija PRE izmene ──
CREATE OR REPLACE FUNCTION public.sast_zakljucaj_sastanak(p_sastanak_id uuid, p_pdf_url text DEFAULT NULL::text, p_pdf_storage_path text DEFAULT NULL::text)
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
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'Nemate pravo da zaključite ovaj sastanak.'
      USING ERRCODE = '42501';
  END IF;

  SELECT s.status,
         (
           public.current_user_is_management()
           OR LOWER(COALESCE(s.vodio_email, '')) = v_email
           OR LOWER(COALESCE(s.zapisnicar_email, '')) = v_email
           OR LOWER(COALESCE(s.created_by_email, '')) = v_email
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
    RAISE EXCEPTION 'Nemate pravo da zaključite ovaj sastanak.'
      USING ERRCODE = '42501';
  END IF;

  SELECT to_jsonb(s)
    INTO v_sastanak
  FROM public.sastanci s
  WHERE s.id = p_sastanak_id;

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

  UPDATE public.sastanci
     SET status = 'zakljucan',
         zakljucan_at = v_now,
         zakljucan_by_email = v_email,
         updated_at = v_now
   WHERE id = p_sastanak_id;

  RETURN jsonb_build_object(
    'ok', true,
    'sastanak_id', p_sastanak_id,
    'zakljucan_at', v_now
  );
END;
$function$
;

-- ── 2) sast_trg_meeting_locked() — PRE izmene ────────────────────────────────
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
        'sastanak_id', NEW.id, 'naslov', NEW.naslov, 'datum', NEW.datum::TEXT,
        'vreme', CASE WHEN NEW.vreme IS NOT NULL THEN left(NEW.vreme::TEXT, 5) ELSE NULL END,
        'tip', NEW.tip, 'zakljucan_at', NEW.zakljucan_at, 'zakljucan_by', NEW.zakljucan_by_email,
        'organizator', COALESCE(NEW.vodio_email, NEW.created_by_email)
      ),
      NEW.zakljucan_by_email
    );
  END LOOP;

  RETURN NEW;
END;
$function$
;

-- ── 3) sastanci_resend_meeting_locked(uuid) — PRE izmene ─────────────────────
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
        'sastanak_id', p_sastanak_id, 'naslov', v_s.naslov, 'datum', v_s.datum::TEXT,
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
$function$
;

-- ── 4) ACL koji treba vratiti uz rollback 3-arg lock RPC-a ───────────────────
REVOKE ALL ON FUNCTION public.sast_zakljucaj_sastanak(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sast_zakljucaj_sastanak(uuid, text, text)
  TO postgres, anon, authenticated, service_role;

COMMENT ON FUNCTION public.sast_zakljucaj_sastanak(uuid, text, text) IS
  'Atomski zakljucava sastanak: proverava scope, kreira/upisuje arhiva snapshot i menja status u zakljucan.';

-- ── 5) Ukloni fn koje paket uvodi (nema je u stanju pre paketa) ──────────────
DROP FUNCTION IF EXISTS public.sast_set_zapisnik_datum(uuid, date);

-- ── 6) PostgREST mora da vidi promenjene signature (1.0 zove preko rpc/) ─────
NOTIFY pgrst, 'reload schema';

COMMIT;

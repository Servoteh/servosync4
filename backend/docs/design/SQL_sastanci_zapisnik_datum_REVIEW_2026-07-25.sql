-- =============================================================================
-- sy15 (živa 1.0 baza) — REVIEW ISPRAVKE paketa „zapisnik nosi datum održavanja"
-- Nadogradnja na SQL_sastanci_zapisnik_datum_2026-07-25.sql (taj pustiti PRVI).
-- Zahtev 014/26; adversarijalni review 25.07.2026, tačke C4 / D7 / D8 / D9 / F20.
--
-- ŠTA SE MENJA
--  1) (C4) SIDRO REZIMEA „Od prošlog sastanka" DOBIJA SVOJ KLJUČ.
--     `payload.datum` sada nosi datum ZAPISNIKA, a edge dispatcher njime traži
--     PRETHODNI zaključan sastanak (`datum=lt.<datum>`) — sa ispravljenim datumom
--     sidro bi klizalo i rezime u zvaničnom mejlu bi bio pogrešan. Zato oba payload-a
--     dobijaju `datum_termina` = `sastanci.datum` (zakazani termin), a dispatcher
--     čita `payload.datum_termina ?? payload.datum` (kompatibilno sa već ukvačenim
--     redovima koji nose samo `datum`).
--  2) (D7) REOPEN BRIŠE `zapisnik_datum` NA NIVOU BAZE. 1.0 „Otvori ponovo"
--     (`otvojiPonovo`) ide direktnim PATCH-om na `sastanci`, mimo 3.0 servisa, pa
--     bi ponovno zaključavanje vaskrslo stari datum bez ikakvog traga u UI-ju.
--     Grana u `sast_check_not_locked` (BEFORE UPDATE) pokriva OBA puta.
--  3) (D8) `sast_set_zapisnik_datum` OSVEŽAVA I `sastanak_arhiva.snapshot`.
--     Print sloj (1.0 `buildZapisnikHtml`, 3.0 `sastanci-print`) snapshot smatra
--     merodavnim, pa bi štampa iz arhive ostala sa starim datumom.
--     `jsonb_set` je STRICT → NULL guard i na vrednosti i na samom snapshot-u.
--  4) (D9) STATUS GUARD u `sast_set_zapisnik_datum`: ispravka ima smisla samo na
--     ZAKLJUČANOM sastanku (na nezaključanom bi je lock RPC prosto pregazio).
--     Greška je `P0001` — BE `rethrowSy15` je mapira na 422; `22023` NIJE mapiran
--     i propao bi kao sirov 500.
--  5) (F20) VRAĆEN `COMMENT` na `sast_zakljucaj_sastanak` (izgubljen u DROP+CREATE)
--     + komentar na novu fn.
--
-- IDEMPOTENTNO (sve `CREATE OR REPLACE`). Backup PRE-review definicija je u
-- backend/docs/design/authz-snapshots/sastanci-zapisnik-datum-BACKUP-2026-07-25.sql
-- (taj fajl vraća stanje pre CELOG paketa).
--
-- PRIMENA:
--   ssh ubuntusrv 'docker exec -i sy15-db psql -U supabase_admin -d postgres' < ovaj_fajl
--   (mora supabase_admin — postgres nije vlasnik ovih funkcija)
-- ⚠️ Uz ovo IDE I izmena edge funkcije `sastanci-notify-dispatch` (čitanje
--    `datum_termina`); bez nje sidro ostaje na `payload.datum`.
-- =============================================================================

BEGIN;

-- ── 1) (C4) `datum_termina` u payload-u meeting_locked (triger) ──────────────
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
        -- `datum` = ono što korisnik vidi (telo mejla + naziv priloga).
        'datum', COALESCE(NEW.zapisnik_datum, NEW.datum)::TEXT,
        -- `datum_termina` = ZAKAZANI termin; SAMO sidro za „Od prošlog sastanka"
        -- (dispatcher njime traži prethodni zaključan sastanak). Ne prikazuje se.
        'datum_termina', NEW.datum::TEXT,
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
        'datum_termina', v_s.datum::TEXT,
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

-- ── 2) (D7) Reopen briše `zapisnik_datum` (pokriva i 1.0 direktan PATCH) ─────
CREATE OR REPLACE FUNCTION public.sast_check_not_locked()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status TEXT;
  v_sid    UUID;
BEGIN
  -- Parent tabela: zakljucan sastanak ne sme da se menja/brise osim management.
  IF TG_TABLE_NAME = 'sastanci' THEN
    IF TG_OP = 'UPDATE' AND OLD.status = 'zakljucan' THEN
      IF NOT public.current_user_is_management() THEN
        RAISE EXCEPTION 'Zaključan sastanak ne može biti menjano (id: %)', OLD.id
          USING ERRCODE = '23514',
                HINT = 'Obratite se administratoru za reopening.';
      END IF;

      -- REOPEN (zakljucan → bilo šta drugo) poništava datum zapisnika: sledeće
      -- zaključavanje mora da ga izabere iznova, inače bi stari (možda pogrešan)
      -- datum tiho vaskrsao. Ovde je namerno na DB nivou — 1.0 `otvojiPonovo` ide
      -- direktnim PATCH-om na `sastanci`, mimo 3.0 servisa. (Review D7, 014/26)
      IF NEW.status <> 'zakljucan' THEN
        NEW.zapisnik_datum := NULL;
      END IF;
    END IF;

    IF TG_OP = 'DELETE' AND OLD.status = 'zakljucan' THEN
      IF NOT public.current_user_is_management() THEN
        RAISE EXCEPTION 'Zaključan sastanak ne može biti obrisan (id: %)', OLD.id
          USING ERRCODE = '23514';
      END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  -- Child tabele: proveri parent status.
  v_sid := CASE TG_OP
    WHEN 'DELETE' THEN OLD.sastanak_id
    ELSE NEW.sastanak_id
  END;

  IF v_sid IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  SELECT status INTO v_status
  FROM public.sastanci
  WHERE id = v_sid;

  IF v_status = 'zakljucan' AND NOT public.current_user_is_management() THEN
    RAISE EXCEPTION 'Nije moguće menjati podatke zaključanog sastanka (id: %)', v_sid
      USING ERRCODE = '23514',
            HINT = 'Sastanak je zaključan.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 3) (D8+D9) Ispravka datuma: status guard + osvežen arhiva snapshot ───────
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
  v_email  TEXT := lower(COALESCE(auth.jwt() ->> 'email', ''));
  v_status TEXT;
BEGIN
  IF v_email = '' OR NOT public.current_user_is_management() THEN
    RAISE EXCEPTION 'Nemate pravo da menjate datum zapisnika.'
      USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_status
  FROM public.sastanci WHERE id = p_sastanak_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sastanak nije pronađen.'
      USING ERRCODE = 'P0002';
  END IF;

  -- (D9) Zapisnik postoji tek posle zaključavanja; na nezaključanom bi ovaj upis
  -- lock RPC prosto pregazio izabranim datumom, pa bi ispravka tiho nestala.
  -- ERRCODE P0001 je namerno (BE rethrowSy15 → 422); 22023 nije mapiran → 500.
  IF v_status <> 'zakljucan' THEN
    RAISE EXCEPTION 'Datum zapisnika se ispravlja samo na zaključanom sastanku (trenutni status: %).', v_status
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.sastanci
     SET zapisnik_datum = p_zapisnik_datum
   WHERE id = p_sastanak_id;

  -- (D8) Arhiva snapshot je merodavan za štampu zapisnika (1.0 buildZapisnikHtml,
  -- 3.0 sastanci-print), pa mora da prati kolonu — inače štampa iz arhive ostaje
  -- na starom datumu. `jsonb_set` je STRICT: NULL vrednost ili NULL snapshot bi
  -- vratili NULL i OBRISALI snapshot, otud COALESCE + `?` provera grane.
  UPDATE public.sastanak_arhiva
     SET snapshot = jsonb_set(
           snapshot,
           '{sastanak,zapisnik_datum}',
           COALESCE(to_jsonb(p_zapisnik_datum::text), 'null'::jsonb),
           true
         )
   WHERE sastanak_id = p_sastanak_id
     AND snapshot IS NOT NULL
     AND snapshot ? 'sastanak'
     AND jsonb_typeof(snapshot -> 'sastanak') = 'object';

  RETURN jsonb_build_object(
    'ok', true,
    'sastanak_id', p_sastanak_id,
    'zapisnik_datum', p_zapisnik_datum
  );
END;
$function$;

-- ── 4) (F20) Komentari (DROP+CREATE je pojeo stari COMMENT) ──────────────────
COMMENT ON FUNCTION public.sast_zakljucaj_sastanak(uuid, text, text, date) IS
  'Atomski zakljucava sastanak: proverava scope, kreira/upisuje arhiva snapshot i menja status u zakljucan. '
  '4. argument p_zapisnik_datum (zahtev 014/26) je datum ODRZAVANJA koji nosi zapisnik — PDF, telo mejla i '
  'naziv priloga; upisuje se u ISTOM UPDATE-u kao status jer triger sast_notif_meeting_locked (AFTER UPDATE '
  'OF status) payload mejla gradi iz NEW.*. NULL = ostavi zatecenu vrednost (po pravilu NULL → koristi se datum).';

COMMENT ON FUNCTION public.sast_set_zapisnik_datum(uuid, date) IS
  'Ispravlja datum zapisnika na ZAKLJUCANOM sastanku (zahtev 014/26). Trazi current_user_is_management() '
  '(isti krug kao sastanci_resend_meeting_locked) — guard triger sast_check_not_locked samo rukovodstvu pusta '
  'izmenu zakljucanog reda. Osvezava i sastanak_arhiva.snapshot. NE dira status, pa NE salje mejlove.';

COMMIT;

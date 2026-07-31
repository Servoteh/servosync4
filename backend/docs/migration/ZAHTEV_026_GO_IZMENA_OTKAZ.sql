-- ============================================================================
-- ZAHTEV 026/26 — zahtev za IZMENU / OTKAZIVANJE već POTVRĐENOG GO termina
-- Datum: 2026-07-31 · grana: feat/zahtev-026-go-izmena-otkaz
--
-- ⚠️ OVAJ FAJL SE NE IZVRŠAVA AUTOMATSKI I NIJE PRIMENJEN NA ŽIVU BAZU.
--    Primenu na sy15 (glavna baza, self-hosted Supabase na ubuntusrv) radi glavna
--    sesija RUČNO, posle review-a. Nema Prisma migracije — sy15 objekti nisu u 3.0
--    migracionom lancu. Dok se ovo ne primeni, nove rute vraćaju grešku
--    (relation/function does not exist) — postojeći GO tok je NETAKNUT.
--
-- ── Zašto ────────────────────────────────────────────────────────────────────
-- Danas zaposleni nad SVOJIM zahtevom može direktno da zove `hr_revise_vacation_request`
-- i `hr_cancel_vacation_request` — obe puštaju podnosioca (`v_is_sub`) i onda kada je
-- zahtev već `approved`. To znači da radnik JEDNOSTRANO briše odobren termin iz grida
-- (kadr_grid_unset_go) i menja evidenciju, bez ijedne HR odluke. Zahtev 026/26 traži
-- suprotno: nad POTVRĐENIM terminom radnik podnosi ZAHTEV, a odluku donosi isti krug
-- koji odobrava GO (`current_user_can_manage_vacreq` + opseg / `vacreq_admin`).
--
-- ── Šta se uvodi ─────────────────────────────────────────────────────────────
--   1. tabela `vacation_change_requests` (jedan otvoren zahtev po GO terminu)
--   2. `kadr_vacreq_change_submit(...)`   — podnošenje (radnik ∨ upravljač)
--   3. `kadr_vacreq_change_decide(...)`   — odluka (odobri/odbij) + izvršenje
--   4. `kadr_queue_vacreq_change_notification(...)` — mejl istim kanalom
--      (`kadr_notification_log`, obrazac `kadr_queue_vacation_*`)
--
-- Izvršenje odobrenog zahteva NE duplira poslovnu logiku — poziva postojeće RPC-ove:
--   • kind='cancel' → `hr_cancel_vacation_request(parent, actor)`
--        (ta fn za `approved` radi `kadr_grid_unset_go` + briše `absences` red →
--         dani se VRAĆAJU u fond; saldo je grid-kanon, ništa se ne preračunava)
--   • kind='revise' → `hr_revise_vacation_request(parent, new_from, new_to, days,
--                      note, actor, p_force_reapproval := false)`
--        (ta fn za odobren zahtev radi unset starog + set novog grid opsega u JEDNOJ
--         transakciji → „otkaz starog + potvrda novog" atomično, bez prolaska kroz
--         `pending`; `force_reapproval := false` jer je odluka upravo doneta)
--
-- PRE PRIMENE proveriti da žive definicije odgovaraju snapshotu:
--   SELECT pg_get_functiondef('public.hr_cancel_vacation_request(uuid,text)'::regprocedure);
--   SELECT pg_get_functiondef('public.hr_revise_vacation_request(uuid,date,date,int,text,text,boolean)'::regprocedure);
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1) Tabela
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.vacation_change_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vacation_request_id uuid NOT NULL REFERENCES public.vacation_requests(id) ON DELETE CASCADE,
  employee_id         uuid NOT NULL REFERENCES public.employees(id),
  -- 'cancel' = otkazivanje termina · 'revise' = predlog novog termina
  kind                text NOT NULL CHECK (kind IN ('cancel', 'revise')),
  -- popunjeno samo za kind='revise'
  new_date_from       date,
  new_date_to         date,
  new_days_count      int,
  -- termin kakav je bio u trenutku podnošenja (za trag i prikaz u listi)
  old_date_from       date NOT NULL,
  old_date_to         date NOT NULL,
  reason              text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_by        text NOT NULL,
  decided_by          text,
  decided_at          timestamptz,
  decision_note       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vcr_revise_has_dates CHECK (
    kind <> 'revise'
    OR (new_date_from IS NOT NULL AND new_date_to IS NOT NULL
        AND new_date_to >= new_date_from AND coalesce(new_days_count, 0) > 0)
  )
);

-- Najviše JEDAN otvoren (pending) zahtev po GO terminu — brana od duplog klika
-- i od dva međusobno protivrečna predloga nad istim odmorom.
CREATE UNIQUE INDEX IF NOT EXISTS vcr_one_open_per_request
  ON public.vacation_change_requests (vacation_request_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS vcr_employee_idx
  ON public.vacation_change_requests (employee_id, created_at DESC);

COMMENT ON TABLE public.vacation_change_requests IS
  'Zahtev 026/26 — molba zaposlenog za izmenu/otkaz VEĆ ODOBRENOG GO termina; odlučuje isti krug koji odobrava GO.';

-- ============================================================================
-- 2) RLS — isti obrazac kao vacation_requests (self ∨ manages ∨ vacreq_admin)
-- ============================================================================
ALTER TABLE public.vacation_change_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vcr_select ON public.vacation_change_requests;
CREATE POLICY vcr_select ON public.vacation_change_requests
  FOR SELECT TO authenticated
  USING (
    employee_id = public.current_user_employee_id()
    OR lower(coalesce(submitted_by, '')) = lower(coalesce(auth.jwt() ->> 'email', '@'))
    OR public.current_user_is_vacreq_admin()
    OR (public.current_user_can_manage_vacreq()
        AND public.current_user_manages_employee(employee_id))
  );

-- Upis ide ISKLJUČIVO kroz SECURITY DEFINER RPC-ove ispod (nema INSERT/UPDATE
-- politike) — tako nijedan klijent ne može da „odobri" sam sebi zahtev.
REVOKE ALL ON public.vacation_change_requests FROM authenticated;
GRANT SELECT ON public.vacation_change_requests TO authenticated;

-- ============================================================================
-- 3) kadr_vacreq_change_submit — podnošenje
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kadr_vacreq_change_submit(
  p_request_id  uuid,
  p_kind        text,
  p_date_from   date    DEFAULT NULL,
  p_date_to     date    DEFAULT NULL,
  p_days_count  int     DEFAULT NULL,
  p_reason      text    DEFAULT NULL,
  p_actor_email text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req    vacation_requests%ROWTYPE;
  v_caller text;
  v_emp    uuid;
  v_is_sub boolean;
  v_is_own boolean;
  v_is_mgr boolean;
  v_new_id uuid;
BEGIN
  v_caller := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));
  IF v_caller = '' THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Nepoznat korisnik.';
  END IF;

  IF p_kind NOT IN ('cancel', 'revise') THEN
    RAISE EXCEPTION 'invalid_kind' USING ERRCODE = '22023', HINT = 'kind mora biti cancel ili revise.';
  END IF;

  SELECT * INTO v_req FROM vacation_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'request_id', p_request_id);
  END IF;

  -- Ovaj tok POSTOJI SAMO za potvrđen termin. Dok je zahtev pending/sef_approved
  -- radnik ga i dalje menja/otkazuje direktno (hr_revise/hr_cancel) — nema šta da
  -- se „vraća u fond" niti odluka koju treba poništiti.
  IF v_req.status <> 'approved' THEN
    RETURN jsonb_build_object('status', 'not_approved', 'current_status', v_req.status);
  END IF;

  v_emp    := v_req.employee_id;
  v_is_sub := lower(coalesce(v_req.submitted_by, '')) = v_caller;
  v_is_own := (v_emp = public.current_user_employee_id());
  v_is_mgr := public.current_user_can_manage_vacreq()
              AND (public.current_user_manages_employee(v_emp)
                   OR public.current_user_is_vacreq_admin());

  -- IDOR: molbu podnosi SAM zaposleni (vlasnik termina), podnosilac originalnog
  -- zahteva („za koga" picker) ili upravljač tog zaposlenog. Niko drugi.
  IF NOT (v_is_own OR v_is_sub OR v_is_mgr) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501',
      HINT = 'Zahtev za izmenu/otkaz može podneti zaposleni ili njegov rukovodilac.';
  END IF;

  IF EXISTS (SELECT 1 FROM vacation_change_requests
              WHERE vacation_request_id = p_request_id AND status = 'pending') THEN
    RETURN jsonb_build_object('status', 'already_pending', 'request_id', p_request_id);
  END IF;

  IF p_kind = 'revise' THEN
    IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_to < p_date_from THEN
      RAISE EXCEPTION 'invalid_dates' USING ERRCODE = '22007', HINT = 'Neispravan opseg datuma.';
    END IF;
    -- Preklapanje sa DRUGIM aktivnim zahtevom istog zaposlenog (svoj termin se ne broji).
    IF EXISTS (
      SELECT 1 FROM vacation_requests
       WHERE employee_id = v_emp
         AND id <> p_request_id
         AND status IN ('pending', 'sef_approved', 'approved')
         AND date_from <= p_date_to AND date_to >= p_date_from
    ) THEN
      RETURN jsonb_build_object('status', 'overlap');
    END IF;
  END IF;

  INSERT INTO vacation_change_requests (
    vacation_request_id, employee_id, kind,
    new_date_from, new_date_to, new_days_count,
    old_date_from, old_date_to, reason, status, submitted_by
  ) VALUES (
    p_request_id, v_emp, p_kind,
    CASE WHEN p_kind = 'revise' THEN p_date_from END,
    CASE WHEN p_kind = 'revise' THEN p_date_to END,
    CASE WHEN p_kind = 'revise' THEN coalesce(p_days_count, 0) END,
    v_req.date_from, v_req.date_to, coalesce(p_reason, ''), 'pending', v_caller
  )
  RETURNING id INTO v_new_id;

  PERFORM public.kadr_queue_vacreq_change_notification(v_new_id, 'submitted');

  RETURN jsonb_build_object('status', 'pending', 'change_request_id', v_new_id, 'kind', p_kind);
END;
$function$;

REVOKE ALL ON FUNCTION public.kadr_vacreq_change_submit(uuid, text, date, date, int, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.kadr_vacreq_change_submit(uuid, text, date, date, int, text, text) TO authenticated;

-- ============================================================================
-- 4) kadr_vacreq_change_decide — odluka HR-a / rukovodioca
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kadr_vacreq_change_decide(
  p_change_id   uuid,
  p_approve     boolean,
  p_note        text DEFAULT NULL,
  p_actor_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_chg    vacation_change_requests%ROWTYPE;
  v_caller text;
  v_inner  jsonb;
BEGIN
  v_caller := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));

  SELECT * INTO v_chg FROM vacation_change_requests WHERE id = p_change_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'change_request_id', p_change_id);
  END IF;
  IF v_chg.status <> 'pending' THEN
    RETURN jsonb_build_object('status', 'already_processed', 'current_status', v_chg.status);
  END IF;

  -- Odlučuje ISTI krug koji odobrava GO. Podnosilac molbe NE može sam sebi da je
  -- odobri čak i ako je rukovodilac (isti duh kao `dual_control` u hr_vacreq_approve).
  IF NOT (public.current_user_can_manage_vacreq()
          AND (public.current_user_manages_employee(v_chg.employee_id)
               OR public.current_user_is_vacreq_admin())) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501',
      HINT = 'Odluku donosi rukovodilac/HR sa pravom upravljanja GO zahtevima.';
  END IF;
  IF p_approve AND lower(coalesce(v_chg.submitted_by, '')) = v_caller
     AND NOT public.current_user_is_vacreq_admin() THEN
    RETURN jsonb_build_object('status', 'dual_control');
  END IF;

  IF NOT p_approve THEN
    UPDATE vacation_change_requests
       SET status = 'rejected', decided_by = v_caller, decided_at = now(),
           decision_note = coalesce(p_note, '')
     WHERE id = p_change_id;
    PERFORM public.kadr_queue_vacreq_change_notification(p_change_id, 'rejected');
    RETURN jsonb_build_object('status', 'rejected', 'change_request_id', p_change_id);
  END IF;

  -- ── Izvršenje ─────────────────────────────────────────────────────────────
  IF v_chg.kind = 'cancel' THEN
    -- Vraća dane u fond (unset grid + brisanje absences reda) — vidi hr_cancel.
    v_inner := public.hr_cancel_vacation_request(v_chg.vacation_request_id, v_caller);
  ELSE
    -- Atomično: stari opseg se skida iz grida, novi upisuje; ostaje 'approved'.
    v_inner := public.hr_revise_vacation_request(
      v_chg.vacation_request_id, v_chg.new_date_from, v_chg.new_date_to,
      coalesce(v_chg.new_days_count, 0), nullif(v_chg.reason, ''), v_caller, false
    );
    -- Ako unutrašnji RPC nije uspeo (saldo/preklapanje/status), molba OSTAJE pending
    -- da HR vidi šta se desilo — bez tihog „odobreno" nad neizvršenom izmenom.
    IF coalesce(v_inner ->> 'status', '') IN
       ('exceeds_balance', 'overlap', 'not_found', 'not_editable', 'not_approved') THEN
      RETURN jsonb_build_object('status', 'failed', 'inner', v_inner);
    END IF;
  END IF;

  UPDATE vacation_change_requests
     SET status = 'approved', decided_by = v_caller, decided_at = now(),
         decision_note = coalesce(p_note, '')
   WHERE id = p_change_id;

  PERFORM public.kadr_queue_vacreq_change_notification(p_change_id, 'approved');

  RETURN jsonb_build_object('status', 'approved', 'change_request_id', p_change_id,
                            'kind', v_chg.kind, 'inner', v_inner);
END;
$function$;

REVOKE ALL ON FUNCTION public.kadr_vacreq_change_decide(uuid, boolean, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.kadr_vacreq_change_decide(uuid, boolean, text, text) TO authenticated;

-- ============================================================================
-- 5) kadr_queue_vacreq_change_notification — mejl istim kanalom
--    (kadr_notification_log + kadr_oversight_recipients; dispečer je 3.0 nativni)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kadr_queue_vacreq_change_notification(
  p_change_id uuid,
  p_event     text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_chg       vacation_change_requests%ROWTYPE;
  v_emp_name  text;
  v_emp_email text;
  v_kind_lbl  text;
  v_subject   text;
  v_body      text;
  v_head      text;
  v_payload   jsonb;
  v_count     int := 0;
BEGIN
  SELECT * INTO v_chg FROM vacation_change_requests WHERE id = p_change_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  SELECT COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni'), e.email
    INTO v_emp_name, v_emp_email
    FROM employees e WHERE e.id = v_chg.employee_id;

  v_kind_lbl := CASE WHEN v_chg.kind = 'cancel'
                     THEN 'otkazivanje godišnjeg odmora'
                     ELSE 'izmenu termina godišnjeg odmora' END;

  v_head := CASE p_event
    WHEN 'submitted' THEN '📨 Nov zahtev za ' || v_kind_lbl
    WHEN 'approved'  THEN '✅ Odobren zahtev za ' || v_kind_lbl
    ELSE '🚫 Odbijen zahtev za ' || v_kind_lbl
  END;
  v_subject := v_head || ' — ' || v_emp_name;

  v_payload := jsonb_build_object(
    'event', p_event, 'kind', v_chg.kind,
    'old_date_from', v_chg.old_date_from, 'old_date_to', v_chg.old_date_to,
    'new_date_from', v_chg.new_date_from, 'new_date_to', v_chg.new_date_to,
    'submitted_by', v_chg.submitted_by, 'decided_by', v_chg.decided_by
  );

  v_body :=
    '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
    || '<h2 style="color:#2563eb;margin-bottom:4px;">' || v_head || '</h2>'
    || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:400px;">'
    || '<tr style="background:#eff6ff;"><td style="padding:8px 14px;border:1px solid #dbeafe;">Zaposleni</td>'
    ||   '<td style="padding:8px 14px;border:1px solid #dbeafe;font-weight:600;">' || v_emp_name || '</td></tr>'
    || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Potvrđen termin</td>'
    ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
    ||     to_char(v_chg.old_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_chg.old_date_to, 'DD.MM.YYYY') || '</td></tr>'
    || CASE WHEN v_chg.kind = 'revise' THEN
         '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Predloženi termin</td>'
         || '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
         || to_char(v_chg.new_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_chg.new_date_to, 'DD.MM.YYYY')
         || ' (' || COALESCE(v_chg.new_days_count::text, '—') || ' radnih dana)</td></tr>'
       ELSE '' END
    || CASE WHEN COALESCE(v_chg.reason, '') <> '' THEN
         '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Razlog</td>'
         || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || v_chg.reason || '</td></tr>'
       ELSE '' END
    || CASE WHEN COALESCE(v_chg.decision_note, '') <> '' THEN
         '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Napomena odluke</td>'
         || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || v_chg.decision_note || '</td></tr>'
       ELSE '' END
    || '</table>'
    || CASE WHEN p_event = 'submitted'
            THEN '<p style="font-size:.9em;color:#475569;">Zahtev čeka odluku u modulu <strong>Kadrovska → Odmori → Zahtevi GO</strong>.</p>'
            ELSE '' END
    || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
    || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
    || '</div>';

  WITH recips AS (
    SELECT DISTINCT lower(x) AS email FROM (
      SELECT email AS x FROM public.kadr_oversight_recipients(v_chg.employee_id)
      UNION ALL SELECT v_emp_email
      UNION ALL SELECT v_chg.submitted_by
    ) s
    WHERE x IS NOT NULL AND x <> ''
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body, notification_type,
      employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at
    )
    SELECT 'email', email, v_subject, v_body, 'vacation_change_' || p_event,
           v_chg.employee_id, 'vacation_change_request', p_change_id, v_payload, 'queued', now()
    FROM recips
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.kadr_queue_vacreq_change_notification(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.kadr_queue_vacreq_change_notification(uuid, text) TO authenticated;

COMMIT;

-- ============================================================================
-- 6) PREDLOG (NIJE u transakciji iznad — traži zasebnu odluku!)
--    Zatvaranje rupe zbog koje ceo tok 026/26 može da se zaobiđe
-- ============================================================================
-- `hr_revise_vacation_request`, `hr_cancel_vacation_request` i
-- `hr_delete_vacation_request` puštaju PODNOSIOCA (`v_is_sub`) i nad `approved`
-- redom. 3.0 FE posle ovog zahteva radniku nudi samo „Zatraži izmenu/otkazivanje",
-- ali ko pozove API direktno i dalje može jednostrano da skine odobren termin.
-- Preporuka: u sve tri funkcije, ODMAH POSLE računanja `v_is_sub`/`v_is_mgr`,
-- ubaciti blok:
--
--   IF v_req.status = 'approved' AND v_is_sub AND NOT v_is_mgr THEN
--     RETURN jsonb_build_object('status', 'needs_change_request',
--                               'request_id', p_request_id);
--   END IF;
--
-- (rukovodilac/HR ostaje netaknut — on i dalje menja/otkazuje direktno; radnik
--  dobija poruku „za potvrđen termin podnesi zahtev za izmenu/otkaz").
-- Nije uključeno u BEGIN/COMMIT gore jer traži prepis celog tela ŽIVIH definicija
-- (`SELECT pg_get_functiondef(...)`) i potvrdu da 1.0 FE ne zavisi od starog
-- ponašanja — dogovor sa Nenadom pre primene.

-- ============================================================================
-- PROVERA POSLE PRIMENE (read-only)
-- ============================================================================
-- SELECT count(*) FROM vacation_change_requests;                      -- 0
-- SELECT proname FROM pg_proc WHERE proname LIKE 'kadr_vacreq_change%';
-- SELECT polname FROM pg_policy
--   WHERE polrelid = 'public.vacation_change_requests'::regclass;     -- vcr_select

-- ============================================================================
-- ZAHTEV 026/26 — zahtev za IZMENU / OTKAZIVANJE već POTVRĐENOG GO termina
-- Datum: 2026-07-31 · grana: feat/zahtev-026-go-izmena-otkaz
--
-- ⚠️⚠️ REDOSLED PRIMENE JE OBAVEZAN: **PRVO OVAJ SQL NA sy15, PA TEK ONDA
--    MERGE/DEPLOY GRANE.** Frontend istog trenutka kad se deployuje sklanja
--    radniku direktnu izmenu/otkaz/brisanje nad potvrđenim terminom i nudi samo
--    „Zatraži izmenu/otkazivanje"; ako funkcije još ne postoje, ta jedina preostala
--    akcija puca (42883 → 503 „modul čeka primenu SQL-a"). Obrnut redosled ostavlja
--    radnike bez ijedne akcije nad potvrđenim odmorom.
--
-- ⚠️ OVAJ FAJL SE NE IZVRŠAVA AUTOMATSKI. Primenu na sy15 (glavna baza, self-hosted
--    Supabase na ubuntusrv) radi glavna sesija RUČNO, posle review-a. Nema Prisma
--    migracije — sy15 objekti nisu u 3.0 migracionom lancu.
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
--   2. pomoćne fn: `kadr_is_service_caller`, `kadr_actor_email`, `kadr_html_escape`,
--      `kadr_vacreq_direct_blocked`
--   3. `kadr_vacreq_change_submit(...)`   — podnošenje (radnik ∨ upravljač)
--   4. `kadr_vacreq_change_decide(...)`   — odluka (odobri/odbij) + izvršenje
--   5. `kadr_queue_vacreq_change_notification(...)` — mejl istim kanalom
--      (`kadr_notification_log`, obrazac `kadr_queue_vacation_*`)
--   6. GUARD u `hr_revise_/hr_cancel_/hr_delete_vacation_request` — radnik-podnosilac
--      NAD ODOBRENIM terminom više ne prolazi direktno (review 31.07, nalaz HIGH):
--      bez ovoga je ceo tok 026/26 kozmetika u UI-ju, jer curl/DevTools poziv i dalje
--      jednostrano skida potvrđen termin. **HR/rukovodilac ostaje netaknut.**
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
-- PRE PRIMENE OBAVEZNO uporediti da žive definicije tri hr_* funkcije odgovaraju
-- snapshotu `backend/docs/design/authz-snapshots/talasG-fn-defs-2026-07-12.sql`
-- (sekcija 7 ih PREPISUJE u celosti — drift bi bio tiho izgubljen):
--   SELECT pg_get_functiondef('public.hr_cancel_vacation_request(uuid,text)'::regprocedure);
--   SELECT pg_get_functiondef('public.hr_delete_vacation_request(uuid,text)'::regprocedure);
--   SELECT pg_get_functiondef('public.hr_revise_vacation_request(uuid,date,date,int,text,text,boolean)'::regprocedure);
-- Skripta usput SAMA snima zatečene definicije u `vacreq_fn_defs_backup_026`
-- (rollback = izvrši sačuvani `definition`).
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
-- 3) Pomoćne funkcije
-- ============================================================================

-- 3a) Da li poziv dolazi od POVERLJIVE (servisne) role — samo tada se veruje
--     `p_actor_email` parametru. Obrazac preuzet iz `kadr_trigger_weekly_risk_summary`
--     (session_user postgres/supabase_admin/superuser), proširen na `service_role`.
--     `session_user` se NE menja kroz `SET ROLE` (3.0 backend: servosync2_app →
--     SET LOCAL ROLE authenticated), a 1.0 PostgREST se povezuje kao `authenticator`
--     — dakle nijedan korisnički klijent ne može da se predstavi kao servis.
CREATE OR REPLACE FUNCTION public.kadr_is_service_caller()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      OR session_user::text IN ('postgres', 'supabase_admin')
      OR EXISTS (SELECT 1 FROM pg_roles r
                  WHERE r.rolname = session_user::name AND r.rolsuper);
$function$;

REVOKE ALL ON FUNCTION public.kadr_is_service_caller() FROM public;
GRANT EXECUTE ON FUNCTION public.kadr_is_service_caller() TO authenticated;

-- 3b) Identitet aktera. ⚠️ REVIEW 31.07 (nalaz MEDIUM „spoofing p_actor_email"):
--     ranije je bilo `coalesce(p_actor_email, auth.jwt()->>'email')` — dakle parametar
--     koji NAPADAČ KONTROLIŠE imao je prednost nad JWT-om, pa je preko direktnog
--     PostgREST rpc poziva svaki `authenticated` korisnik mogao da se predstavi kao
--     tuđi podnosilac (i tako obori novu `dual_control` branu u decide).
--     Sada: JWT PRVI, `p_actor_email` se poštuje SAMO kad je pozivalac servisna rola.
--     3.0 backend ništa ne gubi — `withUserRls`/`runIdempotentRls` postavljaju
--     `request.jwt.claims` sa ISTIM mejlom koji prosleđuju kao `p_actor_email`.
CREATE OR REPLACE FUNCTION public.kadr_actor_email(p_actor_email text DEFAULT NULL)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT lower(coalesce(
    nullif(auth.jwt() ->> 'email', ''),
    CASE WHEN public.kadr_is_service_caller() THEN nullif(p_actor_email, '') END,
    ''
  ));
$function$;

REVOKE ALL ON FUNCTION public.kadr_actor_email(text) FROM public;
GRANT EXECUTE ON FUNCTION public.kadr_actor_email(text) TO authenticated;

-- 3c) HTML escape za korisnički tekst koji ide u telo mejla (nalaz LOW „HTML
--     injekcija"): `reason`/`decision_note` su slobodan tekst radnika i lepe se u
--     HTML koji 3.0 dispečer šalje NEIZMENJEN (`html: row.body`).
CREATE OR REPLACE FUNCTION public.kadr_html_escape(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT replace(replace(replace(replace(replace(
           coalesce(p_text, ''),
           '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$function$;

REVOKE ALL ON FUNCTION public.kadr_html_escape(text) FROM public;
GRANT EXECUTE ON FUNCTION public.kadr_html_escape(text) TO authenticated;

-- 3d) Brana iz sekcije 7: da li direktan (hr_*) zahvat nad ODOBRENIM terminom mora
--     da se odbije jer ga radi PODNOSILAC koji nije upravljač.
--     Interna putanja (`kadr_vacreq_change_decide` izvršava HR odluku) se prepoznaje
--     po transakciono-lokalnom GUC-u `kadr.vacreq_change_exec` = vacation_request_id;
--     taj GUC postavlja SAMO decide (`set_config(..., is_local => true)`), a nijedan
--     klijent ga ne može postaviti kroz PostgREST (izlaže se samo `public` šema, a
--     `set_config` je u `pg_catalog`).
CREATE OR REPLACE FUNCTION public.kadr_vacreq_direct_blocked(
  p_request_id uuid,
  p_status     text,
  p_is_sub     boolean,
  p_is_mgr     boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_status = 'approved'
     AND coalesce(p_is_sub, false)
     AND NOT coalesce(p_is_mgr, false)
     AND coalesce(nullif(current_setting('kadr.vacreq_change_exec', true), ''), '')
         IS DISTINCT FROM p_request_id::text;
$function$;

REVOKE ALL ON FUNCTION public.kadr_vacreq_direct_blocked(uuid, text, boolean, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.kadr_vacreq_direct_blocked(uuid, text, boolean, boolean) TO authenticated;

-- ============================================================================
-- 4) kadr_vacreq_change_submit — podnošenje
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
  -- Identitet iz JWT-a (p_actor_email samo za servisnu rolu) — vidi 3b.
  v_caller := public.kadr_actor_email(p_actor_email);
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
-- 5) kadr_vacreq_change_decide — odluka HR-a / rukovodioca
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
  v_chg       vacation_change_requests%ROWTYPE;
  v_caller    text;
  v_inner     jsonb;
  v_parent    text;
  v_expect    text;
  v_year      int;
  v_remaining int;
  v_failed    boolean := false;
BEGIN
  -- Identitet iz JWT-a (p_actor_email samo za servisnu rolu) — inače bi `dual_control`
  -- ispod bio zaobilazan prosleđivanjem tuđeg mejla (review 31.07).
  v_caller := public.kadr_actor_email(p_actor_email);
  IF v_caller = '' THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Nepoznat korisnik.';
  END IF;

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
  -- (1) Matični zahtev MORA i dalje biti `approved`. Bez ove provere je moguć
  --     scenario iz review-a: u međuvremenu je vraćen na `pending` → `hr_revise`
  --     tiho prepiše datume i ostavi ga `pending`, a molba bi bila „odobrena".
  SELECT status INTO v_parent FROM vacation_requests
   WHERE id = v_chg.vacation_request_id FOR UPDATE;
  IF v_parent IS NULL THEN
    RETURN jsonb_build_object('status', 'failed', 'reason', 'parent_not_found',
                              'change_request_id', p_change_id);
  END IF;
  IF v_parent <> 'approved' THEN
    RETURN jsonb_build_object('status', 'failed', 'reason', 'parent_not_approved',
                              'parent_status', v_parent, 'change_request_id', p_change_id);
  END IF;

  -- (2) Saldo FAIL-CLOSED za `revise`. `hr_revise` proverava saldo samo
  --     `IF v_remaining IS NOT NULL` — bez reda u `v_vacation_balance` za ciljnu
  --     godinu provera se TIHO preskače (na produ je bilo 21 aktivnih bez 2026 reda,
  --     zahtev 028/26). Ovde je taj put jedina brana fonda, pa odbijamo unapred.
  IF v_chg.kind = 'revise' THEN
    v_year := EXTRACT(YEAR FROM v_chg.new_date_from)::int;
    SELECT days_remaining INTO v_remaining FROM v_vacation_balance
     WHERE employee_id = v_chg.employee_id AND year = v_year;
    IF v_remaining IS NULL THEN
      RETURN jsonb_build_object('status', 'failed', 'reason', 'no_balance_row',
                                'year', v_year, 'change_request_id', p_change_id);
    END IF;
  END IF;

  -- (3) POZITIVNA provera ishoda: prihvata se ISKLJUČIVO očekivani status unutrašnjeg
  --     RPC-a. Sve ostalo (already_closed, not_found, not_editable, pending,
  --     exceeds_balance…) → `failed`, molba OSTAJE `pending`, a pod-blok VRAĆA
  --     UNAZAD sve što je unutrašnji RPC već stigao da upiše (grid/absences/datumi).
  v_expect := CASE WHEN v_chg.kind = 'cancel' THEN 'canceled' ELSE 'rescheduled' END;

  BEGIN
    -- Interna putanja — otključava guard iz sekcije 7 samo za OVAJ zahtev i OVU tx.
    PERFORM set_config('kadr.vacreq_change_exec', v_chg.vacation_request_id::text, true);

    IF v_chg.kind = 'cancel' THEN
      -- Vraća dane u fond (unset grid + brisanje absences reda) — vidi hr_cancel.
      v_inner := public.hr_cancel_vacation_request(v_chg.vacation_request_id, v_caller);
    ELSE
      -- Atomično: stari opseg se skida iz grida, novi upisuje; ostaje 'approved'.
      v_inner := public.hr_revise_vacation_request(
        v_chg.vacation_request_id, v_chg.new_date_from, v_chg.new_date_to,
        coalesce(v_chg.new_days_count, 0), nullif(v_chg.reason, ''), v_caller, false
      );
    END IF;

    PERFORM set_config('kadr.vacreq_change_exec', '', true);

    IF coalesce(v_inner ->> 'status', '') IS DISTINCT FROM v_expect THEN
      RAISE EXCEPTION 'vacreq_change_exec_failed' USING ERRCODE = 'ZC026';
    END IF;
  EXCEPTION WHEN SQLSTATE 'ZC026' THEN
    -- Pod-blok je rollback-ovan → ništa od unutrašnjeg RPC-a nije ostalo upisano.
    v_failed := true;
  END;

  IF v_failed THEN
    PERFORM set_config('kadr.vacreq_change_exec', '', true);
    RETURN jsonb_build_object('status', 'failed',
                              'reason', coalesce(v_inner ->> 'status', 'unknown'),
                              'expected', v_expect, 'inner', v_inner,
                              'change_request_id', p_change_id);
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
-- 6) kadr_queue_vacreq_change_notification — mejl istim kanalom
--    (kadr_notification_log + kadr_oversight_recipients; dispečer je 3.0 nativni)
--
--    ⚠️ NIJE za `authenticated` (review 31.07): funkcija nema nikakvu proveru prava
--    i zove se ISKLJUČIVO iznutra iz dva DEFINER RPC-a (koji se izvršavaju kao owner,
--    pa im grant ne treba). Sa grantom je svako mogao da fabrikuje „✅ Odobren zahtev"
--    mejl sebi i celom oversight krugu (lažan „dokaz" HR odluke + spam).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kadr_queue_vacreq_change_notification(
  p_change_id uuid,
  p_event     text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
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

  -- Sav tekst koji potiče od korisnika ide kroz `kadr_html_escape` — telo se šalje
  -- kao gotov HTML (dispečer ga NE sanitizuje), pa bi sirov `reason` bio injekcija.
  v_body :=
    '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
    || '<h2 style="color:#2563eb;margin-bottom:4px;">' || v_head || '</h2>'
    || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:400px;">'
    || '<tr style="background:#eff6ff;"><td style="padding:8px 14px;border:1px solid #dbeafe;">Zaposleni</td>'
    ||   '<td style="padding:8px 14px;border:1px solid #dbeafe;font-weight:600;">'
    ||     public.kadr_html_escape(v_emp_name) || '</td></tr>'
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
         || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">'
         || public.kadr_html_escape(v_chg.reason) || '</td></tr>'
       ELSE '' END
    || CASE WHEN COALESCE(v_chg.decision_note, '') <> '' THEN
         '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Napomena odluke</td>'
         || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">'
         || public.kadr_html_escape(v_chg.decision_note) || '</td></tr>'
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

-- Interni helper — bez granta korisničkim rolama (owner ga izvršava kroz DEFINER RPC-ove).
REVOKE ALL ON FUNCTION public.kadr_queue_vacreq_change_notification(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.kadr_queue_vacreq_change_notification(uuid, text) FROM authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.kadr_queue_vacreq_change_notification(uuid, text) TO service_role';
  END IF;
END $$;

-- ============================================================================
-- 7) ZATVARANJE RUPE NA API NIVOU (bilo „PREDLOG" — odluka doneta 31.07.2026)
--
--    `hr_revise_vacation_request`, `hr_cancel_vacation_request` i
--    `hr_delete_vacation_request` puštaju PODNOSIOCA (`v_is_sub`) i nad `approved`
--    redom. 3.0 FE posle ovog zahteva radniku nudi samo „Zatraži izmenu/otkazivanje",
--    ali dok ovo ne stoji u BAZI, curl/DevTools poziv (ili 1.0 klijent preko
--    PostgREST-a) i dalje jednostrano skida odobren termin → ceo tok 026/26 bi bio
--    kozmetika.
--
--    Tela su PREPISANA IZ SNAPSHOT-a `talasG-fn-defs-2026-07-12.sql` sa JEDNIM
--    umetnutim blokom (`kadr_vacreq_direct_blocked`) odmah posle provere prava.
--    Rukovodilac/HR (`v_is_mgr`) je NETAKNUT — on i dalje menja/otkazuje/briše
--    direktno; interna putanja iz `kadr_vacreq_change_decide` je propuštena preko
--    transakcionog GUC-a. Radnik dobija `{"status":"needs_change_request"}`.
--
--    ⚠️ UTICAJ NA 1.0: i 1.0 klijenti gađaju iste fn preko PostgREST-a. Radnik koji u
--    1.0 pokuša izmenu/otkaz POTVRĐENOG termina dobiće `needs_change_request` (1.0 FE
--    taj status ne poznaje → generička poruka, ali NIŠTA se ne menja u bazi). To je
--    tražena posledica odluke: potvrđen termin se menja samo kroz molbu u 3.0.
--    Provereno: definicija `hr_revise_vacation_request` je IDENTIČNA u talasD i talasG
--    snapshotu, i nijedan drugi sy15/3.0 pozivalac ne prosleđuje `p_actor_email`.
-- ============================================================================

-- Sigurnosna kopija zatečenih definicija (rollback = izvrši sačuvani `definition`).
CREATE TABLE IF NOT EXISTS public.vacreq_fn_defs_backup_026 (
  id          bigserial PRIMARY KEY,
  fn          text NOT NULL,
  definition  text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.vacreq_fn_defs_backup_026 FROM authenticated;

INSERT INTO public.vacreq_fn_defs_backup_026 (fn, definition)
SELECT p, pg_get_functiondef(p::regprocedure)
  FROM unnest(ARRAY[
    'public.hr_cancel_vacation_request(uuid,text)',
    'public.hr_delete_vacation_request(uuid,text)',
    'public.hr_revise_vacation_request(uuid,date,date,int,text,text,boolean)'
  ]) AS p;

-- ── 7a) hr_cancel_vacation_request ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_cancel_vacation_request(
  p_request_id uuid,
  p_actor_email text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req    vacation_requests%ROWTYPE;
  v_caller text;
  v_is_sub boolean;
  v_is_mgr boolean;
  v_was    text;
BEGIN
  v_caller := public.kadr_actor_email(p_actor_email);

  SELECT * INTO v_req FROM vacation_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'request_id', p_request_id);
  END IF;
  v_was := v_req.status;

  v_is_sub := (v_caller <> '' AND lower(coalesce(v_req.submitted_by, '')) = v_caller);
  v_is_mgr := public.current_user_can_manage_vacreq()
              AND (public.current_user_manages_employee(v_req.employee_id)
                   OR public.current_user_is_vacreq_admin());
  IF NOT (v_is_sub OR v_is_mgr) THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Otkazati može podnosilac ili upravljac GO zahteva.';
  END IF;

  /* ZAHTEV 026/26 — nad POTVRĐENIM terminom radnik ne otkazuje direktno; podnosi molbu. */
  IF public.kadr_vacreq_direct_blocked(p_request_id, v_req.status, v_is_sub, v_is_mgr) THEN
    RETURN jsonb_build_object('status', 'needs_change_request', 'request_id', p_request_id,
                              'current_status', v_req.status);
  END IF;

  IF v_req.status IN ('rejected', 'canceled') THEN
    RETURN jsonb_build_object('status', 'already_closed', 'request_id', p_request_id, 'current_status', v_req.status);
  END IF;

  /* Ako je bio odobren — oslobodi saldo: skloni grid go + evidencijski absence. */
  IF v_req.status = 'approved' THEN
    PERFORM public.kadr_grid_unset_go(v_req.employee_id, v_req.date_from, v_req.date_to);
    DELETE FROM absences
     WHERE employee_id = v_req.employee_id AND type = 'godisnji'
       AND date_from = v_req.date_from AND date_to = v_req.date_to AND archived_at IS NULL;
  END IF;

  UPDATE vacation_requests
     SET status = 'canceled', reviewed_by = v_caller, reviewed_at = now(), updated_at = now()
   WHERE id = p_request_id;

  RETURN jsonb_build_object('status', 'canceled', 'request_id', p_request_id, 'was', v_was);
END;
$function$;

-- ── 7b) hr_delete_vacation_request ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_delete_vacation_request(
  p_request_id uuid,
  p_actor_email text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req    vacation_requests%ROWTYPE;
  v_caller text;
  v_is_sub boolean;
  v_is_mgr boolean;
  v_was    text;
BEGIN
  v_caller := public.kadr_actor_email(p_actor_email);

  SELECT * INTO v_req FROM vacation_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'request_id', p_request_id);
  END IF;
  v_was := v_req.status;

  v_is_sub := (v_caller <> '' AND lower(coalesce(v_req.submitted_by, '')) = v_caller);
  v_is_mgr := public.current_user_can_manage_vacreq()
              AND (public.current_user_manages_employee(v_req.employee_id)
                   OR public.current_user_is_vacreq_admin());
  IF NOT (v_is_sub OR v_is_mgr) THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Obrisati zahtev može podnosilac ili upravljac GO zahteva.';
  END IF;

  /* ZAHTEV 026/26 — brisanje POTVRĐENOG termina je HR odluka, ne radnikov klik. */
  IF public.kadr_vacreq_direct_blocked(p_request_id, v_req.status, v_is_sub, v_is_mgr) THEN
    RETURN jsonb_build_object('status', 'needs_change_request', 'request_id', p_request_id,
                              'current_status', v_req.status);
  END IF;

  /* Ako je bio odobren — oslobodi saldo pre brisanja (grid go + evidencijski absence). */
  IF v_req.status = 'approved' THEN
    PERFORM public.kadr_grid_unset_go(v_req.employee_id, v_req.date_from, v_req.date_to);
    DELETE FROM absences
     WHERE employee_id = v_req.employee_id AND type = 'godisnji'
       AND date_from = v_req.date_from AND date_to = v_req.date_to AND archived_at IS NULL;
  END IF;

  DELETE FROM vacation_requests WHERE id = p_request_id;

  RETURN jsonb_build_object('status', 'deleted', 'request_id', p_request_id, 'was', v_was);
END;
$function$;

-- ── 7c) hr_revise_vacation_request ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_revise_vacation_request(
  p_request_id uuid,
  p_date_from date,
  p_date_to date,
  p_days_count integer,
  p_note text DEFAULT NULL::text,
  p_actor_email text DEFAULT NULL::text,
  p_force_reapproval boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req        vacation_requests%ROWTYPE;
  v_caller     text;
  v_old_status text;
  v_is_sub     boolean;
  v_is_mgr     boolean;
  v_new_year   int;
  v_remaining  int;
  v_available  int;
  v_same_old   int;
  v_updated    int;
  v_old_from   date;
  v_old_to     date;
BEGIN
  v_caller := public.kadr_actor_email(p_actor_email);

  SELECT * INTO v_req FROM vacation_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'request_id', p_request_id);
  END IF;
  v_old_status := v_req.status;
  v_old_from   := v_req.date_from;
  v_old_to     := v_req.date_to;

  v_is_sub := (v_caller <> '' AND lower(coalesce(v_req.submitted_by, '')) = v_caller);
  v_is_mgr := public.current_user_can_manage_vacreq()
              AND (public.current_user_manages_employee(v_req.employee_id)
                   OR public.current_user_is_vacreq_admin());

  IF NOT (v_is_sub OR v_is_mgr) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Samo podnosilac ili upravljac GO zahteva moze da menja.';
  END IF;

  /* ZAHTEV 026/26 — nad POTVRĐENIM terminom radnik ne menja direktno (inače bi ovde
     pao u „pending" granu, obrisao grid ćelije i sam poništio HR odluku). */
  IF public.kadr_vacreq_direct_blocked(p_request_id, v_req.status, v_is_sub, v_is_mgr) THEN
    RETURN jsonb_build_object('status', 'needs_change_request', 'request_id', p_request_id,
                              'current_status', v_req.status);
  END IF;

  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_to < p_date_from THEN
    RAISE EXCEPTION 'invalid_dates' USING ERRCODE = '22007', HINT = 'Neispravan opseg datuma.';
  END IF;

  IF v_req.status = 'rejected' THEN
    RETURN jsonb_build_object('status', 'not_editable', 'request_id', p_request_id, 'current_status', v_req.status);
  END IF;

  v_new_year := EXTRACT(YEAR FROM p_date_from)::int;

  /* ── ODOBREN + UPRAVLJAC → premeštanje, OSTAJE 'approved' ─────────────────
     Preskače se ako upravljač eksplicitno traži ponovno odobravanje
     (p_force_reapproval = true) → pada u „pending" granu ispod. */
  IF v_req.status = 'approved' AND v_is_mgr AND NOT p_force_reapproval THEN
    SELECT days_remaining INTO v_remaining FROM v_vacation_balance
     WHERE employee_id = v_req.employee_id AND year = v_new_year;
    v_same_old := CASE WHEN v_req.year = v_new_year THEN COALESCE(v_req.days_count, 0) ELSE 0 END;
    IF v_remaining IS NOT NULL THEN
      v_available := v_remaining + v_same_old;
      IF COALESCE(p_days_count, 0) > v_available THEN
        RETURN jsonb_build_object('status', 'exceeds_balance', 'request_id', p_request_id,
                                  'remaining', v_available, 'requested', COALESCE(p_days_count, 0));
      END IF;
    END IF;

    UPDATE absences
       SET date_from = p_date_from, date_to = p_date_to, days_count = NULLIF(p_days_count, 0),
           note = COALESCE(note, '') || ' · termin promenjen ' || v_caller
     WHERE employee_id = v_req.employee_id AND type = 'godisnji'
       AND date_from = v_req.date_from AND date_to = v_req.date_to AND archived_at IS NULL;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      INSERT INTO absences (employee_id, type, date_from, date_to, days_count, note)
      VALUES (v_req.employee_id, 'godisnji', p_date_from, p_date_to, NULLIF(p_days_count, 0),
              'GO termin promenjen (' || v_caller || ')');
    END IF;

    /* GRID JE ZAKON: skloni stari termin, upiši nov. */
    PERFORM public.kadr_grid_unset_go(v_req.employee_id, v_old_from, v_old_to);
    PERFORM public.kadr_grid_set_go(v_req.employee_id, p_date_from, p_date_to, v_caller);

    UPDATE vacation_requests
       SET date_from = p_date_from, date_to = p_date_to,
           days_count = COALESCE(p_days_count, 0), year = v_new_year,
           note = COALESCE(p_note, note), reviewed_by = v_caller, reviewed_at = now()
     WHERE id = p_request_id RETURNING * INTO v_req;

    RETURN jsonb_build_object('status', 'rescheduled', 'request_id', p_request_id,
       'date_from', p_date_from, 'date_to', p_date_to,
       'days_count', COALESCE(p_days_count, 0), 'reviewed_by', v_caller);
  END IF;

  /* ── Sve ostalo → 'pending' (ponovno odobravanje) ────────────────────────
     Uključuje: podnosilac koji nije upravljač; pending/sef_approved izmene;
     i upravljača koji je eksplicitno tražio ponovno odobravanje. */
  IF v_req.status = 'approved' THEN
    DELETE FROM absences
     WHERE employee_id = v_req.employee_id AND type = 'godisnji'
       AND date_from = v_req.date_from AND date_to = v_req.date_to AND archived_at IS NULL;
    /* GRID JE ZAKON: oslobodi go ćelije starog (odobrenog) termina. */
    PERFORM public.kadr_grid_unset_go(v_req.employee_id, v_old_from, v_old_to);
  END IF;

  UPDATE vacation_requests
     SET date_from = p_date_from, date_to = p_date_to,
         days_count = COALESCE(p_days_count, 0), year = v_new_year,
         note = COALESCE(p_note, note),
         status = 'pending', level1_by = NULL, level1_at = NULL,
         reviewed_by = NULL, reviewed_at = NULL, rejection_note = NULL, updated_at = now()
   WHERE id = p_request_id RETURNING * INTO v_req;

  RETURN jsonb_build_object('status', 'pending', 'request_id', p_request_id,
     'reverted', (v_old_status = 'approved'),
     'date_from', p_date_from, 'date_to', p_date_to, 'days_count', COALESCE(p_days_count, 0));
END;
$function$;

COMMIT;

-- ============================================================================
-- PROVERA POSLE PRIMENE (read-only)
-- ============================================================================
-- SELECT count(*) FROM vacation_change_requests;                      -- 0
-- SELECT proname FROM pg_proc WHERE proname LIKE 'kadr_vacreq_change%';
-- SELECT polname FROM pg_policy
--   WHERE polrelid = 'public.vacation_change_requests'::regclass;     -- vcr_select
--
-- Guard (sekcija 7) je u sve tri fn:
-- SELECT p.proname,
--        pg_get_functiondef(p.oid) LIKE '%kadr_vacreq_direct_blocked%' AS ima_guard
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('hr_cancel_vacation_request','hr_delete_vacation_request',
--                      'hr_revise_vacation_request');                 -- 3× true
--
-- Queue fn NIJE dostupna korisnicima:
-- SELECT has_function_privilege('authenticated',
--          'public.kadr_queue_vacreq_change_notification(uuid,text)', 'EXECUTE'); -- false
--
-- Rollback sekcije 7 (ako zatreba):
-- SELECT definition FROM vacreq_fn_defs_backup_026 ORDER BY id DESC LIMIT 3;  -- pa izvrši

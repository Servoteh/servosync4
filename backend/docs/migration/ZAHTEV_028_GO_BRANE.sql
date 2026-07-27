-- ============================================================================
-- ZAHTEV 028/26 — GO brane u sy15 (PREDLOG, NIJE PRIMENJEN)
-- Datum: 2026-07-27 · grana: fix/zahtev-028-go-prikaz
--
-- ⚠️ OVAJ FAJL SE NE IZVRŠAVA AUTOMATSKI. Primenu radi Nenad ručno na sy15
--    (glavna baza), posle pregleda. Nema Prisma migracije — sy15 objekti nisu
--    u 3.0 migracionom lancu.
--
-- ── Zašto ────────────────────────────────────────────────────────────────────
-- Bug 028/26 („GO: pogrešan prikaz raspoloživih dana") imao je četiri sloja.
-- Tri su zatvorena u aplikaciji (ova grana):
--   1. FE: obrazac je uz „Za koga" picker prikazivao saldo PODNOSIOCA i kad se
--      podnosi za člana tima (Zoran 41 → forma piše 41 za Lazara koji ima 15/7).
--   2. FE: svuda se prikazivao KALENDARSKI `days_remaining` umesto 1.0 kanona
--      `days_remaining_accrued ?? days_remaining` (stečeno do danas).
--   3. BE `moj-profil.service.ts submitVacation`: verovao je klijentskom
--      `daysCount` (DTO ga pušta 0–366), validirao kalendarski saldo i bio
--      FAIL-OPEN kad reda u `v_vacation_balance` nema.
-- Četvrti sloj je u bazi i traži ove dve izmene:
--   4a. `hr_vacreq_approve` — kad `days_remaining` vrati NULL (nema reda za
--       zaposlenog+godinu; na produ 21 aktivan zaposleni bez 2026 reda) provera
--       se PRESKAKALA i zahtev je odobravan bez ikakve kape.
--   4b. Nijedna tačka upisa GO ćelija nema trajni guard — `kadr_grid_set_go` je
--       jedini put kojim GO ulazi u `work_hours` pri odobrenju (zove ga i
--       `hr_vacreq_approve` i `hr_vacreq_reschedule` i `hr_revise_vacation_request`),
--       pa je to prirodno mesto za „zakucavanje".
--
-- ── Osnov brojeva ────────────────────────────────────────────────────────────
-- `v_vacation_balance` (snapshot talasG 2026-07-12) računa:
--   days_used            = opening_used + grid_used
--   days_remaining       = days_total + days_carried_over − opening_used
--                          − grid_used − grid_planned            (kalendarski)
--   days_remaining_accrued = days_carried_over + COALESCE(days_earned, days_total)
--                          − days_used − days_planned            (stečeno do danas)
-- `grid_used`/`grid_planned` DOLAZE IZ `work_hours` (absence_code='go'), pa se u
-- guard-u u `kadr_grid_set_go` NE SME koristiti `days_remaining` — bilo bi
-- ciklično. Kapa je zato izvor alokacije:
--   cap = vacation_entitlements.days_total + days_carried_over − opening_used
-- a potrošnja se broji direktno iz grida.
--
-- ── Napomena o polaznim definicijama ─────────────────────────────────────────
-- Tela ispod su doslovna kopija AKTUELNIH definicija iz
-- `backend/docs/design/authz-snapshots/talasG-fn-defs-2026-07-12.sql`
-- (hr_vacreq_approve: linija 2104; kadr_grid_set_go: linija 2971) uz označene
-- izmene. Istraga je potvrdila da su žive definicije identične snapshotu.
-- PRE PRIMENE svejedno uporediti sa živim stanjem:
--   SELECT pg_get_functiondef('public.hr_vacreq_approve(uuid,text)'::regprocedure);
--   SELECT pg_get_functiondef('public.kadr_grid_set_go(uuid,date,date,text)'::regprocedure);
-- ============================================================================


-- ============================================================================
-- 1) hr_vacreq_approve — FAIL-CLOSED kad nema reda fonda
-- ============================================================================
-- IZMENA (2 mesta, obe grane finalizacije — „pending direktno" i „sef_approved"):
--   staro:  IF v_remaining IS NOT NULL AND coalesce(v_req.days_count,0) > v_remaining
--   novo:   IF v_remaining IS NULL  → RAISE (nema fonda, ne odobravaj)
--           IF coalesce(v_req.days_count,0) > v_remaining → exceeds_balance (NETAKNUTO)
--
-- Zašto RAISE a ne `RETURN jsonb_build_object('status','no_balance_row', …)`:
-- FE `frontend/src/app/kadrovska/_components/odmori/odobravanje-tab.tsx:158-161`
-- (i mobilni `app/mob/odobravanja/page.tsx:211`) prepoznaju samo `dual_control`,
-- `exceeds_balance` i `already_processed`; SVAKI drugi status pada u granu
-- `showToast('✅ Odobreno')`. Nov status bi, dakle, prikazao LAŽAN uspeh a zahtev
-- ne bi bio odobren. RAISE ide kroz `rethrowSy15` (P0001 → 422) i korisnik dobija
-- grešku. Ako se ipak želi „meki" ishod, prvo dopuniti obe FE grane pa tek onda
-- zameniti RAISE sa RETURN … 'no_balance_row'.

CREATE OR REPLACE FUNCTION public.hr_vacreq_approve(p_request_id uuid, p_actor_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req           vacation_requests%ROWTYPE;
  v_email         text;
  v_is_admin      boolean;
  v_is_hr         boolean;
  v_is_menadzment boolean;
  v_target_is_sef boolean;
  v_remaining     int;
  v_abs_id        uuid;
BEGIN
  v_email := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));
  v_is_admin := public.current_user_is_admin();
  v_is_hr    := public.current_user_is_hr() OR public.current_user_is_vacreq_admin();
  v_is_menadzment := EXISTS (
    SELECT 1 FROM user_roles WHERE lower(email) = v_email AND role = 'menadzment' AND is_active = true
  );

  IF NOT (v_is_admin OR v_is_hr OR v_is_menadzment) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Nemate ulogu za odobravanje GO zahteva.';
  END IF;

  SELECT * INTO v_req FROM vacation_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id);
  END IF;

  IF NOT (public.current_user_manages_employee(v_req.employee_id) OR public.current_user_is_vacreq_admin()) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Zahtev je van vaseg opsega pododeljenja.';
  END IF;

  IF v_req.status NOT IN ('pending', 'sef_approved') THEN
    RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id, 'current_status', v_req.status);
  END IF;

  /* Da li je PODNOSILAC šef/uprava? Njima finalizuje samo admin/HR. */
  v_target_is_sef := EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN employees e ON e.id = v_req.employee_id
    WHERE lower(ur.email) = lower(coalesce(e.email, ''))
      AND ur.is_active = true
      AND ur.role IN ('menadzment', 'admin', 'hr', 'poslovni_admin', 'leadpm', 'pm')
  );

  /* ── PENDING ─────────────────────────────────────────────────────────── */
  IF v_req.status = 'pending' THEN
    /* Direktno finalno: admin/HR uvek; ŠEF (menadžment) samo za OBIČNOG radnika. */
    IF v_is_admin OR ((v_is_hr OR v_is_menadzment) AND NOT v_target_is_sef) THEN
      SELECT days_remaining INTO v_remaining FROM v_vacation_balance
       WHERE employee_id = v_req.employee_id AND year = v_req.year;
      -- ZAHTEV 028/26: NULL = nema reda fonda za tu godinu → NE odobravaj (ranije
      -- se cela provera preskakala i zahtev je prolazio bez kape).
      IF v_remaining IS NULL THEN
        RAISE EXCEPTION 'no_balance_row' USING ERRCODE = 'P0001',
          HINT = format('Zaposleni nema evidenciju fonda godišnjeg odmora za %s. godinu — HR mora upisati fond (vacation_entitlements) pre odobrenja.', v_req.year);
      END IF;
      IF coalesce(v_req.days_count, 0) > v_remaining THEN
        RETURN jsonb_build_object('status', 'exceeds_balance', 'request_id', p_request_id,
                                  'remaining', v_remaining, 'requested', coalesce(v_req.days_count, 0));
      END IF;

      UPDATE vacation_requests
         SET status = 'approved', level1_by = coalesce(level1_by, v_email),
             level1_at = coalesce(level1_at, now()), reviewed_by = v_email, reviewed_at = now()
       WHERE id = p_request_id AND status = 'pending' RETURNING * INTO v_req;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id);
      END IF;

      INSERT INTO absences (employee_id, type, date_from, date_to, days_count, note)
      VALUES (v_req.employee_id, 'godisnji', v_req.date_from, v_req.date_to,
              NULLIF(v_req.days_count, 0),
              'Odobreno (' || CASE WHEN v_is_admin THEN 'uprava direktno, ' ELSE 'šef odeljenja direktno, ' END || v_email || ')')
      RETURNING id INTO v_abs_id;
      /* GRID JE ZAKON: upiši go ćelije za radne dane perioda. */
      PERFORM public.kadr_grid_set_go(v_req.employee_id, v_req.date_from, v_req.date_to, v_email);

      /* Info mejl administraciji kad finalizuje šef/HR (ne admin) — uvid bez akcije. */
      IF NOT v_is_admin THEN
        INSERT INTO kadr_notification_log (channel, recipient, subject, body,
          related_entity_type, related_entity_id, employee_id,
          notification_type, status, scheduled_at, next_attempt_at, payload)
        SELECT 'email', 'administracija@servoteh.com',
          format('ℹ GO odobrio šef — %s (%s–%s)',
            coalesce(e.full_name, 'N/N'), to_char(v_req.date_from, 'DD.MM.'), to_char(v_req.date_to, 'DD.MM.YYYY')),
          format('<div style="font-family:sans-serif"><p>Godišnji odmor zaposlenog <strong>%s</strong> (%s – %s, %s dana) finalno je odobrio <strong>%s</strong>.</p><p style="color:#64748b;font-size:.9em">Informativno — akcija nije potrebna. Detalji u Kadrovska → Odmori.</p></div>',
            coalesce(e.full_name, 'N/N'), to_char(v_req.date_from, 'DD.MM.YYYY'), to_char(v_req.date_to, 'DD.MM.YYYY'),
            coalesce(v_req.days_count, 0), v_email),
          'vacation_request', p_request_id::text, v_req.employee_id,
          'vacation_approved', 'queued', now(), now(),
          jsonb_build_object('approved_by', v_email, 'direct', true)
        FROM employees e WHERE e.id = v_req.employee_id;
      END IF;

      RETURN jsonb_build_object('status', 'approved', 'request_id', p_request_id,
                                'absence_id', v_abs_id, 'reviewed_by', v_email, 'direct', true);
    END IF;

    /* Šef za ŠEFA/UPRAVU → samo 1. nivo; finalizuje admin/HR. */
    UPDATE vacation_requests
       SET status = 'sef_approved', level1_by = v_email, level1_at = now()
     WHERE id = p_request_id AND status = 'pending' RETURNING * INTO v_req;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id);
    END IF;

    RETURN jsonb_build_object('status', 'sef_approved', 'request_id', p_request_id, 'level1_by', v_email);
  END IF;

  /* ── SEF_APPROVED → finalizacija ─────────────────────────────────────── */
  /* Admin/HR uvek; šef (menadžment) samo za običnog radnika. */
  IF NOT (v_is_hr OR v_is_admin OR (v_is_menadzment AND NOT v_target_is_sef)) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Finalizaciju za šefove/upravu radi HR ili uprava.';
  END IF;

  IF (NOT v_is_admin) AND lower(coalesce(v_req.level1_by, '')) = v_email THEN
    RETURN jsonb_build_object('status', 'dual_control', 'request_id', p_request_id, 'level1_by', v_req.level1_by);
  END IF;

  SELECT days_remaining INTO v_remaining FROM v_vacation_balance
   WHERE employee_id = v_req.employee_id AND year = v_req.year;
  -- ZAHTEV 028/26: isto fail-closed pravilo i u grani finalizacije.
  IF v_remaining IS NULL THEN
    RAISE EXCEPTION 'no_balance_row' USING ERRCODE = 'P0001',
      HINT = format('Zaposleni nema evidenciju fonda godišnjeg odmora za %s. godinu — HR mora upisati fond (vacation_entitlements) pre odobrenja.', v_req.year);
  END IF;
  IF coalesce(v_req.days_count, 0) > v_remaining THEN
    RETURN jsonb_build_object('status', 'exceeds_balance', 'request_id', p_request_id,
                              'remaining', v_remaining, 'requested', coalesce(v_req.days_count, 0));
  END IF;

  UPDATE vacation_requests
     SET status = 'approved', reviewed_by = v_email, reviewed_at = now()
   WHERE id = p_request_id AND status = 'sef_approved' RETURNING * INTO v_req;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id);
  END IF;

  INSERT INTO absences (employee_id, type, date_from, date_to, days_count, note)
  VALUES (v_req.employee_id, 'godisnji', v_req.date_from, v_req.date_to,
          NULLIF(v_req.days_count, 0),
          'Odobreno (finalizacija ' || v_email || ', šef: ' || coalesce(v_req.level1_by, '') || ')')
  RETURNING id INTO v_abs_id;
  /* GRID JE ZAKON: upiši go ćelije za radne dane perioda. */
  PERFORM public.kadr_grid_set_go(v_req.employee_id, v_req.date_from, v_req.date_to, v_email);

  /* Info mejl administraciji kad finalizuje neko ko nije admin. */
  IF NOT v_is_admin THEN
    INSERT INTO kadr_notification_log (channel, recipient, subject, body,
      related_entity_type, related_entity_id, employee_id,
      notification_type, status, scheduled_at, next_attempt_at, payload)
    SELECT 'email', 'administracija@servoteh.com',
      format('ℹ GO finalizovao %s — %s (%s–%s)', v_email,
        coalesce(e.full_name, 'N/N'), to_char(v_req.date_from, 'DD.MM.'), to_char(v_req.date_to, 'DD.MM.YYYY')),
      format('<div style="font-family:sans-serif"><p>Godišnji odmor zaposlenog <strong>%s</strong> (%s – %s) finalizovao je <strong>%s</strong> (1. nivo: %s).</p><p style="color:#64748b;font-size:.9em">Informativno — akcija nije potrebna.</p></div>',
        coalesce(e.full_name, 'N/N'), to_char(v_req.date_from, 'DD.MM.YYYY'), to_char(v_req.date_to, 'DD.MM.YYYY'),
        v_email, coalesce(v_req.level1_by, '—')),
      'vacation_request', p_request_id::text, v_req.employee_id,
      'vacation_approved', 'queued', now(), now(),
      jsonb_build_object('approved_by', v_email, 'level1_by', v_req.level1_by)
    FROM employees e WHERE e.id = v_req.employee_id;
  END IF;

  RETURN jsonb_build_object('status', 'approved', 'request_id', p_request_id,
                            'absence_id', v_abs_id, 'reviewed_by', v_email, 'level1_by', v_req.level1_by);
END;
$function$
;


-- ============================================================================
-- 2) kadr_grid_set_go — TRAJNI GUARD (jedina tačka upisa GO ćelija)
-- ============================================================================
-- Sve što upisuje 'go' u `work_hours` pri odobravanju prolazi kroz ovu funkciju:
--   hr_vacreq_approve (2 grane), hr_vacreq_reschedule, hr_revise_vacation_request.
-- Zato guard ovde pokriva i puteve koje aplikacija ne dodiruje (ručni SQL, budući
-- RPC-ovi, mobilni). INSERT deo je NETAKNUT — dodat je samo blok provere iznad.
--
-- Pravilo:
--   (postojeći 'go' dani u godini, VAN raspona koji se upisuje) + (novi dani te godine)
--     ≤ vacation_entitlements.days_total + days_carried_over − opening_used
--
-- Zašto „van raspona": funkcija je idempotentna (ON CONFLICT DO UPDATE), a
-- `hr_revise_vacation_request` prvo zove `kadr_grid_unset_go` pa `set_go` — bez
-- izuzimanja raspona bi se isti dani brojali dvaput i izmena termina bi pucala.
--
-- Zašto NE `v_vacation_balance.days_remaining`: taj izraz sadrži `grid_used` i
-- `grid_planned` koji se izvode IZ `work_hours` — provera bi bila ciklična.
-- Kapa je zato sirova alokacija iz `vacation_entitlements` (bez COALESCE default-a
-- koje view podmeće: nema reda = nema odobrenja).
--
-- Raspon može da pređe granicu godine (npr. 28.12–05.01), pa se proverava po
-- godini posebno.
--
-- ⚠️ Posledica: RAISE unutar `kadr_grid_set_go` obara CELU transakciju odobravanja
--    (status zahteva, `absences` red i notifikacija se rollback-uju). To je
--    namerno — bolje nego odobren GO bez pokrića u fondu.

CREATE OR REPLACE FUNCTION public.kadr_grid_set_go(p_employee_id uuid, p_date_from date, p_date_to date, p_actor text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n integer;
  v_year integer;
  v_cap integer;
  v_existing integer;
  v_new integer;
BEGIN
  IF p_employee_id IS NULL OR p_date_from IS NULL OR p_date_to IS NULL
     OR p_date_to < p_date_from THEN
    RETURN 0;
  END IF;

  /* ── ZAHTEV 028/26: trajni guard nad fondom (po godini raspona) ────────── */
  FOR v_year IN
    SELECT DISTINCT extract(year from g.d)::int
      FROM generate_series(p_date_from, p_date_to, interval '1 day') g(d)
     WHERE extract(isodow from g.d::date) < 6
       AND NOT EXISTS (
         SELECT 1 FROM kadr_holidays h
          WHERE h.holiday_date = g.d::date AND h.is_workday = false
       )
  LOOP
    SELECT COALESCE(ve.days_total, 0) + COALESCE(ve.days_carried_over, 0)
           - COALESCE(ve.opening_used, 0)
      INTO v_cap
      FROM vacation_entitlements ve
     WHERE ve.employee_id = p_employee_id AND ve.year = v_year;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'no_balance_row' USING ERRCODE = 'P0001',
        HINT = format('Zaposleni nema alokaciju godišnjeg odmora za %s. godinu — HR mora upisati fond (vacation_entitlements) pre upisa GO u grid.', v_year);
    END IF;

    /* Već upisani 'go' dani te godine, BEZ raspona koji sada (re)upisujemo. */
    SELECT count(*)::int INTO v_existing
      FROM work_hours wh
     WHERE wh.employee_id = p_employee_id
       AND wh.absence_code = 'go'
       AND extract(year from wh.work_date)::int = v_year
       AND NOT (wh.work_date BETWEEN p_date_from AND p_date_to);

    /* Novi dani te godine — ISTI filter kao INSERT ispod (vikendi + praznici). */
    SELECT count(*)::int INTO v_new
      FROM generate_series(p_date_from, p_date_to, interval '1 day') g(d)
     WHERE extract(year from g.d)::int = v_year
       AND extract(isodow from g.d::date) < 6
       AND NOT EXISTS (
         SELECT 1 FROM kadr_holidays h
          WHERE h.holiday_date = g.d::date AND h.is_workday = false
       );

    IF v_existing + v_new > v_cap THEN
      RAISE EXCEPTION 'exceeds_balance' USING ERRCODE = 'P0001',
        HINT = format('GO za %s. godinu: već upisano %s + novih %s = %s dana, a fond dozvoljava %s.',
                      v_year, v_existing, v_new, v_existing + v_new, v_cap);
    END IF;
  END LOOP;

  INSERT INTO work_hours (employee_id, work_date, hours, absence_code, last_edited_by, updated_at)
  SELECT p_employee_id, g.d::date, 0, 'go', p_actor, now()
  FROM generate_series(p_date_from, p_date_to, interval '1 day') g(d)
  WHERE extract(isodow from g.d::date) < 6
    AND NOT EXISTS (
      SELECT 1 FROM kadr_holidays h
       WHERE h.holiday_date = g.d::date AND h.is_workday = false
    )
  ON CONFLICT (employee_id, work_date) DO UPDATE
    SET absence_code  = 'go',
        hours         = 0,
        last_edited_by = EXCLUDED.last_edited_by,
        updated_at    = now()
    WHERE work_hours.absence_code IS NULL OR work_hours.absence_code = 'go';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$
;


-- ============================================================================
-- PRE PRIMENE — obavezna provera koga guard obara
-- ============================================================================
-- 1) Aktivni zaposleni BEZ alokacije za tekuću godinu (fail-closed ih blokira —
--    HR mora prvo upisati fond; na produ ih je bilo 21):
--
--    SELECT e.id, e.full_name
--      FROM employees e
--     WHERE e.is_active
--       AND NOT EXISTS (SELECT 1 FROM vacation_entitlements ve
--                        WHERE ve.employee_id = e.id
--                          AND ve.year = EXTRACT(year FROM CURRENT_DATE)::int)
--     ORDER BY e.full_name;
--
-- 2) Zaposleni koji VEĆ imaju u gridu više 'go' dana nego što fond dozvoljava
--    (guard bi im obarao svaku sledeću izmenu termina — sanirati pre primene):
--
--    SELECT g.employee_id, e.full_name, g.year, g.go_dana,
--           ve.days_total + ve.days_carried_over - ve.opening_used AS fond
--      FROM (SELECT employee_id, extract(year from work_date)::int AS year, count(*) AS go_dana
--              FROM work_hours WHERE absence_code = 'go'
--             GROUP BY 1, 2) g
--      JOIN employees e ON e.id = g.employee_id
--      LEFT JOIN vacation_entitlements ve
--             ON ve.employee_id = g.employee_id AND ve.year = g.year
--     WHERE ve.employee_id IS NULL
--        OR g.go_dana > COALESCE(ve.days_total,0) + COALESCE(ve.days_carried_over,0)
--                       - COALESCE(ve.opening_used,0)
--     ORDER BY e.full_name, g.year;
--
-- 3) Rollback: oba tela su u snapshotu
--    `backend/docs/design/authz-snapshots/talasG-fn-defs-2026-07-12.sql`
--    (hr_vacreq_approve linija 2104, kadr_grid_set_go linija 2971) — vraćanje je
--    CREATE OR REPLACE originalnog teksta.
-- ============================================================================

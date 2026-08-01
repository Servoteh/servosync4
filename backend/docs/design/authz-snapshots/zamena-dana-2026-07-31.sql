-- ============================================================================
-- ZAMENA DANA (rad vikendom → +1 dan GO) — sy15 izmene 31.07.2026
-- Kontekst: incident Nedeljko Stamenić (radio 2 subote; 04.07 nikad nije dobio
-- +1 dan, a bonus dan za 13.06 je bio NEVIDLJIV u koloni „Preostalo" jer se
-- pro-ratira ceo fond). Presuda vlasnika (Nenad, 31.07.2026):
--   1) Kad postoji odobren zahtev „dan_odmora", sati odrađene subote se NE
--      plaćaju (nema duplog: ili sati ili slobodan dan) — fn sama čisti grid.
--   2) Bonus dani se broje kao ODMAH zarađeni (ne pro-rata) — vidljivi u saldu.
-- Primena: docker exec sy15-db psql -U supabase_admin -d postgres < APPLY deo.
--
-- ⚠️ REDOSLED (obavezno): primeniti na sy15 PRE merge-a/deploy-a backenda.
-- Novi makeupApprove OČEKUJE ključ 'hours_cleared' u odgovoru fn — sa starom fn
-- odbija odobrenje tipiziranom greškom (fail-loud umesto tihe duple kompenzacije).
-- ============================================================================

-- ============================== APPLY =======================================

-- (0) Parcijalni UNIQUE na (employee_id, work_date) — zatvara trku duplog granta
--     (dva paralelna odobrenja / dugme + approve istovremeno). PRE primene proveriti
--     duplikate (mora vratiti 0 redova):
--       SELECT employee_id, work_date, count(*) FROM vacation_bonus_days
--        WHERE work_date IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vacation_bonus_days_emp_workdate
  ON public.vacation_bonus_days (employee_id, work_date)
  WHERE work_date IS NOT NULL;

-- (1) v_vacation_balance: bonus dani (vacation_bonus_days) su ODMAH zarađeni.
--     Formula: earned = LEAST(days_total,
--                            ceil((days_total - bonus) * mes_odr/mes_uk) + bonus).
--     Kolone izlaza IDENTIČNE staroj definiciji; security_invoker očuvan.
CREATE OR REPLACE VIEW public.v_vacation_balance
WITH (security_invoker = on) AS
 WITH grid AS (
         SELECT wh.employee_id,
            EXTRACT(year FROM wh.work_date)::integer AS year,
            count(*) FILTER (WHERE wh.work_date <= CURRENT_DATE)::integer AS used_days,
            count(*) FILTER (WHERE wh.work_date > CURRENT_DATE)::integer AS planned_days
           FROM work_hours wh
          WHERE wh.absence_code = 'go'::text
          GROUP BY wh.employee_id, (EXTRACT(year FROM wh.work_date))
        ), bonus AS (
         SELECT b.employee_id,
            b.year,
            COALESCE(sum(b.days), 0)::integer AS bonus_days
           FROM vacation_bonus_days b
          GROUP BY b.employee_id, b.year
        ), base AS (
         SELECT e.id AS employee_id,
            COALESCE(v.year, g.year) AS year,
            COALESCE(v.days_total, 20) AS days_total,
            COALESCE(v.days_carried_over, 0) AS days_carried_over,
            COALESCE(v.opening_used, 0) AS opening_used,
            COALESCE(g.used_days, 0) AS grid_used,
            COALESCE(g.planned_days, 0) AS grid_planned,
            COALESCE(v.accrual_model, false) AS accrual_model,
            COALESCE(v.accrual_base, 20) AS accrual_base,
            COALESCE(v.accrual_start, e.hire_date) AS accrual_start,
            COALESCE(b.bonus_days, 0) AS bonus_days
           FROM employees e
             FULL JOIN vacation_entitlements v ON v.employee_id = e.id
             FULL JOIN grid g ON g.employee_id = e.id AND (v.year IS NULL OR g.year = v.year)
             LEFT JOIN bonus b ON b.employee_id = e.id AND b.year = COALESCE(v.year, g.year)
        ), calc AS (
         SELECT base.employee_id,
            base.year,
            base.days_total,
            base.days_carried_over,
            base.opening_used,
            base.grid_used,
            base.grid_planned,
            base.accrual_model,
            base.accrual_base,
            base.accrual_start,
            base.opening_used + base.grid_used AS days_used,
            base.grid_planned AS days_planned,
            base.opening_used + base.grid_used + base.grid_planned AS days_committed,
            base.days_total + base.days_carried_over - base.opening_used - base.grid_used - base.grid_planned AS days_remaining,
                CASE
                    WHEN base.year IS NULL THEN NULL::integer
                    -- Bonus dani (rad vikendom) su zarađeni ODMAH, ne pro-rata:
                    -- pro-ratira se samo osnova (days_total - bonus), bonus se dodaje ceo.
                    ELSE ( SELECT LEAST(base.days_total,
                                        ceil(GREATEST(0, base.days_total - base.bonus_days)::numeric
                                             * x.mes_odradjeno::numeric / x.mes_ukupno::numeric)::integer
                                        + base.bonus_days) AS "least"
                       FROM ( SELECT 12 - EXTRACT(month FROM s.eff_start)::integer + 1 AS mes_ukupno,
                                GREATEST(0, LEAST(12 - EXTRACT(month FROM s.eff_start)::integer + 1, EXTRACT(year FROM s.as_of)::integer * 12 + EXTRACT(month FROM s.as_of)::integer - (EXTRACT(year FROM s.eff_start)::integer * 12 + EXTRACT(month FROM s.eff_start)::integer) + 1)) AS mes_odradjeno
                               FROM ( SELECT GREATEST(make_date(base.year, 1, 1), COALESCE(base.accrual_start, make_date(base.year, 1, 1))) AS eff_start,
                                        LEAST(CURRENT_DATE, make_date(base.year, 12, 31)) AS as_of) s) x)
                END AS days_earned
           FROM base
        )
 SELECT employee_id,
    year,
    days_total,
    days_carried_over,
    days_used,
    days_remaining,
    opening_used,
    grid_used AS dated_used,
    accrual_model,
    accrual_base,
    accrual_start,
    days_earned,
        CASE
            WHEN accrual_model AND days_earned IS NOT NULL THEN days_committed > days_earned
            ELSE false
        END AS is_advance,
    days_planned,
    days_committed,
    days_carried_over + COALESCE(days_earned, days_total) - days_used - days_planned AS days_remaining_accrued
   FROM calc;

-- (2) kadr_grant_bonus_go: uz grant, ISKLJUČI plaćene sate tog dana (zamena ⊕ sati).
--     Novo u jsonb odgovoru: hours_cleared (koliko grid redova je neutralisano) i
--     already_granted (soft dedup umesto RAISE — postojeći red za isti dan USVAJA
--     link na zahtev ako ga nema, entitlement se NE diže drugi put, a čišćenje
--     sati se SVEJEDNO izvrši; tako se dedup, ručna sanacija i atomski approve
--     slivaju u istu invarijantu „nikad i sati i dan").
--     ⚠️ NE pozivati za dan zaključan 3.0 bravom grida (kadr_grid_day_locks) —
--     fn tu bravu NE VIDI (živi u 3.0 bazi); BE je proverava pre poziva.
CREATE OR REPLACE FUNCTION public.kadr_grant_bonus_go(p_employee_id uuid, p_work_date date, p_days numeric DEFAULT 1, p_reason text DEFAULT ''::text, p_makeup_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_year int; v_actor text; v_id uuid; v_note text; v_cleared int := 0; v_already boolean := false;
BEGIN
  IF NOT (
    public.current_user_can_manage_employee_pii()
    OR public.current_user_is_vacreq_admin()
    OR EXISTS (SELECT 1 FROM public.user_roles ur
                WHERE lower(ur.email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
                  AND ur.role = 'hr' AND ur.is_active)
    -- menadžment: sme SAMO za zaposlene iz svojih pododeljenja
    OR EXISTS (SELECT 1 FROM public.user_roles ur
                JOIN public.employees emp ON emp.id = p_employee_id
                WHERE lower(ur.email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
                  AND ur.role = 'menadzment' AND ur.is_active
                  AND emp.sub_department_id IS NOT NULL
                  AND ur.managed_sub_department_ids @> ARRAY[emp.sub_department_id])
  ) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_days IS NULL OR p_days <= 0 OR p_days > 5 THEN RAISE EXCEPTION 'invalid_days'; END IF;
  v_year := EXTRACT(year FROM COALESCE(p_work_date, CURRENT_DATE))::int;
  v_actor := lower(COALESCE(auth.jwt() ->> 'email', 'system'));

  -- Dedup po (employee_id, work_date) preko parcijalnog unique indeksa (trka-bezbedno):
  -- postojeći red za isti dan → v_id ostaje NULL → soft grana (bez duplog entitlementa).
  INSERT INTO vacation_bonus_days (employee_id, year, days, work_date, reason, makeup_request_id, added_by)
  VALUES (p_employee_id, v_year, p_days, p_work_date, COALESCE(p_reason, ''), p_makeup_request_id, v_actor)
  ON CONFLICT (employee_id, work_date) WHERE work_date IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL AND p_work_date IS NOT NULL THEN
    v_already := true;
    -- Usvoji link na zahtev ako postojeći (npr. ručni) red nema — bedž
    -- bonus_granted prestaje večno da tvrdi „dan NIJE upisan".
    UPDATE vacation_bonus_days
       SET makeup_request_id = COALESCE(makeup_request_id, p_makeup_request_id)
     WHERE employee_id = p_employee_id AND work_date = p_work_date;
  ELSE
    v_note := format(' | +%s dan GO za rad vikendom%s (%s; dodao %s %s)',
      p_days, CASE WHEN p_work_date IS NOT NULL THEN ' ' || to_char(p_work_date, 'DD.MM.YYYY') ELSE '' END,
      NULLIF(p_reason, ''), v_actor, to_char(CURRENT_DATE, 'DD.MM.YYYY'));

    UPDATE vacation_entitlements SET
      days_total = days_total + p_days,
      note = COALESCE(note, '') || v_note,
      updated_at = now()
    WHERE employee_id = p_employee_id AND year = v_year;
    IF NOT FOUND THEN
      INSERT INTO vacation_entitlements (employee_id, year, days_total, days_carried_over, opening_used, source, note)
      VALUES (p_employee_id, v_year, 20 + p_days, 0, 0, 'manual_' || v_year, 'Osnova 20.' || v_note);
    END IF;
  END IF;

  -- NOVO 31.07.2026 (presuda vlasnika): zamena dana ISKLJUČUJE plaćene sate za
  -- odrađeni vikend-dan — ili sati ili slobodan dan, nikad oboje. Izvršava se i
  -- u already_granted grani (legacy grant stare fn nije brisao sate). SECURITY
  -- DEFINER prolazi RLS na work_hours; dira SAMO taj dan i SAMO radne sate
  -- (redove sa absence_code ne dira; idempotentno — red na 0h se ne dira ponovo).
  IF p_work_date IS NOT NULL THEN
    UPDATE work_hours wh SET
      hours = 0, overtime_hours = 0, two_machine_hours = 0, field_hours = 0,
      note = CASE WHEN COALESCE(wh.note, '') = ''
                  THEN 'zamena dana — sati kompenzovani slobodnim danom (+1 dan GO)'
                  ELSE wh.note || ' | zamena dana — sati kompenzovani slobodnim danom (+1 dan GO)' END,
      last_edited_by = v_actor,
      updated_at = now()
    WHERE wh.employee_id = p_employee_id AND wh.work_date = p_work_date
      AND wh.absence_code IS NULL
      AND (wh.hours > 0 OR wh.overtime_hours > 0 OR wh.two_machine_hours > 0 OR wh.field_hours > 0);
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('ok', true, 'bonus_id', v_id, 'year', v_year,
    'already_granted', v_already, 'hours_cleared', v_cleared);
END;
$function$;

-- ============================== ROLLBACK ====================================
-- Indeks: DROP INDEX IF EXISTS public.uq_vacation_bonus_days_emp_workdate;
--   (bezbedan za ostaviti i pri rollbacku fn — stara fn ga ne koristi.)
-- Pune STARE definicije (pg_get_viewdef / pg_get_functiondef, 31.07.2026 pre
-- izmene). Za rollback: odkomentarisati i izvršiti.
--
-- CREATE OR REPLACE VIEW public.v_vacation_balance WITH (security_invoker = on) AS
--  WITH grid AS (
--          SELECT wh.employee_id,
--             EXTRACT(year FROM wh.work_date)::integer AS year,
--             count(*) FILTER (WHERE wh.work_date <= CURRENT_DATE)::integer AS used_days,
--             count(*) FILTER (WHERE wh.work_date > CURRENT_DATE)::integer AS planned_days
--            FROM work_hours wh
--           WHERE wh.absence_code = 'go'::text
--           GROUP BY wh.employee_id, (EXTRACT(year FROM wh.work_date))
--         ), base AS (
--          SELECT e.id AS employee_id,
--             COALESCE(v.year, g.year) AS year,
--             COALESCE(v.days_total, 20) AS days_total,
--             COALESCE(v.days_carried_over, 0) AS days_carried_over,
--             COALESCE(v.opening_used, 0) AS opening_used,
--             COALESCE(g.used_days, 0) AS grid_used,
--             COALESCE(g.planned_days, 0) AS grid_planned,
--             COALESCE(v.accrual_model, false) AS accrual_model,
--             COALESCE(v.accrual_base, 20) AS accrual_base,
--             COALESCE(v.accrual_start, e.hire_date) AS accrual_start
--            FROM employees e
--              FULL JOIN vacation_entitlements v ON v.employee_id = e.id
--              FULL JOIN grid g ON g.employee_id = e.id AND (v.year IS NULL OR g.year = v.year)
--         ), calc AS (
--          SELECT base.*,
--             base.opening_used + base.grid_used AS days_used,
--             base.grid_planned AS days_planned,
--             base.opening_used + base.grid_used + base.grid_planned AS days_committed,
--             base.days_total + base.days_carried_over - base.opening_used - base.grid_used - base.grid_planned AS days_remaining,
--                 CASE
--                     WHEN base.year IS NULL THEN NULL::integer
--                     ELSE ( SELECT LEAST(base.days_total, ceil(base.days_total::numeric * x.mes_odradjeno::numeric / x.mes_ukupno::numeric)::integer)
--                        FROM ( SELECT 12 - EXTRACT(month FROM s.eff_start)::integer + 1 AS mes_ukupno,
--                                 GREATEST(0, LEAST(12 - EXTRACT(month FROM s.eff_start)::integer + 1, EXTRACT(year FROM s.as_of)::integer * 12 + EXTRACT(month FROM s.as_of)::integer - (EXTRACT(year FROM s.eff_start)::integer * 12 + EXTRACT(month FROM s.eff_start)::integer) + 1)) AS mes_odradjeno
--                                FROM ( SELECT GREATEST(make_date(base.year, 1, 1), COALESCE(base.accrual_start, make_date(base.year, 1, 1))) AS eff_start,
--                                         LEAST(CURRENT_DATE, make_date(base.year, 12, 31)) AS as_of) s) x)
--                 END AS days_earned
--            FROM base
--         )
--  SELECT employee_id, year, days_total, days_carried_over, days_used, days_remaining,
--     opening_used, grid_used AS dated_used, accrual_model, accrual_base, accrual_start,
--     days_earned,
--         CASE WHEN accrual_model AND days_earned IS NOT NULL THEN days_committed > days_earned ELSE false END AS is_advance,
--     days_planned, days_committed,
--     days_carried_over + COALESCE(days_earned, days_total) - days_used - days_planned AS days_remaining_accrued
--    FROM calc;
--
-- Stara funkcija (razlike u odnosu na APPLY verziju):
--   * tvrdi dedup: IF p_work_date IS NOT NULL AND EXISTS (SELECT 1 FROM
--     vacation_bonus_days b WHERE b.employee_id=p_employee_id AND
--     b.work_date=p_work_date) THEN RAISE EXCEPTION 'already_granted'; END IF;
--   * goli INSERT ... RETURNING id INTO v_id (bez ON CONFLICT, bez v_already);
--   * entitlement bump BEZUSLOVNO (nema soft grane);
--   * BEZ bloka „NOVO 31.07.2026" (UPDATE work_hours / v_cleared);
--   * RETURN jsonb_build_object('ok', true, 'bonus_id', v_id, 'year', v_year);

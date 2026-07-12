-- AUTHZ/RPC SNAPSHOT: TALAS G — Kadrovska (HR) — snimljeno 2026-07-12
-- Izvor: zamrznuti cloud = restore-izvor sy15. Re-verifikovati na zivoj sy15 pre R1 (doktrina A5).
-- 119 funkcija (kadr_* / hr_* / attendance_* / assessment_* / talk_* / makeup/paid_leave/nop + current_user_* helperi).
-- Front-facing podskup (~50) vs pozadina (cron scheduleri, dispatch queue, trigeri) — razvrstano u MODULE_SPEC_kadrovska_30.md §0.
-- Dodatak na kraju: definicije kanonskih view-ova (v_employees_safe, v_vacation_balance, v_attendance_*, v_salary_*, ...).

-- ============ absences_archive_guard ============
CREATE OR REPLACE FUNCTION public.absences_archive_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Okida se samo kad se archived_at/archived_by menja (WHEN klauzula nize).
  IF NOT (public.current_user_is_admin() OR public.current_user_is_hr()) THEN
    RAISE EXCEPTION 'permission_denied: arhiviranje odsustva sme samo HR ili administrator'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ ai_chat_can_view_employee ============
CREATE OR REPLACE FUNCTION public.ai_chat_can_view_employee(p_emp_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select p_emp_id is not null and (
    p_emp_id = public.current_user_employee_id()
    or public.current_user_manages_employee(p_emp_id)
  );
$function$
;

-- ============ approve_nop_request ============
CREATE OR REPLACE FUNCTION public.approve_nop_request(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_req nop_requests%rowtype; v_actor text; v_abs_id uuid;
begin
  if not public.current_user_is_admin() then
    raise exception 'permission_denied' using errcode='42501', hint='Neplaćeno može da odobri samo administrator (Nenad ili Nevena).';
  end if;
  v_actor := lower(coalesce(auth.jwt()->>'email',''));

  update nop_requests set status='approved', reviewed_by=v_actor, reviewed_at=now()
   where id=p_request_id and status='pending' returning * into v_req;
  if not found then
    return jsonb_build_object('status','already_processed','request_id',p_request_id);
  end if;

  -- upiši 'nop' u work_hours (upsert po emp+datum), nuluj radne sate tog dana
  insert into work_hours (employee_id, work_date, hours, absence_code, last_edited_by, updated_at)
  values (v_req.employee_id, v_req.work_date, 0, 'nop', v_actor, now())
  on conflict (employee_id, work_date) do update
    set absence_code='nop', hours=0, last_edited_by=v_actor, updated_at=now();

  -- evidencija u absences (type=neplaceno) ako ne postoji za taj dan
  if not exists (select 1 from absences a where a.employee_id=v_req.employee_id
                 and a.type='neplaceno' and a.date_from=v_req.work_date and a.date_to=v_req.work_date) then
    insert into absences (employee_id, type, date_from, date_to, days_count, note)
    values (v_req.employee_id, 'neplaceno', v_req.work_date, v_req.work_date, 1,
            'Neplaćeno — odobrio ' || v_actor)
    returning id into v_abs_id;
  end if;

  return jsonb_build_object('status','approved','request_id',p_request_id,'absence_id',v_abs_id,'reviewed_by',v_actor);
end; $function$
;

-- ============ assessment_close ============
CREATE OR REPLACE FUNCTION public.assessment_close(p_assessment uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT assessment_set_state(p_assessment,'closed',NULL); $function$
;

-- ============ assessment_compute_results ============
CREATE OR REPLACE FUNCTION public.assessment_compute_results(p_assessment uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM assessments WHERE id = p_assessment) THEN RETURN; END IF;
  DELETE FROM assessment_results WHERE assessment_id = p_assessment;
  INSERT INTO assessment_results (assessment_id, scope_kind, ref_id, self_avg, peer_avg, peer_count, leader_val, target_val)
  SELECT p_assessment, 'competence', c.id,
    (SELECT round(avg(s.level),2) FROM assessment_scores s JOIN assessment_raters r ON r.id=s.rater_id
       WHERE r.assessment_id=p_assessment AND r.rater_kind='self'   AND s.competence_id=c.id AND s.level IS NOT NULL),
    -- peer_avg samo ako je bar 2 peer-a ocenilo (k-anonimnost)
    (SELECT CASE WHEN count(DISTINCT r.id) >= 2 THEN round(avg(s.level),2) END
       FROM assessment_scores s JOIN assessment_raters r ON r.id=s.rater_id
       WHERE r.assessment_id=p_assessment AND r.rater_kind='peer'   AND s.competence_id=c.id AND s.level IS NOT NULL),
    (SELECT count(DISTINCT r.id) FROM assessment_scores s JOIN assessment_raters r ON r.id=s.rater_id
       WHERE r.assessment_id=p_assessment AND r.rater_kind='peer'   AND s.competence_id=c.id AND s.level IS NOT NULL),
    (SELECT round(avg(s.level),2) FROM assessment_scores s JOIN assessment_raters r ON r.id=s.rater_id
       WHERE r.assessment_id=p_assessment AND r.rater_kind='leader' AND s.competence_id=c.id AND s.level IS NOT NULL),
    (SELECT t.target_level FROM assessment_targets t WHERE t.assessment_id=p_assessment AND t.competence_id=c.id)
  FROM assessments a
  JOIN profile_groups pg ON pg.profile_id=a.profile_id
  JOIN competences c ON c.group_id=pg.group_id AND c.is_active
  WHERE a.id=p_assessment;

  INSERT INTO assessment_results (assessment_id, scope_kind, ref_id, self_avg, peer_avg, peer_count, leader_val, target_val)
  SELECT p_assessment, 'group', g.id,
    round(avg(cr.self_avg),2), round(avg(cr.peer_avg),2), COALESCE(max(cr.peer_count),0),
    round(avg(cr.leader_val),2), round(avg(cr.target_val),2)
  FROM assessments a
  JOIN profile_groups pg ON pg.profile_id=a.profile_id
  JOIN competence_groups g ON g.id=pg.group_id
  JOIN competences c ON c.group_id=g.id AND c.is_active
  LEFT JOIN assessment_results cr ON cr.assessment_id=p_assessment AND cr.scope_kind='competence' AND cr.ref_id=c.id
  WHERE a.id=p_assessment
  GROUP BY g.id;
END; $function$
;

-- ============ assessment_gap_to_goals ============
CREATE OR REPLACE FUNCTION public.assessment_gap_to_goals(p_assessment uuid, p_source text DEFAULT 'leader'::text, p_min_gap numeric DEFAULT 1)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_emp uuid; v_plan uuid; v_email text; v_cnt int := 0; rec record; v_cat text; v_cur numeric;
BEGIN
  SELECT employee_id, plan_id INTO v_emp, v_plan FROM assessments WHERE id=p_assessment;
  IF v_emp IS NULL OR NOT current_user_can_manage_assessment(v_emp) THEN RAISE EXCEPTION 'Nije dozvoljeno.'; END IF;
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  PERFORM assessment_compute_results(p_assessment);
  FOR rec IN
    SELECT c.id comp_id, c.name_sr comp_name, g.scope, ar.target_val,
           COALESCE(CASE WHEN p_source='self' THEN ar.self_avg ELSE ar.leader_val END, ar.self_avg) AS cur_val
    FROM assessment_results ar
    JOIN competences c ON c.id=ar.ref_id AND ar.scope_kind='competence'
    JOIN competence_groups g ON g.id=c.group_id
    WHERE ar.assessment_id=p_assessment AND ar.target_val IS NOT NULL
  LOOP
    v_cur := rec.cur_val;
    IF v_cur IS NULL THEN CONTINUE; END IF;
    IF (rec.target_val - v_cur) < p_min_gap THEN CONTINUE; END IF;
    v_cat := CASE rec.scope WHEN 'strucna' THEN 'strucni' WHEN 'liderska' THEN 'liderstvo' ELSE 'soft_skill' END;
    IF EXISTS (SELECT 1 FROM employee_expectations e WHERE e.employee_id=v_emp AND e.title=('Razvoj: '||rec.comp_name) AND (e.plan_id IS NOT DISTINCT FROM v_plan)) THEN CONTINUE; END IF;
    INSERT INTO employee_expectations (employee_id, plan_id, title, description_md, priority, status, category, progress, created_by)
    VALUES (v_emp, v_plan, 'Razvoj: '||rec.comp_name,
            format('Iz 360° procene: trenutni nivo **%s**, ciljni **%s**. Podići kompetenciju „%s".', round(v_cur,1), rec.target_val, rec.comp_name),
            CASE WHEN (rec.target_val - v_cur) >= 2 THEN 'visoka' ELSE 'srednja' END, 'aktivno', v_cat, 0, v_email);
    v_cnt := v_cnt + 1;
  END LOOP;
  RETURN v_cnt;
END; $function$
;

-- ============ assessment_open_360 ============
CREATE OR REPLACE FUNCTION public.assessment_open_360(p_employee uuid, p_period text DEFAULT NULL::text, p_peer_employee_ids uuid[] DEFAULT '{}'::uuid[], p_peer_emails text[] DEFAULT '{}'::text[], p_cycle uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_email text; v_period text; v_profile int; v_aid uuid; v_pos int; v_emp_email text; pid uuid; pem text;
BEGIN
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  IF NOT current_user_can_manage_assessment(p_employee) THEN
    RAISE EXCEPTION 'Nemate pravo da otvorite procenu za ovog zaposlenog (svoju procenu vodi nadređeni/HR).';
  END IF;
  SELECT position_id, lower(email) INTO v_pos, v_emp_email FROM employees WHERE id = p_employee;
  v_period := coalesce(nullif(trim(p_period),''), to_char(now(),'YYYY'));
  SELECT profile_id INTO v_profile FROM profile_positions WHERE position_id = v_pos LIMIT 1;
  SELECT id INTO v_aid FROM assessments WHERE employee_id=p_employee AND period_label=v_period ORDER BY created_at LIMIT 1;
  IF v_aid IS NULL THEN
    INSERT INTO assessments (cycle_id, employee_id, profile_id, period_label, status, opened_by)
    VALUES (p_cycle, p_employee, v_profile, v_period, 'collecting', v_email) RETURNING id INTO v_aid;
  ELSE
    UPDATE assessments SET profile_id=COALESCE(profile_id,v_profile), cycle_id=COALESCE(cycle_id,p_cycle), status='collecting' WHERE id=v_aid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM assessment_raters WHERE assessment_id=v_aid AND rater_kind='self') THEN
    INSERT INTO assessment_raters (assessment_id, rater_kind, rater_employee_id, rater_email, token, status)
    VALUES (v_aid, 'self', p_employee, v_emp_email, _assessment_new_token(), 'pending');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM assessment_raters WHERE assessment_id=v_aid AND rater_kind='leader') THEN
    INSERT INTO assessment_raters (assessment_id, rater_kind, rater_employee_id, rater_email, status)
    VALUES (v_aid, 'leader', current_user_employee_id(), v_email, 'pending');
  END IF;
  FOREACH pid IN ARRAY COALESCE(p_peer_employee_ids,'{}') LOOP
    IF pid IS NOT NULL AND pid <> p_employee AND pid IS DISTINCT FROM current_user_employee_id()
       AND NOT EXISTS (SELECT 1 FROM assessment_raters WHERE assessment_id=v_aid AND rater_employee_id=pid) THEN
      INSERT INTO assessment_raters (assessment_id, rater_kind, rater_employee_id, rater_email, token, status)
      VALUES (v_aid, 'peer', pid, (SELECT lower(email) FROM employees WHERE id=pid), _assessment_new_token(), 'pending');
    END IF;
  END LOOP;
  FOREACH pem IN ARRAY COALESCE(p_peer_emails,'{}') LOOP
    IF nullif(trim(pem),'') IS NOT NULL
       AND lower(trim(pem)) <> COALESCE(v_emp_email,'') AND lower(trim(pem)) <> v_email
       AND NOT EXISTS (SELECT 1 FROM assessment_raters WHERE assessment_id=v_aid AND lower(rater_email)=lower(trim(pem))) THEN
      INSERT INTO assessment_raters (assessment_id, rater_kind, rater_email, token, status)
      VALUES (v_aid, 'peer', lower(trim(pem)), _assessment_new_token(), 'pending');
    END IF;
  END LOOP;
  RETURN v_aid;
END; $function$
;

-- ============ assessment_open_campaign ============
CREATE OR REPLACE FUNCTION public.assessment_open_campaign(p_title text, p_period text, p_employee_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_email text; v_cycle uuid; v_period text; eid uuid; v_profile int; v_pos int; v_emp_email text; v_aid uuid;
BEGIN
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  IF NOT (current_user_can_manage_org_profile() OR current_user_is_admin()) THEN
    RAISE EXCEPTION 'Samo HR/menadžment otvara kampanju.'; END IF;
  v_period := coalesce(nullif(trim(p_period),''), to_char(now(),'YYYY'));
  INSERT INTO assessment_cycles (title, period_label, status, created_by)
  VALUES (coalesce(nullif(trim(p_title),''),'360° '||v_period), v_period, 'open', v_email)
  RETURNING id INTO v_cycle;

  FOREACH eid IN ARRAY COALESCE(p_employee_ids,'{}') LOOP
    IF eid IS NULL THEN CONTINUE; END IF;
    SELECT position_id, lower(email) INTO v_pos, v_emp_email FROM employees WHERE id=eid;
    SELECT profile_id INTO v_profile FROM profile_positions WHERE position_id=v_pos LIMIT 1;
    SELECT id INTO v_aid FROM assessments WHERE employee_id=eid AND period_label=v_period ORDER BY created_at LIMIT 1;
    IF v_aid IS NULL THEN
      INSERT INTO assessments (cycle_id, employee_id, profile_id, period_label, status, opened_by)
      VALUES (v_cycle, eid, v_profile, v_period, 'collecting', v_email) RETURNING id INTO v_aid;
    ELSE
      UPDATE assessments SET cycle_id=COALESCE(cycle_id,v_cycle), profile_id=COALESCE(profile_id,v_profile) WHERE id=v_aid;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM assessment_raters WHERE assessment_id=v_aid AND rater_kind='self') THEN
      INSERT INTO assessment_raters (assessment_id, rater_kind, rater_employee_id, rater_email, token, status)
      VALUES (v_aid, 'self', eid, v_emp_email, _assessment_new_token(), 'pending');
    END IF;
  END LOOP;
  RETURN v_cycle;
END; $function$
;

-- ============ assessment_open_self ============
CREATE OR REPLACE FUNCTION public.assessment_open_self(p_period text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_emp uuid; v_email text; v_period text; v_profile int; v_aid uuid; v_pos int;
BEGIN
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  SELECT id, position_id INTO v_emp, v_pos FROM employees WHERE lower(email) = v_email LIMIT 1;
  IF v_emp IS NULL THEN RAISE EXCEPTION 'Vaš zaposleni profil nije pronađen.'; END IF;
  v_period := coalesce(nullif(trim(p_period), ''), to_char(now(), 'YYYY'));
  SELECT profile_id INTO v_profile FROM profile_positions WHERE position_id = v_pos LIMIT 1;

  SELECT id INTO v_aid FROM assessments
   WHERE employee_id = v_emp AND period_label = v_period ORDER BY created_at LIMIT 1;
  IF v_aid IS NULL THEN
    INSERT INTO assessments (employee_id, profile_id, period_label, status, opened_by)
    VALUES (v_emp, v_profile, v_period, 'collecting', v_email)
    RETURNING id INTO v_aid;
  ELSIF v_profile IS NOT NULL THEN
    UPDATE assessments SET profile_id = COALESCE(profile_id, v_profile) WHERE id = v_aid;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM assessment_raters WHERE assessment_id = v_aid AND rater_kind = 'self') THEN
    INSERT INTO assessment_raters (assessment_id, rater_kind, rater_employee_id, rater_email, status)
    VALUES (v_aid, 'self', v_emp, v_email, 'pending');
  END IF;
  RETURN v_aid;
END; $function$
;

-- ============ assessment_reopen ============
CREATE OR REPLACE FUNCTION public.assessment_reopen(p_assessment uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT assessment_set_state(p_assessment,'collecting',NULL); $function$
;

-- ============ assessment_self_submit ============
CREATE OR REPLACE FUNCTION public.assessment_self_submit(p_assessment uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_email text; v_emp uuid;
BEGIN
  v_email := lower(coalesce(auth.jwt() ->> 'email',''));
  v_emp := current_user_employee_id();
  UPDATE assessment_raters SET status = 'submitted', submitted_at = now()
   WHERE assessment_id = p_assessment
     AND (lower(rater_email) = v_email OR rater_employee_id = v_emp);
  PERFORM assessment_compute_results(p_assessment);
END; $function$
;

-- ============ assessment_set_state ============
CREATE OR REPLACE FUNCTION public.assessment_set_state(p_assessment uuid, p_status text, p_visible boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_emp uuid;
BEGIN
  SELECT employee_id INTO v_emp FROM assessments WHERE id=p_assessment;
  IF v_emp IS NULL OR NOT current_user_can_manage_assessment(v_emp) THEN RAISE EXCEPTION 'Nije dozvoljeno.'; END IF;
  UPDATE assessments SET status=COALESCE(p_status,status), visible_to_employee=COALESCE(p_visible,visible_to_employee) WHERE id=p_assessment;
  PERFORM assessment_compute_results(p_assessment);
END; $function$
;

-- ============ assessment_set_targets ============
CREATE OR REPLACE FUNCTION public.assessment_set_targets(p_assessment uuid, p_targets jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_emp uuid; rec record;
BEGIN
  SELECT employee_id INTO v_emp FROM assessments WHERE id=p_assessment;
  IF v_emp IS NULL OR NOT current_user_can_manage_assessment(v_emp) THEN RAISE EXCEPTION 'Nije dozvoljeno.'; END IF;
  FOR rec IN SELECT * FROM jsonb_to_recordset(p_targets) AS x(competence_id int, target_level int) LOOP
    INSERT INTO assessment_targets (assessment_id, competence_id, target_level)
    VALUES (p_assessment, rec.competence_id, rec.target_level)
    ON CONFLICT (assessment_id, competence_id) DO UPDATE SET target_level=EXCLUDED.target_level;
  END LOOP;
  PERFORM assessment_compute_results(p_assessment);
END; $function$
;

-- ============ assessment_share ============
CREATE OR REPLACE FUNCTION public.assessment_share(p_assessment uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT assessment_set_state(p_assessment,'shared',true); $function$
;

-- ============ assessment_submit_by_token ============
CREATE OR REPLACE FUNCTION public.assessment_submit_by_token(p_token text, p_scores jsonb, p_answers jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rid uuid; v_aid uuid; v_status text; rec record;
BEGIN
  SELECT r.id, r.assessment_id INTO v_rid, v_aid FROM assessment_raters r WHERE r.token = p_token;
  IF v_rid IS NULL THEN RAISE EXCEPTION 'Neispravan ili istekao link.'; END IF;
  SELECT status INTO v_status FROM assessments WHERE id=v_aid;
  IF v_status NOT IN ('collecting','draft') THEN RAISE EXCEPTION 'Procena je zatvorena.'; END IF;

  FOR rec IN SELECT * FROM jsonb_to_recordset(p_scores) AS x(competence_id int, level int, comment text) LOOP
    -- samo kompetencije iz opsega procene
    IF EXISTS (SELECT 1 FROM v_assessment_scope vs WHERE vs.assessment_id=v_aid AND vs.competence_id=rec.competence_id) THEN
      INSERT INTO assessment_scores (rater_id, competence_id, level, comment)
      VALUES (v_rid, rec.competence_id, rec.level, rec.comment)
      ON CONFLICT (rater_id, competence_id) DO UPDATE SET level=EXCLUDED.level, comment=EXCLUDED.comment;
    END IF;
  END LOOP;
  FOR rec IN SELECT * FROM jsonb_to_recordset(p_answers) AS x(question_code text, answer_text text) LOOP
    INSERT INTO assessment_answers (rater_id, question_code, answer_text)
    VALUES (v_rid, rec.question_code, rec.answer_text)
    ON CONFLICT (rater_id, question_code) DO UPDATE SET answer_text=EXCLUDED.answer_text;
  END LOOP;

  UPDATE assessment_raters SET status='submitted', submitted_at=now() WHERE id=v_rid;
  PERFORM assessment_compute_results(v_aid);
  RETURN jsonb_build_object('ok', true);
END; $function$
;

-- ============ assessment_token_context ============
CREATE OR REPLACE FUNCTION public.assessment_token_context(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_rid uuid; v_aid uuid; v_kind text; v_status text; v_emp_name text; v_period text; v_result jsonb;
BEGIN
  SELECT r.id, r.assessment_id, r.rater_kind INTO v_rid, v_aid, v_kind FROM assessment_raters r WHERE r.token=p_token;
  IF v_rid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'Neispravan link.'); END IF;
  SELECT a.status, a.period_label, e.full_name INTO v_status, v_period, v_emp_name
    FROM assessments a JOIN employees e ON e.id=a.employee_id WHERE a.id=v_aid;

  SELECT jsonb_build_object(
    'ok', true, 'rater_kind', v_kind, 'status', v_status, 'period', v_period,
    'employee_name', CASE WHEN v_kind='self' THEN 'sebe' ELSE v_emp_name END,
    'scope', (SELECT jsonb_agg(jsonb_build_object(
        'group_id', s.group_id, 'group_name', s.group_name, 'scope', s.scope,
        'competence_id', s.competence_id, 'competence_name', s.competence_name,
        'levels', (SELECT jsonb_agg(jsonb_build_object('level', l.level, 'descriptor', l.descriptor_sr) ORDER BY l.level)
                   FROM competence_levels l WHERE l.competence_id=s.competence_id))
        ORDER BY s.group_sort, s.comp_sort)
      FROM v_assessment_scope s WHERE s.assessment_id=v_aid),
    'questions', (SELECT jsonb_agg(jsonb_build_object('code', q.code, 'text', q.text_sr, 'group_id', q.group_id) ORDER BY q.group_id NULLS FIRST, q.sort_order)
      FROM competence_questions q WHERE q.is_active AND (q.group_id IS NULL OR q.group_id IN
        (SELECT DISTINCT group_id FROM v_assessment_scope WHERE assessment_id=v_aid))),
    'existing', (SELECT jsonb_object_agg(s.competence_id::text, jsonb_build_object('level', s.level, 'comment', s.comment))
      FROM assessment_scores s WHERE s.rater_id=v_rid)
  ) INTO v_result;
  RETURN v_result;
END; $function$
;

-- ============ assessment_unshare ============
CREATE OR REPLACE FUNCTION public.assessment_unshare(p_assessment uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT assessment_set_state(p_assessment,NULL,false); $function$
;

-- ============ attendance_cancel_correction ============
CREATE OR REPLACE FUNCTION public.attendance_cancel_correction(p_correction_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller text := lower(COALESCE(auth.jwt() ->> 'email', ''));
  v_corr record;
BEGIN
  SELECT * INTO v_corr FROM public.attendance_corrections WHERE id = p_correction_id;
  IF v_corr.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nepoznata_korekcija');
  END IF;
  IF v_corr.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vec_ponistena');
  END IF;
  IF NOT (public.current_user_manages_employee(v_corr.employee_id) OR public.current_user_is_hr_or_admin()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nema_prava');
  END IF;

  DELETE FROM public.attendance_events WHERE id = ANY (v_corr.event_ids);
  UPDATE public.attendance_corrections
     SET status = 'cancelled', cancelled_by = v_caller, cancelled_at = now()
   WHERE id = p_correction_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$
;

-- ============ attendance_extra_recipients ============
CREATE OR REPLACE FUNCTION public.attendance_extra_recipients(p_employee_id uuid)
 RETURNS TABLE(email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DISTINCT lower(x.email)
  FROM public.employees e
  JOIN public.attendance_notify_extra x
    ON x.sub_department_id = e.sub_department_id
    OR (x.sub_department_id IS NULL AND e.sub_department_id IS NULL)
  WHERE e.id = p_employee_id
    AND x.email IS NOT NULL AND x.email <> '';
$function$
;

-- ============ attendance_fill_event_ts ============
CREATE OR REPLACE FUNCTION public.attendance_fill_event_ts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.event_ts_local IS NOT NULL THEN
    NEW.event_ts := NEW.event_ts_local AT TIME ZONE 'Europe/Belgrade';
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ attendance_katze_max_idreg ============
CREATE OR REPLACE FUNCTION public.attendance_katze_max_idreg()
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(MAX(external_id::bigint), 0)
  FROM public.attendance_events
  WHERE source IN ('katze','katze_manual');
$function$
;

-- ============ attendance_submit_correction ============
CREATE OR REPLACE FUNCTION public.attendance_submit_correction(p_employee_id uuid, p_day date, p_in time without time zone DEFAULT NULL::time without time zone, p_out time without time zone DEFAULT NULL::time without time zone, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller text := lower(COALESCE(auth.jwt() ->> 'email', ''));
  v_is_self boolean;
  v_is_mgr boolean;
  v_is_hr boolean;
  v_today date := (now() AT TIME ZONE 'Europe/Belgrade')::date;
  v_emp_name text;
  v_corr_id uuid := gen_random_uuid();
  v_ids bigint[] := '{}';
  v_id bigint;
  v_has_in boolean;
  v_open int;
  v_sef record;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) < 5 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'obrazlozenje_obavezno');
  END IF;
  IF p_in IS NULL AND p_out IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nema_vremena');
  END IF;
  IF p_in IS NOT NULL AND p_out IS NOT NULL AND p_in >= p_out THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ulaz_posle_izlaza');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.id = p_employee_id AND lower(COALESCE(e.email,'')) = v_caller AND COALESCE(e.email,'') <> ''
  ) INTO v_is_self;
  v_is_mgr := public.current_user_manages_employee(p_employee_id);
  v_is_hr := public.current_user_is_hr_or_admin();
  IF NOT (v_is_self OR v_is_mgr OR v_is_hr) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nema_prava');
  END IF;

  IF p_day > v_today THEN
    RETURN jsonb_build_object('ok', false, 'error', 'buducnost');
  END IF;
  IF NOT v_is_hr AND p_day < v_today - 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'prekasno');
  END IF;

  SELECT full_name INTO v_emp_name FROM public.employees WHERE id = p_employee_id AND is_active;
  IF v_emp_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'nepoznat_zaposleni');
  END IF;

  IF EXISTS (SELECT 1 FROM public.attendance_corrections c
             WHERE c.employee_id = p_employee_id AND c.day = p_day AND c.status = 'active') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'vec_korigovano');
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.attendance_events ae
    WHERE ae.employee_id = p_employee_id AND ae.event_ts_local::date = p_day AND ae.direction = 'in'
  ) INTO v_has_in;
  SELECT COALESCE(d.open_intervals, 0) INTO v_open
  FROM public.v_attendance_daily d
  WHERE d.employee_id = p_employee_id AND d.day = p_day;

  IF p_in IS NOT NULL AND v_has_in THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ulaz_postoji');
  END IF;
  IF p_out IS NOT NULL AND v_has_in AND COALESCE(v_open, 0) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'izlaz_postoji');
  END IF;

  IF p_in IS NOT NULL THEN
    INSERT INTO public.attendance_events
      (source, external_id, employee_id, event_ts_local, direction, terminal_name, raw)
    VALUES ('manual', 'corr-' || v_corr_id || '-in', p_employee_id, p_day + p_in, 'in',
            'Korekcija', jsonb_build_object('correction_id', v_corr_id, 'reason', btrim(p_reason), 'entered_by', v_caller))
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END IF;
  IF p_out IS NOT NULL THEN
    INSERT INTO public.attendance_events
      (source, external_id, employee_id, event_ts_local, direction, terminal_name, raw)
    VALUES ('manual', 'corr-' || v_corr_id || '-out', p_employee_id, p_day + p_out, 'out',
            'Korekcija', jsonb_build_object('correction_id', v_corr_id, 'reason', btrim(p_reason), 'entered_by', v_caller))
    RETURNING id INTO v_id;
    v_ids := v_ids || v_id;
  END IF;

  INSERT INTO public.attendance_corrections
    (id, employee_id, day, corrected_in, corrected_out, reason, created_by, created_for_self, event_ids)
  VALUES (v_corr_id, p_employee_id, p_day, p_in, p_out, btrim(p_reason), v_caller, v_is_self, v_ids);

  -- obavesti šefa + dopunske primaoce (Zoran/Vladan za pododeljenja bez šefa);
  -- preskoči unosioca
  FOR v_sef IN
    SELECT DISTINCT t.email FROM (
      SELECT r.email FROM public.kadr_oversight_recipients(p_employee_id) r WHERE r.role_label = 'sef'
      UNION
      SELECT x.email FROM public.attendance_extra_recipients(p_employee_id) x
    ) t
    WHERE t.email <> v_caller
  LOOP
    INSERT INTO public.kadr_notification_log
      (channel, recipient, subject, body, related_entity_type, related_entity_id,
       employee_id, notification_type, status, scheduled_at, payload)
    VALUES ('email', v_sef.email,
      'Korekcija prisustva — ' || v_emp_name || ' (' || to_char(p_day, 'DD.MM.YYYY.') || ')',
      '<div style="font-family:sans-serif;max-width:560px">'
      || '<h3 style="color:#b7791f">✎ Korekcija prisustva</h3>'
      || '<p><strong>' || v_emp_name || '</strong> — ' || to_char(p_day, 'DD.MM.YYYY.') || '</p>'
      || '<p>' || COALESCE('Ulaz: <strong>' || to_char(p_day + p_in, 'HH24:MI') || '</strong> ', '')
      || COALESCE('Izlaz: <strong>' || to_char(p_day + p_out, 'HH24:MI') || '</strong>', '') || '</p>'
      || '<p>Obrazloženje: <em>' || btrim(p_reason) || '</em></p>'
      || '<p style="color:#666;font-size:13px">Uneo: ' || v_caller
      || CASE WHEN v_is_self THEN ' (za sebe)' ELSE ' (u ime radnika)' END || '</p>'
      || '<p style="color:#666;font-size:13px">Korekciju možete poništiti u aplikaciji (Moj profil › Moj tim / Kadrovska › Prisustvo).</p>'
      || '<p style="color:#999;font-size:12px">Servoteh — automatsko obaveštenje</p></div>',
      'attendance_correction', v_corr_id::text, p_employee_id, 'attendance_correction',
      'queued', now(), jsonb_build_object('work_date', p_day, 'correction_id', v_corr_id));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'correction_id', v_corr_id, 'employee_name', v_emp_name);
END;
$function$
;

-- ============ can_edit_kadrovska_grid ============
CREATE OR REPLACE FUNCTION public.can_edit_kadrovska_grid()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.kadr_grid_editor_allowlist a
    WHERE lower(a.email) = lower(coalesce(public.current_user_email(), ''))
  );
$function$
;

-- ============ can_edit_vacation_balance ============
CREATE OR REPLACE FUNCTION public.can_edit_vacation_balance()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.kadr_vacation_editor_allowlist a
    WHERE lower(a.email) = lower(coalesce(public.current_user_email(), ''))
  );
$function$
;

-- ============ current_user_can_manage_assessment ============
CREATE OR REPLACE FUNCTION public.current_user_can_manage_assessment(p_emp uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (public.current_user_is_admin() OR public.current_user_manages_dev_plan(p_emp))
     AND p_emp IS DISTINCT FROM public.current_user_employee_id();
$function$
;

-- ============ current_user_can_manage_employee_pii ============
CREATE OR REPLACE FUNCTION public.current_user_can_manage_employee_pii()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.current_user_is_admin()
      OR public.current_user_is_poslovni_admin();
$function$
;

-- ============ current_user_can_manage_org_profile ============
CREATE OR REPLACE FUNCTION public.current_user_can_manage_org_profile()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE lower(email) = lower(auth.jwt() ->> 'email')
      AND role IN ('admin', 'menadzment', 'pm', 'leadpm')
      AND is_active = true
  )
$function$
;

-- ============ current_user_can_manage_talk ============
CREATE OR REPLACE FUNCTION public.current_user_can_manage_talk(p_emp uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select (public.current_user_is_admin() or public.current_user_manages_dev_plan(p_emp))
     and p_emp is distinct from public.current_user_employee_id();
$function$
;

-- ============ current_user_can_manage_vacreq ============
CREATE OR REPLACE FUNCTION public.current_user_can_manage_vacreq()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.current_user_is_vacreq_admin() OR exists (
    SELECT 1
    FROM public.user_roles AS ur
    WHERE lower(ur.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      AND ur.role IN ('admin', 'hr', 'menadzment', 'leadpm', 'pm', 'poslovni_admin')
      AND ur.is_active IS TRUE
  )
$function$
;

-- ============ current_user_dev_managed_sub_depts ============
CREATE OR REPLACE FUNCTION public.current_user_dev_managed_sub_depts()
 RETURNS integer[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    (SELECT array_agg(DISTINCT s)
       FROM user_roles ur, unnest(ur.managed_sub_department_ids) AS s
      WHERE lower(ur.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        AND ur.is_active IS TRUE),
    '{}'::int[]);
$function$
;

-- ============ current_user_email ============
CREATE OR REPLACE FUNCTION public.current_user_email()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    NULLIF(current_setting('request.jwt.claim.email', true), ''),
    NULL
  );
$function$
;

-- ============ current_user_employee_id ============
CREATE OR REPLACE FUNCTION public.current_user_employee_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id FROM employees WHERE lower(email) = lower(coalesce(auth.jwt() ->> 'email','')) LIMIT 1;
$function$
;

-- ============ current_user_is_admin ============
CREATE OR REPLACE FUNCTION public.current_user_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM   public.user_roles
    WHERE  LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND  role = 'admin'
      AND  is_active = TRUE
  );
$function$
;

-- ============ current_user_is_hr ============
CREATE OR REPLACE FUNCTION public.current_user_is_hr()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      AND role = 'hr'
      AND is_active IS TRUE
  );
$function$
;

-- ============ current_user_is_hr_or_admin ============
CREATE OR REPLACE FUNCTION public.current_user_is_hr_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND role IN ('admin','hr','menadzment')
      AND is_active = TRUE
  );
$function$
;

-- ============ current_user_is_management ============
CREATE OR REPLACE FUNCTION public.current_user_is_management()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM   public.user_roles
    WHERE  LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
      AND  role IN ('admin','menadzment')
      AND  project_id IS NULL
      AND  is_active = TRUE
  );
$function$
;

-- ============ current_user_is_poslovni_admin ============
CREATE OR REPLACE FUNCTION public.current_user_is_poslovni_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      AND role = 'poslovni_admin'
      AND is_active IS TRUE
  );
$function$
;

-- ============ current_user_is_vacreq_admin ============
CREATE OR REPLACE FUNCTION public.current_user_is_vacreq_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT lower(coalesce(auth.jwt() ->> 'email', '')) = ANY (ARRAY[
    'zoran.jarakovic@servoteh.com'
  ])
$function$
;

-- ============ current_user_managed_departments ============
CREATE OR REPLACE FUNCTION public.current_user_managed_departments()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NULL::text[];
$function$
;

-- ============ current_user_managed_sub_department_ids ============
CREATE OR REPLACE FUNCTION public.current_user_managed_sub_department_ids()
 RETURNS integer[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT ur.managed_sub_department_ids
  FROM public.user_roles AS ur
  WHERE lower(ur.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    AND ur.role = 'menadzment'
    AND ur.is_active IS TRUE
  ORDER BY ur.project_id NULLS FIRST
  LIMIT 1
$function$
;

-- ============ current_user_manages_dev_plan ============
CREATE OR REPLACE FUNCTION public.current_user_manages_dev_plan(p_emp uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.current_user_sees_all_dev_plans()
    OR EXISTS (SELECT 1 FROM employees e
       WHERE e.id = p_emp AND e.sub_department_id IS NOT NULL
         AND e.sub_department_id = ANY (public.current_user_dev_managed_sub_depts()));
$function$
;

-- ============ current_user_manages_employee ============
CREATE OR REPLACE FUNCTION public.current_user_manages_employee(p_emp_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN public.current_user_is_admin() THEN true
    WHEN public.current_user_is_hr() THEN true
    WHEN public.current_user_is_poslovni_admin() THEN true
    WHEN EXISTS (
      SELECT 1 FROM public.user_roles AS ur
      WHERE lower(ur.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        AND ur.role IN ('pm', 'leadpm', 'projektant_vodja')
        AND ur.is_active IS TRUE
    ) THEN true
    WHEN public.current_user_managed_sub_department_ids() IS NULL THEN
      EXISTS (
        SELECT 1 FROM public.user_roles AS ur
        WHERE lower(ur.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
          AND ur.role = 'menadzment'
          AND ur.is_active IS TRUE
      )
    ELSE EXISTS (
      SELECT 1 FROM public.employees AS e
      WHERE e.id = p_emp_id
        AND e.sub_department_id IS NOT NULL
        AND e.sub_department_id = any (public.current_user_managed_sub_department_ids())
    )
  END
$function$
;

-- ============ current_user_role ============
CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT LOWER(role)
       FROM public.user_roles
      WHERE LOWER(email) = LOWER(auth.jwt() ->> 'email')
        AND is_active = true
      ORDER BY
        CASE LOWER(role)
          WHEN 'leadpm' THEN 1
          WHEN 'pm'     THEN 2
          WHEN 'viewer' THEN 3
          ELSE 4
        END
      LIMIT 1),
    'viewer'
  );
$function$
;

-- ============ current_user_role_v2 ============
CREATE OR REPLACE FUNCTION public.current_user_role_v2()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT lower(role)
       FROM public.user_roles
      WHERE user_id = auth.uid()
        AND is_active = true
      ORDER BY
        CASE lower(role)
          WHEN 'admin' THEN 1 WHEN 'leadpm' THEN 2 WHEN 'pm' THEN 3
          WHEN 'menadzment' THEN 4 WHEN 'hr' THEN 5 WHEN 'viewer' THEN 6
          ELSE 7
        END
      LIMIT 1),
    (SELECT lower(role)
       FROM public.user_roles
      WHERE lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        AND is_active = true
      ORDER BY
        CASE lower(role)
          WHEN 'admin' THEN 1 WHEN 'leadpm' THEN 2 WHEN 'pm' THEN 3
          WHEN 'menadzment' THEN 4 WHEN 'hr' THEN 5 WHEN 'viewer' THEN 6
          ELSE 7
        END
      LIMIT 1),
    'viewer'
  );
$function$
;

-- ============ current_user_sees_all_dev_plans ============
CREATE OR REPLACE FUNCTION public.current_user_sees_all_dev_plans()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.current_user_is_admin()
    OR EXISTS (SELECT 1 FROM user_roles
       WHERE lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
         AND is_active IS TRUE AND managed_departments @> ARRAY['*']);
$function$
;

-- ============ employees_sensitive_guard ============
CREATE OR REPLACE FUNCTION public.employees_sensitive_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.personal_id IS NOT NULL OR NEW.bank_account IS NOT NULL
       OR NEW.bank_name IS NOT NULL OR NEW.address IS NOT NULL
       OR NEW.city IS NOT NULL OR NEW.postal_code IS NOT NULL
       OR NEW.phone_private IS NOT NULL OR NEW.emergency_contact_name IS NOT NULL
       OR NEW.emergency_contact_phone IS NOT NULL
       OR NEW.emergency_contact_relation IS NOT NULL
       OR NEW.emergency_contact_phone_alt IS NOT NULL
    THEN
      IF NOT public.current_user_can_manage_employee_pii() THEN
        RAISE EXCEPTION 'Samo administrator ili poslovni administrator može da unosi lične podatke (JMBG, banka, adresa, privatni telefon, kontakt za hitne slučajeve).'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.personal_id                    IS DISTINCT FROM OLD.personal_id)
  OR (NEW.bank_name                      IS DISTINCT FROM OLD.bank_name)
  OR (NEW.bank_account                   IS DISTINCT FROM OLD.bank_account)
  OR (NEW.address                        IS DISTINCT FROM OLD.address)
  OR (NEW.city                           IS DISTINCT FROM OLD.city)
  OR (NEW.postal_code                    IS DISTINCT FROM OLD.postal_code)
  OR (NEW.phone_private                  IS DISTINCT FROM OLD.phone_private)
  OR (NEW.emergency_contact_name         IS DISTINCT FROM OLD.emergency_contact_name)
  OR (NEW.emergency_contact_phone        IS DISTINCT FROM OLD.emergency_contact_phone)
  OR (NEW.emergency_contact_relation     IS DISTINCT FROM OLD.emergency_contact_relation)
  OR (NEW.emergency_contact_phone_alt    IS DISTINCT FROM OLD.emergency_contact_phone_alt)
  THEN
    IF NOT public.current_user_can_manage_employee_pii() THEN
      RAISE EXCEPTION 'Samo administrator ili poslovni administrator može da menja lične podatke (JMBG, banka, adresa, privatni telefon, kontakt za hitne slučajeve).'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ employees_sync_full_name ============
CREATE OR REPLACE FUNCTION public.employees_sync_full_name()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_first text := NULLIF(btrim(NEW.first_name), '');
  v_last  text := NULLIF(btrim(NEW.last_name), '');
BEGIN
  IF v_first IS NOT NULL OR v_last IS NOT NULL THEN
    NEW.full_name := btrim(concat_ws(' ', v_last, v_first));
  END IF;

  RETURN NEW;
END;
$function$
;

-- ============ has_edit_role ============
CREATE OR REPLACE FUNCTION public.has_edit_role(proj_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  auth_email TEXT := lower(coalesce(auth.jwt()->>'email', ''));
BEGIN
  IF auth_email = '' THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE lower(email) = auth_email
      AND project_id IS NULL
      AND role IN ('admin','hr','menadzment','pm','leadpm','poslovni_admin')
      AND is_active = true
  ) THEN
    RETURN true;
  END IF;

  IF proj_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE lower(email) = auth_email
      AND project_id = proj_id
      AND role IN ('pm','leadpm')
      AND is_active = true
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$function$
;

-- ============ hr_approve_vacation_request ============
CREATE OR REPLACE FUNCTION public.hr_approve_vacation_request(p_request_id uuid, p_actor_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req      vacation_requests%ROWTYPE;
  v_reviewer text;
  v_abs_id   uuid;
BEGIN
  IF NOT public.current_user_can_manage_vacreq() THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Korisnik nije u upravljačkoj roli za GO zahteve.';
  END IF;

  v_reviewer := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));

  UPDATE vacation_requests
     SET status = 'approved', reviewed_by = v_reviewer, reviewed_at = now()
   WHERE id = p_request_id AND status = 'pending' RETURNING * INTO v_req;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id);
  END IF;

  INSERT INTO absences (employee_id, type, date_from, date_to, days_count, note)
  VALUES (v_req.employee_id, 'godisnji', v_req.date_from, v_req.date_to,
          NULLIF(v_req.days_count, 0),
          'Odobreno iz zahteva GO (' || COALESCE(v_req.submitted_by, '') || ')')
  RETURNING id INTO v_abs_id;
  /* GRID JE ZAKON. */
  PERFORM public.kadr_grid_set_go(v_req.employee_id, v_req.date_from, v_req.date_to, v_reviewer);

  RETURN jsonb_build_object('status', 'approved', 'request_id', p_request_id,
                            'absence_id', v_abs_id, 'reviewed_by', v_reviewer);
END;
$function$
;

-- ============ hr_cancel_vacation_request ============
CREATE OR REPLACE FUNCTION public.hr_cancel_vacation_request(p_request_id uuid, p_actor_email text DEFAULT NULL::text)
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
  v_caller := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));

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
$function$
;

-- ============ hr_correct_vacation_balance ============
CREATE OR REPLACE FUNCTION public.hr_correct_vacation_balance(p_employee_id uuid, p_year integer, p_target_remaining integer, p_accrual integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_used    int;
  v_carried int;
  v_total   int;
BEGIN
  IF NOT public.can_edit_vacation_balance() THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Korekciju GO salda smeju samo ovlašćeni (Nevena/Nenad/Nikola).';
  END IF;

  IF p_target_remaining < 0 THEN
    RAISE EXCEPTION 'invalid_target' USING ERRCODE = '22023', HINT = 'Preostalo ne sme biti < 0.';
  END IF;

  SELECT COALESCE(days_used, 0) INTO v_used
  FROM public.v_vacation_balance
  WHERE employee_id = p_employee_id AND year = p_year;
  v_used := COALESCE(v_used, 0);

  -- back-solve uz garanciju >=0
  v_carried := GREATEST(0, p_target_remaining - p_accrual + v_used);
  v_total   := p_target_remaining + v_used - v_carried;  -- == p_accrual kad nema overdraw

  INSERT INTO public.vacation_entitlements
    (employee_id, year, days_total, days_carried_over, review_flag, source, note)
  VALUES
    (p_employee_id, p_year, v_total, v_carried, 'corrected', 'correction',
     'Korekcija preostalog: ' || p_target_remaining || ' (used=' || v_used ||
     ') ' || coalesce(public.current_user_email(),'') )
  ON CONFLICT (employee_id, year) DO UPDATE SET
    days_total        = EXCLUDED.days_total,
    days_carried_over = EXCLUDED.days_carried_over,
    review_flag       = 'corrected',
    source            = COALESCE(public.vacation_entitlements.source, 'correction'),
    note              = EXCLUDED.note;

  RETURN jsonb_build_object(
    'employee_id', p_employee_id, 'year', p_year,
    'days_total', v_total, 'days_carried_over', v_carried,
    'days_used', v_used, 'remaining', p_target_remaining
  );
END;
$function$
;

-- ============ hr_delete_vacation_request ============
CREATE OR REPLACE FUNCTION public.hr_delete_vacation_request(p_request_id uuid, p_actor_email text DEFAULT NULL::text)
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
  v_caller := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));

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
$function$
;

-- ============ hr_reject_vacation_request ============
CREATE OR REPLACE FUNCTION public.hr_reject_vacation_request(p_request_id uuid, p_rejection_note text DEFAULT NULL::text, p_actor_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req      vacation_requests%ROWTYPE;
  v_reviewer text;
BEGIN
  IF NOT public.current_user_can_manage_vacreq() THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Korisnik nije u upravljackoj roli za GO zahteve.';
  END IF;

  SELECT * INTO v_req FROM vacation_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id);
  END IF;

  IF NOT (public.current_user_manages_employee(v_req.employee_id) OR public.current_user_is_vacreq_admin()) THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Zahtev je van vaseg opsega pododeljenja.';
  END IF;

  v_reviewer := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));

  UPDATE vacation_requests
     SET status         = 'rejected',
         reviewed_by    = v_reviewer,
         reviewed_at    = now(),
         rejection_note = COALESCE(p_rejection_note, '')
   WHERE id = p_request_id
     AND status IN ('pending', 'sef_approved')
   RETURNING * INTO v_req;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id);
  END IF;

  RETURN jsonb_build_object('status', 'rejected', 'request_id', p_request_id,
                            'reviewed_by', v_reviewer,
                            'rejection_note', COALESCE(p_rejection_note, ''));
END;
$function$
;

-- ============ hr_reschedule_vacation_request ============
CREATE OR REPLACE FUNCTION public.hr_reschedule_vacation_request(p_request_id uuid, p_date_from date, p_date_to date, p_days_count integer, p_actor_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req           vacation_requests%ROWTYPE;
  v_reviewer      text;
  v_new_year      int;
  v_remaining     int;
  v_available     int;
  v_same_year_old int;
  v_updated       int;
  v_old_from      date;
  v_old_to        date;
BEGIN
  IF NOT public.current_user_can_manage_vacreq() THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Korisnik nije u upravljackoj roli za GO zahteve.';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_to < p_date_from THEN
    RAISE EXCEPTION 'invalid_dates' USING ERRCODE = '22007', HINT = 'Neispravan opseg datuma (do < od ili prazno).';
  END IF;

  SELECT * INTO v_req FROM vacation_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found', 'request_id', p_request_id);
  END IF;

  IF NOT (public.current_user_manages_employee(v_req.employee_id) OR public.current_user_is_vacreq_admin()) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Zahtev je van vaseg opsega pododeljenja.';
  END IF;

  IF v_req.status <> 'approved' THEN
    RETURN jsonb_build_object('status', 'not_approved', 'request_id', p_request_id, 'current_status', v_req.status);
  END IF;

  v_new_year := EXTRACT(YEAR FROM p_date_from)::int;
  v_old_from := v_req.date_from;
  v_old_to   := v_req.date_to;

  SELECT days_remaining INTO v_remaining FROM v_vacation_balance
   WHERE employee_id = v_req.employee_id AND year = v_new_year;
  v_same_year_old := CASE WHEN v_req.year = v_new_year THEN COALESCE(v_req.days_count, 0) ELSE 0 END;
  IF v_remaining IS NOT NULL THEN
    v_available := v_remaining + v_same_year_old;
    IF COALESCE(p_days_count, 0) > v_available THEN
      RETURN jsonb_build_object('status', 'exceeds_balance', 'request_id', p_request_id,
                                'remaining', v_available, 'requested', COALESCE(p_days_count, 0));
    END IF;
  END IF;

  v_reviewer := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));

  UPDATE absences
     SET date_from = p_date_from, date_to = p_date_to, days_count = NULLIF(p_days_count, 0),
         note = COALESCE(note, '') || ' · termin promenjen ' || COALESCE(v_reviewer, '')
   WHERE employee_id = v_req.employee_id AND type = 'godisnji'
     AND date_from = v_req.date_from AND date_to = v_req.date_to AND archived_at IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    INSERT INTO absences (employee_id, type, date_from, date_to, days_count, note)
    VALUES (v_req.employee_id, 'godisnji', p_date_from, p_date_to, NULLIF(p_days_count, 0),
            'GO termin promenjen (' || COALESCE(v_reviewer, '') || ')');
  END IF;

  /* GRID JE ZAKON: skloni go za stari termin, upiši za nov. */
  PERFORM public.kadr_grid_unset_go(v_req.employee_id, v_old_from, v_old_to);
  PERFORM public.kadr_grid_set_go(v_req.employee_id, p_date_from, p_date_to, v_reviewer);

  UPDATE vacation_requests
     SET date_from = p_date_from, date_to = p_date_to, days_count = COALESCE(p_days_count, 0),
         year = v_new_year, reviewed_by = v_reviewer, reviewed_at = now()
   WHERE id = p_request_id RETURNING * INTO v_req;

  RETURN jsonb_build_object('status', 'rescheduled', 'request_id', p_request_id,
     'date_from', p_date_from, 'date_to', p_date_to,
     'days_count', COALESCE(p_days_count, 0), 'reviewed_by', v_reviewer);
END;
$function$
;

-- ============ hr_revise_vacation_request ============
CREATE OR REPLACE FUNCTION public.hr_revise_vacation_request(p_request_id uuid, p_date_from date, p_date_to date, p_days_count integer, p_note text DEFAULT NULL::text, p_actor_email text DEFAULT NULL::text, p_force_reapproval boolean DEFAULT false)
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
  v_caller := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));

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
$function$
;

-- ============ hr_rollover_year ============
CREATE OR REPLACE FUNCTION public.hr_rollover_year(p_from_year integer, p_to_year integer, p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows    jsonb;
  v_count   int := 0;
  v_applied int := 0;
BEGIN
  /* Samo uprava (CEO/CFO/admin). */
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Godišnji prelaz radi samo uprava (admin).';
  END IF;

  IF p_to_year <> p_from_year + 1 THEN
    RAISE EXCEPTION 'invalid_years'
      USING ERRCODE = '22023', HINT = 'p_to_year mora biti p_from_year + 1.';
  END IF;

  /* Plan: za svakog AKTIVNOG zaposlenog sa from-godinom u saldu,
     preneto_u_novu = preostalo(from). Minus se prenosi (bez GREATEST 0). */
  SELECT count(*),
         jsonb_agg(jsonb_build_object(
           'employee_id', b.employee_id,
           'remaining_from', b.days_remaining,
           'carried_to', b.days_remaining
         ) ORDER BY b.days_remaining)
    INTO v_count, v_rows
  FROM v_vacation_balance b
  JOIN employees e ON e.id = b.employee_id AND e.is_active IS TRUE
  WHERE b.year = p_from_year;

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'status', 'dry_run', 'from', p_from_year, 'to', p_to_year,
      'count', COALESCE(v_count, 0),
      'sum_carried', COALESCE((SELECT sum((x->>'carried_to')::int) FROM jsonb_array_elements(COALESCE(v_rows,'[]'::jsonb)) x), 0),
      'rows', COALESCE(v_rows, '[]'::jsonb)
    );
  END IF;

  /* APPLY — kreiraj/azuriraj `to` entitlement. Ne gazi ručne korekcije. */
  INSERT INTO vacation_entitlements (
    employee_id, year, days_total, days_carried_over, opening_used,
    accrual_model, accrual_base, source, note, updated_at
  )
  SELECT b.employee_id, p_to_year, 20, b.days_remaining, 0,
         false, 20,
         'rollover_' || p_from_year || '_' || p_to_year,
         'Godišnji prelaz: preneto = preostalo ' || p_from_year
           || ' (' || b.days_remaining || ' dana)', now()
  FROM v_vacation_balance b
  JOIN employees e ON e.id = b.employee_id AND e.is_active IS TRUE
  WHERE b.year = p_from_year
  ON CONFLICT (employee_id, year) DO UPDATE
    SET days_carried_over = EXCLUDED.days_carried_over,
        source            = EXCLUDED.source,
        note              = EXCLUDED.note,
        updated_at        = now()
    WHERE vacation_entitlements.source IS DISTINCT FROM 'manual_adjust';

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  RETURN jsonb_build_object(
    'status', 'applied', 'from', p_from_year, 'to', p_to_year, 'applied', v_applied
  );
END;
$function$
;

-- ============ hr_set_advance_approval ============
CREATE OR REPLACE FUNCTION public.hr_set_advance_approval(p_employee_id uuid, p_year integer, p_approved boolean, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text;
  v_id    uuid;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Avans odobrava samo uprava (CEO/CFO).';
  END IF;
  IF p_employee_id IS NULL OR p_year IS NULL THEN
    RAISE EXCEPTION 'invalid_args' USING ERRCODE = '22023';
  END IF;

  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  INSERT INTO vacation_entitlements (
    employee_id, year, days_total, days_carried_over,
    advance_approved, advance_approved_by, advance_approved_at, advance_note, updated_at
  ) VALUES (
    p_employee_id, p_year, 20, 0,
    p_approved,
    CASE WHEN p_approved THEN v_email ELSE NULL END,
    CASE WHEN p_approved THEN now()   ELSE NULL END,
    NULLIF(p_note, ''), now()
  )
  ON CONFLICT (employee_id, year) DO UPDATE
    SET advance_approved    = EXCLUDED.advance_approved,
        advance_approved_by = CASE WHEN EXCLUDED.advance_approved THEN EXCLUDED.advance_approved_by ELSE NULL END,
        advance_approved_at = CASE WHEN EXCLUDED.advance_approved THEN EXCLUDED.advance_approved_at ELSE NULL END,
        advance_note        = EXCLUDED.advance_note,
        updated_at          = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'status', 'ok', 'entitlement_id', v_id,
    'employee_id', p_employee_id, 'year', p_year,
    'advance_approved', p_approved, 'approved_by', CASE WHEN p_approved THEN v_email ELSE NULL END
  );
END;
$function$
;

-- ============ hr_update_employee ============
CREATE OR REPLACE FUNCTION public.hr_update_employee(p_id uuid, p_patch jsonb, p_expected_updated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_emp           employees%ROWTYPE;
  v_updated_rows  int;
  v_allowed_keys  text[] := ARRAY[
    'full_name','first_name','last_name',
    'position','department','department_id','sub_department_id','position_id',
    'team','phone','email','hire_date','is_active','work_type','note',
    'birth_date','gender','slava','slava_day',
    'education_level','education_title',
    'medical_exam_date','medical_exam_expires',
    'personal_id','bank_name','bank_account','address','city','postal_code',
    'phone_private','emergency_contact_name','emergency_contact_phone',
    'emergency_contact_relation','emergency_contact_phone_alt'
  ];
  v_key           text;
  v_filtered      jsonb := '{}'::jsonb;
BEGIN
  IF NOT (
    public.current_user_is_admin()
    OR public.current_user_is_hr()
    OR public.current_user_is_poslovni_admin()
    OR (public.has_edit_role() AND public.current_user_manages_employee(p_id))
  ) THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Nemate ovlašćenje za izmenu ovog zaposlenog.';
  END IF;

  IF p_id IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023', HINT = 'p_id is required';
  END IF;

  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023', HINT = 'p_patch must be a jsonb object';
  END IF;

  FOREACH v_key IN ARRAY v_allowed_keys
  LOOP
    IF p_patch ? v_key THEN
      v_filtered := v_filtered || jsonb_build_object(v_key, p_patch -> v_key);
    END IF;
  END LOOP;

  IF v_filtered = '{}'::jsonb THEN
    SELECT * INTO v_emp FROM employees WHERE id = p_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'employee_missing' USING ERRCODE = '02000';
    END IF;
    RETURN jsonb_build_object(
      'applied', true, 'id', p_id, 'updated_at', v_emp.updated_at,
      'changed_fields', 0, 'reason', 'noop'
    );
  END IF;

  SELECT * INTO v_emp FROM employees
   WHERE id = p_id AND updated_at = p_expected_updated_at;

  IF NOT FOUND THEN
    SELECT updated_at INTO v_emp.updated_at FROM employees WHERE id = p_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'employee_missing' USING ERRCODE = '02000';
    END IF;
    RETURN jsonb_build_object(
      'applied', false, 'reason', 'stale', 'current_updated_at', v_emp.updated_at
    );
  END IF;

  UPDATE employees SET
    full_name                 = COALESCE(v_filtered ->> 'full_name', full_name),
    first_name                = CASE WHEN v_filtered ? 'first_name' THEN NULLIF(v_filtered ->> 'first_name', '') ELSE first_name END,
    last_name                 = CASE WHEN v_filtered ? 'last_name' THEN NULLIF(v_filtered ->> 'last_name', '') ELSE last_name END,
    position                  = COALESCE(v_filtered ->> 'position', position),
    department                = COALESCE(v_filtered ->> 'department', department),
    department_id             = CASE WHEN v_filtered ? 'department_id' THEN NULLIF(v_filtered ->> 'department_id', '')::int ELSE department_id END,
    sub_department_id         = CASE WHEN v_filtered ? 'sub_department_id' THEN NULLIF(v_filtered ->> 'sub_department_id', '')::int ELSE sub_department_id END,
    position_id               = CASE WHEN v_filtered ? 'position_id' THEN NULLIF(v_filtered ->> 'position_id', '')::int ELSE position_id END,
    team                      = CASE WHEN v_filtered ? 'team' THEN NULLIF(v_filtered ->> 'team', '') ELSE team END,
    phone                     = COALESCE(v_filtered ->> 'phone', phone),
    email                     = COALESCE(v_filtered ->> 'email', email),
    hire_date                 = CASE WHEN v_filtered ? 'hire_date' THEN NULLIF(v_filtered ->> 'hire_date', '')::date ELSE hire_date END,
    is_active                 = COALESCE((v_filtered ->> 'is_active')::boolean, is_active),
    work_type                 = COALESCE(v_filtered ->> 'work_type', work_type),
    note                      = COALESCE(v_filtered ->> 'note', note),
    birth_date                = CASE WHEN v_filtered ? 'birth_date' THEN NULLIF(v_filtered ->> 'birth_date', '')::date ELSE birth_date END,
    gender                    = CASE WHEN v_filtered ? 'gender' THEN NULLIF(v_filtered ->> 'gender', '') ELSE gender END,
    slava                     = CASE WHEN v_filtered ? 'slava' THEN NULLIF(v_filtered ->> 'slava', '') ELSE slava END,
    slava_day                 = CASE WHEN v_filtered ? 'slava_day' THEN NULLIF(v_filtered ->> 'slava_day', '') ELSE slava_day END,
    education_level           = CASE WHEN v_filtered ? 'education_level' THEN NULLIF(v_filtered ->> 'education_level', '') ELSE education_level END,
    education_title           = CASE WHEN v_filtered ? 'education_title' THEN NULLIF(v_filtered ->> 'education_title', '') ELSE education_title END,
    medical_exam_date         = CASE WHEN v_filtered ? 'medical_exam_date' THEN NULLIF(v_filtered ->> 'medical_exam_date', '')::date ELSE medical_exam_date END,
    medical_exam_expires      = CASE WHEN v_filtered ? 'medical_exam_expires' THEN NULLIF(v_filtered ->> 'medical_exam_expires', '')::date ELSE medical_exam_expires END,
    personal_id               = CASE WHEN v_filtered ? 'personal_id' THEN NULLIF(v_filtered ->> 'personal_id', '') ELSE personal_id END,
    bank_name                 = CASE WHEN v_filtered ? 'bank_name' THEN NULLIF(v_filtered ->> 'bank_name', '') ELSE bank_name END,
    bank_account              = CASE WHEN v_filtered ? 'bank_account' THEN NULLIF(v_filtered ->> 'bank_account', '') ELSE bank_account END,
    address                   = CASE WHEN v_filtered ? 'address' THEN NULLIF(v_filtered ->> 'address', '') ELSE address END,
    city                      = CASE WHEN v_filtered ? 'city' THEN NULLIF(v_filtered ->> 'city', '') ELSE city END,
    postal_code               = CASE WHEN v_filtered ? 'postal_code' THEN NULLIF(v_filtered ->> 'postal_code', '') ELSE postal_code END,
    phone_private             = CASE WHEN v_filtered ? 'phone_private' THEN NULLIF(v_filtered ->> 'phone_private', '') ELSE phone_private END,
    emergency_contact_name    = CASE WHEN v_filtered ? 'emergency_contact_name' THEN NULLIF(v_filtered ->> 'emergency_contact_name', '') ELSE emergency_contact_name END,
    emergency_contact_phone   = CASE WHEN v_filtered ? 'emergency_contact_phone' THEN NULLIF(v_filtered ->> 'emergency_contact_phone', '') ELSE emergency_contact_phone END,
    emergency_contact_relation  = CASE WHEN v_filtered ? 'emergency_contact_relation' THEN NULLIF(v_filtered ->> 'emergency_contact_relation', '') ELSE emergency_contact_relation END,
    emergency_contact_phone_alt = CASE WHEN v_filtered ? 'emergency_contact_phone_alt' THEN NULLIF(v_filtered ->> 'emergency_contact_phone_alt', '') ELSE emergency_contact_phone_alt END
   WHERE id = p_id AND updated_at = p_expected_updated_at;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  IF v_updated_rows = 0 THEN
    SELECT updated_at INTO v_emp.updated_at FROM employees WHERE id = p_id;
    RETURN jsonb_build_object(
      'applied', false, 'reason', 'stale', 'current_updated_at', v_emp.updated_at
    );
  END IF;

  SELECT updated_at INTO v_emp.updated_at FROM employees WHERE id = p_id;
  RETURN jsonb_build_object(
    'applied', true, 'id', p_id, 'updated_at', v_emp.updated_at,
    'changed_fields', (SELECT count(*)::int FROM jsonb_object_keys(v_filtered))
  );
END;
$function$
;

-- ============ hr_upsert_salary_payroll ============
CREATE OR REPLACE FUNCTION public.hr_upsert_salary_payroll(p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id            uuid;
  v_employee      uuid;
  v_year          int;
  v_month         int;
  v_expected      timestamptz;
  v_existing      salary_payroll%ROWTYPE;
  v_inserted_id   uuid;
  v_updated_rows  int;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Samo administrator može da menja obračun zarade.';
  END IF;

  IF p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'invalid_payload' USING ERRCODE = '22023';
  END IF;

  v_id := NULLIF(p_row ->> 'id', '')::uuid;
  v_employee := (p_row ->> 'employee_id')::uuid;
  v_year := (p_row ->> 'period_year')::int;
  v_month := (p_row ->> 'period_month')::int;
  v_expected := NULLIF(p_row ->> 'expected_updated_at', '')::timestamptz;

  /* INSERT path — v_id IS NULL znači novi red. */
  IF v_id IS NULL THEN
    INSERT INTO salary_payroll (
      employee_id, period_year, period_month,
      salary_type, compensation_model,
      advance_amount, advance_paid_on, advance_note,
      fixed_salary, hours_worked, hourly_rate,
      transport_rsd, domestic_days, per_diem_rsd,
      foreign_days, per_diem_eur,
      final_paid_on, status, note,
      fond_sati_meseca, redovan_rad_sati, prekovremeni_sati,
      praznik_placeni_sati, praznik_rad_sati,
      godisnji_sati, slobodni_dani_sati,
      bolovanje_65_sati, bolovanje_100_sati, dve_masine_sati,
      teren_u_zemlji_count, teren_u_inostranstvu_count,
      payable_hours, ukupna_zarada, prvi_deo, preostalo_za_isplatu,
      warnings
    ) VALUES (
      v_employee, v_year, v_month,
      COALESCE(p_row ->> 'salary_type', 'ugovor'),
      NULLIF(p_row ->> 'compensation_model', ''),
      COALESCE((p_row ->> 'advance_amount')::numeric, 0),
      NULLIF(p_row ->> 'advance_paid_on', '')::date,
      COALESCE(p_row ->> 'advance_note', ''),
      COALESCE((p_row ->> 'fixed_salary')::numeric, 0),
      COALESCE((p_row ->> 'hours_worked')::numeric, 0),
      COALESCE((p_row ->> 'hourly_rate')::numeric, 0),
      COALESCE((p_row ->> 'transport_rsd')::numeric, 0),
      COALESCE((p_row ->> 'domestic_days')::int, 0),
      COALESCE((p_row ->> 'per_diem_rsd')::numeric, 0),
      COALESCE((p_row ->> 'foreign_days')::int, 0),
      COALESCE((p_row ->> 'per_diem_eur')::numeric, 0),
      NULLIF(p_row ->> 'final_paid_on', '')::date,
      COALESCE(p_row ->> 'status', 'draft'),
      COALESCE(p_row ->> 'note', ''),
      COALESCE((p_row ->> 'fond_sati_meseca')::numeric, 0),
      COALESCE((p_row ->> 'redovan_rad_sati')::numeric, 0),
      COALESCE((p_row ->> 'prekovremeni_sati')::numeric, 0),
      COALESCE((p_row ->> 'praznik_placeni_sati')::numeric, 0),
      COALESCE((p_row ->> 'praznik_rad_sati')::numeric, 0),
      COALESCE((p_row ->> 'godisnji_sati')::numeric, 0),
      COALESCE((p_row ->> 'slobodni_dani_sati')::numeric, 0),
      COALESCE((p_row ->> 'bolovanje_65_sati')::numeric, 0),
      COALESCE((p_row ->> 'bolovanje_100_sati')::numeric, 0),
      COALESCE((p_row ->> 'dve_masine_sati')::numeric, 0),
      COALESCE((p_row ->> 'teren_u_zemlji_count')::int, 0),
      COALESCE((p_row ->> 'teren_u_inostranstvu_count')::int, 0),
      COALESCE((p_row ->> 'payable_hours')::numeric, 0),
      COALESCE((p_row ->> 'ukupna_zarada')::numeric, 0),
      COALESCE((p_row ->> 'prvi_deo')::numeric, 0),
      COALESCE((p_row ->> 'preostalo_za_isplatu')::numeric, 0),
      COALESCE((p_row -> 'warnings')::jsonb, '[]'::jsonb)
    )
    ON CONFLICT (employee_id, period_year, period_month) DO NOTHING
    RETURNING id INTO v_inserted_id;

    IF v_inserted_id IS NULL THEN
      /* UNIQUE konflikt — drugi admin je u međuvremenu kreirao red. */
      SELECT id, updated_at INTO v_existing.id, v_existing.updated_at
        FROM salary_payroll
       WHERE employee_id = v_employee
         AND period_year = v_year
         AND period_month = v_month;
      RETURN jsonb_build_object(
        'applied', false,
        'reason', 'row_exists',
        'existing_id', v_existing.id,
        'current_updated_at', v_existing.updated_at
      );
    END IF;

    SELECT * INTO v_existing FROM salary_payroll WHERE id = v_inserted_id;
    RETURN jsonb_build_object(
      'applied', true,
      'id', v_inserted_id,
      'updated_at', v_existing.updated_at,
      'status', v_existing.status,
      'total_rsd', v_existing.total_rsd,
      'ukupna_zarada', v_existing.ukupna_zarada
    );
  END IF;

  /* UPDATE path — v_id postoji. */
  SELECT * INTO v_existing FROM salary_payroll WHERE id = v_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary_payroll_row_missing' USING ERRCODE = '02000';
  END IF;

  /* Locked check — ako je trenutni status paid, vrati conflict bez izmena. */
  IF v_existing.status = 'paid' THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'locked',
      'current_updated_at', v_existing.updated_at,
      'current_status', 'paid'
    );
  END IF;

  /* Optimistic check — expected_updated_at mora se poklapati. */
  IF v_expected IS NULL OR v_existing.updated_at <> v_expected THEN
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'stale',
      'current_updated_at', v_existing.updated_at
    );
  END IF;

  /* Apply UPDATE — pun set polja, totals trigger će recomputovati. */
  UPDATE salary_payroll SET
    salary_type        = COALESCE(p_row ->> 'salary_type', salary_type),
    compensation_model = COALESCE(NULLIF(p_row ->> 'compensation_model', ''), compensation_model),
    advance_amount     = COALESCE((p_row ->> 'advance_amount')::numeric, advance_amount),
    advance_paid_on    = NULLIF(p_row ->> 'advance_paid_on', '')::date,
    advance_note       = COALESCE(p_row ->> 'advance_note', advance_note),
    fixed_salary       = COALESCE((p_row ->> 'fixed_salary')::numeric, fixed_salary),
    hours_worked       = COALESCE((p_row ->> 'hours_worked')::numeric, hours_worked),
    hourly_rate        = COALESCE((p_row ->> 'hourly_rate')::numeric, hourly_rate),
    transport_rsd      = COALESCE((p_row ->> 'transport_rsd')::numeric, transport_rsd),
    domestic_days      = COALESCE((p_row ->> 'domestic_days')::int, domestic_days),
    per_diem_rsd       = COALESCE((p_row ->> 'per_diem_rsd')::numeric, per_diem_rsd),
    foreign_days       = COALESCE((p_row ->> 'foreign_days')::int, foreign_days),
    per_diem_eur       = COALESCE((p_row ->> 'per_diem_eur')::numeric, per_diem_eur),
    final_paid_on      = NULLIF(p_row ->> 'final_paid_on', '')::date,
    status             = COALESCE(p_row ->> 'status', status),
    note               = COALESCE(p_row ->> 'note', note),
    fond_sati_meseca   = COALESCE((p_row ->> 'fond_sati_meseca')::numeric, fond_sati_meseca),
    redovan_rad_sati   = COALESCE((p_row ->> 'redovan_rad_sati')::numeric, redovan_rad_sati),
    prekovremeni_sati  = COALESCE((p_row ->> 'prekovremeni_sati')::numeric, prekovremeni_sati),
    praznik_placeni_sati = COALESCE((p_row ->> 'praznik_placeni_sati')::numeric, praznik_placeni_sati),
    praznik_rad_sati   = COALESCE((p_row ->> 'praznik_rad_sati')::numeric, praznik_rad_sati),
    godisnji_sati      = COALESCE((p_row ->> 'godisnji_sati')::numeric, godisnji_sati),
    slobodni_dani_sati = COALESCE((p_row ->> 'slobodni_dani_sati')::numeric, slobodni_dani_sati),
    bolovanje_65_sati  = COALESCE((p_row ->> 'bolovanje_65_sati')::numeric, bolovanje_65_sati),
    bolovanje_100_sati = COALESCE((p_row ->> 'bolovanje_100_sati')::numeric, bolovanje_100_sati),
    dve_masine_sati    = COALESCE((p_row ->> 'dve_masine_sati')::numeric, dve_masine_sati),
    teren_u_zemlji_count = COALESCE((p_row ->> 'teren_u_zemlji_count')::int, teren_u_zemlji_count),
    teren_u_inostranstvu_count = COALESCE((p_row ->> 'teren_u_inostranstvu_count')::int, teren_u_inostranstvu_count),
    payable_hours      = COALESCE((p_row ->> 'payable_hours')::numeric, payable_hours),
    ukupna_zarada      = COALESCE((p_row ->> 'ukupna_zarada')::numeric, ukupna_zarada),
    prvi_deo           = COALESCE((p_row ->> 'prvi_deo')::numeric, prvi_deo),
    preostalo_za_isplatu = COALESCE((p_row ->> 'preostalo_za_isplatu')::numeric, preostalo_za_isplatu),
    warnings           = COALESCE((p_row -> 'warnings')::jsonb, warnings)
   WHERE id = v_id
     AND updated_at = v_expected;

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  IF v_updated_rows = 0 THEN
    /* Race: između našeg SELECT-a (gore) i UPDATE-a, neko je commit-ovao
       drugu izmenu — updated_at se pomerio. */
    SELECT updated_at INTO v_existing.updated_at FROM salary_payroll WHERE id = v_id;
    RETURN jsonb_build_object(
      'applied', false,
      'reason', 'stale',
      'current_updated_at', v_existing.updated_at
    );
  END IF;

  SELECT * INTO v_existing FROM salary_payroll WHERE id = v_id;
  RETURN jsonb_build_object(
    'applied', true,
    'id', v_id,
    'updated_at', v_existing.updated_at,
    'status', v_existing.status,
    'total_rsd', v_existing.total_rsd,
    'ukupna_zarada', v_existing.ukupna_zarada
  );
END $function$
;

-- ============ hr_upsert_work_hours_batch ============
CREATE OR REPLACE FUNCTION public.hr_upsert_work_hours_batch(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row            jsonb;
  v_emp            uuid;
  v_date           date;
  v_applied        int := 0;
  v_field_sub      text;
  v_abs_code       text;
  v_abs_sub        text;
  v_editor         text;
BEGIN
  IF NOT public.can_edit_kadrovska_grid() THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Samo ovlašćeni unos sati (mesečni grid).';
  END IF;

  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'invalid_payload'
      USING ERRCODE = '22023', HINT = 'p_rows mora biti JSONB array.';
  END IF;

  v_editor := public.current_user_email();

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_emp  := (v_row ->> 'employee_id')::uuid;
    v_date := (v_row ->> 'work_date')::date;

    v_field_sub := v_row ->> 'field_subtype';
    IF v_field_sub IS NOT NULL AND v_field_sub NOT IN ('domestic', 'foreign') THEN
      v_field_sub := NULL;
    END IF;

    v_abs_code := NULLIF(v_row ->> 'absence_code', '');
    v_abs_sub  := NULLIF(v_row ->> 'absence_subtype', '');

    INSERT INTO work_hours (
      employee_id, work_date,
      hours, overtime_hours, field_hours, field_subtype,
      two_machine_hours, absence_code, absence_subtype,
      note, project_ref, last_edited_by
    ) VALUES (
      v_emp, v_date,
      COALESCE((v_row ->> 'hours')::numeric, 0),
      COALESCE((v_row ->> 'overtime_hours')::numeric, 0),
      COALESCE((v_row ->> 'field_hours')::numeric, 0),
      v_field_sub,
      COALESCE((v_row ->> 'two_machine_hours')::numeric, 0),
      v_abs_code,
      v_abs_sub,
      COALESCE(v_row ->> 'note', ''),
      COALESCE(v_row ->> 'project_ref', ''),
      v_editor
    )
    ON CONFLICT (employee_id, work_date) DO UPDATE SET
      hours             = EXCLUDED.hours,
      overtime_hours    = EXCLUDED.overtime_hours,
      field_hours       = EXCLUDED.field_hours,
      field_subtype     = EXCLUDED.field_subtype,
      two_machine_hours = EXCLUDED.two_machine_hours,
      absence_code      = EXCLUDED.absence_code,
      absence_subtype   = EXCLUDED.absence_subtype,
      note              = EXCLUDED.note,
      project_ref       = EXCLUDED.project_ref,
      last_edited_by    = EXCLUDED.last_edited_by;

    v_applied := v_applied + 1;
  END LOOP;

  RETURN jsonb_build_object('applied', v_applied, 'conflicts', '[]'::jsonb);
END;
$function$
;

-- ============ hr_vacreq_approve ============
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
      IF v_remaining IS NOT NULL AND coalesce(v_req.days_count, 0) > v_remaining THEN
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
  IF v_remaining IS NOT NULL AND coalesce(v_req.days_count, 0) > v_remaining THEN
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

-- ============ kadr_audit_log_trigger ============
CREATE OR REPLACE FUNCTION public.kadr_audit_log_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp_field TEXT;
  v_emp UUID;
  v_row_id TEXT;
  v_before JSONB;
  v_after  JSONB;
  v_email TEXT;
BEGIN
  v_emp_field := COALESCE(TG_ARGV[0], 'employee_id');

  IF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD);
    v_after  := NULL;
    v_row_id := COALESCE(v_before ->> 'id', '');
    BEGIN v_emp := (v_before ->> v_emp_field)::uuid; EXCEPTION WHEN others THEN v_emp := NULL; END;
  ELSIF TG_OP = 'INSERT' THEN
    v_before := NULL;
    v_after  := to_jsonb(NEW);
    v_row_id := COALESCE(v_after ->> 'id', '');
    BEGIN v_emp := (v_after ->> v_emp_field)::uuid; EXCEPTION WHEN others THEN v_emp := NULL; END;
  ELSE
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_row_id := COALESCE(v_after ->> 'id', v_before ->> 'id', '');
    BEGIN v_emp := COALESCE((v_after ->> v_emp_field)::uuid, (v_before ->> v_emp_field)::uuid); EXCEPTION WHEN others THEN v_emp := NULL; END;
  END IF;

  BEGIN
    SELECT u.email INTO v_email FROM auth.users u WHERE u.id = auth.uid();
  EXCEPTION WHEN others THEN
    v_email := NULL;
  END;

  INSERT INTO kadr_audit_log (
    actor_user_id, actor_email, action, table_name, row_id, employee_id,
    before_data, after_data
  ) VALUES (
    auth.uid(), v_email, TG_OP, TG_TABLE_NAME, v_row_id, v_emp,
    v_before, v_after
  );

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$
;

-- ============ kadr_can_manage_hr ============
CREATE OR REPLACE FUNCTION public.kadr_can_manage_hr()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.current_user_is_hr_or_admin() OR public.current_user_can_manage_employee_pii();
$function$
;

-- ============ kadr_dashboard_action_stack ============
CREATE OR REPLACE FUNCTION public.kadr_dashboard_action_stack(p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_items jsonb := '[]'::jsonb;
  v_today date := CURRENT_DATE;
  v_year_curr int := EXTRACT(year FROM v_today)::int;
  v_month_prev_start date := (DATE_TRUNC('month', v_today::timestamp) - interval '1 month')::date;
  v_month_prev_end date := (DATE_TRUNC('month', v_today::timestamp) - interval '1 day')::date;
  v_is_admin boolean := public.current_user_is_admin();
  v_is_hr boolean := public.current_user_is_hr();
  v_can_manage_vacreq boolean := public.current_user_can_manage_vacreq();
BEGIN
  IF v_is_hr OR v_is_admin THEN
    v_items := v_items || COALESCE((
      SELECT jsonb_agg(x.obj)
      FROM (
        SELECT jsonb_build_object(
          'id', 'contract_' || c.id::text,
          'type', 'contract_expiring',
          'priority', CASE WHEN c.date_to - v_today < 7 THEN 90 ELSE 50 END,
          'title', 'Ugovor ističe — ' || e.full_name,
          'subtitle', COALESCE(c.contract_type, '') || ' • do ' || c.date_to::text,
          'deep_link_tab', 'contracts',
          'deep_link_filter', jsonb_build_object('employee_id', c.employee_id::text)
        ) AS obj
        FROM public.contracts c
        JOIN public.employees e ON e.id = c.employee_id
        WHERE c.is_active IS TRUE
          AND c.date_to >= v_today
          AND c.date_to <= v_today + interval '30 days'
          AND e.is_active IS TRUE
        ORDER BY c.date_to ASC
        LIMIT 10
      ) x
    ), '[]'::jsonb);
  END IF;
  IF v_is_hr OR v_is_admin THEN
    v_items := v_items || COALESCE((
      SELECT jsonb_agg(x.obj)
      FROM (
        SELECT jsonb_build_object(
          'id', 'medical_' || e.id::text,
          'type', 'medical_expiring',
          'priority', CASE WHEN e.medical_exam_expires - v_today < 7 THEN 95 ELSE 60 END,
          'title', 'Lekarski ističe — ' || e.full_name,
          'subtitle', 'do ' || e.medical_exam_expires::text,
          'deep_link_tab', 'employees',
          'deep_link_filter', jsonb_build_object('employee_id', e.id::text)
        ) AS obj
        FROM public.employees e
        WHERE e.is_active IS TRUE
          AND e.medical_exam_expires IS NOT NULL
          AND e.medical_exam_expires >= v_today
          AND e.medical_exam_expires <= v_today + interval '30 days'
        ORDER BY e.medical_exam_expires ASC
        LIMIT 10
      ) x
    ), '[]'::jsonb);
  END IF;
  IF v_is_hr OR v_is_admin THEN
    v_items := v_items || COALESCE((
      SELECT jsonb_agg(x.obj)
      FROM (
        SELECT jsonb_build_object(
          'id', 'birthday_' || e.id::text,
          'type', 'birthday_this_week',
          'priority', 45,
          'title', '🎂 ' || e.full_name,
          'subtitle', 'Rođendan ' || to_char(e.birth_date, 'DD.MM.'),
          'deep_link_tab', 'employees',
          'deep_link_filter', jsonb_build_object('employee_id', e.id::text)
        ) AS obj
        FROM public.employees e
        WHERE e.is_active IS TRUE
          AND e.birth_date IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM generate_series(v_today, v_today + interval '7 days', interval '1 day') AS ds(d)
            WHERE to_char((ds.d)::date, 'MM-DD') = to_char(e.birth_date, 'MM-DD')
          )
        LIMIT 10
      ) x
    ), '[]'::jsonb);
  END IF;
  IF v_is_hr OR v_is_admin THEN
    v_items := v_items || COALESCE((
      SELECT jsonb_agg(x.obj)
      FROM (
        SELECT jsonb_build_object(
          'id', 'notif_' || knl.id::text,
          'type', 'queued_notification',
          'priority', 70,
          'title', '🔔 ' || COALESCE(knl.subject, 'Notifikacija'),
          'subtitle', COALESCE(knl.notification_type, '') || ' • ' || COALESCE(knl.channel, ''),
          'deep_link_tab', 'notifications',
          'deep_link_filter', jsonb_build_object('status', 'queued')
        ) AS obj
        FROM public.kadr_notification_log knl
        WHERE knl.status = 'queued'
        ORDER BY knl.scheduled_at ASC NULLS LAST
        LIMIT 5
      ) x
    ), '[]'::jsonb);
  END IF;
  IF v_can_manage_vacreq THEN
    v_items := v_items || COALESCE((
      SELECT jsonb_agg(x.obj)
      FROM (
        SELECT jsonb_build_object(
          'id', 'vacreq_' || vr.id::text,
          'type', 'pending_vac_request',
          'priority', 80,
          'title', '✋ Zahtev za GO — ' || e.full_name,
          'subtitle', 'od ' || vr.date_from::text || ' do ' || vr.date_to::text,
          'deep_link_tab', 'vac-requests',
          'deep_link_filter', jsonb_build_object(
            'status', 'pending',
            'employee_id', vr.employee_id::text
          )
        ) AS obj
        FROM public.vacation_requests vr
        JOIN public.employees e ON e.id = vr.employee_id
        WHERE vr.status = 'pending'
          AND e.is_active IS TRUE
          AND public.current_user_manages_employee(vr.employee_id)
        ORDER BY vr.created_at DESC NULLS LAST
        LIMIT 10
      ) x
    ), '[]'::jsonb);
  END IF;
  IF v_is_hr AND NOT v_is_admin THEN
    v_items := v_items || COALESCE((
      SELECT jsonb_agg(x.obj)
      FROM (
        SELECT jsonb_build_object(
          'id', 'missing_grid_' || e.id::text,
          'type', 'missing_grid_prev_month',
          'priority', 85,
          'title', '⚠ Nedostaje grid — ' || e.full_name,
          'subtitle', 'Prošli mesec: 0 sati upisano',
          'deep_link_tab', 'grid',
          'deep_link_filter', jsonb_build_object(
            'employee_id', e.id::text,
            'year', EXTRACT(year FROM v_month_prev_start)::int,
            'month', EXTRACT(month FROM v_month_prev_start)::int
          )
        ) AS obj
        FROM public.employees e
        WHERE e.is_active IS TRUE
          AND e.work_type = 'ugovor'
          AND NOT EXISTS (
            SELECT 1
            FROM public.work_hours wh
            WHERE wh.employee_id = e.id
              AND wh.work_date >= v_month_prev_start
              AND wh.work_date <= v_month_prev_end
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.absences a
            WHERE a.employee_id = e.id
              AND a.date_from <= v_month_prev_start
              AND a.date_to >= v_month_prev_end
          )
        ORDER BY e.full_name ASC NULLS LAST, e.id ASC
        LIMIT 10
      ) x
    ), '[]'::jsonb);
  END IF;
  IF v_is_hr OR v_is_admin THEN
    v_items := v_items || COALESCE((
      SELECT jsonb_agg(x.obj)
      FROM (
        SELECT jsonb_build_object(
          'id', 'vac_high_' || vb.employee_id::text,
          'type', 'vacation_balance_high',
          'priority', 25,
          'title', '🏖️ Visok saldo GO — ' || e.full_name,
          'subtitle', vb.days_remaining::text || ' preostalih dana ' || v_year_curr::text,
          'deep_link_tab', 'vacation',
          'deep_link_filter', jsonb_build_object(
            'employee_id', vb.employee_id::text,
            'year', v_year_curr
          )
        ) AS obj
        FROM public.v_vacation_balance vb
        JOIN public.employees e ON e.id = vb.employee_id
        WHERE vb.year = v_year_curr
          AND vb.days_remaining > 15
          AND e.is_active IS TRUE
        ORDER BY vb.days_remaining DESC
        LIMIT 5
      ) x
    ), '[]'::jsonb);
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(sub.entity ORDER BY sub.prio DESC)
    FROM (
      SELECT
        t.entity,
        (t.entity->>'priority')::int AS prio
      FROM jsonb_array_elements(v_items) AS t(entity)
      ORDER BY (t.entity->>'priority')::int DESC
      LIMIT GREATEST(COALESCE(p_limit, 10), 1)
    ) sub
  ), '[]'::jsonb);
END;
$function$
;

-- ============ kadr_dashboard_kpis ============
CREATE OR REPLACE FUNCTION public.kadr_dashboard_kpis(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_year int := coalesce(p_year, extract(year from current_date)::int);
  v_month int := coalesce(p_month, extract(month from current_date)::int);
  v_month_start date := make_date(v_year, v_month, 1);
  v_month_end date := (v_month_start + interval '1 month' - interval '1 day')::date;
  v_today date := current_date;
  v_is_admin boolean := public.current_user_is_admin();
  v_is_hr boolean := public.current_user_is_hr();
  v_is_menadzment boolean := exists (
    select 1
    from public.user_roles ur
    where lower(ur.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and ur.role = 'menadzment'
      and ur.is_active is true
  );
  v_managed_ids int[] := public.current_user_managed_sub_department_ids();
  v_managed_eff int[] := nullif(v_managed_ids, array[]::int[]);
  v_no_scope boolean := v_is_admin OR v_is_hr OR (v_is_menadzment AND v_managed_eff is null);
BEGIN
  RETURN jsonb_build_object(
    'year', v_year,
    'month', v_month,
    'scope_kind', (
      case
        when v_is_admin then 'admin'
        when v_is_hr then 'hr'
        when v_is_menadzment and v_managed_eff is null then 'menadzment_full'
        when v_is_menadzment then 'menadzment_scoped'
        else 'viewer'
      end
    ),
    'managed_sub_department_ids', to_jsonb(v_managed_eff),
    'active_employees', (
      select count(*)::int
      from public.employees e
      where e.is_active is true
        and (v_no_scope or e.sub_department_id = any (v_managed_eff))
    ),
    'on_absence_today', (
      select count(distinct a.employee_id)::int
      from public.absences a
      join public.employees e on e.id = a.employee_id
      where a.date_from <= v_today
        and a.date_to >= v_today
        and e.is_active is true
        and (v_no_scope or e.sub_department_id = any (v_managed_eff))
    ),
    'pending_vac_requests', (
      select count(*)::int
      from public.vacation_requests vr
      join public.employees e on e.id = vr.employee_id
      where vr.status in ('pending','sef_approved')
        and e.is_active is true
        and (v_no_scope or e.sub_department_id = any (v_managed_eff))
    ),
    'pending_makeup', (
      select count(*)::int
      from public.makeup_requests m
      join public.employees e on e.id = m.employee_id
      where m.status in ('pending','sef_approved')
        and e.is_active is true
        and (v_no_scope or e.sub_department_id = any (v_managed_eff))
    ),
    'pending_paid_leave', (
      select count(*)::int
      from public.paid_leave_requests pl
      join public.employees e on e.id = pl.employee_id
      where pl.status in ('pending','sef_approved')
        and e.is_active is true
        and (v_no_scope or e.sub_department_id = any (v_managed_eff))
    ),
    'grid_fill_percent', (
      with active_emps as (
        select e.id
        from public.employees e
        where e.is_active is true
          and (v_no_scope or e.sub_department_id = any (v_managed_eff))
      ),
      wd as (
        select count(*)::numeric as n
        from generate_series(v_month_start, v_month_end, interval '1 day') g(dt)
        where extract(isodow from g.dt::date) < 6
      ),
      expected as (
        select
          (select count(*)::numeric from active_emps) * 8.0 * (select n from wd) as hrs
      ),
      actual as (
        select coalesce(sum(wh.hours), 0)::numeric as hrs
        from public.work_hours wh
        where wh.employee_id in (select id from active_emps)
          and wh.work_date >= v_month_start
          and wh.work_date <= v_month_end
      )
      select case
        when (select hrs from expected) = 0 then 0::numeric
        else round(
          (select hrs from actual) * 100.0 / (select hrs from expected),
          1
        )
      end
    )
  );
END
$function$
;

-- ============ kadr_dashboard_mini_reports ============
CREATE OR REPLACE FUNCTION public.kadr_dashboard_mini_reports(p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_year int := COALESCE(p_year, EXTRACT(year FROM CURRENT_DATE)::int);
  v_month int := COALESCE(p_month, EXTRACT(month FROM CURRENT_DATE)::int);
  v_month_start date := make_date(v_year, v_month, 1);
  v_month_end date := (v_month_start + INTERVAL '1 month' - INTERVAL '1 day')::date;
  v_managed_ids int[] := public.current_user_managed_sub_department_ids();
  v_managed_eff int[] := nullif(v_managed_ids, array[]::int[]);
  v_is_admin boolean := public.current_user_is_admin();
  v_is_hr boolean := public.current_user_is_hr();
  v_is_menadzment boolean := EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE lower(ur.email) = lower(COALESCE(auth.jwt() ->> 'email', ''))
      AND ur.role = 'menadzment'
      AND ur.is_active IS TRUE
  );
  v_no_scope boolean := v_is_admin OR v_is_hr OR (v_is_menadzment AND v_managed_eff IS NULL);
  v_allow boolean := v_is_admin OR v_is_hr OR v_is_menadzment;
BEGIN
  RETURN jsonb_build_object(
    'year', v_year,
    'month', v_month,
    'scope_kind', CASE
      WHEN v_is_admin THEN 'admin'
      WHEN v_is_hr THEN 'hr'
      WHEN v_is_menadzment AND v_managed_eff IS NULL THEN 'menadzment_full'
      WHEN v_is_menadzment THEN 'menadzment_scoped'
      ELSE 'no_access'
    END,
    'managed_sub_department_ids', to_jsonb(v_managed_eff),
    'employees_by_department', CASE
      WHEN NOT v_allow THEN '[]'::jsonb
      WHEN v_no_scope THEN COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object('department', dept, 'count', cnt)
                 ORDER BY cnt DESC
               )
        FROM (
          SELECT
            COALESCE(e.department, 'Bez odeljenja') AS dept,
            COUNT(*)::int AS cnt
          FROM public.employees e
          WHERE e.is_active IS TRUE
          GROUP BY 1
        ) t
      ), '[]'::jsonb)
      ELSE COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object('department', dept, 'count', cnt)
                 ORDER BY cnt DESC
               )
        FROM (
          SELECT
            COALESCE(sd.name, 'Bez pododeljenja') AS dept,
            COUNT(*)::int AS cnt
          FROM public.employees e
          LEFT JOIN public.sub_departments sd ON sd.id = e.sub_department_id
          WHERE e.is_active IS TRUE
            AND e.sub_department_id = ANY (v_managed_eff)
          GROUP BY COALESCE(sd.name, 'Bez pododeljenja')
        ) t
      ), '[]'::jsonb)
    END,
    'hours_per_day', CASE
      WHEN NOT v_allow THEN '[]'::jsonb
      ELSE COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object(
                   'date', to_char(days.day_d, 'YYYY-MM-DD'),
                   'hours', COALESCE(daily.hrs, 0)
                 )
                 ORDER BY days.day_d
               )
        FROM (
          SELECT (g.d)::date AS day_d
          FROM generate_series(v_month_start, v_month_end, INTERVAL '1 day') AS g(d)
        ) days
        LEFT JOIN (
          SELECT wh.work_date, SUM(wh.hours)::numeric(8, 2) AS hrs
          FROM public.work_hours wh
          JOIN public.employees e ON e.id = wh.employee_id
          WHERE wh.work_date >= v_month_start
            AND wh.work_date <= v_month_end
            AND e.is_active IS TRUE
            AND (v_no_scope OR e.sub_department_id = ANY (v_managed_eff))
          GROUP BY wh.work_date
        ) daily ON daily.work_date = days.day_d
      ), '[]'::jsonb)
    END,
    'absences_by_type', CASE
      WHEN NOT v_allow THEN '[]'::jsonb
      ELSE COALESCE((
        SELECT jsonb_agg(
                 jsonb_build_object('type', a_type, 'days', a_days)
                 ORDER BY a_days DESC
               )
        FROM (
          SELECT
            a.type AS a_type,
            SUM(a.days_count)::int AS a_days
          FROM public.absences a
          JOIN public.employees e ON e.id = a.employee_id
          WHERE a.date_from <= v_month_end
            AND a.date_to >= v_month_start
            AND e.is_active IS TRUE
            AND (v_no_scope OR e.sub_department_id = ANY (v_managed_eff))
          GROUP BY a.type
          HAVING SUM(a.days_count) > 0
        ) t
      ), '[]'::jsonb)
    END
  );
END;
$function$
;

-- ============ kadr_delete_makeup ============
CREATE OR REPLACE FUNCTION public.kadr_delete_makeup(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_req public.makeup_requests%ROWTYPE; v_actor text; v_is_admin boolean;
BEGIN
  SELECT * INTO v_req FROM makeup_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  v_actor := lower(COALESCE(auth.jwt()->>'email',''));
  v_is_admin := public.current_user_can_manage_employee_pii()
    OR EXISTS (SELECT 1 FROM public.user_roles ur WHERE lower(ur.email)=v_actor AND ur.role='hr' AND ur.is_active);
  IF v_req.status IN ('approved','completed') THEN RAISE EXCEPTION 'must_storno_first'; END IF;
  IF NOT (v_is_admin OR (lower(COALESCE(v_req.submitted_by,'')) = v_actor AND v_req.status IN ('pending','sef_approved','rejected'))) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  DELETE FROM makeup_requests WHERE id = p_request_id;
  RETURN jsonb_build_object('ok', true);
END; $function$
;

-- ============ kadr_dispatch_dequeue ============
CREATE OR REPLACE FUNCTION public.kadr_dispatch_dequeue(p_batch_size integer DEFAULT 25, p_max_attempts integer DEFAULT 8)
 RETURNS SETOF kadr_notification_log
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM public.kadr_notification_log
     WHERE status IN ('queued', 'failed')
       AND next_attempt_at <= now()
       AND attempts < p_max_attempts
     ORDER BY next_attempt_at ASC, created_at ASC
     LIMIT p_batch_size
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.kadr_notification_log n
     SET attempts = n.attempts + 1, last_attempt_at = now(), status = 'queued'
   FROM picked p
  WHERE n.id = p.id
  RETURNING n.*;
END;
$function$
;

-- ============ kadr_dispatch_mark_failed ============
CREATE OR REPLACE FUNCTION public.kadr_dispatch_mark_failed(p_id uuid, p_error text, p_backoff_sec integer DEFAULT 300)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.kadr_notification_log
     SET status = 'failed',
         error = LEFT(COALESCE(p_error, ''), 1000),
         next_attempt_at = now() + make_interval(secs => GREATEST(p_backoff_sec, 30))
   WHERE id = p_id;
$function$
;

-- ============ kadr_dispatch_mark_sent ============
CREATE OR REPLACE FUNCTION public.kadr_dispatch_mark_sent(p_ids uuid[])
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH upd AS (
    UPDATE public.kadr_notification_log
       SET status = 'sent', sent_at = now(), error = NULL
     WHERE id = ANY (p_ids)
    RETURNING 1
  )
  SELECT count(*)::int FROM upd;
$function$
;

-- ============ kadr_get_contract_bruto ============
CREATE OR REPLACE FUNCTION public.kadr_get_contract_bruto(p_employee_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN public.current_user_can_manage_employee_pii() THEN (
    SELECT coalesce(st.bruto_rsd, CASE WHEN st.amount_type = 'bruto' THEN st.amount END)
    FROM public.salary_terms st
    WHERE st.employee_id = p_employee_id
      AND (st.effective_from IS NULL OR st.effective_from <= current_date)
      AND (st.effective_to IS NULL OR st.effective_to >= current_date)
    ORDER BY st.effective_from DESC NULLS LAST, st.created_at DESC
    LIMIT 1
  ) END;
$function$
;

-- ============ kadr_get_contract_salary ============
CREATE OR REPLACE FUNCTION public.kadr_get_contract_salary(p_employee_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN public.current_user_can_manage_employee_pii() THEN (
    SELECT jsonb_build_object(
      'term_id',        st.id,
      'neto_rsd',       st.neto_rsd,
      'bruto_rsd',      st.bruto_rsd,
      'amount',         st.amount,
      'amount_type',    st.amount_type,
      'currency',       st.currency,
      'salary_type',    st.salary_type,
      'effective_from', st.effective_from,
      'approved_by',    st.approved_by,
      'approved_at',    st.approved_at
    )
    FROM public.salary_terms st
    WHERE st.employee_id = p_employee_id
      AND (st.effective_from IS NULL OR st.effective_from <= current_date)
      AND (st.effective_to IS NULL OR st.effective_to >= current_date)
    ORDER BY st.effective_from DESC NULLS LAST, st.created_at DESC
    LIMIT 1
  ) END;
$function$
;

-- ============ kadr_grant_bonus_go ============
CREATE OR REPLACE FUNCTION public.kadr_grant_bonus_go(p_employee_id uuid, p_work_date date, p_days numeric DEFAULT 1, p_reason text DEFAULT ''::text, p_makeup_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_year int; v_actor text; v_id uuid; v_note text;
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
  -- dedup: isti zaposleni + isti dan rada ne sme dva puta
  IF p_work_date IS NOT NULL AND EXISTS (
    SELECT 1 FROM vacation_bonus_days b WHERE b.employee_id = p_employee_id AND b.work_date = p_work_date
  ) THEN RAISE EXCEPTION 'already_granted'; END IF;

  INSERT INTO vacation_bonus_days (employee_id, year, days, work_date, reason, makeup_request_id, added_by)
  VALUES (p_employee_id, v_year, p_days, p_work_date, COALESCE(p_reason, ''), p_makeup_request_id, v_actor)
  RETURNING id INTO v_id;

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
  RETURN jsonb_build_object('ok', true, 'bonus_id', v_id, 'year', v_year);
END;
$function$
;

-- ============ kadr_grid_set_go ============
CREATE OR REPLACE FUNCTION public.kadr_grid_set_go(p_employee_id uuid, p_date_from date, p_date_to date, p_actor text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF p_employee_id IS NULL OR p_date_from IS NULL OR p_date_to IS NULL
     OR p_date_to < p_date_from THEN
    RETURN 0;
  END IF;

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

-- ============ kadr_grid_unset_go ============
CREATE OR REPLACE FUNCTION public.kadr_grid_unset_go(p_employee_id uuid, p_date_from date, p_date_to date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF p_employee_id IS NULL OR p_date_from IS NULL OR p_date_to IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM work_hours
   WHERE employee_id = p_employee_id
     AND work_date BETWEEN p_date_from AND p_date_to
     AND absence_code = 'go';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$
;

-- ============ kadr_makeup_actor_allowed ============
CREATE OR REPLACE FUNCTION public.kadr_makeup_actor_allowed(p_employee_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.current_user_can_manage_employee_pii()
      OR EXISTS (SELECT 1 FROM public.user_roles ur
                  WHERE lower(ur.email) = lower(COALESCE(auth.jwt()->>'email',''))
                    AND ur.role = 'hr' AND ur.is_active)
      OR EXISTS (SELECT 1 FROM public.user_roles ur
                  JOIN public.employees emp ON emp.id = p_employee_id
                  WHERE lower(ur.email) = lower(COALESCE(auth.jwt()->>'email',''))
                    AND ur.role = 'menadzment' AND ur.is_active
                    AND emp.sub_department_id IS NOT NULL
                    AND ur.managed_sub_department_ids @> ARRAY[emp.sub_department_id]);
$function$
;

-- ============ kadr_medical_exams_sync_employee ============
CREATE OR REPLACE FUNCTION public.kadr_medical_exams_sync_employee()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp UUID;
  v_latest_date   DATE;
  v_latest_until  DATE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_emp := OLD.employee_id;
  ELSE
    v_emp := NEW.employee_id;
  END IF;

  SELECT exam_date, valid_until
    INTO v_latest_date, v_latest_until
    FROM kadr_medical_exams
    WHERE employee_id = v_emp
    ORDER BY exam_date DESC, created_at DESC
    LIMIT 1;

  UPDATE employees
     SET medical_exam_date    = v_latest_date,
         medical_exam_expires = v_latest_until
   WHERE id = v_emp;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ kadr_notify_push_trg ============
CREATE OR REPLACE FUNCTION public.kadr_notify_push_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net'
AS $function$
declare
  v_url   text := 'https://fniruhsuotwsrjsbhrxd.supabase.co/functions/v1/push-dispatch';
  v_key   text := (select value from private.app_config where key = 'push_dispatch_key');
  v_deep  text := '/m';
  v_title text; v_msg text;
begin
  if new.recipient is null or new.recipient = '' then return new; end if;
  if coalesce(new.channel, 'email') <> 'email' then return new; end if;
  if coalesce(new.status, 'queued') not in ('queued', 'pending') then return new; end if;
  v_title := coalesce(nullif(new.subject, ''), 'SERVOSYNC obaveštenje');
  v_msg := left(btrim(regexp_replace(coalesce(new.body, ''), '<[^>]+>', ' ', 'g')), 140);
  if new.notification_type ilike 'vacation%' or new.notification_type ilike 'go%' then v_deep := '/m/odsustva';
  elsif new.notification_type ilike 'contract%' then v_deep := '/m/profil'; end if;
  perform net.http_post(url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-push-key', v_key),
    body := jsonb_build_object('emails', jsonb_build_array(lower(new.recipient)),'title', v_title,'message', v_msg,'url', v_deep,'tag', coalesce(new.notification_type,'servosync')));
  return new;
exception when others then return new;
end $function$
;

-- ============ kadr_onboarding_start ============
CREATE OR REPLACE FUNCTION public.kadr_onboarding_start(p_employee_id uuid, p_template_id uuid, p_start_date date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_run uuid; v_kind text; v_start date := COALESCE(p_start_date, current_date);
        v_email text := lower(COALESCE(auth.jwt() ->> 'email', ''));
BEGIN
  IF NOT public.kadr_can_manage_hr() THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501'; END IF;
  SELECT kind INTO v_kind FROM public.kadr_onboarding_templates WHERE id = p_template_id;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'template_not_found'; END IF;

  INSERT INTO public.kadr_onboarding_runs(employee_id, template_id, kind, start_date, created_by)
    VALUES (p_employee_id, p_template_id, v_kind, v_start, v_email)
    RETURNING id INTO v_run;

  INSERT INTO public.kadr_onboarding_tasks(run_id, title, description, sort_order, due_date, assignee_hint)
    SELECT v_run, title, description, sort_order,
           v_start + COALESCE(offset_days, 0), assignee_hint
    FROM public.kadr_onboarding_template_items WHERE template_id = p_template_id;

  RETURN v_run;
END; $function$
;

-- ============ kadr_oversight_recipients ============
CREATE OR REPLACE FUNCTION public.kadr_oversight_recipients(p_employee_id uuid)
 RETURNS TABLE(email text, role_label text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT DISTINCT lower(ur.email), 'sef'::text
    FROM public.employees e
    JOIN public.user_roles ur
      ON ur.role = 'menadzment'
     AND ur.is_active
     AND ur.managed_sub_department_ids @> ARRAY[e.sub_department_id]
   WHERE e.id = p_employee_id
     AND e.sub_department_id IS NOT NULL
     AND ur.email IS NOT NULL AND ur.email <> ''
  UNION
  SELECT DISTINCT lower(ur.email), 'uprava'::text
    FROM public.user_roles ur
   WHERE ur.role = 'admin'
     AND ur.is_active
     AND ur.email IS NOT NULL AND ur.email <> '';
$function$
;

-- ============ kadr_payroll_init_month ============
CREATE OR REPLACE FUNCTION public.kadr_payroll_init_month(p_year integer, p_month integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count INT := 0;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'invalid month %', p_month;
  END IF;

  WITH ins AS (
    INSERT INTO public.salary_payroll (
      employee_id, period_year, period_month,
      salary_type, compensation_model,
      fixed_salary, hourly_rate,
      transport_rsd, per_diem_rsd, per_diem_eur,
      status, warnings
    )
    SELECT
      e.id, p_year, p_month,
      COALESCE(s.salary_type, 'ugovor'),
      s.compensation_model,
      CASE WHEN COALESCE(s.salary_type,'ugovor') IN ('ugovor','dogovor')
           THEN COALESCE(s.amount, 0) ELSE 0 END,
      CASE WHEN s.salary_type = 'satnica'
           THEN COALESCE(s.amount, 0) ELSE 0 END,
      COALESCE(s.transport_allowance_rsd, 0),
      COALESCE(s.per_diem_rsd, 0),
      COALESCE(s.per_diem_eur, 0),
      'draft',
      CASE
        WHEN s.employee_id IS NULL
          THEN '[{"code":"no_salary_terms","message":"Zaposleni nema aktivne uslove zarade — obračun je 0."}]'::jsonb
        WHEN s.compensation_model IS NULL
          THEN '[{"code":"no_compensation_model","message":"Aktivni uslov zarade nema definisan tip zarade (compensation_model)."}]'::jsonb
        ELSE '[]'::jsonb
      END
    FROM public.employees e
    LEFT JOIN public.v_employee_current_salary s ON s.employee_id = e.id
    WHERE e.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM public.salary_payroll p
         WHERE p.employee_id = e.id
           AND p.period_year = p_year
           AND p.period_month = p_month
      )
    RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM ins;

  RETURN v_count;
END;
$function$
;

-- ============ kadr_payroll_unlock ============
CREATE OR REPLACE FUNCTION public.kadr_payroll_unlock(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row salary_payroll%ROWTYPE;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'permission_denied'
      USING ERRCODE = '42501', HINT = 'Samo administrator može da otključa mesec.';
  END IF;

  /* Setuj session GUC tako da naredni UPDATE (status: paid → finalized)
     prođe kroz immutability trigger. set_config(..., true) je lokalan za
     transakciju — ne curi van. */
  PERFORM set_config('payroll.unlock_ok', 'on', true);

  UPDATE salary_payroll
     SET status = 'finalized'
   WHERE id = p_id
     AND status = 'paid'
   RETURNING * INTO v_row;

  IF NOT FOUND THEN
    /* Ili red ne postoji, ili nije bio u 'paid' statusu. Idempotent — ne
       bacamo grešku, samo izveštaj. */
    RETURN jsonb_build_object(
      'status', 'noop',
      'id', p_id,
      'reason', 'not_paid_or_missing'
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'unlocked',
    'id', p_id,
    'new_status', 'finalized',
    'updated_at', v_row.updated_at
  );
END $function$
;

-- ============ kadr_pulse_notify_dispatch ============
CREATE OR REPLACE FUNCTION public.kadr_pulse_notify_dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url    text;
  v_bearer text;
  v_headers jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RETURN;
  END IF;

  SELECT NULLIF(btrim(ds.decrypted_secret), '')
    INTO v_url
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'kadr_notify_dispatch_url'
   LIMIT 1;
  IF v_url IS NULL THEN RETURN; END IF;

  SELECT btrim(ds.decrypted_secret)
    INTO v_bearer
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'kadr_notify_dispatch_bearer'
   LIMIT 1;

  IF v_bearer IS NOT NULL AND length(v_bearer) > 0 THEN
    IF strpos(lower(v_bearer), 'bearer ') = 1 THEN
      v_headers := jsonb_build_object('Authorization', v_bearer, 'Content-Type', 'application/json');
    ELSE
      v_headers := jsonb_build_object('Authorization', 'Bearer ' || v_bearer, 'Content-Type', 'application/json');
    END IF;
  ELSE
    v_headers := jsonb_build_object('Content-Type', 'application/json');
  END IF;

  PERFORM net.http_post(url := v_url, headers := v_headers, body := '{}'::jsonb);
END;
$function$
;

-- ============ kadr_queue_document_email ============
CREATE OR REPLACE FUNCTION public.kadr_queue_document_email(p_employee_id uuid, p_doc_type text, p_storage_path text, p_file_name text, p_label text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp_name  text;
  v_emp_email text;
  v_label     text;
  v_subject   text;
  v_body      text;
  v_payload   jsonb;
BEGIN
  IF NOT public.current_user_can_manage_employee_pii() THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  IF p_storage_path IS NULL OR p_storage_path = '' THEN
    RETURN jsonb_build_object('status', 'no_path');
  END IF;

  SELECT COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni'), e.email
    INTO v_emp_name, v_emp_email
  FROM employees e
  WHERE e.id = p_employee_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  IF v_emp_email IS NULL OR v_emp_email = '' THEN
    RETURN jsonb_build_object('status', 'no_email');
  END IF;

  v_label := COALESCE(NULLIF(p_label, ''), CASE p_doc_type
      WHEN 'resenje_go'          THEN 'Re�enje o godi�njem odmoru'
      WHEN 'aneks'               THEN 'Aneks ugovora o radu'
      WHEN 'potvrda_zaposlenje'  THEN 'Potvrda o zaposlenju'
      WHEN 'potvrda_primanja'    THEN 'Potvrda o visini primanja'
      WHEN 'resenje_porodiljsko' THEN 'Re�enje o porodiljskom odsustvu'
      ELSE 'Dokument'
    END);

  v_subject := v_label || ' � ' || v_emp_name;
  v_body :=
    '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
    || '<h2 style="color:#2563eb;margin-bottom:4px;">?? ' || v_label || '</h2>'
    || '<p>Po�tovani/a <strong>' || v_emp_name || '</strong>,</p>'
    || '<p>U prilogu se nalazi Va� dokument: <strong>' || v_label || '</strong> (PDF).</p>'
    || '<p style="font-size:.9em;color:#64748b;">Dokument je izdao poslodavac �Servoteh" d.o.o. '
    || 'Za sva pitanja obratite se kadrovskoj slu�bi.</p>'
    || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
    || '<p style="font-size:.85em;color:#64748b;">Srdacan pozdrav,<br><em>HR odeljenje � Servoteh</em></p>'
    || '</div>';

  v_payload := jsonb_build_object(
    'attachment_bucket',   'employee-docs',
    'attachment_path',     p_storage_path,
    'attachment_filename', COALESCE(NULLIF(p_file_name, ''), 'dokument.pdf'),
    'doc_type',            p_doc_type
  );

  INSERT INTO kadr_notification_log (
    channel, recipient, subject, body, notification_type,
    employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at
  ) VALUES (
    'email', v_emp_email, v_subject, v_body, 'document_issued',
    p_employee_id, 'employee_document', NULL, v_payload, 'queued', now()
  );

  RETURN jsonb_build_object('status', 'queued', 'recipient', v_emp_email);
END;
$function$
;

-- ============ kadr_queue_makeup_notification ============
CREATE OR REPLACE FUNCTION public.kadr_queue_makeup_notification(p_request_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp_name   text; v_emp_email text; v_emp_id uuid;
  v_abs_date   date; v_hours numeric; v_deadline date; v_plan text; v_reason text;
  v_subject    text; v_emp_body text; v_over_body text; v_payload jsonb;
BEGIN
  SELECT COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni'),
         e.email, e.id, m.absence_date, m.absence_hours, m.makeup_deadline, m.makeup_plan, m.reason
    INTO v_emp_name, v_emp_email, v_emp_id, v_abs_date, v_hours, v_deadline, v_plan, v_reason
    FROM makeup_requests m JOIN employees e ON e.id = m.employee_id
   WHERE m.id = p_request_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_payload := jsonb_build_object('status', p_status, 'absence_date', v_abs_date,
                                  'hours', v_hours, 'deadline', v_deadline);

  IF p_status = 'submitted' THEN
    v_subject := 'Nov zahtev — nadoknada sati — ' || v_emp_name;
  ELSIF p_status = 'sef_approved' THEN
    v_subject := 'Nadoknada sati — odobrio šef, čeka HR — ' || v_emp_name;
  ELSIF p_status = 'approved' THEN
    v_subject := 'Nadoknada sati — odobreno — ' || v_emp_name;
    v_emp_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#16a34a;margin-bottom:4px;">✅ Nadoknada sati odobrena</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>,</p>'
      || '<p>Odobren je izostanak uz nadoknadu sati za <strong>' || to_char(v_abs_date,'DD.MM.YYYY')
      || '</strong> (' || v_hours::text || ' h).</p>'
      || '<p>Sate je potrebno nadoknaditi'
      || CASE WHEN v_deadline IS NOT NULL THEN ' do <strong>' || to_char(v_deadline,'DD.MM.YYYY') || '</strong>' ELSE '' END
      || CASE WHEN COALESCE(v_plan,'') <> '' THEN ', prema planu: ' || v_plan ELSE '' END || '.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh HR</em></p></div>';
  ELSIF p_status = 'rejected' THEN
    v_subject := 'Nadoknada sati — odbijeno — ' || v_emp_name;
    v_emp_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#dc2626;margin-bottom:4px;">❌ Zahtev za nadoknadu sati odbijen</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>, Vaš zahtev za nadoknadu sati za <strong>'
      || to_char(v_abs_date,'DD.MM.YYYY') || '</strong> je odbijen.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh HR</em></p></div>';
  ELSE
    RETURN;
  END IF;

  /* Mejl radniku samo za approved/rejected (krajnje odluke). */
  IF p_status IN ('approved', 'rejected') AND v_emp_email IS NOT NULL AND v_emp_email <> '' THEN
    INSERT INTO kadr_notification_log (channel, recipient, subject, body, notification_type,
      employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at)
    VALUES ('email', lower(v_emp_email), v_subject, v_emp_body, 'makeup_' || p_status,
      v_emp_id, 'makeup_request', p_request_id, v_payload, 'queued', now());
  END IF;

  /* Kopija nadležnima (šef + uprava, + HR na submitted/sef_approved). */
  v_over_body :=
    '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
    || '<h2 style="margin-bottom:4px;">Nadoknada sati — ' || v_emp_name || '</h2>'
    || '<p>Datum izostanka: <strong>' || to_char(v_abs_date,'DD.MM.YYYY') || '</strong> ('
    || v_hours::text || ' h). Status: <strong>' || p_status || '</strong>.</p>'
    || CASE WHEN COALESCE(v_reason,'') <> '' THEN '<p>Razlog: ' || v_reason || '</p>' ELSE '' END
    || CASE WHEN COALESCE(v_plan,'') <> '' THEN '<p>Plan nadoknade: ' || v_plan || '</p>' ELSE '' END
    || CASE WHEN p_status IN ('submitted','sef_approved')
       THEN '<p>Na obradu u modulu Kadrovska → Nadoknada sati.</p>' ELSE '' END
    || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
    || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p></div>';

  INSERT INTO kadr_notification_log (channel, recipient, subject, body, notification_type,
    employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at)
  SELECT 'email', r.email, '[Kopija] ' || v_subject, v_over_body, 'makeup_' || p_status,
         v_emp_id, 'makeup_request', p_request_id, v_payload, 'queued', now()
  FROM (
    SELECT email FROM public.kadr_oversight_recipients(v_emp_id)
    UNION
    SELECT lower(email) FROM user_roles
     WHERE p_status IN ('submitted','sef_approved') AND role = 'hr' AND is_active = true
       AND email IS NOT NULL AND email <> ''
  ) r
  WHERE r.email IS NOT NULL AND r.email <> ''
    AND (v_emp_email IS NULL OR r.email <> lower(v_emp_email));
END;
$function$
;

-- ============ kadr_queue_nop_notification ============
CREATE OR REPLACE FUNCTION public.kadr_queue_nop_notification(p_request_id uuid, p_phase text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp_name     text;
  v_emp_email    text;
  v_emp_id       uuid;
  v_work_date    date;
  v_reason       text;
  v_status       text;
  v_requested_by text;
  v_review_note  text;
  v_subject      text;
  v_body         text;
  v_payload      jsonb;
  v_count        int := 0;
BEGIN
  SELECT
    COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni'),
    e.email, e.id,
    nr.work_date, nr.reason, nr.status, lower(nr.requested_by), nr.review_note
  INTO v_emp_name, v_emp_email, v_emp_id,
       v_work_date, v_reason, v_status, v_requested_by, v_review_note
  FROM nop_requests nr
  JOIN employees e ON e.id = nr.employee_id
  WHERE nr.id = p_request_id;

  IF NOT FOUND THEN RETURN 0; END IF;

  v_payload := jsonb_build_object(
    'phase', p_phase, 'work_date', v_work_date,
    'status', v_status, 'requested_by', v_requested_by
  );

  IF p_phase = 'requested' THEN
    v_subject := 'Predlog za neplaćeno odsustvo — ' || v_emp_name;
    v_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#b45309;margin-bottom:4px;">🟠 Predlog za neplaćeno odsustvo</h2>'
      || '<p>Podnet je predlog za <strong>neplaćeni dan</strong> koji čeka odobrenje uprave:</p>'
      || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:380px;">'
      || '<tr style="background:#fffbeb;"><td style="padding:8px 14px;border:1px solid #fde68a;">Zaposleni</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #fde68a;font-weight:600;">' || v_emp_name || '</td></tr>'
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Datum</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
      ||     to_char(v_work_date, 'DD.MM.YYYY') || '</td></tr>'
      || CASE WHEN COALESCE(v_reason, '') <> ''
         THEN '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Razlog</td>'
              || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || v_reason || '</td></tr>'
         ELSE '' END
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;font-size:.9em;color:#64748b;">Predložio/la</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-size:.9em;color:#64748b;">'
      ||     COALESCE(v_requested_by, '—') || '</td></tr>'
      || '</table>'
      || '<p style="font-size:.9em;color:#475569;">Odobravanje se vrši u modulu <strong>Kadrovska</strong>. '
      ||   'Neplaćeno odsustvo odobrava isključivo uprava.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
      || '</div>';

    -- Primaoci: uprava + šef (oversight). Podnosioca dodajemo da zna da je predlog evidentiran.
    WITH recips AS (
      SELECT DISTINCT lower(x) AS email FROM (
        SELECT email AS x FROM public.kadr_oversight_recipients(v_emp_id)
        UNION ALL SELECT v_requested_by
      ) s WHERE x IS NOT NULL AND x <> ''
    ), ins AS (
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body, notification_type,
        employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at
      )
      SELECT 'email', email, v_subject, v_body, 'nop_requested',
             v_emp_id, 'nop_request', p_request_id, v_payload, 'queued', now()
      FROM recips RETURNING 1
    )
    SELECT count(*) INTO v_count FROM ins;

  ELSIF p_phase = 'decided' THEN
    v_subject := 'Neplaćeno odsustvo — '
      || CASE WHEN v_status = 'approved' THEN 'odobreno' ELSE 'odbijeno' END
      || ' (' || to_char(v_work_date, 'DD.MM.YYYY') || ')';
    v_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="margin-bottom:4px;color:'
      ||   CASE WHEN v_status='approved' THEN '#16a34a' ELSE '#dc2626' END || ';">'
      ||   CASE WHEN v_status='approved' THEN '✅ Neplaćeno odsustvo odobreno' ELSE '❌ Neplaćeno odsustvo odbijeno' END
      || '</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>,</p>'
      || '<p>Vaš zahtev za neplaćeni dan <strong>' || to_char(v_work_date, 'DD.MM.YYYY') || '</strong> je <strong>'
      ||   CASE WHEN v_status='approved' THEN 'ODOBREN' ELSE 'ODBIJEN' END || '</strong>.</p>'
      || CASE WHEN COALESCE(v_review_note, '') <> ''
         THEN '<p><strong>Napomena:</strong> ' || v_review_note || '</p>' ELSE '' END
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;">Srdačan pozdrav,<br><em>HR odeljenje — Servoteh</em></p>'
      || '</div>';

    -- Primaoci: zaposleni + šef (oversight ima i upravu — koja je donela odluku, korisno za evidenciju).
    WITH recips AS (
      SELECT DISTINCT lower(x) AS email FROM (
        SELECT v_emp_email AS x
        UNION ALL SELECT email FROM public.kadr_oversight_recipients(v_emp_id)
      ) s WHERE x IS NOT NULL AND x <> ''
    ), ins AS (
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body, notification_type,
        employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at
      )
      SELECT 'email', email, v_subject, v_body, 'nop_decided',
             v_emp_id, 'nop_request', p_request_id, v_payload, 'queued', now()
      FROM recips RETURNING 1
    )
    SELECT count(*) INTO v_count FROM ins;
  ELSE
    RETURN 0;
  END IF;

  RETURN v_count;
END;
$function$
;

-- ============ kadr_queue_paidleave_notification ============
CREATE OR REPLACE FUNCTION public.kadr_queue_paidleave_notification(p_request_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp_name text; v_emp_email text; v_emp_id uuid;
  v_from date; v_to date; v_days int; v_type text; v_label text; v_reason text;
  v_subject text; v_emp_body text; v_over_body text; v_payload jsonb;
BEGIN
  SELECT COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni'),
         e.email, e.id, p.date_from, p.date_to, p.days_count, p.leave_type, p.reason
    INTO v_emp_name, v_emp_email, v_emp_id, v_from, v_to, v_days, v_type, v_reason
    FROM paid_leave_requests p JOIN employees e ON e.id = p.employee_id
   WHERE p.id = p_request_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT label INTO v_label FROM public.paid_leave_reason_map(v_type);
  v_payload := jsonb_build_object('status', p_status, 'leave_type', v_type,
                                  'date_from', v_from, 'date_to', v_to, 'days_count', v_days);

  IF p_status = 'submitted' THEN
    v_subject := 'Nov zahtev — plaćeno odsustvo (' || v_label || ') — ' || v_emp_name;
  ELSIF p_status = 'sef_approved' THEN
    v_subject := 'Plaćeno odsustvo — odobrio šef, čeka HR — ' || v_emp_name;
  ELSIF p_status = 'approved' THEN
    v_subject := 'Plaćeno odsustvo odobreno — ' || v_emp_name;
    v_emp_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#16a34a;margin-bottom:4px;">✅ Plaćeno odsustvo odobreno</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>,</p>'
      || '<p>Odobreno je plaćeno odsustvo (<strong>' || v_label || '</strong>) za period <strong>'
      || to_char(v_from,'DD.MM.YYYY') || ' – ' || to_char(v_to,'DD.MM.YYYY') || '</strong> ('
      || COALESCE(v_days::text,'—') || ' radnih dana).</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh HR</em></p></div>';
  ELSIF p_status = 'rejected' THEN
    v_subject := 'Plaćeno odsustvo odbijeno — ' || v_emp_name;
    v_emp_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#dc2626;margin-bottom:4px;">❌ Zahtev za plaćeno odsustvo odbijen</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>, Vaš zahtev (' || v_label || ', '
      || to_char(v_from,'DD.MM.YYYY') || ' – ' || to_char(v_to,'DD.MM.YYYY') || ') je odbijen.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh HR</em></p></div>';
  ELSE
    RETURN;
  END IF;

  IF p_status IN ('approved', 'rejected') AND v_emp_email IS NOT NULL AND v_emp_email <> '' THEN
    INSERT INTO kadr_notification_log (channel, recipient, subject, body, notification_type,
      employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at)
    VALUES ('email', lower(v_emp_email), v_subject, v_emp_body, 'paidleave_' || p_status,
      v_emp_id, 'paid_leave_request', p_request_id, v_payload, 'queued', now());
  END IF;

  v_over_body :=
    '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
    || '<h2 style="margin-bottom:4px;">Plaćeno odsustvo — ' || v_emp_name || '</h2>'
    || '<p>Osnov: <strong>' || v_label || '</strong>. Period: <strong>'
    || to_char(v_from,'DD.MM.YYYY') || ' – ' || to_char(v_to,'DD.MM.YYYY') || '</strong> ('
    || COALESCE(v_days::text,'—') || ' dana). Status: <strong>' || p_status || '</strong>.</p>'
    || CASE WHEN COALESCE(v_reason,'') <> '' THEN '<p>Obrazloženje: ' || v_reason || '</p>' ELSE '' END
    || CASE WHEN p_status IN ('submitted','sef_approved')
       THEN '<p>Na obradu u modulu Kadrovska → Plaćeno odsustvo.</p>' ELSE '' END
    || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
    || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p></div>';

  INSERT INTO kadr_notification_log (channel, recipient, subject, body, notification_type,
    employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at)
  SELECT 'email', r.email, '[Kopija] ' || v_subject, v_over_body, 'paidleave_' || p_status,
         v_emp_id, 'paid_leave_request', p_request_id, v_payload, 'queued', now()
  FROM (
    SELECT email FROM public.kadr_oversight_recipients(v_emp_id)
    UNION
    SELECT lower(email) FROM user_roles
     WHERE p_status IN ('submitted','sef_approved') AND role = 'hr' AND is_active = true
       AND email IS NOT NULL AND email <> ''
  ) r
  WHERE r.email IS NOT NULL AND r.email <> ''
    AND (v_emp_email IS NULL OR r.email <> lower(v_emp_email));
END;
$function$
;

-- ============ kadr_queue_payroll_notifications ============
CREATE OR REPLACE FUNCTION public.kadr_queue_payroll_notifications(p_period_year integer, p_period_month integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rec          record;
  v_count        int := 0;
  v_period_label text;
  v_subject      text;
  v_email_body   text;
  v_wa_body      text;
  v_payload      jsonb;
  v_total        numeric;
  v_field_row    text;
BEGIN
  v_period_label := to_char(
    make_date(p_period_year, p_period_month, 1),
    'TMMonth YYYY'
  );

  FOR v_rec IN
    SELECT
      e.id                                                       AS emp_id,
      COALESCE(e.full_name,
               e.first_name || ' ' || e.last_name,
               'Zaposleni')                                      AS emp_name,
      e.email,
      e.phone,
      COALESCE(SUM(wh.hours),           0)                       AS regular_hours,
      COALESCE(SUM(wh.overtime_hours),  0)                       AS overtime_hours,
      COALESCE(SUM(wh.field_hours),     0)                       AS field_hours,
      COALESCE(SUM(wh.two_machine_hours), 0)                     AS two_machine_hours,
      COUNT(DISTINCT wh.work_date)                               AS work_days
    FROM work_hours wh
    JOIN employees e ON e.id = wh.employee_id
    WHERE EXTRACT(YEAR  FROM wh.work_date)::int = p_period_year
      AND EXTRACT(MONTH FROM wh.work_date)::int = p_period_month
      AND e.is_active = true
    GROUP BY e.id, emp_name, e.email, e.phone
  LOOP
    v_total := v_rec.regular_hours + v_rec.overtime_hours;

    v_field_row := CASE WHEN v_rec.field_hours > 0
      THEN '<tr><td style="padding:7px 14px;border:1px solid #e2e8f0;">Terenska</td>'
        || '<td style="padding:7px 14px;border:1px solid #e2e8f0;text-align:right;">'
        || v_rec.field_hours::text || 'h</td></tr>'
      ELSE '' END;

    v_subject := 'Obračun sati za ' || v_period_label || ' — ' || v_rec.emp_name;

    v_email_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#2563eb;margin-bottom:4px;">📋 Obračun sati — ' || v_period_label || '</h2>'
      || '<p>Poštovani/a <strong>' || v_rec.emp_name || '</strong>,</p>'
      || '<p>Ovde je pregled Vaše evidencije radnih sati za <strong>' || v_period_label || '</strong>:</p>'
      || '<table style="border-collapse:collapse;margin:14px 0;width:100%;max-width:380px;">'
      || '<tr style="background:#eff6ff;">'
      ||   '<td style="padding:8px 14px;border:1px solid #dbeafe;"><strong>Redovni sati</strong></td>'
      ||   '<td style="padding:8px 14px;border:1px solid #dbeafe;text-align:right;font-weight:700;">'
      ||     v_rec.regular_hours::text || 'h</td>'
      || '</tr>'
      || '<tr>'
      ||   '<td style="padding:7px 14px;border:1px solid #e2e8f0;">Prekovremeni</td>'
      ||   '<td style="padding:7px 14px;border:1px solid #e2e8f0;text-align:right;">'
      ||     v_rec.overtime_hours::text || 'h</td>'
      || '</tr>'
      || v_field_row
      || '<tr style="background:#f8fafc;border-top:2px solid #94a3b8;">'
      ||   '<td style="padding:8px 14px;border:1px solid #cbd5e1;"><strong>Ukupno</strong></td>'
      ||   '<td style="padding:8px 14px;border:1px solid #cbd5e1;text-align:right;font-weight:700;">'
      ||     v_total::text || 'h</td>'
      || '</tr>'
      || '<tr>'
      ||   '<td style="padding:7px 14px;border:1px solid #e2e8f0;font-size:.9em;color:#64748b;">Radnih dana</td>'
      ||   '<td style="padding:7px 14px;border:1px solid #e2e8f0;text-align:right;font-size:.9em;color:#64748b;">'
      ||     v_rec.work_days::text || '</td>'
      || '</tr>'
      || '</table>'
      || '<p style="font-size:.88em;color:#64748b;">Ukoliko imate pitanja u vezi sa ovom evidencijom, obratite se HR odeljenju.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;">Srdačan pozdrav,<br><em>HR odeljenje — Servoteh</em></p>'
      || '</div>';

    v_wa_body :=
      'Obračun sati za ' || v_period_label || ': '
      || 'redovni ' || v_rec.regular_hours::text || 'h'
      || ', prekovremeni ' || v_rec.overtime_hours::text || 'h'
      || CASE WHEN v_rec.field_hours > 0 THEN ', terenska ' || v_rec.field_hours::text || 'h' ELSE '' END
      || ' (ukupno ' || v_total::text || 'h). '
      || 'Za pitanja kontaktujte HR. — Servoteh';

    v_payload := jsonb_build_object(
      'period_year',       p_period_year,
      'period_month',      p_period_month,
      'regular_hours',     v_rec.regular_hours,
      'overtime_hours',    v_rec.overtime_hours,
      'field_hours',       v_rec.field_hours,
      'two_machine_hours', v_rec.two_machine_hours,
      'work_days',         v_rec.work_days
    );

    -- Email
    IF v_rec.email IS NOT NULL AND v_rec.email <> '' THEN
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body, notification_type,
        employee_id, payload, status, scheduled_at
      ) VALUES (
        'email', v_rec.email, v_subject, v_email_body, 'payroll_statement',
        v_rec.emp_id, v_payload, 'queued', now()
      );
      v_count := v_count + 1;
    END IF;

    -- WhatsApp
    IF v_rec.phone IS NOT NULL AND v_rec.phone <> '' THEN
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body, notification_type,
        employee_id, payload, status, scheduled_at
      ) VALUES (
        'whatsapp', v_rec.phone, v_subject, v_wa_body, 'payroll_statement',
        v_rec.emp_id, v_payload, 'queued', now()
      );
      v_count := v_count + 1;
    END IF;

  END LOOP;

  RETURN v_count;
END;
$function$
;

-- ============ kadr_queue_vacation_notification ============
CREATE OR REPLACE FUNCTION public.kadr_queue_vacation_notification(p_vacation_request_id uuid, p_new_status text, p_rejection_note text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp_name        text;
  v_emp_email       text;
  v_emp_phone       text;
  v_emp_id          uuid;
  v_date_from       date;
  v_date_to         date;
  v_days_count      int;
  v_subject         text;
  v_email_body      text;
  v_wa_body         text;
  v_oversight_body  text;
  v_payload         jsonb;
  v_status_label    text;
  v_send_wa         boolean := true;
BEGIN
  SELECT
    COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni'),
    e.email, e.phone, e.id, vr.date_from, vr.date_to, vr.days_count
  INTO v_emp_name, v_emp_email, v_emp_phone, v_emp_id,
       v_date_from, v_date_to, v_days_count
  FROM vacation_requests vr
  JOIN employees e ON e.id = vr.employee_id
  WHERE vr.id = p_vacation_request_id;

  IF NOT FOUND THEN RETURN; END IF;

  v_payload := jsonb_build_object(
    'status', p_new_status, 'date_from', v_date_from,
    'date_to', v_date_to, 'days_count', v_days_count
  );

  IF p_new_status = 'approved' THEN
    v_status_label := 'ODOBREN';
    v_subject := 'Rešenje o godišnjem odmoru — ' || v_emp_name;
    v_email_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#16a34a;margin-bottom:4px;">✅ Zahtev za GO odobren</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>,</p>'
      || '<p>Vaš zahtev za <strong>godišnji odmor</strong> je <strong style="color:#16a34a">ODOBREN</strong>.</p>'
      || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:360px;">'
      || '<tr style="background:#f0fdf4;">'
      ||   '<td style="padding:8px 14px;border:1px solid #d1fae5;">Period odmora</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #d1fae5;font-weight:600;">'
      ||     to_char(v_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_date_to, 'DD.MM.YYYY')
      ||   '</td></tr>'
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Radnih dana</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
      ||     COALESCE(v_days_count::text, '—') || '</td></tr>'
      || '</table>'
      || '<p>Ovo obaveštenje služi kao potvrda o odobrenom godišnjem odmoru.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;">Srdačan pozdrav,<br><em>HR odeljenje — Servoteh</em></p>'
      || '</div>';
    v_wa_body :=
      'Vaš zahtev za GO je ODOBREN: '
      || to_char(v_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_date_to, 'DD.MM.YYYY')
      || ' (' || COALESCE(v_days_count::text, '?') || ' radnih dana). — Servoteh HR';

  ELSIF p_new_status = 'rejected' THEN
    v_status_label := 'ODBIJEN';
    v_subject := 'Zahtev za GO odbijen — ' || v_emp_name;
    v_email_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#dc2626;margin-bottom:4px;">❌ Zahtev za GO odbijen</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>,</p>'
      || '<p>Vaš zahtev za godišnji odmor (<strong>'
      ||   to_char(v_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_date_to, 'DD.MM.YYYY')
      || '</strong>) je <strong style="color:#dc2626">ODBIJEN</strong>.</p>'
      || CASE WHEN COALESCE(p_rejection_note, '') <> ''
         THEN '<p><strong>Razlog:</strong> ' || p_rejection_note || '</p>' ELSE '' END
      || '<p>Za više informacija obratite se neposrednom rukovodiocu ili HR-u.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;">Srdačan pozdrav,<br><em>HR odeljenje — Servoteh</em></p>'
      || '</div>';
    v_wa_body :=
      'Vaš zahtev za GO je ODBIJEN ('
      || to_char(v_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_date_to, 'DD.MM.YYYY') || ').'
      || CASE WHEN COALESCE(p_rejection_note, '') <> ''
         THEN ' Razlog: ' || p_rejection_note ELSE '' END
      || ' — Servoteh HR';

  ELSIF p_new_status = 'rescheduled' THEN
    v_status_label := 'TERMIN PROMENJEN';
    v_subject := 'Izmena termina godišnjeg odmora — ' || v_emp_name;
    v_email_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#2563eb;margin-bottom:4px;">🗓 Termin godišnjeg odmora je promenjen</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>,</p>'
      || '<p>Termin Vašeg <strong>godišnjeg odmora</strong> je izmenjen. Novi period je:</p>'
      || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:360px;">'
      || '<tr style="background:#eff6ff;">'
      ||   '<td style="padding:8px 14px;border:1px solid #dbeafe;">Novi period odmora</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #dbeafe;font-weight:600;">'
      ||     to_char(v_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_date_to, 'DD.MM.YYYY')
      ||   '</td></tr>'
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Radnih dana</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
      ||     COALESCE(v_days_count::text, '—') || '</td></tr>'
      || '</table>'
      || '<p>Godišnji odmor ostaje <strong>odobren</strong> za navedeni novi termin.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;">Srdačan pozdrav,<br><em>HR odeljenje — Servoteh</em></p>'
      || '</div>';
    v_wa_body :=
      'Termin Vašeg GO je PROMENJEN. Novi period: '
      || to_char(v_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_date_to, 'DD.MM.YYYY')
      || ' (' || COALESCE(v_days_count::text, '?') || ' radnih dana). — Servoteh HR';

  ELSIF p_new_status = 'sef_approved' THEN
    v_status_label := 'ODOBRIO ŠEF — ČEKA HR';
    v_send_wa := false;   -- međukorak; ne šalji WhatsApp radniku
    v_subject := 'GO zahtev — odobrio šef, čeka HR finalizaciju — ' || v_emp_name;
    v_email_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#2563eb;margin-bottom:4px;">🕓 Zahtev za GO — odobrio šef</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>,</p>'
      || '<p>Vaš zahtev za godišnji odmor (<strong>'
      ||   to_char(v_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_date_to, 'DD.MM.YYYY')
      || '</strong>) je odobrio neposredni rukovodilac i prosleđen je <strong>HR-u na finalizaciju</strong>. '
      || 'O konačnoj odluci bićete obavešteni.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;">Srdačan pozdrav,<br><em>HR odeljenje — Servoteh</em></p>'
      || '</div>';

  ELSE
    RETURN;
  END IF;

  -- Zaposleni: email
  IF v_emp_email IS NOT NULL AND v_emp_email <> '' THEN
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body, notification_type,
      employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at
    ) VALUES (
      'email', lower(v_emp_email), v_subject, v_email_body, 'vacation_' || p_new_status,
      v_emp_id, 'vacation_request', p_vacation_request_id, v_payload, 'queued', now()
    );
  END IF;

  -- Zaposleni: WhatsApp (osim za međukorak sef_approved)
  IF v_send_wa AND v_emp_phone IS NOT NULL AND v_emp_phone <> '' AND v_wa_body IS NOT NULL THEN
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body, notification_type,
      employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at
    ) VALUES (
      'whatsapp', v_emp_phone, v_subject, v_wa_body, 'vacation_' || p_new_status,
      v_emp_id, 'vacation_request', p_vacation_request_id, v_payload, 'queued', now()
    );
  END IF;

  -- Kopija šefu + upravi (+ HR za sef_approved) — kratko informativno telo
  v_oversight_body :=
    '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
    || '<h2 style="margin-bottom:4px;">Zahtev za GO — ' || v_status_label || '</h2>'
    || '<p>Zahtev zaposlenog <strong>' || v_emp_name || '</strong> ('
    || to_char(v_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_date_to, 'DD.MM.YYYY')
    || ', ' || COALESCE(v_days_count::text, '?') || ' radnih dana): <strong>' || v_status_label || '</strong>.'
    || CASE WHEN p_new_status = 'sef_approved'
       THEN ' Potrebna je finalizacija HR-a u modulu Kadrovska → Zahtevi GO.' ELSE '' END
    || '</p>'
    || CASE WHEN p_new_status = 'rejected' AND COALESCE(p_rejection_note, '') <> ''
       THEN '<p><strong>Razlog:</strong> ' || p_rejection_note || '</p>' ELSE '' END
    || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
    || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
    || '</div>';

  INSERT INTO kadr_notification_log (
    channel, recipient, subject, body, notification_type,
    employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at
  )
  SELECT 'email', r.email, '[Kopija] ' || v_subject, v_oversight_body, 'vacation_' || p_new_status,
         v_emp_id, 'vacation_request', p_vacation_request_id, v_payload, 'queued', now()
  FROM (
    SELECT email FROM public.kadr_oversight_recipients(v_emp_id)
    UNION
    SELECT lower(email) FROM user_roles
     WHERE p_new_status = 'sef_approved' AND role = 'hr' AND is_active = true
       AND email IS NOT NULL AND email <> ''
  ) r
  WHERE r.email IS NOT NULL AND r.email <> ''
    AND (v_emp_email IS NULL OR r.email <> lower(v_emp_email));
END;
$function$
;

-- ============ kadr_queue_vacation_submission_notification ============
CREATE OR REPLACE FUNCTION public.kadr_queue_vacation_submission_notification(p_vacation_request_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emp_name     text;
  v_emp_email    text;
  v_emp_id       uuid;
  v_submitted_by text;
  v_date_from    date;
  v_date_to      date;
  v_days_count   int;
  v_note         text;
  v_subject      text;
  v_body         text;
  v_payload      jsonb;
  v_count        int := 0;
BEGIN
  SELECT
    COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni'),
    e.email, e.id,
    lower(vr.submitted_by),
    vr.date_from, vr.date_to, vr.days_count, vr.note
  INTO v_emp_name, v_emp_email, v_emp_id, v_submitted_by,
       v_date_from, v_date_to, v_days_count, v_note
  FROM vacation_requests vr
  JOIN employees e ON e.id = vr.employee_id
  WHERE vr.id = p_vacation_request_id;

  IF NOT FOUND THEN RETURN 0; END IF;

  v_subject := 'Nov zahtev za godišnji odmor — ' || v_emp_name;

  v_payload := jsonb_build_object(
    'status', 'submitted', 'date_from', v_date_from,
    'date_to', v_date_to, 'days_count', v_days_count,
    'submitted_by', v_submitted_by
  );

  v_body :=
    '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
    || '<h2 style="color:#2563eb;margin-bottom:4px;">📨 Nov zahtev za godišnji odmor</h2>'
    || '<p>Podnet je zahtev za godišnji odmor:</p>'
    || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:380px;">'
    || '<tr style="background:#eff6ff;"><td style="padding:8px 14px;border:1px solid #dbeafe;">Zaposleni</td>'
    ||   '<td style="padding:8px 14px;border:1px solid #dbeafe;font-weight:600;">' || v_emp_name || '</td></tr>'
    || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Period</td>'
    ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
    ||     to_char(v_date_from, 'DD.MM.YYYY') || ' – ' || to_char(v_date_to, 'DD.MM.YYYY') || '</td></tr>'
    || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Radnih dana</td>'
    ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
    ||     COALESCE(v_days_count::text, '—') || '</td></tr>'
    || CASE WHEN COALESCE(v_note, '') <> ''
       THEN '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Napomena</td>'
            || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || v_note || '</td></tr>'
       ELSE '' END
    || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;font-size:.9em;color:#64748b;">Podneo/la</td>'
    ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-size:.9em;color:#64748b;">'
    ||     COALESCE(v_submitted_by, '—') || '</td></tr>'
    || '</table>'
    || '<p style="font-size:.9em;color:#475569;">Zahtev čeka na odobravanje u modulu <strong>Kadrovska → Zahtevi GO</strong>.</p>'
    || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
    || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
    || '</div>';

  -- Primaoci: šef + uprava (helper) ∪ zaposleni ∪ podnosilac — DISTINCT lowercase
  WITH recips AS (
    SELECT DISTINCT lower(x) AS email FROM (
      SELECT email AS x FROM public.kadr_oversight_recipients(v_emp_id)
      UNION ALL SELECT v_emp_email
      UNION ALL SELECT v_submitted_by
    ) s
    WHERE x IS NOT NULL AND x <> ''
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body, notification_type,
      employee_id, related_entity_type, related_entity_id, payload, status, scheduled_at
    )
    SELECT 'email', email, v_subject, v_body, 'vacation_submitted',
           v_emp_id, 'vacation_request', p_vacation_request_id, v_payload, 'queued', now()
    FROM recips
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  RETURN v_count;
END;
$function$
;

-- ============ kadr_queue_weekly_risk_summary ============
CREATE OR REPLACE FUNCTION public.kadr_queue_weekly_risk_summary()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today              date := CURRENT_DATE;
  v_period_start       date := CURRENT_DATE - interval '12 months';
  v_email_recipients   text[];
  v_count              int := 0;
  v_now_iso            timestamptz := now();
  v_email              text;
  v_high_rows          text := '';
  v_med_rows           text := '';
  v_high_count         int := 0;
  v_med_count          int := 0;
  v_med_soon_count     int := 0;
  v_con_soon_count     int := 0;
  v_subject            text;
  v_html_body          text;
  v_text_body          text;
  r                    record;
BEGIN
  /* 1. Učitaj email primaoce iz singleton config-a. Ako nema — skip. */
  SELECT email_recipients
    INTO v_email_recipients
  FROM public.kadr_notification_config
  WHERE id = 1
    AND enabled = true;

  IF v_email_recipients IS NULL OR array_length(v_email_recipients, 1) IS NULL THEN
    RETURN 0;
  END IF;

  /* 2. Per zaposleni risk (isti algoritam kao FE u reportsTab.js). */
  FOR r IN
    WITH bo AS (
      SELECT
        a.employee_id,
        COUNT(*) AS bo_count,
        COALESCE(SUM(
          GREATEST(LEAST(a.date_to, v_today) - GREATEST(a.date_from, v_period_start), 0)::int + 1
        ), 0) AS bo_days
      FROM public.absences a
      WHERE a.type = 'bolovanje'
        AND a.date_from IS NOT NULL
        AND a.date_to   IS NOT NULL
        AND a.date_from <= v_today
        AND a.date_to   >= v_period_start
      GROUP BY a.employee_id
    ),
    con AS (
      SELECT DISTINCT ON (c.employee_id)
        c.employee_id,
        c.date_to AS con_date_to
      FROM public.contracts c
      WHERE c.is_active IS NOT FALSE
      ORDER BY c.employee_id, c.date_from DESC NULLS LAST
    )
    SELECT
      e.id,
      COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni') AS emp_name,
      e.department,
      COALESCE(bo.bo_days, 0) AS bo_days,
      COALESCE(bo.bo_count, 0) AS bo_count,
      e.medical_exam_expires,
      con.con_date_to,
      (e.medical_exam_expires - v_today)::int AS med_exp_days,
      (con.con_date_to        - v_today)::int AS con_exp_days
    FROM public.employees e
    LEFT JOIN bo  ON bo.employee_id = e.id
    LEFT JOIN con ON con.employee_id = e.id
    WHERE e.is_active = true
    ORDER BY e.last_name NULLS LAST, e.first_name NULLS LAST
  LOOP
    DECLARE
      v_level       text := 'low';
      v_reasons     text := '';
      v_med_str     text := '';
      v_con_str     text := '';
    BEGIN
      /* Risk klasifikacija */
      IF r.bo_days > 7 THEN
        v_level := 'high'; v_reasons := '>7 dana bolovanja (' || r.bo_days || ' d)';
      END IF;
      IF r.med_exp_days IS NOT NULL AND r.med_exp_days < 0 THEN
        v_level := 'high';
        v_reasons := CASE WHEN v_reasons = '' THEN 'Lekarski istekao' ELSE v_reasons || ' · Lekarski istekao' END;
      END IF;
      IF r.con_exp_days IS NOT NULL AND r.con_exp_days < 0 THEN
        v_level := 'high';
        v_reasons := CASE WHEN v_reasons = '' THEN 'Ugovor istekao' ELSE v_reasons || ' · Ugovor istekao' END;
      END IF;
      IF v_level <> 'high' THEN
        IF r.bo_days BETWEEN 4 AND 7 THEN
          v_level := 'medium';
          v_reasons := r.bo_days || ' dana bolovanja';
        END IF;
        IF r.med_exp_days IS NOT NULL AND r.med_exp_days BETWEEN 0 AND 30 THEN
          v_level := 'medium';
          v_reasons := CASE WHEN v_reasons = '' THEN 'Lekarski ističe ≤30 d' ELSE v_reasons || ' · Lekarski ističe ≤30 d' END;
        END IF;
        IF r.con_exp_days IS NOT NULL AND r.con_exp_days BETWEEN 0 AND 30 THEN
          v_level := 'medium';
          v_reasons := CASE WHEN v_reasons = '' THEN 'Ugovor ističe ≤30 d' ELSE v_reasons || ' · Ugovor ističe ≤30 d' END;
        END IF;
      END IF;

      /* Counts za summary */
      IF r.med_exp_days IS NOT NULL AND r.med_exp_days BETWEEN 0 AND 60 THEN
        v_med_soon_count := v_med_soon_count + 1;
      END IF;
      IF r.con_exp_days IS NOT NULL AND r.con_exp_days BETWEEN 0 AND 60 THEN
        v_con_soon_count := v_con_soon_count + 1;
      END IF;

      IF v_level = 'high' THEN
        v_high_count := v_high_count + 1;
        v_high_rows := v_high_rows
          || '<tr><td style="padding:5px 10px;border-bottom:1px solid #fee;">'
          || r.emp_name
          || CASE WHEN r.department IS NOT NULL AND r.department <> '' THEN ' <span style="color:#888">(' || r.department || ')</span>' ELSE '' END
          || '</td><td style="padding:5px 10px;border-bottom:1px solid #fee;font-size:.9em;color:#7f1d1d;">'
          || v_reasons
          || '</td></tr>';
      ELSIF v_level = 'medium' THEN
        v_med_count := v_med_count + 1;
        v_med_rows := v_med_rows
          || '<tr><td style="padding:5px 10px;border-bottom:1px solid #fef3c7;">'
          || r.emp_name
          || CASE WHEN r.department IS NOT NULL AND r.department <> '' THEN ' <span style="color:#888">(' || r.department || ')</span>' ELSE '' END
          || '</td><td style="padding:5px 10px;border-bottom:1px solid #fef3c7;font-size:.9em;color:#854d0e;">'
          || v_reasons
          || '</td></tr>';
      END IF;
    END;
  END LOOP;

  /* Ako nema ničega da prijavimo i nema dokumenata koji ističu — preskoči. */
  IF v_high_count = 0 AND v_med_count = 0 AND v_med_soon_count = 0 AND v_con_soon_count = 0 THEN
    RETURN 0;
  END IF;

  /* 3. Sastavi subject + HTML body + text body */
  v_subject := 'Servoteh HR — risk pregled ' || to_char(v_today, 'DD.MM.YYYY');

  v_html_body :=
    '<div style="font-family:sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a;">'
    || '<h2 style="margin-bottom:4px;color:#1e40af;">📊 Servoteh HR — risk pregled</h2>'
    || '<p style="color:#555;margin-top:0;">Sažetak za ' || to_char(v_today, 'DD.MM.YYYY') || '</p>'
    || '<table style="border-collapse:collapse;margin:10px 0;">'
    ||   '<tr><td style="padding:4px 12px;color:#7f1d1d;font-weight:700;">Visok rizik:</td>'
    ||       '<td style="padding:4px 12px;font-weight:700;">' || v_high_count || '</td></tr>'
    ||   '<tr><td style="padding:4px 12px;color:#854d0e;font-weight:700;">Srednji rizik:</td>'
    ||       '<td style="padding:4px 12px;font-weight:700;">' || v_med_count || '</td></tr>'
    ||   '<tr><td style="padding:4px 12px;color:#555;">Lekarski ističe ≤60 d:</td>'
    ||       '<td style="padding:4px 12px;">' || v_med_soon_count || '</td></tr>'
    ||   '<tr><td style="padding:4px 12px;color:#555;">Ugovori ističu ≤60 d:</td>'
    ||       '<td style="padding:4px 12px;">' || v_con_soon_count || '</td></tr>'
    || '</table>';

  IF v_high_rows <> '' THEN
    v_html_body := v_html_body
      || '<h3 style="color:#7f1d1d;margin-top:18px;">VISOK RIZIK</h3>'
      || '<table style="border-collapse:collapse;width:100%;background:#fef2f2;border:1px solid #fecaca;border-radius:4px;">'
      || v_high_rows
      || '</table>';
  END IF;
  IF v_med_rows <> '' THEN
    v_html_body := v_html_body
      || '<h3 style="color:#854d0e;margin-top:18px;">SREDNJI RIZIK</h3>'
      || '<table style="border-collapse:collapse;width:100%;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;">'
      || v_med_rows
      || '</table>';
  END IF;

  v_html_body := v_html_body
    || '<p style="font-size:.85em;color:#64748b;margin-top:18px;">'
    || 'Detalji u app-u: Kadrovska → Izveštaji → Rizik. '
    || 'Pravilo: visok = &gt;7 d bolovanja u 12 meseci ILI istekli dokumenti; srednji = 4–7 d ILI dokumenti ističu ≤30 d.'
    || '</p>'
    || '<p style="font-size:.85em;color:#64748b;">Automatski generisano — ' || to_char(v_now_iso, 'DD.MM.YYYY HH24:MI') || '</p>'
    || '</div>';

  v_text_body :=
    'Servoteh HR — risk pregled za ' || to_char(v_today, 'DD.MM.YYYY') || E'\n\n'
    || 'Visok rizik: ' || v_high_count || E'\n'
    || 'Srednji rizik: ' || v_med_count || E'\n'
    || 'Lekarski ističe (60d): ' || v_med_soon_count || E'\n'
    || 'Ugovori ističu (60d): ' || v_con_soon_count || E'\n\n'
    || 'Detalji u app-u: Kadrovska → Izveštaji → Rizik.';

  /* 4. Upiši red u log za svakog email primaoca. */
  FOREACH v_email IN ARRAY v_email_recipients LOOP
    IF v_email IS NULL OR trim(v_email) = '' THEN
      CONTINUE;
    END IF;
    INSERT INTO public.kadr_notification_log (
      channel,
      recipient,
      subject,
      body,
      notification_type,
      status,
      scheduled_at,
      next_attempt_at,
      payload,
      created_at,
      updated_at
    ) VALUES (
      'email',
      trim(v_email),
      v_subject,
      v_html_body,
      'weekly_risk_summary',
      'queued',
      v_now_iso,
      v_now_iso,
      jsonb_build_object(
        'text_body',         v_text_body,
        'high_count',        v_high_count,
        'medium_count',      v_med_count,
        'medical_soon_60d',  v_med_soon_count,
        'contracts_soon_60d', v_con_soon_count,
        'period_start',      v_period_start,
        'period_end',        v_today
      ),
      v_now_iso,
      v_now_iso
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$
;

-- ============ kadr_schedule_attendance_alerts ============
CREATE OR REPLACE FUNCTION public.kadr_schedule_attendance_alerts()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_day date;
  r record;
  v_recip record;
  v_subject text;
  v_problem text;
BEGIN
  IF EXTRACT(hour FROM (now() AT TIME ZONE 'Europe/Belgrade')) <> 6 THEN
    RETURN;
  END IF;
  v_day := (now() AT TIME ZONE 'Europe/Belgrade')::date - 1;

  FOR r IN
    SELECT d.employee_id, e.full_name, lower(NULLIF(e.email, '')) AS emp_email,
           to_char(d.first_in, 'HH24:MI') AS first_in_s, 'nema_izlaz'::text AS problem
    FROM public.v_attendance_daily d
    JOIN public.employees e ON e.id = d.employee_id AND e.is_active
    LEFT JOIN public.work_hours w ON w.employee_id = d.employee_id AND w.work_date = v_day
    WHERE d.day = v_day AND d.open_intervals > 0
      AND (w.absence_code IS NULL)
    UNION ALL
    SELECT w.employee_id, e.full_name, lower(NULLIF(e.email, '')), NULL, 'nema_prolaza'
    FROM public.work_hours w
    JOIN public.employees e ON e.id = w.employee_id AND e.is_active
    WHERE w.work_date = v_day AND COALESCE(w.hours, 0) > 0
      AND COALESCE(w.field_hours, 0) = 0 AND w.absence_code IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.attendance_events ae
                      WHERE ae.employee_id = w.employee_id AND ae.event_ts_local::date = v_day)
      AND EXISTS (SELECT 1 FROM public.attendance_events ae
                  WHERE ae.employee_id = w.employee_id
                    AND ae.event_ts_local::date >= v_day - 7 AND ae.event_ts_local::date < v_day)
  LOOP
    v_problem := CASE WHEN r.problem = 'nema_izlaz'
      THEN 'ulaz u ' || COALESCE(r.first_in_s, '?') || ', ali izlaz NIJE otkucan'
      ELSE 'u gridu su upisani sati, ali NEMA nijednog otkucaja' END;
    v_subject := 'Provera kucanja — ' || r.full_name || ' (' || to_char(v_day, 'DD.MM.YYYY.') || ')';

    FOR v_recip IN
      SELECT s.email, 'sef'::text AS who FROM public.kadr_oversight_recipients(r.employee_id) s
      WHERE s.role_label = 'sef' AND s.email <> COALESCE(r.emp_email, '')
      UNION
      SELECT x.email, 'sef'::text FROM public.attendance_extra_recipients(r.employee_id) x
      WHERE x.email <> COALESCE(r.emp_email, '')
      UNION
      SELECT r.emp_email, 'radnik' WHERE r.emp_email IS NOT NULL
    LOOP
      IF EXISTS (SELECT 1 FROM public.kadr_notification_log n
                 WHERE n.notification_type = 'attendance_missing_punch'
                   AND n.related_entity_id = r.employee_id::text
                   AND n.recipient = v_recip.email
                   AND (n.payload ->> 'work_date')::date = v_day) THEN
        CONTINUE;
      END IF;
      INSERT INTO public.kadr_notification_log
        (channel, recipient, subject, body, related_entity_type, related_entity_id,
         employee_id, notification_type, status, scheduled_at, payload)
      VALUES ('email', v_recip.email, v_subject,
        '<div style="font-family:sans-serif;max-width:560px">'
        || '<h3 style="color:#d97706">⚠ Provera kucanja za ' || to_char(v_day, 'DD.MM.YYYY.') || '</h3>'
        || CASE WHEN v_recip.who = 'radnik'
             THEN '<p>Za Vas juče: <strong>' || v_problem || '</strong>.</p>'
                  || '<p>Ako je greška, ispravite u aplikaciji: <strong>Moj profil › Moje prisustvo</strong> (uz obrazloženje) ili se javite šefu.</p>'
             ELSE '<p>Radnik <strong>' || r.full_name || '</strong>: ' || v_problem || '.</p>'
                  || '<p>Korekciju možete uneti u <strong>Moj profil › Moj tim</strong> (uz obrazloženje radnika).</p>'
           END
        || '<p style="color:#999;font-size:12px">Servoteh — automatsko obaveštenje</p></div>',
        'attendance_alert', r.employee_id::text, r.employee_id, 'attendance_missing_punch',
        'queued', now(), jsonb_build_object('work_date', v_day, 'problem', r.problem));
    END LOOP;
  END LOOP;
END;
$function$
;

-- ============ kadr_schedule_attendance_weekly_digest ============
CREATE OR REPLACE FUNCTION public.kadr_schedule_attendance_weekly_digest()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_local timestamp := (now() AT TIME ZONE 'Europe/Belgrade');
  v_from date;
  v_to date;
  v_admin record;
  v_rows text := '';
  v_dead text := '';
  v_cnt int := 0;
  r record;
BEGIN
  IF EXTRACT(isodow FROM v_local) <> 1 OR EXTRACT(hour FROM v_local) <> 6 THEN
    RETURN;
  END IF;
  v_to := v_local::date;           -- ponedeljak
  v_from := v_to - 7;

  FOR r IN
    SELECT e.full_name, count(*) AS n
    FROM public.kadr_notification_log n
    JOIN public.employees e ON e.id = n.employee_id
    WHERE n.notification_type = 'attendance_missing_punch'
      AND (n.payload ->> 'work_date')::date >= v_from
      AND (n.payload ->> 'work_date')::date < v_to
    GROUP BY e.full_name, n.employee_id
    ORDER BY n DESC LIMIT 20
  LOOP
    v_cnt := v_cnt + 1;
    v_rows := v_rows || '<tr><td style="padding:3px 10px">' || r.full_name
      || '</td><td style="padding:3px 10px;text-align:center">' || r.n || '</td></tr>';
  END LOOP;

  FOR r IN
    SELECT e.full_name
    FROM public.employees e
    WHERE e.is_active
      AND EXISTS (SELECT 1 FROM public.work_hours w
                  WHERE w.employee_id = e.id AND w.work_date >= v_from AND w.work_date < v_to
                    AND COALESCE(w.hours, 0) > 0 AND COALESCE(w.field_hours, 0) = 0
                    AND w.absence_code IS NULL)
      AND NOT EXISTS (SELECT 1 FROM public.attendance_events ae
                      WHERE ae.employee_id = e.id AND ae.event_ts_local::date >= v_from - 7)
    ORDER BY e.full_name
  LOOP
    v_dead := v_dead || '<li>' || r.full_name || '</li>';
  END LOOP;

  IF v_cnt = 0 AND v_dead = '' THEN RETURN; END IF;

  FOR v_admin IN
    SELECT DISTINCT lower(ur.email) AS email FROM public.user_roles ur
    WHERE ur.role = 'admin' AND ur.is_active AND COALESCE(ur.email, '') <> ''
  LOOP
    IF EXISTS (SELECT 1 FROM public.kadr_notification_log n
               WHERE n.notification_type = 'attendance_weekly_digest'
                 AND n.recipient = v_admin.email
                 AND (n.payload ->> 'week_start')::date = v_from) THEN
      CONTINUE;
    END IF;
    INSERT INTO public.kadr_notification_log
      (channel, recipient, subject, body, related_entity_type, related_entity_id,
       notification_type, status, scheduled_at, payload)
    VALUES ('email', v_admin.email,
      'Prisustvo — nedeljni izveštaj (' || to_char(v_from, 'DD.MM.') || '–' || to_char(v_to - 1, 'DD.MM.YYYY.') || ')',
      '<div style="font-family:sans-serif;max-width:560px">'
      || '<h3>📊 Kucanje — nedeljni pregled</h3>'
      || CASE WHEN v_rows <> '' THEN
           '<p>Alarmi „nije se dobro kucao" po radniku:</p><table style="border-collapse:collapse;font-size:14px">'
           || '<tr><th style="text-align:left;padding:3px 10px">Radnik</th><th style="padding:3px 10px">Alarma</th></tr>'
           || v_rows || '</table>'
         ELSE '<p>Nije bilo dnevnih alarma ove nedelje. 🎉</p>' END
      || CASE WHEN v_dead <> '' THEN
           '<p style="margin-top:14px"><strong>⚠ Strukturni problem — grid sati bez IJEDNOG prolaza (mrtva/nemapirana kartica?):</strong></p><ul>' || v_dead || '</ul>'
         ELSE '' END
      || '<p style="color:#999;font-size:12px">Servoteh — automatsko obaveštenje</p></div>',
      'attendance_digest', to_char(v_from, 'YYYY-MM-DD'),
      'attendance_weekly_digest', 'queued', v_now,
      jsonb_build_object('week_start', v_from));
  END LOOP;
END;
$function$
;

-- ============ kadr_schedule_corrective_reminders ============
CREATE OR REPLACE FUNCTION public.kadr_schedule_corrective_reminders()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r record; v_count_overdue int := 0; v_count_followup int := 0;
  v_admin_email constant text := 'administracija@servoteh.com';
begin
  -- 6a. Mere sa probijenim rokom (šef koji vodi plan + administracija)
  for r in
    select m.id as measure_id, m.description_md, m.due_date,
           p.id as plan_id, p.created_by, p.employee_id,
           coalesce(e.full_name, e.first_name||' '||e.last_name, '?') as emp_name
      from corrective_measures m
      join corrective_plans p on p.id = m.plan_id
      join employees e on e.id = p.employee_id
     where m.status in ('otvoreno','u_toku')
       and m.due_date is not null and m.due_date < current_date
       and m.escalated_at is null
       and p.status in ('otvoren','u_toku')
  loop
    insert into kadr_notification_log (
      channel, recipient, subject, body, notification_type,
      employee_id, related_entity_type, related_entity_id, status, scheduled_at
    )
    select 'email', rcpt,
      '⚠ Korektivna mera — probijen rok (' || r.emp_name || ')',
      '<div style="font-family:sans-serif;max-width:540px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#dc2626;margin-bottom:4px;">⚠ Probijen rok korektivne mere</h2>'
      || '<p>Zaposleni: <strong>' || r.emp_name || '</strong></p>'
      || '<p>Mera: ' || coalesce(left(r.description_md, 300),'—') || '</p>'
      || '<p>Rok je bio: <strong>' || to_char(r.due_date,'DD.MM.YYYY.') || '</strong></p>'
      || '<p>Otvorite plan korektivnih mera u aplikaciji (Kadrovska → Razvoj zaposlenih) i ažurirajte status mere ili zakažite razgovor.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje.</em></p></div>',
      'corrective_overdue', r.employee_id, 'corrective_measure', r.measure_id::text, 'queued', now()
    from unnest(array_remove(array[nullif(lower(coalesce(r.created_by,'')),''), v_admin_email], null)) as rcpt
    group by rcpt;

    update corrective_measures set escalated_at = now(), updated_at = now() where id = r.measure_id;
    v_count_overdue := v_count_overdue + 1;
  end loop;

  -- 6b. Follow-up razgovor je danas (podsetnik šefu)
  for r in
    select p.id as plan_id, p.created_by, p.followup_date, p.employee_id,
           coalesce(e.full_name, e.first_name||' '||e.last_name, '?') as emp_name
      from corrective_plans p
      join employees e on e.id = p.employee_id
     where p.status in ('otvoren','u_toku')
       and p.followup_date is not null and p.followup_date <= current_date
       and p.followup_notified_at is null
       and nullif(lower(coalesce(p.created_by,'')),'') is not null
  loop
    insert into kadr_notification_log (
      channel, recipient, subject, body, notification_type,
      employee_id, related_entity_type, related_entity_id, status, scheduled_at
    ) values (
      'email', lower(r.created_by),
      '📅 Follow-up korektivnog plana danas — ' || r.emp_name,
      '<div style="font-family:sans-serif;max-width:540px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#2563eb;margin-bottom:4px;">📅 Follow-up razgovor</h2>'
      || '<p>Za zaposlenog <strong>' || r.emp_name || '</strong> zakazan je follow-up razgovor korektivnog plana za <strong>'
      || to_char(r.followup_date,'DD.MM.YYYY.') || '</strong>.</p>'
      || '<p>Posle razgovora upišite zapisnik (tip „Korektivni") i ažurirajte status mera.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje.</em></p></div>',
      'corrective_followup', r.employee_id, 'corrective_plan', r.plan_id::text, 'queued', now()
    );
    update corrective_plans set followup_notified_at = now(), updated_at = now() where id = r.plan_id;
    v_count_followup := v_count_followup + 1;
  end loop;

  return jsonb_build_object('overdue', v_count_overdue, 'followup', v_count_followup);
end; $function$
;

-- ============ kadr_schedule_hr_reminders ============
CREATE OR REPLACE FUNCTION public.kadr_schedule_hr_reminders()
 RETURNS TABLE(scheduled_count integer, skipped_count integer, config_missing boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enabled              boolean;
  v_med_lead             int;
  v_con_lead             int;
  v_bday_enabled         boolean;
  v_ann_enabled          boolean;
  v_bday_oversight_on    boolean;
  v_bday_digest_on       boolean;
  v_wa_recipients        text[];
  v_em_recipients        text[];
  v_lk_lead              int;
  v_pass_lead            int;
  v_dl_lead              int;
  v_med_emp_lead         int;
  v_scheduled            int := 0;
  v_skipped              int := 0;
  /* Fiksni primalac administracije (zahtev korisnika, kao kod ugovora). */
  v_admin_email          text := 'administracija@servoteh.com';
BEGIN
  v_enabled            := (SELECT enabled                    FROM public.kadr_notification_config WHERE id = 1);
  v_med_lead           := (SELECT medical_lead_days          FROM public.kadr_notification_config WHERE id = 1);
  v_con_lead           := (SELECT contract_lead_days         FROM public.kadr_notification_config WHERE id = 1);
  v_bday_enabled       := (SELECT birthday_enabled           FROM public.kadr_notification_config WHERE id = 1);
  v_ann_enabled        := (SELECT work_anniversary_enabled   FROM public.kadr_notification_config WHERE id = 1);
  v_bday_oversight_on  := (SELECT birthday_oversight_enabled FROM public.kadr_notification_config WHERE id = 1);
  v_bday_digest_on     := (SELECT birthday_digest_enabled    FROM public.kadr_notification_config WHERE id = 1);
  v_wa_recipients      := (SELECT whatsapp_recipients        FROM public.kadr_notification_config WHERE id = 1);
  v_em_recipients      := (SELECT email_recipients           FROM public.kadr_notification_config WHERE id = 1);
  v_lk_lead            := COALESCE((SELECT lk_lead_days             FROM public.kadr_notification_config WHERE id = 1), 30);
  v_pass_lead          := COALESCE((SELECT passport_lead_days       FROM public.kadr_notification_config WHERE id = 1), 180);
  v_dl_lead            := COALESCE((SELECT driver_license_lead_days FROM public.kadr_notification_config WHERE id = 1), 30);
  v_med_emp_lead       := COALESCE((SELECT medical_emp_lead_days    FROM public.kadr_notification_config WHERE id = 1), 15);

  IF v_enabled IS NULL OR NOT v_enabled THEN
    scheduled_count := 0;
    skipped_count   := 0;
    config_missing  := true;
    RETURN NEXT;
    RETURN;
  END IF;

  /* -- A) Medical expiring ------------------------------------------- */
  WITH medical_due AS (
    SELECT e.id AS emp_id,
           COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
           e.medical_exam_expires AS due_date,
           (e.medical_exam_expires - CURRENT_DATE) AS days_left
      FROM employees e
     WHERE e.is_active = true
       AND e.medical_exam_expires IS NOT NULL
       AND e.medical_exam_expires <= CURRENT_DATE + v_med_lead
       AND e.medical_exam_expires >= CURRENT_DATE
  ),
  wa_targets AS (
    SELECT unnest(v_wa_recipients) AS recipient, 'whatsapp'::text AS channel
  ),
  em_targets AS (
    SELECT unnest(v_em_recipients) AS recipient, 'email'::text AS channel
  ),
  all_targets AS (
    SELECT * FROM wa_targets UNION ALL SELECT * FROM em_targets
  ),
  candidates AS (
    SELECT md.emp_id, md.emp_name, md.due_date, md.days_left,
           t.recipient, t.channel
      FROM medical_due md
      CROSS JOIN all_targets t
  ),
  to_insert AS (
    SELECT c.* FROM candidates c
     WHERE NOT EXISTS (
       SELECT 1 FROM kadr_notification_log n
        WHERE n.notification_type = 'medical_expiring'
          AND n.related_entity_id = c.emp_id::text
          AND n.recipient = c.recipient
          AND n.scheduled_at::date = CURRENT_DATE
     )
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body,
      related_entity_type, related_entity_id, employee_id,
      notification_type, status, scheduled_at, next_attempt_at, payload
    )
    SELECT
      channel, recipient,
      format('Lekarski istice — %s', emp_name),
      format(E'Zaposleni *%s*: lekarski pregled istice %s (za %s dana).',
             emp_name, to_char(due_date, 'DD.MM.YYYY'), days_left),
      'employee_medical', emp_id::text, emp_id,
      'medical_expiring', 'queued', now(), now(),
      jsonb_build_object(
        'employee_name', emp_name,
        'due_date', due_date,
        'days_left', days_left
      )
    FROM to_insert
    RETURNING 1
  )
  SELECT count(*) INTO v_scheduled FROM ins;

  /* -- B1) Contract expiring (ODREĐENO) → nadređeni + uprava + administracija
     Dani 1..lead (date_to > danas). Single-shot dedup po (contract, recipient, datum isteka). */
  WITH contracts_due AS (
    SELECT c.id AS contract_id, c.employee_id,
           COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
           NULLIF(c.position, '')        AS position,
           NULLIF(c.contract_number, '') AS contract_number,
           c.date_to AS due_date,
           (c.date_to - CURRENT_DATE) AS days_left
      FROM contracts c
      JOIN employees e ON e.id = c.employee_id
     WHERE e.is_active = true
       AND c.is_active = true
       AND c.contract_type = 'odredjeno'
       AND c.archived_at IS NULL
       AND c.date_to IS NOT NULL
       AND c.date_to <= CURRENT_DATE + v_con_lead
       AND c.date_to >  CURRENT_DATE            -- dan-0 ide kroz B2
  ),
  candidates AS (
    SELECT cd.contract_id, cd.employee_id, cd.emp_name, cd.position,
           cd.contract_number, cd.due_date, cd.days_left,
           r.recipient
      FROM contracts_due cd
      CROSS JOIN LATERAL (
        SELECT lower(email) AS recipient
          FROM public.kadr_oversight_recipients(cd.employee_id)
         WHERE email IS NOT NULL AND email <> ''
        UNION
        SELECT v_admin_email
      ) r
  ),
  to_insert AS (
    SELECT c.* FROM candidates c
     WHERE NOT EXISTS (
       SELECT 1 FROM kadr_notification_log n
        WHERE n.notification_type = 'contract_expiring'
          AND n.related_entity_id = c.contract_id::text
          AND n.recipient = c.recipient
          AND (n.payload->>'due_date')::date = c.due_date
     )
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body,
      related_entity_type, related_entity_id, employee_id,
      notification_type, status, scheduled_at, next_attempt_at, payload
    )
    SELECT
      'email', recipient,
      format('Ističe ugovor (određeno) — %s', emp_name),
      '<div style="font-family:sans-serif;max-width:540px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#d97706;margin-bottom:4px;">⏰ Ističe ugovor o radu (određeno)</h2>'
      || '<p>Ugovor o radu na <strong>određeno vreme</strong> uskoro ističe:</p>'
      || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:420px;">'
      || '<tr style="background:#fffbeb;"><td style="padding:8px 14px;border:1px solid #fde68a;">Zaposleni</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #fde68a;font-weight:600;">' || emp_name || '</td></tr>'
      || CASE WHEN position IS NOT NULL
         THEN '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Radno mesto</td>'
              || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || position || '</td></tr>'
         ELSE '' END
      || CASE WHEN contract_number IS NOT NULL
         THEN '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Broj ugovora</td>'
              || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || contract_number || '</td></tr>'
         ELSE '' END
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Datum isteka</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
      ||     to_char(due_date, 'DD.MM.YYYY') || '</td></tr>'
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Preostalo dana</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
      ||     days_left::text || '</td></tr>'
      || '</table>'
      || '<p style="background:#fef3c7;border-left:4px solid #d97706;padding:10px 14px;border-radius:4px;">'
      ||   '<strong>Potrebno je doneti odluku o produženju ugovora</strong> i obaviti razgovor sa '
      ||   'zaposlenim — da li se ugovor produžava ili ne.</p>'
      || '<p style="font-size:.9em;color:#475569;">Detalji u modulu <strong>Kadrovska → Ugovori</strong>.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
      || '</div>',
      'employee_contract', contract_id::text, employee_id,
      'contract_expiring', 'queued', now(), now(),
      jsonb_build_object(
        'employee_name', emp_name,
        'due_date', due_date,
        'days_left', days_left,
        'contract_id', contract_id,
        'contract_type', 'odredjeno'
      )
    FROM to_insert
    RETURNING 1
  )
  SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;

  /* -- B2) Contract expiring DANAS (date_to = danas) → administracija ----- */
  WITH contracts_today AS (
    SELECT c.id AS contract_id, c.employee_id,
           COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
           NULLIF(c.position, '')        AS position,
           NULLIF(c.contract_number, '') AS contract_number,
           c.date_to AS due_date
      FROM contracts c
      JOIN employees e ON e.id = c.employee_id
     WHERE e.is_active = true
       AND c.is_active = true
       AND c.contract_type = 'odredjeno'
       AND c.archived_at IS NULL
       AND c.date_to = CURRENT_DATE
  ),
  to_insert AS (
    SELECT ct.*, v_admin_email AS recipient
      FROM contracts_today ct
     WHERE NOT EXISTS (
       SELECT 1 FROM kadr_notification_log n
        WHERE n.notification_type = 'contract_expiring_today'
          AND n.related_entity_id = ct.contract_id::text
          AND n.recipient = v_admin_email
          AND (n.payload->>'due_date')::date = ct.due_date
     )
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body,
      related_entity_type, related_entity_id, employee_id,
      notification_type, status, scheduled_at, next_attempt_at, payload
    )
    SELECT
      'email', recipient,
      format('Danas ističe ugovor (određeno) — %s', emp_name),
      '<div style="font-family:sans-serif;max-width:540px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#dc2626;margin-bottom:4px;">📅 Danas ističe ugovor o radu (određeno)</h2>'
      || '<p><strong>Danas</strong> ističe ugovor o radu na određeno vreme za zaposlenog:</p>'
      || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:420px;">'
      || '<tr style="background:#fef2f2;"><td style="padding:8px 14px;border:1px solid #fecaca;">Zaposleni</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #fecaca;font-weight:600;">' || emp_name || '</td></tr>'
      || CASE WHEN position IS NOT NULL
         THEN '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Radno mesto</td>'
              || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || position || '</td></tr>'
         ELSE '' END
      || CASE WHEN contract_number IS NOT NULL
         THEN '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Broj ugovora</td>'
              || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || contract_number || '</td></tr>'
         ELSE '' END
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Datum isteka</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
      ||     to_char(due_date, 'DD.MM.YYYY') || ' (danas)</td></tr>'
      || '</table>'
      || '<p style="font-size:.9em;color:#475569;">Informativno obaveštenje administraciji. '
      ||   'Detalji u modulu <strong>Kadrovska → Ugovori</strong>.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
      || '</div>',
      'employee_contract', contract_id::text, employee_id,
      'contract_expiring_today', 'queued', now(), now(),
      jsonb_build_object(
        'employee_name', emp_name,
        'due_date', due_date,
        'days_left', 0,
        'contract_id', contract_id,
        'contract_type', 'odredjeno'
      )
    FROM to_insert
    RETURNING 1
  )
  SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;

  /* -- C) Birthday globalni (ako je uključeno) ----------------------- */
  IF v_bday_enabled THEN
    WITH birthdays_today AS (
      SELECT e.id AS emp_id,
             COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
             e.birth_date
        FROM employees e
       WHERE e.is_active = true
         AND e.birth_date IS NOT NULL
         AND to_char(e.birth_date, 'MM-DD') = to_char(CURRENT_DATE, 'MM-DD')
    ),
    wa_targets AS (
      SELECT unnest(v_wa_recipients) AS recipient, 'whatsapp'::text AS channel
    ),
    em_targets AS (
      SELECT unnest(v_em_recipients) AS recipient, 'email'::text AS channel
    ),
    all_targets AS (
      SELECT * FROM wa_targets UNION ALL SELECT * FROM em_targets
    ),
    candidates AS (
      SELECT bd.*, t.recipient, t.channel
        FROM birthdays_today bd
        CROSS JOIN all_targets t
    ),
    to_insert AS (
      SELECT c.* FROM candidates c
       WHERE NOT EXISTS (
         SELECT 1 FROM kadr_notification_log n
          WHERE n.notification_type = 'birthday'
            AND n.related_entity_id = c.emp_id::text
            AND n.recipient = c.recipient
            AND n.scheduled_at::date = CURRENT_DATE
       )
    ),
    ins AS (
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body,
        related_entity_type, related_entity_id, employee_id,
        notification_type, status, scheduled_at, next_attempt_at, payload
      )
      SELECT
        channel, recipient,
        format('Rodjendan — %s', emp_name),
        format(E'Danas je rodjendan zaposlenog *%s*. Srecan rodjendan!', emp_name),
        'employee_birthday', emp_id::text, emp_id,
        'birthday', 'queued', now(), now(),
        jsonb_build_object('employee_name', emp_name, 'birth_date', birth_date)
      FROM to_insert
      RETURNING 1
    )
    SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;
  END IF;

  /* -- D) Work anniversary (ako je uključeno) -------------------------- */
  IF v_ann_enabled THEN
    WITH anniversaries_today AS (
      SELECT e.id AS emp_id,
             COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
             e.hire_date,
             EXTRACT(YEAR FROM AGE(CURRENT_DATE, e.hire_date))::int AS years_worked
        FROM employees e
       WHERE e.is_active = true
         AND e.hire_date IS NOT NULL
         AND to_char(e.hire_date, 'MM-DD') = to_char(CURRENT_DATE, 'MM-DD')
         AND e.hire_date < CURRENT_DATE
    ),
    wa_targets AS (
      SELECT unnest(v_wa_recipients) AS recipient, 'whatsapp'::text AS channel
    ),
    em_targets AS (
      SELECT unnest(v_em_recipients) AS recipient, 'email'::text AS channel
    ),
    all_targets AS (
      SELECT * FROM wa_targets UNION ALL SELECT * FROM em_targets
    ),
    candidates AS (
      SELECT ann.*, t.recipient, t.channel
        FROM anniversaries_today ann
        CROSS JOIN all_targets t
    ),
    to_insert AS (
      SELECT c.* FROM candidates c
       WHERE NOT EXISTS (
         SELECT 1 FROM kadr_notification_log n
          WHERE n.notification_type = 'work_anniversary'
            AND n.related_entity_id = c.emp_id::text
            AND n.recipient = c.recipient
            AND n.scheduled_at::date = CURRENT_DATE
       )
    ),
    ins AS (
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body,
        related_entity_type, related_entity_id, employee_id,
        notification_type, status, scheduled_at, next_attempt_at, payload
      )
      SELECT
        channel, recipient,
        format('Godisnjica — %s (%s god.)', emp_name, years_worked),
        format(E'Zaposleni *%s* danas slavi *%s godina* rada u firmi.', emp_name, years_worked),
        'employee_anniversary', emp_id::text, emp_id,
        'work_anniversary', 'queued', now(), now(),
        jsonb_build_object('employee_name', emp_name, 'years_worked', years_worked, 'hire_date', hire_date)
      FROM to_insert
      RETURNING 1
    )
    SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;
  END IF;

  /* -- F) Birthday OVERSIGHT — na dan rođendana → NADREĐENI -------------- *
   * Šef pododeljenja zaposlenog (user_roles.menadzment čiji
   * managed_sub_department_ids sadrži e.sub_department_id). Email kanal.
   * Dedup po (zaposleni, primalac, dan). Nezavisno od bloka C.              */
  IF v_bday_oversight_on THEN
    WITH birthdays_today AS (
      SELECT e.id AS emp_id,
             COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
             e.birth_date,
             e.sub_department_id,
             COALESCE(NULLIF(e.position, ''), NULLIF(e.department, ''), '—') AS position_or_dept
        FROM employees e
       WHERE e.is_active = true
         AND e.birth_date IS NOT NULL
         AND e.sub_department_id IS NOT NULL
         AND to_char(e.birth_date, 'MM-DD') = to_char(CURRENT_DATE, 'MM-DD')
    ),
    candidates AS (
      SELECT bt.emp_id, bt.emp_name, bt.birth_date, bt.position_or_dept,
             lower(ur.email) AS recipient
        FROM birthdays_today bt
        JOIN public.user_roles ur
          ON ur.role = 'menadzment'
         AND ur.is_active
         AND ur.managed_sub_department_ids @> ARRAY[bt.sub_department_id]
       WHERE ur.email IS NOT NULL AND ur.email <> ''
    ),
    to_insert AS (
      SELECT c.* FROM candidates c
       WHERE NOT EXISTS (
         SELECT 1 FROM kadr_notification_log n
          WHERE n.notification_type = 'birthday_oversight'
            AND n.related_entity_id = c.emp_id::text
            AND n.recipient = c.recipient
            AND n.scheduled_at::date = CURRENT_DATE
       )
    ),
    ins AS (
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body,
        related_entity_type, related_entity_id, employee_id,
        notification_type, status, scheduled_at, next_attempt_at, payload
      )
      SELECT
        'email', recipient,
        format('🎂 Danas je rođendan — %s', emp_name),
        '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
        || '<h2 style="color:#9333ea;margin-bottom:4px;">🎂 Danas je rođendan</h2>'
        || '<p>Danas rođendan slavi član vašeg tima:</p>'
        || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:380px;">'
        || '<tr style="background:#faf5ff;"><td style="padding:8px 14px;border:1px solid #e9d5ff;">Zaposleni</td>'
        ||   '<td style="padding:8px 14px;border:1px solid #e9d5ff;font-weight:600;">' || emp_name || '</td></tr>'
        || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Radno mesto / odeljenje</td>'
        ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || position_or_dept || '</td></tr>'
        || '</table>'
        || '<p style="font-size:.95em;">Lepa prilika da mu/joj čestitate. 🎉</p>'
        || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
        || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
        || '</div>',
        'employee_birthday', emp_id::text, emp_id,
        'birthday_oversight', 'queued', now(), now(),
        jsonb_build_object('employee_name', emp_name, 'birth_date', birth_date)
      FROM to_insert
      RETURNING 1
    )
    SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;
  END IF;

  /* -- G) Birthday DIGEST — svakog 1. u mesecu → LIDERI ODELJENJA -------- *
   * Za svakog menadžera: zaposleni iz NJEGOVIH pododeljenja sa rođendanom u
   * narednih 30 dana, grupisani u jedan mejl. Puna lista (svi) i na
   * administracija@servoteh.com. Dedup po (primalac, mesec).
   * next_bday = ovogodišnji rođendan (offset dana od početka godine; ako je
   * prošao → +1 god). Feb-29 u nepreestupnoj → 1. mart (prihvatljivo).      */
  IF v_bday_digest_on AND EXTRACT(DAY FROM CURRENT_DATE)::int = 1 THEN
    WITH upcoming AS (
      SELECT e.id AS emp_id,
             COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
             COALESCE(NULLIF(e.department, ''), '—') AS department,
             e.sub_department_id,
             nb.next_bday,
             (nb.next_bday - CURRENT_DATE) AS days_until
        FROM employees e
        CROSS JOIN LATERAL (
          SELECT (
            CASE
              WHEN (date_trunc('year', CURRENT_DATE)::date
                    + (e.birth_date - date_trunc('year', e.birth_date)::date)) >= CURRENT_DATE
              THEN (date_trunc('year', CURRENT_DATE)::date
                    + (e.birth_date - date_trunc('year', e.birth_date)::date))
              ELSE ((date_trunc('year', CURRENT_DATE)::date
                    + (e.birth_date - date_trunc('year', e.birth_date)::date)) + INTERVAL '1 year')::date
            END
          ) AS next_bday
        ) nb
       WHERE e.is_active = true
         AND e.birth_date IS NOT NULL
         AND nb.next_bday <= CURRENT_DATE + 30
    ),
    per_mgr AS (
      SELECT lower(ur.email) AS recipient,
             u.emp_name, u.department, u.next_bday, u.days_until
        FROM upcoming u
        JOIN public.user_roles ur
          ON ur.role = 'menadzment'
         AND ur.is_active
         AND u.sub_department_id IS NOT NULL
         AND ur.managed_sub_department_ids @> ARRAY[u.sub_department_id]
       WHERE ur.email IS NOT NULL AND ur.email <> ''
    ),
    per_admin AS (
      SELECT v_admin_email AS recipient,
             u.emp_name, u.department, u.next_bday, u.days_until
        FROM upcoming u
    ),
    combined AS (
      SELECT * FROM per_mgr
      UNION ALL
      SELECT * FROM per_admin
    ),
    digest AS (
      SELECT recipient,
             count(*) AS n,
             string_agg(
               '<tr>'
               || '<td style="padding:7px 12px;border:1px solid #e2e8f0;">' || emp_name || '</td>'
               || '<td style="padding:7px 12px;border:1px solid #e2e8f0;color:#475569;">' || department || '</td>'
               || '<td style="padding:7px 12px;border:1px solid #e2e8f0;font-weight:600;white-space:nowrap;">'
               ||   to_char(next_bday, 'DD.MM.') || '</td>'
               || '<td style="padding:7px 12px;border:1px solid #e2e8f0;white-space:nowrap;">'
               ||   CASE WHEN days_until = 0 THEN 'danas 🎂' ELSE 'za ' || days_until || ' d' END
               || '</td>'
               || '</tr>',
               '' ORDER BY next_bday, emp_name
             ) AS rows_html
        FROM combined
       GROUP BY recipient
    ),
    to_insert AS (
      SELECT d.* FROM digest d
       WHERE NOT EXISTS (
         SELECT 1 FROM kadr_notification_log n
          WHERE n.notification_type = 'birthday_digest'
            AND n.recipient = d.recipient
            AND to_char(n.scheduled_at, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')
       )
    ),
    ins AS (
      INSERT INTO kadr_notification_log (
        channel, recipient, subject, body,
        related_entity_type, related_entity_id, employee_id,
        notification_type, status, scheduled_at, next_attempt_at, payload
      )
      SELECT
        'email', recipient,
        format('🎂 Rođendani u narednih 30 dana (%s)', n),
        '<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;">'
        || '<h2 style="color:#9333ea;margin-bottom:4px;">🎂 Rođendani u narednih 30 dana</h2>'
        || '<p>Pregled predstojećih rođendana zaposlenih iz vašeg obima:</p>'
        || '<table style="border-collapse:collapse;margin:16px 0;width:100%;">'
        || '<thead><tr style="background:#faf5ff;">'
        ||   '<th style="padding:7px 12px;border:1px solid #e9d5ff;text-align:left;">Zaposleni</th>'
        ||   '<th style="padding:7px 12px;border:1px solid #e9d5ff;text-align:left;">Odeljenje</th>'
        ||   '<th style="padding:7px 12px;border:1px solid #e9d5ff;text-align:left;">Datum</th>'
        ||   '<th style="padding:7px 12px;border:1px solid #e9d5ff;text-align:left;">Za</th>'
        || '</tr></thead><tbody>'
        || rows_html
        || '</tbody></table>'
        || '<p style="font-size:.9em;color:#475569;">Detalji u modulu <strong>Kadrovska → Zaposleni</strong> '
        ||   '(brzi filter „🎂 Rođendani &lt;30d").</p>'
        || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
        || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — mesečni pregled (1. u mesecu)</em></p>'
        || '</div>',
        'birthday_digest_month', to_char(CURRENT_DATE, 'YYYY-MM'), NULL,
        'birthday_digest', 'queued', now(), now(),
        jsonb_build_object('month', to_char(CURRENT_DATE, 'YYYY-MM'), 'count', n)
      FROM to_insert
      RETURNING 1
    )
    SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;
  END IF;


  /* -- H) STRANCI — dokumenti (pasoš/viza/radna/boravišna): 30 dana pre + na dan
        isteka → administracija. Single-shot dedup po (tip, zaposleni:dok, datum). */
  WITH docs AS (
    SELECT f.employee_id,
           COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
           d.kind, d.label, NULLIF(d.doc_num, '') AS doc_num, d.due_date,
           (d.due_date - CURRENT_DATE) AS days_left
      FROM public.employee_foreign_docs f
      JOIN employees e ON e.id = f.employee_id AND e.is_active
      CROSS JOIN LATERAL (VALUES
        ('pasos',   'Pasoš',             f.passport_number,         f.passport_expiry),
        ('viza',    'Viza',              f.visa_number,             f.visa_expiry),
        ('radna',   'Radna dozvola',     f.work_permit_number,      f.work_permit_expiry),
        ('boravak', 'Boravišna dozvola', f.residence_permit_number, f.residence_permit_expiry)
      ) AS d(kind, label, doc_num, due_date)
     WHERE d.due_date IS NOT NULL
  ),
  due_docs AS (
    SELECT *, 'foreign_doc_expiring'::text AS ntype FROM docs
     WHERE due_date > CURRENT_DATE AND due_date <= CURRENT_DATE + 30
    UNION ALL
    SELECT *, 'foreign_doc_expiring_today'::text FROM docs WHERE due_date = CURRENT_DATE
  ),
  to_insert AS (
    SELECT dd.* FROM due_docs dd
     WHERE NOT EXISTS (
       SELECT 1 FROM kadr_notification_log n
        WHERE n.notification_type = dd.ntype
          AND n.related_entity_id = dd.employee_id::text || ':' || dd.kind
          AND n.recipient = v_admin_email
          AND (n.payload->>'due_date')::date = dd.due_date
     )
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body,
      related_entity_type, related_entity_id, employee_id,
      notification_type, status, scheduled_at, next_attempt_at, payload
    )
    SELECT
      'email', v_admin_email,
      CASE WHEN ntype = 'foreign_doc_expiring_today'
           THEN format('🛂 DANAS ističe: %s — %s', label, emp_name)
           ELSE format('🛂 Ističe za %s dana: %s — %s', days_left, label, emp_name) END,
      '<div style="font-family:sans-serif;max-width:540px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:' || CASE WHEN ntype = 'foreign_doc_expiring_today' THEN '#dc2626' ELSE '#d97706' END
      || ';margin-bottom:4px;">🛂 ' || CASE WHEN ntype = 'foreign_doc_expiring_today'
           THEN 'DANAS ističe dokument stranog radnika' ELSE 'Ističe dokument stranog radnika' END || '</h2>'
      || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:420px;">'
      || '<tr style="background:#fffbeb;"><td style="padding:8px 14px;border:1px solid #fde68a;">Zaposleni</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #fde68a;font-weight:600;">' || emp_name || '</td></tr>'
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Dokument</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">' || label || '</td></tr>'
      || CASE WHEN doc_num IS NOT NULL
         THEN '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Broj</td>'
              || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || doc_num || '</td></tr>'
         ELSE '' END
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Datum isteka</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
      ||     to_char(due_date, 'DD.MM.YYYY')
      ||     CASE WHEN ntype = 'foreign_doc_expiring_today' THEN ' (danas)' ELSE '' END || '</td></tr>'
      || '</table>'
      || '<p style="background:#fef3c7;border-left:4px solid #d97706;padding:10px 14px;border-radius:4px;">'
      ||   'Potrebno je pokrenuti produženje dokumenta na vreme.</p>'
      || '<p style="font-size:.9em;color:#475569;">Detalji u kartonu zaposlenog (Kadrovska → Zaposleni → 🌍 Stranac).</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
      || '</div>',
      'employee_foreign_doc', employee_id::text || ':' || kind, employee_id,
      ntype, 'queued', now(), now(),
      jsonb_build_object('employee_name', emp_name, 'doc', label, 'doc_kind', kind,
                         'doc_number', doc_num, 'due_date', due_date, 'days_left', days_left)
    FROM to_insert
    RETURNING 1
  )
  SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;

  /* -- I) SLUŽBENE KARTICE BANKE: 30 dana pre + na dan isteka → administracija
        (Intesa ne obaveštava). Dedup po (tip, kartica, datum). */
  WITH cards AS (
    SELECT c.id AS card_id, c.employee_id, c.bank, NULLIF(c.card_number, '') AS card_number, c.valid_thru,
           COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
           (c.valid_thru - CURRENT_DATE) AS days_left
      FROM public.employee_bank_cards c
      JOIN employees e ON e.id = c.employee_id AND e.is_active
     WHERE c.is_active AND c.valid_thru IS NOT NULL
  ),
  due_cards AS (
    SELECT *, 'bank_card_expiring'::text AS ntype FROM cards
     WHERE valid_thru > CURRENT_DATE AND valid_thru <= CURRENT_DATE + 30
    UNION ALL
    SELECT *, 'bank_card_expiring_today'::text FROM cards WHERE valid_thru = CURRENT_DATE
  ),
  to_insert AS (
    SELECT dc.* FROM due_cards dc
     WHERE NOT EXISTS (
       SELECT 1 FROM kadr_notification_log n
        WHERE n.notification_type = dc.ntype
          AND n.related_entity_id = dc.card_id::text
          AND n.recipient = v_admin_email
          AND (n.payload->>'due_date')::date = dc.valid_thru
     )
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body,
      related_entity_type, related_entity_id, employee_id,
      notification_type, status, scheduled_at, next_attempt_at, payload
    )
    SELECT
      'email', v_admin_email,
      CASE WHEN ntype = 'bank_card_expiring_today'
           THEN format('💳 DANAS ističe službena kartica (%s) — %s', bank, emp_name)
           ELSE format('💳 Ističe za %s dana: službena kartica (%s) — %s', days_left, bank, emp_name) END,
      '<div style="font-family:sans-serif;max-width:540px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:' || CASE WHEN ntype = 'bank_card_expiring_today' THEN '#dc2626' ELSE '#d97706' END
      || ';margin-bottom:4px;">💳 ' || CASE WHEN ntype = 'bank_card_expiring_today'
           THEN 'DANAS ističe službena kartica' ELSE 'Ističe službena kartica banke' END || '</h2>'
      || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:420px;">'
      || '<tr style="background:#fffbeb;"><td style="padding:8px 14px;border:1px solid #fde68a;">Zaposleni</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #fde68a;font-weight:600;">' || emp_name || '</td></tr>'
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Banka</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || bank || '</td></tr>'
      || CASE WHEN card_number IS NOT NULL
         THEN '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Kartica</td>'
              || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || card_number || '</td></tr>'
         ELSE '' END
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Važi do</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
      ||     to_char(valid_thru, 'DD.MM.YYYY')
      ||     CASE WHEN ntype = 'bank_card_expiring_today' THEN ' (danas)' ELSE '' END || '</td></tr>'
      || '</table>'
      || '<p style="background:#fef3c7;border-left:4px solid #d97706;padding:10px 14px;border-radius:4px;">'
      ||   'Banka ne šalje obaveštenje — potrebno je poručiti novu karticu na vreme.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
      || '</div>',
      'employee_bank_card', card_id::text, employee_id,
      ntype, 'queued', now(), now(),
      jsonb_build_object('employee_name', emp_name, 'bank', bank, 'card_number', card_number,
                         'due_date', valid_thru, 'days_left', days_left)
    FROM to_insert
    RETURNING 1
  )
  SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;


  /* -- J) LIČNA DOKUMENTA (LK / pasoš / vozačka / lekarski) ---------------- *
   * Single-shot pre isteka → zaposleni (ako ima email) + administracija;
   * na dan isteka → administracija. Provera važi SAMO za zaposlene koji
   * imaju unet datum isteka (pasoš se ne unosi svima — samo INO tereni).
   * Lekarski se čita sa employees.medical_exam_expires (postojeće polje).
   * Lead dani: config (lk 30 / pasoš 180 / vozačka 30 / lekarski 15).      */
  WITH docs AS (
    SELECT e.id AS emp_id,
           COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'N/N') AS emp_name,
           lower(NULLIF(e.email, '')) AS emp_email,
           d.kind, d.label, d.icon, NULLIF(d.doc_num, '') AS doc_num,
           d.due_date, d.lead_days,
           (d.due_date - CURRENT_DATE) AS days_left
      FROM employees e
      LEFT JOIN public.employee_personal_docs pd ON pd.employee_id = e.id
      CROSS JOIN LATERAL (VALUES
        ('licna_karta', 'Lična karta',      '🪪', pd.lk_number,             pd.lk_expiry,             v_lk_lead),
        ('pasos',       'Pasoš',            '🛂', pd.passport_number,       pd.passport_expiry,       v_pass_lead),
        ('vozacka',     'Vozačka dozvola',  '🚗', pd.driver_license_number, pd.driver_license_expiry, v_dl_lead),
        ('lekarski',    'Lekarski pregled', '🩺', NULL,                     e.medical_exam_expires,   v_med_emp_lead)
      ) AS d(kind, label, icon, doc_num, due_date, lead_days)
     WHERE e.is_active = true
       AND d.due_date IS NOT NULL
  ),
  due_docs AS (
    SELECT d.*, 'personal_doc_expiring'::text AS ntype, r.recipient
      FROM docs d
      CROSS JOIN LATERAL (
        SELECT v_admin_email AS recipient
        UNION
        SELECT d.emp_email WHERE d.emp_email IS NOT NULL
      ) r
     WHERE d.due_date > CURRENT_DATE AND d.due_date <= CURRENT_DATE + d.lead_days
    UNION ALL
    SELECT d.*, 'personal_doc_expiring_today'::text, v_admin_email
      FROM docs d
     WHERE d.due_date = CURRENT_DATE
  ),
  to_insert AS (
    SELECT dd.* FROM due_docs dd
     WHERE NOT EXISTS (
       SELECT 1 FROM kadr_notification_log n
        WHERE n.notification_type = dd.ntype
          AND n.related_entity_id = dd.emp_id::text || ':' || dd.kind
          AND n.recipient = dd.recipient
          AND (n.payload->>'due_date')::date = dd.due_date
     )
  ),
  ins AS (
    INSERT INTO kadr_notification_log (
      channel, recipient, subject, body,
      related_entity_type, related_entity_id, employee_id,
      notification_type, status, scheduled_at, next_attempt_at, payload
    )
    SELECT
      'email', recipient,
      CASE WHEN ntype = 'personal_doc_expiring_today'
           THEN format('%s DANAS ističe: %s — %s', icon, label, emp_name)
           ELSE format('%s Ističe za %s dana: %s — %s', icon, days_left, label, emp_name) END,
      '<div style="font-family:sans-serif;max-width:540px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:' || CASE WHEN ntype = 'personal_doc_expiring_today' THEN '#dc2626' ELSE '#d97706' END
      || ';margin-bottom:4px;">' || icon || ' ' || CASE WHEN ntype = 'personal_doc_expiring_today'
           THEN 'DANAS ističe dokument' ELSE 'Uskoro ističe dokument' END || '</h2>'
      || CASE WHEN recipient = emp_email
         THEN '<p>Vaš dokument uskoro ističe — molimo pokrenite obnovu na vreme:</p>'
         ELSE '<p>Dokument zaposlenog uskoro ističe:</p>' END
      || '<table style="border-collapse:collapse;margin:16px 0;width:100%;max-width:420px;">'
      || '<tr style="background:#fffbeb;"><td style="padding:8px 14px;border:1px solid #fde68a;">Zaposleni</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #fde68a;font-weight:600;">' || emp_name || '</td></tr>'
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Dokument</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">' || label || '</td></tr>'
      || CASE WHEN doc_num IS NOT NULL
         THEN '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Broj</td>'
              || '<td style="padding:8px 14px;border:1px solid #e2e8f0;">' || doc_num || '</td></tr>'
         ELSE '' END
      || '<tr><td style="padding:8px 14px;border:1px solid #e2e8f0;">Datum isteka</td>'
      ||   '<td style="padding:8px 14px;border:1px solid #e2e8f0;font-weight:600;">'
      ||     to_char(due_date, 'DD.MM.YYYY')
      ||     CASE WHEN ntype = 'personal_doc_expiring_today' THEN ' (danas)'
                  ELSE ' (za ' || days_left || ' dana)' END || '</td></tr>'
      || '</table>'
      || '<p style="background:#fef3c7;border-left:4px solid #d97706;padding:10px 14px;border-radius:4px;">'
      ||   'Potrebno je pokrenuti obnovu dokumenta na vreme.</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje</em></p>'
      || '</div>',
      'employee_personal_doc', emp_id::text || ':' || kind, emp_id,
      ntype, 'queued', now(), now(),
      jsonb_build_object('employee_name', emp_name, 'doc', label, 'doc_kind', kind,
                         'doc_number', doc_num, 'due_date', due_date, 'days_left', days_left)
    FROM to_insert
    RETURNING 1
  )
  SELECT v_scheduled + count(*) INTO v_scheduled FROM ins;

  scheduled_count := v_scheduled;
  skipped_count   := v_skipped;
  config_missing  := false;
  RETURN NEXT;
END;
$function$
;

-- ============ kadr_schedule_onboarding_reminders ============
CREATE OR REPLACE FUNCTION public.kadr_schedule_onboarding_reminders(p_lead_days integer DEFAULT 2)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_to    text := 'administracija@servoteh.com';
  v_today date := current_date;
  v_rec   record;
  v_rows  text := '';
  v_cnt   int := 0;
  v_late  int := 0;
BEGIN
  -- Dedup: ne �alji dva digesta isti dan.
  IF EXISTS (SELECT 1 FROM kadr_notification_log
             WHERE notification_type = 'onboarding_due' AND scheduled_at::date = v_today) THEN
    RETURN 0;
  END IF;

  FOR v_rec IN
    SELECT t.title, t.due_date, t.assignee_hint, r.kind,
           COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni') AS emp_name,
           (t.due_date < v_today) AS overdue
    FROM kadr_onboarding_tasks t
    JOIN kadr_onboarding_runs r ON r.id = t.run_id AND r.status = 'active'
    JOIN employees e ON e.id = r.employee_id
    WHERE t.status = 'open' AND t.due_date IS NOT NULL AND t.due_date <= v_today + p_lead_days
    ORDER BY t.due_date, emp_name
  LOOP
    v_cnt := v_cnt + 1;
    IF v_rec.overdue THEN v_late := v_late + 1; END IF;
    v_rows := v_rows
      || '<tr>'
      || '<td style="padding:6px 10px;border:1px solid #e2e8f0;">' || v_rec.emp_name || '</td>'
      || '<td style="padding:6px 10px;border:1px solid #e2e8f0;">' || v_rec.title
      || CASE WHEN v_rec.assignee_hint IS NOT NULL AND v_rec.assignee_hint <> ''
              THEN ' <span style="color:#64748b">(' || v_rec.assignee_hint || ')</span>' ELSE '' END || '</td>'
      || '<td style="padding:6px 10px;border:1px solid #e2e8f0;white-space:nowrap;">' || to_char(v_rec.due_date, 'DD.MM.YYYY') || '</td>'
      || '<td style="padding:6px 10px;border:1px solid #e2e8f0;font-weight:600;color:'
      || CASE WHEN v_rec.overdue THEN '#dc2626">KASNI' ELSE '#ca8a04">uskoro' END || '</td>'
      || '</tr>';
  END LOOP;

  IF v_cnt = 0 THEN RETURN 0; END IF;

  INSERT INTO kadr_notification_log (channel, recipient, subject, body, notification_type, status, scheduled_at)
  VALUES (
    'email', v_to,
    'Uvodenje/Izlazak � ' || v_cnt || ' zadataka dospeva/kasni' || CASE WHEN v_late > 0 THEN ' (' || v_late || ' kasni)' ELSE '' END,
    '<div style="font-family:sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">'
    || '<h2 style="color:#2563eb;margin-bottom:4px;">?? Zadaci uvodenja/izlaska � podsetnik</h2>'
    || '<p>Sledeci zadaci dospevaju u narednih ' || p_lead_days || ' dana ili kasne:</p>'
    || '<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:.92em;">'
    || '<tr style="background:#eff6ff;"><th style="padding:6px 10px;border:1px solid #dbeafe;text-align:left;">Zaposleni</th>'
    || '<th style="padding:6px 10px;border:1px solid #dbeafe;text-align:left;">Zadatak</th>'
    || '<th style="padding:6px 10px;border:1px solid #dbeafe;text-align:left;">Rok</th>'
    || '<th style="padding:6px 10px;border:1px solid #dbeafe;text-align:left;">Status</th></tr>'
    || v_rows || '</table>'
    || '<p style="font-size:.85em;color:#64748b;">Otvori modul Kadrovska ? �Uvodenje / Izlazak" za detalje.</p>'
    || '</div>',
    'onboarding_due', 'queued', now()
  );
  RETURN v_cnt;
END; $function$
;

-- ============ kadr_set_contract_salary ============
CREATE OR REPLACE FUNCTION public.kadr_set_contract_salary(p_employee_id uuid, p_neto numeric, p_bruto numeric, p_effective_from date DEFAULT CURRENT_DATE, p_approved_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prev   public.salary_terms%ROWTYPE;
  v_found  boolean;
  v_new_id uuid;
  -- Satnica/ne-RSD: amount ima drugu semantiku (satnica po satu / devizni iznos),
  -- pa ga NE prepisujemo ugovornim netom — menjaju se samo neto/bruto snapshoti.
  v_touch_amount boolean;
BEGIN
  IF NOT public.current_user_can_manage_employee_pii() THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF p_employee_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = p_employee_id) THEN
    RAISE EXCEPTION 'employee_not_found';
  END IF;
  IF p_neto IS NULL OR p_neto <= 0 OR p_bruto IS NULL OR p_bruto <= 0 OR p_bruto < p_neto THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  p_effective_from := COALESCE(p_effective_from, current_date);

  SELECT * INTO v_prev
    FROM public.salary_terms st
   WHERE st.employee_id = p_employee_id
     AND st.effective_from <= p_effective_from
     AND (st.effective_to IS NULL OR st.effective_to >= p_effective_from)
   ORDER BY st.effective_from DESC, st.created_at DESC
   LIMIT 1;
  v_found := FOUND;

  -- Bez promene: isti neto i bruto kao na važećem redu → ne diraj istoriju.
  IF v_found
     AND round(COALESCE(v_prev.neto_rsd, -1), 2) = round(p_neto, 2)
     AND round(COALESCE(v_prev.bruto_rsd, -1), 2) = round(p_bruto, 2) THEN
    IF p_approved_by IS NOT NULL AND COALESCE(v_prev.approved_by, '') = '' THEN
      UPDATE public.salary_terms
         SET approved_by = p_approved_by, approved_at = p_effective_from
       WHERE id = v_prev.id;
    END IF;
    RETURN jsonb_build_object('status', 'unchanged', 'term_id', v_prev.id);
  END IF;

  v_touch_amount := v_found
    AND v_prev.salary_type IN ('ugovor', 'dogovor')
    AND COALESCE(v_prev.currency, 'RSD') = 'RSD';

  -- Isti „važi od" → ispravka u mestu (ne otvaramo drugi red za isti datum).
  IF v_found AND v_prev.effective_from = p_effective_from THEN
    UPDATE public.salary_terms
       SET amount      = CASE WHEN v_touch_amount THEN p_neto ELSE amount END,
           amount_type = CASE WHEN v_touch_amount THEN 'neto' ELSE amount_type END,
           neto_rsd    = p_neto,
           bruto_rsd   = p_bruto,
           approved_by = COALESCE(p_approved_by, approved_by),
           approved_at = CASE WHEN p_approved_by IS NOT NULL THEN p_effective_from ELSE approved_at END
     WHERE id = v_prev.id;
    RETURN jsonb_build_object('status', 'updated', 'term_id', v_prev.id);
  END IF;

  IF v_found THEN
    -- Nova izmena: novi istorijski red, parametri obračuna se prenose sa prethodnog.
    INSERT INTO public.salary_terms (
      employee_id, salary_type, compensation_model, effective_from, effective_to,
      amount, amount_type, currency, hourly_rate,
      transport_allowance_rsd, per_diem_rsd, per_diem_eur,
      fixed_amount, fixed_transport_component, fixed_extra_hour_rate,
      first_part_amount, split_hour_rate, split_transport_amount,
      hourly_transport_amount, terrain_domestic_rate, terrain_foreign_rate,
      contract_ref, note, neto_rsd, bruto_rsd, approved_by, approved_at
    ) VALUES (
      p_employee_id, v_prev.salary_type, v_prev.compensation_model, p_effective_from, NULL,
      CASE WHEN v_touch_amount THEN p_neto ELSE v_prev.amount END,
      CASE WHEN v_touch_amount THEN 'neto' ELSE v_prev.amount_type END,
      COALESCE(v_prev.currency, 'RSD'), v_prev.hourly_rate,
      v_prev.transport_allowance_rsd, v_prev.per_diem_rsd, v_prev.per_diem_eur,
      v_prev.fixed_amount, v_prev.fixed_transport_component, v_prev.fixed_extra_hour_rate,
      v_prev.first_part_amount, v_prev.split_hour_rate, v_prev.split_transport_amount,
      v_prev.hourly_transport_amount, v_prev.terrain_domestic_rate, v_prev.terrain_foreign_rate,
      v_prev.contract_ref, 'Izmena ugovorne zarade (forma zaposlenog)', p_neto, p_bruto,
      p_approved_by, CASE WHEN p_approved_by IS NOT NULL THEN p_effective_from END
    ) RETURNING id INTO v_new_id;
  ELSE
    -- Prvi unos (novi zaposleni): mesečna ugovorna zarada, model Fiksno kao početni.
    INSERT INTO public.salary_terms (
      employee_id, salary_type, compensation_model, effective_from,
      amount, amount_type, currency, note, neto_rsd, bruto_rsd, approved_by, approved_at
    ) VALUES (
      p_employee_id, 'ugovor', 'fiksno', p_effective_from,
      p_neto, 'neto', 'RSD', 'Ugovorna zarada (forma zaposlenog)', p_neto, p_bruto,
      p_approved_by, CASE WHEN p_approved_by IS NOT NULL THEN p_effective_from END
    ) RETURNING id INTO v_new_id;
  END IF;

  RETURN jsonb_build_object('status', 'created', 'term_id', v_new_id);
END;
$function$
;

-- ============ kadr_storno_makeup ============
CREATE OR REPLACE FUNCTION public.kadr_storno_makeup(p_request_id uuid, p_note text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_req public.makeup_requests%ROWTYPE; v_actor text; v_days numeric := 0;
BEGIN
  SELECT * INTO v_req FROM makeup_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found'; END IF;
  IF NOT public.kadr_makeup_actor_allowed(v_req.employee_id) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF v_req.status NOT IN ('approved','completed') THEN RAISE EXCEPTION 'not_approved'; END IF;
  v_actor := lower(COALESCE(auth.jwt()->>'email','system'));

  IF v_req.compensation_type = 'dan_odmora' THEN
    DELETE FROM vacation_bonus_days b
     WHERE (b.makeup_request_id = p_request_id)
        OR (b.employee_id = v_req.employee_id AND b.work_date = v_req.weekend_work_date)
    RETURNING days INTO v_days;
    IF v_days > 0 THEN
      UPDATE vacation_entitlements SET
        days_total = days_total - v_days,
        note = COALESCE(note,'') || format(' | STORNO −%s dan GO (rad vikendom %s): %s (storno %s %s)',
          v_days, to_char(v_req.weekend_work_date,'DD.MM.YYYY'), NULLIF(p_note,''), v_actor, to_char(CURRENT_DATE,'DD.MM.YYYY')),
        updated_at = now()
      WHERE employee_id = v_req.employee_id AND year = EXTRACT(year FROM v_req.weekend_work_date)::int;
    END IF;
  END IF;

  UPDATE makeup_requests SET status = 'storniran', storno_by = v_actor, storno_at = now(),
    storno_note = COALESCE(p_note,''), updated_at = now()
  WHERE id = p_request_id;
  RETURN jsonb_build_object('ok', true, 'reversed_days', COALESCE(v_days,0));
END; $function$
;

-- ============ kadr_trigger_schedule_hr_reminders ============
CREATE OR REPLACE FUNCTION public.kadr_trigger_schedule_hr_reminders()
 RETURNS TABLE(scheduled_count integer, skipped_count integer, config_missing boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.current_user_is_hr_or_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.kadr_schedule_hr_reminders();
END;
$function$
;

-- ============ kadr_trigger_weekly_risk_summary ============
CREATE OR REPLACE FUNCTION public.kadr_trigger_weekly_risk_summary()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
      public.current_user_is_hr()
      OR public.current_user_is_admin()
      OR session_user::text IN ('postgres', 'supabase_admin')
      OR EXISTS (
        SELECT 1 FROM pg_roles r
        WHERE r.rolname = session_user::name AND r.rolsuper
      )
  ) THEN
    RAISE EXCEPTION 'Access denied: HR or admin only';
  END IF;
  RETURN public.kadr_queue_weekly_risk_summary();
END;
$function$
;

-- ============ kadr_work_hours_audit ============
CREATE OR REPLACE FUNCTION public.kadr_work_hours_audit(p_employee_id uuid DEFAULT NULL::uuid, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_limit integer DEFAULT 300)
 RETURNS TABLE(id bigint, action text, actor_email text, changed_at timestamp with time zone, employee_id uuid, work_date date, old_data jsonb, new_data jsonb, diff_keys text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not (public.can_edit_kadrovska_grid() or public.current_user_is_admin()) then
    raise exception 'permission_denied'
      using errcode = '42501',
            hint = 'Istorija sati je dostupna samo ovlašćenima za mesečni grid.';
  end if;

  return query
  select
    l.id,
    l.action,
    l.actor_email,
    l.changed_at,
    nullif(coalesce(l.new_data->>'employee_id', l.old_data->>'employee_id'), '')::uuid,
    nullif(coalesce(l.new_data->>'work_date',  l.old_data->>'work_date'), '')::date,
    l.old_data,
    l.new_data,
    l.diff_keys
  from public.audit_log l
  where l.table_name = 'work_hours'
    and (p_employee_id is null
         or coalesce(l.new_data->>'employee_id', l.old_data->>'employee_id') = p_employee_id::text)
    and (p_date_from is null
         or coalesce(l.new_data->>'work_date', l.old_data->>'work_date') >= to_char(p_date_from, 'YYYY-MM-DD'))
    and (p_date_to is null
         or coalesce(l.new_data->>'work_date', l.old_data->>'work_date') <= to_char(p_date_to, 'YYYY-MM-DD'))
  order by l.changed_at desc
  limit least(greatest(coalesce(p_limit, 300), 1), 1000);
end;
$function$
;

-- ============ makeup_approve ============
CREATE OR REPLACE FUNCTION public.makeup_approve(p_request_id uuid, p_actor_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req           makeup_requests%ROWTYPE;
  v_email         text;
  v_is_admin      boolean;
  v_is_hr         boolean;
  v_is_menadzment boolean;
BEGIN
  v_email := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));
  v_is_admin := public.current_user_is_admin();
  v_is_hr    := public.current_user_is_hr();
  v_is_menadzment := EXISTS (SELECT 1 FROM user_roles WHERE lower(email) = v_email AND role = 'menadzment' AND is_active = true);

  IF NOT (v_is_admin OR v_is_hr OR v_is_menadzment) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Nemate ulogu za odobravanje nadoknade.';
  END IF;

  SELECT * INTO v_req FROM makeup_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;

  IF NOT public.current_user_manages_employee(v_req.employee_id) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Zahtev je van vaseg opsega.';
  END IF;

  IF v_req.status NOT IN ('pending', 'sef_approved') THEN
    RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id, 'current_status', v_req.status);
  END IF;

  IF v_req.status = 'pending' THEN
    IF v_is_admin THEN
      UPDATE makeup_requests
         SET status = 'approved', level1_by = coalesce(level1_by, v_email), level1_at = coalesce(level1_at, now()),
             reviewed_by = v_email, reviewed_at = now()
       WHERE id = p_request_id AND status = 'pending' RETURNING * INTO v_req;
      IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
      RETURN jsonb_build_object('status', 'approved', 'request_id', p_request_id, 'reviewed_by', v_email, 'direct', true);
    END IF;

    UPDATE makeup_requests SET status = 'sef_approved', level1_by = v_email, level1_at = now()
     WHERE id = p_request_id AND status = 'pending' RETURNING * INTO v_req;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
    RETURN jsonb_build_object('status', 'sef_approved', 'request_id', p_request_id, 'level1_by', v_email);
  END IF;

  -- sef_approved → finalizacija (HR / admin)
  IF NOT (v_is_hr OR v_is_admin) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Finalizaciju radi HR ili uprava.';
  END IF;
  IF (NOT v_is_admin) AND lower(coalesce(v_req.level1_by, '')) = v_email THEN
    RETURN jsonb_build_object('status', 'dual_control', 'request_id', p_request_id, 'level1_by', v_req.level1_by);
  END IF;

  UPDATE makeup_requests SET status = 'approved', reviewed_by = v_email, reviewed_at = now()
   WHERE id = p_request_id AND status = 'sef_approved' RETURNING * INTO v_req;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
  RETURN jsonb_build_object('status', 'approved', 'request_id', p_request_id, 'reviewed_by', v_email, 'level1_by', v_req.level1_by);
END;
$function$
;

-- ============ makeup_complete ============
CREATE OR REPLACE FUNCTION public.makeup_complete(p_request_id uuid, p_actor_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_req makeup_requests%ROWTYPE; v_email text;
BEGIN
  IF NOT public.current_user_can_manage_vacreq() THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM makeup_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
  IF NOT public.current_user_manages_employee(v_req.employee_id) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Van opsega.';
  END IF;
  v_email := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));
  UPDATE makeup_requests SET status = 'completed', completed_by = v_email, completed_at = now()
   WHERE id = p_request_id AND status = 'approved' RETURNING * INTO v_req;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
  RETURN jsonb_build_object('status', 'completed', 'request_id', p_request_id, 'completed_by', v_email);
END;
$function$
;

-- ============ makeup_reject ============
CREATE OR REPLACE FUNCTION public.makeup_reject(p_request_id uuid, p_note text DEFAULT NULL::text, p_actor_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_req makeup_requests%ROWTYPE; v_email text;
BEGIN
  IF NOT public.current_user_can_manage_vacreq() THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_req FROM makeup_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
  IF NOT public.current_user_manages_employee(v_req.employee_id) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Van opsega.';
  END IF;
  v_email := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));
  UPDATE makeup_requests SET status = 'rejected', reviewed_by = v_email, reviewed_at = now(),
         rejection_note = coalesce(p_note, '')
   WHERE id = p_request_id AND status IN ('pending', 'sef_approved') RETURNING * INTO v_req;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
  RETURN jsonb_build_object('status', 'rejected', 'request_id', p_request_id, 'reviewed_by', v_email);
END;
$function$
;

-- ============ paid_leave_approve ============
CREATE OR REPLACE FUNCTION public.paid_leave_approve(p_request_id uuid, p_actor_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req           paid_leave_requests%ROWTYPE;
  v_email         text;
  v_is_admin      boolean;
  v_is_hr         boolean;
  v_is_menadzment boolean;
  v_slobodan      text;
  v_label         text;
  v_abs_id        uuid;
BEGIN
  v_email := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));
  v_is_admin := public.current_user_is_admin();
  v_is_hr    := public.current_user_is_hr();
  v_is_menadzment := EXISTS (SELECT 1 FROM user_roles WHERE lower(email) = v_email AND role = 'menadzment' AND is_active = true);

  IF NOT (v_is_admin OR v_is_hr OR v_is_menadzment) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Nemate ulogu za odobravanje plaćenog odsustva.';
  END IF;

  SELECT * INTO v_req FROM paid_leave_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;

  IF NOT public.current_user_manages_employee(v_req.employee_id) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Zahtev je van vaseg opsega.';
  END IF;

  IF v_req.status NOT IN ('pending', 'sef_approved') THEN
    RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id, 'current_status', v_req.status);
  END IF;

  -- 1. nivo (osim admin prečice)
  IF v_req.status = 'pending' AND NOT v_is_admin THEN
    UPDATE paid_leave_requests SET status = 'sef_approved', level1_by = v_email, level1_at = now()
     WHERE id = p_request_id AND status = 'pending' RETURNING * INTO v_req;
    IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
    RETURN jsonb_build_object('status', 'sef_approved', 'request_id', p_request_id, 'level1_by', v_email);
  END IF;

  -- finalizacija
  IF v_req.status = 'sef_approved' AND NOT (v_is_hr OR v_is_admin) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Finalizaciju radi HR ili uprava.';
  END IF;
  IF v_req.status = 'sef_approved' AND (NOT v_is_admin) AND lower(coalesce(v_req.level1_by, '')) = v_email THEN
    RETURN jsonb_build_object('status', 'dual_control', 'request_id', p_request_id, 'level1_by', v_req.level1_by);
  END IF;

  UPDATE paid_leave_requests
     SET status = 'approved',
         level1_by = coalesce(level1_by, v_email),
         level1_at = coalesce(level1_at, now()),
         reviewed_by = v_email, reviewed_at = now()
   WHERE id = p_request_id AND status IN ('pending', 'sef_approved')
   RETURNING * INTO v_req;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;

  SELECT slobodan_reason, label INTO v_slobodan, v_label FROM public.paid_leave_reason_map(v_req.leave_type);

  INSERT INTO absences (employee_id, type, date_from, date_to, days_count, slobodan_reason, note)
  VALUES (v_req.employee_id, 'placeno', v_req.date_from, v_req.date_to, NULLIF(v_req.days_count, 0),
          v_slobodan, 'Plaćeno odsustvo — ' || v_label || ' (odobreno iz zahteva ' || coalesce(v_req.submitted_by, '') || ')')
  RETURNING id INTO v_abs_id;

  /* Mesečni grid: kod 'pl' za radne dane perioda (Pon–Pet, bez neradnih
     praznika). Upsert po (employee_id, work_date). */
  INSERT INTO work_hours (employee_id, work_date, hours, absence_code, last_edited_by, updated_at)
  SELECT v_req.employee_id, g.d::date, 0, 'pl', v_email, now()
  FROM generate_series(v_req.date_from, v_req.date_to, interval '1 day') g(d)
  WHERE extract(isodow from g.d::date) < 6
    AND NOT EXISTS (SELECT 1 FROM kadr_holidays h WHERE h.holiday_date = g.d::date AND h.is_workday = false)
  ON CONFLICT (employee_id, work_date) DO UPDATE
    SET absence_code = 'pl', hours = 0, last_edited_by = EXCLUDED.last_edited_by, updated_at = now();

  RETURN jsonb_build_object('status', 'approved', 'request_id', p_request_id,
                            'absence_id', v_abs_id, 'reviewed_by', v_email, 'level1_by', v_req.level1_by);
END;
$function$
;

-- ============ paid_leave_delete ============
CREATE OR REPLACE FUNCTION public.paid_leave_delete(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_req paid_leave_requests%ROWTYPE;
BEGIN
  IF NOT public.current_user_is_hr_or_admin() THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Brisanje plaćenog odsustva radi HR/admin.';
  END IF;

  SELECT * INTO v_req FROM paid_leave_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found', 'request_id', p_request_id); END IF;

  IF v_req.status = 'approved' THEN
    /* Povuci grid 'pl' za radne dane perioda. */
    DELETE FROM work_hours
     WHERE employee_id = v_req.employee_id
       AND work_date BETWEEN v_req.date_from AND v_req.date_to
       AND absence_code = 'pl';
    /* Povuci matching placeno absences red (snapshot perioda, živ). */
    DELETE FROM absences
     WHERE employee_id = v_req.employee_id
       AND type = 'placeno'
       AND date_from = v_req.date_from
       AND date_to   = v_req.date_to
       AND archived_at IS NULL;
  END IF;

  DELETE FROM paid_leave_requests WHERE id = p_request_id;
  RETURN jsonb_build_object('status', 'deleted', 'request_id', p_request_id, 'was', v_req.status);
END;
$function$
;

-- ============ paid_leave_reason_map ============
CREATE OR REPLACE FUNCTION public.paid_leave_reason_map(p_type text)
 RETURNS TABLE(slobodan_reason text, label text)
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT
    CASE p_type
      WHEN 'brak'            THEN 'brak'
      WHEN 'rodjenje_deteta' THEN 'rodjenje_deteta'
      WHEN 'smrt_uze'        THEN 'smrt_clana_porodice'
      WHEN 'selidba'         THEN 'selidba'
      WHEN 'selidba_drugo'   THEN 'selidba'
      WHEN 'krv'             THEN 'dobrovoljno_davanje_krvi'
      ELSE 'ostalo'
    END,
    CASE p_type
      WHEN 'brak'            THEN 'Sklapanje braka'
      WHEN 'rodjenje_deteta' THEN 'Porođaj supruge / rođenje deteta'
      WHEN 'bolest_uze'      THEN 'Teža bolest člana uže porodice'
      WHEN 'porodjaj_drugi'  THEN 'Porođaj drugog člana uže porodice'
      WHEN 'smrt_uze'        THEN 'Smrt člana uže porodice'
      WHEN 'smrt_sire'       THEN 'Smrt člana šire porodice'
      WHEN 'selidba'         THEN 'Selidba domaćinstva (isto mesto)'
      WHEN 'selidba_drugo'   THEN 'Selidba domaćinstva (drugo naseljeno mesto)'
      WHEN 'nepogoda'        THEN 'Elementarna nepogoda u domaćinstvu'
      WHEN 'ispit'           THEN 'Polaganje stručnog ili drugog ispita'
      WHEN 'krv'             THEN 'Dobrovoljno davanje krvi'
      ELSE 'Plaćeno odsustvo'
    END;
$function$
;

-- ============ paid_leave_reject ============
CREATE OR REPLACE FUNCTION public.paid_leave_reject(p_request_id uuid, p_note text DEFAULT NULL::text, p_actor_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_req paid_leave_requests%ROWTYPE; v_email text;
BEGIN
  IF NOT public.current_user_can_manage_vacreq() THEN RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_req FROM paid_leave_requests WHERE id = p_request_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
  IF NOT public.current_user_manages_employee(v_req.employee_id) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501', HINT = 'Van opsega.';
  END IF;
  v_email := lower(coalesce(p_actor_email, auth.jwt() ->> 'email', ''));
  UPDATE paid_leave_requests SET status = 'rejected', reviewed_by = v_email, reviewed_at = now(),
         rejection_note = coalesce(p_note, '')
   WHERE id = p_request_id AND status IN ('pending', 'sef_approved') RETURNING * INTO v_req;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'already_processed', 'request_id', p_request_id); END IF;
  RETURN jsonb_build_object('status', 'rejected', 'request_id', p_request_id, 'reviewed_by', v_email);
END;
$function$
;

-- ============ reject_nop_request ============
CREATE OR REPLACE FUNCTION public.reject_nop_request(p_request_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_actor text; v_found boolean;
begin
  if not public.current_user_is_admin() then
    raise exception 'permission_denied' using errcode='42501';
  end if;
  v_actor := lower(coalesce(auth.jwt()->>'email',''));
  update nop_requests set status='rejected', reviewed_by=v_actor, reviewed_at=now(), review_note=coalesce(p_note,'')
   where id=p_request_id and status='pending';
  get diagnostics v_found = row_count;
  return jsonb_build_object('status', case when v_found then 'rejected' else 'already_processed' end, 'request_id', p_request_id);
end; $function$
;

-- ============ rev_current_employee_id ============
CREATE OR REPLACE FUNCTION public.rev_current_employee_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT id
  FROM public.employees
  WHERE lower(email) = lower(auth.jwt() ->> 'email')
    AND is_active IS TRUE
  LIMIT 1;
$function$
;

-- ============ salary_payroll_compute_totals ============
CREATE OR REPLACE FUNCTION public.salary_payroll_compute_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_base NUMERIC(14, 2);
BEGIN
  IF NEW.ukupna_zarada IS NOT NULL AND NEW.ukupna_zarada > 0 THEN
    NEW.total_rsd := NEW.ukupna_zarada;
  ELSIF NEW.salary_type = 'satnica' THEN
    v_base := COALESCE(NEW.hours_worked, 0) * COALESCE(NEW.hourly_rate, 0);
    NEW.total_rsd := v_base
                   + COALESCE(NEW.transport_rsd, 0)
                   + COALESCE(NEW.per_diem_rsd, 0) * COALESCE(NEW.domestic_days, 0);
  ELSE
    v_base := COALESCE(NEW.fixed_salary, 0);
    NEW.total_rsd := v_base
                   + COALESCE(NEW.transport_rsd, 0)
                   + COALESCE(NEW.per_diem_rsd, 0) * COALESCE(NEW.domestic_days, 0);
  END IF;

  NEW.total_eur := COALESCE(NEW.per_diem_eur, 0) * COALESCE(NEW.foreign_days, 0);
  NEW.second_part_rsd := NEW.total_rsd - COALESCE(NEW.advance_amount, 0);
  RETURN NEW;
END;
$function$
;

-- ============ salary_payroll_immutability_check ============
CREATE OR REPLACE FUNCTION public.salary_payroll_immutability_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* Trigger se kači BEFORE UPDATE. Ako je OLD.status='paid', dozvoljen je
     UPDATE samo ako je sesija eksplicitno otključala preko
     `kadr_payroll_unlock` (koji setuje payroll.unlock_ok=on u svojoj transakciji).

     No-op UPDATE (svi NEW IS NOT DISTINCT FROM OLD) prolazi uvek — to nije
     prava izmena. */
  IF OLD.status = 'paid' THEN
    IF current_setting('payroll.unlock_ok', true) IS DISTINCT FROM 'on' THEN
      /* Ako su sve vrednosti iste, ovo je NO-OP UPDATE — pusti. */
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'salary_payroll_locked: mesec je zaključan (status=paid). Admin mora prvo da otključa preko kadr_payroll_unlock(id).'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $function$
;

-- ============ salary_payroll_set_created_by ============
CREATE OR REPLACE FUNCTION public.salary_payroll_set_created_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
BEGIN
  IF NEW.created_by IS NULL OR NEW.created_by = '' THEN
    NEW.created_by := LOWER(COALESCE(auth.jwt() ->> 'email', 'system'));
  END IF;
  RETURN NEW;
END $function$
;

-- ============ salary_terms_close_previous ============
CREATE OR REPLACE FUNCTION public.salary_terms_close_previous()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
BEGIN
  IF NEW.effective_to IS NULL THEN
    UPDATE salary_terms SET effective_to = (NEW.effective_from - INTERVAL '1 day')::date, updated_at = now()
     WHERE employee_id = NEW.employee_id AND id <> NEW.id AND effective_to IS NULL AND effective_from < NEW.effective_from;
  END IF;
  RETURN NEW;
END $function$
;

-- ============ salary_terms_set_created_by ============
CREATE OR REPLACE FUNCTION public.salary_terms_set_created_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
BEGIN
  IF NEW.created_by IS NULL OR NEW.created_by = '' THEN
    NEW.created_by := LOWER(COALESCE(auth.jwt() ->> 'email', 'system'));
  END IF;
  RETURN NEW;
END $function$
;

-- ============ talk_acknowledge ============
CREATE OR REPLACE FUNCTION public.talk_acknowledge(p_talk uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare t record;
begin
  select * into t from employee_talks where id = p_talk;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if t.employee_id is distinct from public.current_user_employee_id() then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if t.status = 'potvrdjen' then return jsonb_build_object('status','already_acknowledged'); end if;
  if t.status <> 'podeljen' then return jsonb_build_object('status','not_shared'); end if;
  update employee_talks
     set status = 'potvrdjen', acknowledged_at = now(), updated_at = now()
   where id = p_talk;
  return jsonb_build_object('status','acknowledged');
end; $function$
;

-- ============ talk_share ============
CREATE OR REPLACE FUNCTION public.talk_share(p_talk uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  t record; v_emp record; v_emailed boolean := false; v_type_label text;
begin
  select * into t from employee_talks where id = p_talk;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if not public.current_user_can_manage_talk(t.employee_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if t.status = 'potvrdjen' then return jsonb_build_object('status','already_acknowledged'); end if;

  update employee_talks
     set status = 'podeljen', shared_at = coalesce(shared_at, now()), updated_at = now()
   where id = p_talk;

  -- korektivni plan(ovi) vezani za razgovor postaju vidljivi zaposlenom
  update corrective_plans set visible_to_employee = true, updated_at = now()
   where (talk_id = p_talk or closing_talk_id = p_talk) and visible_to_employee = false;

  select coalesce(full_name, first_name||' '||last_name, 'Zaposleni') as full_name, email
    into v_emp from employees where id = t.employee_id;

  v_type_label := case t.talk_type
    when 'godisnji' then 'Godišnji razgovor (učinak i zarada)'
    when 'korektivni' then 'Korektivni razgovor'
    when 'jedan_na_jedan' then 'Razgovor 1-na-1'
    else 'Razgovor' end;

  if v_emp.email is not null and v_emp.email <> '' then
    insert into kadr_notification_log (
      channel, recipient, subject, body, notification_type,
      employee_id, related_entity_type, related_entity_id, status, scheduled_at
    ) values (
      'email', v_emp.email,
      '🗣 Zapisnik razgovora — ' || v_type_label,
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#2563eb;margin-bottom:4px;">🗣 ' || v_type_label || '</h2>'
      || '<p>Poštovani/a <strong>' || v_emp.full_name || '</strong>,</p>'
      || '<p>Vaš rukovodilac je podelio zapisnik razgovora'
      || case when t.talk_date is not null then ' održanog <strong>' || to_char(t.talk_date,'DD.MM.YYYY.') || '</strong>' else '' end
      || ' sa Vama.</p>'
      || '<p>Zapisnik možete pročitati u aplikaciji: <strong>Moj profil → Razgovori sa nadređenim</strong>. '
      || 'Molimo Vas da potvrdite da ste upoznati sa sadržajem (dugme „Upoznat/a sam").</p>'
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh — automatsko obaveštenje.</em></p>'
      || '</div>',
      'talk_shared', t.employee_id, 'employee_talk', p_talk::text, 'queued', now()
    );
    v_emailed := true;
  end if;

  return jsonb_build_object('status','shared','emailed',v_emailed);
end; $function$
;

-- ============ talk_unshare ============
CREATE OR REPLACE FUNCTION public.talk_unshare(p_talk uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare t record;
begin
  select * into t from employee_talks where id = p_talk;
  if not found then return jsonb_build_object('status','not_found'); end if;
  if not public.current_user_can_manage_talk(t.employee_id) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;
  if t.status = 'potvrdjen' then
    return jsonb_build_object('status','already_acknowledged');  -- posle potvrde nema povlačenja
  end if;
  update employee_talks set status = 'nacrt', updated_at = now() where id = p_talk;
  return jsonb_build_object('status','draft');
end; $function$
;

-- ============ vacation_requests_no_overlap ============
CREATE OR REPLACE FUNCTION public.vacation_requests_no_overlap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conf record;
BEGIN
  /* Samo aktivni statusi blokiraju. */
  IF NEW.status NOT IN ('pending', 'sef_approved', 'approved') THEN
    RETURN NEW;
  END IF;

  /* Na UPDATE proveri samo kad se DATUMI menjaju (status-only update se ne dira). */
  IF TG_OP = 'UPDATE'
     AND NEW.date_from IS NOT DISTINCT FROM OLD.date_from
     AND NEW.date_to   IS NOT DISTINCT FROM OLD.date_to THEN
    RETURN NEW;
  END IF;

  IF NEW.date_from IS NULL OR NEW.date_to IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT vr.id, vr.date_from, vr.date_to, vr.status
    INTO v_conf
    FROM public.vacation_requests vr
   WHERE vr.employee_id = NEW.employee_id
     AND vr.id <> NEW.id
     AND vr.status IN ('pending', 'sef_approved', 'approved')
     AND vr.date_from <= NEW.date_to
     AND vr.date_to   >= NEW.date_from
   ORDER BY vr.date_from
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Već postoji aktivan zahtev za godišnji odmor koji se preklapa sa tim danima (% – %, status: %). Prvo obriši ili otkaži prethodni pa podnesi ponovo.',
      to_char(v_conf.date_from, 'DD.MM.YYYY'),
      to_char(v_conf.date_to,   'DD.MM.YYYY'),
      v_conf.status
      USING ERRCODE = '23P01';   -- exclusion_violation → PostgREST 409
  END IF;

  RETURN NEW;
END;
$function$
;

-- ================================================================
-- DODATAK: KANONSKI VIEW-OVI (pg_get_viewdef, security_invoker gde je naznaceno u spec §1)
-- ================================================================

-- ============ VIEW v_attendance_daily ============
CREATE OR REPLACE VIEW public.v_attendance_daily AS
WITH ev AS (
         SELECT attendance_events.id,
            attendance_events.employee_id,
            attendance_events.event_ts_local AS ts,
            attendance_events.event_ts_local::date AS day,
            attendance_events.direction,
                CASE attendance_events.direction
                    WHEN 'in'::text THEN 0
                    WHEN 'official_out'::text THEN 1
                    WHEN 'break'::text THEN 2
                    WHEN 'out'::text THEN 3
                    ELSE 4
                END AS dir_prio
           FROM attendance_events
          WHERE attendance_events.employee_id IS NOT NULL AND attendance_events.event_ts_local IS NOT NULL AND attendance_events.direction <> 'unknown'::text
        ), dedup AS (
         SELECT x.id,
            x.employee_id,
            x.ts,
            x.day,
            x.direction,
            x.dir_prio
           FROM ( SELECT ev.id,
                    ev.employee_id,
                    ev.ts,
                    ev.day,
                    ev.direction,
                    ev.dir_prio,
                    lag(ev.ts) OVER w AS prev_ts,
                    lag(ev.direction) OVER w AS prev_dir
                   FROM ev
                  WINDOW w AS (PARTITION BY ev.employee_id, ev.day ORDER BY ev.ts, ev.dir_prio, ev.id)) x
          WHERE x.prev_ts IS NULL OR x.direction <> x.prev_dir OR (x.ts - x.prev_ts) > '00:01:00'::interval
        ), paired AS (
         SELECT dedup.employee_id,
            dedup.day,
            dedup.ts,
            dedup.direction,
            lead(dedup.ts) OVER w AS next_ts,
            lead(dedup.direction) OVER w AS next_dir
           FROM dedup
          WINDOW w AS (PARTITION BY dedup.employee_id, dedup.day ORDER BY dedup.ts, dedup.dir_prio, dedup.id)
        )
 SELECT employee_id,
    day,
    min(ts) FILTER (WHERE direction = 'in'::text) AS first_in,
    max(ts) FILTER (WHERE direction = ANY (ARRAY['out'::text, 'official_out'::text, 'break'::text])) AS last_out,
    round(EXTRACT(epoch FROM sum(next_ts - ts) FILTER (WHERE (direction = ANY (ARRAY['in'::text, 'official_out'::text])) AND next_ts IS NOT NULL)) / 3600.0, 2) AS presence_hours,
    count(*)::integer AS events_cnt,
    count(*) FILTER (WHERE (direction = ANY (ARRAY['in'::text, 'official_out'::text])) AND next_ts IS NULL)::integer AS open_intervals,
    count(*) FILTER (WHERE direction = 'in'::text AND next_dir = 'in'::text)::integer AS double_in_cnt
   FROM paired
  GROUP BY employee_id, day;

-- ============ VIEW v_attendance_now ============
CREATE OR REPLACE VIEW public.v_attendance_now AS
SELECT DISTINCT ON (ae.employee_id) ae.employee_id,
    e.full_name,
    e.department,
    ae.event_ts,
    ae.direction,
    ae.terminal_name,
    ae.source,
        CASE
            WHEN ae.direction = 'in'::text THEN 'prisutan'::text
            WHEN ae.direction = 'break'::text THEN 'pauza'::text
            ELSE 'odsutan'::text
        END AS status
   FROM attendance_events ae
     JOIN employees e ON e.id = ae.employee_id
  WHERE ae.employee_id IS NOT NULL AND e.is_active AND ae.event_ts >= (now() - '24:00:00'::interval)
  ORDER BY ae.employee_id, ae.event_ts DESC;

-- ============ VIEW v_attendance_shadow_monthly ============
CREATE OR REPLACE VIEW public.v_attendance_shadow_monthly AS
SELECT employee_id,
    full_name,
    department,
    date_trunc('month'::text, day::timestamp with time zone)::date AS mesec,
    count(*) FILTER (WHERE grid_covered AND absence_code IS NULL)::integer AS radnih_dana,
    count(*) FILTER (WHERE is_comparable)::integer AS poredivih_dana,
    count(*) FILTER (WHERE is_comparable AND abs(diff_hours) <= 0.5)::integer AS ok_dana,
    count(*) FILTER (WHERE is_comparable AND abs(diff_hours) > 1.5)::integer AS problem_dana,
    round(avg(diff_hours) FILTER (WHERE is_comparable), 2) AS prosek_diff,
    count(*) FILTER (WHERE COALESCE(grid_field_hours, 0::numeric) > 0::numeric AND absence_code IS NULL)::integer AS teren_dana,
    COALESCE(sum(open_intervals) FILTER (WHERE grid_covered AND absence_code IS NULL), 0::bigint)::integer AS zaborav_izlaza,
    count(*) FILTER (WHERE NOT grid_covered AND absence_code IS NULL AND presence_hours > 1::numeric)::integer AS dana_bez_grida
   FROM v_attendance_vs_grid
  GROUP BY employee_id, full_name, department, (date_trunc('month'::text, day::timestamp with time zone));

-- ============ VIEW v_attendance_vs_grid ============
CREATE OR REPLACE VIEW public.v_attendance_vs_grid AS
SELECT d.employee_id,
    e.full_name,
    e.department,
    d.day,
    d.first_in,
    d.last_out,
    d.presence_hours,
    d.open_intervals,
    d.double_in_cnt,
    w.hours AS grid_hours,
    w.overtime_hours AS grid_overtime,
    w.field_hours AS grid_field_hours,
    w.absence_code,
    (COALESCE(w.hours, 0::numeric) + COALESCE(w.overtime_hours, 0::numeric) + COALESCE(w.field_hours, 0::numeric)) > 0::numeric AS grid_covered,
    COALESCE(w.hours, 0::numeric) > 0::numeric AND COALESCE(w.field_hours, 0::numeric) = 0::numeric AND w.absence_code IS NULL AND d.presence_hours IS NOT NULL AS is_comparable,
    round(COALESCE(d.presence_hours, 0::numeric) - COALESCE(w.hours, 0::numeric) - COALESCE(w.overtime_hours, 0::numeric) - COALESCE(w.field_hours, 0::numeric), 2) AS diff_hours
   FROM v_attendance_daily d
     JOIN employees e ON e.id = d.employee_id
     LEFT JOIN work_hours w ON w.employee_id = d.employee_id AND w.work_date = d.day;

-- ============ VIEW v_development_plans ============
CREATE OR REPLACE VIEW public.v_development_plans AS
SELECT dp.id,
    dp.employee_id,
    dp.period_label,
    dp.period_start,
    dp.period_end,
    dp.career_goal_md,
    dp.target_position_id,
    dp.mentor_employee_id,
    dp.summary_md,
    dp.self_assessment_md,
    dp.status,
    dp.created_at,
    dp.created_by,
    dp.updated_at,
    dp.updated_by,
    e.full_name AS employee_name,
    e.department AS employee_department,
    e.position_id AS employee_position_id,
    e.sub_department_id AS employee_sub_department_id,
    jp.name AS target_position_name,
    m.full_name AS mentor_name,
    COALESCE(g.goals_total, 0::bigint) AS goals_total,
    COALESCE(g.goals_done, 0::bigint) AS goals_done,
    COALESCE(g.overall_progress, 0) AS overall_progress,
    c.last_checkin_date
   FROM development_plans dp
     LEFT JOIN employees e ON e.id = dp.employee_id
     LEFT JOIN job_positions jp ON jp.id = dp.target_position_id
     LEFT JOIN employees m ON m.id = dp.mentor_employee_id
     LEFT JOIN LATERAL ( SELECT count(*) AS goals_total,
            count(*) FILTER (WHERE ee.status = 'ispunjeno'::text) AS goals_done,
            round(avg(ee.progress) FILTER (WHERE ee.status <> 'otkazano'::text))::integer AS overall_progress
           FROM employee_expectations ee
          WHERE ee.plan_id = dp.id) g ON true
     LEFT JOIN LATERAL ( SELECT max(dc.checkin_date) AS last_checkin_date
           FROM development_checkins dc
          WHERE dc.plan_id = dp.id) c ON true;

-- ============ VIEW v_employee_current_salary ============
CREATE OR REPLACE VIEW public.v_employee_current_salary AS
SELECT DISTINCT ON (employee_id) employee_id,
    id AS salary_term_id,
    salary_type,
    compensation_model,
    effective_from,
    effective_to,
    amount,
    amount_type,
    currency,
    hourly_rate,
    transport_allowance_rsd,
    per_diem_rsd,
    per_diem_eur,
    fixed_amount,
    fixed_transport_component,
    fixed_extra_hour_rate,
    first_part_amount,
    split_hour_rate,
    split_transport_amount,
    hourly_transport_amount,
    terrain_domestic_rate,
    terrain_foreign_rate,
    contract_ref,
    note,
    updated_at,
    neto_rsd,
    bruto_rsd,
    approved_by,
    approved_at,
    fixed_no_extra_hours,
    payment_window_override,
    payroll_group,
    cash_allowance_rsd
   FROM salary_terms st
  WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
  ORDER BY employee_id, effective_from DESC;

-- ============ VIEW v_employee_expectations ============
CREATE OR REPLACE VIEW public.v_employee_expectations AS
SELECT ee.id,
    ee.employee_id,
    ee.title,
    ee.description_md,
    ee.due_date,
    ee.priority,
    ee.status,
    ee.created_at,
    ee.created_by,
    ee.updated_at,
    ee.updated_by,
    ee.completed_at,
    ee.completion_note,
    ee.plan_id,
    ee.category,
    ee.progress,
        CASE
            WHEN ee.status = ANY (ARRAY['ispunjeno'::text, 'otkazano'::text]) THEN false
            WHEN ee.due_date IS NULL THEN false
            WHEN ee.due_date < CURRENT_DATE THEN true
            ELSE false
        END AS is_overdue,
        CASE
            WHEN ee.due_date IS NULL THEN NULL::integer
            ELSE ee.due_date - CURRENT_DATE
        END AS days_to_due,
    e.full_name AS employee_name,
    e.position_id AS employee_position_id,
    e.department AS employee_department
   FROM employee_expectations ee
     LEFT JOIN employees e ON e.id = ee.employee_id;

-- ============ VIEW v_employees_safe ============
CREATE OR REPLACE VIEW public.v_employees_safe AS
SELECT e.id,
    e.full_name,
    e.first_name,
    e.last_name,
    e."position",
    e.department,
    e.team,
    e.phone AS phone_work,
    e.email,
    e.hire_date,
    e.is_active,
    e.note,
    e.birth_date,
    e.gender,
    e.slava,
    e.slava_day,
    e.education_level,
    e.education_title,
    e.medical_exam_date,
    e.medical_exam_expires,
    e.work_type,
    e.department_id,
    e.sub_department_id,
    e.position_id,
    d.name AS department_name,
    sd.name AS sub_department_name,
    jp.name AS position_name,
    e.created_at,
    e.updated_at,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.personal_id
            ELSE NULL::text
        END AS personal_id,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.bank_name
            ELSE NULL::text
        END AS bank_name,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.bank_account
            ELSE NULL::text
        END AS bank_account,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.address
            ELSE NULL::text
        END AS address,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.city
            ELSE NULL::text
        END AS city,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.postal_code
            ELSE NULL::text
        END AS postal_code,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.phone_private
            ELSE NULL::text
        END AS phone_private,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.emergency_contact_name
            ELSE NULL::text
        END AS emergency_contact_name,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.emergency_contact_phone
            ELSE NULL::text
        END AS emergency_contact_phone,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.emergency_contact_relation
            ELSE NULL::text
        END AS emergency_contact_relation,
        CASE
            WHEN current_user_can_manage_employee_pii() THEN e.emergency_contact_phone_alt
            ELSE NULL::text
        END AS emergency_contact_phone_alt
   FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN sub_departments sd ON sd.id = e.sub_department_id
     LEFT JOIN job_positions jp ON jp.id = e.position_id;

-- ============ VIEW v_kadr_audit_log ============
CREATE OR REPLACE VIEW public.v_kadr_audit_log AS
SELECT l.id,
    l.actor_user_id,
    l.actor_email,
    l.action,
    l.table_name,
    l.row_id,
    l.employee_id,
    e.full_name AS employee_name,
    l.before_data,
    l.after_data,
    l.changed_at
   FROM kadr_audit_log l
     LEFT JOIN employees e ON e.id = l.employee_id;

-- ============ VIEW v_kadr_certificate_status ============
CREATE OR REPLACE VIEW public.v_kadr_certificate_status AS
SELECT c.id,
    c.employee_id,
    e.full_name AS employee_name,
    e.first_name AS employee_first_name,
    e.last_name AS employee_last_name,
    e."position" AS employee_position,
    e.department AS employee_department,
    e.is_active AS employee_active,
    c.cert_type,
    c.cert_name,
    c.issuer,
    c.document_no,
    c.issued_on,
    c.expires_on,
    c.cost_rsd,
    c.document_url,
    c.note,
        CASE
            WHEN c.expires_on IS NULL THEN 'lifetime'::text
            WHEN c.expires_on < CURRENT_DATE THEN 'expired'::text
            WHEN c.expires_on < (CURRENT_DATE + '30 days'::interval) THEN 'expiring_soon'::text
            ELSE 'ok'::text
        END AS status,
        CASE
            WHEN c.expires_on IS NOT NULL THEN c.expires_on - CURRENT_DATE
            ELSE NULL::integer
        END AS days_to_expiry
   FROM kadr_certificates c
     JOIN employees e ON e.id = c.employee_id;

-- ============ VIEW v_kadr_medical_exam_status ============
CREATE OR REPLACE VIEW public.v_kadr_medical_exam_status AS
SELECT id AS employee_id,
    full_name AS employee_name,
    first_name AS employee_first_name,
    last_name AS employee_last_name,
    "position" AS employee_position,
    department AS employee_department,
    is_active AS employee_active,
    medical_exam_date,
    medical_exam_expires,
        CASE
            WHEN medical_exam_expires IS NULL AND medical_exam_date IS NULL THEN 'never'::text
            WHEN medical_exam_expires IS NULL THEN 'unknown_expiry'::text
            WHEN medical_exam_expires < CURRENT_DATE THEN 'expired'::text
            WHEN medical_exam_expires < (CURRENT_DATE + '30 days'::interval) THEN 'expiring_soon'::text
            ELSE 'ok'::text
        END AS status,
        CASE
            WHEN medical_exam_expires IS NOT NULL THEN medical_exam_expires - CURRENT_DATE
            ELSE NULL::integer
        END AS days_to_expiry
   FROM employees e
  WHERE is_active = true;

-- ============ VIEW v_salary_payroll_month ============
CREATE OR REPLACE VIEW public.v_salary_payroll_month AS
SELECT p.id,
    p.employee_id,
    p.period_year,
    p.period_month,
    p.salary_type,
    p.advance_amount,
    p.advance_paid_on,
    p.advance_note,
    p.fixed_salary,
    p.hours_worked,
    p.hourly_rate,
    p.transport_rsd,
    p.domestic_days,
    p.per_diem_rsd,
    p.foreign_days,
    p.per_diem_eur,
    p.total_rsd,
    p.total_eur,
    p.second_part_rsd,
    p.final_paid_on,
    p.status,
    p.note,
    p.created_by,
    p.created_at,
    p.updated_at,
    p.compensation_model,
    p.fond_sati_meseca,
    p.redovan_rad_sati,
    p.prekovremeni_sati,
    p.praznik_placeni_sati,
    p.praznik_rad_sati,
    p.godisnji_sati,
    p.slobodni_dani_sati,
    p.bolovanje_65_sati,
    p.bolovanje_100_sati,
    p.dve_masine_sati,
    p.teren_u_zemlji_count,
    p.teren_u_inostranstvu_count,
    p.payable_hours,
    p.ukupna_zarada,
    p.prvi_deo,
    p.preostalo_za_isplatu,
    p.warnings,
    e.full_name AS employee_name,
    e."position" AS employee_position,
    e.department AS employee_department,
    e.is_active AS employee_active,
    e.work_type AS employee_work_type,
    e.hire_date AS employee_hire_date
   FROM salary_payroll p
     JOIN employees e ON e.id = p.employee_id;

-- ============ VIEW v_vacation_balance ============
CREATE OR REPLACE VIEW public.v_vacation_balance AS
WITH grid AS (
         SELECT wh.employee_id,
            EXTRACT(year FROM wh.work_date)::integer AS year,
            count(*) FILTER (WHERE wh.work_date <= CURRENT_DATE)::integer AS used_days,
            count(*) FILTER (WHERE wh.work_date > CURRENT_DATE)::integer AS planned_days
           FROM work_hours wh
          WHERE wh.absence_code = 'go'::text
          GROUP BY wh.employee_id, (EXTRACT(year FROM wh.work_date))
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
            COALESCE(v.accrual_start, e.hire_date) AS accrual_start
           FROM employees e
             FULL JOIN vacation_entitlements v ON v.employee_id = e.id
             FULL JOIN grid g ON g.employee_id = e.id AND (v.year IS NULL OR g.year = v.year)
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
                    ELSE ( SELECT LEAST(base.days_total, ceil(base.days_total::numeric * x.mes_odradjeno::numeric / x.mes_ukupno::numeric)::integer) AS "least"
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


-- AUTHZ/RPC SNAPSHOT: TALAS D — Projektni biro + Moj profil + Podešavanja (RBAC admin)
-- Snimljeno 2026-07-12 sa ŽIVE baze kroz Management API (zamrznuti cloud = restore-izvor sy15).
-- Re-verifikovati na živoj sy15 pre R1 (doktrina A5). NIKAD ssh — Management API / sy15 psql kroz glavnu sesiju.
-- 71 imena / 71 definicija (overloadi mogući). Grupisano: PB (37+1) / Podešavanja RBAC / authz predikati / Moj profil (deljeno sa G).
-- FRONT vs POZADINA: pb_dispatch_* + pb_enqueue_notifications + pb_in_quiet_hours + pb_engineering_lead_by_subdept
--   = POZADINA (pg_cron job 7 + edge pb-notify-dispatch, service_role) — NE seli se.
--   pb_*_sync / pb_task_deps_check_cycle_trg / user_roles_set_updated_at / audit_row_change = TRIGERI — ostaju u bazi.
--   Sekcija „MOJ PROFIL" = RPC-ovi u vlasništvu Talasa G (Kadrovska) koje profil samo POZIVA kroz GUC.

-- ============================================================================
-- PB — Projektni biro (pb_*, 37 fn) + gate can_write_pb_eng_tips
-- ============================================================================

-- ============ pb_add_eng_tip_file ============
CREATE OR REPLACE FUNCTION public.pb_add_eng_tip_file(p_tip_id uuid, p_storage_path text, p_file_name text, p_mime_type text, p_size_bytes bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_email text := nullif(trim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_cnt bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niste prijavljeni' USING ERRCODE = '42501';
  END IF;
  IF NOT public.pb_eng_tip_can_manage(p_tip_id) THEN
    RAISE EXCEPTION 'Nemate pravo da dodajete priloge' USING ERRCODE = '42501';
  END IF;
  IF nullif(trim(p_storage_path), '') IS NULL OR nullif(trim(p_file_name), '') IS NULL THEN
    RAISE EXCEPTION 'storage_path i file_name su obavezni' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_cnt FROM public.pb_eng_tip_files WHERE tip_id = p_tip_id;
  IF v_cnt >= 8 THEN
    RAISE EXCEPTION 'Maksimalno 8 priloga po savetu' USING ERRCODE = '22023';
  END IF;

  IF p_mime_type IS NOT NULL
     AND p_mime_type NOT LIKE 'image/%'
     AND p_mime_type <> 'application/pdf' THEN
    RAISE EXCEPTION 'Dozvoljeni su samo slike i PDF' USING ERRCODE = '22023';
  END IF;

  IF p_size_bytes IS NOT NULL AND p_size_bytes > 5 * 1024 * 1024 THEN
    RAISE EXCEPTION 'Fajl je veći od 5 MB' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.pb_eng_tip_files (
    tip_id, storage_path, file_name, mime_type, size_bytes, uploaded_by
  ) VALUES (
    p_tip_id, trim(p_storage_path), trim(p_file_name), nullif(trim(p_mime_type), ''),
    p_size_bytes, v_email
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id,
    'tip_id', p_tip_id,
    'storage_path', trim(p_storage_path),
    'file_name', trim(p_file_name),
    'mime_type', nullif(trim(p_mime_type), ''),
    'size_bytes', p_size_bytes
  );
END;
$function$
;

-- ============ pb_can_comment ============
CREATE OR REPLACE FUNCTION public.pb_can_comment()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select public.pb_can_edit_tasks()
      or public.current_user_role() = 'inzenjer';
$function$
;

-- ============ pb_can_edit_tasks ============
CREATE OR REPLACE FUNCTION public.pb_can_edit_tasks()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select public.current_user_is_admin()
      or public.has_edit_role()
      or public.current_user_role() = 'projektant_vodja';
$function$
;

-- ============ pb_check_dep_cycle ============
CREATE OR REPLACE FUNCTION public.pb_check_dep_cycle(p_task_id uuid, p_depends_on uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE walk AS (
    SELECT depends_on_task_id AS node
    FROM public.pb_task_deps
    WHERE task_id = p_depends_on
    UNION
    SELECT d.depends_on_task_id
    FROM public.pb_task_deps d
    JOIN walk w ON d.task_id = w.node
  )
  SELECT EXISTS (SELECT 1 FROM walk WHERE node = p_task_id) OR p_task_id = p_depends_on;
$function$
;

-- ============ pb_current_employee_id ============
CREATE OR REPLACE FUNCTION public.pb_current_employee_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.id
  FROM public.employees e
  WHERE lower(trim(coalesce(e.email, ''))) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
    AND e.is_active IS TRUE
  LIMIT 1;
$function$
;

-- ============ pb_current_user_can_see_all_reports ============
CREATE OR REPLACE FUNCTION public.pb_current_user_can_see_all_reports()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  auth_email TEXT := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
BEGIN
  IF auth_email = '' THEN
    RETURN false;
  END IF;

  IF public.current_user_is_admin() THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE lower(trim(ur.email)) = auth_email
      AND ur.project_id IS NULL
      AND ur.role IN ('leadpm', 'pm', 'menadzment')
      AND ur.is_active IS TRUE
  ) THEN
    RETURN true;
  END IF;

  IF public.pb_engineering_lead_by_subdept() THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$function$
;

-- ============ pb_delete_eng_tip_category ============
CREATE OR REPLACE FUNCTION public.pb_delete_eng_tip_category(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niste prijavljeni' USING ERRCODE = '42501';
  END IF;
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Samo admin' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.pb_eng_tip_categories WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Kategorija nije pronađena' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$
;

-- ============ pb_delete_eng_tip_file ============
CREATE OR REPLACE FUNCTION public.pb_delete_eng_tip_file(p_file_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tip_id uuid;
  v_path text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niste prijavljeni' USING ERRCODE = '42501';
  END IF;

  SELECT f.tip_id, f.storage_path
  INTO v_tip_id, v_path
  FROM public.pb_eng_tip_files f
  WHERE f.id = p_file_id;

  IF v_tip_id IS NULL THEN
    RAISE EXCEPTION 'Prilog nije pronađen' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.pb_eng_tip_can_manage(v_tip_id) THEN
    RAISE EXCEPTION 'Nemate pravo da brišete prilog' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.pb_eng_tip_files WHERE id = p_file_id;
  RETURN jsonb_build_object('ok', true, 'storage_path', v_path);
END;
$function$
;

-- ============ pb_dispatch_dequeue ============
CREATE OR REPLACE FUNCTION public.pb_dispatch_dequeue(batch_size integer DEFAULT 10)
 RETURNS TABLE(id uuid, channel text, recipient text, subject text, body text, attempts integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.pb_in_quiet_hours() THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.pb_notification_log nl
  SET status = 'processing',
      processed_at = now(),
      attempts = nl.attempts + 1
  WHERE nl.id IN (
    SELECT nl2.id FROM public.pb_notification_log nl2
    WHERE nl2.status = 'pending'
    ORDER BY nl2.created_at ASC
    LIMIT GREATEST(1, COALESCE(batch_size, 10))
    FOR UPDATE SKIP LOCKED
  )
  RETURNING nl.id, nl.channel::TEXT, nl.recipient, nl.subject, nl.body, nl.attempts;
END;
$function$
;

-- ============ pb_dispatch_mark_failed ============
CREATE OR REPLACE FUNCTION public.pb_dispatch_mark_failed(p_id uuid, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.pb_notification_log
  SET status = CASE WHEN attempts >= 5 THEN 'dead_letter' ELSE 'failed' END,
      error = p_error,
      next_attempt_at = now() + interval '30 minutes'
  WHERE id = p_id;
END;
$function$
;

-- ============ pb_dispatch_mark_sent ============
CREATE OR REPLACE FUNCTION public.pb_dispatch_mark_sent(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.pb_notification_log
  SET status = 'sent', sent_at = now()
  WHERE id = p_id AND status = 'processing';
END;
$function$
;

-- ============ pb_eng_tip_can_manage ============
CREATE OR REPLACE FUNCTION public.pb_eng_tip_can_manage(p_tip_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.pb_eng_tips t
    WHERE t.id = p_tip_id
      AND t.deleted_at IS NULL
      AND (
        public.current_user_is_admin()
        OR t.author_id IS NOT DISTINCT FROM public.pb_current_employee_id()
      )
  );
$function$
;

-- ============ pb_eng_tip_excerpt ============
CREATE OR REPLACE FUNCTION public.pb_eng_tip_excerpt(p_telo text, p_len integer DEFAULT 240)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT left(
    trim(regexp_replace(
      regexp_replace(coalesce(p_telo, ''), E'```[\\s\\S]*?```', ' ', 'g'),
      E'[#*_`\\[\\]()>~\\-]+', ' ', 'g'
    )),
    p_len
  );
$function$
;

-- ============ pb_eng_tip_likes_count_sync ============
CREATE OR REPLACE FUNCTION public.pb_eng_tip_likes_count_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.pb_eng_tips
       SET likes_count = likes_count + 1
     WHERE id = NEW.tip_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.pb_eng_tips
       SET likes_count = GREATEST(0, likes_count - 1)
     WHERE id = OLD.tip_id;
  END IF;
  RETURN NULL;
END;
$function$
;

-- ============ pb_eng_tip_visible ============
CREATE OR REPLACE FUNCTION public.pb_eng_tip_visible(p_tip_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.pb_eng_tips t
    WHERE t.id = p_tip_id
      AND t.deleted_at IS NULL
      AND (
        t.status = 'published'::public.pb_eng_tip_status
        OR public.current_user_is_admin()
        OR t.author_id IS NOT DISTINCT FROM public.pb_current_employee_id()
      )
  );
$function$
;

-- ============ pb_eng_tips_search_tsv_sync ============
CREATE OR REPLACE FUNCTION public.pb_eng_tips_search_tsv_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.naslov, '')), 'A') ||
    setweight(to_tsvector('simple', array_to_string(coalesce(NEW.tags, '{}'::text[]), ' ')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.vendor, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.telo, '')), 'C');
  RETURN NEW;
END;
$function$
;

-- ============ pb_engineering_lead_by_subdept ============
CREATE OR REPLACE FUNCTION public.pb_engineering_lead_by_subdept()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.employees e
    INNER JOIN public.sub_departments sd ON sd.id = e.sub_department_id
    WHERE e.is_active IS TRUE
      AND lower(trim(sd.name)) = lower(trim('Rukovodstvo inženjeringa'))
      AND lower(trim(coalesce(e.email, ''))) = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
  );
$function$
;

-- ============ pb_enqueue_notifications ============
CREATE OR REPLACE FUNCTION public.pb_enqueue_notifications()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cfg         public.pb_notification_config%ROWTYPE;
  v_today       DATE := CURRENT_DATE;
  v_enqueued    INTEGER := 0;
  v_task        RECORD;
  v_load        RECORD;
  v_n           INTEGER;
BEGIN
  SELECT * INTO v_cfg FROM public.pb_notification_config WHERE id = 1;
  IF NOT FOUND OR NOT v_cfg.enabled THEN
    RETURN 0;
  END IF;

  FOR v_task IN
    SELECT
      t.id,
      t.naziv,
      t.status,
      t.datum_zavrsetka_plan,
      t.datum_pocetka_plan,
      t.employee_id,
      e.full_name AS engineer_name,
      p.project_code,
      p.project_name
    FROM public.pb_tasks t
    LEFT JOIN public.employees e ON t.employee_id = e.id
    LEFT JOIN public.projects  p ON t.project_id  = p.id
    WHERE t.deleted_at IS NULL
      AND t.status <> 'Završeno'::public.pb_task_status
  LOOP
    IF v_cfg.notify_on_deadline_warning
       AND v_task.datum_zavrsetka_plan IS NOT NULL
       AND v_task.datum_zavrsetka_plan >= v_today
       AND (v_task.datum_zavrsetka_plan - v_today) <= v_cfg.deadline_warning_days
    THEN
      IF coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0
         AND NOT EXISTS (
        SELECT 1 FROM public.pb_notification_log nl
        WHERE nl.related_task_id = v_task.id
          AND nl.trigger_type = 'deadline_warning'
          AND nl.created_at::date = v_today
      ) THEN
        INSERT INTO public.pb_notification_log
          (channel, recipient, recipient_user_id, subject, body,
           trigger_type, related_task_id, related_employee_id, payload)
        SELECT
          'email',
          trim(r.r),
          (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
          'PB Upozorenje: rok ističe — ' || v_task.naziv,
          format(
            'Zadatak "%s" (projekat %s) ističe %s (%s dana).'
            || chr(10) || 'Inženjer: %s | Status: %s',
            v_task.naziv,
            coalesce(v_task.project_code, '—'),
            v_task.datum_zavrsetka_plan::text,
            (v_task.datum_zavrsetka_plan - v_today)::text,
            coalesce(v_task.engineer_name, 'nije dodeljen'),
            v_task.status
          ),
          'deadline_warning',
          v_task.id,
          v_task.employee_id,
          jsonb_build_object(
            'task_id',      v_task.id,
            'task_name',    v_task.naziv,
            'project_code', v_task.project_code,
            'deadline',     v_task.datum_zavrsetka_plan,
            'days_left',    (v_task.datum_zavrsetka_plan - v_today)
          )
        FROM unnest(v_cfg.email_recipients) AS r(r);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_enqueued := v_enqueued + v_n;
      END IF;
    END IF;

    IF v_cfg.notify_on_deadline_overdue
       AND v_task.datum_zavrsetka_plan IS NOT NULL
       AND v_task.datum_zavrsetka_plan < v_today
    THEN
      IF coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0
         AND NOT EXISTS (
        SELECT 1 FROM public.pb_notification_log nl
        WHERE nl.related_task_id = v_task.id
          AND nl.trigger_type = 'deadline_overdue'
          AND nl.created_at::date = v_today
      ) THEN
        INSERT INTO public.pb_notification_log
          (channel, recipient, recipient_user_id, subject, body,
           trigger_type, related_task_id, related_employee_id, payload)
        SELECT
          'email',
          trim(r.r),
          (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
          'PB Kašnjenje: rok prošao — ' || v_task.naziv,
          format(
            'Zadatak "%s" (projekat %s) nije završen.'
            || chr(10) || 'Rok je bio: %s (%s dana kašnjenja).'
            || chr(10) || 'Inženjer: %s | Status: %s',
            v_task.naziv,
            coalesce(v_task.project_code, '—'),
            v_task.datum_zavrsetka_plan::text,
            (v_today - v_task.datum_zavrsetka_plan)::text,
            coalesce(v_task.engineer_name, 'nije dodeljen'),
            v_task.status
          ),
          'deadline_overdue',
          v_task.id,
          v_task.employee_id,
          jsonb_build_object(
            'task_id',      v_task.id,
            'task_name',    v_task.naziv,
            'project_code', v_task.project_code,
            'deadline',     v_task.datum_zavrsetka_plan,
            'days_late',    (v_today - v_task.datum_zavrsetka_plan)
          )
        FROM unnest(v_cfg.email_recipients) AS r(r);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_enqueued := v_enqueued + v_n;
      END IF;
    END IF;

    IF v_cfg.notify_on_blocked AND v_task.status = 'Blokirano' THEN
      IF coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0
         AND NOT EXISTS (
        SELECT 1 FROM public.pb_notification_log nl
        WHERE nl.related_task_id = v_task.id
          AND nl.trigger_type = 'task_blocked'
          AND nl.created_at::date = v_today
      ) THEN
        INSERT INTO public.pb_notification_log
          (channel, recipient, recipient_user_id, subject, body,
           trigger_type, related_task_id, related_employee_id, payload)
        SELECT
          'email',
          trim(r.r),
          (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
          'PB Blokirano: ' || v_task.naziv,
          format(
            'Zadatak "%s" (projekat %s) je blokiran.'
            || chr(10) || 'Inženjer: %s',
            v_task.naziv,
            coalesce(v_task.project_code, '—'),
            coalesce(v_task.engineer_name, 'nije dodeljen')
          ),
          'task_blocked',
          v_task.id,
          v_task.employee_id,
          jsonb_build_object(
            'task_id',      v_task.id,
            'task_name',    v_task.naziv,
            'project_code', v_task.project_code
          )
        FROM unnest(v_cfg.email_recipients) AS r(r);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_enqueued := v_enqueued + v_n;
      END IF;
    END IF;

    IF v_cfg.notify_on_no_engineer
       AND v_task.employee_id IS NULL
       AND v_task.datum_pocetka_plan IS NOT NULL
       AND v_task.datum_pocetka_plan >= v_today
       AND (v_task.datum_pocetka_plan - v_today) <= coalesce(v_cfg.deadline_warning_days, 3)
    THEN
      IF coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0
         AND NOT EXISTS (
        SELECT 1 FROM public.pb_notification_log nl
        WHERE nl.related_task_id = v_task.id
          AND nl.trigger_type = 'no_engineer'
          AND nl.created_at::date = v_today
      ) THEN
        INSERT INTO public.pb_notification_log
          (channel, recipient, recipient_user_id, subject, body,
           trigger_type, related_task_id, related_employee_id, payload)
        SELECT
          'email',
          trim(r.r),
          (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
          'PB: zadatak bez inženjera — ' || v_task.naziv,
          format(
            'Zadatak "%s" (projekat %s) počinje %s, inženjer nije dodeljen.',
            v_task.naziv,
            coalesce(v_task.project_code, '—'),
            v_task.datum_pocetka_plan::text
          ),
          'no_engineer',
          v_task.id,
          NULL,
          jsonb_build_object('task_id', v_task.id, 'task_name', v_task.naziv)
        FROM unnest(v_cfg.email_recipients) AS r(r);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_enqueued := v_enqueued + v_n;
      END IF;
    END IF;
  END LOOP;

  IF v_cfg.notify_on_overload AND coalesce(array_length(v_cfg.email_recipients, 1), 0) > 0 THEN
    FOR v_load IN
      SELECT *
      FROM public.pb_get_load_stats(30)
      WHERE load_pct > v_cfg.overload_threshold_pct
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.pb_notification_log nl
        WHERE nl.related_employee_id = v_load.employee_id
          AND nl.trigger_type = 'overload'
          AND nl.created_at::date = v_today
      ) THEN
        INSERT INTO public.pb_notification_log
          (channel, recipient, recipient_user_id, subject, body,
           trigger_type, related_task_id, related_employee_id, payload)
        SELECT
          'email',
          trim(r.r),
          (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(trim(r.r)) LIMIT 1),
          'PB Preopterećenost: ' || v_load.full_name,
          format(
            'Inženjer %s je opterećen %s%% u narednih 30 dana'
            || ' (max %sh, planirano %sh).',
            v_load.full_name,
            v_load.load_pct::text,
            v_load.max_hours::text,
            v_load.total_hours::text
          ),
          'overload',
          NULL,
          v_load.employee_id,
          jsonb_build_object(
            'employee_id', v_load.employee_id,
            'full_name',   v_load.full_name,
            'load_pct',    v_load.load_pct,
            'total_hours', v_load.total_hours,
            'max_hours',   v_load.max_hours
          )
        FROM unnest(v_cfg.email_recipients) AS r(r);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_enqueued := v_enqueued + v_n;
      END IF;
    END LOOP;
  END IF;

  RETURN v_enqueued;
END;
$function$
;

-- ============ pb_get_eng_tip ============
CREATE OR REPLACE FUNCTION public.pb_get_eng_tip(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niste prijavljeni' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'id je obavezan' USING ERRCODE = '22023';
  END IF;

  IF NOT public.pb_eng_tip_visible(p_id) THEN
    RAISE EXCEPTION 'Savet nije pronađen' USING ERRCODE = 'P0002';
  END IF;

  BEGIN
    UPDATE public.pb_eng_tips SET views_count = views_count + 1 WHERE id = p_id;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  SELECT jsonb_build_object(
    'id', t.id,
    'naslov', t.naslov,
    'telo', t.telo,
    'category_id', t.category_id,
    'category', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', c.id, 'naziv', c.naziv, 'slug', c.slug, 'ikona', c.ikona, 'boja', c.boja
    ) END,
    'tags', t.tags,
    'vendor', t.vendor,
    'url', t.url,
    'project_id', t.project_id,
    'project', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', p.id, 'project_code', p.project_code, 'project_name', p.project_name
    ) END,
    'status', t.status,
    'author_id', t.author_id,
    'author', CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', e.id, 'full_name', e.full_name, 'email', e.email
    ) END,
    'author_email', t.author_email,
    'likes_count', t.likes_count,
    'views_count', t.views_count,
    'is_liked_by_me', EXISTS (
      SELECT 1 FROM public.pb_eng_tip_likes l
      WHERE l.tip_id = t.id AND l.user_id = auth.uid()
    ),
    'created_at', t.created_at,
    'updated_at', t.updated_at,
    'files', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', f.id,
        'file_name', f.file_name,
        'mime_type', f.mime_type,
        'is_image', f.is_image,
        'size_bytes', f.size_bytes,
        'storage_path', f.storage_path
      ) ORDER BY f.created_at)
      FROM public.pb_eng_tip_files f
      WHERE f.tip_id = t.id
    ), '[]'::jsonb)
  )
  INTO v_row
  FROM public.pb_eng_tips t
  LEFT JOIN public.pb_eng_tip_categories c ON c.id = t.category_id
  LEFT JOIN public.projects p ON p.id = t.project_id
  LEFT JOIN public.employees e ON e.id = t.author_id
  WHERE t.id = p_id AND t.deleted_at IS NULL;

  IF v_row IS NULL THEN
    RAISE EXCEPTION 'Savet nije pronađen' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_row;
END;
$function$
;

-- ============ pb_get_load_stats ============
CREATE OR REPLACE FUNCTION public.pb_get_load_stats(window_days integer DEFAULT 30)
 RETURNS TABLE(employee_id uuid, full_name text, total_hours numeric, max_hours numeric, load_pct integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today DATE := CURRENT_DATE;
BEGIN
  RETURN QUERY
  WITH
  workday_window AS (
    SELECT
      gs.d::date AS day,
      ROW_NUMBER() OVER (ORDER BY gs.d) AS rn
    FROM generate_series(v_today, v_today + (window_days * 2 + 14), '1 day'::interval) AS gs(d)
    WHERE EXTRACT(DOW FROM gs.d) NOT IN (0, 6)
  ),
  window_days_cte AS (
    SELECT day FROM workday_window WHERE rn <= window_days
  ),
  window_size AS (
    SELECT COUNT(*)::INTEGER AS n_days FROM window_days_cte
  ),
  candidate_employees AS (
    SELECT e.id AS employee_id, e.full_name
    FROM public.employees e
    WHERE e.is_active = TRUE
      AND (
        EXISTS (
          SELECT 1
          FROM public.sub_departments sd
          INNER JOIN public.departments d ON d.id = sd.department_id
          WHERE sd.id = e.sub_department_id
            AND d.name = 'Inženjering i projektovanje'
            AND sd.name = 'Mašinsko projektovanje'
        )
        OR (
          e.sub_department_id IS NULL
          AND (
            lower(trim(coalesce(e.department, ''))) LIKE '%mašinsko%'
            OR lower(trim(coalesce(e.department, ''))) LIKE '%masinski%'
          )
          AND lower(trim(coalesce(e.department, ''))) LIKE '%projektovanje%'
        )
        OR EXISTS (
          SELECT 1
          FROM public.sub_departments sd_ip
          INNER JOIN public.departments d_ip ON d_ip.id = sd_ip.department_id
          WHERE sd_ip.id = e.sub_department_id
            AND d_ip.name = 'Inženjering i projektovanje'
            AND sd_ip.name IN ('Hidraulika i algoritmi', 'Rukovodstvo inženjeringa')
        )
        OR EXISTS (
          SELECT 1
          FROM public.sub_departments sd2
          INNER JOIN public.departments d2 ON d2.id = sd2.department_id
          WHERE sd2.id = e.sub_department_id
            AND d2.name = 'Projekti'
            AND sd2.name = 'PM tim'
        )
        OR EXISTS (
          SELECT 1
          FROM public.job_positions jp
          INNER JOIN public.departments d3 ON d3.id = jp.department_id
          WHERE jp.id = e.position_id
            AND d3.name = 'Projekti'
            AND jp.name IN ('LEAD PM', 'Projekt menadžer')
        )
        OR (
          e.position_id IS NULL
          AND lower(trim(coalesce(e.position, ''))) IN ('lead pm', 'pm', 'projekt menadžer')
          AND (
            e.department_id = (SELECT id FROM public.departments WHERE name = 'Projekti' LIMIT 1)
            OR lower(trim(coalesce(e.department, ''))) LIKE '%projekt%'
          )
        )
        OR lower(trim(e.full_name)) IN (
          'milorad jerotić',
          'milorad jerotic',
          'slaviša radosavljević',
          'slavisa radosavljevic',
          'radosavljević slaviša',
          'radosavljevic slavisa',
          'radisavljević slaviša',
          'radisavljevic slavisa',
          'slaviša radisavljević',
          'igor voštić',
          'igor vostic',
          'voštić igor',
          'vostic igor',
          'gnjidić tatjana',
          'tatjana gnjidić'
        )
      )
  ),
  per_day AS (
    SELECT
      ce.employee_id,
      ce.full_name,
      w.day,
      COALESCE(SUM(t.norma_sati_dan), 0)::NUMERIC AS day_hours
    FROM candidate_employees ce
    CROSS JOIN window_days_cte w
    LEFT JOIN public.pb_tasks t ON
      t.employee_id = ce.employee_id
      AND t.status <> 'Završeno'::public.pb_task_status
      AND t.deleted_at IS NULL
      AND t.datum_pocetka_plan IS NOT NULL
      AND t.datum_zavrsetka_plan IS NOT NULL
      AND w.day BETWEEN t.datum_pocetka_plan AND t.datum_zavrsetka_plan
    GROUP BY ce.employee_id, ce.full_name, w.day
  ),
  per_employee AS (
    SELECT
      pd.employee_id,
      pd.full_name,
      SUM(LEAST(pd.day_hours, 7))::NUMERIC AS total_hours
    FROM per_day pd
    GROUP BY pd.employee_id, pd.full_name
  )
  SELECT
    pe.employee_id,
    pe.full_name,
    pe.total_hours,
    (ws.n_days * 7)::NUMERIC AS max_hours,
    CASE WHEN ws.n_days > 0
      THEN ROUND(pe.total_hours * 100.0 / (ws.n_days * 7))::INTEGER
      ELSE 0
    END AS load_pct
  FROM per_employee pe
  CROSS JOIN window_size ws
  ORDER BY load_pct DESC, pe.full_name;
END;
$function$
;

-- ============ pb_get_mechanical_projecting_engineers ============
CREATE OR REPLACE FUNCTION public.pb_get_mechanical_projecting_engineers()
 RETURNS TABLE(id uuid, full_name text, department text, email text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.id, e.full_name, e.department, e.email
  FROM public.employees e
  WHERE e.is_active = TRUE
    AND (
      EXISTS (
        SELECT 1
        FROM public.sub_departments sd
        INNER JOIN public.departments d ON d.id = sd.department_id
        WHERE sd.id = e.sub_department_id
          AND d.name = 'Inženjering i projektovanje'
          AND sd.name = 'Mašinsko projektovanje'
      )
      OR (
        e.sub_department_id IS NULL
        AND (
          lower(trim(coalesce(e.department, ''))) LIKE '%mašinsko%'
          OR lower(trim(coalesce(e.department, ''))) LIKE '%masinski%'
        )
        AND lower(trim(coalesce(e.department, ''))) LIKE '%projektovanje%'
      )
      OR EXISTS (
        SELECT 1
        FROM public.sub_departments sd_ip
        INNER JOIN public.departments d_ip ON d_ip.id = sd_ip.department_id
        WHERE sd_ip.id = e.sub_department_id
          AND d_ip.name = 'Inženjering i projektovanje'
          AND sd_ip.name IN ('Hidraulika i algoritmi', 'Rukovodstvo inženjeringa')
      )
      OR EXISTS (
        SELECT 1
        FROM public.sub_departments sd2
        INNER JOIN public.departments d2 ON d2.id = sd2.department_id
        WHERE sd2.id = e.sub_department_id
          AND d2.name = 'Projekti'
          AND sd2.name = 'PM tim'
      )
      OR EXISTS (
        SELECT 1
        FROM public.job_positions jp
        INNER JOIN public.departments d3 ON d3.id = jp.department_id
        WHERE jp.id = e.position_id
          AND d3.name = 'Projekti'
          AND jp.name IN ('LEAD PM', 'Projekt menadžer')
      )
      OR (
        e.position_id IS NULL
        AND lower(trim(coalesce(e.position, ''))) IN ('lead pm', 'pm', 'projekt menadžer')
        AND (
          e.department_id = (SELECT id FROM public.departments WHERE name = 'Projekti' LIMIT 1)
          OR lower(trim(coalesce(e.department, ''))) LIKE '%projekt%'
        )
      )
      OR lower(trim(e.full_name)) IN (
        'milorad jerotić',
        'milorad jerotic',
        'slaviša radosavljević',
        'slavisa radosavljevic',
        'radosavljević slaviša',
        'radosavljevic slavisa',
        'radisavljević slaviša',
        'radisavljevic slavisa',
        'slaviša radisavljević',
        'igor voštić',
        'igor vostic',
        'voštić igor',
        'vostic igor',
        'gnjidić tatjana',
        'tatjana gnjidić'
      )
    )
  ORDER BY e.full_name ASC;
$function$
;

-- ============ pb_get_team_load_stats ============
CREATE OR REPLACE FUNCTION public.pb_get_team_load_stats(window_days integer DEFAULT 20)
 RETURNS TABLE(sub_department_id integer, sub_department_name text, department_name text, member_count integer, avg_load_pct integer, max_load_pct integer, total_hours numeric, max_hours numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH per_emp AS (
    SELECT
      ls.employee_id,
      ls.load_pct,
      ls.total_hours,
      ls.max_hours,
      e.sub_department_id
    FROM public.pb_get_load_stats(window_days) ls
    JOIN public.employees e ON e.id = ls.employee_id
  )
  SELECT
    sd.id                                  AS sub_department_id,
    sd.name                                AS sub_department_name,
    d.name                                 AS department_name,
    COUNT(*)::INTEGER                      AS member_count,
    ROUND(AVG(pe.load_pct))::INTEGER       AS avg_load_pct,
    MAX(pe.load_pct)::INTEGER              AS max_load_pct,
    SUM(pe.total_hours)::NUMERIC           AS total_hours,
    SUM(pe.max_hours)::NUMERIC             AS max_hours
  FROM per_emp pe
  JOIN public.sub_departments sd ON sd.id = pe.sub_department_id
  JOIN public.departments d      ON d.id  = sd.department_id
  GROUP BY sd.id, sd.name, d.name
  ORDER BY avg_load_pct DESC NULLS LAST;
$function$
;

-- ============ pb_get_work_report_summary ============
CREATE OR REPLACE FUNCTION public.pb_get_work_report_summary(p_date_from date, p_date_to date, p_employee_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(employee_id uuid, full_name text, report_count integer, total_hours numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    e.id AS employee_id,
    e.full_name,
    COUNT(wr.id)::integer AS report_count,
    COALESCE(SUM(wr.sati), 0)::numeric AS total_hours
  FROM public.pb_work_reports wr
  INNER JOIN public.employees e ON e.id = wr.employee_id
  WHERE wr.datum BETWEEN p_date_from AND p_date_to
    AND (
      public.pb_current_user_can_see_all_reports()
      OR wr.employee_id IS NOT DISTINCT FROM public.pb_current_employee_id()
    )
    AND (
      p_employee_id IS NULL
      OR wr.employee_id = p_employee_id
    )
  GROUP BY e.id, e.full_name
  ORDER BY total_hours DESC;
END;
$function$
;

-- ============ pb_in_quiet_hours ============
CREATE OR REPLACE FUNCTION public.pb_in_quiet_hours()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cfg public.pb_notification_config%ROWTYPE;
  v_now TIME;
BEGIN
  SELECT * INTO v_cfg FROM public.pb_notification_config WHERE id = 1;
  IF NOT FOUND OR v_cfg.quiet_hours_start IS NULL OR v_cfg.quiet_hours_end IS NULL THEN
    RETURN FALSE;
  END IF;
  v_now := (now() AT TIME ZONE COALESCE(v_cfg.quiet_hours_tz, 'Europe/Belgrade'))::TIME;
  IF v_cfg.quiet_hours_start < v_cfg.quiet_hours_end THEN
    RETURN v_now >= v_cfg.quiet_hours_start AND v_now < v_cfg.quiet_hours_end;
  ELSE
    RETURN v_now >= v_cfg.quiet_hours_start OR v_now < v_cfg.quiet_hours_end;
  END IF;
END;
$function$
;

-- ============ pb_list_eng_tip_categories ============
CREATE OR REPLACE FUNCTION public.pb_list_eng_tip_categories()
 RETURNS SETOF pb_eng_tip_categories
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT *
  FROM public.pb_eng_tip_categories
  WHERE je_aktivna IS TRUE
  ORDER BY redosled ASC, naziv ASC;
$function$
;

-- ============ pb_list_eng_tips ============
CREATE OR REPLACE FUNCTION public.pb_list_eng_tips(p_filter jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(id uuid, naslov text, excerpt text, category_id uuid, category_naziv text, category_ikona text, category_boja text, tags text[], vendor text, project_id uuid, project_code text, project_name text, author_id uuid, author_full_name text, status pb_eng_tip_status, likes_count integer, views_count integer, files_count bigint, is_liked_by_me boolean, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_search text := nullif(trim(coalesce(p_filter->>'search', '')), '');
  v_sort text := coalesce(nullif(trim(p_filter->>'sort', ''), ''), 'recent');
  v_limit int := LEAST(GREATEST(coalesce((p_filter->>'limit')::int, 100), 1), 500);
  v_offset int := GREATEST(coalesce((p_filter->>'offset')::int, 0), 0);
  v_my_only boolean := coalesce((p_filter->>'my_only')::boolean, false);
  v_include_drafts boolean := coalesce((p_filter->>'include_drafts')::boolean, false);
  v_category_ids uuid[];
  v_tags text[];
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niste prijavljeni' USING ERRCODE = '42501';
  END IF;

  IF p_filter ? 'category_ids' AND jsonb_typeof(p_filter->'category_ids') = 'array' THEN
    SELECT coalesce(array_agg(x::uuid), '{}')
    INTO v_category_ids
    FROM jsonb_array_elements_text(p_filter->'category_ids') AS t(x)
    WHERE nullif(trim(x), '') IS NOT NULL;
  END IF;

  IF p_filter ? 'tags' AND jsonb_typeof(p_filter->'tags') = 'array' THEN
    SELECT coalesce(array_agg(lower(trim(x))), '{}')
    INTO v_tags
    FROM jsonb_array_elements_text(p_filter->'tags') AS t(x)
    WHERE nullif(trim(x), '') IS NOT NULL;
  END IF;

  RETURN QUERY
  SELECT
    t.id,
    t.naslov,
    public.pb_eng_tip_excerpt(t.telo, 240) AS excerpt,
    t.category_id,
    c.naziv AS category_naziv,
    c.ikona AS category_ikona,
    c.boja AS category_boja,
    t.tags,
    t.vendor,
    t.project_id,
    p.project_code,
    p.project_name,
    t.author_id,
    e.full_name AS author_full_name,
    t.status,
    t.likes_count,
    t.views_count,
    (SELECT count(*)::bigint FROM public.pb_eng_tip_files f WHERE f.tip_id = t.id) AS files_count,
    EXISTS (
      SELECT 1 FROM public.pb_eng_tip_likes l
      WHERE l.tip_id = t.id AND l.user_id = v_uid
    ) AS is_liked_by_me,
    t.created_at,
    t.updated_at
  FROM public.pb_eng_tips t
  LEFT JOIN public.pb_eng_tip_categories c ON c.id = t.category_id
  LEFT JOIN public.projects p ON p.id = t.project_id
  LEFT JOIN public.employees e ON e.id = t.author_id
  WHERE t.deleted_at IS NULL
    AND (
      t.status = 'published'::public.pb_eng_tip_status
      OR (
        v_include_drafts
        AND (
          public.current_user_is_admin()
          OR t.author_id IS NOT DISTINCT FROM public.pb_current_employee_id()
        )
      )
    )
    AND (NOT v_my_only OR t.author_id IS NOT DISTINCT FROM public.pb_current_employee_id())
    AND (v_category_ids IS NULL OR cardinality(v_category_ids) = 0 OR t.category_id = ANY (v_category_ids))
    AND (v_tags IS NULL OR cardinality(v_tags) = 0 OR t.tags && v_tags)
    AND (
      v_search IS NULL
      OR t.search_tsv @@ websearch_to_tsquery('simple', v_search)
    )
  ORDER BY
    CASE WHEN v_search IS NOT NULL THEN ts_rank(t.search_tsv, websearch_to_tsquery('simple', v_search)) END DESC NULLS LAST,
    CASE WHEN v_sort = 'popular' THEN t.likes_count END DESC NULLS LAST,
    t.created_at DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$
;

-- ============ pb_list_projects ============
CREATE OR REPLACE FUNCTION public.pb_list_projects()
 RETURNS TABLE(id uuid, project_code text, project_name text, status text, predmet_item_id integer, projectm text, project_deadline date, pm_email text, leadpm_email text, reminder_enabled boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT
    p.id,
    p.project_code,
    p.project_name,
    p.status,
    p.bigtehn_item_id AS predmet_item_id,
    p.projectm,
    p.project_deadline,
    p.pm_email,
    p.leadpm_email,
    p.reminder_enabled
  FROM public.projects p
  INNER JOIN production.predmet_aktivacija pa ON pa.predmet_item_id = p.bigtehn_item_id
  WHERE p.bigtehn_item_id IS NOT NULL AND pa.je_aktivan IS TRUE AND pa.je_projektovanje_montaza IS TRUE
  ORDER BY p.project_code ASC NULLS LAST, p.project_name ASC;
$function$
;

-- ============ pb_normalize_project_code ============
CREATE OR REPLACE FUNCTION public.pb_normalize_project_code(txt text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT regexp_replace(
    regexp_replace(lower(trim(COALESCE(txt, ''))), '^rn[[:space:]]*', ''),
    '[[:space:]]',
    '',
    'g'
  );
$function$
;

-- ============ pb_predmet_project_uuid ============
CREATE OR REPLACE FUNCTION public.pb_predmet_project_uuid(p_item_id integer)
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT (
    substr(m, 1, 8) || '-' ||
    substr(m, 9, 4) || '-' ||
    '5' || substr(m, 13, 3) || '-' ||
    '8' || substr(m, 17, 3) || '-' ||
    substr(m, 21, 12)
  )::uuid
  FROM (SELECT md5('servoteh_pb_predmet:v1:' || p_item_id::text) AS m) s;
$function$
;

-- ============ pb_save_eng_tip ============
CREATE OR REPLACE FUNCTION public.pb_save_eng_tip(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_email text := nullif(trim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_author_id uuid := public.pb_current_employee_id();
  v_naslov text;
  v_telo text;
  v_status public.pb_eng_tip_status;
  v_tags text[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niste prijavljeni' USING ERRCODE = '42501';
  END IF;

  v_naslov := nullif(trim(coalesce(p_payload->>'naslov', '')), '');
  v_telo := nullif(trim(coalesce(p_payload->>'telo', '')), '');

  IF v_naslov IS NULL OR length(v_naslov) < 3 OR length(v_naslov) > 200 THEN
    RAISE EXCEPTION 'Naslov mora imati 3–200 karaktera' USING ERRCODE = '22023';
  END IF;
  IF v_telo IS NULL OR length(v_telo) < 10 THEN
    RAISE EXCEPTION 'Telo mora imati najmanje 10 karaktera' USING ERRCODE = '22023';
  END IF;

  IF p_payload ? 'tags' AND jsonb_typeof(p_payload->'tags') = 'array' THEN
    SELECT coalesce(array_agg(DISTINCT nullif(trim(x), '')), '{}')
    INTO v_tags
    FROM jsonb_array_elements_text(p_payload->'tags') AS t(x);
    IF cardinality(v_tags) > 10 THEN
      RAISE EXCEPTION 'Maksimalno 10 tag-ova' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_tags := '{}';
  END IF;

  v_status := coalesce(
    nullif(trim(p_payload->>'status'), '')::public.pb_eng_tip_status,
    'draft'::public.pb_eng_tip_status
  );

  v_id := nullif(trim(coalesce(p_payload->>'id', '')), '')::uuid;

  IF v_id IS NULL THEN
    IF NOT public.can_write_pb_eng_tips() THEN
      RAISE EXCEPTION 'Nemate pravo da kreirate savete' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.pb_eng_tips (
      naslov, telo, category_id, tags, vendor, url, project_id, status,
      author_id, author_email, created_by, updated_by
    ) VALUES (
      v_naslov,
      v_telo,
      nullif(trim(coalesce(p_payload->>'category_id', '')), '')::uuid,
      v_tags,
      nullif(trim(coalesce(p_payload->>'vendor', '')), ''),
      nullif(trim(coalesce(p_payload->>'url', '')), ''),
      nullif(trim(coalesce(p_payload->>'project_id', '')), '')::uuid,
      v_status,
      v_author_id,
      v_email,
      v_email,
      v_email
    )
    RETURNING id INTO v_id;
  ELSE
    IF NOT (
      public.current_user_is_admin()
      OR EXISTS (
        SELECT 1 FROM public.pb_eng_tips t
        WHERE t.id = v_id
          AND t.deleted_at IS NULL
          AND t.author_id IS NOT DISTINCT FROM v_author_id
      )
    ) THEN
      RAISE EXCEPTION 'Nemate pravo da menjate ovaj savet' USING ERRCODE = '42501';
    END IF;

    UPDATE public.pb_eng_tips
    SET
      naslov = v_naslov,
      telo = v_telo,
      category_id = nullif(trim(coalesce(p_payload->>'category_id', '')), '')::uuid,
      tags = v_tags,
      vendor = nullif(trim(coalesce(p_payload->>'vendor', '')), ''),
      url = nullif(trim(coalesce(p_payload->>'url', '')), ''),
      project_id = nullif(trim(coalesce(p_payload->>'project_id', '')), '')::uuid,
      status = v_status,
      updated_by = v_email
  WHERE id = v_id AND deleted_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Savet nije pronađen' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN public.pb_get_eng_tip(v_id);
END;
$function$
;

-- ============ pb_soft_delete_eng_tip ============
CREATE OR REPLACE FUNCTION public.pb_soft_delete_eng_tip(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text := nullif(trim(coalesce(auth.jwt() ->> 'email', '')), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niste prijavljeni' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'id je obavezan' USING ERRCODE = '22023';
  END IF;

  IF NOT public.pb_eng_tip_can_manage(p_id) THEN
    RAISE EXCEPTION 'Nemate pravo da brišete ovaj savet' USING ERRCODE = '42501';
  END IF;

  UPDATE public.pb_eng_tips
  SET deleted_at = now(), updated_by = v_email
  WHERE id = p_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Savet nije pronađen' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$
;

-- ============ pb_soft_delete_task ============
CREATE OR REPLACE FUNCTION public.pb_soft_delete_task(p_task_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text := COALESCE(auth.jwt() ->> 'email', '');
BEGIN
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'task_id je obavezan' USING ERRCODE = '22023';
  END IF;
  IF NOT public.pb_can_edit_tasks() THEN
    RAISE EXCEPTION 'Nemate pravo da brišete zadatke' USING ERRCODE = '42501';
  END IF;

  UPDATE public.pb_tasks
  SET
    deleted_at = now(),
    updated_by = NULLIF(trim(v_email), '')
  WHERE id = p_task_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zadatak nije pronađen ili je već obrisan' USING ERRCODE = 'P0002';
  END IF;
END;
$function$
;

-- ============ pb_soft_delete_tasks ============
CREATE OR REPLACE FUNCTION public.pb_soft_delete_tasks(p_task_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text := COALESCE(auth.jwt() ->> 'email', '');
  v_n integer;
BEGIN
  IF p_task_ids IS NULL OR array_length(p_task_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  IF NOT public.pb_can_edit_tasks() THEN
    RAISE EXCEPTION 'Nemate pravo da brišete zadatke' USING ERRCODE = '42501';
  END IF;

  UPDATE public.pb_tasks
  SET
    deleted_at = now(),
    updated_by = NULLIF(trim(v_email), '')
  WHERE id = ANY (p_task_ids)
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$
;

-- ============ pb_task_deps_check_cycle_trg ============
CREATE OR REPLACE FUNCTION public.pb_task_deps_check_cycle_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF public.pb_check_dep_cycle(NEW.task_id, NEW.depends_on_task_id) THEN
    RAISE EXCEPTION 'Ciklična zavisnost između zadataka nije dozvoljena (task_id=%, depends_on=%)',
      NEW.task_id, NEW.depends_on_task_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$
;

-- ============ pb_toggle_eng_tip_like ============
CREATE OR REPLACE FUNCTION public.pb_toggle_eng_tip_like(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := nullif(trim(coalesce(auth.jwt() ->> 'email', '')), '');
  v_liked boolean;
  v_count int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Niste prijavljeni' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'id je obavezan' USING ERRCODE = '22023';
  END IF;
  IF NOT public.pb_eng_tip_visible(p_id) THEN
    RAISE EXCEPTION 'Savet nije pronađen' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM public.pb_eng_tip_likes WHERE tip_id = p_id AND user_id = v_uid) THEN
    DELETE FROM public.pb_eng_tip_likes WHERE tip_id = p_id AND user_id = v_uid;
    v_liked := false;
  ELSE
    INSERT INTO public.pb_eng_tip_likes (tip_id, user_id, user_email)
    VALUES (p_id, v_uid, v_email);
    v_liked := true;
  END IF;

  SELECT likes_count INTO v_count FROM public.pb_eng_tips WHERE id = p_id;
  RETURN jsonb_build_object('liked', v_liked, 'likes_count', coalesce(v_count, 0));
END;
$function$
;

-- ============ pb_update_task_progress ============
CREATE OR REPLACE FUNCTION public.pb_update_task_progress(p_task_id uuid, p_status text, p_procenat integer)
 RETURNS pb_tasks
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r public.pb_tasks;
begin
  if not public.pb_can_comment() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_procenat is not null and (p_procenat < 0 or p_procenat > 100) then
    raise exception 'procenat mora biti 0..100';
  end if;
  update public.pb_tasks
     set status = coalesce(p_status::public.pb_task_status, status),
         procenat_zavrsenosti = coalesce(p_procenat, procenat_zavrsenosti),
         updated_at = now()
   where id = p_task_id and deleted_at is null
   returning * into r;
  if not found then
    raise exception 'zadatak nije nadjen';
  end if;
  return r;
end;
$function$
;

-- ============ pb_upsert_eng_tip_category ============
CREATE OR REPLACE FUNCTION public.pb_upsert_eng_tip_category(p_payload jsonb)
 RETURNS pb_eng_tip_categories
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_naziv text;
  v_slug text;
  v_row public.pb_eng_tip_categories;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Niste prijavljeni' USING ERRCODE = '42501';
  END IF;
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Samo admin' USING ERRCODE = '42501';
  END IF;

  v_naziv := nullif(trim(coalesce(p_payload->>'naziv', '')), '');
  IF v_naziv IS NULL THEN
    RAISE EXCEPTION 'naziv je obavezan' USING ERRCODE = '22023';
  END IF;

  v_slug := nullif(trim(coalesce(p_payload->>'slug', '')), '');
  IF v_slug IS NULL THEN
    v_slug := lower(regexp_replace(regexp_replace(v_naziv, '\s+', '-', 'g'), '[^a-zA-Z0-9\-]+', '', 'g'));
  END IF;

  v_id := nullif(trim(coalesce(p_payload->>'id', '')), '')::uuid;

  IF v_id IS NULL THEN
    INSERT INTO public.pb_eng_tip_categories (naziv, slug, ikona, boja, redosled, je_aktivna)
    VALUES (
      v_naziv,
      v_slug,
      nullif(trim(coalesce(p_payload->>'ikona', '')), ''),
      nullif(trim(coalesce(p_payload->>'boja', '')), ''),
      coalesce((p_payload->>'redosled')::int, 0),
      coalesce((p_payload->>'je_aktivna')::boolean, true)
    )
    RETURNING * INTO v_row;
  ELSE
    UPDATE public.pb_eng_tip_categories
    SET
      naziv = v_naziv,
      slug = v_slug,
      ikona = coalesce(nullif(trim(coalesce(p_payload->>'ikona', '')), ''), ikona),
      boja = coalesce(nullif(trim(coalesce(p_payload->>'boja', '')), ''), boja),
      redosled = coalesce((p_payload->>'redosled')::int, redosled),
      je_aktivna = coalesce((p_payload->>'je_aktivna')::boolean, je_aktivna)
    WHERE id = v_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$function$
;

-- ============ can_write_pb_eng_tips ============
CREATE OR REPLACE FUNCTION public.can_write_pb_eng_tips()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    public.pb_can_edit_tasks()
    OR public.current_user_role() IN ('inzenjer','projektant_vodja')
    OR EXISTS (
      SELECT 1
      FROM public.pb_get_mechanical_projecting_engineers() eng
      WHERE eng.id IS NOT DISTINCT FROM public.pb_current_employee_id()
    );
$function$
;

-- ============================================================================
-- PODEŠAVANJA — RBAC admin (nalozi/role/override/predmet aktivacija/audit)
-- ============================================================================

-- ============ admin_invite_user_role ============
CREATE OR REPLACE FUNCTION public.admin_invite_user_role(p_email text, p_role text, p_full_name text DEFAULT ''::text, p_team text DEFAULT ''::text, p_project_id uuid DEFAULT NULL::uuid, p_managed_sub_department_ids integer[] DEFAULT NULL::integer[], p_send_recovery boolean DEFAULT true, p_plan_montaze_readonly boolean DEFAULT false, p_kadrovska_access boolean DEFAULT false, p_kadrovska_hide_contracts boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_email text := lower(trim(coalesce(p_email, '')));
  v_role text := lower(trim(coalesce(p_role, 'viewer')));
  v_actor text := public.current_user_email();
  v_uid uuid;
  v_row public.user_roles%ROWTYPE;
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_email = '' OR v_email !~ '^[^@]+@[^@]+\.[^@]+$' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;
  -- Sinhronizovano sa ROLE_LABELS u src/lib/constants.js i allowedRoles u
  -- supabase/functions/admin-invite-user/index.ts.
  IF v_role NOT IN (
    'admin','hr','menadzment','pm','leadpm','viewer','magacioner',
    'cnc_operater','inzenjer','projektant_vodja','poslovni_admin','monter',
    'tim_lider','proizvodni_radnik'
  ) THEN
    RAISE EXCEPTION 'invalid_role';
  END IF;

  SELECT id INTO v_uid FROM auth.users WHERE lower(email) = v_email LIMIT 1;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'auth_user_missing',
      'message', 'Auth nalog za ovaj email ne postoji. Koristite Edge admin-invite-user da se kreira nalog i uloga odjednom.'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE lower(ur.email) = v_email
      AND ur.is_active = true
      AND (
        (p_project_id IS NULL AND ur.project_id IS NULL)
        OR ur.project_id IS NOT DISTINCT FROM p_project_id
      )
  ) THEN
    RAISE EXCEPTION 'duplicate_active_role';
  END IF;

  INSERT INTO public.user_roles (
    email, role, project_id, is_active, full_name, team,
    managed_sub_department_ids, created_by, must_change_password,
    plan_montaze_readonly, kadrovska_access, kadrovska_hide_contracts
  ) VALUES (
    v_email,
    v_role,
    p_project_id,
    true,
    coalesce(nullif(trim(p_full_name), ''), ''),
    coalesce(nullif(trim(p_team), ''), ''),
    CASE
      WHEN p_managed_sub_department_ids IS NULL THEN NULL
      WHEN cardinality(p_managed_sub_department_ids) = 0 THEN NULL
      ELSE p_managed_sub_department_ids
    END,
    coalesce(v_actor, ''),
    true,
    coalesce(p_plan_montaze_readonly, false),
    coalesce(p_kadrovska_access, false),
    coalesce(p_kadrovska_hide_contracts, false)
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'user_role', to_jsonb(v_row),
    'auth_user_id', v_uid,
    'send_recovery', coalesce(p_send_recovery, true)
  );
END;
$function$
;

-- ============ get_my_user_roles ============
CREATE OR REPLACE FUNCTION public.get_my_user_roles()
 RETURNS TABLE(email text, role text, project_id uuid, is_active boolean, managed_departments text[], managed_sub_department_ids integer[], plan_montaze_readonly boolean, kadrovska_access boolean, kadrovska_hide_contracts boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    ur.email, ur.role, ur.project_id, ur.is_active,
    ur.managed_departments, ur.managed_sub_department_ids,
    ur.plan_montaze_readonly, ur.kadrovska_access, ur.kadrovska_hide_contracts
  FROM public.user_roles AS ur
  WHERE lower(ur.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    AND ur.is_active IS TRUE;
$function$
;

-- ============ clear_my_must_change_password ============
CREATE OR REPLACE FUNCTION public.clear_my_must_change_password()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE public.user_roles
     SET must_change_password = false,
         updated_at = now()
   WHERE lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
     AND must_change_password IS DISTINCT FROM false;
$function$
;

-- ============ ack_user_roles_password_changed ============
CREATE OR REPLACE FUNCTION public.ack_user_roles_password_changed()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text := lower(trim(coalesce(auth.jwt() ->> 'email', '')));
BEGIN
  IF v_email = '' THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  UPDATE public.user_roles
  SET must_change_password = false,
      updated_at = now()
  WHERE lower(trim(email)) = v_email
    AND is_active = true;
END;
$function$
;

-- ============ user_roles_set_updated_at ============
CREATE OR REPLACE FUNCTION public.user_roles_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $function$
;

-- ============ list_predmet_aktivacija_admin ============
CREATE OR REPLACE FUNCTION public.list_predmet_aktivacija_admin()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT production.list_predmet_aktivacija_admin();
$function$
;

-- ============ set_predmet_aktivacija ============
CREATE OR REPLACE FUNCTION public.set_predmet_aktivacija(p_item_id integer, p_aktivan boolean, p_napomena text DEFAULT NULL::text, p_projektovanje_montaza boolean DEFAULT NULL::boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'production', 'pg_temp'
AS $function$
  SELECT production.set_predmet_aktivacija(
    p_item_id,
    p_aktivan,
    p_napomena,
    p_projektovanje_montaza
  );
$function$
;

-- ============ can_manage_predmet_aktivacija ============
CREATE OR REPLACE FUNCTION public.can_manage_predmet_aktivacija()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    public.current_user_is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE LOWER(ur.email) = LOWER(COALESCE((auth.jwt() ->> 'email'), ''))
        AND COALESCE(ur.is_active, true) IS TRUE
        AND ur.role = 'menadzment'
    );
$function$
;

-- ============ audit_row_change ============
CREATE OR REPLACE FUNCTION public.audit_row_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_action text := TG_OP;
  v_table  text := TG_TABLE_NAME;
  v_rec_id text;
  v_old    jsonb;
  v_new    jsonb;
  v_diff   text[] := '{}';
  v_key    text;
  v_email  text;
  v_uid    uuid;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN v_new := to_jsonb(NEW); END IF;

  IF TG_OP = 'DELETE' THEN
    v_rec_id := COALESCE(v_old ->> 'id', v_old ->> 'employee_id', v_old ->> 'pk');
  ELSE
    v_rec_id := COALESCE(v_new ->> 'id', v_new ->> 'employee_id', v_new ->> 'pk');
  END IF;

  IF TG_OP = 'UPDATE' AND v_old IS NOT NULL AND v_new IS NOT NULL THEN
    FOR v_key IN SELECT key FROM jsonb_each(v_new) LOOP
      IF (v_new -> v_key) IS DISTINCT FROM (v_old -> v_key) THEN
        v_diff := array_append(v_diff, v_key);
      END IF;
    END LOOP;
    IF array_length(v_diff, 1) IS NULL THEN RETURN NULL; END IF;
    IF array_length(v_diff, 1) = 1 AND v_diff[1] = 'updated_at' THEN RETURN NULL; END IF;
  END IF;

  BEGIN v_email := public.current_user_email(); EXCEPTION WHEN OTHERS THEN v_email := NULL; END;
  BEGIN v_uid := auth.uid(); EXCEPTION WHEN OTHERS THEN v_uid := NULL; END;

  INSERT INTO public.audit_log (table_name, record_id, action, actor_email, actor_uid, old_data, new_data, diff_keys)
  VALUES (v_table, v_rec_id, v_action, v_email, v_uid, v_old, v_new, v_diff);

  RETURN NULL;
END;
$function$
;

-- ============ audit_log_cleanup ============
CREATE OR REPLACE FUNCTION public.audit_log_cleanup(older_than_days integer DEFAULT 730)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE deleted_count integer;
BEGIN
  IF NOT public.current_user_is_admin() THEN RAISE EXCEPTION 'audit_log_cleanup: samo admin'; END IF;
  DELETE FROM public.audit_log WHERE changed_at < now() - make_interval(days => older_than_days);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$
;

-- ============================================================================
-- AUTHZ PREDIKATI (deljeni helperi — koriste ih politike više modula)
-- ============================================================================

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

-- ============================================================================
-- MOJ PROFIL — front RPC (DELJENO sa Kadrovskom/Talas G — vlasnik ostaje G!)
-- ============================================================================

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

-- ============ get_team_issued_tools ============
CREATE OR REPLACE FUNCTION public.get_team_issued_tools()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT coalesce(jsonb_agg(row ORDER BY (row->>'issued_at') DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'recipient_employee_id', d.recipient_employee_id,
      'document_id', d.id,
      'doc_number', d.doc_number,
      'issued_at', d.issued_at,
      'expected_return_date', d.expected_return_date,
      'document_status', d.status,
      'oznaka', t.oznaka,
      'naziv', t.naziv,
      'serijski_broj', t.serijski_broj,
      'quantity', l.quantity,
      'unit', l.unit,
      'pribor', l.napomena,
      'line_status', l.line_status,
      'subgroup_label', s.label,
      'group_label', g.label
    ) AS row
    FROM public.rev_document_lines l
    JOIN public.rev_documents d ON d.id = l.document_id
    LEFT JOIN public.rev_tools t ON t.id = l.tool_id
    LEFT JOIN public.rev_inventory_subgroups s ON s.id = t.subgroup_id
    LEFT JOIN public.rev_inventory_groups g ON g.id = s.group_id
    WHERE l.line_type = 'TOOL'
      AND l.line_status = 'ISSUED'
      AND d.status = ANY (ARRAY['OPEN'::text, 'PARTIALLY_RETURNED'::text])
      AND d.recipient_employee_id IS NOT NULL
      AND public.current_user_manages_employee(d.recipient_employee_id)
  ) q;
$function$
;

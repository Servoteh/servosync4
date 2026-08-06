-- =====================================================================================
-- POVRATAK (rollback) za 074/26 — VRAĆA kadr_queue_makeup_notification na verziju
-- koja je bila živa na sy15 pre 06.08.2026.
--
-- Snimljeno preko `pg_get_functiondef` NEPOSREDNO pre primene izmene.
-- Pusti SAMO ako nova verzija pravi problem:
--   ssh ubuntusrv "docker exec -i sy15-db psql -U supabase_admin -d postgres" < ovaj_fajl
--
-- ⚠️ Stara verzija NE čita `compensation_type` — mejl za „dan odmora" opet počinje da
-- tvrdi „Datum izostanka" za dan kada čovek RADI vikendom (to je i bio kvar 074/26).
-- =====================================================================================

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

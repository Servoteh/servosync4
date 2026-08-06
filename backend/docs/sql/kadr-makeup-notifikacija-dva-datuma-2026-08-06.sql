-- =====================================================================================
-- ZAHTEV 074/26 (Miljan Nikodijević, 06.08.2026) — mejl o nadoknadi sati mora da nosi
-- OBA datuma i da za „dan odmora" ne tvrdi izostanak.
--
-- BAZA: sy15 (self-hosted, ubuntusrv) — `docker exec -i sy15-db psql -U supabase_admin -d postgres`
-- IDEMPOTENTNO: CREATE OR REPLACE FUNCTION; sme da se pusti više puta.
--
-- ŠTA JE BILO POGREŠNO (mereno 06.08.2026 nad živom `makeup_requests`, 9 redova):
--   tip          | redova | bez weekend_work_date | weekend_work_date = absence_date | ima makeup_deadline
--   nadoknada    |   3    |          3            |               0                  |         2
--   dan_odmora   |   6    |          0            |               6                  |         0
--
--   1) Stara verzija fn NIJE čitala ni `compensation_type` ni `weekend_work_date` —
--      SVAKI mejl je ispisivao `absence_date` pod nazivom „Datum izostanka". Za
--      `dan_odmora` je to obrnuto od istine: tog dana čovek RADI (vikend), a ne izostaje.
--      Živi primer 06.08.2026 06:10 (Veljko, Nikola Mrkajić, Nenad):
--      „Nadoknada sati — Arsić Nikola. Datum izostanka: 22.08.2026 (8.0 h)" — 22.08. je
--      subota koju Nikola RADI. Isto je važilo i za naslov i za telo koje ide RADNIKU
--      na `approved` („Odobren je izostanak uz nadoknadu sati za …").
--   2) Za tip `nadoknada` mejl nadležnima NIKAD nije prikazivao `makeup_deadline`
--      (rok nadoknade), iako ga 2 od 3 postojeća reda imaju.
--
-- ODLUKA VLASNIKA (Nenad, 06.08.2026): za `dan_odmora` se u formi dodaje NEOBAVEZNO
-- polje „Planirani slobodan dan" koje se upisuje u `absence_date`. Ko ga ne zna —
-- ostavi prazno i `absence_date` ostaje jednak `weekend_work_date` (današnje ponašanje).
--
-- BEZBEDNOST IZMENE: svi ostali potrošači radnog datuma koriste
-- `COALESCE(weekend_work_date, absence_date)` i za `dan_odmora` UVEK pogode
-- `weekend_work_date` (mereno: 0/6 redova bez njega), pa im drugačiji `absence_date`
-- ne menja rezultat. Provereno (06.08.2026):
--   * backend/src/modules/kadrovska/grid-autofill.service.ts:421
--   * backend/src/modules/kadrovska/kadrovska-mutations.service.ts:447 i :542
--   * backend/src/modules/kadrovska/kadrovska.service.ts:857 i :1153
--   * backend/src/modules/moj-profil/moj-profil.service.ts:235
--   * sy15 `kadr_storno_makeup` — čita ISKLJUČIVO `v_req.weekend_work_date`
--   * nijedna druga sy15 funkcija ni view ne čita `makeup_requests.absence_date`
--     (provera: pg_get_functiondef nad prokind='f' + pg_get_viewdef — 0 pogodaka
--     van `kadr_queue_makeup_notification`)
--
-- ŠTA OSTAJE NETAKNUTO: lista primalaca, RLS, SECURITY DEFINER, search_path, uslovi
-- za upis u `kadr_notification_log`, kao i SVI postojeći ključevi u `v_payload`
-- (dodata su samo dva nova: `compensation_type` i `weekend_work_date`).
-- Za tip `nadoknada` tekstovi naslova i tela ostaju DOSLOVNO isti kao pre.
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
  v_ctype      text; v_weekend date;
  v_dan_odmora boolean; v_work_date date; v_free_day date; v_kind text;
  v_subject    text; v_emp_body text; v_over_body text; v_payload jsonb;
BEGIN
  SELECT COALESCE(e.full_name, e.first_name || ' ' || e.last_name, 'Zaposleni'),
         e.email, e.id, m.absence_date, m.absence_hours, m.makeup_deadline, m.makeup_plan, m.reason,
         m.compensation_type, m.weekend_work_date
    INTO v_emp_name, v_emp_email, v_emp_id, v_abs_date, v_hours, v_deadline, v_plan, v_reason,
         v_ctype, v_weekend
    FROM makeup_requests m JOIN employees e ON e.id = m.employee_id
   WHERE m.id = p_request_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_dan_odmora := COALESCE(v_ctype, 'nadoknada') = 'dan_odmora';
  /* Radni datum — ISTI izraz koji koriste svi ostali potrošači (`COALESCE`), da
     mejl nikad ne pokaže drugi dan od onog koji grant/autofill stvarno koriste. */
  v_work_date  := COALESCE(v_weekend, v_abs_date);
  /* 074/26: za 'dan_odmora' je `absence_date` istorijski PUKI DUPLIKAT
     `weekend_work_date`; od 074/26 sme da nosi PLANIRAN slobodan dan. Prikazuje se
     samo kad se stvarno razlikuje — inače bi 6 zatečenih redova dobilo besmislen
     red „Planirani slobodan dan" jednak danu rada. */
  v_free_day := CASE WHEN v_dan_odmora AND v_weekend IS NOT NULL
                      AND v_abs_date IS DISTINCT FROM v_weekend
                     THEN v_abs_date ELSE NULL END;
  v_kind := CASE WHEN v_dan_odmora THEN 'Dan odmora (rad vikendom)' ELSE 'Nadoknada sati' END;

  v_payload := jsonb_build_object('status', p_status, 'absence_date', v_abs_date,
                                  'hours', v_hours, 'deadline', v_deadline,
                                  'compensation_type', v_ctype,
                                  'weekend_work_date', v_weekend);

  IF p_status = 'submitted' THEN
    v_subject := 'Nov zahtev — ' || lower(v_kind) || ' — ' || v_emp_name;
  ELSIF p_status = 'sef_approved' THEN
    v_subject := v_kind || ' — odobrio šef, čeka HR — ' || v_emp_name;
  ELSIF p_status = 'approved' THEN
    v_subject := v_kind || ' — odobreno — ' || v_emp_name;
    v_emp_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || CASE WHEN v_dan_odmora
              THEN '<h2 style="color:#16a34a;margin-bottom:4px;">✅ Dan odmora odobren (rad vikendom)</h2>'
              ELSE '<h2 style="color:#16a34a;margin-bottom:4px;">✅ Nadoknada sati odobrena</h2>' END
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>,</p>'
      || CASE WHEN v_dan_odmora THEN
              '<p>Odobren je <strong>rad vikendom ' || to_char(v_work_date,'DD.MM.YYYY')
              || '</strong> (' || v_hours::text || ' h). U saldo godišnjeg odmora dodaje se '
              || '<strong>+1 dan</strong> (kucani sati tog dana se brišu — zamena, ne duplo).</p>'
              || CASE WHEN v_free_day IS NOT NULL
                      THEN '<p>Planirani slobodan dan: <strong>' || to_char(v_free_day,'DD.MM.YYYY')
                           || '</strong>.</p>'
                      ELSE '' END
         ELSE
              '<p>Odobren je izostanak uz nadoknadu sati za <strong>' || to_char(v_abs_date,'DD.MM.YYYY')
              || '</strong> (' || v_hours::text || ' h).</p>'
              || '<p>Sate je potrebno nadoknaditi'
              || CASE WHEN v_deadline IS NOT NULL THEN ' do <strong>' || to_char(v_deadline,'DD.MM.YYYY') || '</strong>' ELSE '' END
              || CASE WHEN COALESCE(v_plan,'') <> '' THEN ', prema planu: ' || v_plan ELSE '' END || '.</p>'
         END
      || '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">'
      || '<p style="font-size:.85em;color:#64748b;"><em>Servoteh HR</em></p></div>';
  ELSIF p_status = 'rejected' THEN
    v_subject := v_kind || ' — odbijeno — ' || v_emp_name;
    v_emp_body :=
      '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">'
      || '<h2 style="color:#dc2626;margin-bottom:4px;">❌ Zahtev za '
      || CASE WHEN v_dan_odmora THEN 'dan odmora' ELSE 'nadoknadu sati' END || ' odbijen</h2>'
      || '<p>Poštovani/a <strong>' || v_emp_name || '</strong>, Vaš zahtev za '
      || CASE WHEN v_dan_odmora
              THEN 'dan odmora (rad vikendom <strong>' || to_char(v_work_date,'DD.MM.YYYY') || '</strong>)'
              ELSE 'nadoknadu sati za <strong>' || to_char(v_abs_date,'DD.MM.YYYY') || '</strong>' END
      || ' je odbijen.</p>'
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
    || '<h2 style="margin-bottom:4px;">' || v_kind || ' — ' || v_emp_name || '</h2>'
    || CASE WHEN v_dan_odmora THEN
            '<p>Radi vikendom: <strong>' || to_char(v_work_date,'DD.MM.YYYY') || '</strong> ('
            || v_hours::text || ' h). Status: <strong>' || p_status || '</strong>.</p>'
            || CASE WHEN v_free_day IS NOT NULL
                    THEN '<p>Planirani slobodan dan: <strong>' || to_char(v_free_day,'DD.MM.YYYY') || '</strong></p>'
                    ELSE '' END
       ELSE
            '<p>Datum odsustva: <strong>' || to_char(v_abs_date,'DD.MM.YYYY') || '</strong> ('
            || v_hours::text || ' h). Status: <strong>' || p_status || '</strong>.</p>'
            || CASE WHEN v_deadline IS NOT NULL
                    THEN '<p>Datum nadoknade sati: <strong>' || to_char(v_deadline,'DD.MM.YYYY') || '</strong></p>'
                    ELSE '' END
       END
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
$function$;

-- =====================================================================================
-- PROVERA POSLE PRIMENE (samo SELECT; ne šalje mejlove — fn se NE poziva).
--
--   -- 1) Da li nova verzija stvarno stoji (mora vratiti true):
--   SELECT pg_get_functiondef(p.oid) ILIKE '%Radi vikendom%' AS nova_verzija
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'kadr_queue_makeup_notification';
--
--   -- 2) Zatečeni redovi i kako će ih mejl opisati:
--   SELECT id, compensation_type,
--          to_char(COALESCE(weekend_work_date, absence_date),'DD.MM.YYYY') AS radni_dan,
--          CASE WHEN compensation_type = 'dan_odmora'
--                AND weekend_work_date IS NOT NULL
--                AND absence_date IS DISTINCT FROM weekend_work_date
--               THEN to_char(absence_date,'DD.MM.YYYY') END AS planirani_slobodan_dan,
--          to_char(makeup_deadline,'DD.MM.YYYY') AS rok_nadoknade
--     FROM makeup_requests ORDER BY created_at DESC;
-- =====================================================================================

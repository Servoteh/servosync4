-- AUTHZ/RPC SNAPSHOT: TALAS B — Sastanci (sast_*/sastanci_*) + AI asistent (ai_chat_*) — snimljeno 2026-07-12
-- Izvor: zamrznuti cloud = restore-izvor sy15 (Management API, node scripts/sb-exec-sql.mjs iz 1.0 repoa).
-- Re-verifikovati na ZIVOJ sy15 pre R1 (R0 korak glavne sesije).
-- 62 funkcija ukupno. Podela (vidi MODULE_SPEC_sastanci_ai_30.md §0):
--   FRONT RPC (poziva 1.0 klijent, 13): sast_weekly_status, sast_weekly_pomeri, sast_weekly_odlozi, sast_weekly_vrati, sast_zakljucaj_sastanak, sastanci_send_invites, sastanci_remind_unprepared, sastanci_resend_meeting_locked, sastanci_set_my_rsvp, sastanci_get_or_create_my_prefs, get_sastanci_user_directory, set_sastanci_ai_model, ai_chat_ja
--   EDGE-TOOL RPC (poziva edge ai-chat SA JWT-om KORISNIKA, 22): ai_chat_can_view_employee, ai_chat_dodaj_belesku, ai_chat_dodaj_uputstvo, ai_chat_employee_lookup, ai_chat_go_pregled, ai_chat_go_saldo, ai_chat_go_zahtevi, ai_chat_inzenjering, ai_chat_kvar_istorija, ai_chat_maint_resolve, ai_chat_masina_info, ai_chat_masina_uputstvo, ai_chat_moj_tim, ai_chat_norm_name, ai_chat_odsustva, ai_chat_opis_pozicije, ai_chat_pretrazi_uputstva, ai_chat_pretrazi_znanje, ai_chat_prijavi_kvar, ai_chat_projekat_info, ai_chat_sati, ai_chat_sql
--   POZADINA (pg_cron / service_role / trigeri — NE seli se, ostaje u sy15): ostatak.
-- pg_cron poslovi (zivi 12.07): sast_weekly_auto_create_a/b (0 6/7 * * 5), sast_action_reminders_daily (0 7 * * *),
--   sast_meeting_reminders_30min (*/30), sast_notify_dispatch_every_2_min (*/2 → pg_net + vault → edge sastanci-notify-dispatch).

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

-- ============ ai_chat_dodaj_belesku ============
CREATE OR REPLACE FUNCTION public.ai_chat_dodaj_belesku(p_ref text, p_naslov text, p_tekst text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_ime text;
  v_id uuid;
begin
  if coalesce(trim(p_tekst), '') = '' then
    return jsonb_build_object('error', 'prazno', 'poruka', 'Beleška je prazna.');
  end if;
  if not exists (select 1 from projects where project_code = trim(p_ref)) then
    return jsonb_build_object('error', 'nepoznat_projekat',
      'poruka', 'Projekat ' || coalesce(p_ref, '?') || ' ne postoji u planu montaže.');
  end if;
  select full_name into v_ime from employees where lower(email) = v_email limit 1;
  insert into ai_project_notes (project_ref, title, content, created_by, author_name)
  values (trim(p_ref), nullif(trim(coalesce(p_naslov, '')), ''), trim(p_tekst), auth.uid(),
          coalesce(v_ime, split_part(v_email, '@', 1)))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id,
    'poruka', 'Beleška sačuvana za projekat ' || trim(p_ref) || '.');
end;
$function$

-- ============ ai_chat_dodaj_uputstvo ============
CREATE OR REPLACE FUNCTION public.ai_chat_dodaj_uputstvo(p_naslov text, p_sadrzaj text, p_modul text DEFAULT NULL::text, p_kljucne_reci text DEFAULT NULL::text, p_vidljivost text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_ime text;
  v_id uuid;
  v_update boolean := false;
  v_vid text := case when p_vidljivost in ('svi', 'admin_hr') then p_vidljivost else null end;
begin
  if not public.current_user_is_hr_or_admin() then
    return jsonb_build_object('error', 'nema_prava', 'poruka', 'Uputstva mogu da menjaju samo administratori i HR.');
  end if;
  if coalesce(trim(p_naslov), '') = '' or coalesce(trim(p_sadrzaj), '') = '' then
    return jsonb_build_object('error', 'prazno', 'poruka', 'Naslov i sadržaj su obavezni.');
  end if;
  select full_name into v_ime from employees where lower(email) = v_email limit 1;
  select id into v_id from ai_uputstva where lower(naslov) = lower(trim(p_naslov)) limit 1;
  if v_id is not null then
    update ai_uputstva
      set sadrzaj = trim(p_sadrzaj),
          modul = coalesce(nullif(trim(coalesce(p_modul, '')), ''), modul),
          kljucne_reci = coalesce(nullif(trim(coalesce(p_kljucne_reci, '')), ''), kljucne_reci),
          vidljivost = coalesce(v_vid, vidljivost),
          author_name = coalesce(v_ime, author_name),
          aktivno = true,
          embedding = null,
          updated_at = now()
      where id = v_id;
    v_update := true;
  else
    insert into ai_uputstva (naslov, modul, sadrzaj, kljucne_reci, vidljivost, author_name, created_by)
    values (trim(p_naslov), nullif(trim(coalesce(p_modul, '')), ''), trim(p_sadrzaj),
            nullif(trim(coalesce(p_kljucne_reci, '')), ''), coalesce(v_vid, 'svi'),
            coalesce(v_ime, split_part(v_email, '@', 1)), auth.uid())
    returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'azurirano', v_update,
    'poruka', case when v_update then 'Uputstvo ažurirano.' else 'Uputstvo sačuvano.' end);
end;
$function$

-- ============ ai_chat_employee_lookup ============
CREATE OR REPLACE FUNCTION public.ai_chat_employee_lookup(p_ime text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_self uuid := public.current_user_employee_id();
  v_out jsonb;
begin
  select jsonb_build_object(
    'ja', (select jsonb_build_object('employee_id', e.id, 'ime', e.full_name, 'pozicija', e.position)
             from employees e where e.id = v_self),
    'rezultati', coalesce((
      select jsonb_agg(jsonb_build_object('employee_id', t.id, 'ime', t.full_name, 'pozicija', t.position))
      from (
        select e.id, e.full_name, e.position
        from employees e
        where e.is_active is true
          and (e.id = v_self or public.current_user_manages_employee(e.id))
          and (
            p_ime is null or trim(p_ime) = ''
            -- svaka rec iz upita mora da se nadje NEGDE u imenu, redosled nebitan
            or not exists (
              select 1
              from regexp_split_to_table(public.ai_chat_norm_name(trim(p_ime)), '\s+') as tok(t)
              where t <> '' and public.ai_chat_norm_name(e.full_name) not like '%' || t || '%'
            )
          )
        order by e.full_name
        limit 12
      ) t), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_go_pregled ============
CREATE OR REPLACE FUNCTION public.ai_chat_go_pregled(p_employee_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_emp uuid := coalesce(p_employee_id, public.current_user_employee_id());
  v_god int := extract(year from current_date)::int;
  v_from date := make_date(v_god, 1, 1);
  v_to date := make_date(v_god + 1, 1, 1);
  v_bal record;
  v_out jsonb;
begin
  if v_emp is null then
    return jsonb_build_object('error', 'nema_zaposlenog',
      'poruka', 'Nalog pozivaoca nije povezan sa kartonom zaposlenog.');
  end if;
  if not public.ai_chat_can_view_employee(v_emp) then
    return jsonb_build_object('error', 'nema_prava',
      'poruka', 'Pozivalac nema pravo uvida u ovog zaposlenog.');
  end if;

  select b.days_total, b.days_carried_over, b.accrual_model, b.days_earned,
         b.days_used, b.days_planned,
         coalesce(b.days_remaining_accrued, b.days_remaining) as preostalo
    into v_bal
  from v_vacation_balance b
  where b.employee_id = v_emp and b.year = v_god;

  with dani as (
    select w.work_date,
           w.work_date - (row_number() over (order by w.work_date))::int as grp
    from work_hours w
    where w.employee_id = v_emp
      and w.work_date >= v_from and w.work_date < v_to
      and w.absence_code = 'go'
  ),
  periodi as (
    select min(work_date) as od, max(work_date) as do_, count(*) as dana
    from dani group by grp
  )
  select jsonb_build_object(
    'zaposleni', (select full_name from employees where id = v_emp),
    'godina', v_god,
    'danasnji_datum', to_char(current_date, 'DD.MM.YYYY.'),
    'godisnje_pravo', v_bal.days_total,
    'preneto_iz_prosle', v_bal.days_carried_over,
    'srazmerno_sticanje', v_bal.accrual_model,
    'zaradjeno_do_danas', v_bal.days_earned,
    -- Na raspolaganju sada: stalni = pravo+preneto; novozaposleni = zarađeno+preneto.
    'ukupno_na_raspolaganju',
      coalesce(v_bal.days_earned, v_bal.days_total) + coalesce(v_bal.days_carried_over, 0),
    'iskorisceno', coalesce(v_bal.days_used, 0),
    'planirano', coalesce(v_bal.days_planned, 0),
    'preostalo_zakljucno_sa_danas', coalesce(v_bal.preostalo, 0),
    'periodi_iskorisceno', coalesce((
      select jsonb_agg(jsonb_build_object(
               'od', to_char(p.od, 'DD.MM.YYYY.'),
               'do', to_char(p.do_, 'DD.MM.YYYY.'),
               'dana', p.dana) order by p.od)
      from periodi p where p.do_ <= current_date), '[]'::jsonb),
    'periodi_planirano', coalesce((
      select jsonb_agg(jsonb_build_object(
               'od', to_char(p.od, 'DD.MM.YYYY.'),
               'do', to_char(p.do_, 'DD.MM.YYYY.'),
               'dana', p.dana) order by p.od)
      from periodi p where p.od > current_date), '[]'::jsonb)
  ) into v_out;

  return coalesce(v_out, jsonb_build_object('error', 'nema_podataka',
    'poruka', 'Za ovog zaposlenog nema salda GO za tekuću godinu.'));
end;
$function$

-- ============ ai_chat_go_saldo ============
CREATE OR REPLACE FUNCTION public.ai_chat_go_saldo(p_employee_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_emp uuid := coalesce(p_employee_id, public.current_user_employee_id());
  v_out jsonb;
begin
  if v_emp is null then
    return jsonb_build_object('error', 'nema_zaposlenog',
      'poruka', 'Nalog pozivaoca nije povezan sa kartonom zaposlenog.');
  end if;
  if not public.ai_chat_can_view_employee(v_emp) then
    return jsonb_build_object('error', 'nema_prava',
      'poruka', 'Pozivalac nema pravo uvida u ovog zaposlenog.');
  end if;
  select jsonb_build_object(
    'zaposleni', e.full_name,
    'godina', b.year,
    'godisnje_pravo', b.days_total,
    'preneto_iz_prosle', b.days_carried_over,
    'srazmerno_sticanje', b.accrual_model,
    'zaradjeno_do_danas', b.days_earned,
    'iskorisceno', b.days_used,
    'planirano_ubuduce', b.days_planned,
    'preostalo', coalesce(b.days_remaining_accrued, b.days_remaining)
  ) into v_out
  from v_vacation_balance b
  join employees e on e.id = b.employee_id
  where b.employee_id = v_emp and b.year = extract(year from current_date)::int;
  return coalesce(v_out, jsonb_build_object('error', 'nema_podataka',
    'poruka', 'Za ovog zaposlenog nema salda GO za tekuću godinu.'));
end;
$function$

-- ============ ai_chat_go_zahtevi ============
CREATE OR REPLACE FUNCTION public.ai_chat_go_zahtevi(p_employee_id uuid DEFAULT NULL::uuid, p_godina integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_emp uuid := coalesce(p_employee_id, public.current_user_employee_id());
  v_out jsonb;
begin
  if v_emp is null then
    return jsonb_build_object('error', 'nema_zaposlenog',
      'poruka', 'Nalog pozivaoca nije povezan sa kartonom zaposlenog.');
  end if;
  if not public.ai_chat_can_view_employee(v_emp) then
    return jsonb_build_object('error', 'nema_prava',
      'poruka', 'Pozivalac nema pravo uvida u ovog zaposlenog.');
  end if;
  select jsonb_build_object(
    'zaposleni', (select full_name from employees where id = v_emp),
    'danasnji_datum', to_char(current_date, 'DD.MM.YYYY.'),
    'zahtevi', coalesce((
      select jsonb_agg(jsonb_build_object(
        'od', to_char(r.date_from, 'DD.MM.YYYY.'),
        'do', to_char(r.date_to, 'DD.MM.YYYY.'),
        'dana', r.days_count,
        'status', r.status,
        'vremenski_status', case
          when r.date_to < current_date then 'iskorisceno'
          when r.date_from > current_date then 'planirano'
          else 'u_toku'
        end,
        'napomena', nullif(r.note, ''),
        'razlog_odbijanja', nullif(r.rejection_note, ''),
        'podnet', to_char(r.created_at, 'DD.MM.YYYY.')
      ) order by r.date_from desc)
      from (
        select * from vacation_requests
        where employee_id = v_emp
          and (p_godina is null or year = p_godina)
        order by date_from desc
        limit 15
      ) r), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_inzenjering ============
CREATE OR REPLACE FUNCTION public.ai_chat_inzenjering(p_upit text, p_projekat text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_upit text := public.ai_chat_norm_name(trim(coalesce(p_upit, '')));
  v_proj uuid;
  v_out jsonb;
begin
  if v_upit = '' then
    return jsonb_build_object('error', 'prazan_upit', 'poruka', 'Zadaj pojam pretrage.');
  end if;
  if p_projekat is not null and trim(p_projekat) <> '' then
    select id into v_proj from projects where project_code = trim(p_projekat) limit 1;
  end if;
  select jsonb_build_object(
    'zadaci', coalesce((
      select jsonb_agg(jsonb_build_object(
        'naziv', t.naziv, 'projekat', t.project_code, 'status', t.status,
        'procenat', t.procenat_zavrsenosti, 'inzenjer', t.inz,
        'opis', left(coalesce(t.opis, ''), 400), 'problem', nullif(left(coalesce(t.problem, ''), 300), '')))
      from (
        select t.*, p.project_code, e.full_name as inz
        from pb_tasks t
        left join projects p on p.id = t.project_id
        left join employees e on e.id = t.employee_id
        where t.deleted_at is null
          and (v_proj is null or t.project_id = v_proj)
          and public.ai_chat_norm_name(coalesce(t.naziv,'') || ' ' || coalesce(t.opis,'') || ' ' || coalesce(t.problem,''))
              like '%' || v_upit || '%'
        order by t.updated_at desc limit 8
      ) t), '[]'::jsonb),
    'komentari', coalesce((
      select jsonb_agg(jsonb_build_object(
        'zadatak', c.naziv, 'projekat', c.project_code,
        'komentar', left(c.body, 400), 'autor', c.created_by, 'datum', to_char(c.created_at, 'DD.MM.YYYY.')))
      from (
        select c.body, c.created_by, c.created_at, t.naziv, p.project_code
        from pb_task_comments c
        join pb_tasks t on t.id = c.task_id
        left join projects p on p.id = t.project_id
        where (v_proj is null or t.project_id = v_proj)
          and public.ai_chat_norm_name(c.body) like '%' || v_upit || '%'
        order by c.created_at desc limit 6
      ) c), '[]'::jsonb),
    'radni_izvestaji', coalesce((
      select jsonb_agg(jsonb_build_object(
        'datum', to_char(w.datum, 'DD.MM.YYYY.'), 'inzenjer', w.inz, 'sati', w.sati,
        'opis', left(coalesce(w.opis, ''), 400)))
      from (
        select w.datum, w.sati, w.opis, e.full_name as inz
        from pb_work_reports w
        left join employees e on e.id = w.employee_id
        where public.ai_chat_norm_name(coalesce(w.opis, '')) like '%' || v_upit || '%'
        order by w.datum desc limit 6
      ) w), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_ja ============
CREATE OR REPLACE FUNCTION public.ai_chat_ja()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce((
    select jsonb_build_object(
      'ime', e.first_name,
      'puno_ime', e.full_name,
      'pozicija', nullif(e.position, ''),
      'odeljenje', nullif(e.department, '')
    )
    from employees e
    where lower(e.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    limit 1
  ), jsonb_build_object('ime', null));
$function$

-- ============ ai_chat_kvar_istorija ============
CREATE OR REPLACE FUNCTION public.ai_chat_kvar_istorija(p_masina text DEFAULT NULL::text, p_upit text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_mc text; v_upit text := public.ai_chat_norm_name(trim(coalesce(p_upit,'')));
  v_out jsonb;
begin
  if p_masina is not null and trim(p_masina) <> '' then
    select machine_code into v_mc from public.ai_chat_maint_resolve(p_masina);
    if v_mc is null then
      return jsonb_build_object('error', 'nema_masine', 'poruka', 'Mašina nije nađena.');
    end if;
    if not public.maint_machine_visible(v_mc) then
      return jsonb_build_object('error', 'nema_prava', 'poruka', 'Nemaš pravo uvida u ovu mašinu.');
    end if;
  end if;
  select jsonb_build_object('kvarovi', coalesce((
    select jsonb_agg(jsonb_build_object(
      'masina', i.machine_code, 'naslov', i.title,
      'opis', left(coalesce(i.description,''), 400),
      'ozbiljnost', i.severity, 'status', i.status,
      'prijavljen', to_char(i.reported_at, 'DD.MM.YYYY.'),
      'reseno', to_char(i.resolved_at, 'DD.MM.YYYY.'),
      'resenje', nullif(left(coalesce(i.resolution_notes,''), 500), ''),
      'napomene_tehnicara', coalesce((
        select string_agg(nullif(trim(ev.comment),''), ' | ')
        from maint_incident_events ev where ev.incident_id = i.id and ev.comment is not null), null)))
    from (
      select * from maint_incidents i
      where public.maint_machine_visible(i.machine_code)
        and (v_mc is null or i.machine_code = v_mc)
        and (v_upit = '' or public.ai_chat_norm_name(
              coalesce(i.title,'') || ' ' || coalesce(i.description,'') || ' ' || coalesce(i.resolution_notes,''))
            like '%' || v_upit || '%')
      order by i.reported_at desc limit 8
    ) i), '[]'::jsonb)) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_maint_resolve ============
CREATE OR REPLACE FUNCTION public.ai_chat_maint_resolve(p_masina text)
 RETURNS TABLE(machine_code text, asset_id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.machine_code, m.asset_id, m.name
  from maint_machines m
  where m.archived_at is null
    and (m.machine_code = trim(p_masina)
         or public.ai_chat_norm_name(m.name) like '%' || public.ai_chat_norm_name(trim(p_masina)) || '%')
  order by (m.machine_code = trim(p_masina)) desc, m.name
  limit 1;
$function$

-- ============ ai_chat_masina_info ============
CREATE OR REPLACE FUNCTION public.ai_chat_masina_info(p_masina text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_mc text; v_aid uuid; v_naziv text;
  v_out jsonb;
begin
  select machine_code, asset_id, name into v_mc, v_aid, v_naziv
  from public.ai_chat_maint_resolve(p_masina);
  if v_mc is null then
    return jsonb_build_object('error', 'nema_masine', 'poruka', 'Mašina „' || coalesce(p_masina,'') || '" nije nađena u katalogu održavanja.');
  end if;
  -- Osnovni karton vidi SVAKO (radnik potvrđuje koju mašinu prijavljuje);
  -- otvoreni kvarovi / kontrole / dokumenti samo za maint-vidljive (operator svoje, tehničar/šef sve).
  if not public.maint_machine_visible(v_mc) then
    return jsonb_build_object(
      'masina', (select jsonb_build_object(
          'sifra', m.machine_code, 'naziv', m.name, 'tip', m.type,
          'proizvodjac', m.manufacturer, 'model', m.model, 'lokacija', m.location)
        from maint_machines m where m.machine_code = v_mc),
      'napomena', 'Prikazan je samo osnovni karton — detalje (kvarovi/dokumenti) vidi održavanje. Kvar možeš prijaviti.');
  end if;
  select jsonb_build_object(
    'masina', (select jsonb_build_object(
        'sifra', m.machine_code, 'naziv', m.name, 'tip', m.type,
        'proizvodjac', m.manufacturer, 'model', m.model, 'lokacija', m.location,
        'godina', m.year_of_manufacture, 'napomena', nullif(m.notes,''))
      from maint_machines m where m.machine_code = v_mc),
    'otvoreni_kvarovi', coalesce((
      select jsonb_agg(jsonb_build_object(
        'naslov', i.title, 'ozbiljnost', i.severity, 'status', i.status,
        'prijavljen', to_char(i.reported_at, 'DD.MM.YYYY.')))
      from (select * from maint_incidents where machine_code = v_mc
            and status not in ('resolved','closed') order by reported_at desc limit 10) i), '[]'::jsonb),
    'poslednje_kontrole', coalesce((
      select jsonb_agg(jsonb_build_object(
        'rezultat', c.result, 'napomena', nullif(c.notes,''), 'kada', to_char(c.performed_at, 'DD.MM.YYYY.')))
      from (select * from maint_checks where machine_code = v_mc order by performed_at desc limit 5) c), '[]'::jsonb),
    'dokumenti', coalesce((
      select jsonb_agg(jsonb_build_object('naziv', d.file_name, 'kategorija', d.category, 'document_id', d.document_id))
      from (select * from maint_documents where asset_id = v_aid and deleted_at is null order by uploaded_at desc limit 20) d), '[]'::jsonb),
    'dokumenti_masine', coalesce((
      select jsonb_agg(jsonb_build_object('naziv', f.file_name, 'kategorija', f.category))
      from (select * from maint_machine_files where machine_code = v_mc and deleted_at is null order by uploaded_at desc limit 20) f), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_masina_uputstvo ============
CREATE OR REPLACE FUNCTION public.ai_chat_masina_uputstvo(p_masina text, p_pitanje text, p_embedding text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_mc text; v_upit text := trim(coalesce(p_pitanje,''));
  v_emb vector(1536); v_out jsonb;
begin
  select machine_code into v_mc from public.ai_chat_maint_resolve(p_masina);
  if v_mc is null then
    return jsonb_build_object('error', 'nema_masine', 'poruka', 'Mašina nije nađena u katalogu.');
  end if;
  if not public.maint_machine_visible(v_mc) then
    return jsonb_build_object('error', 'nema_prava', 'poruka', 'Nemaš pravo uvida u dokumentaciju ove mašine.');
  end if;
  begin
    if p_embedding is not null and p_embedding <> '' then v_emb := p_embedding::vector(1536); end if;
  exception when others then v_emb := null;
  end;
  select jsonb_build_object(
    'masina', v_mc,
    'odlomci', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dokument', d.doc_name, 'kategorija', d.category,
        'strana', d.page_from, 'tekst', left(d.content, 1500),
        'slicnost', round((coalesce(d.sim, 0))::numeric, 3)))
      from (
        select doc_name, category, page_from, content, chunk_index,
               case when v_emb is null or embedding is null then null
                    else 1 - (embedding <=> v_emb) end as sim
        from ai_masina_docs
        where machine_code = v_mc and (
          (v_emb is not null and embedding is not null and (embedding <=> v_emb) < 0.6)
          or to_tsvector('simple', coalesce(doc_name,'') || ' ' || content) @@ plainto_tsquery('simple', v_upit)
          or public.ai_chat_norm_name(content) like '%' || public.ai_chat_norm_name(v_upit) || '%')
        order by sim desc nulls last, chunk_index
        limit 6
      ) d), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_moj_tim ============
CREATE OR REPLACE FUNCTION public.ai_chat_moj_tim()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_self uuid := public.current_user_employee_id();
  v_out jsonb;
begin
  select jsonb_build_object(
    'broj_zaposlenih', count(*),
    'zaposleni', coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', t.id,
      'ime', t.full_name,
      'pozicija', t.position,
      'go_preostalo', t.days_remaining,
      'danas_odsutan', t.absence_code
    ) order by t.full_name), '[]'::jsonb)
  ) into v_out
  from (
    select e.id, e.full_name, e.position, b.days_remaining, wh.absence_code
    from employees e
    left join v_vacation_balance b
      on b.employee_id = e.id and b.year = extract(year from current_date)::int
    left join work_hours wh
      on wh.employee_id = e.id and wh.work_date = current_date and wh.absence_code is not null
    where e.is_active is true
      and (e.id = v_self or public.current_user_manages_employee(e.id))
    limit 200
  ) t;
  return v_out;
end;
$function$

-- ============ ai_chat_norm_name ============
CREATE OR REPLACE FUNCTION public.ai_chat_norm_name(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select translate(lower(coalesce(p, '')), 'ćčšžđ', 'ccszd');
$function$

-- ============ ai_chat_odsustva ============
CREATE OR REPLACE FUNCTION public.ai_chat_odsustva(p_employee_id uuid DEFAULT NULL::uuid, p_godina integer DEFAULT NULL::integer, p_tip text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_emp uuid := coalesce(p_employee_id, public.current_user_employee_id());
  v_god int := coalesce(p_godina, extract(year from current_date)::int);
  v_from date := make_date(coalesce(p_godina, extract(year from current_date)::int), 1, 1);
  v_to date := make_date(coalesce(p_godina, extract(year from current_date)::int) + 1, 1, 1);
  v_out jsonb;
begin
  if v_emp is null then
    return jsonb_build_object('error', 'nema_zaposlenog',
      'poruka', 'Nalog pozivaoca nije povezan sa kartonom zaposlenog.');
  end if;
  if not public.ai_chat_can_view_employee(v_emp) then
    return jsonb_build_object('error', 'nema_prava',
      'poruka', 'Pozivalac nema pravo uvida u ovog zaposlenog.');
  end if;

  with dani as (
    select w.work_date, w.absence_code,
           w.work_date - (row_number() over (partition by w.absence_code order by w.work_date))::int as grp
    from work_hours w
    where w.employee_id = v_emp
      and w.work_date >= v_from and w.work_date < v_to
      and w.absence_code is not null
      and (p_tip is null or w.absence_code = lower(trim(p_tip)))
  ),
  periodi as (
    select absence_code, min(work_date) as od, max(work_date) as do_, count(*) as dana,
           count(*) filter (where work_date <= current_date) as dana_iskorisceno,
           count(*) filter (where work_date > current_date) as dana_planirano
    from dani
    group by absence_code, grp
  )
  select jsonb_build_object(
    'zaposleni', (select full_name from employees where id = v_emp),
    'godina', v_god,
    'danasnji_datum', to_char(current_date, 'DD.MM.YYYY.'),
    'ukupno_iskorisceno_po_tipu', coalesce((
      select jsonb_object_agg(t.absence_code, t.total)
      from (select absence_code, sum(dana_iskorisceno) as total from periodi
            group by absence_code having sum(dana_iskorisceno) > 0) t), '{}'::jsonb),
    'ukupno_planirano_po_tipu', coalesce((
      select jsonb_object_agg(t.absence_code, t.total)
      from (select absence_code, sum(dana_planirano) as total from periodi
            group by absence_code having sum(dana_planirano) > 0) t), '{}'::jsonb),
    'periodi', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tip', p.absence_code,
        'od', to_char(p.od, 'DD.MM.YYYY.'),
        'do', to_char(p.do_, 'DD.MM.YYYY.'),
        'dana', p.dana,
        'vremenski_status', case
          when p.do_ < current_date then 'iskorisceno'
          when p.od > current_date then 'planirano'
          else 'u_toku'
        end
      ) order by p.od desc)
      from (select * from periodi order by od desc limit 60) p), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_opis_pozicije ============
CREATE OR REPLACE FUNCTION public.ai_chat_opis_pozicije(p_naziv text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_naziv text := trim(coalesce(p_naziv, ''));
  v_out jsonb;
begin
  if v_naziv = '' then
    select jsonb_build_object('pozicije', coalesce(jsonb_agg(
      jsonb_build_object('naziv', j.name, 'nadredjeni', j.reports_to_line)
      order by j.name), '[]'::jsonb))
    into v_out from job_positions j;
    return v_out;
  end if;
  select jsonb_build_object('pogodci', coalesce((
    select jsonb_agg(jsonb_build_object(
      'naziv', j.name,
      'nadredjeni', j.reports_to_line,
      'svrha', left(coalesce(j.summary_md, ''), 1200),
      'odgovornosti', left(coalesce(j.responsibilities_md, ''), 2000),
      'ovlascenja', left(coalesce(j.authority_md, ''), 800),
      'kpi', left(coalesce(j.kpi_md, ''), 800),
      'kvalifikacije', left(coalesce(j.qualifications_md, ''), 800),
      'saradnja', left(coalesce(j.collaboration_md, ''), 600)))
    from (
      select * from job_positions j
      where public.ai_chat_norm_name(j.name) like '%' || public.ai_chat_norm_name(v_naziv) || '%'
      order by j.name limit 3
    ) j), '[]'::jsonb)) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_pretrazi_uputstva ============
CREATE OR REPLACE FUNCTION public.ai_chat_pretrazi_uputstva(p_upit text, p_embedding text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_upit text := trim(coalesce(p_upit, ''));
  v_emb vector(1536);
  v_qnorm text;
  v_out jsonb;
begin
  if v_upit = '' then
    return jsonb_build_object('error', 'prazan_upit', 'poruka', 'Zadaj pojam pretrage.');
  end if;
  begin
    if p_embedding is not null and p_embedding <> '' then v_emb := p_embedding::vector(1536); end if;
  exception when others then v_emb := null;
  end;
  v_qnorm := public.ai_chat_norm_name(v_upit);

  select jsonb_build_object('uputstva', coalesce((
    select jsonb_agg(jsonb_build_object(
      'naslov', u.naslov, 'modul', u.modul,
      'sadrzaj', left(u.sadrzaj, 2500),
      'slicnost', u.score))
    from (
      select u.*,
             round((coalesce(sim.s, 0))::numeric, 3) as score,
             wm.hits as wm_hits
      from ai_uputstva u
      cross join lateral (
        select public.ai_chat_norm_name(coalesce(u.naslov,'') || ' ' || coalesce(u.kljucne_reci,'') || ' ' || u.sadrzaj) as norm
      ) hay
      left join lateral (
        select case when v_emb is null or u.embedding is null then null
                    else 1 - (u.embedding <=> v_emb) end as s
      ) sim on true
      cross join lateral (
        select count(*) filter (where w_ok) as total,
               count(*) filter (where w_ok and hay.norm like '%' || left(w, 5) || '%') as hits
        from (
          select w,
                 char_length(w) >= 4
                 and not (w = any(array['kako','vidim','mogu','gdje','sta','kada','koji','koja','koje','ovde','moze','mozes','molim','hocu','zelim','gde','kako'])) as w_ok
          from unnest(regexp_split_to_array(v_qnorm, '\s+')) as w
        ) q
      ) wm
      where u.aktivno is true
        and (u.vidljivost = 'svi' or public.current_user_is_hr_or_admin())
        and (
          to_tsvector('simple', coalesce(u.naslov,'') || ' ' || coalesce(u.kljucne_reci,'') || ' ' || u.sadrzaj)
            @@ plainto_tsquery('simple', v_upit)
          or hay.norm like '%' || v_qnorm || '%'
          or (v_emb is not null and u.embedding is not null and (u.embedding <=> v_emb) < 0.55)
          or (wm.total >= 1 and wm.hits >= greatest(1, ceil(wm.total * 0.6)))
        )
      order by coalesce(sim.s, 0) desc, wm.hits desc, u.updated_at desc
      limit 6
    ) u), '[]'::jsonb)) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_pretrazi_znanje ============
CREATE OR REPLACE FUNCTION public.ai_chat_pretrazi_znanje(p_ref text DEFAULT NULL::text, p_upit text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_upit text := trim(coalesce(p_upit, ''));
  v_out jsonb;
begin
  if v_upit = '' then
    return jsonb_build_object('error', 'prazan_upit', 'poruka', 'Zadaj pojam pretrage.');
  end if;
  select jsonb_build_object(
    'beleske', coalesce((
      select jsonb_agg(jsonb_build_object(
        'projekat', n.project_ref, 'naslov', n.title, 'tekst', left(n.content, 600),
        'autor', n.author_name, 'datum', to_char(n.created_at, 'DD.MM.YYYY.')))
      from (
        select * from ai_project_notes n
        where (p_ref is null or n.project_ref = trim(p_ref))
          and (to_tsvector('simple', coalesce(n.title, '') || ' ' || n.content)
                 @@ plainto_tsquery('simple', v_upit)
               or public.ai_chat_norm_name(coalesce(n.title, '') || ' ' || n.content)
                 like '%' || public.ai_chat_norm_name(v_upit) || '%')
        order by n.created_at desc limit 8
      ) n), '[]'::jsonb),
    'izvestaji', coalesce((
      select jsonb_agg(jsonb_build_object(
        'projekat', i.predmet_broj, 'broj', i.broj_izvestaja,
        'datum', to_char(i.datum_rada, 'DD.MM.YYYY.'), 'autor', i.autor_ime,
        'opis', left(coalesce(i.opis_radova, ''), 500)))
      from (
        select * from montaza_izvestaji i
        where (p_ref is null or i.predmet_broj = trim(p_ref))
          and public.ai_chat_norm_name(
                coalesce(i.opis_radova, '') || ' ' || coalesce(i.problemi, '') || ' '
                || coalesce(i.otvorene_stavke, ''))
              like '%' || public.ai_chat_norm_name(v_upit) || '%'
        order by i.datum_rada desc nulls last limit 5
      ) i), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_prijavi_kvar ============
CREATE OR REPLACE FUNCTION public.ai_chat_prijavi_kvar(p_masina text, p_naslov text, p_opis text DEFAULT NULL::text, p_ozbiljnost text DEFAULT 'minor'::text, p_bezbednosni_rizik boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_mc text; v_aid uuid;
  v_sev maint_incident_severity;
  v_id uuid; v_wo uuid; v_wonum text;
begin
  if coalesce(trim(p_naslov),'') = '' then
    return jsonb_build_object('error', 'prazno', 'poruka', 'Naslov (kratak opis kvara) je obavezan.');
  end if;
  -- razrešenje mašine ide preko DEFINER helpera (katalog je svima čitljiv za lookup)
  select machine_code, asset_id into v_mc, v_aid from public.ai_chat_maint_resolve(p_masina);
  if v_mc is null then
    return jsonb_build_object('error', 'nema_masine', 'poruka', 'Mašina „' || coalesce(p_masina,'') || '" nije nađena — proveri šifru/naziv.');
  end if;
  begin
    v_sev := lower(trim(coalesce(p_ozbiljnost,'minor')))::maint_incident_severity;
  exception when others then v_sev := 'minor';
  end;
  v_id := gen_random_uuid();
  begin
    -- id se generiše unapred (bez RETURNING) — RETURNING bi tražio SELECT-vidljivost
    -- reda, koju običan prijavilac nema (njegov kvar vidi održavanje).
    insert into maint_incidents (id, machine_code, asset_id, asset_type, reported_by, title, description, severity, status, safety_marker)
    values (v_id, v_mc, v_aid, case when v_aid is null then null else 'machine'::maint_asset_type end, auth.uid(),
            trim(p_naslov), nullif(trim(coalesce(p_opis,'')),''), v_sev, 'open', coalesce(p_bezbednosni_rizik,false));
  exception
    when insufficient_privilege then
      return jsonb_build_object('error', 'nema_prava',
        'poruka', 'Nemaš pravo da prijaviš kvar kroz aplikaciju — obrati se održavanju ili administratoru.');
    when others then
      return jsonb_build_object('error', 'greska', 'poruka', 'Prijava nije sačuvana: ' || SQLERRM);
  end;
  -- WO kreira AFTER-trigger (major/critical/safety) → čitaj posle inserta, ne iz RETURNING
  select i.work_order_id into v_wo from maint_incidents i where i.id = v_id;
  if v_wo is not null then
    select wo_number into v_wonum from maint_work_orders where wo_id = v_wo;
  end if;
  return jsonb_build_object('ok', true, 'incident_id', v_id, 'masina', v_mc,
    'radni_nalog', v_wonum,
    'poruka', 'Kvar je prijavljen za mašinu ' || v_mc || '.'
      || case when v_wonum is not null then ' Automatski je otvoren radni nalog ' || v_wonum || '.'
              when v_sev in ('major','critical') or coalesce(p_bezbednosni_rizik,false)
                then ' Održavanje je obavešteno o hitnom kvaru.'
              else '' end);
end;
$function$

-- ============ ai_chat_projekat_info ============
CREATE OR REPLACE FUNCTION public.ai_chat_projekat_info(p_ref text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_ref text := trim(coalesce(p_ref, ''));
  v_proj record;
  v_out jsonb;
begin
  if v_ref = '' then
    return jsonb_build_object('error', 'prazan_ref', 'poruka', 'Zadaj broj projekta (npr. 9400/7).');
  end if;
  select id, project_code, project_name, status, project_deadline, pm_email
    into v_proj from projects where project_code = v_ref limit 1;

  select jsonb_build_object(
    'projekat', case when v_proj.id is null
      then jsonb_build_object('napomena', 'Projekat ' || v_ref || ' nije u planu montaže — prikazujem samo izveštaje montera.')
      else jsonb_build_object(
        'broj', v_proj.project_code, 'naziv', v_proj.project_name,
        'status', v_proj.status,
        'rok', case when v_proj.project_deadline is null then null else to_char(v_proj.project_deadline, 'DD.MM.YYYY.') end,
        'pm', nullif(v_proj.pm_email, '')) end,
    'plan', case when v_proj.id is null then null else (
      select jsonb_build_object(
        'pozicija_ukupno', count(distinct wp.id),
        'faza_ukupno', count(ph.id),
        'prosecan_napredak_pct', round(coalesce(avg(ph.pct), 0)),
        'faze_u_blokadi', count(ph.id) filter (where coalesce(ph.blocker, '') <> ''))
      from work_packages wp
      left join phases ph on ph.work_package_id = wp.id
      where wp.project_id = v_proj.id) end,
    'izvestaji_montera', coalesce((
      select jsonb_agg(jsonb_build_object(
        'broj', i.broj_izvestaja, 'datum', to_char(i.datum_rada, 'DD.MM.YYYY.'),
        'autor', i.autor_ime, 'status', i.status,
        'opis', left(coalesce(i.opis_radova, ''), 400),
        'problemi', nullif(left(coalesce(i.problemi, ''), 250), ''),
        'otvorene_stavke', nullif(left(coalesce(i.otvorene_stavke, ''), 250), '')))
      from (
        select * from montaza_izvestaji
        where predmet_broj = v_ref
        order by datum_rada desc nulls last, created_at desc limit 5
      ) i), '[]'::jsonb),
    'otvorene_akcije', case when v_proj.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'naslov', a.naslov, 'odgovoran', coalesce(a.odgovoran_label, a.odgovoran_text, a.odgovoran_email),
        'rok', coalesce(to_char(a.rok, 'DD.MM.YYYY.'), a.rok_text),
        'status', a.effective_status))
      from (
        select * from v_akcioni_plan
        where projekat_id = v_proj.id and effective_status in ('otvoren', 'u_toku', 'kasni')
        order by rok asc nulls last limit 10
      ) a), '[]'::jsonb) end,
    'sastanci_stavke', case when v_proj.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'naslov', pa.naslov, 'status', pa.status,
        'odgovoran', coalesce(pa.odgovoran_label, pa.odgovoran_text),
        'rok', coalesce(to_char(pa.rok, 'DD.MM.YYYY.'), pa.rok_text),
        'sadrzaj', left(coalesce(pa.sadrzaj_text, ''), 300)))
      from (
        select pa.* from presek_aktivnosti pa
        join sastanci s on s.id = pa.sastanak_id
        where s.projekat_id = v_proj.id
          and pa.status in ('planiran', 'u_toku', 'blokirano')
        order by pa.updated_at desc limit 10
      ) pa), '[]'::jsonb) end,
    'beleske', coalesce((
      select jsonb_agg(jsonb_build_object(
        'naslov', n.title, 'tekst', left(n.content, 400),
        'autor', n.author_name, 'datum', to_char(n.created_at, 'DD.MM.YYYY.')))
      from (
        select * from ai_project_notes where project_ref = v_ref
        order by created_at desc limit 5
      ) n), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$function$

-- ============ ai_chat_sati ============
CREATE OR REPLACE FUNCTION public.ai_chat_sati(p_employee_id uuid DEFAULT NULL::uuid, p_godina integer DEFAULT NULL::integer, p_mesec integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_emp uuid := coalesce(p_employee_id, public.current_user_employee_id());
  v_from date := make_date(
    coalesce(p_godina, extract(year from current_date)::int),
    coalesce(p_mesec, extract(month from current_date)::int), 1);
  v_to date := (v_from + interval '1 month')::date;
  v_out jsonb;
begin
  if v_emp is null then
    return jsonb_build_object('error', 'nema_zaposlenog',
      'poruka', 'Nalog pozivaoca nije povezan sa kartonom zaposlenog.');
  end if;
  if not public.ai_chat_can_view_employee(v_emp) then
    return jsonb_build_object('error', 'nema_prava',
      'poruka', 'Pozivalac nema pravo uvida u ovog zaposlenog.');
  end if;
  select jsonb_build_object(
    'zaposleni', (select full_name from employees where id = v_emp),
    'mesec', to_char(v_from, 'MM.YYYY'),
    'dana_sa_satima', count(*) filter (where coalesce(w.hours, 0) > 0),
    'sati_redovno', coalesce(sum(w.hours), 0),
    'sati_prekovremeno', coalesce(sum(w.overtime_hours), 0),
    'sati_teren', coalesce(sum(w.field_hours), 0),
    'sati_dve_masine', coalesce(sum(w.two_machine_hours), 0),
    'dani_odsustva_po_tipu', coalesce((
      select jsonb_object_agg(a.absence_code, a.cnt)
      from (select absence_code, count(*) as cnt
            from work_hours
            where employee_id = v_emp and work_date >= v_from and work_date < v_to
              and absence_code is not null
            group by absence_code) a), '{}'::jsonb)
  ) into v_out
  from work_hours w
  where w.employee_id = v_emp and w.work_date >= v_from and w.work_date < v_to;
  return v_out;
end;
$function$

-- ============ ai_chat_sql ============
CREATE OR REPLACE FUNCTION public.ai_chat_sql(p_sql text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_sql text := regexp_replace(coalesce(p_sql, ''), ';\s*$', '');
  v_out jsonb;
begin
  if not public.current_user_is_hr_or_admin() then
    return jsonb_build_object('error', 'nema_prava',
      'poruka', 'Slobodni SQL upiti su dozvoljeni samo administratorima i HR-u.');
  end if;
  if v_sql !~* '^\s*(select|with)\M' then
    return jsonb_build_object('error', 'samo_select', 'poruka', 'Dozvoljen je samo SELECT (ili WITH … SELECT).');
  end if;
  if position(';' in v_sql) > 0 then
    return jsonb_build_object('error', 'jedan_iskaz', 'poruka', 'Samo jedan SQL iskaz, bez tačke-zapete.');
  end if;
  if v_sql ~ '--' or position('/*' in v_sql) > 0 then
    return jsonb_build_object('error', 'bez_komentara', 'poruka', 'Komentari u upitu nisu dozvoljeni.');
  end if;
  if v_sql ~* '\m(insert|update|delete|merge|drop|alter|create|grant|revoke|truncate|copy|call|do|set|reset|vacuum|analyze|listen|notify|refresh|comment|security|begin|commit|rollback|savepoint|lock|cluster|reindex|pg_sleep|dblink|pg_read_file|pg_ls_dir|pg_stat_file|lo_import|lo_export)\M' then
    return jsonb_build_object('error', 'zabranjeno',
      'poruka', 'Upit sadrži nedozvoljenu ključnu reč — dozvoljen je samo čist SELECT.');
  end if;
  perform set_config('statement_timeout', '4000', true);
  execute 'select coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb) '
       || 'from (select * from (' || v_sql || ') ai_raw limit 200) t'
    into v_out;
  return jsonb_build_object('redova', jsonb_array_length(v_out), 'rezultat', v_out);
exception when others then
  return jsonb_build_object('error', 'sql_greska', 'sqlstate', SQLSTATE, 'poruka', SQLERRM);
end;
$function$

-- ============ akcioni_plan_trg_istorija ============
CREATE OR REPLACE FUNCTION public.akcioni_plan_trg_istorija()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email TEXT;
  v_old_odg TEXT;
  v_new_odg TEXT;
BEGIN
  BEGIN
    v_email := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
  EXCEPTION WHEN others THEN
    v_email := NULL;
  END;

  IF COALESCE(OLD.status,'') <> COALESCE(NEW.status,'') THEN
    INSERT INTO public.akcioni_plan_istorija (akcija_id, polje, staro, novo, izmenio_email)
    VALUES (NEW.id, 'status', OLD.status, NEW.status, v_email);
  END IF;

  IF COALESCE(OLD.rok::TEXT,'') <> COALESCE(NEW.rok::TEXT,'') THEN
    INSERT INTO public.akcioni_plan_istorija (akcija_id, polje, staro, novo, izmenio_email)
    VALUES (NEW.id, 'rok', OLD.rok::TEXT, NEW.rok::TEXT, v_email);
  END IF;

  IF COALESCE(OLD.rok_text,'') <> COALESCE(NEW.rok_text,'') THEN
    INSERT INTO public.akcioni_plan_istorija (akcija_id, polje, staro, novo, izmenio_email)
    VALUES (NEW.id, 'rok_text', OLD.rok_text, NEW.rok_text, v_email);
  END IF;

  v_old_odg := COALESCE(OLD.odgovoran_label, OLD.odgovoran_text, OLD.odgovoran_email, '');
  v_new_odg := COALESCE(NEW.odgovoran_label, NEW.odgovoran_text, NEW.odgovoran_email, '');
  IF v_old_odg <> v_new_odg THEN
    INSERT INTO public.akcioni_plan_istorija (akcija_id, polje, staro, novo, izmenio_email)
    VALUES (NEW.id, 'odgovoran', v_old_odg, v_new_odg, v_email);
  END IF;

  IF COALESCE(OLD.naslov,'') <> COALESCE(NEW.naslov,'') THEN
    INSERT INTO public.akcioni_plan_istorija (akcija_id, polje, staro, novo, izmenio_email)
    VALUES (NEW.id, 'naslov', OLD.naslov, NEW.naslov, v_email);
  END IF;

  IF COALESCE(OLD.projekat_id::TEXT,'') <> COALESCE(NEW.projekat_id::TEXT,'') THEN
    INSERT INTO public.akcioni_plan_istorija (akcija_id, polje, staro, novo, izmenio_email)
    VALUES (NEW.id, 'projekat', OLD.projekat_id::TEXT, NEW.projekat_id::TEXT, v_email);
  END IF;

  RETURN NEW;
END;
$function$

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

-- ============ get_sastanci_user_directory ============
CREATE OR REPLACE FUNCTION public.get_sastanci_user_directory()
 RETURNS TABLE(email text, full_name text, role text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.has_edit_role() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    LOWER(ur.email) AS email,
    COALESCE(NULLIF(TRIM(ur.full_name), ''), LOWER(ur.email)) AS full_name,
    ur.role
  FROM public.user_roles ur
  WHERE ur.is_active = TRUE
    AND ur.email IS NOT NULL
    AND TRIM(ur.email) <> ''
  ORDER BY 2, 1;
END;
$function$

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

-- ============ is_sastanak_ucesnik ============
CREATE OR REPLACE FUNCTION public.is_sastanak_ucesnik(p_sastanak_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM   public.sastanak_ucesnici
    WHERE  sastanak_id = p_sastanak_id
      AND  LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
  );
$function$

-- ============ sast_adjust_for_holiday ============
CREATE OR REPLACE FUNCTION public.sast_adjust_for_holiday(m date)
 RETURNS date
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d date := m; i int := 0;
BEGIN
  WHILE i < 5 LOOP  -- Pon..Pet iste nedelje
    IF NOT EXISTS (
      SELECT 1 FROM public.kadr_holidays h
      WHERE h.holiday_date = d AND COALESCE(h.is_workday, false) = false
    ) THEN
      RETURN d;
    END IF;
    d := d + 1; i := i + 1;
  END LOOP;
  RETURN m;  -- (nerealno) cela radna nedelja praznik → vrati ponedeljak
END;
$function$

-- ============ sast_auto_create_weekly ============
CREATE OR REPLACE FUNCTION public.sast_auto_create_weekly(p_force boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now_local timestamptz := now();
  v_today     date := (v_now_local AT TIME ZONE 'Europe/Belgrade')::date;
  v_monday    date := public.sast_next_week_monday(v_today);
  v_target    date;
BEGIN
  -- Vremenski guard (DST-otporno): kreiraj samo kad je LOKALNO 08h petkom.
  IF NOT p_force THEN
    IF EXTRACT(isodow FROM (v_now_local AT TIME ZONE 'Europe/Belgrade')) <> 5
       OR EXTRACT(hour FROM (v_now_local AT TIME ZONE 'Europe/Belgrade'))::int <> 8 THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Odložena nedelja?
  IF EXISTS (SELECT 1 FROM public.sast_weekly_skip WHERE week_monday = v_monday) THEN
    RETURN NULL;
  END IF;

  -- Već postoji sedmični u toj nedelji (ručno/prethodno)? → ne dupliraj
  IF EXISTS (
    SELECT 1 FROM public.sastanci
    WHERE tip = 'sedmicni'
      AND datum BETWEEN v_monday AND v_monday + 6
      AND status <> 'otkazan'
  ) THEN
    RETURN NULL;
  END IF;

  v_target := public.sast_adjust_for_holiday(v_monday);
  RETURN public.sast_create_weekly_at(v_target, '09:00');
END;
$function$

-- ============ sast_check_not_locked ============
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
$function$

-- ============ sast_create_weekly_at ============
CREATE OR REPLACE FUNCTION public.sast_create_weekly_at(p_target date, p_vreme time without time zone DEFAULT '09:00:00'::time without time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_src   RECORD;
  v_new   uuid;
  v_dtxt  text := to_char(p_target, 'DD.MM.YYYY');
BEGIN
  -- Izvor = poslednji sedmični STROGO pre ciljanog datuma (za mesto/vodio/prenos)
  SELECT id, mesto, vodio_email, vodio_label
    INTO v_src
  FROM public.sastanci
  WHERE tip = 'sedmicni' AND datum < p_target
  ORDER BY datum DESC, created_at DESC
  LIMIT 1;

  INSERT INTO public.sastanci
    (tip, naslov, datum, vreme, mesto, status, vodio_email, vodio_label, created_by_email)
  VALUES
    ('sedmicni', 'Sedmični sastanak — ' || v_dtxt || '.', p_target, p_vreme,
     COALESCE(v_src.mesto, 'Sala za sastanke'), 'planiran',
     v_src.vodio_email, v_src.vodio_label, 'auto@sistem')
  RETURNING id INTO v_new;

  IF v_src.id IS NOT NULL THEN
    -- Kopiraj učesnike → trigger auto-enqueue meeting_invite (.ics + zapisnik u edge-u)
    INSERT INTO public.sastanak_ucesnici (sastanak_id, email, label, pozvan, prisutan)
    SELECT v_new, u.email, u.label, true, false
    FROM public.sastanak_ucesnici u
    WHERE u.sastanak_id = v_src.id;

    -- Prenesi otvorene/u_toku akcije (guard gleda ciljni = planiran → prolazi)
    UPDATE public.akcioni_plan
       SET sastanak_id = v_new, updated_at = now()
     WHERE sastanak_id = v_src.id AND status IN ('otvoren','u_toku');
  END IF;

  -- Stemplji da su pozivnice poslate (UI prikaz "pozvano"; ne šalje slepo opet)
  UPDATE public.sastanci SET pozivnice_poslate_at = now() WHERE id = v_new;

  RETURN v_new;
END;
$function$

-- ============ sast_dashboard_stats ============
CREATE OR REPLACE FUNCTION public.sast_dashboard_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := current_date;
  v_in14  date := current_date + 14;
BEGIN
  RETURN jsonb_build_object(
    'sastanc_upcoming', (
      SELECT count(*)::int
      FROM public.sastanci s
      WHERE s.status = 'planiran'
        AND s.datum >= v_today
        AND s.datum <= v_in14
    ),
    'sastanc_u_toku', (
      SELECT count(*)::int
      FROM public.sastanci s
      WHERE s.status = 'u_toku'
    ),
    'akcije_otvoreno', (
      SELECT count(*)::int
      FROM public.v_akcioni_plan v
      WHERE v.effective_status IN ('otvoren', 'u_toku', 'kasni')
    ),
    'akcije_kasni', (
      SELECT count(*)::int
      FROM public.v_akcioni_plan v
      WHERE v.effective_status = 'kasni'
    ),
    'pm_teme_na_cekanju', (
      SELECT count(*)::int
      FROM public.pm_teme t
      WHERE t.status = 'predlog'
    )
  );
END;
$function$

-- ============ sast_enqueue_cancel ============
CREATE OR REPLACE FUNCTION public.sast_enqueue_cancel(p_sastanak_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_s RECORD; v_rec RECORD; v_cnt int := 0;
BEGIN
  SELECT * INTO v_s FROM public.sastanci WHERE id = p_sastanak_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  FOR v_rec IN
    SELECT email, label FROM public.sastanak_ucesnici
    WHERE sastanak_id = p_sastanak_id AND pozvan = true
  LOOP
    PERFORM public.sastanci_enqueue_notification(
      'meeting_cancel', 'email', v_rec.email, v_rec.label,
      format('Otkazano: %s', v_s.naslov), NULL, NULL, p_sastanak_id, NULL,
      jsonb_build_object(
        'sastanak_id', p_sastanak_id, 'naslov', v_s.naslov, 'datum', v_s.datum::text,
        'vreme', CASE WHEN v_s.vreme IS NOT NULL THEN left(v_s.vreme::text,5) ELSE NULL END,
        'mesto', v_s.mesto, 'tip', v_s.tip
      ), NULL
    );
    v_cnt := v_cnt + 1;
  END LOOP;
  RETURN v_cnt;
END;
$function$

-- ============ sast_next_week_monday ============
CREATE OR REPLACE FUNCTION public.sast_next_week_monday(d date)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT d + ((8 - EXTRACT(isodow FROM d)::int) % 7);
$function$

-- ============ sast_pm_teme_draft_status_guard ============
CREATE OR REPLACE FUNCTION public.sast_pm_teme_draft_status_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'draft'
     AND NEW.status <> OLD.status
     AND NEW.status NOT IN ('usvojeno', 'odbijeno') THEN
    RAISE EXCEPTION 'Draft tema može biti samo usvojena ili odbijena.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$

-- ============ sast_target_week_monday ============
CREATE OR REPLACE FUNCTION public.sast_target_week_monday()
 RETURNS date
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE m date := public.sast_next_week_monday((now() AT TIME ZONE 'Europe/Belgrade')::date);
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.sastanci
    WHERE tip = 'sedmicni' AND datum BETWEEN m AND m + 6
      AND status IN ('zakljucan','zavrsen')
  ) THEN
    m := m + 7;
  END IF;
  RETURN m;
END;
$function$

-- ============ sast_trg_akcija_changed ============
CREATE OR REPLACE FUNCTION public.sast_trg_akcija_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_odg_promenjen BOOLEAN;
  v_nesto_promenio BOOLEAN;
  v_kind TEXT;
  v_recipient TEXT;
BEGIN
  v_odg_promenjen := COALESCE(OLD.odgovoran_email, '') <> COALESCE(NEW.odgovoran_email, '');

  v_nesto_promenio :=
    v_odg_promenjen
    OR COALESCE(OLD.status, '') <> COALESCE(NEW.status, '')
    OR COALESCE(OLD.rok::TEXT, '') <> COALESCE(NEW.rok::TEXT, '')
    OR COALESCE(OLD.naslov, '') <> COALESCE(NEW.naslov, '');

  IF NOT v_nesto_promenio THEN
    RETURN NEW;
  END IF;

  IF NEW.odgovoran_email IS NULL OR trim(NEW.odgovoran_email) = '' THEN
    RETURN NEW;
  END IF;

  v_kind := CASE WHEN v_odg_promenjen THEN 'akcija_new' ELSE 'akcija_changed' END;
  v_recipient := lower(NEW.odgovoran_email);

  IF EXISTS (
    SELECT 1
    FROM public.sastanci_notification_log
    WHERE kind = v_kind
      AND recipient_email = v_recipient
      AND related_akcija_id = NEW.id
      AND status IN ('queued', 'sent')
  ) THEN
    RETURN NEW;
  END IF;

  IF v_odg_promenjen THEN
    PERFORM public.sastanci_enqueue_notification(
      'akcija_new',
      'email',
      NEW.odgovoran_email,
      COALESCE(NEW.odgovoran_label, NEW.odgovoran_text, NEW.odgovoran_email),
      format('Nova akcija (premeštena): %s', NEW.naslov),
      NULL,
      NULL,
      NEW.sastanak_id,
      NEW.id,
      jsonb_build_object(
        'akcija_id',     NEW.id,
        'naslov',        NEW.naslov,
        'rok',           NEW.rok,
        'rok_text',      NEW.rok_text,
        'prioritet',     NEW.prioritet,
        'status',        NEW.status,
        'sastanak_id',   NEW.sastanak_id,
        'odg_label',     COALESCE(NEW.odgovoran_label, NEW.odgovoran_text, NEW.odgovoran_email),
        'izmena',        'odgovoran_promenjen'
      ),
      NULL
    );
    RETURN NEW;
  END IF;

  PERFORM public.sastanci_enqueue_notification(
    'akcija_changed',
    'email',
    NEW.odgovoran_email,
    COALESCE(NEW.odgovoran_label, NEW.odgovoran_text, NEW.odgovoran_email),
    format('Akcija ažurirana: %s', NEW.naslov),
    NULL,
    NULL,
    NEW.sastanak_id,
    NEW.id,
    jsonb_build_object(
      'akcija_id',     NEW.id,
      'naslov',        NEW.naslov,
      'rok',           NEW.rok,
      'rok_text',      NEW.rok_text,
      'prioritet',     NEW.prioritet,
      'status_old',    OLD.status,
      'status_new',    NEW.status,
      'rok_old',       OLD.rok,
      'sastanak_id',   NEW.sastanak_id,
      'odg_label',     COALESCE(NEW.odgovoran_label, NEW.odgovoran_text, NEW.odgovoran_email)
    ),
    NULL
  );

  RETURN NEW;
END;
$function$

-- ============ sast_trg_akcija_new ============
CREATE OR REPLACE FUNCTION public.sast_trg_akcija_new()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_recipient TEXT;
BEGIN
  IF NEW.odgovoran_email IS NULL OR trim(NEW.odgovoran_email) = '' THEN
    RETURN NEW;
  END IF;

  v_recipient := lower(NEW.odgovoran_email);

  IF EXISTS (
    SELECT 1
    FROM public.sastanci_notification_log
    WHERE kind = 'akcija_new'
      AND recipient_email = v_recipient
      AND related_akcija_id = NEW.id
      AND status IN ('queued', 'sent')
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM public.sastanci_enqueue_notification(
    'akcija_new',
    'email',
    NEW.odgovoran_email,
    COALESCE(NEW.odgovoran_label, NEW.odgovoran_text, NEW.odgovoran_email),
    format('Nova akcija: %s', NEW.naslov),
    NULL,
    NULL,
    NEW.sastanak_id,
    NEW.id,
    jsonb_build_object(
      'akcija_id',     NEW.id,
      'naslov',        NEW.naslov,
      'opis',          NEW.opis,
      'rok',           NEW.rok,
      'rok_text',      NEW.rok_text,
      'prioritet',     NEW.prioritet,
      'sastanak_id',   NEW.sastanak_id,
      'odg_label',     COALESCE(NEW.odgovoran_label, NEW.odgovoran_text, NEW.odgovoran_email)
    ),
    NEW.created_by_email
  );

  RETURN NEW;
END;
$function$

-- ============ sast_trg_meeting_locked ============
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

-- ============ sast_trg_ucesnik_invite ============
CREATE OR REPLACE FUNCTION public.sast_trg_ucesnik_invite()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_sast  public.sastanci%ROWTYPE;
  v_dupl  BOOLEAN;
BEGIN
  SELECT * INTO v_sast FROM public.sastanci WHERE id = NEW.sastanak_id;
  IF v_sast.status <> 'planiran' THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.sastanci_notification_log
    WHERE kind = 'meeting_invite'
      AND recipient_email = lower(NEW.email)
      AND related_sastanak_id = NEW.sastanak_id
      AND status IN ('queued', 'sent')
  ) INTO v_dupl;
  IF v_dupl THEN RETURN NEW; END IF;
  PERFORM public.sastanci_enqueue_notification(
    'meeting_invite', 'email', NEW.email, NEW.label,
    format('Pozivnica: %s - %s', v_sast.naslov, to_char(v_sast.datum, 'DD.MM.YYYY')),
    NULL, NULL, NEW.sastanak_id, NULL,
    jsonb_build_object(
      'sastanak_id', v_sast.id, 'naslov', v_sast.naslov, 'datum', v_sast.datum::TEXT,
      'vreme', CASE WHEN v_sast.vreme IS NOT NULL THEN left(v_sast.vreme::TEXT, 5) ELSE NULL END,
      'mesto', v_sast.mesto, 'tip', v_sast.tip,
      'organizator', COALESCE(v_sast.vodio_email, v_sast.created_by_email)
    ), NULL
  );
  RETURN NEW;
END;
$function$

-- ============ sast_trg_ucesnik_invite_cleanup ============
CREATE OR REPLACE FUNCTION public.sast_trg_ucesnik_invite_cleanup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM public.sastanci_notification_log
  WHERE kind = 'meeting_invite'
    AND related_sastanak_id = OLD.sastanak_id
    AND recipient_email = lower(OLD.email);
  RETURN OLD;
END;
$function$

-- ============ sast_user_can_move_weekly ============
CREATE OR REPLACE FUNCTION public.sast_user_can_move_weekly()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.sast_weekly_movers
    WHERE lower(email) = lower(COALESCE(auth.jwt() ->> 'email',''))
  );
$function$

-- ============ sast_weekly_odlozi ============
CREATE OR REPLACE FUNCTION public.sast_weekly_odlozi(p_week_monday date DEFAULT NULL::date, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email  text := lower(COALESCE(auth.jwt() ->> 'email',''));
  v_monday date := COALESCE(p_week_monday, public.sast_target_week_monday());
  v_sid    uuid;
  v_cancel boolean := false;
BEGIN
  IF NOT public.sast_user_can_move_weekly() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.sast_weekly_skip(week_monday, reason, created_by_email)
  VALUES (v_monday, p_reason, v_email)
  ON CONFLICT (week_monday) DO UPDATE
    SET reason = EXCLUDED.reason, created_by_email = EXCLUDED.created_by_email;

  -- Ako je sastanak već kreiran u toj nedelji → otkaži + obavesti učesnike
  SELECT id INTO v_sid FROM public.sastanci
  WHERE tip = 'sedmicni' AND datum BETWEEN v_monday AND v_monday + 6
    AND status IN ('planiran','u_toku')
  ORDER BY datum LIMIT 1;

  IF v_sid IS NOT NULL THEN
    UPDATE public.sastanci SET status = 'otkazan', updated_at = now() WHERE id = v_sid;
    PERFORM public.sast_enqueue_cancel(v_sid);
    v_cancel := true;
  END IF;

  RETURN jsonb_build_object('week_monday', v_monday, 'cancelled', v_cancel, 'sastanak_id', v_sid);
END;
$function$

-- ============ sast_weekly_pomeri ============
CREATE OR REPLACE FUNCTION public.sast_weekly_pomeri(p_datum date, p_vreme time without time zone DEFAULT '09:00:00'::time without time zone)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_monday date;
  v_sid    uuid;
  v_dtxt   text;
BEGIN
  IF NOT public.sast_user_can_move_weekly() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_datum IS NULL THEN RAISE EXCEPTION 'Datum je obavezan.'; END IF;

  v_monday := p_datum - (EXTRACT(isodow FROM p_datum)::int - 1);  -- ponedeljak te nedelje
  v_dtxt   := to_char(p_datum, 'DD.MM.YYYY');

  -- Pomeranje poništava eventualno odlaganje te nedelje
  DELETE FROM public.sast_weekly_skip WHERE week_monday = v_monday;

  SELECT id INTO v_sid FROM public.sastanci
  WHERE tip = 'sedmicni' AND datum BETWEEN v_monday AND v_monday + 6
    AND status IN ('planiran','u_toku')
  ORDER BY datum LIMIT 1;

  IF v_sid IS NOT NULL THEN
    UPDATE public.sastanci
       SET datum = p_datum, vreme = p_vreme,
           naslov = 'Sedmični sastanak — ' || v_dtxt || '.',
           pozivnice_poslate_at = now(), updated_at = now()
     WHERE id = v_sid;
    PERFORM public.sastanci_send_invites(v_sid);  -- novi termin → nove pozivnice (.ics)
    RETURN v_sid;
  ELSE
    -- Još nije kreiran (pre petka) → kreiraj sada za taj datum
    RETURN public.sast_create_weekly_at(p_datum, p_vreme);
  END IF;
END;
$function$

-- ============ sast_weekly_status ============
CREATE OR REPLACE FUNCTION public.sast_weekly_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_monday  date := public.sast_target_week_monday();
  v_target  date := public.sast_adjust_for_holiday(v_monday);
  v_skip    RECORD;
  v_s       RECORD;
BEGIN
  SELECT * INTO v_skip FROM public.sast_weekly_skip WHERE week_monday = v_monday;
  SELECT id, datum, vreme, status INTO v_s FROM public.sastanci
   WHERE tip = 'sedmicni' AND datum BETWEEN v_monday AND v_monday + 6
     AND status <> 'otkazan'
   ORDER BY datum LIMIT 1;

  RETURN jsonb_build_object(
    'week_monday',  v_monday,
    'default_date', v_target,
    'skipped',      (v_skip.week_monday IS NOT NULL),
    'skip_reason',  v_skip.reason,
    'sastanak_id',      v_s.id,
    'sastanak_datum',   v_s.datum,
    'sastanak_vreme',   CASE WHEN v_s.vreme IS NOT NULL THEN left(v_s.vreme::text,5) ELSE NULL END,
    'sastanak_status',  v_s.status,
    'can_move',     public.sast_user_can_move_weekly()
  );
END;
$function$

-- ============ sast_weekly_vrati ============
CREATE OR REPLACE FUNCTION public.sast_weekly_vrati(p_week_monday date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_monday date := COALESCE(p_week_monday, public.sast_target_week_monday());
  v_sid    uuid;
  v_react  boolean := false;
BEGIN
  IF NOT public.sast_user_can_move_weekly() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.sast_weekly_skip WHERE week_monday = v_monday;

  -- Ako je sedmični te nedelje otkazan → vrati u planiran i ponovo pozovi
  SELECT id INTO v_sid FROM public.sastanci
  WHERE tip = 'sedmicni' AND datum BETWEEN v_monday AND v_monday + 6
    AND status = 'otkazan'
  ORDER BY datum DESC LIMIT 1;

  IF v_sid IS NOT NULL THEN
    UPDATE public.sastanci SET status = 'planiran', updated_at = now() WHERE id = v_sid;
    PERFORM public.sastanci_send_invites(v_sid);
    v_react := true;
  END IF;

  RETURN jsonb_build_object('week_monday', v_monday, 'reactivated', v_react, 'sastanak_id', v_sid);
END;
$function$

-- ============ sast_zakljucaj_sastanak ============
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

-- ============ sastanci_dispatch_dequeue ============
CREATE OR REPLACE FUNCTION public.sastanci_dispatch_dequeue(p_batch_size integer DEFAULT 25, p_max_attempts integer DEFAULT 5)
 RETURNS SETOF sastanci_notification_log
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id FROM public.sastanci_notification_log
    WHERE status IN ('queued', 'failed') AND next_attempt_at <= now() AND attempts < p_max_attempts
    ORDER BY next_attempt_at ASC, created_at ASC LIMIT p_batch_size FOR UPDATE SKIP LOCKED
  )
  UPDATE public.sastanci_notification_log n
     SET attempts = n.attempts + 1, last_attempt_at = now(), status = 'queued'
  FROM picked p WHERE n.id = p.id RETURNING n.*;
END;
$function$

-- ============ sastanci_dispatch_mark_failed ============
CREATE OR REPLACE FUNCTION public.sastanci_dispatch_mark_failed(p_id uuid, p_error text, p_backoff_sec integer DEFAULT 60)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  UPDATE public.sastanci_notification_log
     SET status = 'failed', error = left(coalesce(p_error, ''), 1000),
         next_attempt_at = now() + make_interval(secs => greatest(p_backoff_sec, 5))
   WHERE id = p_id;
$function$

-- ============ sastanci_dispatch_mark_sent ============
CREATE OR REPLACE FUNCTION public.sastanci_dispatch_mark_sent(p_ids uuid[])
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH upd AS (
    UPDATE public.sastanci_notification_log
       SET status = 'sent', sent_at = now(), error = NULL
     WHERE id = ANY (p_ids) RETURNING 1
  ) SELECT count(*)::int FROM upd;
$function$

-- ============ sastanci_enqueue_action_reminders ============
CREATE OR REPLACE FUNCTION public.sastanci_enqueue_action_reminders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec RECORD; v_today DATE := current_date; v_dupl BOOLEAN; v_cnt INT := 0;
BEGIN
  FOR v_rec IN
    SELECT a.id, a.naslov, a.rok, a.rok_text, a.prioritet, a.sastanak_id, a.odgovoran_email,
      COALESCE(a.odgovoran_label, a.odgovoran_text, a.odgovoran_email) AS odg_label
    FROM public.akcioni_plan a
    WHERE a.status IN ('otvoren','u_toku','kasni') AND a.odgovoran_email IS NOT NULL
      AND trim(a.odgovoran_email) <> '' AND a.rok IS NOT NULL
      AND a.rok BETWEEN (v_today - 2) AND (v_today + 1)
  LOOP
    SELECT EXISTS (SELECT 1 FROM public.sastanci_notification_log
      WHERE kind = 'action_reminder' AND recipient_email = lower(v_rec.odgovoran_email)
        AND related_akcija_id = v_rec.id AND status IN ('queued','sent')
        AND created_at >= (now() - interval '20 hours')) INTO v_dupl;
    IF v_dupl THEN CONTINUE; END IF;
    PERFORM public.sastanci_enqueue_notification('action_reminder', 'email', v_rec.odgovoran_email, v_rec.odg_label,
      CASE WHEN v_rec.rok < v_today THEN format('Akcija kasni: %s (rok bio %s)', v_rec.naslov, to_char(v_rec.rok,'DD.MM.YYYY'))
           WHEN v_rec.rok = v_today THEN format('Rok danas: %s', v_rec.naslov)
           ELSE format('Rok sutra: %s', v_rec.naslov) END,
      NULL, NULL, v_rec.sastanak_id, v_rec.id,
      jsonb_build_object('akcija_id',v_rec.id,'naslov',v_rec.naslov,'rok',v_rec.rok,'rok_text',v_rec.rok_text,
        'prioritet',v_rec.prioritet,'sastanak_id',v_rec.sastanak_id,'odg_label',v_rec.odg_label,'reminder_for',v_today::text), NULL);
    v_cnt := v_cnt + 1;
  END LOOP;
  RETURN v_cnt;
END;
$function$

-- ============ sastanci_enqueue_meeting_reminders ============
CREATE OR REPLACE FUNCTION public.sastanci_enqueue_meeting_reminders()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rec RECORD; v_ucr RECORD; v_dupl BOOLEAN; v_cnt INT := 0;
BEGIN
  FOR v_rec IN
    SELECT s.id, s.naslov, s.datum, s.vreme, s.mesto, s.tip,
      COALESCE(s.vodio_email, s.created_by_email) AS organizator,
      (s.datum + COALESCE(s.vreme, '09:00'::time))::timestamptz AS starts_at
    FROM public.sastanci s
    WHERE s.status = 'planiran' AND s.datum IS NOT NULL AND s.vreme IS NOT NULL
  LOOP
    IF v_rec.starts_at NOT BETWEEN (now() + interval '15 minutes') AND (now() + interval '45 minutes') THEN
      CONTINUE;
    END IF;
    FOR v_ucr IN SELECT email, label FROM public.sastanak_ucesnici WHERE sastanak_id = v_rec.id
    LOOP
      SELECT EXISTS (SELECT 1 FROM public.sastanci_notification_log
        WHERE kind = 'meeting_reminder' AND recipient_email = lower(v_ucr.email)
          AND related_sastanak_id = v_rec.id AND status IN ('queued','sent')
          AND created_at >= (now() - interval '1 hour')) INTO v_dupl;
      IF v_dupl THEN CONTINUE; END IF;
      PERFORM public.sastanci_enqueue_notification('meeting_reminder', 'email', v_ucr.email, v_ucr.label,
        format('Podsetnik: %s - %s u %s', v_rec.naslov, to_char(v_rec.datum,'DD.MM.YYYY'), left(v_rec.vreme::text,5)),
        NULL, NULL, v_rec.id, NULL,
        jsonb_build_object('sastanak_id',v_rec.id,'naslov',v_rec.naslov,'datum',v_rec.datum::text,
          'vreme',left(v_rec.vreme::text,5),'mesto',v_rec.mesto,'tip',v_rec.tip,'organizator',v_rec.organizator,'starts_at',v_rec.starts_at::text), NULL);
      v_cnt := v_cnt + 1;
    END LOOP;
  END LOOP;
  RETURN v_cnt;
END;
$function$

-- ============ sastanci_enqueue_notification ============
CREATE OR REPLACE FUNCTION public.sastanci_enqueue_notification(p_kind text, p_channel text, p_recipient_email text, p_recipient_label text, p_subject text, p_body_html text DEFAULT NULL::text, p_body_text text DEFAULT NULL::text, p_related_sastanak_id uuid DEFAULT NULL::uuid, p_related_akcija_id uuid DEFAULT NULL::uuid, p_payload jsonb DEFAULT NULL::jsonb, p_created_by_email text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prefs     public.sastanci_notification_prefs%ROWTYPE;
  v_opted_in  BOOLEAN;
  v_status    TEXT;
  v_id        UUID;
  v_email     TEXT;
BEGIN
  v_email := lower(COALESCE(p_recipient_email, ''));
  IF v_email = '' THEN
    RETURN NULL;
  END IF;

  -- Pročitaj prefs (ako ne postoje → default = sve true)
  SELECT * INTO v_prefs
  FROM public.sastanci_notification_prefs
  WHERE email = v_email;

  -- Odredi opt-in status po kind-u; ako reda nema, default je TRUE.
  -- meeting_locked je OBAVEZAN (zvanična distribucija zapisnika) → uvek TRUE.
  v_opted_in := CASE p_kind
    WHEN 'akcija_new'        THEN COALESCE(v_prefs.on_new_akcija,       TRUE)
    WHEN 'akcija_changed'    THEN COALESCE(v_prefs.on_change_akcija,    TRUE)
    WHEN 'meeting_invite'    THEN COALESCE(v_prefs.on_meeting_invite,   TRUE)
    WHEN 'meeting_locked'    THEN TRUE   -- obavezno svima, ignoriše opt-out
    WHEN 'action_reminder'   THEN COALESCE(v_prefs.on_action_reminder,  TRUE)
    WHEN 'meeting_reminder'  THEN COALESCE(v_prefs.on_meeting_reminder, TRUE)
    ELSE TRUE
  END;

  v_status := CASE WHEN v_opted_in THEN 'queued' ELSE 'skipped' END;

  INSERT INTO public.sastanci_notification_log (
    kind, channel,
    recipient_email, recipient_label,
    subject, body_html, body_text,
    related_sastanak_id, related_akcija_id,
    status, scheduled_at, next_attempt_at,
    payload, created_by_email
  ) VALUES (
    p_kind, COALESCE(p_channel, 'email'),
    v_email, p_recipient_label,
    COALESCE(p_subject, p_kind), p_body_html, p_body_text,
    p_related_sastanak_id, p_related_akcija_id,
    v_status, now(), now(),
    p_payload, p_created_by_email
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$

-- ============ sastanci_get_or_create_my_prefs ============
CREATE OR REPLACE FUNCTION public.sastanci_get_or_create_my_prefs()
 RETURNS sastanci_notification_prefs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email TEXT;
  v_row   public.sastanci_notification_prefs;
BEGIN
  v_email := lower(COALESCE(auth.jwt() ->> 'email', ''));
  IF v_email = '' THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  INSERT INTO public.sastanci_notification_prefs (email)
  VALUES (v_email)
  ON CONFLICT (email) DO NOTHING;

  SELECT * INTO v_row
  FROM public.sastanci_notification_prefs
  WHERE email = v_email;

  RETURN v_row;
END;
$function$

-- ============ sastanci_pulse_notify_dispatch ============
CREATE OR REPLACE FUNCTION public.sastanci_pulse_notify_dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_url     text;
  v_bearer  text;
  v_headers jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RETURN;
  END IF;

  SELECT NULLIF(btrim(ds.decrypted_secret), '')
    INTO v_url
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'sast_notify_dispatch_url'
   LIMIT 1;
  IF v_url IS NULL THEN RETURN; END IF;

  SELECT btrim(ds.decrypted_secret)
    INTO v_bearer
    FROM vault.decrypted_secrets ds
   WHERE ds.name = 'sast_notify_dispatch_bearer'
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

-- ============ sastanci_remind_unprepared ============
CREATE OR REPLACE FUNCTION public.sastanci_remind_unprepared(p_sastanak_id uuid)
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
  IF NOT FOUND THEN RETURN 0; END IF;

  DELETE FROM public.sastanci_notification_log
   WHERE kind = 'meeting_prep_reminder' AND related_sastanak_id = p_sastanak_id AND related_akcija_id IS NULL;

  FOR v_rec IN
    SELECT email, label FROM public.sastanak_ucesnici
     WHERE sastanak_id = p_sastanak_id AND pozvan = true AND pripremljen = false
  LOOP
    PERFORM public.sastanci_enqueue_notification(
      'meeting_prep_reminder', 'email', v_rec.email, v_rec.label,
      format('Podsetnik: pripremi se za „%s"', v_s.naslov), NULL, NULL, p_sastanak_id, NULL,
      jsonb_build_object(
        'sastanak_id', p_sastanak_id, 'naslov', v_s.naslov, 'datum', v_s.datum::TEXT,
        'vreme', CASE WHEN v_s.vreme IS NOT NULL THEN left(v_s.vreme::TEXT, 5) ELSE NULL END,
        'mesto', v_s.mesto, 'organizator', COALESCE(v_s.vodio_email, v_s.created_by_email)
      ),
      NULL
    );
    v_cnt := v_cnt + 1;
  END LOOP;
  RETURN v_cnt;
END;
$function$

-- ============ sastanci_resend_meeting_locked ============
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

-- ============ sastanci_send_invites ============
CREATE OR REPLACE FUNCTION public.sastanci_send_invites(p_sastanak_id uuid)
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
  IF NOT FOUND THEN RETURN 0; END IF;

  DELETE FROM public.sastanci_notification_log
   WHERE kind = 'meeting_invite' AND related_sastanak_id = p_sastanak_id AND related_akcija_id IS NULL;

  FOR v_rec IN
    SELECT email, label FROM public.sastanak_ucesnici WHERE sastanak_id = p_sastanak_id AND pozvan = true
  LOOP
    PERFORM public.sastanci_enqueue_notification(
      'meeting_invite', 'email', v_rec.email, v_rec.label,
      format('Pozivnica: %s', v_s.naslov), NULL, NULL, p_sastanak_id, NULL,
      jsonb_build_object(
        'sastanak_id', p_sastanak_id, 'naslov', v_s.naslov, 'datum', v_s.datum::TEXT,
        'vreme', CASE WHEN v_s.vreme IS NOT NULL THEN left(v_s.vreme::TEXT, 5) ELSE NULL END,
        'mesto', v_s.mesto, 'tip', v_s.tip, 'organizator', COALESCE(v_s.vodio_email, v_s.created_by_email)
      ),
      NULL
    );
    v_cnt := v_cnt + 1;
  END LOOP;
  RETURN v_cnt;
END;
$function$

-- ============ sastanci_set_my_rsvp ============
CREATE OR REPLACE FUNCTION public.sastanci_set_my_rsvp(p_sastanak_id uuid, p_status text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_updated int;
begin
  if v_email = '' then
    raise exception 'RSVP: nedostaje email u sesiji';
  end if;
  if p_status is not null and p_status not in ('dolazim', 'ne_dolazim') then
    raise exception 'RSVP: nevažeći status %', p_status;
  end if;
  update public.sastanak_ucesnici
     set rsvp_status = p_status,
         rsvp_at     = now()
   where sastanak_id = p_sastanak_id
     and lower(email) = v_email;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return 'not_participant';
  end if;
  return coalesce(p_status, 'cleared');
end
$function$

-- ============ set_sastanci_ai_model ============
CREATE OR REPLACE FUNCTION public.set_sastanci_ai_model(p_model text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m text := lower(trim(coalesce(p_model, '')));
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF m NOT IN ('claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5') THEN
    RAISE EXCEPTION 'nepoznat model: %', p_model USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.sastanci_ai_settings (id, model, updated_by, updated_at)
  VALUES (1, m, auth.uid(), now())
  ON CONFLICT (id) DO UPDATE
    SET model = EXCLUDED.model,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  RETURN m;
END;
$function$

-- ================================================================
-- VIEW DEFINICIJE (front read okvir)
-- ================================================================

-- ============ view: v_akcioni_plan ============
CREATE OR REPLACE VIEW public.v_akcioni_plan AS
SELECT id,
    sastanak_id,
    tema_id,
    projekat_id,
    rb,
    naslov,
    opis,
    odgovoran_email,
    odgovoran_label,
    odgovoran_text,
    rok,
    rok_text,
    status,
    prioritet,
    zatvoren_at,
    zatvoren_by_email,
    zatvoren_napomena,
    created_at,
    created_by_email,
    updated_at,
        CASE
            WHEN (status = ANY (ARRAY['zavrsen'::text, 'odlozen'::text, 'otkazan'::text])) THEN status
            WHEN ((rok IS NOT NULL) AND (rok < CURRENT_DATE) AND (status = ANY (ARRAY['otvoren'::text, 'u_toku'::text]))) THEN 'kasni'::text
            ELSE status
        END AS effective_status,
        CASE
            WHEN (rok IS NULL) THEN NULL::integer
            ELSE (rok - CURRENT_DATE)
        END AS dana_do_roka
   FROM akcioni_plan ap;

-- ============ view: v_pm_teme_pregled ============
CREATE OR REPLACE VIEW public.v_pm_teme_pregled AS
SELECT id,
    vrsta,
    oblast,
    naslov,
    opis,
    projekat_id,
    status,
    prioritet,
    sastanak_id,
    predlozio_email,
    predlozio_label,
    predlozio_at,
    resio_email,
    resio_label,
    resio_at,
    resio_napomena,
    created_at,
    updated_at,
    hitno,
    za_razmatranje,
    admin_rang,
    admin_rang_by_email,
    admin_rang_at,
        CASE
            WHEN (za_razmatranje AND hitno) THEN 'hitno_razmatra'::text
            WHEN za_razmatranje THEN 'razmatra'::text
            WHEN hitno THEN 'hitno'::text
            ELSE 'normalno'::text
        END AS visual_tag
   FROM pm_teme t;


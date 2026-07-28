-- Odluke 2 i 3 (Nenad, 26.07.2026) — self-service RPC-ovi za sy15 bazu.
-- Obrazac: sastanci_set_my_rsvp (SECURITY DEFINER; identitet = auth.jwt()->>'email'
-- iz GUC klaimova koje backend postavlja u withUserMapped transakciji).
-- RLS politike se NE diraju (su_update/p_onb_tasks_manage ostaju edit/HR-only);
-- self-put ide isključivo kroz ove uske funkcije sa server-side vlasništvom.
-- PRIMENJENO na živu sy15 bazu 26.07.2026 (docker exec -i sy15-db psql -U postgres).

-- ---------------------------------------------------------------------------
-- (3a) Status SOPSTVENE akcione tačke pod sastanci.read (1.0 myWork paritet).
--      Dozvoljeni statusi: otvoren / u_toku / zavrsen (bez otkazivanja).
--      zavrsen → snapshot zatvoren_* (paritet patchAkcija servisa); reopen → čisti.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sastanci_set_my_akcija_status(p_akcija_id uuid, p_status text)
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
    raise exception 'Akcija: nedostaje email u sesiji';
  end if;
  if p_status not in ('otvoren', 'u_toku', 'zavrsen') then
    raise exception 'Akcija: nevažeći status %', p_status;
  end if;
  update public.akcioni_plan
     set status            = p_status,
         zatvoren_at       = case when p_status = 'zavrsen' then now() else null end,
         zatvoren_by_email = case when p_status = 'zavrsen' then v_email else null end,
         updated_at        = now()
   where id = p_akcija_id
     and lower(coalesce(odgovoran_email, '')) = v_email;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return 'not_owner';
  end if;
  return p_status;
end
$function$;

GRANT EXECUTE ON FUNCTION public.sastanci_set_my_akcija_status(uuid, text)
  TO authenticated, service_role, servosync2_app;

-- ---------------------------------------------------------------------------
-- (3b) SOPSTVENA priprema za sastanak pod sastanci.read (pripremljen + tekst).
--      pozvan/prisutan NAMERNO van dometa — to vodi zapisničar (su_update RLS).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sastanci_set_my_priprema(p_sastanak_id uuid, p_pripremljen boolean, p_priprema text)
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
    raise exception 'Priprema: nedostaje email u sesiji';
  end if;
  update public.sastanak_ucesnici
     set pripremljen = coalesce(p_pripremljen, pripremljen),
         priprema    = case when p_priprema is null then priprema
                            else nullif(btrim(p_priprema), '') end
   where sastanak_id = p_sastanak_id
     and lower(email) = v_email;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return 'not_participant';
  end if;
  return 'ok';
end
$function$;

GRANT EXECUTE ON FUNCTION public.sastanci_set_my_priprema(uuid, boolean, text)
  TO authenticated, service_role, servosync2_app;

-- ---------------------------------------------------------------------------
-- (2) Onboarding: radnik štiklira SOPSTVENI zadatak (done ↔ pending).
--     'skipped' ostaje HR-u (kadr endpoint); vlasništvo = zadatak pripada
--     AKTIVNOM run-u čiji je employee = rev_current_employee_id().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.profile_set_my_onboarding_task(p_task_id uuid, p_done boolean)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email   text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_emp     uuid := public.rev_current_employee_id();
  v_updated int;
begin
  if v_emp is null then
    return 'no_employee';
  end if;
  update public.kadr_onboarding_tasks t
     set status  = case when p_done then 'done' else 'pending' end,
         done_at = case when p_done then now() else null end,
         done_by = case when p_done then v_email else null end
    from public.kadr_onboarding_runs r
   where t.id = p_task_id
     and r.id = t.run_id
     and r.employee_id = v_emp
     and r.status = 'active'
     and t.status <> 'skipped';
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return 'not_found';
  end if;
  return case when p_done then 'done' else 'pending' end;
end
$function$;

GRANT EXECUTE ON FUNCTION public.profile_set_my_onboarding_task(uuid, boolean)
  TO authenticated, service_role, servosync2_app;

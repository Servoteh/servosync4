-- AUTHZ/RPC SNAPSHOT: Talas E — Energetika/SCADA (scada_*) — snimljeno 2026-07-12
-- Izvor: zamrznuti Supabase cloud (Management API, read-only) = restore-izvor sy15 baze (cutover 1.5, noc 09->10.07).
-- Pre R1 RE-VERIFIKOVATI na zivoj sy15 (bez ssh iz spec faze; R0 korak glavne sesije).
-- Sadrzaj: pune definicije svih 5 scada_* funkcija (pg_get_functiondef, prokind='f') + appendix
-- (9 politika, trigger, cron job, table grants) za R0 re-verifikaciju.
--
-- FRONT-facing: scada_cancel_command (jedini RPC koji front zove) + scada_is_admin_or_management (RLS helper).
-- POZADINA (NE seli se): scada_claim_commands (bridge, service_role-only), scada_alarm_push_trg (trigger),
--   scada_watchdog (pg_cron */5 min). Bridge = systemd na ubuntusrv od 11.07 (docs/scada/bridge-scada-install.md).
--
-- POZNAT DRIFT cloud vs sy15 (commit 1.0 repoa dc8bb57, 2026-07-11): scada_alarm_push_trg v_url je na sy15
-- repointovan na 'http://gateway/functions/v1/push-dispatch' (ovde dole je stara cloud vrednost
-- 'https://fniruhsuotwsrjsbhrxd.supabase.co/...'). Ostale definicije se ocekuju identicne — proveriti u R0.

-- ============ scada_alarm_push_trg ============
-- ACL: {postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.scada_alarm_push_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'net'
AS $function$
declare
  v_url text := 'https://fniruhsuotwsrjsbhrxd.supabase.co/functions/v1/push-dispatch';
  v_key text := (select value from private.app_config where key = 'push_dispatch_key');
  v_site text; v_title text; v_emails jsonb; v_tag text;
begin
  if new.active is distinct from true then return new; end if;
  select name into v_site from public.scada_sites where key = new.site_key;
  v_title := '⚡ SCADA — ' || coalesce(v_site, new.site_key);
  v_tag := case when new.code = 'BRIDGE_STALE' then 'scada-stale' else 'scada-alarm' end;
  select jsonb_agg(distinct lower(ur.email)) into v_emails
    from public.user_roles ur left join public.scada_notify_prefs p on p.user_email = lower(ur.email)
   where ur.is_active = true and ur.project_id is null and lower(ur.role::text) in ('admin','menadzment')
     and coalesce(p.enabled, true) and new.severity <= coalesce(p.min_severity, 3)
     and (p.sites is null or new.site_key = any(p.sites));
  if v_emails is null or jsonb_array_length(v_emails) = 0 then return new; end if;
  perform net.http_post(url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-push-key', v_key),
    body := jsonb_build_object('emails', v_emails,'title', v_title,'message', left(coalesce(new.text, new.code),140),'url','/m/energetika','tag', v_tag));
  return new;
exception when others then return new;
end $function$
;

-- ============ scada_cancel_command ============
-- ACL: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.scada_cancel_command(p_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_status text;
begin
  if not public.scada_is_admin_or_management() then
    raise exception 'nedozvoljeno';
  end if;

  update public.scada_commands
     set status = 'expired',
         result = jsonb_build_object('error','otkazano iz aplikacije (bridge se nije javio na vreme)')
   where id = p_id
     and status = 'pending'
     and requested_by = lower(coalesce(auth.jwt()->>'email',''));

  select status into v_status from public.scada_commands where id = p_id;
  return coalesce(v_status, 'missing');
end;
$function$
;

-- ============ scada_claim_commands ============
-- ACL: {postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.scada_claim_commands(p_limit integer DEFAULT 10)
 RETURNS SETOF scada_commands
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- istekle pending → expired (audit ostaje)
  update public.scada_commands
     set status = 'expired',
         result = coalesce(result, jsonb_build_object('error','expired before claim'))
   where status = 'pending'
     and expires_at < now();

  -- zaglavljene claimed (bridge pao pre ishoda) → failed sa jasnom napomenom
  update public.scada_commands
     set status = 'failed',
         applied_at = now(),
         result = coalesce(result, jsonb_build_object(
           'error', 'bridge prekinut pre potvrde — ishod nepoznat (NIJE ponovo izvršeno)'))
   where status = 'claimed'
     and claimed_at < now() - interval '2 minutes';

  return query
  with picked as (
    select c.id
      from public.scada_commands c
     where c.status = 'pending'
       and c.expires_at >= now()
     order by c.requested_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
     for update skip locked
  )
  update public.scada_commands c
     set status = 'claimed', claimed_at = now()
    from picked
   where c.id = picked.id
  returning c.*;
end;
$function$
;

-- ============ scada_is_admin_or_management ============
-- ACL: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.scada_is_admin_or_management()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.user_roles ur
    where ur.is_active = true
      and ur.project_id is null
      and lower(ur.email) = lower(coalesce(auth.jwt()->>'email',''))
      and lower(ur.role::text) in ('admin','menadzment')
  );
$function$
;

-- ============ scada_watchdog ============
-- ACL: {postgres=X/postgres,service_role=X/postgres}
CREATE OR REPLACE FUNCTION public.scada_watchdog()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.scada_alarms (site_key, code, severity, text)
  select s.site_key, 'BRIDGE_STALE', 2,
         'Bridge ne šalje podatke od ' || to_char(s.updated_at at time zone 'Europe/Belgrade', 'DD.MM. HH24:MI')
    from public.scada_snapshots s
   where s.updated_at < now() - interval '5 minutes'
     and not exists (
       select 1 from public.scada_alarms a
        where a.site_key = s.site_key and a.code = 'BRIDGE_STALE' and a.active
     )
  on conflict do nothing;
end $function$
;

-- =====================================================================
-- APPENDIX A — pg_policies (9 politika; snimljeno 2026-07-12 sa cloud restore-izvora)
-- =====================================================================
-- scada_sites      | scada_read_sites   | SELECT to authenticated USING scada_is_admin_or_management()
-- scada_snapshots  | scada_read_snap    | SELECT to authenticated USING scada_is_admin_or_management()
-- scada_history    | scada_read_hist    | SELECT to authenticated USING scada_is_admin_or_management()
-- scada_alarms     | scada_read_alarm   | SELECT to authenticated USING scada_is_admin_or_management()
-- scada_commands   | scada_cmd_read     | SELECT to authenticated USING scada_is_admin_or_management()
-- scada_commands   | scada_cmd_insert   | INSERT to authenticated WITH CHECK (
--                       scada_is_admin_or_management()
--                       AND requested_by = lower(coalesce(auth.jwt()->>'email',''))
--                       AND status = 'pending' AND result IS NULL
--                       AND claimed_at IS NULL AND applied_at IS NULL)
-- scada_notify_prefs | scada_prefs_select | SELECT to authenticated USING (
--                       scada_is_admin_or_management() AND user_email = lower(coalesce(auth.jwt()->>'email','')))
-- scada_notify_prefs | scada_prefs_upsert | INSERT to authenticated WITH CHECK (
--                       scada_is_admin_or_management() AND user_email = lower(coalesce(auth.jwt()->>'email','')))
-- scada_notify_prefs | scada_prefs_update | UPDATE to authenticated USING (
--                       scada_is_admin_or_management() AND user_email = lower(coalesce(auth.jwt()->>'email','')))
--                       WITH CHECK (user_email = lower(coalesce(auth.jwt()->>'email','')))
--
-- NB: NEMA UPDATE/DELETE politike na scada_commands za authenticated — status menja ISKLJUCIVO
--     bridge (service_role, RLS bypass) ili DEFINER RPC scada_cancel_command. Audit je nepromenljiv.
-- NB: snapshot/history/alarms/sites NEMAJU insert/update politike — pise iskljucivo service_role (bridge).
-- NB: RLS enabled na svih 6 tabela; anon: REVOKE ALL (migracija add_scada_module.sql).

-- =====================================================================
-- APPENDIX B — trigger + pg_cron + table grants (2026-07-12)
-- =====================================================================
-- TRIGGER: scada_alarm_push_aigt AFTER INSERT ON public.scada_alarms
--          FOR EACH ROW EXECUTE FUNCTION scada_alarm_push_trg()
-- CRON:    jobid=21  jobname='scada_watchdog_every_5_min'  schedule='*/5 * * * *'
--          command='select public.scada_watchdog()'  active=true
-- GRANTS (relacl, svih 6 tabela isto): postgres=arwdDxtm | authenticated=arwdDxtm | service_role=arwdDxtm
--          (RLS je stvarni gate; authenticated ima siroke grantove ali politike ga ogranicavaju)
--
-- ZIVOST PODATAKA na cloud restore-izvoru (2026-07-12):
--   scada_sites=5 (max last_seen 2026-07-09 22:27 UTC) · scada_snapshots=5 (max updated_at 09.07 22:27 UTC)
--   scada_history=438086 (max ts 09.07 22:27 UTC) · scada_alarms=12747 (8 aktivnih; max raised_at 09.07)
--   scada_commands=15 (11 applied / 4 rejected; poslednja 05.07) · scada_notify_prefs=0
--   → cloud upisi STALI u trenutku cutover-a 1.5 = bridge vise NE pise u cloud (konzistentno sa
--     seobom bridge-a na ubuntusrv/sy15 11.07). Sveze upise verifikovati na sy15 u R0.

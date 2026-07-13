-- ============================================================================
-- TALAS D — R0 GRANTS (DRAFT, MINIMALAN) — Projektni biro + Moj profil + Podešavanja
-- ----------------------------------------------------------------------------
-- ARHITEKTURA (kao Talas B/A.2a): 2.0 backend za Talas D koristi
-- `Sy15Service.withUserRls` (GUC claims sub+email + `SET LOCAL ROLE authenticated`
-- u ISTOJ transakciji). Ceo READ se izvršava kao `authenticated` (rolbypassrls = f)
-- → važe SVE 1.0 RLS politike + table/fn privilegije IDENTIČNO kao kroz PostgREST =
-- paritet po konstrukciji. Nikakvi NOVI grantovi na tabele/funkcije nisu potrebni
-- za R1 READ: SET ROLE nasleđuje privilegije koje `authenticated` VEĆ ima (isti
-- objekti koje 1.0 front čita).
--
-- JEDINI R0 DB korak = članstvo `servosync2_app` u `authenticated` — ISTI kao Talas B
-- (`talasB-R0-grants-DRAFT.sql`). Ako je Talas B već primenio članstvo, ovaj blok je
-- no-op. Ostavljen ovde idempotentno (Talas D može biti prvi na svežoj sy15).
-- Primena: glavna sesija, na ŽIVOJ sy15, ISKLJUČIVO kao `supabase_admin`
-- (doktrina §A.6 — sy15 `postgres` nije superuser).
--
-- ----------------------------------------------------------------------------
-- R0 VERIFIKACIJA (Management API, read-only, 2026-07-13) — R1 READ POVRŠINA
-- ----------------------------------------------------------------------------
-- `has_table_privilege('authenticated', <t>, 'select')` = TRUE za SVE tabele/view-ove
-- koje R1 čita (0 rupa za read):
--   PB:        pb_tasks, pb_work_reports, pb_task_comments, pb_task_deps, pb_task_files,
--              pb_eng_tips, pb_eng_tip_categories, pb_eng_tip_likes, pb_eng_tip_files,
--              pb_notification_config, pb_notification_log
--   RBAC/mat.: user_roles, departments, sub_departments, job_positions, company_profile,
--              kadr_grid_editor_allowlist, kadr_holidays, employee_expectations,
--              competences, competence_groups, competence_levels, competence_profiles,
--              competence_questions, profile_positions, audit_log
--   Profil:    vacation_requests, vacation_history, makeup_requests, paid_leave_requests,
--              employee_talks, absences, work_hours_remarks
--   View-ovi:  v_employees_safe, v_vacation_balance, v_settings_audit_log,
--              v_attendance_daily, v_employee_expectations, v_competence_framework  (svi TRUE)
--   RPC EXECUTE (DEFINER, front): pb_list_projects, pb_get_mechanical_projecting_engineers,
--              pb_get_load_stats, pb_get_team_load_stats, pb_get_work_report_summary,
--              pb_list_eng_tips, pb_get_eng_tip, pb_list_eng_tip_categories,
--              get_my_user_roles, list_predmet_aktivacija_admin  — 1.0 front ih već zove
--              kao authenticated (EXECUTE nasleđen; RE-VERIFIKOVATI ako se pojavi 42501).
--
-- ⚠️ NALAZ 1 — `predmet_aktivacija` NIJE u `public` šemi: živi u `production` šemi
--   (RPC-only pristup preko `list_predmet_aktivacija_admin()`/`set_predmet_aktivacija()`;
--   audit piše sam RPC — spec §2.4.11). Zato NEMA Prisma modela; čita se isključivo kroz
--   RPC. Nije potreban direktan grant (DEFINER RPC).
--
-- ⚠️ NALAZ 2 (nasleđeno, NIJE Talas D posao) — `anon` ima SELECT na većini gornjih tabela
--   (izuzetak: kadr_grid_editor_allowlist = anon FALSE). To je 1.0 posture (pre-prod audit
--   2026-07-05 K1). 2.0 app radi kao `authenticated`, NE `anon` — ne utiče na Talas D; popis
--   ostaje za finalni 3.0 hardening (van obima R1).
--
-- R2 (NIJE R0/R1): dvostrano upravljanje nalozima (D1 — GoTrue admin + user_roles INSERT/
--   UPDATE + welcome outbox), overrides data-migracija (#44), audit 2.0-strana (D10). Tada
--   se procenjuju grantovi za WRITE put (verovatno DEFINER RPC / BYPASSRLS konekcija kao B).
--
-- STORAGE (R2): bucketi `pb-task-files`, `pb-eng-tip-files` idu kroz sy15 storage-api
--   presigned (Reversi/Sastanci obrazac); RLS na storage.objects netaknut. Nema R0 grant-a.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'servosync2_app') then
    raise notice 'rola servosync2_app ne postoji — preskočeno (uspostaviti pre R0)';
    return;
  end if;

  -- Članstvo = most za SET LOCAL ROLE authenticated (Sy15Service.withUserRls).
  -- Bez ovoga SET ROLE pada sa 42501 i Talas D read endpointi vraćaju 403 na sve.
  if not exists (
    select 1
    from pg_auth_members m
    join pg_roles grp on grp.oid = m.roleid
    join pg_roles mem on mem.oid = m.member
    where grp.rolname = 'authenticated'
      and mem.rolname = 'servosync2_app'
  ) then
    grant authenticated to servosync2_app;
    raise notice 'GRANT authenticated TO servosync2_app — izvršeno';
  else
    raise notice 'servosync2_app je već član authenticated — no-op (verovatno Talas B)';
  end if;
end $$;

notify pgrst, 'reload schema';

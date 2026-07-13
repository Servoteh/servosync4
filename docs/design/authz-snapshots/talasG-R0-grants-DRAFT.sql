-- ============================================================================
-- TALAS G — R0 GRANTS (DRAFT, MINIMALAN) — Kadrovska / HR
-- ----------------------------------------------------------------------------
-- ARHITEKTURA (doktrina A.2a, presuda 13.07): 2.0 backend čita/piše sy15 kroz
-- `Sy15Service.withUserRls`:
--   1) GUC claims (`request.jwt.claims` sa sub+email),
--   2) `SET LOCAL ROLE authenticated` u ISTOJ transakciji.
-- Ceo upit se izvršava kao `authenticated` (rolbypassrls = f) → važe SVE 1.0 RLS
-- politike (141 na 49 HR tabela + 4 storage) + table/fn privilegije IDENTIČNO kao
-- kroz PostgREST = paritet po konstrukciji. Za Kadrovsku je ovo NEZAOBILAZNO:
-- konekciona rola `servosync2_app` je BYPASSRLS → direktan put (`this.sy15.db`) bi
-- PROBIO PII masku (v_employees_safe / current_user_can_manage_employee_pii) i
-- zarade (admin-only). SVAKI read u KadrovskaService ide kroz `withUserRls`
-- (dokazano unit-om `kadrovska.pii-guard.spec` — 41 read metoda, 0 dodira `db`).
--
-- ZAKLJUČAK: NIJEDAN nov table/fn grant za `servosync2_app` NIJE potreban za R1 read.
-- `SET ROLE authenticated` nasleđuje privilegije koje `authenticated` VEĆ ima —
-- a to je TAČNO površina koju 1.0 front (PostgREST) već čita. Verifikacija ispod
-- (cloud snapshot 13.07 kroz Management API) potvrđuje da `authenticated` ima
-- SELECT na svih ~28 CRUD tabela + 14 kanonskih view-ova + osnovne tabele view-ova.
--
-- JEDINI R0 DB korak = članstvo (kao Talas B; verovatno već primenjeno). Primena:
-- glavna sesija, na ŽIVOJ sy15, ISKLJUČIVO kao `supabase_admin` (doktrina §A.6 —
-- sy15 `postgres` nije superuser; grant kao postgres = tihi no-op uz WARNING).
--
-- STORAGE (bez grant-a): bucket `employee-docs` (private, 4 op = can_manage_pii)
-- ide kroz sy15 storage-api presigned sa SY15_SERVICE_KEY (Reversi/Talas F obrazac,
-- §2.3 storage-proxy) — R2; RLS na storage.objects netaknut.
--
-- NE DIRA SE (pozadina, grant SAMO service_role — spec §0.2): hr-notify-dispatch,
-- kiosk-punch, assessment-invite, push-dispatch (edge); kadr_dispatch_dequeue/
-- mark_sent/mark_failed, kadr_pulse_notify_dispatch, kadr_schedule_* (pg_cron ×9);
-- syncKatze (bridge). 2.0 NE duplira slanje; queue-okidači (kadr_queue_*) su DEFINER
-- i jedini legalni upis u kadr_notification_log (INSERT deny za klijente) — R2 poziva
-- ih kroz GUC.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'servosync2_app') then
    raise notice 'rola servosync2_app ne postoji — preskočeno (uspostaviti pre R0)';
    return;
  end if;

  -- Članstvo = most za SET LOCAL ROLE authenticated (Sy15Service.withUserRls).
  -- Bez ovoga SET ROLE pada sa 42501 i SVI Kadrovska endpointi vraćaju 403.
  -- (Talas B je isto tražio; ako je već primenjen — no-op.)
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
    raise notice 'servosync2_app je već član authenticated — no-op';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- R0 VERIFIKACIJA (READ) — pokrenuti na ŽIVOJ sy15 kao supabase_admin i uporediti
-- sa cloud snapshotom. Očekivano: has_table_privilege('authenticated', obj, 'SELECT')
-- = true za sve dole. Cloud snapshot (13.07) je već potvrdio true za sve OSIM 2 rupe
-- (ispod). RE-VERIFIKOVATI na sy15 (cloud je samo polazna tačka — doktrina A5).
-- ----------------------------------------------------------------------------
-- SELECT o.name,
--        to_regclass('public.'||o.name) IS NOT NULL AS exists,
--        has_table_privilege('authenticated','public.'||o.name,'SELECT') AS auth_sel
-- FROM (VALUES
--   -- Jezgro + Zaposleni (PII)
--   ('employees'),('contracts'),('employee_children'),('employee_bank_cards'),
--   ('employee_foreign_docs'),('employee_personal_docs'),('employee_documents'),
--   ('kadr_certificates'),('kadr_medical_exams'),('employee_badges'),
--   -- Odmori
--   ('vacation_requests'),('vacation_entitlements'),('vacation_history'),
--   ('vacation_bonus_days'),('absences'),('makeup_requests'),('paid_leave_requests'),('nop_requests'),
--   -- Sati
--   ('work_hours'),('work_hours_remarks'),('attendance_events'),
--   ('attendance_corrections'),('attendance_notify_extra'),
--   -- Zarade
--   ('salary_terms'),('salary_payroll'),
--   -- Razvoj / 360 / razgovori
--   ('assessments'),('assessment_cycles'),('assessment_raters'),('assessment_scores'),
--   ('assessment_answers'),('assessment_targets'),('assessment_results'),
--   ('development_plans'),('development_checkins'),('employee_expectations'),
--   ('employee_talks'),('corrective_plans'),('corrective_measures'),
--   -- Uvođenje + Sistem
--   ('kadr_onboarding_runs'),('kadr_onboarding_tasks'),('kadr_onboarding_templates'),
--   ('kadr_onboarding_template_items'),('kadr_notification_log'),('kadr_notification_config'),
--   ('kadr_audit_log'),('kadr_document_ack'),('kadr_holidays'),('device_push_tokens'),
--   ('kadr_grid_editor_allowlist'),('kadr_vacation_editor_allowlist'),
--   -- 14 kanonskih view-ova
--   ('v_employees_safe'),('v_vacation_balance'),('v_attendance_now'),('v_attendance_daily'),
--   ('v_attendance_shadow_monthly'),('v_attendance_vs_grid'),('v_salary_payroll_month'),
--   ('v_employee_current_salary'),('v_development_plans'),('v_employee_expectations'),
--   ('v_assessment_scope'),('v_kadr_audit_log'),('v_kadr_certificate_status'),('v_kadr_medical_exam_status'),
--   -- Deljeno sa D (G čita, D poseduje ekran) — grants moraju pokriti SELECT
--   ('departments'),('sub_departments'),('job_positions'),('company_profile'),('user_roles')
-- ) AS o(name) ORDER BY o.name;

-- ============================================================================
-- POPIS RUPA / DRIFT (cloud snapshot 13.07 — RE-VERIFIKOVATI na sy15):
-- ----------------------------------------------------------------------------
-- [1] kadr_vacation_editor_allowlist — has_table_privilege('authenticated', ...,
--     'SELECT') = FALSE (RLS OFF, lookup tabela; §1.1). G R1 je NE čita direktno —
--     saldo-editor pravo dolazi kroz `can_edit_vacation_balance()` (DEFINER helper,
--     radi bez SELECT-a). NIJE rupa za G. ⚠️ ALI ako Talas D doda „Urednici salda GO"
--     ekran koji LISTA tabelu pod authenticated → treba:
--        GRANT SELECT ON public.kadr_vacation_editor_allowlist TO authenticated;
--     (paran sa kadr_grid_editor_allowlist koji VEĆ ima SELECT=true). Odluka: Talas D.
--
-- [2] worker_employee_map — NE POSTOJI u cloud snapshotu (information_schema = 0).
--     G4 drift: most `employees`↔2.0 radnici živi na SELF-HOST sy15 (ubuntusrv), ne
--     na cloud restore-izvoru. R0 RE-VERIFIKACIJA na sy15 OBAVEZNA. G ga NE koristi
--     u R1 read — `employees` je izvor istine; ako Reversi/2.0 već drži most, G ga NE
--     duplira. Ako fali i na sy15 → van G obima (2.0-side tabela).
--
-- [3] development_plan_checkins → stvarno ime je `development_checkins` (spec §1.1
--     nabraja „development_plans (+_checkins)"; kolone: id/plan_id/employee_id/
--     checkin_date/author_email/author_kind/note_md/created_at). Prisma model
--     `DevelopmentCheckin` @@map("development_checkins"). Nema rupe.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- R2 (NE u R0 read fazi — dokumentovano radi potpunosti):
--  - EXECUTE na ~60 front RPC (hr_*/kadr_*/attendance_*/assessment_*/talk_*/makeup/
--    paid_leave/nop): `authenticated` ih VEĆ ima (1.0 front ih zove kroz PostgREST) →
--    SET ROLE authenticated ih nasleđuje. Mutacije idu kroz withUserRls/runIdempotentRls.
--  - Storage `employee-docs`: BE storage-proxy sa SY15_SERVICE_KEY (bez SQL grant-a).
--  - kadr_queue_* (DEFINER, jedini legalni upis u kadr_notification_log): R2 kroz GUC.
-- ----------------------------------------------------------------------------

notify pgrst, 'reload schema';

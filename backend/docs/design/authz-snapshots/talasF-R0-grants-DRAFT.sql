-- ============================================================================
-- TALAS F — Održavanje (CMMS): R0 GRANTS DRAFT (read sloj)
-- Nacrt: 2026-07-13 · MODULE_SPEC_odrzavanje_30.md §6 (R0) + MIGRACIONA_DOKTRINA_3.0 §A.2a/§A.6
-- ============================================================================
-- MODEL PRISTUPA (doktrina A.2a — dokazano Talasom B): 2.0 BE se konektuje kao
-- `servosync2_app` (rolbypassrls = TRUE), a SVAKI read/mutacija ide kroz
-- `Sy15Service.withUserRls` = GUC claims (sub+email) + `SET LOCAL ROLE authenticated`
-- u ISTOJ transakciji. Zato SVE table/fn/view privilegije za CMMS moraju stajati na
-- roli `authenticated` (ne na `servosync2_app`) — identično kao 1.0 PostgREST.
--
-- PREDUSLOV (Talas B R0, VEĆ PRIMENJEN — bez njega `SET LOCAL ROLE authenticated` pada 42501):
--     GRANT authenticated TO servosync2_app;
-- Talas F NE traži nov membership grant.
--
-- ⚠️ NIKAD ssh (doktrina §A.6, fail2ban). Verifikacija ide Management API-jem
--    (1.0 repo `node scripts/sb-exec-sql.mjs --sql "..."`, read-only SELECT).
-- ⚠️ Snapshot izvor = ZAMRZNUTI cloud (restore-izvor sy15). Doktrina A5: RE-VERIFIKOVATI
--    na živoj sy15 pre R1 deploy-a. Dole su rezultati sa restore-izvora (2026-07-13).
-- ============================================================================


-- ── 1. VERIFIKACIJA: SELECT za `authenticated` na svim maint tabelama i view-ovima ──────────
-- Sve security_invoker view-ove (v_maint_*) čita `authenticated` I preko njih se čitaju
-- OSNOVNE maint tabele (doktrina A.6) — pa je potreban SELECT na oba sloja.
--
-- select json_agg(json_build_object('name',relname,'kind',relkind,
--   'auth_select',has_table_privilege('authenticated', oid, 'SELECT')) order by relkind, relname)
-- from pg_class c join pg_namespace n on n.oid=c.relnamespace
-- where n.nspname='public' and (c.relname like 'maint\_%' or c.relname like 'v_maint\_%')
--   and c.relkind in ('r','v');
--
-- REZULTAT (2026-07-13, restore-izvor): auth_select = TRUE za SVIH 34 tabela + 16 view-ova.
--   → RUPA: 0. Read grantovi za CMMS su NASLEĐENI (Supabase default GRANT ... TO authenticated).
--   → v_maint_* (security_invoker) rade jer authenticated ima SELECT i na osnovnim maint tabelama.


-- ── 2. VERIFIKACIJA: EXECUTE za `authenticated` na helper + front RPC funkcijama ────────────
-- /maintenance/me poziva helper fn direktno; RLS politike ih pozivaju implicitno — u OBA
-- slučaja `authenticated` mora imati EXECUTE (SECURITY DEFINER ne oslobađa EXECUTE na pozivaocu).
--
-- select json_agg(json_build_object('fn',proname,'auth_exec',
--   has_function_privilege('authenticated',oid,'EXECUTE')) order by proname)
-- from pg_proc p join pg_namespace n on n.oid=p.pronamespace
-- where n.nspname='public' and (proname like 'maint\_%' or proname in
--   ('create_maint_vehicle','create_maint_it_asset','create_maint_facility',
--    'archive_maint_vehicle','archive_maint_asset','restore_maint_vehicle','restore_maint_asset',
--    'ensure_vehicle_service_wos','ensure_asset_service_wos'));
--
-- REZULTAT (2026-07-13): auth_exec = TRUE za sve proverene (helperi:
--   maint_profile_role, maint_has_floor_read_access, maint_is_erp_admin,
--   maint_is_erp_admin_or_management, maint_assignable_users; + svih 16(+1) front RPC).
--   → RUPA: 0. EXECUTE je NASLEĐEN.


-- ── 3. VERIFIKACIJA: cross-module SELECT (spec §1 „Cross-module čitanja") ────────────────────
-- select has_table_privilege('authenticated','public.bigtehn_machines_cache','SELECT') as bigtehn,
--        has_table_privilege('authenticated','public.employees','SELECT') as employees,
--        has_table_privilege('authenticated','public.user_roles','SELECT') as user_roles;
--
-- REZULTAT (2026-07-13): bigtehn = TRUE, employees = TRUE, user_roles = TRUE.
--   → RUPA: 0. (user_roles čitaju helperi po email-u; bigtehn/importable view; employees best-effort.)


-- ============================================================================
-- ZAKLJUČAK R0 (READ sloj):  ✅ 0 RUPA — nijedan nov GRANT nije potreban za R1.
-- Sve SELECT (tabele+view-ovi), EXECUTE (helper+RPC), cross-module SELECT već postoje
-- na roli `authenticated`. R1 read radi „po nasleđu".
--
-- Ako se posle re-verifikacije na ŽIVOJ sy15 (doktrina A5) pojavi rupa, primeni je
-- ISKLJUČIVO kao `supabase_admin` (sy15 `postgres` NIJE superuser — doktrina A6):
--     -- primer (SAMO ako živa sy15 pokaže FALSE negde):
--     -- GRANT SELECT ON public.maint_<tabela> TO authenticated;
--     -- GRANT EXECUTE ON FUNCTION public.<fn>(<args>) TO authenticated;
-- Po grantu: NOTIFY pgrst, 'reload schema';  (osvežava PostgREST cache — paralelni 1.0 rad)
-- ============================================================================


-- ── R2 TODO (NE deo R1 — write paritet) ─────────────────────────────────────────────────────
-- Za R2 verifikovati (isti obrazac) za `authenticated`:
--   • INSERT/UPDATE/DELETE na maint tabelama po §2 politikama (write kroz withUserRls);
--     deny-all tabele (maint_wo_number_counter; maint_machines_deletion_log I/U/D=false;
--     maint_notification_log INSERT=false) OSTAJU bez DML granta — upis samo kroz DEFINER RPC/trigger.
--   • Storage RLS bucket `maint-machine-files` (SELECT preko maint_has_floor_read_access;
--     INSERT/UPDATE/DELETE po §2.3) — BE storage-proxy koristi SERVICE kredencijal (spec §7.4),
--     pa authenticated grant NIJE nužan za sam storage, ali meta-red RLS proveru radi BE kroz withUserRls.
--   • EXECUTE na maint_attach_incident_files (foto tok #43) — VEĆ TRUE (verifikovano gore).
-- Napomena: dispatch pipeline (maint_dispatch_dequeue/mark_sent/mark_failed) NE POSTOJI na
--   živoj bazi (spec §2.6, §7.1) — NE grant-uje se; oživljavanje = zaseban post-seoba zadatak.

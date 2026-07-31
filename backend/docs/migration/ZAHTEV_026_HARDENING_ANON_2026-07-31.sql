-- =============================================================================
-- sy15 hardening — anonimni pristup kroz javni PostgREST (primenjeno 31.07.2026)
--
-- KONTEKST: sy15 REST (https://api.servosync.servoteh.com/rest/v1/...) odgovara na
-- zahteve BEZ ijednog zaglavlja pod rolom `anon`. Zato svaki objekat koji ima GRANT
-- za `anon` i NEMA RLS efektivno stoji otvoren ka internetu. Nađeno u adversarial
-- review-u isporuke 31.07 (batch 045–049/26 + 026/26).
--
-- OVAJ FAJL JE VEĆ PRIMENJEN NA ŽIVOJ sy15 BAZI 31.07.2026 (supabase_admin).
-- Idempotentan je — ponovno pokretanje ne menja ništa. Čuva se radi traga i
-- radi obnove posle eventualnog restore-a baze iz starijeg snapshot-a.
--
-- Provera pre/posle (očekivano POSLE: svuda 401):
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     'https://api.servosync.servoteh.com/rest/v1/vacreq_fn_defs_backup_026?select=id&limit=1'
--   curl -s -o /dev/null -w '%{http_code}\n' \
--     'https://api.servosync.servoteh.com/rest/v1/kadr_vacation_editor_allowlist?select=*&limit=1'
--   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
--     -d '{"p_change_id":"11111111-1111-1111-1111-111111111111","p_event":"submitted"}' \
--     'https://api.servosync.servoteh.com/rest/v1/rpc/kadr_queue_vacreq_change_notification'
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) Objekti uvedeni zahtevom 026/26 — ZAHTEV_026_GO_IZMENA_OTKAZ.sql je radio
--    REVOKE samo nad `authenticated`, a Supabase default privilegije daju `anon`
--    sve. Posledica: backup tabela je bila javno čitljiva I brisiva, a queue
--    funkcija javno pozivna (SECURITY DEFINER, šalje mejlove).
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE public.vacreq_fn_defs_backup_026 FROM anon;
ALTER TABLE public.vacreq_fn_defs_backup_026 ENABLE ROW LEVEL SECURITY;
-- Bez ijedne politike = deny-all za anon/authenticated; SECURITY DEFINER fn i
-- vlasnik (supabase_admin) rade nesmetano, pa je rollback i dalje moguć.

REVOKE ALL ON TABLE public.vacation_change_requests FROM anon;

REVOKE EXECUTE ON FUNCTION public.kadr_queue_vacreq_change_notification(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.kadr_vacreq_change_submit(uuid, text, date, date, integer, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.kadr_vacreq_change_decide(uuid, boolean, text, text) FROM anon;
-- Ostaje: submit/decide → authenticated + service_role; queue → SAMO service_role
-- (interno je zovu definer funkcije).

-- -----------------------------------------------------------------------------
-- 2) ZATEČENA RUPA (nije iz ove isporuke, nađena usput): kadr_vacation_editor_allowlist
--    je bila BEZ RLS-a i sa punim grantovima za `anon` → anonimni zahtev sa interneta
--    je vraćao redove, a po grantovima je mogao i INSERT/DELETE. Ta lista je izvor
--    istine za pravo `kadrovska.vacation_edit` (korekcija GO salda), pa je upis u nju
--    bio put ka eskalaciji privilegija, a brisanje ka gubitku prava Nenadu/Neveni.
--
--    Sestrinska kadr_grid_editor_allowlist ima ispravan obrazac (RLS + 4 politike);
--    ovde se preslikava 1:1. Napomena: aplikacija članstvo čita kroz SECURITY DEFINER
--    fn `can_edit_vacation_balance()` (auth.controller.ts reconcileAllowlistMirror),
--    a `backfillAllowlistOverrides` čita tabelu pod rolom authenticated — zato
--    SELECT politika za authenticated ostaje `true`.
-- -----------------------------------------------------------------------------

REVOKE ALL ON TABLE public.kadr_vacation_editor_allowlist FROM anon;
ALTER TABLE public.kadr_vacation_editor_allowlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kadr_vacation_editor_allowlist_select ON public.kadr_vacation_editor_allowlist;
DROP POLICY IF EXISTS kadr_vacation_editor_allowlist_insert ON public.kadr_vacation_editor_allowlist;
DROP POLICY IF EXISTS kadr_vacation_editor_allowlist_update ON public.kadr_vacation_editor_allowlist;
DROP POLICY IF EXISTS kadr_vacation_editor_allowlist_delete ON public.kadr_vacation_editor_allowlist;

CREATE POLICY kadr_vacation_editor_allowlist_select ON public.kadr_vacation_editor_allowlist
  FOR SELECT TO authenticated USING (true);
CREATE POLICY kadr_vacation_editor_allowlist_insert ON public.kadr_vacation_editor_allowlist
  FOR INSERT TO authenticated WITH CHECK (current_user_is_admin());
CREATE POLICY kadr_vacation_editor_allowlist_update ON public.kadr_vacation_editor_allowlist
  FOR UPDATE TO authenticated USING (current_user_is_admin()) WITH CHECK (current_user_is_admin());
CREATE POLICY kadr_vacation_editor_allowlist_delete ON public.kadr_vacation_editor_allowlist
  FOR DELETE TO authenticated USING (current_user_is_admin());

COMMIT;

-- =============================================================================
-- PROVERE POSLE PRIMENE (izvršene 31.07.2026, sve zeleno)
--
--   -- 1. anon više ne prolazi (tri curl-a iz zaglavlja → 401, 401, 401)
--
--   -- 2. pravo korekcije GO salda i dalje radi za onoga ko je na listi:
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     SET LOCAL request.jwt.claims = '{"email":"nenad.jarakovic@servoteh.com","role":"authenticated"}';
--     SELECT can_edit_vacation_balance();          -- t
--     SELECT count(*) FROM kadr_vacation_editor_allowlist;  -- 4 (backfill čita)
--   ROLLBACK;
--
--   -- 3. ko nije na listi i dalje nema pravo:
--   BEGIN;
--     SET LOCAL ROLE authenticated;
--     SET LOCAL request.jwt.claims = '{"email":"strahinja.petrovic@servoteh.com","role":"authenticated"}';
--     SELECT can_edit_vacation_balance();          -- f
--   ROLLBACK;
--
-- =============================================================================
-- 3) SISTEMSKI PREGLED (isti dan, posle gornjeg) — ista klasa greške, širi obim.
--    Pretraga cele sy15 `public` šeme dala je još dva sloja izloženosti; oba su
--    ZATEČENA (nisu iz isporuke 31.07) i oba su zatvorena istog dana.
--
-- 3a) POGLEDI BEZ security_invoker SA GRANTOM ZA anon (24 komada)
--     Pogled bez `security_invoker=true` izvršava se sa pravima VLASNIKA, pa
--     zaobilazi RLS matičnih tabela. Anonimni zahtev je vraćao stvarne podatke:
--       v_kadr_medical_exam_status  → 153 reda (ime i prezime + status lekarskog)
--       v_kadr_audit_log            → 1000+ redova HR audit traga (mejlovi aktera)
--       v_settings_audit_log        → 227 redova
--       information_schema_*_v      → kompletna šema baze
--       v_rev_machines / v_rev_*    → 87 / 47 redova
--     Mera: REVOKE ALL ... FROM anon na svih 24 (authenticated ostaje netaknut).
-- -----------------------------------------------------------------------------
REVOKE ALL ON
  public.audit_foreign_keys_v, public.audit_indexes_v, public.audit_policies_v,
  public.audit_routines_security_v, public.audit_table_grants_v, public.audit_table_sizes_v,
  public.audit_tables_rls_v, public.audit_tables_without_pk_v,
  public.information_schema_columns_v, public.information_schema_routines_v,
  public.information_schema_tables_v, public.loc_location_hierarchy_issues,
  public.v_kadr_audit_log, public.v_kadr_certificate_status, public.v_kadr_medical_exam_status,
  public.v_loc_tp_operation_slots, public.v_rev_inventory_with_groups, public.v_rev_machines,
  public.v_rev_my_consumed, public.v_rev_otpisani_alat, public.v_rev_tool_availability,
  public.v_rev_tool_service_summary, public.v_settings_audit_log, public.v_vacation_balance
FROM anon;

-- -----------------------------------------------------------------------------
-- 3b) SECURITY DEFINER FUNKCIJE KOJE MENJAJU PODATKE, BEZ INTERNE PROVERE POZIVAOCA
--     (67 komada; statička analiza: telo ne pominje auth.uid()/auth.jwt()/
--     current_user_is_*/request.jwt itd.). Dokaz dosega bez izvršenja: anon POST na
--     /rest/v1/rpc/kadr_grid_set_go sa neispravnim UUID-om vraćao je 400
--     „invalid input syntax for type uuid" — dakle poziv je STIGAO do funkcije i
--     zaustavila ga je tek provera tipa, a ne autorizacija. Sa ispravnim argumentima
--     bilo ko sa interneta mogao je da upiše GO/bolovanje bilo kom zaposlenom,
--     isprazni redove za slanje mejlova ili menja napredak zadataka.
--
--     Mera: opoziv EXECUTE za anon; kod dela funkcija pravo je stizalo preko PUBLIC
--     (ACL red „=X/…") pa je opoziv nad anon bio bez efekta — otud dva prolaza.
--     authenticated i service_role imaju EKSPLICITNE grantove i zadržavaju pravo.
--
--     NAMERNO IZUZETE (anonimne su po dizajnu, uz sopstveni token):
--       kiosk_record_punch(text,text)                  — kiosk u pogonu
--       assessment_submit_by_token(text,jsonb,jsonb)   — 360 ocenjivanje preko linka
-- -----------------------------------------------------------------------------
DO $$
DECLARE r record; n1 int := 0; n2 int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
       AND p.proname NOT LIKE '\_%'
       AND pg_get_function_result(p.oid) <> 'trigger'
       AND p.prosrc ~* '\m(insert|update|delete|truncate)\M'
       AND NOT (p.prosrc ~* 'auth\.(uid|jwt|email)|current_user_is_|can_edit_|can_manage_|request\.jwt|current_setting\(''request|is_admin|has_role|current_user_can')
       AND p.proname NOT IN ('kiosk_record_punch', 'assessment_submit_by_token')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);   n1 := n1 + 1;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM public', r.sig); n2 := n2 + 1;
  END LOOP;
  RAISE NOTICE 'Opozvano: anon=% , public=%', n1, n2;
END $$;

-- =============================================================================
-- PROVERE POSLE PRIMENE (izvršene 31.07.2026)
--   anon → 401 na: vacreq_fn_defs_backup_026, vacation_change_requests,
--          kadr_vacation_editor_allowlist, svih 24 pogleda, rpc/kadr_grid_set_go
--          („permission denied for function")
--   kiosk i dalje radi: anon POST rpc/kiosk_record_punch → 200 {"ok":false,"error":"nepoznat_qr"}
--   prijavljen korisnik netaknut: v_kadr_medical_exam_status 153 / v_rev_machines 87 /
--          v_vacation_balance 157 redova pod SET LOCAL ROLE authenticated
--   backend log: 0 pojava „permission denied"/42501 posle izmena
--   post-deploy-verify.sh: 🟢 EXIT 0 (web + LAN + boot)
--
-- OSTAJE OTVORENO (traži odluku, NIJE urađeno):
--   • 86 SECURITY DEFINER funkcija koje SAMO ČITAJU a nemaju internu proveru pozivaoca
--     i dalje su anon-izvršive — svaku treba pojedinačno proceniti (neke su bezopasne
--     lookup funkcije, neke mogu curiti podatke).
--   • Uzrok je sistemski: Supabase podrazumevano daje anon/PUBLIC prava na SVAKI nov
--     objekat. Preporuka: `ALTER DEFAULT PRIVILEGES ... REVOKE ... FROM anon, PUBLIC`
--     + nedeljna provera koja prijavi (a) tabele bez RLS-a sa anon grantom,
--     (b) poglede bez security_invoker sa anon grantom, (c) definer funkcije bez
--     provere pozivaoca. Bez toga se rupa vraća sa sledećom migracijom.
-- =============================================================================

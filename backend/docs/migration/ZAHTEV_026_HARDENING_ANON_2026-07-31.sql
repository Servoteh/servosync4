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
-- PREPORUKA ZA DALJE (nije u ovom fajlu, traži odluku):
--   Sistemski pregled — svaka tabela u `public` bez RLS-a a sa grantom za `anon` je
--   javno dostupna. Na dan 31.07. takvih je bilo dve (obe zatvorene gore), ali svaka
--   nova tabela nasleđuje Supabase default grantove za anon, pa vredi uvesti stalnu
--   proveru (npr. nedeljni upit koji prijavi RLS-off + anon-grant tabele).
-- =============================================================================

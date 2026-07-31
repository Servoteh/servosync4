-- =============================================================================
-- sy15 hardening — TALAS 2 (primenjeno 31.07.2026, posle ZAHTEV_026_HARDENING_ANON)
--
-- Talas 1 je zatvorio ono što je AKTIVNO curilo (tabele bez RLS-a, 24 pogleda,
-- 67 funkcija koje menjaju podatke). Talas 2 zatvara ostatak i, važnije,
-- postavlja BRANU da se rupa ne vraća sa svakom novom migracijom.
--
-- Sve je VEĆ PRIMENJENO na živoj sy15 bazi. Fajl je trag i recept za obnovu.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) BRANA — zašto podrazumevana prava NISU dovoljna
--
-- Prvo je pokušano čisto rešenje (ALTER DEFAULT PRIVILEGES). Ono radi za TABELE,
-- ali NE i za funkcije: PostgreSQL ugrađeno pravilo svakoj novoj funkciji daje
-- EXECUTE roli PUBLIC, i to se `ALTER DEFAULT PRIVILEGES ... REVOKE ... FROM PUBLIC`
-- ovde NE poništava — izmereno na živoj bazi: nova funkcija je i dalje dobijala
-- ACL `=X/supabase_admin` (PUBLIC), a PUBLIC obuhvata `anon`.
-- Zato brana stoji na dva nivoa: podrazumevana prava (tabele/sekvence) + event
-- trigger (funkcije, pogledi, tabele — pojas i tregeri).
-- -----------------------------------------------------------------------------

ALTER DEFAULT PRIVILEGES FOR ROLE postgres       IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres       IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres       IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;

-- Event trigger: novom objektu u `public` odmah skida anon/PUBLIC.
-- NAMERNI IZUZECI (anonimni po dizajnu, uz sopstveni token) — ne diraju se:
--   kiosk_record_punch (kiosk u pogonu), assessment_submit_by_token (360 preko linka)
-- ⚠️ POSLEDICA ZA BUDUĆI RAZVOJ: ako neki nov tok MORA raditi bez prijave
--    (npr. „Zaboravljena lozinka" koja je u izradi na grani feat/scada-u-monorepo),
--    posle kreiranja funkcije treba EKSPLICITNO `GRANT EXECUTE ... TO anon`.
--    Okidač radi samo na CREATE i ne gazi kasnije dodeljena prava.
CREATE OR REPLACE FUNCTION public.sec_guard_revoke_anon()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT object_identity, object_type, schema_name
      FROM pg_event_trigger_ddl_commands()
     WHERE schema_name = 'public'
       AND object_type IN ('function','table','view','materialized view','sequence')
  LOOP
    BEGIN
      IF r.object_type = 'function' THEN
        IF split_part(r.object_identity, '(', 1) IN
           ('public.kiosk_record_punch','public.assessment_submit_by_token') THEN
          CONTINUE;
        END IF;
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', r.object_identity);
      ELSE
        EXECUTE format('REVOKE ALL ON %s FROM anon', r.object_identity);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Brana NIKAD ne sme da obori migraciju — samo upozori.
      RAISE WARNING 'sec_guard_revoke_anon: % (%) preskočen: %', r.object_identity, r.object_type, SQLERRM;
    END;
  END LOOP;
END
$fn$;

DROP EVENT TRIGGER IF EXISTS sec_guard_revoke_anon;
CREATE EVENT TRIGGER sec_guard_revoke_anon ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION','CREATE TABLE','CREATE TABLE AS','CREATE VIEW','CREATE MATERIALIZED VIEW','CREATE SEQUENCE')
  EXECUTE FUNCTION public.sec_guard_revoke_anon();

-- Dokaz da brana radi (izvršeno u transakciji pa poništeno):
--   create table _t(id int); create function _f() returns int language sql as 'select 1';
--   create view _v as select 1;
--   → anon: tabela f, pogled f, funkcija f;  authenticated i servosync2_app: sve t.

-- -----------------------------------------------------------------------------
-- 2) 67 SECURITY DEFINER funkcija koje SAMO ČITAJU a nemaju proveru pozivaoca
--
-- Svaka je pojedinačno pročitana i klasifikovana (4 nezavisne procene + skeptik).
-- Od 68 kandidata, 67 je oduzeto; ostaje SAMO `assessment_token_context(text)` —
-- deo anonimnog 360 toka preko linka, uz token.
--
-- Šta je STVARNO curilo anonimno (nije teorija — funkcije bez ijedne provere):
--   ai_chat_opis_pozicije        → svih 78 radnih mesta + `reports_to_line`, tj. cela
--                                  organizaciona šema + pun opis posla (odgovornosti, ovlašćenja, KPI)
--   loc_sync_admin_emails        → e-mail adrese svih admina i menadžmenta (24 adrese)
--   pb_get_mechanical_projecting_engineers → ime + službeni e-mail inženjera projektovanja
--   pb_list_projects             → šifre i nazivi aktivnih projekata
--   ai_chat_masina_info          → „osnovni karton" mašine (proizvođač, model, lokacija) —
--                                  fallback grana je namerno vraćala podatke i kad provera padne
--   attendance_extra_recipients  → poslovne adrese za obaveštenja o prisustvu
--   get_team_issued_tools        → zaduženi alat po članovima tima (serijski brojevi)
--
-- Ostale su bile zaštićene internom proverom pa nisu curile, ali anonimni pristup
-- im nije trebao — princip je „zabranjeno dok se ne dokaže da treba".
-- Napomena: opoziv ide i nad PUBLIC, jer je delu funkcija pravo stizalo tim putem.
-- Spisak imena je u istoriji ove izmene (67 imena, prevelik za komentar).

-- -----------------------------------------------------------------------------
-- 3) Osetljive tabele — dodatni sloj uz RLS
--
-- RLS je već odbijao anon, ali `anon` je i dalje imao GRANT SELECT. Posle opoziva
-- EXECUTE-a nad RLS predikat-funkcijama, anon upit nad tim tabelama bi ionako pao
-- greškom — čistije je da uopšte nema pravo. Oduzeto na 21 tabeli:
--   salary_payroll, salary_terms, employee_bank_cards, employee_personal_docs,
--   employee_foreign_docs, employee_documents, employees, user_roles, contracts,
--   vacation_requests, vacation_change_requests, absences, employee_talks,
--   development_plans, assessments, assessment_scores, assessment_answers,
--   assessment_raters, audit_log, kadr_notification_log, attendance_events, employee_badges
-- (Iz spiska su primenjene one koje su grant zaista imale.)

-- =============================================================================
-- PROVERE POSLE PRIMENE (31.07.2026, sve zeleno)
--   anon → 401: ai_chat_opis_pozicije, loc_sync_admin_emails, pb_list_projects,
--                get_sastanci_user_directory, ai_chat_masina_info,
--                employees, user_roles, salary_payroll, employee_personal_docs, audit_log
--   namerni anonimni tokovi i dalje rade:
--     rpc/kiosk_record_punch        → 200 {"ok":false,"error":"nepoznat_qr"}
--     rpc/assessment_token_context  → 200 {"ok":false,"error":"Neispravan link."}
--   backend log: 0 pojava „permission denied"/42501
--   post-deploy-verify.sh: 🟢 EXIT 0
--
-- OSTAJE ZA ODLUKU (nije urađeno):
--   • `anon` i dalje ima GRANT SELECT na ~180 ostalih tabela u `public`. Sve su pod
--     RLS-om i vraćaju 0 redova, pa nije curenje — ali „deny by default" bi značio
--     oduzeti i to. Nije urađeno da se pred kraj dana ne dira 180 objekata odjednom.
--   • `assessment_token_context` ostaje anon: proveriti kojim ključem radi edge funkcija
--     `ocena.html?token=` — ako koristi service_role, i ovaj izuzetak može da padne.
-- =============================================================================

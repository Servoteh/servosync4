-- ============================================================================
-- App rola bez superuser prava (DB audit DB-051) — glavna 3.0/4.0 baza
-- ============================================================================
-- PROBLEM: backend se kačio kao `servosync` = SUPERUSER klastera. SQLi ili RCE u
-- aplikaciji tada ne daje „pristup podacima" nego CEO server baze (COPY FROM
-- PROGRAM, čitanje fajlova, gašenje baze, zaobilaženje svih grantova).
--
-- REŠENJE: `servosync_app` = obična rola sa DML pravima nad `public` + jedini
-- superuser-parametar koji sync stvarno treba (session_replication_role).
-- Vlasnik šeme i DDL ostaju kod `servosync` — migracije (`prisma migrate deploy`)
-- se izvršavaju ODVOJENIM URL-om (MIGRATE_DATABASE_URL u backend.env; deploy
-- workflow ga koristi, uz fallback na DATABASE_URL radi kompatibilnosti).
--
-- IZVRŠAVA SE: jednom po bazi, kao vlasnik (`servosync`):
--   docker exec -i servosync-pg psql -U servosync -d servosync -v app_pass='<LOZINKA>' \
--     < backend/scripts/db-app-role.sql
-- (lozinka BEZ navodnika — skripta je sama kvotira preko format %L; skripta ne
--  sadrži nijednu tajnu, pa sme u git.)
--
-- ⚠️ ALTER DEFAULT PRIVILEGES je OBAVEZAN deo: bez njega tabela koju napravi
-- SLEDEĆA migracija ne bi imala grantove i aplikacija bi je videla kao
-- „permission denied" tek u produkciji.
-- ============================================================================

-- 1) Rola (bez SUPERUSER/CREATEDB/CREATEROLE; samo LOGIN).
--    \gexec jer psql varijabla ne može u DO $$ blok (ne interpolira se unutar
--    dollar-quote-a); format %L kvotira lozinku bezbedno.
SELECT format('CREATE ROLE servosync_app LOGIN PASSWORD %L', :'app_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'servosync_app')
\gexec

SELECT format('ALTER ROLE servosync_app LOGIN PASSWORD %L', :'app_pass')
\gexec

ALTER ROLE servosync_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- 2) Pristup bazi i šemi (USAGE, ne CREATE — app ne pravi objekte)
GRANT CONNECT ON DATABASE servosync TO servosync_app;
GRANT USAGE ON SCHEMA public TO servosync_app;
REVOKE CREATE ON SCHEMA public FROM servosync_app;

-- 3) DML nad postojećim tabelama + sekvence (autoincrement id-evi)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO servosync_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO servosync_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO servosync_app;

-- 4) Buduće tabele (kreira ih vlasnik kroz migracije) — bez ovoga app ne vidi
--    ništa novo posle sledeće migracije.
ALTER DEFAULT PRIVILEGES FOR ROLE servosync GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO servosync_app;
ALTER DEFAULT PRIVILEGES FOR ROLE servosync GRANT USAGE, SELECT ON SEQUENCES TO servosync_app;
ALTER DEFAULT PRIVILEGES FOR ROLE servosync GRANT EXECUTE ON FUNCTIONS TO servosync_app;

-- 5) Jedini superuser-parametar koji sync koristi: generic.syncer.ts radi
--    `SET LOCAL session_replication_role = 'replica'` (gasi FK/trigere pri
--    punjenju keša). PG15+ ume da ga dodeli pojedinačno — bez GRANT-a bi sync
--    padao na "permission denied to set parameter".
GRANT SET ON PARAMETER session_replication_role TO servosync_app;

-- 6) Provera (očekivano: rolsuper=f, rolbypassrls=f)
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
FROM pg_roles WHERE rolname = 'servosync_app';

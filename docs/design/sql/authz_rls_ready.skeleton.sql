-- =============================================================================
-- authz_rls_ready.skeleton.sql — SKELET (NE primenjuje se ručno)
-- =============================================================================
-- Cilj: postaviti "RLS-ready" temelje da uključivanje pravog PostgreSQL RLS-a u
-- ServoSync 3.0 bude KONFIGURACIJA (flip-a-switch), a ne redizajn autorizacije.
-- Odluka: guards + RLS-ready SADA; nativni RLS TEK 3.0 (BACKEND_RULES §11.4 / ODLUKE.md).
--
-- KAKO SE PRIMENJUJE (NE ručno, da se ne naruši Prisma istorija):
--   1) DDL tabela/kolona (§A) ide kroz `prisma/schema.prisma` + `npm run migrate:dev`
--      (Prisma generiše zvaničnu migraciju). Blok §A ovde je REFERENCA ekvivalentnog SQL-a.
--   2) SQL funkcije i GUC (§B, §C) idu kao RAW SQL unutar te iste Prisma migracije
--      (Prisma migracije su običan .sql — dodaj ove blokove u generisani migration.sql).
--   3) §D (runtime rola + FORCE RLS + CREATE POLICY) se NE radi u 2.0 — to je 3.0 korak;
--      ostavljeno zakomentarisano kao dokaz da temelji rade.
--
-- Konvencija: role = lowercase snake_case (BACKEND_RULES §2.2, odluka 2026-07-08).
-- =============================================================================


-- =====================================================================
-- §A  DDL — tabele i kolone (kroz Prisma schema.prisma; ovo je referenca)
-- =====================================================================

-- A.1  Dodela uloga (app-owned). Nadskup 1.0 user_roles: + managed_sub_department_ids[].
CREATE TABLE IF NOT EXISTS user_roles (
  id                          serial       PRIMARY KEY,
  user_id                     integer      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                        varchar(30)  NOT NULL,            -- katalog: src/common/authz/roles.ts
  scope_type                  varchar(20)  NOT NULL DEFAULT 'global', -- global|project|department|module
  scope_id                    varchar(64),                     -- projectId / departmentId / modul-ključ
  managed_sub_department_ids  integer[],                       -- 1.0 scope Kadrovske (NULL = pun obim)
  is_active                   boolean      NOT NULL DEFAULT true,
  created_at                  timestamp    NOT NULL DEFAULT now(),
  updated_at                  timestamp    NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_roles UNIQUE (user_id, role, scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id) WHERE is_active;

-- A.2  Per-user override flagovi (1.0: readonly/access/hide flags). deny > rola.
CREATE TABLE IF NOT EXISTS user_permission_overrides (
  id       serial      PRIMARY KEY,
  user_id  integer     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key      varchar(64) NOT NULL,   -- npr. 'finalni_potpisnik', 'plan_montaze.write'
  allow    boolean     NOT NULL,   -- true=grant, false=deny (deny jači)
  CONSTRAINT uq_user_perm_override UNIQUE (user_id, key)
);

-- A.3  Most JWT-user → proizvodni Worker (definesApproval/definesLaunch/machine_access).
ALTER TABLE users ADD COLUMN IF NOT EXISTS worker_id integer;
ALTER TABLE users ADD CONSTRAINT fk_users_worker
  FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE SET NULL;

-- A.4  Kanonsko vlasništvo reda kao FK na users (za owner-only obrazac).
--      Danas je vlasništvo string username (created_by VarChar) ili created_by_worker_id.
--      Dodati created_by_id FK na proizvodnim/osetljivim tabelama (primer; ponoviti po potrebi):
-- ALTER TABLE tech_processes ADD COLUMN IF NOT EXISTS created_by_id integer REFERENCES users(id);
-- ALTER TABLE work_orders    ADD COLUMN IF NOT EXISTS created_by_id integer REFERENCES users(id);
-- (project_id već postoji na work_orders/part_locations/handover_drafts/mrp_demands/drawing_plans.)


-- =====================================================================
-- §B  GUC ugovor identiteta — app na SVAKOM requestu postavlja app.user_id
-- =====================================================================
-- App (NestJS) radi u interaktivnoj tx po requestu:
--     SELECT set_config('app.user_id', $userId::text, true);   -- true = LOCAL (tx-scope, pooler-safe)
-- (Dokazano radi u ovom kodu: generic.syncer.ts već koristi SET LOCAL u $transaction.)
-- Funkcije čitaju identitet ODAVDE — rade i pre nego što ijedna politika postoji.

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS integer
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::integer $$;


-- =====================================================================
-- §C  Predikat-funkcije — JEDAN izvor istine za app ScopeService I buduće RLS politike
-- =====================================================================
-- Paralela 1.0 (has_edit_role/current_user_manages_employee/maint_machine_visible).
-- NestJS ScopeService where-builderi zovu ISTU logiku (ili ove fn preko $queryRaw),
-- pa 3.0 samo doda `USING (fn(...))` politike bez nove semantike.
-- Anti-rekurzija (1.0 obrazac): funkcije nad user_roles su SECURITY DEFINER i politike
-- NIKAD ne SELECT-uju user_roles direktno (izbegava 42P17).

CREATE OR REPLACE FUNCTION app_has_role(p_role text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = app_current_user_id() AND ur.role = p_role AND ur.is_active
  )
$$;

CREATE OR REPLACE FUNCTION app_is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT app_has_role('admin') $$;

-- Vlasništvo reda (owner-only obrazac 7).
CREATE OR REPLACE FUNCTION app_is_owner(p_created_by_id integer)
RETURNS boolean LANGUAGE sql STABLE
AS $$ SELECT p_created_by_id IS NOT NULL AND p_created_by_id = app_current_user_id() $$;

-- Pristup mašini (RADNIK → machine_access; RBAC §3.1.4).
CREATE OR REPLACE FUNCTION app_has_machine(p_work_center_code text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_is_admin() OR EXISTS (
    SELECT 1
    FROM users u
    JOIN machine_access ma ON ma.worker_id = u.worker_id
    WHERE u.id = app_current_user_id() AND ma.work_center_code = p_work_center_code
  )
$$;

-- Per-projekat scope (pm/leadpm; 1.0 has_edit_role(project)).
CREATE OR REPLACE FUNCTION app_can_edit_project(p_project_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_is_admin() OR EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = app_current_user_id() AND ur.is_active
      AND ( (ur.scope_type = 'global' AND ur.role IN ('sef','menadzment'))
         OR (ur.scope_type = 'project' AND ur.role IN ('pm','leadpm') AND ur.scope_id = p_project_id) )
  )
$$;

-- Managed sub-departments (menadzment/tim_lider Kadrovska/prisustvo scope; 3.0).
CREATE OR REPLACE FUNCTION app_manages_sub_department(p_sub_department_id integer)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_is_admin() OR EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = app_current_user_id() AND ur.is_active
      AND ( ur.managed_sub_department_ids IS NULL           -- NULL = pun obim (legacy)
         OR p_sub_department_id = ANY(ur.managed_sub_department_ids) )
  )
$$;


-- =====================================================================
-- §D  3.0 KORAK (NE u 2.0) — uključivanje pravog RLS-a. Ostavljeno zakomentarisano.
-- =====================================================================
-- Preduslov: app se konektuje kao NE-superuser rola BEZ BYPASSRLS (sada je owner `servosync`
-- koji zaobilazi RLS). Bez ovoga politike nemaju efekta.
--
-- CREATE ROLE servosync_app LOGIN PASSWORD '***' NOSUPERUSER NOBYPASSRLS;
-- GRANT USAGE ON SCHEMA public TO servosync_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO servosync_app;
--
-- Primer politike (kad zatreba, 3.0) — koristi ISTE predikat-funkcije:
-- ALTER TABLE tech_processes ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tech_processes FORCE ROW LEVEL SECURITY;   -- da ni owner ne zaobilazi
-- CREATE POLICY tp_read  ON tech_processes FOR SELECT
--   USING (app_has_role('tehnolog') OR app_has_role('sef') OR app_is_admin()
--          OR app_has_machine(work_center_code));
-- CREATE POLICY tp_write ON tech_processes FOR UPDATE
--   USING (app_has_role('sef') OR app_is_admin() OR app_is_owner(created_by_id))
--   WITH CHECK (app_has_role('sef') OR app_is_admin() OR app_is_owner(created_by_id));
--
-- CI garancija (kao 1.0): provera da je RLS aktivan na svakoj osetljivoj tabeli
-- (izbegava "RLS-disabled → admin-write inertno" footgun iz 1.0).

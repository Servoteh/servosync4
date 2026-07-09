-- authz_rls_ready: RLS-ready foundations (AUTHZ_UNIFIED.md §5, ODLUKE #12).
-- Purely additive DDL + idempotent data fix + predicate functions. NO policies, NO RLS
-- enabling here — enforcement stays in NestJS guards until 3.0 (skeleton §D).
-- Generated via `prisma migrate diff` (datamodel→datamodel; prod-only environment, approved
-- deviation from `migrate:dev` — AUTHZ_UNIFIED §8 Faza 1). Apply with `npm run migrate:prod`.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "worker_id" INTEGER,
ALTER COLUMN "role" SET DEFAULT 'user';

-- CreateTable
CREATE TABLE "user_roles" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role" VARCHAR(30) NOT NULL,
    "scope_type" VARCHAR(20) NOT NULL DEFAULT 'global',
    "scope_id" VARCHAR(64),
    "managed_sub_department_ids" INTEGER[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "pk_user_roles" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_permission_overrides" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "allow" BOOLEAN NOT NULL,

    CONSTRAINT "pk_user_permission_overrides" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_user_roles_user" ON "user_roles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_roles" ON "user_roles"("user_id", "role", "scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_user_permission_overrides" ON "user_permission_overrides"("user_id", "key");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "fk_users_worker" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "fk_user_roles_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "fk_user_permission_overrides_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ============================================================================
-- Data fix: legacy role values were uppercase ("ADMIN"/"USER"); the catalog is
-- lowercase (roles.ts). Without this, guard activation would deny everyone
-- including admin (AUTHZ_UNIFIED §6.1.1). Idempotent.
-- ============================================================================
UPDATE "users" SET "role" = lower("role") WHERE "role" <> lower("role");

-- ============================================================================
-- Identity GUC contract + predicate functions (AUTHZ_UNIFIED §5, skeleton §B/§C).
-- App sets identity per request inside an interactive transaction:
--   SELECT set_config('app.user_id', $userId::text, true);  -- true = tx-scoped (pooler-safe)
-- Both the NestJS ScopeService and future 3.0 RLS policies call THESE functions —
-- one source of truth for scope semantics (1.0 pattern: has_edit_role & co).
-- Anti-recursion (1.0 lesson 42P17): policies never SELECT user_roles directly,
-- only via these SECURITY DEFINER helpers; user_roles itself never gets FORCE RLS.
-- ============================================================================

CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS integer
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::integer $$;

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
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT app_has_role('admin') $$;

-- Row ownership (owner-only pattern; expects created_by_id FK columns added per table later).
CREATE OR REPLACE FUNCTION app_is_owner(p_created_by_id integer)
RETURNS boolean
LANGUAGE sql STABLE
AS $$ SELECT p_created_by_id IS NOT NULL AND p_created_by_id = app_current_user_id() $$;

-- Machine access (proizvodni_radnik → machine_access via users.worker_id bridge).
CREATE OR REPLACE FUNCTION app_has_machine(p_work_center_code text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_is_admin() OR EXISTS (
    SELECT 1
    FROM users u
    JOIN machine_access ma ON ma.worker_id = u.worker_id
    WHERE u.id = app_current_user_id() AND ma.work_center_code = p_work_center_code
  )
$$;

-- Per-project scope (pm/leadpm; 1.0 has_edit_role(project) equivalent for 2.0 roles).
CREATE OR REPLACE FUNCTION app_can_edit_project(p_project_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_is_admin() OR EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = app_current_user_id() AND ur.is_active
      AND ( (ur.scope_type = 'global' AND ur.role IN ('sef', 'menadzment'))
         OR (ur.scope_type = 'project' AND ur.role IN ('pm', 'leadpm') AND ur.scope_id = p_project_id) )
  )
$$;

-- Managed sub-departments (Kadrovska/prisustvo scope; used from 3.0).
-- 1.0 semantics preserved: "full scope when unset" applies ONLY to `menadzment`
-- (legacy rows: NULL from 1.0 import, empty array from Prisma writes — both count as unset);
-- `tim_lider` must have an explicit list. Role-filtered so no other role row can match.
CREATE OR REPLACE FUNCTION app_manages_sub_department(p_sub_department_id integer)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_is_admin() OR EXISTS (
    SELECT 1 FROM user_roles ur
    WHERE ur.user_id = app_current_user_id() AND ur.is_active
      AND ur.role IN ('menadzment', 'tim_lider')
      AND ( (ur.role = 'menadzment'
             AND (ur.managed_sub_department_ids IS NULL
                  OR cardinality(ur.managed_sub_department_ids) = 0))
         OR p_sub_department_id = ANY(ur.managed_sub_department_ids) )
  )
$$;

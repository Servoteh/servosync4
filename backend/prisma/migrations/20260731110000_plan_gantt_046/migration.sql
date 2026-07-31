-- Zahtev 046/26 (F0+F1): „MS Project" gant u modulu Plan proizvodnje.
--
-- Odluke vlasnika ugrađene ovde:
--   • planirani termini su PARALELAN pogled — postojeći ručni redosled
--     (`shift_sort_order`) OSTAJE master; nijedan postojeći sort/bucket se ne dira;
--   • mapa hala↔mašina je RUČNI ŠIFRARNIK (nova tabela), ne izvođenje iz šifre mašine.
--
-- ADITIVNO i idempotentno (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS):
-- ne menja nijednu postojeću kolonu i ne dira podatke. App-owned → TIMESTAMPTZ(6)
-- (BACKEND_RULES §2.3). Meki ref-ovi bez DB FK (kućni obrazac plan_proizvodnje_*).

-- 1) Termini/uslov/završenost na postojećem overlay-u -------------------------
ALTER TABLE "plan_proizvodnje_overlays"
  ADD COLUMN IF NOT EXISTS "planned_start_at"          TIMESTAMPTZ(6),   -- NULL = stavka nije na gantu
  ADD COLUMN IF NOT EXISTS "planned_end_at"            TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "planned_duration_minutes"  INTEGER,          -- override; NULL = TPZ + TK × kom
  ADD COLUMN IF NOT EXISTS "planned_done"              BOOLEAN,          -- tri-state: NULL = auto iz kucanja
  ADD COLUMN IF NOT EXISTS "planned_done_at"           TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "planned_done_by"           TEXT,
  ADD COLUMN IF NOT EXISTS "predecessor_work_order_id" INTEGER,          -- meki ref → work_orders.id
  ADD COLUMN IF NOT EXISTS "predecessor_line"          INTEGER;          -- meki ref → work_order_operations.id

CREATE INDEX IF NOT EXISTS "idx_plan_proizvodnje_overlays_planned_start"
  ON "plan_proizvodnje_overlays" ("planned_start_at");

-- 2) Ručni šifrarnik hala (mašina → hala) ------------------------------------
CREATE TABLE IF NOT EXISTS "plan_proizvodnje_machine_halls" (
  "machine_code" VARCHAR(50)    NOT NULL,   -- meki ref → operations.work_center_code (sync keš)
  "hall"         VARCHAR(100)   NOT NULL,
  "sort_order"   INTEGER,
  "note"         TEXT,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_by"   TEXT,
  CONSTRAINT "pk_plan_proizvodnje_machine_halls" PRIMARY KEY ("machine_code")
);
CREATE INDEX IF NOT EXISTS "idx_plan_proizvodnje_machine_halls_hall"
  ON "plan_proizvodnje_machine_halls" ("hall");

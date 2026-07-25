-- Zahtev 016/26 (Strahinja) — planer(i) predmeta za obaveštenje o lansiranju primopredaje.
-- App-owned overlay nad predmet cache-om (project_id = meki ref na projects.id; NULL = globalni
-- planer koji prima SVA lansiranja). ADITIVNO — bez izmene sync-ovanih tabela.

CREATE TABLE IF NOT EXISTS "predmet_planeri" (
  "id" SERIAL NOT NULL,
  "project_id" INTEGER,
  "planner_user_id" INTEGER NOT NULL,
  "created_by_user_id" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_predmet_planeri" PRIMARY KEY ("id")
);

-- Sigurnosna mreza protiv duplog (predmet, planer); NULL project_id (globalni) se dedup-uje
-- u servisu ("replace" semantika), jer PG unique NULL tretira kao razlicit.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_predmet_planeri_project_user"
  ON "predmet_planeri" ("project_id", "planner_user_id");

CREATE INDEX IF NOT EXISTS "idx_predmet_planeri_project"
  ON "predmet_planeri" ("project_id");

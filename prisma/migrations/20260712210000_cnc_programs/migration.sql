-- CAM/programiranje status po poziciji (Miljan t.7, ODLUKE #8 + #35).
-- App-owned tabela: jedan red po RN-u, pamti „CAM završen" + audit ko/kada.
CREATE TABLE "cnc_programs" (
  "id"                     SERIAL       NOT NULL,
  "work_order_id"          INTEGER      NOT NULL,
  "is_done"                BOOLEAN      NOT NULL DEFAULT false,
  "completed_by_worker_id" INTEGER,
  "completed_at"           TIMESTAMPTZ(6),
  "note"                   VARCHAR(500),
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_cnc_programs" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_cnc_programs_work_order" ON "cnc_programs" ("work_order_id");

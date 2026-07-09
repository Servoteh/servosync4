-- New in 2.0 — per-execution work-time ledger ("dva skena": START + STOP).
-- Additive: tech_processes is NOT modified; pieceCount accumulation stays authoritative.
-- Hand-authored (no local dev DB): includes the partial-unique index + v_work_sessions
-- view, which Prisma cannot express in schema.prisma.

CREATE TABLE "work_time_entries" (
  "id"               SERIAL          NOT NULL,
  "tech_process_id"  INTEGER         NOT NULL,
  "work_order_id"    INTEGER,
  "project_id"       INTEGER         NOT NULL DEFAULT 0,
  "ident_number"     VARCHAR(50)     NOT NULL,
  "variant"          INTEGER         NOT NULL DEFAULT 0,
  "operation_number" INTEGER         NOT NULL,
  "work_center_code" VARCHAR(5)      NOT NULL,
  "worker_id"        INTEGER         NOT NULL,
  "started_at"       TIMESTAMPTZ(6)  NOT NULL,
  "stopped_at"       TIMESTAMPTZ(6),
  "piece_count"      INTEGER         NOT NULL DEFAULT 0,
  "quality_type_id"  INTEGER         NOT NULL DEFAULT 0,
  "auto_closed"      BOOLEAN         NOT NULL DEFAULT false,
  "note"             TEXT,
  "created_at"       TIMESTAMPTZ(6)  NOT NULL DEFAULT now(),
  CONSTRAINT "pk_work_time_entries" PRIMARY KEY ("id")
);

CREATE INDEX "idx_work_time_entries_tech_process" ON "work_time_entries"("tech_process_id");
CREATE INDEX "idx_work_time_entries_started_at"   ON "work_time_entries"("started_at");

-- At most ONE open session per (worker, tech_process) — the 2.0 analogue of legacy
-- DefinisiIDPostupkaZaRadnika. Partial unique index (Prisma cannot express it).
CREATE UNIQUE INDEX "uq_work_time_entries_open"
  ON "work_time_entries"("worker_id","tech_process_id")
  WHERE "stopped_at" IS NULL;

ALTER TABLE "work_time_entries"
  ADD CONSTRAINT "fk_work_time_entries_tech_process"
  FOREIGN KEY ("tech_process_id") REFERENCES "tech_processes"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "work_time_entries"
  ADD CONSTRAINT "fk_work_time_entries_worker"
  FOREIGN KEY ("worker_id") REFERENCES "workers"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Unifying bridge: native sessions UNION legacy tech_processes rows that have no
-- native session yet — so nothing is double-counted and legacy history stays visible.
CREATE VIEW "v_work_sessions" AS
  SELECT w.tech_process_id, w.worker_id, w.project_id, w.ident_number, w.variant,
         w.operation_number, w.work_center_code, w.started_at, w.stopped_at,
         w.piece_count, w.quality_type_id, w.auto_closed, 'entry'::text AS source
    FROM work_time_entries w
  UNION ALL
  SELECT tp.id, tp.worker_id, tp.project_id, tp.ident_number, tp.variant,
         tp.operation_number, tp.work_center_code,
         tp.entered_at, tp.finished_at, tp.piece_count, tp.quality_type_id,
         false, 'legacy'::text AS source
    FROM tech_processes tp
   WHERE NOT EXISTS (SELECT 1 FROM work_time_entries w WHERE w.tech_process_id = tp.id);

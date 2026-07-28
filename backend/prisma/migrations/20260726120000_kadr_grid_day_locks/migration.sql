-- AUDIT-K7c (26.07): brava potvrđenog dana mesečnog grida.
--
-- Živi u 3.0 bazi, NE u sy15 `work_hours` — ta tabela je deljena sa ŽIVIM 1.0 i
-- njena šema se ne dira. Dok 1.0 radi paralelno, on ovu bravu ne vidi; puna je
-- tek po gašenju 1.0.
--
-- Otključavaju je urednik grida (kadrovska.grid_edit) i admin, i tek tada smeju
-- da izmene dan.
CREATE TABLE "kadr_grid_day_locks" (
    "id"          SERIAL       NOT NULL,
    "employee_id" UUID         NOT NULL,
    "work_date"   DATE         NOT NULL,
    "locked_by"   VARCHAR(160) NOT NULL,
    "locked_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "note"        TEXT,
    CONSTRAINT "pk_kadr_grid_day_locks" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_kadr_grid_day_locks_emp_date"
    ON "kadr_grid_day_locks" ("employee_id", "work_date");

CREATE INDEX "idx_kadr_grid_day_locks_date"
    ON "kadr_grid_day_locks" ("work_date");

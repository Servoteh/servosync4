-- Talas A (paritet 1.0): scheduler pogon u 3.0 — dnevnik izvršavanja zakazanih
-- poslova. UNIQUE (job_key, scheduled_for) je ISTOVREMENO i mutex: instanca koja
-- prva INSERT-uje "claim" red izvršava posao; ostale (ili restartovana ista)
-- dobiju conflict i preskoče. FAILED pokušaji se ponavljaju kroz atomski UPDATE
-- (attempts) do max broja pokušaja u catch-up prozoru.
CREATE TABLE "scheduled_job_runs" (
    "id" SERIAL NOT NULL,
    "job_key" VARCHAR(64) NOT NULL,
    "scheduled_for" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    -- RUNNING | DONE | FAILED (String, ne enum — BACKEND_RULES §2)
    "status" VARCHAR(16) NOT NULL DEFAULT 'RUNNING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "summary" TEXT,
    "error" TEXT,

    CONSTRAINT "pk_scheduled_job_runs" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_scheduled_job_runs_job_scheduled"
    ON "scheduled_job_runs" ("job_key", "scheduled_for");

CREATE INDEX "idx_scheduled_job_runs_job_started"
    ON "scheduled_job_runs" ("job_key", "started_at" DESC);

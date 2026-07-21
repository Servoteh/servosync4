-- Zahtevi (AI PM modul) — F1 backend jezgro (MODULE_SPEC_zahtevi.md §3).
-- App-owned tabele (nula legacy veza), prefiks change_request_* + decision_log_entries.
-- Ručno pisana migracija (obrazac postojećih SQL fajlova): dev Postgres 5435 nedostupan
-- u okruženju agenta; primeniće se `migrate:dev`/`migrate:prod` na dev/prod bazi.

-- CreateTable
CREATE TABLE "change_requests" (
    "id" SERIAL NOT NULL,
    "req_no" VARCHAR(12) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT NOT NULL,
    "expected_behavior" TEXT,
    "current_behavior" TEXT,
    "kind" VARCHAR(20),
    "module" VARCHAR(40),
    "areas" TEXT[],
    "priority_user" VARCHAR(10),
    "priority_final" VARCHAR(10),
    "ai_score" INTEGER,
    "ai_score_reason" TEXT,
    "final_score" INTEGER,
    "reward_amount" DECIMAL(10,2),
    "reward_status" VARCHAR(10) NOT NULL DEFAULT 'NONE',
    "reward_month" VARCHAR(7),
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" INTEGER NOT NULL,
    "submitted_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "decided_by_user_id" INTEGER,
    "decision_note" TEXT,
    "merged_into_id" INTEGER,
    "branch_name" VARCHAR(120),
    "pr_url" VARCHAR(300),
    "commit_sha" VARCHAR(64),
    "delivered_version" VARCHAR(60),
    "implemented_by" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_change_requests" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_request_attachments" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "bucket" VARCHAR(60) NOT NULL,
    "storage_path" VARCHAR(300) NOT NULL,
    "original_name" VARCHAR(200) NOT NULL,
    "content_type" VARCHAR(80) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "transcript" TEXT,
    "transcript_model" VARCHAR(60),
    "created_by_user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_change_request_attachments" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_request_ai_analyses" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    "model" VARCHAR(60),
    "result" JSONB,
    "claude_package" TEXT,
    "error_code" VARCHAR(40),
    "tokens_in" INTEGER,
    "tokens_out" INTEGER,
    "started_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_change_request_ai_analyses" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_request_comments" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "author_user_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "is_question" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_change_request_comments" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_request_events" (
    "id" SERIAL NOT NULL,
    "request_id" INTEGER NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "actor_user_id" INTEGER,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_change_request_events" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_log_entries" (
    "id" SERIAL NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "decision" TEXT NOT NULL,
    "context" TEXT,
    "consequences" TEXT,
    "tags" TEXT[],
    "related_request_id" INTEGER,
    "status" VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
    "superseded_by_id" INTEGER,
    "decided_on" DATE NOT NULL,
    "created_by_user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_decision_log_entries" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_request_reward_tariffs" (
    "id" SERIAL NOT NULL,
    "score" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'RSD',
    "valid_from" DATE NOT NULL,
    "created_by_user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_change_request_reward_tariffs" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_change_requests_status" ON "change_requests"("status");

-- CreateIndex
CREATE INDEX "idx_change_requests_created_by" ON "change_requests"("created_by_user_id");

-- CreateIndex
CREATE INDEX "idx_change_requests_module" ON "change_requests"("module");

-- CreateIndex
-- Jedinstven broj zahteva. req_no = "NNN/YY" već NOSI godinu u sufiksu, pa je globalni
-- UNIQUE nad req_no ekvivalent uniqueности PO GODINI (brojač se resetuje po godini —
-- request-numbering.service). Advisory lock serijalizuje generisanje; ovaj indeks je
-- safety-net protiv trke. Drži se van Prisma @@unique (numeracija je SQL-vlasništvo).
CREATE UNIQUE INDEX "uq_change_requests_req_no" ON "change_requests"("req_no");

-- CreateIndex
CREATE INDEX "idx_cr_attachments_request" ON "change_request_attachments"("request_id");

-- CreateIndex
CREATE INDEX "idx_cr_analyses_request" ON "change_request_ai_analyses"("request_id");

-- CreateIndex
CREATE INDEX "idx_cr_comments_request" ON "change_request_comments"("request_id");

-- CreateIndex
CREATE INDEX "idx_cr_events_request" ON "change_request_events"("request_id");

-- CreateIndex
CREATE INDEX "idx_decision_log_entries_status" ON "decision_log_entries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cr_reward_tariffs_score_valid_from" ON "change_request_reward_tariffs"("score", "valid_from");

-- AddForeignKey
ALTER TABLE "change_request_attachments" ADD CONSTRAINT "fk_cr_attachments_request" FOREIGN KEY ("request_id") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_request_ai_analyses" ADD CONSTRAINT "fk_cr_analyses_request" FOREIGN KEY ("request_id") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_request_comments" ADD CONSTRAINT "fk_cr_comments_request" FOREIGN KEY ("request_id") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_request_events" ADD CONSTRAINT "fk_cr_events_request" FOREIGN KEY ("request_id") REFERENCES "change_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed početne tarife nagrada (presuda §13.8, blaža skala): ocena → iznos u RSD.
-- validFrom = CURRENT_DATE (dan aktivacije). Kasnije izmene kroz UI = NOV red po važenju.
-- Idempotentno (ON CONFLICT nad uq score+valid_from): re-run migracije ne duplira.
INSERT INTO "change_request_reward_tariffs" ("score", "amount", "currency", "valid_from", "created_by_user_id")
VALUES
  (1, 500, 'RSD', CURRENT_DATE, 0),
  (2, 1000, 'RSD', CURRENT_DATE, 0),
  (3, 1500, 'RSD', CURRENT_DATE, 0),
  (4, 2000, 'RSD', CURRENT_DATE, 0),
  (5, 3000, 'RSD', CURRENT_DATE, 0)
ON CONFLICT ON CONSTRAINT "uq_cr_reward_tariffs_score_valid_from" DO NOTHING;

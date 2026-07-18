-- BigBit → Postgres sync bookkeeping (Sprint 1, approach B — NestJS + SQL Server client).
-- See docs/schema-rename-map.md → "BigBit sync (Sprint 1)".

-- CreateTable
CREATE TABLE "bb_sync_log" (
    "id" SERIAL NOT NULL,
    "started_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(6),
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "trigger" VARCHAR(20) NOT NULL DEFAULT 'manual',
    "triggered_by_user_id" INTEGER,
    "entity_scope" VARCHAR(100),
    "rows_fetched" INTEGER NOT NULL DEFAULT 0,
    "rows_upserted" INTEGER NOT NULL DEFAULT 0,
    "rows_skipped" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "metadata" JSONB,

    CONSTRAINT "pk_bb_sync_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_sync_state" (
    "entity" VARCHAR(100) NOT NULL,
    "cursor" JSONB,
    "last_success_at" TIMESTAMP(6),
    "last_attempt_at" TIMESTAMP(6),
    "last_error_message" TEXT,
    "last_success_sync_log_id" INTEGER,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_bb_sync_state" PRIMARY KEY ("entity")
);

-- CreateIndex
CREATE INDEX "idx_bb_sync_log_entity_scope_started_at" ON "bb_sync_log"("entity_scope", "started_at");

-- CreateIndex
CREATE INDEX "idx_bb_sync_log_status_started_at" ON "bb_sync_log"("status", "started_at");

-- AddForeignKey
ALTER TABLE "bb_sync_log" ADD CONSTRAINT "fk_bb_sync_log_triggered_by_user" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bb_sync_state" ADD CONSTRAINT "fk_bb_sync_state_last_success_log" FOREIGN KEY ("last_success_sync_log_id") REFERENCES "bb_sync_log"("id") ON DELETE SET NULL ON UPDATE NO ACTION;


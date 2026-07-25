-- Batch B (T2+T3) — ADITIVNO:
--   • soft-delete na stavkama dokumenata (poništivo brisanje + audit; čitaoci filtriraju deleted_at IS NULL)
--   • dunning_notices — trag poslatih opomena (nivo po dospelosti; anti-dupli-slanje)

ALTER TABLE "stock_document_items" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "stock_document_items" ADD COLUMN IF NOT EXISTS "deleted_by_user_id" INTEGER;

ALTER TABLE "bank_statement_lines" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "bank_statement_lines" ADD COLUMN IF NOT EXISTS "deleted_by_user_id" INTEGER;

CREATE TABLE IF NOT EXISTS "dunning_notices" (
  "id" SERIAL NOT NULL,
  "partner_id" INTEGER NOT NULL,
  "level" INTEGER NOT NULL,
  "as_of" TIMESTAMPTZ(6) NOT NULL,
  "overdue_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "days_overdue" INTEGER,
  "sent_to" VARCHAR(255),
  "sent_ok" BOOLEAN NOT NULL DEFAULT false,
  "note" VARCHAR(500),
  "sent_by_user_id" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_dunning_notices" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_dunning_notices_partner_level" ON "dunning_notices" ("partner_id", "level");
CREATE INDEX IF NOT EXISTS "idx_dunning_notices_created" ON "dunning_notices" ("created_at");

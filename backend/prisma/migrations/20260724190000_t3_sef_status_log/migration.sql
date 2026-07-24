-- T3 batch A — SEF status istorija (document flow timeline). ADITIVNO.

CREATE TABLE IF NOT EXISTS "sef_status_log" (
  "id" SERIAL NOT NULL,
  "outbox_id" INTEGER,
  "incoming_id" INTEGER,
  "status" VARCHAR(30) NOT NULL,
  "note" VARCHAR(500),
  "user_id" INTEGER,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_sef_status_log" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_sef_status_log_outbox" ON "sef_status_log" ("outbox_id");
CREATE INDEX IF NOT EXISTS "idx_sef_status_log_incoming" ON "sef_status_log" ("incoming_id");

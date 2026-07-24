-- E1 — SEF ulazne e-fakture (O3 presuda 24.07: danas kroz BigBit → cutover-bloker).
-- ADITIVNO: nova tabela sef_incoming_invoices (inbox pull sa SEF-a, rok 15 dana,
-- dedup po BigBit logici PIB+broj protiv KUF evidencije).

CREATE TABLE IF NOT EXISTS "sef_incoming_invoices" (
  "id" SERIAL NOT NULL,
  "sef_purchase_id" VARCHAR(64) NOT NULL,
  "supplier_pib" VARCHAR(20) NOT NULL,
  "supplier_name" VARCHAR(255),
  "invoice_number" VARCHAR(64) NOT NULL,
  "issue_date" TIMESTAMPTZ(6),
  "delivery_date" TIMESTAMPTZ(6),
  "due_date" TIMESTAMPTZ(6),
  "total_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "vat_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'RSD',
  "status" VARCHAR(20) NOT NULL DEFAULT 'NEW',
  "accept_deadline" TIMESTAMPTZ(6),
  "reject_comment" VARCHAR(500),
  "already_exists" BOOLEAN NOT NULL DEFAULT false,
  "matched_kuf_entry_id" INTEGER,
  "raw_xml" TEXT,
  "action_by_user_id" INTEGER,
  "action_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_sef_incoming_invoices" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_sef_incoming_sef_purchase_id"
  ON "sef_incoming_invoices" ("sef_purchase_id");
CREATE INDEX IF NOT EXISTS "idx_sef_incoming_status" ON "sef_incoming_invoices" ("status");
CREATE INDEX IF NOT EXISTS "idx_sef_incoming_deadline" ON "sef_incoming_invoices" ("accept_deadline");
CREATE INDEX IF NOT EXISTS "idx_sef_incoming_pib_number"
  ON "sef_incoming_invoices" ("supplier_pib", "invoice_number");

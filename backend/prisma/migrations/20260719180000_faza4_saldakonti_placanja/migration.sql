ALTER TABLE "ledger_entries" ADD COLUMN     "currency" VARCHAR(3),
ADD COLUMN     "document_number" VARCHAR(30),
ADD COLUMN     "due_date" TIMESTAMPTZ(6),
ADD COLUMN     "reconciled_at" TIMESTAMPTZ(6),
ADD COLUMN     "reconciliation_group_id" INTEGER;

-- CreateTable
CREATE TABLE "reconciliation_groups" (
    "id" SERIAL NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "created_by_user_id" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_reconciliation_groups" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statements" (
    "id" SERIAL NOT NULL,
    "bank_account" VARCHAR(50) NOT NULL,
    "statement_number" VARCHAR(30) NOT NULL,
    "statement_date" TIMESTAMPTZ(6) NOT NULL,
    "imported_file_name" VARCHAR(255),
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "opening_balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "closing_balance" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'RSD',
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_bank_statements" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_statement_lines" (
    "id" SERIAL NOT NULL,
    "statement_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL DEFAULT 0,
    "partner_account" VARCHAR(50),
    "partner_name" VARCHAR(255),
    "amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "direction" VARCHAR(10) NOT NULL,
    "reference_number" VARCHAR(30),
    "document_date" TIMESTAMPTZ(6),
    "matched_customer_id" INTEGER,
    "matched_ledger_entry_id" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'UNMATCHED',

    CONSTRAINT "pk_bank_statement_lines" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" SERIAL NOT NULL,
    "order_number" VARCHAR(20) NOT NULL,
    "supplier_id" INTEGER NOT NULL,
    "supplier_account" VARCHAR(50),
    "amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'RSD',
    "reference_number_debit" VARCHAR(20),
    "reference_number_credit" VARCHAR(20),
    "purpose" VARCHAR(255),
    "due_date" TIMESTAMPTZ(6),
    "status" VARCHAR(20) NOT NULL DEFAULT 'CREATED',
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "source_ledger_entry_id" INTEGER,
    "exported_at" TIMESTAMPTZ(6),
    "created_by_user_id" INTEGER,
    "updated_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_payment_orders" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_orders" (
    "id" SERIAL NOT NULL,
    "partner_id" INTEGER NOT NULL,
    "compensation_number" VARCHAR(20) NOT NULL,
    "date" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "total_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_compensation_orders" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compensation_order_lines" (
    "id" SERIAL NOT NULL,
    "compensation_id" INTEGER NOT NULL,
    "ledger_entry_id" INTEGER,
    "side" VARCHAR(10) NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "line_no" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_compensation_order_lines" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_reconciliation_groups_kind" ON "reconciliation_groups"("kind");

-- CreateIndex
CREATE INDEX "idx_bank_statements_status" ON "bank_statements"("status");

-- CreateIndex
CREATE INDEX "idx_bank_statements_date" ON "bank_statements"("statement_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bank_statements_account_number" ON "bank_statements"("bank_account", "statement_number");

-- CreateIndex
CREATE INDEX "idx_bank_statement_lines_statement" ON "bank_statement_lines"("statement_id");

-- CreateIndex
CREATE INDEX "idx_bank_statement_lines_partner_account" ON "bank_statement_lines"("partner_account");

-- CreateIndex
CREATE INDEX "idx_bank_statement_lines_status" ON "bank_statement_lines"("status");

-- CreateIndex
CREATE INDEX "idx_payment_orders_supplier" ON "payment_orders"("supplier_id");

-- CreateIndex
CREATE INDEX "idx_payment_orders_status" ON "payment_orders"("status");

-- CreateIndex
CREATE INDEX "idx_payment_orders_due_date" ON "payment_orders"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payment_orders_dedup" ON "payment_orders"("reference_number_credit", "supplier_id");

-- CreateIndex
CREATE INDEX "idx_compensation_orders_partner" ON "compensation_orders"("partner_id");

-- CreateIndex
CREATE INDEX "idx_compensation_orders_status" ON "compensation_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_compensation_orders_number" ON "compensation_orders"("compensation_number");

-- CreateIndex
CREATE INDEX "idx_compensation_order_lines_compensation" ON "compensation_order_lines"("compensation_id");

-- CreateIndex
CREATE INDEX "idx_ledger_entries_open_items" ON "ledger_entries"("account_code", "analytical_code", "reconciled_at");

-- CreateIndex
CREATE INDEX "idx_ledger_entries_recon_group" ON "ledger_entries"("reconciliation_group_id");

-- AddForeignKey
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "fk_bank_statement_lines_statement" FOREIGN KEY ("statement_id") REFERENCES "bank_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_order_lines" ADD CONSTRAINT "fk_compensation_order_lines_compensation" FOREIGN KEY ("compensation_id") REFERENCES "compensation_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


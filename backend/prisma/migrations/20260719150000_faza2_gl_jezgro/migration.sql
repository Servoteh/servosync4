-- CreateTable
CREATE TABLE "journal_entries" (
    "id" SERIAL NOT NULL,
    "number" VARCHAR(10) NOT NULL,
    "order_type_code" VARCHAR(5) NOT NULL,
    "year" INTEGER NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "document_date" TIMESTAMPTZ(6) NOT NULL,
    "posting_date" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 0,
    "reverses_entry_id" INTEGER,
    "reversed_by_entry_id" INTEGER,
    "posting_scheme_id" INTEGER,
    "source_goods_doc_id" INTEGER,
    "signature" VARCHAR(50),
    "signed_at" TIMESTAMPTZ(6),
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pk_journal_entries" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" SERIAL NOT NULL,
    "journal_entry_id" INTEGER NOT NULL,
    "account_code" VARCHAR(10) NOT NULL,
    "analytical_code" INTEGER,
    "debit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "fx_debit" DECIMAL(19,4),
    "fx_credit" DECIMAL(19,4),
    "fx_currency" VARCHAR(3),
    "description" VARCHAR(255),
    "cost_center" VARCHAR(20),
    "source_goods_doc_id" INTEGER,
    "source_service_doc_id" INTEGER,
    "source_project_id" INTEGER,
    "source_work_order_id" INTEGER,
    "reconciled_with_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_ledger_entries" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_journal_entries_reverses" ON "journal_entries"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "idx_journal_entries_source_goods_doc" ON "journal_entries"("source_goods_doc_id");

-- CreateIndex
CREATE INDEX "idx_journal_entries_status" ON "journal_entries"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_journal_entries_number" ON "journal_entries"("company_id", "order_type_code", "year", "number");

-- CreateIndex
CREATE INDEX "idx_ledger_entries_journal" ON "ledger_entries"("journal_entry_id");

-- CreateIndex
CREATE INDEX "idx_ledger_entries_account_analytical" ON "ledger_entries"("account_code", "analytical_code");

-- CreateIndex
CREATE INDEX "idx_ledger_entries_source_goods_doc" ON "ledger_entries"("source_goods_doc_id");

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "fk_journal_entries_reverses" FOREIGN KEY ("reverses_entry_id") REFERENCES "journal_entries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "fk_journal_entries_scheme" FOREIGN KEY ("posting_scheme_id") REFERENCES "accounting_schemes"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "fk_ledger_entries_journal" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "fk_ledger_entries_account" FOREIGN KEY ("account_code") REFERENCES "accounts"("code") ON DELETE NO ACTION ON UPDATE CASCADE;


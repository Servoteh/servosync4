-- CreateTable
CREATE TABLE "vat_account_map" (
    "account" VARCHAR(10) NOT NULL,
    "name" VARCHAR(255),
    "direction" VARCHAR(10) NOT NULL,
    "rate" INTEGER,
    "role" VARCHAR(20) NOT NULL,

    CONSTRAINT "pk_vat_account_map" PRIMARY KEY ("account")
);

-- CreateTable
CREATE TABLE "popdv_definitions" (
    "id" SERIAL NOT NULL,
    "aop" VARCHAR(20) NOT NULL,
    "row_label" VARCHAR(255),
    "formula" TEXT,
    "vat_section" VARCHAR(10) NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_popdv_definitions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_returns" (
    "id" SERIAL NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" SMALLINT,
    "period_quarter" SMALLINT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "output_vat" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "input_vat" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "vat_liability" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_vat_returns" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_return_lines" (
    "id" SERIAL NOT NULL,
    "vat_return_id" INTEGER NOT NULL,
    "aop" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_vat_return_lines" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vat_ledger_entries" (
    "id" SERIAL NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "document_number" VARCHAR(30) NOT NULL,
    "partner_id" INTEGER,
    "document_date" TIMESTAMPTZ(6) NOT NULL,
    "tax_period_year" INTEGER NOT NULL,
    "tax_period_month" SMALLINT NOT NULL,
    "vat_base" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "vat_amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "vat_rate_code" VARCHAR(5),
    "source_journal_entry_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_vat_ledger_entries" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_statements" (
    "id" SERIAL NOT NULL,
    "statement_type" VARCHAR(20) NOT NULL,
    "period_year" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_financial_statements" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_statement_lines" (
    "id" SERIAL NOT NULL,
    "statement_id" INTEGER NOT NULL,
    "aop" VARCHAR(20) NOT NULL,
    "label" VARCHAR(255),
    "amount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "formula" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_financial_statement_lines" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_formula_definitions" (
    "id" SERIAL NOT NULL,
    "statement_type" VARCHAR(20) NOT NULL,
    "aop" VARCHAR(20) NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "formula" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_balance_formula_definitions" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_vat_account_map_direction" ON "vat_account_map"("direction");

-- CreateIndex
CREATE INDEX "idx_popdv_definitions_section" ON "popdv_definitions"("vat_section");

-- CreateIndex
CREATE INDEX "idx_popdv_definitions_aop" ON "popdv_definitions"("aop");

-- CreateIndex
CREATE INDEX "idx_vat_returns_status" ON "vat_returns"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_vat_returns_period" ON "vat_returns"("period_year", "period_month", "period_quarter");

-- CreateIndex
CREATE INDEX "idx_vat_return_lines_return" ON "vat_return_lines"("vat_return_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_vat_return_lines_return_aop" ON "vat_return_lines"("vat_return_id", "aop");

-- CreateIndex
CREATE INDEX "idx_vat_ledger_entries_period" ON "vat_ledger_entries"("tax_period_year", "tax_period_month", "direction");

-- CreateIndex
CREATE INDEX "idx_vat_ledger_entries_partner" ON "vat_ledger_entries"("partner_id");

-- CreateIndex
CREATE INDEX "idx_vat_ledger_entries_source" ON "vat_ledger_entries"("source_journal_entry_id");

-- CreateIndex
CREATE INDEX "idx_financial_statements_status" ON "financial_statements"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_financial_statements_type_year" ON "financial_statements"("statement_type", "period_year");

-- CreateIndex
CREATE INDEX "idx_financial_statement_lines_statement" ON "financial_statement_lines"("statement_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_financial_statement_lines_statement_aop" ON "financial_statement_lines"("statement_id", "aop");

-- CreateIndex
CREATE INDEX "idx_balance_formula_definitions_type" ON "balance_formula_definitions"("statement_type");

-- CreateIndex
CREATE UNIQUE INDEX "uq_balance_formula_definitions_type_aop" ON "balance_formula_definitions"("statement_type", "aop");

-- AddForeignKey
ALTER TABLE "vat_return_lines" ADD CONSTRAINT "fk_vat_return_lines_return" FOREIGN KEY ("vat_return_id") REFERENCES "vat_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_statement_lines" ADD CONSTRAINT "fk_financial_statement_lines_statement" FOREIGN KEY ("statement_id") REFERENCES "financial_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;


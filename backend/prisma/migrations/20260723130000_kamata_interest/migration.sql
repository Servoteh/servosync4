-- Kamata (obračun zatezne kamate) — InterestRate + InterestCalculation + InterestCalcLine.
-- Aditivno: samo nove tabele.

-- CreateTable
CREATE TABLE "interest_rates" (
    "id" SERIAL NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "rate_pct" DECIMAL(9,4) NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "note" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_interest_rates" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interest_calculations" (
    "id" SERIAL NOT NULL,
    "partner_id" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "method" VARCHAR(20) NOT NULL DEFAULT 'proporcionalni',
    "calc_date" TIMESTAMPTZ(6) NOT NULL,
    "total_principal" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "total_interest" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "status" VARCHAR(10) NOT NULL DEFAULT 'DRAFT',
    "journal_entry_id" INTEGER,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_interest_calculations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interest_calc_lines" (
    "id" SERIAL NOT NULL,
    "calculation_id" INTEGER NOT NULL,
    "ledger_entry_id" INTEGER,
    "document_number" VARCHAR(30),
    "principal" DECIMAL(19,4) NOT NULL,
    "due_date" TIMESTAMPTZ(6) NOT NULL,
    "days_overdue" INTEGER NOT NULL,
    "rate_pct" DECIMAL(9,4) NOT NULL,
    "interest" DECIMAL(19,4) NOT NULL,

    CONSTRAINT "pk_interest_calc_lines" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_interest_rates_kind_from" ON "interest_rates"("kind", "valid_from");

-- CreateIndex
CREATE INDEX "idx_interest_calc_partner" ON "interest_calculations"("partner_id");

-- CreateIndex
CREATE INDEX "idx_interest_calc_lines_calc" ON "interest_calc_lines"("calculation_id");

-- AddForeignKey
ALTER TABLE "interest_calc_lines" ADD CONSTRAINT "fk_interest_calc_lines_calc" FOREIGN KEY ("calculation_id") REFERENCES "interest_calculations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

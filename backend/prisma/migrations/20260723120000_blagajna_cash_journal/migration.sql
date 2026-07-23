-- Blagajna (gotovinski dnevnik) — CashJournal + CashEntry (4.0 XL, SAP Cash Journal).
-- Aditivno: samo nove tabele, ne dira postojeće.

-- CreateTable
CREATE TABLE "cash_journals" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "name" VARCHAR(100) NOT NULL,
    "account_code" VARCHAR(10) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'RSD',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_cash_journals" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_entries" (
    "id" SERIAL NOT NULL,
    "cash_journal_id" INTEGER NOT NULL,
    "entry_number" VARCHAR(20) NOT NULL,
    "direction" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "entry_date" TIMESTAMPTZ(6) NOT NULL,
    "partner_id" INTEGER,
    "contra_account" VARCHAR(10) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(10) NOT NULL DEFAULT 'DRAFT',
    "journal_entry_id" INTEGER,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_cash_entries" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_cash_journals_company" ON "cash_journals"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cash_entries_number" ON "cash_entries"("cash_journal_id", "direction", "entry_number");

-- CreateIndex
CREATE INDEX "idx_cash_entries_journal_date" ON "cash_entries"("cash_journal_id", "entry_date");

-- CreateIndex
CREATE INDEX "idx_cash_entries_status" ON "cash_entries"("status");

-- AddForeignKey
ALTER TABLE "cash_entries" ADD CONSTRAINT "fk_cash_entries_journal" FOREIGN KEY ("cash_journal_id") REFERENCES "cash_journals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

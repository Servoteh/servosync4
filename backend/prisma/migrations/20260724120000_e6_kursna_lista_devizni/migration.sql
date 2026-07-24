-- E6 — devizni izvod + kursna lista (O2 presuda 24.07: ~100 deviznih izvoda/god).
-- ADITIVNO: nova tabela exchange_rates + FX kolone na bank_statement_lines.
-- BigBit pravila (doc 09): izvodi po PRODAJNOM kursu, blagajna po srednjem;
-- vikend/praznik = poslednji raniji datum. amount na stavci ostaje UVEK RSD.

CREATE TABLE IF NOT EXISTS "exchange_rates" (
  "id" SERIAL NOT NULL,
  "rate_date" TIMESTAMPTZ(6) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "buy_rate" DECIMAL(19,6) NOT NULL DEFAULT 0,
  "middle_rate" DECIMAL(19,6) NOT NULL DEFAULT 0,
  "sell_rate" DECIMAL(19,6) NOT NULL DEFAULT 0,
  "source" VARCHAR(20),
  "note" VARCHAR(255),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_exchange_rates" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_exchange_rates_date_currency"
  ON "exchange_rates" ("rate_date", "currency");
CREATE INDEX IF NOT EXISTS "idx_exchange_rates_currency_date"
  ON "exchange_rates" ("currency", "rate_date");

ALTER TABLE "bank_statement_lines" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(3);
ALTER TABLE "bank_statement_lines" ADD COLUMN IF NOT EXISTS "foreign_amount" DECIMAL(19,4);
ALTER TABLE "bank_statement_lines" ADD COLUMN IF NOT EXISTS "exchange_rate" DECIMAL(19,6);

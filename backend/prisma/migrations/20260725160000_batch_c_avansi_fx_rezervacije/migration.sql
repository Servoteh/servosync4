-- Batch C: avansni računi (AVR), devizne kursne razlike, rezervacija zaliha.
-- Sve aditivno — nijedna postojeća kolona se ne menja niti briše.

-- ── C1: avansi na fakturi ────────────────────────────────────────────────────
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "advance_invoice_id"      INTEGER,
  ADD COLUMN IF NOT EXISTS "advance_applied_amount"  DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "advance_paid_at"         TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "advance_paid_amount"     DECIMAL(19,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "advance_direction"       VARCHAR(3);

CREATE INDEX IF NOT EXISTS "idx_invoices_advance" ON "invoices" ("advance_invoice_id");

-- Jedan AVR se sme odbiti na najviše JEDNOM konačnom računu (anti-duplo odbijanje avansa).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_invoices_advance_applied_once"
  ON "invoices" ("advance_invoice_id")
  WHERE "advance_invoice_id" IS NOT NULL AND "status" <> 'CANCELLED';

-- ── C2: revalorizacija deviznih otvorenih stavki ─────────────────────────────
CREATE TABLE IF NOT EXISTS "fx_revaluation_runs" (
  "id"                 SERIAL         NOT NULL,
  "as_of_date"         TIMESTAMPTZ(6) NOT NULL,
  "currency"           VARCHAR(3)     NOT NULL,
  "company_id"         INTEGER        NOT NULL DEFAULT 0,
  "rate_used"          DECIMAL(19,6)  NOT NULL,
  "gain_amount"        DECIMAL(19,4)  NOT NULL DEFAULT 0,
  "loss_amount"        DECIMAL(19,4)  NOT NULL DEFAULT 0,
  "items_count"        INTEGER        NOT NULL DEFAULT 0,
  "journal_entry_id"   INTEGER,
  "status"             VARCHAR(20)    NOT NULL DEFAULT 'POSTED',
  "note"               TEXT,
  "created_by_user_id" INTEGER,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_fx_revaluation_runs" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_fx_revaluation_runs_key"
  ON "fx_revaluation_runs" ("as_of_date", "currency", "company_id");

-- Aktivan obračun je jedinstven po (presek, valuta, firma); storniran oslobađa slot.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_fx_revaluation_runs_active"
  ON "fx_revaluation_runs" ("as_of_date", "currency", "company_id")
  WHERE "status" <> 'REVERSED';

-- ── C3: rezervacija zaliha ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "stock_reservations" (
  "id"                 SERIAL         NOT NULL,
  "item_id"            INTEGER        NOT NULL,
  "warehouse_id"       INTEGER        NOT NULL,
  "source_type"        VARCHAR(20)    NOT NULL,
  "source_id"          INTEGER        NOT NULL,
  "source_line"        INTEGER,
  "quantity"           DECIMAL(19,6)  NOT NULL,
  "status"             VARCHAR(20)    NOT NULL DEFAULT 'OPEN',
  "released_at"        TIMESTAMPTZ(6),
  "release_reason"     VARCHAR(200),
  "expires_at"         TIMESTAMPTZ(6),
  "note"               TEXT,
  "created_by_user_id" INTEGER,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_stock_reservations" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_stock_reservations_source_line"
  ON "stock_reservations" ("source_type", "source_id", "source_line");

CREATE INDEX IF NOT EXISTS "idx_stock_reservations_item_wh_status"
  ON "stock_reservations" ("item_id", "warehouse_id", "status");

CREATE INDEX IF NOT EXISTS "idx_stock_reservations_expiry"
  ON "stock_reservations" ("status", "expires_at");

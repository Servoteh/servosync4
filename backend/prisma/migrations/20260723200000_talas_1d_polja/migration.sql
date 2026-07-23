-- Talas 1D (docs/PLAN_TALAS_1C-1E §3) — nova polja, sve ADITIVNO:
--   D6: invoices.po_number — broj narudžbenice kupca → UBL cac:OrderReference (SEF javni sektor)
--   D8: invoices.is_locked — tehnička brava proknjiženog/SEF-prihvaćenog dokumenta
--   D9: financial_statement_lines.amount_2 / amount_3 — Iznos_2 (PG) / Iznos_3 (PS) kolone APR obrasca

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "po_number" VARCHAR(50);
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "is_locked" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "financial_statement_lines" ADD COLUMN IF NOT EXISTS "amount_2" DECIMAL(19,4) NOT NULL DEFAULT 0;
ALTER TABLE "financial_statement_lines" ADD COLUMN IF NOT EXISTS "amount_3" DECIMAL(19,4) NOT NULL DEFAULT 0;

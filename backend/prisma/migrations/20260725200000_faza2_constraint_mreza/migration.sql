-- ============================================================================
-- FAZA 2: CONSTRAINT MREŽA (DB audit — DB-001/002/003/004/005/006/007/008/009,
-- DB-011, DB-012*, DB-013 deo, DB-022; dogovoreno sa korisnikom 25.07.2026)
-- ============================================================================
-- Pred-scan na produ 25.07 (docs/DB_AUDIT_REPORT.md §5): SVE stavke ispod imaju
-- 0 prljavih/duplih redova — constrainti ulaze čisto. Tabele su male ili prazne
-- (4.0 pilot), pa plain DDL bez CONCURRENTLY; jedini izuzeci sa podacima
-- (work_time_entries 907, nonconformity_reports) idu NOT VALID → VALIDATE.
--
-- NAPOMENA za Prisma šemu: parcijalni unique indeksi, NULLS NOT DISTINCT i
-- trigeri NISU izrazivi u Prisma DSL-u — žive samo ovde (presedan:
-- uq_stock_documents_po). U schema.prisma stoje komentari-pokazivači.
-- ============================================================================

-- ── 1) DB-001/002: trigger brana — knjižen/zaključan dokument se NE BRIŠE ────
-- Kaskade za draft lifecycle OSTAJU (servisi ih koriste); trigeri su poslednja
-- linija odbrane od admin-delete/bag-a. Kaskadni DELETE okida child trigere,
-- pa brana na cash_entries pokriva i kaskadu sa cash_journals.

CREATE OR REPLACE FUNCTION trg_journal_entries_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('posted', 'locked') THEN
    RAISE EXCEPTION 'POSTED_DELETE_FORBIDDEN: journal_entries id=% status=% — brisanje zabranjeno, koristi storno (reverse).', OLD.id, OLD.status;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS guard_delete ON journal_entries;
CREATE TRIGGER guard_delete BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION trg_journal_entries_guard();

CREATE OR REPLACE FUNCTION trg_invoices_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'DRAFT' OR OLD.is_locked THEN
    RAISE EXCEPTION 'POSTED_DELETE_FORBIDDEN: invoices id=% status=% — račun se ne briše (storno).', OLD.id, OLD.status;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS guard_delete ON invoices;
CREATE TRIGGER guard_delete BEFORE DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION trg_invoices_guard();

CREATE OR REPLACE FUNCTION trg_stock_documents_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'POSTED' OR OLD.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'POSTED_DELETE_FORBIDDEN: stock_documents id=% (status=%, nalog=%) — proknjižen robni dokument se ne briše.', OLD.id, OLD.status, OLD.journal_entry_id;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS guard_delete ON stock_documents;
CREATE TRIGGER guard_delete BEFORE DELETE ON stock_documents
  FOR EACH ROW EXECUTE FUNCTION trg_stock_documents_guard();

CREATE OR REPLACE FUNCTION trg_bank_statements_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'POSTED_DELETE_FORBIDDEN: bank_statements id=% — proknjižen izvod se ne briše (storniraj nalog).', OLD.id;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS guard_delete ON bank_statements;
CREATE TRIGGER guard_delete BEFORE DELETE ON bank_statements
  FOR EACH ROW EXECUTE FUNCTION trg_bank_statements_guard();

CREATE OR REPLACE FUNCTION trg_cash_entries_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'POSTED_DELETE_FORBIDDEN: cash_entries id=% — POSTED uplatnica/isplatnica se ne briše (ovo brani i kaskadu sa cash_journals).', OLD.id;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS guard_delete ON cash_entries;
CREATE TRIGGER guard_delete BEFORE DELETE ON cash_entries
  FOR EACH ROW EXECUTE FUNCTION trg_cash_entries_guard();

-- ── 2) DB-003: vat_returns period-unique KOJI RADI (NULLS NOT DISTINCT) ─────
-- PG default NULLS DISTINCT čini stari unique neefektivnim (svaki red ima bar
-- jedan NULL od month/quarter). Scan 25.07: 0 duplikata → čista zamena.
DROP INDEX IF EXISTS "uq_vat_returns_period";
CREATE UNIQUE INDEX "uq_vat_returns_period" ON "vat_returns"
  ("period_year", "period_month", "period_quarter") NULLS NOT DISTINCT;

-- ── 3) DB-004/005/013: UNIQUE identiteti (scan 25.07: 0 duplikata svuda) ─────
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workers_card_id" ON "workers" ("card_id")
  WHERE btrim(card_id) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS "uq_projects_project_number" ON "projects" ("project_number")
  WHERE btrim(project_number) <> '';
CREATE UNIQUE INDEX IF NOT EXISTS "uq_document_types_code" ON "document_types" ("code");
-- NAPOMENA: workers/projects/document_types su BigBit sync-keš — ako izvor ikad
-- donese duplikat, syncer po pravilu §5 preskače red i loguje (skip-ne-abort).
-- items.catalog_number NIJE ovde (DB-081): 1.980 duplikat-grupa čeka čišćenje u
-- BigBit-u; do tada watchdog u monitor-sy15.sh. workers.username ODLOŽEN (duplikati).

-- ── 4) DB-011: numeracija faktura je po firmi — unique dobija company_id ────
DROP INDEX IF EXISTS "uq_invoices_type_number";
CREATE UNIQUE INDEX "uq_invoices_company_type_number" ON "invoices"
  ("company_id", "document_type", "document_number");

-- ── 5) DB-022: parcijalni unique za NULL-scope redove ────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pracenje_notes_project_global" ON "pracenje_notes" ("project_id")
  WHERE work_order_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "uq_predmet_planeri_global_user" ON "predmet_planeri" ("planner_user_id")
  WHERE project_id IS NULL;

-- ── 6) DB-008: FK stavke nacrta primopredaje → crtež ────────────────────────
-- Orphan (1 red, legacy nacrt G-0001/20) saniran na produ pre ove migracije.
ALTER TABLE "handover_draft_items"
  ADD CONSTRAINT "fk_handover_draft_items_drawing"
  FOREIGN KEY ("drawing_id") REFERENCES "drawings"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "handover_draft_items" VALIDATE CONSTRAINT "fk_handover_draft_items_drawing";

-- ── 7) DB-006/007/009/012: CHECK paket (scan 25.07: 0 prljavih u svih 14) ────
-- GL: storno je protiv-nalog, negativno duguje/potražuje nema legitimnu upotrebu.
ALTER TABLE "ledger_entries" ADD CONSTRAINT "chk_ledger_entries_nonnegative"
  CHECK (debit >= 0 AND credit >= 0);
-- Knjižen račun mora imati kupca (SEF/KIF/saldakonti ga pretpostavljaju).
ALTER TABLE "invoices" ADD CONSTRAINT "chk_invoices_posted_customer"
  CHECK (status = 'DRAFT' OR customer_id IS NOT NULL);
ALTER TABLE "invoice_items" ADD CONSTRAINT "chk_invoice_items_qty_discount"
  CHECK (quantity > 0 AND discount_percent BETWEEN 0 AND 100 AND cash_discount_percent BETWEEN 0 AND 100);
ALTER TABLE "stock_document_items" ADD CONSTRAINT "chk_stock_document_items_qty_discount"
  CHECK (quantity > 0 AND discount_percent BETWEEN 0 AND 100);
ALTER TABLE "koop_otpremnica_stavke" ADD CONSTRAINT "chk_koop_stavke_vraceno"
  CHECK (vraceno_kolicina >= 0 AND vraceno_kolicina <= kolicina);
ALTER TABLE "cash_entries" ADD CONSTRAINT "chk_cash_entries_amount_direction"
  CHECK (amount > 0 AND direction IN ('IN', 'OUT'));
ALTER TABLE "interest_rates" ADD CONSTRAINT "chk_interest_rates_interval"
  CHECK (valid_to IS NULL OR valid_to >= valid_from);
ALTER TABLE "customer_discounts" ADD CONSTRAINT "chk_customer_discounts_interval"
  CHECK (valid_to IS NULL OR valid_to >= valid_from);
-- Tačno jedan od (mesec, kvartal) + opsezi — mesec 13 više ne pravi „prazan" period.
ALTER TABLE "vat_returns" ADD CONSTRAINT "chk_vat_returns_period"
  CHECK (num_nonnulls(period_month, period_quarter) = 1
         AND (period_month IS NULL OR period_month BETWEEN 1 AND 12)
         AND (period_quarter IS NULL OR period_quarter BETWEEN 1 AND 4));
ALTER TABLE "dunning_notices" ADD CONSTRAINT "chk_dunning_notices_level"
  CHECK (level IN (1, 2, 3));
-- Kursevi: 0 = legitiman „nije uneto" sentinel (resolver ga preskače, guard E6);
-- CHECK brani samo besmisleno NEGATIVNO.
ALTER TABLE "exchange_rates" ADD CONSTRAINT "chk_exchange_rates_nonnegative"
  CHECK (buy_rate >= 0 AND middle_rate >= 0 AND sell_rate >= 0);

-- Žive tabele sa podacima → NOT VALID pa VALIDATE (bez dugog locka):
ALTER TABLE "work_time_entries" ADD CONSTRAINT "chk_work_time_entries_interval"
  CHECK (stopped_at IS NULL OR stopped_at >= started_at) NOT VALID;
ALTER TABLE "work_time_entries" VALIDATE CONSTRAINT "chk_work_time_entries_interval";
ALTER TABLE "nonconformity_reports" ADD CONSTRAINT "chk_nonconformity_type_status"
  CHECK (type IN (1, 2) AND status IN (0, 1)) NOT VALID;
ALTER TABLE "nonconformity_reports" VALIDATE CONSTRAINT "chk_nonconformity_type_status";

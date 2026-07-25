-- ============================================================================
-- FAZA 3 (DB audit): GL status VELIKA slova + akter statusa + tipovi/preciznost
-- (DB-028, DB-063, DB-025, DB-027; dogovoreno 25.07.2026 — v. DB_AUDIT_REPORT §5)
-- ============================================================================

-- ── 1) DB-028: journal_entries status draft/posted/locked → DRAFT/POSTED/LOCKED
-- Jedina status-familija malim slovima u 4.0 (mešanje u istom modulu je već
-- pravilo tihe greške: filter 'POSTED' nad journal_entries je vraćao 0 redova).
-- Prebačeno DOK JE TABELA PRAZNA na produ; UPDATE je no-op tamo, a dev/test
-- baze sa redovima dobijaju deterministično upper().
UPDATE journal_entries SET status = upper(status) WHERE status <> upper(status);
ALTER TABLE "journal_entries" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- Trigger brana (uvedena 20260725200000) — nova verzija je CASE-ROBUSNA:
-- radi ispravno i da se negde ikad ponovo pojavi lowercase vrednost.
CREATE OR REPLACE FUNCTION trg_journal_entries_guard() RETURNS trigger AS $$
BEGIN
  IF upper(OLD.status) IN ('POSTED', 'LOCKED') THEN
    RAISE EXCEPTION 'POSTED_DELETE_FORBIDDEN: journal_entries id=% status=% — brisanje zabranjeno, koristi storno (reverse).', OLD.id, OLD.status;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

-- ── 2) DB-063: akter poslednje STATUSNE promene naloga ──────────────────────
-- Globalni AuditInterceptor loguje HTTP poziv, ali entitet mora nositi svog
-- aktera (post/lock/unlock/lock-older) — revizorski trag na samom nalogu.
ALTER TABLE "journal_entries" ADD COLUMN "status_changed_by_user_id" INTEGER;
ALTER TABLE "journal_entries" ADD COLUMN "status_changed_at" TIMESTAMPTZ(6);

-- ── 3) DB-025: price_list_entries.price/fee Float → Decimal(19,4) ───────────
-- Novac nikad Float (BACKEND_RULES §2); kolone su mrtve u kodu (pricing čita
-- price_without_vat), ali su bile mamac. Sync i dalje piše brojeve — kompatibilno.
ALTER TABLE "price_list_entries" ALTER COLUMN "price" DROP DEFAULT;
ALTER TABLE "price_list_entries" ALTER COLUMN "price" TYPE numeric(19,4) USING "price"::numeric(19,4);
ALTER TABLE "price_list_entries" ALTER COLUMN "price" SET DEFAULT 0;
ALTER TABLE "price_list_entries" ALTER COLUMN "fee" DROP DEFAULT;
ALTER TABLE "price_list_entries" ALTER COLUMN "fee" TYPE numeric(19,4) USING "fee"::numeric(19,4);
ALTER TABLE "price_list_entries" ALTER COLUMN "fee" SET DEFAULT 0;

-- ── 4) DB-027: preciznost — količine 19,6 / cena 19,4 / kurs 19,6 (standard) ─
-- 3-way match nabavka↔robno je poredio numeric(18,4) sa numeric(19,6); sve su
-- PROŠIRENJA (bez gubitka podataka), tabele male.
ALTER TABLE "purchase_request_items" ALTER COLUMN "quantity" TYPE numeric(19,6);
ALTER TABLE "supplier_rfq_items" ALTER COLUMN "quantity" TYPE numeric(19,6);
ALTER TABLE "purchase_order_items" ALTER COLUMN "ordered_quantity" TYPE numeric(19,6);
ALTER TABLE "purchase_order_items" ALTER COLUMN "received_quantity" TYPE numeric(19,6);
ALTER TABLE "purchase_order_items" ALTER COLUMN "unit_price" TYPE numeric(19,4);
ALTER TABLE "projects" ALTER COLUMN "exchange_rate" TYPE numeric(19,6);

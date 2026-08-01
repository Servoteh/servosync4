-- =============================================================================
-- AVANSI: N:M veza avans ↔ konačni račun (+ avans bez predračuna)
-- =============================================================================
-- Izvor istine: backend/docs/migration/BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md §4.5 i §7 (G1/G2/G5).
--
-- Dokazano produkcijskim podacima BigBit-a (BB_T_25.MDB, 2025):
--   • AVR-00013/2025 (bruto 37.902,00) odbijen je na DVE fakture:
--     IFR 353/25 (20.802,00) + IFR 370/25 (17.100,00) = ceo avans;
--   • IFUSL 059/25 zatvara ŠEST avansnih računa (ukupno 2.812.500,00);
--   • parcijalno korišćenje: T_AVR_Usluge ID=7 (Uk 36.457.095,55 / Koristi 19.772.331,75).
-- BigBit to nosi child tabelama T_AVR_Roba / T_AVR_Usluge (FK IDDok + slobodan
-- BrojDokAVR), ovde je to prava spojna tabela sa FK-ovima na obe strane.
--
-- Naša zatečena šema je dozvoljavala samo 1:1 vezu:
--   invoices.advance_invoice_id (skalar) + parcijalni unique uq_invoices_advance_applied_once.
-- Ovo je migracija koja tu blokadu skida i prevodi postojeće veze na spojnu tabelu.
--
-- Kompatibilnost: kolone invoices.advance_invoice_id / advance_applied_amount /
-- advance_closing_entry_id OSTAJU (SEF BillingReference, štampa, FE, pdv modul), ali od
-- sada su DENORMALIZACIJA aktivnih primena (prva primena + zbir), a ne izvor istine.
--
-- Idempotentno: sve DDL naredbe su IF NOT EXISTS / IF EXISTS, backfill ima NOT EXISTS guard.
-- =============================================================================

-- ── 1) Spojna tabela primena avansa ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "invoice_advance_applications" (
    "id"                 SERIAL         NOT NULL,
    "invoice_id"         INTEGER        NOT NULL,
    "advance_invoice_id" INTEGER        NOT NULL,
    "applied_amount"     DECIMAL(19,4)  NOT NULL,
    "applied_net"        DECIMAL(19,4)  NOT NULL DEFAULT 0,
    "applied_vat"        DECIMAL(19,4)  NOT NULL DEFAULT 0,
    "vat_rate_code"      VARCHAR(5),
    "closing_entry_id"   INTEGER,
    "reversal_entry_id"  INTEGER,
    "status"             VARCHAR(10)    NOT NULL DEFAULT 'ACTIVE',
    "reversed_at"        TIMESTAMPTZ(6),
    "created_by_user_id" INTEGER,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pk_invoice_advance_applications" PRIMARY KEY ("id")
);

-- Primena bez iznosa nema smisla (BigBit dozvoljava 0 i negativne — mi ne).
ALTER TABLE "invoice_advance_applications"
  DROP CONSTRAINT IF EXISTS "ck_invoice_advance_app_amount";
ALTER TABLE "invoice_advance_applications"
  ADD CONSTRAINT "ck_invoice_advance_app_amount" CHECK ("applied_amount" > 0);

ALTER TABLE "invoice_advance_applications"
  DROP CONSTRAINT IF EXISTS "ck_invoice_advance_app_status";
ALTER TABLE "invoice_advance_applications"
  ADD CONSTRAINT "ck_invoice_advance_app_status" CHECK ("status" IN ('ACTIVE','REVERSED'));

-- Avans i račun su ista tabela (invoices) — dva FK-a, oba CASCADE (brisanje drafta
-- ne sme da ostavi visuljke; proknjižen dokument se ionako ne briše nego stornira).
ALTER TABLE "invoice_advance_applications"
  DROP CONSTRAINT IF EXISTS "fk_invoice_advance_app_invoice";
ALTER TABLE "invoice_advance_applications"
  ADD CONSTRAINT "fk_invoice_advance_app_invoice"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "invoice_advance_applications"
  DROP CONSTRAINT IF EXISTS "fk_invoice_advance_app_advance";
ALTER TABLE "invoice_advance_applications"
  ADD CONSTRAINT "fk_invoice_advance_app_advance"
  FOREIGN KEY ("advance_invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_invoice_advance_app_invoice"
  ON "invoice_advance_applications" ("invoice_id");
CREATE INDEX IF NOT EXISTS "idx_invoice_advance_app_advance"
  ON "invoice_advance_applications" ("advance_invoice_id");
CREATE INDEX IF NOT EXISTS "idx_invoice_advance_app_entry"
  ON "invoice_advance_applications" ("closing_entry_id");

-- Isti avans sme biti AKTIVNO primenjen najviše jednom na istom računu (dupli klik).
-- Više primena istog avansa na RAZLIČITIM računima je sada dozvoljeno (to je ceo cilj).
-- Storno (status='REVERSED') oslobađa slot, pa se avans može ponovo iskoristiti.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_invoice_advance_app_active"
  ON "invoice_advance_applications" ("invoice_id", "advance_invoice_id")
  WHERE "status" = 'ACTIVE';

-- ── 2) Osnov avansa bez predračuna (BigBit: avans po UGOVORU) ───────────────
ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "advance_basis" VARCHAR(255);

-- ── 3) Skini 1:1 blokadu ────────────────────────────────────────────────────
-- uq_invoices_advance_applied_once je dozvoljavao jedan avans na TAČNO JEDNOM računu;
-- N:M kontrolu („Σ primena ≤ naplaćeni avans") od sada radi AdvanceInvoiceService u
-- transakciji sa advisory lock-om, a duple primene na ISTOM računu hvata
-- uq_invoice_advance_app_active iznad.
DROP INDEX IF EXISTS "uq_invoices_advance_applied_once";

-- ── 4) Backfill postojećih 1:1 veza u spojnu tabelu ─────────────────────────
-- Osnovica/PDV se izvode iz odnosa neto/bruto samog avansnog računa (ista srazmera
-- kao grossToNet u servisu). Storniran konačni račun se NE prenosi (njegova veza je
-- mrtva). Guard NOT EXISTS čini korak ponovljivim.
INSERT INTO "invoice_advance_applications" (
    "invoice_id", "advance_invoice_id", "applied_amount", "applied_net", "applied_vat",
    "vat_rate_code", "closing_entry_id", "status", "created_at", "updated_at"
)
SELECT
    src."invoice_id",
    src."advance_invoice_id",
    src."applied_amount",
    src."applied_net",
    src."applied_amount" - src."applied_net" AS "applied_vat",
    src."vat_rate_code",
    src."closing_entry_id",
    'ACTIVE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (
    SELECT
        f."id"                    AS "invoice_id",
        f."advance_invoice_id"    AS "advance_invoice_id",
        f."advance_applied_amount" AS "applied_amount",
        ROUND(
          f."advance_applied_amount" *
          CASE WHEN a."gross_total" > 0 THEN a."net_total" / a."gross_total" ELSE 1 END, 2
        )                          AS "applied_net",
        (SELECT ii."vat_rate_code" FROM "invoice_items" ii
          WHERE ii."invoice_id" = a."id" ORDER BY ii."line_no" LIMIT 1) AS "vat_rate_code",
        f."advance_closing_entry_id" AS "closing_entry_id"
    FROM "invoices" f
    JOIN "invoices" a ON a."id" = f."advance_invoice_id"
    WHERE f."advance_invoice_id" IS NOT NULL
      AND f."status" <> 'CANCELLED'
      AND f."advance_applied_amount" > 0
) src
WHERE NOT EXISTS (
    SELECT 1 FROM "invoice_advance_applications" x
     WHERE x."invoice_id" = src."invoice_id"
       AND x."advance_invoice_id" = src."advance_invoice_id"
);

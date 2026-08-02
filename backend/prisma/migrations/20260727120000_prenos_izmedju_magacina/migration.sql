-- =============================================================================
-- GRUPA C — PRENOS IZMEĐU MAGACINA (međuskladišnica) 27.07.2026
-- =============================================================================
-- Zašto: `stock_documents` je do danas znao SAMO za jedan magacin po dokumentu
-- (`warehouse_id`), a stanje se svuda (lager, kartica artikla, costing, guard
-- negativnog stanja) računa kao Σ(±količina) po `stock_document_items.warehouse_id`
-- sa znakom iz `document_types.is_inbound`. Jedan dokument = JEDAN znak = JEDAN
-- magacin. Zato je „prenos" razduživao izvor i NIGDE ne zaduživao odredište —
-- `target_warehouse_id` nije čitao nijedan obračun stanja (samo KEPU vrednosno).
--
-- Rešenje je da prenos bude PAR dokumenata (izlaz iz izvora + ulaz u odredište),
-- napravljen u JEDNOJ transakciji i međusobno povezan. Ova migracija donosi:
--
--   A) `stock_documents.transfer_pair_doc_id` — veza izlaz ↔ ulaz (obostrana).
--      Bez nje se par ne može ni prikazati, ni stornirati, ni sprečiti da neko
--      obriše samo jednu stranu i opet izgubi zalihu.
--   B) `stock_documents.reversal_of_doc_id` — storno-veza (novi dokument pokazuje
--      koji dokument poništava). PARCIJALNI UNIQUE: jedan dokument sme biti
--      storniran NAJVIŠE JEDNOM (bez toga bi dvostruki storno duplo zadužio
--      izvorni magacin i opet napravio lažnu zalihu — u suprotnom smeru).
--   C) vrste dokumenata `PREIZ` (prenos izlaz) i `PREUL` (prenos ulaz) — bez njih
--      prenos ne može ni da nastane (`document_types.code` se validira pri upisu),
--      a par mora imati dva tipa jer se ZNAK zalihe izvodi iz `is_inbound`.
--   D) vrsta `IFR` (izlazna faktura — roba/izdatnica). `robno/carry-over.service.ts`
--      je koristi kao podrazumevanu vrstu za prepis fakture u izdatnicu, a nijedna
--      isporučena migracija je nije sejala →
--      izdatnica na svežoj bazi pada sa 422 „Tip dokumenta 'IFR' ne postoji"
--      (nalaz §3.18 / C14 iz PREGLED_DOKUMENATA_4.0).
--
-- `posting_template` za PREIZ/PREUL je namerno 0 (nema šeme kontiranja): prenos
-- između sopstvenih magacina ne menja imovinu firme, pa u glavnu knjigu ne ide.
-- KEPU (robna evidencija po magacinu) se svejedno vodi — piše ga robni tok.
--
-- SVE je aditivno i idempotentno (IF NOT EXISTS / WHERE NOT EXISTS).
-- =============================================================================

-- ─── A) + B) veza para i storno-veza ─────────────────────────────────────────

ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS transfer_pair_doc_id INTEGER;
ALTER TABLE stock_documents ADD COLUMN IF NOT EXISTS reversal_of_doc_id   INTEGER;

COMMENT ON COLUMN stock_documents.transfer_pair_doc_id IS
  'Parni dokument prenosa (izlaz iz izvornog ↔ ulaz u odredišni magacin). Meki ref stock_documents.id — bez FK jer je veza obostrana i nastaje u istoj transakciji.';
COMMENT ON COLUMN stock_documents.reversal_of_doc_id IS
  'Dokument koji ovaj dokument STORNIRA (poništava). Parcijalni unique: jedan dokument sme biti storniran najviše jednom.';

CREATE INDEX IF NOT EXISTS idx_stock_documents_transfer_pair
  ON stock_documents (transfer_pair_doc_id)
  WHERE transfer_pair_doc_id IS NOT NULL;

-- Parcijalni UNIQUE (a ne obični) — NULL-ovi u Postgresu nisu jednaki, ali
-- parcijalni indeks je jeftiniji i eksplicitno kaže šta se čuva: nema dva storna
-- istog dokumenta.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_documents_reversal_of
  ON stock_documents (reversal_of_doc_id)
  WHERE reversal_of_doc_id IS NOT NULL;

-- ─── C) vrste dokumenata za prenos ───────────────────────────────────────────
-- PREIZ mora imati is_inbound = FALSE (razdužuje izvorni magacin),
-- PREUL mora imati is_inbound = TRUE  (zadužuje odredišni magacin).
-- Obe utiču na zalihe (affects_stock = TRUE) i obe su interni dokument.

INSERT INTO "document_types"
  ("code", "description", "is_inbound", "affects_stock", "is_internal_document",
   "posting_template", "post_in_vat_ledger")
SELECT 'PREIZ', 'Prenos između magacina — izlaz', false, true, true, 0, false
WHERE NOT EXISTS (SELECT 1 FROM "document_types" WHERE "code" = 'PREIZ');

INSERT INTO "document_types"
  ("code", "description", "is_inbound", "affects_stock", "is_internal_document",
   "posting_template", "post_in_vat_ledger")
SELECT 'PREUL', 'Prenos između magacina — ulaz', true, true, true, 0, false
WHERE NOT EXISTS (SELECT 1 FROM "document_types" WHERE "code" = 'PREUL');

-- Ako su redovi zatečeni iz ranijeg ručnog unosa sa pogrešnim smerom, ISPRAVI —
-- pogrešan `is_inbound` na ovim dvema vrstama je upravo bag koji ova migracija
-- zatvara (prenos bi opet bio jednostran).
UPDATE "document_types"
   SET "is_inbound" = false, "affects_stock" = true
 WHERE "code" = 'PREIZ' AND ("is_inbound" IS DISTINCT FROM false OR "affects_stock" IS DISTINCT FROM true);

UPDATE "document_types"
   SET "is_inbound" = true, "affects_stock" = true
 WHERE "code" = 'PREUL' AND ("is_inbound" IS DISTINCT FROM true OR "affects_stock" IS DISTINCT FROM true);

-- ─── D) izlazna vrsta za izdatnicu (nalaz §3.18) ─────────────────────────────

INSERT INTO "document_types"
  ("code", "description", "is_inbound", "affects_stock")
SELECT 'IFR', 'Izlazna faktura — roba (izdatnica)', false, true
WHERE NOT EXISTS (SELECT 1 FROM "document_types" WHERE "code" = 'IFR');

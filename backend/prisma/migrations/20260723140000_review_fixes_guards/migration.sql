-- Review fixevi (adversarijalni review 23.07) — DB guardi protiv duplih zapisa.
-- Aditivno: samo dodaje partial unique index, ne dira podatke.

-- Jedna narudžbenica sme dati najviše JEDAN robni ulaz (zatvara TOCTOU dvostrukog
-- prijema u nabavka.receiveOrder — findFirst→create nije atomičan). Partial: samo
-- za redove sa purchase_order_id (robni dokumenti bez PO nisu ograničeni).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_stock_documents_po"
  ON "stock_documents" ("purchase_order_id")
  WHERE "purchase_order_id" IS NOT NULL;

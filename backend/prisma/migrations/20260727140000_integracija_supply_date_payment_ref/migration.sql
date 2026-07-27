-- =============================================================================
-- INTEGRACIJA TALASA (27.07.2026) — dva polja koja RAČUN već ume da pošalje,
-- ali ih nema gde da upiše.
-- =============================================================================
-- KONTEKST: grupa D (SEF/UBL) je pripremila `cac:Delivery` i `cac:PaymentMeans` i
-- oba bloka DEFANZIVNO čekaju kolone koje je trebalo da doda grupa B. Grupa B ih
-- nije dodala (njen paket je pokrio `stock_documents`, `companies` i
-- `document_prints`), pa su ta dva bloka ostala trajno nema:
--
--   A) `invoices.supply_date` — DATUM PROMETA DOBARA I USLUGA (BT-72).
--      Propisan sadržaj računa po ZPDV čl. 42 i obavezan element e-fakture.
--      `UblInvoiceInput.supplyDate` postoji i `buildDelivery` ga ume ispisati, ali
--      izvora nije bilo, pa se `cac:Delivery` NIKAD nije emitovao.
--      NULLABLE i BEZ default-a: datum prometa se NE SME izvoditi iz `document_date`
--      (datum izdavanja je drugi podatak i često drugi dan) — dok ga niko ne unese,
--      blok izostaje, što je pošteno; lažan datum prometa je poreski problem.
--
--   B) `invoices.payment_reference` — POZIV NA BROJ (BT-83) za `cac:PaymentMeans`.
--      Do sada je UBL slao broj dokumenta kao zamenu (BigBit paritet). Sa ovom
--      kolonom banka dobija poziv na broj kakav je stvarno ugovoren, a fallback na
--      broj dokumenta ostaje za račune bez njega — ne uvodi se prazno polje.
--
-- Sve ADITIVNO i IDEMPOTENTNO (ADD COLUMN IF NOT EXISTS), sve NULLABLE bez
-- default-a — nijedan postojeći red ne pada i ništa se ne izmišlja.
--
-- REDOSLED MIGRACIJA U OVOM TALASU (bitno pri spajanju grana):
--   20260727110000  uslovi otpreme + IBAN/SWIFT + document_prints   (grupa B)
--   20260727120000  prenos između magacina (PREIZ/PREUL/IFR)        (grupa C)
--   20260727140000  ovo                                             (integracija)
-- Grupa C piše `stock_documents.note`, a tu kolonu uvodi 110000 — dakle 110000
-- MORA ići pre 120000. Timestampi to garantuju; ne preimenovati foldere.
-- =============================================================================

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "supply_date" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "payment_reference" VARCHAR(50);

COMMENT ON COLUMN "invoices"."supply_date" IS
  'Datum prometa dobara i usluga (BT-72, ZPDV čl. 42) → UBL cac:Delivery/cbc:ActualDeliveryDate. NIKAD se ne izvodi iz document_date: datum izdavanja računa je drugi podatak. NULL = nije unet, blok cac:Delivery se ne emituje.';

COMMENT ON COLUMN "invoices"."payment_reference" IS
  'Poziv na broj (BT-83) → UBL cac:PaymentMeans/cbc:PaymentID. NULL = koristi se broj dokumenta kao poziv na broj (BigBit paritet, Module__ER_Module).';

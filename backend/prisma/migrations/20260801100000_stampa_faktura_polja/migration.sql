-- Štampa izlaznih faktura, korak 3 (backend/docs/STAMPA_FAKTURA_GAP.md §4):
-- podaci bez kojih se pet donetih BigBit obrazaca ne mogu odštampati.
-- Sve je ADITIVNO i NULLABLE — nijedna postojeća kolona se ne menja, zatečeni računi ostaju validni.
-- Imena/tipovi preuzeti iz legacy "goods_documents" gde tamo isti podatak već postoji
-- (shipment_method, fco, payment_method, warehouse_id).

-- ── Invoice: podaci dokumenta ────────────────────────────────────────────────
ALTER TABLE "invoices"
  -- „Robu izdao → iz magacina <naziv>" (jedina razlika IFR ↔ IFGP). Meki ref warehouses.id.
  -- NULLABLE (za razliku od goods_documents.warehouse_id NOT NULL DEFAULT 1): usluga nema magacin,
  -- a zatečenim računima bi podmetnuta „1" odštampala pogrešan magacin.
  ADD COLUMN IF NOT EXISTS "warehouse_id"           INTEGER,
  -- Traka uslova domaće robne fakture: FCO | način plaćanja | način otpreme | datum prometa.
  ADD COLUMN IF NOT EXISTS "fco"                    VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "shipment_method"        VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "payment_method"         VARCHAR(50),
  -- ⚠️ Datum prometa NIJE ovde. Ova migracija je 01.08.2026. dodavala i
  -- "delivery_date" za taj podatak, ali ga je migracija 20260727140000 već uvela kao
  -- "invoices"."supply_date" (BT-72, UBL cbc:ActualDeliveryDate). Pri spajanju grana
  -- 02.08.2026. je kolona uklonjena odavde: dve kolone za jedan obavezan element
  -- računa znače da polovina koda čita praznu. Produkcijska tabela "invoices" je bila
  -- prazna, pa nije bilo podataka za prenos.
  -- Broj izvozne deklaracije / JCI na ino robnoj fakturi (do sada se lepio u "note").
  ADD COLUMN IF NOT EXISTS "customs_declaration_no" VARCHAR(30),
  -- Otpremni blok ino usluge (Invoice 060/26): paritet, kolete, dimenzije, težine, istovar, špediter.
  ADD COLUMN IF NOT EXISTS "delivery_term"          VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "package_description"    VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "package_dimensions"     VARCHAR(60),
  ADD COLUMN IF NOT EXISTS "gross_weight_kg"        DECIMAL(19,3),
  ADD COLUMN IF NOT EXISTS "net_weight_kg"          DECIMAL(19,3),
  ADD COLUMN IF NOT EXISTS "unloading_place"        TEXT,
  ADD COLUMN IF NOT EXISTS "forwarder_contact"      TEXT;

-- ── InvoiceItem: jedinica mere na stavci ─────────────────────────────────────
-- Kolona „j.m." / „Unit" na sva četiri obrasca. Pamti se na stavci, jer slobodna uslužna stavka
-- (item_id IS NULL) nema artikal iz kog bi se izvela.
ALTER TABLE "invoice_items"
  ADD COLUMN IF NOT EXISTS "unit" VARCHAR(5);

-- ── PaymentAccount: bankarske instrukcije za ino fakturu ─────────────────────
-- Blok „Beneficiary Customer / Bank of beneficiary" na ino fakturama. Štampa ova polja već
-- očekuje (IssuerInfo.iban/swift), ali ih do sada nije imala odakle napuniti — mrtav kod.
ALTER TABLE "payment_accounts"
  ADD COLUMN IF NOT EXISTS "iban"         VARCHAR(34),
  ADD COLUMN IF NOT EXISTS "swift"        VARCHAR(11),
  ADD COLUMN IF NOT EXISTS "bank_address" TEXT,
  ADD COLUMN IF NOT EXISTS "currency"     VARCHAR(3);

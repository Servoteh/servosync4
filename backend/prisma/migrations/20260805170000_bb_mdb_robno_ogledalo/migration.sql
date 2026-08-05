-- =============================================================================
-- ROBNO OGLEDALO IZ BIGBITA (05.08.2026) — lager lista + kartice artikla
-- -----------------------------------------------------------------------------
-- 🔴 ZAŠTO: 4.0 robne tabele su na produkciji PRAZNE (mereno: stock_documents 0,
-- stock_levels 0, stock_reservations 0, purchase_orders 0). Robno se vodi
-- ISKLJUČIVO u BigBitu. MSSQL kanal koji je nekad punio `goods_*_mirror` je
-- MRTAV od 22.07.2026; jedini živ kanal je noćni .mdb izvoz (17:30 / 03:45).
--
-- ŠTA RADI:
--   1) proširuje POSTOJEĆA ogledala `goods_documents_mirror` /
--      `goods_document_items_mirror` (obe prazne na produ) poljima bez kojih se
--      stanje ne može izračunati: smer prometa, level, rezervacija, magacin,
--      sirova količina;
--   2) uvodi ogledalo narudžbenica `purchase_orders_mirror` /
--      `purchase_order_items_mirror` (BigBit T_Trebovanja) — ODVOJENO od
--      4.0-native `purchase_orders`, koji ostaje netaknut;
--   3) uvodi četiri `bb_mdb_stage_*` tabele koje puni izvozna skripta.
--
-- FORMULA LAGERA (BigBit paritet):
--   stanje      = SUM(quantity_in) - SUM(quantity_out)  nad `level = 0`
--   rezervisano = SUM(quantity)                         nad `is_reservation`
--   slobodno    = stanje - rezervisano
-- Magacin se uzima SA STAVKE (`goods_document_items_mirror.warehouse_id`),
-- nikad sa zaglavlja — jedan dokument nosi stavke iz više magacina.
--
-- NE DIRA: `items` (ni sekvencu), šifarnike, nijedan seed, nijednu 4.0-native
-- robnu tabelu. Sve nove kolone su nullable ili sa difoltom, pa `sync-map`
-- deklaracija starog MSSQL kanala (tri kolone na `goods_documents_mirror`)
-- ostaje upotrebljiva.
-- =============================================================================

-- ── 1) goods_documents_mirror: zaglavlje robnog dokumenta ───────────────────
ALTER TABLE "goods_documents_mirror"
  ADD COLUMN "document_number"  VARCHAR(50),
  ADD COLUMN "posting_date"     DATE,
  ADD COLUMN "is_inflow"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "level"            SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "is_reservation"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "warehouse_id"     INTEGER,
  ADD COLUMN "customer_id"      INTEGER,
  ADD COLUMN "project_id"       INTEGER,
  ADD COLUMN "is_locked"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "year"             INTEGER,
  ADD COLUMN "imported_drop_id" INTEGER;

CREATE INDEX "idx_goods_documents_mirror_level" ON "goods_documents_mirror"("level");
CREATE INDEX "idx_goods_documents_mirror_reservation" ON "goods_documents_mirror"("is_reservation");
CREATE INDEX "idx_goods_documents_mirror_imported_drop" ON "goods_documents_mirror"("imported_drop_id");

ALTER TABLE "goods_documents_mirror" ADD CONSTRAINT "fk_goods_documents_mirror_imported_drop"
  FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 2) goods_document_items_mirror: stavka ──────────────────────────────────
-- `quantity` je SIROVA BigBit `Kolicina` UZ postojeće quantity_in/quantity_out:
-- in/out je izvedena podela po smeru zaglavlja i zgodna za SUM(in)-SUM(out), ali
-- se REZERVISANO po BigBit paritetu računa kao SUM(Kolicina) nad dokumentima sa
-- Rezervisi=True, bez obzira na smer.
ALTER TABLE "goods_document_items_mirror"
  ADD COLUMN "quantity"               DECIMAL(18,4),
  ADD COLUMN "kg_quantity"            DECIMAL(18,4),
  ADD COLUMN "purchase_price_net"     DECIMAL(19,4),
  ADD COLUMN "actual_wholesale_price" DECIMAL(19,4),
  ADD COLUMN "actual_retail_price"    DECIMAL(19,4),
  ADD COLUMN "discount_percent"       DECIMAL(9,4),
  ADD COLUMN "item_description"       VARCHAR(255);

-- Lager grupiše po (artikal, magacin) nad ~182.500 stavki — bez ovog indeksa je
-- svaki prikaz stanja pun prolaz kroz tabelu.
CREATE INDEX "idx_goods_document_items_mirror_item_wh" ON "goods_document_items_mirror"("item_id", "warehouse_id");
CREATE INDEX "idx_goods_document_items_mirror_document" ON "goods_document_items_mirror"("document_id");

-- ── 3) Ogledalo narudžbenica (T_Trebovanja) ─────────────────────────────────
-- ⚠️ NIJE `purchase_orders`: taj model je 4.0-native (status-mašina, sopstvena
-- numeracija) i ostaje prazan dok se narudžbenice ne presele u 4.0.
CREATE TABLE "purchase_orders_mirror" (
    "id" INTEGER NOT NULL,
    "order_number" VARCHAR(50),
    "order_date" DATE,
    "supplier_id" INTEGER,
    "project_id" INTEGER,
    "note" TEXT,
    "level" SMALLINT NOT NULL DEFAULT 0,
    "is_ordered" BOOLEAN NOT NULL DEFAULT false,
    "year" INTEGER,
    "imported_drop_id" INTEGER,

    CONSTRAINT "purchase_orders_mirror_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "purchase_order_items_mirror" (
    "id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "ordered_quantity" DECIMAL(19,6),
    "received_quantity" DECIMAL(19,6),
    "unit_price" DECIMAL(19,4),
    "discount_percent" DECIMAL(9,4),
    "description" VARCHAR(255),
    "expected_delivery_date" DATE,
    -- `actual_delivery_date`, NIKAD `delivery_date`: to ime je u ovom repou značilo tri
    -- različite stvari i prvi sudar je proizveo pogrešan zakonski rok od 15 dana na
    -- ulaznim fakturama (razrešeno 02.08.2026; branu drži sales/datum-prometa.spec.ts).
    "actual_delivery_date" DATE,
    "is_delivered" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_items_mirror_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_purchase_orders_mirror_level" ON "purchase_orders_mirror"("level");
CREATE INDEX "idx_purchase_orders_mirror_supplier" ON "purchase_orders_mirror"("supplier_id");
CREATE INDEX "idx_purchase_orders_mirror_imported_drop" ON "purchase_orders_mirror"("imported_drop_id");
CREATE INDEX "idx_purchase_order_items_mirror_item" ON "purchase_order_items_mirror"("item_id");
CREATE INDEX "idx_purchase_order_items_mirror_order" ON "purchase_order_items_mirror"("order_id");

ALTER TABLE "purchase_orders_mirror" ADD CONSTRAINT "fk_purchase_orders_mirror_imported_drop"
  FOREIGN KEY ("imported_drop_id") REFERENCES "bb_mdb_drops"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_order_items_mirror" ADD CONSTRAINT "fk_purchase_order_items_mirror_order"
  FOREIGN KEY ("order_id") REFERENCES "purchase_orders_mirror"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 4) Staging (`bb_mdb_stage_*`) ───────────────────────────────────────────
-- Sve kolone TEXT — tipizacija je posao uvoza (korak 2), da bajat red padne tamo
-- gde se može imenovati, a ne na `COPY` sa porukom o broju kolone.
--
-- 🔴 REDOSLED KOLONA JE UGOVOR: `\copy` ide bez liste kolona, a INSERT u staging
-- je POZICIONI (`SELECT nextval(), drop_id, t."Kol1", …`). Ove četiri tabele su
-- JEDINE koje se uzimaju PROJEKTOVANO — zaglavlje se poredi CELO (61/37/27/20
-- kolona), a prepisuje se samo `PICK` podskup iz bigbit-mdb-export.sh. Promena
-- redosleda ovde bez promene u skripti tiho upisuje u pogrešnu kolonu.
CREATE TABLE "bb_mdb_stage_robna_dokumenta" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "id_dok" TEXT,
    "ulaz" TEXT,
    "broj_dokumenta" TEXT,
    "vrsta_dokumenta" TEXT,
    "sifra_komitenta" TEXT,
    "datum_dokumenta" TEXT,
    "datum_knjizenja" TEXT,
    "id_magacin_dok" TEXT,
    "level" TEXT,
    "id_predmet" TEXT,
    "zakljucano" TEXT,
    "rezervisi" TEXT,
    "godina" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_robna_dokumenta" PRIMARY KEY ("id")
);

CREATE TABLE "bb_mdb_stage_robne_stavke" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "id_stavke" TEXT,
    "id_dok" TEXT,
    "sifra_artikla" TEXT,
    "kolicina" TEXT,
    "kg_kolicina" TEXT,
    "nabavna_cena_neto" TEXT,
    "stvarna_vp_cena" TEXT,
    "stvarna_mp_cena" TEXT,
    "rabat_proc" TEXT,
    "id_magacin" TEXT,
    "opis_stavke" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_robne_stavke" PRIMARY KEY ("id")
);

CREATE TABLE "bb_mdb_stage_trebovanja" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "id_treb" TEXT,
    "broj_trebovanja" TEXT,
    "datum_trebovanja" TEXT,
    "sifra_komitenta" TEXT,
    "id_predmet" TEXT,
    "napomena" TEXT,
    "level" TEXT,
    "poruceno" TEXT,
    "godina" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_trebovanja" PRIMARY KEY ("id")
);

CREATE TABLE "bb_mdb_stage_trebovanja_stavke" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "id_stavke" TEXT,
    "id_treb" TEXT,
    "sifra_artikla" TEXT,
    "treb_kol" TEXT,
    "isporucena_kolicina" TEXT,
    "cena" TEXT,
    "opis" TEXT,
    "ocekivani_datum_isporuke" TEXT,
    "datum_isporuke" TEXT,
    "isporuceno" TEXT,
    "rabat_proc" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_trebovanja_stavke" PRIMARY KEY ("id")
);

CREATE INDEX "idx_bb_mdb_stage_robna_dokumenta_drop" ON "bb_mdb_stage_robna_dokumenta"("drop_id");
CREATE INDEX "idx_bb_mdb_stage_robne_stavke_drop" ON "bb_mdb_stage_robne_stavke"("drop_id");
CREATE INDEX "idx_bb_mdb_stage_trebovanja_drop" ON "bb_mdb_stage_trebovanja"("drop_id");
CREATE INDEX "idx_bb_mdb_stage_trebovanja_stavke_drop" ON "bb_mdb_stage_trebovanja_stavke"("drop_id");

ALTER TABLE "bb_mdb_stage_robna_dokumenta" ADD CONSTRAINT "fk_bb_mdb_stage_robna_dokumenta_drop"
  FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bb_mdb_stage_robne_stavke" ADD CONSTRAINT "fk_bb_mdb_stage_robne_stavke_drop"
  FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bb_mdb_stage_trebovanja" ADD CONSTRAINT "fk_bb_mdb_stage_trebovanja_drop"
  FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bb_mdb_stage_trebovanja_stavke" ADD CONSTRAINT "fk_bb_mdb_stage_trebovanja_stavke_drop"
  FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

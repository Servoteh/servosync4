-- TALAS B — 6 BigBit child tabela koje postoje SAMO u `.mdb` originalu
-- (nema ih u QBigTehn MSSQL kopiji, pa ih `src/modules/sync` ne moze ni videti).
-- Puni ih iskljucivo `tools/bigbit-bridge` (mdb-export -> CSV -> `\copy` stage ->
-- INSERT ON CONFLICT DO UPDATE); aplikacija ih samo CITA (BACKEND_RULES §3).
--
-- Izvori: docs/migration/BIGBIT_KOMITENTI.md §2.1/§2.2 i BIGBIT_ARTIKLI.md
-- §2.1/§2.2/§3.1/§3.2; originalni DDL u docs/migration/BB_T_26_schema.sql.
--
-- ADITIVNO: nijedna postojeca tabela se ne dira, nema backfill-a, nema data-migracije.
--
-- ================== ZASTO NEMA NIJEDNOG FOREIGN KEY-a ==================
-- Sve reference (customer_id, item_id, supplier_id, salesperson_id, route_id,
-- driver_id, payment_account_id) su MEKE — obicne INTEGER kolone bez FK constraint-a:
--
--   1) BRIDGE NEMA FK-RESOLVE KORAK. Za razliku od `customer.syncer.ts` (koji
--      nerazresive FK-ove null-uje red po red, BACKEND_RULES §5), bridge radi jedan
--      set-based UPSERT po tabeli u JEDNOJ transakciji. Tvrd FK bi na prvom siroceti
--      (kontakt komitenta obrisanog u BigBit-u, barkod artikla koji jos nije stigao u
--      `items`) oborio CELU tabelu — umesto jednog preskocenog reda dobili bismo nula
--      redova. Legacy izvor sirocad ima; to je zateceno stanje, ne greska uvoza.
--
--   2) `item_*.item_id` NIJE `items.id` NEGO `items.external_item_id`. `items.id` je
--      QBigTehn-lokalni IDENTITY iz kopije, a BigBit sifra artikla zivi odvojeno u
--      `external_item_id` (BIGBIT_ARTIKLI.md §5.1). Nad `external_item_id` NEMA UNIQUE
--      constraint-a (ima duplih 0 za redove bez BigBit parnjaka), pa FK tehnicki i nije
--      moguc. Citanje ide preko `external_item_id`, nikad preko `items.id`.
--      `customer_*.customer_id` se, nasuprot tome, poklapa sa `customers.id` 1:1
--      (BIGBIT_KOMITENTI.md §5.1 — PK komitenta se pri transferu NE remapira).
--
-- Zato svaka child tabela dobija `idx_*` po roditeljskom kljucu: on je jedini put
-- do reda (nema FK indeksa koji bi to pokrio) i nosi sve upite kartona.

-- ---------------------------------------------------------------- KOMITENT: kontakti
-- Was: KomitentiKontaktOsobe (BB_T_26_schema.sql:429-440)
CREATE TABLE "customer_contacts" (
  "id"             SERIAL       NOT NULL,
  "customer_id"    INTEGER      NOT NULL,
  "contact_person" VARCHAR(50),
  "phone"          VARCHAR(20),
  "fax"            VARCHAR(20),
  "mobile"         VARCHAR(20),
  "email"          VARCHAR(50),
  "birth_date"     TIMESTAMP(6),
  -- KontaktDefault: podrazumevana kontakt osoba komitenta.
  "is_default"     BOOLEAN      NOT NULL DEFAULT false,
  CONSTRAINT "pk_customer_contacts" PRIMARY KEY ("id")
);

CREATE INDEX "idx_customer_contacts_customer" ON "customer_contacts" ("customer_id");

-- ---------------------------------------------------------- KOMITENT: mesta isporuke
-- Was: MestaIsporuke (BB_T_26_schema.sql:2499-2521). Svaka lokacija nosi SVOJ GLN,
-- uplatni racun, rutu/vozaca i prodavca — prakticno pod-komitent.
CREATE TABLE "customer_delivery_locations" (
  "id"                 SERIAL      NOT NULL,
  "customer_id"        INTEGER     NOT NULL,
  -- NazivMestaIsporuke, npr. „Magacin 2" / „Filijala Novi Sad".
  "name"               VARCHAR(50) NOT NULL,
  "city"               VARCHAR(30),
  "address"            VARCHAR(50),
  "phone"              VARCHAR(20),
  -- Podrucje: podrucje/region isporuke (slobodan tekst, ne sifarnik).
  "area"               VARCHAR(30),
  "fax"                VARCHAR(20),
  -- SifraProdavcaMestaIsporuke: moze se razlikovati od glavnog prodavca komitenta.
  "salesperson_id"     INTEGER,
  "contract_category"  VARCHAR(30),
  "general_category"   VARCHAR(30),
  "sales_channel"      VARCHAR(30),
  "route_id"           INTEGER,
  "driver_id"          INTEGER,
  "payment_account_id" INTEGER,
  -- GLN PO LOKACIJI (nije isti kao customers.gln) — regulatorno bitno za SEF.
  "gln"                VARCHAR(30),
  "region"             INTEGER,
  -- AktivnoMISP.
  "active"             BOOLEAN     NOT NULL DEFAULT true,
  "postal_code"        VARCHAR(20),
  -- BrojMestaIsporuke: interni broj lokacije kod komitenta.
  "location_number"    VARCHAR(20),
  CONSTRAINT "pk_customer_delivery_locations" PRIMARY KEY ("id")
);

CREATE INDEX "idx_delivery_locations_customer"
  ON "customer_delivery_locations" ("customer_id");

-- ------------------------------------------------------------------ ARTIKAL: barkodovi
-- Was: R_Artikli_BarKod (BB_T_26_schema.sql:1001-1007). `items.bar_code` je samo
-- PRIMARNI barkod; ovde su barkodovi ambalaza sa mnoziocem kolicine.
CREATE TABLE "item_barcodes" (
  "id"           SERIAL         NOT NULL,
  -- BIGBIT sifra artikla -> items.external_item_id (NE items.id!), v. zaglavlje.
  "item_id"      INTEGER        NOT NULL,
  "bar_code"     VARCHAR(20)    NOT NULL,
  -- MultiFaktor: kutija od 12 kom -> 12, pojedinacni komad -> 1.
  -- Access Currency -> DECIMAL(19,4), nikad Float (BACKEND_RULES §2).
  "multi_factor" DECIMAL(19, 4) NOT NULL DEFAULT 1,
  CONSTRAINT "pk_item_barcodes" PRIMARY KEY ("id")
);

CREATE INDEX "idx_item_barcodes_item" ON "item_barcodes" ("item_id");
-- Nosilac lookup-a „skeniran barkod -> artikal" (razlog postojanja tabele;
-- BigBit VBA `F_IDArtikalZaBarKod` gadja tacno ovaj predikat).
CREATE INDEX "idx_item_barcodes_bar_code" ON "item_barcodes" ("bar_code");

-- --------------------------------------------------------------------- ARTIKAL: prevodi
-- Was: R_Artikli_Ino (BB_T_26_schema.sql:1009-1015). Izvor NEMA surogat id kolonu —
-- PK je poslovni par (IDArtikal, IDJezik). Taj PK vec indeksira "item_id" kao vodecu
-- kolonu, pa zaseban indeks po "item_id" ne bi doneo nista osim troska pri upisu.
CREATE TABLE "item_translations" (
  -- BIGBIT sifra artikla -> items.external_item_id (NE items.id!), v. zaglavlje.
  "item_id"      INTEGER     NOT NULL,
  -- IDJezik: sifarnik jezika NIJE pronadjen u BigBit izvozu (BIGBIT_ARTIKLI.md §8/4),
  -- pa ostaje go broj dok se ne utvrdi koji ID je koji jezik.
  "language_id"  INTEGER     NOT NULL,
  "foreign_name" VARCHAR(50) NOT NULL,
  "foreign_unit" VARCHAR(5),
  CONSTRAINT "pk_item_translations" PRIMARY KEY ("item_id", "language_id")
);

-- ------------------------------------------------------------------- ARTIKAL: kvalitet
-- Was: R_KvalitetArtikla (BB_T_26_schema.sql:1023-1028). Ciljna tabela za
-- items.quality_type_id, koji je do sada visio u prazno.
-- "id" je INTEGER bez sekvence: vrednost dolazi iz BigBit-a (legacy dodela), nikad
-- se ne generise ovde — zato NEMA SERIAL i nema setval-a u bridge SQL-u.
CREATE TABLE "item_quality_types" (
  "id"           INTEGER     NOT NULL,
  -- KvalitetArtikal: kratka oznaka klase kvaliteta.
  "quality_code" VARCHAR(20) NOT NULL,
  "description"  VARCHAR(20) NOT NULL,
  CONSTRAINT "pk_item_quality_types" PRIMARY KEY ("id")
);

-- ------------------------------------------------------------------ ARTIKAL: dobavljaci
-- Was: DobavljaciZaArtikal (BB_T_26_schema.sql:243-250). Vise dobavljaca po artiklu,
-- jedan primaran, svaki sa svojim lead time-om; items.supplier_id nosi samo jednog.
CREATE TABLE "item_suppliers" (
  "id"             SERIAL  NOT NULL,
  -- BIGBIT sifra artikla -> items.external_item_id (NE items.id!), v. zaglavlje.
  "item_id"        INTEGER NOT NULL,
  -- [Sifra dobavljaca]: meki ref -> customers.id (dobavljac je komitent).
  "supplier_id"    INTEGER NOT NULL,
  -- Primarni.
  "is_primary"     BOOLEAN NOT NULL DEFAULT false,
  -- VremeIsporuke: lead time u danima.
  "lead_time_days" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "pk_item_suppliers" PRIMARY KEY ("id")
);

CREATE INDEX "idx_item_suppliers_item" ON "item_suppliers" ("item_id");

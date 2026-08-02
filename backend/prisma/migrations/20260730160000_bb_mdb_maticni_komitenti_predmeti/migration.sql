-- =============================================================================
-- BigBit .mdb staging za MATIČNE PODATKE — komitenti i predmeti (30.07.2026)
-- -----------------------------------------------------------------------------
-- ZAŠTO: do 22.07.2026 su komitenti i predmeti stizali kroz MSSQL kopiju
-- `QBigTehn`. Tog dana je prenos iz BigBita u tu kopiju prestao da se radi, a
-- niko to nije video osam dana. Mereno 30.07:
--     BigBit (živi)      → predmet 10014
--     QBigTehn (izvor)   → predmet 10005, poslednja izmena 22.07. 08:47
--     ServoSync 4.0      → predmet 10005
-- Dakle naš sync je bio ispravan i savršeno usklađen sa svojim izvorom — a izvor
-- je bio mrtav. Zato matični podaci od sada idu ISTIM kanalom kao knjigovodstvo:
-- direktno iz kopije BigBit baze (`bigbit-mdb-export.sh` → staging → uvoz).
--
-- Tabele su ČISTI STAGING: sve kolone `text`, bez ograničenja i bez tipizacije.
-- Tako bajat ili neočekivan red pada u UVOZU, gde greška može da imenuje šifru i
-- razlog, umesto na `COPY` sa porukom o rednom broju kolone.
--
-- Imena kolona prate BigBit 1:1 (`Sifra`, `Ziro racun_1`, `IDPredmet`…) jer
-- postojeći mapper (`syncers/customer.syncer.ts`, `sync-map.generated.ts`) čita
-- baš njih — MSSQL tabela je bila preslikana kopija ove iste. Time se menja SAMO
-- izvor redova; razrešavanje veza, zaštita 4.0-native redova i validacija ostaju
-- netaknuti i već testirani.
--
-- `ON DELETE CASCADE` na drop: staging živi i umire sa svojim drop-om.
-- =============================================================================

-- CreateTable
CREATE TABLE "bb_mdb_stage_komitenti" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "sifra" TEXT,
    "naziv" TEXT,
    "poslovnica" TEXT,
    "mesto" TEXT,
    "adresa" TEXT,
    "postanski_broj" TEXT,
    "ziro_racun_1" TEXT,
    "ziro_racun_2" TEXT,
    "ziro_racun_3" TEXT,
    "telefon" TEXT,
    "fax" TEXT,
    "kontakt" TEXT,
    "napomena" TEXT,
    "drzava" TEXT,
    "region" TEXT,
    "vrsta_sifre" TEXT,
    "email" TEXT,
    "mobilni" TEXT,
    "datum_rodjenja" TEXT,
    "web_adresa" TEXT,
    "sifra_prodavca" TEXT,
    "rabat_komitenta" TEXT,
    "zast_kod_kupca" TEXT,
    "pib" TEXT,
    "pdv_status" TEXT,
    "msifra" TEXT,
    "odlozeno" TEXT,
    "id_ruta" TEXT,
    "id_vozac" TEXT,
    "id_uplatni_racun" TEXT,
    "fakturisanje_po_mestima_isporuke" TEXT,
    "cenovnik" TEXT,
    "prvi_unos" TEXT,
    "poslednja_izmena" TEXT,
    "prvi_unos_user" TEXT,
    "poslednja_izmena_user" TEXT,
    "procenat_provizije" TEXT,
    "fikt_rabat_komitenta" TEXT,
    "komitenti_nacin_placanja" TEXT,
    "potpis_kom" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_komitenti" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bb_mdb_stage_predmeti" (
    "id" SERIAL NOT NULL,
    "drop_id" INTEGER NOT NULL,
    "id_predmet" TEXT,
    "broj_predmeta" TEXT,
    "opis" TEXT,
    "datum_otvaranja" TEXT,
    "id_prodavac" TEXT,
    "id_komitent" TEXT,
    "next_action" TEXT,
    "datum_zakljucenja" TEXT,
    "memo" TEXT,
    "status" TEXT,
    "nasa_ref" TEXT,
    "nas_kontakt1" TEXT,
    "nas_kontakt2" TEXT,
    "nas_tel1" TEXT,
    "nas_tel2" TEXT,
    "vasa_ref" TEXT,
    "vas_kontakt1" TEXT,
    "vas_kontakt2" TEXT,
    "vas_tel1" TEXT,
    "vas_tel2" TEXT,
    "nabavna_vrednost" TEXT,
    "carina" TEXT,
    "spedicija" TEXT,
    "prevoz" TEXT,
    "ostalo" TEXT,
    "ino_dobavljac" TEXT,
    "rj" TEXT,
    "devvaluta" TEXT,
    "kurs" TEXT,
    "id_vrsta_posla" TEXT,
    "naziv_predmeta" TEXT,
    "rok_zavrsetka" TEXT,
    "potpis" TEXT,
    "datum_i_vreme" TEXT,
    "broj_ugovora" TEXT,
    "datum_ugovora" TEXT,
    "broj_narudzbenice" TEXT,
    "datum_narudzbenice" TEXT,

    CONSTRAINT "pk_bb_mdb_stage_predmeti" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_komitenti_drop" ON "bb_mdb_stage_komitenti"("drop_id");

-- CreateIndex
CREATE INDEX "idx_bb_mdb_stage_predmeti_drop" ON "bb_mdb_stage_predmeti"("drop_id");

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_komitenti" ADD CONSTRAINT "fk_bb_mdb_stage_komitenti_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bb_mdb_stage_predmeti" ADD CONSTRAINT "fk_bb_mdb_stage_predmeti_drop" FOREIGN KEY ("drop_id") REFERENCES "bb_mdb_drops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
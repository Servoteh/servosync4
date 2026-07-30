-- Dopuna staging kolona koje je otkrila BRANA ZAGLAVLJA (30.07.2026).
-- Prava BigBit tabela `Komitenti` ima 57 kolona, deklaracija je imala 40.
-- Među nedostajućima su GLN, MaticniBroj, JBKJS i CRF — polja od kojih zavisi
-- e-faktura, za koja se do sada mislilo da ih .mdb izvoz ne donosi.
-- `Magacini` dobija `PotpisSlika` (poslednja kolona izvora).

-- AlterTable
ALTER TABLE "bb_mdb_stage_komitenti" ADD COLUMN     "crf" TEXT,
ADD COLUMN     "datum_i_vreme_kom" TEXT,
ADD COLUMN     "er_xml_sa_popustom_po_artiklu" TEXT,
ADD COLUMN     "gln" TEXT,
ADD COLUMN     "id_pantheon" TEXT,
ADD COLUMN     "jbkjs" TEXT,
ADD COLUMN     "kl_ruc_proc" TEXT,
ADD COLUMN     "koristi_pnb_zad_model" TEXT,
ADD COLUMN     "kredit_limit" TEXT,
ADD COLUMN     "maticni_broj" TEXT,
ADD COLUMN     "napomena_za_salda" TEXT,
ADD COLUMN     "ne_prikazati_u_pregledu" TEXT,
ADD COLUMN     "ne_proveravaj_pib" TEXT,
ADD COLUMN     "news_letter" TEXT,
ADD COLUMN     "posta_na_drugu_adresu" TEXT,
ADD COLUMN     "provera_duga" TEXT,
ADD COLUMN     "skraceni_naziv" TEXT;

-- AlterTable
ALTER TABLE "bb_mdb_stage_magacini" ADD COLUMN     "potpis_slika" TEXT;
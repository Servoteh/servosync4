-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "BBDefUser" (
    "UserName" VARCHAR(20) NOT NULL,
    "DefaultGodina" INTEGER DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
    "DefaultOJ" INTEGER DEFAULT 0,
    "DefaultOD" INTEGER DEFAULT 0,
    "UnlockGodina" BOOLEAN DEFAULT false,
    "UnlockOJ" BOOLEAN DEFAULT false,
    "UnlockOD" BOOLEAN DEFAULT false,
    "Level" SMALLINT DEFAULT 0,
    "MaxLevel" SMALLINT DEFAULT 0,

    CONSTRAINT "aaaaaBBDefUser_PK" PRIMARY KEY ("UserName")
);

-- CreateTable
CREATE TABLE "BBOdeljenja" (
    "OD" SERIAL NOT NULL,
    "OznakaOD" VARCHAR(10) NOT NULL,
    "OpisOD" VARCHAR(50) NOT NULL,

    CONSTRAINT "aaaaaBBOdeljenja_PK" PRIMARY KEY ("OD")
);

-- CreateTable
CREATE TABLE "BBOrgJedinice" (
    "OJ" SERIAL NOT NULL,
    "OznakaOJ" VARCHAR(10) NOT NULL,
    "OpisOJ" VARCHAR(50) NOT NULL,

    CONSTRAINT "aaaaaBBOrgJedinice_PK" PRIMARY KEY ("OJ")
);

-- CreateTable
CREATE TABLE "BBPravaPristupa" (
    "ID" SERIAL NOT NULL,
    "ImeUsera" VARCHAR(20) NOT NULL,
    "ImeForme" VARCHAR(50) NOT NULL,
    "ImeKontrole" VARCHAR(50) NOT NULL,
    "Visible" BOOLEAN NOT NULL DEFAULT true,
    "Locked" BOOLEAN NOT NULL DEFAULT false,
    "Enabled" BOOLEAN NOT NULL DEFAULT true,
    "Vrednost" VARCHAR(250),
    "RecordSource" TEXT,
    "Filter" VARCHAR(250),

    CONSTRAINT "aaaaaBBPravaPristupa_PK" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "CFG_Global" (
    "IDFirma" INTEGER NOT NULL DEFAULT 0,
    "Parametar" VARCHAR(120) NOT NULL,
    "Vrednost" TEXT,
    "Tip" VARCHAR(20),
    "Opis" VARCHAR(100),

    CONSTRAINT "CFG_Global_PK" PRIMARY KEY ("IDFirma","Parametar")
);

-- CreateTable
CREATE TABLE "CFG_Sys" (
    "Parametar" VARCHAR(120) NOT NULL,
    "Vrednost" VARCHAR(50),
    "Tip" VARCHAR(20),
    "Opis" VARCHAR(255),
    "DIVUnos" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK_CFG_Sys" PRIMARY KEY ("Parametar")
);

-- CreateTable
CREATE TABLE "Cenovnik" (
    "ID" SERIAL NOT NULL,
    "Sifra artikla" INTEGER NOT NULL DEFAULT 0,
    "Vrsta dokumenta" VARCHAR(5) NOT NULL,
    "Cena" DOUBLE PRECISION DEFAULT 0,
    "Tarifa" VARCHAR(5) NOT NULL,
    "CenaBezPDV" DECIMAL(19,4) DEFAULT 0,
    "Taksa" DOUBLE PRECISION DEFAULT 0,
    "Prn" BOOLEAN DEFAULT true,
    "CenaSaPDV" DECIMAL(19,4) DEFAULT 0,
    "CheckCenaSaPDV" BOOLEAN DEFAULT false,
    "ZakCen" BOOLEAN DEFAULT false,

    CONSTRAINT "PK_Cenovnik" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "Info" (
    "ID" INTEGER NOT NULL DEFAULT 0,
    "DatumIVremeSlanja" TIMESTAMP(6),
    "KoJePoslao" VARCHAR(250),
    "Prijem" BOOLEAN DEFAULT false,
    "DatumIVremePrijema" TIMESTAMP(6),
    "KoJePrimio" VARCHAR(250),

    CONSTRAINT "aaaaaInfo_PK" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "Komitenti" (
    "Sifra" SERIAL NOT NULL,
    "Naziv" VARCHAR(50) NOT NULL,
    "Poslovnica" VARCHAR(50),
    "Mesto" VARCHAR(30),
    "Adresa" VARCHAR(50),
    "Postanski broj" VARCHAR(20),
    "Ziro racun_1" VARCHAR(30),
    "Ziro racun_2" VARCHAR(30),
    "Ziro racun_3" VARCHAR(30),
    "Telefon" VARCHAR(20),
    "Fax" VARCHAR(20),
    "Kontakt" VARCHAR(50),
    "Napomena" TEXT,
    "Drzava" VARCHAR(30),
    "Region" INTEGER DEFAULT 0,
    "Vrsta sifre" VARCHAR(10) DEFAULT 'KUPDOB',
    "Email" VARCHAR(50),
    "Mobilni" VARCHAR(20),
    "Datum rodjenja" TIMESTAMP(6),
    "Web adresa" VARCHAR(50),
    "Sifra prodavca" INTEGER DEFAULT 0,
    "RabatKomitenta" DOUBLE PRECISION DEFAULT 0,
    "ZastKodKupca" VARCHAR(50),
    "PIB" VARCHAR(20) NOT NULL,
    "PDVStatus" INTEGER DEFAULT 0,
    "MSifra" VARCHAR(10),
    "Odlozeno" SMALLINT DEFAULT 0,
    "IDRuta" INTEGER DEFAULT 0,
    "IDVozac" INTEGER DEFAULT 0,
    "IDUplatniRacun" INTEGER DEFAULT 0,
    "FakturisanjePoMestimaIsporuke" BOOLEAN DEFAULT true,
    "Cenovnik" VARCHAR(5),
    "PrviUnos" TIMESTAMP(6),
    "PoslednjaIzmena" TIMESTAMP(6),
    "PrviUnosUser" VARCHAR(20),
    "PoslednjaIzmenaUser" VARCHAR(20),
    "ProcenatProvizije" DOUBLE PRECISION DEFAULT 0,
    "FiktRabatKomitenta" DOUBLE PRECISION DEFAULT 0,
    "KomitentiNacinPlacanja" VARCHAR(50),
    "PotpisKom" VARCHAR(50),
    "SkraceniNaziv" VARCHAR(30),
    "DatumIVremeKom" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "ProveraDuga" BOOLEAN DEFAULT false,
    "KreditLimit" DECIMAL(19,4) DEFAULT 0,
    "NeProveravajPIB" BOOLEAN DEFAULT false,
    "IDPantheon" VARCHAR(30),
    "NewsLetter" BOOLEAN DEFAULT false,
    "PostaNaDruguAdresu" BOOLEAN DEFAULT false,
    "GLN" VARCHAR(30),
    "KLRucProc" DECIMAL(19,4) DEFAULT 0,
    "NapomenaZaSalda" TEXT,
    "NePrikazatiUPregledu" BOOLEAN DEFAULT false,
    "JBKJS" VARCHAR(10),
    "MaticniBroj" VARCHAR(20),
    "ER_XMLSaPopustomPoArtiklu" BOOLEAN DEFAULT false,
    "CRF" BOOLEAN DEFAULT false,

    CONSTRAINT "PK_Komitenti" PRIMARY KEY ("Sifra")
);

-- CreateTable
CREATE TABLE "KomponentePDMCrteza" (
    "IDKomponenteCrteza" SERIAL NOT NULL,
    "ZaIDCrtez" INTEGER NOT NULL,
    "TrebaIDCrtez" INTEGER NOT NULL,
    "PotrebnoKomada" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PK_KomponentePDMCrteza" PRIMARY KEY ("IDKomponenteCrteza")
);

-- CreateTable
CREATE TABLE "MRP_Potrebe" (
    "IDPotreba" SERIAL NOT NULL,
    "IDPredmet" INTEGER NOT NULL,
    "IDCrtezRoot" INTEGER,
    "SifraRadnika" INTEGER,
    "Izvor" SMALLINT NOT NULL,
    "TipEksplozije" SMALLINT,
    "Status" SMALLINT NOT NULL DEFAULT 0,
    "DatumPotrebe" DATE NOT NULL,
    "Napomena" VARCHAR(500),
    "DIVUnosa" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "DIVUnosaKorisnik" VARCHAR(20),
    "DIVIzmena" TIMESTAMP(6),
    "DIVIzmenaKorisnik" VARCHAR(20),
    "PlaniranaKolicina" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "IDPlan" INTEGER,

    CONSTRAINT "PK_MRP_Potrebe" PRIMARY KEY ("IDPotreba")
);

-- CreateTable
CREATE TABLE "MRP_PotrebeStavke" (
    "IDPotrebaStavka" SERIAL NOT NULL,
    "IDPotreba" INTEGER NOT NULL,
    "IDCrtezIzvora" INTEGER,
    "IDCrtezNabavke" INTEGER,
    "SifraArtikla" INTEGER,
    "KataloskiBrojStavka" VARCHAR(100) NOT NULL,
    "NazivArtiklaStavka" VARCHAR(200) NOT NULL,
    "JedinicaMereStavka" VARCHAR(10) NOT NULL,
    "IzvorStavke" SMALLINT NOT NULL,
    "KolicinaPotrebna" DECIMAL(19,6) NOT NULL,
    "DatumPotrebe" DATE NOT NULL,
    "VremeIsporukeDana" INTEGER,
    "DatumNabavke" DATE GENERATED ALWAYS AS ("DatumPotrebe" - COALESCE("VremeIsporukeDana", 0)) STORED,
    "Napomena" VARCHAR(500),
    "DIVUnosa" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "DIVUnosaKorisnik" VARCHAR(20),
    "DIVIzmena" TIMESTAMP(6),
    "DIVIzmenaKorisnik" VARCHAR(20),
    "DobavljacID" INTEGER,
    "StatusStavke" SMALLINT NOT NULL DEFAULT 0,
    "KolicinaRezervisano" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "KolicinaZaNabavku" DECIMAL(19,6) NOT NULL DEFAULT 0,

    CONSTRAINT "PK_MRP_PotrebeStavke" PRIMARY KEY ("IDPotrebaStavka")
);

-- CreateTable
CREATE TABLE "MRP_StanjeArtikala" (
    "SifraArtikla" INTEGER NOT NULL,
    "Zalihe" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "Rezervisane" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "Naziv" VARCHAR(200),
    "KataloskiBroj" VARCHAR(100),
    "JedinicaMere" VARCHAR(20),
    "PoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MRP_StanjeArtikala_pkey" PRIMARY KEY ("SifraArtikla")
);

-- CreateTable
CREATE TABLE "MRP_StanjeArtikala_TMP" (
    "SifraArtikla" INTEGER NOT NULL,
    "Zalihe" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "Rezervisane" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "Naziv" VARCHAR(200),
    "KataloskiBroj" VARCHAR(100),
    "JedinicaMere" VARCHAR(20),

    CONSTRAINT "MRP_StanjeArtikala_TMP_pkey" PRIMARY KEY ("SifraArtikla")
);

-- CreateTable
CREATE TABLE "MRP_SyncStatus" (
    "SyncKey" VARCHAR(50) NOT NULL,
    "PoslednjiSync" TIMESTAMP(6),
    "PoslednjiSyncKorisnik" VARCHAR(100),
    "Napomena" VARCHAR(255),

    CONSTRAINT "MRP_SyncStatus_pkey" PRIMARY KEY ("SyncKey")
);

-- CreateTable
CREATE TABLE "Magacini" (
    "IDFirma" INTEGER DEFAULT 0,
    "IDMagacin" SERIAL NOT NULL,
    "Magacin" VARCHAR(50) NOT NULL,
    "UlicaIBroj" VARCHAR(50),
    "Mesto" VARCHAR(30),
    "ProsecneCene" BOOLEAN DEFAULT false,
    "VrstaMag" VARCHAR(5),
    "KontoMag" VARCHAR(10),
    "ImeMagacionera" VARCHAR(30),
    "BrLkMagacionera" VARCHAR(20),
    "PotpisSlika" VARCHAR(250),

    CONSTRAINT "PK_Magacini" PRIMARY KEY ("IDMagacin")
);

-- CreateTable
CREATE TABLE "NacrtPrimopredaje" (
    "IDNacrtPrim" SERIAL NOT NULL,
    "IDProjektant" INTEGER NOT NULL,
    "DatumNacrta" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "IDPredmet" INTEGER NOT NULL,
    "BrojKomada" INTEGER NOT NULL,
    "IDStatusNacrtaPrimopredaje" INTEGER NOT NULL DEFAULT 0,
    "Napomena" VARCHAR(250),
    "Potpis" VARCHAR(30),
    "PrviUnos" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "PoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "BrojNacrta" VARCHAR(30) NOT NULL DEFAULT '',
    "Zakljucano" BOOLEAN DEFAULT false,
    "TipNacrta" SMALLINT NOT NULL DEFAULT 0,
    "IDGlavniCrtez" INTEGER,

    CONSTRAINT "NacrtPrimopredaje_pkey" PRIMARY KEY ("IDNacrtPrim")
);

-- CreateTable
CREATE TABLE "NacrtPrimopredajeStavke" (
    "IDNacrtStavka" SERIAL NOT NULL,
    "IDNacrtPrim" INTEGER NOT NULL,
    "IDCrtez" INTEGER NOT NULL,
    "Napomena" VARCHAR(250),
    "Potpis" VARCHAR(30),
    "PrviUnos" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "PoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "KolicinaZaIzradu" INTEGER NOT NULL DEFAULT 1,
    "IDGlavniCrtez" INTEGER,
    "IsGlavni" BOOLEAN NOT NULL DEFAULT false,
    "PredProveraDuplikat" BOOLEAN NOT NULL DEFAULT false,
    "PredProveraIDNacrtPrim" INTEGER,
    "PredProveraIDRN" INTEGER,
    "IskljuciPrimopredaju" BOOLEAN NOT NULL DEFAULT false,
    "OdlukaAkcija" SMALLINT NOT NULL DEFAULT 0,
    "DIVOdluke" TIMESTAMP(0),
    "KolicinaDefinisanaUCrtezu" INTEGER DEFAULT 0,

    CONSTRAINT "NacrtPrimopredajeStavke_pkey" PRIMARY KEY ("IDNacrtStavka")
);

-- CreateTable
CREATE TABLE "Nalepnice" (
    "ID" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL,
    "IDPostupka" INTEGER NOT NULL,
    "IdentBroj" VARCHAR(20) NOT NULL,
    "BarKod" VARCHAR(20) NOT NULL,
    "NazivPredmeta" VARCHAR(50) NOT NULL,
    "Komitent" VARCHAR(255) NOT NULL,
    "NazivDela" VARCHAR(250) NOT NULL,
    "BrojCrteza" VARCHAR(100) NOT NULL,
    "Materijal" VARCHAR(250) NOT NULL,
    "DatumUnosa" TIMESTAMP(6) NOT NULL,
    "Kolicina" SMALLINT NOT NULL,
    "UkupnaKolicina" SMALLINT,
    "PRN" BOOLEAN DEFAULT true,

    CONSTRAINT "PK_Nalepnice" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "PDMCrtezi" (
    "IDCrtez" SERIAL NOT NULL,
    "pdmWeID" VARCHAR(20) NOT NULL,
    "TransactionDate" TIMESTAMP(6),
    "DesignDate" TIMESTAMP(6),
    "DesignBy" VARCHAR(50),
    "ApprovedDate" TIMESTAMP(6),
    "ApprovedBy" VARCHAR(50),
    "BrojCrteza" VARCHAR(20) NOT NULL,
    "Revizija" VARCHAR(3) NOT NULL DEFAULT 'A',
    "Kolicina" INTEGER NOT NULL DEFAULT 1,
    "KataloskiBroj" VARCHAR(50) NOT NULL,
    "Naziv" VARCHAR(255) NOT NULL,
    "Materijal" VARCHAR(255),
    "RN" VARCHAR(20),
    "Dimenzije" VARCHAR(255),
    "Oznaka" VARCHAR(20) NOT NULL,
    "Tezina" DOUBLE PRECISION,
    "Naziv fajla" VARCHAR(500),
    "PDMStatusCrteza" VARCHAR(20) NOT NULL,
    "Comment" VARCHAR(255),
    "WhereUsed" VARCHAR(255),
    "Naziv_projekta" VARCHAR(255),
    "DIVUnosa" TIMESTAMP(6),
    "Potpis" VARCHAR(50),
    "IDStatusCrteza" INTEGER NOT NULL DEFAULT 0,
    "Nabavka" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PK_Crtez" PRIMARY KEY ("IDCrtez")
);

-- CreateTable
CREATE TABLE "PDMXMLImportLog" (
    "IDLog" SERIAL NOT NULL,
    "NazivFajla" VARCHAR(255) NOT NULL,
    "PutanjaFajla" VARCHAR(1024) NOT NULL,
    "ImportTimestamp" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "Uspesno" BOOLEAN NOT NULL,
    "StatusPoruka" VARCHAR(1000),
    "Kriticno" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PDMXMLImportLog_pkey" PRIMARY KEY ("IDLog")
);

-- CreateTable
CREATE TABLE "PDM_PDFCrtezi" (
    "BrojCrteza" VARCHAR(100) NOT NULL,
    "Revizija" VARCHAR(10) NOT NULL,
    "NazivFajla" VARCHAR(255),
    "DatumUnosa" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "VelicinaKB" INTEGER,
    "KorisnikUnosa" VARCHAR(50) DEFAULT (SESSION_USER)::text,
    "PDFBinary" BYTEA,

    CONSTRAINT "PK_PDM_PDFCrtezi" PRIMARY KEY ("BrojCrteza","Revizija")
);

-- CreateTable
CREATE TABLE "PDM_Planiranje" (
    "IDPlan" SERIAL NOT NULL,
    "IDPredmet" INTEGER NOT NULL,
    "IDCrtezSklopa" INTEGER,
    "KolicinaZaIzradu" DECIMAL(18,4) NOT NULL,
    "StatusPlaniranja" INTEGER NOT NULL DEFAULT 0,
    "DatumPlaniranja" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SifraRadnikaPlaniranja" INTEGER NOT NULL,
    "Napomena" VARCHAR(255),
    "Potpis" VARCHAR(30),
    "PrviUnos" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "PoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "Zakljucano" BOOLEAN,
    "BrojPlana" VARCHAR(30),
    "BrojCrtezaPlana" VARCHAR(20),
    "RevizijaPlana" VARCHAR(3),

    CONSTRAINT "PK_PDM_Planiranje" PRIMARY KEY ("IDPlan")
);

-- CreateTable
CREATE TABLE "PDM_PlaniranjeStavke" (
    "IDPlanStavka" SERIAL NOT NULL,
    "IDPlan" INTEGER NOT NULL,
    "IDCrtezNabavke" INTEGER NOT NULL,
    "SifraArtikla" INTEGER,
    "KolicinaPoSklopu" DECIMAL(18,4) NOT NULL,
    "PotrebnoUkupno" DECIMAL(18,4),
    "PredProveraIDPlan" INTEGER,
    "OdlukaAkcija" SMALLINT NOT NULL DEFAULT 0,
    "RucnaKolicina" DECIMAL(18,4),
    "Rezervisano" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "ZaNabavku" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "Zalihe" DECIMAL(18,4),
    "NazivArtiklaStavke" VARCHAR(150),
    "KataloskiBrojStavke" VARCHAR(20),
    "JMStavke" VARCHAR(5),
    "JeRucnaStavka" BOOLEAN NOT NULL DEFAULT false,
    "IskljuciNabavku" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PK_PDM_PlaniranjeStavke" PRIMARY KEY ("IDPlanStavka")
);

-- CreateTable
CREATE TABLE "Parametri za rad" (
    "Korisnik" VARCHAR(50) NOT NULL,
    "VrstaDokumenta" VARCHAR(10),
    "Telefon" VARCHAR(50),
    "Poslednji broj fakture" INTEGER DEFAULT 0,
    "Poslednji broj profakture" INTEGER DEFAULT 0,
    "Faktura kroz" VARCHAR(10),
    "Profaktura kroz" VARCHAR(10),
    "Faktura prefix" VARCHAR(10),
    "Profaktura prefix" VARCHAR(10),

    CONSTRAINT "aaaaaParametri za rad_PK" PRIMARY KEY ("Korisnik")
);

-- CreateTable
CREATE TABLE "Predmeti" (
    "IDPredmet" SERIAL NOT NULL,
    "BrojPredmeta" VARCHAR(20) NOT NULL,
    "Opis" VARCHAR(50),
    "DatumOtvaranja" TIMESTAMP(6) DEFAULT (CURRENT_DATE)::timestamp without time zone,
    "IDProdavac" INTEGER NOT NULL DEFAULT 0,
    "IDKomitent" INTEGER NOT NULL,
    "NextAction" VARCHAR(50),
    "DatumZakljucenja" TIMESTAMP(6),
    "Memo" TEXT,
    "Status" VARCHAR(20),
    "NasaRef" VARCHAR(20),
    "NasKontakt1" VARCHAR(50),
    "NasKontakt2" VARCHAR(50),
    "NasTel1" VARCHAR(20),
    "NasTel2" VARCHAR(20),
    "VasaRef" VARCHAR(20),
    "VasKontakt1" VARCHAR(50),
    "VasKontakt2" VARCHAR(50),
    "VasTel1" VARCHAR(20),
    "VasTel2" VARCHAR(20),
    "NabavnaVrednost" DECIMAL(19,4) DEFAULT 0,
    "Carina" DECIMAL(19,4) DEFAULT 0,
    "Spedicija" DECIMAL(19,4) DEFAULT 0,
    "Prevoz" DECIMAL(19,4) DEFAULT 0,
    "Ostalo" DECIMAL(19,4) DEFAULT 0,
    "InoDobavljac" INTEGER DEFAULT 0,
    "RJ" VARCHAR(4),
    "devvaluta" VARCHAR(3),
    "kurs" DECIMAL(19,4) DEFAULT 0,
    "IDVrstaPosla" INTEGER DEFAULT 0,
    "NazivPredmeta" VARCHAR(250),
    "RokZavrsetka" TIMESTAMP(6),
    "Potpis" VARCHAR(50),
    "DatumIVreme" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "BrojUgovora" VARCHAR(100),
    "DatumUgovora" TIMESTAMP(6),
    "BrojNarudzbenice" VARCHAR(100),
    "DatumNarudzbenice" TIMESTAMP(6),

    CONSTRAINT "PK_Predmeti" PRIMARY KEY ("IDPredmet")
);

-- CreateTable
CREATE TABLE "PredmetiVrstaPosla" (
    "IDVrstaPosla" SERIAL NOT NULL,
    "VrstaPosla" VARCHAR(20),
    "Opis" VARCHAR(150),

    CONSTRAINT "PK_PredmetiVrstaPosla" PRIMARY KEY ("IDVrstaPosla")
);

-- CreateTable
CREATE TABLE "PrimopredajaCrteza" (
    "IDPrimopredaje" SERIAL NOT NULL,
    "IDCrtez" INTEGER NOT NULL,
    "DatumPredaje" TIMESTAMP(6) NOT NULL,
    "IDRadnikPredaje" INTEGER NOT NULL,
    "IDStatusPrimopredaje" INTEGER NOT NULL DEFAULT 0,
    "DatumPromeneStatusa" TIMESTAMP(6),
    "IDRadnikPromeneStatusa" INTEGER,
    "KomentarPromeneStatusa" VARCHAR(250),
    "DatumLansiranja" TIMESTAMP(6),
    "IDRadnikLansiranja" INTEGER,
    "Napomena" VARCHAR(250),
    "Potpis" VARCHAR(30),
    "PrviUnos" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "PoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "Zakljucano" BOOLEAN DEFAULT false,

    CONSTRAINT "PrimopredajaCrteza_pkey" PRIMARY KEY ("IDPrimopredaje")
);

-- CreateTable
CREATE TABLE "PrimopredajaPDFCrteza" (
    "ID" SERIAL NOT NULL,
    "IDPrimopredaje" INTEGER NOT NULL,
    "LinkFajla" VARCHAR(1024) NOT NULL,
    "NazivFajla" VARCHAR(255) NOT NULL,

    CONSTRAINT "PrimopredajaPDFCrteza_pkey" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "Prodavci" (
    "Sifra prodavca" SERIAL NOT NULL,
    "Prodavac" VARCHAR(50) NOT NULL,
    "Region" INTEGER DEFAULT 0,
    "ProcenatZaObracun" DOUBLE PRECISION DEFAULT 0,
    "DeljivoUGrupi" BOOLEAN DEFAULT false,
    "ImeProdavca" VARCHAR(30),
    "BrLkProdavca" VARCHAR(20),
    "LogAcc" VARCHAR(50),
    "Password" VARCHAR(20),
    "Aktivan" BOOLEAN DEFAULT true,
    "NefiskalniRN" BOOLEAN DEFAULT false,
    "Storniranje" BOOLEAN DEFAULT false,
    "PotpisSlika" VARCHAR(250),
    "OznakaTima" VARCHAR(10) DEFAULT '000',
    "Telefon" VARCHAR(20),
    "Email" VARCHAR(50),

    CONSTRAINT "PK_Prodavci" PRIMARY KEY ("Sifra prodavca")
);

-- CreateTable
CREATE TABLE "R_Artikli" (
    "Sifra artikla" SERIAL NOT NULL,
    "Kataloski broj" VARCHAR(20) NOT NULL DEFAULT '-',
    "BarKod" VARCHAR(50),
    "PLU" INTEGER DEFAULT 0,
    "ExtSifra" VARCHAR(20),
    "Naziv" VARCHAR(50) NOT NULL,
    "Jedinica mere" VARCHAR(5),
    "Pakovanje" VARCHAR(10),
    "InoJm" VARCHAR(5),
    "Kutija" DOUBLE PRECISION DEFAULT 0,
    "Transportno pakovanje" DOUBLE PRECISION DEFAULT 0,
    "Poreklo" VARCHAR(5) NOT NULL DEFAULT '0',
    "Grupa" VARCHAR(10) NOT NULL,
    "Podgrupa" VARCHAR(10) NOT NULL DEFAULT '0',
    "Tarifa robe" VARCHAR(5) NOT NULL DEFAULT '3',
    "Tarifa usluga" VARCHAR(5) NOT NULL DEFAULT '1',
    "Uvek porez na robu" BOOLEAN DEFAULT true,
    "Uvek porez na usluge" BOOLEAN DEFAULT false,
    "VP cena" DOUBLE PRECISION DEFAULT 0,
    "MP cena" DOUBLE PRECISION DEFAULT 0,
    "NabDevCena" DOUBLE PRECISION DEFAULT 0,
    "ProdDevCena" DOUBLE PRECISION DEFAULT 0,
    "Minimalna kolicina" DOUBLE PRECISION DEFAULT 0,
    "ArtTaksa" DOUBLE PRECISION DEFAULT 0,
    "Odlozeno" SMALLINT DEFAULT 0,
    "Neoporezivi deo" DOUBLE PRECISION DEFAULT 0,
    "MaxRabatProc" DOUBLE PRECISION DEFAULT 100,
    "Memo" TEXT,
    "KngSifra" VARCHAR(10) DEFAULT '0',
    "ArtAkciza" DOUBLE PRECISION DEFAULT 0,
    "KngSifra_2" VARCHAR(10) DEFAULT '0',
    "ZavTrosProiz" DOUBLE PRECISION DEFAULT 0,
    "CarStopa" DOUBLE PRECISION DEFAULT 0,
    "IDRaster" INTEGER DEFAULT 0,
    "CarTarifa" VARCHAR(20),
    "ZemljaPorekla" VARCHAR(20),
    "Polica" VARCHAR(10),
    "INONaziv" VARCHAR(50),
    "SifDob" INTEGER DEFAULT 1,
    "WebOpis" VARCHAR(255),
    "OpisArtikla" VARCHAR(50),
    "Tezina" DOUBLE PRECISION DEFAULT 0,
    "PDFLink" VARCHAR(255),
    "ZaBrisanje" BOOLEAN DEFAULT false,
    "Aktivan" BOOLEAN DEFAULT true,
    "CenaZaUpisUCen" DOUBLE PRECISION DEFAULT 0,
    "IDMestoIzdavanja" INTEGER DEFAULT 0,
    "Proizvodjac" VARCHAR(50),
    "HPS" VARCHAR(50) DEFAULT 'O',
    "PotpisArt" VARCHAR(50),
    "DatumIVremeArt" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "KolUPak" DOUBLE PRECISION DEFAULT 1,
    "KLRucProc" DECIMAL(19,4) DEFAULT 0,
    "OsnJM" VARCHAR(5),
    "SlikaSimbolaLink" VARCHAR(250),
    "MPKaloProc" DOUBLE PRECISION DEFAULT 0,
    "WordLokacija" VARCHAR(250),
    "VPKaloProc" DOUBLE PRECISION DEFAULT 0,
    "NeVodiZalihe" BOOLEAN DEFAULT false,
    "TezinaKg" DOUBLE PRECISION DEFAULT 0,
    "Zapremina" DOUBLE PRECISION DEFAULT 0,
    "Povrsina" DOUBLE PRECISION DEFAULT 0,
    "RSort" INTEGER DEFAULT 0,
    "AkcijskiRabat" DOUBLE PRECISION DEFAULT 0,
    "Napomena2" VARCHAR(255),
    "IDKvalitetArtikla" INTEGER DEFAULT 0,
    "Debljina" DOUBLE PRECISION DEFAULT 0,
    "BBSifra artikla" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PK_R_Artikli" PRIMARY KEY ("Sifra artikla")
);

-- CreateTable
CREATE TABLE "R_Grupa" (
    "Grupa" VARCHAR(10) NOT NULL,
    "Opis" VARCHAR(50) NOT NULL,

    CONSTRAINT "PK_R_Grupa" PRIMARY KEY ("Grupa")
);

-- CreateTable
CREATE TABLE "R_Podgrupa" (
    "Podgrupa" VARCHAR(10) NOT NULL,
    "Opis" VARCHAR(50) NOT NULL,
    "GrupaVeza" VARCHAR(10) DEFAULT '0',

    CONSTRAINT "PK_R_Podgrupa" PRIMARY KEY ("Podgrupa")
);

-- CreateTable
CREATE TABLE "R_Poreklo" (
    "Poreklo" VARCHAR(5) NOT NULL,
    "Opis" VARCHAR(50) NOT NULL,
    "PodgrupaVeza" VARCHAR(10) DEFAULT '0',
    "PopustProc" DECIMAL(19,4) DEFAULT 0,

    CONSTRAINT "PK_R_Poreklo" PRIMARY KEY ("Poreklo")
);

-- CreateTable
CREATE TABLE "R_Tarife" (
    "ID" SERIAL NOT NULL,
    "Tarifa" VARCHAR(5) NOT NULL,
    "Osnovna stopa" DOUBLE PRECISION DEFAULT 0,
    "Zeleznica stopa" DOUBLE PRECISION DEFAULT 0,
    "Gradska stopa" DOUBLE PRECISION DEFAULT 0,
    "Ratna stopa" DOUBLE PRECISION DEFAULT 0,
    "Posebna stopa" DOUBLE PRECISION DEFAULT 0,
    "Opis" TEXT,
    "Vazi od" TIMESTAMP(6),
    "Vazi do" TIMESTAMP(6),
    "PDVGrupa" VARCHAR(10) DEFAULT 'VISA',

    CONSTRAINT "PK_R_Tarife" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "R_Vrste dokumenata" (
    "ID" SERIAL NOT NULL,
    "Vrsta dokumenta" VARCHAR(5) NOT NULL,
    "Opis" VARCHAR(50) NOT NULL,
    "Ulazni" BOOLEAN NOT NULL DEFAULT false,
    "Analiticki konto" VARCHAR(10),
    "Knjiziti analitiku" BOOLEAN DEFAULT false,
    "Sema za kontiranje" INTEGER DEFAULT 0,
    "Knjiziti sintetiku" BOOLEAN DEFAULT false,
    "Prodaja sa PPP" BOOLEAN DEFAULT false,
    "Prodaja sa PPU" BOOLEAN DEFAULT true,
    "KnjizitiTKZad" BOOLEAN DEFAULT false,
    "KnjizitiTKRazd" BOOLEAN DEFAULT false,
    "TextZaReport" VARCHAR(50),
    "KnjizitiUPDVEvidenciju" BOOLEAN DEFAULT true,
    "KEPUDefZaduzenje" VARCHAR(30),
    "KEPUDefRazduzenje" VARCHAR(30),
    "InterniDokument" BOOLEAN DEFAULT false,
    "NumeracijaOd" INTEGER DEFAULT 0,
    "KOTP" BOOLEAN DEFAULT false,
    "PrefiksBrojaDok" VARCHAR(5),
    "IDMagacinZaVrstuDok" INTEGER DEFAULT 0,
    "KODJ" BOOLEAN DEFAULT false,
    "FR" BOOLEAN DEFAULT false,
    "UticeNaZalihe" BOOLEAN DEFAULT true,

    CONSTRAINT "PK_R_Vrste dokumenata" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "Radni fajlovi" (
    "IDBaze" INTEGER NOT NULL,
    "Firma" VARCHAR(150) NOT NULL,
    "Naziv baze" VARCHAR(255),
    "Logo" BYTEA,
    "Mesto" VARCHAR(50),
    "Adresa" VARCHAR(50),
    "Telefon" VARCHAR(50),
    "Fax" VARCHAR(50),
    "Ziro racun" VARCHAR(50),
    "Delatnost" VARCHAR(255),
    "Sifra delatnosti" VARCHAR(50),
    "Opstina" VARCHAR(50),
    "Napomena" TEXT,
    "Specijal" VARCHAR(50) DEFAULT 'DEFAULT',
    "e-mail" VARCHAR(30),
    "Maticni broj" VARCHAR(50),
    "Registarski broj" VARCHAR(50),
    "Podracuni" VARCHAR(100),
    "Kasa_ProdavnicaID" INTEGER DEFAULT 0,
    "Kasa_KupacID" INTEGER DEFAULT 0,
    "Kasa_VrstaDokumenta" VARCHAR(5) DEFAULT 'MP1',
    "Kasa_RadniNalogID" INTEGER DEFAULT 0,
    "BrDecUlKl" SMALLINT DEFAULT 2,
    "BrDecIzKl" SMALLINT DEFAULT 2,
    "KursDeli" BOOLEAN DEFAULT false,
    "ProveraZalihaMag" BOOLEAN DEFAULT true,
    "AutoPodelaPrihoda" BOOLEAN DEFAULT false,
    "FakturnaJeVPZaUlKl" BOOLEAN DEFAULT false,
    "KepuPoNabavnojCeni" BOOLEAN DEFAULT false,
    "TrgovackaPoKursu" BOOLEAN DEFAULT false,
    "KepuPoKursu" BOOLEAN DEFAULT false,
    "GKPoKursu" BOOLEAN DEFAULT false,
    "KontoKupac" VARCHAR(20) DEFAULT '2040',
    "KontoDobavljac" VARCHAR(20) DEFAULT '4350',
    "KnjiziRazlikeNaTK" BOOLEAN DEFAULT true,
    "KnjiziRazlikeNaKEPU" BOOLEAN DEFAULT true,
    "KnjiziRazlikeNaMPKEPU" BOOLEAN DEFAULT true,
    "GKPoKursuObrnuto" BOOLEAN DEFAULT false,
    "AutoZakRoba" BOOLEAN DEFAULT false,
    "AutoZakGK" BOOLEAN DEFAULT false,
    "StarijeOdDanaRoba" INTEGER DEFAULT 7,
    "StarijeOdDanaGk" INTEGER DEFAULT 7,
    "ProveraPorukaInterval" INTEGER DEFAULT 0,
    "DekodirajBarKod" BOOLEAN DEFAULT false,
    "PIB" VARCHAR(20),
    "Garancija" TEXT,
    "KEPUPoKNGCeni" BOOLEAN DEFAULT false,
    "PEPDV" VARCHAR(20),
    "Vlasnik" VARCHAR(50),
    "PoreskaSifra" VARCHAR(50),
    "Galeb" BOOLEAN DEFAULT false,
    "Raster" BOOLEAN DEFAULT false,
    "PG_Naziv baze" VARCHAR(255),
    "ServerZaGaleb" BOOLEAN DEFAULT false,
    "KlijentZaGaleb" BOOLEAN DEFAULT false,
    "FP_ImeStampaca" VARCHAR(50) DEFAULT 'GALEB01',
    "MestoIzdavanjaRacuna" VARCHAR(50) DEFAULT 'Beograd',
    "Kasa_KasaID" INTEGER DEFAULT 0,
    "WebAdresa" VARCHAR(50),
    "APRText" VARCHAR(250),
    "SaljiBosson" BOOLEAN DEFAULT false,
    "Kasa_Cenovnik" VARCHAR(5) DEFAULT 'MP1',
    "VPCenovnik" VARCHAR(5) DEFAULT 'STDCN',
    "FooterText" VARCHAR(255),
    "Logo_Footer" BYTEA,
    "RPT_Memorandum_Header" VARCHAR(64) NOT NULL DEFAULT 'Memorandum_Header_STD',
    "RPT_Memorandum_Footer" VARCHAR(64) NOT NULL DEFAULT 'Memorandum_Footer_STD',
    "LogoFontSize" INTEGER NOT NULL DEFAULT 24,
    "PDVStatus" INTEGER NOT NULL DEFAULT 0,
    "JBKJS" VARCHAR(20),
    "ER_ApiKey" VARCHAR(50),
    "NazivFirmeNezvanicno" VARCHAR(150),

    CONSTRAINT "aaaaaRadni fajlovi_PK" PRIMARY KEY ("IDBaze")
);

-- CreateTable
CREATE TABLE "RobnaDokumentaMirror" (
    "IDDok" INTEGER NOT NULL,
    "VrstaDokumenta" VARCHAR(5) NOT NULL,
    "DatumDokumenta" DATE NOT NULL,

    CONSTRAINT "RobnaDokumentaMirror_pkey" PRIMARY KEY ("IDDok")
);

-- CreateTable
CREATE TABLE "RobneStavkeMirror" (
    "IDStavke" INTEGER NOT NULL,
    "IDDok" INTEGER NOT NULL,
    "SifraArtikla" INTEGER NOT NULL,
    "KataloskiBroj" VARCHAR(100),
    "IDMagacin" INTEGER NOT NULL,
    "KolicinaUlaz" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "KolicinaIzlaz" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "PoslednjaIzmena" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RobneStavkeMirror_pkey" PRIMARY KEY ("IDStavke")
);

-- CreateTable
CREATE TABLE "SklopoviPDMCrteza" (
    "IDSklopoviCrteza" SERIAL NOT NULL,
    "IDCrtez" INTEGER NOT NULL,
    "KoristiSeUIDCrteza" INTEGER NOT NULL,
    "KoristiSeBrojKomada" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PK_SklopoviPDMCrteza" PRIMARY KEY ("IDSklopoviCrteza")
);

-- CreateTable
CREATE TABLE "StatusiCrteza" (
    "IDStatusCrteza" INTEGER NOT NULL,
    "NazivStatusa" VARCHAR(50) NOT NULL,

    CONSTRAINT "StatusiCrteza_pkey" PRIMARY KEY ("IDStatusCrteza")
);

-- CreateTable
CREATE TABLE "StatusiNacrtaPrimopredaje" (
    "IDStatusNacrtaPrimopredaje" INTEGER NOT NULL,
    "StatusNacrtaPrimopredaje" VARCHAR(100) NOT NULL,

    CONSTRAINT "StatusiNacrtaPrimopredaje_pkey" PRIMARY KEY ("IDStatusNacrtaPrimopredaje")
);

-- CreateTable
CREATE TABLE "StatusiPrimopredaje" (
    "IDStatusPrimopredaje" INTEGER NOT NULL,
    "NazivStatusa" VARCHAR(50) NOT NULL,

    CONSTRAINT "PK_StatusiPrimopredaje" PRIMARY KEY ("IDStatusPrimopredaje")
);

-- CreateTable
CREATE TABLE "T_Planer" (
    "ID" SERIAL NOT NULL,
    "IDFirma" INTEGER NOT NULL DEFAULT 0,
    "KadaDatum" TIMESTAMP(6) NOT NULL,
    "KadaVreme" TIMESTAMP(6) NOT NULL,
    "OdKoga" VARCHAR(50) NOT NULL,
    "ZaKoga" VARCHAR(50) NOT NULL,
    "Subject" VARCHAR(255) NOT NULL DEFAULT '-',
    "Prioritet" INTEGER NOT NULL DEFAULT 0,
    "Poruka" TEXT,
    "RepeatCode" VARCHAR(10) NOT NULL DEFAULT 'JEDNOM',
    "CheckUradjeno" BOOLEAN NOT NULL DEFAULT false,
    "KadaJeUradjeno" TIMESTAMP(6),
    "KoJeUradio" VARCHAR(50),
    "IDProgToExecute" VARCHAR(255),
    "AutoExec" BOOLEAN NOT NULL DEFAULT false,
    "DIVPrviUnos" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "DIVPoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK_T_Planer" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "T_PlanerGrupeUsera" (
    "ID" SERIAL NOT NULL,
    "NazivGrupe" VARCHAR(50) NOT NULL,
    "UserName" VARCHAR(50) NOT NULL,

    CONSTRAINT "T_PlanerGrupeUsera_pkey" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "T_Robna dokumenta" (
    "IDDok" SERIAL NOT NULL,
    "IDFirma" INTEGER NOT NULL DEFAULT 0,
    "Ulaz" BOOLEAN NOT NULL DEFAULT false,
    "Broj naloga" VARCHAR(20) NOT NULL,
    "Vrsta naloga" VARCHAR(5) NOT NULL,
    "Broj dokumenta" VARCHAR(20) NOT NULL,
    "Vrsta dokumenta" VARCHAR(5) NOT NULL,
    "Sifra komitenta" INTEGER NOT NULL DEFAULT 0,
    "Datum dokumenta" TIMESTAMP(6) NOT NULL,
    "Datum knjizenja" TIMESTAMP(6) NOT NULL,
    "Datum valute" TIMESTAMP(6) NOT NULL,
    "Opis" VARCHAR(30),
    "Nacin otpreme" VARCHAR(30),
    "Fco" VARCHAR(30),
    "Broj izjave" VARCHAR(20),
    "Datum izjave" TIMESTAMP(6),
    "Sifra prodavca" INTEGER DEFAULT 0,
    "Nacin placanja" VARCHAR(50),
    "IDTrebZaProizvodnju" INTEGER DEFAULT 0,
    "IDMagacinDOK" INTEGER NOT NULL DEFAULT 1,
    "Memo" TEXT,
    "Kurs" DOUBLE PRECISION DEFAULT 1,
    "IDRadniNalog" INTEGER DEFAULT 0,
    "ObrKurs" DOUBLE PRECISION DEFAULT 1,
    "Carina" DOUBLE PRECISION DEFAULT 0,
    "Spedicija" DOUBLE PRECISION DEFAULT 0,
    "OstaliZavTros" DOUBLE PRECISION DEFAULT 0,
    "DevVredFak" DOUBLE PRECISION DEFAULT 0,
    "Level" SMALLINT DEFAULT 0,
    "IDPredmet" INTEGER DEFAULT 0,
    "Zakljucano" BOOLEAN DEFAULT false,
    "IDDokUF" INTEGER DEFAULT 0,
    "IDDokIF" INTEGER DEFAULT 0,
    "Rezervisi" BOOLEAN DEFAULT false,
    "CarKurs" DOUBLE PRECISION DEFAULT 1,
    "IDDokUSL" INTEGER DEFAULT 0,
    "PovCarOsn" DOUBLE PRECISION DEFAULT 0,
    "DevValuta" VARCHAR(3) DEFAULT 'DIN',
    "IDMestoIsporuke" INTEGER DEFAULT 0,
    "IDRuta" INTEGER DEFAULT 0,
    "IDVozac" INTEGER DEFAULT 0,
    "OJ" INTEGER DEFAULT 0,
    "Potpisano" BOOLEAN DEFAULT false,
    "OD" INTEGER DEFAULT 0,
    "Potpis" VARCHAR(50),
    "DatumIVreme" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "Godina" INTEGER DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
    "DatIVreme" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "IDKontaktOsobe" INTEGER DEFAULT 0,
    "PrimljenNovac" DECIMAL(19,4) DEFAULT 0,
    "UsloviPlacanja" VARCHAR(50),
    "PrimljeniCekovi" DECIMAL(19,4) DEFAULT 0,
    "PrimljenaKartica" DECIMAL(19,4) DEFAULT 0,
    "IDKasa" INTEGER DEFAULT 0,
    "StampanFiskalno" BOOLEAN DEFAULT false,
    "PrimljeniVirmani" DECIMAL(19,4) DEFAULT 0,
    "IDDokExtBaza" INTEGER DEFAULT 0,
    "DokBarKod" VARCHAR(30),
    "DokBrojKutija" SMALLINT DEFAULT 1,

    CONSTRAINT "PK_T_Robna dokumenta" PRIMARY KEY ("IDDok")
);

-- CreateTable
CREATE TABLE "T_Robne stavke" (
    "IDStavke" SERIAL NOT NULL,
    "IDDok" INTEGER NOT NULL DEFAULT 0,
    "Sifra artikla" INTEGER NOT NULL DEFAULT 0,
    "Kolicina" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "KG_Kolicina" DOUBLE PRECISION DEFAULT 0,
    "Nabavna cena - neto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "Zavisni trosak - sopstveni" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "Zavisni trosak - dobavljac" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "Kalkulativna VP cena" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "Kalkulativna MP cena" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "Stvarna VP cena" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "Stvarna MP cena" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "Taksa" DOUBLE PRECISION DEFAULT 0,
    "Obracunat porez na ulazu - roba" BOOLEAN NOT NULL DEFAULT true,
    "Tarifa - roba - ulaz" VARCHAR(5) NOT NULL DEFAULT '3',
    "Obracunat porez na usluge" BOOLEAN NOT NULL DEFAULT true,
    "Tarifa - usluge - izlaz" VARCHAR(5) NOT NULL DEFAULT '1',
    "Obracunat  porez na robu" BOOLEAN NOT NULL DEFAULT true,
    "Tarifa - roba - Izlaz" VARCHAR(5) NOT NULL DEFAULT '3',
    "RabatProc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "KasaProc" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "Odlozeno" SMALLINT DEFAULT 0,
    "Neoporezivi deo" DOUBLE PRECISION DEFAULT 0,
    "Akciza" DOUBLE PRECISION DEFAULT 0,
    "FiksniPorez" DOUBLE PRECISION DEFAULT 0,
    "DevNabCena" DOUBLE PRECISION DEFAULT 0,
    "IDMagacin" INTEGER NOT NULL DEFAULT 1,
    "KNGCena" DOUBLE PRECISION DEFAULT 0,
    "CarStopa" DOUBLE PRECISION DEFAULT 0,
    "IDPredmetStavka" INTEGER NOT NULL DEFAULT 0,
    "OpisStavke" VARCHAR(50),
    "ID_PO" INTEGER DEFAULT 0,
    "PakPoOsnJM" DOUBLE PRECISION DEFAULT 1,
    "IDPrepisaneStavke" INTEGER,
    "ProknjizenoIzProfUIF" BOOLEAN DEFAULT false,
    "IDStavkeTrebovanja" INTEGER DEFAULT 0,

    CONSTRAINT "PK_T_Robne stavke" PRIMARY KEY ("IDStavke")
);

-- CreateTable
CREATE TABLE "UplatniRacuni" (
    "IDFirma" INTEGER NOT NULL DEFAULT 0,
    "ID" SERIAL NOT NULL,
    "UplatniRacun" VARCHAR(50) NOT NULL,
    "NazivBanke" VARCHAR(50),
    "Default" BOOLEAN NOT NULL DEFAULT false,
    "Rbr" SMALLINT NOT NULL DEFAULT 0,
    "KodZemlje" VARCHAR(20),
    "OznakaBanke" VARCHAR(20),

    CONSTRAINT "aaaaaUplatniRacuni_PK" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "VrednostiZaKombo" (
    "Kolona" VARCHAR(64) NOT NULL,
    "Vrednost" VARCHAR(255) NOT NULL,

    CONSTRAINT "PK_TabelaVrednostiZaKombo" PRIMARY KEY ("Kolona","Vrednost")
);

-- CreateTable
CREATE TABLE "Vrsta naloga" (
    "Vrsta naloga" VARCHAR(5) NOT NULL,
    "Opis" VARCHAR(50),

    CONSTRAINT "aaaaaVrsta naloga_PK" PRIMARY KEY ("Vrsta naloga")
);

-- CreateTable
CREATE TABLE "Vrste sifara" (
    "Vrsta sifre" VARCHAR(10) NOT NULL,
    "Opis" VARCHAR(50),

    CONSTRAINT "aaaaaVrste sifara_PK" PRIMARY KEY ("Vrsta sifre")
);

-- CreateTable
CREATE TABLE "_Dnevnik" (
    "ID" SERIAL NOT NULL,
    "Opis" TEXT NOT NULL,
    "DIV" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK__Dnevnik" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "_RegAccess" (
    "ID" SERIAL NOT NULL,
    "HDSn" VARCHAR(100),
    "WinUser" VARCHAR(100),
    "ComputerName" VARCHAR(100),
    "IPAdress" VARCHAR(100),
    "Program_Name" VARCHAR(255),
    "CNNString" VARCHAR(255),
    "Login_Time" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK_RegAccess" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "_RegApps" (
    "DBName" VARCHAR(100),
    "AppName" VARCHAR(100) NOT NULL,
    "Disabled" BOOLEAN NOT NULL DEFAULT false,
    "AplFile" VARCHAR(250) NOT NULL,
    "MDWFile" VARCHAR(250),
    "ClientDir" VARCHAR(250),
    "DownloadDir" VARCHAR(1000),
    "PrviUnos" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "PoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK__RegApp" PRIMARY KEY ("AppName")
);

-- CreateTable
CREATE TABLE "_RegAppsFiles" (
    "DBName" VARCHAR(100),
    "AppName" VARCHAR(100) NOT NULL,
    "AppFileName" VARCHAR(255) NOT NULL,
    "ClientDir" VARCHAR(255) NOT NULL,
    "Install" BOOLEAN NOT NULL DEFAULT false,
    "Update" BOOLEAN NOT NULL DEFAULT false,
    "PrviUnos" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "PoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK__RegAppFile" PRIMARY KEY ("AppName","AppFileName")
);

-- CreateTable
CREATE TABLE "_RegUsers" (
    "DBName" VARCHAR(100),
    "RegUserID" INTEGER NOT NULL,
    "Disabled" BOOLEAN NOT NULL DEFAULT false,
    "HDSn" VARCHAR(100) NOT NULL,
    "WinUser" VARCHAR(100) NOT NULL,
    "ComputerName" VARCHAR(100) NOT NULL,
    "IPAdress" VARCHAR(100),
    "Name" VARCHAR(100),
    "email" VARCHAR(100),
    "Telefon" VARCHAR(100),
    "Opis" VARCHAR(200),
    "VaziOdDatuma" DATE,
    "VaziDoDatuma" DATE,
    "PrviUnos" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "PoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK__Users" PRIMARY KEY ("RegUserID")
);

-- CreateTable
CREATE TABLE "_RegUsersApps" (
    "DBName" VARCHAR(100),
    "RegUserID" INTEGER NOT NULL,
    "AppName" VARCHAR(100) NOT NULL,
    "Disabled" BOOLEAN NOT NULL DEFAULT false,
    "BBUserName" VARCHAR(50),
    "BBPassword" VARCHAR(50),
    "BBMacroName" VARCHAR(100),
    "EXCL" BOOLEAN NOT NULL DEFAULT false,
    "RUNTIME" BOOLEAN NOT NULL DEFAULT false,
    "BBExtraStartUp" VARCHAR(100),
    "BBCMD" VARCHAR(100),
    "PrviUnos" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "PoslednjaIzmena" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK__RegUsersApps" PRIMARY KEY ("RegUserID","AppName")
);

-- CreateTable
CREATE TABLE "_Rev" (
    "ID" SERIAL NOT NULL,
    "APP" VARCHAR(20) NOT NULL DEFAULT 'DB',
    "Ver" VARCHAR(50) NOT NULL DEFAULT '-',
    "VerDatum" TIMESTAMP(6) NOT NULL DEFAULT (CURRENT_DATE)::timestamp without time zone,
    "Tema" VARCHAR(100) NOT NULL DEFAULT '-',
    "Opis" TEXT,
    "Uradjeno" BOOLEAN NOT NULL DEFAULT true,
    "Firma" VARCHAR(30) DEFAULT '-',
    "DIVUnos" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SubRev" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "aaaaa_AppRev_PK" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "tLansiranRN" (
    "IDLansiran" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL DEFAULT 0,
    "Lansiran" BOOLEAN DEFAULT false,
    "DatumUnosa" TIMESTAMP(6) NOT NULL,
    "DIVUnos" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SifraRadnikaUnos" INTEGER NOT NULL DEFAULT 0,
    "PotpisUnos" VARCHAR(50),
    "DIVIspravke" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SifraRadnikaIspravka" INTEGER NOT NULL,
    "PotpisIspravka" VARCHAR(50),

    CONSTRAINT "PK_tLansiranRN" PRIMARY KEY ("IDLansiran")
);

-- CreateTable
CREATE TABLE "tLokacijeDelova" (
    "IDLokacije" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL DEFAULT 0,
    "IDPredmet" INTEGER NOT NULL DEFAULT 0,
    "IDVrstaKvaliteta" INTEGER NOT NULL DEFAULT 0,
    "IDPozicija" INTEGER NOT NULL DEFAULT 0,
    "SifraRadnika" INTEGER NOT NULL DEFAULT 0,
    "Datum" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "Kolicina" INTEGER NOT NULL DEFAULT 0,
    "DatumIVremeUnosa" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PK_tLokacijeDelova" PRIMARY KEY ("IDLokacije")
);

-- CreateTable
CREATE TABLE "tOperacije" (
    "RJgrupaRC" VARCHAR(5) NOT NULL,
    "NazivGrupeRC" VARCHAR(50) NOT NULL,
    "Napomena" VARCHAR(255),
    "IDRadneJedinice" VARCHAR(5) NOT NULL,
    "BezPostupka" BOOLEAN DEFAULT false,
    "ZnacajneOperacijeZaZavrsen" BOOLEAN DEFAULT false,
    "KoristiPrioritet" BOOLEAN NOT NULL DEFAULT false,
    "IDOperacije" SERIAL NOT NULL,
    "PreskocivaOperacija" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PK_tOperacije" PRIMARY KEY ("IDOperacije")
);

-- CreateTable
CREATE TABLE "tOperacijeFix" (
    "ID" SERIAL NOT NULL,
    "RJgrupaRC" VARCHAR(5) NOT NULL,
    "NazivGrupeRC" VARCHAR(50) NOT NULL,
    "Napomena" VARCHAR(255),
    "IDRadneJedinice" VARCHAR(5) NOT NULL,
    "BezPostupka" BOOLEAN,
    "ZnacajneOperacijeZaZavrsen" BOOLEAN,
    "KoristiPrioritet" BOOLEAN NOT NULL
);

-- CreateTable
CREATE TABLE "tPDM" (
    "IDStavkePDM" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL DEFAULT 0,
    "PozicijaPDM" VARCHAR(50) NOT NULL,
    "OperacijaPDM" INTEGER DEFAULT 0,
    "RJgrupaRC" VARCHAR(5) NOT NULL,
    "NazivP" VARCHAR(60),
    "BrojCrtezaP" VARCHAR(50),
    "Komada" INTEGER DEFAULT 0,
    "DIVUnosa" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "DIVIspravke" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SifraRadnika" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PK_tPDM" PRIMARY KEY ("IDStavkePDM")
);

-- CreateTable
CREATE TABLE "tPLP" (
    "IDStavkePLP" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL DEFAULT 0,
    "PozicijaPLP" VARCHAR(50) NOT NULL,
    "RJgrupaRC" VARCHAR(5) NOT NULL,
    "Materijal" VARCHAR(50),
    "DimenzijaMaterijala" VARCHAR(50),
    "JM" VARCHAR(5),
    "TezinaJed" DOUBLE PRECISION DEFAULT 0,
    "Komada" INTEGER DEFAULT 0,
    "BrojPozicije" VARCHAR(50),
    "DIVUnosa" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "DIVIspravke" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SifraRadnika" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PK_tPLP" PRIMARY KEY ("IDStavkePLP")
);

-- CreateTable
CREATE TABLE "tPND" (
    "IDStavkePND" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL DEFAULT 0,
    "PozicijaPND" VARCHAR(50) NOT NULL,
    "OperacijaPND" INTEGER DEFAULT 0,
    "RJgrupaRC" VARCHAR(5) NOT NULL,
    "NazivDela" VARCHAR(80) NOT NULL,
    "Komada" DOUBLE PRECISION DEFAULT 0,
    "Napomena" VARCHAR(50),
    "DIVUnosa" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "DIVIspravke" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SifraRadnika" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PK_tPND" PRIMARY KEY ("IDStavkePND")
);

-- CreateTable
CREATE TABLE "tPozicije" (
    "IDPozicije" INTEGER NOT NULL,
    "Pozicija" VARCHAR(20) NOT NULL,
    "Opis" VARCHAR(250),

    CONSTRAINT "PK_tPozicije" PRIMARY KEY ("IDPozicije")
);

-- CreateTable
CREATE TABLE "tPristupMasini" (
    "IDPristupMasini" SERIAL NOT NULL,
    "SifraRadnika" INTEGER NOT NULL,
    "RJgrupaRC" VARCHAR(5) NOT NULL,
    "Napomena" VARCHAR(250),

    CONSTRAINT "PK_tPristupMasini" PRIMARY KEY ("IDPristupMasini")
);

-- CreateTable
CREATE TABLE "tRN" (
    "IDRN" SERIAL NOT NULL,
    "IDPredmet" INTEGER NOT NULL DEFAULT 0,
    "IdentBroj" VARCHAR(50) NOT NULL,
    "Varijanta" INTEGER NOT NULL DEFAULT 0,
    "BBIDKomitent" INTEGER NOT NULL,
    "BBNazivPredmeta" VARCHAR(250),
    "BBDatumOtvaranja" TIMESTAMP(6) NOT NULL DEFAULT (CURRENT_DATE)::timestamp without time zone,
    "DatumUnosa" TIMESTAMP(6) NOT NULL,
    "Komada" INTEGER NOT NULL DEFAULT 1,
    "BrojCrteza" VARCHAR(100) NOT NULL,
    "Proizvod" VARCHAR(150),
    "TezinaNeobrDela" DOUBLE PRECISION DEFAULT 0,
    "NazivDela" VARCHAR(250) NOT NULL,
    "IdentMaterijala" INTEGER DEFAULT 0,
    "Materijal" VARCHAR(250) NOT NULL,
    "DimenzijaMaterijala" VARCHAR(150) NOT NULL,
    "JM" VARCHAR(50) NOT NULL,
    "TezinaObrDela" DOUBLE PRECISION DEFAULT 0,
    "Napomena" TEXT,
    "StatusRN" BOOLEAN DEFAULT false,
    "RokIzrade" TIMESTAMP(6),
    "DIVUnosaRN" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "DIVIspravkeRN" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SifraRadnika" INTEGER NOT NULL DEFAULT 0,
    "Zakljucano" BOOLEAN DEFAULT false,
    "Potpis" VARCHAR(50),
    "PrnTimer" INTEGER DEFAULT 0,
    "VezaSaBrojemCrteza" VARCHAR(100),
    "IDVrstaKvaliteta" INTEGER NOT NULL DEFAULT 0,
    "Revizija" VARCHAR(3) NOT NULL DEFAULT 'A',
    "IDPrimopredaje" INTEGER NOT NULL DEFAULT 0,
    "IDCrtez" INTEGER NOT NULL DEFAULT 0,
    "IDStatusPrimopredaje" INTEGER NOT NULL DEFAULT 3,
    "SifraRadnikaPrimopredaje" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "aaaaatRN_PK" PRIMARY KEY ("IDRN")
);

-- CreateTable
CREATE TABLE "tRNKomponente" (
    "IDKomponente" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL,
    "IDRNPodkomponenta" INTEGER NOT NULL,
    "BrojKomada" INTEGER NOT NULL DEFAULT 1,
    "Napomena" VARCHAR(255),

    CONSTRAINT "tRNKomponente_pkey" PRIMARY KEY ("IDKomponente")
);

-- CreateTable
CREATE TABLE "tRNNDKomponente" (
    "IDNDKomponente" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL,
    "SifraArtikla" INTEGER NOT NULL,
    "BrojKomada" INTEGER NOT NULL,
    "Napomena" VARCHAR(255),

    CONSTRAINT "tRNNDKomponente_pkey" PRIMARY KEY ("IDNDKomponente")
);

-- CreateTable
CREATE TABLE "tR_Grupa" (
    "ID" SERIAL NOT NULL,
    "Grupa" VARCHAR(10) NOT NULL,
    "Opis" VARCHAR(50),

    CONSTRAINT "PK_tR_Grupa" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "tRadneJedinice" (
    "ID" SERIAL NOT NULL,
    "IDRadneJedinice" VARCHAR(5) NOT NULL,
    "RadnaJedinica" VARCHAR(50) NOT NULL,

    CONSTRAINT "PK_tRadneJedinice" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "tRadnici" (
    "SifraRadnika" SERIAL NOT NULL,
    "Radnik" VARCHAR(50) NOT NULL,
    "ProcenatZaObracun" DOUBLE PRECISION DEFAULT 0,
    "ImeIPrezime" VARCHAR(50),
    "BrLkRadnika" VARCHAR(20),
    "Password" VARCHAR(20),
    "Aktivan" BOOLEAN DEFAULT true,
    "IDRadneJedinice" VARCHAR(5) NOT NULL DEFAULT '0',
    "IDKartice" VARCHAR(50) NOT NULL,
    "LogAcc" VARCHAR(50),
    "IDVrsteRadnika" INTEGER NOT NULL DEFAULT 0,
    "PotpisSlika" VARCHAR(150),
    "DefiniseSaglasan" BOOLEAN DEFAULT false,
    "DefiniseLansiran" BOOLEAN DEFAULT false,
    "MultiNalog" BOOLEAN DEFAULT false,
    "PasswordRadnika" VARCHAR(50) NOT NULL,

    CONSTRAINT "aaaaatRadnici_PK" PRIMARY KEY ("SifraRadnika")
);

-- CreateTable
CREATE TABLE "tSaglasanRN" (
    "IDSaglasan" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL DEFAULT 0,
    "Saglasan" BOOLEAN DEFAULT false,
    "DatumUnosa" TIMESTAMP(6) NOT NULL,
    "DIVUnos" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SifraRadnikaUnos" INTEGER NOT NULL DEFAULT 0,
    "PotpisUnos" VARCHAR(50),
    "DIVIspravke" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "SifraRadnikaIspravka" INTEGER NOT NULL,
    "PotpisIspravka" VARCHAR(50),

    CONSTRAINT "PK_tSaglasanRN" PRIMARY KEY ("IDSaglasan")
);

-- CreateTable
CREATE TABLE "tStavkeRN" (
    "IDStavkeRN" SERIAL NOT NULL,
    "IDRN" INTEGER NOT NULL DEFAULT 0,
    "Operacija" INTEGER NOT NULL DEFAULT 0,
    "RJgrupaRC" VARCHAR(5) NOT NULL,
    "OpisRada" TEXT NOT NULL,
    "AlatPribor" VARCHAR(50),
    "Tpz" DOUBLE PRECISION DEFAULT 0,
    "Tk" DOUBLE PRECISION DEFAULT 0,
    "TezinaTO" DOUBLE PRECISION DEFAULT 0,
    "SifraRadnika" INTEGER NOT NULL DEFAULT 0,
    "DIVUnosa" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "DIVIspravke" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "Prioritet" INTEGER NOT NULL DEFAULT 100,

    CONSTRAINT "PK_tStavkeRN" PRIMARY KEY ("IDStavkeRN")
);

-- CreateTable
CREATE TABLE "tStavkeRNSlike" (
    "ID" SERIAL NOT NULL,
    "IDStavkeRN" INTEGER NOT NULL DEFAULT 0,
    "LinkSlika" VARCHAR(250) NOT NULL,
    "ImeFajla" VARCHAR(50) NOT NULL,

    CONSTRAINT "PK_tStavkeRNSlike" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "tTehPostupak" (
    "IDPostupka" SERIAL NOT NULL,
    "SifraRadnika" INTEGER NOT NULL,
    "IDPredmet" INTEGER NOT NULL DEFAULT 0,
    "IdentBroj" VARCHAR(50) NOT NULL,
    "Varijanta" INTEGER NOT NULL DEFAULT 0,
    "PrnTimer" INTEGER DEFAULT 0,
    "DatumIVremeUnosa" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "Operacija" INTEGER NOT NULL,
    "RJgrupaRC" VARCHAR(5) NOT NULL,
    "Toznaka" VARCHAR(50) NOT NULL,
    "Komada" INTEGER NOT NULL,
    "Potpis" VARCHAR(50),
    "SimbolRadnik" BOOLEAN DEFAULT false,
    "SimbolPostupak" BOOLEAN DEFAULT false,
    "SimbolOperacija" BOOLEAN DEFAULT false,
    "DatumIVremeZavrsetka" TIMESTAMP(6),
    "ZavrsenPostupak" BOOLEAN DEFAULT false,
    "Napomena" TEXT,
    "IDRN" INTEGER NOT NULL DEFAULT 0,
    "IDVrstaKvaliteta" INTEGER NOT NULL DEFAULT 0,
    "DoradaOperacije" INTEGER DEFAULT 0,

    CONSTRAINT "PK_tTehPostupak" PRIMARY KEY ("IDPostupka")
);

-- CreateTable
CREATE TABLE "tTehPostupakBackup" (
    "IDPostupka" SERIAL NOT NULL,
    "SifraRadnika" INTEGER NOT NULL,
    "IDPredmet" INTEGER NOT NULL,
    "IdentBroj" VARCHAR(50) NOT NULL,
    "Varijanta" INTEGER NOT NULL,
    "PrnTimer" INTEGER,
    "DatumIVremeUnosa" TIMESTAMP(6) NOT NULL,
    "Operacija" INTEGER NOT NULL,
    "RJgrupaRC" VARCHAR(5) NOT NULL,
    "Toznaka" VARCHAR(50) NOT NULL,
    "Komada" INTEGER NOT NULL,
    "Potpis" VARCHAR(50),
    "SimbolRadnik" BOOLEAN,
    "SimbolPostupak" BOOLEAN,
    "SimbolOperacija" BOOLEAN,
    "DatumIVremeZavrsetka" TIMESTAMP(6),
    "ZavrsenPostupak" BOOLEAN,
    "Napomena" TEXT,
    "IDRN" INTEGER NOT NULL,
    "IDVrstaKvaliteta" INTEGER NOT NULL,
    "DoradaOperacije" INTEGER,
    "DatumIspravke" TIMESTAMP(6),
    "NapomenaIspravke" VARCHAR(500)
);

-- CreateTable
CREATE TABLE "tTehPostupakDokumentacija" (
    "ID" SERIAL NOT NULL,
    "IDPostupka" INTEGER NOT NULL,
    "LinkFajla" VARCHAR(250) NOT NULL,
    "ImeFajla" VARCHAR(50) NOT NULL,

    CONSTRAINT "PK_tTehPostupakDokumentacija" PRIMARY KEY ("ID")
);

-- CreateTable
CREATE TABLE "tVrsteKvalitetaDelova" (
    "IDVrstaKvaliteta" INTEGER NOT NULL,
    "VrstaKvaliteta" VARCHAR(50) NOT NULL,

    CONSTRAINT "PK_IDVrstaKvaliteta" PRIMARY KEY ("IDVrstaKvaliteta")
);

-- CreateTable
CREATE TABLE "tVrsteRadnika" (
    "IDVrsteRadnika" SERIAL NOT NULL,
    "VrstaRadnika" VARCHAR(50) NOT NULL,
    "DodatnaOvlascenja" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PK_tVrsteRadnika" PRIMARY KEY ("IDVrsteRadnika")
);

-- CreateTable
CREATE TABLE "tmp_T_KontroleNaFormi" (
    "ImeForme" VARCHAR(50) NOT NULL,
    "ImeKontrole" VARCHAR(50) NOT NULL,
    "TipKontrole" VARCHAR(50),

    CONSTRAINT "aaaaatmp_T_KontroleNaFormi_PK" PRIMARY KEY ("ImeForme","ImeKontrole")
);

-- CreateIndex
CREATE UNIQUE INDEX "UQ_Crtez_BrojRev" ON "PDMCrtezi"("BrojCrteza", "Revizija");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_PrimopredajaPDFCrteza_IDPrimopredaje_LinkFajla" ON "PrimopredajaPDFCrteza"("IDPrimopredaje", "LinkFajla");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_R_Tarife_Tarifa" ON "R_Tarife"("Tarifa");

-- CreateIndex
CREATE UNIQUE INDEX "StatusiPrimopredaje_NazivStatusa_key" ON "StatusiPrimopredaje"("NazivStatusa");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_tOperacije_RJgrupaRC" ON "tOperacije"("RJgrupaRC");

-- CreateIndex
CREATE UNIQUE INDEX "UQ_tRNKomponente_IDRN_IDPodkomponente" ON "tRNKomponente"("IDRN", "IDRNPodkomponenta");

-- AddForeignKey
ALTER TABLE "BBDefUser" ADD CONSTRAINT "FK_BBDefUser_BBOdeljenja" FOREIGN KEY ("DefaultOD") REFERENCES "BBOdeljenja"("OD") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "BBDefUser" ADD CONSTRAINT "FK_BBDefUser_BBOrgJedinice" FOREIGN KEY ("DefaultOJ") REFERENCES "BBOrgJedinice"("OJ") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Cenovnik" ADD CONSTRAINT "Cenovnik_FK00" FOREIGN KEY ("Sifra artikla") REFERENCES "R_Artikli"("Sifra artikla") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Cenovnik" ADD CONSTRAINT "Cenovnik_FK01" FOREIGN KEY ("Tarifa") REFERENCES "R_Tarife"("Tarifa") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Komitenti" ADD CONSTRAINT "FK_Komitenti_Prodavci" FOREIGN KEY ("Sifra prodavca") REFERENCES "Prodavci"("Sifra prodavca") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Komitenti" ADD CONSTRAINT "Komitenti_FK01" FOREIGN KEY ("IDVozac") REFERENCES "Komitenti"("Sifra") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Komitenti" ADD CONSTRAINT "Komitenti_FK02" FOREIGN KEY ("Vrsta sifre") REFERENCES "Vrste sifara"("Vrsta sifre") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "KomponentePDMCrteza" ADD CONSTRAINT "FK_KomponentePDMCrteza_TrebaIDCrtez" FOREIGN KEY ("TrebaIDCrtez") REFERENCES "PDMCrtezi"("IDCrtez") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "KomponentePDMCrteza" ADD CONSTRAINT "FK_KomponentePDMCrteza_ZaIDCrtez" FOREIGN KEY ("ZaIDCrtez") REFERENCES "PDMCrtezi"("IDCrtez") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MRP_PotrebeStavke" ADD CONSTRAINT "FK_MRP_PotrebeStavke_MRP_Potrebe" FOREIGN KEY ("IDPotreba") REFERENCES "MRP_Potrebe"("IDPotreba") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "NacrtPrimopredaje" ADD CONSTRAINT "FK_NP_IDGlavniCrtez_PDMCrtezi" FOREIGN KEY ("IDGlavniCrtez") REFERENCES "PDMCrtezi"("IDCrtez") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "NacrtPrimopredaje" ADD CONSTRAINT "FK_NacrtPrim_Predmeti" FOREIGN KEY ("IDPredmet") REFERENCES "Predmeti"("IDPredmet") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "NacrtPrimopredaje" ADD CONSTRAINT "FK_NacrtPrim_Projektant" FOREIGN KEY ("IDProjektant") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "NacrtPrimopredaje" ADD CONSTRAINT "FK_NacrtPrimopredaje_StatusiNacrtaPrimopredaje" FOREIGN KEY ("IDStatusNacrtaPrimopredaje") REFERENCES "StatusiNacrtaPrimopredaje"("IDStatusNacrtaPrimopredaje") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "NacrtPrimopredajeStavke" ADD CONSTRAINT "FK_NPS_RootCrtez" FOREIGN KEY ("IDGlavniCrtez") REFERENCES "PDMCrtezi"("IDCrtez") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "NacrtPrimopredajeStavke" ADD CONSTRAINT "FK_NacrtPrimStavke_NacrtPrim" FOREIGN KEY ("IDNacrtPrim") REFERENCES "NacrtPrimopredaje"("IDNacrtPrim") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PDMCrtezi" ADD CONSTRAINT "FK_PDMCrtezi_StatusiCrteza" FOREIGN KEY ("IDStatusCrteza") REFERENCES "StatusiCrteza"("IDStatusCrteza") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PDM_Planiranje" ADD CONSTRAINT "FK_PDM_Planiranje_CrtezSklopa" FOREIGN KEY ("IDCrtezSklopa") REFERENCES "PDMCrtezi"("IDCrtez") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PDM_PlaniranjeStavke" ADD CONSTRAINT "FK_PDM_PlaniranjeStavke_CrtezNabavke" FOREIGN KEY ("IDCrtezNabavke") REFERENCES "PDMCrtezi"("IDCrtez") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PDM_PlaniranjeStavke" ADD CONSTRAINT "FK_PDM_PlaniranjeStavke_Plan" FOREIGN KEY ("IDPlan") REFERENCES "PDM_Planiranje"("IDPlan") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PrimopredajaCrteza" ADD CONSTRAINT "FK_PPcr_PDMCrtezi" FOREIGN KEY ("IDCrtez") REFERENCES "PDMCrtezi"("IDCrtez") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PrimopredajaCrteza" ADD CONSTRAINT "FK_PPcr_Status" FOREIGN KEY ("IDStatusPrimopredaje") REFERENCES "StatusiPrimopredaje"("IDStatusPrimopredaje") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "PrimopredajaPDFCrteza" ADD CONSTRAINT "FK_PrimopredajaPDFCrteza_PrimopredajaCrtetza" FOREIGN KEY ("IDPrimopredaje") REFERENCES "PrimopredajaCrteza"("IDPrimopredaje") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "RobneStavkeMirror" ADD CONSTRAINT "FK_RSM_Dokument" FOREIGN KEY ("IDDok") REFERENCES "RobnaDokumentaMirror"("IDDok") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SklopoviPDMCrteza" ADD CONSTRAINT "FK_SklopoviPDMCrteza_Crtez" FOREIGN KEY ("IDCrtez") REFERENCES "PDMCrtezi"("IDCrtez") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "SklopoviPDMCrteza" ADD CONSTRAINT "FK_SklopoviPDMCrteza_KoristiSeUIDCrteza" FOREIGN KEY ("KoristiSeUIDCrteza") REFERENCES "PDMCrtezi"("IDCrtez") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "UplatniRacuni" ADD CONSTRAINT "FK_UplatniRacuni_UplatniRacuni" FOREIGN KEY ("ID") REFERENCES "UplatniRacuni"("ID") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "_RegAppsFiles" ADD CONSTRAINT "FK__RegAppsFiles__RegApps" FOREIGN KEY ("AppName") REFERENCES "_RegApps"("AppName") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "_RegUsersApps" ADD CONSTRAINT "FK__RegUsersApps__RegApps" FOREIGN KEY ("AppName") REFERENCES "_RegApps"("AppName") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "_RegUsersApps" ADD CONSTRAINT "FK__RegUsersApps__RegUsers" FOREIGN KEY ("RegUserID") REFERENCES "_RegUsers"("RegUserID") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tLansiranRN" ADD CONSTRAINT "tLansiranRN_FK00" FOREIGN KEY ("IDRN") REFERENCES "tRN"("IDRN") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tLokacijeDelova" ADD CONSTRAINT "FK_tLokacijeDelova_Predmeti" FOREIGN KEY ("IDPredmet") REFERENCES "Predmeti"("IDPredmet") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tLokacijeDelova" ADD CONSTRAINT "FK_tLokacijeDelova_tPozicije" FOREIGN KEY ("IDPozicija") REFERENCES "tPozicije"("IDPozicije") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tLokacijeDelova" ADD CONSTRAINT "FK_tLokacijeDelova_tRadnici" FOREIGN KEY ("SifraRadnika") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPDM" ADD CONSTRAINT "tPDM_FK00" FOREIGN KEY ("SifraRadnika") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPDM" ADD CONSTRAINT "tPDM_FK01" FOREIGN KEY ("RJgrupaRC") REFERENCES "tOperacije"("RJgrupaRC") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPDM" ADD CONSTRAINT "tPDM_FK02" FOREIGN KEY ("IDRN") REFERENCES "tRN"("IDRN") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPLP" ADD CONSTRAINT "tPLP_FK00" FOREIGN KEY ("SifraRadnika") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPLP" ADD CONSTRAINT "tPLP_FK01" FOREIGN KEY ("RJgrupaRC") REFERENCES "tOperacije"("RJgrupaRC") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPLP" ADD CONSTRAINT "tPLP_FK02" FOREIGN KEY ("IDRN") REFERENCES "tRN"("IDRN") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPND" ADD CONSTRAINT "tPND_FK00" FOREIGN KEY ("SifraRadnika") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPND" ADD CONSTRAINT "tPND_FK01" FOREIGN KEY ("RJgrupaRC") REFERENCES "tOperacije"("RJgrupaRC") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPND" ADD CONSTRAINT "tPND_FK02" FOREIGN KEY ("IDRN") REFERENCES "tRN"("IDRN") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPristupMasini" ADD CONSTRAINT "tPristupMasini_FK00" FOREIGN KEY ("RJgrupaRC") REFERENCES "tOperacije"("RJgrupaRC") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tPristupMasini" ADD CONSTRAINT "tPristupMasini_FK01" FOREIGN KEY ("SifraRadnika") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tRN" ADD CONSTRAINT "FK_tRN_SifraRadnikaPrimopredaje_tRadnici" FOREIGN KEY ("SifraRadnikaPrimopredaje") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tRN" ADD CONSTRAINT "FK_tRN_StatusiPrimopredaje" FOREIGN KEY ("IDStatusPrimopredaje") REFERENCES "StatusiPrimopredaje"("IDStatusPrimopredaje") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tRN" ADD CONSTRAINT "FK_tRN_tRadnici" FOREIGN KEY ("SifraRadnika") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tRN" ADD CONSTRAINT "FK_tRN_tVrsteKvalitetaDelova" FOREIGN KEY ("IDVrstaKvaliteta") REFERENCES "tVrsteKvalitetaDelova"("IDVrstaKvaliteta") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tRNKomponente" ADD CONSTRAINT "FK_tRNKomponente_ParentRN" FOREIGN KEY ("IDRN") REFERENCES "tRN"("IDRN") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tRNNDKomponente" ADD CONSTRAINT "FK_tRNNDKomponente_RN" FOREIGN KEY ("IDRN") REFERENCES "tRN"("IDRN") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tRNNDKomponente" ADD CONSTRAINT "FK_tRNNDKomponente_R_Artikli" FOREIGN KEY ("SifraArtikla") REFERENCES "R_Artikli"("Sifra artikla") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tSaglasanRN" ADD CONSTRAINT "tSaglasanRN_FK00" FOREIGN KEY ("IDRN") REFERENCES "tRN"("IDRN") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tStavkeRN" ADD CONSTRAINT "tStavkeRN_FK00" FOREIGN KEY ("SifraRadnika") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tStavkeRN" ADD CONSTRAINT "tStavkeRN_FK01" FOREIGN KEY ("RJgrupaRC") REFERENCES "tOperacije"("RJgrupaRC") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tStavkeRN" ADD CONSTRAINT "tStavkeRN_FK02" FOREIGN KEY ("IDRN") REFERENCES "tRN"("IDRN") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tStavkeRNSlike" ADD CONSTRAINT "FK_tStavkeRNSlike_tStavkeRN" FOREIGN KEY ("IDStavkeRN") REFERENCES "tStavkeRN"("IDStavkeRN") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tTehPostupak" ADD CONSTRAINT "FK_tTehPostupak_tRadnici" FOREIGN KEY ("SifraRadnika") REFERENCES "tRadnici"("SifraRadnika") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tTehPostupakDokumentacija" ADD CONSTRAINT "FK_tTehPostupakDokumentacija_tTehPostupak" FOREIGN KEY ("IDPostupka") REFERENCES "tTehPostupak"("IDPostupka") ON DELETE NO ACTION ON UPDATE NO ACTION;

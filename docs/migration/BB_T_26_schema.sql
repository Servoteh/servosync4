-- ----------------------------------------------------------
-- MDB Tools - A library for reading MS Access database files
-- Copyright (C) 2000-2011 Brian Bruns and others.
-- Files in libmdb are licensed under LGPL and the utilities under
-- the GPL, see COPYING.LIB and COPYING files respectively.
-- Check out http://mdbtools.sourceforge.net
-- ----------------------------------------------------------

-- That file uses encoding UTF-8

CREATE TABLE [_Rev]
 (
	[PK]			Long Integer NOT NULL, 
	[Ver]			Text (64) NOT NULL, 
	[DIV]			DateTime NOT NULL, 
	[Napomena]			Memo/Hyperlink (255)
);

CREATE TABLE [Addinol]
 (
	[Naziv / INO NAZIV   u oba polja se upisuje]			Text (255), 
	[Kataloski broj]			Text (255), 
	[Tarifni broj]			Text (255), 
	[EAN-Number BARKOD]			Text (255), 
	[Density]			Double, 
	[EUR/unit]			Double, 
	[EUR/100KG]			Double, 
	[EUR/100L]			Double, 
	[PRODAJNA CENAEUR]			Double
);

CREATE TABLE [Akcije]
 (
	[IDAkcija]			Long Integer NOT NULL, 
	[OpisAkcije]			Text (50) NOT NULL, 
	[Aktivna]			Boolean NOT NULL, 
	[DatIVreme]			DateTime
);

CREATE TABLE [AkcijeArtikli]
 (
	[IDAkcija]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL, 
	[RabatProc]			Currency NOT NULL, 
	[DatIVreme]			DateTime
);

CREATE TABLE [APVP_CTKolone]
 (
	[OznakaCTKolone]			Text (5) NOT NULL, 
	[VrstaDokumenta]			Text (10) NOT NULL, 
	[VrstaNaloga]			Text (10) NOT NULL, 
	[OpisKolone]			Text (50) NOT NULL
);

CREATE TABLE [ArtikliNaziviPanela]
 (
	[IDProdavnica]			Long Integer NOT NULL, 
	[BrojGlavnogPanela]			Integer NOT NULL, 
	[BrojPanela]			Integer NOT NULL, 
	[Caption]			Text (50)
);

CREATE TABLE [ArtikliPanelDef]
 (
	[FormaIme]			Text (50) NOT NULL, 
	[DugmeIme]			Text (50) NOT NULL, 
	[BrojPanela]			Long Integer NOT NULL, 
	[IDProdavnica]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL
);

CREATE TABLE [AvUplateTrebovanja]
 (
	[ID]			Long Integer, 
	[IDTreb]			Long Integer NOT NULL, 
	[DatumDospeca]			DateTime NOT NULL, 
	[IznosZaUplatu]			Currency NOT NULL, 
	[Placeno]			Boolean NOT NULL
);

CREATE TABLE [BBDefUser]
 (
	[UserName]			Text (20) NOT NULL, 
	[DefaultGodina]			Long Integer NOT NULL, 
	[DefaultOJ]			Long Integer NOT NULL, 
	[DefaultOD]			Long Integer NOT NULL, 
	[UnlockGodina]			Boolean NOT NULL, 
	[UnlockOJ]			Boolean NOT NULL, 
	[UnlockOD]			Boolean NOT NULL, 
	[Level]			Byte NOT NULL, 
	[MaxLevel]			Byte NOT NULL
);

CREATE TABLE [BBOrgJedinice]
 (
	[OJ]			Long Integer NOT NULL, 
	[NazivOJ]			Text (50) NOT NULL
);

CREATE TABLE [BBS_Indexi]
 (
	[ID]			Long Integer, 
	[TableName]			Text (250) NOT NULL, 
	[IndexName]			Text (250), 
	[IndexExpr]			Text (250), 
	[Datum]			DateTime NOT NULL
);

CREATE TABLE [BBS_SveTabele]
 (
	[ImeTabele]			Text (50) NOT NULL, 
	[ZaBrisanje]			Boolean NOT NULL, 
	[RBR]			Long Integer NOT NULL, 
	[BrojSlogova]			Long Integer NOT NULL
);

CREATE TABLE [CarinskeTarife]
 (
	[TarifniBroj]			Text (12) NOT NULL, 
	[CarinskaStopa]			Double NOT NULL
);

CREATE TABLE [CarMagDok]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[BrojKnjige]			Long Integer NOT NULL, 
	[IDJezik]			Long Integer NOT NULL, 
	[Level]			Byte NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[IDCM]			Long Integer, 
	[Ulaz]			Boolean NOT NULL, 
	[CM_Datum]			DateTime, 
	[CM_MagacinskiBr]			Text (10), 
	[Kontrolnik]			Text (20), 
	[JCI]			Text (50), 
	[ObrKurs]			Double NOT NULL, 
	[Sifra komitenta]			Long Integer, 
	[TransportDoGranice]			Double, 
	[TransportUZemlji]			Double, 
	[TransportBrFakt]			Text (50), 
	[Koleta]			Long Integer NOT NULL, 
	[BrutoKg]			Double NOT NULL, 
	[NetoKg]			Double NOT NULL, 
	[INOBrojFakt]			Text (50), 
	[INOVredFakt]			Double NOT NULL, 
	[Napomena]			Memo/Hyperlink (255), 
	[Potpis]			Text (20), 
	[DatumIVremeUnosa]			DateTime, 
	[IDCMUlaz]			Long Integer NOT NULL, 
	[Odobreno]			Boolean NOT NULL, 
	[OdobrioPotpis]			Text (20), 
	[OdobrioDatumIVreme]			DateTime, 
	[Zavrseno]			Boolean NOT NULL, 
	[DevValuta]			Text (5), 
	[SifraKupca]			Long Integer, 
	[BrojFaktureKupca]			Text (10), 
	[IDProfCM]			Long Integer, 
	[IDMagacin]			Long Integer NOT NULL, 
	[Paritet]			Text (50), 
	[LCBroj]			Text (30), 
	[VrstaRobe]			Text (50), 
	[CIPrijave]			Text (10)
);

CREATE TABLE [CarMagStavke]
 (
	[IDCMSt]			Long Integer, 
	[IDCM]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[DevCena]			Double, 
	[CarTarifniBroj]			Text (12), 
	[RedBrSaFakt]			Long Integer, 
	[RedBrNaimenovanja]			Byte, 
	[Tarifa]			Text (5), 
	[ArtKoleta]			Long Integer, 
	[ArtBruto]			Double, 
	[ArtNeto]			Double, 
	[Potpis]			Text (20), 
	[DatumIVremeUnosa]			DateTime, 
	[ZalihePreIzlaza]			Double NOT NULL, 
	[ArtM3]			Double NOT NULL, 
	[InoNazivArt]			Text (50), 
	[InoJmArt]			Text (5)
);

CREATE TABLE [Cenovnik]
 (
	[ID]			Long Integer, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Vrsta dokumenta]			Text (5) NOT NULL, 
	[Cena]			Double NOT NULL, 
	[Tarifa]			Text (5) NOT NULL, 
	[CenaBezPDV]			Currency NOT NULL, 
	[Taksa]			Double NOT NULL, 
	[Prn]			Boolean NOT NULL, 
	[CenaSaPDV]			Currency NOT NULL, 
	[CheckCenaSaPDV]			Boolean NOT NULL, 
	[ZakCen]			Boolean NOT NULL
);

CREATE TABLE [CFG_Global]
 (
	[Parametar]			Text (120), 
	[Vrednost]			Text (150), 
	[Tip]			Text (20), 
	[Opis]			Text (100)
);

CREATE TABLE [CSVExport_Grupa]
 (
	[ID]			Long Integer, 
	[Grupa]			Text (10) NOT NULL
);

CREATE TABLE [CSVExport_Poreklo]
 (
	[ID]			Long Integer, 
	[Poreklo]			Text (5) NOT NULL
);

CREATE TABLE [Depoziti]
 (
	[ID]			Long Integer, 
	[IDKomitent]			Long Integer NOT NULL, 
	[Datum]			DateTime NOT NULL, 
	[Broj dokumenta]			Text (20) NOT NULL, 
	[Zaduzenje]			Currency NOT NULL, 
	[Uplata]			Currency NOT NULL, 
	[Valuta]			Text (3) NOT NULL, 
	[Kurs]			Double NOT NULL, 
	[Opis]			Text (50), 
	[IDDok]			Long Integer, 
	[IDProdavnica]			Long Integer, 
	[IDKasa]			Long Integer, 
	[IDBlagajnaStavke]			Long Integer
);

CREATE TABLE [DobavljaciZaArtikal]
 (
	[ID]			Long Integer, 
	[IDArtikal]			Long Integer NOT NULL, 
	[Sifra dobavljaca]			Long Integer NOT NULL, 
	[Primarni]			Boolean NOT NULL, 
	[VremeIsporuke]			Long Integer NOT NULL
);

CREATE TABLE [ER_DokZaExport_MOD]
 (
	[ID]			Long Integer, 
	[NameIzvor]			Text (50), 
	[ReportName]			Text (50), 
	[DocType]			Text (50), 
	[TableName]			Text (50), 
	[FormatType]			Text (255)
);

CREATE TABLE [ER_SifrePoreskogOslobadjanja]
 (
	[ID_PO]			Long Integer, 
	[Kategorija_PO]			Text (2) NOT NULL, 
	[Oznaka_PO]			Text (50) NOT NULL, 
	[Zakon]			Text (200), 
	[Clan]			Text (50), 
	[Stav]			Text (50), 
	[Tacka]			Text (50), 
	[Podtacka]			Text (50), 
	[Opis_PO]			Memo/Hyperlink (255), 
	[VaziOd]			DateTime, 
	[VaziDo]			DateTime
);

CREATE TABLE [EXT_Dokumenta_USL]
 (
	[ID]			Long Integer NOT NULL, 
	[IDDok]			Long Integer, 
	[BrojNarudzbenice]			Text (20), 
	[DatumNarudzbenice]			DateTime, 
	[OpisNarudzbenice]			Text (100), 
	[BrojOtpremnice]			Text (20), 
	[DatumOtpremnice]			DateTime, 
	[OpisOtpremnice]			Text (100), 
	[Storno]			Boolean NOT NULL, 
	[EdiType]			Text (15), 
	[BrojUgovora]			Text (30), 
	[DatumUgovora]			DateTime
);

CREATE TABLE [EXT_RobnaDokumenta]
 (
	[ID]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[BrojNarudzbenice]			Text (20), 
	[DatumNarudzbenice]			DateTime, 
	[OpisNarudzbenice]			Text (100), 
	[BrojOtpremnice]			Text (20), 
	[DatumOtpremnice]			DateTime, 
	[OpisOtpremnice]			Text (100), 
	[Storno]			Boolean NOT NULL, 
	[EdiType]			Text (15) NOT NULL
);

CREATE TABLE [FP550_CMD]
 (
	[ID]			Long Integer, 
	[NazivCmd]			Text (250), 
	[CMD]			Byte, 
	[SubCMD]			Text (250), 
	[NazivSubCmd]			Text (250), 
	[Sintaksa]			Text (50), 
	[Descr]			Memo/Hyperlink (255), 
	[Odgovor]			Text (250), 
	[DescrOdgovora]			Memo/Hyperlink (255)
);

CREATE TABLE [FP550_IzvrseneKomande]
 (
	[ID]			Long Integer, 
	[Cmd]			Long Integer NOT NULL, 
	[Par]			Text (200), 
	[DatiVr]			DateTime, 
	[rezultat]			Memo/Hyperlink (255), 
	[Uspesno]			Boolean NOT NULL, 
	[Potpis]			Text (50)
);

CREATE TABLE [GrupeSlike]
 (
	[ID]			Long Integer, 
	[IDGrupa]			Text (10) NOT NULL, 
	[LinkSlika]			Text (250)
);

CREATE TABLE [INOUplatniRacuni]
 (
	[IDINOUplatniRacun]			Long Integer, 
	[UplatniRacun]			Text (50) NOT NULL, 
	[CorBanka]			Text (50), 
	[CorSwift]			Text (50), 
	[CorGrad]			Text (50), 
	[CorAdresa]			Text (50), 
	[CorZemlja]			Text (50), 
	[BenBanka]			Text (50) NOT NULL, 
	[BenSwift]			Text (50) NOT NULL, 
	[BenGrad]			Text (50) NOT NULL, 
	[BenAdresa]			Text (50), 
	[BenZemlja]			Text (50), 
	[Default]			Boolean NOT NULL, 
	[Rbr]			Integer NOT NULL
);

CREATE TABLE [KamataRucno]
 (
	[KamateRucnoID]			Long Integer, 
	[Komitent]			Text (50), 
	[DatumObracuna]			DateTime, 
	[BrojDokumenta]			Long Integer, 
	[DatumDokumenta]			DateTime, 
	[DatumValute]			DateTime, 
	[DatumPlacanja]			DateTime, 
	[Iznos]			Double NOT NULL
);

CREATE TABLE [KamataStavkeDetaljno]
 (
	[Konto]			Text (10), 
	[Naziv]			Text (50), 
	[Broj dokumenta]			Text (20), 
	[Datum dokumenta]			DateTime, 
	[Valuta dokumenta]			DateTime, 
	[SumOfDuguje]			Currency, 
	[SumOfPotrazuje]			Currency, 
	[SaldoStavke]			Currency, 
	[KamataDoDatuma]			DateTime, 
	[KoeficijentKamate]			Double, 
	[SumaZaKamatu]			Double, 
	[IznosKamate]			Double
);

CREATE TABLE [KamataVrsteStopa]
 (
	[VrstaStopeID]			Long Integer, 
	[NazivStope]			Text (50)
);

CREATE TABLE [KamatneStope]
 (
	[StopeID]			Long Integer, 
	[VrstaStope]			Long Integer NOT NULL, 
	[OdDatumaStope]			DateTime NOT NULL, 
	[IznosStope]			Double NOT NULL, 
	[ZaDana]			Long Integer NOT NULL
);

CREATE TABLE [KASE]
 (
	[IDKasa]			Long Integer, 
	[Baza]			Text (250) NOT NULL, 
	[SHUTTLE]			Text (250), 
	[Slanje]			Boolean NOT NULL, 
	[Prijem]			Boolean NOT NULL, 
	[Napomena]			Memo/Hyperlink (255), 
	[DatIVremeSlanja]			DateTime, 
	[StatusSlanja]			Text (10), 
	[DatIVremePrijema]			DateTime, 
	[StatusPrijema]			Text (10)
);

CREATE TABLE [KNG_Artikli]
 (
	[KngSifra]			Text (10) NOT NULL, 
	[KngNazivArtikla]			Text (50) NOT NULL, 
	[Jedinica mere]			Text (5), 
	[Cena]			Double NOT NULL
);

CREATE TABLE [KNG_Artikli_2]
 (
	[KngSifra_2]			Text (10) NOT NULL, 
	[KngNazivArtikla]			Text (50) NOT NULL, 
	[Jedinica mere]			Text (5), 
	[Cena]			Double NOT NULL
);

CREATE TABLE [KomitentiKontaktOsobe]
 (
	[IDKontaktOsobe]			Long Integer, 
	[Sifra]			Long Integer NOT NULL, 
	[KontaktOsoba]			Text (50), 
	[KontaktTelefon]			Text (20), 
	[KontaktFax]			Text (20), 
	[KontaktMobilni]			Text (20), 
	[KontaktEmail]			Text (50), 
	[Datum rodjenja]			DateTime, 
	[KontaktDefault]			Boolean NOT NULL
);

CREATE TABLE [Kontni plan]
 (
	[Konto]			Text (10) NOT NULL, 
	[Opis]			Text (255), 
	[Dugacki opis]			Memo/Hyperlink (255), 
	[Plan duguje]			Currency, 
	[Plan potrazuje]			Currency, 
	[Dozvoljen unos analitike]			Boolean NOT NULL, 
	[Fajl sifara]			Text (64), 
	[InoKonto]			Text (10)
);

CREATE TABLE [KOPIJA Robna dokumenta]
 (
	[IDDok]			Long Integer, 
	[Ulaz]			Boolean NOT NULL, 
	[Broj naloga]			Text (20), 
	[Vrsta naloga]			Text (5), 
	[Broj dokumenta]			Text (20) NOT NULL, 
	[Vrsta dokumenta]			Text (5) NOT NULL, 
	[Sifra komitenta]			Long Integer, 
	[Datum dokumenta]			DateTime NOT NULL, 
	[Datum knjizenja]			DateTime, 
	[Datum valute]			DateTime, 
	[Opis]			Text (30), 
	[Nacin otpreme]			Text (30), 
	[Fco]			Text (30), 
	[Broj izjave]			Text (20), 
	[Datum izjave]			DateTime, 
	[Sifra prodavca]			Long Integer, 
	[Nacin placanja]			Text (50), 
	[IDTrebZaProizvodnju]			Long Integer NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[Memo]			Memo/Hyperlink (255), 
	[Kurs]			Double NOT NULL, 
	[IDRadniNalog]			Long Integer
);

CREATE TABLE [KOPIJA Robne stavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Kolicina]			Double, 
	[Nabavna cena - neto]			Currency, 
	[Zavisni trosak - sopstveni]			Currency, 
	[Zavisni trosak - dobavljac]			Currency, 
	[Kalkulativna VP cena]			Currency, 
	[Kalkulativna MP cena]			Currency, 
	[Stvarna VP cena]			Currency, 
	[Stvarna MP cena]			Currency, 
	[Taksa]			Currency, 
	[Obracunat porez na ulazu - roba]			Boolean NOT NULL, 
	[Tarifa - roba - ulaz]			Text (5), 
	[Obracunat porez na usluge]			Boolean NOT NULL, 
	[Tarifa - usluge - izlaz]			Text (5), 
	[Obracunat  porez na robu]			Boolean NOT NULL, 
	[Tarifa - roba - Izlaz]			Text (5), 
	[RabatProc]			Double, 
	[KasaProc]			Double, 
	[Odlozeno]			Integer, 
	[Neoporezivi deo]			Currency NOT NULL, 
	[Akciza]			Currency NOT NULL
);

CREATE TABLE [Kursna lista]
 (
	[Datum]			DateTime NOT NULL, 
	[IDBanka]			Long Integer NOT NULL, 
	[DevValuta]			Text (3) NOT NULL, 
	[SrednjiKurs]			Currency NOT NULL, 
	[ProdajniKurs]			Currency NOT NULL, 
	[KupovniKurs]			Currency NOT NULL
);

CREATE TABLE [LevelVrsteDok]
 (
	[Level]			Byte NOT NULL, 
	[Tabela]			Text (50) NOT NULL, 
	[Opis]			Text (50), 
	[TekstNaReportu]			Text (50), 
	[Report]			Text (50)
);

CREATE TABLE [Magacini]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDMagacin]			Long Integer, 
	[Magacin]			Text (50) NOT NULL, 
	[UlicaIBroj]			Text (50), 
	[Mesto]			Text (30), 
	[ProsecneCene]			Boolean NOT NULL, 
	[VrstaMag]			Text (5), 
	[KontoMag]			Text (10), 
	[ImeMagacionera]			Text (30), 
	[BrLkMagacionera]			Text (20), 
	[PotpisSlika]			Text (250)
);

CREATE TABLE [MestaIzdavanja]
 (
	[IDMestoIzdavanja]			Long Integer, 
	[MestoIzdavanja]			Text (50) NOT NULL
);

CREATE TABLE [MPStavkeNivelacije]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[Stara MP cena]			Currency NOT NULL, 
	[Nova MP cena]			Currency NOT NULL, 
	[Taksa]			Currency NOT NULL, 
	[Stara tarifa]			Text (5) NOT NULL, 
	[Nova tarifa]			Text (5) NOT NULL
);

CREATE TABLE [Nalepnice]
 (
	[IDSet]			Long Integer NOT NULL, 
	[ID]			Long Integer, 
	[IDFirma]			Long Integer, 
	[Broj dokumenta]			Text (20) NOT NULL, 
	[Sifra dobavljaca]			Text (10), 
	[Naziv dobavljaca]			Text (50), 
	[Sifra artikla]			Text (50), 
	[Naziv artikla]			Text (50), 
	[Kolicina]			Integer NOT NULL, 
	[Jedinica mere]			Text (5), 
	[Nabavna cena]			Double, 
	[Zavisni trosak]			Double, 
	[Razlika u ceni]			Double, 
	[VP Cena]			Double NOT NULL, 
	[Tarifa]			Text (5), 
	[Stopa poreza]			Double, 
	[MP Cena]			Double NOT NULL, 
	[PRN]			Boolean NOT NULL, 
	[RbrIzKepu]			Long Integer, 
	[RbrIzTK]			Long Integer, 
	[BarKod]			Text (20), 
	[KolUPak]			Double NOT NULL, 
	[Znak]			Text (5), 
	[OsnJM]			Text (5), 
	[IDArtikal]			Long Integer NOT NULL
);

CREATE TABLE [NalepniceNNID]
 (
	[ID]			Long Integer, 
	[IDStavke]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL
);

CREATE TABLE [ODBC_Synch]
 (
	[ID]			Long Integer, 
	[MasterTableName]			Text (64), 
	[LokalTableName]			Text (64), 
	[Direction]			Text (20), 
	[QueryType]			Text (20), 
	[QueryName]			Text (64), 
	[Opis]			Text (100), 
	[SQLText]			Memo/Hyperlink (255), 
	[DoIt]			Boolean NOT NULL, 
	[DatIVremeKreiranja]			DateTime
);

CREATE TABLE [OK_Stavke]
 (
	[ID]			Long Integer, 
	[IDOK]			Long Integer NOT NULL, 
	[BrojDokumenta]			Text (30), 
	[DatumDokumenta]			DateTime NOT NULL, 
	[DatumValute]			DateTime NOT NULL, 
	[DatumPlacanja]			DateTime NOT NULL, 
	[Iznos]			Double NOT NULL, 
	[Duguje]			Currency NOT NULL, 
	[Potrazuje]			Currency NOT NULL, 
	[IDStavkeGK]			Long Integer NOT NULL, 
	[Saldo]			Currency NOT NULL, 
	[IznosKamate]			Currency NOT NULL
);

CREATE TABLE [OK_VrsteObracuna]
 (
	[IDVrstaObracuna]			Long Integer NOT NULL, 
	[OpisVrsteObracuna]			Text (50)
);

CREATE TABLE [OK_VrsteStopa]
 (
	[IDVrstaStope]			Long Integer, 
	[NazivStope]			Text (50) NOT NULL
);

CREATE TABLE [OP_Dokumenta]
 (
	[IDDok]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[IDKomitent]			Long Integer NOT NULL, 
	[IDMestoIsporuke]			Long Integer NOT NULL, 
	[IDOperater]			Long Integer NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[IDDokVeza]			Long Integer NOT NULL, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[IDRuta]			Long Integer NOT NULL, 
	[IDVozac]			Long Integer NOT NULL, 
	[BrojNaloga]			Text (20) NOT NULL, 
	[VrstaNaloga]			Text (5) NOT NULL, 
	[BrojDokumenta]			Text (20) NOT NULL, 
	[VrstaDokumenta]			Text (5) NOT NULL, 
	[Cenovnik]			Text (10), 
	[DIVUnosa]			DateTime NOT NULL, 
	[DIVIspravke]			DateTime NOT NULL, 
	[DatumPorudzbine]			DateTime NOT NULL, 
	[DatumOtpreme]			DateTime NOT NULL, 
	[Opis]			Text (30), 
	[Memo]			Memo/Hyperlink (255), 
	[Level]			Byte NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[BrojIsporuke]			Integer NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [OP_ModleID]
 (
	[IDDok]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[DoIt]			Boolean NOT NULL
);

CREATE TABLE [Operateri]
 (
	[IDOperater]			Long Integer, 
	[ImeOperatera]			Text (50) NOT NULL, 
	[pwd]			Text (20)
);

CREATE TABLE [OTKUP_Dokumenta]
 (
	[IDDok]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[IDKomitent]			Long Integer NOT NULL, 
	[IDOperater]			Long Integer NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[IDDokVeza]			Long Integer NOT NULL, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[IDRuta]			Long Integer NOT NULL, 
	[IDVozac]			Long Integer NOT NULL, 
	[BrojNaloga]			Text (20) NOT NULL, 
	[VrstaNaloga]			Text (5) NOT NULL, 
	[BrojDokumenta]			Text (20) NOT NULL, 
	[VrstaDokumenta]			Text (5) NOT NULL, 
	[DIVUnosa]			DateTime NOT NULL, 
	[DIVIspravke]			DateTime NOT NULL, 
	[DatumPrijemaUMag]			DateTime NOT NULL, 
	[PeriodOdDatuma]			DateTime NOT NULL, 
	[PeriodDoDatuma]			DateTime NOT NULL, 
	[Opis]			Text (30), 
	[Memo]			Memo/Hyperlink (255), 
	[Level]			Byte NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [OTKUP_Stavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[IDOdKoga]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL, 
	[PMM]			Double NOT NULL, 
	[PSM]			Double NOT NULL, 
	[SomatskeCelije]			Double NOT NULL, 
	[Kiselost]			Double NOT NULL, 
	[ZadovoljenaMikrobiologija]			Boolean NOT NULL, 
	[PrimljenaKolicina]			Double NOT NULL, 
	[Cena]			Double NOT NULL, 
	[TarifaPDV]			Text (5) NOT NULL
);

CREATE TABLE [Parametri za rad]
 (
	[Korisnik]			Text (50), 
	[VrstaDokumenta]			Text (10), 
	[Firma]			Text (50), 
	[Telefon]			Text (50), 
	[Poslednji broj fakture]			Long Integer NOT NULL, 
	[Poslednji broj profakture]			Long Integer NOT NULL, 
	[Faktura kroz]			Text (10), 
	[Profaktura kroz]			Text (10), 
	[Faktura prefix]			Text (10), 
	[Profaktura prefix]			Text (10)
);

CREATE TABLE [PDV_IF_PU_MAP]
 (
	[VrstaDok]			Text (10) NOT NULL, 
	[Kolona]			Text (50) NOT NULL, 
	[Opis]			Text (100)
);

CREATE TABLE [PDV_Knjige]
 (
	[PDVEvidencija]			Text (10) NOT NULL, 
	[Naziv]			Text (120) NOT NULL, 
	[AOPOsnovica]			Text (5) NOT NULL, 
	[AOPIznosPDV]			Text (5) NOT NULL, 
	[UF]			Boolean NOT NULL
);

CREATE TABLE [PDV_Kolone]
 (
	[IDKolonaPDV]			Long Integer, 
	[ImeKolone]			Text (50) NOT NULL, 
	[AOP_PPPDV]			Text (50) NOT NULL
);

CREATE TABLE [PDV_PPPDV]
 (
	[ID]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[PDVVisaStopa]			Currency NOT NULL, 
	[PDVNizaStopa]			Currency NOT NULL, 
	[PDVPoljoStopa]			Currency NOT NULL, 
	[OdDatuma]			DateTime, 
	[DoDatuma]			DateTime, 
	[OsnovicaIzlazSaPravomNaOdbitakPP]			Currency NOT NULL, 
	[PDVIzlazSaPravomNaOdbitakPP]			Currency NOT NULL, 
	[OsnovicaIzlazBezPravaNaOdbitakPP]			Currency NOT NULL, 
	[PDVIzlazBezPravaNaOdbitakPP]			Currency NOT NULL, 
	[OsnovicaIzlazOpstaStopa]			Currency NOT NULL, 
	[PDVIzlazOpstaStopa]			Currency NOT NULL, 
	[OsnovicaIzlazPosebnaStopa]			Currency NOT NULL, 
	[PDVIzlazPosebnaStopa]			Currency NOT NULL, 
	[OsnovicaUlazUvoz]			Currency NOT NULL, 
	[PDVUlazUvoz]			Currency NOT NULL, 
	[OsnovicaUlazPoljo]			Currency NOT NULL, 
	[PDVUlazPoljo]			Currency NOT NULL, 
	[OsnovicaUlazOstalo]			Currency NOT NULL, 
	[PDVUlazOstalo]			Currency NOT NULL, 
	[DatumPrijave]			DateTime, 
	[Opstina]			Text (50), 
	[Firma]			Text (50) NOT NULL, 
	[Delatnost]			Text (250), 
	[Mesto]			Text (50), 
	[MestoPrijave]			Text (50), 
	[Adresa]			Text (100), 
	[PIB]			Text (20) NOT NULL, 
	[ImePoreskogSavetnika]			Text (100), 
	[PIBPoreskogSavetnika]			Text (20), 
	[JMBGPoreskogSavetnika]			Text (20), 
	[Povracaj]			Boolean NOT NULL, 
	[PEPDV]			Text (20), 
	[Period]			Text (10), 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [PDV_SemeKontaZaKnjizenje]
 (
	[Konto]			Text (10) NOT NULL, 
	[PDVEvidencija]			Text (10) NOT NULL, 
	[DugPot]			Boolean NOT NULL, 
	[PDVStopa]			Currency NOT NULL, 
	[PDVOsnovica]			Boolean NOT NULL, 
	[ObracunPDVOsnovica]			Boolean NOT NULL, 
	[ObracunPDVIznos]			Boolean NOT NULL, 
	[PDVGrupa]			Text (10) NOT NULL, 
	[AOP_POPDV]			Text (10)
);

CREATE TABLE [PodgrupeSlike]
 (
	[ID]			Long Integer, 
	[IDPodgrupa]			Text (10) NOT NULL, 
	[LinkSlika]			Text (250)
);

CREATE TABLE [POPDV_SemeKontaZaKnjizenje]
 (
	[Konto]			Text (10) NOT NULL, 
	[PDVOznaka]			Text (10) NOT NULL, 
	[K1Def]			Text (100), 
	[K2Def]			Text (255), 
	[K3Def]			Text (255), 
	[K4Def]			Text (255)
);

CREATE TABLE [Posete]
 (
	[ID]			Long Integer, 
	[IDKupac]			Long Integer NOT NULL, 
	[IDProdavac]			Long Integer NOT NULL, 
	[Datum]			DateTime NOT NULL, 
	[Memo]			Memo/Hyperlink (255) NOT NULL, 
	[KljucnaRec]			Text (20) NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [Pozicije]
 (
	[Pozicija]			Text (10) NOT NULL, 
	[Opis pozicije]			Text (50) NOT NULL
);

CREATE TABLE [Predmeti]
 (
	[IDPredmet]			Long Integer, 
	[BrojPredmeta]			Text (20) NOT NULL, 
	[Opis]			Text (50), 
	[DatumOtvaranja]			DateTime NOT NULL, 
	[IDProdavac]			Long Integer NOT NULL, 
	[IDKomitent]			Long Integer NOT NULL, 
	[NextAction]			Text (50), 
	[DatumZakljucenja]			DateTime, 
	[Memo]			Memo/Hyperlink (255), 
	[Status]			Text (20) NOT NULL, 
	[NasaRef]			Text (20), 
	[NasKontakt1]			Text (50), 
	[NasKontakt2]			Text (50), 
	[NasTel1]			Text (20), 
	[NasTel2]			Text (20), 
	[VasaRef]			Text (20), 
	[VasKontakt1]			Text (50), 
	[VasKontakt2]			Text (50), 
	[VasTel1]			Text (20), 
	[VasTel2]			Text (20), 
	[NabavnaVrednost]			Currency, 
	[Carina]			Currency, 
	[Spedicija]			Currency, 
	[Prevoz]			Currency, 
	[Ostalo]			Currency, 
	[InoDobavljac]			Long Integer, 
	[RJ]			Text (4), 
	[devvaluta]			Text (3), 
	[kurs]			Currency, 
	[IDVrstaPosla]			Long Integer NOT NULL, 
	[NazivPredmeta]			Text (250), 
	[RokZavrsetka]			DateTime NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[BrojUgovora]			Text (100), 
	[DatumUgovora]			DateTime, 
	[BrojNarudzbenice]			Text (100), 
	[DatumNarudzbenice]			DateTime
);

CREATE TABLE [PredmetiFazeDef]
 (
	[IDFazaPredmeta]			Long Integer, 
	[FazaPredmeta]			Text (20) NOT NULL, 
	[Napomena]			Text (255)
);

CREATE TABLE [PredmetiVrstaPosla]
 (
	[IDVrstaPosla]			Long Integer, 
	[VrstaPosla]			Text (20), 
	[Opis]			Text (150)
);

CREATE TABLE [ProdavciZaGK]
 (
	[ID]			Long Integer, 
	[IDStavkeIzGK]			Long Integer NOT NULL, 
	[Sifra prodavca]			Long Integer NOT NULL
);

CREATE TABLE [ProduktObrade]
 (
	[IDStavke]			Long Integer, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer, 
	[Kolicina]			Double NOT NULL, 
	[Cena]			Currency NOT NULL
);

CREATE TABLE [R_Artikli]
 (
	[Sifra artikla]			Long Integer, 
	[Kataloski broj]			Text (20) NOT NULL, 
	[BarKod]			Text (20), 
	[PLU]			Long Integer NOT NULL, 
	[ExtSifra]			Text (20), 
	[Naziv]			Text (50) NOT NULL, 
	[Jedinica mere]			Text (5), 
	[Pakovanje]			Text (10), 
	[InoJm]			Text (5), 
	[Kutija]			Double, 
	[Transportno pakovanje]			Double, 
	[Poreklo]			Text (5) NOT NULL, 
	[Grupa]			Text (10) NOT NULL, 
	[Podgrupa]			Text (10) NOT NULL, 
	[Tarifa robe]			Text (5) NOT NULL, 
	[Tarifa usluga]			Text (5) NOT NULL, 
	[Uvek porez na robu]			Boolean NOT NULL, 
	[Uvek porez na usluge]			Boolean NOT NULL, 
	[VP cena]			Double, 
	[MP cena]			Double, 
	[NabDevCena]			Double, 
	[ProdDevCena]			Double, 
	[Minimalna kolicina]			Double, 
	[ArtTaksa]			Double, 
	[Odlozeno]			Integer NOT NULL, 
	[Neoporezivi deo]			Double NOT NULL, 
	[MaxRabatProc]			Double NOT NULL, 
	[Memo]			Memo/Hyperlink (255), 
	[KngSifra]			Text (10) NOT NULL, 
	[ArtAkciza]			Double NOT NULL, 
	[KngSifra_2]			Text (10), 
	[ZavTrosProiz]			Double NOT NULL, 
	[CarStopa]			Double NOT NULL, 
	[IDRaster]			Long Integer NOT NULL, 
	[CarTarifa]			Text (20), 
	[ZemljaPorekla]			Text (20), 
	[Polica]			Text (20), 
	[INONaziv]			Text (50), 
	[SifDob]			Long Integer NOT NULL, 
	[WebOpis]			Text (255), 
	[OpisArtikla]			Text (50), 
	[Tezina]			Double NOT NULL, 
	[PDFLink]			Text (255), 
	[ZaBrisanje]			Boolean NOT NULL, 
	[Aktivan]			Boolean NOT NULL, 
	[CenaZaUpisUCen]			Double NOT NULL, 
	[IDMestoIzdavanja]			Long Integer NOT NULL, 
	[Proizvodjac]			Text (50), 
	[HPS]			Text (50) NOT NULL, 
	[PotpisArt]			Text (50), 
	[DatumIVremeArt]			DateTime, 
	[KolUPak]			Double NOT NULL, 
	[KLRucProc]			Currency NOT NULL, 
	[OsnJM]			Text (5), 
	[SlikaSimbolaLink]			Text (250), 
	[MPKaloProc]			Double NOT NULL, 
	[WordLokacija]			Text (250), 
	[VPKaloProc]			Double NOT NULL, 
	[NeVodiZalihe]			Boolean NOT NULL, 
	[TezinaKg]			Double NOT NULL, 
	[Zapremina]			Double NOT NULL, 
	[Povrsina]			Double NOT NULL, 
	[RSort]			Long Integer NOT NULL, 
	[AkcijskiRabat]			Double NOT NULL, 
	[Napomena2]			Text (255), 
	[IDKvalitetArtikla]			Long Integer NOT NULL, 
	[Debljina]			Double NOT NULL
);

CREATE TABLE [R_Artikli_BarKod]
 (
	[ID]			Long Integer, 
	[IDArtikal]			Long Integer NOT NULL, 
	[BarKod]			Text (20) NOT NULL, 
	[MultiFaktor]			Currency NOT NULL
);

CREATE TABLE [R_Artikli_Ino]
 (
	[IDArtikal]			Long Integer NOT NULL, 
	[IDJezik]			Long Integer NOT NULL, 
	[InoNazivArt]			Text (50) NOT NULL, 
	[InoJMArt]			Text (5)
);

CREATE TABLE [R_Grupa]
 (
	[Grupa]			Text (10) NOT NULL, 
	[Opis]			Text (50)
);

CREATE TABLE [R_KvalitetArtikla]
 (
	[IDKvalitetArtikla]			Long Integer NOT NULL, 
	[KvalitetArtikal]			Text (20) NOT NULL, 
	[Opis]			Text (20) NOT NULL
);

CREATE TABLE [R_Poreklo]
 (
	[Poreklo]			Text (5) NOT NULL, 
	[Opis]			Text (50), 
	[PodgrupaVeza]			Text (10) NOT NULL, 
	[PopustProc]			Currency NOT NULL
);

CREATE TABLE [R_Tarife]
 (
	[Tarifa]			Text (5) NOT NULL, 
	[Osnovna stopa]			Double, 
	[Zeleznica stopa]			Double, 
	[Gradska stopa]			Double, 
	[Ratna stopa]			Double NOT NULL, 
	[Posebna stopa]			Double NOT NULL, 
	[Opis]			Memo/Hyperlink (255), 
	[Vazi od]			DateTime, 
	[Vazi do]			DateTime, 
	[PDVGrupa]			Text (10) NOT NULL
);

CREATE TABLE [Rabati]
 (
	[ID]			Long Integer, 
	[Sifra]			Long Integer NOT NULL, 
	[RabatProc]			Double NOT NULL, 
	[IDGrupa]			Text (10) NOT NULL, 
	[ExtraRabatProc]			Double NOT NULL
);

CREATE TABLE [RabatiPoArt]
 (
	[ID]			Long Integer, 
	[Sifra]			Long Integer NOT NULL, 
	[RabatProc]			Double NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL, 
	[OdDatuma]			DateTime NOT NULL, 
	[DoDatuma]			DateTime NOT NULL, 
	[ExtraRabatProc]			Double NOT NULL
);

CREATE TABLE [Radni fajlovi]
 (
	[IDBaze]			Long Integer, 
	[Firma]			Text (50) NOT NULL, 
	[Naziv baze]			Text (255) NOT NULL, 
	[Logo]			OLE (255), 
	[Mesto]			Text (50), 
	[Adresa]			Text (50), 
	[Telefon]			Text (50), 
	[Fax]			Text (50), 
	[Ziro racun]			Text (50), 
	[Delatnost]			Text (255), 
	[Sifra delatnosti]			Text (50), 
	[Opstina]			Text (50), 
	[Napomena]			Memo/Hyperlink (255), 
	[Specijal]			Text (50) NOT NULL, 
	[e-mail]			Text (30), 
	[Maticni broj]			Text (50), 
	[Registarski broj]			Text (50), 
	[Podracuni]			Text (100), 
	[Kasa_ProdavnicaID]			Long Integer, 
	[Kasa_KupacID]			Long Integer, 
	[Kasa_VrstaDokumenta]			Text (5), 
	[Kasa_RadniNalogID]			Long Integer, 
	[BrDecUlKl]			Integer NOT NULL, 
	[BrDecIzKl]			Integer NOT NULL, 
	[KursDeli]			Boolean NOT NULL, 
	[ProveraZalihaMag]			Boolean NOT NULL, 
	[AutoPodelaPrihoda]			Boolean NOT NULL, 
	[FakturnaJeVPZaUlKl]			Boolean NOT NULL, 
	[KepuPoNabavnojCeni]			Boolean NOT NULL, 
	[TrgovackaPoKursu]			Boolean NOT NULL, 
	[KepuPoKursu]			Boolean NOT NULL, 
	[GKPoKursu]			Boolean NOT NULL, 
	[KontoKupac]			Text (20), 
	[KontoDobavljac]			Text (20), 
	[KnjiziRazlikeNaTK]			Boolean NOT NULL, 
	[KnjiziRazlikeNaKEPU]			Boolean NOT NULL, 
	[KnjiziRazlikeNaMPKEPU]			Boolean NOT NULL, 
	[GKPoKursuObrnuto]			Boolean NOT NULL, 
	[AutoZakRoba]			Boolean NOT NULL, 
	[AutoZakGK]			Boolean NOT NULL, 
	[StarijeOdDanaRoba]			Long Integer NOT NULL, 
	[StarijeOdDanaGk]			Long Integer NOT NULL, 
	[ProveraPorukaInterval]			Long Integer NOT NULL, 
	[DekodirajBarKod]			Boolean NOT NULL, 
	[PIB]			Text (20), 
	[Garancija]			Memo/Hyperlink (255), 
	[KEPUPoKNGCeni]			Boolean NOT NULL, 
	[PEPDV]			Text (20), 
	[Vlasnik]			Text (50), 
	[PoreskaSifra]			Text (50), 
	[Galeb]			Boolean NOT NULL, 
	[Raster]			Boolean NOT NULL, 
	[PG_Naziv baze]			Text (255), 
	[ServerZaGaleb]			Boolean NOT NULL, 
	[KlijentZaGaleb]			Boolean NOT NULL, 
	[FP_ImeStampaca]			Text (50) NOT NULL, 
	[MestoIzdavanjaRacuna]			Text (50), 
	[Kasa_KasaID]			Long Integer NOT NULL, 
	[WebAdresa]			Text (50), 
	[APRText]			Text (250), 
	[SaljiBosson]			Boolean NOT NULL, 
	[Kasa_Cenovnik]			Text (5), 
	[VPCenovnik]			Text (5), 
	[FooterText]			Text (255)
);

CREATE TABLE [RasterDefStavkeKolona]
 (
	[IDRaster]			Long Integer NOT NULL, 
	[IDRasteKolona]			Long Integer NOT NULL
);

CREATE TABLE [RasterDefStavkeVrsta]
 (
	[IDRaster]			Long Integer NOT NULL, 
	[IDRasterVrsta]			Long Integer NOT NULL
);

CREATE TABLE [RasterDefZag]
 (
	[IDRaster]			Long Integer, 
	[Raster]			Text (10) NOT NULL, 
	[OpisRastera]			Text (50)
);

CREATE TABLE [RasterMPStavke]
 (
	[IDRasterVrsta]			Long Integer NOT NULL, 
	[IDRasterKolona]			Long Integer NOT NULL, 
	[IDStavkeIzRobnog]			Long Integer NOT NULL, 
	[IDDok]			Long Integer NOT NULL, 
	[IDProdavnice]			Long Integer NOT NULL, 
	[IDKasa]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL
);

CREATE TABLE [RasterStavke]
 (
	[IDRasterVrsta]			Long Integer NOT NULL, 
	[IDRasterKolona]			Long Integer NOT NULL, 
	[IDStavkeIzRobnog]			Long Integer NOT NULL, 
	[IDProizvodjaca]			Text (15) NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[KutijaRaster]			Double
);

CREATE TABLE [Reversi]
 (
	[IDReversa]			Long Integer, 
	[Sifra komitenta]			Long Integer NOT NULL, 
	[Sifra prodavca]			Long Integer NOT NULL, 
	[RazduzioDok]			Boolean NOT NULL, 
	[Broj reversa]			Text (20) NOT NULL, 
	[Datum reversa]			DateTime NOT NULL, 
	[OpisDok]			Text (255), 
	[Napomena]			Memo/Hyperlink (255), 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime
);

CREATE TABLE [SastavMaterijala]
 (
	[KatBrZaSastav]			Text (20) NOT NULL, 
	[Sastav]			Text (50) NOT NULL, 
	[Sl1]			Long Integer, 
	[Sl2]			Long Integer, 
	[Sl3]			Long Integer, 
	[Sl4]			Long Integer, 
	[Sl5]			Long Integer
);

CREATE TABLE [Sema za kontiranje]
 (
	[IDSeme]			Long Integer, 
	[Vrsta naloga]			Text (5) NOT NULL, 
	[Opis]			Text (50)
);

CREATE TABLE [Semafor]
 (
	[Uredjaj]			Text (20), 
	[Zauzet]			Boolean NOT NULL, 
	[StatusPromenjen]			DateTime NOT NULL, 
	[OpisStanja]			Text (200)
);

CREATE TABLE [Slicice]
 (
	[ID]			Long Integer, 
	[Opis]			Text (20), 
	[Slika]			OLE (255)
);

CREATE TABLE [SpecifikacijaZahtevaNabavke]
 (
	[IDStavke]			Long Integer, 
	[IDZahtevaZaNabavku]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[ZahtevanaKolicina]			Double, 
	[Kataloski brojStavke]			Text (20) NOT NULL, 
	[OpisStavke]			Text (150), 
	[Jedinica mereStavke]			Text (5), 
	[SifraDobavljaca]			Long Integer NOT NULL, 
	[Proizvodjaca]			Text (50), 
	[Napomena]			Memo/Hyperlink (255), 
	[DatIVreme]			DateTime, 
	[IDPredmet]			Long Integer NOT NULL, 
	[KreirajUpit]			Boolean NOT NULL, 
	[IDPlanStavka]			Long Integer
);

CREATE TABLE [Stavke seme za kontiranje]
 (
	[IDStavkeSeme]			Long Integer, 
	[IDSeme]			Long Integer, 
	[Konto]			Text (10) NOT NULL, 
	[Opis]			Text (50), 
	[DefDug]			Text (255) NOT NULL, 
	[DefPot]			Text (255) NOT NULL, 
	[Analitika]			Boolean NOT NULL, 
	[Poreklo]			Text (5) NOT NULL, 
	[KngSifra_2]			Text (10) NOT NULL
);

CREATE TABLE [StvarniUtrosakSirovina]
 (
	[IDStavke]			Long Integer, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[Cena]			Double NOT NULL
);

CREATE TABLE [SYNCH_Cenovnik]
 (
	[ID]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Vrsta dokumenta]			Text (10) NOT NULL, 
	[Cena]			Double NOT NULL, 
	[Tarifa]			Text (5) NOT NULL, 
	[Taksa]			Double NOT NULL, 
	[CenaBezPDV]			Currency NOT NULL, 
	[Prn]			Boolean NOT NULL, 
	[CenaSaPDV]			Currency NOT NULL, 
	[CheckCenaSaPDV]			Boolean NOT NULL
);

CREATE TABLE [SYNCH_R_Poreklo]
 (
	[Poreklo]			Text (10) NOT NULL, 
	[Opis]			Text (50), 
	[PopustProc]			Currency NOT NULL
);

CREATE TABLE [T_AVR_Usluge]
 (
	[ID]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[BrojDokAVR]			Text (20) NOT NULL, 
	[DatumDokAVR]			DateTime NOT NULL, 
	[UkIznosSaPDVAVR]			Currency NOT NULL, 
	[UkPDVVisaAVR]			Currency NOT NULL, 
	[UkPDVNizaAVR]			Currency NOT NULL, 
	[KoristiIznosSaPDV]			Currency NOT NULL, 
	[KoristiPDVVisa]			Currency NOT NULL, 
	[KoristiPDVNiza]			Currency NOT NULL, 
	[ID_PO]			Long Integer NOT NULL
);

CREATE TABLE [T_ER_DokumentaNabavke]
 (
	[ID]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[PurchaseInvoiceID]			Text (50) NOT NULL, 
	[InvoiceID]			Text (50), 
	[SalesInvoiceID]			Text (50), 
	[Sifra komitenta]			Long Integer NOT NULL, 
	[Naziv]			Text (150) NOT NULL, 
	[PIB]			Text (30) NOT NULL, 
	[TipDokumenta]			Text (20) NOT NULL, 
	[Broj dokumenta]			Text (50) NOT NULL, 
	[Datum dokumenta]			DateTime NOT NULL, 
	[Datum slanja]			DateTime NOT NULL, 
	[Datum prometa]			DateTime NOT NULL, 
	[Datum valute]			DateTime NOT NULL, 
	[Iznos]			Double NOT NULL, 
	[SEFStatus]			Text (20) NOT NULL, 
	[Comment]			Text (255), 
	[GlobalUID]			Text (50), 
	[LastModifiedUTC]			Text (50), 
	[PrviUnos]			DateTime NOT NULL, 
	[PoslednjaIzmena]			DateTime NOT NULL, 
	[Status]			Text (20) NOT NULL
);

CREATE TABLE [T_ER_StatusDokumenata]
 (
	[ID]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[IzTabele]			Text (10) NOT NULL, 
	[IDDok]			Long Integer NOT NULL, 
	[IDProdavnica]			Long Integer NOT NULL, 
	[IDKasa]			Long Integer NOT NULL, 
	[RequestID]			Text (50) NOT NULL, 
	[Status]			Text (20), 
	[OpisStatusa]			Text (255), 
	[InvoiceID]			Text (50), 
	[PurchaseInvoiceID]			Text (50), 
	[SalesInvoiceID]			Text (50), 
	[GlobalUID]			Text (50), 
	[LastModifiedUTC]			Text (50), 
	[PrviUnos]			DateTime, 
	[PoslednjaIzmena]			DateTime, 
	[ZakljucanUSEFu]			Boolean NOT NULL
);

CREATE TABLE [T_Glavna knjiga]
 (
	[StavkaID]			Long Integer, 
	[Konto]			Text (10) NOT NULL, 
	[InoKonto]			Text (10) NOT NULL, 
	[Analiticka sifra]			Long Integer NOT NULL, 
	[Broj dokumenta]			Text (20) NOT NULL, 
	[Datum dokumenta]			DateTime, 
	[Valuta dokumenta]			DateTime, 
	[Datum knjizenja]			DateTime, 
	[IDNaloga]			Long Integer NOT NULL, 
	[Opis dokumenta]			Text (50), 
	[Duguje]			Currency NOT NULL, 
	[Potrazuje]			Currency NOT NULL, 
	[Povezan]			Boolean NOT NULL, 
	[IDDokIzRobnog]			Long Integer, 
	[Temeljnica]			Text (10), 
	[DevDuguje]			Currency NOT NULL, 
	[DevPotrazuje]			Currency NOT NULL, 
	[DevValuta]			Text (3) NOT NULL, 
	[Pozicija]			Text (10) NOT NULL, 
	[IDDokMP]			Long Integer NOT NULL, 
	[IDProdavnicaMP]			Long Integer NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[IDDokIzUsluga]			Long Integer NOT NULL, 
	[PG_IDDokIzRobnog]			Long Integer, 
	[OJ]			Long Integer NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[OD]			Long Integer NOT NULL, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[PNBOdobBrojGK]			Text (25)
);

CREATE TABLE [T_GrkStavke]
 (
	[ID]			Long Integer, 
	[IDGrk]			Long Integer NOT NULL, 
	[IDStavkeIzGK]			Long Integer NOT NULL, 
	[Opis]			Text (50), 
	[Duguje]			Currency NOT NULL, 
	[Potrazuje]			Currency NOT NULL
);

CREATE TABLE [T_Izvestaj]
 (
	[IDIzvestaja]			Long Integer, 
	[Sifra komitenta]			Long Integer NOT NULL, 
	[Datum izvestaja]			DateTime NOT NULL, 
	[Broj izvestaja]			Text (20) NOT NULL, 
	[Sifra prodavca]			Long Integer NOT NULL, 
	[Napomena]			Memo/Hyperlink (255), 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[Zakljucano]			Boolean NOT NULL
);

CREATE TABLE [T_IzvestajStavke]
 (
	[ID]			Long Integer, 
	[IDIzvestaja]			Long Integer NOT NULL, 
	[IDKontaktOsobe]			Long Integer, 
	[OdVremena]			DateTime NOT NULL, 
	[DoVremena]			DateTime NOT NULL, 
	[Komentar]			Memo/Hyperlink (255) NOT NULL
);

CREATE TABLE [T_Knjiga KEPU_MP]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer, 
	[IDProdavnica]			Long Integer NOT NULL, 
	[Datum knjizenja]			DateTime, 
	[Opis]			Text (50), 
	[Zaduzenje]			Currency, 
	[Razduzenje]			Currency, 
	[Iznos uplate]			Currency, 
	[Rbr]			Long Integer, 
	[Level]			Byte NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [T_MagDok]
 (
	[IDDok]			Long Integer, 
	[Ulaz]			Boolean NOT NULL, 
	[IDMagacinDok]			Long Integer NOT NULL, 
	[IDKomitent]			Long Integer NOT NULL, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[IDVrstaDokumenta]			Long Integer NOT NULL, 
	[IDTrebZaProizvodnju]			Long Integer NOT NULL, 
	[BrojDokumenta]			Text (20) NOT NULL, 
	[Datum]			DateTime, 
	[Napomena]			Memo/Hyperlink (255), 
	[Zakljucano]			Boolean NOT NULL, 
	[IDDokBBUF]			Long Integer NOT NULL, 
	[IDDokBBIF]			Long Integer NOT NULL, 
	[DatIVremeUnosa]			DateTime NOT NULL, 
	[DatIVremeIspravke]			DateTime NOT NULL, 
	[PotpisUnosa]			Text (20) NOT NULL, 
	[PotpisIspravke]			Text (20) NOT NULL, 
	[IDDokUSLMAT]			Long Integer NOT NULL
);

CREATE TABLE [T_MagProizvodjaci]
 (
	[IDProizvodjaca]			Text (15) NOT NULL, 
	[ProizvodjacOpis]			Text (50)
);

CREATE TABLE [T_MagVrsteDokumenata]
 (
	[IDVrsteDokumenta]			Long Integer NOT NULL, 
	[VrstaDokumenta]			Text (50) NOT NULL
);

CREATE TABLE [T_MPDokumenta]
 (
	[IDDok]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[IDProdavnica]			Long Integer NOT NULL, 
	[IDKasa]			Long Integer NOT NULL, 
	[IDKupac]			Long Integer NOT NULL, 
	[IDRadniNalog]			Long Integer, 
	[Broj dokumenta]			Text (20) NOT NULL, 
	[Vrsta dokumenta]			Text (5) NOT NULL, 
	[Datum dokumenta]			DateTime NOT NULL, 
	[Datum valute]			DateTime, 
	[Opis]			Text (30), 
	[Sifra prodavca]			Long Integer NOT NULL, 
	[Kurs]			Double NOT NULL, 
	[PrimljenNovac]			Currency NOT NULL, 
	[PrimljeniCekovi]			Currency NOT NULL, 
	[DatIVreme]			DateTime, 
	[Depozit]			Currency NOT NULL, 
	[RabatProc]			Double NOT NULL, 
	[Smena]			Byte NOT NULL, 
	[Level]			Byte NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[PrimljenaKartica]			Currency NOT NULL, 
	[StampanFiskalno]			Boolean NOT NULL, 
	[FiktRabat]			Double NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[BrojStola]			Long Integer NOT NULL, 
	[Naplaceno]			Boolean NOT NULL, 
	[BrojStampanja]			Byte NOT NULL, 
	[LimitIznos]			Currency NOT NULL, 
	[PrimljeniVirmani]			Currency NOT NULL, 
	[DIVSynch]			DateTime
);

CREATE TABLE [T_MPStavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[IDProdavnice]			Long Integer NOT NULL, 
	[IDKasa]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[KalkulativnaMPCena]			Double, 
	[StvarnaMPCena]			Double, 
	[Taksa]			Double, 
	[TarifaRoba]			Text (5) NOT NULL, 
	[IDStavMagOtpreme]			Long Integer NOT NULL, 
	[Porudzbina]			Integer NOT NULL, 
	[DatIVremePor]			DateTime, 
	[Pripremljeno]			Boolean NOT NULL, 
	[Izdato]			Boolean NOT NULL, 
	[DatIVremePripreme]			DateTime, 
	[DIVSynch]			DateTime
);

CREATE TABLE [T_MPStavke_Obrisane]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[IDProdavnice]			Long Integer NOT NULL, 
	[IDKasa]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[KalkulativnaMPCena]			Currency, 
	[StvarnaMPCena]			Currency, 
	[Taksa]			Currency, 
	[TarifaRoba]			Text (5) NOT NULL, 
	[IDStavMagOtpreme]			Long Integer NOT NULL, 
	[Porudzbina]			Integer NOT NULL, 
	[DatIVremePor]			DateTime, 
	[DatIVremeBrisanja]			DateTime, 
	[DIVSynch]			DateTime
);

CREATE TABLE [T_Nalozi]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDNaloga]			Long Integer, 
	[Broj naloga]			Text (20) NOT NULL, 
	[Vrsta naloga]			Text (5) NOT NULL, 
	[Datum naloga]			DateTime NOT NULL, 
	[Opis naloga]			Memo/Hyperlink (255), 
	[Datum knjizenja]			DateTime NOT NULL, 
	[Level]			Byte NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[STARIID]			Long Integer
);

CREATE TABLE [T_Obelezja_Val]
 (
	[Tabela]			Text (64), 
	[PKIzTabele]			Long Integer, 
	[Obelezje]			Text (20) NOT NULL, 
	[Vrednost]			Text (255)
);

CREATE TABLE [T_OS_Sredstva]
 (
	[IDOS]			Long Integer, 
	[Inventarni broj]			Text (10), 
	[Kataloski broj]			Text (20), 
	[Naziv]			Text (50) NOT NULL, 
	[MarkaTipModel]			Text (50), 
	[Kolicina]			Double, 
	[Jedinica mere]			Text (5), 
	[Poreklo]			Text (5), 
	[Grupa]			Text (10), 
	[Podgrupa]			Text (10), 
	[ID dobavljaca]			Long Integer NOT NULL, 
	[Broj racuna]			Text (10), 
	[Datum nabavke]			DateTime NOT NULL, 
	[Proizvodjac]			Text (30), 
	[Napomena]			Memo/Hyperlink (255), 
	[Stopa otpisa]			Double NOT NULL, 
	[Level]			Byte NOT NULL, 
	[AmGrupa]			Text (10)
);

CREATE TABLE [T_OS_Stavke]
 (
	[IDStavke]			Long Integer, 
	[IDOS]			Long Integer NOT NULL, 
	[Opis]			Text (50), 
	[Datum]			DateTime NOT NULL, 
	[Vrednost]			Currency, 
	[Otpis]			Currency NOT NULL, 
	[DatumObracuna]			DateTime, 
	[PorAmVrednost]			Currency NOT NULL, 
	[PorAmOtpis]			Currency NOT NULL, 
	[PorAmProdaja]			Currency NOT NULL
);

CREATE TABLE [T_PDV_IF]
 (
	[ID]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[PDVVisaStopa]			Currency NOT NULL, 
	[PDVNizaStopa]			Currency NOT NULL, 
	[Datum]			DateTime NOT NULL, 
	[VrstaDok]			Text (10) NOT NULL, 
	[BrDok]			Text (20) NOT NULL, 
	[NazivMestoAdresa]			Text (120) NOT NULL, 
	[PIB]			Text (20) NOT NULL, 
	[VredBezPDVVisa]			Currency NOT NULL, 
	[VredBezPDVNiza]			Currency NOT NULL, 
	[VredBezPDVNula]			Currency NOT NULL, 
	[UmanjenjeBezPDVVisa]			Currency NOT NULL, 
	[DatPorPerioda]			DateTime NOT NULL, 
	[UmanjenjeBezPDVNiza]			Currency NOT NULL, 
	[UmanjenjeBezPDVNula]			Currency NOT NULL, 
	[IDDokIzRobnog]			Long Integer NOT NULL, 
	[IDDokIzFin]			Long Integer NOT NULL, 
	[IdDokIzUsluga]			Long Integer NOT NULL, 
	[IDPazar]			Long Integer NOT NULL, 
	[Level]			Byte NOT NULL, 
	[Period]			Text (10) NOT NULL, 
	[JestePromet]			Boolean NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [T_PDV_UF]
 (
	[ID]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[PDVVisaStopa]			Currency NOT NULL, 
	[PDVNizaStopa]			Currency NOT NULL, 
	[PDVPoljoStopa]			Currency NOT NULL, 
	[Datum]			DateTime NOT NULL, 
	[VrstaDok]			Text (10) NOT NULL, 
	[BrDok]			Text (20) NOT NULL, 
	[NazivMestoAdresa]			Text (120) NOT NULL, 
	[PIB]			Text (20) NOT NULL, 
	[NabVredVanPDV]			Currency NOT NULL, 
	[VredBezPDVVisa]			Currency NOT NULL, 
	[VredBezPDVNiza]			Currency NOT NULL, 
	[VredBezPDVNula]			Currency NOT NULL, 
	[DatPorPerioda]			DateTime NOT NULL, 
	[VredBezPDVPoljo]			Currency NOT NULL, 
	[UmanjenjeBezPDVVisa]			Currency NOT NULL, 
	[UmanjenjeBezPDVNiza]			Currency NOT NULL, 
	[UmanjenjeBezPDVNula]			Currency NOT NULL, 
	[UmanjenjeBezPDVPoljo]			Currency NOT NULL, 
	[IDDokIzRobnog]			Long Integer NOT NULL, 
	[IDDokIzFin]			Long Integer NOT NULL, 
	[IdDokIzUsluga]			Long Integer NOT NULL, 
	[IDPazar]			Long Integer NOT NULL, 
	[Level]			Byte NOT NULL, 
	[Period]			Text (10) NOT NULL, 
	[JestePromet]			Boolean NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [T_PlaniranjeStavkeTipDogadjaja]
 (
	[IDTipDogadjaja]			Long Integer NOT NULL, 
	[NazivTipaDogadjaja]			Text (100) NOT NULL, 
	[Opis]			Text (255), 
	[Aktivan]			Boolean NOT NULL
);

CREATE TABLE [T_PlaniranjeStavkeTok]
 (
	[IDTok]			Long Integer, 
	[IDPlanStavka]			Long Integer NOT NULL, 
	[IDRobnaStavka]			Long Integer, 
	[IDTipDogadjaja]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[DatumDogadjaja]			DateTime NOT NULL, 
	[Korisnik]			Text (100), 
	[Napomena]			Memo/Hyperlink (255), 
	[Aktivno]			Boolean NOT NULL, 
	[PrviUnos]			DateTime, 
	[PoslednjaIzmena]			DateTime
);

CREATE TABLE [T_POPDV_EvidentiranePrijave_Zag]
 (
	[POPDVIDPrijave]			Text (20) NOT NULL, 
	[POPDVOdDatumaPorPerioda]			DateTime, 
	[POPDVDoDatumaPorPerioda]			DateTime, 
	[POPDVDatumPrijave]			DateTime, 
	[POPDVVrstaPrijave]			Text (1), 
	[POPDVIDPrijaveKojaSeMenja]			Text (20) NOT NULL, 
	[BrDec]			Integer NOT NULL
);

CREATE TABLE [T_POPDV_GK]
 (
	[StavkaID]			Long Integer NOT NULL, 
	[PDVOznaka]			Text (10) NOT NULL, 
	[DatPorPerioda]			DateTime NOT NULL, 
	[K1Iznos]			Currency NOT NULL, 
	[K2Iznos]			Currency NOT NULL, 
	[K3Iznos]			Currency NOT NULL, 
	[K4Iznos]			Currency NOT NULL
);

CREATE TABLE [T_Popis stavke]
 (
	[IDStavke]			Long Integer, 
	[IDPopis]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL, 
	[Cena]			Double NOT NULL, 
	[KolKng]			Double NOT NULL, 
	[KolPop]			Double NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[Tarifa]			Text (5) NOT NULL, 
	[NC]			Currency NOT NULL, 
	[VPC]			Currency NOT NULL, 
	[MPC]			Currency NOT NULL
);

CREATE TABLE [T_Profakture]
 (
	[IDDok]			Long Integer, 
	[Ulaz]			Boolean NOT NULL, 
	[Broj naloga]			Text (20), 
	[Vrsta naloga]			Text (5), 
	[Broj dokumenta]			Text (20) NOT NULL, 
	[Vrsta dokumenta]			Text (5) NOT NULL, 
	[Sifra komitenta]			Long Integer NOT NULL, 
	[Datum dokumenta]			DateTime NOT NULL, 
	[Datum knjizenja]			DateTime, 
	[Datum valute]			DateTime, 
	[Opis]			Text (30), 
	[Nacin otpreme]			Text (30), 
	[Fco]			Text (30), 
	[Broj izjave]			Text (10), 
	[Datum izjave]			DateTime, 
	[Sifra prodavca]			Long Integer, 
	[Nacin placanja]			Text (50), 
	[Kurs]			Double NOT NULL, 
	[Level]			Byte NOT NULL, 
	[Status]			Text (10) NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL
);

CREATE TABLE [T_Profakture stavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Kolicina]			Double, 
	[Nabavna cena - neto]			Currency, 
	[Zavisni trosak - sopstveni]			Currency, 
	[Zavisni trosak - dobavljac]			Currency, 
	[Kalkulativna VP cena]			Currency, 
	[Kalkulativna MP cena]			Currency, 
	[Stvarna VP cena]			Currency, 
	[Stvarna MP cena]			Currency, 
	[Taksa]			Currency, 
	[Obracunat porez na ulazu - roba]			Boolean NOT NULL, 
	[Tarifa - roba - ulaz]			Text (5), 
	[Obracunat porez na usluge]			Boolean NOT NULL, 
	[Tarifa - usluge - izlaz]			Text (5), 
	[Obracunat  porez na robu]			Boolean NOT NULL, 
	[Tarifa - roba - Izlaz]			Text (5) NOT NULL, 
	[RabatProc]			Double, 
	[KasaProc]			Double, 
	[Odlozeno]			Integer, 
	[Neoporezivi deo]			Currency NOT NULL
);

CREATE TABLE [T_Proizvodnja]
 (
	[IDDok]			Long Integer, 
	[Sifra komitenta]			Long Integer NOT NULL, 
	[IDKontaktOsobe]			Long Integer NOT NULL, 
	[Vrsta dokumenta]			Long Integer NOT NULL, 
	[Broj dokumenta]			Text (20) NOT NULL, 
	[IDFirma]			Long Integer NOT NULL, 
	[Datum dokumenta]			DateTime NOT NULL, 
	[Datum knjizenja]			DateTime, 
	[Datum valute]			DateTime, 
	[IDMagacinDOK]			Long Integer NOT NULL, 
	[Opis]			Text (255), 
	[Sifra prodavca]			Long Integer NOT NULL, 
	[Nacin placanja]			Text (50), 
	[IDTrebZaProizvodnju]			Long Integer NOT NULL, 
	[IDDokUF]			Long Integer NOT NULL, 
	[IDDokIF]			Long Integer NOT NULL, 
	[IDDokUSL]			Long Integer NOT NULL, 
	[Memo]			Memo/Hyperlink (255), 
	[Kurs]			Double NOT NULL, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[Level]			Byte NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[Rezervisi]			Boolean NOT NULL, 
	[Potpisano]			Boolean NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[Godina]			Long Integer NOT NULL, 
	[IDDokUSLMAT]			Long Integer NOT NULL
);

CREATE TABLE [T_ProizvodnjaStavkeNormativi]
 (
	[IDStavkeNormativ]			Long Integer, 
	[IDStavke]			Long Integer NOT NULL, 
	[Materijal]			Text (15), 
	[Sifra artikla]			Long Integer NOT NULL, 
	[UtrosenaKolicina]			Double NOT NULL, 
	[UtrosenoVreme]			Long Integer NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[NabavnaCena]			Double NOT NULL
);

CREATE TABLE [T_Rastavnice]
 (
	[ID]			Long Integer, 
	[OdSifArt]			Long Integer NOT NULL, 
	[DobijaSeSifArt]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[Level]			Byte NOT NULL, 
	[TezinaKGZaPrer]			Double NOT NULL, 
	[NCKoef]			Double NOT NULL
);

CREATE TABLE [T_Recepti]
 (
	[IDStavke]			Long Integer, 
	[ZaSifruArtikla]			Long Integer NOT NULL, 
	[TrebSifraArtikla]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[Level]			Byte NOT NULL, 
	[TezinaKGZaPrer]			Double NOT NULL
);

CREATE TABLE [T_Robna dokumenta]
 (
	[IDDok]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[Ulaz]			Boolean NOT NULL, 
	[Broj naloga]			Text (20) NOT NULL, 
	[Vrsta naloga]			Text (5) NOT NULL, 
	[Broj dokumenta]			Text (20) NOT NULL, 
	[Vrsta dokumenta]			Text (5) NOT NULL, 
	[Sifra komitenta]			Long Integer NOT NULL, 
	[Datum dokumenta]			DateTime NOT NULL, 
	[Datum knjizenja]			DateTime, 
	[Datum valute]			DateTime, 
	[Opis]			Text (30), 
	[Nacin otpreme]			Text (30), 
	[Fco]			Text (30), 
	[Broj izjave]			Text (20), 
	[Datum izjave]			DateTime, 
	[Sifra prodavca]			Long Integer NOT NULL, 
	[Nacin placanja]			Text (50), 
	[IDTrebZaProizvodnju]			Long Integer NOT NULL, 
	[IDMagacinDOK]			Long Integer NOT NULL, 
	[Memo]			Memo/Hyperlink (255), 
	[Kurs]			Double NOT NULL, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[ObrKurs]			Double NOT NULL, 
	[Carina]			Double NOT NULL, 
	[Spedicija]			Double NOT NULL, 
	[OstaliZavTros]			Double NOT NULL, 
	[DevVredFak]			Double NOT NULL, 
	[Level]			Byte NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[IDDokUF]			Long Integer NOT NULL, 
	[IDDokIF]			Long Integer NOT NULL, 
	[Rezervisi]			Boolean NOT NULL, 
	[CarKurs]			Double NOT NULL, 
	[IDDokUSL]			Long Integer NOT NULL, 
	[PovCarOsn]			Double NOT NULL, 
	[DevValuta]			Text (3) NOT NULL, 
	[IDMestoIsporuke]			Long Integer NOT NULL, 
	[IDRuta]			Long Integer NOT NULL, 
	[IDVozac]			Long Integer NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[Potpisano]			Boolean NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[Godina]			Long Integer NOT NULL, 
	[DatIVreme]			DateTime, 
	[IDKontaktOsobe]			Long Integer NOT NULL, 
	[PrimljenNovac]			Currency NOT NULL, 
	[UsloviPlacanja]			Text (50), 
	[PrimljeniCekovi]			Currency NOT NULL, 
	[PrimljenaKartica]			Currency NOT NULL, 
	[IDKasa]			Long Integer NOT NULL, 
	[StampanFiskalno]			Boolean NOT NULL, 
	[PrimljeniVirmani]			Currency NOT NULL, 
	[IDDokExtBaza]			Long Integer NOT NULL, 
	[DokBarKod]			Text (30), 
	[DokBrojKutija]			Integer NOT NULL, 
	[STARIID]			Long Integer, 
	[PNBOdobBrojDok]			Text (25)
);

CREATE TABLE [T_Robne stavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[KG_Kolicina]			Double NOT NULL, 
	[Nabavna cena - neto]			Double NOT NULL, 
	[Zavisni trosak - sopstveni]			Double NOT NULL, 
	[Zavisni trosak - dobavljac]			Double NOT NULL, 
	[Kalkulativna VP cena]			Double NOT NULL, 
	[Kalkulativna MP cena]			Double NOT NULL, 
	[Stvarna VP cena]			Double NOT NULL, 
	[Stvarna MP cena]			Double NOT NULL, 
	[Taksa]			Double NOT NULL, 
	[Obracunat porez na ulazu - roba]			Boolean NOT NULL, 
	[Tarifa - roba - ulaz]			Text (5) NOT NULL, 
	[Obracunat porez na usluge]			Boolean NOT NULL, 
	[Tarifa - usluge - izlaz]			Text (5) NOT NULL, 
	[Obracunat  porez na robu]			Boolean NOT NULL, 
	[Tarifa - roba - Izlaz]			Text (5) NOT NULL, 
	[RabatProc]			Double NOT NULL, 
	[KasaProc]			Double NOT NULL, 
	[Odlozeno]			Integer NOT NULL, 
	[Neoporezivi deo]			Double NOT NULL, 
	[Akciza]			Double NOT NULL, 
	[FiksniPorez]			Double NOT NULL, 
	[DevNabCena]			Double NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[KNGCena]			Double NOT NULL, 
	[CarStopa]			Double NOT NULL, 
	[IDPredmetStavka]			Long Integer NOT NULL, 
	[OpisStavke]			Text (50), 
	[ID_PO]			Long Integer NOT NULL, 
	[PakPoOsnJM]			Double NOT NULL, 
	[IDPrepisaneStavke]			Long Integer, 
	[ProknjizenoIzProfUIF]			Boolean NOT NULL, 
	[IDStavkeTrebovanja]			Long Integer NOT NULL, 
	[IDPlanStavka]			Long Integer
);

CREATE TABLE [T_StatusDokumenata]
 (
	[ID]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[PrimioFakturu]			Boolean NOT NULL, 
	[UtovarioUVozilo]			Long Integer NOT NULL, 
	[Isporuceno]			Boolean NOT NULL, 
	[Komentar]			Text (50), 
	[Napomena]			Memo/Hyperlink (255), 
	[PripremioRobu]			Long Integer NOT NULL
);

CREATE TABLE [T_Statusi]
 (
	[IDStatus]			Long Integer NOT NULL, 
	[Tabela]			Text (64) NOT NULL, 
	[OpisStatusa]			Text (50)
);

CREATE TABLE [T_tmp]
 (
	[NoviAutoNumber]			Long Integer
);

CREATE TABLE [T_Trebovanja]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDTreb]			Long Integer, 
	[Broj trebovanja]			Text (20) NOT NULL, 
	[Datum trebovanja]			DateTime NOT NULL, 
	[Sifra komitenta]			Long Integer NOT NULL, 
	[Kurs]			Double NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[Napomena]			Memo/Hyperlink (255), 
	[Level]			Byte NOT NULL, 
	[IDPredmetDok]			Long Integer NOT NULL, 
	[IDTrebVeza]			Long Integer NOT NULL, 
	[DevValuta]			Text (3) NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[Poruceno]			Boolean NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Potpisano]			Boolean NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[Zakljucano]			Boolean NOT NULL, 
	[Sifra prodavca]			Long Integer NOT NULL, 
	[DatIVreme]			DateTime, 
	[OpisDok]			Text (255), 
	[VrstaTreb]			Text (15) NOT NULL, 
	[AvansnoPlacanje]			Boolean NOT NULL, 
	[IDUpita]			Long Integer NOT NULL, 
	[STARIID]			Long Integer
);

CREATE TABLE [T_Trebovanja stavke]
 (
	[IDStavke]			Long Integer, 
	[IDTreb]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[ZaliheKol]			Double, 
	[TrebKol]			Double, 
	[IsporucenaKolicina]			Double, 
	[Cena]			Double, 
	[ZaliheKG_Kol]			Double, 
	[UlazKol]			Double NOT NULL, 
	[IzlazKol]			Double NOT NULL, 
	[Opis]			Text (50), 
	[Napomena]			Memo/Hyperlink (255), 
	[OcekivaniDatumIsporuke]			DateTime, 
	[DatumIsporuke]			DateTime, 
	[DatIVreme]			DateTime, 
	[IDPredmet]			Long Integer NOT NULL, 
	[Isporuceno]			Boolean NOT NULL, 
	[RabatProc]			Double NOT NULL, 
	[IDStavkeUpita]			Long Integer NOT NULL, 
	[IDZahtevaZaNabavku]			Long Integer NOT NULL
);

CREATE TABLE [T_TrebovanjaPratecaDok]
 (
	[ID]			Long Integer, 
	[IDTreb]			Long Integer NOT NULL, 
	[LinkFajla]			Text (250) NOT NULL
);

CREATE TABLE [T_Trgovacka knjiga]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer, 
	[IDProdavnica]			Long Integer NOT NULL, 
	[Datum knjizenja]			DateTime, 
	[Opis]			Text (50), 
	[Zaduzenje]			Currency, 
	[Razduzenje]			Currency, 
	[Datum uplate]			DateTime, 
	[Iznos uplate]			Currency, 
	[Rbr]			Long Integer, 
	[Vrsta dokumenta]			Text (5) NOT NULL, 
	[Level]			Byte NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [T_UpitDobavljacu]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[IDUpita]			Long Integer, 
	[Broj upita]			Text (20) NOT NULL, 
	[Datum upita]			DateTime NOT NULL, 
	[Sifra komitenta]			Long Integer NOT NULL, 
	[Napomena]			Memo/Hyperlink (255), 
	[IDPredmetDok]			Long Integer NOT NULL, 
	[IDTrebVeza]			Long Integer NOT NULL, 
	[Poslato]			Boolean NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[Sifra prodavca]			Long Integer NOT NULL, 
	[OpisDok]			Text (255), 
	[IDStatus]			Long Integer, 
	[PrihvacenaPonudaDok]			Boolean NOT NULL
);

CREATE TABLE [T_Usluge dokumenta]
 (
	[IDDok]			Long Integer, 
	[IDFirma]			Long Integer NOT NULL, 
	[Broj naloga]			Text (20), 
	[Vrsta naloga]			Text (5), 
	[Broj dokumenta]			Text (20) NOT NULL, 
	[Vrsta dokumenta]			Text (5) NOT NULL, 
	[Sifra komitenta]			Long Integer, 
	[Datum dokumenta]			DateTime NOT NULL, 
	[Datum knjizenja]			DateTime, 
	[Datum valute]			DateTime, 
	[Napomena]			Memo/Hyperlink (255), 
	[Sifra prodavca]			Long Integer, 
	[Nacin placanja]			Text (50), 
	[IDRadniNalog]			Long Integer, 
	[Level]			Byte NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[IDDokIF]			Long Integer NOT NULL, 
	[Ulaz]			Boolean NOT NULL, 
	[ObrKurs]			Double NOT NULL, 
	[CarKurs]			Double NOT NULL, 
	[PovCarOsn]			Double NOT NULL, 
	[OporeziviZT]			Long Integer NOT NULL, 
	[NeoporeziviZT]			Double NOT NULL, 
	[DevVred]			Double NOT NULL, 
	[DevValuta]			Text (3) NOT NULL, 
	[DevVauta]			Text (3) NOT NULL, 
	[IDDokUSL]			Long Integer NOT NULL, 
	[MestoPrometa]			Text (30) NOT NULL, 
	[DatumPrometa]			DateTime NOT NULL, 
	[Zapisnik]			Memo/Hyperlink (255), 
	[OJ]			Long Integer NOT NULL, 
	[Potpisano]			Boolean NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[Godina]			Long Integer NOT NULL, 
	[IDDokUSLVeza]			Long Integer NOT NULL, 
	[TekstZaFakturu]			Text (50), 
	[PrihvacenDok]			Boolean NOT NULL, 
	[Opis]			Text (255)
);

CREATE TABLE [T_Usluge Servis]
 (
	[IDStavke]			Long Integer, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[IDRadnik]			Long Integer NOT NULL, 
	[Opis]			Text (255) NOT NULL, 
	[Jedinica mere]			Text (5), 
	[Kolicina]			Double NOT NULL, 
	[Cena]			Currency NOT NULL
);

CREATE TABLE [T_Usluge stavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[Opis]			Text (255) NOT NULL, 
	[Jedinica mere]			Text (3), 
	[Kolicina]			Double, 
	[Cena]			Double, 
	[Tarifa usluga]			Text (5) NOT NULL, 
	[Obracunat  porez]			Boolean NOT NULL, 
	[Grupa]			Text (10) NOT NULL, 
	[DevCena]			Double NOT NULL, 
	[CarStopa]			Double NOT NULL, 
	[RabatProc]			Double NOT NULL, 
	[Prihvacena]			Boolean NOT NULL, 
	[IDRazlogOslobadjanja]			Long Integer NOT NULL
);

CREATE TABLE [T_UslugeDok_PratecaDok]
 (
	[IDPrateceDok]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[Link]			Text (255) NOT NULL, 
	[RedBroj]			Byte NOT NULL
);

CREATE TABLE [tImportLog]
 (
	[IDLog]			Long Integer, 
	[DatumLoga]			DateTime NOT NULL, 
	[ExcelRed]			Long Integer NOT NULL, 
	[KataloskiBroj]			Text (100), 
	[NazivFajla]			Text (255) NOT NULL, 
	[Poruka]			Text (255), 
	[Vrednost]			Text (255)
);

CREATE TABLE [tmp_T_KontroleNaFormi]
 (
	[ImeForme]			Text (50) NOT NULL, 
	[ImeKontrole]			Text (50) NOT NULL, 
	[TipKontrole]			Text (50), 
	[TabOrder]			Long Integer NOT NULL, 
	[TabStop]			Boolean NOT NULL
);

CREATE TABLE [TMP_ZaLink]
 (
	[LinkSlika]			Text (250), 
	[Poreklo]			Text (5), 
	[Grupa]			Text (10)
);

CREATE TABLE [tRadnici]
 (
	[SifraRadnika]			Long Integer, 
	[Radnik]			Text (50) NOT NULL, 
	[ProcenatZaObracun]			Double, 
	[ImeIPrezime]			Text (50), 
	[BrLkRadnika]			Text (20), 
	[Password]			Text (20), 
	[Aktivan]			Boolean NOT NULL, 
	[IDRadneJedinice]			Text (5), 
	[IDKartice]			Text (50), 
	[LogAcc]			Text (50), 
	[IDVrsteRadnika]			Long Integer NOT NULL, 
	[PotpisSlika]			Text (150), 
	[DefiniseSaglasan]			Boolean NOT NULL, 
	[DefiniseLansiran]			Boolean NOT NULL, 
	[MultiNalog]			Boolean NOT NULL
);

CREATE TABLE [UplatniRacuni]
 (
	[ID]			Long Integer, 
	[UplatniRacun]			Text (50) NOT NULL, 
	[NazivBanke]			Text (50), 
	[Default]			Boolean NOT NULL, 
	[KodZemlje]			Text (20), 
	[Rbr]			Integer NOT NULL, 
	[OznakaBanke]			Text (20)
);

CREATE TABLE [V_Stavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[KolicinaPoFakturi]			Double, 
	[NabavnaCena]			Double NOT NULL, 
	[ProdajnaCena]			Double NOT NULL, 
	[TarifaPDV]			Text (5), 
	[ObracunatPDV]			Boolean NOT NULL, 
	[RabatProc]			Double, 
	[RokTrajanja]			DateTime, 
	[Komentar]			Text (50)
);

CREATE TABLE [Virmani]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[IDVirman]			Long Integer, 
	[OrganizacionaJedinica]			Text (5), 
	[IDNaTeret]			Long Integer NOT NULL, 
	[IDUKorist]			Long Integer NOT NULL, 
	[SvrhaDoznake]			Text (100), 
	[DPO]			DateTime, 
	[PNBZadModel]			Text (2), 
	[PNBZadBroj]			Text (25), 
	[SifraPlacanja]			Text (5), 
	[Iznos]			Currency, 
	[PNBOdobModel]			Text (2), 
	[PNBOdobBroj]			Text (25), 
	[Mesto]			Text (20), 
	[Datum]			DateTime, 
	[Stampati]			Boolean NOT NULL, 
	[Valuta]			Text (5), 
	[NaTeretZiroRacun]			Text (50), 
	[UKoristZiroRacun]			Text (50), 
	[DIVUnos]			DateTime, 
	[IDDokIzRobnog]			Long Integer NOT NULL, 
	[IDDokIzGK]			Long Integer NOT NULL, 
	[IDStavkaIzNaloga]			Long Integer NOT NULL, 
	[Status]			Long Integer NOT NULL, 
	[DatumKalkulacije]			DateTime NOT NULL, 
	[DatumValute]			DateTime NOT NULL, 
	[RedniBrojSerije]			Long Integer NOT NULL, 
	[Zakljucano]			Boolean NOT NULL
);

CREATE TABLE [Vrsta naloga]
 (
	[Vrsta naloga]			Text (5) NOT NULL, 
	[Opis]			Text (50)
);

CREATE TABLE [Vrste sifara]
 (
	[Vrsta sifre]			Text (10) NOT NULL, 
	[Opis]			Text (50)
);

CREATE TABLE [ZahteviZaNabavku]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[IDZahtevaZaNabavku]			Long Integer, 
	[InicijatorZahteva]			Long Integer NOT NULL, 
	[BrojZahteva]			Text (20) NOT NULL, 
	[DatumZahteva]			DateTime NOT NULL, 
	[Opis]			Text (50), 
	[RokZaZavrsetak]			DateTime, 
	[IDPredmetDok]			Long Integer NOT NULL, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[PorekloZahteva]			Text (20), 
	[IDStatus]			Long Integer, 
	[Napomena]			Text (250), 
	[IDProdavac]			Long Integer NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime
);

CREATE TABLE [ZaSHUTTLE_Info]
 (
	[ID]			Long Integer NOT NULL, 
	[DatumIVremeSlanja]			DateTime, 
	[KoJePoslao]			Text (250), 
	[Prijem]			Boolean NOT NULL, 
	[DatumIVremePrijema]			DateTime, 
	[KoJePrimio]			Text (250)
);

CREATE TABLE [APOP_CTKolone]
 (
	[OznakaCTKolone]			Text (5) NOT NULL, 
	[IDKomitent]			Long Integer NOT NULL, 
	[OpisKolone]			Text (50) NOT NULL, 
	[DoIt]			Boolean NOT NULL
);

CREATE TABLE [ArtikliSlike]
 (
	[ID]			Long Integer, 
	[IDArtikal]			Long Integer NOT NULL, 
	[LinkSlika]			Text (250)
);

CREATE TABLE [BBOdeljenja]
 (
	[OD]			Long Integer NOT NULL, 
	[Naziv]			Text (50) NOT NULL
);

CREATE TABLE [BBPravaPristupa]
 (
	[ID]			Long Integer, 
	[ImeUsera]			Text (20) NOT NULL, 
	[ImeForme]			Text (50) NOT NULL, 
	[ImeKontrole]			Text (50) NOT NULL, 
	[Visible]			Boolean NOT NULL, 
	[Locked]			Boolean NOT NULL, 
	[Enabled]			Boolean NOT NULL, 
	[Vrednost]			Text (30), 
	[RecordSource]			Memo/Hyperlink (255), 
	[Filter]			Text (250)
);

CREATE TABLE [BrojStolaTuraKartica]
 (
	[Broj]			Long Integer NOT NULL, 
	[BrojKartice]			Text (50) NOT NULL, 
	[Aktivan]			Boolean NOT NULL
);

CREATE TABLE [CEN_DozvoljeniCenovnici]
 (
	[CenVrstaDok]			Text (10) NOT NULL, 
	[OpisCenovnika]			Text (100) NOT NULL, 
	[CenSaPDV]			Boolean NOT NULL, 
	[Zakljucan]			Boolean NOT NULL
);

CREATE TABLE [CSVExport_Podgrupa]
 (
	[ID]			Long Integer, 
	[Podgrupa]			Text (10) NOT NULL
);

CREATE TABLE [DExp_KutBarKod]
 (
	[KutBarkod]			Text (30) NOT NULL, 
	[IDDok]			Long Integer NOT NULL, 
	[PaletaBroj]			Text (5) NOT NULL, 
	[PaketBroj]			Text (5) NOT NULL
);

CREATE TABLE [ER_KategorijePO]
 (
	[ID]			Long Integer, 
	[Kategorija_PO]			Text (2) NOT NULL, 
	[OpisKategorije_PO]			Text (200)
);

CREATE TABLE [FP_Artikli]
 (
	[PLU]			Long Integer, 
	[Naziv]			Text (32), 
	[Tarifa]			Text (1), 
	[Cena]			Currency, 
	[ProdataKolicina]			Double, 
	[Promenjen]			Boolean NOT NULL
);

CREATE TABLE [FP_ZahtevZaStampu]
 (
	[ID]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[IDProdavnica]			Long Integer NOT NULL, 
	[IDKasa]			Long Integer NOT NULL, 
	[ZahtevObradjen]			Boolean NOT NULL, 
	[DatumiVremeZahteva]			DateTime, 
	[DatumIVremeObrade]			DateTime, 
	[Status]			Text (50)
);

CREATE TABLE [FP550_Status]
 (
	[StatusByte]			Byte, 
	[StatusBit]			Byte, 
	[ind]			Text (1), 
	[Opis]			Text (250), 
	[Vred]			Byte
);

CREATE TABLE [InoKontniPlan]
 (
	[InoKonto]			Text (10) NOT NULL, 
	[Opis]			Text (50)
);

CREATE TABLE [Komitenti]
 (
	[Sifra]			Long Integer, 
	[Naziv]			Text (50) NOT NULL, 
	[Poslovnica]			Text (50), 
	[Mesto]			Text (30), 
	[Adresa]			Text (50), 
	[Postanski broj]			Text (20), 
	[Ziro racun_1]			Text (30), 
	[Ziro racun_2]			Text (30), 
	[Ziro racun_3]			Text (30), 
	[Telefon]			Text (20), 
	[Fax]			Text (20), 
	[Kontakt]			Text (50), 
	[Napomena]			Memo/Hyperlink (255), 
	[Drzava]			Text (30), 
	[Region]			Long Integer, 
	[Vrsta sifre]			Text (10) NOT NULL, 
	[Email]			Text (50), 
	[Mobilni]			Text (20), 
	[Datum rodjenja]			DateTime, 
	[Web adresa]			Text (50), 
	[Sifra prodavca]			Long Integer NOT NULL, 
	[RabatKomitenta]			Double NOT NULL, 
	[ZastKodKupca]			Text (50), 
	[PIB]			Text (20), 
	[PDVStatus]			Long Integer NOT NULL, 
	[MSifra]			Text (10), 
	[Odlozeno]			Integer NOT NULL, 
	[IDRuta]			Long Integer NOT NULL, 
	[IDVozac]			Long Integer NOT NULL, 
	[IDUplatniRacun]			Long Integer, 
	[FakturisanjePoMestimaIsporuke]			Boolean NOT NULL, 
	[Cenovnik]			Text (5), 
	[PrviUnos]			DateTime, 
	[PoslednjaIzmena]			DateTime, 
	[PrviUnosUser]			Text (20), 
	[PoslednjaIzmenaUser]			Text (20), 
	[ProcenatProvizije]			Double NOT NULL, 
	[FiktRabatKomitenta]			Double NOT NULL, 
	[KomitentiNacinPlacanja]			Text (50), 
	[PotpisKom]			Text (50), 
	[SkraceniNaziv]			Text (30), 
	[DatumIVremeKom]			DateTime, 
	[ProveraDuga]			Boolean NOT NULL, 
	[KreditLimit]			Currency NOT NULL, 
	[NeProveravajPIB]			Boolean NOT NULL, 
	[IDPantheon]			Text (30), 
	[NewsLetter]			Boolean NOT NULL, 
	[PostaNaDruguAdresu]			Boolean NOT NULL, 
	[GLN]			Text (30), 
	[KLRucProc]			Currency NOT NULL, 
	[NapomenaZaSalda]			Memo/Hyperlink (255), 
	[NePrikazatiUPregledu]			Boolean NOT NULL, 
	[JBKJS]			Text (10), 
	[MaticniBroj]			Text (20), 
	[ER_XMLSaPopustomPoArtiklu]			Boolean NOT NULL, 
	[CRF]			Boolean NOT NULL, 
	[KoristiPNBZadModel]			Boolean NOT NULL
);

CREATE TABLE [KontniPlan_STD]
 (
	[Konto]			Text (10) NOT NULL, 
	[Opis]			Text (255), 
	[Dugacki opis]			Memo/Hyperlink (255), 
	[Plan duguje]			Currency, 
	[Plan potrazuje]			Currency, 
	[Dozvoljen unos analitike]			Boolean NOT NULL, 
	[Fajl sifara]			Text (64), 
	[InoKonto]			Text (10)
);

CREATE TABLE [MestaIsporuke]
 (
	[ID]			Long Integer, 
	[IDKomitent]			Long Integer NOT NULL, 
	[NazivMestaIsporuke]			Text (50) NOT NULL, 
	[MestoIsporuke]			Text (30) NOT NULL, 
	[AdresaIsporuke]			Text (50) NOT NULL, 
	[Telefon]			Text (20), 
	[Podrucje]			Text (30) NOT NULL, 
	[Fax]			Text (20), 
	[SifraProdavcaMestaIsporuke]			Long Integer NOT NULL, 
	[KategorijaUgovora]			Text (30), 
	[OpstaKategorizacija]			Text (30), 
	[KanalProdaje]			Text (30), 
	[IDRutaMestaIsporuke]			Long Integer NOT NULL, 
	[IDVozacMestaIsporuke]			Long Integer NOT NULL, 
	[IDUplatniRacunMestaIsporuke]			Long Integer NOT NULL, 
	[GLN]			Text (30), 
	[RegionMestaIsporuke]			Long Integer NOT NULL, 
	[AktivnoMISP]			Boolean NOT NULL, 
	[PostBrojMestaIsporuke]			Text (20), 
	[BrojMestaIsporuke]			Text (20)
);

CREATE TABLE [OK_Stope]
 (
	[ID]			Long Integer, 
	[IDVrstaStope]			Long Integer NOT NULL, 
	[OdDatumaStope]			DateTime NOT NULL, 
	[IznosStope]			Double NOT NULL, 
	[ZaDana]			Long Integer NOT NULL
);

CREATE TABLE [OK_Zag]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDOK]			Long Integer, 
	[IDKomitent]			Long Integer NOT NULL, 
	[BrojObracuna]			Text (20) NOT NULL, 
	[DatumObracuna]			DateTime NOT NULL, 
	[DatumValute]			DateTime NOT NULL, 
	[SerijaObracuna]			Text (10) NOT NULL, 
	[PeriodOdDatuma]			DateTime NOT NULL, 
	[PeriodDoDatuma]			DateTime NOT NULL, 
	[ZaKonto]			Text (10) NOT NULL, 
	[Opis]			Text (200), 
	[Napomena]			Memo/Hyperlink (255), 
	[IDNalogGK]			Long Integer NOT NULL, 
	[IDStavkeGK]			Long Integer NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[VrstaObracuna]			Long Integer NOT NULL
);

CREATE TABLE [OP_Stavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL, 
	[NarucenaKolicina]			Double NOT NULL, 
	[OtpremljenaKolicina]			Double NOT NULL, 
	[IsporucenaKolicina]			Double NOT NULL, 
	[Cena]			Currency NOT NULL, 
	[RabatProc]			Double NOT NULL, 
	[ExRabatProc]			Currency NOT NULL
);

CREATE TABLE [PDV_Knjige_DefKolona]
 (
	[ID]			Long Integer, 
	[IDKnjiga]			Long Integer NOT NULL, 
	[IDKolona]			Long Integer NOT NULL
);

CREATE TABLE [PDV_UF_PU_MAP]
 (
	[VrstaDok]			Text (10) NOT NULL, 
	[Kolona]			Text (50) NOT NULL, 
	[Opis]			Text (100)
);

CREATE TABLE [PredmetiFaze]
 (
	[ID]			Long Integer, 
	[IDPredmet]			Long Integer, 
	[IDFazaPredmeta]			Long Integer, 
	[Opis]			Text (250), 
	[DIVUnosa]			DateTime NOT NULL
);

CREATE TABLE [Prodavci]
 (
	[Sifra prodavca]			Long Integer, 
	[Prodavac]			Text (50) NOT NULL, 
	[Region]			Long Integer, 
	[ProcenatZaObracun]			Double NOT NULL, 
	[DeljivoUGrupi]			Boolean NOT NULL, 
	[ImeProdavca]			Text (30), 
	[BrLkProdavca]			Text (20), 
	[LogAcc]			Text (50) NOT NULL, 
	[Password]			Text (20), 
	[Aktivan]			Boolean NOT NULL, 
	[NefiskalniRN]			Boolean NOT NULL, 
	[Storniranje]			Boolean NOT NULL, 
	[PotpisSlika]			Text (250), 
	[OznakaTima]			Text (10) NOT NULL, 
	[Telefon]			Text (20), 
	[Email]			Text (50)
);

CREATE TABLE [PSF_AnalitickaKonta_T]
 (
	[Konto]			Text (10) NOT NULL, 
	[DinSaldo]			Boolean NOT NULL, 
	[DevSaldo]			Boolean NOT NULL, 
	[OTST]			Boolean NOT NULL
);

CREATE TABLE [R_Artikli_TMP]
 (
	[Sifra artikla]			Long Integer, 
	[Kataloski broj]			Text (20) NOT NULL, 
	[BarKod]			Text (20), 
	[PLU]			Long Integer NOT NULL, 
	[ExtSifra]			Text (20), 
	[Naziv]			Text (50) NOT NULL, 
	[InoNaziv]			Text (50), 
	[Jedinica mere]			Text (5), 
	[InoJm]			Text (5), 
	[Pakovanje]			Text (10), 
	[Kutija]			Double, 
	[Transportno pakovanje]			Double, 
	[Poreklo]			Text (10) NOT NULL, 
	[Grupa]			Text (10) NOT NULL, 
	[Podgrupa]			Text (10) NOT NULL, 
	[Tarifa robe]			Text (5) NOT NULL, 
	[Tarifa usluga]			Text (5) NOT NULL, 
	[Uvek porez na robu]			Boolean NOT NULL, 
	[Uvek porez na usluge]			Boolean NOT NULL, 
	[VP cena]			Double, 
	[MP cena]			Double, 
	[NabDevCena]			Double, 
	[ProdDevCena]			Double, 
	[Minimalna kolicina]			Double, 
	[ArtTaksa]			Double, 
	[Odlozeno]			Integer NOT NULL, 
	[Neoporezivi deo]			Double NOT NULL, 
	[MaxRabatProc]			Double NOT NULL, 
	[Memo]			Memo/Hyperlink (255), 
	[KngSifra]			Text (10) NOT NULL, 
	[ArtAkciza]			Double NOT NULL, 
	[KngSifra_2]			Text (10), 
	[ZavTrosProiz]			Double NOT NULL, 
	[CarStopa]			Double NOT NULL, 
	[IDRaster]			Long Integer NOT NULL, 
	[CarTarifa]			Text (20), 
	[ZemljaPorekla]			Text (20), 
	[SifDob]			Long Integer NOT NULL, 
	[OpisArtikla]			Text (50), 
	[ZaBrisanje]			Boolean NOT NULL, 
	[Aktivan]			Boolean NOT NULL, 
	[IDMestoIzdavanja]			Long Integer NOT NULL, 
	[HPS]			Text (50) NOT NULL, 
	[KolUPak]			Double NOT NULL, 
	[OsnJM]			Text (5), 
	[MPKaloProc]			Double NOT NULL, 
	[VPKaloProc]			Double NOT NULL, 
	[NeVodiZalihe]			Boolean NOT NULL, 
	[TezinaKg]			Double NOT NULL, 
	[Zapremina]			Double NOT NULL
);

CREATE TABLE [R_Podgrupa]
 (
	[Podgrupa]			Text (10) NOT NULL, 
	[Opis]			Text (50), 
	[GrupaVeza]			Text (10) NOT NULL
);

CREATE TABLE [R_Vrste dokumenata]
 (
	[Vrsta dokumenta]			Text (5), 
	[Opis]			Text (50), 
	[Ulazni]			Boolean NOT NULL, 
	[Analiticki konto]			Text (10), 
	[Knjiziti analitiku]			Boolean NOT NULL, 
	[Sema za kontiranje]			Long Integer, 
	[Knjiziti sintetiku]			Boolean NOT NULL, 
	[Prodaja sa PPP]			Boolean NOT NULL, 
	[Prodaja sa PPU]			Boolean NOT NULL, 
	[KnjizitiTKZad]			Boolean NOT NULL, 
	[KnjizitiTKRazd]			Boolean NOT NULL, 
	[TextZaReport]			Text (50), 
	[KnjizitiUPDVEvidenciju]			Boolean NOT NULL, 
	[KEPUDefZaduzenje]			Text (30), 
	[KEPUDefRazduzenje]			Text (30), 
	[InterniDokument]			Boolean NOT NULL, 
	[NumeracijaOd]			Long Integer NOT NULL, 
	[KOTP]			Boolean NOT NULL, 
	[PrefiksBrojaDok]			Text (5), 
	[IDMagacinZaVrstuDok]			Long Integer NOT NULL, 
	[KODJ]			Boolean NOT NULL, 
	[FR]			Boolean NOT NULL, 
	[UticeNaZalihe]			Boolean NOT NULL
);

CREATE TABLE [RadniNalozi]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDRadniNalog]			Long Integer, 
	[Godina]			Long Integer NOT NULL, 
	[Pozicija]			Text (10) NOT NULL, 
	[BrojRadnogNaloga]			Text (20) NOT NULL, 
	[NazivProizvoda]			Text (50) NOT NULL, 
	[DatumOtvaranja]			DateTime NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[JedinicaMere]			Text (4), 
	[CenaProizvoda]			Double NOT NULL, 
	[Memo]			Memo/Hyperlink (255), 
	[IDInvestitor]			Long Integer NOT NULL, 
	[SpecifikacijaRadova]			Memo/Hyperlink (255), 
	[PrilogSpecifikaciji]			Memo/Hyperlink (255), 
	[IntTrKol]			Double NOT NULL, 
	[IntTrJm]			Text (5), 
	[IntTrCena]			Double NOT NULL, 
	[DatumZatvaranja]			DateTime, 
	[IDPredmet]			Long Integer NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime, 
	[RegBroj]			Text (50), 
	[MarkaITip]			Text (100), 
	[BrojSasije]			Text (100), 
	[BrojMotora]			Text (100), 
	[BrojKM]			Long Integer
);

CREATE TABLE [RasterDefKolona]
 (
	[IDRasterKolona]			Long Integer, 
	[KolonaRastera]			Text (4) NOT NULL, 
	[OpisKoloneRastera]			Text (50), 
	[BarKodKolona]			Text (20)
);

CREATE TABLE [RasterDefVrsta]
 (
	[IDRasterVrsta]			Long Integer, 
	[VrstaRastera]			Text (4) NOT NULL, 
	[OpisVrsteRastera]			Text (50), 
	[BarKodVrsta]			Text (20)
);

CREATE TABLE [RasterTrebovanjaStavke]
 (
	[IDRasterVrsta]			Long Integer NOT NULL, 
	[IDRasterKolona]			Long Integer NOT NULL, 
	[IDStavkeIzTrebovanja]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[IDProizvodjaca]			Text (15) NOT NULL, 
	[KutijaRaster]			Double
);

CREATE TABLE [ReversiStavke]
 (
	[IDStavke]			Long Integer, 
	[IDReversa]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[Razduzio]			Boolean NOT NULL, 
	[Datum razduzenja]			DateTime
);

CREATE TABLE [Stavke nivelacije]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer, 
	[Kolicina]			Double, 
	[Stara nabavna cena - neto]			Currency, 
	[Nova nabavna cena - neto]			Currency, 
	[Stari zavisni trosak - sopstveni]			Currency, 
	[Novi zavisni trosak - sopstveni]			Currency, 
	[Stari zavisni trosak - dobavljac]			Currency, 
	[Novi zavisni trosak - dobavljac]			Currency, 
	[Stara VP cena]			Currency, 
	[Nova VP cena]			Currency, 
	[Stara MP cena]			Currency, 
	[Nova MP cena]			Currency, 
	[Stara taksa]			Currency, 
	[Nova taksa]			Currency, 
	[Staro obracunat porez na ulazu - roba]			Boolean NOT NULL, 
	[Novo obracunat porez na ulazu - roba]			Boolean NOT NULL, 
	[Stara tarifa - roba]			Text (5), 
	[Nova tarifa - roba]			Text (5), 
	[Stara tarifa - usluge]			Text (5), 
	[Nova tarifa - usluge]			Text (5), 
	[Stara Akciza]			Currency NOT NULL, 
	[Nova Akciza]			Currency NOT NULL, 
	[KG_Kolicina]			Double NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL
);

CREATE TABLE [T_AVR_Roba]
 (
	[ID]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[BrojDokAVR]			Text (20) NOT NULL, 
	[DatumDokAVR]			DateTime NOT NULL, 
	[UkIznosSaPDVAVR]			Currency NOT NULL, 
	[UkPDVVisaAVR]			Currency NOT NULL, 
	[UkPDVNizaAVR]			Currency NOT NULL, 
	[KoristiIznosSaPDV]			Currency NOT NULL, 
	[KoristiPDVVisa]			Currency NOT NULL, 
	[KoristiPDVNiza]			Currency NOT NULL, 
	[ID_PO]			Long Integer NOT NULL
);

CREATE TABLE [T_GK_IZV_Stavke]
 (
	[ID]			Long Integer, 
	[Rbr]			Long Integer NOT NULL, 
	[IZV]			Text (20) NOT NULL, 
	[Opis]			Text (255) NOT NULL, 
	[Formula]			Text (255), 
	[Vred]			Currency NOT NULL, 
	[_DevVred]			Currency NOT NULL, 
	[DIVDef]			DateTime NOT NULL, 
	[DIVUpdate]			DateTime NOT NULL
);

CREATE TABLE [T_GrkZag]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[IDGrk]			Long Integer, 
	[BrojGrk]			Text (20) NOT NULL, 
	[Datum]			DateTime NOT NULL, 
	[Opis]			Text (50), 
	[Memo]			Text (50), 
	[IDKomitent]			Long Integer, 
	[Level]			Byte NOT NULL
);

CREATE TABLE [T_Knjiga KEPU]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer, 
	[IDMagacin]			Long Integer NOT NULL, 
	[Datum knjizenja]			DateTime, 
	[Opis]			Text (50), 
	[Zaduzenje]			Currency, 
	[Razduzenje]			Currency, 
	[Iznos uplate]			Currency, 
	[Rbr]			Long Integer, 
	[Level]			Byte NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [T_MagStavke]
 (
	[ID]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[IDArtikal]			Long Integer NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[IDVezaUlazaIzlaza]			Long Integer NOT NULL, 
	[IDPredmetStavka]			Long Integer NOT NULL, 
	[Duzina]			Currency NOT NULL, 
	[Sirina]			Currency NOT NULL, 
	[IDProizvodjaca]			Text (15) NOT NULL, 
	[Kolicina]			Currency NOT NULL, 
	[DatIVremeUnosa]			DateTime NOT NULL, 
	[Kutija]			Double, 
	[DatIVremeIspravke]			DateTime NOT NULL, 
	[PotpisUnosa]			Text (20) NOT NULL, 
	[PotpisIspravke]			Text (20) NOT NULL
);

CREATE TABLE [T_MPDokumenta_Placanja]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[IDProdavnice]			Long Integer NOT NULL, 
	[IDKasa]			Long Integer NOT NULL, 
	[IDVrstaPlacanja]			Long Integer NOT NULL, 
	[IDBanke]			Long Integer NOT NULL, 
	[SerijskiBroj]			Text (30) NOT NULL, 
	[Iznos]			Currency NOT NULL, 
	[DatumRealizacije]			DateTime, 
	[BrojTekucegRacuna]			Text (30) NOT NULL, 
	[BrojSpecifikacije]			Text (20) NOT NULL, 
	[Realizovan]			Boolean NOT NULL, 
	[Vlasnik]			Text (30) NOT NULL, 
	[DIVSynch]			DateTime
);

CREATE TABLE [T_Obelezja_Def]
 (
	[Tabela]			Text (64), 
	[Obelezje]			Text (20), 
	[OpisObelezja]			Text (255), 
	[Sekcija]			Text (255), 
	[Rbr]			Long Integer, 
	[TipVrednosti]			Long Integer, 
	[Duzina]			Long Integer
);

CREATE TABLE [T_PDV_GK]
 (
	[ID]			Long Integer, 
	[StavkaID]			Long Integer NOT NULL, 
	[DatPorPerioda]			DateTime NOT NULL, 
	[PDVEvidencija]			Text (10) NOT NULL, 
	[PDVStopa]			Currency NOT NULL, 
	[PDVOsnovica]			Currency NOT NULL, 
	[ObracunPDVOsnovica]			Boolean NOT NULL, 
	[PDVIznos]			Currency NOT NULL, 
	[ObracunPDVIznos]			Boolean NOT NULL, 
	[PDVGrupa]			Text (10) NOT NULL
);

CREATE TABLE [T_PK1]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[IDPK1]			Long Integer, 
	[DatumKnjizenja]			DateTime NOT NULL, 
	[OpisKnjizenja]			Text (50), 
	[ProdajaPoOpsStopi]			Currency NOT NULL, 
	[ProdajaPoNizojStopi]			Currency NOT NULL, 
	[ProdajaBezPP]			Currency NOT NULL, 
	[PrihodOdUslugaSaPP]			Currency NOT NULL, 
	[PrihodOdUlugaBezPP]			Currency NOT NULL, 
	[PlaceniPPProiziUsluga]			Currency NOT NULL, 
	[NabavnaVrednostRobeiRepro]			Currency NOT NULL, 
	[VrednostSopsProiNaMalo]			Currency NOT NULL, 
	[RazlikaUCeni]			Currency NOT NULL, 
	[ObracunatiAkciPP]			Currency NOT NULL, 
	[ProdajnaVrednostRobeiProiz]			Currency NOT NULL, 
	[MatiNemaTrosiAm]			Currency NOT NULL, 
	[DoprinosiBrutoPlat]			Currency NOT NULL, 
	[OstaliRasiRasFin]			Currency NOT NULL, 
	[ZiroracunUplacenao]			Currency NOT NULL, 
	[ZiroracunIsplaceno]			Currency NOT NULL, 
	[rbr]			Long Integer NOT NULL, 
	[OstaliPrihodi]			Currency NOT NULL, 
	[ObracunatiPDV]			Currency NOT NULL, 
	[PrethodniPDV]			Currency NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[IDDokIzRobnog]			Long Integer NOT NULL, 
	[IDDokIzFin]			Long Integer NOT NULL, 
	[IdDokIzUsluga]			Long Integer NOT NULL, 
	[IDPazar]			Long Integer NOT NULL, 
	[Level]			Byte NOT NULL
);

CREATE TABLE [T_POPDV_EvidentiranePrijave_Stavke]
 (
	[POPDVIDPrijave]			Text (20) NOT NULL, 
	[PDVOznaka]			Text (10) NOT NULL, 
	[Rbr]			Long Integer, 
	[Sekcija]			Text (3), 
	[Header]			Text (1), 
	[Opis]			Text (255), 
	[BrojKolona]			Long Integer, 
	[AktivneKolone]			Text (4), 
	[K1Val]			Double, 
	[K2Val]			Double, 
	[K3Val]			Double, 
	[K4Val]			Double, 
	[K1Def]			Text (100), 
	[K2Def]			Text (255), 
	[K3Def]			Text (255), 
	[K4Def]			Text (255), 
	[K1AOP]			Text (10), 
	[K2AOP]			Text (10), 
	[K3AOP]			Text (10), 
	[K4AOP]			Text (10)
);

CREATE TABLE [T_Popis zaglavlja]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDPopis]			Long Integer, 
	[Datum]			DateTime NOT NULL, 
	[Napomena]			Memo/Hyperlink (255), 
	[IDKomitent]			Long Integer NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[Level]			Byte NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[BrDok]			Text (10) NOT NULL, 
	[Serija]			Long Integer NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[IDDokIzRobnog]			Long Integer NOT NULL
);

CREATE TABLE [T_Proizvodnja stavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Kolicina]			Double NOT NULL, 
	[KG_Kolicina]			Double NOT NULL, 
	[Stvarna VP cena]			Double NOT NULL, 
	[Stvarna MP cena]			Double NOT NULL, 
	[Obracunat  porez na robu]			Boolean NOT NULL, 
	[Tarifa - roba - Izlaz]			Text (5) NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[IDPredmetStavka]			Long Integer NOT NULL, 
	[OpisStavke]			Text (50), 
	[IDPrepisaneStavke]			Long Integer, 
	[ProknjizenoIzProfUIF]			Boolean NOT NULL, 
	[Status]			Long Integer NOT NULL
);

CREATE TABLE [T_SerijeStatusa]
 (
	[IDSerije]			Long Integer, 
	[DatumIVremePocetka]			DateTime NOT NULL, 
	[Potpis]			Text (50) NOT NULL, 
	[Napomena]			Memo/Hyperlink (255), 
	[PrimioFakturu]			Boolean NOT NULL, 
	[UtovarioUVozilo]			Long Integer NOT NULL, 
	[Isporuceno]			Boolean NOT NULL, 
	[Komentar]			Text (50), 
	[PripremioRobu]			Long Integer NOT NULL, 
	[UpisiPrimioFakturu]			Boolean NOT NULL, 
	[UpisiUtovarioUVozilo]			Boolean NOT NULL, 
	[UpisiIsporuceno]			Boolean NOT NULL, 
	[UpisiKomentar]			Boolean NOT NULL, 
	[UpisiPripremioRobu]			Boolean NOT NULL
);

CREATE TABLE [T_StavkeSerijeStatusa]
 (
	[ID]			Long Integer, 
	[IDSerije]			Long Integer NOT NULL, 
	[IDDok]			Long Integer
);

CREATE TABLE [T_Trebovanja_ERNabavka]
 (
	[ID]			Long Integer, 
	[IDTreb]			Long Integer NOT NULL, 
	[PurchaseInvoiceID]			Text (50) NOT NULL
);

CREATE TABLE [T_UpitDobavljacu Stavke]
 (
	[IDStavke]			Long Integer, 
	[IDUpita]			Long Integer NOT NULL, 
	[Sifra artikla]			Long Integer NOT NULL, 
	[Kataloski brojStavkeUpita]			Text (20) NOT NULL, 
	[OpisStavkeUpita]			Text (150), 
	[Jedinica mereStavkeUpita]			Text (5), 
	[TrebKol]			Double NOT NULL, 
	[DatIVreme]			DateTime, 
	[IDPredmet]			Long Integer NOT NULL, 
	[Proizvodjaca]			Text (50), 
	[RokZaIsporuku]			DateTime, 
	[PrihvacenaPonuda]			Boolean NOT NULL
);

CREATE TABLE [T_Usluge_PratecaDok]
 (
	[IDPrateceDok]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[Link]			Text (255) NOT NULL, 
	[RedBroj]			Byte NOT NULL
);

CREATE TABLE [UI_Stavke]
 (
	[IDStavke]			Long Integer, 
	[IDDok]			Long Integer NOT NULL, 
	[IDMagacin]			Long Integer NOT NULL, 
	[PaketBroj]			Text (5) NOT NULL, 
	[PaletaBroj]			Text (5), 
	[IDArtikal]			Long Integer NOT NULL, 
	[UTKolicina]			Double NOT NULL, 
	[IDDobavljac]			Long Integer NOT NULL, 
	[ISKolicina]			Long Integer NOT NULL, 
	[UTKol1]			Currency NOT NULL, 
	[UTKol2]			Currency NOT NULL, 
	[UTKol3]			Currency NOT NULL
);

CREATE TABLE [V_Dokumenta]
 (
	[IDDok]			Long Integer, 
	[IDDokRobno]			Long Integer NOT NULL, 
	[IDKomitent]			Long Integer, 
	[IDMestoIsporuke]			Long Integer, 
	[IDProdavac]			Long Integer, 
	[IDMagacin]			Long Integer NOT NULL, 
	[IDDokVeza]			Long Integer NOT NULL, 
	[IDRadniNalog]			Long Integer NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[BrojNaloga]			Text (20) NOT NULL, 
	[VrstaNaloga]			Text (5) NOT NULL, 
	[BrojDokumenta]			Text (20) NOT NULL, 
	[VrstaDokumenta]			Text (5) NOT NULL, 
	[DatumDokumenta]			DateTime NOT NULL, 
	[DatumKnjizenja]			DateTime, 
	[DatumValute]			DateTime, 
	[Opis]			Text (30), 
	[NacinOtpreme]			Text (30), 
	[Fco]			Text (30), 
	[MestoPrometa]			Text (20), 
	[DatumPrometa]			DateTime, 
	[NacinPlacanja]			Text (50), 
	[Memo]			Memo/Hyperlink (255), 
	[Kurs]			Double NOT NULL, 
	[Carina]			Double NOT NULL, 
	[Spedicija]			Double NOT NULL, 
	[OstaliZavTros]			Double NOT NULL, 
	[DevVredFak]			Double NOT NULL, 
	[DevValuta]			Text (3) NOT NULL, 
	[Level]			Byte NOT NULL, 
	[Zakljucano]			Boolean NOT NULL, 
	[OJ]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL
);

CREATE TABLE [VrstePlacanja]
 (
	[IDVrstaPlacanja]			Long Integer NOT NULL, 
	[OpisVrstePlacanje]			Text (20) NOT NULL
);

CREATE TABLE [ZahteviZaPonude]
 (
	[IDFirma]			Long Integer NOT NULL, 
	[IDZahteviPonude]			Long Integer, 
	[Opis]			Text (50), 
	[DatumZahteva]			DateTime NOT NULL, 
	[RokZaPonudu]			DateTime, 
	[IDKomitent]			Long Integer NOT NULL, 
	[IDPredmet]			Long Integer NOT NULL, 
	[PorekloZahteva]			Text (20) NOT NULL, 
	[Napomena]			Text (250), 
	[OJ]			Long Integer NOT NULL, 
	[IDProdavac]			Long Integer NOT NULL, 
	[OD]			Long Integer NOT NULL, 
	[Godina]			Long Integer NOT NULL, 
	[IDDokProf]			Long Integer NOT NULL, 
	[IDDokUSL]			Long Integer NOT NULL, 
	[IDStatus]			Long Integer NOT NULL, 
	[Potpis]			Text (50), 
	[DatumIVreme]			DateTime
);

CREATE TABLE [ZaSHUTTLE_Status]
 (
	[ID]			Long Integer, 
	[Komitenti]			Boolean NOT NULL, 
	[RobnaDokumenta]			Boolean NOT NULL, 
	[RobneStavke]			Boolean NOT NULL, 
	[Nalozi]			Boolean NOT NULL, 
	[GlavnaKnjiga]			Boolean NOT NULL, 
	[ProdavciZaGK]			Boolean NOT NULL, 
	[MPDokumenta]			Boolean NOT NULL, 
	[MPStavke]			Boolean NOT NULL, 
	[DatumIVreme]			DateTime
);



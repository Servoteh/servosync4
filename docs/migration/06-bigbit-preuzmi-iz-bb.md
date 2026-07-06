# „Preuzmi iz BB" (PreuzmiIzBB) — legacy mehanizam i mapiranje za `bigbit-sync`

> Izvor: read-only analiza legacy VBA izvoza (`_analiza/izvoz/Izvoz/VBA`), 2026-07-07. Ovo je **referenca
> za budući NestJS `bigbit-sync` modul** — tačno šta legacy „Preuzmi iz BB" dugme radi, po tabeli i koloni.
> Dopunjuje [ServoSync-specification.md](../ServoSync-specification.md) (koji je na nivou tabela) i
> [MODULE_SPEC_bigbit_sync.md](../design/MODULE_SPEC_bigbit_sync.md). Odluka o izvoru 2.0 (export vs live)
> je u [BACKEND_RULES §11.2](../BACKEND_RULES.md).

## 1. Lanac poziva i redosled

`RibbonModule.PreuzmiIzBigBitaRibbon` → `PreuzmiIzBB()`. Pet koraka, vezani `retValOk And …`,
**abort-on-fail** (prva greška prekida ostatak). Redosled je bitan zbog FK zavisnosti:

1. **Vrste šifara** — `UradiImportIzTabeleUTabelu("EXT_Vrste sifara", "Vrste sifara", …)` (direktan DAO `INSERT…SELECT`)
2. **Prodavci** — `DodajNoveProdavceIzBigBita`
3. **Komitenti** — `DodajNoveKomitenteIzBigBita`
4. **Predmeti** — `DodajNovePredmeteIzBigBita`
5. **R_Artikli** — `DodajNoveArtikleIzBigBita`

Svih 5 je **INSERT-only (anti-join `WHERE cilj.kljuc IS NULL`)** — postojeći redovi se **nikad ne ažuriraju**.
Koraci 2–5 idu kroz `ExportujTabeluUSQL`: otvore anti-join SELECT nad EXT_ (Access link), pa red-po-red
`INSERT` preko ADO na SQL Server. **Realni INSERT = presek SELECT liste sa kolonama koje postoje u cilju**
(`ADO_PostojiKolonaUTabeli`); tekst se seče na dužinu ciljne kolone, apostrof `'` → razmak, datumi formatirani.

## 2. Mapiranje po tabeli (izvor → cilj, ključ, kolone, transformacije)

### 2.1 Vrste šifara — `EXT_Vrste sifara` → `Vrste sifara`
- Ključ (anti-join): `[Vrsta sifre]`
- Kolone: `[Vrsta sifre]`, `Opis`
- Transformacija: nema

### 2.2 Prodavci — `EXT_Prodavci` → `Prodavci`
- Ključ: `[Sifra prodavca]`
- Kolone: `[Sifra prodavca]`, `Prodavac`, `Region`, `ProcenatZaObracun`, `DeljivoUGrupi`, `ImeProdavca`,
  `BrLkProdavca`, `LogAcc`, `Password`, `Aktivan`, `NefiskalniRN`, `Storniranje`, `PotpisSlika`,
  `OznakaTima`, `Telefon`, `Email`
- **Transformacija:** `Password` NULL → `Password = [Sifra prodavca]` (default password = šifra prodavca)

### 2.3 Komitenti — `EXT_Komitenti` → `Komitenti`
- Ključ: `Sifra`
- Kolone: `Sifra`, `Naziv`, `Poslovnica`, `Mesto`, `Adresa`, `[Postanski broj]`, `[Ziro racun_1]`,
  `[Ziro racun_2]`, `[Ziro racun_3]`, `Telefon`, `Fax`, `Kontakt`, `Napomena`, `Drzava`, `Region`,
  `[Vrsta sifre]`, `Email`, `Mobilni`, `[Datum rodjenja]`, `[Web adresa]`, `[Sifra prodavca]`,
  `RabatKomitenta`, `ZastKodKupca`, `PIB`, `PDVStatus`
- **Transformacije (2):**
  - `[Sifra prodavca] = 0` (hard-kodirano, ne uzima se iz BB)
  - PIB placeholder: PIB prazan → `PIB = "XX_" & Sifra`

### 2.4 Predmeti — `EXT_Predmeti` → `Predmeti`  (čuva BB ključ, IDENTITY_INSERT)
- Ključ: `IDPredmet` (prenosi se 1:1)
- Kolone: `IDPredmet`, `BrojPredmeta`, `Opis`, `DatumOtvaranja`, `IDProdavac`, `IDKomitent`, `NextAction`,
  `DatumZakljucenja`, `Memo`, `Status`, `NasaRef`, `NasKontakt1`, `NasKontakt2`, `NasTel1`, `NasTel2`,
  `VasaRef`, `VasKontakt1`, `VasKontakt2`, `VasTel1`, `VasTel2`, `NabavnaVrednost`, `Carina`, `Spedicija`,
  `Prevoz`, `Ostalo`, `InoDobavljac`, `RJ`, `DevValuta`, `Kurs`, `NazivPredmeta`, `BrojUgovora`,
  `DatumUgovora`, `BrojNarudzbenice`, `DatumNarudzbenice`
- Transformacija: nema

### 2.5 R_Artikli — `EXT_R_Artikli` → `R_Artikli`  (bez IDENTITY_INSERT; cilj auto-generiše `IDArtikal`)
- **Ključ (kritično):** BB `[Sifra artikla]` → ciljna kolona **`[BBSifra artikla]`** (ne primarni `IDArtikal`).
  Anti-join: `LEFT JOIN R_Artikli ON EXT_R_Artikli.[Sifra artikla] = R_Artikli.[BBSifra artikla] WHERE … IS NULL`
- Kolone (SELECT lista): `[Sifra artikla] AS [BBSifra artikla]`, `[Kataloski broj]`, `BarKod`, `PLU`,
  `ExtSifra`, `Naziv`, `[Jedinica mere]`, `Pakovanje`, `InoJm`, `Kutija`, `[Transportno pakovanje]`,
  `Poreklo`, `Grupa`, `Podgrupa`, `[Tarifa robe]`, `[Tarifa usluga]`, `[Uvek porez na robu]`,
  `[Uvek porez na usluge]`, `[VP cena]`, `[MP cena]`, `NabDevCena`, `ProdDevCena`, `[Minimalna kolicina]`,
  `ArtTaksa`, `Odlozeno`, `[Neoporezivi deo]`, `MaxRabatProc`, `Memo`, `KngSifra`, `ArtAkciza`, `KngSifra_2`,
  `ZavTrosProiz`, `CarStopa`, `IDRaster`, `CarTarifa`, `ZemljaPorekla`, `Polica`, `INONaziv`, `SifDob`,
  `WebOpis`, `OpisArtikla`, `Tezina`, `PDFLink`, `ZaBrisanje`, `Aktivan`, `CenaZaUpisUCen`,
  `IDMestoIzdavanja`, `Proizvodjac`, `HPS`, `PotpisArt`, `DatumIVremeArt`, `KolUPak`, `KLRucProc`, `OsnJM`,
  `SlikaSimbolaLink`, `MPKaloProc`, `WordLokacija`, `VPKaloProc`, `NeVodiZalihe`, `TezinaKg`, `Zapremina`,
  `Povrsina`, `RSort`, `AkcijskiRabat`, `Napomena2`, `IDKvalitetArtikla`, `Debljina`

### Tabele koje NISU u dugmetu (važna korekcija)
`R_Tarife`, `R_Grupa`, `R_Podgrupa`, `Magacini` **nemaju** `DodajNove…IzBigBita` proceduru — ne stižu kroz
„Preuzmi iz BB". Rešavaju se **data-driven** kroz formu `PS_TabeleZaImportIzPG` + config tabelu
`EXT_Import_DEF` (definicije `ImeIzTabele/ImeUTabelu/SQLTexImport` su **redovi u Access bazi, ne u kodu**).
→ Za `bigbit-sync` te definicije treba pročitati iz `.accdb/.mdb` (`EXT_Import_DEF`), nisu u VBA fajlovima.

## 3. Mirror: T_Robna dokumenta / T_Robne stavke (`modSyncMirrorTabele.bas`)

`SyncMirrorZaKatBroj(KatBroj, SessionID)` — po kataloškom broju i sesiji: **DELETE ceo skup pa reinsert**
(nije UPSERT po redu). Izvor su `EXT_T_Robna dokumenta` / `EXT_T_Robne stavke` (link na BigBit lager
`BB_T_25.MDB`), cilj SQL tabele `RobnaDokumentaMirror` / `RobneStavkeMirror`.
- Transformacija količine: `Kolicina > 0 → KolicinaUlaz`; `< 0 → KolicinaIzlaz = Abs(...)`; `PoslednjaIzmena = GETDATE()`.
- Koristi se samo za PDM/MRP potrebe (rezervacije/zalihe po kataloškom broju), ne za ceo lager.

## 4. Kako se legacy kačio na BigBit (za odluku o izvoru 2.0)

Dva smera:
- **Izvor (EXT_*):** fizički **Access-linkovane tabele** sa prefiksom `EXT_`, connect string oblika
  `;DATABASE=<putanja>\BB_T_25.MDB` (ponegde ODBC). Putanje/stringovi su u config tabelama
  `BazeIFirme(FirmaZaBaze, TipBaze, IDBaze, Baza)` i `BazeITabele(Name, IDBaze, SourceTableName)` u samoj
  Access bazi (`LinkovaneTabele.bas`, `BBFIT.bas`) — **ne u kodu**.
- **Cilj (upis):** SQL Server `QBigTehn` (`CNN_CurrentDataBase` / `F_CNNString("SQL")`).

Dakle legacy je **Access-frontend kao posrednik** između BigBit Access lagera i QBigTehn SQL Server-a.
Potvrđuje analizu iz §11.2: kad QBigTehn nestane, ServoSync mora sam do BigBit-a — a BigBit izvor je
**Access `.MDB`**, ne SQL Server. To ide u prilog preporuci **export (XML/CSV) + UPSERT** umesto živog ODBC-a.

## 5. PDM XML (relevantno za Sync C)

- **`PDMXMLParser.bas`** (schema-aware): `ImportXMLWithReferences` → iterira `//transaction`, za svaki
  `document` puni tabelu `PDM_Document`. Tagovi: `transaction/@date` (Unix epoch → datum), `document/@id`,
  `@pdmweid`, `configuration/attribute/@name+@value` (→ kolone `Attr_<name>`), **rekurzija** kroz
  `references/document` (parent-child = BOM/sklop hijerarhija). `Revision` prazan → `"A"`.
- **`BigBitXML.bas`** (sirovi staging): parsira bilo koji BB XML u generičku `xml_Imported`
  (`imeTabele, BrojSloga, ImePolja, VrednostPolja`) — bez mapiranja na poslovne tabele.
- Za 2.0 Sync C: `PDMXMLParser` je model — XML iz SolidWorks-a nosi `document` + `references` (BOM), što se
  mapira na `drawings` + `drawing_components`/`drawing_assemblies`. Potvrđuje „XML kao ugovor" pravac (§11.3).

## 6. Za implementaciju `bigbit-sync` (sažetak)

1. **5 tabela** u glavnom toku (Vrste šifara, Prodavci, Komitenti, Predmeti, R_Artikli), redosled zbog FK.
2. Legacy je **INSERT-only** — 2.0 menja u **UPSERT po prirodnom ključu** (`Vrsta sifre`, `Sifra prodavca`,
   `Sifra`, `IDPredmet`, `BBSifra artikla`). Time nestaju „nema update / nema delete" bagovi.
3. Preneti **3 hard-kodirane transformacije**: PIB `XX_<Sifra>`, komitent `[Sifra prodavca]=0`,
   prodavac `Password = Sifra` kad je NULL. (Razmotriti da li ih uopšte zadržati — v2 prilika da se PIB
   drift i šifra=0 poprave umesto da se ponove.)
4. **Mapiranje ključa artikla** `Sifra artikla (BB) → BBSifra artikla (cilj)` je obavezno (cilj ima svoj `IDArtikal`).
5. `R_Tarife/R_Grupa/R_Podgrupa/Magacini` → pročitati `EXT_Import_DEF` iz Access baze (definicije nisu u kodu).

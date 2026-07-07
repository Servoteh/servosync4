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

---

## 7. Verifikacija iz čistog VBA izvora (QBigTehn_APL, 2026-07-08)

> Osnov: direktno čitanje VBA modula (`ImportIzBB_Module.bas`, `BBSQLModule.bas`, `modSyncMirrorTabele.bas`,
> `EXT_Import.bas`, `LinkovaneTabele.bas`, `ADO_Module.bas`), ne string-mining. Zaključak: §1–§4 su **uglavnom
> tačni**; sve razlike su niže. Najveće korekcije su u **mehanizmu upisa** (§7.2) i **mirror-u** (§7.4).

### 7.1 Kolone i transformacije po tabeli — status vs §2

| Tabela | Anti-join ključ | Kolone | Transformacije | Status |
|---|---|---|---|---|
| Vrste šifara (2.1) | `[Vrsta sifre]` | `[Vrsta sifre]`, `Opis` | nema | **POTVRĐENO** — ali NE ide kroz `ExportujTabeluUSQL`, već `UradiImportIzTabeleUTabelu` (direktan DAO `INSERT…SELECT`, Access→Access) |
| Prodavci (2.2) | `[Sifra prodavca]` | 16 kolona kako doc navodi | `Password = IIf(IsNull([Password]),[Sifra prodavca],[Password])` | **POTVRĐENO** — preciznije: okida samo na `IsNull`, ne na prazan string |
| Komitenti (2.3) | `Sifra` `LEFT JOIN Komitenti WHERE Komitenti.Sifra Is Null` | kako doc (uklj. `[Ziro racun_1..3]`, `[Vrsta sifre]`) | (a) `[Sifra prodavca]` hard-kod `0 AS [Sifra prodavca]`; (b) `PIB = IIf(Nz([PIB],"")="","XX_" & [Sifra],[PIB])` | **POTVRĐENO EGZAKTNO** — PIB placeholder pokriva i NULL i prazan string (`Nz`) |
| Predmeti (2.4) | `IDPredmet` (1:1) | 34 kolone kako doc | nema | **POTVRĐENO** — `IDENTITY_INSERT ON` auto-detektovan (v. §7.2) |
| R_Artikli (2.5) | BB `[Sifra artikla]` → cilj `[BBSifra artikla]` | ~70 kolona, `[Sifra artikla] AS [BBSifra artikla]` | nema (mapiranje ključa) | **POTVRĐENO** — poziva `ExportujTabeluUSQLBezIdentityKolone`; cilj sam generiše `IDArtikal` |

### 7.2 Mehanizam upisa `ExportujTabeluUSQL` — DOPUNA §1 (`BBSQLModule.bas:497`)

Doc §1 je opisao motor približno tačno; egzaktni detalji i zamke:

- **Presek kolona:** za svako polje izvora `ADO_PostojiKolonaUTabeli(F_CNNString("SQL"), UTabelu, ImePolja)`; zadržavaju se samo kolone koje postoje u cilju. `Size` i `Type` se uzimaju sa **ciljne** kolone.
- **Tekst se seče na dužinu CILJNE kolone:** `Left(Vrednost, SizeKoloneZaExport(i))` (za `dbText`).
- **Datum:** `SQLFormatDatumIVreme(Vrednost, False)`.
- **Apostrof (potvrda + zamka):** `Replace(Vrednost, "'", " ")` — apostrof se zamenjuje **RAZMAKOM, ne dublira** (`D'Or` → `D Or`, gubitak podatka). Doc §1 je ovo naveo tačno. **RAZLIKA:** mirror (§7.4) koristi drugačiju logiku (`' → ''`).
- Sve vrednosti idu kao **stringovi u jednostrukim navodnicima**, red-po-red pojedinačnim `pCNN.Execute`.
- **`IDENTITY_INSERT` je DINAMIČKI:** `ADO_IsIdentity(F_CNNString("SQL"), UTabelu)` → `SET IDENTITY_INSERT ON` na početku / `OFF` na kraju. Predmeti (identity `IDPredmet`) ⇒ `ON` (čuva BB ključ). R_Artikli ide `…BezIdentityKolone` gde je `IDENTITY_INSERT` **zakomentarisan** ⇒ nikad se ne pali.
- **Nema transakcije/rollback:** broji `Ispravno`/`NEIspravno`, **delimičan uspeh je moguć** (pola tabele ubačeno pa greška).

### 7.3 Connection stringovi — DOPUNA/KOREKCIJA §4

- `F_CNNString(TypeCNN)` (`ADO_Module.bas:41`): bazni string = `LIB_CFGRW.CNN_CurrentDataBase` — **config-driven, NIJE hard-kodiran u kodu**. `TypeCNN="SQL"` skida `ODBC;` prefiks (čist string za ADO); `TypeCNN="ODBC"` garantuje `ODBC;` prefiks (za DAO linkove). **Cilj svih `Dodaj*` = QBigTehn SQL Server** preko `F_CNNString("SQL")`. `ImportPodToSQL` / `fsSifraArtiklaZaKatBarNaz` koriste `BBCFG.CNNString` / `CNN_CurrentDataBase` (isti SQL Server).
- **Izvor (EXT_):** fizičke Access-linkovane tabele; `Connect = ";DATABASE=<putanja>\BB_T_25.MDB"` (Access) ili `"ODBC;…"`. `ForsirajNoveLinkoveZaIDBaze(IDBaze, CNNString)` prepisuje `tdf.Connect`.
- **KOREKCIJA §4 (registar tabela):** doc navodi `BazeIFirme(FirmaZaBaze, TipBaze, IDBaze, Baza)`; u ovom izvozu stvarne config tabele su **`Baze` + `Baze_Tipovi`(`TipBaze→IDBaze`) + `BazeITabele`**(`Name, SourceTableName, IDBaze, CheckLink, CurrentSourceDataBase, SysFitLevel`), čitane preko `F_Baze_SQL(TipBaze)`. Putanje **nisu u VBA** — moraju se pročitati iz Access baze.
- **NOVO (multi-firma):** postoji dimenzija `F_FirmaZaBaze()`/`SysFITFirma` i filter `SysFitLevel <= F_SysFitLevel` na `BazeITabele` — **koje se tabele uopšte linkuju zavisi od firme i FIT nivoa**. String-mining ovo nije uhvatio.

### 7.4 Mirror `SyncMirrorZaKatBroj` — KOREKCIJA §3 (`modSyncMirrorTabele.bas`)

§3 je pojednostavljen; egzaktan kod pokazuje finiji, per-sesija model:

- **DELETE NIJE „ceo skup"** — scoped je po **`SessionID` I `KataloskiBroj`**: `DELETE FROM RobneStavkeMirror WHERE SessionID='..' AND KataloskiBroj=N'..'`. ⇒ **Mirror tabele imaju kolonu `SessionID`** koju šema iz doc-a ne navodi.
- **Izvor spaja TRI EXT tabele** (doc navodi dve): `[EXT_T_Robne stavke] RS INNER JOIN EXT_R_Artikli RA ON RS.[Sifra artikla]=RA.[Sifra artikla] INNER JOIN [EXT_T_Robna dokumenta] D ON RS.IDDok=D.IDDok WHERE RA.[Kataloski broj]='..'`. `EXT_R_Artikli` služi za prevod **`Sifra artikla` → `Kataloski broj`**.
- **Ciljne šeme (za implementaciju):**
  - `RobnaDokumentaMirror(SessionID, IDDok, VrstaDokumenta, DatumDokumenta)` — uz `IF NOT EXISTS(… WHERE SessionID AND IDDok)` dedup.
  - `RobneStavkeMirror(SessionID, IDStavke, IDDok, SifraArtikla, KataloskiBroj, IDMagacin, KolicinaUlaz, KolicinaIzlaz, PoslednjaIzmena)`.
- **Količina (potvrda §3):** `Kolicina>0 → KolicinaUlaz`; `<0 → KolicinaIzlaz=Abs(...)`; `PoslednjaIzmena=GETDATE()`. `SifraArtikla` upisan kao `CLng` (numerički).
- **Escaping:** `SqlEscape` dublira apostrof (`' → ''`), `SqlDec` menja decimalni zarez u tačku; koriste se `N'..'` unicode literali. **Zamka:** ceo blok je u `BeginTrans/CommitTrans` **DAO workspace** transakcije oko **ADO** `Execute` — ne štiti stvarne ADO pozive. `dbExt=CurrentDb` (čita preko app-ovih EXT_ linkova).

### 7.5 `EXT_Import_DEF` i tri putanje importa — DOPUNA §2 note

Potvrda da `R_Tarife/R_Grupa/R_Podgrupa/Magacini` NE idu kroz dugme. `ImportIzEXTTabele(ImeIzTabele, ImeUTabelu)` čita `SQLTextImport` i `SQLTextPostImport` iz Access tabele **`EXT_Import_DEF`** preko `DLookup` po (`[ImeIzTabele]` AND `[ImeUTabelu]`). Kolone: `ImeIzTabele, ImeUTabelu, SQLTextImport, SQLTextPostImport` — **redovi u `.accdb/.mdb`, ne u VBA**. Tri distinktna mehanizma importa u kodu:

| Putanja | Smer | Kako | Identity |
|---|---|---|---|
| `UradiImportIzTabeleUTabelu` | Access→Access | direktan DAO `INSERT…SELECT` | — (Vrste šifara ide ovuda) |
| `UradiImportIzTabeleUSQLTabelu` + `ImportPodToSQL` | Access→SQL | row-by-row ADO | `SET IDENTITY_INSERT` ako `IsAutoNumber(cilj)` |
| `ExportujTabeluUSQL(BezIdentityKolone)` | Access→SQL | glavni tok „Dodaj*" (§7.2) | dinamički / isključen |

### 7.6 Za implementaciju `bigbit-sync` — zaključak

1. **Kolone/transformacije iz §2 su verifikovane** — mogu direktno u Prisma mapping. Zadržati kao svesnu odluku (ili popraviti): `[Sifra prodavca]=0`, `PIB="XX_"&Sifra`, a **`Password=[Sifra prodavca]` NE prenositi** (security).
2. **Zameniti `ExportujTabeluUSQL` UPSERT servisom u JEDNOJ transakciji.** Legacy nema rollback (delimičan uspeh) i INSERT-only je (promene u BB se ne propagiraju). Presek kolona i sečenje teksta na dužinu cilja postaju eksplicitan Prisma DTO/validacija; **apostrof-→razmak NE reprodukovati** (koristiti pravu parametrizaciju).
3. **Mirror u 2.0 mora imati `SessionID` (scope ključ) i tri-tabelni izvor** (`Robne stavke` × `R_Artikli` × `Robna dokumenta`). Preslikati kao staging tabelu sa `session/request` scope-om ili materijalizovan view; količinski split i dedup dokumenta zadržati.
4. **Izvor konfiguracija (`Baze/Baze_Tipovi/BazeITabele`, `EXT_Import_DEF`) pročitati iz Access baze**, uz **multi-firma + `SysFitLevel` filter** — connection registry u 2.0 mora nositi dimenzije firma/tip-baze/FIT. Cilj upisa je uvek `CNN_CurrentDataBase` (config-driven, ne hard-kod).
5. **R_Artikli:** obavezno mapiranje `Sifra artikla (BB) → BBSifra artikla (cilj)`; cilj generiše svoj `IDArtikal`. **Predmeti:** čuvati `IDPredmet` 1:1 (legacy pali `IDENTITY_INSERT`, u 2.0 to je prirodni ključ za UPSERT).
# BigBit — Artikli (matični podatak robe/usluga): polja, unos, slike, prevodi, tok podataka

**Datum analize:** 27.07.2026
**Status:** činjenična rekonstrukcija iz DDL-a i VBA koda dostupnog lokalno (bez SSH na ubuntusrv/mdbtools
u ovoj sesiji). Svaka tvrdnja ima izvor (fajl + linija/funkcija). Gde nema dokaza — piše `NEPOZNATO`.
Nadovezuje se na [BB_T_26-analiza-klaster-A-maticni-tehnologija-reversi.md](BB_T_26-analiza-klaster-A-maticni-tehnologija-reversi.md)
i [BB_T_26-analiza-F1-pokrivenost-polja.md](BB_T_26-analiza-F1-pokrivenost-polja.md) — ovaj dokument ide
dublje samo na artikal (polja, unos, slike/prevodi, tačan mehanizam prenosa), ne ponavlja ceo klaster.

---

## 0. Izvori

| Izvor | Šta je |
|---|---|
| `backend/docs/migration/BB_T_26_schema.sql` (linije 930–1029) | **originalni BigBit DDL** (mdbtools izvoz `BB_T_26.MDB`, snapshot 11.07.2026) — `R_Artikli`, `R_Artikli_BarKod`, `R_Artikli_Ino`, `R_Grupa` |
| `_legacy/_analiza/qbigtehn_sqlserver.sql` (linije 6498–6617, 21877+) | **QBigTehn kopija** (SQL Server, `vasa-SQL`) — `CREATE TABLE [dbo].[R_Artikli]` + `MS_Description` komentari kolona |
| `_legacy/QBigTehn_APL/modules/ImportIzBB_Module.bas` (f-ja `DodajNoveArtikleIzBigBita`) | **tačan mehanizam prenosa** BigBit → QBigTehn (VBA, SELECT/INSERT) |
| `_legacy/QBigTehn_APL/tables.txt` | popis linked tabela (`EXT_R_Artikli` → `BB_T_26.MDB`; `R_Artikli` → SQL Server) |
| `_legacy/Izvoz/Moduli_Tekst/BiranjeArtikla.txt` | VBA modul: picker artikla, kartica, kloniranje po modelu, barkod lookup |
| `_legacy/Izvoz/Forme/Grupe artikala.txt` + `_legacy/QBigTehn_APL/forms/Form_Grupe artikala.cls` | forma šifarnika grupa |
| `_legacy/BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/Doc__Form_Unos artikala.txt` + `Doc__Form_ArtikliSlike.txt` | **kod-behind PRAVE BigBit forme za unos artikla** (nađeno 27.07 posle prve verzije ovog doc-a — izvor za §3.3 i §4.8–4.10) |
| `backend/prisma/schema.prisma` (linije 787–888, 3448–3458) | trenutni model `Item`/`ItemGroup`/`ItemSubgroup`/`ItemOrigin`/`ItemValuation` |
| `backend/src/modules/sync/sync-map.generated.ts` (linija ~1701) | generic syncer mapiranje `R_Artikli` → `Item` |
| `backend/src/modules/robno/*`, `backend/src/modules/nabavka/*`, `backend/src/modules/sales/*` | potrošači `items` tabele u 2.0/3.0 |

**Metod:** statička DDL analiza (bez live upita na produkciju u ovoj sesiji) + čitanje VBA izvoznih fajlova
koji su već lokalno raspakovani u `_legacy/`. Brojevi redova (91.199 R_Artikli, 82.855 Cenovnik) preuzeti iz
F1 analize (već izmereni ranije, nisu ponovo mereni ovde).

---

## 1. R_Artikli — glavna tabela artikla (67 kolona)

**PK:** `Sifra artikla` (Long Integer / IDENTITY). **U originalnom BigBit-u ovo JE prava BigBit šifra.**
U QBigTehn kopiji ovo je **lokalni IDENTITY kopije** — originalna BigBit šifra se čuva odvojeno u
`BBSifra artikla` (kolona koja postoji SAMO u kopiji, ne u originalu). Ovo je najveći strukturni rizik
za 4.0 (v. §5).

Puna lista (izvor: `BB_T_26_schema.sql:930-998`, original; nullability iz originala — QBigTehn kopija
relaksira većinu `NOT NULL` u `NULL`, v. F1 §Šema-drift):

| Kolona (BigBit) | Tip | NOT NULL u originalu? | Trenutno polje u `Item` | Grupa |
|---|---|---|---|---|
| Sifra artikla | Long Integer | PK | `id` | identitet |
| Kataloski broj | Text(20) | DA | `catalogNumber` | identitet — glavni ljudski ključ za tehnologiju |
| BarKod | Text(20) | ne | `barCode` | identitet (samo JEDAN — v. §3.1 za multi-barkod) |
| PLU | Long Integer | DA | `plu` | POS (MP kasa) |
| ExtSifra | Text(20) | ne | `externalCode` | eksterna šifra (dobavljača/proizvođača?) |
| Naziv | Text(50) | DA | `name` | osnovni naziv (srpski) |
| Jedinica mere | Text(5) | ne | `unit` | |
| Pakovanje | Text(10) | ne | `packaging` | |
| InoJm | Text(5) | ne | `foreignUnit` | jedinica mere na stranom jeziku (uz INONaziv) |
| Kutija | Double | ne | `box` | kom/kutija za pakovanje |
| Transportno pakovanje | Double | ne | `transportPackaging` | |
| Poreklo | Text(5) | DA | `originCode` | FK → `R_Poreklo` |
| Grupa | Text(10) | DA | `groupCode` | FK → `R_Grupa` |
| Podgrupa | Text(10) | DA | `subgroupCode` | FK → `R_Podgrupa` |
| Tarifa robe | Text(5) | DA | `goodsTaxRateCode` | FK → `R_Tarife` (PDV kad je roba) |
| Tarifa usluga | Text(5) | DA | `serviceTaxRateCode` | FK → `R_Tarife` (PDV kad je usluga) |
| Uvek porez na robu | Boolean | DA | `alwaysTaxGoods` | |
| Uvek porez na usluge | Boolean | DA | `alwaysTaxServices` | |
| VP cena | Double | ne | `wholesalePrice` | komercijala |
| MP cena | Double | ne | `retailPrice` | maloprodaja (POS, van scope Servoteh) |
| NabDevCena | Double | ne | `fxPurchasePrice` | devizna nabavna cena |
| ProdDevCena | Double | ne | `fxSalePrice` | devizna prodajna cena |
| Minimalna kolicina | Double | ne | `minQuantity` | min. zaliha (nabavka/MRP) |
| ArtTaksa | Double | ne | `itemFee` | taksa (ekološka i sl.) |
| Odlozeno | Integer | DA | `paymentTermDays` | valuta plaćanja u danima, specifična za artikal |
| Neoporezivi deo | Double | DA | `nonTaxablePart` | |
| MaxRabatProc | Double | DA | `maxDiscountPercent` | maksimalan dozvoljen rabat na prodaji |
| Memo | Memo/Hyperlink(255) | ne | `memo` | slobodan tekst — interna napomena |
| KngSifra | Text(10) | DA | `accountingCode` | GK konto (analitika artikla) |
| ArtAkciza | Double | DA | `itemExcise` | akciza |
| KngSifra_2 | Text(10) | ne | `accountingCode2` | drugi GK konto (zamena/alternativa — v. `UpisiKNG2SifruUArtikal` u §4) |
| ZavTrosProiz | Double | DA | `finalProcessingCost` | zavisni trošak proizvodnje (kalkulacija) |
| CarStopa | Double | DA | `customsRate` | carinska stopa |
| IDRaster | Long Integer | DA | `rasterId` | ⚠ **za Servoteh NIJE POS/tekstil koncept** — koristi se za DIMENZIJE lima/ploče (v. §4.10: obračun kg/komadu preko gustine čelika); ranija klasifikacija „van scope" (klaster B §5) važi za maloprodajnu upotrebu rastera, ne za ovu |
| CarTarifa | Text(20) | ne | `customsTariff` | carinski tarifni broj |
| ZemljaPorekla | Text(20) | ne | `originCountry` | |
| Polica | Text(20) | ne | `shelf` | ⚠ QBigTehn kopija suzila na `nvarchar(10)` — rizik truncation-a pri direktnom BigBit sync-u (v. F1) |
| INONaziv | Text(50) | ne | `foreignName` | naziv na (jednom) stranom jeziku — v. §3.2 za PRAVI multi-language |
| SifDob | Long Integer | DA | `supplierId` | FK → Komitenti (podrazumevani/glavni dobavljač) |
| WebOpis | Text(255) | ne | `webDescription` | duži opis za web/katalog |
| OpisArtikla | Text(50) | ne | `itemDescription` | kratak opis (odvojen od `Naziv`) |
| Tezina | Double | DA | `weight` | |
| PDFLink | Text(255) | ne | `pdfLink` | v. §3.3 — LINK, ne BLOB |
| ZaBrisanje | Boolean | DA | `toDelete` | meko brisanje (flag, ne DELETE) |
| Aktivan | Boolean | DA | `active` | |
| CenaZaUpisUCen | Double | DA | `priceToWritePricelist` | |
| IDMestoIzdavanja | Long Integer | DA | `issuePlaceId` | FK → `MestaIzdavanja` |
| Proizvodjac | Text(50) | ne | `manufacturer` | |
| HPS | Text(50) | DA (CHECK: H/P/S/O) | `hps` | kod tipa artikla (Hrana/Piće/Servis/Ostalo?) — CHECK constraint u QBigTehn kopiji: `'H' OR 'P' OR 'S' OR 'O'` |
| PotpisArt | Text(50) | ne | `signature` | ko je poslednji potpisao/uneo izmenu |
| DatumIVremeArt | DateTime | ne | `createdAt` | jedini datum na artiklu — nema odvojeno `updatedAt` |
| KolUPak | Double | DA | `quantityInPackage` | |
| KLRucProc | Currency | DA | `manualMarkupPercent` | ručna kalkulativna marža |
| OsnJM | Text(5) | ne | `baseUnit` | osnovna JM (za konverziju iz pakovanja) |
| SlikaSimbolaLink | Text(250) | ne | `symbolImageLink` | v. §3.3 — LINK na fajl, ne BLOB |
| MPKaloProc | Double | DA | `retailLossPercent` | kalo (rastur) na MP |
| WordLokacija | Text(250) | ne | `wordLocation` | v. §3.3 |
| VPKaloProc | Double | DA | `wholesaleLossPercent` | kalo na VP |
| NeVodiZalihe | Boolean | DA | `notStockTracked` | artikal se ne prati po zalihama (npr. usluga) |
| TezinaKg | Double | DA | `weightKg` | (odvojeno od `Tezina` — verovatno drugačija JM) |
| Zapremina | Double | DA | `volume` | |
| Povrsina | Double | DA | `area` | |
| RSort | Long Integer | DA | `sortOrder` | ručni redosled prikaza |
| AkcijskiRabat | Double | DA | `promotionDiscount` | |
| Napomena2 | Text(255) | ne | `note2` | druga napomena (uz `Memo`) |
| IDKvalitetArtikla | Long Integer | DA | `qualityTypeId` | FK → `R_KvalitetArtikla` (ne postoji ni u kopiji ni u 2.0 — v. §2) |
| Debljina | Double | DA | `thickness` | debljina (lim/ploča — Servoteh specifično) |
| — (`BBSifra artikla`, samo u kopiji) | int NOT NULL | — | `externalItemId` | **jedini most nazad ka originalnoj BigBit šifri** |

CHECK constraint-i uočeni u QBigTehn kopiji (`qbigtehn_sqlserver.sql:8420-8444`, verovatno postoje i u
originalu jer su poslovna pravila): `ArtTaksa IS NOT NULL`, `HPS IN ('H','P','S','O')`, `Kutija >= 0`,
`MPKaloProc >= 0`, `Naziv IS NOT NULL`, `Tezina >= 0`, `[Transportno pakovanje] >= 0`.

---

## 2. Šifarnici i prateće tabele

### 2.1 Grupa/Podgrupa/Poreklo/Kvalitet (klasifikacija)

| Tabela | Kolone | Svrha | Sinkuje se u 2.0/3.0? |
|---|---|---|---|
| `R_Grupa` | `Grupa`(PK Text10), `Opis` | glavna grupa robe | **NE** (model `ItemGroup` postoji, prazan) |
| `R_Podgrupa` | `Podgrupa`(PK), `Opis`, `GrupaVeza` | podgrupa, FK na grupu | **NE** (`ItemSubgroup` prazan) |
| `R_Poreklo` | `Poreklo`(PK Text5), `Opis`, `PodgrupaVeza`, `PopustProc` | poreklo robe (uvoz/domaće?) **sa komercijalnim popustom po poreklu** | **NE** (`ItemOrigin` prazan) |
| `R_KvalitetArtikla` | `IDKvalitetArtikla`(PK), `KvalitetArtikal` Text(20), `Opis` Text(20) | klasa kvaliteta artikla | **NE POSTOJI ni model** — `Item.qualityTypeId` visi u prazno. Tabela nije ni u QBigTehn kopiji (F1) — za 4.0 mora direktno iz BigBit originala. |

Posledica danas: `Item.groupCode/subgroupCode/originCode/qualityTypeId` su ispravni kodovi (FK vrednosti
stižu), ali UI nema odakle da povuče naziv — treba tražiti šifru grupe/porekla napamet. Jeftin fix
(3 mala syncera + 1 novi model) je već preporučen u klaster A dokumentu §A.8.1.

### 2.2 Dobavljači i mesto izdavanja

- **`DobavljaciZaArtikal`** (`BB_T_26_schema.sql:243-250`): `ID`(PK), `IDArtikal`, `Sifra dobavljaca`,
  `Primarni`(bool), `VremeIsporuke`(Long — lead time u danima). Više dobavljača po artiklu, sa jednim
  označenim kao primarni. **Logika je već ušla u MRP** (`MrpDemandItem.supplierId` + lead time), ali
  sama tabela nije sinkovana — MRP danas koristi samo `Item.supplierId` (jedan dobavljač, `SifDob`), ne
  celu listu.
- **`MestaIzdavanja`** (`BB_T_26_schema.sql:541-545`): `IDMestoIzdavanja`(PK), `MestoIzdavanja` Text(50).
  Sitan šifarnik (mesto sa kog se artikal izdaje — verovatno magacin/rampa). Nije sinkovan; `Item.issuePlaceId`
  visi u prazno.

### 2.3 Cene, rabati, akcije

| Tabela | Kolone | Redova | Status u 2.0/3.0 |
|---|---|---:|---|
| `Cenovnik` | `ID`(PK), `Sifra artikla`, `Vrsta dokumenta`, `Cena`, `Tarifa`, `CenaBezPDV`, `CenaSaPDV`, `Taksa`, `Prn`, `ZakCen` | 82.855 | **SINKOVANO** → `PriceListEntry` (1:1, `Decimal`) |
| `Rabati` | `ID`, `Sifra`(komitent), `RabatProc`, `IDGrupa`, `ExtraRabatProc` | — | GAP — rabat po komitentu × grupi robe |
| `RabatiPoArt` | `ID`, `Sifra`(komitent), `RabatProc`, `IDArtikal`, `OdDatuma`, `DoDatuma`, `ExtraRabatProc` | — | GAP — rabat po komitentu × artiklu, vremenski ograničen |
| `Akcije` | `IDAkcija`(PK), `OpisAkcije`, `Aktivna`, `DatIVreme` | — | GAP |
| `AkcijeArtikli` | `IDAkcija`, `IDArtikal`, `RabatProc`, `DatIVreme` | — | GAP — akcijski rabat po artiklu |

---

## 3. Slike, prevodi, opisi — detaljno (glavni fokus zahteva)

### 3.1 Barkod — NIJE jedno polje u praksi

`Item.barCode` (jedno polje, `R_Artikli.BarKod`) je samo **primarni/podrazumevani** barkod. Postoji
zasebna tabela za **višestruke barkodove po artiklu**:

**`R_Artikli_BarKod`** (`BB_T_26_schema.sql:1001-1007`): `ID`(PK), `IDArtikal`(FK), `BarKod` Text(20)
NOT NULL, `MultiFaktor` Currency NOT NULL.

`MultiFaktor` = faktor pakovanja za taj konkretan barkod (npr. barkod na kutiji od 12 kom ima
`MultiFaktor = 12`, dok barkod na pojedinačnom komadu ima `MultiFaktor = 1`) — jedan artikal, više
skeniranih ambalaža, svaka sa svojim množiteljem količine.

**Potvrđeno u kodu da se OBA izvora pretražuju pri skeniranju** — `BiranjeArtikla.txt` funkcija
`F_IDArtikalZaBarKod`:

```vba
retVal = ADO_Lookup(..., "[Sifra artikla]", "R_Artikli", "[Barkod]='" & BarKod & "'")
If Nz(retVal, -1) = -1 Then
    retVal = ADO_Lookup(..., "[IDArtikal]", "R_Artikli_Barkod", "[Barkod]='" & BarKod & "'")
End If
```

Prvo traži u glavnom polju, pa tek ako ne nađe — u multi-barkod tabeli. **2.0/3.0 danas ima samo
`Item.barCode`; `R_Artikli_BarKod` nije modelovana ni sinkovana** — skener koji naiđe na barkod kutije
(a ne na primarni) neće naći artikal. Ovo je poznat gap (klaster A §A.3), ovde potvrđen tačnim mehanizmom
pretrage koji treba replicirati.

### 3.2 Prevodi — PRAVA tabela postoji, nije samo `INONaziv`

Na samom `R_Artikli` postoji `INONaziv`/`InoJm` (jedan strani naziv + jedna strana JM — trenutno
mapirano u `Item.foreignName`/`Item.foreignUnit`). Ali BigBit ima **zasebnu tabelu za više jezika**:

**`R_Artikli_Ino`** (`BB_T_26_schema.sql:1009-1015`):

| Kolona | Tip | Značenje |
|---|---|---|
| `IDArtikal` | Long Integer NOT NULL | FK → R_Artikli |
| `IDJezik` | Long Integer NOT NULL | FK → šifarnik jezika (tabela jezika nije pronađena u dostupnom exportu — `NEPOZNATO` koji ID odgovara kom jeziku) |
| `InoNazivArt` | Text(50) NOT NULL | naziv artikla na tom jeziku |
| `InoJMArt` | Text(5) | jedinica mere na tom jeziku |

Ovo je **1:N** (jedan artikal, više jezika), za razliku od `INONaziv` koji je **1:1** (jedan „strani
naziv", verovatno engleski, kolona na samoj `R_Artikli`). Praktično: `INONaziv` je brzi/legacy prečac za
najčešće korišćen strani jezik (verovatno EN za štampu dokumenata), a `R_Artikli_Ino` je pravi
višejezični rečnik ako Servoteh štampa dokumenta na više jezika istovremeno (nemački kupci?).

**Status u 2.0/3.0: potpun GAP.** `R_Artikli_Ino` nije ni pomenuta u ranijim analizama (klaster A/F1 su
je samo uzgred spomenuli u tabeli mapiranja pod „prateće tabele van sync mape", bez strukture). Nije ni
u QBigTehn kopiji (`qbigtehn_sqlserver.sql` nema `R_Artikli_Ino`) — mora se čitati direktno iz BigBit
originala kad dođe 4.0 Sync B.

Uz to postoji generički **`T_SRPENG_Recnik`** (rečnik srpski↔engleski, forma `SRPENG_Recnik`/
`SRPENG_SrpskiPodforma`/`SRPENG_EngleskiPodforma` u `_legacy/Izvoz/Forme/`) — ovo NIJE vezano za artikal
nego izgleda kao opšti rečnik termina za prevod štampanih dokumenata (etikete, izveštaji). Struktura
tabele nije čitljiva iz dostupnog exporta (binarni form dump bez čistog VBA) — `NEPOZNATO` da li ga
Servoteh uopšte koristi za artikle ili samo za druge dokumente.

### 3.3 Slike i prilozi — LINK, ne BLOB

Tri polja na `R_Artikli` upućuju na spoljne fajlove, **nijedno ne čuva sadržaj u bazi**:

| Polje | Tip | Šta je |
|---|---|---|
| `SlikaSimbolaLink` | Text(250) | putanja/link do slike simbola artikla |
| `PDFLink` | Text(255) | putanja/link do PDF dokumenta artikla |
| `WordLokacija` | Text(250) | putanja/link do Word dokumenta (specifikacija?) |

Sve tri su **string putanje**, ne `OLE Object`/`Attachment` tip polja. **Mehanizam dodele — potvrđen
kodom forme „Unos artikala"** (`Doc__Form_Unos artikala.txt:386-489`): dupli klik na polje otvara
Windows `FileDialog` (`msoFileDialogOpen`) sa filterom po tipu (`IzberiJPGFajl` — JPG/GIF/PNG;
`IzberiPDFFajl` — PDF; `IzberiWordFajl` — docx/doc) i upisuje **punu apsolutnu putanju izabranog
fajla** kakva jeste — operater ručno bira fajl bilo gde na disku/mreži, **nema upravljanog foldera ni
konvencije imenovanja**. Uz svako polje ide i dugme za brisanje linka (`DugmeObrisiPDFLink` i sl. —
postavi Null + snimi). `NEPOZNATO` ostaje samo: na kom serveru/share-u fajlovi tipično žive u praksi
(zavisi šta su operateri birali; utvrdiće se uvidom u stvarne vrednosti kolona na produkciji).

**Uz to postoji i 1:N tabela za VIŠE slika po artiklu** (nije bila u prvoj verziji ovog dokumenta):

**`ArtikliSlike`** (`BB_T_26_schema.sql:2326-2331`): `ID`(PK), `IDArtikal`(FK, NOT NULL),
`LinkSlika` Text(250). Forma `ArtikliSlike` (`Doc__Form_ArtikliSlike.txt`): isti FileDialog obrazac
za izbor, prikaz kroz `Image.Picture = LinkSlika` uz `FileExists` proveru (mrtav link → prazna slika,
bez pucanja). Dakle: `R_Artikli.SlikaSimbolaLink` = JEDNA glavna „slika simbola", `ArtikliSlike` =
galerija dodatnih slika. Postoje i **`GrupeSlike`** (`BB_T_26_schema.sql:331`) i **`PodgrupeSlike`**
(`BB_T_26_schema.sql:822`) — slika po grupi/podgrupi robe (za kataloge/menije). Sve tri tabele su
**GAP** u 2.0/3.0 (nema modela, nema sync-a).

**Posledica za 4.0:** ako se ovi linkovi žele učiniti korisnim (prikaz slike u UI, preview PDF-a), treba
prvo utvrditi da li je fajl-server dostupan sa novog stacka (network share vs. lokalni disk stare
Windows mašine) — inače su to mrtvi linkovi. Danas (2.0/3.0) su polja `symbolImageLink`/`pdfLink`/
`wordLocation` sinkovana kao tekst, ali se **nigde u frontendu ne renderuju** (nema komponente koja čita
ova polja — potvrđeno odsustvom frontend rute za artikle, v. §6).

### 3.4 Opisi — četiri odvojena tekstualna polja + jedna napomena

Artikal ima **četiri** različita „opisna" polja plus dve napomene, sa različitom namenom:

| Polje | Dužina | Namena (zaključeno iz naziva i konteksta) |
|---|---|---|
| `Naziv` | 50 | glavni, kratak — vidi se svuda (dokumenti, pretrage) |
| `OpisArtikla` | 50 | dodatni kratak opis, odvojen od naziva |
| `WebOpis` | 255 | duži opis, verovatno za katalog/web (BigBit „online" varijanta — v. `09-bigbit-online-domain-map.md`) |
| `Memo` | Memo (255) | slobodna interna napomena |
| `Napomena2` | 255 | druga napomena (uz Memo — namena razdvajanja nejasna, `NEPOZNATO`) |
| `INONaziv` | 50 | naziv na stranom jeziku (v. §3.2) |

Sva ova polja su danas 1:1 sinkovana u `Item` (`itemDescription`, `webDescription`, `memo`, `note2`,
`foreignName`) — nema gubitka podataka, samo nema UI koji bi ih prikazao razdvojeno.

### 3.5 Custom atributi artikla (R_Artikli_Obelezja) — potvrđeno u kodu, DDL nepoznat

VBA funkcija `ZadovoljenUslovZaObelezje` (`BiranjeArtikla.txt:489-505`) čita ključ-vrednost par po
artiklu iz tabele **`R_Artikli_Obelezja`**:

```vba
VrednostUTabeli = DLookup("[Vrednost]", "R_Artikli_Obelezja", "IDArtikal = " & IDArtikal)
```

Koristi se za filtriranje/uslovljavanje (npr. „artikal ima obeležje X sa vrednošću koja odgovara Y").
Tabela **nije pronađena** u `BB_T_26_schema.sql` niti u QBigTehn kopiji — mogla je biti dodata posle
snapshot-a, ili živi u drugom BigBit modulu koji nije obuhvaćen `BB_T_26.MDB` exportom. `NEPOZNATO`:
tačna struktura (verovatno `IDArtikal`, `Obelezje`/`IDObelezje`, `Vrednost`), broj redova, da li se
aktivno koristi kod Servoteha ili je nasleđe iz drugog BigBit klijenta. **Treba proveriti direktno na
BigBit originalu pre 4.0 planiranja** ako se custom atributi artikla pokažu bitni.

---

## 4. Kako se artikal unosi danas (BigBit — VBA/forme)

Kod-behind prave forme **„Unos artikala"** pronađen je u
`_legacy/BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/Doc__Form_Unos artikala.txt` (489 linija,
čist VBA) — §4.8–4.10 dolaze direktno iz njega. §4.1–4.7 dolaze iz pratećeg modula
`_legacy/Izvoz/Moduli_Tekst/BiranjeArtikla.txt` (picker/kartica/kloniranje, poziva istu formu kroz
`BBOpenForm "Unos artikala"`).

### 4.1 Pretraga/izbor artikla (autocomplete)

`NazivArtiklaNijeUListi` (koristi se u `OnNotInList` combo-boxa za izbor artikla na svakom dokumentu):
pretraga po `Naziv LIKE '%...%' OR [Kataloski broj] LIKE '%...%'`, sortirano po nazivu pa kat. broju.
Kad je zadat cenovnik (`Vrsta dokumenta`), spaja se sa `Cenovnik` da odmah pokaže cenu i tarifu, i
posebno sortira „SIR%" grupu na kraj liste (`ORDER BY IIf([Grupa] Like 'SIR%','ZZ','') + [Naziv]`) —
sirovine se sistematski guraju na dno pri običnom biranju artikla.

### 4.2 Kloniranje artikla „po modelu" (`DodajArtiklePoModelu`)

Umesto praznog unosa, operater može izabrati postojeći artikal kao **model** i napraviti N kopija:

```vba
INSERT INTO [dbo].[R_Artikli] (Kataloski broj, BarKod, PLU, ExtSifra, Naziv, InoNaziv, ...)
SELECT SledeciKatBroj(), Null AS BarKod, SledeciPLU, ExtSifra, Naziv, InoNaziv, ...
FROM R_Artikli WHERE [Sifra artikla] = <IDArtikalModel>
```

Kopira se **skoro sve** (JM, pakovanje, poreklo, grupa/podgrupa, tarife, cene, GK konta, carinska stopa,
raster, dobavljač, opis, magacinski flagovi, dimenzije...) sem: `Kataloski broj` (dobija sledeći slobodan
broj preko `SledeciKatBroj()`), `BarKod` (uvek prazan — barkod se ne kopira, mora se posebno dodeliti),
`PLU` (dobija sledeći slobodan preko `SledeciPLU`). Ovo je bitan UX obrazac za 4.0: masovno dodavanje
sličnih artikala (varijante dimenzija/boja) kroz „Kloniraj kao..." radije nego prazan formular svaki put.

### 4.3 Barkod — posebne forme

`Form_BarKod_Unos.cls`, `Form_BarKod_Ispravka.cls`, `Form_BarKod_Status.cls` (potvrđeno postojanje u
`_legacy/QBigTehn_APL/forms/`, sadržaj nije dubinski čitan u ovoj analizi jer je kod-behind prazan/trivijalan
po nazivu funkcija) — odvojen tok od glavnog unosa artikla: dodela barkoda, ispravka pogrešno
dodeljenog, pregled statusa dodele. Ovo je odvojena operativna aktivnost od kreiranja artikla — potvrđuje
da barkod nije nužno poznat u trenutku kreiranja artikla (artikal prvo postoji, barkod se „zalepi" kasnije).

### 4.4 Kartica artikla (pregled kretanja)

`KarticaArtikla`/`VPKarticaArtikla` (VP kartica), `MPKarticaArtikla` (MP kartica), `KomisionaKarticaArtikla`
(komisiona prodaja) — tri odvojena „kartica artikla" prikaza po kanalu prodaje (veleprodaja/maloprodaja/
komisiona), sve filtrirane po `[Sifra artikla] = X` i opciono po magacinu/prodavnici. Nema paralelu u
2.0/3.0 danas (nema uvid u kretanje artikla kroz vreme na nivou UI — samo agregatni `MrpItemStock`).

### 4.5 Normativ i rastavnica sa nivoa artikla

`NormativArtikla` otvara formu „Unos recepta" (→ `T_Recepti`), `RastavnicaArtikla` otvara
„Rastavnice_Unos" (→ `T_Rastavnice`) — oba filtrirana po artiklu. Ovo je BigBit-ov artikal-nivo BOM,
već analiziran i **odbačen kao superseded** od strane PDM BOM-a u klaster A §A.5 (`SastavMaterijala`)
— isti zaključak važi i za `T_Recepti`/`T_Rastavnice`, koji su takođe artikal-nivo (ne crtež-nivo).

### 4.6 Direktan upis pojedinačnog polja (administrativni prečac)

`UpisiUArtikal(IDArtikal, NazivKolone, NovaVrednost)` — generička funkcija koja otvara `R_Artikli` DAO
recordset i upisuje proizvoljnu kolonu po imenu, sa type-coercion za Boolean. Koristi se npr. u
`UpisiKNG2SifruUArtikal` (upis GK konta zamene) i verovatno na više mesta van ovog modula. Ovo je
tipičan legacy „escape hatch" — nema validacije na nivou forme, direktan pristup bazi mimo glavnog
unosnog ekrana. Nije nešto što treba replicirati u 4.0 (BACKEND_RULES već zabranjuje ovakve obrasce),
ali objašnjava zašto neka polja (npr. `KngSifra_2`) mogu imati vrednosti koje ne prolaze kroz glavnu
formu za unos.

### 4.8 Sama forma „Unos artikala" — nov unos, numeracija, tvrda pravila

Iz `Doc__Form_Unos artikala.txt` (linije po navodu):

- **Novi artikal** (`Dugme_Novi_artikal`, :69-91): novi slog + fokus na `Kataloski broj`; ako je
  prazan, **auto-dodela sledećeg kataloškog broja**: `DMax("[NajveciKatBrojNum]", "NajveciKatBroj") + 1`,
  formatirano na **5 cifara sa vodećim nulama** (`DoChLeft(CStr(tmp), 5, "0")`). Dakle podrazumevana
  šema kataloškog broja je numerička petocifrena (`00001`…), a upit `NajveciKatBroj` računa maksimum
  numeričkog dela — operater može ručno prekucati u nenumerički format ako želi.
- **Jedinstvenost kataloškog broja — TVRDA validacija na formi** (`Form_BeforeUpdate`, :271-295):
  `DLookup` traži drugi artikal sa istim kataloškim brojem (`[Sifra artikla] <> tekući`) → ako postoji,
  `MsgBox "Već postoji artikal sa istim kataloškim brojem!"` + `CancelEvent` — **snimanje se BLOKIRA**.
  Ovo je legacy pandan 3.0 brani za jedinstven kataloški broj (DB constraint) — BigBit isto pravilo
  sprovodi, ali samo na nivou ove forme (escape hatch-evi iz §4.6 ga zaobilaze).
- **PLU auto-dodela** u istom `BeforeUpdate`: ako je `PLU` prazan/0 → `SledeciPLU()`.
- **Brisanje** (`Dugme_Obrisi_artikal`, :93-107): fizički DELETE sloga uz potvrdu — uprkos postojanju
  `ZaBrisanje` flaga na tabeli, forma nudi i pravo brisanje (flag je verovatno za „označi pa obriši
  kasnije skriptom" tok).
- **Posle snimanja** (`Form_AfterUpdate`, :261-269): requery listi artikala na otvorenoj formi
  „Ulazna faktura" (artikal se često dodaje USRED unosa ulazne fakture — nov artikal odmah vidljiv u
  padajućim listama fakture) + `PotpisiArt` upis potpisa (audit ko je menjao).

### 4.9 Zaštita cena od slučajne izmene + kaskadni šifarnici

- Polja **`VP cena`, `MP cena`, `PLU`, `ProdDevCena` su po defaultu zaključana (Locked)**; dupli klik
  na polje toggle-uje zaključanost (:382-393, :406-417). Cena se ne može slučajno prekucati — svesna
  gesta otključavanja je obavezna. Vredan UX obrazac za 4.0 (edit-guard na cenovnim poljima).
- **Kaskadni combo-boxovi klasifikacije** (:336-404): izbor `Grupa` → requery `Podgrupa` liste → izbor
  `Podgrupa` → requery `Poreklo` liste. Potvrđuje hijerarhiju Grupa → Podgrupa → Poreklo iz §2.1
  (`GrupaVeza`/`PodgrupaVeza` kolone) kao ŽIVU logiku unosa, ne mrtve kolone.
- Sa forme se direktno otvaraju šifarnici (dugmad): Poreklo, Tarife poreza, Parametri, RasterDef,
  PregledKNGArtikala (i dupli klik na `KngSifra`), Kartica artikla, Unos recepta.

### 4.10 Raster kod Servoteha = dimenzije ploče + auto-obračun težine (ISPRAVKA ranije klasifikacije)

`DugmePreracunajTezinuUKomadu` (:218-241):

```vba
Me!Kutija = Me!Debljina * VrstaRastera * KolonaRastera * 7850 / 1000000000
```

`VrstaRastera` i `KolonaRastera` (izvučeni iz `RasterDef*` tabela za `IDRaster` artikla) su ovde
**dimenzije u mm**, `Debljina` je debljina lima u mm, **7850 = gustina čelika u kg/m³** — formula
računa **kilograme po komadu ploče/lima** i upisuje u `Kutija`. Dakle za Servoteh raster NIJE
maloprodajni koncept veličina/boja (kako je klasifikovano u klaster B §5 „van scope-a") nego nosilac
**dimenzija tablе/lima** za obračun mase. Pre isključivanja `Raster*` tabela iz 4.0 scope-a obavezno
proveriti koliko Servoteh artikala ima `IDRaster > 0` i da li se ovaj obračun aktivno koristi —
klasifikacija „van scope" važi samo za maloprodajnu upotrebu rastera (veličine/boje), ne za ovu.

### 4.11 Zamena artikla (KngSifra_2 kao „nasledi ovaj")

`PonistiZamenu`/`UpisiKNG2SifruUArtikal`/`UpisiNovuUmestoStareKNG2Sifre`: `KngSifra_2` se koristi kao
**„zamenska šifra"** — kad se jedan artikal zamenjuje drugim (isti GK tretman), stari artikal dobija
`KngSifra_2` postavljen na šifru **primarnog** (zamenjujućeg) artikla. `BrojArtikalaSaKNG2Sifrom` broji
koliko artikala „gleda" na istu zamensku šifru; ne može se poništiti zamena na primarnom artiklu ako
postoji više od jednog artikla koji ga referiše kao zamenu (`"Ovaj artikal je primarni u zameni i ne
može se poništiti."`). Ovo je poslovno pravilo o **nasleđivanju artikala** (stari kataloški broj se više
ne koristi, ali ostaje u istoriji dokumenata, novi artikal preuzima buduće porudžbine) koje danas u
2.0/3.0 nema nikakav ekvivalent — vredno zabeležiti za 4.0 `masters`/`inventory` ako Servoteh redovno
menja/ukida artikle.

---

## 5. Tok podataka: BigBit → QBigTehn → servosync4 (tačan mehanizam)

Tri stanice, potvrđene kodom:

```
BigBit original (BB_T_26.MDB, R_Artikli)
      │  EXT_R_Artikli = LINKED tabela (ODBC/Access link)
      │  putanja: P:\Servoteh\BigBit26\STH26\BB_T_26.MDB  (iz tables.txt)
      ▼
QBigTehn Access app (QBigTehn_APL) — dugme "Preuzmi iz BB"
      │  DodajNoveArtikleIzBigBita() — SAMO NOVI REDOVI
      ▼
QBigTehn SQL Server (vasa-SQL:5765, baza QBigTehn, tabela R_Artikli)
      │  POST /sync/run — NA DUGME, generic syncer, watermark: null (FULL REFRESH)
      ▼
servosync4 Postgres (items)
```

### 5.1 BigBit → QBigTehn: `DodajNoveArtikleIzBigBita`

Puna SELECT lista (67 kolona originala, sve prenete) sa **ključnim detaljem** koji objašnjava ID-drift
opisan u F1 analizi:

```vba
SELECT EXT_R_Artikli.[Sifra artikla] AS [BBSifra artikla], EXT_R_Artikli.[Kataloski broj], ...
FROM EXT_R_Artikli
LEFT JOIN R_Artikli ON EXT_R_Artikli.[Sifra artikla] = R_Artikli.[BBSifra artikla]
WHERE (((R_Artikli.[BBSifra artikla]) Is Null));

retValOk = ExportujTabeluUSQLBezIdentityKolone("EXT_R_Artikli", "R_Artikli", ...)
```

`ExportujTabeluUSQLBezIdentityKolone` (naziv govori sam za sebe: „export tabele u SQL BEZ IDENTITY
kolone") — **BigBit-ova `Sifra artikla` se upisuje u `BBSifra artikla`, a QBigTehn-ova `Sifra artikla`
(PK) dobija NOVU vrednost preko IDENTITY auto-increment-a SQL Server-a.** Ovo je tačan, do sada
nepotvrđen mehanizam iza F1-ovog nalaza „NAJVEĆI DRIFT — u kopiji je `Sifra artikla` lokalni QBigTehn
IDENTITY, ne BigBit šifra". Direktna posledica: `items.id` u servosync4 **nikad neće odgovarati BigBit
šifri artikla** — jedina veza nazad je `items.external_item_id` (= `BBSifra artikla`).

**Match je `WHERE ... IS NULL` (LEFT JOIN anti-join)** — ovo je čist **append-only za NOVE redove**.
U dostupnim VBA modulima (`ImportIzBB_Module.bas`, `ODBC_Synch_Module.bas`, `ODBC_Synch_NoviModul.bas`,
`ADO_Synch.bas`, `modSyncMirrorTabele.bas`) **nije pronađena nijedna `UPDATE R_Artikli` naredba** koja bi
osvežila postojeće redove kad se artikal izmeni u BigBit-u (cena, naziv, aktivan/neaktivan...) nakon što
je već jednom prebačen. To znači: **ako se artikal izmeni u BigBit-u posle prvog "Preuzmi iz BB", ta
izmena NE stiže automatski u QBigTehn kopiju niti dalje u 2.0/3.0**, osim ako postoji drugi mehanizam
koji nije obuhvaćen ovim exportom (npr. ručna izmena direktno u QBigTehn Access aplikaciji, koja ima
svoju sopstvenu „Unos artikala" formu — v. §4). **Ovo nije bilo eksplicitno rečeno u ranijim analizama
i vredi proveriti sa Nenadom/Nesom** pre nego što se pretpostavi svežina cena/naziva u `items` (osim
onoga što `Cenovnik` posebno sinkuje, koji ima sopstveni tok preko drugih upita — `06_PrenesiR_Artikli.sql`
i sličnih u `_legacy/Izvoz/Upiti/`).

`06_PrenesiR_Artikli.sql` (`_legacy/Izvoz/Upiti/06_PrenesiR_Artikli.sql`) je varijanta istog append-only
obrasca na nivou čiste SQL (bez VBA), ista `WHERE [Sifra artikla] Is Null` logika, ali koristi
`Sifra artikla` direktno (ne `BBSifra artikla`) — ovo je verovatno stariji/alternativni put unutar SAME
QBigTehn baze (npr. iz staging tabele `R_Artikli1` u samu `R_Artikli`), ne BigBit→QBigTehn korak.
Postojanje **dve** varijante transfera (VBA funkcija + gola SQL upit datoteka) sugeriše da je mehanizam
menjan tokom vremena — trenutno aktivna varijanta (VBA `ImportIzBB_Module`) je ta koja se poziva sa
dugmeta u UI (`RibbonModule`/meni), ali ovo nije direktno potvrđeno klikom kroz UI (van dosega ove analize).

### 5.2 QBigTehn → servosync4: generic syncer, FULL REFRESH

`sync-map.generated.ts` (linija ~1701): `source: "R_Artikli"`, `model: "Item"`, **`watermark: null`**.
Za razliku od `Komitenti` (koji ima `PoslednjaIzmena` watermark → inkrementalni sync), `R_Artikli` nema
kolonu za praćenje poslednje izmene koju bi syncer mogao koristiti — svaki `POST /sync/run` mora čitati
**svih 91.199+ redova** iznova (full refresh), što bar znači da **ako QBigTehn kopija sadrži svežu
vrednost, ona STIŽE u Postgres na sledeći ručni sync-run** (za razliku od §5.1 koraka gde append-only
znači da QBigTehn kopija možda uopšte nema svežu vrednost). Dva odvojena rizika za svežinu, na dve
različite stanice lanca — ne mešati ih.

---

## 6. Trenutno stanje u servosync4 (šta danas postoji)

- **Modeli:** `Item` (`items`), `ItemGroup` (`item_groups`, prazan), `ItemSubgroup` (`item_subgroups`,
  prazan), `ItemOrigin` (`item_origins`, prazan), `ItemValuation` (`item_valuations` — trošak po
  metodama A/B/C/VP/MP, koristi se u `robno/costing.service.ts`, nije direktan port BigBit tabele nego
  2.0-native kalkulacija).
- **Upis:** ISKLJUČIVO generic syncer (`sync-map.generated.ts`). Pretraga po celom `backend/src/modules`
  stablu ne nalazi nijedan `item.create`/`item.update`/`item.upsert` poziv na Prisma `Item` model u
  aplikativnom kodu — `items` je **čist read-only cache**, tačno kao `customers`.
- **Nema CRUD UI ni API endpoint-a za artikle.** Nema `backend/src/modules/items` (ili slično) modula,
  nema `frontend/src/app/**/artikli` rute. Artikal se **ne unosi u 3.0/4.0 danas** — unosi se isključivo
  u BigBit, kao i pre.
- **Potrošači `items` u 2.0/3.0** (read-only, preko `itemId` mekog FK-a): `robno` (kalkulacija, nivelacija,
  rezervacije, inventura), `nabavka` (3-way match, RFQ), `sales` (fakturisanje, avansni računi, SEF/UBL),
  `handovers`, `tech-processes`, `podesavanja` (predmet-planeri). Sve čitaju `Item.name`/`catalogNumber`/
  cene za prikaz, nijedan ne piše nazad u `items`.
- **`ItemValuation`** je jedina po-artiklu tabela koju 2.0/3.0 **piše** (`costing.service.ts`) — ali to
  je izvedena vrednost (trošak), ne matični podatak artikla.

---

## 7. Gap analiza — šta nedostaje za 4.0 `masters`/`inventory` (prioritizovano)

| # | Šta nedostaje | Trenutni gap | Cena porta | Prioritet |
|---|---|---|---|---|
| 1 | Nazivi grupa/podgrupa/porekla u UI | `ItemGroup`/`ItemSubgroup`/`ItemOrigin` postoje, nikad se ne pune | mala (3 syncera po obrascu `customer.syncer.ts`) | **VISOK, odmah** |
| 2 | Multi-barkod (`R_Artikli_BarKod`) | skener koji čita barkod kutije/ambalaže ne nalazi artikal | srednja (nova tabela + prošireni lookup po obrascu `F_IDArtikalZaBarKod`) | VISOK (barkod nalepnice već aktivna tema, v. memory) |
| 3 | Multi-jezik naziv (`R_Artikli_Ino`) | samo jedan „strani naziv" (`INONaziv`), nije ni u QBigTehn kopiji | srednja (mora direktno iz BigBit originala pri 4.0 Sync B) | SREDNJI (zavisi da li Servoteh štampa na >2 jezika) |
| 4 | `R_KvalitetArtikla` | `Item.qualityTypeId` visi, tabela ne postoji ni u kopiji | mala (nov model + sync direktno iz originala) | SREDNJI |
| 5 | `DobavljaciZaArtikal` (puna lista, ne samo primarni) | MRP zna samo `Item.supplierId` (jedan dobavljač) | srednja | SREDNJI (procurement priprema) |
| 6 | `Rabati`/`RabatiPoArt`/`Akcije`/`AkcijeArtikli` | komercijalna politika cena potpuno odsutna | srednja-visoka | SREDNJI (sales pricing) |
| 7 | `R_Artikli_Obelezja` (custom atributi) | struktura nepoznata, koristi se u legacy filterima | nepoznata dok se ne potvrdi DDL | NIZAK dok se ne potvrdi da se koristi |
| 8 | Slike/PDF/Word linkovi se ne prikazuju + `ArtikliSlike`/`GrupeSlike`/`PodgrupeSlike` galerije (1:N) | polja postoje i sinkuju se ali frontend ih ignoriše; 1:N tabele slika uopšte nisu modelovane | mala za UI linkova; srednja za galerije (nisu u QBigTehn kopiji → BigBit-direct) | NIZAK dok se ne proveri dostupnost putanja sa produkcije |
| 9 | Zamena artikla (`KngSifra_2` lanac) | poslovno pravilo „stari artikal → novi artikal" nema ekvivalent | srednja (state/relacija, ne samo polje) | NIZAK-SREDNJI (proveriti da li se aktivno koristi) |
| 10 | Kartica artikla (VP/MP/komisiona pregled kretanja) | nema UI ekvivalenta | srednja (potrebna je i transakciona istorija, ne samo matični podatak) | SREDNJI (UX, ne blokira core) |

**Fundamentalni rizik (ponovljen iz F1, ovde potvrđen mehanizmom u §5.1):** `items.id` je QBigTehn-lokalni
IDENTITY, ne BigBit šifra. Svaka buduća migracija koja direktno čita BigBit (4.0 Sync B) mora mapirati
preko `external_item_id`, ili sve postojeće FK-ove (cenovnik, MRP, robne stavke, buduće fakture) treba
jednokratno remap-ovati na BigBit prostor ključeva. Ovo je odluka koja **mora** biti doneta pre 4.0
`masters`/`inventory` implementacije (BACKEND_RULES §11 — otvorena arhitektonska odluka).

**Operativni rizik (nov nalaz, §5.1):** ako se potvrdi da BigBit izmene postojećih artikala ne
propagiraju automatski u QBigTehn kopiju (nema UPDATE mehanizma u pregledanom kodu), onda `items` u
servosync4 može nositi **zastarele** cene/nazive/aktivan-flag za artikle koji su odavno kreirani a
kasnije menjani u BigBit-u — čak i uz redovan `POST /sync/run`. Ovo treba potvrditi upitom na produkciji
(uporediti `DatumIVremeArt` na QBigTehn kopiji vs. BigBit original za isti `BBSifra artikla`/`Sifra artikla`)
pre nego što se donese bilo kakva odluka o pouzdanosti cena iz `items` u 4.0 `sales`/`procurement`.

---

## 8. Otvorena pitanja (NEPOZNATO — treba proveriti sa Nenadom/Nesom ili direktno na BigBit originalu)

1. Struktura `R_Artikli_Obelezja` (custom atributi) — nema DDL u dostupnom exportu.
2. Da li BigBit izmene postojećih artikala (cena, naziv, aktivan) ikad stižu u QBigTehn kopiju van
   append-only „Preuzmi iz BB" mehanizma — ili se to radi ručno, direktno u QBigTehn Access aplikaciji.
3. ~~Tačna konvencija putanje za slike/PDF/Word~~ **REŠENO 27.07 (v. §3.3):** putanje su proizvoljne,
   ručno birane kroz FileDialog — nema konvencije. Ostaje samo: uvid u stvarne vrednosti kolona na
   produkciji (koji server/share operateri tipično biraju) i da li je taj share dostupan sa 4.0 stacka.
3b. Koliko Servoteh artikala ima `IDRaster > 0` i koristi li se aktivno obračun kg/komadu iz §4.10 —
   odlučuje da li `RasterDef*` tabele ulaze u 4.0 scope (ispravka ranije „van scope" klasifikacije).
4. Šifarnik jezika za `R_Artikli_Ino.IDJezik` (koji ID je koji jezik) — tabela nije pronađena u exportu.
5. Da li se `T_SRPENG_Recnik` uopšte koristi za artikle, ili isključivo za druge štampane dokumente.
6. Namena razdvajanja `Memo` vs `Napomena2` (dva slobodna teksta na istom artiklu).

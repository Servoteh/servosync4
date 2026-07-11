## F1 — Pokrivenost polja: da li su sinkovane matične tabele stvarno 1:1?

> **Pitanje (Nenad #3):** da li sync BigBit → 2.0 kopira SVE kolone, ili nam negde fale polja?
>
> **Izvori poređenja (tri strane):**
> 1. **BigBit original** — `_analiza/bigbit/BB_T_26_schema.sql` (Access DDL, snapshot BB_T_26)
> 2. **QBigTehn kopija** (vasa-SQL, iz koje 2.0 stvarno sinkuje) — `_analiza/qbigtehn_sqlserver.sql`
> 3. **2.0 target** — `backend/prisma/schema.prisma` + `backend/src/modules/sync/sync-map.generated.ts` (62 mapiranih tabela; generic syncer registruje sve iz mape, `Komitenti` ima i namenski `customer.syncer.ts`)

### Kratak odgovor

| Tabela → 2.0 model | BigBit kolona | Kopirano u 2.0 | Izostavljeno iz BigBit-a | Ocena |
|---|---:|---:|---:|---|
| Komitenti → Customer | **57** | **56** | 1 (`KoristiPNBZadModel`) | praktično 1:1 |
| Predmeti → Project | **38** | **38** | 0 | 1:1 |
| R_Artikli → Item | **67** | **67** (+1 samo iz kopije: `BBSifra artikla`) | 0 | 1:1 + surogat |
| Prodavci → Salesperson | **16** | **16** | 0 | 1:1 |
| Cenovnik → PriceListEntry | **11** | **11** | 0 | 1:1 |
| Magacini → Warehouse | **11** | **11** | 0 | 1:1 |
| R_Tarife → TaxRate | **10** | **10** (+ surogat `ID` iz kopije) | 0 | 1:1 + surogat |
| R_Vrste dokumenata → DocumentType | **23** | **23** (+ surogat `ID` iz kopije) | 0 | 1:1 + surogat |
| R_Grupa → ItemGroup | 2 | **0** | 2 | **model postoji, NIJE sinkovan** |
| R_Podgrupa → ItemSubgroup | 3 | **0** | 3 | **model postoji, NIJE sinkovan** |
| R_Poreklo → ItemOrigin | 4 | **0** | 4 | **model postoji, NIJE sinkovan** |
| R_KvalitetArtikla → (nema modela) | 3 | **0** | 3 | **nema ni u QBigTehn kopiji, ni u 2.0** |
| **UKUPNO** | **245** | **232** | **13** | |

Dakle: **osam „velikih" matičnih tabela jeste sadržajno 1:1** (232/233 kolona iz BigBit-a, jedina rupa je
`Komitenti.KoristiPNBZadModel`). Ono što FALI nisu kolone u sinkovanim tabelama, nego **četiri šifarnika
artikala koji se uopšte ne sinkuju** (12 kolona, ~stotine redova) i par pratećih tabela van sync mape
(`KomitentiKontaktOsobe`, `MestaIsporuke`, `R_Artikli_BarKod`, `R_Artikli_Ino`, `MestaIzdavanja`).

---

### 1. Komitenti → `Customer` (`customers`)

BigBit: **57** kolona · QBigTehn kopija: **56** · sync mapira **56/56** iz kopije (watermark: `PoslednjaIzmena` → inkrementalno; jedina tabela od posmatranih sa watermark-om).

| BigBit kolona | Tip (Access) | Mapira se u 2.0? | Napomena |
|---|---|---|---|
| Sifra | Long Integer | DA `id` | PK; u kopiji IDENTITY |
| Naziv | Text(50) | DA `name` | |
| Poslovnica | Text(50) | DA `branch` | |
| Mesto | Text(30) | DA `city` | |
| Adresa | Text(50) | DA `address` | |
| Postanski broj | Text(20) | DA `postalCode` | |
| Ziro racun_1 | Text(30) | DA `bankAccount1` | banking |
| Ziro racun_2 | Text(30) | DA `bankAccount2` | banking |
| Ziro racun_3 | Text(30) | DA `bankAccount3` | banking |
| Telefon | Text(20) | DA `phone` | |
| Fax | Text(20) | DA `fax` | |
| Kontakt | Text(50) | DA `contact` | |
| Napomena | Memo | DA `note` | |
| Drzava | Text(30) | DA `country` | |
| Region | Long Integer | DA `region` | |
| Vrsta sifre | Text(10) | DA `codeTypeCode` | FK → `code_types`; syncer NULL-uje nepostojeći kod. **Drift:** BigBit NOT NULL, kopija NULL |
| Email | Text(50) | DA `email` | |
| Mobilni | Text(20) | DA `mobile` | |
| Datum rodjenja | DateTime | DA `birthDate` | |
| Web adresa | Text(50) | DA `webAddress` | |
| Sifra prodavca | Long Integer | DA `salespersonId` | FK → `salespeople`; syncer NULL-uje nerazrešiv ID |
| RabatKomitenta | Double | DA `customerDiscount` | komercijala (rabat) |
| ZastKodKupca | Text(50) | DA `buyerProtectionCode` | |
| PIB | Text(20) | DA `taxId` | **Drift nullability:** BigBit NULL-abilan, kopija NOT NULL, 2.0 `String` NOT NULL — direktan 4.0 sync sa BigBit-a mora obraditi NULL PIB |
| PDVStatus | Long Integer | DA `vatStatus` | tax |
| MSifra | Text(10) | DA `externalCode` | |
| Odlozeno | Integer | DA `paymentTermDays` | valuta plaćanja (dana) |
| IDRuta | Long Integer | DA `routeId` | FK bez tabele u 2.0 (rute se ne sinkuju) |
| IDVozac | Long Integer | DA `driverId` | self-FK → `customers`; čuva se samo > 0 |
| IDUplatniRacun | Long Integer | DA `paymentAccountId` | `UplatniRacuni` SE sinkuje (u mapi) |
| FakturisanjePoMestimaIsporuke | Boolean | DA `invoicePerDeliveryAddress` | sales; ali `MestaIsporuke` NIJE u sync mapi |
| Cenovnik | Text(5) | DA `priceListCode` | komercijala |
| PrviUnos | DateTime | DA `createdAt` | |
| PoslednjaIzmena | DateTime | DA `updatedAt` | **watermark za inkrementalni sync** |
| PrviUnosUser | Text(20) | DA `createdBy` | |
| PoslednjaIzmenaUser | Text(20) | DA `updatedBy` | |
| ProcenatProvizije | Double | DA `commissionPercent` | komercijala |
| FiktRabatKomitenta | Double | DA `fictitiousDiscount` | komercijala |
| KomitentiNacinPlacanja | Text(50) | DA `paymentMethod` | banking/sales |
| PotpisKom | Text(50) | DA `signature` | |
| SkraceniNaziv | Text(30) | DA `shortName` | |
| DatumIVremeKom | DateTime | DA `recordCreatedAt` | |
| ProveraDuga | Boolean | DA `checkDebt` | finance |
| KreditLimit | Currency | DA `creditLimit` | Decimal(19,4); finance |
| NeProveravajPIB | Boolean | DA `skipTaxIdValidation` | |
| IDPantheon | Text(30) | DA `pantheonId` | |
| NewsLetter | Boolean | DA `newsletter` | |
| PostaNaDruguAdresu | Boolean | DA `mailToDifferentAddress` | |
| GLN | Text(30) | DA `gln` | SEF/e-faktura |
| KLRucProc | Currency | DA `manualMarkupPercent` | komercijala |
| NapomenaZaSalda | Memo | DA `balanceNote` | finance |
| NePrikazatiUPregledu | Boolean | DA `hideInOverview` | |
| JBKJS | Text(10) | DA `publicSectorId` | SEF (javni sektor) |
| MaticniBroj | Text(20) | DA `registrationNumber` | |
| ER_XMLSaPopustomPoArtiklu | Boolean | DA `einvoiceXmlPerItemDiscount` | SEF |
| CRF | Boolean | DA `centralInvoiceRegistry` | CRF registar |
| **KoristiPNBZadModel** | Boolean | **NE — izostavljeno** | **Ne postoji ni u QBigTehn kopiji** (BigBit je dodao kolonu POSLE kreiranja kopije → dokaz šema-drifta). Poziv-na-broj zadati model — **bitno za 4.0 banking**, nebitno za tehnologiju |

**Zaključak:** 56/57; sva komercijalna, SEF i finansijska polja komitenata su VEĆ u 2.0 bazi (samo kao cache).

### 2. Predmeti → `Project` (`projects`)

BigBit: **38** kolona · kopija: **38** · mapirano **38/38**. Bez watermark-a → full refresh pri svakom run-u.

| BigBit kolona | Tip | Mapira se u 2.0? | Napomena |
|---|---|---|---|
| IDPredmet | Long Integer | DA `id` | PK |
| BrojPredmeta | Text(20) | DA `projectNumber` | |
| Opis | Text(50) | DA `description` | |
| DatumOtvaranja | DateTime | DA `openedAt` | **Drift:** BigBit NOT NULL → kopija NULL |
| IDProdavac | Long Integer | DA `salespersonId` | FK |
| IDKomitent | Long Integer | DA `customerId` | FK |
| NextAction | Text(50) | DA `nextAction` | |
| DatumZakljucenja | DateTime | DA `closedAt` | |
| Memo | Memo | DA `memo` | |
| Status | Text(20) | DA `status` | **Drift:** BigBit NOT NULL → kopija NULL |
| NasaRef / NasKontakt1 / NasKontakt2 / NasTel1 / NasTel2 | Text | DA `ourRef/ourContact1/ourContact2/ourPhone1/ourPhone2` | 5 kolona |
| VasaRef / VasKontakt1 / VasKontakt2 / VasTel1 / VasTel2 | Text | DA `theirRef/theirContact1/theirContact2/theirPhone1/theirPhone2` | 5 kolona |
| NabavnaVrednost | Currency | DA `procurementValue` | komercijala (kalkulacija predmeta) |
| Carina | Currency | DA `customs` | customs |
| Spedicija | Currency | DA `forwarding` | |
| Prevoz | Currency | DA `transport` | |
| Ostalo | Currency | DA `other` | |
| InoDobavljac | Long Integer | DA `foreignSupplierId` | procurement |
| RJ | Text(4) | DA `workUnitCode` | |
| devvaluta | Text(3) | DA `currency` | |
| kurs | Currency | DA `exchangeRate` | |
| IDVrstaPosla | Long Integer | DA `workTypeId` | **Drift:** BigBit NOT NULL → kopija NULL; `PredmetiVrstaPosla` postoji u kopiji ali NIJE u sync mapi |
| NazivPredmeta | Text(250) | DA `projectName` | |
| RokZavrsetka | DateTime | DA `deadline` | **Drift:** BigBit NOT NULL → kopija NULL |
| Potpis | Text(50) | DA `signature` | |
| DatumIVreme | DateTime | DA `createdAt` | |
| BrojUgovora | Text(100) | DA `contractNumber` | sales |
| DatumUgovora | DateTime | DA `contractDate` | sales |
| BrojNarudzbenice | Text(100) | DA `orderNumber` | sales |
| DatumNarudzbenice | DateTime | DA `orderDate` | sales |

**Zaključak:** potpuno 1:1. Napomena: prateće tabele `PredmetiFaze`/`PredmetiFazeDef`/`PredmetiVrstaPosla` postoje u obe baze, ali NISU u sync mapi (faze predmeta i vrste posla su rupa ako 4.0 želi CRM/komercijalni pregled predmeta).

### 3. R_Artikli → `Item` (`items`)

BigBit: **67** kolona · kopija: **68** (sve BigBit kolone + `BBSifra artikla`) · mapirano **68/68**.

| BigBit kolona | Tip | Mapira se u 2.0? | Napomena |
|---|---|---|---|
| Sifra artikla | Long Integer | DA `id` | **NAJVAŽNIJI DRIFT:** u kopiji je ovo LOKALNI QBigTehn IDENTITY, **ne** BigBit šifra (v. §Drift) |
| Kataloski broj | Text(20) | DA `catalogNumber` | ključno za tehnologiju |
| BarKod | Text(20) | DA `barCode` | **Drift širine:** kopija nvarchar(50), BigBit Text(20); 2.0 VarChar(50) |
| PLU | Long Integer | DA `plu` | POS polje (podatak se kopira, MP se ne koristi u 4.0) |
| ExtSifra | Text(20) | DA `externalCode` | |
| Naziv | Text(50) | DA `name` | |
| Jedinica mere | Text(5) | DA `unit` | |
| Pakovanje | Text(10) | DA `packaging` | |
| InoJm | Text(5) | DA `foreignUnit` | |
| Kutija | Double | DA `box` | |
| Transportno pakovanje | Double | DA `transportPackaging` | |
| Poreklo | Text(5) | DA `originCode` | kod BEZ šifarnika (R_Poreklo se ne sinkuje) |
| Grupa | Text(10) | DA `groupCode` | kod BEZ šifarnika (R_Grupa se ne sinkuje) |
| Podgrupa | Text(10) | DA `subgroupCode` | kod BEZ šifarnika (R_Podgrupa se ne sinkuje) |
| Tarifa robe | Text(5) | DA `goodsTaxRateCode` | tax |
| Tarifa usluga | Text(5) | DA `serviceTaxRateCode` | tax |
| Uvek porez na robu | Boolean | DA `alwaysTaxGoods` | tax |
| Uvek porez na usluge | Boolean | DA `alwaysTaxServices` | tax |
| VP cena | Double | DA `wholesalePrice` | komercijala |
| MP cena | Double | DA `retailPrice` | MP — kopira se, ne koristi u 4.0 |
| NabDevCena | Double | DA `fxPurchasePrice` | procurement |
| ProdDevCena | Double | DA `fxSalePrice` | sales |
| Minimalna kolicina | Double | DA `minQuantity` | inventory (min zalihe) |
| ArtTaksa | Double | DA `itemFee` | tax |
| Odlozeno | Integer | DA `paymentTermDays` | |
| Neoporezivi deo | Double | DA `nonTaxablePart` | tax |
| MaxRabatProc | Double | DA `maxDiscountPercent` | komercijala |
| Memo | Memo | DA `memo` | |
| KngSifra | Text(10) | DA `accountingCode` | GK konto — finance/GL |
| ArtAkciza | Double | DA `itemExcise` | tax (akciza) |
| KngSifra_2 | Text(10) | DA `accountingCode2` | GK konto 2 |
| ZavTrosProiz | Double | DA `finalProcessingCost` | proizvodna kalkulacija |
| CarStopa | Double | DA `customsRate` | customs |
| IDRaster | Long Integer | DA `rasterId` | RASTER — kopira se kao broj, Raster* tabele su na tvrdoj exclude listi |
| CarTarifa | Text(20) | DA `customsTariff` | customs |
| ZemljaPorekla | Text(20) | DA `originCountry` | customs |
| Polica | Text(20) | DA `shelf` | **Drift širine — SUŽENO:** kopija nvarchar(10) < BigBit Text(20) → rizik truncation pri 4.0 direktnom syncu |
| INONaziv | Text(50) | DA `foreignName` | |
| SifDob | Long Integer | DA `supplierId` | procurement (dobavljač → Komitenti) |
| WebOpis | Text(255) | DA `webDescription` | |
| OpisArtikla | Text(50) | DA `itemDescription` | |
| Tezina | Double | DA `weight` | |
| PDFLink | Text(255) | DA `pdfLink` | |
| ZaBrisanje | Boolean | DA `toDelete` | |
| Aktivan | Boolean | DA `active` | |
| CenaZaUpisUCen | Double | DA `priceToWritePricelist` | |
| IDMestoIzdavanja | Long Integer | DA `issuePlaceId` | FK visi — `MestaIzdavanja` ne postoji u kopiji ni u 2.0 |
| Proizvodjac | Text(50) | DA `manufacturer` | |
| HPS | Text(50) | DA `hps` | |
| PotpisArt | Text(50) | DA `signature` | |
| DatumIVremeArt | DateTime | DA `createdAt` | jedini datum na artiklu |
| KolUPak | Double | DA `quantityInPackage` | |
| KLRucProc | Currency | DA `manualMarkupPercent` | |
| OsnJM | Text(5) | DA `baseUnit` | |
| SlikaSimbolaLink | Text(250) | DA `symbolImageLink` | |
| MPKaloProc | Double | DA `retailLossPercent` | |
| WordLokacija | Text(250) | DA `wordLocation` | |
| VPKaloProc | Double | DA `wholesaleLossPercent` | |
| NeVodiZalihe | Boolean | DA `notStockTracked` | inventory |
| TezinaKg | Double | DA `weightKg` | |
| Zapremina | Double | DA `volume` | |
| Povrsina | Double | DA `area` | |
| RSort | Long Integer | DA `sortOrder` | |
| AkcijskiRabat | Double | DA `promotionDiscount` | komercijala |
| Napomena2 | Text(255) | DA `note2` | |
| IDKvalitetArtikla | Long Integer | DA `qualityTypeId` | **kod visi** — `R_KvalitetArtikla` nema ni u kopiji ni u 2.0 |
| Debljina | Double | DA `thickness` | |
| — (`BBSifra artikla`, samo kopija) | int NOT NULL | DA `externalItemId` | **čuva ORIGINALNU BigBit šifru artikla** — jedini most ka BigBit ID prostoru |

**Zaključak:** svih 67 BigBit kolona je u 2.0 — uključujući KOMPLETNA komercijalna polja (cene, rabati, GK konta, akciza, carinska stopa/tarifa, dobavljač). Rupa nije u kolonama nego u ID prostoru (v. §Drift) i u šifarnicima.

### 4. Prodavci → `Salesperson` (`salespeople`)

BigBit: **16** · kopija: **16** · mapirano **16/16**.

| BigBit kolona | Tip | Mapira se u 2.0? | Napomena |
|---|---|---|---|
| Sifra prodavca | Long Integer | DA `id` | PK |
| Prodavac | Text(50) | DA `name` | |
| Region | Long Integer | DA `region` | |
| ProcenatZaObracun | Double | DA `commissionPercent` | komercijala (provizija) |
| DeljivoUGrupi | Boolean | DA `splitInTeam` | |
| ImeProdavca | Text(30) | DA `firstName` | |
| BrLkProdavca | Text(20) | DA `idNumber` | |
| LogAcc | Text(50) | DA `loginAccount` | **Drift:** BigBit NOT NULL → kopija NULL |
| Password | Text(20) | DA `password` | ⚠ plain-text lozinka legacy sistema — kopira se u 2.0 cache; NE koristiti za auth, kandidat za izostavljanje |
| Aktivan | Boolean | DA `active` | |
| NefiskalniRN | Boolean | DA `nonFiscalWorkOrder` | |
| Storniranje | Boolean | DA `canCancel` | |
| PotpisSlika | Text(250) | DA `signatureImage` | |
| OznakaTima | Text(10) | DA `teamCode` | |
| Telefon | Text(20) | DA `phone` | |
| Email | Text(50) | DA `email` | |

### 5. Cenovnik → `PriceListEntry` (`price_list_entries`)

BigBit: **11** · kopija: **11** · mapirano **11/11**.

| BigBit kolona | Tip | Mapira se u 2.0? | Napomena |
|---|---|---|---|
| ID | Long Integer | DA `id` | PK |
| Sifra artikla | Long Integer | DA `itemId` | FK → `items` (u kopiji pokazuje na LOKALNU QBigTehn šifru, ne BigBit) |
| Vrsta dokumenta | Text(5) | DA `documentTypeId` | string kod; **nema FK** na `document_types` u 2.0 |
| Cena | Double | DA `price` | **Drift:** BigBit NOT NULL → kopija NULL; Float u 2.0 (nasleđe — BACKEND_RULES kaže novac=Decimal, ovde je izuzetak jer je cache) |
| Tarifa | Text(5) | DA `taxRateCode` | FK → `tax_rates.code` |
| CenaBezPDV | Currency | DA `priceWithoutVat` | Decimal(19,4) |
| Taksa | Double | DA `fee` | |
| Prn | Boolean | DA `print` | |
| CenaSaPDV | Currency | DA `priceWithVat` | Decimal(19,4) |
| CheckCenaSaPDV | Boolean | DA `checkPriceWithVat` | |
| ZakCen | Boolean | DA `isLocked` | |

### 6. Magacini → `Warehouse` (`warehouses`)

BigBit: **11** · kopija: **11** · mapirano **11/11**.

| BigBit kolona | Tip | Mapira se u 2.0? | Napomena |
|---|---|---|---|
| IDFirma | Long Integer | DA `companyId` | **Drift:** BigBit NOT NULL → kopija NULL |
| IDMagacin | Long Integer | DA `id` | PK |
| Magacin | Text(50) | DA `name` | |
| UlicaIBroj | Text(50) | DA `street` | |
| Mesto | Text(30) | DA `city` | |
| ProsecneCene | Boolean | DA `averagePrices` | inventory (metod cena) |
| VrstaMag | Text(5) | DA `warehouseType` | |
| KontoMag | Text(10) | DA `account` | GL konto magacina |
| ImeMagacionera | Text(30) | DA `managerName` | |
| BrLkMagacionera | Text(20) | DA `managerIdNumber` | |
| PotpisSlika | Text(250) | DA `signatureImagePath` | |

### 7. R_Tarife → `TaxRate` (`tax_rates`)

BigBit: **10** kolona, **PK = `Tarifa` (Text 5) — NEMA `ID`** · kopija: **11** (dodat surogat `ID` IDENTITY) · mapirano **11/11 iz kopije**.

| BigBit kolona | Tip | Mapira se u 2.0? | Napomena |
|---|---|---|---|
| — (`ID`, samo kopija) | int IDENTITY | DA `id` | **surogat ključ postoji SAMO u kopiji** — 2.0 `tax_rates.id` nije BigBit ključ |
| Tarifa | Text(5) | DA `code` | pravi (BigBit) ključ; u 2.0 `uq_tax_rates_code` |
| Osnovna stopa | Double | DA `baseRate` | PDV stopa |
| Zeleznica stopa | Double | DA `railwayRate` | istorijsko |
| Gradska stopa | Double | DA `cityRate` | istorijsko |
| Ratna stopa | Double | DA `warRate` | istorijsko |
| Posebna stopa | Double | DA `specialRate` | |
| Opis | Memo | DA `description` | |
| Vazi od | DateTime | DA `validFrom` | |
| Vazi do | DateTime | DA `validTo` | |
| PDVGrupa | Text(10) | DA `vatGroup` | SEF/tax |

### 8. R_Vrste dokumenata → `DocumentType` (`document_types`)

BigBit: **23** kolone, **PK = `Vrsta dokumenta` (Text 5) — NEMA `ID`** · kopija: **24** (dodat surogat `ID`) · mapirano **24/24**.

| BigBit kolona | Tip | Mapira se u 2.0? | Napomena |
|---|---|---|---|
| — (`ID`, samo kopija) | int IDENTITY | DA `id` | surogat samo u kopiji |
| Vrsta dokumenta | Text(5) | DA `code` | pravi ključ; ⚠ u 2.0 `code` **nema unique constraint** (za razliku od `tax_rates.code`) |
| Opis | Text(50) | DA `description` | |
| Ulazni | Boolean | DA `isInbound` | |
| Analiticki konto | Text(10) | DA `analyticalAccount` | **GL/finance** |
| Knjiziti analitiku | Boolean | DA `postAnalytical` | GL |
| Sema za kontiranje | Long Integer | DA `postingTemplate` | GL (šema kontiranja — sama šema NIJE sinkovana) |
| Knjiziti sintetiku | Boolean | DA `postSynthetic` | GL |
| Prodaja sa PPP | Boolean | DA `saleWithPpp` | tax |
| Prodaja sa PPU | Boolean | DA `saleWithPpu` | tax |
| KnjizitiTKZad | Boolean | DA `postRetailCharge` | trgovačka knjiga |
| KnjizitiTKRazd | Boolean | DA `postRetailDischarge` | trgovačka knjiga |
| TextZaReport | Text(50) | DA `reportText` | |
| KnjizitiUPDVEvidenciju | Boolean | DA `postInVatLedger` | PDV evidencija |
| KEPUDefZaduzenje | Text(30) | DA `kepuDefaultCharge` | KEPU |
| KEPUDefRazduzenje | Text(30) | DA `kepuDefaultDischarge` | KEPU |
| InterniDokument | Boolean | DA `isInternalDocument` | |
| NumeracijaOd | Long Integer | DA `numberingStart` | |
| KOTP | Boolean | DA `isFiscal` | |
| PrefiksBrojaDok | Text(5) | DA `documentNumberPrefix` | |
| IDMagacinZaVrstuDok | Long Integer | DA `defaultWarehouseId` | |
| KODJ | Boolean | DA `isDepartmental` | |
| FR | Boolean | DA `isFr` | |
| UticeNaZalihe | Boolean | DA `affectsStock` | inventory |

### 9–12. Šifarnici artikala — R_Grupa, R_Podgrupa, R_Poreklo, R_KvalitetArtikla — **RUPA**

Sve četiri tabele postoje u BigBit-u; prve tri postoje i u QBigTehn kopiji, ali **nijedna nije u
`sync-map.generated.ts` niti ima syncer** → 2.0 tabele `item_groups`/`item_subgroups`/`item_origins`
su **prazne** (modeli postoje u schema.prisma, nikad se ne pišu), a za `R_KvalitetArtikla` model ni ne postoji.

| BigBit kolona | Tip | Mapira se u 2.0? | Napomena |
|---|---|---|---|
| **R_Grupa.**Grupa | Text(10) | NE (`ItemGroup.code` čeka) | `Item.groupCode` ostaje kod bez naziva |
| R_Grupa.Opis | Text(50) | NE (`ItemGroup.description` čeka) | |
| **R_Podgrupa.**Podgrupa | Text(10) | NE (`ItemSubgroup.code` čeka) | |
| R_Podgrupa.Opis | Text(50) | NE (`ItemSubgroup.description` čeka) | |
| R_Podgrupa.GrupaVeza | Text(10) | NE (`ItemSubgroup.parentGroup` čeka) | hijerarhija grupa→podgrupa |
| **R_Poreklo.**Poreklo | Text(5) | NE (`ItemOrigin.code` čeka) | |
| R_Poreklo.Opis | Text(50) | NE (`ItemOrigin.description` čeka) | |
| R_Poreklo.PodgrupaVeza | Text(10) | NE (`ItemOrigin.subgroupCode` čeka) | |
| R_Poreklo.PopustProc | Currency | NE (`ItemOrigin.discountPercent` čeka) | **komercijalni popust po poreklu — bitan za 4.0 sales** |
| **R_KvalitetArtikla.**IDKvalitetArtikla | Long Integer | NE — nema modela | `Item.qualityTypeId` visi |
| R_KvalitetArtikla.KvalitetArtikal | Text(20) | NE — nema modela | **tabela NE POSTOJI ni u QBigTehn kopiji** → za 4.0 mora direktno iz BigBit-a |
| R_KvalitetArtikla.Opis | Text(20) | NE — nema modela | |

> Pažnja: `tR_Grupa` → `ProductionItemGroup` (`production_item_groups`) SE sinkuje, ali to je **zaseban
> QBigTehn proizvodni šifarnik grupa** (kolone `ID, Grupa, Opis`), ne komercijalna `R_Grupa`. Ne mešati.

---

### Šema-drift: BigBit original ≠ QBigTehn kopija (rizik za direktan BigBit sync u 4.0)

2.0 sync SELECT-i su pisani nad **kopijom**. Sledeće razlike znače da se isti SELECT-i **ne mogu uperiti u
BigBit original** bez prilagođavanja:

| # | Tabela | BigBit original | QBigTehn kopija | Posledica za 4.0 |
|---|---|---|---|---|
| 1 | **R_Artikli** | `Sifra artikla` = BigBit šifra | `Sifra artikla` = **lokalni IDENTITY kopije**; BigBit šifra je u dodatnoj koloni `BBSifra artikla` | **NAJVEĆI RIZIK.** 2.0 `items.id` živi u QBigTehn ID prostoru; sve interne FK veze (`price_list_entries.item_id`, MRP, robne stavke…) koriste taj prostor. Direktan BigBit sync mora ili remap preko `items.external_item_id` (= BigBit šifra) ili jednokratnu migraciju ključa. |
| 2 | R_Tarife | PK = `Tarifa`, nema `ID` | dodat surogat `ID` IDENTITY | 2.0 `tax_rates.id` ne postoji u BigBit-u — vezivati po `code` (unique postoji) |
| 3 | R_Vrste dokumenata | PK = `Vrsta dokumenta`, nema `ID` | dodat surogat `ID` | isto; uz to 2.0 `document_types.code` **nema unique** — dodati pre prevezivanja |
| 4 | Komitenti | 57 kolona (ima `KoristiPNBZadModel`) | 56 kolona (nema je) | kopija kasni za BigBit šemom; nova BigBit polja se NE pojavljuju sama u 2.0 |
| 5 | BBOdeljenja | `(OD, Naziv)` | `(OD, OznakaOD, OpisOD)` | sync mapa čita `OznakaOD/OpisOD` — na originalu bi pukla (kolone ne postoje) |
| 6 | BBOrgJedinice | `(OJ, NazivOJ)` | `(OJ, OznakaOJ, OpisOJ)` | isto |
| 7 | CFG_Global | `(Parametar, Vrednost, Tip, Opis)` — nema `IDFirma` | `IDFirma` postoji i deo je PK | composite ključ `(companyId, parameter)` u 2.0 nema pandan u originalu |
| 8 | R_KvalitetArtikla | postoji (3 kolone) | **ne postoji** | kopija nije potpuna — ima BigBit tabela koje uopšte nisu prenete |
| 9 | Nullability (masovno) | mnogi `NOT NULL` (npr. `Predmeti.DatumOtvaranja/Status/RokZavrsetka`, `Cenovnik.Cena`, `Magacini.IDFirma`, `Prodavci.LogAcc`) | relaksirano u `NULL` | 2.0 šema prati kopiju; direktan BigBit feed je stroži — mali rizik |
| 10 | Nullability (obrnuto) | `Komitenti.PIB` NULL-abilan | `PIB NOT NULL` | 2.0 `taxId` NOT NULL → BigBit red bez PIB-a bi pao/iskrivio se |
| 11 | Širine tekstova | `R_Artikli.BarKod` Text(20), `Polica` Text(20), `BBPravaPristupa.Vrednost` Text(30) | nvarchar(50), **nvarchar(10)** (suženo!), nvarchar(250) | `Polica` može da truncira BigBit vrednost; ostalo bezopasno |

### Svežina podataka — kako proveriti (upiti, ne izvršavati sada)

Lanac: **BigBit (Access)** → QMegaTeh skripte na ~10 min → **QBigTehn kopija (vasa-SQL)** → `POST /sync/run`
(**na dugme, nema cron-a**) → **2.0 Postgres**. Zaostajanje 2.0 = vreme od poslednjeg ručnog run-a; kursori i
logovi su u `bb_sync_state` / `bb_sync_log` (REST: `GET /sync/state`, `GET /sync/logs`).

Od 8 sinkovanih tabela **samo `Komitenti` ima watermark** (`PoslednjaIzmena`); ostale su full refresh —
za njih se svežina meri isključivo vremenom poslednjeg run-a + poređenjem broja redova.

MSSQL strana (sa ubuntusrv, 192.168.64.25:5765 je dostupan):

```sql
-- vasa-SQL / QBigTehn
SELECT COUNT(*) AS cnt, MAX([PoslednjaIzmena]) AS max_izmena FROM [dbo].[Komitenti];
SELECT COUNT(*) AS cnt, MAX([DatumIVremeArt]) AS max_unos   FROM [dbo].[R_Artikli];
SELECT COUNT(*) AS cnt, MAX([DatumIVreme])    AS max_unos   FROM [dbo].[Predmeti];
SELECT COUNT(*) AS cnt FROM [dbo].[Cenovnik];            -- nema datumske kolone
SELECT COUNT(*) AS cnt FROM [dbo].[Magacini];
SELECT COUNT(*) AS cnt FROM [dbo].[Prodavci];
SELECT COUNT(*) AS cnt FROM [dbo].[R_Tarife];
SELECT COUNT(*) AS cnt FROM [dbo].[R_Vrste dokumenata];
```

Postgres strana (2.0 prod, `docker exec servosync-pg …`):

```sql
SELECT count(*) AS cnt, max(updated_at) AS max_izmena FROM customers;
SELECT count(*) AS cnt, max(created_at) AS max_unos   FROM items;
SELECT count(*) AS cnt, max(created_at) AS max_unos   FROM projects;
SELECT count(*) FROM price_list_entries;
SELECT count(*) FROM warehouses;
SELECT count(*) FROM salespeople;
SELECT count(*) FROM tax_rates;
SELECT count(*) FROM document_types;
-- kada je sync poslednji put uspeo, po entitetu:
SELECT entity, last_success_sync_log_id FROM bb_sync_state ORDER BY entity;
SELECT * FROM bb_sync_log ORDER BY id DESC LIMIT 20;
```

Za tabele bez datumske kolone (Cenovnik, Magacini, Prodavci, R_Tarife, R_Vrste dokumenata) count nije dovoljan
dokaz identičnosti — po potrebi uporediti i checksum (MSSQL `CHECKSUM_AGG(BINARY_CHECKSUM(*))` vs Postgres
hash agregat po istim kolonama). **BigBit original ↔ kopija** se ne može proveriti SQL-om odavde (Access);
praktična provera je preko QMegaTeh log-a skripti ili jednokratnog BigBit exporta — do tada važi pretpostavka
„kopija kasni ≤10 min", uz izuzetke iz drift tabele (kolone koje skripte NE prenose kasne zauvek).

### Zaključak F1

1. **Za tehnologiju (2.0/3.0) sync je sadržajno DOVOLJAN:** svih 8 velikih matičnih tabela je 1:1 po
   kolonama (232 od 233 kolone), a tehnologiji trebaju imena, katalog brojevi i ID-jevi — sve je tu.
   Jedina vidljiva posledica rupe je UI: `Item.groupCode/subgroupCode/originCode/qualityTypeId` su kodovi
   bez naziva (šifarnici prazni).
2. **Za 4.0 komercijalu polja uglavnom NE fale u sinkovanim tabelama** — rabati, cenovnici, kreditni limiti,
   GK konta, PDV/akciza/carina, SEF polja (GLN, JBKJS, CRF) su VEĆ kopirani. Fale: (a) 4 šifarnika artikala
   (12 kolona, uklj. komercijalni `R_Poreklo.PopustProc`), (b) `Komitenti.KoristiPNBZadModel` (banking),
   (c) cele prateće tabele van sync mape: `KomitentiKontaktOsobe`, `MestaIsporuke`, `R_Artikli_BarKod`,
   `R_Artikli_Ino`, `MestaIzdavanja`, `PredmetiFaze/Def`, `PredmetiVrstaPosla` — to je posao 4.0 domena
   (masters/sales), ne krpljenje postojećeg sync-a.
3. **Pravi rizik za 4.0 nije pokrivenost polja nego ID prostor i šema-drift:** 2.0 živi na QBigTehn
   lokalnim šiframa artikala (`items.id`), BigBit šifra je samo u `items.external_item_id`; surogat ključevi
   tarifa/vrsta dokumenata postoje samo u kopiji; par tabela ima različite nazive kolona (BBOdeljenja/
   BBOrgJedinice) ili različit PK (CFG_Global). Direktan BigBit izvor (odluka §11.2a: EXPORT + UPSERT)
   mora da uključi mapiranje ključeva i mali sloj prevoda imena kolona — ne može se prosto preusmeriti
   postojeći SELECT.
4. **Preporuka (jeftino, odmah):** dodati 3 lagana syncera za `R_Grupa`/`R_Podgrupa`/`R_Poreklo` (modeli
   već postoje i prazni su), model + syncer za `R_KvalitetArtikla` odložiti do BigBit exporta (tabele nema
   u kopiji); dodati `@unique` na `document_types.code`; razmotriti izostavljanje `Prodavci.Password` iz
   sync-a (plain-text lozinke u cache-u).

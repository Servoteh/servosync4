## F3. Definitivni inventar — svih 207 tabela `BB_T_26` u tri kofe

> **Izvor:** `_analiza/bigbit/BB_T_26_schema.sql` (mdb-tools DDL, snapshot `BB_T_26_11-07-26.mdb`, ~358 MB).
> Verifikovano: `grep -c "CREATE TABLE"` = **207** — svaka tabela ispod je svrstana u tačno jednu kofu.
> Ukršteno sa: `backend/src/modules/sync/sync-map.generated.ts` (62 mapirana entiteta; iz BB_T_26 skupa
> njih **22** su već sinkovana), `table-ownership.ts`, ROADMAP §4.0 (redosled domena odozdo-naviše),
> klaster-analize A/B/C (`backend/docs/migration/BB_T_26*`), master plan `BB_T_26_ANALIZA_I_PLAN.md`.
> **Ispravke vlasnika ugrađene:** (1) BigBit `Reversi` = komercijalni revers robe → `sales`/4.0, NIJE
> magacin alata; (2) PDM je jedini izvor BOM-a — `SastavMaterijala`/`T_Rastavnice`/`T_Recepti` su
> BigBit-interne komercijalno-materijalne, bez dodira sa proizvodnim BOM-om; (3) MALOPRODAJA/POS/Raster/
> OTKUP/KASE/FP* = tvrda exclude-lista, ne kopira se uopšte.
>
> **Brojevi redova:** poznati su samo za tabele iz ranijih analiza (magacinski izvoz `BB_T_2x`); „—" =
> nije izvučen u ovom izvozu (za GK/PDV transakcione obime treba `mdb-export` count iz radne godišnje
> `.MDB` — vidi klaster C napomenu: ovaj snapshot je *eksterni magacinski*, finansijski core živi u
> godišnjoj bazi).

### F3.1 Kofa 1 — KEEP-SYNC (49 tabela): 4.0 aplikaciji trebaju ovi podaci, sinkuju se / kopiraju

Kriterijum: matični podaci i šifarnici (temelj svih faza), robna dokumenta kao feed (MRP/zalihe),
nabavka-uvid koji MRP već koristi/planira, i mali finansijsko-carinski šifarnici koje klaster C
preporučuje kao rani cache (Sync B). „✅ SYNCED" = već u `sync-map.generated.ts` danas.

| Tabela | Redova | Domen | Zašto |
|---|---:|---|---|
| Komitenti | 6.669 | masters | ✅ SYNCED → `Customer`/`customers` (57 kolona, watermark `PoslednjaIzmena`); ključ PIB/JBKJS/CRF za SEF |
| KomitentiKontaktOsobe | — | masters | 1:N kontakti komitenta (`IDKontaktOsobe`, `Sifra`→Komitenti, `KontaktDefault`); Faza 1 plana — child tabela, ne overlay |
| MestaIsporuke | — | masters/sales | 1:N mesta isporuke (`IDKomitent`, GLN, ruta/vozač); `Customer.invoicePerDeliveryAddress` flag postoji, adrese fale; Faza 1 |
| Predmeti | 7.736 | masters | ✅ SYNCED → `Project`/`projects`; `IDPredmet` = osovina 2.0↔4.0 (proizvodnja i komercijala dele ključ) |
| PredmetiFaze | — | masters | dnevnik faza predmeta (`IDPredmet`, `IDFazaPredmeta`, `DIVUnosa`) — workflow trag uz Predmete koji 4.0 preuzima |
| PredmetiFazeDef | — | masters | šifarnik faza predmeta (`IDFazaPredmeta`, `FazaPredmeta`) — lookup za PredmetiFaze |
| PredmetiVrstaPosla | — | masters | model `ProjectWorkType` POSTOJI, syncer fali → `Project.workTypeId` bez naziva; rupa u sync-u (Faza 0) |
| Prodavci | 80 | masters | ✅ SYNCED → `Salesperson`/`salespeople` (17 kolona 1:1) |
| R_Artikli | 91.199 | masters | ✅ SYNCED → `Item`/`items` (~68 kolona); najveća matična tabela |
| R_Artikli_BarKod | — | masters | multi-barkod po artiklu (`IDArtikal`, `BarKod`, `MultiFaktor`); `Item.barCode` je jedan — Faza 1 child tabela; veza na 2.0 scan/nalepnice |
| R_Artikli_Ino | — | masters/customs | ino naziv+JM po artiklu i jeziku (`IDJezik`, `InoNazivArt`) — obavezan za dvojezične carinske dokumente (doc 14) |
| R_Grupa | — | masters | model `ItemGroup` postoji, NIJE sinkovan → `Item.groupCode` bez naziva; Faza 0 (jeftin syncer) |
| R_Podgrupa | — | masters | model `ItemSubgroup` postoji, nije sinkovan; Faza 0 |
| R_Poreklo | — | masters | model `ItemOrigin` postoji, nije sinkovan; nosi i `PopustProc`; Faza 0 |
| R_KvalitetArtikla | — | masters | `Item.qualityTypeId` visi u prazno — treba NOV model (≠ `PartQualityType`/tVrsteKvalitetaDelova!); Faza 0 |
| MestaIzdavanja | — | masters | šifarnik (`IDMestoIzdavanja`) — cilj za `Item.issuePlaceId` koji danas referiše prazno |
| R_Tarife | — | tax-šifarnik | ✅ SYNCED → `TaxRate`/`tax_rates`; effective-dated (`Vazi od/do`) — temelj 4.0 `tax` |
| R_Vrste dokumenata | — | masters/finance | ✅ SYNCED → `DocumentType` (24 kol.); nosi `Sema za kontiranje`/`UticeNaZalihe`/KEPU flagove — ključ posting pravila |
| Cenovnik | 82.855 | masters/pricing | ✅ SYNCED → `PriceListEntry`; cena po (artikal × vrsta dok.), Decimal ispravno |
| CEN_DozvoljeniCenovnici | — | masters/pricing | šifarnik dozvoljenih cenovnika (`CenVrstaDok`, `CenSaPDV`, `Zakljucan`) — mali lookup uz Cenovnik |
| Magacini | 3 | masters | ✅ SYNCED → `Warehouse`/`warehouses` |
| Nalepnice | — | masters/štampa | ✅ SYNCED → `Label`/`labels`; podaci za nalepnice artikala (BarKod, VP/MP cena, KolUPak) |
| T_Robna dokumenta | — (najveća) | inventory-feed | ✅ SYNCED → `GoodsDocument` (63 kolone) — cache/feed za MRP zalihe; nosi i landed-cost kolone (`Carina`/`Spedicija`/`OstaliZavTros`) |
| T_Robne stavke | — (najveća) | inventory-feed | ✅ SYNCED → `GoodsDocumentItem`; `ID_PO`/`IDStavkeTrebovanja`/`IDPlanStavka` zatvaraju krug plan→nabavka→ulaz; ⚠️ cene Float→Decimal pri prelasku u vlasništvo |
| ZahteviZaNabavku | 3.990 | procurement-uvid | MRP spec §1 već planira `purchase_requests` + ekran; preduslov MRP toka (potreba→zahtev) |
| SpecifikacijaZahtevaNabavke | — | procurement-uvid | stavke zahteva; `IDPlanStavka` = spona MRP plan → nabavka; `KreirajUpit` flag |
| DobavljaciZaArtikal | — | procurement/masters | `Primarni` + `VremeIsporuke` (lead time) — logika VEĆ ušla u `MrpDemandItem.supplierId` (MRP §3.5) |
| T_Statusi | — | masters-šifarnik | generički rečnik statusa (`IDStatus`+`Tabela`) — lookup koji KEEP nabavka-tabele referišu (`IDStatus`); prenosi se kao editabilan šifarnik, ne enum |
| T_PlaniranjeStavkeTipDogadjaja | — | planiranje/MRP | šifarnik tipova događaja plana (naručeno/stiglo…) — lookup za Tok |
| T_PlaniranjeStavkeTok | — | planiranje/MRP | event-log po stavci plana (`IDPlanStavka`, `IDRobnaStavka`, `Kolicina`, `DatumDogadjaja`, watermark `PoslednjaIzmena`) — spona plan↔robni ulaz koju MRP praćenje treba |
| CarinskeTarife | — | customs-šifarnik | `TarifniBroj`→`CarinskaStopa`; doc 14: tarifa „danas nedostaje u ERP-u, treba je uvesti" — jeftin, hrani normativ za carinu |
| Kontni plan | — | finance-šifarnik | radni kontni plan (`Konto`, analitika flag, `InoKonto`); klaster C preporuka: RANO kao cache (mali, retko se menja) |
| KontniPlan_STD | — | finance-šifarnik | standardni/šablonski kontni plan — ista struktura, rani cache |
| InoKontniPlan | — | finance-šifarnik | paralelni ino/IFRS kontni plan (`InoKonto`) — rani cache |
| Vrsta naloga | — | finance-šifarnik | model `OrderType` POSTOJI u 2.0, syncer fali (prazan stub) — najjeftinije zatvaranje rupe |
| VrstePlacanja | — | banking-šifarnik | šifarnik načina plaćanja (2 kolone) — rani cache po klasteru C |
| UplatniRacuni | — | banking-šifarnik | ✅ SYNCED → `PaymentAccount` (ali iz QBigTehn kopije stiže PRAZNO — puni se tek direktnim BigBit izvorom) |
| INOUplatniRacuni | — | banking-šifarnik | ino računi (Cor/Ben banka, SWIFT) — obavezni za INO avansni tok nabavke (IBAN/SWIFT na proformi) |
| Kursna lista | — | banking-šifarnik | kurs po (Datum×IDBanka×DevValuta) — klaster C „kandidat #1" za rani read-only cache; hrani devizna dokumenta i kursne razlike |
| Pozicije | 65 | finance-šifarnik | mesto troška (`Pozicija` Text PK) — referiše ga `T_Glavna knjiga.Pozicija`; ≠ 2.0 `Position` (tPozicije)! |
| Vrste sifara | — | masters-šifarnik | ✅ SYNCED → `CodeType` (razdvaja kupca/dobavljača kroz `Customer.codeTypeCode`) |
| BBDefUser | — | config | ✅ SYNCED → `DefaultUser` (default godina/OJ/OD po korisniku) |
| BBOrgJedinice | — | config | ✅ SYNCED → `OrganizationalUnit`; ⚠️ šema-drift: BB_T_26 ima `(OJ, NazivOJ)`, sync-mapa očekuje `Oznaka/Opis` — remapirati pre direktnog BigBit izvora |
| BBOdeljenja | — | config | ✅ SYNCED → `Department`; isti drift (`(OD, Naziv)` vs `OznakaOD/OpisOD`) |
| BBPravaPristupa | — | config/RBAC | ✅ SYNCED → `AccessRight`; UI-nivo prava (forma×kontrola×Visible/Locked/Enabled) — izvor za inventar permisija 2.0 RBAC-a, ne portuje se 1:1 |
| CFG_Global | — | config | ✅ SYNCED → `GlobalConfig`; ⚠️ BB_T_26 varijanta NEMA `IDFirma` kolonu koju sync-mapa mapira — drift za validaciju |
| Parametri za rad | — | config | ✅ SYNCED → `WorkParameter` (brojači/prefiksi faktura po korisniku) |
| Radni fajlovi | — | config | ✅ SYNCED → `Company` (firma, naziv baze, logo, mesto) — matični podaci firme; ⚠️ granični slučaj F3.5 #1 |
| _Rev | — | config | ✅ SYNCED (revizija šeme `Ver`/`DIV`) — koristi se za praćenje verzije legacy šeme |

### F3.2 Kofa 2 — EXCLUDE-TVRDO (55 tabela): NIKAD se ne kopira, deny-lista u dizajnu sync-a

Kriterijum: (a) tvrda lista vlasnika — maloprodaja/POS/Raster/OTKUP/KASE/fiskalni; (b) očigledan
tehnički balast — kopije, tmp, replikaciona infrastruktura mosta koji se gasi, Access-specifična
UI/report konfiguracija, slike-linkovi, tuđi vertikali. Ove tabele se u sync registru **nikad ne
registruju** (deny-lista) i ne ulaze ni u jednokratnu kopiju.

| Tabela | Redova | Domen | Zašto |
|---|---:|---|---|
| T_MPDokumenta | — | POS/MP | tvrda lista — maloprodajni/POS račun (IDKasa, Smena, BrojStola, StampanFiskalno) |
| T_MPStavke | — | POS/MP | tvrda lista — stavke POS računa |
| T_MPStavke_Obrisane | — | POS/MP | tvrda lista — audit obrisanih POS stavki |
| T_MPDokumenta_Placanja | — | POS/MP | tvrda lista — načini plaćanja POS dokumenta (kartice/čekovi) |
| MPStavkeNivelacije | — | POS/MP | tvrda lista — maloprodajna nivelacija (stara↔nova MP cena) |
| T_Knjiga KEPU_MP | — | POS/MP | tvrda lista — KEPU knjiga maloprodaje po prodavnici |
| KASE | — | POS | tvrda lista — POS kase + SHUTTLE konfiguracija (`Baza`, `SHUTTLE`, status slanja/prijema) |
| BrojStolaTuraKartica | — | POS | ugostiteljski POS (broj stola/tura/kartica) — tuđi vertikal |
| ArtikliNaziviPanela | — | POS | touch-panel naslovi po prodavnici (Panel*) |
| ArtikliPanelDef | — | POS | definicija dugmadi POS panela (FormaIme, DugmeIme) |
| FP_Artikli | — | fiskalni | PLU artikli za fiskalni printer |
| FP_ZahtevZaStampu | — | fiskalni | red zahteva za fiskalnu štampu po kasi |
| FP550_CMD | — | fiskalni | komandni set FP-550 printera (sintaksa/odgovori) |
| FP550_IzvrseneKomande | — | fiskalni | log izvršenih FP komandi |
| FP550_Status | — | fiskalni | status-bitovi FP-550 |
| RasterDefZag | — | raster/MP | tvrda lista — definicija raster matrice (veličine×boje, tekstil/obuća) |
| RasterDefKolona | — | raster/MP | tvrda lista — kolone rastera |
| RasterDefVrsta | — | raster/MP | tvrda lista — vrste rastera |
| RasterDefStavkeKolona | — | raster/MP | tvrda lista — pripadnost kolona rasteru |
| RasterDefStavkeVrsta | — | raster/MP | tvrda lista — pripadnost vrsta rasteru |
| RasterStavke | — | raster/MP | tvrda lista — količine po ćeliji za robne stavke |
| RasterMPStavke | — | raster/MP | tvrda lista — količine po ćeliji za MP stavke |
| RasterTrebovanjaStavke | — | raster/MP | tvrda lista — količine po ćeliji za trebovanja |
| OTKUP_Dokumenta | — | otkup | tvrda lista — otkup (mlekarski vertikal, PeriodOd/Do) |
| OTKUP_Stavke | — | otkup | tvrda lista — stavke otkupa (PMM/PSM/SomatskeCelije/Kiselost = mleko; tuđi klijent) |
| Addinol | — | bloat | uvezen cenovnik dobavljača Addinol (EUR/100KG, EUR/100L) — jednokratni radni import, ne šema |
| KOPIJA Robna dokumenta | — | bloat | ručna kopija robnih dokumenata (stara struktura, 22 kolone) — mrtav ostatak |
| KOPIJA Robne stavke | — | bloat | ručna kopija robnih stavki — mrtav ostatak |
| R_Artikli_TMP | — | tmp | privremena kopija R_Artikli (54 kolone) — radni ostatak |
| T_tmp | — | tmp | jedna kolona `NoviAutoNumber` — pomoćni brojač |
| tmp_T_KontroleNaFormi | — | tmp | snimak TabOrder-a Access kontrola po formi — čist UI alat |
| TMP_ZaLink | — | tmp | privremeni linkovi slika (LinkSlika/Poreklo/Grupa) |
| OP_ModleID | — | tmp | pomoćna selekcija (`IDDok`, `DoIt`) za modalni ekran porudžbenica |
| tImportLog | — | bloat | log Excel importa (ExcelRed, NazivFajla, Poruka) — istorijski radni log |
| BBS_Indexi | — | BBS-interno | BigBit sistemski katalog indeksa (TableName/IndexExpr) |
| BBS_SveTabele | — | BBS-interno | BigBit sistemski spisak tabela (`ZaBrisanje`, `BrojSlogova`) — održavanje .mdb |
| ODBC_Synch | — | sync-infra | konfiguracija starog „Preuzmi iz BB" ODBC mosta (MasterTableName, SQLText, DoIt) — most se gasi, konfiguracija se NE prenosi |
| SYNCH_Cenovnik | — | sync-infra | replikaciona pomoćna kopija cenovnika (za kase/SHUTTLE) |
| SYNCH_R_Poreklo | — | sync-infra | replikaciona pomoćna kopija porekla |
| ZaSHUTTLE_Info | — | sync-infra | log slanja/prijema SHUTTLE paketa ka kasama |
| ZaSHUTTLE_Status | — | sync-infra | checkbox-status koje tabele idu u SHUTTLE (Komitenti/RobnaDokumenta/GlavnaKnjiga…) |
| Semafor | — | infra | mutex uređaja (`Uredjaj`, `Zauzet`) — zamenjuje ga aplikativno zaključavanje, klaster C: ne migrira se |
| GrupeSlike | — | slike | linkovi slika po grupi artikala (LinkSlika na disk putanju) |
| PodgrupeSlike | — | slike | linkovi slika po podgrupi |
| ArtikliSlike | — | slike | linkovi slika po artiklu (legacy putanje na disku) |
| Slicice | — | slike | OLE sličice u bazi — Access embed |
| APVP_CTKolone | — | report-config | definicija crosstab kolona Access izveštaja (VrstaDokumenta×VrstaNaloga) — izveštaji se ne portuju 1:1 (496 izveštaja → trijaža top ~30) |
| APOP_CTKolone | — | report-config | crosstab kolone „analitički pregled otvorenih pozicija" po komitentu — isto |
| ER_DokZaExport_MOD | — | report-config | mapiranje report→format za export dokumenata (ReportName/FormatType) — Access-specifično |
| LevelVrsteDok | — | report-config | mapiranje `Level`→tabela→tekst na reportu — legacy status-UI; koncept Level se prenosi kao status String, ne ova tabela |
| NalepniceNNID | — | print-pomoćna | selekcija stavki za štampu nalepnica (`IDStavke`, `IDFirma`) — privremeni red za štampu |
| Operateri | — | bloat/security | operateri BigBit-a sa `pwd` u čistom tekstu — mrtvi nalozi, 2.0 ima svoj auth (⚠️ granični F3.5 #2) |
| CSVExport_Grupa | — | export-config | filter grupa za CSV izvoz — jednokratni alat |
| CSVExport_Poreklo | — | export-config | filter porekla za CSV izvoz |
| CSVExport_Podgrupa | — | export-config | filter podgrupa za CSV izvoz |

### F3.3 Kofa 3 — ODLOŽI-4.0 (103 tabele): trebaju, ali tek u kasnijim fazama 4.0

Kriterijum: transakcioni i regulatorni domeni koje BigBit danas radi pouzdano i koji NISU preduslov
ranijih faza (ROADMAP: 4.0 nema rok, ide trigerima; redosled masters → tax/GL → inventory → sales+sef
→ banking → procurement+customs). Struktura je poznata iz ovog DDL-a; podaci ostaju u BigBit-u do
odgovarajuće faze. ⚠️ = granični slučaj u F3.5.

| Tabela | Redova | Domen | Zašto |
|---|---:|---|---|
| T_Nalozi | — | finance/GL | zaglavlje naloga za knjiženje (temeljnica; `Vrsta naloga`, `Level`, `Godina`) — jezgro posting engine-a, faza GL |
| T_Glavna knjiga | — | finance/GL | stavke GK (Konto/Analitika/Duguje/Potrazuje/Dev*, poreklo IDDokIzRobnog/Usluga/MP) — najveća transakciona; čeka Korak 0 (Access upiti) |
| T_GrkZag | — | finance/GL | zaglavlje grupnog knjiženja/rekapitulacije |
| T_GrkStavke | — | finance/GL | stavke rekapitulacije → `IDStavkeIzGK` |
| T_GK_IZV_Stavke | — | finance/izveštaji | definicije redova bilansa/ZR (`IZV`, `Formula`) — trijaža, ne migrira se 1:1 |
| Sema za kontiranje | — | finance/posting | zaglavlje šeme automatskog kontiranja po vrsti naloga — pravila su u Access imenovanim upitima (Korak 0 preduslov) |
| Stavke seme za kontiranje | — | finance/posting | redovi šeme (`Konto`, `DefDug`/`DefPot` izrazi, `KngSifra_2`) — posting-rules-as-data |
| KNG_Artikli | — | finance/posting | ⚠️ knjigovodstvene šifre artikala (KngSifra→Cena) koje šeme kontiranja referišu — uz šeme, faza GL |
| KNG_Artikli_2 | — | finance/posting | ⚠️ drugi set KNG šifara (`KngSifra_2` iz Stavki seme) |
| ProdavciZaGK | — | finance/GL | veza prodavac↔GK stavka (provizije/izveštaji po prodavcu) |
| PSF_AnalitickaKonta_T | — | finance/AR-AP | ⚠️ konfiguracija analitičkih konta za saldo/otvorene stavke (`DinSaldo`/`DevSaldo`/`OTST`) — IOS/otvorene stavke |
| T_PK1 | — | finance/tax | ⚠️ obrazac PK-1 (promet, RuC, obračunati/prethodni PDV po knjiženju; ima `IDPazar`/MP veze — ako je čisto MP → prekvalifikovati u EXCLUDE) |
| T_OS_Sredstva | — | finance/OS | registar osnovnih sredstava (Inventarni broj, Stopa otpisa, AmGrupa) — izolovan pod-modul, kasna faza |
| T_OS_Stavke | — | finance/OS | kretanja/amortizacija po sredstvu (+ poreska amortizacija PorAm*) |
| T_PDV_IF | — | tax/KIF | registar izlaznih faktura po stopama (osnovica/PDV viša-niža-nula, poreklo dokumenta) |
| T_PDV_UF | — | tax/KUF | registar ulaznih faktura (+ poljoprivredna stopa, NabVredVanPDV) |
| T_PDV_GK | — | tax | PDV vezan za ručne GK stavke (`StavkaID`→GK, PDVEvidencija/Stopa/Osnovica) |
| PDV_Knjige | — | tax-šifarnik | definicija PDV evidencija (AOP mapiranje, UF flag) |
| PDV_Knjige_DefKolona | — | tax-šifarnik | kolone po knjizi (IDKnjiga×IDKolona) |
| PDV_Kolone | — | tax-šifarnik | definicija PDV kolona (`AOP_PPPDV`) |
| PDV_PPPDV | — | tax | podaci PPPDV prijave (svi AOP totali po stopama, period, PIB, poreski savetnik) |
| PDV_IF_PU_MAP | — | tax/sef | mapiranje vrste dokumenta → kolona PU/SEF (izlaz) — za pojedinačnu/zbirnu evidenciju |
| PDV_UF_PU_MAP | — | tax/sef | isto za ulaz |
| PDV_SemeKontaZaKnjizenje | — | tax/posting | konto → PDV prepoznavanje pri knjiženju (`PDVStopa`, osnovica/iznos flagovi, `AOP_POPDV`) |
| POPDV_SemeKontaZaKnjizenje | — | tax/POPDV | konto → POPDV kolone (`K1Def`–`K4Def`) |
| T_POPDV_GK | — | tax/POPDV | POPDV iznosi po GK stavci (`PDVOznaka`, `K1Iznos`–`K4Iznos`) |
| T_POPDV_EvidentiranePrijave_Zag | — | tax/POPDV | zaglavlje evidentirane POPDV prijave (izmena/storno lanac) — dokaz da skladište POPDV JESTE u BigBit-u (logika možda u eksternoj .mdb — proveriti) |
| T_POPDV_EvidentiranePrijave_Stavke | — | tax/POPDV | stavke prijave po sekcijama/kolonama (K1–K4 Val/Def/AOP) |
| T_Knjiga KEPU | — | tax/inventory | KEPU knjiga veleprodaje po magacinu (zaduženje/razduženje) — zakonska knjiga, hrane je robna dokumenta+GK |
| T_Trgovacka knjiga | — | tax/inventory | ⚠️ trgovačka knjiga — ima `IDProdavnica`; ako se vodi samo za maloprodaju → prekvalifikovati u EXCLUDE |
| T_AVR_Roba | — | tax/avansi | rekapitulacija avansnih računa — roba (iskorišćeni iznosi, `ID_PO` oslobođenje) — ROADMAP tok C |
| T_AVR_Usluge | — | tax/avansi | isto za usluge — ROADMAP tok B (avansni račun = 0 na SEF) |
| Virmani | — | banking | nalozi za plaćanje — state machine (PNB moduli MOD97/11, `IDNaTeret/UKorist`, veze na robno/GK) |
| Depoziti | — | banking | ⚠️ depoziti/avansni saldo komitenta — ima POS veze (`IDProdavnica`/`IDKasa`) ali i komitent-saldo; proveriti realnu upotrebu |
| KamataRucno | — | banking/kamata | zaglavlje ručnog obračuna kamate |
| KamataStavkeDetaljno | — | banking/kamata | detaljne stavke obračuna (koeficijent, suma za kamatu) — bez PK! |
| KamataVrsteStopa | — | banking/kamata | vrste kamatnih stopa |
| KamatneStope | — | banking/kamata | effective-dated stope (`OdDatumaStope`, `ZaDana`) — konformna kamata 🔴 |
| OK_Zag | — | banking/kamata | zaglavlje obračuna kamate vezano za GK (`ZaKonto`, `IDNalogGK`, `IDStavkeGK`, serija) |
| OK_Stavke | — | banking/kamata | stavke obračuna (dug/potraž/saldo/iznos kamate po dokumentu) |
| OK_Stope | — | banking/kamata | stope po vrsti (effective-dated) |
| OK_VrsteStopa | — | banking/kamata | šifarnik vrsta stopa |
| OK_VrsteObracuna | — | banking/kamata | šifarnik vrsta obračuna |
| ZahteviZaPonude | — | procurement | RFQ zaglavlje (rok za ponudu, veze na profakturu/uslugu, `IDStatus`) — pun RFQ→PO tok je kasna faza |
| T_UpitDobavljacu | — | procurement | upit konkretnom dobavljaču (`Poslato`, `PrihvacenaPonudaDok`, `IDTrebVeza`) |
| T_UpitDobavljacu Stavke | — | procurement | stavke upita (`TrebKol`, `RokZaIsporuku`, `PrihvacenaPonuda` po stavci) |
| OP_Dokumenta | — | procurement | porudžbenica dobavljaču (PurchaseOrder; `Cenovnik`, `BrojIsporuke`, `Zakljucano`) — 3-way match nosilac |
| OP_Stavke | — | procurement | stavke PO: `NarucenaKolicina`/`OtpremljenaKolicina`/`IsporucenaKolicina` (parcijalne isporuke) |
| T_Trebovanja | — | procurement/inventory | trebovanja (interni zahtev za materijalom; `VrstaTreb`, `IDUpita`, samoreferenca `IDTrebVeza`) — spona MRP→izdavanje |
| T_Trebovanja stavke | — | procurement/inventory | stavke trebovanja (ZaliheKol/TrebKol/IsporucenaKolicina, datumi isporuke) |
| T_TrebovanjaPratecaDok | — | procurement | prilozi trebovanja (Link) |
| AvUplateTrebovanja | — | procurement | avansne uplate po trebovanju (`DatumDospeca`, `Placeno`) — avansni tok nabavke |
| T_Trebovanja_ERNabavka | — | procurement/sef | spona trebovanje ↔ SEF ulazna faktura (`PurchaseInvoiceID`) |
| CarMagDok | — | customs | carinski magacinski dokument (JCI, kontrolnik, transport do granice/u zemlji, koleta, bruto/neto, paritet, LC broj) — landed cost ulazi; 🔴 ključ raspodele nedokumentovan |
| CarMagStavke | — | customs | stavke carinjenja (`CarTarifniBroj`, RedBrNaimenovanja, ArtBruto/Neto/M3, `InoNazivArt`) |
| T_ER_DokumentaNabavke | — | sef | SEF ulazne fakture (inbox nabavke) — auto-prijem ulazne fakture u zalihe je deo sales+sef faze |
| T_ER_StatusDokumenata | — | sef | statusi SEF dokumenata (workflow log) |
| ER_SifrePoreskogOslobadjanja | — | sef/tax-šifarnik | zvanične šifre poreskog oslobođenja (Zakon/Član/Stav/Tačka, VaziOd/Do) — može se re-seedovati i sa SEF API-ja |
| ER_KategorijePO | — | sef/tax-šifarnik | kategorije poreskog oslobođenja (S20/Z…) |
| EXT_RobnaDokumenta | — | sef/sales | ⚠️ dodatna polja robnih dokumenata za eFakturu/EDI (BrojNarudzbenice/Otpremnice, `EdiType`, `Storno`) — SEF traži broj narudžbenice |
| EXT_Dokumenta_USL | — | sef/sales | ⚠️ isto za usluge (+ BrojUgovora/DatumUgovora) |
| T_Profakture | — | sales | profakture/ponude (struktura kao robno; `Status`, `Level`) — tok A (PON/PROF) |
| T_Profakture stavke | — | sales | stavke profakture (pun cenovni sloj, rabati, neoporezivi deo) |
| T_Usluge dokumenta | — | sales | dokumenti usluga (IFUSL; `Zapisnik` memo umesto otpremnice — ROADMAP tok B) |
| T_Usluge stavke | — | sales | stavke usluga (`Tarifa usluga`, `IDRazlogOslobadjanja`) |
| T_Usluge Servis | — | sales/servis | ⚠️ servisni rad po RN i radniku (`IDRadniNalog`→BigBit RadniNalozi, `IDRadnik`→BigBit tRadnici) — vezano za odluku o BigBit RN |
| T_UslugeDok_PratecaDok | — | sales | prilozi uz dokument usluge (Link, RedBroj) |
| T_Usluge_PratecaDok | — | sales | drugi set priloga usluga (istorijska dupla tabela) |
| Rabati | — | sales/pricing | rabat po komitentu × grupi (`RabatProc`, `ExtraRabatProc`) |
| RabatiPoArt | — | sales/pricing | rabat po komitentu × artiklu, vremenski ograničen (OdDatuma/DoDatuma) |
| Akcije | — | sales/pricing | akcije (aktivna/neaktivna) |
| AkcijeArtikli | — | sales/pricing | artikli u akciji sa akcijskim rabatom |
| Reversi | 135 | sales | **komercijalni revers robe komitentu** (ispravka #1 — NIJE magacin alata; taj je 1.0 `rev_*`/sy15); marginalan obim |
| ReversiStavke | 144 | sales | stavke reversa (`Razduzio`, `Datum razduzenja`) |
| Posete | — | sales/CRM | ⚠️ posete prodavaca kupcima (Memo, KljucnaRec) — proveriti da li Servoteh uopšte koristi |
| T_Izvestaj | — | sales/CRM | ⚠️ izveštaj o poseti komitentu (prodavac, zaključano) |
| T_IzvestajStavke | — | sales/CRM | ⚠️ stavke izveštaja (kontakt osoba, od-do vremena, komentar) |
| T_SerijeStatusa | — | sales/dispatch | serije statusa isporuke (PrimioFakturu/UtovarioUVozilo/Isporuceno/PripremioRobu) — logistika otpreme |
| T_StavkeSerijeStatusa | — | sales/dispatch | veza serije statusa ↔ dokument |
| T_StatusDokumenata | — | sales/dispatch | status otpreme po pojedinačnom dokumentu (iste kolone kao serija) |
| V_Dokumenta | — | sales/dispatch | ⚠️ paralelni dokument vezan na robni (`IDDokRobno`; nosi i Carina/Spedicija/OstaliZavTros) — namena nejasna, potvrditi upotrebu |
| V_Stavke | — | sales/dispatch | ⚠️ stavke uz V_Dokumenta (KolicinaPoFakturi, `RokTrajanja`) |
| UI_Stavke | — | sales/dispatch | ⚠️ utovar/istovar po paketu/paleti (`UTKolicina`/`ISKolicina`, PaketBroj/PaletaBroj) |
| DExp_KutBarKod | — | sales/dispatch | ⚠️ barkodovi kutija po dokumentu (paleta/paket) — verovatno EDI/kupac-specifično pakovanje |
| Stavke nivelacije | — | inventory | VP nivelacija (stara↔nova nabavna/ZT/VP/MP/tarifa/akciza po artiklu i magacinu) — ROADMAP §4 eksplicitno u `inventory` |
| T_Popis zaglavlja | — | inventory | popis/inventura zaglavlje (veza na robni dokument knjiženja popisa) |
| T_Popis stavke | — | inventory | stavke popisa (`KolKng` vs `KolPop` → manjak/višak) |
| T_MagStavke | — | inventory | komadna/dimenziona evidencija (`IDVezaUlazaIzlaza`, Duzina/Sirina/Kutija — ploče) — 🔴 ROADMAP pravilo, gradi se u fazi `inventory` |
| T_MagDok | — | inventory | nalog magacinu / interni pokret (izdavanje materijala u proizvodnju) — MRP spec ga pominje kao ciljni tok |
| T_MagVrsteDokumenata | — | inventory-šifarnik | vrste magacinskih naloga (2 kolone) |
| T_MagProizvodjaci | — | inventory-šifarnik | šifarnik proizvođača za komadnu evidenciju |
| T_Proizvodnja | — | inventory/costing | proizvodni robno-knjigovodstveni dokument (materijali→gotov proizvod; veze na fakture/trebovanja) — ≠ 2.0 shop-floor |
| T_Proizvodnja stavke | — | inventory/costing | stavke proizvodnje (VP/MP cene, status) |
| T_ProizvodnjaStavkeNormativi | — | inventory/costing | normativ po stavci (`UtrosenaKolicina`, `UtrosenoVreme`, `NabavnaCena`) — production costing |
| T_Rastavnice | — | inventory/costing | rastavnica (OdSifArt→DobijaSeSifArt, kroj/prerada) — BigBit-interna, NE dira PDM BOM (ispravka #2) |
| T_Recepti | — | inventory/costing | recept/normativ artikal-nivo (ZaSifruArtikla←TrebSifraArtikla) — BigBit-interna, NE dira PDM BOM (ispravka #2) |
| SastavMaterijala | — | inventory/costing | ⚠️ 5-slot sastav (KatBrZaSastav, `Sl1..Sl5`) — BigBit-interna beleška; šta su Sl1..Sl5 → potvrda pre bilo kakve kopije |
| StvarniUtrosakSirovina | — | inventory/costing | stvarno utrošena sirovina po BigBit RN (kolicina×cena) — materijalni trošak proizvodnje |
| ProduktObrade | — | inventory/costing | proizvod obrade po BigBit RN (`IDArtikal`, `Kolicina`, `Cena`) — izlazna strana costing lanca |
| RadniNalozi | 2.588 | inventory/servis | ⚠️ BigBit komercijalno-servisni RN (vozilska polja RegBroj/BrojSasije/BrojMotora) — TREĆI homonim; otvorena odluka #2 (scope 4.0 ili van) |
| tRadnici | 123 | masters/servis | ⚠️ BigBit-ova kopija radnika (bez `PasswordRadnika`) — homonim; služi samo za razrešenje FK `T_Usluge Servis.IDRadnik`; mapira se na postojeće 2.0 `workers`, ne sinkuje zasebno |
| T_Obelezja_Def | — | masters-ext | ⚠️ EAV definicije dodatnih obeležja po tabeli (TipVrednosti, Sekcija) — proveriti šta stvarno sadrži |
| T_Obelezja_Val | — | masters-ext | ⚠️ EAV vrednosti (`Tabela`+`PKIzTabele`+`Obelezje`→`Vrednost`) — može nositi realne matične atribute |

### F3.4 Brojčani rezime

| Kofa | Tabela | % od 207 | Od toga već sinkovano u 2.0 |
|---|---:|---:|---:|
| **KEEP-SYNC** | **49** | 23,7% | 22 (✅ u `sync-map.generated.ts`) + 5 sa gotovim modelom bez syncera (R_Grupa, R_Podgrupa, R_Poreklo, PredmetiVrstaPosla, Vrsta naloga) |
| **EXCLUDE-TVRDO** | **55** | 26,6% | 0 (deny-lista — nikad se ne registruju u sync) |
| **ODLOŽI-4.0** | **103** | 49,8% | 0 (struktura poznata iz DDL-a, podaci ostaju u BigBit-u do faze) |
| **Ukupno** | **207** | 100% | |

Presek EXCLUDE kofe: 25 tabela je tvrda lista vlasnika (MP/POS/KASE/paneli 10 + Raster 8 + OTKUP 2 +
fiskalni FP* 5), 30 je tehnički balast (tmp/kopije 7, sync/SHUTTLE/Semafor infra 6, report/export
config 7, slike 4, BBS 2, ostalo — Addinol/tImportLog/NalepniceNNID/Operateri 4). ODLOŽI kofa po
domenima: finance/GL+OS 14, tax/POPDV/KEPU/AVR 18, banking/kamata 11, procurement/trebovanja 10,
customs 2, sef 6, sales/CRM/dispatch 23, inventory/costing/BigBit-proizvodnja 16, masters-ext/homonimi
(tRadnici, T_Obelezja_Def/_Val) 3.

### F3.5 Granični slučajevi — za potvrdu Nenada (redosled po važnosti)

1. **`Radni fajlovi` — KEEP, iako je pomenut u bloat listi.** Već je sinkovan kao `Company`
   (`sync-map` red 3404) i nosi matične podatke firme (naziv, logo, mesto) koje 2.0 koristi. Predlog:
   ostaje KEEP; potvrditi da je pominjanje u bloat listi bilo omaškom (ime zvuči kao radni fajl, a nije).
2. **`Operateri` → EXCLUDE.** Lozinke u čistom tekstu, mrtvi nalozi (analogno memoriji „legacy MSSQL
   lozinka nebitna"); ako 4.0 zatreba mapa „ko je šta uneo", čita se jednokratno pri migraciji, ne sinkuje.
3. **`RadniNalozi` (2.588) — ODLOŽI, ali otvorena odluka #2 iz master plana:** da li je BigBit
   komercijalno-servisni RN (sa vozilskim poljima) uopšte u scope-u 4.0, i da li se mapira na
   `Project`/`WorkOrder` ili ostaje zaseban registar. Povlači i `T_Usluge Servis`, `StvarniUtrosakSirovina`,
   `ProduktObrade`, `tRadnici`.
4. **`SastavMaterijala` — ODLOŽI uslovno:** ispravka #2 kaže da BigBit-interne tabele ne diraju PDM BOM
   (nema dileme), ali ostaje pitanje da li 4.0 uopšte želi BigBit materijalni obračun — i šta su slotovi
   `Sl1..Sl5` (Negovan). Ako ne — seli se u EXCLUDE.
5. **`T_Trgovacka knjiga` i `T_PK1` — ODLOŽI vs EXCLUDE:** obe imaju maloprodajne veze (`IDProdavnica`,
   `IDPazar`). Ako se kod Servoteha vode isključivo za maloprodaju → prekvalifikovati u EXCLUDE (uz
   KEPU_MP); ako i za veleprodaju → ostaju u tax fazi.
6. **`V_Dokumenta`/`V_Stavke`, `UI_Stavke`, `DExp_KutBarKod` — namena nepotvrđena.** Liče na
   otpremu/pakovanje (utovar-istovar po paketu/paleti, barkodovi kutija) verovatno za konkretnog
   EDI kupca. Ako je mrtav tok → EXCLUDE; trenutno konzervativno u ODLOŽI (sales/dispatch).
7. **`EXT_RobnaDokumenta`/`EXT_Dokumenta_USL` — ODLOŽI (sef/sales):** kolone (BrojNarudzbenice,
   EdiType, Storno) izgledaju kao SEF/EDI dodatna polja dokumenata, ali prefiks `EXT_` je isti kao kod
   starog „Preuzmi iz BB" mosta — potvrditi da nisu staging mosta (tada bi išle u EXCLUDE sa `ODBC_Synch`).
8. **`T_Obelezja_Def`/`T_Obelezja_Val` (EAV) — ODLOŽI:** proveriti sadržaj na produkciji — ako nose
   realne dodatne atribute matičnih podataka, deo se diže u KEEP (kao prava polja, ne EAV); ako su prazne
   → EXCLUDE.
9. **`T_PlaniranjeStavkeTok`/`TipDogadjaja` — stavljene u KEEP** jer `IDPlanStavka`/`IDRobnaStavka`
   zatvaraju MRP krug plan→realizacija (i imaju watermark kolone `PrviUnos`/`PoslednjaIzmena` — spremne
   za inkrementalni sync). Potvrditi da BigBit-ova strana planiranja nije prevaziđena QBigTehn
   `PDM_Planiranje*` lancem koji se gasi na cutover-u.
10. **`Posete`, `T_Izvestaj`(+`Stavke`) — ODLOŽI (CRM):** potvrditi da li se posete/izveštaji prodavaca
    danas uopšte kucaju; ako ne → EXCLUDE.
11. **`Depoziti` — ODLOŽI (banking):** tabela meša avansni saldo komitenta i POS blagajnu
    (`IDKasa`/`IDBlagajnaStavke`). Ako je upotreba čisto POS → EXCLUDE po tvrdoj listi.
12. **`NalepniceNNID` → EXCLUDE** (privremeni red za štampu), dok matična `Nalepnice` ostaje KEEP
    (već sinkovana u `labels`) — potvrditi da NNID pomoćna zaista nema trajni sadržaj.
13. **Šema-drift pre bilo kog novog syncera (ne odluka, podsetnik):** `BBOdeljenja`/`BBOrgJedinice`/
    `CFG_Global` u BB_T_26 imaju drugačije kolone od QBigTehn kopija koje sync-mapa očekuje — svaki KEEP
    syncer koji se bude prebacivao na direktan BigBit izvor mora prvo diff šeme na živom izvoru (§3.3
    master plana).

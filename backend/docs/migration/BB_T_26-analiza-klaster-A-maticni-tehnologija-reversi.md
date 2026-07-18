## Klaster A — Matični podaci + Tehnologija-relevantni + Reversi

> Izvor: `_analiza/bigbit/BB_T_26_schema.sql` (mdb-tools DDL, snapshot BigBit `BB_T_26.MDB`, 11.07.2026, 207 tabela).
> Poređeno sa: `backend/prisma/schema.prisma`, `backend/src/modules/sync/sync-map.generated.ts` (62 entiteta), `backend/docs/ROADMAP.md`.
> Status: **ANALIZA I PLAN** — ništa se ne implementira. Tipovi/PK/FK su naslućeni iz Access DDL-a (`IDxxx`/`Sifra*` konvencije, bez eksplicitnih constraint-a u mdb-export-u).

### A.0 Ključni nalaz pre tabela — dva izvora se lako pobrkaju

Tri stvari koje menjaju kako se čita ceo ostatak:

1. **2.0 danas NE čita BigBit direktno.** Svih 62 syncera (`sync-map.generated.ts`) čitaju **QBigTehn MSSQL** (`vasa-SQL:5765`), a QBigTehn već sadrži BigBit matične podatke prekopirane starim „Preuzmi iz BB" (EXT_* ODBC, INSERT-only) mehanizmom. Zato mapiranja u ovom klasteru (Komitenti→Customer, R_Artikli→Item…) opisuju **QBigTehnovu kopiju BigBit tabele**, ne nužno BB_T_26 original. To postaje bitno u 4.0 (Sync B direktni cutover), gde se izvor menja na sam BigBit — i tada šema mora da se poklopi (vidi §A.1e drift kod BB* tabela).

2. **`tRadnici` je homonim.** BB_T_26 ima svoju `tRadnici` (123 reda), a 2.0 `Worker` sinkuje QBigTehnovu `tRadnici`. Kolone su gotovo identične (isti ekosistem), ali QBigTehn ima dodatnu kolonu `PasswordRadnika`→`workerPassword` koje **nema** u BB_T_26 `tRadnici`. Znači: podaci su „isti oblik, drugi bunar".

3. **`Reversi` je homonim (najvažnije za backlog).** BB_T_26 `Reversi`/`ReversiStavke` je **komercijalni revers robe komitentu** (135 dokumenata / 144 stavke, veže se na `Komitenti`+`Prodavci`+`R_Artikli`). To **nije** magacin alata koji tehnolozi traže — taj živi u ServoSync **1.0** kao `rev_*` (sy15 baza, UUID PK, ručni/rezni alat, LZO). Detaljno u §A.5.

---

### A.1 Matični podaci koje 2.0 VEĆ sinkuje (kandidati za trajni Sync B do 4.0)

#### a) Komitenti → `Customer` (`customers`) — 6.669 redova — SINKOVANO (watermark `PoslednjaIzmena`)

- **Svrha:** kupci/dobavljači (jedinstven šifarnik komitenata; `Vrsta sifre`/`codeTypeCode` razdvaja kupca od dobavljača).
- **PK:** `Sifra` (Long) → `Customer.id`. **FK:** `Sifra prodavca`→`Prodavci`, `IDVozac`→`Komitenti` (self, vozač), `IDUplatniRacun`→`UplatniRacuni`, `IDRuta`→ruta.
- **Paritet:** BB_T_26 ima **57 kolona**, `Customer` mapira **56** — 1:1 osim **`KoristiPNBZadModel`** (poslednja BB kolona, „koristi PNB poziv-na-broj model") koja **nije** u sync-mapi. Sve regulatorno bitno je preneseno: `PIB`→`taxId`, `MaticniBroj`→`registrationNumber`, `JBKJS`→`publicSectorId`, `GLN`, `CRF`→`centralInvoiceRegistry`, `PDVStatus`→`vatStatus`, `KreditLimit`/`ProveraDuga`. Audit polja (`PrviUnos`/`PoslednjaIzmena`/`…User`) mapirana → watermark inkrement radi.
- **2.0 = cache/overlay** (ROADMAP §4.0 „masters"). Overlay polja se NE dodaju u `customers` (BACKEND_RULES §4/§11.1).

#### b) Predmeti → `Project` (`projects`) — 7.736 redova — SINKOVANO

- **Svrha:** poslovni predmet (projekat/nalog) — sve u Servotehu (ponuda→ugovor→proizvodnja→isporuka) visi o Predmetu. Vezna tačka komercijale (BigBit) i proizvodnje (RN, primopredaje).
- **PK:** `IDPredmet`. **FK:** `IDKomitent`→`Komitenti`, `IDProdavac`→`Prodavci`, `IDVrstaPosla`→`PredmetiVrstaPosla`, `InoDobavljac`→`Komitenti`.
- **Paritet:** **38 kolona = 1:1** (uklj. landed-cost polja `NabavnaVrednost`/`Carina`/`Spedicija`/`Prevoz`/`Ostalo`, `devvaluta`/`kurs`, ugovor/narudžbenica). U 2.0 se `Project` već koristi u modulima Predmeti, Primopredaje (`HandoverDraft.projectId`), Lokacije (`PartLocation.projectId`).
- **Napomena:** `Predmeti` je **most 2.0↔4.0** — proizvodnja (2.0) i komercijala (BigBit/4.0) dele isti `IDPredmet`. Stabilan legacy ključ već postoji.

#### c) R_Artikli → `Item` (`items`) — 91.199 redova — SINKOVANO (goods mirror)

- **Svrha:** matični artikal (roba, usluga, materijal, gotov proizvod). Najveća matična tabela.
- **PK:** `Sifra artikla`. **FK (šifarski):** `Grupa`→`R_Grupa`, `Podgrupa`→`R_Podgrupa`, `Poreklo`→`R_Poreklo`, `Tarifa robe`/`Tarifa usluga`→`R_Tarife`, `IDKvalitetArtikla`→`R_KvalitetArtikla`, `IDMestoIzdavanja`→`MestaIzdavanja`, `SifDob`→`Komitenti`(dobavljač), `IDRaster`→raster.
- **Paritet:** ~68 BB kolona, `Item` je **plosnat 1:1 port**. Sitna razlika: `Item.externalItemId` **nema izvor u BB_T_26 R_Artikli** (QBigTehn dodatak). `BarKod` je jedno polje — multi-barkod (`R_Artikli_BarKod`) NIJE modelovan (vidi §A.4 gap).
- **⚠️ Rupa u lancu:** `Item` referiše `groupCode`/`subgroupCode`/`originCode`/`qualityTypeId`, ali **pripadajući šifarnici NISU sinkovani** (vidi §A.2) → FK ciljevi prazni; batch-resolve (memory „legacy-read: batch-resolve") vraća `null` umesto 500, ali su nazivi grupa/porekla nedostupni u UI.

#### d) Prodavci → `Salesperson` (`salespeople`) — 80 redova — SINKOVANO

- **Svrha:** prodavci/komercijalisti + operativni nalog (`LogAcc`/`Password`, `Aktivan`, `NefiskalniRN`, `Storniranje` = prava u BigBit-u).
- **PK:** `Sifra prodavca`. **Paritet: 17 kolona = 1:1.** `Customer.salespersonId` i `Project.salespersonId` gađaju ovo.

#### e) Cenovnik → `PriceListEntry` (`price_list_entries`) — 82.855 redova — SINKOVANO

- **Svrha:** cena po (artikal × vrsta dokumenta) sa PDV varijantama.
- **PK:** `ID`. **FK:** `Sifra artikla`→`R_Artikli`, `Tarifa`→`R_Tarife`, `Vrsta dokumenta`→`R_Vrste dokumenata`. **Paritet: 11 kolona = 1:1** (`CenaBezPDV`/`CenaSaPDV` kao `Decimal(19,4)`, po BACKEND_RULES §2). Iznosi ispravno Decimal, ne Float.

#### f) Magacini → `Warehouse` (`warehouses`) — 3 reda — SINKOVANO

- **Svrha:** magacin (VP/MP/proizvodni), sa knjigovodstvenim kontom i magacionerom. **PK:** `IDMagacin` (composite izvor `IDFirma`+`IDMagacin`; 2.0 uzima `IDMagacin` kao PK, `IDFirma`→`companyId` polje). **Paritet: 11 kolona = 1:1.**

#### g) Šifarnici koji su takođe sinkovani (podrška artiklima/dokumentima)

| BigBit | 2.0 model / tabela | Status | Napomena |
|---|---|---|---|
| R_Tarife | `TaxRate` / `tax_rates` | SINKOVANO | 10 kolona 1:1; **effective-dated** (`Vazi od`/`Vazi do`→`validFrom`/`validTo`) — temelj za 4.0 `tax` |
| R_Vrste dokumenata | `DocumentType` / `document_types` | SINKOVANO | 24 kolone; nosi šeme kontiranja/PDV flagove (4.0 finance) |
| BBDefUser | `DefaultUser` / `default_users` | SINKOVANO | default godina/OJ/OD po useru |
| BBOrgJedinice | `OrganizationalUnit` / `organizational_units` | SINKOVANO | **⚠️ drift, vidi dole** |
| BBOdeljenja | `Department` / `departments` | SINKOVANO | **⚠️ drift, vidi dole** |

**⚠️ Šema drift kod BB* tabela (bitno za Sync B direktni cutover u 4.0):** sync-mapa očekuje `BBOdeljenja(OD, OznakaOD, OpisOD)` i `BBOrgJedinice(OJ, OznakaOJ, OpisOJ)`, a **BB_T_26 ima samo `BBOdeljenja(OD, Naziv)` i `BBOrgJedinice(OJ, NazivOJ)`** (2 kolone). Znači QBigTehnova varijanta BB* tabela ima dodatne kolone kojih u BigBit originalu nema. Kad `bigbit-sync` (4.0) pređe da čita direktno BigBit, mapiranje `code`/`description` puca — treba re-mapirati na `Naziv`. Isti rizik postoji i za druge „prekopirane" tabele — zahteva validaciju šeme na pravom BigBit izvoru pre cutover-a.

---

### A.2 Šifarnici artikala/predmeta — model postoji ili nedostaje, ali NIJE sinkovan (rupa u pokrivenosti)

Ove BB tabele imaju (ili bi trebalo da imaju) model u 2.0, ali ih **nijedan syncer ne puni** (nema ih u `sync-map` source listi) → tabele prazne, FK nazivi nedostupni:

| BigBit | 2.0 model | Postoji model? | Sinkuje se? | Posledica |
|---|---|---|---|---|
| R_Grupa | `ItemGroup` | DA | **NE** | `Item.groupCode` bez naziva grupe |
| R_Podgrupa | `ItemSubgroup` | DA | **NE** | `Item.subgroupCode` bez naziva |
| R_Poreklo | `ItemOrigin` | DA | **NE** | `Item.originCode` bez naziva; `PopustProc` (popust po poreklu) nedostupan |
| R_KvalitetArtikla | — | **NE** | NE | `Item.qualityTypeId` visi u prazno; **ne mešati** sa `PartQualityType` (`Was: tVrsteKvalitetaDelova` — to je kvalitet PROIZVEDENOG dela, ne matičnog artikla) |
| PredmetiVrstaPosla | `ProjectWorkType` | DA | **NE** | `Project.workTypeId` bez naziva vrste posla |

> Napomena: postoji i `tR_Grupa`→`ProductionItemGroup` koji SE sinkuje, ali je to **zasebna proizvodna grupa** iz QBigTehn-a, ne komercijalna `R_Grupa`. Dva paralelna šifarnika grupa — ne spajati bez potvrde.

**Preporuka:** dodati lagane syncere (svega stotine redova) za `R_Grupa`/`R_Podgrupa`/`R_Poreklo` da UI artikala dobije nazive; `R_KvalitetArtikla` traži nov model. Nizak rizik, visoka korist za module Komitenti/Predmeti/MRP.

---

### A.3 Tehnologija-relevantni GAP-ovi (nema modela u 2.0)

| BigBit tabela | Kolone (naslućeni PK/FK) | Uloga | 2.0 status |
|---|---|---|---|
| **PredmetiFaze** | `ID`, `IDPredmet`→Predmeti, `IDFazaPredmeta`→PredmetiFazeDef, `Opis`, `DIVUnosa` | dnevnik faza kroz koje predmet prolazi (workflow trag) | GAP — nema modela; slično po nameni 2.0 `handover_statuses`/`Project.status`, ali granularnije |
| **PredmetiFazeDef** | `IDFazaPredmeta`(PK), `FazaPredmeta`, `Napomena` | šifarnik faza predmeta | GAP |
| **KomitentiKontaktOsobe** | `IDKontaktOsobe`(PK), `Sifra`→Komitenti, ime/tel/fax/mob/email, `Datum rodjenja`, `KontaktDefault` | kontakt osobe komitenta (1:N) | GAP — `Customer` ima samo jedan `contact` string; višestruki kontakti se gube |
| **MestaIsporuke** | `ID`(PK), `IDKomitent`→Komitenti, adresa/mesto/podrucje, ruta/vozač/uplatni račun, `GLN`, `AktivnoMISP` | mesta isporuke komitenta (1:N, za fakturisanje po mestu) | GAP — `Customer.invoicePerDeliveryAddress` postoji kao flag, ali same adrese nisu modelovane (4.0 `sales`) |
| **MestaIzdavanja** | `IDMestoIzdavanja`(PK), `MestoIzdavanja` | mesto izdavanja artikla | GAP — `Item.issuePlaceId` referiše prazno |
| **R_Artikli_BarKod** | `ID`(PK), `IDArtikal`→R_Artikli, `BarKod`, `MultiFaktor` | više barkodova po artiklu + faktor pakovanja | GAP — `Item.barCode` je jedan; relevantno za scan/nalepnice (memory „barkod nalepnice") |
| **Operateri** | `IDOperater`(PK), `ImeOperatera`, `pwd` | operateri BigBit-a (lozinke) | GAP — 2.0 ima svoj `User`/auth; verovatno se NE migrira (mrtvi nalozi, memory „legacy MSSQL lozinka nebitna") |
| **Pozicije** (BigBit) | `Pozicija`(PK Text), `Opis pozicije` | 65 redova — generički šifarnik pozicija (magacin/GK) | GAP — **ne mešati** sa 2.0 `Position` (`Was: tPozicije`, proizvodne pozicije za `PartLocation` ledger) |
| **ProdavciZaGK** | `ID`(PK), `IDStavkeIzGK`→GK stavka, `Sifra prodavca`→Prodavci | veza prodavca ka stavci glavne knjige | GAP — čisto **4.0 finance/GL**, ne tehnologija |

---

### A.4 Reversi (BigBit) — homonimska zamka + veza sa backlogom i 3.0 pilotom

**BigBit `Reversi` (135) / `ReversiStavke` (144):**

- `Reversi`: `IDReversa`(PK), `Sifra komitenta`→Komitenti, `Sifra prodavca`→Prodavci, `RazduzioDok`(bool), `Broj reversa`, `Datum reversa`, `OpisDok`, `Napomena`, `Potpis`, `DatumIVreme`.
- `ReversiStavke`: `IDStavke`(PK), `IDReversa`→Reversi, `IDArtikal`→R_Artikli, `Kolicina`, `Razduzio`(bool), `Datum razduzenja`.
- **Šta je zapravo:** privremeno izdavanje **robe (artikala) KOMITENTU** uz potpisnicu, sa razduženjem — komercijalni revers/konsignacija. Vezuje se na matične artikle i komitente, ne na zaposlene, ne na alat.

**Zašto je ovo zamka za magacin-alata backlog (memory „magacin-alata-backlog"):**

- Tehnolozi žele da vide **dostupnost ALATA** dok pišu TP. Taj podatak **NIJE** u BigBit `Reversi`. On živi u **ServoSync 1.0** kao `rev_*` familija (14 tabela, sy15 baza, **UUID PK**): `rev_tools` (47 ručnih alata/LZO), `rev_cutting_tool_catalog`/`rev_cutting_tool_stock` (rezni alat, još 0 podataka), `rev_documents`/`rev_document_lines`/`rev_tool_stock_ledger`, kartice mašina/alata. Vidi `MODULE_SPEC_reversi.md`.
- **3.0 Reversi pilot** (`MODULE_SPEC_reversi.md`) radi nad **sy15/1.0 bazom**, ne nad BigBit-om. Ključna odluka pilota: `rev_*` tabele OSTAJU u sy15 (atomarnost sa `loc_*`), 2.0 backend im pristupa kroz **drugi datasource** — seli se kod i authz, ne podaci.

**Zaključak (za backlog):** BigBit `Reversi` i 1.0 `rev_*` su **različiti podaci sa istim imenom**. Za „tehnolog vidi dostupnost alata" izvor je **1.0 `rev_cutting_tool_stock`/`rev_tools`** (posle 3.0 pilota), a **ne** BigBit `Reversi`. BigBit `Reversi` (konsignacija robe komitentu) je marginalan (135 dok.) i pripada 4.0 `sales`/`inventory` domenu, ako se uopšte prenosi. **Ne treba ga uvlačiti u magacin-alata backlog** — to bi bila pogrešna spona. (Isto važi i za tabelu `Reversi` u brojevima zadatka — to je BigBit komercijalni revers.)

---

### A.5 SastavMaterijala (BigBit BOM) vs PDM BOM u 2.0

- **`SastavMaterijala`:** `KatBrZaSastav`(Text 20, kataloški broj za koji važi sastav), `Sastav`(Text 50), `Sl1..Sl5`(Long Integer, 5 slotova — verovatno reference komponenti/slika). Ravna, **maks. 5 slotova, bez rekurzije, bez količina/jedinica po komponenti**. Ključ je tekstualni kataloški broj, ne artikal-ID.
- **Namena:** rudimentarna beleška „od čega se sastoji" na nivou kataloškog broja — **nije prava sastavnica**. Nema dubine, nema anti-ciklus potrebe, nema where-used.
- **2.0 PDM BOM (autoritativan):** `Drawing` (`PDMCrtezi`) + `DrawingComponent` (`KomponentePDMCrteza`, parent/child + `requiredQuantity`) + `DrawingAssembly` + `WorkOrderComponent`/`WorkOrderItemComponent`. Prava **rekurzivna** sastavnica sa `WITH RECURSIVE` + anti-ciklus guardom (ROADMAP §2.0 rizici; memory „legacy-read: batch-resolve"). Izvor je SolidWorks PDM (Sync C, jednosmeran).
- **Zaključak:** `SastavMaterijala` je **prevaziđen PDM BOM-om** — inženjerska sastavnica u 2.0 dolazi iz PDM-a, ne iz BigBit-a. Eventualna vrednost `SastavMaterijala` je samo ako `Sl1..Sl5` nose materijalni sastav/kvalitet čelika koji PDM ne pokriva — **traži potvrdu Negovana** šta su `Sl1..Sl5` pre bilo kakve migracije. Podrazumevano: **ne migrirati** (superseded).

---

### A.6 StvarniUtrosakSirovina + BigBit RadniNalozi (proizvodni obračun — 4.0, ne 2.0)

- **`StvarniUtrosakSirovina`:** `IDStavke`(PK), `IDRadniNalog`→**BigBit `RadniNalozi`**, `IDArtikal`→R_Artikli, `Kolicina`, `Cena`. = stvarno utrošena sirovina po radnom nalogu (materijalni trošak proizvodnje).
- **⚠️ `RadniNalozi` je TREĆI homonim RN-a.** BigBit `RadniNalozi` (2.588 redova; PK `IDRadniNalog`, `IDPredmet`→Predmeti, `IDInvestitor`→Komitenti, + polja vozila `RegBroj`/`MarkaITip`/`BrojSasije`/`BrojMotora`/`BrojKM`) je **komercijalno-servisni radni nalog** (uklj. servis vozila). To **nije** 2.0 `WorkOrder` (`Was: tRN`, izvor QBigTehn `tRN` — proizvodni RN za tehnologiju). Tri različita RN pojma: BigBit `RadniNalozi` (komercijala/servis), QBigTehn `tRN`→2.0 `WorkOrder` (proizvodnja), i `tLansiranRN`→`WorkOrderLaunch`.
- **2.0 status:** GAP i po nameni **van scope-a 2.0** — proizvodni obračun materijala/troška je 4.0 (`inventory`/`finance`, „gotov proizvod" tok C iz ROADMAP-a: TREB/ULGP/IFGP). `StvarniUtrosakSirovina` pripada tom lancu.

---

### A.7 Tabela mapiranja BigBit → ServoSync 2.0 (ceo klaster A)

| BigBit tabela | Redova | 2.0 model / tabela | Sinkuje se? | Klasifikacija |
|---|---:|---|---|---|
| Komitenti | 6.669 | `Customer` / customers | DA (Sync B) | matični ✓ (−1 kol: KoristiPNBZadModel) |
| Predmeti | 7.736 | `Project` / projects | DA | matični ✓ 1:1 (most 2.0↔4.0) |
| R_Artikli | 91.199 | `Item` / items | DA | matični ✓ 1:1 (+externalItemId QBigTehn) |
| Prodavci | 80 | `Salesperson` / salespeople | DA | matični ✓ 1:1 |
| Cenovnik | 82.855 | `PriceListEntry` / price_list_entries | DA | matični ✓ 1:1 |
| Magacini | 3 | `Warehouse` / warehouses | DA | matični ✓ 1:1 |
| R_Tarife | — | `TaxRate` / tax_rates | DA | šifarnik ✓ (temelj 4.0 tax) |
| R_Vrste dokumenata | — | `DocumentType` / document_types | DA | šifarnik ✓ (4.0 finance) |
| BBDefUser | — | `DefaultUser` / default_users | DA | config ✓ |
| BBOrgJedinice | — | `OrganizationalUnit` | DA | config ✓ (⚠️ drift Naziv vs Oznaka/Opis) |
| BBOdeljenja | — | `Department` | DA | config ✓ (⚠️ drift) |
| tRadnici (BigBit) | 123 | `Worker` (sinkuje QBigTehn tRadnici!) | posredno | homonim; QBigTehn ima +PasswordRadnika |
| R_Grupa | — | `ItemGroup` | **NE** | model postoji, prazan → gap sync |
| R_Podgrupa | — | `ItemSubgroup` | **NE** | model postoji, prazan → gap sync |
| R_Poreklo | — | `ItemOrigin` | **NE** | model postoji, prazan → gap sync |
| PredmetiVrstaPosla | — | `ProjectWorkType` | **NE** | model postoji, prazan → gap sync |
| R_KvalitetArtikla | — | — | NE | GAP (nema modela) |
| R_Artikli_BarKod | — | — | NE | GAP (multi-barkod) |
| PredmetiFaze | — | — | NE | GAP (workflow faza) |
| PredmetiFazeDef | — | — | NE | GAP |
| KomitentiKontaktOsobe | — | — | NE | GAP (1:N kontakti) |
| MestaIsporuke | — | — | NE | GAP (4.0 sales) |
| MestaIzdavanja | — | — | NE | GAP (Item.issuePlaceId cilj) |
| Operateri | — | — | NE | GAP (verovatno se ne migrira) |
| Pozicije (BigBit) | 65 | — | NE | GAP (≠ 2.0 Position/tPozicije) |
| ProdavciZaGK | — | — | NE | GAP (4.0 finance/GL) |
| Reversi (BigBit) | 135 | — | NE | GAP (4.0 sales; ≠ 1.0 magacin alata) |
| ReversiStavke | 144 | — | NE | GAP (4.0 sales) |
| SastavMaterijala | — | — | NE | prevaziđen PDM BOM-om (§A.5) |
| StvarniUtrosakSirovina | — | — | NE | GAP (4.0 inventory/finance) |
| RadniNalozi (BigBit) | 2.588 | — (≠ 2.0 WorkOrder) | NE | GAP (4.0 komercijala/servis; homonim RN) |

---

### A.8 Preporuke za pripremu domena

1. **Zatvoriti rupu šifarnika artikala (jeftino, odmah korisno):** dodati syncere za `R_Grupa`/`R_Podgrupa`/`R_Poreklo` (modeli već postoje, stotine redova) da UI Komitenti/Predmeti/Artikli/MRP dobije nazive grupa/porekla. Za `R_KvalitetArtikla` dodati nov model (`Item.qualityTypeId` ga čeka). Obrazac: `customer.syncer.ts` (BACKEND_RULES §5).
2. **Pre 4.0 Sync B (direktni BigBit) — validirati šemu na pravom izvoru.** Drift kod `BBOdeljenja`/`BBOrgJedinice` (Naziv vs Oznaka/Opis) dokazuje da QBigTehnove kopije ≠ BigBit original. Napraviti diff sync-mape prema `BB_T_26_schema.sql` za sve „prekopirane" tabele pre nego što se izvor prebaci. Bez toga syncer tiho puni pogrešne/null kolone.
3. **Razrešiti tri homonima u dokumentaciji i kodu (rizik zabune):**
   - `Reversi`: BigBit komercijalni revers robe (4.0 sales) **vs** 1.0 `rev_*` magacin alata (3.0 pilot). Magacin-alata backlog gađa **1.0 `rev_*`**, ne BigBit.
   - `tRadnici`: BigBit vs QBigTehn (2.0 sinkuje QBigTehn; +PasswordRadnika).
   - `RadniNalozi`: BigBit komercijala/servis vs QBigTehn `tRN`→2.0 `WorkOrder`.
   - `Pozicije`: BigBit šifarnik vs 2.0 `Position`/`tPozicije`.
4. **Ne uvlačiti BigBit `Reversi` u magacin-alata backlog.** Kad se posle cutover-a bude uvezivala „dostupnost alata za TP", izvor je 1.0 `rev_cutting_tool_stock`/`rev_tools` (kroz 3.0 sy15 datasource iz `MODULE_SPEC_reversi.md`), a ne BigBit. Postaviti pitanje „gde alat danas fizički živi" (memory) baš prema 1.0 modulu.
5. **`SastavMaterijala` — potvrda Negovana šta su `Sl1..Sl5` pre bilo kakve odluke.** Podrazumevano ne migrirati (inženjerski BOM je PDM/`DrawingComponent`). Migrirati samo ako nose materijalni sastav koji PDM ne daje.
6. **Kontakti i mesta isporuke (4.0 sales priprema):** `KomitentiKontaktOsobe` i `MestaIsporuke` su 1:N proširenja `Customer`-a koja 2.0 model danas gubi (samo `contact` string + `invoicePerDeliveryAddress` flag). Kad krene 4.0 `sales`, modelovati kao zasebne child tabele sa `customerId` FK — ne kao overlay na `customers` (cache-never-touch, §11.1).
7. **`Predmeti` kao osovina integracije:** `IDPredmet` je zajednički ključ proizvodnje (2.0) i komercijale (BigBit/4.0). Već je stabilan legacy ključ; u 4.0 `Project` prelazi iz cache u vlasništvo bez migracije podataka (samo „preimenovanje vlasnika", ROADMAP §4.0).
8. **Finansijske spone (`ProdavciZaGK`, `StvarniUtrosakSirovina`, `RadniNalozi`, BigBit `Reversi`) su čist 4.0** (`finance`/`inventory`/`sales`) — ne dovlačiti u 2.0/3.0 scope; evidentirati kao ulaz za 4.0 domensku analizu (postoji `09-bigbit-online-domain-map.md`).

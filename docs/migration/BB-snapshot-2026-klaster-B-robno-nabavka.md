## Klaster B — Robno-materijalno, Nabavka, Maloprodaja, Carina, Cene, Proizvodnja (BigBit snapshot 11.07.2026)

Analiza DDL iz `_analiza/bigbit/BB_T_26_schema.sql` (mdb-tools izvoz, 207 tabela) upoređena sa ServoSync 2.0
(`backend/prisma/schema.prisma` + `sync-map.generated.ts` + `docs/ROADMAP.md`). Ovo je **plan/analiza za
3.0/4.0** — ništa se ne implementira. Access tipovi: `Long Integer` = Int/PK-FK, `Double`/`Currency` =
novac/količine (u 2.0 obavezno `Decimal`), `Boolean` = flag, `Memo/Hyperlink` = text, `Text (n)` = VarChar(n).
Konvencija: kolone `IDxxx` i „Sifra xxx" su naslućeni FK (Access ih ne deklariše).

> **Ključni kontekst iz ROADMAP-a:** 2.0 je preuzeo **proizvodni core iz QBigTehn-a** (RN/TP/PDM/BOM/MRP). Ceo
> ovaj klaster (robni tok, nabavka, maloprodaja, carina) je **komercijalni deo BigBit-a koji dolazi tek u 4.0**
> kroz domene `inventory`, `procurement`, `sales`, `customs` (ROADMAP §„Domeni 4.0", tačke 4/8/9). U 2.0 je od
> ovog klastera prisutan samo **read-only cache** minimalnog podskupa (robna dokumenta kao izvor MRP zaliha,
> cenovnik, magacini, tarife, vrste dokumenata). **⚠️ Bitno razdvajanje:** BigBit `RadniNalozi`, `T_Proizvodnja`,
> `T_Rastavnice`, `T_Recepti` **NISU** isto što i 2.0 proizvodni core (koji je iz QBigTehn-a) — vidi §7.

---

### 1. Robno-materijalno jezgro (robna dokumenta + robne stavke + magacinske stavke)

Centralni robni tok BigBit-a: jedan dokument-model (`T_Robna dokumenta`) sa tipom (`Vrsta dokumenta`) pokriva
sve robne pokrete — ulaz, izlaz, međuskladišnice, kalkulacije, otpremnice, rezervacije. Uz njega ide granularna
komadna evidencija (`T_MagStavke`) koja Servotehu služi za praćenje po komadu/proizvođaču/dimenziji (ploče).

**`T_Robna dokumenta`** (65 kolona) — zaglavlje robnog dokumenta.
- Kolone: `IDDok` (PK), `IDFirma`, **`Ulaz`** (bool — smer pokreta), `Vrsta dokumenta`/`Vrsta naloga` (tip →
  šifarnik `R_Vrste dokumenata`), `Broj dokumenta`/`Broj naloga`, `Sifra komitenta` (FK→Komitenti),
  `Datum dokumenta`/`Datum knjizenja`/`Datum valute`, `IDMagacinDOK` (FK→Magacini), `IDRadniNalog` (FK→RadniNalozi),
  `IDPredmet` (FK→Predmeti), `IDTrebZaProizvodnju` (FK→Trebovanja), `Kurs`/`ObrKurs`/`CarKurs`/`DevValuta`/`DevVredFak`
  (devizni dokument), `Carina`/`Spedicija`/`OstaliZavTros`/`PovCarOsn` (**zavisni troškovi = landed cost**),
  `IDDokUF`/`IDDokIF`/`IDDokUSL` (veze na ulaznu/izlaznu fakturu / uslugu), `Rezervisi` (rezervacija zaliha),
  `IDMestoIsporuke`/`IDRuta`/`IDVozac` (isporuka), `PrimljenNovac`/`PrimljeniCekovi`/`PrimljenaKartica`/
  `PrimljeniVirmani`/`IDKasa`/`StampanFiskalno` (fiskalni/kasa deo), `DokBarKod`/`DokBrojKutija`, `Zakljucano`,
  `Potpisano`/`Potpis`, `OJ`/`OD`/`Godina` (org. dimenzije).
- Veze: → `Komitenti`, `Magacini`, `Predmeti`, `RadniNalozi`, `T_Trebovanja`, fakture (`T_PDV_UF`/`T_PDV_IF`),
  `R_Vrste dokumenata`. 1:N ka `T_Robne stavke`.
- Broj redova: nije u zadatom setu (očekivano najveća/najprometnija tabela sistema).
- **Status u 2.0: DELIMIČNO — `GoodsDocument` (`goods_documents`, „Was: T_Robna_dokumenta").** Model postoji sa
  kompletnim mapiranjem (63 kolone, `sync-map` red 4225), sinkuje se kao **cache** (izvor je QBigTehn MSSQL preko
  `vasa-SQL`, ne BigBit). Služi kao feed za MRP zalihe i uvid. **Nema aplikativne logike** (kalkulacija, kontiranje,
  fiskalizacija) — to je gap za 4.0 `inventory`/`sales`.

**`T_Robne stavke`** (36 kolona) — stavke robnog dokumenta.
- Kolone: `IDStavke` (PK), `IDDok` (FK), `Sifra artikla` (FK→R_Artikli), `Kolicina`/`KG_Kolicina`,
  cenovni sloj: `Nabavna cena - neto`, `Zavisni trosak - sopstveni/dobavljac`, `Kalkulativna/Stvarna VP cena`,
  `Kalkulativna/Stvarna MP cena`, `KNGCena`, `DevNabCena`; poreski sloj: `Tarifa - roba - ulaz/Izlaz`,
  `Tarifa - usluge`, `Obracunat porez...` flagovi, `Akciza`, `FiksniPorez`, `CarStopa`, `Neoporezivi deo`;
  `RabatProc`/`KasaProc`, `IDMagacin`, `IDPredmetStavka`, `ID_PO` (veza na porudžbenicu), `IDStavkeTrebovanja`,
  `IDPlanStavka` (veza na MRP plan), `IDPrepisaneStavke` (kopiranje).
- Veze: → `T_Robna dokumenta`, `R_Artikli`, `Magacini`, `OP_Dokumenta`/porudžbenica (`ID_PO`),
  `T_Trebovanja stavke`, MRP plan.
- **Status u 2.0: DELIMIČNO — `GoodsDocumentItem` (`goods_document_items`, „Was: T_Robne_stavke", `sync-map` red 4650).**
  Kompletno mapiran, cache. **⚠️ zamka:** cene su u legacy-ju `Double` (Float); 2.0 model ih je zadržao kao `Float`
  (za paritet sa izvorom), ali za 4.0 vlasništvo **mora `Decimal`** (BACKEND_RULES §pravilo 2).

**`T_MagStavke`** (15 kolona) — komadna/dimenziona magacinska evidencija.
- Kolone: `ID` (PK), `IDDok`, `IDArtikal`, `IDMagacin`, **`IDVezaUlazaIzlaza`** (spaja ulaznu i izlaznu stavku —
  praćenje konkretnog komada), `IDPredmetStavka`, `Duzina`/`Sirina`/`Kutija` (dimenzije — ploče/profili),
  `IDProizvodjaca` (FK→T_MagProizvodjaci), `Kolicina`, unos/ispravka potpis+vreme.
- Svrha: Servoteh-specifično — praćenje robe **po komadu i dimenziji** (limovi/ploče), sa vezom ulaz↔izlaz.
- **Status u 2.0: GAP.** Nema modela. Bitno za `inventory` u 4.0 (komadna evidencija je 🔴 pravilo iz ROADMAP §4).

**`T_MagDok`** (19 kolona) — zaglavlje magacinskog naloga (interni pokret vezan za proizvodnju).
- Kolone: `IDDok`, `Ulaz`, `IDMagacinDok`, `IDKomitent`, `IDRadniNalog`, `IDPredmet`, `IDVrstaDokumenta`
  (FK→T_MagVrsteDokumenata), `IDTrebZaProizvodnju`, veze `IDDokBBUF`/`IDDokBBIF`/`IDDokUSLMAT`, `Zakljucano`.
- Svrha: nalog magacinu / interni robni pokret (izdavanje materijala u proizvodnju, trebovanje→izdavanje).
- **Status u 2.0: GAP** (ali koncept „Nalog magacinu" pominje MRP spec §2 kao ciljni tok).

**`T_MagVrsteDokumenata`** (2 kol., `IDVrsteDokumenta`+`VrstaDokumenta`) i **`T_MagProizvodjaci`** (2 kol.,
`IDProizvodjaca` text + opis) — mali šifarnici uz `T_MagStavke`/`T_MagDok`. **GAP** (jeftino za port).

**`R_Vrste dokumenata`** (24 kol.) — 🔴 **ključni šifarnik tipova dokumenata** i pravila knjiženja.
- Kolone: `Vrsta dokumenta` (PK text), `Opis`, `Ulazni`, `Analiticki konto`, `Sema za kontiranje`,
  `Knjiziti analitiku/sintetiku`, `Prodaja sa PPP/PPU`, `KnjizitiTKZad/Razd`, `KnjizitiUPDVEvidenciju`,
  `KEPUDefZaduzenje/Razduzenje`, `NumeracijaOd`, `PrefiksBrojaDok`, `IDMagacinZaVrstuDok`, **`UticeNaZalihe`**,
  `InterniDokument`, `KOTP`/`KODJ`/`FR`.
- Svrha: definiše ponašanje svakog tipa dokumenta (šema kontiranja, PDV knjige, KEPU, uticaj na zalihe).
- **Status u 2.0: PRISUTAN kao cache — `DocumentType` (`sync-map` red 3224, „Was: R_Vrste dokumenata").** Ali samo
  kao lookup; pravila kontiranja/knjiženja (šeme) su **gap za 4.0** `tax`/`finance`.

**Podklaster: kompleksnost VISOKA · prioritet 4.0 KRITIČAN (`inventory` je temelj, ROADMAP domen #4).**

---

### 2. Cene, rabati, akcije, nivelacije

**`Cenovnik`** (11 kol.) — glavni cenovnik po artiklu i vrsti dokumenta.
- Kolone: `ID` (PK), `Sifra artikla`, `Vrsta dokumenta`, `Cena`, `Tarifa`, `CenaBezPDV`/`CenaSaPDV`, `Taksa`,
  `Prn`, `ZakCen` (zaključana cena).
- Broj redova: **82.855** (drugi po veličini u setu).
- **Status u 2.0: PRISUTAN kao cache — `PriceListEntry` (`price_list_entries`, „Was: Cenovnik", `sync-map` red 325).**
  Sinkuje se (Sync B, matični podaci). U 4.0 prelazi iz cache → vlasništvo (`masters`/pricing). `CenaBezPDV`/
  `CenaSaPDV` su već `Decimal` u 2.0. (`SYNCH_Cenovnik` je replikacioni pomoćni — ne portovati.)

**`Rabati`** (`ID`, `Sifra` komitenta, `RabatProc`, `IDGrupa`, `ExtraRabatProc`) — rabat po komitentu i grupi robe.
**`RabatiPoArt`** (+ `IDArtikal`, `OdDatuma`/`DoDatuma`) — rabat po komitentu i artiklu, vremenski ograničen.
**`Akcije`** (`IDAkcija`, `OpisAkcije`, `Aktivna`) + **`AkcijeArtikli`** (`IDAkcija`+`IDArtikal`+`RabatProc`) —
akcijske cene/popusti po artiklu.
- Svrha: komercijalna politika cena (rabat po kupcu × grupa × artikal × akcija).
- **Status u 2.0: GAP (sve četiri).** Za 4.0 `sales`/pricing — srednja kompleksnost.

**`Stavke nivelacije`** (25 kol.) + **`MPStavkeNivelacije`** (9 kol.) — nivelacija (promena cene na zalihama).
- `Stavke nivelacije`: stara↔nova (nabavna, ZT, VP, MP, taksa, tarifa, akciza) po artiklu i magacinu. `MPStavkeNivelacije`
  je maloprodajni ekvivalent (stara↔nova MP cena + taksa + tarifa).
- Svrha: dokument promene cene zaliha (VP i MP), utiče na vrednost lagera.
- **Status u 2.0: GAP.** ROADMAP §4 eksplicitno navodi **nivelaciju** kao deo `inventory` domena 4.0. Srednja kompleksnost.

**Podklaster: kompleksnost SREDNJA · prioritet 4.0 (cenovnik VISOK jer je matični podatak; rabati/akcije/nivelacija uz `sales`/`inventory`).**

---

### 3. Nabavka (RFQ → PO → prijem) — domen `procurement`

Tok (iz `docs/migration/13-bigbit-nabavka.md`): Specifikacija → Zahtev za ponudu (upit) → Ponuda → Porudžbenica →
[Profaktura/avans] → Prijem → Ulazna faktura + Otpremnica → knjiženje/ulaz u magacin. Statusi su konfigurabilan
šifarnik (`Tabela statusa`), ne hardkod.

**`ZahteviZaNabavku`** (17 kol.) — zahtev za nabavku (interni, od inicijatora/projektanta).
- Kolone: `IDZahtevaZaNabavku` (PK), `InicijatorZahteva` (FK→radnik/lice), `BrojZahteva`, `DatumZahteva`,
  `Opis`, `RokZaZavrsetak`, `IDPredmetDok` (FK→Predmeti), `IDRadniNalog`, `PorekloZahteva` (kanal, npr. „MEJL"),
  `IDStatus` (FK→T_Statusi), `IDProdavac`, `OJ`/`OD`/`Godina`.
- Broj redova: **3.990**.
- **Status u 2.0: GAP na nivou tabele, ali PLANIRAN.** MRP spec (`MODULE_SPEC_mrp.md` §1) predviđa `purchase_requests`/
  `_items` i ekran `ZahteviZaNabavku`; model još nije u `schema.prisma` (čeka §11.3 / decision-engine). Prioritet: 2.0
  „uvid", pun rad tek 4.0 `procurement`.

**`SpecifikacijaZahtevaNabavke`** (14 kol.) — stavke zahteva.
- Kolone: `IDStavke` (PK), `IDZahtevaZaNabavku`, `Sifra artikla`, `ZahtevanaKolicina`, `Kataloski brojStavke`,
  `OpisStavke`, `Jedinica mereStavke`, `SifraDobavljaca`, `Proizvodjaca`, `IDPredmet`, **`KreirajUpit`** (flag →
  generiše upit dobavljaču), `IDPlanStavka` (veza na MRP plan).
- Veze: → `ZahteviZaNabavku`, `R_Artikli`, `Komitenti` (dobavljač), MRP `mrp_demand_items`/plan.
- **Status u 2.0: GAP.** Bitna spona MRP → nabavka (`IDPlanStavka`). Prioritet 4.0.

**`ZahteviZaPonude`** (17 kol.) — zahtev za ponudu (RFQ zaglavlje, širi od upita).
- Kolone: `IDZahteviPonude` (PK), `Opis`, `DatumZahteva`, `RokZaPonudu`, `IDKomitent`, `IDPredmet`,
  `PorekloZahteva`, `IDProdavac`, `IDDokProf`/`IDDokUSL` (veze na profakturu/uslugu), `IDStatus`.
- **Status u 2.0: GAP.** 4.0 `procurement` (entitet Quote/RFQ iz doc 13 §5).

**`T_UpitDobavljacu`** (18 kol.) + **`T_UpitDobavljacu Stavke`** (11 kol.) — upit konkretnom dobavljaču.
- Zaglavlje: `IDUpita` (PK), `Broj upita`, `Datum upita`, `Sifra komitenta` (dobavljač), `IDPredmetDok`,
  `IDTrebVeza` (veza na trebovanje), `Poslato`, `IDStatus`, `PrihvacenaPonudaDok`.
- Stavke: `IDStavke`, `IDUpita`, `Sifra artikla`, `Kataloski brojStavkeUpita`, `OpisStavkeUpita`, `TrebKol`,
  `Proizvodjaca`, `RokZaIsporuku`, **`PrihvacenaPonuda`** (flag po stavci).
- Veze: → `Komitenti`, `R_Artikli`, `T_Trebovanja` (`IDTrebVeza`), `Predmeti`.
- **Status u 2.0: GAP.** 4.0 `procurement`.

**`DobavljaciZaArtikal`** (5 kol.) — mapiranje artikal ↔ dobavljač.
- Kolone: `IDArtikal`, `Sifra dobavljaca`, **`Primarni`** (primarni dobavljač), **`VremeIsporuke`** (lead time dana).
- **Status u 2.0: GAP na tabeli**, ali **logika je već ušla u MRP** (`MrpDemandItem.supplierId` + MRP spec §3.5:
  „primarni dobavljač + lead time, `ORDER BY Primarni DESC`, `VremeIsporukeDana`"). Puna tabela ide u 4.0 `procurement`/`masters`.

**Porudžbenica / narudžbina** — u BigBit-u se realizuje kroz **`OP_Dokumenta`** (32 kol.) + **`OP_Stavke`** (9 kol.):
- `OP_Dokumenta`: `IDDok`, `IDKomitent` (dobavljač), `IDMagacin`, `IDRadniNalog`, `IDPredmet`, `IDRuta`/`IDVozac`,
  `VrstaNaloga`/`VrstaDokumenta`, `Cenovnik`, `DatumPorudzbine`/`DatumOtpreme`, `BrojIsporuke`, `Zakljucano`.
- `OP_Stavke`: `IDArtikal`, **`NarucenaKolicina`**/**`OtpremljenaKolicina`**/**`IsporucenaKolicina`** (parcijalne
  isporuke), `Cena`, `RabatProc`/`ExRabatProc`.
- **Status u 2.0: GAP.** Ovo je „PurchaseOrder/PurchaseOrderLine" iz doc 13 §5. `ID_PO` na `T_Robne stavke` zatvara
  3-way match (PO ⇄ ulazna faktura ⇄ otpremnica). Prioritet 4.0 `procurement`, VISOKA kompleksnost (statusni workflow,
  parcijalne isporuke, auto-numeracija sa posebnim brojačem za pneumatiku).

**Podklaster: kompleksnost VISOKA · prioritet: 2.0 delimičan „uvid" (MRP/nabavka), pun modul 4.0 `procurement` (ROADMAP domen #8).**

---

### 4. Trebovanja (interni zahtevi za materijalom / spona proizvodnja↔nabavka)

**`T_Trebovanja`** (28 kol.) — zaglavlje trebovanja.
- Kolone: `IDTreb` (PK), `Broj trebovanja`, `Datum trebovanja`, `Sifra komitenta`, `IDPredmet`, `IDTrebVeza`
  (samoreferenca — vezano trebovanje), **`VrstaTreb`**, `Poruceno`, `AvansnoPlacanje`, **`IDUpita`** (veza na upit
  dobavljaču), `Kurs`/`DevValuta`, `Zakljucano`, `Potpisano`.
- Broj redova: nije u zadatom setu.
**`T_Trebovanja stavke`** (bar 17 kol.) — `IDStavke`, `IDTreb`, `Sifra artikla`, `ZaliheKol`, `TrebKol`,
  `IsporucenaKolicina`, `UlazKol`/`IzlazKol`, `OcekivaniDatumIsporuke`/`DatumIsporuke`, `Isporuceno`, `IDPredmet`.
**`T_Trebovanja_ERNabavka`** (3 kol.) — spona trebovanja ↔ SEF ulazna faktura (`PurchaseInvoiceID`).
`T_TrebovanjaPratecaDok`, `AvUplateTrebovanja` — prilozi i avansne uplate (mali pomoćni).
- Veze: → `Komitenti`, `Predmeti`, `R_Artikli`, `T_UpitDobavljacu`, SEF.
- **Status u 2.0: GAP.** `T_Robna dokumenta.IDTrebZaProizvodnju` i `T_Robne stavke.IDStavkeTrebovanja` već referišu
  trebovanje. Prioritet 4.0 `procurement`/`inventory` (trebovanje je spona MRP → izdavanje materijala u proizvodnju).

**Podklaster: kompleksnost SREDNJA · prioritet 4.0.**

---

### 5. Maloprodaja (POS) + raster (veličine/boje)

**`T_MPDokumenta`** (35 kol.) — maloprodajni/POS dokument (račun na kasi).
- Kolone: `IDDok`, `IDProdavnica`, `IDKasa`, `IDKupac`, `IDRadniNalog`, `Vrsta dokumenta`, `Datum`, `Sifra prodavca`,
  `PrimljenNovac`/`PrimljeniCekovi`/`PrimljenaKartica`/`PrimljeniVirmani`/`Depozit`, `RabatProc`/`FiktRabat`,
  `Smena`, `BrojStola`, `Naplaceno`, `StampanFiskalno`, `BrojStampanja`, `DIVSynch`.
**`T_MPStavke`** (17 kol.) — `Sifra artikla`, `Kolicina`, `KalkulativnaMPCena`/`StvarnaMPCena`, `Taksa`,
  `TarifaRoba`, `Porudzbina`, `Pripremljeno`/`Izdato` (priprema robe), `DatIVremePripreme`.
**`T_MPDokumenta_Placanja`** (14 kol.) — načini plaćanja po dokumentu (`IDVrstaPlacanja`, `IDBanke`, `SerijskiBroj`,
  `Iznos`, `Realizovan`, `BrojTekucegRacuna`) — kartice/čekovi/virmani.
`T_MPStavke_Obrisane` — audit obrisanih stavki (ne portovati kao entitet).
- **Status u 2.0: GAP.** ROADMAP §„Van scope-a 2.0" eksplicitno: **POS ostaje u BigBit-u**. U 4.0 `sales` — ali POS je
  po analizi (`ROADMAP` — 26% bloat: „POS/knjigovodstvo/tuđi klijenti") kandidat da se **ne portuje** za Servoteh
  (Servoteh je proizvodnja, ne maloprodaja). **Prioritet NIZAK / verovatno van scope-a.**

**Raster (matrica veličina × vrsta, tekstil/obuća):**
- **`RasterDefZag`** (`IDRaster`, `Raster`, `OpisRastera`) — definicija rastera; **`RasterDefKolona`** (`IDRasterKolona`,
  `KolonaRastera`, `BarKodKolona`) i **`RasterDefVrsta`** (`IDRasterVrsta`, `VrstaRastera`, `BarKodVrsta`) — dimenzije
  matrice; `RasterDefStavkeKolona`/`RasterDefStavkeVrsta` — koje kolone/vrste pripadaju rasteru.
- **`RasterStavke`** / **`RasterMPStavke`** / **`RasterTrebovanjaStavke`** — količine po ćeliji (vrsta×kolona) vezane
  za robnu/MP/trebovanje stavku (`IDStavkeIzRobnog`/`IDStavkeIzTrebovanja`), `IDProizvodjaca`, `KutijaRaster`.
- **Status u 2.0: GAP.** Raster je maloprodajni koncept (veličine/boje) — **za Servoteh (proizvodnja) verovatno NIJE
  relevantan**. Prioritet NIZAK / van scope-a; odluka uz Negovana/Nesu (BACKEND_RULES §11).

**`OTKUP_Dokumenta`** (28 kol.) + **`OTKUP_Stavke`** (11 kol.) — otkup (poljoprivredni/sirovinski, sa poljima
`PMM`/`PSM`/`SomatskeCelije`/`Kiselost`/`ZadovoljenaMikrobiologija` — mleko). **Tuđi vertikal, van Servoteh domena.**
- **Status u 2.0: GAP · prioritet: NE PORTOVATI** (bloat/tuđi klijent).

**Podklaster: kompleksnost SREDNJA · prioritet NIZAK/van scope-a (POS, raster, otkup nisu Servoteh core).**

---

### 6. Carina / uvoz — domen `customs`

Iz `docs/migration/14-bigbit-carina.md`: BigBit **ne radi carinski obračun** (rade špedicija/JCI); koristi se samo za
Ino profakturu, normativ i izjave. `customs` u 4.0 = evidencija carinskog predmeta + eksterni JCI + **landed cost**.

**`CarinskeTarife`** (2 kol.) — `TarifniBroj` (PK text 12), `CarinskaStopa` (Double). Šifarnik tarifa → stopa.
- **Status u 2.0: GAP.** Doc 14 §5 kaže da carinska tarifa „**danas nedostaje u ERP-u, treba je uvesti**" — dakle i u
  BigBit-u je minimalna. Jeftino za port, prioritet 4.0 `customs`.

**`CarMagDok`** (44 kol.) — carinski magacinski dokument (uvoz/carinjenje).
- Kolone: `IDCM` (PK), `Ulaz`, `CM_Datum`, `CM_MagacinskiBr`, **`JCI`** (broj carinske deklaracije), `Kontrolnik`,
  `ObrKurs`, `Sifra komitenta`, `TransportDoGranice`/`TransportUZemlji`/`TransportBrFakt` (zavisni troškovi),
  `Koleta`/`BrutoKg`/`NetoKg`, `INOBrojFakt`/`INOVredFakt`, `DevValuta`, `Paritet` (Incoterms/Fco), `LCBroj`,
  `VrstaRobe`, `CIPrijave` (carinarnica), `IDMagacin`, `Odobreno`/`Zavrseno`.
**`CarMagStavke`** (20 kol.) — `Sifra artikla`, `Kolicina`, `DevCena`, **`CarTarifniBroj`**, `RedBrNaimenovanja`,
  `Tarifa`, `ArtKoleta`/`ArtBruto`/`ArtNeto`/`ArtM3`, `ZalihePreIzlaza`, **`InoNazivArt`**/`InoJmArt` (dvojezičnost).
- Veze: → `Komitenti`, `Magacini`, `R_Artikli`, `CarinskeTarife`.
- **Status u 2.0: GAP.** Nosi landed-cost polja (transport, koleta, bruto/neto) i JCI. Prioritet 4.0 `customs`.
  **⚠️ OTVORENO (ROADMAP §Carina):** ključ raspodele zavisnih troškova na artikle nije dokumentovan — intervju sa
  referentom uvoza (Tatjana) pre implementacije. Ne-implementirati unapred (BACKEND_RULES §11).

**Podklaster: kompleksnost SREDNJA-VISOKA · prioritet 4.0 `customs` (ROADMAP domen #8/9, zavisi od `inventory`+`procurement`).**

---

### 7. Proizvodnja na BigBit strani (≠ 2.0 proizvodni core)

**⚠️ Kritično razlikovanje:** 2.0 `WorkOrder`/`Operation`/`TechProcess` dolaze iz **QBigTehn** (shop-floor:
radni nalozi, operacije, tehnološki postupci, mašine). BigBit-ove tabele ispod su **komercijalno-materijalna
proizvodnja** (utrošak materijala → gotov proizvod, sa knjiženjem i normativima) — to je drugi sistem.

**`RadniNalozi`** (28 kol.) — BigBit radni nalog (servisno-vozilski registar!).
- Kolone: `IDRadniNalog` (PK), `BrojRadnogNaloga`, `NazivProizvoda`, `Kolicina`, `CenaProizvoda`, `IDInvestitor`
  (FK→Komitenti), `IDPredmet`, `Pozicija`, `SpecifikacijaRadova`, `DatumOtvaranja`/`DatumZatvaranja`, i vozilska
  polja: **`RegBroj`**, **`MarkaITip`**, **`BrojSasije`**, **`BrojMotora`**, **`BrojKM`**.
- Broj redova: **2.588**.
- **Status u 2.0: NIJE isto što i `WorkOrder`.** 2.0 `WorkOrder` (`work_orders`, „Was: tRN") je iz QBigTehn-a. BigBit
  `RadniNalozi` je **odvojen registar** koji referišu `T_Robna dokumenta.IDRadniNalog`, `T_Proizvodnja.IDRadniNalog`,
  `OP_Dokumenta`, `OTKUP`, `ZahteviZaNabavku`. **GAP** — u 4.0 treba odlučiti da li se BigBit `RadniNalozi` mapira na
  postojeći `WorkOrder`/`Project` ili ostaje zaseban komercijalni RN. (Vozilska polja sugerišu servisni modul —
  verovatno delom bloat.) Odluka uz Negovana/Nesu.

**`T_Proizvodnja`** (31 kol.) — proizvodni dokument (materijali → gotov proizvod).
- Kolone: `IDDok`, `Sifra komitenta`, `Vrsta dokumenta`, `IDMagacinDOK`, `IDTrebZaProizvodnju`, `IDDokUF`/`IDDokIF`/
  `IDDokUSL`/`IDDokUSLMAT` (veze na fakture/usluge/materijal), `IDRadniNalog`, `IDPredmet`, `Rezervisi`, `Potpisano`.
**`T_Proizvodnja stavke`** (14 kol.) — `Sifra artikla`, `Kolicina`, `Stvarna VP/MP cena`, `Tarifa`, `IDMagacin`,
  `IDPredmetStavka`, `Status`.
**`T_ProizvodnjaStavkeNormativi`** (10 kol.) — `IDStavke`, `Materijal`, `Sifra artikla`, **`UtrosenaKolicina`**,
  **`UtrosenoVreme`**, `IDMagacin`, `NabavnaCena` — normativ (utrošak materijala i vremena po stavci proizvodnje).
- Veze: → `Komitenti`, `Magacini`, `Predmeti`, `RadniNalozi`, `T_Trebovanja`, fakture.
- **Status u 2.0: GAP.** Ovo je „proizvodnja kao robno-materijalni/knjigovodstveni dokument" — komplementarno 2.0
  shop-floor jezgru. Prioritet 4.0 `inventory` (production costing).

**`T_Rastavnice`** (`OdSifArt` → `DobijaSeSifArt`, `Kolicina`, `Level`, `TezinaKGZaPrer`, `NCKoef`) — rastavnica
(jedan artikal → više artikala, prerada/kroj). **`T_Recepti`** (`ZaSifruArtikla`, `TrebSifraArtikla`, `Kolicina`,
`Level`) — recept/normativ (BOM za proizvodnju). **`SastavMaterijala`**, **`StvarniUtrosakSirovina`** — sastav i
stvarni utrošak.
- **Status u 2.0: GAP, ali koncept postoji drugačije.** 2.0 ima BOM iz PDM-a (`drawing_components`,
  `DrawingComponent` — „Was: KomponentePDMCrteza") i MRP eksploziju. BigBit `T_Recepti`/`T_Rastavnice` su
  **artikal-nivo BOM/normativ** (ne crtež-nivo). U 4.0 treba uskladiti: PDM BOM (2.0) vs artikal-recept (BigBit) —
  moguć dupli izvor sastavnice. **Odluka uz Negovana** (BACKEND_RULES §11).

**Podklaster: kompleksnost VISOKA · prioritet: delom preklapa 2.0 core (odluke potrebne), delom 4.0 `inventory`.**

---

### 8. Popis / inventura

**`T_Popis zaglavlja`** (14 kol.) — `IDPopis` (PK), `Datum`, `IDKomitent`, `IDMagacin`, `Serija`, `BrDok`,
  `IDDokIzRobnog` (veza na robni dokument nivelacije/knjiženja popisa), `Zakljucano`, `OJ`/`OD`/`Godina`.
**`T_Popis stavke`** (11 kol.) — `IDArtikal`, `Cena`, **`KolKng`** (knjigovodstvena količina) vs **`KolPop`**
  (popisana količina) → manjak/višak, `IDMagacin`, `Tarifa`, `NC`/`VPC`/`MPC`.
- Veze: → `Magacini`, `R_Artikli`, `T_Robna dokumenta`.
- **Status u 2.0: GAP.** ROADMAP §4 navodi **popis** kao deo `inventory` 4.0. Srednja kompleksnost, prioritet 4.0.

---

### 9. Tabela mapiranja BigBit → ServoSync 2.0

| BigBit tabela | Redova | 2.0 model / tabela | Status | Domen 4.0 | Prioritet |
|---|---|---|---|---|---|
| T_Robna dokumenta | (velika) | `GoodsDocument` / `goods_documents` | **cache (delimično)** | inventory/sales | KRITIČAN |
| T_Robne stavke | (velika) | `GoodsDocumentItem` / `goods_document_items` | **cache (delimično)** | inventory/sales | KRITIČAN |
| RobnaDokumentaMirror | — | `GoodsDocumentMirror` / `goods_documents_mirror` | **cache (MRP feed)** | inventory | (pomoćni) |
| RobneStavkeMirror | — | `GoodsDocumentItemMirror` / `goods_document_items_mirror` | **cache (MRP feed)** | inventory | (pomoćni) |
| T_MagStavke | — | — | GAP | inventory (komadna) | VISOK |
| T_MagDok | — | — | GAP | inventory | SREDNJI |
| T_MagVrsteDokumenata / T_MagProizvodjaci | — | — | GAP | inventory (šifarnik) | NIZAK |
| R_Vrste dokumenata | — | `DocumentType` / (lookup) | **cache (lookup)** | tax/finance (šeme knjiženja = gap) | VISOK |
| Cenovnik | 82.855 | `PriceListEntry` / `price_list_entries` | **cache (sinkuje se)** | masters/pricing | VISOK |
| Rabati / RabatiPoArt | — | — | GAP | sales/pricing | SREDNJI |
| Akcije / AkcijeArtikli | — | — | GAP | sales/pricing | NIZAK |
| Stavke nivelacije / MPStavkeNivelacije | — | — | GAP | inventory (nivelacija) | SREDNJI |
| ZahteviZaNabavku | 3.990 | (planirano `purchase_requests`) | GAP (spec spreman) | procurement | VISOK (2.0 uvid) |
| SpecifikacijaZahtevaNabavke | — | (planirano `_items`) | GAP | procurement | VISOK |
| ZahteviZaPonude | — | — | GAP | procurement | SREDNJI |
| T_UpitDobavljacu (+Stavke) | — | — | GAP | procurement | SREDNJI |
| DobavljaciZaArtikal | — | (logika u `MrpDemandItem.supplierId`) | **delimično (logika)** | procurement/masters | SREDNJI |
| OP_Dokumenta / OP_Stavke (porudžbenica) | — | — | GAP | procurement | VISOK |
| T_Trebovanja (+stavke, _ERNabavka) | — | — | GAP | procurement/inventory | SREDNJI |
| T_MPDokumenta (+Stavke, _Placanja) | — | — | GAP | sales (POS) | NIZAK / van scope |
| Raster* (Def/Stavke/MP/Trebovanja) | — | — | GAP | sales (maloprodaja) | NIZAK / van scope |
| OTKUP_Dokumenta / OTKUP_Stavke | — | — | GAP | — (tuđi vertikal) | NE PORTOVATI |
| CarinskeTarife | — | — | GAP | customs | SREDNJI |
| CarMagDok / CarMagStavke | — | — | GAP | customs (landed cost) | SREDNJI-VISOK |
| RadniNalozi | 2.588 | ≠ `WorkOrder` (odvojen registar) | GAP (odluka) | inventory/masters | SREDNJI (odluka) |
| T_Proizvodnja (+stavke, Normativi) | — | ≠ 2.0 shop-floor core | GAP | inventory (costing) | VISOK |
| T_Rastavnice / T_Recepti / SastavMaterijala | — | ≠ `DrawingComponent` (PDM BOM) | GAP (odluka) | inventory/produkcija | VISOK (odluka) |
| T_Popis zaglavlja / T_Popis stavke | — | — | GAP | inventory (popis) | SREDNJI |
| Magacini | 3 | `Warehouse` / `warehouses` | **cache (sinkuje se)** | masters | (već tu) |

Legenda: **cache** = read-only ogledalo u 2.0, puni ga isključivo sync modul (BACKEND_RULES §4); **GAP** = ne postoji
u 2.0; **≠** = 2.0 ima sličan koncept iz drugog izvora (QBigTehn/PDM), nije isti entitet.

---

### 10. Spona sa MRP modulom u 2.0 (uvid)

MRP u 2.0 (`MODULE_SPEC_mrp.md`) je već **funkcionalni most** iz ovog klastera ka proizvodnji, ali „uvid" (read-only):
- **Zalihe:** `MrpItemStock`/`_tmp` (`mrp_item_stock`) su **snapshot zaliha kao BigBit overlay** — izvedeno iz
  robnih pokreta (`GoodsDocument*` / mirror). Formula slobodnih zaliha: `Zalihe − Rezervisano` (MRP §3.1, 🔴).
- **Potrebe:** `MrpDemand`/`MrpDemandItem` (`mrp_demands`/`_items`) — potrebe iz BOM eksplozije; stavka nosi
  `supplierId` + `leadTimeDays` (= BigBit `DobavljaciZaArtikal.Primarni`/`VremeIsporuke`) i `toProcureQuantity`.
- **Veza ka nabavci:** `SpecifikacijaZahtevaNabavke.IDPlanStavka` i `T_Robne stavke.IDStavkeTrebovanja`/`IDPlanStavka`
  u BigBit-u zatvaraju krug plan → zahtev → trebovanje → robni ulaz. U 2.0 to je `purchase_requests` (planirano, čeka
  §11.3 BOM CTE + anti-ciklus guard).
- **Zaključak:** MRP je „pipak" 2.0 u BigBit robno-nabavni klaster. Kad 4.0 preuzme `inventory`+`procurement`,
  MRP prelazi iz „uvid nad tuđim podacima" u „vlasnik toka" (potreba → plan → PO → prijem → zalihe interno).

---

### 11. Preporuke za pripremu domena (4.0)

1. **Redosled = ROADMAP §Domeni 4.0 (odozdo naviše):** `masters` → `tax`/GL → **`inventory`** (robna dokumenta,
   kalkulacija, komadna evidencija, nivelacija, popis) → `sales`+`sef` → `banking` → **`procurement`+`customs`**.
   Robno-materijalno (`inventory`) je temelj — sve ostalo (nabavka, carina, prodaja) se na njega naslanja.
2. **Jedan dokument-model sa tipom** (ne tabela-po-vrsti): `T_Robna dokumenta` + `R_Vrste dokumenata.UticeNaZalihe`/
   `Sema za kontiranje` pokazuju da je BigBit već „jedan model + tip + posting rules". Preneti tako (ROADMAP §Model
   dokumenata), a **šeme za kontiranje** (`Sema za kontiranje`, `Stavke seme...`) ekstrahovati iz Access imenovanih
   upita (ROADMAP §„Korak 0 — ekstrakcija Access upita" — tamo živi većina posting logike, NE u VBA izvozu).
3. **Novac/količine → `Decimal`.** BigBit `Double`/`Currency` cene u `T_Robne stavke`/`T_MPStavke` moraju u `Decimal`
   pri prelazu cache → vlasništvo (2.0 ih trenutno drži `Float` samo radi pariteta sa izvorom).
4. **Landed cost je 🔴 otvorena stavka:** `T_Robna dokumenta` (Carina/Spedicija/OstaliZavTros) i `CarMagDok`
   (transport/koleta/bruto-neto) nose ulaze, ali **ključ raspodele zavisnih troškova na artikle nije dokumentovan** —
   intervju sa referentom uvoza (Tatjana) PRE implementacije kalkulacije. Ne-implementirati unapred (BACKEND_RULES §11).
5. **Statusi kao editabilan šifarnik, ne enum/hardkod:** `T_Statusi` + `IDStatus` na zahtevima/upitima — preneti kao
   String status sa dozvoljenim vrednostima u `///` (BACKEND_RULES §2) + konfigurabilnu „Tabelu statusa".
6. **Razjasniti dupli izvor sastavnice (odluka Negovan):** BigBit `T_Recepti`/`T_Rastavnice`/`SastavMaterijala`
   (artikal-nivo BOM) vs 2.0 `DrawingComponent` (PDM/crtež-nivo BOM). Odlučiti koji je izvor istine za MRP eksploziju
   u objedinjenom sistemu — inače dupla/konfliktna sastavnica.
7. **Razjasniti `RadniNalozi` (BigBit) vs `WorkOrder` (2.0/QBigTehn):** dva odvojena RN registra sa istim imenom.
   Robna dokumenta/proizvodnja/nabavka u BigBit-u vezuju BigBit `IDRadniNalog`. Mapirati na `WorkOrder`/`Project`
   ili držati zaseban komercijalni RN? (Vozilska polja `RegBroj/BrojSasije/BrojMotora` sugerišu servisni podmodul —
   proveriti da li je Servoteh core ili bloat.)
8. **Isključiti iz scope-a (bloat/tuđi vertikal):** `OTKUP_*` (otkup mleka), `Raster*` (veličine/boje — maloprodaja),
   `T_MP*` (POS) — ROADMAP već identifikuje POS/tuđe klijente kao ~26% bloat-a; potvrditi sa Nesom da Servoteh ove
   tokove ne koristi pre nego što se uopšte planiraju.
9. **Šifra Proizvođača vs Dobavljača** (doc 13 §5, pravilo 7): `DobavljaciZaArtikal` + `IDProizvodjaca` na mag/raster
   stavkama → modelirati mapiranje artikal ↔ (proizvođačka šifra, dobavljačke šifre) u `masters`/`procurement`.
10. **3-way match kao prvoklasni tok:** `OP_Stavke` (Naručena/Otpremljena/Isporučena) + `T_Robne stavke.ID_PO` +
    veza na ulaznu fakturu (`IDDokUF`) → u 4.0 `procurement` pravi statusni workflow (state machine), ne razbijeni
    checkbox-i (`Poruceno`/`Isp.`) kao u legacy-ju.

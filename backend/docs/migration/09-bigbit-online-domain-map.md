# BigBit OnLine VBA -> ServoSync 4.0 domeni - mapa modula

> Izvor: read-only analiza **izvučenog VBA izvora OnLine BigBit aplikacije** (`BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/`, 824 komponente, van gita) — moduli (`Module__*`), klase (`Class__*`), forme i izveštaji (`Doc__Form_*` / `Doc__Report_*`) MS Access / VBA front-enda komercijalnog ERP-a **BigBit OnLine** (autor Slaviša Đurić / BIT CO., Rev 9.6.x).
> **Svrha:** vodič za **ServoSync 4.0** (apsorpcija BigBit-a — [ROADMAP §4.0](../ROADMAP.md)): koji legacy VBA modul pokriva koji 4.0 domen, šta se **prenosi** (poslovno/regulatorno pravilo), šta se **prepisuje** (infra/UI plumbing), šta se **baca** (van scope-a). Ništa u legacy kodu nije menjano — čista analiza za planiranje.
> **Dopunjuje:** [07 §8](07-bigbit-sef-efaktura.md) (definitivni SEF spec iz istog VBA izvora) i [10](10-bigbit-glavni-meni.md) (navigaciona mapa žive aplikacije). Analog za proizvodni core je [08](08-qbigtehn-vba-domain-map.md) (QBigTehn → 2.0).

## Kontekst iz ROADMAP-a

4.0 apsorbuje BigBit: njegove funkcije (komitenti, artikli, cenovnik, robna dokumenta, GK, PDV, fakturisanje, banke, SEF) prestaju da budu eksterni „izvor istine" i **rebuild-uju se u ServoSync domene** — `inventory`, `finance`/GL, `sales`, `procurement`, `sef`, uz `tax` (PDV/POPDV) i `banking`. Ukida se `bigbit-sync` most iz 2.0 (matični podaci više ne dolaze spolja). Ovo je **najveći regulatorni/računovodstveni domen** (fiskalizacija RS, SEF eFaktura, PDV/POPDV, KEPU) i pokreće se **trigerima, ne rokom** (prestanak vendor podrške, regulatorne promene, potreba za objedinjenim izveštavanjem). Preduslov je stabilna 3.0 platforma.

## Kako čitati

- **Kolone tabela:** `VBA modul` · `šta radi` · `4.0 meta (domen/tabela)` · `napomene za prenos`. Imena modula su bez putanje i `.txt` sufiksa.
- **4.0 domeni:** `sales` (fakturisanje/prodaja) · `procurement` (nabavka) · `inventory` (magacin/robna dokumenta) · `finance`/GL (glavna knjiga) · `tax` (PDV/POPDV) · `banking` (banke/plaćanja) · `sef` (eFaktura + fiskalizacija). 🔴 = **regulatorno** pravilo (mora preživeti prepisivanje).
- **Ključno arhitektonsko pravilo (kroz ceo dokument):** BigBit-ova prava poslovna logika je **retko u VBA** — VBA forme uglavnom samo pokreću **Access imenovane upite** (`DoCmd.OpenQuery "..."`) i mapiranje dokument→konto drži tabela `Sema za kontiranje` + string-izraz `Eval()` engine. Sadržaj tih upita **NIJE u ovom izvozu** i mora se izvući iz `.accdb`/`.mdb` pre migracije. VBA je često samo okidač i UI.
- **Legacy anti-paterni koje 4.0 zamenjuje:** ručna auto-numeracija (`DCount+1`/`DMax+1`, race condition), hardkodovane PDV stope po datumu, `Eval()` nad korisničkim string izrazom, operacije bez transakcije, `On Error Resume Next` koji guta greške, fiksni bankarski/fiskalni tekst-formati, globalno mutabilno stanje (singleton `BBCFG`). Napomene ispod ističu **pravilo** koje se prenosi, ne mehaniku koja se baca.

---

## 1. Fakturisanje — `sales`

Jezgro komercijale (~45 fajlova). Centralna tabela `T_Robna dokumenta` (zaglavlja izlazne IF i ulazne UF razlikuju se samo poljem `[Ulaz]` Yes/No) + `T_Robne stavke`; usluge u `T_Usluge dokumenta`; profakture u `Profakture`. Tok: profaktura/ponuda → knjiženje (append upiti) u račun / ulaz / trebovanje / proizvodnju preko fabrika `KreirajRobniDok/KreirajProfakturaDok/...` + `DodajStavke*`.

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Doc__Form_Izlazna faktura` | Glavna forma IF/otpremnice/računa: zaglavlje, komitent/cenovnik/magacin, broj dokumenta, štampa, zaključavanje, okidači knjiženja | `sales` (+`inventory`,`sef`,`tax`,`banking`) | 🔴 **NUMERACIJA — TRI konkurentna algoritma** (`Parametri za rad`.[Poslednji broj]+prefiks; `1+Max` iz `MaxBrojDokPoVrstama`; `SledeciBrojDokumenta`), svi race-condition → 4.0 **DB sekvenca po (vrsta,godina)**. `Form_BeforeUpdate` **blokira snimanje ako PIB neispravan** (`DobarPIB`, osim `NeProveravajPIB`). RUC upozorenje ako razlika u ceni <25%. Zaključavanje (`Z_Zakljucaj_IF`) → immutable. `PrimeniKurs` množi stavke kursom. Fiskalni račun samo za MP1/MPS |
| `Doc__Form_Profaktura` | Ponuda/predračun (PON) → pretvaranje u izlazni/ulazni dok, novu profakturu, potvrdu porudžbine | `sales` (quote→order→invoice) | Izvorni dokument iz kog se „knjiženjem" generišu robni dokumenti (`DodajStavkeURobniDok(...,'StavkeZaNaknjizavanje',...)`). PON numeracija = globalni brojač `BrojSvihDokumenataPoVrstama`. `PodeliDokumentUDokumente(IDDok,50)` deli veliki dok na komade po 50 stavki (SEF/štampa limit). Ključni tok za 4.0 quote→order→invoice |
| `Doc__Form_OP_Fakturisanje` | Masovno (batch) fakturisanje: po jedna faktura po komitentu iz otpremnica za period | `sales` (consolidated billing) | Petlja po komitentima → `OP_KreirajRobniDok`+`OP_ProknjiziStavkeURobniDok`. Grupisanje po **kupac+MISP**, veza faktura↔otpremnica (regulatorno-referentna). Cenovnik MP*⇒sa PDV/rabat 0; STDCN⇒bez PDV/rabat 10% |
| `Doc__Form_USLUGA Faktura` | Faktura usluga: numeracija, veza sa robnom/drugom uslugom, avansi, eFaktura, štampe | `sales` (usluge), `sef` | Usluge = poseban tok **bez inventory efekta**. Paralelna numeracija (`SledeciBrojDokumentaUsluga`). `DatumPrometa` **zaseban** od datuma dokumenta (PDV period). eFaktura preko `ER_Export_OtvoriFormuZaDok 'T_Usluge dokumenta'` |
| `Class__IF_Class` | Data-provider izlazne fakture za report/eFaktura (prodavac, magacioner, tekst, PDV flag) | `sales` (+`tax`,`sef`) | `CheckProdajaSaPDV` iz `R_Vrste dokumenata.[Prodaja sa PPP]` — **vrsta dokumenta određuje da li ide sa PDV**. `Kategorija_PO`/`Oznaka_PO` = **poreske kategorije za SEF** (S/AE/O/E/Z + osnov oslobođenja) → FK na šifarnik. Potpisni blokovi (vozač/l.k.) — na modernoj fakturi nepotrebni |
| `Class__Prof_Class` | Profaktura: kontakt-osoba + `KoeficijentRezervacije`/`IDPredmet` | `sales` (predračun) | Kontakt-osobe (`KomitentiKontaktOsobe`, 1:N, `KontaktDefault`) → zaseban entitet u 4.0. `KoeficijentRezervacije` = broj otvorenih dokumenata istog predmeta (raspodela rezervacija) |
| `Class__USLF_Class` | Kontekst fakture usluga (vidljivost datuma prometa, PiP) | `sales` (usluge) | `DatumPrometa` zaseban (PDV period usluga); `TekstZaFakturu` slobodan opis |
| `Doc__Form_ProknjiziStavkeIzProfaktureuIzlazni` | Tanak wrapper koji pokreće imenovani append-upit i osvežava podformu | `sales`/`inventory`/proizvodnja | ⚠️ **ZAMKA:** sve transformacije stavki (profaktura→izlazni/trebovanje/proizvodnja) su **Access IMENOVANI UPITI** (`ProknjiziStavkeIzProfaktureUIzlazni`, `Trebovanje_UpisiStavkeProfakture`…) koji **nisu u VBA** — mapiranje kolona/količina/cena mora se rekonstruisati iz `.accdb` |
| `Doc__Form_StavkeZaKnjizenjeIzProfuIF` | Priprema TMP tabele stavki za knjiženje profakture i količine za trebovanje | `inventory`,`sales` | **Algoritam alokacije:** `KolicinaZaTrebovanje = min(TrenutneZalihe, RezervisanaKolicina)` uz kumulativno oduzimanje istrebovanog kroz sortiran recordset (`Round` na `F_BrDecIzKl`). „LosiArt" izveštaj = artikli koji bi otišli u minus. Radi preko TMP MDB — u 4.0 transakcioni upit |
| `Doc__Form_ProknjiziIRaspodeliStavkeUProfakture` | Raspodela ulaznih stavki na više dokumenata rezervacije po predmetu | `inventory` (rezervacije), `sales` | Alokacija zaliha na projekte/predmete (`KoeficijentRezervacije` = broj dokumenata istog predmeta+vrste) |
| `Doc__Form_Z_Zakljucaj_IF` | Zaključavanje IF (+ `Z_Otkljucaj_*`) | `sales`/`finance` | 🔴 Zaključan račun → `AllowEdits/Deletions=False`. `ZakOtkDok` postavlja `Zakljucano`. 4.0: status dokumenta (Draft/Issued/Locked) + audit; izdat/poslat na SEF se **ne sme menjati** (samo storno/knjižno odobrenje) |
| `Doc__Form_PodesavanjeBrojaFakture` | Podešavanje početnog broja fakture/profakture | `sales` (config numeracije) | Format broja (prefiks + 4 cifre + sufiks „/godina") u `Parametri za rad` → u 4.0 konfigurabilne sekvence sa godišnjim resetom |
| `Doc__Form_ER_Export` | UI okidač slanja izlaznih u SEF (`ER_ExportUSEF`, `sendToCir`) | `sef` | `sendToCir` = slanje u **Centralni registar faktura** (javni sektor). Detalji u §2 |

---

## 2. SEF / eFaktura — `sef`

Ovo je definitivno dokumentovano u **[07 §8](07-bigbit-sef-efaktura.md)** iz istog VBA izvora; ta analiza **potvrđuje §8 1:1** (transport/API sloj) i dodaje ono što §8 ne pokriva. 8 ključnih fajlova (~250KB); `Module__SEF_Common` (88KB, ~2170 linija) je najveći i najvredniji. Transport = nizak rizik (standardni javni SEF API, throttle 3 req/s); **UBL parsiranje/mapiranje i auto-knjiženje ulaznih faktura u zalihe** su netrivijalni i vezuju SEF za `procurement`+`inventory`.

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Class__ER_API_Class` | HTTP klijent za SEF (`MSXML2.XMLHTTP`, sinhroni): GET/POST wrapperi + auth + rate-limit | `sef` (`SefApiClient`) | Potvrđuje **§8.1**. `ER_API_URL`/`ER_ApiKey` iz configa → u 4.0 **env, ne kod** (demo ključ u komentaru je mrtav). 🔴 **Throttle: MFIN max 3 kmd/s** (`ER_BrojKomandePoRedu Mod 3`) — obavezno preneti (p-limit/queue). ⚠️ `POST_CMD` gradi query pogrešno (dva `?` u URL-u) — **ne kopirati doslovno**, koristiti pravi query builder |
| `Module__ER_API_Common` | IZLAZNE fakture: slanje, statusi, storno/cancel, provera reg. firme, requestId, lock-check | `sef` (`SefOutbox`) | Potvrđuje **§8.2**. **NOVO:** (1) `requestId` = deterministički **idempotency ključ** `<IDFirma>-<KodTabele>-<IDDok>-<IDProdavnica>-<IDKasa>` skraćen na 32 znaka (`KodTabele`: 01=Robna, 02=Usluge, 03=MP, 04=CMDok_Izlaz, 00=ostalo) — preneti šablon. (2) `ER_DokZakljucanUSEFu` = **guard protiv duplog slanja** (`DLookup ZakljucanUSEFu` u `T_ER_StatusDokumenata`) → 4.0 unique/locked flag. (3) ⚠️ **guard `MozeDaSeStornira/Otkaze` su NEUTRALISANI** (uslovi zakomentarisani, „niko ne zna kad može pa pretpostavljamo uvek") — **NE preuzimati kao pravilo**, implementirati pravu SEF eligibility po zvaničnoj spec. JSON: storno=`{stornoComment}`, cancel=`{cancelComments}` |
| `Module__SEF_API_Common` | ULAZNE fakture (transport): promene/ids/status/UBL XML/prihvati-odbij/PDF | `sef` (`SefInbox`) | Potvrđuje **§8.3**. Accept/reject JSON: `{invoiceId, accepted:"True"/"False" (STRING, ne bool!), Comments}`. PDF prikaz: UBL→base64→`DecodeBase64`→`.PDF` → u 4.0 **server-side XML→PDF render**. ⚠️ `retVal` se postavi na True pa se nikad ne ažurira iz `POST_CMD` (greške se tiho gube) — u 4.0 **obavezno proveravati HTTP status** |
| `Module__SEF_Common` | **Najveći/najvredniji** (~2170 lin.): ručni UBL XML parser, staging u TMP, node→kolona mapiranje, **auto-knjiženje ulazne fakture u robni dokument (prijem) + kreiranje nivelacije** | `sef`+`procurement`+`inventory` | ⚠️ **§8 ovo NE pokriva** (§8 kaže samo „parse→lokalne tabele"). Stvarnost: BigBit iz ulazne SEF UBL fakture **automatski kreira robni dokument prijema** (`KreirajSEFRobniDokument`→`ProknjiziSEFRobneStavke`) i **nivelaciju cena** (`SEF_KreirajNivelaciju`+`DefinisiProdajnuCenu` iz min RUC-a, cenovnika, zaliha) — **SEF-inbox vezan za procurement+inventory, nije izolovan**. UBL parser je ručno pisan (`NazivKolonaZa*`); za 4.0 pravi UBL 2.1 parser ALI **preneti mapiranje polja i tip-kodove**. `SEF_TipDokumenta`/`PrevediSEFStatusZaPotrebeFirme` = mapiranje SEF tipova/statusa na interne |
| `Class__SEF_Class` | Data-model ulazne fakture (PurchaseInvoiceId/SalesInvoiceId/InvoiceId, status, dobavljač PIB→šifra) | `sef` (`sef_inbox` entitet) | Potvrđuje **§8.4**. `T_ER_DokumentaNabavke` (hardkodovano). Watermark za polling = `LastModifiedUtc`. Dobavljač: **PIB→`Komitenti.Sifra`** (`DLookup`) — ⚠️ dupli/prazni PIB lome mapiranje. 4.0: `sef_inbox` + `sef_status_log` |
| `Class__ER_Class` | Data-model + **UBL builder za IZLAZNE** (56KB, najveća klasa): TaxTotal po stopama, rabati (`AllowanceCharge`), avansi (`BillingReference`/`PrepaymentAmount`), prilozi (base64) | `sef` (`sef_outbox` + UBL builder) | 🔴 **REGULATORNO JEZGRO.** Knjižno odobrenje → `<CreditNote>` (`ER_KnjiznoOdobrenjeOBA` odlučuje), faktura → `<Invoice>`. Avans preko `cac:BillingReference` (broj+datum iz `EDI_ER_AVR`). PDV total po stopama iz `tmp_EDI_ER_PDVTotalPoStopama` sa `IDKategorijaPO`. ⚠️ XML se gradi **konkatenacijom bez escaping-a** + ručni UTF8 → u 4.0 **pravi UBL serializer/validator** (CIUS/EN16931 XSD). Prilozi max 3. Za pun izlazni field-mapping **pročitati OVU klasu detaljno** (nije iscrpno gledana) |
| `Doc__Form_ER_DokumentaNabavke` | UI: pregled/rad sa ulaznim SEF fakturama (preuzmi, prihvati/odbij, knjiži) | `frontend` (sef inbox) | Izvor istine za operativni tok (ko preuzima/odobrava) koji §6.3 navodi kao otvoreno pitanje. Manje kritično za backend port |
| `Doc__Form_VPRacunGledaj` · `Module__FP_*` | Fiskalizacija (VP i MP) — vidi **§7 (Kasa/POS)** | `sef`/fiskalizacija | Fiskalni račun (ESIR/L-PFR) ≠ SEF eFaktura — razdvojiti (B2C fiskal vs B2B/B2G eFaktura) |

---

## 3. Magacin / Robna dokumenta — `inventory`

Jezgro: par zaglavlje+stavke (`Robna dokumenta`/`T_Robne stavke`), isti obrazac za magacinske dokumente (`T_MagDok`), popis, nivelaciju. Tok: kalkulacija (Ulazna faktura) → naknjižavanje → lager/kartica artikla (prosečne cene) → KEPU/Trgovačka knjiga → PDV → SEF. **Poslovna logika je razbacana između VBA i stotina Access upita.**

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Module__KreiranjeDokumenata` | **Fabrika svih robnih/magacinskih dokumenata i stavki** (`KreirajRobniDok`, `DodajStavke*`, `KreirajProfaktura/Usluga/Trebovanje/MAGDok`, `KreirajNalogGK`) | `inventory` (jezgro) + grane `sales`/`procurement`/`finance` | 🔴 **KRITIČNO:** broj = `1+DLookup(Max,...)` → race → 4.0 **DB sekvenca po (vrsta,godina,firma)**. **Nema transakcije oko zaglavlje+stavke** → moguća polu-kreirana dokumenta → obavezno umotati. Stavka nosi 8+ cenovnih polja (Nabavna neto, Zav. trošak sopstveni/dobavljač, Kalk. VP/MP, Stvarna VP/MP, KNGCena, Taksa, Rabat, Kasa) + duple PDV flegove (roba-ulaz/izlaz/usluge) — model stavke 4.0 mora ovo pokriti ili eksplicitno izostaviti. `Datum valute = DatumDok + Komitenti.Odlozeno`. ⚠️ Nazivi polja sa duplim razmakom (`Obracunat  porez`). `MAGDok` razbija ploče na komade (Servoteh: `Duzina/Sirina/Kutija`, gustina čelika). Error handling `MsgBox:Resume Next` — ne preslikavati |
| `Module__Uskladjivanje prodaje` | **Metod obračuna zaliha** — prosečna nabavna/VP cena, upis u prodaju, provera neg. zaliha | `inventory` (weighted-average) | 🔴 Prosečna ponderisana: prolaz kroz recordset sortiran po artiklu+datumu; ULAZ akumulira `StanjeNabVred`; prosek=`StanjeNabVred/StanjeKol`; IZLAZ upisuje tekući prosek samo za period. `DaLiImaNegZalihe` mora proći pre popravke. ⚠️ Unutar `BeginTrans`+interaktivni `MsgBox Yes→Commit/No→Rollback` (destruktivno) → u 4.0 deterministički servis. **Prosečna cena je regulatorno prihvatljiv metod** — implementirati nad kretanjima |
| `Module__Nivelacija` | Nivelacija (preračun zaliha na novu prodajnu cenu) — regulatorno za MP | `inventory` (+`tax`/`finance`) | 🔴 Kad se promeni prodajna cena robe na zalihama, zakonski dokument nivelacije knjiži razliku. Prag: knjiži samo ako `Abs(StaraVP−NovaVP)≥0.01`. Vezati za KEPU (razlika u ceni → razduženje MP). Zaseban tip dokumenta sa parom (stara,nova) cena po stavci |
| `Module__POPIS` · `Doc__Form_Unos popisa` | Popis/inventura: unos listi, punjenje stanja iz knjigovodstva, knjiženje razlika (viškovi/manjkovi) | `inventory` (inventura) | 🔴 Godišnji popis: snapshot knjigovodstvenog stanja + unos stvarnog → auto ulazni (VIŠKOVI) / izlazni (MANJKOVI) dokument. `CenaZaUpisUPopis` definiše 7 cenovnih baza (Nabavna neto/bruto, Kalk./Stvarna VP/MP, CENOVNIK). Logika viškova/manjkova u Access upitima |
| `Module__LastParKalk` | Priprema tabele poslednjih kalkulativnih cena artikla (make-table) | `inventory` (last cost) | Logika u 2 Access upita → u 4.0 view „last calculation per article". Signal da se poslednja nabavna cena koristi kao default pri izlazima |
| `Module__PodeliDokNaViseDok` | Deljenje dokumenta na više (serijska proizvodnja: 50 dok/rezervacija sa `/i`) | `inventory` (rezervacije) | `Level>=250` = profaktura/rezervacija (marker kroz ceo sistem). Logika deljenja količine u upitu. U 4.0 rezervacija = **status na stavci**, ne kopija dokumenta |
| `Module__BBDetaljnoDok` | Rutiranje „otvori izvorni dokument" iz bilo koje stavke | `inventory` (drill-down UX) | Taksonomija: `Ulaz`→Ulazna faktura; izlaz `Level>=250`→Profaktura; `Vrsta naloga Like 'BLAG*'`→Blagajna, inače GK. Potvrđuje `Level>=250`=profaktura globalno |
| `Module__Proizvodnja` | Trebovanje sirovina + knjiženje gotovih proizvoda (Servoteh) | `inventory` + proizvodnja (MES) | **Dodir sa ServoSync 4.0 proizvodnjom.** Trebovanje = izlazni dok (`TREB`/`TRPR`) po prosečnoj nab. ceni; GP ulaz: `KalkMP=NabGP*(1+PDV/100)`; prodaja GP sa rabatom ograničenim na `MaxRabatProc`. Receptura/cena koštanja u upitu `PRZ_CenaKostanjaGP` — preneti sastavnice iz upita |
| `Doc__Form_Ulazna faktura` | **Kalkulacija/prijem** — ulazna tačka celog toka robe; iz nje: izlazni dok, MP ulaz, trebovanje za proizvodnju, uvoz, rezervacije | `procurement`+`inventory` (+`sales` veza) | 🔴 `Form_BeforeUpdate`: obavezni broj/datum/nalog + **validan PIB**. **Kalkulacija zavisnih troškova uvoza:** `KoefZTDob=(Carina+Spedicija)/(ObrKurs*DevVredFak)`, `KoefZTSop` + korekcija kursa zbog PDV/carine — algoritam nabavne cene (marže, KEPU). Naknjižavanje preko imenovanih upita (`StavkeZaNaknjizavanje`…) |
| `Doc__Form_IzlazMagStavke` / `IzlazMagZagDok` | Magacinski izlaz (izdavanje ploča/komada), veza na trebovanje/uslugu; rezervacija pozicija | `inventory` (izdavanje, komadna evidencija) | Pre izlaza **obavezna provera zaliha**; posle kreiranja **zaključava** (`ZakOtkDok 'T_MagDok'`); sprečava dupli izlaz. Komadna/pločasta evidencija (`Duzina/Sirina`) = Servoteh zahtev |
| `Doc__Form_Kartica artikla` | Karton artikla — analitička evidencija kretanja/stanja po artiklu/magacinu/levelu; popravka prosečnih cena | `inventory` (stock ledger) | Tri cenovne kolone (Nabavna/Fakturna/VP) → u 4.0 jedan model kretanja sa izborom kolone. Preknjižavanje sa artikla na artikal menja istoriju → u 4.0 merge/ispravke sa audit tragom |
| `Doc__Form_Knjiga KEPU` · `Module__TK_KEPU_MP` · `Module__NKEPU` | Regulatorne knjige (KEPU VP/MP, Trgovačka) — vidi **§5 (PDV/knjige)** | `tax`/`inventory` | 🔴 Detalji i algoritmi u §5 i §8 (Regulatorna pravila) |
| `Module__BRISANJE` | Reset baze — daje **potpun katalog tabela sistema** | referentni ER model | `ObrisiBazuZaNovogKorisnika` lista = najbolji popis transakcionih+matičnih tabela za mapiranje 4.0 šeme. Par `Robna dokumenta` (staro) vs `T_Robna dokumenta` (novo, MSSQL-linkovano) koegzistira |

---

## 4. Glavna knjiga — `finance` / GL

Srednje-velik, regulatorno gust. Logika knjiženja **nije u VBA** — VBA pokreće upite (`NSK_ProknjiziStavkeIzRobnog`, `SKProknjiziZaglavljaNalogaIzRobnog`, `OS_ProknjiziOtpis`), a dokument→konto drži `Sema za kontiranje` + `VredIzraza` engine.

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Module__SemaZaKontiranje` | **Srce auto-knjiženja** — string-izraz engine (slova A..Z→vrednosti kolona→`Eval()`) za dugovnu/potražnu stranu | `finance`/GL (posting rules) | 🔴 **Ključno pravilo cele GK.** Legenda A–K (A=nabavna neto, C=zav. trošak oporeziv, D=ukalk. RUC, G=kalk. VP bez poreza, J=porez u fakturi, K=kalk. porez MP…) je **najbolja dokumentacija značenja kalkulacije** — sačuvati. ⚠️ `Eval()` nad korisničkim izrazom = injection zamka → u 4.0 **bezbedan expression parser / tipizirani posting rules**. Tabela `Sema za kontiranje` **nije u izvozu** — obavezno izvući |
| `Module__KreiranjeDokumenata` (GK deo) | `KreirajNalogGK` — zaglavlje naloga sa auto-brojem po vrsti | `finance`/GL (journal header) | `BrojNaloga=1+DLookup(...'BrojNalogaPoVrstama')`→race → 4.0 sekvenca po (firma,vrsta,godina). `Level` = nivo firme (konsolidacija/multi-tenant) provlači se kroz sve GK objekte |
| `Module__ZR` | Završni račun (bilans stanja/uspeha) — rekurzivni parser AOP izraza (`D202*+P433*−D021*`) + XML export za APR | `finance`/GL (bilansi) + regulatorni export | 🔴 XML: `Vrsta_Posla 750`, JMB/PIB, Period, `Kodeks_19..26` (APR obrasci). AOP definicije = **podaci** (`ZR_*` tabele) → migrirati kao konfiguraciju. Krhak DSL → u 4.0 eksplicitno mapiranje pozicija→{konto-maska, strana, znak} umesto string `Eval` |
| `Module__OS` | Osnovna sredstva: amortizacija + revalorizacija (računovodstvena i poreska po grupama) | `finance`/GL (fixed assets) | 🔴 Revalorizacija od 01.01.2002 **od meseca NAKON nabavke**; poreska amortizacija prag „5 prosečnih zarada". Revalorizacija je danas **mrtva** — preneti **stanja** (`OS_Stavke`), algoritam samo za rekonstrukciju istorije. Knjiženje preko `OS_Proknjizi*` upita |
| `Module__Kamate` | Obračun kamate na otvorene stavke (konformni metod) | `finance`/GL + `banking` | 🔴 Vidi §6 (Banke) — isti modul; konformni metod, više varijanti funkcije (utvrditi aktivni put) |
| `Module__APGK` | Razbijanje iznosa naloga na PDV osnovicu/PDV (oba smera) + drill | `finance`/GL + `tax` | Most GK→PDV knjige (KUF/KIF). `PDVOsnovica` flag: osnovica→PDV ili PDV→osnovica; `Round(.,2)` |
| `Module__Otvorene stavke` | Dugovni iznos za zatvaranje na kontu kupca | `finance`/GL (open-item) | Tanka; prava logika vezivanja uplata/faktura u Access upitima/`OTST Pojedinacno` |
| `Module__Bliski susret` | Parametri firme + kontni preseci + feature flagovi knjiženja (`F_GKPoKursu`, `F_KepuPo...`) | `finance`/GL config + cross-cutting | `KontoKupca`/`KontoDobavljaca` + prekidači koji menjaju **algoritam** knjiženja (po kursu/obrnuto/knjiži razlike/nabavna vs KNG). U 4.0 „company settings" + chart-of-accounts mapping. `Level`/`NivoBaze` = multi-firma. Config keširan u modul-singleton (paziti invalidaciju) |
| `Doc__Form_NSK_Knjizenje` | **Motor knjiženja** robno→GK (auto-otvori naloge + knjiži stavke; brisanje po uslovu) | `finance`/GL (posting run) | **Najvažnija forma za razumevanje toka.** Logika u `NSK_OtvoriNalogeIzRobnog`/`NSK_ProknjiziStavkeIzRobnog`/`NSK_Obrisi*` (nisu u VBA — izvući). ⚠️ Knjiženje+brisanje bez transakcije (`SetWarnings False`) → u 4.0 **atomska, idempotentna** operacija + audit |
| `Doc__Form_APGK` | Hub „Analiza prometa GK" + PDV knjige (dnevnik, bruto salda, KUF/KIF, PP-PDV, PDV šema konta) | `finance`/GL izveštaji + `tax` | 🔴 Generiše `APGK_PDVUF`(KUF)/`APGK_PDVIF`(KIF), PP-PDV report, PDV šema konta — sve Access upiti/reporti (logika u bazi) |
| `Doc__Form_Bruto stanje` · `Kartica konta` · `Analiticka kartica` · `Otvorene stavke analitike` · `Dnevnik glavne knjige` | Bruto bilans, kartica konta, saldo-konto kupaca/dobavljača (AR/AP), aging, dnevnik knjiženja | `finance`/GL izveštaji | 🔴 Dnevnik = zakonska knjiga (hronološki). Devizne varijante (`InoBrutoStanje`, `InoKarticaKonta`) → u 4.0 jedan model sa valutom. Analitička kartica pokreće kamatni obračun (§6). `Level` filter svuda |
| `Doc__Form_OS_Obracun` · `OS_Obracun revalorizacije` | Poreska amortizacija (Obrazac OA) + računovodstvena/revalorizacija | `finance`/GL | 🔴 Obrazac OA (poreski bilans), REV-5/5a (zastareli). Make-table upiti → u 4.0 servis/transakcija |
| `Doc__Form_CTGK_Def` · `GRKZag` | Korisnički definisani GL izveštaji; alternativni tok knjiženja zaglavlja | `finance`/GL | CTGK = konfigurabilni report (pozicija→maska konta→strana) — definicije su podaci. GRK = drugi ulaz u isti posting motor → konsolidovati NSK+GRK u jedan servis |
| `Module__Dnevnik` | **Audit log** korisničkih akcija (NE računovodstveni dnevnik) | cross-cutting (audit trail) | ⚠️ Imenska kolizija sa „Dnevnik glavne knjige". Poziva se na Open/Close formi → u 4.0 strukturiran audit log |

---

## 5. PDV / POPDV — `tax`

Srpska regulativa PDV-a + istorijski porez na promet + regulatorne knjige. Kod je mali jer je najveći deo u Access upitima (`PDV_UknjiziIzRobnog_IF`, `ProknjiziUKEPU...`, `PK1NProknjizi...`). **Najveći gap: POPDV se ne generiše nativno** — poziva se posebna `.mdb` aplikacija.

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Module__PDV_Modul` | **Centralne PDV stope** datumski uslovljene + override po grupi | `tax` (rate-by-date resolver) | 🔴 Hardkodovani pragovi: Viša 18%→**20%** (30.09.2012); Niža 8%→**10%** (01.01.2014); Poljo 5%→**8%**. Override `PDVGrupa` ('VISA'/'NIZA'/'POLJO') pobeđuje datum. **U 4.0 OBAVEZNO tabela stopa (vazi_od/do)** — inače buduće izmene i retroaktivni obračun lome kod. `F_PDV_KomitentVanPDV=2` = magičan broj → flag na komitentu |
| `Doc__Form_PDVStavkeNalogaPodforma` | PDV pod-slog svake GL stavke (osnovica/iznos/stopa/grupa) | `tax` (integracija sa GL) | 🔴 **Ključni obrazac:** svaka GK stavka nosi PDV pod-slog = most GK↔PDV knjige. `PDVIznos=Round(Osnovica*Stopa/100,2)`, obrnut i iz iznosa. U 4.0 osnovica zavisi od smera (UF/IF) |
| `Doc__Form_PDV_IF` / `PDV_UF` | Knjiga izlaznih (KIF) / ulaznih (KUF) faktura + export za PU | `tax` (KIF/KUF) | 🔴 Obrnut obračun osnovice iz bruto. Poseban tok van PDV sistema (`PDV_UknjiziIzRobnog_UF_VanPDV`) i poljo (5/8%). Punjenje iz robnog/usluga/GK — **upiti nisu u izvozu**. TXT export za PU = legacy (fiksna širina) → u 4.0 zamenjuje SEF/POPDV |
| `Doc__Form_PDV_FormaPPPDV` · `Doc__Report_PDV_ObrazacPPDV` | Poreska prijava PPPDV — agregacija po poljima iz KUF/KIF | `tax` (PPPDV) | 🔴 Eksplicitno mapiranje polja (opšta/posebna/nulta sa pravom na odbitak/poljo/uvoz). ⚠️ komentar `?????????` kod „NulaStopa→SaPravomNaOdbitakPP" = nesigurno mapiranje — proveriti sa aktuelnim obrascem. U 4.0 predaja elektronska; obrazac = referenca polja |
| `Doc__Form_APGK_PDVSemeKontaZaKnjizenje` · `APGK_PDVProvera` · `PDV_SemeZaKnjizenje` | Šeme „poresko pravilo → konto" za auto-knjiženje PDV-a + rekonsilijacija GL↔PDV | `finance`/GL + `tax` | 🔴 Pravilo: iznos PDV ne sme uz stopu 0% (osim osnovica-red). Mapira (grupa/evidencija/AOP/ulaz-izlaz/promet) → konto. U 4.0 konfiguracioni sloj auto-knjiženja + auto-rekonsilijacija |
| `Doc__Form_AVR_Roba` / `AVR_Usluge` | Avansni računi — preračun PDV iz bruto avansa, iskorišćeni/preostali iznos | `tax` (avansi) + `sales` | 🔴 `PDVVisa=Round(Bruto/(1+st/100)*(st/100),2)`, stopa iz `F_PDV_VisaStopa(DatumAVR)` — **stopa na datum avansa, ne fakture**. ⚠️ AVR_Roba NE oduzima već iskorišćeno, AVR_Usluge oduzima (`Column−Column(7/8/9)`) — nekonzistentnost; **usvojiti verziju iz Usluge** (praćenje ostatka) za oba toka. Avans je poseban POPDV dokument — preneti vezu faktura↔avans |
| `Doc__Form_Promena poreskih stopa` · `Unos_Pregled tarifa i stopa` | Batch promena i šifarnik stopa/tarifa | `tax` (šifarnik) | 🔴 Mehanizam za zakonske izmene (18→20, 8→10). ⚠️ transformacija je **destruktivan update** (`PromeniPoreskeStope*`) → gubi istoriju → u 4.0 **versioning sa datumom važenja** (kritično za retroaktivne obračune) |
| `Class__POPDV_Class` | Launcher **EKSTERNE** Access aplikacije za POPDV | `tax` (POPDV) — **VELIKI GAP** | 🔴🔴 **KRITIČNO:** POPDV (obavezan od 2017) se u BigBit-u **NE radi nativno** — poziva `BigBit_APL_2010.mdb` preko `MSACCESS.EXE`+MDW. Znači **POPDV logika NIJE u izvozu**. 4.0 mora **graditi POPDV od nule** (iz poreskih kategorija stavki + PDV totala po stopama) ili integracijom sa SEF-om. Potvrditi sa Negovanom/Nesom gde je logika te eksterne app |
| `Module__TK_KEPU_MP` · `Doc__Form_Knjiga KEPU` / `KEPU_MP` / `Trgovacka knjiga` · `Module__NKEPU` | Regulatorne knjige MP (KEPU VP/MP, Trgovačka): zaduženje (ulaz)/razduženje (pazar), po kursu, razlika u ceni | `inventory`/`tax` + `finance` | 🔴 Ulaz→zaduženje po nab./prodajnoj vrednosti, izlaz→razduženje („Dnevni pazar"). ⚠️ Izlaz kao **negativan IDDok** (trik da izbegne dupli ključ) → u 4.0 pravi tip stavke. `UpisiRbrUKEPU` = obavezna **kontinuirana numeracija**. Tri cenovne osnove (KNG/nabavna/default) po parametrima. `On Error Resume Next` maskira greške. Selekcija „šta nije proknjiženo" u upitima |
| `Doc__Form_KnjigaPK1` + `PK1_Modul` + reports | PK-1 knjiga popisa (MP/ugostiteljstvo), poseban tok KAFANE | `inventory`/`tax` | 🔴 PK-1 kolone (Opšta/Niža/BezPP/Usluge/Prihod/NabavnaRiP/Provizija/ObračunatiPP/…) = najdetaljnija struktura marže i poreza po dokumentu. Ceo obračun u `PK1N*` upitima. Proceniti da li 4.0 uopšte podržava PK-1 (paušalci) |
| `Doc__Form_Obracun poreza` (+ dispečeri, PPP/PPS, PPD) | **Istorijski** porez na promet (pre-PDV, do 2005): preračunata stopa `porez=(stopa/(100+zbirna))*osnovica` | `tax` (istorijski — verovatno NE portovati) | ⚠️ BUG: `RZCRatni/RZCPosebni` koriste `(Ratna/(100+Ratna))` nekonzistentno; ako se prenosi istorija, koristiti `IzracunajPorezPoStopama`. Van opsega osim za istorijski pregled |

---

## 6. Banke / plaćanja — `banking`

Ceo platni promet: virmani (nalozi za plaćanje), izvodi (import), blagajna (GL nalozi), obračun kamate (konformni metod), avansi, INO plaćanja, saldakonti. Presek svega = **zaključavanje (period-lock)**.

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Module__Kamate` | **Jezgro obračuna kamate** — konformni (složeni) metod po periodima stopa; knjiženje iz otvorenih stavki | `finance`/GL + `banking` | 🔴 **KONFORMNI METOD:** koef = Π po periodima `(1+Stopa/100)^(dana/N) − 1`, `N=ZaDana` (dnevna baza). Seče period na granici stope. Mora se preneti **tačno** (greška u N = pravni rizik). ⚠️ postoji **4–5 varijanti** funkcije (…Ispravan/Nova/Rucno/1) — utvrditi aktivni put (`ObracunZaSeriju`→`ProknjiziUKamatePripremu`→`IzracunajKoeficijentKamateRucno` sa `Vrsta=1`). Napisati čist iterativni algoritam sa test-vektorima |
| `Module__KontrolniBrojevi` | Kontrolni brojevi računa i poziva na broj (MOD97, MOD11) | `banking` (validacija) — util | 🔴 `KBroj97` = ISO 7064 MOD 97-10 (`98−(broj·100 mod 97)`, `CDec` → u 4.0 **BigInt/decimal, ne float**). `DobarTR` = format banka(3)-partija(13)-kontrola(2). `Kbroj22` = MOD11. Preneti **1:1 uz unit-testove** sa poznatim primerima; dodati IBAN validaciju |
| `Module__ExportUHalcom` · `Module__FX_HALCOM` | Export naloga u e-banking fajl (Halcom fiksna širina) / parsiranje uvezenih izvoda | `banking` (export/import) | ⚠️ **NE prenositi fiksni tekst-format** — zameniti **NBS/ISO 20022** (`pain.001`, `camt.053/054`). `ZameniNasaSlovaVerz2` (banka ne prima UTF). ⚠️ **`PrebaciUFX` (za Servoteh!) NIJE u ovom izvozu** — obavezno naći. Iznosi u izvodu bez separatora (`IznosIgnorSep2Dec /100`); broj dok iz poziva na broj (krhko) → u 4.0 eksplicitno mapiranje model 97 |
| `Module__Zakljucavanje` | Period-lock dokumenata (roba/GK/virmani); auto-lock starijih od N dana | cross-cutting (period-close) | 🔴 Vidi §9 (Regulatorna pravila). `ZakOtkDok` postavlja `Zakljucano`; otključavanje traži grupu `Admins`/`Otkljucavanje` |
| `Doc__Form_VIRMANI_Priprema` | Masovno kreiranje naloga iz otvorenih obaveza dobavljačima (payment run) | `procurement`/`banking` + `sef` | Pravila: konto `46*`→„putni troškovi" bez broja dok; inače „Uplata računa" sa obaveznim brojem. Blokira: stavka bez poziva na broj, loš TR (`DobarTR`), **duplikat poziva na broj** (`ProveraPozivaNaBroj` — zaštita od dvostrukog plaćanja). Štampa ulaznu SEF fakturu. Logika u `VIRMANI_KreirajIzPregleda` (nije u izvozu) |
| `Doc__Form_Pregled virmana` · `UnosVirmana` · `ExportVirmana` | Administracija naloga: workflow potpisivanja, export, štampa | `banking` (payment workflow) | 🔴 **STATE MACHINE:** `Status 0`=kreiran → `1`=potpisan → export → nazad na 0. Potpisati samo kreirane; exportovati samo potpisane (i uz definisanu firmu). ⚠️ **granananje po firmi:** `Servoteh`→`PrebaciUFX`, inače `PrebaciUHalcom`. U 4.0 draft→signed→exported + audit; sprečiti re-export |
| `Doc__Form_FX_HAL_KnjizenjeIzvoda` · `FX_HAL_Stavke` | Uvoz izvoda (Halcom/FX/LHB) + knjiženje u GK; kurs/rekonsilijacija | `banking` (import + auto-knjiženje) | 3 formata preko Access import spec → u 4.0 ISO 20022 `camt` parser. 🔴 **Pravilo kursa:** izvod/nalozi po **PRODAJNOM** kursu (`KursnaListaNaDanZaNaloge`), za razliku od blagajne (srednji). Kontiranje izvoda u SQL upitima — izvući |
| `Doc__Form_Blagajna` · `Stavke blagajne` | Blagajna kao GL nalog (dinarski/devizni), konverzija, auto-podela prihoda | `finance`/GL + `banking` (gotovina) | Broj naloga auto po vrsti (`1+Count`, 4 cifre); jedinstvenost (broj+vrsta+level). 🔴 **Pravilo kursa:** `KursDeli` flag: `Dev=iznos/Kurs` ili `*Kurs`; **SREDNJI** kurs (`KursnaListaNaDan`). Validacije: duguje/potražuje≠0, `Specijal='PROKOMERC'`→obavezan broj dok, obavezna temeljnica. Auto-split: konto `202*`+`F_AutoPodelaPrihoda`→prihod po prodavcima |
| `Doc__Form_OK_ObracunZaSeriju` · `OK_PregledObracuna` (+ šifarnici stopa) | Batch obračun zatezne kamate za komitente + knjiženje u GK | `finance`/GL (kamata) | Petlja po komitentima → `KreirajKamataDok`+`ProknjiziUKamatePripremu`; `DatumValute=DatumObracuna+Odlozeno`. Idempotentnost po `SerijaObracuna`. Šifarnik stopa vremenski određen (`OdDatumaStope`, `ZaDana`, tip). Kontiranje u `OK_ProknjiziIzPregledaUNalog` |
| `Doc__Form_INOUplatniRacuni...` · `AvUplateTrebovanja` | INO (devizni) računi + avansne uplate po trebovanju | `banking` (INO) + `sales`/`procurement` (avansi) | INO → IBAN/SWIFT validacija + `pain.001` (BIC/IBAN). Avans regulatorno bitan za PDV — pratiti vezu avans↔trebovanje↔konačni račun |

---

## 7. Kasa / POS / fiskalizacija — `sef` (fiskalizacija) + `sales`

Maloprodajni POS (41 fajl). Tok: skeniranje barkoda→`PrenesiCeneIzCenovnika`→snimanje stavke→„Fiskalni račun"→fiskalni uređaj→`StampanFiskalno=True`+zaključavanje. **KRITIČNO:** ceo niskonivoski protokol (Galeb serijski, SHARP TXT) je **LEGACY pre-2022 fiskalizacija i NE prenosi se** — Srbija od 2022 koristi e-fiskalizaciju (ESIR/L-PFR/SUF). Prenose se **poslovna pravila**.

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Module__GALEB_FP550` · `Module__FP_ProgProc` · `Module__SHARP_ER_A457` | Niskonivoski fiskalni drajveri (serijski frame Galeb, TXT export SHARP) | `sef`/fiskalizacija — **NE prenosi se** | ⚠️ Legacy hardver. Zamenjuje **L-PFR/ESIR REST API** + bezbednosni element. Zadržati koncepte: verifikacija statusa uređaja pre računa, poreske grupe → **eksplicitne PDV stope** (Chr$ kodovi se bacaju), načini plaćanja P/C/D → **enum** (gotovina/kartica/ček/prenos/vaučer). ⚠️ SHARP „Tarifa+1" off-by-one pri mapiranju grupa |
| `Module__FP_Kasa` · `Module__FP_FiskalniRacun` | Orkestracija fiskalne štampe iz dokumenta (redosled računa, sync cena, VP fiskal) | `sales` + `sef`/fiskal | 🔴 `FP_StampajFiskalniRacun` redosled (stavke→međuzbir→plaćanja→zatvaranje) **mora ostati** u ESIR toku. Podela naplate na 3 kanala + „popuni razliku gotovinom". ⚠️ „ne mogu se menjati cene kad je otvoren račun" → cene sync PRE otvaranja. VP: B2C fiskal vs B2B eFaktura (SEF) — razdvojiti |
| `Doc__Form_MPRacun` · `MPRacun-Podforma` | **Glavna POS forma** — kasa blok: zaglavlje, naplata, fiskalna štampa, zaključavanje, konfiguracija terminala | `sales` (POS) + `sef`/fiskal + `inventory` + `tax` | 🔴🔴 **NAJVAŽNIJE:** fiskalizovan račun je **NEPROMENLJIV** (`Form_Delete Cancel`, podforma `Locked`) → direktno u 4.0 (**storno umesto brisanja**). Naplata ≤1000× vrednosti = sanity-guard. Rabat ≤ kupčev dogovoreni. Konfiguracija kase (prodavnica/kasa/vrsta/kupac) u `Radni fajlovi`. 🔴 **Težinski barkod:** prefiks `28`+EAN-13 → PLU=`Left(7)`, količina=`Mid(8,5)/1000` — **obavezno portovati** (vage). Poreska tarifa **po stavci** iz cenovnika. Zalihe=MP+VP−rezervisano. ⚠️ `RazdvojKolicineZaFP` (Galeb limit 5 znakova) → u 4.0 **izbaciti** (pravi lažne dvostruke stavke) |
| `Module__DodelaPLU` | Dodela PLU + auto-numeracija dokumenata | `sales`+`inventory` | 🔴 ⚠️ `DCount(*)+1` race → duplikati/rupe pod više kasa → 4.0 **DB sekvenca po (vrsta,godina,prodavnica)**. Brojevi moraju biti neprekidni/jedinstveni (poresko pravilo) |
| `Doc__Form_FP_Server` | Mrežni print-server fiskalnih računa (red + worker + semafor uređaja) | `sef`/fiskal (queue/worker) | **Arhitektura vredna za 4.0:** red zahteva + worker + lock uređaja (jedan L-PFR opslužuje više kasa). ⚠️ semafor preko flag polja+Access tajmer → u 4.0 pravi queue + service lock. `FP_Beep` heartbeat |
| `Doc__Form_FP_Artikli` · `Doc__Form_Kasa` · `Doc__Form_FP_Dijalog` | Admin artikala u uređaju, dnevni izveštaji, dijagnostika | `sef`/fiskal + `inventory` | 🔴 `0A`=Z-izveštaj (dnevni presek + upis u fiskalnu memoriju + nuliranje) vs `2N`=X-izveštaj (samo pregled) → ekvivalent dnevni/periodični L-PFR. ⚠️ `FP_Dijalog` upisuje **hardkodovane stope 18/8** (stara verzija) → 4.0 konfigurabilne. „Promenjen" dirty-flag = koristan obrazac |
| `Doc__Form_ZbiroviMPDokumentaPoslednjaKL` | Obračun ostvarene **razlike u ceni (RUC/marža)** u MP — KEPU/pazar izveštaj | `finance`/GL + `tax` + `inventory` | 🔴 Koef RUC = Ukupna razlika u ceni / (Kalk. VP + Nivelacija); Ostvarena RUC = Ostvarena VP × koef. **Osnov za vrednovanje MP zaliha i knjiženje pazara (KEPU).** ⚠️ obračun u Access upitima (`Kalkulativna razlika u ceni`, `Prihod po VP za RZCN`) — rekonstruisati |
| `Doc__Form_ProknjiziStavkeIzIzlaznogUKasaBlok` · `UnosSmene` · `Module__KasaModul` · `Module__BBTouchScreenCMD` | Konverzija VP→MP, smena/kasir, touchscreen UI | `sales` (POS UI) | Konverzija VP→MP = servisna operacija (append-query). Smena = atribut računa (pazar po smenama). UI automatizacija (`SendKeys`) — ne portuje se, samo inventar POS akcija |

---

## 8. Matični podaci — `masters` (u 2.0 read-only cache, u 4.0 izvorni)

Komitenti, artikli, cenovnici, predmeti, šifarnici. „Teška" logika je u Access upitima; forme su tanak CRUD. ⚠️ Jedna tabela `Komitenti` služi i kao partneri i kao generički šifarnik (`Vrsta sifre`) — razdvojiti u 4.0.

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Module__PIB` | 🔴 Validacija srpskog PIB-a + GLN | `tax`/masters validacija | Zvanični checksum (prvih 8 cifara, mod 10/mod 11). ⚠️ zadnja cifra poredi se kao string (labava VBA konverzija) → u 4.0 striktno numerički. `DobarGLN` = samo dužinska provera (nije mod-check). **Policy:** na komitentu PIB = upozorenje, na fakturama = tvrda zabrana (osim `NeProveravajPIB`) → reusable validator + policy flag |
| `Module__Cene` | Razrešavanje cene iz cenovnika + KNG (konsignacija) + cenovnik po komitentu | `sales`/pricing | Cena po (`Vrsta dokumenta`,`Sifra artikla`) — `DFirst` ne garantuje jedinstvenost → u 4.0 uniq ključ + default cenovnik po kupcu. KNG_Artikli = konsignacioni tok (odvojeno u lageru) |
| `Module__DodelaPLU` | Auto PLU + `SledeciBrojDokumenta` | `inventory`+`sales`/`procurement` | ⚠️ `DMax+1`/`DCount+1` race → DB sekvenca. Dva režima (`MaxVrstaDok` vs `CountVrstaDok`) |
| `Module__PotpisivanjeDok` | Audit „potpis" (ko/kada) matičnih zapisa | cross-cutting audit | `PotpisiKom`/`PotpisiArt`/`PotpisiDok` → u 4.0 standardna audit polja (created/updated by/at); ⚠️ nazivi kolona različiti po tabeli |
| `Doc__Form_Unos komitenata` · `Pregled komitenata` | CRUD komitenta + **merge duplikata / masovne izmene** | masters (partneri) + `finance` | `KomitentiNacinPlacanja` zaključan osim za grupu `KomAvPlacanje` (role-based field lock). 🔴 **KRITIČNO za migraciju:** `DugmePrebaciSveIzPregNaSifru` = **merge partnera** — `PREB_*` upiti preknjižavaju SVE reference (GK, dokumenta, rabati, mesta isporuke) na jednu šifru pa briše duple → u 4.0 **dedup po PIB-u + FK re-pointing u transakciji** |
| `Doc__Form_Unos artikala` · `Pregled artikala` | CRUD artikla (kat.broj, PLU, tarifa, taksa, cene, raster) + masovne cene/težine | `inventory` + `tax` | Kat.broj jedinstvenost ručno u `BeforeUpdate` → DB unique. 🔴 Masovna „Promena poreskih stopa" → **versioning** (datum primene). Težina komada = `Debljina*raster*7850/1e9` (gustina čelika — Servoteh). Cene zaključane, otključavaju dvoklikom (nema audit). `ArtTaksa` (eko taksa) + `Tarifa robe` (PDV) → dokumenti |
| `Doc__Form_Cenovnik` (+ VP, podforma, `IzborZaKreiranjeCenovnika`) | Cenovnik po vrsti dokumenta: formiranje MP/VP, preračun po kursu, export ka vagama/kasama, pricing engine (množi/deli/prepiši) | `sales` (pricing) + fiskal | 🔴 MP vs VP po `R_Vrste dokumenata.[Prodaja sa PPP]` (MP=sa PDV, VP=bez). Export u BIZERBA/GALEB/VAGA1 fiksne formate (adapteri ako se uređaji zadrže). Kurs >0.001. Pricing engine (X// + koeficijent + zaokruživanje, „prepiši" **destruktivno** briše pa append) — logika u `CEN_*` upitima; dvosmerna veza cenovnik↔artikal |
| `Doc__Form_Vrste dokumenata` | 🔴 Definicija vrsta robnih dokumenata + **KEPU kolone + šema kontiranja** | `finance`/GL + `inventory` + KEPU | 🔴 `Ulazni` flag auto-set KEPU: ulaz→`Zaduzenje='A'`; izlaz→`Zaduzenje='B-A'/'B'`. Svaka vrsta ima „Prodaja sa PPP" + šemu kontiranja. **Srž mapiranja dokument→GL nalog i KEPU** — preneti tabelu + šeme 1:1 i validirati na podacima |
| `Doc__Form_Kursna lista` | Kursevi po datumu/valuti | `finance`/`banking` + `sales` | „Formiraj iz datuma za datum" (vikend/praznik). U 4.0 razmotriti auto-import NBS; istorija po (valuta, datum, tip kursa) |
| `Doc__Form_Predmeti` (+ ispravka komitenta) | Predmet (projekat/posao) — čvor komitent↔ponude↔usluge↔radni nalozi | `sales`/MES | ⚠️ `BrojPredmeta=DMax+1` (race). Most ka proizvodnji (`RadniNalog` po predmetu) — **uskladiti sa ServoSync proizvodnim core-om** (Predmet→RadniNalog→Faktura verovatno već postoji) |
| `Doc__Form_MestaIsporuke` · `Rabati*` · `Prodavci` · `Radnici` · `Magacini` · `Kvalitet/BazniArtikli/Pozicije/Vrste sifara/ZastPregledKomitenata` | Dostavne adrese, rabatna politika, prodavci/radnici, skladišta, klasifikatori artikla | masters | Mesta isporuke = 1:N adrese po partneru. 🔴 Rabat 2 nivoa: opšti komitenta + po artiklu (prioritet) — pravila u upitima fakturisanja. ⚠️ Radnik nosi `Password` **plain** (InputMask samo maskira) → u 4.0 **hešovati**. Klasifikatori (grupa/podgrupa/poreklo/kvalitet/proizvođač): svi `DMax(ID)+1` na klijentu → identity. `ZastPregledKomitenata`: `Vrsta sifre` razdvaja partnere ('KUPDOB') od generičkih šifara — **razdvojiti tabele/servise u 4.0** |

---

## 9. Import / sync / infra

Konfiguracija (`CFG_*` KV), ADO/ODBC linkovanje, SHUTTLE offline replikacija, EDI/eFaktura export engine, prava pristupa, zaključavanje. **Većina ovoga se ZAMENJUJE, ne portuje** (Access/DAO/MDB „vodovod"). Ali unutar plumbinga žive **važna pravila** koja moraju u 4.0.

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Class__EDI_Class` | 🔴 **Generic meta-podacima vođen EDI/e-dokument engine** (`T_EDI_Def`/`_Sekcije`/`_Stavke` → TXT/JSON/XML) | `sef` (UBL/XML) + `tax` (POPDV) + integracije (RFZO/BEX) | 🔴 **KRITIČNO REGULATORNO** — osnova SEF eFaktura (UBL 2.1: `cbc:`/`cac:` čvorovi, `InvoiceTypeCode`, kategorije PDV oslobođenja), RFZO, POPDV. **Preneti:** definicija formata kao podatak (sekcije, obavezna polja, dinamički uslovi po dok/stavci/stopi/kategoriji). ⚠️ **ZAMKE:** `Eval()` nad korisničkim izrazom (sigurnosni rizik), `'!'` sentinel, XML escaping (`<>&`) — u 4.0 tipizirani UBL builder/serializer, ALI **zadržati katalog mapiranja polja** (nosi tačna imena UBL/SEF čvorova + obaveznost) |
| `Class__BBCFG_Class` · `Module__CFGRW` | Config singleton (~250 propertija) + KV čitač sa scope override lancem | `config` (settings servis) | **Preneti:** DefaultPDV 20/10, `KnjigaKEPU`, PIB/GLN/MB firme, default magacini, numeracija — kao **tipiziran config po tenant-u** (ne globalni singleton), firma-podaci u pravu tabelu. Scope lanac (default→global/tenant→lokal) + enum validacija (`SamoDozvoljeneVrednosti`) = dobar obrazac. ⚠️ ODBC_Synch parametri = legacy MSSQL sync (gasi se posle cutover-a) |
| `Module__LinkovaneTabele` · `Module__Sys` · `Module__Bliski susret` | ADO/DAO linkovanje tabela, health-check, tenant-resolution preko konekcionog stringa | infra/persistence — **NE portuje se** | Zameniti pravim DB konekcijama/DataSource. **Zadržati koncept kataloga** `Baze`/`BazeITabele` (koja tabela iz kog izvora) → mapiranje „BigBit-owned vs ServoSync-owned" pri cutover-u. ⚠️ tenant iz putanje baze — krhko, ne replicirati |
| `Module__BBPravaPristupa` | 🔴 Table-driven RBAC + row/field-level security (Visible/Enabled/Locked/Filter/RecordSource po user+kontroli) | infra/auth (RBAC) | **Model prava za preneti:** granularno do polja + row-level (RecordSource/Filter po useru) + nivoi (`BBDefUser.Level`) + grupe. U 4.0 role+permission+field-policy vezano za **resurse/akcije, ne UI kontrole** |
| `Module__Zakljucavanje` | 🔴 Zaključavanje dokumenata/perioda (roba/GK/virmani), auto-lock starijih od N dana | `finance`/`inventory`/`banking` — cross-cutting | Vidi §10. Status dokumenta (draft/posted/locked) + period-close + audit; proknjižen/potpisan se ne sme menjati |
| `Doc__Form_Shuttle` | SHUTTLE offline replikacija centrala↔radnja (per-tabela Append/Import/Update + PK renumeracija) | infra/sync — **NE portuje se** | ⚠️ Najbitniji legacy sync mehanizam (privremen, gasi se). **Preneti semantiku:** katalog entiteta + zavisnosti (šifarnici pre dokumenata), profili smera (centrala→radnja šifarnici; radnja→centrala MP dokumenti), strategija PK-kolizija (renumeracija `max+1`) → u 4.0 **UUID/globalni ID / server-authoritative** |
| `Module__BBJson` · `Module__A_Base64` · `Module__Convertor` | JSON serijalizacija, Base64, ćirilica↔latinica | infra/util za `sef` | Trivijalno u 4.0 (nativni JSON/Buffer). **Zadržati zahteve:** korektna null/broj/bool serijalizacija (bila SEF zamka), base64 priloga/QR, **transliteracija naziva za SEF/izveštaje** (digrafi LJ/NJ/DZ pre pojedinačnih slova) |
| `Class__BBImport_Class` · `Doc__Form_BBExport` · `CSVExport_*` | XLS/XML import (matching po kat.broju), generic export XLS/XML/CSV | `procurement`/`sales` import + infra export | Import stavki matchuje na artikle **po `Kataloski broj`** → u 4.0 XLSX parser + preview/validate + mapiranje kolona. Export = standardni grid CSV/XLSX. ⚠️ hardkodovane putanje (`C:\SHARES\...`) |
| `Module__BBCMD` · `Doc__Form_BazeITabele` · `CFGReadWrite` · `BBImport` | Schema-sync između .mdb, deployment objekata, admin config/veze | infra (migracije/admin) — **NE portuje se** | Zamenjuju Prisma migracije + CI/CD. Ideja verzionisanih izmena vođenih tabelom = migration runner. `BBOpenForm` prolazi kroz prava+i18n → u 4.0 guard/interceptor |

---

## 10. Ostalo (izveštaji / UI / pomoćno)

45 fajlova „vodoinstalaterskog" sloja — **nizak rizik**, uglavnom se ne portuje. Izuzeci vredni pažnje:

| VBA modul | Šta radi | 4.0 meta | Napomene za prenos |
|---|---|---|---|
| `Doc__Form_Prva maska` | **Glavni meni cele aplikacije** + RBAC (`UserUGrupi`) | cross-cutting (navigacija) | **NAJVREDNIJI za mapiranje 4.0 modula** — kompletan inventar ekrana po domenima (dopunjuje [10](10-bigbit-glavni-meni.md)). ⚠️ backdoor: `Form_Close` ne izlazi ako `CurrentUser='Slavisa'` — ne prenositi |
| `Doc__Form_Izmene` | Alat za migracije baza + skript **PDV 18→20** | `tax` + platform | 🔴 **REGULATORNI PRESEDAN:** migracija stope (update stare tarife 18 → append nove 20 → update Artikli → update Cenovnik). Pokazuje propagaciju stope kroz tarife→artikle→cenovnik. **U 4.0 stope sa periodom važenja; istorijski dokumenti čuvaju staru stopu.** Multi-firma = zaseban `.mdb` po firmi (`Radni fajlovi`) → u 4.0 `company_id` kolona |
| `Class__Email_Class` | SMTP nalog iz CFG tabela | cross-cutting (notifications) | **ISPRAVAN obrazac** (kredencijali iz configa, ne koda) → slediti. `EmailAcctPwd` u 4.0 u secrets/env. `EmailSluzbeNabavka` → `procurement` |
| `Module__Zakljucavanje` helper `ZakOtkDok` (+ `Z_Zakljucaj_*` forme) | Univerzalni lock helper po (tabela, id) | cross-cutting (document lifecycle) | 🔴 BigBit-ov obrazac immutability-ja (isti za fakture/naloge/izveštaje). ⚠️ trenutno samo bool `Zakljucano` **bez korisnika/vremena** → u 4.0 dodati „ko/kada zaključao" (audit) |
| `Doc__Form_Nalepnice` (+ reports) | Štampa nalepnica / barkoda / **Deklaracije** | `inventory` (labeliranje) | 🔴 „Deklaracija" = zakonska deklaracija robe (uvoz/MP). Barkod EAN check-digit u reportu (nije u VBA). ⚠️ globalna staging tabela `NNID` deljena među korisnicima → u 4.0 server-side render po sesiji |
| `Module__BBError` · `Doc__Form_BBMsgBoxFrm` · pickeri (`IzborArtikla`/`IzborZaKomitenta`) · `Doc__Report_Memorandum_Header*` | Error handler, custom MsgBox, lookup dijalozi, memorandum zaglavlje | cross-cutting UI | `BBErrorMSG` → strukturiran exception filter + log (trenutno bez perzistencije). 🔴 Memorandum: **koji žiro/uplatni račun se štampa na kom tipu dokumenta** (za INO/izveštaje se krije) — konfigurabilan račun po firmi + pravilo vidljivosti (3 skoro-duplikata → jedan parametrizovan template) |
| Interni messaging (`P_Poruke`, `P_PregledPoruka`, `SMS_Poruke`, tajmer), `Digitron`, splash/test forme, prazni reporti (`KRI/KR/Garancija`) | In-app inbox, SMS priprema, kalkulator, UI chrome | cross-cutting notifications / — | Messaging: deep-link (`ImeForme`+`IDDok`)→URL; polling→push/SSE. ⚠️ **Poslovna logika KR/KRI/Garancija reporta NIJE u VBA** (u Access report dizajnu + RecordSource) — rekonstruisati (KR = kalkulacija, Garancija = garantni list; `KR_22032010` = verzionisan po propisu) |

---

## 11. Regulatorna / poslovna pravila (kritično za 4.0)

Skup pravila i algoritama koje **prepisivanje mora da preživi** (iz `porting_notes` svih domena). Ovo je „ne-pregovarački" deo 4.0.

### PDV
- 🔴 **Istorijske stope** (`PDV_Modul`): Viša 18%→20% (30.09.2012), Niža 8%→10% (01.01.2014), Poljo 5%→8% (30.09.2012). Override `PDVGrupa` pobeđuje datum. → **tabela stopa (vazi_od/do)**, nikad hardkod (buduće izmene + retroaktivni obračun).
- 🔴 **Migracija stope** (`Izmene`): update stare → append nove → update artikli → update cenovnik; **istorijski dokumenti čuvaju staru stopu** (versioning, ne destruktivan update).
- 🔴 **Avansni PDV** (`AVR_*`): `PDV=Round(Bruto/(1+st/100)*(st/100),2)`, **stopa na datum avansa**. Usvojiti AVR_Usluge logiku (praćenje ostatka) za oba toka. Avans = poseban POPDV dokument, veza avans↔faktura obavezna.
- 🔴 **PDV pod-slog po GL stavci** (`PDVStavkeNalogaPodforma`) = most GK↔KUF/KIF; osnovica zavisi od smera (UF/IF).
- 🔴 **POPDV GAP:** ne postoji nativno (eksterna `BigBit_APL_2010.mdb`) → **graditi od nule** iz poreskih kategorija stavki + PDV totala po stopama.

### KEPU / Trgovačka knjiga / PK-1
- 🔴 Ulaz→zaduženje, izlaz→razduženje („Dnevni pazar"); izlaz kao **negativan IDDok** (legacy trik) → pravi tip stavke.
- 🔴 **Obavezna kontinuirana numeracija** (`UpisiRbrUKEPU`/`UpisiRbrUTrkn`), carry-forward salda po stranama („Prenos").
- 🔴 Tri cenovne osnove (KNG/nabavna/default) po parametrima; razlika u ceni (RUC) = vrednovanje MP zaliha + knjiženje pazara. Selekcija „šta nije proknjiženo" i obračun u Access upitima — izvući.

### SEF eFaktura (vidi [07 §8](07-bigbit-sef-efaktura.md))
- 🔴 **Throttle 3 req/s** (MFIN); `ApiKey` header; base URL + ključ iz configa (demo/prod).
- 🔴 **Idempotency `requestId`** = `<IDFirma>-<KodTabele>-<IDDok>-<IDProdavnica>-<IDKasa>` (32 znaka; KodTabele 01–04/00) + `date=Auto` + opc. `sendToCir` (CRF/javni sektor).
- 🔴 **Lock-guard protiv duplog slanja** (`ZakljucanUSEFu`) → unique/locked flag.
- ⚠️ **Guard `MozeDaSeStornira/Otkaze` su neutralisani** — NE preuzimati kao pravilo, implementirati pravu eligibility po zvaničnoj spec.
- 🔴 Knjižno odobrenje → `<CreditNote>`; avans → `cac:BillingReference`; kategorije PDV (S/AE/O/E/Z) po stopi (`IDKategorijaPO`); accept/reject `accepted:"True"/"False"` (STRING). Pravi UBL serializer + XSD (CIUS/EN16931), ne konkatenacija.
- 🔴 **SEF-inbox nije izolovan** — auto-kreira robni dokument prijema + nivelaciju (`SEF_Common`) → vezan za `procurement`+`inventory`.

### Fiskalizacija
- 🔴 **Fiskalni račun NEPROMENLJIV** → storno umesto brisanja (`MPRacun` `Form_Delete Cancel`).
- 🔴 Redosled računa (stavke→međuzbir→plaćanja→zatvaranje); dnevni **Z-izveštaj** (`0A`) obavezan na kraju smene; X (`2N`) bez upisa.
- 🔴 **Težinski barkod** prefiks `28`+EAN-13 (količina/1000). Poreska tarifa **po stavci**. Načini plaćanja → enum.
- ⚠️ Legacy protokol (Galeb/SHARP) se **baca** → ESIR/L-PFR/SUF; B2C fiskal ≠ B2B/B2G SEF.

### Knjiženje / GL
- 🔴 **Šema za kontiranje** (`SemaZaKontiranje`) = dokument→konto preko formule (A..K legenda) → **tipizirani posting rules** (ne `Eval`). Tabela nije u izvozu — izvući.
- 🔴 **Prosečna ponderisana cena** (`Uskladjivanje prodaje`) = metod obračuna zaliha; provera neg. zaliha pre popravke; deterministički servis nad kretanjima.
- 🔴 **Kalkulacija zavisnih troškova uvoza** (`Ulazna faktura`): `KoefZT` iz carine/špedicije + korekcija kursa.
- 🔴 **Nivelacija** = knjiženje razlike u ceni na zalihama (prag 0.01) → KEPU razduženje.
- 🔴 **Konformni metod kamate** (`Kamate`): Π `(1+Stopa/100)^(dana/N)−1`; utvrditi aktivnu varijantu; test-vektori.
- 🔴 **Kontrolni brojevi** (`KontrolniBrojevi`): MOD97 (ISO 7064) račun/poziv na broj, MOD11, PIB checksum — 1:1 uz unit-testove; BigInt/decimal.
- 🔴 **Bilansi/ZR** = AOP mapiranje + XML za APR (`Kodeks_*`); eksplicitno pozicija→{maska, strana, znak}.

### Cross-cutting
- 🔴 **Numeracija dokumenata:** svi legacy algoritmi (`DCount+1`/`DMax+1`) su race → **DB sekvenca po (vrsta, godina, firma/prodavnica)**; neprekidnost i jedinstvenost = poresko pravilo.
- 🔴 **Zaključavanje / period-lock** (`Zakljucavanje`): proknjižen/potpisan/poslat dokument se ne sme menjati; auto-lock starijih od N dana; audit „ko/kada".
- 🔴 **PIB validacija** kao policy (upozorenje na komitentu vs zabrana na fakturi).
- 🔴 **Poreske kategorije SEF na stavci** (`Kategorija_PO`) — FK na šifarnik, ne slobodan tekst.

---

## 12. Procena obima po domenu

| 4.0 domen | Obim koda | Rizik | Ključni razlog |
|---|---|---|---|
| **Fakturisanje** (`sales`) | **Veliki** | **Visok** | 3 race-numeracije; sva logika knjiženja u Access upitima; PDV/SEF kategorije; avansi/knjižna odobrenja |
| **SEF / eFaktura** (`sef`) | Srednji | Srednji-visok | Transport nizak (§8 spec gotov); **UBL mapiranje + auto-knjiženje ulaznih u zalihe** je težak deo (vezuje procurement+inventory) |
| **Magacin / robna** (`inventory`) | **Veliki** | **Visok** | Metod prosečne cene, nivelacija, kalkulacija uvoza, popis; logika razbacana VBA↔upiti; nema transakcija; komadna evidencija (Servoteh) |
| **Glavna knjiga** (`finance`/GL) | Srednji-veliki | **Visok** | Posting engine (`Sema za kontiranje`) + OS + bilansi/APR; sve knjiženje u upitima van izvoza |
| **PDV / POPDV** (`tax`) | Srednji (kod malen) | **Visok** | **POPDV od nule** (gap); logika u upitima; effective-dated stope; legacy porez na promet van opsega |
| **Banke / plaćanja** (`banking`) | Srednji | Srednji-visok | Konformna kamata + MOD97/11 (1:1); **`PrebaciUFX` nedostaje**; export/import formati → ISO 20022 |
| **Kasa / POS / fiskal** (`sef`/`sales`) | Srednji | Srednji | Logika jasna ali isprepletena sa hardverom (baca se); ESIR/L-PFR integracija nova; RUC/pazar u upitima |
| **Matični podaci** (masters) | Srednji | Srednji | U 2.0 već read-only cache/overlay; merge-partnera + versioning stopa; razdvajanje `Komitenti` (partneri vs šifarnik) |
| **Import / infra** | Veliki (ali većina se **baca**) | Nizak-srednji | Plumbing se zamenjuje; prenosi se: **EDI engine** (SEF/POPDV osnova), RBAC model, zaključavanje |
| **Ostalo** (izveštaji/UI) | Mali | Nizak | Uglavnom se ne portuje; izuzeci: PDV-migracija presedan, memorandum/žiro pravilo, deklaracija robe |

> **Napomena o preduslovu (svi domeni):** najveći skriveni trošak je **ekstrakcija Access imenovanih upita** (`*Proknjizi*`, `NSK_*`, `SK*`, `PDV_Uknjizi*`, `ProknjiziUKEPU*`, `VIRMANI_KreirajIzPregleda`, `CEN_*`, `PREB_*`, `PK1N*`, `OK_*`) iz `.accdb`/`.mdb` — tamo živi većina poslovnih pravila koja **nisu u VBA izvozu**. To treba uraditi **pre** implementacije bilo kog knjiženja.

## 13. Redosled za 4.0 (šta prvo)

**Korak 0 — ekstrakcija (preduslov):** izvući sve Access imenovane upite (knjiženje/KEPU/PDV/pricing/merge) iz `.accdb`/`.mdb` + potvrditi POPDV eksternu logiku sa Negovanom/Nesom. Bez toga posting/regulatorni domeni nemaju izvor pravila.

1. **Matični podaci + config** (`masters`, `config`) — temelj; u 2.0 su ionako read-only cache/overlay, pa je prelaz na „izvorni" postupan. Razdvojiti partnere od šifarnika, dedup po PIB-u.
2. **Poreski/knjigovodstveni šifarnici** — **poreske stope (effective-dated)**, vrste dokumenata + **šeme za kontiranje** + kontni plan. Ovi feed-uju sve ostalo.
3. **Glavna knjiga / posting engine** (`finance`/GL) — jer i fakturisanje i magacin knjiže preko `Sema za kontiranje`; konsolidovati NSK+GRK u jedan atomski, idempotentan posting servis.
4. **Magacin / robna dokumenta** (`inventory`) — kalkulacija, prosečna cena, nivelacija, popis; hrani KEPU + GK.
5. **Fakturisanje** (`sales`) + **SEF outbox/inbox** (`sef`) — najveći domen; naslanja se na tax + GK + inventory. SEF-inbox nosi auto-prijem u zalihe.
6. **PDV knjige (KIF/KUF/PPPDV) + POPDV** (`tax`) — derivišu iz faktura/GK; **POPDV od nule**.
7. **Banke / plaćanja** (`banking`) — izvodi, virmani, kamate; naslanja se na GK/saldakonti.
8. **Kasa / POS + e-fiskalizacija** (ESIR/L-PFR) — poseban regulatorni sistem; može teći paralelno sa 5–7 (odvojen od SEF-a).

> **Zašto ovim redom:** identično logici ROADMAP §4.0 — regulatorni/računovodstveni domen ide poslednji i tek na stabilnoj 3.0 platformi, a unutar 4.0 se ide **odozdo naviše** (šifarnici → GL posting → dokumenti → regulatorni izveštaji), jer je svaki gornji sloj potrošač pravila iz donjeg. Fiskalizacija je jedini deo koji se **piše iznova** (nova ESIR/L-PFR spec), ne portuje.
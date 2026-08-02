# Štampe ServoSync 4.0 — registar svih obrazaca

**Datum:** 27.07.2026. · **Grana:** `feat/4.0-bigbit-nocni-sync`
**Cilj vlasnika:** „Rešavaj i PDF i sve štampe da nam app bude 99 % kao BigBit i još jača u nekim
stvarima kada pređemo na nju."

Ovo je JEDAN spisak svih štampi u aplikaciji: šta postoji, kojom rutom se dobija, gde je dugme,
koliko je PDF veliki, da li je obrazac propisan zakonom i u čemu smo bolji od BigBita.
Dopuna registra je obavezna uz svaku novu štampu.

---

## 0. Zajednički obrazac („ServoSync dokument")

Sve štampe prolaze kroz `backend/src/modules/documents/doc-layout/` — **jedan izvor istine** za
temu i formatiranje. Pre ovog talasa su postojale tri kopije istog zaglavlja (logo 110/120/128 px,
tri različite noge, dva formata para), pa je aplikacija delovala kao četiri različita programa.

Šta je sada zajedničko i **isto na svakom papiru**:

| Element | Pravilo |
|---|---|
| Papir | A4; uspravno za dokumente, položeno za knjige i tabele preko 8 kolona |
| Marže | 32/32/32/40 pt uspravno, 24/28/24/40 pt položeno |
| Logotip | fiksno 128 px |
| Font | Roboto (pdfmake vfs) — pokriva ćčđšž ĆČĐŠŽ |
| Zaglavlje tabele | ponavlja se na svakoj strani (`headerRows`) |
| Prelom reda | `dontBreakRows: true` — stavka se ne lomi preko strane |
| Novac | `1.234.567,89` (tačka hiljade, zarez decimala), ASCII minus, desno poravnato |
| Datum | `dd.MM.yyyy.` |
| Iznos u slovima | zaokruženje JEDNOM na 2 decimale; valuta se slaže sa brojem („jedan dinar") |
| Noga | levo oznaka dokumenta · sredina „Štampao: … · datum i vreme · ServoSync 4.0" · desno „strana N/M" |
| Prazan dokument | uokvirena napomena, nikad nema nula i nikad pad |
| Znakovi van fonta | `sanitizeText`: ⌀/∅ → Ø, ↔ → „/", ✓/✗ → DA/NE (Roboto ih tiho briše) |

Renderer je i dalje isključivo `PdfService` (pdfmake 0.3, `DocumentsModule`) — **nijedna nova npm
zavisnost**. Barkod ide kroz postojeći `bwip-js` (`documents/barcode.service.ts`).

---

## 1. Robno i zalihe

| Dokument | Ruta | Dugme | Veličina | Zakonski obrazac | Bolji od BigBita |
|---|---|---|---|---|---|
| Prijemnica / primka (UL) | `GET /v1/robno/documents/:id/pdf?variant=primka` | `/robno/detalj?id=N` → Select „Obrazac štampe" + „Štampaj" | ~72 KB | ne | fakturna cena + rabat (vidi se kako je nastala nabavna neto), Σ količina, iznos u slovima, kontrolni zbir, statusna značka + žig „NACRT", trag štampe, „strana N/M" |
| Kalkulacija cene — obrazac KL | `…/pdf?variant=kalkulacija` | isti Select (UL dokument) | ~75 KB | ne (poslovni standard) | eksplicitna KONTROLA KALKULACIJE u nozi + crveno „NEUSKLAĐENO" kad ne zatvara; BigBit tiho štampa `Sum()` |
| Izdatnica (IZ) | `…/pdf?variant=izdatnica` | `/robno/detalj?id=N` | ~72 KB | ne | potpisna mesta, iznos u slovima, kontrolni zbir, značka, N/M (BigBit `NalogZaIzdavanjeRobe` nema ništa od toga) |
| **Otpremnica (bez cena)** | `…/pdf?variant=otpremnica` | `/robno/detalj?id=N` (uslovi otpreme se unose u panelu „Uslovi otpreme") | ~65 KB | ne | **pravi Code 128 SVG po stavci** (BigBit štampa bar kod kao TEKST), barkod broja dokumenta, tri potpisa, N/M; **uslovi otpreme se štampaju kako su UNETI, a prazno polje ostaje linija za ručni upis** — nikad pretpostavljena vrednost (v. §6.2) |
| Nivelacija cena (NIV) | `…/pdf?variant=nivelacija` | `/robno/detalj?id=N` | ~71 KB | ne | kontrola „razlika vrednosti vs knjižena nivelacija" nad NEZAOKRUŽENOM osnovom, iznos u slovima, N/M |
| Prenosnica (prenos magacina) | `…/pdf?variant=prenosnica` | `/robno/detalj?id=N` | ~71 KB | ne | **štampa OBA magacina** i broj parnog dokumenta; BigBit `Prenosnica - DEFAULT` imenuje samo odredište, pa se ne vidi odakle je roba otišla. **Ulazna strana para (PREUL) rekonstruiše smer iz parnjaka** — ranije je tvrdila „IZ MAGACINA \<odredište\> / U MAGACIN —", tj. suprotan smer od stvarnog |
| Zapisnik o višku / manjku | `…/pdf?variant=zapisnik` | `/robno/detalj?id=N` | ~70 KB | ne | BigBit ovaj obrazac NEMA — kod nas imenovan dokument sa komisijskim potpisima i vezom na broj popisa |
| **Trebovanje materijala (magacin)** | `…/pdf?variant=trebovanje` | `/robno/detalj?id=N` (IZ) → Select „Obrazac štampe" | ~72 KB | ne | BigBit `CL_TrebovanjeZaProizvodnju`; kod nas nosi i radni nalog i predmet u zaglavlju i potpis „Trebovao" (BigBit ima samo izdao/primio). **Štampaju se BROJEVI** (`work_orders.ident_number`, `projects.project_number`), ne interni id-jevi iz baze — po id-u je magacioner nalazio pogrešan nalog. **NIJE narudžbenica dobavljaču** — to je drugi BigBit obrazac („Trebovanje - DEFAULT") i živi u Nabavci |
| **Zapisnik o prijemu robe (kvantitativno-kvalitativni)** | `GET /v1/robno/documents/:id/prijem-zapisnik/pdf` | `/robno/detalj?id=N` (UL) → „Zapisnik o prijemu" | ~65 KB | ne | BigBit `V_PrijemnicaSaRazlikama`; kod nas naručeno (iz narudžbenice) vs primljeno sa crvenim odstupanjem i Σ kontrolom. **Telo je SPOJ (full outer) narudžbenice i prijemnice, agregiran PO ARTIKLU**: naručeno-a-neisporučeno dobija red sa Primljeno 0 i crvenim manjkom (u robnom ulazu tog reda uopšte NEMA), a isporučeno-van-narudžbenice red sa oznakom i crvenim viškom. „Nema odstupanja" se izriče SAMO kad su oba skupa potpuno pokrivena — nula u zbiru ne dokazuje ništa ako ništa nije upoređeno. Štampa se BROJ narudžbenice (ne interni id). Kolone „Rok trajanja / Serija / LOT / Nalaz kontrole" su PRAZNE za ručni upis — te kolone još nemaju polja u šemi |
| **Popisna lista — popunjena** | `GET /v1/robno/inventory-counts/:id/pdf?variant=popunjena` | `/robno/popis` → „Štampaj popisnu listu" | ~66 KB | **DA** (zakonski obrazac popisa) | kolone i natpisi potpisa preuzeti doslovno; nadgradnja samo u nozi: N/M, trag štampe, značka popisa, kontrolni zbir Σ višak/Σ manjak |
| Popisna lista — prazna (teren) | `…?variant=prazna` | `/robno/popis` → „Prazna lista" | ~63 KB | DA (isti okvir) | jedan šablon umesto tri BigBit izveštaja koji se razilaze |
| Lager lista | `GET /v1/robno/lager/pdf?warehouseId&onlyInStock&q` | `/robno` → panel „Lager lista" → „Štampaj" | ~63 KB | ne | kolone Rezervisano i Raspoloživo (BigBit nema pojam rezervacije), traka primenjenih filtera, kontrolni zbir, crveno negativno raspoloživo, upozorenje kad je lista odsečena |
| Kartica artikla | `GET /v1/robno/item-card/pdf?itemId&warehouseId&from&to` | `/robno` → panel „Kartica artikla" → „Štampaj" | ~63 KB | ne | red „Početno stanje (donos)" i NEZAVISNO izračunato stanje iz costinga pored salda kartice, sa crvenim „NEUSKLAĐENO" kad se ne poklope |

## 2. Nabavka i SEF

| Dokument | Ruta | Dugme | Veličina | Zakonski obrazac | Bolji od BigBita |
|---|---|---|---|---|---|
| Upit za ponudu (RFQ) | `GET /v1/nabavka/rfqs/:id/pdf` | `/nabavka` → kolona „Štampa" u sekciji Upiti + dugme u dijalogu detalja | ~62 KB | ne | do sada je PDF postojao samo kao prilog mejla — nije se mogao odštampati iz aplikacije |
| Narudžbenica dobavljaču | `GET /v1/nabavka/orders/:id/pdf` | `/nabavka` → „Štampa" po redu | ~72 KB | ne | statusna značka + žig „NACRT", iznos u slovima, trag štampe, N/M, dve varijante iz jednog šablona |
| Narudžbenica bez cena (magacin) | `…/pdf?variant=bezCena` | `/nabavka` → „Bez cena" | ~64 KB | ne | isto, uz poseban naziv fajla |
| Poređenje naručeno/primljeno/fakturisano | `GET /v1/nabavka/orders/:id/match/pdf` | `/nabavka` → „Štampa poređenja" u panelu reda | ~67 KB | ne | **BigBit ovaj izveštaj NEMA**; naziv i kataloški broj artikla, crvena razlika, kontrolni zbir, izvori (robni ulaz, KUF stavka) |
| Pregled odstupanja (3-way match) | `GET /v1/nabavka/match-summary/pdf?from&to&supplierId&onlyWithFindings` | `/nabavka` → traka perioda + „Pregled odstupanja (PDF)" | ~67 KB | ne | traka primenjenih filtera, legenda kodova, upozorenje „PRIKAZANO PRVIH N OD M" umesto tihog odsecanja |
| SEF izlazna e-faktura (prikaz UBL-a) | `GET /v1/sef/outbox/:id/pdf` | `/sef` → „Štampa" u outbox listi | ~75 KB | ne (UBL je propisan, prikaz nije) | **BigBit nema SEF**; štampa se ono što je STVARNO poslato (sačuvan UBL), sa žigom „NIJE POSLATO NA SEF"/„ODBIJENO"/„STORNIRANO" |
| SEF ulazna e-faktura | `GET /v1/sef/incoming/:id/pdf` | `/sef` → kartica „Ulazne fakture" → „Štampa" | ~74 KB | ne | istaknuta traka zakonskog roka od 15 dana (crveno kad ističe) i kontrola „iznos u XML-u vs iznos u evidenciji" |

## 3. Finansije i saldakonti

| Dokument | Ruta | Dugme | Veličina | Zakonski obrazac | Bolji od BigBita |
|---|---|---|---|---|---|
| Bankovni izvod | `GET /v1/izvodi/:id/pdf` | `/izvodi` → kolona „Štampa"; `/izvodi/detalj` → „Štampa" | ~73 KB | ne | **BigBit obrazac izvoda UOPŠTE NEMA** (0 pogodaka u 922 izveštaja); kontrola salda ista kao traka na ekranu, iznos u slovima, značka, N/M |
| Opomena za naplatu (nivo 1/2/3) | `GET /v1/saldakonti/dunning/pdf?partnerId&level&asOf` | `/saldakonti/kartica` → izbor nivoa + „Opomena (PDF)" | ~63 KB | ne | **BigBit opomenu nema**; potpisno mesto sa M.P. i mesto/datum izdavanja, trag štampe |
| Izjava o kompenzaciji | `GET /v1/saldakonti/compensation/:id/pdf` | `/saldakonti` → tab „Kompenzacije" → tabela kompenzacija, kolona „Štampa" | ~73 KB | ne (čl. 336 ZOO) | konto i dospeće po stavci, iznos u slovima, tvrda kontrola bilateralnog bilansa, značka, N/M |
| Kartica komitenta | `GET /v1/saldakonti/partner-card/pdf` | `/saldakonti/kartica` → „Štampa PDF" | ~62 KB | ne | razdelnik hiljada (bio je jedini dokument bez njega), zajednička noga sa tragom štampe |
| IOS — izvod otvorenih stavki | `GET /v1/saldakonti/ios-pdf` | `/saldakonti/kartica` → „IOS (PDF)" | ~62 KB | ne (obrazac usaglašavanja) | isti format novca kao ostatak aplikacije, N/M |
| Dnevnik knjiženja | `GET /v1/gl/journal-book/pdf?from&to&orderType&year` | `/glavna-knjiga` → tab Dnevnik → „Dnevnik (PDF)" | zavisi od obima | ne (knjiga po ZOR) | N/M, traka filtera, kontrolni zbir sa alarmom, naziv komitenta uz šifru; **obavezan obim + kapa od 20.000 stavki** |
| Kartica konta | `GET /v1/gl/account-card/pdf?accountCode&analyticalCode&costCenter&from&to` | `/glavna-knjiga` → tab Kartica konta → „Štampa (PDF)" | zavisi od obima | ne | isti filteri kao ekran; kartični kontrolni red (saldo, ne lažni alarm) |
| Nalog za knjiženje (temeljnica) | `GET /v1/gl/journal/:id/pdf` | `/glavna-knjiga/detalj` → „Štampa" | ~68 KB | ne | status se ispisuje srpski (bio sirov „POSTED"), zajednička noga |
| Bruto bilans (zaključni list) | `GET /v1/gl/trial-balance/pdf?year&class` | `/glavna-knjiga` → „Bruto bilans (PDF)" | ~143 KB | ne | međuzbirovi po sintetici i klasi, tvrda kontrola bilansa, **ispisan obim** („samo nalozi poslovne godine, bez kumulativa") |
| **Knjiga evidencije prometa (KEP)** | `GET /v1/pdv/print/kepu?year&month&warehouseId` | `/pdv` → tab „KEPU" → **Select „Magacin"** + „Štampa (mesec)" / „Cela godina" | ~71 KB (2 strane) | **DA** (evidencija prometa) | **jedina štampa u aplikaciji sa pravim per-page carry**: strana papira = strana knjige (45 redova), DONOS i ZA PRENOS računati od početka godine i kad se štampa jedan mesec iz sredine godine (pdfmake to ne ume sam — prelom je ručan). **PET kolona po čl. 15 Pravilnika 99/2015** (BigBit-ova šesta „Iznos uplate na račun" je pred-2015 oblik bez izvora — izbačena); kolona 3 nosi vrstu, broj i DATUM isprave. **Obrazac je vezan za JEDAN magacin** (čl. 3: knjiga se vodi po prodajnom mestu); bez izabranog magacina papir se zove „INTERNI PREGLED PROMETA", nema oznaku obrasca ni potpisno mesto i nosi crveno upozorenje. Princip vrednovanja (MP) je ispisan na papiru |
| **Blagajnički izveštaj (dnevnik)** | `GET /v1/blagajna/journals/:id/dnevnik/pdf?from&to` | `/blagajna` → izbor perioda + „Blagajnički izveštaj" | ~74 KB | DA (blagajničko poslovanje) | BigBit `Blagajna`; kod nas i „Temeljnica" (broj GK naloga po stavci), iznos u slovima, upozorenje kad izveštaj sadrži NACRT stavke, i **pošteno upozorenje da dan nije zaključen** (saldo se računa u trenutku štampe). Apoenska specifikacija se štampa PRAZNA — aplikacija apoene ne evidentira |

## 4. Prodaja i završni račun

| Dokument | Ruta | Dugme | Veličina | Zakonski obrazac | Bolji od BigBita |
|---|---|---|---|---|---|
| Faktura (domaća) | `GET /v1/sales/invoices/:id/pdf` | `/fakturisanje/detalj?id=N` → Select „Vrsta štampe" + „Štampaj" | ~70 KB | ne (sadržaj računa je propisan ZPDV) | statusna značka, rekapitulacija PDV po stopama, trag štampe |
| Otpremnica sa fakture | `…/pdf?variant=delivery` | isti Select | ~57 KB | ne | 2× bez cena, jedan šablon |
| Ino faktura (izvoz, engleski) | `…/pdf?variant=export` | isti Select | ~65 KB | ne | engleska noga kroz isti zajednički obrazac |
| Avansni račun (AVR) | `…/pdf?variant=advance` (auto za `documentType='AVR'`) | `/fakturisanje/avansi` → „Štampaj"; i Select na detalju | ~63 KB | DA (ZPDV čl. 16) | stanje naplate („avans NIJE naplaćen — poreska obaveza još nije nastala") i pravna napomena; BigBit AVR štampa kao običnu fakturu |
| Knjižno odobrenje (KO) | `…/pdf?variant=credit-note` | isti Select | ~64 KB | DA (ZPDV čl. 21) | značka NACRT/KNJIŽENO/STORNIRANO, kontrolni red rekapitulacije, klauzula o potvrdi primaoca |
| Knjižno zaduženje (KZ) | `…/pdf?variant=debit-note` | isti Select | ~63 KB | DA | isto |
| **Bilans stanja** | `GET /v1/zavrsni/statements/:id/pdf?jedinica=hiljade\|dinari` | `/zavrsni-racun` | ~73 KB | **DA** (Pravilnik, Sl. glasnik RS 89/2020) | do sada je postojao samo APR XML — obračun se nije mogao odštampati ni potpisati; 7 propisanih kolona, dvoredno zaglavlje se ponavlja |
| **Bilans uspeha** | isto (`spec` po vrsti izveštaja) | `/zavrsni-racun` | ~72 KB | **DA** | isto; PDF i APR XML se hrane iz ISTOG sačuvanog obračuna, pa se ne mogu razići |

## 5. Ostale žive štampe (van ovog talasa)

| Dokument | Ruta | Dugme |
|---|---|---|
| KIF / KUF / PP-PDV | `/v1/pdv/**` | `/pdv` |
| Nalog za plaćanje | `GET /v1/placanja/orders/:id/pdf` | `/placanja` |
| Radni nalog + barkod nalepnica | `documents/work-orders` | `/work-orders` |
| Primopredaja — paket za štampu | `GET /v1/handovers/:id/print-bundle/pdf` | `/handovers` |
| Zapisnik sa sastanka | `GET /v1/sastanci/:id/arhiva/pdf` | `/sastanci` |
| Revers — potpisni PDF | `GET /v1/reversi/documents/:id/signature-pdf` | `/reversi` |
| Plan montaže — izveštaj | `GET /v1/plan-montaze/reports/:id/pdf` | `/plan-montaze` |

---

## 6. Šta JOŠ FALI do 99 % pariteta

### 6.1. Nedostajući obrasci (nova gradnja)

| Dokument | Zašto treba | Procena |
|---|---|---|
| **KR-1 komisiona evidencija** | BigBit obrazac (`QVP_KR-1`); u 4.0 NEMA NIJEDAN TRAG — `grep -riE 'komision\|consign'` po `backend/src` i `schema.prisma` = 0 pogodaka. Traži ceo model (prijem u komision → prodaja → povraćaj/isplata komitentu → veza na redni broj u KEP knjizi). **NE graditi dok vlasnik ne potvrdi da Servoteh uopšte radi komisionu prodaju** — inače je to najskuplja stavka spiska izgrađena za nikoga | velika (traži model) |
| **Statistički izveštaj (obrazac SI)** | motor, PDF i APR XML su VEĆ ožičeni (`STATEMENT_TYPE.POPDV_ANNUAL` u `apr-xml.service.ts` i `statement-pdf.service.ts`), ali `balance_formula_definitions` NEMA NIJEDAN red za SI (seed ga izričito preskače), pa bi papir izašao prazan. Nije gradnja nego PREPIS AOP pozicija sa predatog obrasca + odluka šta sa pozicijama koje glavna knjiga ne zna (broj zaposlenih, bruto zarade) | srednja (seed + odluka) |
| **Izveštaj o tokovima gotovine / o promenama na kapitalu / o ostalom rezultatu** | tri PREDATA obrasca Servoteha za 2023 (`_legacy/BigBit26/ZR_validacija/`) koji nisu ni `STATEMENT_TYPE`, ni PDF, ni XML | srednja |

**Isporučeno u ovom talasu** (bilo je na ovom spisku, sada je u §1 i §3): KEP knjiga,
trebovanje iz magacina, zapisnik o prijemu robe, blagajnički izveštaj.

> **Ispravka ranijeg reda registra:** stavka „Blagajnički dnevnik — 4.0 nema blagajnu, procena
> VELIKA" je bila **netačna**. Modul je bio živ i na backendu (`blagajna.service.ts` sa
> auto-knjiženjem u GK i brojačem pod advisory lock-om) i na frontendu (`/blagajna`) — falila je
> samo štampa, a saldo pre/posle, temeljnica i iznos u slovima su već postojali. Stvarna procena
> je bila mala/srednja.

### 6.2. Polja koja su obrasci štampali prazna — REŠENO 27.07.2026.

Migracija `20260727110000_uslovi_otpreme_iban_trag_stampe` (aditivna, idempotentna, sve kolone
nullable). Sve je živo i dokazano smoke-om `backend/scripts/smoke-grupa-b.ts` (23/23).

| Tabela | Kolone | Stanje |
|---|---|---|
| `stock_documents` | `fco`, `shipping_method`, `shipping_date`, `delivery_place`, `route`, `customer_order_ref` | ✅ dodato; unosi se na `/robno/detalj?id=N` → panel **„Uslovi otpreme"**, štampa `otpremnica` |
| `stock_documents` | `note` (napomena) | ✅ dodato — FE tip ju je deklarisao pre nego što je kolona postojala (mrtvo polje); sada se i unosi i štampa |
| `companies` | `iban`, `swift` | ✅ dodato; unosi se u **Podešavanja → Podaci firme**; čita ih ino faktura (`invoice-pdf`, štampa se u grupama po 4 — ISO 13616) i UBL `cac:PaymentMeans`. **Zaštićeno od sinhronizacije** — v. napomenu ispod |
| — | tabela `document_prints` | ✅ napravljena — brojač primeraka + žig i značka „KOPIJA" (v. §6.2.1) |
| `invoices` | `supply_date`, `payment_reference` | ✅ dodato migracijom `20260727140000` — datum prometa (BT-72, ZPDV čl. 42) i poziv na broj (BT-83). Bez njih `cac:Delivery` NIJE mogao da se emituje, iako je UBL builder bio spreman |

> **⚠️ IBAN/SWIFT i BigBit sinhronizacija — ZATVORENO 27.07.2026.** `companies` je registrovan
> entitet sync mape sa `watermark: null`, što je značilo **full refresh** (`deleteMany({})` +
> `createMany` samo nad MAPIRANIM kolonama). Kolone `iban`/`swift` BigBit nema, pa nisu u mapi —
> jedno pokretanje sinhronizacije bi ih obrisalo **tiho, bez ijedne greške u logu**, i ino faktura
> bi opet izlazila bez podataka za uplatu. Rešeno novim skupom `NATIVE_COLUMN_TABLES`
> (`sync/table-ownership.ts`): za tabele sa 3.0-native kolonama syncer **nikad ne briše red** nego
> radi `upsert` samo nad mapiranim kolonama, pa nemapirano ostaje netaknuto. Zaključano testom
> „companies: NIKAD ne briše" u `generic.syncer.spec.ts`.

> **Ispravka ranijeg reda registra.** Ovaj odeljak je tvrdio da otpremnica „štampa prazne linije
> za ručni upis". **To nije bilo tačno.** `stock-document-pdf.service.ts` je tvrdo upisivao četiri
> konstante — „Roba je FCO: magacin isporučioca", „Način otpreme: sopstveni prevoz", „Mesto
> prometa: magacin" i „Datum otpreme = datum dokumenta". Otpremnica je prateća isprava uz robu, pa
> je papir tvrdio činjenice koje niko nije uneo. Sada: uneto → štampa se uneto; neuneto → **linija
> za ručni upis** (`____________________`), nikad pretpostavka. Datum otpreme se NIKAD ne izvodi iz
> datuma dokumenta — ni na papiru ni u bazi.

#### 6.2.1. Trag štampe i značka „KOPIJA" (nadgradnja — BigBit ovo NEMA)

Do sada je trag štampe postojao samo kao tekst u nozi papira i nigde se nije pamtio; nije se moglo
odgovoriti ko je i koliko puta izvadio otpremnicu. Sada svaka štampa upisuje red u
`document_prints` (`DocumentPrintService.register`), pa:

- **1. primerak** = original, bez ikakve oznake;
- **2. i dalji** = značka „KOPIJA · primerak br. N" u zaglavlju, žig `KOPIJA` preko strane i
  „· primerak br. N" uz trag štampe u nozi;
- svaki **obrazac se broji zasebno** (otpremnica i izdatnica istog dokumenta su svaka svoj original).

> **PREGLED NIJE ŠTAMPA (ispravka 27.07.2026).** Trag se prvo upisivao na SVAKI `GET` PDF-a, a
> ruta stoji pod `ROBNO_READ` — pa je svako otvaranje dokumenta radi provere, od bilo kog korisnika
> sa pravom čitanja, trošilo redni broj primerka. Prvi FIZIČKI otisak koji ide uz robu izlazio je sa
> žigom „KOPIJA · primerak br. N" iako original nikad nije odštampan. Sada trag i žig nastaju
> **samo kad klijent pošalje `?stampa=1`**, što FE šalje isključivo iz radnje „Štampaj"; uz nju na
> detalju stoji odvojeno dugme **„Pregled"** koje ne broji. Rute: `documents/:id/pdf?stampa=1`,
> `inventory-counts/:id/pdf?…&stampa=1`. Istorija je vidljiva na
> `GET /v1/robno/documents/:id/prints` — bez nje se broj primerka sa papira nije mogao proveriti.
>
> **PRAZNA popisna lista se NIKAD ne žigoše** — to je obrazac koji komisija na terenu popunjava i
> potpisuje, pa taj papir TEK POSTAJE original; žig „KOPIJA" bi obezvredio dokument koji ide
> knjigovodstvu. Popunjena varijanta se žigoše normalno.

Pravila koja se ne smeju menjati:

- `register` **nikad ne baca** — ako upis traga padne, papir svejedno izlazi, ali bez broja
  primerka (bolje bez tvrdnje nego lažno „original");
- **neuspeo render poništava potrošen primerak** (`DocumentPrintService.discard`): broj se dodeljuje
  PRE rendera jer je deo sadržaja papira, pa bi bez poništavanja pad rendera trajno potrošio broj i
  prva uspešna štampa izašla kao „primerak br. 2". Briše se SAMO taj jedan red i samo po id-u koji
  je ta štampa napravila — pravilo „nikad ne brisati tragove po dokumentu" ostaje netaknuto;
- `copyNo` se dodeljuje pod `pg_advisory_xact_lock` u transakciji (isti obrazac kao numeracija
  blagajne) — bez toga bi dva istovremena klika na „Štampaj" pala na `uq_document_prints_copy`;
- `variant` je **NOT NULL sa default `''`** — u Postgresu su NULL-ovi u UNIQUE indeksu međusobno
  različiti, pa bi nullable kolona propustila duplikate i „KOPIJA" se ne bi pojavila nikad;
- žig **„NACRT" ima prvenstvo** nad „KOPIJA" (pdfmake nosi jedan žig po dokumentu); značka i noga i
  dalje kažu da je kopija.

**Rast i retencija.** Red je ~120 B; pri nekoliko stotina štampi dnevno to je ~10–20 MB godišnje —
zato se **ne briše ništa**, tabela je dokazni trag i vredna je upravo zato što je potpuna. Ako obim
ikada naraste, sme se arhivirati **samo po starosti** (`printed_at < now() - N godina`) i **nikad po
dokumentu**: brisanje redova jednog dokumenta obara `MAX(copy_no)` i sledeća štampa bi se lažno
predstavila kao original. Indeksi: `uq_document_prints_copy` (ključ primerka i brana od duplikata),
`idx_document_prints_document` (poziv sa svake štampe — „koliko je puta štampan dokument N"),
`idx_document_prints_at` (pretraga i eventualna retencija po datumu).

**Povezano danas:** sve štampe robnog modula (`primka`, `izdatnica`, `otpremnica`, `nivelacija`,
`prenosnica`, `kalkulacija`, `zapisnik`) i popisna lista (obe varijante). Ostale štampe (faktura,
narudžbenica, nalog GK, izvod…) još **nisu** povezane — servis je zajednički i povezivanje je po
dve linije po štampi, ali te fajlove u ovom talasu drže druge grupe.

### 6.3. Otvoreni nalazi niže ozbiljnosti

- ~~**UBL nema `cac:PaymentMeans` ni `cac:Delivery`**~~ — ✅ **REŠENO.** Oba bloka su živa
  (`UblBuilderService`); `cac:Delivery` je do 27.07. ostajao nem jer kolone `invoices.supply_date`
  nije bilo — dodata je migracijom `20260727140000` i `SefService` je čita direktno. Datum prometa
  se **NIKAD ne podmeće datumom izdavanja**: kad nije unet, blok izostaje (lažan datum prometa je
  poreski problem, praznina nije).
- ~~**UBL šalje `unitCode="H87"` za svaku stavku**~~ — ✅ **REŠENO** (`unitCodeOf`, mapa
  `items.unit` → UN/ECE Rec 20, fallback H87 uz upozorenje u logu).
- **DONOS / ZA PRENOS na knjigama** — REŠENO za KEP knjigu (ručno paginiranje po 45 redova, svaka
  strana knjige = zasebna tabela sa `pageBreak: "before"`; v. `pdv/print/kepu-pdf.service.ts`).
  **Ispravka 27.07.2026:** „ZA PRENOS" se računao kao `donos + Σ ODŠTAMPANIH redova`, pa se pri
  štampi jednog meseca — kad prva strana knjige nije odštampana cela, a skoro nikad nije — razilazio
  sa „DONOS"-om sledeće strane; papir je sam sebi protivrečio na dve uzastopne strane zakonske
  knjige. Sada oba zbira dolaze iz kumulative godine (`ZA PRENOS(N) ≡ DONOS(N+1)`), a delimično
  odštampana strana nosi napomenu koliko redova te strane pripada drugim mesecima. Zaključano
  testom „REGRESIJA: lanac DONOS/ZA PRENOS drži i kad strana knjige NIJE odštampana cela".
  Za dnevnik knjiženja i karticu konta nije propisano, pa nije ni urađeno — ako se zatraži, obrazac
  za prepis je isti, ali tamo broj redova po strani NIJE fiksan i traži merenje visine reda.
- **Blagajna nema zaključenje dana** — „Prethodni saldo" i „Novi saldo" se računaju iz stavki pri
  svakoj štampi, pa naknadno uneta stavka sa ranijim datumom tiho menja već potpisan izveštaj.
  Štampa to izričito piše u nozi; trajno rešenje je tabela zaključenih dana (šema, van štampe).
- **Blagajna nema apoensku evidenciju** — mreža apoena (5000…1 + čekovi) se štampa PRAZNA kao
  obrazac za brojanje. Deviznu blagajnu (`DevBlagajna`) nije moguće odštampati verno dok stavka
  nema devizni iznos i kurs.
- **QR kod na otpremnici i računu** — `bwip-js` podržava `bcid:"qrcode"` bez nove zavisnosti;
  traži metodu `qrSvg()` u deljenom `documents/barcode.service.ts`. Danas štampamo Code 128.
- **Kartica konta nema polja perioda na ekranu** — ruta prima `from`/`to`, filter ih ne šalje.
- **Dugme za opomenu na `/naplata`** — ceo dunning tok je tamo, štampa je danas na kartici komitenta.
- **Bruto bilans na `/zavrsni-racun`** — tab „Bruto bilans" nema dugme za štampu; obim tog ekrana je
  KUMULATIVAN (`posting_date <= 31.12.`), a PDF u Glavnoj knjizi je po poslovnoj godini. Obim je
  sada ISPISAN na papiru, ali definiciju treba presuditi i svesti na jedan čitalac.

**Otvoreno posle integracije 27.07.2026 (pošteno popisano):**

- **Trag štampe pokriva SAMO robni modul** — 8 obrazaca robnog dokumenta + popisna lista u obe
  varijante. Faktura, narudžbenica, upit, nalog GK, kartica konta, bankovni izvod, opomena,
  kompenzacija, SEF prikazi, KEP knjiga i blagajnički izveštaj **nemaju** brojač primeraka ni značku
  „KOPIJA". Servis je zajednički i povezivanje je 3 linije po štampi (`register` sa `isPrintAction`,
  `copyNo` u `buildPageFooter`, `discard` u `catch` oko rendera) — posao za jedan prolaz.
- **KEP — MP ili VP knjiga nije presuđeno.** `robno/kepu-book.util.ts` puni knjigu MALOPRODAJNOM
  vrednošću, a `pdv/kepu.service.ts` u komentaru tvrdi da je knjiga VELEPRODAJNA. BigBit ima DVA
  odvojena izveštaja („Knjiga KEPU" i „Knjiga KEPU_MP") nad dva upita; mi imamo JEDNU tabelu i jedan
  tvrdo kodiran princip. Papir princip **ispisuje**, ali za pravo rešenje treba odluka knjigovođe pa
  ili druga vrednosna kolona ili `book_type` u `kepu_book_entries`.
- **KEP — kolona 3 nema poslovno ime dobavljača** (čl. 15 ga traži pri nabavci). Vrsta, broj i datum
  isprave se štampaju; dobavljač traži dopunu PUNJENJA knjige (`kepu-book.util.ts`), ne štampe.
- **KEP — pet mrtvih zastavica u `companies`** (`kepuAtPurchasePrice`, `kepuAtCostAccountingPrice`,
  `kepuByExchangeRate`, `postKepuDifferences`, `postRetailKepuDifferences`) i dalje nema nijednog
  čitaoca. BigBit po njima bira osnovicu KEPU reda; dok se ne ožiče, podešavanje firme nema efekta.
- **Zapisnik o prijemu — poređenje je PO ARTIKLU, ne po redu.** Veza „stavka prijemnice → stavka
  narudžbenice" u šemi ne postoji, pa se obe strane agregiraju po artiklu i papir to izričito piše.
  Poređenje red-na-red traži novu kolonu (npr. `stock_document_items.purchase_order_item_id`).
- **Zapisnik o prijemu — tri kvalitativne kolone i dalje prazne** (`expiry_date`, `batch_no`, `note`
  po stavci ne postoje). Kad stignu, menjaju se tačno tri ćelije (označene konstantom `MANUAL`).
- **Prenos — glavna knjiga ga ne knjiži.** `PREIZ`/`PREUL` imaju `posting_template = 0` jer prenos
  između sopstvenih magacina ne menja imovinu firme. Ako se zalihe u GK vode analitički PO MAGACINU,
  treba nalog 1310(odredište)/1310(izvor) — traži odluku knjigovođe i šemu kontiranja.
- **Prenos — obe strane para nose ISTI broj** („0001/2026"), jer se numeracija vodi po vrsti
  dokumenta. U listi se sada razlikuju po novoj koloni **„Vrsta"** (PREIZ/PREUL), ali zajednički
  broj para bi bio čistije rešenje.
- **Prenos ne poštuje seriju/LOT ni rok trajanja** — te kolone u `stock_document_items` ne postoje
  (ista rupa kao kod zapisnika o prijemu).
- **Vrednovanje prenosa je uvek ponderisani prosek**, i kad je magacin podešen na metodu poslednje
  nabavne cene (`Warehouse.averagePrices = false`, što je Prisma default). Σ vrednosti zaliha ostaje
  očuvana, ali cena koštanja po magacinu ne prati izabranu valuacionu metodu. Treba presuditi i,
  ako se ostaje na proseku, zapisati kao svesnu odluku.
- **Broj priloga / apoeni / devizna blagajna** — v. dve stavke iznad; nepromenjeno.

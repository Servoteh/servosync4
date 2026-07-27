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
| **Otpremnica (bez cena)** | `…/pdf?variant=otpremnica` | `/robno/detalj?id=N` | ~66 KB | ne | **pravi Code 128 SVG po stavci** (BigBit štampa bar kod kao TEKST), barkod broja dokumenta, tri potpisa, N/M |
| Nivelacija cena (NIV) | `…/pdf?variant=nivelacija` | `/robno/detalj?id=N` | ~71 KB | ne | kontrola „razlika vrednosti vs knjižena nivelacija" nad NEZAOKRUŽENOM osnovom, iznos u slovima, N/M |
| Prenosnica (prenos magacina) | `…/pdf?variant=prenosnica` | `/robno/detalj?id=N` | ~71 KB | ne | **štampa OBA magacina** i broj parnog dokumenta; BigBit `Prenosnica - DEFAULT` imenuje samo odredište, pa se ne vidi odakle je roba otišla |
| Zapisnik o višku / manjku | `…/pdf?variant=zapisnik` | `/robno/detalj?id=N` | ~70 KB | ne | BigBit ovaj obrazac NEMA — kod nas imenovan dokument sa komisijskim potpisima i vezom na broj popisa |
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
| **KEPU knjiga** (štampa sa DONOS / ZA PRENOS) | zakonska evidencija prometa; motor i tabela `kepu_book_entries` postoje, štampe nema | srednja |
| **Trebovanje iz magacina** | BigBit `Trebovanje` — postoji u pogonu, nema obrazac u 4.0 | mala |
| **KR-1 komisiona evidencija** | BigBit obrazac; u 4.0 nema podataka | velika (traži model) |
| **Zapisnik o prijemu robe (kvalitativni)** | odvojen od primke; danas se prijem dokazuje samo primkom | srednja |
| **Blagajnički dnevnik / uplatnica-isplatnica** | BigBit ih ima; 4.0 nema blagajnu | velika |
| **Statistički aneks i Izveštaj o tokovima gotovine** | uz bilanse, za APR predaju | srednja |

### 6.2. Nedostajuća polja u šemi (obrazac ih štampa kao prazne linije)

| Tabela | Kolone | Posledica danas |
|---|---|---|
| `stock_documents` | `fco`, `nacin_otpreme`, `datum_otpreme`, `mesto_isporuke`, `po_porudzbini_od`, `ruta` | otpremnica štampa prazne linije za ručni upis (bolje nego izmišljena vrednost, ali nije paritet) |
| `stock_documents` | `note` (napomena) | FE tip `StockDocument` je deklariše, kolone nema — mrtvo polje |
| `companies` | `iban`, `swift` | ino faktura izlazi bez podataka za plaćanje (`invoice-pdf.service.ts` ih čita, kolona nema) |
| — | tabela `document_prints` | nema brojača primeraka ni značke „KOPIJA" (uzor §B6) |

### 6.3. Otvoreni nalazi niže ozbiljnosti

- **UBL nema `cac:PaymentMeans` ni `cac:Delivery`** — naša izlazna e-faktura nema račun za
  uplatu, poziv na broj i datum prometa; štampa verno prikazuje prazninu (`UblBuilderService`).
- **UBL šalje `unitCode="H87"` za svaku stavku** — štampa prikazuje mašinski kod umesto „kom/m/kg".
- **DONOS / ZA PRENOS na knjigama** (dnevnik, kartica konta) — pdfmake nema per-page carry;
  traži prelom u dva prolaza. Za KEPU je obavezno, za dnevnik nije propisano.
- **QR kod na otpremnici i računu** — `bwip-js` podržava `bcid:"qrcode"` bez nove zavisnosti;
  traži metodu `qrSvg()` u deljenom `documents/barcode.service.ts`. Danas štampamo Code 128.
- **Kartica konta nema polja perioda na ekranu** — ruta prima `from`/`to`, filter ih ne šalje.
- **Dugme za opomenu na `/naplata`** — ceo dunning tok je tamo, štampa je danas na kartici komitenta.
- **Bruto bilans na `/zavrsni-racun`** — tab „Bruto bilans" nema dugme za štampu; obim tog ekrana je
  KUMULATIVAN (`posting_date <= 31.12.`), a PDF u Glavnoj knjizi je po poslovnoj godini. Obim je
  sada ISPISAN na papiru, ali definiciju treba presuditi i svesti na jedan čitalac.

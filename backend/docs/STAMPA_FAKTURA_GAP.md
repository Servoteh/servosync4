# Štampa izlaznih faktura — gap prema pet BigBit obrazaca

Popis razlika između onoga što `InvoicePdfService` danas štampa i pet stvarnih BigBit izlaza
iz [docs/zahtevi/fakture-obrasci-2026-08/](../../docs/zahtevi/fakture-obrasci-2026-08/).
Analiza obrazaca (šta koji obrazac sadrži) je u
[STAMPA_IZLAZNIH_FAKTURA.md](STAMPA_IZLAZNIH_FAKTURA.md) — ovaj dokument je nastavak: **šta kod
radi, šta ne radi i šta fali u modelu**. Nijedna linija koda nije menjana pri pisanju ovoga.

Oznake: **S** = sat-dva, **M** = pola dana do dana, **L** = više od dana ili traži odluku/migraciju.
**NEPOZNATO** = nije se moglo utvrditi iz obrazaca ni iz koda.

---

## 1. Čime raspolažemo

### 1.1 Renderer

`PdfService` (`backend/src/modules/documents/pdf.service.ts:28`) je tanak omotač oko **pdfmake 0.3**
(server-side, `createPdf(...).getBuffer()`), bez puppeteer-a i bez ijedne druge PDF zavisnosti.

| mogućnost | stanje |
|---|---|
| font | samo **Roboto** (regular/medium/italic/mediumitalic) iz `vfs_fonts`, `pdf.service.ts:41-48`. Nema serif fonta ni Arial-a. Original je Arial-oid — Roboto je vizuelno blizak, ali nije isti. |
| eksterni resursi | **zabranjeni** — `setUrlAccessPolicy(() => false)` (`pdf.service.ts:50`). Svaki logo/QR mora biti inline (data URL ili `svg` node). |
| slike | data URL; jedini asset u repou je `SERVOTEH_LOGO_DATA_URL` (`modules/documents/servoteh-logo.ts`, JPEG base64). |
| SVG | podržan (`BarcodeService.code128Svg` vraća SVG koji pdfmake embeduje) — `modules/documents/barcode.service.ts:17`. |
| QR kod | **nije implementiran**, ali zavisnost `bwip-js` već postoji i podržava `bcid: "qrcode"` → nova metoda u `BarcodeService` je trivijalna. |
| tabele | `table.body` + `headerRows` + `widths` + `layout` (debljine/boje linija, padding) — koristi se svuda; puni okviri i unutrašnje vertikale su stvar `layout`-a. |
| ponavljanje zaglavlja tabele | `headerRows: n` — radi. |
| **ponavljanje zaglavlja STRANE** | pdfmake ima `header: (currentPage, pageCount) => Content`, ali **nigde u repou nije upotrebljen** — pretraga po `modules/` nalazi samo `footer:`. Novo za ovaj posao (ino usluga ga traži). |
| podnožje / numeracija strana | `footer: (currentPage, pageCount)` — koristi se, `invoice-pdf.service.ts:258-264`. |
| linije / okviri van tabela | `canvas` (`invoice-pdf.service.ts:513`) i `layout` okviri. |
| prelom strane | `pageBreak: "before"` (pdfmake) — u repou se **ne koristi** nigde; treba za „blok banke na posebnoj strani". |

### 1.2 Postojeće varijante štampe

`InvoicePrintVariant = "withPrices" | "withoutPrices" | "export"` (`invoice-pdf.service.ts:24`).

- Izbor varijante je **samo po `invoice.isExport`** (`invoice-pdf.service.ts:62-63`) — `documentType`
  se ne gleda. Posledica: **IFUSL se danas štampa istim šablonom kao IFR**, a **IZVUS istim kao
  IZVRO**. Podela roba/usluga u štampi ne postoji.
- Ulazne tačke: `SalesController.invoicePdfDownload` (`sales.controller.ts:69-87`, `GET
  /api/v1/sales/invoices/:id/pdf?variant=…`), `InvoiceMailService.sendInvoice`
  (`print/invoice-mail.service.ts:62-65`) i SEF prilog `sef.service.ts:146-148`.
- `withoutPrices` (otpremnica) **nije među pet donetih obrazaca** — ostaje kakav jeste, samo se
  pazi da ga preuređivanje ne obori.

### 1.3 Koje podatke štampa danas dobija

`buildInvoicePdf` učitava (`invoice-pdf.service.ts:56-99`):

| izvor | šta se uzima | fajl:linija |
|---|---|---|
| `Invoice` + `items` | ceo red + sve stavke | `:56-59` |
| `Customer` | `name, address, city, postalCode, country, taxId, registrationNumber` | `:68-79` |
| `Company` (izdavalac) | `companyName, address, city, taxId, registrationNumber, bankAccount, phone, email` | `:138-150` |
| `Item` | `name, foreignName, unit` — ali se **koristi samo naziv**, `unit` se odbacuje | `:188-198` |
| `Invoice` (AVR) | broj odbijenog avansa | `:90-99` |

Model (`prisma/schema.prisma`): `Invoice` `:3838-3919`, `InvoiceItem` `:3926-3953`,
`Customer` `:164-227`, `Company` `:935-1010`, `Item` `:793-869`, `Warehouse` `:487-501`,
`Salesperson` `:766-786`, `TaxRate` `:126-141`, `StockDocument` `:3328-3383`.

### 1.4 Presek po obrascu (grubo)

| obrazac | koliko je danas tačno |
|---|---|
| **IFR** (roba) | ~15 %. Poklapaju se: logo, broj/datum, kupac (bez okvira), tabela stavki (bez pola kolona), osnovica/PDV/za plaćanje, tekući račun. Sve ostalo (traka uslova, potpisi, napomene, memorandum, format brojeva) fali. |
| **IFGP** | isto kao IFR — razlika prema IFR je **samo naziv magacina** u „Robu izdao"; magacin u modelu ne postoji, pa je danas 0 %. |
| **IFUSL** (usluga) | ~10 %. Nema svog šablona — štampa se kao roba, sa Kat. br. kolonom koje ne treba, pogrešnim naslovom, pogrešnim sudom i sa 4 potpisa umesto jednog. |
| **ino roba** (228/25) | ~25 %. Engleski labeli i EUR postoje; fali `Stat. goods No.`, `Catalog No.`, `Unit`, TOTAL/DISCOUNT blok po originalu, slobodan tekst (ponuda/JCI/način plaćanja), tačan član 24. **Blok banke je mrtav kod** (v. §2, red „IBAN/SWIFT"). |
| **ino usluga** (060/26) | ~15 %. Sve mane ino-robe + nema ponavljanja zaglavlja po stranama, nema otpremnog bloka, nema bloka banke na zasebnoj strani, štampa se sa kolonama koje usluga nema. |

---

## 2. Tabela gap-ova

### 2.1 Zajedničko svim obrascima

| obrazac | element | stanje danas | traženo | gde se menja | težina |
|---|---|---|---|---|---|
| SVI | logo + TÜV/ISO znak | samo Servoteh logo levo (`invoice-pdf.service.ts:284`) | logo levo + **TÜV Rheinland / ISO 9001:2008 znak desno**, ispod puna linija | `invoice-pdf.service.ts:268-296` + nov asset pored `documents/servoteh-logo.ts` | M (asset fali) |
| SVI | red firme ispod logoa | ne postoji; podaci firme su u levoj koloni „PRODAVAC" (`:303-310`) | jedan centriran red: naziv, adresa, tel/fax, e-mail, `web::` — doslovno | `invoice-pdf.service.ts:268-296`, `:298-342` | S |
| SVI | podnožje = memorandum | tekstualna traka „Račun br. X · strana 1/1" (`:258-264`) | traka **6 partnerskih logotipa** + registarski red (MB / Reg. br. / Šifra delatnosti / PIB) + APR rečenica + „google mapa" QR desno | `invoice-pdf.service.ts:258-264`; QR → nova metoda u `documents/barcode.service.ts` | L (6 asseta) |
| SVI | blok „PRODAVAC" levo | postoji (`:298-342`) | **ne postoji na obrascu** — podaci firme su u memorandumu; leva strana nosi samo „K u p a c:" | `invoice-pdf.service.ts:298-342` | S |
| SVI | okvir oko kupca | nema okvira | okvir oko bloka kupca; naslov `K u p a c:` razmaknutim slovima **iznad** okvira | `invoice-pdf.service.ts:298-342` | S |
| SVI | separator hiljada | nema ga (`formatDecimal` samo menja tačku u zarez, `:667-674`) | **`99,363.64`** — zarez za hiljade, tačka za decimale, na svih pet obrazaca | `invoice-pdf.service.ts:667-690` | S |
| SVI | valuta uz iznos | `fmtMoney` lepi „RSD"/„EUR" uz svaki iznos (`:684-690`) | valuta se piše **samo u naslovu reda** (`Za uplatu (RSD):`, `TOTAL AMOUNT ( EUR)`), ne uz brojeve | `invoice-pdf.service.ts:684-690`, `:417-481` | S |
| SVI | format datuma | domaći `dd.MM.yyyy.`, ino `yyyy-MM-dd` (`:655-661`) | domaći **`DD-MM-YY`**; ino **`DD.MM.GGGG.`**; ino `Date of delivery` **`DD-MM-YY`** | `invoice-pdf.service.ts:655-661` | S |
| SVI | broj dokumenta | `IFR0043/2026` (`numbering.service.ts:72`) | **`657/25`** — bez prefiksa, dvocifrena godina | `numbering.service.ts:72` (izvorno) ili formatiranje u štampi `invoice-pdf.service.ts:276` — **odluka, v. §5** | M |
| SVI | rabat = 0 | prazna ćelija (`formatDiscount`, `:677-681`) | štampa se `0` u koloni i `Rabat: 0.00` / `DISCOUNT: 0.00` u zbiru | `invoice-pdf.service.ts:677-681`, `:417-481` | S |
| SVI | kolona j.m. | **ne postoji** (učita se `Item.unit` na `:189` pa se odbaci na `:193-197`) | kolona `j.m.` / `Unit` posle naziva | `invoice-pdf.service.ts:180-199`, `:344-415` | S |
| SVI | zaglavlja sa razmaknutim slovima | obična (`N A Z I V   R O B E` → „Opis") | doslovno `N A Z I V   R O B E`, `C E N A`, `O P I S`, `I Z N O S` | `invoice-pdf.service.ts:574-644` | S |
| SVI | okvir tabele stavki | bez vertikala (`vLineWidth: () => 0`, `:407`) | pun okvir sa vertikalama, zaglavlje sa linijom iznad i ispod | `invoice-pdf.service.ts:399-414` | S |
| SVI | izbor šablona | samo `isExport` (`:62-63`) | 4 šablona po `documentType`: IFR/IFGP · IFUSL · IZVRO/IZVGP · IZVUS | `invoice-pdf.service.ts:24`, `:62-63`, `:203-266` | M |
| SVI | potpis „Potpis i pečat" | jedna linija desno (`:506-518`) | ne postoji ni na jednom od pet obrazaca — zamenjuje se blokovima po obrascu | `invoice-pdf.service.ts:506-518` | S |
| SVI | napomena `invoice.note` | štampa se kao „Napomena: …" (`:501-502`) | na obrascu nema generičke napomene; slobodan tekst postoji samo na ino robi i ide na tačno mesto | `invoice-pdf.service.ts:501-502` | S |

### 2.2 IFR + IFGP (domaća, roba)

| obrazac | element | stanje danas | traženo | gde se menja | težina |
|---|---|---|---|---|---|
| IFR/IFGP | `Tekući račun: 160-110610-83` | u podnožju kao „Tekući račun: …" (`:491-495`) | **centriran, ispod reda firme, iznad kupca**, podebljan | `invoice-pdf.service.ts:483-495`, `:239-242` | S |
| IFR/IFGP | naslov | „RAČUN" + podnaslov sa datumom u istom redu (`:282-295`) | desno, krupno **`Račun br. 657/25`**, ispod `Datum izdavanja računa:` i `Valuta za plaćanje:`, pa niže `Mesto izdavanja računa: Beograd` | `invoice-pdf.service.ts:268-296` | M |
| IFR/IFGP | `Mesto izdavanja računa` | **ne štampa se** | `Beograd` — `Company.invoiceIssuingPlace` postoji (`schema.prisma:992`) ali se ne učitava | `invoice-pdf.service.ts:137-150` (dopuniti `select`) | S |
| IFR/IFGP | traka uslova (4 kolone) | **ne postoji** | `Roba je FCO \| Način plaćanja \| Način otpreme robe \| Datum prometa dobara` sa vrednostima ispod | `invoice-pdf.service.ts:203-266` (nova sekcija) + **4 nova polja u modelu, v. §3** | L |
| IFR/IFGP | kolona `PDV` (stopa po stavci) | ne postoji (štampa se iznos PDV-a, ne stopa) | `20%` po stavci — iz `InvoiceItem.vatRateCode` (`schema.prisma:3940`) → `TaxRate.baseRate` (`:129`) | `invoice-pdf.service.ts:344-415` + novo učitavanje stopa | M |
| IFR/IFGP | kolona `Kat. br.` | ne postoji | kataloški broj — `Item.catalogNumber` (`schema.prisma:795`) postoji, ne učitava se | `invoice-pdf.service.ts:180-199`, `:344-415` | S |
| IFR/IFGP | kolone „Osnovica" i „PDV" po stavci | štampaju se (`:383-384`) | **ne postoje na obrascu** — stavka ima samo `CENA`, `R%`, `VREDNOST` | `invoice-pdf.service.ts:352-357`, `:380-386` | S |
| IFR/IFGP | zbirni blok | 2–3 reda desno bez okvira (`:417-481`) | 5 redova: bruto zbir (bez labele) · `Rabat:` · `Vrednost bez PDV (osnovica):` · `PDV po stopi 20% X <osnovica> =` · **uokvireno** `Za uplatu (RSD):` | `invoice-pdf.service.ts:417-481` | M |
| IFR/IFGP | red PDV-a nosi osnovicu | ne (samo iznos) | tekst reda sadrži i stopu i osnovicu: `PDV po stopi 20% X 99,363.64 =` | `invoice-pdf.service.ts:417-481` | S |
| IFR/IFGP | napomene (4 reda) | nema ih | `Napomena o poreskom oslobodjenju: NEMA` · reklamacije **„po prijemu robe"** · **Privredni sud** · zatezna kamata | `invoice-pdf.service.ts:483-520` | S |
| IFR/IFGP | 4 kolone potpisa | jedna linija „Potpis i pečat" | `Robu primio` (prazno) · `Preuzeo za prevoz` (SERVOTEH doo + adresa + PIB/MB) · `Robu izdao` (`Broj l.k.:____` + `iz magacina <MAGACIN>` + adresa magacina) · `Odgovorno lice` (ime) | `invoice-pdf.service.ts:483-520` | M |
| IFGP | naziv magacina | **nema podatka** | `Gotovi proizvodi` vs `Magacin robe` — jedina razlika IFGP↔IFR | `invoice-pdf.service.ts` + **`Invoice.warehouseId`, v. §3** | L |
| IFR/IFGP | ime odgovornog lica | nema ga | `Dragana Korkut` — `Salesperson.name` (`schema.prisma:768`) + `Invoice.salespersonId` (`:3898`) postoje, ali se `salespersonId` **nikad ne upisuje** (`fakturisanje.service.ts:171-193`) | `fakturisanje.service.ts:171-193` + `invoice-pdf.service.ts:66-86` | M |

### 2.3 IFUSL (domaća, usluga)

| obrazac | element | stanje danas | traženo | gde se menja | težina |
|---|---|---|---|---|---|
| IFUSL | zaseban šablon | **ne postoji** — štampa se kao roba | poseban šablon (razlike nisu kozmetičke) | `invoice-pdf.service.ts:24`, `:62-63`, `:203-266` | L |
| IFUSL | naslov | „RAČUN" jednoredno | `Račun` u jednom redu, ispod **podvučeno** `br. 653/25` | `invoice-pdf.service.ts:268-296` | S |
| IFUSL | gornji desni blok | Datum + Valuta | `Datum izdavanja računa` · `Mesto izdavanja računa` · **`Rok za plaćanje`** · **`Datum prometa`** | `invoice-pdf.service.ts:268-296` + `Invoice.deliveryDate` (§3) | M |
| IFUSL | traka uslova | — | **ne sme je biti** (usluga nema FCO/otpremu) | `invoice-pdf.service.ts:203-266` | S |
| IFUSL | kolona Kat. br. | (danas se ne štampa nijedna) | **ne sme je biti**; kolona naziva se `O P I S` | `invoice-pdf.service.ts:344-415` | S |
| IFUSL | nazivi kolona | „Opis"/„Za plaćanje"/„Rabat" | `O P I S` · `I Z N O S` · `Rab%` | `invoice-pdf.service.ts:574-604` (novi set labela) | S |
| IFUSL | zbirni blok | 2–3 reda bez okvira | **5 uokvirenih redova**: `Vrednost bez PDV (osnovica)` · `Odobren rabat` · `Ukupno vrednost bez PDV (osnovica)` · `PDV po stopi 20% X … =` · `Ukupno za uplatu (RSD)` (poslednji podebljano+deblji okvir) | `invoice-pdf.service.ts:417-481` | M |
| IFUSL | tekst reklamacije | — | „u roku od 5 dana" (**bez** „po prijemu robe") | `invoice-pdf.service.ts:483-520` | S |
| IFUSL | nadležni sud | — | **Trgovinski sud u Beogradu** (a ne Privredni) | `invoice-pdf.service.ts:483-520` | S |
| IFUSL | potpisi | jedna linija desno | **samo `Odgovorno lice`** + ime + `Br. l.k.:008165163` | `invoice-pdf.service.ts:483-520` + broj l.k. (§3) | M |

### 2.4 Ino faktura za robu (Invoice 228/25)

| obrazac | element | stanje danas | traženo | gde se menja | težina |
|---|---|---|---|---|---|
| ino roba | naslov | „INVOICE" levo uz logo + podnaslov | desno, krupno `Invoice No. 228/25` | `invoice-pdf.service.ts:268-296` | S |
| ino roba | gornji levi blok | dve kolone SELLER/BUYER | parovi labela/vrednost desno od labele: `Date:` `Customer:` `Address:` `Delivery term:` `Payment terms:` | `invoice-pdf.service.ts:298-342` | M |
| ino roba | vrednosti uslova ostaju srpske | — | `magacin kupca`, `virmanom` se **ne prevode** | `invoice-pdf.service.ts:613-644` | S |
| ino roba | kolona `Catalog No.` | ne postoji | postoji (`Item.catalogNumber`, `schema.prisma:795`) | `invoice-pdf.service.ts:180-199`, `:344-415` | S |
| ino roba | kolona `Stat. goods No.` | ne postoji | carinska tarifa — `Item.customsTariff` (`schema.prisma:828`) postoji, ne učitava se; **štampa se i kad je prazna** | `invoice-pdf.service.ts:180-199`, `:344-415` | S |
| ino roba | kolone `Net`/`VAT` po stavci | štampaju se (`:383-384`) | **ne postoje** — ino faktura nema PDV kolone | `invoice-pdf.service.ts:352-357`, `:380-386` | S |
| ino roba | zbir | `Net total / VAT / Total due` | `TOTAL` · `DISCOUNT:` · uokvireno `TOTAL AMOUNT ( EUR)` (razmak u `( EUR)` je iz originala) | `invoice-pdf.service.ts:417-481`, `:613-644` | M |
| ino roba | poziv na ponudu | ne štampa se | `Fakturisanje je izvršeno na osnovu ponude 0206-25` — veza postoji (`Invoice.copiedFromDocId`, `schema.prisma:3868`), ne koristi se u štampi | `invoice-pdf.service.ts:483-520` + učitavanje broja izvornog PROF/PON | M |
| ino roba | broj izvozne deklaracije | ne štampa se | `25-0401-000005` — **nema namenskog polja** (v. §3) | `invoice-pdf.service.ts:483-520` + model | M |
| ino roba | `Način plaćanja: avansno` | ne štampa se | slobodan red ispod deklaracije, **na srpskom** | `invoice-pdf.service.ts:483-520` | S |
| ino roba | poresko oslobođenje | generički engleski tekst „VAT exempt — Article 24…" (`:642-643`) | srpski, tačan član: `Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.` | `invoice-pdf.service.ts:642-643`, `:503-504` | S |
| ino roba | reklamacije/sud/kamata | ne štampaju se | štampaju se **jednom** (u originalu su odštampani dvaput — greška BigBita, ne prepisuje se) | `invoice-pdf.service.ts:483-520` | S |
| ino roba | **blok banke IBAN/SWIFT** | grana postoji (`:496-500`) ali je **MRTAV KOD**: `loadIssuer` (`:137-173`) nikad ne postavlja `iban`/`swift`, pa su uvek `undefined` → ništa se ne štampa | dve kolone: `Beneficiary Customer:` (IBAN, naziv, adresa) i `Bank of beneficiary:` (SWIFT, banka + valuta, adresa banke, država) | `invoice-pdf.service.ts:137-173`, `:496-500` + **IBAN/SWIFT/adresa banke u modelu, v. §3** | L |
| ino roba | potpisi | jedna linija „Signature & stamp" | **nema potpisnih linija** | `invoice-pdf.service.ts:506-518` | S |

### 2.5 Ino faktura za uslugu (Invoice 060/26)

| obrazac | element | stanje danas | traženo | gde se menja | težina |
|---|---|---|---|---|---|
| ino usluga | zaseban šablon | ne postoji (isto kao ino roba) | poseban šablon | `invoice-pdf.service.ts:24`, `:62-63` | M |
| ino usluga | kolone | iste kao ino roba | `No. \| Description \| Unit \| Quantity \| Price \| Total` — **bez `Catalog No.` i bez `Stat. goods No.`** | `invoice-pdf.service.ts:344-415` | S |
| ino usluga | `Date of delivery:` | ne postoji | **datum + mesto**: `06-03-26 , Beograd` | `invoice-pdf.service.ts:268-296` + `Invoice.deliveryDate` (§3) + `Company.invoiceIssuingPlace` | M |
| ino usluga | `Payment terms:` | „Due date" u podnaslovu | zaseban red, vrednost je **datum** `06.03.2026.` | `invoice-pdf.service.ts:268-296` | S |
| ino usluga | ponavljanje zaglavlja po stranama | **ne postoji** — zaglavlje je deo `content` (`:242`), štampa se samo jednom | na SVAKOJ strani: logo, red firme, `Invoice No.`, Date/Customer/Address/Date of delivery/Payment terms, pa zaglavlje tabele | `invoice-pdf.service.ts:239-266` (prelazak na `header:` funkciju + povećan gornji `pageMargin`) | L |
| ino usluga | `Strana X od Y` | `Račun br. … · strana 1/1` centrirano (`:258-264`) | `Strana 1 od 3` **desno dole**, ispod memoranduma | `invoice-pdf.service.ts:258-264` | S |
| ino usluga | `www.BigBit.rs` | — | **ne prepisuje se** (vodeni žig tuđeg programa) | — | — |
| ino usluga | poresko oslobođenje | generički čl. 24 | `Napomena: Oslobodjeno PDV-a na osnovu člana 24. stav 2 Zakona o pdv.` — **drugi stav nego za robu** | `invoice-pdf.service.ts:503-504`, `:642-643` | S |
| ino usluga | reklamacije/sud | — | „u roku od 5 dana" + **Trgovinski sud u Beogradu** | `invoice-pdf.service.ts:483-520` | S |
| ino usluga | otpremni blok | **ne postoji** | `Paritet:` · `Količina:` · `Dimenzije:` · `Ukupna brutto:` · `Ukupna Netto:` · `Mesto istovara:` (naziv/ulica/pošta+mesto+država) · `Kontakt špeditera u uvozu:` (firma + telefoni) | `invoice-pdf.service.ts:483-520` + **7 novih podataka u modelu, v. §3** | L |
| ino usluga | zbir na kraju stavki | — | `TOTAL` i uokvireno `TOTAL AMOUNT ( EUR)` na strani gde se stavke završavaju (str. 2) | `invoice-pdf.service.ts:417-481` | S |
| ino usluga | blok banke na zasebnoj strani | — | poslednja strana nosi **samo** zaglavlje + blok banke → `pageBreak` | `invoice-pdf.service.ts:239-266` | M |
| ino usluga | brojevi u otpremnom bloku | — | `1.720,00 kg` — **tačka za hiljade, zarez za decimale**, obrnuto od iznosa na istom papiru | `invoice-pdf.service.ts:667-674` | S |

---

## 3. Nedostajući podaci u modelu

„Ima?" = da li podatak uopšte postoji u Prisma šemi (`backend/prisma/schema.prisma`).

| # | podatak | obrazac | ima? | gde je danas | predlog gde bi živeo |
|---|---|---|---|---|---|
| 1 | **Magacin računa** (`iz magacina Magacin robe` / `Gotovi proizvodi` + adresa) | IFR, IFGP | delimično | `Warehouse` model postoji (`:487-501`: `name:490`, `street:491`, `city:492`). `Invoice` **nema `warehouseId`**. Posredno: `Invoice.stockDocumentId` (`:3897`) → `StockDocument.warehouseId` (`:3339`) — **samo za auto-robne račune**, ručno kucan IFR nema ništa. Legacy `GoodsDocument.warehouseId` (`:1102`). | **`Invoice.warehouseId Int?`** (meki ref `warehouses.id`), default iz `DocumentType.defaultWarehouseId` (`:920`) |
| 2 | **Roba je FCO** (`magacin kupca`) | IFR, IFGP | NE | legacy `GoodsDocument.fco` (`:1096`, VarChar 30) — nova `Invoice` tabela ga nije prenela | **`Invoice.fco String?`** VarChar(30); ponuđene vrednosti iz `ComboValue` (`:1213-1219`) |
| 3 | **Način plaćanja** (`virmanom`) | IFR, IFGP (traka); ino roba (`Payment terms`) | delimično | `Customer.paymentMethod` (`:203`) postoji kao podrazumevana vrednost kupca; legacy `GoodsDocument.paymentMethod` (`:1100`). Na `Invoice` **nema** | **`Invoice.paymentMethod String?`** VarChar(50), prepis sa kupca pri kreiranju |
| 4 | **Način otpreme robe** (`lično`) | IFR, IFGP | NE | legacy `GoodsDocument.shipmentMethod` (`:1095`) | **`Invoice.shipmentMethod String?`** VarChar(30) |
| 5 | **Datum prometa dobara / Datum prometa / Date of delivery** | IFR, IFGP, IFUSL, ino usluga | NE | `Invoice` ima samo `documentDate` (`:3852`) i `dueDate` (`:3853`). SEF-u isto fali (`sef-incoming.service.ts:456` beleži da se `cbc:ActualDeliveryDate` ne parsira) | **`Invoice.deliveryDate DateTime?`** — koristi i štampa i UBL `cbc:ActualDeliveryDate` |
| 6 | **Mesto izdavanja računa** (`Beograd`) | IFR, IFGP, IFUSL, ino usluga (uz Date of delivery) | **DA** | `Company.invoiceIssuingPlace` (`:992`, default `Beograd`) — samo se ne učitava u `loadIssuer` (`invoice-pdf.service.ts:138-150`) | ostaje gde jeste; dopuniti `select` |
| 7 | **Odgovorno lice — ime** (`Dragana Korkut`, `Ana Golubović`) | IFR, IFGP, IFUSL | **DA (verovatno)** | `Salesperson.name` (`:768`) + `firstName` (`:772`); `Invoice.salespersonId` (`:3898`) postoji ali ga `createProforma` **ne upisuje** (`fakturisanje.service.ts:171-193`) | popuniti `Invoice.salespersonId` pri kreiranju; alternativa = polje na `Company` ako je odgovorno lice jedno za celu firmu (**odluka, §5**) |
| 8 | **Broj lične karte odgovornog lica** (`008165163`) | IFUSL | **DA (verovatno)** | `Salesperson.idNumber` (`:773`, VarChar 20). Na IFR/IFGP je to prazna linija u koloni „Robu izdao" (popunjava se rukom) → tamo podatak i ne treba | ostaje `Salesperson.idNumber`; **provera zaštite ličnih podataka, §5** |
| 9 | **Kataloški broj artikla** | IFR, IFGP, ino roba | **DA** | `Item.catalogNumber` (`:795`) — `resolveItemNames` ga ne učitava (`invoice-pdf.service.ts:189`) | ostaje; proširiti učitavanje |
| 10 | **Jedinica mere** | SVI | **DA** | `Item.unit` (`:800`), `Item.foreignUnit` (`:802`) — učitava se pa se odbacuje (`invoice-pdf.service.ts:189, 193-197`). Slobodna uslužna stavka (`itemId=null`) **nema j.m. nigde** | `Item.unit` + **`InvoiceItem.unit String?`** za slobodne stavke |
| 11 | **PDV stopa po stavci** (`20%`) | IFR, IFGP, IFUSL | **DA** | `InvoiceItem.vatRateCode` (`:3940`) → `TaxRate.baseRate` (`:129`); štampa ih ne razrešava | ostaje; dodati učitavanje `tax_rates` u print |
| 12 | **Stat. goods No.** (carinska tarifa) | ino roba | **DA** | `Item.customsTariff` (`:828`, VarChar 20) — ne učitava se | ostaje; proširiti učitavanje |
| 13 | **Broj izvozne deklaracije / JCI** (`25-0401-000005`) | ino roba | NE (namenski) | `Invoice.note` (`:3901`) — komentar u šemi baš kaže „npr. JCI referenca kod izvoza", tj. danas bi se lepilo u slobodan tekst | **`Invoice.customsDeclarationNo String?`** VarChar(30) |
| 14 | **Poziv na ponudu** (`na osnovu ponude 0206-25`) | ino roba | delimično | `Invoice.copiedFromDocId` (`:3868`) i `linkedInvoiceDocId` (`:3867`) čuvaju vezu na PROF/PON → broj se može pročitati; kad račun nije nastao prepisom, veze nema | ostaje veza; opciono **`Invoice.offerReference String?`** za ručno kucan poziv |
| 15 | **Paritet / Incoterms** (`FCA Dobanovci-Beograd`) | ino usluga | NE | ne postoji (razlikuje se od domaćeg `FCO`) | **`Invoice.deliveryTerm String?`** VarChar(60) |
| 16 | **Količina koleta** (`1 paleta`) | ino usluga | NE | — | **`Invoice.packageDescription String?`** VarChar(60) |
| 17 | **Dimenzije pošiljke** (`400 x 800 x 2400 mm`) | ino usluga | NE | `Drawing.dimensions` (`:264`) je nevezan pojam (crtež, ne pošiljka) | **`Invoice.packageDimensions String?`** VarChar(60) |
| 18 | **Ukupna brutto kg** (`1.720,00`) | ino usluga | NE | `Item.weightKg` (`:853`) / `Item.weight` (`:835`) po artiklu; **brutto uključuje paletu → ne može se izračunati** | **`Invoice.grossWeightKg Decimal?`** (19,3) |
| 19 | **Ukupna netto kg** (`1.700,00`) | ino usluga | NE | isto kao gore; netto **bi se** moglo sabrati iz `Item.weightKg`, ali samo ako je popunjeno svuda (NEPOZNATO na produ) | **`Invoice.netWeightKg Decimal?`** (19,3) |
| 20 | **Mesto istovara** (naziv, ulica, pošta+mesto, država) | ino usluga | NE | legacy `GoodsDocument.deliveryPlaceId` (`:1121`) postoji, ali **tabele mesta isporuke nema u šemi** (nijedan model `DeliveryPlace`/`delivery_places`). Na 060/26 je jednako adresi kupca — ali to nije garancija | **`Invoice.unloadingPlace String?` @db.Text** (slobodan višered), ili puna tabela adresa isporuke ako ih ima više po kupcu (**odluka, §5**) |
| 21 | **Kontakt špeditera u uvozu** (firma + telefoni) | ino usluga | NE | — | **`Invoice.forwarderContact String?` @db.Text** |
| 22 | **IBAN** (`RS35160005010003501186`) | ino roba, ino usluga | **NE** | `IssuerInfo.iban` (`invoice-pdf.service.ts:37`) postoji u tipu ali se nikad ne puni → mrtva grana `:497-498`. `Company.bankAccount` (`:944`) je domaći tekući račun. `PaymentAccount` (`:1193-1206`) ima `accountNumber`/`bankName`/`countryCode`/`bankCode` — **ali ne IBAN** | **`PaymentAccount.iban String?`** (+ `isDefault` po valuti) ili `Company.iban` |
| 23 | **SWIFT/BIC** (`DBDBRSBG`) | ino roba, ino usluga | **NE** | isto kao 22 — `IssuerInfo.swift` (`:36`) mrtvo | **`PaymentAccount.swift String?`** |
| 24 | **Naziv + adresa banke** (`Banca Intesa a.d. EUR`, `Milentija Popovića 7b, 11070 New Belgrade`, `Republic of Serbia`) | ino roba, ino usluga | delimično | `PaymentAccount.bankName` (`:1197`) postoji; **adrese banke nema** | **`PaymentAccount.bankAddress String?`**, **`PaymentAccount.currency String?`** (u originalu piše „Banca Intesa a.d. **EUR**") |
| 25 | **TÜV/ISO znak, 6 partnerskih logotipa, QR „google mapa"** | SVI | NE (assets) | u repou je samo `SERVOTEH_LOGO_DATA_URL`. `Company.logo` (`:939`) i `Company.logoFooter` (`:1000`) su `Bytes?` kolone koje **postoje** — da li su na produ popunjene: **NEPOZNATO** | assets pored `documents/servoteh-logo.ts` (isti obrazac, data URL); QR generisati kroz `bwip-js` |
| 26 | **Registarski broj / šifra delatnosti / APR rečenica u podnožju** | SVI | **DA** | `Company.registryNumber` (`:952`), `businessActivityCode` (`:946`), `registrationNumber` (`:951`), `taxId` (`:980`), `aprText` (`:995`), `footerText` (`:999`) | ostaje; dopuniti `loadIssuer` select |
| 27 | **Član oslobođenja po vrsti prometa** | ino roba vs ino usluga | nije podatak | izvodi se iz `documentType`: `IZVRO`/`IZVGP` → čl. 24 st. 1 t. 2; `IZVUS` → čl. 24 st. 2 | konstante u štampi (ne u modelu) |

---

## 4. Predlog redosleda izvođenja

Svaki korak je zaokružen i proverljiv sam za sebe (PDF se skida sa
`GET /api/v1/sales/invoices/:id/pdf` i poredi sa odgovarajućim papirom).

**Korak 1 — Memorandum (zajednički okvir).** Zaglavlje strane (logo + TÜV/ISO + red firme + linija)
i podnožje (partnerska traka + registarski red + APR rečenica + QR) kao dve funkcije koje koriste
sva četiri šablona. Traži nabavku 7 asseta i QR metodu u `BarcodeService`. Dopuniti `loadIssuer`
(`invoice-pdf.service.ts:137-173`) poljima `invoiceIssuingPlace`, `registryNumber`,
`businessActivityCode`, `fax`, `webAddress`, `aprText`.
*Provera:* bilo koji račun — prva i poslednja traka strane se poklapaju sa svakim od pet papira.

**Korak 2 — Formatiranje (brojevi, datumi, broj dokumenta).** `formatDecimal` sa separatorom
hiljada, tri formata datuma, „kg" format sa obrnutim separatorima, prikaz broja računa `657/25`.
*Provera:* jedinični testovi nad pomoćnim funkcijama (`invoice-pdf.service.ts:655-690`) — bez
generisanja PDF-a; brojevi iz papira su gotovi test-vektori (`99,363.64`, `25-12-25`, `1.720,00`).

**Korak 3 — Model: polja dokumenta.** Jedna migracija: `warehouseId`, `fco`, `shipmentMethod`,
`paymentMethod`, `deliveryDate`, `customsDeclarationNo`, `deliveryTerm`, `packageDescription`,
`packageDimensions`, `grossWeightKg`, `netWeightKg`, `unloadingPlace`, `forwarderContact` na
`Invoice`; `unit` na `InvoiceItem`; `iban`/`swift`/`bankAddress`/`currency` na `PaymentAccount`.
Uz to: `createProforma` (`fakturisanje.service.ts:171-193`) počinje da upisuje `salespersonId` i
prepisuje `paymentMethod` sa kupca.
*Provera:* `prisma migrate` + `node dist/main` boot-smoke; postojeći testovi prolaze; nova polja
vidljiva na `GET /sales/invoices/:id`.

**Korak 4 — Domaći obrazac za robu (IFR/IFGP).** Pun šablon: tekući račun, okvir kupca, desni blok
naslova, traka uslova, tabela `R.br./PDV/Kat.br./NAZIV ROBE/j.m./Količina/CENA/R%/VREDNOST`,
petoredni zbir sa uokvirenim „Za uplatu", četiri napomene, četiri kolone potpisa sa magacinom.
*Provera:* IFR 657/25 i IFGP 650/25 jedan pored drugog sa originalima — jedina razlika među njima
mora biti naziv magacina.

**Korak 5 — Domaći obrazac za uslugu (IFUSL).** Zaseban šablon (naslov u dva reda, drugi desni blok,
bez trake uslova, kolona `O P I S`, pet uokvirenih zbirnih redova, Trgovinski sud, jedan potpis sa
brojem l.k.). Ovde se i uvodi izbor šablona po `documentType` umesto po `isExport`
(`invoice-pdf.service.ts:62-63`).
*Provera:* IFUSL 653/25 prema originalu + regresija: IFR i dalje izgleda kao u koraku 4.

**Korak 6 — Ino roba (IZVRO/IZVGP).** Engleski šablon: parovi labela/vrednost, kolone
`Catalog No./Description/Unit/Stat. goods No./Quantity/Price/Total ( EUR)`,
`TOTAL`/`DISCOUNT`/`TOTAL AMOUNT ( EUR)`, slobodni tekst (ponuda, JCI, način plaćanja), član 24
st. 1 t. 2, **živ** blok banke iz `PaymentAccount`, bez potpisnih linija.
*Provera:* Invoice 228/25 prema originalu; IBAN/SWIFT vidljivi (danas se ne štampaju uopšte).

**Korak 7 — Ino usluga (IZVUS), višestrana.** Prelazak zaglavlja u `header:` funkciju (ponavljanje
na svakoj strani), `Strana X od Y` desno dole, kolone bez `Catalog No.`/`Stat. goods No.`,
`Date of delivery` sa mestom, otpremni blok (paritet/kolete/dimenzije/težine/mesto
istovara/špediter), član 24 st. 2, blok banke na zasebnoj poslednjoj strani (`pageBreak`).
*Provera:* Invoice 060/26 — mora dati **tri** strane sa istim zaglavljem i zbirom na kraju stavki.

> Koraci 1–2 su bezbedni i ne menjaju sadržaj; korak 3 je jedina migracija; 4–7 su nezavisni jedan
> od drugog i mogu se raditi paralelno kad koraci 1–3 legnu.

---

## 5. Otvorena pitanja za vlasnika

Samo ona koja se **ne mogu** rešiti iz papira:

1. **Broj računa.** Obrazac štampa `657/25`, a 4.0 numeracija pravi `IFR0043/2026`
   (`numbering.service.ts:72`) i taj broj ide u SEF, GK i saldakonta. Da li 4.0 **menja numeraciju**
   na BigBit format, ili zadržava svoju i samo je u štampi skraćuje? (Skraćivanje u štampi znači da
   papir i SEF nose različit broj — to obično nije prihvatljivo.)
2. **Odgovorno lice.** Da li je to (a) komercijalista sa računa (`Salesperson`), (b) jedno ime za
   celu firmu, ili (c) korisnik koji je izdao račun? Na papirima su dva različita imena
   (Dragana Korkut na robi, Ana Golubović na usluzi) — što sugeriše (a), ali nije dokaz.
3. **Broj lične karte u bazi.** IFUSL štampa `Br. l.k.:008165163`. Da li se broj lične karte sme
   čuvati u bazi i štampati na dokumentu koji ide kupcu (zaštita podataka o ličnosti)?
   Na IFR/IFGP je to prazna linija — da li je namerno prazno ili je BigBit samo nije popunio?
4. **FCO / način otpreme / način plaćanja.** Odakle vrednosti: podrazumevano sa kupca, iz šifarnika
   sa padajućom listom, ili se kucaju po dokumentu? I da li se traka uslova štampa i kad su polja
   prazna (prazan okvir) ili se izostavlja?
5. **Mesto istovara.** Na 060/26 je identično adresi kupca. Da li je to pravilo (pa se izvodi
   automatski), ili kupac ima više adresa isporuke pa treba zaseban šifarnik?
6. **Brutto/netto kilaža i dimenzije.** Ručni unos po fakturi, ili obračun iz `Item.weightKg`?
   Ako je obračun — odakle težina palete/ambalaže (brutto − netto = 20 kg na 060/26)?
7. **Špediter.** Slobodan tekst po fakturi, ili šifarnik špeditera (isti se ponavljaju)?
8. **Ino faktura i valuta.** Blok banke na papirima je uvek EUR (`Banca Intesa a.d. EUR`).
   Šta se štampa za USD ili drugu valutu — drugi račun? Postoji li više deviznih računa?
9. **`web::` sa dve dvotačke** u redu firme — prepisati doslovno (kako sad stoji u
   [STAMPA_IZLAZNIH_FAKTURA.md](STAMPA_IZLAZNIH_FAKTURA.md) §1) ili tiho ispraviti na `web:`?
10. **„Trgovinski sud u Beogradu"** je zastareo naziv (danas Privredni sud). Ostaje doslovno
    prepisano sa obrasca, ili se ispravlja? Ako se ispravlja — i na usluzi i na robi isti naziv?
11. **Otpremnica bez cena** (`withoutPrices`, `invoice-pdf.service.ts:117-121`) nije među pet
    donetih obrazaca. Postoji li BigBit obrazac i za nju, ili se štampa neka od pet varijanti bez
    cena?
12. **Prelom domaćeg računa.** Nijedan od tri domaća primera nema drugu stranu. Kako izgleda IFR sa
    40 stavki — ponavlja li se zaglavlje kao na ino usluzi, gde ide blok potpisa? **NEPOZNATO** iz
    donetog materijala.
13. **Partnerska traka u podnožju** (AVENTICS · Rexroth · ABB · SKF · CASAPPA · MP FILTRI) — ko daje
    fajlove logotipa i da li je spisak partnera i dalje tačan? Isto za TÜV/ISO znak i ciljni URL QR
    koda („google mapa").

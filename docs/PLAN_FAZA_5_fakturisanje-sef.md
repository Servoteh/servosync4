# FAZA 5 — Fakturisanje (izlazni računi) + SEF (implementacioni dizajn, build-ready)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Verifikovano nad kodom.
> Preduslov: Faza 0 (carry-over), Faza 2 (posting), Faza 3 (GoodsDocument app + costing). **Ništa nije primenjeno.**
> *(SEF komponenta — agent pao na schema-retry; dizajn preuzet iz [doc 07 §8/§9](../backend/docs/migration/07-bigbit-sef-efaktura.md), koji je pun spec.)*

## A — Izlazni računi (`src/modules/sales/fakturisanje/`)

### Stanje
`GoodsDocument`/`GoodsDocumentItem` nose ceo oblik: `level`, `linkedInvoiceDocId` (=IDDokIF), `reserveStock`, `dueDate`,
`isSigned`, `currency`, `exchangeRate`/`accountingExchangeRate`, `fxInvoiceValue`; na stavci `discountPercent`,
`cashDiscountPercent`, **`copiedFromItemId`** (=IDPrepisaneStavke), `postedFromProformaToInvoice`, `actualWholesalePrice`.
Numeracija danas `WorkParameter` per-username (rupičav = „crvena sveska"). `DocumentType` ima prefix/numberingStart/
postingTemplate/postInVatLedger. **Pun GoodsDocument se ne piše nigde** (postaje app-owned tek posle Faze 3).
`src/modules/reversi/` je HOMONIM (magacin alata) — ne dirati.

### Dizajn — nad GoodsDocument, razlikovano `documentType`+`level`
- **Vrste:** PON/PROF (draft, level 250), IFR/IFGP/IFUSL (domaći, level 0), **IZVRO/IZVGP/IZVUS** (izvoz, level 0),
  AVR, **REV** (revers); sve `isInbound=false`. Predračun=PROF 250 (standardizovati 255→250); račun = NOV level-0
  dokument kroz **DocumentCarryOverService** (par PROF→IFR/…, `pricePolicy=keep`, `qtyPolicy=full`, `dedupKey=copiedFromItemId`),
  upis `linkedInvoiceDocId` (**anti-duplo guard:** `>0` blokira ponovni prepis).
- **Numeracija:** NOVA app tabela **`DocumentNumberSequence`** (documentType, year, companyId, lastNumber, `@@unique`),
  increment `SELECT…FOR UPDATE`/upsert u transakciji knjiženja — **zamenjuje WorkParameter i crvenu svesku**; broj se
  rezerviše tek pri knjiženju (level 0); format = prefix + seq + `/` + year.
- **PricingService** (deljen predračun/račun): baza `PriceListEntry` po `Company.wholesalePriceListCode` (fallback
  `Item.wholesalePrice`) → rabat iz nove **`CustomerDiscount`** (customerId, itemGroupCode; fallback `Customer.customerDiscount`),
  kap `Item.maxDiscountPercent` uz upozorenje → kasa → `actualWholesalePrice`. RuC=0 za IFR.
- **IZVOZ (`ExportInvoicePolicy`):** konto kupca **2050** (ne 2040), `goodsTaxCalculated=false` (samo osnovica O, PDV
  kategorija **Z / osnov čl.24**), `currency='EUR'` + kursevi, FX u fxInvoiceValue; **kursne razlike (5630/6630)** računa
  PostingService pri naplati; ino faktura (engleski) + INO instrukcije (SWIFT/IBAN iz PaymentAccount); NIJE na domaćem
  SEF-u; JCI referenca (novo polje/memo).
- **Reversi REV:** par PROF→REV u istom carry-over toku, print „Revers", zaseban REV niz; **u sales modulu** (ne u
  homonimnom `reversi/`).
- **Okidači pri knjiženju** (level 0, ista transakcija): Faza-2 PostingService (auto-robno IFR/IFGP/IZVRO/IZVGP po šemi
  33/36/24/47; ručno IFUSL/IZVUS 2040|2050/4703/6140) + Faza-3 CostingService (izlaz=prosek); rollback numeracije ako padne.

## B — SEF integracija (iz doc 07 §8 — pun spec)
- **`SefApiClient`** (REST `fetch`, header `ApiKey` iz configa, **THROTTLE 3 req/s** — p-limit/queue, MFIN limit; base
  URL demo/prod iz env; `ResponseStatus=-1`=nema komunikacije).
- **`SefOutbox`:** UBL 2.1 builder iz GoodsDocument (49 cbc/cac elem., PDV kategorije **S20/Z**, osnov **24-1-5** za BMTS,
  avans `BillingReference`→„za plaćanje=0", rabat `AllowanceCharge`, PDF prilog base64) → `POST /sales-invoice/ubl?requestId=`
  (idempotencija) → status polling `/changes` → **storno/cancel sa guard** (`MozeDaSeStornira/Otkaze`).
- **`SefInbox`:** polling `/purchase-invoice/changes|ids` → `/xml` → parse → **accept/reject (rok 15 dana)**;
  JSON `{invoiceId, accepted, Comments}`.
- **Modeli:** `sef_outbox`/`sef_inbox`/`sef_status_log` (`/// Was: T_ER_DokumentaNabavke`), watermark `LastModifiedUtc`.
- **Pojedinačna evidencija PDV** za kupce van SEF-a (doc 12 §10d).
- **RBAC (doc 07 §9.1):** preuzimanje/pregled = admin nabavke+prodaje+šefovi; **odobravanje = nabavka**; slanje/storno = prodaja.

## C — Štampa varijante + auto-mail + prevod za carinu
- **PDF šabloni** (pdfmake nad GoodsDocument): faktura sa/bez cena, **2× otpremnica bez cena**, **zapisnik umesto
  otpremnice kod IFUSL**, ino faktura (engleski), KNG. **Specijal per-firma fallback** (Servoteh=DEFAULT).
- **PrintAs** dropdown (Faza 0) — izbor varijante.
- **Pošalji na mail** (Resend attachment, Faza 0; audit ko/kome/kad) — zamenjuje BigBit OSSMTP.
- **Prevod za carinu** = eksplicitna varijanta (i18n + `CarinskeTarife` + landscape) nad narudžbenicom/uvozom.

## Redosled + Quick win
1. `DocumentNumberSequence` + `CustomerDiscount` migracije. 2. PricingService. 3. Modul + carry-over parovi. 4.
ExportInvoicePolicy. 5. Okidači posting+costing. 6. Štampa/mail. 7. **SEF (demo prvo!)**. **Quick win:** PROF→IFR
carry-over → knjiženje 2040/6040 → PDF faktura na mail (bez SEF-a) end-to-end.

## Odluke
- ✅ Račun nad GoodsDocument (tip+level), ne nov silos; REV u sales (ne homonimni reversi) — mi-tehnicki.
- ✅ DocumentNumberSequence (jedna DB sekvenca) zamenjuje crvenu svesku — mi-tehnicki (potvrditi Nesa).
- ✅ **SEF demo pre prod** (env prekidač) — mi-tehnicki.
- ⏳ **GoodsDocument app-owned** (§11.1, ista kao Faza 3) — Negovan/Nesa (bez toga modul nema gde da piše).
- ⏳ **IFUSL iz servisnih RN** (N5) — Negovan/Nesa (preporuka: vezati na workOrderId, GL ručni template sa pred-popunjenim kontima).
- ⏳ **CustomerDiscount matrica** (rabat po grupi) — Negovan (preporuka: graditi + fallback flat).

## Rizici
- **Numeracija pod konkurencijom** → `SELECT…FOR UPDATE`, rezervacija tek pri knjiženju, bez rupa.
- **SEF prod bez demo testa** → obavezan demo prolaz + knjigovođa validira (Faza 6 gejt).
- **Izvoz slučajno na domaći SEF** → ExportInvoicePolicy isključuje izvoz iz SEF export puta.

**Procena Faze 5:** ~15–22 AI-dana.

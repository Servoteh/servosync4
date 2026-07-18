# Module Spec: SEF eFaktura (ServoSync 4.0)

| | |
|---|---|
| **Modul** | SEF eFaktura (Sistem E-Faktura, MFIN) — izlazne + ulazne fakture |
| **Verzija spec** | 1.0 (2026-07-08) |
| **Faza** | 4.0 (apsorpcija BigBit komercijale) — **trigger-based, ne rok** ([ROADMAP §4.0](../ROADMAP.md)) |
| **Izvor** | Reverse-engineering izvučenog VBA (`OnLine_BigBit_VBA`): `Module__SEF_API_Common`, `Module__ER_API_Common`, `Class__ER_API_Class`, `Class__SEF_Class`, `Class__ER_Class` |
| **Status** | Specifikacija spremna (kod-verifikovana); implementacija tek u 4.0 |

> Ovo je **kod-verifikovan** spec — svaki endpoint, header, throttle i JSON body je izvučen iz stvarnog
> BigBit VBA koji je godinama u produkciji sa MFIN SEF-om. Dopunjuje [migration/07](../migration/07-bigbit-sef-efaktura.md)
> (§8 = sažetak) punim implementacionim detaljima za NestJS. Ne implementira se pre 4.0; služi da znanje
> ne ispari (izvor je pod Access ULS-om, izvučen jednokratno).

## 1. Cilj

ServoSync postaje **direktni SEF učesnik** umesto BigBit-a: šalje izlazne fakture kao UBL 2.1, prima i
odgovara na ulazne fakture, prati statuse. Zamenjuje `OnLine_BigBit_APL.MDB` SEF sloj. **Nema vendor
magije** — koristi se standardni javni MFIN API (`/api/publicApi/*`).

**Okruženja:** demo `https://demoefaktura.mfin.gov.rs` · prod `https://faktura.mfin.gov.rs` (oba potvrđena u kodu).

## 2. Arhitektura (NestJS)

```
SefModule
├── SefApiClient        (HTTP: ApiKey, throttle 3 req/s, retry)  ← Class__ER_API_Class
├── SefOutboxService    (izlazne: UBL build → send → status → storno/cancel)  ← ER_API_Common
├── SefInboxService     (ulazne: poll → xml → parse → accept/reject)  ← SEF_API_Common
├── UblBuilder          (ServoSync faktura → UBL 2.1 XML)
├── UblParser           (UBL XML → domenski objekat)  + XML→PDF render
├── SefController       (/api/v1/sef/*)
└── entities: SefOutbox, SefInbox, SefStatusLog
```

## 3. HTTP klijent — pravila iz koda (`Class__ER_API_Class`)

- **Transport:** `MSXML2.XMLHTTP` (sinhroni) u legacy-ju → u NestJS `axios`/`fetch` (async + queue).
- **Autentifikacija:** header **`ApiKey: <ključ>`** (metod `ER_Autenticate`). Ključ + base URL iz configa
  (`ReadCFGParametar("ER_API_URL")`, `RFReadParameter("ER_ApiKey")`) → u ServoSync **`.env`/secret**, ne u kod.
- **Zaglavlja:** `accept: text/plain`; `Content-Type: application/xml` (UBL) ili `application/json` (accept/reject/storno/cancel).
- **🔴 RATE LIMIT (obavezno):** MFIN dozvoljava **max 3 komande/sekundi**. Legacy broji (`ER_BrojKomandePoRedu Mod 3`)
  i čeka do 1s. NestJS: **globalni token-bucket / p-limit queue na 3 req/s** za ceo SEF modul (deljeno inbox+outbox).
- **Rezultat:** `ReadyState=4` → `Status ∈ {200,304}` = OK; inače greška sa telom odgovora. `Status=-1` = nema
  komunikacije sa serverom. U 4.0: tipizirane greške + retry sa backoff-om na 5xx/timeout (ne na 4xx).

## 4. Izlazne fakture — `sales-invoice` (`ER_API_Common`)

| Akcija | HTTP | Query/Body | Napomena |
|---|---|---|---|
| **Slanje** | `POST /api/publicApi/sales-invoice/ubl` | body = UBL XML; `?requestId=<UBL_RequestID>` `&date=Auto` opc. `&sendToCir=` | `requestId` = idempotencija; `sendToCir` = slanje u Centralni registar faktura (javni sektor) |
| Status | `GET /api/publicApi/sales-invoice` | `?invoiceId=<SalesInvoiceId>` | pojedinačni status |
| Lista ID | `POST /api/publicApi/sales-invoice/ids` | — | svi ID-jevi |
| Promene | `POST /api/publicApi/sales-invoice/changes` | `?date=<d>` | polling promena statusa |
| Potpisana | `GET /api/publicApi/sales-invoice/signature` | `?invoiceId=` | preuzimanje potpisanog dokumenta |
| **Storno** | `POST /api/publicApi/sales-invoice/storno` | JSON | guard `ER_FakturaMozeDaSeStornira(status, id)` |
| **Otkazivanje** | `POST /api/publicApi/sales-invoice/cancel` | JSON | guard `ER_FakturaMozeDaSeOtkaze(status, id)` |

**Tok slanja:** ServoSync faktura → `UblBuilder` (UBL 2.1) → POST `/ubl` sa `requestId` → SEF vrati `SalesInvoiceId`
→ čuva se u `SefOutbox` → periodično `changes` ažurira status → storno/cancel po potrebi (uz guard po statusu).

## 5. Ulazne fakture — `purchase-invoice` (`SEF_API_Common`)

| Akcija | HTTP | Query/Body | Napomena |
|---|---|---|---|
| Promene na dan | `POST /api/publicApi/purchase-invoice/changes` | `?date=<d>` | dnevni polling |
| ID po statusu/periodu | `POST /api/publicApi/purchase-invoice/ids` | `?Status=<s>&dateFrom=<d>&dateTo=<d>` | statusi: `New`, `Seen`, `Approved`, `Rejected`… |
| Status | `GET /api/publicApi/purchase-invoice` | `?invoiceId=<id>` | |
| **UBL XML** | `GET /api/publicApi/purchase-invoice/xml` | `?invoiceId=<id>` | telo fakture |
| **Prihvati/odbij** | `POST /api/publicApi/purchase-invoice/acceptRejectPurchaseInvoice` | JSON | zakonski rok **15 dana** |

**JSON body prihvatanja/odbijanja (tačno iz koda `SEF_JSONRequestBodyZaPrihvatanjeOdbijanjeUlazneFakture`):**
```json
{ "invoiceId": <id>, "accepted": "<True|False>", "Comments": "<opciono>" }
```
**Tok:** poll `changes`/`ids` → za nove `GET /xml` → `UblParser` → upis u `SefInbox` (Status/TipDokumenta) →
korisnik pregleda i prihvata/odbija → POST `acceptReject`. PDF za prikaz: UBL XML → base64 → render (legacy
`SEF_UBLPreuzimanjeUlazneFakture` + `DecodeBase64` preko `MSXML2.DOMDocument bin.base64`; u NestJS server-side XML→PDF).

## 6. UBL 2.1 mapiranje (iz izvučenih elemenata — [07 §6.2](../migration/07-bigbit-sef-efaktura.md))

- **Zaglavlje:** `cbc:CustomizationID`, `cbc:InvoiceTypeCode`, `cbc:IssueDate`, `cbc:DueDate`,
  `cbc:DocumentCurrencyCode`, `cbc:EndpointID` (PIB/JBKJS ruta).
- **Strane:** `cac:AccountingSupplierParty`, `cac:AccountingCustomerParty`, `cac:Party`.
- **Stavke:** `cac:InvoiceLine`/`cac:CreditNoteLine`, `cbc:InvoicedQuantity`/`cbc:CreditedQuantity`,
  `cbc:LineExtensionAmount`, `cbc:BaseQuantity`.
- **Porezi:** `cac:TaxTotal` → `cac:TaxSubtotal` → `cac:TaxCategory` → `cac:TaxScheme` (🔴 PDV kategorije
  S/AE/O/E/Z + osnov oslobođenja — u BigBit-u polja `Kategorija_PO`/`Oznaka_PO` iz `IF_Class`).
- **Iznosi:** `cac:LegalMonetaryTotal` (`cbc:TaxExclusiveAmount`, `cbc:TaxInclusiveAmount`, `cbc:PayableAmount`).
- **Avansi:** `cac:BillingReference` → `cac:InvoiceDocumentReference` (referenca avansne fakture).
- **Rabati:** `cac:AllowanceCharge` (`cbc:ChargeIndicator`, `cbc:AllowanceChargeReason(Code)`).
- **Prilog (PDF u fakturi):** `cac:Attachment` → `cbc:EmbeddedDocumentBinaryObject` (base64).
- **Knjižno odobrenje/zaduženje:** `cbc:CreditNoteTypeCode`, `cac:CreditNoteLine` (CreditNote dokument).

## 7. Model podataka (app-owned, Prisma)

Iz legacy `T_ER_DokumentaNabavke` / `T_ER_StatusDokumenata` / `T_ER_UF`:

```
SefOutbox   (izlazne)  id, servosyncInvoiceId(FK sales), salesInvoiceId(SEF), requestId, status,
                        sentAt, lastStatusAt, ublXml, errorText
SefInbox    (ulazne)   id, purchaseInvoiceId(SEF), supplierPib, supplierName, invoiceId, status,
                        statusDesc, lastModifiedUtc, ublXml, pdfPath, decisionAt, decision, comment
SefStatusLog           id, kind(in/out), sefId, status, at, raw
```
- **Model statusa** (SEF + srpski, iz koda): `Draft/Nacrt` · `New` · `Sent/Poslata` · `Seen` · `Approved/Odobrena`
  · `Rejected/Odbijena` · `Cancelled` · `Storno/Stornirana` · `Mistake`. → String polje sa `///` dozvoljenim vrednostima.
- **Watermark za polling:** `lastModifiedUtc` (per SefInbox) — inkrementalni `changes` poll.

## 8. Poslovna pravila koja moraju preživeti (🔴 regulatorno)

1. **PDV kategorije po SEF-u** (S/AE/O/E/Z + osnov oslobođenja) — FK na šifarnik, ne slobodan tekst.
2. **Rate limit 3 req/s** — deljeni queue; prekoračenje = MFIN odbija.
3. **`requestId` idempotencija** slanja — ista faktura se ne šalje dvaput (SEF vraća isti ID).
4. **Guard za storno/cancel po statusu** — ne može se stornirati faktura u proizvoljnom stanju.
5. **Rok 15 dana** za odgovor na ulaznu fakturu — alert/podsetnik pre isteka.
6. **Datum prometa ≠ datum dokumenta** (PDV period) — kod usluga posebno (`USLF_Class`).
7. **Avansne reference** (`BillingReference`) — konačna faktura mora referencirati avanse.

## 9. Testiranje

- **Demo okruženje** (`demoefaktura.mfin.gov.rs`) je u legacy configu — testira se bez rizika po produkciju.
- Unit: `UblBuilder`/`UblParser` protiv zlatnih UBL primera (validacija po MFIN XSD).
- Integration: mock SEF server + e2e protiv demo API-ja; test throttle-a (3 req/s), idempotencije, retry-a.
- Statusni model: prelazi Draft→Sent→Approved/Rejected/Cancelled/Storno.

## 10. Otvorena pitanja (za 4.0, potvrda kad faza krene)

1. **Config lokacija ApiKey + izbor demo/prod** — u BigBit-u je u `BB_CFG_Lokal.mdb`/config tabeli; u
   ServoSync-u `.env` + admin toggle; potvrditi ko rotira ključ.
2. **XML→PDF render** — biblioteka (MFIN pruža vizualizaciju? ili sopstveni XSLT→PDF).
3. **Fiskalizacija (LPFR/ESIR)** — zaseban regulatorni tok od SEF-a; potvrditi da li se uopšte koristi
   (na glavnoj masci BigBit-a nema kase — [10](../migration/10-bigbit-glavni-meni.md)).
4. **CIR (Centralni registar faktura)** — `sendToCir` samo za javni sektor; utvrditi da li Servoteh fakturiše JS.
5. **Retry/error politika** — legacy samo prikaže grešku; 4.0 treba robustan retry + dead-letter za outbox.
6. **Interna error/retry logika** ostaje delom u zaključanom VBA (samo Negovan ima design pristup) — rekonstruisati
   iz javne SEF dokumentacije.

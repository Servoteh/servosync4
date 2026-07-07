# SEF eFaktura integracija u BigBit-u — reverse engineering

> Izvor: string-analiza binarnih `.MDB` fajlova (`BigbitRaznoNenad/`, van gita) + izvučeni upiti, 2026-07-07.
> VBA izvorni kod OnLine aplikacije **još nije izvučen** — ovo je rekonstrukcija iz API putanja, imena
> objekata i poznatog javnog SEF API-ja. Za pun UBL field-mapping treba ekstrakcija VBA (vidi §6).
> Svrha: podloga za budući ServoSync SEF modul (4.0) i za procenu tog posla.

## 1. Gde integracija živi

| Fajl | Uloga |
|---|---|
| `OnLine_BigBit_APL.MDB` (104MB) | **SEF komunikacija** — svi API pozivi, UBL, ApiKey; jedina komponenta koja priča sa državom |
| `BigBit_APL_2010.MDB` (123MB) | Fakturisanje core (eFakture upiti/izveštaji, veza avansi) — bez HTTP poziva |
| `MojaBIgBitBaza.accdb` / `BB_T_25.MDB` | Podaci (fakture, `T_ER_UF` ulazne, robna dokumenta) |
| QBigTehn (QMegaTeh) | **Nema SEF koda** — proizvodnja ne dira eFakture |

## 2. API — šta je nađeno u binarnom

- **Okruženje:** `https://demoefaktura.mfin.gov.rs` (hardkodovan demo URL; produkcijski
  `efaktura.mfin.gov.rs` verovatno u config tabeli — potvrditi kod Vase).
- **Autentifikacija:** `ApiKey` header (standardni SEF javni API mehanizam).
- **Endpointi (12+, poklapaju se 1:1 sa zvaničnim SEF javnim API-jem):**

### Izlazne fakture (`sales-invoice`)
| Endpoint | Namena |
|---|---|
| `POST /api/publicApi/sales-invoice/ubl` | slanje fakture kao UBL 2.1 XML |
| `/sales-invoice/ids` · `/changes` | praćenje ID-jeva / promena statusa (polling) |
| `/sales-invoice/cancel` · `/storno` | otkazivanje / storniranje |
| `/sales-invoice/signature` | preuzimanje potpisanog dokumenta |

### Ulazne fakture (`purchase-invoice`) — „povlačenje faktura"
| Endpoint | Namena |
|---|---|
| `/purchase-invoice/ids` | lista ID-jeva ulaznih faktura |
| `/purchase-invoice/changes` | delta od poslednjeg poll-a |
| `/purchase-invoice/xml` | preuzimanje UBL XML-a konkretne fakture |
| `/purchase-invoice/acceptRejectPurchaseInvoice` | odobravanje / odbijanje |

### Pomoćni
| Endpoint | Namena |
|---|---|
| `/api/publicApi/Company/CheckIfCompanyRegisteredOnEfaktura` | provera da li je komitent na SEF-u |
| `/api/publicApi/get-unit-measures` | šifarnik jedinica mere |

*(Usput nađeno i `http://api.bex.rs` — BEX kurirska integracija, zasebna tema.)*

## 3. Interni artefakti (imena objekata iz binarnog + upita)

- **`T_ER_UF`** — tabela ulaznih faktura (Elektronski Registar — Ulazne Fakture); kolone bar
  `Status`, `TipDokumenta` (pregledi po statusu SEF-a postoje kao upiti).
- `eFaktureNabavke`, `eFaktureIzXML`, `InvoiceIDUlaznihFak` — ulazni tok (preuzet XML → parsiranje → lokalna evidencija).
- `EfakturaUXML`, `eFaktureUSEF`, `eFaktureUDok` — izlazni tok (faktura → UBL; evidencija šta je u SEF-u).
- `eFakturaVezaAvansi` — povezivanje avansnih faktura (SEF zahteva reference avansa u konačnoj).
- `EFakturaRegisteredCompany` — keš provere registrovanosti komitenata.
- `EFakturaZaStampu`, `eFakturaSaOpisomStavke`, `eFaktureSaKoef*`, `eFaktureUsluga*` — štampa/prikaz varijante.
- Base64 konverzija slika (VBScript tehnika) — verovatno logo/prilog u UBL.

## 4. Rekonstruisani tokovi

### Izlazna faktura
1. Faktura nastaje u BigBit-u (robna dokumenta / fakturisanje).
2. OnLine app je pretvara u **UBL 2.1 XML** (`EfakturaUXML`; PDV kategorije, veza avansa iz `eFakturaVezaAvansi`).
3. `POST /sales-invoice/ubl` (ApiKey header) → SEF vraća `InvoiceID` → čuva se lokalno (`eFaktureUSEF`).
4. Periodično `GET /sales-invoice/changes|ids` → ažuriranje statusa (Poslata/Odobrena/Odbijena/Stornirana).
5. Storno/otkazivanje po potrebi kroz `/storno` i `/cancel`.

### Ulazna faktura (povlačenje)
1. Polling: `GET /purchase-invoice/ids` + `/changes` (ručno dugme ili periodično — potvrditi kod Vase).
2. Za nove ID-jeve: `GET /purchase-invoice/xml` → UBL XML.
3. Parsiranje u lokalne tabele (`eFaktureIzXML` → `T_ER_UF` sa Status/TipDokumenta).
4. Korisnik pregleda i odobrava/odbija → `POST /purchase-invoice/acceptRejectPurchaseInvoice`
   (zakonski rok za odgovor: 15 dana).

### Pomoćni tok
- Pre slanja: `CheckIfCompanyRegisteredOnEfaktura` za komitenta (ako nije na SEF-u → faktura ide drugim kanalom).

## 5. Šta ovo znači za ServoSync 4.0 (SEF modul)

- **Nema vendor magije** — BigBit koristi standardni javni SEF API (12-ak endpointa). ServoSync ekvivalent
  je jedan NestJS servis: REST klijent + UBL 2.1 builder/parser + polling cron + tabele
  (`sef_outbox`, `sef_inbox`, statusi) — dobro omeđen posao (procena iz ROADMAP-a: unutar dev B traka
  „Fakturisanje + SEF", 2–3 meseca uklj. demo okruženje).
- **Najteži deo nije HTTP nego UBL mapiranje**: PDV kategorije (S/AE/O/E/Z…), avansi, knjižna
  odobrenja/zaduženja — tačno ono što je u VBA koji još nismo izvukli.
- Demo okruženje (`demoefaktura...`) postoji u kodu — put za testiranje bez rizika je već utaban.

## 6. Dopuna — dubinska ekstrakcija (2026-07-07)

### 6.1 Pokušaj ekstrakcije VBA izvora — status
Pokušana ekstrakcija koda iz `OnLine_BigBit_APL.MDB` (rad na kopiji, Access 16 COM). Redosled:
OLEDB → DAO auth → `SaveAsText` → VBIDE. **Rezultat: kompajlirani VBA je zaključan Access
user-level (workgroup) zaštitom.** Baza se otvara samo ugrađenim `Admin` nalogom koji **nema „design"
prava** → VBA projekat se ne učitava (`VBProjects.Count = 0`). Privilegovani nalozi (Slavisa/Sada/nadmin
iz `BIGBIT_accounts.csv`) **ne postoje u `BIGBIT.MDW`** — taj CSV je dump drugog/spojenog workgroup-a.
- **Da se dobije pun VBA izvor:** tražiti od Vase (a) ispravan `.MDW` sa admin nalogom, ili (b) sam izvorni
  kod / nezaštićenu kopiju. Inventar je poznat: **115 modula, 563 forme, 496 izveštaja, 68 makroa**
  (makroi uklj. `StartBigBit`, `StartKasa`, `StartNabavka`, `StartProizvodnja`, `StartPS` — ulazne tačke po modulima).

### 6.2 Šta JESTE izvučeno (string-mining binarnog — dovoljno za SEF modul)
Iako je kod zaključan, iz binarnog su izvučeni **UBL 2.1 field-mapping, URL-ovi i model statusa** — suština:

- **Produkcijski URL potvrđen:** `https://faktura.mfin.gov.rs` (+ demo `https://demoefaktura.mfin.gov.rs`).
- **UBL 2.1 elementi (49 nađenih) — i izlazne fakture i knjižna odobrenja:**
  - Zaglavlje: `cbc:CustomizationID`, `cbc:InvoiceTypeCode`, `cbc:IssueDate`, `cbc:DueDate`,
    `cbc:DocumentCurrencyCode`, `cbc:EndpointID` (PIB/JBKJS ruta).
  - Strane: `cac:AccountingSupplierParty`, `cac:AccountingCustomerParty`, `cac:Party`.
  - Stavke: `cac:InvoiceLine` / `cac:CreditNoteLine`, `cbc:InvoicedQuantity`/`cbc:CreditedQuantity`,
    `cbc:LineExtensionAmount`, `cbc:BaseQuantity`.
  - Porezi: `cac:TaxTotal` → `cac:TaxSubtotal` → `cac:TaxCategory` → `cac:TaxScheme` (PDV kategorije).
  - Iznosi: `cac:LegalMonetaryTotal` (`cbc:TaxExclusiveAmount`, `cbc:TaxInclusiveAmount`, `cbc:PayableAmount`).
  - **Avansi/veze:** `cac:BillingReference` → `cac:InvoiceDocumentReference` (referenca avansne fakture).
  - **Rabati:** `cac:AllowanceCharge` (`cbc:ChargeIndicator`, `cbc:AllowanceChargeReason(Code)`).
  - **Prilog (PDF u fakturi):** `cac:Attachment` → `cbc:EmbeddedDocumentBinaryObject` (base64 — otud Base64 VBA rutine).
  - **Knjižno odobrenje/zaduženje:** `cbc:CreditNoteTypeCode`, `cac:CreditNoteLine` (CreditNote dokument).
- **Model statusa dokumenta** (SEF + srpski ekvivalenti u UI): `Draft/Nacrt` · `New` · `Sent/Poslata` ·
  `Seen` · `Approved/Odobrena` · `Rejected/Odbijena` · `Cancelled` · `Storno/Stornirana` · `Mistake`.
- **BEX kurirska integracija** (`http://api.bex.rs:62502`) — zaseban modul (otprema robe), van SEF-a.

### 6.3 Šta ostaje (manje kritično, za implementaciju)
1. **Tačna logika grešaka/retry i kadenca polling-a** — ostaje u zaključanom VBA; rekonstruisati iz
   zvanične SEF dokumentacije (javno) + testirati na demo okruženju.
2. **Config lokacija `ApiKey` + izbor prod/demo** (verovatno tabela u `BB_CFG_Lokal.mdb` ili `T_*` config) — pitati Vasu.
3. **Struktura `T_ER_UF`** i povezanih (DAO čitanje šeme je bezbedno i moguće — nije blokirano ULS-om za tabele).
4. Operativni tok (ko klikće „preuzmi ulazne", ko odobrava) — pitati fakturistu.

> **Zaključak:** za pisanje ServoSync SEF modula (4.0) imamo **dovoljno** — endpointe (§2), UBL mapiranje
> (§6.2), model statusa i tokove (§4). Nedostaje samo interna error/retry logika, koja se ionako radi po
> javnoj SEF specifikaciji. Pun VBA izvor je „nice to have", ne blokada.

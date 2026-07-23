# Fakturisanje (izlazni računi) — konsolidacija toka

> **Status:** SINTEZA (2026-07-18). Nije nova analiza — objedinjuje već razrađene delove u JEDAN tok
> „izlazni račun". Izvori: [26](26-profakture-tok-iz-koda.md) (profakture), [27](27-prepisivanje-dokumenata-carry-over.md)
> (carry-over), [07](07-bigbit-sef-efaktura.md) (SEF), [30](30-glavna-knjiga-modul-dubinski.md) (GL posting),
> [12](12-bigbit-uputstvo-master.md) §10–12 (operativni tokovi), [38](38-terminologija-pantheon-sap-predlog.md) (nazivi).

## 1. Vrste izlaznog računa — DOMAĆE + IZVOZ (verifikovano iz rule-tabela)

### 1a. Domaće (kupci u zemlji = konto 2040, sa PDV)
| Šifra | Šta | Šema | GL knjiženje |
|---|---|---|---|
| **IFR** | izlazna faktura **robe** | 33 | **auto**: 2040 dug=O+P+Q; 6040/4702/4710; rashod 5010/1320 |
| **IFGP** | izlazna faktura **gotovog proizvoda** | 36 | **auto** iz robnog |
| **IFUSL** | izlazna faktura **usluge** | — | **RUČNO**: 2040 dug / 4703 pot PDV / 6140 pot osnovica |
| **AVR** | avansni račun | 39 | ručno: 4300 dug / 4720 pot |

### 1b. IZVOZ (kupci u inostranstvu = konto 2050, BEZ PDV, devizno)
| Šifra | Šta | Šema | GL knjiženje |
|---|---|---|---|
| **IZVRO** | **izvozna faktura robe** | 24 (IZVOZ ROBE) | **auto**: **2050 dug=O** (samo osnovica, **bez PDV** — izvoz oslobođen, čl. 24 PDV) |
| **IZVGP** | **izvoz gotovih proizvoda** | 47 (IZVOZ GOT.PROIZVODA) | **auto**: 2050 dug=O |
| **IZVUS** | **izvoz usluga** | — | **RUČNO** (kao IFUSL, 2050 strana) |

**Izvoz — ključne razlike od domaćeg (moraju u 4.0):**
- **Konto 2050** (kupci u inostranstvu), NE 2040. Šira ino-struktura postoji: `203/2010/2030/2031/2039/2050`.
- **Bez PDV-a** — izvoz je oslobođen (šema samo `O`=osnovica, nema P/Q PDV linija). Na SEF: PDV kategorija
  za izvoz / osnov oslobođenja.
- **Devizno** (EUR) — devizna potraživanja + **kursne razlike** (5630/6630 pri naplati po drugom kursu).
- **Ino faktura** (engleski report — doc 20: `InoFaktura`, `InoPROFaktura`) + `INOInstrukcijeZaPlacanje`
  (SWIFT/IBAN, korespondentna banka — `INOUplatniRacuni`, doc 21).
- **JCI / carinska dokumentacija** za izvoz robe (izvozno carinjenje, dokaz izvoza za PDV oslobođenje).
- **SEF:** izvoz stranom kupcu NIJE na domaćem SEF-u (strani kupac nije obveznik); prekogranični promet
  usluga ima posebnu evidenciju.

Robna domaća+izvoz (IFR/IFGP/IZVRO/IZVGP) se knjiže „iz robnog po šemi" ([30](30-glavna-knjiga-modul-dubinski.md));
usluge (IFUSL/IZVUS) **ručnim nalogom** — česta greška u kucanju konta (doc 12 §18).

## 2. Životni ciklus (od predračuna do naplate)

```
Upit kupca → Predračun (profaktura, Level 250, doc 26)
   │ prihvat → Predmet (doc 31)
   ▼ carry-over (doc 27: KreirajRobniDok Level 0 + kopija stavki + link IDDokIF)
Izlazni račun (IFR/IFGP/IFUSL, Level 0, proknjižen)
   ├─ SEF export (doc 07: UBL → sales-invoice/ubl, status polling)
   ├─ GL knjiženje (auto robno / ručno usluge, doc 30)
   ├─ štampa (doc 20: Faktura sa/bez cena, 2× otpremnica bez cena; IFUSL → Zapisnik umesto otpremnice)
   ▼
Naplata (izvod → 2040 zatvara otvorenu stavku, doc 21/25)
```

**Cena/rabat:** isti engine kao profaktura (doc 26 §C, doc 23 §1.6) — cenovnik po komitentu → rabat
(cap MaxRabat) → kasa → StvarnaVP. **RuC=0 pravilo** (Mag.VP=Nab.cena) kod IFR (doc 35/39).

## 3. Specifičnosti iz uputstva (doc 12) — MORA se preneti

- **Numeracija iz „crvene sveske"** (fizička Knjiga izlaznih faktura) → 4.0 **pouzdane sekvence po vrsti+godini**.
- **FCO prag 5000 din** (magacin prodavca/kupca), **kurs 125 din / Robert Bosch 118**.
- **PO broj kupca u napomenu** — bez njega faktura **neće biti odobrena na SEF-u**.
- **SEF slučajevi** (doc 07 §9, doc 12 §10a–f): standard export; ručni unos na SEF; **Pojedinačna
  evidencija PDV** za kupce van SEF-a; **BMTS bez PDV → kategorija Z, osnov 24-1-5**; avans → konačni
  račun „za plaćanje = 0".
- **IFGP posebnost:** obriši postojeću SEF fakturu pa unesi konačni račun; veza sa avansom.
- **Standardni pravni tekstovi** (poresko oslobođenje, reklamacije 5 dana, nadležni sud, zatezna kamata).
- **Reversi** = `documentType='REV'` u istom toku (doc 33), pravljen iz profakture, print „Revers".

## 4. 2.0 stanje + procena

**2.0:** `GoodsDocument` model **već nosi oblik** (level, linkedInvoiceDocId, copiedFromItemId — doc 26 §G),
ali **nema app modula** (samo sync-cache); nema fakturisanja, SEF app tabela postoji delom (doc 07).

**Procena (deo 4.0 sales, ne dupla — koristi carry-over doc 27 + GL doc 30 + SEF doc 07):**

| Deo | AI-dani |
|---|---|
| Izlazni račun modul (IFR/IFGP/IFUSL **+ izvoz IZVRO/IZVGP/IZVUS**) — CRUD, numeracija, cena/rabat engine | 5–7 |
| Izvoz specifično: 2050, bez-PDV šema, devizno + kursne razlike, ino faktura (eng), JCI veza | 2–3 |
| Carry-over predračun→račun (reuse doc 27 servis) | 1–2 |
| GL knjiženje (auto robno / ručno usluge) — zavisi od GL (doc 30) | 2–3 |
| SEF integracija (reuse doc 07 spec) — kategorije S20/Z, avans→0, pojedinačna evidencija | 4–6 |
| Štampa varijante (faktura sa/bez cena, otpremnica, zapisnik) — reuse doc 20/28 | 2–3 |
| **Ukupno** | **~15–22 AI-dana** (uz GL/carry-over/SEF kao preduslove) |

**Veze:** predračun (26) → carry-over (27) → GL (30) → SEF (07) → naplata (25); robno-costing (39) daje
RuC=0/cene; terminologija (38). Fakturisanje je „spoj" svih tih delova — zato sinteza, ne nova analiza.

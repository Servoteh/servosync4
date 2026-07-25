# PLAN — Batch C: put do cutover-a 31.12.2026

> **Odluke korisnika 25.07.2026:** (1) Servoteh **izdaje i prima avansne račune** → AVR ulazi prvi;
> (2) **cutover do 31.12.2026** — tvrd rok, sve se podređuje zatvaranju godine; (3) 3-way match je
> **upozorenje, ne blokada**. Nastavak [PLAN_TALAS_2_3_batch_A.md](PLAN_TALAS_2_3_batch_A.md) /
> [batch_B](PLAN_TALAS_2_3_batch_B.md); isti protokol (fan-out → smoke → adversarial review → PR → deploy).

## 0. Kritični put do 31.12 (šta MORA biti gotovo i uvežbano)

| Rok | Stavka | Stanje |
|---|---|---|
| **odmah** | 🔴 **Prave ZR_AOP_Modla formule** (Slavišina `.mdb`) | **BLOKIRANO — van našeg domašaja.** Bilans za 2026 se predaje po podacima na 31.12; sada radimo na *rekonstrukciji* koja NIJE za predaju. Ovo je jedini rizik koji može da obori cutover, a rešava se samo telefonom Slaviši. |
| odmah | SEF prod ključ | E1 izgrađen, stoji u DRY-RUN-u |
| **Batch C** | Devizne otvorene stavke + **kursne razlike na 31.12** | Zakonska obaveza pri zatvaranju godine — bez toga bilans nije tačan |
| **Batch C** | Avansni računi (AVR) | Koriste se; bez njih BigBit ne može da se ugasi |
| do 30.11 | Popis uvežban na pravim podacima | Kod gotov (E2), treba proba |
| do 31.12 | Prenos godine testiran | Kod gotov (B2), treba proba na 2025→2026 |

## 1. Batch C — 4 celine kroz 5 agenata

| Agent | Stavka | Sadržaj |
|---|---|---|
| **C1a** | **AVR izlazni** (XL) | Avansni račun iz predračuna/porudžbine → naplata → **konačni račun odbija avans** (stavka „umanjenje za primljeni avans", `payable = ukupno − avans`); PDV po naplati avansa (obaveza nastaje naplatom, ne izdavanjem); UBL 386 + `cac:BillingReference` na avans (builder to VEĆ podržava — `isPrepayment`/`prepaymentReference`); GL: avans na 4300 (primljeni avansi) pa preknjižavanje na prihod pri konačnom računu |
| **C1b** | **AVR ulazni + FE** | Ulazni avansni račun dobavljača u KUF (pretporez po plaćanju), veza na konačni ulazni račun; FE: „Napravi avansni račun" iz predračuna, prikaz „odbijen avans" na konačnom, lista avansa po komitentu |
| **C2** | **Devizne otvorene stavke + kursne razlike** (L) | Popunjavanje `fxDebit/fxCredit/fxCurrency` pri knjiženju deviznih faktura/izvoda; otvorene stavke i kartica u **valuti + protivvrednosti**; **revalorizacija na dan** (31.12 ili bilo koji presek): preračun po kursu na dan → nalog kursnih razlika (563 negativne / 663 pozitivne), idempotentno po (period, valuta) |
| **C3** | **Rezervacija zaliha** (M) | Predračun rezerviše robu (`StockReservation`), lager prikazuje `raspoloživo = stanje − rezervisano`, izdatnica/storno oslobađa; guard negativnog stanja gleda raspoloživo |
| **C4** | **3-way match — upozorenje** (M) | Poređenje naručeno (PO) / primljeno (prijem) / fakturisano (ulazna faktura) po narudžbenici; odstupanje van tolerancije → **upozorenje** na pripremi plaćanja i na nalogu (NE blokira potpis/izvoz, po odluci) |

**Šema (glavna petlja, pre fan-out-a):** `Invoice.advanceInvoiceId` + `advanceAppliedAmount` (C1) ·
`StockReservation` tabela (C3). Sve aditivno. `fxDebit/fxCredit/fxCurrency` i `reserved` VEĆ postoje.

## 2. Definicije gotovog (smoke)

- **C1**: predračun 12.000 → AVR 12.000 → naplata → konačni račun 12.000 sa odbitkom avansa → **za plaćanje 0**; GL: 4300 se zatvara, prihod priznat jednom; ponovni AVR iz istog predračuna → 409
- **C2**: EUR faktura 1.000 po kursu 117 → otvorena stavka nosi 1.000 EUR / 117.000 RSD; revalorizacija na kurs 120 → nalog kursne razlike 3.000 na 663; ponovna revalorizacija istog perioda → 409 (ili nula-razlika)
- **C3**: predračun na 10 kom od 12 na stanju → raspoloživo 2; izdatnica oslobađa; pokušaj izlaza 5 kom → 422 (raspoloživo 2)
- **C4**: PO 100 kom, primljeno 100, fakturisano 120 → upozorenje „fakturisano više od primljenog" pri pripremi plaćanja; plaćanje i dalje prolazi

## 3. Van Batch C (potvrđeno „ne zasad")

Payment Run F110 · EBS fuzzy uparivanje · dimenzije knjiženja (SAP CO) · terminologija Pantheon/SAP ·
automatsko slanje opomena po rasporedu · POPDV legacy VBA formule.

## 4. Protokol

Nepromenjen. **Dodatno posle git incidenta 25.07:** pre svakog push-a `git branch --show-current`; rad ide na
zasebnu granu `feat/4.0-batch-c` nad `main` (radni direktorijum dele druge sesije).

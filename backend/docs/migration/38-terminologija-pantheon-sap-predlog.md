# Terminologija 4.0 — predlozi iz Pantheon/SAP (da ne miriše na BigBit)

> **Status:** PREDLOG (2026-07-18). Nenad: idemo na istu formu/UX kao 3.0, ali hoćemo **profesionalne
> nazive** da ne ispadne da kopiramo zastareli BigBit (Slaviša ad-hoc terminologija). Izvor:
> **Pantheon (Datalab)** = regionalni ERP (SLO/HR/SRB), srpski/hrvatski priručnik → **primarni izvor
> naziva** (knjigovođa-konsultant ih prepoznaje); **SAP** (FI/SD/MM) = globalni standard → za **kod**
> (engleski) i strukturu.

**Pravilo (BACKEND_RULES §9):** kod/tabele na engleskom, UI/dokumentacija na srpskom → koristi
**SAP-terminologiju za kod** (`ledger_entry`, `AccountsReceivable`), **Pantheon-terminologiju za UI**
(„Temeljnica", „Otvorene stavke").

## Zašto Pantheon kao primarni
Pantheon koristi baš srpsku knjigovodstvenu terminologiju (Otvorene stavke, Saldakonti, Temeljnica,
Predračun, Primka, Knjižno odobrenje) — to je jezik koji naš knjigovođa-konsultant (i APR/poreska)
očekuje, a nije BigBit-ov „nalog/IFR/UFROB" žargon. SAP daje čistu modul-strukturu (FI/SD/MM) i engleske
nazive za kod.

## Mapiranje po domenu: BigBit → Pantheon (UI) → SAP (kod) → **predlog 4.0**

### Glavna knjiga / finansije
| BigBit (Slaviša) | Pantheon (UI srpski) | SAP (kod eng) | **Predlog 4.0** |
|---|---|---|---|
| Nalog GK | **Temeljnica** | Journal Entry / Document | UI „Nalog za knjiženje"/„Temeljnica"; kod `journal_entry` |
| Stavka naloga | Stavka temeljnice | Line item | `ledger_entry` |
| Kontni plan | **Kontni plan** | Chart of Accounts (CoA) | „Kontni plan" / `chart_of_accounts` |
| Otvorene stavke | **Otvorene stavke** | Open Items | „Otvorene stavke" / `open_items` |
| — | **Saldakonti** | Subledger (AR/AP) | „Saldakonti" (kupci/dobavljači) |
| Kartica konta/analitike | Kartica konta / komitenta | Account/Customer line items | „Kartica konta" / „Kartica komitenta" |
| Bruto stanje | **Bruto bilanca** | Trial Balance | „Bruto bilans (probni)" / `trial_balance` |
| Dnevnik | Dnevnik knjiženja | Journal | „Dnevnik" |
| Šema za kontiranje | **Automatsko knjiženje / knjižne sheme** | Posting scheme / Automatic postings | „Šema knjiženja" / `posting_scheme` |
| Konto 2040 (kupci) | Kupci / potraživanja | **Accounts Receivable (AR)** | AR |
| Konto 4350 (dobavljači) | Dobavljači / obaveze | **Accounts Payable (AP)** | AP |

### Prodaja / fakturisanje
| BigBit | Pantheon | SAP | **Predlog 4.0** |
|---|---|---|---|
| PON / Profaktura | **Predračun** (ponuda/predračun) | Sales Quotation / Pro forma | „Predračun" (ne „profaktura") / `proforma` |
| IFR/IFGP/IFUSL | **Izlazni račun** (robe/proizvoda/usluge) | Customer Invoice / Billing | „Izlazni račun" / `sales_invoice` |
| AVR | **Avansni račun** | Down-payment invoice | „Avansni račun" |
| KNO/KNZ | **Knjižno odobrenje / knjižno terećenje** | Credit memo / Debit memo | „Knjižno odobrenje/zaduženje" |
| Otpremnica | **Otpremnica** | Delivery Note | „Otpremnica" |
| Revers | Revers / konsignacija | Consignment | „Revers (konsignacija)" |
| Zahtev za ponudu (kupac) | **Upit kupca** | Customer Inquiry | „Upit kupca" |

### Nabavka / robno (magacin)
| BigBit | Pantheon | SAP | **Predlog 4.0** |
|---|---|---|---|
| Upit dobavljaču | **Upit za ponudu** | RFQ (Request for Quotation) | „Upit dobavljaču" / `rfq` |
| Narudžbenica (NARUČIVANJE) | **Narudžba dobavljaču** | Purchase Order (PO) | „Narudžbenica" / `purchase_order` |
| Ulaz (UFROB/UFMAT) | **Primka** (ulazni dokument) | Goods Receipt (GR) | „Prijem/Primka" / `goods_receipt` |
| Izlaz iz magacina | **Izdavanje / Izdatnica** | Goods Issue | „Izdavanje" |
| Popis | **Inventura** | Physical Inventory | „Popis (inventura)" |
| Nivelacija | **Nivelacija / prevrednovanje** | Revaluation | „Nivelacija" |
| Lager lista | **Zalihe / lager lista** | Stock overview | „Stanje zaliha" |
| Magacin | **Skladište** | Warehouse/Plant | „Magacin/Skladište" |

### Banka / blagajna / plaćanja
| BigBit | Pantheon | SAP | **Predlog 4.0** |
|---|---|---|---|
| Izvod | **Bankovni izvod** | Bank Statement | „Izvod" / `bank_statement` |
| Virman | **Nalog za plaćanje / platni nalog** | Payment Order | „Nalog za plaćanje" / `payment_order` |
| Priprema plaćanja | **Priprema plaćanja / platni promet** | Payment Run (F110) | „Priprema plaćanja" |
| Blagajna (BLAG) | **Blagajna (gotovinski dnevnik)** | Cash Journal | „Blagajna" |

### PDV / porezi / završni račun
| BigBit | Pantheon | SAP | **Predlog 4.0** |
|---|---|---|---|
| PDV knjige / POPDV | **Obračun PDV-a / PDV evidencije** | Tax reporting | „PDV evidencije / POPDV" |
| Uvoz/carina | Uvoz / carina | Import / Customs | „Uvoz/Carina" |
| Osnovna sredstva | **Osnovna sredstva (registar OS)** | Asset Accounting (AA) | „Osnovna sredstva" / `fixed_assets` |
| Amortizacija | **Amortizacija** | Depreciation | „Amortizacija" |
| Završni račun / bilansi | **Godišnji obračun / finansijski izveštaji** (Bilans stanja/uspeha) | Financial Statements / Year-End Closing | „Završni račun" / „Godišnji izveštaji" (vidi doc 37) |

### Šifarnici / matični podaci
| BigBit | Pantheon | SAP | **Predlog 4.0** |
|---|---|---|---|
| Komitenti | **Subjekti / Komitenti / Partneri** | Business Partner (BP) | „Komitenti/Partneri" (2.0 već ima `customers`) |
| Artikli | **Identi / Artikli** | Material | „Artikli" (2.0 `items`) |
| Cenovnik | **Cenovnik** | Price List / Condition | „Cenovnik" |
| Vrste dokumenata | **Vrste dokumenata** | Document Type | „Vrste dokumenata" |
| Predmet | **Projekt** (Pantheon: Projekti) | Project / WBS | zadržati „Predmet" (2.0 `projects`, ustaljeno kod Servoteha) |

## Preporuka

1. **UI nazivi = Pantheon** (regionalni, knjigovođa ih prepoznaje): „Temeljnica", „Otvorene stavke",
   „Predračun", „Primka", „Knjižno odobrenje", „Bruto bilans", „Nalog za plaćanje". Beži od BigBit
   žargona („IFR/UFROB/nalog GK/profaktura").
2. **Kod = SAP-ish engleski** (po BACKEND_RULES): `chart_of_accounts`, `ledger_entry`, `open_items`,
   `sales_invoice`, `purchase_order`, `goods_receipt`, `payment_order`, `fixed_asset`.
3. **Zadržati ustaljene 3.0 nazive** koje Servoteh već koristi: „Predmet", „Radni nalog", „Primopredaje",
   „Kvalitet", „Održavanje", „Reversi" (magacin alata) — ne menjati, da se ne pravi zabuna.
4. **Interni šifre dokumenata** (IFR/UFROB/REZR…) mogu ostati kao interni `documentType` kodovi (kompatibilnost
   sa migriranim podacima), ali korisniku se prikazuje čitljiv naziv („Izlazni račun robe", „Ulazni račun").

> **Sažetak:** UX ostaje kao 3.0; nazivi se dižu na Pantheon/SAP standard — profesionalno, prepoznatljivo
> knjigovođi i APR-u, i vidljivo drugačije od zastarelog BigBit-a. Ovaj doc je rečnik za sve buduće
> 4.0 finansijske/komercijalne module.

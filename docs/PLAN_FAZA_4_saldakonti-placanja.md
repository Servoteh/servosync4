# FAZA 4 — Saldakonti + plaćanja (implementacioni dizajn, build-ready)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Verifikovano nad kodom.
> Preduslov: Faza 2 (GL — otvorene stavke iz LedgerEntry). **Ništa nije primenjeno.**

## Centralna ideja
**Otvorene stavke se NE materijalizuju** kao zaseban entitet — **izveden pogled nad `ledger_entry`** (kao BigBit);
zatvaranje = oznaka uskladjivanja na samim redovima. Saldakonti, priprema plaćanja i IOS **dele jedan izvor istine
(GK)** → nema drift-a.

## A — Saldakonti (`src/modules/saldakonti/`)

### Šema (dopune)
- **Na `ledger_entry`** (traži od Faze 2 ako ne nosi): `documentNumber` (Broj dok — ključ grupisanja), `dueDate`
  (Valuta = dospeće; izvedeno iz GoodsDocument.dueDate preko traceback). Faza 4 dodaje samo **`reconciliationGroupId`**
  + `reconciledAt`. Otvorena stavka = red gde je konto u saldakonto registru, nalog proknjižen, `reconciledAt IS NULL`.
- **`SaldakontoAccount`** (`/// Was: PSF_AnalitickaKonta_T`) — registar konta koja drže otvorene stavke; **rešava
  jedan-kontrolni-konto ograničenje:** `account`, `side` receivable|payable, `tracksOpenItems`, `holdsDin/FxBalance`,
  `controlAccount` (2040→202, 4351→435). Seed iz kontnog plana (Faza 1). **Servisi čitaju OVAJ registar, ne hardkod klase.**
- **`ReconciliationGroup`** (batch zatvaranja): controlAccount, partnerId, `kind` auto|manual|payment|compensation,
  `residual` (ostatak ≤ tolerancije), `writeOffJournalEntryId` (ako je ostatak = kursna razlika/otpis).
- **`IosStatement`** + `IosStatementLine` — **SNAPSHOT** u trenutku izdavanja (IOS se ne menja kad se GK menja):
  documentNumber/datum/dueDate/debit/credit/runningBalance/daysOverdue; status draft|sent|confirmed|disputed, pdfPath.
- **`Compensation`** (`/// Was: GRKZag`) + `CompensationLine` — partnerId, account, documentNumber, sourceLedgerEntryId,
  openAmount, `offsetAmount`, `isPartial` (offsetAmount<openAmount = delimično prebijanje „Deo"), direction.

### Servisi
1. **SaldakontoAccountService** — registar (isOpenItemAccount, controlAccountFor, sideOf); keš.
2. **OpenItemsService** — jezgro: `getOpenItems({side?,controlAccount?,partnerId?,cutoff?,onlyDue?})` = Prisma groupBy
   nad ledger_entry po (account, partnerId, documentNumber), Sum debit/credit, HAVING ≠0, proknjižen, reconciledAt NULL.
   Saldo receivable=Σ(debit-credit), payable=Σ(credit-debit). `dueDate`=min po dokumentu, `daysOverdue`=cutoff-dueDate.
   `getAging(buckets 0-30/31-60/61-90/>90)`; `getPartnerCard` (kartica analitike); devizni saldo paralelno.
3. **ReconciliationService** — `autoReconcile(controlAccount, partnerId, tolerance)`: matchuje dugovne (fakture) i
   potražne (uplate/KO) FIFO ili po documentNumber (PNBOdobBroj uplate=broj fakture); |saldo|≤tolerance → grupa +
   reconciledAt; ostatak → kursna razlika/otpis (Faza-2 posting). `manualReconcile`/`unreconcile` (role-gated).
   Poziva se i posle auto-knjiženja izvoda (uparivanje uplate↔faktura).
4. **IosService** — `generate` (snapshot) → `renderPdf` (PdfService/pdfmake) → `send` (Resend attachment, Faza 0) →
   markConfirmed/Disputed; `bulkGenerate` za sve partnere sa saldom.
5. **CompensationService** — `buildFromOpenItems` (predlog iz otvorenih stavki), `validateBalanced` (bilateralno
   min(potraživanje,obaveza); multilateralno lanac konzistentan+balansiran), `post` → Faza-2 nalog vrste **KMP**.

## B — Izvodi (TXT import + auto-knjiženje)
- **BankStatementImportService:** parser **fiksne kolone** po spec-u (FX Import: MatTR 1/18, NazivKomitenta 19/35,
  Iznos 135/13, DugPotInd 148/1, TRKomitenta 149/18, PozivNaBroj 169/20, DatumDok 189/8; LHB varijanta) → `BankStatement`
  + `BankStatementLine`; upload endpoint + preview.
- **Uparivanje:** komitent po žiro računu (Customer žiro polja) → analitička; sa otvorenom stavkom (strana po klasi
  4* potražuje).
- **Auto-knjiženje:** 2 koraka preko Faza-2 posting (komitentska strana + protivstavka konto banke), dvojno pod jednim
  JournalEntry. Posle knjiženja → ReconciliationService upari uplatu sa fakturom.

## C — Priprema plaćanja / virmani
- **Selekcija dospelih** iz LedgerEntry (potražna salda klasa 4 po komitentu/dokumentu, `dueDate ≤ cutoff` = danas).
- **Priprema ekran** (editabilni grid, check-off `Stampati`, masovno Yes/No, edit iznosa/PNB, filteri) → kreiranje
  **`PaymentOrder`** (`/// Was: Virmani`) sa **dedup po (PNBOdobBroj, komitent)** (sprečava dvostruko plaćanje).
- **Status-mašina:** 0 kreiran → 1 potpisan → 2 plaćen; `Zakljucano` (Faza-0 lock).
- **MOD97/MOD11** poziv na broj (`KBroj97=98-((broj*100) mod 97)`) — util.
- **Export fiksni TXT FX format** (vodeći+detaljni slog, tačne širine iz doc 21 §B) + „označi plaćene" posle exporta.
  **FX/Intesa export već radi u legacy → zadržati format** (Nenad).

## Redosled + Quick win
1. SaldakontoAccount registar + OpenItemsService (jezgro). 2. Reconciliation. 3. IOS. 4. Izvodi import+auto-knjiženje.
5. Priprema plaćanja+virmani+export. 6. Kompenzacija. **Quick win:** otvorene stavke + aging po komitentu iz GK
(danas ne postoji) — odmah upotrebljivo za naplatu.

## Odluke
- ✅ **Otvorene stavke = izveden pogled** (ne materijalizovan) — mi-tehnicki.
- ✅ **SaldakontoAccount registar** rešava jedan-kontrolni-konto (lista umesto BigBit jednog) — mi-tehnicki (preporuka
  za više pod-konta, potvrditi Nesa).
- ✅ **IOS snapshot** (ne menja se sa GK) — mi-tehnicki.
- ✅ **FX/Intesa export format zadržan** — Nenad (odlučeno).
- ⏳ **Konto banke za protivstavku izvoda** — iz UplatniRacuni/parametar (potvrditi Nesa).

## Rizici
- **dueDate izvor** — LedgerEntry mora nositi valutu (ili izvesti iz GoodsDocument); bez toga dospelost ne radi.
- **Auto-reconcile pogrešno uparivanje** → guard isti kontrolni konto+komitent, tolerancija, role-gated unreconcile.
- **Dvostruko plaćanje** → dedup (PNBOdobBroj, komitent) pre kreiranja virmana.

**Procena Faze 4:** ~15–22 AI-dana.

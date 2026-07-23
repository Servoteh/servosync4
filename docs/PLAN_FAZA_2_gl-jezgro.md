# FAZA 2 — GL jezgro / Glavna knjiga (implementacioni dizajn, build-ready)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Verifikovano nad kodom.
> Preduslov: Faza 1 (Account/AccountingScheme + izraz-parser) i Faza 0 (audit/lock). **Ništa nije primenjeno.**

## Stanje (verifikovano)
- GL je **greenfield**. `Journal` model (schema:1213) je **app-event-log** (id/message/createdAt), NE
  knjigovodstveni → ime zauzeto → novi modeli **`JournalEntry`/`LedgerEntry`**.
- Postojeća infra hrani kontiranje: `DocumentType` VEĆ ima `postingTemplate` (=legacy IDSeme), `analyticalAccount`,
  `postAnalytical/Synthetic`, `postInVatLedger`, `affectsStock`. `Company` ima `customerAccount @default("2040")` /
  `supplierAccount @default("4350")` (poklapa doc 30). `GoodsDocument` ima `level`, `isLocked`, `postingDate`, `year`,
  `projectId`, `workOrderId` (traceback + lifecycle spremni).
- ⚠️ **GoodsDocumentItem iznosi su `Float`** (legacy-portovani pre §2) → konverzija u Decimal na posting granici.

## Dizajn — modul `src/modules/general-ledger/`

### Prisma modeli (Decimal(19,4), `/// Was:` + schema-rename-map)
- **`JournalEntry`** (`/// Was: T_Nalozi`): `number`(zero-pad 4), `orderTypeCode`→OrderType, `year`, `companyId`,
  `documentDate`, `postingDate`, **`status` draft|posted|locked**, **`version`** (optimistic), `reversesEntryId`/
  `reversedByEntryId` (storno self-FK), `postingSchemeId` (null=ručni), `sourceGoodsDocId`, `signature`/`signedAt`.
  `@@unique([companyId, orderTypeCode, year, number])`.
- **`LedgerEntry`** (`/// Was: T_Glavna_knjiga`): `accountCode`→Account, `analyticalCode`(=komitent, null=sintetika),
  `debit`/`credit` **Decimal**, `fxDebit/fxCredit/fxCurrency` (dev par), `costCenter`, traceback
  (`sourceGoodsDocId/ServiceDocId/ProjectId/WorkOrderId`), `reconciledWithId` (auto-zatvaranje, kasnije).
  `@@index([accountCode, analyticalCode])`.

### Posting engine (`PostingEngineService.postFromGoodsDocument(docId)` u `prisma.$transaction`)
1. Učitaj GoodsDocument+items; DocumentType; `schemeId = postingTemplate` (0/null → skip, idempotentno).
2. **Kontekst kolona A–Z:** agregacija iz items po **autoritativnom mapiranju doc 30 §B** (A=NabNeto, B=ZTS,
   C=ZTD, D=PDV20 osn, O=StvarnaVP, P/Q=PDV, X/Y/Z=avans — NE VBA komentari). **Float→Decimal odmah na ulazu**
   (zaokruži 4 decimale, izoluj gubitak preciznosti izvora).
3. Za svaku liniju šeme: `debit=evaluate(defDebit, ctx)`, `credit=evaluate(defCredit, ctx)` (Faza-1 safe parser);
   `analyticalCode = line.postsAnalytics ? doc.customerId : null`.
4. GROUP BY (accountCode+analyticalCode), sumiraj, odbaci nula-redove (kao legacy 2Korak).
5. **BALANS-KONTROLA:** `Σdebit.equals(Σcredit)`; ako ne → `LedgerNotBalancedException` (tipizirana), rollback
   cele transakcije. **Nikad delimičan upis.**
6. Kreiraj JournalEntry (draft) + LedgerEntry[] sa traceback; broj preko `JournalEntryNumberingService`
   (`pg_advisory_xact_lock(hash(company,vrsta,godina))` → MAX+1 → zero-pad, obrazac `WorkOrderNumberingService`).
7. **Idempotentnost:** proveri postoji li JournalEntry sa `sourceGoodsDocId=docId` (legacy „proknjižen=izveden");
   re-post samo ako je stari draft.

### Životni ciklus + storno (veza Faza 0)
- `post`: draft→posted (signature/signedAt, version++). Guard `assertMutable`: samo draft sme edit/delete.
- `lock`: posted→locked (=legacy Zakljucano). **posted/locked = IMMUTABLE.**
- **`reverse(entryId)`:** NE edit/delete — kreira NOVI storno JournalEntry (obrnut debit↔credit ili negativni
  po KNO `−O−P−Q`), `reversesEntryId`/`reversedByEntryId` linkovi, prolazi istu balans-kontrolu.
- Audit hook na Faza-0 AuditModule (post/lock/reverse → audit event).

## Izveštaji (nad LedgerEntry)
- **Dnevnik** (hronološki, filter datum/vrsta/status). **Bruto bilans/probni** (po kontu: PS duguje/potrazuje
  iz naloga vrste „PS", promet, saldo; osnov za bilanse Faza 7). **Kartica konta** (jedan konto). **Kartica
  analitike** (konto+komitent = saldakonto). **Salda analitike**.
- **Odluka:** bruto stanje **računati u letu** (as-of, kao BigBit) + opciono materijalizovati snapshot za ZR
  (Faza 7) — ne perzistentna tabela stanja. SQL agregacije + apiBlob PDF + FE ekrani.

## Redosled gradnje
1. Potvrdi Faza-1 Account/scheme + izdvoji `ExpressionEvaluatorService` (ako parser nije servis).
2. Modeli JournalEntry/LedgerEntry + migracija + rename-map.
3. `PostingEngineService` + `JournalEntryNumberingService` + balans-kontrola.
4. Životni ciklus (post/lock/reverse) + audit hook.
5. Ručni unos naloga (forma stavki, konta bez šeme — kamate/izvodi/plate; ~87 od 117 vrsta ručno).
6. Izveštaji (Dnevnik, Bruto bilans, kartice).

## Quick win
**Auto-knjiženje jedne robne fakture (IFR) → nalog na 2040/6040/4702 sa balans-kontrolom**, vidljivo u Dnevniku
i Kartici konta — dokaz da posting engine + šeme rade end-to-end.

## Odluke (rešene / Kapija 0)
- ✅ Imena `JournalEntry`/`LedgerEntry` (Journal zauzet) — mi-tehnicki.
- ✅ Novac **Decimal(19,4)**, Float→Decimal na posting granici — mi-tehnicki (§2).
- ✅ Storno = protiv-nalog, nikad edit — mi-tehnicki.
- ✅ Bruto stanje u letu (ne perzistentno) — mi-tehnicki.
- ⏳ **Potvrda kontnog plana + DefDug/DefPot formula** — Nesa/knjigovođa (Kapija 0, K2).
- ⏳ **Mapiranje slova A–Z ↔ GoodsDocumentItem kolone** — proveriti da 2.0 kolone pokrivaju sve (doc 30 §B); ako
  fali kolona, dodati (mi-tehnicki, ali potvrda semantike od knjigovođe).

## Rizici
- **Float izvor u GoodsDocumentItem** → gubitak preciznosti; mitigacija: Decimal konverzija + zaokruživanje na
  ulazu, i dugoročno migrirati te kolone na Decimal (Faza 3 robno).
- **Balans mora uvek štimati** → posting isključivo in-transaction sa balans-kontrolom pre commit-a.
- **Idempotentnost** → guard po `sourceGoodsDocId` da re-post ne duplira nalog.

**Procena Faze 2:** ~18–26 AI-dana.

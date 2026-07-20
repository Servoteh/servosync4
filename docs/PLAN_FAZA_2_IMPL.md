# FAZA 2 — GL posting servis: implementacioni dizajn (build-ready)

> **Datum:** 2026-07-19. Dopuna [PLAN_FAZA_2_gl-jezgro.md](PLAN_FAZA_2_gl-jezgro.md) — ovaj dokument
> je **precizan implementacioni nacrt posting servisa**. Verifikovano nad kodom i doc 18/30.
> **Ništa nije primenjeno u schema.prisma.** Nacrti:
> - `backend/prisma/_nacrt-4.0-faza2-ledger.prisma` — modeli (TEKST, ne u schema)
> - `backend/src/modules/gl/posting/posting.service.ts.nacrt` — servis (prava logika, `.nacrt`)
> - ŽIVO: `backend/src/modules/gl/posting/expression-parser.ts` (parser + `expression-parser.spec.ts`)

## 0. Šta je ŽIVO vs NACRT (verifikovano nad repoom)

| Komponenta | Status | Lokacija |
|---|---|---|
| `evaluateExpression(expr, varMap, arith)` + `Arith<T>` + `numberArith` + `buildVarMap` | **ŽIVO** (`.ts`, testiran) | `backend/src/modules/gl/posting/expression-parser.ts` |
| `Account`, `AccountingScheme`, `AccountingSchemeLine`, `SaldakontoAccount` | **ŽIVO** (schema:2450–2518) | `backend/prisma/schema.prisma` |
| `DocumentType.postingTemplate`, `Company.customerAccount/supplierAccount`, `GoodsDocument(.level/.isLocked/.year/.projectId/.workOrderId)` | **ŽIVO** | `backend/prisma/schema.prisma` |
| `prismaDecimalArith` (adapter Prisma.Decimal) | **treba napisati** pri aktivaciji | README §Decimal daje telo 1:1 |
| `JournalEntry`, `LedgerEntry` | **NACRT** (nije u schema) | ovaj dokument §(a), `_nacrt-4.0-faza2-ledger.prisma` |
| `PostingService.postDocument` | **NACRT** | `posting.service.ts.nacrt` |

Parser je već aktiviran (nije `.nacrt`) — **koristi se stvarno**: servis ga poziva za DefDug/DefPot.

---

## (a) LedgerEntry / JournalEntry model — predlog (Prisma TEKST, NE u schema)

Puna definicija u `backend/prisma/_nacrt-4.0-faza2-ledger.prisma`. Sažetak:

### `JournalEntry` (`/// Was: T_Nalozi`) — zaglavlje naloga
`Journal` (schema:1213) je app-event-log → ime zauzeto → **`JournalEntry`**.

| Polje | Tip | Poreklo / uloga |
|---|---|---|
| `id` | Int PK | IDNaloga |
| `number` | VarChar(10) | Broj naloga, zero-pad 4 po (company, vrsta, godina) |
| `orderTypeCode` | VarChar(5) | Vrsta naloga (= `AccountingScheme.orderType`) |
| `year`, `companyId`, `documentDate`, `postingDate` | | glava |
| `status` | String `draft\|posted\|locked` | životni ciklus (Level/Zakljucano, doc 30 §D) |
| `version` | Int | optimistic lock (edit samo dok draft) |
| `reversesEntryId` / `reversedByEntryId` | Int? self-FK | storno = protiv-nalog, nikad edit |
| `postingSchemeId` | Int? | `AccountingScheme.id`; null = ručni nalog |
| `sourceGoodsDocId` | Int? | **idempotencija ključ** (doc 18 §2.2 t.5) |
| `signature` / `signedAt` | | audit (veza Faza 0) |

`@@unique([companyId, orderTypeCode, year, number])`, `@@index([sourceGoodsDocId])`, `@@index([status])`.

### `LedgerEntry` (`/// Was: T_Glavna knjiga`) — stavka
| Polje | Tip | Poreklo / uloga |
|---|---|---|
| `journalEntryId` | Int FK | IDNaloga |
| `accountCode` | VarChar(10) FK `Account.code` | **Konto** |
| `analyticalCode` | Int? | **komitent** (`Analiticka sifra`); null = sintetika |
| `debit` / `credit` | **Decimal(19,4)** | Duguje / Potrazuje (NIKAD Float) |
| `fxDebit`/`fxCredit`/`fxCurrency` | Decimal?/VarChar(3) | devizni par (SHOULD) |
| `description`, `costCenter` | | opis / mesto troška (Pozicija) |
| `sourceGoodsDocId`/`sourceServiceDocId`/`sourceProjectId`/`sourceWorkOrderId` | Int? | **traceback** (doc 30 §D) |
| `reconciledWithId` | Int? | otvorene stavke / auto-zatvaranje (Faza 4) |

`@@index([journalEntryId])`, `@@index([accountCode, analyticalCode])` (kartica analitike), `@@index([sourceGoodsDocId])`.

**Dopuna ŽIVIH modela pri aktivaciji:** `Account` dobija `ledgerEntries LedgerEntry[]`,
`AccountingScheme` dobija `journalEntries JournalEntry[]` (Prisma traži obe strane relacije).

---

## (b) Tok: DocumentType → šema → linije → evaluate → varMap

```
DocumentType.postingTemplate  (= legacy IDSeme; 0/null → skip, NoPostingSchemeException)
   │
   ▼
AccountingScheme  (id == postingTemplate; nosi orderType = vrsta naloga)
   │  include lines orderBy lineNo
   ▼
AccountingSchemeLine[]  (svaki red = accountCode + defDebit + defCredit + postsAnalytics)
   │
   ▼  za SVAKU liniju:
      debit  = defDebit  ? evaluateExpression(defDebit,  varMap, prismaDecimalArith) : 0
      credit = defCredit ? evaluateExpression(defCredit, varMap, prismaDecimalArith) : 0
      analyticalCode = postsAnalytics ? doc.customerId : null
```

Prazna formula (`""`/null) = ta strana ne postoji za red → 0 (parser bi na prazan string bacio
`ExpressionError("Prazan izraz")`, zato guard pre poziva — README §Kako poziva).

### varMap A–Z — AUTORITATIVNO mapiranje (doc 30 §B / doc 18 §2.2)

Izvor: `SKStavkeZaKnjizenjeAnalitika1Korak.sql`. **NE VBA komentari** (stariji šablon, doc 30 §B ⚠️).

| Slovo | Kolona dokumenta | Značenje |
|---|---|---|
| **A** | `NabNetoVred` | nabavna neto vrednost |
| **B** | `ZTS` | zavisni trošak sopstveni |
| **C** | `ZTD` | zavisni trošak dobavljača |
| **D** | `PPDOsn` | osnovica PDV 20% |
| **E** | `PPDZel` | osnovica PDV 10% („Zeleznica" kolona, doc 18 §3.1) |
| **O** | `StvarnaVP` | stvarna VP vrednost (osnovica izlaza) |
| **P** | PDV viša stopa (20%) | |
| **Q** | PDV niža stopa (10%) | |
| **X / Y / Z** | avans | avansne komponente |

varMap se puni ceo A–Z (slova van tabele = 0) da parser ne pukne ako ih izraz referiše.
Vrednosti su **agregati po dokumentu** (Σ preko stavki), Float→Decimal **na granici** (zaokruži 4 dec.).

**Kontrolne šeme (doc 30 §B/§C, provera protiv živih registara):**
- IFR (roba, IDSeme 33): `2040 DefDug=O+P+Q`, `1320 DefPot=...`, `4702 ...` → kupac duguje bruto.
- UFROB (ulaz, IDSeme 3): `1320 dug=A+B+C`, `2700 dug=D`, `4350 pot=A+B+C+D+E`.
- KNO (IDSeme 31): `2020 DefDug=-O-P-Q` (negativno = storno) → parser podržava unarni minus.

> ⚠️ **Kapija 0 (K2):** tačne A–Z→kolona formule (posebno PDV D/E/P/Q po stopi iz `R_Tarife`) i
> spisak DefDug/DefPot potvrđuje knjigovođa/Nesa. Servis daje SKELET agregacije sa `TODO(kapija-0)`
> markerima — **ne izmišlja PDV brojke**; do potvrde su ta slova 0.

---

## (c) GROUP BY (konto + komitent) agregacija

Legacy `…2Korak` (doc 30 §B): `GROUP BY konto+komitent+dok`, `Sum(Dug)`, `Sum(Pot)`, **odbaci nula-redove**.
- Ključ grupisanja: `accountCode | analyticalCode` (`""` za sintetiku).
- Σ debit i Σ credit po ključu.
- Odbaci red gde su **i** debit **i** credit nula (`debit.isZero() && credit.isZero()`).

Rezultat: skup jedinstvenih (konto, komitent) stavki spremnih za balans-kontrolu i INSERT.

---

## (d) Balans-kontrola ΣDug = ΣPot

Nakon GROUP BY, pre INSERT-a: `Σ debit` vs `Σ credit` preko svih grupisanih stavki.
- Decimal je **egzaktan** → tolerancija 0, poređenje `totalDebit.equals(totalCredit)`.
- Ne štima → **`LedgerNotBalancedException(totalDebit, totalCredit)`** (tipizirana, kod `GL_NOT_BALANCED`).
- Baca se **unutar `$transaction`** → rollback cele transakcije. **Nikad delimičan upis** (doc 30 §F).
- Nije 500 (BACKEND_RULES §7) — poslovna greška sa kodom.

---

## (e) Idempotencija (re-post ne duplira)

Legacy: „proknjižen = IZVEDEN, ne flag" (doc 18 §2.2 t.5) — dokument je proknjižen ako postoji GK
stavka sa njegovim ID-jem. 2.0 ekvivalent = provera `JournalEntry.sourceGoodsDocId = docId`:

1. `findFirst({ where: { sourceGoodsDocId: docId } })`.
2. Postoji i **posted/locked** → `AlreadyPostedException` (nema re-post, immutable).
3. Postoji i **draft** → obriši ga (cascade briše `LedgerEntry`) i ponovo izvedi → **ne duplira nalog**.
4. Ne postoji → normalno knjiži.

`@@index([sourceGoodsDocId])` ubrzava proveru. (Puni `@@unique` bi blokirao storno-lanac istog
dokumenta — zato index + WHERE u servisu, ne unique.)

### Životni ciklus + storno (skica, veza Faza 0)
- `post`: draft → posted (signature/signedAt, version++). Guard `assertMutable`: edit/delete samo draft.
- `lock`: posted → locked. **posted/locked = IMMUTABLE.**
- `reverse(entryId)`: NOVI storno `JournalEntry` (obrnut dug↔pot ili negativni `−O−P−Q`),
  `reverses/reversedBy` linkovi, prolazi istu balans-kontrolu. Nikad edit/delete.

---

## Numeracija naloga
`1 + MAX(number)` po (company, vrsta, godina), zero-pad 4 (doc 30 §D). `pg_advisory_xact_lock(hashtext(company:vrsta:godina))`
u transakciji da paralelni post ne dobiju isti broj (obrazac `WorkOrderNumberingService`).

## Redosled aktivacije
1. Nesa/knjigovođa potvrde kontni plan + DefDug/DefPot + A–Z formule (Kapija 0).
2. Kopiraj modele iz `_nacrt-4.0-faza2-ledger.prisma` u `schema.prisma`, dodaj inverzne relacije,
   `npm run migrate:dev`, ažuriraj `docs/schema-rename-map.md` (`T_Nalozi`→journal_entries, `T_Glavna knjiga`→ledger_entries).
3. Napiši `prisma-decimal-arith.ts` (README daje telo), rename `posting.service.ts.nacrt` → `.ts`.
4. Zameni `TODO(kapija-0)` agregacije potvrđenim PDV/avans formulama.
5. Testovi: balans-kontrola (baca), idempotencija (re-post draft ne duplira, posted baca), GROUP BY, quick-win IFR.

## Quick win
Auto-knjiženje jedne IFR (roba) → `2040 DefDug=O+P+Q` / prihod / PDV, balans-kontrola prođe, vidljivo
u Dnevniku i Kartici konta — end-to-end dokaz da parser + šeme + posting servis rade.

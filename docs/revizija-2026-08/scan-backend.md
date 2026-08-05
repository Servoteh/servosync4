# Skener backenda — inventar anti-obrazaca

**Baza koda:** `C:\Users\nenad.jarakovic\wt\robno-quality\backend\src` (539 ne-test `.ts` fajlova, 173.856 linija; +229 `*.spec.ts`)
**Merilo:** `backend/docs/BACKEND_RULES.md` (v0.9) + `backend/CLAUDE.md`
**Datum:** 2026-08-04

---

## ⚠️ Napomena o stabilnosti mete — obavezno pročitati pre korišćenja linija

Zadatak je opisao ovu putanju kao „svež `main`". **Nije.** To je radni worktree sa **8 neispraćenih izmena i refaktorom koji je tekao TOKOM skeniranja**:

```
HEAD = a53115c0
 M backend/src/modules/robno/{costing,inventory,reservation,robno,transfer}.service.ts
 M backend/src/modules/robno/dto/reservation.dto.ts
?? backend/prisma/migrations/20260804100000_v_stock_movements/
?? backend/src/modules/robno/stock-movements.ts
```

`robno.service.ts` je promenjen **dva puta u toku skeniranja** (1415 → 1302 → 1309 linija, mtime 00:50:21 pa 00:51:40). Da bi brojevi linija uopšte bili upotrebljivi, ceo `src` je **snimljen u 00:51:26** i sve dole navedeno je mereno nad tim snimkom. Za `modules/robno/*` proveri liniju pre nego što je otvoriš.

**Posledica po nalaz:** taj refaktor je **već popravio kalibracioni primer iz zadatka** (obrazac 6) i usput obrisao po jedan nalaz iz obrazaca 2 i 3. To je ovde zabeleženo kao „REŠENO u toku skeniranja", ne kao živ nalaz — v. §6 i §8.

**Metod:** mehanički skeneri (Node, brace-matching za tela petlji; rezolucija tipova `@Body()` do deklaracije; normalizacija SQL fragmenata) → **svaki kandidat pročitan u kodu pre uvrštavanja**. Odbačeno je ~120 lažno pozitivnih (npr. `.filter()` nad listom ID-jeva umesto nad stranom rezultata; `class X extends Y {}` koja nasleđuje validatore; `for (const r of rows) map.set(...)` bez DB poziva).

---

## Rezime

| # | Obrazac | Živih nalaza |
|---|---|---|
| 1 | N+1 upit u petlji | **32** |
| 2 | Filtriranje posle paginacije | **1** (+1 rešen u toku skeniranja) |
| 3 | Mrtav kod | **10** (+11 samo-u-testovima; +1 rešen u toku skeniranja) |
| 4 | Mutirajuća ruta bez validacije | **73** |
| 5 | Nevalidiran numerički param | **9** |
| 6 | Dupliran poslovni predikat u raw SQL-u | **3 grupe** (+1 grupa rešena u toku skeniranja) |
| 7 | Servisi preko 600 linija | **67 ukupno** → 9 stvarno izmešanih + 9 delimično |

---

## 1. N+1 upit u petlji

Kriterijum: `await` na Prisma/`tx` pozivu koji se izvršava jednom po iteraciji. Najteži slučajevi su oni unutar `$transaction` (drže konekciju iz pool-a i otvorenu transakciju) i oni unutar `pg_advisory_xact_lock` (drže i poslovni lock).

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `modules/work-orders/work-orders.service.ts:1657` | work-orders | 🔴 | `bulkClone` pravi po jedan `workOrder.create` + klon 4 tabele za SVAKI RN izvornog predmeta (bez `take`), i to držeći `pg_advisory_xact_lock(projectId)` — na velikom predmetu transakcija sigurno istekne. |
| `modules/kadrovska/kadrovska-mutations.service.ts:3015` | kadrovska | 🔴 | Obračun zarada radi 4 sekvencijalna upita po zaposlenom (`workHours.findMany` :3016, `$queryRaw` :3052 i :3084, RPC :3180) nad celim brojem zaposlenih bez `LIMIT`, sve u jednoj RLS transakciji — ~1200 upita za 300 ljudi. |
| `modules/pdm/pdm-import.service.ts:386` | pdm | 🔴 | Ugnježdeno u petlju :363 — `drawingComponent.findFirst` + `delete`/`update` po ivici × po dokumentu daje kvadratno ponašanje unutar transakcije čiji je `timeout: 120_000` već simptom ovog problema. |
| `modules/pdm/pdm-import.service.ts:412` | pdm | 🔴 | Isto kvadratno ponašanje za `drawingAssembly` u istoj transakciji. |
| `modules/robno/reservation.service.ts:708` | robno | 🟠 | `stockReservation.create` po stavci dok `lockStockKeys` (:557) drži advisory lock na SVAKOM (artikal, magacin) — blokira paralelni `createStockDocument` nad istim artiklima. |
| `modules/robno/reservation.service.ts:675` | robno | 🟠 | `stockReservation.updateMany` po izmenjenoj stavci, isti lock-hold trošak. |
| `modules/handovers/handover-drafts.service.ts:1505` | handovers | 🟠 | `drawingHandover.create` po crtežu dok se drži `pg_advisory_xact_lock(handover_draft_submit:<id>)` (:1474); zamenljivo jednim `createMany`. |
| `modules/pdm/pdm-import.service.ts:281` | pdm | 🟠 | 2 upita (`drawing.findUnique` + `update`/`create`) po jedinstvenom dokumentu celog PDM XML izvoza — hiljade, bez granice. |
| `modules/pdm/pdm-import.service.ts:363` | pdm | 🟠 | `drawing.findMany` po upsertovanom dokumentu samo da nađe starije revizije; jedan grupni `IN` upit ga zamenjuje. |
| `modules/robno/calculation.service.ts:95` | robno | 🟠 | `stockDocumentItem.update` (:185) po stavci dokumenta, bez granice; ulazi u istu transakciju kao nivelacija ispod. |
| `modules/robno/nivelacija.service.ts:182` | robno | 🟠 | 3+ `await`-a po ulaznoj stavci (`itemValuation.findUnique` :183, `costing.stateAsOf` :193, `applyLeveling` :199) naslagana na petlju iz `calculation.service` u JEDNOJ transakciji. |
| `modules/gl/gl-write.service.ts:120` | gl | 🟠 | `ledgerEntry.update` po stavci naloga; `validateCreateJournalEntry` traži samo `lines.length >= 2` — gornje granice nema. |
| `modules/placanja/payment-preparation.service.ts:397` | placanja | 🟠 | 2 upita po nalogu za plaćanje (dedup `findFirst` :414 + `create` :426) nad neograničenim `dto.lines`, u atomičnoj transakciji celog batch-a. |
| `modules/plan-proizvodnje/plan-proizvodnje.service.ts:253` | plan-proizvodnje | 🟠 | Do 2000 sekvencijalnih `upsert`-a (`@ArrayMaxSize(2000)`) u jednoj transakciji umesto jednog `INSERT … ON CONFLICT` nad `unnest`. |
| `modules/podesavanja/podesavanja-users.service.ts:348` | podesavanja | 🟠 | **Otvara NOVU `$transaction` po iteraciji** (:351) za svaki e-mail iz `user_roles` — N transakcija i N zauzimanja konekcije, uz ugnježdenu petlju `overrides` (:358). |
| `modules/izvodi/bank-statement.service.ts:176` | izvodi | 🟠 | 3+ upita po redu izvoda (`matchOpenItem` :185, `bankStatementLine.update` :191, `matchCustomer` :222) na običnom HTTP zahtevu, bez transakcije i bez ikakvog timeout guard-a; dnevni izvod ima stotine redova. |
| `modules/reversi/reversi.service.ts:2141` | reversi | 🟠 | `sy15.withUser(...)` otvara **transakciju po redu** bulk uvoza, a `BulkCuttingRowDto[] rows` nema `@ArrayMaxSize` — uvoz od 5000 redova = 5000 transakcija. |
| `modules/reversi/reversi.service.ts:1932` | reversi | 🟠 | `revTool.findFirst` + `revTool.create` po redu, `rows` bez `@ArrayMaxSize`; provera postojanja je jedan `oznaka IN (...)` upit. |
| `modules/reversi/reversi.service.ts:2755` | reversi | 🟠 | `revDocumentLine.findMany` + cela RPC transakcija po dokumentu u rollback petlji. |
| `modules/saldakonti/compensation.service.ts:300` | saldakonti | 🟠 | `ledgerEntry.findUnique` po stavci kompenzacije; jedan `findMany({id:{in:[…]}})` zamenjuje celu petlju. |
| `modules/saldakonti/compensation.service.ts:341` | saldakonti | 🟠 | 1–3 upita po `postLines` stavci (`findMany` :346 + dva `updateMany` :365/:371). |
| `modules/sales/sales.service.ts:652` | sales | 🟠 | `applyCoefficient` radi `invoiceItem.update` po stavci — svaka promena koeficijenta prepisuje ceo dokument red po red. |
| `modules/sales/sales.service.ts:390` | sales | 🟠 | `invoiceItem.update` po pomerenoj stavci pri prenumeraciji; jedan raw `lineNo = lineNo - 1 WHERE lineNo > x` to rešava. |
| `modules/nabavka/nabavka.service.ts:355` | nabavka | 🟠 | `supplierRfqItem.update` po stavci upita za ponudu. |
| `modules/nabavka/nabavka.service.ts:568` | nabavka | 🟠 | `purchaseOrderItem.update` po stavci narudžbenice za upis `receivedQuantity`. |
| `modules/pracenje/pracenje.service.ts:767` | pracenje | 🟠 | BFS po roditeljskom grafu radi 2 upita po čvoru (`findUnique` :771 + `findMany` :785); dubina je ograničena (`CYCLE_MAX_DEPTH = 50`) ali širina fronta nije. |
| `modules/pracenje/pracenje.service.ts:409` | pracenje | 🟠 | `predmetAktivacija.update` po redu za pomeranje ZA JEDNO MESTO — menjaju se samo dva reda, a prepisuje se ceo rep liste. |
| `modules/sastanci/sastanci.service.ts:1715` | sastanci | 🟠 | `presekAktivnost.updateMany` po id-u; `ReorderDto` ima `@ArrayMinSize(1)` ali **nema** `@ArrayMaxSize`. |
| `modules/sastanci/sastanci.service.ts:2106` | sastanci | 🟠 | `pmTema.updateMany` po stavci; `ReorderRangDto` takođe bez `@ArrayMaxSize`. |
| `modules/handovers/handovers.service.ts:1022` | handovers | 🟠 | `user.findFirst({where:{workerId}})` (:1053) + slanje mejla po generatoru odbijenih primopredaja; jedan `findMany` pre petlje to rešava. |
| `modules/tech-processes/tech-processes.service.ts:3554` | tech-processes | 🟠 | `position.findUnique` (:3555) + `partLocation.create` (:3561) po lokaciji iz `dto.locations`, bez granice. |
| `modules/pracenje/pracenje.service.ts:458` | pracenje | 🟡 | Do 50 `updateMany` poziva (DTO nameće ≤50) u jednoj transakciji — trivijalno spojivo u jedan `CASE` update. |

**Nije nalaz (namerno):** `modules/robno/reservation.service.ts:820` (`lockStockKeys`) izvršava `pg_advisory_xact_lock` po ključu u petlji, ali je to **sortirano zauzimanje lock-ova radi izbegavanja deadlock-a**. Batch verzija je moguća (`… FROM unnest($1) ORDER BY k`), ali se redosled NE SME ukloniti.

---

## 2. Filtriranje POSLE paginacije

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `modules/nabavka/three-way-match.service.ts:288–306` | nabavka | 🟠 | `matchSummary` skenira najviše `MATCH_SCAN_LIMIT = 1000` narudžbenica (:288), pa tek onda filtrira `findingCount > 0` (:302) i seče stranu u JS-u (:303) — `meta.total` (:307) je broj nalaza **unutar prvih 1000**, pa lista tiho tvrdi manji broj neusaglašenosti nego što ih ima (kod sam loguje upozorenje na :291). |

**REŠENO u toku skeniranja:** `robno.service.ts` `listLagerAsOf` je filtrirao `query.q` u JS-u posle `LIMIT/OFFSET` uz `total` bez tog filtera — ista greška protiv koje živi `listLager` ima eksplicitan komentar (`„Pretraga MORA u SQL, pre LIMIT/OFFSET"`). Metoda je obrisana neispraćenim refaktorom; nema je više ni u snimku ni u živom stablu.

Odbačeno kao lažno pozitivno (11 kandidata): `item-lookup.service.ts:253`, `customers.service.ts:669`, `cnc-programs.service.ts:417`, `handovers.service.ts:270`, `pdm.service.ts:924`, `odrzavanje.service.ts:621`, `reversi.service.ts:889`, `daily-brief.service.ts:703`, `advance-vat.service.ts:596` i dr. — svuda je `.filter()` nad listom ID-jeva ili nad skupom za presek, ne nad stranom rezultata. `plan-proizvodnje-read.service.ts:209` prozorira po RN-u u JS-u, ali je pretraga `q` primenjena u SQL-u pre toga, pa `total`/`has_more` ostaju tačni (perf, ne korektnost).

---

## 3. Mrtav kod

Provereno grep-om nad celim `src` (uključujući `*.spec.ts`), uz proveru barrel `index.ts` re-eksporta (postoje samo dva, nijedan ne dodiruje ove module) i namespace importa (nema ih).

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `common/authz/roles.ts:283` | common/authz | 🟡 | `ACTIVE_2_0_ROLES` — nula referenci; katalog uloga je „jedini izvor" (BACKEND_RULES §2.2), a nosi mrtvu listu koja može da se raziđe sa živom. |
| `common/authz/roles.ts:291` | common/authz | 🟡 | `getRoleMeta` — nula referenci u istom, kritičnom authz fajlu. |
| `common/document-types/stock-check.ts:70` | common | 🟡 | `STOCK_CHECK_LABEL` — nula referenci. |
| `common/login-throttle.ts:72` | common | 🟡 | `__resetLoginThrottle` — test hook **bez ijednog testa** (za razliku od `__resetClaimThrottle`, koji se koristi); ili napiši test ili ukloni. |
| `common/login-throttle.ts:76` | common | 🟡 | `LOGIN_THROTTLE_POLICY` — nula referenci, dok njegov blizanac `CLAIM_THROTTLE_POLICY` jeste pokriven spec-om. |
| `modules/documents/servoteh-logo.ts:10` | documents | 🟡 | `SERVOTEH_LOGO_RATIO` — nula referenci. |
| `modules/gl/print/doc-layout.ts:442` | gl | 🟡 | `sumDecimals` — nula referenci u štampi glavne knjige. |
| `modules/kadrovska/payroll/payroll-calc.ts:489` | kadrovska | 🟡 | `isWeekdayYmd` — nula referenci u obračunu zarada. |
| `modules/sync/table-ownership.ts:164` | sync | 🟡 | `isQbigtehnChainEntity` — nula referenci; vlasništvo tabela je pravilo iz BACKEND_RULES §3, pa mrtav predikat o njemu obmanjuje čitaoca. |
| `modules/sync/table-ownership.ts:440` | sync | 🟡 | `BIGBIT_SOURCE_MARKER` — nula referenci. |

**Eksporti koji postoje samo zbog testova (11)** — nisu mrtav kod, ali jesu proširenje javne površine radi testiranja: `detectAttachmentContentType`, `ALL_ROLE_KEYS` (namerni „tripwire" u 9 spec-ova — ne brisati), `buildVarMap`, `SERIES_PREFIXES`, `paymentWindowLabel`, `isDateInPaymentWindow`, `formatPresenceHm`, `parseOpRef`, `buildIdentCandidates`, `sortTpOptions`, `NATIVE_ID_MAX`.

**REŠENO u toku skeniranja:** `robno.service.ts:332` `private async listLagerAsOf()` — 110 linija (JSDoc 324–331 + telo 332–433), nula poziva bilo gde. Bila je „DB-060 fallback" za granu koju je `listLager` u međuvremenu uklonio. Obrisana neispraćenim refaktorom. **Posle toga u celom `src` nema nijedne nepozvane `private` metode.**

---

## 4. Mutirajuća ruta bez validacije (kršenje BACKEND_RULES §6/§8)

`main.ts:67` — `app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))`. Bez klase kao metatype pipe nema šta da validira; komentar na `main.ts:64–66` to i priznaje („Handleri sa interface tipovima … pipe ih preskače").

Kodna baza ima i **prihvaćen alternativni obrazac** — `interface` + `validate*()` funkcija (v. `gl/dto/create-journal-entry.dto.ts:27`, koji se poziva na BACKEND_RULES §6). Zato su **odbačene 74 rute** koje taj guard stvarno zovu i **12 delimičnih**. Ostaje **73 mutirajuće rute bez ijedne provere tela**:

- **34** sa inline object-literal tipom (`@Body() body: { year: number; month: number }`)
- **24** sa `interface` tipom
- **15** sa `type` alias tipom

Po modulima: robno 12 · sales 6 · pdv 6 · izvodi 6 · saldakonti 5 · auth 5 · handovers 4 · zavrsni 3 · zahtevi 3 · work-orders 3 · ostalo 20.

Najozbiljnije (novčani i knjigovodstveni tok):

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `modules/pdv/pdv.controller.ts:119` | pdv | 🔴 | `POST kif-kuf/build` sa inline telom `{year, month, force}` — nevalidirani `year`/`month` idu u `Number()` i dalje u raw SQL (v. §5); ovo je ulazna tačka lanca koji vraća 500. |
| `modules/pdv/pdv.controller.ts:160` | pdv | 🔴 | `POST popdv/compute` sa inline telom — `NaN` mesec prolazi opsežnu proveru i stiže u raw SQL i u Prisma `where` (v. §5). |
| `modules/saldakonti/saldakonti.controller.ts:288` | saldakonti | 🔴 | `POST compensation` — `CreateCompensationDto` je `type` alias u `compensation.service.ts:33`; kompenzacija knjiži u glavnu knjigu bez ijedne provere iznosa/stavki. |
| `modules/sales/sales.controller.ts:286` | sales | 🔴 | `POST advance-invoices` — `CreateAdvanceInvoiceDto` je `type` alias (`advance-invoice.service.ts:27`); avansna faktura nosi PDV posledice. |
| `modules/sales/sales.controller.ts:321` | sales | 🔴 | `POST invoices/:id/apply-advance` sa inline `{advanceInvoiceId: number; amount?: string \| number}` — iznos zatvaranja avansa neproveren. |
| `modules/sales/sales.controller.ts:297` | sales | 🔴 | `POST advance-invoices/:id/paid` sa inline `{paidAt: string; amount: string \| number}` — datum i iznos plaćanja neprovereni. |
| `modules/izvodi/izvodi.controller.ts:162` | izvodi | 🔴 | `POST :id/post` — `PostStatementDto` je `type` alias (`bank-statement.service.ts:26`); knjiženje izvoda u GK bez provere tela. |
| `modules/izvodi/izvodi.controller.ts:123` / `:132` | izvodi | 🔴 | Dodavanje/izmena stavke izvoda (`type` alias) — iznosi i veze ka nalozima neprovereni. |
| `modules/gl/gl.controller.ts:115` | gl | 🔴 | `POST journal/lock-older` sa inline `{beforeDate?: string; dryRun?: boolean}` — masovno zaključavanje naloga glavne knjige; `beforeDate` nije ni proveren kao datum. |
| `modules/gl/gl.controller.ts:150` | gl | 🔴 | `POST year-open` — `YearOpenDto` je `interface` (`year-open.service.ts:45`); otvaranje poslovne godine bez validacije. |
| `modules/robno/robno.controller.ts:323` | robno | 🔴 | `POST documents` sa presekom tipova `{kind} & CreateStockDocumentDto` — glavna ruta za unos robnog dokumenta nema validaciju stavki ni količina. |
| `modules/robno/robno.controller.ts:531` | robno | 🔴 | `POST transfers` — `CreateTransferDto` je `interface` (`dto/transfer.dto.ts:29`); ublažava ga `validateHeader` u servisu (`transfer.service.ts:141`), ali to nije `class-validator` i ne pokriva `items[]` po polju. |
| `modules/placanja/placanja.controller.ts:96` | placanja | 🔴 | `POST orders/sign-batch` sa inline `{ids: number[]}` — masovno potpisivanje naloga za plaćanje bez provere niza. |
| `modules/placanja/placanja.controller.ts:112` | placanja | 🔴 | `POST orders/lock-older` sa inline telom — masovno zaključavanje platnih naloga. |
| `modules/auth/auth.controller.ts:177` | auth | 🟠 | `POST change-password` — `ChangePasswordBody` je `interface` deklarisan u samom kontroleru (:41); promena lozinke bez provere dužine/tipa. |
| `modules/auth/auth.controller.ts:156` | auth | 🟠 | `POST logout` — `RefreshBody` `interface` (:37). |
| `modules/masters/customers.controller.ts:91` / `:97` | masters | 🟠 | `POST ''` i `PATCH :id` imaju `@Body() body: unknown` — komitenti se upisuju iz potpuno netipiziranog tela. |
| `modules/zavrsni/zavrsni.controller.ts:67` / `:79` / `:105` | zavrsni | 🟠 | Bilans stanja, bilans uspeha i finalizacija završnog računa — sve tri sa inline `{year?: number}` / `{force?, reason?}`. |
| `modules/nabavka/nabavka.controller.ts:265` | nabavka | 🟠 | `POST orders/:id/receive` sa inline `{lines: Array<{itemId, receivedQuantity?}>}` — prijem robe, ugnježdeni niz bez ikakve provere. |
| `modules/sync/sync.controller.ts:39` | sync | 🟠 | `POST run` — `RunSyncBody` `interface`; ovo je i dalje otvoreni `TODO(auth)` dug iz BACKEND_RULES §7. |

*(preostalih 53 su iste vrste, niže poslovne težine — pun spisak reproducibilan skenerom `scan-body3.js`)*

---

## 5. Nevalidiran numerički param u SQL/Prisma

Kršenje `CLAUDE.md` pravila 7 / BACKEND_RULES §6 („500 je rezervisan za neočekivane greške"). Ceo klaster je u `pdv` modulu.

**Pojačivač (uzrok što i namerno odbijanje vraća 500):**

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `modules/pdv/popdv.service.ts:759` | pdv | 🔴 | `PopdvPeriodException extends Error` — nije `HttpException`, pa ga `common/http-exception.filter.ts:34` ne propušta; **namerno** odbijanje nevalidnog perioda korisniku stiže kao 500 „Neočekivana greška na serveru". |
| `modules/pdv/vat-ledger.service.ts:545` | pdv | 🔴 | `InvalidVatPeriodException extends Error` — isto; nigde u `src` nije uhvaćen ni mapiran. |

**Mesta gde `NaN` stiže do upita:**

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `modules/pdv/pdv.controller.ts:168–169` | pdv | 🔴 | `Number(body.month)` daje `NaN`, a `NaN != null` je `true` → guard `if (hasMonth && (month < 1 \|\| month > 12))` (`popdv.service.ts:745`) **propušta NaN jer su oba poređenja `false`** → NaN stiže i u raw SQL `EXTRACT(MONTH …) IN (${Prisma.join(months)})` (:403) i u Prisma `taxPeriodMonth: { in: months }` (:454). Isto važi za `quarter` (:748 → `[NaN,NaN,NaN]`). |
| `modules/pdv/pdv.controller.ts:180` | pdv | 🔴 | `?year=abc` → `NaN != null` → `popdv.service.ts:324` `where: { periodYear: NaN }` ide direktno u Prisma → 500 iz drajvera umesto 422. |
| `modules/pdv/pdv.controller.ts:204–206` | pdv | 🔴 | KEPU: `Number(year)` → `new Date(Date.UTC(NaN, …))` = Invalid Date vezan kao raw parametar (`kepu.service.ts:149`), a `?warehouseId=abc` → `` Prisma.sql`AND kbe.warehouse_id = ${NaN}` `` (`kepu.service.ts:200`). |
| `modules/pdv/pdv.controller.ts:219–221` | pdv | 🔴 | Ista tri parametra na drugoj KEPU ruti (knjiga). |
| `modules/pdv/pdv.controller.ts:125–126` | pdv | 🟠 | `Number(body.year)`/`Number(body.month)` iz inline tela → `assertPeriod` (`vat-ledger.service.ts:130`) → `InvalidVatPeriodException` → 500 (v. pojačivač). Prazno telo `{}` je dovoljno. |
| `modules/pdv/pdv.controller.ts:167` | pdv | 🟠 | `Number(body.year)` → `resolvePeriod` (`popdv.service.ts:735`) → 500. |
| `modules/pdv/pdv.controller.ts:97–98, 104–105, 115` | pdv | 🟠 | `GET kif` / `GET kuf` / provera perioda: bare `@Query("year") year: string` bez `ParseIntPipe`; izostavljen parametar → `Number(undefined) = NaN` → 500. |

**Odbačeno kao lažno pozitivno (provereno da JESTE zaštićeno):** `kvalitet.service.ts:187,190` (NaN ne prolazi kroz poređenja sa konstantama) · `plan-proizvodnje-read.service.ts:442,443` i `plan-proizvodnje.service.ts:64,65,128,328,329` (DTO ima `@Matches(/^\d+$/)`) · `pracenje-read.service.ts:716,1448,1449` i `pracenje.service.ts:75,100,179,197` (`@Matches(NODE_ID)`) · `moj-profil.service.ts:770,1032` (`@IsISO8601` / `@IsNumber @Min @Max`, uz NaN-safe opsege) · ceo `kadrovska.service.ts` (`@Type(() => Number) @IsInt @Min @Max`).

---

## 6. Dupliran poslovni predikat u raw SQL-u

### Grupa A — „šta se uopšte broji kao proknjižen nalog" (🔴)

Predikat `je.status IN ('POSTED','LOCKED')` + prateći `JOIN journal_entries je ON je.id = le.journal_entry_id` prepisan je **20 puta u 14 fajlova**. Postoji tačno jedna konstanta — `POSTED_STATUSES` u `zavrsni/control-rules.service.ts:93` — ali **nije eksportovana**, pa je niko drugi ne može koristiti.

Raw SQL (16 mesta, 11 fajlova):
`gl/gl-read.service.ts:116` · `gl/print/account-card-print.service.ts:143` · `gl/print/journal-book-print.service.ts:163` · `gl/print/trial-balance-print.service.ts:125` · `gl/year-open.service.ts:194` · `pdv/popdv.service.ts:401` · `pdv/popdv.service.ts:503` · `pdv/vat-ledger.service.ts:180` · `pdv/vat-sanity.ts:520` · `pdv/vat-sanity.ts:536` · `saldakonti/open-items.service.ts:217` · `saldakonti/open-items.service.ts:274` · `saldakonti/open-items.service.ts:354` · `saldakonti/partner-card.service.ts:160` · `saldakonti/partner-card.service.ts:187` · `sales/fakturisanje.service.ts:1420`

Prisma strana (4 mesta, 4 fajla):
`izvodi/bank-statement.service.ts:283` · `izvodi/bank-statement.service.ts:905` · `kamata/kamata.service.ts:181` · `placanja/payment-preparation.service.ts:141`

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| 20 mesta gore, sidro `saldakonti/open-items.service.ts:217` | gl/pdv/saldakonti/sales/izvodi/kamata | 🔴 | Doslednost drže isključivo komentari koji se međusobno pozivaju („Konzistentno sa partner-card / assertCreditLimit / payment-preparation…", open-items:211–215) — propusti li se jedno mesto pri dodavanju novog statusa, PDV, IOS, kartica partnera i kreditni limit tiho počnu da tvrde različit dug za istog komitenta, bez ijedne greške u logu. |

### Grupa B — „otvorena stavka saldakonta" (🟠)

Trojka `JOIN saldakonto_accounts sa ON sa.account = le.account_code` + `je.status IN ('POSTED','LOCKED')` + `AND sa.tracks_open_items = TRUE`, **6 puta u 3 fajla**:
`saldakonti/open-items.service.ts:212/223`, `:273/277`, `:350/360` · `saldakonti/partner-card.service.ts:159/162`, `:186/189` · `sales/fakturisanje.service.ts:1416/1422`

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `saldakonti/open-items.service.ts:212`, `partner-card.service.ts:159`, `sales/fakturisanje.service.ts:1416` | saldakonti/sales | 🟠 | Isti predikat otvorene stavke pokreće i IOS i brana kreditnog limita (`assertCreditLimit`); razilaženje znači da kupac prođe limit kao da duga nema — komentar na `fakturisanje.service.ts:1418–1420` upravo taj scenario opisuje kao već jednom uhvaćen nalaz. |

### Grupa C — nesargabilan filter godine (🟠)

`AND EXTRACT(YEAR FROM je.posting_date) = ?` — **5 mesta u 3 fajla**: `pdv/popdv.service.ts:402`, `:504` · `pdv/vat-ledger.service.ts:181` · `pdv/vat-sanity.ts:523`, `:537`

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `pdv/popdv.service.ts:402` (+4) | pdv | 🟠 | Funkcija nad kolonom obara indeks po `posting_date` na svih 5 mesta odjednom; uz to je isti poslovni „prozor perioda" prepisan pet puta, pa promena semantike perioda mora da se izvede peterostruko. |

### Grupa D — kalibracioni primer iz zadatka: **REŠENO u toku skeniranja**

`document_type_code <> 'KODJ' AND COALESCE(dt.affects_stock,TRUE)=TRUE AND sdi.deleted_at IS NULL` + `CASE WHEN dt.is_inbound THEN quantity ELSE -quantity END` — na `HEAD (a53115c0)` je stajao **10 puta u 5 fajlova**:

`robno/costing.service.ts:66/67` (`stateAsOf`), `:135/136` (`averageAsOf`), `:185/186` (`lastPrice`) · `robno/robno.service.ts:230/231` (`listLager` agregat), `:363/364` + `:379/380` (`listLagerAsOf` + count), `:555/556` (`getItemCard`) · `robno/reservation.service.ts:915/916` (`computeOnHand`) · `robno/inventory.service.ts:488/489` (`candidateItemIds`) · `robno/transfer.service.ts:603/604` (`averageCosts`)

Neispraćeni refaktor uvodi pogled `v_stock_movements` (migracija `20260804100000_v_stock_movements`) i modul `robno/stock-movements.ts` sa `V_STOCK_MOVEMENTS` simbolom, i briše svih 10 prepisa. **Komentar te migracije nezavisno potvrđuje isti broj** („PREPISANI u 10 raw-SQL upita u 5 fajlova"). Nakon refaktora u celom `src` nema više nijednog pojavljivanja `affects_stock` u SQL-u.

→ **Grupe A, B i C su ISTA bolest u GL/PDV/saldakonti domenu i NISU obuhvaćene tim refaktorom.** Isti lek (pogled ili eksportovan `Prisma.sql` fragment) direktno se preslikava.

---

## 7. Servisi preko 600 linija

**67 `*.service.ts` fajlova prelazi 600 linija.** Broj linija sam po sebi nije nalaz — kriterijum je broj RAZLIČITIH odgovornosti. Analizirana su 22 najveća.

### Tier A — stvarno izmešane odgovornosti (9)

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `modules/tech-processes/tech-processes.service.ts:1` (4906) | tech-processes | 🟠 | 9 klastera (read+A4 pretraga · kiosk barkod/identitet radnika · upis rada · analitika sesija · izveštaji · storno/audit · štampa nalepnica · provere dozvola · cron) i 6 injektovanih servisa, od toga 2 cross-domain reach-in (`QualityService`, `WorkOrdersService`) — najgori slučaj u bazi. |
| `modules/odrzavanje/odrzavanje.service.ts:1` (4480) | odrzavanje | 🟠 | Ceo CMMS u jednoj klasi: 7+ familija entiteta (mašine, vozila, vozači, IT oprema, objekti, delovi, RN, incidenti, dokumenta, podešavanja) × read I write; sopstveni baneri u fajlu i `R2 — MUTACIJE` na :1743 su doslovno manifest podservisa. |
| `modules/kadrovska/kadrovska-mutations.service.ts:1` (4076) | kadrovska | 🟠 | 6 imenovanih domena (odmori · sati · zaposleni · zarade · notifikacije · storage proxy) + **inline HTML renderer mejlova** (`inviteEmailHtml`, `escHtml`); injektuje **2 različita DB klijenta** (`Sy15Service` + `PrismaService`). |
| `modules/reversi/reversi.service.ts:1` (3188) | reversi | 🟠 | Čitanja + katalog + klasifikaciono stablo + izveštaji + **bulk uvoz sa fuzzy matchingom imena** (`resolveEmployeesFuzzy`, `stripDiacritics`) + **engine za masovni storno** (`analyzeReversals`/`executeReversals`/`rollbackReversals`) + štampa + PDF potpisi. |
| `modules/sastanci/sastanci.service.ts:1` (2718) | sastanci | 🟠 | 9 klastera uključujući **AI sumarizaciju** (`aiSummary`, injektuje `AiProviderService` + `AiModelPolicyService`) i **storage/slike** — ni jedno ni drugo nije domen sastanaka. |
| `modules/moj-profil/moj-profil.service.ts:1` (2330) | moj-profil | 🟠 | „Moj profil" (o sebi) i **„Moj tim"** (`team`, `teamMemberHours`, `teamAttendanceCorrection`, `managesEmployee`) su **različiti permisijski domeni u istoj klasi**, plus 360-rater inbox i ~175-linijski kalkulator sati. |
| `modules/kadrovska/kadrovska.service.ts:1` (2157) | kadrovska | 🟠 | Isti 6 domena kao mutations servis, samo read; familija `report*` i familija grid/prisustvo su dva očigledna podservisa; takođe 2 DB klijenta. |
| `modules/locations/locations.service.ts:1` (1519) | locations | 🟠 | Uz lokacije/palete nosi i **administraciju sync/bridge-a** (`syncStatus`, `syncHealth`, `syncOutbound`, `syncArm`, `syncRunNow`, `definitionsAudit`) — potpuno druga odgovornost; 2 DB klijenta + printer. |
| `modules/podesavanja/podesavanja.service.ts:1` (1200) | podesavanja | 🟠 | Grab-bag: korisnici/role/dozvole · org struktura · profil firme · **okvir kompetencija** · aktivacija/prioritet predmeta · AI modeli · audit log — 5 nepovezanih poddomena; 2 DB klijenta. |

### Tier B — jedan domen, 1–2 jasno izdvojiva podservisa (9)

| fajl:linija | modul | ozb. | konkretna posledica |
|---|---|---|---|
| `modules/sales/print/invoice-pdf.service.ts:1` (2326) | sales | 🟡 | Dve odgovornosti duž već postojeće granice imena: repozitorijum podataka za štampu (`load*`) i graditelj izgleda (`build*`), za 6 vrsta dokumenata + legacy putanja. |
| `modules/pracenje/pracenje-read.service.ts:1` (2085) | pracenje | 🟡 | Read-only i kohezivan, ali nosi ~600-linijski engine stabla sklopova / re-parentinga (`projectNodes`, `virtuelniSklopovi`, `sliceSubtree`, algoritam dokumentovan na 335–460). |
| `modules/work-orders/work-orders.service.ts:1` (1990) | work-orders | 🟡 | Kohezivan domen + ~400-linijski engine kloniranja (`copyFrom`/`cloneVariant`/`rework`/`bulkClone`) + blok PDF priloga crteža. |
| `modules/handovers/handovers.service.ts:1` (1905) | handovers | 🟡 | Primopredaje + notifikacije/mejlovi + PDF storage + kreiranje RN-a (koje pripada `work-orders`); injektuje 5 servisa. |
| `modules/handovers/handover-drafts.service.ts:1` (1669) | handovers | 🟡 | Legitimno dug agregat; izdvojiv je samo ~250-linijski engine preduslova (`checkItemPreconditions`, `preCheckItems`) i notifikacije. |
| `modules/zahtevi/zahtevi.service.ts:1` (1510) | zahtevi | 🟡 | Najbolje razložen od velikih (AI/odluke/mejl su već podservisi, injektuje ih 8); inline je ostao samo klaster priloga + AI transkripcije. |
| `modules/kvalitet/kvalitet.service.ts:1` (1412) | kvalitet | 🟡 | Kohezivan NC domen + familija `summary*` (6 metoda analitike) + skladište dokumenata — dve čiste ekstrakcije. |
| `modules/robno/robno.service.ts:1` (1302) | robno | 🟡 | Uglavnom kohezivan agregat robnog dokumenta; izdvojivi su generisanje **KEPU knjige** (`writeKepuForDocument`, `rebuildKepu`) i read-izveštaji (lager, kartica artikla). |
| `modules/izvodi/bank-statement.service.ts:1` (1119) | izvodi | 🟡 | Agregat izvoda + **engine automatskog uparivanja** (`matchLines`/`matchCustomer`/`matchOpenItem`) + **knjiženje u GK** (`postStatement`, `nextJournalNumber`) — dve odvojive odgovornosti. |

### Tier C — nije nalaz (kohezivno, samo dugačko)

`modules/zavrsni/control-rules.service.ts` (1269) — klasa je zapravo ~200 linija; ostalo su čiste modul-level funkcije pravila. · `modules/sales/fakturisanje.service.ts` (1581) — 5 javnih metoda, ostalo su privatni koraci istih transakcija; već delegira pricing/posting/numbering/SEF. · `modules/sales/advance-invoice.service.ts` (1125) — 3 javne metode, jedan PDV životni ciklus. · `modules/sync/bigbit-mdb-import.service.ts` (3805) — jedan ETL posao; mehanički deljiv na per-entity syncere po obrascu koji repo već koristi, ali nizak prioritet.

### Veliki kontroleri — provereno, oba su tanka

`modules/odrzavanje/odrzavanje.controller.ts` (1322, ~148 ruta) i `modules/kadrovska/kadrovska-mutations.controller.ts` (903, ~137 ruta): grep za `throw new`, `await `, `if (`, `prisma`, `Number(` daje **nula pogodaka u oba fajla**. Čist routing sloj — nema poslovne logike za premeštanje; njihova veličina je samo simptom veličine pripadajućih servisa.

---

## TOP 15 po vrednosti popravke

| # | Nalaz | Trud | Šta se dobija |
|---|---|---|---|
| 1 | §5 — `PopdvPeriodException` / `InvalidVatPeriodException` da nasleđuju `HttpException` (`popdv.service.ts:759`, `vat-ledger.service.ts:545`) | **S** | Dve linije uklanjaju ceo razred lažnih 500-ki; namerno odbijanje perioda postaje 422 sa porukom. Odmah usklađuje modul sa „500 samo za neočekivano". |
| 2 | §5 — `NaN` guard na PDV periодu (`popdv.service.ts:745/748` + `pdv.controller.ts:168–169,180,204–206,219–221`) | **S** | Zatvara jedini potvrđen put kojim `NaN` stiže i u raw SQL i u Prisma `where`; `Number.isInteger()` umesto `<`/`>` poređenja. |
| 3 | §6 grupa A — eksportovati `POSTED_STATUSES` i jedan `Prisma.sql` fragment za `JOIN journal_entries … status IN (…)` | **M** | Uklanja 20 prepisa u 14 fajlova; PDV, IOS, kartica partnera i kreditni limit prestaju da mogu tiho da se raziđu. Konstanta već postoji u `control-rules.service.ts:93` — treba je samo izložiti. |
| 4 | §1 — `work-orders.service.ts:1657` `bulkClone` na `createMany` po tabeli | **M** | Uklanja jedini nalaz sa garantovanim produkcijskim padom (tx timeout uz držan advisory lock na predmetu). |
| 5 | §1 — `kadrovska-mutations.service.ts:3015` obračun zarada: 4 upita/zaposleni → 4 grupna upita | **M** | ~1200 upita → ~4 za 300 zaposlenih; skida najduži RLS transakcijski blok u bazi. |
| 6 | §4 — `class-validator` DTO za 14 novčanih ruta iz §4 tabele (avansi, kompenzacija, izvod-post, GK lock/year-open, robni dokument, prenos, sign-batch) | **M** | Najveći deo stvarnog rizika iz 73 rute pokriven sa ~14 klasa; ostalo može postepeno. |
| 7 | §1 — `pdm-import.service.ts:386/412` ugnježdene petlje → grupni `IN` upit po nivou | **M** | Uklanja kvadratno ponašanje unutar transakcije čiji je `timeout: 120_000` već postavljen zbog njega. |
| 8 | §6 grupa B — deljeni fragment za „otvorena stavka saldakonta" (6 mesta, 3 fajla) | **S** | IOS i brana kreditnog limita počinju da čitaju doslovno isti predikat; komentar na `fakturisanje.service.ts:1418` opisuje nalaz koji je taj razlaz već jednom napravio. |
| 9 | §1 — `reversi.service.ts:1932/2141` + `@ArrayMaxSize` na `BulkToolRowDto`/`BulkCuttingRowDto` | **S** | Sprečava 5000 transakcija iz jednog HTTP zahteva; `@ArrayMaxSize` je jedna linija po DTO-u. |
| 10 | §2 — `three-way-match.service.ts:288–306`: filtriranje `findingCount > 0` u SQL, pre `LIMIT` | **M** | `meta.total` prestaje da laže iznad 1000 narudžbenica; kod već loguje upozorenje da broji pogrešno. |
| 11 | §1 — `bank-statement.service.ts:176` uparivanje izvoda: 3 upita/red → batch pre petlje | **M** | Uvoz dnevnog izvoda (stotine redova) prestaje da bude stotine round-tripova na sinhronom HTTP zahtevu bez timeout-a. |
| 12 | §1 — `podesavanja-users.service.ts:348`: izvući `$transaction` IZVAN petlje | **S** | N transakcija → 1; uklanja N zauzimanja konekcije iz pool-a. |
| 13 | §7 — izdvojiti sync/bridge administraciju iz `locations.service.ts` (6 metoda) | **S** | Najjeftinija Tier A ekstrakcija — te metode nemaju veze sa lokacijama i lako se sele. |
| 14 | §3 — obrisati 10 potvrđeno mrtvih eksporta (posebno `ACTIVE_2_0_ROLES` i `getRoleMeta` u `common/authz/roles.ts`) | **S** | Authz katalog je „jedini izvor" po BACKEND_RULES §2.2 — mrtva lista uloga pored žive je zamka pri sledećoj izmeni prava. |
| 15 | §7 — razdvojiti `tech-processes.service.ts` po granici kiosk-upis / analitika sesija / read | **L** | Najveći dug u bazi (4906 linija, 9 klastera, 2 cross-domain reach-in-a); jedini na listi koji traži plan, ne popravku. |

---

### Reproducibilnost

Skeneri korišćeni za ovaj izveštaj (u istom scratchpad folderu, svi read-only): `scan-loops.js` (obrazac 1), `scan-misc.js paginate|dead|deadexport|num` (2, 3, 5), `scan-body3.js` (4), `scan-sqldup.js` (6). Svi gađaju snimak `snap/src`. Nijedan fajl u repou nije menjan.

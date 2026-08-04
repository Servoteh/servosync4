# Protivprovera: `docs/revizija-2026-08/scan-backend.md` — svi 🔴 nalazi

**Grana:** `refactor/robno-single-source` · **HEAD u trenutku provere:** `bcfd9b5e`
(izveštaj je pisan na `a53115c0` — HEAD se pomerio 5 komitova, linije u `robno/` i `pdv/` su pomerene).
**Kod:** `C:\Users\nenad.jarakovic\wt\robno-quality\backend\src` (read-only, ništa nije menjano)
**Merilo za §4:** `backend/test/body-validation-baseline.json` (mašinski merenih 164 rute) +
`backend/test/body-validation-coverage.e2e-spec.ts`

## Rezultat

| | broj |
|---|---|
| Presuda ukupno | **14** (od toga §4 tabela nosi 14 pod-redova) |
| POTVRĐENO | **5** |
| OBORENO | **7** |
| POTVRĐENO UZ ISPRAVKU (struktura tačna, posledica/brojka pogrešna) | **2** |
| §4 pod-redovi: oboreno / potvrđeno | **13 / 1** |

🔴 **Glavni nalaz protivprovere:** §4 tabela („mutirajuća ruta bez validacije") je **13/14 pogrešna**.
Izveštaj na `scan-backend.md:125` sam kaže da je odbacio 74 rute koje zovu `validate*()` guard — a
onda je u 🔴 tabelu upisao upravo takve rute. Baseline JSON meri **pipe** sloj (tačno), izveštaj je tu
brojku pročitao kao „nema nikakve provere tela" (netačno). To je obrazac 2 iz zadatka —
jedan sloj → ekstrapolacija na celu putanju.

---

## Presude

| nalaz | fajl:linija | PRESUDA | ozbiljnost posle provere | precizna formulacija | dokaz |
|---|---|---|---|---|---|
| **1.** §1 kvadratni N+1 u PDM uvozu | `pdm/pdm-import.service.ts:386` | **OBOREN** | 🟡 | Petlje SU tekstualno ugnježdene, ali **nije kvadratno**: unutrašnja iteracija ne zavisi od N. `staleComponents` su **postojeći redovi u bazi** čiji je `childDrawingId` starija revizija — trošak je Σ po zastarelim ivicama, ne proizvod N×M. Oba `@@index`-a postavljena su namerno za ovaj pristup. Za tipičan uvoz petlja se izvrši **0 puta**. | `:363 for (const u of upserted)` → `:374 if (!isHighest) continue;` i `:376 if (!oldIds.length) continue;` — dve kapije gase unutrašnju petlju kad ne postoji starija revizija. `:382 findMany({where:{childDrawingId:{in:oldIds}}})`, pa `:386 for (const edge of staleComponents)`. `schema.prisma:348-350`: `// Perf paket (DB-037): … PDM relink idu po obe strane.` + `@@index([childDrawingId], map:"idx_drawing_components_child")` |
| **2.** §1 isto kvadratno za `drawingAssembly` | `pdm/pdm-import.service.ts:412` | **OBOREN** | 🟡 | Bajt-za-bajt isti oblik kao #1, ista presuda. Dodatno: predloženi lek iz `scan-backend.md:286` („grupni `IN` upit") **napravio bi kvar** — kod to izričito objašnjava. | `:408 findMany` → `:412 for (const edge of staleAssemblies)`. Komentar `:378-380`: „Dedup po (parent, child) ručno — **nema unique constrainta, pa bi slepi update napravio dupli red** kad parent već ima vezu na novu reviziju." |
| **3.** §1 „transakcija čiji je `timeout: 120_000` već simptom ovog problema" | `pdm-import.service.ts:195` | **OBOREN** | — | Transakcija je **po fajlu (po HTTP zahtevu)**, ne „ceo PDM XML izvoz"; jedan zahtev nosi jedan fajl. Vrednost `120_000` je **identična HTTP timeout-u bridge klijenta** — nijedan komentar ni dokument je ne pripisuje petljama. Nema `pg_advisory_xact_lock` nigde u `modules/pdm`. Jedina granica na N je `fileSize: 10MB`; mereno na stvarnom produkcijskom izvozu N≈37, plafon N≲7.800. | `:195` `// Upsert tok — JEDNA transakcija po fajlu; log ide VAN nje.` `:197-199 $transaction(…, {timeout:120_000, maxWait:10_000})`. `tools/pdm-bridge/pdm-bridge.mjs:31 const REQUEST_TIMEOUT_MS = 120_000;`. `pdm.controller.ts:69 limits:{fileSize: 10*1024*1024}`. `test/fixtures/pdm/1126982_B.xml` = 146.105 B / 37 distinct docId |
| **4.** §4 🔴 tabela „mutirajuća ruta bez validacije" (14 ruta) | — | **OBOREN 13 / POTVRĐEN 1** | 🟠 (svedeno) | Vidi pod-tabelu ispod. Pipe ih zaista preskače (baseline je tačan), ali 12 od 14 poziva `validate*()` guard ili validira u samom kontroleru. Zatečeni dug je stilski (`interface` umesto klase), ne „bez ijedne provere tela". | pod-tabela |
| **5.** §1 `bulkClone` — „na velikom predmetu transakcija sigurno istekne" | `work-orders.service.ts:1595` (petlja `:1656`) | **POTVRĐEN UZ ISPRAVKU** | 🟠 (bilo 🔴) | Struktura tačna: `workOrder.create` + `cloneItems` po RN-u, `findMany` bez `take`. **Pojačanje koje izveštaj nije našao:** `$transaction` na `:1604` **nema `timeout`** → Prisma podrazumevani **5 s**, ne 120 s. **Ali** „sigurno istekne" je nemereno, a advisory lock je na **PRAZNOM ciljnom** predmetu — 409 garantuje da tamo nema drugog posla, pa lock-contention iz nalaza ne postoji. `cloneItems` je uz to **batch-ovan** (`createMany`), ~9 upita/RN, ne 4 reda pojedinačno. | `:1623 pg_advisory_xact_lock(${targetProjectId})` (TARGET, ne source). `:1625-1631 if (existingInTarget > 0) throw new ConflictException("… bulk-clone je dozvoljen samo u prazan predmet.")`. `:1634 findMany({where, orderBy})` bez `take`. `:1664 tx.workOrder.create`, `:1679 this.cloneItems(...)`. `cloneItems` `:1782 Promise.all([4× findMany])` + `:1805 createMany` |
| **6.** §1 obračun zarada „~1200 upita za 300 ljudi" | `kadrovska-mutations.service.ts:3015` | **POTVRĐEN UZ ISPRAVKU** | 🟠 (bilo 🔴) | N+1 je stvaran (3–4 sekvencijalna upita po zaposlenom u jednoj transakciji). **Brojke su izmišljene** (obrazac 5): produkcija ima **157** zaposlenih, ne 300; 4. upit je u `if (persist)` grani, pa preview radi 3. Realno **≤628**, tipično ~400–500 — ne „~1200". Granica postoji: `monthEmpIds` dolazi iz `salary_payroll` za taj mesec i prazan skup je 422. | `:3015 for (const emp of employees)`, `:3016 tx.workHours.findMany`, `:3052 tx.$queryRaw`, `:3084 tx.$queryRaw`, `:3179 this.rpcJson(tx, …)` — poslednji u `persist` grani (`else results.push(preview)` `:3190`). `:2998-3007` `monthRows` → `if (!monthEmpIds.length) throw new UnprocessableEntityException("Mesec nije pripremljen …")`. `docs/infra/BAZE-UPOREDNI-PREGLED.md:66`: `employees (157)` |
| **7.** §5 `PopdvPeriodException extends Error` → namerno odbijanje stiže kao 500 | `pdv/popdv.service.ts:759` | **POTVRĐEN** | 🔴 | Doslovno tačno. Klasa nasleđuje `Error`, ne `HttpException`; filter propušta samo `HttpException`; **nigde u `src` nije uhvaćena** (grep: nula `catch`/`instanceof`). Baca se na `:741` i `:749`. | `:759 export class PopdvPeriodException extends Error {`. `common/http-exception.filter.ts:34 if (exception instanceof HttpException) {` … `:48 res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({… "Neočekivana greška na serveru…"})`. Registrovan: `main.ts:54 app.useGlobalFilters(new AllExceptionsFilter())` |
| **8.** §5 `InvalidVatPeriodException extends Error` | `pdv/vat-ledger.service.ts:545` | **POTVRĐEN** | 🔴 | Isto. Baca se na `:536`/`:539` iz `assertPeriod`, i iz `popdv.service.ts:736`/`:746`. Grep po celom `src`: jedini pogodci su deklaracija, dva `throw`-a i jedan `import` — **nula mesta hvatanja ili mapiranja**. | `:545 export class InvalidVatPeriodException extends Error {`, `:546 readonly code = "PDV_INVALID_PERIOD";`. Grep `InvalidVatPeriodException` po `src`: `popdv.service.ts:50` (import), `vat-ledger.service.ts:536,539,552` |
| **9.** §5 `NaN` mesec prolazi guard i stiže u raw SQL **i** u Prisma `where` | `popdv.service.ts:745` + `pdv.controller.ts:167-169` | **POTVRĐEN** | 🔴 | Lanac je doslovno tačan i prohodan. `:735` proverava **samo `year`** kroz `Number.isInteger`; za `month` te provere **nema nigde** u `resolvePeriod`. `NaN != null` → `hasMonth = true`; `:745` oba poređenja `false` → propušta; `months = [NaN]` ide u oba upita. | `:738 const hasMonth = month != null;` · `:745 if (hasMonth && (month < 1 \|\| month > 12))` — bez `Number.isInteger` · `:166 resolvePeriod` → `:169 periodMonths` → `:175 sumVatAccounts` → `:403 AND EXTRACT(MONTH FROM je.posting_date) IN (${Prisma.join(months)})`; i `:185 sumManualVatEntries` → `:454 taxPeriodMonth: { in: months }` |
| **10.** §5 `?year=abc` → `where:{periodYear:NaN}` direktno u Prisma | `popdv.service.ts:324` | **POTVRĐEN** | 🟠 | Tačno, i linija se **nije pomerila**. `Number("abc")=NaN`, `NaN != null` je `true`, pa uslovni izraz uzima granu sa `NaN`. | `pdv.controller.ts:180 year != null ? Number(year) : undefined` → `popdv.service.ts:324 where: year != null ? { periodYear: year } : undefined` |
| **11.** §5 KEPU: `Date.UTC(NaN)` i `warehouse_id = ${NaN}` u raw SQL | `kepu.service.ts:200` / `:138` | **POTVRĐEN** | 🟠 | Tačno na obe KEPU rute (`book` i `recap`), bez ijednog `Number.isInteger`/`ParseIntPipe` gejta. | `pdv.controller.ts:200-206` i `:215-221`: `Number(year)`, `Number(month)`, `Number(warehouseId)` → `kepu.service.ts:187 new Date(Date.UTC(year, 0, 1))` i `:200 Prisma.sql\`AND kbe.warehouse_id = ${warehouseId}\`` (isto `:138` u `recap`) |
| **12.** §6 grupa A — `POSTED_STATUSES` nije eksportovana, predikat prepisan 20× u 14 fajlova | `zavrsni/control-rules.service.ts:93` + 20 mesta | **POTVRĐEN (izveštaj UNDERCOUNTS)** | 🔴 | Jedina konstanta stvarno **nije eksportovana** — `const`, bez `export`, u servisu koji nije ni deljiva biblioteka. Brojka nije naduvana nego **preniska**: mereno **32 pojave u 17 ne-test fajlova** (izveštaj kaže 20/14). Izveštaj nije naveo `saldakonti/reconciliation.service.ts` i `zavrsni/gkeval.service.ts`. | `control-rules.service.ts:93 const POSTED_STATUSES = ["POSTED", "LOCKED"];` — bez `export` (susedni `:96 const CLOSING_ORDER_TYPE` isto). Mereno: `grep -rn "POSTED'.*'LOCKED'\|POSTED\".*\"LOCKED"` bez `*.spec.ts` = **32 pogotka / 17 fajlova** |
| **13.** (c) REZIDUAL: da li **ijedan pisac glavne knjige** proverava PDV bravu | `pdv/vat-period-lock.ts:60` | **POTVRĐEN** | 🔴 | **Ne — 2 od ~18 ulaznih točaka u GK.** Deljeni motor `PostingEngineService` bravu **ne zove**, pa je nijedan pisac ne nasleđuje. Bravu importuju samo 4 fajla u celom `src`, svi u `pdv/` i `sales/`; `gl/`, `robno/`, `izvodi/`, `nabavka/`, `blagajna/`, `saldakonti/`, `placanja/`, `sync/` — nula. Dve koje je zovu (`advance-invoice.service.ts:538`, `:849`) su ručne dogradnje, što kod i priznaje. | `posting.service.ts:28-40` (import blok — nema `vat-period-lock`), `:236 tx.journalEntry.create({… status:"POSTED"})` bez provere. `advance-invoice.service.ts:536-537`: „Ulazni smer je ovu bravu imao od početka; **izlazni je nije** (review Batch C, nalaz 6)." Bez brave: `gl-write.service.ts:92` (`POST /gl/journal`, slobodan `dto.documentDate`), `posting.service.ts:389`, `fakturisanje.service.ts:1521`, `bank-statement.service.ts:740`, `blagajna.service.ts:152`, `compensation.service.ts:330`, `fx-revaluation.service.ts:436`, `year-open.service.ts:442`, `sync/bigbit-mdb-import.service.ts:1923` |
| **14.** (c) kontra-hipoteza: postoji li **ekvivalentna GK brava** koja nalaz #13 čini bezopasnim | `prisma/migrations/**` + `gl/` | **OBORENA kontra-hipoteza** (nalaz #13 stoji) | 🔴 | Tražen mehanizam po obrascu 1 — **ne postoji**. Nema tabele perioda, nema `CHECK` na datum, nema INSERT/UPDATE trigera, nema simbola `assertPeriodNotLocked`/`closedPeriod`/`fiscalPeriod` (grep: nula). Postoji samo **po-redu** nepromenljivost, koja je ortogonalna: `LOCKED` čuva postojeći red, ali ništa ne brani **opsegu datuma** da primi nove redove. `settings.auto_lock_gk` je mrtva kolona. | Triger je **samo `BEFORE DELETE`**: `20260725200000_faza2_constraint_mreza/migration.sql:20-29` → `IF upper(OLD.status) IN ('POSTED','LOCKED') THEN RAISE EXCEPTION 'POSTED_DELETE_FORBIDDEN…'` + `CREATE TRIGGER guard_delete BEFORE DELETE ON journal_entries`. `lockOlderThan` (`gl-write.service.ts:238-280`) radi `updateMany` nad **postojećim** redovima i ne ostavlja marker koji bi insert put mogao pročitati. `settings.auto_lock_gk` referisan samo iz `sync/sync-map.generated.ts:2668` |

---

## Pod-tabela: §4 🔴 rute u TRENUTNOM kodu (13 oborenih / 1 potvrđena)

Linije su **ažurirane na `bcfd9b5e`**; gde se pomerila, navedena je i stara iz izveštaja.

| ruta (tvrdnja izveštaja) | fajl:linija sada | PRESUDA | dokaz — šta doslovno piše |
|---|---|---|---|
| `robno.controller.ts:323` `POST documents` — „glavna ruta … nema validaciju stavki ni količina" | `robno.controller.ts:348-350` | **OBOREN — već popravljeno** | Telo je klasa: `:350 create(@Body() body: CreateStockDocumentBodyDto)`; `dto/create-stock-document.dto.ts:209 export class CreateStockDocumentBodyDto extends CreateStockDocumentDto { @IsIn(STOCK_DOCUMENT_KINDS…) }`. Komentar `:344-346` opisuje baš tu popravku. **`POST /robno/documents` NE POSTOJI u `body-validation-baseline.json`** — mašinska potvrda. |
| `robno.controller.ts:531` `POST transfers` — „`validateHeader` … ne pokriva `items[]` po polju" | `robno.controller.ts:556` | **OBOREN** | Kaveat je netačan: `transfer.service.ts:643 return dto.items.map((it, idx) => {` pa **po polju po stavci**: `:645 if (!Number.isInteger(it?.itemId) \|\| it.itemId <= 0) throw`, `:652 if (!quantity.greaterThan(0)) throw`, `:668 if (d.isNegative()) throw … ne sme biti negativna` (za obe cene). Zaglavlje: `:627/:631/:635/:638`. |
| `sales.controller.ts:286` `POST advance-invoices` | `:286` (nepomereno) | **OBOREN** | `advance-invoice.service.ts:204 const input = validateCreateAdvanceInvoice(dto);` → `dto/advance-invoice.dto.ts:66-152` (proforma id, iznos kroz `parseAmount` sa regexom `/^-?\d+(\.\d+)?$/`, obavezan kupac/iznos/osnov bez predračuna, `parseDate`). |
| `sales.controller.ts:297` `advance-invoices/:id/paid` — „datum i iznos plaćanja neprovereni" | `:297` | **OBOREN** | `advance-invoice.service.ts:476 const input = validateMarkAdvancePaid(dto);` → `dto/advance-invoice.dto.ts:163 parseDate(dto?.paidAt, …)`, `:168 parseAmount(dto?.amount, …)`, oba **obavezna** (`:165`, `:170`), `:173 if (errors.length) throw new BadRequestException(errors);`. |
| `sales.controller.ts:321` `invoices/:id/apply-advance` — „iznos zatvaranja avansa neproveren" | `:321` | **OBOREN** | `advance-invoice.service.ts:672 const input = validateApplyAdvance(dto);` → `dto/advance-invoice.dto.ts:208/:211 isPositiveInt(...)`, `:216 parseAmount(dto.amount, "Iznos odbitka avansa", errors)`. |
| `izvodi.controller.ts:123` / `:132` — „iznosi i veze ka nalozima neprovereni" | `:123` / `:132` | **OBOREN** | `bank-statement.service.ts:347 validateCreateStatementLine(dto);` i `:396 validateUpdateStatementLine(dto);`. |
| `izvodi.controller.ts:162` `POST :id/post` — „knjiženje izvoda u GK bez provere tela" | `:162` | **OBOREN** | `bank-statement.service.ts:615 validatePostStatement(dto);` |
| `gl.controller.ts:115` `journal/lock-older` — „`beforeDate` **nije ni proveren kao datum**" | `:115` | **OBOREN — doslovno pobijeno** | Provera stoji **4 linije ispod `@Body()`**, u samom kontroleru: `:121 if (!raw \|\| typeof raw !== "string" \|\| raw.trim() === "") throw new BadRequestException("Parametar beforeDate je obavezan (datum praga).")` i `:125 if (Number.isNaN(before.getTime())) throw new BadRequestException("Parametar beforeDate nije ispravan datum.")` |
| `gl.controller.ts:150` `POST year-open` — „otvaranje poslovne godine bez validacije" | `:150` | **OBOREN** | `year-open.service.ts:88-107`: `if (!Number.isInteger(fromYear) \|\| fromYear < 2000 \|\| fromYear > 2100) throw`, isto za `toYear`, `if (toYear <= fromYear) throw`, i `if (Number.isNaN(psDate.getTime())) throw … "postingDate nije ispravan datum."` |
| `placanja.controller.ts:96` `orders/sign-batch` — „bez provere niza" | `:96` | **OBOREN** (rezidual 🟡) | Niz **jeste** proveren: `:100 const ids = Array.isArray(body?.ids) ? body.ids : [];`. Elementi su pojedinačno ograđeni: `payment-preparation.service.ts:599-608 for (const id of orderIds) { try { await this.transition(id,"CREATED","SIGNED",…) } catch (e) { skipped.push({id, reason:…}) } }` — loš id postaje `skipped`, ne pad. **Rezidual:** nema `@ArrayMaxSize`, pa je N upita neograničen — to je 🟡 perf, ne 🔴 novčani nalaz. |
| `placanja.controller.ts:112` `orders/lock-older` | `:112` | **OBOREN** | Identična provera kao GL: `:118 if (!raw \|\| typeof raw !== "string" \|\| raw.trim() === "") throw new BadRequestException(…)`, `:122 if (Number.isNaN(before.getTime())) throw new BadRequestException("Parametar beforeDate nije ispravan datum.")` |
| `saldakonti.controller.ts:288` `POST compensation` — „knjiži u GK **bez ijedne provere** iznosa/stavki" | `:288` (telo `:291`) | **OBOREN — doslovno pobijeno** | `compensation.service.ts:169 validateCreateCompensationDto(dto);` → `dto/saldakonti.dto.ts:87-121`: `partnerId` ceo pozitivan broj, `lines.length < 2` → greška, **po stavci** `ledgerEntryId`/`side`/`isPositiveDecimalString(l.amount)`, i „mora imati obe strane (potraživanje i obavezu)". Baš iznosi i stavke koje izveštaj tvrdi da nisu provereni. |
| `pdv.controller.ts:119` `kif-kuf/build` — „nevalidirani `year`/`month` … **idu dalje u raw SQL**" | `:119` | **OBOREN u posledici** (rezidual = #7/#8) | Posledica je netačna: `vat-ledger.service.ts:130 this.assertPeriod(year, month);` → `:538 if (!Number.isInteger(month) \|\| month < 1 \|\| month > 12) throw` — **`NaN` mesec puca ovde i nikad ne stiže u SQL**. Ostaje samo pogrešna klasa greške (500 umesto 422) = nalaz #8, ne „nevalidirano telo". |
| `pdv.controller.ts:160` `popdv/compute` — „`NaN` mesec prolazi … i stiže u raw SQL i u Prisma `where`" | `:160` | **POTVRĐEN** | Jedina tačna 🔴 ruta u tabeli. Ceo lanac u nalazu #9: `resolvePeriod` `:745` nema `Number.isInteger` za `month` → `:403` raw SQL i `:454` Prisma `where`. Razlika prema `kif-kuf/build`: `assertPeriod` proverava mesec, `resolvePeriod` ne. |

---

## Presuda o `vat-period-lock` rezidualu (zadatak (c))

**POTVRĐEN — rezidual je stvaran i nije bezopasan.**

Formulacija koja izdržava provocu: *„PDV brava `assertVatPeriodNotLocked` (`pdv/vat-period-lock.ts:60`)
štiti samo PDV obračun i uređivanje nacrta faktura. Od ~18 ulaznih točaka koje pišu u
`journal_entries`/`ledger_entries`, njih **2** je zovu (`sales/advance-invoice.service.ts:538` i
`:849`), i to ručno. Deljeni motor `PostingEngineService.postManualEntry`
(`gl/posting/posting.service.ts:192`, upis na `:236`) bravu ne zove, pa je nijedan pisac ne nasleđuje.
GK **nema** sopstvenu bravu perioda kao zamenu."*

Šta obara „prethodni krug ju je oborio": oborena je bila samo **formulacija** („zove se isključivo iz
`pdv/`"). Rezidual ide u obrnutom smeru — 6 poziva u `sales/` ne spašava nalaz, jer **4 od tih 6**
(`sales.service.ts:186/247/305/377` kroz `:482`) sede na uređivanju polja **DRAFT** fakture, a
`sales.service.ts` **ne piše u GK uopšte**.

Najoštrija asimetrija, cela dokaziva u kodu: **ne možeš** izmeniti stavku nacrta fakture u zaključanom
periodu (`sales.service.ts:247` → 409), **ali možeš** tu istu fakturu proknjižiti u GK i u KIF
(`fakturisanje.service.ts:1521`, bez brave). Brava stoji na jeftinoj operaciji, a nema je na skupoj.

Posledica koja je time potvrđena: nalog sa `documentDate` u periodu za koji `VatReturn` ima status
`POSTED` uleće kao `status:"POSTED"` (`posting.service.ts:236`) bez ijedne greške — a POPDV
prekomputacija tog meseca je blokirana (`popdv.service.ts:172`) i KIF/KUF punjenje takođe
(`vat-ledger.service.ts:134`), pa se **taj red ne može više nikada pojaviti u nijednom PDV obračunu**.

---

## Tri najteža POTVRĐENA nalaza

1. **GK se knjiži u zaključan PDV period, i taj red ne može ući u nijedan PDV obračun** — nalazi
   #13 + #14. Deljeni `PostingEngineService` ne zove bravu, GK nema ekvivalentnu bravu perioda (samo
   `BEFORE DELETE` triger i po-redu `LOCKED`), a `POST /gl/journal` prima slobodan `documentDate`
   (`gl-write.service.ts:92`). Tiho, više modula, poreska posledica. **Lek nije 18 popravki nego jedna:**
   pozvati bravu u `postManualEntry`/`postFromStockDocument`.
2. **„Šta se broji kao proknjižen nalog" prepisan 32× u 17 ne-test fajlova, a jedina konstanta nije
   eksportovana** — nalaz #12 (`control-rules.service.ts:93`, `const` bez `export`). Ovde je izveštaj
   **potcenio** obim (tvrdio 20/14). Doslednost PDV-a, IOS-a, kartice partnera i kreditnog limita drže
   isključivo komentari; propušten prepis znači različit dug za istog komitenta bez greške u logu.
3. **PDV period: `NaN` mesec stiže i u raw SQL i u Prisma `where`, a namerna odbijanja stižu kao 500** —
   nalazi #7, #8, #9 (+#10, #11). `resolvePeriod` (`popdv.service.ts:745`) proverava opsege ali nikad
   `Number.isInteger` za `month`, dok `assertPeriod` (`vat-ledger.service.ts:538`) to radi — ista
   provera, dva različita ishoda na dve susedne rute. Uz to dve klase (`:759`, `:545`) nasleđuju `Error`
   umesto `HttpException` i nigde nisu uhvaćene, pa svako namerno odbijanje perioda korisnik vidi kao
   „Neočekivana greška na serveru".

**Runner-up (svedeno, ali stvarno):** `bulkClone` — nalaz #5. Struktura N+1 je tačna i izveštaj je
**promašio pravo pojačanje**: `$transaction` na `work-orders.service.ts:1604` **nema `timeout`**, pa važi
Prisma podrazumevanih 5 s, a ne 120 s. Ono što je izveštaj naduvao je lock-contention (lock je na
praznom ciljnom predmetu) i „sigurno istekne" (nemereno).

---

## Obrasci precenjivanja — gde su se okinuli

| obrazac | gde | šta se desilo |
|---|---|---|
| **1. Apsolutna negacija merena jednim grepom** | §4, 12 ruta | „bez ijedne provere tela" mereno pipe slojem; `validate*()` guard u servisu nije tražen — iako `scan-backend.md:125` sam priznaje da taj obrazac postoji i da je po njemu odbačeno 74 rute. |
| **2. Jedan sloj → ekstrapolacija** | §4 `saldakonti:288`, `gl:115`, `robno:531` | Posledica („knjiži u GK bez provere iznosa", „beforeDate nije ni proveren kao datum", „ne pokriva `items[]` po polju") tvrđena bez čitanja servisa — a kod te tvrdnje pobija doslovno. |
| **4. Zastarela meta** | §4 `robno:323` | Već popravljeno na grani; klasa `CreateStockDocumentBodyDto` + komentar `:344-346` koji objašnjava baš tu popravku. Odsustvo iz baseline-a je mašinska potvrda. |
| **5. Izmišljeni brojevi** | §1 zarade | „~1200 upita za 300 ljudi" — produkcija ima **157** zaposlenih (`BAZE-UPOREDNI-PREGLED.md:66`), realno ≤628. |
| **5. Izmišljeni brojevi (u DRUGOM smeru)** | §6 grupa A | „20 puta u 14 fajlova" je **preniska** brojka; mereno 32/17. Nalaz je time teži, ne lakši. |
| **nova varijanta: „timeout je simptom"** | §1 pdm | Kauzalno tvrđeno bez dokaza; ista konstanta `120_000` je HTTP timeout bridge klijenta (`pdm-bridge.mjs:31`), a transakcija je po fajlu. |

## Šta izveštaj tvrdi tačno i treba mu priznati

- `body-validation-baseline.json` kao merilo **jeste** ispravno na svom sloju — 164 rute stvarno prolaze
  pipe bez validacije. Greška je u prevodu te činjenice u poslovnu posledicu, ne u merenju.
- §5 klaster (`pdv`) je **najkvalitetniji deo izveštaja**: tačne linije, tačan lanac, tačan mehanizam
  (`NaN != null` → `false || false`), i tačna dijagnoza pojačivača (klasa greške). Ništa nije preteralo.
- §6 grupa A je **potcenjena**, ne precenjena.
- „REŠENO u toku skeniranja" beleške (§2, §3, §6 grupa D) su ispravno klasifikovane kao ne-živi nalazi
  — izveštaj je tu bio disciplinovan.

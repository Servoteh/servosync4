# FAZA 6 — PDV / POPDV / mesečni ciklus (implementacioni dizajn, build-ready)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Verifikovano nad kodom.
> Preduslov: Faza 2 (GL), Faza 5 (računi + SEF), Faza 3 (robno RuC/KEPU). **Ništa nije primenjeno.**

## Stanje (verifikovano)
Nijedan PDV model ne postoji. Kačimo se na: `TaxRate` (`/// Was: R_Tarife`, svih 5 kolona koje se **sabiraju** +
`validFrom/validTo` + `vatGroup`) — **effective-dating skelet već tu, treba resolver**; `DocumentType.postInVatLedger`
(=KnjizitiUPDVEvidenciju) + `postingTemplate` + `isInbound`; `Customer.vatStatus` (=PDVStatus; 2=van PDV);
`GoodsDocumentItem` per-stavku stope + flagovi obračuna + nonTaxablePart.

## A — PDV knjige (KIF/KUF) — `src/modules/vat-books/`

### Modeli
- **`VatBookEntry`** (`/// Was: T_PDV_IF + T_PDV_UF`, spojene sa `book` diskriminatorom): `book` KIF|KUF,
  `documentTypeCode`, `documentNumber`, `documentDate`, **`taxPeriod`** (DatPorPerioda — period kome PDV pripada, ≠ datum
  dok), `customerId`, `isTaxableSupply` (JestePromet), `direction` (+1 / **-1 za storno/knjižno odobrenje/REV**);
  osnovice po grupi (`baseVisa/Niza/Poljo/Nula/VanPdv` Decimal) + PDV (`vatVisa/Niza/Poljo`); `deductibleType` DA|NE|DEL
  (hook za POPDV); `popdvCode` (PDVOznaka); poreklo (`goodsDocumentId`/`serviceDocumentId`/`ledgerEntryId` — jedan set);
  `postedAt`. **Idempotentnost = parcijalni @@unique po (book, origin)** (Prisma ekvivalent legacy `Is Null`).
- **`VatBookRun`** (nova infra za mesečni ciklus): `period` (YYYY-MM), `book`, `status` DRAFT|POSTED|REVERSED — vezuje
  batch da se ceo period može čisto obrisati i reknjižiti.

### `VatPostingService` (transakcijski, idempotentno)
1. **postFromGoodsInvoices(period, book):** GoodsDocument gde `postInVatLedger=true` I nema VatBookEntry za (book,
   goodsDocumentId); po stavci `rate=resolveRate(item.taxRate, doc.date)`, osnovica=(qty×actualWholesalePrice−nonTaxablePart)
   → bucket po `vatGroup`, PDV=osnovica×stopa. **Van-PDV grana** (Customer.vatStatus=2 → baseVanPdv, PDV=0). **REV →
   direction=-1.** `createMany` jednim INSERT-om.
2. **postFromServiceDocuments** (analogno usluge). 3. **postFromLedger** (iz GK preko `PDV_SemeKontaZaKnjizenje`
   osnovica↔PDV smer; zavisi od Faze 2). 4. **reversePeriod** (obeleži run REVERSED, obriši entrye — čist reknjiži).

### `TaxRateResolver.resolve(code, onDate)`
Efektivna stopa = **SUM(5 kolona)** (PDVZbirneStope); izbor reda: **grupa POBEĐUJE datum** — filtriraj po vatGroup, pa
onaj čiji [validFrom,validTo] pokriva onDate (ne-preklapajući: 3=20% od 01.10.2012, 4=10%, 5=8%). **Port F_PDV_*Stopa iz
PRAVE effective-dated tabele, NE hardkodovanih pragova** (doc 18 §3.1 zahtev). Nema stope za datum → tipizirana greška.

## B — POPDV engine (deklarativni obrazac, POPDV_DEF izvučen 164 reda)
- **Modeli:** `PopdvFormDef` (import POPDV_DEF: `pdvOznaka`, `sekcija`, `k1def..k4def` formule, `k1aop..k4aop`,
  `aktivneKolone` maska — **seed iz izvučenih 164 reda**); `PopdvGkLine` (`/// Was: T_POPDV_GK`: GK stavka → PDVOznaka →
  K1..K4 iznos).
- **`PopdvPostingService`:** knjiži GK stavku u POPDV kolone preko `POPDV_SemeKontaZaKnjizenje` (konto+PDVOznaka),
  idempotentno.
- **POPDV obračun engine:** učitaj PopdvFormDef, **Eval `KxDef` formule preko Faza-1 safe parsera** (rekurzivno nad
  iznosima drugih oznaka — npr. `1.5=[1.1K1]+[1.2K1]+…`), agregacija po `KxAOP` → PPPDV. Sekcijski prikaz obrasca.
  **Deklarativno — nula reverse-inženjeringa** (doc 18 §3.3).

## C — Mesečni PDV ciklus + PPPDV (`MonthlyVatCloseService` — knjigovođin gejt, doc 35 B2)
Workflow 8 koraka: (1) brisanje+reknjiženje auto naloga (IFR/IFGP/UFROB/UFMAT/TREB/ULGP) preko VatBookRun; (2) kontrole
izlaznih/ulaznih naloga; (3) USLRO→5012, TREB→5110, ULGP→9020/9600/9800; (4) **slaganje robno↔finansijski (RuC=0)**;
(5) **slaganje SEF↔BB** (16,66667% formula, filter datuma); (6) obračun **47−27−2790**. Kontrolni izveštaji po koraku
(razlike PDV faktura↔nalog, RuC≠0 lista). **PPPDV prijava** model + AOP agregacija iz POPDV. **Zaključavanje perioda**
(Faza-0 lock, posle predaje immutable).

## Redosled + Quick win
1. VatBookEntry/Run + TaxRateResolver. 2. VatPostingService (goods/service/ledger). 3. POPDV modeli + seed POPDV_DEF
+ engine. 4. Mesečni ciklus + PPPDV. **Quick win:** uknjiži jedan period → KIF/KUF izvoz → suma osnovica/PDV po grupi
(temelj za PDV prijavu).

## Odluke
- ✅ **Jedna VatBookEntry tabela sa book diskriminatorom** (KIF/KUF) — mi-tehnicki.
- ✅ **Effective-dated rate resolver** (ne hardkod pragovi) — mi-tehnicki.
- ✅ **POPDV = deklarativni POPDV_DEF + eval** (seed 164 reda) — mi-tehnicki.
- ⏳ **Validacija paralelnim vođenjem ≥1 pun period** (K1) — **Nesa/knjigovođa** (acceptance gejt — PDV prijava = BigBit
  do dinara).

## Rizici
- **PDV tačnost = zakonska odgovornost** → knjigovođa validira paralelno; ništa u prod bez toga.
- **Effective dating pogrešan** → retroaktivni obračuni greše; test na stvarnim R_Tarife granicama.
- **Idempotentnost uknjiženja** → parcijalni unique po (book, origin) sprečava dupli PDV red.

**Procena Faze 6:** ~5–8 AI-dana (+ mesečni ciklus workflow ~3–4).

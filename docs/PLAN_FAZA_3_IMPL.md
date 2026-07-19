# FAZA 3 — Robno / costing + nivelacija — IMPLEMENTACIONI DIZAJN (build-ready)

> **Datum:** 2026-07-19. Nadgradnja [PLAN_FAZA_3_robno-costing.md](PLAN_FAZA_3_robno-costing.md).
> Formule TAČNO iz [backend/docs/migration/39-robno-inventory-kalkulacija.md](../backend/docs/migration/39-robno-inventory-kalkulacija.md).
> Preduslov: Faza 2 (`JournalEntry`/`LedgerEntry` + `PostingEngineService`, [PLAN_FAZA_2_gl-jezgro.md](PLAN_FAZA_2_gl-jezgro.md)).
> Nacrt modela: [backend/prisma/_nacrt-4.0-faza3-robno.prisma](../backend/prisma/_nacrt-4.0-faza3-robno.prisma). **Ništa nije primenjeno.**
>
> **Odluka Nenad (18.07): radi se KAO BIGBIT** — jedna valuaciona cena po artiklu + nivelacija/uprosečavanje.
> **Costing = ponderisani prosek "u letu" (as-of), NE FIFO, BEZ perzistentne tabele stanja** (doc 39 §C).

---

## 0) Rezime odluka (šta je fiksirano ovim dizajnom)

| Tema | Odluka |
|---|---|
| Costing metod | **Ponderisani prosek as-of** iz kretanja (doc 39 §C). NE FIFO, NE LIFO. |
| Perzistentno stanje | **Nema** — stanje i cene se računaju u letu; `StockLevel` je samo opcioni keš. |
| Valuaciona cena | **Jedna po artiklu** (`ItemValuation`, overlay), nivelacija je održava. |
| Nivelacija | **AUTO uprosečavanje pri ulazu** (MUST) + ručna „Nivelacija zaliha" ostaje precrtana. |
| goods_documents vlasništvo | **Ostaje sync-cache** — 2.0 piše u NOVE `stock_documents` (v. §e). |
| Float→Decimal | Nove tabele su Decimal od starta; legacy goods_document(_item) migracija = aditivna+swap, van ovog nacrta. |

---

## a) Robni dokument — modeli (ulaz / izlaz / nivelacija / međuskladišnica)

Jedan model `StockDocument` + `StockDocumentItem` (2.0-owned, sve Decimal). Smer i GK šemu vozi
`DocumentType` (postojeći sync-cache: `affectsStock`, `isInbound`, `postingTemplate`, `kepuDefault*`) —
isto vozilo kao legacy `R_Vrste_dokumenata`. `kind` diskriminator:

- **`UL`** — prijem/ulaz (domaći ili uvoz `isImport=true`). Zadužuje magacin. Okida kalkulaciju (landed).
- **`IZ`** — izdavanje/izlaz. Razdužuje magacin po **prosečnoj** ceni (trošak = as-of prosek).
- **`NIV`** — nivelacija: revalorizacija zatečenog stanja (header nema kol. kretanje, nosi `StockLevelingItem` parove).
- **`PRENOS`** — međuskladišnica: `warehouseId`(izvor) → `targetWarehouseId`(odredište); izlaz iz jednog + ulaz u drugi po prosečnoj ceni izvora.
- **`VISAK` / `MANJAK`** — iz popisa (§d), knjiže se kao robni ulaz (manjak = negativna količina).

Landed-cost slog stavke (`StockDocumentItem`) preslikava doc 39 §A: `purchasePriceNet`(A), `dependentCostOwn`(B, ZTsop),
`dependentCostSupplier`(C, ZTdob), `calculatedWholesalePrice`(KalkVP), `calculatedRetailPrice`(KalkMP),
`actualWholesalePrice/RetailPrice`(Stvarna, transakciona), `excise`(Akciza), `fee`(Taksa), `fixedTax`,
`fxPurchasePrice`(DevNabCena), `customsRate`(CarStopa). Header uvoza: `customsExchangeRate`(CarKurs),
`accountingExchangeRate`(ObrKurs), `fxInvoiceValue`(DevVredFak), `customs`, `forwarding`, `customsRefundBase`(PovCarOsn).

### CalculationService.calculate(docId) — landed cost (doc 39 §A, verbatim)

**Domaća kaskada** po stavci (doc 39 §A, `SracunajKalkulaciju`):
```
NabNeto = Fakturna − Rabat − Kasa            (purchasePriceNet, A)
KalkVP  = NabNeto + ZTsop + ZTdob + RuC + Akciza
KalkMP  = Taksa + FiksniPorez + KalkVP*(1 + ΣStopa/100)
RuC     = KalkVP − NabNeto − ZTsop − ZTdob − Akciza      (definicija)
```
Kad se roba vodi po nabavnoj (Mag.VP = Nab.cena) → operater ne unosi maržu → **RuC = 0** i `KalkVP = A+B+C+Akciza`.

**Uvoz — ZT raspodela po JM** (doc 39 §A, `Module__UVOZ`, ključ `DevNabCena/DevVredFak`):
```
carosnjm     = DevNabCena*CarKurs + (PovCarOsn/DevVredFak)*DevNabCena     ' carinska osnovica/JM
carinajm     = carosnjm * (CarStopa/100)
brutonabcena = DevNabCena*(brutonabvred/DevVredFak) + carinajm            ' pun landed cost/JM
```
tako da `NabNeto + ZTsop + ZTdob = brutonabcena`. **CarKurs** za carinsku osnovicu, **ObrKurs** za
knjigovodstvenu nabavnu; razlika kurseva → ZTsop. Doc-level `customs/forwarding/otherDependentCosts`
raspoređeni **proporcionalno vrednosti stavke** (odluka §Odluke T1, potvrda Tatjana da li za neke robe po kg).

Sve u `$transaction`, `Prisma.Decimal`, zaokruživanje na 4 decimale tek pri upisu. Invarijanta testa:
`Σ Kol*(KalkVP − NabNeto − ZTsop − ZTdob − Akciza) = 0` (ukalkulisana RuC = 0).

---

## b) COSTING — ponderisani prosek as-of + nivelacija (formula iz doc 39, TAČNO)

### CostingService.averageAsOf(itemId, warehouseId, asOf)

Ponderisana prosečna **iz kretanja** (raw SQL, UNION legacy `goods_documents/items` + native `stock_documents/items`),
doc 39 §C (`KLProsecnaVPCenaZalihaNaDan1Korak.sql`):

```
ProsecnaKalkVPCena = Σ(±Kol * KalkVP)            / Σ(±Kol)
ProsecnaNabCena    = Σ(±Kol * (NabNeto+ZTsop+ZTdob)) / Σ(±Kol)
```

- Znak `±Kol`: `+` za ulaz, `−` za izlaz (iz `DocumentType.isInbound`/`affectsStock`).
- Filtri: `documentDate ≤ asOf`, `warehouseId`, **`documentType <> KODJ` izuzet**.
- `Σ(±Kol) = 0` (stanje 0) → **fallback poslednja cena** (poslednji ulaz KalkVP/Nab).
- Prekidač `Warehouse.averagePrices = false` → **poslednja KalkVP umesto proseka** (magacin bira).
- **Bez perzistentne tabele stanja** — `StockLevel` je samo opcioni denormalizovani keš; izvor istine je ovaj upit.

**Na izlazu (`IZ`):** trošak = prosek (`NabNeto=ProsecnaNab`, `KalkVP=ProsecnaVP`); `Stvarna VP/MP` = prodajna
(transakciona). **Kalkulativna = knjigovodstvena, Stvarna = transakciona → ostvarena RuC = Stvarna − Kalkulativna**
(marža realizacije, doc 39 §C).

Indeksi (perf, PLAN_FAZA_3 §Rizici): `(item_id, warehouse_id)` i `(document_date, warehouse_id, document_type)`
— oba prisutna u nacrtu na `stock_document_items` / `stock_documents`.

### Nivelacija = uprosečavanje — VERIFIKOVANA formula (doc 39 §F)

> doc 39 §F: **„Nivelacija mora da se radi kao u BigBitu — moraju se uprosečiti cene, jer ista roba ima
> različite cene i zavisne troškove uvoza."** Vrsta `NIV` (`UticeNaZalihe=True`); prag `|Stara−Nova|≥0.01`
> (`Module__Nivelacija.OdrediNeproknjizeneNivelacijeZaliha`). **Uprosečavanje = ponderisana prosečna (§C) kao osnov nove cene.**

Nova cena je ponderisani prosek zatečenog stanja i novog ulaza (ISTI oblik kao §C costing prosek — nije izmišljena):

```
novaVP = (stanjeKol * staraVP + ulazKol * ulaznaVP) / (stanjeKol + ulazKol)
```
i analogno za `NabNeto`, `ZTsop`, `ZTdob`, `MP`. Gde:
- `stanjeKol` = as-of stanje pre ulaza (`CostingService` / `StockLevel.onHand`),
- `staraVP` = trenutna valuaciona cena artikla (`ItemValuation.valuationWholesalePrice` = BigBit `R_Artikli.VP`),
- `ulazKol` / `ulaznaVP` = količina i `KalkVP` nove ulazne stavke.

(Dvočlana ponderisana sredina je specijalni slučaj `Σ(±Kol*cena)/Σ(±Kol)` sa dva člana: zatečeno stanje + novi
ulaz — dakle identična costing formuli iz doc 39 §C, samo primenjena inkrementalno pri ulazu.)

---

## c) Kako nivelacija upisuje novu prosečnu cenu i knjiži razliku

`NivelacijaService` (poziva se iz `CalculationService` na kraju kalkulacije ulaza, u istom `$transaction`):

1. Za svaku stavku ulaza: `stanjeKol = CostingService.stateAsOf(itemId, warehouseId, docDate)`.
2. **Ako `stanjeKol = 0`** → nema šta da se uprosečava → `ItemValuation` se prosto prepiše novim ulaznim cenama
   (doc 39 §A: `Zalihe=0 → upiši nove cene`). Nema NIV dokumenta.
3. **Ako `stanjeKol > 0` i `|ulaznaVP − staraVP| ≥ 0.01`** → **AUTO nivelacija**:
   a. Izračunaj `novaVP` (i NabNeto/ZTsop/ZTdob/MP) po formuli §b.
   b. **Update `ItemValuation`** na uprosečene (`nova*`) cene — to je nova jedinstvena valuaciona cena artikla.
   c. Kreiraj **`NIV` StockDocument** (`kind='NIV'`, `linkedInboundDocId` = izvorni `UL`) + po jedan
      **`StockLevelingItem`** par (`old*` = pre-ulaz `ItemValuation`, `new*` = uprosečeno),
      `quantityRevalued = stanjeKol`, `valueAdjustment = stanjeKol * (novaVP − staraVP)`.
   d. `StockLevelingItem` **revalorizuje zatečeno stanje** sa stare na novu cenu (doc 39 §F).
4. **Knjiženje razlike (GK):** NIV dokument okida Faza-2 `PostingEngineService` (v. §d). `valueAdjustment > 0`
   (poskupljenje) → zaduži zalihu (`1320`) / razduži revalorizacionu protivstavku; `< 0` obrnuto. Zbir
   `Σ valueAdjustment` mora balansirati (Faza 2 balans-kontrola). `isPosted=true` po knjiženju.

> Prag 0.01 sprečava beskonačne mikro-nivelacije od zaokruživanja. Ručna „Nivelacija zaliha" iz menija
> **ostaje precrtana** (BB_T_26 §4) — automatska pri ulazu je jedina aktivna (doc 39 §F).

---

## d) Veze: Nabavka prijem → robni ulaz; robni dokument → Faza 2 GL

### Nabavka (Traka B) → robni ulaz
`PurchaseOrderItem.receivedQuantity` (BigBit `IsporucenaKolicina`) je već u šemi (schema:2646). Pri prijemu:
- `RobnoService.createInboundFromPurchaseOrder(poId)` kreira `StockDocument(kind='UL', purchaseOrderId=poId)`
  sa stavkama iz `PurchaseOrderItem` gde `receivedQuantity > 0` (`quantity = receivedQuantity`,
  `invoicePrice = unitPrice`, `itemId = articleId`).
- Anti-duplo guard (doc: „IDStavkeTrebovanja Is Null") → jedna PO stavka daje najviše jedan robni ulaz;
  `linkedInboundDocId` / `purchaseOrderId` čuvaju traceback (3-way match: naručeno/primljeno/fakturisano;
  fakturisano dolazi iz Faze 5).
- Meki ref (bez @relation) jer je cross-modul; validacija postojanja PO u servisu.

### Robni dokument → Faza 2 GL (doc 39 §E, šeme 3/32/33/34)
`RobnoService` po kalkulaciji/knjiženju poziva `PostingEngineService.postFromStockDocument(docId)`
(pandan `postFromGoodsDocument` iz Faze 2). Kontekst kolona A–Z se agregira iz `StockDocumentItem`
(A=NabNeto, B=ZTsop, C=ZTdob, O=StvarnaVP, …). GK šeme (doc 39 §E):
- **UFROB (šema 3):** `1320 Dug = A+B+C` (zaliha po **nabavnoj/landed**, BEZ RuC), `2700/2710 Dug = D/E`, `4350 Pot = A+B+C+D+E`.
- **UFMAT (34):** `1010 Dug = A` (materijal po nabavnoj).
- **IFR (33):** `2040 Dug = O+P+Q`, `6040 Pot = O`, `4702/4710 Pot = P/Q`, `1320 Pot = A` (razduženje), `5010 Dug = A` (COGS). **Marža = 6040 − 5010 = Stvarna − Kalkulativna.**
- **UVOZ (32):** `1320 Dug = A`, `2740 Dug = D`, `4360 Pot = A` (doc 39 §E; PLAN_FAZA_3 navodi 4350/2740 — uskladiti sa kontnim planom, Kapija 0 K2).

**RuC = 0 na strani zalihe** jer `1320 = A+B+C` (landed) — zaliha ide po nabavnoj, ukalkulisana RuC u magacinu = 0
(doc 39 §B, „Mag.VP = Nab.cena"). Nivelacija drži **jednu** cenu → nema drifta zaliha↔GK.
`journalEntryId` na `StockDocument` je meki ref na Faza-2 nalog (traceback). Idempotentnost: PostingEngine
proverava postoji li nalog sa `sourceStockDocId=docId` (kao Faza 2 guard po sourceGoodsDocId).

### KEPU (regulatorno, doc 39 §E)
`KepuService` puni `KepuBookEntry` iz `StockDocument` preko `DocumentType.kepuDefaultCharge/Discharge`:
`MagUlaz = Kol*(KalkVP+Taksa)`, `MagStvarniIzlaz = Kol*(StvarnaVP+Taksa)`. Rekoncilijacija robno↔KEPU.

---

## e) B1 — da li goods_documents ostaje sync-cache ili postaje 2.0-owned

**Nalaz (verifikovano nad kodom):**
- `sync-map.generated.ts:3081` mapira `T_Robna dokumenta → goods_documents`, `:3506` `T_Robne stavke → goods_document_items`.
  Dodatno postoje odvojene mirror tabele `goods_documents_mirror`/`goods_document_items_mirror` (:2980/:3013) za PDM/MRP sync.
- `table-ownership.ts`: `goods_documents` **NIJE** u `OWNED_PRODUCTION_TABLES` ni u `QBIGTEHN_CHAIN_ENTITIES`
  → tretira se kao **PERMANENT BigBit master-data sync** (komentar table-ownership.ts:88–92 eksplicitno
  navodi „goods documents" među BigBit-hranjenim tabelama koje vasa-SQL nastavlja da puni posle cutover-a).
- `GoodsDocumentItem` iznosi su **Float** (netačno za novac/costing).

**Zaključak:** `goods_documents` **jeste aktivna sync-cache** (ranija tvrdnja „2.0 ih vlasnički piše" je NETAČNA,
review B1). Faza 3 **NE SME pisati u njih** dok se ne reši vlasništvo (Kapija 0 B1).

**PREPORUKA (ovaj dizajn): opcija A — 2.0-native paralelne tabele, legacy ostaje read-only cache.**
- Novi robni tok (UL/IZ/NIV/PRENOS/popis) piše u **`stock_documents`/`stock_document_items`** (2.0-owned, Decimal).
- `goods_documents` ostaje netaknut BigBit sync-cache (istorijski podaci); costing ga čita zajedno sa
  native dokumentima kroz **UNION as-of upit** (isti oblik, mapirane kolone; Float legacy vrednosti se
  castuju na Decimal u SQL-u — čitanje, ne pisanje).
- Prednost: **nula rizika po sync** (ne diramo cache, ne treba izbaciti iz SYNC_MAP), Decimal ispravnost od
  starta, čist cutover (kad BigBit robno ugasne, legacy tabela postane samo arhiva).
- Alternativa B (izbaci iz SYNC_MAP + preseli goods_documents u 2.0-owned + Float→Decimal aditivna+swap) je
  invazivnija i vezuje Fazu 3 za gašenje BigBit robnog; **ne preporučuje se za start** — može kasnije, kad se
  BigBit robno tok ugasi (tada se native tabele proglase jedinim izvorom, legacy ostane arhiva).

> **Kapija 0 B1 (blokira pisanje):** potvrditi opciju A sa Negovanom/Nesom. Do potvrde: samo `stock_*` tabele,
> `goods_documents` read-only. **Ovaj dizajn NE menja schema.prisma i NE dira sync mapiranje.**

---

## Redosled gradnje
1. **Modeli** (`_nacrt-4.0-faza3-robno.prisma` → schema.prisma) + migracija + rename-map + seed `NIV`/`PRENOS` DocumentType.
2. `CalculationService` (domaća kaskada + uvoz ZT raspodela).
3. `CostingService.averageAsOf` (UNION as-of, KODJ izuzet, fallback poslednja).
4. `NivelacijaService` + `StockLevelingItem` (auto uprosečavanje).
5. `LagerService` (stanje as-of + prosečna/poslednja + rezervacije + `|VPC−ProsecnaKalkVP|≥0.01` flag; negativne zalihe).
6. Popis (`InventoryCount(_Item)` — predpunjenje→unos→razlika→knjiženje VISAK/MANJAK).
7. GK kontiranje robnog (`postFromStockDocument`, šeme 3/32/33/34) + `KepuService` + rekoncilijacija.

**Quick win:** jedan `UL` (uvoz) → kalkulacija (landed, ZT raspodela) → costing prosek → GK `1320/4350` sa RuC=0,
vidljivo u lageru i Kartici konta; drugi ulaz po drugoj ceni → AUTO nivelacija (uprosečavanje + NIV nalog razlike).

## Odluke
- ✅ Costing = ponderisani prosek as-of, NE FIFO (doc 39 §C) — Nenad/mi-tehnicki.
- ✅ Nivelacija/uprosečavanje kao BigBit (formula doc 39 §F, verifikovana) — Nenad (18.07).
- ✅ Bez perzistentne tabele stanja; `StockLevel` opcioni keš — mi-tehnicki.
- ✅ `goods_documents` ostaje sync-cache; native `stock_documents` (opcija A) — **preporuka, potvrda Kapija 0 B1**.
- ⏳ Landed-cost ključ raspodele po vrednosti stavke (Module__UVOZ) — potvrda Tatjana (T1: da li kg za neke robe).
- ⏳ Kontni plan / brojevi konta u šemama (32: 4360 vs 4350) — Nesa/knjigovođa (Kapija 0 K2).

## Rizici
- **goods_documents pisanje pre B1 potvrde** → mitigacija: samo `stock_*` tabele, legacy read-only (opcija A).
- **Zaliha↔GK drift** → RuC=0 (1320=landed) + nivelacija drži jednu cenu; kontrole (ukalkulisana/ostvarena RuC) odmah otkrivaju.
- **Costing as-of performans** → indeksi `(item_id, warehouse_id)`, `(document_date, warehouse_id, document_type)`.
- **Float legacy u UNION as-of** → cast ::numeric u SQL-u (čitanje); native tabele Decimal od starta.

**Procena Faze 3:** ~20–27 AI-dana (nepromenjeno).

# FAZA 3 — Robno / costing + nivelacija (implementacioni dizajn, build-ready)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Verifikovano nad kodom.
> Preduslov: Faza 2 (GL kontiranje). **Odluka Nenad: radi se KAO BIGBIT** (jedna valuaciona cena + nivelacija/uprosečavanje).

## Stanje
`GoodsDocument`/`GoodsDocumentItem` nose **sve** landed-cost kolone (purchasePriceNet, dependentCostOwn=ZTsop,
dependentCostSupplier=ZTdob, calculated/actual VP/RP, excise, customs, forwarding, fx*) — **ali sve `Float`**
(netačno za novac). `Item` (VP/MP Float), `Warehouse.averagePrices` (prekidač), `DocumentType.isInbound/kepuDefault*`,
`MrpItemStock` (samo snapshot). **Nema** costing/kalkulacija/nivelacija logike.

> 🔴 **ISPRAVKA (review B1):** ranija tvrdnja „goods_documents NISU sync-cache → 2.0 ih vlasnički piše" je **NETAČNA** —
> `sync-map.generated.ts:3079/3505` mapira T_Robna dokumenta→goods_documents i table-ownership ih drži kao BigBit-hranjene.
> **Faza 3 NE sme pisati u njih dok se ne reši vlasništvo (Kapija 0 B1)** — ili izbaciti iz SYNC_MAP + preneti u 2.0, ili
> overlay/dual-key. Float→Decimal migracija (dole) mora biti **aditivna+swap, PRE prvog knjiženja** (review B4), ne in-place ALTER.

## Dizajn — modul `src/modules/robno/` (nazivi doc 38: Primka/Zalihe/Nivelacija)

### Migracija Float→Decimal (KRITIČNO, prvo)
Sve iznosne kolone → **Decimal(19,4)**, količine → **Decimal(19,6)**, kursevi → Decimal(19,6), na
`goods_document_items`, `goods_documents`, `items`, `price_list_entries`. Ručni SQL `USING kolona::numeric(x,y)`
(sačuvati podatak). Verifikacija: kontrola ukalkulisane RuC pre/posle — zaokruženje ne sme promeniti knjigovodstvene
sume iznad tolerancije.

### CalculationService.calculate(docId)
- **Domaća kaskada** po stavci: `nabavnaNeto=fakturna*(1-rabat/100)*(1-kasa/100)`; `KalkVP=nabavnaNeto+ZTsop+ZTdob+
  RuC+Akciza`; `KalkMP=Taksa+FiksniPorez+KalkVP*(1+ΣStopa/100)`; `RuC=KalkVP-nabavnaNeto-ZTsop-ZTdob-Akciza`.
- **Uvoz ZT raspodela po JM** (ključ `DevNabCena/DevVredFak`): `carosnjm=DevNabCena*CarKurs+(PovCarOsn/DevVredFak)*
  DevNabCena`; `carinajm=carosnjm*customsRate/100`; `brutonabcena=DevNabCena*(brutonabvred/DevVredFak)+carinajm` →
  `purchasePriceNet+ZTsop+ZTdob=brutonabcena`. **CarKurs** (customsExchangeRate) za carinsku osnovicu, **ObrKurs**
  (accountingExchangeRate) za knjigovodstvenu; kursna razlika→ZTsop. Doc-level customs/forwarding raspoređeni
  **proporcionalno vrednosti stavke**.
- Sve u `$transaction`, `Prisma.Decimal`, zaokruživanje 4 decimale tek pri upisu. Test invarijante:
  `Σ Kol*(KalkVP-NabNeto-ZTsop-ZTdob)=0` (ukalkulisana RuC=0).

### CostingService.averageAsOf(itemId, warehouseId, asOf)
Ponderisana prosečna **as-of iz kretanja** (raw SQL join goods_documents+items): `ProsecnaKalkVP=Σ(±Kol*KalkVP)/
Σ(±Kol)`, `ProsecnaNab=Σ(±Kol*(NabNeto+ZTsop+ZTdob))/Σ(±Kol)`; filtri `documentDate≤asOf`, warehouse, znak iz
`isInbound`, **KODJ izuzet**; Σ=0 → fallback poslednja cena. Prekidač `Warehouse.averagePrices=false` → poslednja
KalkVP umesto proseka. **Bez perzistentne tabele stanja** (BigBit princip). Na izlazu trošak=prosek; ostvarena
RuC=Stvarna-Kalkulativna.

### NivelacijaService (auto uprosečavanje — MUST, odluka Nenad)
Pri propagaciji cene u Item: ako as-of stanje=0 → upiši nove cene direktno; ako stanje>0 i `|ulaznaVP - Item.VP|≥0.01`
→ **AUTO nivelacija:** `novaVP=(stanjeKol*staraVP+ulazKol*ulaznaVP)/(stanjeKol+ulazKol)` (i NabNeto/ZTsop/ZTdob/MP),
update Item na uprosečenu cenu + kreiraj **NIV GoodsDocument** (`documentType='NIV'`) + **`StockLevelingItem`** par
(stara/nova, `valueAdjustment=stanjeKol*(novaVP-staraVP)`) koji revalorizuje zatečeno stanje. Prag 0.01.

### Novi model + seed
- **`StockLevelingItem`** (`/// Was: StavkeNivelacije`): goodsDocumentId(NIV), itemId, warehouseId, quantityRevalued,
  old/new (PurchaseNet/DependentOwn/Supplier/VP/MP), valueAdjustment, isPosted. Header = GoodsDocument `NIV`.
- Nove valuacione kolone na `Item`: valuationPurchaseNet/DependentOwn/DependentSupplier (osnov za parove).
- Seed DocumentType `NIV` (affectsStock); potvrditi da KODJ/ne-stanje tipovi imaju flag za izuzimanje.

## Lager + Popis + RuC (komponenta 2)
- **LagerService:** stanje as-of po (magacin,artikal) + poslednja/prosečna cena + rezervacije (slobodno=kol-rez) +
  flag nekonzistentnosti (`|VPC-prosecnaKalkVP|≥0.01`); negativne zalihe; API+FE lager lista.
- **Popis:** modeli `InventoryCount`+`InventoryCountItem` (KolKng/KolPop/cena); tok predpunjenje→unos→razlika→
  knjiženje viška/manjka (VISAR/MANJR → robni ulaz + Faza-2 posting 6740/5740, preko carry-over).
- **RuC kontrole:** ukalkulisana (ulaz=0), ostvarena (izlaz marža), neispravna kartica (vrednost bez količine).

## GK kontiranje robnog + KEPU (komponenta 3)
- Robni dokument okida **Faza-2 PostingEngine** (UFROB 1320=A+B+C/4350; UFMAT 1010=A; IFR 2040/6040/5010/1320;
  UVOZ 4630/4350/2740). **RuC=0** jer zaliha ide po nabavnoj (1320=A+B+C landed).
- **KEPU** (regulatorno): model `KepuBookEntry` (magacin, zaduženje/razduženje, iznos) + `KepuService` (puni iz
  robnih dok preko `kepuDefault*`; MagUlaz=Kol*(KalkVP+Taksa), MagStvarniIzlaz=Kol*(StvarnaVP+Taksa)); rekoncilijacija
  robno↔KEPU. Veza sa Faza-4 saldakonti (otvorene stavke 4350).

## Redosled + Quick win
1. **Float→Decimal migracija** (PRE svega). 2. Calculation. 3. Costing. 4. Nivelacija + StockLevelingItem. 5. Lager.
6. Popis. 7. GK kontiranje + KEPU. **Quick win:** jedan ulaz robe → kalkulacija (landed) → costing prosek → GK
1320/4350 sa RuC=0, vidljivo u lageru i Kartici konta.

## Odluke
- ✅ **Landed-cost ključ raspodele = po vrednosti stavke** (kako Module__UVOZ radi) — preporuka; **potvrditi Tatjana**
  (T1) da li kg za neke robe.
- ✅ Float→Decimal migracija (§2) — mi-tehnicki.
- ✅ Nivelacija/uprosečavanje kao BigBit — Nenad (odlučeno).
- ✅ Bez perzistentne tabele stanja — mi-tehnicki.

## Rizici
- **Float→Decimal na postojećim redovima** → zaokruženje; mitigacija: `USING ::numeric`, verifikacija suma pre/posle.
- **Zaliha↔GK drift** → RuC=0 obezbeđeno GK šemom (1320=landed) + nivelacija drži jednu cenu; kontrole odmah otkrivaju.
- **Costing as-of performans** → indeksi na (item_id, warehouse_id) i (document_date, warehouse_id, document_type).

**Procena Faze 3:** ~20–27 AI-dana.

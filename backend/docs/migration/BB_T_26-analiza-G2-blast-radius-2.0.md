# BB_T_26 analiza — G2: Blast radius master ID-eva u ServoSync 2.0

> Deo G-serije (priprema Faze 2: direktan BigBit→PG sync za 5 mastera — Komitenti,
> Predmeti, R_Artikli, Cenovnik, Magacini). Pitanje: **kako 2.0 danas koristi
> `items.id` i ostale master ključeve, i šta tačno puca ako `items.id` pređe na
> BigBit šifru.** Brojevi redova su iz prod PG (servosync-pg, 2026-07-12).

---

## TL;DR

1. **`items.id` = QBigTehn lokalni IDENTITY, kopiran verbatim** iz `R_Artikli.[Sifra artikla]`
   (IDENTITY(1,1), `qbigtehn_sqlserver.sql:6499`; mapiranje `sync-map.generated.ts:2657–2661`).
   BigBit šifra ide SAMO u `items.external_item_id` ← `[BBSifra artikla]`
   (`sync-map.generated.ts:3126–3127`; kolona postoji samo u kopiji, `qbigtehn_sqlserver.sql:6566`, default 0 `:7575`).
2. **Prelaz `items.id` → BigBit šifra menja ključ na 90.986 od 92.357 artikala (100% mapiranih,
   `id ≠ external_item_id` u svim slučajevima)** i — kritično — **57.998 BigBit šifri kolidira sa
   postojećim lokalnim id-jevima DRUGIH artikala** (opsezi se preklapaju: lokalni 1..93359,
   BigBit 17048..127472). In-place `UPDATE` je nemoguć bez dvofazne migracije, a svaka
   neremapovana meka referenca ne puca — nego **ćutke pokazuje na pogrešan artikal**.
3. **Proizvodni lanac (tech_processes, work_orders, operations, drawing_\*) NE referiše `items.id`.**
   Vezuje se preko stringova (`drawing_number`, `catalog_number`, `material`, `ident_number`) i preko
   `projects.id`/`customers.id`. Jedini tvrdi FK proizvodnje ka `items` je
   `work_order_item_components.item_id` (1.027 redova). Promena item ključa NE dira RN/TP/barkod tok.
4. **`customers.id` je već de facto BigBit ID prostor** — svih 36.753 `work_orders.external_customer_id`
   (← `tRN.BBIDKomitent`) rezolvira na `customers.id`; QBigTehn-ove sopstvene procedure join-uju
   `Komitenti.Sifra = tRN.BBIDKomitent` (`qbigtehn_sqlserver.sql:552`). Za Komitente Faza 2 može
   zadržati ključ bez remapa.
5. **Cenovnik i Magacini imaju blast radius 0 danas** — `price_list_entries` i `warehouses` u prod imaju
   0 redova. Ali: prostor za `price_list_entries.item_id` mora biti odlučen PRE nego što ih Faza 2 napuni.
6. **Preporuka: NE menjati `items.id`.** Faza 2 upsert-uje po `items.external_item_id` (u prod bez
   duplikata za vrednosti > 0 — treba ga formalizovati parcijalnim unique indeksom). Alternativa
   (promena ključa) povlači dvofaznu migraciju + gašenje/remap QBigTehn sync-a + remap 6 tabela.

---

## 1. Kako se `items.id` DODELJUJE danas (sync mehanika)

| Činjenica | Dokaz |
|---|---|
| `items.id` ← `R_Artikli.[Sifra artikla]` (isId: true), bez ikakvog remapa | `backend/src/modules/sync/sync-map.generated.ts:2657–2661` |
| `[Sifra artikla]` je u QBigTehn kopiji `int IDENTITY(1,1)` — lokalni surogat, NE BigBit šifra | `_analiza/qbigtehn_sqlserver.sql:6499` |
| `items.external_item_id` ← `[BBSifra artikla]` — jedini most ka BigBit prostoru | `sync-map.generated.ts:3126–3127`; DDL `qbigtehn_sqlserver.sql:6566`, `DF_R_Artikli_BBSifraArtikla` default 0 `:7575` |
| GenericSyncer kopira PK verbatim: full_refresh = `deleteMany` + `createMany` (id iz izvora), incremental = `upsert({ where: { id } })` | `backend/src/modules/sync/generic.syncer.ts:101–105` (upsert), `:127–140` (wipe+bulk, `session_replication_role='replica'`) |
| `external_item_id` u Prisma šemi: `Int @default(0)`, **bez unique indeksa** | `backend/prisma/schema.prisma:835` |
| Isti obrazac za ostale mastere: `customers.id` ← `Komitenti.Sifra` (`sync-map:478–482`; ručni syncer `customer.syncer.ts:65–66`), `projects.id` ← `Predmeti.IDPredmet` (`sync-map:2138–2142`), `warehouses.id` ← `Magacini.IDMagacin` (`sync-map:1196–1200`), `price_list_entries.id` ← `Cenovnik.ID` + `itemId` ← `Cenovnik.[Sifra artikla]` (`sync-map:335–343`) | navedene linije |

Posledica: **dok god QBigTehn MSSQL sync radi, on je vlasnik `items.id`** — svaka promena ključa u
PG biće pregažena sledećim full_refresh-om (`deleteMany` + insert sa izvornim `Sifra artikla`).
Promena ključa zahteva prethodno gašenje item sync-a ili remap sloj u synceru.

## 2. Inventar FK kolona po masteru (schema.prisma) + živi redovi (prod, 2026-07-12)

### 2.1 → `items.id`

**Tvrdi FK (DB constraint):**

| Kolona | Constraint | Dokaz (schema.prisma) | Redova u prod |
|---|---|---|---|
| `price_list_entries.item_id` | `fk_price_list_entries_items` | :109, :119 | **0** |
| `work_order_item_components.item_id` | `fk_work_order_item_components_item` | :1559, :1563 | **1.027** (svi rezolviraju po `items.id`; samo 994 bi „pogodilo" nešto po BigBit prostoru → 33 reda bi visila) |

Napomena: i u QBigTehn kopiji `tRNNDKomponente.SifraArtikla` ima tvrdi FK ka `R_Artikli`
(`FK_tRNNDKomponente_R_Artikli`, `qbigtehn_sqlserver.sql:8336–8337`) — dakle vrednosti su
dokazano u LOKALNOM prostoru. Isto i `Cenovnik_FK00` (`:8097–8098`).

**Meke reference (kolona bez DB FK — ne pucaju, ćutke promašuju):**

| Kolona | Dokaz (schema.prisma) | Izvor vrednosti | Redova u prod (item_id > 0) |
|---|---|---|---|
| `mrp_item_stock.item_id` — **PK tabele!** | :441 | `MRP_StanjeArtikala.SifraArtikla` (`sync-map:1083,1088–1092`) | **36** (28 rezolvira, 8 orphan) |
| `mrp_demand_items.item_id` | :416 | `MRP_PotrebeStavke` (`sync-map:912`) | **36** (28 rezolvira) |
| `mrp_item_stock_tmp.item_id` (PK) | :454 | isto | 0 |
| `drawing_plan_items.item_id` | :343 | `PDM_PlaniranjeStavke.SifraArtikla`, kopira se verbatim kao soft ref (`drawing-plan-item.syncer.ts:81`) | 0 |
| `goods_document_items.item_id` | :1119 | `T_Robne_stavke` | 0 |
| `goods_document_items_mirror.item_id` | :999 | `RobneStavkeMirror` (`sync-map:3953`) | 0 |
| `work_orders.material_id` | :1501 | `tRN.IdentMaterijala` (`sync-map:5962–5963`; DDL `qbigtehn_sqlserver.sql:1674`) | **0** (neiskorišćeno) |
| `items.supplier_id` (ka komitentu-dobavljaču, default 1) | :806 | `R_Artikli` | 0 sa vrednošću > 1 |

**Aplikativna upotreba `items.id`:** MRP batch-resolve artikala po id (`mrp.service.ts:225–242,
:385–:416`; PK `mrp_item_stock` je `itemId`, komentar `mrp.service.ts:404`); work-orders detail
uključuje `itemComponents` (`work-orders.service.ts:179`) i briše ih pri brisanju RN (`:717`).
Nema zasebnog items REST kontrolera (pregled kontrolera: `@Controller` grep — auth, directory,
lookups, mrp, part-locations, notifications, handovers, pdm, reversi, structures/*, sync,
tech-processes, work-orders) — `items.id` izlazi napolje kroz MRP odgovore i RN komponente.

### 2.2 → `customers.id`

| Kolona | Tip veze | Dokaz | Redova u prod |
|---|---|---|---|
| `customers.driver_id` (self-FK) | tvrdi `fk_customers_driver` | schema.prisma:222 | — |
| `projects.customer_id` | meka | schema.prisma:687 | 7.480 > 0; **7.478 rezolvira** (2 orphan) |
| `work_orders.external_customer_id` | meka | schema.prisma:1492; ← `tRN.BBIDKomitent` (`sync-map:5899–5900`; DDL `:1665`) | 36.753 > 0; **36.753 rezolvira (100%)** |
| `goods_documents.customer_id` (+ `driver_id`, `contact_person_id`) | meka | schema.prisma:1059 | 0 (tabela prazna) |
| `mrp_demand_items.supplier_id` | meka | schema.prisma:430 | — (36 stavki ukupno) |
| `projects.foreign_supplier_id` | meka | schema.prisma:707 | — |

Aplikativno: filter RN po komitentu ide na `externalCustomerId` (`work-orders.service.ts:109`);
štampa RN rezolvira `customer.findUnique({ where: { id: wo.externalCustomerId } })`
(`work-order-print.service.ts:43–45`); kreiranje RN iz primopredaje upisuje
`externalCustomerId: ctx.project.customerId` (`handovers.service.ts:983`); TP štampa ide
project → customer (`tech-processes.service.ts:2714–2722`); javni API `directory/customers/:id`
(`directory.controller.ts:35–43`).

**Ključni nalaz:** `tRN.BBIDKomitent` („BB" = BigBit ID) rezolvira 100% na `customers.id`, a QBigTehn
procedure join-uju `Komitenti.Sifra = tRN.BBIDKomitent` (`qbigtehn_sqlserver.sql:552, 2063, 5497…`)
→ **QBigTehn kopija Komitenti čuva ORIGINALNE BigBit šifre** (IDENTITY je punjen uz očuvanje
vrednosti), pa je `customers.id` u 2.0 već BigBit prostor. Za Komitente prelaz na BigBit ključ je
no-op po vrednostima. (Opseg `customers.id` 0..1006059 — daleko iznad broja redova 6.244 — dodatno
potvrđuje da to nije gusti lokalni IDENTITY niz.)

### 2.3 → `projects.id`

| Kolona | Tip veze | Dokaz | Redova u prod |
|---|---|---|---|
| `handover_drafts.project_id` | tvrdi `fk_handover_drafts_projects` | schema.prisma:516 | 339 |
| `part_locations.project_id` | tvrdi `fk_part_locations_project` | schema.prisma:1359 | 7.007 |
| `work_orders.project_id` | meka; **deo poslovnog identiteta** `@@unique(projectId, identNumber, variant)` | schema.prisma:1489, :1538 | **40.614** (svi > 0) |
| `tech_processes.project_id` | meka; deo istog trojnog ključa | schema.prisma:1675 | **97.694** (svi > 0) |
| `work_time_entries.project_id` | meka | schema.prisma:1709 | 4 |
| `drawing_plans.project_id` | meka | schema.prisma:318 | 6 |
| `mrp_demands.project_id` | meka | schema.prisma:391 | 0 |
| `goods_documents.project_id` | meka | schema.prisma:1081 | 0 |

**`projects.id` ulazi u RNZ/RN barkod** (`formatOrderBarcode({ projectId, identNumber, variant, revision })`,
`tech-processes.service.ts:2727–2732`) — promena projektnog ključa invalidira odštampane barkodove.
Ukupna izloženost `projects.id`: **~145.700 redova** — NAJVEĆI blast radius od svih mastera.
`Predmeti.IDPredmet` je u kopiji IDENTITY (`qbigtehn_sqlserver.sql:1732`) i **nema BB\* kolonu** —
da li vrednosti odgovaraju BigBit `Predmeti.IDPredmet` ne može se dokazati iz DDL-a (proveriti
poređenjem podataka u G3; BigBit ima istoimenu tabelu, `BB_T_26_schema.sql:858–860`).

### 2.4 → `price_list_entries.id` i → `warehouses.id`

- **`price_list_entries`**: niko ne referiše `price_list_entries.id`; tabela u prod ima **0 redova**
  (Cenovnik nije napunjen). `Cenovnik.ID` je lokalni IDENTITY (`qbigtehn_sqlserver.sql:6190`), a
  `Cenovnik.[Sifra artikla]` FK-uje na LOKALNU šifru artikla (`Cenovnik_FK00`, `:8097–8098`).
  Blast radius danas = 0, ali **`item_id` prostor buduće Faze 2 zavisi od odluke o `items.id`**.
- **`warehouses`**: nijedna Prisma relacija ne pokazuje na `Warehouse` (model bez back-relacija,
  schema.prisma:479–493). Meke kolone: `goods_documents.warehouse_id` (:1071),
  `goods_document_items.warehouse_id` (:1143), `goods_document_items_mirror.warehouse_id` (:1001),
  `document_types.default_warehouse_id` (:891) — sve tabele sa 0 živih redova; i sama `warehouses`
  ima **0 redova** u prod. Blast radius = 0; Faza 2 za Magacine slobodno bira ključ.

## 3. Proizvodni lanac: referiše li `items.id` ili šifru?

**Šifru/string, ne `items.id`.** Dokazi:

- `tech_processes` (tTehPostupak) nema NIJEDNU item kolonu — identitet posla je
  (`projectId`, `identNumber`, `variant`) + `workOrderId` + `workCenterCode`
  (schema.prisma:1672–1699).
- `work_orders` (tRN) nosi materijal i deo kao STRINGOVE: `drawingNumber`, `partName`,
  `material`, `materialDimension` (schema.prisma:1497–1504); jedina item-id kolona
  `material_id` (← `tRN.IdentMaterijala`) ima **0 redova > 0** u prod — mrtva.
- `operations` (tOperacije) su radni centri (`workCenterCode`), bez veze sa items
  (schema.prisma:1367–1384); `work_order_operations` vezuje se na njih String kodom (:1642).
- `drawing_*` (PDM): `drawings` identitet je `drawingNumber+revision` i `catalogNumber`
  (String, schema.prisma:254–257); komponente/sklopovi FK-uju drawing↔drawing.
  Jedina item veza je `drawing_plan_items.item_id` — meka i trenutno prazna (0 redova sa item_id).
- Jedini stvarni dodir proizvodnje sa items prostorom: `work_order_item_components`
  (tRNNDKomponente — spisak nestandardnih delova RN), 1.027 redova, tvrdi FK (schema.prisma:1563).

**Zaključak:** promena `items.id` NE dira RN/TP/operacije/PDM tok niti barkod lanac; pogađa
šifarničko-planski sloj (RN komponente, MRP, budući Cenovnik).

## 4. BLAST RADIUS — šta tačno puca ako `items.id` pređe na BigBit šifru

| # | Efekat | Obim | Način otkaza |
|---|---|---|---|
| 1 | Promena ključa na artiklima | **90.986 / 92.357** redova (100% mapiranih; `id ≠ external_item_id` u svih 90.986) | — |
| 2 | Artikli bez BigBit šifre (`external_item_id = 0`) | **1.371** | nemaju novi ključ → poseban opseg ili ostaju lokalni (mešani prostor!) |
| 3 | **Kolizija prostora**: BigBit šifra = lokalni id NEKOG DRUGOG artikla | **57.998** | in-place UPDATE nemoguć (PK sudar); neremapovana meka referenca posle migracije pokazuje na POGREŠAN artikal — tiha semantička korupcija, ne greška |
| 4 | Tvrdi FK remap | `work_order_item_components` **1.027** (+ `price_list_entries` 0) | bez remapa: FK violation pri migraciji; sa remapom po `external_item_id`: 33 reda bez pogotka (994/1.027 rezolvira po ext prostoru) |
| 5 | Meki remap | `mrp_item_stock` (PK!, 36), `mrp_demand_items` (36) | bez remapa: MRP pregledi vezuju pogrešne artikle (`mrp.service.ts` rezolvira po id) |
| 6 | Sync pregazi migraciju | ceo `items` | QBigTehn generic syncer (full_refresh `deleteMany`+insert; incremental upsert po id) vraća stari ključ — mora se ugasiti item sync ili ubaciti remap u syncer |
| 7 | API/klijenti | MRP odgovori, RN itemComponents | promenjeni id-jevi u odgovorima; nema perzistentnih 2.0-native referenci van tabela gore |
| 8 | Sequence | `items.id @default(autoincrement())` (schema.prisma:768) | posle bilo kakve intervencije `setval` mora iznad novog max (danas max id 93.359, max BigBit šifra 127.472) |

**Ne puca:** tech_processes (97.694), work_orders (40.614) osim komponenti, operacije, drawings,
primopredaje, barkod lanac — ništa od toga ne drži item id.

**Poređenje po masterima (za redosled Faze 2):**

| Master | 2.0 tabela | Redova | Izloženost ključa | Verdikt za Fazu 2 |
|---|---|---|---|---|
| Komitenti | customers | 6.244 | 36.753 WO + 7.480 projekata rezolvira 100%/99,97% | **već BigBit prostor** — zadržati id |
| Predmeti | projects | 7.602 | **~145.700 redova** + RN/RNZ barkod | ključ NE dirati; poklapanje sa BigBit-om dokazati podacima (G3) |
| R_Artikli | items | 92.357 | 1.099 živih referenci, ali 57.998 kolizija prostora | ključ NE dirati; most = `external_item_id` |
| Cenovnik | price_list_entries | 0 | 0 | slobodno; `item_id` prostor odlučiti pre punjenja |
| Magacini | warehouses | 0 | 0 | slobodno |

## 5. Preporuka za Fazu 2 (items)

1. **`items.id` ostaje QBigTehn lokalni ključ** (posle cutover-a: prosto „ServoSync ključ");
   BigBit→PG drop-folder sync radi **upsert po `external_item_id`**, a `id` dodeljuje PG
   autoincrement za NOVE artikle.
2. Preduslov: **parcijalni unique indeks** `uq_items_external_item_id (external_item_id) WHERE external_item_id > 0`
   — u prod danas 0 duplikata, pa je migracija bezbedna; indeks pretvara pretpostavku u garanciju.
3. Novi BigBit artikal bez lokalnog para → insert (novi lokalni id); postojeći → update po ext šifri;
   1.371 lokalnih artikala bez BigBit šifre ostaju netaknuti (QBigTehn-native).
4. Redosled uvoza nebitan za tvrde FK-ove SAMO ako se `items` uvek uvozi pre `Cenovnik`-a
   (`price_list_entries.item_id` je tvrdi FK, schema.prisma:119); `item_id` u `price_list_entries`
   se pri uvozu MORA remapovati BigBit šifra → lokalni id (BigBit Cenovnik nosi BigBit šifre,
   za razliku od QBigTehn kopije koja nosi lokalne — `Cenovnik_FK00`).
5. Dok paralelno rade QBigTehn MSSQL sync i BigBit drop sync, `items` sme da ima samo JEDNOG
   pisca (BACKEND_RULES §4 „sync-ovane tabele su cache") — definisati primat pre uključenja.

---

*Metod: schema.prisma (celina, 2.015 linija), sync-map.generated.ts + generic/customer/drawing-plan-item synceri,
qbigtehn_sqlserver.sql DDL, BB_T_26_schema.sql, i live COUNT/rezolucija upiti nad prod PG
(`docker exec servosync-pg`, 2026-07-12). Nadovezuje se na F1 (drift `Sifra artikla` vs `BBSifra artikla`,
BB_T_26-analiza-F1-pokrivenost-polja.md §Drift red 1).*

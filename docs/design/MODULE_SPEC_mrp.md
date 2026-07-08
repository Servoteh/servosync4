# Module Spec: MRP / Nabavka (uvid) — ServoSync 2.0

| | |
|---|---|
| **Modul** | MRP / planiranje nabavke iz BOM-a (uvid u V1) |
| **Verzija spec** | 1.0 (2026-07-08) |
| **Faza** | 2.0 (Sprint 8 — uvid); pun MRP kasnije |
| **Izvor** | QBigTehn: [migration/08 §6](../migration/08-qbigtehn-vba-domain-map.md), UI `Izvoz/Forme`, SQL [migration/05](../migration/05-qbigtehn-sqlserver-logic.md) |
| **Status** | Spec spreman; **BOM eksplozija čeka §11.3** (rekurzivni CTE + anti-ciklus guard) |

> Planiranje nabavke iz sastavnice: **potreba → plan → zahtev za nabavku → nalog magacinu**. Zalihe su
> BigBit overlay (read-only cache). **Decision-engine (odluke 1/2/3) je deljen sa primopredajom** — u 2.0
> jedan generičan resolver. **⚠️ BOM rekurzija bez anti-ciklus zaštite u legacy-ju** — PG `WITH RECURSIVE`
> bez guarda **visi** ([ROADMAP rizici](../ROADMAP.md), §11.3 blokira).

## 1. Domenski model (Prisma)

| Tabela | Uloga |
|---|---|
| `mrp_demands` / `mrp_demand_items` | MRP potrebe (zaglavlje + stavke) |
| `mrp_plans` / `mrp_plan_items` | plan nabavke (+ `decision` na stavci) |
| `mrp_item_stock` / `_tmp` | snapshot zaliha (BigBit overlay) |
| `purchase_requests` / `_items` | zahtevi dobavljačima (RFQ) |
| `drawing_components` | BOM izvor (iz PDM-a) |

## 2. Ekrani (iz dizajna `Izvoz/Forme`)

| Ekran | Ključne akcije (iz koda) |
|---|---|
| **Planiranje nabavke** (`PlaniranjeNabavke`, 12 dugmeta) | „Novo planiranje" · **Zaključavanje** · **„Proknjiži planiranje"** · **„Definiši rezervisane i trebovane količine"** · **„Definiši sporne stavke"** |
| **Sporne stavke** (`PlanSporneStavke` + podforma) | **decision engine** — „Primeni odluke" · „Primeni na sve stavke" |
| **Zahtevi za nabavku** (`ZahteviZaNabavku`, 9 dugmeta) | filter · „Predmet" · „Tabela statusa" · „Detaljno zahtev" · **„Realizacija zahteva"** · „Detaljno upit" |
| **Potrebni gotovi delovi za crtež** (`PotrebniGotoviDeloviZaCrtez`) | **generisanje MRP potreba iz sastavnice** (BOM eksplozija) |
| **MRP pregledi** (`MRP_PregledSaZalihama`, `PoDobavljacima`, `Rezervisano`, `SamoNabavku`) | dashboard tabovi (filtrirani view-ovi) |
| **Mail nabavci** (`BBMail_ZaNabavku`) | slanje specifikacije PDF + SMTP |

**UI obrasci:** master-detail plan + state-machine dugmad, decision-podforma, dashboard tabovi nad SQL view-om.

## 3. Poslovna pravila (🔴 = obavezan port; [08 §6](../migration/08-qbigtehn-vba-domain-map.md))

1. **🔴 FORMULA SLOBODNIH ZALIHA (ponavlja se svuda):** `SlobodneZalihe = Zalihe(PlusMinusKolicina) − Rezervisano(RezervisanaKolicina)`, upis samo ako `≥ 0`.
2. **🔴 STATE MACHINE plana (port 1:1):** `predato → sve lock`; `sporne bez odluke → samo „Odluke"`; `sve pokriveno → Proknjiži`.
   `PlanJeSpremanZaProknjizavanje` = nema stavke gde `Rezervisano + ZaNabavku < PotrebnoUkupno`. Proknjižavanje → `spMRP_Potrebe_PromeniStatus(4)` + lock.
3. **🔴 DECISION ENGINE** (`OdlukaAkcija`): **1 = ISKLJUČI** (cilj 0) · **2 = NABAVI PONOVO** (cela) · **3 = NABAVI RAZLIKU** (`ZaNabavku − PrethodnoPlanirane`, min 0).
   Gate: svaka `NeedsDecision` stavka mora imati `IskljuciNabavku` ili `OdlukaAkcija ≠ 0`. → **jedan generičan `decision resolver`** (deljen sa primopredajom, [08 §4/§6](../migration/08-qbigtehn-vba-domain-map.md)).
4. **🔴 BOM eksplozija** (`ftMRP_PotrebeZaCrtez`): `TipEksplozije` **1 = top-level**, **2 = puna**; guard protiv duple otvorene potrebe (`Status IN (0,2)`). U 2.0 → **rekurzivni BOM CTE + anti-ciklus guard** (§11.3).
5. **Primarni dobavljač + lead time:** `ORDER BY Primarni DESC`, `VremeIsporukeDana` na stavku.
6. **🔴 Broj zahteva `'0000/YYYY'`** per-godina brojač → **atomska sekvenca** (legacy je race-condition).
7. **Zahtev za nabavku:** `RokZaPonudu = DatumZahteva + URokuDana`; `NotInList` dozvoljava **slobodan (ne-kataloški) unos** → podržati katalog-vezane I ad-hoc stavke.
8. **Nema pravog rollbacka** → sve u jednu transakciju.

## 4. RBAC ([RBAC_RLS_PREDLOG](RBAC_RLS_PREDLOG.md))

- **NABAVKA_VIEW:** MRP/nabavka samo uvid (V1 cilj).
- ŠEF/ADMIN: pun rad; MENADZMENT: uvid.
- Mutacije (plan, proknjižavanje, zahtevi) — posle §11.

## 5. API (predlog, `/api/v1/mrp/*`, `/api/v1/purchase-requests/*`)

| Endpoint | Metod | Opis | Faza |
|---|---|---|---|
| `/mrp/plans` `/plans/:id` | GET | plan + stavke + zalihe | uvid ✅ |
| `/mrp/plans/:id/views` | GET | pregledi (po dobavljaču/rezervisano/samo nabavka) | uvid ✅ |
| `/drawings/:id/bom-requirements` | GET | potrebni delovi iz sastavnice (BOM eksplozija) | **posle §11.3** |
| `/mrp/plans` | POST | novo planiranje | posle §11 |
| `/mrp/plans/:id/decisions` | POST | decision engine (1/2/3) | posle §11 |
| `/mrp/plans/:id/post` | POST | proknjiži (gate + lock) | posle §11 |
| `/purchase-requests` | GET/POST | zahtevi za nabavku (RFQ) | posle §11 |

## 6. Zamke (NE prenositi)

- BOM rekurzija bez anti-ciklus guarda (PG visi) → guard u CTE.
- `MAX(Revizija)` leksikografski (radi za A/B/C, ne dvocifrene) → `revision_order` kolona.
- Ručni brojač `'0000/YYYY'` → sekvenca. Bez transakcije → transakcija.
- Duplirane stavke-podforme (ista `SlobodneZalihe` formula) → jedan servis.

## 7. Otvorena pitanja

1. **§11.3** — BOM/MRP procedure na `WITH RECURSIVE` + anti-ciklus (blokira BOM eksploziju).
2. Da li V1 ostaje samo uvid ili odmah dobija planiranje.
3. Generičan decision resolver — deljen MRP + primopredaja (potvrda oblika).

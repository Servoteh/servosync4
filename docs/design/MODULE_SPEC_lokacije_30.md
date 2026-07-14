# Module Spec: Lokacije delova + Štampa nalepnica — 3.0 TALAS A (nastavak pilota)

| | |
|---|---|
| **Moduli (grupa)** | 1.0 „Lokacije delova" (`loc_*`) + 1.0 „Štampa nalepnica" (TSPL2) — sele se ZAJEDNO |
| **Verzija spec** | 1.0 (2026-07-12) |
| **Faza** | 3.0-B/C — Talas A, odmah posle Reversi pilota |
| **Izvor** | 1.0 ŽIVI kod (`src/services/lokacije.js` ~1100 LOC + `src/ui/lokacije/` 7 fajlova ~11k LOC + `stampaNalepnica/` 1.2k) + živi DB (snimljeno 12.07) |
| **Authz snapshot** | [`authz-snapshots/lokacije-fn-defs-2026-07-12.sql`](authz-snapshots/lokacije-fn-defs-2026-07-12.sql) (36 fn) |
| **Doktrina** | [`MIGRACIONA_DOKTRINA_3.0.md`](MIGRACIONA_DOKTRINA_3.0.md) — VAŽI U CELOSTI |
| **Status** | ✅ **ODOBREN (Nenad, 12.07)** — sva 4 pitanja §7 presuđena („važe predlozi"); spreman za R1 (izvršava Opus po doktrini) |

> ⚠️ **NE mešati sa postojećim 2.0 `part-locations`** (`MODULE_SPEC_lokacije.md`) — to je
> QBigTehn magacinski ledger (praćenje kroz pogon, domen Proizvodnja). OVO je 1.0 sistem
> FIZIČKIH lokacija (hale/police/kavezi/mašine) — domen **Logistika**. Po playbook §4.2,
> `loc_*` je jedinstveni sistem fizičkih lokacija u 3.0; modeli se NE stapaju sada.
> Odnos i plan 3.0 unifikacije: postojeći spec §8.

## 0. Obim — šta se SELI, šta NE (ključna podela FRONT vs BRIDGE)

Od 36 `loc_*` funkcija, front koristi **12**; ostatak je pozadinska infrastruktura.

**SELI SE (korisnička površina):**
- Read: lokacije (šifarnik+hijerarhija), placements, movements/istorija, izveštaj po
  lokacijama, predmet/TP pregled, health/status banneri.
- Mutacije: `loc_create_movement` (SVE pokrete), `loc_move_cage`, CRUD `loc_locations`.
- Štampa nalepnica (police + TP/RNZ) — **spaja se sa postojećim 2.0 TSPL2 print servisom**
  (`LABEL_PRINTER_HOST` env + `/tech-processes/labels/print` obrazac već postoji!).
- Skener (kamera + HID + ručni): RNZ/short/compact barkodi stavki + shelf barkodi.
- Admin Sync tab (read status + arm/disarm/run-now — samo tanki RPC pozivi).

**NE SELI SE (ostaje u sy15/bridge — umire ili se repointuje uz QBigTehn cutover):**
- `bridge/` Node servis (MSSQL→cache sync jobs) — netaknut.
- pg_cron ingest worker (`loc_bigtehn_ingest_run`) — netaknut (2.0 ga samo armira/okida
  preko postojećih RPC-ova, kao 1.0 Sync tab).
- Outbound MSSQL write-back (`loc_sync_outbound_events` + Node worker) — netaknut; 2.0
  samo čita queue (admin). Gasi se sa QBigTehn cutover-om (playbook §4.2 most).
- Edge `loc-sync-monitor-dispatch` (mejl alerti) — netaknut.
- Trigeri (path/hijerarhija guard, outbound enqueue, machine sync) — ostaju u bazi.

## 1. Živi podaci i model (12.07)

| Tabela | Redova | Prisma model? | Napomena |
|---|---:|---|---|
| `loc_locations` | 1561 | ✅ `LocLocation` | hijerarhija HALL→SHELF + MACHINE + CAGE, `path_cached`, anti-ciklus trigeri |
| `loc_item_placements` | 865 | ✅ `LocItemPlacement` | mutabilno stanje (trigger iz movements); RLS krije `rev_tools` redove od ne-manage |
| `loc_location_movements` | 1132 | ✅ `LocLocationMovement` | append-only ledger; `client_event_uuid` UNIQUE (idempotencija VEĆ postoji) |
| `loc_sync_outbound_events` | 1261 | — ($queryRaw, admin) | queue za MSSQL write-back |
| `loc_bigtehn_ingest_state` / `loc_sync_worker_heartbeat` / `loc_sync_alerts_outbox` | 1/1/0 | — ($queryRaw) | worker status/health |
| `bigtehn_items_cache`, `v_active_bigtehn_work_orders`, `v_bigtehn_work_orders_with_mes_active`, `bridge_sync_log` | — | — ($queryRaw read) | Predmet tab + banneri; grants potrebni |

**PK = uuid, zadržava se** (kao Reversi). Modeli se DODAJU u postojeći `prisma/sy15.prisma`.

## 2. Žive politike + authz model (snapshot 12.07; RE-VERIFIKOVATI na sy15 pre R1)

9 politika, 4 authz nivoa (jasnije nego Reversi):

| DB funkcija | Ko prolazi | → 2.0 permisija |
|---|---|---|
| (select true) | svi prijavljeni: locations, movements, heartbeat, ingest_state | `lokacije.read` |
| `loc_can_create_movement()` | manage role **ILI aktivan zaposleni po email-u** (⚠️ pravilo firme — NE sužavati!) | `lokacije.move` |
| `loc_can_manage_locations()` | `admin, leadpm, pm, menadzment` | `lokacije.manage` |
| `loc_is_admin()` | samo `admin` (sync tab, outbound queue, alerts) | `lokacije.admin` |
| — 1.0 `canPrintLocLabels()` | manage ILI `magacioner` ILI `cnc_operater` | `lokacije.labels` |
| RLS na placements | `item_ref_table='rev_tools'` vidljiv samo `rev_can_manage()` | ostaje u bazi (GUC) |

**Dodele u `role-permissions.ts`:** `read` → sve aktivne uloge; `move` → sve aktivne uloge
(row-odluku donosi DB fn kroz GUC — širina „aktivan zaposleni" OSTAJE u bazi); `manage` →
admin/menadzment/pm/leadpm; `admin` → admin; `labels` → manage + magacioner + cnc_operater
(⚠️ `cnc_operater` je 3.0-rezervisana → aktivirati kao pm/leadpm obrazac).
⚠️ Mutacioni RPC-ovi traže `auth.uid()` → GUC sub claim OBAVEZAN (doktrina A2).

## 3. API (predlog, `/api/v1/locations/*` — "physical locations"; part-locations ostaje zaseban)

| Endpoint | Metod | Permisija | 1.0 poreklo |
|---|---|---|---|
| `/locations` (+`/:id`) | GET | read | fetchLocations (hijerarhija, filteri kind/hall/active) |
| `/locations` / `/:id` | POST / PATCH | manage | createLocation/updateLocation (REST write, RLS paritet) |
| `/locations/placements` | GET | read | fetchPlacements/fetchItemPlacements (search, po stavci/crtežu) |
| `/locations/movements` | GET | read | istorija + filteri (korisnik/lokacija/tip/nalog/datum) |
| **`/locations/movements`** | **POST** | **move** | `loc_create_movement(payload)` kroz GUC; `client_event_uuid` generiše BE ako fali |
| `/locations/cage-move` | POST | manage | `loc_move_cage` |
| `/locations/reports/by-location` | GET | read | `loc_report_parts_by_locations` (12 param) + suggest |
| `/locations/predmet/:itemId/tps` | GET | read | `loc_tps_for_predmet` + `loc_get_bigtehn_op_status` |
| `/locations/lookups/validate-order` | GET | read | `loc_order_no_in_active_proj_mont` |
| `/locations/lookups/barcode` | GET | read | parse RNZ/short/compact + shelf (server-side resolve, paritet `barcodeParse.js`+`shelfBarcode.js`) |
| `/locations/sync/status` | GET | **admin** | ingest status + health + heartbeat + bridge_sync_log |
| `/locations/sync/arm` / `/run-now` | POST | **admin** | `loc_bigtehn_ingest_arm` / `_run_now` |
| `/locations/sync/outbound` | GET | **admin** | outbound queue pregled |
| `/locations/definitions-audit` | GET | manage | `loc_locations_audit` |
| `/locations/labels/print` | POST | labels | **reuse 2.0 TSPL2 servisa** (LABEL_PRINTER_HOST) — police + TP nalepnice |

Idempotencija: movements koriste POSTOJEĆI `client_event_uuid` (NE rev_api_idempotency);
BE prosleđuje klijentov uuid ili generiše svoj — retry vraća `{ok, idempotent:true}` iz RPC-a.

## 4. FE (Next) — `/lokacije` pod nav sekcijom **Logistika** (nova sekcija u 2.0 sidebar-u)

Tabovi (paritet 1.0; manage/admin gate po §2):
1. **Početna** — KPI, poslednjih 12 pokreta, health/bridge banneri, brze akcije
2. **Pregled predmeta** — pretraga predmeta → TP-ovi sa placement-ima + op-status (+ PDF crteža preko postojećeg 2.0 PDM!)
3. **Lokacije** (browse) — šifarnik hala/polica/kaveza, tree/table, Edit/Toggle (manage), Premeštaj kaveza (manage)
4. **Stavke** — placements pretraga + istorija stavke
5. **Pregled po lokacijama** — report + filteri + CSV
6. **Istorija premeštanja** — movements + filteri + CSV
7. **Štampa nalepnica** — batch TP/police (labels permisija)
8. **Istorija definicija** (manage) · 9. **Sync** (admin)

Modali: Brzo premeštanje (11 movement_type vrednosti — select paritet), Nova/Izmena
lokacije, Premeštaj kaveza, Istorija stavke. **Skener**: proširiti Reversi `ScanOverlay`
— novi parseri (RNZ:/short/compact + `LP:`/`HALA - POLICA` shelf format), dvokoračni tok
(stavka → destinacija). **Mobilni**: /m/lokacije tok = isti ekrani (2.0 responsive) —
uklj. batch mod (više stavki → jedna destinacija).
⚠️ **Offline queue se NE prenosi u v1** (2.0 web je online-only kao Reversi); offline je
deo mobilnih šavova u finalnom 3.0 (playbook §6) — zabeleženo kao svesno odstupanje.

## 5. Parity matrica (doktrina B — status se ažurira TOKOM rada)

> **R1 izvršen 12.07** (grana `wave-a/lokacije`): Prisma modeli (`LocLocation`,
> `LocItemPlacement`, `LocLocationMovement` + 4 enuma) u `prisma/sy15.prisma`;
> `lokacije.{read,move,manage,admin,labels}` permisije + dodele (`cnc_operater`
> aktiviran tier→v2); modul `src/modules/locations/` — **11 GET endpointa**
> (locations +`:id`, placements, movements, reports/by-location + suggest,
> predmet/:id/tps, lookups/{validate-order,barcode}, definitions-audit,
> sync/{status,outbound}); barkod parser VERAN port (`barcode.ts`). Testovi:
> unit rola-matrica + unit barkod (parser+shelf) + **e2e permission matrica 202**
> (rola × endpoint × 200/403, AUTHZ_ENFORCE=true). Build 0 greš., lint čist,
> ceo paket zelen (349 unit / 261 e2e). Mutacije = R2, FE/mobilno = R3.
>
> **R2 izvršen 13.07** (grana `wave-a/lokacije`): BE mutacije — **7 novih endpointa**
> u `src/modules/locations/` (POST `/movements`→`loc_create_movement`, POST `/cage-move`
> →`loc_move_cage`, POST `/` + PATCH `/:id` = CRUD `loc_locations` Prisma kroz `withUser`,
> POST `/sync/arm`→`loc_bigtehn_ingest_arm`, POST `/sync/run-now`→`loc_bigtehn_ingest_run_now`,
> POST `/labels/print`). DTO-i (class-validator, camelCase→snake_case) u `dto/locations-tx.dto.ts`.
> Idempotencija = NATIVNA `client_event_uuid` (DB fn replay → `{ok,idempotent:true}`; NE
> rev_api_idempotency, doktrina A4). jsonb envelope `{ok,error}` → HTTP (401/403/404/422);
> CRUD Prisma greške → HTTP (P2002→409, P2025→404, triger/FK→422). **TSPL2 REUSE**: RAW
> transport izdvojen iz `TechProcessesService.printRawLabel` u deljeni
> `common/printing/LabelPrintService` (`PrintingModule`) — koriste ga i Tehnologija i
> Lokacije; NE piše se nov TSPL2 (front R3 gradi shelf/TP program u 1.0 formatu).
> Guard po živoj politici (spec §2): movements=`move`, cage-move+CRUD=`manage`, sync=`admin`,
> labels=`labels`. ⚠️ cage-move guard je **`manage`** (ne „move" iz R2 instrukcije) — jer
> `loc_move_cage` DB fn traži `loc_can_manage_locations()`; usklađeno sa spec §3 + e2e.
> Šema re-verifikovana (Management API, read-only): potpisi 4 fn + `loc_locations` kolone +
> oba enuma = 0 drift. Testovi: **+21 unit** (payload paritet, idempotency, envelope+SQLSTATE
> mapiranje) + **e2e matrica 202→288** (nove move/manage/admin/labels mutacione grane +
> ValidationPipe 400 grane). tsc 0, build 0, lint 0 novih grešaka; ceo paket zelen
> (**370 unit / 347 e2e**). FE 9 tabova + skener + rezni fix = R3.
>
> **R2 security follow-up (13.07, adversarni review):** MEDIUM leak u R1 read putu —
> `GET /placements` (i `lookups/barcode` ITEM razrešenje) čitao je `loc_item_placements`
> kroz `sy15.db` (`servosync2_app` = BYPASSRLS), pa je row-scoped RLS `loc_placements_select`
> (krije `item_ref_table='rev_tools'` od ne-`rev_can_manage`) bio zaobiđen → svako sa
> `lokacije.read` je mogao dobiti rev_tools placements. FIX (doktrina A.2a): dodat
> `Sy15Service.withUserRls` (claims PA `SET LOCAL ROLE authenticated` u istoj tx → RLS se
> evaluira); `listPlacements` + `resolveItemPlacements` prebačeni na njega; `itemRefTable`
> whitelist (`bigtehn_rn`/`rev_tools`, ostalo → 400). Audit svih `loc_*` SELECT politika
> (Management API): **jedina** row-scoped je `loc_placements_select` — ostale su `true`
> (locations/movements/heartbeat/ingest_state) ili `loc_is_admin()` (sync outbound/alerts),
> pa `withUser`/DEFINER ostaju ispravni. +4 unit (dokaz da placements idu kroz withUserRls,
> ne sy15.db; 400 na nedozvoljenu tabelu). Ceo paket zelen (**374 unit / 347 e2e**).

| # | Funkcija | Status |
|---|---|---|
| 1 | Dashboard KPI + poslednji pokreti + banneri | R1: BE read izvori (movements + sync/status banneri) IMPLEMENTED+TESTED; UI R3 |
| 2 | Browse šifarnik + hijerarhija + edit/toggle (manage) | R1: browse read (`GET /locations` +filteri kind/hall/active/q) IMPLEMENTED+TESTED; R2: edit/toggle (`PATCH /:id` isActive) IMPLEMENTED+TESTED; UI R3 |
| 3 | Nova lokacija / izmena (RLS paritet) | R2: `POST /locations` + `PATCH /:id` (Prisma kroz `withUser`, SAMO 1.0-editabilna polja, triger/RLS paritet) IMPLEMENTED+TESTED (unit CRUD + SQLSTATE→HTTP; e2e manage gate); UI R3 |
| 4 | Premeštaj kaveza (`loc_move_cage`) | R2: `POST /cage-move` (manage gate; envelope→HTTP) IMPLEMENTED+TESTED (unit bind+404/422; e2e manage) |
| 5 | Placements pretraga + istorija stavke | R1: read (`GET /placements` + istorija po item_ref) IMPLEMENTED+TESTED |
| 6 | **Brzo premeštanje (movement, 11 tipova, idempotentno)** | R2: `POST /movements`→`loc_create_movement(jsonb)` kroz `withUser`; DTO paritet 1:1 (camelCase→snake_case), NATIVNA idempotencija `client_event_uuid` IMPLEMENTED+TESTED (unit payload paritet + replay + envelope; e2e move gate + 400); UI select 11 tipova R3 |
| 7 | Skener: RNZ/short/compact parse + autofill (placements/op-status/crtež) | R1: parser+resolve (`GET /lookups/barcode` ITEM → placements) IMPLEMENTED+TESTED (unit); autofill UI R3 |
| 8 | Skener: shelf barkod (LP:/kratki format) → destinacija | R1: shelf resolver (`GET /lookups/barcode` SHELF) IMPLEMENTED+TESTED (unit) |
| 9 | Pregled predmeta (TP-ovi, op-status, PDF crteža) | R1: TP+op-status read (`GET /predmet/:id/tps`, opc. `workOrderId`) IMPLEMENTED+TESTED; PDF/UI R3 |
| 10 | Report po lokacijama (12 filtera) + CSV + suggest | R1: report+suggest read (`GET /reports/by-location` svih 13 param + `/suggest-naziv-dela`) IMPLEMENTED+TESTED; CSV/UI R3 |
| 11 | Istorija premeštanja + filteri + CSV | R1: read + SVI filteri (korisnik/lokacija/tip/nalog/datum) (`GET /movements`) IMPLEMENTED+TESTED; CSV/UI R3 |
| 12 | Štampa nalepnica: TP (RNZ) + police, batch | R2: `POST /labels/print` (labels gate) — REUSE deljenog `LabelPrintService` (RAW TSPL2 transport, isti kao Tehnologija; NE piše se nov TSPL2) IMPLEMENTED+TESTED (unit delegacija; e2e labels gate); front gradi shelf/TP program u 1.0 formatu R3 |
| 13 | Istorija definicija (audit, manage) | R1: read (`GET /definitions-audit`, manage gate) IMPLEMENTED+TESTED |
| 14 | Sync tab: status/arm/run-now/outbound (admin) | R1: status+outbound read (`GET /sync/status`,`/sync/outbound`, admin gate) IMPLEMENTED+TESTED; R2: `POST /sync/arm`+`/sync/run-now` (admin gate; envelope→HTTP) IMPLEMENTED+TESTED (unit not_admin→403; e2e admin) |
| 15 | Mobilni tok (skener + batch) — responsive | NOT_STARTED (R3) |
| 16 | e2e permission matrica (read/move/manage/admin/labels) | R2: TESTED — SVIH 5 nivoa sa realnim endpointima: e2e 288 slučaja (read/move/manage/admin/labels × rola × 200/403 + ValidationPipe 400, AUTHZ_ENFORCE=true) + unit rola-matrica |
| 17 | Reversi spoj: initial placement alata IZ 2.0 Reversija → `/locations/movements` | NOT_STARTED (R3) |
| 18 | ⭐ REZNI FIX: izdavanje reznog sa MACHINE lokacije (rešava Reversi caveat) | NOT_STARTED (R3) |

## 6. Redosled izvođenja (R-faze za CEO talas)

| Faza | Šta | Gate |
|---|---|---|
| R0 | Nenadov review spec-a + re-verifikacija snapshot-a na živoj sy15 + grants za `servosync2_app` (loc tabele write, execute na 12 front fn, SELECT bigtehn cache/views — migracija u 1.0 repo) | odobreno |
| R1 ✅ | BE read sloj: Prisma modeli u sy15.prisma + svi GET endpointi + `lokacije.*` permisije + e2e read matrica — **URAĐEN 12.07** (grana `wave-a/lokacije`, §5 note) | read paritet ✅ |
| R2 | BE mutacije: movements (client_event_uuid), cage-move, locations CRUD, sync arm/run, labels print (reuse TSPL2); e2e full | write paritet |
| R3 | FE: 9 tabova + modali + skener proširenje + mobilno; **⭐ Rezni fix u Reversiju** (izvorna lokacija = MACHINE) | UI paritet |
| R4 | Živi smoke (pun ciklus: sken → premeštaj → istorija → nalepnica) + Playwright happy-path + paralelni rad → hub preklop | parity gate (doktrina D) |
| R5 | Retrospektiva tempa → ažurirati PROCENA_SEOBE (druga merna tačka!) | kalibracija |

## 7. Odluke R0 — ✅ PRESUĐENO (Nenad, 12.07: „važe predlozi")

1. **Predmet tab izvor**: ✅ **DA** — v1 čita iste `bigtehn_*` cache tabele iz sy15 (paritet).
   Repoint na 2.0 `tech_processes` = zaseban most uz QBigTehn cutover (playbook §4.2), NE sada.
2. **PDF crteža u Predmet tabu**: ✅ **2.0 PDM** (`drawing_pdfs`) — dedup ranije za ovaj ekran;
   sy15 bucket se za ovaj ekran ne koristi.
3. **`cnc_operater` aktivacija** (labels permisija): ✅ **DA** — aktivirati kao pm/leadpm obrazac
   (tier → v2 + dodela u `role-permissions.ts`).
4. **Sync tab**: ✅ **SELITI** — admin kontrola postojećeg workera (3 tanka RPC-a + read queue);
   1.0 Sync tab ostaje kao fallback do QBigTehn cutover-a.

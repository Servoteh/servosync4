# F5 — Gašenje mosta ka staroj bazi (sy15) — plan (jul 2026)

Nastavak plana [PLAN_PRACENJE_PROIZVODNJE_2026-07.md](PLAN_PRACENJE_PROIZVODNJE_2026-07.md) (§5, red „F5").
Rečnik imena: [VERZIJE.md](VERZIJE.md). Status: **PREDLOG — čeka presude M1–M10 (§8) i preflight (§3.1).**

Analiza rađena 19–20.07.2026 nad živim kodom (worktree `wt/pracenje-f1`, grana `main`) — svi
navodi su fajl:linija odnosno tabela.kolona; SQL definicije iz snapshota
`backend/docs/design/authz-snapshots/talasC-fn-defs-2026-07-12.sql` (dalje „snapshot").

---

## 1. Zašto ovaj dokument i šta F5 tačno jeste (a šta nije)

Praćenje proizvodnje je od 19.07.2026 **native na glavnoj bazi** (F1/F2 plana praćenja,
komiti `06e8e6c`/`32b986b`). Time je most `glavna baza → sy15 keš → sy15 RPC → 3.0 backend`
izgubio najvećeg potrošača — ali **ne i poslednjeg**. F5 = dovesti i ostale potrošače feed
lanca na glavnu bazu, pa fizički ugasiti:

- `LocTpFeedService` hranilicu (`backend/src/modules/locations/loc-tp-feed.service.ts`),
- pg_cron ingest u sy15 (`loc_bigtehn_ingest_5min` → `loc_bigtehn_ingest_run()`),
- 3 keš tabele feed lanca: `bigtehn_tech_routing_cache`, `bigtehn_work_orders_cache`,
  `bigtehn_work_order_lines_cache` (+ view lanac nad njima).

**Šta F5 NIJE** (česte zablude — ispravke dokumentacije u §3.4):

1. F5 **ne gasi kataloške keševe** `bigtehn_items_cache` / `customers_cache` /
   `machines_cache` / `drawings_cache` — njih puni bridge **CATALOGS** grupa, ne feed
   (loc-tp-feed.service.ts:18-19), i žive do B2/bigbit-bridge
   (RUNBOOK_LOC_MOST_REPOINT.md:27). F5b/F5c repoint-i skidaju *razloge* da CATALOGS živi,
   ali samo gašenje kataloga je B2 posao.
2. F5 **ne gasi sy15 kao bazu** — Talas B/C/D fasade (sastanci, kadrovska, reversi, PB,
   održavanje, energetika, ai-chat, plan-montaže podaci, auth/D1) ostaju 100% na sy15 (§7).
   `VERZIJE.md` navodi 4 sy15 potrošača — stvarno ih je **15+** (popis u §2.2).
3. Quick-win „repoint praćenje-karantina na 3.0 sastanke" **ne postoji**: podaci sastanaka i
   `akcioni_plan` su i dalje u sy15 (sastanci.service.ts:70-71, doktrina §A.1; u servisu 0
   poziva glavnog `PrismaService`). Karantin `pracenje-akcije-sy15.service.ts` pada tek sa
   seobom sastanaka (§7).

## 2. Mapa zavisnosti — ko još živi na mostu

### 2.1 Lanac (tekstualni crtež)

```
GLAVNA BAZA (servosync, 5435)                          STARA BAZA (sy15, 5436)
tech_processes ────────────┐
work_orders ───────────────┤ LocTpFeedService (3.0 BE, oba Prisma klijenta)
work_order_operations ─────┘ loc-tp-feed.service.ts — watermark loc_tp_feed_state (sy15),
      │                      holdback 2 min (:121-130), storno skip (:317-322),
      │                      upis u bridge_sync_log pod legacy imenima jobova (:263-291)
      ▼
  sy15: bigtehn_tech_routing_cache / bigtehn_work_orders_cache / bigtehn_work_order_lines_cache
      │
      ├─► pg_cron loc_bigtehn_ingest_5min → loc_bigtehn_ingest_run()
      │      (parser loc_bigtehn_parse_ident čita bigtehn_items_cache = CATALOGS!)
      │      → loc_location_movements (source='bigtehn') → trigger → loc_item_placements
      │         ▲ čitaju: 3.0 modul locations (SVE rute /v1/locations/*)
      │                   1.0 Lokacije ekran + 1.0 MOBILNI /m/* myLokacije (3.0 nema /m/lokacije)
      │
      ├─► view lanac v_production_operations_pre_g4 → v_production_operations →
      │   v_production_operations_effective + v_active_bigtehn_work_orders +
      │   v_bigtehn_work_orders_with_mes_active + RPC-ovi (reassign, open_ops…)
      │         ▲ čita: 3.0 plan-proizvodnje (26 ruta) — NAJVEĆI preostali potrošač
      │
      └─► loc_* DB fn-ovi koji JOIN-uju keš (loc_tps_for_predmet, loc_get_bigtehn_op_status,
          loc_report_*…) ▲ čita: 3.0 locations

  PARALELNO (nije feed): bridge CATALOGS → bigtehn_items/customers/machines/drawings_cache
          ▲ čitaju: plan-montaze, plan-proizvodnje (machines/drawings/customers),
            locations (validate-order, report), kadrovska, odrzavanje import — gasi se B2
```

Praćenje: **od 19.07. van lanca** (pracenje-read.service.ts:30-40 dokumentuje bivše
mapiranje); jedini sy15 dodir praćenja je karantin akcionih tačaka (v. §1.3).

### 2.2 Tabela: potrošač → sy15 objekti → šta treba da se desi

| # | Potrošač | sy15 objekti (glavni) | Šta treba da se desi | Podfaza |
|---|---|---|---|---|
| 1 | **plan-proizvodnje** (plan-proizvodnje.service.ts) | 3 feed keša + machines/customers/drawings keš, view lanac `v_production_operations*`, RPC reassign/open_ops, app tabele `production_overlays`(741)/`urgency`(9)/`reassign_audit`(0)/`auto_cooperation_groups`(3)/`drawings`(0), bucketi | native read sloj + migracija app podataka + reassign u BE (obrazac praćenje F1/F2) | **F5b** |
| 2 | **locations** (locations.service.ts) | `loc_*` tabele (ostaju u sy15 — doktrina A1), fn-ovi koji čitaju bigtehn keš, `v_bigtehn_work_orders_with_mes_active` (:693), syncHealth nad `bridge_sync_log` (:924-989) | repoint bigtehn čitanja na glavnu bazu + zamena ingest signala + prerada syncHealth | **F5c** |
| 3 | **loc-tp-feed** hranilica | piše 3 keša + `loc_tp_feed_state` + `bridge_sync_log` | gasi se TEK kad #1 i #2 padnu | **F5d** |
| 4 | pg_cron ingest (sy15) | `loc_bigtehn_ingest_run` + `_state` + parser + heartbeat | zamenjen native ingest-om (F5c), pa unschedule + DROP | **F5d** |
| 5 | 1.0 mobilni **/m/pracenje** (myPracenje.js) | sy15 `pracenje_*` RPC-ovi (get_aktivni_predmeti…) — poslednji ŽIVI 1.0 klijent tih fn | **O8 redirect** na 3.0 `/m/pracenje` | **F5a** |
| 6 | 1.0 mobilni **/m/*** myLokacije | `loc_*` u sy15 (ne keš) | nastavlja da radi dok loc_* žive u sy15; seoba = B3 (M10) | posle F5 |
| 7 | plan-montaze | `projects/work_packages/phases`, `montaza_*`, **CATALOGS keševi** (:216,229,259), bucketi | NIJE bloker feed-a; katalozi = B2, podaci = zasebna seoba | posle F5 (§7) |
| 8 | pracenje karantin | `v_akcioni_plan` (view) | pada sa seobom sastanaka | posle F5 (§7) |
| 9–15 | sastanci, reversi(+loc atomarnost), PB, kadrovska+moj-profil, odrzavanje, energetika, ai-chat | svoje domenske tabele/RPC/buckete u sy15 | seobe fasada modul-po-modul | posle F5 (§7) |
| 16 | podesavanja (D1 dual-write), auth SSO, session-auto-close | GoTrue + `user_roles`, `SY15_JWT_SECRET`, `attendance_events` | pada tek sa penzijom 1.0 logina | posle F5 (§7) |
| 17 | monitor-sy15.sh (ubuntusrv, van repoa) | `bridge_sync_log`, heartbeat, `synced_at` provere | prilagoditi u F5d (inače lažni alarmi) | **F5d** |

## 3. F5a — quick-wins + preflight

### 3.1 Preflight — utvrditi ŽIVO stanje mosta (blokira sve ostalo)

**Kontradikcija u dokumentaciji**: RUNBOOK_LOC_MOST_REPOINT.md (§0, 18.07) i
RADNI_PLAN_3.0.md:65 kažu „kod sletio, živa sekvenca NIJE izvršena — čeka prozor";
VERZIJE.md:24-25 (19.07) tvrdi da keš „danas puni loc-tp-feed". Pre bilo kakvog plana
gašenja mora se znati da li se gasi **radna** hranilica ili se B1 sekvenca **tek uspostavlja**
(to su dva različita plana!). Provere (read-only):

1. `GET /api/v1/locations/sync/feed-status` — `initialized` / `lastRunAt` / brojevi redova.
2. sy15: `SELECT * FROM cron.job` — da li je `loc_bigtehn_ingest_5min` `active`.
3. ubuntusrv: `~/servoteh-bridge/.env` → `ENABLE_JOB_PRODUCTION` (stari bridge) +
   da li postoji systemd `loc-tp-feed.timer` (runbook korak 8).
4. sy15: `bridge_sync_log` poslednji upisi po 3 legacy job imena; `loc_bigtehn_ingest_state.last_processed_signal_id` vs max id keša.
5. Svežina keša: `max(synced_at)` u 3 feed tabele vs `now()`.

Ishod preflight-a upisati u ovaj dokument (dopuna §3.1) — od njega zavisi da li F5d
gasi feed ili je feed već mrtav pa se samo čisti.

**✅ PREFLIGHT IZVRŠEN 20.07.2026 (Nenad, SSH na ubuntusrv → sy15-db kontejner) — NALAZI:**

1. **Hranilica (loc-tp-feed B1) NIKAD NIJE PUŠTENA U RAD** — `loc_tp_feed_state` tabela
   **ne postoji** u sy15 (seed `10_feed_state_init.sql` nikad izvršen). RUNBOOK (18.07,
   „sekvenca neizvršena") je bio TAČAN; VERZIJE.md tvrdnja da feed puni keš je bila netačna.
2. **Keš je ZAMRZNUT od gašenja QBigTehn sync-a**: `max(synced_at)` = RN **14.07 11:30**,
   linije **13.07 15:00**, tech_routing **15.07 16:15** (provera 20.07 06:26 — staro 5–7 dana).
3. `loc_bigtehn_ingest_5min` pg_cron u sy15 **jeste aktivan** (*/5) ali prazan hod — troši
   keš koji niko ne puni. Aktivni su i `loc_purge_synced_daily`, `loc_sync_health_check_hourly`,
   `po_cleanup_orphaned_machines` (za F5d listu).
4. `sy15-scheduler` (dispatch-loop.sh) okida SAMO notifikacione fn (sastanci/hr/loc-monitor/
   maint/pb) — nema veze sa proizvodnim feed-om.
5. `bridge_sync_log` ima drugačija imena kolona od plana (nije bitno — istorija, ne živi tok).

**POSLEDICA (bitnija od F5 samog): 3.0 Plan proizvodnje i 1.0 Lokacije rade nad podacima
zamrznutim 14–15.07** — svaka operacija kucana od tada NE postoji u planu mašina. F5d je
„čišćenje" (nema šta da se gasi osim praznog pg_cron-a), ali **F5b/F5c postaju hitni** —
ili se kao privremeni most aktivira B1 sekvenca iz RUNBOOK-a (odmrzava odmah), ili se ide
pravo na native repoint (par dana rada). Odluka M11 (Nenad).

### 3.2 O8 — redirect 1.0 ekrana praćenja — ⚠️ SEKCIJA NEVAŽEĆA (verifikacija 20.07.2026)

**Živa provera 1.0 repoa (grana `cutover/front-repoint`) OBORILA je premise ove sekcije:**
- `ss2Cutover.js` i `SS2_ORIGIN` **ne postoje** u 1.0 `src/` (grep = 0 pogodaka) — recept
  „obrazac ss2Cutover:56" je bio nevažeća referenca analize.
- Tvrdnja „desktop je već cutover-ovan (iframe)" je **netačna**: desktop modul
  `pracenjeProizvodnje` je ŽIV (`router.js:145-147` teardown grana, `:914-915` mobilna
  grana `renderMyPracenje` — pun render, ne redirect).
- **Posledica koja VEĆ VAŽI**: 1.0 praćenje (desktop + mobilni) čita sy15 `pracenje_*`
  podatke u koje 3.0 od F2 (19.07.) više NE piše → 1.0 ekran pokazuje zamrznuto stanje, a
  unosi u 1.0 idu u tabele koje niko ne čita. O8 je zato HITNIJI nego što je plan mislio,
  ali traži **stvarni mini-dizajn** (redirect i za desktop i za mobilni, prenos tokena u
  3.0) i **koordinaciju sa sesijom koja drži granu `cutover/front-repoint`** u 1.0 repou
  (aktivna, sa nekomitovanim izmenama van praćenja).
- §3.3 DROP ostaje blokiran dok pravi O8 ne legne (1.0 živi kod i dalje zove te RPC-ove).

### 3.3 Posle O8: DROP sy15 `pracenje_*` objekata

Kad O8 legne (i prođe par dana bez žalbi): DROP `pracenje_manual_overrides`,
`pracenje_parent_override`, `pracenje_proizvodnje_napomene`, `predmet_aktivacija`,
`predmet_prioritet`, `predmet_plan_prioritet` (+audit) i `get_pracenje_*` RPC-ova u sy15 —
3.0 ih od F1 ne zove (komit `32b986b`), a podaci su uvezeni 19.07 (F2 uvoz: 7602 aktivacije…).
Pre DROP-a: `pg_dump` tih objekata u arhivu (obrazac „zamrzni pa obriši", §6.3).

### 3.4 Sitni quick-wins (nezavisni)

- ~~Brisanje mrtvog QBigTehn sync koda~~ — ⚠️ **STAVKA NEVAŽEĆA (verifikacija 20.07.2026)**:
  `mssql.client.ts` + `customer.syncer.ts` + `generic.syncer.ts` + `SYNC_MAP` su **ŽIVO
  jezgro BigBit matičnog sync-a** (`sync.service.ts:9-12,34-42` — registruje CustomerSyncer
  + 34 generička syncera; radi do 4.0). Brisanje bi oborilo prod sync. Jedino stvarno mrtvo
  je istorijska lista `QBIGTEHN_CHAIN_ENTITIES` u `table-ownership.ts` — a i ona služi kao
  zaštita owned tabela od re-importa. **Ne dirati ništa od ovoga do 4.0/B2.**
- **Dokumentaciona ispravka** `docs/VERZIJE.md`: sekcija „Šta gde piše u kodu" — potrošača je
  15+ (tabela §2.2); formulacija „bigtehn_* nestaju sa F5" važi samo za 3 feed keša,
  kataloški imaju uslov B2.

### 3.5 F5a — preduslovi / verifikacija / rollback / procena

- **Preduslovi**: nema (preflight je read-only; O8 traži samo pristup 1.0 repou i deploy 1.0 fronta).
- **Verifikacija**: O8 — na telefonu otvoriti 1.0 `/m/pracenje` → mora sleteti na 3.0
  `/m/pracenje` ulogovan (token fragment); deep-link test; per-uređaj beg
  `ss2_cutover='off'` i dalje radi za ostale ekrane. DROP (§3.3) — pre izvršenja grep 1.0
  repoa da nijedan živi kod ne zove te RPC-ove (posle O8 ne sme biti nijedan).
- **Rollback**: O8 = revert komita u 1.0 (fajlovi nisu brisani); DROP = restore iz dump-a.
- **Procena**: **0.5 dana** multi-agent (preflight + O8 + brisanje sync koda + docs); DROP
  §3.3 posle par dana soak-a, 1 sat.

## 4. F5b — Plan proizvodnje repoint (najveći komad)

Obrazac = praćenje F1/F2 (native read sloj + jednokratna migracija app podataka + preklop),
ali sa bitnim otežanjima (§4.4). Detaljna inventura: 26 ruta kontrolera, svaka mapirana na
sy15 objekat — grupacija (a) keš čitanja / (b) app podaci / (c) RPC logika / (e) storage.

### 4.1 F5b-0 — izviđanje žive sy15 baze (blokira, read-only psql)

Tri definicije **nisu ni u jednom snapshotu** (samo pozivi) i moraju se izvući pre porta:

1. `production_machine_group_slug()` — gate za reassign group-mismatch (RPC :3365-3376);
   verovatno se poklapa sa `departments.ts:27-71` taksonomijom — pri portu spojiti u jedan
   izvor istine.
2. `plan_tech_routing_real_seconds(wo, operacija)` — koristi je pre_g4 view (:4341).
3. `v_bigtehn_work_orders_with_mes_active` — definicija `is_mes_active` + whitelist tabela
   `production_active_work_orders` (9412 redova, „puni BRIDGE — ne dirati",
   MODULE_SPEC_planovi_pracenje_30.md:72). **Kako nov RN postaje MES-aktivan posle
   cutover-a** mora se utvrditi na živoj bazi pre definisanja native filtera (M7).

Usput: uporediti skup redova sy15 kanona završne kontrole
(`production._pracenje_line_is_final_control`, snapshot:314-327 — heuristika po imenu/kodu)
sa native kanonom `operations.significant_for_finishing` (pracenje-read.service.ts:1410-1420)
— presuda M6. I proveriti svežinu `bigtehn_rework_scrap_cache` (nema hranilicu u novom kodu,
frozen od 14.07 → G4 dorada/škart oznake u PP su verovatno već ustajale; native port ovo leči).

### 4.2 F5b-1 — BE native sloj + migracija (obrazac pracenje-read)

**(a) Read sloj** — inverzija hranilice, mapiranje keš→native je već dokumentovano
(pracenje-read.service.ts:29-37, loc-tp-feed.service.ts): `bigtehn_work_orders_cache` ←
`work_orders` (ISTI id), `..._lines_cache` ← `work_order_operations` (ISTI id),
`..._tech_routing_cache` ← `tech_processes` (isti IDPostupka prostor), `machines_cache` ←
`operations`, `customers_cache` ← `customers`, `drawings_cache` ← PDM `drawings`/`drawing_pdfs`,
`rework_scrap_cache` ← `tech_processes.quality_type_id` (1=dorada, 2=škart) + rework lanac
`work_orders.parent_work_order_id`. Prepisuje se logika view lanca (spremnost/ready chain,
auto-koop, previous_operation_status, auto_sort_bucket 1-8, G4, final-control filter,
effective filter nad `predmet_aktivacije` — ta tabela u glavnoj bazi VEĆ postoji,
schema.prisma:2281-2296) + **OBA sort kanona** (RPC bez tie-breakera vs BE `OPS_SORT` sa
`rn_ident_broj, operacija` — verno preneti oba) + RPC paginacija po RN-u
(`plan_pp_open_ops_for_machine`, snapshot:3011-3058). `departments.ts` i `lookups.ts` su čist
TS — prenose se bez izmene.

**(b) Migracija app podataka** — čist COPY, **id prostori se poklapaju** (dokazano feed-om:
`wo.id AS id` :456, `op.id AS id` :558): `production_overlays` 741 (+history 112 — M8),
`production_urgency_overrides` 9, `production_auto_cooperation_groups` 3,
`production_reassign_audit` 0, `production_drawings` 0. Skript po obrascu
`scripts/migrate-pracenje-sy15.ts` (dry-run default, `legacy_sy15_id` idempotentnost).

**(c) Reassign u BE**: single/bulk sa group-mismatch gate-om (`machine_group_mismatch`),
force gate (admin/menadžment + `force_reason` ≥3 znaka), idempotencija **ON CONFLICT
(client_event_uuid, line_id) DO NOTHING** — force gate i idempotencija moraju ostati na
DB/BE strani (mirror guard u kontroleru već postoji :264-277, ali „DB je konačni gate"
prestaje da važi — test pokriti).

**(e) Skice/PDF**: skice planera → nova app-owned tabela + skladište po M1; bigtehn crteži →
PDM `drawings`/`drawing_pdfs` sa auth-gated content rutom (presedan:
`pracenje.crtezSignUrl` → `/api/v1/pracenje/crtez/:id/pdf/content`, pracenje-read.service.ts:1364-1389);
revizija fallback `{broj}_A/B` semantika prenosiva. Gate `can_read_production_drawings()`
(8 uloga) → `role-permissions.ts` mapa — **presuda O7 (svi vide PDF) važi SAMO za praćenje**,
za PP gate ostaje (PLAN_PRACENJE doc:181-184).

### 4.3 F5b-2 — preklop + FE izmene

FE tabovi (5 + `/m/proizvodnja`) idu isključivo kroz `frontend/src/api/plan-proizvodnje.ts` —
**ugovor kolona view-a zadržati 1:1** pa tabovi ostaju netaknuti. Obavezne FE izmene:

1. **PDF otvaranje**: `window.open(presigned)` (skice-modal.tsx:91-92, ops-table.tsx:127-133,
   tp-procedure-modal.tsx:46-52) → blob-fetch obrazac `openPracenjeDrawingPdf`
   (predmet-view.tsx:192-214), jer je auth Bearer u localStorage (401 na golu rutu).
2. **bridge-banner.tsx** (`useBridgeStatus`) — gubi smisao; ukloniti + ugasiti `GET bridge-status` (M4).
3. **Id tipovi**: sy15 vraća id-jeve kao string (`jsonSafe`); ugovor fiksirati po M3.
4. `has_bigtehn_drawing`/`broj_crteza` imena kolona zadržati (izvor postaje PDM).
5. Lookups rute (`op-snapshot`/`tp-options`/`resolve-drawing-no`/`rn-by-ids`) — **0 FE
   poziva** (grep frontend/src); sudbina po M5.

### 4.4 Šta je TEŽE nego kod praćenja (da se ne potceni)

1. **Performanse**: pun sken effective view-a već sada ~5.3s (service:74-80, timeout 30s);
   native reimplementacija ide nad 214k `work_order_operations` + 98k `tech_processes` —
   **ne prepisivati view lanac 1:1 bez merenja**; planirati indekse/materijalizaciju.
2. **Tri nedostajuće definicije** (F5b-0) — praćenje je imalo sve u snapshotima.
3. **Mutacioni RPC sa force gate-om i idempotencijom** (praćenje je bilo pretežno read).
4. **Dva sort-kanona** (RPC vs BE) + paginacija po RN-u umesto po redovima.
5. **Dva kanona završne kontrole** (M6) — razlika u skupu redova menja koji RN „ispada" iz plana.
6. **Storage odluka** (M1) — glavna baza nema object storage; praćenje je nasledilo bytea obrazac.
7. **`is_mes_active` lanac** (M7) — poslovno pravilo koje niko nije dokumentovao.

### 4.5 F5b — preduslovi / verifikacija / rollback / procena

- **Preduslovi**: F5b-0 izviđanje završeno; M1, M3–M8 presuđene; preflight §3.1.
- **Verifikacija** (lekcija 19.07 — boot incident F2): **svaki nov SQL obavezno kroz
  seeded-repro** — smoke skript (obrazac `scripts/smoke-pracenje-read.ts`: svih ~26 putanja,
  0 SQL grešaka) na 4.0 sandbox bazi (192.168.64.28:5437) SA seed podacima, pa na klonu/dev
  bazi SA stvarnim podacima; uporedni diff kanona: skup redova sy15
  `v_production_operations_effective` vs native izlaz za iste ulaze (posebno final-control i
  mes_active filtere); reassign idempotencija (dupli `client_event_uuid` → 1 audit red);
  perf budžet (operations?machine < 1s, operations/all < 5s); e2e smoke 5 tabova +
  `/m/proizvodnja`; migracija dry-run izveštaj → `--apply` → brojevi 741/112/9/3 sravnjeni.
- **Rollback**: kod — revert deploy-a (stari servis i dalje ume da čita sy15 dok se keš ne
  dropuje — zato F5d ide TEK posle soak-a); podaci — overlay/urgency mutacije nastale posle
  preklopa se pri rollback-u ručno vraćaju (prozor držati kratak, preklop van radnog vremena).
- **Procena**: **2–3 dana** multi-agent rada (praćenje F1–F3 = 1 dan; PP je L: ~1.5–2k
  linija BE+SQL + perf rad + FE S-M + migracija S + reassign M), + korisnički parity check.

## 5. F5c — Lokacije: uslovi + repoint

Doktrina A1 ostaje: **`loc_*` podaci žive u sy15** (locations.service.ts:44-52) do B3 seobe.
F5c je zato minimalni zahvat koji feed čini nepotrebnim (put presuđuje M2):

### 5.1 Sadržaj (preporučena varijanta M2-A: repoint čitanja + native ingest, loc_* ostaje u sy15)

1. **Zamena ingest signala**: novi 3.0 servis (cron u BE) čita `tech_processes` glavne baze
   direktno i upisuje `loc_location_movements` (source='bigtehn' ili novi source) u sy15 —
   preuzima semantiku koju danas deli feeder+ingest: holdback 2 min (loc-tp-feed:121-130),
   storno `komada<0` skip (:317-322), initial placement qty/crtež, MACHINE lokacije,
   heartbeat. Parser `loc_bigtehn_parse_ident` (čita `bigtehn_items_cache`) se prepisuje u
   TS nad native `projects` (filter `status='U TOKU'` — 00_preflight_checks.sql:85-88).
   Watermark seli u glavnu bazu (app-owned tabela) — ne ostaje u sy15.
2. **Repoint bigtehn čitanja** locations modula na glavnu bazu (BE SQL umesto sy15 fn):
   `loc_tps_for_predmet` (+ crteži → PDM), `loc_get_bigtehn_op_status` (+ `v_loc_tp_operation_slots`),
   `loc_report_parts_by_locations`, `loc_report_suggest_naziv_dela`,
   `loc_order_no_in_active_proj_mont`, direktno čitanje
   `v_bigtehn_work_orders_with_mes_active` (locations.service.ts:693,699 — zavisi od M7 definicije).
   TP-nalepnica podaci (predmet/work-orders ruta) prelaze na isti native izvor; štampa kroz
   `LabelPrintService` netaknuta (nije sy15).
3. **syncHealth prerada** (locations.service.ts:924-989): kad feed stane, pragovi
   cacheStale.rn/linije/tp nad `bridge_sync_log` postaju TRAJNO true (lažni baner) —
   penzionisati ih po obrascu `crtezi: false` (:954-957) ili ukloniti rute+banere (M9);
   prag `catalog_items` OSTAJE dok CATALOGS (B2) živi.
4. **Mobilni**: 1.0 `/m/*` myLokacije čita/piše `loc_*` u sy15 preko PostgREST — **nastavlja
   da radi** posle F5c/F5d (loc_* ostaju). 3.0 `/m/lokacije` ruta ne postoji (parity #15
   NOT_STARTED) — gradnja NIJE uslov F5, presuda M10.

Varijanta M2-B (B3 odmah: seoba `loc_*` tabela u glavnu bazu + native ingest bez sy15) gasi
feeder+keš+ingest odjednom, ali povlači: remapiranje reversi↔loc atomarnosti (rev servis
zove `loc_create_movement` u sy15 — sy15.service.ts:20), 1.0 mobilni gubi izvor (mora 3.0
/m/lokacije PRE toga), audit/outbox lanci — realno **1.5–2 dana dodatno** i širi blast radius.

### 5.2 F5c — preduslovi / verifikacija / rollback / procena

- **Preduslovi**: M2, M7, M9, M10 presuđene; F5b-0 izviđanje (deli `mes_active` nalaz);
  preflight §3.1.
- **Verifikacija**: seeded-repro za nov ingest — na sandbox bazi odigrati kucanje u
  `tech_processes` → očekivan `loc_location_movements` red + `loc_item_placements` upsert;
  storno i holdback slučajevi eksplicitno (kucanje mlađe od 2 min NE sme proći odmah);
  paralelni rad (novi ingest + stari lanac NE smeju duplirati signale — prelaz: pauza starog
  cron-a pa uključenje novog, sa watermark handover-om); diff izveštaja
  (parts_by_locations sy15 vs native za isti dan); 1.0 mobilni smoke (sken → placement vidljiv).
- **Rollback**: novi ingest se isključi (cron off), sy15 cron `loc_bigtehn_ingest_5min` se
  reaktivira + `loc_bigtehn_ingest_arm(true)` — watermark handover mora biti reverzibilan
  (zapisati oba watermarka pre prelaza).
- **Procena**: **1–1.5 dan** multi-agent (M2-A); M2-B varijanta +1.5–2 dana.

## 6. F5d — fizičko gašenje (tek posle F5b+F5c soak-a)

### 6.1 Redosled koraka (svaki reverzibilan do koraka 5)

1. **3.0 kod**: ukloniti `LocTpFeedService` + rute `POST /locations/sync/feed-run`,
   `GET /locations/sync/feed-status` (locations.controller.ts:250-254, :181-184) + systemd
   `loc-tp-feed.timer` na ubuntusrv (ako je runbook korak 8 bio instaliran — v. preflight).
2. **sy15 pg_cron**: unschedule `loc_bigtehn_ingest_5min`; `loc_bigtehn_ingest_arm(false)`;
   obrisati heartbeat red `'loc-bigtehn-ingest'` (obrazac 50_heartbeat_cleanup.sql) — inače
   `loc_sync_health_check_hourly` diže lažni `worker_down`.
3. **Monitoring**: `monitor-sy15.sh` (živi na ubuntusrv, NIJE u repou) — izbaciti proveru
   `bigtehn_work_orders_cache.synced_at > 6h` i ingest heartbeat; syncHealth već prerađen u F5c.
4. **sy15 DROP funkcija/state**: `loc_bigtehn_ingest_run`, `_run_now`, `_arm`,
   `loc_get_bigtehn_ingest_status`, `loc_bigtehn_parse_ident`; tabele
   `loc_bigtehn_ingest_state`, `loc_tp_feed_state`.
5. **sy15 zamrzni-pa-dropuj 3 feed keša** + view lanac: `bigtehn_tech_routing_cache`,
   `bigtehn_work_orders_cache`, `bigtehn_work_order_lines_cache`,
   `v_active_bigtehn_work_orders`, `v_bigtehn_work_orders_with_mes_active`,
   `v_loc_tp_operation_slots`, `v_bigtehn_rn_struktura`, `v_production_operations*` lanac.
   Postupak: `pg_dump` objekata → RENAME u `_zzz_f5_*` (ili REVOKE SELECT) → **soak 2 nedelje**
   → DROP. Ako išta pukne u soak-u, RENAME nazad je trenutan.
6. **`bridge_sync_log`**: prestaje da prima upise; tabela OSTAJE (istorija) do B3.
   `loc_sync_outbound_events` (~1274 PENDING, zamrznuto) i `loc_sync_alerts_outbox` +
   `loc-sync-monitor-dispatch` edge ostaju dok `loc_*` sistem živi u sy15 (B3).

### 6.2 Šta se u F5d NE dira (da se ne pretera)

- **CATALOGS keševi**: `bigtehn_items_cache` (plan-montaze:216,833; kadrovska; loc
  validate-order), `bigtehn_customers_cache` (plan-montaze:229,844), `bigtehn_machines_cache`
  (odrzavanje import fn `maint_machines_import_from_cache` — čak i posle PP repointa!),
  `bigtehn_drawings_cache` (plan-montaze:259) — gase se sa B2, ne sa F5.
- **Bucket `bigtehn-drawings`** (sy15 storage): plan-montaze ga i dalje koristi (:42) —
  gasi se tek posle njegovog PDM repointa. PP prestaje da ga koristi u F5b.
- **`production_active_work_orders`** (9412, „puni BRIDGE") — sudbina zavisi od M7 nalaza;
  ne dirati dok se native mes_active ne dokaže.

### 6.3 F5d — preduslovi / verifikacija / rollback / procena

- **Preduslovi**: F5b ŽIV na produ + soak ≥1 nedelja bez incidenta; F5c živ + soak;
  potvrda da NIJEDAN 3.0 modul više ne čita 3 feed keša ni view lanac (grep + sy15
  `pg_stat_user_tables` seq/idx scan brojači pre/posle RENAME — brojači miruju = niko ne čita).
- **Verifikacija**: posle koraka 1–2: feed-status 404, cron.job neaktivan, nema novih
  `bridge_sync_log` redova, nema `worker_down` alarma; posle RENAME (korak 5): svi ekrani
  PP/Lokacije/1.0 mobilni rade; `monitor-sy15.sh` ne alarmira.
- **Rollback**: koraci 1–2 revert deploy + re-schedule cron; korak 5 RENAME nazad; posle
  DROP-a — restore iz dump-a (zato dump obavezan).
- **Procena**: **0.5 dana** rada + 2 nedelje kalendarskog soak-a (bez rada).

## 7. F5e — šta OSTAJE posle F5 i kada pada

Sy15 posle F5 i dalje nosi (uslovi gašenja — redosled iz analize ostatka):

| Ostaje | Pada kada | Napomena |
|---|---|---|
| CATALOGS keševi (items/customers/machines/drawings) + bridge CATALOGS | **B2** (bigbit-bridge) + repoint plan-montaze/odrzavanje kataloga | F5b/F5c skidaju PP/loc razloge, ali montaza/kadrovska/odrzavanje ostaju |
| plan-montaze podaci (projects/work_packages/phases, montaza_*) + bucketi | zasebna seoba montaže | nije F5 |
| sastanci ceo domen + `akcioni_plan` → tada pada i **pracenje karantin** (`pracenje-akcije-sy15.service.ts`) + promote 501 postaje implementabilan (schema.prisma:2361 `izvorAkcioniPlanId` čeka) | seoba sastanaka | sy15 uuid ↔ 3.0 Int nerazrešiv do seobe |
| reversi + loc_* **ZAJEDNO** (atomarnost rev↔loc — sy15.service.ts:20) | **B3** seoba | tada padaju i `loc_sync_outbound_events`/alerts/edge |
| kadrovska + moj-profil (zajedno), odrzavanje, energetika, PB | seobe fasada modul-po-modul | ai-chat POSLEDNJI od fasada (alati čitaju tuđe domene) |
| session-auto-close (sy15 read-only `attendance_events`) | repoint kapije/prisustva | nezavisno, graceful bez env-a |
| D1 dual-write + `Sy15AuthAdminService` + SSO `SY15_JWT_SECRET` | penzija 1.0 logina (ss2 soft-flip) | POSLEDNJE |
| `Sy15StorageService` + bucketi (reversal-pdf, sastanci-*, pb-*, maint-*, employee-docs, montaza-izvestaji, bigtehn-drawings) | posle SVIH seoba fasada | tek tada: brisanje `Sy15Module`, `sy15.prisma`, prebuild koraka, SY15_* env |

## 8. Odluke M1–M10 — ✅ PRESUĐENO 20.07.2026 (Nenad)

> **Sve odluke M1–M6 i M8–M10 presuđene PO PREPORUCI** (20.07.2026): M1 skice = bytea u
> glavnoj bazi · M2 Lokacije = minimalni repoint (A) · M3 = string id-jevi ostaju · M4 =
> bridge-status/baner se uklanja · M5 = lookups rute se gase (TS kanonizacija se čuva) ·
> M6 = native `significant_for_finishing` kanon + obavezan diff skupa · M8 = jednokratni
> uvoz istorije u `audit_log` · M9 = penzionisati pragove u F5c · M10 = 1.0 mobilni
> Lokacije ostaje do B3. **M7 se presuđuje posle F5b-0 izviđanja** (kako je i predloženo).
> F5a je time potpuno deblokiran; F5b čeka samo F5b-0 nalaze.
> **F5a izvođenje ODOBRENO I POKRENUTO 20.07.2026 (Nenad: „kreni").**

1. **M1 — Skladište PP skica** (`production_drawings` zamena; meta 0 redova → trivijalno):
   (a) **bytea u glavnoj bazi** — obrazac `drawing_pdfs.pdf_binary` (schema.prisma:302-313) +
   auth-gated content ruta; (b) uvesti storage servis (MinIO/S3). **Preporuka: (a)** —
   postojeći obrazac, 20MB limit prihvatljiv, bez nove infrastrukture; storage servis je
   4.0 tema ako zatreba šire.
2. **M2 — Put za Lokacije**: (A) minimalni repoint čitanja + native ingest, `loc_*` ostaje u
   sy15 do B3; (B) B3 seoba `loc_*` odmah. **Preporuka: (A)** — manji blast radius, 1.0
   mobilni preživljava, reversi atomarnost netaknuta; (B) tek uz B3 talas.
3. **M3 — Id ugovor PP API-ja**: zadržati string id-jeve (FE tipovi već `line_id: string`)
   ili preći na number. **Preporuka: zadržati string** — nula FE izmena, izbegava BigInt
   serializacione zamke.
4. **M4 — `bridge-status` ruta + bridge-banner**: ukloniti ili repoint na feed/ingest status.
   **Preporuka: ukloniti** (posle F5d nema šta da pokazuje); zdravlje native sloja ide u
   postojeći monitoring.
5. **M5 — PP lookups rute** (op-snapshot/tp-options/resolve-drawing-no/rn-by-ids; 0 FE
   poziva): portovati ili ugasiti. **Preporuka: ugasiti u F5b**, a 9400-kanonizaciju
   (`lookups.ts`, čist TS) sačuvati u repou — ako Lokacije-native zatraže, port je jeftin.
6. **M6 — Kanon završne kontrole u PP filterima**: sy15 heuristika
   (`_pracenje_line_is_final_control`) vs native flag `operations.significant_for_finishing`.
   **Preporuka: native flag** (jedan kanon za praćenje i PP) + obavezan diff skupa redova u
   F5b verifikaciji; odstupanja presuditi pojedinačno.
7. **M7 — Native definicija „MES aktivan RN"**: kandidat `predmet_aktivacije` (je_aktivan po
   predmetu) + status RN — ali sy15 whitelist `production_active_work_orders` je finiji (po
   RN-u). **Preporuka: presuditi POSLE F5b-0 izviđanja**; ako whitelist nosi ručne izuzetke,
   uvesti app-owned `rn_mes_izuzeci` tabelu, inače aktivacija po predmetu.
8. **M8 — `production_overlays_history` (112)**: u glavnu `audit_log` (obrazac praćenje O2)
   ili zasebna history tabela + trigger. **Preporuka: jednokratni uvoz u `audit_log`** +
   novi zapisi kroz postojeći `withUser` GUC audit — bez novog trigger mehanizma.
9. **M9 — syncHealth/baneri posle gašenja feed-a**: penzionisati rn/linije/tp pragove
   (obrazac `crtezi:false`) ili ukloniti rute sync/* + FE sync-tab/banere. **Preporuka:
   penzionisati u F5c** (mali diff), kompletno uklanjanje ostaviti za B3.
10. **M10 — Mobilne Lokacije**: graditi 3.0 `/m/lokacije` sada ili ostaviti 1.0 mobilni nad
    sy15 `loc_*` do B3. **Preporuka: ostaviti 1.0 do B3** — radi, nije bloker F5; parity #15
    ulazi u B3 obim.

## 9. Zbirni redosled i procena

| Podfaza | Sadržaj | Zavisi od | Procena (multi-agent) |
|---|---|---|---|
| **F5a** | preflight žive hranilice + O8 mobilni redirect + brisanje mrtvog sync koda + docs | — | 0.5 dana (+DROP §3.3 posle soak-a) |
| **F5b-0** | izviđanje žive sy15 (3 definicije + mes_active + rework_scrap svežina) | preflight | 0.5 dana |
| **F5b** | PP native read sloj + migracija (741/112/9/3/0) + reassign + skice + FE | F5b-0; M1,M3–M8 | 2–3 dana |
| **F5c** | Lokacije: native ingest + repoint čitanja + syncHealth | M2,M7,M9,M10; deli F5b-0 nalaz | 1–1.5 dan |
| **F5d** | gašenje: kod → cron → monitoring → DROP fn/state → RENAME+soak → DROP keš | F5b+F5c soak ≥1 ned. | 0.5 dana + 2 ned. soak |
| **F5e** | ništa se ne radi — popis šta ostaje (§7) za B2/B3/seobe | — | — |

**Ukupno radno: ~5–6 dana multi-agent tempa** (referenca: praćenje F1–F3 za 1 dan), plus
kalendarski soak. Kritični put: preflight → F5b-0 → M presude → F5b → F5c → F5d.

## 10. Veza sa postojećim planovima

- Ovaj plan izvršava red **F5** iz PLAN_PRACENJE_PROIZVODNJE_2026-07.md §5 i zatvara
  RUNBOOK_LOC_MOST_REPOINT.md (B1 lanac se gasi umesto da se dalje održava).
- B2 (CATALOGS/bigbit-bridge) i B3 (seoba `loc_*` + konsolidacija) NISU u obimu — F5 im
  samo skida PP/Lokacije blokere.
- Presude iz plana praćenja koje se ovde NASLEĐUJU: O7 važi samo za praćenje (PP gate za
  crteže ostaje); obrazac migracije `legacy_sy15_id` + dry-run default; lekcija 19.07:
  nov SQL ne ide na prod bez seeded-repro smoke-a na bazi sa podacima.

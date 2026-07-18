# RUNBOOK — B1 loc-most repoint (1.0 Lokacije ingest: QBigTehn → 2.0 `tech_processes`)

> **Šta ovo zatvara:** Blok B stavku (1) iz [DEFINICIJA_3.0_ZAVRSEN.md](DEFINICIJA_3.0_ZAVRSEN.md) —
> jedini preostali tvrdi razlog zašto QBigTehn ne sme da se ugasi. Kad je ovo gotovo,
> deblokira se B2 (bigbit-bridge) i dalji lanac dekomisije.
> **Status:** kod sletanje ✅ · **živa sekvenca (koraci 0–10) NIJE izvršena** — čeka prozor.
> **Datum pripreme:** 2026-07-18.

---

## 1. Šta se menja (i šta se NAMERNO ne menja)

Modul Lokacije (1.0, tabele `loc_*` u sy15) zavisio je od QBigTehn-a u oba smera:

| Smer | Pre | Posle |
|---|---|---|
| **Ingest** („gde je deo na mašini") | MSSQL `tTehPostupak` → bridge (15 min) → `bigtehn_tech_routing_cache` → pg_cron `loc_bigtehn_ingest_run` | **2.0 `tech_processes` → `LocTpFeedService` (5 min) → ISTI cache → ISTI ingest** |
| **Outbound** (ručni pokreti nazad) | trigger → `loc_sync_outbound_events` → worker → MSSQL `sp_ApplyLocationEvent` | **ugašen** (queue zamrznut kao istorija) |

**Vodeći princip: menja se hranilica, ne motor.** Nizvodno od cache-a ništa se ne dira —
`loc_bigtehn_ingest_run` (osim jedne relaksacije gate-a, §2.1), parser `loc_bigtehn_parse_ident`,
placement trigger, watermark, admin RPC-ovi arm/run-now/status, RLS. Time 1.0 potrošači
(uklj. mobilni `/m/*` `myLokacije`, koji je još 1.0) ne vide nikakvu promenu semantike.

**Van opsega B1 (svesno):** bridge **CATALOGS** grupa ostaje živa do B2 — `bigtehn_items_cache`,
`customers`, `machines`… i dalje se pune iz QBigTehn-a preko Sync B. Gasi se **samo PRODUCTION**
grupa. (Verify nalaz: gašenje CATALOGS bi zamrzlo 7 kataloga sa živim potrošačima —
`plan-montaze` čita `customers_cache`, `plan-proizvodnje` `machines_cache`.)

### 1.1 Šta je isporučeno u kodu (već na `main`)

| Fajl | Uloga |
|---|---|
| `backend/src/modules/locations/loc-tp-feed.service.ts` | feeder 2.0 → sy15 cache (3 tabele), sopstveni watermark, holdback, storno filter, `bridge_sync_log` upis |
| `backend/src/modules/locations/loc-tp-feed.service.spec.ts` | testovi mapiranja/guard-a (Prisma-mock) |
| `locations.controller.ts` | `POST /api/v1/locations/sync/feed-run` (+`{confirm:true}`), `GET .../sync/feed-status` — `lokacije.admin` |
| `locations.service.ts` | `syncHealth`: `loc-sync-mssql` izbačen iz `workerHealthy`, drawings prag penzionisan |
| `backend/docs/sql/sy15/loc-most-repoint/*.sql` | žive SQL operacije (ručno psql-om — **nisu** migracije 2.0 baze) |

---

## 2. Rešeni rizici (zašto sekvenca izgleda ovako)

Sekvenca je prošla adversarijalnu verifikaciju; ovo su nalazi koji su promenili plan:

### 2.1 BLOKER — `skip_zero_qty` bi sistematski gutao transfere
2.0 pravi `tech_processes` red na **START-sken sa `piece_count = 0`** (kumulativ raste tek na
STOP/kontrolu). Feeder ga uhvati dok je 0; ingest u TRANSFER grani radi `skip_zero_qty` i
**trajno troši signal** (id-watermark ide napred). Rezultat bi bio: deo se skenira na M2, pokret
M1→M2 se nikad ne upiše, a svaki sledeći transfer polazi od pogrešne lokacije.
→ **Rešenje:** `30_ingest_relax_zero_qty.sql` — gate ostaje samo za `NULL`. Bezbedno jer se
`komada` u TRANSFER grani **ne koristi za količinu** (količina = zatečeni `v_current_qty`);
u 2.0 semantici START-sken jeste dokaz prisustva na mašini.

### 2.2 BLOKER — deljeni watermark bi progutao backlog
Legacy watermark = `started_at` poslednjeg **success** runa iz `bridge_sync_log`, a bridge upisuje
success i za **prazan** run svakih 15 min (izvor frozen). Feeder koji bi čitao odatle krenuo bi
od „pre par minuta" i backlog od 14.07 **nikad** ne bi ušao u cache.
→ **Rešenje:** sopstveni state `loc_tp_feed_state` (`10_feed_state_init.sql`). U `bridge_sync_log`
se i dalje **upisuje** (monitoring paritet), ali se odatle **ne čita**.

### 2.3 Dry-run cron bi pojeo backlog pre ARM-a
`loc_bigtehn_ingest_run` pomera watermark **i u dry-run-u**, a pg_cron ga vozi svakih 5 min → do
ARM-a bi sve već bilo „processed".
→ **Rešenje:** cron se **pauzira** pre prvog feed-a (`20_ingest_cron_pause.sql`), vraća tek posle
ARM-a. Cena: očekivan `worker_down` alert za `loc-bigtehn-ingest` dok traje pauza (§5).

### 2.4 Id-gap trka (timestamp feed vs id-watermark ingest)
Prisma interaktivna transakcija može commit-ovati red sa **manjim** id-jem posle reda sa većim →
ingest bi zaostalog suseda zauvek preskočio.
→ **Rešenje:** `cutAtHoldback` u feederu — hrani se strogo rastući prefiks stariji od **2 min**;
prvi „mlad" red seče i sve iza sebe.

### 2.5 Storno kontra-redovi
`storno()` pravi nov red sa **negativnim** `piece_count` i `finished_at = now` → ingest bi ga video
kao svež signal i napravio **pogrešan** transfer nazad na mašinu stornirane operacije.
→ **Rešenje:** feeder ne hrani redove sa `komada < 0` (ali **pomera** watermark preko njih).

### 2.6 Nepotpuno mapiranje bi slomilo 1.0 ekrane
Feeder piše **pun** legacy skup kolona (`item_id`, `customer_id`, `varijanta`, `naziv_dela`…),
jer 1.0 filtrira po `item_id`, a pickeri sortiraju po `modified_at`.

### 2.7 Kumulativ bez novog id-ja
`piece_count` raste UPDATE-om bez promene `entered_at` → delta bi ga promašila.
→ **Rešenje:** feeder uz deltu radi i **refresh** otvorenih (≤30 dana) i skoro zatvorenih redova.

### 2.8 Outbound dokaz
Nalaz „worker nikad nije radio" (1274 PENDING, `attempts=0`) odnosi se na **ServoTehERP** MSSQL,
ne QBigTehn — a `DEFINICIJA_3.0_ZAVRSEN.md` (18.07) tvrdi suprotno („još piše").
→ **Rešenje:** kolizija se razrešava **preflight-om (C2)** kao tvrdom kapijom, uz potvrdu Negovana.

---

## 3. Sekvenca

> Legenda: 🟢 reverzibilno · 🟡 traži verifikaciju pre nastavka · 🔴 poslovna odluka.
> SQL putanje su relativne na `backend/docs/sql/sy15/loc-most-repoint/`.
> psql: sy15 = `127.0.0.1:5436`, 2.0 = `127.0.0.1:5435` (ubuntusrv 192.168.64.28).

### 🟡 Korak 0 — Pre-flight (read-only)
1. `00_preflight_checks.sql` na obe baze; **snimiti kompletan izlaz**.
2. **Kapija (C2):** nijedan `SYNCED`/`IN_PROGRESS` red i nijedan `attempts>0` u
   `loc_sync_outbound_events`. Ako ima → outbound **nije** mrtav → koraci 8–9 se **ne rade** bez
   koordinacije sa Negovanom.
3. **Kapija (G):** nema 2.0 `tech_processes` redova sa `id ≤ cache_max_id` nastalih posle 14.07.
4. **Bridge VM 192.168.64.24** — potvrditi da `loc-sync-mssql` proces ne radi (stop + disable ako radi).
5. `DRY=1 ./monitor-sy15.sh` — snimiti **baseline** (šta je već u alarmu pre prelaza).
6. Negovan: potvrda da niko ne čita lokacijske podatke iz ServoTehERP-a.

### 🟢 Korak 1 — State tabela + rollback materijal
1. `01_originals_backup.sql` → izlaz snimiti kao `01_originals_LIVE_<datum>.sql` **i commit-ovati**.
2. `10_feed_state_init.sql` (seed = zatečeni max iz cache-a → backlog od 14.07 ulazi u feed).
3. Provera: `GET /api/v1/locations/sync/feed-status` → `initialized: true`.

### 🟡 Korak 2 — Pauza ingest cron-a
`20_ingest_cron_pause.sql`. Od sada teče prozor u kom se očekuje `worker_down` šum (§5).

### 🟢 Korak 3 — Relaksacija zero-qty gate-a
`30_ingest_relax_zero_qty.sql` (skripta sama puca ako živa definicija ne odgovara očekivanoj).

### 🟡 Korak 4 — Prvi feed (ručno)
`POST /api/v1/locations/sync/feed-run` sa `{"confirm": true}` kao `lokacije.admin`.
Verifikacija:
- odgovor: `tp.fed` > 0 (backlog), `stornoSkipped` očekivan, `heldBack` mali;
- spot-check 3 reda: `bigtehn_tech_routing_cache` vs `tech_processes` (id, `machine_code`,
  `komada`, `started_at` — **isti trenutak**, bez ±2h pomaka);
- `bigtehn_work_orders_cache`: novi RN ima `item_id` i `naziv_dela` (ne NULL);
- `bridge_sync_log`: novi `success` redovi pod legacy imenima;
- `GET /locations/sync/health` → `cacheStale.rn/linije/tp = false`.

### 🟡 Korak 5 — Dry-run ingest nad novim feedom
`POST /locations/sync/run-now` (`armed` je i dalje FALSE) → pregledati `last_run_summary`:
- `by_action`: `chain_transfer`/`shelf_transfer`/`initial_placement` smisleni;
  `skip_zero_qty` treba da bude **≈0** (dokaz da §2.1 radi);
- `no_machine_loc` / `no_rn_in_cache` / `skip_bad_ident` niski — svaki nenulti proveriti u `samples`;
- ako `no_machine_loc` > 0: nedostaje MACHINE lokacija → dodati je u 1.0 UI
  (Podešavanja → Mašine; `maint_machines` trigger je sinhronizuje), pa ponoviti.
⚠️ **Svaki `run-now` pomera watermark** — ne petljati serijski pre odluke iz koraka 6.

### 🔴 Korak 6 — Odluka o backlog-u (Nenad)
**(A) backfill** — ingest svari zaostatak, auto-pokreti sa `moved_at` u prošlosti; poravnava
lance mašina, ali može praviti transfere koji su već **ručno** izvedeni → najaviti korisnicima.
**(B) start „od sada"** — `60_advance_watermark.sql`; ručno stanje ostaje istina.
*Preporuka: (B), pošto je ručno održavanje bilo aktivno; backfill nosi rizik duplog kretanja.*

### 🟡 Korak 7 — ARM + vraćanje cron-a
1. `POST /locations/sync/arm` `{"armed": true}`.
2. `20_ingest_cron_pause.sql` (donji deo) — vratiti `active = true`.
3. Nadzor 3–4 ciklusa: novi `loc_location_movements` sa `source='bigtehn'`, `loc_item_placements`
   bez duplikata, `armed_errors = 0`, heartbeat ponovo napreduje, mobilni `/m/*` prikaz ispravan.

### 🟢 Korak 8 — Cron feed-a (systemd timer, ubuntusrv)
5-minutni timer koji zove `feed-run`. **Auth:** koristiti mehanizam dogovoren u §4 (otvoreno
pitanje — do tada feed ide ručno). Posle instalacije pratiti `feed-status` 1–2h.

### 🟡 Korak 9 — Gašenje legacy PRODUCTION feeda
`~/servoteh-bridge/.env` → `ENABLE_JOB_PRODUCTION=false` (**`ENABLE_JOB_CATALOGS` ostaje `true`**,
§1) + `systemctl --user restart servoteh-bridge`. Potvrditi da KATZE i dalje radi i da
`monitor-sy15.sh` ne pravi **novi** alarm u odnosu na baseline iz koraka 0.

### 🟡 Korak 10 — Gašenje outbound-a
Samo ako kapija (C2) iz koraka 0 i dalje važi: `40_trigger_drop_outbound_enqueue.sql`, pa
`50_heartbeat_cleanup.sql`. Verifikacija: ručni pokret kroz UI → placement se menja, **nov red u
`loc_sync_outbound_events` NE nastaje**, count zamrznut.

### Korak 11 — Soak i zatvaranje
7 dana: ingest heartbeat živ, `loc_sync_alerts_outbox` prazan, monitor tih, korisnici bez pritužbi
na pogrešne lokacije. Zatim: `DEFINICIJA_3.0_ZAVRSEN.md` B(1) → DONE, `docs/RADNI_PLAN_3.0.md` B1 →
✅ → **B2 (bigbit-bridge) je deblokiran**.

---

## 4. Otvorena pitanja (blokiraju samo navedeni korak)

| # | Pitanje | Blokira | Ko |
|---|---|---|---|
| 1 | **Auth za feed cron.** `POST /work/auto-close` je po ODLUKE #24 namerno bez crona, pa „isti mehanizam kao auto-close" **ne postoji**. Opcije: servisni nalog + login u timer skripti · dugoživeći scoped token · localhost-only ruta sa network guardom · `@nestjs/schedule` in-process (odstupa od #24). | korak 8 (do tada ručni feed) | Nesa/Nenad |
| 2 | **Backlog: (A) ili (B)?** | korak 6 | Nenad |
| 3 | **Granularnost signala:** je li legacy `tTehPostupak` dobijao NOV red po svakoj prijavi (uklj. povratak na istu mašinu) ili jedan po (trojka, op, RC) kao 2.0 `create-on-scan`? Ako je legacy imao više — A→B→A gubi drugi dolazak na A i treba v2 dohrana iz `work_time_entries` (svaki START = red). Indicija iz 2.0 komentara: paritet, ali dokaz iz legacy APL-a fali. | ne blokira prelaz; presuđuje da li ide v2 | Negovan / `_legacy/APL` |
| 4 | **ServoTehERP potvrda** (§2.8). | korak 10 | Negovan |

---

## 5. Očekivani „šum" (da se ne pomeša sa kvarom)

- **Dok je ingest cron pauziran** (koraci 2–7): `worker_down` alert za `loc-bigtehn-ingest`
  (prag 10 min, dedup po danu) + `monitor-sy15.sh` heartbeat alarm (15 min). **Očekivano.**
- **Vikend/praznik:** `monitor-sy15.sh` alarmira ako `bigtehn_work_orders_cache.synced_at`
  stariji od 6h — feeder je delta-only, pa bez izmena RN-a `synced_at` ne napreduje. Isto kao pre
  cutover-a; svesno prihvaćeno.
- **`GET /locations/sync/outbound`** i dalje prikazuje ~1274 PENDING — to je **zamrznuta istorija**,
  ne zaostatak.

## 6. Rollback

| Sloj | Kako |
|---|---|
| Feed/ingest | `arm {armed:false}` (trenutno) · stop `loc-tp-feed.timer` · `~/servoteh-bridge/.env` nazad na `ENABLE_JOB_PRODUCTION=true` + restart. Watermark se **ne** vraća unazad; upsert po PK znači da ponovni feed ne duplira. Pogrešni auto-pokreti se ispravljaju `CORRECTION` pokretom, **ne** brisanjem ledgera. |
| Ingest fn / trigger | `01_originals_LIVE_<datum>.sql` (`CREATE OR REPLACE` vraća zatečene definicije). |
| Backend | `git revert` + redeploy kroz Actions; feed endpointi nestaju, ostali sync endpointi netaknuti. |

⚠️ Rollback bridge-a je validan **samo dok je `tTehPostupak` frozen** (jeste, od 14.07): deljena
imena jobova u `bridge_sync_log` znače da je bridge watermark „zagađen" feeder runovima, pa bi
bridge preskočio starije MSSQL redove — bezopasno samo zato što ih nema.

**Tačka bez povratka ne postoji:** jedina destruktivna operacija bila bi brisanje queue redova,
a to se namerno **ne radi** (ostaju do B3).

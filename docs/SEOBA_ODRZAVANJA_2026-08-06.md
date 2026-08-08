# Seoba održavanja (CMMS) na 3.0 bazu — merenje, priprema i runbook (06.08.2026)

**Korak 2** iz [PLAN_GASENJA_SY15_2026-08-03.md](PLAN_GASENJA_SY15_2026-08-03.md), posle
koraka 1 (sastanci + PB, [SEOBA_SASTANCI_PB_2026-08-05.md](SEOBA_SASTANCI_PB_2026-08-05.md)).

**Ništa od ovoga nije primenjeno na produkciji.** Sve merenje je rađeno `SELECT`-om nad živom
sy15 bazom; migracija i prenos su napisani i dokazani na *odvojenoj probnoj bazi*
(`odrzavanje_proba`, napravljena i obrisana u toku rada).

> **Nijedan broj ovde ne dolazi iz `pg_stat`** — sve je `count(*)`, `pg_constraint`,
> `pg_indexes`, `pg_trigger`, `pg_policies`, `pg_depend`, `pg_attrdef`, `pg_get_functiondef`.
> (Pouka: [PLAN_GASENJA §1 nalaz 2](PLAN_GASENJA_SY15_2026-08-03.md) — `n_live_tup` nije broj redova.)

---

## 1. Merenje — 34 tabele, 764 reda

`count(*)` nad živom sy15, 06.08.2026.

| Tabela | redova | | Tabela | redova |
|---|---:|---|---|---:|
| `maint_assets` | 142 | | `maint_vehicle_service_plan` | 4 |
| `maint_work_orders` | 134 | | `maint_documents` | 3 |
| `maint_machines` | 87 | | `maint_machine_notes` | 3 |
| `maint_vehicle_tires` | 76 | | `maint_notification_rules` | 3 |
| `maint_incident_events` | 60 | | `maint_machine_status_override` | 2 |
| `maint_machine_files` | 58 | | `maint_machines_deletion_log` | 1 |
| `maint_notification_log` | 48 | | `maint_settings` | 1 |
| `maint_vehicle_details` | 46 | | **`maint_wo_number_counter`** | **1** |
| `maint_drivers` | 30 | | `maint_asset_service_plan` · `maint_checks` · `maint_facility_details` · `maint_locations` · `maint_part_stock_movements` · `maint_part_vehicles` · `maint_parts` · `maint_suppliers` · `maint_tasks` · `maint_vehicle_bookings` · `maint_wo_labor` · `maint_wo_parts` | 0 |
| `maint_incidents` | 21 | | | |
| `maint_vehicle_owners` | 14 | | | |
| `maint_wo_events` | 13 | | | |
| `maint_user_profiles` | 9 | | | |
| `maint_it_asset_details` | 8 | | | |

### 🔴 Nalaz 1: 34 tabele, a ne 33 — i promašena je baš ona sa brojačem

Polazni spisak zadatka imao je 33 tabele, jer je izveden iz `prisma/sy15.prisma`, a taj
fajl **namerno nema model** za `maint_wo_number_counter` (deny-all RLS; upis samo kroz
trigger). Ta jedna tabela nosi **BROJAČ RADNIH NALOGA**:

| | izmereno |
|---|---|
| `maint_wo_number_counter` | `year = 2026`, `last_value = 134` |
| naloga sa brojem | **134 / 134** (nijedan bez broja) |
| poslednji broj | `WO-2026-00134` |

Da se ta tabela ne prenese, trigger bi posle preklopa krenuo od `WO-2026-00001` i **sudario
se sa postojećim brojevima** — parcijalni unique nad `wo_number` bi to pretvorio u 500-ku na
prvom novom nalogu.

> **Pouka je ista kao u koraku 1** (`akcioni_plan_istorija`, 689 redova): domen se ne
> popisuje po spisku modela ni po prefiksu imena, nego po **katalogu baze + pozivima iz
> koda**. Ovde je `pg_class` dao tabelu koju Prisma model nije.

### Obim logike (mereno, ne procenjeno)

| Šta | Koliko |
|---|---:|
| tabele | **34** |
| redova | **764** |
| FK ka `auth.users` | **46** |
| FK unutar domena | **37** |
| **inbound FK ka `maint_*`** | **0** |
| CHECK ograničenja | 53 |
| indeksi | 81 |
| trigeri | **34** (18 `touch_updated_at` + 1 broj naloga + 4 guarda tipa + **11 logike**) |
| RLS politike | **102** na 34 tabele (svih 34 ima `relrowsecurity`) |
| view-ovi | **17** (16 `v_maint_*` + `v_rev_machines`) |
| PG enum tipovi | **23** |
| funkcije sa prefiksom `maint_` | **43** (41 `SECURITY DEFINER`) |
| 🔴 funkcije BEZ prefiksa koje diraju `maint_*` | **16** |
| pg_cron poslova u sy15 za ovaj domen | **0** (pogon je u 3.0 scheduleru, Talas A) |
| storage | `maint-machine-files` — 59 objekata / **469 MB** |
| ključeva u sy15 registru idempotencije | 21 `odrzavanje.*` (od 663 ukupno) |

### 🔴 Nalaz 2: funkcija je 59, ne 43 — 16 ih nema prefiks domena

Upit po prefiksu (`proname LIKE 'maint%'`) daje 43. Upit po **telu** (`prosrc ~ 'maint_'`)
nalazi još 16 koje domen dodiruju a ne nose mu ime:

`ai_chat_asset_resolve` · `ai_chat_kvar_istorija` · `ai_chat_maint_resolve` ·
`ai_chat_masina_info` · `ai_chat_masina_uputstvo` · `ai_chat_prijavi_kvar` ·
`archive_maint_asset` · `archive_maint_vehicle` · `create_maint_facility` ·
`create_maint_it_asset` · `create_maint_vehicle` · `ensure_asset_service_wos` ·
`ensure_vehicle_service_wos` · `restore_maint_asset` · `restore_maint_vehicle` ·
`trg_maint_wo_asset_service_plan_completion`

Šest od njih su `ai_chat_*` — tj. **AI-asistent je drugi potrošač ovog domena** (v. §4).

---

## 2. Mapa identiteta — 21/21, i domen NE ČEKA kadrovsku

### 2.1 `auth.users` uuid → 3.0 `users.id`

Sve spoljne veze domena (46 FK kolona) idu **isključivo** ka `auth.users` — nema nijedne ka
`employees`, `projects` ili bilo kom drugom domenu.

| Provera | Rezultat |
|---|---|
| različitih `auth.users` naloga koje domen koristi | **21** |
| od toga sa redom u sy15 `auth.users` | 21 |
| **od toga sa parnjakom u 3.0 `users` po mejlu** | **21 / 21** |

Uparivanje koristi **postojeći** helper `backend/scripts/lib/sy15-identity.ts`
(`buildUserMaps`) — napravljen za korak 1 i **nije menjan**. Pošto održavanje nema veze ka
`projects`/`employees`, `buildProjectMap` mu ne treba.

Dva naloga zaslužuju napomenu, oba se razrešavaju: `ai-maint-test@servoteh.local` (nalog
testa AI-prijave, `users.id = 56`) i `stamenic4@gmail.com` (`users.id = 39`).

### 2.1b 🔴 Mapa identiteta je bila SAMO OFFLINE — zato su upisi padali sa 422 (rešeno 08.08.)

`buildUserMaps` postoji **van runtime-a**: prenosna skripta ga pozove, razreši uuid → Int i
upiše rezultat. **U bazi od toga nije ostajalo ništa** — izmereno 08.08.2026, 3.0 `users` je
imao tačno ove kolone: `id, email, password_hash, full_name, role, active, email_verified_at,
last_login_at, created_at, updated_at, worker_id, must_change_password`. Nijedne sa sy15 uuid-om.

Posledica na živom radu: DTO polja koja nose čoveka (`responsibleUserId`, `assignedTo`) su
`@IsUUID()`, pa je `OdrzavanjeService.id30` pod `ODRZAVANJE_IZVOR=3.0` **GLASNO padao sa 422
na 5 mesta** (createMachine, updateMachine, updateIncident, updateWorkOrder ×2). Pad je bio
svesna odluka — tiho `null` bi značilo „nalog sačuvan, dodela nestala" — ali je time
**dodela radnog naloga čoveku i postavljanje odgovornog za mašinu bili neupotrebljivi**.

Rešeno uvođenjem `users.sy15_user_id` (`uuid`, NULL dozvoljen, `uq_users_sy15_user_id`):

| Merenje 08.08.2026 (`ANALYZE` pa `count(*)`, ne `n_live_tup`) | |
|---|---:|
| 3.0 `users` | **71** (svi aktivni, 71 različit mejl) |
| sy15 `auth.users` | **62** (svi sa mejlom) |
| poklapanje po `lower(btrim(email))` | **61 / 62 (98 %)** |
| sy15 naloga bez 3.0 parnjaka | **1** — `bigtehn-worker@system.local` |
| 3.0 naloga bez sy15 parnjaka | **10** |

- **NULL je ispravno stanje, ne kvar.** Deset 3.0 naloga nikad nije imalo sy15 parnjaka
  (71 vs 62); `NOT NULL` bi bio laž o podatku.
- **`bigtehn-worker@system.local` OSTAJE bez parnjaka.** To je sistemski nalog BIGTEHN mosta,
  a most je ugašen 07.08.2026. Pravljenje 3.0 naloga za mrtav sistem uvelo bi novo stanje koje
  niko nije tražio; nalog bez ijedne dodele ionako nema šta da prevede. Nije prećutan —
  migracija ga PRIJAVLJUJE (`RAISE WARNING`), i skripta ga ispisuje kao napomenu.
- Popuna: migracija `20260808100000_users_sy15_user_id_prevod_identiteta` (DDL + 61 par
  izmeren sa žive sy15; spajanje se obavlja NA CILJU po `lower(btrim(email))`, pa promenjen
  mejl ne prođe tiho nego se prijavi). Održavanje veze posle toga:
  `backend/scripts/povezi-identitet-sy15.ts` (dry-run podrazumevan, `--apply` upisuje) —
  koristi **isti** `scripts/lib/sy15-identity.ts`, bez druge kopije pravila uparivanja.
- Runtime: `backend/src/common/identity/sy15-user-id.ts`. Uuid **sa** parnjakom → `users.id`;
  uuid **bez** parnjaka → i dalje 422, ali sada sa imenovanim uuid-om i uputstvom. Broj i
  izostavljeno polje se ponašaju kao pre.

### 2.2 🔴 Presuda: održavanje se može preseliti PRE kadrovske

Kod sastanaka je Projektni biro pao na tome što `pb_current_employee_id()` traži tabelu
`employees`. Ista provera za održavanje, nad živom sy15 (regexp nad `prosrc` svih `maint*`
funkcija za `employees`/`departments`/`profiles`):

```
(0 rows)
```

**Nijedna `maint*` funkcija — ni gejt, ni akciona, ni trigger — ne pominje kadrovsku.**
Identitet se razrešava preko `auth.uid()` → `maint_user_profiles` i `auth.jwt() ->> 'email'`
→ `public.user_roles`. Oba parnjaka 3.0 **već ima**.

To je bitna razlika prema PB-u: **korak 2 ne zavisi od koraka 4.**

### 2.3 🔴 Nalaz 3: odakle se čita ERP rola — merenje je oborilo doslovan prepis

sy15 gejtovi (`maint_is_erp_admin`, `maint_is_erp_admin_or_management`,
`maint_has_floor_read_access`) gledaju sy15 `public.user_roles` po mejlu iz JWT-a.
3.0 `user_roles` ima **drugi oblik** (`user_id`, `scope_type`/`scope_id` — nema ni `email`
ni `project_id`) i, što je važnije, **drugu popunjenost**:

| izvor rola | globalnih aktivnih |
|---|---:|
| sy15 `user_roles` | **60** |
| 3.0 `user_roles` SAM | **11** |
| 3.0 `users.role` ∪ `user_roles.role` | 71 korisnika / 17 rola |

**Doslovan prepis „čitaj `user_roles`" srezao bi `floor_read` sa 35 ljudi na ~11** — dvadesetak
ljudi bi pod `3.0` tiho ostalo bez pristupa održavanju. U 3.0 je PRIMARNA rola `users.role`,
a `user_roles` je tabela *dodatnih* rola.

Zato je parnjak **unija** obe. Kontrolno merenje po mejlovima:

| gejt | sy15 danas | 3.0 (unija) |
|---|---:|---:|
| `floor_read` | **35** | **34** |

Razlika je **tačno jedan nalog**: `kontrola@servoteh.com` (u 3.0 ima rolu `kontrolor`, koja
nije u floor-read spisku). **Nijedan nalog ne DOBIJA pristup koji danas nema** — greška ide u
bezbednom smeru. Da li `kontrolor` treba u floor-read je odluka o proizvodu → **prosleđena,
ne doneta** (§8).

---

## 3. FK šavovi — čist domen po FK grafu

### Ka spolja (domen → van domena)

| Cilj | FK-ova | Ocena |
|---|---:|---|
| `auth.users` | **46** | 🟢 rešeno — Int FK na `users.id`, 21/21 (§2.1) |
| bilo šta drugo | **0** | — |

ON DELETE raspodela je prepisana sa žive baze, ne izmišljena: **40 × SET NULL, 5 × RESTRICT**
(`maint_checks.performed_by`, `maint_incidents.reported_by`, `maint_machine_notes.author`,
`maint_machine_status_override.set_by`, `maint_work_orders.reported_by`), **1 × CASCADE**
(`maint_user_profiles.user_id`, koji je i PK).

### Ka unutra (van domena → domen)

**0 FK-ova.** Nijedna tuđa tabela ne referencira `maint_*`.

### Kolone koje LIČE na vezu a nisu

| Kolona | Šta je stvarno |
|---|---|
| `maint_machines.department_id` | **TEKST** („01".."21"), izveden iz šifre mašine (`maint_machine_dept_code`). NIJE FK i nijedan gejt ga ne koristi. Nije veza ka kadrovskoj. |
| `maint_it_asset_details.assigned_to` | slobodan tekst „kome je dodeljeno" — nije nalog |
| `maint_documents.entity_id` | polimorfni pokazivač, pokriven CHECK-om |

---

## 4. 🔴 Nalaz 4: domen NIJE samostalan — tri šava koje FK graf NE POKAZUJE

Polazna pretpostavka zadatka bila je „ČIST, samostalan domen; nema nijednog inbound FK-a".
**Po FK grafu je to tačno. Po view/triger/poziv grafu nije.** Šavovi su nađeni tek
`pg_depend`-om nad view-ovima i `grep`-om nad `backend/src`:

| # | Šav | Kako je nađen | Zašto je opasan |
|---|---|---|---|
| **a** | `v_rev_machines` je doslovno `SELECT … FROM maint_machines`, a **Reversi (korak 3) čitaju mašine kroz njega** (`reversi.service.ts` → `reportMachines`) | `pg_depend` nad view-ovima | Čim mašine pređu u 3.0, sy15 kopija prestaje da se menja → Reversi bi **tiho** prikazivali zastarelo stanje (preimenovana mašina pod starim imenom, novoarhivirana kao aktivna, nova da ne postoji) |
| **b** | triger `maint_machines_sync_to_loc` **PIŠE u `public.loc_locations`** (domen Lokacije, korak 3) na svaki INSERT/UPDATE mašine | `pg_trigger` + telo | Održavanje piše u TUĐI domen. Izmereno: 86/86 aktivnih praćenih mašina ima red u `loc_locations` (90 `MACHINE` lokacija ukupno) |
| **c** | `ai_chat_prijavi_kvar` radi **`INSERT INTO maint_incidents`** — AI-asistent PIŠE u ovaj domen iz drugog modula | `prosrc` + `grep` | Pod `3.0` bi prijave kvara kroz asistenta i dalje išle u sy15 dok modul piše u 3.0 → **dve istine o kvarovima, bez ijedne greške u logu** |

Četvrta, blaža: `maint_machines_import_from_cache` i `v_maint_machines_importable` čitaju
`public.bigtehn_machines_cache` (90 redova) — spoljni katalog mašina, nije `maint_*`.

> **Pouka:** „nema inbound FK-a" **nije** dokaz odvojivosti. Vlasništvo nad podatkom se
> proverava i preko `pg_depend` (view-ovi), `pg_trigger` (upisi u tuđe tabele) i `prosrc`
> (funkcije bez prefiksa domena).

---

## 5. Prekidač `ODRZAVANJE_IZVOR` — dizajn koji prati POZIVAOCE

### 5.1 Merenje pre uvođenja (obavezno, po pouci incidenta 06.08.)

`grep -o "maint_[a-z_]*"` nad **celim** `backend/src` (ne samo nad `modules/odrzavanje`) daje
pet mesta koja stvarno dodiruju domen:

| # | Gde | Šta | Pod prekidačem? |
|---|---|---|---|
| 1 | `modules/odrzavanje/*` | 121 `withUserMapped` + 24 `runIdem`; **0 direktnih sirovih sy15 poziva mimo njih** | ✅ da |
| 2 | `scheduler/sy15-cron-jobs.ts` | posao `maint-deadlines` (`maint_check_all_deadlines(30)`) | ✅ da |
| 3 | `scheduler/dispatch/notify-dispatch.service.ts` | **samo** `dispatchMaint()` | ✅ da |
| 4 | `ai-chat/tools/sy15-tools.ts` | 5 alata: `masina_info`, `kvar_istorija`, `masina_uputstvo`, `prijavi_kvar`, `trosak_sredstva` | ✅ da (§4c) |
| 5 | `reversi/reversi.service.ts` | `reportMachines()` → `v_rev_machines` | ✅ da (§4a) |

Uz to, tri mesta koja `maint_` pominju **samo u komentarima** i ne diraju podatke:
`common/authz/permissions.ts`, `roles.ts`, `role-permissions.ts`. Ne diraju se.

### 5.2 Šta prekidač NAMERNO NE dodiruje

`notify-dispatch.service.ts` drži **tri** outbox-a. Pod `ODRZAVANJE_IZVOR` ide **isključivo**
`dispatchMaint()`; `dispatchKadr()` je kadrovska (korak 4), `dispatchPb()` je pod `PB_IZVOR`.
Isto u `sy15-cron-jobs.ts`: od 22 posla samo `maint-deadlines` je ovaj domen. Taj fajl je
sada **jedino mesto u kodu koje drži sva tri prekidača** — i to je namerno vidljivo.

### 5.3 Ponašanje

`ODRZAVANJE_IZVOR=sy15` (**podrazumevano, i za svaku neprepoznatu vrednost**) = kao do sada.

`ODRZAVANJE_IZVOR=3.0` = sve gorenavedeno vraća **503 sa imenom putanje** i uputstvom za
povratak. Logika još nije prepisana (v. §7), pa je to **brana, ne radno stanje**.

Zajedničko telo je postojeći `backend/src/common/sy15/izvor-prekidac.ts` — nije pisano
iznova. `OdrzavanjeSourceService` **ne čita** zastareli `SASTANCI_PB_IZVOR` (isti razlog kao
`PbSourceService`: stari naziv ne sme da pomeri tuđ domen).

---

## 6. Šta je urađeno u ovoj grani (`feat/sy15-seoba-odrzavanje`)

| Šta | Gde | Stanje |
|---|---|---|
| 34 Prisma modela | `backend/prisma/schema.prisma` | ✅ `prisma validate` čist |
| Migracija (34 tabele, 46+37 FK, 87 CHECK, 120 indeksa, 23 trigera, 26 DB default-a) | `backend/prisma/migrations/20260806140000_odrzavanje_seoba_sy15/` | ✅ **primenjena na probnu bazu, NE na prod** |
| Skripta prenosa | `backend/scripts/migrate-odrzavanje-sy15.ts` | ✅ dry-run + `--apply` + `--verify-only` + `--show-columns` |
| Prekidač `ODRZAVANJE_IZVOR` | `backend/src/common/sy15/odrzavanje-source.service.ts` | ✅ nezavisan, bez alias-a |
| 3.0 parnjak RLS-a i gejtova | `backend/src/modules/odrzavanje/odrzavanje-authz.service.ts` | ✅ 9 gejtova + scope-ovi, 58 testova |
| Env red | `backend/.env.example` | ✅ |
| Zajednički helper identiteta | `backend/scripts/lib/sy15-identity.ts` | ✅ **ponovo iskorišćen, nije menjan** |

### Prenosne odluke (sve izmerene)

1. **UUID PK-ovi se zadržavaju** → prenos je egzaktno idempotentan (upsert po ključu), bez remap tabele.
2. **46 kolona `auth.users` → `users.id`** (Int), ON DELETE prepisan sa žive baze. FK-ovi su
   **SQL-only**: 46 Prisma relacija tražilo bi 46 povratnih polja na `User`, a modul ih nikad
   ne džoinuje (imena autora rešava batch-om).
3. **23 PG enuma → String + CHECK** (BACKEND_RULES §2.2), isti skup vrednosti, `VarChar(20)`
   (najduža vrednost `motor_transmisija` = 17).
4. **37 unutrašnjih FK-ova ostaju prave Prisma relacije** — njih modul prati.
5. **RLS se ne prenosi** (102 politike) → `OdrzavanjeAuthzService`.
6. **Trigeri se dele:** mehanika se prenosi (18 `touch_updated_at`, dodela broja naloga, 4
   guarda tipa sredstva), **logika se prepisuje** (11 trigera, spisak u migraciji §6b).
7. **Fajlovi ostaju u sy15 storage-u** — prenose se samo putanje.

### 🔴 Nalaz 5: Prisma `@default(uuid(4))` je KLIJENTSKI — 26 kolona je izgubilo DB default

`prisma migrate diff` je napravio uuid PK kolone **bez `DEFAULT`**, jer Prisma tu vrednost
generiše u klijentu. Živa sy15 te kolone ima sa `DEFAULT gen_random_uuid()` — izmereno
`pg_attrdef`: **26 kolona** (25 uuid + `maint_assets.qr_token` kao `(gen_random_uuid())::text`).

Uhvaćeno **na probnoj bazi**, ne pretpostavljeno: prvi `INSERT` mimo Prisma klijenta pao je sa
`null value in column "qr_token" violates not-null constraint`. Bez toga bi svaki upis koji ne
ide kroz Prisma Client (prenosna skripta, ručni `INSERT` u održavanju produkcije, trigger koji
piše u drugu tabelu) padao. Default-i su vraćeni ručno u migraciji, §4b.

### 🔴 Nalaz 6: „Objekti" na produkciji NIKAD nisu radili — nađeno usput

| Merenje | Rezultat |
|---|---|
| kolone `maint_facility_details` u živoj sy15 | **14** — `cadastral_parcels` NIJE među njima |
| `prisma/sy15.prisma` | deklariše `cadastralParcels @map("cadastral_parcels")` |
| `odrzavanje.service.ts:3476` | upisuje `cadastralParcels` pri SVAKOM čuvanju detalja objekta |
| `maint_assets` tipa `facility` | **0** |
| `maint_facility_details` | **0 redova** |

Prisma dakle šalje `cadastral_parcels` u `INSERT`/`UPDATE`, baza vraća **42703**, a
`rethrowSy15` taj SQLSTATE ne mapira → **500**. Zato u modulu Objekti nema ni jednog
sačuvanog reda. **Nije posledica ovog rada** — zatečeno stanje koje je merenje kolona otkrilo.

Odluka: kolona **ostaje u 3.0 modelu** (FE je nudi kao „Katastarske parcele", pa preklop taj
ekran usput popravlja), a prenos je **preskače** (`skip`) jer je u izvoru nema. Popravka za
`sy15` stranu je odluka o proizvodu → §8.

### 🔴 Nalaz 7: jedina nullable array kolona i CHECK koji brani prazan niz

`maint_drivers.drivers_license_categories` je **jedina** nullable array kolona domena
(ostale 4 su `NOT NULL DEFAULT '{}'`), i izmereno je **30/30 redova NULL**.

Prisma ne ume `null` u skalarnom nizu (`String[]` je u klijentu uvek non-null), a zamena
`NULL → []` **nije opcija**: CHECK `maint_drivers_license_cats_nonempty`
(`IS NULL OR cardinality > 0`) izričito zabranjuje prazan niz. Skripta zato **izostavlja polje**
iz upisa — kolona ostaje NULL, kao u izvoru.

### Dokaz izvodljivosti (izvršen, ne pretpostavljen)

Napravljena je **odvojena baza `odrzavanje_proba`** (servosync-pg kluster, kroz SSH tunel),
primenjen **ceo lanac migracija** (112 migracija, `migrate status` → „Database schema is up to
date!", bez drift-a), učitani FK ciljevi (`users` 71, `workers` 174 — kopija sa produkcije), pa
je skripta pročitala **živu sy15** (samo SELECT) i upisala:

| Provera | Rezultat |
|---|---|
| struktura | 34 tabele · 46 FK ka `users` (40 SET NULL / 5 RESTRICT / 1 CASCADE) · 37 unutrašnjih FK · 87 CHECK · 120 indeksa · 23 trigera |
| mapa identiteta | **21/21**, sekcija BLOKADE prazna |
| dry-run | `read=782` (764 reda + 18 popravki kružnih veza) |
| **`--apply`** | **34/34 tabela se poklapa** |
| brojač naloga | `sy15=2026:134` = `3.0=2026:134` ✅ |
| kružne veze nalog↔incident | `sy15=9/9` = `3.0=9/9` ✅ |
| **drugo pokretanje `--apply`** | **`ins=0 upd=782`** — idempotencija je egzaktna |

Uz to 7 ponašajnih proba na istoj bazi (sve prošle): DB default za uuid + `qr_token` ·
numeracija `WO-2026-00001`/`00002` i brojač na 2 · CHECK odbija nevalidan `priority` (23514) ·
guard tipa sredstva odbija `vehicle_details` nad mašinom · RESTRICT FK zaustavlja brisanje
korisnika sa nalogom · `touch_updated_at` pomera `updated_at` · unique nad `lower(asset_code)`
odbija duplikat.

**Probna baza je posle dokaza obrisana.**

### Provere

| Provera | Rezultat |
|---|---|
| `npx tsc --noEmit` | ✅ **nula NOVIH grešaka.** Ostaju 4 **zatečene** grupe u **spec** fajlovima (`handovers/handover-draft-print`, `kadrovska.zahtev-026`, `kamata`, `moj-profil.zahtev-026`) — dokazano `git diff --name-only HEAD` da nijedan od njih NIJE u diff-u ove grane |
| `npx jest` (pun set) | ✅ **263 suite / 5.713 testova** (+3 suite, +86 testova prema 260/5.627) |
| `npm run build` | ✅ entrypoint `dist/main.js` |
| ceo lanac migracija | ✅ 112 migracija, `migrate status` čist, bez drift-a |
| 🔴 **boot-smoke `node dist/main` u OBA položaja** | ✅ „Nest application successfully started" protiv **posebno migrirane probne baze**, i sa `ODRZAVANJE_IZVOR=sy15` i sa `=3.0`: **0 ERROR redova**, 22 posla registrovana |
| 🔴 **dokaz razdvojenosti prekidača** | ✅ pod `=3.0` u logu upozorava **SAMO** `OdrzavanjeSourceService` (4 instance: održavanje, scheduler, ai-chat, reversi); pod `=sy15` **nula** upozorenja bilo kog prekidača |

---

## 7. 🔴 ŠTA OSTAJE ZA PREKLOP (pun spisak)

Prenos **podataka** je gotov i dokazan. Modul pod `3.0` **još nije prepisan** — ovo je
rangirano po tome šta zaustavlja preklop.

| # | Blokada | Obim (mereno) | Procena |
|---|---|---|---:|
| **1** | **145 poziva kroz dva branjena getera** (`withUserMapped` 121 + `runIdem` 24) treba prevesti na 3.0 Prisma put | 149 REST ruta | 3–5 dana |
| **2** | **14 DEFINER funkcija koje kod STVARNO zove** (od 43): `maint_machine_rename` (3 mesta), `maint_machine_delete_hard`, `maint_machines_import_from_cache`, `maint_create_preventive_work_order`, `maint_attach_incident_files`, `maint_notification_retry`, `maint_check_vehicle_deadlines`, `ensure_vehicle_service_wos`, `ensure_asset_service_wos`, `maint_assignable_users` + 4 gejta | najveća je `maint_check_vehicle_deadlines` (9.595 znakova, 3 petlje + enqueue) | 3–4 dana |
| **3** | **11 „logika" trigera** — auto-nalog iz incidenta, enqueue obaveštenja + delay, 2 audit traga, denormalizacija `asset_id`, kreiranje sredstva uz mašinu, `current_stock += delta`, 2 × zatvaranje roka plana, guard rola profila | v. migracija §6b | 2 dana |
| **4** | **13 view-ova `v_maint_*`** (čitani na 30 mesta). **Svi su `security_invoker = true`** — RLS se primenjivao I KROZ VIEW, pa scope MORA eksplicitno u upit | + tranzitivno `v_maint_machine_last_check` | 1–2 dana |
| **5** | **Registar idempotencije**: 24 `runIdem` poziva sa 23 različite `action` vrednosti trenutno pišu u sy15 `rev_api_idempotency`. 3.0 već ima **generički** `api_idempotency` + `IdempotencyService` (`common/idempotency/`, iz koraka 1) — treba samo zameniti poziv. **Ništa se ne dodaje**, i stari ključevi se NE prenose | 21 ključ u sy15 | ~2 h |
| **6** | 🔴 **Šav ka Lokacijama** (§4b): triger `maint_machines_sync_to_loc` piše u `loc_locations`. Pod `3.0` mašine su u 3.0, a `loc_locations` još u sy15 — **traži odluku**, ne samo prepis | 86/86 mašina | odluka |
| **7** | 🔴 **Šav ka Reversima** (§4a): `v_rev_machines`. Brana je postavljena (503), ali pravo rešenje je da Reversi čitaju mašine iz 3.0 — što stiže sa korakom 3 | 87 mašina | korak 3 |
| **8** | **5 AI alata** (§4c) — brana postavljena; prepis `ai_chat_*` nad 3.0 bazom | `prijavi_kvar` je jedini upis | 1 dan |
| **9** | **`bigtehn_machines_cache`** (90 redova) — „uvoz iz kataloga" i lista importable mašina; nije `maint_*`, stiže sa svojim domenom | | — |
| **10** | **Fajlovi u sy15 storage-u** (`maint-machine-files`, 469 MB) — putanje prenete, URL-ovi važe | 59 objekata | posebno |
| **11** | 🟡 **`ai_chat_sql`** je generički read-only SQL alat i može da dotakne `maint_*`. Nije stavljen pod branu (nije mu poznat domen unaprijed); pod `3.0` bi čitao sy15 kopiju. Samo čitanje, ne razilazi baze | | dokumentovano |

**Zbir: ~10–14 dana** do punog rada pod `3.0`. Sam prenos podataka je **~2 minuta**.

> ✅ **PREVOD IDENTITETA (08.08.2026) — zatvoren.** Nije bio u tabeli gore jer nije ličio na
> blokadu: kod je „radio", samo je svaka dodela čoveka pod `3.0` vraćala 422. Detalji i brojke
> u §2.1b. Time je uklonjena poslednja stavka koja bi pri preklopu oborila **stvaran radni
> tok** (dodela radnog naloga, odgovorni za mašinu), a ne samo neku rutu.

### Šta pod `3.0` RADI od 06.08.

Ništa iz modula — i to je namerno. Ovaj korak isporučuje **šemu, prenos, prekidač i sloj
prava**; `3.0` je zasad položaj u kome sve pada sa 503 i imenuje putanju. Isto je bio i prvi
dan koraka 1 (sastanci: 4 od 65 funkcija, ostalo 503).

---

## 8. 🔴 Odluke koje čekaju Nenada (ne kod)

1. **`kontrolor` i pristup održavanju** (§2.3). U sy15 `kontrola@servoteh.com` ima floor-read;
   u 3.0 bi ga izgubio jer rola `kontrolor` nije u spisku. Jedini nalog u razlici 35 → 34.
   Da se doda, dodaje se jedna vrednost u `FLOOR_READ_ROLES`.
2. **„Katastarske parcele" na objektima** (nalaz 6). Kolone u sy15 NEMA, pa modul Objekti na
   produkciji ne može da sačuva red (500 na 42703, 0 objekata). Pod `3.0` radi. Da li se
   popravlja i `sy15` strana (jedan `ALTER TABLE`) dok se ne pređe — odluka.
3. **Šav ka `loc_locations`** (§4b, blokada 6): da li se sinhronizacija mašina u lokacije
   posle preklopa zadržava, i ko je izvršava dok su lokacije još u sy15.
4. **Zatečena nedoslednost `maint_documents`**: `maint_documents_entity_fk_chk` dozvoljava
   `entity_type='driver'`, a `maint_documents_entity_match` ga ne nabraja — pa dokument vozača
   ne može da postoji iako ga UI nudi. Prenosi se **doslovno** (0 takvih redova); popravka je
   odluka o proizvodu.
5. **Termin preklopa.**

---

## 9. Runbook — šta uraditi na produkciji kad odluka padne

⚠️ Koraci 0–6 prenose **podatke** i **bezbedni su**: `ODRZAVANJE_IZVOR` ostaje `sy15`, pa modul
ceo taj vremenski period radi normalno nad sy15. Prenos se sme uraditi i **danima pre**
preklopa (i ponoviti — idempotentan je).

| # | Korak | Trajanje | Povratak |
|---|---|---|---|
| 0 | `ssh ubuntusrv` + noćni klon 3.0 baze (postojeći backup) | 5 min | — |
| 1 | `npm run migrate:prod` (`prisma migrate deploy`) — kreira 34 prazne tabele | ~15 s | tabele su nove i prazne → `DROP` je bezbedan |
| 2 | `migrate status` mora biti čist (bez drift-a) | 5 s | — |
| 3 | `npx ts-node --transpile-only backend/scripts/migrate-odrzavanje-sy15.ts --show-columns` — revizija mape kolona (477 kolona, 46/46 user kolona) | 5 s | ništa se ne čita ni ne piše |
| 4 | `... ` (**dry-run**) — sekcija „BLOKADE" mora biti prazna, a mapa identiteta mora dati **21/21** | ~20 s | ništa se ne piše |
| 5 | `... --apply` — 764 reda + 18 popravki kružnih veza | ~2 min | `TRUNCATE` 34 tabele + ponovi (sy15 je i dalje netaknut izvor) |
| 6 | `... --verify-only` — svih 34 redova `OK`, plus brojač naloga i kružne veze | ~15 s | — |
| **7** | **`ODRZAVANJE_IZVOR=3.0`** u `backend.env` + `systemctl restart` / redeploy kontejnera. 🔴 **`SASTANCI_IZVOR` i `PB_IZVOR` se NE diraju** | ~2 min | **`ODRZAVANJE_IZVOR=sy15` + restart = ~2 min** |
| 8 | `ssh ubuntusrv 'bash -s' < backend/scripts/post-deploy-verify.sh` — mora 🟢 EXIT 0 | ~1 min | — |
| 9 | Ručna proba: otvori radni nalog, prijavi kvar, upiši napomenu na mašinu | 5 min | v. korak 7 |

⚠️ **Korak 7 se NE izvodi dok blokade 1–5 iz §7 nisu zatvorene** — pod `3.0` ceo modul sada
pada sa 503. Koraci 0–6 se izvode kad se hoće.

### Povratak (rollback)

Jedan potez, bez deploy-a koda: **`ODRZAVANJE_IZVOR=sy15` + restart (~2 min).** sy15 se tokom
seobe ne dira, pa je u svakom trenutku važeći izvor. Prenete 3.0 tabele ostaju kao mrtav teret
dok se ne pokuša ponovo — ne smetaju.

### ⚠️ Tačka bez povratka

Čim se pod `ODRZAVANJE_IZVOR=3.0` upiše **prvi** radni nalog, prijava kvara ili napomena, 3.0
ima podatak koji sy15 nema. Od tada povratak traži ručno prenošenje tih redova nazad. Zato
korak 9 treba raditi odmah i na jednom nalogu.

🔴 **Dodatna tačka bez povratka, specifična za ovaj domen:** brojač `maint_wo_number_counter`.
Ako se pod `3.0` izda nalog `WO-2026-00135`, a onda se vrati na `sy15`, sy15 brojač je i dalje
na 134 i **sledeći sy15 nalog dobija isti broj**. Pri povratku posle izdatog naloga MORA se
ručno podići sy15 brojač na najviši izdati broj.

### 🔴 Provera koju ne treba preskočiti (pouka incidenta 06.08.)

Posle koraka 7 proveriti u dnevniku (`scheduled_job_runs`) da **poslovi tuđih domena rade**:
`sast-action-reminders`, `sast-meeting-reminders`, `sast-weekly-auto`, `pb-enqueue`,
`pb-notify-dispatch`, `kadr-hr-reminders`, `kadr-notify-dispatch`. Nijedan od njih nije ovaj
domen i **nijedan ne sme da padne**. To je pinovano testovima
(`sy15-cron-jobs.spec.ts`, `notify-dispatch.service.spec.ts`, `izvor-prekidaci.spec.ts`), ali
proveriti i na produkciji — upravo je nepostojanje te provere bio incident.

Očekivano je da padnu, i to samo ova dva: `maint-deadlines` i `maint-notify-dispatch`, sa 503 i
imenom putanje. To je brana, ne kvar.

---

## 10. Preporuka

**Održavanje je dobar drugi rez — i lakši od sastanaka u jednom, teži u drugom.**

- 🟢 **Lakši:** domen NE zavisi od kadrovske (§2.2) — nijedna `maint*` funkcija ne pominje
  `employees`. To je suprotno od Projektnog biroa i znači da korak 2 ne mora da čeka korak 4.
  Identitet je 21/21, FK graf je čist, prenos je dokazan i idempotentan.
- 🔴 **Teži:** logike je mnogo više. Sastanci su imali 39 funkcija domena i 27 tabela; ovde su
  **34 tabele, 59 funkcija, 102 RLS politike, 34 trigera i 13 view-ova** — i tri šava ka
  drugim domenima koje FK graf ne pokazuje (§4).

Zato predlog za sledeći potez:

1. **Izvesti korake 0–6 runbook-a kad god** (prenos je bezbedan i ponovljiv) — time se rizik
   deli na dva dana i podaci se već zateknu u 3.0.
2. **Prepisati modul po blokadama 1–5** (§7, ~10–14 dana). Redosled koji se preporučuje je isti
   koji je radio kod sastanaka: **prvo read-scope** (blokada 4 — bez njega blokada 1 postaje
   bezbednosni propust), pa registar idempotencije (5), pa CRUD (1), pa DEFINER logika (2+3).
3. **Odluke iz §8 tražiti pre koraka 7**, a ne posle.
4. **Reverse i Lokacije (korak 3) planirati odmah posle** — dva od tri šava iz §4 se time
   zatvaraju sama.

Ono što je ovde napisano važi u oba slučaja: šema, migracija, skripta prenosa, prekidač i sloj
prava su gotovi i dokazani, a helper `sy15-identity.ts` je i dalje zajednički za sve preostale
korake — nije menjan.

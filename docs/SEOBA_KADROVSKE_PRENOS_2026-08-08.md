# Seoba Kadrovske — SKRIPTA PRENOSA (merenje + runbook)

**Datum merenja: 08.08.2026.** Sve brojke u ovom dokumentu su IZMERENE nad živom sy15
i živom 3.0, uz `count(*)` (nikad `n_live_tup`). Deo temelja seobe iz
[PLAN_GASENJA_SY15_2026-08-03.md](PLAN_GASENJA_SY15_2026-08-03.md); obrazac uzet iz
[SEOBA_ODRZAVANJA_2026-08-06.md](SEOBA_ODRZAVANJA_2026-08-06.md).

> ⚠️ **Kadrovska je zamrznuta za dorade i popravke** (`docs/OTVORENI_POSLOVI.md` §K).
> Sama seoba je ono što zamrzavanje UKIDA i jeste dozvoljena. Zato ovaj posao prenosi
> logiku i podatke **kakvi jesu**; svaki zatečen kvar je zapisan u §7 i **nije popravljen**.

Isporučeno:

| fajl | šta je |
|---|---|
| `backend/scripts/migrate-kadrovska-sy15.ts` | idempotentna skripta prenosa (65 tabela) |
| `backend/scripts/prep-kadrovska-probna.sh` | pravi PROBNU bazu (svoj PG kontejner) za dokaz |
| `backend/tsconfig.scripts.json` | prevod skripti — `tsconfig.build.json` ih namerno izuzima |

---

## 1. 🔴 Domen NIJE 19 tabela — nego 65

Mapa domena sa kojom je posao započet navodi *„19 tabela (prefiks `kadr` / `hr_` +
`employees`, `work_hours`, `makeup_requests`, `vacation_bonus_days`,
`attendance_events`, `salaries`)"*. **Taj broj je artefakt filtera po imenu, ne domen.**

Izmereno nad živom sy15:

- filter po imenu daje **tačno tih 19** tabela — dakle mapa je bila interno tačna, ali
  je merila IME, ne domen;
- `salaries` **u sy15 ne postoji**. Plate stoje u `salary_payroll` (0 redova) i
  `salary_terms` (143). Ime iz mape ne bi ništa našlo;
- domen po FK grafu (`pg_constraint`) i po RLS/funkcijama ima **65 tabela**: **43 tabele
  imaju FK na `employees`**, plus roditelji (`departments`, `sub_departments`,
  `job_positions`) i satelitski registri (kompetencije, ciklusi ocenjivanja, praznici,
  tri allowlist tabele).

Da se prenos držao „19", **tiho** bi u sy15 ostalo:

| ostalo bi u sy15 | redova |
|---|---|
| `vacation_go_days` (iskorišćeni GO dani) | 5.269 |
| `vacation_history` | 447 |
| `competence_levels` | 570 |
| `salary_terms` (ugovorene zarade) | 143 |
| `vacation_requests` / `vacation_entitlements` | 134 / 132 |
| `absences` | 134 |
| `employee_badges` | 263 |
| `katze_employee_map` | 163 |
| `contracts`, `employee_documents`, `employee_personal_docs`, … (PII) | 119 + 28 + 22 + 17 + 2 |
| ostalo (ocenjivanje, onboarding, obaveštenja, audit) | ~2.700 |

Ukupno ~**19.000 redova van `attendance_events`**, i **cela istorija odsustava**.

**Pouka za sledeći domen:** spisak tabela se izvodi iz FK grafa i RLS politika, nikad
iz prefiksa imena. Ime je konvencija, a konvencija se u ovoj bazi ne poštuje
dosledno (`absences`, `contracts`, `salary_*`, `vacation_*`, `employee_*`,
`competence_*` nemaju `kadr` prefiks, a jesu kadrovska).

## 2. Izmereno stanje izvora (08.08.2026)

- **65 tabela, 750 kolona, ~510.000 redova.**
- Najveća: **`attendance_events` = 491.268 redova / 140 MB** (`count(*)` u 10:27).
  Ponovljeno merenje u 10:47 dalo je **491.271**, u 11:54 **491.278** — **Katze most
  (kapija) piše uživo, na 10 min, i ne gasi se.**
- `attendance_events` po izvoru: `katze` 488.921 · `katze_manual` 2.320 · `manual` 27.
  `external_id` nije NULL nigde (`ux_attendance_events_source_ext` je pravi prirodni
  ključ), a **`employee_id` je NULL u 139.955 redova (28%)** — kartica bez parnjaka.
- **Nijedan PG `enum` u domenu** (svi enumi u bazi su `maint_*` / `loc_*`). Tipovi:
  `text`, `text[]`, `bigint`, `bigint[]`, `boolean`, `date`, `integer`, `jsonb`,
  `numeric(*)`, `smallint`, `time`, `timestamp`, `timestamptz`, `uuid`.
- **Sve 65 tabele imaju PK** — upsert ima za šta da se uhvati. Složen PK ima samo
  `vacation_go_days` (`employee_id` + `used_date`); `katze_employee_map` ide po
  `katze_id`, `worker_employee_map` po `bigtehn_worker_id`, tri allowlist-a po `email`.
- **12 kolona je vezano na sekvencu**, najveća `attendance_events.id`
  (`last_value = 491.276`).

## 3. Odredište — zašto skripta NIJE po DMMF-u

Izmereno na 3.0 produkciji: **313 tabela u `public`, a od kadrovske postoje samo
`kadr_grid_day_locks` i `worker_employee_map`.** Prisma modeli kadrovske još ne
postoje i predmet su **druge grane istog temelja** — da ih ova grana napravi, dve
grane bi se sudarile u `prisma/schema.prisma` (pouka „paralelne grane u istom fajlu =
sekvencijalni merge").

Zato je spisak kolona izveden iz `information_schema` **odredišta** u trenutku
pokretanja, pa **upoređen sa izvorom u oba smera**:

- kolona u odredištu a nema je u izvoru → **BLOKADA** (tabela se ne prenosi),
- kolona u izvoru a nema je u odredištu → **BLOKADA** (podatak bi se tiho izgubio),
- PK se razlikuje → **BLOKADA** (upsert bi duplirao redove).

Time je sačuvano ono zbog čega je DMMF i biran u održavanju: **promašeno ime kolone
pukne glasno.** Kad Prisma šema stigne, prenos radi bez ijedne izmene — samo se probna
baza zameni pravom.

## 4. Identitet — dva različita mehanizma, oba izmerena

Kadrovska naloge drži na **dva** načina, i to je moralo da se izmeri, ne pretpostavi:

**(a) 6 `uuid` kolona → 3.0 `users.id` (Int).** Pet ima FK na `auth.users`
(`absences.archived_by`, `contracts.archived_by`, `employee_documents.uploaded_by`,
`kadr_certificates.created_by`, `kadr_medical_exams.created_by`). Šesta,
**`kadr_audit_log.actor_user_id`, FK NEMA** — nađena je pretragom po tipu i proverena
podatkom (395/1239 popunjeno, **0** vrednosti bez parnjaka u `auth.users`). To je isti
obrazac kao `maint_it_asset_details.assigned_to` u održavanju, samo obrnut: tamo je ime
lagalo da je nalog, ovde odsustvo FK-a laže da nije. Skripta na startu **sama proverava**
da nema sedme takve kolone (`proveriUuidKoloneNaloga`).

**(b) 44 TEKST kolone koje drže mejl** (`submitted_by`, `reviewed_by`, `level1_by`,
`last_edited_by`, `actor_email`, `rater_email`, tri `allowlist.email`, …). One se
prenose **doslovno** (ostaju tekst), ali se svaka vrednost proverava:

- **50 različitih mejlova**, od kojih **49 ima nalog u 3.0 `users`**;
- **1 mejl nema nalog nigde**, i pojavljuje se u 2 reda (dve allowlist tabele) — v. §7.1;
- **9 vrednosti NISU mejl**, već pečat sistemskog upisa: `auto:kapija`,
  `backfill:grid_canon`, `fix:veljko_go_2026_datumi`, `import-jun-2026`,
  `import-jun-2026-fix`, `sistematizacija-v53-import`,
  `sistematizacija-cnc-programer-2026-07-03`, `nenad.jarakovic (chat 2026-07-07)`,
  `Nenad — naknadni unos 30.06`.
  🔴 Te vrednosti se **ne prijavljuju kao blokada** — nikad nisu bile nalog. Ispisuju se
  posebno, da se „nema naloga" ne pomeša sa „nije nalog". Da su tretirane kao mejlovi,
  dobili bismo 9 lažnih blokada i posao bi stao bez razloga.

`auth.users` ima 62 reda; **1 nema parnjaka u 3.0**:
`bigtehn-worker@system.local` (`00000000-…-099`) — sistemski nalog mosta. Domen ga ne
koristi ni u jednoj od 6 `uuid` kolona (0 nerazrešenih pri prolazu).

## 5. Kako skripta radi

```
npx ts-node --transpile-only backend/scripts/migrate-kadrovska-sy15.ts             # dry-run
                                                                     --show-columns  # revizija mape
                                                                     --apply         # upis
                                                                     --apply --resume# nastavak
                                                                     --verify-only   # dokaz
                                                                     --verify-only --detalji
                                                                     --only=t1,t2  --batch=5000
```

- **Idempotencija.** Upis je jedan `INSERT … ON CONFLICT (pk) DO UPDATE SET …
  WHERE (t.*) IS DISTINCT FROM (EXCLUDED.*) RETURNING (t.xmax = 0)`. `WHERE` je ono što
  drugom prolazu daje **0 izmena**: red koji je već identičan se ne dira (nema ni
  „prazan" `UPDATE`, ni pomeranja `xmax`), a `RETURNING` odmah kaže koliko je *stvarno*
  upisano i koliko od toga je novo. Broj „0 izmena" je time **merena posledica, ne tvrdnja**.
- **Paketi + nastavak.** Čitanje ide keyset kursorom po PK (`WHERE (pk) > ($1::tip)`),
  paket 2.000 (`attendance_events` 5.000). Posle svakog paketa kursor se pamti u
  `kadr_seoba.prenos_stanje`; `--apply --resume` nastavlja odatle. Prekid mreže ne
  znači ponovni prolaz kroz 491k redova.
- **Sve se čita kao TEKST, pa se na upisu kastuje.** JS round-trip Prisma raw tipova je
  mesto tihe greške: `bigint` obara `JSON.stringify`, `time without time zone` se vrati
  kao `Date` i ne da se upisati, `numeric` kroz `Number` gubi cifre. Tekst je jedini
  oblik koji Postgres pročita i vrati bit-identično.
- **Render je nezavisan od sesije.** `timestamptz` se ne pušta kroz `::text` (to zavisi
  od `TimeZone` konekcije) nego kroz `to_char(… AT TIME ZONE 'UTC', …)`; isto za
  `timestamp`, `date`, `time` (koji zavise od `DateStyle`). Zona se **ispisuje u
  vrednosti**, ne pretpostavlja — direktna primena pouke „vremena u bazi su UTC bez zone".
- **Sekvence.** Posle upisa `setval` na `max(pk)` za svih 12 sekvenci, a `--verify-only`
  to proverava kao zasebnu stavku. Bez toga bi prvi upis iz 3.0 pao na `duplicate key` —
  ista zamka koju je održavanje platilo kroz `maint_wo_number_counter`.
- **Blokade su podeljene po težini** (`struktura` / `identitet` / `verifikacija`).
  `struktura` **zaustavlja upis**; `identitet` i `verifikacija` se ispisuju i obaraju
  izlazni kod, ali ne zaustavljaju prenos 510k redova zbog jednog mrtvog reda.
  Nijedna se ne prećutkuje.

### `--verify-only` — count **i** checksum

`count(*)` **ne hvata** promašenu kolonu ni izmenjen red: broj redova ostane isti.
Zato verifikacija po tabeli računa i **md5**: red → `md5` spoja svih prenetih kolona
(kanonski render, `quote_nullable` da se NULL razlikuje od praznog stringa), tabela →
`md5` spoja **sortiranih** heševa redova (pa ne zavisi od fizičkog reda). Uz to:

- **user kolone se iz heša izuzimaju** (uuid u izvoru, Int u odredištu) i proveravaju
  zasebno, red po red, kroz mapu identiteta;
- **sekvence** se proveravaju posebno;
- `--detalji` na razliku ispisuje **koje ključeve** treba pogledati.

## 6. Dokaz na PROBNOJ bazi

**Produkcija nije dirana ničim osim `pg_dump`-om (čitanje).**

Probna baza je **svoj PG kontejner** (`kadr-probna-pg`, port 5439), a ne deljena
`servosync-dev`: tokom ovog posla je na `servosync-dev` uporedo radila druga grana
(`kadr_sema_shadow_005`, `DROP TABLE _prisma_migrations`) i prenos je **dva puta pao na
„Can't reach database server" iako je TCP port bio otvoren a SSH radio**. Baza koja
služi kao DOKAZ ne sme da deli sudbinu tuđeg `migrate reset`-a.

- `kadr_probna_src` — struktura + **svi pravi podaci** 65 tabela iz žive sy15, plus
  kopija `auth.users` (62 reda);
- `kadr_probna_dst` — samo struktura, plus 3.0 `users` (71 red) i **6 `uuid` kolona
  naloga prevedeno u `integer`** — tačno onako kako će 3.0 i imati. Time proba
  **stvarno vozi** put uuid → `users.id`, ne samo kopiranje.
- `btree_gist` se instalira namerno: bez njega EXCLUDE ograničenje
  `absences_no_overlap_per_employee` ne može da se napravi, pa bi probna baza izgubila
  branu koju produkcija ima.

Brisanje posle: `ssh ubuntusrv "docker rm -f kadr-probna-pg"`.

### 🔴 Gde se skripta POKREĆE — izmereno, jer razlika je 75×

| odakle | čitanje | upis | ukupno za 491k redova |
|---|---:|---:|---:|
| radna stanica preko VPN-a | ~950 red/s | **~89 red/s** | **~1,5–2 h** |
| na serveru (kontejner, `--network host`) | — | **~6.700 red/s** | **74 s** |

Uzrok je izmeren, ne pogođen: paket od 2.000 redova je 0,75 MB, i putuje ~13 s naviše, a
3 MB naniže ~8,4 s — **VPN uplink je ~6× sporiji od downlinka** (58 KB/s vs 360 KB/s).
Sve tri varijante `ON CONFLICT`-a merene su isto (13–17 s), dakle usko grlo **nije** SQL
nego link. **Zato se prenos pokreće NA ubuntusrv-u** (obe baze su ionako tamo):

```
tar -czf kadr_run.tgz -C backend package.json package-lock.json \
  prisma/schema.prisma prisma/sy15.prisma \
  scripts/migrate-kadrovska-sy15.ts scripts/lib/sy15-identity.ts
scp kadr_run.tgz ubuntusrv:/tmp/ && ssh ubuntusrv
  mkdir -p /tmp/kadrrun && tar -xzf /tmp/kadr_run.tgz -C /tmp/kadrrun
  # .env sa DATABASE_URL i SY15_DATABASE_URL u /tmp/kadrrun/.env
  docker run -d --name kadr-runner --network host -v /tmp/kadrrun:/app -w /app node:22 sleep infinity
  docker exec kadr-runner sh -lc "npm i --no-save prisma@6.19.3 @prisma/client@6.19.3 ts-node typescript @types/node"
  docker exec kadr-runner sh -lc "npx prisma generate --schema prisma/schema.prisma; npx prisma generate --schema prisma/sy15.prisma"
  docker exec kadr-runner sh -lc "npx ts-node --transpile-only scripts/migrate-kadrovska-sy15.ts --apply"
```

Na ubuntusrv-u **nema instaliranog node-a** i ovaj postupak ga NE instalira — sve živi u
kontejneru koji se posle briše (`docker rm -f kadr-runner`).

### Ishod prolaza

| | izvor | odredište |
|---|---:|---:|
| pre prenosa | 510.620 | **0** |
| posle prolaza 1 | 510.620 | **510.620** (ins=510.620, upd=0, **81 s**) |
| prolaz 2 (isti podaci) | 510.620 | 510.620, **izmena = 0** |

`--verify-only`: **65/65 tabela, count i checksum se poklapaju**; svih 12 sekvenci OK;
6 `uuid` kolona naloga preslikano 1:1 (`employee_documents.uploaded_by` 119/119,
`kadr_audit_log.actor_user_id` 395/395). Jedina preostala stavka u sekciji BLOKADE su
**2 reda sa mrtvim mejlom** iz §7.1 — one traže odluku, ne popravku.

### Mutaciona proba — namerno kvarenje, po stavci

Test ne vredi dok se ne dokaže da OBARA. Svaka stavka je pokvarena namerno pa vraćena:

| # | šta je pokvareno | šta je skripta uradila |
|---|---|---|
| M1 | jednom redu `work_hours` promenjen broj sati (count ostaje isti) | `!!! work_hours 8446 8446 RAZLIKA` — **checksum oborio, `count(*)` ne bi**; `--detalji` pokazao tačno 1 red; `--apply` popravio sa `upd=1` |
| M2 | obrisan 1 red iz `attendance_events` | `!!! 491278 vs 491277` + blokada; `--apply` vratio sa `ins=1`, a ostalih **491.277 redova nije dirao** |
| M3 | preimenovana kolona `vacation_requests.reviewed_by` | `🔴 STRUKTURNA blokada PRE upisa — ne pišem ništa` |
| M4 | sekvenca `attendance_events.id` vraćena na 1 | `!!! max_izvor=491286 sekvenca3.0=1` + blokada sa objašnjenjem `duplicate key` |
| M5 | obrisan 3.0 nalog koji potpisuje `kadr_audit_log` | prijavljen kao nerazrešen nalog, kolona ostala NULL, **red nije tiho podmetnut tuđem nalogu** |
| M6 | 3 nova reda ubačena u izvor **dok prenos radi** (simulacija kapije) | sledeći prolaz `ins=3, upd=0` — bez duplikata i bez diranja ostalih 491k |
| M7 | prekid nasred `attendance_events` + `--resume` | nastavio od zapamćenog kursora, dopunio samo ono što fali |

🔴 **Mutaciona proba je i našla pravi kvar u samoj skripti** (v. §7.6) — dokaz da nije
ukras: prvi pun prolaz je preneo 391.781 od 491.278 redova, a verifikacija ga je oborila.

## 7. 🔴 ZATEČENI KVAROVI — zapisani, NISU popravljeni (zamrzavanje §K)

### 7.1 Mrtav mejl u dve allowlist tabele — `nevena.knezevic@sevroteh.com`

`kadr_grid_editor_allowlist` i `kadr_vacation_editor_allowlist` imaju red sa mejlom
**`nevena.knezevic@sevroteh.com`** (nota: „Legacy nalog"). Domen je **`sevroteh`**, a
ne `servoteh` — slovo je premetnuto.

Izmereno: tog mejla **nema** ni u sy15 `auth.users` (62 reda) ni u 3.0 `users` (71).
Dakle red **ne daje nikakvo pravo nikome** — ni sada u sy15, ni posle preklopa. Ispravan
red za istu osobu (`nevena.knezevic@servoteh.com`) **postoji** u obe tabele, pa
funkcionalne štete nema; šteta je što allowlist prava izgleda kao da ima 5 upisivača
grida a stvarno ih ima 4.

- gde: sy15 `public.kadr_grid_editor_allowlist` i `public.kadr_vacation_editor_allowlist`
- čita ga: `can_edit_kadrovska_grid` (`backend/src/modules/kadrovska/kadrovska-mutations.service.ts:1109`
  + RLS `work_hours`, `attendance_events`, `employee_badges`) i
  `can_edit_vacation_balance` (RLS `vacation_entitlements`)
- **odluka koju traži pre produkcijskog `--apply`:** obrisati red, ili ga preneti kao
  mrtav podatak. Skripta ga danas prijavljuje kao blokadu `[identitet]` i **ne prenosi
  ga tiho**.

### 7.2 `employees.email` — 107 praznih stringova umesto NULL

`employees`: 157 redova, `email IS NOT NULL` u 155, ali **`email = ''` u 107**. Stvarnih
mejlova je 48. Kolona je time neupotrebljiva za `NOT NULL`/`UNIQUE` bez čišćenja, a
svaka provera „ima li mejl" mora da testira i prazan string — što je klasa greške koja
se lako promaši (`WHERE email IS NOT NULL` prolazi za 107 redova bez mejla).

- gde: sy15 `public.employees.email`
- posledica koju treba imati na umu pri pisanju 3.0 modela: ako se u 3.0 postavi
  `UNIQUE` na `email`, **107 praznih stringova se sudara među sobom** i prenos pada.
  (Skripta ih prenosi kakvi su; sudar bi se pojavio na strani šeme.)

### 7.3 `attendance_events`: 139.955 redova (28%) bez `employee_id`

Kartica sa kapije koja nije uparena sa zaposlenim. Prenosi se kakva jeste. Za 3.0 to
znači da svaki izveštaj prisustva mora da računa sa NULL-om, a ne da ga filtrira tiho.

- gde: sy15 `public.attendance_events.employee_id`

### 7.4 `cadastral_parcels`-obrazac: nema ga ovde, ali je provereno

U održavanju je nađena kolona koju kod upisuje a u bazi je nema (`42703` na svaki upis).
U kadrovskoj je provereno isto u oba smera: **razlika kolona izvor↔odredište je 0** za
svih 65 tabela (`--show-columns`, 750 kolona). Nema šta da se prijavi.

### 7.5 `absences_no_overlap_per_employee` traži `btree_gist`

Ograničenje je EXCLUDE nad `uuid` + `daterange` i **ne može se restaurirati bez
ekstenzije `btree_gist`**. Nije kvar u sy15 (tamo ekstenzija postoji), ali je zamka za
3.0: migracija koja pravi tu tabelu **mora** prvo da uradi
`CREATE EXTENSION IF NOT EXISTS btree_gist`, inače brana protiv preklapanja odsustava
tiho nestane (tabela se napravi, samo bez ograničenja).

### 7.6 Kvar U SAMOJ SKRIPTI — nađen mutacionom probom i POPRAVLJEN

Ovo nije zatečen kvar kadrovske nego greška ovog posla; stoji ovde jer je klasa greške
vredna više od nalaza.

Prvi pun prolaz preneo je **391.781 od 491.278 redova** `attendance_events` — **99.497
redova je TIHO preskočeno**. Uzrok: `ORDER BY "id"` u čitanju paketa. Postgres kod
`ORDER BY` prvo gleda **izlazne aliase**, a kolone se čitaju kao tekst (`"id"::text AS "id"`),
pa se sortiranje vezalo za TEKST i teklo leksikografski: `1, 10, 100, 1000, 10000, 100000…`
`WHERE` aliase **ne vidi**, pa je kursor poredio numerički — dva poretka su se razišla i
paging je preskakao blokove. Potpis u odredištu je bio nedvosmislen: preživeli su baš
id-jevi `1, 10, 100, 104, 1000, 1044, 10000, 10449, 100000`.

- **Šta je uhvatilo:** `--verify-only` (`!!! attendance_events 491278 vs 391781`, i
  različit checksum). Prolaz sam sebe nije prijavio kao neuspeh — završio je „uredno".
- **Popravka:** tabela dobija alias (`FROM … AS s`), `ORDER BY s."id"`; plus **nova brana
  po tabeli**: posle svake tabele se `s.read` poredi sa `count(*)` izvora i manjak je
  strukturna blokada — da se ovakav promašaj vidi ODMAH, a ne tek na kraju prolaza.
- **Pouka:** kad se kolone čitaju kastovane (`::text`), **svako** `ORDER BY` mora biti
  kvalifikovano imenom tabele. Ovo je tiha greška najgore vrste: ne baca izuzetak, ne
  ostavlja trag u logu, a odnese petinu tabele.

## 8. Šta OSTAJE (procena u danima)

| posao | procena |
|---|---|
| Prisma šema + migracija za 65 tabela / 750 kolona (druga grana) | 3–4 dana |
| Prepis 73 DEFINER funkcije u NestJS servise | 12–18 dana |
| Prepis 49 RLS politika u 3.0 authz (allowlist-e + `managed_sub_department_ids`) | 4–6 dana |
| Prepis okidača (`attendance_fill_event_ts`, `salary_payroll_compute_totals`, `salary_payroll_immutability_check`, `salary_terms_close_previous`, `vacation_requests_no_overlap`) | 2–3 dana |
| Repoint 177 poziva iz `kadrovska.service.ts` / `moj-profil.service.ts` / `kadrovska-mutations.service.ts` / `grid-autofill.service.ts` | 8–12 dana |
| Katze most + kiosk: preusmeriti pisce `attendance_events` na 3.0 | 2–3 dana |
| Scheduler poslovi `kadr-*` (6) + `kadr_dispatch_*` | 2–3 dana |
| Preklop (prolaz + prolaz + `--verify-only` u prozoru dok most stoji) | 0,5 dana |

**Ukupno ~34–50 radnih dana** za ceo domen; **ova skripta (prenos podataka) je gotova.**

## 9. Runbook preklopa (kad Prisma šema stigne)

0. **Pokreni skriptu NA ubuntusrv-u** (v. §6) — sa radne stanice preko VPN-a je 75× sporije.
1. `--show-columns` — mapa kolona mora biti bez blokada.
2. `--verify-only` — pokazuje 0 u odredištu; potvrđuje da mapa identiteta stoji.
3. `--apply` (prvi prolaz, most i dalje radi). Izmereno: **81 s za svih 510.620 redova**,
   od toga 74 s na `attendance_events` (~6.700 red/s).
4. `--apply` **još jednom** — hvata redove koji su se u izvoru izmenili ispod kursora.
   🔴 Jedan prolaz **nije snapshot**: `attendance_events.employee_id` se popuni kad se
   kartica upari, a taj `UPDATE` ispod kursora prvi prolaz ne vidi.
5. Zastavi Katze most (`bridge`), pa **treći `--apply`** — sada je izvor miran.
6. `--verify-only` mora dati `poklapa se: 65/65`, sve sekvence OK, sekcija BLOKADE prazna.
7. Tek onda prebaci pisce (most, kiosk) na 3.0 i pusti most.

> Ako 6. korak ne da 65/65 i praznu sekciju blokada — **preklop se ne radi.** „Radi"
> bez zelenog `--verify-only` ne postoji.

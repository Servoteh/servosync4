# Seoba sastanaka i projektnog biroa na 3.0 bazu — merenje, priprema i runbook (05.08.2026)

**Korak 1** iz [PLAN_GASENJA_SY15_2026-08-03.md](PLAN_GASENJA_SY15_2026-08-03.md) — prvi pravi rez
posle odluke da reversi idu tek u koraku 3 ([SEOBA_REVERSA_2026-08-05.md](SEOBA_REVERSA_2026-08-05.md)).

**Ništa od ovoga nije primenjeno na produkciji.** Sve merenje je rađeno `SELECT`-om nad živom sy15
bazom; migracija i prenos su napisani i dokazani na *odvojenoj probnoj bazi* (`sastanci_pb_proba`,
napravljena i obrisana u toku rada).

> ⚠️ Server je 05.08. imao nestanak struje → `pg_stat` statistika je resetovana.
> **Nijedan broj ovde ne dolazi iz statistike** — sve je `count(*)`.
> (Pouka: [PLAN_GASENJA §1 nalaz 2](PLAN_GASENJA_SY15_2026-08-03.md) — `n_live_tup` nije broj redova.)

---

## 1. Merenje — domen je veći nego što spisak po prefiksu pokazuje

`count(*)` nad živom sy15, 05.08.2026. **27 tabela, 1.120 redova.**

| Tabela | redova | | Tabela | redova |
|---|---:|---|---|---:|
| `akcioni_plan_istorija` | **689** | | `pb_task_comments` | 8 |
| `sastanci_notification_log` | 134 | | `pb_eng_tip_categories` | 9 |
| `pb_tasks` | 106 | | `presek_aktivnosti` | 9 |
| `akcioni_plan` | 98 | | `sastanci` | 6 |
| `sastanak_ucesnici` | 39 | | `sastanci_notification_prefs` | 6 |
| `sastanak_arhiva` | 3 | | `sast_weekly_movers` | 2 |
| `pb_eng_tips` | 2 | | `pb_eng_tip_likes` | 2 |
| `sastanci_templates` · `sastanci_template_ucesnici` · `sastanci_ai_settings` · `pb_eng_tip_files` · `pb_task_deps` · `pb_work_reports` · `pb_notification_config` | 1 svaka | | `pm_teme` · `sastanak_odluke` · `presek_slike` · `sast_weekly_skip` · `pb_task_files` · `pb_notification_log` | 0 |

### 🔴 Nalaz 1: tri tabele koje spisak po prefiksu promaši

Polazni spisak zadatka imao je 24 tabele. Merenje je našlo još tri, i sve tri nose podatke:

| Tabela | redova | Zašto je promašena | Zašto MORA ići |
|---|---:|---|---|
| `akcioni_plan_istorija` | **689** | nema prefiks domena | Revizioni trag akcionih tačaka — **veći od same tabele akcija (98)**. Bez njega se gubi ceo istorijat izmena. FK ka `akcioni_plan`, 0 siročadi. |
| `sast_weekly_movers` | 2 | prefiks je `sast_`, ne `sastan_` → `LIKE 'sastan%'` je ne vidi | Allowlist ko sme da pomera sedmični sastanak (`sast_user_can_move_weekly`). |
| `sast_weekly_skip` | 0 | isto | Koje se nedelje preskaču (`sast_auto_create_weekly`). |

Isti previd pogodio je i **funkcije**: upit sa `LIKE 'sastan%'` vratio je 53 funkcije;
sa `LIKE 'sast%'` ih je **74 (65 `SECURITY DEFINER`)** — 21 funkcija `sast_*` je nedostajala,
među njima `sast_zakljucaj_sastanak` (4.002 znaka — zaključavanje sastanka, arhiva, PDF).

> **Pouka za sledeće korake:** domen se ne popisuje po prefiksu imena nego po **FK grafu +
> pozivima iz koda**. Ovde su oba puta dala isti dodatak koji ime nije.

### 🔴 Nalaz 2: obim logike je 74 funkcije, ne 46

Plan gašenja (§5, korak 1) procenjuje „46 fn". Izmereno:

| Šta | Koliko |
|---|---:|
| funkcija domena (`sast*`, `pb_*`, `pm_*`, `akcion*`, `presek*`) | **74** |
| od toga `SECURITY DEFINER` | **65** |
| view-ova (`v_akcioni_plan`, `v_pm_teme_pregled`) | 2 |
| trigera | 31 |
| RLS politika | **74** (na 20 tabela) |
| pg_cron poslova u sy15 | 0 aktivnih za ovaj domen (`sastanci_pulse_notify_dispatch` je `f` — preseljen u 3.0 scheduler, Talas A) |

---

## 2. 🔴 Ključno merenje: mapa predmeta (`projects`) — ključ RADI

Ovo je pitanje od kog je zavisio ceo dizajn: sy15 ima svoju `public.projects`, 3.0 ima svoju.

| | sy15 `public.projects` | 3.0 `public.projects` |
|---|---|---|
| redova | **23** | **7.631** |
| PK | `uuid` | `Int` (legacy `Predmeti.Sifra`) |
| poslovni ključ | `project_code` („9400/2", „9811-1") | `project_number` |
| veza ka drugom | `bigtehn_item_id` (Int) | — |

**sy15 `projects` nije nezavisna tabela nego IZVEDEN pokazivač na 3.0 predmet.** Dokaz je u samoj
bazi — funkcija `pb_predmet_project_uuid(p_item_id integer)`:

```sql
SELECT (substr(m,1,8)||'-'||substr(m,9,4)||'-'||'5'||substr(m,13,3)||'-'||'8'||substr(m,17,3)||'-'||substr(m,21,12))::uuid
FROM (SELECT md5('servoteh_pb_predmet:v1:' || p_item_id::text) AS m) s;
```

tj. `projects.id = uuid5(bigtehn_item_id)`, a `bigtehn_item_id` **JESTE** 3.0 `projects.id`.

### Merenje ključa (dve nezavisne provere)

| Provera | Rezultat |
|---|---|
| sy15 `bigtehn_item_id` → postoji u 3.0 `projects.id` | **22/22** |
| sy15 `project_code` → postoji u 3.0 `projects.project_number` | **22/22** (iste redove) |
| ukupno sy15 projekata | 23 — 23. je sintetički `PRAC-PROD-TEST` bez `bigtehn_item_id`, **koji nijedan red domena ne referencira** |
| koliko predmeta domen stvarno koristi | **16** (svi imaju parnjaka) |

Popunjenost FK kolona ka predmetu: `pb_tasks` 106/106 · `akcioni_plan` 83/98 · `sastanci` 1/6 ·
`pb_eng_tips` 0/2 · `pm_teme` 0/0.

**Odluka: uuid kolone predmeta postaju `Int` FK na 3.0 `projects.id`.** Ovo je suprotno od zamke
BigBit artikala (uparivanje po `items.id` = 0/92.511) — ovde ključ radi, i to je izmereno pre
pisanja ijedne linije koda. Skripta prenosa **odbija da nastavi** ako se broj po id-u razidje sa
brojem po šifri.

---

## 3. Mapa identiteta (korak 0 plana) — mejl je identitet, i to je dobra vest

### 3.1 `auth.users` uuid → 3.0 `users.id`

Domen koristi **6 različitih `auth.users` naloga** (3 FK kolone + 2 uuid kolone bez FK-a).
**Svih 6 ima parnjaka u 3.0 `users` po mejlu — 6/6.**

| sy15 `auth.users.id` | mejl | 3.0 `users.id` |
|---|---|---:|
| `a4913a06-…7285d` | marko.stojanovic@servoteh.com | 31 |
| `77ebe11b-…fb026` | milan.stojadinovic@servoteh.com | 29 |
| `eb10a139-…95a9436` | milorad.jerotic@servoteh.com | 30 |
| `90d00c13-…41196f` | nenad.jarakovic@servoteh.com | 2 |
| `1f7f4130-…422967` | pavle.ilic@servoteh.com | 24 |
| `864dfd9e-…1d2c233` | tatjana.gnjidic@servoteh.com | 27 |

*(Za kontekst: cela sy15 `auth.users` ima 60 naloga, od kojih 59 ima parnjaka — 1 nepokriven ne
dodiruje ovaj domen.)*

### 3.2 Mejlovi — 1.309 pojava, 27 različitih vrednosti

Domen **ne čuva identitet kao nalog nego kao mejl**: PK učesnika je `(sastanak_id, email)`,
RSVP/priprema/RLS porede `lower(email) = jwt.email`, primaoci obaveštenja su mejlovi.
Mejl-kolona ima 39 u 27 tabela.

**23 od 27 vrednosti su pravi ljudi i SVI (23/23) imaju nalog u 3.0 `users`.**

Četiri vrednosti nemaju parnjaka, i **to nije kvar nego podatak** (52 pojave):

| Vrednost | pojava | Šta je |
|---|---:|---|
| `seed-zapisnik-15-06-2026@import.servoteh` | 47 | marker uvoza starog zapisnika (38 u `akcioni_plan.created_by_email`, 9 u `zatvoren_by_email`) |
| `auto@sistem` | 2 | sistemski akter — sastanke koje kuje `sast_auto_create_weekly` |
| `zoran.jarakovic@servoteh.`**`ocm`** | 2 | 🔴 **tipfeler** („ocm" umesto „com") u `sastanci_template_ucesnici` i `sastanci_notification_log` |
| `a2b-runbook-test` | 1 | ostatak testa |

**Odluka: mejlovi se prenose DOSLOVNO.** Prevođenje u `users.id` polomilo bi PK učesnika i mejl
kanal (na sastanak se poziva i neko bez naloga), a „ispravljanje" tipfelera bilo bi izmišljanje
podatka. Tipfeler je **prijavljen kao poznat rep** (v. §7) — ispravlja se u aplikaciji, ne u seobi.

**Zajednički helper:** `backend/scripts/lib/sy15-identity.ts` (`buildUserMaps`, `buildProjectMap`).
Napravljen uz ovaj korak ali **ne zna ništa o ovom domenu** — koriste ga i koraci 2–5.

---

## 4. FK šavovi — domen JESTE odvojiv (za razliku od reversa)

### Ka spolja (domen → van domena) — 12 FK-ova

| Cilj | FK-ova | Popunjenost | Ocena |
|---|---:|---|---|
| `public.projects` | **5** (a ne 3) | 190 redova ukupno | 🟢 **rešeno** — Int FK, 22/22 (§2) |
| `public.employees` | 4 (PB) | 14 različitih radnika | 🟡 **meka veza** — uuid se prenosi doslovno (obrazac `KadrGridDayLock`) |
| `auth.users` | 3 | 6 naloga | 🟢 **lako** — 6/6 po mejlu |

### Ka unutra (van domena → domen) — 2 FK-a, oba bezopasna

| Izvor | Cilj | Stanje |
|---|---|---|
| `public.akcioni_plan_istorija.akcija_id` | `akcioni_plan` | 🟢 ide ZAJEDNO (nalaz 1) |
| `production.operativna_aktivnost.izvor_akcioni_plan_id` | `akcioni_plan` | 🟢 **mrtav šav**: tabela ima 4 reda, **0** sa popunjenom vezom |

### Zaključak o odvojivosti

**Sastanci + PB se mogu odvojiti — nemaju transakcioni šav ka drugom domenu.** To je bitna razlika
u odnosu na reverse (koji su sa Lokacijama jedna transakcija). Ostaje **jedna prava zavisnost**:

> 🔴 **Projektni biro visi o `employees`.** `pb_current_employee_id()` (jwt mejl → `employees.id`)
> je ulaz u **sva** prava modula (`pb_can_edit_tasks`, `pb_eng_tip_visible`,
> `pb_current_user_can_see_all_reports`…), a funkcije opterećenja (`pb_get_load_stats`,
> `pb_get_team_load_stats`, `pb_get_mechanical_projecting_engineers`) džoinuju i `departments`,
> `sub_departments`, `job_positions`. Sve to je kadrovska = **korak 4**.
> **Zato PB pod prekidačem `3.0` u celini vraća 503, iako su mu podaci preneti.**

Sastanci tu zavisnost **nemaju** — njihova prava idu po mejlu iz sesije.

---

## 5. Mejl kanal i scheduler — šta prekidač NE pokriva

**Nalaz: dispatch je već u 3.0.** sy15 Edge funkcije `sastanci-notify-dispatch` / `pb-notify-dispatch`
3.0 backend **više ne poziva** — mejl ide kroz `MailService` (Resend HTTP API,
`backend/src/common/mail/mail.service.ts`). Jedini preostali `functions/v1` je **RSVP magic-link u
telu mejla** (`sastanci-dispatch.service.ts:171-186` → `${base}/sastanci-rsvp?t=…`).

Sedam poslova 3.0 schedulera dira ovaj domen — **svi i dalje gađaju sy15**:

| Job key | Raspored | Šta zove | Gde je |
|---|---|---|---|
| `sast-action-reminders` | dnevno 09:00 | `sastanci_enqueue_action_reminders()` | `scheduler/sy15-cron-jobs.ts:143` |
| `sast-meeting-reminders` | svakih 5 min | `sastanci_enqueue_meeting_reminders()` | `sy15-cron-jobs.ts:149` |
| `sast-weekly-auto` | petak 08:00 | `sast_auto_create_weekly()` | `sy15-cron-jobs.ts:162` |
| `pb-enqueue` | dnevno 09:00 | `pb_enqueue_notifications()` | `sy15-cron-jobs.ts:177` |
| `sastanci-notify-dispatch` | svakih 2 min | `sastanci_dispatch_dequeue/mark_sent/mark_failed` | `scheduler/dispatch/sastanci-dispatch.service.ts:189` |
| `pb-notify-dispatch` | svakih 5 min | `pb_dispatch_dequeue/mark_sent/mark_failed` | `scheduler/dispatch/notify-dispatch.service.ts:174` |
| `sast-periodicni-auto` | dnevno 08:00 | direktan upis u sy15 `sastanci` / `sastanak_ucesnici` / `akcioni_plan` | `scheduler/sastanci-periodicni.service.ts:77` |

> 🔴 **Prekidač `SASTANCI_PB_IZVOR` NE prebacuje mejl kanal.** Ti poslovi ne prolaze kroz
> `withUserMapped`/`runIdem` (idu direktno preko `Sy15Service.db.$queryRaw`, bez RLS-a), pa branu
> ne vide. To je **namerno**: pod `3.0` sastanci i dalje šalju podsetnike iz sy15 podataka, što je
> tačno dok se ne prepišu `sastanci_enqueue_*` i `pb_enqueue_notifications` u NestJS.
> **Redosled je obavezan: prvo prepis enqueue logike, pa tek onda prekidač na `3.0` u punom obimu.**
>
> Dodatna zamka koju `.env.example:252-259` već beleži: `sastanci_dispatch_dequeue` claim **ne pomera**
> `next_attempt_at`, pa bi dva dispečera slala duplikate — preklop mora biti atomski.

---

## 6. Šta je urađeno u ovoj grani (`feat/sy15-seoba-sastanci-pb`)

| Šta | Gde | Stanje |
|---|---|---|
| 27 Prisma modela | `backend/prisma/schema.prisma` | ✅ `prisma validate` čist |
| Migracija (27 tabela, FK, indeksi, 30 CHECK, 5 parcijalnih/funkcijskih indeksa, tsvector + trigger, generisana kolona, 11 `updated_at` trigera) | `backend/prisma/migrations/20260805200000_sastanci_pb_seoba_sy15/` | ✅ **primenjena na probnu bazu, NE na prod** |
| Zajednički helper identiteta i predmeta | `backend/scripts/lib/sy15-identity.ts` | ✅ koristiće ga koraci 2–5 |
| Skripta prenosa | `backend/scripts/migrate-sastanci-pb-sy15.ts` | ✅ dry-run + `--apply` + `--verify-only` |
| Prepis DEFINER samouslužne logike | `backend/src/modules/sastanci/sastanci-samousluga.service.ts` | ✅ 4 funkcije, 15 testova |
| Prekidač `SASTANCI_PB_IZVOR` | `backend/src/common/sy15/sastanci-pb-source.service.ts` | ✅ 11 testova |
| Env red | `backend/.env.example` | ✅ |

### Prenosne odluke (sve izmerene)

1. **UUID PK-ovi se zadržavaju** → prenos je egzaktno idempotentan (upsert po `id`), bez remap tabele.
2. **Predmet → `Int` FK** na 3.0 `projects.id` (§2).
3. **Mejlovi doslovno** (§3.2). **`auth.users` → `users.id`** po mejlu (§3.1).
4. **`employees` ostaje meka uuid veza** bez FK-a (korak 4).
5. **PG enumi → `String` + `CHECK`** (`pb_task_status`, `pb_task_vrsta`, `pb_prioritet`,
   `pb_eng_tip_status`) — BACKEND_RULES §2.2, isti skup vrednosti.
6. **RLS se ne prenosi** (74 politike) — 3.0 koristi guardove i query-scoping (ODLUKE.md).
7. **Trigeri se dele na dve vrste:** mehanika se prenosi (`updated_at`, `search_tsv`), a **logika ne**
   (`sast_check_not_locked`, `akcioni_plan_trg_istorija`, `sast_trg_ucesnik_invite`,
   `pb_task_deps_check_cycle_trg`, `pb_eng_tip_likes_count_sync`…) — ona se prepisuje u NestJS.
   Spisak izostavljenih je u migraciji, §2.5.

### Prepisane DEFINER funkcije (4 od 65)

| sy15 `SECURITY DEFINER` | → NestJS | Pravilo koje se moralo zadržati |
|---|---|---|
| `sastanci_set_my_rsvp` | `setMyRsvp` | samo `dolazim`/`ne_dolazim`/null; poklapanje po `lower(email)`; 0 redova → `not_participant` |
| `sastanci_set_my_priprema` | `setMyPriprema` | `null` argument ne dira polje; prazan tekst → NULL |
| `sastanci_set_my_akcija_status` | `setMyAkcijaStatus` | samo `otvoren`/`u_toku`/`zavrsen` (**uži** od CHECK-a na tabeli); menja samo odgovorni; **status ≠ `zavrsen` BRIŠE potpis zatvaranja** |
| `sastanci_get_or_create_my_prefs` | `getOrCreateMyPrefs` | upsert po mejlu (ključ tabele je mejl, ne nalog) |

*Zašto baš te:* u sy15 su bile `DEFINER` samo zato što RLS ne bi dozvolio korisniku `UPDATE`;
sama provera je jedan `WHERE lower(email) = jwt.email`. U 3.0 nema RLS-a, pa taj `WHERE` postaje
obično sužavanje upita — pravilo je isto, sprovodi ga servis umesto baze.

### Dokaz izvodljivosti (izvršen, ne pretpostavljen)

Napravljena je **odvojena baza `sastanci_pb_proba`** (servosync-pg kluster, kroz SSH tunel),
primenjen **ceo lanac migracija** (`prisma migrate deploy` — sve prošlo, uključujući novu),
učitani FK ciljevi (`projects`, `users`, `workers` — kopija sa produkcije, read-only), pa je
skripta pročitala **živu sy15** (samo SELECT) i upisala:

```
sastanci_templates     1/1     akcioni_plan            98/98    pb_eng_tip_categories   9/9
sastanci               6/6     akcioni_plan_istorija 689/689    pb_eng_tips             2/2
sastanak_ucesnici    39/39     sastanak_arhiva          3/3     pb_tasks            106/106
presek_aktivnosti      9/9     sastanci_notif_log   134/134     pb_task_comments        8/8
                          … svih 27 tabela: brojevi se poklapaju
```

| Provera | Rezultat |
|---|---|
| prenos | **1.120/1.120 redova**, `ins=1119 upd=1` |
| verifikacija count-ova | **27/27 tabela OK** |
| **drugo pokretanje `--apply`** | **`ins=0 upd=1120`** — idempotencija je egzaktna |
| sekcija BLOKADE | **prazna** |
| mapa predmeta (dve nezavisne provere) | 22 po id-u = 22 po šifri ✅ |

Probna baza je posle dokaza **obrisana**.

### Provere

| Provera | Rezultat |
|---|---|
| `npx tsc --noEmit` | ✅ nula NOVIH grešaka. Ostaje 5 **zatečenih** grupa u **spec** fajlovima (`handovers`, `kadrovska.zahtev-026`, `kamata`, `moj-profil.zahtev-026`, `sales.controller`) — izmereno `git stash` metodom nad istim stablom; `tsconfig.build.json` isključuje `**/*spec.ts` |
| `npx jest` (pun set) | ✅ **242 suite / 5.185 testova prošlo** (+26 novih) |
| `npm run build` | ✅ entrypoint `dist/main.js` |
| **boot-smoke `node dist/main`** | ✅ „Nest application successfully started" — i sa `SASTANCI_PB_IZVOR=sy15` i sa `=3.0` |

### Prekidač — šta stvarno radi danas

`SASTANCI_PB_IZVOR=sy15` (podrazumevano, **i za svaku neprepoznatu vrednost**) = ponašanje kao do sada.

`SASTANCI_PB_IZVOR=3.0`:

- **rade iz 3.0 baze:** moj RSVP, moja priprema, status moje akcije, moja podešavanja obaveštenja;
- **sve ostale rute sastanaka i CEO projektni biro vraćaju 503** sa porukom koja kaže i šta je
  zapelo i kako se vraća.

Zašto 503 a ne tiho čitanje sy15: pod prekidačem u položaju „3.0" upis koji bi ipak otišao u sy15
razišao bi dve baze, a to se **ne vidi odmah** — otkrilo bi se tek kad se brojevi ne poklope.
Zato je jedini ulaz u sy15 iz oba servisa sveden na **dva getera sa branom**
(`withUserMapped`, `runIdem`).

---

## 7. Šta uraditi na produkciji kad odluka padne

⚠️ **Preduslov koji nije ispunjen:** koraci ispod prenose *podatke*. Moduli će raditi na 3.0 tek kad
se napiše i ono što danas živi u bazi. Procena preostalog posla:

| Posao | Procena |
|---|---|
| Sastanci: 21 `sast_*` + 14 `sastanci_*` fn + 2 view-a + zaključavanje/arhiva/PDF | **4–6 dana** |
| Sastanci: enqueue mejlova (`sastanci_enqueue_*`) + trigeri pozivnica | 1–2 dana |
| PB: **blokiran do koraka 4** (kadrovska) — `pb_current_employee_id` i org struktura | — |

Sam prenos podataka je **~10 minuta**.

### Redosled

| # | Korak | Trajanje | Povratak |
|---|---|---|---|
| 0 | `ssh ubuntusrv` + noćni klon 3.0 baze (postojeći backup) | 5 min | — |
| 1 | Zamrzni upis: javi da se ~15 min ne unose akcione tačke i ne zaključava sastanak | 1 min | — |
| 2 | `npm run migrate:prod` (`prisma migrate deploy`) — kreira 27 praznih tabela | ~10 s | tabele su nove i prazne → `DROP` je bezbedan |
| 3 | `migrate status` mora biti čist (bez drift-a) | 5 s | — |
| 4 | `npx ts-node --transpile-only backend/scripts/migrate-sastanci-pb-sy15.ts` (**dry-run**) — sekcija „BLOKADE" mora biti prazna, a mapa predmeta mora dati **isti broj po id-u i po šifri** | ~30 s | ništa se ne piše |
| 5 | `... --apply` — 1.120 redova | ~2 min | `TRUNCATE` 27 tabela + ponovi (sy15 je i dalje netaknut izvor) |
| 6 | `... --verify-only` — svih 27 redova mora reći `OK` | ~10 s | — |
| 7 | `SASTANCI_PB_IZVOR=3.0` u `backend.env` + `systemctl restart` / redeploy kontejnera | ~2 min | **`SASTANCI_PB_IZVOR=sy15` + restart = ~2 min** |
| 8 | `ssh ubuntusrv 'bash -s' < backend/scripts/post-deploy-verify.sh` — mora 🟢 EXIT 0 | ~1 min | — |
| 9 | Ručna proba: otvori sastanak, potvrdi dolazak (RSVP), upiši pripremu, promeni status svoje akcije | 5 min | v. korak 7 |

**Ukupno: ~10 minuta rada + 5 minuta probe.**

### Povratak (rollback)

Jedan potez, bez deploy-a koda: **`SASTANCI_PB_IZVOR=sy15` + restart (~2 min).** sy15 se tokom
seobe ne dira, pa je u svakom trenutku važeći izvor. Prenete 3.0 tabele ostaju kao mrtav teret dok
se ne pokuša ponovo — ne smetaju.

⚠️ **Tačka bez povratka:** čim se pod `SASTANCI_PB_IZVOR=3.0` upiše **prvi** RSVP ili status akcije,
3.0 ima podatak koji sy15 nema. Od tada povratak traži ručno prenošenje tih redova nazad.
Zato korak 9 treba raditi odmah i na jednom sastanku.

### Poznati repovi (svesno ostavljeni)

1. 🔴 **Fajlovi ostaju u sy15 storage-u.** Prenose se samo putanje. Bucket-i:
   `sastanci-arhiva` (22 objekta), `pb-eng-tip-files` (1), `sastanak-slike` (0), `pb-task-files` (0).
   URL-ovi se i dalje potpisuju kroz `Sy15StorageService` (`SY15_STORAGE_URL` = javni gateway) i
   **ostaju važeći** — čitanje starih zapisnika radi i posle prebacivanja. Seoba fajlova ide sa
   korakom 2 (održavanje, 469 MB), kad se ionako gradi put za storage.
2. 🔴 **Mejl kanal ostaje na sy15** (§5) — prekidač ga ne pokriva.
3. 🔴 **RSVP magic-link i dalje gađa sy15 Edge fn** `sastanci-rsvp`. Tokeni (`rsvp_token`) se prenose
   **doslovno**, pa već poslati linkovi rade; ali sam endpoint piše u sy15. Prepisati zajedno sa
   enqueue logikom.
4. 🟡 **Tipfeler `zoran.jarakovic@servoteh.ocm`** (2 reda) — prenosi se kakav jeste. Ispraviti u
   aplikaciji (šablon učesnika), ne u skripti seobe.
5. 🟡 **`akcioni_plan_istorija` se posle seobe puni iz NestJS-a**, ne iz trigera — dok se to ne
   napiše, izmene akcionih tačaka pod `3.0` ne bi ostavljale trag. Trenutno je to bezopasno jer
   izmene akcija pod `3.0` padaju sa 503.
6. `rev_api_idempotency` se ne dira — registar cele aplikacije (56 redova sastanaka, 31 PB-a) ostaje
   u sy15 dok tamo ima ijedan modul.
7. sy15 tabele domena se **ne brišu** ni posle uspešne seobe. Tek posle 2–3 nedelje mirnog rada, i
   to zasebnom odlukom.

---

## 8. Preporuka

**Sastanci JESU dobar prvi rez — ali samo sastanci, ne i projektni biro.**

Merenje je potvrdilo premisu plana u jednom delu i oborilo je u drugom:

- 🟢 **Potvrđeno:** domen nema transakcioni šav ka drugom domenu (za razliku od reversa),
  mapa predmeta radi 22/22, identitet je 100% pokriven, prenos je dokazan i idempotentan.
- 🔴 **Oboreno:** „PB vuče 4 FK ka kadrovskoj koje pokriva mapa identiteta" — ne pokriva.
  `pb_current_employee_id()` traži **tabelu `employees`**, ne mapu; a funkcije opterećenja traže i
  `departments`/`sub_departments`/`job_positions`. **Projektni biro se ne može uključiti pre
  koraka 4 (kadrovska)**, bez obzira što su mu podaci preneti.

Zato predlog za sledeći potez:

1. **Prepisati sastanke** (4–6 dana) i pustiti ih na `3.0` same — PB ostaje na sy15 pod istim
   prekidačem (i danas tako pada sa 503).
2. Ako se traži brži dobitak: **razdvojiti prekidač** na `SASTANCI_IZVOR` i `PB_IZVOR` tek kad
   sastanci budu gotovi — danas bi razdvajanje samo dozvolilo pola domena u jednoj a pola u drugoj
   bazi bez ijedne koristi.
3. **PB pomeriti iza kadrovske** u redosledu plana (bio je korak 1, treba da bude korak 4b).

Ono što je ovde napisano važi u oba slučaja: šema, migracija, skripta prenosa i mapa identiteta su
gotove i dokazane, a helper `sy15-identity.ts` je zajednički za sve preostale korake.

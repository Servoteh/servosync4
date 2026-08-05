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
2. ~~🔴 Mejl kanal ostaje na sy15 (§5)~~ — **ZATVORENO 06.08.** (v. §7b): tri scheduler posla i
   dispečer sastanaka poštuju prekidač; `pb-enqueue` i PB dispečer idu kroz `assertPorted`.
3. ~~🔴 RSVP magic-link gađa sy15 Edge fn~~ — **ZATVORENO 06.08.** (v. §7d).
4. 🟡 **Tipfeler `zoran.jarakovic@servoteh.ocm`** (2 reda) — prenosi se kakav jeste. Ispraviti u
   aplikaciji (šablon učesnika), ne u skripti seobe.
5. 🟡 **`akcioni_plan_istorija` se posle seobe puni iz NestJS-a**, ne iz trigera — dok se to ne
   napiše, izmene akcionih tačaka pod `3.0` ne bi ostavljale trag. Trenutno je to bezopasno jer
   izmene akcija pod `3.0` padaju sa 503.
6. ~~`rev_api_idempotency` se ne dira~~ — **DOPUNJENO 06.08.** (v. §7e): 3.0 je dobio SVOJ generički
   registar (`api_idempotency`), pa sastanci pod `3.0` više ne zavise od sy15 registra. sy15
   `rev_api_idempotency` **se i dalje ne dira i ne prazni** — služi modulima koji su još tamo
   (kadrovska ~470 redova, PB 31, održavanje 16). Dva registra rade paralelno, svaki za svoju
   stranu prekidača; **stari ključevi se NE prenose** (registar je kratkotrajan po prirodi).
7. sy15 tabele domena se **ne brišu** ni posle uspešne seobe. Tek posle 2–3 nedelje mirnog rada, i
   to zasebnom odlukom.

---

## 7b. Prepis logike — šta je urađeno 06.08. i šta je OSTALO

Runbook iznad prenosi *podatke*. Ovaj odeljak je o *logici* koja je živela u bazi.

### Inventar — mereno, ne procenjeno

Spisak se NE pravi po katalogu funkcija nego po **stvarnim pozivima iz 3.0 koda**
(`grep` nad `backend/src/`, 06.08.2026) i po **FK/triger grafu** žive sy15.

| Šta | Koliko |
|---|---:|
| funkcije celog domena (sastanci **+** PB) | 73 (65 `SECURITY DEFINER`) |
| od toga **samo sastanci** | **39** |
| direktno pozvane iz 3.0 (`SELECT fn(...)`) | **23** |
| dodatno dosegnute preko njih (helperi koje te fn zovu) | 5 |
| trigeri koje domen okida implicitno | 6 |
| **ukupno dosegnuto = prepisano** | **34 od 39** |
| 🔴 **potvrđeno mrtve** (definisane, ništa ih ne doseže) | **3** |
| PB funkcije | 34 — **ne diraju se** (blokirane kadrovskom, §4) |

**Direktno pozvane (23):** `sastanci_set_my_rsvp` · `sastanci_set_my_priprema` ·
`sastanci_set_my_akcija_status` · `sastanci_get_or_create_my_prefs` *(ove 4 su bile
prepisane 05.08.)* · `sast_weekly_status` · `sast_dashboard_stats` ·
`get_sastanci_user_directory` · `sast_enqueue_cancel` · `sast_zakljucaj_sastanak` ·
`sast_set_zapisnik_datum` · `sastanci_send_invites` · `sastanci_remind_unprepared` ·
`sastanci_resend_meeting_locked` · `sast_weekly_pomeri` · `sast_weekly_odlozi` ·
`sast_weekly_vrati` · `set_sastanci_ai_model` · `sastanci_enqueue_action_reminders` ·
`sastanci_enqueue_meeting_reminders` · `sast_auto_create_weekly` ·
`sastanci_dispatch_dequeue` · `sastanci_dispatch_mark_sent` ·
`sastanci_dispatch_mark_failed`.

**Dosegnute preko njih (5):** `sastanci_enqueue_notification` (jezgro mejl kanala) ·
`sast_create_weekly_at` · `sast_target_week_monday` · `sast_next_week_monday` ·
`sast_adjust_for_holiday` · plus gejtovi `sast_user_can_move_weekly`,
`current_user_is_management`, `current_user_is_admin`, `has_edit_role`,
`is_sastanak_ucesnik` (poslednjih pet nisu `sast*` pa ne ulaze u 39).

**Trigeri koji su LOGIKA, ne mehanika (6)** — migracija ih namerno ne prenosi:
`sast_trg_ucesnik_invite` · `sast_trg_ucesnik_invite_cleanup` ·
`sast_trg_meeting_locked` · `akcioni_plan_trg_istorija` · `sast_check_not_locked` ·
`sast_pm_teme_draft_status_guard`.

### 🔴 Nalaz: tri funkcije su mrtve, i jedna od njih znači da mejl NE STIŽE

| Funkcija | Zašto je mrtva | Posledica |
|---|---|---|
| `sast_trg_akcija_new` (1.301 zn.) | **nijedan triger je ne poziva** — provereno `pg_trigger` nad `akcioni_plan`: postoje samo `akcioni_plan_istorija_trg`, `sast_trg_locked_guard_akcioni_plan`, `trg_akcioni_plan_updated` | 🔴 „dodeljena ti je akcija" mejl **se ne šalje** |
| `sast_trg_akcija_changed` (2.717 zn.) | isto | 🔴 „akcija ti je izmenjena" mejl **se ne šalje** |
| `sastanci_pulse_notify_dispatch` | pg_cron posao je `f` (dispatch preseljen u 3.0, Talas A) | nema — zamenjena |

**Merenje koje to potvrđuje** (`sastanci_notification_log`, poslednji red po vrsti):

| vrsta | redova | poslednji |
|---|---:|---|
| `meeting_invite` | 52 | 04.08.2026 |
| `meeting_reminder` | 25 | 03.08.2026 |
| `meeting_locked` | 50 | 28.07.2026 |
| `action_reminder` | 1 | 05.07.2026 |
| `akcija_new` | 5 | **23.06.2026** |
| `akcija_changed` | 1 | **23.06.2026** |

Trigeri su očigledno bili zakačeni pa **skinuti 23.06.2026** i nikad vraćeni — od
tada odgovorni ne dobija mejl kad mu se dodeli ili izmeni akciona tačka.

> **ODLUKA JE PROSLEĐENA, NE DONETA:** te dve funkcije **nisu** prepisane. Prepis
> bi ih *oživeo* — ljudi bi odjednom počeli da primaju obaveštenja koja šest
> nedelja ne stižu, i to za sve akcije koje se u međuvremenu dodeljuju. To je
> odluka o proizvodu (da li se uopšte želi taj mejl), ne o seobi. Ako se želi,
> telo je u ovom runbook-u i prepis je pola dana.

### Šta je prepisano (i gde)

| Novo | Sadržaj |
|---|---|
| `backend/src/modules/sastanci/sastanci-fn.service.ts` | 17 DEFINER fn + 6 trigera + helperi; svako telo izvučeno sa **žive** sy15 (`pg_get_functiondef`) |
| `backend/src/modules/sastanci/sastanci-authz.service.ts` | 3.0 parnjak sy15 gejtova nad `users`+`user_roles` |
| `backend/prisma/migrations/20260806090000_sastanci_view_ovi_3_0/` | `v_akcioni_plan` + `v_pm_teme_pregled` doslovno |
| testovi | 72 paritet-testa (zaključavanje, TZ podsetnika, istorija akcija — sva tri obavezna) |

**Tri svesna odstupanja od PL/pgSQL izvora**, sva posledica seobe a ne izbor:
`auth.jwt() ->> 'email'` postaje eksplicitan argument · gejtovi prava čitaju 3.0
tabele · `kadr_holidays` prosleđuje pozivalac.

### 🔴 Zašto `SastanciAuthzService` MORA da postoji

U sy15 je row-scope sprovodio RLS, pa ga kod **namerno nije duplirao** (doktrina
A.2a — „scope se NE duplira u WHERE"). U 3.0 RLS-a nema (ODLUKE.md). Da se ovaj
sloj nije napisao, prava bi **tiho nestala**: svako sa `sastanci.edit` permisijom
menjao bi i otkazivao TUĐE sastanke, a nijedan test to ne bi primetio.

Prepisano je: `sastanci_update`/`sastanci_delete` scope (mgmt ∨ vodio ∨ zapisničar
∨ created_by) na `cancel`/`delete`, guard zaključanog sastanka, i mgmt/admin/
allowlist gejtovi u samim funkcijama.

### Šta pod `3.0` RADI od 06.08.

Sedmični status · KPI Pregleda · direktorijum korisnika · AI model (čitanje i
upis) · **zaključavanje sastanka + arhiva + zapisnik mejl** · ispravka datuma
zapisnika · otkazivanje · brisanje · pozivnice · podsetnik nepripremljenima ·
ponovno slanje zapisnika · pomeri/odloži/vrati sedmični · podešavanja obaveštenja ·
sve četiri samouslužne radnje (05.08.) · **cela automatika mejlova i dispatch**.

---

## 7d. RSVP magic-link — 3.0 parnjak (poslednja edge fn)

Ruta: **`/api/v1/sastanci-rsvp?t=<token>&r=dolazim|ne_dolazim[&c=1]`**, javna (bez
JWT-a). `SastanciRsvpController`. Tokeni su preneti doslovno, pa **linkovi koji su
već u sandučićima rade**. Pod `sy15` ruta ne piše u 3.0 nego radi **302 na sy15
edge** sa nepromenjenim upitom — klik se beleži kod vlasnika podatka.

### 🔴 Nalaz: edge fn ima treći parametar koji nijedan naš dokument nije pomenuo

Edge funkcija je **pročitana sa živog kontejnera** (`sy15-functions`, 9.829 B), a
ne izvedena iz linka u mejlu. Da je izvedena, izgubila bi se ova zaštita:

> **Bez `c=1` edge NE PIŠE NIŠTA** — vraća samo stranu potvrde sa dugmetom.
> Razlog je u komentaru samog edge-a: prvi GET na link iz mejla radi **i svaki
> mašinski skener** (Microsoft SafeLinks, antivirus, link-preview bot), pa bi upis
> na prvi GET beležio lažno „Dolazim" za ljude koji link nisu ni otvorili.

Isti razlog traži i **`@Head()` handler deklarisan PRE `@Get()`**: Express
`router.get()` hvata i HEAD zahteve, pa bi bez toga skener koji radi HEAD na link
sa `c=1` prošao kroz celu GET granu i upisao RSVP.

### Dva popravljena kvara nađena usput

1. 🔴 **Dispečer je i pod `3.0` čitao `rsvp_token` sa sy15.** Zatečeni tokeni su
   preneti pa bi „radilo" — ali učesnik dodat POSLE preklopa ne postoji u sy15, pa
   bi mu pozivnica tiho stigla **bez dugmadi**.
2. 🔴 **Bazni URL ne sme iz `PUBLIC_APP_URL` lanca** — ta kaskada daje adresu
   **fronta**, a front i API su različiti hostovi i Worker ne proksira `/api`. Link
   bi pao na static export → 404, tj. **tačno bag koji je RSVP link već jednom
   imao**. Zato nova env `PUBLIC_API_URL`, sa produkcionom vrednošću kao
   podrazumevanom — preklop ne traži novo podešavanje na serveru.

---

## 7c. 🔴 PREOSTALE BLOKADE za preklop sastanaka na `3.0`

Ovo je pun spisak — modul pod `3.0` **još nije ceo**. Rangirano po tome šta
zaustavlja preklop.

| # | Blokada | Zašto blokira | Procena |
|---|---|---|---:|
| ~~**1**~~ | ~~**Registar idempotencije `rev_api_idempotency` ostaje u sy15**~~ | ✅ **ZATVORENO 06.08.** — v. §7e. Registar je u 3.0 (`api_idempotency`, generički za celu aplikaciju); `create-sastanak`, `bulk-ucesnici`, `prenos` i `instantiate` više ne vraćaju 503. | — |
| **2** | **Tabelarni CRUD još ide kroz `withUserMapped`** (73 poziva) | Liste, detalj, učesnici, tačke, odluke, akcije, teme, šabloni, arhiva, slike. Sve to su obični upiti nad tabelama koje SU prenete, ali prolaze kroz branu ka sy15. | **2–3 dana** |
| **3** | **RLS write-scope za OSTALU decu sastanka** | Politike `pa_*`, `ps_*`, `sa_*`, `pmt_*` = `has_edit_role ∧ (učesnik ∨ mgmt ∨ organizator-trio)`. Prepisano je: scope nad `sastanci` (ranije) **i `sastanci_insert` + `su_*` + `ap_*`** (06.08., traže ih četiri rute iz blokade 1). Ostatak ide uz blokadu 2 i **ne sme kasniti za njom** | uključeno u 2 |
| ~~**4**~~ | ~~**RLS read-scope na dve tabele**~~ | ✅ **ZATVORENO 06.08.** — v. §7e. Merenje je našlo **tri** tabele, ne dve (runbook je promašio `sastanci_notification_prefs`). | — |
| **5** | 🔴 **`projekat_id` je promenio TIP** (uuid → Int) | FE danas šalje sy15 uuid predmeta (`?projekatId=`), a 3.0 kolona je `Int`. DTO, picker (`listProjekti`) i svi filteri po predmetu moraju da se prevedu ZAJEDNO sa FE-om. Uz to 3.0 `projects` **nema** `project_code` ni `bigtehn_item_id` — parnjaci su `project_number` i sam `id`, pa se menja i SQL u `AKCIJE_SELECT` | 1 dan (BE+FE zajedno) |
| **6** | **`kadr_holidays` nije u 3.0** | Pomeranje sedmičnog sa praznika. Danas se čita READ-ONLY sa sy15 (fail-soft: bez praznika termin se ne pomera). Nestaje sa **korakom 4** (kadrovska) — nije potrebno rešavati posebno | — |
| **7** | **`get_predmet_plan_prioritet_ids()`** (⭐ lista predmeta) | Čita `production.predmet_plan_prioritet` u sy15. Nije domen sastanaka — stiže sa svojim modulom | — |
| **8** | **Fajlovi ostaju u sy15 storage-u** | Nepromenjeno (§7 rep 1) — putanje su prenete, URL-ovi važe | — |
| **9** | 🟡 **Dopuna mejla (`enrichPayload`) i dalje čita sy15** | Dispečer pod `3.0` čita/piše RED u 3.0, ali dopunu tela mejla (zaduženja iz `v_akcioni_plan`, PDF zapisnika iz arhive) i dalje vuče sa sy15. **Svi ti pozivi su fail-soft**, pa je najgori ishod mejl bez dopune — ne pad. Ide uz blokadu 2 | uključeno u 2 |

### Provere urađene 06.08.

| Provera | Rezultat |
|---|---|
| `npx tsc --noEmit` | ✅ nula NOVIH grešaka (ostaje 5 **zatečenih** grupa u spec fajlovima) |
| `npx jest` (pun set) | ✅ **246 suite / 5.299 testova** (+4 suite, +114 testova) |
| `npm run build` | ✅ entrypoint `dist/main.js` |
| 🔴 **boot-smoke `node dist/main`** | ✅ „Nest application successfully started" — protiv **žive 3.0 baze**, i sa `SASTANCI_PB_IZVOR=sy15` i sa `=3.0` |
| view-ovi na probnoj bazi | ✅ primenjeni nad PRAVIM DDL-om tabela; **22 / 24 kolone — isto kao sy15**; `effective_status` izvodi `kasni` sa `dana_do_roka = -5` |
| FK `ON DELETE` protiv žive sy15 | ✅ 19/19 se poklapa (posle popravke 4 koja su bila `CASCADE` umesto `SET NULL`) |

**Zbir onoga što je ostalo za sastanke: ~3–4 dana** (blokade 2+3 i 5; blokade 1 i 4
zatvorene 06.08.).

### Redosled koji se preporučuje

1. ~~Blokada **4** (read-scope)~~ ✅ urađeno 06.08. — bilo je prvo namerno: bez
   njega blokada 2 postaje bezbednosni propust.
2. ~~Blokada **1** (registar idempotencije)~~ ✅ urađeno 06.08.
3. Blokada **2 + 3** — CRUD i njegov write-scope se ne razdvajaju. Read-scope i
   deo write-scope-a (`sastanci_insert`, `su_*`, `ap_*`) su već tu i **moraju se
   iskoristiti**, ne napisati ponovo.
4. Blokada **5** — traži usklađen FE deploy, pa ide poslednja.

---

## 7e. Blokade 1 i 4 — šta je urađeno 06.08.

### Blokada 4: RLS read-scope (`SastanciAuthzService`)

Politike su povučene sa **žive sy15** (`pg_policies`), ne iz ovog dokumenta —
pravilo iz BACKEND_RULES/ODLUKE. Izmereno: **svih 27 tabela domena ima
`relrowsecurity = TRUE`** i bar jednu SELECT/ALL politiku (nema tabele sa
podrazumevanom zabranom).

🔴 **Nalaz: blokada 4 je nabrajala DVE tabele, a ima ih TRI.** Tekst iznad kaže
„ostale SELECT politike su `true` pa nemaju šta da se prenese" — netačno.

| Tabela | SELECT politika | Pravilo | Stanje |
|---|---|---|---|
| `pm_teme` | `pmt_select` | predlagač ∨ mgmt ∨ učesnik(sastanak_id) ∨ (draft ∧ bez sastanka ∧ edit) | ✅ `scopeTemeWhere` + `scopeTemeSql` |
| `sastanci_notification_log` | `snl_select` | primalac ∨ mgmt | ✅ `scopeNotifLogWhere` |
| **`sastanci_notification_prefs`** | `snp_select_own` | **svoj red ∨ mgmt** | ✅ `scopeNotifPrefsWhere` — **nije bio u spisku** |
| ostalih 13 tabela sastanaka | — | `true` (javno za `authenticated`) | nema šta da se prenese |

**Otvoreno (`true`), popisano da se ne pogađa ponovo:** `sastanci`,
`sastanak_ucesnici`, `sastanak_odluke`, `sastanak_arhiva`, `akcioni_plan`,
`akcioni_plan_istorija`, `presek_aktivnosti`, `presek_slike`,
`sastanci_templates`, `sastanci_template_ucesnici`, `sastanci_ai_settings`,
`sast_weekly_movers`, `sast_weekly_skip`.

🔴 **Drugi nalaz: `sast_dashboard_stats` je JEDINA pozvana fn domena koja NIJE
`SECURITY DEFINER`** (`pg_proc.prosecdef = f`). U sy15 se izvršava pod
`SET LOCAL ROLE authenticated`, pa njen `count(*) FROM pm_teme` **prolazi kroz
`pmt_select`**. Prepis na ovoj grani je brojao nesuženo → KPI „Teme na čekanju"
je pod `3.0` odavao i tuđe (pa i tuđe draft) teme. Popravljeno; ostale četiri
brojke gledaju objekte sa politikom `true` i **ostaju nesužene** (sužavanje bi
bilo regresija).

Usput izmereno: oba view-a (`v_pm_teme_pregled`, `v_akcioni_plan`) su u sy15
`security_invoker = true`, tj. RLS pozivaoca se **primenjuje i kroz view** —
zato `listTeme` pod `3.0` MORA da spoji `scopeTemeSql`.

**Prvi potrošač:** `notifications()` (lista obaveštenja) skinuta sa 503 — red tog
outbox-a nosi `subject`, `body_html` i `payload` cele poruke. `myPrefs` je već
išao kroz `getOrCreateMyPrefs` (upsert po svom mejlu) pa scope zadovoljava po
konstrukciji. `listTeme` **ostaje na 503** zbog blokade 5 (`projekatId` uuid→Int);
njen scope je gotov i pokriven testovima.

**⚠️ Jedno svesno odstupanje, mereno:** sy15 `snl_select`/`snp_select_own` porede
KOLONU doslovno sa `lower(jwt.email)` (samo desna strana spuštena), dok
`pmt_select` spušta obe. Ovde su sva tri poređenja neosetljiva na veličinu slova.
Razlika je **nulta na živim podacima** — `sastanci_notification_log` 0/134 i
`sastanci_notification_prefs` 0/6 redova ima veliko slovo — i može pokazati samo
sopstveni red, nikad tuđi.

**Projektni biro se NE dira** (pada sa 503 do koraka 4), ali su mu read-politike
popisane da ne budu promašene kad dođe na red:

| PB tabela | SELECT qual | Traži |
|---|---|---|
| `pb_eng_tips` | `deleted_at IS NULL ∧ (published ∨ admin ∨ autor = ja)` | `pb_current_employee_id()` |
| `pb_eng_tip_files` | `pb_eng_tip_visible(tip_id)` | isto, preko roditelja |
| `pb_work_reports` | `can_see_all ∨ svoj employee_id` | isto + org struktura |
| `pb_notification_log` | `recipient_user_id = uid()` (+ admin ALL) | `auth.uid()` |
| `pb_tasks`, `pb_task_files` | `deleted_at IS NULL` | ništa — soft-delete filter, ne identitet |

### Blokada 1: registar idempotencije (`api_idempotency`)

**Generička 3.0 tabela**, ne „sastanci": izmereno da sy15 `rev_api_idempotency`
uprkos `rev_` prefiksu nikad nije bio samo za reverse — **643 reda, 35 različitih
`action` vrednosti**: `kadr.grid.batch` 368, kadrovska ukupno ~470, sastanci 56,
PB 31, održavanje 16, **reversi 2**. Zato ime, servis (`IdempotencyService`) i
modul stoje u `common/` i koristiće ih koraci 2–5 gašenja sy15.

| | sy15 `rev_api_idempotency` | 3.0 `api_idempotency` |
|---|---|---|
| ključ | `client_event_id uuid` PK | isto (namerno — PK je i brava) |
| akcija | `action text` | `action varchar(100)` |
| odgovor | `result jsonb` | isto |
| akter | **nema** | `actor_email varchar(255)` |
| TTL | **nema čišćenja UOPŠTE** | 30 dana, `RetentionJobsService` |
| indeks | samo PK | + `created_at` (za retention brisanje) |

**TTL — mereno, ne procenjeno.** sy15 registar nema ni pg_cron posao ni triger za
čišćenje; `min(created_at) = 2026-07-10` (dan nastanka registra),
`max = 2026-08-05`, 643 reda, **nijedan nikad obrisan** → efektivni TTL je
beskonačan. Stvarna svrha ključa traje sekunde. Uzeto 30 dana (isti red veličine
kao `DICTATION_DELIVERED_DAYS`) — brisanje starijeg ključa ne može da napravi
duplikat jer klijent za svaki nov POST kuje NOV uuid.

🔴 **Stari zapisi se NE migriraju.** Prenos 643 tuđa ključa ne bi odbranio nijedan
zahtev — samo bi preneo smeće.

**Jedna namerna razlika: provera aktera.** sy15 na ponovljen ključ vraća sačuvan
odgovor **bilo kome** ko ga zna, a odgovor nosi tuđe podatke (id i naslov tuđeg
sastanka, broj prenetih akcija). Ključ je nasumičan uuid pa je praktično
neiskoristivo, ali provera ne košta ništa → tuđi ključ dobija 409 umesto tuđeg
rezultata. Legitiman slučaj (isti korisnik ponavlja svoj zahtev) je netaknut.

**Ugovor prema klijentu je NEPROMENJEN:** isti `clientEventId` iz zahteva, isti
`action` prostor imena, isti `{ data, meta: { idempotent } }` odgovor, isti 409 na
ključ upotrebljen za drugu akciju.

**Skinuto sa 503** (pod `SASTANCI_PB_IZVOR=3.0`):
`POST /sastanci` (`sastanci.create-sastanak`) · `PUT /sastanci/:id/ucesnici`
(`sastanci.bulk-ucesnici`) · `POST /sastanci/:id/prenos` (`sastanci.prenos`) ·
`POST /sastanci/templates/:id/instantiate` (`sastanci.instantiate-template`).
Uz svaku je moralo i ono što je u sy15 radila baza:

- **gejt prava PRE registra** (neovlašćen pokušaj ne sme da potroši korisnikov
  `clientEventId`) — `sastanci_insert` = `has_edit_role()`, `su_*`/`ap_*` =
  `has_edit_role ∧ (mgmt ∨ učesnik ∨ organizator-trio)`;
- **logički trigeri koje migracija namerno ne prenosi**: `sast_trg_ucesnik_invite`
  (bez njega bi novi sastanak nastao BEZ ijedne pozivnice, tiho),
  `sast_trg_ucesnik_invite_cleanup`, `sast_check_not_locked`;
- kod `prenos` gejt se traži **i za izvor i za cilj** — `ap_update` u sy15
  proverava i `USING` (stari red) i `WITH CHECK` (novi red).

⚠️ **Rep:** `create-sastanak` pod `3.0` **ne upisuje predmet** (`projekat_id`) —
DTO još nosi sy15 uuid, a 3.0 kolona je `Int` (blokada 5). Predmet se ćutke
ispušta; uuid u `Int` koloni bi bio 500. Zatvara se sa blokadom 5.

**Merenje umesto pretpostavke — konkurentni isti ključ.** Ceo dizajn stoji na
tome da `INSERT … ON CONFLICT DO NOTHING` nad PK-om ČEKA, a ne da propusti drugi
poziv. Provereno na odvojenoj probnoj bazi (`idem_proba`, PostgreSQL 17.6,
napravljena i obrisana u toku rada): sesija A zauzme ključ i drži transakciju 3 s;
sesija B sa istim ključem kreće 1 s kasnije i njen INSERT **blokira 1,981 s**
(tačno do A-inog COMMIT-a), vrati `INSERT 0 0`, pa pročita `result={"id": 1}` —
dakle **gotov** rezultat, nikad poluupisan red.

### Provere urađene 06.08. (blokade 1 i 4)

| Provera | Rezultat |
|---|---|
| `npx tsc --noEmit` | ✅ nula NOVIH grešaka. Ostaje istih 5 **zatečenih** grupa u spec fajlovima (`handovers`, `kadrovska.zahtev-026`, `kamata`, `moj-profil.zahtev-026`, `sales.controller`) — nijedan od tih fajlova nije u diff-u ovog rada (`git diff --name-only` protiv `1028ab37`), pa su zatečene po konstrukciji |
| `npx jest` (pun set) | ✅ **249 suite / 5.357 testova** (+3 suite, +58 testova) |
| `npm run build` | ✅ entrypoint `dist/main.js` |
| 🔴 **boot-smoke `node dist/main`** | ✅ „Nest application successfully started" protiv **žive 3.0 baze**, i sa `SASTANCI_PB_IZVOR=sy15` i sa `=3.0` |
| migracija `20260806120000_api_idempotency` | ✅ ceo lanac (109 migracija) primenjen na probnu bazu; `migrate status` čist, bez drift-a; probna baza obrisana |
| konkurentni isti ključ | ✅ izmereno na PostgreSQL-u (v. gore), ne pretpostavljeno |

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

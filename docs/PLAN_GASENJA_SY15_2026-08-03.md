# Gašenje sy15 — plan seobe na 3.0 bazu (03.08.2026)

Posle cutovera 1.0 ([ANALIZA_GASENJE_1.0](ANALIZA_GASENJE_1.0_2026-08-03.md)) ostaje pitanje:
kako ukinuti zavisnost od sy15 i sve dovesti u 3.0 bazu.

⚠️ `backend/docs/MIGRACIJA_3.0_PLAYBOOK.md` je pisan u julu, dok je 1.0 bila živa — njegove
pretpostavke o „paralelnom radu" i „1.0 kao izvor istine" **više ne važe**. Ovaj dokument ga
zamenjuje u delu koji se tiče baze.

**Sve niže je izmereno na produkciji 03.08.2026.**

---

## 1. Šta je zapravo u sy15 — merenje, ne procena

| Domen | Tabela | Veličina |
|---|---:|---:|
| **ostalo** (SCADA, BigTehn keš, logovi, auth, storage) | 107 | **843 MB** |
| kadrovska | 18 | 8,0 MB |
| lokacije | 7 | 3,3 MB |
| održavanje | 34 | 2,4 MB |
| reversi | 15 | 1,3 MB |
| sastanci | 9 | 0,9 MB |
| projektni biro | 11 | 0,8 MB |
| montaža / plan | 4 | 0,1 MB |

### 🔴 Nalaz 1: poslovni podaci koji se sele staju u ~17 MB

Svih šest živih domena zajedno = **16,8 MB**. Seoba **nije problem količine podataka** —
problem je seoba *logike* (147 modela u `prisma/sy15.prisma`, `SECURITY DEFINER` funkcije,
RLS politike).

### 🔴 Nalaz 2: NEMA lakog dobitka — „prazne" tabele su pune

> **ISPRAVKA 03.08 (prva verzija ovog dokumenta je bila pogrešna).** Prvo merenje je uzelo
> `pg_stat_user_tables.n_live_tup` kao broj redova i zaključilo da BigTehn keš drži ~94 MB za
> nula redova. **Netačno.** Te tabele nemaju izmena, pa ih autovacuum nikad nije dodirnuo i
> brojač je ostao na nuli iz vremena kad su bile prazne (`last_autovacuum` = `-`).
> `count(*)` posle `ANALYZE` daje stvarno stanje:

| Tabela | Veličina | **Stvarno redova** | (statistika je tvrdila) |
|---|---:|---:|---:|
| `scada_history` | 558 MB | 2.404.838 | 2.404.838 ✅ |
| `attendance_events` | 140 MB | 5.822 | 5.822 ✅ |
| `bigtehn_work_order_lines_cache` | 55 MB | **186.352** | ~~0~~ |
| `bigtehn_tech_routing_cache` | 21 MB | **76.647** | ~~1~~ |
| `bridge_sync_log` | 17 MB | 77.266 | 77.266 ✅ |
| `audit_log` | 16 MB | 14.380 | 14.380 ✅ |
| `bigtehn_work_orders_cache` | 12 MB | **40.758** | ~~0~~ |
| `ai_uputstva` | 3,5 MB | **173** | ~~0~~ |
| `production_active_work_orders` | 1,4 MB | **9.412** | ~~0~~ |
| `bigtehn_drawings_cache` | 1,5 MB | **5.427** | ~~0~~ |

**🔴 POUKA (važi za svaku buduću odluku o brisanju): `n_live_tup` NIJE broj redova.** Pre bilo
kakvog `DROP`/`TRUNCATE` obavezno `ANALYZE` + `count(*)`. Da se išlo po prvoj verziji ovog
dokumenta, obrisalo bi se 186 hiljada živih redova.

Ono što ostaje tačno:
- **`scada_history` (558 MB) je 2/3 cele baze** i pripada SCADA sistemu, ne poslovnoj aplikaciji.
- **`attendance_events`: 140 MB za 5.822 reda** = 87 MB heap + 53 MB indeksa, ~24 kB po redu.
  `VACUUM FULL` ga nije smanjio → prostor je stvarno zauzet (sadržaj, ne bloat). Vredi videti
  šta te kolone nose pre seobe.
- BigTehn keš (~95 MB) **nije smeće nego istorija** QBigTehn naloga, rutiranja i crteža.
  QBigTehn jeste mrtav od 22.07, ali podaci stoje i kod ih pominje na 8–16 mesta.
  **Odluka o njihovoj sudbini je zaseban zadatak — ne briše se usput.**

### 🔴 Nalaz 3: sy15 ima TRI pisca, ne jednog

Po broju izmena (`pg_stat_user_tables`):

| Pisac | Šta piše | Izmena |
|---|---|---:|
| **SCADA gateway** | `scada_snapshots`, `scada_sites`, `scada_history` | **4,09 mil.** |
| **bridge** (.mdb kanal) | `bigtehn_*_cache`, `bridge_sync_log`, `loc_*_ingest/heartbeat` | **~262 hilj.** |
| **3.0 aplikacija** | `work_hours`, `attendance_events`, `kadr_*`, `rev_*`, `loc_*` | ~20 hilj. |

**To je najvažnija stavka plana:** sy15 se ne može ugasiti dok se ne presele i SCADA i bridge.
Sama aplikacija je najmanji pisac.

> **Pojašnjenje o SCADA-i (Nenad, 03.08): gateway JESTE prebačen na 3.0** — kod živi u
> `scada/` u monorepou i vrti se na ubuntusrv. **Ali baza nije preseljena.** Izmereno:
> `servosync-pg` nema **nijednu** `scada_*` tabelu, poslednji zapis u sy15 `scada_history`
> je od 05.08. 15:31, a `backend/src/modules/energetika/energetika.service.ts:13` doslovno
> kaže: *„Podaci žive u sy15 (1.0) bazi; ovaj servis samo ČITA 5 `scada_*` tabela."*
>
> Praktično to **olakšava** posao: pošto je gateway naš kod u monorepou, prebacivanje je
> promena odredišta upisa + seoba pet tabela, bez pregovaranja sa tuđim sistemom.

---

## 2. Potpuna mapa pisaca — ko danas drži sy15 u životu (izmereno 03.08. uveče)

Žive konekcije (`pg_stat_activity`) + servisi na ubuntusrv + cron u bazi:

| # | Pisac | Šta radi | Dokaz |
|---|---|---|---|
| 1 | **`servoteh-bridge-scada.service`** | relej scada-app → sy15: `scada_snapshots` (5 s), `scada_history` (60 s), retencija brisanjem | `bridge/src/jobs/scadaSnapshot.js:107,135,159`; 4,09 mil. izmena; poslednji zapis danas 15:31 |
| 2 | **`servoteh-bridge.service`** (.mdb kanal) | BigBit masteri → `bigtehn_items_cache` (7.626), `bigtehn_customers_cache` (6.251), workers/machines + `bridge_sync_log` | poslednji upis **danas 04:00** (noćni uvoz iz BBDROP-a) |
| 3 | **pg_cron U SAMOJ BAZI** — 5 aktivnih poslova | `loc_bigtehn_ingest_5min` (na 5 min pretače BigTehn keš u `loc_*`!), `loc_purge_synced_daily`, `loc_sync_health_check_hourly`, `po_cleanup_orphaned_machines`, `scada_watchdog_every_5_min` | `cron.job`; notifikacioni dispatch poslovi su ugašeni (`f`) — preseljeni u 3.0 scheduler (Talas A) |
| 4 | **3.0 backend** (`servosync2_app` konekcija) | Prisma direktno (`rev_*`, `loc_*`) + `withUserRls` RPC (kadr/hr/sastanci/maint/pb) | najmanji pisac (~20 hilj. izmena) |
| 5 | **GoTrue + storage + PostgREST** | 60 naloga (9 prijava u 7 dana); storage 8 bucketa; PostgREST konekcije = bridge instance (`SUPABASE_URL=localhost:8080`) | `auth.users`, `storage.objects` |

**Ključna posledica:** čak i kad aplikacija (pisac #4) potpuno pređe, sy15 drže živa
pisci #1–#3 — a pisac #2 je vezan za BigBit, čije je gašenje planirano **01.02.2027**.
Dakle: ili se bridge **preusmerava na 3.0 bazu** (piše iste kaše tamo), ili sy15 živi do 2027.

### SCADA lanac — precizno (ispravka posle Nenadove primedbe)

`scada-app` (naš kod, `scada/` u monorepou) **ne piše u bazu uopšte** — drži lokalni
`data/history.json` (24 h, 1-min rezolucija). U sy15 piše **bridge-scada relej**. Ekran
Energetika u 3.0 čita tih 5 `scada_*` tabela iz sy15 (`energetika.service.ts:13`).
→ Seoba SCADA-e = preusmeriti relej + preseliti 5 tabela + prevesti `energetika.service` na
3.0 Prisma. Sve tri stvari su naš kod. `scada_history` retencija se već radi brisanjem
(`SCADA_HISTORY_RETENTION_DAYS`), pa 558 MB nije večno — može se doneti i odluka o kraćoj
retenciji umesto seobe cele istorije.

## 3. Logika u bazi — stvarna mera posla (ne podaci, već funkcije)

**346 `SECURITY DEFINER` funkcija** u `public` šemi:

| Domen | DEFINER fn | Trigeri | Napomena |
|---|---:|---:|---|
| kadr + hr | **58** | 9+3+2 | najviše logike; plate pod allowlist bravom |
| maint (održavanje) | **41** | 34 | |
| pb (projektni biro) | **32** | 11 | |
| loc (lokacije) | **26** | 8 | + 3 aktivna cron posla |
| **rev (reversi)** | **22** | 12 | ⚠️ v. ispravku niže |
| sastanci | 14 | 5 | kanonski RPC obrazac |
| scada | 5 | 1 | watchdog |
| „ostalo" | **148** | 69 | `ai_chat_*` (~20, AI asistent!), `assessment_*` (~15, ocenjivanje), auth/role pomoćne, kiosk… |

> **⚠️ ISPRAVKA moje ranije tvrdnje „reversi nemaju logiku u bazi" — imaju, i to srž:**
> `rev_issue_reversal`, `rev_confirm_return`, `rev_next_doc_number` (numeracija!),
> `rev_hand_tool_apply_delta`, `rev_write_off_tool`… ukupno 22. Reversi jesu najmanji po
> podacima, ali seoba znači **prepisivanje tih 22 funkcije u NestJS**. Olakšica: 3.0 ih već
> zove po imenu (poznate su i pobrojane), a testovi reversa postoje.

**Pravi posao seobe = prepisivanje ~200 živih funkcija domena u NestJS** (3.0 koristi guardove
+ query-scoping, ne RLS — ODLUKE.md), pri čemu je „ostalo" grupa (AI asistent, ocenjivanje)
posao za sebe koji nijedan domenski korak ne pokriva.

## 4. Šavovi koji određuju redosled

- **67 FK kolona po `public` šemi gađa `auth.users` (GoTrue).** Svaka preseljena tabela sa
  takvom kolonom mora dobiti mapiranje sy15 `auth.users.id` → 3.0 `users.id` (SSO već ima
  upar po mejlu). To je **prvi zajednički imenilac svih koraka** — mapa identiteta se pravi
  jednom, pre prvog domena.
- **Reversi FK van domena:** `users` (issued_by, return_confirmed_by…), `employees`
  (issued_to, recipient), `loc_locations` (recipient_loc, cutting stock), `bigtehn_artikli_cache`
  (katalog alata po BigBit šifri!). Dakle ni reversi nisu ostrvo: vuku identitet, lokacije i
  BigBit šifre.
- **`loc_*` je vezan za bridge** (`loc_bigtehn_ingest_5min` pretače BigTehn keš u lokacije
  na 5 min) — lokacije se ne sele bez odluke o bridge-u.
- **Storage: 1,5 GB u 8 bucketa** — `bigtehn-drawings` **995 MB** (5.427 QBigTehn crteža,
  istorija), `maint-machine-files` **469 MB** (živo), `employee-docs` 24 MB (poverljivo),
  `zahtevi-prilozi` 7,6 MB… Seoba fajlova je odvojen posao od tabela; 3.0 već ima svoj put
  do storage-a preko javnog gateway-a.

Za poređenje: 3.0 baza danas ima **225 tabela / 2,7 GB** — prostor nije ograničenje.

---

## 5. Predloženi redosled (revizija posle punog merenja)

### Korak 0 — mapa identiteta (preduslov SVAKOG koraka)
Jednokratna tabela uparivanja sy15 `auth.users.id` ↔ 3.0 `users.id` (po mejlu; SSO već ima
taj upar u hodu). 60 naloga — sat posla, ali bez nje nijedna od 67 FK kolona ne može da se
prevede. Pravi se i verifikuje jednom, koristi u svim koracima.

### Korak 1 — SAMO SASTANCI (74 fn / 27 tabela / 1.120 redova) — PRVI PRAVI REZ

> **REVIZIJA 2 — 05.08 uveče (nalaz pripreme sastanci+PB, grana `feat/sy15-seoba-sastanci-pb`):**
> 1. **PB je IZBAČEN iz koraka 1** — `pb_current_employee_id()` traži tabelu `employees`
>    (ne mapu identiteta) i ulaz je u SVA prava modula; funkcije opterećenja džoinuju i
>    `departments`/`sub_departments`/`job_positions`. PB pod prekidačem `3.0` vraća 503 u
>    celini → **PB ide IZA kadrovske (novi korak 4b)**. Podaci PB su preneti i čekaju.
> 2. **Domen sastanaka je 27 tabela, ne 24**: `LIKE 'sastan%'` promašuje
>    `akcioni_plan_istorija` (**689 redova — veća od same tabele akcija!**),
>    `sast_weekly_movers`, `sast_weekly_skip`. Funkcija je 74 (65 DEFINER), ne 46.
> 3. **`projects` mapa RADI**: sy15 `projects` je IZVEDEN pokazivač
>    (`uuid5(md5('servoteh_pb_predmet:v1:' || bigtehn_item_id))`, a `bigtehn_item_id` = 3.0
>    `projects.id`). Provereno 22/22 po id-u I 22/22 po šifri; prenosna skripta odbija rad
>    ako se ta dva broja raziđu.
> 4. **Identitet: domen čuva MEJL, ne nalog** — 23/23 pravih ljudi ima 3.0 nalog; 4 sintetičke
>    vrednosti (seed/auto/tipfeler `.ocm`/test) ostaju doslovno kao podatak.
> 5. **Prekidač NE pokriva 7 scheduler poslova** koji gađaju sy15 direktno (`$queryRaw` mimo
>    branjenih getera) — enqueue logika (`sastanci_enqueue_*`, `pb_enqueue_notifications`)
>    se prepisuje PRE punog preklopa. Mejl dispatch je već u 3.0 (Resend); RSVP magic-link
>    još gađa sy15 `functions/v1/sastanci-rsvp` (tokeni preneti doslovno — stari linkovi rade).
>
> Pripremljeno (dokazano na probnoj bazi): **1.120/1.120 redova, 27/27 tabela, idempotentno**;
> prekidač `SASTANCI_PB_IZVOR`; 4 samouslužne DEFINER fn prepisane u `SastanciSamouslugaService`
> (+26 testova). Runbook: `docs/SEOBA_SASTANCI_PB_2026-08-05.md` (na toj grani).
> **Ostaje:** ~61 DEFINER fn za sastanke (4–6 dana) + enqueue (1–2 dana).

> **🔴 INCIDENT 06.08 — PRAVILO ZA SVE PREOSTALE KORAKE: JEDAN PREKIDAČ = JEDAN DOMEN.**
> Zajednički prekidač `SASTANCI_PB_IZVOR` je na produkciji prebačen na `3.0` zbog SASTANAKA
> (koji su bili spremni) i tim potezom oborio **ceo Projektni biro u 503** + posao
> `pb-notify-dispatch` koji je počeo da pada na svaka 2 min. Vraćen za ~2 min, bez upisa u
> međuvremenu, pa nema podataka za usklađivanje. Prekidač je razdvojen na
> **`SASTANCI_IZVOR`** i **`PB_IZVOR`** (oba podrazumevano `sy15`).
> **Pre uvođenja prekidača u koracima 2–5 (održavanje, reversi, kadrovska) izmeriti koje sve
> module dodiruje** — `grep` za pozivaoce branjenog getera (`assertPorted` / `isThreeZero`), ne
> po imenu promenljive. Ako dodiruje domen koji se u tom koraku ne seli, razdvojiti ga ODMAH.
> Detalji i pouke: `docs/SEOBA_SASTANCI_PB_2026-08-05.md` **§7h**.

> **REVIZIJA 05.08 (nalaz pripreme reversa):** reversi su izbačeni sa prvog mesta.
> Priprema (grana `feat/sy15-seoba-reversi`) je dokazala tri stvari:
> 1. **Reversi i Lokacije su transakciono JEDNO** — izdavanje alata u istom `COMMIT`-u piše
>    i `rev_document_lines` i `loc_location_movements`; `rev_tools.loc_item_ref_id` ↔
>    `loc_item_placements` popunjen 47/47. Podela baza ne kida džoin nego **atomarnost**.
> 2. `rev_issue_reversal`/`rev_confirm_return` nose CELU logiku izdavanja/povraćaja u
>    PL/pgSQL-u — nema šta da se „prevede", piše se iznova (~5–8 dana), PRE prenosa podataka.
> 3. `rev_api_idempotency` je registar **cele aplikacije** (643 reda: kadrovska 476,
>    moj-profil 60, sastanci 56…, reversi samo 2) — ne seli se sa domenom.
>
> Pripremljeno i važi za korak 3: 14 Prisma modela, offline migracija, prenosna skripta
> (dokazana: 195/195 redova, idempotentna), prekidač `REVERSI_IZVOR` (pod `3.0` sve što bi
> pisalo u sy15 vraća 503 — nema tihog razilaženja). Runbook: `docs/SEOBA_REVERSA_2026-08-05.md`.

Sastanci su listni domen bez transakcionih šavova ka drugima (2 inbound FK: istorija ide
zajedno; `production.operativna_aktivnost.izvor_akcioni_plan_id` je mrtav šav — 0 popunjenih).

### Korak 2 — održavanje (41 fn, 34 tabele + 34 trigera, 2,4 MB + 469 MB fajlova)
Najviše mehaničkog posla. Ovde prvi put ozbiljno ulazi storage seoba
(`maint-machine-files`, 469 MB).

### Korak 3 — reversi + lokacije ZAJEDNO (jedan potez, ~49 fn)
Zbog transakcione celine (v. reviziju u koraku 1). Uključuje i preuzimanje
`loc_bigtehn_ingest` cron logike u 3.0 scheduler — čime se delimično načinje i bridge
(korak 5). Priprema reversa je već urađena; dopisuje se loc deo + prepisivanje
izdavanja/povraćaja u NestJS.

### Korak 4 — kadrovska (58 fn, najosetljivije)
Plate pod allowlist bravom, audit trag, `hr_*` brane (npr. zabrana direktnih izmena odobrenog
odmora — bila je predmet oborene revizije 026!). **Tek posle tri uvežbana kruga.**
Uz nju idu `employee-docs` (24 MB, poverljivo) i `attendance_events` (140 MB stvarnog
sadržaja — pre seobe utvrditi šta te kolone nose).

### Korak 4b — projektni biro (32 fn, podaci već preneti u koraku 1)
Uključuje se tek kad `employees`/`departments`/`job_positions` budu u 3.0 bazi (korak 4) —
`pb_current_employee_id()` je ulaz u sva PB prava i traži te tabele (revizija 2, tačka 1).

### Korak 5 — SCADA + bridge preusmeravanje (uslov za gašenje)
- **SCADA:** preusmeriti `bridge-scada` relej na 3.0 bazu + preseliti 5 tabela + prevesti
  `energetika.service`. Odluka usput: koliko istorije seliti (retencija već postoji).
- **Bridge (.mdb masteri):** preusmeriti upis keševa na 3.0 (BigBit živi do ~01.02.2027,
  kanal mora nastaviti da radi!) i preneti `loc_bigtehn_ingest` logiku (cron u bazi!) u
  3.0 scheduler. **Ovo je poslednji pisac — kad on pređe, sy15 se gasi.**

### Korak 6 — „ostalo" koje nijedan domen ne pokriva
`ai_chat_*` (~20 fn — AI asistent), `assessment_*` (~15 fn — ocenjivanje), `absences`/
`contracts` (arhive), `dictation_inbox` (diktafon!), kiosk pomoćne, GoTrue gašenje (poslednje —
9 prijava u 7 dana još ide kroz njega), storage preostali bucketi (`bigtehn-drawings` 995 MB —
odluka: seliti ili arhivirati).

## 6. Šta traži Nenadovu odluku (po koraku u kom postaje bitno)

1. **(korak 1)** Reversi FK ka lokacijama dok lokacije još ne pređu: pointer u sy15 (slabija
   konzistencija) ili kopija šifarnika lokacija kao read-only u 3.0 (preporuka)?
2. **(korak 5)** Koliko SCADA istorije seliti — sve (558 MB) ili poslednjih N meseci
   (retencija ionako postoji)?
3. **(korak 5)** Bridge preusmeravanje: piše li od tada u 3.0 bazu direktno, ili kroz
   backend API (jedan pisac, jedna validacija — preporuka, ali više posla)?
4. **(korak 6)** `bigtehn-drawings` 995 MB: seliti u 3.0 storage ili arhivirati na disk
   (crteži mrtvog QBigTehn-a — ali kod ih još ume da prikaže)?

## 7. Zaključak

**Podaci su sitni (~17 MB živih domena) — posao je u logici i piscima:**
1. ~**200 DEFINER funkcija** živih domena prepisati u NestJS (+ ~35 „ostalo" koje niko ne
   pokriva: AI asistent, ocenjivanje, diktafon),
2. **dva bridge servisa preusmeriti** na 3.0 (SCADA relej + .mdb masteri — bez toga sy15
   živi do gašenja BigBita 2027),
3. **kadrovska poslednja** (plate, audit, poverljivost),
4. mapa identiteta (67 FK ka `auth.users`) je preduslov svega — korak 0.

Redosled (revizija 2, 05.08 uveče): **identitet → SAMO sastanci → održavanje →
reversi+lokacije (jedan potez) → kadrovska → PB (blokiran kadrovskom) → SCADA/bridge →
ostalo → gašenje.** Svaki korak iza prekidača, sa povratkom bez novog deploy-a.

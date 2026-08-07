# Seoba SCADA / energetike na 3.0 bazu — merenje i runbook (07.08.2026)

Korak 5 iz [PLAN_GASENJA_SY15_2026-08-03.md](PLAN_GASENJA_SY15_2026-08-03.md).
Grana: `feat/scada-na-3-0-bazu`.

---

## 0. 🔴 ODLUKA KOJA ODREĐUJE CEO OBLIK POSLA: ISTORIJA SE NE PRENOSI

Vlasnik, 07.08.2026, doslovno:

> „ne hajemo za stare podatke", „ostati bez te istorije čak i od dva meseca, ne treba nam".

Zato **ne postoji skripta za prenos podataka i neće je ni biti.** Tabele u 3.0 se prave
prazne i puni ih relej od trenutka preklopa. Ovo je izmereno u sy15 07.08.2026 i namerno
ostavljeno da umre zajedno sa tom bazom:

| tabela | redova u sy15 | šta se dešava |
|---|---:|---|
| `scada_history` | 2.549.847 | **ne prenosi se** (02.07.–07.08., ~3.540/h) |
| `scada_alarms` | 13.204 | **ne prenosi se** |
| `scada_commands` | 29 | **ne prenosi se** |
| `scada_snapshots` | 5 | ne prenosi se — relej ih prepiše za ~5 s |
| `scada_notify_prefs` | 0 | nema šta |
| `scada_sites` | 5 | ⚠️ **JEDINO ovo se seeduje** — v. §2 |

**Posledica koju treba reći korisniku unapred:** posle preklopa su trend-ekrani prazni i
pune se od nule. Pun dnevni grafik postoji tek posle ~24 h, nedeljni posle 7 dana. Alarmi
takođe kreću od nule (aktivni alarmi se vrate sami u prvom prolazu releja, u roku od 5 s).
**To je očekivano i ispravno stanje, ne kvar.**

---

## 1. Merenje — 6 tabela, a ne 5

Spisak po `prisma/sy15.prisma` daje **pet** modela. Živa baza ima **šest**:

```
scada_sites · scada_snapshots · scada_history · scada_alarms · scada_commands · scada_notify_prefs
```

`scada_notify_prefs` **nema Prisma model** u `sy15.prisma`, pa ga „spisak po modelima"
promaši — ista zamka kao `maint_wo_number_counter` kod održavanja. Prazna je (0 redova) i
jedini potrošač joj je bio triger `scada_alarm_push_trg`, ali bez nje sy15 ne može da se
ugasi do kraja, pa je prenesena.

3.0 baza pre ove grane: **0 `scada_*` tabela** (`information_schema.tables`).

### Šta još živi u sy15 uz tabele

| objekat | šta radi | sudbina |
|---|---|---|
| `scada_watchdog()` + pg_cron jobid 21 (5 min) | diže `BRIDGE_STALE` kad relej ćuti | **prepisan** u posao `scada-watchdog` |
| `scada_claim_commands(p_limit)` | `FOR UPDATE SKIP LOCKED` preuzimanje komandi | **prepisan** u `scadaStore.js` (3.0 grana) |
| `scada_cancel_command(uuid)` | otkazivanje SVOJE pending komande | **prepisan** u `energetika.service.ts` |
| `scada_is_admin_or_management()` | RLS predikat | **ne prenosi se** — 3.0 nema RLS, pravo je na HTTP sloju |
| `scada_alarm_push_trg` (triger) | web-push na nov alarm | **ne prenosi se** — push u 3.0 ne radi (tri mrtve pretplate) |
| retencija u releju (90 dana) | briše stare uzorke | **prepisana** u posao `scada-retention` |

---

## 2. `scada_sites` je jedini seed — i bez njega ništa ne radi

`scada_sites.key` je **FK roditelj svim ostalim tabelama**, a relej sistem samo
`UPDATE`-uje (`online`, `last_seen`) — **nikad ga ne insertuje**. Da nije seedovan, prvi
upis snapshota bi pao na FK grešci i relej bi stao na prvom prolazu.

To nije istorija nego konfiguracija, pa seed stoji u samoj migraciji
(`ON CONFLICT DO NOTHING`, pa je ponovljena primena bezbedna):

```
kot1 · kot2 · kot3 · solar-kaco · solar-sigen
```

`online`/`last_seen` se **namerno ne seeduju**: lažan `online=true` pre prvog prolaza
prikazao bi sistem kao ispravan iako se još niko nije javio.

---

## 3. Prekidač `SCADA_IZVOR` — obim je IZMEREN, ne pretpostavljen

Pouka incidenta 06.08.2026 (`SASTANCI_PB_IZVOR` je oborio Projektni biro): prekidač
prati **stvarne pozivaoce podataka**, ne naziv domena. Tri nezavisna preseka:

1. **`grep` nad `backend/src`** — 11 fajlova pominje „scada", ali samo
   `modules/energetika/*` dodiruje podatke. Ostalo je tekst (`ai-tools.ts` opis za model,
   `permissions.ts` dodela prava) i ožičenje (`app.module.ts`).
   AI-asistent **nema nijedan `scada_*` alat** — za razliku od održavanja, gde
   `ai_chat_prijavi_kvar` PIŠE u domen i zato je moralo pod prekidač.
2. **`pg_depend` nad view-ovima sy15** — **0 view-ova** čita `scada_*`.
   (Baš ovaj presek je kod održavanja otkrio `v_rev_machines`, šav koji FK graf ne vidi.)
3. **`pg_proc.prosrc`** — 4 funkcije pominju `scada_*`, i **sve četiri su SCADA sopstvene**.

**Zaključak: zatvoren domen.** Jedini potrošač u aplikaciji je `modules/energetika/*`,
jedini pisac je relej. Nijedan tuđi domen ne ulazi u ove tabele.

### Prekidač postoji na DVA mesta i oba se preklapaju

| gde | env | šta presuđuje |
|---|---|---|
| backend (`ScadaSourceService`) | `SCADA_IZVOR` | odakle se **čita** |
| relej (`bridge/src/config.js`) | `SCADA_IZVOR` + `SCADA_PG_URL` | gde se **piše** |

Podrazumevano je `sy15` na oba, i **svaka neprepoznata vrednost pada na `sy15`** — preklop
u pogrešnom smeru razilazi dve baze, a to se ne vidi dok se brojevi ne raziđu.

Relej **pada na startu** ako je `SCADA_IZVOR=3.0` bez `SCADA_PG_URL`. Namerno: inače bi
proces startovao „uspešno" pa tek na prvom upisu počeo da baca greške, a snapshotovi bi
tiho stajali — tačno stanje koje watchdog prijavljuje kao `BRIDGE_STALE`.

---

## 4. Kako relej piše u 3.0 — direktan Postgres

3.0 baza **nema PostgREST**, pa se kanal mora promeniti; nema varijante „ostavi kako jeste".
Uveden je `bridge/src/db/scadaStore.js`: jedan ugovor, dve implementacije.

**Izabrano: direktan Postgres (`pg`).**

- Trust se **ne menja** — relej već nosi `service_role` ključ koji zaobilazi RLS nad celom
  sy15 bazom, dakle već je potpuno poverljiv pisac. Konekcioni string je isti nivo poverenja.
- Svaki upis je upsert sa izričitim conflict targetom — tačno ono što je PostgREST i
  emulirao, samo bez HTTP/JSON sloja i bez deljenja na 500-redne komade.
- `claim` komandi traži `FOR UPDATE SKIP LOCKED`; preko PostgREST-a je to **moralo** da bude
  `SECURITY DEFINER` RPC, a 3.0 nema RPC sloj da ga ugosti.

**Odbijeno:**

- *HTTP ingest endpoint na 3.0 backendu* — nadzor kotlarnica bi zavisio od toga da backend
  radi, a backend se redeployuje na svaki push na `main`. SCADA ne sme da stane zbog deploy-a.
- *Preseliti relej u 3.0 scheduler* — ERP backend bi počeo da polje uređaje, isti deploy
  problem, a `CLAUDE.md` relej namerno drži kao zaseban stabilan proces (SCADA gateway drži
  jednu jedinu konekciju ka Unitronics PLC-u i ume da se blokira).

### Šta prekidač NE pokriva

`bridge_sync_log` (dnevnik prolaza releja) **ostaje u sy15** i pod `3.0`. To je operativni
dnevnik samog releja, koji deli i druga instanca (`servoteh-bridge` za BigTehn) — da je i on
prešao, dnevnik bi se raspolovio na dve baze bez ikakve koristi. Isto važi za Telegram alerte.

---

## 5. Watchdog i retencija — prešli na 3.0 scheduler

Oba posla se registruju **samo pod `SCADA_IZVOR=3.0`** (`ScadaJobsService.buildJobs()` vraća
prazno pod `sy15`). Razlog nije kozmetika: bezuslovna registracija bi pod `sy15` digla
`BRIDGE_STALE` za svih 5 sistema odmah po deploy-u (3.0 snapshotovi su prazni i `updated_at`
nikad ne stiže), na ekranu koji još gleda u sy15.

| posao | raspored | šta radi |
|---|---|---|
| `scada-watchdog` | na 5 min | prepis `scada_watchdog()`; sistem bez snapshota > 5 min → `BRIDGE_STALE` (severity 2) |
| `scada-retention` | dnevno 03:40 | `scada_history` stariji od **90 dana** (isti rok kao relej danas) |

**🔴 Watchdog samo UBACUJE alarm — ne gasi ga.** Kad se relej vrati, `BRIDGE_STALE` nije u
skupu aktivnih alarma uređaja, pa upada u `toClear` njegovog diff-synca i tamo se zatvori.
Zato watchdog i relej **nisu dva pisca nad istim redom**: jedan otvara, drugi zatvara. Ovo je
provereno uživo (§7).

Retencija prelazi sa releja na scheduler jer 3.0 nema PostgREST kanal za masovni `DELETE`, a
usput dobija dnevnik u `scheduled_job_runs` (relej je brisao bez ikakvog traga). Pod `3.0` je
`scadaHistoryCleanup()` u releju **no-op**, da dva mehanizma ne brišu istu tabelu.

Rok od 90 dana se **ne menja** pri seobi — seoba i promena roka su dve odluke.
(Izmereno: u sy15 ta retencija **još nikad ništa nije obrisala** — najstariji uzorak je od
02.07.2026, ~36 dana, a rok je 90. Prvi stvarni rez tek predstoji, i to je onaj koji briše
~3,2 mil. redova odjednom — otud `staleAfterMinutes: 60` na poslu.)

---

## 6. Razlike koje ostaju posle preklopa

| | sy15 | 3.0 |
|---|---|---|
| istorija | 2,55 mil. uzoraka | **prazno na startu**, puni se od preklopa |
| RLS | 6 tabela, `scada_is_admin_or_management()` | **nema** — pravo je `energetika.read`/`energetika.control` na HTTP sloju |
| web-push na alarm | triger → `push-dispatch` | **nema** (push u 3.0 ionako ne radi) |
| `scada_notify_prefs` | 0 redova | 0 redova (čeka oživljavanje push-a) |

Dodela prava se **ne menja**: ista dva ključa, iste role (admin + menadžment).
Gubi se samo DB-nivo sloj koji u 3.0 bazi ne postoji ni za jedan modul — otud pravilo da se
`DATABASE_URL` 3.0 baze nikad ne daje klijentu (sy15 je to trpeo preko `anon`).

---

## 7. Šta je provereno (izvršeno, ne pretpostavljeno)

Sve protiv **sveže migrirane probne baze** na dev klusteru (napravljena, izmerena, obrisana).

- `migrate deploy` — ceo lanac migracija prolazi na praznoj bazi; rezultujuće strukture
  (indeksi, FK, parcijalni UNIQUE, CHECK) poklapaju se sa `\d` sa žive sy15.
- `tsc --noEmit` — bez novih grešaka (4 zatečene ostaju: handovers, kadrovska.zahtev-026,
  kamata, moj-profil.zahtev-026).
- `npm run build` — prolazi.
- `npx jest` — **5.795 testova, 266 suita, sve prolazi.**
- 🔴 `npx jest --config ./test/jest-e2e.json --ci --runInBand "permissions|coverage|command-safety"`
  — **25 suita, 4.590 testova, prolazi.** Ovo je ZASEBAN korak CI-ja i `npx jest` ga
  **ne pokriva**: `test/*.e2e-spec.ts` ide drugim configom, pa promena konstruktora nekog
  servisa ovde pukne a lokalni `jest` (samo `src`) to ne vidi. Tako je 07.08.2026 propuštena
  regresija — `EnergetikaService` je dobio treću zavisnost (`ScadaSourceService`), a
  `energetika-command-safety.e2e-spec.ts` gradi testni modul ručno i nije je pružao.
  **Svaka izmena konstruktora servisa traži i ovu komandu, ne samo `npx jest`.**
- **boot `node dist/main` u OBA položaja prekidača**, protiv sveže migrirane baze:
  - `SCADA_IZVOR` nepostavljen → diže se, tiho (sy15 je podrazumevano)
  - `SCADA_IZVOR=3.0` → diže se + upozorenje sa načinom povratka
  - broj registrovanih poslova **22 → 24**: tačno dva nova, i to samo pod `3.0`
- **watchdog stvarno okinut** (`SCHEDULER_ENABLED=true`): upisao `BRIDGE_STALE` severity 2 sa
  vremenom u Europe/Belgrade (09:31 UTC → „07.08. 11:31"), dnevnik u `scheduled_job_runs`.
  Ponovljen prolaz: `INSERT 0 0` (NOT EXISTS + parcijalni UNIQUE).
- **relej gasi `BRIDGE_STALE`** svojim diff-syncom kad se vrati — potvrđeno uživo.
- **3.0 write putanja releja, 13/13 provera**: snapshot upsert ne udvaja red; history dedup
  po PK + `DO UPDATE` prepiše minutni bucket; alarm insert poštuje parcijalni UNIQUE (dupli
  aktivan nemoguć), update i clear rade; `claim` preuzima jednom pa više ne; ishod `applied`
  postavlja `applied_at`, `rejected` ga **ne** postavlja (paritet sy15); retencija briše po
  cutoff-u; heartbeat sistema upisan.
  - *Ova proba je usput uhvatila grešku:* `RETURNING` bez `c.` prefiksa bio je dvosmislen
    zbog `picked` join-a → vraćeno na `c.*` kao u sy15 RPC-u.
- **nezavisnost prekidača**: `SASTANCI_IZVOR=3.0` (živo na produkciji) ne pomera SCADA-u;
  `SCADA_IZVOR=3.0` ne pomera sastanke, PB ni održavanje. Pinovano testom.

---

## 8. 🔴 Runbook — preklop na produkciji

**Preduslovi**

1. `migrate deploy` je prošao (tabele postoje, `scada_sites` ima 5 redova).
2. Na ubuntusrv u `~/bridge-scada` je **`npm install`** izvršen — `pg` je nova zavisnost i
   **trenutno NE POSTOJI** na živom releju (provereno 07.08.2026).
3. Korisnik zna da istorija kreće od nule (§0).

**Redosled je bitan: PRVO RELEJ, PA BACKEND.**

Obrnut redosled znači prazan ekran (backend čita 3.0 koju još niko ne puni). Između dva
koraka je normalno da ekran kratko pokazuje stare sy15 podatke.

---

### 🔴 KOMANDE U LETU — prozor u kome se komanda MOŽE IZGUBITI

**Ovo nije samo prikaz podataka.** Aplikacija kroz `scada_commands` **stvarno upravlja opremom
u kotlarnicama** — potvrda vlasnika 07.08. i izmereno u istoriji komandi:

| site | target | op | value | ishod |
|---|---|---|---|---|
| `kot2` | `Web_P1`, `Web_P2` | set | `{"v": true}` | **pumpe UKLJUČENE**, `applied` |
| `kot2` | `Web_K7`, `Web_K8`, `Web_K10` | set | `{"v": true}` | **kaloriferi**, `applied` |
| `kot3` | `…:value` | set | `{"v": 0/1}` | **ventil/ventilator**, `applied` |

**Za solarne elektrane nema nijedne komande** — tamo se ništa ne pali (potvrda vlasnika).

Stanje na dan pisanja: **23 `applied`, 6 `rejected`, 0 `pending`**; poslednja komanda 03.08.

**Lanac:** aplikacija upiše red u `scada_commands` (`pending`) → relej ga `claim`-uje
(`FOR UPDATE SKIP LOCKED`) → izvrši na PLC-u → upiše `applied`.

**🔴 Problem:** između koraka 1 (relej na 3.0) i koraka 3 (backend na 3.0) backend i dalje
piše komande u **sy15**, a relej ih traži u **3.0**. Komanda poslata u tom prozoru:
- ostaje zauvek `pending` u sy15,
- **oprema se NE upali/ugasi**,
- korisnik **ne dobija grešku** — dugme izgleda kao da je odradilo posao.

**Isti rizik postoji i u obrnutom redosledu** — nijedan redosled ga sam po sebi ne uklanja.

**Obavezno pre preklopa:**

1. **Ne preklapati dok neko upravlja kotlarnicom.** Komande se šalju retko i ručno (poslednja
   4 dana pre preklopa), pa je prozor u praksi prazan — ali to se **proverava, ne pretpostavlja**.
2. **Skratiti prozor:** korake 1 i 3 izvršiti jedan za drugim, bez pauze. Provera iz koraka 2
   (da 3.0 prima snapshot-ove) može i **posle** prelaska backend-a — prikaz sme kratko da
   trepne, upravljanje ne sme.
3. **Proveriti `pending` pre i posle** (mora biti 0 na obe strane):
```bash
docker exec sy15-db psql -U supabase_admin -d postgres -tAc \
  "SELECT count(*) FROM scada_commands WHERE status='pending';"
docker exec servosync-pg psql -U servosync -d servosync -tAc \
  "SELECT count(*) FROM scada_commands WHERE status='pending';"
```
4. **Ako se posle preklopa nađe `pending` u sy15** — to je izgubljena komanda: oprema NIJE
   dobila nalog. Ponoviti je kroz ekran (ne prepisivati red u bazi).
5. **Prva stvar posle preklopa:** poslati jednu bezopasnu komandu kroz ekran i potvrditi da je
   stigla do PLC-a (`status='applied'` u **3.0**). Dok to ne prođe, **ne gasiti sy15 watchdog**.

```bash
# 1. RELEJ na 3.0
ssh ubuntusrv
cd ~/bridge-scada
npm install                       # pg — nova zavisnost
# u .env dodati:
#   SCADA_IZVOR=3.0
#   SCADA_PG_URL=postgresql://<user>:<pass>@<host>:5435/servosync
systemctl --user restart servoteh-bridge-scada
journalctl --user -u servoteh-bridge-scada -f     # traži 'snapshot pass done'

# 2. PROVERA da 3.0 prima podatke (sačekati ~1 minut zbog history bucket-a)
docker exec servosync-pg psql -U servosync -d servosync -c \
  "SELECT site_key, online, updated_at FROM scada_snapshots ORDER BY site_key;"
docker exec servosync-pg psql -U servosync -d servosync -c \
  "SELECT count(*) FROM scada_history;"          # mora rasti

# 3. BACKEND na 3.0 — SCADA_IZVOR=3.0 u backend.env
#    🔴 `docker restart` NE UČITAVA izmenjen env — mora `up -d` (v. zamku ispod)
cd /home/admluka/servosync && docker compose up -d backend    # mora ispisati "Recreated"
docker exec servosync-backend printenv | grep '^SCADA_IZVOR='  # OBAVEZNA potvrda
#    (u logu mora da se pojavi WARN [ScadaSourceService] SCADA_IZVOR=3.0 …)

# 4. Provera ekrana: /energetika — 5 sistema, snapshotovi sveži, trend PRAZAN (očekivano)

# 5. TEK KAD SVE RADI: ugasiti pg_cron watchdog u sy15 da ne diže alarme u mrtvoj bazi
docker exec sy15-db psql -U supabase_admin -d postgres -c \
  "SELECT cron.unschedule('scada_watchdog_every_5_min');"
```

Korak 5 je **namerno poslednji i odvojen**: dok se ne preklopi, sy15 watchdog je i dalje
korisna brana. Posle preklopa on samo alarmira nad bazom koju niko ne gleda.

### 🔴 ZAMKA KOJA JE ZAMALO NAPRAVILA TIHI ISPAD (uhvaćena pri izvođenju 07.08)

`docker restart servosync-backend` **ne učitava izmenjen `backend.env`** — Docker peče
`env_file` u trenutku *create*, a `restart` samo ponovo pokreće postojeći kontejner sa
zatečenim okruženjem. Kontejner se digne **zdrav, bez ijedne greške**, ali radi po **starom**
prekidaču.

Opasno je baš ovde jer se relej (systemd, `EnvironmentFile`) preklopi **ispravno** i odmah
prestane da piše u sy15 — pa ekran služi zamrznute podatke bez ikakve poruke o grešci.
Kod nas je prozor trajao ~15 min (10:59–11:14); izmereno `scada_commands` u sy15 = **0**,
dakle nijedna komanda nije izgubljena, ali da jeste — oprema se ne bi upalila.

**Lek:** `docker compose up -d backend` (izlaz mora sadržati `Recreated`) pa **obavezno**
`docker exec servosync-backend printenv | grep '^SCADA_IZVOR='`. Prazan izlaz = preklop nije
izvršen. Isto važi za svaki naredni prekidač (`ODRZAVANJE_IZVOR`, `PB_IZVOR`, …).

### Povratak (rollback) — ~2 min, bez deploy-a

```bash
# 1. backend:  SCADA_IZVOR=sy15  + restart
# 2. relej:    SCADA_IZVOR=sy15  (SCADA_PG_URL sme da ostane) + restart
systemctl --user restart servoteh-bridge-scada
```

sy15 nastavlja tačno gde je stala — njeni podaci nisu dirani ni u jednom koraku.

**Cena povratka:** u sy15 ostaje rupa za vreme provedeno na 3.0 (relej je za to vreme pisao
tamo), a u 3.0 rupa posle povratka. Po odluci iz §0 to je prihvatljivo — istorija nikome ne
treba. Ako se posle povratka ponovo pređe na 3.0, tabele **ne treba prazniti**: svi upisi su
upserti sa conflict targetom, pa je ponovni prelaz bezbedan.

---

## 9. ✅ IZVEDENO 07.08.2026 u 11:14 — i šta ostaje otvoreno

**Preklop je izvršen na produkciji.** Rešeno u toku izvođenja:

- **`npm install --omit=dev`** odrađen na živom releju — `pg` instaliran.
- **`SCADA_PG_URL`** = nalog **`servosync_app`** (već je imao INSERT/UPDATE nad svih šest
  `scada_*` tabela). Poseban uži nalog nije pravljen: relej ionako nosi `service_role` ključ
  za sy15, pa se nivo poverenja ne menja. Host je **`127.0.0.1:5435`**, ne `servosync-pg:5432`
  — relej radi na hostu, van docker mreže.

**Izmereno posle preklopa:** svih 5 sistema `online=t`, snimci stari 1 s; 8 aktivnih alarma
poklapa se red-po-red sa sy15 (verna slika, ne novi alarmi); komanda `Web_P1` prošla ceo lanac
za **3 s** (claimed 11:04:38 → applied 11:04:41, odgovor `{"ok":true,"tag":"Web_P1","value":1}`)
— proba je bila bezbedna jer je pumpa već bila upaljena. sy15 `pg_cron` jobid 21 ugašen;
zamenio ga backend posao `scada-watchdog`, prvi prolaz „svi sistemi svezi".
`post-deploy-verify` 🟢.

**🔴 FORMAT KOMANDE:** vrednost je **`{"v": 1}`**, ne golo `true` — allowlist releja čita
`value?.v` i golu vrednost odbija sa „vrednost mora 0/1".

**Ostaje otvoreno:**

- **🔴 VRATITI ALARME** — Telegram i mail su **namerno ispražnjeni** za vreme seobe (odluka
  vlasnika: „mail za scadu blokiraj dok radiš, posle puštamo kada sve preselimo"). Originali
  stoje u komentaru iznad svake linije u `/home/admnenad/scada-app/.env`
  (`ALERT_TELEGRAM_CHAT_ID=1183773172`, `ALERT_MAIL_TO=` tri adrese).
  Snimak: `.env.bak-20260807-125107-pre-seobe-alarmi`.
- **Web-push na alarme** ostaje mrtav dok se pretplate ne obnove (nije regresija — ne radi
  ni danas).
- **Gašenje sy15 `scada_*` tabela** — tek posle nekoliko dana stabilnog rada na 3.0;
  do tada su nedirnut rollback put.

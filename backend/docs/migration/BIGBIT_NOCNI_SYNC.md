# BigBit noćni uvoz (.mdb → 4.0)

**Zašto postoji:** završni račun za 2026. ostaje u BigBitu, a prelazak na 4.0 se dokazuje
**najmanje tri paralelna PDV obračuna** (isti period obračunat u oba sistema i upoređen) do
aprila 2027. Da bi to bilo moguće, 4.0 mora imati **sveže i prave** BigBit podatke.

Finansijsko jezgro BigBita (glavna knjiga, nalozi, kontni plan, PDV šeme) **ne postoji** u MSSQL
izvoru koji vozi postojeći sync (`sync-map.generated.ts` — samo šifarnici). Ono živi isključivo u
Access `.mdb` fajlu. Odatle ovaj kanal.

> **Ovo NE dira postojeći MSSQL sync.** `SyncService` / `SYNC_MAP` / `CustomerSyncer` rade
> nepromenjeno; `.mdb` kanal je zaseban put, sa svojim tabelama i svojim poslom.

---

## 1. Kako je sklopljeno (i zašto u dva koraka)

Backend radi u kontejneru `servosync-backend`. Provereno 26.07.2026 na `ubuntusrv`:

```
docker inspect servosync-backend --format '{{.HostConfig.Binds}}'   ->  []
docker exec servosync-backend ls /var/run/docker.sock               ->  nema
docker exec servosync-backend which docker                          ->  nema
```

Dakle Node proces **ne može ni da pročita** `/srv/bigbit-incoming/`, **ni da pokrene** `mdbtools`.
Zato je kanal dvostepen, a **jedini dodirni medijum je Postgres**:

| | Ko | Gde | Šta radi |
|---|---|---|---|
| **Korak 1** | `backend/scripts/bigbit-mdb-export.sh` | host `ubuntusrv` (systemd timer) | najnoviji `.mdb` → `mdbtools` → `\copy` u `bb_mdb_stage_*`, red u `bb_mdb_drops` |
| **Korak 2** | scheduler posao `bigbit-mdb-sync` | backend kontejner | `bb_mdb_stage_*` → `accounts`, `order_types`, `saldakonto_accounts`, `journal_entries`, `ledger_entries` |

Prednost: **nula izmena** imidža, `docker-compose.yml`-a, mrežnih prava i npm zavisnosti.

---

## 2. Ručno pokretanje

**Korak 1 (host):**

```bash
ssh ubuntusrv
BB_DATABASE_URL='postgresql://servosync_app:...@servosync-pg:5432/servosync' \
  bash /opt/servosync/bigbit-mdb-export.sh
# opcije:
#   --force              ponovi i za drop koji je već LOADED (+ preskoči proveru istog sha256)
#   --dir /put           drugi drop folder (default /srv/bigbit-incoming)
#   BB_KEEP_WORK=1       ostavi radne CSV-ove u /tmp/bigbit-mdb-export/<dropId>/
#   BB_SETTLE_SECONDS=60 koliko čekati da se veličina fajla ustali (nema .ready markera)
#   BB_ALLOW_SHRINK=1    dozvoli pad broja redova >20% (legitimno samo za novu poslovnu godinu)
#   BB_KEEP_DAYS=7       koliko dana .mdb fajlova ostaje u drop folderu
```

Skripta izlazi != 0 na svaku branu (§5) i tada **ništa ne upisuje** — staro stanje staginga
ostaje netaknuto (`\copy` ide u jednoj transakciji po drop-u).

**Korak 2 (aplikacija):**

```
POST /api/v1/scheduler/jobs/bigbit-mdb-sync/run-now        (PERMISSIONS.SCHEDULER_RUN)
```

Radi i kad je `SCHEDULER_ENABLED` isključen. Rezultat (`summary`) se vidi u
`GET /api/v1/scheduler/jobs` i u tabeli `scheduled_job_runs`.

---

## 3. Kako se gasi (i pali)

Tri nezavisna prekidača, od najužeg ka najširem:

1. **Korisnički prekidač** — `app_switches` red `bigbit_mdb_sync`, ekran *Podešavanja →
   Integracije*, kvačica „Uvoz radi svake noći”. Menja ga administrator (`sync.run`), važi
   **od sledećeg pokretanja** i **bez restarta** backenda.

   Kapija je na **jednom mestu** — u `SchedulerService`, preko `ScheduledJob.switchKey`. Zato je
   poštuju **svi** ulazi (noćni tik, `run-now`, svaki budući) i nijedan ne može da je zaobiđe
   zaboravivši poziv. Ponašanje se razlikuje po ulazu, namerno:
   * **zakazani posao** → `job.run()` se **ne poziva**, run je **DONE** sa razlogom u `summary`
     (namerno gašenje nije kvar i ne sme da pravi lažnu uzbunu ni da troši `MAX_ATTEMPTS`);
   * **ručni `run-now`** → **greška** sa istim tekstom (čovek koji je pritisnuo dugme mora da
     vidi zašto se ništa nije desilo, ne tihu 200).

   Ista provera stoji **i u samom servisu uvoza** (`runImport` vraća `DISABLED`) — kao odbrana u
   dubinu, jer je to metoda koja stvarno piše u glavnu knjigu.

   **Nema reda = uključeno.** Prekidač je *OFF*-prekidač: odsustvo reda (nova baza, neprimenjen
   seed) ne sme tiho da ugasi noćni uvoz. Isto važi i za **grešku pri čitanju** prekidača —
   posao se pušta dalje, ali se greška **loguje** (nedostupan prekidač ne sme da bude razlog
   izostanka uvoza).

   > **Šta prekidač NE gasi:** šifarnički MSSQL sync (komitenti, predmeti, artikli — ekran
   > `/syncs`). To je zaseban kanal sa svojim pokretanjem.

   > **Uvoz koji je već u toku se NE prekida.** Provera je jednokratna, na startu. Ako se
   > prekidač skine u 03:50, posao pokrenut u 03:45 završava do kraja.

2. **Korak 1** — `systemctl disable --now bigbit-mdb-export.timer` na hostu. Staging prestaje da
   se osvežava; korak 2 tada padne na brani svežine (§5) — što je i poenta.

3. **Ceo scheduler** — `SCHEDULER_ENABLED=false` u `backend.env` (gasi i sve druge poslove).

**Nadzornik se NE gasi prekidačem.** Posao `bigbit-sync-watchdog` (07:15) namerno nema
`switchKey`: on mora da radi i kad je uvoz ugašen, jer je „ugašen mesec dana, a niko ne zna”
upravo kvar zbog kog postoji.

---

## 4. Šta se uvozi, a šta namerno NE

**Uvozi se u 4.0 modele** (redosled je obavezan zbog FK lanca):

| Izvor (.mdb) | Cilj | Redova (snimak 11.07.2026) |
|---|---|---|
| `Kontni plan` | `accounts` | 1.389 |
| `Vrsta naloga` | `order_types` | 117 |
| `PSF_AnalitickaKonta_T` | `saldakonto_accounts` | 9 |
| `T_Nalozi` | `journal_entries` | 1.126 |
| `T_Glavna knjiga` | `ledger_entries` | **20.366** |

**Staguje se, ali se NE uvozi** (kontrolni „zlatni uzorak” za poređenje PDV obračuna):
`T_PDV_GK` (1.965), `T_POPDV_GK` (4.486), `Sema za kontiranje` (30),
`Stavke seme za kontiranje` (105).

**Ne dira se uopšte:**

* **`Komitenti` i `Predmeti`** — njih već vozi **živi MSSQL sync**, koji čita bazu *uživo* i time
  je **svežiji od noćnog fajla**. Uz to su `Predmeti` u dual-unos režimu (3.0 dodeljuje broj →
  isti broj se prekuca u BigBit), pa bi `.mdb` kanal bio drugi pisac po istim redovima.
  `.mdb` kopija se koristi samo za kontrolu integriteta.
* **`Sema za kontiranje` / `Stavke seme`** — 4.0 seed je **ručno ispravljen** (šema 31 gađa
  nepostojeća konta 470/471; 37/38 su jednostrane pa ne balansiraju), a slepi uvoz bi te
  ispravke pregazio. Šeme voze *buduće* automatsko knjiženje, ne paralelni PDV obračun
  (PDV se izvodi iz glavne knjige po kontu), pa nisu na kritičnom putu.
* **`saldakonto_accounts.side` / `partner_scope` / `control_account`** — to su **4.0 odluke**
  koje BigBit ne zna (primljeni avansi 4300/4302 su `payable` ali *kupčevi*). Uvoz na
  postojećem redu menja samo `DinSaldo`/`DevSaldo`/`OTST`.

---

## 5. Brane — zašto posao pada glasno

Motiv je konkretan: 26.07.2026. je u `/srv/bigbit-incoming/` stajao fajl **star 15 dana** i
nijedan posao ga nije dirao — niko to ne bi primetio. **Tišina je najgori ishod.**

### 5.1 Starost fajla (prag: 24 h)

Dostava spusti `.mdb` oko 02:00, korak 1 radi u 02:50, korak 2 u 03:45 — zdrav drop je tada star
1–2 h. Sa pragom od 24 h **jedna propuštena noć već diže uzbunu** (sutrašnji posao vidi fajl star
~25,5 h), umesto da se to primeti tek za nekoliko dana.

Prag je **jedna konstanta** (`MAX_DROP_AGE_HOURS` u `src/common/switches/bigbit-sync.ts`) koju
koriste i posao i ekran. Ekran ima i **meke** pragove (36 h / 72 h) za „kasni, ali još radi”, ali
**prvo** poredi sa tvrdim — pa ne postoji prozor u kome posao svake noći puca a kartica je žuta.

### 5.2 Isti sadržaj, nov datum (lažna svežina)

`mtime` pomera i običan `cp`, `rsync` bez `--times` ili ponovna isporuka istog fajla — pa
dvonedeljni sadržaj izgleda „star 0,2 h”. To je **opasnije** od bajatog fajla jer datum izgleda
ispravno. Zato se `file_sha256` sada **poredi** (ranije se samo računao i upisivao): isti heš kao
neki već obrađen drop → **stani**, bez obzira na datum. Provera je na oba mesta — u skripti
(pre 18 s izvoza) i u servisu (nad već uvezenim drop-ovima).

### 5.3 Nepotpun fajl

Polovično prekopiran 375 MB Access fajl daje **ispravno zaglavlje** i manje redova — brana
zaglavlja to ne hvata. Dve nezavisne provere:

* **sentinel** `<ime>.mdb.ready` (ako ga dostava pravi posle zatvaranja fajla) — najjači dokaz;
* inače: veličina + `mtime` moraju biti **nepromenjeni** kroz `BB_SETTLE_SECONDS` (default 60 s).

Uz to: **pad broja redova preko 20 %** u odnosu na prethodni uspešan drop obara korak 1
(glavna knjiga tokom godine samo raste). Legitiman pad → `BB_ALLOW_SHRINK=1`.

### 5.4 Prazan izvoz nije uspeh

Ako je staging glavne knjige, naloga ili kontnog plana prazan, korak 2 **baca** umesto da upiše
`DONE` sa „+0/~0/=0”. Uspeh sa nula redova nije uspeh, a `DONE` bi značio da se drop **nikad**
ne pokušava ponovo.

### 5.5 Jedan uvoz u jednom trenutku

Scheduler blokira paralelno pokretanje samo ako postoji `RUNNING` red **mlađi od 10 minuta**, a
uvoz pune glavne knjige to lako pređe. Zato je claim atomski **CAS nad
`bb_mdb_drops.import_started_at`**: drugi uvoz istog drop-a vraća `BUSY` i **ne piše ništa**.
Zaostali claim (proces ubijen) se sam oslobađa posle 2 h.

Kad bilo koja brana pukne, posao baca → run je **FAILED** u `scheduled_job_runs`, greška ide u
`bb_mdb_drops.import_error` i u `bb_sync_state.last_error_message` (odatle je vidi ekran), a
ujutru je nadzornik gura na zvonce. Poruke su dvoslojne: **prvo rečenica za čoveka** („Podaci iz
BigBita nisu stigli… javite osobi zaduženoj za BigBit; kvar NIJE u 4.0”), pa tehnički detalj u
uglastim zagradama.

---

## 6. Idempotencija — dokaz, ne obećanje

Svaki korak je `INSERT … ON CONFLICT DO UPDATE … **WHERE red je STVARNO različit**`. Postgres
vrati red iz `RETURNING` samo ako je stvarno pisao, pa se „nepromenjeno” **meri**, ne procenjuje.

Ključevi idempotencije: `journal_entries.bb_nalog_id` (UNIQUE) i `ledger_entries.bb_stavka_id`
(UNIQUE) — direktno `IDNaloga` i `StavkaID` iz BigBita. Ti ključevi su ujedno i jedini način da se
**stavka po stavku** uporedi naš PDV obračun sa BigBitovim (`bb_mdb_stage_pdv_gk.stavka_id`).

Izmereno na dev bazi (192.168.64.28:5437) nad stvarnim `BB_T_26_11-07-26.mdb`, **posle
remedijacije 26.07.2026**:

| Prolaz | accounts | order_types | saldakonto | journal_entries | ledger_entries | trajanje |
|---|---|---|---|---|---|---|
| **1. (prazna GK)** | 0/0, 1389 nepr. | 0/0, 117 nepr. | 0/0, 9 nepr. | **1126 novih** | **20366 novih** | **6,1 s** |
| **2. (isti drop, `--force`)** | 0/0, 1389 nepr. | 0/0, 117 nepr. | 0/0, 9 nepr. | 0/0, 1126 nepr. | **0/0, 20366 nepr.** | 4,2 s |
| **3. (NOV drop, isti sadržaj)** | 0/0, 1389 nepr. | 0/0, 117 nepr. | 0/0, 9 nepr. | 0/0, 1126 nepr. | **0/0, 20366 nepr.** | 5,0 s |

**Prolaz 3 je onaj koji se stvarno dešava svake noći** (nov fajl → nov `drop_id`, isti
računovodstveni sadržaj) i on je bio **pokvaren u prvoj verziji**: `imported_drop_id` je bio deo
poređenja `IS DISTINCT FROM`, a menja se sa svakim drop-om — pa je svaka noć prepisivala **svih
1389 konta i svih 20.366 GK stavki** (sa 6 indeksa), `updated_at` se pomerao na svemu, a brojači
su svake noći pisali „sve izmenjeno” i time činili *stvarnu* BigBitovu ispravku nevidljivom.
Sada `imported_drop_id` ostaje u `SET`, ali **nije u poređenju** — „ažurirano” znači isključivo da
se sadržaj promenio u BigBitu. (Prva verzija je idempotenciju merila samo prolazom 2, jedinim
koji se u produkciji ne dešava.)

Tvrdi dokaz da 2. i 3. prolaz **ne pišu nijedan bajt** — Postgresovi sopstveni brojači, identični
pre i posle oba prolaza (`diff` bez razlike):

```
accounts         n_tup_ins=5      n_tup_upd=5559
journal_entries  n_tup_ins=2408   n_tup_upd=2393
ledger_entries   n_tup_ins=41076  n_tup_upd=23582
order_types      n_tup_ins=117    n_tup_upd=234
```

**Brojači se moraju zbrajati.** Za svaki korak važi
`staged = inserted + updated + unchanged + skipped + filtered`. `filtered` je uveden zato što su
redovi koje filter izbaci (prazan `Datum knjizenja`, nenumerički `IDNaloga`, duplikat ključa,
predugačka identitetska kolona) ranije **nestajali iz svih brojača** — dokument koji izvor ima, a
4.0 nema, izgledao je kao „nepromenjen”. Sada se broje i imenuju po razlogu u `notes`.

Korak 1 je idempotentan po identitetu fajla **(ime + mtime + veličina)**: drugo pokretanje nad
istim fajlom izlazi sa 0 i porukom „već je stagovan”.

**Merenja koraka 1** (isti fajl, 375 MB, 200 tabela): ukupno **18,1 s** za svih 9 tabela —
`mdb-export` glavne knjige ~2,5 s, ostalo ispod sekunde po tabeli, `\copy` ~4 s.

---

## 7. Trag: šta je uvezeno, odakle i kada

**`bb_mdb_drops`** = jedan red po snimku BigBita:
`file_name`, `file_mtime`, `file_size`, `file_sha256`, pa `stage_status/staged_at/
stage_duration_ms/stage_row_counts` (korak 1) i `import_status/imported_at/import_duration_ms/
import_row_counts` (korak 2). `import_row_counts` je JSON sa `{inserted, updated, unchanged,
skipped, durationMs, notes}` po tabeli.

**Zašto novi model, a ne `BbSyncState`:** `bb_sync_state` je *kursor po entitetu* (jedan red po
tabeli, poslednja pozicija) i nema gde da smesti identitet i meru **fajla**. Ovde je jedinica
posla *drop*, ne entitet: jedan fajl daje 9 tabela odjednom i sve one dele istu proveru svežine i
isti trag. `BbSyncLog` je takođe nezgodan — vezan je za `SyncService.run()` petlju koju ovaj
kanal uopšte ne koristi. Uz to bi mešanje `.mdb` entiteta u `bb_sync_state` zamutilo ekran
`/syncs`, koji prikazuje stanje MSSQL sync-a.

**Oznaka porekla na redu (zahtev 7):** `accounts`, `order_types`, `saldakonto_accounts`,
`journal_entries` i `ledger_entries` imaju kolonu **`imported_drop_id`**.

* `imported_drop_id IS NULL` → red je **nastao u 4.0**.
* `imported_drop_id IS NOT NULL` → red je došao iz BigBita, i to **iz tačno tog fajla**
  (`JOIN bb_mdb_drops` daje ime, datum i veličinu izvora).

To je bolje od proste `source='BIGBIT'` zastavice jer uz „odakle” daje i „iz kog snimka” —
neophodno kad se posle tri paralelna PDV obračuna traži zašto se dva sistema razlikuju.
`imported_drop_id` beleži **prvi** drop koji je red doneo i posle se ne prepisuje (§6).

**Zapisnik se ne sme obrisati.** FK ka `bb_mdb_drops` je `ON DELETE RESTRICT`. Ranije je bio
`ON DELETE SET NULL`, što je značilo da rutinsko `DELETE FROM bb_mdb_drops WHERE id < N` radi
`UPDATE ... SET imported_drop_id = NULL` nad svim uvezenim redovima — dakle **čišćenje starih
drop-ova bi tiho uništilo upravo onu informaciju zbog koje kolona postoji**. Staging se umesto
toga čisti ciljano (§9).

**Heartbeat za ekran.** Posle svakog uspešnog uvoza upisuje se `bb_sync_state` red
`entity = 'bigbit-mdb'` sa `last_success_at` i `cursor = { sourceFile, sourceFileModifiedAt,
rowsImported, lastSummary }`; pri padu — `last_attempt_at` + `last_error_message`. Odatle kartica
u *Podešavanja → Integracije* čita **starost izvornog fajla** (uvoz može uredno da radi svake
noći nad bajatim fajlom — to stanje se mora videti). Upisuje se kroz Prisma (`new Date()`),
**nikad** kroz SQL `now()` iz host skripte: kolona je legacy `Timestamp(6)` bez zone, pa bi
`now()` u `Europe/Belgrade` upisao vrednost 2 h u budućnosti i pragovi bi kasnili.

**Ključ posla je jedan string na jednom mestu** — `BIGBIT_MDB_SYNC_JOB_KEY` u
`src/common/switches/bigbit-sync.ts` (`'bigbit-mdb-sync'`). Ranije su posao i ekran koristili
**različite** ključeve, pa ekran napravljen baš da prijavi pad nije mogao da prijavi ništa:
`scheduled_job_runs` upit je uvek vraćao prazno, kartica je doveka pisala „Još nije bilo uvoza”
— i kad uvoz radi i kad je mrtav. Test to sada pinuje.

---

## 8. Odluke o preslikavanju (i zašto)

* **Negativni iznosi.** 592 od 20.366 GK stavki ima negativno `Duguje`/`Potrazuje`. Živi
  `chk_ledger_entries_nonnegative` ih je odbijao. Guard **nije ukinut** — sužen je na
  4.0-native redove:
  `CHECK (bb_stavka_id IS NOT NULL OR (debit >= 0 AND credit >= 0))`.
  Vezan je za `bb_stavka_id`, a **ne** za `imported_drop_id`, jer je `bb_stavka_id` **stabilan**
  marker porekla — nikad ne postaje `NULL`, pa pravilo ostaje tačno bez obzira na vezu ka drop-u.
  Istorija ulazi 1:1 jer je cilj **verna kopija** radi poređenja; „ispravljanje” znaka pri uvozu
  bi tiho razišlo dva sistema koja upravo treba da se poklope.
* **Nebalansirani nalozi.** 13 od 1.126 ne balansira (ukupno **+0,10 RSD**, sve zaokruženja).
  Uvoz ide sirovim SQL-om, ne kroz servis knjiženja, pa se `LedgerNotBalancedException` uopšte
  ne okida — namerno, iz istog razloga.
* **`Pozicija` NIJE mesto troška.** Vrednosti su `0` (19.296), `drugi` (577), `fiskalni` (493) —
  to je klasifikacija **porekla ulaznog dokumenta** za PDV/KEPU. Zato ide u novu kolonu
  `ledger_entries.document_origin`, a `cost_center` na uvezenim redovima ostaje `NULL`.
* **Devize.** `DevDuguje`/`DevPotrazuje` u 19.770 od 20.366 redova samo **preslikavaju dinarski
  iznos** (kad je `DevValuta` = RSD). Zato se `fx_debit`/`fx_credit`/`fx_currency` pune **samo**
  kad valuta nije RSD. Valuta se normalizuje (9 varijanti u izvoru → `DIN`/`Din`/`rsd`/prazno →
  `RSD`). Rezultat na dev bazi: RSD 19.539, EUR 830, USD 86, CNY 19.
* **Status naloga.** Sve uvezeno je već proknjiženo u BigBitu → `POSTED`; `Zakljucano=1` →
  `LOCKED` (10 naloga). Nikad `DRAFT` — uvezen nalog se u 4.0 ne edituje.
* **Sudar broja naloga = KVAR, ne fusnota.** `uq_journal_entries_number` je
  `(company, vrsta, godina, broj)`, a 4.0-native knjiženje i BigBit dele isti prostor brojeva
  (`nextJournalNumber` je `MAX+1` nad istim ključem). Ako 4.0 zauzme broj koji BigBit kasnije
  izda, izvorni nalog ne može da uđe — **i sa njim otpadaju sve njegove GK stavke**, jer se
  vezuju preko `bb_nalog_id`. Zato uvoz takav nalog preskoči, **imenuje sudar** i onda **obori
  ceo run** (`BigbitMdbConflictError`, status `FAILED`). Ranije je to bio broj u jednoj log
  liniji uz `DONE` — dokument sa svojom PDV osnovicom nikad ne bi ušao, a poređenje bi promašilo
  baš tu razliku. Uslov je trajan, pa se run ponavlja svake noći dok se ne razreši (§9).
* **Duplikat unutar istog uvoza.** Dva različita `IDNaloga` koja se svedu na isti
  `(firma, vrsta, godina, broj)` bi oborila ceo `INSERT` na unique indeksu (`ON CONFLICT
  (bb_nalog_id)` ga ne hvata). Zato `ROW_NUMBER()` višak izbacuje u isti brojač sudara — uvoz
  padne sa **objašnjenjem**, ne sa sirovom `unique violation`.
* **Identitetske kolone se NE skraćuju.** `konto`, `Vrsta naloga` i `Broj naloga` se ranije
  sekli sa `left()`; to bi **tiho spojilo** dve različite vrednosti u jednu (a kod vrste naloga i
  dva odvojena brojevna niza, što vodi pravo u sudar iznad). Sada se predugačak red **odbacuje**
  i broji u `filtered`. `Vrsta naloga` je već na granici (5/5).
* **Zamke ekstrakcije** (sve rešene u skripti): razdvajač je `|` jer `Broj dokumenta` sadrži zarez
  (`105CHGR26003000Q,BI0`); `-e` (C-escape) jer memo polja nose prelome reda; `-T/-D` jer je
  difolt format američki sa dvocifrenom godinom; brojanje redova **nikad** po `mdb-count`
  (greši za −9 na `T_Glavna knjiga` i `T_PDV_GK`).

---

## 9. Kad padne — šta raditi

**Gde se vidi da je palo (tri mesta, po redu koliko su brza):**

1. **Zvonce** — jutarnji nadzornik `bigbit-sync-watchdog` (07:15) šalje notifikaciju svim
   aktivnim administratorima kad postoji `danger` upozorenje (uvoz kasni, pao je, zaglavio se,
   nikad nije proradio, ili je prekidač ugašen). Jedna poruka po danu po primaocu — catch-up i
   retry ne prave tri obaveštenja. **Ovo je jedini kanal koji sam dolazi do čoveka;** sve
   ostalo traži da neko otvori ekran.
2. **Podešavanja → Integracije** — kartica „Noćni uvoz finansija iz BigBita (.mdb)”:
   prekidač, poslednji uspešan uvoz, broj redova, starost izvornog fajla, upozorenja na srpskom.
3. **`scheduled_job_runs`** (`job_key = 'bigbit-mdb-sync'`) i `bb_mdb_drops.import_error` —
   pun tekst greške.

| Simptom | Uzrok | Šta uraditi |
|---|---|---|
| `Podaci iz BigBita nisu stigli … star N h` | dostava `.mdb`-a iz BigBita stala | `ls -la /srv/bigbit-incoming/`. Problem je **uzvodno**, u BigBit izvozu — javiti osobi zaduženoj za BigBit. Kvar nije u 4.0. |
| `nema nijednog učitanog fajla` | korak 1 nikad nije prošao | `systemctl status bigbit-mdb-export.timer`; pokreni ručno (§2) i pogledaj izlaz. |
| `BigBit je ponovo isporučio ISTI fajl` | isti sadržaj, nov `mtime` (rsync bez `--times`, ručni `cp`, ponovljena isporuka) | Noćni izvoz na BigBit mašini verovatno ne radi i samo prekopira staru kopiju. **Lažna svežina je opasnija od bajatog fajla** — datum izgleda dobro. Javiti BigBit strani. |
| `Fajl iz BigBita je prazan ili nepotpun` | kopiranje 375 MB nije bilo završeno kad je izvoz krenuo | Ponoviti korak 1 (skripta sada čeka da se veličina stabilizuje 60 s, ili traži `<ime>.mdb.ready`). Ako se ponavlja — dostava puca na pola. |
| `FAJL SE JOŠ MENJA (…)` iz skripte | isti uzrok, uhvaćen ranije | Nije kvar — sledeći termin će ga pokupiti. Trajno: neka dostava pravi `.ready` marker. |
| `PAD BROJA REDOVA za '<tabela>'` | krnj izvoz ili pogrešan fajl (GK tokom godine samo raste) | Proveriti koji je fajl pokupljen. Ako je pad **legitiman** (nova poslovna godina, arhiviranje) → `BB_ALLOW_SHRINK=1`. |
| `N BigBit nalog(a) NIJE moglo da uđe` | sudar broja naloga sa 4.0-native nalogom | **Run je FAILED, i tako treba.** Sa svakim preskočenim nalogom otpadaju i sve njegove GK stavke, pa poređenje PDV-a promašuje baš tu razliku. Rešenje: u 4.0 ne knjižiti u vrste naloga/godine koje vodi BigBit, ili preknjižiti sporni 4.0 nalog. Upit u §10. |
| `⚠ nestalo iz BigBita: N naloga / M stavki` | dokument obrisan ili prekontiran u BigBitu | Uvoz **nikad ne briše**, pa fantom ostaje u 4.0 i diže PDV osnovicu. Ne briše se automatski — to je knjigovodstvena odluka. Upit u §10. |
| `ZAGLAVLJE SE PROMENILO za '<tabela>'` | BigBit dodao/premestio kolonu | **Ne zaobilaziti.** Uskladiti model u `schema.prisma` (nova migracija) **i** manifest `TABLES` u skripti, pa ponoviti. Brana postoji da se ne upišu pomerene vrednosti u pogrešne kolone. |
| `stage_status=FAILED` | `mdb-export` ili `\copy` pao | `BB_KEEP_WORK=1` pa ponoviti — CSV-ovi ostaju u `/tmp/bigbit-mdb-export/<dropId>/`. Vidi `bb_mdb_drops.stage_error`. |
| `uvoz drop-a N je VEĆ U TOKU` | drugi uvoz istog drop-a (dvoklik, druga instanca) | Nije kvar — sačekati. Mutex je `bb_mdb_drops.import_started_at`; zaostali claim se sam oslobađa posle 2 h. |
| Posao vraća `DISABLED` / `isključen u Podešavanjima` | ugašen korisnički prekidač | Nije kvar. Upaliti ga ako treba (§3). Kartica pokazuje i **koliko dugo** je ugašen. |
| Ekran: `Uvoz je počeo … i nikad se nije završio` | proces ubijen (OOM) ili restart kontejnera usred obrade | Pokrenuti ručno (§2). Red ostaje `RUNNING` zauvek jer ga niko ne zatvara — zato postoji zasebno upozorenje. |
| Ekran: `Stanje nepoznato` | `GET /admin/sync/bigbit` pao | **Ne oslanjati se na prikazano** — ne zna se ni da li je uvoz uključen. Osvežiti; ako se ponavlja, IT. |

**Ponovno pokretanje je uvek bezbedno** — ni korak 1 ni korak 2 ne prave duplikate (§6).

**Brisanje drop-a nije predviđeno.** FK `imported_drop_id` je `ON DELETE RESTRICT` jer je
`bb_mdb_drops` **zapisnik**: bez njega se ne može reći iz kog je fajla koji red došao.
`DELETE FROM bb_mdb_drops` će uredno odbiti posao. Staging se čisti sam — noćni posao
`retention-cleanup` (03:30) briše `bb_mdb_stage_*` za sve osim poslednjih 7 drop-ova, a korak 1
briše `.mdb` fajlove starije od 7 dana (`BB_KEEP_DAYS`) iz drop foldera.

---

## 10. Korisni upiti (provere)

```sql
-- Poslednji drop-ovi: šta je stiglo, koliko je trajalo
SELECT id, file_name, file_mtime, pg_size_pretty(file_size) AS vel,
       stage_status, stage_duration_ms, import_status, import_duration_ms, imported_at
FROM bb_mdb_drops ORDER BY file_mtime DESC LIMIT 10;

-- Koliko je 4.0 podataka uvezeno, a koliko je nastalo ovde
SELECT count(*) FILTER (WHERE imported_drop_id IS NOT NULL) AS iz_bigbita,
       count(*) FILTER (WHERE imported_drop_id IS NULL)     AS nativno_4_0
FROM ledger_entries;

-- Kontrola: nalozi koji ne balansiraju (u snimku 11.07. -> 13 komada, ukupno 0,10 RSD)
SELECT j.bb_nalog_id, j.order_type_code, j.number,
       sum(l.debit) - sum(l.credit) AS razlika
FROM ledger_entries l JOIN journal_entries j ON j.id = l.journal_entry_id
WHERE j.imported_drop_id IS NOT NULL
GROUP BY 1,2,3 HAVING sum(l.debit) <> sum(l.credit) ORDER BY 4;

-- SUDARI BROJA NALOGA: koji 4.0-native nalog blokira koji BigBit nalog
SELECT s.id_naloga AS bb_nalog, s.vrsta_naloga, s.godina, s.broj_naloga,
       j.id AS blokira_ga_4_0_nalog, j.created_at
FROM bb_mdb_stage_nalozi s
JOIN journal_entries j
  ON j.company_id = coalesce(nullif(btrim(s.id_firma), '')::int, 0)
 AND j.order_type_code = btrim(s.vrsta_naloga)
 AND j.year = coalesce(nullif(btrim(s.godina), '')::int, 0)
 AND j.number = btrim(s.broj_naloga)
WHERE s.drop_id = (SELECT max(id) FROM bb_mdb_drops WHERE stage_status = 'LOADED')
  AND j.bb_nalog_id IS DISTINCT FROM nullif(btrim(s.id_naloga), '')::int;

-- NESTALO IZ BIGBITA: uvezene stavke kojih u poslednjem snimku više nema
-- (obrisane/prekontirane u BigBitu; uvoz ih NE briše sam — to je odluka knjigovodstva)
WITH seen AS (
  SELECT stavka_id::int AS id FROM bb_mdb_stage_gk
  WHERE drop_id = (SELECT max(id) FROM bb_mdb_drops WHERE stage_status = 'LOADED')
    AND btrim(coalesce(stavka_id, '')) ~ '^[0-9]+$'
)
SELECT l.bb_stavka_id, l.account_code, l.debit, l.credit, l.description, j.number
FROM ledger_entries l JOIN journal_entries j ON j.id = l.journal_entry_id
WHERE l.bb_stavka_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM seen WHERE seen.id = l.bb_stavka_id);

-- ZLATNI UZORAK: naš izračun vs. BigBitov PDV motor, stavka po stavku
SELECT p.stavka_id, p.pdv_evidencija, p.pdv_osnovica, p.pdv_iznos,
       l.account_code, l.debit, l.credit
FROM bb_mdb_stage_pdv_gk p
JOIN ledger_entries l ON l.bb_stavka_id = p.stavka_id::int
WHERE p.drop_id = (SELECT max(id) FROM bb_mdb_drops WHERE import_status = 'DONE')
LIMIT 50;
```

---

## 11. Šta još NIJE urađeno (pošteno)

Redosled je po tome koliko blokira tri paralelna PDV obračuna.

1. **DOSTAVA `.mdb`-a IZ BIGBITA NE POSTOJI — ovo je pravi blokator.** Ovaj kanal obrađuje
   samo ono što zatekne u `/srv/bigbit-incoming/`. Jedini fajl tamo je od **11.07.2026**.
   Noćni izvoz *iz BigBita* u taj folder je zaseban posao **na BigBit mašini** i treba mu neko
   ko ima pristup toj mašini. Dok ne proradi, brana svežine će svake noći javljati bajat drop —
   to je ispravno ponašanje, ali paralelnih PDV obračuna do tada **nema**.
   Idealno neka dostava posle zatvaranja fajla napravi marker `<ime>.mdb.ready` (skripta ga
   prepoznaje i preskače čekanje na stabilizaciju).

2. **KORAK 1 NIJE INSTALIRAN NA HOST.** Skriptu treba kopirati i zakazati:

   ```bash
   sudo install -m 750 backend/scripts/bigbit-mdb-export.sh /opt/servosync/bigbit-mdb-export.sh
   sudo install -m 600 /dev/null /etc/servosync/bigbit-mdb.env
   # u /etc/servosync/bigbit-mdb.env:
   #   BB_DATABASE_URL=postgresql://servosync_app:...@127.0.0.1:5432/servosync
   ```
   ```ini
   # /etc/systemd/system/bigbit-mdb-export.service
   [Unit]
   Description=BigBit .mdb -> Postgres staging
   [Service]
   Type=oneshot
   # EnvironmentFile (0600), NE Environment= — unit fajl je čitljiv svima,
   # a `docker run ... psql "$URL"` bi lozinku pokazao i u `ps aux`.
   EnvironmentFile=/etc/servosync/bigbit-mdb.env
   ExecStart=/bin/bash /opt/servosync/bigbit-mdb-export.sh
   ```
   ```ini
   # /etc/systemd/system/bigbit-mdb-export.timer
   [Unit]
   Description=BigBit .mdb staging svake noći u 02:50
   [Timer]
   OnCalendar=*-*-* 02:50:00
   Persistent=true
   [Install]
   WantedBy=timers.target
   ```

   **02:50 namerno** — posle noćnog backupa (02:30–02:35, klon cele mašine); korak 2 je na
   03:45, posle `retention-cleanup` (03:30) koji se u istom tiku izvršava serijski.
   `BB_DATABASE_URL` mora biti dostupan **sa hosta**: `servosync-pg` je ime kontejnera na docker
   mreži, pa ide mapirani port (`127.0.0.1:5432`) ili `--network servosync_default`.

3. **PDV MOTOR — sledeći paket.** `PDV_SemeKontaZaKnjizenje` (20), `POPDV_SemeKontaZaKnjizenje`
   (84) i `PDV_Knjige` (17) **nemaju ciljne tabele** u 4.0. Bez njih se PDV prijava ne može
   izvesti iz glavne knjige, a to je jedini kanal kod Servoteha (`T_PDV_IF`/`T_PDV_UF` su
   prazne). Staging za poređenje (`T_PDV_GK` 1.965, `T_POPDV_GK` 4.486) je već tu — upit je u §10.

4. **ŠEME KNJIŽENJA se staguju ali se NE uvoze.** 4.0 seed je ručno ispravljen (šema 31 gađa
   nepostojeća konta 470/471; 37/38 su jednostrane pa ne balansiraju), a slepi uvoz bi te
   ispravke pregazio. Šeme voze *buduće* automatsko knjiženje, ne paralelni PDV obračun.

5. **KOMITENTI I PREDMETI NISU U OVOM KANALU** i to se neće menjati: njih vozi MSSQL sync koji
   čita bazu *uživo*. **Ali taj sync nije zakazan** — pokreće se isključivo rutom
   `POST /api/v1/sync/run` sa ekrana `/syncs`, a `sync.run` ima samo administrator. Pošto je
   od 26.07.2026 unos komitenata i predmeta u 4.0 **zabranjen** (odluka vlasnika), korisnik koji
   unese novog komitenta u BigBit mora da traži od administratora da pokrene uvoz. Poruke u
   aplikaciji to sada **tako i kažu**. Kad se šifarnički sync zakaže kao posao, tekst se menja na
   jednom mestu: `backend/src/modules/directory/bigbit-owned.ts`.

6. **NEMA ekrana „Pokreni sada" za ovaj uvoz.** Ručno pokretanje ide kroz
   `POST /api/v1/scheduler/jobs/bigbit-mdb-sync/run-now` (§2). Kartica u *Podešavanja →
   Integracije* prikazuje stanje i drži prekidač, ali nema dugme.

7. **NEMA oznake porekla na EKRANIMA.** U bazi se uvezeni red razlikuje po
   `imported_drop_id`/`bb_stavka_id`, ali listе glavne knjige i naloga to ne prikazuju. Pre
   prvog prod uvoza treba dodati bedž „iz BigBita" i filter „samo 4.0 unosi" — inače će pilot
   krug u ponedeljak zateći ~20.000 stavki kojih u petak nije bilo, među njima 592 sa negativnim
   iznosom i 13 naloga koji ne balansiraju, i to prijaviti kao bag.
   **Prvi prod uvoz uraditi ručno i danju**, ne pustiti da se dogodi u 03:45 bez ikoga.

8. **SENKE PREDMETA (nasleđeno).** U bazi postoje ranije nastali 3.0-native predmeti; paritet-guard
   (`ADDITIVE_DEDUP_FIELDS.projects`) zbog njih **preskače BigBit kopiju istog broja**, pa se ti
   predmeti više nikad neće poravnati sa BigBitom. Treba ih jednokratno prevezati (radni nalozi,
   aktivacije, `customer_rfqs.project_id`) i obrisati native red. Van ovog paketa.

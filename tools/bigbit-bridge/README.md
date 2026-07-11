# ServoSync BigBit bridge

Skripta koja BigBit ERP matične tabele (Access `.mdb` sa ULS workgroup security)
sinkuje u ServoSync 2.0 PostgreSQL — **direktno, bez XML-a i bez NestJS sync modula**
(odluka Nenad 11.07.2026, [BB_T_26_ANALIZA_I_PLAN.md §7.3](../../docs/migration/BB_T_26_ANALIZA_I_PLAN.md)).

- **Gde radi:** Windows server `Srv-all.servoteh.local` (192.168.64.27, Windows Server 2019).
- **Ritam:** 1× dnevno u **05:30** (Windows Task Scheduler — `install-task.ps1`).
- **Jezik:** PowerShell 5.1 (bez PS7 pretpostavki); OLEDB kroz `System.Data.OleDb` iz .NET-a.
- **Jedine zavisnosti na mašini:** ACE OLEDB x64 redistributable + PostgreSQL client tools (`psql.exe`).

Obrazac je isti kao [pdm-bridge](../pdm-bridge/README.md): samostalan alat, config odvojen
od koda, log fajl (append), idempotentno, single-shot proces (raspored radi Task Scheduler).

## Arhitektura

```
BigBit server                     Srv-all (192.168.64.27)                 ubuntusrv (192.168.64.28)
┌──────────────┐   UNC copy   ┌──────────────────────────────┐   LAN 5432   ┌────────────────────┐
│ BB_T.mdb     │ ───────────► │ 1. lokalna KOPIJA .mdb+.MDW  │ ───────────► │ docker servosync-pg│
│ BIGBIT.MDW   │              │ 2. ACE OLEDB čita KOPIJU     │  psql.exe    │  \copy → TEMP stage│
│ (otvoreni od │              │ 3. CSV (UTF-8) u temp        │  (bb_sync)   │  INSERT…ON CONFLICT│
│  BigBit app) │              │ 4. psql \copy + UPSERT       │              │  DO UPDATE (UPSERT)│
└──────────────┘              └──────────────────────────────┘              └────────────────────┘
```

Po tabeli: čitanje → CSV → `\copy` u TEMP staging tabelu → `INSERT … ON CONFLICT … DO UPDATE`
— sve u **jednoj transakciji po tabeli** (pola tabele nikad ne ostaje upisano).
**UPSERT je odluka**: insert-only je odbačen jer bi zamrzao kasnije izmene u BigBit-u
(promenjen opis grupe se nikad ne bi propagirao). No-op update-i se preskaču
(`WHERE … IS DISTINCT FROM …`) da dnevni run ne pravi mrtve verzije redova u PG.

### Zašto se čita KOPIJA, nikad original

Original `.mdb` **drži otvorenim BigBit aplikacija** ceo dan. Bridge zato:

1. kopira `.mdb` **i** `BIGBIT.MDW` sa UNC putanje u lokalni temp (`Copy-Item` radi i nad
   otvorenim Jet fajlovima — Access ih deli read/write);
2. otvara **isključivo kopiju** — na original se ne kači nijedna OLEDB sesija (ni na MDW).

Jet nema online-backup API, pa kopija otvorene baze u teoriji može biti „pokidana"
(uhvaćena usred upisa). **Noćni termin 05:30 (niko ne radi) je upravo ono što taj rizik
minimizuje.** Pokidana kopija pada glasno pri otvaranju/čitanju (exit 2) — podatak se
ne upisuje pogrešno, a sledeća noć pokušava ponovo.

### ⚠️ ULS: koji nalog sme da čita

BigBit koristi Access **user-level security** (workgroup `BIGBIT.MDW`). Konekcija ide sa
`Jet OLEDB:System Database=<MDW>` + `User ID`/`Password`:

- **`admin` / `telefon` NEMA read pravo** — konekcija se otvori, ali svaki SELECT pada.
- Aplikativni nalog je **`Slavisa`** — lozinka se nabavlja od **Negovana** (još nije nabavljena).
- Skripta **na startu radi `SELECT COUNT(*)` probu** i pada sa jasnom porukom (exit 2)
  ako nalog nema read — nema tihe polovične sinhronizacije.

## Obim v0 (pilot) i faze proširenja

v0 = 3 šifarnika artikala (modeli u 2.0 postoje, a bili su prazni — poznata rupa iz
[F1 analize](../../docs/migration/BB_T_26-analiza-F1-pokrivenost-polja.md): `Item.groupCode/
subgroupCode/originCode` su kodovi bez naziva):

| BigBit (Access) | Kolone | → PG tabela | Napomena |
|---|---|---|---|
| `R_Grupa` | `Grupa` Text(10), `Opis` Text(50) | `item_groups(code PK, description)` | `description = COALESCE(Opis,'')` |
| `R_Podgrupa` | `Podgrupa`, `Opis`, `GrupaVeza` | `item_subgroups(code PK, description, parent_group)` | `parent_group` default `'0'` |
| `R_Poreklo` | `Poreklo` Text(5), `Opis`, `PodgrupaVeza`, `PopustProc` Currency | `item_origins(code PK, description, subgroup_code, discount_percent numeric(19,4))` | `PopustProc` = komercijalni popust, bitan za 4.0 sales |

Tabele se dodaju **deklarativno** u `$TableMaps` na vrhu `bigbit-bridge.ps1` (SELECT lista,
ciljna tabela, kolone sa tipovima i default-ima) — ništa drugo se ne menja. Deny-lista
(EXCLUDE-TVRDO iz F3) se sprovodi prosto time što tabela **nije u mapi** — skripta nikad
ne SELECT-uje ništa van allow-liste.

**Faza 2** — `Komitenti`, `Predmeti`, `R_Artikli`, `Cenovnik`, `Magacini`, `Prodavci`:

- ⚠️ **`Prodavci.Password` se NIKAD ne kopira** — plain-text lozinke; kolona se prosto
  ne stavlja u SELECT listu mape.
- ⛔ **BLOKIRANO odlukom o ID-prostoru**: `items.id` je danas QBigTehn lokalna šifra, a
  BigBit šifra živi u `external_item_id` — direktan BigBit izvor traži remap ili migraciju
  ključa ([§7.2/§7.3](../../docs/migration/BB_T_26_ANALIZA_I_PLAN.md)). Ne implementirati pre te odluke.
- `Cenovnik` i `R_Artikli` flagovi **moraju UPSERT** (cena se menja na postojećem redu) —
  mehanizam je već takav.

**Faza 3** — ostatak KEEP-SYNC liste (49 tabela) iz
[F3 inventara 207 tabela](../../docs/migration/BB_T_26-analiza-F3-inventar-207-tabela.md).

## Preduslovi

### Na Srv-all (192.168.64.27)

1. **Microsoft Access Database Engine 2016 Redistributable — x64**
   (`accessdatabaseengine_X64.exe`, Microsoft download; daje `Microsoft.ACE.OLEDB.16.0`;
   skripta ima fallback na 12.0 ako već postoji stariji). ⚠️ Mora **x64** — PowerShell
   proces je 64-bitni i ne vidi 32-bitni provider. Ako je na serveru instaliran 32-bitni
   Office, installer odbija — pokreni ga sa `/quiet` (poznato Microsoft zaobilaženje).
2. **PostgreSQL client tools** — treba samo `psql.exe`: EDB installer (čekirati samo
   „Command Line Tools") ili zip „binaries". Putanja se auto-detektuje (PATH pa
   `C:\Program Files\PostgreSQL\<ver>\bin`) ili se zada kroz `BB_BRIDGE_PSQL_EXE`.
3. Windows nalog koji pokreće task: **read na BigBit UNC share** + pravo
   *Log on as a batch job*.
4. Disk za temp: kopija cele `.mdb` (Jet limit 2 GB) — default `%TEMP%\bigbit-bridge`.

### Na ubuntusrv (192.168.64.28) — ⚠️ JOŠ NIJE URAĐENO

1. **Izlaganje 5432 na LAN, samo za Srv-all.** PG je docker kontejner `servosync-pg`;
   u produkcionom compose-u (na serveru, `/home/admluka/servosync`) port dodati vezan
   za LAN IP:

   ```yaml
   services:
     db:
       ports:
         - "192.168.64.28:5432:5432"   # bind samo na LAN IP, ne 0.0.0.0
   ```

   pa firewall ograničiti na Srv-all IP:

   ```bash
   sudo ufw allow from 192.168.64.27 to any port 5432 proto tcp comment 'bigbit-bridge (Srv-all)'
   ```

   > Napomena: docker publish pravi DNAT pre ufw INPUT lanca — proveriti da važi i
   > DOCKER-USER pravilo ako ufw ne uhvati saobraćaj:
   > `sudo iptables -I DOCKER-USER -p tcp --dport 5432 ! -s 192.168.64.27 -j DROP`
   > (bind na 192.168.64.28 već isključuje internet stranu — tunel ne izlaže 5432).

2. **Namenska PG rola `bb_sync`** — write SAMO na ciljne tabele
   (`docker exec -it servosync-pg psql -U servosync -d servosync`):

   ```sql
   CREATE ROLE bb_sync LOGIN PASSWORD '<jaka lozinka>';
   GRANT CONNECT, TEMPORARY ON DATABASE servosync TO bb_sync;  -- TEMPORARY: staging tabele
   GRANT USAGE ON SCHEMA public TO bb_sync;
   GRANT SELECT, INSERT, UPDATE ON TABLE item_groups, item_subgroups, item_origins TO bb_sync;
   ```

   **Bez DELETE** — bridge nikad ne briše (vidi „Poznata ograničenja"). Pri dodavanju
   tabela u fazi 2/3 GRANT se proširuje istim obrascem.

## Instalacija (na Srv-all)

1. Iskopiraj ceo folder `bigbit-bridge` (npr. u `C:\ServoSync\bigbit-bridge`).
2. `copy bigbit-bridge.env.example bigbit-bridge.env` pa popuni: UNC putanje do `.mdb` i
   `BIGBIT.MDW`, ULS nalog (`Slavisa` + lozinka od Negovana), PG host/lozinku za `bb_sync`.
   `bigbit-bridge.env` sadrži lozinke → **nikad u git** (`.gitignore` ga već pokriva);
   NTFS prava na folder suzi na naloge kojima treba.
3. Provera preduslova (ništa se ne upisuje):

   ```bat
   powershell -NoProfile -ExecutionPolicy Bypass -File smoke-check.ps1
   ```

   Proverava: 64-bit proces, config, ACE provider registrovan, `psql.exe`, UNC dostupnost,
   PG konekciju + privilegije po tabeli + TEMP privilegiju, i **ULS READ test** (kopira
   `.mdb` u temp pa `SELECT COUNT(*)` na sve 3 tabele; preskoči sa `-SkipUlsTest` ako je
   kopija prevelika za brzu proveru).
4. Probni run bez upisa (sve stvarno osim COMMIT-a — na kraju ROLLBACK):

   ```bat
   powershell -NoProfile -ExecutionPolicy Bypass -File bigbit-bridge.ps1 -DryRun
   echo %ERRORLEVEL%
   ```

5. Prvi pravi run: isto bez `-DryRun`; proveri `bigbit-bridge.log` i u PG:
   `SELECT count(*) FROM item_groups;` itd.
6. Registracija taska (iz **admin** PowerShell-a; [ČOVEK] unosi lozinku naloga interaktivno
   — ne čuva se nigde):

   ```bat
   powershell -NoProfile -ExecutionPolicy Bypass -File install-task.ps1 -RunAsUser DOMEN\nalog
   ```

   Parametri: `-RunAsUser` (obavezan), `-At` (default `05:30`), `-TaskName`, `-ScriptDir`,
   `-Password` (SecureString, za skriptovanu instalaciju bez prompta). Postavlja sve bez
   GUI koraka — uključujući *Start in* (poznata `schtasks` zamka iz pdm-bridge README-a;
   akcija dodatno koristi apsolutnu `-File` putanju pa radi i bez *Start in*). Sam task se
   izvršava potpuno neinteraktivno (`-NonInteractive`). Idempotentno: ponovno pokretanje
   pregazi postojeći task.

   Odmah probaj: `Start-ScheduledTask -TaskName "ServoSync BigBit Bridge"`, pa
   `Get-ScheduledTaskInfo -TaskName "ServoSync BigBit Bridge"` (LastTaskResult po tabeli dole).

## Exit kodovi (Task Scheduler „Last Run Result")

| Kod | Značenje |
|-----|----------|
| `0` | sve tabele sinkovane |
| `1` (0x1) | bar jedna tabela pala (transakcija po tabeli — ništa delimično; vidi log) |
| `2` (0x2) | BigBit read pao: ULS login odbijen / nalog bez READ prava / pokidana kopija |
| `3` (0x3) | konfiguracija/preduslov: fali promenljiva, ACE provider neregistrovan, nema `psql.exe` |
| `4` (0x4) | kopija sa UNC pala (share nedostupan / nema prava) |
| `5` (0x5) | PostgreSQL nedostupan (`SELECT 1` pao — firewall/5432/lozinka) |

## Log

`bigbit-bridge.log` (append, pored skripte ili `BB_BRIDGE_LOG_FILE`), po run-u:

```
2026-07-12 05:30:02 INFO  === BigBit bridge start - mod=upsert, pg=192.168.64.28:5432/servosync as bb_sync, ... ===
2026-07-12 05:30:03 INFO  PostgreSQL dostupan (SELECT 1 OK).
2026-07-12 05:30:41 INFO  Snapshot MDB: \\bigbit\...\BB_T.mdb -> ...\run-20260712_053002\bigbit-copy.mdb (612.4 MB, 38.1s)
2026-07-12 05:30:42 INFO  ACE OLEDB provider: Microsoft.ACE.OLEDB.16.0 (ULS nalog: Slavisa)
2026-07-12 05:30:42 INFO  ULS READ provera OK (R_Grupa: 57 redova u snapshotu).
2026-07-12 05:30:43 INFO  R_Grupa -> item_groups: read=57 inserted=0 updated=2 unchanged=55 missing_in_source=0 (0.8s)
...
2026-07-12 05:30:45 INFO  REZIME: tabele OK=3 palo=0, read=312 inserted=2 updated=5 (42.7s)
```

`missing_in_source` = redovi koji postoje u PG a više ih nema u BigBit-u — **samo se
loguju (WARN), nikad se ne brišu** (odluka §7.3: bez hard-delete; „obrisano" flag ide u
overlay tabelu kad na to dođe red).

## Rollback

1. Task: `uninstall-task.ps1 -DisableOnly` (pauza; `Enable-ScheduledTask` vraća) ili bez
   parametra (uklanjanje).
2. Podaci: **DELETE iz 3 tabele je bezbedan** — pune se isključivo odavde (pre bridge-a su
   bile prazne; ne piše ih ni backend ni QBigTehn sync):

   ```sql
   DELETE FROM item_origins;
   DELETE FROM item_subgroups;
   DELETE FROM item_groups;
   ```

3. BigBit strana je netaknuta po definiciji — bridge je samo kopirao fajlove sa share-a.

## Dodavanje nove tabele (faza 2/3)

U `bigbit-bridge.ps1`, blok `$TableMaps` — dodaj novu mapu po istom obrascu:

1. `SelectSql`: kolone **eksplicitno** (nikad `SELECT *`) — šema-drift u BigBit-u tada
   pada glasno umesto da tiho pomeri kolone; osetljive kolone (npr. `Prodavci.Password`)
   se prosto ne navode.
2. `Columns`: redosled = redosled u SELECT-u; `PgType` = tip staging kolone (mora biti
   kompatibilan sa ciljnom tabelom); `Default` = vrednost kad je Access ćelija NULL
   (izostavi `Default` za pravi SQL NULL).
3. `KeyColumns` = PK ciljne tabele (ON CONFLICT target).
4. Proširi GRANT za `bb_sync` (SQL gore) i, po potrebi, listu tabela u `smoke-check.ps1`.
5. Test: `bigbit-bridge.ps1 -Only <tabela> -DryRun`.

## Poznata ograničenja

- **ULS kredencijal:** lozinka naloga `Slavisa` se tek nabavlja od Negovana — do tada je
  jedini blokator prvog run-a (runtime proba javlja tačno to).
- **Snapshot konzistentnost:** kopija otvorene Jet baze nije transakciono konzistentan
  backup; noćni termin (05:30) je mitigacija, pokidana kopija pada glasno (exit 2) i
  sledeća noć pokušava ponovo. Podaci su šifarnici koji se menjaju retko — prozor rizika
  je minimalan.
- **Encoding:** Access čuva Unicode — CSV se piše kao **UTF-8 bez BOM-a** (BOM bi ušao u
  prvo polje header-a), `\copy` ide sa `ENCODING 'UTF8'`, a `PGCLIENTENCODING=UTF8` je
  postavljen za psql proces. Naša slova (š, đ, č…) prolaze bez izobličenja.
- **Decimalni separator:** srpski locale piše `1,5` — brojevi se formatiraju invariant
  kulturom (`1.5`) pre CSV-a (zamka rešena u `Convert-CellValue`).
- **Duplikat ključa u izvoru:** dva reda sa istim PK u snapshotu obaraju tabelu glasno
  (`ON CONFLICT ... cannot affect row a second time`) — namerno, to je problem podataka
  u BigBit-u koji se rešava tamo, ne tihim gaženjem.
- **Bez delete propagacije:** v0 samo upisuje/menja; nestale redove broji i loguje
  (`missing_in_source`), ništa ne briše.
- **Širine kolona 1:1** (`Text(10)` → `varchar(10)`): duža vrednost (ne bi smela da
  postoji) pada glasno na `\copy` — bolje nego tiho sečenje.
- **Jedan hop, bez state fajla:** za razliku od pdm-bridge-a nema lokalnog state-a —
  UPSERT je idempotentan po prirodi, pa je ponovljeni run uvek bezbedan.

# ServoSync PDM bridge

Skripta koja PDM izvoze (SolidWorks PDM) nosi sa mrežnih share-ova u ServoSync 2.0:

- **XML** (`PDM_BRIDGE_XML_DIR`, npr. `\\<bigbit-server>\PDMExport\XML`) →
  `POST {API_BASE}/v1/pdm/import` (multipart: `file` + `sourcePath`)
- **PDF** (`PDM_BRIDGE_PDF_DIR`, npr. `\\pdm-pdf\VASADATA`) →
  `POST {API_BASE}/v1/pdm/pdf-import` (multipart: `file` + `sourcePath`)

Jedan fajl, **nula zavisnosti** (Node built-in `fetch`/`FormData`/`Blob` + `node:fs`/`node:crypto`),
Node ≥ 20.6 (preporuka: **22 LTS**). Proces je *single-shot*: uradi jedan prolaz i završi se —
periodično pokretanje radi **Windows Task Scheduler** (dole), ne rezidentni servis.

Kontekst i cutover plan: [docs/design/PLAN_primopredaja_tp_cutover.md](../../docs/design/PLAN_primopredaja_tp_cutover.md)
(§1 legacy tok, §2.8 XML ugovor, §2.9 rizici, §3 P4).

## Pasivni i aktivni mod

### `PDM_BRIDGE_MODE=passive` (default — OBAVEZAN dok legacy živi)

Bridge fajlove **ne pomera i ne briše** — legacy 10-min skripte ih i dalje nose u
`Importovano`/`Neuspelo`. Kad ih legacy skloni, bridge ih prosto više ne vidi.
Dupli-send sprečava lokalni state fajl (`pdm-bridge.state.json`):

- ključ = puna putanja fajla → `{ size, mtimeMs, sha256, sentAt, result, statusMessage }`;
- isti `(ime, size, mtime)` → skip bez čitanja; isti `sha256` → skip (samo se osveži otisak);
- **izmenjen sadržaj = novi re-export → šalje se ponovo**;
- poslovno odbijen fajl (`success:false`) se za isti sadržaj **ne šalje ponovo** — isti sadržaj
  bi opet pao; tek novi re-export (novi hash) ide ponovo;
- state se snima atomično (tmp + rename) **posle svakog fajla** — pad usred run-a ne duplira poslato;
- zapisi za fajlove koji više ne postoje (legacy ih premestio) se automatski čiste na kraju run-a.

### `PDM_BRIDGE_MODE=active` (TEK NA CUTOVER)

> **UPOZORENJE:** aktivni mod se uključuje **tek kada se legacy 10-min skripte ugase**.
> Dok legacy živi, dve skripte bi se otimale oko istih fajlova — pasivni mod je obavezan.

Posle **definitivnog** odgovora bridge premešta fajl (paritet legacy `PremestiXMLFile`):

- `data.success: true` → `Importovano\` (`PDM_BRIDGE_IMPORTED_DIR`, default `{XML_DIR}\Importovano`);
- odbijeno (`success:false` ili 4xx) → `Neuspelo\` (`PDM_BRIDGE_FAILED_DIR`, default `{XML_DIR}\Neuspelo`);
- PDF-ovi uvek idu u `{PDF_DIR}\Importovano` / `{PDF_DIR}\Neuspelo`;
- kolizija imena → sufiks `_yyyyMMdd_HHmmss`;
- privremene greške (mreža/5xx) se **ne premeštaju** — sledeći run pokušava ponovo;
- state se i dalje vodi: pad između slanja i premeštanja se sanira u sledećem run-u
  (fajl se ne šalje ponovo, samo se premesti).

## Instalacija

1. Windows mašina koja **vidi oba UNC share-a** i backend API (LAN `192.168.64.28:3000`
   ili tunel `api.servosync2.servoteh.com`).
2. Instaliraj [Node.js 22 LTS](https://nodejs.org) (`node --version` ≥ 20.6).
3. Iskopiraj ceo folder `pdm-bridge` (npr. u `C:\ServoSync\pdm-bridge`).
4. `copy .env.example .env` pa popuni vrednosti (API, nalog, share putanje).
5. Probni run iz foldera skripte:

   ```bat
   cd C:\ServoSync\pdm-bridge
   node --env-file=.env pdm-bridge.mjs
   echo %ERRORLEVEL%
   ```

   Log ide u konzolu i u `pdm-bridge.log` (append).

Operativni redosled sa skriptama (`smoke-check.ps1` → `install-task.ps1`) i ljudskim koracima:
[§ Puštanje u pogon (P4c)](#puštanje-u-pogon-p4c--pasivni-rad-uz-legacy).

### Servisni nalog (API)

`PDM_BRIDGE_EMAIL/PASSWORD` je ServoSync korisnik čija rola nosi permisiju **`pdm.import`** —
na prod-u je `AUTHZ_ENFORCE=true`, pa bez nje svaki upload pada sa 403. `pdm.import` nose
role **`admin` i `sef`** (`src/common/authz/role-permissions.ts`); napravi zaseban servisni
nalog (npr. `pdm-bridge@servoteh.com`) sa rolom **`sef`** (minimum koji nosi permisiju; uz
potvrdu SoD rafinacije iz A-5 pre dodele) — ne koristi lični niti `admin`. ⚠️ Alternativa
(otvorena odluka P4_SPEC §8 #10): namenska mini-rola samo `pdm.import` + `pdm.read` — vidi
[§ Puštanje u pogon (P4c)](#puštanje-u-pogon-p4c--pasivni-rad-uz-legacy) korak 1. JWT važi
`JWT_EXPIRES_IN` (7d); bridge se svakako loguje na početku svakog run-a, a na 401 usred
slanja uradi jedan re-login pa ponovi fajl.

### Windows nalog (share-ovi)

Task Scheduler nalog (`/RU`) mora imati **read** na oba UNC share-a; u aktivnom modu i
**write/move** (premeštanje u `Importovano`/`Neuspelo`). Test: prijavi se kao taj nalog i
probaj `dir \\<bigbit-server>\PDMExport\XML`.

## Task Scheduler (na 5 minuta)

> **Automatizovano:** `install-task.ps1` registruje task sa SVIM podešavanjima iz ove sekcije
> (uključujući *Start in* — bez GUI koraka) — vidi
> [§ Puštanje u pogon (P4c)](#puštanje-u-pogon-p4c--pasivni-rad-uz-legacy) korak 4.
> Ispod je ručni postupak (referenca / fallback).

```bat
schtasks /Create /TN "ServoSync PDM Bridge" ^
  /TR "\"C:\Program Files\nodejs\node.exe\" --env-file=.env pdm-bridge.mjs" ^
  /SC MINUTE /MO 5 /RU <DOMEN\nalog-sa-read-na-share-ove> /RP
```

(`/RP` bez vrednosti pita za lozinku; nalogu treba i pravo *Log on as a batch job*.)

**OBAVEZAN GUI korak — `schtasks` ne ume da postavi radni folder:** otvori
`taskschd.msc` → task **ServoSync PDM Bridge** → *Properties* → *Actions* → *Edit* →
**Start in (optional) = folder skripte** (npr. `C:\ServoSync\pdm-bridge`). Bez toga je
radni folder `System32`, pa `--env-file=.env` i `pdm-bridge.mjs` ne postoje → task pada.

Preporučena podešavanja u GUI-ju:

- *General*: **Run whether user is logged on or not**;
- *Settings* → *If the task is already running*: **Do not start a new instance**
  (run-ovi ne smeju da se preklapaju);
- *Settings*: **Stop the task if it runs longer than** 1 hour (zaštita od visećeg run-a).

Alternativa bez GUI koraka — apsolutne putanje u `/TR` (relativni state/log se ionako
razrešavaju od foldera skripte, a fallback čita `.env` pored skripte):

```bat
schtasks /Create /TN "ServoSync PDM Bridge" ^
  /TR "\"C:\Program Files\nodejs\node.exe\" C:\ServoSync\pdm-bridge\pdm-bridge.mjs" ^
  /SC MINUTE /MO 5 /RU <DOMEN\nalog> /RP
```

## Smoke test (bez mreže i baze)

```bat
npm run smoke
```

(ili `node pdm-bridge.mjs --smoke`). Napravi privremeni test folder sa XML/PDF uzorcima
(po stvarnom izvozu iz §2.8), provuče ih kroz kompletnu scan/state logiku sa lažnim
transportom (dry-run, ništa se ne šalje) i proveri: prvi prolaz šalje sve; drugi ništa
(dedup); touch bez izmene ne šalje; izmenjen sadržaj šalje ponovo; aktivni mod premešta u
`Importovano`/`Neuspelo`; 403 prekida run bez settle-ovanja state-a; `sendWithRetry` nad
stvarnim oblikom PDF odgovora (uključujući `success` flag). Exit 0 = sve provere prošle.

## State fajl i reset

`pdm-bridge.state.json` je jedini lokalni „pamćenjak" poslatog. **Reset:** obriši fajl →
sledeći run skenira sve ispočetka i šalje sve što zatekne. Bezbedno je — backend dedup-uje
(XML: već uvezen koren se preskače; PDF: upsert po crtežu) — ali stvara nepotreban saobraćaj,
pa se radi samo kad je state sumnjiv ili posle promene share putanja (ključ je puna putanja).

## Exit kodovi (Task Scheduler „Last Run Result")

| Kod | Značenje |
|-----|----------|
| `0` (0x0) | sve poslato/preskočeno |
| `1` (0x1) | bar jedan fajl pao (ili folder nedostupan) — vidi `pdm-bridge.log` |
| `2` (0x2) | login/permisija neuspešna (pogrešan nalog, API nedostupan ili 403 bez `pdm.import`) |
| `3` (0x3) | konfiguracija neispravna (`.env` nije nađen / obavezna promenljiva fali) |

## Retry ponašanje

- **Mrežna greška / 5xx:** do 3 ponovna pokušaja po fajlu (backoff 2s / 8s / 30s), pa se
  fajl beleži kao *privremeni* neuspeh — sledeći run ga pokušava ponovo.
- **401:** jedan re-login pa ponavljanje fajla; ako i re-login padne → exit 2.
- **Ponovljen 401 / 403 (nalog bez `pdm.import`):** ceo run se ODMAH prekida (exit 2)
  **bez settle-ovanja** fajlova u state — auth ishod nije svojstvo sadržaja fajla; kad se
  permisija sredi, sledeći run šalje sve zatečeno.
- **Ostali 4xx:** definitivan neuspeh za taj fajl (fail-fast), run nastavlja sa ostalima.
- **HTTP 200 + `success:false`** (poslovna validacija): beleži se kao neuspeh sa
  `statusMessage`, **bez retry-a** — isti sadržaj bi opet pao; novi re-export menja hash
  i šalje se ponovo.

## Troubleshooting

- **0x3 a `.env` postoji** → task nema *Start in* (radni folder je `System32`); postavi
  *Start in* ili koristi apsolutne putanje u `/TR`.
- **0x2** → proveri email/lozinku i da li je API dostupan sa te mašine
  (`curl http://192.168.64.28:3000/api/health`).
- **403 Forbidden u logu (exit 2)** → servisni nalog nema `pdm.import` (nose je role
  `admin` i `sef` — servisnom nalogu daj `sef`); run se prekida bez settle-ovanja, pa
  posle dodele permisije sledeći run šalje sve zaostale fajlove sam.
- **`folder nedostupan`** u logu → Windows nalog task-a ne vidi UNC share; testiraj
  `dir \\server\share` pod tim nalogom. Run tada završava sa exit 1 (vidljivo u scheduler-u).
- **`nestao tokom run-a`** u logu → normalno u pasivnom modu: legacy skripta je premestila
  fajl između skena i slanja.
- **Fajl preko limita** → poruka `preko limita PDM_BRIDGE_MAX_MB`; povećaj limit u `.env`
  i obriši state (ili samo taj zapis iz `pdm-bridge.state.json`).
- Sve ostalo: `pdm-bridge.log` ima pun trag po fajlu (rezultat + `statusMessage` backenda);
  istorija uvoza je i u aplikaciji: `GET /api/v1/pdm/import-log`.

## Puštanje u pogon (P4c) — pasivni rad uz legacy

Operativni paket po [P4_SPEC §2.4](../../docs/design/P4_SPEC_pdm_intake_PREDLOG.md): bridge radi
**pasivno** paralelno sa legacy 10-min skriptama **≥ 1 nedelju**, brojevi se porede dnevno, pa tek
onda cutover ([runbook 17](../../docs/migration/17-cutover-runbook.md)). Koraci koje mora da uradi
čovek su označeni **[ČOVEK]** — skripte ništa od toga ne rade same i ništa se ne provizionira
daljinski.

| # | Korak | Ko / čime |
|---|-------|-----------|
| 1 | Servisni nalog + permisija | **[ČOVEK]** (⚠️ odluka §8 #10) |
| 2 | Izbor mašine + `.env` kredencijali | **[ČOVEK]** |
| 3 | Provera preduslova | `smoke-check.ps1` |
| 4 | Registracija Task Scheduler taska | `install-task.ps1` + **[ČOVEK]** lozinka |
| 5 | Paralelna verifikacija ≥ 1 nedelja | **[ČOVEK]** dnevno (SQL dole) |
| 6 | Rollback po potrebi | `uninstall-task.ps1` |

### 1. [ČOVEK] Servisni nalog `pdm-bridge@servoteh.com` + permisija

Admin kreira ServoSync korisnika `pdm-bridge@servoteh.com` (jaka lozinka; ne koristi se lični
nalog niti `admin`). `AUTHZ_ENFORCE=true` je živ na prod-u, pa rola MORA nositi `pdm.import`.

⚠️ **Otvorena odluka (P4_SPEC §8 #10, Nenad)** — dve opcije, odluka se donosi PRE dodele:

- **Opcija A (bez izmene koda, dostupna odmah):** rola **`sef`** — jedina ne-admin rola koja
  danas nosi `pdm.import`. Mana: nosi i širok set (tehnologija/RN write+approve, primopredaje
  approve…) — za servisni nalog je to više nego što treba (SoD potvrda iz A-5 obavezna pre dodele).
- **Opcija B (predlog spec-a, čistiji SoD):** namenska **mini-rola** samo sa `pdm.import` +
  `pdm.read` — sitna izmena `src/common/authz/roles.ts` + `role-permissions.ts` i deploy.
  **NIJE implementirana** — čeka Nenadovu odluku; ovaj paket je namerno ne uvodi unapred.

Do odluke: nalog sme dobiti `sef` (dokumentovano ograničenje); kasnija zamena role ne traži
nikakvu promenu na bridge strani (isti email/lozinka, ista permisija).

### 2. [ČOVEK] Izbor mašine i kredencijali

- Windows mašina koja **vidi oba UNC share-a** i API (kandidat: BigBit server ili mašina u istoj
  mreži — vidi „Instalacija" gore). Odluku donosi čovek — skripte NE biraju mašinu.
- Kopirati folder `pdm-bridge` (npr. `C:\ServoSync\pdm-bridge`), `copy .env.example .env`,
  popuniti: API base, email/lozinku servisnog naloga iz koraka 1, share putanje.
  `PDM_BRIDGE_MODE` ostaje `passive` (default) — **obavezno** dok legacy skripte žive.
- `.env` sadrži lozinku → nikad u git (`.gitignore` je već pokriva); NTFS prava na folder
  ograničiti na naloge kojima treba.

### 3. Provera preduslova — `smoke-check.ps1`

Iz foldera skripte, pod nalogom koji će pokretati task (ili bar jednom pod njim):

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File smoke-check.ps1
```

Proverava, **bez slanja ijednog fajla**: Node ≥ 20.6; `.env` kompletan + mod `passive`;
vidljivost share-ova (+ broj zatečenih fajlova); upisivost foldera (state/log); `GET /health`
(baza `up`); login servisnim nalogom; **probu permisije `pdm.import` bez fajla** —
`POST /v1/pdm/import` bez `file` polja: očekivan odgovor je 400 „Nedostaje XML fajl"
(guard prošao, backend odbija PRE ikakve obrade — ne nastaje ni log red), a 403 znači da rola
nema permisiju (korak 1 nije završen). Exit 0 = sve prošlo.

### 4. Registracija taska — `install-task.ps1`

Iz **admin** PowerShell-a, u folderu skripte:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File install-task.ps1 -RunAsUser DOMEN\nalog
```

Parametri: `-RunAsUser` (obavezan — Windows nalog sa read na share-ovima), `-NodeExe`
(default: auto-detekcija), `-ScriptDir` (default: folder skripte), `-IntervalMinutes`
(default 5), `-TaskName` (default `ServoSync PDM Bridge`).

- Postavlja SVE iz sekcije „Task Scheduler" bez GUI koraka: *Start in* (WorkingDirectory),
  *Do not start a new instance*, *Run whether user is logged on or not*, stop posle 1h,
  *StartWhenAvailable*.
- **[ČOVEK] unosi lozinku naloga interaktivno** (Read-Host) — ne prosleđuje se kroz fajl,
  ne ostaje zapisana nigde.
- Greška `0x80070569` pri registraciji = nalogu fali *Log on as a batch job*
  (`secpol.msc` → Local Policies → User Rights Assignment).
- **Idempotentno:** ponovno pokretanje pregazi postojeći task (`-Force` re-register) — promena
  intervala/naloga = samo ponovo pokreni skriptu.

Prvi run odmah: `Start-ScheduledTask -TaskName "ServoSync PDM Bridge"`, pa proveriti
`pdm-bridge.log` i *Last Run Result* (`Get-ScheduledTaskInfo`; exit kodovi gore).

### 5. [ČOVEK] Paralelna verifikacija ≥ 1 nedelja (runbook preduslov)

Svaki radni dan se porede brojevi uvoza i pregledaju kritične greške — dve strane:

**2.0 strana** (`ssh ubuntusrv`, pa `docker exec -it servosync-pg psql -U servosync -d servosync`):

```sql
-- XML uvozi po danu. PDF se namerno isključuje: legacy PDMXMLImportLog NE loguje
-- PDF-ove, a 2.0 ih piše u ISTU tabelu (status_message prefiks 'PDF:').
-- imported_at je bez TZ (kontejner beleži UTC) — otud konverzija u lokalni dan;
-- jednom proveri `docker exec servosync-pg date`, pa ako je već lokalno vreme
-- zameni prvi red sa: imported_at::date AS dan.
SELECT (imported_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Belgrade')::date AS dan,
       count(*)                            AS ukupno,
       count(*) FILTER (WHERE success)     AS uspesno,
       count(*) FILTER (WHERE NOT success) AS palo,
       count(*) FILTER (WHERE is_critical) AS kriticno
FROM   drawing_import_log
WHERE  lower(file_name) LIKE '%.xml'
  AND  imported_at >= now() - interval '8 days'
GROUP  BY 1
ORDER  BY 1 DESC;
```

**Legacy strana** (SSMS na `Vasa-SQL,5765`, baza `QBigTehn` — dovoljan je read-only
`bridge_reader` nalog):

```sql
SELECT CAST(l.ImportTimestamp AS date)                AS Dan,
       COUNT(*)                                       AS Ukupno,
       SUM(CASE WHEN l.Uspesno  = 1 THEN 1 ELSE 0 END) AS Uspesno,
       SUM(CASE WHEN l.Uspesno  = 0 THEN 1 ELSE 0 END) AS Palo,
       SUM(CASE WHEN l.Kriticno = 1 THEN 1 ELSE 0 END) AS Kriticno
FROM   dbo.PDMXMLImportLog AS l
WHERE  l.ImportTimestamp >= DATEADD(day, -8, GETDATE())
GROUP  BY CAST(l.ImportTimestamp AS date)
ORDER  BY Dan DESC;
```

Za dan sa razlikom — uparivanje po imenu fajla (jučerašnji dan):

```sql
-- 2.0 (psql):
SELECT file_name, success, is_critical, status_message
FROM   drawing_import_log
WHERE  lower(file_name) LIKE '%.xml'
  AND  (imported_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Belgrade')::date = current_date - 1
ORDER  BY file_name;

-- legacy (SSMS):
SELECT l.NazivFajla, l.Uspesno, l.Kriticno, l.StatusPoruka
FROM   dbo.PDMXMLImportLog AS l
WHERE  CAST(l.ImportTimestamp AS date) = CAST(DATEADD(day, -1, GETDATE()) AS date)
ORDER  BY l.NazivFajla;
```

Kritične greške (dnevno, cilj = 0): u aplikaciji PDM → tab uvoza (filter „kritično"), API
`GET /api/v1/pdm/import-log?isCritical=true`, ili psql:
`SELECT imported_at, file_name, status_message FROM drawing_import_log WHERE is_critical AND imported_at >= now() - interval '1 day';`

**Očekivane (legitimne) razlike** — ne alarmirati:

- 2.0 log broji i **ručne UI upload-ove** („Uvezi XML" dugme) — legacy ih nema;
- bridge isti sadržaj šalje **jednom** (state dedup) — legacy ume da reprocesira isti fajl
  više puta (svaki prolaz = novi log red);
- fajl koji legacy skloni **pre nego što ga bridge vidi** (kreiran neposredno pre legacy
  run-a, uz `MIN_AGE_S` prozor) — proveriti sledeći dan; ako se ponavlja, smanjiti interval.

**Kriterijum prolaza** (preduslov runbook §1): ≥ 1 kalendarska nedelja u kojoj (1) svaki
uspešan legacy XML uvoz ima pandan u `drawing_import_log` (po imenu fajla), (2) `kriticno = 0`
na 2.0 strani, (3) task nema run-ove sa *Last Run Result* `0x2`/`0x3` (auth/konfiguracija).
Neobjašnjena razlika = STOP — rešava se pre zakazivanja cutover-a.

### 6. Rollback

```bat
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall-task.ps1 -DisableOnly
```

`-DisableOnly` pauzira task (ostaje registrovan; `Enable-ScheduledTask` vraća); bez parametra
task se uklanja. Pasivni mod ništa nije pomerao ni menjao na share-ovima — legacy tok je
netaknut, rollback nema proizvodni uticaj. State fajl se namerno ne briše (ponovno uključivanje
ne šalje ponovo već poslato).

## Prelazak na aktivni mod (cutover)

Redosled iz [PLAN_primopredaja_tp_cutover.md §2.9](../../docs/design/PLAN_primopredaja_tp_cutover.md):

1. **Ugasi legacy 10-min skripte** (obe: kopiranje sa PDM servera i Access uvoz) i potvrdi
   da više ne rade — ovo je preduslov, ne opcija.
2. Pusti poslednji legacy ciklus da isprazni zaostatak; ono što ostane u folderu preuzima bridge.
3. U `.env` postavi `PDM_BRIDGE_MODE=active` (po potrebi i `PDM_BRIDGE_IMPORTED_DIR`/`PDM_BRIDGE_FAILED_DIR`).
4. Proveri da Task Scheduler nalog ima **write/move** pravo na share-ovima.
5. Isprati prvi aktivni run u `pdm-bridge.log`: uspešni fajlovi treba da se sele u
   `Importovano\`, odbijeni u `Neuspelo\`.

Povratak: vrati `PDM_BRIDGE_MODE=passive` — bridge odmah prestaje da pomera fajlove.

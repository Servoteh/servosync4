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

### Servisni nalog (API)

`PDM_BRIDGE_EMAIL/PASSWORD` je ServoSync korisnik čija rola nosi permisiju **`pdm.import`** —
na prod-u je `AUTHZ_ENFORCE=true`, pa bez nje svaki upload pada sa 403. `pdm.import` nose
role **`admin` i `sef`** (`src/common/authz/role-permissions.ts`); napravi zaseban servisni
nalog (npr. `pdm-bridge@servoteh.com`) sa rolom **`sef`** (minimum koji nosi permisiju; uz
potvrdu SoD rafinacije iz A-5 pre dodele) — ne koristi lični niti `admin`. JWT važi
`JWT_EXPIRES_IN` (7d); bridge se svakako loguje na početku svakog run-a, a na 401 usred
slanja uradi jedan re-login pa ponovi fajl.

### Windows nalog (share-ovi)

Task Scheduler nalog (`/RU`) mora imati **read** na oba UNC share-a; u aktivnom modu i
**write/move** (premeštanje u `Importovano`/`Neuspelo`). Test: prijavi se kao taj nalog i
probaj `dir \\<bigbit-server>\PDMExport\XML`.

## Task Scheduler (na 5 minuta)

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

# P4 SPEC — nativni PDM XML+PDF intake + primopredaja cutover

> **Status: POTVRĐEN ZA IMPLEMENTACIJU (Nenad, 11.07).** Dokument prepakuje
> [PLAN_primopredaja_tp_cutover.md §3 P4](PLAN_primopredaja_tp_cutover.md) posle usklađivanja sa
> STVARNIM stanjem koda na `main`-u (2026-07-11; backend HEAD `26d3538`, frontend HEAD `b605365`) —
> veći deo originalnog P4 („P4a") je već isporučen i deployovan, pa ovaj spec pokriva samo ono što
> preostaje + 4 potvrđene odluke (Nenad, 11.07) + uzvodne činjenice iz `BB Tehnologija opis-NACRTI I
> PDM BIRO.pdf`. Autoritativni operativni redosled cutover-a ostaje
> [docs/migration/17-cutover-runbook.md](../migration/17-cutover-runbook.md).

## 0. ZAKLJUČANE ODLUKE (Nenad, 11.07) — obavezujuće za implementaciju

1. **Obim/redosled:** raditi **ceo P4 redom P4b → P4c → P4d**, uključujući sporne stavke. Bez preskakanja.
2. **Kriterijum „tehnolog" (odluka #2):** `GET /handovers/technologists` + approve validacija koriste **vrstu radnika „Tehnolog"** (`worker_types.name ILIKE 'Tehnolog'`, legacy paritet `IDVrsteRadnika=1`) — zajednički helper sa `NotificationsService.resolveTechnologistWorkerIds`; `defines_approval` se napušta za ovaj kriterijum.
3. **Biro role (odluka):** **kreirati minimalne role SADA** — projektanti biroa dobijaju rolu (predlog `inzenjer` / `projektant_vodja`) sa `primopredaje.write` (kreiranje/uređivanje nacrta primopredaje). Skinuti cutover blocker. *(REŠENO 13.07.2026: 17 biro naloga kreirano uz login parnost 1.0→2.0 — vidi §8 #7.)*
4. **„Definiši sporne stavke" (odluka):** **ulazi u P4 SADA** (§6.5.4 postaje obavezan, ne opcion) — OdlukePredProvera pre-check duplikata/količina vs PDM sastavnica.
5. **„Preuzmi izradu" (odluka #4):** `POST /handovers/:id/take-over` prepiše `technologist_id` na aktera (rola Tehnolog, primopredaja SAGLASNA, nezaključana, ne-legacy-guarded) + ažurira `work_orders.worker_id`; audit kolone `technologist_assigned_at/by`. Ne pamti se prvobitno dodeljeni.

**Default-i za tehničke odluke (Negovan/Miljan — potvrditi, NE blokiraju start):**
- ODLUKA #3 (PDM = nativni XML+PDF intake, ne direktan SQL) — **ratifikovana** Nenadovom odlukom #3; ažurirati `ODLUKE.md #3/#12`.
- PDF blob = **`bytea`** u `drawing_pdfs` (kao trenutno) — Negovan ratifikuje.
- `draft_id` kolona — **odloženo**, zadržati postojeću `resolveDraftContext` heuristiku dok Negovan ne odluči.
- `production_deadline` (rok pri odobravanju) = **nullable** (opcion) dok Miljan ne potvrdi da je obavezan; `draft_type` labele iz legacy („Parcijalna predaja delova/podsklopova" / „Glavni sklop").

---

## 1. Sažetak i granica sa već isporučenim

### 1.1 Već postoji na `main`-u (git-verifikovano) — P4 to NE dira

| Oblast | Šta je isporučeno | Commit (backend, osim gde piše FE) |
|---|---|---|
| **XML parser + `POST /pdm/import`** | `pdm-xml-parser.ts` (xmldoc/sax, eksplicitni UTF-8, atributi sa razmacima, rekurzivni `references` walk, fixture = stvarni `1126982_B.xml`); legacy-paritet validacije `ProveriXMLFajl` (obavezni `id`/`Oznaka`/`Reference Count`, `State` odobreno/izmena bez revizije case-insensitive, ≤20 znakova, prazna revizija→`A`, sve-ili-ništa po fajlu); upsert `drawings` + delete/recreate BOM ivica + relink starih revizija; `Nabavka` flag = slovo u `Oznaka` (bez upisa u artikle — otvorena odluka §11.1); root dedup (broj+revizija) → ceo fajl skip; log u `drawing_import_log`; poslovna greška = HTTP 200 + `success:false` | `7d42f24` |
| **PDF intake `POST /pdm/pdf-import`** | upsert u `drawing_pdfs` po `(drawingNumber, revision)` iz imena fajla `{Broj}_{Rev}.pdf` (paritet `PDM_PDFCommon.bas`); crtež NE mora postojati (PDF sme pre XML-a, kao legacy `PDM_PDFCrtezi`); magic-bytes provera; log u isti `drawing_import_log` (prefiks `PDF:`) | `7d42f24` |
| **Watcher/bridge servis** | `tools/pdm-bridge/pdm-bridge.mjs` — zero-dependency Node single-shot + Windows Task Scheduler; **PASSIVE mod default** (nikad ne pomera/briše fajl — legacy 10-min skripte nastavljaju paralelno); sha256 state dedup; auth greška prekida run bez settle-ovanja; ACTIVE mod (`Importovano`/`Neuspelo` move, paritet `PremestiXMLFile`) rezervisan za cutover; README + smoke test; `.env.example` | `bd40b87` |
| **Backfill primopredaja iz `tRN`** | derivacioni syncer `handover-derivation.syncer.ts`: `tRN` redovi sa `IDPrimopredaje>0` → `drawing_handovers` (provenance `legacy_rn_id` UNIQUE, NULL=nativni red; nativni id — `id=IDRN` svesno ODBIJEN zbog kolizije posle setval); audit iz `tSaglasanRN`/`tLansiranRN` (OUTER APPLY TOP 1); tehnolog iz `tRN.SifraRadnika` samo za statuse 1/3 (semantika `spPromeniStatusPrimopredaje`); remap `work_orders.drawing_handover_id` (draft-id → derivirani handover id); registrovan POSLE work_orders | `cc90f50` |
| **Legacy guard mutacija** | `HANDOVER_LEGACY_GUARD` (default true): approve/reject/launch/prepare/return nad deriviranim redovima → 409 (odobravanje do cutover-a u QBigTehn); i WO-level launch propagacija poštuje guard; gasi se na cutover (`false` + compose up) | `cc90f50` |
| **Tok tehnologa (P1)** | `approve` sa obaveznim `technologistId` → `drawing_handovers.technologist_id` (app-only kolona, dokumentovana devijacija); `return-to-pending` (409 ako RN postoji); `prepare-work-order` („Otkucaj TP" — idempotentno, RN u statusu SAGLASAN); `launch` reuse pripremljenog RN-a; advisory lock; JWT `workerId` u audit kolone (status/launch/approval) — **konzumira se** | `c35b72d` |
| **Oba mehanizma lansiranja (odluka #1 — VEĆ ŽIVI)** | Tok A: `POST /handovers/:id/launch`; Tok B: „Unos radnog naloga" — `POST /work-orders` (blanko, `handoverStatusId=0`) → `approve` → `POST /work-orders/:id/launch` koji **propagira status 3 + lock na izvornu primopredaju** preko `drawingHandoverId` (advisory lock, uslovni update, klonovi isključeni) | `c35b72d` |
| **Štampa crteža (P3)** | print-bundle (pdf-lib) po formatu papira, draft- i handover-level | `4c27965`, FE `80d7436` |
| **Kartica TP zbir (P2)** | `operations[]` agregati na `/card` | `30facb7`, FE `268953d` |
| **Dorade „10 tačaka"** | clone-variant („Prepiši isti postupak", variant MAX+1 → oživljen stale-RN guard), CAM priority endpoint, customer prefill, strukture delete/activate, notifikacije (škart/dorada → tehnolozi + projektant crteža; nova primopredaja → tehnolozi; `app_notifications` + zvonce) | `72922bc`, `65f6f70`, `26d3538`, FE `b605365`, `f7a0de3` |
| **FE intake UI** | „Uvezi XML / Uvezi PDF" dugmad na PDM import-log tabu (multi-file, sekvencijalno); „Legacy" badge + sakrivene mutacije za derivirane redove; tab „Odobrene" sa TP typing flow-om i technologist picker-om | FE `645eea0`, `ceb7958` |
| **Cutover runbook** | `docs/migration/17-cutover-runbook.md` (freeze → poslednji ciklus → finalni sync → verifikacija → setval → split → deploy → smoke) | `bd40b87` |

**Zaključak:** od originalnog PLAN §3 P4 kôd-delovi su isporučeni. Preostaju: **operativno puštanje
bridge-a u pasivni rad**, **split sync mape**, **dopunska skripta za tabele bez syncer-a +
verifikacioni report**, **odluke** (`draft_id`, ODLUKA #3 revizija, blob storage) — plus **novo** iz
4 potvrđene odluke i uzvodnih činjenica (dole).

### 1.2 Šta prepakovani P4 DODAJE (novo, još ne postoji u kodu)

| # | Stavka | Izvor | Odeljak |
|---|---|---|---|
| 1 | Lista tehnologa = radnici vrste **„Tehnolog"** (ne `defines_approval`) | Odluka #2 | §6.3 |
| 2 | **„Preuzmi izradu"** — takeover zaduženja na saglasnoj primopredaji | Odluka #4 | §6.4 |
| 3 | **Rok izrade pri ODOBRAVANJU** (ne tek pri lansiranju) | Uzvodna činjenica 2 | §6.5.1 |
| 4 | **Tip nacrta** vidljiv/upotrebljiv (Parcijalna predaja vs Glavni sklop) | Uzvodna činjenica 1 | §6.5.2 |
| 5 | **Biro permisije** — kreiranje nacrta za projektante + preduslovi stavke (ODOBREN + PDF + poslednja revizija) | Uzvodna činjenica 3 | §6.5.3 |
| 6 | Split sync mape (bigbit-trajni / qbigtehn-privremeni) | PLAN §3 P4 | §7.2 |
| 7 | Dopunska skripta za tabele bez syncer-a + verifikacioni SQL report | PLAN §2.9 t.3 | §5.3, §7.3 |
| 8 | Operativno puštanje pdm-bridge (servisni nalog, instalacija, paralelna verifikacija) | Odluka #3 | §2.4 |
| 9 | (opciono) „Definiši sporne stavke" — §7.2 pre-check duplikata | Uzvodna činjenica 4 | §6.5.4 |

---

## 2. Watcher/bridge servis (odluka #3 — potvrđena, isporučen kôd, preostaje pogon)

### 2.1 Arhitektura (isporučeno, `bd40b87`)

Odluka #3 (Nenad, 11.07): **2.0 dobija sopstveni watcher nad XML/PDF folderima; Access radi
PARALELNO do cut-off-a; obe aplikacije aktivne istovremeno je OK.** Isporučena realizacija:
`tools/pdm-bridge/` — jedan `.mjs` fajl, nula zavisnosti (Node ≥ 20.6 built-in
`fetch`/`FormData`/`crypto`), *single-shot* proces koji Windows Task Scheduler pokreće na 5 min
(paralela legacy 10-min ritmu, koji je i u legacy-ju bio eksterni OS task — u VBA nema tajmera;
lanac je `XMLImport.bas` → `PDMXMLParser.bas` → `PDM_Common.bas` + `Autoexec_PokreniParsiranje`).
Bridge skenira share-ove i šalje multipart na `POST /v1/pdm/import` i `POST /v1/pdm/pdf-import`
(uz `sourcePath` za log provenance).

Namerno NIJE rezidentni servis niti deo NestJS backenda: backend je u Dockeru na Ubuntu serveru i
ne vidi Windows UNC share-ove; bridge živi na Windows mašini koja vidi i share-ove i API — isti
obrazac kao `servoteh-bridge`.

### 2.2 Coexistence sa Access-om — KRITIČNA pravila (implementirana; ovde ratifikovana)

Legacy Access uvoz posle obrade radi `fso.MoveFile` u `Importovano\`/`Neuspelo\` (ne briše) — to je
**jedini mehanizam koji „troši" fajl iz ulaznog foldera** i tako ostaje do cutover-a:

1. **`PDM_BRIDGE_MODE=passive` (default, OBAVEZAN dok legacy živi):** bridge fajl samo ČITA — nikad
   move/delete. Kad ga legacy skloni, bridge ga više ne vidi. Nema otimanja oko fajlova.
2. **Sopstvena evidencija „obrađeno"** (tri nezavisna sloja idempotencije):
   - lokalni state `pdm-bridge.state.json`: ključ = puna putanja → `{size, mtimeMs, sha256, sentAt,
     result}`; isti `(ime,size,mtime)` → skip bez čitanja; isti `sha256` → skip; **izmenjen sadržaj
     = novi re-export → šalje se ponovo**; atomičan upis posle svakog fajla;
   - backend XML dedup: root `(drawingNumber, revision)` već u `drawings` → ceo fajl skip
     (uspešan, ne-kritičan log) — paritet legacy `UveziPDM_XMLFajl`; konkurentan uvoz istog fajla
     (bridge + ručni upload) pada na `uq` constraint → poslovni ishod „već postoji", ne 500;
   - backend PDF dedup: upsert po `(broj, revizija)` — ponovljeno slanje je bezopasno.
   - trajna istorija je `drawing_import_log` (`GET /pdm/import-log`, UI tab) — state fajl sme da se
     obriše (rescan je bezbedan, samo pravi saobraćaj).
3. **Poslovno odbijen fajl** (`success:false`) se za isti sadržaj ne šalje ponovo; auth greška
   (403/ponovljen 401) prekida ceo run BEZ settle-ovanja state-a.
4. **`PDM_BRIDGE_MODE=active` TEK kad se legacy skripte ugase** (cutover korak 7): bridge preuzima
   move u `Importovano\`/`Neuspelo\` (paritet `PremestiXMLFile`), kolizija imena → sufiks timestamp.

### 2.3 Folderi i konfiguracija

- `PDM_BRIDGE_XML_DIR` = share koji legacy skripta puni sa PDM servera (BigBit server ekvivalent
  `C:\PDMExport\XML\`, CFG `PDM_XMLFolder`); `PDM_BRIDGE_PDF_DIR` = `\\pdm-pdf\VASADATA`.
- Sve env promenljive su već u `tools/pdm-bridge/.env.example` (API base, servisni nalog, mode,
  `MIN_AGE_S=30` — zaštita od fajla koji se još piše, `MAX_MB`, state/log putanje). Backend strana:
  `HANDOVER_LEGACY_GUARD` već u `backend/.env.example`. **Nema novih env promenljivih u ovom spec-u**
  osim ako se usvoji §6.4 (nema ni tamo) — postojeća pravila pokrivaju sve.

### 2.4 PREOSTAJE u P4 (operativno, bez novog koda)

- [ ] Servisni nalog `pdm-bridge@servoteh.com` sa permisijom `pdm.import` (nose je `admin` i `sef`;
      README preporučuje `sef` uz SoD potvrdu). ⚠️ Alternativa za odluku: namenska mini-rola samo sa
      `pdm.import` + `pdm.read` (čistiji SoD; malo koda u `role-permissions.ts`).
- [ ] Izbor Windows mašine (vidi oba share-a + API), instalacija po README (Task Scheduler na 5 min,
      *Start in* folder, *Do not start a new instance*).
- [ ] **Paralelna verifikacija ≥ 1 nedelja** (runbook preduslov): brojevi u `drawing_import_log` se
      poklapaju sa legacy `PDMXMLImportLog`; dnevni pregled kritičnih grešaka.

---

## 3. Parser + `POST /pdm/import` — referentni ugovor (isporučeno; bez izmena u P4)

Radi potpunosti spec-a, pravila koja su implementirana i testirana (`pdm-xml-parser.spec.ts`,
`pdm-import.service.spec.ts` — fixture je stvarni `1126982_B.xml`):

- **Encoding:** UTF-8 BEZ XML deklaracije i BEZ BOM-a → eksplicitni `toString("utf8")` + defanzivno
  skidanje BOM-a; numerički entiteti (`&#xA;` u `ZiliS`) rešeni sax-om; obavezan trim vrednosti.
- **Struktura:** `<xml><transactions><transaction …>` → `<document id pdmweid>` →
  `<configuration name quantity>` → `<attribute name value/>` + ugnježdeni `<references>`
  (rekurzija; isto podstablo se ponavlja pod više roditelja).
- **Atributi sa razmacima** (`Approved by`, `Document Number`, `Reference Count`) — legacy
  `Replace(' ','_')` → `Attr_*` mapiranje preneto kao direktan attr-map.
- `id` (broj crteža) je **string** (`K00693`, `EGE2`); `State` poređenje **case-insensitive**
  (`odobreno` / `izmena bez revizije`); prazna `Revision` → `"A"`; max 20 znakova.
- **Datumi haotični** (5+ formata u istom fajlu) → best-effort parse, nikad hard-fail; `Weight`
  prazan/nevalidan → legacy `-1` semantika.
- **Dedup:** dokumenti po `(docId, revizija)` — prva pojava nosi atribute; BOM ivice po
  `(parent, child, rev)` — prva pojava nosi količinu; validacija SVE-ILI-NIŠTA po fajlu.
- **BOM:** delete/recreate komponenti SAMO za dokumente koji su u fajlu roditelji; relink starih
  revizija u BOM-u svih OSTALIH roditelja (port `ZameniIDCrtezaStareRevizijeUKomponentama`,
  normalizacija revizije prazan→`A` svuda).
- `isProcurement` = `Oznaka` sadrži ne-cifru (legacy pravilo; `MakeOrBuy` je **nepouzdan** —
  informativno). ⚠️ ostaje na Negovanu (§8 #4). `RN` atribut = referenca uz ručnu potvrdu (ume biti
  `0001`, ne broj predmeta) — bez auto-mapiranja predmeta, kao PLAN §2.8.
- Bez upisa u artikle (otvorena odluka BACKEND_RULES §11.1 — ne implementira se).

P4 ovde **ne menja ništa**; jedini follow-up je posmatranje pariteta tokom paralelne nedelje (§2.4).

---

## 4. PDF intake (isporučeno; blob odluka za ratifikaciju)

- Model: `drawing_pdfs` (Was: `PDM_PDFCrtezi`), PK `(drawing_number, revision)`, `pdf_binary` =
  **`bytea` u Postgres-u** — 1:1 paritet legacy blob tabeli. Nezavisan od `drawings` (PDF sme stići
  pre XML-a). Čitanje: `GET /pdm/drawings/:id/pdf/content` (stream), print-bundle čita
  `octet_length` bez učitavanja bloba, spajanje drži jedan blob u memoriji (200MB guard).
- ⚠️ **Blob storage odluka (§8 #3):** de facto je već `bytea` (isporučeno i radi; i 1.0 viewer po
  playbook-u §4.4 čita iz `drawing_pdfs`). Predlog: **ratifikovati `bytea`** — prednosti:
  transakcioni integritet, jedan backup, bez novog infra dela; mana: rast baze (pratiti; ako pređe
  ~10-20 GB razmotriti separatni tablespace ili izmeštanje u fajl-sistem u 3.0). Ne menjati u P4.
- Ime fajla: sufiks posle POSLEDNJEG `_` sa 1–3 znaka = revizija, inače revizija `A`; eksplicitna
  form polja (`drawingNumber`/`revision`) imaju prednost — ručni upload pokriva izuzetke.

---

## 5. Backfill primopredaja + tabele bez syncer-a

### 5.1 Backfill iz `tRN` (isporučeno, `cc90f50` — referentna semantika)

Legacy primopredaja NE živi u `PrimopredajaCrteza` (prazna i na živom MSSQL-u) nego kao atributi
`tRN` reda (`IDPrimopredaje`, `IDStatusPrimopredaje` 0/1/2/3, `SifraRadnikaPrimopredaje`); audit u
`tSaglasanRN`/`tLansiranRN`; `spPromeniStatusPrimopredaje` menja status 0/1/2 grupno po
`IDPrimopredaje`, status 3 samo za taj `IDRN`, i upisuje tehnologa u `tRN.SifraRadnika`. Derivacioni
syncer je tačno to preneo (vidi §1.1). Svaki run je pun prolaz (~3.4k redova); legacy je izvor
istine do cutover-a (guard štiti nativne mutacije); nativni redovi (`legacy_rn_id IS NULL`)
strukturno nedostižni za upsert.

> **Fix `b064a96` (E2E proba na produ, 13.07.2026):** ID-kolizija iz ove priče se materijalizovala —
> native `drawing_handovers.id` se sudarao sa legacy `work_orders.drawing_handover_id` (nosi **ID
> NACRTA iz `tRN`**, opseg 1..3446, 3349 RN-ova) → launch native primopredaje 409 na tuđem RN-u.
> `submit()` sekvenca sada radi floor `GREATEST(MAX(id), MAX(legacy ref), 9999)` → native
> primopredaje od **10000+** do cutover remapa.

### 5.2 ⚠️ `draft_id` kolona (odluka Negovan — §8 #2)

`drawing_handovers` i dalje do nacrta dolazi heuristikom (`resolveDraftContext`). Predlog: app-only
kolona `draft_id Int?` (+ `idx_`), koju pišu `handover-drafts.submit()` (nativni tok) i derivacija
(iz `tRN.IDPrimopredaje` = `IDNacrtPrim` — meki FK, batch-resolve po legacy-read pravilu). Dodatni
argument od uzvodne činjenice 1: **tip nacrta** (`handover_drafts.draft_type`) postaje pouzdano
dostupan na primopredaji preko join-a umesto heuristike. Bez potvrde — ne raditi.

### 5.3 Tabele lanca BEZ syncer-a — jednokratna dopunska skripta (NOVO u P4)

Provereno u `sync-map.generated.ts` (nema source-a) — finalni uvoz ih mora dopuniti:

| 2.0 tabela | Legacy izvor | Napomena |
|---|---|---|
| `work_order_machined_parts` | `tPDM` | stavke RN — mašinski delovi |
| `work_order_blanks` | `tPLP` | stavke RN — pripremci/limovi |
| `work_order_nonstandard_parts` | `tPND` | stavke RN — nestandardni delovi |
| `work_order_approvals` | `tSaglasanRN` | audit saglasnosti (derivacija ga čita, ali istorija treba i u 2.0 tabeli) |
| `drawing_plan_items` | `PDM_PlaniranjeStavke` | stavke planiranja |
| `drawing_handover_pdfs` | `PrimopredajaPDFCrteza` | verovatno prazna (kao parent) — proveriti COUNT pri implementaciji |

Lookup-ovi `drawing_statuses` / `handover_draft_statuses` su rešeni seed-om u `c35b72d` — otpada iz
originalnog spiska. Realizacija: **privremeni syncer-i po postojećem obrascu**
(`customer.syncer.ts`: iscrpno mapiranje, null-ovanje nerazrešivih FK, skip-ne-abort) registrovani
samo za finalni run — dobijaju isti verifikacioni izveštaj kao ostali, a brišu se sa splitom mape
(§7.2). Alternativa (ad-hoc skripta van sync modula) se NE preporučuje — gubi obrazac i report.

Uz skriptu ide **verifikacioni SQL report** (runbook preduslov): COUNT/MAX(id) po tabeli legacy vs
2.0, MAX RN ordinal po predmetu, FK orfani, broj PDF blobova.

---

## 6. Oba toka lansiranja + tok tehnologa (odluke #1, #2, #4 + uzvodne dopune)

### 6.1 Odluka #1 (potvrđena): OBA mehanizma lansiranja ostaju — stanje: VEĆ ŽIVI

- **Tok A — „Dokument primopredaje":** submit nacrta → `drawing_handovers` (status 0) → Miljan
  `approve` (+tehnolog, →1) → „Otkucaj TP" `prepare-work-order` (RN bez lansiranja) → kucanje TP →
  `POST /handovers/:id/launch` (→3, lock, launch red; reuse pripremljenog RN-a).
- **Tok B — „Unos radnog naloga":** `POST /work-orders` (blanko, `handoverStatusId=0`) → CRUD
  operacija → `approve` (→1) → `POST /work-orders/:id/launch` (→3) koji, ako RN ima
  `drawingHandoverId`, **propagira status 3 + lock na izvornu primopredaju** (advisory lock, uslovni
  update — dupli launch pada na 409; klonovi isključeni). Paritet legacy statusa
  `tRN.IDStatusPrimopredaje` (0 U obradi / 1 Saglasan / 2 Odbijeno / 3 Lansiran) je 1:1.

**P4 posao: nikakav kôd** — samo se u spec/docs fiksira da se nijedan tok NE gasi (ranija dilema
„biraš jedan" je zatvorena). Smoke na cutover-u testira OBA (runbook korak 8 pokriva tok A; dodati
i tok B u smoke listu).

### 6.2 Ko sme šta (postojeće, nepromenjeno)

`approve`/`reject`/`launch`/`return-to-pending` = `primopredaje.approve` (SEF/ADMIN);
`prepare-work-order` = `rn.write`. `Worker.definesApproval`/`definesLaunch` ostaju drugi gate za
RN-nivo approve/launch — **ne dirati** (odluka #2 menja samo izbor tehnologa, ne approve gate).

### 6.3 Odluka #2 (potvrđena): lista tehnologa = svi radnici vrste „Tehnolog" — IZMENA

Danas `GET /handovers/technologists` i `approve()` validacija koriste `defines_approval=true`
(`handovers.service.ts:232-277`) — to je pogrešan kriterijum. Legacy: `tRadnici.IDVrsteRadnika=1`.
2.0 mapiranje: `workers.worker_type_id` → `worker_types` (Was: `tVrsteRadnika`; na prod-u id 1,
name `Tehnolog`).

- **Izmena 1:** `technologists()` → `active: true` + `workerTypeId IN (SELECT id FROM worker_types
  WHERE name ILIKE 'Tehnolog')` — **tačno isti kriterijum kao**
  `NotificationsService.resolveTechnologistWorkerIds()` (`notifications.service.ts:82-95`; match po
  imenu, ne hardkodovan id; dva batch upita, bez required JOIN-a — legacy-read pravilo).
  Refaktor: izvući zajednički helper (npr. `src/common/workers/technologist-criteria.ts`) da lista,
  approve validacija, notifikacije i §6.4 takeover koriste JEDAN izvor istine.
- **Izmena 2:** `approve()` validacija tehnologa: `definesApproval` → vrsta „Tehnolog" + `active`.
- Poruka greške ažurirati (referiše `defines_approval`); DTO komentar u
  `dto/approve-handover.dto.ts` takođe.
- Test dopune: postojećih 25+ testova za approve pokriva oblik — menja se mock kriterijum.

### 6.4 Odluka #4 (potvrđena): „Preuzmi izradu" — NOVO

Legacy paritet: `UPDATE tRN SET SifraRadnika` — tehnolozi „jedni drugima imaju pravo da pomažu".
Raspored ostaje: Miljan dodeljuje tehnologa pri odobravanju; posle toga bilo koji tehnolog može
zvanično preuzeti zaduženje.

**Endpoint:** `POST /api/v1/handovers/:id/take-over` (UI dugme „Preuzmi izradu" na tabu „Odobrene"
i na detalju primopredaje).

- **Guard-ovi:** JWT + `primopredaje.write` (TEHNOLOG je ima; KONTROLOR/MENADZMENT je takođe imaju
  → drugi gate je obavezan) **+ servisna provera: `actor.workerId` mora biti aktivan radnik vrste
  „Tehnolog"** (isti helper iz §6.3; `workerId` 0/null → 422 „nalog nije vezan za radnika").
  Namerno NE nova permisija — worker-type gate je precizniji od role-gate-a i 1:1 sa odlukom.
- **Preduslovi:** `statusId=1` (SAGLASAN — posle odobravanja, pre lansiranja), `isLocked=false`,
  `assertNotLegacyGuarded` (409 za derivirane redove dok `HANDOVER_LEGACY_GUARD` živi — nativni
  upis bi pregazio sledeći derivacioni run; do cutover-a se preuzimanje radi u QBigTehn-u).
- **Efekat (jedna transakcija + isti advisory lock kao prepare/launch):**
  1. `technologist_id := actor.workerId` — polje se PREPIŠE, prvobitno dodeljeni se NE pamti
     (odluka #4);
  2. audit kolone (dole);
  3. ako preko back-linka postoji pripremljen RN (`findHandoverWorkOrder`) koji NIJE
     lansiran/zaključan → `work_orders.worker_id := actor.workerId` (legacy paritet: `tRN` JESTE
     RN, pa `SifraRadnika` menja i „vlasnika" naloga; bez ovoga bi kartica RN-a pokazivala starog
     tehnologa).
- **Idempotentnost:** ako je `technologist_id` već = `actor.workerId` → 200 `{alreadyOwner: true}`
  bez upisa.
- **Konkurentnost:** uslovni `updateMany` po `(id, statusId=1, isLocked=false)` — dva konkurentna
  preuzimanja: poslednji pobeđuje (poslovno prihvatljivo — „pomažu jedni drugima"), ali launch/lock
  u međuvremenu obara na 409.
- **Audit (mali, po odluci):** dve app-only kolone na `drawing_handovers` (isti dokumentovani
  presedan kao `technologist_id`/`legacy_rn_id`; red u `schema-rename-map.md`):
  - `technologist_assigned_at DateTime?` — kada je tekući tehnolog dodeljen/preuzeo;
  - `technologist_assigned_by_id Int?` — ko je izveo dodelu (kod approve = šef; kod take-over =
    sam preuzimalac).
  Pišu ih **i `approve()` i `take-over`** — jedan mehanizam pokriva „ko/kada" za obe putanje.
  Tip kolona: `Timestamp(6)` konzistentno sa sestrinskim kolonama tabele (BACKEND_RULES Timestamptz
  pravilo važi za NOVE tabele — ovde se ne meša tip unutar postojeće).
- **Opciono (predlog, ne obaveza):** `app_notifications` red prethodnom tehnologu („NN je preuzeo
  izradu za primopredaju X") — emit van transakcije, best-effort, obrazac iz `26d3538`.
- **Frontend:** dugme na tabu „Odobrene" (vidljivo kad je red SAGLASAN, nije legacy, nije moj);
  osvežava listu + „Za tehnologa" filter.

### 6.5 Uzvodne dopune (BB Tehnologija opis — NACRTI I PDM BIRO)

#### 6.5.1 Rok izrade se popunjava pri ODOBRAVANJU (ne pri kreiranju nacrta)

Danas `dueDate` postoji samo na `launch` (→ `work_orders.production_deadline`). Legacy: rok unosi
inženjer koji odobrava. Izmena:

- `ApproveHandoverDto` += `dueDate?: string` (ISO; ista `parseDateParam` validacija kao launch);
- nova app-only kolona `drawing_handovers.production_deadline DateTime?` (isti presedan; upisuje je
  approve, prazni return-to-pending zajedno sa undo-om tehnologa);
- `createHandoverWorkOrder` (prepare i launch tok) propagira handover rok u
  `work_orders.production_deadline`; eksplicitni `dueDate` na launch-u i dalje ima prednost
  (override);
- ⚠️ Miljan potvrđuje da li je rok pri odobravanju OBAVEZAN (predlog: opciono polje u P4, pooštriti
  posle potvrde);
- derivacioni syncer: `tRN` nosi i rok (kolona roka se već sinkuje u `work_orders`) — backfill
  handover roka iz RN reda je nice-to-have, ne blokira (derivirani redovi su ionako guard-ovani).

#### 6.5.2 Tip nacrta (Parcijalna predaja / Glavni sklop)

`handover_drafts.draft_type` (SmallInt, default 0) **već postoji** i DTO-i ga primaju — ali UI ga ne
izlaže i vrednosti nisu potvrđene (spec pretpostavlja 0=Glavni sklop, 1=Pojedinačni sklop,
2=Podsklopovi; PDF govori o „Parcijalna predaja (delovi/podsklopovi)" vs „Glavni sklop").
P4: lookup labela (konstanta u kodu, ne nova tabela) + polje u „Novi nacrt" dijalogu + kolona/badge
na listi nacrta i na primopredaji (preko draft konteksta; čisto tek sa `draft_id` — §5.2).
⚠️ Tačne labele/vrednosti potvrđuje biro (§8 #6). Auto-BOM-expand za Glavni sklop postoji u
MODULE_SPEC-u — NE širiti obim ovde ako već radi; samo tip učiniti vidljivim. *(Nadgradnja: pun
**AUTO-BOM isporučen 13.07.2026, proba r1** — izbor glavnog sklopa automatski izlistava sve pozicije
iz sastavnice, `useBom` flat rekurzivno; nabavni `is_procurement` tiho preskočeni; neodobreni u
PDM-u preskočeni uz upozorenje; sam sklop = prva stavka `isMain`.)*

#### 6.5.3 Kreiranje nacrta = bilo koji inženjer iz biroa + preduslovi stavke

- **Permisije:** `POST /handover-drafts` traži `primopredaje.write`, koju danas nose
  admin/sef/tehnolog/kontrolor/menadzment — ~~projektanti nemaju nijednu 2.0 rolu~~ *(REŠENO
  13.07.2026, §8 #7: biro role aktivirane sa 2.0 permisijama + 17 naloga otvoreno; projektanti rade
  na `/nacrti`, gate `primopredaje.write` — ODLUKE #33)*. Prvobitni predlog minimalnog seta:
  `pdm.read`, `primopredaje.read`, `primopredaje.write`, `tehnologija.read`,
  `rn.read`, `directory.read`.
- **Preduslovi stavke (legacy pravilo):** u nacrt ulazi samo crtež koji je **ODOBREN** (`State`),
  **ima PDF** i **poslednja je revizija**. Danas se ništa od toga ne validira pri dodavanju stavke.
  Predlog: pri add-item — hard 422 za ne-odobren `pdm_status`; upozorenje (ne blokada) za
  nedostajući PDF i ne-poslednju reviziju (PDF ume da kasni za XML-om; ručni izuzeci postoje).
  ⚠️ Potvrda biro/Miljan da li PDF/revizija treba da budu hard blokada.

#### 6.5.4 „Definiši sporne stavke" (pre-check duplikata) — OPCIONO u P4

Kolone postoje (`pre_check_duplicate`, `pre_check_draft_id`, `pre_check_work_order_id`,
`decision_action`, `decision_date_time` na `handover_draft_items` — legacy `PredProveraDuplikat`/
`OdlukaAkcija`), ali logika §7.2 iz MODULE_SPEC_nacrti_primopredaje **nije implementirana**
(eksplicitno van skopa u `handover-drafts.service.ts:85`). Semantika: kad je deo već puštan na
istom RN/predmetu, uporedi količine sa PDM sastavnicom i traži odluku projektanta.
Predlog: **P4-opciono / kandidat za P5** — nije preduslov cutover-a (legacy tok radi bez toga za
nove unose; backfill NE dira ove kolone). Ako Nenad želi pre cutover-a, ide kao zaseban pod-paket.
Napomena za intake: PDM funkcije „Gde se koristi" i „Sastavnica" već postoje u 2.0
(`GET /pdm/drawings/:id/where-used`, `/bom`) — pre-check ima sve building blokove.

---

## 7. Cutover — redosled, split sync mape, verifikacija

### 7.1 Redosled (autoritativno: runbook 17; ovde sažetak + rizici iz PLAN §2.9)

Freeze legacy (van radnog vremena, revoke write / sklanjanje ikona) → poslednji ciklus 10-min
skripti + ručni uvoz zaostalih → **finalni force/full sync** (reset kursora lanca u `bb_sync_state`
— pažnja: kursor `drawing_handovers` je pomeran fallback-om; force re-import `work_orders` MORA ići
kao `["work_orders","drawing_handovers"]` da remap prođe posle) + dopunska skripta §5.3 →
**verifikacioni report 1:1** → `alignIdSequence` setval nad SVIM tabelama lanca (napomena: do
cutover remapa `submit()` već drži floor `GREATEST(MAX(id), MAX(legacy ref), 9999)` na
`drawing_handovers` — fix `b064a96`, vidi §5.1) → split mape +
gašenje derivacionog syncer-a + deploy → `HANDOVER_LEGACY_GUARD=false` + bridge `active` + gašenje
legacy skripti → **smoke oba toka lansiranja istog dana** → prva nedelja: dnevni
`drawing_import_log` + bridge log.

Ključni rizici (nepregovarani): (1) ponovni sync posle nativnih upisa TIHO gazi 2.0 redove —
redosled je zakon; (2) RN numeracija nastavlja legacy niz samo ako je finalni uvoz kompletan;
(3) rollback trivijalan do splita, posle zahteva ručno prenošenje — zato smoke istog dana;
(4) bez ODLUKE #3 revizije (⚠️) se ne kreće.

### 7.2 Split sync mape (NOVO u P4 — kôd)

`sync-map.generated.ts` danas drži ~62 tabele u jednoj mapi. Predlog:

- uvesti eksplicitan skup `QBIGTEHN_CHAIN_ENTITIES` (pored postojećeg `OWNED_PRODUCTION_TABLES` u
  `table-ownership.ts`) — lanac koji se gasi: `drawings`, `drawing_components`,
  `drawing_assemblies`, `drawing_import_log`, `drawing_pdfs`, `drawing_plans` (+`drawing_plan_items`
  iz §5.3), `handover_drafts`, `handover_draft_items`, `drawing_handovers` (derivacija),
  `work_orders`, `work_order_operations`, `work_order_operation_images`, `work_order_launches`
  (+§5.3 tabele), `tech_processes`, `tech_process_documents`, `labels`, `part_locations`,
  `work_order_components`, `work_order_item_components` + jednokratno seed-ovani šifarnici
  (workers, worker_types, operations, work_units, positions, part_quality_types, machine_access,
  production_item_groups, planner_*);
- BigBit-trajni deo (komitenti, predmeti/`projects`, artikli, magacini, MRP_*, cenovnik, robna
  dokumenta, registry/CFG…) ostaje netaknut — vasa-SQL se ne gasi;
- na cutover: lanac se izbacuje iz registracije u `SyncService` (uklanjanje iz mape/modula, ne
  „skip flag" — mrtav kôd se briše), derivacioni syncer se gasi; tačan spisak se pri implementaciji
  izvodi iz `sync-map.generated.ts` i unakrsno proverava sa `docs/migration` sync mapom.

### 7.3 Verifikacioni report (NOVO u P4 — skripta uz §5.3)

Jedan SQL/TS report (može `tools/` skripta): po tabeli lanca COUNT + MAX(id) legacy vs 2.0; MAX RN
ordinal po predmetu; FK orfani (meki FK-ovi batch-resolve lanca); broj PDF blobova
(`PDM_PDFCrtezi` vs `drawing_pdfs`); handover statusna distribucija (0/1/2/3) legacy vs derivirano.
Izlaz se prilaže uz runbook korak 4 — odstupanja se rešavaju PRE nastavka.

---

## 8. Otvorena pitanja / odluke

| # | Pitanje | Ko | Predlog / default |
|---|---|---|---|
| 1 | **Revizija ODLUKE #3**: „PDM = trajan direktan SQL na međusloj" → „nativni XML+PDF intake u 2.0" (ODLUKE.md #3/#12 još kaže direktan SQL) | Negovan (potpis) | usvojiti nativni intake — kôd već živi i radi paritetno |
| 2 | `draft_id` kolona na `drawing_handovers` (zamena `resolveDraftContext` heuristike; nosi i tip nacrta) | Negovan | DA — mala migracija, čisti semantiku (§5.2) |
| 3 | Blob storage za PDF: ostaje `bytea` u PG? | Negovan/Nenad | DA, ratifikovati postojeće; revizija tek u 3.0 ako baza preraste (§4) |
| 4 | `Nabavka` flag: legacy pravilo (slovo u `Oznaka`) vs `MakeOrBuy` | Negovan | zadržati legacy pravilo (MakeOrBuy dokazano nepouzdan) |
| 5 | Undo odobrene kad RN postoji: danas blokada (409) — treba li storno-RN varijanta? | Miljan/Negovan | zadržati blokadu (ručno brisanje RN-a pa undo); storno tek na dokazanu potrebu |
| 6 | `draft_type` vrednosti/labele (Glavni sklop / Parcijalna…) | biro (preko Miljana) | potvrditi 0/1/2 mapiranje pre UI labela (§6.5.2) |
| 7 | Aktivacija biro rola (`projektant_vodja`/`inzenjer` → 2.0 permisije) + nalozi | Nenad/Negovan | ✅ **REŠENO 13.07.2026** — 17 biro naloga (Milorad Jerotić=`projektant_vodja`, ostali `inzenjer`, svi worker-linked) uz **login parnost 1.0→2.0** (svi 1.0 korisnici → 2.0 nalog sa ISTOM 1.0 lozinkom: 27 update + 31 insert po SSO JIT mapiranju; backup `users_pwhash_backup_20260713`; servisni nalozi netaknuti); dejan.cirkovic i jovan.blagojevic bez 1.0 naloga → privremena lozinka |
| 8 | Rok pri odobravanju: obavezan ili opcion? | Miljan | opcion u P4, pooštriti po potvrdi (§6.5.1) |
| 9 | PDF/poslednja-revizija preduslov stavke nacrta: hard ili soft? | biro/Miljan | State=hard, PDF+revizija=soft upozorenje (§6.5.3) |
| 10 | Servisni nalog bridge-a: rola `sef` ili namenska mini-rola samo `pdm.import`? | Nenad | mini-rola (čistiji SoD) — sitna izmena `role-permissions.ts` (§2.4) |
| 11 | §7.2 „sporne stavke": u P4 ili P5? | Nenad | P5 (nije preduslov cutover-a) (§6.5.4) |
| 12 | Notifikacija prethodnom tehnologu pri „Preuzmi izradu"? | Nenad | DA, best-effort (jeftino uz postojeći modul) (§6.4) |

---

## 9. Predlog redosleda poslova u P4 (pod-paketi)

P4a (isporučeno i deployovano) je nulta tačka. Preostalo:

| Paket | Sadržaj | Obim | Zavisnosti |
|---|---|---|---|
| **P4b — tok tehnologa dopune** | §6.3 lista tehnologa po vrsti (zajednički helper) + §6.4 „Preuzmi izradu" (migracija 3 app-only kolone: `technologist_assigned_at/by`, `production_deadline`; endpoint + FE dugme) + §6.5.1 rok pri odobravanju + §6.5.2 tip nacrta u UI + §6.5.3 biro permisije i preduslovi stavke | **M** (2–3 dana sa testovima) | odluke §8 #6–#9; ništa ne čeka cutover |
| **P4c — bridge u pogon (pasivno)** | §2.4: servisni nalog (+eventualna mini-rola §8 #10), instalacija na Windows mašinu, Task Scheduler; zatim **≥1 nedelja paralelne verifikacije** brojeva vs `PDMXMLImportLog` | **S** kôd/ops + 1 nedelja kalendarski | ničim blokiran — krenuti ODMAH (kalendarski je na kritičnom putu cutover-a) |
| **P4d — cutover pripreme u kodu** | §5.3 privremeni syncer-i za tabele bez syncer-a + §7.3 verifikacioni report + §7.2 split mape (skup + uklanjanje na dan) + `draft_id` ako #2 prođe | **M** (2–3 dana) | odluka §8 #2; izvršava se pre zakazivanja dana |
| **P4e — cutover izvršenje** | runbook 17 korak-po-korak (freeze → finalni sync+dopuna → report → setval → split deploy → guard off + bridge active → smoke OBA toka lansiranja) | **S** kôd (flip-ovi) + 1 dan ops | P4b+P4c+P4d gotovi; ⚠️ ODLUKA #3 potpisana; obuka biro/Miljan/tehnolozi |

Paralelizacija: P4c krenuti prvi (kalendarska nedelja); P4b i P4d mogu paralelno posle odluka.

---

## 10. Kako se P4 promenio u odnosu na PLAN §3 P4 (posle usklađivanja sa git-om)

**Izbačeno iz P4 jer je VEĆ isporučeno (git-verifikovano):**
- `POST /pdm/import` + parser sa celim §2.8 ugovorom i legacy validacijama → `7d42f24`;
- PDF intake (`/pdm/pdf-import` → `drawing_pdfs`) → `7d42f24`;
- watcher/bridge za XML+PDF foldere (pasivni/aktivni mod, state, retry, README, smoke) → `bd40b87`;
- backfill `drawing_handovers` iz `tRN` atributa (derivacioni syncer + remap + legacy guard) → `cc90f50`;
- runbook `docs/migration/17-cutover-runbook.md` → `bd40b87`;
- (van originalnog P4, ali zatvara ranije ⚠️ iz §2.9): variant bump rešen kroz clone-variant
  (`72922bc`), JWT `workerId` konzumiran u upisima (`c35b72d`), seed lookup-ova (`c35b72d`),
  notifikacije (`26d3538`).

**Ostalo iz originalnog P4 (i dalje u ovom spec-u):** split sync mape; dopunska skripta za tabele
bez syncer-a (+report); odluke `draft_id` i revizija ODLUKE #3; operativno puštanje bridge-a.

**Novo (nije bilo u PLAN §3 P4) — zbog 4 potvrđene odluke i uzvodnih činjenica:**
- odluka #1 formalno zatvara dilemu „jedan tok" → OBA toka lansiranja ostaju (kôd već podržava oba,
  smoke lista proširena tokom B);
- odluka #2 → izmena kriterijuma liste/validacije tehnologa (`defines_approval` → vrsta „Tehnolog");
- odluka #3 → ratifikacija isporčenog pasivnog coexistence modela + pogon (P4c);
- odluka #4 → NOVI endpoint „Preuzmi izradu" (`take-over`) + mali audit;
- uzvodne činjenice → rok pri odobravanju, tip nacrta u UI, biro permisije + preduslovi stavke,
  (opciono) sporne stavke.

---

## 11. Izvori (commit hashevi i fajlovi na koje se spec oslanja)

Backend commiti: `7d42f24` (pdm import), `cc90f50` (derivacija+guard), `bd40b87` (bridge+runbook),
`c35b72d` (tok tehnologa P1), `4c27965` (print-bundle), `30facb7` (kartica agregati), `72922bc`
(clone-variant/CAM), `65f6f70` (strukture), `26d3538` (notifikacije). Frontend: `645eea0` (import
UI + legacy badge), `ceb7958` (tab Odobrene), `80d7436` (print dijalog), `b605365` (Realizacija +
zvonce), `f7a0de3` (strukture/RN UI).

Ključni fajlovi: `src/modules/pdm/pdm-import.service.ts`, `pdm-xml-parser.ts`, `pdm.controller.ts`;
`src/modules/handovers/handovers.service.ts`, `handovers.controller.ts`,
`handover-drafts.service.ts`; `src/modules/work-orders/work-orders.service.ts`;
`src/modules/sync/syncers/handover-derivation.syncer.ts`, `sync-map.generated.ts`,
`table-ownership.ts`; `src/modules/notifications/notifications.service.ts`;
`src/common/authz/role-permissions.ts`; `prisma/schema.prisma` (`Drawing*`, `Handover*`,
`WorkOrder*`, `Worker*`); `tools/pdm-bridge/*`; `docs/design/PLAN_primopredaja_tp_cutover.md`;
`docs/design/PLAN_dorade_2026-07-10.md`; `docs/migration/17-cutover-runbook.md`;
`docs/ODLUKE.md`; `_analiza/pdm-xml-primeri/1126982_B.xml`;
`_analiza/servosync_docs/MODULE_SPEC_nacrti_primopredaje.md`.

---

## 12. Napomena o statusu

**Ovo je PREDLOG spec-a — ništa se ne implementira dok Nenad ne potvrdi** (a stavke označene ⚠️ dok
ih ne potvrde Negovan odnosno Miljan/biro). Dokument namerno NE menja postojeće autoritativne
docove (PLAN, runbook, MODULE_SPEC-ovi) — posle potvrde se relevantni delovi prenose u njih, a
paketi P4b–P4e kreću redom iz §9.

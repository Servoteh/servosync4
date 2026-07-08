# Module Spec: Tehnologija / Tehnološki postupci (TP) — ServoSync 2.0

| | |
|---|---|
| **Modul** | Tehnologija — tehnološki postupci, operacije, barkod-praćenje izvršenja |
| **Verzija spec** | 1.0 (2026-07-08) |
| **Faza** | 2.0 — **pilot domenski modul** ([ROADMAP](../ROADMAP.md)) |
| **Izvor** | QBigTehn: kod [migration/08 §1](../migration/08-qbigtehn-vba-domain-map.md), UI `Izvoz/Forme`, SQL logika [migration/05](../migration/05-qbigtehn-sqlserver-logic.md), RBAC [RBAC_RLS_PREDLOG](RBAC_RLS_PREDLOG.md) |
| **Status** | Spec spreman za implementaciju; **read-only prvo**, mutacije posle §11 odluka |

> Prvi domenski modul 2.0. Bira se jer: podaci su već sinhronizovani, tebi je prioritet
> (tehnolog/CNC/šef), i pilot je za RBAC. **Read-only deo (lista + kartica + operacije) ne čeka §11 odluke**
> jer ništa ne piše; mutacije (zatvaranje postupka, dorada/škart) dolaze posle potvrde vlasništva tabela
> ([BACKEND_RULES §3](../BACKEND_RULES.md) — proizvodne tabele su ServoSync vlasništvo).

## 1. Domenski model (Prisma, već u šemi)

| Tabela | Was | Uloga | Ključna polja |
|---|---|---|---|
| `tech_processes` | tTehPostupak | tehnološki postupak (jedan red = operacija na postupku) | `workerId` (tehnolog), `projectId`, `identNumber`, `variant`, `operationNumber`, `workCenterCode`, `pieceCount`, `isProcessFinished`, `qualityTypeId`, `reworkOperationId`, `signature` |
| `operations` | tOperacije | katalog radnih centara/operacija | `workCenterCode` (unique), `workCenterName`, `withoutProcess`, `significantForFinishing`, `usesPriority`, `isSkippable` |
| `machine_access` | tPristupMasini | **ACL: radnik ↔ radni centar** | `workerId`, `workCenterCode` |
| `work_order_operations` | tStavkeRN | operativna razrada RN | `operationNumber`, `workCenterCode`, `workDescription`, `toolsFixtures`, `setupTime`, `cycleTime`, `priority` |
| `tech_process_documents` | tTehPostupakDokumentacija | dokumentacija/skice/CNC uz operaciju | `fileLink`, `fileName` |
| `workers` | tRadnici | radnik (login karticom) | `cardId`, `username`, `workerTypeId`, `definesApproval`, `definesLaunch` |
| `part_quality_types` | tVrsteKvalitetaDelova | vrste kvaliteta (dorada/škart) | enum `0=dobar, 1=dorada, 2=škart` |

**Ključna veza:** `RJgrupaRC` (workCenterCode) je labav string ključ svuda u legacy-ju → u 2.0 **pravi FK** ka `operations`.
CNC programi trenutno nemaju tabelu — predlog `cnc_programs` (RBAC §7.3, otvoreno).

## 2. Ekrani (iz stvarnog QBigTehn dizajna `Izvoz/Forme`)

| Ekran (legacy forma) | Obrazac | Svrha | Ključne akcije/polja |
|---|---|---|---|
| **BarKod unos** (`BarKod_Unos`) | touch-panel / kiosk | radnik skenira karticu + postupak, evidentira komade | `ProcitajBarKod`, dugme „Preuzmi BarKod iz clipboard-a", „Zatvaram nalog drugog radnika"; polja `LogovaniRadnik`, `IdentBroj`, checkbox `SimbolRadnik/Postupak/Operacija`; RecordSource `tTehPostupak` |
| **BarKod status** (`BarKod_Status`) | kiosk read | prikaz unetog postupka | `NapravljenoKomada`/`PotrebnoKomada`, `IdentBroj`, `Operacija`, `RokIzrade`, `NazivDela` |
| **Kartica TP** (`Kartica TehPostupka` + Podforma) | master-detail | pregled postupka + stavke izvršenja (komadi, vreme) | nav dugmad; podforma sumira `NapravljenoKomada`, `UtrosenoVreme` |
| **Unos operacije** (`UnosOperacije`) | forma/lista | CRUD katalog operacija/radnih centara | „&Nova operacija"; checkbox `BezPostupka`, `ZnacajneOperacijeZaZavrsen`, `KoristiPrioritet`, `PreskocivaOperacija`; `RJgrupaRC`, `NazivGrupeRC` |
| **Pristup mašinama** (`PristupMasinama`, `RadniciPoMasinama`) | master-detail | dodela radnik ↔ radni centar (ACL) | `SifraRadnika` + `NazivGrupeRC` |
| **Kritični postupci** (`frmKriticniPostupci`) | lista (bojena) | pregled kritičnih postupaka | severity 1/2/3 (žuta/narandžasta/crvena) |
| **Dokumentacija** (`tTehPostupakDokumentacija`) | prilozi | PDF/skice/CNC po operaciji | `fileLink`, `fileName` |
| **Pregled po prioritetima/operacijama** (`PregledOperacijaPoPrioritetima`, `PPS_PregledPoOperacijama`) | lista | radni redosled | filter po radnom centru/prioritetu |

**UI obrasci za 2.0 dizajn sistem:** kiosk/touch ekran (barkod, velika dugmad), master-detail (kartica + podforma),
grid unos (operacije), bojena lista po severity-ju (kritični postupci) — vidi `frontend` repo, `docs/DESIGN_SYSTEM.md`.

## 3. Poslovna pravila (🔴 = mora preživeti port; izvor [08 §1/§10](../migration/08-qbigtehn-vba-domain-map.md), [05](../migration/05-qbigtehn-sqlserver-logic.md))

1. **🔴 Barkod format:** `PredmetID:IdentBroj:Varijanta:Operacija:RJgrupaRC` (separatori `:`, fallback dekodiranje). `AGDesifrujBarKod`.
2. **🔴 Zatvaranje postupka** (`OznaciDaJeZavrsenPostupak`): provera količina → `isProcessFinished=true` + `finishedAt` + **`priority=255`** (skinuto sa prioriteta). Premašaj količine → greška (ne zatvara). **U 2.0 = jedna DB transakcija.**
3. **🔴 DORADA/ŠKART** (`ftDodatiPostupkeZaDoraduIliSkart`): zatvoreni redovi sa količinom dorade → **novi nalog** (`identNumber` sufiks `-D`n dorada / `-S`n škart) + poruka planeru/tehnologu. Kvalitet enum `0=dobar, 1=dorada, 2=škart`.
4. **🔴 Autorizacija operacije:** radnik vidi/radi samo operacije čiji je `workCenterCode` u `machine_access` za tog radnika (join). Logovani radnik sme zatvarati tuđi postupak samo uz `definesApproval`/`additionalPrivileges`.
5. **Prioritet operacije:** `100` ako `operations.usesPriority=true`, inače `255`.
6. **Sumiranje** (komadi/vreme): u 2.0 **SUM na DB/API**, ne u UI (legacy sabira u podformi).
7. `significantForFinishing` operacije određuju kad je postupak „završiv"; `isSkippable` = preskočiva.
8. **🔴 Noćni auto-close (iz [zvaničnog uputstva](../migration/11-bb-tehnologija-uputstvo.md)):** nezatvoreni
   nalozi se **automatski zatvaraju u 23h** → u 2.0 scheduled job (`@nestjs/schedule`).
9. **⚠️ Ograničenje za popraviti:** legacy „detaljan pregled gotovosti" i „dinamika izrade" **NE rade za ceo
   sklop** — 2.0 dodaje agregaciju gotovosti po sklopu (rekurzivni BOM CTE).

## 4. RBAC (iz [RBAC_RLS_PREDLOG §3.1](RBAC_RLS_PREDLOG.md))

- **TEHNOLOG** i **CNC_PROGRAMER:** pun pristup celom modulu (TP, operacije, dokumentacija, šifarnici) — **bez row-scopinga unutar modula**.
- **ŠEF:** sve to + odobravanje/otključavanje; menja `machine_access`, može izmeniti/potpisati završen TP.
- **RADNIK:** vidi svoje operacije **po `machine_access`**; unos rada (barkod) na dozvoljene radne centre.
- Zaključan/završen TP (`isProcessFinished`): menja samo ŠEF/ADMIN.
- Potpis TP: autor (`workerId`) ili ŠEF; da li i CNC_PROGRAMER — otvoreno (RBAC §7.2).

## 5. API (predlog, `/api/v1/tehnologija/*`)

| Endpoint | Metod | Opis | Faza |
|---|---|---|---|
| `/tech-processes` | GET | lista + filter (predmet/radnik/radni centar/status) | read-only ✅ |
| `/tech-processes/:id` | GET | kartica + stavke izvršenja (sumirano) | read-only ✅ |
| `/tech-processes/critical` | GET | kritični postupci (severity) | read-only ✅ |
| `/operations` | GET/POST/PUT | katalog operacija/radnih centara | read ✅ / write (TEHNOLOG+) |
| `/machine-access` | GET/POST/DELETE | ACL radnik↔radni centar | ŠEF |
| `/tech-processes/:id/documents` | GET/POST | dokumentacija/CNC prilozi | TEHNOLOG/CNC |
| `/barcode/scan` | POST | evidencija izvršenja (barkod) | **mutacija — posle §11** |
| `/tech-processes/:id/finish` | POST | zatvaranje postupka (transakcija) | **mutacija — posle §11** |
| `/tech-processes/:id/rework` | POST | dorada/škart → novi nalog | **mutacija — posle §11** |

**Redosled implementacije:** (1) read-only lista+kartica+operacije+kritični → odmah upotrebljivo tehnolozima;
(2) `machine_access` + dokumentacija; (3) barkod/finish/rework mutacije po §11.1 (cache/overlay) odluci.

**🎯 Prioritet ekrana (iz [zvaničnog uputstva §sažetak](../migration/11-bb-tehnologija-uputstvo.md)):** najkorišćeniji
su **Pregled RN (statusi delova)**, **Pregled TP (učinak po radniku)**, **Detaljan pregled gotovosti** i
**Kartica TP** — graditi ih prve. **❌ NE graditi** (vlasnik izričito): zaseban „Lansiranje" ekran (lansiranje je
akcija u Primopredaji), „Razlike verzija 1/2", „Unos predmeta".

## 6. Zamke iz legacy-ja (NE prenositi)

- SQL injection (string-concat) → parametrizovan Prisma.
- Ručni autonumber (`DMax+1`) → sekvenca.
- Bez transakcije (delimičan uspeh) → DB transakcija za finish/rework.
- Global singleton `BBTehn` (kontekst sesije) → request-scoped kontekst/DTO.
- `RJgrupaRC` kao string ključ → FK ka `operations`.
- Plaintext lozinka radnika → hash; `cardId` = barkod login.

## 7. Otvorena pitanja

1. **§11.1** (cache/overlay) — proizvodne tabele su ServoSync vlasništvo; potvrditi pre mutacija.
2. **`cnc_programs` tabela** — uvesti ili CNC ostaje prilog uz TP (RBAC §7.3).
3. **CNC_PROGRAMER potpisuje TP?** (RBAC §7.2).
4. Da li se `machine_access` seed-uje iz QBigTehn ili unosi iznova.

# Module Spec: Radni nalozi (RN) — ServoSync 2.0

| | |
|---|---|
| **Modul** | Radni nalozi (RN) — zaglavlje + stavke, workflow saglasnost→lansiranje |
| **Verzija spec** | 1.0 (2026-07-08) |
| **Faza** | 2.0 (posle Tehnologije) |
| **Izvor** | QBigTehn: kod [migration/08 §2](../migration/08-qbigtehn-vba-domain-map.md), UI `Izvoz/Forme`, [MODULE_SPEC_structures](MODULE_SPEC_structures.md), RBAC [RBAC_RLS_PREDLOG](RBAC_RLS_PREDLOG.md) |
| **Status** | Spec spreman; read-only prvo, mutacije + workflow posle §11 |

> **Ključna legacy činjenica:** `tRN` je **istovremeno tehnološki postupak i zaglavlje radnog naloga**
> (PK `IDRN`). Stavke su u **4 tabele**: `tStavkeRN` (operacije), `tPND` (nabavni delovi), `tPLP`
> (limovi/profili), `tPDM` (montažni delovi). U 2.0 razmotriti **jedinstvene work_order stavke sa tipom**
> umesto 4 fizičke tabele (otvoreno — potvrda Neša/Negovan).

## 1. Domenski model (Prisma, već u šemi)

| Tabela | Was | Uloga |
|---|---|---|
| `work_orders` | tRN | zaglavlje RN + TP (`workerId`, `isLocked`, `handoverWorkerId`, `signature`) |
| `work_order_operations` | tStavkeRN | operacije RN-a (`operationNumber`, `workCenterCode`, `toolsFixtures`, `setupTime`, `cycleTime`, `priority`) |
| `work_order_launches` | tLansiranRN | ko/kada lansirao (`createdByWorkerId`) |
| `work_order_approvals` | tSaglasanRN | ko/kada odobrio (`createdByWorkerId`) |
| `work_order_machined_parts` | tPDM | montažni delovi |
| `work_order_blanks` | tPLP | limovi/profili |
| `work_order_nonstandard_parts` | tPND | nabavni/nestandardni delovi |
| `work_order_components` / `work_order_item_components` | | RN↔RN / RN↔artikal veze |

## 2. Ekrani (iz stvarnog dizajna `Izvoz/Forme`)

| Ekran | Obrazac | Ključne akcije (iz koda) |
|---|---|---|
| **Unos RN** (`UnosRN`, 22 dugmeta) | master-detail | Novi dokument · **Zaključavanje** · **„Prepiše stavke/delove/limove"** (`DugmeKopirajPostupke`) · **„Prepiši isti postupak"** · Lager lista · „Sa skicama" (report) · Obriši postupak · navigacija · Requery |
| **Unos stavki RN** (`UnosStavkiRN`) | podforma (grid) | „Nova stavka" · „Skica" · prebaci u clipboard; polja `AlatPribor`, `Cena(Tpz)`, `Tk`, `Operacija`, `OpisRada`, `Prioritet`, `txtBarKod`, suma `Ukupno = Tpz + Tk×Komada` |
| **Saglasnost** (`RNSaglasanStatus`) | popup | odobravanje; polja `DIVUnos`/`PotpisUnos` (odobravač), `DIVIspravke`/`PotpisIspravka` |
| **Lansiranje** (`RNLansiranStatus`) | popup | lansiranje; iste `DIV`/`Potpis` kolone |
| **Kreiraj nove naloge za predmet** (`KreirajNoveNalogeZaIDPredmet`) | staging + bulk | bulk-clone svih naloga projekta u novi projekat sa koeficijentom količine |
| **Izbor naloga za prepisivanje** (`IzborNalogaZaPrepisivanje`) | dijalog | izbor izvornog RN za kopiranje stavki |
| **Pregled stavki RN** (`PregledStavkiRN`) | lista | read-only pregled |

**UI obrasci:** master-detail (RN + stavke-grid), popup workflow (saglasnost/lansiranje), staging tabela za bulk-clone.

## 3. Poslovna pravila (🔴 = obavezan port; [08 §2/§10](../migration/08-qbigtehn-vba-domain-map.md))

1. **🔴 STATE MACHINE (port 1:1):** RN mora biti **SAGLASAN pre LANSIRANJA** (nikad obrnuto). Preduslovi za saglasnost:
   sačuvan + `stavki > 0` + korisnik u grupi (`Saglasnost`/`Admins`/`definesApproval`). Lansiranje jednostavnije (bez forsirane provere operatera).
2. **🔴 Jedinstvenost `identNumber`:** jedinstven **osim** za isti (`projectId`, `drawingNumber`, `variant`, `revision`).
3. **🔴 Zaključavanje** (`isLocked`): zaključan/lansiran RN → nema izmene/brisanja (`AllowEdits/Deletions=false` u legacy-ju).
   Brisanje blokirano ako `isLocked` ili nalog već u proizvodnji.
4. **🔴 DORADA/ŠKART child nalog** (`KreirajNalogDoradeIliSkarta`): `identNumber` sufiks `-D`n (dorada, kvalitet=1) ili
   `-S`n (škart, =2); kopira zaglavlje + **sve 4 vrste stavki**. Prioritet `100` ako `usesPriority` else `255`.
5. **🔴 Bulk-clone za predmet** (`spKreirajSveStavkeRNZaNoviIDPredmet`): koeficijent množi `Komada`; dvofazno
   (staging sa `Kreirati` checkbox → SP po nalogu). U 2.0 → **transakcioni clone endpoint** (ne temp-tabela).
6. **Kopiranje postupka** (`spRN_PrepisiStavkeIzNaloga(NoviIDRN, IzIDRN)`) — samo kad je cilj prazan.
7. **Saglasnost re-potvrda:** toggle saglasnosti resetuje operatera (mora ponovo). `DIV`/`Potpis` = ko je odobrio.
8. Suma stavke: `Ukupno = Tpz + (Tk × Komada)` (priprema + komad×broj).
9. **⚠️ Legacy bug (NE prenositi):** `PrepisiZaglavljePostupka` piše `TezinaObrDela` u `TezinaNeobrDela`.

## 4. RBAC ([RBAC_RLS_PREDLOG §3.2](RBAC_RLS_PREDLOG.md))

- **Lansiranje** (`work_order_launches`): permission `rn.launch` = rola ∈ {ŠEF, TEHNOLOG, ADMIN} **I** `Worker.definesLaunch=true`.
- **Odobravanje** (`work_order_approvals`): `rn.approve` = `Worker.definesApproval=true` (dozvoljeno samo za `workerType ∈ {Tehnolog, Inženjeri}`; `definesLaunch ⇒ definesApproval`).
- **Rola daje mogućnost, `Worker` flag daje ovlašćenje** — oba se proveravaju.
- ŠEF: pun rad + odobravanje/lansiranje; TEHNOLOG: W (odobrava uz flag); KONTROLOR/RADNIK: R (+ unos rada po `machine_access`).

## 5. API (predlog, `/api/v1/work-orders/*`)

| Endpoint | Metod | Opis | Faza |
|---|---|---|---|
| `/work-orders` | GET | lista + filter | read-only ✅ |
| `/work-orders/:id` | GET | zaglavlje + 4 vrste stavki | read-only ✅ |
| `/work-orders/:id/items` | GET/POST/PUT | operacije (stavke) | read ✅ / write posle §11 |
| `/work-orders` | POST | nov RN | posle §11 |
| `/work-orders/:id/approve` | POST | saglasnost (guard: stavki>0, flag) | posle §11 |
| `/work-orders/:id/launch` | POST | lansiranje (guard: saglasan, flag) | posle §11 |
| `/work-orders/:id/lock` | POST | zaključavanje | posle §11 |
| `/work-orders/:id/copy-from/:sourceId` | POST | kopiranje stavki (cilj prazan) | posle §11 |
| `/work-orders/:id/rework` | POST | dorada/škart child nalog | posle §11 |
| `/projects/:id/bulk-clone` | POST | bulk-clone naloga predmeta (koeficijent) | posle §11 |

## 6. Zamke iz legacy-ja (NE prenositi)

- Global singleton `RNP` (aktivni RN kontekst, lazy-load) → request-scoped.
- 4 fizičke tabele stavki → razmotriti jedinstvene stavke sa tipom (0=operacija, 1=PND, 2=PDM, 3=PLP…).
- Ručni autonumber, string-concat SQL, bez transakcije → sekvenca/Prisma/transakcija.
- Bug `TezinaObrDela`→`TezinaNeobrDela` (ne reprodukovati).

## 7. Otvorena pitanja

1. **§11.1** — vlasništvo proizvodnih tabela (mutacije).
2. **Jedinstvene stavke sa tipom vs 4 tabele** — potvrda Neša/Negovan.
3. Da li `KONTROLOR` učestvuje u odobravanju/kontroli RN pre lansiranja.
4. Bulk-clone: koeficijent po nalogu ili po stavci.

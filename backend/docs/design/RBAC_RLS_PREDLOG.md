# Predlog: jedinstveni RBAC/„RLS" model za ServoSync 2.0 (kompatibilan sa 1.0)

> **Status: PREDLOG — čeka potvrdu (Negovan / Nesa).** Ništa odavde se ne implementira dok odluka
> ne bude zapisana u [BACKEND_RULES.md](../BACKEND_RULES.md) (§11/§12 proces).
>
> **Cilj:** da 2.0 od prvog dana ima model prava koji je **nadskup** modela iz ServoSync 1.0
> (`servoteh-plan-montaze`), tako da 3.0 integracija bude *mapiranje*, a ne redizajn autorizacije.
> Autorizacija je najveći pojedinačni rizik 3.0 (293+ RLS politika + 238 SECURITY DEFINER fn,
> ocena 5/5 u [migration/03](../migration/03-planmontaze-complexity-profile.md)).
>
> Izvori: `servoteh-plan-montaze/docs/RBAC_MATRIX.md` (auto-generisan snapshot), `docs/SECURITY.md`,
> `sql/schema.sql` + 346 migracija; za 2.0: `prisma/schema.prisma`, [ROADMAP.md](../ROADMAP.md),
> [BACKEND_RULES.md](../BACKEND_RULES.md), MODULE_SPEC_structures.md. Datum analize: 2026-07-04.

---

## 1. Šta ServoSync 1.0 stvarno ima (inventura)

### 1.1 Brojke — i važno upozorenje

| Metrika | Zvanično (RBAC_MATRIX.md) | Realno (živa baza) |
|---|---|---|
| Tabele sa RLS | 99 | **~140+** |
| RLS politike | 293 | **~360+** |
| SECURITY DEFINER fn | 238 | 238+ |
| `USING(true)` SELECT politike | 55 | 55+ |
| `TO anon` politike | 0 | 0 |

⚠️ **Generator matrice (regex) sistematski preskače tri cele grupe**: (1) CMMS/Održavanje jezgro
(`maint_work_orders`, `maint_incidents`, `maint_machines`, `maint_assets`, `maint_parts`…) jer
politike nemaju `TO authenticated` klauzulu; (2) ceo modul **praćenja proizvodnje**
(`supabase/migrations/…pracenje_proizvodnje_init.sql`, ~53 politike / ~38 tabela — prave se
dinamički kroz `EXECUTE format(...)`); (3) **SCADA/Energetika** (`scada_*`). Pri 3.0 migraciji
obavezno povući `pg_policies` sa žive Supabase baze (upit stoji u RBAC_MATRIX.md §6).

### 1.2 Role u 1.0 (finalni CHECK constraint na `user_roles.role`)

`admin · menadzment · leadpm · pm · hr · poslovni_admin · projektant_vodja · inzenjer · viewer · magacioner · cnc_operater` (+ legacy `user`, ne koristi se u pravilima)

Plus **odvojen** CMMS role sistem: `maint_user_profiles.role` enum = `operator · technician · chief · management · admin`.

### 1.3 Dimenzije scopinga (ovo je srž kompleksnosti, ne broj rola)

Model 1.0 = **rola × per-projekat × managed_sub_departments × override flagovi**:

| Dimenzija | Mehanizam u 1.0 | Primer |
|---|---|---|
| Globalna rola | `user_roles.project_id IS NULL` | admin, hr |
| Per-projekat rola | `user_roles.project_id = <uuid>` (samo pm/leadpm) | `has_edit_role(project_id)` |
| Upravljana pododeljenja | `user_roles.managed_sub_department_ids INT[]` | menadzment vidi samo svoje pododeljenje u Kadrovskoj |
| Per-user override flagovi | `plan_montaze_readonly`, `kadrovska_access`, `kadrovska_hide_contracts` | rola daje, flag oduzima/dodaje |
| Vlasništvo reda | `auth.uid()` / `lower(email)` kolone (`submitted_by`, `autor_user_id`, `uploaded_by`…) | zahtevi za GO, izveštaji montaže |
| Učesništvo | `is_sastanak_ucesnik(sastanak_id)` | sastanci vidljivi samo učesnicima + menadžmentu |
| Pristup mašini | CMMS `operator` vidi samo dodeljene mašine (`assigned_machine_codes`) | održavanje |
| Email allowlist | `kadr_grid_editor_allowlist` + konstante | grid editori, GO admin |

### 1.4 Dvanaest obrazaca politika u 1.0 (za prevod u 2.0 mehanizme)

| # | Obrazac 1.0 | Gde | Prevod u 2.0 (NestJS) |
|---|---|---|---|
| 1 | read-all-authenticated (`SELECT USING(true)`) | cache/šifarnici/plan/sastanci-select (55+) | samo `JwtAuthGuard`, bez row filtera |
| 2 | read-all + admin-write | departments, holidays, kategorije | `@Roles(ADMIN)` na mutacijama |
| 3 | `has_edit_role([project])` write | plan montaže, sastanci, PB | permission `modul.write` + project-scope provera |
| 4 | kadrovska-scoped select | employees, absences, contracts, work_hours | query-scope: managed-departments ∪ own |
| 5 | admin-only (sve operacije) | zarade, PII dece, audit log | `@Roles(ADMIN)` na celom resursu |
| 6 | hr-or-admin (+poslovni_admin) | sertifikati, lekarski, notif config | `@Roles(ADMIN, HR, POSLOVNI_ADMIN)` |
| 7 | owner-only (`auth.uid()`) | lajkovi, fajlovi, izveštaji montaže | query-scope: `createdById = user.id` |
| 8 | own-email submitter | zahtevi GO/slobodni dani | query-scope: own ∪ manages |
| 9 | participant-scoped | sastanci SELECT | query-scope: join na učesnike ∪ menadžment |
| 10 | module-manager write | reversi, lokacije, plan proizvodnje, PB, CMMS | permission `modul.write` po rolama modula |
| 11 | **no-client-write** (`USING(false)`) | history/audit/counter tabele | tabele piše samo servis (bez public endpointa) |
| 12 | admin/management-only read | sync outbox, logovi | `@Roles(ADMIN, MENADZMENT)` na GET |

### 1.5 Ostalo što 3.0 mora da reprodukuje (da se ne zaboravi)

- **Privilegovani RPC-ovi** (238 SECURITY DEFINER): odobravanja GO, payroll, reversi izdavanja,
  premeštanja lokacija… → postaju NestJS servisne metode u transakciji, uz proveru role u telu.
- **Audit**: `audit_row_change()` trigger na 9 osetljivih tabela + `kadr_audit_log`; RLS: read admin,
  write niko → u 2.0 već planirani `audit_log` interceptor (BACKEND_RULES §8).
- **Storage authz** po bucket-u (sastanci-arhiva, employee_documents…) → MinIO/S3 presigned + ista
  permission provera u aplikaciji.
- **PII zaštita**: guard trigeri (JMBG/banka), maskirani view-ovi (`v_employees_safe`),
  `security_invoker=on` na per-employee view-ovima; immutability zarada.
- **service_role bypass** (edge funkcije) → u 2.0 interni servisi; paziti na atribuciju u auditu.

---

## 2. Predlog kanonskog kataloga rola (2.0 + rezervisano za 3.0)

> **⚠️ PREVAZIĐENO 2026-07-08 → [AUTHZ_UNIFIED.md](AUTHZ_UNIFIED.md) je IZVOR ISTINE.** Objedinjeni katalog
> (1.0 taksonomija + 2.0) je u AUTHZ_UNIFIED §2 i u kodu (`src/common/authz/roles.ts`). Dve izmene u odnosu na
> tabelu ispod: (1) konvencija je **lowercase** (`admin`/`sef`/`cnc_programer`), ne UPPERCASE; (2) dodate role
> iz 1.0 prod koje su ovde falile — **`tim_lider`, `monter`, `proizvodni_radnik`** (2.0 `RADNIK` = `proizvodni_radnik`,
> jedan ključ). Tabela ispod se zadržava kao obrazloženje prava po ulozi (i dalje važi), ali imena čitaj u lowercase.

Konvencija 2.0: **rola je String, lowercase snake_case** ([BACKEND_RULES §2.2](../BACKEND_RULES.md); prevaziđeno „velikim slovima"). Katalog je **nadskup**:
2.0 aktivira proizvodne role, a imena rola iz 1.0 su rezervisana odmah (da 3.0 ne dobije koliziju).

| Kanonska rola | Poreklo | Aktivna u | Opis / prava (sažeto) |
|---|---|---|---|
| `ADMIN` | 1.0 `admin` + 2.0 V1 | **2.0 V1** | Sve, uključujući korisnike, sync, audit, zarade (3.0). |
| `SEF` | **nova (2.0)**; apsorbuje CMMS `chief` | **2.0 V2** | Šef proizvodnje: **pun pristup TEHNOLOGIJI** + odobravanje/lansiranje RN + plan/pregled cele proizvodnje + write lokacije + read MRP/strukture. |
| `TEHNOLOG` | 2.0 draft (ARCHITECTURE §7) | **2.0 V2** | **Pun pristup modulu TEHNOLOGIJA** (TP, operacije, dokumentacija, šifarnici); kandidat za `definesApproval`. |
| `CNC_PROGRAMER` | **nova (2.0)** | **2.0 V2** | **Pun pristup modulu TEHNOLOGIJA** — fokus: CNC programi/dokumentacija uz TP i operacije; read PDM. |
| `KONTROLOR` | 2.0 draft | 2.0 V2 | Kvalitet: primopredaje, vrste kvaliteta, dorada/škart. |
| `MAGACIONER` | 1.0 `magacioner` | 2.0 V2 | Lokacije delova write; (3.0: reversi, CMMS magacin). |
| `RADNIK` | 2.0 draft; apsorbuje CMMS `operator` | 2.0 V2 | Pogon: vidi svoje RN/operacije **po `machine_access`**; unos rada. |
| `NABAVKA_VIEW` | 2.0 draft | 2.0 V2 | MRP/nabavka samo uvid. |
| `MENADZMENT` | 1.0 `menadzment` (i CMMS `management`) | 2.0 V2 (read) / 3.0 | Uprava: širok uvid svuda; write u operativi po 1.0 pravilima; Kadrovska scoped po `managed_sub_departments`; **bez zarada**. |
| `CNC_OPERATER` | 1.0 `cnc_operater` | 3.0 | ≠ CNC_PROGRAMER! U 1.0: pregled proizvodnje + štampa nalepnica. Zadržava se kao posebna rola. |
| `PM` / `LEADPM` | 1.0 | 3.0 | Projektni menadžeri; jedine role sa **per-projekat** dodelom. |
| `HR` | 1.0 | 3.0 | Kadrovska bez zarada. |
| `POSLOVNI_ADMIN` | 1.0 | 3.0 | Kadrovska bez zarada i ugovora; PII dokumenti. |
| `PROJEKTANT_VODJA` | 1.0 `projektant_vodja` | 3.0 | Projektni biro pun edit. |
| `INZENJER` | 1.0 `inzenjer` | 3.0 | Projektni biro ograničen edit (status/završenost/komentari). |
| `TEHNICAR_ODRZAVANJA` | CMMS `technician` | 3.0 | Održavanje: radni nalozi održavanja. |
| `VIEWER` | 1.0 `viewer` | 3.0 | Read-only. |
| `USER` | 2.0 V1 šema | prelazno | Postoji u šemi; posle V2 mapira se u `VIEWER` ili konkretnu rolu. |

Napomene:
- **„Šef ima ta prava i neka iz ostatka aplikacije"** — predlog konkretizacije je u matrici §3;
  tačan obim `SEF` prava **treba potvrditi** (otvoreno pitanje §7.1).
- Odstupanje od ARCHITECTURE drafta: umesto role `PROJEKTNI_BIRO` koristimo 1.0 par
  `PROJEKTANT_VODJA`/`INZENJER` (1:1 kompatibilnost; draft sme da bude pregažen — BACKEND_RULES §2).
- Mapiranje 1.0→kanonski pri 3.0 migraciji: lowercase→UPPERCASE 1:1, plus CMMS profil se spaja u
  katalog (`operator→RADNIK`, `technician→TEHNICAR_ODRZAVANJA`, `chief→SEF`, `management→MENADZMENT`,
  `admin→ADMIN`) uz modul-scope (vidi §4).

### 2.1 Mapiranje stvarnih rukovodilaca (sistematizacija 2026 — odluka 2026-07-08)

| Osoba | Naziv u sistematizaciji | Kanonska rola 2.0 | Scope / dodatno |
|---|---|---|---|
| **Miljan Nikodijević** | Rukovodilac proizvodnih operacija i tehnologije | **`MENADZMENT`** | proizvodnja + tehnologija; scope = pododseci koje vodi (`managed_sub_department_ids`) |
| **Nikola Ninković** | Šef mašinske obrade | **`MENADZMENT`** | šef CELE mašinske obrade; nema poseban scope (potvrda Nenad 8.7) |
| **Milorad Jerotić** | Gl. mašinski inž. + Rukovodilac inženjeringa; **finalni potpisnik** | **`PROJEKTANT_VODJA`** + flag **`finalni_potpisnik`** | finalno odobrenje nacrta/primopredaje |

> **Revizija 2026-07-20 (Nenad):** Miljan prebačen `SEF` → **`MENADZMENT`** (sa dodeljenim
> `managed_sub_department_ids`). Razlog: rukovodilac treba da odobrava GO SVOM timu (paritet 1.0),
> a cela skop-mašinerija (`current_user_can_manage_vacreq` / `current_user_manages_employee` /
> `hr_vacreq_approve` dvostepeno) prepoznaje `menadzment` + pododseke, a NE `sef`. Time je usklađen
> sa Nikolom (isti profil „scoped šef") i sa V1 pojednostavljenjem ispod. Prethodna dodela (`SEF`)
> nije davala nikakva `kadrovska.*` prava → Miljan nije mogao da priđe odobravanju GO.

> **V1 pojednostavljenje:** u ServoSync 1.0 su sva trojica `menadzment`. Prihvatljivo je da u 2.0 V1
> ostanu `MENADZMENT` (uvid+write), a granularizacija na `SEF`/`PROJEKTANT_VODJA` + `finalni_potpisnik`
> flag dolazi u V2 kad zaživi odobravanje/lansiranje. `finalni_potpisnik` = per-user override flag
> (obrazac 1.0 „per-user flag", §1.3), ne zasebna rola.

---

## 3. Matrica prava — moduli 2.0 × role

Legenda: **W** = pun read/write · **R** = read · **A** = approve/lansiranje/otključavanje ·
**own/mach** = row-scope (samo svoji redovi / svoje mašine) · — = bez pristupa.
`ADMIN` svuda ima W+A (izostavljen iz kolona radi čitljivosti).

| Modul (tabele) | SEF | TEHNOLOG | CNC_PROGRAMER | KONTROLOR | MAGACIONER | RADNIK | NABAVKA_VIEW | MENADZMENT |
|---|---|---|---|---|---|---|---|---|
| **TEHNOLOGIJA**: `tech_processes`, `tech_process_documents`, `work_order_operations`, `work_order_operation_images`, `operations`, `work_units`, `part_quality_types`, (novo) `cnc_programs` | **W+A** | **W** | **W** | R | R | R (mach) | R | R |
| `machine_access` (dodela radnik↔mašina) | **W** | R | R | — | — | R (own) | — | R |
| **RN**: `work_orders` + komponente/stavke | W+**A** (launch/approve) | W; A uz `definesApproval` | R | R | R | R+unos rada (mach) | R | R |
| **PDM/BOM**: `drawings`, `drawing_components`, `drawing_plans`… | R | R (+W na tehnološkim poljima — potvrditi) | R | R | R | — | R | R |
| **Nacrti/Primopredaje**: `handover_drafts`, `drawing_handovers`… | W+A | W (svoje primopredaje) | R | **W** (prijem/kvalitet) | R | — | — | R |
| **Lokacije delova**: `part_locations`, `positions` | W | R | R | R | **W** | R | — | R |
| **Strukture**: `workers`, `worker_types`, `machine_access` admin | W | R | R | R | R | R (own) | — | R |
| **MRP/Nabavka** (uvid): `mrp_*` | R | R | R | — | R | — | **R** | R |
| **Komitenti/Predmeti** (cache, read-only): `customers`, `projects`… | R | R | R | R | R | — | R | R |
| **Sync admin**: `POST /sync/run`, `bb_sync_log/state` | — (R log) | — | — | — | — | — | — | R log |
| **Audit**: `audit_log` | — | — | — | — | — | — | — | — |
| **Users/role admin**: `users`, `user_roles` | — | — | — | — | — | — | — | — |

*Sync run, audit read i user admin = samo `ADMIN` (obrazac 5 i 11 iz 1.0; postojeći `TODO(auth)` u
`sync.controller.ts` se zatvara ovim).*

### 3.1 Row-level pravila za TEHNOLOGIJU (detaljno — jezgro zahteva)

1. **TEHNOLOG i CNC_PROGRAMER vide SVE u modulu** — nema row-scopinga unutar modula (obrazac 1:
   read-all unutar role). Obojica pišu TP, operacije, dokumentaciju i šifarnike modula.
2. **Završen/zaključan TP** (`tech_processes.isProcessFinished = true` / potpisan): izmena samo
   `SEF`/`ADMIN` (ili otključavanje pa izmena vlasnika). Preslikava 1.0 obrazac `sast_check_not_locked`.
3. **Vlasništvo TP**: `tech_processes.workerId` = tehnolog autor; ostaje informativno (ne ograničava
   read), ali ulazi u audit i u pravilo potpisa: potpisuje autor ili `SEF`.
4. **`machine_access`**: dodelu radnika mašinama menja `SEF`/`ADMIN`; `RADNIK` vidi svoje redove.
5. **Šifarnici modula** (`operations`, `work_units`, `part_quality_types`): read svi prijavljeni,
   write `TEHNOLOG`/`CNC_PROGRAMER`/`SEF`/`ADMIN` (obrazac 2 sa širim write skupom).
6. **CNC programi**: danas **ne postoji tabela** — CNC sadržaj živi kao prilog
   (`tech_process_documents.fileLink`, `work_order_operation_images`) i slobodan tekst
   (`work_order_operations.toolsFixtures`). Predlog: nova **app-owned** tabela `cnc_programs`
   (`id, drawingId?/techProcessId?, workCenterCode, version, fileLink, note, createdById, …`) —
   vlasnički write `CNC_PROGRAMER` (+`TEHNOLOG`/`SEF`), read ceo modul. (Otvoreno pitanje §7.3.)

### 3.2 RN pravila koja se ukrštaju sa TEHNOLOGIJOM

- **Lansiranje RN** (`work_order_launches`): permission `rn.launch` = rola ∈ {`SEF`,`TEHNOLOG`,`ADMIN`}
  **I** `Worker.definesLaunch = true`.
- **Odobravanje RN** (`work_order_approvals`): permission `rn.approve` = `Worker.definesApproval = true`,
  a flag je dozvoljen samo za `worker_type ∈ {Tehnolog, Inženjeri}` i `definesLaunch ⇒ definesApproval`
  (postojeća pravila MODULE_SPEC_structures §7.3).
- Rola daje *mogućnost*, `Worker` flag daje *ovlašćenje* — oba sloja se proveravaju (isti duh kao 1.0
  „rola × override flagovi").

---

## 4. Model podataka (app-owned; Prisma)

Zadržava postojeće `users.role` (V1: `ADMIN`/`USER`) i dodaje V2 sloj — **nadskup 1.0 šeme**:

```prisma
/// App-owned. Supersedes 1.0 user_roles(email, role, project_id, managed_sub_department_ids, flags).
model UserRole {
  id        Int      @id @default(autoincrement())
  userId    Int
  role      String   /// katalog iz §2, velikim slovima
  scopeType String   @default("global") /// global | project | department | module
  scopeId   String?  /// projectId / departmentId / modul-ključ (npr. "odrzavanje" za CMMS profil)
  isActive  Boolean  @default(true)
  createdAt DateTime
  updatedAt DateTime
  @@unique([userId, role, scopeType, scopeId])
}

/// Per-user override flagovi (1.0: plan_montaze_readonly, kadrovska_access, kadrovska_hide_contracts…)
model UserPermissionOverride {
  id     Int     @id @default(autoincrement())
  userId Int
  key    String  /// permission ključ, npr. "plan-montaze.write"
  allow  Boolean /// true = grant, false = deny (deny jači od role)
  @@unique([userId, key])
}
```

- `scopeType='project'` pokriva 1.0 per-projekat `pm`/`leadpm`; `scopeType='department'` +
  više redova pokriva `managed_sub_department_ids[]`; `scopeType='module'` pokriva CMMS profile
  (ista rola `RADNIK` može biti globalna ili samo za modul održavanja).
- Dodaje se **`User.workerId` FK** (već planirano u MODULE_SPEC_structures §5.3) — most ka
  proizvodnim flagovima (`definesApproval`, `definesLaunch`, `MachineAccess`).
- Legacy `access_rights` (BBPravaPristupa), `default_users.level` — **ne koriste se runtime**
  (migration/01 §4); služe samo kao referenca šta je legacy dozvoljavao.

---

## 5. Arhitektura sprovođenja („RLS" u 2.0 stack-u)

ROADMAP (linija 76) je već presudio pravac: *„293 RLS politike → NestJS guardovi + eksplicitno
query-scoping (Prisma nema nativni RLS)"*. Predlog konkretizuje tri sloja:

1. **Sloj 1 — coarse (endpoint):** globalni `JwtAuthGuard` + `RolesGuard`/`PermissionsGuard`.
   Permission ključevi `modul.akcija` (`tehnologija.read`, `tehnologija.write`, `tehnologija.approve`,
   `rn.launch`, `rn.approve`, `lokacije.write`, `mrp.read`, `sync.run`…). Mapa rola→permisije je
   **jedan TS fajl** (`src/common/authz/role-permissions.ts`) — ekvivalent 1.0 `erpRbacMatrix.js`,
   izvor istine za backend i frontend (izvoz kroz `/api/v1/me/permissions`).
2. **Sloj 2 — row (query-scoping):** `ScopeService` sa builder-ima Prisma `where` uslova po
   obrascima iz §1.4: `scopeOwn(userId)`, `scopeMachineAccess(workerId)`,
   `scopeManagedDepartments(user)`, `scopeProject(user, projectId)`, `scopeUnlocked()`.
   Servis domenskog modula **mora** provući scope za role koje ga zahtevaju (RADNIK→mach, itd.).
3. **Sloj 3 — mutaciona pravila u servisu:** zaključavanja (TP finished, RN locked), flag provere
   (`definesLaunch`), no-client-write tabele (audit/history pišu samo interceptori/servisi).

**V1 → V2 put (bez bacanja koda):** V1 ostaje kako BACKEND_RULES §7 kaže (svi `ADMIN`), ali se
`@Roles()`/`@RequirePermission()` dekoratori i no-op guardovi pišu **odmah uz auth modul**, sa
permission ključevima iz ovog dokumenta. Aktivacija V2 = uključivanje guard logike + seed
`user_roles` — bez izmena po kontrolerima.

**Paritet-testovi (obavezno):** 1.0 ima 29 pgTAP RLS testova; 2.0 dobija ekvivalent — e2e supertest
matrica „rola × endpoint × očekivan status (200/403) + row-scope asercije". Bez ovoga se RLS→guard
migracija u 3.0 ne može dokazati (RED rizik iz migration/03 §84).

**Opcioni sloj 4 — pravi PostgreSQL RLS (defense-in-depth):** tehnički izvodljiv
(`SET LOCAL app.user_id` kroz Prisma `$extends` + interaktivne transakcije), ali dupliran trud i
komplikuje connection pooling. **Preporuka: NE sada**; razmotriti u 3.0 samo ako se pojavi drugi
kanal pristupa bazi (BI alati, drugi servisi). → otvoreno pitanje §7.4.

---

## 6. Mapiranje 1.0 → 2.0/3.0 (kontrolna lista za 3.0)

| 1.0 artefakt | 2.0/3.0 ekvivalent |
|---|---|
| `user_roles` (email-based) | `UserRole` (userId-based, §4) — email matching nestaje |
| `has_edit_role(project_id)` | permission `*.write` + `scopeProject` |
| `current_user_is_admin/hr/management/...` | `RolesGuard` predikati nad katalogom §2 |
| `current_user_manages_employee` | `scopeManagedDepartments` (department-scope role) |
| `maint_user_profiles` | `UserRole` sa `scopeType='module', scopeId='odrzavanje'` |
| override flagovi (readonly/access/hide) | `UserPermissionOverride` (deny > rola) |
| 238 SECURITY DEFINER RPC | NestJS servisne metode u transakciji + provera permisije u telu |
| `audit_row_change` trigeri | `audit_log` interceptor (BACKEND_RULES §8) |
| storage bucket politike | MinIO/S3 presigned + ista permission provera |
| pgTAP RLS testovi | e2e permission matrica (§5) |
| skriveni moduli: CMMS jezgro, praćenje proizvodnje, SCADA | **eksplicitno uneti u 3.0 plan** — nisu u RBAC_MATRIX.md |

---

## 7. Odluke (Nenad, 2026-07-08) — vidi [ODLUKE.md](../ODLUKE.md)

1. **Obim `SEF` prava** → ✅ **ODLUČENO: pun rad + odobravanje** (RN/primopredaje/lokacije) + pregled ostalog.
   **Jedan `SEF`** (ne per-modul). Uključuje write na strukturama i planu.
2. **`CNC_PROGRAMER` potpisuje/završava TP?** → ✅ **DA.** Potpisuju/završavaju: **TEHNOLOG (autor) + ŠEF + CNC_PROGRAMER.**
3. **Tabela `cnc_programs`** → ✅ **DA — uvodi se** (app-owned; CNC_PROGRAMER vlasnik write-a; veza na crtež/TP, verzija, fajl).
4. **PG RLS** → ✅ **NE sada** — samo NestJS guardovi + query-scoping (pravi PG RLS eventualno u 3.0).
5. **`MENADZMENT`** → ✅ **Uvid + write** (paritet sa 1.0), ne samo read.
6. **Imenovanje/mapiranje ljudi** → ✅ **iz sistematizacije 2026** (§2 dopunjen):
   - **Miljan Nikodijević** (*Rukovodilac proizvodnih operacija i tehnologije*) → **`MENADZMENT`**
     (proizvodnja/tehnologija; scope = pododseci koje vodi). *Rev. 2026-07-20: prebačen sa `SEF` da bi
     mogao da odobrava GO svom timu — vidi belešku uz tabelu §2.1.*
   - **Nikola Ninković** (*Šef mašinske obrade*) → **`MENADZMENT`** (scope = mašinska obrada / radna jedinica).
   - **Milorad Jerotić** (*Gl. mašinski inž. + Rukovodilac inženjeringa; **finalni potpisnik***) → **`PROJEKTANT_VODJA`**
     + **`finalni potpisnik` flag** (finalno odobrenje nacrta/primopredaje).
   - U 1.0 su svi **`MENADZMENT`** → prihvatljivo za V1 (svi MENADZMENT sa uvid+write), granularizacija (SEF/PROJEKTANT_VODJA) u V2.
   - `SEF` (ne `SEF_PROIZVODNJE`); draft `PROJEKTNI_BIRO` zamenjen parom `PROJEKTANT_VODJA`/`INZENJER`.

**Razrešeno (Negovan/Vasa, 8.7):** potpis/završetak TP — **DA, `KONTROLOR` finalnom kontrolom validira da je TP
završen** i ako sve operacije nisu otkucane („ako on kaže da je dobro, dobro je"); **isto mogu svi iz
`MENADZMENT`**. Obavezan **audit zapis: ime+prezime + kada**. Nikola Ninković = **`MENADZMENT`** (šef CELE
mašinske obrade), bez posebnog scope-a.

## 8. Redosled implementacije (kad se odobri)

1. Auth modul V1 po BACKEND_RULES §7 (JWT, bcrypt, `ADMIN`), odmah sa no-op `RolesGuard` +
   `@RequirePermission()` dekoratorima i katalogom permisija iz ovog dokumenta; zatvoriti
   `TODO(auth)` na `POST /sync/run` (`sync.controller.ts`).
2. Migracija: `user_roles` + `user_permission_overrides` + `users.worker_id` FK (app-owned tabele).
3. `ScopeService` + prvi domenski modul (TEHNOLOGIJA) sa pravilima iz §3.1 kao pilot.
4. e2e permission matrica (rola × endpoint) — raste sa svakim modulom.
5. Aktivacija V2 guard logike kad Negovan potvrdi §7; seed rola za stvarne korisnike.

---

*Verzija 0.1, 2026-07-04 — prva verzija predloga, izvedena iz pune inventure 1.0 RLS sloja i
2.0 šeme. Autor analize: AI sesija (Nenad); odluke donose Negovan/Nesa.*

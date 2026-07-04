# Servosync — Module Spec: Proizvodne strukture (Production Structures)

| | |
|---|---|
| **Modul** | Production Structures (radnici, RJ, operacije, vrste poslova) |
| **Verzija specifikacije** | 1.1 |
| **Datum** | maj 2026 |
| **Sprint** | 2 (po ARCHITECTURE.md planu) |
| **Korisnici modula** | Admin (kompletan CRUD), Menadžment (read), svi (read u dropdown-ima drugih modula) |
| **Status** | Specifikacija za implementaciju |

---

## 0. Kako koristiti ovaj dokument

Ovo je specifikacija **foundation modula** koji obezbeđuje master data o ljudima i resursima proizvodnje. Servosync **mora imati** ovaj modul pre nego što Sprint 4 (Primopredaje) i Sprint 5 (RN) mogu da funkcionišu — jer ti moduli zavise od `workers`, `operations`, `work_units`, `worker_types`, i `machine_access` tabela.

Modul je relativno mali (~5 CRUD ekrana), ali je **kritičan** zato što sadrži:

- **Permission flagove** koji se koriste kroz ceo sistem (`defines_approval`, `defines_launch`)
- **Worker × Machine matricu** koja kontroliše ko šta sme da kuca u proizvodnji
- **Operations master list** koja je osnova za sve tehnološke postupke

**Pre čitanja:**
- `ARCHITECTURE.md` — strateški kontekst
- `schema.prisma` — definicije Worker, WorkUnit, Operation, WorkerType, MachineAccess
- `BB_Tehnologija_opis.pdf` — strane 18-20 (Proizvodne strukture)

---

## 1. Cilj modula

**Šta modul radi:**

Implementira **CRUD za master data o ljudima i operacionim resursima** u Servoteh proizvodnji:

- **Radnici** — svi zaposleni koji rade na proizvodnji (i tehnolozi, i majstori, i kontrolori, i montažeri, i inženjeri)
- **Radne jedinice (RJ)** — organizacijske celine u pogonu (Sečenje, Struganje, Glodanje, Bravari, Farbanje, ...)
- **Operacije** — konkretne operacije/mašine unutar radne jedinice (Sečenje-Testera, CNC Glodanje DMU 50T, Bravari-Savijanje, ...)
- **Vrste poslova** — klasifikacija radnika po ulozi (Tehnolog, Majstor, Kontrola, Montaža, Inženjeri, NN)
- **Matrica radnik × mašina** — koja kucanja su dozvoljena kom radniku

**Zašto je foundation:**

Svi drugi moduli koriste ove tabele kao FK reference:

| Modul | Šta koristi |
|---|---|
| Nacrti modul (Sprint 4) | `Worker` za `HandoverDraft.designer_id` |
| Primopredaje modul (Sprint 4) | `Worker.defines_approval`, `Worker.defines_launch` za authorization |
| Work Orders (Sprint 5) | `Worker`, `WorkUnit`, `Operation` za tehnološke postupke i operacije |
| Production (Sprint 6) | `Worker`, `Operation`, `MachineAccess` za prijavu rada na mašini |
| Locations (Sprint 7) | `Worker` za `PartLocation.worker_id` (ko je smestio deo) |

**Bez ovog modula:**
- Ne mogu se kreirati primopredaje (nema tehnologa)
- Ne mogu se kreirati RN-ovi (nema radnika ni operacija)
- Ne može se prijaviti rad na mašini (nema MachineAccess)

---

## 2. Skop modula (iz BB_Tehnologija_opis.pdf, strane 18-20)

### 2.1 Ekrani u Sprintu 2

| # | Ekran (legacy ime) | Engleski naziv | API ruta | Tabela |
|---|---|---|---|---|
| 1 | Unos/Pregled radnika | Workers list + CRUD | `/workers` | `workers` |
| 2 | Vrste poslova | Worker types CRUD | `/worker-types` | `worker_types` |
| 3 | Unos/Pregled radnih jedinica | Work units CRUD | `/work-units` | `work_units` |
| 4 | Unos/Pregled operacija | Operations CRUD | `/operations` | `operations` |
| 5 | Radnici po mašinama | Worker × Machine matrix | `/machine-access` | `machine_access` |

### 2.2 Šta NIJE u skopu V1

- **HR funkcionalnosti** — plate, odsustva, ugovori (to je Kadrovska modul u postojećoj Supabase aplikaciji, migracija dolazi u Fazi 2)
- **Atendenca** (dolazak/odlazak sa posla) — V2 ako bude trebalo
- **Performance tracking** po radniku — to je deo Production modula (Sprint 6 — "Analiza dnevnih aktivnosti")
- **Bar-kod fizička integracija** — V2/V3 zavisno od odluke
- **Brisanje radnika** — soft delete (`active = false`), nikad hard delete (audit trail mora ostati)
- **Brisanje operacija** — soft delete, postoje RN-ovi koji ih referenciraju
- **OAuth/AD integracija** — V2

---

## 3. Tabele koje koristi

### 3.1 `workers` (Worker model)

**Definicija (iz schema.prisma):**

| Kolona | Tip | Komentar |
|---|---|---|
| `id` | Int PK | Auto-increment |
| `username` | VarChar(50) | Skraćeno ime radnika (`MilanB`, `Jota`, `Cira`) |
| `commission_percent` | Float (default 0) | Procenat provizije (legacy iz BigBit-a) |
| `full_name` | VarChar(50) | Ime i prezime (`Breka Milan`, `Orescanin Milos`) |
| `id_number` | VarChar(20) | Šifra radnika (legacy `Sifra radnika`) |
| `password` | VarChar(20) | **LEGACY plain-text** lozinka za QMegaTeh login (deprecate u V2) |
| `active` | Boolean | Soft delete flag |
| `work_unit_code` | VarChar(5) | FK na `work_units.code` (npr. "02" = Struganje) |
| `card_id` | VarChar(50) | **Bar-kod ID kartice** radnika (`0005748586`) — koristi se za bar-kod login na proizvodnji |
| `login_account` | VarChar(50) | Login account za web aplikaciju (npr. `JovicaM`, `NikolaN`) |
| `worker_type_id` | Int FK | FK na `worker_types.id` |
| `signature_image` | VarChar(150) | Putanja do JPG slike potpisa (za primopredaje) |
| `defines_approval` | Boolean (default false) | **Permission flag** — može da odobrava primopredaje (Sprint 4) |
| `defines_launch` | Boolean (default false) | **Permission flag** — može da lansira RN |
| `multi_account` | Boolean (default false) | Može imati više login account-a istovremeno (npr. tehnolog koji se loguje i kao majstor) |
| `worker_password` | VarChar(50) | **LEGACY** sekundarna lozinka — koristi se za bar-kod login |

**Veze (relations):**
- `worker_type` → `worker_types`
- `handover_drafts` ← HandoverDraft (kao designer)
- `work_orders` ← WorkOrder (kao designer i kao handover worker — 2 relacije)
- `work_order_operations` ← WorkOrderOperation (kao izvršilac)
- `machine_access` ← MachineAccess (matrica)
- ... 8+ ostalih relacija

**Indeksi (preporuka):**
- `(active)` — najčešći filter
- `(worker_type_id, active)` — za "svi tehnolozi koji su aktivni"
- `(card_id)` — unique-ish, za bar-kod login lookup
- `(login_account)` — za web auth lookup

### 3.2 `work_units` (WorkUnit model)

| Kolona | Tip | Komentar |
|---|---|---|
| `id` | Int PK | |
| `code` | VarChar(5) | Šifra ("00" = NN, "01" = Sečenje, "02" = Struganje, ...) |
| `name` | VarChar(50) | Naziv (`Sečenje`, `Struganje`, `Glodanje`, ...) |

**Seed data** (iz PDF-a strana 19):

```
00 - NN
01 - Sečenje
02 - Struganje
03 - Glodanje
04 - Bravari
05 - Farbanje
06 - Brušenje
07 - Poboljšanje
08 - Montaža
09 - Kooperacija
10 - Erodiranje
11 - Kontrola
12 - Servis
13 - Laser
14 - Ispravljanje
15 - Savijanje
16 - Probijanje
17 - CAM programiranje
18 - Obaranje ivica
19 - Poslovođa
20 - (?)  - lista ide dalje, treba potvrditi
21 - 3D Štampanje
```

### 3.3 `operations` (Operation model)

**Definicija:**

| Kolona | Tip | Komentar |
|---|---|---|
| `id` | Int PK | |
| `work_center_code` | VarChar(5) UNIQUE | **Prirodni ključ** za reference iz drugih tabela (`1.10`, `2.5`, `3.40`) |
| `work_center_name` | VarChar(50) | Naziv operacije (`Sečenje - Testera`, `CNC Strugаnje (GILDEMEISTER)`) |
| `note` | VarChar(255) | Napomena |
| `work_unit_code` | VarChar(5) | FK preko code na `work_units` (logički, ne formalni FK) |
| `without_process` | Boolean | **Flag**: operacija ne zahteva tehnološki postupak ("Opšti nalog za sve poslove") |
| `significant_for_finishing` | Boolean | **Flag**: operacija je "Kraj postupka" (final inspection) |
| `uses_priority` | Boolean | **Flag**: operacija koristi prioritet u planiranju proizvodnje (100/255 sortiranje) |
| `is_skippable` | Boolean | **Flag**: operacija može da se preskoci u tehnologiji |

**Seed data primer** (iz PDF-a strana 19):

```
work_unit  | work_center_code | work_center_name           | without | significant | priority | skippable
NN         | 0.0              | OPŠTI NALOG                | TRUE    | FALSE       | FALSE    | FALSE
Sečenje    | 1.10             | Sečenje - Testera          | FALSE   | FALSE       | TRUE     | FALSE
Sečenje    | 1.2              | Makaze                     | FALSE   | FALSE       | TRUE     | FALSE
Sečenje    | 1.30             | Gasno                      | FALSE   | FALSE       | TRUE     | FALSE
Sečenje    | 1.40             | Vodeno sečenje             | FALSE   | FALSE       | TRUE     | FALSE
Sečenje    | 1.50             | Plazma sečenje             | FALSE   | FALSE       | TRUE     | FALSE
Sečenje    | 1.60             | Lasersko sečenje           | FALSE   | FALSE       | TRUE     | FALSE
Struganje  | 2.4              | Struganje univerzalno (Krasni proleteri) | FALSE | FALSE | TRUE | FALSE
Struganje  | 2.5              | CNC Strugаnje (GILDEMEISTER)| FALSE   | FALSE       | TRUE     | FALSE
Struganje  | 2.10             | Uslužno struganje          | FALSE   | FALSE       | TRUE     | FALSE
Glodanje   | 3.40             | CNC Glodanje (MAHO 700)    | FALSE   | FALSE       | TRUE     | FALSE
Glodanje   | 3.21             | CNC-GLODANJE (TOS WHN 13) MEFI | FALSE | FALSE     | TRUE     | FALSE
Bravari    | 4.1              | Bravari-Savijanje          | FALSE   | FALSE       | TRUE     | FALSE
Farbanje   | 5.1              | Farbanje                   | FALSE   | FALSE       | TRUE     | FALSE
Brušenje   | 6.3              | Brušenje - Ravno (Geibel Hotz) | FALSE | FALSE   | TRUE     | FALSE
Kontrola   | 8.2              | Ručni radovi-Ažistiranje   | FALSE   | FALSE       | FALSE    | FALSE
Kontrola   | 8.3              | Završna Kontrola           | FALSE   | TRUE        | FALSE    | FALSE
Kontrola   | 8.4              | Međufazna Kontrola         | FALSE   | FALSE       | FALSE    | FALSE
```

**Important:** kompletan seed data treba pripremiti od Servoteh tehnologa kao deo Sprint 2 deliverable-a (verovatno 50-80 operacija ukupno).

### 3.4 `worker_types` (WorkerType model)

| Kolona | Tip | Komentar |
|---|---|---|
| `id` | Int PK | |
| `name` | VarChar(50) | Naziv vrste posla |
| `additional_privileges` | Boolean | Flag za "ima dodatna prava" (npr. kontrolor može da zatvara tuđe naloge) |

**Seed data** (iz PDF-a strana 18):

```
ID | Name      | Additional Privileges
0  | NN        | FALSE
1  | Tehnolog  | FALSE
2  | Majstor   | FALSE
3  | Kontrola  | TRUE   ← može zatvarati tuđe naloge
4  | Montaža   | FALSE
5  | Inženjeri | FALSE
```

### 3.5 `machine_access` (MachineAccess model)

**Many-to-many između `workers` i `operations`** (koja kucanja sme radnik):

| Kolona | Tip | Komentar |
|---|---|---|
| `id` | Int PK | |
| `worker_id` | Int FK | → `workers.id` |
| `work_center_code` | VarChar(5) FK | → `operations.work_center_code` (preko prirodnog ključa) |
| `note` | VarChar(250) | Napomena ("Samo manji komadi", "Bez gradinje", ...) |

**Veza:** Worker može imati 0..N MachineAccess entry-ja. Operation može imati 0..N radnika koji je smiju kucati.

**Konvencija:**
- Ako MachineAccess **postoji** za par (worker, operation) → radnik može kucati
- Ako **ne postoji** → ne može
- Postoje izuzeci: radnici sa `worker_type = NN` (`work_unit_code = 00`) mogu da kucaju OPŠTI NALOG (`work_center_code = 0.0`) bez eksplicitnog MachineAccess (implicitno pravilo)

---

## 4. Domenski rečnik

| Srpski termin | Engleski u kodu | Šta znači |
|---|---|---|
| Radnik | worker | Zaposleni u proizvodnji (tehnolog, majstor, kontrolor, montažer, ...) |
| Vrsta posla | worker type | Klasifikacija radnika po ulozi (Tehnolog, Majstor, Kontrola, ...) |
| Radna jedinica (RJ) | work unit | Organizacijska celina pogona (Sečenje, Struganje, Glodanje, ...) |
| Operacija | operation | Konkretna operacija/mašina unutar RJ (Sečenje-Testera, CNC Glodanje DMU 50T) |
| Šifra radnika | id_number | Stari "Sifra radnika" iz BigBit-a |
| ID kartice | card_id | Bar-kod ID-jevi radnika (10-cifren broj) |
| Login account | login_account | Web app username |
| Definiše saglasnost | defines_approval | Permission flag — može odobrati primopredaju |
| Definiše lansiranje | defines_launch | Permission flag — može lansirati RN |
| Multi-account | multi_account | Može imati više login account-a istovremeno |
| Matrica radnik × mašina | machine access | Many-to-many koje operacije može radnik kucati |
| Opšti nalog | general/general work order | Operacija 0.0 (bez tehnološkog postupka, za sve poslove koji ne ulaze u RN) |
| Kraj postupka | end of process / significant for finishing | Operacija koja označava završetak (Završna Kontrola) |
| Bez postupka | without process | Operacija ne zahteva tehnološki postupak |
| Prioritet | priority | Da li operacija koristi 100/255 prioritet za planiranje |

---

## 5. Worker vs User razdvajanje — kritični koncept

**Pitanje:** Šta je razlika između `workers` tabele (HR/proizvodnja) i `users` tabele (NestJS auth)?

### 5.1 Dve odvojene tabele, dva različita cilja

**`users` tabela** (Sprint 0):
- Cilj: web aplikacija auth (login, JWT, refresh tokens, role)
- Polja: email, password_hash (bcrypt), role, isActive
- Koristi se za: login flow, autorizacija API endpoint-a, audit log actor

**`workers` tabela** (Sprint 2):
- Cilj: HR/proizvodnja master data
- Polja: full_name, card_id, work_unit_code, worker_type_id, signature_image, permission flags
- Koristi se za: ko je projektant na nacrtu, koji tehnolog odobrava, ko kuca operaciju, ko je smestio deo u magacin

### 5.2 Kako se vezuju?

**Postoje 3 scenarija:**

**Scenario A: Web user koji je i radnik u proizvodnji** (najčešći)
- Postoji `User` zapis (za login)
- Postoji `Worker` zapis (za audit/primopredaje/...)
- Veza: dodaje se opcionalna kolona **`users.worker_id` FK ka workers** u Sprint 2 migration

**Scenario B: Web user koji NIJE u proizvodnji** (npr. menadžment, admin)
- Postoji samo `User` zapis
- `Worker` ne postoji (ili postoji sa specijalnom rolom "Menadžment")

**Scenario C: Radnik koji NE koristi web app** (samo bar-kod stanice)
- Postoji `Worker` zapis (sa `card_id` i `worker_password`)
- `User` ne postoji
- Radnik se autentifikuje samo na proizvodnji preko bar-koda (V2/V3 funkcija)

### 5.3 Migracija za Sprint 2 dodaje `users.worker_id`

```prisma
model User {
  // ... postojeća polja
  workerId Int?    @unique @map("worker_id")  // Opcionalna veza ka Worker zapisu
  worker   Worker? @relation(fields: [workerId], references: [id], onDelete: SetNull)
}

model Worker {
  // ... postojeća polja
  user User?
}
```

**Cascade pravila:**
- Brisanje User-a → `worker_id` se ne briše, Worker ostaje (HR audit)
- Brisanje Worker-a → User.worker_id se postavlja na NULL (User ostaje ali nije više povezan)
- Soft delete Worker-a (active=false) → User može da se loguje ali nema permission flags

### 5.4 Permission flags rezolucija u kodu

```typescript
// Pseudo: helper service
async getWorkerPermissions(userId: number): Promise<WorkerPermissions> {
  const user = await this.prisma.user.findUnique({
    where: { id: userId },
    include: { worker: true },
  });
  
  if (!user.worker) {
    // User bez worker veze — koristi se samo system role
    return { definesApproval: false, definesLaunch: false };
  }
  
  return {
    definesApproval: user.worker.definesApproval,
    definesLaunch: user.worker.definesLaunch,
    workerTypeName: user.worker.workerType.name,
    workUnitCode: user.worker.workUnitCode,
  };
}
```

Ovo se onda koristi u guards za API endpoint-e koji zahtevaju `defines_approval` (npr. `POST /handovers/:id/approve`).

### 5.5 Legacy `workers.password` i `workers.worker_password`

**Trenutna polja u šemi:**
- `workers.password` (VarChar 20) — legacy plain-text iz QMegaTeh-a
- `workers.worker_password` (VarChar 50) — drugi legacy plain-text (PIN za bar-kod)

**V1 odluka:**
- **NE koristimo** ova polja za bilo kakvu auth
- Sva auth ide kroz `users.password_hash` (bcrypt, Sprint 0)
- Polja ostaju u šemi za legacy data migration kompatibilnost, ali se NE prikazuju u UI i NE koriste u poslovnoj logici
- V2: deprecate ova polja, ukloniti iz šeme

---

## 6. API endpoints

### 6.1 Workers

**`GET /api/v1/workers`** — lista radnika

Query params:
- `active` (boolean) — default `true` (samo aktivni)
- `work_unit_code` (string) — filter po radnoj jedinici
- `worker_type_id` (number) — filter po vrsti posla
- `defines_approval` (boolean) — samo tehnolozi za approve dialog
- `defines_launch` (boolean) — samo "launch-capable"
- `search` (string) — fuzzy nad `full_name`, `username`, `card_id`
- `cursor`, `limit`

Response:
```json
{
  "data": [
    {
      "id": 5,
      "username": "MilanB",
      "fullName": "Breka Milan",
      "idNumber": "0005748586",
      "cardId": "0005748586",
      "active": true,
      "workUnit": { "code": "02", "name": "Struganje" },
      "workerType": { "id": 2, "name": "Majstor", "additionalPrivileges": false },
      "definesApproval": false,
      "definesLaunch": false,
      "multiAccount": false,
      "signatureImage": "/signatures/milan_breka.jpg",
      "loginAccount": "MilanB",
      "linkedUserId": 12  // ako ima vezu sa User-om
    }
  ],
  "meta": { "pagination": { ... }, "total_count": 87 }
}
```

**`GET /api/v1/workers/:id`** — detalj jednog radnika

Response: kompletan worker objekat + lista `machine_access` entry-ja (operacije koje sme da kuca).

**`POST /api/v1/workers`** — kreiraj radnika

Request body:
```json
{
  "username": "novi_radnik",
  "fullName": "Petar Petrović",
  "idNumber": "0012345678",
  "cardId": "0012345678",
  "workUnitCode": "03",
  "workerTypeId": 2,
  "loginAccount": "PetarP",
  "definesApproval": false,
  "definesLaunch": false,
  "multiAccount": false,
  "signatureImage": null
}
```

Auth: `role = 'ADMIN'`.

Validation:
- `username` mora biti jedinstven
- `cardId` mora biti jedinstven (ako postoji)
- `workUnitCode` mora postojati u `work_units`
- `workerTypeId` mora postojati u `worker_types`

**`PATCH /api/v1/workers/:id`** — ažuriraj radnika

**`DELETE /api/v1/workers/:id`** — soft delete (postavi `active = false`)

Pravila:
- Ne dozvoljava se hard delete u V1
- Ako radnik ima aktivne RN-ove ili primopredaje → upozorenje, ali dozvoljava se deaktivacija

**`POST /api/v1/workers/:id/link-user`** — poveži radnika sa User-om

Request body:
```json
{
  "userId": 42
}
```

Postavlja `users.worker_id = :id`. Validacija: jedan User može biti vezan samo za jednog Worker-a (UNIQUE constraint).

**`POST /api/v1/workers/:id/unlink-user`** — raskine vezu

### 6.2 Work Units

**`GET /api/v1/work-units`** — lista RJ-eva

Response:
```json
{
  "data": [
    { "id": 1, "code": "01", "name": "Sečenje" },
    { "id": 2, "code": "02", "name": "Struganje" },
    /* ... */
  ]
}
```

**`POST /api/v1/work-units`** — kreiraj RJ (admin)
**`PATCH /api/v1/work-units/:id`** — ažuriraj
**`DELETE /api/v1/work-units/:id`** — soft delete (V1 ne dozvoljava ako ima Worker-e)

### 6.3 Operations

**`GET /api/v1/operations`** — lista operacija

Query params:
- `work_unit_code` (string) — filter po RJ
- `without_process` (boolean) — filter operacije bez tehnološkog postupka
- `uses_priority` (boolean) — filter prioritetnih operacija
- `search` (string) — fuzzy

Response:
```json
{
  "data": [
    {
      "id": 1,
      "workCenterCode": "1.10",
      "workCenterName": "Sečenje - Testera",
      "workUnit": { "code": "01", "name": "Sečenje" },
      "withoutProcess": false,
      "significantForFinishing": false,
      "usesPriority": true,
      "isSkippable": false,
      "note": null,
      "workersWithAccess": 12  // broj radnika koji smeju kucati ovu operaciju
    }
  ]
}
```

**`POST /api/v1/operations`** — kreiraj (admin)
**`PATCH /api/v1/operations/:id`** — ažuriraj
**`DELETE /api/v1/operations/:id`** — soft delete (ne briše ako ima RN operations)

### 6.4 Worker Types

**`GET /api/v1/worker-types`** — lookup

```json
{
  "data": [
    { "id": 0, "name": "NN", "additionalPrivileges": false },
    { "id": 1, "name": "Tehnolog", "additionalPrivileges": false },
    { "id": 2, "name": "Majstor", "additionalPrivileges": false },
    { "id": 3, "name": "Kontrola", "additionalPrivileges": true },
    { "id": 4, "name": "Montaža", "additionalPrivileges": false },
    { "id": 5, "name": "Inženjeri", "additionalPrivileges": false }
  ]
}
```

CRUD samo za admin role.

### 6.5 Machine Access (Radnici po mašinama)

**`GET /api/v1/machine-access`** — matrica

Query params:
- `worker_id` (number) — sve operacije koje sme jedan radnik
- `work_center_code` (string) — svi radnici koji smiju jednu operaciju
- `work_unit_code` (string) — sve veze za RJ

Response:
```json
{
  "data": [
    {
      "id": 1,
      "workerId": 11,
      "worker": { "id": 11, "fullName": "Breka Milan", "username": "MilanB" },
      "workCenterCode": "2.1",
      "operation": {
        "workCenterCode": "2.1",
        "workCenterName": "Struganje univerzalno (Prvomajska TNP250)"
      },
      "note": null
    }
  ]
}
```

**`POST /api/v1/machine-access`** — dodaj radniku pravo da kuca operaciju

Request body:
```json
{
  "workerId": 11,
  "workCenterCode": "2.5",
  "note": null
}
```

Validation: par `(workerId, workCenterCode)` mora biti jedinstven (UNIQUE constraint dodati u migration).

**`DELETE /api/v1/machine-access/:id`** — ukloni vezu

**`POST /api/v1/machine-access/batch`** — bulk add/remove (za UI "Radnici po mašinama" matricu)

Request body:
```json
{
  "workerId": 11,
  "addOperations": ["2.1", "2.5", "2.8"],
  "removeOperations": ["3.40"]
}
```

Transakcija: dodaje sve `addOperations`, briše sve `removeOperations` atomarno.

---

## 7. Poslovna pravila

### 7.1 Worker.active soft delete

**Pravila:**
- `active = false` znači "ne prikazuj u standardnim pregledima" (default filter `?active=true`)
- Ali zapis ostaje u sistemu za audit log i historical relations
- Polja kao `defines_approval`, `defines_launch` se ne uzimaju u obzir za inactive worker-e (vraćaju se `false` u permission check-u)
- Linked User može da se i dalje loguje, ali nema permission flagove

**Implementacija u service-u:**

```typescript
async getActiveWorkers(filter: WorkerFilter) {
  return this.prisma.worker.findMany({
    where: {
      active: true,  // implicit filter
      ...this.buildWhere(filter),
    },
  });
}

// Posebna ruta /workers/inactive za admin pregled
async getInactiveWorkers() {
  return this.prisma.worker.findMany({
    where: { active: false },
  });
}
```

### 7.2 Validation: Worker.username i Worker.card_id moraju biti unikatni

**Migration u Sprint 2 dodaje:**

```sql
ALTER TABLE workers ADD CONSTRAINT uq_workers_username UNIQUE (username);
ALTER TABLE workers ADD CONSTRAINT uq_workers_card_id UNIQUE (card_id);
ALTER TABLE workers ADD CONSTRAINT uq_workers_login_account UNIQUE (login_account)
  WHERE login_account IS NOT NULL;
```

### 7.3 Permission flag pravila

**Pravilo 1: `defines_approval = true` zahteva određen `worker_type`**

```typescript
async validateApprovalPermission(workerId: number, definesApproval: boolean) {
  if (!definesApproval) return; // bez problema
  
  const worker = await this.prisma.worker.findUnique({
    where: { id: workerId },
    include: { workerType: true },
  });
  
  // Defines approval samo za Tehnolog i Inženjeri
  const allowedTypes = ['Tehnolog', 'Inženjeri'];
  if (!allowedTypes.includes(worker.workerType.name)) {
    throw new ValidationException(
      `Worker type '${worker.workerType.name}' ne može imati defines_approval=true`,
      'WORKER_TYPE_NOT_ELIGIBLE_FOR_APPROVAL'
    );
  }
}
```

**Pravilo 2: `defines_launch = true` zahteva `defines_approval = true`**

Ne može se lansirati RN bez prethodnog odobravanja primopredaje.

### 7.4 Operation special flag-ovi

**Pravila za `without_process = true`:**
- Operacija je "Opšti nalog" — radnici je kucaju kad rade nešto što ne ulazi u RN (čišćenje radionice, sastanak, edukacija)
- Ne ulazi u tehnološke postupke nikada
- Samo jedna takva operacija sme da postoji per work_unit (uglavnom `work_unit = NN` i `work_center_code = 0.0`)
- UI prikazuje crveno-stamovanu oznaku "Bez tehnološkog postupka"

**Pravila za `significant_for_finishing = true`:**
- Operacija je "kraj postupka" — kad se ona završi, deo prelazi u status "spreman za lokaciju"
- Trigger u proizvodnji: kad radnik kuca završetak operacije sa `significant_for_finishing = true` → automatski se kreira `PartLocation` placeholder (čeka da kontrolor odredi gde se deo smesti)
- Tipično: Završna Kontrola (`8.3`)

**Pravila za `uses_priority = true`:**
- Operacija je vidljiva u "Operativni plan" view-u sa polje prioriteta (100/255)
- Tehnolog može da postavi prioritet 100 (visok) za ovu operaciju u RN-u
- Operacije sa `uses_priority = false` se ne pojavljuju u sortiranju po prioritetu
- Tipično: sve operacije za proizvodnju (sečenje, struganje, glodanje, ...), ne za kontrolu

**Pravila za `is_skippable = true`:**
- Operacija može da se preskoci u tehnološkom postupku
- Primer: "Brušenje" je opcionalno ako je deo već zadovoljavajuće kvalitete posle glodanja
- Tehnolog u UI-ju "Tehnološki postupak za RN" može da označi operaciju kao "skip"

### 7.5 Worker × Machine matrix — implicit pravila

**Eksplicitno pravilo:**
- Ako MachineAccess za par (worker, operation) postoji → radnik može kucati

**Implicit pravilo (samo jedno, ne više tri kao u v1.0):**

**Radnici sa `worker_type = "NN"` mogu da kucaju OPŠTI NALOG bez MachineAccess**
   - `work_center_code = "0.0"` (Opšti nalog) je dostupna svim radnicima
   - Razlog: opšti nalog ne zahteva specijalnu obuku

**Šta sa Kontrolom i Inženjerima?**

V1.0 je predlagao da Kontrolor sa `additional_privileges = true` može kucati sve operacije. **V1.1 je ovo ispravio** — kontrolor kuca samo svoje (kontrolne) operacije. Logika za zatvaranje proizvodnje:

> Kontrolor kuca samo kontrolu, ali on time **zatvara ceo RN tehnološki postupak** jer ako je uradio završnu kontrolu, znači da je sve prethodno odrađeno bez obzira na eksplicitno kucanje.

To je **implicit closure pattern** koji se implementira u Production modul (Sprint 6), ne u Structures. Kad operacija sa `significant_for_finishing = true` bude kucna kao završena:

1. Operacija → `completed_at = now()`
2. **Sve prethodne nezatvorene operacije u istom RN-u** → auto-mark `completed_at = significant.completed_at`, `completed_by = "AUTO_BY_FINAL_CHECK"` u audit log
3. RN status → `COMPLETED`

Ovaj pattern eliminiše potrebu da Kontrolor kuca sve operacije unazad — automatski se zatvaraju kad on potvrdi završnu kontrolu.

**`additional_privileges = true` (Worker Type) znači šta:**

- **Smije da zatvori (potvrdi) tuđe operacije** — npr. ako majstor je već kucnuo svoj kraj, kontrolor smije da auto-zatvori sve uzlazno
- **Ne menja "ko šta sme kucati"** — to ostaje striktno po MachineAccess matrici

**Implementacija u service-u (Structures modul):**

```typescript
async canWorkerLogOperation(workerId: number, workCenterCode: string): Promise<boolean> {
  const worker = await this.prisma.worker.findUnique({
    where: { id: workerId },
    include: { workerType: true },
  });
  
  if (!worker.active) return false;
  
  // Implicit pravilo: NN tip može kucati Opšti nalog
  if (workCenterCode === '0.0' && worker.workerType.name === 'NN') {
    return true;
  }
  
  // Striktna provera MachineAccess tabele
  const access = await this.prisma.machineAccess.findFirst({
    where: { workerId, workCenterCode },
  });
  
  return !!access;
}

// Posebna metoda za "implicit closure" check (koristi se u Production modul, Sprint 6)
async canWorkerCloseOthersOperations(workerId: number): Promise<boolean> {
  const worker = await this.prisma.worker.findUnique({
    where: { id: workerId },
    include: { workerType: true },
  });
  
  return worker.workerType.additionalPrivileges === true;
}
```

---

## 8. UI tokovi

### 8.1 Forma: Unos/Pregled radnika

**Layout (PDF strana 18):**

```
[Header]
  Radnici | ID [___] | IDF [_]
  [Novi radnik] [✓ Snimi] [STOP]
  SERVOTEH

[Filteri]:
  Pronađi po imenu ili prezimenu [___▼]
  Za radnu jedinicu [Sečenje ▼]  Za vrstu posla [Majstor ▼]   [✓ Aktivan]
  
[Tabela]:
  | Šifra   | Skraćeno  | Ime i prezime  | ID kartice | Radna       | Aktivan | Vrsta    | Password    | Log account | Broj lične | Multi  | Definiše    | Definiše  |
  | radnika | ime       | radnika        |            | jedinica    |         | posla    |             |             | karte      | nalog  | saglasan    | lansiran  |
  | 0       | a         | Korisnik       | 0          | 00 - NN     | ✓       | NN       | ****        |             |            |        |             |           |
  | 74      | VA        | Jovica Milosević| 0002750623 | 00 - NN     | ✓       | Tehnolog | ****        | JovicaM    |            |        |             |           |
  | 5       | MilanB    | Breka Milan    | 0005748586 | 02-Struganje| ✓       | Majstor  |             |            |            |        |             |           |
  | 11      | Jota      | Orescanin Milos| 0001597027 | 05-Farbanje | ✓       | Majstor  |             |            |            | ✓      |             |           |
  | 12      | Cira      | Cirovic Predrag| 0005748558 | 02-Struganje| ✓       | Majstor  |             |            |            | ✓      |             |           |
  | 13      | Miljan    | Nikodijević Miljan|0001596834| 00 - NN     | ✓       | Tehnolog |             | MiljanN    |            |        |             |           |
  | ...
```

**Funkcionalnost:**

1. Grid sa svim radnicima, default filter `active = true`
2. Klikom na red → desni panel sa detaljima (edit mode)
3. "Novi radnik" → otvara prazan red u tabeli + edit dialog
4. Polja u edit dialogu:
   - Username * (mandatory, unique)
   - Full name * (mandatory)
   - ID kartice (unique)
   - Login account (unique ako postoji)
   - Work unit * (dropdown)
   - Worker type * (dropdown)
   - Permission flags (checkboxes: Defines Approval, Defines Launch, Multi-account)
   - Active checkbox
   - Signature image upload
   - **"Linkuj sa User-om"** dropdown (postojeći users bez worker-a)
5. "Snimi" → POST/PATCH API
6. Validacija u real-time (username uniqueness check kroz debounced API call)

### 8.2 Forma: Vrste poslova

**Layout (PDF strana 18):**

```
[Header]
  Vrste poslova
  [Nova vrsta posla] [STOP]

[Tabela]:
  | ID | Vrsta posla | Moguće zatvaranje tuđih naloga |
  | 0  | NN          | □                              |
  | 1  | Tehnolog    | □                              |
  | 2  | Majstor     | □                              |
  | 3  | Kontrola    | ✓                              |
  | 4  | Montaža     | □                              |
  | 5  | Inženjeri   | □                              |
```

**Funkcionalnost:**

- Lookup CRUD
- Edit u-grid (kao Excel)
- Validation: `name` unique

### 8.3 Forma: Unos/Pregled radnih jedinica

**Layout (PDF strana 19, levo):**

```
[Header]
  Unos/pregled radnih jedinica
  [Nova radna jedinica] [STOP]

[Tabela]:
  | Šifra | Radna jedinica   |
  | 00    | NN               |
  | 01    | Sečenje          |
  | 02    | Struganje        |
  | 03    | Glodanje         |
  | 04    | Bravari          |
  | ...
```

Lookup CRUD, edit u-grid.

### 8.4 Forma: Unos/Pregled operacija

**Layout (PDF strana 19, desno):**

```
[Header]
  Unos operacija po radnim jedinicama
  [Nova operacija] [STOP]

[Filter]:
  Pronađi šifru [___]   Za radnu jedinicu [Sečenje ▼]

[Tabela]:
  | Šifra | Opis                                            | Radna jedinica | Napomena                  | Bez      | Kraj      | Koristi   | Međufazni |
  |       |                                                 |                |                           | postupka | postupka  | prioritet | postupak  |
  | 0.0   | OPŠTI NALOG                                    | NN             | Opšti nalog za sve poslove| □        | □         | □         | □         |
  | 1.10  | Sečenje - Testera                              | Sečenje        |                           | □        | □         | ✓         | □         |
  | 1.2   | Makaze                                          | Sečenje        |                           | □        | □         | ✓         | □         |
  | 1.30  | Gasno                                           | Sečenje        |                           | □        | □         | ✓         | □         |
  | 2.4   | Struganje univerzalno (Krasni proleteri)       | Struganje      |                           | □        | □         | ✓         | □         |
  | 2.5   | CNC Struganje (GILDEMEISTER)                   | Struganje      |                           | □        | □         | ✓         | □         |
  | ...
```

**Funkcionalnost:**

- Filter po RJ
- 4 flag kolone (without_process, significant_for_finishing, uses_priority, is_skippable)
- Inline edit

### 8.5 Forma: Radnici po mašinama (matrica)

**Layout (PDF strana 20):**

```
[Header]
  Radnici raspoređeni po mašinama
  [Izdvoj radnike] [za radnu jedinicu ▼] [✓ Aktivne]
  SERVOTEH

[Levi panel - lista radnika]:
  ┌─ Pronađi radnika [___] ───┐
  ┌─ [Novi radnik] ────────────┐
  
  | Aktivan | ID | Ime i prezime radnika   | Nick name | ID kartice | Radna jedinica |
  | ✓       | 0  | Korisnik                | a         | 0          | 00 - NN        |
  | ✓       | 1  | Jarakovic Ilja          | Ilija     | 1          | 19 - Poslovođa |
  | ✓       | 74 | Jovica Milosević        | VA        | 0002750623 | 00 - NN        |
  | □       | 2  | Umicevic Milan          | Milan     | 2          | 19 - Poslovođa |
  | □       | 4  | Jarakovic Nenad         | Nenad     | 4          | 19 - Poslovođa |
  | ▸ 5     | Breka Milan             | MilanB    | 0005748586 | 02-Struganje   |  ← currently selected
  | □       | 6  | Durutovic Jelena        | Jelena    | 6          | 00 - NN        |
  | ...

[Desni panel - matrica za izabranog radnika]:
  Radnik: Breka Milan
  
  | ID   | Radnik       | Mašina                                      | Napomena                |
  | 11   | Breka Milan  | 2.1 - Struganje univerzalno (Prvomajska TNP250) |                     |
  | 12   | Breka Milan  | 2.5 - CNC Struganje (GILDEMEISTER)         |                         |
  | 13   | Breka Milan  | 6.3 - Brušenje - Ravno (Geibel Hotz)       |                         |
  | 173  | Breka Milan  | 2.6 - CNC Struganje (EMCO)                 |                         |
  | 175  | Breka Milan  | 0.0 - OPŠTI NALOG                          |                         |
  | 236  | Breka Milan  | 6.1.1 - Brušenje-Spoljno kružno (STUDER)   |                         |
  | 237  | Breka Milan  | 6.1.2 - Brušenje otvora (STUDER)           |                         |
  | 244  | Breka Milan  | 3.12 - CNC Glodanje (DMU 50T) MillPlus     |                         |
  | ...
  
  [+ Dodaj operaciju...] (modal sa listom svih operacija sa checkbox-ima)
  [Bulk akcije: Označi sve operacije iz RJ ▼]
```

**Funkcionalnost:**

1. Levo: lista radnika sa search/filter
2. Desno: matrica za izabranog radnika (sve operacije koje sme da kuca)
3. "Dodaj operaciju" → modal sa **stablo prikaz** operacija (RJ → operacije unutar RJ), checkbox za svaku
4. Bulk akcije: "Označi sve operacije iz RJ X" (npr. svi struganje radnici dobiju sve struganje operacije)
5. Inline note polje za svaki MachineAccess entry

---

## 9. Test scenariji

### 9.1 Unit testovi

**Test 1: Worker create with valid data**
- Action: POST /workers sa svim mandatory poljima
- Expect: 201, worker kreiran, `active = true` by default

**Test 2: Worker username uniqueness**
- Setup: postoji worker sa username "MilanB"
- Action: POST /workers sa istim username
- Expect: 409 Conflict

**Test 3: Permission flag validation (Pravilo 1)**
- Setup: worker tipa "Majstor"
- Action: PATCH /workers/:id sa `definesApproval: true`
- Expect: 400, error code "WORKER_TYPE_NOT_ELIGIBLE_FOR_APPROVAL"

**Test 4: defines_launch zahteva defines_approval**
- Action: PATCH worker sa `definesLaunch: true, definesApproval: false`
- Expect: 400, error code

**Test 5: Operation work_center_code uniqueness**
- Setup: postoji operacija sa work_center_code "1.10"
- Action: POST /operations sa istim
- Expect: 409 Conflict

**Test 6: MachineAccess unique constraint**
- Setup: postoji MachineAccess (worker=11, operation=2.1)
- Action: POST opet sa istim parom
- Expect: 409 Conflict

**Test 7: Implicit permission — NN može opšti nalog bez MachineAccess**
- Setup: worker tipa "NN", bez MachineAccess
- Action: canWorkerLogOperation(workerId, "0.0")
- Expect: true

**Test 8a: Kontrolor NE može kucati struganje bez MachineAccess (v1.1)**
- Setup: worker tipa "Kontrola" sa additional_privileges=true, bez MachineAccess za 2.5
- Action: canWorkerLogOperation(workerId, "2.5")
- Expect: false (striktna provera MachineAccess matrice)

**Test 8b: Kontrolor MOŽE da zatvori tuđe operacije (additional_privileges flag) (v1.1)**
- Setup: worker tipa "Kontrola" sa additional_privileges=true
- Action: canWorkerCloseOthersOperations(workerId)
- Expect: true

**Test 8c: Majstor NE može zatvarati tuđe operacije**
- Setup: worker tipa "Majstor" (additional_privileges=false)
- Action: canWorkerCloseOthersOperations(workerId)
- Expect: false

### 9.2 Integration testovi

**Test 9: GET /workers sa filterima**
- Setup: 100 radnika, 30 sa worker_type=Majstor, 70 sa drugim
- Action: GET /workers?worker_type_id=2
- Expect: 30 redova

**Test 10: Worker soft delete**
- Action: DELETE /workers/:id
- Expect: worker.active = false, ali zapis postoji

**Test 11: Workers/inactive endpoint**
- Setup: 10 aktivnih, 5 neaktivnih
- Action: GET /workers (default), zatim GET /workers/inactive
- Expect: prvi vraća 10, drugi vraća 5

**Test 12: Batch machine access**
- Setup: worker bez MachineAccess
- Action: POST /machine-access/batch sa `addOperations: ["1.10", "2.1", "3.40"]`
- Expect: 3 MachineAccess entry-ja kreirana atomarno

**Test 13: Link User → Worker**
- Setup: User i Worker postoje, oba bez veze
- Action: POST /workers/:id/link-user sa userId
- Expect: users.worker_id = id, GET /workers/:id vraća linkedUserId

**Test 14: Unique link constraint**
- Setup: User #42 već povezan sa Worker #11
- Action: POST /workers/12/link-user sa userId=42
- Expect: 409 Conflict (User može biti vezan samo za jednog Worker-a)

### 9.3 E2E testovi

**Test 15: Admin kreira novog radnika kroz UI**
- Login (admin) → /strukture/radnici → "Novi radnik" → popuni formu → "Snimi"
- Expect: worker u tabeli, success notification

**Test 16: Admin dodeljuje operacije radniku**
- Login (admin) → /strukture/radnici-po-masinama → izaberi worker u levom panelu → klikni "Dodaj operaciju" → izaberi 3 operacije → "Save"
- Expect: 3 MachineAccess entry-ja u tabeli za tog worker-a

---

## 10. Cursor instrukcije za implementaciju

### 10.1 Sprint 2 — Backend

```
Implementacija Production Structures modula za Servosync (Sprint 2 po ARCHITECTURE.md, v1.1).

VAŽNO — Sprint sequencing pretpostavka:
- Sprint 1 (BigBit Sync) je VEĆ izvršen i popunjava sledeće tabele iz BigBit-a:
  * work_units (iz tRadneJedinice)
  * worker_types (iz tVrsteRadnika)
  * operations (iz tOperacije)
  * workers (iz tRadnici)
  * machine_access (iz tPristupMasini)
- Sprint 2 NE dodaje seed data za ove tabele — one su već popunjene
- Sprint 2 dodaje samo NestJS CRUD endpoint-e + UI + business logic (permission rules, access checker)

Kontekst:
- Pročitaj docs/ARCHITECTURE.md i docs/MODULE_SPEC_structures.md (v1.1)
- Pročitaj docs/MODULE_SPEC_bigbit_sync.md (v1.1) — za razumevanje šta sync donosi
- Prisma šema već sadrži: Worker, WorkUnit, Operation, WorkerType, MachineAccess

Cilj Sprinta 2:
- NestJS CRUD endpoint-i za 5 tabela
- Migracija koja dodaje users.worker_id FK (sekcija 5.3)
- Migracije za unique constraints (sekcija 7.2)
- Business logic services: PermissionValidator, AccessCheckerService
- Unit i integration testovi (sekcija 9)

Konkretno uradi:

1. Migration: Add users.worker_id
   - Dodaj nullable workerId Int? @unique kolonu u User model
   - FK ka Worker sa onDelete: SetNull
   - Update Worker model sa user: User? relacijom

2. Migration: Unique constraints (ako nisu već postavljeni)
   - workers.username UNIQUE
   - workers.card_id UNIQUE (where not null)
   - workers.login_account UNIQUE (where not null)
   - machine_access (worker_id, work_center_code) UNIQUE

3. NE pisi seed data — one dolaze iz Sprint 1 sync-a
   - Validation: pre Sprint 2 start-a, proveri da li su tabele popunjene preko `GET /sync/state` API-ja
   - Ako su tabele prazne, pokreni Sprint 1 sync prvo (`POST /sync/run`)

4. Kreiraj NestJS module (isto kao u v1.0):
   - workers, work-units, operations, worker-types, machine-access

5. Implementiraj endpoint-e prema sekciji 6

6. Permission validation (sekcija 7.3):
   - PermissionValidator service
   - validateApprovalPermission()
   - validateLaunchPermission()

7. Access checker (sekcija 7.5 v1.1 — POJEDNOSTAVLJEN):
   - AccessCheckerService.canWorkerLogOperation(workerId, workCenterCode)
   - SAMO jedno implicit pravilo (NN tip + opšti nalog 0.0)
   - Striktna provera MachineAccess matrice za sve ostalo
   - Posebna metoda: canWorkerCloseOthersOperations(workerId) — vraća worker.workerType.additionalPrivileges (za Sprint 6 implicit closure)

8. Auth pravila, validation, audit log — kao v1.0

9. Testovi (sekcija 9):
   - 8 unit testova
   - 6 integration testova
   - 2 E2E testa
   
   PAŽNJA — Test 8 (Kontrola može sve) je UKLONJEN u v1.1. Umesto njega:
   - Test 8': "Kontrolor NE može kucati struganje bez MachineAccess"
     - Setup: worker tipa "Kontrola", bez MachineAccess za 2.5
     - Action: canWorkerLogOperation(workerId, "2.5")
     - Expect: false
   - Test 8'' (novi): "Kontrolor može da zatvori tuđe operacije"
     - Setup: worker tipa "Kontrola" sa additional_privileges=true
     - Action: canWorkerCloseOthersOperations(workerId)
     - Expect: true

10. Swagger, performance — kao v1.0

Ne menjaj:
- BigBit sync modul (Sprint 1) — samo koristi njegove tabele
- Auth modul (Sprint 0) — samo dodaj workerId polje u User

Posle implementacije:
- npm run test, all green
- Otvori PR "feat(structures): implement Sprint 2 per MODULE_SPEC_structures.md v1.1"
```

### 10.2 Sprint 2 — Frontend

Glavne stranice:

- `/strukture/radnici/page.tsx` — Lista i CRUD radnika
- `/strukture/vrste-poslova/page.tsx` — Worker types CRUD
- `/strukture/radne-jedinice/page.tsx` — Work units CRUD
- `/strukture/operacije/page.tsx` — Operations CRUD
- `/strukture/radnici-po-masinama/page.tsx` — Matrica

Komponente:

- `<WorkerForm />` — modal/sidebar za create/edit
- `<WorkerSignatureUpload />` — image upload za potpis
- `<MachineAccessMatrix />` — dvodelni layout (radnici levo, operacije desno)
- `<OperationsFlagsEditor />` — inline edit za flags
- `<UserLinkDropdown />` — dropdown za vezivanje Worker sa User

Hooks:
- useWorkers, useWorker, useCreateWorker, useUpdateWorker, useDeleteWorker, useLinkUser
- useWorkUnits, useOperations, useWorkerTypes
- useMachineAccess, useMachineAccessByWorker, useBulkUpdateAccess

---

## 11. Open questions / decisions

### Resolved u v1.1

**Q1: Tačan spisak Operations — RESOLVED**

**Nalaz:** Sve operacije postoje u BigBit `tOperacije` tabeli (~70 entry-ja). Schema je identična sa Lukinim `Operation` modelom.

**Odluka v1.1:** Sync iz BigBit-a kroz prošireni Sprint 1 (MODULE_SPEC_bigbit_sync.md v1.1, sekcija 3.3). Sprint 2 pretpostavlja da je tabela već popunjena.

**Q2: Tačan spisak WorkerTypes — RESOLVED**

**Nalaz:** Postoji `tVrsteRadnika` u BigBit-u sa `IDVrsteRadnika`, `VrstaRadnika`, `DodatnaOvlascenja` kolonama. Schema mapira se 1:1 u `worker_types`.

**Odluka v1.1:** Sync iz BigBit-a kroz prošireni Sprint 1. Tačan spisak će biti vidljiv posle prvog sync run-a.

**Q3: Šta sa `workers.password` i `workers.worker_password` legacy poljima — RESOLVED**

**Nalaz:** Oba polja postoje u BigBit `tRadnici` tabeli kao plain text:
- `Password` (nvarchar 20) — login za QMegaTeh Access aplikaciju
- `PasswordRadnika` (nvarchar 50) — PIN za bar-kod stanice u proizvodnji

**Odluka v1.1:**
- **V1:** Polja se migriraju kroz sync (real data postoji), ali se **NE koriste u aplikaciji**. Sva auth ide kroz `users.password_hash` (bcrypt).
- **Bar-kod identifikacija (V2/V3):** `card_id` (bar-kod ID) + opcionalan PIN preko `worker_password`. Radnik provuče karticu → auto-fill card_id → ukucava PIN za potvrdu.
- **V2:** Deprecate oba polja, ukloniti iz šeme.

**Q4: Implicit permission rules — RESOLVED**

**Nalaz + Servoteh business pattern:** Kontrolor sa `additional_privileges = true` kuca **samo svoje operacije** (Završna Kontrola). MEĐUTIM, kucanje završne kontrole ima **implicit closure semantiku** za ceo tehnološki postupak:

> "Kontrolor kuca samo kontrolu, ali on time zatvara proizvodnju do tog RN tehnološkog postupka jer ako je uradio završnu kontrolu znači da je sve prethodno odrađeno bez obzira na kucanje."

**Odluka v1.1:**

Worker × Operation matrica — striktna (ko šta sme kucati):

```typescript
async canWorkerLogOperation(workerId: number, workCenterCode: string): Promise<boolean> {
  const worker = await this.prisma.worker.findUnique({
    where: { id: workerId },
    include: { workerType: true },
  });
  
  if (!worker.active) return false;
  
  // Implicit pravilo 1: NN tip može kucati Opšti nalog (0.0)
  if (workCenterCode === '0.0' && worker.workerType.name === 'NN') {
    return true;
  }
  
  // Eksplicitno pravilo: provera MachineAccess tabele
  const access = await this.prisma.machineAccess.findFirst({
    where: { workerId, workCenterCode },
  });
  
  return !!access;
}
```

**Implicit closure pravilo (Sprint 6):**

Implementira se u **Production modul, ne u Structures**. Kad radnik sa `worker_type = Kontrola` zaključi operaciju koja ima `significant_for_finishing = true`:

1. Operacija se markira `completed_at = now()`
2. **Sve prethodne operacije u tom RN-u (po prioritet/redosled)** koje još nisu zatvorene → auto-mark `completed_at = significant_operation.completed_at`, `completed_by = "AUTO_BY_FINAL_CHECK"`
3. RN status → `COMPLETED`
4. PartLocation placeholder se kreira (čeka kontrolora da odluči gde se deo smesti)

Ovo je **business pattern documented** ovde, ali implementacija ide u Sprint 6 (Production module).

**Q5: Bulk import radnika iz BigBit-a — RESOLVED**

**Odluka v1.1:** Pokriva Sprint 1 BigBit sync sa proširenim skopom. Sve postojeće radnike (~100-200) povlači iz `tRadnici` automatski.

**Q6: Operation `priority` semantics — RESOLVED**

**Odluka v1.1:** `uses_priority = true` znači:
- (a) Polje "Prioritet" je **vidljivo u UI** za tu operaciju u RN-u
- (b) Vrednosti: 100 = visok prioritet, 255 = default
- (c) Operacija učestvuje u sortiranju u "Operativnom planu" view-u (Sprint 6)
- (d) Operacije sa `uses_priority = false` (npr. Kontrola) imaju fiksni redosled

Implementacija sortiranja ide u Sprint 6 (Production module). Sprint 2 samo nasleđuje polje iz BigBit-a kroz sync.

**Q7: Signature image storage — RESOLVED**

**Odluka v1.1:**
- **V1:** Lokalni FS na Servoteh on-prem serveru:
  ```
  /var/servosync/signatures/{worker_id}.jpg
  ```
- Nginx/Caddy serve-uje direktno (static files)
- NestJS endpoint `POST /workers/:id/signature` prima multipart upload (max 500 KB JPG)
- `workers.signature_image` čuva relativnu putanju
- **V2:** S3-compatible storage (MinIO za on-prem) ako bude trebalo

### Open za V1 implementation

**Q8: Da li sync iz BigBit-a treba da bude inicijalni one-time (pre Sprint 2) ili kontinuiran (cron 02:00)?**

**Preporuka:** Oba. Inicijalni full refresh **pre Sprint 2** (jednokratni). Posle toga kontinuiran cron sa strategijama iz MODULE_SPEC_bigbit_sync.md v1.1 sekcija 4.1.

**Q9: Servoteh-specific edge case — može li jedan radnik pripadati u 2 radne jedinice?**

Iz PDF-a strana 18 vidim `work_unit_code` kao single FK na worker-u. Ali ako je radnik fleksibilan (npr. radi i struganje i glodanje), kako se to evidentira?

**Predlog:** Primary `work_unit_code` (njegova matična RJ) + `MachineAccess` matrica koja može uključiti operacije iz drugih RJ. Tako radnik može da kuca van svoje primarne RJ ako ima access.

Potvrditi sa Vasom da li ovo pokriva sve realne scenarije.

---

## 12. Reference

- `BB_Tehnologija_opis.pdf` — strane 18-20 (Proizvodne strukture)
- `legacy/QMegaTeh_Reference.md` — sekcija o Proizvodnim strukturama u VBA kodu
- `schema.prisma`:
  - Worker, WorkUnit, Operation, WorkerType, MachineAccess
  - User (za worker_id veza koja se dodaje)
- `schema-rename-map.md` — legacy → Postgres mapping
- VBA moduli za referenc:
  - `Form_Radnici` (CRUD form za radnike)
  - `Form_VrstePoslova`, `Form_UnosRadnihJedinica`, `Form_OperacijePoRadnimJedinicama`, `Form_RadniciPoMasinama`

---

## 13. Verzija

| Verzija | Datum | Šta se promenilo |
|---|---|---|
| 1.0 | maj 2026 | Inicijalna specifikacija Production Structures modula za V1 |
| 1.1 | maj 2026 | **Resolved 6 od 7 Open Questions** kroz mapping na BigBit tabele i pristup sa Vasom: Q1, Q2, Q5 → prebačeno na Sprint 1 sync (MODULE_SPEC_bigbit_sync.md v1.1 prošireni skop); Q3 → legacy password polja u šemi ali ne korišćena u kodu; Q4 → kontrolor kuca SAMO svoje operacije, ali `additional_privileges` flag omogućava "implicit closure" celog RN postupka pri završnoj kontroli (pattern dokumentovan ovde, implementira se u Sprint 6); Q6 → uses_priority semantika dokumentovana (vidljivost + sortiranje, 100/255); Q7 → signature image storage na lokalni FS `/var/servosync/signatures/`. Implicit pravilo u sekciji 7.5 smanjeno sa 3 na 1 (samo NN tip može Opšti nalog 0.0). Dodato novo open pitanje Q9 o multi-RJ radnicima. |

---

*Kraj MODULE_SPEC_structures.md*

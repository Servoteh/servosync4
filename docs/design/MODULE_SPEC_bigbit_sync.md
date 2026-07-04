# Servosync — Module Spec: BigBit Sync

| | |
|---|---|
| **Modul** | BigBit Sync (master data integration) |
| **Verzija specifikacije** | 1.1 |
| **Datum** | maj 2026 |
| **Sprint** | 1 (po ARCHITECTURE.md planu) |
| **Korisnik modula** | Sistem (admin manualni trigger + automatski cron) |
| **Status** | Specifikacija za implementaciju |

---

## 0. Kako koristiti ovaj dokument

Ovo je specifikacija prvog **integracionog modula** u Servosync sistemu — sync sa BigBit SQL Server-om. Kreira se u Sprintu 1, odmah posle Sprinta 0 foundation, jer **svi ostali moduli zavise od master podataka** koje ovaj modul donosi (Customer, Project, Item, Warehouse, TaxRate, ItemGroup, Salesperson).

Bez BigBit sync-a, PDM modul može da postoji ali ne može da prikaže kupca crteža, RN ne može da se vezuje za predmet, MRP ne može da računa potrebe bez katalog artikala.

**Pre čitanja:**
- `ARCHITECTURE.md` — strateški kontekst
- `schema.prisma` — `BbSyncLog`, `BbSyncState`, plus target tabele (`Customer`, `Project`, ...)
- `legacy/QMegaTeh_Reference.md` — **Dodatak E (Master-data sync iz BigBit-a)** — detaljan opis trenutnog stanja
- Sekcija 16.5 u `QMegaTeh_Reference.md` — Master-data sync flow dijagram

---

## 1. Cilj modula

**Šta BigBit Sync radi:**

Sinhronizuje **master podatke iz BigBit ERP sistema** u Servosync Postgres bazu. Sync je **jednosmeran** (BigBit → Servosync) i **read-only sa BigBit strane** — Servosync ne piše ništa nazad u BigBit.

**Zašto je potreban:**

BigBit je vendor-održavan ERP sistem koji čuva centralne poslovne podatke (komitenti, artikli, predmeti, knjigovodstvo, fakture). Servoteh ga koristi za sve što nije proizvodnja (računovodstvo, PDV, fakture, KEPU). Servosync se kači na BigBit kao master-data izvor i koristi te podatke za proizvodne procese.

**Bez sync-a, scenario:**
- Komercijala otvori novi predmet u BigBit-u → tehnolog hoće da otvori RN za taj predmet u Servosync-u → ne može jer Servosync ne zna za predmet
- Konstruktor doda novi artikal u BigBit katalog → MRP ne može da rezerviše tu komponentu jer Servosync nema zapis o artiklu

**Sa sync-om, scenario:**
- Sync se izvrši (manualno ili automatski) → Servosync ima ažurne komitente, predmete, artikle → RN, PDM, MRP rade bez problema

**Strategija (odlučeno):**

**Pristup B** — NestJS servis koji koristi `mssql` paket za read-only konekciju ka BigBit SQL Server-u. Servis povlači delte (incremental), upsert-uje u Postgres preko Prisma. Trigger: manualni kroz UI dugme ili automatski cron.

---

## 2. Skop modula

### 2.1 Šta se sync-uje (iz BigBit-a u Servosync)

**Commercial / ERP master data (komitenti, predmeti, artikli...):**

| # | Target tabela | Legacy BigBit izvor | Pretpostavljen broj zapisa | Učestalost |
|---|---|---|---|---|
| 1 | `customers` | `Komitenti` | 1.000 - 5.000 | Često (novi kupci nedeljno) |
| 2 | `projects` | `Predmeti` | 500 - 2.000 | Često (novi predmeti dnevno) |
| 3 | `salespeople` | `Prodavci` | 20 - 50 | Retko |
| 4 | `items` | `R_Artikli` | 10.000 - 50.000 | Vrlo često (novi artikli stalno) |
| 5 | `warehouses` | `Magacini` | 5 - 20 | Retko |
| 6 | `tax_rates` | `R_Tarife` | 3 - 10 | Vrlo retko |
| 7 | `item_groups` | `R_Grupa` | 30 - 100 | Retko |
| 8 | `item_subgroups` | `R_Podgrupa` | 50 - 300 | Retko |

**Production master data (radnici, operacije, RJ — DODATO u v1.1):**

| # | Target tabela | Legacy BigBit izvor | Pretpostavljen broj zapisa | Učestalost |
|---|---|---|---|---|
| 9 | `work_units` | `tRadneJedinice` | 20 - 30 | Vrlo retko (nova RJ nastaje kad se otvori novi pogon) |
| 10 | `worker_types` | `tVrsteRadnika` | 5 - 10 | Vrlo retko |
| 11 | `operations` | `tOperacije` | 50 - 100 | Retko (kad se kupi nova mašina) |
| 12 | `workers` | `tRadnici` | 80 - 200 | Često (zaposlenja, otkazi) |
| 13 | `machine_access` | `tPristupMasini` | 500 - 2.000 | Često (kad se radnik kvalifikuje za novu mašinu) |

**Zašto su production master data u sync-u:**

Ranija pretpostavka (v1.0) je bila da production master data unosimo manualno u Servosync. Sa pristupom v1.1:
- BigBit i Servosync **dele radnike i operacije** dok god QMegaTeh radi paralelno sa Servosync-om (cutover period)
- Vendor BigBit-a dodaje nove operacije kad Servoteh kupi novu mašinu — sync ih automatski povlači
- Nema rizika od "razilaženja" radnika između dva sistema u paralelnom radu
- Migracija postojećih ~100 radnika i ~70 operacija je trivijalna

**Šta se NE sync-uje (van skopa, čak i v1.1):**

- `WorkOrder` (RN) — Servosync je vlasnik production workflow-a, BigBit ima legacy podatke koji se ne sinhronizuju
- `WorkOrderOperation` (operacije po RN-u) — production data, ne master
- `PartLocation` — Servosync vlasništvo
- `HandoverDraft`, `DrawingHandover` — Servosync vlasništvo (workflow)

### 2.2 Šta se NE sync-uje (van skopa)

**Ne sync-ujemo iz BigBit-a:**
- Robna dokumenta (T_Robna dokumenta, T_Robne stavke) — knjigovodstvene transakcije, čitaju se on-demand
- Glavna knjiga, fakture, KEPU, POPDV — knjigovodstvo ostaje u BigBit-u
- Otvorene stavke, IOS, kompenzacije — finansija
- Cenovnici — Servoteh proizvodnja koristi sopstvene cenovnike (price_list_entries je već u šemi)
- Konobari, fiskal — POS funkcionalnost, irelevantna

**Ne sync-ujemo iz Servosync-a ka BigBit-u (write-back):**
- Ništa u V1. Sync je strogo jednosmeran.
- V2 razmotri: kreiranje komitenta u Servosync-u kroz nov RN flow — možda treba propagirati nazad u BigBit. Ali to nije u skopu V1.

### 2.3 Sync triger-i

| Trigger | Učestalost | Šta okida |
|---|---|---|
| **Manual** | Po potrebi | Admin klikne "Sync from BigBit" dugme u UI |
| **Cron** | Svako jutro 02:00 | Svi entiteti incremental |
| **API** | Po potrebi | Drugi servisi (npr. RN modul) mogu da okidaju targeted sync (samo customers ili samo projects) |

---

## 3. Tabele koje koristi

### 3.1 Application-owned tabele (sync metadata)

**`bb_sync_log`** — istorija svih sync run-ova

Definicija je u `schema.prisma`:
- `id` (Int PK)
- `started_at`, `finished_at` — vremenski opseg
- `status` (`running`, `success`, `failed`, `partial`)
- `trigger` (`manual`, `cron`, `api`)
- `triggered_by_user_id` (FK → users, SetNull on delete)
- `entity_scope` (String — npr. `customers`, `items`, `all_incremental`)
- `rows_fetched`, `rows_upserted`, `rows_skipped` (Int counters)
- `error_message` (Text)
- `metadata` (JSONB — fleksibilno za dodatne info)

**`bb_sync_state`** — cursor po entitetu

- `entity` (String PK) — npr. `customers`, `items`
- `cursor` (JSONB) — opaque cursor, oblik zavisi od entiteta:
  - Za entitete sa timestamp kolonom: `{"lastModifiedAt": "2026-05-12T14:30:00Z"}`
  - Za entitete sa autoincrement ID-jem bez timestamp-a: `{"lastId": 12345}`
  - Za entitete sa SQL Server rowversion: `{"lastRowversion": "0x00000000001A2F45"}`
  - Za entitete sa full refresh: `{"strategy": "full_refresh"}`
- `last_success_at` — kad je poslednji uspešan sync
- `last_attempt_at` — kad je poslednji pokušaj (uključujući fail)
- `last_error_message` — error message ako poslednji attempt failed
- `last_success_sync_log_id` (FK → bb_sync_log) — link na konkretan log entry

### 3.2 Target tabele (Servosync vlasništvo, ali populated iz BigBit-a)

Svaka od ovih tabela ima sledeće zajedničke kolone:
- `legacy_sifra` (ili sličan legacy identifier) — original primary key iz BigBit-a
- `synced_from_bigbit` (Boolean, default true) — flag za buduće razdvajanje (kad neko ručno kreira customer-a u Servosync-u, ovo je false)
- `last_synced_at` (Timestamp) — kad je ovaj zapis poslednji put sync-ovan

**`customers`** (Customer model u Prisma) — komitenti

Mapping kolona iz BigBit `Komitenti`:

| BigBit kolona | Postgres kolona | Komentar |
|---|---|---|
| `Sifra` | `legacy_sifra` | Original PK iz BigBit-a, unique |
| `Naziv` | `name` | Maks 255 chars |
| `Mesto` | `city` | |
| `Adresa` | `address` | |
| `[Postanski broj]` | `postal_code` | Razmak u nazivu → snake_case |
| `Drzava` | `country` | |
| `Telefon` | `phone` | |
| `Fax` | `fax` | |
| `Email` | `email` | |
| `Mobilni` | `mobile` | |
| `[Web adresa]` | `web_address` | |
| `PIB` | `pib` | Ako je NULL u BigBit, generiše se placeholder `XX_<sifra>` |
| `PDVStatus` | `vat_status` | |
| `Region` | `region` | |
| `[Ziro racun_1]`, `[Ziro racun_2]`, `[Ziro racun_3]` | `bank_account_1`, `bank_account_2`, `bank_account_3` | |
| `Kontakt` | `contact_name` | |
| `[Vrsta sifre]` | `code_type_id` (FK) | Lookup u `code_types` |
| `RabatKomitenta` | `discount_percentage` | |

**`projects`** (Project model) — predmeti

Mapping iz BigBit `Predmeti`:

| BigBit kolona | Postgres kolona |
|---|---|
| `IDPredmet` | `legacy_id_predmet` (unique) |
| `BrojPredmeta` | `project_number` |
| `Opis` | `description` |
| `NazivPredmeta` | `project_name` |
| `DatumOtvaranja` | `opened_at` |
| `DatumZakljucenja` | `closed_at` |
| `IDProdavac` | `salesperson_id` (FK → salespeople) |
| `IDKomitent` | `customer_id` (FK → customers) |
| `Status` | `status` |
| `BrojUgovora` | `contract_number` |
| `DatumUgovora` | `contract_date` |
| `RJ` | `work_unit_code` |
| `DevValuta` | `currency_code` |
| `Kurs` | `exchange_rate` |

**`items`** (Item model) — artikli iz kataloga

Mapping iz BigBit `R_Artikli`:

| BigBit kolona | Postgres kolona |
|---|---|
| `IDArtikla` ili `Sifra` | `legacy_id` (unique) |
| `Naziv` | `name` |
| `Sifra` | `catalog_number` |
| `IDGrupa` | `item_group_id` (FK) |
| `IDPodgrupa` | `item_subgroup_id` (FK) |
| `IDTarifa` | `tax_rate_id` (FK) |
| `JediniceMere` | `unit_of_measure` |
| `KataloskaCena` | `catalog_price` |
| `[is_procurement_item]` | `is_procurement_item` | Da li je nabavni artikal |

**`salespeople`** (Salesperson model) — prodavci/komercijalisti

Mapping iz BigBit `Prodavci`:

| BigBit | Postgres |
|---|---|
| `[Sifra prodavca]` | `legacy_code` |
| `Prodavac` | `username` |
| `ImeProdavca` | `full_name` |
| `Email` | `email` |
| `Telefon` | `phone` |
| `Aktivan` | `is_active` |
| `Region` | `region` |

**`warehouses`** (Warehouse model) — magacini

Mapping iz BigBit `Magacini`:

| BigBit | Postgres |
|---|---|
| `Sifra` | `legacy_sifra` |
| `Naziv` | `name` |
| `Mesto` | `location` |
| `Tip` | `warehouse_type` |

**`tax_rates`** (TaxRate model) — PDV tarife

Mapping iz BigBit `R_Tarife`:

| BigBit | Postgres |
|---|---|
| `IDTarifa` | `legacy_id` |
| `Naziv` | `name` |
| `Stopa` | `rate_percentage` |
| `Aktivna` | `is_active` |

**`item_groups`, `item_subgroups`** — grupe i podgrupe artikala

Standardna mappings iz `R_Grupa` i `R_Podgrupa`.

### 3.3 Production master data tabele (DODATO u v1.1)

**`work_units`** (WorkUnit model) — radne jedinice (RJ)

Mapping iz BigBit `tRadneJedinice`:

| BigBit kolona | Postgres kolona | Komentar |
|---|---|---|
| `ID` (auto int) | `id` (auto int) | Auto-increment |
| `IDRadneJedinice` (nvarchar 5) | `code` (varchar 5) | Šifra ("00", "01", "02", ...) |
| `RadnaJedinica` (nvarchar 50) | `name` (varchar 50) | Naziv |

**`worker_types`** (WorkerType model) — vrste poslova

Mapping iz BigBit `tVrsteRadnika`:

| BigBit kolona | Postgres kolona |
|---|---|
| `IDVrsteRadnika` | `id` |
| `VrstaRadnika` | `name` |
| `DodatnaOvlascenja` | `additional_privileges` |

**`operations`** (Operation model)

Mapping iz BigBit `tOperacije`:

| BigBit kolona | Postgres kolona |
|---|---|
| `IDOperacije` | `id` |
| `RJgrupaRC` | `work_center_code` (UNIQUE) |
| `NazivGrupeRC` | `work_center_name` |
| `Napomena` | `note` |
| `IDRadneJedinice` | `work_unit_code` |
| `BezPostupka` | `without_process` |
| `ZnacajneOperacijeZaZavrsen` | `significant_for_finishing` |
| `KoristiPrioritet` | `uses_priority` |
| `PreskocivaOperacija` | `is_skippable` |

**`workers`** (Worker model)

Mapping iz BigBit `tRadnici`:

| BigBit kolona | Postgres kolona | Komentar |
|---|---|---|
| `SifraRadnika` (int) | `id` | PK (matching auto-increment) |
| `Radnik` | `username` | UNIQUE |
| `ProcenatZaObracun` | `commission_percent` | Provizija |
| `ImeIPrezime` | `full_name` | |
| `BrLkRadnika` | `id_number` | Broj lične karte |
| `Password` | `password` | **LEGACY** — ne koristi se u aplikaciji (vidi sekcija 5 u MODULE_SPEC_structures.md) |
| `Aktivan` | `active` | Soft delete flag |
| `IDRadneJedinice` | `work_unit_code` | FK preko code na work_units |
| `IDKartice` | `card_id` | Bar-kod ID, UNIQUE |
| `LogAcc` | `login_account` | Web app username, UNIQUE if not null |
| `IDVrsteRadnika` | `worker_type_id` | FK na worker_types |
| `PotpisSlika` | `signature_image` | Putanja do JPG |
| `DefiniseSaglasan` | `defines_approval` | Permission flag |
| `DefiniseLansiran` | `defines_launch` | Permission flag |
| `MultiNalog` | `multi_account` | |
| `PasswordRadnika` | `worker_password` | **LEGACY** PIN za bar-kod |

**`machine_access`** (MachineAccess model) — matrica radnik × mašina

Mapping iz BigBit `tPristupMasini`:

| BigBit kolona | Postgres kolona |
|---|---|
| `IDPristupMasini` | `id` |
| `SifraRadnika` | `worker_id` (FK → workers) |
| `RJgrupaRC` | `work_center_code` (FK → operations.work_center_code) |
| `Napomena` | `note` |

UNIQUE constraint: `(worker_id, work_center_code)`.

### 3.4 Application-owned tabele (sync metadata)

(Premeštena originalna sekcija 3.1 niže)

---

## 4. Strategije inkrementalnog sync-a

### 4.1 Strategija po entitetu

Različite BigBit tabele imaju različite "watermark" kolone. Strategija sync-a se bira prema dostupnosti kolona:

**Commercial master data:**

| Entitet | Strategija | Razlog |
|---|---|---|
| `customers` | **Timestamp + ID composite cursor** | Verovatno postoji `DatumIzmene` ili `LastModified` kolona. Cursor: `{"lastModifiedAt": "...", "lastId": N}` |
| `projects` | **Timestamp + ID composite cursor** | Slično |
| `items` | **Timestamp + ID composite cursor** | Vrlo bitno za performanse — 50.000+ zapisa |
| `salespeople` | **Full refresh** | Mali skup (50 zapisa), uvek sync sve |
| `warehouses` | **Full refresh** | Vrlo mali skup |
| `tax_rates` | **Full refresh** | Vrlo mali skup |
| `item_groups`, `item_subgroups` | **Full refresh** | Mali skup, retko se menjaju |

**Production master data (DODATO u v1.1):**

| Entitet | Strategija | Razlog |
|---|---|---|
| `work_units` | **Full refresh** | ~25 zapisa, retko menjano |
| `worker_types` | **Full refresh** | ~6 zapisa, gotovo nikad menjano |
| `operations` | **Full refresh** | ~70 zapisa, povremeno nove operacije |
| `workers` | **ID watermark + weekly full refresh** | ~100-200 zapisa. Nove se dodaju, ali UPDATE (npr. promena `defines_approval` flag-a) je čest — zato weekly full refresh kao backup |
| `machine_access` | **Full refresh** | ~1.000-2.000 zapisa, ali često se menja per worker — full refresh je sigurniji od pokušaja delta sync-a |

**Cursor format primer (composite):**

```json
{
  "lastModifiedAt": "2026-05-12T14:30:00.000Z",
  "lastId": 12345
}
```

Razlog za composite: ako u istom milisekundi su izmenjena 2 reda, koristimo ID kao tiebreaker da ne preskočimo nijedan.

**SQL upit za incremental:**

```sql
SELECT TOP 1000 *
FROM Komitenti
WHERE
  (DatumIzmene > :lastModifiedAt)
  OR (DatumIzmene = :lastModifiedAt AND Sifra > :lastId)
ORDER BY DatumIzmene ASC, Sifra ASC;
```

### 4.2 Šta ako BigBit tabela nema timestamp kolonu?

**Opcija A — autoincrement ID watermark:**

```sql
SELECT TOP 1000 *
FROM Komitenti
WHERE Sifra > :lastId
ORDER BY Sifra ASC;
```

**Problem:** ovo detektuje samo **nove** zapise. UPDATE u BigBit-u neće biti reflektovan. Loše za podatke koji se često ažuriraju (komitenti — adresa, telefon).

**Opcija B — SQL Server rowversion:**

SQL Server ima built-in `rowversion` (a.k.a. `timestamp`) kolona koja se automatski ažurira na svaki INSERT/UPDATE. Idealan watermark.

**Problem:** podrazumeva `ALTER TABLE` na BigBit-u da se doda kolona. **Vendor mora odobriti** ovu izmenu. Ne diramo bez dogovora.

**Opcija C — full refresh ako tabela nije velika:**

Ako je tabela < 5.000 zapisa, jednostavno povući sve i upsert-ovati. Manje optimalno, ali pouzdano.

**Opcija D — checksum poređenje:**

MD5 hash svih relevantnih kolona u BigBit-u → poredi sa cached hash u Servosync-u. Skuplo ali ne zahteva izmenu BigBit-a.

**Preporuka za V1:**

- Customers, Projects, Items: pokušati **Opciju A (autoincrement ID)** + dopuna **full refresh jednom nedeljno** kao backup za UPDATE-ove (cron koji vrti nedeljom)
- Salespeople, Warehouses, TaxRates, ItemGroups: **full refresh** uvek (mali skupovi)

**V2 razmotri Opciju B (rowversion)** posle razgovora sa vendorom BigBit-a.

### 4.3 Upsert pattern

Za svaki entity:

```typescript
// Pseudo kod
async syncEntity(entityName: string, batch: BigBitRow[]) {
  for (const row of batch) {
    const transformed = mapToPostgres(row);
    
    await prisma[entityName].upsert({
      where: { legacySifra: transformed.legacySifra },
      create: transformed,
      update: {
        ...transformed,
        lastSyncedAt: new Date(),
      },
    });
  }
}
```

**Konflikt rezolucija:**

- Polja koja dolaze iz BigBit-a — **BigBit pobeđuje** uvek (overwrite)
- Polja koja su Servosync-specifična (npr. `default_technologist_id` na customer-u, ako bismo dodali takvu kolonu) — **ostaju lokalna**, sync ih ne dira

Trenutno mapping pokazuje da **sva polja u target tabelama dolaze iz BigBit-a** — nema lokalnih polja. Sve može da se overwrite-uje sigurno.

### 4.4 Batching

Da ne preopteretimo BigBit ni Postgres:
- **Batch size:** 1.000 zapisa po SQL upitu
- **Concurrent batches:** 1 (sequential, ne paralelno) — da bismo kontrolisali rate na BigBit-u
- **Inter-batch pauza:** 100ms — da BigBit ima dah

Za 50.000 artikala = 50 batch-eva = 50 * (vreme upita + 100ms) ≈ 5-10 minuta.

---

## 5. API endpoints

### 5.1 Sync trigger

**`POST /api/v1/sync/run`** — manualni sync

Request body:
```json
{
  "entities": ["customers", "items"],  // optional, default: ["all_incremental"]
  "strategy": "incremental"            // optional: "incremental" | "full_refresh"
}
```

Response (immediate, sync is async):
```json
{
  "data": {
    "syncLogId": 1234,
    "status": "running",
    "message": "Sync started in background",
    "entities": ["customers", "items"]
  }
}
```

Auth: zahteva `role = 'ADMIN'`.

### 5.2 Sync status

**`GET /api/v1/sync/state`** — trenutni state svih entiteta

Response:
```json
{
  "data": [
    {
      "entity": "customers",
      "lastSuccessAt": "2026-05-12T02:15:30Z",
      "lastAttemptAt": "2026-05-12T02:15:30Z",
      "cursor": {
        "lastModifiedAt": "2026-05-11T18:45:00Z",
        "lastId": 1234
      },
      "lastSuccessSyncLogId": 1230,
      "lastErrorMessage": null,
      "isHealthy": true,
      "minutesSinceLastSuccess": 480
    },
    {
      "entity": "items",
      "lastSuccessAt": "2026-05-12T02:18:42Z",
      "lastAttemptAt": "2026-05-12T03:00:00Z",
      "cursor": {"lastId": 47823},
      "lastSuccessSyncLogId": 1231,
      "lastErrorMessage": "Connection timeout to BigBit SQL Server",
      "isHealthy": false,
      "minutesSinceLastSuccess": 555
    }
    /* ... za sve entitete */
  ]
}
```

`isHealthy` = `last_success_at` je u poslednjih 24h.

**`GET /api/v1/sync/state/:entity`** — state jednog entiteta

Response: jedan objekat iz gornje liste.

### 5.3 Sync log

**`GET /api/v1/sync/log`** — lista sync run-ova

Query params:
- `status` — filter (`success`, `failed`, `partial`, `running`)
- `entity_scope` — filter po entitetu
- `trigger` — filter (`manual`, `cron`, `api`)
- `date_from`, `date_to`
- `cursor`, `limit`

Response:
```json
{
  "data": [
    {
      "id": 1234,
      "startedAt": "2026-05-12T02:00:00Z",
      "finishedAt": "2026-05-12T02:18:42Z",
      "duration": 1122,
      "status": "success",
      "trigger": "cron",
      "triggeredByUserId": null,
      "entityScope": "all_incremental",
      "rowsFetched": 487,
      "rowsUpserted": 482,
      "rowsSkipped": 5,
      "errorMessage": null,
      "metadata": {
        "entities_synced": ["customers", "projects", "items"],
        "batches": 12
      }
    }
    /* ... */
  ]
}
```

**`GET /api/v1/sync/log/:id`** — detalj jednog log entry-ja

### 5.4 Health check

**`GET /api/v1/sync/health`** — provera konekcije ka BigBit-u

Response:
```json
{
  "data": {
    "bigbitConnection": "ok",
    "bigbitVersion": "Microsoft SQL Server 2014 SP3",
    "responseTimeMs": 145,
    "syncedEntities": {
      "customers": "healthy",
      "items": "stale",  // > 24h od poslednjeg sync-a
      "projects": "healthy"
    }
  }
}
```

### 5.5 On-demand sync (za druge module)

**`POST /api/v1/sync/run-targeted`** — internal API za druge module

Drugi servisi (PDM, RN, MRP) mogu da okidaju targeted sync ako otkriju da su podaci stari:

```typescript
// Iz pdm.service.ts
if (customerNotFound) {
  await this.bigbitSyncService.runTargeted(['customers']);
  // retry...
}
```

Ovo NIJE eksterni API endpoint — samo NestJS interni servis poziv.

---

## 6. Poslovna pravila

### 6.1 Sync state machine

```
        ┌──────────────────┐
        │  Manual / Cron / │
        │  API triger      │
        └────────┬─────────┘
                 │
                 ▼
   ┌─────────────────────────────┐
   │  Kreiraj bb_sync_log entry  │
   │  status = 'running'         │
   └─────────────┬───────────────┘
                 │
                 ▼
   ┌─────────────────────────────┐
   │  Za svaki entity u skopu:    │
   │  - Procitaj bb_sync_state    │
   │  - Otvori BigBit konekciju   │
   │  - Povuci delta              │
   │  - Upsert u Postgres         │
   │  - Update bb_sync_state      │
   └─────────────┬───────────────┘
                 │
       ┌─────────┴──────────┐
       │                    │
   sve uspelo          neki padali
       │                    │
       ▼                    ▼
   status='success'    status='partial' ili 'failed'
   finished_at = now() finished_at = now()
       │                    │
       └─────────┬──────────┘
                 │
                 ▼
   ┌─────────────────────────────┐
   │  Ako failed/partial:         │
   │  - Šalji notification email  │
   │  - (V2) Schedule retry       │
   └─────────────────────────────┘
```

### 6.2 Error handling

**Tipovi grešaka:**

| Tip greške | Šta se desi | Status posle |
|---|---|---|
| BigBit konekcija nije moguća | Sync se prekida pre nego što počne | `failed` |
| BigBit konekcija padne usred batch-a | Trenutni batch se prekida, ostali entiteti se preskaču | `failed` |
| Validacija reda failed (npr. nepostojeći FK) | Red se preskače, log warning, sync nastavlja | `partial` (na kraju) |
| Postgres upsert failed | Tranzakcija rollback-uje, sync entity se markira failed, ostali entiteti nastavljaju | `partial` |
| Timeout (sync traje > 30 min) | Sync se prekida | `failed` |

**Critical errors koji okidaju email alarm:**
- Connection failure ka BigBit-u
- Postgres failure
- Sync traje > 30 min
- Više od 50 redova preskočeno u jednom entitetu

### 6.3 Idempotentnost

Sync mora biti **idempotentan** — ako pokrenemo isti sync 2 puta, rezultat je isti.

Garantujemo kroz:
- **Upsert pattern** (ne insert) — ne dupliciraju se zapisi
- **Cursor se update-uje samo posle success-a** — ako padne usred, sledeći sync će preuzeti od istog cursor-a
- **Idempotent SQL queries** — koristi se primary key (`legacy_sifra`) za upsert WHERE

### 6.4 Cursor management

**Pravila:**

1. Cursor se čita iz `bb_sync_state.cursor` na početku sync run-a
2. Cursor se ažurira **POSLE uspešnog batch upsert-a**, ne pre
3. Ako batch padne, cursor ostaje stara vrednost — sledeći run će povući isti batch ponovo (upsert je idempotent)
4. Posle success-a celokupnog sync-a entiteta, `last_success_at` i `last_success_sync_log_id` se ažuriraju

```typescript
// Pseudo kod
async syncEntity(entity: string) {
  const state = await this.prisma.bbSyncState.findUnique({ where: { entity } });
  const cursor = state?.cursor || { lastId: 0 };
  
  let totalUpserted = 0;
  let currentCursor = cursor;
  
  while (true) {
    const batch = await this.fetchBatchFromBigBit(entity, currentCursor);
    if (batch.length === 0) break;
    
    await this.prisma.$transaction(async (tx) => {
      for (const row of batch) {
        await tx[entity].upsert({ /* ... */ });
      }
      
      const newCursor = this.computeNextCursor(batch);
      await tx.bbSyncState.update({
        where: { entity },
        data: { cursor: newCursor, lastAttemptAt: new Date() },
      });
      
      currentCursor = newCursor;
      totalUpserted += batch.length;
    });
  }
  
  // Final success update
  await this.prisma.bbSyncState.update({
    where: { entity },
    data: {
      lastSuccessAt: new Date(),
      lastSuccessSyncLogId: this.currentLogId,
      lastErrorMessage: null,
    },
  });
  
  return totalUpserted;
}
```

### 6.5 BigBit konekcija

**Connection string** se konfiguriše kroz environment varijable:

```
BIGBIT_DB_HOST=Vasa-SQL
BIGBIT_DB_PORT=5765
BIGBIT_DB_NAME=QBigTehn
BIGBIT_DB_USER=QBigTehn
BIGBIT_DB_PASSWORD=<changed_post_handover>
BIGBIT_DB_ENCRYPT=false
BIGBIT_DB_TRUST_SERVER_CERT=true
BIGBIT_DB_REQUEST_TIMEOUT_MS=30000
BIGBIT_DB_POOL_MAX=5
```

**Sigurnost:**

- Password se rotira **odmah po preuzimanju projekta od vendora** (postoji u plain-textu u VBA kodu, mora se promeniti)
- Idealno: kreiranje **read-only role** na BigBit SQL Server-u za sync (samo SELECT prava)
- Production environment koristi `.env.production` koji nije u Git-u

**Connection pool:**

- Max 5 simultanih konekcija (`mssql` paket podrazumeva pool)
- Idle timeout 30s
- Connection timeout 15s

### 6.6 Notification (email) za sync padove

Posle svakog sync run-a sa statusom `failed` ili `partial`:
- Email se šalje admin korisniku (`role='ADMIN'`) — listi adresa konfigurabilna kroz `SYNC_ALERT_EMAILS` env varijablu
- Email sadrži: status, entity scope, error message, link na `/sync/log/:id` u UI

**V1:** koristi `nodemailer` paket sa SMTP koji Servoteh već ima.
**V2:** razmotri Resend, SendGrid, ili Servoteh interni mail server.

### 6.7 Audit log

Svaki sync run automatski generiše audit log entry:
- `action`: `SYNC_RUN`
- `entityType`: `bb_sync_log`
- `entityId`: ID od `bb_sync_log` entry-ja
- `metadata`: status, entityScope, rowsUpserted

---

## 7. UI tokovi

### 7.1 Forma: Sync dashboard

**Layout:**

```
[Header]
  Sync Status Dashboard

[Last sync card]:
  Poslednji sync: 2026-05-12 02:18:42 (cron)
  Status: ✓ Uspešno
  Trajanje: 18 min 42 s
  Upsert-ovano: 482 zapisa

[Entities grid]:
  | Entity        | Last Success    | Status   | Rows Last Sync | Cursor                    |
  | customers     | 2026-05-12 02:15| Healthy  | 12             | lastId: 4567              |
  | items         | 2026-05-11 02:23| ⚠ Stale  | 247            | lastModifiedAt: 2026-05-11|
  | projects      | 2026-05-12 02:16| Healthy  | 8              | lastId: 1234              |
  | warehouses    | 2026-05-12 02:16| Healthy  | 12             | (full_refresh)            |
  ...

[Action buttons]:
  [▶ Sync All (Incremental)]  [▶ Sync All (Full Refresh)]  [⚙ Targeted Sync]
  [📊 View Logs]               [🔄 Refresh Status]
```

**Funkcionalnost:**

- "Sync All Incremental" — okida POST /sync/run sa entities=all_incremental
- "Sync All Full Refresh" — okida POST /sync/run sa strategy=full_refresh
- "Targeted Sync" — otvara modal sa checkbox-ima za izbor pojedinačnih entiteta
- "View Logs" — navigacija na sync log listu

### 7.2 Forma: Sync log lista

**Layout:**

```
[Header]
  Sync Log

[Filteri]:
  Status: [Sve ▾]  Entity: [Sve ▾]  Trigger: [Sve ▾]  Datum: [from] - [to]

[Table]:
  | ID   | Started At          | Duration | Status   | Trigger | Entity Scope     | Rows | Error |
  | 1234 | 2026-05-12 02:00:00 | 18m 42s  | ✓ Success| cron    | all_incremental  | 482  |       |
  | 1233 | 2026-05-11 02:00:00 | 17m 03s  | ✓ Success| cron    | all_incremental  | 425  |       |
  | 1232 | 2026-05-10 14:23:00 | 1m 12s   | ⚠ Partial| manual  | customers, items | 14   | View  |
  | 1231 | 2026-05-10 02:00:00 | 0m 18s   | ✗ Failed | cron    | all_incremental  | 0    | View  |
  ...

[Pagination]: < Previous | 1 2 3 ... 47 | Next >
```

**Funkcionalnost:**

- Klikom na red → otvara se detalj log entry-ja (modal ili nova stranica)
- "View" link u Error koloni → dialog sa full error message
- Filteri u real-time

### 7.3 Forma: Sync log detalj

**Layout:**

```
[Header]
  Sync Log #1234

[Summary card]:
  Status: ✓ Success
  Started: 2026-05-12 02:00:00
  Finished: 2026-05-12 02:18:42
  Duration: 18m 42s
  Trigger: cron
  Triggered by: (system)
  Entity scope: all_incremental
  Rows fetched: 487
  Rows upserted: 482
  Rows skipped: 5

[Metadata JSON]:
  {
    "entities_synced": ["customers", "projects", "items", ...],
    "batches": 12,
    "skipped_reasons": {...}
  }

[Error message]: (samo ako status = failed ili partial)
  ...

[Affected entities states]:
  | Entity     | Rows Synced | New Cursor                        |
  | customers  | 12          | { "lastId": 4567 }                |
  | items      | 247         | { "lastModifiedAt": "...", ... }  |
  | projects   | 8           | { "lastId": 1234 }                |
  ...
```

---

## 8. Test scenariji

### 8.1 Unit testovi

**Test 1: Cursor generation za composite cursor**
- Setup: batch sa 100 zapisa, najveći `DatumIzmene = X`, najveći `Sifra = Y`
- Action: `computeNextCursor(batch)`
- Expect: `{ lastModifiedAt: X, lastId: Y }`

**Test 2: Cursor generation za autoincrement only**
- Setup: batch sa 50 zapisa, max `Sifra = 1234`
- Action: `computeNextCursor(batch)`
- Expect: `{ lastId: 1234 }`

**Test 3: Mapping customer fields**
- Setup: BigBit row sa svim poljima
- Action: `mapCustomerToPostgres(row)`
- Expect: pravilno transformisan objekat sa snake_case poljima, default `XX_<sifra>` za PIB ako null

**Test 4: Idempotent upsert**
- Setup: customer postoji u Postgres-u sa Sifra=123
- Action: 2x `upsertCustomer({ legacySifra: 123, ... })`
- Expect: jedan red u tabeli, drugi poziv ažurira postojeci

### 8.2 Integration testovi (sa mock BigBit)

**Test 5: Successful sync run**
- Setup: mock BigBit sa 10 customer-a
- Action: `POST /sync/run` sa entities=["customers"]
- Expect: 200, sync log status=success, 10 redova u customers tabeli

**Test 6: Sync fails on BigBit connection**
- Setup: BigBit mock vraća connection error
- Action: `POST /sync/run`
- Expect: sync log status=failed, error message zabeleżen, cursor ne-izmenjen

**Test 7: Partial sync (jedna entity padne)**
- Setup: mock vraća success za customers, fail za items
- Action: `POST /sync/run` sa entities=["customers", "items"]
- Expect: sync log status=partial, customers sync-ovano, items nije

**Test 8: Incremental cursor advance**
- Setup: prvi run dovuče 1000 customers (max lastId=1000), drugi run dovuče još 500 (max lastId=1500)
- Action: 2 uzastopna sync run-a
- Expect: cursor posle prvog = {lastId: 1000}, posle drugog = {lastId: 1500}

**Test 9: Batch processing**
- Setup: BigBit mock vraća 2500 customers (3 batch-a od 1000)
- Action: sync customers
- Expect: 3 SQL upita ka BigBit-u, 2500 redova u Postgres-u

### 8.3 E2E testovi

**Test 10: Admin trigger sync from UI**
- Login (admin) → /sync → klikni "Sync All Incremental"
- Expect: notification "Sync started", posle 30s status update na "Success"

**Test 11: Health check endpoint**
- GET /sync/health
- Expect: bigbitConnection=ok ako konekcija radi, response time

---

## 9. Cursor instrukcije za implementaciju

### 9.1 Sprint 1 — Backend implementation

```
Implementacija BigBit Sync modula za Servosync (Sprint 1 po ARCHITECTURE.md, v1.1 sa proširenim skopom).

VAŽNO — Sprint sequencing:
- Sprint 1 (ovaj) sync-uje 13 entiteta: 8 commercial master + 5 production master (workers, operations, etc.)
- Sprint 2 (Production Structures) pretpostavlja da je Sprint 1 već popunio workers, operations, work_units, worker_types, machine_access tabele
- Sprint 2 dodaje samo NestJS CRUD endpoint-e za te tabele + UI

Kontekst:
- Pročitaj docs/ARCHITECTURE.md i docs/MODULE_SPEC_bigbit_sync.md
- Prisma šema već sadrži BbSyncLog, BbSyncState + target tabele (Customer, Project, Item, Warehouse, TaxRate, ItemGroup, ItemSubgroup, Salesperson)
- Pristup B: NestJS service sa `mssql` paketom, read-only konekcija ka BigBit-u

Cilj Sprinta 1:
- Implementiraj NestJS modul `bigbit-sync` koji povlači master data iz BigBit SQL Server-a u Servosync Postgres
- Manual trigger kroz UI dugme + cron job (svako jutro 02:00)
- API endpoints prema sekciji 5 ove specifikacije
- Unit i integration testovi prema sekciji 8

Konkretno uradi:

1. Instaliraj dependency:
   - npm install mssql
   - npm install @nestjs/schedule (ako nije već)

2. Kreiraj NestJS modul `src/modules/bigbit-sync/`:
   - bigbit-sync.module.ts
   - bigbit-sync.controller.ts (HTTP endpoints)
   - bigbit-sync.service.ts (core orchestration logic)
   - bigbit-sync.cron.ts (@Cron decorator za 02:00 daily)
   - clients/bigbit-mssql.client.ts (mssql konekcija + query helpers)
   - syncers/ folder sa per-entity syncer-ima:
     - customer.syncer.ts
     - project.syncer.ts
     - item.syncer.ts
     - salesperson.syncer.ts
     - warehouse.syncer.ts
     - tax-rate.syncer.ts
     - item-group.syncer.ts
     - item-subgroup.syncer.ts
   - dto/ folder sa request/response DTO-ovima
   - mappers/ folder sa per-entity mapper-ima (BigBit row → Postgres model)
   - tests/ folder

3. Implementiraj sledeće endpoint-e prema specifikaciji (sekcija 5):
   - POST /sync/run
   - GET /sync/state
   - GET /sync/state/:entity
   - GET /sync/log
   - GET /sync/log/:id
   - GET /sync/health

4. Per-entity syncer interfejs:

```typescript
interface IEntitySyncer {
  entityName: string;
  strategy: 'incremental' | 'full_refresh';
  
  sync(syncLogId: number): Promise<SyncEntityResult>;
}

interface SyncEntityResult {
  rowsFetched: number;
  rowsUpserted: number;
  rowsSkipped: number;
  newCursor: any;
  errors: string[];
}
```

5. Connection setup (clients/bigbit-mssql.client.ts):
   - Connection pool sa configurable env variables
   - Health check method
   - executeQuery<T>(sql, params) helper
   - Graceful handling timeout-a i konekcijskih grešaka

6. Konfiguracija (config/bigbit.config.ts):
   - Pročitaj env variables iz sekcije 6.5
   - Validation kroz Joi ili class-validator

7. Cron job (cron/bigbit-sync.cron.ts):
   - @Cron('0 2 * * *') — svako jutro 02:00
   - Pokreće runAllIncremental() iz servisa
   - Logs success/failure

8. Notification (notifications/sync-alert.service.ts):
   - Šalje email kad sync padne (status = failed/partial)
   - Koristi nodemailer
   - Lista adresa iz SYNC_ALERT_EMAILS env varijable

9. Audit log:
   - Svaki sync run automatski generiše AuditLog entry (kroz interceptor ili eksplicitan poziv)

10. Auth:
    - POST /sync/run, /sync/run-targeted: role='ADMIN'
    - GET endpoint-i: any authenticated user

11. Validacija:
    - DTO klase koriste class-validator
    - Whitelist svih dozvoljenih entity values (sprečava SQL injection u entity parameter)

12. Testovi (sekcija 8):
    - Unit testovi za cursor logic i mappers
    - Integration testovi sa mock mssql klijentom (testcontainers ili jest mock)
    - E2E testovi za HTTP endpoint-e

13. Swagger:
    - Sve endpoint-e dekoriši
    - DTO klase imaju @ApiProperty

14. Performance:
    - Batch size = 1000 (configurable)
    - Inter-batch pauza = 100ms
    - Total timeout = 30 min

15. Error handling:
    - Custom exception klase: BigbitConnectionException, SyncTimeoutException, EntitySyncException
    - Mapping na HTTP statuse u global filter-u

16. Logging:
    - Strukturirano logovanje sa pino
    - Per-batch log entry sa: entity, batch_num, rows, duration

Ne menjaj:
- Postojeće target tabele (Customer, Project, Item itd.) — samo populišeš ih, ne diraš strukturu
- Auth modul, audit log modul
- Druge module

Posle implementacije:
- npm run test — svi testovi prolaze
- npm run start:dev — aplikacija startuje
- Testiraj kroz Swagger UI da li sync radi
- Otvori PR "feat(bigbit-sync): implement Sprint 1 BigBit sync per MODULE_SPEC_bigbit_sync.md"

PR template:

## Sprint 1 — BigBit Sync modul

Implementira BigBit → Postgres sync prema MODULE_SPEC_bigbit_sync.md (pristup B).

### Implementirano:
- [ ] mssql client sa connection pool-om i health check
- [ ] Per-entity syncers: customers, projects, items, salespeople, warehouses, tax_rates, item_groups, item_subgroups
- [ ] Cursor management (incremental + full_refresh strategije)
- [ ] HTTP endpoints (POST /sync/run, GET /sync/state, GET /sync/log, GET /sync/health)
- [ ] Cron job (svako jutro 02:00)
- [ ] Email notifikacije za sync padove
- [ ] Audit log integration

### Testovi:
- [ ] Unit testovi (X/X)
- [ ] Integration testovi sa mock BigBit (X/X)
- [ ] E2E testovi (X/X)

### Acceptance test (manual):
- [ ] Connection ka BigBit-u radi (GET /sync/health)
- [ ] Manual sync customers radi (POST /sync/run)
- [ ] Incremental sync radi 2x bez duplikata
- [ ] Cron triger radi (proveri kroz logs)
- [ ] Sync log se prikazuje sa filterima
- [ ] Email notifikacija šalje na failed sync
```

### 9.2 Frontend implementation (paralelno)

Frontend deo: 2 stranice (`/sync` dashboard + `/sync/logs` lista). Manje posla od PDM frontend-a jer je admin-only ekran sa malo stejta.

Detalji idu u zaseban `MODULE_SPEC_bigbit_sync_FE.md` ako bude potrebno, ali za V1 može da bude basic UI.

---

## 10. Open questions / decisions

**Q1: Imaju li BigBit tabele timestamp kolone (`DatumIzmene`, `LastModified`)?**

Treba proveriti u praksi (pre Sprinta 1):
- SELECT TOP 1 * FROM Komitenti — pogledaj kolone
- Ako nema, koristi autoincrement ID watermark + weekly full refresh

**Q2: Kako menjamo SQL Server password posle preuzimanja?**

Trenutni `QBigTehn / QbigTehn.9496` mora se promeniti. Ko menja i kada — pre Sprinta 1 ili tokom?

**Q3: Notification email destination?**

`SYNC_ALERT_EMAILS` env varijabla — koje adrese? Default: admin email-ovi koji ti pošalješ.

**Q4: SMTP server za email?**

Postoji li Servoteh SMTP ili koristimo external (Resend, SendGrid)? Za V1 bi bio dovoljan Servoteh SMTP ako postoji.

**Q5: Šta sa lokalnim izmenama master data?**

Trenutni mapping pretpostavlja sve customer polja dolaze iz BigBit-a. Šta ako tehnolog promeni adresu komitenta u Servosync UI-ju — da li se piše nazad u BigBit?

**V1 preporuka:** UI customer forme su **read-only** osim za polja koja Servosync poseduje (npr. `default_technologist_id` koje bismo dodali u V2). Ako korisnik hoće da promeni adresu, mora to da uradi u BigBit-u.

**Q6: Real-time sync ili batch?**

V1 batch (cron + manual). V2 razmotri: BigBit triggers koji okidaju webhook ka Servosync-u na svaku izmenu. Ali to zahteva vendor cooperation.

---

## 11. Reference

- `BB_Tehnologija_opis.pdf` — strana 21 ("RAZNO" modul — pokazuje "Preuzmi iz BigBit-a" dugme u QMegaTeh-u)
- `legacy/QMegaTeh_Reference.md`:
  - Dodatak E (Master-data sync iz BigBit-a) — detaljan opis trenutnog stanja
  - Sekcija 16.5 — Master-data sync flow dijagram
  - Dodatak F (Glossary) — terminologija
- VBA moduli (referenc za biz logiku):
  - `ImportIzBB_Module.bas` — sve `DodajNoveKomitenteIzBigBita`, `DodajNovePredmeteIzBigBita`, itd. funkcije
  - `RibbonModule.bas` — `PreuzmiIzBigBitaRibbon` dugme handler
  - `LinkovaneTabele.bas` — EXT_* linked tables management
- `schema.prisma` — BbSyncLog, BbSyncState definicije
- `schema-rename-map.md` — mapping legacy → Postgres za sve target tabele

---

## 12. Verzija

| Verzija | Datum | Šta se promenilo |
|---|---|---|
| 1.0 | maj 2026 | Inicijalna specifikacija BigBit Sync modula za V1, pristup B (NestJS + mssql) |
| 1.1 | maj 2026 | **Prošireni skop:** dodato 5 production master entiteta (work_units, worker_types, operations, workers, machine_access) iz BigBit tabela `tRadneJedinice`, `tVrsteRadnika`, `tOperacije`, `tRadnici`, `tPristupMasini`. Razlog: Sprint 2 (Production Structures) pretpostavlja da ove tabele već postoje. Strategije: full refresh za work_units/worker_types/operations/machine_access (mali skupovi), ID watermark + weekly full refresh za workers. |

---

*Kraj MODULE_SPEC_bigbit_sync.md*

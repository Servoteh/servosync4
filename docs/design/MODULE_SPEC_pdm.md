# Servosync — Module Spec: PDM (Projektna dokumentacija)

| | |
|---|---|
| **Modul** | PDM (Product Data Management) |
| **Verzija specifikacije** | 1.1 |
| **Datum** | maj 2026 |
| **Sprint** | 3 (po ARCHITECTURE.md planu) |
| **Korisnik modula** | Projektni biro (kreira crteže) + svi (čitaju katalog crteža) |
| **Status** | Specifikacija za implementaciju |

---

## 0. Kako koristiti ovaj dokument

Ovaj dokument je **konkretna specifikacija PDM modula** — šta se tačno gradi, koje API rute, kakva poslovna pravila, kako forme rade. Service kao input za:

- **Cursor agenta** koji generiše NestJS kod modula
- **Frontend developera** koji pravi React komponente za PDM ekrane
- **QA testera** koji piše test scenarije
- **Korisničku obuku** (Servoteh projektni biro)

**Pre čitanja ovog dokumenta**, pretpostavlja se da ste pročitali:
- `ARCHITECTURE.md` — strateški kontekst
- `schema.prisma` — definicije tabela
- `schema-rename-map.md` — mapiranje srpski ↔ engleski

**Reference koje se često spominju:**
- `legacy/QMegaTeh_Reference.md` — stara dokumentacija sistema (sekcija 8 — domeni; sekcija 11 — UI; Dodatak F — glossary)
- `BB_Tehnologija_opis.pdf` — vizuelni opis ekrana (strane 2-3 za PDM)
- VBA moduli: `PDM_Common.bas`, `PDM_Class.cls`, `PDM_PDFCommon.bas`, `PDM_Test.bas`, `PDMXMLParser.bas`

---

## 1. Cilj PDM modula

**Šta PDM radi u Servoteh-u:**

PDM modul je **digitalna evidencija svih konstrukcionih crteža** koji se proizvode u Servoteh-u. Konstruktori u projektnom birou crtaju u SolidWorks-u, izvoze XML metapodatke i PDF crteža u sistem, pa od tu nadalje:

- **Tehnolozi** pretražuju crteže, otvaraju ih, vide gde su upotrebljeni
- **Proizvodnja** dobija sastavnice (BOM) za svaki sklop koji treba sastaviti
- **Nabavka** dobija listu gotovih delova koje treba kupiti za sklop (kroz MRP modul)
- **Magacin** dobija lokacije gde su završeni delovi smešteni (kroz Lokacije modul)

PDM nije samo "katalog crteža" — to je **mesto gde proizvodnja crpe sve podatke o delovima koji se prave**.

### Šta PDM **NIJE** (vrlo važno za pravilno razumevanje skopa)

PDM modul **NE dodeljuje crtežima poslovni kontekst** (predmet, radni nalog, kupca). Ovo je ključno razumevanje koje je propušteno u v1.0 spec-u:

- Kad crtež uđe u sistem kroz **XML import**, on dolazi **BEZ broja predmeta**. To su čisti CAD metapodaci: broj crteža, revizija, naziv, materijal, dimenzije, BOM relacije
- Polja `projectName` i `workOrderRef` u tabeli `drawings` su **legacy denormalizovan tekst** — POPUNJAVAJU se TEK posle prvog HandoverDraft-a kreiranog od strane projektanta, NISU stvarne FK reference
- **Tačka gde se predmet "lepi" na crtež** je u **Nacrti modulu** (Sprint 4) kroz `HandoverDraft.projectId` FK relaciju
- Workflow odobravanja crteža za proizvodnju, kreiranje RN-a, lansiranje — sve to je u **Primopredaje modulu** (Sprint 4)

Drugim rečima — **PDM je read-mostly katalog crteža**. Jedini write je XML import iz CAD-a.

### Veza sa drugim modulima

- **Nacrti modul (Sprint 4)** — od PDM crteža se kreira "nacrt primopredaje" gde se prvi put dodeljuje predmet
- **Primopredaje modul (Sprint 4)** — workflow odobravanja crteža za lansiranje u proizvodnju
- **Radni nalog modul (Sprint 5)** — RN se vezuje za konkretan crtež + reviziju (kreira se posle lansiranja)
- **MRP modul (Sprint 8)** — proračun potreba materijala na osnovu BOM-a iz PDM-a
- **Nabavka uvid modul (Sprint 8)** — "Planiranje nabavke iz sklopnog crteža" čita PDM BOM

### Ko vidi šta u PDM-u

| Korisnik | Šta radi u PDM-u | Dodatni pristup |
|---|---|---|
| **Projektni biro / Konstruktor** | Kreira crteže kroz XML import, browse-uje katalog | Kreira nacrte u Nacrti modulu |
| **Tehnolog** | Browse katalog (svi crteži, uključujući one bez predmeta) | Vidi primopredaje koje treba odobriti u Primopredaje modulu |
| **Proizvodnja / Majstor** | Browse katalog (za referencu) | Vidi RN-ove u Radni nalog modulu |
| **Kontrolor** | Browse katalog (za referencu) | Vidi operacije u Proizvodnja modulu |

Svi korisnici imaju **isti pregled crteža** — razlika je samo u sledećim koracima koje rade van PDM-a.

---

## 2. Skop modula (iz BB_Tehnologija_opis.pdf, strane 2-3)

**Ekrani koji se grade u Sprintu 3:**

| # | Ekran (legacy ime) | Slovenski ekvivalent | API ruta | Tabele |
|---|---|---|---|---|
| 1 | Pregled crteža | Drawing list with filters | `GET /pdm/drawings` | `drawings`, `drawing_statuses` |
| 2 | Sklop (crtež) | Drawing assembly view (BOM tree) | `GET /pdm/drawings/:id/bom` | `drawings`, `drawing_components`, `drawing_assemblies` |
| 3 | XML import log | XML import history | `GET /pdm/import-log` | `drawing_import_log` |
| 4 | Sastavnica delova (za sklop) | Parts BOM (manufactured parts) | `GET /pdm/drawings/:id/bom/parts` | (view nad `drawing_components` filtered) |
| 5 | Sastavnica gotove robe (za sklop) | Goods BOM (purchased items) | `GET /pdm/drawings/:id/bom/purchased` | (view nad `drawing_components` filtered) |
| 6 | Gde se koristi | Where-used (reverse BOM) | `GET /pdm/drawings/:id/where-used` | (reverse query nad `drawing_components`) |
| 7 | Štampa PDF crteža | Open/Print PDF | `GET /pdm/drawings/:id/pdf` | `drawing_pdfs` |
| 8 | XML import | Upload XML iz CAD-a | `POST /pdm/import` | `drawing_import_log`, `drawings`, `drawing_components` |

**Ekrani koji SU u PDF-u na PDM strani, ALI pripadaju drugim modulima:**

| Dugme u PDF-u | Stvarni modul | Opis |
|---|---|---|
| "Kreiranje primopredaje" (sidebar na PDF strani 3) | **Nacrti modul (Sprint 4)** | PDM samo prikazuje dugme/link koji vodi u `/nacrti/novi?drawingId={selectedDrawingId}` |
| "Novi nacrt" | **Nacrti modul (Sprint 4)** | Isto kao gore, link u Nacrti modul |
| "Planiranje nabavke" | **MRP modul (Sprint 8)** | Link u `/mrp/planiraj?drawingId={selectedDrawingId}` |
| "Otvori novi nacrt" / "Prikaži nacrt" | **Nacrti modul** | Cross-modul navigacija |

**Šta NIJE u skopu PDM modula:**

- **Dodela predmeta crtežu** — to se događa kroz `HandoverDraft.projectId` u Nacrti modulu, ne u PDM-u
- **Kreiranje primopredaja, odobravanje, lansiranje** — Primopredaje modul (Sprint 4)
- **Kreiranje radnih naloga** — Work Orders modul (Sprint 5), kreira se kroz lansiranje primopredaje
- **Editovanje crteža posle XML importa** — PDM je read-mostly; jedini write je sledeći XML import za istu reviziju (UPSERT)
- **Brisanje crteža** — soft delete biće u V2 ako bude potrebno; u V1 crteži ostaju u sistemu zauvek
- **Editovanje BOM-a ručno** — BOM dolazi isključivo iz XML-a; ručno editovanje ne postoji

---

## 3. Tabele koje koristi (iz `schema.prisma`)

### 3.1 Glavne tabele

**`drawings`** — centralna tabela crteža

Kolone (key):
- `id` (Int PK)
- `drawing_number` (VarChar 20) — broj crteža (npr. `1133418`)
- `revision` (VarChar 3, default "A") — revizija (`A`, `B`, `C`, ...)
- `catalog_number` (VarChar 50) — Identbroj
- `name` (VarChar 255) — naziv dela
- `material` (VarChar 255) — materijal (`Č0361`, `Plain Carbon Steel`, ...)
- `dimensions` (VarChar 255) — dimenzije (`o50x100`, `60x630`, ...)
- `weight` (Float) — masa u kg
- `marking` (VarChar 20) — oznaka
- `is_procurement` (Boolean) — flag "ovo je gotov deo (kupuje se)"
- `pdm_status` (VarChar 20) — operativni status (`Preuzeto`, `Postoji`, ...)
- `status_id` (FK → `drawing_statuses`)
- `designed_by` (VarChar 50), `design_date` — projektant i datum
- `approved_by` (VarChar 50), `approved_date` — odobrenje
- `file_name` (VarChar 500) — original SolidWorks fajl
- `created_at`, `signature`

**Legacy polja (denormalizovan tekst, popunjavaju se POSLE prve primopredaje, NISU FK):**

- `where_used` (VarChar 255) — denormalizovan pregled gde se koristi (slobodan tekst, cached)
- `project_name` (VarChar 255) — naziv projekta kao slobodan tekst (legacy; pravi FK ka projects ide kroz `HandoverDraft`)
- `work_order_ref` (VarChar 20) — referenca na RN kao slobodan tekst (legacy; pravi FK ide kroz `WorkOrder`)

**Vrlo važno:** ova legacy polja su **NULLABLE** i **prazna posle XML importa**. Tek nakon što projektant kreira `HandoverDraft` koji uključuje crtež, sistem može (opcionalno) da denormalizuje ove tekstualne reference u tabelu `drawings`. To je optimizacija za search/filter — projektni biro može da pretraži "sve crteže predmeta X" kroz fuzzy search nad `project_name`, ali zvanični FK lookup ide kroz `HandoverDraft.projectId`.

Za pravi domain query "koji predmet koristi ovaj crtež" treba ići preko Nacrti modula:
```sql
SELECT DISTINCT p.* 
FROM projects p
JOIN handover_drafts hd ON hd.project_id = p.id
JOIN handover_draft_items hdi ON hdi.draft_id = hd.id
WHERE hdi.drawing_id = :drawing_id
  AND hd.deleted_at IS NULL;
```

**Unique constraint:** `(drawing_number, revision)` — isti crtež može imati više revizija, ali kombinacija mora biti jedinstvena.

**Indeksi (preporuka da se dodaju ako nisu):**
- `(drawing_number)` — za search po broju
- `(catalog_number)` — za search po identbroju
- `(name)` — za fuzzy search po nazivu (`pg_trgm` indeks)
- `(is_procurement, status_id)` — za filter procurement crteža

**`drawing_components`** — komponente crteža (BOM relations)

- `parent_drawing_id` → `drawings.id` (NoAction)
- `child_drawing_id` → `drawings.id` (NoAction)
- `required_quantity` (Int, default 1)

Ovo je **klasična adjacency list** za hijerarhiju sklopova. Sklop A ima 3 komponente B, C, D — to su 3 reda u ovoj tabeli sa `parent = A` i `child = B/C/D`.

**Napomena:** `onDelete: NoAction` — ne dozvoljava brisanje crteža koji ima komponente. To je dobro za V1.

**`drawing_assemblies`** — slično `drawing_components`

Razlog za dve tabele (verovatno):
- `drawing_components` = svi parent↔child odnosi (Sastavnica delova)
- `drawing_assemblies` = samo direct children sa direct quantity (Sastavnica gotove robe)

**OPEN QUESTION:** treba potvrditi sa Lukom šta je tačno razlika između ove dve tabele jer migracija iz BigBit-a je preneo i jednu i drugu. Ako su semantički iste, jedna se može deprecate-ovati. Ako nisu, treba dokumentovati razliku.

### 3.2 Pomoćne tabele

**`drawing_pdfs`** — PDF fajl reference + binary storage

- `(drawing_number, revision)` composite PK
- `file_name` (VarChar 255) — original PDF ime
- `pdf_binary` (Bytes) — **PDF se čuva direktno u bazi**
- `size_kb` (Int) — veličina za UI prikaz
- `uploaded_at`, `uploaded_by` (SESSION_USER default)

**Napomena za V1:** čuvanje PDF-ova u Postgres-u kao `bytea` je legit pristup za V1 ako PDF-ovi nisu preveliki (recimo <5MB svaki). Za V2 prebaci na file-storage (S3-compatible ili filesystem) sa file references u DB.

**`drawing_import_log`** — istorija XML import-a

- `file_name` (VarChar 255)
- `file_path` (VarChar 1024)
- `imported_at` (Timestamp)
- `success` (Boolean)
- `status_message` (VarChar 1000) — error description ako fail
- `is_critical` (Boolean) — flag za kritične greške

**`drawing_statuses`** — lookup tabela

- `id` (Int PK)
- `name` (VarChar 50) — npr. `Preuzeto`, `Postoji`, `Ne postoji`, `Pregled`, `Saglasan`

**Seed data koji treba dodati:**
```sql
INSERT INTO drawing_statuses (id, name) VALUES
  (1, 'Preuzeto'),
  (2, 'Postoji'),
  (3, 'Ne postoji'),
  (4, 'Pregled'),
  (5, 'Saglasan');
```

(Tačan spisak treba potvrditi sa Servoteh projektnim biroom — ovo je gruba lista iz starog sistema.)

### 3.3 Tabele za druge module (referenc samo)

- `drawing_handovers` — koristi **Primopredaje modul** (Sprint 4)
- `drawing_handover_pdfs` — koristi **Primopredaje modul**
- `drawing_plans`, `drawing_plan_items` — koristi **MRP modul** (Sprint 8)
- `handover_drafts`, `handover_draft_items` — koristi **Nacrti modul** (Sprint 4)

---

## 4. Domenski rečnik

| Srpski termin | Engleski u kodu | Šta znači |
|---|---|---|
| Crtež | drawing | Konstrukcioni crtež dela (CAD output) |
| Broj crteža | drawing_number | Identifikator crteža (npr. `1133418`) |
| Revizija | revision | Verzija crteža (`A`, `B`, `C`, ...) |
| Identbroj / Kataloški broj | catalog_number | String identifikator dela u katalogu |
| Sklop | assembly | Crtež koji ima komponente (BOM) — top-level proizvod |
| Komponenta | component | Stavka u BOM-u — pokazuje na drugi crtež |
| Sastavnica | BOM (Bill of Materials) | Lista svih komponenti potrebnih za sklop |
| Sastavnica delova | parts BOM | BOM koji prikazuje samo delove koji se proizvode (nisu `is_procurement=true`) |
| Sastavnica gotove robe | purchased BOM / goods BOM | BOM koji prikazuje samo delove koji se kupuju (`is_procurement=true`) |
| Gde se koristi | where-used | Reverse BOM — lista parent crteža koji koriste dati crtež |
| PodSklop / PodPodSklop | sub-assembly / sub²-assembly | Sklop unutar sklopa (rekurzivno do n-tog nivoa) |
| Procurement (Nabavni) deo | procurement part / purchased part | Komponenta koja se kupuje, ne pravi |
| Materijal | material | Materijal od kog se deo pravi (`Č0361`, `Plain Carbon Steel`, ...) |
| Težina | weight | Masa dela u kg |
| Projektant | designer | Osoba koja je nacrtala crtež |
| XML Import | XML import | Proces uvoza metapodataka iz SolidWorks PDM-a u Servosync |

---

## 5. API endpoints

### 5.1 Pregled crteža

**`GET /api/v1/pdm/drawings`** — lista crteža sa filterima

Query params:
- `search` (string) — fuzzy search po `drawing_number`, `catalog_number`, `name`
- `revision` (string) — filter po reviziji
- `material` (string) — filter po materijalu
- `designed_by` (string) — filter po projektantu
- `is_procurement` (boolean) — filter procurement vs proizvedeni
- `status_id` (number) — filter po statusu
- `date_from`, `date_to` (ISO date) — filter po `design_date`
- `project_name` (string) — **legacy fuzzy text search** nad `drawings.project_name` denormalizovanim poljem; **NIJE** FK lookup. Za pravu pretragu po predmetu koristi `?via_project_id=` (vidi ispod)
- `via_project_id` (number) — **prava** pretraga po predmetu kroz HandoverDraft veze (cross-modul JOIN)
- `cursor`, `limit` — paginacija (default 50)
- `sort` — sort key (`-design_date` za desc, `drawing_number` za asc)

Response:
```json
{
  "data": [
    {
      "id": 12345,
      "drawingNumber": "1133418",
      "revision": "B",
      "catalogNumber": "DM-103",
      "name": "Pregradni nosač creva na robotu - zavarivanje",
      "material": "Č0361",
      "dimensions": "Zavareni sklop",
      "weight": 3.185,
      "marking": "DM",
      "isProcurement": false,
      "pdmStatus": "Preuzeto",
      "statusId": 1,
      "statusName": "Preuzeto",
      "designedBy": "Dejan Crković",
      "designDate": "2026-04-21T00:00:00+02:00",
      "fileName": "1133418.sldasm",
      "createdAt": "2026-04-24T15:30:00+02:00"
    }
  ],
  "meta": {
    "pagination": {
      "next_cursor": "...",
      "has_more": true
    },
    "total_count": 1247
  }
}
```

**`GET /api/v1/pdm/drawings/:id`** — detalj crteža

Response: kompletan objekat crteža sa svim poljima + lista komponenti (BOM) + lista parent assemblies (where-used).

### 5.2 BOM (Sastavnice)

**`GET /api/v1/pdm/drawings/:id/bom`** — kompletna BOM tree

Query params:
- `depth` (number, default `unlimited`) — koliko nivoa duboko (0 = samo direct children)
- `expand_all` (boolean) — flatten tree u listu

Response (recursive tree):
```json
{
  "data": {
    "drawing": {
      "id": 12345,
      "drawingNumber": "1133418",
      "name": "Pregradni nosač creva na robotu",
      "revision": "B"
    },
    "components": [
      {
        "id": 1,
        "drawing": {
          "id": 11334,
          "drawingNumber": "1133391",
          "name": "Stranica rama 3",
          "revision": "A",
          "isProcurement": false
        },
        "requiredQuantity": 1,
        "children": [
          /* rekurzivno */
        ]
      },
      {
        "id": 2,
        "drawing": {
          "id": 11335,
          "drawingNumber": "1133392",
          "name": "Nabla 1/2\"",
          "revision": "A",
          "isProcurement": true
        },
        "requiredQuantity": 2,
        "children": []
      }
    ]
  }
}
```

**`GET /api/v1/pdm/drawings/:id/bom/parts`** — Sastavnica delova (samo `is_procurement = false`)

Response: flat list svih delova koji se proizvode, sa expanded quantities (uračunavajući quantity_per_parent kroz hijerarhiju).

**`GET /api/v1/pdm/drawings/:id/bom/purchased`** — Sastavnica gotove robe (samo `is_procurement = true`)

Response: flat list svih kupljenih delova, sa expanded quantities. Ovo je input za **Planiranje nabavke iz sklopnog crteža** (MRP modul).

### 5.3 Where-used

**`GET /api/v1/pdm/drawings/:id/where-used`** — reverse BOM

Response:
```json
{
  "data": [
    {
      "parentDrawing": {
        "id": 67890,
        "drawingNumber": "1133418",
        "name": "Pregradni nosač creva...",
        "revision": "B"
      },
      "requiredQuantity": 1
    },
    /* svi parent crteži koji koriste ovaj crtež */
  ]
}
```

### 5.4 PDF štampa

**`GET /api/v1/pdm/drawings/:id/pdf`** — preuzmi PDF crteža

Response: binary stream `application/pdf` + `Content-Disposition: inline` ili `attachment` zavisi od `?download=true` query param-a.

**`GET /api/v1/pdm/drawings/:id/pdf/preview`** — PDF metadata bez sadržaja

Response:
```json
{
  "data": {
    "fileName": "1133418.pdf",
    "sizeKb": 2456,
    "uploadedAt": "2026-04-24T15:30:00+02:00",
    "uploadedBy": "dejan.crkovic"
  }
}
```

### 5.5 XML Import

**`POST /api/v1/pdm/import`** — upload XML iz SolidWorks PDM-a

Request body: `multipart/form-data` sa XML fajlom.

Response:
```json
{
  "data": {
    "importId": 1234,
    "fileName": "1089151-B.xml",
    "success": true,
    "statusMessage": "Successfully imported 47 drawings, 312 BOM relations",
    "stats": {
      "drawingsCreated": 5,
      "drawingsUpdated": 42,
      "bomRelationsCreated": 312,
      "errors": []
    }
  }
}
```

**`GET /api/v1/pdm/import-log`** — istorija XML import-a

Query params:
- `success` (boolean) — filter po success/fail
- `is_critical` (boolean) — filter kritičnih grešaka
- `date_from`, `date_to` — vremenski opseg
- `cursor`, `limit`

Response: lista zapisa iz `drawing_import_log` sortiranih po `imported_at DESC`.

### 5.6 Auxiliary

**`GET /api/v1/pdm/statuses`** — lookup za drawing statuses

Response: lista iz `drawing_statuses` tabele.

**`GET /api/v1/pdm/designers`** — lista projektanata (distinct values iz `drawings.designed_by`)

Response za autocomplete u UI filterima.

**`GET /api/v1/pdm/materials`** — lista materijala (distinct values iz `drawings.material`)

Response za autocomplete u UI filterima.

### 5.7 Cross-modul query — Kontekst crteža

**`GET /api/v1/pdm/drawings/:id/context`** — kontekst crteža (cross-modul agregat)

Vraća **sve veze crteža sa drugim modulima** — koristi se za PDM Detail panel da prikaže "ovaj crtež je deo X nacrta, ima Y aktivnih RN-ova, lansiran je Z puta".

Response:
```json
{
  "data": {
    "drawing": {
      "id": 12345,
      "drawingNumber": "1133418",
      "revision": "B"
    },
    "drafts": [
      {
        "id": 2259,
        "draftNumber": "G-9611-1/3",
        "projectName": "Termička linija ST-TO-14",
        "projectId": 9611,
        "status": "Predat",
        "createdAt": "2026-04-24T12:18:14Z"
      }
    ],
    "handovers": [
      {
        "id": 4521,
        "status": "Saglasan",
        "handoverWorker": "Dragan Ristanić",
        "approvedAt": "2026-04-25T10:00:00Z"
      }
    ],
    "workOrders": [
      {
        "id": 8856,
        "woNumber": "9400/1/305",
        "status": "IN_PROGRESS",
        "projectName": "Termička linija ST-TO-14",
        "quantity": 2
      }
    ],
    "stats": {
      "totalProductionRuns": 1,
      "totalQuantityProduced": 2,
      "lastUsedInProductionAt": "2026-04-25T10:00:00Z"
    }
  }
}
```

Ovaj endpoint:
- Čita iz Nacrti modula (HandoverDraft tabela)
- Čita iz Primopredaje modula (DrawingHandover tabela)
- Čita iz Work Orders modula (WorkOrder tabela)
- Vraća konsolidovan view

**Implementacija:** koristi Prisma joins (cross-modul querying je OK pošto imamo single Postgres bazu — to NIJE microservices arhitektura).

---

## 6. Poslovna pravila

### 6.1 BOM rekurzivna ekspanzija

Za izračun "Sastavnica delova za sklop X sa total količinom N":

```
expandBOM(drawingId, multiplier=1):
  result = []
  components = SELECT * FROM drawing_components WHERE parent_drawing_id = drawingId
  
  for component in components:
    childDrawing = component.childDrawing
    totalQty = component.requiredQuantity * multiplier
    
    if childDrawing.isProcurement:
      result.append({drawing: childDrawing, totalQty: totalQty})
    else:
      // recursion za podsklopove
      childResults = expandBOM(childDrawing.id, totalQty)
      result.extend(childResults)
      // takođe dodaj sam podsklop u listu delova
      result.append({drawing: childDrawing, totalQty: totalQty})
  
  return aggregateByDrawing(result)  // grupiši po drawing.id i sumiraj
```

**Postgres optimizacija:** za V1 ovo radi kao rekurzivan Prisma query. Za V2 napravi materialized view `v_drawing_bom_flat` koji ima precomputed BOM (refreshed na svaki update).

### 6.2 Where-used optimizacija

Default implementation: `SELECT * FROM drawing_components WHERE child_drawing_id = X` (direct parents).

Ali UI zahteva i **transitive parents** (parent of parent of parent, do top sklopa) za pravi "gde se koristi". Za to:

```sql
-- Recursive CTE
WITH RECURSIVE parents AS (
  SELECT parent_drawing_id, child_drawing_id, 1 AS depth
  FROM drawing_components
  WHERE child_drawing_id = :target_id
  
  UNION ALL
  
  SELECT dc.parent_drawing_id, p.child_drawing_id, p.depth + 1
  FROM drawing_components dc
  JOIN parents p ON dc.child_drawing_id = p.parent_drawing_id
)
SELECT DISTINCT parent_drawing_id FROM parents;
```

API ruta `/pdm/drawings/:id/where-used` vraća **samo direct parents** by default. Sa `?recursive=true` vraća sve top-level parents (transitive closure).

### 6.3 Status transitions

Trenutno `drawing_statuses` je lookup bez state machine pravila. To je OK za V1 — bilo koji status se može postaviti bilo kad.

Za V2 razmotri state machine:
- `Preuzeto` → `Pregled` → `Saglasan` → (lansiran kroz primopredaju)
- `Saglasan` ne može da postane `Preuzeto` (forward-only)

Ali to nije u V1 skopu.

### 6.4 Procurement flag

`is_procurement = true` znači "ovaj crtež je gotov deo koji se kupuje, ne pravi". Pravila:

- Procurement crteži **mogu** imati nadređene sklopove (gde se koristi)
- Procurement crteži **NE bi trebalo** da imaju komponenti (BOM ispod njih je prazan) — ali to nije forsirano constraint-om. UI bi trebao da upozori ako neko pokuša
- Sastavnica gotove robe = stablo gde su samo `is_procurement = true` listovi

### 6.5 PDF storage

Default ponašanje pri XML import-u:

1. Ako u XML-u postoji `<pdf>file_path.pdf</pdf>` referenca, parser pokušava da pročita fajl
2. Ako fajl postoji, učitava se kao `bytea` u `drawing_pdfs.pdf_binary`
3. Ako fajl ne postoji, log se zapisuje u `drawing_import_log` sa `is_critical = false` (warning, ne fail)

**Veličina ograničenja za V1:** maksimum 10MB po PDF-u (config parameter). Ako PDF prelazi, log warning + ne ubacuj.

### 6.6 Duplikati pri XML import-u

Ako XML import donosi crtež sa istim `(drawing_number, revision)` koji već postoji:

- **UPSERT pattern** — postojeći zapis se ažurira sa novim podacima
- `created_at` ostaje original, `signature` se ažurira u current user
- Stari `drawing_components` se brišu i ponovo kreiraju iz novog XML-a
- Log zapis sa `success = true`, `status_message = "Updated existing drawing"`

Ako se promenila revizija (`A` → `B`):
- Pravi se **novi red** u `drawings` (jer je unique constraint na `(drawing_number, revision)`)
- Stari crtež sa `revision = A` ostaje (ne briše se)
- Sve BOM relacije se prave na novu reviziju (`drawing_id` na novi `id`)

### 6.7 Soft delete

U V1 **nema delete operacija** za crteže. Crteži se samo dodaju i ažuriraju kroz XML import. UI nema dugme "Obriši crtež".

Razlog: postoje RN-ovi, primopredaje, plan nabavke koji referenciraju crteže. Brisanje bi razbilo integritet.

Za V2: dodaj `deleted_at` kolonu na `drawings` i soft delete kao opcija.

---

## 7. UI tokovi (po formi iz PDF-a)

### 7.1 Forma: Pregled crteža (PDF strana 2)

**Layout (top-down):**

```
[Header sa logom Servoteh]
[Filteri u kartici]:
  ┌─ Od datuma ──┐  ┌─ Do datuma ──┐  ┌─ Odobrio ──┐
  └──────────────┘  └──────────────┘  └────────────┘
  ┌─ Od datuma (designed) ┐  ┌─ Do datuma ┐  ┌─ Projektovao ┐
  └────────────────────┘  └────────────┘  └──────────────┘
  ┌─ Materijal ─┐  ┌─ Dimenzije ─┐  ┌─ Inicijalni RN ─┐  ┌─ Naziv inic. RN ─┐
  ┌─ Broj crteža ─┐  ┌─ Naziv (deo naziva) ─┐  ┌─ Za status ─┐  ┌─ PDF ─┐
  ┌─ [Otvori PDF crtež] [Štampaj PDF crtež] [Sastavnica delova] [Sastavnica gotove robe] [Gde se koristi] ─┐

[Glavni grid - tabela crteža]:
  Broj crteža | Revizija | Vrsta | Naziv | Dimenzije | Masa | Materijal | Projektovao | Datum projektovanja | Odobrio od | Status crteža | PDF | Naziv inicijalnog RN* | Broj reference*

  * "Naziv inicijalnog RN" i "Broj reference" su LEGACY denormalizovan tekst koji se popunjava 
    POSLE prvog HandoverDraft-a. Za nove crteže koji još nisu primopredati, ove kolone su PRAZNE.

[Right sidebar - PDM crteži kartica]:
  PDM crteži - kontekst izabranog crteža
  miljann (miljan.nikodijevic)
  SERVOTEH
  [<<] [<] [>] [>>]  navigacija
  
  Status crteža: Preuzeto
  Projektant: Dejan Crković
  Datum kreiranja: 2026-04-24
  
  Kontekst proizvodnje (iz GET /pdm/drawings/:id/context):
  ─ Aktivni nacrti: 1 (G-9611-1/3 - Termička linija)
  ─ Aktivne primopredaje: 1 (Saglasan, tehnolog: Dragan Ristanić)
  ─ Aktivni RN-ovi: 1 (9400/1/305, u toku)
  ─ Lansiranja ukupno: 1
  
  Cross-modul akcije (NAVIGACIJA U DRUGE MODULE):
  → [Kreiraj nacrt primopredaje]    [vodi u /nacrti/novi?drawingId={X}]
  → [Prikaži nacrte]                 [vodi u /nacrti?drawingId={X}]
  → [Prikaži primopredaje]           [vodi u /primopredaje?drawingId={X}]
  → [Prikaži RN-ove]                 [vodi u /work-orders?drawingId={X}]
  → [Planiraj nabavku]               [vodi u /mrp/planiraj?drawingId={X}]
```

**Funkcionalnost:**

1. Korisnik unosi filtere → grid se filtrira u real-time (debounce 300ms)
2. Klikom na red u gridu → desni sidebar pokazuje detalje crteža + cross-modul kontekst
3. Dugme **"Otvori PDF crtež"** otvara PDF u novom tab-u
4. Dugme **"Štampaj PDF crtež"** šalje PDF na default printer (browser print dialog)
5. Dugme **"Sastavnica delova"** otvara dialog/modal sa BOM stablom (samo delovi)
6. Dugme **"Sastavnica gotove robe"** otvara dialog/modal sa BOM stablom (samo kupovni)
7. Dugme **"Gde se koristi"** otvara dialog sa where-used listom
8. Cross-modul dugmad u sidebar-u su **navigation links**, ne API pozivi iz PDM-a — vodi u drugi modul sa pre-filled `drawingId` query param-om

**Filter validacija:**

- Datum opseg: `date_from` mora biti ≤ `date_to`
- Broj crteža: text, partial match (LIKE `%term%`)
- Naziv: text, fuzzy search (pg_trgm)

**Stranica:**

- Default 50 redova po stranici
- Cursor-based pagination (next/prev dugmad)

### 7.2 Forma: Sklop (crtež) — BOM tree view (PDF strana 2-3)

**Layout:**

```
[Header]:
  PDM Sklop | ID crteža | Broj crteža | Revizija | [<<] [<] [>] [>>] | Pronađi sklop ▾ | [STOP]
  SERVOTEH | 12822 | 1089218 | A

[Main info]:
  Broj crteža | Revizija | Naziv | Materijal | Dimenzije | Težina
  1089218 | A | DIN933-M12x60-10.9-plain | Sklop | | 0.11

[BOM tree - rekurzivno]:
  1089218 - A
  ├── K00544 - E - 2 ─ DIN 125 - M12 - St300HV - plain
  ├── K00602 - F - 1 ─ DIN 127B - M12 - Spring steel - black
  ├── K10716 - E - 1 ─ DIN 933 - M12 x 60 - 10.9 - plain
  └── K12468 - E - 1 ─ DIN934 - M12 - 10 - plain
```

**Funkcionalnost:**

1. Tree view može da se proširi/zatvori po nivou
2. Klik na child crtež → otvori sklop te child crteža (drill-down)
3. Right-click na child → context menu: "Otvori PDF", "Sastavnica", "Gde se koristi"
4. Indikatori boja:
   - **Zeleno**: proizvedeni delovi (`is_procurement = false`)
   - **Plavo**: kupovni delovi (`is_procurement = true`)
   - **Crveno**: crteži sa `pdm_status = 'Ne postoji'` (greška, treba pažnja)

### 7.3 Forma: Sastavnica delova (PDF strana 3 — mali dijalog)

**Layout (modal/dialog):**

```
Sastavnica delova: Pregradni nosač creva na robotu - zavarivanje [X]

Broj crteža | Revizija | Naziv | Količina za izradu | Prikaži stablo | Top Level [ ]
1133418 | B | Pregradni nosač creva... | 1 | □ | □

[Otvori PDF crtež] [Štampaj PDF crtež] [Štampaj sastavnicu] [Štampaj sve PDF crteže]

Tabela:
| Broj crteža | Revizija | Naziv          | Količina za izradu | PDF |
| 1133390     | A        | Stranica rama 3| 1                  | □   |
| 1133391     | A        | Stranica rama 2| 1                  | □   |
| 1133392     | A        | Nabla 1/2"     | 2                  | □   |
| 1133393     | A        | Stranica rama 1| 1                  | □   |
```

**Pravila:**

- Lista prikazuje **samo proizvedene delove** (`is_procurement = false`)
- Količina je expanded (uračunava količinu sklopa)
- "Prikaži stablo" toggle prebacuje na tree view umesto flat list-e

### 7.4 Forma: XML import log (PDF strana 2)

**Layout:**

```
PDM XML ImportLog

Tabela:
| IDLog | Naziv fajla     | Vreme importa       | Uspesno | StatusPoruka                                            | Kritično |
| 11525 | 1086951_B.xml   | 24-04-26 19:09:07   | ✓       | Podaci iz XML fajl su USPESNO IMPORTOVANI               |          |
| 11528 | 1129092_B.xml   | 24-04-26 19:09:07   | ✓       | Podaci iz XML fajl su USPESNO IMPORTOVANI               |          |
| 11529 | 1109245.xml     | 24-04-26 19:09:07   | ✓       | Podaci iz XML fajl su USPESNO IMPORTOVANI               |          |
| ...   | ...             | ...                  | ...     | ...                                                      | ...      |
```

**Funkcionalnost:**

- Sortirano po `imported_at DESC` (najnoviji prvi)
- Filter dugmad: "Sve", "Samo uspešni", "Samo neuspešni", "Samo kritični"
- Klikom na red → dialog sa punim `status_message` (jer je u tabeli skraćen)
- Bez pagination — uvek prikaže poslednjih 500, sa "Load more" dugmetom

### 7.5 Forma: Gde se koristi (modal dialog)

**Layout:**

```
Gde se koristi crtež: 1133392 - Nabla 1/2"  [X]

Tabela:
| Broj crteža | Revizija | Naziv                                  | Količina | Top Level |
| 1133418     | B        | Pregradni nosač creva na robotu - zav. | 2        | ?         |
| 1140092     | A        | Sklop X                                | 4        | ✓         |
| 1156783     | C        | Vrata (Faza 1) - deo 11                | 1        | ✓         |
```

**Pravila:**

- Toggle "Direct only" / "Recursive" — direct parents vs sve parent-e
- "Top Level" kolona pokazuje koji su top-level (nemaju daljih parent-a)

---

## 8. Test scenariji

### 8.1 Unit testovi (servisni nivo)

**Test 1: BOM ekspanzija — flat assembly**
- Setup: crtež A ima 3 dece B, C, D sa količinama 1, 2, 1; svi su `is_procurement=true`
- Action: `expandBOM(A, 1)`
- Expect: `[{drawing: B, totalQty: 1}, {drawing: C, totalQty: 2}, {drawing: D, totalQty: 1}]`

**Test 2: BOM ekspanzija — multi-level**
- Setup: A ima child B (qty 2). B ima child C (qty 3, procurement=true).
- Action: `expandBOM(A, 1)`
- Expect: `[{drawing: B, totalQty: 2}, {drawing: C, totalQty: 6}]`

**Test 3: BOM ekspanzija — multiplier**
- Setup: kao Test 2, ali kvantitet sklopa = 5
- Action: `expandBOM(A, 5)`
- Expect: `[{drawing: B, totalQty: 10}, {drawing: C, totalQty: 30}]`

**Test 4: Where-used direct**
- Setup: A → B (sklop A koristi B). C → B (sklop C koristi B).
- Action: `whereUsed(B, recursive=false)`
- Expect: `[A, C]`

**Test 5: Where-used recursive**
- Setup: A → B → C (A koristi B, B koristi C)
- Action: `whereUsed(C, recursive=true)`
- Expect: `[B, A]`

**Test 6: Drawing search fuzzy**
- Setup: crteži sa nazivima `"Pregradni nosač"`, `"Pregradna ploča"`, `"Nosač creva"`
- Action: `search(q='pregradn')`
- Expect: prva dva (fuzzy match pomocu pg_trgm)

### 8.2 Integration testovi (controller + DB)

**Test 7: GET /pdm/drawings with filter**
- Setup: 100 crteža, 30 sa `material='Č0361'`, 70 sa drugim
- Action: `GET /pdm/drawings?material=Č0361`
- Expect: 30 redova u response

**Test 8: GET /pdm/drawings/:id/bom**
- Setup: sklop sa 5 podsklopova, svaki sa 3-5 komponenti
- Action: `GET /pdm/drawings/123/bom`
- Expect: recursive tree, properly nested

**Test 9: POST /pdm/import — valid XML**
- Setup: valid XML fajl sa 10 crteža i 25 BOM relacija
- Action: `POST /pdm/import` sa multipart XML
- Expect: 201 Created, `drawings` table ima 10 novih redova, `drawing_components` ima 25 novih

**Test 10: POST /pdm/import — invalid XML**
- Setup: malformed XML
- Action: `POST /pdm/import` sa lošim XML
- Expect: 400 Bad Request, log zapis u `drawing_import_log` sa `success=false`

### 8.3 E2E testovi

**Test 11: Korisnik pretraži crtež i otvori PDF**
- Login → /pdm/drawings → unesi search "1133418" → klikni red → kliknik "Otvori PDF crtež" → PDF se otvara u tab-u

**Test 12: Korisnik vidi BOM sklopa**
- Login → /pdm/drawings → klikni sklop → klikni "Sastavnica delova" → dialog otvara sa expanded BOM

**Test 13: XML import flow**
- Login (admin) → /pdm/import-log → klikni "Import XML" dugme → upload fajla → success notification + nov zapis u log-u

---

## 9. Cursor instrukcije za implementaciju

### 9.1 Sprint 3 Sprint instrukcije

```
Implementacija PDM modula za Servosync (Sprint 3 po ARCHITECTURE.md).

Kontekst:
- Pročitaj docs/ARCHITECTURE.md i docs/MODULE_SPEC_pdm.md
- Prisma šema je već u prisma/schema.prisma — koristi postojeće modele Drawing, DrawingComponent, DrawingAssembly, DrawingPdf, DrawingImportLog, DrawingStatus
- Naming convention: snake_case za DB, camelCase za TS, PascalCase za klase

Cilj Sprinta 3:
- Implementiraj NestJS modul `pdm` sa potpunim CRUD-om za drawings + BOM operacije
- API endpoints prema sekciji 5 ove specifikacije
- Unit i integration testovi prema sekciji 8

Konkretno uradi:

1. Kreiraj NestJS modul `src/modules/pdm/`:
   - pdm.module.ts
   - pdm.controller.ts
   - pdm.service.ts
   - dto/ folder sa DTO klasama:
     - drawing-response.dto.ts (response shape)
     - drawing-filter.dto.ts (filter query params)
     - bom-response.dto.ts (recursive BOM shape)
     - import-xml.dto.ts (multipart upload)
   - tests/pdm.service.spec.ts (unit testovi)
   - tests/pdm.controller.spec.ts (e2e testovi)

2. Implementiraj sledeće endpoint-e prema specifikaciji (sekcija 5):
   - GET /pdm/drawings (sa filterima)
   - GET /pdm/drawings/:id
   - GET /pdm/drawings/:id/bom
   - GET /pdm/drawings/:id/bom/parts
   - GET /pdm/drawings/:id/bom/purchased
   - GET /pdm/drawings/:id/where-used
   - GET /pdm/drawings/:id/pdf
   - GET /pdm/drawings/:id/pdf/preview
   - GET /pdm/import-log
   - GET /pdm/statuses
   - GET /pdm/designers
   - GET /pdm/materials
   - POST /pdm/import (za XML upload — placeholder za sad, parsing logika ide u Sprint 4)

3. Poslovna pravila iz sekcije 6:
   - BOM ekspanzija (rekurzivna)
   - Where-used (direct + recursive sa CTE)
   - Procurement flag handling
   - PDF storage iz drawing_pdfs.pdf_binary

4. Validacija:
   - Sve DTO klase koriste class-validator dekoratore
   - Postoji global ValidationPipe (već konfigurisan u Sprintu 0)

5. Greške:
   - Koristi custom DrawingNotFoundException, BomCircularException kad treba
   - Mapping na HTTP statuse kroz global exception filter (već postoji)

6. Auth:
   - Svi endpoint-i su zaštićeni @UseGuards(JwtAuthGuard)
   - Endpoint /pdm/import zahteva role 'ADMIN' (ostali endpoint-i prihvataju bilo kog autentifikovanog korisnika za V1)

7. Audit log:
   - POST /pdm/import operacija mora da generiše audit log entry (automatski kroz AuditLogInterceptor)

8. Swagger:
   - Sve endpoint-e dekoriši sa @ApiOperation, @ApiResponse, @ApiQuery, @ApiBody itd.
   - DTO klase imaju @ApiProperty dekoratore

9. Testovi:
   - Unit testovi za BOM ekspanziju (sekcija 8.1, testovi 1-6)
   - Integration testovi za endpoint-e (sekcija 8.2, testovi 7-10)
   - Test fixtures koriste predefinisane drawings i komponente (verovatno sa testcontainers ili in-memory Postgres)

10. Performanse:
   - Indeksi na drawings(drawing_number), drawings(catalog_number) — ako ne postoje, dodaj migraciju koja ih kreira
   - Za fuzzy search nad drawings.name koristi pg_trgm extension (ako nije instaliran, dodaj migraciju `CREATE EXTENSION IF NOT EXISTS pg_trgm`)
   - Recursive CTE za where-used (sekcija 6.2)

Ne menjaj:
- Postojeće tabele u schema.prisma (samo dodaj indekse ako su potrebni)
- Druge module (auth, users, ostali)
- Postojeću arhitekturu globalnih filter-a, pipe-ova, interceptor-a

Posle implementacije:
- Pokreni `npm run test` i osiguraj da svi testovi prolaze
- Pokreni `npm run start:dev` i testiraj endpoint-e kroz Swagger UI (/api/docs)
- Otvori PR sa imenom "feat(pdm): implement PDM module per MODULE_SPEC_pdm.md"
- U PR opisu navedi: koje endpoint-e si implementirao, koje testove si dodao, da li su sve provere prošle

PR template:

## Sprint 3 — PDM modul

Implementira PDM modul prema MODULE_SPEC_pdm.md.

### Implementirano:
- [ ] GET /pdm/drawings sa svim filterima
- [ ] GET /pdm/drawings/:id
- [ ] GET /pdm/drawings/:id/bom (rekurzivni)
- [ ] GET /pdm/drawings/:id/bom/parts
- [ ] GET /pdm/drawings/:id/bom/purchased
- [ ] GET /pdm/drawings/:id/where-used
- [ ] GET /pdm/drawings/:id/pdf
- [ ] GET /pdm/drawings/:id/pdf/preview
- [ ] GET /pdm/import-log
- [ ] GET /pdm/statuses, /pdm/designers, /pdm/materials
- [ ] POST /pdm/import (placeholder, parsing u Sprint 4)

### Testovi:
- [ ] Unit testovi prolaze (X/X)
- [ ] Integration testovi prolaze (X/X)
- [ ] Swagger UI radi i prikazuje sve endpoint-e

### Performanse:
- [ ] Indeksi na drawings.drawing_number, drawings.catalog_number
- [ ] pg_trgm ekstenzija instalirana

### Acceptance test (manual):
- [ ] Mogu da pretražim crteže po broju, materijalu, projektantu
- [ ] Mogu da otvorim sklop i vidim BOM tree
- [ ] Mogu da preuzmem PDF crteža (binary)
- [ ] Mogu da vidim where-used za bilo koji crtež
- [ ] XML import log se prikazuje sa filterima
```

### 9.2 Frontend instrukcije (paralelno sa BE)

```
Implementacija PDM frontend komponenti za Servosync (Next.js + React).

Kontekst:
- Pročitaj docs/ARCHITECTURE.md i docs/MODULE_SPEC_pdm.md
- Stack: Next.js 14+ App Router, React 18+, Tailwind CSS, shadcn/ui, TanStack Query, TanStack Table
- API client je u src/lib/api-client.ts (generisani types iz Swagger spec-a u src/types/api.ts)

Cilj:
- Implementiraj PDM forme prema sekciji 7 ove specifikacije
- Sve komponente su u src/app/pdm/ folderu (Next.js App Router routing)

Konkretno uradi:

1. Kreiraj sledeće routes (Next.js App Router):
   - src/app/pdm/page.tsx — Pregled crteža (forma 7.1)
   - src/app/pdm/[id]/page.tsx — Detalj crteža sa BOM tree (forma 7.2)
   - src/app/pdm/import-log/page.tsx — XML import log (forma 7.4)

2. Komponente u src/components/pdm/:
   - DrawingsList.tsx — glavni grid sa filterima
   - DrawingsFilters.tsx — filter panel
   - BomTreeView.tsx — rekurzivni BOM tree (koristi shadcn/ui collapsible)
   - BomPartsDialog.tsx — modal za Sastavnicu delova (forma 7.3)
   - BomPurchasedDialog.tsx — modal za Sastavnicu gotove robe
   - WhereUsedDialog.tsx — modal za "Gde se koristi" (forma 7.5)
   - PdfPreviewButton.tsx — dugme koje otvara PDF u tabu
   - DrawingDetailSidebar.tsx — desni sidebar sa detaljima izabranog crteža

3. TanStack Query hooks u src/hooks/pdm/:
   - useDrawings.ts — paginated list sa filterima
   - useDrawing.ts — single drawing detail
   - useDrawingBom.ts — BOM tree
   - useWhereUsed.ts — reverse BOM
   - useImportLog.ts — XML import log

4. UX detalji:
   - Filteri debounced 300ms
   - Empty states za prazne liste (npr. "Nema crteža za zadate filtere")
   - Loading skeletoni umesto spinner-a
   - Error states sa retry dugmetom
   - Responsive (radni stol primary, tablet sekundarni — ne mobile za V1)

5. Stilovi:
   - Tailwind utility classes
   - shadcn/ui komponente (Button, Input, Select, Dialog, Table)
   - Boje za status:
     - Zelena (default): proizvedeni delovi
     - Plava: kupovni delovi (is_procurement=true)
     - Crvena: crteži sa pdm_status='Ne postoji'

6. Testovi:
   - Component testovi sa Vitest + React Testing Library
   - Mock API responses kroz MSW (Mock Service Worker)

Ne menjaj:
- Auth flow (login/logout) — to je iz Sprinta 0
- Layout (header, sidebar) — to je app-shell layer
- API client wrapper — koristi postojeći

Posle implementacije:
- Pokreni `npm run dev` i testiraj kroz browser
- Pokreni `npm run test` — svi testovi prolaze
- Otvori PR "feat(pdm): implement PDM frontend per MODULE_SPEC_pdm.md"
```

---

## 10. Open questions / decisions

**Q1: `drawing_components` vs `drawing_assemblies` — koja je razlika?**

Iz mapping-a vidim da su obe migrirane iz BigBit-a, ali nije jasno semantičko razdvajanje. Potrebno je:
- Pitati developera koji je radio Lukino mapping
- Pogledati VBA reference u `PDM_Common.bas`
- Eventualno deprecate jedne tabele ako su iste

**Q2: Da li PDF storage ostaje u Postgres (`bytea`) ili migriramo u filesystem/S3?**

Za V1 OK je u Postgres-u (~5MB po crtežu, nema mnogo). Za V2 razmotri:
- Filesystem na Servoteh server-u (`/var/servosync/pdfs/{drawing_number}/{revision}.pdf`)
- S3-compatible storage (MinIO za on-prem)

**Q3: Kako se SolidWorks XML uploaduje? — RESOLVED u v1.1**

**Odluka V1:** Manual upload kroz UI dugme. Korisnik klikne "Import XML", izabere fajl (može i više), sistem ih procesira sekvencijalno.

V2 razmotri:
- File-drop watcher na server-u (konstruktor stavi XML u shared folder, server pojede automatski)
- Direct integration sa SolidWorks PDM API

**Q4: Status code-ovi u drawing_statuses — finalna lista?**

Trenutno predloženo: `Preuzeto`, `Postoji`, `Ne postoji`, `Pregled`, `Saglasan`. Treba potvrditi sa Servoteh projektnim biroom.

**Q5: Performanse — preview za 50,000+ crteža?**

Pregled crteža sa filterom bez WHERE klauze — koliko je realan tipičan poslednji 1000 + paginacija? Testirati u Sprintu 3 sa realnim podacima migriranim iz QBigTehn.

**Q6: Multi-revision pregled?**

Ako korisnik traži crtež `1133418`, sistem nalazi `A`, `B`, `C` revizije. Da li grid prikazuje sve ili samo poslednju? Trenutno mapping kaže prikaži sve (svaki red je `(drawing_number, revision)` jedinstven). Treba potvrditi sa korisnicima.

**Q7: Štampa sastavnice?**

PDF specifikacija pokazuje dugme "Štampaj sastavnicu" — to nije isto što i "Štampaj PDF crtež". Sastavnica je tabela. Trebamo:
- HTML render → browser print
- Ili generisati PDF na backend strani (jspdf, puppeteer)

**Preporuka:** HTML render → CSS print styles → `window.print()`. Najjednostavnije za V1.

**Q8: Cross-modul "context" endpoint performance — V1.1 novo pitanje**

`GET /pdm/drawings/:id/context` radi 3-4 JOIN-a kroz druge module (drafts, handovers, work orders). Za jedan crtež brzo, ali ako se zove iz sidebar-a na svaki klik u tabeli sa 1000 redova, može da bude problem.

**Preporuka:** lazy loading — context se učitava tek kad korisnik klikne na red. Eventualno cache 60s na klijent strani.

**Q9: Legacy denormalizovan `project_name` i `work_order_ref` polja — V1.1 novo pitanje**

Trenutno su u šemi kao tekstualna polja koja se popunjavaju "negde" posle prve primopredaje. Treba odlučiti:

- (a) Sistem **automatski denormalizuje** ove vrednosti pri kreiranju HandoverDraft-a (trigger ili event listener)
- (b) Polja **ostaju prazna** i koriste se samo za legacy podatke migrirane iz BigBit-a (postoji u QMegaTeh-u)
- (c) Polja se **deprecate** u V2 i koristi se samo cross-modul JOIN

**Preporuka za V1:** Opcija (a) — koristiti event listener `handover.batch_created` koji ažurira `project_name` i `work_order_ref` na svim crtežima u nacrtu. To olakšava brzu pretragu bez constant JOIN-a, i kompatibilno je sa starim podacima.

**Q10: Tehnolog UI — da li skroz isti pregled crteža kao projektni biro?**

Iz odgovora: "Tehnolog vidi te crteže ali oni nemaju dodeljenu tehnologiju niti broj predmeta jer nisu lansirani ali ih ima u nekom od prikaza."

**Pitanje:** Da li tehnolog ima:
- (a) **Isti UI** kao projektni biro (svi crteži, isti filteri) + dodatne dugmiće za primopredaje?
- (b) **Filter view** koji prikazuje samo crteže koji imaju aktivnu primopredaju za njega (njegov "inbox")?

**Preporuka za V1:** Opcija (a) sa role-based dugmadima. Tehnolog vidi sve crteže u PDM Pregled, plus poseban "Moje primopredaje" view u Primopredaje modulu. RBAC za V2.

---

## 11. Reference

- `BB_Tehnologija_opis.pdf` — strane 2-3 (vizuelni opis svih PDM ekrana)
- `legacy/QMegaTeh_Reference.md` — Dodatak F (PDM glossary), sekcija 8 (PDM domen u VBA kodu)
- VBA moduli:
  - `PDM_Common.bas` — glavna PDM biznis logika (~1452 LOC)
  - `PDM_Class.cls` — PDM state management
  - `PDM_PDFCommon.bas` — PDF handling
  - `PDMXMLParser.bas` — XML import parser
- `schema.prisma` — definicije svih Drawing* tabela
- `schema-rename-map.md` — mapiranje srpskih ↔ engleskih imena

---

## 12. Verzija

| Verzija | Datum | Šta se promenilo |
|---|---|---|
| 1.0 | maj 2026 | Inicijalna specifikacija PDM modula za V1 |
| 1.1 | maj 2026 | Korekcija razumevanja toka — predmet se NE dodeljuje u PDM-u (nego u Nacrti modulu kroz HandoverDraft.projectId); `projectName` i `workOrderRef` označeni kao **legacy denormalizovan tekst**, ne FK reference; "Kreiranje primopredaje" eksplicitno označeno kao navigation link u Nacrti modul, ne PDM funkcija; dodat novi endpoint `GET /pdm/drawings/:id/context` koji vraća cross-modul agregat (drafts + handovers + work orders); UI sidebar redizajniran da prikazuje pravu cross-modul kontekst; novi open questions Q8, Q9, Q10 vezani za v1.1 koncepte; Q3 (XML upload) resolved kao manual upload za V1 |

---

*Kraj MODULE_SPEC_pdm.md*

# Servosync — Module Spec: Nacrti i Primopredaje

| | |
|---|---|
| **Modul** | Nacrti i Primopredaje (Draft & Handover Workflow) |
| **Verzija specifikacije** | 1.0 |
| **Datum** | maj 2026 |
| **Sprint** | 4 (po ARCHITECTURE.md planu) |
| **Korisnici modula** | Projektni biro (kreira nacrte), Tehnolozi (odobravaju primopredaje, lansiraju proizvodnju), svi (primaju notifikacije) |
| **Status** | Specifikacija za implementaciju |

---

## 0. Kako koristiti ovaj dokument

Ovo je specifikacija **najkritičnijeg workflow modula** u Servosync sistemu — Nacrti i Primopredaje. To je tačka gde se **PDM crteži vežu za poslovne projekte (predmete)** i gde se kreiraju radni nalozi za proizvodnju. Bez ovog modula:

- PDM crteži stoje u sistemu bez konteksta proizvodnje
- Radni nalozi se ne mogu kreirati automatski
- Tehnolozi nemaju mehanizam za odobravanje šta ide u proizvodnju
- Nema audit trail-a "ko je odlučio da se ovaj crtež radi"

Modul povezuje **3 koncepta**:
1. **Nacrti** (handover_drafts) — projektant priprema spisak crteža za predaju u proizvodnju
2. **Primopredaje** (drawing_handovers) — tehnolog odobrava ili odbija nacrte
3. **Lansiranje** — kreiranje radnih naloga iz odobrenih primopredaja

Plus **notifikacije** — sistem za obaveštavanje korisnika o promenama u workflow-u.

**Pre čitanja:**
- `ARCHITECTURE.md` — strateški kontekst
- `MODULE_SPEC_pdm.md` — kako PDM funkcioniše
- `schema.prisma` — definicije HandoverDraft, HandoverDraftItem, DrawingHandover, HandoverStatus, HandoverDraftStatus, Notification
- `BB_Tehnologija_opis.pdf` — strane 5-8 (Nacrti, Primopredaje, Lansiranje)
- `legacy/QMegaTeh_Reference.md` — sekcija o Primopredajama u VBA kodu

---

## 1. Cilj modula

**Šta modul radi:**

Implementira **kompletan workflow** od trenutka kad projektant odluči da crtež ide u proizvodnju do trenutka kad se kreira radni nalog:

```
Projektant (PDM crtež bez predmeta)
        ↓ (kreira nacrt primopredaje)
Nacrt primopredaje (sa dodeljenim predmetom!)
        ↓ (predaje tehnologu)
Primopredaja (na odobravanju)
        ↓ (tehnolog odobri ili odbije)
Odobreno / Odbijeno
        ↓ (samo ako odobreno, tehnolog lansira)
Lansirana primopredaja → kreiran Radni nalog
```

**Zašto je dvostepen (Nacrt → Primopredaja → Lansiranje):**

- **Nacrt** je projektant-side dokument — "ovo planiram da pošaljem u proizvodnju"
- **Primopredaja** je proizvodnja-side dokument — "tehnolog je formalno preuzeo i odobrio"
- **Lansiranje** je trenutak rađanja RN-a — proizvodnja zvanično počinje

Ovaj dvostepeni proces postoji zato što:
- Projektant može da napravi nacrt pa promeni mišljenje (briše ili menja pre primopredaje)
- Tehnolog treba pravo veta — može da odbije nacrt ako nešto nije OK (npr. nedostaje informacija, dimenzija je sumnjiva, BOM nije kompletan)
- Audit trail — zna se ko je odlučio i kada

**Veza sa drugim modulima:**

- **PDM modul** — izvor crteža za nacrte. Projektant bira crteže iz PDM-a kad kreira nacrt
- **Work Orders (RN) modul** — *destinacija* — Lansiranje kreira RN zapise sa svim potrebnim podacima
- **Notifikacije** — push obaveštenja u toku workflow-a
- **MRP modul** — kad je RN kreiran, MRP počinje da računa potrebe materijala za njega

---

## 2. Skop modula (iz BB_Tehnologija_opis.pdf, strane 5-8)

### 2.1 Ekrani u skopu Sprinta 4

**Iz NACRTI modula (PDF strana 5):**

| # | Ekran (legacy ime) | Engleski naziv | Korisnik | Tabele |
|---|---|---|---|---|
| 1 | Pregled nacrta | Drafts list | Projektni biro | `handover_drafts` |
| 2 | Pregled predatih nacrta | Submitted drafts list (color-coded) | Projektni biro | `handover_drafts`, status filter |
| 3 | Kreiraj primopredaju | Create draft (wizard) | Projektni biro | `handover_drafts`, `handover_draft_items` |
| 4 | Nacrti primopredaje (detail) | Draft detail | Projektni biro | `handover_drafts`, `handover_draft_items` |

**Iz PRIMOPREDAJE modula (PDF strane 6-7):**

| # | Ekran | Engleski naziv | Korisnik | Tabele |
|---|---|---|---|---|
| 5 | Odobravanje primopredaja | Pending approval | Tehnolog | `drawing_handovers` filtered by status |
| 6 | Odobrene | Approved (waiting for tech process) | Tehnolog | `drawing_handovers` filtered |
| 7 | Odbijene | Rejected | Tehnolog | `drawing_handovers` filtered |
| 8 | Lansirane | Launched (RN created) | Svi | `drawing_handovers` filtered |
| 9 | Pregled svih primopredaja | All handovers | Svi | `drawing_handovers` |
| 10 | Izbor tehnologa (dialog) | Tehnolog selector | Projektant pri odobravanju | `workers` filtered |

**Iz LANSIRANJE modula (PDF strana 8):**

| # | Ekran | Status | Razlog |
|---|---|---|---|
| - | Lansiranje primopredaje | **NIJE u skopu** | Eksplicitno označeno "NEPOTREBAN" i "DUPLIRANA OPCIJA" u PDF-u. Lansiranje se radi iz "Odobrene" forme direktno (dugme "Lansiraj RN") |

### 2.2 Push notifikacije (V1 — in-app)

| Trigger | Notification message | Recipient |
|---|---|---|
| Projektant kreira nacrt → predaje | "Novi nacrt za odobravanje: [draft_number]" | Svi tehnolozi (broadcast) ILI izabrani tehnolog |
| Tehnolog odobri primopredaju | "Tehnolog [name] odobrio primopredaju [number]" | Projektant koji je kreirao |
| Tehnolog odbije primopredaju | "Tehnolog [name] odbio primopredaju [number]: [razlog]" | Projektant |
| Tehnolog lansira RN | "Lansiran RN [wo_number] iz primopredaje [handover_number]" | Projektant + svi koji su uključeni u proizvodnju |

### 2.3 Šta NIJE u skopu V1

- **Email notifikacije** — V2
- **WhatsApp notifikacije** — V3
- **WebSocket real-time push** — V1 koristi polling (frontend pita server na 30s)
- **Editor za nacrte posle predaje** — kad je nacrt jednom predaje (statusId promenjen), ne može se menjati. Mora se obrisati i kreirati novi
- **Bulk operacije** (odobri/odbij više primopredaja odjednom) — V2
- **Notifikacija o "kasnenju"** — npr. "Primopredaja [X] čeka odobravanje već 3 dana" — V2

---

## 3. Tabele koje koristi

### 3.1 Glavne tabele

**`handover_drafts`** (Nacrt primopredaje)

Iz Lukin schema:
- `id` (Int PK)
- `designer_id` (FK → workers) — **projektant** koji je kreirao nacrt
- `draft_date` (Timestamp, default now)
- `project_id` (FK → projects) — **TAČKA DODELE PREDMETA** — ovde se predmet prvi put vezuje za crteže
- `piece_count` (Int) — broj komada za proizvodnju
- `status_id` (FK → handover_draft_statuses, default 0)
- `note` (VarChar 250)
- `signature` (VarChar 30)
- `draft_number` (VarChar 30, default "") — broj nacrta (auto-generated, format `G-{yymmdd}-{seq}`)
- `is_locked` (Boolean, default false) — kad se nacrt zaključa, ne može se menjati
- `draft_type` (SmallInt, default 0) — tip nacrta (videti dole)
- `main_drawing_id` (FK → drawings, nullable) — **glavni crtež sklopa** ako je nacrt za ceo sklop

**`draft_type` enum vrednosti** (potvrditi sa Vasom, pretpostavljam):
- `0` = Glavni sklop (cela mašina) — `main_drawing_id` je top-level
- `1` = Pojedinačni sklop (jedan sklop unutar mašine)
- `2` = Podsklopovi (lista podsklopova zasebno)

**OPEN QUESTION:** Treba potvrditi tačne vrednosti i njihovo značenje. Predlog je da se kreira lookup tabela `draft_types` ako su semantički različite, ili enum u kodu.

**`handover_draft_items`** (Stavke nacrta)

- `id` (Int PK)
- `draft_id` (FK → handover_drafts)
- `drawing_id` (FK → drawings) — komponenta nacrta
- `quantity_to_produce` (Int, default 1)
- `main_drawing_id` (FK → drawings, nullable) — ako je stavka deo većeg sklopa
- `is_main` (Boolean, default false) — flag za glavni crtež nacrta
- `pre_check_duplicate` (Boolean) — flag "ovaj crtež je već u nekom drugom nacrtu"
- `pre_check_draft_id` (FK self → handover_drafts, nullable) — koji nacrt je već ima
- `pre_check_work_order_id` (FK → work_orders, nullable) — RN ako je već lansirana
- `exclude_from_handover` (Boolean) — projektant može da isključi stavku iz primopredaje
- `decision_action` (SmallInt, default 0) — akcija odluke (0=ostavi, 1=isključi, ...)
- `decision_date_time` (Timestamp, nullable)
- `quantity_defined_in_drawing` (Int, default 0) — količina definisana u crtežu (informativno)
- `note` (VarChar 250)
- `signature` (VarChar 30)

**`drawing_handovers`** (Primopredaja crteža — formalni dokument)

- `id` (Int PK)
- `drawing_id` (FK → drawings)
- `handover_date` (Timestamp)
- `handover_worker_id` (FK → workers) — **kome se predaje (tehnolog)**
- `status_id` (FK → handover_statuses) — status primopredaje
- `status_changed_at` (Timestamp, nullable)
- `status_changed_by_id` (FK → workers, nullable)
- `status_change_comment` (VarChar 250, nullable) — **razlog odbijanja ili komentar**
- `launched_at` (Timestamp, nullable) — **kad je lansirana proizvodnja**
- `launched_by_id` (FK → workers, nullable)
- `note` (VarChar 250)
- `signature` (VarChar 30)
- `is_locked` (Boolean, default false)

**`drawing_handover_pdfs`** (Dokumenti uz primopredaju)

- `id`, `handover_id`, `file_link`, `file_name`
- Unique: `(handoverId, fileLink)`

### 3.2 Lookup tabele

**`handover_draft_statuses`**:

Seed (treba potvrditi sa Servoteh-om):
```
0 - Za kreiranje    (draft tek započet)
1 - Za primopredaju (gotov, čeka prelazak u primopredaju)
2 - Predat           (poslat u primopredaje)
3 - Odbijen          (tehnolog odbio)
4 - Lansiran         (RN-ovi kreirani)
5 - Storniran        (projektant otkazao)
```

**`handover_statuses`**:

Seed (treba potvrditi):
```
0 - Saglasan         (odobreno, čeka tehnologiju)
1 - Odbijen          (tehnolog odbio)
2 - U obradi         (tehnolog radi tehnološki postupak)
3 - Lansiran         (RN kreiran)
4 - Zaključen        (RN završen, primopredaja zaključena)
```

### 3.3 Nova tabela koju dodajemo — `app_notifications`

Postojeća `notifications` tabela u Lukin šemi je legacy `Info` — nema kanala, nema entity reference. Predlog **nove tabele** za V1 push notifications:

```prisma
model AppNotification {
  id            Int       @id @default(autoincrement())
  recipientUserId Int     @map("recipient_user_id")  // FK → users
  channel       String    @map("channel")             // 'in_app', 'email' (V2), 'whatsapp' (V3)
  type          String    @map("type")                // 'draft_submitted', 'handover_approved', ...
  title         String    @map("title") @db.VarChar(255)
  message       String    @map("message") @db.VarChar(1000)
  entityType    String?   @map("entity_type")         // 'handover_draft', 'drawing_handover', 'work_order'
  entityId      Int?      @map("entity_id")
  actionUrl     String?   @map("action_url") @db.VarChar(500)  // deep-link u frontend (npr. /primopredaje/123)
  readAt        DateTime? @map("read_at") @db.Timestamp(6)
  sentAt        DateTime  @default(now()) @map("sent_at") @db.Timestamp(6)
  metadata      Json?
  
  recipient     User      @relation(fields: [recipientUserId], references: [id], onDelete: Cascade)
  
  @@index([recipientUserId, readAt])
  @@index([entityType, entityId])
  @@map("app_notifications")
}
```

**Migracija u Sprint 4:** dodaj ovu tabelu kroz Prisma migration. Stari `notifications` tabela ostaje (legacy), ali nova `app_notifications` je za sve novo.

### 3.4 Veze sa Worker tabelom

Već postoje flags u `workers` koje su ključne za workflow:

- **`defines_approval`** (Boolean) — radnik ima pravo da odobrava primopredaje (tehnolog flag)
- **`defines_launch`** (Boolean) — radnik ima pravo da lansira proizvodnju (samo viši tehnolozi/menadžment)
- **`worker_type_id`** (FK → worker_types) — vrsta posla (Tehnolog, Projektant, Majstor, Kontrolor, Montaža, Inženjeri)

**Pravilo:** samo radnici sa `defines_approval = true` se prikazuju u dijalogu "Izbor tehnologa" pri primopredaji.

---

## 4. Domenski rečnik

| Srpski termin | Engleski u kodu | Šta znači |
|---|---|---|
| Nacrt (primopredaje) | (handover) draft | Projektantov spisak crteža za predaju u proizvodnju |
| Primopredaja | drawing handover | Formalni dokument predaje crteža tehnologu na odobravanje |
| Projektant | designer | Konstruktor iz projektnog biroa koji kreira nacrt |
| Tehnolog | technologist (worker sa `defines_approval=true`) | Osoba koja odobrava primopredaje i radi tehnologiju |
| Glavni crtež | main drawing | Top-level sklop u nacrtu (ako nacrt ima hijerarhiju) |
| Tip nacrta | draft type | Glavni sklop / Pojedinačni sklop / Podsklopovi |
| Lansiranje | launch | Kreiranje RN-a iz odobrene primopredaje |
| Saglasan | approved | Tehnolog odobrio primopredaju |
| Odbijen | rejected | Tehnolog odbio primopredaju (sa razlogom) |
| Predmet | project | Poslovni projekat / kontekst za koji se radi proizvodnja |
| Broj nacrta | draft number | Auto-generated identifikator nacrta (npr. `G-260424-001`) |
| Broj primopredaje | handover number | Auto-generated identifikator primopredaje |
| Stavka nacrta | draft item | Jedan red u nacrtu (jedan crtež sa količinom) |
| Pre-check duplikata | duplicate pre-check | Provera da li je crtež već u nekom drugom otvorenom nacrtu |
| Notifikacija | notification | Sistemska poruka korisniku o promenama workflow-a |

---

## 5. State machine — Glavni workflow

### 5.1 Kompletan flow dijagram

```
                            PROJEKTANT
                                │
                                │ (kreira nacrt iz PDM Pregled crteža)
                                ▼
                    ┌──────────────────────┐
                    │  HandoverDraft       │
                    │  status: ZaKreiranje │ ← može da menja, briše
                    └──────────┬───────────┘
                               │
                               │ (projektant dodaje stavke, ureduje, valja)
                               │
                               ▼
                    ┌──────────────────────┐
                    │  HandoverDraft       │
                    │  status: ZaPrimopr.  │ ← spreman ali nije još predat
                    └──────────┬───────────┘
                               │
                               │ (projektant klikne "Predaj")
                               │
                               ▼
                    ┌──────────────────────┐
                    │  HandoverDraft       │ ← LOCKED, projektant ne može više da menja
                    │  status: Predat      │
                    │  is_locked: TRUE     │
                    └──────────┬───────────┘
                               │
                               │ (sistem AUTOMATSKI kreira:)
                               │  - DrawingHandover record po svakoj stavci
                               │  - Notification ka tehnolozima
                               │
                               ▼
                    ┌──────────────────────┐
                    │  DrawingHandover     │
                    │  status: NaCekanju   │ ← čeka odobravanje
                    └──────────┬───────────┘
                               │
                               │ (tehnolog otvori, pregleda)
                               │
                          ┌────┴────┐
                          │         │
                       ODOBRI   ODBIJ
                          │         │
                          ▼         ▼
            ┌──────────────────┐  ┌──────────────────┐
            │  DrawingHandover │  │  DrawingHandover │
            │  status:Saglasan │  │  status: Odbijen │
            │  status_changed  │  │  status_change_  │
            │  _by_id = tehn.  │  │  comment = razlog│
            └────────┬─────────┘  └────────┬─────────┘
                     │                     │
                     │ (notif. projektantu)│ (notif. projektantu)
                     │                     │
                     │                     ▼
                     │              ┌─────────────────┐
                     │              │ Projektant      │
                     │              │ kreira novi     │
                     │              │ nacrt sa fix-om │
                     │              └─────────────────┘
                     │
                     │ (tehnolog uradi tehnološki postupak, vrati se)
                     │ (klikne "Lansiraj RN")
                     │
                     ▼
            ┌──────────────────┐
            │  DrawingHandover │
            │  status:Lansiran │
            │  launched_at=now │
            │  launched_by_id  │
            └────────┬─────────┘
                     │
                     │ (sistem AUTOMATSKI kreira WorkOrder)
                     │
                     ▼
            ┌──────────────────┐
            │  WorkOrder       │ ← Radni nalog ulazi u proizvodnju
            │  status: Aktivan │
            └──────────────────┘
```

### 5.2 Status transitions sa pravilima

**HandoverDraft transitions:**

| From | To | Trigger | Pravila |
|---|---|---|---|
| (none) | `ZaKreiranje` | Projektant kreira nacrt | designer_id = current user; project_id required; main_drawing_id required |
| `ZaKreiranje` | `ZaPrimopredaju` | Projektant označi "Spreman za primopredaju" | Nacrt mora imati barem 1 stavku |
| `ZaPrimopredaju` | `Predat` | Projektant klikne "Predaj" | is_locked = TRUE; kreiraju se DrawingHandover entry-ji; šalju se notifikacije |
| Bilo koji | `Storniran` | Projektant otkazuje | Samo ako `is_locked = FALSE` |
| `Predat` | `Lansiran` | Sve njegove primopredaje su lansirane | Automatski (sistemski compute) |
| `Predat` | `Odbijen` | Sve njegove primopredaje su odbijene | Automatski |

**DrawingHandover transitions:**

| From | To | Trigger | Pravila |
|---|---|---|---|
| (none) | `NaCekanju` | Auto-kreirana iz Predat draft-a | handover_worker_id = tehnolog izabran u dialogu |
| `NaCekanju` | `Saglasan` | Tehnolog odobri | Samo radnik sa defines_approval=TRUE može; obavezan comment ako prelazi 3 dana |
| `NaCekanju` | `Odbijen` | Tehnolog odbije | status_change_comment OBAVEZAN |
| `Saglasan` | `UObradi` | Tehnolog počinje tehnološki postupak | (Soft transition, opcionalno) |
| `Saglasan` ili `UObradi` | `Lansiran` | Tehnolog klikne "Lansiraj RN" | Samo radnik sa defines_launch=TRUE; kreira se WorkOrder zapis |
| `Lansiran` | `Zaključen` | RN se završi u proizvodnji | (Cross-modul event iz WorkOrders modula) |

### 5.3 Cross-module events

Modul emituje sledeće NestJS events:

```typescript
// kad se kreira novi DrawingHandover (iz Predat draft-a)
this.eventEmitter.emit('handover.created', { handoverId, draftId });

// kad tehnolog odobri
this.eventEmitter.emit('handover.approved', { handoverId, approvedBy });

// kad tehnolog odbije
this.eventEmitter.emit('handover.rejected', { handoverId, rejectedBy, comment });

// kad se lansira RN
this.eventEmitter.emit('handover.launched', { handoverId, workOrderId });
```

**Listeneri:**
- `NotificationService` — sluša sve events, kreira `AppNotification` zapise
- `WorkOrdersService` — sluša `handover.launched`, kreira `WorkOrder` zapis
- `AuditService` — sluša sve events, kreira `AuditLog` zapise

---

## 6. API endpoints

### 6.1 Nacrti (handover_drafts)

**`GET /api/v1/handover-drafts`** — lista nacrta sa filterima

Query params:
- `status_id` — filter po statusu
- `designer_id` — filter po projektantu (default: current user ako role = projektant)
- `project_id` — filter po predmetu
- `date_from`, `date_to` — vremenski opseg po `draft_date`
- `is_locked` — boolean filter
- `cursor`, `limit`

Response:
```json
{
  "data": [
    {
      "id": 2259,
      "draftNumber": "G-260424-001",
      "draftDate": "2026-04-24T12:18:14Z",
      "draftType": 0,
      "designer": {
        "id": 13,
        "fullName": "Nikodijević Miljan"
      },
      "project": {
        "id": 9611,
        "projectNumber": "9611-1",
        "name": "Termička linija ST-TO-14"
      },
      "mainDrawing": {
        "id": 12345,
        "drawingNumber": "G-9611-1/3",
        "name": "Sklop F",
        "revision": "B"
      },
      "pieceCount": 1,
      "status": {
        "id": 0,
        "name": "Za Kreiranje"
      },
      "itemsCount": 47,
      "isLocked": false,
      "createdAt": "2026-04-24T12:18:14Z",
      "updatedAt": "2026-04-24T12:18:14Z"
    }
  ],
  "meta": {
    "pagination": { "next_cursor": "...", "has_more": true },
    "total_count": 234
  }
}
```

**`GET /api/v1/handover-drafts/:id`** — detalj nacrta sa stavkama

Response: kompletan nacrt + lista svih `handover_draft_items` sa expand-ovanim drawing reference.

**`POST /api/v1/handover-drafts`** — kreiraj nov nacrt

Request body:
```json
{
  "projectId": 9611,
  "mainDrawingId": 12345,
  "draftType": 0,
  "pieceCount": 1,
  "note": "Prvo izdanje za 14. OKTOBAR"
}
```

Response: kreiran nacrt sa auto-generated `draftNumber` (format `G-{yymmdd}-{seq}` gde je `seq` daily sequence broj).

**`PATCH /api/v1/handover-drafts/:id`** — ažuriraj nacrt

Body: parcijalni update (osim immutable polja: `designer_id`, `draft_number`, `created_at`).

**Pravila:**
- Ne može se ažurirati ako `is_locked = TRUE` (status `Predat` ili dalje)
- Ne može se promeniti `project_id` ako već postoje stavke (mora se nacrt obrisati i kreirati novi)

**`DELETE /api/v1/handover-drafts/:id`** — obriši nacrt

**Pravila:**
- Soft delete (`deleted_at`)
- Samo ako `is_locked = FALSE`
- Briše i sve `handover_draft_items`

### 6.2 Stavke nacrta (handover_draft_items)

**`GET /api/v1/handover-drafts/:draftId/items`** — sve stavke nacrta

Response: lista stavki sa expand-ovanim drawing info.

**`POST /api/v1/handover-drafts/:draftId/items`** — dodaj stavku

Request body:
```json
{
  "drawingId": 11334,
  "quantityToProduce": 2,
  "mainDrawingId": 12345,  // opcionalno, ako je deo glavnog sklopa
  "isMain": false,
  "note": "Komponenta sa zaštitnim premazom"
}
```

**Auto provera duplikata:** pre nego što se kreira stavka, sistem proverava:
- Da li `drawing_id` već postoji u drugom otvorenom nacrtu (status != Storniran/Odbijen)
- Da li postoji aktivan RN za taj crtež (`work_orders` sa statusom != Završen/Otkazan)

Ako oba `false` → kreira stavku normalno (`pre_check_duplicate = false`).

Ako jedan ili oba `true` → kreira stavku sa `pre_check_duplicate = true` i postavlja `pre_check_draft_id` / `pre_check_work_order_id`. UI prikazuje upozorenje, ali projektant može da prelazi (klik "Dodaj svejedno").

**`PATCH /api/v1/handover-draft-items/:id`** — ažuriraj stavku

Polja koja se mogu menjati: `quantityToProduce`, `excludeFromHandover`, `note`, `decisionAction`.

**`DELETE /api/v1/handover-draft-items/:id`** — ukloni stavku iz nacrta

### 6.3 Predaja nacrta u primopredaju

**`POST /api/v1/handover-drafts/:id/submit`** — predaj nacrt u primopredaju

Request body:
```json
{
  "technologistId": 7,  // opcionalno, ako se daje konkretnom tehnologu; ako null, broadcast svim tehnolozima
  "comment": "Hitno, klijent traži za 2 nedelje"
}
```

**Šta se dešava (transakcijski):**

1. Validacija: nacrt mora biti u statusu `ZaPrimopredaju` ili `ZaKreiranje` sa barem 1 stavkom
2. Update: `handover_drafts.status_id = 2 (Predat)`, `is_locked = TRUE`
3. Kreiraju se `DrawingHandover` zapisi:
   - Po jedan za svaku stavku u nacrtu (osim onih sa `exclude_from_handover = true`)
   - `drawing_id` = `handover_draft_items.drawing_id`
   - `handover_worker_id` = `technologistId` (ako prosleđen) ili NULL (broadcast)
   - `status_id` = 0 (NaCekanju)
   - `handover_date` = now()
4. Šalju se notifikacije:
   - Ako `technologistId` prosleđen → notifikacija samo tom korisniku
   - Ako null → notifikacije svim radnicima sa `defines_approval = true`
5. Audit log: `SUBMIT_DRAFT` action

Response:
```json
{
  "data": {
    "draft": { /* updated draft */ },
    "handoversCreated": 47,
    "notificationsSent": 5
  }
}
```

### 6.4 Primopredaje (drawing_handovers)

**`GET /api/v1/handovers`** — lista primopredaja sa filterima

Query params:
- `status_id` — filter (`NaCekanju`, `Saglasan`, `Odbijen`, `Lansiran`, ...)
- `handover_worker_id` — filter "moje primopredaje" (current tehnolog)
- `designer_id` — filter po projektantu (iz povezanog drafta)
- `project_id` — filter po predmetu
- `drawing_number` — search
- `date_from`, `date_to`
- `cursor`, `limit`

Response: standardna paginated lista.

**`GET /api/v1/handovers/:id`** — detalj

**`POST /api/v1/handovers/:id/approve`** — odobri primopredaju

Request body:
```json
{
  "comment": "OK, materijal dostupan, krećemo"
}
```

Pravila:
- Auth: current user must have `worker.defines_approval = true`
- Status mora biti `NaCekanju`

Transakcija:
1. `drawing_handovers.status_id = 1 (Saglasan)`
2. `status_changed_at = now()`, `status_changed_by_id = current user`
3. `status_change_comment = comment` (opcionalno)
4. Notifikacija projektantu
5. Audit log

**`POST /api/v1/handovers/:id/reject`** — odbij primopredaju

Request body:
```json
{
  "comment": "Nedostaje materijal u BOM-u za poziciju X"
}
```

Pravila:
- Auth: `defines_approval = true`
- Status mora biti `NaCekanju`
- `comment` JE OBAVEZAN (razlika od `approve` gde je opcionalan)

Transakcija slično `approve`-u + obavezan comment.

**`POST /api/v1/handovers/:id/launch`** — lansiraj primopredaju (kreira RN)

Request body:
```json
{
  "comment": "Lansirano za sledeću smenu",
  "dueDate": "2026-08-01"
}
```

Pravila:
- Auth: `defines_launch = true`
- Status mora biti `Saglasan` ili `UObradi`

Transakcija:
1. Kreira se `WorkOrder` zapis sa:
   - `drawing_id` = primopredaja.drawing_id
   - `project_id` = preuzeto iz povezanog draft.project_id
   - `partner_id` = preuzeto iz project.customer_id
   - `quantity` = handover_draft_items.quantity_to_produce
   - `due_date` = request.dueDate
   - `status` = LAUNCHED
2. `drawing_handovers.status_id = 3 (Lansiran)`
3. `launched_at = now()`, `launched_by_id = current user`
4. Notifikacije svima uključenima
5. Audit log

Response:
```json
{
  "data": {
    "handover": { /* updated */ },
    "workOrder": {
      "id": 8856,
      "woNumber": "9611-1/300",
      "status": "LAUNCHED"
    }
  }
}
```

### 6.5 Pomoćni endpoint-i

**`GET /api/v1/handovers/pending-approval`** — moje primopredaje na čekanju (tehnolog inbox)

Filter automatski: `status_id = 0` AND `handover_worker_id = current_user` OR `handover_worker_id IS NULL` (broadcast).

**`GET /api/v1/workers/technologists`** — lista tehnologa za dialog "Izbor tehnologa"

Filter: `defines_approval = true` AND `active = true`.

**`GET /api/v1/handover-draft-statuses`** — lookup
**`GET /api/v1/handover-statuses`** — lookup

### 6.6 Notifications

**`GET /api/v1/notifications`** — moje notifikacije

Query params:
- `unread_only` (boolean) — samo nepročitane
- `channel` — default `in_app`
- `cursor`, `limit`

Response:
```json
{
  "data": [
    {
      "id": 5678,
      "type": "handover_pending_approval",
      "title": "Nova primopredaja čeka odobravanje",
      "message": "Primopredaja #4521 za crtež 1089151-B (predmet 9611-1)",
      "entityType": "drawing_handover",
      "entityId": 4521,
      "actionUrl": "/primopredaje/4521",
      "readAt": null,
      "sentAt": "2026-05-12T14:23:00Z",
      "metadata": {
        "draftId": 2259,
        "drawingNumber": "1089151-B"
      }
    }
  ],
  "meta": {
    "unreadCount": 12,
    "total_count": 87
  }
}
```

**`PATCH /api/v1/notifications/:id/read`** — markiraj kao pročitano

**`PATCH /api/v1/notifications/mark-all-read`** — markiraj sve kao pročitane

**Frontend polling:** svako 30s frontend pita `GET /notifications?unread_only=true&limit=10` za badge counter i recent unread.

---

## 7. Poslovna pravila — detalji

### 7.1 Auto-generisanje `draft_number`

Format: `G-{yymmdd}-{seq}` (primer: `G-260424-001` za prvi nacrt 24.04.2026)

```typescript
async generateDraftNumber(): Promise<string> {
  const today = new Date();
  const yymmdd = format(today, 'yyMMdd');
  const prefix = `G-${yymmdd}-`;
  
  const latestToday = await this.prisma.handoverDraft.findFirst({
    where: {
      draftNumber: { startsWith: prefix },
    },
    orderBy: { draftNumber: 'desc' },
  });
  
  const seq = latestToday
    ? parseInt(latestToday.draftNumber.split('-')[2]) + 1
    : 1;
  
  return `${prefix}${String(seq).padStart(3, '0')}`;
}
```

**Concurrency:** koristi Postgres `ADVISORY LOCK` ili `SERIALIZABLE` transakciju da se izbegnu duplikati pri istovremenom kreiranju.

### 7.2 Provera duplikata pri dodavanju stavke

Trigger: pri `POST /handover-drafts/:id/items`.

```sql
-- Pre dodavanja stavke, sistem proverava
WITH 
  active_drafts AS (
    SELECT 
      hdi.draft_id, 
      hdi.id AS item_id,
      hd.draft_number,
      hd.status_id
    FROM handover_draft_items hdi
    JOIN handover_drafts hd ON hd.id = hdi.draft_id
    WHERE hdi.drawing_id = :drawingId
      AND hd.status_id NOT IN (3 /* Odbijen */, 5 /* Storniran */)
      AND hd.deleted_at IS NULL
  ),
  active_wos AS (
    SELECT id, wo_number
    FROM work_orders
    WHERE drawing_id = :drawingId
      AND status NOT IN ('COMPLETED', 'CANCELED')
  )
SELECT 
  (SELECT json_agg(active_drafts) FROM active_drafts) AS drafts,
  (SELECT json_agg(active_wos) FROM active_wos) AS work_orders;
```

Ako su rezultati prazni → `preCheckDuplicate = false`, dodaje normalno.

Ako bilo koji ima rezultata → `preCheckDuplicate = true`, set `preCheckDraftId` ili `preCheckWorkOrderId`. UI prikazuje upozorenje, korisnik može da prelazi sa `?force=true` parametrom.

### 7.3 Auto-kreiranje DrawingHandover-a pri Submit-u nacrta

```typescript
async submitDraft(draftId: number, technologistId?: number, comment?: string) {
  return this.prisma.$transaction(async (tx) => {
    const draft = await tx.handoverDraft.findUnique({
      where: { id: draftId },
      include: { items: true },
    });
    
    if (!draft) throw new DraftNotFoundException(draftId);
    if (draft.isLocked) throw new DraftAlreadySubmittedException(draftId);
    
    // 1. Lock draft
    await tx.handoverDraft.update({
      where: { id: draftId },
      data: { statusId: 2, isLocked: true },
    });
    
    // 2. Kreiraj DrawingHandover po stavci
    const handovers = [];
    for (const item of draft.items) {
      if (item.excludeFromHandover) continue;
      
      const handover = await tx.drawingHandover.create({
        data: {
          drawingId: item.drawingId,
          handoverDate: new Date(),
          handoverWorkerId: technologistId, // ili NULL za broadcast
          statusId: 0, // NaCekanju
          note: comment,
        },
      });
      handovers.push(handover);
    }
    
    // 3. Emit event
    this.eventEmitter.emit('handover.batch_created', {
      draftId,
      handovers,
      submittedBy: currentUserId,
      technologistId,
    });
    
    return { draft, handoversCreated: handovers.length };
  });
}
```

### 7.4 Notifikacije — koje, kada, kome

**Lista događaja koji emituju notifikacije:**

| Event | Recipient | Title | Message template |
|---|---|---|---|
| `handover.batch_created` (technologistId set) | Tehnolog | "Nova primopredaja za odobravanje" | "Primopredaja {handoverNumber} za predmet {projectName}: {drawingsCount} crteža" |
| `handover.batch_created` (broadcast) | Svi `defines_approval=true` | "Nova primopredaja čeka tehnologa" | "Primopredaja {handoverNumber} dostupna za preuzimanje" |
| `handover.approved` | Projektant koji je kreirao draft | "Primopredaja odobrena" | "Tehnolog {workerName} odobrio primopredaju {handoverNumber}" |
| `handover.rejected` | Projektant | "Primopredaja odbijena" | "Tehnolog {workerName} odbio primopredaju {handoverNumber}: {comment}" |
| `handover.launched` | Projektant + sve uključene strane | "RN lansiran" | "Lansiran radni nalog {woNumber} iz primopredaje {handoverNumber}" |

**Service za kreiranje notifikacija:**

```typescript
@Injectable()
export class NotificationService {
  @OnEvent('handover.batch_created')
  async onHandoverBatchCreated(event: HandoverBatchCreatedEvent) {
    const recipients = await this.getRecipients(event);
    
    for (const recipient of recipients) {
      await this.prisma.appNotification.create({
        data: {
          recipientUserId: recipient.userId,
          channel: 'in_app',
          type: 'handover_pending_approval',
          title: 'Nova primopredaja čeka odobravanje',
          message: this.formatMessage(event),
          entityType: 'drawing_handover',
          entityId: event.handovers[0].id,
          actionUrl: `/primopredaje/${event.handovers[0].id}`,
          metadata: { draftId: event.draftId, handoverCount: event.handovers.length },
        },
      });
    }
  }
  
  // ostali event listeneri...
}
```

### 7.5 Lansiranje — kreiranje WorkOrder-a

Detalji ove logike idu u `MODULE_SPEC_work_orders.md` (Sprint 5). Ovde samo high-level:

```typescript
@Injectable()
export class WorkOrderCreationService {
  @OnEvent('handover.launched')
  async onHandoverLaunched(event: HandoverLaunchedEvent) {
    const handover = await this.prisma.drawingHandover.findUnique({
      where: { id: event.handoverId },
      include: { drawing: true },
    });
    
    const draftItem = await this.prisma.handoverDraftItem.findFirst({
      where: { drawingId: handover.drawingId },
      include: { draft: { include: { project: true } } },
    });
    
    const workOrder = await this.prisma.workOrder.create({
      data: {
        drawingId: handover.drawingId,
        projectId: draftItem.draft.projectId,
        partnerId: draftItem.draft.project.customerId,
        quantity: draftItem.quantityToProduce,
        dueDate: event.dueDate,
        status: 'LAUNCHED',
        handoverId: handover.id, // back-reference
        launchedAt: new Date(),
        launchedById: event.launchedBy,
      },
    });
    
    // Emit work_order.created event za MRP, audit, itd.
    this.eventEmitter.emit('work_order.created', { workOrderId: workOrder.id });
    
    return workOrder;
  }
}
```

### 7.6 Što se desi sa duplikatima — workflow

Scenario: projektant A pravi nacrt za predmet X koji koristi šaraf 1133392. Tehnolog odobri, RN se lansira. **Onda** projektant B pravi nacrt za predmet Y koji takođe koristi isti šaraf 1133392.

Šta sistem radi:
1. Pri dodavanju stavke u nacrt B, pre-check duplikata detektuje da postoji aktivan RN za 1133392
2. `pre_check_duplicate = true`, `pre_check_work_order_id` = RN A
3. UI prikazuje žuto upozorenje: "Pažnja: ovaj crtež već ima aktivan RN #8856 za predmet X. Da li dodaješ ipak?"
4. Projektant B može da:
   - Klikne "Dodaj svejedno" — stavka se dodaje, kasnije se kreira novi RN za predmet Y (potpuno OK po pravilu 3)
   - Klikne "Otkaži" — stavka se ne dodaje

Posle lansiranja, postoje dva RN-a za isti crtež ali različite predmete:
- `WorkOrder` #8856: drawing=1133392, project=X, quantity=2
- `WorkOrder` #9012: drawing=1133392, project=Y, quantity=4

Proizvodnja zna razdvojiti jer su povezani sa različitim predmetima.

---

## 8. UI tokovi

### 8.1 Forma: Pregled nacrta (Drafts list)

**Layout:**

```
[Header]
  Crteži predati u primopredaju
  miljann (miljan.nikodijevic) | SERVOTEH

[Filters bar]:
  Kreirani nacrti u periodu  Od datuma [___] Do datuma [___]
  Crteže spremio za primopredaju [___]
  Za radni nalog [___]   Za crtež broj [___]
  Za nacrt broj [___]    Za status [Za Kreiranje ▼]
  
  [Detaljno nacrt primopredaje]  [Detaljno crtež]  [STOP]  [Potrebne komponente za crtež]

[Glavna tabela]:
  | Broj   | Datum    | Radni  | Broj    | Broj      | Revizija | Naziv     | Materijal | Dimenzije | Težina |
  | nacrta | nacrta   | nalog  | komada  | crteža    |          |           |           |           |        |
  | G-9611-1/3 | 06-10-25 | 0001 | 1 | 1122346 | A | Sklop F | Sklop | | 0 |
  | G-0001/3 | 06-10-25 | 0001 | 1 | 1121938 | A | Nadsklop F | Sklop | | 0 |
  | ...

[Action]:
  [+ Novi nacrt primopredaje]  [Briši izabrani]
```

### 8.2 Forma: Kreiraj primopredaju (Wizard)

**Pogled (PDF strana 5):**

```
[Header]
  Nacrt primopredaje | ID nacrta [2259] | [<<] [<] [>] [>>] | Pronađi nacrt primopredaje [___]
  SERVOTEH

[Top buttons]:
  [+ Novi nacrt primopredaje]  [Snimi]  [STOP]  [Kreiraj primopredaju]  [Definiši spone stavke]

[Naručilac projekta panel]:
  Broj radnog naloga [9611-1 ▼]    Tip nacrta [Glavni sklop ▼]    Projektant [Dejan Crković ▼]
  Naziv               [Termička linija ST-TO-14]                    Status nacrta [Za Kreiranje ▼]
  Kupac               [14. OKTOBAR d.o.o. Kruševac]                  Predao [_______]
                                                                       Potpisao [_______]
                       Broj crteža glavnog sklopa  [1089151 - B ▼]    Pretpregled vremena
                       Broj nacrta                  [G-9611-1/3]      24-04-26 12:18:14
                       Datum kreiranja              [24-04-26]
                       Broj komada                  [1]

[Stavke tabela]:
  | Broj    | Revizija | Naziv             | Količina      | Količina | Crtež kreira | Kreirana   | Isključi  | Vodeci sklop | Materijal | Dimenzije | Težina | Radni nalog |
  | crteža  |          |                   | definisana    | za izradu| u nacrtu    | primopredaja| primopredaja| primopredaja|           |           |        | u crtezu    |
  | 1089175 | B        | Držač cilindra D5 | 4             | 4         | □            | □          | □         | 1089151 - B  | Č0361     | Šipka 125 | 1     |             |
  | 1133484 | B        | Hauba - deo 04    | 1             | 1         | □            | □          | □         | 1089151 - B  | Č0361     | Šečenje 2mm| 1     |             |
  | ...

[Bottom buttons]:
  [+ Dodaj stavku]  [Briši stavku]  [Spreman za primopredaju]  [Predaj na primopredaju]
```

**Funkcionalnost:**

1. Projektant otvori novi prazan nacrt
2. Bira **predmet** iz dropdown-a (filter aktivnih projekata)
3. Bira **tip nacrta** (Glavni sklop / Pojedinačni sklop / Podsklopovi)
4. Bira **glavni crtež sklopa** — ako tip = Glavni sklop, auto-populate stavki iz BOM-a tog sklopa
5. Stavke tabela popunjena
6. Može da dodaje/uklanja stavke ručno
7. **"Spreman za primopredaju"** → status `ZaPrimopredaju`
8. **"Predaj na primopredaju"** → otvara dijalog "Izbor tehnologa" (8.3 ispod), pa onda Submit transakcija

**Auto-populate stavki iz glavnog sklopa:**

Kad projektant izabere `mainDrawingId` i `draftType=0` (Glavni sklop), sistem automatski BOM-expand glavnog sklopa i prebaci sve komponente kao `HandoverDraftItem`-e. Projektant može onda da ručno isključi pojedine.

### 8.3 Dialog: Izbor tehnologa

**Pogled (PDF strana 6):**

```
[Modal title]: frmIzborTehnologa  [X]

[List box]:
  Tehnolog kome se prosleđuje primopredaja
  ┌─────────────────────────────────────┐
  │ Aleksandar Stanić                    │
  │ Branislav Stanojević                 │
  │ Dijana Kastratović                   │
  │ Dragan Ristanić    ← currently selected
  │ Jovica Milosević                     │
  │ Ljubiša Simović                      │
  │ Nikodijevic Miljan                   │
  │ Stefan Daničić                       │
  │ Strahinja Petrović                   │
  └─────────────────────────────────────┘
  
  [Comment textarea]:
  [_______________________________________________]
  
  [Buttons]: [Odobri primopredaju]  [Odustani]
```

**Funkcionalnost:**

- Lista popunjena radnicima sa `defines_approval = true` AND `active = true`
- Korisnik bira ili može da ostavi prazno (broadcast svima)
- Comment je opcionalno (postaje `note` na primopredaji)
- Klik "Odobri primopredaju" → Submit transakcija (sekcija 6.3)

### 8.4 Forma: Odobravanje primopredaja (Tehnolog inbox)

**Pogled (PDF strana 6):**

```
[Header]
  Crteži predati na odobrenje
  miljann (miljan.nikodijevic) | SERVOTEH

[Filters]:
  Od datuma [___] Do datuma [___]
  Za nacrt broj [___]   Za predmet [___]   Za tehnologa [Dragan Ristanić ▼]
  Za status [U obradi ▼]   Broj nacrta primopredaje [___]
  
  [Detaljno crtež]  [STOP]  [PDF Crtež]  [Odobri primopredaju]  [Odbij primopredaju]

[Tabela]:
  | Broj    | Revizija | Broj    | Varij. | Datum    | Naziv                          | Količina | Materijal | Dimenzije | Težina | Komitent          | Broj nacrta  | Status   | Primopredaju kreirao |
  | crteža  |          | naloga  |        | nacrta   |                                |          |           |           |        |                   | primopredaje |          |                       |
  | 1133418 | B        | 9400/1/305 | 0  | 24-04-26 | Pregradni nosač creva na ro... | 1        | Zavareni  |           |3.185   | 14. OKTOBAR d.o.o. | G-9400/6/35  | U obradi | Luka Talović         |
  | ...
```

**Funkcionalnost:**

- Default filter: `status = NaCekanju` AND (`handover_worker_id = currentUser` OR `handover_worker_id IS NULL`)
- Klik na red → highlight + enable "Odobri" / "Odbij" dugmiće
- "Odobri primopredaju" → opcionalno comment input → poziv `POST /handovers/:id/approve`
- "Odbij primopredaju" → **OBAVEZAN** comment input → poziv `POST /handovers/:id/reject`

### 8.5 Forma: Odobrene primopredaje

**Pogled (PDF strana 6 — dno):**

```
[Header]
  Odobreni Crteži
  miljann (miljan.nikodijevic) | SERVOTEH

[Filters]:
  Evidencija predatih crteža u periodu [___] [___]
  Kreirao primopredaju [___]   Za (deo) broj crteža [___]   Za predmet [___]   Za tehnologa [___]   Za broj nacrta [Saglasan ▼]
  
  [Dokument primopredaje]  [Detaljno crtež]  [STOP]  [PDF Crtež]  [Lansiraj RN]  [Štampaj sve prikazane PDF crteže na izabrani štampač]

[Tabela]:
  | Broj    | Revizija | Broj   | Varij. | Datum    | Naziv             | Količina | Materijal | Dimenzije | Težina | Komitent          | Broj nacrta  | Status    | Primopredaju kreirao | Primopredaju odobrio | Datum odobravanja |
  | crteža  |          | naloga |        | naloga   |                   |          |           |           |        |                   | primopredaje |           |                       |                       |                   |
  | 1134765 | A        | 9400/1/266 | 1 | 21-04-26 | Kutija zavese 1500| 1        | Sklop     |Sklop      |8.57    | 14. OKTOBAR d.o.o.| G-9400/1/15  | Saglasan  | Marko Stojanović     | Nikodijevic Miljan    | 22-04-26          |
```

**Funkcionalnost:**

- Filter `status = Saglasan` (default)
- "Lansiraj RN" → otvara mali dialog (due date, comment) → poziv `POST /handovers/:id/launch`
- Posle uspešnog lansiranja, primopredaja prelazi u tab "Lansirane" automatski

### 8.6 Forma: Notifikacije (Frontend header)

**Header notification icon (uvek vidljiv, top-right):**

```
[🔔 5]  ← icon sa unread count badge
```

**Klik na icon → dropdown panel:**

```
[Notifikacije]                                    [Sve označi kao pročitano]
─────────────────────────────────────────────────────────────────────
🟢 Nova primopredaja čeka odobravanje
   Primopredaja G-9400/1/15 za predmet Termička linija
   pre 5 minuta
─────────────────────────────────────────────────────────────────────
🟢 Tehnolog odobrio primopredaju
   Nikodijevic Miljan odobrio primopredaju G-9400/1/14
   pre 2 sata
─────────────────────────────────────────────────────────────────────
⚪ Lansiran RN
   RN 9611-1/305 iz primopredaje G-9611-1/3
   pre 5 sati
─────────────────────────────────────────────────────────────────────
[Vidi sve notifikacije →]
```

Klik na notifikaciju → navigacija na `actionUrl` (deep-link u modul).

---

## 9. Test scenariji

### 9.1 Unit testovi

**Test 1: Generate draft number**
- Setup: nema nacrta danas
- Action: `generateDraftNumber()`
- Expect: `G-{yymmdd}-001`

**Test 2: Concurrent draft number generation**
- Setup: 2 paralelna poziva
- Action: `Promise.all([gen, gen])`
- Expect: 2 različita broja (`001` i `002`), nema duplikata

**Test 3: Pre-check duplicate detection**
- Setup: crtež 1133392 već u draft #5 (status `Predat`)
- Action: dodaj stavku 1133392 u draft #10
- Expect: stavka kreirana sa `preCheckDuplicate=true`, `preCheckDraftId=5`

**Test 4: Submit draft locks it**
- Setup: draft sa 10 stavki, status `ZaPrimopredaju`
- Action: `submitDraft(draftId, technologistId=7)`
- Expect: 10 DrawingHandover entry-ja kreirano, draft `isLocked=true`, 1 notifikacija poslata

**Test 5: Reject handover requires comment**
- Setup: primopredaja `NaCekanju`
- Action: `rejectHandover(id, comment=null)`
- Expect: 400 error "comment required"

**Test 6: Only defines_approval workers can approve**
- Setup: user sa `defines_approval=false`
- Action: `approveHandover(id)`
- Expect: 403 Forbidden

**Test 7: Launch creates WorkOrder**
- Setup: primopredaja `Saglasan`, draft sa project_id=X
- Action: `launchHandover(id, dueDate)`
- Expect: WorkOrder kreiran sa drawingId, projectId=X, partnerId=project.customerId

### 9.2 Integration testovi

**Test 8: End-to-end happy path**
- Projektant kreira draft → dodaje 5 stavki → predaje tehnologu T1 → T1 odobri sve 5 → T1 lansira 3 → ostala 2 ostaju Saglasan
- Expect: 5 DrawingHandover, 3 WorkOrder, 5 notifikacija ka projektantu

**Test 9: Rejection flow**
- Projektant kreira draft → predaje → T1 odbije sa comment-om
- Expect: DrawingHandover.status=Odbijen, comment sačuvan, notifikacija ka projektantu

**Test 10: Concurrent approval**
- 2 tehnologa istovremeno odobravaju istu primopredaju
- Expect: jedan uspe, drugi dobije 409 Conflict ("primopredaja je već u statusu Saglasan")

### 9.3 E2E testovi

**Test 11: Projektant kreira nacrt iz UI**
- Login (projektant) → /nacrti → klikni "Novi nacrt" → izaberi predmet, glavni crtež → auto-populate stavki → klikni "Predaj"
- Expect: dialog "Izbor tehnologa" otvori → izaberi tehnologa → potvrdi → success notification, redirect na /nacrti sa novim nacrtom u statusu "Predat"

**Test 12: Tehnolog vidi notifikaciju i odobri**
- Login (tehnolog) → notification badge prikazuje "1" → klikni → dropdown sa primopredajom → klik → /primopredaje/123 → klik "Odobri" → success

**Test 13: Lansiranje kreira RN**
- Tehnolog sa `defines_launch=true` → /primopredaje (filter Odobrene) → klikni red → klikni "Lansiraj RN" → unesi dueDate → potvrdi → success, WorkOrder ID prikazan

---

## 10. Cursor instrukcije za implementaciju

### 10.1 Sprint 4 — Backend

```
Implementacija Nacrti i Primopredaje modula za Servosync (Sprint 4 po ARCHITECTURE.md).

Kontekst:
- Pročitaj docs/ARCHITECTURE.md i docs/MODULE_SPEC_nacrti_primopredaje.md
- Prisma šema sadrži: HandoverDraft, HandoverDraftItem, DrawingHandover, DrawingHandoverPdf, HandoverStatus, HandoverDraftStatus, Worker
- NOVA TABELA za V1: AppNotification — dodaj kroz migration

Cilj Sprinta 4:
- Implementiraj 3 NestJS modula koji čine handover workflow:
  1. handover-drafts (Nacrti)
  2. handovers (Primopredaje + lansiranje)
  3. notifications (in-app push notifications)
- API endpoints prema sekciji 6 ove specifikacije
- Event-driven arhitektura preko NestJS @EventEmitterModule

Konkretno uradi:

1. Migracija za AppNotification tabelu:
   - Kreiraj prisma migration sa AppNotification modelom (sekcija 3.3)
   - Dodaj relaciju u User model (notifications: AppNotification[])
   - Indeksi: (recipient_user_id, read_at), (entity_type, entity_id)

2. Migracije za lookup data:
   - Seed handover_draft_statuses sa 6 stavki (sekcija 3.2)
   - Seed handover_statuses sa 5 stavki (sekcija 3.2)

3. Kreiraj NestJS module:
   - src/modules/handover-drafts/
     - handover-drafts.module.ts
     - handover-drafts.controller.ts
     - handover-drafts.service.ts
     - draft-number-generator.service.ts (sekcija 7.1)
     - duplicate-check.service.ts (sekcija 7.2)
     - dto/ folder
     - events/ folder (HandoverDraftCreatedEvent, HandoverDraftSubmittedEvent)
   - src/modules/handovers/
     - handovers.module.ts
     - handovers.controller.ts
     - handovers.service.ts
     - work-order-creation.listener.ts (listener za handover.launched event)
     - dto/ folder
     - events/ folder (HandoverApprovedEvent, HandoverRejectedEvent, HandoverLaunchedEvent)
   - src/modules/notifications/
     - notifications.module.ts
     - notifications.controller.ts
     - notifications.service.ts
     - notification.listener.ts (listener za sve handover events)
     - dto/ folder

4. Implementiraj sledeće endpoint-e (sekcija 6):

   Drafts:
   - GET /handover-drafts (sa filterima)
   - GET /handover-drafts/:id
   - POST /handover-drafts
   - PATCH /handover-drafts/:id (samo dok nije locked)
   - DELETE /handover-drafts/:id (soft delete)
   - GET /handover-drafts/:draftId/items
   - POST /handover-drafts/:draftId/items (sa pre-check duplikata)
   - PATCH /handover-draft-items/:id
   - DELETE /handover-draft-items/:id
   - POST /handover-drafts/:id/submit (kritični transakcijski endpoint)

   Handovers:
   - GET /handovers (sa filterima)
   - GET /handovers/:id
   - POST /handovers/:id/approve
   - POST /handovers/:id/reject
   - POST /handovers/:id/launch (kreira WorkOrder)
   - GET /handovers/pending-approval (tehnolog inbox)

   Notifications:
   - GET /notifications
   - PATCH /notifications/:id/read
   - PATCH /notifications/mark-all-read

   Helpers:
   - GET /workers/technologists (defines_approval=true filter)
   - GET /handover-draft-statuses
   - GET /handover-statuses

5. Poslovna pravila (sekcija 7):
   - Generate draft number sa concurrency protection (advisory lock)
   - Pre-check duplicate na svako dodavanje stavke
   - Submit transakcija atomarna (locks draft + creates handovers + emits event)
   - Approve/Reject sa proverom role-a i obaveznog comment-a
   - Launch kreira WorkOrder kroz event listener (cross-modul)

6. Event-driven arhitektura:
   - @EventEmitterModule.forRoot() u app.module
   - Events emit-uju se iz servisa
   - NotificationService je listener za sve events
   - WorkOrderCreationService je listener za handover.launched

7. Auth pravila:
   - Svi endpoint-i: @UseGuards(JwtAuthGuard)
   - POST /handovers/:id/approve, /reject: @Roles('defines_approval')
   - POST /handovers/:id/launch: @Roles('defines_launch')
   - POST /handover-drafts/:id/submit: only draft creator (designer_id = current user)

8. Validacija (class-validator):
   - CreateHandoverDraftDto, UpdateHandoverDraftDto
   - SubmitDraftDto sa optional technologistId
   - RejectHandoverDto sa REQUIRED comment
   - LaunchHandoverDto sa required dueDate

9. Notifikacije:
   - Channel = 'in_app' za V1
   - Type vrednosti: 'handover_pending_approval', 'handover_approved', 'handover_rejected', 'rn_launched'
   - actionUrl uvek deep-link u frontend rutu

10. Testovi (sekcija 9):
    - Unit testovi (7 testova iz 9.1)
    - Integration testovi (3 iz 9.2)
    - E2E testovi (3 iz 9.3)

11. Audit log:
    - Sve write operacije generišu AuditLog entry kroz interceptor
    - Action types: 'CREATE_DRAFT', 'SUBMIT_DRAFT', 'APPROVE_HANDOVER', 'REJECT_HANDOVER', 'LAUNCH_HANDOVER'

12. Cross-modul integration:
    - Implementiraj WorkOrderCreationService listener iako WorkOrders modul nije gotov
    - Za V1 placeholder: kreira WorkOrder zapis sa minimum poljima
    - Sprint 5 (WorkOrders modul) će proširiti logiku

Ne menjaj:
- PDM modul (Sprint 3)
- BigBit sync modul (Sprint 1)
- Auth modul (Sprint 0)

Posle implementacije:
- npm run test, all green
- Swagger UI prikazuje sve endpoint-e
- Otvori PR "feat(handover-workflow): implement Sprint 4 per MODULE_SPEC_nacrti_primopredaje.md"
```

### 10.2 Sprint 4 — Frontend

Glavne stranice (Next.js App Router):

- `src/app/nacrti/page.tsx` — Pregled nacrta
- `src/app/nacrti/[id]/page.tsx` — Detalj/edit nacrta
- `src/app/nacrti/novi/page.tsx` — Wizard za kreiranje
- `src/app/primopredaje/page.tsx` — Tehnologov inbox
- `src/app/primopredaje/[id]/page.tsx` — Detalj primopredaje sa Approve/Reject/Launch akcijama
- `src/app/primopredaje/odobrene/page.tsx`, `/odbijene`, `/lansirane`, `/sve` — filter views

Komponente:

- `<NotificationBadge />` — u header-u, polling svako 30s
- `<NotificationDropdown />` — panel sa listom unread
- `<DraftWizard />` — multi-step forma za kreiranje nacrta
- `<TechnologistSelectorDialog />` — Modal za izbor tehnologa
- `<ApproveRejectDialog />` — Modal za Approve/Reject sa comment polje
- `<LaunchRnDialog />` — Modal za lansiranje sa due date

Hooks (TanStack Query):

- `useDrafts`, `useDraft`, `useDraftItems`, `useSubmitDraft`
- `useHandovers`, `useHandover`, `useApproveHandover`, `useRejectHandover`, `useLaunchHandover`
- `useNotifications`, `useMarkAsRead`

---

## 11. Open questions / decisions

**Q1: Tačne vrednosti `draft_type` enum-a?**

Trenutno pretpostavljam:
- 0 = Glavni sklop (cela mašina)
- 1 = Pojedinačni sklop
- 2 = Podsklopovi (lista)

**Treba potvrditi sa Vasom precizno značenje pre Sprinta 4.**

**Q2: Seed data za handover_draft_statuses i handover_statuses**

Predložene vrednosti su pretpostavke. Treba potvrditi sa projektnim biroom u Servoteh-u tačne labele i redosled. Posebno:
- Da li postoji status "Storniran" za drafts? (kad projektant otkazuje)
- Da li tehnolog može da vrati primopredaju "u obradu" iz "Saglasan" (npr. otkriće da je nešto pogrešno)?

**Q3: Broadcast vs Targeted notifications**

Trenutno spec dozvoljava oba mode-a:
- Targeted (technologistId set) → notifikacija samo tom korisniku
- Broadcast (technologistId null) → notifikacija svim sa defines_approval=true

Pitanje: koji je default ponašanje u UI dijalogu "Izbor tehnologa"? Treba li uvek izbor ili može da se ostavi prazno?

**Preporuka:** UI uvek traži izbor (radio: "Konkretan tehnolog" ili "Svi tehnolozi"). Default = "Svi tehnolozi" (broadcast) za brzinu.

**Q4: Real-time push notifikacije ili polling?**

V1 = polling svako 30s. To je dovoljno za interno korišćenje (low latency requirement).

V2 = WebSocket ili Server-Sent Events za real-time push. Treba razmotriti.

**Q5: Šta sa primopredajama kojima je tehnolog napušten kompanju?**

Scenario: tehnolog T1 dobio primopredaju, status NaCekanju. Posle nekoliko dana, T1 napušta firmu (`workers.active = false`). Primopredaja stoji u inbox-u koji nema vlasnika.

**Predlog:** dnevni cron job "stale handovers check" — za sve primopredaje sa `status = NaCekanju` AND `handover_worker_id` od neaktivnog radnika → automatski revert na broadcast (set `handover_worker_id = NULL`) + notifikacija svima sa defines_approval=true.

V1 manualno (admin može ručno da ponovo dodeli). V2 automatski.

**Q6: Audit log granularnost**

Svako menjanje stavke nacrta — da li ide u audit log? Može da napravi puno entry-ja za jedan veliki nacrt sa 100 stavki.

**Predlog:** detaljnost audit log-a:
- ALWAYS: CREATE_DRAFT, SUBMIT_DRAFT, APPROVE/REJECT/LAUNCH_HANDOVER, DELETE_DRAFT
- ONLY ON STATUS CHANGE: UPDATE_DRAFT (samo kad se status_id menja, ne za svaku malu izmenu)
- NEVER: UPDATE_DRAFT_ITEM (suviše granularno, pravi noise)

**Q7: Šta ako tehnolog odobri ali pre lansiranja primopredaja se "zamrzne" (čeka materijal)?**

Da li postoji intermediate status između Saglasan i Lansiran? Trenutno spec ima `UObradi` koji se može koristiti, ali nije obavezan.

V1 preporuka: koristi `Saglasan` za sve do lansiranja, `UObradi` je opcionalan flag.

---

## 12. Reference

- `BB_Tehnologija_opis.pdf` — strane 5-7 (Nacrti, Primopredaje workflow); strana 8 (Lansiranje — koje IZBACUJEMO)
- `MODULE_SPEC_pdm.md` — PDM modul iz kojeg crteži dolaze u nacrte
- `legacy/QMegaTeh_Reference.md`:
  - Sekcija 8.5 (Primopredaje u VBA kodu)
  - VBA moduli: `Form_Primopredaja`, `Form_NacrtPrimopredaje`, `Form_PregledNacrtaPrimopredaje`, `Form_PregledStavkiPrimopredajaRN`
- `schema.prisma`:
  - HandoverDraft, HandoverDraftItem
  - DrawingHandover, DrawingHandoverPdf
  - HandoverStatus, HandoverDraftStatus
  - Worker (sa defines_approval, defines_launch flags)
  - User (za AppNotification)
- `schema-rename-map.md` — mapping legacy → Postgres
- Servoteh-specifična pitanja → Vasin Servoteh kontakt

---

## 13. Verzija

| Verzija | Datum | Šta se promenilo |
|---|---|---|
| 1.0 | maj 2026 | Inicijalna specifikacija — Nacrti + Primopredaje + Notifikacije workflow za V1 |

---

*Kraj MODULE_SPEC_nacrti_primopredaje.md*

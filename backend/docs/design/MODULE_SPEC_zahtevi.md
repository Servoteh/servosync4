# Module Spec: Zahtevi — AI Product Manager + Decision Log

| | |
|---|---|
| **Modul** | `zahtevi` — centralni sistem zahteva korisnika (bug / dorada / nova funkcija) sa AI trijažom, admin kontrolom, generisanjem „Claude paketa" i Decision Log-om |
| **Verzija spec** | 1.3 (2026-07-21) — Fable razrada; v1.1 nagrađivanje (§12); v1.2 presude §13; v1.3 korigovana tarifa (blaža skala) + kompletna lista ideja za AI duplikate + živa provera sličnih u formi |
| **Pozicija** | **Platformski modul** — NIJE BigBit/4.0 domen niti 1.0 seoba; novi native modul na glavnoj bazi (kao `sastanci`, `nabavka`). Može na `main` nezavisno od 4.0 talasa. |
| **Izvor zahteva** | Razgovor Nenad ↔ Fable 21.07.2026 (Owner Inbox → prošireno na sve korisnike; dva odvojena odobrenja; Decision Log). Papirna preteča: [docs/zahtevi/](../../../docs/zahtevi/) docx fajlovi. |
| **Status** | **PRESUĐEN 21.07.2026** (svih 12 pitanja, §13) — spreman za izvođenje F0→F5 |

> **Vizija (ne obavezuje V1):** modul je kandidat za izdvajanje u zaseban proizvod
> („AI-asistirano upravljanje razvojem"). Zato: sve tabele sa sopstvenim prefiksom,
> minimalna sprega (samo `users` + `AiProviderService` + storage gateway), nikakva
> logika drugih domena unutra.

---

## 0. Cilj i obim

**Problem danas:** zahtevi korisnika stižu usmeno, preko Viber-a, docx fajlova u
`docs/zahtevi/` i sastanaka. Nema statusa, nema istorije, nema veze zahtev → commit →
verzija. Odluke arhitekture žive samo u glavama i po CLAUDE.md/memorijama.

**Šta modul radi:**

1. **Podnošenje** — svaki ulogovani korisnik kreira zahtev: tekst, **diktat (STT)**,
   **slike/prilozi**, očekivano vs trenutno ponašanje.
2. **AI trijaža (automatska, kratka)** — klasifikacija (modul/tip/prioritet), provera
   duplikata, sažetak za admin inbox. Best-effort: pad AI-ja ne blokira podnošenje.
3. **Admin inbox** — Nenad vidi original + AI sažetak i odlučuje: odobri detaljnu
   analizu / vrati na dopunu / odbij / spoji / arhiviraj / prebaci u backlog.
4. **AI detaljna analiza (odobrenje #1)** — razumevanje, uticaj, rizici, konflikti,
   otvorena pitanja, acceptance kriterijumi, test scenariji.
5. **Odobrenje realizacije (odobrenje #2)** — TEK tada zahtev sme u implementaciju.
6. **Claude paket** — jednim klikom generisan kompletan prompt-dokument za Claude Code
   (kontekst + AC + ograničenja + testovi). **Modul NIKAD sam ne pokreće izmene koda.**
7. **Praćenje** — grana/PR/commit/verzija isporuke, status testiranja, ko je radio.
8. **Decision Log** — ADR-stil registar tehničkih i poslovnih odluka sa obrazloženjem.
9. **Nagrađivanje** — AI odmah oceni svaki predlog **0–5**; ocena 0 = automatsko
   odbacivanje, ocena ≥1 = prihvaćen u obradu i nosi novčani iznos po tarifi;
   mesečni obračun za isplatu najaktivnijima (§12).

**Van obima V1:** automatska GitHub integracija (auto-link PR-a — ručni unos u V1),
push/email notifikacije podnosiocima (V1 samo minimalno, §9), javni portal, SLA metrike.

---

## 1. Tok i status mašina

### 1.1 Podrazumevani tok (presuđen u razgovoru — „varijanta 2 sa kratkom trijažom")

```
Korisnik podnese zahtev
  → AI kratka trijaža AUTOMATSKI (klasifikacija + duplikati + sažetak; best-effort)
  → zahtev u admin inbox-u sa AI sažetkom
  → admin odlučuje: detaljna analiza? (odobrenje #1)
  → AI detaljna analiza → admin odlučuje: realizacija? (odobrenje #2)
  → PLANIRANO → U REALIZACIJI → SPREMNO ZA TEST → NA TESTIRANJU → ZAVRŠENO
```

**Doktrina dva odobrenja:** „Odobri AI analizu" i „Odobri realizaciju" su DVA odvojena
dugmeta, dva statusa, dva event-a. AI analiza nikad ne implicira realizaciju.

### 1.2 Statusi

Status je `String` na redu (BACKEND_RULES §2 — ne Prisma enum), dozvoljene vrednosti
u `///` komentaru. Mapiranje na nazive iz razgovora + StatusBadge ton (DESIGN_SYSTEM §7 —
dodati u kanonsku mapu u F0):

| Status (DB) | Naziv u UI | Iz razgovora | Ton |
|---|---|---|---|
| `DRAFT` | Nacrt | DRAFT | `neutral` |
| `SUBMITTED` | Podnet | PODNET / ČEKA ADMIN PREGLED | `warn` |
| `NEEDS_INFO` | Vraćen na dopunu | VRAĆENO NA DOPUNU | `warn` |
| `ANALYSIS_APPROVED` | Odobrena AI analiza | ODOBRENA AI OBRADA / ČEKA AI OBRADU | `info` |
| `ANALYZED` | AI obrađen — čeka odluku | AI OBRAĐENO / ČEKA ADMIN ODLUKU | `warn` |
| `APPROVED` | Odobren za realizaciju | ODOBRENO ZA REALIZACIJU | `success` |
| `PLANNED` | Planiran | PLANIRANO | `info` |
| `IN_PROGRESS` | U realizaciji | U REALIZACIJI | `info` |
| `READY_FOR_TEST` | Spreman za test | SPREMNO ZA TEST | `info` |
| `TESTING` | Na testiranju | NA TESTIRANJU | `warn` |
| `DONE` | Završen | ZAVRŠENO | `success` |
| `REJECTED` | Odbijen | ODBIJENO | `danger` |
| `MERGED` | Spojen sa drugim | (akcija „Spoji") | `neutral` |
| `DEFERRED` | Backlog / buduća verzija | (akcija „Prebaci u budућu verziju") | `neutral` |
| `ARCHIVED` | Arhiviran | ARHIVIRANO | `neutral` |

Napomene:
- „ČEKA AI OBRADU / AI OBRAĐENO" za **trijažu** nije poseban status reda — trijaža je
  best-effort pozadinski korak unutar `SUBMITTED` (rezultat = red u `change_request_ai_analyses`
  sa `kind=TRIAGE`). Za **detaljnu** analizu jeste: `ANALYSIS_APPROVED` (čeka/traje) → `ANALYZED`.
- `MERGED` nosi `mergedIntoId` (pokazivač na kanonski zahtev); spojeni zahtev je terminalan.
- `REJECTED` može nastati i **automatski** — trijažna ocena 0 (§12.1): event `AI_REJECTED`,
  podnosilac vidi obrazloženje, admin ima „Vrati u obradu" (restore).

### 1.3 Dozvoljeni prelazi (servis enforce-uje, obrazac `assertStatus` iz nabavke)

```
DRAFT            → SUBMITTED (submit, owner) | (obrisan — hard delete, samo owner, samo DRAFT)
SUBMITTED        → ANALYSIS_APPROVED | NEEDS_INFO | REJECTED | MERGED | DEFERRED | ARCHIVED | APPROVED*
NEEDS_INFO       → SUBMITTED (dopuna, owner) | ARCHIVED (admin) | (withdraw, owner → ARCHIVED)
ANALYSIS_APPROVED→ ANALYZED (AI završi) | SUBMITTED (AI pao — admin retry ili odluka bez analize)
ANALYZED         → APPROVED | REJECTED | NEEDS_INFO | MERGED | DEFERRED | ARCHIVED
APPROVED         → PLANNED | IN_PROGRESS
PLANNED          → IN_PROGRESS | DEFERRED
IN_PROGRESS      → READY_FOR_TEST
READY_FOR_TEST   → TESTING | DONE (admin preskoči test za trivijalno)
TESTING          → DONE | IN_PROGRESS (pao test — vraća se)
DEFERRED         → SUBMITTED (reaktivacija) | ARCHIVED
REJECTED         → SUBMITTED (restore — samo AI-odbačen ocenom 0, admin) | ARCHIVED
MERGED/DONE      → ARCHIVED
```

\* `SUBMITTED → APPROVED` direktno: admin sme da odobri realizaciju i bez detaljne
analize (trivijalni zahtevi) — event beleži da je analiza preskočena.

**Withdraw (povlačenje):** owner sme da povuče zahtev (`→ ARCHIVED`, event `WITHDRAWN`)
dok je u `DRAFT | SUBMITTED | NEEDS_INFO`. Posle odobrenja analize — samo admin.

**Nepromenjivost originala:** posle submit-a `title/description/expectedBehavior/currentBehavior`
su zaključani (owner sme PATCH samo u `DRAFT`). Dopune u `NEEDS_INFO` idu kao komentari —
original se NIKAD ne prepisuje. STT transkript na audio prilogu je immutable od nastanka.

---

## 2. Uloge i permisije

Katalog (F0 — prvo `backend/src/common/authz/permissions.ts`, pa FE mirror
`frontend/src/lib/permissions.ts`):

| Ključ | Semantika |
|---|---|
| `zahtevi.read` | pristup modulu; **row-scope u servisu**: korisnik vidi SAMO svoje zahteve |
| `zahtevi.write` | kreiranje/izmena/submit/withdraw SOPSTVENIH zahteva + prilozi + komentari na svojima |
| `zahtevi.admin` | sve: inbox svih zahteva, oba odobrenja, statusi realizacije, meta izmene (modul/prioritet/tip), spajanje, retriage |
| `zahtevi.decisions.read` | čitanje Decision Log-a |
| `zahtevi.decisions.write` | unos/izmena odluka |

Dodela u `role-permissions.ts`:
- `zahtevi.read` + `zahtevi.write` → **sve SSO uloge** (u `VIEWER_READ_BASELINE` ide samo
  `read`; `write` kroz post-merge `addPerms` sloj svim ulogama — svako sme da PODNESE zahtev).
- `zahtevi.admin` + `zahtevi.decisions.write` → samo `admin` (dobija kroz `ALL` automatski).
- `zahtevi.decisions.read` → `admin` + **`menadzment`** (presuda §13.2).
- Nova rola se NE uvodi (princip `roles.ts`: uloga ide uz modul samo kad zatreba).

Guard obrazac (identičan nabavci): `@UseGuards(JwtAuthGuard, PermissionsGuard)` +
klasni `@RequirePermission(PERMISSIONS.ZAHTEVI_READ)` + per-endpoint override.
Row-scope: servis SVAKI read/write filtrira `createdByUserId = req.user.userId` osim
kad pozivalac ima `zahtevi.admin` (proveru radi servis kroz prosleđen `AuthUser`).
Obavezan spec test `role-permissions.zahtevi.spec.ts` (obrazac postoji po modulu).

---

## 3. Model podataka (glavna baza — `backend/prisma/schema.prisma`)

Konvencije: modeli PascalCase singular, tabele snake_case plural, constraints
`pk_/fk_/uq_/idx_`, statusi String + `///`, meki ref na `users.id` (Int, bez
`@relation` ka users — kao `createdByUserId` obrazac u nabavci). Sve nove tabele,
nula legacy veza. Skica (Opus u F1 razrađuje do pune šeme):

```prisma
/// Zahtev korisnika (bug / dorada / nova funkcija) — AI PM modul.
model ChangeRequest {
  id                Int       @id @default(autoincrement())
  reqNo             String    @db.VarChar(12)  /// "023/26" — brojač po godini, advisory lock (obrazac purchase-numbering)
  title             String    @db.VarChar(200)
  description       String                     /// ORIGINAL podnosioca — immutable posle submit-a
  expectedBehavior  String?                    /// za bug: šta treba da se desi
  currentBehavior   String?                    /// za bug: šta se sada dešava
  kind              String?   @db.VarChar(20)  /// BUG | MISSING_1_0 | IMPROVEMENT_3_0 | FEATURE_4_0 | UI_UX | BUSINESS_RULE | OTHER
  module            String?   @db.VarChar(40)  /// slug modula iz nav kataloga (npr. "odrzavanje", "nabavka")
  areas             String[]                   /// DATABASE | BACKEND | FRONTEND | MOBILE — višestruko
  priorityUser      String?   @db.VarChar(10)  /// LOW | MEDIUM | HIGH | CRITICAL — mišljenje podnosioca
  priorityFinal     String?   @db.VarChar(10)  /// isti skup — postavlja admin (AI samo predlaže u analizi)
  aiScore           Int?                       /// trijažna ocena 0–5 (§12.1) — AI PREDLOG
  aiScoreReason     String?                    /// obrazloženje ocene (1–2 rečenice, prikazuje se podnosiocu)
  finalScore        Int?                       /// potvrđena/korigovana ocena — postavlja SAMO admin (§12.2)
  rewardAmount      Decimal?  @db.Decimal(10, 2) /// snapshot iznosa iz važeće tarife pri admin potvrdi ocene
  rewardStatus      String    @default("NONE") @db.VarChar(10) /// NONE | PROPOSED | CONFIRMED | PAID | EXCLUDED
  rewardMonth       String?   @db.VarChar(7)   /// "2026-08" — mesec obračuna (= mesec potvrde ocene)
  status            String    @default("DRAFT") @db.VarChar(20) /// §1.2
  createdByUserId   Int
  submittedAt       DateTime? @db.Timestamptz(6)
  decidedAt         DateTime? @db.Timestamptz(6)   /// vreme odobrenja/odbijanja realizacije
  decidedByUserId   Int?
  decisionNote      String?                    /// razlog odbijanja / napomena odluke
  mergedIntoId      Int?                       /// za MERGED — kanonski zahtev
  branchName        String?   @db.VarChar(120) /// praćenje realizacije (V1 ručni unos)
  prUrl             String?   @db.VarChar(300)
  commitSha         String?   @db.VarChar(64)
  deliveredVersion  String?   @db.VarChar(60)  /// npr. "main 2026-07-25" ili tag
  implementedBy     String?   @db.VarChar(120) /// "Opus agent / Nenad" — slobodan tekst
  createdAt         DateTime  @default(now()) @db.Timestamptz(6)
  updatedAt         DateTime  @updatedAt @db.Timestamptz(6)

  attachments ChangeRequestAttachment[]
  analyses    ChangeRequestAiAnalysis[]
  comments    ChangeRequestComment[]
  events      ChangeRequestEvent[]
  // uq: (reqNo) po godini — partial/composite u SQL migraciji; idx: status, createdByUserId, module
  @@map("change_requests")
}

/// Prilog zahteva — slika, audio diktat ili dokument. Fajl u sy15 storage-u, meta-red je izvor istine.
model ChangeRequestAttachment {
  id            Int      @id @default(autoincrement())
  requestId     Int
  kind          String   @db.VarChar(10)   /// IMAGE | AUDIO | FILE
  bucket        String   @db.VarChar(60)   /// "zahtevi-prilozi"
  storagePath   String   @db.VarChar(300)  /// "req/<requestId>/<uuid>.<ext>"
  originalName  String   @db.VarChar(200)
  contentType   String   @db.VarChar(80)
  sizeBytes     Int
  transcript    String?                    /// AUDIO: STT transkript — IMMUTABLE od nastanka
  transcriptModel String? @db.VarChar(60)  /// npr. "gpt-4o-transcribe"
  createdByUserId Int
  createdAt     DateTime @default(now()) @db.Timestamptz(6)
  deletedAt     DateTime? @db.Timestamptz(6)  /// soft-delete (fajl best-effort remove)
  request ChangeRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  @@map("change_request_attachments")
}

/// Jedan AI prolaz nad zahtevom. Više redova = istorija (retriage, ponovljena analiza).
model ChangeRequestAiAnalysis {
  id          Int      @id @default(autoincrement())
  requestId   Int
  kind        String   @db.VarChar(10)  /// TRIAGE | DETAILED
  status      String   @default("PENDING") @db.VarChar(10) /// PENDING | DONE | FAILED
  model       String?  @db.VarChar(60)
  result      Json?    /// struktura §4.1 / §4.2 (izlaz extractWithTool alata)
  claudePackage String?                 /// DETAILED: generisan markdown paket §4.3 (admin sme da doradi)
  errorCode   String?  @db.VarChar(40)  /// FAILED: upstream_error | not_configured | ...
  tokensIn    Int?
  tokensOut   Int?
  startedByUserId Int?                  /// null = automatska trijaža na submit
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  finishedAt  DateTime? @db.Timestamptz(6)
  request ChangeRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  @@map("change_request_ai_analyses")
}

/// Komentar/pitanje/odgovor na zahtevu (admin ↔ podnosilac). Dopune u NEEDS_INFO idu ovuda.
model ChangeRequestComment {
  id          Int      @id @default(autoincrement())
  requestId   Int
  authorUserId Int
  body        String
  isQuestion  Boolean  @default(false)  /// true = pitanje prosleđeno podnosiocu (može poteći iz AI analize)
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  request ChangeRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  @@map("change_request_comments")
}

/// Insert-only timeline zahteva (ko/šta/kad) — obrazac maint_wo_events.
model ChangeRequestEvent {
  id          Int      @id @default(autoincrement())
  requestId   Int
  type        String   @db.VarChar(30)  /// CREATED|SUBMITTED|TRIAGED|TRIAGE_FAILED|ANALYSIS_APPROVED|ANALYZED|ANALYSIS_FAILED|COMMENT|NEEDS_INFO|RESUBMITTED|APPROVED|REJECTED|MERGED|DEFERRED|WITHDRAWN|STATUS_CHANGED|LINK_ADDED|META_CHANGED
  actorUserId Int?     /// null = sistem/AI
  data        Json?    /// npr. {from,to} za STATUS_CHANGED, {field,old,new} za META_CHANGED
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  request ChangeRequest @relation(fields: [requestId], references: [id], onDelete: Cascade)
  @@map("change_request_events")
}

/// Decision Log — ADR-stil registar odluka (tehničkih i poslovnih), §6.
model DecisionLogEntry {
  id            Int      @id @default(autoincrement())
  title         String   @db.VarChar(200)
  decision      String                   /// ŠTA je odlučeno
  context       String?                  /// ZAŠTO — okolnosti, alternative
  consequences  String?                  /// posledice / šta ovo menja
  tags          String[]                 /// slobodni tagovi: "storage", "authz", "deploy"...
  relatedRequestId Int?                  /// meki ref na change_requests.id
  status        String   @default("ACTIVE") @db.VarChar(12) /// ACTIVE | SUPERSEDED
  supersededById Int?                    /// meki ref na noviju odluku
  decidedOn     DateTime @db.Date        /// datum odluke (ne createdAt — odluke se unose i retroaktivno)
  createdByUserId Int
  createdAt     DateTime @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime @updatedAt @db.Timestamptz(6)
  @@map("decision_log_entries")
}

/// Tarifa nagrada: ocena → iznos (§12.2). Promena = NOV red sa validFrom; istorija se čuva.
model ChangeRequestRewardTariff {
  id              Int      @id @default(autoincrement())
  score           Int                          /// 1–5 (ocena 0 nema iznos)
  amount          Decimal  @db.Decimal(10, 2)
  currency        String   @default("RSD") @db.VarChar(3)
  validFrom       DateTime @db.Date
  createdByUserId Int
  createdAt       DateTime @default(now()) @db.Timestamptz(6)
  // uq: (score, validFrom)
  @@map("change_request_reward_tariffs")
}
```

Globalni `AuditInterceptor` (audit_log) hvata sve mutacione rute besplatno; domenski
timeline je `change_request_events` (bogatiji, insert-only, prikazuje se u UI).

---

## 4. AI cevovod

Sav AI ide kroz postojeći `AiProviderService` (`backend/src/common/ai/ai-provider.service.ts`) —
jedini izlaz ka LLM-ovima; boot-safe (bez ključa → analiza `FAILED not_configured`,
modul normalno radi bez AI). Strukturisan izlaz preko `extractWithTool`
(`tool_choice` forsiran — obrazac montaža-izveštaja): nema parsiranja slobodnog teksta.

### 4.1 Trijaža (`kind=TRIAGE`) — automatska na submit

- **Okidač:** `POST /zahtevi/:id/submit` upiše red analize `PENDING` i pokrene
  fire-and-forget promise (try/catch → `DONE`/`FAILED`); submit odgovara ODMAH.
  Nema queue infrastrukture i ne uvodi se — isto kao mail u nabavci (nikad ne obara radnju).
- **Model:** jeftin — env `ZAHTEVI_TRIAGE_MODEL` (default `claude-haiku-4-5-20251001`;
  fallback logika kao u engineConfig — bez Anthropic ključa koristi OpenAI mini).
- **Ulaz:** naslov + opis + expected/current + transkripti audio priloga + slike
  (base64, kroz resize ≤1568px — vision blokovi kao u `extractWithTool` pozivima) +
  **kandidati za duplikate — KOMPLETNA lista postojećih ideja** (presuda §13.13):
  svi zahtevi (id, reqNo, naslov, jednoredni sažetak, status) sem davno arhiviranih;
  naslovi su jeftini po tokenima. Tek preko ~500 zahteva uvesti pre-filter sličnošću.
- **Izlazna šema (tool input):**
  ```json
  {
    "summary": "sažetak 2-3 rečenice za admin inbox",
    "module": "slug ili null",
    "kind": "BUG | ... | OTHER",
    "areas": ["BACKEND", "FRONTEND"],
    "priorityProposal": "LOW|MEDIUM|HIGH|CRITICAL",
    "duplicates": [{ "requestId": 12, "confidence": "HIGH|MEDIUM", "reason": "..." }],
    "score": 3,
    "scoreReason": "obrazloženje ocene u 1-2 rečenice (prikazuje se podnosiocu)",
    "questions": ["nejasnoća 1", "..."]
  }
  ```
- AI predlozi `module/kind/priority` se upisuju u red zahteva SAMO ako su polja prazna
  (podnosiočev izbor se ne pregazi); admin uvek može da preinači (event `META_CHANGED`).
- `score` se upisuje u `aiScore` + `rewardStatus=PROPOSED` (za ≥1); **ocena 0 →
  automatski `REJECTED`** (event `AI_REJECTED`) — rubrika i pravila u §12.1.
  Trijaža bez ocene (AI pad) → admin ocenjuje ručno.
- Pad trijaže: event `TRIAGE_FAILED`, zahtev ostaje `SUBMITTED`, admin ima dugme
  „Ponovi trijažu" (`POST /:id/retriage`).

### 4.2 Detaljna analiza (`kind=DETAILED`) — odobrenje #1, samo admin

- **Okidač:** `POST /zahtevi/:id/approve-analysis` → status `ANALYSIS_APPROVED`,
  red analize `PENDING`, fire-and-forget; front polluje detalj (redovni GET) dok
  ne bude `DONE` (→ status `ANALYZED`) ili `FAILED` (→ vraća se `SUBMITTED` + event).
- **Model:** jak — env `ZAHTEVI_ANALYSIS_MODEL` (default `claude-sonnet-5`).
- **Ulaz:** sve iz trijaže + svi komentari/odgovori + trijažni rezultat + **kontekst
  sistema**: kratak statični opis ServoSync arhitekture i modula (održava se kao
  konstanta/fajl u modulu — `zahtevi-ai-context.ts`; NE čita ceo repo).
- **Izlazna šema:**
  ```json
  {
    "understanding": "šta korisnik zapravo traži, svojim rečima",
    "affectedModules": ["nabavka", "gl"],
    "impact": "procena uticaja (obim izmena, ko je pogođen)",
    "risks": ["rizik 1"],
    "conflicts": ["moguć sukob sa postojećom funkcijom X"],
    "openQuestions": ["pitanje za podnosioca/admina"],
    "acceptanceCriteria": ["AC1", "AC2"],
    "testScenarios": ["scenario 1"],
    "estimate": "S | M | L | XL",
    "priorityProposal": "LOW|MEDIUM|HIGH|CRITICAL"
  }
  ```
- `openQuestions` admin može jednim klikom da prosledi podnosiocu → komentari
  `isQuestion=true` + status `NEEDS_INFO`.

### 4.3 Claude paket

Generiše se IZ detaljne analize (deo istog AI poziva — polje `claudePackage`,
markdown), čuva na redu analize; admin sme da ga doradi (PATCH) pre kopiranja.
UI: „📋 Kopiraj Claude paket" + „⬇ Preuzmi .md". Šablon (AI ga popunjava):

```markdown
# Zahtev Z-<reqNo>: <naslov>
## Kontekst
<modul, poslovni kontekst, veza sa postojećim funkcijama>
## Zahtev
<original korisnika (citat) + AI strukturisano razumevanje>
## Acceptance kriterijumi
- [ ] ...
## Ograničenja
- Pročitaj i poštuj CLAUDE.md + backend/docs/BACKEND_RULES.md repoa.
- NE menjaj ponašanje postojećih modula van navedenog obima.
- Migracije kroz `npm run migrate:dev`; boot-smoke pre push-a; post-deploy verify.
## Test scenariji
1. ...
## Definicija gotovog
Testovi prolaze, lint čist, spec ažuriran, zahtev Z-<reqNo> → SPREMNO ZA TEST.
```

**Tvrdo pravilo:** paket je artefakt za ručno prenošenje u Claude Code. Modul nema
nikakav mehanizam izvršavanja koda niti pristup repou.

### 4.4 Troškovi i otpornost

- Trijaža auto, ali jeftin model + ulaz sečen (opis ≤8k karaktera, ≤5 slika).
- Detaljna analiza SAMO na klik admina (odobrenje #1 je ujedno i troškovna brana).
- `tokensIn/Out` + `model` na svakom redu analize → vidljiva potrošnja.
- Svaki AI pad je zabeležen (`FAILED` + `errorCode` + event) i NIKAD ne obara
  poslovni tok (doktrina iz mail/notifikacija).

---

## 5. Prilozi: slike i audio diktati

**Storage:** postojeći `Sy15StorageService` (service-key proxy; pravo se proverava PRE
poziva) — novi **private bucket `zahtevi-prilozi`**, putanje `req/<requestId>/<uuid>.<ext>`.
Meta-red (`change_request_attachments`) je izvor istine; brisanje = soft-delete +
best-effort `remove`. Čitanje kroz `signUrl` (3600 s).

**Upload endpoint:** `POST /zahtevi/:id/attachments` — `FilesInterceptor("files", 10)`,
hard cap 25 MB/fajl (obrazac media-ai). Servis validira: mime allowlist
(`image/jpeg|png|webp|heic`, `audio/webm|mp4|mpeg|ogg|wav`, `application/pdf`),
audio ≤15 MB (STT pravilo 1.0), ukupno ≤10 priloga po zahtevu, prazan/<200 B → 400.
Dozvoljeno owner-u u `DRAFT|SUBMITTED|NEEDS_INFO`, adminu uvek.

**Audio diktat — dva režima (oba u V1):**

1. **Diktat u polje** (već postoji): `DictateButton` iz
   `frontend/src/components/voice-controls.tsx` → `/v1/ai/stt` → tekst u
   opis/naslov. Audio se NE čuva. + `RefineButton` (✨ dotera tekst) — original
   pre doterivanja ostaje u `description` tek posle submit-a nepromenjiv, pa je
   doterivanje dozvoljeno samo u DRAFT fazi.
2. **Glasovna poruka kao prilog** (novo): snimi (MediaRecorder, obrazac iz
   `voice-controls.tsx`) → upload kao `kind=AUDIO` prilog → server ODMAH po
   uploadu pozove `AiProviderService.transcribe` i upiše `transcript` na meta-red
   (best-effort; pad = transcript null + dugme „Transkribuj ponovo").
   **Original audio + transkript se čuvaju trajno** — zahtev iz razgovora.

**Slike:** `<input type="file" accept="image/*" capture="environment" multiple>`
(native kamera na telefonu — kanonski obrazac `prijava-kvara-dialog.tsx`), klijentski
resize preko `frontend/src/lib/image-resize.ts` pre upload-a (štedi prenos; original
preko 25 MB se odbija).

**Nove ui-kit komponente (F2, po pravilu DESIGN_SYSTEM §10 — u kit + `/dev/ui` katalog):**
- `attachment-input.tsx` — dashed dropzone + kamera + lista pending fajlova
  (generalizacija ponovljenog obrasca iz odrzavanje/kvalitet/kadrovska).
- `audio-recorder.tsx` — snimi/stop/preview + trajanje; emituje `Blob`.

---

## 6. Decision Log

Zaseban tab u modulu (`/zahtevi` → tab „Odluke"), nezavisan životni ciklus od zahteva.

- **Unos:** naslov, odluka (ŠTA), kontekst (ZAŠTO — alternative, okolnosti),
  posledice, tagovi, datum odluke (retroaktivan unos dozvoljen), opciona veza na zahtev.
- **Supersede umesto edit:** suštinska promena odluke = nova odluka +
  `status=SUPERSEDED` / `supersededById` na staroj (istorija se ne gubi). Sitne
  ispravke teksta su dozvoljene (PATCH, audit hvata).
- **Poreklo:** ručno; + prečica sa zahteva — uz `REJECTED`/`APPROVED` odluku admin
  može čekirati „Zabeleži u Decision Log" (prefil naslova/konteksta iz zahteva).
- **Vidljivost:** `zahtevi.decisions.read` = admin + menadzment (presuda §13.2);
  upis samo admin. Šire otvaranje kasnije = samo dodela permisije, bez izmene koda.
- **Budući AI hook (van V1):** Decision Log kao kontekst za detaljnu analizu
  (relevantne odluke po tagovima/modulu u prompt) — zabeleženo, ne implementira se.

---

## 7. REST API (`/api/v1/zahtevi`, envelope `{ data, meta }` / `{ error: { code } }`)

| Metod + ruta | Permisija | Napomena |
|---|---|---|
| `GET /zahtevi` | `read` | lista; ne-admin vidi SAMO svoje; filteri: `status,module,kind,q,page,pageSize` (parsePagination); admin dodatno `createdBy` |
| `GET /zahtevi/inbox-meta` | `admin` | brojači za inbox: po statusima koji čekaju admina (`SUBMITTED`, `ANALYZED`, `TESTING`) |
| `GET /zahtevi/slicni?q=` | `write` | BEZ AI — brza pretraga naslova/opisa (pg_trgm ili ILIKE) postojećih zahteva; zove je forma novog zahteva (debounce) da korisnik PRE podnošenja vidi „ovo možda već postoji" |
| `POST /zahtevi` | `write` | kreira `DRAFT` (ili uz `submit:true` odmah podnosi); `clientEventId` idempotencija (FE obrazac) |
| `GET /zahtevi/:id` | `read` | detalj + prilozi + analize + komentari + events; row-scope |
| `PATCH /zahtevi/:id` | `write`/`admin` | owner: sadržaj samo u `DRAFT`; admin: meta (`module,kind,priorityFinal`) bilo kad → event `META_CHANGED` |
| `DELETE /zahtevi/:id` | `write` | hard delete SAMO owner + SAMO `DRAFT` |
| `POST /zahtevi/:id/submit` | `write` | `DRAFT→SUBMITTED` (+ iz `NEEDS_INFO` re-submit); okida trijažu §4.1 |
| `POST /zahtevi/:id/withdraw` | `write` | §1.3 |
| `POST /zahtevi/:id/attachments` | `write` | multipart §5; AUDIO → auto STT |
| `GET /zahtevi/:id/attachments/:attId/url` | `read` | signed URL |
| `DELETE /zahtevi/:id/attachments/:attId` | `write` | soft-delete (owner u DRAFT/SUBMITTED/NEEDS_INFO; admin uvek) |
| `POST /zahtevi/:id/attachments/:attId/transcribe` | `write` | retry STT ako je pao |
| `POST /zahtevi/:id/comments` | `write` | owner + admin (admin i `isQuestion:true`) |
| `POST /zahtevi/:id/retriage` | `admin` | ponovi trijažu |
| `POST /zahtevi/:id/approve-analysis` | `admin` | odobrenje #1 → §4.2 |
| `PATCH /zahtevi/:id/analyses/:analysisId` | `admin` | dorada `claudePackage` |
| `POST /zahtevi/:id/decision` | `admin` | telo: `{ action: "approve"|"reject"|"needs-info"|"merge"|"defer"|"archive", note?, mergeIntoId?, logDecision? }` — odobrenje #2 i ostale presude |
| `POST /zahtevi/:id/status` | `admin` | realizacioni prelazi (`planned/in-progress/ready-for-test/testing/done`) + link polja (`branchName,prUrl,commitSha,deliveredVersion,implementedBy`) |
| `POST /zahtevi/:id/score` | `admin` | potvrdi/koriguj ocenu (0–5); 0 → `REJECTED`; ≥1 → snapshot iznosa iz tarife, `rewardStatus=CONFIRMED`, `rewardMonth` |
| `POST /zahtevi/:id/restore` | `admin` | vrati AI-odbačen (ocena 0) u `SUBMITTED` |
| `GET/PUT /zahtevi/nagrade/tarife` | `admin` | tarifa ocena→iznos (izmena = nov red sa `validFrom`) |
| `GET /zahtevi/nagrade/obracun?month=YYYY-MM` | `admin` | mesečni obračun: po korisniku broj predloga po ocenama + suma + stavke (`CONFIRMED`) |
| `POST /zahtevi/nagrade/obracun/:month/zakljuci` | `admin` | zaključi mesec: `CONFIRMED → PAID` (stavke zaključane) |
| `GET/POST /zahtevi/odluke`, `PATCH /zahtevi/odluke/:id` | `decisions.read`/`.write` | Decision Log; `POST /zahtevi/odluke/:id/supersede` |

DTO: obrazac repoa — `interface` + ručna `validate*()` sa srpskim porukama
(class-validator još nije uveden, BACKEND_RULES §6). Poslovne greške: ugrađeni
NestJS exception-i (404/409/422) kao u nabavci.

---

## 8. Frontend

**Rute (obrazac Nabavke — lista + `[id]`):**

- `/zahtevi` — `page.tsx`: za sve — „Moji zahtevi" (DataTable: reqNo, naslov,
  modul, tip, StatusBadge, **ocena** ★, **iznos**, datum) + kartica „Moje nagrade
  ovog meseca" (suma); za admina — `Tabs`: **Inbox** (čeka pregled/odluku,
  brojači iz `inbox-meta`; red prikazuje AI ocenu sa jednim-klikom potvrde),
  **Svi zahtevi** (filteri), **Nagrade** (tarifa + mesečni obračun + „Zaključi
  mesec"), **Odluke** (Decision Log), **Arhiva**. Dugme „+ Novi zahtev" uvek vidljivo.
- `/zahtevi/novi` — forma: naslov*, opis* (textarea + `DictateButton` + `RefineButton`),
  tip (select, opciono — „AI će predložiti"), modul (select iz nav kataloga, opciono),
  prioritet po mišljenju podnosioca, očekivano/trenutno ponašanje (prikazano kad je
  tip BUG ili prazno), prilozi (`attachment-input` + `audio-recorder`). „Sačuvaj nacrt"
  / „Podnesi" (Ctrl+S). Zod poruke srpski. **Slični zahtevi uživo (§13.13):** dok
  korisnik kuca naslov (debounce ~400 ms), panel „Ovo možda već postoji" prikazuje
  pogotke `GET /zahtevi/slicni` sa linkovima — PRE podnošenja, bez AI troška.
  Posle podnošenja detalj polluje trijažu, pa podnosilac u roku od par sekundi
  vidi i AI presudu (duplikat → obaveštenje sa linkom na original + auto-reject).
- `/zahtevi/[id]` — detalj: header (reqNo + naslov + StatusBadge + meta čipovi),
  admin action-bar uslovljen statusom (§1.3); tabovi:
  1. **Zahtev** — original (immutable prikaz), prilozi (slike lightbox; audio
     `<audio controls>` preko signed URL + transkript ispod),
  2. **AI analiza** — trijažni sažetak + duplikati (linkovi) + detaljna analiza
     (kartice: razumevanje/uticaj/rizici/konflikti/AC/testovi/procena) + potrošnja
     tokena + „Kopiraj/Preuzmi Claude paket" + admin edit paketa; `PENDING` →
     spinner sa refetch intervalom (TanStack `refetchInterval` dok ne završi),
  3. **Pitanja** — komentari; admin: „Prosledi pitanja podnosiocu" (iz `openQuestions`),
  4. **Istorija** — events timeline; realizaciona polja (grana/PR/verzija) sa edit za admina.
- **Navigacija:** registracija u `frontend/src/lib/navigation.ts` — domen „Sistem"
  (ili po §13.5), `requires: 'zahtevi.read'`, ikonica `Inbox`/`Lightbulb` (lucide).
- **API sloj:** `frontend/src/api/zahtevi.ts` — TanStack hookovi, `apiFetch`/`apiUpload`,
  invalidacija `['zahtevi']`, `clientEventId` na create (postojeći obrazac).
- **Statusi:** dodati vrstu u DESIGN_SYSTEM §7 mapu (F0), lokalni `statusMeta()`
  switch (obrazac `nabavka/page.tsx`).
- **Responsivno je obavezno** (§11: 360–1440 px) — forma novog zahteva mora biti
  potpuno upotrebljiva sa telefona (kamera + diktat su primarni mobilni scenario).
  Namenska `/m/zahtevi` ruta NIJE u V1 (§13.6).

---

## 9. Notifikacije (V1 minimalno)

- **Adminu:** bez push-a — inbox brojači na `/zahtevi` + badge u sidebaru (opciono
  F5). Postojeći `notifications` modul je **worker-scoped** (`recipientWorkerId`) —
  ne odgovara; user-scoped varijanta je zaseban posao, NE radi se usput.
- **Podnosiocu:** e-mail preko postojećeg `MailService` (Resend, DRY-RUN bez ključa,
  nikad ne obara radnju) na: odluku (approve/reject/needs-info) i `DONE`.
  Env flag `ZAHTEVI_MAIL_NOTIFY` — **default `true`** (presuda §13.4: uključeno odmah;
  bez Resend ključa automatski DRY-RUN).
- Sve ostalo (in-app zvonce za usere, Telegram…) → budući zahtev kroz sam modul 🙂.

---

## 10. Tvrde doktrine modula (Opus agenti — NE odstupati)

1. **AI nikad ne menja stanje zahteva odlučujuće** — samo popunjava predloge i
   analize; svaki prelaz statusa čini čovek. TAČNO DVA izuzetka: `ANALYSIS_APPROVED →
   ANALYZED` po završetku analize koju je čovek odobrio, i auto-`REJECTED` na
   trijažnu ocenu 0 (§12.1, Nenadova presuda 21.07 — uz obavezan admin restore ventil).
   **Novac AI nikad ne dodeljuje** — svaka nagrada nastaje tek admin potvrdom ocene (§12.2).
2. **Dva odobrenja su odvojena** (§1.1) — nikakva prečica „odobri i analizu i
   realizaciju jednim klikom" osim eksplicitnog `SUBMITTED→APPROVED` (koji preskače
   analizu, ne spaja odobrenja).
3. **Original je svetinja** — opis, transkripti i prilozi podnosioca se ne menjaju
   i ne brišu posle submit-a (soft-delete priloga ostavlja meta-red).
4. **AI pad ≠ pad modula** — svaki AI/STT/mail poziv u try/catch, boot-safe bez
   ključeva, modul potpuno funkcionalan bez ijednog AI poziva.
5. **Modul ne izvršava kod** — Claude paket je tekst za ručno prenošenje.
6. **Row-scope u servisu** — ne-admin NIKAD ne vidi tuđ zahtev (ni kroz detalj, ni
   kroz listu, ni kroz signed URL priloga tuđeg zahteva).
7. Sve opšte: BACKEND_RULES.md (String statusi, envelope, migracije, engleski kod /
   srpski docs, nova env promenljiva → `.env.example`, **nova zavisnost → samo uz
   izričito odobrenje** — za ovaj modul NIJEDNA nova zavisnost nije predviđena).

---

## 11. Fazni plan za izvođenje (Opus agenti)

Svaka faza = zaokružen, deploy-abilan komad; jedan Opus prolaz po fazi sa ovim spec-om
+ sekcijom faze. Posle svake faze: `npm test` (backend), lint, **boot-smoke**
(`node dist/main` — memorija incidenta 19.07), a posle deploy-a obavezno
`ssh ubuntusrv 'bash -s' < backend/scripts/post-deploy-verify.sh` (🟢 EXIT 0).

### F0 — priprema (mali, ručni ili mini-agent)
- `permissions.ts` (BE) + `permissions.ts` (FE mirror): 5 ključeva §2.
- `role-permissions.ts`: baseline read svim + `addPerms` write svim; spec test.
- DESIGN_SYSTEM §7: vrsta „Zahtevi" sa tonovima §1.2.
- Storage: kreirati bucket `zahtevi-prilozi` (private) na sy15 storage-u.
- **AC:** testovi authz prolaze; bucket postoji; ništa vidljivo korisnicima.

### F1 — backend jezgro (bez AI)
- Prisma modeli §3 + migracija (uq `reqNo` po godini u SQL-u; indeksi; **seed
  početne tarife nagrada** §13.8).
- `zahtevi.module/controller/service` + DTO validacije; numeracija (advisory lock,
  obrazac `purchase-numbering.service.ts`).
- Status mašina §1.3 (`assertStatus`), row-scope, events, komentari.
- Prilozi §5: upload/sign/soft-delete + STT na AUDIO (transcribe u try/catch).
- `GET /zahtevi/slicni` — brza pretraga sličnih (pg_trgm indeks nad naslov+opis
  ili ILIKE; BEZ AI) za živu proveru u formi (§13.13).
- Registracija u `app.module.ts`.
- **AC:** ceo tok DRAFT→SUBMITTED→(admin decision path)→DONE izvodljiv kroz API;
  ne-admin ne može da pročita tuđ zahtev (403/404); upload slike i audio sa
  transkriptom radi; events kompletan. **Testovi:** service spec (status mašina,
  row-scope, prelazi), role-permissions spec, attachment validacije.

### F2 — frontend jezgro
- `frontend/src/api/zahtevi.ts`; rute §8 (`/zahtevi`, `/zahtevi/novi`, `/zahtevi/[id]`);
  nav registracija; `statusMeta`.
- Nove kit komponente `attachment-input` + `audio-recorder` (+ `/dev/ui` katalog).
- Diktat u polje (`DictateButton`) + glasovna poruka kao prilog.
- Admin action-bar + inbox tabovi + brojači.
- **AC:** korisnik sa telefona (browser, 360 px) podnese zahtev sa slikom iz kamere
  i glasovnom porukom < 2 min; admin sprovede sve odluke iz UI; e2e smoke
  (`e2e/`): submit → admin approve → status DONE.

### F3 — AI trijaža + detaljna analiza + Claude paket
- `zahtevi-ai.service.ts` (poseban servis u modulu, koristi `AiProviderService`):
  trijaža §4.1 (fire-and-forget na submit + retriage), detaljna §4.2, paket §4.3.
- Ocena 0–5 u trijaži (§12.1): rubrika u promptu, auto-reject na 0 + restore,
  `PROPOSED` reward status; admin potvrda ocene (`POST /:id/score`).
- Env: `ZAHTEVI_TRIAGE_MODEL`, `ZAHTEVI_ANALYSIS_MODEL` → `.env.example`.
- FE: AI tab §8 (trijaža u inbox redu, detaljna kartica, paket copy/download/edit,
  „Prosledi pitanja"); ocena ★ u listi/detalju + jedan-klik potvrda u inboxu.
- **AC:** submit bez ijednog AI ključa radi (analiza FAILED not_configured, tok
  netaknut); trijaža klasifikuje i nađe očigledan duplikat (test sa 2 slična
  zahteva → duplikat dobija ocenu 0 i auto-reject); detaljna analiza vraća sve
  sekcije šeme; paket sadrži AC + ograničenja; tokeni zabeleženi; restore vraća
  AI-odbačen zahtev u SUBMITTED. **Testovi:** ai service spec sa mock provider-om
  (DONE/FAILED putevi, ne-pregazivanje korisničkih polja, ocena 0/≥1 grane).

### F4 — Decision Log + nagrade + praćenje + mail
- Decision Log BE+FE §6 (tab „Odluke", supersede tok, prečica sa odluke zahteva).
- Nagrade §12.2: tarifa CRUD (nov red po važenju), mesečni obračun + „Zaključi
  mesec" (`PAID`), kartica „Moje nagrade" za korisnika, `EXCLUDED` akcija.
- Realizaciona polja + `POST /:id/status` UI (link grana/PR/verzija).
- Mail podnosiocu §9 (flag, DRY-RUN test).
- **AC:** odluka se unese/supersede-uje; sa REJECTED zahteva nastane log zapis;
  admin upiše PR link i verziju; mail DRY-RUN loguje sadržaj; obračun za mesec
  daje tačne sume po korisniku (test: 3 korisnika, mešane ocene, jedan EXCLUDED),
  zaključen mesec je immutable (potvrda ocene posle zaključenja ide u naredni).

### F5 — glancanje (po potrebi, posle prvih živih zahteva)
- Sidebar badge brojač za admina; merge duplikata UX (prikaz na kanonskom);
  filteri/pretraga po sadržaju; opciono `/m/zahtevi`; opciono embedding duplikata;
  **rang lista** (top predlagači po mesecu — poeni/ocene, BEZ iznosa, §13.9).

**Redosled i paralelizam:** F0→F1→F2 sekvencijalno; F3 i F4 mogu paralelno posle F2
(različiti fajlovi). Svaki agent dobija: ovaj spec + BACKEND_RULES.md + CLAUDE.md +
konkretnu fazu; zabranjeno mu je da dira druge module.

---

## 12. Nagrađivanje predloga (AI ocena 0–5 + mesečni obračun)

**Cilj (Nenad, 21.07.2026):** finansijski motivisati najaktivnije — ideje koje se
prihvate i ispravke nose novac, obračunat na kraju meseca.

### 12.1 Ocena

Trijaža (§4.1) uz klasifikaciju vraća i **ocenu 0–5** sa obrazloženjem.
**POOŠTRENA rubrika (presuda Nenad 24.07.2026 — v1.3 rubrika zamenjena):** većina
prijava treba da padne u 1–2★; ocene 3+ su RETKE; 5★ isključivo revolucionarne
ideje. Tarifa je NEPROMENJENA — štednja se postiže strožim ocenjivanjem. Rubrika
(ide u trijažni prompt, doslovno — `zahtevi-ai.ts SCORE_RUBRIC`):

| Ocena | Značenje |
|---|---|
| **0** | Neupotrebljiv: spam, nerazumljiv, već postoji u sistemu, ili **duplikat** (ocenu zadržava PRVI podnosilac) |
| **1** | Kozmetika, sitna ispravka, mala operativna molba, dorada koja pomaže uglavnom podnosiocu |
| **2** | Korisna manja dorada ili validan bag ograničenog dometa — **podrazumevana ocena za dobre, obične predloge** |
| **3** | RETKO: značajno poboljšanje sa jasnim efektom na rad VIŠE ljudi/tima, ili bag koji iskrivljuje evidenciju (sati/količine/novac) |
| **4** | VRLO RETKO: menja tok posla odeljenja, ili bag koji pravi direktnu štetu/trošak |
| **5** | IZUZETAK: revolucionarna ideja — novi tok rada, velika merljiva ušteda/prihod (u dilemi 4 vs 5 → 4) |

- **Ocena 0 → zahtev se AUTOMATSKI odbacuje** (`REJECTED`, event `AI_REJECTED`;
  podnosilac vidi obrazloženje). Ovo je jedina AI izmena statusa u modulu (izuzetak
  doktrine §10.1 — Nenadova presuda). Sigurnosni ventil: admin „Vrati u obradu"
  (`POST /:id/restore`) + AI-odbačeni imaju svoj filter u admin inboxu (uvid da AI
  ne baca dobre predloge).
- **Ocena ≥1 = predlog prihvaćen u obradu** i kandidat za nagradu. Tumačenje:
  „prihvaćen" = ušao u tok; NE znači odobrenu realizaciju (dva odobrenja iz §1.1 ostaju).
- AI pad / bez ocene → admin ocenjuje ručno (`POST /:id/score` radi i bez AI ocene).

### 12.2 Novac

- **Tarifa** ocena→iznos: `change_request_reward_tariffs` (§3), admin UI u tabu
  „Nagrade". Promena iznosa = NOV red sa `validFrom` — istorija se čuva, stari
  obračuni ostaju tačni. **Početna tarifa (presuda §13.8, seed u F1 migraciji):**
  1 → 500, 2 → 1.000, 3 → 1.500, 4 → 2.000, 5 → 3.000 RSD.
- AI ocena je samo **predlog** (`rewardStatus=PROPOSED`). **Novac nastaje TEK admin
  potvrdom** (`POST /:id/score` — potvrdi ili koriguj, jedan klik u inbox redu).
  Pri potvrdi: snapshot iznosa iz važeće tarife → `rewardAmount`,
  `rewardStatus=CONFIRMED`, `rewardMonth` = mesec potvrde.
- **Mesečni obračun:** tab „Nagrade" → izveštaj po korisniku (broj predloga po
  ocenama + ukupan iznos + stavke) za izabrani mesec; „Zaključi mesec" →
  `CONFIRMED → PAID`, stavke immutable (potvrda posle zaključenja ide u naredni
  mesec). **V1 = izveštaj za ručnu isplatu** — veza sa kadrovskom/payroll je §13.10
  (Zarade su pod tvrdom bravom — ne dira se bez posebne odluke).
- **Vidljivost:** korisnik vidi SVOJE ocene, obrazloženja i iznose („Moji zahtevi"
  + kartica mesečne sume); tuđe iznose vidi samo admin. Rang lista (poeni, bez
  iznosa) — F5 (§13.9).

### 12.3 Zaštita od zloupotrebe („farmanje" predloga)

1. **Duplikat = 0** — prvi podnosilac zadržava ocenu; kasniji dobija auto-reject sa
   linkom na original.
2. **Svaki dinar prolazi kroz admin potvrdu** — AI ne dodeljuje novac (doktrina §10.1).
3. Admin akcija **`EXCLUDED`** — predlog validan ali bez nagrade (npr. proistekao iz
   redovnog radnog zadatka; pravilo §13.11).
4. Mesečni cap: presuda §13.11 — **BEZ capa** (ne gradi se u V1; admin potvrda
   svake nagrade je dovoljna brana).
5. Tarifa, potvrde i zaključivanja su pod globalnim auditom + events timeline-om.

---

## 13. Presude (Nenad, 21.07.2026 — sva pitanja ZATVORENA)

Presuđeno interaktivno 21.07.2026 (Fable ↔ Nenad). Presude su ugrađene u sekcije
gore; ovde je registar radi referenci (§13.N).

1. **Vidljivost tuđih zahteva** → SAMO ADMIN vidi sve; korisnici samo svoje.
   Menadzment uvid kasnije po potrebi (samo dodela permisije, bez koda).
2. **Decision Log čitanje** → ADMIN + MENADZMENT (`zahtevi.decisions.read`);
   upis samo admin.
3. **AI modeli** → Haiku 4.5 trijaža / Sonnet 5 detaljna analiza (env promenljive,
   promena bez koda).
4. **Mail podnosiocu** → UKLJUČEN ODMAH (`ZAHTEVI_MAIL_NOTIFY` default `true`;
   bez Resend ključa automatski DRY-RUN).
5. **Navigacija** → domen „Sistem".
6. **`/m/zahtevi`** → NE u V1; responsive desktop forma (360 px) je obavezna i dovoljna.
7. **Test statusi** → OBA ostaju (`READY_FOR_TEST` i `TESTING`).
8. **Početna tarifa** → 1 → 500 / 2 → 1.000 / 3 → 1.500 / 4 → 2.000 / 5 → 3.000 RSD
   (Nenad korigovao istog dana na blažu skalu; seed u F1 migraciji; kasnije
   izmene kroz UI, nov red po važenju).
9. **Rang lista** → DA — javna po mesecu, poeni/ocene BEZ iznosa (F5).
10. **Isplata** → V1 SAMO IZVEŠTAJ za ručnu isplatu („Zaključi mesec");
    payroll/kadrovska integracija eventualno kasnije kao zaseban posao
    (salary-brava se NE dira).
11. **Cap + EXCLUDED** → BEZ mesečnog capa (mehanizam se ne gradi); `EXCLUDED`
    ostaje diskreciona admin alatka (npr. predlog proistekao iz redovnog radnog
    zadatka) — bez tvrdog pravila.
12. **Osnov nagrade** → OCENA + ADMIN POTVRDA, ne čeka se realizacija; loši
    predlozi dobijaju 0/`EXCLUDED`.
13. **Provera duplikata** (dopuna istog dana) → AI u trijaži dobija KOMPLETNU
    listu postojećih ideja (ne uzorak) da odmah kaže da isto/slično već postoji;
    + živa provera sličnih u formi PRE podnošenja (`GET /zahtevi/slicni`, bez AI).

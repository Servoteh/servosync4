# Module Spec: Neusaglašenosti na montaži

| | |
|---|---|
| **Izvor** | Zahtev **004/26** (Zoran Jaraković, ocena 4★ potvrđena) — prijava SVAKE neusaglašenosti u montaži (odstupanje od crteža, deo ne može da se ugradi, loše zavarivanje, farbanje…) jer se danas sanira na licu mesta i informacija se NE vrati tehnologiji/proizvodnji/kontroli |
| **Presude** | Nenad 23.07.2026: **zaseban 2.0-native modul** (ne proširenje Kvaliteta — statusi/polja se sudaraju; ne sy15) · obaveštenje = **rola `menadzment`** (in-app + mail) · prijavljuju **svi sa pristupom Montaži** · UI = **tab u Montaži + kartica u /m/montaza** (mobilna kamera) |
| **Istraživanje** | Izveštaj 23.07 (Explore): kvalitet `NonconformityReport` gap-analiza, montaža sy15 svet, reuse mapa — ključne putanje na dnu ovog dokumenta |
| **Status** | PRESUĐEN — Opus izvodi (grana `feat/montaza-neusaglasenosti`) |

## 1. Model (glavna baza, `backend/prisma/schema.prisma`)

Konvencije repoa (BACKEND_RULES: PascalCase model / snake_case plural tabela, String statusi sa `///`,
meki ref na users/workers, `pk_/fk_/uq_/idx_`, Timestamptz(6)).

```prisma
/// Neusaglašenost na montaži (zahtev 004/26) — prijava sa terena/hale + istraga.
model MontageNonconformity {
  id            Int      @id @default(autoincrement())
  reportNumber  String   @db.VarChar(12)   /// "NM-NNN/YY" — brojač po godini (advisory lock obrazac, namespace 'montaza:nm')
  projectNumber String?  @db.VarChar(20)   /// broj predmeta (obavezan u prijavi; lookup kroz postojeći montaza/lookups/predmeti)
  projectId     Int?                       /// meki ref projects.id kad je razrešiv
  description   String                     /// opis problema (obavezan)
  severity      String   @db.VarChar(10)   /// MALA | SREDNJA | VISOKA (obavezan)
  locationKind  String   @db.VarChar(10)   /// SERVOTEH | TEREN (obavezan)
  locationNote  String?  @db.VarChar(200)  /// za TEREN: koja lokacija
  drawingNumber String?  @db.VarChar(60)   /// opciono
  workOrderCode String?  @db.VarChar(40)   /// opciono (RN broj — string, meki)
  status        String   @default("CEKA_ANALIZU") @db.VarChar(15) /// CEKA_ANALIZU | U_TOKU | ZAVRSENO
  reportedByUserId Int
  // Istraga (popunjava se u U_TOKU/ZAVRSENO):
  responsibleDepartment String? @db.VarChar(60)  /// odgovorno odeljenje (slobodan tekst uz predloge)
  responsibleWorkerId   Int?                     /// izvršilac (meki ref workers.id, opciono)
  investigationReport   String?                  /// nalaz istrage
  preventiveMeasures    String?                  /// preventivne mere
  investigatedByUserId  Int?
  closedAt      DateTime? @db.Timestamptz(6)
  createdAt     DateTime @default(now()) @db.Timestamptz(6)
  updatedAt     DateTime @updatedAt @db.Timestamptz(6)
  photos MontageNonconformityPhoto[]
  events MontageNonconformityEvent[]
  // uq reportNumber; idx: status, severity, projectNumber, createdAt
  @@map("montage_nonconformities")
}

/// Foto prijave — bytea obrazac IDENTIČAN kvalitet.QualityDocument (magic-byte validacija, 25MB).
model MontageNonconformityPhoto {
  id        Int      @id @default(autoincrement())
  nonconformityId Int
  fileName  String   @db.VarChar(200)
  contentType String @db.VarChar(80)
  content   Bytes
  createdByUserId Int
  createdAt DateTime @default(now()) @db.Timestamptz(6)
  nonconformity MontageNonconformity @relation(fields: [nonconformityId], references: [id], onDelete: Cascade)
  @@map("montage_nonconformity_photos")
}

/// Insert-only timeline (obrazac ChangeRequestEvent iz zahtevi modula).
model MontageNonconformityEvent {
  id        Int      @id @default(autoincrement())
  nonconformityId Int
  type      String   @db.VarChar(30) /// CREATED | STATUS_CHANGED | INVESTIGATION_UPDATED | PHOTO_ADDED | NOTE
  actorUserId Int?
  data      Json?
  createdAt DateTime @default(now()) @db.Timestamptz(6)
  nonconformity MontageNonconformity @relation(fields: [nonconformityId], references: [id], onDelete: Cascade)
  @@map("montage_nonconformity_events")
}
```

Migracija: ručno pisana po obrascu postojećih — **OBAVEZNO izvršiti na privremenoj bazi
(psql -f) pre push-a** (lekcija 22.07; agent piše tačan SQL u izveštaj ako nema DB pristup).

## 2. Permisije i tok

- Novi ključevi: `montaza.neusaglasenosti.read` (ceo montaža krug — dodeliti SVIM rolama koje
  imaju `montaza.read`), `montaza.neusaglasenosti.write` (prijava + dodavanje fotki: isti krug),
  `montaza.neusaglasenosti.manage` (istraga, promena statusa: admin, menadzment, pm, leadpm,
  tim_lider). BE katalog + FE mirror + `role-permissions.<modul>.spec.ts` test.
- **Statusi:** `CEKA_ANALIZU → U_TOKU → ZAVRSENO` (manage; `U_TOKU → CEKA_ANALIZU` dozvoljen povratak;
  ZAVRSENO je terminalan — bez brisanja). Prijava je immutable posle kreiranja (izmene = istraga polja).
- **Obaveštenje (COO = rola `menadzment`):** na SVAKU novu prijavu → (1) in-app zvonce:
  `NotificationsService.notifyWorkers` + novi helper `resolveManagementWorkerIds` (users sa rolom
  menadzment ∧ workerId — obrazac `resolveTechnologistWorkerIds`); (2) mail (Resend) svim
  menadzment korisnicima sa email-om — obrazac `zahtevi-mail.service.ts`, env `MONTAZA_NM_MAIL_NOTIFY`
  default true, try/catch, NIKAD ne obara prijavu. Na ZAVRSENO → mail podnosiocu prijave.

## 3. REST API (`/api/v1/montaza/neusaglasenosti`, envelope `{data,meta}`)

| Ruta | Perm | Napomena |
|---|---|---|
| `GET /` | read | lista + filteri: `status, severity, q` (opis/predmet/RN/odeljenje), `from/to`, paginacija |
| `POST /` | write | prijava: projectNumber*, description*, severity*, locationKind* (+locationNote za TEREN), drawing/RN opciono; event CREATED; notifikacije |
| `GET /:id` | read | detalj + fotke meta + events |
| `POST /:id/photos` | write | FilesInterceptor ≤6×8MB, magic-byte validacija (obrazac kvalitet `uploadDocument`); podnosilac ili manage |
| `GET /:id/photos/:photoId` | read | bytea serve (Content-Type iz reda) |
| `PATCH /:id/istraga` | manage | responsibleDepartment/responsibleWorkerId/investigationReport/preventiveMeasures + event |
| `POST /:id/status` | manage | prelazi §2 + event; ZAVRSENO → mail podnosiocu |

Brojevi: `NM-NNN/YY` — advisory lock dvo-argumentni `pg_advisory_xact_lock(hashtext('montaza:nm'), godina::int)`
(**`::int` cast — lekcija 22.07!**), numerički MAX u JS.

## 4. Frontend

- **Desktop:** novi tab „Neusaglašenosti" u modulu Montaža (`frontend/src/app/montaza/`) —
  lista (DataTable: broj, predmet, ozbiljnost čip — MALA=info/SREDNJA=warn/VISOKA=danger,
  status čip po §7 mapi, datum, podnosilac) + filteri + detalj (dijalog ili sekcija po obrascu
  modula): prijava (immutable) + fotke (lightbox) + istraga forma (manage) + timeline.
  Dugme „+ Prijavi neusaglašenost" → dijalog **fork `prijava-kvara-dialog.tsx` obrasca**
  (opis, ozbiljnost, lokacija, predmet picker — postojeći `predmet-picker.tsx`/lookup,
  crtež/RN, `AttachmentInput` sa kamerom).
- **Mobilni:** kartica „Prijavi neusaglašenost" u `/m/montaza` (postojeći hub) → isti dijalog
  (responsive 360px; kamera `capture="environment"` primarni tok).
- DESIGN_SYSTEM §7: dodati vrstu (statusi + ozbiljnost tonovi) PRE koda. Status čipovi:
  CEKA_ANALIZU=warn, U_TOKU=info, ZAVRSENO=success.
- API sloj `frontend/src/api/montaza-neusaglasenosti.ts` (TanStack obrazac).

## 5. Van obima V1 (svesno)
Povezivanje sa kvalitet arhivom (read-only tab u Kvalitetu — kasnije po potrebi), izveštaji/agregati,
AI analiza prijave, eskalacije po roku, izmena prijave posle kreiranja.

## 6. Verifikacija i doktrine
Bez novih zavisnosti. Svaki `$queryRaw/$executeRaw` i migracija se izvršavaju na stvarnom
Postgres-u pre push-a (throwaway baza). Notifikacije/mail nikad ne obaraju prijavu. Testovi:
servis (statusi, numeracija, istraga guard, foto validacija), role spec, mail/notif mock.
Backend `npm test`+build+boot-smoke; FE `tsc`+`next build` — sve zeleno. NE push-ovati.

## Reuse putanje (iz istraživanja 23.07)
`backend/src/modules/kvalitet/kvalitet.service.ts` (uploadDocument — magic bytes/bytea; numeracija),
`backend/src/modules/zahtevi/` (events timeline, mail servis obrazac, status mašina guard),
`backend/src/modules/notifications/notifications.service.ts` + `backend/src/common/workers/technologist-criteria.ts`
(obrazac za novi management resolver), `frontend/src/components/ui-kit/attachment-input.tsx`,
`frontend/src/app/odrzavanje/_components/prijava-kvara-dialog.tsx` (skelet dijaloga),
`frontend/src/app/montaza/_components/predmet-picker.tsx` + `GET montaza/lookups/predmeti`.

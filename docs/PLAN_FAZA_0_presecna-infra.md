# FAZA 0 — Presečna infra (implementacioni dizajn, build-ready)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Dizajn verifikovan
> nad STVARNIM 2.0/3.0 kodom (workflow, 4 agenta). Radi se PRVO — diže i postojeći 3.0.
> **Ništa nije primenjeno** — ovo je spreman-za-gradnju plan (šema/migracije/servisi/koraci).

## Zašto prvo
Presečni slojevi (audit/lock/undo, carry-over, UX, Resend) grade se JEDNOM pa svaki modul (i 3.0 i 4.0)
dobija ih „besplatno". Većina je buildable ODMAH na postojećem kodu → rani merljiv rezultat na 3.0.

---

## Komponenta A — Audit + Lock + Undo (nadogradnja, ne greenfield)

### Trenutno stanje (verifikovano)
- **Audit postoji, nezreo:** `common/audit/audit.interceptor.ts` (globalni `APP_INTERCEPTOR`, app.module.ts:95)
  hvata POST/PUT/PATCH/DELETE, piše **samo `afterData`** (orezano telo, 8KB); **`beforeData` se NIKAD ne
  puni**; `entityType/Id` grubo iz URL-a; upis fire-and-forget **van transakcije**. `AuditLog` model
  (schema:1965) nema `changedFields` ni `requestId`.
- **Identitet:** `jwt.strategy.ts` → `req.user = {userId, email, role, workerId}`.
- **Prisma:** `prisma.service.ts` golo `extends PrismaClient`, **nema `$extends` nigde**; @prisma/client
  **6.19.3** → client extensions pun obim. **Nema CLS/AsyncLocalStorage** (nova zavisnost = odobrenje —
  koristimo Node ugrađeni `AsyncLocalStorage`, BEZ nove zavisnosti).
- **Lock ad-hoc (4 obrasca):** `isLocked` na 6 modela; handovers state-machine (status 0/1/2/3 + isLocked),
  work-orders `assertEditable`, TP `isProcessFinished`, kvalitet status-int. **Nema deljenog
  `status`/`lockedById`/`lockReason` mixina.** `permissions.ts` nema `*.lock/*.post`; `AUTHZ_ENFORCE`=shadow.
- **Soft-delete:** 0 pojava `deletedAt` u core (brisanje fizičko); obrazac postoji u sy15 (1.0), ne u 2.0 core.

### Dizajn — DVA SLOJA (oba ostaju)
- **(a) HTTP AuditInterceptor = safety-net** (ruta/akter/IP/coarse action; hvata i ono što zaobiđe Prisma —
  raw SQL, sync). Nadograđuje se (tip fix + `requestId`), ne briše.
- **(b) Prisma client extension = field-level `before→after` diff** na DB write-putu. Vežu se preko
  zajedničkog `requestId` iz CLS-a.

1. **CLS actor-context** (`common/audit/actor-context.ts`): Node `AsyncLocalStorage<{userId,workerId,requestId}>`
   + interceptor `als.enterWith(...)` registrovan **PRE** AuditInterceptor-a. Extension čita store → **sam
   stampuje** `updatedById/deletedById` + audit actor (nemoguće „zaboraviti ko").
2. **Audit extension** (`common/audit/audit.extension.ts`): `Prisma.defineExtension` `query.$allModels.$allOperations`
   — na update/delete u ISTOJ tx učita staro (`beforeData`), posle (`afterData`), izračuna **`changedFields`**
   (samo izmenjena polja), upiše 1 `audit_log` red. Kači se preko **novog provider tokena `PRISMA_EXTENDED`**;
   Faza 0 migrira **4 vruća modula** (handovers/work-orders/kvalitet/pdm), 3.0 read-moduli ostaju na baznom
   PrismaService (kompilira odmah — **ništa se ne lomi**).
3. **Soft-delete + UNDO:** migracija dodaje `deleted_at/deleted_by_id` (+ `created_by_id/updated_by_id` gde
   fale). Extension `delete`→`update{deletedAt}`. Filter obrisanih **eksplicitno** (`notDeleted()` helper),
   NE globalni override (rizičan — odloži). UNDO: `POST /:resource/:id/restore` (auditovano) + FE „Poništi"
   toast. `GET /audit?entityType&entityId` timeline. Hard-delete samo `*.delete.force`.
4. **Lifecycle mixin (temelj):** migracija dodaje deljene kolone `status` (String, /// draft/posted/locked —
   ne enum, §2), `posted_at/by_id`, `locked_at/by_id`, `lock_reason`, **`version Int`** (optimistic). Helper
   `common/lifecycle/lockable.ts` (`assertNotLocked`). `isLocked` OSTAJE u Fazi 0; nova polja se pune paralelno.
   Permisije `*.lock/*.unlock/*.post` = samo deklaracija (guard i dalje shadow — **NE flipovati AUTHZ_ENFORCE**).

### Migracije (ručni SQL, obrazac postoji)
`audit_changed_fields` (audit_log += changed_fields jsonb, request_id) · `soft_delete_core` (deleted_at/
deleted_by_id/created_by_id/updated_by_id + parcijalni indeks `WHERE deleted_at IS NULL`) · `lifecycle_columns`
(status/posted/locked/version).

### Odluke (rešene, preporuka)
- **CLS bez nove zavisnosti** → Node `AsyncLocalStorage` (ne `nestjs-cls`) — poštuje pravilo 10. ✅ mi-tehnicki.
- **Oba sloja (interceptor + extension), ne zamena** — interceptor hvata ne-Prisma efekte. ✅ mi-tehnicki.
- **Eksplicitni soft-delete filter (ne globalni)** u Fazi 0 — bezbednije od global override-a. ✅ mi-tehnicki.
- **Ne flipovati AUTHZ_ENFORCE** u Fazi 0 — permisije deklarisati, enforce u kasnijoj fazi. ✅ (potvrditi Kapija 0).

**Procena A:** ~5–8 AI-dana.

---

## Komponenta B — DocumentCarryOverService (dizajn sad, primena Faza 5)

### Stanje
`GoodsDocumentItem` (schema:1121) VEĆ ima **`copiedFromItemId`** (=IDPrepisaneStavke) + `postedFromProformaToInvoice`;
`GoodsDocument` ima `level`, `linkedInvoiceDocId`. **Ali nema app modula** (samo sync-cache). 4.0 dokument-modeli
još ne postoje → ovo je **dizajn servisa + šema kolona**, primena kad dokumenti postoje (Faza 5).

### Dizajn
Deklarativna konfiguracija po paru (registar): `{sourceType, targetType, fieldMap, pricePolicy:
keep|recalcPricebook|recalcRabatKasa, qtyPolicy: full|deliveredOnly|remaining, dedupKey}`. Traceback:
**`sourceDocId`+`sourceItemId` (pozitivan FK)** umesto negacije; `NOT EXISTS` guard umesto „doktor" upita
(doc 27). Servis `DocumentCarryOverService.carry(pairKey, sourceId, targetId, selectedItemIds)` → INSERT sa
mapiranjem + traceback + event u audit. **Sad:** definiši interfejs + dodaj `source_doc_id/source_item_id`
kolone (uz `copiedFromItemId` koji ostaje kompat), + unit test skelet.

**Odluka:** pozitivan FK (`sourceItemId`) umesto BigBit negacije — uniformno, testabilno. ✅ mi-tehnicki.
**Procena B:** ~1–2 dana (dizajn+šema sad); ~4–6 dana primena u Fazi 5.

---

## Komponenta C — UX standard (grid-toolbar, štampa-varijante, dupli-klik)

### Stanje
Frontend ima `components/ui-kit` (dialog.tsx i dr.); tabele se grade **ad-hoc po modulu** (`_components`);
štampa preko `apiBlob` (`/print` endpointi). Nema zajedničkog DataTable sa toolbar-om.

### Dizajn
- **Reusable `<DataToolbar>`** (nad postojećim tabelama, opt-in props): filter po vrednosti/bez, sort, export
  XLS, „Pošalji mail". Ne prepravlja sve tabele — kači se gde treba.
- **`<PrintAs>` dropdown** („Štampaj kao…": sa/bez cena, kopija/original, INO, N kopija) nad postojećom
  `apiBlob`/PDF infra — parametrizuje `/print?variant=`.
- **Dupli-klik hook/util** (`useGridConventions`): dvoklik na filter=obriši, na red=drill-through, na
  header=toggle kolone.
- **Lock-uslovni UI**: helper koji sivi dugmad kad `row.status===locked`.

**Odluka:** proširiti postojeći UI-kit (ne uvoditi tešku grid biblioteku — nova zavisnost, pravilo 10). ✅ mi-tehnicki.
**Procena C:** ~5–7 dana (komponente + reuse). Diže i 3.0 odmah.

---

## Komponenta D — Resend attachments + auto-mail dokumenata + prevod za carinu

### Stanje
`common/mail/mail.service.ts` = **Resend HTTP** (`api.resend.com/emails`), verifikovan `obavestenja@servoteh.com`,
`send({to,subject,html})` — **bez attachments**. PDF infra postoji (`documents/pdf.service.ts`,
`work-order-print.service.ts`, `handovers/print-bundle.service.ts` → vraćaju Buffer/PDF).

### Dizajn
- Proširi `MailService.send` → prima `attachments?: {filename, content(base64)}[]` (Resend API polje).
- Generički **`sendDocument(docId, to, variant)`**: dokument → PDF (postojeća infra) → base64 → Resend, +
  audit (ko/kome/kad). „Pošalji na mail" dugme na svakom dokumentu (doc 20).
- **Zamena OSSMTP RFQ** (doc 24): nabavka auto-mail ide kroz Resend, isti servis za sve.
- **Prevod za carinu** (doc 36): eksplicitna štampa-varijanta (`PrintAs` + i18n + carinska tarifa +
  landscape) nad narudžbenicom/uvozom — nije skriveni gest.

**Odluke:** attachment limit ~25MB (Resend/SEF prag, doc 12); ko sme slati = permisija `document.send`. ✅ mi-tehnicki.
**Procena D:** ~2–3 dana.

---

## Redosled gradnje Faze 0 (zavisnosti)
1. **CLS actor-context** (temelj — mora pre audit extension-a).
2. **Audit extension + migracije** (changed_fields, soft-delete, lifecycle) — paralelno UX i Resend (nezavisni).
3. **Soft-delete + UNDO** (posle extension-a).
4. **Lifecycle kolone + permisije** (deklaracija).
5. **Carry-over interfejs + kolone** (dizajn, bez primene).
6. **UX komponente** i **Resend attachments** — nezavisni, mogu paralelno od početka.

## Quick win (prvi merljiv rezultat na 3.0)
**Field-level audit + „ko je izmenio" na 4 vruća modula** (handovers/work-orders/kvalitet/pdm) — odmah vidljivo
u postojećem sistemu: „ko je stavku promenio sa X na Y i kad", + UNDO obrisane stavke. To je nešto što 3.0
danas NEMA, a gradi se na postojećem `AuditLog`-u.

## Rizici (i mitigacija)
- **Audit extension nad SVIM modelima može usporiti/duplirati interceptor** → Faza 0 migrira samo 4 modula na
  `PRISMA_EXTENDED`, ostali inkrementalno; interceptor i extension razdvojeni po `requestId` (nema duplog reda
  za istu izmenu jer extension piše field-level, interceptor request-envelope).
- **Globalni soft-delete filter** rizičan (može sakriti redove u postojećim upitima) → eksplicitni `notDeleted()`.
- **Migracije na hot tabele** (WorkOrder itd.) → samo dodavanje kolona (nullable/default), bez izmene postojećih.

**Ukupno Faza 0:** ~15–22 AI-dana (A 5–8, B 1–2, C 5–7, D 2–3; delom paralelno).

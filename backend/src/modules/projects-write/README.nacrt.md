# Modul Projects-Write + CustomerRfq — NACRT (Traka B §A)

> **Status:** skele spremne, **NIJE aktivirano.** Svi fajlovi imaju ekstenziju `*.ts.nacrt` →
> van TypeScript kompilacije (`npm run build` ih ignoriše), da referentna implementacija ne obori
> build dok Prisma model `CustomerRfq` nije u `schema.prisma`. **Blokada N3** (predmeti master vs
> ogledalo) mora biti potvrđena pre aktivacije — preporuka: **2.0 = MASTER** (write direktno u `projects`).

## Šta je ovde

| Fajl | Uloga |
|---|---|
| `projects-write.controller.ts.nacrt` | REST rute (`/api/v1/projects`, `/api/v1/rfqs/*`), JWT + PermissionsGuard |
| `projects-write.service.ts.nacrt` | `createProject` (numeracija, workTypeId≠0 guard, customer check), `updateProject` |
| `customer-rfq.service.ts.nacrt` | CRUD nad CustomerRfq + `createProjectFromRfq` (write-back, idempotentno) |
| `project-numbering.service.ts.nacrt` | `MAX(project_number::int)+1` uz `pg_advisory_xact_lock` (BigBit DMax+1) |
| `dto/create-project.dto.ts.nacrt` | interface + ručna `validate*()` (kao handovers/kvalitet/nabavka) |
| `dto/update-project.dto.ts.nacrt` | isto, PATCH semantika |
| `dto/customer-rfq.dto.ts.nacrt` | create/update DTO za CustomerRfq (origin/status enum-provere) |
| `projects-write.module.ts.nacrt` | wiring (PrismaModule) |
| `../../../prisma/_nacrt-4.0-trakaB-predmeti.prisma` | Prisma model `CustomerRfq` (1 tabela) |

## Odvojeno od read-only `directory`

`directory` modul (`listProjects`/`findProject`, finansijske kolone sakrivene) se **NE dira** — ovo je
**nov, odvojen** write-path modul nad istom tabelom `projects`. GET putanja predmeta ostaje u `directory`.

## Tok

```
prodavac:  zahtev kupca za ponudu (CustomerRfq, DRAFT) ──> OPEN ──> QUOTED
prodavac:  „Napravi predmet iz zahteva" ──> projects.create (broj, workTypeId=1 TRGOVINA, kopira
             customerId/description) + write-back rfq.projectId (idempotentno) ──> RFQ = QUOTED
prodavac:  createProject (direktno) ──> broj = MAX(project_number::int)+1, openedAt=danas,
             salespersonId=JWT, status=UNKNOWN, workTypeId ≠ 0 (inače „Niste definisali vrstu posla!!!")
```

- **Numeracija** (`project-numbering.service`): `pg_advisory_xact_lock(hashtext('projects:number'))`
  UNUTAR `$transaction`, pa `MAX(project_number::int)+1` (numerički, ne string orderBy) — isti obrazac
  kao `handovers/draft-numbering.service.ts`. Štiti od 2.0↔2.0 trke; dual-run sa BigBit-om tek posle
  cutover-a (odluka N3 = 2.0 jedini pisac).
- **`createProjectFromRfq`** je **idempotentno**: ako `rfq.projectId` već postoji i predmet postoji,
  vraća ga bez kreiranja (`created:false`). Bez opisa → 422.
- **Poslovne greške** = NestJS ugrađeni exception-i (404 NotFound / 422 Unprocessable) — nema još
  `BusinessException` (BACKEND_RULES §7). Domenska poruka `„Niste definisali vrstu posla!!!"` = 422.

## Aktivacija (checklist — kad baza + N3 potvrda budu spremni)

1. **Rebaza** nakon tuđeg `pracenje`/`nabavka` commita (schema.prisma bez konflikta).
2. Prepiši model `CustomerRfq` iz `_nacrt-4.0-trakaB-predmeti.prisma` u `schema.prisma`;
   upiši `/// Was: ZahteviZaPonude` u `docs/schema-rename-map.md`. **Model `Project` se NE menja.**
3. `npm run migrate:dev` na **dev bazi** (Ubuntu, ne prod) → testiraj.
4. Preimenuj sve `*.ts.nacrt` → `*.ts` (i ovaj README u `README.md`).
5. Dodaj u `src/common/authz/permissions.ts`:
   ```ts
   PROJECTS_WRITE: "projects.write",
   RFQ_READ:       "rfq.read",
   RFQ_WRITE:      "rfq.write",
   ```
   + role mapiranje (`role-permissions.ts`) + **mirror** u `frontend/src/lib/permissions.ts`.
6. Registruj `ProjectsWriteModule` u `app.module.ts` imports.
7. **Proveri `AuthUser` polje**: kod koristi `actor.userId` (ne `actor.id`) — vidi `auth/jwt.strategy.ts`.
   (NAPOMENA: `nabavka` nacrt koristi `actor.id` — to je latentni bug u tom nacrtu, ispraviti pri
   njegovoj aktivaciji na `actor.userId`.)
8. Napiši testove (obrazac: `handovers.service.spec.ts` — Prisma-mock): numeracija (MAX+1, prazna
   tabela → "1"), workTypeId=0 → 422 sa tačnom porukom, `createProjectFromRfq` idempotencija.
9. Frontend: otključaj write-akcije predmeta i „Napravi predmet iz zahteva" u UI-u.

## Otvorena pitanja (Traka B §Odluke / BACKEND_RULES §11.1)

- **N3** (predmeti MASTER vs ogledalo) — preporuka: **2.0 MASTER**; write-path čeka potvrdu Negovana.
  Dok BigBit sync još kreira predmete, `createProject`/`createProjectFromRfq` NE smeju u prod (dva pisca).
- **Numeracija tokom dual-run** — advisory lock štiti 2.0↔2.0, ali ne 2.0↔BigBit; 2.0 preuzima
  numeraciju tek na cutover (Nenad).
- **status inicijalno "UNKNOWN"** — potvrditi listu dozvoljenih statusa predmeta (BigBit `T_Statusi`);
  trenutno `Project.status` je slobodan String bez `///` kataloga.
- **`origin` / `status` vrednosti CustomerRfq** — DRAFT|OPEN|QUOTED|WON|LOST usvojene iz plana; potvrditi
  poslovni tok (kada OPEN, kada WON/LOST) sa prodajom.
- **`proformaDocId` meki ref** — na koji dokument model (profaktura/ponuda kupcu) pokazuje — dolazi sa
  Faza-5 fakturama; do tada čist Int bez validacije postojanja.

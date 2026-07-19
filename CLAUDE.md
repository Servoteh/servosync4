# ServoSync4 — koren monorepoa

ERP/MES za Servoteh: prerada QBigTehn legacy sistema (proizvodni core) na moderan stack.
Ovaj repo je **jedinstven monorepo** — nastao spajanjem ranijih `servosync/backend` i
`servosync/frontend` (istorija oba očuvana). Plan verzija 1.0→4.0: [backend/docs/ROADMAP.md](backend/docs/ROADMAP.md).

**Pravila po oblastima — pročitaj pre rada u toj oblasti:**

- Backend (NestJS + Prisma + PostgreSQL): [backend/CLAUDE.md](backend/CLAUDE.md) →
  [backend/docs/BACKEND_RULES.md](backend/docs/BACKEND_RULES.md)
- Frontend (Next.js, dizajn sistem): [frontend/CLAUDE.md](frontend/CLAUDE.md) →
  [frontend/docs/DESIGN_SYSTEM.md](frontend/docs/DESIGN_SYSTEM.md)
- E2E (Playwright smoke): [e2e/](e2e/) — `npm test` + `npm run summary`.

## Aktivni cilj vs referenca

- **ServoSync 3.0 (ovaj repo) = jedini aktivni sistem.** Sve izmene idu ovde, na svež `main`.
  Terminologija i istorijat verzija (šta znače „2.0", „sy15", „glavna baza"…):
  **[docs/VERZIJE.md](docs/VERZIJE.md)** — stariji dokumenti koji kažu „2.0" misle na ovaj repo.
- **ServoSync 1.0 (`servoteh-plan-montaze`) = read-only referenca koja se prazni** — moduli se
  sele ovamo, podaci migriraju, pa se gasi; ne razvija se, ne briše se.

## Legacy / referentni materijal

Folder `_legacy/` drži legacy izvoze i alate za analizu (BigBit `.mdb`/`.mdw`, `Izvoz`, `_analiza`,
`_tools`, `APL`, `QBigTehn_APL`, PDF/docx uputstva, sačuvani git patch-evi). To je **referentni
materijal — ne dira se, ne refaktoriše, i NIJE u gitu** (`.gitignore`, ~2 GB binarnih fajlova).

## Higijena repoa — gde šta ide (pravilo)

**Koren repoa sadrži samo:** `CLAUDE.md`, `README.md`, `.gitignore` i foldere
(`backend/`, `frontend/`, `e2e/`, `docs/`, `_legacy/`, `.github/`, `.claude/`).
Nikakvi radni/doneseni fajlovi ne stoje u korenu. Kad se pojavi novi fajl, odmah ga smesti:

- **Korisnički zahtevi / doneseni dokumenti** (docx, pdf, skice sa sastanaka) →
  [docs/zahtevi/](docs/zahtevi/) — verzionišu se, jer su izvor za planove rada.
- **Legacy binarni materijal** (Access `.mdb`/`.mdw`, izvozi, stari alati) → `_legacy/`
  (van gita). Npr. `_legacy/BigBit26/` — BigBit produkcijski dump iz 2026.
- **Generisani izveštaji/analize** (output skripti, coverage, ad-hoc auditi) →
  `backend/reports/` (gitignored) ili scratchpad — nikad u git.
- **Planovi i analize (markdown)** → `docs/` (monorepo nivo) ili `backend/docs/`
  (backend-specifično; `backend/docs/migration/` za BigBit rekonstrukcije).

Isto pravilo važi i za AI-asistente: fajl zatečen na pogrešnom mestu se premešta po
ovoj šemi (uz `git mv` ako je verzionisan i ažuriranje referenci u docs).

## Deploy (ukratko — detalji u docs/MONOREPO_MIGRACIJA.md)

- **backend** → `.github/workflows/deploy-backend.yml` (push na `main`, paths `backend/**`) na
  self-hosted runner-u; usput bake-uje `frontend/out` u image za same-origin `:3000`.
- **frontend** → Cloudflare Git-integracija vezana za ovaj repo, root dir `frontend/`.

Otvorene arhitektonske odluke (blokiraju — potvrda sa Negovanom/Nesom) su u
[BACKEND_RULES.md §11](backend/docs/BACKEND_RULES.md); ne implementirati ih unapred.

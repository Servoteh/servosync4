# ServoSync4 — monorepo

Jedinstven repo za ServoSync (ERP/MES za Servoteh). Nastao spajanjem dva ranija
odvojena repoa (`servosync/backend` + `servosync/frontend`) u jedan, uz **očuvanu git
istoriju** oba (vidi [docs/MONOREPO_MIGRACIJA.md](docs/MONOREPO_MIGRACIJA.md)).

## Struktura

| Folder | Šta je | Deploy |
|--------|--------|--------|
| [backend/](backend/) | NestJS 11 + Prisma 6 + PostgreSQL 16 (proizvodni core) | self-hosted runner na `.28` → `.github/workflows/deploy-backend.yml` |
| [frontend/](frontend/) | Next.js (dizajn sistem) | Cloudflare Git-integracija (root dir `frontend/`) |
| [e2e/](e2e/) | Playwright klik-test 2.0 (smoke) | ručno: `npm test` + `npm run summary` |
| `_legacy/` | legacy referentni materijal (~2 GB) — **van gita** (`.gitignore`) | — |

## Pravila po oblastima — pročitaj pre rada

- Backend: [backend/CLAUDE.md](backend/CLAUDE.md) → [backend/docs/BACKEND_RULES.md](backend/docs/BACKEND_RULES.md)
- Frontend: [frontend/CLAUDE.md](frontend/CLAUDE.md) → [frontend/docs/DESIGN_SYSTEM.md](frontend/docs/DESIGN_SYSTEM.md)

Root smernice: [CLAUDE.md](CLAUDE.md).

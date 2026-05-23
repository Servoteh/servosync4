# BigTehn API (ServoSync backend)

**ServoSync** is the product name for the BigBit ↔ BigTehn (QMegaTeh) sync and related tooling. This repository is the **NestJS + Prisma + PostgreSQL** backend that will host APIs and future ServoSync jobs. HTTP routes are served under the `/api` prefix.

## Requirements

- Node.js 20+ (recommended)
- Docker Desktop / Docker Engine with **Compose v2** (`docker compose` CLI)
- A recent Compose build that supports `docker compose up --wait` (Docker Desktop 2024+ is usually fine)

## Quick start (first time on a machine)

From the repository root:

```bash
npm run bootstrap
```

This will:

1. Run `npm install`
2. Create `.env` from `.env.example` if `.env` is missing
3. Start PostgreSQL with `docker compose up -d --wait db` (waits until the DB is healthy)
4. Run `prisma migrate deploy` and `prisma generate`

Then start the API:

```bash
npm run start:dev
```

Open `GET http://localhost:3000/api/health` (or the port set in `PORT` inside `.env`).

If you already ran `npm install` and only need to (re)apply DB + client:

```bash
npm run setup
```

If `bootstrap` / `setup` fails with **P3009** (failed migration) or **P3005** (non-empty DB), reset the local Docker volume and run setup again:

```bash
npm run docker:db:fresh
npm run setup
```

If you pulled a change that **renamed the Postgres user or database** (e.g. `bigtehn` → `servosync`), run the same once so the volume matches your `.env`.

## Manual setup (step by step)

Use this when you prefer not to use the scripted flow, or when debugging.

1. `npm install`
2. Copy `.env.example` to `.env` if you do not have `.env` yet (defaults: `localhost:5435`, user `servosync`, password from `docker-compose.yml`).
3. Start Postgres:

   ```bash
   docker compose up -d db
   ```

   For a **clean** volume (all data in that Docker volume is lost):

   ```bash
   npm run docker:db:fresh
   ```

4. Wait until the database accepts connections, then:

   ```bash
   npm run migrate:prod
   ```

5. `npm run prisma:generate` if needed.
6. `npm run start:dev`

The schema is defined in `prisma/schema.prisma` and applied via SQL files in `prisma/migrations/`.

## Schema changes (development)

Create and apply a new migration against your local database:

```bash
npm run migrate:dev
```

This runs `prisma migrate dev` (interactive migration name when prompted).

## Useful commands

| Script | Description |
|--------|-------------|
| `bootstrap` | `npm install` + full local DB setup (best after `git clone`) |
| `setup` | DB + migrations + Prisma Client only (deps must exist) |
| `migrate:dev` | `prisma migrate dev` — create/apply migrations in development |
| `migrate:prod` | `prisma migrate deploy` — apply pending migrations (CI/production-style) |
| `prisma:pull` | Introspect the database into `schema.prisma` (review diffs afterwards) |
| `prisma:studio` | Open Prisma Studio |
| `docker:db:fresh` | `docker compose down -v` + `up -d db` — reset local Postgres volume |
| `prisma:migrate:baseline` | Mark baseline migration as applied without running SQL (existing DB that already matches the baseline) |
| `prisma:migrate:resolve-failed` | Mark failed baseline migration as rolled back (see P3009) |

`npm run build` runs `prisma generate` automatically via `prebuild`.

Legacy aliases `prisma:migrate` and `prisma:migrate:deploy` still map to the same Prisma commands.

## Troubleshooting

### “The datasource property `url` is no longer supported in schema files” (Prisma 7)

This repo targets **Prisma 6**, where `url = env("DATABASE_URL")` in `schema.prisma` is valid. The message appears if the **Prisma 7** CLI or extension validates your schema.

1. Use the project’s CLI (not bare `npx prisma` without a version):  
   `npm run migrate:prod`, `npm run prisma:generate`, `npm run prisma:pull`, etc.
2. Reinstall pinned versions:  
   `rm -rf node_modules package-lock.json && npm install`
3. If you use the **Prisma VS Code extension**, set it to match the workspace Prisma version or disable schema validation until you intentionally upgrade to Prisma 7 (that upgrade needs `prisma.config.ts`, driver adapters, and Jest/ESM changes).

### P3005 — database schema is not empty

The database already has tables (old volume or manual DDL), but Prisma expects an empty database for the first `migrate deploy`.

- If you can drop local data: `npm run docker:db:fresh`, then `npm run migrate:prod` again.
- If you must keep an existing database that already matches the baseline migration: run once `npm run prisma:migrate:baseline` (marks the migration as applied without executing its SQL).

### P3009 — failed migrations in the target database

`_prisma_migrations` contains a failed run for `20260104120000_baseline`. Prisma will not apply new migrations until this is resolved.

- **Typical local fix:** `npm run docker:db:fresh`, then `npm run migrate:prod` (clears the volume, including migration history).
- **If you cannot delete the volume:** `npm run prisma:migrate:resolve-failed`, then manually drop partially created tables if deploy fails with “already exists”, then `npm run migrate:prod` again.

### P3018 — migration failed mid-way

Same practical recovery as above: reset the local volume with `npm run docker:db:fresh`, then run `npm run migrate:prod` again after fixing the migration SQL in the repo.

## Tests

```bash
npm run test
npm run test:e2e
```

## Optional: migrate via Docker Compose

After `docker compose up -d db`:

```bash
docker compose --profile migrate run --rm migrate
```

Uses `DATABASE_URL` pointing at the `db` service inside the compose network (see `docker-compose.yml`).

## Documentation

- [ServoSync — BigBit → BigTehn sync (legacy behaviour & v2 goals)](docs/ServoSync-specification.md)

## Legacy MSSQL tooling

One-off SQL Server → PostgreSQL conversion scripts and archived SQL live under `legacy/`. Day-to-day schema work should go through Prisma only.

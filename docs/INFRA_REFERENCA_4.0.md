# Infrastruktura i pristup — referenca za gradnju 4.0

> **Datum:** 2026-07-19. Konsolidacija 9 izvora (master: `backend/docs/infra/INFRASTRUKTURA.md`) na jedno
> mesto — da se osnovne činjenice ne ponavljaju. Stanje verifikovano 08.07 (SSH + živa provera).

## 1. Mašine
| Mašina | Adresa | Uloga |
|---|---|---|
| **Ubuntu server** | `192.168.64.28` (`ubuntusrv`) | **Prod PG + backend API :3000 + GitHub self-hosted runner + bigbit-bridge**. SSH nalog `admnenad` (ključ `servoteh_vm_ed25519`). |
| Bridge VM „DC" | `192.168.64.24` | Win Server — BigTehn→Supabase sync + SCADA relay + domen kontroler |
| Vasa-SQL | `192.168.64.25:5765` | QBigTehn MS SQL (legacy izvor); `bridge_reader` read-only |
| BigBit mašina | `192.168.64.14` | BigBit `.mdb` (izvor za bigbit-bridge); CIFS share `EXPORT/...` |
| 1.0 Supabase | cloud `fniruhsuotwsrjsbhrxd` | ServoSync 1.0 baza (198 tabela) |

## 2. Baza — ⚠️ NEMA lokalne dev baze, NEMA staginga
- **Prod PG:** Docker kontejner **`servosync-pg`** (`postgres:18`) na Ubuntu; port **`5435` na hostu** →
  `5432` u kontejneru; **dostupan sa celog LAN-a**. Baza/user `servosync/servosync`. **Prod lozinka ≠ dev** —
  živi samo u prod `.env` (pod `~admluka`, čita se `sudo`) i u kontejneru (`printenv POSTGRES_PASSWORD`). Van gita.
- **Pristup:** (a) direktno sa LAN-a `postgresql://servosync:<LOZINKA>@192.168.64.28:5435/servosync` (psql/DBeaver/
  Prisma Studio); (b) SSH + `sudo docker exec -it servosync-pg psql -U servosync -d servosync`.
- **Dev baza:** postoji samo kao `backend/docker-compose.yml` (`db` servis, `localhost:5435`, lozinka `servosync_dev`)
  — **Nenad je nema pokrenutu lokalno**. Dokumentacija izričito: *„Radimo direktno na produkciji (bez staging-a)"*.
  Jedina schema je `public` (grep `CREATE SCHEMA` = 0).
- `sy15-db` (zaseban kontejner na Ubuntu) = 1.0 pilot datasource (Reversi/kadrovska; env `SY15_DATABASE_URL`).

## 3. Migracije (Prisma)
- Šema **samo kroz Prisma migracije** (nikad ručni DDL na produ). `npm run migrate:dev` lokalno; `prisma migrate
  deploy` prod. **Primenjene migracije se NE edituju.** Klijent `@prisma/client 6.19.3`.
- **⚠️ Na produ migracije primenjuje CI AUTOMATSKI na svaki backend deploy** (`docker compose run --rm backend npx
  prisma migrate deploy`). CI (`ci-backend.yml`) vozi testove sa **Prisma-mock** — **NE testira migraciju nad živom
  bazom**, i **ne blokira deploy** (nema `needs: [ci]`).
- **Test migracije PRE prod-a = nema automatski.** Jedini siguran način: lokalna dev baza (`docker compose up -d db`)
  → `migrate:dev` → testiraj → pa PR→merge.

## 4. Deploy
- **Backend:** self-hosted runner na serveru; okida **push na `main` sa `backend/**`** (isključeni `test/**`, `docs/**`).
  Tok: build frontend `out` + bake u image → rsync → `docker compose build backend` → **`prisma migrate deploy`** →
  `up -d backend` → health `/api` + `/login`. Same-origin :3000 servira i front.
- **Frontend (prod):** Cloudflare Git-integracija (`servosync2`, root `frontend/`) → `servosync2.servoteh.com`.
  **Frontend NE okida backend deploy** — bezbedno za nav izmene.
- **bigbit-bridge:** systemd timer 05:30, `mdb-tools` → `docker exec ... psql` u `servosync-pg`.

## ✅ DEV BAZA — POSTAVLJENA 19.07 (servosync-dev)
- **Kontejner `servosync-dev`** na Ubuntu (`192.168.64.28`), `postgres:18`, mreža `servosync_default`,
  volume `servosync-dev-data`, mount `/var/lib/postgresql` (PG18 konvencija, isto kao prod).
- **Port `0.0.0.0:5437` — DOSTUPAN sa Nenadovog PC-a preko LAN-a** ✅ (5435=prod, 5436=sy15, 5437=dev).
- **Klon prod-a (19.07):** `pg_dump --format=custom` prod → `pg_restore` dev. 100 tabela, 24 primenjene
  Prisma migracije, projects=7602. Verno stanje prod-a → `migrate dev` vidi sinhronizovano.
- **DEV URL** (u `backend/.env.dev`, van gita):
  `postgresql://servosync:servosync_dev@192.168.64.28:5437/servosync?schema=public`
- **Kako migrirati na DEV** (Windows PowerShell / bash):
  `DATABASE_URL="postgresql://servosync:servosync_dev@192.168.64.28:5437/servosync?schema=public" npx prisma migrate dev`
  (ili `dotenv -e .env.dev -- npx prisma migrate dev` ako se doda dotenv-cli). **Nikad `.env` prod URL za dev migraciju.**
- **Re-klon** (osveži dev iz prod-a): `docker exec servosync-pg pg_dump ... | docker cp ... | pg_restore --clean --if-exists`.
- **⚠️ NAUČENO 19.07:** `prisma migrate dev` u ne-interaktivnom shell-u (Bash tool) **NE čeka potvrdu** i
  RESETUJE bazu ako detektuje drift (klon prod-a IMA drift: `_pwhash_backup_*` tabele + 2 FK van migracija).
  Zato: (1) `.env` sada pokazuje na DEV (5437), ne prod; (2) za 4.0 migracije koristi `prisma migrate diff`
  → izoluj samo nove `CREATE TABLE` (odseci `DROP INDEX idx_work_orders_parent` + `bb_sync_state DROP DEFAULT`
  drift redove) → `psql -f` direktno → `migrate resolve --applied`. NE `migrate dev` na kloniranoj bazi.
- **PROD DRIFT (nalaz):** prod je u drift-u sa schema.prisma već sada — `idx_work_orders_parent` i
  `bb_sync_state.updated_at` default postoje na bazi ali ne u migracijama. Bezopasno, ali očistiti u zasebnoj migraciji.
- **Napomena:** dev je 24 migracije; repo ima 25 (`20260719120000_pracenje_native_f1` = tuđi „Pracenje",
  još nije na prod). Kad taj ode na main + prod, dev re-klonirati.

## ⚠️ 4.0 gradnja — stvarno stanje (provereno 19.07 sa Nenadovog PC-a)
- **Nenadov PC:** NEMA Docker, NEMA lokalnu dev bazu (`localhost:5435` zatvoren). **Koristi se `servosync-dev` na Ubuntu (gore).**
- **PROD baza `192.168.64.28:5435` je DOSTUPNA sa PC-a preko LAN-a** ✅ (ali `.env` pogrešno kaže
  `@localhost:5435` — za direktan pristup treba `@192.168.64.28:5435`).
- **NE migrirati direktno na prod** (živa firmina baza). Tok: `migrate dev` na **`servosync-dev`** → PR → merge →
  CI radi `migrate deploy` na prod. `pg_dump` snapshot prod-a pre svake netrivijalne migracije.
- **Konto mape (2040/2050/4350/4360/2740/47x…):** potvrđene iz BigBit analize (docs 30/39) — NE čeka se Nesa
  za osnovni registar; Nesa validira tek regulatorni izlaz (PDV/bilansi) paralelnim vođenjem.

## 5. Bezbedan dev-tok za 4.0 (preporuka)
1. **Feature grana** (`feat/4.0-...`) od `main` HEAD — NIKAD direktno na `main` (main ima tuđe izmene + deploy trigger).
2. **Lokalna dev baza** (`docker compose up -d db`, port 5435, `servosync_dev`) — jedini način da migraciju testiraš
   pre prod-a. Bez nje: samo autoring `schema.prisma`, migracija se ne pušta.
3. **Rizične migracije (Float→Decimal, hot tabele) = aditivno + backfill + swap**, NE in-place `ALTER USING` (lockuje
   prod). PRE prvog prod knjiženja. Ručni `pg_dump` snapshot pre svake netrivijalne migracije.
4. **PR→merge**, ne push na main; razmisliti o `needs: [ci]` kapiji.

## 6. Tajne (GDE su, bez vrednosti)
Prod DB lozinka: `~admluka/servosync/.env` + kontejner env. `backend/.env` (van gita, šablon `.env.example`):
`DATABASE_URL`, `BIGBIT_DB_PASSWORD`, `JWT_SECRET`, `SY15_*`. GitHub secrets: runner self-hosted (odlazni, bez porta).
BigBit `.mdb` = bez lozinke (`mdb-tools` ignoriše ULS).

## Ponovljive činjenice (da se ne pitaju)
Ubuntu `192.168.64.28` · kontejner `servosync-pg` · port `5435`(host)→`5432` · `servosync/servosync` · SSH `admnenad` ·
Vasa-SQL `192.168.64.25:5765` · **bez staginga, migrate deploy auto na svaki backend push** · dev baza samo lokalno u compose.

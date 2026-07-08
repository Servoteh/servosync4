# ServoSync — infrastruktura i pristup (master dokument)

> Kompletna slika: koje mašine postoje, gde je baza, kako ide deploy, ko čemu sme da priđe.
> **Stanje verifikovano 2026-07-08** (živa provera sa Nenadove mašine + SSH na server).
> Detaljni pod-dokumenti: [INSTALACIJA-VM.md](INSTALACIJA-VM.md) (bridge VM), [SCADA-RELAY.md](SCADA-RELAY.md)
> (SCADA tok), [../../../frontend/docs/DEPLOY.md](../../../frontend/docs/DEPLOY.md) (Cloudflare front/tunnel),
> [BAZE-UPOREDNI-PREGLED.md](BAZE-UPOREDNI-PREGLED.md) (spisak tabela 1.0 vs 2.0 sa brojem redova).

---

## 1. Mašine (mrežna mapa)

| Mašina | Adresa | Uloga | Pristup |
|---|---|---|---|
| **Ubuntu server** | `192.168.64.28` · alias `ubuntusrv` | **Prod PostgreSQL + backend API** (2.0), cilj selidbe 1.0 baze | SSH `admnenad`/`admluka`/`waxadmin` (+ sudo) |
| **Bridge VM „DC"** | `192.168.64.24` | BigTehn→Supabase sync + SCADA relay + Kotlarnica SCADA (port 3000) | SSH `adm.nenad` (Win Server 2016) — v. [INSTALACIJA-VM.md](INSTALACIJA-VM.md) |
| **Vasa-SQL** | `192.168.64.25:5765` | QBigTehn MS SQL — izvor legacy podataka | `bridge_reader` (read-only, cela baza) + admin (Nenad) |
| **SCADA LAN** | `192.168.75.x` | PLC/Loxone/blue'Log uređaji | samo sa bridge VM |
| **1.0 Supabase** | `fniruhsuotwsrjsbhrxd.supabase.co` (cloud) | ServoSync **1.0** baza (Postgres+PostgREST+GoTrue, 198 tabela) | service_role / access token (§3b) |

> ⚠️ Bridge VM je i **domen kontroler** — planirana selidba bridge+scada-app na Ubuntu (systemd uniti
> spremni u [SCADA-RELAY.md](SCADA-RELAY.md) §Ubuntu).

---

## 2. Ubuntu server (`ubuntusrv` · 192.168.64.28)

| | |
|---|---|
| OS | Ubuntu 24.04.4 LTS (kernel 6.8) |
| Docker | 29.6.1 |
| Admin nalozi | `admluka` (Luka), `admnenad` (Nenad), `waxadmin` — svi u `sudo` grupi; home-ovi 0750 (ne čitaju se međusobno bez sudo) |
| Otvoreni portovi | `22` SSH · `3000` backend API · `5435` PostgreSQL · `53` systemd-resolved · `631` CUPS · `20241` (ostalo) |

### SSH pristup

```bash
ssh ubuntusrv          # alias iz ~/.ssh/config: HostName 192.168.64.28, User admnenad, key servoteh_vm_ed25519
```

> ⚠️ Nalog je **`admnenad`** (bez tačke). `adm.nenad` sa tačkom je Windows bridge-VM nalog i NE radi ovde.

---

## 3. Prod baza — PostgreSQL

| | |
|---|---|
| Kako radi | **Docker kontejner `servosync-pg`** (`postgres:18`; nije nativni servis — `systemctl postgresql` = inactive) |
| Port | **5435** na hostu (`0.0.0.0:5435` → container `5432`) — **dostupan sa celog LAN-a** (verifikovano: konekcija sa Nenadove mašine radi, 88 tabela, migracije primenjene) |
| Baza / user | `servosync` / `servosync` |
| Lozinka | **prod ≠ dev**: `servosync_dev` iz repo `.env` NE radi na produ. Prava lozinka je u prod `.env` / kontejneru na serveru (retrieval u §4a) |
| Vlasnik stack-a | compose + prod `.env` su pod home-om vlasnika deploy-a (`admluka`); čitljivo drugima samo preko sudo |
| Migracije | Prisma (`prisma migrate deploy`) — automatski pri deploy-u (v. §5); šema se NE dira ručno |

Dev baza (za lokalni rad) je zasebna: Docker Postgres na `localhost:5435` iz [../../docker-compose.yml](../../docker-compose.yml),
lozinka `servosync_dev`. Ista port-broj 5435, ali druga mašina — ne mešati.

### 3b. ServoSync 1.0 baza — Supabase (cloud)

1.0 (`servoteh-plan-montaze`) NE koristi on-prem PG nego **Supabase** (hostovani Postgres + PostgREST + GoTrue).
Do gašenja u 3.0 živi paralelno sa 2.0.

| | |
|---|---|
| Projekat (ref) | `fniruhsuotwsrjsbhrxd` · `https://fniruhsuotwsrjsbhrxd.supabase.co` |
| Baza | Postgres, **198 tabela** u `public` (verifikovano 2026-07-08); ~360+ RLS politika = authz sloj |
| Migrira se | u 1.5 (međukorak) na on-prem Ubuntu (PG + PostgREST + GoTrue), pa u 3.0 u 2.0 stack |

**Pristup (ključevi su u `servoteh-plan-montaze/.env` i `servoteh-bridge/.env` — NISU u git-u):**

| Način | Ključ | Šta daje |
|---|---|---|
| **Raw SQL** | `SUPABASE_ACCESS_TOKEN` (Management API) | pun SQL: `POST https://api.supabase.com/v1/projects/<ref>/database/query` — čita/piše sve, zaobilazi RLS |
| **REST (podaci)** | `SUPABASE_SERVICE_ROLE_KEY` | `GET/POST https://<ref>.supabase.co/rest/v1/<tabela>` — pun CRUD nad podacima, zaobilazi RLS |
| **Klijentski** | `VITE_SUPABASE_ANON_KEY` | isto što i front 1.0 — poštuje RLS (ograničeno po roli) |

> ⚠️ `SUPABASE_ACCESS_TOKEN` je **management token za ceo projekat** (može i da menja/obriše projekat) —
> najosetljiviji od svih; tretirati kao root. `SERVICE_ROLE` zaobilazi RLS — ne stavljati ga u klijentski kod.
> Direktne Postgres lozinke za Supabase (za psql/DBeaver) nema u fajlovima — bila bi u Supabase dashboard-u
> (Project Settings → Database), ako zatreba raw psql umesto Management API-ja.

---

## 4. Pristup bazi — ko sme šta

**Nije „samo Luka".** Nenad ima ravnopravan pristup na svakom sloju (verifikovano 2026-07-08):

| Sloj | Nenad | Kako |
|---|---|---|
| Mreža do porta 5435 | ✅ | port otvoren, dostupan sa laptopa (testirano) |
| SSH na server | ✅ | `ssh ubuntusrv` (nalog `admnenad`) |
| Root na serveru | ✅ | `admnenad` u `sudo` grupi → `sudo …` uz svoju lozinku |
| Prod DB lozinka | ⏳ | jedino što fali — daje je Luka, ili je Nenad uzme sam preko sudo (dole) |

### 4a. Kako doći do prod lozinke (na serveru, preko sudo)

```bash
ssh ubuntusrv
# 1) nađi gde je stack i pročitaj lozinku iz prod .env:
sudo find /home -maxdepth 3 -name '.env' -path '*servosync*' 2>/dev/null
sudo grep DATABASE_URL <putanja>/.env
# 2) ili pročitaj lozinku direktno iz kontejnera (ime je servosync-pg):
sudo docker exec servosync-pg printenv POSTGRES_PASSWORD POSTGRES_USER POSTGRES_DB
# 3) ili uđi u psql u kontejneru:
sudo docker exec -it servosync-pg psql -U servosync -d servosync
```

> `admnenad` NIJE u `docker` grupi i `sudo` traži lozinku — komande iznad se pokreću u
> **interaktivnom** SSH terminalu (ne prolaze kroz neinteraktivnu/automatizovanu sesiju).

### 4b. Direktan pristup sa Nenadove mašine (kad ima prod lozinku)

Pošto je port 5435 otvoren sa LAN-a, baza se koristi kao da je lokalna — bilo kojim klijentom:

```
Host:     192.168.64.28
Port:     5435
Database: servosync
User:     servosync
Password: <PROD_LOZINKA_OD_LUKE>
```

- **psql:** `psql "postgresql://servosync:<LOZINKA>@192.168.64.28:5435/servosync"`
- **DBeaver / TablePlus / DataGrip:** novi PostgreSQL konekt sa gornjim poljima
- **Prisma Studio (iz repoa):** `DATABASE_URL="postgresql://servosync:<LOZINKA>@192.168.64.28:5435/servosync?schema=public" npx prisma studio`

> Za upite/izmene šeme iz alata poštovati [BACKEND_RULES.md](../BACKEND_RULES.md): šema se menja SAMO kroz
> Prisma migracije, ne ručnim DDL-om na produ. Ad-hoc `SELECT` je slobodan; ručni `INSERT/UPDATE/DELETE`
> na sync-cache tabelama se ne radi (piše ih sync modul).

---

## 5. Deploy — kako kod stiže na server

**Backend** (auto, na `git push` u `main`) — [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml):

```
push main → GitHub Actions self-hosted runner (živi NA serveru, outbound-only)
          → rsync source u ~/servosync/backend
          → docker compose build backend
          → docker compose run --rm backend npx prisma migrate deploy   (idempotentno)
          → docker compose up -d backend
          → health check: curl localhost:3000/api
```

Docs-only push se ignoriše (paths filter). Ništa se ne izlaže spolja — runner zove GitHub odlazno.

**Frontend** (auto, na `git push` u `main` na `github.com/servosync/frontend`):

```
push main → Cloudflare (Workers, projekat servosync2) auto-build static export
          → servosync2.servoteh.com
```

Detalji i ručni deploy: [frontend/docs/DEPLOY.md](../../../frontend/docs/DEPLOY.md).

---

## 6. Javni pristup (Cloudflare)

| Deo | Javni hostname | Put |
|---|---|---|
| Front | `servosync2.servoteh.com` | Cloudflare Workers (projekat `servosync2`), git-povezan auto-deploy |
| Backend API | `api.servosync2.servoteh.com` | Cloudflare Tunnel `servosync2` → `localhost:3000` na serveru |

- Zona `servoteh.com` na Cloudflare nalogu `nenad.jarakovic@servoteh.com`.
- **Status 2026-07-08:** front živ (cert active); backend radi lokalno (port 3000 sluša), ali `cloudflared`
  na serveru je **još inactive** — dok se ne pokrene sa tunnel tokenom, `api.servosync2.servoteh.com` ne
  prolazi do backenda. Pokreće ga `admluka`/`admnenad` na serveru (v. DEPLOY.md §Backend-Tunnel).
- 1.0 radi paralelno na `servosync.servoteh.com` (zaseban Pages projekat).

---

## 6b. Front na :3000 (LAN / offline fallback)

Kad internet/Cloudflare padne, front na Cloudflare-u je nedostupan. Zato backend može da servira i
**sam front** (Next static export `out/`) na svom portu — isti origin, **bez CORS-a i bez drugog kontejnera**.
Uključuje se env promenljivom `FRONTEND_STATIC_DIR` (prazno = samo API, kao do sada); front sam izvede API
na istom hostu:portu (`src/api/client.ts` runtime-resolve), pa radi bez ikakve dodatne konfiguracije.

> ⚠️ Zavisi od merge-a `feat/wave-3 → main`: i runtime-resolve (frontend) i serviranje statike (`main.ts`)
> su na `feat/wave-3`. Prod backend se auto-deploy-uje sa `main`, pa ovo proradi tek kad wave-3 uđe u `main`
> (Lukin pregled) i backend se rebuilduje. Do tada je za test potreban ručni build backenda sa `feat/wave-3`.

Koraci na serveru (interaktivno; `admnenad`/`admluka` sa sudo). Compose je `/home/admluka/servosync/docker-compose.yml`:

```bash
ssh ubuntusrv
cd /home/admluka/servosync
# 1) front repo kao izvor out/ (dok nije u main-u, uzmi feat/wave-3):
sudo git clone -b feat/wave-3 https://github.com/servosync/frontend.git frontend
# 2) build out/ bez Node-a na hostu (jednokratni node kontejner):
sudo docker run --rm -v "$PWD/frontend":/app -w /app node:22-bookworm-slim sh -c "npm ci && npm run build"
```

Zatim u `backend` servis u `docker-compose.yml` dodaj volume + env:

```yaml
  backend:
    # ... postojeće ...
    environment:
      # ... postojeće (DATABASE_URL, JWT_SECRET, ...) ...
      FRONTEND_STATIC_DIR: /app/frontend-static
    volumes:
      - ./frontend/out:/app/frontend-static:ro
```

```bash
sudo docker compose up -d backend
curl -I http://localhost:3000/login          # -> 200 (front na :3000)
curl -fsS http://localhost:3000/api > /dev/null && echo "API i dalje radi"
```

Klijenti otvore `http://192.168.64.28:3000` — dobiju front, API je na `.../api` (isti origin). Osvežavanje
fronta: `cd frontend && sudo git pull && sudo docker run --rm ... npm ci && npm run build` (build gore) —
backend ne treba restart (čita volume). Verifikovano izolovano: `/login`, `/login/`, `/` → 200 HTML;
`_next`/`config.js`/`favicon` → 200; `/api/*` prolazi ka kontrolerima.

> Alternativa (zaseban nginx kontejner na `:8080`, `front-lan`) je opisana u
> [../../../frontend/docs/DEPLOY.md](../../../frontend/docs/DEPLOY.md) → „LAN pristup". Ovo (front na :3000)
> je čistije: jedan origin, nema CORS-a, jedan servis.

---

## 7. Bezbednosne napomene

- **Nula direktno izloženih portova** na internet — sve javno ide kroz Cloudflare (Pages/Workers + Tunnel).
  Na LAN-u su portovi otvoreni (5435, 3000, 22) jer je mreža interna.
- `bridge_reader` (Vasa-SQL) je read-only na celoj QBigTehn bazi (odluka 2026-07-06, [SYNC-SETUP.md §7](../../SYNC-SETUP.md)).
- Prod DB lozinka i `.env` tajne **nisu u git-u** — samo na serveru; prenose se ručno/preko sudo.
- U QBigTehn MSSQL se **nikad ne piše** (samo SELECT preko `bridge_reader`).

---

## 8. Brza dijagnostika

| Simptom | Provera |
|---|---|
| Ne mogu SSH na server | koristiš li `ssh ubuntusrv` (nalog `admnenad`, ne `adm.nenad`)? ključ `~/.ssh/servoteh_vm_ed25519` |
| Baza „auth failed" | koristiš dev lozinku (`servosync_dev`) na produ — treba prod lozinka iz `.env` na serveru |
| Port 5435 nedostupan | `Test-NetConnection 192.168.64.28 -Port 5435`; jesi li na istoj LAN/VPN mreži? |
| `api.servosync2` ne radi | `cloudflared` na serveru nije pokrenut (v. §6) |
| Backend lokalno? | `ssh ubuntusrv "curl -fsS localhost:3000/api"` |
```

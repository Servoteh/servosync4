# Reversi pilot (3.0-B) — preostali koraci za PUŠTANJE UŽIVO

Stanje 2026-07-10: kod je MERGED na `main` (BE + FE), e2e klik-test prošao na živoj
sy15 bazi. Backend se auto-deploy-uje na push (runner) i **boot-safe je** — bez
`SY15_DATABASE_URL` Reversi endpointi vraćaju 503, sve ostalo (TP/RN/PDM/…) radi normalno.
Da bi Reversi RADIO uživo, ostaju **2 serverska koraka + 1 FE deploy** (traže `admluka`/sudo —
ja kao `admnenad` bez sudo-a ne mogu; sve komande su niže).

## 1. Backend env + docker mreža (na serveru, kao admluka ili sudo)

Backend (`servosync-backend`, Lukin compose `~/servosync/docker-compose.yml`) mora da:
(a) vidi `sy15-db` po imenu → priključiti ga na `servosync15_default` mrežu,
(b) ima `SY15_*` env promenljive.

**Env vrednosti su spremne** u `ubuntusrv:~/servosync15/sy15-app-role.env`
(`SY15_DATABASE_URL` sa rolom `servosync2_app`). Dodati u backend `environment`/`env_file`:

```
SY15_DATABASE_URL=postgresql://servosync2_app:<lozinka>@sy15-db:5432/postgres
SY15_STORAGE_URL=http://sy15-storage:5000/storage/v1     # ili javni gateway /storage/v1
SY15_SERVICE_KEY=<sy15 SERVICE_ROLE key iz ~/servosync15/.env>
```

U `docker-compose.yml` (servis backend) dodati eksternu mrežu — da preživi `compose up -d`
(ručni `docker network connect` se GUBI pri recreate-u iz deploy workflow-a):

```yaml
services:
  backend:
    networks: [default, servosync15]
    # ... env_file ili environment sa SY15_* iznad
networks:
  servosync15:
    external: true
    name: servosync15_default
```

Pa: `docker compose up -d backend`. Provera: `curl -s http://localhost:3000/api/v1/reversi/reports/warehouse -H "authorization: Bearer <token>"` → JSON (ne 503).

## 2. Aktivacija reversi.* prava korisnicima (već u kodu, nije DB posao)

`reversi.read/manage/team_read` su u `role-permissions.ts` (admin/menadzment/magacioner/pm/leadpm
= manage; svi prijavljeni = read). `AUTHZ_ENFORCE=true` je već na produ → prava rade čim BE dobije env.

## 3. FE wrangler deploy (kada je BE spreman)

Namerno NIJE pokrenut da korisnici ne vide 503-Reversi pre nego što BE dobije env.
Kad korak 1 prođe: iz `Servosync 2.0/frontend` (main): `npm run deploy` (`next build && wrangler deploy`).
Reversi se pojavi u nav-u „Oprema i energija" za korisnike sa `reversi.read`.

## Verifikacija posle svega
- Login → nav „Oprema i energija → Reversi" → tab Moji alati/Stanje magacina učitavaju.
- Kao magacioner: „+ Izdaj" → skeniraj/izaberi alat → Izdaj → dokument OPEN; pa „Vrati…" → RETURNED.
- Paritet: isti dokument vidljiv i u 1.0 Reversi UI-ju (ista baza).

## Preostalo za R3 (nije blokada za puštanje — Nenad dorađuje)
- Bulk-import (XLSX) endpoint + FE ekran (1.0 radi klijentski; seli se na BE).
- Rezni alat tab + kartica mašine (katalog reznog danas prazan).
- Skener „za povraćaj" (skeniraj alat → nađi otvoren revers) — sada je skener u Izdaj.

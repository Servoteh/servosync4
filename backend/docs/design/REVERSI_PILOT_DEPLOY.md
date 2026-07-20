# Reversi pilot (3.0-B) — ✅ UŽIVO (2026-07-11)

**PILOT JE PUŠTEN UŽIVO 11.07.2026.** BE služi realne Reversi podatke sa sy15 (magacin 47,
27 dokumenata) na `servosync2.servoteh.com`; FE `/reversi` (200) pod nav grupom „Oprema i
energija". Sve niže je izvršeno — ostaje samo domenska validacija reznog (Nenad, §Rezni).

Istorijat (za referencu): kod MERGED na `main` (BE+FE), e2e klik-test prošao na živoj sy15;
backend je **boot-safe** (bez `SY15_DATABASE_URL` Reversi vraća 503, ostalo radi).

## ⚠️ KRITIČNA LEKCIJA (sudar mrežnog alias-a `db`) — pri sledećem sličnom radu

Kad je backend priključen na `servosync15_default` (da vidi sy15-db), **`sy15-db` ima network
alias `db`** — isti kao 2.0 host u `DATABASE_URL=...@db:5432`. Docker DNS je `db` razrešio na
sy15-db → 2.0 backend pao na „Authentication failed for servosync" (pogrešna baza!). **Fix:
2.0 `DATABASE_URL` host `db` → `servosync-pg`** (container_name, jednoznačan). Bez ovoga
priključivanje na sy15 mrežu OBARA ceo 2.0 backend. Isto važi za bilo koji cross-stack join.

## 1. Backend env + docker mreža — ✅ IZVRŠENO (admnenad ima ACL rw na Lukin compose)

Backend (`servosync-backend`, `~admluka/servosync/docker-compose.yml` + `backend.env` —
admnenad ima ACL `rw`, ne treba sudo). Urađeno:

## 1. Backend env + docker mreža (na serveru, kao admluka ili sudo)

Izmene su u `~admluka/servosync/backend.env` i `docker-compose.yml` (NISU u git repou →
preživljavaju auto-deploy; backup compose-a: `~admnenad/compose-backup-*.yml`).

**(a) `backend.env` — dodato:**
```
SY15_DATABASE_URL=postgresql://servosync2_app:<pw>@sy15-db:5432/postgres   # iz ~/servosync15/sy15-app-role.env
SY15_STORAGE_URL=https://api.servosync.servoteh.com/storage/v1
SY15_SERVICE_KEY=<SERVICE_ROLE_KEY iz ~/servosync15/.env>
# + IZMENJENO: DATABASE_URL host db → servosync-pg (vidi KRITIČNU LEKCIJU gore)
```

> ⚠️ **Lekcija (20.07.2026):** `SY15_STORAGE_URL` MORA biti **javni gateway URL**
> (`https://api.servosync.servoteh.com/storage/v1`), NE interni docker host
> (`http://sy15-storage:5000/storage/v1`, kako je ovaj dokument ranije nalagao).
> Interni host je 20.07. oborio **sve** BE storage tokove (upload + potpisani URL-ovi,
> 8 modula): (a) `/storage/v1` prefiks skida Caddy gateway — storage-api (Fastify) ga
> ne poznaje pa direktan pogodak vraća 404; (b) `signUrl()` vraća `${base}${signedURL}`
> koji otvara **browser**, pa base mora biti javno dostupan. Detalji:
> [PLAN_SASTANCI_PRIMEDBE_2026-07-20.md §S0](../../../docs/PLAN_SASTANCI_PRIMEDBE_2026-07-20.md).

**(b) `docker-compose.yml` — backend na obe mreže:**
```yaml
services:
  backend:
    networks: [default, sy15]
networks:
  sy15:
    external: true
    name: servosync15_default
```
Pa: `docker compose up -d backend`. **Verifikovano živo:** warehouse=200 (47 stavki), documents total=27.

## 2. Aktivacija reversi.* prava (u kodu, nije DB posao) — ✅

`reversi.read/manage/team_read` u `role-permissions.ts` (admin/menadzment/magacioner/pm/leadpm
= manage; svi prijavljeni = read). `AUTHZ_ENFORCE=true` na produ → radi.

## 3. FE wrangler deploy — ✅ IZVRŠENO (verzija 27d2244f)

`npm run deploy` iz `Servosync 2.0/frontend` (main). Živo: `servosync2.servoteh.com/reversi` = 200,
nav grupa „Oprema i energija". (Tehnologija iframe u 1.0 hubu servira isti front.)

## Verifikacija posle svega — ✅ (osim reznog)
- `/reversi` 200; warehouse/documents vraćaju realne podatke kroz živi backend na sy15.
- Ručni alat: izdaj→vrati dokazan (REV-TOOL-2026-0027). Rezni: create+seed rade; **izdavanje
  reznog traži domensku validaciju** (§Rezni — source-location, prazan katalog).

## Paritet sa 1.0 — DODATO (11.07)
- **Kartica alata** (klik na red u Magacinu/Otpisano): baterije, servisi, Otpiši/Vrati u upotrebu, Prijem zaliha.
- **Potpisnica PDF**: „Generiši" (client jsPDF + Roboto) → upload; „Preuzmi" (potpisan URL).
- **Bulk-import** inventara ručnog alata (XLSX/CSV, dugme „Uvoz alata" u Magacinu) — verifikovano na živoj bazi.
- **Skener** (kamera BarcodeDetector + HID + ručni unos) u „Izdaj".
- **Rezni alat** tab: katalog (create/update/list + na stanju), Zaliha (seed), Izdaj na mašinu; **Mašine** → kartica (rezni na mašini + glave).

## ⚠️ Rezni alat — traži domensku validaciju (Nenad, sa realnim podacima)
Katalog reznog je danas PRAZAN. Verifikovano na živoj bazi: **create + seed rade**.
**Cutting ISSUE/RETURN source-location model NIJE potvrđen** — `rev_issue_cutting_reversal`
dekrementira izvornu lokaciju; sintetički test (seed u magacin → izdaj na mašinu) je
pao na check-constraint (negativna zaliha) jer stvarni model verovatno seeduje rezni na
DRUGU lokaciju (mašina/alat-specifičnu), ne magacin. BE defaultuje `source_location_id`
na ALAT-MAG-01 i mapira grešku na 422 (čist error, ne 500), ali **tok izdavanja reznog
treba proći sa Nenadom kad se unese realni katalog** (koja lokacija je izvor). Ručni alat
(TOOL/COOPERATION) tok je potpuno dokazan na živoj bazi (REV-TOOL-2026-0027).

## Preostalo (opciono, Nenad)
- Uvoz postojećih reversa (bulk tip 3) + rezni katalog (tip 2) — sada samo ručni alat (tip 1).
- Skener „za povraćaj" (skeniraj alat → nađi otvoren revers) — sada je skener u „Izdaj".
- Početno smeštanje uvezenog alata u magacin (loc placement) — sada je alat odmah upotrebljiv iz null lokacije.

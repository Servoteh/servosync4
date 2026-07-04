# Profil kompleksnosti — ServoSync 1.0 (servoteh-plan-montaze)

> Izvor: read-only multi-agent analiza (complexity-profile workflow, 8 agenata), 2026-07-03. Objedinjeno iz 7 dimenzionih profila. Cifre iz različitih izvora se blago razlikuju (mereno u različito vreme) — dat je „živi" broj kad postoji.

## 1. Ukupni obim

### Frontend / prezentacija + logika (src/)
| Sloj | Fajlovi | LOC |
|---|---|---|
| src/ui/ (UI moduli) | 267 .js | 111.077 |
| src/state/ | 8 | 3.118 |
| src/lib/ (helperi + PDF + format) | 66 | 10.809 |
| src/services/ (data-access nad Supabase) | 83 | 25.874 |
| src/styles/ (CSS) | 15 | 28.787 |
| **UKUPNO** | **~342 JS + 15 CSS** | **~151K JS + 29K CSS** |

- Logički moduli: ~19; Framework: **nema** (vanilla JS, 1.152 innerHTML dodela u 213 fajla).
- Najveći monoliti: 2.000–3.061 LOC/fajl (lokacije, mojProfil, kadrovska, odrzavanjeMasina).

### Servisni / data-access sloj
- 83 fajla, ~25.874 LOC; 69 zove `sbReq*`, 14 helperi. Choke-point: `supabase.js` (348 LOC).
- **~753 data-access poziva** (650 sbReq + 94 sbReqThrow + 9 sbReqWithCount); ~612 PostgREST filter-operatora.
- 26 UI fajlova zaobilazi servise (leaky: kadrovska *Tab.js + mobile my*).

### Baza (živo stanje)
| Metrika | Živo | Kumulativno |
|---|---|---|
| Tabele | 140 | 151–263 CREATE |
| View-ovi | 67 | 56–122 |
| **RLS politike** | **293** | ~530–818 (589–614 DROP — visok churn) |
| SECURITY DEFINER fn | 238 | 436–676 |
| Distinct DB fn | ~271–392 | 412–727 |
| Trigeri | ~132–200 | 137–151 |
| RAISE EXCEPTION (poslovna pravila) | — | 473 |

### Migracije, edge, testovi
- `sql/migrations`: 337 .sql / 57.784 LOC + paralelno `supabase/migrations` 172 / 32.290 LOC. Praktično forward-only (samo 4+14 down). 65–67 manual skripti.
- Edge: 12 Deno fn / ~3.659 LOC; pg_cron 17–26; 5 outbox tabela; realtime 1 tabela (work_hours); offline queue ~424 LOC.
- Native: Capacitor android/ios, 8 plugina, ~7.332 LOC mobile UI; PWA + APK + iOS.
- Eksterni API: Resend, Anthropic, WhatsApp Graph v20, Web Push VAPID, FCM v1.
- Testovi: 61 vitest / ~582–641 it(); 29 pgTAP / ~324–352 asertacija (25/29 RLS+JWT).

## 2. Širina vs dubina — **dominantno DUBINA**

- **Širina** je u frontendu (~19 modula, 342 fajla, 125K LOC prezentacije) — ali „plitka" i mehanički portabilna (statičan Vite SPA bez frameworka).
- **Dubina** je u bazi: aplikacija je **backend-in-the-database**. Autorizacija (293 RLS + 238 DEFINER), API (PostgREST + 130–271 RPC), poslovna pravila (473 RAISE), transakcione invarijante, scheduling (pg_cron), integracije (pg_net/edge), storage-authz — sve živi u Postgres/Supabase sloju, ne u JS-u. `sbReq` je tanak; ono što zove je gusto.
- **Gde je OBOJE:** kadrovska i lokacije (široko u UI + duboko u bazi).

## 3. Najteži delovi za migraciju (rangirano)

1. **RLS → aplikativna autorizacija (najteži).** 293 žive politike su JEDINI authz sloj, vezane za `auth.jwt()`/`auth.uid()` koje on-prem PG nema. Prisma nema RLS i bori se sa per-request kontekstom (SET LOCAL van transakcije). Model nije 10 ravnih rola nego **rola × per-project × managed_departments nizovi × override flagovi** — kombinatorna eksplozija.
2. **Poslovna logika u bazi** (238 DEFINER RPC + 132–200 trigera + 473 exception). Transakciona atomičnost (reversi inventar, maint, payroll, loc) sa advisory lock-ovima i idempotencijom.
3. **Zamena PostgREST-a eksplicitnim endpointima** (~753 poziva, embedded select, count=exact paginacija, upsert merge).
4. **Orkestracija bez pg_cron/pg_net/Vault** (17–26 cron + 5 outbox sa SKIP LOCKED/backoff → NestJS scheduler + BullMQ/pg-boss).
5. **Auth (GoTrue → NestJS/Passport JWT)** — PKCE/refresh/passkeys utkano u sbReq wrapper i Admin API.
6. **Offline queue idempotencija (mobile)** — kadrOfflineQueue čuva PostgREST putanje; oslonjen na partial UNIQUE(client_event_uuid). Razlika u ugovoru = tihi duplikati u magacinu.
7. **Push pipeline** (Web Push VAPID + FCM v1 RS256 + APNs + token lifecycle).
8. **Realtime** (postgres_changes + setAuth → WS gateway ili LISTEN/NOTIFY).
9. **Storage** (Supabase signed URL → MinIO/S3 presigned + app-authz).

## 4. Lako vs Teško

**LAKO / mehanički:** prezentacija (statičan Vite SPA → Cloudflare Pages trivijalno); data model 1:1 (cilj ostaje Postgres, pg_dump → prisma db pull); ~40/61 vitest = izvrsna specifikacija čistih pravila (payroll, porez, datumi); edge kao poslovna logika + eksterni API = obični HTTP; native sloj sa `server.url` skoro netaknut; sva Supabase vezanost skoncentrisana u services/ (jedan sloj se prepravlja, ne 267 UI fajlova).

**TEŠKO / gradi se iznova:** ceo authz model (293 RLS + 238 DEFINER); transakcioni RPC-ovi; Supabase-native supstrat bez drop-in zamene (GoTrue, Storage, Realtime, pg_cron, pg_net, Vault, outbox); verifikacija (RLS test coverage sam tim označen **RED** — nema IDOR/privilege-escalation suite); dual migration system; hardkodovane Supabase reference (Workbox regex, VAPID key, capacitor server.url).

## 5. Ukupna ocena težine

| # | Dimenzija | Ocena |
|---|---|---|
| 1 | Frontend / UI | 4/5 |
| 2 | Podaci / RLS / RBAC | **5/5** |
| 3 | Servisni sloj | 4/5 |
| 4 | Edge / realtime / offline | 4/5 |
| 5 | SQL migracije / evolucija | **5/5** |
| 6 | Mobilna / PWA / native | 3/5 |
| 7 | Testovi / domenska pravila | 4/5 |
| | **UKUPNO** | **~4,5 → 5/5** |

**Objedinjena ocena: 5/5 (jedan od najtežih re-platforming-a), ali težina NIJE u veličini nego u arhitektonskom impedance-mismatch-u prema NestJS + Prisma + on-prem Postgres.**

- *Što NE diže preko 5:* cilj ostaje Postgres (data model 1:1, single-tenant), prezentacija trivijalna za novi hosting, sva vezanost u jednom servisnom sloju, mali realtime/offline footprint, RBAC_MATRIX.md daje čist snapshot, ~582 vitest testa = gotova specifikacija.
- *Što drži na 5:* baza je de-facto backend — authz/API/pravila/scheduling/integracije/storage žive u Supabase primitivima bez Prisma ekvivalenta. Ili zadržati raw SQL (dual sistem, Prisma → $queryRaw), ili prepisati 300+ komada security-kritične logike.
- **Ključni skriveni rizik:** frontend danas **implicitno veruje bazi** (RLS) da enforce-uje bezbednost; UI helperi su kozmetika. NestJS zahteva rebuild kompletne autorizacije + re-validaciju end-to-end — skuplje nego što broj UI fajlova sugeriše, a uz RED test coverage regresiju je teško dokazati.

**Za poređenje sa QBigTehn:** ServoSync 1.0 je široka aplikacija (~180K LOC, 19 modula, 140 tabela) čiji rizik NIJE proporcionalan LOC-u nego koncentraciji nemapabilne Supabase-native logike (293 RLS + 238 DEFINER + orkestracija). Mehanički deo (frontend, data model, čiste funkcije) je velik ali predvidiv; nemehanički deo (authz rebuild, transakcioni RPC, orkestracija, auth) je manji po obimu ali nosi većinu rizika i truda.

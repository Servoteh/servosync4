# SSO + modul „Tehnologija" — 2.0 kao iframe modul u ServoSync 1.0 shell-u

> **Status: ŽIVO NA PRODU od 10.07.2026** (potvrdio Nenad u browseru). Ovaj dokument je vodič za
> svakoga ko dorađuje 2.0 a mora da zna kako je aplikacija embed-ovana i kako SSO radi.
> Širi kontekst plana spajanja: [MIGRACIJA_3.0_PLAYBOOK.md](MIGRACIJA_3.0_PLAYBOOK.md) §2.1.

## Slika sveta

- **1.0 shell** (`servosync.servoteh.com`, Vite/vanilla, repo `servoteh-plan-montaze`) ima HUB karticu
  **📐 Tehnologija** → ruta `/tehnologija` → **iframe ka `https://servosync2.servoteh.com`** (ceo naš front).
- **1.0 backend je od 10.07 on-prem** (`api.servosync.servoteh.com` → sy15 stack na ubuntusrv, GoTrue+PostgREST) —
  isti server kao naš backend. Cutover detalji: 1.0 repo `infra/self-host/CUTOVER_1.5.md`.
- Smer 3.0 NEPROMENJEN: 1.0 moduli se dugoročno prepisuju NA 2.0 stack; 1.0 shell je privremeni ulaz.

## SSO protokol (postMessage handoff)

Korisnik se loguje JEDNOM u 1.0; u modul ulazi bez kucanja ako ima **AKTIVAN 2.0 nalog sa istim email-om**.

```
iframe (mi, bez sesije)  ──  {type:'ss2-sso-ready'}          ──►  parent (1.0)
parent (1.0)             ──  {type:'ss2-sso-token', token}   ──►  iframe   (token = 1.0 GoTrue access JWT)
mi: POST /api/auth/sso {token} → {accessToken, user} → setToken + prime ['me'] → guardovi se sami re-evaluiraju
```

- **Origin provere u OBA smera.** Dozvoljeni parent origin-i (frontend `src/lib/auth-context.tsx`,
  `SSO_PARENT_ORIGINS`): `https://servosync.servoteh.com` + `http://192.168.64.28:8090` (1.0 LAN fallback).
  1.0 strana proverava naš origin + `event.source === iframe.contentWindow`.
- Van iframe-a ili sa postojećom sesijom = no-op. 401 sa `/auth/sso` = ćutke ostaje običan login ekran.
- Browser **particioniše storage u cross-origin iframe-u** → sesija u iframe-u je odvojena od sesije u
  zasebnom tabu (svaka se SSO-uje za sebe; to je očekivano).

## Šta je gde u kodu

| Strana | Fajl | Šta |
|---|---|---|
| BE (ovaj repo) | `src/modules/auth/auth.service.ts` → `ssoLogin()` | `jwt.verifyAsync(token, {secret: SY15_JWT_SECRET, algorithms:['HS256']})` → lookup po `payload.email` (`users.email` unique, mora `active`) → potpis NAŠEG tokena identično `login()` |
| BE | `src/modules/auth/auth.controller.ts` → `@Post('sso')` | bez guarda (kao `/login`), ručna validacija body-ja |
| FE (frontend repo) | `src/api/auth.ts` → `ssoExchange()` | POST `/auth/sso` |
| FE | `src/lib/auth-context.tsx` | handshake effect u `AuthProvider` (mount: ako iframe && bez tokena → `ss2-sso-ready`; listener za `ss2-sso-token`) |
| 1.0 repo | `src/ui/tehnologija/index.js` | iframe + parent strana bridge-a (listener u render, skida se u teardown) |

## Konfiguracija / tajne

- **`SY15_JWT_SECRET`** = `JWT_SECRET` sy15 GoTrue stacka (na serveru: `~/servosync15/.env`, vlasnik admnenad).
  Postavljen u **`/home/admluka/servosync/backend.env`** (fajl je admnenad-ov, u compose `env_file`).
  Prazno = SSO isključen (endpoint vraća 401). Dokumentovano u `.env.example`.
- Autorizacija je NAMERNO „postojanje aktivnog 2.0 naloga" — role/permisije ostaju naše (`users.role`).
  Novi tehnolog dobija SSO prostim kreiranjem 2.0 naloga (lozinka mu ne treba — random). **Zajednički
  nalozi (`tehnologija@`) NEMAJU SSO** — matching je po ličnom email-u iz 1.0 tokena.

## Infra lekcije (10.07 — da se ne ponove)

1. **`api.servosync2.servoteh.com` NIJE POSTOJAO u DNS-u** do 10.07 — API je van LAN-a bio mrtav, niko nije
   primetio jer interno front bira `http://<host>:3000/api`. Sada: ruta u **`servosync2` cloudflared tunelu**
   (Zero Trust → Tunnels → servosync2 → Published application routes → `api.servosync2.servoteh.com` →
   `http://localhost:3000`). **530 + telo „1033" = ruta dodata na pogrešan/mrtav tunel** (obriši CNAME pa
   dodaj na tunelu koji je HEALTHY).
2. **Deploy backend** = push na `main` → GitHub Actions self-hosted runner NA serveru (rsync → compose build
   → migrate → `up -d backend`; paths filter `src/**` — docs ne okidaju deploy). **Deploy frontend** =
   `npm run deploy` (next build + `wrangler deploy`, LOKALNO; živi front je **Worker `servosync2`**, ne Pages).
3. Radne kopije oba 2.0 repoa stoje na `feat/wave-3` — za prod izmene koristiti **worktree sa `origin/main`**
   (SSO je tako i isporučen: be `bbb1b82`, fe `3872316`).
4. **NE dodavati `X-Frame-Options` ni CSP `frame-ancestors` bez allowlist-a** — slomilo bi embed. Ako se
   security headeri ikad uvedu: `frame-ancestors 'self' https://servosync.servoteh.com http://192.168.64.28:8090`.

## Test recepti

```bash
# endpoint živ (očekuj 401):
curl -s -X POST https://api.servosync2.servoteh.com/api/auth/sso -H 'Content-Type: application/json' -d '{"token":"x"}'

# pun E2E bez browsera — mintuj 1.0-kompatibilan token na ubuntusrv (deljeni secret) pa zameni:
ssh ubuntusrv
cd ~/servosync15
b64url(){ openssl base64 -A | tr '+/' '-_' | tr -d '='; }
S=$(grep '^JWT_SECRET=' .env | cut -d= -f2-); N=$(date +%s); E=$((N+600))
H=$(printf '{"alg":"HS256","typ":"JWT"}'|b64url)
P=$(printf '{"role":"authenticated","aud":"authenticated","email":"nenad.jarakovic@servoteh.com","sub":"t","iat":%s,"exp":%s}' $N $E|b64url)
SG=$(printf '%s' "$H.$P"|openssl dgst -sha256 -hmac "$S" -binary|b64url)
curl -s -X POST http://localhost:3000/api/auth/sso -H 'Content-Type: application/json' -d "{\"token\":\"$H.$P.$SG\"}"
```

## TODO / dalji koraci

- [ ] Rate-limit / audit log na `/auth/sso` (sada se oslanja samo na potpis+exp).
- [ ] `frame-ancestors` allowlist (v. lekciju 4) kad se uvedu security headeri.
- [ ] Lični 2.0 nalozi za preostale tehnologe (SSO umesto zajedničkog `tehnologija@`).
- [ ] Kasnija opcija: same-origin varijanta (`servosync.servoteh.com/tehnologija` + `basePath`) — v. playbook §2.1.

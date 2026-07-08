# ServoSync 2.0 — deploy (frontend na Cloudflare Pages, backend on-prem iza Tunnel-a)

> Stanje 2026-07-08. Odluke i „ko šta radi" su na kraju.

## Arhitektura

| Deo | Hostname | Gde |
|---|---|---|
| Front (login + app) | `servosync2.servoteh.com` | Cloudflare Pages, projekat **`servosync2`** (`servosync2.pages.dev`) |
| Backend API | `api.servosync2.servoteh.com` | Cloudflare Tunnel → on-prem `192.168.64.28:3000` |

- Zona `servoteh.com` je na Cloudflare-u (nalog `nenad.jarakovic@servoteh.com`, ID `e2f616e00cb68d6485f93a6be4dfb14b`).
- 1.0 ostaje netaknut na `servosync.servoteh.com` (Pages projekat `servoteh-servosync`) — radi paralelno.
- Front je **static export** (`output: "export"` u `next.config.ts`) jer je app 100% client-side
  (token u localStorage + TanStack Query). Nema SSR-a, nema Workers adaptera.

## Frontend — build i deploy

Iz `frontend/`:

```bash
# 1) API URL za produkciju (već postoji frontend/.env.production):
#    NEXT_PUBLIC_API_URL=https://api.servosync2.servoteh.com/api
# 2) build + deploy na Pages:
npm run deploy      # = next build (→ out/) + wrangler pages deploy out --project-name=servosync2
```

- `NEXT_PUBLIC_API_URL` se **bake-uje u build** (client JS), pa promena URL-a traži novi build.
- Direct-upload deploy (gornja komanda) je za „odmah". Dugoročno: povezati GitHub repo na Pages projekat
  (auto-deploy na push), isto kao 1.0. Tada se `NEXT_PUBLIC_API_URL` postavlja kao Pages build env var.
- Autentikacija: wrangler koristi keširani OAuth token (`wrangler whoami`). Token ima `pages:write`.

### Status (2026-07-08)
- ✅ Projekat `servosync2` kreiran, deploy uspešan.
- ✅ Login forma živa: **https://servosync2.pages.dev/login** i **https://servosync2.servoteh.com/login** (HTTP 200, cert **active**).
- ✅ Oba DNS CNAME zapisa napravljena (proxied).
- ✅ Tunel `servosync2` (id `f4ef24cf-0292-4a8b-aa8a-15126f6e199a`) kreiran + ingress `api.servosync2.servoteh.com → http://localhost:3000`.
- ⏳ Preostaje: pokrenuti `cloudflared` na serveru (192.168.64.28) sa tunnel tokenom → tada backend postaje dostupan na `api.servosync2.servoteh.com` i login autentifikuje.

### DNS zapisi (napravljeni)
| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `servosync2` | `servosync2.pages.dev` | 🟠 |
| CNAME | `api.servosync2` | `f4ef24cf-0292-4a8b-aa8a-15126f6e199a.cfargotunnel.com` | 🟠 |

## Preostali DNS zapisi (traže `dns_records:edit` — wrangler OAuth ga NEMA)

Oba se prave u Cloudflare dashboard-u (DNS → Records) ili API-jem sa DNS-scoped tokenom:

1. **Front:** `servosync2` **CNAME** → `servosync2.pages.dev` (proxied / narandžasti oblak).
   Najlakše: Pages → `servosync2` → *Custom domains* → domen `servosync2.servoteh.com` je već „pending",
   klik na *Set up / Activate* sam napravi ovaj zapis.
2. **Backend (posle tunela):** `api.servosync2` **CNAME** → `<TUNNEL_ID>.cfargotunnel.com` (proxied).
   Ako se tunel/hostname pravi kroz dashboard (Zero Trust → Networks → Tunnels → Public hostname), ovaj
   zapis se napravi automatski.

## Backend — Cloudflare Tunnel (radi se na serveru 192.168.64.28)

Backend NE izlažemo direktno; `cloudflared` na serveru cilja `http://localhost:3000`.

**Opcija A — token (preporuka, bez browsera na serveru):**
1. Napraviti tunel (dashboard: Zero Trust → Networks → Tunnels → Create, ili API) i uzeti **tunnel token**.
2. Dodati Public hostname: `api.servosync2.servoteh.com` → service `http://localhost:3000`
   (time se pravi i DNS CNAME iz tačke 2 gore).
3. Na serveru (ima ga `admluka` preko SSH; Docker bez sudo-a) — kao Docker servis u compose-u:
   ```yaml
   cloudflared:
     image: cloudflare/cloudflared:latest
     command: tunnel --no-autoupdate run --token ${CF_TUNNEL_TOKEN}
     restart: unless-stopped
     network_mode: host   # da vidi localhost:3000; ili u istoj mrezi → service http://backend:3000
   ```
   ili kao host servis:
   ```bash
   sudo cloudflared service install <CF_TUNNEL_TOKEN>
   ```

**Opcija B — interaktivno na serveru:** `cloudflared tunnel login` (browser prijava na CF nalog) →
`cloudflared tunnel create servosync2` → `cloudflared tunnel route dns servosync2 api.servosync2.servoteh.com`
→ `config.yml` sa ingress `http://localhost:3000` → `cloudflared service install`.

Provera kad tunel proradi: `curl https://api.servosync2.servoteh.com/api` → health backend-a (bez auth-a).

## CORS / auth napomene
- Backend CORS je `origin: true` — prima front sa bilo kog origin-a, ne treba podešavati po domenu.
- Login šalje `POST /api/auth/login`, token ide u **localStorage** (Bearer), ne cookie — nema
  cross-site cookie problema između `servosync2.servoteh.com` i `api.servosync2.servoteh.com`.
- Cloudflare Access: ako se kasnije stavi na `api.*`, mora da propušta `POST /api/auth/*` (ili se API drži
  bez Access-a, uz JWT kao jedinu zaštitu). Trenutno nema Access politike na ovim hostname-ovima.

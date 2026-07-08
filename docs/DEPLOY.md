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

## LAN pristup / offline fallback (jedan build, bez rebuild-a)

Front bira API base **u runtime-u u browseru** ([../src/api/client.ts](../src/api/client.ts)), pa **isti
`out/` build** radi i kroz Cloudflare i direktno na LAN-u. Kad internet padne (ili terminal nema izlaz na
net), LAN put i dalje radi jer ne prolazi kroz Cloudflare edge — server (backend + PostgreSQL) rade lokalno.

**Kako se bira API:**

| Front otvoren na… | API base | Put |
|---|---|---|
| `servosync2.servoteh.com`, `*.pages.dev` | `https://api.servosync2.servoteh.com/api` | kroz Cloudflare Tunnel |
| LAN IP/hostname, npr. `http://192.168.64.28` | `http://<isti-host>:3000/api` | direktno na backend (LAN) |
| `localhost:3001` (dev) | `http://localhost:3000/api` | lokalni backend |

Redosled odlučivanja: `window.__SERVOSYNC_API_URL__` (override iz `/config.js`) → izvođenje iz adrese
(tabela gore) → build-time `NEXT_PUBLIC_API_URL` (samo bez window-a) → `localhost:3000`.

**Serviranje fronta sa LAN-a (na Ubuntu serveru 192.168.64.28 koji već vrti backend).**

⚠️ `out/` fizički NE postoji na serveru (front ide na Cloudflare, ne na Ubuntu), a **prod compose nije u
git-u** — živi kao `~/servosync/docker-compose.yml` pod `admluka` home-om (vidi
[INFRASTRUKTURA.md §5](../../backend/docs/infra/INFRASTRUKTURA.md)). Zato se `front-lan` dodaje **ručno na
serveru** (interaktivni SSH; docker traži sudo za `admnenad`/`admluka`). Build ide iz frontend repoa kroz
[../Dockerfile](../Dockerfile) (nginx služi `out/`), pa nije potreban Node na hostu.

Jednokratno + servis (na serveru, interaktivno):

```bash
ssh ubuntusrv
cd ~/servosync
git clone https://github.com/servosync/frontend.git frontend      # jednom (build kontekst)
# u ~/servosync/docker-compose.yml dodaj servis:
```
```yaml
  front-lan:
    build:
      context: ./frontend        # gore kloniran frontend repo
    image: servosync-front-lan
    ports:
      - "8080:80"                # LAN: http://192.168.64.28:8080
    restart: unless-stopped
```
```bash
sudo docker compose up -d --build front-lan
curl -I http://localhost:8080                                      # provera
```

Kasnije osvežavanje fronta: `cd ~/servosync/frontend && git pull && sudo docker compose up -d --build front-lan`.

Klijenti otvaraju `http://192.168.64.28:8080` — front sam izvede API na `http://192.168.64.28:3000/api`.
**Bez izmene koda i bez rebuild-a fronta na Cloudflare-u.** (Alternativa bez Dockerfile-a: `npx serve out -l 8080`
uz prethodno prekopiran `out/` na server.)

**Preduslovi / napomene:**
- Backend sluša na `0.0.0.0:3000`, port otvoren na LAN-u, CORS `origin: true` → LAN origin prihvaćen bez podešavanja.
- LAN je plain **http** (bez cert-a) — OK za ovaj fetch/localStorage app; nema secure-context feature-a.
- Token je u `localStorage` **po origin-u** → prelazak Cloudflare↔LAN znači zasebnu prijavu.
- **Za rad app-a internet NE treba** (backend + PG lokalno). Internet treba samo `cloudflared` tunelu i
  GitHub deploy-u — ne i pokrenutoj aplikaciji.
- **Override** (ako front i backend nisu na istoj mašini / poseban host): odkomentariši
  `window.__SERVOSYNC_API_URL__` u posluženoj kopiji [`out/config.js`](../public/config.js) na LAN serveru —
  menjaš samo taj jedan fajl, Cloudflare kopija ostaje prazna.

## CORS / auth napomene
- Backend CORS je `origin: true` — prima front sa bilo kog origin-a, ne treba podešavati po domenu.
- Login šalje `POST /api/auth/login`, token ide u **localStorage** (Bearer), ne cookie — nema
  cross-site cookie problema između `servosync2.servoteh.com` i `api.servosync2.servoteh.com`.
- Cloudflare Access: ako se kasnije stavi na `api.*`, mora da propušta `POST /api/auth/*` (ili se API drži
  bez Access-a, uz JWT kao jedinu zaštitu). Trenutno nema Access politike na ovim hostname-ovima.

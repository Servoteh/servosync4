# Instalacija i servis — SCADA aplikacija

Postavljanje na **Win2019 VM** kao Windows servis + pristup spolja preko Cloudflare.
Sažetak; pun postupak je u [`deploy/DEPLOY.md`](../../deploy/DEPLOY.md).

> Obrazac je isti kao `servoteh-bridge` (Windows servis na `C:\Servoteh\...`).

## Preduslovi

- Node.js **≥ v20** na VM-u.
- VM mora **videti PLC** na mreži `192.168.64.0/19`:
  ```powershell
  node --version
  Test-NetConnection 192.168.75.25 -Port 502    # TcpTestSucceeded = True
  ```
  Ako `502` ne prolazi → reši mrežu/bridge pre nastavka.

## 1) Backend kao Windows servis

```powershell
mkdir C:\Servoteh -ErrorAction SilentlyContinue
cd C:\Servoteh
git clone <repo-url> Scada_PLC          # ili kopiraj folder
cd C:\Servoteh\Scada_PLC\app

copy .env.example .env
notepad .env
#   SIMULATE=false
#   PLC_IP=192.168.75.25
#   (opciono) ALERT_TELEGRAM_BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID

npm install --omit=dev

# SMOKE TEST (pre servisa) — samo čita PLC:
npm run test:connection      # mora: "VEZA OK" + očitane vrednosti
node server.js               # otvori http://localhost:3000 ; Ctrl+C za stop

# INSTALACIJA SERVISA (PowerShell KAO ADMINISTRATOR):
npm run service:install
Get-Service "Kotlarnica SCADA"   # Status: Running
```

Servis se sam diže na boot i restartuje ako padne.
Logovi: **Event Viewer → Applications and Services Logs → „Kotlarnica SCADA"**.

## 2) Konfiguracija (`.env`)

| Varijabla | Default | Opis |
|---|---|---|
| `SIMULATE` | `false` | `true` = lažni podaci (razvoj), **na produkciji mora `false`** |
| `PLC_IP` | `192.168.75.25` | IP Unitronics PLC-a |
| `PLC_PORT` | `502` | PCOM/TCP port |
| `PLC_UNIT` | `1` | Unit ID PLC-a |
| `HTTP_PORT` | `3000` | Web port |
| `ALERT_TELEGRAM_BOT_TOKEN` | — | (opciono) Telegram alarmi |
| `ALERT_TELEGRAM_CHAT_ID` | — | (opciono) odredište alarma |
| `BLUELOG_*`, `SIGEN_*`, `LOXONE_*` | — | (opciono) integracije, vidi [`app/README.md`](../../app/README.md) |

## 3) Cloudflare Tunnel + Access (pristup spolja)

Skraćeno (pun postupak u `deploy/DEPLOY.md`):

```powershell
winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create kotlarnica
# config.yml: upiši TUNNEL-ID i hostname (npr. kotlarnica.<domen>)
cloudflared tunnel route dns kotlarnica kotlarnica.<domen>
cloudflared tunnel run kotlarnica        # test
cloudflared service install              # auto-start
```

**Access (prijava):** Cloudflare dashboard → Zero Trust → Access → Applications →
Add (Self-hosted) → domain `kotlarnica.<domen>` → Policy Allow → dozvoljeni e-mailovi
(operateri). Od tada stranica traži prijavu.

## 4) Update koda kasnije

```powershell
Stop-Service "Kotlarnica SCADA"
cd C:\Servoteh\Scada_PLC
git pull
cd app
npm install --omit=dev
Start-Service "Kotlarnica SCADA"
```

Deinstalacija servisa: `npm run service:uninstall` (admin).

## Pravila (bezbednost / pouzdanost)

1. **Tačno JEDAN** servis ka PLC-u (PLC dozvoljava 1 TCP vezu). Ne pokretati na dve mašine.
2. VM po mogućstvu na **UPS-u** (kao i PLC).
3. Upis (komande, režimi, setpoint) menja PLC **uživo** — UI traži potvrdu.
4. Na produkciji `SIMULATE=false`. Ako UI piše „SIMULACIJA" → ne gleda pravi PLC.

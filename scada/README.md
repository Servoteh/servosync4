# Kotlarnica SCADA (zamena za ZView)

Sopstvena web aplikacija za nadzor i upravljanje kotlarnicom (Unitronics **JZ20-J-T40**)
preko **PCOM/TCP** (isti protokol kao stari ZView/`drvjazz`) na **192.168.75.25:502**.
PLC ne treba menjati. Bez Supabase, bez baze — istorija je lokalni JSON.

## Arhitektura
```
[PLC] —PCOM(1 veza)— [Win2019 VM: Node servis = web + PCOM master] —cloudflared→ [Cloudflare + Access] → korisnici
```
Jedan servis drži **jednu** PCOM vezu; svi korisnici idu preko njega (WebSocket). Pristup
spolja preko Cloudflare Tunnel + Access (prijava). Detaljan deploy: [`../deploy/DEPLOY.md`](../deploy/DEPLOY.md).

## Pokretanje
```powershell
cd app
npm install
# UŽIVO (pravi PLC) — podrazumevano:
npm start
# SIMULACIJA (bez PLC-a, razvoj):
$env:SIMULATE="true"; npm start
```
→ http://localhost:3000

## Konfiguracija (`.env` ili env vars)
`SIMULATE, PLC_IP, PLC_PORT, PLC_UNIT, HTTP_PORT, ALERT_TELEGRAM_BOT_TOKEN, ALERT_TELEGRAM_CHAT_ID` (vidi `.env.example`).

## Kao Windows servis (na VM-u)
```powershell
npm run service:install     # PowerShell kao Administrator
npm run service:uninstall
```

## Fajlovi
- `server.js` — PCOM master, REST (`/api/state`, `/api/write`, `/api/history`), WebSocket, alarmi, istorija.
- `pcom.js` — Unitronics PCOM/TCP klijent (RW/RB/RE/RA, SW/SB/SA).
- `tags.js` — mapa tagova (operand → tip → skala → zona).
- `history.js` — lokalna istorija (24h) → `data/history.json`.
- `notifier.js` — Telegram alarmi (opciono).
- `service/` — node-windows install/uninstall.
- `public/` — web UI (glassmorphism, sinoptik, toggle prekidači, trendovi).
- `test-connection.js` — PCOM smoke test.

## Funkcije
- Sinoptik postrojenja, zone sa temp/setpoint, kaloriferi/pumpe (status RADI/STOJI), animacija.
- **Režimi** GREJANJE/HLAĐENJE (MB26) i AUTO/RUČNO (MB14) — čita živo + menja uz potvrdu.
- **Ručne komande** K1–K5 / P1–P4 (MB8–12 / MB16–19) kao toggle prekidači.
- **Raspored** PON-PET / SUB-NED (satnice BCD) + aktivni dani.
- **Trendovi** (24h), **alarmi** + Telegram, **reset** greške frekventnog.

## Solarna elektrana — blue'Log (FNE SERVOTEH, ~312 kW)
Read-only integracija PV elektrane preko **meteocontrol blue'Log X-Control** (lokalni REST koji
koristi web "cockpit"). 6× KACO blueplanet 50 TL3 + Janitza UMG 96RM. **Nezvaničan** API — pri
firmware update-u loggera proveri rute: `npm run bluelog:discover`.

```powershell
# u app/.env:  BLUELOG_HOST=192.168.75.15  BLUELOG_USER=FNEServoteh  BLUELOG_PASS=<malim slovima>
npm run bluelog:discover     # prijavi se + izvuče uređaje/oblike -> data/bluelog-structure.json
npm start                    # poller se diže ako je BLUELOG_HOST zadat; podaci na /api/bluelog + WS type:'bluelog'
```
- `bluelog/bluelog.js` — klijent: prijava (MD5 lozinka + CSRF), `getDevices`, `getDeviceValues`/`latestValues` (`POST /device/values`, dateRange u **epoch ms**).
- `bluelog/bluelogtags.js` — tag-mapa + `normalize`: snaga postrojenja = suma `P_AC` invertora; dnevni prinos = suma `E_DAY`; po invertoru `P_AC/P_DC/E_DAY/T`.
- `bluelog/discover.js` — `npm run bluelog:discover`.
- Modbus TCP (čist, zvaničan) bi tražio meteocontrol SCADA licencu **557.009** (na ovom uređaju `scada=false`).

> ⚠️ Upis menja PLC uživo. Čitanje je bezbedno; svaki upis traži potvrdu u UI.

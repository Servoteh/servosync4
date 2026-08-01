# Deploy — Kotlarnica SCADA (Win2019 VM + Cloudflare)

Sve je spremno; ostaje samo izvršiti korake na VM-u i povezati Cloudflare.
Obrazac je isti kao `servoteh-bridge` (Windows servis na `C:\Servoteh\...`).

> Arhitektura: **jedan** Node servis na VM-u drži **jednu** PCOM vezu ka PLC-u i
> služi web UI. Pristup spolja = **Cloudflare Tunnel** (izlazna veza, bez port-forwarda)
> + **Cloudflare Access** (prijava). Bez Supabase, bez baze (istorija = lokalni JSON).

---

## FAZA 0 — Provera (na VM-u, OBAVEZNO prvo)
```powershell
node --version                                   # >= v20
Test-NetConnection 192.168.75.25 -Port 502       # TcpTestSucceeded = True (VM vidi PLC)
```
Ako `502` ne prolazi → VM nije na mreži PLC-a (`192.168.64.0/19`). Reši mrežu/bridge pre nastavka.

---

## FAZA 1 — Backend kao Windows servis
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

# SMOKE TEST (pre servisa):
npm run test:connection      # mora: "VEZA OK" + očitane vrednosti
node server.js               # otvori http://localhost:3000 ; Ctrl+C za stop

# INSTALACIJA SERVISA (PowerShell KAO ADMINISTRATOR):
npm run service:install
Get-Service "Kotlarnica SCADA"   # Status: Running
```
Servis se sam diže na boot i restartuje ako padne. Logovi servisa: Event Viewer →
Applications and Services Logs → "Kotlarnica SCADA".

Update koda kasnije:
```powershell
Stop-Service "Kotlarnica SCADA"; cd C:\Servoteh\Scada_PLC; git pull
cd app; npm install --omit=dev; Start-Service "Kotlarnica SCADA"
```
Deinstalacija: `npm run service:uninstall` (admin).

---

## FAZA 2 — Cloudflare Tunnel + Access
Preduslov: domen u tvom Cloudflare nalogu.

```powershell
# 1) instaliraj cloudflared
winget install --id Cloudflare.cloudflared
# 2) prijava (otvori browser, izaberi domen)
cloudflared tunnel login
# 3) napravi tunel
cloudflared tunnel create kotlarnica
#    -> ispiše TUNNEL-ID i putanju do <ID>.json ; premesti json u C:\Servoteh\.cloudflared\
# 4) config
mkdir C:\Servoteh\.cloudflared -ErrorAction SilentlyContinue
copy C:\Servoteh\Scada_PLC\deploy\cloudflared\config.example.yml C:\Servoteh\.cloudflared\config.yml
notepad C:\Servoteh\.cloudflared\config.yml      # upiši TUNNEL-ID i hostname (npr. kotlarnica.tvoj-domen.rs)
# 5) DNS zapis
cloudflared tunnel route dns kotlarnica kotlarnica.tvoj-domen.rs
# 6) test
cloudflared tunnel run kotlarnica                 # pa otvori https://kotlarnica.tvoj-domen.rs
# 7) instaliraj cloudflared kao servis (auto-start)
cloudflared service install
```

**Cloudflare Access (prijava) — u Cloudflare dashboard:**
Zero Trust → Access → Applications → Add application → Self-hosted →
- domain: `kotlarnica.tvoj-domen.rs`
- Policy: Allow → emails (npr. `nenad.jarakovic@servoteh.com` i ostali operateri)
Od tog trenutka stranica traži prijavu pre prikaza.

---

## FAZA 3 — već uključeno u kodu (ništa za connect)
- **Istorija/trendovi:** lokalno `app/data/history.json` (24h, 1 uzorak/min), prikaz u sekciji TRENDOVI.
- **Telegram alarmi:** popuni `ALERT_TELEGRAM_*` u `.env` (ili pri service:install) → alarm pumpe/zaštite stiže na Telegram.

---

## Pravila (bezbednost/pouzdanost)
1. **Tačno JEDAN** servis ka PLC-u (PLC dozvoljava 1 TCP vezu). Ne pokretati na dve mašine.
2. VM po mogućstvu na **UPS-u** (kao PLC).
3. Upis (komande, režimi, setpoint) menja PLC uživo — UI traži potvrdu; po želji dodati „samo operater piše".

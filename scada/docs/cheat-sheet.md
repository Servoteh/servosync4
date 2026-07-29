# 🔖 CHEAT SHEET — Kotlarnice i SCADA (Servoteh)

> Brza referenca za teren — sve najvažnije na jednom mestu. Detalji u [README.md](README.md).
> ⚠️ **Zlatno pravilo:** Unitronics Jazz dozvoljava **samo 1 TCP vezu** — pre rada U90 Ladder-om
> preko mreže **zaustavi SCADA servis** (`Stop-Service "Kotlarnica SCADA"`).

---

## 1. Pristupi (IP / login)

| Sistem | Adresa | Login | Kako |
|---|---|---|---|
| **SCADA web (lokalno)** | `http://localhost:3000` | — | bilo koji browser, na VM-u |
| **SCADA web (spolja)** | `https://kotlarnica.<domen>` | Cloudflare (email) | `[POTVRDITI domen]` |
| **Unitronics Jazz** | `192.168.75.25:502` | — | PCOM/TCP (preko SCADA app) |
| **Siemens Hala 5** | `192.168.75.12` ⚠️ (txt kaže `192.168.11.8`) | `admin` / `admin` | **samo Firefox** → `https://<ip>/awp/Servoteh/start.html` |
| **blue'Log (PV)** | `192.168.75.15` | `FNEServoteh` / `[POTVRDITI]` | lokalni REST (read-only) |

---

## 2. UNITRONICS — najvažniji operandi

**Temperature (MI, čitanje, ×10 → `235`=`23.5°C`):**
`MI20` spolja · `MI21` sud · `MI22` CNC · `MI23` zavarivanje · `MI24/25` montaža 1/2 · `MI26` hidraulika

**Zadate temperature / setpoint (MI, R/W):**

| Zona | Setpoint | Donji prag (=SP−3°C) |
|---|---|---|
| Spolja | `MI30` | — |
| Sud | `MI31` (H) / `MI32` (L) | — |
| Montaža | `MI33` | `MI34` |
| CNC | `MI35` | `MI36` |
| Hidraulika | `MI37` | `MI38` |
| Zavarivanje | `MI39` | `MI40` |

> Regulacija: **pali kad temp ≤ (zadata − 3°C), gasi na zadatoj** (histereza 3°C).

**Režimi (MB, R/W) — POTVRĐENO:**

| Komanda | Operand | Vrednosti |
|---|---|---|
| GREJANJE / HLAĐENJE | `MB26` | **`0` = GREJANJE · `1` = HLAĐENJE** |
| AUTO / RUČNO | `MB14` | uživo `0` (smer `[POTVRDITI]`) |
| Reset greške VFD | `O18` | momentary (impuls, sam se vrati na 0) |

**Ručne komande (MB toggle):**
Kaloriferi `K1–K5` = `MB8 · MB9 · MB10 · MB11 · MB12`
Pumpe `P1–P4` = `MB16 · MB17 · MB18 · MB19`

**Raspored:**
Satnice (BCD HH:MM): `MI60` PON-PET ON · `MI61` PON-PET OFF · `MI62` SUB-NED ON · `MI63` SUB-NED OFF
Aktivni dani (0/1): `MI50`–`MI56` (Pon→Ned)

**Statusi (I, čitanje):**
`I2` VFD radi · `I3` toplotna pumpa · `I6` kotao radi · `I15` glavni ON/OFF · `I16` P4 prekidač

**Alarmi:**
`I4` alarm pumpe · `I5` zaštite (zbirno) · `O16` alarmni izlaz (sirena/lampa)

**Izlazi (status, O):** kaloriferi `O0–O4` (K1–K5) · pumpe `O5–O7`+`O17` (P1–P4) · zonsko grejanje `O8–O14` (T1–T7)

---

## 3. SIEMENS Hala 5 — najvažnije

- **CPU:** S7-1200 **1214C** (`6ES7 214-1AG40-0XB0`, FW V4.4) + ET 200SP (PROFINET). Reguliše **hale 3–6**.
- **Nadzor:** samo web server (nema HMI panela) → **Firefox** → `https://192.168.75.12/awp/Servoteh/start.html`
- **Programski alat:** TIA Portal **v16**. Projekat u `TIA KOTLARNICA HALA 5/…/Termoregulacija hala TIA.ap16`.

**Ključni tagovi:**

| Šta | Adresa |
|---|---|
| Temp sud / Hala 3 / 4 / **5** / 6 / spolja | `%IW68` / `70` / `72` / `74` / `78` / `76` |
| Režim auto / ručno | `%M0.0` / `%M0.1` |
| Grejanje / hlađenje | `%M0.2` / `%M0.3` |
| Komanda kotla | `%Q2.0` |
| Pumpe P1–P4 | `%Q2.1`–`%Q2.4` |
| Kaloriferi K1–K15 | `%Q2.5`–`%Q3.6`, `%Q4.0`–`%Q4.4` |
| Tolerancija / pragovi | `%MW15` / `%MW20`/`%MW22` |
| Web STOP (E-stop) | `%M3.1` |

> Temperature su **Real °C** (bez ×10, za razliku od Unitronics). Integracija u SCADA app: **OPC UA** (preporuka) ili S7comm (port 102).

---

## 4. SCADA aplikacija — komande (PowerShell, na VM-u)

```powershell
# Status / start / stop servisa:
Get-Service "Kotlarnica SCADA"
Start-Service "Kotlarnica SCADA"
Stop-Service  "Kotlarnica SCADA"     # OBAVEZNO pre U90 Ladder preko mreže!

# Provera veze sa PLC-om:
Test-NetConnection 192.168.75.25 -Port 502     # TcpTestSucceeded = True

# Smoke test (samo čita PLC):
cd C:\Servoteh\Scada_PLC\app ; npm run test:connection

# Logovi uživo (ručno pokretanje):
Stop-Service "Kotlarnica SCADA" ; cd C:\Servoteh\Scada_PLC\app ; node server.js

# Update koda:
Stop-Service "Kotlarnica SCADA" ; cd C:\Servoteh\Scada_PLC ; git pull
cd app ; npm install --omit=dev ; Start-Service "Kotlarnica SCADA"
```

Logovi servisa: **Event Viewer → Applications and Services Logs → „Kotlarnica SCADA"**.

---

## 5. Brza dijagnostika

| Simptom | Prvo proveri |
|---|---|
| PLC „offline" u UI | `Test-NetConnection …502`; **dvostruka veza?** (U90 Ladder online / drugi servis) → ugasi višak |
| Zona se ne greje | PLC online? → AUTO + GREJANJE (`MB14`,`MB26`)? → raspored aktivan? → kotao/pumpa rade? |
| Uređaj ne reaguje | glavni ON/OFF (`I15`)? → fizički prekidač u ormaru (`I7–I14`)? → motorna zaštita |
| VFD greška | klik **Reset frekventnog** (`O18`); ako se vraća → čitaj kod na VFD displeju |
| Temp nerealna (−50/+300) | senzor/ožičenje (prekid ili kratak spoj) |
| Web radi lokalno, ne spolja | `Get-Service cloudflared`; Cloudflare Access policy; DNS |

---

## 6. Bezbednosna pravila (uvek)

1. ⚠️ **1 TCP veza** na Jazz → tačno jedan SCADA servis; zaustavi ga pre mrežnog rada U90 Ladder-om.
2. 💾 **Backup pre svake izmene** programa (`.U90` / TIA projekat) + upiši red u [servisni dnevnik](odrzavanje/servisni-dnevnik.md).
3. 🔄 Posle ručne intervencije **vrati na AUTO**.
4. ✍️ Svaki upis iz SCADA menja **živi PLC** — UI traži potvrdu; ne diraj registar ako ne znaš šta radi.
5. 🔋 PLC + VM na **UPS-u**. Na produkciji `SIMULATE=false`.

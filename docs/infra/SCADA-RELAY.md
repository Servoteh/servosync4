# SCADA relay — uputstvo (bridge + scada-app)

> **Kopija iz repoa `servoteh-bridge` (`docs/SCADA-RELAY.md`), preneta 2026-07-05** — kompletno
> uputstvo kako je SCADA tok urađen u ServoSync 1.0 eri. Živa verzija se održava u `servoteh-bridge`;
> ovde stoji kao referenca za 2.0 (posebno §Prelazak na Ubuntu — isti server je 2.0 prod cilj).

> Kako Energetika/SCADA modul u ServoSync-u dobija podatke i izvršava komande.
> Zapis stanja produkcione mašine: [INSTALACIJA-VM.md](INSTALACIJA-VM.md).
> Širi dizajn i istorija odluka: repo `servoteh-plan-montaze` → `docs/scada/`.

## Arhitektura

```
PLC-ovi / Loxone / blue'Log (LAN 192.168.75.x) + Sigen cloud
        │  (drajveri: PCOM, S7 AWP scrape, Loxone HTTP+WS, REST)
  scada-app  ─ servis "Kotlarnica SCADA", port 3000, lokalni API + LAN UI
        │  GET /api/state /api/s7 /api/loxone /api/bluelog /api/sigen
  bridge     ─ servis "Servoteh Bridge" (SCADA_ENABLED=true)
        ├─► scada_snapshots (5 s) + scada_history (60 s) + scada_alarms → Supabase
        └─◄ scada_claim_commands() poll (2 s) → allowlist → /api/*/write → uređaj
        │
  ServoSync (Cloudflare Pages) — desktop: originalni HMI ekrani u iframe-u
  (/scada-hmi/* + fetch-shim); mobilno: /m/energetika. RLS: admin + menadzment.
```

Bridge NIKAD ne priča direktno sa uređajima — sve ide kroz scada-app
(drajveri i validacija na jednom mestu), a bridge dodaje svoj drugi sloj:
allowlist + opsezi + rate-limit + trajni audit.

## Env varijable (bridge .env, SCADA sekcija)

| Var | Default | Značenje |
|---|---|---|
| `SCADA_ENABLED` | false | uključi SCADA petlje u scheduleru |
| `SCADA_BASE_URL` | http://127.0.0.1:3000 | lokalni API scada-app-a |
| `SCADA_SNAPSHOT_MS` | 5000 | upis snapshot-a + alarma |
| `SCADA_HISTORY_MS` | 60000 | uzorci istorije (min 60 s — ts poravnat na minut) |
| `SCADA_CMD_POLL_MS` | 2000 | poll komandi |
| `SCADA_CONTROL` | true | **kill-switch**: false = samo nadzor, komande se odbijaju |
| `SCADA_CMD_RATE_PER_MIN` | 10 | max izvršenih komandi/min po sistemu |
| `SCADA_HISTORY_RETENTION_DAYS` | 90 | brisanje stare istorije |
| `ENABLE_JOB_CATALOGS` / `ENABLE_JOB_PRODUCTION` | true | BigTehn jobovi (per-mašina profil; SCADA i SQL sync mogu zajedno) |

## Tok komande (bezbednost)

1. UI (admin/menadzment) → potvrda → INSERT `scada_commands` (`pending`; RLS: samo u svoje ime)
2. Bridge: RPC `scada_claim_commands()` — istekle pending (>2 min) → `expired`; zaglavljene `claimed` (>2 min, pad bridža) → `failed` („ishod nepoznat — NIJE ponovo izvršeno")
3. Kill-switch → **allowlist** (`src/scada/allowlist.js`) → rate-limit → izvršenje → `applied`/`failed` + `result`
4. Ako se bridge ne javi za ~15 s, UI komandu **otkaže** (`scada_cancel_command` RPC) — ne može da „procuri" i izvrši se naknadno
5. Sve trajno u `scada_commands` (ko, kad, šta, ishod — audit tab u modulu)

**Allowlist (v1):** kot1 SP_*/RK_*/AUTO_MAN/GREJ_HLAD/dani/satnice/RESET_VFD;
kot2 = Siemens whitelist MINUS **Web_Estop (daljinski E-stop namerno blokiran)**;
kot3 po stvarnom tagu iz Loxone strukture (writable + max); solar-sigen samo
operatingMode 0|5 (i samo ako scada-app ima SIGEN_CONTROL=true); KACO read-only.

## Alarmi i push

- Bridge diff-sync: novi alarm → INSERT, nestali → `active=false`, promenjen tekst/severity → UPDATE. Severity: 2=alarm, 3=upozorenje, 4=info.
- DB trigger `scada_alarm_push_aigt` → edge `push-dispatch` → web/native push svim admin/menadzment (podešavanja: `scada_notify_prefs`, default severity ≤ 3).
- Watchdog `scada_watchdog_every_5_min` (pg_cron): snapshot stariji od 5 min → alarm `BRIDGE_STALE` (+push). Kad se bridge vrati, sam ga očisti.
- Telegram: postojeći bridge notifier (greške jobova + primenjene komande, throttle 1 h).

## Dijagnostika

| Simptom | Proveri |
|---|---|
| UI baner „Bridge offline" | servis „Servoteh Bridge" na VM; log `logs\bridge-*.log` → `[scada] starting loops` |
| Sistem crven, bridge javlja | scada-app ne može do uređaja — `payload.error` u `scada_snapshots`; LAN/uređaj |
| Komanda `pending` → `expired` | bridge ne radi ili je komanda otkazana iz UI posle timeout-a |
| Komanda `rejected` | razlog u `result.error` (allowlist/opseg/rate-limit/kill-switch) |
| Loxone bez soba/temperatura | WS ka Miniserveru pao (`wsReady=false` → offline); LOXONE_PASS |
| Smoke test ručno | `npm run sync:scada` (jedan pass), `npm run sync:scada-commands` |

## Prelazak na Ubuntu server (kad dođe vreme)

Sve je čist Node — radi na Linuxu bez izmena koda. Razlike:

1. **Servisi** = systemd umesto node-windows/winsw:

```ini
# /etc/systemd/system/scada-app.service
[Unit]
Description=Kotlarnica SCADA (PLC drajveri, port 3000)
After=network-online.target
[Service]
WorkingDirectory=/opt/servoteh-bridge/scada-app
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=servoteh
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/servoteh-bridge.service
[Unit]
Description=Servoteh Bridge (BigTehn sync + SCADA relay)
After=network-online.target scada-app.service
[Service]
WorkingDirectory=/opt/servoteh-bridge
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
User=servoteh
[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now scada-app servoteh-bridge`

2. **BigTehn SQL** radi sa Linuxa (tedious/TCP). Jedino `BIGTEHN_DRAWINGS_DIR`
   (PDF crteži sa Windows share-a) traži CIFS mount:
   `sudo mount -t cifs //bigbit-server/PDMExport /mnt/crtezi -o credentials=...`
   pa `BIGTEHN_DRAWINGS_DIR=/mnt/crtezi`.
3. **Uslovi mreže:** mašina mora da vidi 192.168.75.x + BigTehn SQL + izlazni HTTPS.
4. `.env` fajlovi se prenose ručno (tajne nisu u git-u); logovi idu u `logs/`
   kao i sada; log-rotacija preko logrotate umesto Scheduled Task-a.
5. Uklapa se u plan migracije Supabase→čist PG na Ubuntu: bridge + scada-app
   na istu mašinu, i time se skidaju sa domen kontrolera.

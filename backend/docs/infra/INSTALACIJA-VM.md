# Zapis stanja — bridge VM 192.168.64.24 (2026-07-05)

> **Kopija iz repoa `servoteh-bridge` (`docs/INSTALACIJA-VM.md`), preneta 2026-07-05** — zapis kako je
> infrastruktura urađena u ServoSync 1.0 eri. Živa verzija se održava u `servoteh-bridge`;
> ovde stoji kao referenca za 2.0 (ista mašina i servisi su izvor legacy podataka i SCADA toka).

> Ovo je zapis STVARNOG stanja instalacije na produkcionoj mašini, da svako
> (i budući ja) zna šta gde radi. Uputstvo za SCADA deo: [SCADA-RELAY.md](SCADA-RELAY.md).

## Mašina

| | |
|---|---|
| IP / hostname | 192.168.64.24 / **DC** (⚠ domen kontroler — planirano preseljenje na Ubuntu, v. SCADA-RELAY.md §Ubuntu) |
| OS | Windows Server 2016 Standard |
| Node | v24.x (`C:\Program Files\nodejs`) |
| Repo | `C:\Servoteh\servoteh-bridge` (git clone, update = `git pull`) |
| SSH | OpenSSH ručno instaliran (Server 2016 nema ugrađen; ZIP sa GitHub-a). Ključ za automatizaciju: nalog `adm.nenad`, javni ključ u `C:\ProgramData\ssh\administrators_authorized_keys` (`claude-code@nenad-laptop`) |

## Windows servisi

| Servis | Šta radi | Kako je instaliran |
|---|---|---|
| **Servoteh Bridge** (`servotehbridge.exe`) | `src/index.js` — BigTehn→Supabase sync (katalozi 06:00, proizvodnja */15 min) **+ SCADA relay** (snapshot 5 s, istorija 60 s, komande 2 s) | winsw daemon u `src\daemon\` |
| **Kotlarnica SCADA** | `scada-app/server.js` — PLC drajveri + lokalni API na portu **3000** (Unitronics PCOM, Siemens S7 AWP, Loxone, blue'Log, Sigenergy) | node-windows (`scada-app: npm run service:install`), instaliran 2026-07-05 skriptom `scripts\setup-scada-vm.ps1` |

Oba servisa su **auto-start** — preživljavaju restart mašine.

## Konfiguracija (.env — NIJE u git-u!)

- `C:\Servoteh\servoteh-bridge\.env` — BigTehn SQL kredencijali, Supabase
  SERVICE_ROLE key, cron rasporedi, Telegram alerting, **SCADA blok**
  (`SCADA_ENABLED=true`, `SCADA_BASE_URL=http://127.0.0.1:3000`,
  `SCADA_CONTROL=true` = kill-switch za komande). Instanca: `servoteh-bridge-prod`.
- `C:\Servoteh\servoteh-bridge\scada-app\.env` — kredencijali uređaja
  (LOXONE_PASS, BLUELOG_PASS, SIGEN_APP_KEY/SECRET, S7_USER/PASS, PLC_IP).
  Prenet scp-om 2026-07-05; original i backup drži Nenad.

## Mreža

- BigTehn SQL Server: TCP (vidi `.env` BIGTEHN_SQL_*)
- SCADA uređaji: LAN **192.168.75.x** (S7 .12:443, blue'Log .15:80, Unitronics .25:502, Loxone .130:80) — rutirano sa ove mašine, provereno preflight-om
- Izlaz: HTTPS ka Supabase (`fniruhsuotwsrjsbhrxd.supabase.co`) i Sigen cloud-u; **nula otvorenih dolaznih portova** (osim SSH 22, samo LAN)

## Procedura ažuriranja

```powershell
cd C:\Servoteh\servoteh-bridge
git pull
npm ci --no-audit --no-fund          # ako se menjao package-lock
cd scada-app; npm ci; cd ..          # ako se menjao scada-app
Restart-Service 'Servoteh Bridge'
Restart-Service *otlarnica*          # Kotlarnica SCADA (ako se menjao scada-app)
```

Izvor koda: primarni razvoj je u repou `servoteh-plan-montaze` (folderi
`bridge/` i `scada-app/`); ovaj repo je **deploy mirror** — izmene se
mirror-uju ovamo commit-om pa VM povuče `git pull`.

## Poznate cake

- `git pull` ume da stane na netrekovanom ručno-kopiranom fajlu → preimenuj u `.bak` pa ponovi (desilo se 2026-07-05 sa `scripts\backfill-production-cache.js`).
- Nested `scada-app/.gitignore` ranije je ignorisao ceo `data/` — strukture (loxone/bluelog/sigen JSON) sada JESU u git-u; ignoriše se samo `data/history.json`.
- node-windows ne prosleđuje system env varove — merodavan je `.env` fajl u repo root-u.
- Dnevni logovi: `logs\bridge-YYYY-MM-DD.log` (pino JSON); rotacija: `scripts\rotate-logs.ps1` (Scheduled Task).

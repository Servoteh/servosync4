# SCADA gateway (kotlarnice + solarne elektrane) — pravila

Node servis koji **jedini fizički priča sa uređajima** u pogonu: Unitronics PLC (PCOM/TCP),
Siemens S7-1200 (AWP web), Loxone Miniserver, meteocontrol blue'Log (lokalni REST) i
Sigenergy Cloud. Služi lokalni API na `:3000` + LAN UI (HMI ekrani u `public/`).

**Pre rada pročitaj dvoje:**
[docs/00-pregled-i-mreza.md](docs/00-pregled-i-mreza.md) — opis modula i pravila komunikacije
(ceo lanac, RS485 lanac, jedna PCOM veza, rate-limit, adrese, dojava) · i
[docs/OTVORENI-POSLOVI.md](docs/OTVORENI-POSLOVI.md) — gde smo stali, šta je otvoreno i šta je
odbijeno sa obrazloženjem.

Ostatak dokumentacije (mapa registara, logika rada, dijagnostika, održavanje) je u [docs/](docs/).

## ⛔ Unitronics drži JEDNU konekciju — i ume da se blokira

PLC prihvata **jednu jedinu PCOM sesiju**. Druga konekcija ga u najboljem slučaju odbija,
a ume i da ga zablokira (traži restart u pogonu). Zato:

- **Nikad** ne pokretati drugi `server.js` sa `SIMULATE=false` dok radi produkcijski servis.
  Za svaku lokalnu probu: `SIMULATE=true` (+ `LOXONE_HOST=`, `S7_HOST=` da se ne diraju ni oni).
- **`ECONNREFUSED` na 502 obično znači da PLC RADI**, a ne da je pokvaren — socket već drži
  živi `scada-app` na ubuntusrv. Provereno 29.07.2026: sa druge mašine veza je odbijena, a
  `journalctl` živog servisa u istom trenutku pokazuje `[PLC] PCOM povezan`. Pre nego što
  nekoga pošalješ da resetuje PLC, proveri log živog servisa.
- PCOM nema transaction-id, pa servis šalje zahteve **serijski**; to je razlog zašto sme
  postojati samo jedan klijent.

## Gde ovo ZAISTA radi (provereno 29.07.2026)

Preseljeno na **ubuntusrv (192.168.64.28)** 20.07.2026. Windows bridge VM (192.168.64.24)
je **napušten** — servisi su tamo `Stopped / Disabled` i takvi moraju i ostati.

```
servosync4/scada/                        ← IZVOR (ovaj folder)
   └─ kopija ─► ubuntusrv:/home/admnenad/scada-app     (systemd --user: scada-app.service, port 3010)
                    ▲ /api/*
                    │
        ubuntusrv:/home/admnenad/bridge-scada          (servoteh-bridge-scada.service)
                    └─► sy15 (self-host, SUPABASE_URL=http://localhost:8080)
                          scada_snapshots · scada_history · scada_alarms  →  4.0 /energetika
```

Uz to na istoj mašini radi `servoteh-bridge.service` (BigTehn + Katze sync) — zaseban posao.

```bash
# isporuka
scp <fajlovi> ubuntusrv:/home/admnenad/scada-app/
ssh ubuntusrv 'systemctl --user restart scada-app.service'
ssh ubuntusrv 'journalctl --user -u scada-app.service -n 30'
```

`Linger=yes` je uključen, pa se servisi dižu i posle restarta mašine. `node` nije u PATH-u
za neinteraktivni SSH — koristi `/home/admnenad/.nvm/versions/node/v22.23.1/bin/node`.

⚠️ `scp` sa Windows mašine unosi **CRLF** (u git-u i na serveru je LF). Node to ne smeta,
ali posle toga `cmp` prijavljuje razliku na svakom fajlu pa provera „server = git" ne radi.
Skini CR pri isporuci (`tr -d '\r'`), a razlike gledaj sa `diff --strip-trailing-cr`.

⚠️ **Windows VM se NE sme paliti** — bio bi drugi PCOM klijent na PLC-u (v. dole).
`servoteh-bridge/scada-app/` je i dalje mirror za istoriju, ali ga niko ne pokreće.

`scada/**` **ne okida** ni backend ni frontend deploy — isporuka je ručna, gore opisana.

## HMI ekrani postoje u dve kopije — i to je namerno

`scada/public/*` je izvor (LAN); `frontend/public/scada-hmi/*` je kopija koju 4.0 servira
kroz iframe (čita `scada_snapshots.payload` umesto `/api/*`, v. `scada-bridge-shim.js`).

Kopije **ne mogu** biti identične jer ERP ljuska traži drugačije ponašanje — zato ovde
nema build-koraka koji prepisuje jednu preko druge; to bi obrisalo pravi rad. Umesto toga
postoji kapija koja hvata **novo** razilaženje:

```bash
node scada/scripts/hmi-drift.mjs           # izveštaj po fajlu
node scada/scripts/hmi-drift.mjs --check   # izlaz 1 na neočekivano razilaženje (ci-scada.yml)
```

Kad namerno raziđeš još jedan ekran, upiši ga u `FORKED` u toj skripti **sa razlogom** —
inače CI pada. Trenutno razdvojeni: `kot1.js`, `kot2.{js,html}`, `kot3.{js,html}`,
`overview.js` (async modal `__scadaConfirm`, trend grafik, prikaz svežine snapshot-a).
Shim linija u `<head>`-u HTML-a je mehanička razlika i ne broji se.

Zašto ovo postoji: badge „⚠ ZASTARELO" na Sigen ekranu mesecima je živeo samo u jednoj
kopiji (PLAN_PARITET §Energetika) — ERP je zamrznute vrednosti crtao kao aktuelne.

## Tajne

`.env` nije u git-u (ignorisan). Kredencijali uređaja (PLC, Loxone, blue'Log, S7, Sigen)
prenose se ručno na VM; obrazac je u [.env.example](.env.example).

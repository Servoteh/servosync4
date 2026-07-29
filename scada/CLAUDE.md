# SCADA gateway (kotlarnice + solarne elektrane) — pravila

Node servis koji **jedini fizički priča sa uređajima** u pogonu: Unitronics PLC (PCOM/TCP),
Siemens S7-1200 (AWP web), Loxone Miniserver, meteocontrol blue'Log (lokalni REST) i
Sigenergy Cloud. Služi lokalni API na `:3000` + LAN UI (HMI ekrani u `public/`).

Detaljna dokumentacija je u [docs/](docs/) — arhitektura, mapa registara, dijagnostika,
instalacija i servis. **Pre rada pročitaj [docs/scada-aplikacija/README.md](docs/scada-aplikacija/README.md).**

## ⛔ Unitronics drži JEDNU konekciju — i ume da se blokira

PLC prihvata **jednu jedinu PCOM sesiju**. Druga konekcija ga u najboljem slučaju odbija,
a ume i da ga zablokira (traži restart u pogonu). Zato:

- **Nikad** ne pokretati drugi `server.js` sa `SIMULATE=false` dok radi produkcijski servis.
  Za svaku lokalnu probu: `SIMULATE=true` (+ `LOXONE_HOST=`, `S7_HOST=` da se ne diraju ni oni).
- Ni „bezopasan" `Test-NetConnection`/`nc` na `192.168.75.25:502` nije bezopasan — radi ga
  samo kad je servis „Kotlarnica SCADA" zaustavljen i kad znaš zašto ti treba.
- PCOM nema transaction-id, pa servis šalje zahteve **serijski**; to je razlog zašto sme
  postojati samo jedan klijent.

## Lanac isporuke (ovo NIJE deo backend/frontend deploy-a)

```
servosync4/scada/            ← IZVOR (ovaj folder)
   └─ mirror ─► servoteh-bridge/scada-app/   (deploy repo)
                    └─ VM: C:\Servoteh\servoteh-bridge  →  git pull + Restart-Service
```

Servis se vrti kao Windows servis („Kotlarnica SCADA", node-windows) na bridge VM-u
192.168.64.24, zajedno sa servisom „Servoteh Bridge" koji čita ovaj API (`SCADA_BASE_URL=
http://127.0.0.1:3000`) i puni `scada_snapshots` / `scada_alarms` za 4.0.
Planirano preseljenje oba servisa na Ubuntu (systemd) — v.
`servoteh-bridge/docs/SCADA-RELAY.md §Prelazak na Ubuntu`.

`scada/**` **ne okida** ni backend ni frontend deploy — isporuka je ručna, kroz mirror.

## HMI ekrani postoje u dve kopije (privremeno)

`scada/public/*.js` su izvor; `frontend/public/scada-hmi/*` je portovana kopija koju 4.0
servira kroz iframe (čita `scada_snapshots.payload` umesto `/api/*`, v. `scada-bridge-shim.js`).
**Svaka izmena ekrana mora u obe.** Razilaženje se već dešavalo (badge „⚠ ZASTARELO"
postojao je samo u jednoj kopiji). Cilj je build-korak koji kopira `scada/public` →
`frontend/public/scada-hmi` i ukine ručnu sinhronizaciju.

## Tajne

`.env` nije u git-u (ignorisan). Kredencijali uređaja (PLC, Loxone, blue'Log, S7, Sigen)
prenose se ručno na VM; obrazac je u [.env.example](.env.example).

# SCADA aplikacija — arhitektura

Sopstvena web aplikacija (Node.js) koja je **zamenila stari ZView**. Nadzire i upravlja
Unitronics kotlarnicom, a opciono prikazuje i solarne elektrane. Izvorni kod je u
[`app/`](../../app/); deploy u [`deploy/DEPLOY.md`](../../deploy/DEPLOY.md).

## Princip

```
[Unitronics Jazz] —PCOM(1 veza)— [Node servis: web + PCOM master] —cloudflared→ [Cloudflare + Access] → korisnici
   192.168.75.25:502                  Win2019 VM, port 3000
```

- **Jedan** servis drži **jednu** PCOM vezu ka PLC-u; svi korisnici idu preko njega (WebSocket).
- Čita ceo blok registara **1×/sek**, emituje stanje svim browserima preko WebSocket-a.
- Upis (komanda/režim/setpoint) ide samo na zahtev, uz potvrdu u UI.
- Bez baze i bez Supabase — **istorija je lokalni JSON** (`app/data/history.json`, 24 h).
- Pristup spolja: **Cloudflare Tunnel** (izlazna veza, bez port-forwarda) + **Access** (prijava).

## Glavni fajlovi (`app/`)

| Fajl | Uloga |
|---|---|
| [`server.js`](../../app/server.js) | PCOM master, REST (`/api/state`, `/api/write`, `/api/history`), WebSocket, alarmi, istorija |
| [`pcom.js`](../../app/pcom.js) | Unitronics PCOM/TCP klijent (RW/RB/RE/RA čitanje; SW/SB/SA upis) |
| [`tags.js`](../../app/tags.js) | Mapa tagova (operand → tip → skala → zona) — **izvor istine za adresiranje** |
| `history.js` | Lokalna istorija 24 h → `data/history.json` |
| `notifier.js` | Telegram alarmi (opciono) |
| `service/` | node-windows install/uninstall (Windows servis) |
| `public/` | Web UI (overview, sinoptik, toggle prekidači, trendovi) |
| `test-connection.js` | PCOM smoke test (samo čitanje) |

## Web rute

| Ruta | Šta je |
|---|---|
| `/` | Overview (početni ekran) |
| `/kotlarnica` | Detaljni sinoptik kotlarnice (stari `index.html`) |
| `GET /api/tags` | Lista tagova + zone + online/simulate status |
| `GET /api/state` | Trenutni snapshot vrednosti |
| `GET /api/history` | Istorija temperatura/setpoint (24 h) |
| `POST /api/write` | Upis u tag (`{name, value}`) — samo `rw` tagovi |
| WebSocket | Push stanja (`type:'state'`, plus `loxone`/`sigen`/`bluelog`) |

## PCOM protokol (ukratko)

Isti ASCII protokol koji je koristio ZView (`drvjazz`), preko TCP porta 502:

```
Frame:  / + UnitID(2) + CMD + Addr(4hex) + Len(2hex) [+ data] + Checksum(2hex) + CR
Čitanje:  RW=MI(16-bit), RB=MB, RE=ulazi(I), RA=izlazi(O)
Upis:     SW=MI,  SB=MB,  SA=izlaz(O)
```

Detalji u [`app/pcom.js`](../../app/pcom.js). PCOM nema „transaction id" pa servis šalje
zahteve **serijski** (jedan po jedan) — zato je bitno da je **samo jedan** klijent na PLC-u.

## Opcione integracije (isti servis, ako su env varijable zadate)

| Integracija | Env prefiks | Šta radi |
|---|---|---|
| **blue'Log** (PV ~312 kW) | `BLUELOG_*` | meteocontrol X-Control, lokalni REST, read-only; čita i **alarme** (`NOCOMM_RS485`…) → baner + Telegram |
| **Sigenergy** (PV) | `SIGEN_*` | Cloud OpenAPI, rate-limit 1/5min; **lista sistema se sama preuzima sa naloga** (nov/podeljen sistem uđe bez izmene `.env`) |
| **Loxone** (nova zgrada) | `LOXONE_*` | sobni regulatori, WebSocket živo stanje |

Sve su **opcione** — ako env nije zadat, integracija se prosto ne diže. Detalji za blue'Log
u [`app/README.md`](../../app/README.md).

## Dalje

- [Instalacija i servis](instalacija-i-servis.md) — deploy na VM, Windows servis, update
- [Dijagnostika i česti problemi](dijagnostika.md)

# TSPL2 raw proxy za TSC ML340P

Mali Node.js servis koji prima HTTP POST sa TSPL2 programom i šalje ga **direktno** na TCP port 9100 štampača — **zaobilazi Chrome i Windows printer driver**.

## Zašto

Bez ovog proxy-ja, klik na "Štampaj" u browseru ide kroz lanac:

```
Chrome print dialog → Windows Print Spooler → TSC Windows driver → printer
```

Svaki član u lancu može da promeni paper size, dodaje margine, prepiše SIZE/GAP postavku štampača — što je upravo problem koji se javljao (4×6 inča default driver-a, dodatne Chrome margine, fizičke nalepnice se sekle na pola).

Sa proxy-jem:

```
Frontend → fetch POST /print → Node proxy → TCP raw → printer
```

Ništa se ne menja u štampaču, samo se crta sadržaj koji mi pošaljemo.

## Brzi start

### 1. Instaliraj Node.js

Skini LTS verziju sa https://nodejs.org/ (verzija 18+ je dovoljna). Posle instalacije proveri:

```cmd
node --version
```

### 2. Pokreni proxy

Dvoklik na **`start.bat`** (Windows) ili iz terminala:

```cmd
cd tools\label-proxy
node label-proxy.mjs
```

Trebalo bi da vidiš:

```
==============================================================
TSPL2 raw proxy listening on http://0.0.0.0:8765
Forwarding to printer 192.168.70.20:9100
Endpoints:
   GET  /health   -> service status
   GET  /probe    -> TCP connectivity check ka stampacu
   POST /print    -> body: {payload:{tspl2:"..."}}
==============================================================
```

### 3. Proveri da proxy može da dođe do štampača

Otvori u browseru: http://localhost:8765/probe

Trebalo bi da dobiješ `{"ok":true,"ms":15}` — znači TCP konekcija je uspešna.

Ako dobiješ `{"ok":false,"error":"..."}`:
- Proveri da li štampač uključen i u istoj LAN-i.
- Proveri IP adresu (default je `192.168.70.20` — ako tvoj štampač ima drugu adresu, vidi sekciju ENV ispod).
- Pinguj iz CMD-a: `ping 192.168.70.20` da potvrdiš da je dostupan.

### 4. Test print iz CLI-a

Pošalji jednostavnu test nalepnicu da potvrdiš da sve radi:

```cmd
curl -X POST http://localhost:8765/print -H "Content-Type: application/json" -d "{\"payload\":{\"tspl2\":\"CLS\r\nTEXT 30,30,\"3\",0,1,1,\"PROXY OK\"\r\nPRINT 1,1\r\n\"}}"
```

Iz štampača treba da izađe nalepnica sa tekstom **"PROXY OK"** odmah, bez ikakve Chrome interakcije.

### 5. Poveži aplikaciju sa proxy-jem

U root folderu projekta `servoteh-plan-montaze` napravi (ili dopuni) fajl **`.env.local`**:

```
VITE_LABEL_PRINTER_PROXY_URL=http://localhost:8765/print
```

Restartuj Vite dev server:

```cmd
npm run dev
```

Sada svaki klik na "Štampaj" u Lokacije ▸ Štampa nalepnica:
- otvara browser print prozor (preview — možeš ga zatvoriti ili sačekati);
- **istovremeno** šalje raw TSPL2 program preko proxy-ja → štampač odmah krene da štampa, bez ikakvih Chrome margina ili driver intervencija.

## ENV varijable

Možeš ih postaviti pre pokretanja `start.bat`-a ili `node`-a:

| Varijabla | Default | Opis |
|---|---|---|
| `PRINTER_HOST` | `192.168.70.20` | IP adresa TSC ML340P |
| `PRINTER_PORT` | `9100` | TCP port (raw print) |
| `PROXY_PORT` | `8765` | Port na kome proxy slusa HTTP |
| `ALLOW_ORIGIN` | `*` | CORS Allow-Origin header |

Primer (Windows CMD):

```cmd
set PRINTER_HOST=192.168.1.50
set PROXY_PORT=9000
start.bat
```

## Sigurnosne odbrane

Proxy automatski **odbija** TSPL2 programe koji sadrže komande koje menjaju konfiguraciju štampača: `SIZE`, `GAP`, `DENSITY`, `SPEED`, `CODEPAGE`, `SET TEAR`, `REFERENCE`, `OFFSET`. Ako frontend slučajno pošalje takvu komandu, proxy odbija sa HTTP 422 i logom u konzolu — štampač se ne dotiče.

## Troubleshooting

### "ECONNREFUSED" pri pokretanju proxy-ja
Port 8765 je već zauzet. Promeni port:
```cmd
set PROXY_PORT=8766
start.bat
```
i u `.env.local`:
```
VITE_LABEL_PRINTER_PROXY_URL=http://localhost:8766/print
```

### Nema printa, browser print prozor se otvara normalno
- Proveri da li proxy radi: http://localhost:8765/health treba da vrati `{"ok":true,...}`
- Proveri da je `.env.local` pravilno setovan (BEZ navodnika oko URL-a, BEZ razmaka oko `=`).
- Restartuj `npm run dev` (Vite čita `.env.local` samo pri startu).
- Otvori DevTools ▸ Network tab ▸ klikni Štampaj ▸ vidi da li ima POST request ka `localhost:8765/print` i koji je response.

### "printer timeout" u proxy logu
Stampac ne odgovara na TCP 9100. Proveri:
- IP i port (probaj `telnet 192.168.70.20 9100` iz CMD-a — ako otvori prazan ekran, port je živ).
- Da je u TSC web admin-u (http://192.168.70.20) pod "Network" enable-ovan TCP/IP printing na port 9100.
- Da nije nešto već zakačeno za štampač (drugi print job u redu).

### Proxy radi ali nalepnica izlazi prazna
Verovatno je TSPL2 stigao ali ima sintax error. Otvori proxy konzolu i vidi log poruke. Ili pošalji ručno test print iz koraka 4 — ako "PROXY OK" izlazi, problem je u našem TSPL2 generatoru (vidi `src/lib/tspl2.js`).

## Auto-start na Windows-u (opciono)

Ako želiš da proxy automatski krene pri logon-u korisnika:

1. `Win+R` → `shell:startup`
2. Kopiraj prečicu (Right-click → Create shortcut) od `start.bat` u taj folder.

Ili kao **Windows Service** preko `node-windows` paketa (napredno).

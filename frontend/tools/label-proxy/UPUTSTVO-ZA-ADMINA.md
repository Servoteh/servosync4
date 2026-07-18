# Štampa nalepnica iz ServoSync-a — uputstvo za admina

**Cilj:** da termalni štampač TSC ML340P štampa nalepnice iz ServoSync aplikacije (završna kontrola).
**Vreme:** ~10 minuta po računaru. **Jednokratno po računaru.**

## Na kom računaru se ovo radi?

Na **SVAKOM računaru sa kog se radi kontrola i štampaju nalepnice** (sada: glavni računar kontrole
u pogonu). Aplikacija u browseru šalje nalepnicu na `localhost` — znači servis mora da radi baš na
tom računaru. Štampač je mrežni (`192.168.70.20`), servis mu prosleđuje preko LAN-a.

## Šta je ovo?

Mali program (`label-proxy`) koji prima nalepnicu iz browsera i šalje je **direktno** štampaču
(TCP 9100), zaobilazeći Windows drajver i Chrome margine (koji seku/pomeraju nalepnice).
Isti ovaj servis već koristi ServoSync 1.0 za štampu — ovo je ista, proverena stvar.

---

## Instalacija — korak po korak

### 1. Instaliraj Node.js (ako već nije)

- Otvori CMD i ukucaj: `node --version`
- Ako ispiše verziju **18 ili noviju** (npr. `v20.11.0`) → preskoči na korak 2.
- Ako javi grešku: skini **LTS** installer sa https://nodejs.org/ , instaliraj (sve default),
  zatvori pa otvori nov CMD i proveri opet `node --version`.

### 2. Iskopiraj folder

Iskopiraj ceo folder `label-proxy` (4 fajla: `label-proxy.mjs`, `start.bat`, `package.json`,
`README.md`) na disk računara, npr. u:

```
C:\servosync\label-proxy\
```

### 3. Pokreni servis

Dupli klik na **`start.bat`**. Otvoriće se crni prozor sa porukom:

```
TSPL2 raw proxy listening on http://0.0.0.0:8765
Forwarding to printer 192.168.70.20:9100
```

⚠ **Taj prozor mora ostati otvoren** — dok je otvoren, štampa radi. (Autostart u koraku 6 rešava
da se sam podiže.)

### 4. Provere (u browseru na tom računaru)

| Provera | Adresa | Očekivano |
|---|---|---|
| Servis radi | `http://localhost:8765/health` | `{"ok":true,...}` |
| Štampač dostupan | `http://localhost:8765/probe` | `{"ok":true,"ms":...}` |

Ako `/probe` vrati grešku: proveri da je štampač uključen i pinguj ga (`ping 192.168.70.20`).

### 5. Test nalepnica (opciono, iz CMD-a)

```cmd
curl -X POST http://localhost:8765/print -H "Content-Type: application/json" -d "{\"payload\":{\"tspl2\":\"CLS\r\nTEXT 30,30,\"3\",0,1,1,\"PROXY OK\"\r\nPRINT 1,1\r\n\"}}"
```

Iz štampača odmah izlazi nalepnica sa tekstom **PROXY OK**.

### 6. Autostart (da se sam diže posle restarta) — OBAVEZNO

1. Desni klik na `start.bat` → **Create shortcut** (Napravi prečicu).
2. Pritisni `Win+R`, ukucaj `shell:startup`, Enter — otvoriće se Startup folder.
3. Prevuci napravljenu prečicu u taj folder.

Time se servis sam pokreće pri svakom logovanju korisnika.

### 7. Finalna provera iz aplikacije

U ServoSync-u (Kontrola na kiosku) uradi jednu završnu kontrolu → nalepnice treba da izađu iz
štampača. **U aplikaciji ne treba ništa da se podešava** — ona već gađa `localhost:8765`.

---

## Ako nešto ne radi

| Simptom | Uzrok / rešenje |
|---|---|
| U aplikaciji: „Štampa nalepnica nije uspela (Failed to fetch)" | Servis ne radi na TOM računaru → pokreni `start.bat` (i uradi korak 6). |
| `start.bat` odmah nestane / javi da nema node | Node.js nije instaliran → korak 1. |
| `/health` ok, `/probe` vraća grešku | Štampač ugašen, van mreže, ili mu je promenjena IP adresa → vidi ispod. |
| Port 8765 zauzet (greška pri startu) | Pre starta u CMD: `set PROXY_PORT=8766` pa `start.bat` — i javi Nenadu da se aplikaciji podesi novi port. |
| Nalepnica izlazi prazna | Javi Nenadu (problem u sadržaju nalepnice, ne u instalaciji). |

**Ako štampač promeni IP adresu** (default je `192.168.70.20`): pre pokretanja u CMD:

```cmd
set PRINTER_HOST=192.168.X.Y
start.bat
```

(ili trajno: u `start.bat` izmeni red sa `PRINTER_HOST`).

---

*ServoSync 2.0 · frontend/tools/label-proxy · isti servis koristi i ServoSync 1.0 (Lokacije → Štampa nalepnica)*

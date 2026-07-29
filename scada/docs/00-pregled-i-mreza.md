# Pregled sistema i mreže

## Arhitektura (ko sa kim priča)

```
                          ┌─────────────────────────────────────────────┐
                          │  Win2019 VM (C:\Servoteh\Scada_PLC)          │
                          │  Node servis "Kotlarnica SCADA" :3000        │
   [Unitronics Jazz]──────┤   • 1 PCOM/TCP veza ka Jazz (192.168.75.25)  │
    192.168.75.25:502     │   • web UI + REST + WebSocket                │
                          │   • istorija (lokalni JSON), Telegram alarmi │
   [blue'Log PV]──────────┤   • opc. blue'Log / Sigenergy / Loxone       │
    192.168.75.15         │                                             │
                          └───────────────┬─────────────────────────────┘
                                          │ cloudflared (izlazni tunel)
                                          ▼
                          [Cloudflare Tunnel + Access (prijava)] → operateri (browser)

   [Siemens S7 Hala 5]  ── zaseban sistem sa sopstvenim web serverom (Firefox)
    192.168.11.8            https://192.168.11.8/awp/Servoteh/start.html
```

**Ključno pravilo:** Unitronics Jazz dozvoljava **samo jednu (1) TCP vezu** istovremeno.
Zato **tačno jedan** SCADA servis sme da priča sa PLC-om. Ako se istovremeno pokrene
još jedan klijent (drugi servis, U90 Ladder online, drugi PC) — veza će se otimati i
očitavanja će padati. Vidi [scada-aplikacija/dijagnostika.md](scada-aplikacija/dijagnostika.md).

---

## Mrežne adrese i pristupi

| Uređaj / servis | IP : port | Protokol | Kredencijali | Napomena |
|---|---|---|---|---|
| Unitronics Jazz (kotlarnica) | `192.168.75.25:502` | PCOM/TCP (i Modbus slave) | — | `SI214=1` (Modbus slave aktivan) |
| Siemens S7 (Hala 5) | `192.168.11.8` | HTTPS web server | `admin` / `admin` `[POTVRDITI]` | **samo Firefox**, vidi niže |
| blue'Log X-Control (PV) | `192.168.75.15` | lokalni REST | `FNEServoteh` / `[POTVRDITI]` | ~312 kW, read-only |
| SCADA web (lokalno) | `http://localhost:3000` | HTTP | — | na VM-u |
| SCADA web (spolja) | `https://kotlarnica.<domen>` | HTTPS | Cloudflare Access (email) | `[POTVRDITI domen]` |

> PLC mreža je `192.168.64.0/19`. Da bi VM video PLC, mora biti na toj mreži (bridge/VLAN).
> Provera: `Test-NetConnection 192.168.75.25 -Port 502` → `TcpTestSucceeded = True`.

---

## Dve kotlarnice — u čemu se razlikuju

|  | **Unitronics (stara hala)** | **Siemens (Hala 5)** |
|---|---|---|
| PLC | Jazz JZ20-J-T40 (mikro PLC) | S7-1200/1500 `[POTVRDITI model]` |
| Programski alat | **U90 Ladder** (`.U90`) | **TIA Portal v16** (`.ap16`) |
| HMI / nadzor | SCADA web aplikacija (Node) | ugrađeni web server PLC-a + HMI panel `[POTVRDITI]` |
| Komunikacija | PCOM/TCP + Modbus/TCP slave | PROFINET / web (S7comm interno) |
| Backup programa | `Ladder.U90`, `program_*.U90` u repo | TIA arhiva u `TIA KOTLARNICA HALA 5/` |

Obe kotlarnice rade istu vrstu posla — **termoregulacija hala po zonama** (merenje
temperature → poređenje sa zadatom → uključivanje kalorifera/pumpi/ventila), ali su
realizovane na dve različite platforme jer su rađene u različito vreme.

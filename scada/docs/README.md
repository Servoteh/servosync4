# Dokumentacija — Kotlarnice i SCADA (Servoteh)

Tehnička i operativna dokumentacija za održavanje sistema termoregulacije hala i prateće
SCADA aplikacije. Namenjeno **operaterima i serviserima Servoteh-a** — i za svakodnevni rad
i za održavanje/intervencije.

> ⚠️ **Status:** prvi nacrt (generisan iz postojećih PLC programa i koda aplikacije).
> Delovi označeni sa **`[POTVRDITI]`** treba da proveri/dopuni neko ko je radio na terenu.

---

## Šta sve postoji

| Sistem | PLC / uređaj | IP adresa | Pristup | Dokumentacija |
|---|---|---|---|---|
| **Kotlarnica — stara hala** | Unitronics **Jazz JZ20-J-T40** | `192.168.75.25:502` | PCOM/TCP + Modbus + SCADA app | [kotlarnica-unitronics/](kotlarnica-unitronics/) |
| **Kotlarnica — Hala 5** | Siemens **S7 (TIA)** | `192.168.11.8` | Web server (Firefox) | [kotlarnica-siemens-hala5/](kotlarnica-siemens-hala5/) |
| **SCADA aplikacija** | Node.js servis (Win2019 VM) | `localhost:3000` / Cloudflare | Web (Cloudflare Access) | [scada-aplikacija/](scada-aplikacija/) |

Solarne elektrane (blue'Log / Sigenergy) su integrisane u istu SCADA aplikaciju — vidi
[scada-aplikacija/README.md](scada-aplikacija/README.md).

---

## Mapa dokumentacije

- 🔖 [**CHEAT SHEET**](cheat-sheet.md) — sve ključne adrese, komande i postupci na jednoj strani (za teren)
- 📋 [**OTVORENI-POSLOVI.md**](OTVORENI-POSLOVI.md) — **prvo ovde kad nastavljaš rad**: šta je
  urađeno, šta je otvoreno i zašto, šta je odbijeno i sa kojim obrazloženjem
- [00-pregled-i-mreza.md](00-pregled-i-mreza.md) — **opis modula**: ceo lanac uređaj → gateway →
  relej → baza → ERP, pravila komunikacije (RS485 lanac, jedna PCOM veza, rate-limit), adrese, dojava
- **Kotlarnica Unitronics (stara hala)**
  - [Pregled](kotlarnica-unitronics/README.md) — model PLC-a, kako se povezuje, kako radi ukratko
  - [Mapa registara / tagova](kotlarnica-unitronics/mapa-registara.md) — kompletna tabela MI/MB/I/O
  - [Logika rada](kotlarnica-unitronics/logika-rada.md) — zone, grejanje/hlađenje, auto/ručno, raspored
  - [Rad operatera](kotlarnica-unitronics/rad-operatera.md) — svakodnevni rad, korak-po-korak
  - [Alarmi i kvarovi](kotlarnica-unitronics/alarmi-i-kvarovi.md) — dijagnostika i postupci
  - [Održavanje PLC programa](kotlarnica-unitronics/odrzavanje-plc.md) — U90 Ladder, backup, izmene
- **Kotlarnica Siemens (Hala 5)**
  - [Pregled i pristup](kotlarnica-siemens-hala5/README.md)
  - [Održavanje PLC programa](kotlarnica-siemens-hala5/odrzavanje-plc.md)
- **SCADA aplikacija**
  - [Arhitektura](scada-aplikacija/README.md)
  - [Instalacija i servis](scada-aplikacija/instalacija-i-servis.md)
  - [Dijagnostika i česti problemi](scada-aplikacija/dijagnostika.md)
- **Održavanje (svi sistemi)**
  - [Plan preventivnog održavanja](odrzavanje/plan-odrzavanja.md) — objedinjeni raspored (dnevno/nedeljno/mesečno/sezonski/godišnje) za sva tri sistema
  - [Servisni dnevnik](odrzavanje/servisni-dnevnik.md) — šablon za evidenciju radova; obavezan backup pre svake izmene

---

## Brzi kontakti / pristupi (popuniti)

| Šta | Vrednost |
|---|---|
| Odgovorni inženjer | `[POTVRDITI]` |
| Serviser PLC (Unitronics) | `[POTVRDITI]` |
| Serviser PLC (Siemens) | `[POTVRDITI]` |
| Cloudflare nalog / domen SCADA | `[POTVRDITI]` |
| Lokacija backup-a PLC programa | `[POTVRDITI]` |

> Tabela kompletnih IP adresa: `IP Address Servoteh 64.xlsx` (u korenu repozitorijuma).

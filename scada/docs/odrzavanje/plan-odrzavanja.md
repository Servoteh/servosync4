# Plan preventivnog održavanja — svi sistemi

Objedinjeni plan preventivnog (planskog) održavanja za sva tri sistema: **Unitronics
kotlarnica (stara hala)**, **Siemens kotlarnica (Hala 5)** i **SCADA aplikacija** (Win2019
VM + Cloudflare). Cilj je da se kvarovi spreče pre nego što se dese — naročito pre i tokom
grejne sezone, kada zastoj direktno znači hladne hale.

> ⚠️ **Status:** prvi nacrt — stavke su konsolidovane iz postojećih „rutinsko održavanje"
> i „kontrolna lista" sekcija u dokumentaciji svakog sistema. Stavke koje zavise od
> terenskih detalja (intervali, odgovorne osobe, hardver) nose oznaku **`[POTVRDITI]`** —
> treba ih da proveri/dopuni neko ko radi na terenu.

**Pravilo nad pravilima:** svaka izmena PLC programa ili veća izmena podešavanja MORA imati
**backup pre izmene** i red u [servisnom dnevniku](servisni-dnevnik.md).

Kolona **„Ko"** koristi sledeće uloge (popuniti imenima u [README brzi kontakti](../README.md)):
- **OP** = operater (svakodnevni nadzor)
- **SRV-U** = serviser PLC Unitronics
- **SRV-S** = serviser PLC Siemens
- **ADM** = administrator SCADA aplikacije / VM-a / Cloudflare-a

---

## Dnevno

| ✓ | Zadatak | Sistem | Ko |
|---|---|---|---|
| ☐ | Pogled na SCADA UI (`http://localhost:3000` ili spolja) — indikator **online**, ne „simulacija" | SCADA | OP |
| ☐ | Sve zone u očekivanom režimu (auto/ručno), temperature blizu zadatih | Unitronics + Siemens | OP |
| ☐ | Nema aktivnih alarma; ako ih ima — zabeleži i obradi po proceduri | Svi | OP |
| ☐ | Proveri da li su stigli Telegram alarmi tokom noći (ako se očekuju) | SCADA | OP |

---

## Nedeljno

| ✓ | Zadatak | Sistem | Ko |
|---|---|---|---|
| ☐ | **Smoke test SCADA veze:** `npm run test:connection` (PLC odgovara, čita se temperatura) | SCADA | ADM |
| ☐ | `Get-Service "Kotlarnica SCADA"` → **Running**; `Get-Service cloudflared` → **Running** | SCADA | ADM |
| ☐ | `Test-NetConnection 192.168.75.25 -Port 502` → `TcpTestSucceeded = True` | SCADA/Unitronics | ADM |
| ☐ | Brzi pregled **Event Viewer → „Kotlarnica SCADA"** — ima li ponavljajućih grešaka (connect/PCOM timeout) | SCADA | ADM |
| ☐ | Provera Siemens web servera: `https://192.168.11.8/awp/Servoteh/start.html` (samo Firefox) — učitava se | Siemens | OP |
| ☐ | Vizuelni obilazak oba ormara: nema neuobičajenih zvukova, mirisa, upaljenih alarm-lampi | Unitronics + Siemens | OP |

---

## Mesečno

| ✓ | Zadatak | Sistem | Ko |
|---|---|---|---|
| ☐ | Pristup SCADA **spolja** kroz Cloudflare (`https://kotlarnica.<domen>`) radi; Access prijava prolazi | SCADA | ADM |
| ☐ | Provera Cloudflare **tunela i Access policy** — tvoj e-mail dozvoljen, DNS zapis tačan | SCADA | ADM |
| ☐ | Provera **datuma/sata PLC-a** (Unitronics i Siemens) — raspored zavisi od tačnog vremena | Unitronics + Siemens | SRV-U / SRV-S |
| ☐ | Pregled **dijagnostičkog buffera** Siemens CPU-a (`Online & diagnostics`) za skrivene greške | Siemens | SRV-S |
| ☐ | Provera istorije/trendova u SCADA — da se podaci pišu (`app/data/history.json`) | SCADA | ADM |
| ☐ | Provera **UPS** za PLC i VM — baterija drži, nema alarma na UPS-u | Svi | ADM |
| ☐ | Vizuelni pregled ormara: **stezaljke** (da nisu olabavile), **motorne zaštite**, **kontaktori** (zagorelost, zujanje) | Unitronics + Siemens | SRV-U / SRV-S |

---

## Sezonski (pre grejne sezone)

> Najvažniji termin u godini — uradi pre prvog hladnog talasa, ne kad zona već ne greje.

| ✓ | Zadatak | Sistem | Ko |
|---|---|---|---|
| ☐ | **Backup `.U90`** programa: upload PLC → PC, snimi kao `program_<DD_MM_GGGG>.U90`, kopija van računara | Unitronics | SRV-U |
| ☐ | **Backup TIA projekta**: upload from device + `Project → Archive…` na siguran disk | Siemens | SRV-S |
| ☐ | Backup SCADA konfiguracije (`app/tags.js`, `.env`, `app/data/`) i `git push` | SCADA | ADM |
| ☐ | **Provera UPS-a** pod opterećenjem (PLC + VM) — test pražnjenja, baterija u roku | Svi | ADM |
| ☐ | **Provera datuma/sata** svih PLC-ova pre sezone | Unitronics + Siemens | SRV-U / SRV-S |
| ☐ | **Provera senzora** temperature: poređenje sa **referentnim termometrom** po zonama | Unitronics + Siemens | SRV-U / SRV-S |
| ☐ | Provera/postavka **rasporeda grejanja** (satnice) za novu sezonu | Unitronics + Siemens | SRV-U / SRV-S |
| ☐ | Probni rad svake zone: zadaj temperaturu, proveri da izlazi (kaloriferi/pumpe/ventili) reaguju | Unitronics + Siemens | SRV-U / SRV-S |
| ☐ | Pun **smoke test SCADA**: čitanje svih tagova, upis setpointa, alarm ode na Telegram | SCADA | ADM |
| ☐ | Pregled ormara pre sezone: stezaljke pritegnute, zaštite ispravne, kontaktori OK | Unitronics + Siemens | SRV-U / SRV-S |

---

## Godišnje

| ✓ | Zadatak | Sistem | Ko |
|---|---|---|---|
| ☐ | **Čišćenje ormara** (prašina, ventilacija/filteri ormara) | Unitronics + Siemens | SRV-U / SRV-S |
| ☐ | Termovizijski / vizuelni pregled spojeva snage (zagrevanje stezaljki, kontaktora) `[POTVRDITI]` | Unitronics + Siemens | SRV-U / SRV-S |
| ☐ | **Zamena/test UPS baterija** po preporuci proizvođača `[POTVRDITI interval]` | Svi | ADM |
| ☐ | Provera i ažuriranje **mape tagova/registara** vs. stvarno stanje PLC programa | Unitronics + Siemens | SRV-U / SRV-S |
| ☐ | Pregled i čišćenje starih backup fajlova; provera da su sve verzije sa datumom na sigurnom disku | Svi | ADM |
| ☐ | Provera Windows/servis ažuriranja na VM-u (van grejne sezone, planski restart) | SCADA | ADM |
| ☐ | Revizija pristupa (Cloudflare Access lista korisnika, lozinke Siemens web servera) | SCADA + Siemens | ADM / SRV-S |

---

## Vezane procedure

- Backup i izmena Unitronics programa: [kotlarnica-unitronics/odrzavanje-plc.md](../kotlarnica-unitronics/odrzavanje-plc.md)
- Backup i izmena Siemens programa: [kotlarnica-siemens-hala5/odrzavanje-plc.md](../kotlarnica-siemens-hala5/odrzavanje-plc.md)
- Dijagnostika SCADA aplikacije: [scada-aplikacija/dijagnostika.md](../scada-aplikacija/dijagnostika.md)
- **Svaki rad upiši u:** [servisni-dnevnik.md](servisni-dnevnik.md)

> ⚠️ Podsetnik: pre bilo kakvog **download-a u Unitronics PLC** zaustavi SCADA servis
> (`Stop-Service "Kotlarnica SCADA"`) — Jazz dozvoljava samo 1 TCP vezu. Vidi
> [00-pregled-i-mreza.md](../00-pregled-i-mreza.md).

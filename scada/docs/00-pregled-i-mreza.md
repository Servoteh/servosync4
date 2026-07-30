# Pregled modula — energetika (kotlarnice + solarne elektrane)

Stanje provereno na živim mašinama **30.07.2026.** Ako nešto ovde ne odgovara stvarnosti,
prvo proveri uživo pa ispravi dokument — ne obrnuto.

## Lanac: od uređaja do ekrana

```
  OPREMA U POGONU (LAN 192.168.75.x)
  ├─ Unitronics Jazz JZ20      .25:502    PCOM/TCP   — kotlarnica 1 (stara hala)
  ├─ Siemens S7-1200           .12:443    AWP web    — kotlarnica 2 / Hala 5
  ├─ Loxone Miniserver         .130:80    HTTP + WS  — nova zgrada
  ├─ meteocontrol blue'Log     .15:80     lokalni REST ─┬─ BM_RS485_1 → 6× KACO 50 kW
  └─ (Sigenergy — nema lokalne veze)                    └─ BM_RS485_2 → Janitza UMG 96RM
                                    │
                                    ▼
  GATEWAY   ubuntusrv:/home/admnenad/scada-app     systemd --user: scada-app.service
            port 3010 · JEDINI koji priča sa opremom · drajveri + validacija + LAN UI
            /api/state /api/s7 /api/loxone /api/bluelog /api/sigen  (+ /history, /write)
                                    │  HTTP 127.0.0.1:3010
                                    ▼
  RELEJ     ubuntusrv:/home/admnenad/bridge-scada  systemd --user: servoteh-bridge-scada.service
            snapshot 5 s · istorija 60 s · alarmi diff-sync · komande 2 s (allowlist)
                                    │
                                    ▼
  BAZA      sy15 (self-hosted na ubuntusrv, SUPABASE_URL=http://localhost:8080)
            scada_sites · scada_snapshots · scada_history · scada_alarms · scada_commands
                                    │
                                    ▼
  ERP 4.0   backend/src/modules/energetika (čita sy15 Prismom)  →  /energetika (iframe HMI)
            i /mob/energetika
```

Uz to, na istoj mašini radi i `servoteh-bridge.service` — **zaseban posao**: BigTehn
(SQL Server `Vasa-SQL:5765`) → sy15 sinhronizacija kataloga, proizvodnje i Katze evidencije.

**Windows bridge VM (192.168.64.24) je napušten.** Servisi tamo su `Stopped / Disabled`
i moraju takvi ostati. Sinhronizacija ide **isključivo** sa ubuntusrv-a — dokaz: posao
`katze_attendance` se izvršava svakih par minuta, a na VM-u je `ENABLE_JOB_KATZE=false`.

## Ključna pravila komunikacije

**1. Unitronics drži JEDNU PCOM sesiju i ume da se blokira.** Zato tačno jedan servis sme
da priča sa PLC-om. Posledica koja zbunjuje: `ECONNREFUSED` na `192.168.75.25:502` sa bilo
koje druge mašine najčešće znači da PLC **radi** — socket već drži živi `scada-app`. Pre
nego što nekoga pošalješ da resetuje PLC, pogledaj `journalctl --user -u scada-app.service`
gde u tom trenutku piše `[PLC] PCOM povezan`. PCOM nema transaction-id, pa servis šalje
zahteve serijski.

**2. blue'Log ima dva nezavisna RS485 porta.** `BM_RS485_1` = svih 6 KACO invertora u
**lancu** (multidrop, adrese 1–6, terminator na kraju), `BM_RS485_2` = Janitza brojilo.
Prekid lanca briše sve **iza** tačke prekida, a sve ispred nastavlja normalno — zato je
28.07. ostala samo adresa 1, a 2–6 su otpale u istom minutu (razmak 44 ms = jedan događaj
na vodu, ne pet kvarova). Brojilo je na drugom portu i radilo je bez prekida, što je i
dokazalo da logger, mreža i napajanje nisu bili u pitanju.

**3. Logger je master regulacije aktivne snage.** Kad ne može da isporuči korekcionu
vrednost (setpoint) invertorima, javlja *„Communication error on an interface for
correction value transmission"*. Ta poruka je **posledica** prekida na magistrali, ne
zaseban kvar.

**4. Sigen cloud ima rate-limit** 1 zahtev po endpointu / 5 min, i povremeno vraća meke
greške (`1001 rpc fail`, `1110`, `1201`). Servis tada zadržava poslednju dobru vrednost, a
UI to označi badge-om „⚠ ZASTARELO" — bez toga bi zamrznuti brojevi izgledali kao aktuelni.

**5. Lista Sigen sistema se preuzima sa naloga** (osvežavanje na 6 h). Fiksna lista u
`.env` je 06.07.2026. novi sistem `Servoteh_110 (2)` držala nevidljivim ~3 nedelje
(~970 kWh/dan van evidencije). `.env` je sada samo seed/fallback.

## Adrese i pristupi

| Uređaj / servis | Adresa | Protokol | Napomena |
|---|---|---|---|
| Unitronics Jazz | `192.168.75.25:502` | PCOM/TCP | samo 1 veza; `SI214=1` |
| Siemens S7 (Hala 5) | `192.168.75.12:443` | AWP web | čita/piše DB „Web" |
| Loxone Miniserver | `192.168.75.130:80` | HTTP + WebSocket | 61 tag |
| blue'Log X-Control | `192.168.75.15:80` | lokalni REST (nezvaničan) | prijava MD5 + CSRF |
| Sigenergy Cloud | `openapi-eu.sigencloud.com` | HTTPS OpenAPI | 4 sistema |
| BigTehn SQL | `Vasa-SQL` = `192.168.64.25:5765` | TDS (mssql) | nalog `bridge_reader`, read-only |
| Gateway API | `ubuntusrv:3010` | HTTP | `scada-app.service` |
| sy15 baza | `ubuntusrv` `localhost:8080` (REST), `127.0.0.1:5436` (PG) | — | self-hosted |

Pogonska mreža je `192.168.64.0/19`. ICMP je mestimično filtriran — `ping` koji ne prolazi
ne znači da uređaj ne radi; meri se port (`Test-NetConnection -Port`, `</dev/tcp/…`).

## Dve kotlarnice — u čemu se razlikuju

|  | **Unitronics (stara hala)** | **Siemens (Hala 5)** |
|---|---|---|
| PLC | Jazz JZ20-J-T40 | S7-1200 |
| Programski alat | U90 Ladder (`.U90`) | TIA Portal |
| Komunikacija | PCOM/TCP (1 veza!) | AWP web server |
| Backup programa | `_legacy/scada-plc/*.U90` | `_legacy/scada-plc/TIA KOTLARNICA HALA 5/` |
| Stanje merenja | ⚠️ **sonde/analogna kartica ne rade** (nasleđeno) | zdravo — 32–54 različite vrednosti po metrici u 24 h |

Obe rade isti posao — termoregulacija hala po zonama — ali su rađene u različito vreme na
različitim platformama. Za kot1 vidi
[kotlarnica-unitronics/alarmi-i-kvarovi.md §D1](kotlarnica-unitronics/alarmi-i-kvarovi.md).

## Dojava alarma

| Kanal | Šta dobija |
|---|---|
| **Telegram** | svaki alarm (radna grupa) |
| **E-mail** (Nenad, Jovan Matić, Želimir Jovašević) | **samo kritično**: invertor otpao sa magistrale (`NOCOMM_RS485`) i pregrejan invertor (`BLUELOG_HOT_C`, 75 °C) |
| ERP `/energetika` | sve iz `scada_alarms` |

Mejl prolazi kroz tri brane: dozvoljeni spisak kodova (`ALERT_MAIL_CODES`), kvar mora
trajati (`ALERT_MAIL_AFTER_MIN`, 10 min) i tvrda dnevna kapica (`ALERT_MAIL_MAX_PER_DAY`,
12). „Alarm prošao" nikad ne ide na mejl. Kotlarnice **nisu** na mejlu — v.
[OTVORENI-POSLOVI.md](OTVORENI-POSLOVI.md).

## Šta gde stoji u repou

| Putanja | Šta je |
|---|---|
| [`scada/`](../) | gateway — drajveri, lokalni API, HMI ekrani, ovi dokumenti |
| [`bridge/`](../../bridge/) | relej u bazu + BigTehn sync |
| `backend/src/modules/energetika/` | ERP čitanje iz sy15 |
| `frontend/public/scada-hmi/` | portovani HMI ekrani za iframe u 4.0 |
| `_legacy/scada-plc/` | PLC projekti (U90, TIA) — van git-a |

Otvoreni i planirani poslovi: **[OTVORENI-POSLOVI.md](OTVORENI-POSLOVI.md)**.

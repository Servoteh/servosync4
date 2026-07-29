# Kotlarnica Siemens — Hala 5 (pregled i pristup)

> Termoregulacija hala 3–6 (sa težištem na Hali 5) na Siemens S7-1200 PLC-u sa sopstvenim
> web serverom. Najveći deo podataka u nastavku je izvučen iz TIA Portal v16 projekta
> (`PEData.plf`, `UserFiles/*.html`). Stavke koje se i dalje ne mogu potvrditi iz fajlova
> ostavljene su kao `[POTVRDITI]` / `[DOPUNITI]` (zahtevaju otvaranje projekta u TIA Portalu
> ili proveru na terenu).

## Šta je to

Termoregulacija proizvodnih hala (3, 4, 5, 6), realizovana na **Siemens** PLC-u (TIA Portal
projekat „Termoregulacija hala TIA"). Sistem reguliše **pumpe (P1–P4)**, **kalorifere
(K1–K15)** i **kotao**, u **automatskom** ili **ručnom** režimu, sa izborom **grejanje /
hlađenje**. Zaseban je od Unitronics kotlarnice — ima **sopstveni web server** na samom
CPU-u (Siemens AWP user-defined stranice), pa se nadzire i komanduje direktno iz browsera
(zasad nije u zajedničkoj SCADA aplikaciji).

## Osnovni podaci

| Stavka | Vrednost | Izvor |
|---|---|---|
| Proizvođač | Siemens | — |
| Tip CPU-a | **S7-1200, CPU 1214C DC/DC/DC** | `PEData.plf` (red 8118) |
| Order number (MLFB) | **6ES7 214-1AG40-0XB0** | `PEData.plf` (red 8101/8119) |
| Verzija firmvera | **V4.4** | `PEData.plf` (red 8117, `SDiag_CmpFirmwareVersion = V4.4`) |
| Ime PLC stanice | `plc_1` (stanica „S7-1200 station_1") | `PEData.plf` (red 8100, 7300) |
| Distribuirani I/O | **ET 200SP** preko PROFINET-a (stanica „ET 200SP station_1") | `PEData.plf` (red 7290) |
| IP adresa | ⚠️ `192.168.75.12` **(verovatno aktuelna, vidi napomenu)** vs `192.168.11.8` (iz txt) | terenski test / `pristup web serveru.txt` |
| Maska / gateway | `255.255.224.0` (/19) `[POTVRDITI]` — isti segment kao ostatak postrojenja | — |
| OPC UA server | postoji kao opcija na CPU-u | `PEData.plf` (red 30639) |
| Programski alat | **TIA Portal v16** (projekat `.ap16`, verzija 1600.0.3102.1) | `PEData.plf` (red 8105) |
| Autor projekta | `sanja.milovanovic` | `PEData.plf` (red 7287) |
| HMI panel | **Nema fizičkog HMI panela** — nadzor isključivo preko web servera CPU-a | vidi „HMI / panel" ispod |

### Hardverska konfiguracija (instancirane stanice)

**S7-1200 station_1** — `plc_1`:
- CPU 1214C DC/DC/DC, `6ES7 214-1AG40-0XB0`, FW V4.4 (on-board: AI 2, DI 14 / DQ 10, brojači HSC).

**ET 200SP station_1** (distribuirani I/O preko PROFINET-a) — `PEData.plf` red 7165–7765:
- Interface modul **IM 155-6 PN**, `6ES7 155-6AR00-0AN0`, V3.2 (glava ET 200SP)
- BusAdapter `6ES7 193-6AR00-0AA0`
- **3 × DI 16x24VDC ST** (`6ES7 131-6BH01-0BA0`) — digitalni ulazi
- **2 × AI 4xRTD/TC 2-,3-,4-wire HF** (`6ES7 134-6JD00-0CA1`) — analogni ulazi za temperaturne sonde (RTD/termopar)
- **2 × DQ 16x24VDC/0.5A ST** (`6ES7 132-6BH01-0BA0`) — digitalni izlazi
- Server modul `6ES7 193-6PA00-0AA0`

> Napomena: ekstrakcija stringova vraća i celu HW katalog biblioteku (mnogi `6ES7...` koji
> nisu nužno ugrađeni). Gore su navedeni samo moduli koji su **instancirani** u stanicama
> (sufiksi `_1`, `_2`, `_3` u `PEData.plf`).

> ⚠️ **Napomena o IP adresi (VAŽNO za pristup):** fajl `pristup web serveru.txt` (iz 2022)
> navodi `192.168.11.8`, ali je IP u međuvremenu menjan (folder projekta = „izmenjena IP adresa").
> Pri ranijem **terenskom ispitivanju dev mašina je dostizala PLC na `192.168.75.12`** (ping ~1 ms),
> što je isti `/19` segment kao Unitronics kotlarnica (`192.168.75.25`) i solarni sistemi — pa ga
> SCADA VM može videti. Zato je **`192.168.75.12` najverovatnije aktuelna adresa**, a `192.168.11.8`
> stara iz txt-a. **Pre oslanjanja proveriti na terenu / u TIA → Device configuration.** Skeniranjem
> portova ranije: `443` (web) i `102` (S7comm) otvoreni, `4840` (OPC UA) i `502` (Modbus) zatvoreni.

## Web pristup (nadzor i komandovanje)

> **Mora preko Firefox-a** (Chrome/Edge često blokiraju self-signed sertifikat web servera).

```
https://192.168.11.8/awp/Servoteh/start.html
korisnik: admin
lozinka:  admin      [PROMENITI default lozinku — bezbednosni rizik]
```

- `awp` = *Automatic Web Programming* (Siemens user-defined web stranice). Naziv aplikacije
  (foldera) je **`Servoteh`** (`PEData.plf` red 7071).
- Web server je **aktivan**, sa **automatskim osvežavanjem** uključenim
  (`WebServerActive`, `WebServerAutomaticUpdateActive` — `PEData.plf` red 8108–8109).
- Stranica `start.html` je glavni SCADA ekran (mnemošema hala sa pumpama, kaloriferima,
  alarmima, izborom režima i unosom željene temperature). `update_page.html` je skriveni
  iframe koji periodično (svakih 10 s) čita promenljive i osvežava prikaz.
- Prvi put Firefox će prijaviti nepoverljiv sertifikat → prihvati izuzetak za `192.168.11.8`.
- **Bezbednost:** `admin/admin` je podrazumevano — preporuka je promeniti lozinku i ne
  izlagati ovaj web spolja bez zaštite (VPN/Cloudflare Access). `[DOPUNITI politiku pristupa]`

### Web stranice (izvor)

Izvorni HTML/CSS/JS web servera su u folderu projekta:

```
…/UserFiles/
├── start.html        ← glavni ekran (AWP_In/Out promenljive, mnemošema, alarmi, komande)
├── update_page.html  ← iframe za periodično čitanje promenljivih (AWP read komande)
├── stylesheet.css
├── java.js
├── logo.png, background.jpg, building13.png, pump_*.png/gif, air.gif, shine.gif, stop.png, load.gif
```

## HMI / panel

U projektu **nema instanciranog HMI uređaja** (panela). Postoje samo dve hardverske stanice:
`S7-1200 station_1` i `ET 200SP station_1` (`PEData.plf`). „WinCC Basic" koji se vidi u
fajlu je samo lista instaliranih TIA softverskih opcija (STEP 7 Basic / WinCC Basic /
SINEMA E Basic, verzije V13–V16), a ne konfigurisan panel. **Operatorski interfejs je web
server CPU-a** (stranice `awp/Servoteh/…`). `[POTVRDITI da na terenu ne postoji dodatni panel]`

## Mapa tagova (PLC I/O i interne promenljive)

Izvučeno iz `PEData.plf` (apsolutne adrese i nazivi tagova). Tipovi: `Bool` (digitalno),
`Int` (analogno 16-bit), `Time`.

### Analogni ulazi — temperature (RTD/TC preko ET 200SP, `Int`)

| Adresa | Tag | Značenje |
|---|---|---|
| `%IW68` | `Temp_suda` | Temperatura u sudu (akumulacioni sud / razdelnik) |
| `%IW70` | `Temp_Hala_3` | Temperatura Hala 3 |
| `%IW72` | `Temp_Hala_4` | Temperatura Hala 4 |
| `%IW74` | `Temp_Hala_5` | Temperatura **Hala 5** |
| `%IW76` | `Temp_spoljasnja` | Spoljašnja temperatura |
| `%IW78` | `Temp_Hala_6` | Temperatura Hala 6 |

### Digitalni ulazi (`Bool`)

| Adresa | Tag | Značenje |
|---|---|---|
| `%I2.0`–`%I2.3` | `Zastita_P1`…`Zastita_P4` | Zaštitne sklopke pumpi 1–4 |
| `%I2.4`–`%I3.5` | `Zastita_K1`…`Zastita_K10` | Zaštitne sklopke kalorifera 1–10 |
| `%I5.6`–`%I6.2` | `Zastita_K11`…`Zastita_K15` | Zaštitne sklopke kalorifera 11–15 |
| `%I3.6`, `%I3.7` | `Alarm_TP1`, `Alarm_TP2` | Alarmi toplotnih pumpi 1 i 2 |
| `%I4.0`–`%I4.3` | `Potvrda_ukljucenja_P1`…`P4` | Povratne potvrde rada pumpi 1–4 |
| `%I4.4`–`%I5.5` | `Potvrda_ukljucenja_K1`…`K10` | Povratne potvrde rada kalorifera 1–10 |
| `%I6.3`–`%I6.7` | `Potvrda_ukljucenja_K11`…`K15` | Povratne potvrde rada kalorifera 11–15 |

### Digitalni izlazi (`Bool`)

| Adresa | Tag | Značenje |
|---|---|---|
| `%Q2.0` | `Ukljucenje_kotla` | Komanda kotla |
| `%Q2.1`–`%Q2.4` | `Ukljucenje_P1`…`P4` | Komande pumpi 1–4 |
| `%Q2.5`–`%Q3.6` | `Ukljucenje_K1`…`K10` | Komande kalorifera 1–10 |
| `%Q4.0`–`%Q4.4` | `Ukljucenje_K11`…`K15` | Komande kalorifera 11–15 |
| `%Q4.5`, `%Q4.7` | `TP1_Run/Standby`, `TP2_Run/Standby` | Toplotne pumpe 1 i 2 (rad/pripravnost) |
| `%Q4.6` | `TP12_Grejanje/Hladjenje` | Toplotne pumpe — izbor grejanje/hlađenje |

### Interne promenljive / parametri regulacije (`%M`, Merker)

| Adresa | Tag | Značenje |
|---|---|---|
| `%M0.0` / `%M0.1` | `Automatski_Rezim` / `Rucni_Rezim` | Režim rada |
| `%M0.2` / `%M0.3` | `Rezim_Grejanja` / `Rezim_Hladjenja` | Izbor grejanje/hlađenje |
| `%M3.1` | `Web_EStop` | Virtuelni STOP sa web servera |
| `%MW15` | `Tolerancija_temperature` | Tolerancija oko željene temperature (histereza) |
| `%MW20` / `%MW22` | `Gornji_prag…` / `Donji_prag_tolerancije_temperature` | Gornji/donji prag (željena ± tolerancija) |
| `%MW24` / `%MW26` | `Gornji_/Donji_prag_tolerancije_temperature_kotla` | Pragovi temperature suda/kotla |
| `%MD28` | `Maksimalna_duzina_rada_rucni_rezim` (`Time`) | Maks. trajanje rada pumpe u ručnom režimu |
| `%MW18` | `WWW_status` | Status web servera |

> Setpoint (željena temperatura) i tolerancija se unose **sa web servera** (`Web.Zeljena_temperatura`,
> opseg 10–30 °C — vidi `start.html`); PLC iz njih računa gornji/donji prag. Tačne **default
> brojčane vrednosti** tolerancije/pragova/maks. vremena nisu čitljive iz stringova → `[POTVRDITI u TIA Portalu]`.

### Web DB promenljive (interfejs web ↔ PLC)

Glavni DB se zove **`Web`** (`DB_WWW`). Web → PLC (komande, `AWP_In_Variable` u `start.html`):
`Web_Estop`, `Web_Rucni_Rezim`, `Web_Automatski_Rezim`, `Web_Grejanje`, `Web_Hladjenje`,
`Web_Ukljucenje_kotla_rucno`, `Web_P1..P4`, `Web_K1..K10`, `Zeljena_temperatura`,
`Alarm_w1x*_reset`, `Alarm_w3x*_reset`. PLC → web (čitanje, `update_page.html`):
`Estop`, `Temp_suda`, `Temp_Hala_3..6`, `Temp_spoljasnja`, `Web_Pumpe` (bit po pumpi),
`Web_Kaloriferi` (bit po kaloriferu), `Potvrde_ukljucenja_pumpi/_kalorifera`,
`Timer_P1..P4`, `AlarmW1`, `AlarmW2`, `AlarmW3`.

## Logika regulacije (iz komentara PLC programa)

Iz komentara blokova u `PEData.plf`:

- **Željena temperatura i tolerancija** se unose sa web servera; PLC formira gornji/donji prag
  („Željena temperatura i tolerancija; željeno krajnje vreme (početno ide direktno sa Web servera)").
- **Automatski režim:** PLC daje „dozvole uključenja P1..4" i „dozvole uključenja K1..K15".
- **Kaloriferi** se uključuju sa **predviđenim zakašnjenjem u odnosu na uključenje odgovarajuće
  pumpe** (IEC tajmeri `IEC_Timer_Px_Odlo…` za odlaganje).
- **Ručni režim:** pumpe imaju **maksimalnu dozvoljenu dužinu rada** (`Maksimalna_duzina_rada_rucni_rezim`);
  po prekoračenju ide upozorenje (`IEC_Timer_Prekoracena_duzina_rada_Px_DB`), pa isključenje.
- **Kotao** se uključuje u odgovarajućem vremenskom periodu u automatskom režimu, a manuelno
  u ručnom; isključuje se ako temperatura suda pređe dozvoljenu vrednost.
- **Grejanje/Hlađenje** — prelazak između režima posebno obrađen.
- Logika kalorifera važi „u automatskom i ručnom režimu kao i u slučaju gubitka inicijalnih
  uslova ili pojave nekog od alarma".

> Tačni brojevi (setpointi po default-u, vremena odlaganja, raspored/sat uključenja kotla)
> nisu čitljivi iz stringova → vide se samo u TIA Portalu. `[DOPUNITI]`

## Spisak alarma (iz `start.html` / `update_page.html`)

Alarmi su grupisani u tri reči (`AlarmW1`, `AlarmW2`, `AlarmW3`); bit određuje konkretan alarm.

**AlarmW1 (kvarovi kontaktora / sistem) — `bit`:**
| Bit | Tekst |
|---|---|
| 0 | Pritisnuta svestop pečurka! (ALARM) |
| 1 | Neadekvatna temperatura u sudu! (OBAVEŠTENJE) |
| 2–5 | Greška kontaktora P4 / P3 / P1 / P2! |
| 6–15 | Greška kontaktora K1 … K10! |

**AlarmW2 (ispad zaštitnih sklopki):**
| Bit | Tekst |
|---|---|
| 0–3 | Ispad zaštitne sklopke P4 / P3 / P1 / P2! |
| 4–13 | Ispad zaštitne sklopke K1 … K10! |
| 14 | PLC ne čita ispravno vreme! |

**AlarmW3 (upozorenja / info):**
| Bit | Tekst |
|---|---|
| 0–3 | Pumpa 4 / 3 / 1 / 2 prekoračila dozvoljenu dužinu rada u ručnom režimu — uskoro isključenje (UPOZORENJE) |
| 4 | Temperatura suda prešla dozvoljenu vrednost — kotao isključen! (UPOZORENJE) |

> `start.html` referencira i K11–K15 / dodatne reči (`AlarmWord4..6`) u JS-u, ali odgovarajući
> `myalarm_` elementi za njih nisu definisani na stranici (kod je pripreman za proširenje).

## Šta postoji u projektu (folder)

```
TIA KOTLARNICA HALA 5/
├── pristup web serveru.txt                  ← URL + kredencijali (gore)
└── 4.2..2026. FINALNA VERZIJA Termoregulacija hala TIA (izmenjena IP adresa)/
    ├── Termoregulacija hala TIA.ap16        ← TIA Portal v16 projekat (otvoriti ovde)
    ├── System/PEData.plf                    ← glavna baza projekta (HW + program + tagovi)
    ├── AdditionalFiles/PLCM/…               ← PLC arhiva
    ├── IM/HMI/…                             ← runtime indeks/podaci
    ├── UserFiles/                           ← web server stranice (start.html, update_page.html, …)
    └── Vci / XRef / Logs …                  ← prateći folderi TIA projekta
```

Naziv foldera kaže „izmenjena IP adresa" → IP je menjan; aktuelni je `192.168.11.8`, dok u
`PEData.plf` (SDiag putanji) ostaje stari trag `192.168.75.x`.
`[POTVRDITI da projekat odgovara onome što je u PLC-u — uraditi Upload from device]`

## Šta tek treba dokumentovati `[DOPUNITI]`

- [ ] Maska podmreže i gateway (videti u TIA → Device configuration → PROFINET interface).
- [ ] Default brojčane vrednosti: tolerancija temperature, pragovi suda/kotla, vremena
      odlaganja kalorifera, maks. trajanje ručnog rada, raspored/sat uključenja kotla.
- [ ] Mapiranje sondi na konkretne kanale AI modula (`6ES7 134-…`) i tačan tip sonde (PT100/PT1000/TC).
- [ ] Da li i kako se uključuje u zajedničku SCADA aplikaciju (S7comm / OPC UA / Modbus).
      CPU ima OPC UA server kao opciju → najlakša integracija.

## Dalje

- [Održavanje PLC programa](odrzavanje-plc.md) — TIA Portal, backup, download.

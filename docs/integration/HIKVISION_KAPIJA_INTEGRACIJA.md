# Hikvision kapija + pametne kamere — integracioni zapis

> **Status:** ISTRAŽENO I ISPLANIRANO (2026-07-18), NIJE JOŠ IMPLEMENTIRANO.
> Ovo je zapis „dokle smo stigli" — priprema da se uređaj kasnije **samo uključi**.
> Pokretanje (most + enrollment) ide kad se pređe na aktivni rad u ovom repou.

Cilj (Nenad): pametni Hikvision uređaj na **ulaznoj kapiji** kao **alternativa kartici** —
identifikacija licem (Face ID), otiskom prsta ili QR kodom. Sve predvideti sada da se kasnije
samo uključi. Isti princip pokriva i buduće **pametne kamere** (Hikvision AI uređaji).

---

## 0. Ključni zaključak (TL;DR)

Naša evidencija (Q11 auto-close + vreme-pregledi) čita **isključivo tabelu `attendance_events`**
(u sy15-db) po `employee_id` + `direction` (in/out). Zato je cela integracija svedena na jedno:

> **Hikvision događaji (lice/otisak/QR/kartica) moraju da slete u `attendance_events` sa tačnim
> `employee_id` i `direction`. Sve nizvodno (Q11, evidencija, izveštaji) već radi — bez ijedne
> izmene koda.**

Zbog toga je sistem **već „Hikvision-spreman by design"**: ključ je *osoba* (`employee_id`), a
NE metod identifikacije. Bilo koji način (Face/otisak/QR/kartica) → isti `employee_id` → radi.

---

## 1. Uređaj

> ⚠️ **Oznaka:** Nenad je naveo `DS-K1T680CF-E1`, ali u Hikvision katalogu **ta oznaka ne postoji**.
> Serija DS-K1T680 ima: **DS-K1T680D-E1** (lice+kartica) i **DS-K1T680DF-E1** (lice + **otisak** +
> kartica + QR). Pošto tražimo i otisak i QR → gotovo sigurno **DS-K1T680DF-E1**.
> **AKCIJA: proveriti nalepnicu na uređaju kad stigne** (kapaciteti se razlikuju po varijanti).

**DS-K1T680DF-E1 — specifikacija:**

| Stavka | Vrednost |
|---|---|
| Identifikacija | **Lice** (100.000), **otisak** (10.000), **kartica** Mifare/DESFire/Felica (100.000), **QR kod** (slika ≥ 6×6 cm), PIN |
| Anti-spoofing | Da (lažno lice / foto zaštita) |
| Lokalni bafer događaja | 150.000 (radi offline, sinhronizuje kad se mreža vrati) |
| Ekran / kamera | 8" touch / 2 MP |
| Mreža / protokoli | TCP/IP, **ISAPI**, ISUP 5.0, **Wiegand**, **RS-485**, **PoE** |
| Napajanje | 12–24 VDC 3A **ili** standardni PoE |
| Uslovi rada | −30 do 60 °C, IP65 (može spolja) |
| Dimenzije | 127,3 × 232,1 × 23,5 mm |

Datasheet: <https://download.discomp.cz/hikvision/datasheets/DS-K1T680DF-E1.pdf>

---

## 2. Kako se povezuje — ISAPI

Uređaj priča **ISAPI** (Hikvision HTTP/REST, **HTTP Digest** autentikacija). Bitne dve grupe poziva:

### 2a. Prijem događaja u realnom vremenu (prolaz kroz kapiju)

Dva režima (biramo jedan):

- **HTTP-host / „listening" (PREPORUKA):** uređaju se zada NAŠ IP:port, i on **sam POST-uje** svaki
  prolaz na nas:
  ```
  PUT /ISAPI/Event/notification/httpHosts/1
  { "HttpHostNotification": { "id":"1", "url":"http://<nas-host>:<port>/hik",
    "protocolType":"HTTP", "parameterFormatType":"JSON", "addressingFormatType":"ipaddress",
    "ipAddress":"<nas-ip>", "portNo":<port>, "httpAuthenticationMethod":"none" } }
  ```
- **Polling (fallback):** `POST /ISAPI/AccessControl/AcsEvent?format=json` sa vremenskim opsegom.
  - `major=5` (access control); `minor`: **38**=kartica OK, **75**=lice OK, **113**=otisak OK, 27=izlazni taster.
  - Paginacija: `searchID` + `searchResultPosition` + `maxResults`.

Provera podrške: `GET /ISAPI/Event/notification/httpHosts/capabilities` → ako postoji
`<HttpHostNotificationCap>true` → uređaj podržava push.

### 2b. Upis osoba i lica na uređaj (da ne unosimo ručno 100+ ljudi)

- Osoba: `POST /ISAPI/AccessControl/UserInfo/Record?format=json` — `employeeNo`, ime, `Valid`,
  prava na vrata (`RightPlan`).
- Lice: `POST /ISAPI/Intelligent/FDLib/FaceDataRecord?format=json` — `multipart/form-data`,
  JPEG ≤ 200 KB, ≥ 80×80 px, jedno frontalno lice.
- Otisak: preko ISAPI capture / lokalno na uređaju.

### 2c. Autentikacija — zamka

**HTTP Digest** (MD5). **KRITIČNO: otklon sata > 5 min ruši Digest** → uređaj MORA imati **NTP**.

---

## 3. Kako se uklapa u NAŠ sistem

### 3a. Postojeći kapija-pipeline (zatečeno stanje)

- Tabela **`attendance_events`** (sy15-db) — ~485k događaja. Kolone: `employee_id` (uuid),
  `direction` (`in`/`out`/`break`/…), `event_ts_local` (naivni lokalni timestamp), `event_ts`,
  `badge_code`, `source`, `terminal_name`.
- Danas je puni **Katze** softver (`source='katze'`, terminali **Portir / Hala 5 / Hala 7 /
  Kontroler05-06**, smerovi in/out/break). `source='katze_manual'` = ručne korekcije.
- **Katze NE radi na ubuntusrv (.28)** — to je zaseban vendorski sistem koji piše u sy15-db spolja.
- Pomoćne tabele: `employee_badges` (kartice: `code` decimalni / `code_short` hex = `attendance_events.badge_code`),
  `katze_employee_map`, `attendance_corrections`, view-ovi `v_attendance_*`.

### 3b. Naš oslonac (zašto je lako)

- **`worker_employee_map`** (2.0 PG, deploy 37360e0, 72 mapiranja): 2.0 `workers.id` → sy15
  `employees.id` (uuid). Ključ mapiranja: `workers.card_id` = `employee_badges[card].code`.
- **Q11 auto-close** (`SessionAutoCloseService`, deploy 143204b) čita `attendance_events` po
  `employee_id` + `direction='out'` → zatvara viseće sesije vremenom izlaska. **Ne zna i ne mari
  koji je metod identifikacije bio.**

---

## 4. Dva puta integracije

### Put A — preko Katze (ako vendor podržava Hikvision)
Registruje se Hikvision terminal u Katze, Katze ga puni → `attendance_events` (`source='katze'`,
novi `terminal_name`). **Nula koda kod nas.**
→ **AKCIJA: pitati Katze vendora da li podržava Hikvision ISAPI uređaje.**

### Put B — naš most `hikvision-bridge` (ono što MI kontrolišemo)
Mali servis (systemd na ubuntusrv, isti obrazac kao `pdm-bridge`):
1. **Sluša** Hikvision push (`/hik`) ILI **polla** `AcsEvent`.
2. **Razreši `employee_id`** iz `employeeNo` u događaju.
3. **`INSERT` u `attendance_events`** (`source='hikvision'`, `terminal_name` = ulaz/izlaz →
   `direction`), **idempotentno** (dedup po serijskom broju događaja uređaja).

Sve nizvodno (Q11, evidencija) radi netaknuto jer čita istu tabelu.

---

## 5. Mapiranje događaj → radnik (ključni trik)

Problem: kartica-događaj nosi broj kartice, ali **lice/otisak/QR nose samo `employeeNo`** (interni ID
osobe na uređaju). Rešenje:

> **Svakog radnika upisati na Hikvision sa `employeeNo` = njegov POSTOJEĆI broj kartice**
> (iz `employee_badges`). Tada SVI tipovi događaja (lice/otisak/QR/kartica) nose isti `employeeNo`,
> i razrešavamo ih kroz **postojeće mapiranje kartica → `employee_id`**. Bez novog mapiranja.

(Alternativa: `employeeNo` = neki drugi stabilan ključ + tabela `hikvision_employeeNo → employee_id`.
Zamka: `employee_id` je UUID = 36 znakova; Hikvision `employeeNo` je obično ≤ 32 → UUID sa crticama
NE staje. Zato je broj kartice bolji ključ.)

### Smer (in/out)
- **Dva uređaja** (jedan ulaz, jedan izlaz) → `terminal_name`/`httpHost` određuje `direction`. **ILI**
- **Jedan uređaj sa dva čitača** (ulazni + izlazni preko Wiegand/RS-485) → čitač u događaju određuje smer.
→ **AKCIJA (odluka pri montaži): jedan uređaj + dva čitača, ili dva uređaja?**

---

## 6. Checklist — šta je spremno, šta se priprema

### ✅ Već spremno (bez uređaja)
- Ključ na `employee_id` (osoba, ne metod) — cela evidencija generička.
- `worker_employee_map` (72), `employee_badges` (kartice) — mapiranje živo.
- Q11 auto-close radi na generičkom `attendance_events` → Face/otisak/QR rade nepromenjeno.

### 🔧 Da se pripremi u ovom repou (pre/bez uređaja)
- [ ] **`hikvision-bridge` skeleton** — HTTP listener + ISAPI JSON parser + `employeeNo→employee_id`
      resolver + idempotentan insert u `attendance_events`. Radi „na prazno" dok uređaj ne dođe.
- [ ] Rezervisati `source='hikvision'` + konvenciju `terminal_name` (`Kapija-ulaz` / `Kapija-izlaz`).
- [ ] **Enrollment skripta** (ISAPI batch) — iz baze zaposlenih upiše osobe (`employeeNo`=broj kartice)
      + lica na uređaj pri prvom priključivanju.
- [ ] Idempotencija/dedup po serijskom broju događaja (uređaj ima offline bafer 150k → moguće ponavljanje).

### 🧩 Pri instalaciji (traži uređaj / odluku / vendora)
- [ ] Potvrditi model sa nalepnice (D vs **DF**).
- [ ] Statički IP na LAN-u; **NTP** (obavezno za Digest); PoE switch port; firewall ubuntusrv↔uređaj.
- [ ] Odluka: jedan uređaj + dva čitača **ili** dva uređaja (ulaz/izlaz) → `direction`.
- [ ] Pitati **Katze vendora** za Hikvision podršku (ako da → Put A, još lakše).
- [ ] Enroll lica: izvor fotografija (baza zaposlenih? na licu mesta na uređaju?).

---

## 7. Pametne kamere (šire) — ista arhitektura

Hikvision AI kamere (analitika: prolazak, prepoznavanje, brojanje…) koriste **isti ISAPI + event
push** obrazac. Kad se budu dodavale:
- Isti `hikvision-bridge` prima njihove event-e (drugi `major/minor` kodovi).
- Ako je događaj vezan za osobu → ide u istu logiku razrešavanja `employee_id`.
- Ako je operativni/bezbednosni (ne-personalni) → zaseban tok/tabela (van evidencije prisustva).

Time je jedan most dovoljan za celu Hikvision familiju (kapija + kamere).

---

## 8. Otvorena pitanja (za Nenada / vendore)

1. **Model** — DS-K1T680**D** ili **DF** (nalepnica)?
2. **Topologija smera** — jedan uređaj + dva čitača, ili dva uređaja (ulaz/izlaz)?
3. **Katze** — da li vendor podržava Hikvision (Put A) ili idemo naš most (Put B)?
4. **Enrollment lica** — odakle fotografije, ko upisuje (batch iz baze vs ručno na uređaju)?
5. **Kartice** — zadržavamo postojeće kartice na Hikvision-u (`employeeNo`=broj kartice)?

---

## 9. Izvori

- Hikvision DS-K1T680DF-E1 datasheet — <https://download.discomp.cz/hikvision/datasheets/DS-K1T680DF-E1.pdf>
- Hikvision DS-K1T680 serija (proizvod) — <https://www.hikvision.com/en/products/Access-Control-Products/Face-Recognition-Terminals/Ultra-Series/ds-k1t680df-e1/>
- ISAPI best-practices (event push, AcsEvent, UserInfo/FDLib) — <https://github.com/uchkunr/hikvision-best-practices>
- Hikvision „real-time event in listening mode" — <https://www.hikvisioneurope.com/eu/portal/portal/Technology%20Partner%20Program/03-How%20to/How%20to%20get%20real-time%20event%20in%20listening%20mode.pdf>
- ISAPI AcsEvent (TPP wiki) — <https://tpp.hikvision.com/Wiki/ISAPI/Access%20Control%20on%20Person/GUID-7A5623B0-9906-4959-9E98-3BDEA9DE4024.html>

---

*Povezano: Q11 auto-close (`backend` — SessionAutoCloseService), `worker_employee_map`,
`attendance_events` (sy15-db). Vidi memoriju `tehnologija-analiza-odluke-vlasnika`.*

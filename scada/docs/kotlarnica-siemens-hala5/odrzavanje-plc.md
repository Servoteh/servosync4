# Održavanje PLC programa — Siemens Hala 5 (TIA Portal)

> ⚠️ **Nacrt** — opšti postupak za TIA Portal projekat; specifičnosti ove instalacije
> označene `[POTVRDITI]`/`[DOPUNITI]`. Radi samo osoba obučena za Siemens TIA.

## Alat

- **Siemens TIA Portal v16** (projekat je `.ap16`, verzija 1600.0.3102.1 — otvara se baš v16
  ili novijim, ne starijim). Potreban paket: **STEP 7 Basic** (za S7-1200). HMI/WinCC nije
  neophodan jer nema panela (nadzor je preko web servera CPU-a).
- Veza ka PLC-u: Ethernet/PROFINET na `192.168.11.8`. PC mora biti u istom opsegu
  (`192.168.11.x`, maska `[POTVRDITI — verovatno 255.255.255.0]`).

## Hardver (potvrđeno iz projekta `PEData.plf`)

- **CPU:** S7-1200, **CPU 1214C DC/DC/DC**, MLFB **6ES7 214-1AG40-0XB0**, **FW V4.4**.
  Ime stanice u projektu: `plc_1`. On-board: AI 2, DI 14 / DQ 10.
- **Distribuirani I/O — ET 200SP** preko PROFINET-a (stanica „ET 200SP station_1"):
  IM 155-6 PN (`6ES7 155-6AR00-0AN0`, V3.2) + BusAdapter `6ES7 193-6AR00-0AA0`;
  3× DI 16 (`6ES7 131-6BH01-0BA0`), 2× AI 4xRTD/TC (`6ES7 134-6JD00-0CA1`),
  2× DQ 16 (`6ES7 132-6BH01-0BA0`), server modul `6ES7 193-6PA00-0AA0`.
- CPU ima i **OPC UA server** kao opciju (najlakši put za buduću SCADA integraciju).
- Kompletna mapa tagova sa adresama: vidi [README.md](README.md) („Mapa tagova").

## Projekat

- Putanja: `TIA KOTLARNICA HALA 5/4.2..2026. FINALNA VERZIJA Termoregulacija hala TIA (izmenjena IP adresa)/Termoregulacija hala TIA.ap16`
- Otvori **ceo folder projekta** (ne samo `.ap16` bez pratećih foldera).
- Naziv „FINALNA VERZIJA / izmenjena IP adresa" → ovo je referentna verzija. `[POTVRDITI da je identična onome u PLC-u]`

## Backup PRE svake izmene (obavezno)

1. **Upload from device** (PLC → PC) u TIA Portal i snimi kao novu verziju projekta sa datumom.
2. Po mogućstvu i **Memory Card image** / arhiva (`Project → Archive…`) na siguran disk.
3. Zabeleži: ko, kada, zašto.

## Učitavanje u PLC (download)

1. Otvori projekat, izaberi PLC u stablu.
2. **Compile** (proveri greške) → **Download to device**.
3. Tokom download-a PLC prelazi u STOP → **regulacija staje**; radi van grejnog termina kad može.
4. Po download-u: **Go online**, proveri da nema dijagnostičkih grešaka (žute/crvene oznake),
   da se temperature čitaju i izlazi reaguju.

## HMI / web server

- **Nema fizičkog HMI panela** — operatorski interfejs je **web server CPU-a**
  (`/awp/Servoteh/...`). Web server je aktivan, sa automatskim osvežavanjem.
- Izvori web stranica su u folderu projekta: **`…/UserFiles/`**
  (`start.html` — glavni ekran, `update_page.html` — periodično čitanje, `stylesheet.css`,
  `java.js`, slike). Te stranice se u TIA Portalu učitavaju kroz **Web server → User-defined
  pages** (HTML directory = `UserFiles`, default page = `start.html`), pa se generiše
  „Web DB" (DB `Web` / `DB_WWW`) i ponovo download-uje u CPU.
- AWP komentari u `start.html`/`update_page.html` (`AWP_In_Variable`, `:="Web".Tag:`)
  povezuju HTML sa promenljivama iz DB-a `Web`.
- Posle izmene web stranica → ponovo prihvati sertifikat u Firefox-u ako se promeni.

## Mreža i bezbednost

- [ ] Promeniti default `admin/admin` web lozinku. `[POTVRDITI status]`
- [ ] Ne izlagati web server direktno na internet — samo lokalno / VPN / Cloudflare Access.
- IP plan: CPU `plc_1` = `192.168.11.8` (aktuelno); ET 200SP je PROFINET IO uređaj na istom
  CPU interfejsu (ime stanice `[POTVRDITI u TIA]`). U projektu ostaje stari trag `192.168.75.x`
  (folder je „izmenjena IP adresa") → `[POTVRDITI maska/gateway u TIA → Device config]`.

## Rutinsko održavanje

- [ ] PLC i mrežna oprema na **UPS-u**.
- [ ] Provera datuma/sata CPU-a (raspored zavisi od tačnog vremena).
- [ ] Periodičan backup projekta (bar pre svake grejne sezone).
- [ ] Provera dijagnostičkog buffera CPU-a (`Online & diagnostics`) za skrivene greške.

## Kontrolna lista pre/posle intervencije

**Pre:** backup projekta ✔ · upload from device ✔ · zapisano šta se menja ✔
**Posle:** compile bez grešaka ✔ · download ok ✔ · online bez dijagnostike ✔ ·
temperature/izlazi ok ✔ · web pristup radi ✔ · nova verzija snimljena sa datumom ✔

---

### TODO za kompletiranje ove dokumentacije `[DOPUNITI]`
- ~~Model CPU-a + I/O lista~~ → urađeno (vidi README: CPU 1214C 6ES7 214-1AG40-0XB0 V4.4 + ET 200SP).
- ~~Mapa DB tagova (merenja, komande)~~ → urađeno (README „Mapa tagova"). Ostaju **default
  brojčane vrednosti** setpointa/tolerancije/vremena (vide se samo u TIA Portalu).
- ~~Lista alarma~~ → urađeno (README „Spisak alarma", AlarmW1/W2/W3). Postupci `[DOPUNITI]`.
- Raspored/sat uključenja kotla u automatskom režimu (logika je potvrđena, brojevi nisu).
- Mapiranje sondi na kanale AI modula `6ES7 134-…` i tip sonde (PT100/PT1000/TC) `[POTVRDITI]`.
- Plan integracije u zajedničku SCADA aplikaciju — **CPU ima OPC UA server** (preporučeno),
  alternativa S7comm. Modbus nije konfigurisan u projektu.

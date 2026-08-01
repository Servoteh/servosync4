# Dijagnostika i česti problemi — SCADA aplikacija

## Brza provera „je li živo"

```powershell
Get-Service "Kotlarnica SCADA"                 # Status: Running?
Test-NetConnection 192.168.75.25 -Port 502     # TcpTestSucceeded: True?
```
- Web na VM-u: `http://localhost:3000` → indikator gore pokazuje **online / simulacija**.
- Logovi servisa: **Event Viewer → Applications and Services Logs → „Kotlarnica SCADA"**.
- Ručno pokretanje radi gledanja logova uživo:
  ```powershell
  Stop-Service "Kotlarnica SCADA"
  cd C:\Servoteh\Scada_PLC\app
  node server.js          # poruke [PLC] povezan / greška idu u konzolu
  ```

---

## Problemi i rešenja

### PLC „offline" u UI / očitavanja padaju
1. `Test-NetConnection 192.168.75.25 -Port 502` — ako `False`: mreža/VM nije na PLC segmentu,
   PLC ugašen ili kabl. Reši mrežu prvo.
2. **Dvostruka veza** — Jazz dozvoljava **samo 1 TCP vezu**. Proveri da nije:
   - pokrenut još jedan SCADA servis / `node server.js` na drugoj mašini,
   - neko otvorio **U90 Ladder online** ka PLC-u,
   - ostao „viseći" socket. Servis ima kratak connect-timeout (4 s) baš da ne guši Jazz,
     ali dva stalna klijenta će se otimati. Ugasi višak.
3. Restart servisa: `Stop-Service` → `Start-Service "Kotlarnica SCADA"`.

### „connect timeout" / „PCOM timeout" u logu
- `connect timeout` (4 s): PLC ne prihvata TCP — ugašen, zauzet drugom vezom, ili mreža.
- `PCOM timeout` (1.5 s): veza otvorena ali PLC ne odgovara na frame — proveri Unit ID
  (`PLC_UNIT`) i da li je još neko na vezi. Servis čeka 8 s pre novog pokušaja (backoff).

### Vrednost temperature je 10× pogrešna
- PLC čuva temperature **×10**. U [`app/tags.js`](../../app/tags.js) tag mora imati `scale:10`.
  Fali → prikaz je 10× veći; višak → 10× manji.

### Satnica rasporeda pogrešna / „čudan broj"
- Satnice su **BCD** u 16-bit registru (vidi [mapa-registara](../kotlarnica-unitronics/mapa-registara.md)).
  Konverziju radi `bcdToHHMM`/`hhmmToBcd` u `server.js`. Unosi se `HH:MM`, ne sirov broj.

### Upis ne prolazi (403 / „tag je samo za citanje")
- Samo tagovi sa `access:'rw'` su upisivi (setpointi, režimi, ručne komande, reset VFD).
  Statusi/merenja su read-only po dizajnu.

### Reset frekventnog ne „ostaje"
- To je **momentary** komanda (`O18`): servis je sam vrati na 0 posle ~0.6 s. Tako i treba.

### Telegram alarmi ne stižu
- Proveri `ALERT_TELEGRAM_BOT_TOKEN` i `ALERT_TELEGRAM_CHAT_ID` u `.env`.
- Alarm se šalje na **ivicu 0→1** (kad alarm tek nastane), ne ponavlja se dok traje.
- U logu na startu piše: `Telegram alarmi: aktivni / isključeni (nema tokena)`.

### Solarna elektrana (blue'Log): invertor „ne javlja" / alarm na loggeru
- Ekran **Solar KACO** ima crveni baner sa brojem aktivnih alarma, kodom, portom i
  **koliko kvar traje**; kartica invertora dobija red „Alarm". Isti podaci su u
  `GET /api/bluelog` → `alarms[]` i `plant.alarmsActive / loggerAlarm`.
- Najčešći kod: **`NOCOMM_RS485`** — invertor je otpao sa RS485 magistrale. Ako više
  invertora otpadne **u istom minutu**, to nije kvar invertora nego **prekid magistrale
  ili zajedničkog napajanja** — proveri lanac iza poslednjeg invertora koji se javlja.
- Dok logger ne vidi invertore, ne može im poslati ni **korekcionu vrednost (setpoint)**
  regulacije aktivne snage — otud i poruka *„Communication error on an interface for
  correction value transmission"*. Ona je **posledica**, uzrok se traži na magistrali.
- Dojava (Telegram): alarm ide odmah kad ga logger prijavi; rezerva je
  `BLUELOG_OFFLINE_MIN` (invertor bez ijedne vrednosti toliko minuta).

  > **Presedan 28–29.07.2026.:** 5 od 6 invertora otpalo u 23:08:00 (u razmaku od 50 ms),
  > kvar primećen tek sutradan uveče — dnevni prinos 32 kWh umesto ~1.650 kWh.
  > Zbog toga su i uvedeni baner i dojava.

### Ne mogu da pročitam listu alarma sa loggera (HTTP 400)
- `POST /alarm/alarms` **mora** imati i polje `language`, inače vraća
  `400 WEB_SERVER_INVALID_REQUEST_DATA`. Ispravno telo:
  `{"dateRange":{"min":<epoch ms>,"max":<epoch ms>},"language":"en"}`.
- Aktivan alarm = zapis **bez** polja `end`. Vidi `app/bluelog/bluelog.js` → `getAlarms()`.

### Sigenergy: sistem se ne vidi / pojavio se novi
- Lista sistema se **sama preuzima sa naloga** i osvežava (`SIGEN_DISCOVER_MS`, 6 h);
  `SIGEN_SYSTEM_ID` je samo seed/fallback. Nov sistem uđe sam i javi se na Telegram.
- `SIGEN_SYSTEM_LOCK=true` isključuje auto-dodavanje (čita se samo ono iz `.env`).
- U logu na startu: `[Sigen] N sistem(a): ime (id), …`.

  > **Presedan 06.07.2026.:** Sigenergy je „Servoteh_110" razdvojio na dva sistema
  > (135 kWp + novi 110 kWp). Fiksna lista u `.env` novi sistem nije obuhvatila, pa
  > ~970 kWh/dan ~3 nedelje nije bilo u evidenciji.

### Web radi lokalno ali ne spolja
- Proveri `cloudflared` servis: `Get-Service cloudflared` / logove tunela.
- Proveri Cloudflare Access policy (da je tvoj e-mail dozvoljen).
- DNS zapis `kotlarnica.<domen>` mora pokazivati na tunel.

### Istorija/trendovi prazni posle restarta
- Istorija je lokalni `app/data/history.json` (24 h, periodičan upis na 5 min + na gašenje).
  Posle čistog restarta puni se iznova; nije kvar.

---

## Kad je problem na PLC strani (ne na aplikaciji)
Ako je veza OK i servis radi, ali **uređaji ne reaguju / zona se ne greje**, problem je u
PLC/postrojenju, ne u aplikaciji → vidi
[kotlarnica-unitronics/alarmi-i-kvarovi.md](../kotlarnica-unitronics/alarmi-i-kvarovi.md).

## Kontakti / eskalacija `[POTVRDITI]`
- Aplikacija/VM/Cloudflare: `[POTVRDITI]`
- PLC Unitronics: `[POTVRDITI]`
- Mreža/infra: `[POTVRDITI]`

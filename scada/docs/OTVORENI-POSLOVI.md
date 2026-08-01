# Energetika — otvoreni i planirani poslovi

Jedno mesto za „gde smo stali". Svaka stavka ima **šta znamo**, **zašto je bitno** i
**sledeći korak**, da se pri nastavku ne kreće od nule. Kad se nešto završi — premesti u
„Urađeno" sa datumom i komitom. Kad se nešto odbije — premesti u „Odbijeno" **sa razlogom**,
da se ne predlaže ponovo.

Opis modula i komunikacije: [00-pregled-i-mreza.md](00-pregled-i-mreza.md).

---

## 🔴 Otvoreno — košta ili blokira

### 1. Kotlarnica 2: šest „ispada zaštitne sklopke" trepće ~68 puta dnevno

**Znamo:** `W4.0`, `W4.4`, `W4.5`, `W4.6`, `W4.12`, `W5.0` — svaki podignut **1839 puta**
od 02.07.2026. (plus `W1.6`, 1835 puta, poslednji 27.07). Pale se i gase po ceo dan.

**Zašto je bitno:** to je jedini razlog što kotlarnice **nisu** na mejl-dojavi. Da su
uključene, stiglo bi nekoliko stotina poruka dnevno i niko ih ne bi čitao.

**Sledeći korak:** utvrditi da li sklopke stvarno ispadaju ili se bitovi čitaju pogrešno
(ista klasa problema kao mrtve sonde na kot1 — vidi #2). Kad znamo koji su stvarni, dodaju
se u `ALERT_MAIL_CODES` u `.env` gateway-a, bez izmene koda.

```sql
select code, count(*) puta, min(raised_at)::date prvi, max(raised_at)::date poslednji
from scada_alarms where site_key='kot2' and raised_at > now()-interval '30 days'
group by code order by puta desc;
```

### 2. Kotlarnica 1: sonde / analogna kartica ne rade (nasleđeno)

**Znamo:** vlasnik potvrdio 30.07.2026. `T_SPOLJA` stoji na 8,3 °C — 14.389 uzoraka kroz
10 dana, **jedna jedina vrednost**; hale pokazuju 2–3 °C u julu. Komunikacija je ispravna
(PCOM povezan), poller radi, mapa registara nije pomerena.

**⛔ Ne dijagnostikovati ponovo i ne resetovati PLC.** Detalji i merljiv otisak:
[kotlarnica-unitronics/alarmi-i-kvarovi.md §D1](kotlarnica-unitronics/alarmi-i-kvarovi.md).

**Sledeći korak:** servis analogne kartice/sondi u pogonu. Do tada ERP prikazuje te brojeve
kao ispravne — vredi razmisliti o oznaci „merenje nepouzdano" na kot1 ekranu.

**Podstavka koja NE spada u priču o sondama:** `SP_SUDA_H` čita 4,5 a `SP_SUDA_L` 10,5
(umesto ~80 / 60), `SP_SPOLJA` 5 umesto 18. To su **zadate vrednosti** koje operater
upisuje u MI registre, ne analogni ulazi — mrtva kartica ih ne objašnjava. Bitno jer HMI
ume i da **piše** setpointe: ako je taj deo mape pomeren, upis sa ekrana ide u pogrešan
registar. Proveriti pre nego što neko menja setpoint na kot1.

### 3. Šta regulacija radi kad ne može da isporuči setpoint

**Znamo:** 29.07. je pet invertora otpalo sa magistrale, ali je i **preživeli** invertor
dao 32 kWh umesto ~260, i od podneva okruglu nulu — iako je uredno komunicirao.
Najverovatnije objašnjenje: logger je master regulacije aktivne snage i, kad ne može da
isporuči korekcionu vrednost, primenjuje bezbedno ograničenje na sve što dohvati.

**Zašto je bitno:** ako je tako, prekid na magistrali košta **celu** elektranu (~1.600 kWh)
umesto 5/6 (~270 kWh). Razlika je oko 1.300 kWh po danu kvara.

**Sledeći korak:** pogledati podešavanje fallback-a u regulaciji na blue'Log-u — bira li se
između „stani sve" i „drži poslednju vrednost". **Ne menjati bez vlasnika** (tiče se
saglasnosti za priključenje).

---

## 🟡 Otvoreno — tehnički dug

### 4. HMI ekrani: šest fajlova namerno razdvojeno

`kot1.js`, `kot2.{js,html}`, `kot3.{js,html}`, `overview.js` razlikuju se između
`scada/public/` (LAN) i `frontend/public/scada-hmi/` (ERP): async modal `__scadaConfirm`
umesto `confirm()`, trend grafik, prikaz svežine snapshot-a.

Kapija protiv **novog** razilaženja radi (`scada/scripts/hmi-drift.mjs` + `ci-scada.yml`).
Pun spoj bi tražio da se `__scadaConfirm` i trend grafik prebace u izvor sa fallback-om kad
nema ljuske — refaktor tri ekrana koji traži probu i na LAN-u i u ERP-u.

### 5. Isporuka je ručna

`scp` + `systemctl --user restart`, bez CI. Zamka: `scp` sa Windowsa unosi CRLF (recept u
[../CLAUDE.md](../CLAUDE.md)). Ideja: workflow koji na push u `scada/**` / `bridge/**`
isporuči na ubuntusrv — traži SSH ključ u secrets ili self-hosted runner.

### 6. Web push — ne zna se da li uopšte radi

Triger `scada_alarm_push_trg` na `scada_alarms` zove edge funkciju `push-dispatch`, a
`scada_notify_prefs` je **prazan** (0 redova) — što znači podrazumevano „svi admin/menadzment
dobijaju sve severity ≤ 3". Nikad nije potvrđeno da push stiže.

**Sledeći korak:** ili proveriti i podesiti prefs, ili ugasiti triger da ne visi kao mrtav
kanal koji se ne prati.

---

## ⚪ Prati se

- **Sigen `Servoteh_110 (2)`** povremeno vraća `1001 rpc fail` na `energyFlow`; dnevni
  brojači stižu uredno. Stale badge to prikazuje. Ako se ne smiri — prijaviti Sigenergy-ju.
- **Kotlarnice na mejl-dojavi** — čeka #1.

---

## ❌ Odbijeno

- **„Nula proizvodnje po danu → alarm"** (30.07.2026, Nenad): *„zbuniće zimi"* — sneg,
  decembar/januar. Posledica koju treba znati: ako svih 6 invertora komunicira a elektrana
  daje 0 kW, mejl **ne stiže**. Tako je bilo 29.07. sa preživelim invertorom (v. #3).

---

## ✅ Urađeno

**29.07.2026 — dojava i vidljivost** (`1375f25`)
- Čitanje alarma sa blue'Log-a. Zamka: `POST /alarm/alarms` traži i polje `language`, bez
  njega vraća 400. Aktivan alarm = zapis bez `end`.
- Telegram dojava po postrojenju, sa gašenjem alarma; rezerva „invertor ne javlja > 15 min".
- Sigen: lista sistema se preuzima sa naloga (novi sistem ulazi sam). Time je uhvaćen
  `Servoteh_110 (2)` koji je ~3 nedelje bio van evidencije (~970 kWh/dan).
- Solar KACO ekran: baner kvara, alarm na kartici invertora, stanje regulacije u rezimeu.
- Most pravi ERP alarm **po uređaju** (`NOCOMM_RS485:INV2`) umesto jednog opšteg.

**29–30.07.2026 — konsolidacija u 4.0**
- `scada/` (gateway) i `bridge/` (relej + BigTehn sync) u monorepo (`1375f25`, `6c1d7452`).
- Obrisane duple kopije: `Scada_PLC` i `servoteh-plan-montaze/scada-app` (`27d6201`).
  PLC projekti prebačeni u `_legacy/scada-plc/` (van git-a).
- Repo `servoteh-bridge` **arhiviran** na GitHub-u (`8c9bb14` = poslednji komit, baner
  pokazuje na novi izvor).
- Ispravljena dokumentacija topologije: sve radi na ubuntusrv, Windows VM napušten
  (`826e75b`), + zamka sa CRLF pri isporuci (`26c163c5`).

**30.07.2026 — mejl i higijena ekrana**
- Mejl za kritično (`34163e79`): `NOCOMM_RS485` + pregrevanje invertora, tri brane protiv
  poplave, primaoci Nenad / Jovan Matić / Želimir Jovašević, transport Resend.
- HMI kopije poravnate 3-way merge-om + kapija protiv tihog razilaženja (`f8c04f2`):
  11 identično, 6 namerno razdvojeno, 0 neočekivanih.
- Zapisan nasleđeni kvar sondi na kot1 (`4f3772a`).

**Incident 28–29.07.2026 (rešen sam)** — pet od šest KACO invertora otpalo sa `BM_RS485_1`
u 23:08 (svih pet u razmaku od 44 ms = jedan događaj na vodu), vratili se 29.07. u 22:33,
trajalo 23 h 25 min. Gubitak ~1.600 kWh. Brojilo na drugom RS485 portu radilo je bez
prekida — to je i dokazalo da logger i mreža nisu bili u pitanju.

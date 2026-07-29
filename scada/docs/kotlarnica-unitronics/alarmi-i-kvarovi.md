# Alarmi i kvarovi — Unitronics Jazz

Dijagnostika i postupci za najčešće situacije. Redosled: **bezbedno → jednostavno → složeno.**

## Alarmni signali u PLC-u

| Alarm | Operand | Šta znači | Prvi korak |
|---|---|---|---|
| Alarm toplotne pumpe | `I4` | Greška/zaštita toplotne pumpe | Proveri pumpu i njenu zaštitu u ormaru |
| Zaštite (zbirno) | `I5` | Aktivirala se neka zaštita | Nađi koja (motorna zaštita, termik, presostat) |
| Alarmni izlaz | `O16` | Sirena/lampa upaljena (zbirni alarm) | Utvrdi uzrok iz I4/I5 i statusa |

Kad alarm pređe iz 0 → 1, SCADA šalje **Telegram** poruku (ako je podešen
`ALERT_TELEGRAM_*`). Vidi [scada-aplikacija/dijagnostika.md](../scada-aplikacija/dijagnostika.md).

---

## Scenariji

### A) Zona se ne greje (hladno iako traži grejanje)
1. Proveri u SCADA: da li je **PLC online**? (ako nije → vidi dijagnostiku aplikacije)
2. Da li je režim **AUTO** i **GREJANJE** (`MB14`, `MB26`)?
3. Da li je **raspored** aktivan u ovom trenutku (dan + satnica)?
4. Da li je merena temperatura stvarno ispod setpointa? (možda senzor pokazuje pogrešno)
5. Da li su **kotao** (`I6`) i **toplotna pumpa** (`I3`) u radu?
6. Proveri zonski izlaz (T1–T7) i uređaj (K/P) — da li je komandovan a ne radi → fizički kvar.

### B) Uređaj (kalorifer/pumpa) ne reaguje na komandu
1. Da li je glavni **ON/OFF** (`I15`) uključen?
2. Položaj **fizičkog prekidača** u ormaru (`I7–I14`) — možda je na „0"/lokalno.
3. U **RUČNO** režimu proveri da je toggle (`MB8–12` / `MB16–19`) zaista postavljen.
4. Motorna zaštita / termik uređaja u ormaru (može držati zaštitu `I5`).

### C) Frekventni regulator u grešci
1. Klikni **Reset greške frekventnog** (`O18`) u SCADA.
2. Ako se vrati: pročitaj kod greške direktno na VFD displeju (pre/podnapon, preopterećenje, pregrejavanje).
3. Proveri pogon koji VFD vrti (zaglavljena pumpa/ventilator, ležaj). `[POTVRDITI koji pogon]`

### D) Temperatura nerealna (npr. −50 °C ili +300 °C)
- Verovatno **senzor/ožičenje** (prekid ili kratak spoj na PT/termoparu).
- Proveri senzor i vezu na ulaz PLC-a. Do popravke tu zonu drži na RUČNO ako je potrebno grejanje.

### E) Senzor čita ×10 pogrešno / čudna skala
- Podsetnik: PLC čuva temperature **×10** (`235` = `23.5 °C`). SCADA to već deli. Ako neki
  novi tag pokazuje 10× veću/manju vrednost → fali/višak `scale:10` u [`app/tags.js`](../../app/tags.js).

---

## Kad zvati servis PLC-a

- Sumnja na kvar samog PLC-a (ne diže se, ulazi/izlazi mrtvi, gubi program).
- Potreba za izmenom **logike** (histereze, dodavanje zone, izmena rasporeda u ladder-u).
- Pre bilo kakve izmene programa: **backup `.U90`** (vidi [odrzavanje-plc.md](odrzavanje-plc.md)).

> Bezbednosno pravilo: u slučaju nejasnog ponašanja **ne ostavljaj sistem u RUČNO bez nadzora**.
> Vrati na AUTO čim je sigurno, ili isključi glavni ON/OFF ako postoji rizik.

# Održavanje PLC programa — Unitronics Jazz (U90 Ladder)

Kako se radi sa samim PLC programom: alat, backup, učitavanje i izmene. **Ovo radi samo
osoba obučena za PLC** — pogrešan upload može zaustaviti grejanje.

## Alat

- **U90 Ladder** (Unitronics) — programski alat za Jazz/M90/M91 seriju. Fajlovi su `.U90`.
  (Napomena: novije Vision serije koriste *VisiLogic*; Jazz koristi *U90 Ladder*.)
- Veza ka PLC-u: serijski (RS232) ili preko mreže/PCOM. `[POTVRDITI kako se vi kačite]`

## Fajlovi programa (u repozitorijumu)

| Fajl | Šta je |
|---|---|
| `program_29_06_2026.U90` | **Najnoviji** program (referentni „živi") |
| `program_31oc17.U90` | Stariji program (31.10.2017) — istorijski |
| `Ladder.U90` | Ladder izvor `[POTVRDITI da li je isti kao gornji]` |
| `Scada_servo_9.zip` | Arhiva starog ZView SCADA projekta |

> Drži ove fajlove pod verzijom (git) i/ili na sigurnom mrežnom disku. Ime fajla nek nosi datum.

## Backup PRE svake izmene (obavezno)

1. Poveži se na PLC iz U90 Ladder.
2. **Upload** (PLC → PC) trenutni program i snimi kao `program_<DD_MM_GGGG>.U90`.
3. Snimi kopiju i van ovog računara (mrežni disk / git push).
4. Zabeleži: ko, kada, zašto se menja.

## Učitavanje programa u PLC (download)

1. Otvori željeni `.U90` u U90 Ladder.
2. Proveri **komunikacione parametre** (Unit ID, mreža) — moraju odgovarati postavkama PLC-a.
3. **Download** (PC → PLC). Tokom toga PLC staje → grejanje pauzira; radi van sezone/grejnog termina ako možeš.
4. Po završetku proveri rad: temperature se osvežavaju, izlazi reaguju, alarmi čisti.

> ⚠️ **Pre download-a obavezno zatvori SCADA vezu** (PLC ima samo 1 TCP vezu). Vidi niže.

## Koegzistencija sa SCADA aplikacijom (VAŽNO)

Jazz dozvoljava **samo jednu TCP vezu**. SCADA servis na VM-u tu vezu drži stalno. Zato:

- Dok radiš **online/upload/download iz U90 Ladder preko mreže**, prvo **zaustavi SCADA servis**:
  ```powershell
  Stop-Service "Kotlarnica SCADA"
  ```
  Posle završetka ga vrati:
  ```powershell
  Start-Service "Kotlarnica SCADA"
  ```
- Ako se kačiš **serijski** (RS232) na PLC, mrežna PCOM veza obično ne smeta, ali je
  sigurnije svejedno zaustaviti servis tokom download-a. `[POTVRDITI vaš način veze]`

## Izmena adresiranja / tagova — sinhronizacija sa SCADA

Ako u programu **pomeriš operande** (npr. dodaš senzor, promeniš MI adresu), SCADA to neće
znati. Tada ažuriraj i mapu tagova:

- [`app/tags.js`](../../app/tags.js) — glavni izvor (operand → tip → skala → zona)
- [`docs/tagovi_kotlarnica.csv`](../tagovi_kotlarnica.csv) — pregledna tabela
- [mapa-registara.md](mapa-registara.md) — ova dokumentacija

Posle izmene: restart SCADA servisa i provera u UI da se nove vrednosti ispravno čitaju.

## Rutinsko održavanje

- [ ] PLC i VM na **UPS-u** (da kratak nestanak struje ne resetuje sistem).
- [ ] Periodičan backup programa (bar pre svake sezone grejanja).
- [ ] Provera datuma/sata u PLC-u (raspored zavisi od tačnog vremena). `[POTVRDITI ima li RTC]`
- [ ] Provera senzora (poređenje sa referentnim termometrom) jednom u sezoni.
- [ ] Vizuelni pregled ormara: stezaljke, motorne zaštite, kontaktori.

## Kontrolna lista pre/posle intervencije

**Pre:** backup ✔ · zapisano šta se menja ✔ · SCADA servis zaustavljen (ako ide mrežom) ✔
**Posle:** download ok ✔ · temperature se čitaju ✔ · izlazi reaguju ✔ · alarmi čisti ✔ ·
SCADA servis pokrenut i online ✔ · novi `.U90` snimljen sa datumom ✔

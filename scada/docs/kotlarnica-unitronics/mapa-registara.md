# Mapa registara / tagova — Unitronics Jazz

Kompletna mapa operanada PLC-a kako ih čita/piše SCADA aplikacija. Izvor: živi PLC program
`program_29_06_2026.U90` + [`app/tags.js`](../../app/tags.js) + [`docs/tagovi_kotlarnica.csv`](../tagovi_kotlarnica.csv).

> **Skala:** temperature se u PLC-u čuvaju ×10 (npr. `235` = `23.5 °C`). SCADA deli sa 10 za prikaz.
> Oznake `[POTVRDITI]` su pretpostavke iz koda koje treba proveriti na terenu.

## Tipovi operanada (Unitronics)

| Tip | Značenje | Smer |
|---|---|---|
| `MI` | Memory Integer (16-bit registar) | čitanje/upis |
| `MB` | Memory Bit (interni bit/flag) | čitanje/upis |
| `I` | Input (digitalni ulaz / interni status bit) | samo čitanje |
| `O` | Output (digitalni izlaz) | čitanje (+ upis kod komandi) |

---

## 1) Merene temperature (MI, čitanje, ×10)

| Operand | Tag | Zona | Opis |
|---|---|---|---|
| `MI20` | T_SPOLJA | SPOLJA | Spoljna temperatura |
| `MI21` | T_SUDA | SUDA | Temperatura suda / HAP fluid |
| `MI22` | T_CNC | CNC | CNC radionica |
| `MI23` | T_ZAVAR | ZAVARIVANJE | Zavarivanje (nije na glavnom ekranu) |
| `MI24` | T_MONTAZA1 | MONTAZA | Montaža 1 |
| `MI25` | T_MONTAZA2 | MONTAZA | Montaža 2 |
| `MI26` | T_HIDRAULIKA | HIDRAULIKA | Hidraulika |

## 2) Zadate temperature / setpoint (MI, čitanje+upis, ×10)

| Operand | Tag | Zona | Opis |
|---|---|---|---|
| `MI30` | SP_SPOLJA | SPOLJA | Zadata spoljna (opis u programu: „ZADATA SPOLJNA TEMPERATURA") |
| `MI31` | SP_SUDA_H | SUDA | Zadata sud — gornja (opis: „ZADATA TEMPERATURA SUDA H") |
| `MI32` | SP_SUDA_L | SUDA | Zadata sud — donja (opis: „ZADATA TEMPERATURA SUDA L") |
| `MI33` | SP_MONTAZA | MONTAZA | Zadata montaža (opis: „ZADATA TEMPERATURA MONTAZA") |
| `MI34` | — | MONTAZA | Donji prag montaže = `MI33 − 3` (opis: „ZADATA TEMPERATURA MONTAZA -3") |
| `MI35` | SP_CNC | CNC | Zadata CNC (opis: „ZADATA TEMPERATURA CNC RADIONICA") |
| `MI36` | — | CNC | Donji prag CNC = `MI35 − 3` (opis: „ZADATA TEMPERATURA CNC RADIONICA -3") |
| `MI37` | SP_HIDRAULIKA | HIDRAULIKA | Zadata hidraulika (opis: „ZADATA TEMPERATURA HIDRAULIKA") |
| `MI38` | — | HIDRAULIKA | Donji prag hidraulika = `MI37 − 3` (opis: „ZADATA TEMPERATURA HIDRAULIKA -3") |
| `MI39` | SP_ZAVAR | ZAVARIVANJE | Zadata zavarivanje (opis: „ZADATA TEMPERATURA ZAVARIVANJE") |
| `MI40` | — | ZAVARIVANJE | Donji prag zavarivanje = `MI39 − 3` (opis: „ZADATA TEMPERATURA ZAVARIVANJE -3") |

> **Razrešeno (potvrđeno iz `program_29_06_2026.U90`):** parni „drugi pragovi" MI34/36/38/40
> su u tabeli operanada nazvani doslovno **„ZADATA TEMPERATURA … -3"**, a HMI ekran setpointa
> prikazuje sufiks **„h-3"**. To je **donja granica histereze grejanja** = zadata vrednost
> umanjena za 3 °C. Tj. zona greje dok merena temperatura ne padne ~3 °C ispod zadate, a gasi
> kad dostigne zadatu. To su **grejni** pragovi (ne rashladni). „SUD" je izuzetak: ima zasebne
> H i L setpointe (MI31/MI32) umesto sufiksa -3.
> Napomena: nije pronađen MI registar koji daje setpoint za SPOLJA (`MI30`) sa -3 sufiksom —
> spoljna se koristi kao referentna, bez para.

## 3) Raspored — aktivni dani (MI50–56, 0/1)

| Operand | Dan |
|---|---|
| `MI50` | Ponedeljak |
| `MI51` | Utorak |
| `MI52` | Sreda |
| `MI53` | Četvrtak |
| `MI54` | Petak |
| `MI55` | Subota |
| `MI56` | Nedelja |

`1` = dan aktivan (grejanje radi po satnici), `0` = neaktivan.

## 4) Raspored — satnice paljenja/gašenja (MI60–63, BCD HH:MM)

| Operand | Tag | Prozor | Ivica |
|---|---|---|---|
| `MI60` | T_PONPET_ON | PON–PET | uključenje |
| `MI61` | T_PONPET_OFF | PON–PET | isključenje |
| `MI62` | T_SUBNED_ON | SUB–NED | uključenje |
| `MI63` | T_SUBNED_OFF | SUB–NED | isključenje |

> **BCD format:** vreme je upakovano u 16-bit registar. Gornji bajt = sati (BCD),
> donji bajt = minuti (BCD). Npr. `0x0600` = `06:00`, `0x1800` = `18:00`.
> SCADA radi konverziju automatski (`bcdToHHMM` / `hhmmToBcd` u `server.js`).

> **Razrešena kolizija (potvrđeno iz `program_29_06_2026.U90`):** interpretacija „raspored/satnice"
> je **ispravna i aktuelna**; CSV opis „Frekventni regulator parametar" je **pogrešan** (vidi sekciju 10).
> Dokazi iz programa:
> - U tabeli operanada `MI60`, `MI61`, `MI62`, `MI63` **nemaju nikakav opis** (prazni su) — za razliku
>   od MI50–56 i MI30–40 koji imaju pune opise. Da su VFD parametri, imali bi naziv.
> - Program ima funkcionalan vremenski program: HMI ekrane **„PON-PET … RAD SAT"** i **„SUB-NED … RAD SAT"**,
>   string **„VREMENSKO UKLJUCENJE GREJANJA KOTLA"**, **„Za unos vremena rada sa skade Zview"**, te oznake
>   **„RADNI SATI PON-PET"** / **„RADNI SATI SUB NED"**. Dva prozora (PON-PET, SUB-NED) × dva vremena
>   (uključenje/isključenje) = 4 registra = MI60–63, tačno kako ih koristi `app/tags.js`.
> - Maska dana je MI50–56 (HMI ekran „ P U S C P S N"); satnice logično slede iza, kao MI60–63.
> - Jedina referenca na frekventni regulator u celom programu je status `I2` i reset `O18` — **nigde**
>   nije nađen MI parametar VFD-a, pa „Frekventni regulator parametar" iz CSV-a nije iz programa.

## 5) Uređaji — kaloriferi i pumpe (izlaz O = status)

| Operand | Tag | Uređaj | Zona | Ručno (MB) | Prekidač (I) |
|---|---|---|---|---|---|
| `O0` | K1 | Kalorifer 1 | MONTAZA | `MB8` | — |
| `O1` | K2 | Kalorifer 2 | MONTAZA | `MB9` | `I13` |
| `O2` | K3 | Kalorifer 3 | MONTAZA | `MB10` | `I12` |
| `O3` | K4 | Kalorifer 4 | CNC | `MB11` | `I11` |
| `O4` | K5 | Kalorifer 5 | HIDRAULIKA | `MB12` | — |
| `O5` | P1 | Pumpa Radionice | CNC | `MB16` | `I9` |
| `O6` | P2 | Pumpa Zavarivanje | ZAVARIVANJE | `MB17` | `I8` |
| `O7` | P3 | Pumpa Kancelarije | KANCELARIJE | `MB18` | `I7` |
| `O17` | P4 | Pumpa Montaža+Hidraulika | MONTAZA | `MB19` | — |

## 6) Zonski izlazi grejanja (O, čitanje)

| Operand | Tag | Zona |
|---|---|---|
| `O8` | T1 | SPOLJA |
| `O9` | T2 | SUDA |
| `O10` | T3 | CNC |
| `O11` | T4 | ZAVARIVANJE |
| `O12` | T5 | MONTAZA |
| `O13` | T6 | MONTAZA |
| `O14` | T7 | HIDRAULIKA |
| `O15` | T8 | REZERVA |

## 7) Statusi (I, čitanje)

| Operand | Tag | Opis |
|---|---|---|
| `I2` | FREKVENTNI_RUN | Frekventni regulator (VFD) radi (opis: „RUN FREKVENTNI REGULATOR") |
| `I3` | TOPLOTNA_PUMPA | Toplotna pumpa radi (opis: „RAD TOPLOTNE PUMPE") |
| `I6` | KOTAO_RAD | Kotao radi (opis: „KOTAO RAD") |
| `I15` | PREKIDAC_ONOFF | Glavni ON/OFF prekidač za pumpe i kalorifere (opis: „OFF/ON PREKIDAC") |
| `I16` | — | **P4 RAD PREKIDAC** (fizički prekidač pumpe P4), *ne* „automatski režim" (potvrđeno iz `program_29_06_2026.U90`) |

Fizički prekidači rada (povratna informacija položaja ručnog prekidača), opisi iz programa
„… RAD PREKIDAC": `I7` P3, `I8` P2, `I9` P1, `I10` K5, `I11` K4, `I12` K3, `I13` K2, `I14` K1,
**`I16` P4** (potvrđeno iz `program_29_06_2026.U90`). `I14` K1 nema poseban tag u `app/tags.js`.

## 8) Alarmi

| Operand | Tag | Opis |
|---|---|---|
| `I4` | ALARM_PUMPE | Alarm toplotne pumpe |
| `I5` | ALARM_ZASTITE | Zaštite (zbirni) |
| `O16` | ALARM_OUT | Alarmni izlaz (sirena/lampa) |

## 9) Režimi i komande (MB / O, upis)

| Operand | Tag | Opis | Tip upisa |
|---|---|---|---|
| `MB26` | GREJ_HLAD | GREJANJE / HLAĐENJE (opis: „bit za grejanje/hladjenje sa scade"). **Smer terenski potvrđen: `0`=GREJANJE, `1`=HLAĐENJE** | set/reset bit |
| `MB14` | AUTO_MAN | AUTO / RUČNO sa SCADA (opis: „scada auto/scada") | set/reset bit |
| `MB1` | — | Automatski režim rada (sa ekrana) — opis nije pronađen u tabeli operanada `[POTVRDITI]` |  |
| `O18` | RESET_VFD | Reset greške frekventnog regulatora (opis: „RESET GRESKE FREKVETNOG") | momentary (sam se vraća na 0 za ~0.6 s) |
| `MB8–12` | RK_K1..K5 | Ručna komanda kalorifera (opisi: „rucno sa scade K1…K5") | toggle |
| `MB16–19` | RK_P1..P4 | Ručna komanda pumpi (opisi: „rucno pumpa P1…P4") | toggle |

> **Potvrđeno iz `program_29_06_2026.U90`:** opisi MB8–12, MB14, MB16–19 i MB26 su gore navedeni
> doslovni nazivi iz tabele operanada. `MB14` je „auto/scada" prekidač (AUTO vs. ručno preko SCADA),
> a `MB26` je bit grejanje/hlađenje sa SCADA. **Smer bita (koja vrednost = grejanje vs. hlađenje,
> odn. auto vs. ručno) NIJE čitljiv iz tabele opisa** i nije ga moguće pouzdano izvući iz binarnog
> programa bez dekodiranja ladder logike — ostaje `[POTVRDITI na terenu]`.

## 10) Frekventni regulator — RAZREŠENO (potvrđeno iz `program_29_06_2026.U90`)

**Kolizija razrešena.** CSV opis `MI60–63` = „Frekventni regulator parametar" je **POGREŠAN
(stara pretpostavka)**. Tačna interpretacija je ona iz `app/tags.js`: **MI60–63 su satnice
rasporeda** (vidi sekciju 4).

Dokazi (ista slika i u `program_31oc17.U90` i u `program_29_06_2026.U90`):
- `MI60`, `MI61`, `MI62`, `MI63` u tabeli operanada **nemaju opis** — nisu označeni kao VFD parametri.
- Jedine reference na frekventni regulator u celom programu su **`I2` „RUN FREKVENTNI REGULATOR"**
  (status) i **`O18` „RESET GRESKE FREKVETNOG"** (reset). VFD nema ni jedan dodeljen MI registar.
- Postoji kompletan vremenski program (HMI ekrani „PON-PET / SUB-NED / RAD SAT", „VREMENSKO
  UKLJUCENJE GREJANJA KOTLA", „RADNI SATI PON-PET/SUB NED") za koji su MI60–63 prirodni nosioci.

**Zaključak:** MI60–63 su **bezbedni za upis kao satnice** (BCD HH:MM). Frekventni regulator se
prati preko `I2`, a greška se resetuje preko `O18`; nema MI parametara VFD-a koje SCADA treba da piše.

---

## Modbus/TCP slave — offset adresa

PLC je i Modbus slave (`SI214=1`). Ako se nekad bude pristupalo Modbus-om (a ne PCOM-om),
adresa se računa iz indeksa operanda:

| Tip operanda | Modbus objekat | Adresa | Funkcije |
|---|---|---|---|
| `MI` | Holding Register | `= index` | FC03 read / FC06,16 write |
| `MB` | Coil | `= index` | FC01 read / FC05 write |
| `I` | Coil (read-only) | `4000 + index` | FC01 read |
| `O` | Coil | `5000 + index` | FC01 read / FC05 write |

> Ako vrednosti budu pomerene za 1 → probati `+1` (Modbus je 1-based, Unitronics 0-based).
> SCADA aplikacija **ne** koristi Modbus, već PCOM — ovo je samo za eventualnu integraciju.

---

## Sirovi izvučeni opisi (referenca)

Sledeći nazivi su doslovno izvučeni iz tabele operanada unutar `program_29_06_2026.U90`
(`.U90` je ZIP arhiva sa deflate-kompresovanim unutrašnjim `Ladder.U90`; opisi su ASCII u formatu
`OPERAND` + tekst). Ovo je „izvor istine" za nazive operanada.

| Operand | Doslovni opis iz programa |
|---|---|
| `MI20` | SPOLJNA TEMPERATURA |
| `MI21` | TEMPERATURA SUDA |
| `MI22` | CNC RADIONICA |
| `MI23` | ZAVARIVANJE |
| `MI24` | MONTAZA 1 |
| `MI25` | MONTAZA 2 |
| `MI26` | HIDRAULIKA |
| `MI27` | REZERVA |
| `MI30` | ZADATA SPOLJNA TEMPERATURA |
| `MI31` | ZADATA TEMPERATURA SUDA H |
| `MI32` | ZADATA TEMPERATURA SUDA L |
| `MI33` | ZADATA TEMPERATURA MONTAZA |
| `MI34` | ZADATA TEMPERATURA MONTAZA -3 |
| `MI35` | ZADATA TEMPERATURA CNC RADIONICA |
| `MI36` | ZADATA TEMPERATURA CNC RADIONICA -3 |
| `MI37` | ZADATA TEMPERATURA HIDRAULIKA |
| `MI38` | ZADATA TEMPERATURA HIDRAULIKA -3 |
| `MI39` | ZADATA TEMPERATURA ZAVARIVANJE |
| `MI40` | ZADATA TEMPERATURA ZAVARIVANJE -3 |
| `MI50…MI56` | PONEDELJAK, UTORAK, SREDA, CETVRTAK, PETAK, SUBOTA, NEDELJA |
| `MI60…MI63` | *(bez opisa — satnice rasporeda; vidi sekciju 4 i 10)* |
| `MI10` / `MI11` | [AI 0: Analog (4-20mA)] / [AI 1: Analog (4-20mA)] |
| `MI12` / `MI13` | T1,T2,T3,T4 / T5,T6,T7,T8 (maske stanja izlaza) |
| `MI16` | hgh *(nejasan kratak naziv — nedokumentovano)* |
| `MB8…MB12` | rucno sa scade K1 … K5 |
| `MB14` | scada auto/scada |
| `MB16…MB19` | rucno pumpa P1 … P4 |
| `MB26` | bit za grejanje/hladjenje sa scade |
| `I2` | RUN FREKVENTNI REGULATOR |
| `I3` | RAD TOPLOTNE PUMPE |
| `I4` | ALARM TOPLOTNE PUMPE |
| `I5` | ZASTITE |
| `I6` | KOTAO RAD |
| `I7…I14` | P3 / P2 / P1 / K5 / K4 / K3 / K2 / K1 — „… RAD PREKIDAC" |
| `I15` | OFF/ON PREKIDAC |
| `I16` | P4 RAD PREKIDAC |
| `O0…O4` | KALORIFER 1 … 5 |
| `O5` / `O6` / `O7` | P1 RADIONICE / P2 ZAVARIVANJE / P3 KANCELARIJE |
| `O8…O15` | T1 SPOLJNA / T2 SUDA / T3 CNC / T4 ZAVARIVANJE / T5 MONTAZA 1 / T6 MONTAZA 2 / T7 HIDRAULIKA / T8 REZERVA |
| `O16` | ALARM |
| `O17` | P4 MONTAZA I HIDRAULIKA |
| `O18` | RESET GRESKE FREKVETNOG |

HMI ekrani (DS — display strings): „TEMPERATURE", „ZADATE VREDNOSTI", „AUTOMATSKI REZIM RADA",
„RADNI SATI PON-PET", „RADNI SATI SUB NED", „VREMENSKO UKLJUCENJE GREJANJA KOTLA",
„Za unos vremena rada sa skade Zview", „PON-PET / SUB-NED … RAD SAT", „ P U S C P S N" (maska dana).

> Sirovi `.strings.txt` i raspakovani `Ladder.U90` su privremeni artefakti ekstrakcije (van repo-a);
> postupak: `.U90` se otpakuje kao ZIP, pa se iz unutrašnjeg `Ladder.U90` izvuku ASCII stringovi.

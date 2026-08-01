# Logika rada — Unitronics Jazz

Kako PLC odlučuje šta da pali. Ovo je **rekonstrukcija iz tagova i SCADA koda** — za tačnu
logiku (histereze, kašnjenja, blokade) treba otvoriti `program_29_06_2026.U90` u U90 Ladder.
Delovi sa `[POTVRDITI]` nisu 100% sigurni dok se ne pogleda ladder.

## Zone

Hala je podeljena na zone; svaka ima merenu temperaturu, zadatu (setpoint) i izlaz grejanja:

| Zona | Merenje | Setpoint | Zonski izlaz | Uređaji |
|---|---|---|---|---|
| SPOLJA | MI20 | MI30 | T1 (O8) | — (referentna/spoljna) |
| SUD / HAP fluid | MI21 | MI31 (H) / MI32 (L) | T2 (O9) | — |
| CNC radionica | MI22 | MI35 | T3 (O10) | K4, P1 |
| Zavarivanje | MI23 | MI39 | T4 (O11) | P2 |
| Montaža | MI24 / MI25 | MI33 | T5 (O12), T6 (O13) | K1, K2, K3, P4 |
| Hidraulika | MI26 | MI37 | T7 (O14) | K5, P4 |
| Kancelarije | — | — | — | P3 |

## Osnovni princip regulacije

Za svaku zonu, pojednostavljeno:

```
ako (merena_temp ≤ zadata_temp − 3 °C)  → uključi grejanje zone (T/K/P)
ako (merena_temp ≥ zadata_temp)         → isključi grejanje zone
```

- **Potvrđeno iz `program_29_06_2026.U90`:** histereza je **3 °C**. Svaka zona (osim suda i spoljne)
  ima par registara: gornji = zadata (`MI33/35/37/39`), donji = zadata − 3 (`MI34/36/38/40`, u
  programu doslovno nazvani „ZADATA TEMPERATURA … -3", a HMI ekran pokazuje „h-3"). To je
  **dvopoložajna (ON/OFF) regulacija grejanja sa histerezom 3 °C** — pali ispod (zadata−3), gasi na zadatoj.
- SCADA **simulacija** koristi uži prag `setpoint − 0.3 °C` (`heatDemand` u `server.js`) — to je samo
  simulacija; **stvarni PLC koristi 3 °C** (donji pragovi MI34/36/38/40).
- „Sud" ima dva zasebna setpointa H i L (`MI31`/`MI32`) → **dvopoložajna regulacija** kotla/akumulacije:
  greje do H, gasi, ponovo pali ispod L (umesto fiksnih −3 °C).

## Režimi rada

### GREJANJE / HLAĐENJE — `MB26` (GREJ_HLAD)
Bira da li sistem greje ili hladi. Opis operanda u programu: **„bit za grejanje/hladjenje sa scade"**
(potvrđeno iz `program_29_06_2026.U90`). Menja se iz SCADA (uz potvrdu) ili sa lokalnog ekrana.
**Smer bita (potvrđeno terenskim testom — operater toggleovao):** `MB26 = 0` → **GREJANJE**,
`MB26 = 1` → **HLAĐENJE**. (U SCADA UI: 0 = narandžasto/grejanje, 1 = plavo/hlađenje.)

### AUTO / RUČNO — `MB14` (AUTO_MAN)
Opis operanda u programu: **„scada auto/scada"** (potvrđeno iz `program_29_06_2026.U90`).
- **AUTO:** PLC sam pali/gasi po temperaturi i rasporedu.
- **RUČNO/SCADA:** operater preuzima kontrolu; uređaji se pale/gase ručnim komandama (MB8–12 / MB16–19)
  ili fizičkim prekidačima u ormaru.
Uživo viđena vrednost je `MB14 = 0`. Tačan smer bita (`0 = auto` ili `0 = ručno`) `[POTVRDITI na terenu]`.

### Ručne komande uređaja — `MB8–12` (kaloriferi), `MB16–19` (pumpe)
Toggle bitovi; svaki forsira jedan uređaj. Opisi iz programa (potvrđeno iz `program_29_06_2026.U90`):
`MB8–12` = „rucno sa scade K1…K5", `MB16–19` = „rucno pumpa P1…P4". Povratna informacija o položaju
**fizičkog** prekidača u ormaru je na ulazima `I7–I14` (+ `I16` za P4). Ako se SCADA komanda i fizički
prekidač ne slažu, fizički prekidač/lokalna logika obično ima prednost. `[POTVRDITI ponašanje]`

## Raspored (vremenski program)

Grejanje radi samo u zadatim terminima, zasebno za radnu nedelju i vikend:

| | Uključenje | Isključenje |
|---|---|---|
| PON–PET | MI60 | MI61 |
| SUB–NED | MI62 | MI63 |

Plus maska aktivnih dana `MI50–56` (0/1 po danu). Satnice su u **BCD HH:MM** formatu
(vidi [mapa-registara.md](mapa-registara.md), sekcija 4).

> **Potvrđeno iz `program_29_06_2026.U90`:** raspored je realan deo programa — postoje HMI ekrani
> „PON-PET / SUB-NED … RAD SAT", maska dana „ P U S C P S N", te oznake „RADNI SATI PON-PET/SUB NED"
> i „VREMENSKO UKLJUCENJE GREJANJA KOTLA". MI60–63 (prazni opisi u tabeli operanada) služe upravo kao
> ove četiri satnice. Raniji CSV opis „Frekventni regulator parametar" za MI60–63 je **pogrešan** i
> razrešen je u korist rasporeda (vidi [mapa-registara.md](mapa-registara.md), sekcija 10).
> Primer podrazumevanih vrednosti iz simulacije: PON–PET 06:00–18:00, SUB–NED 07:00–22:00.
> Stvarne vrednosti pročitati iz PLC-a.

## Pomoćni pogon

- **Kotao** (`I6 KOTAO_RAD`) — izvor toplote; status se prikazuje, ne upravlja se iz SCADA.
- **Toplotna pumpa** (`I3`), alarm na `I4`.
- **Frekventni regulator / VFD** (`I2 FREKVENTNI_RUN`, opis „RUN FREKVENTNI REGULATOR") — greška se
  resetuje komandom `O18 RESET_VFD` (opis „RESET GRESKE FREKVETNOG", momentary dugme u SCADA).
  Potvrđeno iz `program_29_06_2026.U90`: VFD se u programu **prati samo** statusom `I2` i resetuje `O18`
  — **nema** nijednog MI registra (parametra) dodeljenog frekventnom regulatoru. Šta tačno VFD pokreće
  (pumpa/ventilator) nije zapisano u programu — `[POTVRDITI na terenu]`.
- **Glavni ON/OFF** (`I15`, opis „OFF/ON PREKIDAC") — opšti prekidač pumpi i kalorifera.

### Interni/pomoćni operandi nađeni u programu (nisu na SCADA, referenca)
- `MI10`/`MI11` — analogni ulazi „AI 0/1: Analog (4-20mA)" (verovatno sirovi ADC pre skaliranja u temperature).
- `MI12`/`MI13` — interne **maske stanja izlaza** („T1,T2,T3,T4" / „T5,T6,T7,T8").
- `MI16` — opis „hgh" (nejasan, kratak naziv; svrha nepoznata) `[POTVRDITI]`.
- `MI27` — „REZERVA" (rezervisano).
> Ovi operandi su pronađeni u tabeli operanada programa, ali ih SCADA aplikacija ne čita/piše.

## Alarmi (sažeto)

| Alarm | Operand | Akcija |
|---|---|---|
| Alarm toplotne pumpe | `I4` | SCADA šalje Telegram; vidi [alarmi-i-kvarovi.md](alarmi-i-kvarovi.md) |
| Zaštite (zbirno) | `I5` | proveriti uzrok u ormaru |
| Alarmni izlaz | `O16` | sirena/lampa aktivna |

> **Pre menjanja logike:** uvek prvo napravi backup `.U90` programa i pročitaj
> [odrzavanje-plc.md](odrzavanje-plc.md).

# Kotlarnica Unitronics (stara hala) — pregled

## Šta je to

Termoregulacija proizvodne hale po zonama, upravljana mikro PLC-om **Unitronics Jazz
JZ20-J-T40**. PLC meri temperature po zonama, poredi ih sa zadatim vrednostima i upravlja
**kaloriferima (K1–K5), pumpama (P1–P4) i zonskim ventilima/izlazima (T1–T7)**, uz
raspored rada po danima i satnici i izbor režima grejanje/hlađenje, auto/ručno.

Nadzor i upravljanje idu preko **SCADA web aplikacije** (Node servis na VM-u), koja je
zamenila stari **ZView**. Aplikacija sa PLC-om priča protokolom **PCOM/TCP** (isti koji je
koristio ZView/`drvjazz`).

## Osnovni podaci

| Stavka | Vrednost |
|---|---|
| Model PLC-a | Unitronics **Jazz JZ20-J-T40** |
| IP : port | `192.168.75.25 : 502` |
| Protokol (SCADA) | **PCOM/TCP** (ASCII frame, port 502) |
| Modbus slave | Aktivan (`SI214 = 1`) — vidi mapu offseta |
| Programski alat | **U90 Ladder** (Unitronics), fajlovi `.U90` |
| Aktuelni program (backup) | `program_29_06_2026.U90` (najnoviji), `Ladder.U90` |
| Broj dozvoljenih TCP veza | **1** (kritično — samo jedan klijent!) |

## Kako se povezuje (lanac)

```
Jazz JZ20-J-T40  ──PCOM/TCP (port 502, 1 veza)──►  Node SCADA servis (VM)  ──►  web UI
   merenja/izlazi                                   čita 1×/sek, piše na komandu
```

- SCADA servis čita ceo blok registara svake sekunde (`MI20–63`, `MB0–26`, `I0–15`, `O0–18`).
- Upis (promena setpointa, ručna komanda, režim) ide **samo na zahtev operatera**, uz potvrdu u UI.
- PLC **ne treba menjati** da bi SCADA radio — sva komunikacija je preko postojećih registara.

## Dalje čitaj

- [Mapa registara / tagova](mapa-registara.md) — tačno koji registar je šta
- [Logika rada](logika-rada.md) — kako PLC odlučuje šta da pali
- [Rad operatera](rad-operatera.md) — kako se koristi iz dana u dan
- [Alarmi i kvarovi](alarmi-i-kvarovi.md)
- [Održavanje PLC programa](odrzavanje-plc.md) — U90 Ladder, backup, izmene

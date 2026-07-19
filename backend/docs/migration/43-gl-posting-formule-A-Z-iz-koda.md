# BigBit GL kontiranje — A-Z formule + šeme (izvučeno iz koda, ne od knjigovođe)

> **Datum:** 2026-07-19. Izvor: BigBit .mdb kod/tabele (`_legacy/BigbitRaznoNenad/_extracted/`).
> Ovo je **Kapija 0 rešena iz koda** (dogovoreno: ne pitamo knjigovođu, sve je u BigBit-u).
> Seed za `AccountingScheme` + `AccountingSchemeLine`. Sve tvrdnje verifikovane fajl:red.

## 0. Mehanizam

`R_Vrste dokumenata` (vrsta dok → IDSeme) → `Sema za kontiranje` (IDSeme → vrsta naloga) →
`Stavke seme za kontiranje` (red = Konto + `DefDug` + `DefPot` nad slovima A-Z) → evaluator **`VredIzraza`**.

- `VredIzraza(Izraz, a,B,c,...,Z)` — 26 pozicionih argumenata (`Module__SemaZaKontiranje.txt:3-52`).
  Slovo N u izrazu = N-ti argument (A=1., Z=26.). `Eval(pomstr)` na kraju → **mi koristimo safe parser** (živ, ispravlja legacy asocijativnost).
- ⚠️ VBA komentari A-K (linije 5-15) su STARIJI šablon — NE odgovaraju runtime vrednostima.
  Autoritet = poziciona vrednost iz upita (`SK*/USL_*/NSK_*ZbirneVrednostiPoDok.sql`).

## 1. A-Z tabela (26 kolona, isti redosled u SK_/USL_/NSK_ putevima)

Redosled: `NabNetoVred, ZTS, ZTD, PPDOsn, PPDZel, PPDGrad, PPDRat, RZC, KalkVP, RobaOsn,
RobaZel, RobaGrad, RobaRat, Taks, StvarnaVP, StRobaOsn, StRobaZel, StRobaGrad, StRobaRat,
NivProd, PPDPos, RobaPos, StRobaPos, AvansUkupno, AvansPDVVisa, AvansPDVNiza`.

| Slovo | Kolona | Iznos |
|---|---|---|
| **A** | NabNetoVred | Σ Kol × neto nabavna cena (ULAZ) |
| **B** | ZTS | zavisni trošak sopstveni (neoporeziv) |
| **C** | ZTD | zavisni trošak dobavljača (oporeziv) |
| **D** | PPDOsn | **ULAZNI PDV 20%** (pretporez, VISA) |
| **E** | PPDZel | **ULAZNI PDV 10%** (NIZA — stopa u koloni „Zeleznica") |
| F, G | PPDGrad/Rat | ulazni PDV gradska/ratna (nasleđe, 0) |
| **H** | RZC | razlika u ceni = Σ Kol × (KalkVP − ZTD − ZTS − NabNeto) |
| **I** | KalkVP | Σ Kol × kalkulativna VP cena |
| J, K | RobaOsn/Zel | PDV na kalk. VP 20% / 10% |
| L, M | RobaGrad/Rat | 0 |
| **N** | Taks | Σ Kol × taksa |
| **O** | StvarnaVP | **neto fakturna vrednost** = Fakturna − Rabat − Kasa (IZLAZ) |
| **P** | StRobaOsn | **IZLAZNI PDV 20%** (VISA) |
| **Q** | StRobaZel | **IZLAZNI PDV 10%** (NIZA) |
| R, S | StRobaGrad/Rat | 0 |
| **T** | NivProd | nivelacija = Σ Kol × (StvarnaVP − KalkVP) |
| **U** | PPDPos | ulazni PDV 8% (POLJO, posebna) |
| **V** | RobaPos | PDV na kalk. VP 8% |
| **W** | StRobaPos | izlazni PDV 8% |
| **X** | AvansUkupno | iskorišćeni avans sa PDV (Σ T_AVR_Roba.KoristiIznosSaPDV) |
| **Y** | AvansPDVVisa | PDV 20% iz avansa |
| **Z** | AvansPDVNiza | PDV 10% iz avansa |

Sažetak: **A**=neto ulaz, **O**=neto izlaz, **D/E/U**=ulazni PDV 20/10/8%, **P/Q/W**=izlazni PDV 20/10/8%,
**B,C**=zavisni troškovi, **H**=RUC, **I**=kalk VP, **T**=nivelacija, **X/Y/Z**=iskorišćeni avans.

## 2. Šeme po vrsti dokumenta (DefDug / DefPot; 0-strana se ne knjiži)

Izvor: `Stavke seme za kontiranje.csv` (105 redova) + `Sema za kontiranje.csv` (30 šema).

| Vrsta (IDSeme) | Konto | DefDug | DefPot |
|---|---|---|---|
| **UFROB** ulaz robe (3) | 1320 / 2700 / 2710 / 4350 | A+B+C / D / E / — | — / — / — / A+B+C+D+E |
| **UFMAT** ulaz materijala (34) | 1010 / 2700 / 2710 / 4350 | A / D / E / — | — / — / — / A+D+E |
| **IFUSL** izlaz usluga (30) | 2020 / 6121 / 4700 / 4710 | O+P+Q / — / — / — | — / O / P / Q |
| **IFR** izlaz robe (33) | 2040 / 5010 / 6040 / 4702 / 4710 / 1320 | O+P+Q / A / — / — / — / — | — / — / O / P / Q / A |
| **IFGP** izlaz gotovih proizvoda (36) | 2040 / 6141 / 4701 / 9800 / 9600 | O+P / — / — / A / — | — / O / P / — / A |
| **VPTR** prodaja u tranzitu (21) | 20200 / 60240 / 47000 / 47100 / 50140 / 13600 | O+P+Q / — / — / — / A / — | — / O / P / Q / — / A |
| **IZVRO** izvoz robe (24) | 2050 / 6050 / 5013 / 1320 | O / — / A / — | — / O / — / A | (bez PDV) |
| **IZVGP** izvoz gotovih (47) | 2050 / 6150 / 9800 / 9600 | O / — / A / — | — / O / — / A | (bez PDV) |
| **UVOZ** (32) | 4360 / 2740 / 1320 | — / D / A | A / — / — |
| **KNO** knjižno odobrenje (31) | 2020 / 470 / 471 / 6120 | -O-P-Q / — / — / — | — / -P / -Q / -O | (umanjenje) |
| **AVR** avans (39) | 4300 / 4720 / 4300 | — / — / P | O+P / P / — |
| **VPSIR** prodaja sirovina (29) | 20200 / 67300 / 47000 / 47100 | O+P+Q+R+S / — / — / — | — / O / P / Q |

Ostale (interne, `csv:52-107`): TREB, REPRE, DONAC, MANJM/R, OTPIM/R, VISAM/R, REZM/R, MMPM/R, KNZ.

## 3. PDV konta po stopi (`PDV_SemeKontaZaKnjizenje.csv`, POPDV potvrda)

| Konto | Smer | Stopa |
|---|---|---|
| 2700/2701/2705 | ulazni (pretporez) | 20% |
| 2710 | ulazni | 10% |
| 2740/2750 | ulazni uvoz | 20% / 10% |
| 2780 | ulazni | 8% (POLJO) |
| **4700/4701/4702/4703** | izlazni | **20%** (svi, POPDV 3.2) |
| 4710 | izlazni | 10% |
| 4720/4730 | izlazni avans | 20% / 10% |

## 4. Stope (`R_Tarife.csv`, effective-dated)

Osnovna=20% (VISA), **Zeleznica=10% (NIZA)**, Posebna=8% (POLJO). 18% istekla 30.09.2012.
Efektivna stopa = ZBIR 5 kolona. Zato slova E/Q/K (PDV*Zel) = 10%.

## 5. Rupe (nema u izvoru / delimično)

- **Zatvaranje avansa** (X/Y/Z) NE koristi nijedna šema — ide preko `PDV_Obracun_*_ZaAvansneRacune.sql`
  (tela nisu otvorena). Za precizno knjiženje zatvaranja avansa dovući te upite.
- **~87 od 117 vrsta naloga NEMA auto-šemu** (izvodi, blagajna, plate, OS, kamate/220) — ručni nalozi.
- Slova F,G,L,M (gradska/ratna) uvek 0.

## Seed plan

1. **AccountingScheme** ← `Sema za kontiranje.csv` (30) + `R_Vrste dokumenata.csv` (58 vrsta → IDSeme + flagovi).
2. **AccountingSchemeLine** ← `Stavke seme za kontiranje.csv` (105 redova: IDSeme, Konto, DefDug, DefPot, Analitika, Poreklo).
3. A-Z izračun (26 vrednosti/dokument, SQL formule §1) → safe parser (živ) → DefDug/DefPot.

**Fajlovi:** `_legacy/BigbitRaznoNenad/_extracted/rule_tables/BB_T_26/*.csv`,
`.../OnLine_BigBit_VBA/Module__SemaZaKontiranje.txt`, `.../queries_full/BigBit_APL_2010/*.sql`.

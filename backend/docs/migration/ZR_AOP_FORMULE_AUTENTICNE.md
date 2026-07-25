# Završni račun 4.0 — AUTENTIČNE AOP formule (Bilans stanja + Bilans uspeha)

**Datum:** 2026-07-26
**Migracija:** `backend/prisma/migrations/20260726090000_seed_balance_formulas_autenticne/migration.sql`
**Preduslovne izmene koda:** [`ZR_ISPRAVKE_MOTORA.md`](ZR_ISPRAVKE_MOTORA.md)
**Prethodni dokumenti:** [`BIGBIT_ZR_MOTOR.md`](BIGBIT_ZR_MOTOR.md) (kako BigBit motor radi), doc 44 (rekonstrukcija — nadjačan ovim dokumentom)

---

## 1. Odakle formule dolaze i zašto je to legitiman izvor

Do sada je seed formula bio **rekonstrukcija** — neko je pogađao maske iz opšteg APR obrasca.
Prave formule žive u vendorskoj Access tabeli `ZR_AOP_Modla` (kolona `Definicija`), koja je
binarna u `.MDB` i **nije izvezena** (kod Slaviše, vidi `BIGBIT_ZR_MOTOR.md`).

**Ovaj seed ne čeka `ZR_AOP_Modla`.** Izvor je bolji od nje za našu svrhu:

- `backend/reports/zr/bs.txt` — **predati** Bilans stanja Servoteha (obrazac po Pravilniku 89/2020), 117 AOP pozicija, tri kolone iznosa (2023 / 2022 kraj / 2021 početak)
- `backend/reports/zr/bu.txt` — **predati** Bilans uspeha, 62 AOP pozicije, dve kolone (2023 / 2022)
- originali: `_legacy/BigBit26/ZR_validacija/*.pdf`

**Obrazac sam nosi formulu.** Kolona 1 („Група рачуна, рачун") daje **masku konta** za listove;
naziv pozicije u zagradi daje **AOP-aritmetiku** za zbirne pozicije. Primer (`bu.txt:19-24`):

```
                        А. ПОСЛОВНИ ПРИХОДИ (1002 + 1005 + 1008 + 1001
                        1009 - 1010 + 1011 + 1012)                              630.409   409.098
          60            I. ПРИХОДИ ОД ПРОДАЈЕ РОБЕ (1003 + 1004)         1002   179.944    58.636
    600, 602 и 604      1. Приходи од продаје робе на домаћем тржишту    1003   178.421    58.465
```

Uz to, obrazac nosi i **predate brojke**, tj. sopstveni regresioni test. To je razlog zašto je
ovaj izvor legitimniji od `ZR_AOP_Modla`: `ZR_AOP_Modla` bi dala BigBit-ovu implementaciju
(uključujući njene bagove — vidi §7), a predati obrazac daje **rezultat koji je Servoteh
zaista prijavio APR-u**.

Maske su zatim mapirane na **stvarni kontni plan Servoteha**
(`backend/prisma/migrations/20260723155000_seed_chart_of_accounts/migration.sql`, 1398 konta),
koji je po **starom kontnom okviru** — otuda odstupanja u §5.

### Pravila prevoda (primenjena bez izuzetka)

| # | Pravilo |
|---|---|
| 1 | Aktiva i rashodi → `D<maska>*-P<maska>*`; pasiva i prihodi → `P<maska>*-D<maska>*` |
| 2 | Svaka maska završava `*` (inače promašuje analitiku: `D023` ne hvata `0239`) |
| 3 | `PSD`/`PSP` se **ne koriste nigde** — `D`/`P` već sadrže PS naloge; `PSD01*+D01*` iz starog seed-a broji početno stanje **dvaput** |
| 4 | Ako naziv pozicije sadrži aritmetiku u zagradi → formula je **isključivo** A-aritmetika, a kolona „Група рачуна" je dokumentacija |
| 5 | „X осим Y" → oduzimanje **obe strane**: `...-DY*+PY*` |
| 6 | Par „дуг. салдо / пот. салдо" → dve obrnute formule nad istim kontom; klamp odseca pogrešan smer (DSL nema `IIf`) |
| 7 | Aritmetika iz zagrade se prepisuje **verbatim** i računa **levo-asocijativno** — ne reprodukuje se BigBit-ova desno-rekurzivna greška (§7) |
| 8 | Ispravke vrednosti se **ne oduzimaju eksplicitno** — kod Servoteha su analitika ispod iste sintetike (`0239`, `0129`, `109`, `139`…), pa je `D<maska>*-P<maska>*` već neto |

---

## 2. Šta je provereno — i šta nije

### Prošlo

| Provera | Obim | Rezultat |
|---|---|---|
| Potpunost AOP skupa | BS 117, BU 62 | **179/179**, nijedan ne fali, nijedan višak |
| Aritmetika zbirnih (BS) | 22 pozicije × 3 kolone | **66/66** tačno |
| Aritmetika zbirnih (BU) | 19 pozicija × 2 kolone | **38/38** tačno |
| Bilans zatvara | `A0059 == A0456` | 868.293 (2023) / 638.633 (2022) / 447.059 (2021) ✅ |
| BU rezultat | `A1055` | 34.636 (2023) / 41.817 (2022) ✅ |
| Nezavisna kontrola BU | zbir 14 prihodnih listova = `A1043` = 653.419; zbir 17 rashodnih = `A1044` = 617.063 | ✅ |
| Strana D/P | svih 165 listova ručno | 0 okrenutih |
| Preklapanje maski | sweep svih maski nad 1398 konta | 0 duplih (posle ispravke 0406 — §4.1) |
| Reference i sintaksa | mašinski nad migracijom | 0 nepostojećih `A<aop>`, 0 maski bez `*`, 0 nepoznatih prefiksa, 0 duplih ordinala |

### **Nije** provereno — iskreno

1. **Formule NISU pokrenute nad podacima.** U 4.0 glavnoj knjizi nema GL istorije za
   2021–2023, a bruto stanje iz BigBit-a nije izvezeno. Verifikacija je **aritmetička**
   (nad predatim iznosima) i **strukturna** (maske nad kontnim planom), ne izvršavanjem motora.
2. **23 konta iz plana ne hvata nijedna maska** (§6). Ako ijedno nosi saldo, `A0059 ≠ A0456`.
3. **Podela grupe 20 (kupci vs povezana lica)** je izvedena iz naziva analitika, ne iz salda
   (§5.2). Zbir `A0038` izlazi tačno u oba tumačenja, pa greška ne bi bila vidljiva.
4. **Kolone 6 i 7 obrasca** (prethodna godina) ostaju **nule** — motor ih čita lookup-om iz
   ranijih obračuna kojih nema (§8, rizik R3).

**Zaključak o zrelosti:** seed je **spreman da zameni rekonstrukcioni**, ali **nije spreman za
poresku predaju** dok se ne urade tri stvari iz `ZR_ISPRAVKE_MOTORA.md` (clamp, ZAK nalog,
kontrolna pravila) i dok se ne pusti obračun nad stvarnim bruto stanjem.

---

## 3. PUNA TABELA FORMULA

Legenda pouzdanosti:
- **visoka** — maska/aritmetika 1:1 sa obrascem I potvrđena nenultim predatim iznosom, ili čista A-aritmetika prekontrolisana u sve kolone
- **srednja** — maska je tačna po obrascu i kontnom planu, ali je predati iznos 0 pa se ne može verifikovati
- **niska** — mapiranje na stari kontni okvir je pretpostavka; predati iznos 0

Sve pozicije imaju `clamp ≥ 0` (BigBit klampuje svaki upis — `BIGBIT_ZR_MOTOR.md` §9.1, i dokazano
predatim brojkama 0455 / 1026 / 1037 / 1050).

### 3.1 BILANS STANJA — AKTIVA

| AOP | Naziv | Formula (DSL) | Pouzd. |
|---|---|---|---|
| 0001 | A. UPISANI A NEUPLAĆENI KAPITAL | `D00*-P00*` | srednja |
| 0002 | B. STALNA IMOVINA | `A0003+A0009+A0017+A0018+A0028` | visoka |
| 0003 | I. NEMATERIJALNA IMOVINA | `A0004+A0005+A0006+A0007+A0008` | visoka |
| 0004 | 1. Ulaganja u razvoj | `D010*-P010*` | visoka |
| 0005 | 2. Koncesije, patenti, licence, softver… | `D011*-P011*+D012*-P012*+D014*-P014*` | visoka |
| 0006 | 3. Gudvil | `D013*-P013*` | niska ⚠ §5.6 |
| 0007 | 4. Nematerijalna imovina u lizingu / u pripremi | `D015*-P015*` | srednja |
| 0008 | 5. Avansi za nematerijalnu imovinu | `D016*-P016*` | srednja |
| 0009 | II. NEKRETNINE, POSTROJENJA I OPREMA | `A0010+A0011+A0012+A0013+A0014+A0015+A0016` | visoka |
| 0010 | 1. Zemljište i građevinski objekti | `D020*-P020*+D021*-P021*+D022*-P022*` | visoka |
| 0011 | 2. Postrojenja i oprema | `D023*-P023*` | visoka |
| 0012 | 3. Investicione nekretnine | `D024*-P024*` | visoka |
| 0013 | 4. NPO u lizingu i u pripremi | `D025*-P025*+D027*-P027*` | visoka |
| 0014 | 5. Ostale NPO i ulaganja na tuđim NPO | `D026*-P026*+D028*-P028*` | visoka |
| 0015 | 6. Avansi za NPO u zemlji | `D029*-P029*` | srednja |
| 0016 | 7. Avansi za NPO u inostranstvu | `MANUAL` | srednja |
| 0017 | III. BIOLOŠKA SREDSTVA | `D0302*-P0302*+D0310*-P0310*+D0311*-P0311*+D0312*-P0312*+D0320*-P0320*` | niska ⚠ §5.1 |
| 0018 | IV. DUGOROČNI FIN. PLASMANI I POTRAŽIVANJA | `A0019+A0020+A0021+A0022+A0023+A0024+A0025+A0026+A0027` | visoka |
| 0019 | 1. Učešća u kapitalu pravnih lica | `D030*-P030*-D0302*+P0302*+D031*-P031*-D0310*+P0310*-D0311*+P0311*-D0312*+P0312*+D032*-P032*-D0320*+P0320*+D040*-P040*+D041*-P041*+D042*-P042*` | niska ⚠ §5.1 |
| 0020 | 2. Učešća vrednovana metodom učešća | `MANUAL` | niska |
| 0021 | 3. Dugoročni plasmani povezanim licima u zemlji | `D033*-P033*+D043*-P043*+D050*-P050*+D051*-P051*` | niska |
| 0022 | 4. …u inostranstvu | `D044*-P044*` | niska |
| 0023 | 5. Dugoročni krediti i zajmovi u zemlji | `D034*-P034*+D045*-P045*+D053*-P053*` | niska |
| 0024 | 6. …u inostranstvu | `D035*-P035*` | niska |
| 0025 | 7. Dugoročna finansijska ulaganja (HoV) | `D036*-P036*+D046*-P046*` | niska |
| 0026 | 8. Otkupljene sopstvene akcije/udeli | `D037*-P037*+D047*-P047*` | niska |
| 0027 | 9. Ostali dugoročni plasmani i potraživanja | `D038*-P038*+D039*-P039*+D048*-P048*+D052*-P052*+D054*-P054*+D055*-P055*+D056*-P056*` | niska |
| 0028 | V. DUGOROČNA AVR | `MANUAL` | srednja |
| 0029 | V. ODLOŽENA PORESKA SREDSTVA | `D288*-P288*` | visoka |
| 0030 | G. OBRTNA IMOVINA | `A0031+A0037+A0038+A0044+A0048+A0057+A0058` | visoka |
| 0031 | I. ZALIHE | `A0032+A0033+A0034+A0035+A0036` | visoka |
| 0032 | 1. Materijal, rez. delovi, alat, sitan inventar | `D10*-P10*` | visoka |
| 0033 | 2. Nedovršena proizvodnja i gotovi proizvodi | `D11*-P11*+D12*-P12*` | visoka |
| 0034 | 3. Roba | `D13*-P13*` | visoka |
| 0035 | 4. Plaćeni avansi za zalihe i usluge u zemlji | `D150*-P150*+D152*-P152*+D154*-P154*` | visoka |
| 0036 | 5. …u inostranstvu | `D151*-P151*+D153*-P153*+D155*-P155*` | srednja |
| 0037 | II. STALNA IMOVINA ZA PRODAJU | `D14*-P14*` | visoka |
| 0038 | III. POTRAŽIVANJA PO OSNOVU PRODAJE | `A0039+A0040+A0041+A0042+A0043` | visoka |
| 0039 | 1. Potraživanja od kupaca u zemlji | `D204*-P204*+D202*-P202*-D2020*+P2020*+D20200*-P20200*+D2090*-P2090*` | srednja ⚠ §5.2 |
| 0040 | 2. …u inostranstvu | `D205*-P205*+D203*-P203*-D2030*+P2030*` | srednja ⚠ §5.2 |
| 0041 | 3. Potraživanja od povezanih lica u zemlji | `D200*-P200*+D2020*-P2020*-D20200*+P20200*` | srednja ⚠ §5.2 |
| 0042 | 4. …u inostranstvu | `D201*-P201*+D2030*-P2030*` | srednja ⚠ §5.2 |
| 0043 | 5. Ostala potraživanja po osnovu prodaje | `D206*-P206*` | srednja |
| 0044 | IV. OSTALA KRATKOROČNA POTRAŽIVANJA | `A0045+A0046+A0047` | visoka |
| 0045 | 1. Ostala potraživanja | `D21*-P21*+D22*-P22*-D223*+P223*-D224*+P224*+D27*-P27*` | visoka |
| 0046 | 2. Više plaćen porez na dobitak | `D223*-P223*` | visoka |
| 0047 | 3. Preplaćeni ostali porezi i doprinosi | `D224*-P224*` | visoka |
| 0048 | V. KRATKOROČNI FINANSIJSKI PLASMANI | `A0049+A0050+A0051+A0052+A0053+A0054+A0055+A0056` | visoka |
| 0049 | 1. Krediti i plasmani — matično i zavisna | `D230*-P230*` | visoka |
| 0050 | 2. …ostala povezana lica | `D231*-P231*` | visoka |
| 0051 | 3. Krediti, zajmovi i plasmani u zemlji | `D232*-P232*+D234*-P234*` | srednja |
| 0052 | 4. …u inostranstvu | `D233*-P233*` | srednja |
| 0053 | 5. HoV po amortizovanoj vrednosti | `D235*-P235*` | visoka |
| 0054 | 6. Fin. sredstva po fer vrednosti kroz BU | `MANUAL` | srednja |
| 0055 | 7. Otkupljene sopstvene akcije/udeli | `D237*-P237*` | visoka |
| 0056 | 8. Ostali kratkoročni fin. plasmani | `D236*-P236*+D238*-P238*+D239*-P239*` | srednja |
| 0057 | VI. GOTOVINA I EKVIVALENTI | `D24*-P24*` | visoka |
| 0058 | VII. KRATKOROČNA AVR | `D28*-P28*-D288*+P288*` | visoka |
| **0059** | **D. UKUPNA AKTIVA** | `A0001+A0002+A0029+A0030` | **visoka** |
| 0060 | Đ. VANBILANSNA AKTIVA | `D88*-P88*` | visoka |

### 3.2 BILANS STANJA — PASIVA

| AOP | Naziv | Formula (DSL) | Pouzd. |
|---|---|---|---|
| 0401 | A. KAPITAL | `A0402+A0403+A0404+A0405+A0406-A0407+A0408+A0411-A0412` | visoka |
| 0402 | I. OSNOVNI KAPITAL | `P30*-D30*-P306*+D306*` | visoka |
| 0403 | II. UPISANI A NEUPLAĆENI KAPITAL | `P31*-D31*` | visoka |
| 0404 | III. EMISIONA PREMIJA | `P306*-D306*` | visoka |
| 0405 | IV. REZERVE | `P32*-D32*` | visoka |
| 0406 | V. POZITIVNE REVAL. REZERVE… | `P330*-D330*` | srednja ⚠ §4.1 |
| 0407 | VI. NEREALIZOVANI GUBICI… | `D331*-P331*+D332*-P332*+D333*-P333*+D334*-P334*+D335*-P335*+D336*-P336*+D337*-P337*` | srednja ⚠ §4.1 |
| 0408 | VII. NERASPOREĐENI DOBITAK | `A0409+A0410` | visoka |
| 0409 | 1. …ranijih godina | `P340*-D340*` | visoka |
| 0410 | 2. …tekuće godine | `P341*-D341*` | visoka |
| 0411 | VIII. UČEŠĆE BEZ PRAVA KONTROLE | `MANUAL` | visoka |
| 0412 | IX. GUBITAK | `A0413+A0414` | visoka |
| 0413 | 1. Gubitak ranijih godina | `D350*-P350*` | visoka |
| 0414 | 2. Gubitak tekuće godine | `D351*-P351*` | visoka |
| 0415 | B. DUGOROČNA REZERVISANJA I OBAVEZE | `A0416+A0420+A0428` | visoka |
| 0416 | I. DUGOROČNA REZERVISANJA | `A0417+A0418+A0419` | visoka |
| 0417 | 1. Rezervisanja za beneficije zaposlenih | `P404*-D404*` | srednja ⚠ §9 |
| 0418 | 2. Rezervisanja za garantni rok | `P400*-D400*` | visoka |
| 0419 | 3. Ostala dugoročna rezervisanja | `P40*-D40*-P400*+D400*-P404*+D404*` | visoka |
| 0420 | II. DUGOROČNE OBAVEZE | `A0421+A0422+A0423+A0424+A0425+A0426+A0427` | visoka |
| 0421 | 1. Obaveze konvertibilne u kapital | `P410*-D410*` | visoka |
| 0422 | 2. Dugoročne obaveze povezanim licima u zemlji | `P411*-D411*-P4111*+D4111*+P412*-D412*-P4121*+D4121*` | srednja ⚠ §5.4 |
| 0423 | 3. …u inostranstvu | `P4111*-D4111*+P4121*-D4121*` | srednja ⚠ §5.4 |
| 0424 | 4. Krediti, zajmovi i lizing u zemlji | `P414*-D414*+P416*-D416*` | visoka |
| 0425 | 5. …u inostranstvu | `P415*-D415*` | srednja |
| 0426 | 6. Obaveze po emitovanim HoV | `P413*-D413*` | visoka |
| 0427 | 7. Ostale dugoročne obaveze | `P419*-D419*` | visoka |
| 0428 | III. DUGOROČNA PVR | `MANUAL` | srednja |
| 0429 | V. ODLOŽENE PORESKE OBAVEZE | `P498*-D498*` | visoka |
| 0430 | G. DUGOROČNI ODLOŽENI PRIHODI I DONACIJE | `P495*-D495*` | srednja |
| 0431 | D. KRATKOROČNA REZERVISANJA I OBAVEZE | `A0432+A0433+A0441+A0442+A0449+A0453+A0454` | visoka |
| 0432 | I. KRATKOROČNA REZERVISANJA | `P467*-D467*` | srednja ⚠ §9 |
| 0433 | II. KRATKOROČNE FINANSIJSKE OBAVEZE | `A0434+A0435+A0436+A0437+A0438+A0439+A0440` | visoka |
| 0434 | 1. Krediti povezanim licima u zemlji | `P420*-D420*+P421*-D421*-P4201*+D4201*` | niska ⚠ §5.5 |
| 0435 | 2. …u inostranstvu | `P4201*-D4201*` | niska |
| 0436 | 3. Krediti od lica koja nisu domaće banke | `MANUAL` | niska ⚠ §5.5 |
| 0437 | 4. Krediti od domaćih banaka | `P422*-D422*+P424*-D424*+P425*-D425*+P429*-D429*` | niska ⚠ §5.5 |
| 0438 | 5. Krediti i obaveze iz inostranstva | `P423*-D423*` | srednja |
| 0439 | 6. Obaveze po kratkoročnim HoV | `P426*-D426*` | visoka |
| 0440 | 7. Obaveze po finansijskim derivatima | `P428*-D428*` | srednja |
| 0441 | III. PRIMLJENI AVANSI, DEPOZITI, KAUCIJE | `P430*-D430*` | visoka |
| 0442 | IV. OBAVEZE IZ POSLOVANJA | `A0443+A0444+A0445+A0446+A0447+A0448` | visoka |
| 0443 | 1. Dobavljači — povezana lica u zemlji | `P431*-D431*+P4330*-D4330*` | visoka ⚠ §5.3 |
| 0444 | 2. …u inostranstvu | `P432*-D432*+P4340*-D4340*` | visoka ⚠ §5.3 |
| 0445 | 3. Dobavljači u zemlji | `P435*-D435*+P433*-D433*-P4330*+D4330*` | visoka ⚠ §5.3 |
| 0446 | 4. Dobavljači u inostranstvu | `P436*-D436*+P434*-D434*-P4340*+D4340*` | visoka ⚠ §5.3 |
| 0447 | 5. Obaveze po menicama | `P4391*-D4391*+P4392*-D4392*` | srednja |
| 0448 | 6. Ostale obaveze iz poslovanja | `P439*-D439*-P4391*+D4391*-P4392*+D4392*` | srednja |
| 0449 | V. OSTALE KRATKOROČNE OBAVEZE | `A0450+A0451+A0452` | visoka |
| 0450 | 1. Ostale kratkoročne obaveze | `P44*-D44*+P45*-D45*+P46*-D46*-P467*+D467*` | visoka |
| 0451 | 2. Obaveze za PDV i ostale javne prihode | `P47*-D47*+P48*-D48*-P481*+D481*` | visoka |
| 0452 | 3. Obaveze po osnovu poreza na dobitak | `P481*-D481*` | visoka |
| 0453 | VI. OBAVEZE PO OSNOVU SREDSTAVA ZA PRODAJU | `P427*-D427*` | srednja |
| 0454 | VII. KRATKOROČNA PVR | `P49*-D49*-P498*+D498*-P495*+D495*` | srednja |
| 0455 | Đ. GUBITAK IZNAD VISINE KAPITALA | `A0415+A0429+A0430+A0431-A0059` | visoka |
| **0456** | **E. UKUPNA PASIVA** | `A0401+A0415+A0429+A0430+A0431-A0455` | **visoka** |
| 0457 | Ž. VANBILANSNA PASIVA | `P89*-D89*` | visoka |

### 3.3 BILANS USPEHA

| AOP | Naziv | Formula (DSL) | Pouzd. |
|---|---|---|---|
| 1001 | A. POSLOVNI PRIHODI | `A1002+A1005+A1008+A1009-A1010+A1011+A1012` | visoka |
| 1002 | I. PRIHODI OD PRODAJE ROBE | `A1003+A1004` | visoka |
| 1003 | 1. Prodaja robe na domaćem tržištu | `P600*+P602*+P604*-D600*-D602*-D604*` | visoka |
| 1004 | 2. …na inostranom tržištu | `P601*+P603*+P605*-D601*-D603*-D605*` | visoka |
| 1005 | II. PRIHODI OD PRODAJE PROIZVODA I USLUGA | `A1006+A1007` | visoka |
| 1006 | 1. …na domaćem tržištu | `P610*+P612*+P614*-D610*-D612*-D614*` | visoka ⚠ §9 |
| 1007 | 2. …na inostranom tržištu | `P611*+P613*+P615*-D611*-D613*-D615*` | visoka |
| 1008 | III. PRIHODI OD AKTIVIRANJA UČINAKA I ROBE | `P62*-D62*` | visoka |
| 1009 | IV. POVEĆANJE VREDNOSTI ZALIHA | `P630*-D630*` | visoka |
| 1010 | V. SMANJENJE VREDNOSTI ZALIHA | `D631*-P631*` | visoka (izuzetak strane) |
| 1011 | VI. OSTALI POSLOVNI PRIHODI | `P64*-D64*+P65*-D65*` | visoka |
| 1012 | VII. PRIHODI OD USKLAĐIVANJA (OSIM FIN.) | `P68*-D68*-P683*+D683*-P685*+D685*-P686*+D686*` | visoka |
| 1013 | B. POSLOVNI RASHODI | `A1014+A1015+A1016+A1020+A1021+A1022+A1023+A1024` | visoka |
| 1014 | I. NABAVNA VREDNOST PRODATE ROBE | `D50*-P50*` | visoka |
| 1015 | II. TROŠKOVI MATERIJALA, GORIVA I ENERGIJE | `D51*-P51*` | visoka |
| 1016 | III. TROŠKOVI ZARADA I OSTALI LIČNI RASHODI | `A1017+A1018+A1019` | visoka |
| 1017 | 1. Troškovi zarada i naknada | `D520*-P520*` | visoka |
| 1018 | 2. Porezi i doprinosi na zarade | `D521*-P521*` | visoka |
| 1019 | 3. Ostali lični rashodi i naknade | `D52*-P52*-D520*+P520*-D521*+P521*` | visoka |
| 1020 | IV. TROŠKOVI AMORTIZACIJE | `D540*-P540*` | visoka |
| 1021 | V. RASHODI OD USKLAĐIVANJA (OSIM FIN.) | `D58*-P58*-D583*+P583*-D585*+P585*-D586*+P586*` | visoka |
| 1022 | VI. TROŠKOVI PROIZVODNIH USLUGA | `D53*-P53*` | visoka |
| 1023 | VII. TROŠKOVI REZERVISANJA | `D54*-P54*-D540*+P540*` | visoka |
| 1024 | VIII. NEMATERIJALNI TROŠKOVI | `D55*-P55*` | visoka |
| 1025 | V. POSLOVNI DOBITAK ≥ 0 | `A1001-A1013` | visoka |
| 1026 | G. POSLOVNI GUBITAK ≥ 0 | `A1013-A1001` | visoka |
| 1027 | D. FINANSIJSKI PRIHODI | `A1028+A1029+A1030+A1031` | visoka |
| 1028 | I. Fin. prihodi od povezanih lica | `P660*+P661*-D660*-D661*` | srednja |
| 1029 | II. PRIHODI OD KAMATA | `P662*-D662*` | visoka |
| 1030 | III. POZITIVNE KURSNE RAZLIKE | `P663*+P664*-D663*-D664*` | visoka |
| 1031 | IV. OSTALI FINANSIJSKI PRIHODI | `P665*+P669*-D665*-D669*` | visoka |
| 1032 | Đ. FINANSIJSKI RASHODI | `A1033+A1034+A1035+A1036` | visoka |
| 1033 | I. Fin. rashodi prema povezanim licima | `D560*+D561*-P560*-P561*` | srednja |
| 1034 | II. RASHODI KAMATA | `D562*-P562*` | visoka |
| 1035 | III. NEGATIVNE KURSNE RAZLIKE | `D563*+D564*-P563*-P564*` | visoka |
| 1036 | IV. OSTALI FINANSIJSKI RASHODI | `D565*+D569*-P565*-P569*` | visoka |
| 1037 | E. DOBITAK IZ FINANSIRANJA ≥ 0 | `A1027-A1032` | visoka |
| 1038 | Ž. GUBITAK IZ FINANSIRANJA ≥ 0 | `A1032-A1027` | visoka |
| 1039 | Z. PRIHODI OD USKLAĐIVANJA FIN. IMOVINE | `P683*+P685*+P686*-D683*-D685*-D686*` | visoka |
| 1040 | I. RASHODI OD USKLAĐIVANJA FIN. IMOVINE | `D583*+D585*+D586*-P583*-P585*-P586*` | visoka |
| 1041 | J. OSTALI PRIHODI | `P67*-D67*` | visoka |
| 1042 | K. OSTALI RASHODI | `D57*-P57*` | visoka |
| 1043 | L. UKUPNI PRIHODI | `A1001+A1027+A1039+A1041` | visoka |
| 1044 | LJ. UKUPNI RASHODI | `A1013+A1032+A1040+A1042` | visoka |
| 1045 | M. DOBITAK IZ REDOVNOG POSLOVANJA ≥ 0 | `A1043-A1044` | visoka |
| 1046 | N. GUBITAK IZ REDOVNOG POSLOVANJA ≥ 0 | `A1044-A1043` | visoka |
| 1047 | NJ. POZITIVAN NETO EFEKAT… | `P69*-D69*-P699*+D699*-D59*+P59*+D599*-P599*` | srednja ⚠ §4.3 |
| 1048 | O. NEGATIVAN NETO EFEKAT… | `D59*-P59*-D599*+P599*-P69*+D69*+P699*-D699*` | srednja ⚠ §4.3 |
| 1049 | P. DOBITAK PRE OPOREZIVANJA ≥ 0 | `A1045-A1046+A1047-A1048` | visoka |
| 1050 | R. GUBITAK PRE OPOREZIVANJA ≥ 0 | `A1046-A1045+A1048-A1047` | visoka |
| 1051 | I. PORESKI RASHOD PERIODA | `D721*-P721*` | visoka |
| 1052 | II. ODLOŽENI PORESKI RASHODI PERIODA | `D722*-P722*` | srednja ⚠ §9 |
| 1053 | III. ODLOŽENI PORESKI PRIHODI PERIODA | `P722*-D722*` | srednja ⚠ §9 |
| 1054 | T. ISPLAĆENA LIČNA PRIMANJA POSLODAVCA | `MANUAL` | — ⚠ §5.7 |
| **1055** | **Ć. NETO DOBITAK ≥ 0** | `A1049-A1050-A1051-A1052+A1053-A1054` | **visoka** |
| 1056 | U. NETO GUBITAK ≥ 0 | `A1050-A1049+A1051+A1052-A1053+A1054` | visoka |
| 1057–1060 | Konsolidacione pozicije | `MANUAL` | visoka |
| 1061–1062 | Zarada po akciji | `MANUAL` | visoka |

---

## 4. Nalazi provere koji su PRIHVAĆENI i kako su ugrađeni

### 4.1 0406 je dvostruko brojao dugovni saldo klase 33 — PRIHVAĆENO

Obrazac (`bs.txt:283-284, 289-292`) traži saldo **po pojedinačnom kontu**: 0406 = konto 330 +
*potražni* saldi 331–337; 0407 = *dugovni* saldi 331–337. Prvi predlog je pisao neto par
(`P330*+P331*…-D…` vs `D331*…-P…`), pa je isti dugovni iznos ulazio dvaput: jednom kao umanjenje
0406, drugi put kao 0407 koji se u 0401 oduzima.

**Ugrađeno:** `0406 = P330*-D330*` (samo konto 330). Time se gube potražni saldi 331–337, ali se
uklanja dvostruko brojanje — a klamp problem ne bi rešio (kad 330 ≠ 0, 0406 ostaje pozitivan pa
clamp ne okida). Za Servoteha su obe pozicije 0/0/0 u sve tri kolone, pa se izmena ne vidi u regresiji.

### 4.2 Klamp važi i tamo gde obrazac ne piše „≥ 0" — PRIHVAĆENO

Obrazac štampa „≥ 0" na 10 BU pozicija, ali simulacija „klamp samo na označene" daje
`A1049 = 35.960` umesto 36.158 i `A1055 = 34.932` umesto 34.636. Razlog: 1047/1048 i 1052/1053 su
ogledala nad istom veličinom i u 1049 odnosno 1055 ulaze **dvaput sa suprotnim znakom**.

**Ugrađeno:** clamp je propisan na **svaku** poziciju, u **svakoj iteraciji**
(`ZR_ISPRAVKE_MOTORA.md` §1). Bez ikakvog clampa `A1055` = 143.604 (2023) / 178.147 (2022).

### 4.3 Konta prenosa 599/699 mogu kontaminirati 1047/1048 — PRIHVAĆENO

Servotehov plan ima `599 Prenos rashoda` i `699 Prenos prihoda`
(`seed_chart_of_accounts/migration.sql:1084, 1254`). Maske `59*`/`69*` bi ih pokupile.

**Ugrađeno:** obe pozicije izuzimaju 599 i 699 na obe strane.

### 4.4 Podela grupe 20 i grupe 43 mora ići po analitici — PRIHVAĆENO

Vidi §5.2 i §5.3.

### 4.5 Konto 039 nije imao nijednu poziciju — PRIHVAĆENO

`039 Ispravka vrednosti dugoročnih finansijskih plasmana` (plan, red 176) nije padao ni u jednu
masku. **Ugrađeno:** dodat u 0027 (potražni je, pa automatski umanjuje).

### 4.6 Sintetike 411/412 su curele iz pasive — PRIHVAĆENO

0422/0423 su prvo koristili samo četvorocifrene maske. Sintetike `411`/`412` postoje kao konta
(plan, redovi 530 i 533). **Ugrađeno:** 0422 uzima `411*`/`412*` minus ino-analitike.

### 4.7 Biološka sredstva su bila u pogrešnoj poziciji — PRIHVAĆENO

Vidi §5.1.

### 4.8 Kontrolna pravila moraju se prepisati zajedno sa seed-om — PRIHVAĆENO

`control-rules.service.ts` proverava `0001 == 0401` (sa novim seed-om: 0 vs 167.829 → **tvrdi FAIL**,
finalizacija blokirana) i `1068 == 1064 − 1066` nad AOP-ovima koji u obrascu **ne postoje**
(→ `0 == 0`, **lažno prolazi**). Tačan spisak izmena je u `ZR_ISPRAVKE_MOTORA.md` §3.

### 4.9 Migracija mora brisati, ne samo INSERT-ovati — PRIHVAĆENO

~25 starih AOP oznaka se poklapa sa zvaničnim, a nose drugo značenje. Uz `ON CONFLICT DO NOTHING`
stari redovi bi tiho preživeli. **Ugrađeno:** `DELETE` definicija + `DELETE` izračunatih linija +
`UPDATE … status='DRAFT'` (jer bi `loadPriorYearAmounts` inače povukao stare vrednosti u kolonu
„prethodna godina", a FINALIZED obračun se ne bi mogao ni preračunati).

### 4.10 Ordinali moraju biti dodeljeni — PRIHVAĆENO

Bez njih bi svih 179 redova imalo `ordinal = 0` i PostgreSQL bi vraćao proizvoljan redosled.
**Ugrađeno:** BS 10–1170, BU 10–620, korak 10.

---

## 5. Odstupanja od doslovnog obrasca (svesna, sa obrazloženjem)

Servotehov kontni plan je po **starom kontnom okviru**; obrazac 89/2020 je po novom. Gde se to
sudara, prednost ima **sadržina konta**, ne broj — inače iznos završi u pogrešnoj poziciji.

### 5.1 Klasa 03: biološka sredstva vs dugoročni plasmani

Obrazac: AOP 0017 = klasa 03 (BIOLOŠKA SREDSTVA). Kod Servoteha je 03 = *dugoročni finansijski
plasmani*, ali su unutar njega analitike koje su **stvarno** biološka sredstva:

```
0302  Mešovite šume                  (ispod 030 Učešća u kapitalu zavisnih)
0310  Višegodišnji zasadi - Voćnjaci (ispod 031 Učešća u kapitalu ostalih povezanih)
0311  Višegodišnji zasad - Vinogradi
0312  Višegodišnji zasad - Ostalo
0320  Osnovno stado                  (ispod 032 Učešća u kapitalu ostalih)
```

**Odluka:** 0017 uzima tačno tih pet analitika; 0019 ih izuzima. Prvi predlog je 0017 stavljao na
`MANUAL` a 0019 ih je gutao — interno kontradiktorno.
**Pouzdanost niska** (sve pozicije su 0/0/0, mapiranje neverifikovano).

### 5.2 Grupa 20: kupci vs povezana lica

Obrazac: 0039 = „204", 0040 = „205", 0041 = „200 и 202", 0042 = „201 и 203".
Servoteh ima **dupli sloj** — i stari (202/203) i novi (2040/2050):

```
202  Kupci u zemlji            2020 Kupci u zemlji - ostala POVEZANA lica ; 20200 analitika
                              2021 komision ; 2022 prodata oprema ; 2023 Ostali kupci
203  Kupci u inostranstvu      2030 Kupci u inostranstvu - ostala POVEZANA lica
                              2031, 2032, 2039 (obični)
2040 Kupci u zemlji ; 2050 Kupci u inostranstvu
```

Doslovno čitanje obrasca (ceo 202 → 0041) bi obične kupce prikazalo kao potraživanja od povezanih
lica. **Odluka:** podela po analitici — 2020 (bez 20200) → 0041, ostatak 202 → 0039; 2030 → 0042,
ostatak 203 → 0040.

⚠️ **Zbir `A0038` izlazi tačan (98.645) u OBA tumačenja**, pa aritmetička provera ovo ne hvata.
Verifikacija traži bruto stanje: 0039 mora dati **97.762**, a 0041 **0** za 2023.

⚠️ `20200 Kupci u zemlji - analitika` je po prefiksu ispod 2020 (povezana lica), ali po nazivu
izgleda kao generički analitički registar. Tretiran je kao **običan kupac** (0039) — ako je zapravo
povezano lice, 97.762 sedi u pogrešnoj poziciji. **Pitanje za knjigovođu.**

### 5.3 Grupa 43: dobavljači

```
433  Dovavljači u zemlji   4330  Dobavljaci - ostala POVEZANA lica u zemlji
                           43301 Ostali dobavljači - struja, telefon, grejanje…
                           4331  Dobavljači u zemlji za nefakturisane obaveze
434  Dobavljači u inostr.  4340  Dobavljaci - ostala POVEZANA lica u inostranstvu
                           4341  Dobavljači u inostranstvu za nefakturisane obaveze
```

Maska `433*` u poziciji povezanih lica (0443) bi povukla 43301 i 4331 — obične dobavljače — a
0443 je predat kao 0/0/0 dok 0445 nosi **78.303**. **Odluka:** 4330 → 0443, ostatak 433 → 0445;
4340 → 0444, ostatak 434 → 0446. Ovo je jedina korekcija koja direktno spasava regresionu kotvu.

### 5.4 Sintetike 411/412

Postoje kao zasebna konta pored analitika 4110/4111/4120/4121. Konzervativno su pripisane
**domaćoj** strani (0422), da ne ispadnu iz pasive.

### 5.5 Grupa 42: „domaće banke vs ostali" (0436/0437)

Podela nije izvodiva iz kontnog plana — sve Servotehove analitike u 422/424 su domaće banke
(Srpska banka, ProCredit, Intesa, Erste). Ceo „(део)" je pripisan 0437, a 0436 je `MANUAL`.
**Posledica:** BS **2022** se ne može reprodukovati po podpozicijama (predato 0436 = 9.400,
0437 = 11.731; naš izlaz bi bio 0 i 21.131). **Zbir 0433 = 21.131 ostaje tačan.**
Ovo je **jedini** „(део)" par sa nenultim iznosima na obe strane u celom bilansu.

⚠️ Analitike 4200 (SBER revolving) i 4210/4211 (Srpska banka) stoje pod 420/421 — pozicijama
*povezanih lica* — iako su bankarski krediti; po sadržini pripadaju 0437. Formule prate obrazac
(broj konta), ne sadržinu. **Pitanje za knjigovođu.**

### 5.6 AOP 0006 „Гудвил" vs Servotehov 013 „Negativni goodwill"

Konto 013 je kod Servoteha *negativni* gudvil (potražan), a 0006 je aktiva. `D013*-P013*` uz clamp
daje trajno 0. Zadržana je formula (a ne `MANUAL`) da bi pozitivan gudvil, ako se ikad proknjiži,
bio uhvaćen. **Pouzdanost niska**; negativan gudvil sadržinski pripada 0430.

Srodno: `0121 Ispravka vrednosti goodwill-a` stoji ispod sintetike `012 Softveri` i pada u AOP 0005
(jedina nenulta pozicija u 0003 — 3.843). Ako je naziv u planu greška i to je zaista ispravka
softvera, sve je u redu; ako nije, umanjuje pogrešnu poziciju. **Pitanje za knjigovođu.**

### 5.7 AOP 1054 / konto 723

Obrazac traži grupu 723 = „Исплаћена лична примања послодавца". Servotehov 723 =
**„Prenos dobitka ili gubitka"** (7230 Prenos dobiti, 7231 Prenos gubitka). Maska `D723*` bi
pokupila prenos rezultata (red veličine miliona) i uništila 1055.
**Odluka: `MANUAL`** dok knjigovođa ne potvrdi. Predato 0/0 u obe godine.

---

## 6. Nalazi koji su ODBAČENI — i zašto

| Nalaz | Odluka | Obrazloženje |
|---|---|---|
| „`D`/`P` moraju dobiti donju granicu datuma (01.01.), a početno stanje ulazi kroz `PSD`/`PSP` → sve formule postaju `PSD02*+D02*-PSP02*-P02*`" | **ODBAČENO za BS, PRIHVAĆENO kao zaseban zadatak za BU** | Za **bilans stanja** je kumulativni `asOf` **ISPRAVAN** — BS je stanje na dan, a PS nalog nije dupliranje nego prenos posle kojeg se prethodna godina više ne knjiži. Predložena izmena bi BS **pokvarila**. Za **bilans uspeha** problem je stvaran, ali rešenje nije donja granica datuma nego izuzimanje `ZAK` naloga (§ ispod). |
| „Kumulativni `asOf` je najveći rizik za BU; dodaj `posting_date >= 01.01.`" | **ODBAČENO kao dovoljno rešenje** | Zaključni nalog `ZAK` je datiran **31.12.**, dakle **unutar** perioda — donja granica ga ne uklanja. Ispravno rešenje: isključiti `order_type_code = 'ZAK'` iz `D`/`P` (`ZR_ISPRAVKE_MOTORA.md` §2). |
| „Zaključna knjiženja idu na prenosna konta 710/711/712/599/699, pa treba testirati AOP 1003 na gross-only" | **ODBAČENO — dijagnoza je bila pogrešna** | `year-open.service.ts:231-254` knjiži kontra-stavku **NAZAD NA ISTO KONTO** klase 5/6, ne na prenosna konta. Posledica je **egzaktna nula**, ne udvostručenje. Test „1003 == 178.421" i dalje vredi, ali kao detektor `ZAK` naloga. |
| „0006 postaviti na MANUAL" | **ODBAČENO** | `MANUAL` danas znači **trajna nula** (nema rute za ručni unos). Formula bar hvata pozitivan gudvil ako se pojavi. |
| „0417 i 0432 obrisati jer konta 404 i 467 ne postoje" | **ODBAČENO** | Maske su bezopasne (tiha nula) i **nužne** su zbog simetrije sa izuzimanjem u 0419 odnosno 0450. Ostaju uz napomenu u §9. |
| „Dodati `2990` u 0058" | **ODBAČENO — ostavljeno otvoreno** | Nije poznato gde je Servoteh prijavio nedospelu kamatu lizinga; nasumično svrstavanje je gore od dokumentovane rupe. Vidi §7 R2. |
| „Ne stavljati clamp na listove, samo na 0401 i 0455" | **ODBAČENO** | BigBit klampuje **svaki** upis — dokazano sa 8 UPDATE upita (`ZR_Upisi…Iznos_{1,2,3}_{Zaok,Nezaok}` + `ZR_UpisiVrednostiuIzAOP…`), i predatim brojkama BU 1052/1053 koje su **listovi** (maska 722) a klampovane su. Primedba je ipak delom prihvaćena: uveden je **`clampedFrom` log** da se okrenut smer ne proguta tiho (`ZR_ISPRAVKE_MOTORA.md` §1). |
| „Reprodukovati BigBit-ovu desno-rekurzivnu asocijativnost minusa" | **ODBAČENO** | Predata brojka to obara: `A1055 = 1049−1050−1051−1052+1053−1054` levo-asocijativno daje **34.636** (tačno), BigBit-ovim parserom bez zagrada **38.668**. Dakle stvarna `ZR_AOP_Modla` ima zagrade; mi pišemo verbatim iz obrasca. |
| „Formule pisati ćirilicom kao u obrascu" | **ODBAČENO** | Ostatak baze (kontni plan, labele) je srpska latinica; APR FiForma XML nosi samo AOP + iznos. Transliteracija je mehanička i bez efekta na predaju. |

---

## 7. Preostali rizici (rangirano)

| # | Rizik | Ozbiljnost | Status |
|---|---|---|---|
| **R1** | **Zaključni nalog `ZAK` nulira ceo bilans uspeha.** `year-open.service.ts` knjiži kontra-stavku na isto konto klase 5/6, datirano 31.12., status POSTED. `gkeval` nema filter po vrsti naloga → `P602*-D602*` = **0**. | **BLOKER za BU** | Fix opisan u `ZR_ISPRAVKE_MOTORA.md` §2 |
| **R2** | **23 konta bez ijedne maske.** Sintetičke „glave" klasa (`0`,`01`,`02`,`1`,`15`,`2`,`20`,`23`,`29`,`3`,`33`,`34`,`35`,`4`,`41`,`42`,`43`) + `290` + `2990 PORSCHE LEASING NEDOSPELA KAMATA`. Ako ijedno nosi saldo → `A0059 ≠ A0456`, bez ikakvog objašnjenja. | visok | Otvoreno; potrebna kontrola pokrivenosti (`ZR_ISPRAVKE_MOTORA.md` §4) |
| **R3** | **Kolone 6 i 7 obrasca ostaju nule.** `loadPriorYearAmounts` čita već sačuvane obračune za `year−1`/`year−2`, kojih nema; `computeStatement` radi `deleteMany+createMany` pa ni ručni `UPDATE` ne preživljava. | visok | Otvoreno; traži uvoz istorije ili zasebnu tabelu |
| **R4** | **Ispravka `2090` nema svoju poziciju u obrascu.** Privremeno je u 0039. Ako je knjigovođa raspoređivao pro-rata, 0039 je potcenjen a 0040 precenjen. | srednji | Pitanje za knjigovođu (§8) |
| **R5** | **MANUAL = trajna nula.** 14 pozicija se ne može popuniti — konkretno 0436 (9.400 u 2022) se nikada neće prikazati. | srednji | Traži `manual_amount` kolonu + PATCH rutu |
| **R6** | **Motor ne filtrira po firmi.** `gkeval.aggregate` nema `je.company_id`. Sa više pravnih lica u bazi bilans spaja sve knjige. | srednji | Otvoreno |
| **R7** | **Tiha nula.** `COALESCE(SUM(...),0)` — maska bez pogotka ne razlikuje se od stvarne nule; uz univerzalni clamp, okrenut smer D/P takođe daje 0. Modul ima **0 testova**. | srednji | Delom pokriveno `clampedFrom` logom |
| **R8** | **APR XML za BS/BU je pogrešan.** `apr-xml.service.ts:62` koristi `DEFAULT_START_COLUMN = 3` → emituje `aop-XXXX-3/-4/-5`; obrazac traži **5/6/7** za BS i **5/6** za BU, uz tekstualno polje `aop-XXXX-4` („Напомена број"). Model `BalanceFormulaDefinition` nema `start_column`/`column_count`. | srednji | Otvoreno, van opsega ovog seed-a |
| **R9** | **0406 gubi potražne salde 331–337.** DSL nema per-konto clamp. | nizak (0/0/0 kod Servoteha) | Dokumentovano, §4.1 |
| **R10** | **BS 2022 se ne reprodukuje po podpozicijama 0436/0437.** | nizak (zbir tačan) | §5.5 |

---

## 8. Otvorena pitanja za knjigovođu (samo ono što se stvarno ne može izvesti)

1. **Konto `2090` (Ispravka vrednosti potraživanja od kupaca)** — obrazac 89/2020 ga ne pominje
   nigde (AOP 0038 je zbir 0039–0043, a te pozicije navode samo 200–206). Da li se ispravka
   raspoređuje po podpozicijama ili ide cela u „kupci u zemlji"? *Privremeno: cela u 0039.*
2. **Konto `20200` „Kupci u zemlji - analitika"** — povezano lice (jer je ispod 2020) ili običan
   kupac? Od ovoga zavisi da li 97.762 završi u AOP 0039 ili 0041.
3. **Konto `723`** — kod nas „Prenos dobitka ili gubitka". Postoji li uopšte konto za „Исплаћена
   лична примања послодавца" (AOP 1054)? *Privremeno: 1054 = MANUAL.*
4. **Konta `4200`, `4210`, `4211`** — stoje pod 420/421 (povezana lica) iako su bankarski krediti.
   Kako je to prijavljeno u obrascu (0434 ili 0437)?
5. **AOP 0436 vs 0437 za 2022** — po kom kriterijumu je 9.400 razdvojeno od 11.731?
6. **Konto `2990` „PORSCHE LEASING NEDOSPELA KAMATA"** i **`290`** — u kojoj AOP poziciji su
   prijavljeni? Danas ih ne hvata nijedna maska.
7. **Konto `0121` „Ispravka vrednosti goodwill-a"** — je li to zapravo ispravka softvera (stoji
   ispod `012 Softveri`)?
8. **Konta `404` (rezervisanja za beneficije zaposlenih) i `467` (kratkoročna rezervisanja)** —
   ne postoje u planu. Ako se otpremnine/jubilarne rezervišu, gde se knjiže?
9. **Konto `6103`** („usluge matičnim licima u INOSTRANSTVU", ali ispod `610` = domaće tržište)
   i **`6042`** („Prihod od prodaje osn. sredstava", ispod `604`) — obrazac ih po broju konta
   svrstava u domaću prodaju (1006) odnosno u prodaju robe (1003). Je li i knjigovođa tako predao?
10. **Konto `722`** — sintetika se zove „Lična primanja poslodavca", a analitika `7220` je
    „ODLOŽENA PORESKA SREDSTVA-OBAVEZE". Knjiži li se na 722 išta osim odloženog poreza?

---

## 9. Napomene o maskama koje su danas prazne

Sledeće maske **ne pogađaju nijedno konto** u Servotehovom planu i daju **tihu nulu**. Ostavljene su
kao rezerva za buduća konta i radi simetrije sa „осим" izuzimanjima; **ne smeju se čitati kao
„provereno 0"**:

- **BS:** `025*` (0013), `040*/041*/042*` (0019), `043*/050*/051*` (0021), `044*` (0022), `053*` (0023),
  `046*` (0025), `047*` (0026), `048*/052*/054*/055*/056*` (0027), `150*` (0035), `206*` (0043),
  `404*` (0417 i 0419), `427*` (0453), `428*` (0440), `467*` (0432 i 0450)
- **BU:** `603*` (1004), `665*` (1031), `565*` (1036), `586*` (1021 i 1040)

---

## 10. Spremnost za produkciju

| Deo | Spreman? |
|---|---|
| **Bilans stanja — struktura, AOP numeracija, aritmetika** | **DA** — zamenjuje rekonstrukcioni seed odmah |
| **Bilans stanja — tačnost iznosa** | **NE dok se ne doda clamp** (`0456` bi izašao 1.036.122 umesto 868.293) |
| **Bilans uspeha — struktura i aritmetika** | **DA** |
| **Bilans uspeha — tačnost iznosa** | **NE** dok se `ZAK` nalog ne isključi iz `D`/`P` (danas: sve nule) |
| **Kolone 6 i 7 (prethodne godine)** | **NE** — nema izvora podataka |
| **APR XML predaja** | **NE** — pogrešna `StartnaKolona` (R8) |
| **Poreska predaja** | **NE** — nijedan obračun nije pušten nad stvarnim bruto stanjem |

**Preporuka:** seed primeniti odmah (jer je zvanična AOP numeracija preduslov za sve dalje), a
istovremeno isporučiti izmene iz `ZR_ISPRAVKE_MOTORA.md` — inače nova kontrolna pravila tvrdo padaju
i finalizacija je nemoguća.

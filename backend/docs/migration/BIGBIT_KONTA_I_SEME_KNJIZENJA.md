# BigBit — kontni plan i automatika knjiženja (rekonstrukcija iz produkcijskih baza)

**Datum analize:** 25.07.2026
**Status:** činjenična rekonstrukcija iz podataka i koda. Svaka tvrdnja ima izvor
(`tabela.kolona`, SQL koji je pokrenut, ili putanja fajla). Gde nema dokaza — stoji `NEPOZNATO`.

---

## 0. Izvori i metod

| Izvor | Šta je | Pokrivenost |
|---|---|---|
| `ubuntusrv:/tmp/bb26/BB_T_25.MDB` (311 MB, 201 tabela) | produkcijska transakciona baza **2025** | `T_Glavna knjiga.Datum knjizenja` **01.01.2025 – 22.08.2025**, `DatumIVreme` max `08/22/25 08:16:50` → **snimak je od 22.08.2025, godina 2025 NIJE kompletna (fali sep–dec)** |
| `_legacy/BB_T_26_11-07-26.mdb` (375 MB) — uploadovan na `ubuntusrv:/tmp/bb26/BB_T_26.mdb` | produkcijska transakciona baza **2026** | `T_Glavna knjiga.Datum knjizenja` **05.01.2025 – 11.07.2026** (2025 datumi = početno stanje preko konta `7000`) |
| `ubuntusrv:/tmp/bb26/APL.MDB` (104 MB) | Access aplikacija (forme, upiti, VBA, `CFG_Apl_SviParametri`) | — |
| `ubuntusrv:/tmp/bb26/BB_CFG.mdb` | vendorski šabloni šema (MAXIT, SUPERDELI, ABB, EXPRO…) | nisu Servotehovi podaci |
| `_legacy/QBigTehn_APL/modules/SemaZaKontiranje.bas` | motor izračunavanja formule | — |
| `_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/*.sql` | Access upiti koji čine ceo lanac knjiženja | — |

**Metod izvoza** (mdbtools kontejner na `ubuntusrv`):

```bash
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-tables -1 /d/BB_T_25.MDB"
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export -d '|' /d/BB_T_25.MDB 'Kontni plan'"
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export /d/BB_T_25.MDB 'T_Glavna knjiga'"
```

> ⚠️ **Zamka za sledećeg:** `mdb-export` bez `-d` daje zarez kao razdvajač; `Opis` polja sadrže
> zareze. Svuda koristi `-d '|'` **osim** za `T_Glavna knjiga` (tamo nema slobodnog teksta sa `|`).

---

## 1. Kontni plan — stvarno stanje

### 1.1 Struktura tabele

`BB_T_25.MDB.[Kontni plan]` — **8 kolona, i to je sve**:

| kolona | tip | šta stvarno nosi (mereno na podacima) |
|---|---|---|
| `Konto` | `Text(10)` | PK. Šifra konta. **Nije čisto numerička** — postoje `02101-1`, `0212-1`, `02206C`, `02207B`, `022906C`, `022907B` |
| `Opis` | `Text(255)` | naziv konta |
| `Dugacki opis` | `Memo` | popunjen na **76 / 1355** konta — koristi se za katastarske podatke nekretnina (broj parcele, list nepokretnosti) |
| `Plan duguje` | `Currency` | **popunjen na 0 konta — MRTVA KOLONA** |
| `Plan potrazuje` | `Currency` | **popunjen na 0 konta — MRTVA KOLONA** |
| `Dozvoljen unos analitike` | `Boolean` | `1` na **1346**, `0` na **9** konta |
| `Fajl sifara` | `Text(64)` | popunjen na **15** konta (`KUPDOB`×12, `BANKE`×2, `OST`×1); prazan na 1340 |
| `InoKonto` | `Text(10)` | **popunjen na 0 konta — MRTVA KOLONA**; `InoKontniPlan` ima **1 red** (prazna) |

**Ono čega NEMA, a Pantheon/SAP ljudi to očekuju:**

- ❌ nema kolone „tip konta" (aktiva/pasiva/prihod/rashod)
- ❌ nema kolone „saldakonto da/ne" (to je zaseban registar — v. §5)
- ❌ nema kolone „zabranjeno direktno knjiženje" (sintetika nije zaključana!)
- ❌ nema kolone „traži analitiku obavezno" — `Dozvoljen unos analitike` je **dozvola, ne obaveza**
- ❌ nema `parent_code` / hijerarhije — hijerarhija je **isključivo implicitna, po prefiksu šifre**

Izvor: `mdb-schema --table 'Kontni plan' BB_T_25.MDB` + prebrojavanje po kolonama.

### 1.2 Struktura šifri (hijerarhija po prefiksu)

`BB_T_25.MDB.[Kontni plan]`, raspodela po dužini šifre:

| dužina | broj konta | značenje |
|---:|---:|---|
| 1 | 10 | klasa (`0`–`9`) |
| 2 | 69 | grupa (`00`, `01`, `02`…) |
| 3 | 289 | sintetika (`020`, `132`, `470`…) |
| 4 | 835 | **analitika — radni nivo** (`1320`, `2040`, `4350`) |
| 5 | 138 | sub-analitika (`51100`, `27200`, `02105`) |
| 6 | 13 | (`022906`) |
| 7 | 1 | (`02101-1`) |

Raspodela po klasama (prva cifra):

| klasa | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| konta | 143 | 77 | 200 | 47 | 262 | 292 | 168 | 21 | 27 | 118 |

Klasa 9 = **obračun troškova i učinaka** (interni obračun proizvodnje) — kod Servoteha je **živa**
(`9020`, `9600`, `9800` su u top-20 prometa, v. §4).

### 1.3 `KontniPlan_STD` — šta je to

Zaseban šablon: **1186 konta**. Nije Servotehov plan nego **vendorski standardni kontni okvir**.

- u `Kontni plan` a ne u `KontniPlan_STD`: **324** konta (Servotehove dopune — nekretnine `022xx`, bankovni računi `24xx`, kreditni `56xx`)
- u `KontniPlan_STD` a ne u `Kontni plan`: **155** konta (npr. `0110`, `0140`, `020`, `025`, `0260`)

**Zaključak: `KontniPlan_STD` je referentni šablon za otvaranje nove firme, NE koristi se u knjiženju.
Ne migrirati.**

### 1.4 Poređenje sa našim seed-om (1398 konta)

Seed: `backend/prisma/migrations/20260723155000_seed_chart_of_accounts/migration.sql`

Šifre izvučene komandom:
```bash
grep -oE "^\('[^']*'" migration.sql | sed "s/^('//; s/'$//"   # → 1398 jedinstvenih
```

| skup | broj |
|---|---:|
| BigBit 2025 (`BB_T_25.[Kontni plan]`) | 1355 |
| BigBit 2026 (`BB_T_26.[Kontni plan]`, 11.07.2026) | **1389** |
| naš seed | **1398** |

**Rezultat poređenja:**

- ✅ **u BigBit 2026 a NEMA u našem seed-u: 0 konta.** Naš seed je potpun nadskup živog plana.
- ✅ **u BigBit 2025 a nema u 2026: 0** — plan se samo dopunjuje, ništa se ne briše.
- ➕ 2026 je dodao **34** konta u odnosu na 2025: `02101-1`, `0212-1`, `02206C`, `02207B`, `02210`,
  `02277`, `02278`, `022906C`, `022907B`, `022909`, `022910`, `23810`, `2387`, `24100`, `27001`,
  `27002`, `27041`, `27101`, `27102`, `2721`, `27250`, `2729`, `27300`, `414301`, `41600`, `4161`,
  `41611`, `424301`, `435`, `4351`, `47250`, `4729`, `5332`, `56231`
- ⚠️ **u našem seed-u a NEMA ih u BigBit-u NIGDE (ni 2025 ni 2026): 9 konta**

| konto | odakle nam je | ima li ijednu stavku u GK 2025/2026 |
|---|---|---|
| `1329` | **naša izmišljotina** — protivstavka NIV-a, uvedena u `posting.service.ts` | ne / ne |
| `13600` | linija šeme **21 (VPTR)** | ne / ne |
| `20200` | linije šema **21, 28, 29** | ne / ne |
| `470` | linija šeme **31 (KNO)** | ne / ne |
| `471` | linija šeme **31 (KNO)** | ne / ne |
| `47100` | linije šema **21, 29** | ne / ne |
| `50140` | linija šeme **21 (VPTR)** | ne / ne |
| `60240` | linija šeme **21 (VPTR)** | ne / ne |
| `67300` | linija šeme **29 (VPSIR)** | ne / ne |

Odnosno: **8 od 9 nisu naša greška — to su konta na koja BigBitove ŠEME pokazuju, a koja u
BigBitovom kontnom planu ne postoje.** BigBit nema FK integritet, pa mu to prolazi. Kod nas
`fk_scheme_lines_account` to ne bi dozvolio, pa ih je autor seed-a morao dodati.

> ⚠️ **62 konta su promenila NAZIV između 2025 i 2026** (uglavnom `021x`/`022x` — nekretnine, gde
> je katastarski broj prebačen s kraja na početak opisa; npr. `0210` „Zemlj 1168m2 KP 1667…" →
> „1667 KP Zemlj 1168m2…"). Naš seed nosi **2026 nazive** (proveren uzorak `0203`, `02100`–`02107`).
> Ispravno je.

**Presuda za §1:** naš kontni plan je **verno preslikan sa BigBit-a od 11.07.2026** i sadrži sve
što BigBit ima. Jedini realni višak je `1329` (v. §6.9).

---

## 2. Vrste konta — `CTGK_Vrste_Konta`

Izvor: `APL.MDB`, tri tabele.

| tabela | redova | sadržaj |
|---|---:|---|
| `CTGK_Zag` | **1** | `IDCTGK=1`, `Opis="ssss"`, `DefVred="Duguje"` |
| `CTGK_Kolone_Pozicije` | **1** | `IDCTGK=1`, `Pozicija="0"`, `ZaglavljeKolone` prazno |
| `CTGK_Vrste_Konta` | **613** | svih 613 vezano za `IDCTGK=1` |

Raspodela `CTGK_Vrste_Konta.Konto` po klasi: **klasa 5 → 389, klasa 6 → 224. Ništa drugo.**

**Šta je CTGK:** „**C**ross-**T**ab **G**lavne **K**njige" — korisnički definisan unakrsni izveštaj
nad glavnom knjigom. `CTGK_Zag` je zaglavlje izveštaja (`DefVred` bira da li se prikazuje Duguje ili
Potražuje), `CTGK_Vrste_Konta` je **spisak konta koja ulaze u redove izveštaja**,
`CTGK_Kolone_Pozicije` su **kolone = `Pozicija`** (mesto troška) koje se pojavljuju kao kolone.

**Čemu služi:** izveštaj troškova i prihoda (klase 5 i 6) po mestima troška.

**Stvarno stanje kod Servoteha: NIJE U UPOTREBI.**
Dokaz: postoji tačno jedno zaglavlje, čiji je naziv `"ssss"` (očigledan test-unos), i jedna kolona
sa `Pozicija="0"` bez naslova. Neko je jednom otvorio ekran, popunio spisak konta iz šablona i
odustao.

> **CTGK NIJE „vrsta konta" u smislu tip/kategorija konta.** Ne postoji nigde u BigBit-u kolona koja
> konto klasifikuje kao aktivu/pasivu/prihod/rashod. Ta klasifikacija u BigBit-u postoji **samo u
> Završnom računu**, kroz AOP pravila (v. `44-zr-bilans-motor-iz-vba.md`), i vezuje se za konta
> preko prefiksa šifre, ne preko atributa na kontu.

---

## 3. Automatika knjiženja — kako BigBit zna na koje konto da knjiži

Ovo je jezgro. Postoje **tri nezavisna sloja**, i svaki treba razumeti odvojeno:

- **sloj A — robno → GK**: `R_Vrste dokumenata` → `Sema za kontiranje` → `T_Glavna knjiga`
- **sloj B — GK → PDV evidencija**: `PDV_SemeKontaZaKnjizenje` → `T_PDV_GK`
- **sloj C — GK → POPDV obrazac**: `POPDV_SemeKontaZaKnjizenje` → `T_POPDV_GK`

Slojevi B i C **ne zavise od sloja A**. Oni gledaju **isključivo konto stavke u glavnoj knjizi** —
bez obzira da li je stavka nastala automatski iz robnog ili ručnim unosom naloga.

### 3.1 Sloj A — ulazna tačka: `R_Vrste dokumenata`

Ovde je „zašiven" prelaz iz robnog u finansijsko. Relevantne kolone:

| kolona | uloga |
|---|---|
| `Vrsta dokumenta` | PK, npr. `IFR`, `UFROB`, `IFGP` |
| **`Sema za kontiranje`** `Long` | **→ `Sema za kontiranje.IDSeme`. `0` ili prazno = dokument se NE knjiži automatski** |
| `Analiticki konto` `Text(10)` | konto koji nadjačava šemu; popunjen na **2 od 56** vrsta: `UZ`→`201`, `VPBP`→`201` |
| `Knjiziti analitiku` / `Knjiziti sintetiku` | prekidači grane knjiženja (v. §3.2) |
| `KnjizitiUPDVEvidenciju` | ide li dokument u PDV knjige |
| `IDMagacinZaVrstuDok` | podrazumevani magacin → posredno određuje konto (v. §3.6) |

Kod Servoteha (2025 i 2026 identično): **25 vrsta dokumenata ima šemu, 31 nema.**

Vrste **BEZ** šeme (→ ne knjiže se automatski u GK): `AVR`, `BOSCH`, `DEV.S`, `DEVCN`, `INOTP`,
`IZVUS`, `KNZ`, `MP1`, **`NIV`**, `OTP`, `PON`, `POPIS`, `POVR`, `PROF`, `PRZ`, `RPP`, `STARI`,
`STDCN`, `STDIN`, `UF`, `UFUSL`, `ULPP`, `ULSIR`, `USL`, `UVOZ`, `UZ`, `VPBP`, `VPOS`, `VPTR`, `ZAP`,
(+ `NALMA`, `PLAN` u 2026).

> 🔴 **Ključno za nas: `NIV` (nivelacija) NEMA šemu ni u 2025 ni u 2026 → BigBit nivelaciju NIKAD
> ne knjiži u glavnu knjigu.** Detaljno u §6.9.
> 🔴 Isto važi za `UVOZ` i `UF` — vrsta dokumenta `UVOZ` nema šemu iako šema 32 (`UVOZ`) postoji.
> Uvoz se u GK unosi **ručnim nalogom** vrste `UVOZ` (1072 stavke u 2025, v. §4.2).

### 3.2 Sloj A — motor: `VredIzraza()` i mapiranje slova A–Z

**Motor:** `_legacy/QBigTehn_APL/modules/SemaZaKontiranje.bas`, funkcija
`VredIzraza(Izraz, a, b, c, … Z) As Double` (linije 4–53). Nije rečnik po imenu — **slova su
pozicioni argumenti**:

```vba
Function VredIzraza(Izraz As Variant, a, b, c, d, e, f, G, H, i, j, K, L, M, n, o, p, Q, r, s, t, U, v, w, X, Y, Z As Double) As Double
     strar = Array(a, b, c, d, e, f, G, H, i, j, K, L, M, n, o, p, Q, r, s, t, U, v, w, X, Y, Z)
     Izraz = UCase$(Izraz)
     For IJ = 0 To (Duzina - 1)
         pom = Mid(Izraz, IJ + 1, 1)
         If (pom >= "A" And pom <= "Z") Then
             indeks = Asc(pom) - Asc("A")
             pomstr = pomstr + CStr(strar(indeks))
         Else
             pomstr = pomstr + pom
         End If
     Next
     If Duzina = 0 Then VredIzraza = 0# Else VredIzraza = Eval(pomstr)
```

**Pozivno mesto** (autoritativno za redosled):
`_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/NSK_VrednostiPoSemiZaKnjizenje1K.sql`

```sql
CCur(Round(VredIzraza(IIf(IsNull([DefDug]),"0",[DefDug]),
  [NabNetoVred],[ZTS],[ZTD],[PPDOsn],[PPDZel],[PPDGrad],[PPDRat],[RZC],[KalkVP],
  [RobaOsn],[RobaZel],[RobaGrad],[RobaRat],[Taks],[StvarnaVP],[StRobaOsn],[StRobaZel],
  [StRobaGrad],[StRobaRat],[NivProd],[PPDPos],[RobaPos],[StRobaPos],
  [AvansUkupno],[AvansPDVVisa],[AvansPDVNiza]),2)) AS GDuguje
```

**Mapiranje slova** (definicije agregata: `NSK_ZbirneVrednostiPoDok1K.sql`, sve su `Sum()` po
dokumentu preko `T_Robne stavke`):

| slovo | polje | značenje |
|---|---|---|
| **A** | `NabNetoVred` | Σ Kol × nabavna neto cena (ULAZ) |
| **B** | `ZTS` | zavisni trošak sopstveni (neoporeziv) |
| **C** | `ZTD` | zavisni trošak dobavljača (oporeziv) |
| **D** | `PPDOsn` | **ulazni PDV 20%** (pretporez) |
| **E** | `PPDZel` | **ulazni PDV 10%** |
| F, G | `PPDGrad`, `PPDRat` | 0 (nasleđe stopa iz SFRJ) |
| **H** | `RZC` | ukalkulisana razlika u ceni |
| **I** | `KalkVP` | kalkulativna VP vrednost |
| J, K, L, M | `RobaOsn/Zel/Grad/Rat` | PDV na **kalkulativnu** VP (20/10/0/0) |
| **N** | `Taks` | taksa |
| **O** | `StvarnaVP` | **osnovica = fakturna − rabat − kasa-skonto** (IZLAZ) |
| **P** | `StRobaOsn` | **izlazni PDV 20%** |
| **Q** | `StRobaZel` | **izlazni PDV 10%** |
| R, S | `StRobaGrad/Rat` | 0 |
| **T** | `NivProd` | Σ Kol × (stvarna VP − kalkulativna VP) |
| U, V, W | `PPDPos`, `RobaPos`, `StRobaPos` | posebna stopa (8%, poljoprivrednici) |
| X, Y, Z | `AvansUkupno`, `AvansPDVVisa`, `AvansPDVNiza` | iskorišćeni avans + PDV iz avansa |

> **Zašto „Zeleznica stopa" = 10%:** `_legacy/…/rule_tables/BB_T_26/R_Tarife.csv` —
> `Tarifa 3: Osnovna=20, Zeleznica=0` (VISA); `Tarifa 4: Osnovna=0, Zeleznica=10` (NIZA).
> Stare jugoslovenske kolone poreza su prenamenjene.

> ⚠️ **Komentari u samom `SemaZaKontiranje.bas` (linije 6–16) su ZASTARELI i NETAČNI** za trenutni
> 26-argumentni poziv (tvrde npr. „G = Kalkulativna VP cena", a stvarno je `G = PPDRat`).
> Autoritativan je SQL pozivni redosled.

**Ceo lanac (aktivna NSK grana):**

```
R_Vrste dokumenata.[Sema za kontiranje] → Sema za kontiranje → Stavke seme za kontiranje
                                                     ↓ NSK_SemaZaDok.sql
T_Robna dokumenta + T_Robne stavke + R_Artikli + R_Tarife
   → NSK_ZbirneVrednostiPoDok1K.sql   (26 agregata A..Z po IDDok/IDMagacin/Poreklo)
   → NSK_ZbirneVrednostiPoDok.sql     (+ PorekloZaSemu = Nz(Poreklo,"X"))
   → NSK_VrednostiPoSemiZaKnjizenje1K.sql   ◄── OVDE SE RAČUNA FORMULA
   → NSK_VrednostiPoSemiZaKnjizenje.sql     (Sum po kontu)
   → NSK_StavkeZaKnjizenje.sql              (+ IDNaloga, Pozicija, IDPredmet, OJ, OD)
   → NSK_ProknjiziStavkeIzRobnog.sql        INSERT INTO [T_Glavna knjiga]
```

Prekidač između dve grane — `Doc__Form_Unos naloga glavne knjige.txt`:
```vba
If BBCFG.KnjizenjePoKNG_2Sifri Then DocName = "Stavke koje nisu proknjizene u GLAVNU KNJIGU"
Else DocName = "NSK_Knjizenje"
```
`KnjizenjePoKNG_2Sifri` default = `False` → **aktivna je NSK grana, `SK_*` grana je mrtva.**

### 3.3 Sloj A — tabele šema

`Sema za kontiranje` (**30 redova**): `IDSeme` | `Vrsta naloga` | `Opis`
`Stavke seme za kontiranje` (**105 redova**): `IDStavkeSeme` | `IDSeme` | `Konto` | `Opis` |
`DefDug` | `DefPot` | `Analitika` | `Poreklo` | `KngSifra_2`

Značenje kolona linije:

| kolona | značenje | stvarno stanje kod Servoteha |
|---|---|---|
| `Konto` | ciljni konto. **Magična vrednost `"MAG"`** → zamenjuje se `Magacini.KontoMag` | nijedna linija nema `"MAG"` |
| `DefDug` / `DefPot` | izraz nad A–Z; `"0"` = ne knjiži na tu stranu | — |
| `Analitika` `Bool` | `True` → `Analiticka sifra` = **šifra komitenta sa dokumenta**; `False` → sintetički zbir na matičnu šifru firme (`Komitenti WHERE [Vrsta sifre]='MATSIF'`) | **svih 105 linija = True** |
| `Poreklo` `Text(5)` | grananje po `R_Artikli.Poreklo`; `"X"` = catch-all (`Nz(...,"X")`) | **svih 105 = `"X"`** → poreklo-specifično kontiranje se NE koristi |
| `KngSifra_2` `Text(10)` | predviđeno grananje po `R_Artikli.KngSifra_2` pod prekidačem `KnjizenjePoKNG_2Sifri` | **svih 105 = `"0"`; MRTVA KOLONA** — ne čita je nijedan upit, čak je ni `CFG_StavkeSemaZaKontiranje_Import.sql` ne prenosi |

**Punjenje `T_Glavna knjiga.[Analiticka sifra]`** —
`NSK_ProknjiziStavkeIzRobnog.sql`:
```sql
INSERT INTO [T_Glavna knjiga] ( IDNaloga, Konto, [Analiticka sifra], … )
SELECT NSK_StavkeZaKnjizenje.IDNaloga, NSK_StavkeZaKnjizenje.Konto,
       NSK_StavkeZaKnjizenje.[Sifra komitenta],   -- ◄── OVO ide u [Analiticka sifra]
       …
```
**Pravilo je bezuslovno: uvek šifra komitenta sa robnog dokumenta.** Nema grananja po kontu —
isti komitent ide na SVE stavke jednog dokumenta, i na `4350` i na `2700` i na `1320`.
Potvrđeno na podacima: **806 od 806** različitih vrednosti `Analiticka sifra` postoji u
`Komitenti.Sifra` (100%).

### 3.4 Sloj A — svih 30 šema (stanje BB_T_26, 11.07.2026)

Legenda: ⛔ = konto ne postoji u kontnom planu.

**Šema 3 — `UFROB` Ulaz robe** — AKTIVNA (`UFROB`)

| konto | DefDug | DefPot | naziv |
|---|---|---|---|
| `1320` | `A+B+C` | `0` | Roba u prometu na veliko |
| `2700` | `D` | `0` | PDV u primljenim fakturama 20% |
| `4350` | `0` | `A+B+C+D+E` | DOBAVLJACI U ZEMLJI |
| `2710` | `E` | `0` | PDV u primljenim fakturama 10% |

**Šema 21 — `VPTR` PRODAJA ROBE U TRANZITU** — _mrtva (nijedna vrsta dokumenta)_

| konto | DefDug | DefPot | naziv |
|---|---|---|---|
| `20200` ⛔ | `O+P+Q` | `0` | — |
| `60240` ⛔ | `0` | `O` | — |
| `47000` | `0` | `P` | PDV po izdatim fakturama 18% |
| `47100` ⛔ | `0` | `Q` | — |
| `50140` ⛔ | `A` | `0` | — |
| `13600` ⛔ | `0` | `A` | — |

**Šema 24 — `IZVRO` IZVOZ ROBE** — AKTIVNA (`IZVRO`)

| konto | DefDug | DefPot | naziv |
|---|---|---|---|
| `2050` | `O` | `0` | Kupci u inostranstvu |
| `6050` | `0` | `O` | Prihodi od prodaje robe na inostranom trzistu |
| `1320` | `0` | `A` | Roba u prometu na veliko |
| `5013` | `A` | `0` | Nabavna vrednost prodate robe na stranom tržištu |

**Šema 26 — `TREB` Trebovanje** — AKTIVNA (`TREB`)

| konto | DefDug | DefPot | naziv |
|---|---|---|---|
| `5110` | `A` | `0` | Troškovi osnovnog materijala za izradu |
| `1010` | `0` | `A` | Osnovni materijal |

**Šema 28 — `KNZ` Knjižno zaduženje** — _mrtva_ · **`20200` ⛔, DefDug = `0+P+Q`** ← 🐞 nula umesto slova `O`

**Šema 29 — `VPSIR` PRODAJA SIROVINA I NEPOVRATNE AMBALAZE** — _mrtva_

| konto | DefDug | DefPot |
|---|---|---|
| `20200` ⛔ | `O+P+Q+R+S` | `0` |
| `67300` ⛔ | `0` | `O` |
| `47000` | `0` | `P` |
| `47100` ⛔ | `0` | `Q` |

**Šema 30 — `IFUSL` Usluge izlaz** — AKTIVNA (`IFUSL`)

| konto | opis | DefDug | DefPot | naziv konta |
|---|---|---|---|---|
| `2020` | Kupac | `O+P+Q` | `0` | Kupci u zemlji - **ostala povezana lica** ⚠️ |
| `4700` | PDV 18% | `0` | `P` | PDV po izdatim fakturama 20% |
| `4710` | PDV 8% | `0` | `Q` | PDV po izdatim fakturama 10% |
| `6121` | Prihod od usluga | `0` | `O` | Prihodi od prodaje **proizvoda** na domaćem tržištu ⚠️ |

**Šema 31 — `KNO` Knjizno odobrenje** — **AKTIVNA (`KNO`) I POKVARENA**

| konto | opis | DefDug | DefPot | naziv konta |
|---|---|---|---|---|
| `2020` | Kupac | `-O-P-Q` | `0` | Kupci u zemlji - ostala povezana lica ⚠️ |
| `470` ⛔ | PDV 18% | `0` | `-P` | **NE POSTOJI** |
| `471` ⛔ | PDV 8% | `0` | `-Q` | **NE POSTOJI** |
| `6120` | Prihodi od prodaje | `0` | `-O` | Prihodi …ostalim povezanim pravnim licima ⚠️ |

**Šema 32 — `UVOZ`** — _mrtva_ · `4360` `0`/`A` · `2740` `D`/`0` · `1320` `A`/`0`

**Šema 33 — `IFR`** — AKTIVNA (`IFR`)

| konto | DefDug | DefPot | naziv |
|---|---|---|---|
| `2040` | `O+P+Q` | `0` | Kupci u zemlji |
| `4702` | `0` | `P` | PDV 20% na Prodate robe na domaćem tržištu |
| `4710` | `0` | `Q` | PDV po izdatim fakturama 10% |
| `6040` | `0` | `O` | Prihodi od prodaje robe na veliko u zemlji |
| `1320` | `0` | `A` | Roba u prometu na veliko |
| `5010` | `A` | `0` | Nabavna vrednost prodate robe na veliko |

**Šema 34 — `UFMAT`** — AKTIVNA (`UFMAT`) · `4350` `0`/`A+D+E` · `2700` `D`/`0` · `1010` `A`/`0` · `2710` `E`/`0`

**Šema 35 — `ULGP` Ulaz gotovih proizvoda** — AKTIVNA (`ULGP`) · `1200` `A`/`0` · `9020` `0`/`A` · `9600` `A`/`0` · `1200` `0`/`A`

**Šema 36 — `IFGP` IZLAZ GOT.PROIZVODA** — AKTIVNA (`IFGP`)

| konto | DefDug | DefPot | naziv |
|---|---|---|---|
| `2040` | `O+P` | `0` | Kupci u zemlji |
| `6141` | `0` | `O` | Prihodi od prodaje proizvoda na domacem trzistu |
| `4701` | `0` | `P` | PDV 20% na Prodate proizvode na domaćem tržištu |
| `9600` | `0` | `A` | Gotovi proizvodi u skladištu |
| `9800` | `A` | `0` | Troškovi prodatih proizvoda |

**Šema 37 — `MMPM`** — AKTIVNA (`MMPM`) · samo `1010` `A`/`0` ← 🐞 **jednostrana, nalog ne balansira**
**Šema 38 — `MMPR`** — AKTIVNA (`MMPR`) · samo `1320` `A`/`0` ← 🐞 **jednostrana**

**Šema 39 — `AVR` AVANSNI RACUN** — _mrtva_ · `4300` `0`/`O+P` · `4720` `0`/`P` · `4300` `P`/`0`

**Šema 40 — `REPRE`** — AKTIVNA (`REPRE`) · `1320` `0`/`A` · `5010` `A`/`0` · `6040` `0`/`A` · `5510` `A+P+Q`/`0` · `4700` `0`/`P` · `4710` `0`/`Q`
**Šema 41 — `VISAM`** — AKTIVNA (`VISAM`) · `1010` `A`/`0` · `6740` `0`/`A`
**Šema 42 — `DONAC`** — AKTIVNA (`DONAC`) · `1320` `0`/`A` · `5010` `A`/`0` · `6040` `0`/`A` · `4700` `0`/`P` · `5793` `A+P`/`0`
**Šema 43 — `TREB1`** — AKTIVNA (`TREB1`) · `1320` `0`/`A` · `51100` `A`/`0`
**Šema 44 — `REZM`** — AKTIVNA (`REZM`) · `1010` `-A`/`0` · `1011` `A`/`0`
**Šema 45 — `REZR`** — AKTIVNA (`OTPIS`, `REZR`) · `1320` `-A`/`0` · `1321` `A`/`0` ← ⚠️ `OTPIS` deli šemu sa rezervacijom
**Šema 46 — `VISAR`** — AKTIVNA (`VISAR`) · `1320` `A`/`0` · `6740` `0`/`A`
**Šema 47 — `IZVGP`** — AKTIVNA (`IZVGP`) · `2050` `O`/`0` · `6150` `0`/`O` · `9800` `A`/`0` · `9600` `0`/`A`
**Šema 48 — `USLMA`** — AKTIVNA (`USLMA`) · `1010` `-A`/`0` · `5110` `A`/`0`
**Šema 49 — `MANJM`** — AKTIVNA (`MANJM`) · `1010` `0`/`A` · `4700` `0`/`P` · `6040` `0`/`A` · `5110` `A`/`0` · `5740` `A+P`/`0`
**Šema 50 — `MANJR`** — AKTIVNA (`MANJR`) · `1320` `0`/`A` · `4700` `0`/`P` · `6040` `0`/`A` · `5010` `A`/`0` · `5741` `A+P`/`0`
**Šema 52 — `OTPIM`** — AKTIVNA (`OTPIM`) · `1010` `0`/`A` · `4700` `0`/`P` · `6040` `0`/`A` · `5110` `A`/`0` · `5795` `A+P`/`0`
**Šema 53 — `OTPIR`** — AKTIVNA (`OTPIR`) · `1320` `0`/`A` · `4700` `0`/`P` · `6040` `0`/`A` · `5010` `A`/`0` · `5796` `A+P`/`0`
**Šema 54 — `ZEMLJ` UTROSAK ROBE ZA POPRAVKE** — AKTIVNA (`USLRO`) · `1320` `-A`/`0` · `5012` `A`/`0`

**Sumarno:** 25 aktivnih, 5 mrtvih (21 `VPTR`, 28 `KNZ`, 29 `VPSIR`, 32 `UVOZ`, 39 `AVR`).
**Jedina AKTIVNA šema koja gađa nepostojeće konto je 31 (`KNO`, knjižno odobrenje).**

### 3.5 Sloj B — `PDV_SemeKontaZaKnjizenje` (20 pravila)

**Ulaz:** konto stavke u `T_Glavna knjiga`. **Izlaz:** red u `T_PDV_GK`.
Pravilo je **1 konto = 1 red** (`Konto` je jedinstven u svih 20 redova).

Značenje svake kolone — verifikovano na 3650 stvarnih redova `T_PDV_GK`:

| kolona | značenje | dokaz |
|---|---|---|
| `Konto` | konto-okidač u GK | join `T_PDV_GK.StavkaID → T_Glavna knjiga.StavkaID` |
| `PDVEvidencija` `Text(10)` | u koju PDV knjigu ide → FK na `PDV_Knjige.PDVEvidencija` | **3623 / 3650 (99,3%) stavki ima evidenciju identičnu šemi** |
| `DugPot` `Bool` | `1` = ulazni PDV (duguje), `0` = izlazni (potražuje) | `2700`=1, `4700`=0 |
| `PDVStopa` `Currency` | stopa; koristi se za izvođenje osnovice | `PDVIznos / PDVOsnovica` = **tačno stopa** na svim kontima gde ima prometa (0.200 / 0.100) |
| `PDVOsnovica` `Bool` | `1` = **iznos na kontu JESTE osnovica** (konto nije PDV nego potraživanje/prihod); `0` = iznos je PDV, osnovica se izvodi | `2050 IZVOZ` = 1 (osnovica 123.849.109, PDV 0); `4331 POLJO` = 1 |
| `ObracunPDVOsnovica` `Bool` | ulazi li osnovica u obračun PPPDV-a | kopira se 1:1 u `T_PDV_GK.ObracunPDVOsnovica` |
| `ObracunPDVIznos` `Bool` | ulazi li iznos PDV-a u obračun | kopira se 1:1 |
| `PDVGrupa` `Text(10)` | `VISA` / `NIZA` / `BEZPDV` / `POLJO` | kopira se 1:1 |
| `AOP_POPDV` `Text(10)` | **prazno u svih 20 redova — MRTVA KOLONA** (zamenio je sloj C) | — |

> ✅ **Provera integriteta:** `ObracunPDVOsnovica`, `ObracunPDVIznos` i `PDVGrupa` u stavci
> `T_PDV_GK` odstupaju od šeme u **0 od 3650** slučajeva. Pravila se doslovno kopiraju.

**Svih 20 pravila** (identično u 2025 i 2026):

| konto | PDVEvidencija | DugPot | stopa | Osn | ObrOsn | ObrIzn | grupa | n(2025) |
|---|---|---:|---:|---:|---:|---:|---|---:|
| `2050` | `IZVOZ` | 1 | 0 | **1** | 1 | 0 | BEZPDV | 9 |
| `2700` | `UF` | 1 | 20 | 0 | 1 | 1 | VISA | 2911 |
| `2701` | `UF` | 1 | 20 | 0 | 1 | 1 | VISA | 0 |
| `2705` | `UFINT-OPST` | 1 | 20 | 0 | 0 | 1 | VISA | 11 |
| `2710` | `UF` | 1 | 10 | 0 | 1 | 1 | NIZA | 135 |
| `2720` | `UF-DATAVAN` | 1 | 20 | 0 | 0 | 1 | VISA | 385 |
| `2730` | `UF-DATAVAN` | 1 | 10 | 0 | 0 | 1 | NIZA | 2 |
| `2740` | `UVOZ` | 1 | 20 | 0 | 1 | 1 | VISA | 125 |
| `2750` | `UVOZ` | 1 | 10 | 0 | 1 | 1 | NIZA | 0 |
| `2760` | `UF` | 1 | 20 | 0 | 1 | 1 | VISA | 0 |
| `2780` | `POLJO` | 1 | 8 | 0 | 0 | 1 | POLJO | 0 |
| `4331` | `POLJO` | 0 | 8 | **1** | 1 | 0 | POLJO | 0 |
| `4700` | `IF-OPSTA` | 0 | 20 | 0 | 1 | 1 | VISA | 4 |
| `4701` | `IFINT-OPST` | 0 | 20 | 0 | 0 | 1 | VISA | 7 ⚠️ |
| `4702` | `IFINT-OPST` | 0 | 20 | 0 | 0 | 1 | VISA | 7 ⚠️ |
| `4710` | `IF-POSEBNA` | 0 | 10 | 0 | 1 | 1 | NIZA | 0 |
| `4720` | `IFAV-OPSTA` | 0 | 20 | 0 | 0 | 1 | VISA | 27 |
| `4730` | `IFAV-POSEB` | 0 | 10 | 0 | 0 | 1 | NIZA | 0 |
| `4760` | `IF-OPSTA` | 0 | 20 | 0 | 1 | 1 | VISA | 0 |
| `4761` | `IF-POSEBNA` | 0 | 10 | 0 | 1 | 1 | NIZA | 0 |

`PDV_Knjige` (17 redova) mapira evidenciju na AOP polje PPPDV obrasca:
`IF-OPSTA`→osn.003/PDV.103, `IF-POSEBNA`→004/104, `IFAV-OPSTA`→–/103, `UF`→008/108,
`UVOZ`→006/106, `IZVOZ`→001/000, `POLJO`→007/107, `UF-BEZPRAV`→008/000.

> 🔴 **Anomalija za proveru sa knjigovođom:** `4701` i `4702` (izlazni PDV na prodaju proizvoda /
> robe na domaćem tržištu) su mapirani na **`IFINT-OPST` = „IF-Interni obračuni"**, ne na
> `IF-OPSTA`. Posledica u podacima 2025: od 31 GK stavke na `4701` samo 7 je generisalo red u
> `T_PDV_GK`, i to sa **osnovicom 0 i PDV-om 0**, iako je promet na kontu 109.007.504 RSD.
> Isto na `4702`. Praktično: **izlazni PDV od redovne prodaje ne ulazi automatski u PDV knjigu** —
> unosi se drugim putem ili ručno.

> 🔴 **`T_PDV_IF` i `T_PDV_UF` su PRAZNE (0 redova) u BB_T_25.** Znači: kod Servoteha **ne postoji
> paralelni kanal PDV evidencije iz robnog** — jedini kanal je GK → `T_PDV_GK`/`T_POPDV_GK`.
> PDV prijava se izvodi **iz glavne knjige, konto po konto.** To je važno: naša PDV logika ne sme
> da se oslanja na robne dokumente kao izvor PDV knjiga.

**Stvarni promet PDV evidencije 2025** (`T_PDV_GK`, 3650 redova):

| evidencija | stopa | n | osnovica | PDV |
|---|---:|---:|---:|---:|
| `UF` | 20 | 2922 | 398.344.373 | 79.668.875 |
| `UF-DATAVAN` | 20 | 392 | 93.346.641 | 18.676.834 |
| `UF` | 10 | 137 | 484.028 | 48.403 |
| `UVOZ` | 20 | 131 | 117.205.664 | 23.441.133 |
| `IFAV-OPSTA` | 20 | 28 | 894.477.992 | 178.895.598 |
| `IFINT-OPST` | 20 | 14 | 0 | 0 |
| `UFINT-OPST` | 20 | 11 | 10.788.641 | 2.157.728 |
| `IZVOZ` | 0 | 9 | 123.849.109 | 0 |
| `IF-OPSTA` | 20 | 4 | 273.333 | 54.667 |
| `UF-DATAVAN` | 10 | 2 | −69.000 | −6.900 |

### 3.6 Sloj C — `POPDV_SemeKontaZaKnjizenje` (84 pravila u 2026)

**Ulaz:** konto stavke u GK. **Izlaz:** red u `T_POPDV_GK` sa 4 iznosa `K1Iznos`…`K4Iznos`.
Ključ je **(`Konto`, `PDVOznaka`)** — isto konto može puniti više POPDV polja (v. `4704`, `4705`, `47250`).

**Gramatika `K1Def`…`K4Def`** (verifikovano numerički na 5132 reda `T_POPDV_GK`):

| token | značenje |
|---|---|
| `D` | uzmi `T_Glavna knjiga.Duguje` te stavke |
| `P` | uzmi `T_Glavna knjiga.Potrazuje` |
| `/0.2`, `/0.1`, `/0.20`, `/0.10`, `/0.01` | podeli — **izvedi osnovicu iz iznosa PDV-a** |
| prazno | to polje se ne puni |

Dokazi iz podataka:

```
konto 2700  oznaka 8а.2DA  def=('D/0.2','D','','')   GK D=6.734,07 → K1=33.670,35  K2=6.734,07
konto 2710  oznaka 8а.2DA  def=('','','D/0.1','D')   GK D=   16,54 → K3=   165,40  K4=   16,54
konto 4703  oznaka 3.2     def=('P/0.2','P','','')   GK P=85.766,25 → K1=428.831,25 K2=85.766,25
konto 2705  oznaka 8б.2    def=('D/0.2','','','')    GK D=220.000  → K1=1.100.000
konto 53100 oznaka 8д.2    def=('D','','','')        GK D= 49.000  → K1=49.000
```

→ **Za dvostopna POPDV polja: `K1` = osnovica po opštoj stopi, `K2` = PDV po opštoj, `K3` = osnovica
po posebnoj, `K4` = PDV po posebnoj.** Za jednokolonska polja (`8д.2`, `8в.2`, `2.4`, `1.1`, `3.4`,
`11.1`) koristi se samo `K1` sa punim iznosom.

**Grupe pravila (84 reda, BB_T_26):**

- **Pretporez `8а.*` / `8б.*`** — konta `2700`, `27001`, `27002`, `2704`, `2705`, `2709`, `2710`,
  `27102`, `2714`, `2719`, `2720`, `27200`, `2721`, `27250`, `2730`, `27300`, `5555`
- **Uvoz `6.2.1DA`** — `2740` (`D/0.2` u K1), `2750` (`D/0.1` u K2)
- **Interni obračun `3а.*`, `8г.1`** — `2760`, `4704`, `4705`, `47250`
- **Izlazni PDV `3.2` / `3.9` / `3.6`** — `4700`, `4701`, `4702`, `4703` (svi `P/0.2` + `P`),
  `4710`, `4720`, `47200`, `4721`, `4730`
- **Promet bez prava odbitka `8д.2`** — 24 troškovna konta (`51220`, `51260`, `5220`–`5293`,
  `52950`, `530xx`–`53990`, `55100`, `55200`, `5559`, `56200`) — puno `D` u `K1`
- **Kamate `8в.2`** — `5530`, `5621`–`5627`, `56260`, `56280`
- **Prihodi** — `60400`→`11.1`, `6041`/`6142`→`1.3`, `6042`/`6621`/`6628x`→`2.4`,
  `6050`/`6150`→`1.1`, `6151`→`11.1`, `6796`→`3.4`
- **Materijal bez PDV** — `10100`→`8д.2`

**Izmene 2025 → 2026** (`POPDV_SemeKontaZaKnjizenje` je jedina rule-tabela koja se menjala):

Dodato 10 pravila: `27001/8а.4DA`, `27002/8а.5DA`, `27102/8а.5DA`, `2721/8а.7NE`, `27250/8б.7`,
`2730/8а.7DA`, `27300/8а.2DA`, `47250/3а.8`, `47250/3а.8DA`, `6151/11.1`.
Uklonjeno 2: `2730/8а.2DA`, `6151/1.1`.
Izmenjeno 3:

| ključ | 2025 | 2026 | ocena |
|---|---|---|---|
| `2720 / 8а.7DA` | `('','D','','')` | `('D/0.1','D','','')` | 🐞 **`2720` je konto PDV-a po stopi 20% — delilac mora biti `0.2`. Osnovica se prijavljuje 2× uvećana.** |
| `4720 / 3.9` | `('','P','','')` | `('P/0.2','P','','')` | ✅ ispravno |
| `66289 / 2.4` | `('P','','','')` | `('+P','','','')` | vodeći `+` — `Eval()` ga toleriše, ali je aljkavo |

**Još dva sumnjiva pravila u 2026 (za proveru sa knjigovođom):**

| ključ | definicija | zašto sumnjivo |
|---|---|---|
| `27300 / 8а.2DA` | `K4 = D/0.01` | delilac `0.01` → osnovica 10× veća nego kod delioca `0.1`. Konto je „PDV u primljenim fakturama 10% ZATVARANJE" |
| `2730 / 8а.7DA` | `K3 = D`, `K4 = D/0.10` | **obrnuto od konvencije** (`2710`, `4710`, `4730` svi imaju `K3 = D/0.1` osnovica, `K4 = D` PDV) |

### 3.7 Ostala mesta gde su konta „zašivena"

Pretraga sve 201 šeme tabele u `BB_T_25.MDB` na kolone koje sadrže konto:

| lokacija | kolona | stanje kod Servoteha |
|---|---|---|
| **`Magacini`** | `KontoMag` `Text(10)` | ✅ **ŽIVO** — `1`=Magacin robe→`1320`, `2`=Repro→`1010`, `44`=Gotovi proizvodi→`9600`. Aktivira se magičnom vrednošću `Konto="MAG"` u liniji šeme: `IIf([Konto]="MAG",[Magacini].[KontoMag],[Konto])`. **Kod Servoteha se ne koristi** (nijedna linija nema `"MAG"`), ali `KontoMag` **jeste** popunjen — spreman je |
| **`R_Vrste dokumenata`** | `Analiticki konto` | popunjen na 2 vrste: `UZ`→`201`, `VPBP`→`201` |
| **`CFG_Global`** | `KEPU.KontoPazar` = `"20400"` | konto pazara za KEPU knjigu |
| **`CFG_Global`** | `SvaKontaKupaca` = `"204*"` | **wildcard obrazac** kojim aplikacija prepoznaje kupačka konta |
| **`CFG_Global`** | `VPKEPUKnjizi` = `"POSEMI"` | KEPU se knjiži „po šemi" |
| `OK_Zag` | `ZaKonto` | obračun kamate — ciljni konto |
| `KamataStavkeDetaljno` | `Konto` | obračun kamate |
| `Radni fajlovi` | `KontoKupac`, `KontoDobavljac` | privremeni radni fajl UI-a, nije trajni parametar |
| `Komitenti` | — | **NEMA polje konta.** Komitent ne nosi svoj konto; konto dolazi iz šeme, komitent je samo analitika |
| `R_Artikli` / `R_Grupa` / `R_Podgrupa` | — | **NEMA polje konta.** Grananje po artiklu je predviđeno preko `Poreklo`/`KngSifra_2` u šemi, ali se ne koristi |

> ✅ **Važno:** kod BigBit-a **konto NE visi ni na artiklu ni na komitentu.** Jedini determinanti su
> **vrsta dokumenta** (preko šeme) i **magacin** (preko `"MAG"` sentinela). To bitno pojednostavljuje
> naš model — ne treba nam „konto na artiklu".

---

## 4. Koja se konta STVARNO koriste

### 4.1 Top 60 konta po prometu — `BB_T_25.[T_Glavna knjiga]`, 01.01.–22.08.2025

```sql
-- ekvivalent (izvedeno python-om nad mdb-export CSV-om):
SELECT Konto, COUNT(*), SUM(Duguje), SUM(Potrazuje) FROM [T_Glavna knjiga] GROUP BY Konto
```

**Ukupno: 25.094 stavke, 1441 nalog, 252 konta u prometu** (od 1355 u planu → **koristi se 18,6%**).
ΣDuguje = 22.128.833.464 · ΣPotražuje = 22.130.406.353.

Kolona „anal." = % stavki na tom kontu koje nose `Analiticka sifra ≠ 0`.

| # | konto | stavki | duguje | potražuje | anal. | naziv |
|---|---|---:|---:|---:|---:|---|
| 1 | `2410` | 170 | 5.186.669.000 | 5.117.649.389 | 0% | Izvod Banca intesa 160-0000000110610-83 |
| 2 | `2485` | 18 | 4.832.000.000 | 3.951.000.000 | 0% | Orocena sredstva Banca intesa 600.000.000 |
| 3 | `2415` | 111 | 2.792.725.249 | 2.692.658.019 | 0% | Erste banka 340-11024045-42 |
| 4 | `2481` | 17 | 2.250.000.000 | 2.250.000.000 | 0% | Orocena sredstva Erste banka 500.000.000 |
| 5 | `4300` | 94 | 252.632.392 | 2.231.229.815 | 100% | Primljeni avansi, depoziti i kaucije |
| 6 | `2040` | 1270 | 799.459.093 | 760.578.976 | 100% | **Kupci u zemlji** |
| 7 | `4350` | 8668 | 656.523.205 | 696.195.202 | 100% | **DOBAVLJACI U ZEMLJI** |
| 8 | `1320` | 1466 | 625.361.133 | 218.624.961 | 99% | **Roba u prometu na veliko** |
| 9 | `1200` | 25 | 353.640.347 | 353.640.347 | 100% | Gotovi proizvodi u skladištu-segmenti |
| 10 | `9600` | 51 | 353.640.347 | 353.640.347 | 100% | Gotovi proizvodi u skladištu |
| 11 | `6141` | 24 | 0 | 545.037.518 | 100% | **Prihodi od prodaje proizvoda — domaće** |
| 12 | `1010` | 373 | 324.857.948 | 157.570.168 | 98% | **Osnovni materijal** |
| 13 | `2489` | 4 | 200.000.000 | 200.000.000 | 0% | Orocena sredstva Banca intesa 200.000.000 |
| 14 | `2442` | 110 | 185.361.113 | 184.377.455 | 0% | Prelazni devizni račun |
| 15 | `2440` | 154 | 184.737.033 | 174.457.990 | 0% | Devizni račun EUR Banca intesa |
| 16 | `4720` | 27 | 178.876.622 | 178.898.038 | 78% | **PDV po primljenim avansima 20%** |
| 17 | `9020` | 25 | 0 | 353.640.347 | 100% | Troškovi materijala, rez. delova, alata (kl. 9) |
| 18 | `9800` | 26 | 353.640.347 | 0 | 100% | Troškovi prodatih proizvoda (kl. 9) |
| 19 | `4790` | 9 | 165.281.357 | 165.281.357 | 0% | Obaveze za PDV 840-714112843-10 |
| 20 | `0230` | 18 | 298.068.640 | 0 | 78% | Nabavna vrednost opreme |
| 21 | `1530` | 120 | 176.747.176 | 71.684.284 | 100% | Placeni avansi za robu u inostranstvu |
| 22 | `4360` | 583 | 115.307.395 | 121.721.186 | 100% | **DOBAVLJACI U INOSTRANSTVU** |
| 23 | `2050` | 9 | 123.849.109 | 102.345.479 | 100% | **Kupci u inostranstvu** |
| 24 | `4701` | 31 | 109.007.504 | 109.007.504 | 77% | PDV 20% na prodate proizvode — domaće |
| 25 | `51100` | 29 | 206.506.941 | 0 | 86% | Troškovi osn. materijala iz magacina robe (TREB-1) |
| 26 | `4302` | 6 | 100.664.687 | 100.664.686 | 100% | Primljeni avansi od pravnih lica inostranstvo |
| 27 | `2790` | 8 | 87.936.487 | 87.936.487 | 0% | Potraživanja za preplaćeni PDV |
| 28 | `4500` | 740 | 84.733.469 | 84.558.423 | 0% | Obaveze za neto zarade |
| 29 | `3400` | 1 | 0 | 167.509.472 | 0% | Neraspoređena dobit ranijih godina |
| 30 | `2700` | 3043 | 85.456.687 | 80.367.544 | 100% | **PDV u primljenim fakturama 20%** |
| 31 | `0239` | 6 | 0 | 161.667.951 | 17% | Ispravka vrednosti postrojenja i opreme |
| 32 | `5110` | 30 | 147.107.991 | 0 | 93% | Troškovi osnovnog materijala za izradu |
| 33 | `6150` | 2 | 0 | 111.552.544 | 100% | Prihodi od prodaje proizvoda — inostrano |
| 34 | `5200` | 24 | 106.226.801 | 0 | 0% | Troškovi zarada (bruto) |
| 35 | `1520` | 502 | 76.489.503 | 12.748.250 | 100% | Placeni avansi za robu u zemlji |
| 36 | `3410` | 1 | 0 | 77.652.295 | 0% | Neraspoređena dobit tekuće godine |
| 37 | `6140` | 88 | 0 | 75.450.230 | 100% | **Prihodi od prodaje usluga — domaće** |
| 38 | `46900` | 59 | 32.905.078 | 32.932.339 | 0% | POREZI I DOPRINOSI |
| 39 | `02105` | 1 | 63.587.137 | 0 | 0% | Zemljište 19446m² KP 6216 |
| 40 | `02209` | 1 | 45.409.749 | 0 | 0% | Objekat-zgrada (P+1) 112m² Čukarica |
| 41 | `02102` | 1 | 44.485.384 | 0 | 0% | Zemljište 2.036m² KP 6145 |
| 42 | `2740` | 125 | 23.010.569 | 20.724.201 | 94% | PDV plaćen pri uvozu dobara 20% |
| 43 | `24191` | 2 | 20.000.000 | 20.000.000 | 0% | Prenos sa računa na račun |
| 44 | `02206` | 1 | 38.485.818 | 0 | 0% | Hala 6 2082m² |
| 45 | `2720` | 385 | 19.275.260 | 19.163.502 | 98% | PDV u datim avansima 20% |
| 46 | `452` | 14 | 14.352.668 | 14.352.668 | 0% | Doprinosi na teret radnika |
| 47 | `2441` | 19 | 14.087.519 | 14.061.066 | 0% | Devizni račun USD |
| 48 | `5300` | 138 | 26.250.952 | 0 | 100% | TROŠKOVI PROIZVODNIH USLUGA |
| 49 | `4630` | 258 | 11.866.888 | 11.866.888 | 100% | Obaveze prema radnicima |
| 50 | `02252` | 1 | 23.413.360 | 0 | 0% | Objekat I 484m² magacin |
| 51 | `02207` | 2 | 23.084.759 | 0 | 0% | Hala 7 1271m² |
| 52 | `02250` | 3 | 22.884.952 | 0 | 67% | Objekat I 167m² stan |
| 53 | `5113` | 649 | 22.280.647 | 0 | 100% | Troškovi alata i sitnog inventara |
| 54 | `453` | 14 | 11.134.072 | 11.134.072 | 0% | Obaveze za poreze i doprinose na teret poslodavca |
| 55 | `6040` | 352 | 0 | 19.263.298 | 100% | **Prihodi od prodaje robe na veliko u zemlji** |
| 56 | `0450` | 11 | 16.848.000 | 2.106.000 | 100% | Dugoročni krediti u zemlji |
| 57 | `4703` | 95 | 3.457.280 | 15.090.046 | 93% | Obaveze za PDV — USLUGE 20% |
| 58 | `5320` | 96 | 15.750.276 | 0 | 100% | Troškovi tekućeg održavanja objekata i opreme |
| 59 | `451` | 14 | 7.370.188 | 7.370.188 | 0% | Obaveze za porez na zarade |
| 60 | `66285` | 8 | 0 | 13.687.318 | 0% | Prihod od kamata na oročena sredstva (600 mil.) |

**Promet po klasi 2025:**

| klasa | stavki | duguje | potražuje |
|---|---:|---:|---:|
| 0 | 116 | 744.356.435 | 186.305.628 |
| 1 | 2.518 | 1.559.899.274 | 816.603.947 |
| 2 | 6.173 | 16.804.834.722 | 15.668.050.521 |
| 3 | 4 | 0 | 245.481.764 |
| 4 | 11.568 | 1.681.373.485 | 3.725.673.332 |
| 5 | 4.001 | 631.088.854 | 3 |
| 6 | 612 | 0 | 781.010.465 |
| 9 | 102 | 707.280.694 | 707.280.694 |

**Kontrola:** nijedno konto u glavnoj knjizi ne nedostaje u kontnom planu (0 sirotana).

**Za uporedbu, 2026 (`BB_T_26`, 20.366 stavki do 11.07.2026, 268 konta u prometu):** ista slika,
uz jednu razliku — na vrhu je **`7000` „Račun otvaranja glavne knjige"** sa 2.641.674.021 na obe
strane (početno stanje 2026 se knjiži preko konta `7000`, dok je u 2025 korišćena vrsta naloga `PS`).

### 4.2 Promet po vrsti naloga 2025 (`T_Nalozi.[Vrsta naloga]`)

| vrsta | stavki | opis |
|---|---:|---|
| `IZVOD` | 4624 | IZVOD |
| `TROS` | 4391 | Troškovi poslovanja |
| `UFROB` | 2900 | Ulaz robe u magacin |
| `IZV-E` | 2329 | Izvod Erste banka |
| `BPDV` | 1774 | Troškovi bez korišćenja PDV-a |
| `IFR` | 1760 | Izlazne fakture robe |
| `UVOZ` | 1072 | Uvoz (**ručni nalog — vrsta dok. `UVOZ` nema šemu**) |
| `UFMAT` | 1018 | Ulaz materijala u magacin |
| `PS` | 989 | Početno stanje |
| `NALOG` | 887 | Nalog (slobodan ručni) |

`Vrsta naloga` ima **112 vrednosti**, od kojih je ~30 zapravo **po bankovnom računu**
(`INTES`, `IZV-E`, `IZVE1`, `DEVRN`, `DEVR2`, `ISRP`, `IZVP1`…). Vrsta naloga u BigBit-u
istovremeno igra ulogu „dnevnika" i „izvora".

### 4.3 Kvalitet podataka u glavnoj knjizi

- **19 od 1441 naloga ne balansira.** 18 su zaokruženja (±0,01–0,02).
  **Jedan je stvaran: nalog `6541`, razlika −1.572.889,76 RSD** (7 stavki, devizni avansi,
  dokument `828/P/2025` — konto `1530` proknjižen na potražnu stranu bez protivstavke).
  ⚠️ **BigBit dozvoljava upis nebalansiranog naloga u glavnu knjigu.** Kod nas
  `LedgerNotBalancedException` to sprečava — što znači da **prenos istorije 1:1 neće proći**.

---

## 5. Saldakonta i analitike

### 5.1 Registar saldakonta — `PSF_AnalitickaKonta_T`

**Samo 9 redova.** To je ceo BigBit registar saldakonta:

| konto | DinSaldo | DevSaldo | OTST | naziv |
|---|---:|---:|---:|---|
| `1520` | 1 | 0 | 1 | Placeni avansi za robu u zemlji |
| `1521` | 1 | 0 | 1 | (avansi) |
| `1530` | 1 | 0 | 1 | Placeni avansi za robu u inostranstvu |
| `2040` | 1 | 0 | 1 | **Kupci u zemlji** |
| `2050` | 1 | 0 | 1 | **Kupci u inostranstvu** |
| `4300` | 1 | 0 | 1 | **Primljeni avansi, depoziti i kaucije** |
| `4302` | 1 | 0 | 1 | Primljeni avansi od pravnih lica inostranstvo |
| `4350` | 1 | 0 | 1 | **DOBAVLJACI U ZEMLJI** |
| `4360` | 1 | 0 | 1 | **DOBAVLJACI U INOSTRANSTVU** |

Kolone: `DinSaldo` = vodi dinarski saldo, `DevSaldo` = vodi devizni saldo (**0 na svim — devizni
saldakonto se NE vodi, ni za `2050` ni za `4360`!**), `OTST` = otvorene stavke (open items).
Identično u 2025 i 2026.

### 5.2 Šta je „analitika" u praksi (šire od saldakonta)

`T_Glavna knjiga.[Analiticka sifra]` `Long` → **`Komitenti.Sifra`, 100% (806/806)**.

Ali se **ne koristi samo na saldakontima** — od 252 konta u prometu, **123 (49%) nose analitiku**.
Kod Servoteha se komitent lepi i na PDV konta i na troškovna:

| konto | stavki | sa analitikom | razl. komitenata |
|---|---:|---:|---:|
| `4350` Dobavljači | 8668 | 8668 (100%) | 553 |
| `2700` PDV u prim. fakt. | 3043 | 3036 (99,8%) | 438 |
| `1320` Roba | 1466 | 1458 (99,5%) | 278 |
| `2040` Kupci | 1270 | 1270 (100%) | 90 |
| `5113` Alat i sitan inventar | 649 | 649 (100%) | 133 |
| `1520` Plaćeni avansi | 502 | 502 (100%) | 130 |
| `5300` Proizvodne usluge | 138 | 138 (100%) | 57 |

→ **BigBit ne razlikuje „saldakonto" od „analitike".** `PSF_AnalitickaKonta_T` je registar konta
za koja se prave **izveštaji otvorenih stavki**; sam upis komitenta na stavku je nezavisan i
bezuslovan (v. §3.3).

### 5.3 Ostale analitičke dimenzije u `T_Glavna knjiga`

Prebrojano na 25.094 stavke 2025:

| kolona | popunjeno | stvarna upotreba |
|---|---:|---|
| `Analiticka sifra` | 13.000+ | **komitent** — jedina prava analitika |
| **`Pozicija`** `Text(10)` | 12.500 | 🔴 **NIJE mesto troška!** Vrednosti: `elektronsk`(i) 9771, `fiskalni` 1778, `drugi` 446, `uvoz` 430, `oslobodj` 75. Polje je **prenamenjeno u oznaku vrste ulaznog dokumenta za PDV/KEPU svrhe.** Original (`RadniNalozi.Pozicija`) se ne koristi |
| `IDPredmet` | 1.212 | ✅ **ŽIVO** — projekat/predmet. Koristi se na prodajnom lancu (`1320` 237, `2040` 222, `4702` 209, `5010` 209, `6040` 209) i na materijalu (`51100` 25, `1010` 23, `5110` 23) |
| `IDDokIzRobnog` | 6.008 | traceback ka robnom dokumentu (= stavke nastale automatski) |
| `DevValuta` / `DevDuguje` / `DevPotrazuje` | 5.384 | devizni iznos. ⚠️ **nekonzistentne vrednosti valute:** `RSD` 19710, `DIN` 4087, `eur` 998, `Din` 215 |
| `Temeljnica` | 157 | skoro mrtvo; `"-"` na svih 6008 automatskih |
| `IDRadniNalog` | **0** | ❌ mrtvo |
| `OJ` (org. jedinica) | **0** | ❌ mrtvo |
| `OD` (odeljenje) | **0** | ❌ mrtvo |
| `IDDokIzUsluga` | **0** | ❌ mrtvo |
| `InoKonto` | **0** | ❌ mrtvo |

> 🔴 **Ključan nalaz za 4.0:** Servoteh **nema mesto troška ni org. jedinicu u glavnoj knjizi.**
> Jedine dimenzije su **komitent** i **predmet**. Ako 4.0 uvodi mesto troška, to je **novo**, ne
> paritet — i nema istorije za migraciju.
> Automatski put (`NSK_ProknjiziStavkeIzRobnog.sql`) puni `Pozicija` iz `RadniNalozi.Pozicija`,
> ali ručni unos naloga tu upisuje klasifikaciju dokumenta — **isto polje, dva različita značenja.**

---

## 6. Odgovori na konkretna konta

| # | pitanje | odgovor iz podataka |
|---|---|---|
| 6.1 | **Kupci 2040 / 2050** | ✅ **POTVRĐENO.** `2040` „Kupci u zemlji" — 1270 stavki, 799,5 mil. duguje, 100% analitika, saldakonto (`PSF`), koristi ga šema 33 (`IFR`) i 36 (`IFGP`). `2050` „Kupci u inostranstvu" — 9 stavki, 123,8 mil., saldakonto, šeme 24 (`IZVRO`) i 47 (`IZVGP`), PDV evidencija `IZVOZ` sa `PDVOsnovica=1`. **ALI:** šeme 30 (`IFUSL`) i 31 (`KNO`) koriste **`2020`** („Kupci u zemlji - ostala povezana lica"), koje **nema nijednu stavku u GK 2025 ni 2026** → ⚠️ te dve šeme su pogrešno kontirane |
| 6.2 | **Dobavljači** | ✅ `4350` „DOBAVLJACI U ZEMLJI" — **najprometnije konto po broju stavki (8668)**, 553 različita komitenta, saldakonto. `4360` „DOBAVLJACI U INOSTRANSTVU" — 583 stavke, 38 komitenata, saldakonto. Nema podele po tipu dobavljača; jedini izuzeci su `43301` „Ostali dobavljači — struja, telefon, grejanje" (`Fajl sifara=OST`) i `4331` „nefakturisane obaveze" |
| 6.3 | **Primljeni avansi 4300** | ✅ **POTVRĐENO.** 94 stavke, **2.231.229.815 potražuje** (5. konto po prometu!), 100% analitika, saldakonto. Nalozi: `AVANS` 37, `PS` 35, `IZVOD` 20. Uz njega `4302` za inostrane pravne osobe. Šema 39 (`AVR`) postoji ali **nije zakačena ni na jednu vrstu dokumenta** — avansni računi se knjiže ručnim nalogom vrste `AVANS` |
| 6.4 | **PDV po izdatim fakturama 4700 / 4702 / 4710** | ✅ Sva tri postoje. **`4700`** „PDV po izdatim fakturama 20%" — koristi ga 6 šema (`REPRE`, `DONAC`, `MANJM`, `MANJR`, `OTPIM`, `OTPIR`, `IFUSL`), PDV evidencija `IF-OPSTA`, POPDV `3.2`. **`4702`** „PDV 20% na prodate robe" — šema 33 (`IFR`), 359 stavki. **`4710`** „PDV po izdatim fakturama 10%" — šeme 30, 33, 40; **0 stavki u GK 2025** (Servoteh nema prodaju po nižoj stopi). Postoje i `4701` (proizvodi, šema 36), `4703` (usluge), `47000` (18% — nasleđe), `4704`/`4705` (interni obračun licence/građevina) |
| 6.5 | **PDV po primljenim avansima 4720 / 4730** | ✅ Oba postoje. **`4720`** 20% — 27 stavki, **178.876.622 / 178.898.038**, PDV evidencija `IFAV-OPSTA`, POPDV `3.9`. **`4730`** 10% — **0 stavki**, definisano ali neiskorišćeno. Prateća: `47200` „POKRIVANJE AVANSA" (102 stavke, POPDV `3.2`) i `4721` „po vraćenim avansima" (POPDV `3.6`) |
| 6.6 | **Prihodi 6040 / 6140** | ✅ **`6040`** „Prihodi od prodaje robe na veliko u zemlji" — 352 stavke, 19,3 mil., **isključivo iz naloga `IFR`**, 100% analitika, 59% nosi `IDPredmet`. **`6140`** „Prihodi od prodaje usluga na domacem trzistu" — 88 stavki, 75,5 mil., **isključivo iz `IFUSL`**. ⚠️ **Ali `6140` NIJE u šemi 30 (`IFUSL`)!** Šema 30 knjiži na **`6121`**. Znači: prihod od usluga na `6140` nastaje **ručnim ispravkama posle automatskog knjiženja**, ili šema nije u upotrebi. Najveći prihodni konto je **`6141` (proizvodi, 545 mil.)** iz šeme 36 |
| 6.7 | **Kursne razlike 663 / 563** | ⚠️ **Sintetike `663` i `563` postoje u planu ali imaju 0 stavki.** Knjiži se na četvorocifrene: **`5630`** „Negativne kursne razlike po dugoročnim obavezama" — 186 stavki (nalozi `DEVRN` 84, `UVOZ` 60, `NALOG` 23) i **`6630`** „Pozitivne kursne razlike po dugoročnim finansijskim plasmanima" — 95 stavki. `5631`, `5632`, `5639`, `6631`, `6632` postoje ali su **prazna**. 🔴 **Nazivi konta ne odgovaraju upotrebi** — kursne razlike od redovnog deviznog poslovanja se knjiže na konta namenjena dugoročnim obavezama/plasmanima. **Nijedna šema kontiranja ne dodiruje kursne razlike** — sve ide ručnim nalogom |
| 6.8 | **Konto 1329 (naša NIV protivstavka)** | 🔴 **NE POSTOJI U BIGBIT-U.** Ni u `BB_T_25.[Kontni plan]` ni u `BB_T_26.[Kontni plan]`, ni jedne stavke u glavnoj knjizi 2025/2026. Cela grupa 132 ima **samo `132`, `1320`, `1321`** (Rezervisana roba). Detalji u §6.9 |

### 6.9 Šta BigBit stvarno radi sa nivelacijom (NIV) — presuda o kontu 1329

Utvrđeno iz tri nezavisna izvora:

1. `R_Vrste dokumenata` gde `Vrsta dokumenta = 'NIV'`:
   `Sema za kontiranje = 0`, `Knjiziti sintetiku = 0`, `Knjiziti analitiku = 0`,
   `KnjizitiUPDVEvidenciju = 0`, `UticeNaZalihe = 1`. **Identično u 2025 i 2026.**
2. `Sema za kontiranje` — među 30 šema **nijedna nema `Vrsta naloga = 'NIV'`**.
3. `Vrsta naloga` (112 vrednosti) — **nema `NIV`**. U glavnoj knjizi 2025 i 2026 ne postoji nijedan
   nalog nastao iz nivelacije.

> 🔴 **Presuda: BigBit nivelaciju NE KNJIŽI U GLAVNU KNJIGU.** Nivelacija menja isključivo
> vrednost zaliha u robnom (`Stavke nivelacije`, `UticeNaZalihe=1`). Razlika u vrednosti zaliha
> se u finansijsko prenosi tek posredno — kroz nabavnu vrednost prodate robe pri sledećoj prodaji.
>
> **Znači konto `1329` nema BigBit poreklo i nema šta da mu se „potvrdi" iz legacyja.** Ovo je
> **nova poslovna odluka**, ne paritet. Postoje dve opcije, obe legitimne, ali izbor je Nesin:
> - **(a) paritet s BigBit-om** — ukloniti `postNivLeveling` iz automatike; NIV ostaje samo robni
>   događaj. Najmanji rizik, nula odstupanja od zatečenog knjigovodstva.
> - **(b) svesno poboljšanje** — knjižiti reval. zaliha. Tada protivkonto **nije `1329`** (taj broj
>   ne postoji ni u zvaničnom kontnom okviru kao „ukalkulisana razlika u ceni robe" za veleprodaju
>   po nabavnim cenama; `Magacini.ProsecneCene = 1` na sva tri magacina → Servoteh vodi zalihe po
>   **prosečnim nabavnim cenama, bez ukalkulisane RUC**, pa konto grupe `132x` za RUC ovde nema
>   ekonomskog smisla). Realan kandidat je konto klase 5/6 (manjak/višak, npr. `6740`/`5740`) ili
>   `5010`. **Traži odluku knjigovođe.**

---

## 7. Šta ispraviti kod nas

### 7.1 Kontni plan (`accounts`)

| # | nalaz | akcija |
|---|---|---|
| K1 | Seed sadrži **8 konta koja u BigBit-u ne postoje** (`13600`, `20200`, `470`, `471`, `47100`, `50140`, `60240`, `67300`) | **Zadržati**, ali dokumentovati kao „tehnička konta za FK integritet šema 21/28/29/31". Sva su bez prometa u 12+ meseci — ne smetaju |
| K2 | Konto **`1329` nema poreklo u BigBit-u** | Zahtev za odluku (v. §6.9). Do odluke ne slati NIV u GK na produ |
| K3 | Naš seed **prati BB_T_26 od 11.07.2026** i potpun je | ✅ nema akcije. Ako BigBit i dalje radi, **pre gašenja ponoviti delta-poređenje** — u 2026 je dodato 34 konta za pola godine, tempo je ~5/mesec |
| K4 | Naš `accounts` nema `Plan duguje`/`Plan potrazuje`/`InoKonto` | ✅ ispravno — te tri kolone su mrtve u BigBit-u |
| K5 | `KontniPlan_STD` (1186 konta) | ❌ **ne migrirati** — vendorski šablon |

### 7.2 Šeme kontiranja (`accounting_schemes` / `accounting_scheme_lines`)

| # | nalaz | akcija |
|---|---|---|
| S1 | Migracija `20260723160000_seed_accounting_schemes_33_36` u komentaru tvrdi da 8 konta (`13600`, `20200`, `470`, `471`, `47100`, `50140`, `60240`, `67300`) **ne postoji u `accounts`**, i zbog toga seeduje samo šeme 33 i 36 | 🔴 **Komentar je ZASTAREO.** Migracija `…155000_seed_chart_of_accounts` (koja ide **pre** nje) sadrži svih 8. **Blokada za pun seed ne postoji više** |
| S2 | Nedostaje **23 od 25 aktivnih šema** | Seedovati preostale aktivne: **3, 24, 26, 30, 31, 34, 35, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 52, 53, 54**. Podaci su u §3.4, izvorni CSV: `mdb-export -d '|' BB_T_26.mdb 'Stavke seme za kontiranje'` |
| S3 | Šeme **21, 28, 29, 32, 39** su u BigBit-u mrtve | **Ne seedovati** (ili seedovati kao `inactive`) |
| S4 | 🐞 Šema **28 (`KNZ`)**: `DefDug = "0+P+Q"` — **cifra nula umesto slova `O`** | Ako se ikad oživljava — ispraviti u `O+P+Q`. Naš parser bi to prihvatio i knjižio samo PDV bez osnovice, isto kao BigBit |
| S5 | 🐞 Šeme **37 (`MMPM`)** i **38 (`MMPR`)** imaju **samo jednu liniju** → nalog ne balansira | Naš `LedgerNotBalancedException` bi ih odbio. **Pre seedovanja dopuniti protivstavku** (verovatno drugi `KontoMag` preko `"MAG"` sentinela — v. S7) i potvrditi s knjigovođom |
| S6 | 🐞 Šema **31 (`KNO`)** je AKTIVNA i gađa nepostojeća konta `470`/`471` + pogrešna `2020`/`6120` | Pre seedovanja ispraviti na `4700`/`4710` i `2040`/`6040`. **Traži potvrdu knjigovođe** |
| S7 | Podržan mora biti sentinel **`Konto = "MAG"`** → `Magacini.KontoMag` | Kod Servoteha se **ne koristi** (0 linija), ali `KontoMag` je popunjen (`1→1320`, `2→1010`, `44→9600`). **Niži prioritet**, ali dodati u parser da ne bismo pukli na budućoj šemi |
| S8 | ✅ Naše A–Z mapiranje u `posting.service.ts` (linije 87–120) | **TAČNO** — provereno slovo po slovo protiv `NSK_VrednostiPoSemiZaKnjizenje1K.sql`. Nema izmene |
| S9 | `origin` (`Poreklo`) i `itemCodebook` (`KngSifra_2`) u našoj šemi | Kolone su ispravno preslikane. **Logiku grananja NE implementirati** — `Poreklo="X"` na svih 105 linija (catch-all), `KngSifra_2="0"` je mrtva kolona koju BigBit nigde ne čita |
| S10 | `postsAnalytics` = `Analitika` | ✅ ispravno. Napomena: **svih 105 linija ima `True`** i aktivna NSK grana **uopšte ne filtrira po toj koloni** — sintetička grana je mrtvi kod |

### 7.3 Saldakonta (`saldakonto_accounts`)

| # | nalaz | akcija |
|---|---|---|
| SK1 | 🔴 Tabela `saldakonto_accounts` je kreirana (`20260719130000_faza1_gl_registri`) ali **NIKAD SEEDOVANA — prazna je.** Nema nijednog `INSERT`-a nigde u repou | **Seedovati 9 redova iz `PSF_AnalitickaKonta_T`**: `1520`, `1521`, `1530` (potraživanja/avansi), `2040`, `2050` (potraživanja), `4300`, `4302`, `4350`, `4360` (obaveze) — svi `holdsDinBalance=true`, `tracksOpenItems=true`, **`holdsFxBalance=false`** (u BigBit-u je `DevSaldo=0` na svima, i za `2050`/`4360`) |
| SK2 | Naš model ima `controlAccount` kojeg u BigBit-u nema | ✅ svesno poboljšanje (v. komentar u `schema.prisma:2833`). Popuniti: `2040→204`, `2050→205`, `4350→435`, `4360→436`, `4300→430`, `4302→430`, `1520→152`, `1521→152`, `1530→153`. **Napomena:** `435` i `4351` postoje tek od 2026 |
| SK3 | Naš `holdsFxBalance` za `2050`/`4360` | BigBit ga **ne vodi** (`DevSaldo=0`), ali `T_Glavna knjiga` ima `DevDuguje`/`DevPotrazuje`/`DevValuta` popunjene na 5384 stavke. **Odluka:** ako 4.0 uvodi devizni saldo — to je novo, ne paritet |

### 7.4 PDV automatika

| # | nalaz | akcija |
|---|---|---|
| P1 | 🔴 **PDV evidencija se kod Servoteha izvodi ISKLJUČIVO iz glavne knjige** (`T_PDV_IF` i `T_PDV_UF` su prazne). Okidač je **konto GK stavke**, ne robni dokument | **Naša PDV logika mora imati taj put:** za svaku GK stavku pogledaj `PDV_SemeKontaZaKnjizenje[konto]` → napravi PDV zapis. Bez toga PDV prijava ne radi za ručne naloge, a to je 100% Servotehovog PDV-a |
| P2 | Treba nam tabela pravila `PDV_SemeKontaZaKnjizenje` (20 redova) i `PDV_Knjige` (17) | Seedovati iz §3.5 |
| P3 | Treba nam `POPDV_SemeKontaZaKnjizenje` (84 reda, BB_T_26) + parser gramatike `D`/`P`/`/0.x` | Seedovati iz §3.6. Parser je trivijalan: `[+-]?[DP](/broj)?` |
| P4 | 🐞 `2720 / 8а.7DA` u 2026 ima `K1 = D/0.1`, a konto je PDV **20%** | **NE prepisivati grešku.** Ispraviti u `D/0.2` uz napomenu knjigovođi da je POPDV 8а.7 u 2026 prijavljivan s 2× uvećanom osnovicom |
| P5 | 🐞 `27300 / 8а.2DA` ima `K4 = D/0.01` (verovatno `0.1`) i `2730 / 8а.7DA` ima K3/K4 obrnuto od konvencije | Označiti kao „za proveru", ne seedovati slepo |
| P6 | 🔴 `4701`/`4702` mapirani na `IFINT-OPST` (interni obračun) umesto `IF-OPSTA` → izlazni PDV od prodaje ne ulazi u PDV knjigu | **Pitanje za knjigovođu pre migracije.** Ako je greška — ispraviti; ako je namerno — dokumentovati zašto |

### 7.5 Analitičke dimenzije

| # | nalaz | akcija |
|---|---|---|
| A1 | `Analiticka sifra` = komitent, **bezuslovno, na svakoj stavci dokumenta** | ✅ naš `analyticalCode: line.postsAnalytics ? analyticalCode : null` je paritetan |
| A2 | 🔴 **`Pozicija` NIJE mesto troška** — Servoteh je koristi za oznaku vrste ulaznog dokumenta (`elektronski`/`fiskalni`/`drugi`/`uvoz`/`oslobodj`) | Ako 4.0 mapira `Pozicija → costCenter`, **to je pogrešno**. Ili preneti kao `documentOrigin`, ili ignorisati |
| A3 | `IDPredmet` je živ (1212 stavki, prodajni lanac + materijal) | ✅ zadržati kao dimenziju |
| A4 | `IDRadniNalog`, `OJ`, `OD`, `IDDokIzUsluga`, `InoKonto` su **prazni u 100% stavki** | Ne graditi izveštaje na njima; nema istorije |
| A5 | `DevValuta` ima 4 varijante za dinar (`RSD`, `DIN`, `Din`, `eur` malim slovima) | Pri migraciji istorije normalizovati |

### 7.6 Migracija istorije glavne knjige

| # | nalaz | akcija |
|---|---|---|
| M1 | 🔴 **`T_Glavna knjiga` sadrži nebalansiran nalog** (`6541`, −1.572.889,76) + 18 sa zaokruženjima | Migracioni put mora imati **`--allow-unbalanced` režim** za istorijske naloge, inače prenos puca. Alternativa: uvesti stavku „prenos razlike" |
| M2 | 2025 baza (`BB_T_25.MDB`) je snimak od **22.08.2025** — nema sep–dec 2025 | Pre migracije **povući svež snimak** obe godine |
| M3 | `Datum dokumenta` ima vrednosti do `07/09/42` i od `04/03/02` | Sanity-check datuma pri uvozu |
| M4 | Početno stanje: 2025 koristi vrstu naloga `PS`, 2026 konto **`7000`** „Račun otvaranja glavne knjige" | Podržati oba obrasca |

---

## Prilog — komande za ponavljanje analize

```bash
# spisak tabela
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-tables -1 /d/BB_T_26.mdb"

# rule tabele (OBAVEZNO -d '|')
for T in 'Kontni plan' 'Sema za kontiranje' 'Stavke seme za kontiranje' \
         'PDV_SemeKontaZaKnjizenje' 'POPDV_SemeKontaZaKnjizenje' \
         'PSF_AnalitickaKonta_T' 'R_Vrste dokumenata' 'Magacini' 'Vrsta naloga'; do
  ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export -d '|' /d/BB_T_26.mdb '$T'"
done

# glavna knjiga (bez -d, nema slobodnog teksta sa |)
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export /d/BB_T_26.mdb 'T_Glavna knjiga'"

# parametri aplikacije
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export -d '|' /d/APL.MDB CFG_Apl_SviParametri"

# šifre konta iz našeg seed-a (za delta-poređenje)
grep -oE "^\('[^']*'" backend/prisma/migrations/20260723155000_seed_chart_of_accounts/migration.sql \
  | sed "s/^('//; s/'$//"
```

**Povezani dokumenti:** [18-gl-pdv-kontiranje-rekonstrukcija.md](18-gl-pdv-kontiranje-rekonstrukcija.md) ·
[30-glavna-knjiga-modul-dubinski.md](30-glavna-knjiga-modul-dubinski.md) ·
[43-gl-posting-formule-A-Z-iz-koda.md](43-gl-posting-formule-A-Z-iz-koda.md) ·
[44-zr-bilans-motor-iz-vba.md](44-zr-bilans-motor-iz-vba.md) ·
[BB_T_26_klaster_C_finansije-pdv-gk.md](BB_T_26_klaster_C_finansije-pdv-gk.md)

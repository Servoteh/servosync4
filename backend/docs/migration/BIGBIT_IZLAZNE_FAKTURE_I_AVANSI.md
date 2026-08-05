# BigBit — izlazne fakture (KIF) i avansni računi: rekonstrukcija iz produkcijske baze

**Datum analize:** 25.07.2026.
**Izvori (sve provereno pokretanjem, ne po sećanju):**

| Izvor | Putanja / komanda |
|---|---|
| Produkcijska baza 2025 (311 MB, 201 tabela) | `ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export /d/BB_T_25.MDB '<tabela>'"` |
| Produkcijska baza 2026 (tekuća godina) | isto, `/d/BB_T_26.mdb` |
| Aplikaciona baza (POPDV definicije) | isto, `/d/APL.MDB` |
| **BigBit VBA + Access upiti + dizajn izveštaja** | `_legacy/BigbitRaznoNenad/_extracted/` (`OnLine_BigBit_VBA/`, `OnLine_BigBit_Design/`, `queries_full/`, `rule_tables/BB_T_26/`) |
| VBA (deljeni moduli) | `_legacy/Izvoz/VBA/IF_Modul.bas`, `USLF_Module.bas`, `DodelaPLU.bas`, `SemaZaKontiranje.bas` |

> **Napomena o topologiji izvora:** `_legacy/QBigTehn_APL/` je export **QBigTehn** (tehnologija),
> NE BigBit ERP-a. Pravi BigBit APL kod je u `_legacy/BigbitRaznoNenad/_extracted/`.
> Nekoliko modula (`IF_Modul.bas`, `USLF_Module.bas`, `SemaZaKontiranje.bas`) postoji u oba.

Sve tvrdnje niže nose izvor u obliku `tabela.kolona` ili konkretan red podataka.
Gde izvor ne postoji — piše **NEPOZNATO**.

---

## 0. Ključna arhitektonska činjenica (pročitati prvo)

**BigBit kod Servoteha NE vodi KIF kao zasebnu tabelu.** `T_PDV_IF` je **prazna**
(0 redova u `BB_T_25.MDB`, 0 u `BB_T_26.mdb`, 0 u `BB_T.MDB`; provereno `mdb-export | wc -l` = 1,
samo zaglavlje). Isto i `PDV_IF_PU_MAP` (0) i `T_Profakture` (0).

PDV evidencija se **izvodi iz Glavne knjige**:

```
T_Glavna knjiga.Konto  ──(PDV_SemeKontaZaKnjizenje.Konto)──►  T_PDV_GK  ──►  PDV_Knjige (AOP na PPPDV)
                       ──(POPDV_SemeKontaZaKnjizenje.Konto)─►  T_POPDV_GK ──► POPDV_DEF_APL (polja POPDV)
```

`T_PDV_GK` (3.650 redova, 2025) drži `StavkaID` = FK na `T_Glavna knjiga.StavkaID`.
Tj. **konto na kome je nešto proknjiženo JESTE poreska evidencija.** Zato su tačna konta
u BigBit-u kritična — nisu „samo GK", oni direktno prave PPPDV/POPDV.

> Posledica za 4.0: naš `pdv` modul koji vodi zaseban KIF registar je **drugačija arhitektura**
> (nije nužno gora), ali mapiranje konto → poresko polje moramo preslikati 1:1, jer je to
> jedina tačka gde BigBit odlučuje šta ide u koje polje prijave.

---

## 1. Vrste izlaznih dokumenata

Izvor: `R_Vrste dokumenata` (57 redova) + stvarni brojevi iz `T_Robna dokumenta` /
`T_Usluge dokumenta` za 2025.

| Vrsta | Opis (`Opis`) | Tabela dokumenta | `Sema za kontiranje` | `KnjizitiUPDVEvidenciju` | `PrefiksBrojaDok` | `UticeNaZalihe` | kom. 2025 |
|---|---|---|---|---|---|---|---|
| `PON` | Ponuda | Robna + Usluge | 0 | 0 | `PN-` | 1 | 575 |
| `PROF` | Profaktura (predračun) | Robna + Usluge | 0 | 0 | — | 1 | 11 |
| **`AVR`** | **Avansni račun** | **Usluge** | **0** | **0** | **`AR-`** | **0** | **21** |
| `IFR` | Račun - otpremnica (roba) | Robna | **33** | 1 | — | 0 | 352 |
| `IFGP` | Račun - otpremnica Gotovi proizvodi | Robna | **36** | 1 | — | 1 | 25 |
| `IFUSL` | Usluge izlaz | Usluge | **30** *(zastarela)* | 1 | — | 1 | 101 |
| `IZVRO` | Izvozna faktura za robu | Robna | **24** | 0 | — | 1 | 0 |
| `IZVGP` | Izvoz gotovih proizvoda | Robna | **47** | 1 | — | 1 | 2 |
| `IZVUS` | IZVOZ USLUGA | Usluge | 0 | 1 | — | 1 | 3 |
| `KNO` | Knjižno odobrenje | Usluge | **31** | 1 | — | 0 | 0 |
| `KNZ` | Knjižno zaduženje | Usluge | **28** *(nepotpuna)* | 1 | — | 1 | 0 |
| `OTP` | Otpremnica | Robna + Usluge | 0 | 0 | — | 1 | 52 |
| `MP1` | Maloprodaja | `T_MPDokumenta` | 0 | 0 | — | 1 | — |
| `VPBP` | Velikoprodaja bez poreza | Robna | 0 | 0 | — | 1 | 0 |
| `VPTR` | Roba prodata u tranzitu | Robna | 21 | 1 | — | 1 | 0 |
| `DONAC` / `REPRE` | Donacija / Reprezentacija (sopstvena potrošnja) | Robna | 42 / 40 | 1 | — | 1 | 0 |

**Revers** — `Reversi` / `ReversiStavke` su ZASEBNE tabele, nisu vrsta dokumenta u
`R_Vrste dokumenata` (v. već postojeći doc `33-reversi-bigbit-vs-2.0-homonim.md`).

### Nalazi koje treba znati

1. **`AVR` je jedini izlazni dokument sa `UticeNaZalihe = 0`, `Sema za kontiranje = 0` i
   `KnjizitiUPDVEvidenciju = 0`.** Avansni račun ne dira zalihu, nema automatsko knjiženje i
   ne ulazi sam po sebi u PDV evidenciju — u PDV evidenciju ulazi **konto na koji ga
   knjigovođa ručno proknjiži** (v. §4).
2. **Avansni računi žive u `T_Usluge dokumenta`**, ne u robnom dokumentu — iako se
   avansiraju i roba i gotovi proizvodi. (`T_Usluge dokumenta.Vrsta dokumenta = 'AVR'`,
   62 kom. 2023, 52 kom. 2024, 21 kom. 2025, 9 kom. 2026 do maja.)
3. **`R_Vrste dokumenata.UticeNaZalihe` je nepouzdana kolona.** `IFR` ima 0 iako
   demonstrabilno razdužuje zalihu (`1320` POT / `5010` DUG u svakom od 352 naloga, v. §3).
   Stvarno razduženje diktira **šema kontiranja**, ne ovaj flag.
4. `R_Vrste dokumenata.NumeracijaOd` je 0 za sve — **nije brojač** (v. §2).
5. `Prodaja sa PPP` / `Prodaja sa PPU` / `KOTP` / `KODJ` / `FR` — semantika **NEPOZNATO**
   (nema je ni u podacima ni u dostupnom VBA; za `AVR` je `Prodaja sa PPP = 1`).

---

## 2. Numeracija

### 2.1 Izlazne fakture — JEDNA zajednička godišnja serija

Ovo je najvažniji nalaz o numeraciji i **razlikuje se od našeg 4.0**.

`IFR`, `IFGP`, `IFUSL`, `IZVGP`, `IZVUS` — **svi dele jedan niz `NNN/YY` po godini**, bez
obzira što neki žive u `T_Robna dokumenta` a neki u `T_Usluge dokumenta`:

```
IFR   2025:  001/25, 002/25, 003/25, …, 483/25, 484/25, 485/25   (352 kom.)
IFUSL 2025:  011/25, 013/25, 026/25, …, 458/25, 476/25, 486/25   (101 kom.)
IZVGP 2025:  228/25, 272/25                                       (2 kom.)
IZVUS 2025:  194/25, 199/25, 275/25                               (3 kom.)
```
Ukupno 483 izlazne fakture, najveći broj u seriji **486/25** — serija je gotovo bez rupa,
što potvrđuje da je **jedinstvena**.

Sufiks `/1` označava ispravku/reizdavanje: `012/25/1`, `045/25/1`, `0273-25/1`.

### 2.2 Ponude / profakture — druga serija

`PON` i `PROF` dele niz `NNNN-YY`: `0938-24`, `0954-25`, `0080-25/1`, `0407-25`.

### 2.3 Avansni računi — treća, sopstvena serija

`AVR` ima svoj godišnji niz. Format se **promenio u avgustu 2024**:

```
do 08/2024 (ručno):  01/24, 02/24, 42/23/2, 49/23/1, 035-24, U0034-24, U0046-24, 43/24-
od 08/2024 (auto):   AVR-00001/2024, AVR-00001/2025 … AVR-00021/2025, AVR-00001/2026 …
```
Auto-format = `Left(VrstaDok,3)` + `-` + 5-cifreni brojač + `/` + 4-cifrena godina.
Isti obrazac se vidi kod drugih vrsta: `PRO-00002/2025` (PROF), `IFG-00025/2025` (IFGP).

Brojač se **resetuje po godini** (`AVR-00021/2025` → `AVR-00001/2026`).

Operater i dalje može da **prekuca broj**: 2025 ima `AVR0005-25` i `AVR-000016/2025`
(višak nule), 2026 ima `0012-26`, `0016-26`, `0017-26` (preuzeti brojevi profakture).

### 2.4 Algoritam dodele broja — **COUNT + 1, po (firma, godina, vrsta, level)**

Nema tabele brojača. Broj se svaki put **prebroji iz tabele dokumenata**.

`_legacy/Izvoz/VBA/DodelaPLU.bas:419-487` (`SledeciBrojDokumentaUsluga` — ovim se numerišu AVR):
```vba
  stWhere = "([IDFirma] = " & F_IDFirma() & ")"
  If lintGodina <> 0 Then stWhere = stWhere & " AND ([Godina] = " & lintGodina & ")"
  stWhere = stWhere & " AND ([Vrsta dokumenta] = '" & stVrstaDokumenta & "')"
  stWhere = stWhere & " AND ([Level] = " & pLevel & ")"          '23-05-2023
  ...
  numPoslednjiBrojDokumenta = Nz(DCount("*", "T_Usluge dokumenta", stWhere), 0)
  ...
  stRetVal = CStr(1 + numPoslednjiBrojDokumenta)
  stRetVal = DoChLeft(stRetVal, BBCFG.BrojZnakovaZaBrDok, "0")
  SledeciBrojDokumentaUsluga = stPrefix & stRetVal & stSufix
```
Pozivno mesto — `_extracted/OnLine_BigBit_VBA/Doc__Form_USLUGA Faktura.txt:648`:
```vba
Me![Broj dokumenta] = SledeciBrojDokumentaUsluga(CStr(Me![Vrsta dokumenta - lista]), _
                        Left(CStr(Me![Vrsta dokumenta - lista]), 3) & "-", "/" & F_Godina())
```
i za robu — `Doc__Form_Izlazna faktura.txt:910` (isti obrazac, `SledeciBrojDokumenta`).

**Formula:** `Left(VrstaDok,3) & "-"` + `zeroPad(1 + COUNT, BBCFG.BrojZnakovaZaBrDok)` + `"/" & Godina`.

Provera nad podacima: 21 AVR dokument u 2025 → `AVR-00001/2025` … `AVR-00021/2025`,
zero-pad na 5 mesta. **Poklapa se do u znak.** ✔

Novije verzije delegiraju na SQL Server UDF `dbo.fsSledeciBrojDokumenta`
(`DodelaPLU.bas:161-262`), sa istom semantikom.

Postoji i stara varijanta sa brojačem u tabeli `Parametri za rad`
(`Poslednji broj fakture` / `Poslednji broj profakture`, `DodelaPLU.bas:103-160`) — mrtva.

**Slabosti algoritma (relevantno za 4.0):**
* `COUNT+1` je **race-condition prone** (dva korisnika istovremeno dobiju isti broj) —
  naš `DocumentNumberSequence` sa `SELECT … FOR UPDATE` je strogo bolji;
* `COUNT+1` **puca kad se dokument obriše** (ponovo dodeli već korišćen broj);
* `MaxBrojDokPoVrstama` (alternativa `AutoBrojDok='MaxVrstaDok'`) u `OnLine_BigBit_APL` verziji
  radi `Max([Broj dokumenta])` **bez `Format`** → poredi kao TEKST („9" > „10").

### 2.5 Zašto se auto-broj i stvarni brojevi razlikuju

Kod generiše broj **po vrsti dokumenta** (`IFR-00123/2025`), ali knjigovodstvo ga
**prekucava** na jedinstvenu seriju `NNN/YY` (§2.1). Zato u podacima 2025 postoje samo
tri dokumenta sa auto-formatom (`PRO-00002/2025`, `IFG-00025/2025`, i AVR-i).
Za **AVR se auto-broj prihvata** (svih 21 u 2025), za fakture **ne**.

`R_Vrste dokumenata.PrefiksBrojaDok` (`AR-` za AVR, `PN-` za PON) je **zakomentarisan u svim
formama** — vidi `Doc__Form_Izlazna faktura.txt:908`
(`'Me![Broj dokumenta] = Me.PrefiksBrojaDok & DoChLeft(...)`) i isto u `USLUGA Faktura`,
`Profaktura`. Koristi se još samo za `BrojPotvrde` na potvrdi porudžbine
(`Doc__Form_Profaktura.txt:857`). Zato je u GK neujednačeno: stavka 100226 nosi
`AR-00001/2025` za dokument `AVR-00001/2025`, stavka 107433 `AR-AVR0005-25` za `AVR0005-25`
— **prefiks tamo dopisuje čovek, ne kod**.

`R_Vrste dokumenata.NumeracijaOd` (0 svuda) koristi se u jednom jedinom upitu —
`BrojSVIHDokumenataPoVrstama.sql` — kao pomerač startne vrednosti brojača.

---

## 3. Knjiženje izlaznih faktura — stvarna konta

### 3.1 Kontni plan (izvod iz `Kontni plan`)

| Konto | Naziv (doslovno iz `Kontni plan.Opis`) |
|---|---|
| `2040` | Kupci u zemlji |
| `2050` | Kupci u inostranstvu |
| `4300` | **Primljeni avansi, depoziti i kaucije** |
| `4301` | Primljeni avansi od ostalih povezanih pravnih lica |
| `4302` | **Primljeni avansi od pravnih lica inostranstvo** |
| `4306` | **PRIMLJENI AVANSI - OSLOBOĐENI PDV - član 24 stav 1 tačka 16v** |
| `4700` | PDV po izdatim fakturama 20% |
| `4701` | **PDV 20% na Prodate proizvode na domaćem tržištu** |
| `4702` | **PDV 20% na Prodate robe na domaćem tržištu** |
| `4703` | **Obaveze za PDV - USLUGE 20%** |
| `4704` / `4705` | PDV 20% interni račun licence / građevina (bez osnovice) |
| `4710` | PDV po izdatim fakturama 10% |
| **`4720`** | **PDV po primljenim avansima 20%** |
| **`47200`** | **PDV po primljenim avansima 20% POKRIVANJE AVANSA** |
| **`47250`** | PDV 20% - INTERNI RAČUN Avansi GRAĐEVINARSTVO - bez osnovice |
| **`4721`** | **PDV po vraćenim avansima 20% POPDV 3.6** |
| **`4729`** | **PDV po primljenim avansima zatvaranje u istom periodu** |
| **`4730`** | **PDV po primljenim avansima 10%** |
| `4740` / `4750` | PDV po osnovu sopstvene potrošnje 20% / 8% |
| `4760` / `4761` | PDV 20% / 10% po osnovu prodaje za gotovinu |
| `4790` | Obaveze za PDV 840-714112843-10 |
| `6040` | Prihodi od prodaje robe na veliko u zemlji |
| `6050` | Prihodi od prodaje robe na inostranom tržištu |
| `6140` | Prihodi od prodaje usluga na domaćem tržištu |
| `6141` | Prihodi od prodaje proizvoda na domaćem tržištu |
| `6150` | Prihodi od prodaje proizvoda na inostranom tržištu |
| `6151` | Prihodi od prodaje usluga na inostranom tržištu |

### 3.2 Kako se biraju konta — po VRSTI DOKUMENTA, preko šeme

Lanac: `R_Vrste dokumenata.[Sema za kontiranje]` → `Sema za kontiranje.IDSeme` →
`Stavke seme za kontiranje` (`Konto`, `DefDug`, `DefPot`).

**Nije po artiklu, nije po komitentu.** Analitika se dodeljuje odvojeno
(`Stavke seme za kontiranje.Analitika = 1` → šifra komitenta na kupčevo/dobavljačevo konto).

Simboli u `DefDug`/`DefPot` (izvedeno iz uparivanja sa stvarnim iznosima):
`O` = osnovica, `P` = PDV po opštoj stopi (20%), `Q` = PDV po posebnoj stopi (10%),
`A` = nabavna vrednost (zaliha), `D`/`E` = ulazni PDV 20%/10%.

### 3.3 Šeme + PROVERA nad stvarnim knjiženjima 2025

Provera: agregacija `T_Glavna knjiga` po (`vrsta dokumenta`, `Konto`) preko
`IDDokIzRobnog` → `T_Robna dokumenta.IDDok`.

**`IFR` — račun-otpremnica robe (šema 33)** — šema i stvarnost se **poklapaju u dlaku**:

| Konto | Šema | Stvarno 2025 (352 naloga) |
|---|---|---|
| `2040` | DUG `O+P+Q` | DUG 23.115.957,98 (352 stavke) |
| `4702` | POT `P` | POT 3.852.659,73 (352) |
| `4710` | POT `Q` | 0 (nema 10% prometa) |
| `6040` | POT `O` | POT 19.263.298,25 (352) |
| `1320` | POT `A` | POT 12.118.019,75 (352) |
| `5010` | DUG `A` | DUG 12.118.019,75 (352) |

**`IFGP` — gotovi proizvodi (šema 36)** — poklapa se:

| Konto | Šema | Stvarno 2025 (24 naloga) |
|---|---|---|
| `2040` | DUG `O+P` | DUG 654.045.021,88 |
| `4701` | POT `P` | POT 109.007.503,64 |
| `6141` | POT `O` | POT 545.037.518,24 |
| `9600` / `9800` | POT `A` / DUG `A` | 304.762.620,01 (klasa 9 — obračun troškova) |

**`IZVGP` — izvoz gotovih proizvoda (šema 47)** — poklapa se, bez PDV-a:
`2050` DUG 111.552.544,00 / `6150` POT 111.552.544,00 / `9800`–`9600` 48.877.726,85.

**`IZVRO` — izvoz robe (šema 24):** `2050` DUG `O` / `6050` POT `O` / `1320` POT `A` /
`5013` DUG `A`. U 2025. nije korišćena (0 dokumenata).

**`IFUSL` — usluge (šema 30 je ZASTARELA!)** — šema kaže `2020` / `4700` / `4710` / `6121`,
a **stvarno knjiženje je `2040` / `4703` / `6140`**. Konkretan primer, faktura `476/25`
(nalog 6874, vrsta naloga `IFUSL`, 13.08.2025):

```
2040  (komitent 11688)  DUG  1.406.068,80
4703                    POT    234.344,80     ← PDV 20% na USLUGE, ne 4700/4702!
6140                    POT  1.171.724,00
```
Agregat 2025: `4703` POT 15.055.261,63 (86 stavki), `6140` POT 75.403.030,19 (87 stavki).
Konta `4700` (4 stavke) i `6121` (0 stavki) su praktično mrtva.

**`IZVUS` — izvoz usluga:** `2050` DUG 278.018,40 / `6151` POT 278.018,40, bez PDV-a.
Nema šemu — knjiži se ručno.

**`KNO` — knjižno odobrenje (šema 31):** `2020` DUG `-O-P-Q`, `470` POT `-P`, `471` POT `-Q`,
`6120` POT `-O`. Konta `470`/`471` su **trocifrena (sintetika) → šema je pokvarena**; u 2025.
i 2026. nema nijednog KNO dokumenta, pa se ne može proveriti nad podacima.

**`KNZ` — knjižno zaduženje (šema 28):** jedna jedina stavka `20200` DUG `0+P+Q`
(vodeća nula umesto slova `O`) → **šema je nepotpuna/pokvarena**, nema podataka.

### 3.4 Mapiranje konto → poresko polje

`PDV_SemeKontaZaKnjizenje` (20 redova) — izlazna strana:

| Konto | `PDVEvidencija` | `PDVStopa` | `PDVGrupa` |
|---|---|---|---|
| `4700` | `IF-OPSTA` | 20 | VISA |
| `4701` | `IFINT-OPST` | 20 | VISA |
| `4702` | `IFINT-OPST` | 20 | VISA |
| **`4720`** | **`IFAV-OPSTA`** | **20** | **VISA** |
| **`4730`** | **`IFAV-POSEB`** | **10** | **NIZA** |
| `4710` | `IF-POSEBNA` | 10 | NIZA |
| `4760` / `4761` | `IF-OPSTA` / `IF-POSEBNA` | 20 / 10 | VISA / NIZA |
| `2050` | `IZVOZ` | 0 | BEZPDV |

`PDV_Knjige`: `IFAV-OPSTA` = „IF-Primlj.avansi po OPŠTOJ stopi", `AOPOsnovica = '-'`,
**`AOPIznosPDV = '103'`** — tj. u PPPDV ide **samo iznos PDV-a, bez osnovice**.
`IFAV-POSEB` → AOP 104.

`POPDV_SemeKontaZaKnjizenje` + `APL.MDB.POPDV_DEF_APL`:

| Konto | POPDV polje | Naziv polja (doslovno iz `POPDV_DEF_APL.Opis`) |
|---|---|---|
| `4700`,`4701`,`4702`,`4703` | **3.2** | „Промет за који је порески дужник обвезник ПДВ који врши тај промет, осим из тачке 3.1" |
| **`4720`** | **3.9** | **„Накнада или део накнаде који је наплаћен пре извршеног промета и ПДВ обрачунат по том основу (аванс)"** |
| **`47200`** | **3.2** | isto polje kao redovan promet, ali sa NEGATIVNIM iznosom |
| **`4721`** | **3.6** | „Смањење основице, односно ПДВ" |
| `4710`,`4730` | 3.9 | (kolone K3/K4 — posebna stopa) |
| `47250` *(samo 2026)* | 3а.8 | „ПДВ по основу накнаде... плаћен пре извршеног промета (аванс)" — interni obračun građevinarstvo |

**Izmena između 2025. i 2026. godine** (`POPDV_SemeKontaZaKnjizenje` u `BB_T_25.MDB` vs `BB_T_26.mdb`):
```
2025:  4720 | 3.9 |        | P |   |      ← samo IZNOS PDV-a
2026:  4720 | 3.9 | P/0.2  | P |   |      ← DODATA i OSNOVICA (K1Def = potražni promet / 0,20)
2026:  +47250 | 3а.8 | P |  |   |         ← novo konto
```
Tj. **od 2026. BigBit u POPDV polje 3.9 prijavljuje i osnovicu avansa**, ne samo PDV.
Konto `4729` („zatvaranje u istom periodu") **nije mapiran ni u jednoj godini** — nekorišćen.

> **Zašto AVR nikad ne bi ušao ni u `T_PDV_IF` da se ta tabela koristi:** upiti koji je pune
> (`queries_full/OnLine_BigBit_APL/PDV_UknjiziIzRobnog_IF.sql:6`,
> `PDV_UknjiziIzUSLUGA_IF.sql:6`) imaju uslov
> `WHERE ([R_Vrste dokumenata].KnjizitiUPDVEvidenciju) = True`, a `AVR` ima `False`.
> Avansni PDV **ulazi isključivo preko konta `4720` u GK** → `T_PDV_GK` → PPPDV/POPDV.

> **Napomena o mapiranju `47200`:** `PDV_SemeKontaZaKnjizenje` **nema red za `47200`**, a
> `T_PDV_GK` ipak klasifikuje stavke sa tog konta kao `IFAV-OPSTA` (npr. `T_PDV_GK.ID=9118`
> → `StavkaID=113438` koji je stavka na kontu `47200`, iznos −2.440,00). Zaključak:
> uparivanje je **po prefiksu konta** (`47200` → `4720`). U POPDV mapiranju `47200` ima
> **eksplicitan** red. To je jedina razlika između dva registra.

---

## 4. AVANSNI RAČUNI — pun tok

### 4.1 Iz čega nastaje

`T_Usluge dokumenta` gde `Vrsta dokumenta='AVR'`, `Vrsta naloga='AVANS'`, `Level=0`.
`T_Usluge stavke` — **tačno jedna stavka**, `Kolicina=1`, `Tarifa usluga='3'` (=20%,
`R_Tarife`: tarifa 3 → „Roba i usluge 20%", grupa VISA), `Cena = OSNOVICA (neto)`.

`Opis` stavke (svih 21 iz 2025) pokazuje izvor:

```
AVR-00014/2025  „Uplata 100% avansa po ponudi 0284-25/1 El.mag.razvodnik, HF0…"
AVR-00003/2025  „Uplata 100% avansa po ponudi 0052-25/1, 3 kom El.mag.razvodn…"
AVR0005-25      „uplata 100% avansa po ponudi 0859-24/1/1"
AVR-00001/2025  „Avansna uplata 30% avansa po Ugovoru o kupoprodaji mašina i o…"   ← UGOVOR, ne ponuda
AVR-00017/2025  „Uplata 30% II dela ugovorenog avansa po Ugovoru o kupoprodaj…"   ← UGOVOR, ne ponuda
2026:           „po profakturi 0011-26 kurs 117.4013"                              ← PROFAKTURA + kurs
```
Dakle izvor je **ponuda, profaktura ILI ugovor** — nije obavezno predračun.
`IDPredmet` je popunjen u ~⅓ slučajeva 2025. i u većini 2026. (10254, 10255, 10293…).

**Veza AVR ↔ izvorni dokument je SLOBODAN TEKST u opisu, ne FK.** Nema kolone tipa
`IDDokPredracun` na `T_Usluge dokumenta` za AVR.

### 4.2 Kada nastaje PDV obaveza — **NAPLATOM**

Ovo je nedvosmisleno dokazano vrstom naloga u kome stavka nastaje.

Svih 21 „nastanaka" avansa u 2025. proknjiženo je u nalogu vrste **`IZVOD` / `IZV-E`**
(izvod banke) — nijedan u nalogu vezanom za AVR dokument:

```
NASTANAK AVANSA (T_Nalozi.Vrsta naloga LIKE 'IZV%'), 2025:
  2025-01-03  AR-00001/2025    kom 1003239  bruto 535.789.358,64  pdv 89.298.226,44  IZV-E
  2025-01-14  AVR-00002/2025   kom   11745  bruto      47.899,50  pdv      7.983,25  IZVOD
  2025-01-27  AVR-00003/2025   kom 1005618  bruto      48.645,00  pdv      8.107,50  IZVOD
  2025-02-04  AVR-00004/2025   kom 1000310  bruto      93.346,50  pdv     15.557,75  IZVOD
  …
  2025-07-01  AVR-00017/2025   kom 1003239  bruto 535.922.487,65  pdv 89.320.414,61  IZVOD
  2025-08-15  AVR-00021/2025   kom 1004715  bruto      84.429,00  pdv     14.071,50  IZVOD
```

Opisi stavki nose **poziv na broj sa izvoda**:
`„AVANS PO PRN [87000130287328]"`, `„UPLATA PREDRACUNA PN-0859-24/1/1 [0…]"`,
`„UPLATA PO PREDRAČUNU-AVANS 50%"`, `„PONUDA BR. PN-0063-25/1/1 [87000135…]"`.

**Datum AVR dokumenta = datum izvoda.** Provereno za svih 21: npr.
`T_Usluge dokumenta.IDDok=7647`, `AVR-00013/2025`, `Datum dokumenta = 2025-05-23`;
GK stavka 119160 u nalogu 6273 (`IZVOD`, 23.05.2025).

→ **BigBit izdaje avansni račun na dan kad novac legne i tog dana priznaje PDV.**

### 4.3 Knjiženje nastanka avansa — konkretan nalog

Nalog **6273**, vrsta `IZVOD`, 23.05.2025 (`AVR-00013/2025`, komitent 1000947):

```
5530                        DUG      1.150,00                  (troškovi platnog prometa)
5530                        DUG      1.300,00
4390  an=1004117            DUG     57.324,05                  (platne kartice)
4300  an=1000947  AVR-00013/2025   DUG 6.317,00   POT 37.902,00   ← avans
2410  „Izvod br."           DUG     37.902,00   POT 59.774,05    ← novac
4720  an=1000947  AVR-00013/2025   DUG     0,00   POT  6.317,00   ← PDV po avansu
```

Izolovan avansni deo:

```
2410 banka                     DUG  37.902,00      ← novac na računu
4300 (kupac)                   POT  37.902,00      ← obaveza po primljenom avansu, BRUTO
4300 (kupac)                   DUG   6.317,00  ┐   ← izdvajanje PDV-a iz avansa
4720 (kupac)                   POT   6.317,00  ┘
------------------------------------------------
neto efekat: 4300 POT 31.585,00 (osnovica) + 4720 POT 6.317,00 (PDV)
```

Ovo je **tačno oblik šeme kontiranja `IDSeme = 39` („AVANSNI RACUN", `Vrsta naloga='AVR'`)**:

```
Stavke seme za kontiranje, IDSeme=39:
  171 | 4300 | DefDug="0"  DefPot="O+P"    ← 4300 POT bruto
  172 | 4720 | DefDug="0"  DefPot="P"      ← 4720 POT PDV
  173 | 4300 | DefDug="P"  DefPot="0"      ← 4300 DUG PDV
```

> **Ali šema 39 NIJE povezana ni sa jednom vrstom dokumenta**
> (`R_Vrste dokumenata` gde `Vrsta dokumenta='AVR'` ima `Sema za kontiranje = 0`,
> `Knjiziti sintetiku = 0`, `Knjiziti analitiku = 0`).
> Dokazi da je knjiženje **RUČNO** (knjigovođa prati šemu kao predložak):
> * GK stavke avansa imaju `IDDokIzUsluga = 0` i `IDDokIzRobnog = 0` (nema veze na dokument),
>   dok `IFR` ima `IDDokIzRobnog` popunjen u svih 1.760 stavki (352 naloga × 5 linija);
> * broj dokumenta u GK je neujednačen (`AR-00001/2025` vs `AVR-00002/2025` vs
>   `AR-AVR0005-25`) — mašina to ne bi radila;
> * stavke sede unutar izvoda, izmešane sa nevezanim linijama;
> * knjiženje ide `INNER JOIN`-om `R_Vrste dokumenata.[Sema za kontiranje] = Sema.IDSeme`
>   (`queries_full/BigBit_APL_2010/NSK_SemaZaDok.sql:3`) — sa vrednošću 0 join **ne vraća ništa**;
> * i **odbitak avansa na konačnoj fakturi** je isto ručan: motor šema ima promenljive
>   `X = AvansUkupno`, `Y = AvansPDVVisa`, `Z = AvansPDVNiza`
>   (`Izvoz/VBA/SemaZaKontiranje.bas:24,32-43` + `SK_KorisceniAvansiRoba.sql`), ali
>   **nijedan od 105 redova** `Stavke seme za kontiranje` ne koristi X/Y/Z.

**Avans bez PDV-a postoji:** `AVR-00008/2025`, 26.03.2025, komitent 11688 — GK stavka 111381
`4300` POT 912.720,00, DUG 0,00, **bez `4720` linije**. (Konta `4302` „Primljeni avansi od
pravnih lica inostranstvo" — 6 stavki, 100.664.686,71 — i `4306` „Primljeni avansi
oslobođeni PDV čl. 24/1/16v" postoje za te slučajeve.)

### 4.4 Zatvaranje avansa na konačnom računu

Zatvaranje ide u **zasebnom nalogu vrste `AVANS`** („Avansni račun", `Vrsta naloga`),
datiranom danom konačne fakture. Agregat svih `AVANS` naloga 2025:

```
Konto     n    Duguje              Potražuje
2040     32           0,00       499.169.743,63
4300     37  -83.194.957,24      -499.169.743,63
47200    36           0,00        -83.188.911,49
4720      1           0,00            -6.045,75   ← 1 izuzetak, knjižen na 4720 umesto 47200
1530/4360/6630  (1 nalog — kursna razlika po DATOM avansu dobavljaču, drugi smer)
```

**Kompletan primer — faktura `045/25/1`, komitent 11745:**

Konačni račun (nalog **5491**, vrsta `IFR`, 28.01.2025) — **pun bruto, ništa umanjeno**:
```
2040  an=11745   DUG 47.899,50
4702  an=11745   POT  7.983,25     (PDV 20% u celosti)
6040  an=11745   POT 39.916,25     (prihod u celosti)
1320  an=11745   POT 15.963,05
5010  an=11745   DUG 15.963,05
```
Odbijanje avansa (nalog **5430**, vrsta **`AVANS`**, isti datum, isti broj dokumenta):
```
4300  an=11745   DUG  -7.983,25   POT -47.899,50   ← negativna kopija naloga nastanka
47200 an=11745   DUG       0,00   POT  -7.983,25   ← storno PDV-a, na POKRIVANJE konto
2040  an=11745   DUG       0,00   POT  47.899,50   ← zatvara potraživanje od kupca
```
Provera balansa: DUG (7.983,25 + 39.916,25 kroz negativne POT) = POT 47.899,50 ✔
Saldo kupca posle oba naloga = 0. PDV neto = 7.983,25 (4702) + 6.317… −7.983,25 (47200) —
tj. avansni PDV se poništava, ostaje PDV konačnog računa.

### 4.5 Delimično korišćenje i više avansa — TABELA VEZE

`T_AVR_Roba` (za `T_Robna dokumenta`) i `T_AVR_Usluge` (za `T_Usluge dokumenta`), identična šema:

```
ID, IDDok (FK na konačni dokument), BrojDokAVR (TEXT 20 — broj avansnog računa, SLOBODAN TEKST),
DatumDokAVR, UkIznosSaPDVAVR, UkPDVVisaAVR, UkPDVNizaAVR,
KoristiIznosSaPDV, KoristiPDVVisa, KoristiPDVNiza, ID_PO
```

**Ovo je CHILD tabela po `IDDok`** → **jedna faktura može imati N avansa**, i pošto
`BrojDokAVR` nije jedinstven, **jedan avans može ići na N faktura**. Oboje potvrđeno podacima:

**(a) Jedan avans → dve fakture** (`AVR-00013/2025`, bruto 37.902,00):
```
T_AVR_Roba: BrojDokAVR=AVR-00013/2025  Koristi=20.802,00 → IFR 353/25 (18.06.2025)
            BrojDokAVR=AVR-00013/2025  Koristi=17.100,00 → IFR 370/25 (25.06.2025)
                                       -----------------
                                       37.902,00  = ceo avans ✔
GK nalog 6446 (AVANS, 18.06): 4300 DUG -3.467,00 POT -20.802,00 | 47200 POT -3.467,00 | 2040 POT 20.802,00 (dok. 353/25)
GK nalog 6495 (AVANS, 25.06): 4300 DUG -2.850,00 POT -17.100,00 | 47200 POT -2.850,00 | 2040 POT 17.100,00 (dok. 370/25)
```

**(b) Više avansa → jedna faktura** (`IFGP 144/25`, 19.03.2025, komitent 12187 — TRI avansa):
```
11/23   17.166.055,50
16/23   62.447.889,31
020/24  79.507.693,98
```
i **`IFUSL 059/25`** (03.02.2025, komitent 1003925 — **ŠEST** avansnih računa,
`T_AVR_Usluge.IDDok = 7569`): `03/24`, `04/24`, `11/24`, `14/24` po 500.000,00,
`029/24` 312.500,00, `AVR-00001/2024` 500.000,00 → **ukupno 2.812.500,00**, što se poklapa
sa GK nalogom 5458 (`AVANS`, 03.02.2025).

> **⚠️ UPOZORENJE ZA BUDUĆI UVOZNIK (dopisano 02.08.2026)** — `IFUSL 059/25` je slučaj na
> kome naivan uvoz tiho slaže dokument.
>
> U 4.0 je veza avans↔račun **spojna tabela `invoice_advance_applications`** (jedan red =
> jedan avans sa SVOJIM iznosom). Kolone `invoices.advance_invoice_id` +
> `advance_applied_amount` su samo denormalizacija: pokazivač na PRVI avans i UKUPNO
> odbijeno. Pravilo koje ceo sistem čita
> (`backend/src/modules/sales/advance-deduction.ts`) vezu-u-koloni-BEZ-reda tretira kao
> **punopravan odbitak**, a njen iznos izvodi kao `kolona − Σ primena tog računa`.
>
> Ako uvoznik za ovaj račun upiše samo kolone — `advance_invoice_id` = prvi AVR (`03/24`,
> 500.000) i `advance_applied_amount` = 2.812.500 — pravilo će **celih 2.812.500 pripisati
> avansu `03/24`**: na štampi („Umanjenje za primljeni avans br. 03/24"), na e-fakturi
> (`PrepaidAmount` uz jedan jedini `cac:BillingReference`) i u iskorišćenosti avansa. Pet
> avansa nestane sa dokumenta, šesti se prekorači 5,6 puta, i to niko ne prijavi:
> `applyAdvance` kontroliše samo primene koje sam upisuje.
>
> **Pravilo uvoza:** svaki red `T_AVR_Roba` / `T_AVR_Usluge` → jedan red
> `invoice_advance_applications` (`applied_amount = KoristiIznosSaPDV`, `advance_invoice_id`
> = uvezeni AVR po `BrojDokAVR`). Kolone se popunjavaju **iz** tih redova
> (`advance_invoice_id` = prvi po datumu, `advance_applied_amount` = zbir svih). Kolone bez
> redova ostaviti samo tamo gde avansni račun kao dokument u 4.0 NE postoji — uz svest da
> tada ceo iznos visi o jednom pokazivaču, i uz proveru da `Σ odbitaka ≤ bruto računa`
> (BigBit tu proveru nema — v. defekt 1 niže).

**(c) Delimično korišćenje** (`KoristiIznosSaPDV < UkIznosSaPDVAVR`):
```
T_AVR_Usluge ID=7:  AVR 43/23  Uk=36.457.095,55  Koristi=19.772.331,75  → IDDok 7338
T_AVR_Usluge ID=8:  58/23      Uk=93.516.458,34  Koristi=59.350.371,26  → IDDok 7388
```

**(d) Avansi žive preko granice godine** — `031/24` (13.06.2024) primenjen na 7 dokumenata
u bazi 2026 (IDDok 43081, 43118, 43409, 43486, 43556, 43568, 43594, 43595), a
`16/23` (03.03.2023) primenjen na `IFGP 144/25` u martu 2025.

**VBA potvrda semantike (SUM, ne jedan avans):**
```vb
' _legacy/QBigTehn_APL/modules/IF_Modul.bas:78
IznosAvansa = Nz(ADO_Lookup(CNN_CurrentDataBase, "UkIznos",
    "SELECT SUM(KoristiIznosSaPDV) as UkIznos FROM T_AVR_Roba WHERE IDDok = " & stR(pIDDok)), 0)
F_IF_ImaAvans = (IznosAvansa >= 0.01)
```
```vb
' _legacy/QBigTehn_APL/modules/USLF_Module.bas:35 — isto nad T_AVR_Usluge
```
Ta funkcija se koristi da se na **štampi fakture** prikaže blok sa odbitkom avansa.

#### Kako operater bira avans (UI) — i gde je BigBit slab

Podforme `AVR_Roba` / `AVR_Usluge` na fakturi
(`_extracted/OnLine_BigBit_VBA/Doc__Form_AVR_Roba.txt`, `Doc__Form_AVR_Usluge.txt`):

```vba
' Doc__Form_AVR_Usluge.txt:25-37 — USLUGE: predlaže PREOSTALI (neiskorišćeni) iznos
Me!KoristiIznosSaPDV = CCur(Me!ComboIzabranAvans.Column(4)) - CCur(Nz(Me!ComboIzabranAvans.Column(7), 0))
Me!KoristiPDVVisa   = CCur(Me!ComboIzabranAvans.Column(5)) - CCur(Nz(Me!ComboIzabranAvans.Column(8), 0))
Me!KoristiPDVNiza   = CCur(Me!ComboIzabranAvans.Column(6)) - CCur(Nz(Me!ComboIzabranAvans.Column(9), 0))
```
```vba
' Doc__Form_AVR_Roba.txt:30-40 — ROBA: predlaže PUN iznos avansa (bez oduzimanja iskorišćenog)
Me!KoristiIznosSaPDV = Me!ComboIzabranAvans.Column(4)
```
Kolone 7/8/9 dolaze iz `queries_full/BigBit_APL_2010/USLUGAComboAVR_USLUGA_IskoriscenPDV.sql`
(`SUM(KoristiIznosSaPDV) GROUP BY BrojDokAVR`). **Ekvivalent za robu postoji ali je mrtav** —
zove se `USLUGAComboAVR_IskoriscenPDV_XXX.sql` (sufiks `_XXX` = isključen).

**Tri stvarna defekta BigBit-a koje NE treba preslikavati:**
1. **Nema nijedne provere `SUM(KoristiIznosSaPDV) ≤ UkIznosSaPDVAVR`** — ni constraint, ni VBA.
   Avans se može prekoračiti.
2. **Za robu se uvek predlaže pun iznos avansa** (nema računa preostatka) → dupli odbitak
   je jedan klik daleko.
3. `KoristiIznosSaPDV_AfterUpdate` (obe podforme) preračunava **samo `KoristiPDVVisa`**,
   nikad `KoristiPDVNiza` → ručni parcijalni unos po nižoj stopi ostaje pogrešan.

**Izvor liste avansa se razlikuje po tipu fakture:**
* usluge → `USLUGAComboAVR_USLUGA.sql`: `HAVING [Vrsta dokumenta] Like "AV*"` (pravi AVR dokumenti);
* roba → `ROBAComboAVR.sql`: `WHERE [Level] = 250` (**profakture**, ne AVR dokumenti).

#### „Iznos za uplatu" na štampi — potvrda naše formule

Novi izveštaj `FakturaSaNovimAvansima` (`_extracted/OnLine_BigBit_Design/`):
```
FakturaSaNovimAvansima.txt:1573   Text315.ControlSource = "=[IznosRacuna]-[PDV_Avansi].[Report]![UkupnoPlacenoAvans]"
PDV_Avansi.txt:529-531            UkupnoPlacenoAvans.ControlSource = "=Sum([KoristiIznosSaPDV])"
PDV_Avansi.txt:19                 RecordSource = "SELECT T_AVR_Roba.* FROM T_AVR_Roba ORDER BY DatumDokAVR, ID"
```
→ **`Za uplatu = bruto računa − Σ KoristiIznosSaPDV`** — identično našem
`computePayableAmount()` (`grossTotal − advanceAppliedAmount`). ✔

(Stariji izveštaj `FakturaSaAvansnima` je radio odbitak **po stopama** iz profakture:
`PDV_RazlikaZaUplatu` = `[IF Porez po dokumentima]![Roba osnovica] − PDV_AvansniRacun![Roba osnovica]`
i isto za porez. Napušten u korist prostog bruto odbitka.)

**Delimična NAPLATA jednog avansnog računa — NE POSTOJI.** U BigBit-u je
**jedna uplata = jedan avansni račun**; „avans u ratama" se vodi kao više AVR dokumenata
(primer (b) `059/25` — 6 rata = 6 avansnih računa). Nijedan `BrojDokAVR` nije se pojavio
dva puta na strani nastanka (`4300` POT u `IZVOD` nalozima).

### 4.6 Mesečni PDV obračun

Nalog vrste **`PDV`** (npr. 5554, 31.01.2025) zatvara sva PDV konta na `4790`:

```
4701  DUG    290.877,26
4702  DUG    430.806,81
4703  DUG    552.591,82
4705  DUG    220.000,00
4720  DUG 89.314.317,19      ← PDV po avansima ULAZI u mesečnu obavezu
47200 DUG   -159.897,27      ← pokrivanje avansa umanjuje obavezu
2700  POT  4.532.417,40      (prethodni porez)
…
4790  POT 79.877.565,74      ← Obaveze za PDV
5799  DUG          1,56      (zaokruženje)
```

→ **PDV po avansu se plaća u mesecu NAPLATE**, a poništava se u mesecu konačnog računa.

### 4.7 Avans na SEF-u (e-faktura / UBL)

BigBit **jeste** predvideo avansni račun za SEF.
`_extracted/OnLine_BigBit_VBA/Module__ER_Module.txt:121-129`:
```vba
    If ER_KnjiznoOdobrenjeOBA(0, VrstaDokumenta) Then
        stRetVal = "381"          ' knjižno odobrenje
    ElseIf ER_KnjiznoZaduzenje(0, VrstaDokumenta) Then
        stRetVal = "383"          ' knjižno zaduženje
    ElseIf ER_Avans(0, VrstaDokumenta) Then
        stRetVal = "386"          ' AVANSNI RAČUN (UBL InvoiceTypeCode)
    Else
        stRetVal = "380"          ' redovna faktura
    End If
```
Prepoznavanje vrste (`ER_Module.txt:1126-1160`): `"AV*"`, `"AVANS"`, `"AVRN"`, `"AVRAC"`, `"AVR"`.

Odbitak avansa na konačnoj fakturi ide u UBL kao **`PrepaidAmountTotal`**
(`ER_Module.txt:919-942` + `queries_full/OnLine_BigBit_APL/EDI_ER_AVR_Roba_Total.sql:2`):
```sql
SELECT tmp_ER_T_AVR.IDDok,
       Sum(Nz([KoristiIznosSaPDV],0)) AS PrepaidAmountTotal,
       First(BrojDokAVR) AS BrojDokAVR, Min(DatumDokAVR) AS DatumDokAVR,
       Sum(Nz([KoristiPDVVisa],0)+Nz([KoristiPDVNiza],0)) AS TaxAmount
FROM tmp_ER_T_AVR GROUP BY tmp_ER_T_AVR.IDDok;
```
Osnovica se u UBL-u **rekonstruiše iz PDV-a** (`EDI_ER_AVR_Roba_Visa.sql:2`):
`TaxableAmount = KoristiPDVVisa / (stopa/100)`, a ostatak ide kao oslobođeni deo sa
`ID_PO` (`EDI_ER_AVR_Roba_BezPDV.sql:2`) — otud kolona `ID_PO` u `T_AVR_*`.

**Ali `BillingReference` na avans je NAMERNO isključen** (`ER_Module.txt:956-962`):
```vba
    retValOk = retValOk Or ER_KnjiznoOdobrenjeZaDok(pIDDok, stVrstaDok)
    retValOk = retValOk Or ER_KnjiznoZaduzenje(pIDDok, stVrstaDok)
    '04-02-2023 hoćemo da dodamo kad mi hoćemo  retValOk = retValOk Or UBL_DokSadrziAvans(pIDDok)
```
U kombinaciji sa ručnom beleškom „NE ŠALJE SE NA SEF" na `T_Usluge dokumenta` `028/24`,
zaključak: **mehanizam postoji, ali se u Servotehu ne koristi konzistentno.**

### 4.8 Vraćeni avans

Konto **`4721` „PDV po vraćenim avansima 20% POPDV 3.6"** postoji u kontnom planu i mapiran je
na POPDV polje 3.6 („Смањење основице, односно ПДВ"). U 2025. **nije korišćen** (0 stavki u GK) →
tok povraćaja avansa bez isporuke je **predviđen ali nedokumentovan podacima**.

---

## 5. Brojevi iz stvarnih podataka (2025)

### 5.1 Izlazni dokumenti

| Vrsta | Kom. | Kupac (DUG) | Prihod (POT) | Izlazni PDV (POT) |
|---|---:|---:|---:|---:|
| `IFR` (roba) | 352 | `2040` 23.115.957,98 | `6040` 19.263.298,25 | `4702` 3.852.659,73 |
| `IFGP` (gotovi proizvodi) | 25 | `2040` 654.045.021,88 | `6141` 545.037.518,24 | `4701` 109.007.503,64 |
| `IFUSL` (usluge) | 101 | `2040` | `6140` 75.403.030,19 | `4703` 15.055.261,63 |
| `IZVGP` (izvoz GP) | 2 | `2050` 111.552.544,00 | `6150` 111.552.544,00 | — |
| `IZVUS` (izvoz usluga) | 3 | `2050` 278.018,40 | `6151` 278.018,40 | — |
| `IZVRO`, `KNO`, `KNZ`, `VPBP`, `VPTR` | 0 | — | — | — |
| **`AVR`** | **21** | — (protivstavka je banka `2410`) | — | **`4720`** |
| `PON` / `PROF` / `OTP` | 575 / 11 / 52 | (bez knjiženja) | | |

### 5.2 Konta na avansnoj strani — koliko puta se STVARNO pojavljuju u GK 2025

| Konto | Broj stavki | Duguje | Potražuje |
|---|---:|---:|---:|
| `4300` Primljeni avansi | **94** | 252.632.392,26 | 2.231.229.814,59 |
| `4302` Primljeni avansi inostranstvo | 6 | 100.664.686,71 | 100.664.685,73 |
| **`4720`** PDV po primljenim avansima 20% | **27** | 178.876.621,88 | 178.898.038,38 |
| **`47200`** POKRIVANJE AVANSA | **44** | −80.915.464,04 | −83.191.351,49 |
| `4730` PDV po primljenim avansima 10% | **0** | — | — |
| `4721` PDV po vraćenim avansima | **0** | — | — |
| `4790` Obaveze za PDV | 9 | 165.281.356,74 | 165.281.356,74 |

`T_PDV_GK` gde `PDVEvidencija='IFAV-OPSTA'`: **27 redova u 2025** (19 pozitivnih naplata,
2 negativna storna, 6 mesečnih nula-linija). `IFAV-POSEB`: **0 redova** — Servoteh nikada
nije imao avans po stopi 10%.

### 5.3 Pet konkretnih avansa (kompletan lanac)

| # | AVR | Datum | Komitent | Bruto | PDV (`4720`) | Osnovica | Zatvoren na |
|---|---|---|---|---:|---:|---:|---|
| 1 | `AVR-00002/2025` | 14.01.2025 | 11745 | 47.899,50 | 7.983,25 | 39.916,25 | `IFR 045/25/1` (28.01.) — pun iznos |
| 2 | `AVR-00013/2025` | 23.05.2025 | 1000947 | 37.902,00 | 6.317,00 | 31.585,00 | `IFR 353/25` (20.802) **+** `IFR 370/25` (17.100) |
| 3 | `AVR-00008/2025` | 26.03.2025 | 11688 | 912.720,00 | **0,00** | 912.720,00 | `IFR 206/25` (09.04.) — **avans BEZ PDV-a** |
| 4 | `AVR-00017/2025` | 01.07.2025 | 1003239 | 535.922.487,65 | 89.320.414,61 | 446.602.073,04 | još otvoren (30% II deo po Ugovoru) |
| 5 | 6× (`03/24`…`AVR-00001/2024`) | 01–08.2024 | 1003925 | 2.812.500,00 | 468.750,00 | 2.343.750,00 | `059/25` (03.02.2025) — **6 avansa na 1 fakturu** |

---

## 6. Provera NAŠIH pet odluka (4.0, `backend/src/modules/sales/advance-invoice.service.ts`)

### ✅ 1. PDV po avansu na `4720` (20%) / `4730` (10%), ne `4702`/`4710` — **POTVRĐENO**

Trostruki dokaz:
* `Kontni plan`: `4720` = „PDV po primljenim avansima 20%", `4730` = „PDV po primljenim avansima 10%";
* `PDV_SemeKontaZaKnjizenje`: `4720` → `IFAV-OPSTA`, `4730` → `IFAV-POSEB`
  (a `4702` → `IFINT-OPST`, `4710` → `IF-POSEBNA` — **druge evidencije**);
* `Stavke seme za kontiranje` `IDSeme=39` („AVANSNI RACUN") koristi `4300` + `4720`;
* stvarni podaci 2025: **27 stavki na `4720`**, nijedna avansna stavka na `4702`/`4710`.

**Dopuna koju smo propustili:** BigBit ima **treće konto za storno** —
`47200` „PDV po primljenim avansima 20% POKRIVANJE AVANSA" (44 stavke 2025), i
**četvrto** — `4721` „PDV po vraćenim avansima 20% POPDV 3.6". Mi storniramo DUG na `4720`.
Iznos obaveze je isti, **ali POPDV polje nije** (v. gap G3).

### ✅ 2. Obavezu priznajemo NAPLATOM, ne izdavanjem — **POTVRĐENO**

Svih 21 nastanaka avansa u 2025. je proknjiženo u nalogu vrste `IZVOD`/`IZV-E`
(`T_Nalozi.Vrsta naloga`), sa opisom koji nosi poziv na broj sa izvoda, i sa datumom
dokumenta = datum izvoda. Mesečni `PDV` nalog uključuje `4720` u obavezu **tog meseca**.
(BigBit u praksi izdaje AVR na dan naplate, pa mu se datum izdavanja i datum naplate poklapaju —
ali okidač je nedvosmisleno novac.)

### ✅ 3. Konačni račun ne menja `grossTotal`, avans umanjuje samo iznos za uplatu — **POTVRĐENO**

Primer `045/25/1`: nalog `IFR` 5491 knjiži **pun** bruto 47.899,50 na `2040`, **pun** PDV
7.983,25 na `4702`, **pun** prihod 39.916,25 na `6040`. Odbijanje avansa je **zaseban nalog**
vrste `AVANS` (5430) koji kreditira `2040` sa 47.899,50. Isti obrazac u svih 32 zatvaranja 2025.

Naše razdvajanje na `journalEntryId` (faktura) + `advanceClosingEntryId` (zatvaranje avansa)
je **identična arhitektura** kao BigBit-ova dva naloga.

### ⚠️ 4. Naplata je kumulativna (avans u ratama) — **NIJE MOGUĆE POTVRDITI iz BigBit-a**

BigBit **nema** kumulativnu naplatu jednog avansnog računa: **jedna uplata = jedan AVR
dokument**. Rate se vode kao više avansnih računa (`IFUSL 059/25` zatvara **šest** AVR-ova
od po 500.000,00 / 312.500,00). Nijedan `BrojDokAVR` se ne pojavljuje dva puta na strani
nastanka.

Naša kumulativna naplata **nije opovrgnuta** (ne krši ništa), ali **rešava drugi problem** od
onog koji BigBit ima. BigBit-ov obrazac („više avansa na jednu fakturu") naš model
**ne podržava** — to je gap G2.

### ✅ 5. Primljeni avansi na `4300` — **POTVRĐENO**

`Kontni plan`: `4300` = „Primljeni avansi, depoziti i kaucije". 94 stavke u GK 2025,
potražni promet 2,23 milijarde RSD.

**Dopuna:** BigBit razdvaja `4302` „Primljeni avansi od pravnih lica inostranstvo"
(6 stavki, 100,66 mil.) i `4306` „PRIMLJENI AVANSI - OSLOBOĐENI PDV - čl. 24 st. 1 t. 16v".
Mi gurnemo sve na `4300` uključujući izvoz. Manji gap (G6).

---

## 7. Gap-ovi 4.0 prema BigBit-u

| # | Gap | Dokaz iz BigBit-a | Šta treba promeniti |
|---|---|---|---|
| **G1** | **Jedan AVR se sme odbiti samo na JEDNOJ fakturi** (parcijalni unique `uq_invoices_advance_applied_once`) | `AVR-00013/2025` (37.902,00) odbijen na `IFR 353/25` (20.802,00) **i** `IFR 370/25` (17.100,00); `T_AVR_Usluge` ID 4/6 i 7/18 pokazuju parcijalno korišćenje (`KoristiIznosSaPDV < UkIznosSaPDVAVR`) | Skinuti unique, uvesti **iznos odbitka po primeni** + kontrolu `SUM(odbijeno) ≤ naplaćeni avans` |
| **G2** | **Jedna faktura sme imati samo JEDAN avans** (`invoice.advanceInvoiceId` je skalar) | `IFGP 144/25` ima **3** avansa; `IFUSL 059/25` ima **6**; BigBit ima child tabele `T_AVR_Roba`/`T_AVR_Usluge` po `IDDok`, a VBA radi `SUM(KoristiIznosSaPDV)` | Uvesti **spojnu tabelu** `invoice_advance_applications (invoice_id, advance_invoice_id, applied_amount, applied_vat)` umesto dve kolone na `invoices` |
| **G3** | **Nema konta `47200` (pokrivanje) ni `4721` (vraćeni avans)** — storniramo DUG na `4720` | `Kontni plan` + 44 stavke na `47200` u 2025; `POPDV_SemeKontaZaKnjizenje`: `4720`→**3.9**, `47200`→**3.2**, `4721`→**3.6** | Dodati `47200`/`4721` u kontni plan i u POPDV mapiranje; storno knjižiti na `47200` (ili svesno odstupiti i dokumentovati POPDV posledicu) |
| **G4** | **PDV linija ide bez analitike** (`analyticalCode: null`) | BigBit stavlja šifru komitenta i na `4720` i na `47200` (npr. GK 101199 `4720 an=11745`) | Preneti `customerId` i na PDV liniju avansa |
| **G5** | **AVR se sme izdati SAMO iz predračuna (`PON`/`PROF`, `level=250`)** | 2 od 21 avansa 2025. su **po Ugovoru** (`AVR-00001/2025` i `AVR-00017/2025` — ujedno **najveći**, 535,8 i 535,9 mil. RSD); 2026. i „po profakturi 0011-26 kurs 117,4013" | Dopustiti izvor **ugovor / predmet / bez izvora**, uz obavezan tekstualni opis osnova |
| **G6** | **Avans bez PDV-a moguć samo preko `isExport`** | `AVR-00008/2025` bruto 912.720,00, **PDV 0,00**, domaći komitent 11688; BigBit ima `4306` (oslobođeno čl. 24/1/16v) i `ER_SifrePoreskogOslobadjanja` (107 šifara, `ID_PO` je i kolona u `T_AVR_*`) | Dodati **razlog poreskog oslobođenja** na AVR (šifra `PO`), i konta `4302`/`4306` |
| **G7** | **Numeracija je po vrsti dokumenta** (`AVR0001/2026`, `IFR0001/2026`, `IFUSL0001/2026` paralelno) | Servoteh vodi **JEDNU godišnju seriju za sve izlazne fakture**: `001/25 … 486/25` deljeno između `IFR`/`IFGP`/`IFUSL`/`IZVGP`/`IZVUS` (483 fakture, max broj 486) | Uvesti **grupu numeracije** (`INVOICE_OUT`) tako da sve izlazne fakture dele jednu sekvencu; `AVR`, `PON/PROF` ostaju zasebne serije |
| **G8** | **Konta prihoda i izlaznog PDV-a ne razlikuju robu / proizvod / uslugu** (samo `6040`/`6140` i `4702`/`4710`) | BigBit: roba `6040`+`4702`, gotovi proizvodi `6141`+**`4701`**, usluge `6140`+**`4703`**, izvoz robe `6050`, izvoz GP `6150`, izvoz usluga `6151` | Vezati konta za **vrstu dokumenta** (šema kontiranja), ne za `isExport`/`SERVICE_TYPES` |
| **G9** | **Nema klase 9 (obračun troškova)** za gotove proizvode | `IFGP`: `9600` POT / `9800` DUG 304,7 mil.; `ULGP`: `1200`/`9020`/`9600` | Odluka za kasnije (nije PDV-relevantno) |
| **G10** | **Knjižno odobrenje / zaduženje** | Šema 31 (`KNO`) koristi trocifrena konta `470`/`471` → **pokvarena**; šema 28 (`KNZ`) ima jednu stavku sa `"0+P+Q"` → **nepotpuna**; 0 dokumenata 2025/2026 | Ne prepisivati BigBit — dizajnirati čisto (`4702`/`4710` sa negativnim iznosima ili `4721` logikom) |
| **G11** | **`grossToNet` vs. unos osnovice** | BigBit-ova AVR stavka nosi **neto osnovicu** (`T_Usluge stavke.Cena`), a bruto se izvodi. Mi primamo bruto i delimo preračunatom stopom. Rezultat isti do na cent, ali BigBit u pola slučajeva ima repetend (`36721.78333…`) jer je i tamo krenuo od bruto iznosa uplate | Nije gap — samo potvrda da je **bruto ulaz ispravan izbor** (uplata JESTE bruto) |
| **G12** | **Avansni račun se ne šalje na SEF** | BigBit ima UBL `InvoiceTypeCode = 386` za avans (`ER_Module.txt:126`) i `PrepaidAmountTotal` na konačnoj fakturi (`EDI_ER_AVR_Roba_Total.sql`) | Naš `sales/sef` modul mora imati vrstu 386 za `AVR` i `PrepaidAmountTotal` na konačnom računu |
| **G13** | **POPDV od 2026. traži i OSNOVICU avansa u polju 3.9** | `POPDV_SemeKontaZaKnjizenje` 2025: `4720 → 3.9, K2Def=P` (samo PDV); 2026: `4720 → 3.9, K1Def=P/0.2, K2Def=P` (i osnovica) | Naša POPDV/PPPDV logika mora izvestiti i osnovicu avansa, ne samo iznos PDV-a |

### Šta iz BigBit-a NE preslikavati (defekti koje smo već izbegli)

| Defekt BigBit-a | Naše 4.0 rešenje |
|---|---|
| Nema provere `SUM(KoristiIznosSaPDV) ≤ UkIznosSaPDVAVR` — avans se može prekoračiti | zadržati kontrolu iznosa; kad se uvede N:M (G1/G2), obavezno `SUM(odbijeno) ≤ naplaćeno` |
| Za robu se predlaže **pun** iznos avansa iako je već delimično iskorišćen (`ROBAComboAVR.sql` nema kolone iskorišćenosti; `USLUGAComboAVR_IskoriscenPDV_XXX.sql` je mrtav kod) | preostali iznos računati uvek, na obe strane |
| `KoristiIznosSaPDV_AfterUpdate` preračunava samo `KoristiPDVVisa`, nikad `KoristiPDVNiza` | naš `splitAdvance()` ide kroz `grossToNet` za obe stope |
| Veza avans↔faktura je **string-match po `BrojDokAVR`** (Text 20), bez FK | naš `advanceInvoiceId` je pravi FK |
| Numeracija `COUNT(*)+1` — race condition + rupe posle brisanja | `DocumentNumberSequence` + `SELECT … FOR UPDATE` |
| `MaxBrojDokPoVrstama.sql` (OnLine verzija) poredi broj kao **tekst** (`"9" > "10"`) | integer sekvenca |

---

## 8. Ono što nije bilo moguće utvrditi

* **Semantika `Prodaja sa PPP` / `Prodaja sa PPU` / `KOTP` / `KODJ` / `FR`** u
  `R_Vrste dokumenata`. `AVR` ima `Prodaja sa PPP = 1`. → **NEPOZNATO**
* **Tok povraćaja avansa** (konto `4721`, POPDV 3.6) — predviđen u kontnom planu i POPDV
  mapiranju, ali **0 knjiženja** u 2025. → **NEPOZNATO**
* **Konto `4729`** „PDV po primljenim avansima zatvaranje u istom periodu" — postoji u
  kontnom planu, **nije u POPDV mapiranju ni u jednoj godini**, 0 knjiženja. → **NEPOZNATO**
* **`T_PDV_IF`** — struktura postoji (pun KIF registar sa `VrstaDok`, `BrDok`, `PIB`,
  `VredBezPDVVisa/Niza/Nula`, `UmanjenjeBezPDV*`, `Period`, `JestePromet`) i postoje upiti
  koji je pune (`PDV_UknjiziIzRobnog_IF.sql`, `PDV_UknjiziIzUSLUGA_IF.sql`), ali je
  **prazna u sve tri baze**. Servoteh je ne koristi. → **NEPOZNATO zašto je napuštena**
* **Da li se avansni račun stvarno šalje na SEF u Servotehu.** Kod postoji i ispravan je
  (UBL 386, `PrepaidAmountTotal`), ali `ER_DokZaExport_MOD` ima samo 3 reporta
  (`Faktura-Roba`, `Faktura-Usluga`, `Faktura-Raster`) — **nema AVR reporta** — a u
  `T_Usluge dokumenta.Opis` za `028/24` stoji ručna beleška **„NE ŠALJE SE NA SEF"**.
  → **verovatno se šalje ručno kroz SEF portal; NEPOTVRĐENO**
* **`T_PDV_IF`** — struktura postoji (pun KIF registar sa `VrstaDok`, `BrDok`, `PIB`,
  `VredBezPDVVisa/Niza/Nula`, `UmanjenjeBezPDV*`, `Period`, `JestePromet`), ali je
  **prazna u sve tri baze**. Servoteh je ne koristi; da li je koriste druge BigBit
  instalacije → **NEPOZNATO**

---

## 9. Reproducibilnost — komande korišćene u ovoj analizi

```bash
# spisak tabela / šema
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-tables -1 /d/BB_T_25.MDB"
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-schema  /d/BB_T_25.MDB"

# vrste dokumenata, šeme kontiranja, PDV/POPDV mapiranja
for T in 'R_Vrste dokumenata' 'Sema za kontiranje' 'Stavke seme za kontiranje' \
         'PDV_SemeKontaZaKnjizenje' 'POPDV_SemeKontaZaKnjizenje' 'PDV_Knjige' \
         'T_AVR_Roba' 'T_AVR_Usluge' 'Kontni plan' 'Vrsta naloga'; do
  ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export /d/BB_T_25.MDB '$T'"
done

# POPDV nazivi polja (3.1–3.10, 3а.1–3а.9)
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export /d/APL.MDB 'POPDV_DEF_APL'"

# GK: -e je OBAVEZAN (Memo polja sadrže prelome reda i lome CSV bez njega)
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local \
  mdb-export -e -D '%Y-%m-%d' -T '%Y-%m-%d' /d/BB_T_25.MDB 'T_Glavna knjiga'"
```

Pomoćni parser (`/tmp/bb.py` na `ubuntusrv`) učitava bilo koju tabelu kroz Pythonov `csv`
modul — direktno `awk -F'|'` **daje pogrešne rezultate** (Memo polja).

Lokalni izvori (VBA / Access upiti / dizajn izveštaja), svi pod
`C:\Users\nenad.jarakovic\Documents\GitHub\servosync4\_legacy\`:

| Tema | Fajl |
|---|---|
| Unos odbitka avansa (UI) | `BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/Doc__Form_AVR_Roba.txt`, `Doc__Form_AVR_Usluge.txt` |
| Preostali iznos avansa | `BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/USLUGAComboAVR_USLUGA.sql`, `USLUGAComboAVR_USLUGA_IskoriscenPDV.sql`, `ROBAComboAVR.sql`, `USLUGAComboAVR_IskoriscenPDV_XXX.sql` *(mrtav)* |
| „Za uplatu" na štampi | `BigbitRaznoNenad/_extracted/OnLine_BigBit_Design/FakturaSaNovimAvansima.txt:1573`, `PDV_Avansi.txt:529` |
| SEF / UBL 386 | `BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/Module__ER_Module.txt:121,919,956,1126` |
| SEF avans upiti | `BigbitRaznoNenad/_extracted/queries_full/OnLine_BigBit_APL/EDI_ER_AVR_*.sql` |
| Numeracija | `Izvoz/VBA/DodelaPLU.bas:103,161,275,419`; `BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/Doc__Form_Izlazna faktura.txt:905`, `Doc__Form_USLUGA Faktura.txt:642` |
| Motor šeme kontiranja (A–Z promenljive) | `Izvoz/VBA/SemaZaKontiranje.bas:4,24,32-43`; `.../queries_full/BigBit_APL_2010/SKStavkeZaKnjizenjeAnalitika1Korak.sql`, `SK_KorisceniAvansiRoba.sql` |
| Punjenje `T_PDV_IF` (gate) | `.../queries_full/OnLine_BigBit_APL/PDV_UknjiziIzRobnog_IF.sql:6`, `PDV_UknjiziIzUSLUGA_IF.sql:6` |
| Detekcija „ima avans" | `Izvoz/VBA/IF_Modul.bas:69-80`, `USLF_Module.bas:26-37` |

> **Zanimljivost iz motora šema:** `VredIzraza()` (`SemaZaKontiranje.bas`) mapira slova A–Z
> pozicijski na vrednosti dokumenta; **X = AvansUkupno, Y = AvansPDVVisa, Z = AvansPDVNiza**
> (puni se iz `SK_KorisceniAvansiRoba.sql`). U celoj tabeli `Stavke seme za kontiranje`
> (105 redova) **nijedan `DefDug`/`DefPot` ne koristi X/Y/Z** → BigBit **ima** mehanizam da
> automatski knjiži odbitak avansa na konačnoj fakturi, ali ga **niko nije uključio**.
> To potvrđuje da je celo avansno knjiženje kod Servoteha ručno.

---

## 10. Sažetak

1. **Naša konta avansa (`4300`, `4720`/`4730`) su TAČNA** — BigBit ih zove doslovno tako
   (`Kontni plan`: „PDV po primljenim avansima 20%/10%"), mapira ih na `IFAV-OPSTA`/`IFAV-POSEB`
   (AOP 103/104) i POPDV polje **3.9 („аванс")**, i koristi ih na svih 27 avansnih stavki 2025.
   Ispravke: za **storno** treba `47200` („POKRIVANJE AVANSA" → POPDV **3.2**, negativno),
   za **povraćaj** `4721` (→ POPDV **3.6**), a od 2026. u 3.9 ide **i osnovica**, ne samo PDV.
2. **Priznavanje naplatom** i **nepromenjen bruto konačnog računa** su potvrđeni BigBit-ovim
   dvostrukim nalogom: `IZVOD` (banka) za nastanak, `AVANS` za zatvaranje.
   Formula „za uplatu" (`bruto − Σ iskorišćeni avans`) je identična našoj.
3. **Tri ozbiljna gap-a:** (a) naš model dozvoljava samo 1:1 vezu avans↔faktura, a BigBit
   demonstrira N:M sa parcijalnim iznosima (`AVR-00013/2025` na dve fakture; `IFUSL 059/25`
   sa šest avansa); (b) naša numeracija po vrsti dokumenta razbija Servotehovu jedinstvenu
   godišnju seriju izlaznih faktura (`001/25 … 486/25`); (c) nemamo UBL vrstu **386** ni
   `PrepaidAmountTotal` za SEF.
4. **Naš zahtev „AVR samo iz predračuna" je pretesan** — dva najveća avansa 2025.
   (po 535+ miliona RSD) izdata su **po Ugovoru**, ne po predračunu.
5. **BigBit-ovi defekti koje NE preslikavati:** nema provere prekoračenja avansa, za robu
   predlaže pun iznos i kad je avans već iskorišćen, ne preračunava PDV po nižoj stopi pri
   parcijalnom unosu, veza avans↔faktura je slobodan tekst, numeracija je `COUNT(*)+1`.

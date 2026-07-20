# 44 — BigBit ZR (Završni Račun) bilansni motor — rekonstrukcija iz VBA

**Izvor:** 7 VBA modula iz `BigBit_APL_2010.MDB` (izvezeni u `_legacy/BigBit26/`):
`ZR` (motor), `ZRXML`, `Form_ZR_UnosZaglavlja`, `Form_ZR_UnosStavki`,
`Form_ZR_AOP_Modla`, `Form_ZR_AOP_Pravila`, `Form_ZR_NezadovoljenaPravila`.
Referentni raniji dokument: doc 37 §C/§F (GKEval), doc 18 §2.2.

**Status ključnog nalaza (čitaj prvo):**
> Stvarne AOP formule **NISU u kodu** — one su **podaci** u Access tabeli
> `ZR_AOP_Modla` (kolona `Definicija`). VBA sadrži samo **evaluator** tih stringova.
> Isto važi za kontrolna pravila (tabela `ZR_AOP_Pravila`). Za verbatim seed
> potreban je CSV dump te dve tabele iz `.MDB` — vidi §7. Dok toga nema, seed
> `balance-formulas-real.sql` je **rekonstrukcija** (standardni APR AOP + kontni
> plan Servoteha), ne 1:1 kopija BigBit-a.

---

## 1. Arhitektura motora (šta radi kod, šta rade podaci)

Motor je **data-driven interpreter**. Formula za jednu AOP poziciju je tekstualni
DSL string u koloni `ZR_Stavke.Definicija` (kopira se iz `ZR_AOP_Modla.Definicija`).
Kod ne zna nijednu AOP definiciju — samo evaluira string.

**Tabele (potvrđene iz DSum poziva i lock-lista u formama):**

| Tabela | Uloga | Ključne kolone |
|---|---|---|
| `ZR_AOP_Modla` | Katalog AOP formula (šablon) | `AOP`, `Definicija`, `GrupaKonta`, `Pozicija`, `ZaKolonu`, `StartnaKolona`, `BrojKolona`, `Obrazac`, `Grupa` |
| `ZR_Stavke` | Popunjene stavke jednog ZR (`IDZR`) | `IDZR`, `AOP`, `Definicija`, `Iznos_1`, `Iznos_2`, `Iznos_3`, `ZaKolonu`, `StartnaKolona`, `BrojKolona`, `Obrazac`, `Grupa` |
| `ZR_AOP_Pravila` | Kontrolna pravila | `Uslov`, `Pravilo`, `Opis`, `Obrazac` |
| `ZR_BrutoStanje_TG` | Bruto stanje GK — tekuća godina | `Konto`, `Duguje`, `Potrazuje`, `PSDuguje`, `PSPotrazuje` |
| `PSPG_BrutoStanje_PG` | Bruto stanje GK — prethodna godina | isto |
| `ZR_Stavke_TG` | Query nad `ZR_Stavke` za tekući `IDZR` (za A-reference) | `AOP`, `Iznos_1/2/3` |

**Tri kolone iznosa (obrazac određuje značenje):**
- `Iznos_1` = tekuća godina (kolona „1" na obrascu)
- `Iznos_2` = pomoćna kolona (BS: npr. ispravka vrednosti / neto)
- `Iznos_3` = prethodna godina (PG) / početno stanje (PS)

---

## 2. DSL sintaksa — tačno kako `VrednostIzraza` radi

Ulazna tačka je `VrednostIzraza(Izraz, ClTg)`; `ClTg=True` → tekuća godina (TG),
`ClTg=False` → prethodna godina / PS (PG). Lanac poziva:

```
VrednostIzraza            → skida zagrade (najdublja prvo), rekurzivno
  VrednostIzrazaBezZagrada → logika/poređenja (NOT/AND/XOR/OR, <= >= < > =)
    ZRVrednostIzrazaTG     → aritmetika + i -
      ZRVrednostClanaIzrazaTG   (ClTg=True)  → DSum nad ZR_BrutoStanje_TG / ZR_Stavke_TG
      ZRVrednostClanaIzrazaPGPS (ClTg=False) → DSum nad PSPG_BrutoStanje_PG / ZR_Stavke_TG
```

### 2.1 Zagrade — `VrednostIzraza`
`InStrRev(Izraz,"(")` nalazi **poslednju** otvorenu zagradu, pa prvu `)` iza nje →
to je „srce" izraza, izračuna se `VrednostIzrazaBezZagrada`, zameni brojem u stringu,
i rekurzija se ponavlja dok ima zagrada. Dakle: **najdublja zagrada prvo**, korektno
ugnježđivanje.

### 2.2 Logika/poređenja — `VrednostIzrazaBezZagrada`
Redom (prvi `InStr` koji nađe operator seče string): `NOT`, `AND`, `XOR`, `OR`,
`<=`, `>=`, `<`, `>`, `=`. **Levo-vezujuće, BEZ prioriteta operatora** — čisto
tekstualno cepanje. Ako ničeg nema → `ZRVrednostIzrazaTG`. Ova grana se koristi za
**pravila** (rezultat je Boolean); u običnim bilansnim formulama je nema.

### 2.3 Aritmetika — `ZRVrednostIzrazaTG`
Samo **`+` i `-`**, levo→desno po **prvom nađenom znaku**. **Nema `*` ni `/`** u
izrazu (parser ih ne prepoznaje kao operatore). Komentar u kodu: `izraz je tipa
D202* + P433* - D021*`. `Currency` tip (fiksna decimala, ne float).

> ⚠️ Posledica „prvi nađeni znak, levo-vezujuće": `A - B + C` se parsira kao
> `A - (B + C)` NIJE — nego kao `A - VrednostIzrazaTG("B + C")` = `A - (B+C)`.
> Zbog rekurzije na **desni** ostatak, `A - B - C` = `A - (B - C)` = `A - B + C`.
> **Ovo je bug-kompatibilnost tačka** — vidi §6.3.

### 2.4 Član izraza — prefiks + maska
`ZRVrednostClanaIzrazaTG(cizraz)` čita prefiks **3→2→1 znak** ovim redom:

1. `Left(cizraz,3)` == `PSD` ili `PSP` → maska = ostatak (od 4. znaka)
2. inače `Left(cizraz,2)` == `AB` ili `AC` → maska = ostatak (od 3. znaka)
3. inače `Left(cizraz,1)` = `D`/`P`/`A` → maska = ostatak (od 2. znaka)

| Prefiks | TG izvor (`ClTg=True`) | PG izvor (`ClTg=False`) | Značenje |
|---|---|---|---|
| `D`  | `DSum([Duguje],   ZR_BrutoStanje_TG, [Konto] Like 'maska')` | `PSPG_BrutoStanje_PG` | dugovni promet |
| `P`  | `DSum([Potrazuje],ZR_BrutoStanje_TG, ...)` | `PSPG_BrutoStanje_PG` | potražni promet |
| `PSD`| `DSum([PSDuguje], ZR_BrutoStanje_TG, ...)` | `PSPG_BrutoStanje_PG` | početno stanje dugovno |
| `PSP`| `DSum([PSPotrazuje],ZR_BrutoStanje_TG, ...)` | `PSPG_BrutoStanje_PG` | početno stanje potražno |
| `A`  | `DSum([Iznos_1], ZR_Stavke_TG, [AOP] Like 'maska')` | `DSum([Iznos_3], ZR_Stavke_TG, ...)` | druga AOP pozicija, kolona 1 (TG) / kolona 3 (PG) |
| `AB` | `DSum([Iznos_2], ZR_Stavke_TG, ...)` | **zakomentarisano — nedostupno u PG** | druga AOP, kolona 2 |
| `AC` | `DSum([Iznos_3], ZR_Stavke_TG, ...)` | **zakomentarisano — nedostupno u PG** | druga AOP, kolona 3 |
| ostalo | `Eval(cizraz)` (goli broj / Access izraz) | `Eval(cizraz)` | konstanta |

**Maska:** sve iza prefiksa je Access `LIKE` maska nad `[Konto]` (D/P/PS*) ili
`[AOP]` (A*). `*` = wildcard (Access `LIKE`, `Option Compare Database` → case-insensitive).
Npr. `D202*` = Σ Duguje za sva konta koja počinju sa `202`.

**Bitna razlika A-referenci TG vs PG:** u TG grani `A<aop>` čita `Iznos_1`
(tekuća); u PG grani `A<aop>` čita `Iznos_3` (prethodna). Tj. isti string `A0002`
u BS PG koloni referiše prethodnogodišnju vrednost druge pozicije — **NE** tekuću.

**Error handling:** svaki član ima `On Error GoTo` koji na grešku vraća `0`
(`v=0: Resume exit`). Nz(v,0) → prazan DSum (nema konta) = 0.

---

## 3. Skaliranje /1000 i zaokruživanje

**U VBA NEMA `/1000`.** `ZRVrednostIzraza*` vraća pune iznose. Deljenje na hiljade
se radi u **imenovanim Access query-jima** koje forma bira preko flega
`ZaokruzenoNa1000` (`DLookup [ZaokruzenoNa1000]` iz `ZR_BrutoStanjeZaglavlje`):

- bruto stanje **već** zaokruženo na 1000 → query `..._Nezaokruzeno` (ne deli ponovo)
- bruto stanje u punim dinarima → query `..._Zaokruzeno` (deli/zaokružuje u SQL-u)

Pri **XML eksportu** (`ZR.ZR_EksportXML_*`) primenjuje se `Round(Nz(Iznos,0),0)` —
celobrojno zaokruženje. `Din()` u `ProzorUSvet` je samo formatiranje prikaza, ne
skaliranje.

**AOP-iz-AOP query (potvrđeno, verbatim):**
```sql
-- ZR_UpisiVrednostiuIzAOPUZRStavke_Iznos_1
UPDATE ZR_Stavke SET Iznos_1 =
  IIf(VrednostIzraza(Nz([Definicija],""),True) > 0, VrednostIzraza(...,True), 0)
WHERE IDZR = [Forms]![ZR_UnosZaglavlja]![IDZR]
  AND (Definicija Like "A*" OR Definicija Like "(A*")
  AND ZaKolonu = "1";
```
Dve stvari iz ovog query-ja:
1. **CLAMP na ≥0:** ako je vrednost A-formule < 0 → upisuje se **0** (negativne
   agregirane pozicije se nuluju). Ovo NE važi za bruto-stanje formule (D/P/PS) —
   samo za A-reference (`Definicija Like "A*"`).
2. **Redosled računanja:** prvo se popune D/P/PS pozicije (direktno iz bruto stanja),
   pa se A-reference reše u **7 iteracija** (`For i=1 To 7` u `Form_ZR_UnosZaglavlja`)
   radi konvergencije ugnježđenih A→A→A referenci.

Kolone: `Iznos_1` → `ZaKolonu="1"`, `Iznos_2` → `ZaKolonu="2"`, `Iznos_3` →
filter `Obrazac Like "bs"` (PG grana, `ClTg=False`).

---

## 4. Kontrolna pravila (aktiva = pasiva itd.)

Data-driven (tabela `ZR_AOP_Pravila`). Forma `Form_ZR_AOP_Pravila` samo edituje i
zaključava kolone `Uslov/Pravilo/Opis/Obrazac` (nema hardkodiranih pravila).

- `VrednostPravila(Pravilo, ClTg)` — parsira `Pravilo` tipa `A001 < A002` preko istih
  NOT/AND/XOR/OR i `<= >= < > =` operatora → poređenje vrednosti `ZRVrednostIzrazaTG`.
- `VrednostPravilaZaUslov(Uslov, Pravilo)` — **uslovna pravila:** ako je `Uslov`
  prazan ILI `Uslov` istinit → rezultat = vrednost `Pravila`; inače → `True`
  (pravilo se ne primenjuje). Napomena: `Pravilo` se ovde evaluira sa `ClTg=False`.
- Pokretanje: dugme → query `ZR_ProveriPravila` → forma `ZR_NezadovoljenaPravila`
  prikazuje pravila koja nisu zadovoljena.

Klasična kontrola „aktiva = pasiva" bi bila red tipa `A0071 = A0424`, ali stvarni
AOP brojevi su **u podacima** (`ZR_AOP_Pravila`), ne u kodu.

**Hardkodirani sistemski AOP-ovi** (jedino što je u kodu, `SetAOP_TG` /
`UpisiKodekseUAOP` u `Form_ZR_UnosZaglavlja`):
- `9001` = BrojMeseciPoslovanja (Period)
- `9002` = VrstaSvojine
- `9005` = BrojZaposlenih

Ako sistemski AOP ne postoji u modli → `MsgBox "U modli ne postoji AOP = ..."`.

---

## 5. Konto → AOP mapiranje

**NEMA statičke konto→AOP tabele.** Mapiranje je **implicitno** kroz DSL masku u
`ZR_AOP_Modla.Definicija`: svaki AOP red nosi svoj izraz koji preko `LIKE 'maska'`
skuplja odgovarajuća konta iz bruto stanja. `GrupaKonta` je **dokumentacioni**
tekstualni atribut (grupisanje/opis na štampi), **NIJE** računski ulaz.

---

## 6. Razlike BS / BU / SI

Sva tri obrasca dele **isti motor i istu tabelu** `ZR_Stavke` — razlikuju se po
koloni `Obrazac` (`"BS"`/`"BU"`/`"SI"`) i po XML eksport proceduri:

| | BS (Bilans stanja) | BU (Bilans uspeha) | SI (Statistički izveštaj) |
|---|---|---|---|
| Kolone iznosa | `Iznos_1` (tekuća krajnje), `Iznos_2`, `Iznos_3` (prethodna) | `Iznos_1`, `Iznos_2` | `Iznos_1`, `Iznos_2`, `Iznos_3` |
| PG grana | DA (`ClTg=False` iz `PSPG_BrutoStanje_PG`) | ograničeno | ograničeno |
| XML `nil` za 0 | DA (`XmlTag` → `i:nil="true"`) | NE (piše `0`) | NE (piše `0`) |
| Naziv u XML | „Bilans stanja" | „Bilans uspeha" | „Statistički izveštaj" |
| Naming polja | `aop-<AOP>-<StartnaKolona+n>` | isto | isto |

Napomena (bug u legacy SI eksportu): za `BrojKolona>=3` SI piše `Iznos_2` i u treću
kolonu (`aop-...-(StartnaKolona+2)` → vrednost `Iznos_2`, ne `Iznos_3`). Ne
reprodukovati — to je greška, ne namera.

### 6.3 Bug-kompatibilnost aritmetike
Zbog levo-vezujuće rekurzije na desni ostatak (§2.3), lanac oduzimanja se ponaša
kao standardno `A - B - C` = `A - B - C` (jer `A - (B - C)`? NE): tačan trace za
`A-B-C`: prvo `-` je na poziciji posle A → `A - eval("B-C")` = `A - (B - C)` =
`A - B + C`. **To je matematički pogrešno**, ali BigBit definicije to izbegavaju
tako što ne pišu više uzastopnih `-` bez zagrada; koriste `X+Y-Z` (jedan minus na
kraju je siguran). Naš port (`gkeval.service.ts`) je **matematički korektan**
(levo-asocijativno `A-B-C = (A-B)-C`) — vidi §8 za implikaciju.

---

## 7. Kako izvući verbatim formule (blokira pun seed)

Nema mdb-tools/pyodbc u okruženju. Instrukcija je u `_legacy/BigBit26/_EXPORT_ZR.txt`:
u Access-u (sa `BIGBIT.MDW` login), Immediate window:
```
DoCmd.TransferText acExportDelim,,"ZR_AOP_Modla","...\ZR_AOP_Modla.csv",True
DoCmd.TransferText acExportDelim,,"ZR_AOP_Pravila","...\ZR_AOP_Pravila.csv",True
DoCmd.TransferText acExportDelim,,"ZR_Stavke","...\ZR_Stavke.csv",True
```
Kad CSV-ovi stignu → čitaju se kolone `AOP`, `Definicija`, `Obrazac`, `Grupa`,
`ZaKolonu`, `StartnaKolona`, `BrojKolona`, `Pozicija` i pretvaraju 1:1 u
`balance_formula_definitions`. **Do tada seed je rekonstrukcija.**

---

## 8. Poklapanje BigBit DSL ↔ naš GkEval — i potrebne dopune

Naš `gkeval.service.ts` pokriva **jezgro** DSL-a: prefiksi `D/P/PSD/PSP/A`,
wildcard `*`→`%` (+ `?`→`_`), aritmetika `+ - ( )`, `A<aop>` preko `resolveAop`
callback-a. Sledeće BigBit konstrukcije **nedostaju** i treba ih specifikovati
(ne implementirati unapred — potvrda scope-a):

1. **`AB`/`AC` prefiksi (Iznos_2 / Iznos_3 druge pozicije).** GkEval prepoznaje
   samo `A<aop>` (jedna kolona). Dopuna: `parseAtom` da razlikuje `AB`/`AC` i da
   `resolveAop` prima i oznaku kolone (`1|2|3`), pa `BalanceSheetService` vraća
   traženu kolonu. Bez ovoga `AB0002` bi se parsiralo kao `A` + operand `B0002`
   (pogrešno).

2. **Clamp A-formula na ≥0** (§3, potvrđeno u query-ju). GkEval NE klampuje. Dopuna:
   ILI u `resolveAop` implementaciji (BalanceSheetService) klampovati rezultat
   pozicija čija formula počinje sa `A`, ILI eksplicitni flag u
   `balance_formula_definitions` (`clamp_zero BOOLEAN`). Preporuka: flag u seed-u
   samo za AOP-e koje BigBit tretira kao `Like "A*"` u `Iznos_1/2`.

3. **PG (prethodna godina) grana.** GkEval računa jednu vrednost na `asOf`. BigBit
   ima poseban izvor za PG (`PSPG_BrutoStanje_PG`) i A→`Iznos_3` semantiku. Kod nas:
   PG = isti `evalFormula` sa `asOf` = kraj prethodne godine, a `resolveAop` u PG
   modu vraća kolonu 3. Dopuna je na nivou `BalanceSheetService` (dva prolaza), ne
   na `gkeval.service.ts`.

4. **Logički/komparacioni operatori za pravila** (`< > <= >= = AND OR XOR NOT`).
   GkEval ima samo aritmetiku. Kontrolna pravila su odvojen posao (tabela
   `ZR_AOP_Pravila`) → treba **poseban** mini-evaluator `RuleEval` (ili proširenje
   GkEval-a Boolean granom). Ne mešati sa bilansnim izrazima.

5. **Aritmetička (bug-)nekompatibilnost oduzimanja** (§6.3). Naš port je
   matematički korektan; BigBit je levo-vezujuć na desni ostatak. **Rizik samo ako**
   izvučena `Definicija` sadrži `A - B - C` bez zagrada. Pri importu verbatim
   formula: skenirati na `≥2` uzastopna `-`/mešana `+`/`-` bez zagrada i ručno
   proveriti (očekivano: nema takvih — BigBit ih izbegava).

6. **`Eval(cizraz)` fallback** (goli Access izraz kad nema prefiksa). GkEval podržava
   samo decimalni literal. Ako neka `Definicija` koristi Access funkciju (malo
   verovatno u bilansu) → GkEvalError. Prihvatljivo; obraditi ako se pojavi u dumpu.

**Zaključak poklapanja:** BigBit DSL **NIJE 1:1** sa našim GkEval-om. Jezgro
(D/P/PSD/PSP/A + wildcard + `+ - ( )`) jeste identično; razlike su: `AB/AC` kolone,
clamp≥0, PG-izvor, Boolean operatori za pravila, i (teoretski) redosled oduzimanja.
Za bilansne pozicije klasa 0–7 sa formulama tipa `PSD022*+D022*-PSD0229*` — poklapa
se 1:1. Za pun paritet trebaju dopune 1–4.

# BigBit ZR (Završni račun / bilansi) — kako motor STVARNO radi

> **Status:** ISTRAŽIVANJE, 2026-07-25. Zamenjuje ključne pretpostavke iz
> [44-zr-bilans-motor-iz-vba.md](44-zr-bilans-motor-iz-vba.md) (VBA je bio tačan, ali su
> zaključci o izvoru podataka i o „nezamenjivosti" `ZR_AOP_Modla` bili **pogrešni**).
> Svaka tvrdnja ispod ima izvor (fajl + isečak). Gde izvora nema — piše **NEPOZNATO**.

---

## PRESUDA (kratko)

**ZR NIJE blokada za 31.12.2026.**

Tri razloga, redom po težini:

1. **Zakonski isporučivač nije ZR modul nego APR eFI.** BigBit ZR ne šalje ništa državi — on
   pravi XML koji se **uvozi u APR-ovu aplikaciju** (`C:\ZR\RIApp.exe`, dugme `DugmeRiApp` u
   `Form_ZR_UnosZaglavlja`). Predaja je i danas u APR-u; BigBit je samo predpunilac.
2. **Ono što BigBit ZR-u treba od nas je bruto stanje po kontu** — i ništa više. To 3.0/4.0 već
   ima (`GkEvalService.grossTrialBalance`). Dok god iz naše glavne knjige može da izađe korektan
   zaključni list po kontu za godinu, knjigovođa radi ZR isto kao i danas.
3. **`ZR_AOP_Modla` NIJE nezamenjiva.** Ona je BigBit-ovo kodiranje zvaničnog obrasca iz
   Pravilnika („Sl. glasnik RS" 89/2020). Predati obrasci Servoteha za 2023
   (`_legacy/BigBit26/ZR_validacija/`) sami nose i AOP aritmetiku i grupe računa po poziciji —
   dovoljno da se modla **rekonstruiše i verifikuje brojevima**, bez knjigovođine mašine.

**Šta jeste rizik** (ali rizik kvaliteta, ne roka): naš postojeći seed formula je 57 redova sa
**pogrešnom AOP numeracijom** i sa **verovatnim dvostrukim brojanjem početnog stanja** (§9). To
se popravlja kod nas, ne kod knjigovođe.

---

## 0. Izvori korišćeni u ovoj analizi

| Izvor | Šta daje |
|---|---|
| `_legacy/BigBit26/BigBit_APL_2010_ZR_code.txt` (672 lin.) | motor `VrednostIzraza` + XML eksport BS/BU/SI |
| `_legacy/BigBit26/BigBit_APL_2010_Form_ZR_UnosZaglavlja_code.txt` (742 lin.) | orkestracija: redosled upita, 7 iteracija, `RIApp.exe` |
| `_legacy/BigBit26/BigBit_APL_2010_Form_ZR_UnosBrutoStanja_code.txt` | punjenje bruto stanja, relink na klijentovu bazu |
| `_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/ZR_*.sql`, `APGK_ZR_*.sql` | **pun SQL svih 25 ZR upita** (nije bilo potrebe za novom ekstrakcijom) |
| `_legacy/BigBit26/ZR_validacija/*.pdf` → `backend/reports/zr/bs.txt`, `bu.txt` + `pdftotext` na `ubuntusrv` | **predati obrasci Servoteha za 2023** (BS, BU, SI, ITG, IPK, IOR, Napomene) |
| `APL.MDB` na `ubuntusrv:/tmp/bb26` (`mdbtools:local`) | `BazeITabele_APL`, `Baze_Tipovi_APL`, `MSysObjects`, `MSysQueries` |
| `_legacy/BigbitRaznoNenad/_extracted/queries_full/OnLine_BigBit_APL/_index.txt` | dokaz da živa Servoteh aplikacija NEMA ZR upite |

---

## 1. Odakle ZR uzima podatke — IZ GLAVNE KNJIGE, AUTOMATSKI

**Odgovor: `ZR_BrutoStanje` se NE kuca ručno. Generiše ga upit iz `T_Glavna knjiga` + `T_Nalozi`.**

Lanac je trostepen i u celini je u kodu.

### 1.1 Izvor — agregacija naše glavne knjige

`_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/ZR_BrutoStanjeUpit.sql`
(verbatim; isto potvrđeno iz `MSysQueries` ObjectId `-2147476550`):

```sql
SELECT Left$([T_Glavna knjiga]![Konto],[Forms]![ZR_UnosBrutoStanja]![SvedenoNaBrojCifZaKonto]) AS SvedenKonto,
       Sum([T_Glavna knjiga].Duguje)     AS SumOfDuguje,
       Sum([T_Glavna knjiga].Potrazuje)  AS SumOfPotrazuje,
       Sum(IIf([Vrsta naloga] Like [Forms]![ZR_UnosBrutoStanja]![VrstaNalogaPS],[Duguje],0))    AS PSDuguje,
       Sum(IIf([Vrsta naloga] Like [Forms]![ZR_UnosBrutoStanja]![VrstaNalogaPS],[Potrazuje],0)) AS PSPotrazuje
FROM T_Nalozi INNER JOIN [T_Glavna knjiga] ON T_Nalozi.IDNaloga = [T_Glavna knjiga].IDNaloga
WHERE ((T_Nalozi.[Datum naloga]) Between Nz(...![OdDatumaNaloga],#1/1/1901#) And Nz(...![DoDatumaNaloga],#12/31/2099#))
  AND ((Nz([T_Nalozi].[Level],0))=0)
  AND (([T_Glavna knjiga].[Datum dokumenta]) Between Nz(...![OdDatumaDokumenta],#1/1/1901#) And Nz(...![DoDatumaDokumenta],#12/31/2099#))
GROUP BY Left$([T_Glavna knjiga]![Konto],[Forms]![ZR_UnosBrutoStanja]![SvedenoNaBrojCifZaKonto]);
```

Čita se: **sve stavke glavne knjige** u zadatom opsegu datuma, `Level = 0` (knjižen, ne nacrt),
grupisano po kontu **svedenom na N cifara** (parametar `SvedenoNaBrojCifZaKonto`, npr. 3). PS
(početno stanje) se izdvaja filtriranjem `Vrsta naloga LIKE 'PS'`
(`_legacy/BigbitRaznoNenad/_extracted/rule_tables/BB_T_26/Vrsta naloga.csv` → `PS,Početno stanje`).

### 1.2 Upis u `ZR_BrutoStanje` (append upit, dugme na formi)

`ZR_BrutoStanjeUpisiUTablicu_Zaokruzeno.sql`:

```sql
INSERT INTO ZR_BrutoStanje ( IDBrutoStanje, Konto, OpisKonta, Duguje, Potrazuje, PSDuguje, PSPotrazuje )
SELECT [Forms]![ZR_UnosBrutoStanja]![IDBrutoStanje], ZR_BrutoStanjeUpit.SvedenKonto, Nz([Opis],"-"),
       Round([SumOfDuguje]/1000,0), Round([SumOfPotrazuje]/1000,0),
       Round([PSDuguje]/1000,0),    Round([PSPotrazuje]/1000,0)
FROM ZR_BrutoStanjeUpit LEFT JOIN [Kontni plan] ON ZR_BrutoStanjeUpit.SvedenKonto = [Kontni plan].Konto;
```

Varijanta `_Nezaokruzeno` je identična bez `/1000` (kad je bruto stanje već u hiljadama).
Okidač je dugme, `Form_ZR_UnosBrutoStanja`:

```vb
Private Sub DugmeUpisiBrutoStanjeUTablicu_Click()
    If Me!ZaokruzenoNa1000 Then stDocName = "ZR_BrutoStanjeUpisiUTablicu_Zaokruzeno" _
    Else stDocName = "ZR_BrutoStanjeUpisiUTablicu_Nezaokruzeno"
    DoCmd.OpenQuery stDocName, acNormal, acEdit
```

### 1.3 Kako se motor priključuje na tu tabelu

`ZR_BrutoStanje_TG.sql` je samo filter na jedno snimljeno bruto stanje:

```sql
SELECT ZR_BrutoStanje.* FROM ZR_BrutoStanje
WHERE (((ZR_BrutoStanje.IDBrutoStanje)=[Forms]![ZR_UnosZaglavlja]![ComboIDBrutoStanjeTG]));
```

a `ZR.bas` nad njim radi `DSum` (`BigBit_APL_2010_ZR_code.txt`, lin. 97–110):

```vb
If UCase$(DugPotPS) = "D" Then
    v = DSum("[Duguje]", "ZR_BrutoStanje_TG", "[Konto] Like '" & likeUslov & "'")
ElseIf UCase$(DugPotPS) = "P" Then
    v = DSum("[Potrazuje]", "ZR_BrutoStanje_TG", "[Konto] Like '" & likeUslov & "'")
ElseIf UCase$(DugPotPS) = "PSD" Then
    v = DSum("[PSDuguje]", "ZR_BrutoStanje_TG", "[Konto] Like '" & likeUslov & "'")
```

### 1.4 Dva režima: „za klijenta" i „za sopstvenu firmu"

Postoje **dve garniture** upita:

- **Servisni (knjigovođin) režim** — `ZR_*`: `ZR_UnosBrutoStanja` bira komitenta iz
  `ZR_Komitenti`, čita mu `BigBitBaza` (putanja do njegovog `.mdb`) i **relinkuje** cele
  `BigBit_T` tabele na tu bazu:
  ```vb
  Private Sub ComboKomitent_AfterUpdate()
      Me!BigBitBaza = DLookup("[BigBitBaza]", "ZR_Komitenti", "[IDKomitent] = " & Me!ComboKomitent)
  ...
  Private Function PoveziSeSaBazom(ImeBaze As String) As Boolean
      varRetOk = ForsirajNoveLinkoveZaTipBaze("BigBit_T", ImeBaze)
  ```
  a `ZR_Komitenti` se puni iz registra klijenata te BigBit instalacije
  (`ZR_PrepisiKomitenteIzCFG.sql`: `INSERT INTO ZR_Komitenti (... BigBitBaza ...) SELECT [Radni fajlovi].Firma, ..., [Radni fajlovi].[Naziv baze], ... FROM [Radni fajlovi]`).

- **Sopstveni režim `APGK_ZR_*`** (`IDZR = 0`, tekuća firma) — ovo je „**ZR iz naše baze**"
  o kom je korisnik govorio. `APGK_ZR_BrutoStanjeStavke_Save0.sql`:
  ```sql
  INSERT INTO ZR_BrutoStanje ( IDBrutoStanje, Konto, OpisKonta, PSDuguje, PSPotrazuje, Duguje, Potrazuje )
  SELECT 0, APGK_BrutoStanje.Konto, APGK_BrutoStanje.OpisKonta,
         APGK_BrutoStanje.PSDuguje, APGK_BrutoStanje.PSPotrazuje,
         APGK_BrutoStanje.UkPrometDuguje, APGK_BrutoStanje.UkPrometPotrazuje
  FROM APGK_BrutoStanje;
  ```
  i `APGK_ZR_Zag_Make0.sql` koji zaglavlje popunjava iz **aktivne firme**:
  ```sql
  SELECT 0 AS IDZR, F_Godina(), F_AFNaziv(), Date(), "Auto", F_AFMesto(), F_AFPIB(),
         F_AFMaticniBroj(), F_AFSifraDelatnosti(), "750" AS VrstaPosla, 1 AS Kodeks25,
         1 AS VelicinaPreduzecaTG, 0 AS Zadruga, 2 AS VrstaSvojine, 10 AS KojeSeGodinePopunjavaju,
         12 AS BrojMeseciPoslovanja, 0 AS StatusnaPromena, 1 AS BrojZaposlenih;
  ```
  `APGK_BrutoStanje` je zaključni list nad `APGK_Dnevnik` (dnevnik glavne knjige aktivne firme),
  sa svim uobičajenim filterima (klasa, OJ, OD, godina, datumi naloga i dokumenta, Level).

> **Zaključak Q1:** korisnik je **u pravu** — ZR radi iz naše baze; ručnog kucanja bruto stanja
> nema. Ono što se ručno unosi su samo pozicije koje glavna knjiga ne daje (npr. OS-podaci koje
> knjigovođa dostavlja, doc 37 §SCOPE) i parametri zaglavlja.

---

## 2. Šta je zaista `ZR_AOP_Modla`

**Katalog AOP pozicija sa formulama** — jedan red = jedna linija zvaničnog obrasca.

### 2.1 Kolone (potvrđeno iz `ZR_PrepisiModlu.sql` i lock-liste u `Form_ZR_AOP_Modla`)

```sql
INSERT INTO ZR_Stavke ( IDZR, AOP, GrupaKonta, Pozicija, Definicija, ZaKolonu, Obrazac, Grupa, StartnaKolona, BrojKolona )
SELECT [Forms]![ZR_UnosZaglavlja]![IDZR], ZR_AOP_Modla.AOP, ZR_AOP_Modla.GrupaKonta, ZR_AOP_Modla.Pozicija,
       ZR_AOP_Modla.Definicija, ZR_AOP_Modla.ZaKolonu, ZR_AOP_Modla.Obrazac, ZR_AOP_Modla.Grupa,
       ZR_AOP_Modla.StartnaKolona, ZR_AOP_Modla.BrojKolona
FROM ZR_AOP_Modla LEFT JOIN ZR_Stavke_TG ON ZR_AOP_Modla.AOP = ZR_Stavke_TG.AOP
WHERE (((ZR_Stavke_TG.AOP) Is Null)
   AND ((ZR_AOP_Modla.Velicina)<=CLng(nz([Forms]![ZR_UnosZaglavlja]![VelicinaPreduzecaTG],0))));
```

| Kolona | Značenje | Ima li je predati obrazac? |
|---|---|---|
| `AOP` | oznaka pozicije (`0002`, `1001`, `9015`) | ✅ kolona 3 obrasca |
| `Pozicija` | tekst pozicije | ✅ kolona 2 |
| `GrupaKonta` | „Група рачуна, рачун" (dokumentaciono) | ✅ kolona 1 |
| `Definicija` | **formula (DSL)** | ⚠️ delimično (§8) |
| `Obrazac` | `BS` / `BU` / `SI` | ✅ (koji je obrazac) |
| `Grupa` | sekcija unutar obrasca (npr. `002` = SI deo II) | ✅ iz zaglavlja sekcija |
| `ZaKolonu` | `"1"`/`"2"`/`"3"` — u koji `Iznos_n` upisati | ✅ implicitno |
| `StartnaKolona`, `BrojKolona` | broj prve kolone i koliko ih ima (za XML `aop-XXXX-N`) | ✅ iz reda brojeva kolona u obrascu |
| `Velicina` | prag veličine preduzeća (§3) | ❌ (i verovatno mrtvo, §3) |

**`Definicija` NIJE u kodu** — kod je samo interpreter. To je i dalje tačno (doc 44). Ali iz toga
**ne sledi** da je tabela nezamenjiva: sadržaj joj je zvanični obrazac (§8).

### 2.2 Sintaksa `Definicija` (verbatim iz `ZR.bas`)

Atom = prefiks + maska, čitano **3 → 2 → 1 znak**
(`BigBit_APL_2010_ZR_code.txt`, lin. 76–113):

| Prefiks | Značenje | Izvor TG (`ClTg=True`) | Izvor PG (`ClTg=False`) |
|---|---|---|---|
| `D<maska>` | Σ dugovnog **ukupnog prometa** | `ZR_BrutoStanje_TG.[Duguje]` | `PSPG_BrutoStanje_PG` |
| `P<maska>` | Σ potražnog ukupnog prometa | `[Potrazuje]` | `PSPG_BrutoStanje_PG` |
| `PSD<maska>` | Σ početnog stanja dugovno | `[PSDuguje]` | `PSPG_BrutoStanje_PG` |
| `PSP<maska>` | Σ početnog stanja potražno | `[PSPotrazuje]` | `PSPG_BrutoStanje_PG` |
| `A<aop>` | druga pozicija, `Iznos_1` | `ZR_Stavke_TG.[Iznos_1]` | `ZR_Stavke_TG.[Iznos_3]` |
| `AB<aop>` | druga pozicija, `Iznos_2` | `[Iznos_2]` | (zakomentarisano — nedostupno) |
| `AC<aop>` | druga pozicija, `Iznos_3` | `[Iznos_3]` | (zakomentarisano) |
| bez prefiksa | `Eval(cizraz)` — konstanta / Access izraz | | |

Maska je Access `LIKE`; `*` = wildcard, **nikad množenje**. Operatori aritmetike: **samo `+` i `-`**.
Komentar u kodu (lin. 51): `' izraz je tipa D202* + P433* - D021*`.

Za **pravila** (`ZR_AOP_Pravila`) dodatno rade `NOT/AND/XOR/OR` i `<= >= < > =`
(`VrednostIzrazaBezZagrada`), a `VrednostPravilaZaUslov(Uslov, Pravilo)` daje uslovna pravila.

### 2.3 Primeri formula koje se mogu rekonstruisati

VBA daje **oblik**, ne konkretne definicije. Ali kombinacija (obrazac + kontni plan + univerzalni
clamp ≥0, §9.1) daje jednoznačne rekonstrukcije, npr.:

| AOP (BU 2023) | Tekst obrasca | Rekonstruisana `Definicija` |
|---|---|---|
| `1003` | „600, 602 и 604 — Приходи од продаје робе на домаћем тржишту" | `P600*+P602*+P604*-D600*-D602*-D604*` |
| `1002` | „I. ПРИХОДИ ОД ПРОДАЈЕ РОБЕ (1003 + 1004)" | `A1003+A1004` |
| `1025` | „В. ПОСЛОВНИ ДОБИТАК (1001 - 1013) ≥ 0" | `A1001-A1013` (clamp ≥0 je automatski) |
| `1026` | „Г. ПОСЛОВНИ ГУБИТАК (1013 - 1001) ≥ 0" | `A1013-A1001` |
| `1051` | „721 — Порески расход периода" | `D721*-P721*` |
| `1052` | „722 **дуг. салдо** — Одложени порески расходи" | `D722*-P722*` (clamp daje „samo ako je dugovni") |
| `1053` | „722 **пот. салдо** — Одложени порески приходи" | `P722*-D722*` |

To je ključni mehanizam: **„dugovni saldo" / „potražni saldo" iz obrasca se u DSL-u izražava
obrnutim parom formula, a univerzalni clamp ≥ 0 odseca pogrešan smer.** DSL nema `IIf`.

---

## 3. Verzionisanje formula po godini i po veličini preduzeća

**Po veličini — DA, mehanizam postoji.** `ZR_PrepisiModlu.sql` (gore, §2.1):

```sql
AND ((ZR_AOP_Modla.Velicina) <= CLng(nz([Forms]![ZR_UnosZaglavlja]![VelicinaPreduzecaTG],0)))
```

Modla je **nadskup**; kopiraju se samo redovi čija je `Velicina` ≤ veličine obveznika. `VelicinaPreduzecaTG`
dolazi iz `ZR_Komitenti.VelicinaPreduzeca` (`Form_ZR_UnosZaglavlja.Naziv_AfterUpdate`:
`Me!VelicinaPreduzecaTG = DLookup("[VelicinaPreduzeca]", "ZR_Komitenti", ...)`), a šifarnik je
tabela `ZR_VelicinaPreduzeca` (baza `9010 = ZR_MOD`).

**Sadržaj `ZR_VelicinaPreduzeca` i tačna šifra Servoteha = NEPOZNATO** (tabela nije kod nas).
Indirektno: `APGK_ZR_Zag_Make0.sql` hardkodira `1 AS VelicinaPreduzecaTG` kao default, a
`APGK_ZR_PrepisiModlu.sql` **uopšte nema `Velicina` filter** — u sopstvenom režimu se kopira cela modla.

**Praktično: taj filter je danas mrtvo slovo.** Pravilnik 89/2020 propisuje **jedan** komplet obrazaca
BS/BU/SI za sva pravna lica (podnožje predatih obrazaca Servoteha: „Образац прописан Правилником о
садржини и форми образаца финансијских извештаја … („Службени гласник РС" бр. 89/2020)"). Podela na
mikro/malo/srednje danas određuje **koje izveštaje predaješ**, ne koje AOP-ove popunjavaš.

**Po godini — NE, nema verzionisanja u šemi.** `ZR_AOP_Modla` nema kolonu godine; kad se propis
promeni, modla se prepravlja „na mestu". Zato je i moguće da je današnja modla usklađena sa 89/2020,
a naša rekonstrukcija sa nekim starijim obrascem (§9.2).

**Za Servoteh (dokumentovano iz `ZR_validacija/`):**
- prosečan broj zaposlenih 2023 = **79** (SI, AOP 9005), 2022 = 80;
- oznaka za vlasništvo (AOP 9002) = **2**;
- broj meseci poslovanja (AOP 9001) = 12;
- predat **pun komplet**: BS, BU, Izveštaj o ostalom rezultatu, Izveštaj o promenama na kapitalu,
  Izveštaj o tokovima gotovine, Statistički izveštaj, Napomene;
- računovodstveni okvir: **MSFI za MSP** (Napomene, str. 1).

Puni komplet + 79 zaposlenih upućuje na **srednje pravno lice**, ali zvanično rešenje o razvrstavanju
nije u ovom materijalu → **veličina po Zakonu o računovodstvu: NEPOZNATO (traži se od knjigovođe, §10)**.

---

## 4. Gde fizički žive `ZR_MOD` i `ZR_POD`

**Kod knjigovođe. Nisu na Servotehovoj mreži.** Dokazi, redom:

1. **Registar baza ih poznaje, ali putanja nije upisana.** `APL.MDB` → `Baze_Tipovi_APL`:
   `9000 = ZR_APL`, `9010 = ZR_MOD`, `9020 = ZR_POD`. `BazeITabele_APL` (`mdb-export`):
   ```
   901010,9010,0,"ZR_AOP_Modla","ZR_AOP_Modla",,0,
   901020,9010,0,"ZR_AOP_Pravila","ZR_AOP_Pravila",,0,
   901030,9010,0,"ZR_VelicinaPreduzeca","ZR_VelicinaPreduzeca",,0,
   902010,9020,0,"ZR_APL_CFG","APL_CFG",,0,
   902030,9020,0,"ZR_BrutoStanjeZaglavlje",...
   902040,9020,0,"ZR_BrutoStanje",...
   902050,9020,0,"ZR_Komitenti",...
   902060,9020,0,"ZR_Zaglavlje",...
   902070,9020,0,"ZR_Stavke",...
   ```
   Poslednja kolona (`CurrentSourceDataBase`) je **prazna** za svih 9 — dok je za sve ostale tipove
   popunjena (`;DATABASE=C:\SHARES\AcBaze\BigBit\TG\BB_T_TG.MDB`). Znači: te baze **nikada nisu bile
   povezane na ovoj instalaciji**.
2. **U `MSysObjects` fajla `APL.MDB` nema nijedne *linkovane tabele* `ZR_*`** — postoje samo forme
   (`Type -32768`), izveštaji (`-32764`) i upiti (`Type 5`) sa tim imenima. Nijedan `Connect`/`Database`
   string ne pominje ZR putanju.
3. **Ni u jednoj lokalnoj `.mdb` nema `ZR_*` tabela**: provereno `BB_T.MDB`/`BB_T_TG.MDB`,
   `BB_T_25.MDB`, `BB_CFG.mdb`, `BB_CFG_Lokal.mdb`, `BB_FIT.mdb`, `BB_TMP.mdb`, `APL.MDB`.
   Folder `_legacy/BigBit26/MOD/` je **prazan**.
4. **Aplikacija je multi-klijentska, tj. knjigovođina.** `ZR_Komitenti` se puni iz registra svih
   klijentskih baza (`ZR_PrepisiKomitenteIzCFG.sql` ← `[Radni fajlovi]`), a `Form_ZR_Start`:
   ```vb
   Private Sub Form_Close()
    If CurrentUser <> "Slavisa" Then
     DoCmd.Quit
    End If
   End Sub
   ```
5. **Putanja se u kodu nikad ne hardkoduje** — postavlja je `ForsirajNoveLinkoveZaTipBaze(<tip>, <baza>)`
   u trenutku izvršavanja, pa je **obrazac putanje NEPOZNAT**; jedini fiksni trag ZR mašine je
   `stAppName = "C:\ZR\RIApp.exe"` (`Form_ZR_UnosZaglavlja.DugmeRiApp_Click`), tj. na toj mašini
   postoji `C:\ZR\`.
6. **Živa Servotehova BigBit aplikacija uopšte nema ZR.** U dumpu `OnLine_BigBit_APL` (1.895 upita)
   ima **0 upita `ZR_*`** i **0 `APGK_ZR_*`** — samo je VBA modul `Module__ZR.txt` (250 linija) ostao
   kao mrtav kod. Cela ZR garnitura (forme + 25 upita + 3 izveštaja) postoji isključivo u
   `BigBit_APL_2010.MDB` (knjigovodstveni/APGK build).

---

## 5. Šta radi `ZRXML` — izvoz za APR

`ZRXML` je pomoćni modul od 17 linija; sav izvoz je u `ZR.bas`
(`ZR_EksportXML_BS` / `_BU` / `_SI`) + jedan legacy (`ZR_EksportXML_Do15032015`, format do 2015).

**Aktuelni format = APR eFI „FiForma"** (`ZR.bas`, lin. 283):

```vb
tmpst = "<FiForma xmlns=""http://schemas.datacontract.org/2004/07/Domain.Model"" " & _
        "xmlns:i=""http://www.w3.org/2001/XMLSchema-instance""><Naziv>Bilans stanja</Naziv>" & _
        "<NumerickaPoljaForme xmlns:a=""http://schemas.datacontract.org/2004/07/AppDef"">"
```

Struktura:

```xml
<FiForma xmlns="http://schemas.datacontract.org/2004/07/Domain.Model"
         xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
  <Naziv>Bilans stanja</Naziv>            <!-- ili "Bilans uspeha" / "Statistički izveštaj" -->
  <NumerickaPoljaForme xmlns:a="http://schemas.datacontract.org/2004/07/AppDef">
    <a:NumerickoPolje>
      <a:Naziv>aop-0002-5</a:Naziv>       <!-- aop-{AOP}-{StartnaKolona + n} -->
      <a:Vrednosti>223642</a:Vrednosti>   <!-- Round(Iznos_n, 0) -->
    </a:NumerickoPolje>
    ...
  </NumerickaPoljaForme>
  <TekstualnaPoljaForme>
    <TekstualnoPolje><Naziv>aop-0002-4</Naziv><Vrednosti></Vrednosti></TekstualnoPolje>
    ...                                    <!-- kolona StartnaKolona-1 = „Napomena broj", prazna -->
  </TekstualnaPoljaForme>
</FiForma>
```

Detalji potvrđeni iz koda:
- broj kolona po AOP-u kontroliše `BrojKolona` (`If ZRStavkeZaExport![BrojKolona] >= 2 Then …`);
- **`i:nil="true"` na nuli — samo u BS.** `XmlTag` (`ZRXML`):
  ```vb
  ElseIf Nz(Vrednost, 0) = 0 Then
     retVal = retVal & " i:nil = ""true""" & "/>"
  ```
  BU i SI pišu golu `0` (koriste `"<a:Vrednosti>" & Round(...) & "</a:Vrednosti>"`);
- ime fajla: `ZR_ReadParametar("XMLDIR") & Left$(Naziv,10) & "_" & Godina` + `_BS.xml`/`_BU.xml`/`_SI.xml`
  (`OdrediIMeXMLFajla`, `DugmeExportXML_Click`); `XMLDIR` je u `ZR_APL_CFG` (baza `9020`);
- izvor podataka je `ZR_StavkeZaExport` (join `ZR_Zaglavlje` + `ZR_Stavke`, `ORDER BY AOP`,
  filtriran po `Obrazac`);
- **poznata greška u legacy SI eksportu:** za `BrojKolona >= 3` treća kolona dobija `Iznos_2` umesto
  `Iznos_3` (`ZR.bas`, lin. 526–531). Ne reprodukovati.

**XML se ne šalje državi iz BigBit-a.** Nosi ga APR-ova aplikacija — `DugmeRiApp_Click`:
`stAppName = "C:\ZR\RIApp.exe" : Call shell(stAppName, 1)`.

Naš `backend/src/modules/zavrsni/apr-xml.service.ts` već generiše ovaj oblik, ali sa
`DEFAULT_START_COLUMN` (jer `StartnaKolona` nije seed-ovan) i sa `i:nil` na 0 za sva tri obrasca —
oba odstupanja su označena kao `TODO(zr-aop-modla)` u kodu.

---

## 6. Može li se ZR pokrenuti bez knjigovođine mašine?

**Ne u BigBit-u; da u 4.0 — i da, i danas, u APR-u ručno.**

### 6.1 U BigBit-u — NE
Nedostaju **podaci** (`ZR_MOD`: modla + pravila + šifarnik veličina; `ZR_POD`: zaglavlja/stavke/
istorija) **i aplikativni objekti** (forme + 25 upita postoje samo u `BigBit_APL_2010.MDB`, kojeg na
Servotehovoj živoj instalaciji nema — §4 t.6). Minimum da BigBit ZR proradi kod nas:
1. kopija `ZR_MOD` i `ZR_POD` `.mdb` fajlova,
2. `BigBit_APL_2010.MDB` + `BIGBIT.MDW` sa nalogom koji ima prava,
3. relink `9010`/`9020` na te kopije,
4. `RIApp.exe` za predaju (ili APR web).

To je **rekonstrukcija tuđe instalacije** — ne preporučuje se kao cilj.

### 6.2 U 4.0 — DA, uz konačan seed formula
Sve komponente osim podataka već postoje:

| Komponenta | Status u 4.0 |
|---|---|
| bruto stanje po kontu iz GK | ✅ `GkEvalService.grossTrialBalance` |
| DSL evaluator (`D/P/PSD/PSP/A/AB/AC`, wildcard, `+ - ( )`) | ✅ `gkeval.service.ts` |
| iterativna konvergencija A-referenci (7 prolaza kao BigBit) | ✅ `balance-sheet.service.ts`, `MAX_ITER = 7` |
| kontrolna pravila | ⚠️ `control-rules.service.ts` — hardkodirana 3 pravila |
| APR FiForma XML | ⚠️ `apr-xml.service.ts` — bez `StartnaKolona`/`BrojKolona` po AOP-u |
| **katalog AOP formula** | ❌ **57 redova, pogrešna numeracija (§9.2)** |

**Minimum za 4.0:** popuniti `balance_formula_definitions` sa svih 117 BS + 62 BU AOP-a po
Pravilniku 89/2020 (+ `startColumn`/`columnCount`), i verifikovati motor na predatom obrascu za
2023 (imamo tačne iznose za dve godine).

### 6.3 Za 31.12.2026 — DA, i bez ijedne od gornje dve stavke
Knjigovođa i danas predaje kroz APR eFI. Njemu treba **zaključni list po kontu za 2026** — što
izlazi iz naše glavne knjige. Formalni preduslov je da 4.0 do 31.12. ima ispravnu GK sa istim
kontnim planom; ZR modul je *nice-to-have*.

---

## 7. Presuda o riziku za 31.12.2026

| Ranija tvrdnja | Nalaz | Ocena |
|---|---|---|
| „`ZR_AOP_Modla` je kod Slaviše i jedina je stvar koja može da obori rok" | Tabela jeste kod njega (§4), ali je sadržaj = zvanični obrazac 89/2020, koji imamo u predatim PDF-ovima | **OBORENO** |
| „ZR se kuca ručno" | Bruto stanje se generiše upitom iz `T_Glavna knjiga` (§1) | **OBORENO** |
| „ZR radi iz naše baze" (korisnik) | Tačno — `APGK_ZR_*` režim radi nad aktivnom firmom (§1.4) | **POTVRĐENO** |
| „ZR je blokada za rok" | Predaja ide kroz APR eFI; nama treba samo bruto stanje | **NIJE BLOKADA** |

**Preostali stvarni rizici (svi upravljivi, nijedan nije rok-kritičan):**

1. 🟠 **Naš seed formula je neupotrebljiv za predaju** — 57 redova prema **pogrešnoj AOP
   numeraciji** i sa verovatnim dvostrukim brojanjem PS (§9). Posao: ~180 redova podataka, 1–2 dana,
   **verifikacija je besplatna** jer imamo predate iznose za 2023 i 2022.
2. 🟠 **Kontni plan mora ostati identičan.** Cela AOP mreža je `LIKE` po kontu; svaka izmena
   analitike (npr. novi konto klase 0 van maske) tiho menja bilans. Već postoji presedan:
   `02277/02278` parking dodat 13-03-2026 (doc 37 §A).
3. 🟡 **„(део)" pozicije nisu izvodive iz obrasca** — npr. AOP 0454 „49 (део) осим 498": podela
   grupe 49 na dugoročno/kratkoročno zavisi od Servotehove analitike. Traži se od knjigovođe (§10).
4. 🟡 **APR eFI XML šema nije potvrđena na živom uvozu.** Naš generator je rekonstrukcija; jedan
   uspešno uvezen XML od knjigovođe rešava pitanje zauvek (§10).
5. 🟢 **Kontrolna pravila** (`ZR_AOP_Pravila`) — korisno, ali APR i sam validira pri uvozu.

---

## 8. Šta predati obrazac DAJE, a šta NE

Izvor: `backend/reports/zr/bs.txt`, `bu.txt` + `pdftotext -layout` ostalih pet PDF-ova
(`ubuntusrv:/tmp/zrpdf/`).

### 8.1 Obim (prebrojano)

| Obrazac | Raspon AOP | Broj pozicija |
|---|---|---|
| Bilans stanja | `0001`–`0060` (aktiva), `0401`–`0457` (pasiva) | **117** |
| Bilans uspeha | `1001`–`1062` | **62** |
| Izveštaj o ostalom rezultatu | `2001`–`2029` | 29 |
| Izveštaj o tokovima gotovine | `3001`–`3055` | 55 |
| Izveštaj o promenama na kapitalu | `4001`–`4090` | 90 |
| Statistički izveštaj | `9001`–`9136` | **136** |
| **Ukupno** | | **489** |

BigBit ZR pokriva **samo BS + BU + SI** (315 pozicija) — ostala tri izveštaja se u BigBit-u ne rade
(nema ni obrasca ni izvoza), pa se popunjavaju u APR eFI ručno. **Naš seed pokriva 57.**

### 8.2 Šta obrazac DAJE — dovoljno za rekonstrukciju

1. **AOP aritmetiku, verbatim.** Npr. BU:
   `А. ПОСЛОВНИ ПРИХОДИ (1002 + 1005 + 1008 + 1009 - 1010 + 1011 + 1012)` → AOP `1001`;
   BS: `Б. СТАЛНА ИМОВИНА (0003 + 0009 + 0017 + 0018 + 0028)` → AOP `0002`;
   SI: `1.8. Стање на крају године (9008 + 9009 + 9010 + 9011 - 9012 + 9013 + 9014)` → AOP `9015`.
2. **Grupe računa po listu**, uključujući izuzetke:
   `600, 602 и 604`, `68, осим 683, 685 и 686`, `52 осим 520 и 521`, `44, 45 и 46 осим 467`,
   `47,48 осим 481`, `43, осим 430`, `42, осим 427`.
3. **Clamp pravilo, eksplicitno** — `≥ 0` piše u tekstu pozicije (BU: 1025, 1026, 1037, 1038, 1045,
   1046, 1049, 1050, 1055, 1056; BS: 0455).
4. **Parove „dobitak/gubitak"**, iz kojih se izvodi smer (npr. 1025 `= 1001-1013 ≥ 0` vs
   1026 `= 1013-1001 ≥ 0`).
5. **`StartnaKolona` / `BrojKolona`** — iz reda brojeva kolona: BS `1..7` → iznosi u 5,6,7
   (start 5, broj 3); BU `1..6` → 5,6 (start 5, broj 2); SI deo I → 3,4 (start 3, broj 2),
   SI deo II → 4,5,6 (start 4, broj 3).
6. **Kontrolne tačke sa pravim brojevima** — BS ukupna aktiva `0059` = ukupna pasiva `0456` =
   `868.293` (2023) / `638.633` (2022); BU neto dobitak `1055` = `34.636` / `41.817`.
   Idealan regresioni test.

### 8.3 Šta obrazac NE daje

| Rupa | Zašto | Kako se popunjava |
|---|---|---|
| **Smer (D−P ili P−D)** po poziciji | obrazac piše samo grupu računa | standardno pravilo (aktiva = dugovni saldo, pasiva = potražni) + univerzalni clamp ≥0; **jedan pogrešan smer daje 0 umesto iznosa — otkriva se na verifikaciji 2023** |
| **PS vs promet** (`PSD/PSP` vs `D/P`) | obrazac ne poznaje pojam početnog stanja | iz semantike BigBit bruto stanja (§9.1): za bilansne pozicije se koristi **ukupan promet**, PS-prefiksi samo tamo gde pozicija traži baš stanje na početku godine (SI deo II) |
| **„(део)" pozicije** | `0428` = „49 (део), осим 498 и 495 (део)" (dugoročna PVR), `0454` = „49 (део) осим 498" (kratkoročna PVR), `0430` = „495 (део)" (dugoročni odloženi prihodi) — ista grupa 49 se cepa na tri pozicije | **NIJE izvodivo iz obrasca** — traži se od knjigovođe (§10 t.2) |
| **„дуг./пот. салдо" pozicije** | AOP 1052/1053 (konto 722) | izvodivo: obrnut par formula + clamp (§2.3) |
| **Napomene broj** (kolona 4) | tekstualna, ručna | ostaje ručno (u XML-u prazno `TekstualnoPolje`) |
| **Sadržaj `ZR_AOP_Pravila`** | nije deo obrasca | APR validira pri uvozu; naš minimalni set je dovoljan |
| **`Velicina` po AOP-u** | nije na obrascu | irelevantno pod 89/2020 (§3) |

**Zaključak §8:** `ZR_AOP_Modla` **nije nezamenjiva**. Ono što u njoj ima a na obrascu nema svodi se
na **dve stvari**: (a) izbor smera/PS-prefiksa po poziciji — izvodivo iz računovodstvenog pravila i
proverljivo brojevima iz 2023, i (b) **„(део)" podele vezane za Servotehovu analitiku** — jedina
tvrda rupa.

---

## 9. Ispravke ranijih dokumenata (važno)

### 9.1 Clamp ≥ 0 je UNIVERZALAN, i `D`/`P` UKLJUČUJU početno stanje

Doc 44 §3 tvrdi da clamp važi „samo za A-reference". **Netačno.** Sva četiri porodice UPDATE upita
imaju isti `IIf(... > 0, ..., 0)`:

```sql
-- ZR_UpisiVrednostiIzBrutoStanjaUZRStavke_Iznos_1_Nezaokruzeno  (formule NAD BRUTO STANJEM)
UPDATE ZR_Stavke SET ZR_Stavke.Iznos_1 =
  IIf(VrednostIzraza(Nz([Definicija],""),True)>0, VrednostIzraza(Nz([Definicija],""),True), 0)
WHERE IDZR=[Forms]![ZR_UnosZaglavlja]![IDZR]
  AND Nz([Definicija],"-") Not Like "A*" And Nz([Definicija],"-") Not Like "(A*"
  AND ZR_Stavke.ZaKolonu="1";

-- ZR_UpisiVrednostiuIzAOPUZRStavke_Iznos_1  (A-reference)  → ista IIf konstrukcija
-- PSPG_ZR_UpisiVrednostiuIzAOPUZRStavke_Iznos_3            → ista, sa ClTg=False
```

→ **BigBit nikad ne upisuje negativan iznos u `ZR_Stavke`.** To je i namera obrasca (svaka pozicija
je nenegativna; dobitak/gubitak su odvojeni AOP-ovi). Naš `balance-sheet.service.ts` **ne klampuje**.

Drugo, teže: **`ZR_BrutoStanje.Duguje` je UKUPAN promet, uključujući PS.** Dokaz je preslikavanje
kolona u `APGK_ZR_BrutoStanjeStavke_Save0.sql`:

```sql
INSERT INTO ZR_BrutoStanje ( ..., Duguje, Potrazuje )
SELECT ..., APGK_BrutoStanje.UkPrometDuguje, APGK_BrutoStanje.UkPrometPotrazuje
```

a `APGK_BrutoStanje` ih računa kao `Sum(Duguje)` nad celim dnevnikom (PS nalozi uključeni), dok
`PSDuguje = Sum(IIf([Vrsta naloga]="PS",[Duguje],0))` **jeste podskup**.

⚠️ Posledica: formule oblika `PSD022*+D022*` (kakve su u našem seed-u i u doc 37 §C/D)
**duplo broje početno stanje**. Ispravan oblik je `D022*-P022*` (ili `D022*-P022*-D0229*+P0229*`
za neto). **Ovo treba proveriti i ispraviti pre bilo kakve upotrebe.**

### 9.2 Naš seed koristi AOP numeraciju koja ne odgovara obrascu koji Servoteh predaje

`backend/prisma/migrations/20260723150000_seed_balance_formulas_rekonstrukcija/migration.sql`:
32 reda `BALANCE_SHEET` + 25 `INCOME_STATEMENT`.

| Naš seed | Stvarni obrazac (89/2020, predat za 2023) |
|---|---|
| `0001` = „UKUPNA AKTIVA" | `0001` = „А. УПИСАНИ А НЕУПЛАЋЕНИ КАПИТАЛ"; ukupna aktiva je **`0059`** |
| `0044` = „OBRTNA IMOVINA" | obrtna imovina je **`0030`** |
| `0401` = „UKUPNA PASIVA" | `0401` = „А. КАПИТАЛ"; ukupna pasiva je **`0456`** |
| `1068` = „NETO DOBITAK" (u `control-rules.service.ts`) | neto dobitak je **`1055`** |
| `1010` = „POSLOVNI RASHODI" | poslovni rashodi su **`1013`** |

Tj. i seed i hardkodirana kontrolna pravila rade nad **starijom/izmišljenom numeracijom**.
Oznaka u zaglavlju migracije („⚠️ REKONSTRUKCIJA — NE ZA PORESKU PREDAJU") je opravdana i treba je
zadržati dok se seed ne prepiše.

### 9.3 Redosled parsiranja `+` i `-` — potvrda i tačan opseg razlike

BigBit (`ZRVrednostIzrazaTG`, `ZR_code.txt` lin. 55–65) prvo traži **`+`**, pa tek ako ga nema **`-`**,
i rekurzira na **desni ostatak**. Naš `gkeval.service.ts` je klasičan levo-asocijativan
(`parseExpr: acc = acc.add/sub(rhs)`).

- Kad izraz sadrži bar jedan `+`, cepanje na prvom `+` je **ekvivalentno** matematički korektnom.
  Primer `1002+1005+1008+1009-1010+1011+1012` (AOP 1001) — oba motora daju isto.
- Razlika nastaje **samo** u podizrazu koji nema `+` a ima **dva ili više `-`**:
  `A-B-C` → BigBit računa `A-(B-C)` = `A-B+C`. **Netačno po obrascu.**
- Primer iz stvarnog obrasca: AOP `1055` = `(1049 - 1050 - 1051 - 1052 + 1053 - 1054)`. Levi deo
  `1049-1050-1051-1052` nema `+` → BigBit bi dao `1049-1050+1051-1052`. Zato je **izvesno** da
  `ZR_AOP_Modla.Definicija` te pozicije ima zagrade (npr. `A1049-(A1050+A1051+A1052)+A1053-A1054`).

**Praktična posledica:** ako formule **pišemo mi** iz obrasca, naš korektan parser je **prednost** —
ne treba reprodukovati BigBit-ovu grešku. Ako bismo ikad uvezli `Definicija` **verbatim**, treba
skenirati na podizraze bez `+` sa ≥2 `-` i ručno ozagraditi.

---

## 10. Traženje od knjigovođe — najviše 5 stavki (spremno za slanje)

> Zdravo Slaviša,
>
> Prelazimo završni račun na naš novi sistem i hteo bih da uporedimo brojeve sa tvojim, da ne bi
> bilo iznenađenja. Treba mi pet stvari — sve su brze:
>
> **1.** Izvoz tabele **`ZR_AOP_Modla`** (i, ako može, **`ZR_AOP_Pravila`**) iz BigBit ZR baze, u CSV.
> U Access-u: `Alt+F11` → `Ctrl+G` → nalepi i Enter:
> `DoCmd.TransferText acExportDelim,,"ZR_AOP_Modla","C:\ZR\ZR_AOP_Modla.csv",True`
> *(Ovo nam nije neophodno — obrasce možemo da napravimo iz Pravilnika 89/2020 — ali je najbrža
> provera da smo sve pozicije uzeli isto kao ti.)*
>
> **2.** Za pozicije koje na obrascu pišu **„(део)"** — grupa **49** se cepa na tri AOP-a:
> **0428** („49 (део), осим 498 и 495 (део)" — дугорочна ПВР), **0430** („495 (део)" — дугорочни
> одложени приходи) i **0454** („49 (део) осим 498" — краткорочна ПВР). **Koja konkretno analitička
> konta Servoteha idu u koju od te tri pozicije?** To se iz obrasca ne vidi, a po kontnom planu ne
> možemo da pogodimo.
>
> **3.** Jedan **XML fajl koji si stvarno uspešno uvezao u APR eFI** (bilo koja godina, BS ili BU) —
> samo kao uzorak formata, da naš izvoz bude 1:1.
>
> **4.** **Kojom veličinom je Servoteh razvrstan** (mikro / malo / srednje / veliko) za 2025. i
> planirano za 2026 — i da li se zbog toga menja komplet izveštaja koji predajemo.
>
> **5.** Za 2026: potvrdi da ti je i dalje dovoljan **zaključni list po kontu** (svedeno na 3 cifre,
> u hiljadama, sa odvojenim početnim stanjem) da uradiš završni — i reci u kom formatu ti najviše
> odgovara (Excel / CSV). Mi ćemo ga isporučiti iz novog sistema.

---

## Dodatak A — Inventar ZR objekata (šta postoji i gde)

**Upiti (svi u `BigBit_APL_2010.MDB`; puni SQL u
`_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/`):**

| Grupa | Upiti |
|---|---|
| Bruto stanje | `ZR_BrutoStanjeUpit`, `ZR_BrutoStanjeUpisiUTablicu_{Zaokruzeno,Nezaokruzeno}`, `ZR_BrutoStanjeObrisi`, `ZR_BrutoStanje_TG`, `PSPG_ZRBrutoStanje` |
| Modla → stavke | `ZR_PrepisiModlu`, `APGK_ZR_PrepisiModlu` |
| Popuna iznosa | `ZR_UpisiVrednostiIzBrutoStanjaUZRStavke_Iznos_{1,2,3}_{Zaokruzeno,Nezaokruzeno}`, `PSPG_ZR_UpisiVrednostiIzBrutoStanjaUZRStavke_Iznos_3_{Zaok,Nezaok}`, `APGK_ZR_UpisiVrednostiIzBrutoStanja` |
| AOP-iz-AOP | `ZR_UpisiVrednostiuIzAOPUZRStavke_Iznos_{1,2,3}`, `PSPG_ZR_UpisiVrednostiuIzAOPUZRStavke_Iznos_3` |
| Poništavanje | `ZR_PonistiVrednostiUZRStavke_Iznos_{1,2,3}` |
| Prethodna godina | `ZR_Stavke_PG`, `ZR_UpisiuPGizZR` |
| Pravila | `ZR_ProveriPravila`, `ZR_PravilaUpisiTrue` |
| Izvoz / štampa | `ZR_StavkeZaExport`, `ZR_StavkeZaExport_15032015`, `ZR_BS`, `ZR_BU`, `ZR_SI` |
| Komitenti | `ZR_PrepisiKomitenteIzCFG`, `ZR_PrepisiKomitenteIzCFG_STR`, `APGK_ZR_UpisiKomitenteIzRF` |
| SI deo II (bruto/ispravka/neto) | `ZR_UpisiVrednostiIznos3UIznos1ZaGrupu606` |

**Forme:** `ZR_Start`, `ZR_UnosZaglavlja`, `ZR_UnosStavki`, `ZR_UnosStavki_SA_NematerijalnaUlaganja`,
`ZR_UnosBrutoStanja`, `ZR_UnosBrutoStanjaStavke`, `ZR_UnosKomitenata`, `ZR_AOP_Modla`,
`ZR_AOP_Pravila`, `ZR_NezadovoljenaPravila` (+ `APGK_ZR_AOP_Modla`, `APGK_ZR_UnosStavki`).
**Izveštaji:** `Zr_BS`, `Zr_BU`, `Zr_SI` — potpuno data-driven
(`OnLine_BigBit_Design/APL_2010/ZR_BS.txt`: `RecordSource="ZR_BS"`, `ControlSource="Pozicija"`,
`"GrupaKonta"`, `"AOP"`, `"=NulaBlanko([Iznos_1])"` — nijedan AOP nije u dizajnu izveštaja).

## Dodatak B — Redosled izvršavanja (jedan ZR ciklus)

Iz `Form_ZR_UnosZaglavlja` (`DugmePopuniVrednostiZRStavke_Click`):

1. `PrepisiModlu` → `ZR_PrepisiModlu` (kopira nedostajuće AOP redove iz modle u `ZR_Stavke`)
2. pročitaj `ZR_BrutoStanjeZaglavlje.ZaokruzenoNa1000` → biraj `_Zaokruzeno` / `_Nezaokruzeno` set
3. `..._Iznos_1`, `..._Iznos_2`, `..._Iznos_3` (formule nad bruto stanjem, `Definicija NOT LIKE "A*"`)
4. `PSPG_..._Iznos_3` (prethodna godina, `ClTg=False`)
5. **7 iteracija** `ZR_UpisiVrednostiuIzAOPUZRStavke_Iznos_1` + `UpisiKodekseUAOP`, pa isto za
   `Iznos_2` i `Iznos_3` (`For i = 1 To 7`) — konvergencija ugnježđenih `A→A→A` referenci
6. `UpisiKodekseUAOP` — jedini hardkodirani AOP-ovi u kodu:
   `9001 = BrojMeseciPoslovanja`, `9002 = VrstaSvojine`, `9005 = BrojZaposlenih`
   (poklapa se sa Statističkim izveštajem Servoteha: 12 / 2 / 79)
7. `ZR_ProveriPravila` → forma `ZR_NezadovoljenaPravila`
8. `DugmeExportXML` → tri fajla `_BS.xml`, `_BU.xml`, `_SI.xml` → `RIApp.exe` (APR)

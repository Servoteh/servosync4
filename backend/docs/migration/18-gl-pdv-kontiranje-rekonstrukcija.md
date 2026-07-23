# GL / PDV / kontiranje — rekonstrukcija poslovne logike iz legacy izvora (Korak 0)

> **Status:** ANALIZA (2026-07-18, multi-agent nad `_legacy\`). **Korak 0 iz ROADMAP §4.0 — koji je
> važio za „najveći skriveni trošak" — je ovim najvećim delom URAĐEN**: imenovani Access upiti su
> locirani i izvučeni direktno iz binarnih `.mdb` kontejnera (DAO, read-only, uz `BIGBIT.MDW`).
> Ništa u legacy fajlovima nije menjano.
>
> Nadgrađuje: [BB_T_26_klaster_C_finansije-pdv-gk.md](BB_T_26_klaster_C_finansije-pdv-gk.md) (model),
> [09-bigbit-online-domain-map.md](09-bigbit-online-domain-map.md) (VBA mapa). Inventar kontejnera:
> [19-legacy-kontejneri-inventar.md](19-legacy-kontejneri-inventar.md).

## 1. Topologija — gde koja logika ŽIVI (razrešeno)

Tekstualni izvoz `Izvoz\` pokriva SAMO tehnološku aplikaciju (QBigTehn_APL) — zato raniji dokumenti
knjižnu logiku vode kao gap. Stvarna raspodela (sve tri baze SU na disku u `_legacy\BigbitRaznoNenad\`):

| Kontejner | Uloga | Ključna logika |
|---|---|---|
| `OnLine_BigBit_APL.MDB` (99 MB, **4.173 upita**) | komercijala/knjigovodstvo front | **`NSK_*` knjiženje naloga**, **`PDV_Uknjizi*`** (IF/UF/USLUGE/GK/VanPDV), `PDV_Obracun_*`, KEPU/TK upiti, `PREB_*` |
| `BigBit_APL_2010.MDB` (117 MB, **5.236 upita**) | APGK/knjigovodstvo | **POPDV engine** (`POPDV_DEF`, `POPDV_PopuniVrednostiUTmp`, sekcijski izveštaji `POPDV_010R…110R`) + duplikat `PDV_Uknjizi*` |
| `BB_T_26.mdb` / `BB_T_25.MDB` | podaci | tabele (uklj. `Sema za kontiranje`, `R_Tarife` sa stvarnim redovima) |

Delimična ekstrakcija već postoji u `_legacy\BigbitRaznoNenad\_extracted\` (OnLine VBA 824 fajla +
**2.412 upita** u `_extracted\queries\`).

## 2. GL posting — rekonstruisano (~45–50%)

### 2.1 Model podataka (pun DDL u `_analiza/bigbit/BB_T_26_schema.sql`)

- **`T_Nalozi`** (l.1548) — temeljnica: `IDNaloga` PK, `Broj naloga`, `Vrsta naloga`→šifarnik,
  `Datum knjizenja`, `Zakljucano`, `Godina`, audit.
- **`T_Glavna knjiga`** (l.1350) — stavke: `Konto`, `Analiticka sifra` (komitent), `Duguje/Potrazuje`
  (+ `DevDuguje/DevPotrazuje/DevValuta`), `IDNaloga`, **poreklo dokumenta** (`IDDokIzRobnog`,
  `IDDokIzUsluga`, `IDDokMP`, `IDCM_Ulaz/Izlaz` — novije, van ovog DDL snimka), `Povezan` (otvorene
  stavke), `Pozicija` (mesto troška), `IDPredmet`, `IDRadniNalog`.
- **`Sema za kontiranje`** (l.1205) + **`Stavke seme za kontiranje`** (l.1245): red šeme = `Konto` +
  **`DefDug`/`DefPot` formule sa slovima A–Z** + `Analitika` + `KngSifra_2` (alternativni konto po
  knjigovodstvenoj grupi artikla). Šema je vezana za `Vrsta naloga`.
- **`R_Vrste dokumenata`** (l.2679) — **centralna posting konfiguracija**: `Sema za kontiranje` (IDSeme),
  `Analiticki konto`, `Knjiziti analitiku/sintetiku`, `KnjizitiUPDVEvidenciju`, `KnjizitiTKZad/Razd`,
  `KEPUDefZaduzenje/Razduzenje`, `UticeNaZalihe`, numeracija.
- Kontni planovi: `Kontni plan` (l.442, sa `Dozvoljen unos analitike`, `Fajl sifara`), `KontniPlan_STD`,
  `InoKontniPlan`. PDV mostovi: `PDV_SemeKontaZaKnjizenje` (l.809) → `T_PDV_GK`;
  `POPDV_SemeKontaZaKnjizenje` (l.829) → `T_POPDV_GK`.

### 2.2 Algoritam (iz VBA, citati = `Izvoz\`)

1. **Dokument → nalog:** pri kreiranju dokumenta `[Broj naloga] = ObrniDatum(Datum)` = `YYMMDD` —
   **jedan nalog po vrsti dokumenta po danu** (`VBA\BBKreiranjeDokumenata.bas:54,262,407`;
   `LIB_GlobalniModul.bas:392-402`).
2. **`KreirajNalogGK`** (`BBKreiranjeDokumenata.bas:507-562`): INSERT u `T_Nalozi`; ručna numeracija
   `1 + DLookup(BrojNalogaPoVrstama)` left-pad 4; novije `SledeciBrojDokumenta`/SQL `fsSledeciBrojDokumenta`.
3. **Mehanika šeme — evaluator `VredIzraza(Izraz, A..Z)`** (`VBA\SemaZaKontiranje.bas:4-53`): slova u
   `DefDug`/`DefPot` zamene se vrednostima iz dokumenta pa `Eval`. Značenja za kalkulaciju (komentari
   u kodu): A=nabavna neto, B/C=zavisni trošak (sopstveni/dobavljač), D=ukalk. razlika u ceni, E/H=plaćen
   porez dobavljaču, F=taksa, G=kalkulativna VP, I=ostvarena VP, J=porez iz fakture, K=kalkulativni porez.
   Mapiranje slova je **kontekstno po vrsti posla** (KEPU: `NKEPU.bas:6-9`).
4. **Izvedeno PDV/POPDV knjiženje po GK stavci:** `OsnovicaPoPDVSemi`/`PDVPoPDVSemi`
   (`Moduli_Tekst\APGK.txt:98-143`) — flag `PDVOsnovica` bira smer (osnovica→PDV ili PDV→osnovica);
   POPDV kolone `POPDV_VrednostKoloneZaKnjizenje` (`VBA\POPDV_Module.bas:175-216`), upis kroz
   `POPDV_ProknjiziStavkuGKPoSemi` (idempotentno po `StavkaID+PDVOznaka`).
5. **Status „proknjižen" je IZVEDEN, ne flag** — dokument je proknjižen ako postoji GK stavka sa njegovim
   ID-jem u koloni porekla (`APGK.txt:144-171`). Zaključavanje odvojeno: `T_Nalozi.Zakljucano` +
   auto-lock starijih od N dana (`Moduli_Tekst\Zakljucavanje.txt:26-121`).
6. **Bilansni izveštaji:** `GKEval.bas:19-154` — rekurzivni parser izraza `D202* + P433* - PSD021*`
   (D/P=promet, PSD/PSP=početno stanje, Like-maske konta).

### 2.3 Šta GL-u još fali

- **Orkestracija automatskog kontiranja dokumenata** (`NSK_Knjizenje`, `NSK_ProknjiziStavkeIzRobnog`,
  `NSK_OtvoriNalogeIzRobnog`…) — locirana u `OnLine_BigBit_APL.MDB` (forme `NSK_Knjizenje`, „Unos naloga
  glavne knjige"), **tela još nisu dumpovana**. Modul `Kontiranje.bas` u tehnološkom APL-u je prazan torzo.
- **Sadržaj tabela** `T_Sema za kontiranje`/`T_Stavke seme za kontiranje` — formule DefDug/DefPot su
  PODACI; dump iz radne baze pokriva veliki deo preostale logike.
- Tela SQL Server procedura: `spDuplirajStavkuGK`, `spKreirajVirmanIzStavkeGK`, `spZakOtk`,
  `fsSledeciBrojDokumenta` (samo potpisi u VBA).
- Knjiženje izvoda banke i blagajne — ništa nađeno u tekst-izvozu.

## 3. PDV / POPDV / KEPU — rekonstruisano (~80%)

### 3.1 Stope — `R_Tarife` (stvarni redovi izvučeni iz `BB_T_25.MDB`)

Efektivna stopa = **ZBIR 5 kolona** (osnovna/železnička/gradska/ratna/posebna — pred-PDV nasleđe;
upit `PDVZbirneStope`). Datumsko važenje = **različite šifre tarifa sa ne-preklapajućim opsezima**
(18→3 na 01.10.2012, 15→5), NE istorija iste šifre:

| Tarifa | Stopa | PDVGrupa | Važi od–do |
|---|---|---|---|
| 3 | 20% | VISA | 01.10.2012– |
| 4 | 10% (u koloni „Zeleznica"!) | NIZA | 01.01.2005– |
| 5 | 8% | POLJO | 01.10.2012– |
| 0/1 | 0% | VANPDV/BEZPDV | 01.01.2005– |

Uz to **VBA rate-resolver sa hardkodovanim pragovima** (`PDV_Modul.txt:10-45`): `F_PDV_VisaStopa` —
grupa pobeđuje datum; datum ≤30.09.2012→18 inače CFG default 20; `F_PDV_NizaStopa` <01.01.2014→8 inače 10.
⚠️ Za 4.0: obavezna prava effective-dated tabela (batch-update `PromeniPoreskeStope*` gubi istoriju).

### 3.2 KIF/KUF punjenje (upiti IZVUČENI iz `OnLine_BigBit_APL.MDB`)

Lanac za izlazne: `PDV_Obracun_IF_1Korak` (po stavci: osnovica=Σ količina×StvarnaVP, PDV po zbiru
tarifa) → `PDV_Obracun_IF` (po dokumentu, kroz rate-resolver, razbijanje na VISA/NIZA/NULA) →
**`PDV_UknjiziIzRobnog_IF`**: `INSERT INTO PDV_IF … LEFT JOIN PDV_IF WHERE IDDokIzRobnog Is Null AND
R_Vrste dokumenata.KnjizitiUPDVEvidenciju=True` — **idempotentno**, filtrirano vrstom dokumenta.
Ulazne analogno + **`_UF_VanPDV`** tok: komitent `PDVStatus=2` (van PDV) → cela vrednost u
`NabVredVanPDV` (nema odbitka). Iz usluga: `PDV_UknjiziIzUSLUGA_IF/UF`. Iz GK: `PDV_UknjiziIzGK_IF/UF`
(okidači `Doc__Form_PDV_IF.txt:278-392`).

### 3.3 POPDV — POTVRĐENO: engine u `BigBit_APL_2010.MDB`, metadata-driven

Obrazac je **deklarativan** — tabela `POPDV_DEF`: red = `PDVOznaka` („3.1", „8e.5"…), do 4 kolone
K1–K4, svaka ILI direktna vrednost ILI **formula `KxDef`** (Eval nad drugim oznakama, npr.
`[3.10K2]+[4.1.4K2]`), `KxAOP` za agregaciju u PPPDV. Orkestracija u `POPDV_Module.txt`:
`POPDVPripremiTMPZaObrazac` (117-172) → `POPDV_StavkeZaTMP` (RIGHT JOIN na `POPDV_DEF`) →
**rekurzivni Eval engine `POPDV_VrednostIzrKolone`** (216-354) → AOP agregacija (379-419).
Knjiženje konto→POPDV kolona: `POPDV_SemeKontaZaKnjizenje` (formule D/P po kontu).

**Posledica za 4.0: POPDV se NE gradi „od nule"** — port = `POPDV_DEF` sadržaj + deklarativni
evaluator. Klasa `Class__POPDV_Class` u OnLine bazi je samo launcher eksterne app (domain-map:117).

**`POPDV_DEF` IZVUČEN (18.07)** — iz `BB_POPDV_T.mdb` (verzija „Novi POPDV" 1.0.0, 18.06.2018;
`_extracted\rule_tables\BB_POPDV_T\`). **164 reda = ceo obrazac**, 18 aktivnih kolona: `Rbr, Sekcija,
Header, PDVOznaka, Opis, K1Def..K4Def, BrojKolona, K1Val..K4Val, K1AOP..K4AOP, AktivneKolone`.
- `PDVOznaka` = polje obrasca (1.1, 3.10, 5.7, 8ђ, 9а.1, 10…); prost red → placeholder `[1.1K1]`,
  zbirni red → formula: `1.5 = [1.1K1]+[1.2K1]+[1.3K1]+[1.4K1]`, `10. = [5.7K1]-[9а.4K1]`.
- `KxAOP` = AOP šifra za PPPDV, samo na zbirnim redovima (`1.5→001`, `5.7→105`, `10.→110`…).
- `AktivneKolone` = bitmaska koje su kolone aktivne (`1000`=samo K1, `1111`=sve 4, `0101`=K2+K4).
- 23 sekcije (`POPDV_DEF_H` daje nazive); najveće: 031 (25 redova) i 081 (23).
→ POPDV engine = učitaj `POPDV_DEF` + Eval `KxDef` nad ćelijama + agregacija po `KxAOP`. **Deklarativno,
1:1 iz podatka.**

### 3.4 KEPU / Trgovačka knjiga — rekonstruisano end-to-end; ✅ KEPU U SCOPE-u 4.0

Tokovi izvučeni (`TK_KEPU_MP.txt:3-354` + upiti `Dokumenta koja nisu uneta u KEPU`, `Vrednosti po
dokumentima za KEPU` — idempotentni LEFT JOIN obrazac, KalkMP/StvarnaMP formule, `F_TrgovackaPoKursu`).
**Istorija odluke (18.07):** prvo precrtano na glavnom meniju kao nekorišćeno, pa **isto veče
revidirano — KEPU knjiga je zakonski obavezna → VRAĆENA u 4.0 scope** (veleprodajna; `KEPU_MP`
ostaje van jer se maloprodaja ne radi). Rekonstrukcija ~90% direktno upotrebljiva za port.
Validaciju regulatornog izlaza radiće knjigovođa-konsultant (vidi ANALIZA_PROCENA §5).

### 3.5 PPPDV (~55%)

`PDV_PPPDV` tabela = kompletna prijava (AOP parovi osnovica/PDV); forma `PDV_FormaPPPDV`.
⚠️ Neprovereno mapiranje „nulta stopa → sa/bez prava na odbitak" (domain-map:113); agregacioni
upiti KIF/KUF→AOP nisu ciljano izvučeni.

## 3.6 NSK posting engine + POPDV upiti — IZVUČENO (18.07)

Kompletna orkestracija auto-kontiranja izvučena iz `.mdb` (`_extracted\queries_full\`), zatvara
raniju rupu §2.3 (bila ~15%):
- **`NSK_SemaZaDok`** — vrsta dokumenta → šema (Konto/DefDug/DefPot); **`NSK_VrednostiPoSemiZaKnjizenje`**
  — agregacija Duguje/Potrazuje po šemi; **`NSK_StavkeZaKnjizenje`** — spajanje sa nalogom+RN/predmetom;
  **`NSK_ProknjiziStavkeIzRobnog`** — INSERT u `T_Glavna knjiga`. → NSK = generički posting engine 1:1.
- **PDV uknjiženje** izvučeno: `PDV_Obracun_IF/UF` (razvrstavanje po stopi VISA/NIZA/POLJO/0),
  `PDV_UknjiziIzGK_IF/UF`, `PDV_UknjiziIzRobnog_IF/UF/IFMP`, `PDV_Obracun_UFUSL`/`_IFUSL_ZaAvansneRacune`.
- **POPDV paket (~35 upita, samo `BigBit_APL_2010.MDB`):** `POPDV_StavkaGKPoSemi`/`ProknjiziStavkuGKPoSemi`
  (→ `T_POPDV_GK`), `POPDV_PopuniVrednostiUTmp` (`POPDV_VrednostIzrKolone` — izvedena polja),
  `POPDV_Evidentiraj_Zag`, `POPDV_Neproknjizeno_Proknjizi`.
- **KEPU/GK:** `Dokumenta koja nisu uneta u GLAVNU KNJIGU`, `Proknjizi analitiku u GLAVNU KNJIGU`,
  `Vrednosti po dokumentima`, `Proknjizi u KEPU`, `ProknjiziUplateIzGKUKEPU`.

**Ključno:** POPDV/USL/avansna logika postoji SAMO u `BigBit_APL_2010.MDB` (ne u OnLine) — to je bio
neizvučeni deo; sada dumpovan. Ostaje još dump **sadržaja** `POPDV_DEF` i `Sema za kontiranje` tabela
(rule-tabele agent u toku) da formule budu podatak, ne samo upit.

## 3.7 Formule kontiranja kao PODATAK — IZVUČENO (18.07)

Sadržaj rule-tabela dumpovan iz `BB_T_26_11-07-26.mdb` (→ `_extracted\rule_tables\BB_T_26\*.csv`,
van gita). Sada su same formule podatak, ne samo upit:
- **`Stavke seme za kontiranje`** (105 redova) — DefDug/DefPot po kontu/šemi. Primeri:
  `3 (UFROB): 1320 dug=A+B+C · 2700 dug=D · 4350 pot=A+B+C+D+E`; `21 (VPTR): 20200 dug=O+P+Q ·
  60240 pot=O · 47000 pot=P`. `Sema za kontiranje` (30, IDSeme→Vrsta naloga: 3=UFROB, 36=IFGP, 42=DONAC).
- **`R_Vrste dokumenata`** (58) — vrsta dok → šema + flagovi. Primeri: `IFGP→šema 36, PDVEvid=True,
  UticeNaZalihe=True`; `IFR→33`; `IFUSL→30`; `AVR→0`.
- **`POPDV_SemeKontaZaKnjizenje`** (84) — konto+PDVOznaka → K1Def..K4Def (supstitut za POPDV_DEF).
  Primeri: `2700, 8а.2DA, D/0.2, D`; `2705, 8б.2, D/0.2`.
- **`Kontni plan`** (1389 konta), **`R_Tarife`** (8, sa vazi_od/do), `PDV_SemeKontaZaKnjizenje` (20),
  `Vrsta naloga` (117), šifarnici artikala `R_Grupa/Podgrupa/Poreklo/KvalitetArtikla` (rupa u syncu).

→ **Posting engine se sada može specirati 1:1 iz podataka** (šema po vrsti dok + DefDug/DefPot formule
+ kontni plan). Ovo diže GL orkestraciju sa ~15% na ~85%.

## 4. Preostalo za ~95%

1. ✅ ~~`POPDV_DEF` (definicija obrasca)~~ — **IZVUČENO 18.07** (Nenad doneo `BB_POPDV_T.mdb`; 164 reda,
   vidi §3.3). POPDV više nije blocker.
2. ✅ ~~sadržaj šema za kontiranje~~ — izvučeno (§3.7).
3. ✅ ~~`NSK_*` orkestracija~~ — izvučeno (§3.6).
4. ✅ ~~sekcijski izveštaji `POPDV_010R…110R`~~ — izvučeno (22/22, [20 §6](20-bigbit-stampani-dokumenti-katalog.md)).
5. Tela `sp*`/`fs*` sa SQL Servera (`vasa-SQL`) — `script.sql` metod iz [05](05-qbigtehn-sqlserver-logic.md).
6. Avansi (`T_AVR_*`) — obračunski upiti izvučeni (§3.6, `PDV_Obracun_IFUSL_ZaAvansneRacune`);
   alokacioni model u [23 §1.5](23-backlog-nedokumentovane-cacke.md).

## 5. Zbirna ocena pokrivenosti

| Podsistem | % | Napomena |
|---|---|---|
| GL model podataka | ~95 | pun DDL, sve posting tabele |
| GL primitivi (evaluatori, numeracija, status, lock) | ~70 | kod pročitan |
| GL orkestracija kontiranja (NSK_* + DefDug/DefPot formule) | **~85** | NSK upiti + šeme kao podatak izvučeni (§3.6/§3.7) |
| PDV stope + effective dating | ~95 | uklj. stvarne redove R_Tarife |
| KIF/KUF punjenje | ~90 | svi Uknjizi+Obracun upiti izvučeni |
| KEPU/TK | ~90 | **van scope-a 4.0** (Nenad 18.07) |
| POPDV | **~95** | engine+upiti+posting formule + **`POPDV_DEF` (164 reda, ceo obrazac)** izvučeni; ostaje samo test na demo/realnom periodu uz knjigovođu |
| PPPDV | ~55 | struktura jasna, agregacija neproverena |
| Avansi (AVR) | ~30 | samo tabele |

## Bezbednosna napomena

Zaštićene baze otvarane **read-only** (DAO + `BIGBIT.MDW`); kredencijali postoje u `_legacy\`
(`BIGBIT_accounts.csv`, `QBigTehn_APL\_PASSWORD_FOUND.txt`) koji je **van gita** — ne prepisuju se
u dokumentaciju. Ništa nije upisano ni menjano u legacy fajlovima.

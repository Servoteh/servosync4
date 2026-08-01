# Avansni računi (AVR) — kako Servoteh radi, šta propis traži, šta 4.0 mora da uradi

**Zadatak vlasnika, 27.07.2026:** *„AVR XX/27 automatski dodeljuje… za AVR isto detaljna analiza
mora da bude, kako ih pravimo i pišemo… vezani su za PDV direktno."*

Ovaj dokument je odgovor na to. Rekonstrukcija je rađena iz tri nezavisna izvora, i svaka tvrdnja
nosi odakle je:

| Oznaka izvora | Šta je |
|---|---|
| `[VBA]` | BigBit izvorni kod — `_legacy/BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/` (527 formi), `OnLine_BigBit_Design/` (498 upita/izveštaja), `_legacy/Izvoz/VBA/` |
| `[DB]` | Produkcijska baza — `BB_T_25.MDB` (presek 31.08.2025) i `BB_T_26.mdb` (kumulativna, 2008–2026), preko `mdbtools:local` na `ubuntusrv` |
| `[4.0]` | Naš kod — putanje su relativne na `backend/` u ovom worktree-u |
| `[PROPIS]` | ZPDV, Pravilnik o POPDV, Pravilnik o e-fakturisanju, mišljenja MF |

Prethodna studija: [`backend/docs/migration/BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md`](../backend/docs/migration/BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md).
Ovaj dokument je **produbljuje i na dva mesta ispravlja** (§0.1).
Numeracija dolazi iz [`ODLUKA_NUMERACIJA_DOKUMENATA.md`](ODLUKA_NUMERACIJA_DOKUMENATA.md) §1.

---

## 0. Rezime za nestrpljive

**Šta je AVR u BigBitu.** Nije zaseban modul. To je obična uslužna faktura kojoj je u padajućoj
listi izabrana vrsta „AVR", sa **tačno jednom stavkom** u koju knjigovođa upiše neto osnovicu
(bruto uplatu podeljenu sa 1,2). Nema svoju formu, nema svoj izveštaj za štampu, nema evidenciju
naplate, nema vezu na izvorni dokument osim slobodnog teksta. `[VBA]` `Doc__Form_USLUGA Faktura.txt`;
`[DB]` `T_Usluge dokumenta` — 1.398 AVR dokumenata 2008–2026, broj stavki po AVR = `Counter({1: 31})`
za 2025+2026.

**Zašto je „direktno vezan za PDV".** Zato što je avans jedini dokument kod koga poreska obaveza
nastaje **naplatom**, a ne prometom — i zato što se ta obaveza kasnije mora **stornirati** kad
stigne konačni račun, inače bi isti PDV bio prijavljen dvaput. Ceo taj lanac je §2.

**Gde smo mi.** 4.0 već ima avansni račun i suštinski je **tačniji od BigBita** (FK umesto stringa,
sekvenca sa row-lockom umesto `COUNT+1`, poreska stavka u istoj transakciji sa knjiženjem).
Ali imamo **jedan kritičan defekt u POPDV lancu** (§5.1 — storno na 4720 umesto na 47200 znači da
POPDV prijavljuje PDV avansa dvaput), **jedan bug koji obara PDV obračun meseca** (§5.2), i
**pet nedostajućih tokova** (§5.3).

**Šta vlasnik traži za numeraciju.** Format `77/27` — to je **Servotehov istorijski format
2016–2024**, ne izmišljotina. `AVR-00021/2025` koji BigBit danas daje je slučajna posledica
automatizacije uvedene 03.01.2025. Detalji §3.2.

### 0.1 Dve ispravke prethodne studije

1. **2025. ima 30 avansnih računa, ne 21.** `BB_T_25.MDB` je presek od 15.08.2025 i staje na
   `AVR-00021/2025`. Živa baza nastavlja: `AVR-00022/2025` (11.09.) … `AVR-00030/2025` (25.12.).
   Svi agregati po kontima za 2025. iz stare studije treba čitati kao „do sredine avgusta".
   **Za buduće analize koristiti `BB_T_26.mdb`** — ona sadrži sve godine. `[DB]`
2. **`AVR-00008/2025` nije „avans bez PDV-a".** To je knjigovodstvena greška od 152.120,00 RSD —
   dokument nosi tarifu 3 (20%), ali je pri naplati proknjižen samo `4300 POT 912.720,00`, bez
   `4720 POT 152.120,00`. Storno je ipak stavljen na 47200, pa je aprilska obaveza umanjena bez
   pokrića. Detaljno u §6.7. `[DB]` GK_25 StavkaID 111381, 114681, 114682

---

## 1. Kako Servoteh radi avanse — ceo tok rečima

### 1.1 Nastanak: kupac traži avans, ili mi tražimo

Kod Servoteha avans nastaje na **dva jasno razdvojena načina**, i to se vidi u iznosima:

**Mali avansi (medijana ~90.000 RSD) idu po ponudi ili profakturi.** Opis stavke glasi doslovno:
„Uplata 100% avansa po ponudi 0052-25/1, 3 kom El.mag.razvodnik", „Uplata 50% avansa po ponudi
0558-25, Zupč.lanac K…". `[DB]` `T_Usluge stavke.Opis`

**Veliki avansi idu po UGOVORU, nijedan po predračunu.** Dva avansa iz 2025. — `AVR-00001/2025`
(535.789.358,64) i `AVR-00017/2025` (535.922.487,65), oba komitent 1003239 (14. OKTOBAR d.o.o.) —
čine **95,6% ukupnog prometa avansa te godine** (1.071,7 od 1.121,1 miliona). Oba nose ugovor
samo u tekstu: „Avansna uplata 30% avansa po Ugovoru o kupoprodaji mašina i opreme za proizvodni
program". `[DB]`

> **Ovo je najvažniji poslovni nalaz za dizajn.** Ograničenje „avans se pravi samo iz predračuna"
> bi isključilo posao koji nosi 95% novca. Naš `createAdvanceWithoutSource` je zato **ispravna
> odluka**, ne kompromis. `[4.0]` `src/modules/sales/advance-invoice.service.ts`

**Rate istog ugovora su zasebni AVR dokumenti.** Termička linija ST-TO-14 (komitent 1003239,
predmet 10255) plaćena je kroz **četiri AVR-a preko dve godine**: `AVR-00027/2025` (27.11.),
`AVR-00028/2025` (05.12.), pa `AVR-00004/2026`, `AVR-00005/2026`, `0017-26`, `AVR-00006/2026`.
BigBit nema pojam „rata istog avansa" — svaka uplata je nov dokument. `[DB]`

### 1.2 Izdavanje: dokument se kuca tek kad novac legne

Ovo je centralna činjenica cele analize, i potvrđena je na **svih 31 AVR iz 2025+2026 bez izuzetka**:

```
Datum dokumenta  ==  Datum valute  ==  DatumPrometa
```

Zašto: zato što knjigovođa ne pravi avansni račun unapred — čeka izvod, vidi koliko je leglo, pa
tek onda otvori formu i otkuca dokument na taj dan. `[DB]` `T_Usluge dokumenta`, svih 31 zapisa

Postupak na ekranu `[VBA]` `Doc__Form_USLUGA Faktura.txt`:

1. `Dugme__Novi_dokumena_Click` → `DoCmd.GoToRecord , , A_NEWREC` (novi prazan slog), linija 216-230
2. iz kombo-liste `Vrsta dokumenta - lista` izabere **AVR** → `Vrsta_dokumenta____l_AfterUpdate`
   (linija 635-651) **tek tu dodeljuje broj** i postavlja `Vrsta naloga = 'AVANS'`
3. bira komitenta → `UzmiPodatkeIzKomitenta` povuče `Odlozeno` u `U roku dana`
4. upiše datum → `Datum_dokumenta_AfterUpdate` izračuna `Datum valute` i `Broj naloga`
   (`ObrniDatum` → `250523`)
5. u podformu upiše **jednu stavku**: količina 1, tarifa `3`, cena = **bruto / 1,2**
6. u `Opis` stavke otkuca osnov slobodnim tekstom

Napomena na dokumentu (`F_DefaultNapomena()` iz `Radni fajlovi.Napomena`) je **identičan tekst na
svih 1379 AVR**, i mesto prometa je `'Beograd'` na svih 1379. `[DB]`

### 1.3 Knjiženje naplate: ručno, iz izvoda

Vrsta dokumenta AVR u `R_Vrste dokumenata` ima `Sema za kontiranje = 0`, `KnjizitiUPDVEvidenciju = 0`,
`Knjiziti sintetiku = 0`. **Sam dokument ne proizvodi nijedan zapis.** Šema kontiranja `IDSeme=39`
(„AVANSNI RACUN") postoji i tačna je, ali je **orfan** — ništa je ne poziva. `[DB]` + `[VBA]`

Knjiženje radi knjigovođa rukom u nalogu vrste `IZVOD` / `IZV-E` / `DEVRN`. Provera: svih 20
knjiženih nastanaka na kontu 4720 u 2025. i svih 10 u 2026. sede u nalozima te vrste — **nijedan
u nalogu vrste AVR**. `[DB]` `T_Glavna knjiga × T_Nalozi`

Sve GK stavke avansa imaju `IDDokIzUsluga = 0` i `IDDokIzRobnog = 0` — **veza dokument ↔ knjiženje
ne postoji**. `Opis dokumenta` je `'-'`. Jedini spoj je otkucan broj dokumenta, i on je nepouzdan
(§6.8).

### 1.4 Odbijanje na konačnom računu

Na formi konačne fakture postoji tab (`TabCtlZaIF = 3`) sa podformom `AVR_Roba` / `AVR_Usluge`,
vezanom preko `IDDok`. Knjigovođa iz kombo-a `ComboIzabranAvans` izabere avans; filter je **samo**
`Sifra komitenta = kupac` i `Level <= Level fakture` — **bez** filtera po godini, po predmetu, po
„nezatvoren", po „naplaćen". `[VBA]` `Doc__Form_AVR_Usluge.txt:25-71`

Uslužna varijanta predlaže **preostatak** (`Column(4) − Nz(Column(7),0)`), robna predlaže **pun
iznos avansa** jer joj upit uopšte nema kolonu iskorišćenosti (ekvivalent postoji ali je isključen
— fajl nosi sufiks `_XXX`). `[VBA]` `Doc__Form_AVR_Roba.txt:30-40`, `USLUGAComboAVR_IskoriscenPDV_XXX.sql`

Konačni račun se knjiži u **punom bruto iznosu** — ništa se ne umanjuje. Odbitak avansa je
**zaseban nalog vrste `AVANS`**, istog dana. Na papiru se pojavljuje samo kao red „Razlika za
uplatu (RSD)". `[DB]` nalog `IFR/250128` vs `AVANS/0003`

### 1.5 Zatvaranje kroz vreme — nije mesec dana, nego godine

21 od 71 veze avans↔faktura **prelazi granicu godine**. Rekordi `[DB]`:

| Avans | Izdat | Zatvoren | Razmak |
|---|---|---|---|
| `16/23` | 03.03.2023 | IFGP 144/25, 19.03.2025 | 2 god. 16 dana |
| `031/24` | 13.06.2024 | 13 faktura, 15.05.–09.07.2026 | 2 godine, i **još otvoren** |
| `58/23` | 27.10.2023 | delimično IFUSL 395/24; 34.166.087,08 **još otvoreno 01.01.2026** | 2+ god. |
| `AVR-00029/2025` | 25.12.2025 | IFGP 171/26, 15.06.2026 | 6 meseci, **preko granice godine** |

**Poreska posledica:** 4720 se puni u mesecu naplate i prenosi na 4790 mesečnim nalogom; storno na
47200 ulazi u obračun tek u mesecu konačne fakture — **razmak do dve godine**. Sistem koji
pretpostavlja da se avans zatvara „uskoro" ovde ne radi.

### 1.6 Otvoreni avansi na 31.12.2025 — 2,4 milijarde

Iz `PS` (početno stanje) redova konta 4300 u `BB_T_26.mdb` — **17 stavki**: `[DB]`

```
bruto      2.397.119.895,52
osnovica   1.997.599.912,90
PDV          399.519.982,62      (odnos tačno 1/6 — potvrda da je sve po 20%)
```

Najveći: `031/24` Jugoimport 792.099.970,36 · `AVR-00001/2025` 535.789.358,64 ·
`AVR-00017/2025` 535.922.487,65 · `030/24` i `U0045-24` Kovački centar po ~122 miliona.

Od 30 avansa izdatih u 2025. na kraju godine je **otvoreno 7**.

---

## 2. PDV lanac — srž dokumenta

### 2.1 Kada nastaje obaveza — propis

**Zakon o PDV, čl. 16:** poreska obaveza nastaje danom kada se **najranije** izvrši jedna od
radnji: 1) promet dobara i usluga; 2) **naplata, odnosno plaćanje, ako je naknada ili deo naknade
naplaćen u novcu pre prometa**. `[PROPIS]`

Dve dopune koje menjaju sliku, a nisu bile u prethodnoj studiji:

- **Naplata mora biti U NOVCU.** Avans u robi ili kroz kompenzaciju **ne** pokreće obavezu po
  čl. 16 t. 2.
- **Kod prenosa poreske obaveze na primaoca** (čl. 10 st. 2 — građevinarstvo, otpad) izdavalac
  **ne obračunava PDV po avansu**; Pravilnik o PDV čl. 166 ga oslobađa i obaveze izdavanja
  avansnog računa. Obavezu interno obračunava primalac. To je konto 47250/27250 — §6.9.

**BigBit ovo poštuje** (§1.3), ali ručno, i to je već proizvelo grešku od 152.120 RSD (§6.7).

### 2.2 T-konta — pun ciklus jednog avansa, sa stvarnim iznosima

Primer je `AVR-00002/2025` → `IFR 045/25/1`, komitent 11745. Svi iznosi doslovno iz glavne knjige.
Avans: bruto **47.899,50** = osnovica 39.916,25 + PDV 7.983,25. `[DB]`

---

**KORAK 0 — izdavanje AVR-a, 14.01.2025**

```
(nijedno knjiženje — dokument nema šemu kontiranja)
```

**KORAK 1 — naplata, nalog `IZVOD/0007` od 14.01.2025** ← *ovde nastaje poreska obaveza*

```
              KONTO                          DUGUJE        POTRAŽUJE
2410   tekući račun                        47.899,50
4300   primljeni avansi (an=11745)          7.983,25       47.899,50
4720   PDV po primljenim avansima 20%                       7.983,25
```

> **Obrati pažnju na 4300.** BigBit knjiži **bruto potražno i PDV dugovno u istom redu**. Saldo je
> neto (39.916,25), ali kartica pokazuje **koliko je novca stvarno primljeno**. Mi to radimo
> drugačije i gubimo tu informaciju — §5.4.

**KORAK 2 — poreska evidencija**

```
T_PDV_GK:    IFAV-OPSTA, stopa 20, PDVIznos 7.983,25, PDVOsnovica 39.916,25   → PP-PDV AOP 103
T_POPDV_GK:  polje 3.9 → K2 = 7.983,25   (od 2026. i K1 = 39.916,25)
```

**KORAK 3 — mesečni nalog `PDV/0001` od 31.01.2025**

```
4720                                    89.314.317,19        (svi januarski avansi)
4790   obaveze za PDV                                      79.877.565,74
```

**KORAK 4 — konačni račun `IFR 045/25/1`, nalog `IFR/250128` od 28.01.2025** — *pun bruto,
ništa umanjeno*

```
2040   kupci u zemlji (an=11745)          47.899,50
4702   PDV po izdatim fakturama 20%                        7.983,25
6040   prihod                                             39.916,25
5010 / 1320   nabavna vrednost            15.963,05        15.963,05
```

**KORAK 5 — zatvaranje avansa, ZASEBAN nalog `AVANS/0003` od 28.01.2025** *(isti dan, isti broj
dokumenta)*

```
4300   primljeni avansi (an=11745)        −7.983,25       −47.899,50
47200  PDV po avansima — POKRIVANJE                       −7.983,25
2040   kupci                                              47.899,50
```

Rezultat: saldo kupca 0, saldo 4300 na tom avansu 0, 47200 nosi dugovni efekat +7.983,25.

**KORAK 6 — mesečni nalog `PDV/0001` (isti januar)**

```
47200                                    −159.897,27        (u tome i naših −7.983,25)
```

### 2.3 POPDV — koja polja, kada, i zašto se ne duplira

**Mapa `POPDV_SemeKontaZaKnjizenje`, i njena promena 2025 → 2026** `[DB]`:

| Konto | Polje | 2025 (K1 / K2) | 2026 (K1 / K2) |
|---|---|---|---|
| `4720` PDV po primljenim avansima 20% | **3.9** | *(prazno)* / `P` | **`P/0.2`** / `P` ← dodata osnovica |
| `47200` pokrivanje avansa | **3.2** | *(prazno)* / `P` | *(prazno)* / `P` |
| `4721` PDV po vraćenim avansima | **3.6** | *(prazno)* / `P` | *(prazno)* / `P` |
| `4730` avansi 10% | **3.9** | `P/0.1` (K3) / `P` (K4) | isto |
| `47250` interni obračun građevinarstvo | **3а.8** | — *(ne postoji)* | **`P`** ← novo |

**Zašto to nije dupli obračun prometa.** Iz `POPDV_DEF_APL`: `[DB]`

```
3.8  = 3.1 + 3.2 + 3.3 + 3.4 + 3.5 + 3.6 + 3.7      ← 3.9 NIJE u zbiru
3.10 = 3.8 + 3.9
5.1  = 3.8K1 + 4.1.1K1 + 4.2.1K1  → PP-PDV AOP 003  ← BEZ 3.9K1
5.2  ← 3.10K2                      → PP-PDV AOP 103
```

Dakle **osnovica avansa u 3.9 K1 je informativna** (ne ulazi u ukupan promet), a **PDV avansa
ulazi u obavezu**. To potvrđuje i `PDV_Knjige`: `IFAV-OPSTA` ima `AOPOsnovica='-'`,
`AOPIznosPDV='103'`. `[DB]`

**Računica kroz životni ciklus** (isti avans, 7.983,25):

| Period | Polje | Iznos |
|---|---|---|
| mesec naplate | 3.9 K2 | **+7.983,25** → ulazi u AOP 103 |
| mesec fakture | 3.2 K2 (konto 4702, pun PDV računa) | **+7.983,25** |
| mesec fakture | 3.2 K2 (konto 47200, storno avansa) | **−7.983,25** |
| | **prijavljeno ukupno** | **7.983,25 — tačno jednom** ✔ |

Osnovica: 3.2 K1 dobija +39.916,25 (pun promet), 3.9 K1 dobija +39.916,25 ali se ne sabira u 3.8
→ AOP 003 nosi 39.916,25 jednom ✔.

> **Zato 47200 NEMA K1Def.** Da ga ima, oduzeo bi osnovicu iz 3.2 i AOP 003 bi bio potcenjen za
> iznos avansa. Asimetrija je namerna i ispravna.

Agregat iz produkcije 2025 `[DB]` `T_POPDV_GK`:

```
3.2 | 4701  | K1 545.037.518,20 | K2 109.007.503,64
3.2 | 4702  | K1  18.221.103,20 | K2   3.644.220,64
3.2 | 4703  | K1  17.286.399,60 | K2   3.457.279,92
3.2 | 47200 | K1           0,00 | K2 −80.915.464,04   ← storno, samo PDV
3.9 | 4720  | K1           0,00 | K2 178.876.621,88
```

### 2.4 Pravilo istog perioda — propis ga ima, BigBit ga nema, mi ga nemamo

**`[PROPIS]` Korisničko uputstvo za Obrazac POPDV, tačka 3.9:**

> „U polju 3.9 **ne iskazuju se** podaci o primljenom avansu ako je u **istom poreskom periodu**
> izvršen i promet dobara i usluga za koji je avans primljen."

Tada se sve iskazuje samo u 3.2 (puna osnovica + pun PDV), jednom.

**BigBit ovo ne primenjuje.** 4720 se knjiži pri svakoj naplati bez obzira na to da li je promet u
istom mesecu; januar 2025. ima i `AVR-00002/2025` u 3.9 (+7.983,25) i njegov storno u 3.2
(−7.983,25) — a promet je bio 28.01., isti mesec. **Iznos obaveze je tačan, prijavljena polja nisu.**
`[DB]`

Zanimljiva potvrda: u kontnom planu **postoji konto `4729` „PDV po primljenim avansima zatvaranje
u istom periodu"** — tačno za ovaj slučaj. Ima **0 knjiženja** u obe godine i nije mapiran ni u
jednoj POPDV šemi. Neko je znao za pravilo, konto je otvoren, i nikad nije upotrebljen. `[DB]`

**Naša preporuka:** implementirati potiskivanje para `4720`/`47200` unutar istog perioda **u POPDV
motoru**, ne u avansnom servisu. Glavna knjiga treba da ostane doslovna (svaki događaj svoj red);
obrazac je taj koji ima pravilo. Otvoreno pitanje za knjigovođu — §8, P1.

### 2.5 Mesečni nalog 4720 → 4790

Formula, verifikovana **do para** na januaru 2025: `[DB]`

```
4790 POT = Σ(izlazna konta 47xx, DUG) − Σ(ulazna konta 27xx, POT) ± zaokruženje (5799/6790)
```

```
IZLAZ (DUG):  4701   290.877,26   4702   430.806,81   4703   552.591,82   4705   220.000,00
              4720 89.314.317,19  ← PDV PO AVANSIMA ULAZI U OBAVEZU TOG MESECA
              47200  −159.897,27  ← pokrivanje avansa SMANJUJE obavezu
              zbir 90.648.695,81
ULAZ  (POT):  2700 4.532.417,40   2705 220.000,00   2710 13.040,02
              2720 6.203.211,37   ← pretporez po DATIM avansima
              27200 −1.150.706,51 ← zatvaranje datih avansa
              2730 −6.900,00      2740 960.069,35
              zbir 10.771.131,63

90.648.695,81 − 10.771.131,63 = 79.877.564,18  + 5799 DUG 1,56 = 79.877.565,74 = 4790 POT ✔
```

Kontrola potpunosti prenosa 4720 → 4790 po mesecima 2025: 01, 02, 03, 05, 06, 07 — **svi se
poklapaju do para**; 08 nedostaje jer je snimak od sredine avgusta. Mehanizam je egzaktan. `[DB]`

**Mi ovaj nalog nemamo** — §5.3.

### 2.6 Ulazna (dana) strana — ogledalo

| Konto | Uloga | POPDV | Okidač |
|---|---|---|---|
| `2720` | PDV po datim avansima 20% | 8а.7DA | **plaćanje** (nalozi IZVOD/IZV-E: 228 od 385 stavki) |
| `27200` | zatvaranje datih avansa | 8а.2DA | prijem konačne fakture dobavljača (nalog NALOG) |
| `2730` / `27300` | pandani po 10% | — | — |
| `27250` | interni obračun građevinarstvo | 8б.7 | plaćanje avansa izvođaču |

Pravilo je **potvrđeno**: zatvaranje datog avansa se **nikad** ne knjiži nazad na 2720, nego na
zasebno konto 27200 — sve 27200 stavke su negativne dugovne. Uzorci: `PA-12/24` an=1003629
−1.044.933,12; `av-122/2024` an=1002524 −14.928,00. Brojevi dokumenata su brojevi **dobavljačevih**
avansnih računa. `[DB]`

### 2.7 KIF/KUF i PP-PDV kod Servoteha ne postoje

Prebrojano u obe baze: `[DB]`

```
T_PDV_IF (KIF)   = 0 redova     T_PDV_UF (KUF)  = 0 redova     PDV_PPPDV = 0 redova
T_POPDV_EvidentiranePrijave_Zag = 7 (2025) / 6 (2026)   ← POPDV je jedina živa evidencija
```

Postoje dva **izvedena** registra iz GK, i pokrivenost pokazuje koji je živ:

| Konto | u `T_PDV_GK` (PP-PDV grana) | u `T_POPDV_GK` (POPDV grana) |
|---|---|---|
| 4703 | **0** od 95 stavki | 82 |
| 4702 | 7 od 359 | 320 |
| 47200 | **1** od 44 | 35 |
| 4720 | 27 od 27 | 19 |

Razlog: oba registra se pune **ručnom akcijom** na ekranu APGK
(`APGK_PDV_Provera_UpisiUPDVEvidenciju`), pa šta uđe zavisi od filtera koji je knjigovođa otkucao.
PP-PDV grana je praktično zapuštena. `[VBA]` + `[DB]`

> Odgovor na pitanje „kako avans ulazi u KIF": **ne ulazi — KIF ne postoji.** Ulazi u POPDV polje
> 3.9 preko konta 4720. Naš pristup (KIF/KUF se deterministički izvode iz GK, u istoj transakciji)
> je strukturno bolji i ovde nema šta da se preslikava.

### 2.8 Formula: osnovica se rekonstruiše iz PDV-a — i to pravi razliku od 1 pare

`[VBA]` `Module__APGK.txt:42-87`:

```vba
If DugPot Then Iznos = Duguje Else Iznos = Potrazuje
If PDVOsnovica Then
   Osnovica = Round(Iznos, 2) : PDV = Round(Osnovica * (PDVStopa/100), 2)
Else
   PDV = Round(Iznos, 2)     : Osnovica = Round(PDV / (PDVStopa/100), 2)
End If
```

Za 4720 je `PDVOsnovica = 0` → ide **druga grana**: PDV = potražni promet, **osnovica se deli iz
PDV-a**.

Posledica: **BigBit sam sa sobom nije saglasan.** `AVR-00017/2025` nosi na dokumentu osnovicu
446.602.073,0417, a poreska evidencija prijavljuje 446.602.073,05. Razlika 0,01. Isto na
`AVR-00009/2025` (215.663,82 vs 215.663,80) i `AVR-00006/2026` (103.001.358,57 vs 103.001.358,55).
`[DB]`

**Naša preračunata stopa daje ISTI PDV** — provereno na dva najgora produkcijska slučaja:

| Avans | Bruto | BigBit PDV | Naš `grossToNet` PDV |
|---|---|---|---|
| `AVR0005-25` | 44.066,14 | 7.344,36 | 7.344,36 ✔ |
| `AVR-00017/2025` | 535.922.487,65 | 89.320.414,61 | 89.320.414,61 ✔ |

Razlika je što **naš zbir po konstrukciji zatvara** (`vat = bruto − net`), a BigBitov ne mora.
`[4.0]` `src/modules/pdv/vat-bridge.util.ts`

**Ali smo nasledili nedoslednost:** naš POPDV seed za 4720 nosi `'P/0.2'` (deli iz PDV-a), dok
`VatLedgerEntry.vatBase` nosi zaokruženu osnovicu. Dva broja za istu osnovicu u istom sistemu.
Otvoreno pitanje §8, P2.

### 2.9 Poreski period se uzima iz otkucanog datuma — i to je već koštalo 89,3 miliona

Oba BigBit motora upisuju `DatPorPerioda = [T_Glavna knjiga].[Datum dokumenta]` — slobodno polje
koje kuca čovek. `[VBA]` `APGK_PDV_Provera_UpisiUPDVEvidenciju.sql`, `POPDV_StavkaGKPoSemi.sql`

Konkretan slučaj u produkciji: `T_PDV_GK`, `IFAV-OPSTA`, **`DatPorPerioda = 2024-01-03`**,
PDVIznos 89.298.226,44, dokument `AR-00001/2025` — a nalog je `IZV-E` od 03.01.**2025**.
**Najveći avans godine sedi u januaru 2024.** `[DB]`

Glavna knjiga to nije primetila jer mesečni PDV nalog radi po nalogu, ne po `DatPorPerioda`.
Obaveza je plaćena tačno, evidencija je pogrešna — i **nijedna bilansna kontrola to ne hvata jer
knjiga i dalje balansira.**

**Naše je strukturno bolje** (`taxPeriodYear`/`taxPeriodMonth` iz `paidAt` u UTC, zasebne kolone),
ali `markAdvancePaid` prihvata **bilo koji** `paidAt` bez ijedne reči upozorenja — ista klasa
greške je i kod nas moguća. Predlog kontrole §7, isporuka I4.

---

## 3. Ekran unosa AVR

### 3.1 Polja — šta se kuca, šta se povlači, šta je konstanta

Iz `T_Usluge dokumenta` (41 kolona), stvarno stanje na svih 1379 AVR: `[DB]` + `[VBA]`

**KUCA SE:**

| Polje | Napomena |
|---|---|
| Komitent | kombo; povlači `Odlozeno` → `U roku dana` |
| Datum dokumenta | = datum izvoda (§1.2) |
| Opis (zaglavlje) | kratka interna referenca: „po ponudi 0315-25", „po profakturi 0011-26 kurs 117.4013", ili prazno |
| `IDPredmet` | kombo `ComboPredmet` — **popunjen u 13/30 (2025) i 7/10 (2026)**, raste |
| `ObrKurs` | samo kod deviznih |

**POVLAČI SE AUTOMATSKI:**

| Polje | Izvor |
|---|---|
| Broj dokumenta | §3.2 |
| Datum valute | `Datum dokumenta + U roku dana` |
| Broj naloga | `ObrniDatum(Datum dokumenta)` → `250523` |
| DatumPrometa | = datum dokumenta |
| Napomena | `F_DefaultNapomena()` — isti tekst na svih 1379 |
| MestoPrometa | `'Beograd'` na svih 1379 |
| TekstZaFakturu | `'Račun'` na svih 1379 ← **defekt, §4.2** |

**KONSTANTE U PRAKSI:** `Level=0` (1379/1379), `Nacin placanja=''` (1379/1379), `Potpisano=0`
(1379/1379), `Zakljucano=1` samo na 97/1379 (7%).

**STAVKA — uvek tačno jedna:** `Kolicina=1`, `Tarifa usluga='3'` (20%), `RabatProc=0`,
`Obracunat porez=1`, `IDRazlogOslobadjanja=0` (**nikad korišćen ni jednom**), `DevCena=0`,
`Cena` = **neto osnovica kao double bez zaokruživanja**, `Opis` = slobodan tekst sa osnovom.

Tarife kroz istoriju: `'3'` (20%) ×1185, `'18'` (staro 18%) ×211, `'0'` ×3.
**Nijedan avans po stopi 10% nikada** — konto 4730 ima 0 stavki u obe godine. `[DB]`

### 3.2 Numeracija

**Šta BigBit radi danas** — `[VBA]` `Doc__Form_USLUGA Faktura.txt:635-651` + `DodelaPLU.bas:419-487`:

```
Left(VrstaDok,3) & "-" & zeroPad(1 + DCount(…), BBCFG.BrojZnakovaZaBrDok) & "/" & F_Godina()
                                                 ↑ default 5
→  AVR-00021/2025
```

`DCount` je filtriran po `IDFirma + Godina + Vrsta dokumenta + Level` → **otud godišnji reset**.
(Dokazano nad podacima: `BB_T_26.mdb` drži svih 1.398 AVR iz 2008–2026 u istoj tabeli, a 2026.
numeracija kreće od `AVR-00001/2026`.)

**Format nije bio isti kroz vreme** — kroz 16 godina tri režima: `[DB]`

| Period | Format | Primeri |
|---|---|---|
| 2008–2015 | `AR<n>/<GG>`, ručno | `AR31-2008`, `AR27/10`, `AR01/15` |
| **2016–2024** | **`<broj>/<GG>`, ručno** | `001/16`, `60/17`, `01/18`, `37/21`, `20/23`, `042/24` |
| 2025– | `AVR-000NN/YYYY`, auto | `AVR-00001/2025` … `AVR-00030/2025` |

> **Vlasnikov format `77/27` je upravo Servotehov format 2016–2024.** Prelaz na `AVR-000NN/YYYY`
> nije bila poslovna odluka — to je slučajna posledica automatizacije uvedene 03.01.2025.
> Vraćanje na `77/27` je **povratak sopstvenom standardu**, ne novotarija.

**Zašto BigBitov mehanizam NE preslikavati:**

- `COUNT(*)+1` je race condition — dva korisnika istovremeno dobiju isti broj
- broj se **reciklira posle brisanja**
- **u živoj bazi postoje 44 para AVR dokumenata sa identičnim brojem** (`AR62/10` ×2, `AR71/10` ×2,
  `AR32/13` ×2, `AR89/15` ×2 …) — nema unique ograničenja `[DB]`
- operater i danas prekucava: 2025 `AVR0005-25` i `AVR-000016/2025` (6 cifara umesto 5);
  2026 `0012-26`, `0016-26`, `0017-26`
- brojač u 2026. **ne prati broj dokumenata**: posle 8 dokumenata sledeći nosi `AVR-00006/2026`,
  ne `AVR-00009/2026` — nastavio je od poslednjeg AVR-**obrasca**, ne od `COUNT` `[DB]`

**Naš mehanizam ostaje, format se menja.** `[4.0]` `src/modules/sales/numbering.service.ts` —
`SELECT … FOR UPDATE` po `(documentType, year, companyId)`, rezervacija unutar transakcije
knjiženja (rollback poništava broj, bez rupa). Godišnji reset već postoji.

Danas formatira `${prefix}${String(seq).padStart(4,"0")}/${year}` → `AVR0001/2026`.
Za `77/27` treba **četiri izmene**:

| # | Danas | Traži se |
|---|---|---|
| 1 | prefiks „AVR" tvrdo zalepljen | opcija bez prefiksa |
| 2 | `/2026` (4 cifre) | `/27` (2 cifre) |
| 3 | `padStart(4,'0')` → `0077` | bez vodećih nula → `77` |
| 4 | isti obrazac za sve vrste | šablon **po vrsti dokumenta** |

**Predlog:** polje `numberFormat` na `DocumentType`, npr. `{seq}/{yy}` za AVR i `{prefix}-{seq:4}-{yy}`
za ponudu (`PN-0285-26` iz `ODLUKA_NUMERACIJA_DOKUMENATA.md` §1).

**Otvoreno (za vlasnika):** da li AVR ima **svoju** seriju (kao dosad kroz celu istoriju) ili ulazi
u zajedničku seriju izlaznih računa `001/27…`? Iz podataka: AVR je oduvek imao svoju. §8, P8.

### 3.3 Validacije

**Šta BigBit BLOKIRA — tačno tri stvari:** `[VBA]`

1. `Form_BeforeUpdate:527-533` — `If Not Me.DobarPIB And Not Me.NeProveravajPIB Then MsgBox "PIB
   komitenta je neispravan!" : DoCmd.CancelEvent`. **Jedina tvrda poslovna validacija na celoj
   formi**, i zaobilazi se čekboksom.
2. `Level` ValidationRule `BETWEEN 0 AND F_NivoBaze()`
3. `Zakljucano=True` → `AllowEdits=False`. Ali `ZakOtkDok` radi samo `rst!Zakljucano = Zakljucaj`
   — **bez ijedne provere** (ne gleda ni da li je dokument proknjižen, ni da li je iznos > 0).

**Šta BigBit NE proverava — potvrđeno podacima:** `[DB]`

| Nedostaje provera | Dokaz iz produkcije |
|---|---|
| jedinstvenost broja | 44 para AVR sa istim brojem |
| `Σ odbijeno ≤ naplaćeno` | ne postoji ni kao constraint ni u VBA |
| avans vezan **sam na sebe** | `T_AVR_Usluge` ID 2,3,4: `AVR 47/22 ← AVR 47/22`, `AVR 42/23 ← AVR 42/23` sa Koristi 71.076.866,01 |
| konzistentnost ključa | ID 7 = `"AVR 43/23"`, ID 18 = `"43/23"` → LEFT JOIN po stringu ne spaja → **isti avans odbijen dvaput**: 19.772.331,75 (IFUSL 312/24) + 13.611.254,72 (IFUSL 452/25) |
| razlog oslobođenja | `IDRazlogOslobadjanja = 0` na **svim** stavkama ikad |
| avans drugog komitenta | filter je samo u kombou; `BrojDokAVR` se može otkucati ručno |
| negativan iznos, datum u budućnosti | ništa |

**Naš minimum validacija (postoji + treba dopuniti):**

| Provera | Stanje u 4.0 |
|---|---|
| jedinstvenost broja | ✅ sekvenca + unique |
| `Σ primena ≤ naplaćen avans` | ✅ pod `pg_advisory_xact_lock` |
| `Σ primena ≤ bruto računa` | ✅ |
| isti avans dvaput na istom računu | ✅ parcijalni unique → 409 |
| avans na samog sebe | ✅ izričito zabranjeno |
| mešanje smerova (in/out) | ✅ |
| PDV period zaključan | ✅ `assertVatPeriodNotLocked` |
| **`Σ appliedVat ≤ knjižen PDV`** | ❌ kontrola ide po **bruto** — §5.5 |
| **`documentDate ≥ paidAt`** | ❌ ne postoji — §5.6 |
| **poreski period vs datum naloga** | ❌ ne postoji — §2.9 |
| **mešovita stopa** | ⚠️ tiho bira dominantnu — §6.10 |

---

## 4. Štampa

### 4.1 Obavezni zakonski elementi — propis

**Osnov:** ZPDV čl. 42 st. 4 + **Pravilnik o određivanju slučajeva u kojima nema obaveze izdavanja
računa… čl. 20** — posebna, **skraćena** lista za avansni račun. Avansni račun **ne mora** da
sadrži vrstu/količinu dobara, jedinicu mere ni datum prometa — prometa još nema. `[PROPIS]`

Obavezno je tačno ovo:

| # | Element | BigBit | 4.0 |
|---|---|---|---|
| 1 | naziv, adresa, PIB izdavaoca | ✅ | ✅ |
| 2 | mesto i datum izdavanja, redni broj | ✅ | ✅ |
| 3 | naziv, adresa, PIB primaoca | ✅ | ✅ |
| 4 | **osnov za avansno plaćanje** (ponuda/predračun/ugovor) | ❌ samo slobodan tekst u opisu stavke | ✅ `advanceBasis`, strukturno |
| 5 | **datum prijema avansa** | ❌ nema kolonu | ✅ `advancePaidAt` |
| 6 | iznos avansne uplate (bruto) | ✅ | ✅ |
| 7 | poreska stopa + iznos PDV (preračunata 20/120) | ✅ | ✅ |

Čl. 21 istog pravilnika: za oslobođen/neoporeziv promet dovoljni su izdavalac/primalac, iznos i
**napomena o odredbi** po kojoj PDV nije obračunat.

Za **e-fakturu** paralelno važi Pravilnik o e-fakturisanju čl. 12 st. 1, sa avansno-specifičnim
tačkama: 5) datum avansne uplate, **6) dan nastanka poreske obaveze**, 12) iznos avansne uplate i
osnov, 14a) šifra poreske kategorije.

**Rok:** gornji rok **nije propisan**. Donja granica **jeste i tvrda**: *„Račun se izdaje najranije
na dan prometa, odnosno na dan prijema avansa."* Dokument izdat **pre** nastanka poreske obaveze
**ne smatra se računom** u smislu ZPDV — primalac po njemu nema pravo na odbitak. `[PROPIS]`

### 4.2 Kako BigBit štampa — i zašto papir nije saobrazan

**Nema izveštaja specifičnog za AVR.** Dugme `Dugme_Printuj_sve_st_Click` (linija 270-300) bira
izveštaj po globalu `ImeFaktureUsluga = "USLUGA Faktura - " + Specijal`, sa fallbackom na
`"USLUGA Faktura - DEFAULT"`. `[VBA]` `Module__Bliski susret.txt:218-235`

**Naslov dokumenta** (linija 410 izveštaja): `=[Forms]![USLUGA Faktura]![TekstZaFakturu]` — a to
polje je **`'Račun'` na SVIH 1379 AVR dokumenata**. `[DB]`

> **Papir dakle glasi „Račun br. AVR-00021/2025".** Pravno je to konačni račun, ne avansni.

Ono što boli: `R_Vrste dokumenata.TextZaReport` za AVR **jeste** `'Avansni račun'`, i **robna**
grana ga čita (`Doc__Form_Izlazna faktura.txt:1284`) — ali **uslužna grana, gde AVR i živi, ne
čita**. Klasičan promašaj jedne linije koda koji je 16 godina štampao pogrešan naslov.

**Šta jeste na papiru** `[VBA]` `USLUGA Faktura - DEFAULT.txt` (RecordSource: `USLUGA Faktura za stampu`):

```
                                    [naslov iz TekstZaFakturu]  br. [PrefiksBrojaDok][Broj dokumenta]
Datum izdavanja racuna: …    Datum prometa: …    ← pravno pogrešna oznaka za avans
Mesto izdavanja racuna: Beograd   Rok za placanje: …

KUPAC: Naziv / Adresa / Poštanski broj + Mesto / PIB: … - MB: …

R.br. | O P I S | j.m. | Kolicina | C E N A | PDV | I Z N O S
──────────────────────────────────────────────────────────────
                                        Vrednost bez PDV (osnovica):
                                        Osnovni porez:
                                        Ukupno za uplatu (RSD):

[Napomena — boilerplate o reklamacijama i zateznoj kamati]

Direktor        Kontrolisao        Odgovorno lice / ImeProdavca, br. l.k.
                                                          www.BigBit.rs
```

**Zakonski elementi avansa nose slobodni tekstovi.** Jedini nosilac činjenice da je reč o avansu je
`Opis` stavke („Uplata 100% avansa po ponudi 0284-25/1…"). Ako operater to ne otkuca — nema ga.

Na **konačnom računu** postoji blok (`PDV_Avansi_USLUGA` kao podizveštaj) sa dva zaglavlja:
„Izvršene uplate i obračunati PDV po avansnim računima" (Datum | Broj | Iznos sa PDV | PDV Opšti |
PDV Posebni) i „Iznos uplate i PDV koji se koristi po ovom računu", pa red „Ukupno:", pa u podnožju
**„Razlika za uplatu (RSD)"** = `[Sve_ukupno] − [UkupnoPlacenoAvans]`. Nema teksta tipa „umanjenje
za primljeni avans" — samo tabela. `[VBA]`

### 4.3 Naša štampa — šta već radimo bolje, šta dodati

`[4.0]` `src/modules/sales/print/invoice-pdf.service.ts`

| Element | Stanje |
|---|---|
| naslov **„AVANSNI RAČUN"** | ✅ `SR_ADVANCE_LABELS.title`, auto-izbor po `documentType==='AVR'` |
| „Avansni račun br. …" | ✅ `docWord` |
| „Iznos avansa:" umesto „Ukupno za uplatu" | ✅ `grossTotalLbl` |
| **„Osnov avansa: …"** | ✅ `advanceBasisLbl`, iz strukturnog polja |
| stanje naplate | ✅ „Avans naplaćen X (datum)" |
| zakonska napomena | ✅ *„Poreska obaveza po avansu nastaje danom naplate avansa (Zakon o PDV, član 16. tačka 2). Iznos ovog avansa umanjuje iznos za uplatu na konačnom računu, ali ne umanjuje osnovicu prihoda."* |
| na konačnom računu: red **„Umanjenje za primljeni avans (br. …)"** po SVAKOJ primeni + „Za uplatu" | ✅ |
| **engleska varijanta nema zakonsku napomenu** | ⚠️ `advanceLegalNote: ""` — za izvozni avans nije sporno, ali treba znati |
| **„dan nastanka poreske obaveze" kao zaseban ispis** | ❌ izvodi se iz datuma naplate; za papir prihvatljivo, za e-fakturu je zaseban obavezan element |
| **štampa NENAPLAĆENOG AVR-a** | ❌ štampamo dokument koji po propisu nije račun — §5.6 |

**Izgled zadržavamo po BigBit uzoru** (zaglavlje firme, traka uslova, tabela stavki, zbirovi,
potpisi) — knjigovodstvo i kupci taj raspored poznaju 16 godina. Menjamo **samo** naslov, dodajemo
osnov, datum prijema avansa i zakonsku napomenu.

---

## 5. Šta 4.0 već ima, šta fali, šta je pogrešno

### 5.1 Tabela stanja

Legenda: ✅ radi · ⚠️ radi ali sa rizikom · ❌ nedostaje · 🔴 **pogrešno, treba ispraviti**

| # | Stavka | Stanje | Detalj |
|---|---|---|---|
| 1 | Okidač PDV obaveze = naplata | ✅ **bolji** | `markAdvancePaid` je poreski događaj, ne `createAdvanceInvoice`; `postingDate = documentDate`; **rate kumulativno, svaka rata knjiži svoj PDV** (BigBit rate rešava zasebnim dokumentima) |
| 2 | N:M avans ↔ račun sa iznosom po primeni | ✅ **znatno bolji** | `invoice_advance_applications` sa pravim FK, `appliedAmount/Net/Vat`, status ACTIVE/REVERSED, parcijalni unique, `pg_advisory_xact_lock` u fiksnom redosledu. BigBit ima **string ključ** i tri dokazana promašaja |
| 3 | Preračunata stopa | ✅ **bolji** | `grossToNet` daje isti PDV kao BigBit i uz to **zatvara zbir** |
| 4 | Osnov: ponuda / profaktura / **ugovor** | ✅ **bolji** | `advanceBasis` strukturno + obavezan bez predračuna; BigBit ima FK `IDDokIF` popunjen na **2 od 40** u 2025/26, i deo pokazuje na nepostojeće dokumente |
| 5 | Zatvaranje iz ranijeg perioda / preko godine | ✅ | nema nijednog vremenskog ograničenja; storno u periodu konačnog računa (tačno) |
| 6 | Naslov štampe „AVANSNI RAČUN" + zakonska napomena | ✅ **bolji** | BigBit štampa „Račun" |
| 7 | SEF/UBL 386 + `BillingReference` po svakoj primeni + `PrepaidAmount` | ✅ **bolji** | BigBit ima `BillingReference` **zakomentarisan** („hoćemo da dodamo kad mi hoćemo", 04-02-2023) |
| 8 | KIF/KUF se izvode iz GK automatski, u istoj transakciji | ✅ **bolji** | BigBit puni ručnom akcijom sa filterima → pokrivenost 1 od 44 na 47200 |
| 9 | **Storno avansa na kontu 47200** | 🔴 | **knjižimo dugovanje na 4720** — POPDV prijavljuje PDV avansa **dvaput**. Najozbiljniji nalaz, §5.2 |
| 10 | **`vatRateCode` = procenat, ne šifra tarife** | 🔴 | ulazni avans upisuje `'3'`; `vat-sanity` P5 čita kao 3% → **prvi ulazni AVR obara PDV obračun meseca**, §5.2 |
| 11 | 4 mapiranja preslikana iz BigBita sa greškom | 🔴 | `2720 → 'D/0.1'` na kontu od 20%; `4710 → 3.9` umesto 3.2; `2730` zamenjene K3/K4; `27300 → 'D/0.01'`, §5.2 |
| 12 | Konto 4300 knjižimo **neto** | ⚠️ | BigBit knjiži bruto POT + PDV DUG → kartica pokazuje primljen novac; kod nas se ta informacija gubi, §5.4 |
| 13 | Veza linija izvoda ↔ naplata avansa | ⚠️ | nema ni FK, ni matcher-a, ni idempotencije; saldo kupca privremeno raste posle uplate |
| 14 | Kontrola `Σ primena ≤ naplaćeno` po **bruto**, ne po PDV | ⚠️ | BigBitov slučaj `AVR-00008/2025` u varijanti sa dve stope i dalje prolazi, §5.5 |
| 15 | Mešovita PDV stopa | ⚠️ | tiho biramo dominantnu i pišemo `logger.warn` koji korisnik ne vidi, §6.10 |
| 16 | Štampa **nenaplaćenog** AVR-a sa definitivnim brojem | ⚠️ | trošimo broj iz serije na dokument koji po propisu nije račun, §5.6 |
| 17 | **Mesečni nalog 47xx/27xx → 4790** | ❌ | `VAT_SETTLEMENT_ORDER_TYPE='PDV'` postoji **samo kao filter**; nijedan servis ga ne pravi |
| 18 | **GK knjiženje ULAZNOG avansa** | ❌ | `advance-vat.service.ts` piše samo `VatLedgerEntry`; 2720/27200 se nikad ne napune → POPDV 8а.7 i 8а.2 **prazni** |
| 19 | **Povraćaj avansa (4721 → POPDV 3.6)** | ❌ | nema rute; 4721 je u POPDV mapi ali **nije** u `vat_account_map` |
| 20 | **Interni obračun građevinarstvo (47250/27250)** | ❌ | konta i mapiranja **postoje**, tok ne postoji |
| 21 | **`projectId` (predmet) na `Invoice`** | ❌ | model nema polje; BigBit ga koristi na **7 od 10** avansa u 2026 |
| 22 | **Pravilo istog perioda (3.9 se ne iskazuje)** | ❌ | POPDV motor ga nema; ni BigBit ga nema, §2.4 |
| 23 | Avans u stranoj valuti na zasebno konto (4302) | ❌ | uvek `'4300'`; izvozni avans bez PDV-a inače radi ispravno |
| 24 | Prenos poreske obaveze na **izlaznom** avansu | ❌ | nema flag-a; za građevinske usluge bismo obračunali 20%, a ne smemo |

### 5.2 Tri stvari koje treba ispraviti pre svega ostalog

---

**🔴 D1 — Storno avansa ide na pogrešno konto → POPDV prijavljuje PDV dvaput**

*Šta radimo:* `applyAdvance` knjiži `4300 DUG = osnovica`, **`4720 DUG = PDV`**, `2040 POT = bruto`.
`[4.0]` `advance-invoice.service.ts` — potvrđeno u kodu, linija sa
`description: "Storno PDV … po avansu"` i `debit: split.vat.toFixed(4)` na `vatAccountFor()`.

*Zašto je to pogrešno — dokazano kroz naš sopstveni kod, nije pretpostavka:*

```
popdv-account-map.sql:52-53   ('4720','3.9','P/0.2',1)  i  ('4720','3.9','P',2)
popdv.service.ts evalColumnDef:  { D: balance.debit, P: balance.credit }
                                                         ↑ 'P' vraća ISKLJUČIVO credit
```

Naš **dugovni** storno ne ulazi ni u jednu POPDV kolonu:

- polje **3.9 ostaje naduvano** — nikad se ne umanjuje
- polje **3.2 ne dobija negativan red** (jer 47200 nikad ne dobije stavku)
- a 3.2 **istovremeno dobija pun PDV konačnog računa** sa 4702

→ **PDV po avansu je prijavljen dvaput**: jednom u 3.9 u mesecu naplate, drugi put u 3.2 u mesecu
konačnog računa.

*Zašto se ne vidi:* zaglavlje `VatReturn` (`sumVatAccounts`) računa `credit − debit`, pa su
`outputVat`, `vatLiability` i PP-PDV pozicije 103/105 **tačni**. Greška je izolovana u **POPDV
linijama**, i `vat-sanity.ts` je ne hvata jer proverava knjige, ne POPDV polja.

*Ko je u pravu:* **BigBit** — ne zato što je BigBit, nego zato što je model „zasebno konto
pokrivanja + negativan potražni iznos" **jedini saglasan sa našom sopstvenom POPDV mapom**, koja je
preslikana iz Pravilnika.

*Ispravka:* knjižiti storno kao **`47200 POT −PDV`** (negativan potražni), ne `4720 DUG`.
Konto `47200` **već postoji** u oba naša registra: `vat-account-map.sql:58` (output/20/avans) i
`popdv-account-map.sql:54` (→ 3.2, `'P'`). Fali samo da ga servis koristi.

*Napomena:* alternativa `column_def = 'P-D'` na 4720 **nije dovoljna sama po sebi** — ona bi
popravila 3.9, ali 3.2 bi i dalje ostalo bez umanjenja.

---

**🔴 D2 — `vatRateCode` nosi šifru tarife; sanity je čita kao procenat → obara PDV obračun meseca**

*Dva pisca iste kolone koriste dva pojma:*

```
vat-ledger.service.ts:224    vatRateCode: rate != null ? String(rate) : null   → '20' / '10'
advance-vat.service.ts:278   vatRateCode  (iz advance.items[0].vatRateCode)    → '3' / '2' / '4'
```

Da je `'3'` = 20%, potvrđeno: `gl/posting/vat-rates.ts` — `VAT_RATE_BY_CODE = { "3": 0.20, "1": 0.20,
"2": 0.10, "4": 0.08, "0": 0 }`.

*Čitalac* — `vat-sanity.ts` P5:

```ts
const rate = Number(code);                       // Number('3') = 3
const expected = new D(g.base).mul(rate).div(100);   // base × 3%
```

*Posledica:* svaka KUF stavka ulaznog avansa formira grupu `input|3` u kojoj je `vat = base × 0,20`,
a P5 očekuje `base × 0,03` → razlika ~17% osnovice, daleko iznad tolerancije (1,00 RSD + 0,1%) →
`problems` → `assertVatPeriodSane` baca **409** → rollback, i **`buildKifKuf` i `popdv.compute` za
taj mesec padaju** dok se ne pozove sa `force`.

> Drugim rečima: **prvi ulazni avansni račun koji neko unese ruši PDV obračun tog meseca**, sa
> porukom koja optužuje „registar PDV konta".

*Ko je u pravu:* **čitalac.** Kolona se u 95% redova puni procentom i tako je i dokumentovana u
`deriveBase` i u P5. Pisac ulaznog avansa mora da upiše **`ratePct`** (koji već izračuna kroz
`resolveRatePct`), a šifru tarife da čuva na stavci dokumenta.

*Ispravka:* jedna linija + test. Uz to **definisati tu kolonu u shemi** (šifra vs procenat) da se
klasa greške ne ponovi.

---

**🔴 D3 — četiri BigBitova defekta doslovno preslikana u naš POPDV seed**

`[4.0]` `prisma/seed/popdv-account-map.sql` je doslovan prepis `POPDV_SemeKontaZaKnjizenje` iz
`BB_T_26`, **uključujući i greške**. Provereno red po red:

| Red | Danas | Treba | Zašto |
|---|---|---|---|
| 25 | `('2720','8а.7DA','D/0.1',1)` | `'D/0.2'` | 2720 je konto po **20%** (`vat-account-map.sql:43`). Deljenje sa 0,1 daje **dvostruku** osnovicu — u BigBitovoj produkciji 2026: **163.222.455,30 umesto 81.611.227,65** |
| 50, 51 | `('4710','3.9',…)` | `'3.2'` | 4710 je **redovan** izlazni PDV 10%, ne avans. Sva ostala izlazna konta (4700–4703) idu na 3.2 |
| 31, 32 | `2730`: K3=`'D'`, K4=`'D/0.10'` | K3=`'D/0.1'`, K4=`'D'` | **kolone zamenjene** — osnovica se prijavljuje kao PDV i obrnuto |
| 33 | `('27300','8а.2DA','D/0.01',4)` | `'D'` (ili `'D/0.1'`) | deljenje sa 0,01 = **100× promet**; nema smisla ni pod jednom stopom |

Poređenja radi, izlazna strana je **ispravna**: `3.9 | 4720 | K1 = 179.817.655,75 = 35.963.531,15/0,2` ✔.

Sva četiri su **danas bez posledica** — ni Servoteh ni mi nemamo promet po 10% ni date avanse po
10%. Ali `evalColumnDef` ih izvršava doslovno; **prva stavka po 10% ih aktivira.**

*Umanjujuća okolnost za 2720:* polje 8а.7 K1 ne ulazi ni u 8а.6 ni u ijedan AOP — kao i 3.9 K1 je
informativno. **Iznos poreza nije pogrešan; pogrešna je prijavljena vrednost u obrascu.**

*Odluka za knjigovođu* (§8, P3): tačan POPDV **vs** identičan izlaz kao BigBit radi uporedivosti
prijava tokom paralelnog rada. **Preporuka: ispraviti sada, dok su tabele prazne**, i dodati test
koji unakrsno proverava `popdv_account_map.column_def` prema `vat_account_map.rate` za isto konto.
To je jedina trajna odbrana od povratka ove klase greške.

### 5.3 Pet nedostajućih tokova (redom po hitnosti)

1. **Mesečni nalog vrste `PDV`** (47xx/27xx → 4790/2790). Bez njega saldo obaveze prema PU **nikad
   ne nastane iz našeg rada**; konta 4720/47200 rastu kumulativno kroz godinu i nikad se ne
   zatvaraju. Danas `VAT_SETTLEMENT_ORDER_TYPE` postoji samo kao **filter** (da se taj nalog izuzme
   iz KIF/KUF) i kao kontrolna tačka P4 koja poredi naš rezultat sa **BigBitovim migriranim
   saldom**. Čim 4.0 postane jedini pogon, ta kontrola ostaje bez reference i `vat-sanity.ts:329`
   počinje da javlja „ne postoji nalog zatvaranja PDV konta". Formula je verifikovana — §2.5.
2. **GK knjiženje ULAZNOG avansa.** Grep po `postManualEntry|PostingEngine|2720|27200|glAccount` u
   `advance-vat.service.ts` vraća **nula pogodaka** — servis piše samo `VatLedgerEntry`. Dati avans
   dobavljaču je **knjigovodstveno nevidljiv**, a POPDV 8а.7/8а.2 ostaju prazni bez obzira na
   postojeća mapiranja (jer POPDV čita iz **salda konta**, ne iz `vat_ledger_entries`).
   Asimetrija je očigledna: izlazni smer uredno knjiži 2040/4300/4720.
3. **Povraćaj avansa** (4721 → POPDV 3.6). BigBit **nema nijedno knjiženje** (0 stavki 2025, 2
   stavke po 0,00 u 2026) — nema se šta preslikati, tok se mora projektovati. Detalji §6.6.
4. **Interni obračun po avansu za građevinarstvo** (47250/27250 → 3а.8 + 8б.7). **Živ u BigBitu od
   2026** — 5 stavki, 1.578.068,83 na obe strane. Konta i POPDV mapiranja **već imamo**; fali samo
   tok i zastavica „prenos poreske obaveze" na avansu. Detalji §6.9.
5. **`projectId` na `Invoice`.** Potvrđeno: `awk '/^model Invoice /,/^}/' schema.prisma | grep -c
   projectId` → **0**. Jedina strukturna spona avansa i posla koju BigBit realno koristi (2026: 7
   od 10), a mi je uopšte nemamo.

### 5.4 Konto 4300 — jednoredni vs dvoredni oblik

| | BigBit | 4.0 |
|---|---|---|
| kupac / banka | `2410 DUG 47.899,50` | `2040 DUG 47.899,50` |
| primljeni avansi | `4300 DUG 7.983,25 / POT 47.899,50` | `4300 POT 39.916,25` |
| PDV | `4720 POT 7.983,25` | `4720 POT 7.983,25` |

Saldo je isti (39.916,25). Ali BigBitova kartica 4300 po komitentu pokazuje **koliko je novca
stvarno primljeno**; naša ne. To je gubitak informacije za usaglašavanje sa kupcem i za bilansnu
poziciju „primljeni avansi". **Preporuka: preslikati dvoredni oblik.**

Druga, veća razlika: **mi ne diramo banku.** BigBit u istom nalogu zadužuje 2410; kod nas
`BankStatementService` knjiži `banka DUG / 2040 POT`, a naplata avansa `2040 DUG`. Par se
poništava, krajnje stanje isto — **ali nema nikakve veze između linije izvoda i `markAdvancePaid`**.
Ako izvod nije proknjižen, 2040 ostaje sa visećim dugovanjem; ako neko ručno proknjiži izvod
direktno na 4300, avans se knjiži dvaput. **Preporuka: `bankStatementLineId` na naplati +
idempotencija po njoj.**

### 5.5 Kontrola po bruto vs po PDV

`applyAdvance` kontroliše `requested ≤ advancePaidAmount − Σ ACTIVE primena` — dakle **bruto**.
PDV primene se izvodi ponovnim pozivom `splitAdvance(requested, advance.items, advance.isExport)`
sa istim ulazom kao pri naplati, pa je za **jednu stopu** proporcija tačna do centa.

Ostatak rizika:

- avans naplaćen **u ratama**: Σ PDV pojedinačnih rata (svaka zaokružena) može se za par centi
  razlikovati od PDV-a izvedenog iz zbirnih primena — nema kontrole koja to hvata
- ako se `advance.items[0].vatRateCode` promeni između naplate i primene, storno PDV-a ne bi
  odgovarao knjiženom
- izvozni avans (`vatPercent 0`) nema PDV liniju ni pri naplati ni pri primeni — konzistentno, ali
  **nema provere da se izvozni avans ne primeni na domaći račun sa PDV-om**

**Preporuka:** kontrola `Σ appliedVat aktivnih primena ≤ Σ knjiženog PDV-a po naplatama tog avansa`
(iz GK, ne izvedeno iz bruto), + test koji reprodukuje BigBitov slučaj `AVR-00008/2025`.

### 5.6 Izdajemo avansni račun pre nego što je avans primljen

`createAdvanceInvoice` postavlja `documentDate = input.documentDate ?? new Date()` i **odmah**
dodeljuje definitivan broj iz sekvence, `status:'POSTED'`, `isLocked:true` — a naplata dolazi
kasnije i **može ne doći nikad**. Naš PDF to čak i priznaje:

> „Avans NIJE naplaćen — poreska obaveza po ovom avansnom računu još nije nastala."

Po propisu (§4.1) dokument izdat pre nastanka poreske obaveze **nije račun** — to je predračun.
Mi ga naslovljavamo „AVANSNI RAČUN", numerišemo iz poreske serije i trošimo broj na njega.

Nema nijedne provere `documentDate ≥ paidAt` ni obrnuto — datumi su potpuno nezavisni.

**Preporuka (usklađuje nas i sa BigBitovom praksom iz §1.2):** AVR se kreira kao **NACRT bez broja**;
broj iz serije se rezerviše **tek pri `markAdvancePaid`**, u istoj transakciji sa knjiženjem — što
naša sekvenca ionako već podržava (rezervacija u transakciji, rollback bez rupa). Alternativa ako
knjigovodstvo insistira na ranijem broju: dozvoliti izdavanje, ali **blokirati štampu i slanje na
SEF** dok nije naplaćen. Odluka §8, P5.

---

## 6. Granični slučajevi koje moramo da podržimo

Svaki je **dokazan produkcijskim podacima** — nijedan nije hipotetički.

### 6.1 Jedan avans se deli na više faktura

`AVR-00001/2026` (bruto 497.754,00) → `IFR 033/26` (316.638,00) + `IFR 062/26` (181.116,00) =
**497.754,00 tačno**. `[DB]`

Rekord: **`031/24` primenjen na 13 faktura** (IFGP 138, 139, 140, 141, 143, 157, 162, 188, 198,
210, 214 + reizdanja `210/26-` i `214/26-`), 15.05.–09.07.2026, ukupno povučeno 192.136.539,66 od
792.099.970,36 — **iskorišćeno 24,3%, ostatak i dalje otvoren**. `[DB]`

> **Kritično za model.** BigBit u `UkIznosSaPDVAVR` **ne upisuje pravi ukupan iznos avansa**, nego
> preračunatu vrednost tog reda: za `031/24` svaki od 13 redova nosi `Uk = Koristi`
> (13.594.229,70 … 17.447.118,09), a pravi iznos je 792.099.970,36. **Iz `T_AVR_*` je nemoguće
> izračunati preostatak** — jedini pouzdan izvor je analitika konta 4300. To direktno objašnjava
> zašto robna podforma predlaže pun iznos avansa: nema podatka nad kojim bi računala.
>
> Naš model (`applied_amount` + FK na avans, `advancePaidAmount − Σ ACTIVE`) je **strogo tačniji** —
> i ovo je najjači argument da se BigBitov zapis **ne preslikava**.

**4.0: ✅ radi.**

### 6.2 Više avansa zatvara jednu fakturu

Rekord: **`IFUSL 059/25`** (03.02.2025, BEO BETONI) zatvara **šest** avansa: `03/24`, `04/24`,
`11/24`, `14/24` (po 500.000,00), `029/24` (312.500,00), `AVR-00001/2024` (500.000,00) =
**2.812.500,00**. `[DB]`

Ostali: `IFGP 144/25` → 3 avansa (159.121.638,79) · `IFGP 053/26-` → `030/24` + `U0045-24`
(244.319.176,80) · `IFR 054/26` → `AVR-00026/2025` + `AVR-00003/2026` (dve rate 50% avansa **po
istoj ponudi 0558-25**, druga preko granice godine).

Zatvaranje `IFGP 142–146/25` je u **jednom nalogu** (`0008`, AVANS, 19.03.2025) sa 11 parova
4300/47200 stavki.

**4.0: ✅ radi.**

### 6.3 Avans po ugovoru (bez predračuna)

Nosi **95,6% novca** (§1.1). Rate istog ugovora su zasebni AVR dokumenti, preko granice godine.

**4.0: ✅ `createAdvanceWithoutSource` sa obaveznim `basis`.** Svesno **bez** anti-duplo guard-a —
to je tačno preslikan BigBitov obrazac rata po istom ugovoru.

⚠️ `advanceBasis` je slobodan tekst i kad postoji ugovor — nema registra ugovora ni FK. Prihvatljivo
dok ugovori nisu entitet, ali treba znati da je i kod nas veza netipizovana.

### 6.4 Zatvaranje u drugom poreskom periodu

21 od 71 veze prelazi granicu godine; rekord 2 godine i 16 dana (§1.5).

**4.0: ✅ radi**, i **bolji smo** — storno se knjiži sa `documentDate = invoice.documentDate`
(period konačnog računa, tačno), a period je zaštićen od upisa u zaključan PDV period. BigBit tu
bravu nema.

❌ **Fali izveštaj „otvoreni avansi na dan"** (BigBitov ekvivalent = PS redovi konta 4300: 17 stavki
/ 2.397.119.895,52 na 31.12.2025). Bez njega niko ne vidi šta je otvoreno.

### 6.5 Avans u stranoj valuti

`DevValuta` na AVR dokumentima je `'RSD'` u **svih 40** dokumenata 2025/2026; kroz celu istoriju
samo 1 (2020) ima stranu valutu. **Inostrani avansi uopšte nemaju AVR dokument** — žive samo kao GK
stavke na kontu **4302** iz naloga `DEVRN`: `[DB]`

```
2026-02-24  DEVRN  '016/26'  an=1005939  POT 1.254.650,34   opis '10684.95e'
2026-03-19  DEVRN  '060/26'  an=1005939  POT 1.236.609,12   opis '10.530.75e'
2025 (PS):  V0026-24  32.009.955,80 = '273.474,60e'  ·  U0031-24  64.039.000,13 = '546.949,20e'
```

**Nijedna 4302 stavka nema prateću 4720 liniju** — inostrani avans **ne nosi PDV**. Devizni iznos i
kurs postoje **samo u slobodnom tekstu opisa**.

**4.0: ⚠️ delimično.** `currency` i `exchangeRate` postoje; `isExport` postavlja `vatRateCode='0'`
i kupca na 2050, `vatAccountFor(0)` vraća `null` pa PDV linija izostaje — **izvozni avans bez PDV-a
radi**. Ali:

- ❌ konto je **uvek `'4300'`** (`ACC_ADVANCES_RECEIVED`) — nema 4302 za inostranstvo ni 4306 za
  oslobođenje po čl. 24/1/16v. Devizni avans nam se meša sa domaćim.
- ❓ kursna razlika / revalorizacija obaveze po deviznom avansu — 4300 nije u obuhvatu
  `fx-revaluation`; treba proveriti (§8, P7)

**Preporuka:** izbor konta po `(isExport, oslobođenje)` umesto konstante. To je zahtev kontnog
plana, ne stvar ukusa.

### 6.6 Povraćaj / nerealizacija avansa

**BigBit nema.** Konto 4721 je mapiran na 3.6, ali **0 knjiženja 2025, 2 stavke po 0,00 u 2026**.
Nema dugmeta „vrati avans", nema vrste dokumenta za storno AVR-a. Ono što je **jednom** urađeno u
16 godina je **negativan AVR dokument**: `U0034-24` (14.10.2024, Sintermetal-EC, osnovica
**−7.583.333,33**), uz `35-24` sa +9.100.000,00 istog dana i istim opisom — dakle „nov AVR na tačnu
vrednost + negativan AVR koji poništava stari". `[DB]`

**Propis traži tri stvari koje ni BigBit ni mi nemamo:** `[PROPIS]`

1. **ZPDV čl. 21** — smanjenje obračunatog PDV je moguće **samo ako primalac ispravi odbitak
   prethodnog poreza i o tome PISMENO OBAVESTI izdavaoca**. Bez te izjave — nema umanjenja.
   SEF to izričito proteže i na storniranje/smanjenje avansne fakture, „bez obzira na to da li je
   nakon te avansne fakture izdata konačna faktura ili ne".
2. **POPDV:** ne ispravlja se već iskazan iznos u 3.9; vrši se **smanjenje u polju 3.6** za iznos
   PDV-a iskazan u 3.9. Ako je povraćaj u **istom periodu** kao naplata — **ne iskazuje se ni 3.9
   ni 3.6**.
3. **SEF: storno avansne fakture više nije moguć** — usmerava na **dokument o smanjenju** vezan za
   avansnu fakturu.

**Naše stanje:** ❌ nema rute (`grep refundAdvance|povraćaj` → 0 pogodaka). Jedini put je
`stornoInvoice(AVR)` → `glWrite.reverse` sa `postingDate = new Date()`. Tri problema:

- `stornoInvoice` **ne poziva** `assertVatPeriodNotLocked` ni za jedan period (za razliku od
  `markAdvancePaid` i `applyAdvance`)
- dugovanje na 4720 → ista slepa tačka POPDV-a kao D1
- **pojmovno**: „storno pogrešno izdatog avansa" i „povraćaj novca kupcu" su kod nas **ista
  operacija**, a poreski su različite
- `4721` **nije** u `vat-account-map.sql` (potvrđeno grep-om) ali **jeste** u
  `popdv-account-map.sql:55` → kad bi se ikad proknjižio, ušao bi u POPDV 3.6 ali **ne** u KIF ni u
  `outputVat` — obaveza bi bila umanjena u obrascu a ne u knjizi

**Predlog:**

```
refundAdvance(advanceId, amount, statementRef, refundedAt)
  ├─ traži referencu izjave primaoca kad je kupac PDV obveznik   ← uslov zakonitosti
  ├─ knjiži  4300 DUG / 2040 (ili 2410) POT / 4721 POT −PDV
  ├─ ako je povraćaj u ISTOM periodu kao naplata → potiskuje i 3.9 i 3.6
  └─ generiše DOKUMENT O SMANJENJU vezan za AVR (ne storno) → SEF
```

Uz to: `4721` dodati u `vat_account_map` (`direction='output'`, `rate=20`), i razdvojiti storno
pogrešno izdatog AVR-a od povraćaja.

### 6.7 Avans naplaćen bez obračunatog PDV-a — kontrola koja mora da postoji

`AVR-00008/2025`, 26.03.2025, Jugoimport SDPR (11688). Dokument **nosi PDV**: tarifa `3`,
`Cena = 760.600,00` → PDV 152.120,00, bruto 912.720,00. `[DB]`

```
NASTANAK   (nalog IZVOD/0061, 26.03.2025):
   4300  an=11688  POT 912.720,00
   ← NEMA 4300 DUG 152.120,00, NEMA 4720 POT 152.120,00
   ← nema ni reda u T_PDV_GK

ZATVARANJE (nalog AVANS/0011, 09.04.2025, faktura IFR 206/25):
   4300  an=11688  DUG −152.120,00  POT −912.720,00
   47200 an=11688                   POT −152.120,00      ← STORNO IPAK IDE
```

**Rezultat:** 47200 nosi u aprilu kredit od 152.120,00 koji **nikad nije bio zadužen na 4720**.
Mesečni nalog `PDV/0004` ima `47200 DUG −206.246,26` i **nema 4720 liniju** — **aprilska obaveza za
PDV umanjena za 152.120,00 RSD bez pokrića.**

BigBit nema nijednu kontrolu koja bi to sprečila (nema veze dokument ↔ GK stavka ↔ `T_AVR_` red).

**4.0: ⚠️** — naša kontrola ide po bruto, ne po PDV (§5.5). Za jednu stopu je bezbedno; treba
proširiti.

### 6.8 Nekonzistentan broj dokumenta u glavnoj knjizi

`Broj dokumenta` u GK je **slobodan tekst**. Isti avansi nose: `AR-00001/2025`, `AVR-00002/2025`,
`AR-AVR0005-25`, `AVR-00020/25` (skraćeno), `AVR-0003/2026` (jedna nula manje nego dokument),
`AR-0012-26`, `12/13` umesto `12/23`, i prazno `'-'`. `[DB]`

**Dokazane greške:**

- nalog `0008` (19.03.2025): stavka 4300 za `'12/23'` nosi −2.428.472,25, a njen par na 47200 nosi
  oznaku **`'13/23'`** (iznos je 12/23-ov). Par je pravilno spojen **iznosima**, oznaka je pogrešna.
- nalog `0021` (05.08.2025): 4300 nosi `'43/23'` (avans), a 47200 nosi **`'452/25'`** — **broj
  FAKTURE**, ne avansa.

**Vrsta naloga za zatvaranje takođe nije konzistentna:** 2026. je `031/24` zatvaran 7× u nalozima
vrste `NALOG` (15.05.–01.06.) i 15× u vrsti `AVANS` (25.06.–09.07.) — **isti posao, dva tipa
naloga, u razmaku od mesec dana**. I jedan izuzetak u stornu: `AVR-00011/2025` storniran je na
**4720** umesto na 47200 (POPDV posledica: ide u 3.9 negativno umesto u 3.2 negativno). `[DB]`

**4.0: ✅** — kod nas je veza FK, ne string. Ovo je nalaz koji **potvrđuje** naš dizajn.

### 6.9 Prenos poreske obaveze — građevinarstvo (novo od 2026, ŽIVO)

Konto **47250** „PDV 20% - INTERNI RAČUN Avansi GRAĐEVINARSTVO - bez osnovice" (POPDV **3а.8**),
par mu je **27250** (POPDV **8б.7**). **0 stavki u 2025, 5 u 2026:** `[DB]`

```
11.02.2026  RAZNO/0017  an=1002613                POT   504.000,00
25.02.2026  IZVOD/0039  '2/26'      an=1005965    POT    74.068,83
28.02.2026  PDV/0002    '02'                      DUG   578.068,83   ← mesečno zatvaranje
29.05.2026  IZVOD/0104  'A-22-2026' an=1002613    POT 1.000.000,00
31.05.2026  PDV/0005    '05'                      DUG 1.000.000,00
                                            ukupno 1.578.068,83 na obe strane
```

**Semantika:** kad Servoteh **plati** avans izvođaču iz građevinarstva (čl. 10 st. 2 t. 3 ZPDV),
sam obračuna PDV (**47250 POT → 3а.8**) i istovremeno ga odbije (**27250 DUG → 8б.7**). Neto efekat
na obavezu je nula, ali **oba polja moraju biti prijavljena.**

Brojevi dokumenata su drugačiji (`'2/26'`, `'A-22-2026'`) i **nema AVR dokumenta iza njih** — knjiži
se direktno u GK. (Otvoreno: da li su to uopšte AVR dokumenti — u `T_Usluge dokumenta` ih nema.)

**4.0: ❌ tok ne postoji**, iako konta **jesu** u oba naša registra (`vat-account-map.sql:45,59`;
`popdv-account-map.sql:30,56,57`). Nijedan servis ne generiše knjiženje na njih.

⚠️ **I obrnuto:** na **izlaznom** avansu nemamo flag „poreski dužnik je primalac". Ako Servoteh
izda avansni račun za građevinske usluge, sistem će obračunati 20% — **a ne sme** (Pravilnik o PDV
čl. 166 ga oslobađa i obaveze izdavanja avansnog računa).

### 6.10 Mešovita PDV stopa na avansu

BigBit: **nikad se nije dogodilo** u 26 godina — sve stavke tarifa `'3'`, konto 4730 (10%) ima 0
stavki. Forma tehnički dopušta N stavki sa različitim tarifama.

**4.0: ⚠️ tiho biramo dominantnu stopu.** `createAdvanceInvoice` uvek pravi **tačno jednu** stavku,
a `resolveVatRateCode` bira šifru sa **najvećom zbirnom osnovicom** na predračunu. Mešovit
predračun (20% + 10%) prolazi uz `logger.warn` — **u log, koji korisnik nikad ne vidi**.

**Propis:** PDV po avansu se obračunava po stopi koja važi za promet koji se avansira; ako je
promet mešovit, **avans se deli**.

**Tri opcije, i preporuka:** (a) podrška za više stavki/stopa na avansu, (b) **tvrdo odbijanje
(422)** sa porukom „razdvoj avans po stopama", (c) današnje tiho biranje. **Preporuka: (b) sada,
(a) kad se ukaže potreba.** Tiho biranje je najgora od tri.

---

## 7. Isporučive celine, redom

Redosled je diktiran rizikom, ne udobnošću: prvo ono što danas daje **pogrešan poreski izlaz**,
pa ono što **blokira zatvaranje**, pa dopune.

### Talas A — ispravke (pre svega ostalog)

| # | Šta | Veličina | Zašto prvo |
|---|---|---|---|
| **A1** | **D2**: `advance-vat.service` upisuje `ratePct` umesto šifre tarife u `vat_ledger_entries.vatRateCode` + test + komentar u shemi | **XS** (1 linija + test) | prvi ulazni AVR danas **obara PDV obračun meseca** |
| **A2** | **D1**: storno avansa na `47200 POT −PDV` umesto `4720 DUG` + test koji proverava POPDV 3.2/3.9 kroz pun ciklus | **S** | POPDV danas **prijavljuje PDV avansa dvaput** |
| **A3** | **D3**: ispraviti 4 reda u `popdv-account-map.sql` + **unakrsni test** `column_def` vs `vat_account_map.rate` | **S** | dok su tabele prazne; test je trajna odbrana |

*Blokada:* A2 i A3 traže presudu knjigovođe (§8, P1 i P3). A1 je čist bug — ide odmah.

### Talas B — numeracija i unos (vlasnikov zahtev)

| # | Šta | Veličina |
|---|---|---|
| **B1** | `numberFormat` na `DocumentType`; podrška za `{seq}/{yy}` bez prefiksa i bez vodećih nula → **`77/27`**; migracija postojećih AVR serija | **M** |
| **B2** | Ekran unosa AVR po §3.1: osnov (ponuda/profaktura/ugovor) kao izbor tipa + broj, predmet, datum prijema avansa | **M** |
| **B3** | Odluka §5.6: AVR kao nacrt bez broja → broj se rezerviše pri naplati (ili blokada štampe/SEF-a dok nije naplaćen) | **S** *(posle odluke P5)* |

### Talas C — zatvaranje PDV lanca

| # | Šta | Veličina |
|---|---|---|
| **C1** | **Mesečni nalog vrste `PDV`** (47xx/27xx → 4790/2790 + zaokruženje 5799/6799) po formuli iz §2.5 | **L** — van avansnog toka, ali bez njega tok nije zatvoren |
| **C2** | **GK knjiženje ulaznog avansa** (dati avansi + 2720 pretporez; 27200 storno pri konačnom računu) | **M** |
| **C3** | **Pravilo istog perioda** u POPDV motoru — potiskivanje para 4720/47200 unutar istog perioda | **M** *(posle odluke P1)* |

### Talas D — nedostajući tokovi

| # | Šta | Veličina |
|---|---|---|
| **D1** | **Povraćaj avansa** (`refundAdvance` → 4721 → POPDV 3.6) + izjava primaoca + dokument o smanjenju za SEF + `4721` u `vat_account_map` | **L** *(posle odluke P4)* |
| **D2** | **Interni obračun građevinarstvo** — zastavica „prenos poreske obaveze" + par 47250/27250; **konta i mapiranja već postoje** | **M** |
| **D3** | **`projectId` na `Invoice`** + popunjavanje sa predračuna + filter/izveštaj po predmetu | **M** |
| **D4** | **Konto 4302/4306** — izbor konta primljenog avansa po `(isExport, oslobođenje)` umesto konstante | **S** |

### Talas E — kontrole i vidljivost

| # | Šta | Veličina |
|---|---|---|
| **E1** | Kontrola `Σ appliedVat ≤ Σ knjiženog PDV` (iz GK) + test koji reprodukuje `AVR-00008/2025` | **S** |
| **E2** | Sanity pravilo (**upozorenje**, ne blokada): poreski period odstupa od datuma izvornog dokumenta > N meseci — BigBitov slučaj od 89,3 mil. (§2.9) | **S** |
| **E3** | Izveštaj **„Otvoreni avansi na dan"** (ekvivalent PS redova konta 4300) | **M** |
| **E4** | Dvoredni oblik 4300 (POT bruto + DUG PDV) — kartica pokazuje primljen novac | **S** |
| **E5** | Veza **linija izvoda ↔ naplata avansa** (`bankStatementLineId` + idempotencija) | **M** |
| **E6** | Mešovita stopa: tvrdo odbijanje (422) umesto tihog `logger.warn` | **XS** |
| **E7** | Period-brava na stornu AVR-a (`assertVatPeriodNotLocked`) | **XS** |

### Talas F — štampa i SEF, dopune

| # | Šta | Veličina |
|---|---|---|
| **F1** | „Dan nastanka poreske obaveze" kao zaseban element (papir + UBL `cbc:TaxPointDate`) | **S** |
| **F2** | Na avansnom računu (386): `BillingReference` na predračun/ugovor — `copiedFromDocId`/`advanceBasis` su nam dostupni | **S** |
| **F3** | Izostaviti `cac:Delivery` na AVR-u (promet još nije izvršen; BigBit ga izostavlja) | **XS** |

### Regresioni testovi — četiri kompletna traga iz produkcije

Svaki ima pun knjigovodstveni trag i može se reprodukovati do para: `[DB]`

1. **`AVR-00013/2025`** — deljenje na dve fakture, istog meseca. Nastanak `IZVOD/0102` 23.05.
   (4300 DUG 6.317,00 / POT 37.902,00; 4720 POT 6.317,00) → `AVANS/0015` 18.06. (IFR 353/25,
   −20.802,00) → `AVANS/0016` 25.06. (IFR 370/25, −17.100,00). **Zbir 37.902,00 tačno.**
2. **`AVR-00001/2026`** — deljenje **preko dva meseca**. `IZVOD/0013` 20.01. (POT 497.754,00,
   4720 POT 82.959,00) → `AVANS/0001` 11.02. (−316.638,00) → `AVANS/0005` 10.03. (−181.116,00).
   Mesečni `PDV/0001` 31.01.: 4720 DUG 92.070,50.
3. **`IFR 054/26`** — **dva avansa iz DVE godine** na jednu fakturu. `AVANS/0003` 03.03.2026:
   `AVR-00026/2025` (nastao 26.11.2025, vidljiv samo u PS) + `AVR-00003/2026` (nastao 25.02.2026).
4. **`AVR-00017/2025`** — najveći avans, **još otvoren**. `IZVOD/0131` 01.07.2025: 4300 DUG
   89.320.414,61 / POT 535.922.487,65; 4720 POT 89.320.414,61. Mesečni `PDV/0007` 31.07.:
   4720 DUG 89.344.128,11. Stanje 01.01.2026: otvoren u punom iznosu.

---

## 8. Pitanja za knjigovođu

Samo ono što se **ne može utvrditi iz podataka ni iz koda**. Sve ostalo je odgovoreno gore.

| # | Pitanje | Zašto pitamo | Blokira |
|---|---|---|---|
| **P1** | **Gde ide umanjenje PDV-a po avansu pri konačnom računu** — na `47200` → POPDV **3.2 negativno** (BigBitov model, saglasan sa našom POPDV mapom), ili na `4720` → **3.9 negativno**? Naš kod danas radi treće: dugovanje na 4720, koje se **ne vidi ni u jednom POPDV polju**. Traži se presuda uz citat Pravilnika za polje 3.9. | od toga zavisi i šema knjiženja i seed | **A2, C3** |
| **P2** | **Osnovica u POPDV/KIF: deliti iz PDV-a (`P/0.2`) kao BigBit, ili čitati iz poreske stavke?** Razlika je 0,01 na velikim iznosima (`AVR-00017/2025`: 446.602.073,05 vs …,04). Danas smo **nedosledni**: dokument nosi tačnu osnovicu, POPDV i KIF je dele. | dve istine o istom broju u istom sistemu | A3 |
| **P3** | **Ispravljamo li 4 mapiranja preslikana iz BigBita** (`2720 D/0.1`→`D/0.2`, `4710 3.9`→`3.2`, `2730` K3/K4, `27300 D/0.01`)? Trade-off: **tačan POPDV** vs **identičan izlaz kao BigBit** radi uporedivosti prijava tokom paralelnog rada. Danas su bez posledica (nema prometa po 10%). | naša preporuka: **ispraviti sada** | **A3** |
| **P4** | **Povraćaj avansa** — BigBit ima **0 knjiženja** na 4721 u dve godine, pa se postupak **ne može rekonstruisati iz podataka**. Kako se knjiži: stornira se samo PDV ili i osnovica? Kako se tretira kursna razlika kod deviznog? Ko traži izjavu primaoca (ZPDV čl. 21) i gde se čuva? | nema šta da se preslika — mora se projektovati | **D1** |
| **P5** | **Sme li AVR da se izda pre nego što je avans primljen?** Propis kaže da takav dokument **nije račun**. Predlog: AVR je nacrt bez broja dok se ne naplati. Ako knjigovodstvo insistira na ranijem broju — blokiramo bar štampu i SEF. | trošimo broj iz poreske serije | **B3** |
| **P6** | **Konto `4729` „PDV po primljenim avansima zatvaranje u ISTOM periodu"** — postoji u kontnom planu, **nije mapiran ni u jednoj godini, 0 knjiženja**. Da li se, kad naplata i konačni račun padnu u isti poreski period, uopšte prolazi kroz 4720/47200? Kod nas se danas **uvek** knjiže obe strane. | direktno vezano za pravilo istog perioda (§2.4) | C3 |
| **P7** | **Revalorizuje li se devizni avans?** `4300` (i budući `4302`) nisu u obuhvatu `fx-revaluation`. BigBit devizni avans drži samo na 4302 sa deviznim iznosom **u slobodnom tekstu opisa**. | bilansna pozicija | D4 |
| **P8** | **(za vlasnika)** Format `77/27` — potvrda da je to **odluka za 4.0** (povratak na format 2016–2024), a ne opis zatečenog stanja. Uz to: **ima li AVR svoju seriju** (kao kroz celu istoriju) ili ulazi u zajedničku seriju izlaznih računa `001/27…`? I ostaje li **bez vodećih nula**? | | **B1** |
| **P9** | **Šalje li Servoteh avansni račun na SEF?** Kod postoji (UBL 386), ali `BillingReference` je zakomentarisan, a na dokumentu `028/24` stoji **ručna beleška „NE ŠALJE SE NA SEF"**. Verovatno ručno kroz portal — nepotvrđeno. | | F2 |
| **P10** | **Je li `47250` (građevinarstvo) uopšte AVR?** Brojevi dokumenata su drugačiji (`'2/26'`, `'A-22-2026'`) i **u `T_Usluge dokumenta` ih nema** — knjiži se direktno u GK. Da li treba da postane dokument u 4.0 ili ostaje GK stavka? | | D2 |
| **P11** | **Ko i kada popunjava `TekstZaFakturu`** — vrednost je `'Račun'` na svih 1379 AVR. Default forme, migracioni artefakt, ili ručni unos? Ako je polje slobodno, moguće je da su ranije štampali sa drugim tekstom. Traži se **jedan uzorak odštampanog AVR-a iz Servoteha** da se izgled potvrdi 1:1 (i da se utvrdi je li `Radni fajlovi.Specijal` = `DEFAULT` ili `ABB`). | | F1 |

---

## Dodatak: šta nedostaje u izvorima

- **GK za septembar–decembar 2025 nije dostupna.** `BB_T_25.MDB` staje na 31.08.2025.
  Zatvaranja avansa `AVR-00019`, `00021`, `00022`, `00023`, `00024`, `00025` iz tog perioda nisu
  direktno vidljiva — znamo **samo iz PS 01.01.2026** da su zatvorena. Ako zatreba potpuna 2025,
  traži se dopunski izvoz sa `C:\SHARES\AcBaze\BigBit\TG\`.
- **`T_AVR_Usluge` nije resetovana po godini**, a `T_AVR_Roba` jeste — ID 2–18 se ponavljaju u obe
  baze, pa je 15 od 86 redova duplikat istog logičkog reda. Pri svakoj analizi tih tabela obavezna
  je deduplikacija (71 jedinstvena veza od 86 redova).

# BigBit — ULAZNE FAKTURE (UF / KUF): rekonstrukcija iz produkcijske baze i koda

> **Datum:** 2026-07-25 · **Autor:** analiza iz izvora, ne iz razgovora sa knjigovođom.
> **Izvori istine (svaka tvrdnja niže ima naveden izvor):**
> - `ubuntusrv:/tmp/bb26/BB_T_25.MDB` — **produkcijska baza 2025**, 311 MB, 201 tabela (mdbtools).
> - `ubuntusrv:/tmp/bb26/APL.MDB` — aplikacija (konfiguracija, `CFG_Apl_SviParametri`).
> - `_legacy/BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/*.txt` — VBA forme/moduli.
> - `_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/*.sql` — Access upiti (tela).
> - Ranije analize koje se **ne ponavljaju** ovde: [43-gl-posting-formule-A-Z-iz-koda.md](43-gl-posting-formule-A-Z-iz-koda.md)
>   (A–Z slova u šemama), [18-gl-pdv-kontiranje-rekonstrukcija.md](18-gl-pdv-kontiranje-rekonstrukcija.md),
>   [BB_T_26_klaster_C_finansije-pdv-gk.md](BB_T_26_klaster_C_finansije-pdv-gk.md), [30-glavna-knjiga-modul-dubinski.md](30-glavna-knjiga-modul-dubinski.md).

---

## 0. Glavni nalaz — pročitati pre svega ostalog

**BigBit NEMA jedinstven dokument „ulazna faktura".** Postoje **dva odvojena sveta**, a KUF (knjiga
ulaznih faktura) je **izvedeni izveštaj nad Glavnom knjigom**, ne tabela dokumenata:

| | Robne UF (roba / materijal) | Uvozne UF | Troškovne i uslužne UF |
|---|---|---|---|
| Nosilac dokumenta | `T_Robna dokumenta` (`Ulaz=True`), forma **`Ulazna faktura`** | isto (`UVOZ`) | **NEMA dokumenta** — kuca se direktno u GK nalog |
| Ima stavke (artikle)? | Da (`T_Robne stavke`) | Da | Ne |
| Knjiženje u GK | **automatsko** iz šeme kontiranja (`Opis naloga = "AUTO-ROBA"`) | **ručno** (`IDDokIzRobnog=0` na svih 1072 GK stavke) | ručno, red po red |
| 2025: dokumenata | 1.306 (UFROB 967 + UFMAT 339) | 111 | — |
| 2025: GK stavki dobavljača | 1.306 | 575 (inodobavljač + špediter + carina) | 2.396 |

Ukupno **4.277 ulaznih faktura** u 2025: **1.306 (30,5 %) automatski knjiženo**, **2.971 (69,5 %) ručno**.

**`T_PDV_UF` (30 kolona) je PRAZNA** — 0 redova i u `BB_T_25.MDB` i u `BB_T.MDB` (2026):

```
$ mdb-export BB_T_25.MDB 'T_PDV_UF' | wc -l   →  1   (samo header)
$ mdb-export BB_T_25.MDB 'T_PDV_IF' | wc -l   →  1   (samo header)
$ mdb-export BB_T_25.MDB 'T_PDV_GK' | wc -l   →  3651
$ mdb-export BB_T_25.MDB 'PDV_PPPDV' | wc -l  →  1   (prazna)
$ mdb-export BB_T_25.MDB 'PDV_UF_PU_MAP'      →  prazna
```

Stari mehanizam (forma `PDV_UF` + upiti `PDV_UknjiziIzRobnog_UF` / `PDV_UknjiziIzGK_UF` /
`PDV_UknjiziIzUSLUGA_UF` → `T_PDV_UF`) je **mrtav kod**. Živi put je:

```
T_Glavna knjiga (stavka)  ──JOIN po KONTU──►  PDV_SemeKontaZaKnjizenje  ──►  T_PDV_GK   (KUF/KIF)
                          ──JOIN po KONTU──►  POPDV_SemeKontaZaKnjizenje ──►  T_POPDV_GK (POPDV obrazac)
```

Potvrda iz konfiguracije aplikacije (`APL.MDB` → `CFG_Apl_SviParametri`):

```
"CFG_Global"|"PDVEvidencijaUF"|"APGK_PDVUF"|"String"|
"CFG_Global"|"PDVEvidencijaIF"|"APGK_PDVIF"|"String"|
```

a `APGK_PDVUF.sql` je samo filter nad GK-izvedenim pogledom:

```sql
-- APGK_PDVUF
SELECT APGK_PDV.* FROM APGK_PDV WHERE (((APGK_PDV.UF)=True));
```

**Posledica za 4.0:** naš model (`VatLedgerEntry` izveden iz `ledger_entries` preko `VatAccountMap`)
je **konceptualno ISPRAVAN i verniji BigBit-u nego što smo mislili**. Ono što nam fali nije PDV
evidencija — fali nam **dokument ulazne fakture** i nekoliko preciznih pravila (§7).

---

## 1. Tok kroz ekrane

### 1.1 Robna ulazna faktura (kalkulacija) — forma `Ulazna faktura`

Izvor: `_legacy/.../OnLine_BigBit_VBA/Doc__Form_Ulazna faktura.txt` (841 lin.) +
`Doc__Form_Ulazna faktura - Podforma.txt` (1436 lin.).

```
Meni → Ulazna faktura
  │
  ├─ zaglavlje (T_Robna dokumenta, Ulaz=True)
  │    Vrsta dokumenta ∈ {UFROB, UFMAT, UVOZ, UF, POVR}
  │    Broj dokumenta  = BROJ FAKTURE DOBAVLJAČA (slobodan tekst!)
  │    Datum dokumenta = datum fakture     → auto: Broj naloga = ObrniDatum(datum) = YYMMDD
  │    Datum valute    = rok plaćanja      → auto: DateAdd("d", [U roku dana], Datum dokumenta)
  │    Šifra komitenta = dobavljač         → PIB se validira
  │    Opis (30 zn.)   = BROJ(EVI) PREDMETA, slobodan tekst (v. §2.3)
  │
  ├─ stavke (T_Robne stavke): artikal, količina, nabavna cena neto, zavisni troškovi, tarifa
  │    ◄── „Proknjiži stavke iz porudžbine" (forma ProknjiziStavkeIzPorudzbineUUlazni) — v. §3
  │    ◄── „Proknjiži iz popisa" / „iz drugog ulaznog dokumenta"
  │    ◄── UVOZ: dugme „Unos uvoz" → forma UVOZStavke (carina, špedicija, kurs)
  │
  ├─ podforma AVR_Roba: vezivanje AVANSNIH RAČUNA dobavljača (T_AVR_Roba) — v. §5
  │
  └─ ZAKLJUČAVANJE (Z_Zakljucaj_UF / Z_Otkljucaj_UF) → Zakljucano=True, forma postaje read-only
       └─ noćno/na zahtev: NSK_OtvoriNalogeIzRobnog + NSK_ProknjiziStavkeIzRobnog → T_Glavna knjiga
```

**Obavezna polja (validacija `Form_BeforeUpdate`, `Doc__Form_Ulazna faktura.txt:411-434`):**

```vb
Private Sub Form_BeforeUpdate(Cancel As Integer)
    If IsNull(Me![Broj dokumenta]) Then
        MsgBox ("Morate uneti broj dokumenta!") : DoCmd.CancelEvent
    ElseIf IsNull(Me![Datum dokumenta]) Then
        MsgBox ("Morate uneti datum dokumenta") : DoCmd.CancelEvent
    ElseIf IsNull(Me![Broj naloga]) Then
        MsgBox ("Morate uneti broj naloga!") : DoCmd.CancelEvent
    ElseIf Not DobarPIB(Nz(Me!PIB, "-")) And Not Me.NeProveravajPIB Then
        MsgBox ("PIB komitenta je neispravan!") : DoCmd.CancelEvent
    End If
End Sub
```

Na stavci (`Doc__Form_Ulazna faktura - Podforma.txt:468-503`): količina ≠ 0, `Nabavna cena - neto` > 0,
`Kalkulativna VP cena` > 0, i (ako je uključena provera) zaliha ne sme da ode ispod nule.

**Automatika datuma** (`Doc__Form_Ulazna faktura.txt:18-34`):

```vb
Private Sub Datum_dokumenta_AfterUpdate()
    If IsNull(Me![Datum valute]) And Not IsNull(Me![Datum dokumenta]) Then
            Me![Datum valute] = DateAdd("d", NullToZero(Me![U roku dana]), Me![Datum dokumenta])
    End If
    Me![U roku dana] = RastojanjeIzmedjuDatuma(Me![Datum dokumenta], Me![Datum valute])
    Me![Broj naloga] = ObrniDatum(Me![Datum dokumenta])
End Sub
```

### 1.2 Troškovna / uslužna ulazna faktura — forma `Unos naloga glavne knjige` (`GKNalog`)

Izvor: `APL.MDB` → `CFG_Apl_SviParametri`:
```
"CFG_Global"|"UnosNalogaGK_FormName"|"GKNalog"|"String"|"[GKNalog], [Unos naloga glavne knjige]"
```
VBA: `Doc__Form_PDVStavkeNaloga.txt` (podforma „Stavke naloga") + `Doc__Form_Stavke naloga.txt`.

```
Meni → Unos naloga glavne knjige
  │   zaglavlje T_Nalozi: Broj naloga, Vrsta naloga (TROS/BPDV/TROS1/UVOZ/NALOG), Datum naloga,
  │                       Datum knjizenja, Zakljucano, Level, Potpis
  │
  └─ podforma „Stavke naloga" → T_Glavna knjiga, red po red:
        Konto · Analiticka sifra (=komitent) · Broj dokumenta (=broj fakture dobavljača)
        Datum dokumenta (=datum fakture) · Valuta dokumenta (=rok) · Duguje/Potrazuje
        Pozicija (=KANAL dokumenta, v. §4.4) · Dev* + Kurs (za devizne)
        └─ ako konto ima PDV šemu → podforma `PDVStavkeNalogaPodforma` se AUTO-popuni
```

Validacija reda (`Doc__Form_PDVStavkeNaloga.txt:481-499`):

```vb
Private Sub Form_BeforeUpdate(Cancel As Integer)
    If Nz(Forms![Unos naloga glavne knjige].Zakljucano, False) Then
        MsgBox ("Nalog je zakljucan!") : DoCmd.CancelEvent
    ElseIf (NullToZero(Me![Duguje]) = 0#) And (NullToZero(Me![Potrazuje]) = 0#) Then
        DoCmd.CancelEvent
        MsgBox ("Unesite neku vrednost u polja DUGUJE ili POTRAZUJE ili ponistite unos!")
        DoCmd.GoToControl "Duguje"
    ElseIf IsNull(Me![Broj dokumenta]) And (Specijal = "PROKOMERC") Then
        DoCmd.CancelEvent
        MsgBox ("Morate uneti broj dokumenta!")
    End If
End Sub
```

> ⚠️ **Broj dokumenta NIJE obavezan kod Servoteha** — provera važi samo za instalaciju `Specijal="PROKOMERC"`.
> U praksi je ipak popunjen **4277/4277 (100 %)** u 2025 (disciplina operatera, ne sistem).

Auto-popuna PDV podreda (`Doc__Form_Stavke naloga.txt:483-519`) — isti izraz kao serverski upit:

```vb
If Me!ImaPDVSemu Then
    Me!PDVStavkeNalogaPodforma.Form!DatPorPerioda = Me![Datum dokumenta]
    Me!PDVStavkeNalogaPodforma.Form!PDVEvidencija = Me!PDVEvidencija
    ...
    If Me!DugPot Then Iznos = Me!Duguje Else Iznos = Me!Potrazuje
    If Me!PDVOsnovica Then
     Osnovica = Round(Iznos, 2) : PDV = Round(Osnovica * (Me!PDVStopa / 100), 2)
    Else
     PDV = Round(Iznos, 2) : Osnovica = Round(PDV / (Me!PDVStopa / 100), 2)
    End If
```

### 1.3 Formiranje KUF-a — forma `APGK` + `APGK_PDVProvera`

**KUF se NE gradi automatski — knjigovođa ga pokreće ručno**, nad filtriranim opsegom.

```
Meni → APGK (Analitika/Pregled Glavne Knjige)
  │   filteri: OdDatumaDok/DoDatumaDok, OdDatumaNaloga/DoDatumaNaloga, ZaKonto1, ZaKomitenta,
  │            ZaBrojNaloga, ZaVrstuNaloga, ZaVrstuKomitenta, OdDatumaValute/DoDatumaValute,
  │            OdDatumaPorPerioda/DoDatumaPorPerioda, ZaPDVEvidenciju, OdLevel/DoLevel
  │
  ├─ tab „Provera" (APGK_PDVProvera): lista GK stavki koje IMAJU PDV šemu a NISU u T_PDV_GK
  │     └─ dugme „Upiši u PDV po šemi" → APGK_PDV_Provera_UpisiUPDVEvidenciju  (INSERT)
  │
  ├─ tab „PDV UF" (APGK_PDVUF): knjiga ulaznih faktura → štampa APGK_PDV_UF / APGK_PDV_UF_POLJO
  │
  └─ tab POPDV: POPDV_Neproknjizeno → POPDV_Neproknjizeno_Proknjizi → T_POPDV_GK
        └─ POPDV obrazac + evidentirana prijava (T_POPDV_EvidentiranePrijave_Zag/_Stavke)
```

Okidač (`Doc__Form_APGK_PDVProvera.txt`):

```vb
Private Sub DugmeUpisiUPDVPoSemi_Click()
    Dim stDocName As String
    stDocName = "APGK_PDV_Provera_UpisiUPDVEvidenciju"
    DoCmd.OpenQuery stDocName, acNormal, acEdit
    Me.Requery
End Sub
```

### 1.4 Statusi i ko ih menja

| Objekat | Polje | Vrednosti | Ko menja |
|---|---|---|---|
| `T_Robna dokumenta` | `Zakljucano` | 0/1 | operater preko `Z_Zakljucaj_UF` / `Z_Otkljucaj_UF` (zasebne forme = tačka za prava pristupa) |
| `T_Robna dokumenta` | `Potpisano`, `Potpis`, `DatumIVreme` | tekst/datum | sistem (`PotpisiDok`) |
| `T_Nalozi` | `Zakljucano` | 0/1 | knjigovođa; blokira izmenu SVIH stavki naloga |
| `T_Nalozi` / `T_Glavna knjiga` | `Level` | Byte | nivo baze (konsolidacija/više baza), filter `Between OdLevel And DoLevel` |
| `T_PDV_GK` | — | **nema status** | red postoji ili ne postoji; „proknjiženo u PDV" = postojanje reda |

> **NEPOZNATO:** ne postoji polje „primljeno/likvidirano/odobreno za plaćanje". Ne postoji workflow
> odobravanja ulazne fakture ni evidencija datuma **prijema** dokumenta (samo datum fakture).
> Ne postoji ni „storniran" flag — storno se radi negativnim iznosima (29 stavki u 2025, §6.6).

---

## 2. Šema tabela — kolone koje nose značenje

### 2.1 `T_Robna dokumenta` — zaglavlje robne UF (`Ulaz = True`)

Popunjenost merena nad **1417 ulaznih dokumenata 2025** (UFROB+UFMAT+UVOZ):

| Kolona | Tip | Značenje | Popunjeno |
|---|---|---|---|
| `IDDok` | Long | PK; na njega pokazuje `T_Glavna knjiga.IDDokIzRobnog` | — |
| `Ulaz` | Bool | **True = ulazni dokument** | 1417 |
| `Vrsta dokumenta` | Text(5) | `UFROB`/`UFMAT`/`UVOZ`/`UF`/`POVR` → bira šemu kontiranja | 1417 |
| `Broj dokumenta` | Text(20) | **BROJ FAKTURE DOBAVLJAČA**, slobodan tekst (`FA-327-0/25`, `IF25-0255`, `0115/25`) | **1417 (100 %)** |
| `Datum dokumenta` | Date | datum fakture dobavljača = **poreski period** | 1417 |
| `Datum valute` | Date | **rok plaćanja** | **1417 (100 %)** |
| `Sifra komitenta` | Long | dobavljač (`Komitenti.Sifra`) | 1417 |
| `Broj naloga` + `Vrsta naloga` | Text | ciljni GK nalog (`YYMMDD`, npr. `250130`) | 1417 |
| `Opis` | Text(30) | **broj(evi) PREDMETA, slobodan tekst** (v. §2.3) | 780 (55 %) |
| `IDRadniNalog` | Long | veza na radni nalog | 506 (36 %) |
| `IDPredmet` | Long | strukturna veza na predmet | **0 (0 %) — NE KORISTI SE** |
| `IDDokUF` / `IDDokIF` / `IDDokUSL` | Long | veze na druge dokumente | **0 / 1 / 0 — NE KORISTE SE** |
| `Kurs`, `ObrKurs`, `CarKurs` | Double | kurs fakture / obračunski / carinski | 1417 |
| `DevVredFak` | Double | devizna vrednost fakture | 111 (= svi UVOZ) |
| `OstaliZavTros` | Double | ostali zavisni troškovi | 111 (= svi UVOZ) |
| `Carina`, `Spedicija` | Double | zasebna polja | **0 — ne koriste se** (sve ide u `OstaliZavTros`) |
| `Zakljucano` | Bool | zaključan dokument | 917 (65 %) |
| `Nacin placanja`, `UsloviPlacanja`, `Broj izjave`, `IDTrebZaProizvodnju` | | | **0 — mrtva polja** |

### 2.2 `T_Glavna knjiga` — nosilac troškovne UF i svih PDV podataka

Kolone bitne za ulaznu fakturu (`mdb-schema -T 'T_Glavna knjiga'`):

| Kolona | Značenje u kontekstu UF |
|---|---|
| `StavkaID` | PK; **ključ na koji se kači cela PDV evidencija** (`T_PDV_GK.StavkaID`, `T_POPDV_GK.StavkaID`) |
| `Konto` | **jedini determinator PDV tretmana** (§4.1) |
| `Analiticka sifra` | dobavljač (`Komitenti.Sifra`) — **INNER JOIN, bez njega stavka ne ulazi u KUF** |
| `Broj dokumenta` | broj fakture dobavljača |
| `Datum dokumenta` | datum fakture → **`DatPorPerioda`** |
| `Valuta dokumenta` | **rok plaćanja** (otvorene stavke / priprema plaćanja) |
| `Datum knjizenja` | datum knjiženja (≠ poreski period) |
| `Duguje` / `Potrazuje` | **oba mogu biti popunjena na ISTOJ stavci** (koristi se kod avansa, §5.1) |
| `Pozicija` | Text(10) — **prenamenjeno: KANAL dokumenta za KUF** (§4.4) |
| `IDDokIzRobnog` | veza na `T_Robna dokumenta.IDDok` (popunjeno samo za UFROB/UFMAT) |
| `IDPredmet`, `IDRadniNalog` | **0 na svim UF stavkama 2025** |
| `Temeljnica` | `"-"` konstanta iz auto-knjiženja |
| `DevDuguje`/`DevPotrazuje`/`DevValuta` | devizni iznos (uvoz) |
| `Potpis`, `DatumIVreme` | audit |

### 2.3 Nalaz: veza UF ↔ PREDMET je SLOBODAN TEKST

`T_Robna dokumenta.IDPredmet = 0` na **svih 1417** ulaznih dokumenata 2025, a
`T_Glavna knjiga.IDPredmet = 0` na svim UF stavkama. Umesto toga, projekat se upisuje u
`T_Robna dokumenta.Opis` (30 znakova) kao slobodan tekst. Merenje (skript nad izvozom):

```
Ulaznih robnih dok 2025: 1417; sa popunjenim Opis: 780
Razlicitih tokena u Opis: 73; od toga postoji kao Predmeti.BrojPredmeta: 39
Pokrivenost pojavljivanja: 794/985 = 80.6 %

  7918   x412  PREDMET: Repro                 9294  x40  PREDMET: (bez naziva)
  9219   x 92  PREDMET: Renoviranje Fom-a     8069  x25  PREDMET: linija za sužavanje
  7349   x 24  PREDMET: Lola 1000t            7701  x21  PREDMET: Linije za termičku obradu otkovaka
  8034   x 16  PREDMET: Servotransfer presa broj 7
  „za" x69, „lager" x50  (nisu predmeti)
Tokeni koji NISU predmet: 7918-, 7918-za, 7918M, 9667-GOODYEAR, ALI, FIZIČKI, NA, RB,
                          „7351 ALI FIZIČKI NA 9000", „Voštić-privatno", „Igor", „Indija" …
```

**Zaključak:** alokacija ulaznog troška na predmet u BigBit-u je **nestrukturirana i nepouzdana**
(19 % tokena nisu validni predmeti; 45 % dokumenata nema nikakvu oznaku). To je **prilika**, ne
paritetni zahtev — u 4.0 treba prava veza `stavka UF → predmet` (postoji `LedgerEntry.sourceProjectId`).

### 2.4 PDV registri (mala, ali kritična konfiguracija)

```sql
CREATE TABLE [PDV_SemeKontaZaKnjizenje]      -- 20 redova; KONTO → PDV knjiga
 ( [Konto] Text(10), [PDVEvidencija] Text(10), [DugPot] Boolean, [PDVStopa] Currency,
   [PDVOsnovica] Boolean, [ObracunPDVOsnovica] Boolean, [ObracunPDVIznos] Boolean,
   [PDVGrupa] Text(10), [AOP_POPDV] Text(10) );

CREATE TABLE [PDV_Knjige]                    -- 17 redova; koja evidencija je UF a koja IF
 ( [PDVEvidencija] Text(10), [Naziv] Text(120), [AOPOsnovica] Text(5), [AOPIznosPDV] Text(5), [UF] Boolean );

CREATE TABLE [T_PDV_GK]                      -- 3650 redova 2025; SAMA KUF/KIF EVIDENCIJA
 ( [ID] Long, [StavkaID] Long, [DatPorPerioda] DateTime, [PDVEvidencija] Text(10),
   [PDVStopa] Currency, [PDVOsnovica] Currency, [ObracunPDVOsnovica] Boolean,
   [PDVIznos] Currency, [ObracunPDVIznos] Boolean, [PDVGrupa] Text(10) );

CREATE TABLE [POPDV_SemeKontaZaKnjizenje]    -- 78 redova; KONTO → POPDV oznaka + formule kolona
 ( [Konto] Text(10), [PDVOznaka] Text(10), [K1Def] Text(100), [K2Def]/[K3Def]/[K4Def] Text(255) );

CREATE TABLE [T_POPDV_GK]                    -- 5132 reda 2025
 ( [StavkaID] Long, [PDVOznaka] Text(10), [DatPorPerioda] DateTime,
   [K1Iznos], [K2Iznos], [K3Iznos], [K4Iznos] Currency );
```

`PDV_Knjige` — sve UF evidencije (kolona `UF=1`) i njihova AOP polja na obrascu PPPDV:

```
PDVEvidencija,Naziv,AOPOsnovica,AOPIznosPDV,UF
"POLJO","POLJOPRIVREDNICI","007","107",1
"UF","UF-Prethodni porez,osim prethodnog poreza sa red. br. 6 i 7.","008","108",1
"UF-BEZPRAV","UF Bez prava na odbitak PDV","008","000",1
"UF-DATAVAN","UF-DATI AVANSI","000","108",1
"UFINT-OPST","UF Interni obracun po OPSTOJ stopi","-","108",1
"UF-NEPODLE","Uf od dobavljaca cija usluga ne podleze PDV","008","000",1
"UF-NIJEPDV","Uf od dobavljaca koji nisu u pdv-u","008","000",1
"UVOZ","Prethodni porez placen prilikom uvoza","006","106",1
```

### 2.5 `T_ER_DokumentaNabavke` — SEF inbox ulaznih e-faktura (10.873 reda)

```sql
CREATE TABLE [T_ER_DokumentaNabavke]
 ( [ID], [IDFirma], [PurchaseInvoiceID] Text(50), [InvoiceID] Text(50), [SalesInvoiceID] Text(50),
   [Sifra komitenta] Long, [Naziv] Text(150), [PIB] Text(30), [TipDokumenta] Text(20),
   [Broj dokumenta] Text(50), [Datum dokumenta], [Datum slanja], [Datum prometa], [Datum valute],
   [Iznos] Double, [SEFStatus] Text(20), [Comment], [GlobalUID], [LastModifiedUTC],
   [PrviUnos], [PoslednjaIzmena], [Status] Text(20) );
```

Sadržaj (cela tabela, sve godine):

```
TipDokumenta: Faktura=10238, Avansni račun=582, Knjižno Odobrenje=50, Knjižno Zaduženje=3
SEFStatus:    Approved=10773, Storno=56, Seen=32, Rejected=9, ReNotified=2
Status:       Odobrena=10770, Nova=103
po godini:    2023=1550, 2024=5535, 2025=3788
```

> **Ovo je zasebna evidencija bez veze sa knjiženjem.** Nema kolone ka `T_Robna dokumenta` ni ka
> `T_Glavna knjiga.StavkaID`. Uparivanje SEF ↔ knjiženo radi čovek očima.

---

## 3. Veza sa robnim ulazom i narudžbenicom

### 3.1 UF ↔ robni ulaz — **jesu ISTI dokument**

Za robu/materijal ne postoje dva dokumenta. `T_Robna dokumenta` vrste `UFROB`/`UFMAT` je istovremeno
prijemnica, kalkulacija **i** ulazna faktura — naziv vrste to i kaže: `UFROB` = „ULAZ ROBE U MAGACIN",
a `TextZaReport` za vrstu `UF` je doslovno `"Kalkulacija"` (`R_Vrste dokumenata`).

Povratna veza iz GK: `T_Glavna knjiga.IDDokIzRobnog`. Popunjenost po vrsti naloga (2025):

```
vrsta      n  IDDokIzRobnog  IDDokIzUsluga  Analiticka  Pozicija  Temeljnica
UFROB   2900           2896              0        2900      2623        2896
UFMAT   1018           1017              0        1018       888        1017
UVOZ    1072              0              0        1060       798           1
TROS    4391              0              0        4391      4387           0
BPDV    1774              0              0        1774      1768           0
TROS1    510              0              0         510       510           0
```

→ **UFROB/UFMAT: 99,9 % vezano na robni dokument. TROS/TROS1/BPDV/UVOZ: 0 % — nema dokumenta iza.**

Iz forme se skače na izvor (`Doc__Form_PDVStavkeNaloga.txt:658-687`):

```vb
Private Sub DugmeRobniDokument_Click()
    If Nz(Me![IDDokIzRobnog], 0) > 0 Then
        UF = DLookup("[Ulaz]", "Robna dokumenta", "[IDDok] = " & Me![IDDokIzRobnog])
        If UF Then stDocName = "Ulazna faktura" Else stDocName = "Izlazna faktura"
        stLinkCriteria = "[IDDok]=" & Me![IDDokIzRobnog]
        BBOpenForm stDocName, , , stLinkCriteria
    ElseIf Nz(Me!IDDokIzUsluga, 0) > 0 Then
        stDocName = "USLUGA faktura" : ...
    Else
        MsgBox "Ne postoji dokument iz kojeg je proknjizena ova stavka."
    End If
```

### 3.2 UF ↔ narudžbenica — **veza postoji samo kao „prepiši stavke", i to na nivou STAVKE**

BigBit **nema** polje `T_Robna dokumenta → narudžbenica`. Veza je jednosmerni prepis pri unosu:

Forma `ProknjiziStavkeIzPorudzbineUUlazni` (`Doc__Form_ProknjiziStavkeIzPorudzbineUUlazni.txt`):

```vb
    If Forms![Ulazna faktura]![Vrsta dokumenta - lista] Like "UVOZ" Then
        DocName = "ProknjiziStavkeIzPorudzbineUUVOZ"
    Else
        DocName = "ProknjiziStavkeIzPorudzbineUUlazni"
    End If
    DoCmd.OpenQuery DocName, A_NORMAL, A_EDIT
```

Upit (`queries_full/OnLine_BigBit_APL/ProknjiziStavkeIzPorudzbineUUlazni.sql`) — jedini trag porekla:

```sql
INSERT INTO [Robne stavke] ( IDDok, [Sifra artikla], Kolicina, ..., IDPredmetStavka, IDPrepisaneStavke )
SELECT CLng([Forms]![Ulazna faktura]![IDDok]), [Trebovanja stavke].[Sifra artikla],
       [Trebovanja stavke].IsporucenaKolicina, ..., [Trebovanja stavke].IDPredmet,
       -[IDStavke] AS Expr17
FROM ... WHERE ((([Trebovanja stavke].IsporucenaKolicina)<>0)
            AND (([Trebovanja stavke].IDTreb)=[Forms]![ProknjiziStavkeIzPorudzbineUUlazni]![IzIDDok]))
```

**Ključ veze: `T_Robne stavke.IDPrepisaneStavke = −[Trebovanja stavke].IDStavke`** (negativan ID =
poreklo iz trebovanja/narudžbenice), a količina se uzima iz `IsporucenaKolicina`.

**Odgovor na otvoreno pitanje:** BigBit **NE radi 3-way match**. Nema polja „fakturisano" na
narudžbenici, nema tolerancija, nema blokade plaćanja. Cena i količina se **prepišu** sa narudžbenice
u kalkulaciju i onda ih operater **ručno prekuca po fakturi dobavljača**. Jedini trag da je stavka
došla sa narudžbenice je negativan `IDPrepisaneStavke`, i **on se ne koristi ni u jednoj kontroli**.

> Naš 4.0 `three-way-match.service.ts` je time **funkcionalni PLUS iznad BigBit-a**, ne paritet.

---

## 4. KNJIŽENJE — konkretna konta

### 4.1 Mehanizam: KONTO je jedini determinator PDV tretmana

`PDV_SemeKontaZaKnjizenje` — **cela tabela iz produkcije 2025** (`mdb-export BB_T_25.MDB`):

```
Konto,PDVEvidencija,DugPot,PDVStopa,PDVOsnovica,ObracunPDVOsnovica,ObracunPDVIznos,PDVGrupa,AOP_POPDV
"2050","IZVOZ",     1, 0.0000,1,1,0,"BEZPDV",
"2700","UF",        1,20.0000,0,1,1,"VISA",
"2701","UF",        1,20.0000,0,1,1,"VISA",
"2705","UFINT-OPST",1,20.0000,0,0,1,"VISA",
"2710","UF",        1,10.0000,0,1,1,"NIZA",
"2720","UF-DATAVAN",1,20.0000,0,0,1,"VISA",
"2730","UF-DATAVAN",1,10.0000,0,0,1,"NIZA",
"2740","UVOZ",      1,20.0000,0,1,1,"VISA",
"2750","UVOZ",      1,10.0000,0,1,1,"NIZA",
"2760","UF",        1,20.0000,0,1,1,"VISA",
"2780","POLJO",     1, 8.0000,0,0,1,"POLJO",
"4331","POLJO",     0, 8.0000,1,1,0,"POLJO",
"4700","IF-OPSTA",  0,20.0000,0,1,1,"VISA",
"4701","IFINT-OPST",0,20.0000,0,0,1,"VISA",
"4702","IFINT-OPST",0,20.0000,0,0,1,"VISA",
"4710","IF-POSEBNA",0,10.0000,0,1,1,"NIZA",
"4720","IFAV-OPSTA",0,20.0000,0,0,1,"VISA",
"4730","IFAV-POSEB",0,10.0000,0,0,1,"NIZA",
"4760","IF-OPSTA",  0,20.0000,0,1,1,"VISA",
"4761","IF-POSEBNA",0,10.0000,0,1,1,"NIZA",
```

Semantika kolona:
- **`DugPot`** — 1 ⇒ uzmi `Duguje`, 0 ⇒ uzmi `Potrazuje`. Svi ULAZNI konti imaju `DugPot=1`.
- **`PDVOsnovica`** — 1 ⇒ iznos na kontu JE osnovica; 0 ⇒ iznos na kontu JE PDV, osnovica se **deli**.
  Svi pretporezni konti imaju `PDVOsnovica=0` (jer na 2700 stoji sam PDV).
- **`ObracunPDVOsnovica` / `ObracunPDVIznos`** — da li osnovica/PDV ulazi u kolonu „**koristi**"
  (odbitno) ili „**ne koristi**" u KUF izveštaju.
- **`PDVGrupa`** — `VISA` (20 %) / `NIZA` (10 %) / `POLJO` (8 %) / `BEZPDV`.

### 4.2 Konta iz `Kontni plan` (1356 redova) — sva relevantna za UF

**Pretporez (klasa 27):**
```
"2700","PDV u primljenim fakturama 20%"
"2701","PDV 20% - INTERNI RACUN LICENCE  - bez osnovice"
"2704","PDV prethodni koji se ne moze koristiti 20%"          ← NIJE u PDV šemi (§4.5)
"2705","PDV 20% - INTERNI RACUN GRADJEVINARSTVO  - bez osnovice"
"2709","PDV IZ PRETHODNE GODINE 20%"
"2710","PDV u primljenim fakturama10%"
"2714","Nepriznat pdv 10 %"                                   ← NIJE u PDV šemi
"2719","PDV IZ PRETHODNE GODINE  10%"
"2720","PDV u datim avansima 20%"
"27200","PDV u datim avansima 20% - ZATVARANJE AVANSA IZ PRETH.PERIODA"   ← NIJE u PDV šemi
"2730","PDV u datim avansima 10%"
"2740","PDV plaćen pri uvozu dobara 20%"
"2750","PDV plaćen pri uvozu dobara10%"
"2760","PDV obračunat na usluge inostranih lica 20%"
"2780","Potraživanja za više plaćen PDV po drugim osnovama"   (POLJO 8%)
```

**Dobavljači (klasa 43) — realno u upotrebi:**
```
"4350","DOBAVLJACI  U ZEMLJI"          ← 3998 stavki 2025 (93,5 %)
"4360","DOBAVLJACI U INOSTRANSTVU"     ←  279 stavki 2025 ( 6,5 %)
"4331","Dobavljači u zemlji za nefakturisane obaveze"   (POLJO protivstavka)
"43301","Ostali dobavljači - struja, telefon, grejanje..."
"4300","Primljeni avansi, depoziti i kaucije"   (IZLAZNI avansi — ne meša se sa datim!)
```
> Standardna konta 4330/4310/4320/4340/4341 postoje u planu ali su **neiskorišćena** —
> Servoteh koristi samo **4350 i 4360**.

**Zalihe / trošak (protivstavka):**
```
"1010" materijal · "1320" roba · "1520" Placeni avansi za robu u zemlji
"1521" Placeni avansi za robu u zemlji bez PDV
51xx/53xx/55xx — troškovi (5113, 5120-5128, 5130, 5300, 5310-5322, 5342, 5390, 5391, 53000, 53220 …)
"0230" oprema (uvoz OS) · "2899" AVR/razgraničenja · "5630"/"6630" kursne razlike-zaokruženje
```

### 4.3 Šeme kontiranja iz baze (`Sema za kontiranje` + `Stavke seme za kontiranje`)

Slova A–Z su dokumentovana u [43-gl-posting-formule-A-Z-iz-koda.md](43-gl-posting-formule-A-Z-iz-koda.md)
(**A**=neto nabavna, **B**=zav. trošak sopstveni, **C**=zav. trošak dobavljača, **D**=ulazni PDV 20 %,
**E**=ulazni PDV 10 %, **O**=neto izlaz, **P**=izlazni PDV 20 %). Ovde su **doslovni redovi iz BB_T_25**:

```
### SEMA 3 = 'UFROB' (Ulaz robe)                 ### SEMA 34 = 'UFMAT' (UFMAT)
  Konto   DefDug         DefPot                    Konto   DefDug   DefPot
  1320    A+B+C          0                         4350    0        A+D+E
  2700    D              0                         2700    D        0
  4350    0              A+B+C+D+E                 1010    A        0
  2710    E              0                         2710    E        0

### SEMA 32 = 'UVOZ' (UVOZ)                      ### SEMA 39 = 'AVR' (AVANSNI RACUN)
  Konto   DefDug   DefPot                          Konto   DefDug   DefPot
  4360    0        A                               4300    0        O+P
  2740    D        0                               4720    0        P
  1320    A        0                               4300    P        0

### SEMA 31 = 'KNO' (Knjizno odobrenje)          ### SEMA 28 = 'KNZ' (Knjižno zaduženje)
  2020    -O-P-Q   0      Kupac                    20200   0+P+Q    0
  470     0        -P     PDV 18%
  471     0        -Q     PDV 8%
  6120    0        -O     Prihodi od prodaje
```

> ⚠️ **KNO/KNZ šeme su za KUPCE (2020/6120), ne za dobavljače.** BigBit **nema šemu za knjižno
> odobrenje DOBAVLJAČA** — ono se knjiži ručno (§6.6).

Veza vrsta dokumenta → šema (`R_Vrste dokumenata`):
```
"UF",   "Ulazna faktura",           Ulazni=1, Sema=0,  KnjizitiUPDVEvidenciju=1, TextZaReport="Kalkulacija"
"UFROB","ULAZ ROBE U MAGACIN",      Ulazni=1, Sema=3,  KnjizitiUPDVEvidenciju=1, Magacin=1
"UFMAT","ULAZ MATERIJALA U MAGACIN",Ulazni=1, Sema=34, KnjizitiUPDVEvidenciju=1, Magacin=2
"UVOZ", "Uvoz",                     Ulazni=1, Sema=0,  KnjizitiUPDVEvidenciju=1, KEPU zad="A"/razd="0"
"UFUSL","Usluge ulaz",              Ulazni=0, Sema=0,  KnjizitiUPDVEvidenciju=1
"POVR", "Povratnica robe DOBAVLJAČU",Ulazni=0,Sema=0,  KnjizitiUPDVEvidenciju=1
"AVR",  "Avansni račun",            Ulazni=0, Sema=39, KnjizitiUPDVEvidenciju=0, prefiks="AR-"
```

### 4.4 STVARNI obrasci knjiženja iz produkcije 2025

Svi primeri su doslovni ispisi iz `T_Glavna knjiga` + `T_PDV_GK`.

#### A) `UFROB` — ulaz robe (967 faktura). Nalog: 1/dan, `Broj naloga=YYMMDD`, `Opis="AUTO-ROBA"`

```
Nalog 250130 | vrsta=UFROB | dat.naloga=01/30/25 | zakljucano=1 | opis: AUTO-ROBA
  Konto   Komitent            BrDok           DatDok    Valuta         Duguje    Potrazuje  IDRobno
  1320    Gem-Lager doo       FA-71-0/25      01/30/25  02/09/25    22,950.00         0.00    37556
  2700    Gem-Lager doo       FA-71-0/25      01/30/25  02/09/25     4,590.00         0.00    37556
        → PDV_GK: evid=UF grupa=VISA stopa=20.00 osnovica=22,950.00 iznos=4,590.00 DatPorPer=01/30/25
  4350    Gem-Lager doo       FA-71-0/25      01/30/25  02/09/25         0.00    27,540.00    37556
```
Agregat 2025: `1320` D 173.393.010,35 · `2700` D 34.637.740,05 · `4350` P 208.030.748,28 (po 967 stavki).

#### B) `UFMAT` — ulaz materijala (339 faktura)

```
Nalog 250110 | vrsta=UFMAT | dat=01/10/25 | opis: AUTO-ROBA
  1010    Atenic commerce d.o.o.  2500132   01/10/25  02/24/25   514,215.98        0.00   37363
  2700    Atenic commerce d.o.o.  2500132   01/10/25  02/24/25   102,843.20        0.00   37363
        → PDV_GK: evid=UF grupa=VISA stopa=20 osnovica=514,216.00 iznos=102,843.20
  4350    Atenic commerce d.o.o.  2500132   01/10/25  02/24/25         0.00  617,059.18   37363
```
Agregat 2025: `1010` D 154.135.662,56 · `2700` D 30.827.132,23 · `4350` P 184.962.793,53.

#### C) `TROS` / `TROS1` — troškovne i uslužne UF (1416 + 170 faktura) — **RUČNO, bez dokumenta**

Jedan mesečni nalog nosi stotine faktura (npr. `TROS` nalog `0002` za februar = **663 stavke**):

```
  4350  Axiom tech d.o.o.  2025-65        02/03/25  02/17/25        0.00   40,440.80
  2700  Axiom tech d.o.o.  2025-65        02/03/25  02/17/25    6,740.13        0.00
        → PDV_GK: evid=UF grupa=VISA stopa=20 osn=33,700.65 iznos=6,740.13 DatPorPer=02/03/25
  5320  Axiom tech d.o.o.  2025-65        02/03/25  02/17/25   33,700.67        0.00
  ---
  4350  Kvatro d.o.o.      FAVP-243-0/25  02/03/25  02/08/25        0.00   38,763.76
  2700  Kvatro d.o.o.      FAVP-243-0/25  02/03/25  02/08/25    6,460.63        0.00
  5125  Kvatro d.o.o.      FAVP-243-0/25  02/03/25  02/08/25   32,303.13        0.00
```
Obrazac: **`4350` P (bruto) · `2700` D (PDV) · `5xxx` D (neto trošak)**, uvek u trojkama, ručno.
Agregat `TROS` 2025: `4350` P 84.221.449,38 · `2700` D 13.940.433,26 · `2710` D 47.077,73 ·
najčešći troškovni konti `5113` (533×), `5390` (157×), `5300` (117×), `5133` (95×), `5128` (85×),
`5320` (74×), `5322` (68×), `5120` (66×).

#### D) `UVOZ` — uvozna faktura (575 stavki dobavljača, 111 robnih dok.)

```
Nalog 0004 | vrsta=UVOZ | dat=01/14/25 | potpis=anag
  4360  Meusburger Georg GmbH   202/11709639  01/14/25 03/15/25       0.00  146,521.87  opis: 1251*117.1238
  4350  Gebruder Weiss d.o.o.   37360645      01/11/25 02/14/25       0.00    6,600.00  (špedicija)
  2700  Gebruder Weiss d.o.o.   37360645      01/11/25 02/14/25   1,100.00        0.00
        → PDV_GK: evid=UF   osn=5,500.00  iznos=1,100.00
  4350  Uprava carina RS        000678        01/14/25 01/14/25       0.00   29,304.50
  2740  Uprava carina RS        4504-000678   01/14/25 01/14/25  29,304.37        0.00
        → PDV_GK: evid=UVOZ osn=146,521.85 iznos=29,304.37   ← osnovica = CARINSKA vrednost
  1320  Meusburger Georg GmbH   202/11709639  01/14/25 03/15/25 152,021.87        0.00   ← nabavna+špedicija
  5630  Meusburger Georg GmbH   -             01/14/25 01/14/25       0.13        0.00   (zaokruženje)
```
Pravila koja se vide iz podataka:
- Inodobavljač ide na **`4360`**, `Opis dokumenta` nosi **računicu preračuna** (`1251*117.1238` = deviza×kurs).
- **Uvozni PDV (`2740`) se duguje CARINI, ne dobavljaču** — protivstavka je `4350` na komitentu
  „Uprava carina Republike Srbije" (šifra 12067).
- Osnovica za `UVOZ` evidenciju je **carinska osnovica**, ne fakturna.
- Špedicija (Gebruder Weiss, Lagermax) je **posebna domaća UF** sa svojim `2700`.
- `1320` = **nabavna vrednost uvećana za zavisne troškove** (landed cost).
- Agregat 2025: `4360` P 109.930.571,19 · `4350` P 29.904.790,41 · `2740` D 22.579.028,78 ·
  `1320` D 96.204.587,48 · `0230` D 19.599.113,01 (uvoz opreme).

#### E) `BPDV` — „TROŠKOVI BEZ KORIŠĆENJA PDV-a" (786 faktura)

Dva podtipa u istom nalogu:

```
(1) dobavljač nije u PDV-u / oslobođeno → bez PDV konta uopšte
  4350  Nebojša Majić PR Stolarija  73/113PP   05/05/25       0.00  357,582.00
  5125  Nebojša Majić PR Stolarija  73/113PP   05/05/25  357,582.00        0.00

(2) PDV postoji ali NEMA PRAVA NA ODBITAK → konto 2704, D i P na ISTOM redu
  4350  JP Putevi Srbije  714513/2025  05/04/25        0.00   582.80
  2704  JP Putevi Srbije  714513/2025  05/04/25       97.13    97.13   ← neutrališe se
  5391  JP Putevi Srbije  714513/2025  05/04/25      582.80     0.00   ← trošak = BRUTO
```

Merenje nad celom 2025 (`2704`+`2714`):
```
stavki: 399; Duguje≠0: 399; Potrazuje≠0: 397; OBA na istoj stavci: 397
suma D=1,257,666.75  P=1,257,666.80  neto=-0.05     ← praktično nula
u PDV evidenciji (T_PDV_GK): 14 od 399
```

**Zaključak:** `2704`/`2714` su **statistička/memo konta**. Nisu u `PDV_SemeKontaZaKnjizenje` pa
**ne ulaze u KUF**, ali JESU u `POPDV_SemeKontaZaKnjizenje` kao oznaka `8а.2NE` — služe **isključivo**
da POPDV obrazac prikaže nabavke **bez prava na odbitak**. Trošak se knjiži u **bruto** iznosu.

#### F) `UFINT-OPST` — interni obračun / reverse charge (građevinarstvo, čl. 10)

```
Nalog 00001 (BPDV) 01/31/25:
  2705  VJ FIRE SYSTEMS DOO      91/2025   01/16/25   220,000.00        0.00
        → PDV_GK: evid=UFINT-OPST grupa=VISA stopa=20 osn=1,100,000.00 iznos=220,000.00
  4705  VJ FIRE SYSTEMS DOO      91/2025   01/16/25         0.00  220,000.00

Nalog 0003 (BPDV) 03/31/25:
  2705  Telefon inženjering doo  02/25     03/31/25   722,003.49        0.00
        → PDV_GK: evid=UFINT-OPST osn=3,610,017.45 iznos=722,003.49
  4705  Telefon inženjering doo  02/25     03/31/25         0.00  722,003.49
```
Obrazac: **`2705` D (pretporez) ↔ `4705` P (obaveza)**, isti iznos, neto efekat na PDV = 0.
`ObracunPDVOsnovica=0` na 2705 ⇒ osnovica se u KUF-u **ne broji** (izbegava dvostruko iskazivanje),
a `PDVOsnovica=0` ⇒ osnovica se **izvodi deljenjem** (220.000 / 0,20 = 1.100.000).
POPDV oznaka: `2705 → 8б.2` (K1Def `D/0.2`), `4705 → 3а.3` (K1Def `P`).
Agregat 2025: 11 stavki, osnovica 10.788.640,95, PDV 2.157.728,19.

Analogno, `2701`/`4704` = interni račun za **licence** (usluge stranih lica), `2760` = PDV na usluge
inostranih lica 20 %, POPDV `3а.2DA`.

---

## 5. AVANSI DOBAVLJAČA (dati avansi)

### 5.1 Nastanak — pretporez se priznaje **NA DAN PLAĆANJA**, iz naloga IZVODA

Raspodela `UF-DATAVAN` stavki po vrsti naloga (2025):
```
UF-DATAVAN: NALOG=156, IZVOD=137, IZV-E=92, PDV=8, BPDV=1
```
→ **229 od 394 (58 %) nastaje direktno u nalogu bankarskog izvoda.**

```
Nalog 0015 | vrsta=IZV-E (Erste izvod) | dat=02/13/25
  4350  Auto servis Rašković   08/2025      D=    14,000.00              (redovne fakture)
  1520  Jelovac constructions  A-6-2025     D= 2,400,000.00  P= 400,000.00   ← AVANS
  4350  Gumatic NS d.o.o.      1539/2025    D=     3,270.00
  2415  Servoteh d.o.o.        Izvod br.                     P=2,419,070.00  ← banka
  2720  Jelovac constructions  A-6-2025     D=   400,000.00              poz=elektronsk
        → PDV_GK: evid=UF-DATAVAN grupa=VISA stopa=20 osn=2,000,000.00 iznos=400,000.00 per=02/13/25
```

Pravila:
- **`1520`** („Placeni avansi za robu u zemlji") nosi **`Duguje` = BRUTO** i **`Potrazuje` = PDV** na
  ISTOJ stavci → neto efekat na 1520 = **osnovica bez PDV** (2.400.000 − 400.000 = 2.000.000).
- **`2720`** D = PDV po datom avansu → **ovo je jedini red koji pravi KUF zapis**.
- `Broj dokumenta` = **broj AVANSNOG RAČUNA dobavljača** (`A-6-2025`, `AV-0005/25`, `18000001492025`).
- `DatPorPerioda` = datum te GK stavke = **datum izvoda/plaćanja**.
- `1521` = „Placeni avansi za robu u zemlji **bez PDV**" (dobavljači van PDV-a).

> To je usklađeno sa čl. 28 ZPDV: pravo na odbitak pretporeza po avansu nastaje kad je avans
> **plaćen** i primljen **avansni račun**.

### 5.2 Zatvaranje pri konačnoj fakturi — **dva različita konta zavisno od PERIODA**

**Slučaj 1 — avans iz ISTOG poreskog perioda → konto `2720`, negativan KUF zapis:**

```
Nalog 0007 | vrsta=NALOG | dat=01/27/25
  1520   Jugo-kaolin d.o.o.  25-37K0-000019  D=  -65,758.75  P= -10,959.79   ← storno avansa
  2720   Jugo-kaolin d.o.o.  25-37K0-000019  D=  -10,959.79
        → PDV_GK: evid=UF-DATAVAN osn=-54,798.95 iznos=-10,959.79 per=01/27/25   ← NEGATIVAN
  4350   Jugo-kaolin d.o.o.  25-391K-000098  D=   65,758.75                  ← konačna faktura
```

**Slučaj 2 — avans iz PRETHODNOG perioda → konto `27200`, BEZ KUF zapisa:**

```
Nalog 0006 | vrsta=NALOG | dat=01/17/25
  1520   Termoproces d.o.o.  PA-12/24  D=-6,269,598.72  P=-1,044,933.12
  27200  Termoproces d.o.o.  PA-12/24  D=-1,044,933.12          ← (nema PDV_GK reda!)
  4350   Termoproces d.o.o.  if-5/25   D= 6,269,598.72
```

`27200` = „PDV u datim avansima 20 % - **ZATVARANJE AVANSA IZ PRETH.PERIODA**".
**Nije u `PDV_SemeKontaZaKnjizenje`** ⇒ ne pravi KUF zapis (jer je avansni pretporez već odbijen u
ranijem periodu i ne sme se stornirati u tekućem KUF-u), **ali JESTE u `POPDV_SemeKontaZaKnjizenje`**
kao `8а.2DA` (K2Def=`D`) — pa POPDV korekcija ipak prođe.

Realni obim: `2720` 385 stavki / 19.275.259,68 · `27200` 6 stavki (UF-DATAVAN) + 1 (UF) / −609.733,47 ·
`2730` (10 %) 2 stavke / −6.900,00.

### 5.3 Robna varijanta — `T_AVR_Roba` (vezivanje avansa uz kalkulaciju)

```sql
CREATE TABLE [T_AVR_Roba]
 ( [ID], [IDDok], [BrojDokAVR] Text(20), [DatumDokAVR] DateTime, [UkIznosSaPDVAVR] Currency,
   [UkPDVVisaAVR], [UkPDVNizaAVR], [KoristiIznosSaPDV], [KoristiPDVVisa], [KoristiPDVNiza], [ID_PO] );
```
Forma `AVR_Roba` (`Doc__Form_AVR_Roba.txt`) računa PDV iz bruto avansa:
```vb
Me!UkPDVVisaAVR = Round((Me!UkIznosSaPDVAVR / (1 + F_PDV_VisaStopa(Me!DatumDokAVR)/100))
                        * (F_PDV_VisaStopa(Me!DatumDokAVR)/100), 2)
```
Agregacija `NSK_KorisceniAvansiRoba.sql` daje slova **X/Y/Z** (`AvansUkupno`, `AvansPDVVisa`,
`AvansPDVNiza`) za šeme kontiranja.

> ⚠️ **Nijedna aktivna šema ne koristi X/Y/Z** (potvrđeno i u §5 doc-a 43). U 2025 `T_AVR_Roba` se
> **praktično ne koristi** — zatvaranje avansa se radi ručnim `NALOG`-om (156 stavki). To je
> **poznata rupa u BigBit-u**, ne uzor za kopiranje.

### 5.4 Izlazni (primljeni) avansi — da se ne pomešaju

Vrsta naloga `AVANS` (22 naloga, 109 stavki) koristi **`4300`** („Primljeni avansi"), **`4720`**
(„PDV po primljenim avansima 20 %"), **`47200`** („…POKRIVANJE AVANSA") i **`2040`** (kupci).
To je **KIF strana** (`IFAV-OPSTA`, 28 stavki / 178.898.038,38 PDV) i ne dodiruje KUF.

---

## 6. Brojevi iz stvarnih podataka (BB_T_25.MDB, 2025)

> Baza pokriva **01.01.2025 – ~20.08.2025** (avgust ima 325 faktura, mesec nije pun).

### 6.1 Obim

```
ULAZNE FAKTURE 2025 = GK stavke koje POTRAŽUJU konto dobavljača (bez početnog stanja): 4.277
Ukupna bruto obaveza:                                            758.844.171,20 RSD
Različitih dobavljača:                                                       568
Broj fakture dobavljača popunjen:                                  4277/4277 (100 %)
Rok plaćanja (Valuta dokumenta) popunjen:                          4277/4277 (100 %)
(uz to: početno stanje PS = 515 stavki / 60.697.290,99 RSD — nisu fakture)
```

### 6.2 Po kanalu dokumenta (`T_Glavna knjiga.Pozicija` → šifarnik `Pozicije`)

| Pozicija | Kom | Iznos (RSD) | Opis iz šifarnika |
|---|---:|---:|---|
| `elektronsk` | **3.191** | 467.153.809,31 | Elektronske fakture (SEF) |
| `uvoz` | 318 | 116.640.925,64 | Uvoz |
| `fiskalni` | 288 | 14.057.746,30 | Fiskalni računi plaćeni karticama ili gotovinom |
| `drugi` | 221 | 23.930.788,34 | Ostali računi – dobavljači nisu u sistemu PDV-a |
| `0` | 184 | 128.084.206,45 | Opšta pozicija (neklasifikovano) |
| `oslobodj` | 75 | 8.976.695,16 | Oslobođeni PDV-a |

→ **74,6 % ulaznih faktura dolazi kroz SEF.**

### 6.3 Po vrsti naloga (= put unosa)

| Vrsta | Kom | Iznos (RSD) | Put |
|---|---:|---:|---|
| `TROS` | 1.416 | 84.931.710,92 | ručno, troškovi |
| `UFROB` | 967 | 208.030.748,28 | auto iz robnog |
| `BPDV` | 786 | 47.375.318,32 | ručno, bez odbitka PDV |
| `UVOZ` | 575 | 139.835.361,60 | ručno |
| `UFMAT` | 339 | 184.962.793,53 | auto iz robnog |
| `TROS1` | 170 | 6.607.316,79 | ručno, fiskalni |
| `IMOV`/`OS`/`RAZNO`/ostalo | 24 | 87.100.921,76 | ručno |

**1.306 (30,5 %) automatski · 2.971 (69,5 %) ručno.**

### 6.4 PDV po evidenciji (ulazna strana)

| PDVEvidencija | Stavki | Osnovica (RSD) | PDV (RSD) |
|---|---:|---:|---:|
| `UF` | 3.059 | 398.828.401,00 | 79.717.277,40 |
| `UVOZ` | 131 | 117.205.664,25 | 23.441.132,85 |
| `UF-DATAVAN` | 394 | 93.277.640,77 | 18.669.934,21 |
| `UFINT-OPST` | 11 | 10.788.640,95 | 2.157.728,19 |
| **UKUPNO pretporez** | **3.595** | | **123.986.072,65** |

Po stopama (cela `T_PDV_GK`): `VISA 20 %` 3.502 · `NIZA 10 %` 139 · `BEZPDV 0 %` 9. **8 % (POLJO) = 0.**

### 6.5 Konta koja se STVARNO pojavljuju u PDV evidenciji ulaza

```
evidencija    konto   stavki           PDV (RSD)        osnovica (RSD)
UF            2700     2911      79,589,402.98      397,947,014.90
UF            2710      135          47,803.20          478,032.00
UF            2704        9          72,679.62          363,398.10     ← istorijski, konto više nije u šemi
UF            2714        2             599.60            5,996.00     ← isto
UF            27200       1         -10,208.00          -51,040.00     ← isto
UF            5322        1          17,000.00           85,000.00     ← ANOMALIJA (troškovni konto u KUF)
UF-DATAVAN    2720      385      19,275,259.68       96,376,298.40
UF-DATAVAN    27200       6        -599,525.47       -3,035,157.63
UF-DATAVAN    2730        2          -6,900.00          -69,000.00
UF-DATAVAN    2704        1           1,100.00            5,500.00
UFINT-OPST    2705       11       2,157,728.19       10,788,640.95
UVOZ          2740      125      23,010,568.75      115,052,843.75
UVOZ          2899        4         428,418.26        2,142,091.30     ← ANOMALIJA
UVOZ          2704        2           2,145.84           10,729.20
```

> **Za knjigovođu:** 13 redova (2704/2714/27200/5322/2899) su nastali dok je konfiguracija
> `PDV_SemeKontaZaKnjizenje` bila drugačija. Danas ta konta **nisu** u šemi. Iznosi su mali
> (≈500 tis. RSD) ali pokazuju da je tabela **append-only bez rekalkulacije** (§4.6 niže).

### 6.6 Storna i knjižna odobrenja dobavljača

```
Negativne stavke na kontima dobavljača (4350/4360/4330/43301/4331): 29
  po vrsti naloga: TROS=14, RAZNO=6, IZV-E=5, IZVOD=3, KURS=1
Stavke DUGUJE>0 na kontima dobavljača (plaćanja + zatvaranja): 4.430
  IZV-E=1833, IZVOD=1802, NALOG=292, DEVRN=214, BPDV=212, KOMP=56, RAZNO=15, PS=4
```
→ **Knjižna odobrenja dobavljača se knjiže kao obična negativna stavka u troškovnom nalogu.**
Nema zasebnog dokumenta, nema veze na originalnu fakturu, nema šeme kontiranja.

### 6.7 SEF ulazna dokumenta (`T_ER_DokumentaNabavke`)

```
2025: 3.788 dokumenata   (2024: 5.535 · 2023: 1.550)
Faktura 10.238 · Avansni račun 582 · Knjižno odobrenje 50 · Knjižno zaduženje 3   (sve godine)
Approved 10.773 · Storno 56 · Seen 32 · Rejected 9 · ReNotified 2
```
Poređenje: **3.788 SEF dokumenata** vs **3.191 GK stavki označenih `elektronsk`** vs
**4.277 ukupno ulaznih faktura** — razlika ≈ 600 je materijal za usaglašavanje (avansni računi
i knjižna odobrenja iz SEF-a se knjiže drugačije ili kasnije).

---

## 7. PDV / KUF pravila — precizno

### 7.1 Kada stavka ulazi u KUF

`APGK_PDV_Provera.sql` — doslovni uslovi:

```sql
FROM T_Nalozi INNER JOIN ((Komitenti INNER JOIN ([T_Glavna knjiga] INNER JOIN PDV_SemeKontaZaKnjizenje
       ON [T_Glavna knjiga].Konto = PDV_SemeKontaZaKnjizenje.Konto)
       ON Komitenti.Sifra = [T_Glavna knjiga].[Analiticka sifra])
       LEFT JOIN T_PDV_GK ON [T_Glavna knjiga].StavkaID = T_PDV_GK.StavkaID)
       ON T_Nalozi.IDNaloga = [T_Glavna knjiga].IDNaloga
WHERE (... AND ((T_PDV_GK.ID) Is Null) AND ... AND ((T_Nalozi.Level) Between OdLevel And DoLevel));
```

1. **Konto stavke mora postojati u `PDV_SemeKontaZaKnjizenje`** — jedini uslov za PDV tretman.
   Vrsta dokumenta/naloga **NE utiče** na ulaznoj strani.
2. **`INNER JOIN Komitenti`** — stavka bez validne analitike (komitenta) **tiho ispada iz KUF-a**.
   ⚠️ To je realan rizik: 14 od 1.074 UVOZ stavki u 2025 nema analitiku.
3. **`T_PDV_GK.ID Is Null`** — append-only; već evidentirana stavka se **nikad ne preračunava**.
   Izmena iznosa u GK **posle** upisa u PDV evidenciju **ne propagira**.
4. Operater bira opseg (datumi dokumenta/naloga, konto, komitent, vrsta naloga, Level) i pritiska dugme.

### 7.2 Poreski period — `DatPorPerioda := [Datum dokumenta]`

`APGK_PDV_Provera_UpisiUPDVEvidenciju.sql`:
```sql
INSERT INTO T_PDV_GK ( StavkaID, DatPorPerioda, PDVEvidencija, PDVStopa, PDVOsnovica,
                       ObracunPDVOsnovica, PDVIznos, ObracunPDVIznos, PDVGrupa )
SELECT APGK_PDV_Provera.StavkaID, APGK_PDV_Provera.[Datum dokumenta], ...
```

Empirijska provera nad 3.595 ulaznih PDV stavki 2025:
```
DatPorPerioda == Datum dokumenta       : 3572 (99.4 %)
DatPorPerioda == Datum knjizenja naloga: 2115 (58.8 %)
isti MESEC kao datum dokumenta         : 3590 od 3595 (99.9 %)
odstupanja koja nisu ni jedno ni drugo : 11   (sve su TIPFELERI: godine 2024, 2052)
```
→ **Poreski period = datum fakture dobavljača.** Nema pravila „period po datumu prijema" niti
„period po datumu knjiženja". Nema polja mesec/kvartal — period je **datum**, agregacija je u izveštaju.
`POPDV_MesecnaIliKvartalnaObaveza=1` (mesečno) je samo parametar obrasca u `APL.MDB`.

### 7.3 Kako se računaju osnovica i PDV

`Module__APGK.txt` — **jedina formula, koristi se i na formi i u upitu**:

```vb
Public Function OsnovicaPoPDVSemi(DugPot As Boolean, Duguje As Currency, Potrazuje As Currency,
                                  PDVOsnovica As Boolean, PDVStopa As Currency) As Currency
    If DugPot Then Iznos = Duguje Else Iznos = Potrazuje
    If PDVOsnovica Then
     Osnovica = Round(Iznos, 2)
     PDV = Round(Osnovica * (PDVStopa / 100), 2)
    Else
     PDV = Round(Iznos, 2)
     Osnovica = Round(PDV / (PDVStopa / 100), 2)
    End If
  OsnovicaPoPDVSemi = Osnovica
End Function
```
(`PDVPoPDVSemi` je identična, vraća `PDV`.)

Za **sva ulazna PDV konta je `PDVOsnovica = 0`** ⇒ **osnovica se izvodi deljenjem PDV-a stopom**,
zaokruženo na 2 decimale. Zato u podacima vidimo osnovicu 22.950,00 iz PDV-a 4.590,00 (÷0,20).

> ✅ **Naš 4.0 `deriveBase()` (`vat-ledger.service.ts:420`) radi identično** — `base = vatAmount / (rate/100)`.

### 7.4 „Koristi / ne koristi" (odbitno vs. neodbitno) u KUF izveštaju

`APGK_PDV.sql` deli iznose prema flagovima:
```sql
Sum(IIf([ObracunPDVIznos]     And [PDVGrupa]="VISA",[PDVIznos],0))    AS VisaPDVKoristi,
Sum(IIf(Not [ObracunPDVIznos] And [PDVGrupa]="VISA",[PDVIznos],0))    AS VisaPDVNeKoristi,
Sum(IIf([ObracunPDVOsnovica]     And [PDVGrupa]="VISA",[PDVOsnovica],0)) AS VisaOsnovicaKoristi,
Sum(IIf(Not [ObracunPDVOsnovica] And [PDVGrupa]="VISA",[PDVOsnovica],0)) AS VisaOsnovicaNeKoristi,
...
```

### 7.5 Tretman posebnih slučajeva — sažeto

| Slučaj | Konto | PDVEvidencija | POPDV | Ulazi u KUF? | Napomena |
|---|---|---|---|---|---|
| Redovan pretporez 20 % | `2700` | `UF` | `8а.2DA` (K1=`D/0.2`, K2=`D`) | ✅ osnovica+PDV | 2.911 stavki |
| Redovan pretporez 10 % | `2710` | `UF` | `8а.2DA` (K3=`D/0.1`, K4=`D`) | ✅ | 135 stavki |
| **Bez prava na odbitak** | `2704`/`2714` | — | `8а.2NE` (K1=`D/0.2`, K2=`D`) | ❌ | D i P na istom redu → nula; trošak u bruto |
| Dobavljač nije u PDV-u | — | — | `8д.2` preko troškovnog konta (`53xxx`, K1=`D`) | ❌ | nema PDV reda uopšte |
| Oslobođeno PDV-a | — | — | `8в.2` (`5530`, `562x`) | ❌ | `Pozicija='oslobodj'` |
| **Uvoz (JCI)** | `2740`/`2750` | `UVOZ` | `6.2.1DA` (K1=`D/0.2`) | ✅ | osnovica = carinska vrednost; protivstavka 4350-Carina |
| **Interni obračun (RC)** | `2705` ↔ `4705` | `UFINT-OPST` | `8б.2` ↔ `3а.3` | ✅ samo PDV, osnovica ne | neto PDV efekat 0 |
| Usluge stranih lica | `2760` | `UF` | `3а.2DA` (K1=`D`) | ✅ | |
| Interni račun licence | `2701` ↔ `4704` | `UF` ↔ `IFINT-OPST` | — ↔ `3а.1`/`8г.1` | ✅ | |
| **Dati avans** | `2720`/`2730` | `UF-DATAVAN` | `8а.7DA` (K2=`D`) | ✅ samo PDV | period = datum plaćanja |
| **Zatvaranje avansa, isti period** | `2720` (negativno) | `UF-DATAVAN` | `8а.2DA` | ✅ negativan | |
| **Zatvaranje avansa, raniji period** | `27200` | — | `8а.2DA` (K2=`D`) | ❌ | ključna distinkcija! |
| Poljoprivrednici 8 % | `2780` ↔ `4331` | `POLJO` | `7.3DA` | ✅ | 0 stavki u 2025 |
| PDV iz prethodne godine | `2709`/`2719` | — | `8а.2DA` | ❌ | ručna korekcija |

### 7.6 POPDV — paralelna evidencija po ISTOM principu

`POPDV_StavkaGKPoSemi.sql`:
```sql
SELECT [T_Glavna knjiga].StavkaID, POPDV_SemeKontaZaKnjizenje.PDVOznaka,
       [T_Glavna knjiga].[Datum dokumenta] AS DatumPorPerioda,
 POPDV_VrednostKoloneZaKnjizenje(1,[Duguje],[Potrazuje],[K1Def],[K2Def],[K3Def],[K4Def]) AS K1Iznos,
 ... (2,3,4)
FROM [T_Glavna knjiga] INNER JOIN POPDV_SemeKontaZaKnjizenje ON [T_Glavna knjiga].Konto = POPDV_SemeKontaZaKnjizenje.Konto
```
Evaluator formula (`POPDV_Module.bas:175-216`) je **string-replace + `Eval`**:
```vb
  Formula = Replace(Formula, "D", "(" & Duguje & ")")
  Formula = Replace(Formula, "P", "(" & Potrazuje & ")")
  retVal = Eval(Formula)
```
tj. `D/0.2` = `Duguje/0,2` (osnovica iz PDV-a), `D` = `Duguje` (sam PDV), `P` = `Potrazuje`.

Doslovni ulazni deo `POPDV_SemeKontaZaKnjizenje` (BB_T_25):
```
Konto,PDVOznaka,K1Def,K2Def,K3Def,K4Def
"2700","8а.2DA","D/0.2","D",,          "2704","8а.2NE","D/0.2","D",,
"2705","8б.2","D/0.2",,,               "2709","8а.2DA","D/0.2","D",,
"2710","8а.2DA",,,"D/0.1","D"          "2714","8а.2NE",,,"D/0.1","D"
"2719","8а.2DA","D/0.1","D",,          "2720","8а.7DA",,"D",,
"27200","8а.2DA",,"D",,                "2730","8а.2DA",,,,"D"
"2740","6.2.1DA","D/0.2",,,            "2750","6.2.1DA",,"D/0.1",,
"2760","3а.2DA","D",,,                 "2780","7.3DA",,"D",,
"5530"/"5621".."56280" → "8в.2","D"    "5555" → "8а.2NE","D"
"51220","5220".."55200","53xxx" → "8д.2","D"
```
> Oznake su **ĆIRILICOM** (`8а`, `8б`, `8в`, `8г`, `8д`, `3а`) — obavezna normalizacija pri migraciji.
> Naš `popdv.service.ts` to već radi (latinica↔ćirilica normalizacija AOP oznaka). ✅

### 7.7 Stope su datumski uslovljene

`Module__PDV_Modul.txt` (+ `_legacy/QBigTehn_APL/modules/PDV_Modul.bas:11-52`):
```vb
Public Function F_PDV_VisaStopa(DATUM, PDVGrupa, PoreskaStopa = 20) As Currency
  If PDVGrupa = "VISA" Then retVal = PoreskaStopa
  ElseIf CDate(DATUM) <= CDate(#9/30/2012#) And DATUM <> 0 Then retVal = 18
  Else retVal = ReadCFGParametar("DefaultPDVVisaStopa", 20)
```
Prelomi: **20 %** (18 % do 30.09.2012) · **10 %** (8 % do 31.12.2013) · **8 %** POLJO (5 % do 30.09.2012).
`APL.MDB`: `DefaultPDVVisaStopa=20`, `DefaultPDVNizaStopa=10`.

---

## 8. GAP-ovi prema ServoSync 4.0

Stanje 4.0 provereno u: `backend/src/modules/pdv/{vat-ledger,advance-vat,popdv,kepu}.service.ts`,
`backend/src/modules/gl/posting/posting.service.ts`, `backend/src/modules/nabavka/*`,
`backend/prisma/schema.prisma`.

### 8.1 Šta smo rešili DOBRO (potvrđeno BigBit-om — ne dirati)

| Tema | BigBit | 4.0 | |
|---|---|---|---|
| KUF izveden iz GK, ne zasebna tabela | `APGK_PDV_Provera` nad `T_Glavna knjiga` | `buildKifKuf()` nad `ledger_entries` | ✅ isti model |
| Konto → PDV smer/stopa kroz registar | `PDV_SemeKontaZaKnjizenje` (20) | `VatAccountMap` (20 redova, isti konti) | ✅ 1:1 |
| Osnovica se izvodi iz PDV-a deljenjem | `OsnovicaPoPDVSemi`, `PDV/(stopa/100)` | `deriveBase()`, isto | ✅ |
| POPDV deklarativno iz registra konta | `POPDV_SemeKontaZaKnjizenje` + `Eval` | `popdv_definitions` + `popdv_account_map` + safe evaluator | ✅ **bolje** (nema `Eval`) |
| Šeme kontiranja kao podaci (A–Z) | `Stavke seme za kontiranje` + `VredIzraza`+`Eval` | `AccountingSchemeLine` + safe expression parser | ✅ **bolje** |
| Pretporez po datom avansu na dan plaćanja | `2720` D u nalogu izvoda | `markIncomingAdvancePaid` → period po `paidAt` | ✅ isto pravilo |
| Storno avansa suprotnim predznakom | `2720` negativno | `vatBase: ZERO.sub(net)` | ✅ |
| 3-way match | **NE POSTOJI** | `three-way-match.service.ts` | ✅ **plus iznad legacy-ja** |

### 8.2 Tabela gap-ova

| # | Šta BigBit ima | Stanje u 4.0 | Ocena | Preporuka |
|---|---|---|---|---|
| **G1** | **Dokument ulazne fakture** (`T_Robna dokumenta` za robu; GK nalog za troškove) | **NE POSTOJI** nijedan model (`advance-vat.service.ts:10-11` to i priznaje) | 🔴 **KRITIČNO** | Uvesti `SupplierInvoice` (zaglavlje+stavke) kao jedinstven nosilac za **obe** vrste — 4.0 prilika da se ukine BigBit-ova dvojnost |
| **G2** | **Broj fakture dobavljača** (`Broj dokumenta`, 100 % popunjen) | `StockDocument` nema `supplierInvoiceNumber`; `postFromStockDocument` ne puni `LedgerEntry.documentNumber` → KUF dobija `String(journal_entry_id)` (`vat-ledger.service.ts:170`) | 🔴 **KRITIČNO** | KUF bez broja fakture nije upotrebljiv pred PU. Popuniti `documentNumber` iz UF |
| **G3** | **Rok plaćanja** (`Valuta dokumenta`, 100 % popunjen; auto iz „u roku dana") | `LedgerEntry.dueDate` postoji ali robno knjiženje ga **ne puni** → `payment-preparation.service.ts` nikad ne vidi obavezu kao dospelu | 🔴 **KRITIČNO** | Popuniti `dueDate`; dodati `paymentTermsDays` na dobavljača |
| **G4** | **Ručni unos troškovne UF** (2.971 od 4.277 = **69,5 %** prometa!) | Jedini automatski put je `postFromStockDocument`; ručni `postManualEntry` postoji ali nema ekran ni PDV podformu | 🔴 **KRITIČNO** | Ekran „Ulazna faktura – trošak/usluga": dobavljač, broj, datum, valuta, kanal, red(ovi) troška + auto `4350/2700/5xxx` |
| **G5** | **Šema UFROB/UFMAT/UVOZ u bazi** (`IDSeme` 3/34/32) | Samo u `prisma/_nacrt-4.0-faza2-seme-seed.ts`; migracija seeduje **samo 33 (IFR) i 36 (IFGP)** → `findUniqueOrThrow({id:3})` **puca** | 🔴 **KRITIČNO** | Seedovati šeme 3/34/32 + 8 konta koja fale u `accounts` |
| **G6** | **Kanal dokumenta** (`Pozicija`: `elektronsk`/`fiskalni`/`drugi`/`oslobodj`/`uvoz`) — 3.191 SEF faktura | `VatLedgerEntry` nema takvo polje | 🟠 VISOK | Dodati `sourceChannel` na UF/KUF; direktno napaja POPDV 8а/8б/8в/8д i usaglašenje sa SEF-om |
| **G7** | **Neodbitni pretporez** (`2704`/`2714`, D+P na istom redu, 399 stavki) | `VatAccountMap` nema 2704/2714; marker `vatRateCode="VP"` je približna zamena; trošak-u-bruto logika ne postoji | 🟠 VISOK | Uvesti `deductible: boolean` na stavci UF + automatsko knjiženje bruto troška; mapirati 2704/2714 → POPDV `8а.2NE` |
| **G8** | **Zatvaranje avansa iz PRETHODNOG perioda ide na `27200` bez KUF zapisa** | Ne postoji; `linkIncomingAdvanceToFinal` uvek pravi negativan KUF zapis, a za `direction='in'` **baca 422** | 🟠 VISOK | Implementirati grananje po periodu (isti period → negativan KUF na 2720; raniji → 27200, samo POPDV). Otključati ulazni smer kad G1 padne |
| **G9** | **Uvoz**: PDV se duguje CARINI (`2740` ↔ `4350`-Carina), osnovica = carinska vrednost ≠ fakturna; landed cost na 1320 | `StockDocument` ima `isImport`, `customs`, `forwarding`, `customsExchangeRate`, `customsRefundBase` — polja postoje, ali **nema šeme 32 ni pravila „PDV carini"** | 🟠 VISOK | Šema UVOZ + zaseban partner „Uprava carina"; osnovica UVOZ evidencije iz carinske vrednosti |
| **G10** | **Interni obračun / reverse charge** (`2705`↔`4705`, `2701`↔`4704`, `2760`) | `VatAccountMap` ima 2705, 2760; **nema 4704/4705**, nema para „obračunaj i odbij" | 🟠 VISOK | Tip UF „interni obračun" koji generiše oba reda; `ObracunPDVOsnovica=false` ekvivalent (osnovica se ne broji) |
| **G11** | **Knjižno odobrenje/zaduženje dobavljača** (29 stavki 2025) | Nema dokumenta; šeme 28/31 samo u nacrtu i **odnose se na kupce** | 🟡 SREDNJI | Tip dokumenta „KO/KZ dobavljača" sa vezom na originalnu UF (BigBit tu vezu **nema** — naša prilika) |
| **G12** | **PIB dobavljača u KUF-u** (`Komitenti.PIB` kroz `INNER JOIN`) | `VatLedgerEntry` nema `partnerPib`; samo meki `partnerId` | 🟡 SREDNJI | Denormalizovati PIB na KUF red (zahtev obrasca; partner se može menjati) |
| **G13** | Stavka **bez komitenta tiho ispada iz KUF-a** (`INNER JOIN Komitenti`) | Naš `buildKifKuf` koristi `le.analytical_code` bez JOIN-a → **zadržava** stavku sa `partnerId=null` | 🟢 4.0 BOLJI | Zadržati, ali dodati **upozorenje** u izveštaju „PDV stavka bez partnera" |
| **G14** | KUF je **append-only**: izmena u GK posle upisa se **ne propagira** (13 anomalnih redova, §6.5) | `buildKifKuf` radi `deleteMany` GK-izvedenih pa reknjiži → **uvek konzistentno** | 🟢 4.0 BOLJI | Zadržati; dodati zaključavanje perioda (već postoji `assertVatPeriodNotLocked`) |
| **G15** | KUF se gradi **ručno**, po filtriranom opsegu | `POST /pdv/kif-kuf/build` po godini/mesecu | 🟢 4.0 BOLJI | Zadržati; dodati automatsko pokretanje pri zaključenju perioda |
| **G16** | **Veza UF ↔ predmet = slobodan tekst** (`Opis`, 80,6 % tačnosti, 45 % prazno) | `LedgerEntry.sourceProjectId` postoji (strukturno) | 🟢 4.0 BOLJI | Obavezna strukturna veza po stavci UF; **migracija: parsirati `Opis` u `IDPredmet`** (73 tokena, 39 validnih) |
| **G17** | **Veza UF ↔ narudžbenica**: samo `IDPrepisaneStavke = −IDStavke`, nigde se ne koristi | `StockDocument.purchaseOrderId` + 3-way match | 🟢 4.0 BOLJI | Zadržati; dodati `SupplierInvoiceItem.purchaseOrderItemId` da match bude po stavci, ne po artiklu |
| **G18** | **SEF inbox** `T_ER_DokumentaNabavke` (10.873) bez ikakve veze sa knjiženjem | `SefIncomingInvoice` ima **`matchedKufEntryId`** | 🟢 4.0 BOLJI | Zatvoriti petlju: SEF → predlog UF → knjiženje (BigBit to nikad nije imao) |
| **G19** | Datum **prijema** dokumenta, workflow odobravanja/likvidature | Ne postoji ni u jednom | ⚪ NEMA IZVORA | Nije paritet. Ako se traži, to je **nova funkcionalnost** — odluka poslovna |
| **G20** | Nema enum-a nigde (Access `Text`) | Prisma šema **nema nijedan `enum`**, sve `VarChar` | 🟡 SREDNJI | Nezavisno od BigBit-a — uvesti enume/CHECK za `direction`, `documentType`, `status` |

### 8.3 Redosled gradnje (predlog)

1. **G5** (seed šema 3/34/32 + konta) — bez toga knjiženje robnog ulaza **puca na čistoj bazi**.
2. **G1 + G2 + G3** — model `SupplierInvoice` (zaglavlje: dobavljač, broj fakture, datum fakture,
   datum valute, kanal, ukupni iznosi; stavke: artikal/trošak-konto, osnovica, stopa, odbitno da/ne,
   predmet, narudžbenica-stavka) + popunjavanje `documentNumber`/`dueDate` u `LedgerEntry`.
3. **G4** — ekran za troškovnu/uslužnu UF (pokriva 69,5 % prometa).
4. **G7 + G6** — odbitnost i kanal (direktno napajaju POPDV i usaglašenje sa SEF-om).
5. **G8 + G10 + G9** — avansi (grananje po periodu), reverse charge, uvoz.
6. **G11, G12, G17, G18** — knjižna odobrenja, PIB, match po stavci, SEF petlja.

---

## 9. Otvorena pitanja za knjigovođu (Nesa / Negovan)

1. **`27200` vs `2720`** — potvrditi pravilo: zatvaranje avansa iz **ranijeg** poreskog perioda ide na
   `27200` i **ne ulazi** u KUF (samo POPDV `8а.2DA`), a iz **istog** perioda na `2720` negativno.
   Ko odlučuje „isti/raniji period" — datum avansnog računa ili datum plaćanja?
2. **`2704`/`2714`** — potvrditi da je jedina svrha POPDV `8а.2NE`, da trošak ostaje **bruto**, i
   da se D/P namerno neutrališu na istom redu (a ne kroz dva reda).
3. **UVOZ osnovica** — potvrditi da je osnovica za `2740` uvek **carinska vrednost sa JCI**, a ne
   fakturna vrednost dobavljača.
4. **Kanal (`Pozicija`)** — je li lista `elektronsk/fiskalni/drugi/oslobodj/uvoz` konačna i traži li
   je PU, ili je interna kontrola? 184 stavke (128 mil. RSD) su ostale na `0` — treba li ih klasifikovati?
5. **13 anomalnih PDV redova** (§6.5: 2704/2714/27200/5322/2899 u `T_PDV_GK`) — jesu li greške koje
   treba isključiti iz migracije ili opravdane ručne korekcije?
6. **`T_AVR_Roba`** — praktično se ne koristi (zatvaranje avansa ide ručnim nalogom). Da li u 4.0
   gradimo strukturnu vezu avans→konačna faktura (preporuka), ili zadržavamo ručni postupak?
7. **Knjižna odobrenja dobavljača** — 29 negativnih stavki u 2025 bez dokumenta. Treba li im
   zaseban tip dokumenta sa vezom na originalnu fakturu?
8. **Datum prijema fakture** — BigBit ga nema. Treba li nam (rokovi za SEF prihvatanje su 15 dana,
   `ACCEPT_DEADLINE_DAYS` u našem `sef-incoming.service.ts`)?
9. **Poljoprivrednici (`2780`/`4331`, 8 %)** — 0 stavki u 2025. Gradimo li uopšte?
10. **Razlika 3.788 SEF vs 3.191 `elektronsk`** — kako se danas usaglašava i šta sa 597 razlike?

---

## 10. Sažetak izvora i kako reprodukovati

```bash
# osnovni izvoz
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-tables -1 /d/BB_T_25.MDB"
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-schema -T 'T_PDV_GK' /d/BB_T_25.MDB"
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export -d ',' -q '\"' \
                 /d/BB_T_25.MDB 'PDV_SemeKontaZaKnjizenje'"

# konfiguracija aplikacije
ssh ubuntusrv "docker run --rm -v /tmp/bb26:/d mdbtools:local mdb-export -d '|' \
                 /d/APL.MDB 'CFG_Apl_SviParametri' | grep -iE 'pdv|uf'"
```

Ključni fajlovi u repou:
- `_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/APGK_PDV_Provera.sql`
- `_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/APGK_PDV_Provera_UpisiUPDVEvidenciju.sql`
- `_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/APGK_PDV.sql`
- `_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/POPDV_StavkaGKPoSemi.sql`
- `_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/NSK_ProknjiziStavkeIzRobnog.sql`
- `_legacy/BigbitRaznoNenad/_extracted/queries_full/OnLine_BigBit_APL/ProknjiziStavkeIzPorudzbineUUlazni.sql`
- `_legacy/BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/Module__APGK.txt` (`OsnovicaPoPDVSemi`)
- `_legacy/BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/Doc__Form_Ulazna faktura.txt`
- `_legacy/BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/Doc__Form_PDVStavkeNaloga.txt`
- `_legacy/QBigTehn_APL/modules/POPDV_Module.bas` (`POPDV_VrednostKoloneZaKnjizenje`)
- `_legacy/QBigTehn_APL/modules/PDV_Modul.bas` (datumske stope)

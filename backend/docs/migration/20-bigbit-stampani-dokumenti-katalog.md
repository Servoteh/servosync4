# BigBit OnLine — katalog štampanih dokumenata i „kartica"

> Izvedeno iz **izvučenih tekstualnih izvora** (2026-07-18): `_legacy/BigbitRaznoNenad/_extracted/`
> — `OnLine_BigBit_VBA/` (824 komponente, code-behind), `OnLine_BigBit_Design/` (**svih 496 report
> definicija**, SaveAsText — uklj. RecordSource), `queries/` (2.412 .sql). Navigacija:
> [10-bigbit-glavni-meni.md](10-bigbit-glavni-meni.md); domeni: [09-bigbit-online-domain-map.md](09-bigbit-online-domain-map.md).

## 1. Brojke — koliko je „živo"

| Metrika | Broj |
|---|---:|
| Izveštaja ukupno u `OnLine_BigBit_APL.MDB` | **496** |
| Jedinstvenih imena izveštaja **pozivanih iz VBA koda** (`DoCmd.OpenReport`/`BBOpenReport`, 403 call-site-a) | **324** |
| Od toga postoji u bazi (živo, dostupno kroz UI) | **~303 (61%)** |
| Pozvano iz koda ali NE postoji u APL (mrtva dugmad ili report u drugom add-in MDB: `APGK_Dnevnik`, `ER_KnjigaStatusa`, `PB2`, `PP4`, `PosebnaUplatnica`, `ORN`…) | 21 |
| Nikad pozvano iz koda (mrtve kopije: `_OLD`, `_STD`, `_28022009`, tuđe SPECIJAL varijante) | **~193 (39%)** |

**Mehanizam SPECIJAL** (`Module__Bliski susret.txt`, `InicSPECIJAL()`): imena komercijalnih dokumenata
grade se dinamički — `ImeFakture = "Faktura - " & Specijal`, isto za Profakturu, Kalkulaciju,
Otpremnicu, „Porudzbenica i izjava", USLUGA fakture, Trebovanje. `Specijal` se čita iz tabele
`Radni fajlovi`; postoje varijante za 13 firmi (ABB, PLANETA, PROKOMERC…). **Za Servoteh nema
`Case "SERVOTEH"` → važi `DEFAULT`** — tj. živi su isključivo `... - DEFAULT` izveštaji.
Posledica: ~80 izveštaja u bazi su tuđe firm-varijante = mrtvo za nas.

## 2. Ključni komercijalni dokumenti (meni → forma → report → izvor podataka)

Legenda prioriteta za 4.0: **M** = must (komercijalno jezgro), **S** = should (regulatorno/knjigovodstvo),
**C** = could (analitika/pomoćno), **X** = ne prenositi.

### 2.1 Prodajni dokumenti (robno)

| Dokument | Meni → forma | Report(i) | RecordSource | Prio / napomena |
|---|---|---|---|---|
| **Profaktura (= „ponuda" u praksi)** | Magacin → Profakture → `Profaktura` | `Profaktura - DEFAULT`; `KNGProfaktura(_2) - DEFAULT` (kontiranje); `ProfakturaOtpremnicaBezCena`; `ProfakturaZaMag` (nalog magacinu) | upit `PROFakturaZaStampu` (svi); KNG → `KNGProfakturaZaStampu` | **M** — centralni prodajni dokument; profaktura = `Robna dokumenta` sa `Level ≥ 250` (`queries/Profakture.sql`) |
| **Pregled profaktura** | Magacin → Pregled profakture → `PregledProfaktura` | `KnjigaProfaktura`; `PregledProfakturaZaArtikleBezPredmeta`; `ZavrseniRezervisaniPredmeti` | upit `PregledProfaktura` | **M** |
| **Faktura (robna)** | Magacin → Izlaz → `Izlazna faktura` | `Faktura - DEFAULT` (glavna); `FakturaSaNovimAvansima`; `FakturaSaAvansimaIzUSLUGA`; `KNGFaktura - DEFAULT` (kontiranje → `KNGFakturaZaStampu`); `MPFaktura - DEFAULT`; `Prenosnica - DEFAULT` | upit `FakturaZaStampu` | **M** — kompletna poreska faktura |
| **Otpremnica (uz fakturu)** | ista forma, dugme „otpremnica" | **nema `Otpremnica - DEFAULT`** → fallback: štampa `Faktura - DEFAULT` sa naslovom `Me![TekstZaRacun]="Otpremnica"` | `FakturaZaStampu` | **M** — u 4.0 otpremnica = ista šema kao faktura, drugi naslov/bez cena |
| **Račun–Otpremnica („izjava")** | ista forma, dugme izjava | `Prazna faktura - DEFAULT` (naslov „Račun - Otpremnica") | `FakturaZaStampu` | C |
| **Zbirna štampa** | Magacin → Knjiga UI → `Pregled dokumenata` | `FakturaSVE - DEFAULT` (sve iz pregleda → `FakturaZaStampu_SVE`); `FakturaZbirna - DEFAULT` (→ `ZbirnaFaktura`); `KLIFSVE - DEFAULT`; `Knjiga UI Faktura` (→ `Pregled zbirova dokumenata`) | — | S |
| **Magacinska otpremnica (OP modul)** | rutna prodaja → `OP_UnosDok`/`OP_PregledDokumenata` | `OP_Otpremnica` (→ `OP_DokZaStampu`); `OP_ZbirnaOtpremnica`; `OP_ZbirneOtpremnicaPoKupcima*`; `OP_NalogZaProizvodnju` | `OP_DokZaStampu` | C — OP (odjava/rute) podmodul, proveriti da li se koristi |
| **Ponuda (INO)** | — (bez menija) | `InoPonudaEng`, `InoPonudaEngBezRabata`, `INOUslugaPonuda - DEFAULT` | inline SQL nad `PROFakturaZaStampu` / `USLUGA Faktura za stampu` | **X iz koda** — nijedan se ne poziva iz VBA (otvarani ručno); potvrđuje: domaća „ponuda" = profaktura |

### 2.2 Fakturisanje usluga + e-Faktura

| Dokument | Meni → forma | Report(i) | RecordSource | Prio / napomena |
|---|---|---|---|---|
| **Faktura usluga** | Usluge → Fakturisanje → `USLUGA Faktura` | `USLUGA Faktura - DEFAULT`; `UslugaFakturaBezKol - DEFAULT`; `USLUGA_FakturaSaNovimAvansima`; `UslugaFakturaVezaSaAvansima`; `KnjiznoZadOd` (knjižno zaduženje/odobrenje); `USLUGAZapisnik` | upit `USLUGA Faktura za stampu` (tabele `Usluge dokumenta` + `Usluge stavke` + `R_Tarife`) | **M** — Servoteh primarno fakturiše usluge |
| **Knjiga faktura usluga** | Usluge → Pregled fakture → `USLUGA Pregled dokumenata` | `USLUGA Knjiga faktura` | upit `USLUGA Pregled faktura` | **M** |
| **Profaktura usluga** | `UslugaProfaktura` (+ `UslugaPregledProfaktura`) | `USLUGA Profaktura`; `UslugaKnjigaProfaktura` | `UslugaProfakturaZaStampu`; `UslugaPregledProfaktura` | **M** |
| **e-Faktura (SEF)** | Usluge → Pregled e-Fakture → `ER_KnjigaStatusa_Usluge`; Magacin → Knjiga e-Faktura → `KnjigaStatusa` | vizuelna kopija: `ER_USLUGAFaktura`, `ER_Faktura` (robno); slanje: **nije report** — `ER_API_Class` → REST `efaktura.mfin.gov.rs` (UBL XML, `SEF_Class`) | inline SQL nad `Usluge dokumenta`/`Robna dokumenta` + `Komitenti` (filter `F_USLF_IDDok()`/`F_IF_IDDok()`) | **M** — vidi [07-bigbit-sef-efaktura.md](07-bigbit-sef-efaktura.md) |

### 2.3 Nabavka / porudžbenice

| Dokument | Meni → forma | Report(i) | RecordSource | Prio / napomena |
|---|---|---|---|---|
| **Narudžbenica robe („trebovanje")** | Magacin → Naručivanje robe → `Trebovanje` (i `TrebovanjeProfaktura` za var. „Prevod") | `TrebovanjeBezCena - DEFAULT`; `TrebBezCenaSrpski`; `TrebSaCenamaSrpski`; `TrebovanjeBezCenaInoExt`; `TrebovanjePrijemnica`; profaktura-varijante `TrebProf*` | `Trebovanje*` upiti u APL | **M** — ovo je porudžbenica ka dobavljaču |
| **Pregled narudžbina** | Magacin → Pregled narudžbine → `PregledTrebovanja` | `PregledTrebovanja` | istoimeni upit | **M** |
| **Potvrda porudžbine kupcu** | `OdstampajPotvrduPoruzbine` | `PotvrdaPorudzbine` | tmp tabela `tmp_PotvrdaPorudzbine` | S |
| **Porudžbenica i izjava** | `Izlazna faktura` (dugme) | `Porudzbenica i izjava - DEFAULT` — **ne postoji u APL** (mrtvo za DEFAULT) | — | X |
| **Upit/zahtev dobavljaču** | Magacin → Zahtev ka dobavljaču → `UpitDobavljacu`, `UnosZahtevaZaNabavku` | `UpitZaDobavljaca`; `INOUpitZaDobavljaca`; `SpecifikacijaZaNabavku`; `PregledZahteva` | inline SQL: `T_UpitDobavljacu`+stavke; `ZahteviZaNabavku`+`SpecifikacijaZahtevaNabavke` (vezano na `Predmeti`) | **M** — RFQ tok, veza sa predmetima; vidi [13-bigbit-nabavka.md](13-bigbit-nabavka.md) |
| **Ulaz / kalkulacija** | Magacin → Ulaz → `Ulazna faktura` | `Kalkulacija - DEFAULT` i `KL` (→ upit `Kalkulacija`); `UFZaMag` (nalog magacinu); `KalkulacijaUVOZ` (→ `KalkulacijaUvoza`, forma `UVOZStavke`); `V_Prijemnica(SaRazlikama)` (veleprodaja) | upit `Kalkulacija` | **M** (kalkulacija cena je zakonska za robno) |

### 2.4 Artikli / zalihe

| Dokument | Meni → forma | Report(i) | RecordSource | Prio / napomena |
|---|---|---|---|---|
| **Kartica artikla** | Artikli → Kartice → `Kartica artikla` | `Kartica artikla`; `Kartica artikla_2Vrste`; `KarticaArtiklaZaSlaganje` | `SELECT [Detalji kartice artikla].* WHERE [Sifra artikla]=Forms!...` — upit `Detalji kartice artikla` (+ varijante `NAB`/`FAKTURNA` po izboru cene) | **M** — v. §3 |
| **Lager lista** | Artikli → Lager lista → `Izbor za lager listu` / `Lager lista` | `Lager lista` (+ `po nabavnoj / po prosecnoj / po MP ceni`, `LagerListaPoProsNabCeni`, `LagerListaPoMPCeniIzCenovnika`); `LL_ArtikliIspodMinKolicine`; `CenovnikIzLagerListe` | **svi nad upitom `Lager lista`** (kolone: Kataloški broj, Naziv, JM, Grupa, Količina, VPC, ΣKol, ΣVrednost) | **M** |
| **Popis** | Artikli → Popis → `Unos popisa`; + iz lager liste | `Popisna lista iz unosa` (→ istoimeni upit); `Popisna lista` / `PopisnaLista_Prazna` (→ upit `Lager lista`); `PopisnaListaSaPolicama`; MP: `MPPopisnaListaIzUnosa` | — | **M** (godišnji popis je zakonski) |
| **Nalepnice** | Artikli → Nalepnice → `Nalepnice` | `Nalepnice - STD`; `Nalepnice_BarKod(_2)`; `Zweckform 4736`; `Xerox65`; `Deklaracija`; kupac-specifične (`Cyclamin*`, `Preradovic`) | upit `NalepniceZaStampu` (jedini nađen i u `queries/` dump-u) | S — STD + barkod dovoljni; `NalepnicaServoteh` (iz `PredmetiPoDokumentima`) već postoji za predmete |
| **Cenovnik** | Razno → Cenovnik → `Cenovnik` | `Cenovnik` | upit `CenovnikZaStampu` | S |
| **Komision** | Artikli → Komisione kartice / Zad-Odj | `Kartica artikla KOMISION`; `Kartica zaduzenja i odjava`; `Lager lista date robe u komision`; `Odjava`; `KR-1(_ProdajaMP)` | varijante `Detalji kartice artikla`/`Lager` | C — potvrditi da li Servoteh vodi komision |
| **Ulaz/izlaz analitika** | Artikli → Ulaz/Izlaz po artiklima | `Ulaz po artiklima`; `Izlaz po artiklima` (+ 6 varijanti); `UlazIzlazPoArtiklima` | istoimeni upiti | C — pokriti generičkim reporting slojem |

### 2.5 Glavna knjiga / finansije

| Dokument | Meni → forma | Report(i) | RecordSource | Prio / napomena |
|---|---|---|---|---|
| **Nalog za knjiženje** | GK → Unos naloga → `Unos naloga glavne knjige` | `Nalog`; `NalogSinteticki`; `Nalog DEVIZE`; (`Nalog2Ver` — ne postoji) | upit `Nalog za stampanje` | **S** |
| **Dnevnik** | GK → Dnevnik → `Dnevnik glavne knjige` | `DnevnikGK` | upit `Dnevnik glavne knjige` | **S** |
| **Bruto stanje (bilans)** | GK → Bruto stanje → `Bruto stanje` | `Bruto stanje`; `Bruto stanje svedeno` | upiti `Bruto stanje(, svedeno)` | **S** |
| **Kartica konta** | GK → Kartica konta → `Kartica konta (sinteticka)` | `Kartica konta`; `Kartica konta sinteticka`; `InoKarticaKonta` | upit `Kartica konta` — v. §3 | **S** |
| **Kartica analitike** | GK → Kartica analitike → `Analiticka kartica` | `Kartica analitike`; `... DEVIZE`; `KarticaAnalitikeSamoDev` | upit `Kartica ANALITIKE za stampu` — v. §3 | **S** |
| **Salda analitike** | GK → Salda analitike → `Izbor salda analitike` (hub: Saldo/Promet po komitentima, ZTST, `AG_SaldaAnalitike`) | `AG_SaldaAnalitike` (→ `AG_OTST_3`); `Saldo po komitentima 3datuma`; `Promet po komitentima`; `Zbirni promet po komitentima` | istoimeni upiti | **S** |
| **Otvorene stavke / IOS** | GK → Otvorene stavke → `Otvorene stavke analitike`, `OTST Pojedinacno` | `Otvorene stavke kartice`; `OtvoreneStavkeSaBrojemDanaKasnjenja`; **`IOS`** (obrazac, → `OTST pojedinacno za stampu`); `NIOS(D/GRP/DGRP)` | upit `Otvorene stavke za stampu` | **S** — IOS je obavezan godišnji obrazac |
| **Kartoteke-štampa (masovno)** | GK → Kartoteke-štampa → `Kartoteka` | `Sve kartice analitike`; `Sve otvorene stavke`; `Sve sinteticke kartice konta`; `DEVIZE Otvorene stavke / Salda / Kursne razlike` | upiti `Sve * za stampu` | C |
| **Blagajna** | GK → Unos blagajne → `Blagajna`, `Stavke blagajne` | `Blagajna(Detaljno)`; `DevBlagajna`; `Temeljnica - NAPLATITI/ISPLATITI` (+DEV) | istoimeni upiti | S |
| **Virman (nalog za prenos)** | Komitenti → Priprema plaćanja → `VIRMANI_Priprema`, `UnosVirmana`, `Pregled virmana` | `Virman` (obrazac), `VirmanNacrtan`; `SviVirmani(Nacrtani)`; `PregledPotpisanihVirmana`; `PregledDuplihVirmana`; `Virmani_RazlikaUIznosima`; (`PosebnaUplatnica` — ne postoji) | tabela/upit `UnosVirmana` (filter `IDVirman`); `PregledVirmana WHERE Stampati=True` | **X za štampu** — u 4.0 zameniti izvozom u e-banking (XML), ne štampati virmane |
| **PDV** | PDV obrazac → POPDV; stare knjige | `PDV_IF`/`PDV_UF(_Poljo)`; `APGK_PDV_IF/UF`; `APGK_PPPDV` (POPDV); `PDV_ObrazacPPDV`; `PDVSpecZaKnjiguIF` | APGK/PDV upiti | **S** — regulatorno; vidi [18-gl-pdv-kontiranje-rekonstrukcija.md](18-gl-pdv-kontiranje-rekonstrukcija.md) |

### 2.6 Robne knjige (regulatorno)

| Dokument | Meni → forma | Report(i) | RecordSource | Prio |
|---|---|---|---|---|
| **KEPU knjiga (VP)** | Razno → KEPU Veleprodaja → `Knjiga KEPU` | `Knjiga KEPU` | upit `Unos pregled KEPU` | **S** |
| KEPU MP | Razno → KEPU Maloprodaja → `Knjiga KEPU_MP` | `Knjiga KEPU_MP` | `Unos pregled KEPU_MP` | X (nema MP kod Servoteha — potvrditi) |
| Trgovačka knjiga | Razno → `Trgovacka knjiga` | `Trgovacka knjiga` | `Unos pregled trgovacke knjige` | C |
| Knjiga PK1 | Razno → Knjiga PK1 → `KnjigaPK1` | `PK1 Izvestaj`; `PP4(_Prazan)`, `PB2` (ne postoje u APL) | inline SQL nad `PK1_UnosSumOf` | X (proizvodnja-MP evidencija; verovatno se ne koristi) |
| **Nivelacija** | Magacin → Nivelacija zaliha → `Nivelacija` | `NivelacijaZalihaVP`; `NivelacijaZalihaMP`; `MPNivelacija` | istoimeni upiti | S |

## 3. „KARTICE" — šta tačno prikazuju

| Kartica | Forma → report | Izvor + filter | Kolone (iz report dizajna) |
|---|---|---|---|
| **Kartica artikla** | `Kartica artikla` → rpt `Kartica artikla` | upit **`Detalji kartice artikla`**, filter `[Sifra artikla]=Forms![Kartica artikla]![Sifra artikla]` + od/do datuma + magacin; izbor cene menja podupit (`... NAB` = nabavna neto, `... FAKTURNA`, default = VP) | Datum dok., Broj dok. (Vrsta+Broj), Komitent, Magacin, **UlazKol / IzlazKol / stanje (running)**, UlazNabVred/UlazKLVPVred, IzlazNabVred/IzlazKLVPVred, KLNabCena/KLVPCena, prosečne cene (`ΣVred/ΣKol`), zbirovi ulaz/izlaz/saldo |
| **Kartice profakture** | `KarticaProfaktura` (klon Kartice artikla) | isti upit, ali podforma filtrirana na **`Level = 250`** (profakture — `queries/Profakture.sql`: `Robna dokumenta WHERE Level>=250`) | iste kolone — promet artikla samo kroz profakture (rezervacije) |
| **Kartice porudžbine** | `KarticaNarudzbina` (klon) | isti upit, filter na Level opseg narudžbina (Od/Do Level kontrole, `BETWEEN 0 AND F_NivoBaze()`) | iste kolone — naručene količine po artiklu |
| **Kartica konta** | `Kartica konta (sinteticka)` → rpt `Kartica konta` | upit `Kartica konta`; parametri: konto, od/do datuma, pozicija | Datum naloga, Vrsta+Broj naloga, Datum dok., Broj dok., Opis dok., Naziv (komitent), **Duguje, Potražuje, Saldo** (`Σ[Duguje]-[Potrazuje]`) |
| **Kartica analitike** | `Analiticka kartica` → rpt `Kartica analitike` | upit `Kartica ANALITIKE za stampu`; parametri: konto+analitika (komitent), od/do | Datum naloga, Broj naloga, Datum dok., Broj dok., Opis dok., Naziv/Mesto/Adresa komitenta, Valuta dok., **Duguje, Potražuje, Saldo** |
| Kartica predmeta | Predmeti → `IzborZaKarticuPredmeta` | promet dokumenata po `IDPredmet` | — (veza na 2.0 `projects`) |

Napomena: BigBit dokumenta žive u **jednoj tabeli `Robna dokumenta`** + stavke; **`Level`** polje
razdvaja tip/status (profaktura=250…), pa su „kartice" isti upit sa različitim Level filterom —
u 4.0 ovo se prirodno mapira na `document_type` + status.

## 4. Predlog MUST liste za 4.0 komercijalno jezgro

Redosled implementacije štampe (svaki = 1 template nad postojećim podacima):

1. **Profaktura** (`PROFakturaZaStampu`) — ponuda/predračun, ulaz u sve tokove.
2. **Faktura usluga** (`USLUGA Faktura za stampu`) + **e-Faktura SEF** (UBL — isti podaci).
3. **Robna faktura** (`FakturaZaStampu`) + **otpremnica** (ista šema, bez cena/drugi naslov — tako radi i legacy).
4. **Kalkulacija ulaza** (`Kalkulacija`) — uz robni ulaz.
5. **Narudžbenica dobavljaču** (`Trebovanje*` bez cena srpski/ino) + **zahtev/upit dobavljaču** (RFQ, vezan na predmete).
6. **Kartica artikla + Lager lista + Popisna lista** — sve nad istim inventory ledger-om.
7. **Knjige**: knjiga (pro)faktura, KEPU; zatim GK set (dnevnik, kartice konta/analitike, IOS, bruto stanje) u finance fazi.
8. **Nalepnice** (STD + barkod) — sitno ali dnevno korišćeno.

Ne prenositi: virmani-štampa (→ e-banking izvoz), PK1/PP4/PB2, MP/KEPU-MP (nema maloprodaje?),
firm-specifične SPECIJAL varijante, `Cyclamin`/`Kolubara`/`ABB` kupac-varijante, OS_ (osnovna
sredstva — posebna odluka), `RasterPrikaz*` (ekranski pomoćni).

## 5. Radni artefakti

Ekstrakcija ponovljiva iz: `_extracted/OnLine_BigBit_VBA` (grep `OpenReport` — 403 poziva, obrazac
`stDocName/DocName = "..."` + `DoCmd.OpenReport`), `_extracted/OnLine_BigBit_Design/*.txt`
(`RecordSource =`, `ControlSource =`). Upiti `*ZaStampu` nisu u `queries/` dump-u (tamo je pretežno
QBigTehn) — definicije su u `OnLine_BigBit_APL.MDB`; po potrebi izvući istim SaveAsText postupkom.

## 6. Status izvoza dizajna (18.07 uveče — formalno)

| Baza | Izvezeno | Napomena |
|---|---|---|
| `OnLine_BigBit_APL.MDB` | **496/496 (100%)**, 112 MB | `_extracted\OnLine_BigBit_Design\*.txt`, nula praznih; svih 20+ ključnih komercijalnih potvrđeno (Profaktura/Faktura/Racun/IOS/Kartice/Knjiga KEPU — `- DEFAULT` varijante) |
| `BigBit_APL_2010.MDB` | **426/713 (60%)** | podfolder `APL_2010\`; **svih 22 POPDV sekcijska izveštaja (POPDV_010R…110R) izvučeno** ✅ |

Metod: `MSACCESS.EXE /wrkgrp BIGBIT.MDW /ro /nostartup` nad **kopijom** u scratchpad-u + COM
`GetActiveObject` + `SaveAsText(acReport)`. Radi nalog `Slavisa` (vlasnik, Admins; kredencijali u
`_legacy\BIGBIT_accounts.csv`, van gita) — `admin` nema read prava. Originali u `_legacy` netaknuti.

**287 palih u APL_2010 — NIJE korupcija** (retry + Compact&Repair + `/decompile` = 0 oporavljeno),
već okruženje: (1) linkovane tabele na nepostojećem `P:\Servoteh\` share-u, (2) VBA UDF koji se ne
kompajlira ovde, (3) orphan subreport zapisi. **Dovršetak:** ponoviti izvoz na mašini sa `P:\` share-om
(produkcioni server / RDP) ili relink-om tabela pre izvoza. Imena svih 713 u `APL_2010\_report_names.txt`.

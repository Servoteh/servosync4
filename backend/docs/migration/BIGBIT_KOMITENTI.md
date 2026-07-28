# BigBit — Komitenti (kupci/dobavljači): polja, unos, validacija, tok podataka

**Datum analize:** 27.07.2026
**Status:** činjenična rekonstrukcija iz DDL-a i VBA koda dostupnog lokalno (bez SSH na ubuntusrv/mdbtools
u ovoj sesiji). Svaka tvrdnja ima izvor (fajl + linija/funkcija). Gde nema dokaza — piše `NEPOZNATO`.
Nadovezuje se na [BB_T_26-analiza-klaster-A-maticni-tehnologija-reversi.md](BB_T_26-analiza-klaster-A-maticni-tehnologija-reversi.md)
§A.1a i [BB_T_26-analiza-F1-pokrivenost-polja.md](BB_T_26-analiza-F1-pokrivenost-polja.md) §1 — ovaj
dokument ide dublje samo na komitenta (polja, unos, validacija pri unosu, tačan mehanizam prenosa), ne
ponavlja ceo klaster.

---

## 0. Izvori

| Izvor | Šta je |
|---|---|
| `backend/docs/migration/BB_T_26_schema.sql` (linije 2426–2485, 429–440, 2499–2521, 2214–2223, 2280–2284) | **originalni BigBit DDL** — `Komitenti`, `KomitentiKontaktOsobe`, `MestaIsporuke`, `UplatniRacuni`, `Vrste sifara` |
| `_legacy/QBigTehn_APL/forms/Form_Unos komitenata.cls` | **kod-behind forme za unos** (čist VBA, bez binarnog šuma — najbolji izvor za ovaj dokument) |
| `_legacy/Izvoz/Forme/Unos komitenata.txt` | isti oblik forme kao raw export (binarni, korišćen samo za `RecordSource`/layout) |
| `_legacy/QBigTehn_APL/modules/LIB_PIB.bas` | validatori: `DobarPIB` (kontrolna cifra PIB-a), `DobarGLN` |
| `_legacy/QBigTehn_APL/modules/ImportIzBB_Module.bas` (f-ja `DodajNoveKomitenteIzBigBita`) | tačan mehanizam prenosa BigBit → QBigTehn |
| `_legacy/QBigTehn_APL/tables.txt` | popis linked tabela (`EXT_Komitenti` → `BB_T_26.MDB`) |
| `backend/prisma/schema.prisma` (linije 164–227, 1222–1228, 761–780) | trenutni model `Customer`/`CodeType`/`Salesperson` |
| `backend/src/modules/sync/syncers/customer.syncer.ts` | dedicated syncer (watermark, FK-resolve) |
| 30 backend modula koji čitaju `customers`/`Customer` (v. §6) | potrošači u 2.0/3.0 |

**Metod:** statička DDL i VBA analiza + prethodno izmereni brojevi redova iz F1 (6.669 Komitenti) —
nisu ponovo mereni ovde.

---

## 1. Komitenti — glavna tabela (57 kolona)

**PK:** `Sifra` (Long Integer / IDENTITY). Za razliku od artikla (§5.1 u BIGBIT_ARTIKLI.md), **ovde se PK
NE remapira** pri prenosu BigBit → QBigTehn — ista `Sifra` se koristi u oba sistema (v. §5.1). Ovo je
zabeleženo i ranije (F1), ovde potvrđeno tačnim SQL-om transfera.

Puna lista (izvor: `BB_T_26_schema.sql:2426-2485`, original; QBigTehn kopija relaksira većinu `NOT NULL`
u `NULL`, v. F1 §Šema-drift):

| Kolona (BigBit) | Tip | NOT NULL u originalu? | Trenutno polje u `Customer` | Napomena |
|---|---|---|---|---|
| Sifra | Long Integer | PK | `id` | |
| Naziv | Text(50) | DA | `name` | |
| Poslovnica | Text(50) | ne | `branch` | |
| Mesto | Text(30) | ne | `city` | |
| Adresa | Text(50) | ne | `address` | |
| Postanski broj | Text(20) | ne | `postalCode` | |
| Ziro racun_1/2/3 | Text(30) ×3 | ne | `bankAccount1/2/3` | do 3 tekuća računa po komitentu, ravno (ne child tabela) |
| Telefon | Text(20) | ne | `phone` | |
| Fax | Text(20) | ne | `fax` | |
| Kontakt | Text(50) | ne | `contact` | **jedan** string — v. §2.1 za pravu 1:N kontakt tabelu |
| Napomena | Memo(255) | ne | `note` | |
| Drzava | Text(30) | ne | `country` | |
| Region | Long Integer | ne | `region` | |
| Vrsta sifre | Text(10) | DA | `codeTypeCode` | FK → `Vrste sifara` (kupac/dobavljač/oboje — v. §2.4) |
| Email | Text(50) | ne | `email` | |
| Mobilni | Text(20) | ne | `mobile` | |
| Datum rodjenja | DateTime | ne | `birthDate` | za fizička lica |
| Web adresa | Text(50) | ne | `webAddress` | |
| Sifra prodavca | Long Integer | DA | `salespersonId` | FK → `Prodavci` — komercijalista zadužen za komitenta |
| RabatKomitenta | Double | DA | `customerDiscount` | opšti rabat komitenta |
| ZastKodKupca | Text(50) | ne | `buyerProtectionCode` | „zaštitni kod kupca" — verovatno anti-fraud/lojalnost kod |
| PIB | Text(20) | ne (originalno NULL-abilan!) | `taxId` | ⚠ u 2.0 `taxId` je `String` NOT NULL — v. §3.1 za posledicu |
| PDVStatus | Long Integer | DA | `vatStatus` | PDV status (obveznik/nije/izuzet — kodna vrednost, šifarnik nije lociran) |
| MSifra | Text(10) | ne | `externalCode` | eksterna šifra |
| Odlozeno | Integer | DA | `paymentTermDays` | valuta plaćanja (dana) |
| IDRuta | Long Integer | DA | `routeId` | FK bez tabele u 2.0 (rute se ne sinkuju) |
| IDVozac | Long Integer | DA | `driverId` | self-FK → `Customer` (vozač je i sam komitent/lice) |
| IDUplatniRacun | Long Integer | ne | `paymentAccountId` | FK → `UplatniRacuni` (v. §2.3) |
| FakturisanjePoMestimaIsporuke | Boolean | DA | `invoicePerDeliveryAddress` | flag — ali same adrese (`MestaIsporuke`) NISU sinkovane (v. §2.2) |
| Cenovnik | Text(5) | ne | `priceListCode` | koji cenovnik važi za ovog komitenta |
| PrviUnos | DateTime | ne | `createdAt` | |
| PoslednjaIzmena | DateTime | ne | `updatedAt` | **jedina tabela od 8 velikih matičnih sa watermark-om** — omogućava inkrementalni sync |
| PrviUnosUser | Text(20) | ne | `createdBy` | |
| PoslednjaIzmenaUser | Text(20) | ne | `updatedBy` | |
| ProcenatProvizije | Double | DA | `commissionPercent` | provizija (ako je komitent ujedno i posrednik?) |
| FiktRabatKomitenta | Double | DA | `fictitiousDiscount` | „fiktivni rabat" — verovatno za štampu (prikazan popust bez stvarnog uticaja na cenu) |
| KomitentiNacinPlacanja | Text(50) | ne | `paymentMethod` | |
| PotpisKom | Text(50) | ne | `signature` | |
| SkraceniNaziv | Text(30) | ne | `shortName` | |
| DatumIVremeKom | DateTime | ne | `recordCreatedAt` | (odvojeno od `PrviUnos` — namena razlike `NEPOZNATO`) |
| ProveraDuga | Boolean | DA | `checkDebt` | uključi proveru duga pri fakturisanju |
| KreditLimit | Currency | DA | `creditLimit` | `Decimal(19,4)` u 2.0 — ispravno, ne Float |
| NeProveravajPIB | Boolean | DA | `skipTaxIdValidation` | eksplicitan bypass PIB validacije (v. §3.1) — znači validacija SE primenjuje, ovo je izuzetak |
| IDPantheon | Text(30) | ne | `pantheonId` | veza ka spoljnom Pantheon sistemu (drugi ERP kod nekog partnera/matične firme?) |
| NewsLetter | Boolean | ne | `newsletter` | |
| PostaNaDruguAdresu | Boolean | DA | `mailToDifferentAddress` | |
| GLN | Text(30) | ne | `gln` | SEF/e-faktura (Global Location Number) |
| KLRucProc | Currency | DA | `manualMarkupPercent` | ručna kalkulativna marža specifična za komitenta |
| NapomenaZaSalda | Memo(255) | ne | `balanceNote` | napomena vezana za saldakonto/otvorene stavke |
| NePrikazatiUPregledu | Boolean | DA | `hideInOverview` | sakrij iz opšteg pregleda (neaktivan/arhiviran bez brisanja) |
| JBKJS | Text(10) | ne | `publicSectorId` | javni sektor (SEF) |
| MaticniBroj | Text(20) | ne | `registrationNumber` | |
| ER_XMLSaPopustomPoArtiklu | Boolean | DA | `einvoiceXmlPerItemDiscount` | e-faktura XML nosi popust po stavci (ne samo zbirno) |
| CRF | Boolean | DA | `centralInvoiceRegistry` | registrovan u CRF (Centralni registar faktura) |
| KoristiPNBZadModel | Boolean | DA | **NE POSTOJI u 2.0** | „koristi poziv-na-broj zadati model" — dodato u BigBit POSLE snapshot-a kopije, jedina rupa u 56/57 (v. F1) |

CHECK constraint-i i ostala pravila nisu eksplicitno viđeni u DDL-u za `Komitenti` (za razliku od
`R_Artikli` koji ima CHECK-ove) — validacija PIB-a/GLN-a je **isključivo na nivou forme** (VBA), ne baze
(v. §3).

---

## 2. Prateće tabele

### 2.1 Kontakt osobe — prava 1:N tabela postoji, nije korišćena u 2.0

Na samom `Komitenti` postoji samo `Kontakt` (jedan string, 50 karaktera). Ali BigBit ima zasebnu tabelu:

**`KomitentiKontaktOsobe`** (`BB_T_26_schema.sql:429-440`):

| Kolona | Tip | Značenje |
|---|---|---|
| `IDKontaktOsobe` | Long Integer | PK |
| `Sifra` | Long Integer NOT NULL | FK → Komitenti |
| `KontaktOsoba` | Text(50) | ime kontakt osobe |
| `KontaktTelefon` | Text(20) | |
| `KontaktFax` | Text(20) | |
| `KontaktMobilni` | Text(20) | |
| `KontaktEmail` | Text(50) | |
| `Datum rodjenja` | DateTime | |
| `KontaktDefault` | Boolean NOT NULL | koja je podrazumevana kontakt osoba (za slučaj više kontakata) |

**Status: potpun GAP.** `Customer.contact` je jedno polje — komitent sa više kontakt osoba (nabavka,
knjigovodstvo, direktor...) gubi sve sem jedne u 2.0/3.0. Za 4.0 `sales`/`masters` treba child tabela
`customer_contacts` sa `customerId` FK-om (ne overlay na `customers` — cache-never-touch, BACKEND_RULES §11.1).

### 2.2 Mesta isporuke — prava 1:N tabela postoji, flag na komitentu je „obećanje bez sadržaja"

**`MestaIsporuke`** (`BB_T_26_schema.sql:2499-2521`):

| Kolona | Tip | Značenje |
|---|---|---|
| `ID` | Long Integer | PK |
| `IDKomitent` | Long Integer NOT NULL | FK → Komitenti |
| `NazivMestaIsporuke` | Text(50) NOT NULL | naziv lokacije (npr. „Magacin 2", „Filijala Novi Sad") |
| `MestoIsporuke` | Text(30) NOT NULL | grad/mesto |
| `AdresaIsporuke` | Text(50) NOT NULL | adresa |
| `Telefon` | Text(20) | |
| `Podrucje` | Text(30) NOT NULL | područje/region isporuke |
| `Fax` | Text(20) | |
| `SifraProdavcaMestaIsporuke` | Long Integer NOT NULL | prodavac specifičan za TO mesto isporuke (može se razlikovati od glavnog prodavca komitenta) |
| `KategorijaUgovora` | Text(30) | |
| `OpstaKategorizacija` | Text(30) | |
| `KanalProdaje` | Text(30) | |
| `IDRutaMestaIsporuke` | Long Integer NOT NULL | ruta specifična za mesto isporuke |
| `IDVozacMestaIsporuke` | Long Integer NOT NULL | vozač specifičan za mesto isporuke |
| `IDUplatniRacunMestaIsporuke` | Long Integer NOT NULL | uplatni račun specifičan za mesto isporuke (fakturiše se na drugi račun po lokaciji!) |
| `GLN` | Text(30) | **svako mesto isporuke ima SVOJ GLN** — bitno za SEF (e-faktura per-lokacija, ne samo per-komitent) |
| `RegionMestaIsporuke` | Long Integer NOT NULL | |
| `AktivnoMISP` | Boolean NOT NULL | aktivno/neaktivno mesto isporuke |
| `PostBrojMestaIsporuke` | Text(20) | |
| `BrojMestaIsporuke` | Text(20) | interni broj mesta isporuke |

**Status: potpun GAP.** `Customer.invoicePerDeliveryAddress` (Boolean) je samo **flag** — kaže „ovaj
komitent se fakturiše po mestima isporuke" ali **same lokacije nisu modelovane nigde u 2.0/3.0**. Ovo
je značajniji gap nego što flag sugeriše: mesto isporuke nosi sopstveni GLN (bitno za SEF e-fakturu),
sopstveni uplatni račun, sopstvenu rutu/vozača/prodavca — praktično je to skoro pod-komitent. Za 4.0
`sales` obavezno modelovati kao `customer_delivery_locations` sa `customerId` FK.

### 2.3 Uplatni računi — šifarnik banaka, ne samo tekst polje

**`UplatniRacuni`** (`BB_T_26_schema.sql:2214-2223`):

| Kolona | Tip | Značenje |
|---|---|---|
| `ID` | Long Integer | PK |
| `UplatniRacun` | Text(50) NOT NULL | broj računa |
| `NazivBanke` | Text(50) | naziv banke |
| `Default` | Boolean NOT NULL | podrazumevani uplatni račun (firme, ne komitenta — kontekst je Servotehov sopstveni račun za uplate) |
| `KodZemlje` | Text(20) | |
| `Rbr` | Integer NOT NULL | redni broj |
| `OznakaBanke` | Text(20) | |

Ovo je **šifarnik** (verovatno Servotehovih sopstvenih uplatnih računa, ne komitentovih — `Komitenti.
Ziro racun_1/2/3` su komitentovi računi, dok je `IDUplatniRacun` FK na OVU tabelu, moguće za „na koji naš
račun ovaj komitent obično uplaćuje/mi šaljemo naloge"). **Status: sinkovano** (klaster A §A.1a napominje
„`UplatniRacuni` SE sinkuje (u mapi)"), ali nema Prisma modela imenovanog eksplicitno u ovoj analizi —
`NEPOZNATO` tačan naziv modela u schema.prisma (nije tražen u ovoj sesiji, van fokusa artikla/komitenta
osnovne tabele).

### 2.4 Vrsta šifre — kupac/dobavljač/oboje

**`Vrste sifara`** (`BB_T_26_schema.sql:2280-2284`): `Vrsta sifre`(PK Text10) NOT NULL, `Opis` Text(50).
Prost šifarnik od 2 kolone. **Sinkovan i modelovan** kao `CodeType` (`code_types`, `schema.prisma:1222-1228`),
sa `Customer.codeTypeCode` FK-om (default `"KUPDOB"` — sudeći po imenu, „KUPac-DOBavljač", tj. podrazumevana
vrednost je da je komitent i kupac i dobavljač istovremeno, dok konkretne vrednosti razdvajaju). U formi
za unos komitenta (`Form_Unos komitenata.cls:198-204`), dupli klik na polje `Vrsta_sifre` otvara zaseban
šifarnik-editor (`DoCmd.OpenForm "Vrste sifara"`) — administrativni prečac za dodavanje novih vrsta šifri
bez napuštanja forme komitenta.

### 2.5 Veza sa prodavcem

`Sifra prodavca` → `Prodavci` (16 kolona, potpuno sinkovano kao `Salesperson`, v. F1 §4). Nije dalje
analizirano u ovom dokumentu — pokriveno u F1.

---

## 3. Validacija pri unosu — konkretni algoritmi

### 3.1 PIB — kontrolna cifra (mod-11 checksum), potvrđen algoritam

`_legacy/QBigTehn_APL/modules/LIB_PIB.bas`, funkcija `DobarPIB(stPIB As String) As Boolean`:

- Uklanja prefiks `"SR"` ako postoji (SR + PIB je format koji se koristi u nekim EU/SEF kontekstima).
- Uzima prvih 8 cifara kao osnovu, poslednju (9.) cifru kao kontrolnu.
- Standardni **srpski PIB mod-11 algoritam** (isti kao za MB/JMBG kontrolnu cifru): svaka cifra se
  sabira sa prethodnim ostatkom, `Mod 10`, pa `× 2 Mod 11`, unazad kroz sve cifre; konačna kontrolna
  cifra `c0 = (11 - c1) Mod 10` mora se poklopiti sa poslednjom cifrom unetog PIB-a.
- Ako `Len(PIB) <> 8` (posle skidanja prefiksa i poslednje cifre) → automatski `False`.

**Kako se validacija primenjuje — dve varijante forme, različita strogost:**
- **Prava BigBit forma** (`_extracted/OnLine_BigBit_VBA/Doc__Form_Unos komitenata.txt:168-177`,
  `Form_BeforeUpdate`): ako `DobarPIB` computed kolona kaže ne → dijalog **„PIB nije dobar!!! Da li
  nastavljate unos?"** (Yes/No, default **No**) → na „No" `CancelEvent` blokira snimanje. Dakle
  **polu-tvrda brana sa svesnim override-om** — operater može da progura loš PIB, ali mora eksplicitno
  da klikne „Yes" preko default odgovora.
- **QBigTehn varijanta iste forme** (`QBigTehn_APL/forms/Form_Unos komitenata.cls`): samo vizuelni
  indikator kroz computed kolonu u `RecordSource`-u, bez `BeforeUpdate` brane.

Ni u jednoj varijanti **nije DB CHECK constraint** (PIB je NULL-abilan u originalu, nema CHECK u
DDL-u). Postoji i eksplicitan bypass:
`Customer.skipTaxIdValidation` (`NeProveravajPIB`) — znači postoje legitimni slučajevi (strani komitenti
bez srpskog PIB-a, fizička lica) gde se validacija namerno isključuje po komitentu.

**Posledica za 2.0/3.0:** `Customer.taxId` je `String` **NOT NULL**, dok je originalni `Komitenti.PIB`
NULL-abilan (F1 §Šema-drift #10). Za komitente bez PIB-a (retail kupci, fizička lica), sync mora nešto
upisati — v. §5.1 za tačan mehanizam koji BigBit sam koristi za ovaj slučaj (`XX_<Sifra>` placeholder,
ali to je specifično za BigBit→QBigTehn korak, ne za QBigTehn→2.0).

### 3.2 GLN — dužina i numerička provera

`DobarGLN(GLN As Variant) As Boolean` (`LIB_PIB.bas:84-110`): validno ako je `6 <= Len(GLN) <= 14` i
`IsNumeric(GLN)`. Prosta provera opsega, ne checksum algoritam (GLN ima svoj sopstveni check-digit
standard koji ovde nije implementiran — samo dužina i da su sve cifre).

### 3.3 Provera duplog PIB-a (lokalna) + NBS provera (nelocirana)

**Lokalna provera duplikata — potvrđena kodom.** Na formi „Pregled komitenata" postoji dugme
`DugmeDupliPIBovi` koje otvara upit `00_FirmeSaDuplimPIBovima`
(`_legacy/BigbitRaznoNenad/_extracted/queries_full/BigBit_APL_2010/00_FirmeSaDuplimPIBovima.sql`):

```sql
SELECT Komitenti.PIB, Komitenti.Sifra, Komitenti.Naziv, Komitenti.Mesto, [00_DupliPIBovi].CountOfPIB
FROM 00_DupliPIBovi INNER JOIN Komitenti ON [00_DupliPIBovi].PIB = Komitenti.PIB
ORDER BY Komitenti.PIB;
```

Dakle: pregled svih komitenata koji dele isti PIB (agregat `00_DupliPIBovi` broji pojave). Ovo je
administrativni alat na zahtev (dugme), ne automatska brana pri unosu — BigBit dozvoljava snimanje
duplog PIB-a. (3.0 je već uveo tvrdu branu za jedinstven kataloški broj artikla po istom principu —
za PIB komitenta u 4.0 treba doneti istu odluku: brana ili samo izveštaj.)

**NBS provera (korisnik pamti da postoji) — NELOCIRANA u dostupnim exportima.** Po Nenadovom sećanju
(27.07.2026), u komitentima postoji provera PIB-a „kod NBS" — da li privredni subjekat sa tim PIB-om
postoji u registru. Pretraženo bez pogotka: svi lokalno raspakovani VBA exporti (OnLine BigBit 2010,
QBigTehn APL, Izvoz — nema `nbs.rs` URL-a, SOAP/XMLHTTP poziva ka NBS, `FollowHyperlink` po PIB-u),
CFG/properties CSV-ovi, DDL obe baze (nema NBS tabela/parametara). Binarni UTF-16 sken `BigBit_APL_2010.MDB` (kompletiran 28.07): svih 10 „NBS" pogodaka su labele na
formama („Overa prijema NBS", „…kontrola NBS", „…propisima NBS", „autonomna pokrajina, jedinica
lokalne samouprave ili NBS" — JBKJS/budžetski kontekst) — nijedan nije kod, URL ni web-servis poziv.
Isti sken transakcione `BB_T_26.mdb`: svi pogoci su TEKST PODATAKA (napomene na fakturama/predmetima
o „srednjem kursu NBS na dan…"), ne kod.
**Najverovatnija lokacija: VBA tekućeg 2026 APL-a (`ubuntusrv:/tmp/bb26/APL.MDB`) koji nije izvučen**
— mdbtools ne vadi VBA module; ZR moduli su ranije vađeni kroz Access. Tipična izvedba bi bila NBS
„Jedinstveni registar računa" web servis (pretraga po PIB-u vraća naziv/račune) — `NEPOZNATO` dok se
ne izvuče VBA iz živog APL-a (v. §8).

### 3.4 Bankovni računi — `DobarTR` (mod-97), pronađen i VEĆ portovan u 3.0/4.0

Isti `RecordSource` forme (`Unos komitenata.txt:22-24`) primenjuje `DobarTr(Nz([Ziro racun_N],""))` na
sva tri žiro računa (`DobarTR1`/`DobarTR2`/`DobarTR3` computed kolone).

**Implementacija: `_legacy/QBigTehn_APL/modules/KontrolniBrojevi.bas:127-162`** (`Function DobarTR`;
bajt-identična i u `_extracted/OnLine_BigBit_VBA/Module__KontrolniBrojevi.txt`). Algoritam: račun se
parsira kao `bbb-nnnnnnnn-kk` (3 cifre banka, srednji deo, 2 kontrolne); format mora tačno da se
rekonstruiše (`tr = ntr` provera); srednji deo se dopuni vodećim nulama na 13 cifara; kontrolni broj
`KBroj97(banka + račun13)` (mod-97) mora biti jednak poslednje 2 cifre. *(Ispravka 28.07: prvobitna
verzija ovog dokumenta je tvrdila da implementacija nije pronađena — grep je bio case-sensitive, a
funkcija se zove `DobarTR`.)*

**U 3.0/4.0 već postoji port:** `backend/src/modules/placanja/mod97.util.ts` — `isValidAccountNumber`
(struktura + `KBroj97(banka3 + račun.padStart(13,"0")) === poslednje2`). Za budući CRUD komitenata
koristiti taj postojeći util, ne pisati nov.

---

## 4. Kako se komitent unosi danas (BigBit — forma „Unos komitenata")

Kod-behind (`Form_Unos komitenata.cls`, potpuno pročitan — 205 linija, čist VBA bez binarnog šuma):

- **`Form_Open`**: pri otvaranju forme, automatski skoči na **poslednji** slog (`DoCmd.GoToRecord , ,
  acLast`) i fokusira polje za pretragu po nazivu (`ComboPoNazivu`) — operater po defaultu vidi
  najnovije unetog komitenta, ne prvog po abecedi/šifri.
- **Pretraga:** dva odvojena combo-boxa za brzi skok — `ComboPoNazivu` (pretraga po nazivu, `AfterUpdate`
  radi `FindFirst "[Sifra] = " & ...` pa skoči na bookmark) i `PronadjiPoZRRN` (verovatno pretraga po
  ZR/RN broju — nezavisan put ka istom komitentu preko poslovnog dokumenta).
- **Dugmad na formi:**
  - `Dugme_Novi_komitent` — `DoCmd.GoToRecord , , A_NEWREC` + fokus na `Naziv` (prvo polje koje se
    popunjava je uvek naziv, ne šifra — šifra je auto-increment).
  - `Dugme_Obrisi_komiten` / `Dugme_Obrisi_slog` — identična implementacija (Access built-in
    select+delete meni komande) — **fizičko brisanje sloga**, nema meko brisanje/flag na komitentu (za
    razliku od artikla koji ima `ZaBrisanje` flag umesto pravog DELETE-a — v. BIGBIT_ARTIKLI.md §1).
    Ovo je bitna razlika u pristupu brisanju između dva matična entiteta.
  - `Dugme_Ponisti_unos` — `A_UNDOFIELD`, sa porukom „Možete da poništite samo tekući unos ili
    ispravku!" ako se pozove van konteksta.
  - `Dugme_Snimi_komitent` — eksplicitno čuvanje (`A_SAVERECORD`), pored automatskog Access
    snimanja pri promeni sloga.
  - `Dugme_Prethodni_slog`/`Dugme_Sledeci_slog` — navigacija.
  - `Dugme_Trazi`/`Dugme_Pronadji_komit` — otvaraju Access built-in Find dijalog (meni komanda 10).
  - `Dugme_Stop` — zatvara formu.
- **`Vrsta_sifre_DblClick`** — dupli klik na polje otvara šifarnik `Vrste sifara` direktno (v. §2.4).

Gornji opis važi za **QBigTehn varijantu** forme. **Prava BigBit forma** (nađena naknadno u
`_extracted/OnLine_BigBit_VBA/Doc__Form_Unos komitenata.txt`, 220 linija) ima i dodatke:

- **PIB polu-tvrda brana** u `Form_BeforeUpdate` (v. §3.1) — dijalog sa default „No" pre snimanja
  lošeg PIB-a.
- **Pretraga po PIB-u** — poseban combo `PronadjiPIB` (:198-203) skače na komitenta po PIB-u; uz
  `ComboPoNazivu` i `PronadjiPoZRRN` to su tri nezavisna puta do sloga.
- **Field-level permisija**: polje `KomitentiNacinPlacanja` je zaključano i otključava se SAMO ako je
  tekući Access user u grupi **`KomAvPlacanje`** (`UserUGrupi(CurrentUser(), "KomAvPlacanje")`,
  :186-196; na `LostFocus` se ponovo zaključava) — način plaćanja komitenta (avansno i sl.) sme da
  menja samo ovlašćena grupa. Za 4.0: presedан za per-polje autorizaciju na matičnim podacima.
- **Vozač automatika** (:212-219): ako je `Vrsta sifre` LIKE `"Voza*"` i `IDVozac` prazan → slog se
  snimi pa `IDVozac = sopstvena Sifra` (komitent-vozač referiše samog sebe; objašnjava self-FK
  `Customer.driverId`).

GLN i tekući računi ostaju čisto vizuelni indikatori u obe varijante. Za 4.0 i dalje važi: tvrda
validacija na granici sistema (uz svestan `skipTaxIdValidation` bypass po komitentu, koji legacy
takođe ima).

---

## 5. Tok podataka: BigBit → QBigTehn → servosync4 (tačan mehanizam)

```
BigBit original (BB_T_26.MDB, Komitenti)
      │  EXT_Komitenti = LINKED tabela (ODBC/Access link)
      ▼
QBigTehn Access app (QBigTehn_APL) — dugme "Preuzmi iz BB"
      │  DodajNoveKomitenteIzBigBita() — SAMO NOVI REDOVI, ISTA Sifra (PK se NE remapira)
      ▼
QBigTehn SQL Server (vasa-SQL:5765, baza QBigTehn, tabela Komitenti)
      │  POST /sync/run — customer.syncer.ts, watermark: PoslednjaIzmena (INKREMENTALNO)
      ▼
servosync4 Postgres (customers)
```

### 5.1 BigBit → QBigTehn: `DodajNoveKomitenteIzBigBita`

```vba
SELECT EXT_Komitenti.Sifra, EXT_Komitenti.Naziv, ..., 0 AS [Sifra prodavca], EXT_Komitenti.RabatKomitenta,
       EXT_Komitenti.ZastKodKupca,
       IIf(Nz([EXT_Komitenti].[PIB],"")="", "XX_" & [EXT_Komitenti].[Sifra], [EXT_Komitenti].[PIB]) AS PIB,
       EXT_Komitenti.PDVStatus
FROM EXT_Komitenti LEFT JOIN Komitenti ON EXT_Komitenti.Sifra = Komitenti.Sifra
WHERE (((Komitenti.Sifra) Is Null));
```

Dve konkretne poslovne odluke, potvrđene kodom:

1. **`Sifra prodavca` se UVEK postavlja na `0`** pri transferu, bez obzira šta stoji u BigBit originalu
   — prodavac se očigledno mora ručno dodeliti posle transfera u QBigTehn strani (ne prenosi se
   automatski). `NEPOZNATO` zašto (možda zato što prodavci u QBigTehn imaju drugačiji šifarnik/ID prostor
   od BigBit prodavaca u trenutku pisanja ovog koda).
2. **Prazan PIB dobija placeholder `"XX_" & Sifra`** (npr. `"XX_4821"`) umesto NULL. Ovo direktno
   objašnjava zašto `Customer.taxId` može biti `NOT NULL` u 2.0 bez greške pri sync-u — BigBit-ov
   originalni NULL PIB nikad ne stiže do QBigTehn kopije kao NULL, uvek je popunjen bar placeholder-om.
   **Ovo je bitna, do sada nedokumentovana činjenica**: F1 analiza je uočila „PIB NULL-abilan u
   originalu, NOT NULL u kopiji" kao šema-drift rizik, ali nije objasnila KAKO se taj drift bezbedno
   premošćuje — sada je potvrđeno da premošćavanje radi upravo ova `IIf` klauzula u transfer upitu.
   **Za 4.0 direktan BigBit sync (Sync B) ovu istu `IIf` logiku treba svesno replicirati**, jer bez nje
   NULL PIB direktno puca na `taxId NOT NULL` u Postgres šemi.

**PK se NE remapira** (`Sifra` ostaje `Sifra`, nema surogat kolone kao `BBSifra artikla` kod artikla) —
zato je `Customer.id` **direktno** BigBit šifra komitenta, bez posrednog mapiranja. Ovo je fundamentalna
razlika u odnosu na artikal (v. BIGBIT_ARTIKLI.md §5.1) i čini `customers` znatno „bezbednijom" tabelom
za direktan cutover u 4.0 — nema potrebe za remap ključeva.

**Isti append-only obrazac** (`WHERE ... IS NULL`, LEFT JOIN anti-join) kao kod artikla — **nema
pronađene `UPDATE Komitenti` naredbe** u `ImportIzBB_Module.bas`/`ODBC_Synch_*.bas`/`ADO_Synch.bas`
koja bi osvežila postojeće komitente kad se izmene u BigBit-u (adresa, telefon, kreditni limit...).
`EXT_Import.bas` ima dve `UPDATE Komitenti` naredbe, ali obe su specifične za GK import po PIB-u
(`UPDATE Komitenti INNER JOIN tmp_StavkeGKZaImport ON Komitenti.PIB = ...`), nisu opšti refresh iz
BigBit-a. **Isti operativni rizik kao kod artikla (BIGBIT_ARTIKLI.md §5.1, §7)** — treba proveriti da
li postoji drugi, ovde neobuhvaćen mehanizam za osvežavanje postojećih komitenata.

### 5.2 QBigTehn → servosync4: dedicated syncer, INKREMENTALNO

`customer.syncer.ts` — jedini domenski (ne generic) syncer među 8 velikih matičnih tabela (v. F1).
Koristi `PoslednjaIzmena` watermark: `WHERE [PoslednjaIzmena] > @cursor`. FK-ovi (`salespersonId`,
`codeTypeCode`) se **razrešavaju unapred u Set-ove** i null-uju ako ciljna vrednost ne postoji, umesto da
sync padne na tom redu (obrazac ponovljen kroz sve syncere po BACKEND_RULES §5).

**Posledica:** `customers` u servosync4 je znatno „svežija" u odnosu na QBigTehn kopiju nego što je
`items` svež u odnosu na svoju kopiju (ovaj korak IMA watermark), ali svežina same QBigTehn kopije u
odnosu na BigBit original ima isti upitnik kao kod artikla (§5.1 append-only rizik).

---

## 6. Trenutno stanje u servosync4 (šta danas postoji)

- **Modeli:** `Customer` (`customers`), `CodeType` (`code_types`), `Salesperson` (`salespeople`) —
  sve tri sinkovane, `UplatniRacuni` takođe (naziv Prisma modela nije potvrđen u ovoj sesiji).
- **Upis:** ISKLJUČIVO `customer.syncer.ts`. Pretraga po `backend/src/modules` ne nalazi nijedan
  `customer.create`/`customer.update`/`customer.upsert` na Prisma `Customer` model u aplikativnom kodu
  — `customers` je **čist read-only cache**, isti obrazac kao `items`.
  `codeType`/`salesperson` relacije se koriste samo za čitanje.
- **Nema CRUD UI ni API endpoint-a za komitente.** Nema `backend/src/modules/customers`/`komitenti`
  modula, nema `frontend/src/app/**/komitenti` rute. Komitent se **ne unosi u 3.0/4.0 danas** — unosi se
  isključivo u BigBit, kroz formu opisanu u §4.
- **Potrošači `customers` u 2.0/3.0** (read-only, preko `customerId`/`komitentId` mekog FK-a) — 30
  fajlova pronađenih pretragom, najznačajniji po domenu:
  - `sales/*` (fakturisanje, avansni računi, SEF/UBL builder, PDF štampa) — najintenzivniji potrošač
  - `saldakonti/*` (partner-card, dunning/opomene, IOS, kompenzacije)
  - `placanja/*` (priprema plaćanja, export naloga, PDF naloga)
  - `pdv/*` (avansni PDV, ručni PDV unosi)
  - `izvodi/*` (bankovni izvodi — matching po komitentu)
  - `gl/*` (štampa naloga knjiženja)
  - `nabavka/*` (3-way match — komitent kao dobavljač)
  - `work-orders/*`, `handovers/*`, `kamata/*`
- **Nijedan modul ne piše nazad u `customers`** — svi samo čitaju `name`/`taxId`/`bankAccount*`/adresu za
  prikaz i štampu dokumenata.

---

## 7. Gap analiza — šta nedostaje za 4.0 `masters`/`sales` (prioritizovano)

| # | Šta nedostaje | Trenutni gap | Cena porta | Prioritet |
|---|---|---|---|---|
| 1 | Kontakt osobe (`KomitentiKontaktOsobe`, 1:N) | `Customer.contact` je jedan string, gubi sve dodatne kontakte | mala-srednja (nova child tabela + FK) | **VISOK** — direktno utiče na svakodnevnu komunikaciju sa kupcima |
| 2 | Mesta isporuke (`MestaIsporuke`, 1:N sa sopstvenim GLN/računom/rutom) | samo flag `invoicePerDeliveryAddress`, bez ijedne stvarne lokacije | srednja (nova child tabela, dotiče SEF e-fakturu) | **VISOK** — SEF per-lokacija GLN je regulatorno bitno |
| 3 | `KoristiPNBZadModel` (poziv-na-broj model) | nedostaje 1 kolona, dodata u BigBit posle snapshot-a kopije | trivijalna (1 kolona) | SREDNJI (4.0 banking) |
| 4 | `Rabati`/`RabatiPoArt` (v. BIGBIT_ARTIKLI.md §2.3) | rabat po komitentu × grupi/artiklu nema ekvivalent | srednja | SREDNJI (sales pricing, deljeno sa artiklom) |
| 5 | Validacija tekućeg računa (`DobarTr`) | implementacija nije locirana, ne zna se tačan algoritam | nepoznata dok se ne pronađe/rekonstruiše | NIZAK dok se ne potvrdi da je potrebna |
| 6 | Fizičko brisanje bez traga | BigBit dozvoljava DELETE komitenta (nema soft-delete kao kod artikla) | — (odluka o pravilu, ne o portu) | RAZMOTRITI za 4.0 — verovatno soft-delete umesto DELETE, radi audit traga |
| 7 | Tvrda validacija PIB/GLN/račun pri unosu | BigBit samo vizuelno upozorava, ne blokira snimanje | mala (validacija na granici, već je princip u BACKEND_RULES) | VISOK za 4.0 CRUD kad god nastane |

**Operativni rizik (isti obrazac kao kod artikla, §5.1):** append-only transfer znači da izmene
postojećih komitenata u BigBit-u (adresa, telefon, kreditni limit, bankovni računi) možda ne stižu
automatski dalje. Za razliku od artikla, ovde **watermark na sledećem koraku (QBigTehn→2.0) barem
garantuje** da SVE što uspe da stigne do QBigTehn kopije (na bilo koji način, uključujući ručnu izmenu
direktno u QBigTehn aplikaciji) stiže dalje do Postgres-a inkrementalno. Rizik je ograničen na prvi
korak (BigBit→QBigTehn), ne na oba koraka kao kod artikla.

**PIB placeholder (`XX_<Sifra>`) je krhka konvencija koju 4.0 mora svesno preneti** ako direktno čita
BigBit — bez nje, komitenti bez PIB-a (retail/fizička lica) padaju na `taxId NOT NULL` ograničenju.

---

## 8. Otvorena pitanja (NEPOZNATO — treba proveriti sa Nenadom/Nesom ili direktno na BigBit originalu)

1. ~~Implementacija `Function DobarTr`~~ **REŠENO 28.07 (v. §3.4):** `KontrolniBrojevi.bas:127` +
   postojeći port `backend/src/modules/placanja/mod97.util.ts`.
1b. **NBS PIB provera (Nenad potvrđuje da postoji, kod nelociran — v. §3.3):** izvući VBA module iz
   tekućeg APL-a (`ubuntusrv:/tmp/bb26/APL.MDB`) kroz Access (mdbtools ne može) i naći
   funkciju/dugme koje zove NBS; utvrditi da li je web servis (koji, sa kojim kredencijalima —
   verovatno CFG parametar) ili otvaranje NBS pretrage u browseru. Tek onda planirati 4.0 ekvivalent
   (NBS „Jedinstveni registar računa" API zahteva registrovan nalog).
2. Zašto se `Sifra prodavca` uvek postavlja na `0` pri transferu novog komitenta iz BigBit-a (ručna
   naknadna dodela — potvrditi da li je to zaista operativna praksa).
3. Da li BigBit izmene postojećih komitenata (adresa, telefon, kreditni limit, bankovni računi) ikad
   stižu u QBigTehn kopiju van append-only „Preuzmi iz BB" mehanizma.
4. Šifarnik `PDVStatus` (kodne vrednosti — obveznik/nije/izuzet/…) — tabela nije locirana u ovoj analizi.
5. Tačan naziv Prisma modela za `UplatniRacuni` (potvrđeno da se sinkuje, model nije eksplicitno tražen
   u ovoj sesiji).
6. Namena razdvajanja `PrviUnos`/`DatumIVremeKom` (dva različita „datum kreiranja" polja na istom slogu).
7. Značenje `ZastKodKupca` („zaštitni kod kupca") — nije pronađen kontekst upotrebe u dostupnom kodu.

# Analiza legacy modula NABAVKA (BigBit / MS Access ERP "SERVOTEH 2023")

Izvor: `Upustvo za Nabavku - 20 06 2023.docx`
Sistem u naslovnoj traci: **"SERVOTEH 2023 – Software by Slaviša Đurić"** (Access aplikacija, interno zvana "BigBit").
Dokument sadrži **16 screenshotova** (PNG) — 6 formi/menija Access aplikacije, 3 email screenshota (Outlook) i 3 prikaza Windows foldera (SHARES/Predmeti). EMF/WMF fajlova nema.

Napomena o metodu: uputstvo je operativni "how-to" za administratora nabavke, nije tehnička specifikacija. Nazivi polja, dugmadi i statusa u nastavku očitani su direktno sa screenshotova; poslovna pravila iz teksta uputstva.

---

## 1. Kompletan tok procesa NABAVKE (od početka do kraja)

```
Specifikacija (od projektanta / ovlašćenog lica)
        │
        ▼
[1] ZAHTEV KA DOBAVLJAČU  (forma "Zahtevi dobavljačima za ponudu")
        │   upit dobavljaču → status: Poslat upit
        ▼
    Ponuda dobavljača  →  prosleđuje se INICIJATORU na potvrdu
        │   (status: Prosleđen inicijatoru)
        │   pregovori: korekcije, uslovi plaćanja, rokovi isporuke
        ▼
    Inicijator potvrdi ponudu (ponuda OBAVEZNO u prilogu potvrdnog maila)
        │   (status: Poručen)   ── ili ── Odustali
        ▼
[2] PORUDŽBENICA  (forma "Naručivanje robe")
        │   unos artikala, količina, rokova, radnog naloga; štiklira se "Poručeno"
        │   parcijalne isporuke → nova, "Vezana narudžbina" (opcija "Upiši stavke iz porudžbine")
        ▼
[3] PLAĆANJE (ako je avans / predračun / profaktura)
        │   mail ka adm. prodaje (Subject: iznos avansa + nalog + primalac; cc Nevena i Nenad)
        │   > 1.000 EUR → štampa + potpis Direktora
        │   avansni račun sa SEF-a → adm. asistent (knjiži na avans, ne na dobavljača)
        │   INO: provera IBAN/SWIFT na proformi; SWIFT potvrda → prosleđuje se dobavljaču
        ▼
[4] PRIJEM ROBE + KONTROLA
        │   Ulazna faktura ⇄ Porudžbenica (količina, cena) — MORAJU se slagati
        │   Otpremnica ⇄ Porudžbenica — MORAJU se slagati
        │   reklamacija ako se ne poklapa
        ▼
[5] KNJIŽENJE / ULAZ U MAGACIN
        │   broj porudžbine se upisuje na fakturu (uslov za knjiženje)
        │   po radnom nalogu: rezervacija / fakturisanje (dalja prodaja) / na stanje
        │   faktura na potpis i pregled → knjiženje; na fakturi se piše "plaćeno"
        ▼
[6] PRAĆENJE  (forma "Pregled narudžbina")
            neisporučene stavke → praćenje rokova, kontakt dobavljača,
            obaveštavanje inicijatora / kupca; organizacija transporta
```

Redosled dokumenata: **Specifikacija → Zahtev za ponudu (upit) → Ponuda → Porudžbenica (narudžbina robe) → [Profaktura/Predračun + avansno plaćanje] → Prijem → Ulazna faktura + Otpremnica → Knjiženje / ulaz u magacin.**

Paralelni tokovi (grananja):
- **Materijal (sirovine):** admin nabavke može samoinicijativno tražiti više ponuda i birati najpovoljniju; teži se lagerovanju i nabavci većih količina; transport se objedinjuje po lokacijama (npr. Atenic commerce doo — čeka se dovoljna količina).
- **Trgovačka roba (za dalju prodaju, ne za projekat):** stavke se prepisuju iz prihvaćene **profakture** (pažnja: ceo dokument ili samo pozicije koje nisu na lageru).
- **Uvozna roba:** komunikacija sa špedicijama; detaljno u posebnom odeljku "Uvoz i carina" (van ovog dokumenta).

---

## 2. Forme / ekrani (naziv, polja, dugmad, pravila)

### 2.0 Meni Magacin (image1) i glavni meni BigBit (image7)
Ulazne tačke iz menija:
- **BigBit / Magacin / Zahtev ka dobavljaču** — pokreće formu iz §2.1
- **BigBit / Magacin / Naručivanje robe** — forma iz §2.2
- **Magacin / Pregled narudžbina** — forma iz §2.5
- **Magacin / PREDMETI / Unos predmeta** — unos predmeta (projekta)
- **Glavni meni / ARTIKLI / Unos, Pregled** (`Godina: 2023`) — forma artikla §2.4

---

### 2.1 Forma "Zahtevi dobavljačima za ponudu" (Zahtev ka dobavljaču) — image2
Ovo je RFQ / evidencija upita dobavljačima. Grid (lista) sa filter-trakom na vrhu.

**Filteri:** `Za komitenta`, `Za odgovorno lice`, `Za status`, polje `Pronadji`.
**Dugmad:** `Novi zahtev`, `Napravi predmet`, `Predmet`, `Prikaži sve`, `Tabela statusa`, `Radni nalog`, `Primeni uslove`, STOP (zatvori).
**Kolone grida:**
- `Inicijator zahteva` (npr. Zoran Jaraković, Milan Nikodijević — projektant/ovlašćeno lice)
- `Datum`
- `Opis` (iz specifikacije — npr. "Servis – popravku sušača", "Usluga termičke obrade")
- `Rok za ponudu` (dana / datum)
- `Predmet` (broj predmeta/projekta, npr. 7380, 4668)
- `Radni nalog`
- `Poreklo zahteva` (npr. "MEJL")
- `Status` (padajući) — **Poslat upit / Prosleđen inicijatoru / Porucen**
- `Odgovorno lice` (npr. "Korisnik")
- `Napomena` (npr. "TME – čekamo da bide na stanju", "uneti u PO 14152")

**Poslovna pravila (iz teksta):**
- U napomenu se beleži: da li je upit poslat većem broju dobavljača, da li je u procesu / korekcijama.
- Dobijena ponuda ide inicijatoru na potvrdu. Za tehnička pitanja upisuje se kontakt projektanta koji je inicirao nabavku.
- Ako ponuda ne stigne za dan-dva → zove se dobavljač radi provere statusa.
- Ako inicijator ne odgovara više dana a radni nalog je otvoren → podsetiti ga. Ako se odustane ili roba nađe na lageru → upisati u napomenu.

**Statusi zahteva (workflow):** `Poslat upit` → `Prosleđen inicijatoru` → `Poručen` | `Odustali`.

---

### 2.2 Forma "Naručivanje robe" (Porudžbenica / narudžbina) — image3, image4, image5
Glavna forma porudžbenice. Popunjava se **tek nakon prihvatanja ponude**.

**Zaglavlje / identifikacija:**
- Interni broj forme (npr. `15169`, `15003`) + dugme `Novo naručivanje`
- `Pronadji narudžbinu`, `Tekst na por.` (padajući, npr. "Narudžba robe")

**Sekcija Dobavljač:** `Šifra` (npr. 1000244), `Naziv` (Siemens d.o.o. / DMG Mori Balkan GMBH / ATB Sever d.o.o.), `Mesto`, `PIB`.
> Pravilo: naziv se bira po nazivu, a ako se ne zna kako je unet — po PIB-u.

**Zaglavlje dokumenta:**
- `Datum naručiv.`, `Broj narudžbine` (npr. 14148, 14009) — **sistem sam dodeljuje broj**, IZUZEV pneumatike gde brojevi idu hronološkim redom
- `Valuta` (padajući: RSD / USD / EUR), `Kurs`
- `Definisao zahtev` (padajući — najčešće projektant, npr. Zoran Jaraković, Milorad Jerotić; za više njih imena se stavljaju u opis/napomenu)
- `Poručeno` (checkbox) — **obavezno štiklirati kad je roba poručena**
- `Potpisano` (checkbox)
- `Opis` (žuto polje) i `Nap.` (napomena, žuto polje) — npr. avansni uslovi, uputstvo koga obavestiti kad roba stigne ("@Duško; Kada stigne harmonika obavestiti Ivana Umićević")

**Sekcija Cenovnik:** `Cenovnik` (npr. STDCN), dugme `Upiši cene iz cenovnika` (napomena: "Cene artikala koji se ne nalaze u cenovniku neće biti promenjene").

**Sekcija veza / kopiranje:** `Prepiši narudžbinu`, `Vezana narudžbina`, `Za profakturu` → `Upiši stavke ponude u profakturu`.

**Dugmad (traka gore desno):**
- `Upiši artikle po uslovu` (po Kat. broj / Grupa / Podgrupa / Poreklo)
- `Upiši stavke iz profakture`
- `Upiši artikle dobavljača`
- `Upiši stavke iz porudžbine` (opcija "prepiši" za parcijalne isporuke — image6)
- `Obriši stavke koje nisu naručene`
- `Upiši naručenu količinu u isporučenu`
- Štampa PDF-a: `Narudžbina bez cena ENGLESKI`, `Narudžbina bez cena SRPSKI`, `Narudžb. sa cenama ENGLESKI`
- `Prevod računa za carinu`, ikonica štampe, Excel export, STOP

**Stavke (grid):** `Kataloški broj`, `Naziv artikla`, `Jed. mere` (Kom/kg/m), `Zalihe`, `Količina za nar.`, `Cena`, `Vrednost narudžbine`, `Isporučena količina`, `Predmet` (broj projekta, npr. 7498, 7380), `Isp.` (checkbox — isporučeno po stavci), `Napomena`, `Opis`.

**Poslovna pravila:**
- Očekivani rokovi isporuke i radni nalog upisuju se po stavci.
- **Parcijalne isporuke:** otvara se nova porudžbenica povezana sa originalnom (`Upiši stavke iz porudžbine`). Iz originalne se **izbrišu prepisane stavke** (ili se ostavi 0 u isporučenoj količini) jer se na osnovu toga vrši dalje knjiženje.
- Zvanične porudžbenice šalju se INO dobavljačima **sa cenama**; obavezno tražiti potvrdu porudžbine sa rokovima, koji se onda unose.
- **Pravila za šifru artikla (Dobavljač vs Proizvođač) — kritično:**
  - Siemens komponente kupljene od drugih dobavljača → unose se **pod Siemens šifrom**.
  - Konvex šifre → sa **ponude**, ne sa fakture.
  - Enel šifre → uneto sa fakture (menja se: ići će šifre **proizvođača**; definiše elektro inženjer).
  - VITa Elko → šifra **proizvođača**, ne dobavljača.
- Elektro materijal / komponente — voditi računa da li ide na projekat ili na stanje.

**Primer avansa (image5):** ATB Sever d.o.o., EUR, `Poručeno` štiklirano, Opis: "30% avansa uplaćeno – 2 376,00 evra – ostalo pred isporuku".

---

### 2.3 Opcija "Upiši stavke iz porudžbine" / "prepiši" (dugme) — image6
Dugme za kreiranje nove porudžbenice kopiranjem stavki iz postojeće (za parcijalne isporuke i povezivanje sa originalnom narudžbinom).

---

### 2.4 Forma "Artikal" (šifarnik artikala) — image8, image9
Otvaranje/uređivanje artikla kad traženi ne postoji.

**Zaglavlje:** broj artikla (npr. 117286, 105107), dugmad `Novi artikal`, `Kartica artikla`, `Recept za proizvodnju`, ✓ (snimi), ✗ (odustani), 🗑 (obriši).
**Pretraga:** `Pronadji artikal po kataloškom broju / po bar kodu / po nazivu`.
**Polja:** `Kataloški broj`, `Bar kod`, `Naziv` (npr. "Cev profilna 200x100x4", "Vodeća čaura klipnjače za cil. Ø63…"), `Pakovanje`, `Jed. mere` (kg / Kom), `Kilograma u komadu`, `Ext. šifra`, `Maksimalan rabat %`, `Grupa` (Repro / Pneumatika…), `Opis grupe`, `Podgrupa`, `Opis podgrupe`, `Minimalna količina`, `Odloženo plaćanje (dana)`.

**Poslovna pravila:** kataloški broj se unosi ručno ili automatski (program predloži) kad je materijal; grupa "Repro" za repromaterijal; jedinica mere kg/m/kom. Pre otvaranja proveriti postojanje po nazivu ili u prethodnim porudžbenicama. Materijal, ležajevi, elektro komponente, pneumatika, hidraulika, SKF komponente — uglavnom već postoje.

---

### 2.5 Forma "Pregled narudžbina" (praćenje / izveštaj) — image13
Praćenje toka nabavke, isporuka i kašnjenja.

**Prikaz:** `Po dokumentima` / `Po artiklima`.
**Filteri:** `Od datuma`, `Do datuma`, `Za dobavljača`, `Zahtev definisao`, `Poručeno`, `Isporučeno`, `Potpisane`, `Za broj predmeta`, `Za naziv predmeta`, `Za broj narudžbine`, `Za komitenta`, `Za valutu`, `Za grupu` / `podgrupu` / `podpodgrupu`, `Za PO broj`.
**Dugmad:** `Primeni uslove`, `STD Juče`, `STD Danas`, `Detaljno porudžbina`, `Detaljno predmet`, štampa, STOP.
**Kolone:** `Broj predmeta`, `Naziv predmeta`, `Definisao zahev`, `Naziv dobavljača`, `Broj narudžbine`, `Datum narudžbine`, `Očekivani dat. isporuke`, `Vrednost narudžbe`, `Vrednost isporuke`, `Opis`, `Poručeno` (checkbox), `Isporučeno` (checkbox).

**Pravilo:** ako stavka nije štiklirana kao `Isporučeno` → prate se rokovi, kontaktira dobavljač, obaveštava inicijator (ili kupac za trgovačku robu).

---

### 2.6 Email komunikacija za plaćanje (Outlook) — image11, image12
Nije Access forma, ali je deo obaveznog toka.
- **image11:** Subject `"NS Koncept" d.o.o. – 50% avansa – 54.700,38 za rn 7570`, od Tatjana Jaraković → Jelena Đurutović, cc 2 osobe, prilog `P_0294-V2.pdf`.
- **image12:** Subject `Minel Trafo za rn 7351 – … – 16 080,60 eur po srednjem kursu`, cc uključuje `nevena.knezevic@servoteh.rs` (predračun > 1.000 EUR).

**Pravila poslovne komunikacije pri plaćanju:**
- U Subject: iznos avansa + za koji nalog + kome se plaća.
- U CC **obavezno Nevena i Nenad**.
- Predračun **> 1.000 EUR** → štampa + potpis **Direktora** pre prosleđivanja na plaćanje.
- INO: proveriti da proforma ima IBAN i SWIFT (inače tražiti dopunu).
- Avansni račun sa **SEF-a** → prosleđuje se adm. asistentu da uplatu proknjiži na **avans**, ne na dobavljača.
- Po prijemu SWIFT potvrde (od adm. prodaje) → prosleđuje se dobavljaču da nastavi porudžbinu.
- Kad je isporuka kompletirana → na fakturi se piše "plaćeno".

---

### 2.7 Arhiviranje u Windows folderima (SHARES/Predmeti) — image14, image15, image16
Za veće projekte, van BigBita, čuvaju se specifikacije, porudžbenice i predračuni.
- **image14:** `SHARES > Predmeti > Predmeti_2023 > Kovački centar`; folderi po predmetu: `7348-23, Indukcioni sistem…`, `7351-23, Sistem za manipulaciju…`.
- **image15:** unutar predmeta 7348-23, predračun PDF sa statusom plaćanja u nazivu: "Induction, uplaceno 30% avansa – 27 099,00 – 20.03. ukupan iznos je 90 33…".
- **image16:** predračuni i specifikacije po RN, sa statusom plaćanja u imenu fajla: "ATB Sever – 30% avansa … 70% pred isporuku", "Hydac – 100% avansa uplaceno", "Lola Fot – 60 % avansa …", "Mg Rohr – 100% placeno", "Nalog za nabavku-RN_7350…", "Specifikacija za nabavku-RN_7350_…-rev2".

**Pravilo:** u nazivu predračuna se beleži da li je plaćeno sve ili samo deo. Čuvaju se i specifikacije (ili mail ako specifikacije nema).

---

## 3. Veze ka drugim modulima

| Modul | Veza (kako se ostvaruje u nabavci) |
|---|---|
| **Magacin / zalihe** | Kolona `Zalihe` na stavci porudžbenice; ulaz u magacin po prijemu; `Otpremnica` se povezuje sa fakturom; roba ide "na stanje" ili "na projekat". |
| **Proizvodnja / MRP / Radni nalog** | Nabavka kreće od **specifikacije projektanta**; svaka stavka porudžbenice i zahteva vezuje se za `Radni nalog` i `Predmet` (projekat). "Poreklo zahteva" (MEJL) i `Inicijator` = projektant. Rezervacija po radnom nalogu nakon prijema. |
| **Dobavljači (komitenti)** | Šifarnik komitenata: `Šifra`, `Naziv`, `Mesto`, `PIB`; pretraga po nazivu ili PIB-u; filter `Za komitenta`. Podrazumevani dobavljači za redovnu robu. |
| **Artikli / šifarnici** | Forma `Artikal` (kataloški broj, bar kod, grupa/podgrupa, jed. mere). Pravila šifri: Dobavljač vs **Proizvođač** (Siemens/Konvex/Enel/VITa Elko). `Cenovnik` (STDCN). |
| **Finansije / knjigovodstvo** | Ulazna faktura ⇄ porudžbenica; broj porudžbine na fakturi = uslov za knjiženje; avans/predračun/profaktura; **SEF** (Sistem e-faktura) — preuzimanje bez prihvatanja, prihvatanje po prijemu robe; valuta/kurs; avansni račun na avans; potpis i pregled fakture pre knjiženja. |
| **Predmet (projekat)** | Centralni vezivni entitet — `Broj predmeta`/`Naziv predmeta` povezuje zahtev, porudžbenicu i praćenje sa projektom; `Napravi predmet` iz zahteva; foldersko arhiviranje po predmetu. |
| **Prodaja (adm. prodaje)** | Trgovačka roba → profaktura kupcu; slanje predračuna na plaćanje ide preko adm. prodaje; obaveštavanje kupca o rokovima. |
| **Uvoz i carina** | Zaseban modul (`Prevod računa za carinu` na porudžbenici); špedicije; poseban deo uputstva. |

---

## 4. Statusi i workflow odobravanja

**A) Zahtev ka dobavljaču (RFQ):**
```
(Novi zahtev) → Poslat upit → Prosleđen inicijatoru → Poručen
                                          └────────────→ Odustali
```
Postoji `Tabela statusa` (šifarnik statusa) — statusi su konfigurabilna lista, ne hardkodovani.

**B) Porudžbenica (Naručivanje robe)** — status preko checkbox-ova/flagova, ne jedno "status" polje:
- `Poručeno` (roba poručena)
- `Potpisano`
- Po stavci: `Isp.` + `Isporučena količina` (isporučeno / delimično / neisporučeno)
- `Vezana narudžbina` (parcijalne isporuke → povezane porudžbenice)

**C) Faktura (SEF tok):**
```
Faktura na SEF-u → preuzeta (bez prihvatanja) → [roba fizički stigla] → prihvaćena
→ upisan broj porudžbine → potpis/pregled → knjiženje → "plaćeno"
```

**Ko šta odobrava:**
- **Inicijator (projektant)** — potvrđuje ponudu pre kreiranja porudžbenice (obavezan prilog prihvaćene ponude uz mail).
- **Direktor** — potpisuje predračune > 1.000 EUR pre plaćanja.
- **Nevena i Nenad** — obavezno u CC na mailovima za plaćanje (nadzor/kontrola).
- **Adm. prodaje** — izvršava plaćanje / šalje SWIFT.
- **Adm. asistent** — knjiži avansni račun sa SEF-a na avans.
- Faktura ide na **potpis i pregled** pre knjiženja.

---

## 5. Za ServoSync 4.0 — šta MORA da se prenese

### Entiteti (predlog domena Nabavka)
1. **PurchaseRequest (Zahtev ka dobavljaču / RFQ)** — inicijator (projektant), opis (iz specifikacije), predmet, radni nalog, poreklo (kanal), rok za ponudu (dana + datum), odgovorno lice, napomena, status; veza N:1 ka dobavljaču (opciono na početku) i 1:N ka ponudama.
2. **Quote / Offer (Ponuda dobavljača)** — dobavljač, iznos, valuta, uslovi plaćanja (avans %), rok isporuke, važenje ponude, prilog (PDF obavezan). Prihvaćena ponuda = obavezan prilog.
3. **PurchaseOrder (Porudžbenica / Naručivanje robe)** — dobavljač, broj (auto-dodeljen; poseban brojač za pneumatiku), datum, valuta+kurs, cenovnik, "definisao zahtev", flagovi `Poručeno`/`Potpisano`, opis, napomena, veza na predmet i radni nalog, veza na vezanu (parent) porudžbenicu.
4. **PurchaseOrderLine (stavka)** — artikal (kataloški broj), naziv, jed. mere, količina naručena, cena, vrednost, **isporučena količina**, flag `Isp.`, predmet, napomena.
5. **Article (Artikal / šifarnik)** — kataloški broj, bar kod, naziv, pakovanje, jed. mere (kg/m/kom), kg/kom, grupa/podgrupa, ext. šifra, max rabat, min količina, odloženo plaćanje. Distinkcija **šifra Proizvođača vs Dobavljača**.
6. **Supplier / Partner (Komitent)** — šifra, naziv, mesto, PIB, IBAN, SWIFT (za INO), podrazumevani status "default dobavljač" za grupu robe.
7. **Project / Case (Predmet)** — centralni vezivni entitet ka RN i dokumentima; arhiviranje.
8. **Proforma / AdvancePayment (Profaktura/Predračun + avans)** — iznos, % avansa, dinamika plaćanja, važenje, status plaćanja (deo/sve), prilog, veza na SEF avansni račun.
9. **GoodsReceipt / Incoming (Prijem)** + veza **Otpremnica** i **Ulazna faktura**.
10. **Invoice (Ulazna faktura)** — broj porudžbine (za knjiženje), SEF status (preuzeta/prihvaćena), veza na otpremnicu, flag "plaćeno", rezultat kontrole (poklapanje sa porudžbenicom/otpremnicom).

### Statusi koji MORAJU da se prenesu (konfigurabilne enum-liste, ne hardkod)
- **Zahtev:** Poslat upit → Prosleđen inicijatoru → Poručen / Odustali (zadržati `Tabela statusa` kao editabilan šifarnik).
- **Porudžbenica:** Poručeno, Potpisano, + izvedeni statusi isporuke po stavci (Neisporučeno / Delimično / Isporučeno).
- **Faktura/SEF:** Preuzeta → Prihvaćena → Knjižena → Plaćeno.
- **Plaćanje/avans:** Neplaćeno / Avans deo / Avans 100% / Plaćeno u celosti.

### Poslovna pravila koja se NE smeju izgubiti
1. **Odobravanje ponude od inicijatora** je gate pre porudžbenice; prihvaćena ponuda mora imati **prilog** (uslov, ne samo referenca).
2. **Prag odobravanja Direktora za > 1.000 EUR** na predračunima.
3. **Obavezni watcheri (CC) na plaćanjima** (Nevena, Nenad) — modelirati kao notifikacije/aproovers, ne kao ad-hoc mail.
4. **Avansni tok:** avans se knjiži na avans, ne na dobavljača; SWIFT potvrda se prosleđuje dobavljaču kao trigger za nastavak isporuke; za INO obavezni IBAN/SWIFT na proformi (validacija).
5. **Trostruko poklapanje (3-way match):** Porudžbenica ⇄ Ulazna faktura ⇄ Otpremnica (količina i cena) pre knjiženja; odstupanje → reklamacija. Broj porudžbenice na fakturi = preduslov knjiženja.
6. **Parcijalne isporuke:** povezane (parent/child) porudžbenice; naručena vs isporučena količina po stavci; ne dozvoliti dvostruko knjiženje (legacy to rešava brisanjem prepisanih stavki ili nulom u isporučenoj — u 4.0 rešiti čisto preko "isporučene količine").
7. **Šifra Proizvođača vs Dobavljača** — pravilo po dobavljaču/proizvođaču (Siemens uvek pod Siemens šifrom; Konvex sa ponude; VITa Elko/Enel → proizvođač). Modelirati mapiranje artikal ↔ (proizvođačka šifra, dobavljačke šifre).
8. **Auto-numeracija porudžbina** sa posebnim brojačem za pneumatiku (hronološki).
9. **Roba na projekat vs na stanje** — obavezan izbor po prijemu (naročito elektro materijal/komponente).
10. **Trgovačka roba (dalja prodaja)** vs materijal za projekat — različit tok (profaktura kupca, fakturisanje) i različiti watcheri (kupac umesto inicijatora).
11. **Ne prihvatati fakturu pre fizičkog prijema robe** (SEF: preuzimanje ≠ prihvatanje).
12. **Cenovnik (STDCN):** cene se povlače iz cenovnika; artikli van cenovnika ostaju nepromenjeni — modelirati price list sa fallback pravilom.
13. **Rokovi isporuke i praćenje:** očekivani datum isporuke po stavci; automatski flag/alert za neisporučeno posle roka → notifikacija inicijatoru/kupcu (zameniti ručni "Pregled narudžbina").

### Šta u 4.0 treba UNAPREDITI (legacy slabosti primećene u uputstvu)
- Status porudžbenice je razbijen na checkbox-ove (`Poručeno`/`Potpisano`/`Isp.`) — u 4.0 uvesti pravi statusni workflow (state machine).
- Kritične odluke (avans, potpis Direktora, CC watcheri, statusi plaćanja) danas žive u **mailu i nazivima fajlova** (Windows folderi SHARES/Predmeti) — u 4.0 sve to su strukturirana polja i prilozi na entitetima + integracija sa SEF-om.
- Reklamacije se danas vode neformalno (mail/viber/skype) — uvesti entitet Reklamacija/odstupanje vezan za prijem.
```

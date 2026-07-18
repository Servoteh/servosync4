# Analiza dokumenta: "Uputstvo za korišćenje BigBit-a (sve zajedno)"

> Izvor: `Uputstvo za korišćenje BigBit-a (sve zajedno).docx`
> BigBit = legacy MS Access ERP (Servoteh d.o.o. Dobanovci). Naslovna traka forme: **"SERVOTEH 2019/2024 – Software by Slaviša Djuric – tel: 011/2271-850, 065/224-1630"**, verzija **Rev 9.6.1 (05.02.2015.)**. Baza je `.MDB` fajl na serveru (`P:\Servoteh\BigBit24\STH24\BB_T_24.MDB`), radi po poslovnoj godini (2019, 2024...).
> Ovo je operativno uputstvo za knjigovodstvo/komercijalu, ne tehnička specifikacija — opisuje "klik po klik" tokove rada. Analiza je ulaz za migraciju BigBit-a u ServoSync 4.0.

---

## 1. Sadržaj / struktura dokumenta

Dokument ima automatski sadržaj (TOC) sa 20 glavnih poglavlja i pod-tačkama. Redosled tema (prati godišnji/mesečni knjigovodstveni ciklus):

1. **Otvaranje nove poslovne godine** — prenos otvorenih stavki/konta
2. **Unos komitenta** (provera na APR-u pre unosa)
3. **Blagajna** (gotovinski troškovi)
4. **Knjiženje izvoda**
5. **Knjiženje izvoda (EXPORT .txt dokumenta iz e-bankinga)**
6. **Pravljenje AVR (avansnih računa)**
7. **Unošenje novih komitenata** (upućuje na tačku 2)
8. **Otvaranje ARTIKALA**
9. **Pravljenje ponude** — a) kad kupac prihvati ponudu, b) poručivanje robe
10. **Fakturisanje robe IFR** — a) slanje preko SEF-a, b) direktan unos na SEF, c) kad postoji avans, d) kupac nije na SEF-u, e) BMTS bez PDV-a, f) finansijsko knjiženje IFR
11. **Fakturisanje usluga IFUSL** — a) finansijsko knjiženje usluga
12. **Fakturisanje gotovog proizvoda IFGP** — a) finansijsko knjiženje IFGP
13. **Knjiženje ulaznih faktura (TROŠ, BPDV, UFROB, UFMAT)** — a) UFROB/UFMAT robno, b) rezervisanje robe, c) UFROB/UFMAT finansijski, d) TROS, e) BPDV
14. **Ulazne fakture – skidanje avansa**
15. **Otvaranje PREDMETA i RN (radnog naloga)**
16. **Uvoz – robno i finansijski** — a) ulaz robe u magacin, b) finansijsko knjiženje uvoza, c) dalja prodaja
17. **Kartice analitike** (+ salda analitike, bruto bilans)
18. **Slaganje robnog i finansijskog – provera**
19. **Pripreme za PDV** (8 koraka: brisanje naloga, provere izlaznih/ulaznih naloga, USLRO, TREB/TREB1, ULGP, slaganje SEF↔BigBit)
20. **Provera PDV obaveza u BigBit-u**

Napomena iz uputstva: navigacija kroz TOC je `Ctrl + levi klik`.

---

## 2. Poslovni procesi i ekrani/forme

### GLAVNI MENI (screenshotovi: image2 = 2019, image16/image23 = 2024)

Ceo BigBit je jedna Access aplikacija sa "switchboard" glavnim menijem organizovanim u kolone/grupe. Verzija 2024 (kompletnija) sadrži grupe:

- **RAZNO:** Korisnici, Poreske stope, Grupe i porekla, Vrste dokumenata, Vrste naloga, Šeme za kontiranje, Cenovnik, KEPU Veleprodaja, Knjiga PK1, KEPU Maloprodaja, Poslovi, Radni nalozi, Magacini, Kursna lista
- **KOMITENTI:** Unos, Pregled, Vrste komitenata, Važni datumi, Unos plaćanja, Pregled plaćanja, Priprema plaćanja, *Stare PDV knjige* (PDV Ulazne fakture, PDV Izlazne fakture)
- **USLUGE:** Fakturisanje, Pregled faktura, Pregled e-Faktura
- **ARTIKLI:** Unos, Pregled, Lager lista, Kartice, Kartice profakture, Kartice porudžbine, Nabavka, Komisioni lager, Komisione kartice, Komision-Zad/Odj, Ulaz/Izlaz po artiklima, Recepti za proizvodnju, Popis, Nalepnice
- **MAGACIN:** Ulaz, Izlaz, Knjiga Ulaza/Izlaza, Knjiga e-Faktura, Nabavka (e-Fakture), Zbirovi po dok., Profakture, Pregled profakture, Nivelacija zaliha, Obračun radnih naloga, Spec. radnih naloga, Naručivanje robe, Pregled narudžbina, Nar. robe (Prevod), Zahtev ka dobavljaču
- **GLAVNA KNJIGA:** Kontni plan, Unos naloga, Unos blagajne, Pregled naloga, Dnevnik, Bruto stanje, Kartica konta, Kartica analitike, Salda analitike, Otvorene stavke, Komitent po kontima, Unakrsni izveštaji, Salda po poslovima, Kartoteke-štampa, Prodavci-obračun
- **IZLAZ IZ MAGACINA:** Po artiklima, VP Analiza, po Kupcima, Odjava dobavljaču, VP Planiranje zaliha
- **REVERSI:** Unos reversa, Pregled reversa
- **PDV obrazac:** Unos naloga GK, POPDV
- **IZVEŠTAJI/SERVIS:** Unos izveštaja, Pregled izveštaja, GK izveštaj, Analiza prodaje
- **PREDMETI:** Unos predmeta, Pregled predmeta, Kartica predmeta, Zahtevi za ponude od kupaca

Zaglavlje menija: korisnik (nevenak/jovanap), naziv firme, putanja do MDB baze, **Godina**, OJ/OD (organizaciona jedinica). Dugme **Kraj rada**.

---

### PROCES 1 — Otvaranje nove poslovne godine
- **Svrha:** početkom godine preneti sve otvorene (nezatvorene) stavke iz prethodne godine.
- **Šta se prenosi:**
  - Sve iz PROFAKTURA (PON, PROF, OTP, REZR, REZM…)
  - Sve iz USLUGA (PON, IFUSL, AVR…)
  - Sve iz Narudžbina
  - Sve iz PREDMETI
  - KUPCI – analitika konta 2040, 2050
  - Dobavljači – analitika 4350, 4360+
  - Avansi – 4300, 4302, 1500, 1520, 1521, 1530 (analitika)
  - Sve rađeno od početka godine

### PROCES 2/7 — Unos komitenta (Komitenti → Unos)
- **Svrha:** unos novog kupca/dobavljača.
- **Pre unosa:** provera tačnog SKRAĆENOG naziva na sajtu **APR** (pretraga po matičnom broju); ako je korisnik budžetskih sredstava, proveriti **JBKJS** na `kjs.trezor.gov.rs`.
- **Obavezna polja:** tačan naziv (sa APR-a), adresa, PIB, matični broj, JBKJS (ako je budžetski korisnik), tekući račun, telefon, kontakt osoba.
- **Poslovno pravilo:** BigBit prepoznaje komitente **po PIB-u** — nije moguće otvoriti dva komitenta sa istim PIB-om.

### PROCES 3 — Blagajna (Glavna knjiga → Unos blagajne)
- **Svrha:** knjiženje gotovinskih troškova iz podignute gotovine.
- **Forma/koraci:** Novi dokument, vrsta **BLAG**, datum (podizanje gotovine), obavezan broj temeljnice za **svaku** stavku.
  - Konto **2419** = ceo iznos blagajne kao **ULAZ**.
  - Svi troškovi kao **IZLAZ** (broj temeljnice, br. dokumenta, u opisu naziv dobavljača).
- **Kontni plan troškova blagajne:** 5130 gorivo · 5133 ostala goriva (argon, tehnogas) · 5120 kancelarijski materijal · 5125 održavanje nekretnina · 5322 održavanje vozila · 5399 parking · 5121 higijena · 5313 taxi · 5510 reprezentacija · 5310 PTT · 5314 PTT pisma · 5391 putarina · 5127 sitan inventar.
- **Kada saldo = 0:** štampa se ceo nalog (isplatiti/naplatiti), pa u Glavnoj knjizi dodaje red **2430** (iznos i duguje i potražuje), sve ide u registrator "Blagajna".
- **Pravila:** svaki račun se unosi **pojedinačno** (bez sabiranja); kontrola — zbir isplata/naplata = uneti iznos blagajne.
- **Od jula 2019.:** za svaki trošak dodatna stavka PDV-a: **2704** za 20% (isti iznos i na duguje i na potražuje), **2714** za 10%. Račun bez PDV-a → konto troška sa dodatnom nulom (petocifreni konto). Putarina i boravišna taksa bez dodatne evidencije.

### PROCES 4/5 — Knjiženje izvoda (Glavna knjiga → Unos naloga → Uvoz izvoda)
- **Screenshotovi:** image3 (forma "Nalog glavne knjige", vrsta **IZVOD**, dugmad: Novi nalog, Knjiženje iz robnog po šemi, Knjiži iz usluga po šemi, Devizni nalog, Sintetički nalog, **Uvoz izvoda**), image5 (dugmad: **e-Banking uvezi podatke**, Obriši uvezene podatke, **Proknjiži u nalog GK**), image4 (uparivanje komitenta po tekućem računu).
- **Svrha:** automatsko knjiženje bankovnog izvoda iz e-banking `.txt` fajla.
- **Koraci:** iz e-banking aplikacije sinhronizacija → izvoz izvoda (`.txt`) u folder IZVODI na serveru → BigBit: Glavna knjiga → Unos naloga → Novi nalog → vrsta IZVOD, datum, broj izvoda → **Uvoz izvoda** (pored STOP) → uvoz podataka iz fajla (dvoklik na plavo polje, izbor `.txt`, "e-banking uvezi podatke").
- **Automatika:** BigBit priliv/odliv raspoređuje na **2040** (kupci) i **4350** (dobavljači). Ručno se menja konto gde nisu kupci/dobavljači (npr. naknada za bezgotovinsko plaćanje → **5530**).
- **Uparivanje:** ako broj računa nije isti u izvodu i BB, ručno se bira komitent; dvoklik na prazno polje dodaje novi tekući račun i čuva ga na komitentu (image4: prikaz Tr1/Tr2/Tr3 računa i "Uvezeni komitent i tekući račun").
- **Završetak:** "Proknjiži u glavnu knjigu".
- **Poseban slučaj — plaćanje karticom (slip):** konto **4390** (na duguje već sa izvoda, na potražuje isti iznos sa slipa) → **2700** ako se koristi PDV (ili **2704** i duguje i potražuje ako se ne koristi) → konto troška (npr. 5130). Datum ostaje datum izvoda.

### PROCES 6 — Pravljenje AVR (avansni račun) (Usluge → Fakturisanje)
- **Svrha:** po uplati avansa od kupca izdati avansni račun (isti dan, najkasnije 3 dana — zakonski rok) na uplaćeni iznos.
- **Koraci:** Usluge → Pregled faktura (naći poslednji broj AVR, dodeliti sledeći) → Fakturisanje → Novi dokument → datum knjiženja = datum sa izvoda (kad je legao avans) → vrsta **AVR** → broj → Opis ("Uplata avansa po osnovu Ponude…, za … uslugu…, cena sa PDV") → Tekst na dokumentu = AVR.
- **Distribucija:** 1 primerak sebi (uz izvod), kupcu preko **SEF-a**; u opis se stavlja "E" kao oznaka da je poslato preko SEF-a.
- **Knjiženje avansa (kroz izvod):**
  | Duguje | Potražuje | Opis |
  |---|---|---|
  | 4300 (ceo iznos) | — | br. AVR |
  | — | 4720 (PDV) | br. AVR |

### PROCES 8 — Otvaranje artikala (Artikli → Unos)
- **Koraci:** Novi artikal → Kataloški broj (od dobavljača ili sledeći slobodan broj koji BB ponudi ispod polja "slika artikla") → Naziv → **Grupa artikla** (gotov proizvod, hidraulika, pneumatika, razno…) → snimanje (klik levo).

### PROCES 9 — Pravljenje ponude (Magacin → Profakture)
- **Svrha:** izrada ponude kad na mail stigne zahtev za ponudu.
- **Forma/koraci:** Novi dokument → naziv kupca → vrsta **PON** → broj (dugme `?` → BB dodeljuje) → Plaćanje u roku (stalni kupci imaju valutu; novi = 100% avans) → Način otpreme (lično/AKS) → **FCO** (magacin prodavca ako ponuda < 5000 din; magacin kupca ako > 5000 din) → snimanje → Nova stavka (artikli) → **Kurs** (ako su cene u EUR, obično 125) → Tekst na reportu "ponuda" → desni klik na štampač → "profaktura" → Ctrl+P (čuvanje na serveru u folderu kupca).
- **Nakon slanja:** Predmeti → **Zahtevi za ponude od kupaca** → Novi zahtev (Komitent, Opis, Poreklo zahteva, Status, Profaktura, Prodavac).
  - **image6 — forma "Zahtevi za ponudu od kupaca":** filteri (Za komitenta, Za odgovorno lice, Za status), dugmad **Novi zahtev, Napravi predmet, Predmet, Profakture, Prikaži sve, Tabela statusa, Unos komitenta, Usluge, Primeni uslove, STOP**. Tabela: Komitent, Datum, Opis, Rok za završetak (dana/datum), Predmet, Poreklo zahteva (Mail…), Status ("Poslata ponuda ku…"), Profaktura (npr. 0661-24).

#### 9a — Kad kupac prihvati ponudu
- Na postojećem zahtevu za ponudu → dugme **Napravi predmet** → BB automatski otvara predmet (dopuniti Rok završetka, broj porudžbenice…).

#### 9b — Poručivanje robe (Magacin → Naručivanje robe / Pregled porudžbina)
- **image7 — forma "Novo naručivanje" (porudžbenica, ID 18286):** Dobavljač (Šifra, Naziv "Aventics GmbH", Mesto Laatzen, PIB), Datum naručivanja, **Broj narudžbine (PO34-24)**, Valuta, Kurs, Definisao zahtev, čekboksovi Poručeno/Potpisano/Avans, Vrsta dokumenta **NARUČIVANJE**, Cenovnik **STDCN**, dugmad **Upiši stavke iz profakture, Upiši artikle po uslovu, Obriši stavke, Upiši artikle dobavljača, Narudžbina bez cena, Narudžb. sa cenama ENGLESKI, Upiši cene iz cenovnika**. Tabela stavki: Kataloški broj, Naziv artikla, Jed. mere, Zalihe, Količina za nar., Cena, Vrednost narudžbine, Isporučena količina, **Predmet**, Napomena.
- **Koraci:** filter Za dobavljača → Po dokumentima → BB izlista naloge za poručivanje → izabrati otvoreni nalog → "Detaljno porudžbina" → **Upiši stavke iz profakture** (uneti broj ponude) → Upiši (BB prepiše artikle) → u napomenu upisati broj porudžbenice kupca.
- **Pravilo:** Robert Bosch ima posebnu porudžbenicu za Aventics (popust); ostali kupci idu u zajedničku porudžbenicu.

### PROCES 10 — Fakturisanje robe IFR (Magacin → Izlaz)
- **image9 — forma "Izlaz" (ID 35386):** Kupac/Prodavnica (Šifra 11813, Naziv "Tetra Pak Production", Mesto, K.osob), dugmad **Novi dokument, Pronađi dokument, Utovar, Brzi unos, FR, štampač, STOP**. Zaglavlje: Datum knjiženja, **Vrsta dok. IFR**, Broj dokumenta (540/24), Datum dok., Plaćanje u roku (60), Dat. valute, Radni nalog, Mesto, Dat. prometa, Način otpreme (aks express), Način plaćanja (virmanom), Opis dokumenta, Prodavac, **Broj naloga (240808)**, Vrsta naloga IFR, **Izlaz iz magacina** (Magacin robe), Pros. cene.
- **image15/image8 — red stavke (Izlaz):** Magacin (Magacin robe), PC, BSM, Zalihe, Kat. broj, Artikal, Tr.Pak, Kutija, Količina, **Fakturna c.**, R.% (rabat), exR% (ekstra rabat), **Prod. VP cena**, **PP Proiz** (proizvod – čekboks za 0% npr. BMTS), PP Usluga, **MP cena** (prodajna sa PDV-om), Odl.pl, **Nab. cena**, **Mag. VP cena**, KNG cena, Uk. zalihe, Rez. kol, Slobodno, Predmet, dugme **Nova stavka**. Desno sumarno: Mag. vred, Rabat, Ekstra rabat, VP vrednost, PDV, Sa PDV.
- **Koraci:** Novi dokument → naziv kupca → vrsta **IFR** → broj (prvi slobodan iz "crvene sveske" = Knjiga izlaznih faktura) → Plaćanje u roku → Način otpreme (AKS/lično) → Način plaćanja (virman) → Izlaz iz magacina robe → **FCO** (ispod/iznad 5000 din) → u žuto polje broj porudžbenice kupca (PO) → Nova stavka (artikal po kat. broju/nazivu, količina, fakturna cena, rabat).
- **Ključno pravilo:** polje **Mag. VP cena mora biti jednako Nab. cena** (ako nije, ručno upisati nabavnu cenu) — inače nastaje RuC (razlika u ceni) i neslaganje robno↔finansijski.
- **Štampa:** desni klik na štampač → "Faktura" (ili "Faktura sa neto cenama" ako ima rabat) + **2 otpremnice** ("Otpremnica bez cena", overe se i idu uz robu).

#### 10a–d — SEF (e-Faktura) tokovi
- **image10/image21 — forma "Export faktura / e-Faktura" u BigBit-u:** zaglavlje Godina, IDF, IDDok, IDProd, IDKasa; blok Kupac (PIB, JBKJS); Datum, Vrsta dok., Broj dokumenta, Broj ugovora, **Broj narudžbenice**; Prilozi uz export (Faktura-Roba, do 3 fajla, max 25MB, putanja PDF `\\SRV\SHARES\EXPORT\...`); **Poreski period fakture** (datum izdavanja / datum prometa / datum plaćanja); Prikaz popusta (po stavci / po artiklu); XML fajl; dugmad **Kreiraj e-Fakturu (XML za import u SEF)**, **Exportuj u SEF**, CRF; blok status (Proveri status, Status dokumenta, promena statusa u SEF-u UTC, Sales ID, Purchase ID); dugmad **Storniraj u SEF-u, Otkaži u SEF-u**, čekboks "Po završetku exporta obriši kreirani PDF".
- **10a (standard):** slanje **sledećeg dana** nakon IFR-a. Magacin → Izlaz → Pronađi dokument (broj iz crvene sveske) → tab **E-faktura** → uneti Broj narudžbenice ako postoji → **Exportuj u SEF**. Važi ako nije bilo avansa i kupac je na SEF-u.
- **10b (ručni unos na SEF):** kad se ne može exportovati iz BB → sajt `efaktura.mfin.gov.rs/login` (sertifikat/kartica) → Napravi novi dokument → naziv kupca, broj dokumenta (isti kao u BB), broj narudžbenice, **datum prometa** (sa fakture), **datum dospeća** (rok plaćanja), **Nastanak PDV obaveze = datum prometa** → stavke (Šifra, Naziv, Količina, JM, Cena, Iznos umanjenja/rabat, Iznos bez PDV, PDV %, PDV kategorija) → provera da je iznos isti kao u BB → **Pošalji dokument**.
  - **image11 — SEF dashboard:** kartice Izlazni dokumenti (Kreiraj novi dokument / Učitaj datoteku), Ulazni dokumenti, Nacrti, Evidencija PDV, Pojedinačna evidencija PDV, Zbirna evidencija PDV, Prekogranični promet, Podešavanja; leva navigacija Komandna tabla, Prodaja, Nabavke.
  - **image12/image13/image14/image23 — SEF "Izlazni dokument / Nacrt":** Lista valuta, Tip dokumenta (Faktura), Broj dokumenta, Broj ugovora, Broj Narudžbenice/Fakture/Ponude, Broj okvirnog sporazuma, sekcija Otpremnica (šifra objekta, interni broj za rutiranje), Osnov za oslobođenje/izuzeće od PDV-a, **Datum prometa, Datum dospeća, Nastanak PDV obaveze**, Poziv na broj; PRODAVAC / KUPAC; stavke (Redni broj, Šifra, Naziv, Količina, JM, Cena, Iznos umanjenja, Iznos bez PDV, PDV %, **PDV kategorija (S20/Z)**, identifikator klasifikacije), Avansna faktura; sumarno (Zbir stavki po stopi 20%, Ukupna osnovica, Ukupan PDV, umanjenje po avansu, **Iznos za plaćanje**); dugmad Pošalji dokument, Obriši, Odbaci promene, Ažuriraj nacrt, Storniranje, Preuzmi PDF/XML/potpis.
- **10c (avansna uplata):** konačnu fakturu **ručno** na SEF → sve prepisati iz BB fakture + polje **Avansni račun** (broj AVR iz BB), Osnovica **S20** → provera "ukupno za plaćanje = 0" (mora biti nula kad je vezan avans) → Pošalji.
- **10d (kupac nije na SEF-u):** faktura se štampa/šalje poštom, ali se **mora prikazati na SEF-u** kroz **Pojedinačna evidencija PDV** → "Dodaj novu pojedinačnu evidenciju" (ručno: broj = broj fakture, godina, poreski period mesečni, promet=isporuka, PIB kupca kao identifikator, tip=faktura, datum naplate=valuta, datum evidentiranja=datum fakture, opis po stopi 20%, osnovica, obračunati PDV, ukupan iznos) → snimi → status "sačuvano" → **evidentiraj** (obavezno da bi proces bio kompletan).

#### 10e — Fakturisanje BMTS-a (bez PDV-a)
- BMTS oslobođen PDV-a po **čl. 24 st. 1 tač. 5 Zakona o PDV-u** → stopa **0%**. Pri unosu stavke u polju "Proizvod" (PP Proiz) izabrati nulu. Na SEF-u: PDV kategorija **Z**, šifra osnova **24-1-5**.

#### 10f — Finansijsko knjiženje IFR (Glavna knjiga → Unos naloga → Knjiženje iz robnog po šemi)
- **image22 — forma "Neproknjižene stavke u GK":** filteri Od/Do datuma, Vrsta dokumenta (IFGP…), čekboksovi "Samo zaključana dok.", "Otvori zaglavlja naloga", "Obriši i zaglavlja naloga (ako nemaju knjiženja)"; dugmad **Neotvoreni nalozi u Glavnoj knjizi, Primeni uslove (Shift+F9), Detaljno dokument, Šeme za kontiranje, Proknjiži iz robnog, Obriši**.
- **Koraci:** Knjiženje iz robnog po šemi → Od/Do datuma → vrsta **IFR** → Primeni uslove → **Proknjiži iz robnog** → Yes/Yes. Rezultat na kontu **2040** (potraživanja od kupaca). Provera: Pregled naloga → nalog IFR.

### PROCES 11 — Fakturisanje usluga IFUSL (Usluge → Fakturisanje)
- **image17 — forma "Fakturisanje" (usluge, dok. 533/24):** Kupac (Šifra 1003372, "Mikrometal smr", PIB), Datum knjiženja, **Vrsta dok. IFUSL**, Broj dok., Plaćanje u roku, Valuta, **Radni nalog**, Broj naloga (240802), Vrsta naloga IFUSL, Prodavac (Jovana Pantelić), Predmet; žuto polje **Napomena o poreskom oslobođenju** ("NEMA. Reklamacije primamo u roku od 5 dana. Za sve sporove nadležan je Trgovinski sud u Beogradu. U slučaju prekoračenja roka obračunavamo zakonom propisanu zateznu kamatu."). Red stavke: Grupa, **Opis** ("Usluga erodiranja otvora na osovini osmice"), Količina, JM (kom), Cena, PDV %, Cena sa PDV, Vred. bez PDV, Rab.%. Desno: blok **Avansni računi** + dugmad **Veza sa fakturom iz usluga, Faktura (veza sa avansima iz usluga), Definiši brojeve prateće dokumentacije, Definiši putanje dokumenata, Raskini vezu, Faktura sa avansima**; polje **Zapisnik** (Tekst na zapisniku = "Zapisnik", tekst "Ovim zapisnikom konstatujemo da je firma Servoteh d.o.o. izvršila uslugu: 1. …") — **zapisnik ide umesto otpremnice**. Sumarno: Vrednost bez poreza, Rabat, Vrednost bez PDV (osnovica), PDV, Vrednost sa porezom.
- **Koraci:** Novi dokument → naziv kupca → vrsta **IFUSL** → broj (crvena sveska) → Plaćanje u roku → **Radni nalog** (broj RN pod kojim se vodi servis) → Prodavac → snimi → Nova stavka (opis usluge, količina, JM, cena) → desno uneti Zapisnik.
- **Štampa:** faktura + zapisnik u 2 primerka, oba pečatirana/potpisana.

#### 11a — Finansijsko knjiženje IFUSL (ručno! Glavna knjiga → Unos naloga)
- **image18** — zaglavlje: Vrsta naloga **IFUSL**, Broj naloga 0063, Datum knjiženja = datum sa IFUSL fakture.
- **image19 — 3 stavke naloga:**
  | Konto | Strana | Iznos |
  |---|---|---|
  | 2040 | Duguje | ceo iznos (npr. 240.000) |
  | 4703 | Potražuje | iznos PDV-a (40.000) |
  | 6140 | Potražuje | osnovica (200.000) |
  - (naziv dobavljača/kupca + broj IFUSL fakture na svakoj stavci)

### PROCES 12 — Fakturisanje gotovog proizvoda IFGP (Magacin → Izlaz)
- **Preduslovi:** nalog za GP daju Miljan/Zoran/proizvodnja/projektanti (broj predmeta ili RN). Proveriti da postoji artikal (ako ne — otvoriti novi).
- **Korak A — provera REZM:** Magacin → Pregled profaktura → Za predmet = broj RN → proveriti da postoji REZM (npr. 7971M) → ostaviti otvoren tab Profakture.
- **Korak B — Trebovanje (Magacin → Izlaz):** Novi dokument → naziv komitenta → datum → vrsta **TREB** (trebovanje materijala; **TREB1** = trebovanje robe) → broj (BB dodeljuje) → desno broj predmeta → Opis = broj predmeta → Nova stavka (ručno artikli iz profakture, umanjiti količinu na profakturi za iskorišćeno).
  - **PRAVILO:** iznos trebovanja mora biti **50% vrednosti gotovog proizvoda** (GP 5.000.000 → trebovanje 2.500.000).
- **Korak C — ULGP (Magacin → Ulaz):** Novi dokument → naziv komitenta → isti datum → vrsta **ULGP** → broj → Opis = broj predmeta → **Magacin gotovih proizvoda** → Nova stavka (artikal, količina, cena = cena sa trebovanja).
- **Korak D — IFGP (Magacin → Izlaz):** Novi dokument → naziv komitenta → isti datum → vrsta **IFGP** → broj (crvena sveska) → Plaćanje u roku → Opis = broj predmeta → Način otpreme → Magacin gotovih proizvoda → Napomena (npr. broj/datum ugovora, avans) → Nova stavka (artikal, količina, fakturna cena) → štampa "Faktura sa neto cenama" + 2 otpremnice.
- **Veza sa avansom:** desno uneti broj AVR, "ukupno avansni račun" (ceo iznos AVR + PDV), "sada se koristi" (iznos za ovaj IFGP) → dugme **Faktura – veza sa avansima** → prikaz konačnog računa.
- **SEF:** IFGP se šalje direktno iz BB, ali se prvo **obriše postojeća faktura pa unese konačni račun** (prethodno sačuvan). (image21 — anotacije "brišemo fakturu" / "unosimo konačni račun").

#### 12a — Finansijsko knjiženje IFGP (automatski, Knjiženje iz robnog po šemi)
- Glavna knjiga → Unos naloga → Novi nalog → Knjiženje iz robnog po šemi → Od/Do datuma → Vrsta dokumenta IFGP → Yes/Yes → štampa naloga (Pregled naloga → Detaljno nalog → štampač).

### PROCES 13 — Knjiženje ulaznih faktura (TROŠ, BPDV, UFROB, UFMAT)
- **Priprema (služba nabavke):** sve fakture (sa SEF-a, mailom ili poštom) prolaze kroz nabavku — provera da je poručeno/isporučeno/izvršeno, potpisana otpremnica/zapisnik. Na fakture za projekat upisuje se broj **RN**; za UFMAT/UFROB/UVOZ i broj **RN + PO**. Potpis/pečat: Nenad ili Nevena.
- **Razvrstavanje faktura:**
  - **TROŠ** — usluge, alati, sitan inventar
  - **BPDV** — fakture bez iskazanog PDV-a ili sa troškom reprezentacije (PDV se ne koristi)
  - **UFMAT** — nabavka materijala za proizvodnju/obradu
  - **UFROB** — sva roba koja se poručuje

#### 13a — UFROB/UFMAT robno (Magacin → Ulaz)
- **image24 — forma "Ulaz":** dugmad **Novi dokument, Pronađi dokument, Upiši izmene u artikle, Trebovanje za proizvodnju, Uvoz, čekić (knjiženje), štampač, STOP, Napravi izlaz**. Zaglavlje: Dobavljač (Šifra/Naziv/Mesto/PIB), Datum knjiženja, Vrsta dok. (UFROB/UFMAT), Broj dokumenta, Datum dok., Plaćanje u roku, Valuta, Radni nalog, Opis dok., Broj naloga (240902), Vrsta naloga, Magacin, Obr. kurs, Car. kurs, Pov. car. osn, Oporezivi ZT, Neoporeziv ZT, Devizna vred, **PNB odobrenja** (poziv na broj), Planske cene, Prod. cene, Predmet, Kurs-PRN, **Veza sa izlaznim dokumentom / Raskini vezu**. Tabela stavki: Kat. broj, Naziv artikla, Jed. mere, Količina, Nabavna neto cena, Pret. porez, VP Cena, Obr. PDV, MP cena, Bruto nab. cena, Bruto nab. vrednost.
- **Koraci:** Novi dokument → naziv dobavljača → datum knjiženja = datum fakture → vrsta UFROB/UFMAT → broj dokumenta = broj fakture → Plaćanje u roku = datum valute → Magacin (BB automatski po vrsti) → PNB odobrenje → snimi → **čekić → desni klik → "proknjiži stavke iz porudžbenice"** (PO upisan rukom na fakturi).
- **Izuzetak (Nenad daje fakturu bez PO):** unos stavku-po-stavku (kat. broj, količina, fakturna cena po komadu, **razlika u ceni = 0**). U Opis dokumenta obavezno broj RN. Provera da se vidi broj Predmeta.
- **Provere:** iznosi iz PO moraju se slagati sa fakturom dobavljača. Ako dobavljač nije PDV obveznik → Preneti porez tarifa 0, PP proizvoda tarifa 0, RuC 0.

#### 13b — Rezervisanje robe UFMAT/UFROB (Magacin → Pregled profaktura / Profakture)
- **image26 — "Pregled profakture" lista:** filteri Za predmet (6938), Za vrstu dok., Za komitenta, Za prodavca, Za magacin, Za radni nalog, Za pred. st. Kolone: P, R, Datum dokumenta, Vrsta dok. (**REZR/REZM**), Naziv kupca/dobavljača (Jugoimport SDPR), **Broj dokumenta (6938R / 6938M / 6938Dule)**, Kupac, Valuta, Veza sa izlaznom fakturom za robu, Broj fin. naloga, Vrsta naloga.
- **image27/image30 — forma "Profakture" (rezervacija, ID 25455):** dugmad **Novi dokument, Prepiši iz ulaza po predmetu, Prepiši profakturu, Nalog magacinu, Vezana profaktura, Dokument bez cena, Lager lista, Stanje u valuti, štampač, STOP**; Tekst na reportu "Profaktura", Tekući račun. Zaglavlje: Kupac (Šifra 11688, Jugoimport SDPR), Datum knjiženja, **Vrsta dok. REZR**, Broj dok. (6938R), Datum dok., Plaćanje u roku, Valuta, **Radni nalog (6938)**, Mesto, Datum prometa, Način otpreme, Uslovi plaćanja (45 dana odloženo), Fco, Opis dokumenta ("Linija tip ST-TO-400"), Broj naloga, Vrsta naloga REZR, Prodavac, **Izlaz iz magacina (Magacin robe)**, Pros. cene, **Predmet (6938)**, Uzmi cene iz cenovnika (STDCN), **čekboks "Rezerviši količine"**, Kurs, Dev. valuta (DIN).
- **image29 — stavke rezervacije:** artikli (Klingerit zaptivač, Brusilica…), Magacin robe, Zalihe 450, VP vrednost, Sa porezom, dugmad Kartica artikla, Cenovnik, Nova stavka.
- **image28 — dijalog "Proknjiži stavke iz ulaznog dokumenta":** "za predmet" (6938), "Za ulaze od datuma dokumenta" (01-10-17), dugme **Proknjiži**, STOP.
- **Koraci:** Pregled profaktura → Za predmet = broj → Primeni uslove (izlistaju REZR, REZM, brojRN+Dule) → izabrati REZR (roba, npr. 6938R) ili REZM (materijal, npr. 6938M) → Detaljno dokument → **Prepiši iz ulaza po predmetu** (broj RN) → **Proknjiži stavke iz ulaznog dokumenta**. Provera: ukupan VP iznos / poslednja stavka.
- **Ako ne postoji rezervacija:** Magacin → Profakture → Novi dokument → naziv komitenta → vrsta REZR/REZM → Izlaz iz magacina robe (UFROB) ili Magacin repro (UFMAT) → broj = RN+R/M → Radni nalog i predmet = RN → obavezno čekirati **Rezerviši količine**.
  - *Napomena:* `6938Dule` = ono što magacin stavlja na rezervaciju za robu uzetu sa stanja magacina.

#### 13c — UFROB/UFMAT finansijski (automatski)
- Glavna knjiga → Unos naloga → Novi nalog → Knjiženje iz robnog po šemi → Od/Do datuma → vrsta UFROB/UFMAT → Yes/Yes → štampa (Pregled naloga → Detaljno nalog).

#### 13d — TROS (trošak, ručno; Glavna knjiga → Unos naloga)
- **Jedan nalog mesečno** (npr. 000008 = avgust); broj naloga = broj meseca; datum knjiženja/naloga = poslednji dan meseca.
- **image31** — meni Glavna knjiga → Pregled naloga; **image32 — lista "Pregled naloga":** dugmad Detaljno nalog, Prikaži sve, Saldo <> 0, štampač, STOP; filter Za vrstu naloga **TROS**; kolone Z, Broj naloga (000009/000008), Vrsta naloga, Datum naloga, Datum knjiženja, Duguje, Potražuje, Saldo.
- **image33 — TROS nalog, red stavke:** Konto **4350** ("DOBAVLJAČI U ZEMLJI"), Šifra 1000865 "Lukoil Srbija", **Posao** (elektronsk = sa SEF-a / fiskalni), Broj dokumenta, Poziv na broj/odobrenje, Datum, Dat. valute, Opis stavke, Valuta, Kurs, Dev. Duguje/Potražuje, Duguje, Potražuje. Vidljiva konta 4350, 2700, 5130.
- **Knjiženje svake fakture = 3 stavke:**
  | Stavka | Konto | Strana | Iznos |
  |---|---|---|---|
  | 1 | 4350 (dobavljači u zemlji) | Potražuje | ukupan iznos sa fakture |
  | 2 | 2700 (PDV 20%) ili 2710 (PDV 10%) | Duguje | iznos PDV-a |
  | 3 | 5*** (npr. 5130) | Duguje | osnovica |
  - Saldo mora biti 0 nakon svakog troška.
  - Povratnica → sve sa minusom; knjižno odobrenje (npr. Lukoil) → ceo nalog sa minusom.

#### 13e — BPDV (bez korišćenja PDV-a; ručno, jedan nalog mesečno)
- Isti postupak kao TROS, vrsta naloga BPDV. Za reprezentaciju / Lukoil putnička vozila i sl.
- **image34 — Pregled naloga, vrsta BPDV** (nalog 0009).
- **Stavke:**
  | Konto | Strana | Iznos |
  |---|---|---|
  | 4350 | Potražuje | ukupan iznos |
  | 5**** (npr. 55100 reprezentacija) | Duguje | ceo iznos |
  | 2704 (20%) / 2714 (10%) — ako ima PDV koji se ne sme koristiti | Duguje **i** Potražuje | iznos PDV-a |

### PROCES 14 — Ulazne fakture: skidanje avansa (Glavna knjiga → Unos naloga, vrsta RAZNO)
- Avans dobavljaču na izvodu → konto **1520/1521**. Skidanje kroz nalog **RAZNO**:
  | Stavka | Konto | Duguje | Potražuje | Opis |
  |---|---|---|---|---|
  | 1 | 1520 | ceo iznos (minus) | PDV (minus) | broj AVR |
  | 2 | 27200 | PDV (minus) | — | broj AVR |
  | 3 | 4350 | ceo iznos sa fakture | — | broj konačne fakture |
- Efekat: avans se "poništava" i uplata prikazuje kroz 4350 na duguje.

### PROCES 15 — Otvaranje PREDMETA i RN (Predmeti → Unos predmeta)
- **Kada:** kupac prihvati ponudu (roba ili usluga) ili za projekat (jave inženjeri/Zoran). Za projekat se **obavezno** otvara i radni nalog.
- **image35 — forma "Unos predmeta" (ID 9501):** dugmad **Novi predmet, Napravi radni nalog, Pregled predmeta, Vrste poslova, čekmark, STOP, Promeni komitenta**. Polja: Broj predmeta (BB dodeljuje, npr. 9026), Datum otvaranja, **Komitent** (Robert Bosch d.o.o.), Naziv predmeta ("Senzor položaja"), Opis, **Vrsta posla** (TRGOVINA), Prodavac (Jovana Pantelić), **Status** (U TOKU), Sledeća akcija, Datum zaključenja, **Rok završetka**, Naša/Vaša ref + kontakti/telefoni, **Veži sa ponudom** / Poveži sa ponudom (+ verzija za Usluge), **Broj narudžbenice (PO broj)** (P79-0085140807), Datum narudžbenice, Broj ugovora, Datum ugovora, Napomena.
- **image36 — šifarnik "Vrsta posla":** NEBITNA (vrsta posla nije bitna), PROIZVODNJA (proizvodnja samo), PROJPROZ (projektovanje i proizvodnja), SERVIS (usluge/servis), TRGOVINA.

### PROCES 16 — Uvoz (robno + finansijski)
#### 16a — Ulaz robe u magacin (Magacin → Ulaz, vrsta UVOZ)
- **Koraci:** Novi dokument → naziv dobavljača (npr. Aventics) → datum = datum sa carine (gornji desni ugao carinskog računa) → vrsta **UVOZ** → broj = broj fakture dobavljača (prve, ako ih ima više) → Magacin robe (roba) ili Magacin repro (materijal) → **Obračunski kurs = kurs sa JCI-a stavka 23** (ceo, 4 decimale; isti u kurs carine).
- **KALKULACIJA (zavisni troškovi):**
  - **Neoporezivi ZT = (1)+(2)+(3):** (1) transport + pakovanje sa fakture dobavljača × kurs sa JCI-a; (2) "ukupno 1" sa carinskog računa (ako smo carinu platili carini); (3) sa špediterske fakture osnovica za troškove (usluga špedicije + bankarska garancija, bez prefakturisanih carinskih troškova, bez PDV-a).
  - **Devizna vrednost** = vrednost robe od ino dobavljača bez pakovanja/prevoza (zbir svih faktura; provera = JCI stavka 22).
  - *Carina se sabira jednom (da se ne duplira).*
- Nabavka olovkom upisuje PO na uvoz → **desni klik na čekić → "proknjiži stavke iz PO"** (uneti PO) → **levi klik na ikonicu Uvoz → "preračunaj ponovo"** (obavezno — inače ZT nisu ukalkulisani) → štampa kalkulacije → snimi (STOP).

#### 16b — Finansijsko knjiženje uvoza (Glavna knjiga → Unos naloga, vrsta UVOZ)
- Datum knjiženja = datum sa carine (ako je kraj meseca a carina nije plaćena → prvi dan narednog meseca).
- **Struktura naloga (saldo mora biti 0):**
  | Konto | Opis | Strana |
  |---|---|---|
  | 4630 | INO dobavljači (Invoice No, kurs×iznos, valuta EUR, kurs sa JCI-a) | Devizno potražuje |
  | 4350 | Uprava carine (br. = poslednjih 6 cifara carinskog računa; iznos "SVEGA" = ukupno 1 + ukupno 2) | Potražuje |
  | 2740 | PDV uvoz (Uprava carine; iznos = ukupno 2) | Duguje |
  | 4350 | Špediter (Pro Team/Delamode/Gebruder…; ukupno sa PDV-om) | Potražuje |
  | 2700 | PDV špediter | Duguje |
  | 1320 (roba) / 1010 (materijal) | ino dobavljač; ukupna nabavna vrednost sa kalkulacije (3. kolona "nabavna vrednost robe") | Duguje |
  - Ako špediter prefakturisao carinske troškove → nema 4350 Uprava carine, ali PDV uvoza (2740) i dalje na Upravu carine.
  - Razlika: saldo minus → **5630** (negativne kursne razlike, duguje); plus → **6630** (pozitivne, potražuje). Veće razlike = greška (tražiti gde).
- **Česte greške:** nepoštovanje koraka; nije kliknuto "preračunaj ponovo" (ZT neukalkulisani); previđena dodatna faktura ino dobavljača (menja se devizna vrednost u zaglavlju).
- Roba iz uvoza može ići: na lager Servoteha / za trgovinu (fakturisati kupcima) / za rezervaciju na RN.

#### 16c — Dalja prodaja (kao IFR)
- Magacin → Naručivanje robe → Pronađi porudžbenicu (PO sa uvoza) → Pregled profakture (šta je ponuđeno/stiglo) → Magacin → Izlaz → Novi dokument → vrsta **IFR** → broj (crvena sveska) → desni klik na alate → **Prepiši iz ulaza / Proknjiži stavke iz profakture** (broj ponude) → ako je ponuda u EUR: kartica STD → uneti kurs → Primeni kurs.
- **Pravilo kursa:** 125 din za sve kupce, **osim Robert Bosch = 118 din**.
- Štampa: 1 faktura + 2 otpremnice bez cena (AKS → prijava brzoj pošti). Ako postoji PO kupca → obavezno u napomeni (inače faktura neće biti odobrena na SEF-u).

### PROCES 17 — Kartice analitike i izveštaji (Glavna knjiga)
- **Kartica analitike:** Od/Do datuma → Za konto (2040 kupci / 4350 dobavljači) → Za naziv (komitent) → Primeni uslove → štampa/PDF (Ctrl+P). Za ino komitente prekidač **DIN/DEV**.
- **Salda analitike:** za banku → konto + Od/Do datuma → Primeni → PDF.
- **Bruto stanje (bilans):** Filter datuma (do datuma) → Primeni → štampa/PDF.
- **Konta za salda:** 2040 domaća potraživanja · 2050 ino potraživanja · 4350 domaće obaveze · 4360 ino obaveze · 4300 primljeni domaći avansi · 4302 primljeni ino avansi · 1520 dati domaći avansi · 1530 dati ino avansi.

### PROCES 18 — Slaganje robnog i finansijskog (provera pre PDV-a)
- **Finansijski:** Glavna knjiga → Bruto stanje → klase **1320** (roba) / **1010** (materijal) → do poslednjeg dana meseca → "Napravi bruto stanje po uslovu (Shift F9)" → saldo duguje (plavo) zapisati.
- **Robno:** Artikli → Lager lista → "Lager lista na dan …" → Izdvoj artikle za magacin (Magacin robe/repro) → Primeni → skrolovati desno → **Prosečna nabavna cena** (dno).
- Ako se ne slažu → neslaganje se mora utvrditi pre predaje PDV-a.
- **Traženje pogrešno knjiženih faktura:** Magacin → Zbirovi po dokumentima → Ulazna dokumenta = NE → datum → vrsta IFR → Primeni → kolona **ukalkulisana RuC** (Ctrl+F3, sortiranje Z-A) → svaka faktura sa RuC ≠ 0 je greška (dva različita ulaza iste robe po različitim cenama) → ući u artikal i ispraviti RuC = 0.
- **Kontrola PDV-a:** Zbirovi po dokumentima (ukupan PDV) za IFR + IFGP → mora se složiti sa kontom **4700**; usluge (pregled za mesec) → sa kontom **4703** (usluge se knjiže ručno — česta greška u kucanju konta).
- **Alternativa:** Lager lista → "NEISPRAVNA KARTICA ARTIKLA" (datum + magacin → razlika +/- u nabavnoj vrednosti).

### PROCES 19 — Pripreme za PDV (8 koraka)
- **I korak — Brisanje naloga:** Glavna knjiga → Pregled naloga → datum (ceo mesec) → vrste **IFR, IFGP, UFMAT, UFROB, TREB, TREB1, USLRO, USLMA** → ući u nalog → levo prazno polje → Delete. **NE brisati: IFUSL, IZVOD, AVR, BPDV, TROS** (knjiže se ručno). Zatim ponovno automatsko knjiženje: Unos naloga → Knjiženje iz robnog po šemi → ceo mesec → Proknjiži iz robnog.
- **II korak — Finansijski nalozi izlaznih faktura:** Pregled naloga → IFR/IFGP/IFUSL → štampa svakog naloga po danu → uz njega slagati račune/otpremnice → uporediti PDV faktura ↔ finansijski nalog.
- **III korak — Ulazne fakture:** Pregled naloga → UFMAT/UFROB (po danu, uporediti sa fakturom i nalogom u registratoru); **TROS** (jedan nalog za mesec).
- **IV korak — BPDV:** jedan nalog za mesec (fakture bez PDV-a / PDV se ne koristi) → uporediti.
- **V korak — USLRO:** Magacin → Zbirovi po dokumentima (NE) → ceo mesec → vrsta **USLRO** → Neto nabavna vrednost (dno) mora se složiti sa **karticom konta 5012** (sintetička); provera da nešto nije skinuto sa robe (1320) i troška (5012).
- **VI korak — TREB i TREB1:** Zbirovi po dokumentima → Neto nabavna vrednost za TREB + TREB1 → zbir se mora složiti sa kontom **5110** (troškovi osnovnog materijala).
- **VII korak — ULGP:** provera konta **9020** (= zbir neto nabavne vrednosti), **9600** (uvek 0 — GP u skladištu); **9020 + 9600 = 9800** (troškovi prodatih proizvoda, isti kao 9020 ali pozitivan).
- **VIII korak — Slaganje SEF ↔ BigBit:**
  - SEF → Prodaja → filter datuma (od 1. u mesecu do ~5. narednog) → tip faktura → prikaz 100 po strani → čekirati sve → otkačiti fakture prethodnog meseca; **fakture sa avansom prikazuju se na SEF-u kao 0** (brojeve zapisati); odštriklirati BMTS/Euro-metal (bez PDV-a) i stornirane → sabrati ukupne iznose po stranama.
  - Izlazni PDV u BB: Bruto stanje → konto **47** → 4701 + 4702 + 4703 → mora se složiti sa PDV-om na SEF-u.
  - Formula PDV-a: `ukupan iznos × 16,66667% = PDV` (npr. 25.768.935,07 × 16,66667% = 4.294.823,37).
  - Ulazne (SEF → Nabavka): isto, otkačiti prethodni mesec, nule, banke, špeditere, bez-PDV, PDV koji se ne koristi. Ulazni PDV u BB: Bruto stanje → konto **27** (oduzeti izvod, špeditere/uvoz, avanse).

### PROCES 20 — Provera PDV obaveza (Glavna knjiga → Bruto stanje)
- **Konto 27** (potraživanja za PDV): zbir duguje minus 2704.
- **Konto 47** (obaveze za PDV): zbir potražuje minus 2790 (ako ima pretplata).
- **Konto 2790** (pretplata): saldo duguje (plavo, bez datuma).
- **Formula:** `47 − 27 − 2790 = obaveza za PDV`. Negativan iznos = pretplata (nema obaveze plaćanja tog meseca).

---

## 3. Moduli / oblasti BigBit-a

| Oblast | Meni-grupa / stavke | Uloga |
|---|---|---|
| **Komercijala / prodaja** | Predmeti (Zahtevi za ponude, Unos/Pregled predmeta), Magacin → Profakture (PON), Naručivanje robe, Pregled narudžbina, Cenovnik | Ponude, predmeti, porudžbenice, cenovnici (STDCN) |
| **Magacin / zalihe** | Magacin (Ulaz, Izlaz, Zbirovi, Nivelacija, Obračun radnih naloga), Artikli (Unos, Lager lista, Kartice, Popis, Recepti za proizvodnju, Nalepnice), Reversi, Izlaz iz magacina | Prijem/izdavanje, lager, rezervacije, komisiona roba |
| **Fakturisanje** | Magacin → Izlaz (IFR, IFGP, TREB, ULGP), Usluge → Fakturisanje (IFUSL, AVR) | Izlazni dokumenti robe/usluga/GP, avansi |
| **Nabavka** | Magacin → Nabavka (e-Fakture), Zahtev ka dobavljaču, Naručivanje robe; Artikli → Nabavka | Porudžbenice, prijem ulaznih faktura |
| **Finansije / Glavna knjiga** | Kontni plan, Unos/Pregled naloga, Dnevnik, Bruto stanje, Kartica konta, Kartica/Salda analitike, Otvorene stavke, Komitent po kontima, Unakrsni izveštaji | Dvojno knjigovodstvo, izvodi, kartice, bilansi |
| **Blagajna** | Glavna knjiga → Unos blagajne (BLAG) | Gotovinski troškovi |
| **PDV / poresko** | PDV obrazac (Unos naloga GK, POPDV), Stare PDV knjige, Bruto stanje (klase 27/47) | Obračun i provera PDV-a |
| **e-Faktura / SEF** | Usluge → Pregled e-Faktura, Magacin → Knjiga e-Faktura / Nabavka (e-Fakture), tab E-faktura na dokumentima | Export/import SEF, evidencije PDV-a |
| **Uvoz / carina** | Magacin → Ulaz (UVOZ), kalkulacija sa JCI-a/špeditera | Uvozne kalkulacije, ino dobavljači, carinski PDV |
| **Proizvodnja / servis (MES)** | Predmeti + Radni nalozi, TREB/TREB1/ULGP, Recepti za proizvodnju, Obračun/Spec. radnih naloga, klase 9020/9600/9800 | Radni nalozi, trebovanje, gotov proizvod |
| **Šifarnici (RAZNO)** | Korisnici, Poreske stope, Grupe i porekla, Vrste dokumenata, Vrste naloga, Šeme za kontiranje, Cenovnik, Poslovi, Magacini, Kursna lista | Matični/konfiguracioni podaci |
| **Komitenti (CRM-lite)** | Unos/Pregled, Vrste komitenata, Važni datumi, Unos/Pregled/Priprema plaćanja | Kupci/dobavljači, plaćanja |
| **Izveštaji / servis** | Unos/Pregled izveštaja, GK izveštaj, Analiza prodaje, Prodavci-obračun | Analitika, obračun prodavaca |

---

## 4. Šifarnici, dokumenta i tokovi

### 4.1 Šifarnici (RAZNO / matični podaci)
- **Komitenti** (ključ = PIB; Vrste komitenata; tekući računi Tr1/Tr2/Tr3; JBKJS za budžetske)
- **Artikli** (kataloški broj, naziv, **Grupe i porekla** — gotov proizvod, hidraulika, pneumatika, razno)
- **Cenovnik** (STDCN = standardni cenovnik, cene po artiklu, EUR)
- **Kursna lista** (kurs iz JCI-a; poslovni kurs 125 din, Robert Bosch 118 din)
- **Poreske stope** (20%, 10%, 0%)
- **Vrste dokumenata** i **Vrste naloga**
- **Šeme za kontiranje** (automatsko knjiženje "iz robnog po šemi")
- **Vrste poslova** (šifarnik na predmetu: NEBITNA, PROIZVODNJA, PROJPROZ, SERVIS, TRGOVINA)
- **Poslovi**, **Magacini** (Magacin robe, Magacin repro, Magacin gotovih proizvoda), **Korisnici**, **Radni nalozi**

### 4.2 Vrste dokumenata (robno)
| Šifra | Značenje | Modul |
|---|---|---|
| PON / PROF | Ponuda / profaktura | Prodaja |
| OTP | Otpremnica | Magacin |
| REZR | Rezervacija robe (RN+R) | Magacin |
| REZM | Rezervacija materijala (RN+M) | Magacin |
| NARUČIVANJE | Porudžbenica ka dobavljaču (PO) | Nabavka |
| UFROB | Ulazna faktura robe | Nabavka |
| UFMAT | Ulazna faktura materijala | Nabavka |
| UVOZ | Uvozni ulaz + kalkulacija | Uvoz |
| TREB | Trebovanje materijala (50% GP) | Proizvodnja |
| TREB1 | Trebovanje robe | Proizvodnja |
| ULGP | Ulaz gotovog proizvoda | Proizvodnja |
| IFR | Izlazna faktura robe | Fakturisanje |
| IFUSL | Izlazna faktura usluge | Fakturisanje |
| IFGP | Izlazna faktura gotovog proizvoda | Fakturisanje |
| AVR | Avansni račun | Fakturisanje (Usluge) |
| USLRO / USLMA | Utrošak robe / materijala (obračun) | Magacin/proizvodnja |

### 4.3 Vrste finansijskih naloga (Glavna knjiga)
IFR, IFGP, IFUSL, UFROB, UFMAT, UVOZ, **TROS**, **BPDV**, **IZVOD**, **AVR**, **RAZNO**, USLRO, USLMA, TREB, TREB1, ULGP.
- Automatski (iz robnog po šemi): IFR, IFGP, UFROB, UFMAT, TREB, TREB1, USLRO, USLMA, ULGP.
- Ručno: **IFUSL, IZVOD, AVR, BPDV, TROS, RAZNO, UVOZ**.

### 4.4 Kontni plan (konta pomenuta u uputstvu)
- **Kupci/potraživanja:** 2040 (domaći), 2050 (ino)
- **Dobavljači/obaveze:** 4350 (domaći), 4360 (ino), 4630 (ino uvoz), 4390 (kartice)
- **Avansi:** 4300/4302 (primljeni dom./ino), 4720/4790 (PDV po primljenim avansima), 1500/1520/1521 (dati dom.), 1530 (dati ino)
- **PDV ulazni (pretporez), klasa 27:** 2700 (20%), 2710 (10%), 2704 (20% ne koristi se), 2714 (10% ne koristi se), 2740 (uvoz/carina), 27200 (avans), 2790 (pretplata)
- **PDV izlazni, klasa 47:** 4700 (zbirni), 4701 (20% proizvodi), 4702 (20% roba), 4703 (usluge 20%)
- **Zalihe:** 1320 (roba), 1010 (materijal)
- **Blagajna:** 2419 (ulaz), 2430 (glavna knjiga)
- **Prihodi:** 6140 (usluge)
- **Troškovi (klasa 5):** 5012, 5110 (osn. materijal), 5120, 5121, 5125, 5127, 5130 (naftni derivati), 5133, 5310, 5313, 5314, 5322, 5391, 5399, 5510/55100 (reprezentacija), 5530, 5630 (neg. kursne razlike)
- **Prihodi kursni:** 6630 (poz. kursne razlike)
- **Obračunska klasa 9 (proizvodnja):** 9020, 9600 (uvek 0), 9800 (= 9020 pozitivno)

### 4.5 Ključni tokovi (workflow)

**A) Prodaja robe (trgovina):**
`Zahtev za ponudu (Predmeti) → PON/profaktura (Magacin) → prihvat → Predmet (+ opciono RN) → Porudžbenica dobavljaču (NARUČIVANJE, PO) → prijem UFROB → IFR (Izlaz) → SEF export → finansijsko knjiženje IFR (2040) → naplata kroz IZVOD`

**B) Usluga:**
`(avans) → AVR (Usluge) + knjiženje 4300/4720 → IFUSL (Radni nalog + Zapisnik) → ručno knjiženje 2040/4703/6140 → SEF (avans → iznos 0)`

**C) Gotov proizvod (proizvodnja):**
`Predmet + RN → REZM/REZR (rezervacija) → TREB/TREB1 (trebovanje, 50%) → ULGP (ulaz GP) → IFGP (+ veza sa avansom) → SEF (obriši pa unesi konačni račun) → finansijsko knjiženje IFGP`

**D) Nabavka/ulaz:**
`Porudžbenica → faktura (SEF/mail/pošta) → nabavka overava (RN+PO) → potpis (Nenad/Nevena) → razvrstavanje (TROŠ/BPDV/UFROB/UFMAT) → robno (Ulaz, proknjiži iz PO) → rezervacija na RN → finansijsko (auto ili ručno TROS/BPDV)`

**E) Uvoz:**
`Dokumentacija (faktura ino + JCI/carina + špediter) → Ulaz UVOZ + kalkulacija ZT (preračunaj ponovo) → finansijski nalog UVOZ (4630/4350/2740/2700/1320) → dalja prodaja (IFR) ili lager/rezervacija`

**F) Mesečni PDV ciklus:**
`Brisanje+reknjiženje auto naloga → provera izlaznih/ulaznih naloga → USLRO/TREB/ULGP kontrole → slaganje SEF↔BB (16,66667%) → obračun 47−27−2790`

### 4.6 Vanjski sistemi i "ručni" artefakti
- **SEF (efaktura.mfin.gov.rs)** — sertifikat/kartica; Prodaja, Nabavke, Zbirna/Pojedinačna evidencija PDV, Prekogranični promet.
- **e-banking banke** — izvoz izvoda u `.txt`, uvoz u BigBit.
- **APR** (naziv/matični), **kjs.trezor.gov.rs** (JBKJS).
- **Fajl-share:** `\\SRV\SHARES\EXPORT\` (PDF/XML fakture), folder IZVODI, folderi po kupcu.
- **"Crvena sveska"** = fizička Knjiga izlaznih faktura (izvor sledećeg slobodnog broja IFR/IFUSL/IFGP i evidencija poslatih na SEF) — **kritična ne-sistemska zavisnost**.
- Registratori (fizički): Blagajna, UVOZ, TROS/BPDV itd.

---

## 5. Za ServoSync 4.0 migraciju — šta je ključno preneti

1. **Numeracija dokumenata i sekvence.** IFR/IFUSL/IFGP brojevi se danas vode u fizičkoj "crvenoj svesci" → 4.0 mora imati pouzdane sekvence po vrsti dokumenta i godini (BB radi po poslovnoj godini / MDB po godini). Uključiti i "Otvaranje nove poslovne godine" (prenos otvorenih stavki 2040/2050/4350/4360/avansi/predmeti/profakture).
2. **Kompletan model dokumenata i njihovih veza (state machine).** PON → Predmet/RN → Porudžbenica → UFROB/UFMAT/UVOZ → REZR/REZM → TREB/TREB1 → ULGP → IFR/IFGP/IFUSL → SEF. Sačuvati polje **Predmet/RN** kao vezni ključ kroz ceo lanac (rezervacije, trebovanja, ulaz/izlaz).
3. **Automatsko kontiranje "po šemi".** Preneti šeme za kontiranje (IFR→2040, UFROB/UFMAT auto, IFGP auto) + ručne obrasce (IFUSL 2040/4703/6140; TROS 4350/2700/5xxx; BPDV; RAZNO za skidanje avansa; UVOZ višelinijski). Kontni plan (klase 1,2,4,5,6,9) je poznat — mapirati tačno.
4. **Integracija sa SEF-om (prioritet).** Danas polu-ručno (export XML iz BB, često ručni unos + pojedinačna evidencija PDV). 4.0 treba native SEF API: slanje izlaznih, prijem ulaznih, PDV kategorije (S20/Z, osnov 24-1-5 za BMTS), avansne fakture (konačni račun = 0), storniranje, statusi (Sales/Purchase ID).
5. **Uvoz + carinske kalkulacije.** Model zavisnih troškova (neoporezivi ZT = transport+pakovanje+carina+špedicija), kurs sa JCI-a (stavka 22/23), ino dobavljači, carinski PDV (2740), kursne razlike (5630/6630). Ovo je najkompleksniji ručni tok — automatizovati raspodelu ZT na artikle.
6. **PDV mašina.** Automatizovati mesečni ciklus (brisanje/reknjiženje, kontrole robno↔finansijski, RuC=0 pravilo, slaganje SEF↔BB) i POPDV. Uklanjanje ručne provere "16,66667%" i ručnog slaganja stranica na SEF-u.
7. **Robno-finansijska konzistentnost.** Ključno pravilo **Mag.VP cena = Nab. cena (RuC=0)** i prosečna nabavna cena po lageru — 4.0 mora garantovati da nema drifta zaliha↔GK (klase 1320/1010 vs. lager lista).
8. **Proizvodnja/MES (radni nalozi).** Predmet + RN, vrste poslova (TRGOVINA/PROIZVODNJA/PROJPROZ/SERVIS), rezervacije (REZR/REZM), trebovanje (pravilo 50% GP), ULGP, obračun preko klase 9 (9020/9600/9800). Recepti za proizvodnju.
9. **Banka/izvodi.** Uvoz izvoda (auto raspoređivanje 2040/4350, uparivanje po tekućem računu, čuvanje novih računa na komitentu, kartica → 4390/2700/trošak).
10. **Šifarnici i matični podaci.** Komitenti (ključ PIB, JBKJS, više tekućih računa, vrste komitenata), Artikli (grupe/porekla, kat. broj), Cenovnik (STDCN, EUR + kurs po kupcu, RB=118), Magacini (roba/repro/GP), Poreske stope, Prodavci.
11. **Otpremnice i zapisnici.** IFR → 2 otpremnice; IFUSL → **Zapisnik umesto otpremnice**; standardni pravni tekstovi (poresko oslobođenje, reklamacije 5 dana, nadležni sud, zatezna kamata).
12. **Ukloniti ne-sistemske zavisnosti.** Crvena sveska, ručni registratori, "Nenad/Nevena potpis", ručni SEF unos — sve prevesti u digitalne tokove sa ulogama/odobrenjima i audit tragom.

---

### Dodatak: screenshotovi po formatu (media/, ukupno 40)
- **JPEG: 31** (glavne Access forme i SEF ekrani — meni, Izlaz/IFR, Ulaz/UFROB, Profakture/REZR, IFUSL, e-Faktura export, SEF web, Pregled/knjiženje naloga, Bruto stanje…)
- **JPG: 4** (image3 Nalog GK/Uvoz izvoda, image4 uparivanje komitenta, image5 e-banking dugmad, image38 fragment "Rok završetka")
- **PNG: 4** (image8 prazan red Ulaz, image35 Unos predmeta, image36 šifarnik Vrsta posla, image37 fragment PO broj)
- **GIF: 1** (image1 — dekorativni/linijski element, nije čitljiv sadržaj)
- EMF/WMF: **nema** u arhivi.
- Svi rasterski screenshotovi su pregledani i opisani uz odgovarajuće procese/forme iznad.

# Proba: povratak na listu i pamćenje mesta (07.08.2026)

> **Ovo se daje AI agentu koji upravlja pregledačem** u kom je korisnik već prijavljen.
> Agent sam klikće kroz aplikaciju i prijavljuje šta vidi.

---

# 🔴 PRVO I NAJVAŽNIJE — ZABRANA UPISA

**Ovo je ŽIVI poslovni sistem jedne firme, ne test okruženje.** U njemu su stvarne fakture,
stvarne zalihe i stvarna glavna knjiga. Od 07.08.2026. je uključeno **automatsko knjiženje**:
dokument koji nastane ili se zaključi **odmah pravi nalog u glavnoj knjizi**.

**SMEŠ SAMO:** otvarati ekrane, postavljati filtere, pretraživati, skrolovati, menjati stranu,
otvarati postojeće zapise radi pregleda, i vraćati se nazad.

**NE SMEŠ, ni na jednom ekranu, ni „da probaš":**

- kliknuti **Snimi, Sačuvaj, Potvrdi, Zaključi, Proknjiži, Pošalji, Izdaj, Storniraj, Obriši,
  Dodaj, Novi, Izmeni, Otkaži** — niti bilo koje dugme koje menja podatak;
- uneti ili promeniti bilo šta u polju koje pripada zapisu (količina, cena, datum, napomena);
- potvrditi bilo koji dijalog koji pita „da li ste sigurni";
- otpremiti fajl, poslati e-poštu, odštampati dokument;
- otvarati Podešavanja, Korisnike, Prava, Sinhronizaciju.

**Polja za pretragu i filteri su izuzetak — njih smeš da koristiš**, jer ništa ne upisuju.

**Ako se bilo koji dijalog otvori sam** — zatvori ga sa Esc ili „Odustani", **nikad** potvrdom.

**Ako nisi siguran da li neki klik nešto menja — ne kliktaj.** Zapiši da si stao i zašto.
Preskočen test je bezopasan; pogrešan klik u glavnoj knjizi nije.

---

## Kako da radiš

1. Idi **jedan test odjednom**, redom.
2. Za svaki: izvrši korake, pa uporedi ono što vidiš sa **OČEKIVANO**.
3. Ako se poklapa — zabeleži „prošao" i idi dalje.
4. Ako se ne poklapa — **ne pokušavaj da popraviš i ne nagađaj uzrok**. Zabeleži tačno: broj
   testa, ekran, šta si uradio (koji filter, koja strana), **šta si stvarno video**, i da li se
   ponavlja iz drugog pokušaja.
5. Nekoliko testova traži da pratiš **prvi trenutak** posle povratka — da li nešto bljesne pa
   se promeni. Tamo gde to piše, gledaj pažljivo; to je bio poseban kvar.

⚠️ Ne izmišljaj objašnjenja zašto nešto ne radi. Kod ne vidiš. Tvoj posao je da tačno opišeš
šta se vidi.

---

## Šta je promenjeno, ukratko

Do sada: kad se sa liste otvori neki zapis pa vrati nazad, aplikacija je vraćala **na početak**,
a ponekad i na **sasvim drugu listu**. Ko je filtrirao, skrolovao pa otvorio jedan red, morao je
sve iznova.

Od 07.08.2026: povratak vraća na **istu listu, sa istim filterima, na isto mesto** — na šest
ekrana: Artikli, Lager lista, Robni dokumenti, Popis, Komitenti, Zahtevi.

---

## Testovi

### T1 — Lager lista, „Detaljno artikal" (glavni test)

Ovo je kvar koji je vlasnik prijavio.

1. Otvori **Matični podaci → Lager lista**.
2. Postavi filter (npr. izaberi magacin) i sačekaj da se lista osveži.
3. **Skroluj nadole** bar dva-tri ekrana redova. Zapamti kataloški broj artikla koji ti je pred
   očima.
4. Desni klik na red → **„Detaljno artikal"**. *(Ili: izaberi red pa istu radnju iz dugmadi
   iznad tabele.)*
5. Kad se otvori kartica, pritisni **Esc** ili klikni **„Nazad"**. Ništa ne menjaj na kartici.

**OČEKIVANO:** vraća te na **Lager listu** — ne na „Artikle". Filter je i dalje postavljen, a
zapamćeni artikal je opet pred tobom.

**RANIJE:** vraćalo je na ekran „Artikli", sa filterima te druge liste.

---

### T2 — Isto, ali dugmetom pregledača

Ponovi T1, ali umesto Esc/„Nazad" upotrebi **strelicu nazad u pregledaču**.

**OČEKIVANO:** isto kao T1.

*(Zaseban test jer aplikacija i pregledač do rezultata dolaze različitim putem.)*

---

### T3 — Robni dokumenti

1. **Robno → Dokumenti**.
2. Postavi filter po vrsti dokumenta i pređi na **dalju stranu** (3. ili 7.).
3. Otvori bilo koji dokument **samo za pregled**. Ne diraj nijedno dugme na njemu.
4. Vrati se dugmetom **„Nazad"**.

**OČEKIVANO:** ista lista, isti filter, **ista strana** — ne strana 1.

⚠️ **Prati prvi trenutak:** ne sme, ni na tren, da bljesne **drugi broj dokumenata** u zaglavlju
ili **drugi broj strana** pa da se promeni. Ako to vidiš — zapiši.

---

### T4 — Popis

1. **Robno → Popis / inventura**, izaberi neki popis.
2. Skroluj kroz stavke. **Ne unosi nijednu količinu i ne diraj „Zaključi".**
3. Ako popis ima vezan dokument, otvori ga za pregled, pa se vrati.

**OČEKIVANO:** vraća te **u taj popis** (ne u listu robnih dokumenata), na isto mesto, i izabrani
popis ostaje izabran — i kad se koristi dugme pregledača.

---

### T5 — Komitenti

1. **Matični podaci → Komitenti**.
2. Ukucaj nešto u pretragu i pređi na **stranu 3 ili 4**.
3. **Skroluj do dna** te strane.
4. Otvori nekog komitenta za pregled, pa se vrati.

**OČEKIVANO:** ista pretraga, ista strana, **isto mesto na strani** — ne vrh.

---

### T6 — Zahtevi

1. Otvori **Zahtevi**, pa **neki tab koji NIJE „Inbox"**.
2. Otvori neki zahtev za pregled.
3. Vrati se.

**OČEKIVANO:** vraća te na **isti tab**, ne na Inbox.

---

### T7 — Nagrade *(samo ako je tab vidljiv)*

⚠️ Ovaj test je o **novcu**. Ništa ne kliktaj osim izbora meseca i povratka.

1. **Zahtevi → Nagrade**.
2. Prebaci se na **prošli mesec**.
3. Otvori neki zahtev za pregled, pa se vrati na Nagrade.

**OČEKIVANO:** prikazan je **prošli mesec**, sa svojim iznosima.

**NE SME:** da se, makar na trenutak, pojave iznosi **tekućeg** meseca pa da se promene. Ako to
vidiš — to je najozbiljnija stavka na spisku, zapiši je odmah i doslovno.

---

### T8 — Jedan meni „Komitenti"

1. Pogledaj levu navigaciju.

**OČEKIVANO:** **tačno jedna** stavka „Komitenti". Ranije su bile dve, pod istim imenom, a vodile
su na različite ekrane.

2. Ako u pregledaču postoji sačuvan stari obeleživač ka komitentima, otvori ga.

**OČEKIVANO:** ne dobijaš „stranica nije pronađena", nego te tiho prebaci na novi ekran.

---

### T9 — Promena filtera vraća na vrh *(ovo je ISPRAVNO)*

1. Na bilo kojoj listi skroluj duboko.
2. **Promeni filter** (ništa ne otvaraj).

**OČEKIVANO:** lista se vraća **na vrh**. To je namerno — nova pretraga daje nove redove.

*(Test postoji da se ovo ne prijavi kao kvar.)*

---

### T10 — Duga pauza *(traje 40 minuta, uradi ga poslednjeg)*

1. Na **Artiklima** ili **Lager listi** skroluj vrlo duboko, koristeći „Učitaj još".
2. Otvori neki artikal za pregled i **ostavi ga otvorenog 35–40 minuta**.
3. Vrati se.

**OČEKIVANO:** ili si na istom mestu, ili si na vrhu uz **poruku koliko je redova ranije bilo
učitano**, pored dugmeta „Učitaj još".

**NE SME:** da aplikacija zastane na nekoliko sekundi dok sama dovlači sve što je ranije bilo.

---

## Šta NIJE menjano (da se ne prijavi kao kvar)

- **Izgled, kolone, boje** — ništa nije dirano.
- **Lista komitenata nema kolone Telefon, Email i Matični broj** — one su na kartici komitenta.
  To je **odluka vlasnika od 07.08.2026**, ne propust.
- **Unos minimalne količine** na lager listi je zaključan — do prelaska se unosi u BigBit-u. Ko
  klikne, dobije objašnjenje. To je ispravno.
- **Brzina učitavanja** velikih lista (artikli imaju preko 92.000 redova) nije predmet probe.

---

## Šta vratiti kao rezultat

Za svaki test: **prošao** / **nije prošao** / **preskočen** (uz razlog).

Za svaki koji nije prošao:

1. broj testa (npr. T3);
2. ekran;
3. šta je tačno urađeno — koji filter, koja strana;
4. **šta se videlo**, što doslovnije;
5. da li se ponavlja iz drugog pokušaja;
6. pregledač (Chrome, Edge, Firefox) i da li računar ili telefon.

Na kraju: kratak spisak prošlih i palih, bez tumačenja uzroka.

**I obavezno navedi da li si negde stao zbog zabrane upisa** — koji test i na kom koraku.

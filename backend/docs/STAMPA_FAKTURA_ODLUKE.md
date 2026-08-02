# Štampa faktura — odluke vlasnika (01.08.2026)

Presuđeno na osnovu gap-analize ([STAMPA_FAKTURA_GAP.md](STAMPA_FAKTURA_GAP.md) §5).
Ovo su **obavezujuće odluke**, ne predlozi — kod koji im protivreči je greška.

---

## O-F1 · Broj računa: 4.0 prelazi na BigBit format `657/25`

Numeracija se **menja u 4.0**, ne skraćuje se samo u štampi. Isti broj stoji na papiru,
u SEF-u, u glavnoj knjizi i u saldakontima.

**Zašto:** skraćivanje samo na papiru značilo bi da kupac i Poreska uprava vide jedan broj,
a naša knjiga i SEF drugi. Za isti račun. To se ne radi.

**Posledica:** menja se `numbering.service.ts` (danas pravi `IFR0043/2026`). Format je
`NNN/GG` — redni broj bez vodećih nula, kosa crta, dvocifrena godina. Brojač je **po vrsti
dokumenta i godini**, i kreće od 1 (v. ranija odluka: ništa se ne prenosi iz istorije, jer
se na softver prelazi tek od nove godine).

⚠️ Ovo dira SEF i knjiženje — menja se **jednom, pre prvih proba**, nikad posle njih.

---

## O-F2 · „Odgovorno lice" = komercijalista sa računa

Uzima se `Salesperson` vezan za taj račun (`Invoice.salespersonId`). Polje **već postoji u
šemi ali se nikad ne popunjava** — `createProforma` ga mora upisivati.

**Dokaz iz papira:** na robi stoji Dragana Korkut, na usluzi Ana Golubović — dakle ime prati
dokument, ne firmu.

---

## O-F3 · Broj lične karte se NE štampa i NE čuva

Iako IFUSL nosi `Br. l.k.:008165163`, taj podatak **ne ide na dokument koji putuje kupcu**
i ne uvodi se u bazu. Linija ostaje prazna — tačno kao što već jeste na fakturama za robu.

**Zašto:** podatak o ličnosti bez poslovne potrebe. Račun je punovažan sa imenom i pečatom;
broj lične karte kupcu ne treba ni za šta.

---

## O-F4 · Traka uslova: šifarnik + podrazumevano sa kupca

`Roba je FCO`, `Način plaćanja` i `Način otpreme robe` biraju se iz **šifarnika** (padajuća
lista), a pri otvaranju dokumenta se popune onim što taj kupac inače koristi. Operater ih
može promeniti na samom dokumentu.

**Posledica:** tri mala šifarnika + podrazumevane vrednosti na kartici kupca; polja na
dokumentu su neobavezna (stari računi nemaju vrednost).

---

## O-F5 · Izlazne fakture dele JEDAN niz brojeva, bez obzira na vrstu

Ne postoji brojač po vrsti dokumenta. `IFR`, `IFGP`, `IFUSL` i njihovi ino parnjaci
(`IZVRO`, `IZVGP`, `IZVUS`) uzimaju broj iz **jednog zajedničkog niza** po firmi i godini.

**Dokaz — sa donetih papira, ne iz pretpostavke:**

| obrazac | broj | datum | vrsta |
|---|---|---|---|
| IFGP | **650**/25 | 22-12-25 | gotovi proizvodi |
| IFUSL | **653**/25 | 24-12-25 | usluga |
| IFR | **657**/25 | 25-12-25 | roba |

Tri različite vrste, a brojevi rastu **hronološki preko vrsta**. Brojač po vrsti to ne može
da proizvede. Poklapa se i sa ranijom odlukom: usluga je poseban **ekran**, ali numeracija je
jedan niz.

**Zašto je ovo više od kozmetike:** pošto broj po odluci O-F1 više ne nosi slovni prefiks, dva
dokumenta različite vrste sa istim rednim brojem izgledala bi identično — `657/25`. Baza to ne
bi prijavila (jedinstvenost nad `invoices` uključuje i vrstu), ali **otvorene stavke, kamata,
priprema plaćanja i uparivanje izvoda grupišu po broju BEZ vrste** — pa bi se dve fakture tiho
netovale u jednu stavku i dug jednog kupca sakrio dug drugog. Jedan zajednički niz taj sudar
čini nemogućim.

⚠️ Ne vraćati na brojač po vrsti. Dokaz i posledica su prepisani i u `numbering.service.ts`.

**Van zajedničkog niza ostaju** avansni račun (AVR), predračun (PROF) i ponuda (PON) — za njih
nemamo papir koji pokazuje šta BigBit radi, a avansi imaju i zaseban zakonski niz.

---

## O-F6 · Naši avansni računi dobijaju SVOJ niz brojeva

Avansni račun koji mi izdajemo kupcu numeriše se **odvojeno od izlaznih faktura**, sopstvenim
nizom (npr. `A-1/26`), a ne iz zajedničkog niza iz O-F5.

**Zašto:** ulazni avansi dobavljača upisuju se u **istu tabelu** `invoices`, sa **istom vrstom**
`AVR` i **ručno kucanim** brojem (`pdv/advance-vat.service.ts:531-588`). Pošto po odluci O-F1 naš
broj sada izgleda `1/26` — tačno kao broj koji srpski dobavljači kucaju na svojim avansima —
sudar je bio pitanje dana. Ishod bi bio ili odbijen legitiman dobavljačev dokument, ili pad
izdavanja našeg avansa usred posla.

Zaseban niz taj sudar čini nemogućim bez diranja tabele u koju se upisuju dobavljačevi avansi.

⚠️ Menja se **pre prvih proba**, kao i O-F1 — posle njih se numeracija ne dira.

---

## 🔴 ČEKA ODLUKU PRE PUŠTANJA U RAD · Matični broj u bloku „Preuzeo za prevoz"

**Nalaz (01.08.2026):** na fakturama za robu, u bloku sa NAŠIM podacima uz potpis, BigBit štampa:

```
SERVOTEH doo
Dobanovci, Ugrinovačka 163
PIB: 101017443   MB: 20748346
```

PIB `101017443` **jeste naš**. Matični broj `20748346` **NIJE** — naš je `17400169`, što piše u
podnožju iste te fakture (`Matični broj: 17400169`, `Registarski broj: 01117400169`).

Broj `20748346` na istom papiru stoji i u okviru KUPCA (`HAP FLUID D.O.O. · PIB: 107136558 -
MB: 20748346`). Dakle BigBit u naš potpisni blok upisuje **matični broj kupca**.

**Koliko dugo traje:** nepoznato, ali greška je u samom obrascu, ne u podacima — dakle važi za
svaku fakturu za robu koja je ikad odštampana iz BigBita. Oba donesena primera (IFR 657/25 i
IFGP 650/25) je nose.

**Šta 4.0 danas radi:** štampa **naš** broj iz `companies.registration_number`. To je svesno
odstupanje od originala, i zato traži potvrdu.

**Za odluku pre puštanja u rad — tri mogućnosti:**

| | šta se štampa | posledica |
|---|---|---|
| A | naš pravi broj `17400169` | papir je tačan; razlikuje se od svih dosadašnjih faktura |
| B | kako BigBit štampa (`20748346`) | papir identičan dosadašnjem, ali nosi tuđ podatak |
| C | matični broj se izostavi iz tog bloka | ostaju naziv, adresa i PIB; najmanje šansi za zabunu |

⚠️ Provera zakonske obaveznosti matičnog broja na računu je deo
[FAKTURE_ZAKONSKA_USKLADJENOST.md](FAKTURE_ZAKONSKA_USKLADJENOST.md) — odluka se donosi tek
kad taj nalaz stigne.

---

## 🔴 ČEKA · Način plaćanja na ino fakturi → prvo provera zakona

Umesto da se doda drugo polje (prvobitni predlog), vlasnik je tražio **proveru da li su naše
fakture uopšte u skladu sa zakonom**, pa da se onda izmeni „na šta je logično".

Njegovo zapažanje: „na ino fakturi ne mora da piše virmanom, to nije ni zakonska obaveza; uvek
nam plaćaju virmanom jer smo veleprodaja."

Nalaz i predlog idu u [FAKTURE_ZAKONSKA_USKLADJENOST.md](FAKTURE_ZAKONSKA_USKLADJENOST.md).

---

## Još otvoreno (nije blokada za koračne izmene)

**🔴 Avansni račun se sudara sa avansima dobavljača.** Ulazni avansi dobavljača upisuju se u
**istu** tabelu `invoices`, sa istom vrstom `AVR` i **ručno kucanim** brojem
(`pdv/advance-vat.service.ts:531-588`). Pošto naš izlazni AVR sada izgleda `1/26` — tačno kao
broj koji srpski dobavljači kucaju — moguć je sudar: ili odbijemo legitiman dobavljačev
dokument, ili nam padne izdavanje avansa. Rešenje traži izmenu šeme (zasebna vrsta dokumenta
ili stvaran `companyId`) i **odluku vlasnika**.



Iz [STAMPA_FAKTURA_GAP.md](STAMPA_FAKTURA_GAP.md) §5 ostaju bez odgovora: mesto istovara
(pravilo ili šifarnik), kilaža i dimenzije (ručno ili obračun), špediter (tekst ili šifarnik),
devizni račun za valute osim EUR, `web::` sa dve dvotačke, naziv „Trgovinski sud", otpremnica
bez cena, prelom domaćeg računa preko jedne strane, i ko daje fajlove logotipa.

Do odgovora se prepisuje **doslovno sa donetih papira** — jer papir je jedini dokaz koji imamo.

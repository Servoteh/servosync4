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

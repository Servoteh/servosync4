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

## Još otvoreno (nije blokada za koračne izmene)

Iz [STAMPA_FAKTURA_GAP.md](STAMPA_FAKTURA_GAP.md) §5 ostaju bez odgovora: mesto istovara
(pravilo ili šifarnik), kilaža i dimenzije (ručno ili obračun), špediter (tekst ili šifarnik),
devizni račun za valute osim EUR, `web::` sa dve dvotačke, naziv „Trgovinski sud", otpremnica
bez cena, prelom domaćeg računa preko jedne strane, i ko daje fajlove logotipa.

Do odgovora se prepisuje **doslovno sa donetih papira** — jer papir je jedini dokaz koji imamo.

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

**Van zajedničkog niza ostaju** avansni račun (AVR), predračun (PROF), ponuda (PON) i revers
(REV) — za njih nemamo papir koji pokazuje šta BigBit radi, a avansi imaju i zaseban zakonski
niz. Svaka od njih uz svoj brojač nosi i **svoj prefiks** (O-F6 za avans, O-F7 za ostale):
razdvojen brojač bez prefiksa ne razdvaja ništa, jer dva nezavisna niza oba kreću od 1.

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

## O-F7 · Svaka vrsta van niza faktura nosi SVOJ prefiks (predračun, ponuda, revers)

Odluka O-F6 je razdvojila samo avansni račun. Sve ostalo što nije izlazna faktura —
predračun (`PROF`), ponuda (`PON`), revers (`REV`) — je i dalje dobijalo goli `1/26`, dakle
**isti tekst broja kao faktura**. Od 02.08.2026. i te vrste nose prefiks svoje serije:
`PROF-12/26`, `PON-5/26`, `REV-8/26`.

**Zašto to nije kozmetika (nalaz N11):** „ne knjiži se" ne znači „ne može da se sudari".

| | šta se meri | posledica golog broja |
|---|---|---|
| predračun | `createProforma` odmah dodeljuje broj → `PROF 1/26` i `IFR 1/26` postoje **istovremeno kod istog kupca** | kupac plaća **po predračunu** i u poziv na broj kuca `1/26`; predračuna u glavnoj knjizi **nema**, pa taj string tamo nosi FAKTURA — uplata zatvara pogrešan dokument |
| revers | `REV` je level-0 vrsta koju prepis (`carry-over`) sme da napravi, a knjiženje **nema filtar vrste** | proknjižen revers upisuje svoj `N/GG` u `ledger_entries`, gde se stavke grupišu **samo po broju** — netuje se sa fakturom istog broja |

**Zašto šifra vrste (`PROF-`), a ne jedno slovo (`P-`, `R-`):** prefiks je ujedno i oznaka
koju parser poziva na broj mora da prepozna u tuđem tekstu. Jedno slovo ispred cifara je u
pozivu na broj običan šum („P 657/25"), pa bi svaka nova jednoslovna serija pojela po jedan
oblik legitimnog poziva na fakturu. Kod `A-` je ta cena plaćena jednom i svesno (O-F6) — ne
umnožava se. Višeslovna šifra kao šum se praktično ne pojavljuje.

**Posledica:** vrste se od sada upisuju u JEDNU mapu `DOCUMENT_SERIES` u
`numbering.service.ts` (vrsta → prefiks; prazan prefiks = niz faktura), iz koje se izvode i
brojač i oblik broja — pa se to dvoje ne mogu razići. **Vrsta koju niko ne upiše u mapu ne
pada na goli broj**, nego dobija prefiks iz sopstvene šifre (`XYZ-1/26`): disjunktnost je
strukturna, a ne stvar pamćenja.

**Izlazne fakture ostaju nedirnute** — jedan zajednički niz, bez prefiksa (O-F1/O-F5).

⚠️ Menja se **pre prvih proba**, kao O-F1 i O-F6. Brane: „serije su međusobno disjunktne"
(spisak vrsta se nabraja **iz mape**, ne prepisuje) i „svaki IZDAT broj se kroz parser vraća
bez golog `N/GG`" (`reference-parser.util.spec.ts`) — nova serija dodata samo u numeraciji
obara drugi test, jer bi njen poziv na broj i dalje proizvodio goli broj fakture.

### Dopuna O-F7 (02.08.2026) — tri stvari koje odluka nije pokrivala

**1. PON i PROF u BigBitu DELE jedan niz — mi ih svesno razdvajamo.** U kodu je do sada
stajalo da za predračun i ponudu „nemamo papir koji pokazuje šta BigBit radi". **Papir postoji
i kaže suprotno:** `migration/BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md:113` — „`PON` i `PROF` dele niz
`NNNN-YY`" (`0938-24`, `0954-25`, `0407-25`). To je isti dokazni obrazac (isprepletani brojevi
preko vrsta) kojim je opravdan zajednički niz faktura u O-F5.

Isto traži i `docs/PLAN_UNOS_DOKUMENATA.md:1281` — grupa `OFFER` = PON + PROF + OTP, sa živim
BigBit brojačem profaktura **264** za 2026.

**Odluka za sada: brojač ostaje razdvojen** — ali ne zato što papira nema, nego zato što pitanje
postaje materijalno **tek pri seed-u brojača**, a seed još nije urađen (v. `PREOSTALE_FAZE.md`,
stavka S9). Dok oba niza kreću od nule, sudar je nemoguć u oba scenarija: `PROF-1/26` i `PON-1/26`
su različiti stringovi zbog prefiksa. Razlika se vidi tek kad se oba seed-uju sa 264 — tada bi
razdvojeni brojači izdali `PROF-265/26` **i** `PON-265/26`, a u BigBit knjizi je 265 jedan slot.

Nije promenjeno odmah iz dva razloga: grupisanje iz plana je i samo nedovršeno (`OTP` nije u
registru, grupe `ADVANCE` i `CREDIT` čekaju potvrdu vlasnika — §9, pitanja 15/16), i zajednički
brojač traži da `sequenceKeyFor` prestane da se izvodi isključivo iz prefiksa, pa ekvivalencija
„bez prefiksa ⇔ u nizu faktura" mora da preživi kao zaseban invariant. **Oboje se radi zajedno sa
seed-om, ne pre njega.**

**2. „Stari i novi broj se nikad ne sudaraju" važi za BAZU, ne za UPARIVANJE.** Uplata se ne
uparuje po celom stringu nego po **kandidatima** koje parser poziva na broj izvodi iz PNB-a — a
taj sloj je zatečeni BigBit broj **normalizovao u naš**. Izmereno nad stvarnim brojevima:
`0012-26` → `12/26`, `AVR-00001/2026` → `A-1/26`, `AR-00001/2025` → `1/25`, `IFG-00025/2025` →
`25/25`, `PON-00285/2026` → `PON-285/26`. Pošto BigBit i 4.0 rade paralelno do cutovera (april
2027), to je svakodnevna, a ne teorijska pojava. Brana: **vodeće nule i šifra vrste uz crticu su
potpis starog broja** — izveden kandidat ne sme da se izjednači sa našim novim brojem.

**3. Registar je od sada JEDAN izvor za oba sloja.** Parser poziva na broj **uvozi**
`DOCUMENT_SERIES` umesto da prepisuje prefikse (razišli su se čim je uveden fallback prefiks:
broj `XYZ-1/26` je postojao, a parser ga je razlagao na goli `1/26`). Uz to, fallback prefiks za
neupisanu vrstu se **proverava, ne izmišlja**: šifra mora biti 2–5 slova (oblik koji parser ume
da pročita) i ne sme se preklapati ni sa jednom registrovanom serijom — inače izdavanje broja
puca sa 422. Ranije je `seriesPrefixFor("A")` davao `A-` sa **drugim brojačem** (dva `A-1/26`),
a `AVR2-1/26` je parser čitao kao avansnu seriju.

---

## O-F8 · Matični broj u bloku „Preuzeo za prevoz" je UVEK NAŠ, nikad kupčev

**Odluka vlasnika (03.08.2026):** *„onaj MB je pogrešno pisan, treba naš MB 17400169, ovaj ne
od kupca"* — dakle mogućnost **A** iz ranije tabele: štampa se `17400169`.

**Nalaz koji je do odluke doveo (01.08.2026):** na fakturama za robu, u bloku sa NAŠIM podacima
uz potpis, BigBit štampa:

```
SERVOTEH doo
Dobanovci, Ugrinovačka 163
PIB: 101017443   MB: 20748346
```

PIB `101017443` **jeste naš**. Matični broj `20748346` **NIJE** — naš je `17400169`, što piše u
podnožju iste te fakture (`Matični broj: 17400169`, `Registarski broj: 01117400169`).

**Dokaz da je broj kupčev, a ne naš:** `20748346` na tom istom papiru stoji i u okviru KUPCA
(`HAP FLUID D.O.O. · PIB: 107136558 - MB: 20748346`). BigBit u naš potpisni blok upisuje
**matični broj kupca**.

**Koliko dugo traje:** greška je u samom obrascu, ne u podacima — dakle važi za svaku fakturu
za robu koja je ikad odštampana iz BigBita. Oba donesena primera (IFR 657/25 i IFGP 650/25)
je nose.

**Posledica u kodu:** nikakva — `domaca-roba.ts` je i pre odluke čitao
`companies.registration_number`. Ono što je odluka donela je **brana**: taj blok sme da čita
`ctx.issuer` i ništa drugo.

⚠️ **Ne „ispravljati nazad" na original.** Papir će se razlikovati od svih dosadašnjih faktura
— to je i cilj. Brane (`templates/domaca-roba.spec.ts`, „matični broj uz potpis je NAŠ"):

| brana | šta hvata |
|---|---|
| „kupčev se u tom bloku ne pojavljuje" | direktan povratak na `ctx.customer.registrationNumber` |
| „bez našeg MB red ostaje bez njega" | „rezervni" fallback na kupca kad firma nema MB |
| „izmena kupčevih identifikatora ne menja blok ni za jedan znak" | svako buduće vezivanje kupca u taj blok, ma kojim putem |

Isti nalaz stoji i u [FAKTURE_ZAKONSKA_USKLADJENOST.md](FAKTURE_ZAKONSKA_USKLADJENOST.md) (N6).

---

## O-F9 · Jedno ime firme svuda: `Servoteh d.o.o.`

**Odluka vlasnika (03.08.2026):** *„ime može Servoteh d.o.o."*

Na istom papiru su do sada stajala **dva oblika istog imena**: memorandum
`Servoteh d.o.o. Dobanovci`, potpisni blok `SERVOTEH doo`. Od sada je oblik jedan, iz
**jednog izvora** — `companies.company_name` — i nijedan šablon ga ne prepisuje, ne skraćuje
i ne diže na velika slova.

**Šta se konkretno promenilo:**

1. **U bazi ime nosi samo naziv** (`Servoteh d.o.o.`), bez grada. Mesto uz ime u gornjoj traci
   papira **dopisuje memorandum sam**, iz `companies.city`:
   `Servoteh d.o.o. Dobanovci  Ugrinovačka 163, 11272 Dobanovci  tel: …`
   Taj red ostaje doslovno kakav je bio — menja se samo odakle mu delovi dolaze.
   (Zaštita: ako zatečeni podatak već nosi grad u nazivu, memorandum ga ne dopisuje dvaput.)
2. **Uklonjeno rezervno ime iz koda.** `loadIssuer` i `loadLegacyIssuer` su vraćali
   `?? "Servoteh d.o.o."` kad firma nema red u `companies` — dakle papir je mogao da nosi ime
   koje u bazi ne postoji i koje se pri preimenovanju firme ne bi promenilo. Sada naziv u tom
   slučaju ostaje prazan, a blokovi ga **preskaču** (bez praznog reda koji pomera raspored),
   isto kao svaki drugi nepopunjen podatak.

**Zašto ovo nije kozmetika:** dva imena iste firme na jednom papiru su za kupca dve firme, a
za nas dva izvora istine — čim se firma preimenuje ili preseli, jedan od njih zaostane.

---

## O-F10 · Poštanski broj dobija svoju kolonu (`companies.postal_code`)

**Odluka vlasnika (03.08.2026):** grad i poštanski broj su **dva podatka**, i svako mesto
štampe bira šta mu treba.

`companies.city` je držao `11272 Dobanovci` kao jedan string, pa se poštanski broj provlačio i
tamo gde mu na papiru nije mesto. Izmereno nad donetim obrascima:

| blok | original (BigBit) | šta smo štampali dok je broj bio u `city` |
|---|---|---|
| memorandum strane | `Ugrinovačka 163, 11272 Dobanovci` | isto ✔ |
| potpisni blok „Preuzeo za prevoz" | `Dobanovci, Ugrinovačka 163` | `11272 Dobanovci, Ugrinovačka 163` ✘ |
| adresa magacina („Robu izdao") | `Ugrinovačka 163, Dobanovci` | `Ugrinovačka 163, 11272 Dobanovci` ✘ |

**Sprovedeno:**

- migracija `20260803090000_companies_postal_code` — kolona + **plašljiv** prenos podataka:
  hvata se isključivo oblik „5 cifara + razmak + ostatak", sve ostalo ostaje netaknuto
  (pogrešno rastavljeno mesto bi se štampalo na svakom papiru, a niko ga ne bi primetio);
- polje **Poštanski broj** na ekranu Podešavanja → Firma (kolona bez ekrana = podatak koji
  niko ne može da unese);
- jedan zajednički formatirač `common/company-address.ts` za sva mesta koja adresu spajaju
  (`Ugrinovačka 163, 11272 Dobanovci`) — deset štampi se inače raziđe u različite oblike;
- blokovi kojima broj **ne treba** (potpisni blok, adresa magacina) spajaju `address` i `city`
  direktno; zato u formatirač i nije dodata funkcija „adresa bez poštanskog broja" — izbor bi
  se sveo na to koje ime neko otkuca, umesto na ono što papir traži;
- e-faktura: poštanski broj sada ide u `cbc:PostalZone` (BT-38). Dok je bio deo mesta, odlazio
  je na SEF kao deo `cbc:CityName` — dakle u pogrešnom elementu.

⚠️ **Migracija je bez PL/pgSQL bloka i bez ijednog `IF EXISTS … AND …` nad samom kolonom.**
Dan ranije je takav uslov (`20260802120000_datum_prometa_znacenje`) oborio SVE backend deploy-e
sa `42703`: PL/pgSQL ceo `IF` sprema kao jedan upit, pa nema kratkog spoja. `ADD COLUMN IF NOT
EXISTS` je idempotentan sam po sebi, a `UPDATE` ide posle njega — kada kolona sigurno postoji.

---

## 🔴 ČEKA · Način plaćanja na ino fakturi → prvo provera zakona

Umesto da se doda drugo polje (prvobitni predlog), vlasnik je tražio **proveru da li su naše
fakture uopšte u skladu sa zakonom**, pa da se onda izmeni „na šta je logično".

Njegovo zapažanje: „na ino fakturi ne mora da piše virmanom, to nije ni zakonska obaveza; uvek
nam plaćaju virmanom jer smo veleprodaja."

Nalaz i predlog idu u [FAKTURE_ZAKONSKA_USKLADJENOST.md](FAKTURE_ZAKONSKA_USKLADJENOST.md).

---

## Još otvoreno (nije blokada za koračne izmene)

~~**🔴 Avansni račun se sudara sa avansima dobavljača.**~~ **ZATVORENO 02.08.2026** — to je
upravo odluka O-F6 iznad i ona je **sprovedena u kodu**: `numbering.service.ts` daje avansnom
računu sopstvenu seriju `A-1/26` (razdvojen brojač **i** prefiks u samom broju). Izmena šeme
nije bila potrebna — prefiks razdvaja naš avans i od dobavljačevog avansa u istoj tabeli i od
fakture u istoj otvorenoj stavci.

**Zašto prefiks, a ne vrsta dokumenta u grupnom ključu saldakonta:** `ledger_entries` **nema**
kolonu vrste dokumenta, a i da je dobije, vrsta u ključu bi raskinula **netiranje** — uplata sa
izvoda, ručna korekcija knjigovođe i uvezeni BigBit red nose broj dokumenta ali ne i vrstu, pa
bi faktura i njena uplata pale u dve grupe i kamata bi se opet računala na već plaćeni deo
fakture (raniji nalaz VISOK). Razdvajanje serija je zato posao **numeracije**. Brane su testovi
„serije su međusobno disjunktne" (`numbering.service.spec.ts`) i „uplata bez vrste i dalje
umanjuje osnovicu" (`kamata.service.spec.ts`).



Iz [STAMPA_FAKTURA_GAP.md](STAMPA_FAKTURA_GAP.md) §5 ostaju bez odgovora: mesto istovara
(pravilo ili šifarnik), kilaža i dimenzije (ručno ili obračun), špediter (tekst ili šifarnik),
devizni račun za valute osim EUR, `web::` sa dve dvotačke, naziv „Trgovinski sud", otpremnica
bez cena, prelom domaćeg računa preko jedne strane, i ko daje fajlove logotipa.

Do odgovora se prepisuje **doslovno sa donetih papira** — jer papir je jedini dokaz koji imamo.

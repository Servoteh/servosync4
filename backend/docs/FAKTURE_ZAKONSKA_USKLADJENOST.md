# Izlazne fakture — provera zakonske usklađenosti

**Traženo:** vlasnik je izričito tražio proveru da li su izlazne fakture u skladu sa zakonom.
**Datum analize:** 02.08.2026. · **Grana:** `feat/4.0-stampa-faktura` · **Kod nije menjan.**

---

## 0. Kako čitati ovaj dokument (obavezno pre §1)

Ovo **nije pravno mišljenje**. Napisao ga je AI asistent koji nije pravnik i čije znanje o
propisima ima datum preseka. Zato je svaka tvrdnja označena:

| oznaka | značenje |
|---|---|
| 🟢 **PROVERENO** | pročitano u kodu ovog repoa ili na donetim BigBit papirima. Ovo se može verifikovati odmah, otvaranjem navedenog fajla i reda. |
| 🟡 **ZNANJE O PROPISU** | opšte poznata pravila, navedena bez brojeva stavova gde nisam siguran. Nije provereno u važećem tekstu zakona. |
| 🔴 **ZA POTVRDU KNJIGOVOĐI** | ne znam, ili znam nesigurno. Ne postupati po ovome dok knjigovođa ne potvrdi. |

**Brojeve članova namerno ne izmišljam.** Gde ih navodim, to je zato što ih **naš sopstveni kod
ili doneti papir već štampa** — pa je predmet provere baš to da li su tačni, a ne moja tvrdnja
da jesu.

**Šta je konkretno pregledano** (🟢):

- `backend/docs/STAMPA_IZLAZNIH_FAKTURA.md` — opis pet donetih BigBit izlaza
- `docs/zahtevi/fakture-obrasci-2026-08/IFR.pdf` i `InoFaktura GP 228-25.pdf` — pročitani kao slike
  (ostala tri kroz opis u dokumentu gore)
- `backend/src/modules/sales/print/templates/{domaca-roba,domaca-usluga,ino-roba,ino-usluga}.ts`
- `backend/src/modules/sales/print/{memorandum,format,invoice-pdf.service}.ts`
- `backend/src/modules/sales/sef/{ubl-builder.service,sef.service}.ts`
- `backend/prisma/schema.prisma` (model `Invoice`) i `backend/src/modules/sales/fakturisanje.service.ts`

---

## 1. Obavezni elementi računa

### 1.1 Šta zakon traži

🟡 Član 42 Zakona o PDV propisuje šta račun mora da sadrži. Po sećanju, to su:

1. naziv, adresa i **PIB izdavaoca**
2. **mesto i datum izdavanja** i **redni broj** računa
3. naziv, adresa i **PIB primaoca**
4. **vrsta i količina** isporučenih dobara / vrsta i **obim usluga**
5. **datum prometa** dobara i usluga i **visina avansnih plaćanja**
6. **iznos osnovice**
7. **poreska stopa** koja se primenjuje
8. **iznos PDV-a** obračunat na osnovicu
9. **napomena o odredbi zakona po kojoj PDV nije obračunat** (kad nije obračunat)
10. napomena da se primenjuje sistem naplate (samo za obveznike po naplaćenoj naknadi)

🔴 **ZA POTVRDU KNJIGOVOĐI:** tačan i važeći spisak, njegova numeracija i posebna pravila za
avansni račun i za račun u stranoj valuti. Spisak gore koristim kao radnu listu, ne kao citat.

### 1.2 Tabela — element po element, obrazac po obrazac

Legenda: ✅ štampa se · ⚠️ štampa se uslovno / nepotpuno · ❌ ne štampa se ·
**(prazno)** = polje u modelu postoji, ali ga niko ne popunjava, pa u praksi izlazi prazno.

| element | traži zakon | domaća roba (IFR/IFGP) | domaća usluga (IFUSL) | ino roba (IZVRO/IZVGP) | ino usluga (IZVUS) |
|---|---|---|---|---|---|
| Naziv i adresa izdavaoca | da | ✅ `memorandum.ts:116-124` | ✅ isto | ✅ isto | ✅ isto |
| **PIB izdavaoca** | da | ✅ `memorandum.ts:198` (podnožje svake strane) + `domaca-roba.ts:509` | ✅ `memorandum.ts:198` | ✅ `memorandum.ts:198` | ✅ `memorandum.ts:198` |
| Naziv i adresa primaoca | da | ✅ `domaca-roba.ts:187-198` | ✅ `domaca-usluga.ts:195-209` | ✅ `ino-roba.ts:130-131` | ✅ `ino-usluga.ts:261-262` |
| **PIB primaoca** | da (kad je obveznik) | ✅ `domaca-roba.ts:181` | ✅ `domaca-usluga.ts:206` | ❌ (strani kupac ga nema — v. §3.4) | ❌ (isto) |
| **Mesto izdavanja** | da | ⚠️ `domaca-roba.ts:223` — samo ako je `companies.invoice_issuing_place` popunjen | ⚠️ `domaca-usluga.ts:219` — red se **briše** ako je prazan (`:255`) | ❌ **nema ga uopšte** | ⚠️ `ino-usluga.ts:239-243` — zalepljen u red `Date of delivery:`, nije zaseban podatak |
| **Datum izdavanja** | da | ✅ `domaca-roba.ts:209` | ✅ `domaca-usluga.ts:218` | ✅ `ino-roba.ts:129` | ✅ `ino-usluga.ts:260` |
| **Redni broj računa** | da | ✅ `domaca-roba.ts:203` | ✅ `domaca-usluga.ts:245-253` | ✅ `ino-roba.ts:99` | ✅ `ino-usluga.ts:250` |
| Vrsta i količina dobara / obim usluge | da | ✅ `domaca-roba.ts:340-342` | ✅ `domaca-usluga.ts:326-328` | ✅ `ino-roba.ts:184-188` | ✅ `ino-usluga.ts:327-329` |
| **Datum prometa** | da | ⚠️ **(prazno)** `domaca-roba.ts:270` | ⚠️ **(prazno)** — red se briše, `domaca-usluga.ts:221` + `:255` | ❌ **nema ga uopšte** | ⚠️ **(prazno)** `ino-usluga.ts:241` |
| **Visina avansnih plaćanja** | da | ❌ **namerno izostavljeno** `domaca-roba.ts:28-30` | ✅ `domaca-usluga.ts:407-416` | ❌ | ❌ |
| Iznos osnovice | da | ✅ `domaca-roba.ts:421` | ✅ `domaca-usluga.ts:392` | ✅ `ino-roba.ts:269` (`TOTAL`) | ✅ `ino-usluga.ts:387` (`TOTAL`) |
| Poreska stopa | da | ✅ `domaca-roba.ts:335, 426` | ✅ `domaca-usluga.ts:321, 396-402` | n/p (oslobođeno) | n/p (oslobođeno) |
| Iznos PDV-a | da | ✅ `domaca-roba.ts:424-429` | ✅ `domaca-usluga.ts:396-402` | n/p | n/p |
| **Napomena o oslobođenju** | da, kad PDV nije obračunat | 🔴 **tvrdo ukucano „NEMA"** `domaca-roba.ts:58` | 🔴 **tvrdo ukucano „NEMA"** `domaca-usluga.ts:46` | 🔴 tvrdo ukucan član `ino-roba.ts:30-31` | 🔴 tvrdo ukucan član `ino-usluga.ts:101-102` |
| Napomena „sistem naplate" | samo za taj režim | ❌ | ❌ | ❌ | ❌ |

### 1.3 Nalazi iz tabele

**N1 · Datum prometa se u praksi ne štampa ni na jednoj fakturi.** 🟢
Polje `Invoice.deliveryDate` postoji u šemi (`schema.prisma:3947`) i sva tri obrasca koja ga
prikazuju čitaju baš njega. Ali **nijedna ruta ga ne upisuje**: pretraga celog `backend/src`
nalazi samo čitanja u šablonima, nijedan upis. `CreateProformaDto`
(`dto/create-proforma.dto.ts:22-35`) ga nema, `fakturisanje.service.ts:186-208` ga ne postavlja,
a PATCH rute za fakture ne postoje. Znači: polje je uvek `null` → traka uslova na robnoj fakturi
ima praznu ćeliju, uslužna faktura red **potpuno izostavlja**, a ino usluga odštampa
`Date of delivery:  Beograd` (mesto bez datuma, jer `join` preskače praznu vrednost).
Ovo je najozbiljniji nalaz u dokumentu: **obavezan element računa strukturno nedostaje.**

> ⚠️ **Dopuna 02.08.2026 (posle spajanja sa `main`):** polje se danas zove
> **`Invoice.supplyDate` / kolona `supply_date`**, ne `deliveryDate`. Nalaz je u
> međuvremenu i ispravljen — datum prometa se unosi (`CreateProformaDto.supplyDate`),
> podrazumeva pri knjiženju uz WARN, prenosi sa predračuna na račun, štampa na sva četiri
> obrasca i šalje u UBL. Ostatak teksta N1 je zatečeno stanje pre ispravke i ostaje kao
> zapis nalaza.

**N2 · Ino robna faktura nema ni datum prometa ni mesto izdavanja.** 🟢
`ino-roba.ts:129-136` štampa samo `Date`, `Customer`, `Address`, `Delivery term`,
`Payment terms`. Provereno i na originalu `InoFaktura GP 228-25.pdf` — ni tamo ih nema.
Dakle to **nije naša regresija, nego nasleđeni nedostatak BigBit obrasca** koji smo verno
prepisali. 🔴 Da li izvozna faktura mora da nosi te elemente — za potvrdu (v. §3).

**N3 · „Napomena o poreskom oslobodjenju: NEMA" je konstanta, ne podatak.** 🟢
Na oba domaća obrasca taj tekst je tvrdo ukucan (`domaca-roba.ts:58`, `domaca-usluga.ts:46`) i
štampa se **uvek**, bez obzira na sadržaj računa. Istovremeno, naš SEF builder zna za domaći
promet bez PDV-a: `ubl-builder.service.ts:80-83` mapira stopu 0% na kategoriju **E** i šalje
razlog `"Promet oslobodjen PDV"` (`:51`, uz `TODO` da tačan osnov tek treba definisati).
Znači sistem **već predviđa** slučaj u kome PDV nije obračunat na domaćem prometu — a papir bi
u tom istom slučaju tvrdio da oslobođenja „NEMA". 🟡 To je upravo element pod tačkom 9 iz §1.1;
netačna napomena je poreski, ne kozmetički problem.

**N4 · Avans se odbija na uslužnoj, a ne odbija na robnoj fakturi.** 🟢
`domaca-usluga.ts:407-416` prikazuje red „Umanjenje za primljeni avans" i umanjuje iznos za
uplatu. `domaca-roba.ts:28-30` to **namerno ne radi** („doneti obrasci ga nemaju"), pa
`domaca-roba.ts:440` štampa `Za uplatu` = pun `grossTotal`. Posledica: za identičnu poslovnu
situaciju kupac dobija **dva različita iznosa za uplatu** zavisno od toga da li mu je prodata
roba ili usluga — a na robnoj fakturi nedostaje i obavezan podatak „visina avansnih plaćanja".
Odluka da se prati doneti papir ovde vodi u pogrešan iznos.

**N5 · Avansni račun (AVR) nema svoj obrazac.** 🟢
`invoice-pdf.service.ts:109-114` svrstava `AVR` u `FORMLESS_DOCUMENT_TYPES` → štampa se na
najbližem obrascu (domaća/ino roba) uz upozorenje u logu. 🟡 Avansni račun ima sopstvena
pravila sadržaja (osnov = primljena uplata, PDV iz preračunate stope). 🔴 Šta tačno avansni
račun mora da sadrži i kako izgleda njegov obrazac — za potvrdu + treba doneti papir.

**N6 · Matični broj u potpisnom bloku originala je tuđi.** 🟢
Na `IFR.pdf`, u koloni „Preuzeo za prevoz", piše `PIB: 101017443 MB: 20748346`. PIB je
Servotehov, ali `20748346` je **matični broj kupca HAP FLUID D.O.O.** (isti broj stoji gore u
okviru kupca), dok podnožje istog papira nosi Servotehov `Matični broj: 17400169`. Dakle
**BigBit je tu štampao pogrešan MB**. Naš kod uzima oba podatka sa izdavaoca
(`domaca-roba.ts:507-513`), pa ispravno štampa 17400169. ⚠️ **Ovo se ne sme „ispraviti nazad"
na original.** Vredi upisati u `STAMPA_IZLAZNIH_FAKTURA.md` da razlika prema papiru na tom
mestu nije naša greška.

---

## 2. Šta štampamo, a nije obavezno (i sme li da se izbaci)

### 2.1 „Način plaćanja: virmanom" — vlasnikova tvrdnja

**Tvrdnja:** „virmanom" na ino fakturi nije zakonska obaveza i suvišno je, jer u veleprodaji
uvek plaćaju virmanom.

**Provera:**

- 🟡 **Način plaćanja nije među obaveznim elementima računa iz člana 42.** Utoliko je vlasnik
  u pravu: izostavljanje tog reda ne čini račun neispravnim po Zakonu o PDV.
- 🟢 **Na ino robnoj fakturi taj podatak se danas štampa DVA PUTA, iz istog polja.**
  `ino-roba.ts:136` štampa `Payment terms: <invoice.paymentMethod>`, a `ino-roba.ts:314-320`
  štampa `Način plaćanja: <invoice.paymentMethod>` — isto polje, ista vrednost, dva mesta,
  jedno od njih na srpskom usred engleskog dokumenta. To je suvišno **bez obzira na zakon**.
- 🟢 **Ali original nosi DVE RAZLIČITE vrednosti:** na `InoFaktura GP 228-25.pdf` gore piše
  `Payment terms: virmanom`, a dole `Način plaćanja: avansno`. To nisu isti podatak — jedan je
  *kako* se plaća, drugi je *pod kojim uslovom* (avansno / po isporuci / 30 dana). Model 4.0
  ima samo jedno polje `Invoice.paymentMethod` (`schema.prisma`, komentar u `ino-roba.ts:298-302`
  to izričito priznaje kao otvoreno pitanje).
- 🔴 **ZA POTVRDU:** da li banka (priliv iz inostranstva) ili špediter/carina traže da faktura
  koja prati izvoz nosi uslov plaćanja. Ovo je jedini razlog zbog kog bih se ustezao da red
  jednostavno obrišem, i ne znam odgovor.

**Zaključak:** ✅ **sme da se izostavi** sa stanovišta Zakona o PDV. Preporuka nije „obriši
oba reda" nego: **ostavi jedan red, i to onaj koji nosi uslov plaćanja („avansno", „30 dana"),
a štampaj ga samo kad je popunjen.** Vrednost „virmanom" na veleprodajnoj fakturi zaista ne
govori ništa novom čitaocu; vrednost „avansno" govori.

### 2.2 Ostalo što štampamo bez zakonske obaveze

| šta | gde | obavezno? | preporuka |
|---|---|---|---|
| `Tekući račun: 160-110610-83` | `domaca-roba.ts:162-174`, `domaca-usluga.ts:170-182` | 🟡 nije u čl. 42 | **zadržati** — bez broja računa kupac ne može da plati |
| `Roba je FCO`, `Način otpreme robe` | `domaca-roba.ts:265-301` | 🟡 nije u čl. 42 | 🟢 oba polja su danas **uvek prazna** (nema ih u DTO-u ni u servisu) → štampa se prazan okvir. Ili popuniti, ili izbaciti kolone; prazan okvir na poreskom dokumentu izgleda kao propušten podatak |
| Četiri potpisne linije | `domaca-roba.ts:499-540` | 🟡 nije obavezno (v. §4) | **zadržati na robi** — nisu potpis računa nego dokaz o izvršenoj isporuci |
| `Broj l.k.:_____` | `domaca-roba.ts:71, 520` | ne | 🟡 traženje broja lične karte bez pravnog osnova je problem zaštite podataka. Odluka O-F3 je već izbacila **upis** tog broja, ali je **prazna linija sa natpisom ostala** — dosledno bi bilo izbaciti i natpis (ili ga zameniti sa „Potpis primaoca") |
| `Matični broj`, `Registarski broj`, `Šifra delatnosti`, APR rečenica | `memorandum.ts:189-207` | 🟡 **nije** po Zakonu o PDV, **ali jeste** po Zakonu o privrednim društvima (poslovna pisma i dokumenti upućeni trećim licima nose poslovno ime, sedište, MB i PIB, i podatak o registraciji) | **ne dirati.** 🔴 Tačan obim tog spiska — za potvrdu |
| Reklamacije / nadležni sud / zatezna kamata | `domaca-roba.ts:59-61`, `domaca-usluga.ts:47-49`, `ino-roba.ts:41-45`, `ino-usluga.ts:105-106` | ne — ugovorni tekst | 🟡 jednostrano odštampana klauzula o nadležnosti suda po pravilu ne obavezuje kupca sam po sebi. Zadržati ili ne — poslovna odluka. **Ali:** „Trgovinski sud u Beogradu" ne postoji od preimenovanja u privredne sudove; klauzula koja imenuje nepostojeći sud je u najboljem slučaju traljava |
| Partnerski logotipi, QR „google mapa" | `memorandum.ts:231-242` | ne — marketing | zadržati |
| **`ISO 9001:2008` znak** | slika `TUV_ISO_LOGO_DATA_URL`, `memorandum.ts:141` | ne | 🟡 **ISO 9001:2008 je povučena verzija standarda** (zamenjena verzijom iz 2015). Znak koji na svakoj fakturi tvrdi važeći sertifikat po povučenoj verziji je netačna tvrdnja prema kupcu. 🔴 Proveriti kod odgovornog za QMS koji sertifikat je danas na snazi i osvežiti sliku |

---

## 3. Izvoz — oslobođenja i SEF

### 3.1 Tri različita člana za istu stvar — u našem sopstvenom kodu

🟢 Ovo je provereno i nesporno:

| gde | tekst koji izlazi | fajl:linija |
|---|---|---|
| ino **roba**, papir | „Oslobodjeno PDV na osnovu **člana 24. stav 1 tačka 2** Zakona o PDV." | `ino-roba.ts:30-31` |
| ino **usluga**, papir | „Oslobodjeno PDV-a na osnovu **člana 24. stav 2** Zakona o pdv." | `ino-usluga.ts:101-102` |
| **SEF / UBL** | šifra `PDV-RS-24-1-5`, tekst „Izvoz dobara (**čl. 24 st. 1 tač. 5** ZPDV)" | `ubl-builder.service.ts:43-44` |

Dakle za izvoz robe naš papir kaže **tačka 2**, a naš XML kaže **tačka 5**. Bar jedno od to
dvoje nije tačno. Papirni tekst je doslovno prepisan sa stvarnog BigBit izlaza
(`InoFaktura GP 228-25.pdf`, provereno na slici), a XML tekst je neko upisao u kod.

🔴 **ZA POTVRDU KNJIGOVOĐI — koji je tačan osnov za:** (a) izvoz robe koju mi otpremamo,
(b) izvoz robe koju kupac sam odvozi, (c) uslugu stranom naručiocu. **Ne navodim svoj predlog
broja člana** — nemam pouzdano znanje, a pogrešan član na izvoznoj fakturi je poreski problem.

### 3.2 Usluga stranom kupcu — sumnjam da je uopšte „oslobođenje"

🟡 Za usluge stranom privrednom subjektu, po opštem pravilu o **mestu prometa usluga**, promet
se smatra izvršenim tamo gde je primalac — dakle **u inostranstvu**. Tada promet nije predmet
oporezivanja srpskim PDV-om, i napomena na računu treba da glasi da PDV **nije obračunat jer
mesto prometa nije u Srbiji**, a ne da je promet „oslobođen po članu 24". To su dva različita
poreska tretmana i različito se iskazuju u poreskoj prijavi.

🟢 Naš obrazac za ino uslugu danas štampa oslobođenje po članu 24
(`ino-usluga.ts:101-102`), a naš primer 060/26 je usluga uz koju ide i pošiljka (paleta,
bruto/neto kilaža, mesto istovara, špediter) — pa nije očigledno ni šta je tu promet.

🔴 **ZA POTVRDU KNJIGOVOĐI, prioritet:** kako se poreski tretira konkretno ono što Servoteh
fakturiše kao „ino usluga" i koja tačno napomena mora da stoji na tom računu. Ovo je,
po mojoj proceni, **najverovatnija stvarna greška** u celom kompletu — ali je iznosim kao
sumnju, ne kao tvrdnju.

### 3.3 Napomena mora da postane podatak, a ne konstanta u šablonu

🟢 Danas je osnov oslobođenja **tvrdo ukucan u svaki od četiri šablona**. To znači:

- domaći promet ne može da nosi nikakvu napomenu osim „NEMA";
- izvoz robe uvek nosi isti član, bez obzira ko otprema robu;
- izmena osnova traži izmenu koda i deploy;
- papir i SEF XML mogu da kažu različito (i danas kažu — §3.1).

Ispravno je da osnov oslobođenja bude **polje na fakturi**, birano iz šifarnika pravnih osnova,
i da **isti taj podatak** puni i štampu i UBL `cbc:TaxExemptionReason` / `TaxExemptionReasonCode`.
Ovo je jedina preporuka u dokumentu koju mogu da dam **bez ijednog broja člana** — i zato je
najsigurnija.

### 3.4 Ide li izvozna faktura na SEF

🟢 **Ne ide** — naš kod je izričito odbija: `sef.service.ts:80-84` baca
`BadRequestException("Izvozna faktura ne ide na domaći SEF")` za svaki `Invoice.isExport = true`.

🟡 To odgovara logici Zakona o elektronskom fakturisanju: obaveza e-fakture postoji između
subjekata javnog i privatnog sektora **u Srbiji**; strani kupac nije takav subjekt.

**Šta to znači za štampu — a važno je:** kod domaćeg B2B prometa papir je samo kopija (§4.2),
ali kod izvoza **PDF/papir jeste jedini račun**. Nema SEF-a da „nosi" podatke koje papir ne
štampa. Zato nedostaci iz N2 (nema datuma prometa, nema mesta izdavanja na ino robnoj fakturi)
tamo bole više nego na domaćem računu, ne manje.

🟢 Uz to: polje za broj izvozne deklaracije (`Invoice.customsDeclarationNo`, `schema.prisma:3951`)
postoji i šablon ga štampa (`ino-roba.ts:309`), ali ga — kao ni datum prometa — **nijedna ruta
ne popunjava**.

🔴 **ZA POTVRDU KNJIGOVOĐI:** da li za izvozni promet (i uopšte za promet licima koja nisu
subjekti e-fakturisanja) postoji obaveza **elektronskog evidentiranja obračuna PDV na SEF-u**
(zbirna/pojedinačna evidencija). 🟢 Pretraga koda: takav tok kod nas **ne postoji nigde** —
ako je obaveza, to je rupa koja nije u štampi nego u modulu PDV-a.

---

## 4. E-faktura (SEF) i šta je uopšte „dokument"

### 4.1 Od kada je obavezna

🟡 Po Zakonu o elektronskom fakturisanju, redosled je bio: od **1. maja 2022.** izdavanje
prema javnom sektoru (B2G) i prijem u javnom sektoru; od **1. jula 2022.** izdavanje iz javnog
sektora i obaveza prijema u privatnom; od **1. januara 2023.** puna obaveza **izdavanja i
prijema e-faktura između subjekata privatnog sektora (B2B)**. Za ove datume sam relativno
siguran. 🔴 Kasnije izmene zakona (uključujući elektronsko evidentiranje prethodnog poreza) —
za potvrdu, tu mi znanje nije pouzdano.

### 4.2 Šta to znači za štampani PDF

🟡 Za domaći B2B promet **e-faktura na SEF-u JESTE račun**. Odštampani PDF nije poreski
dokument nego **kopija/pratilac** — poslati kupcu samo PDF mejlom ne ispunjava obavezu.

Praktična posledica za nas, i ona je važnija od same konstatacije:
**papir i XML moraju da govore isto.** Svaka razlika između njih je razlika između kopije i
originala na poreskom dokumentu. Danas ih imamo najmanje četiri (§4.3).

### 4.3 Nosi li naš UBL sve obavezne elemente — 🟢 provereno čitanjem buildera

| element | stanje u `ubl-builder.service.ts` |
|---|---|
| CustomizationID / ProfileID | ✅ `:199-200` |
| Broj, datum izdavanja, valuta, tip (380/386) | ✅ `:201-206` |
| **Datum prometa** (`cac:Delivery/cbc:ActualDeliveryDate`) | ❌ **ne postoji nigde u builderu.** Sama šema to priznaje: komentar uz `deliveryDate` (`schema.prisma:3944-3947`) kaže „Isti podatak puni i UBL `cbc:ActualDeliveryDate`, **koji SEF-u danas nedostaje**" |
| Prodavac: naziv, adresa, PIB, MB | ✅ `:306-329` |
| Kupac: naziv, adresa, PIB, MB, JBKJS | ✅ `:331-361` |
| **Država kupca** | ⚠️ `:369` tvrdo ukucano `RS` za **obe** strane, iako `Customer.country` postoji i štampa se na ino usluzi |
| PDV rekapitulacija po stopama | ✅ `:255-283`, grupisanje `:472-491` |
| Osnov oslobođenja za domaću 0% kategoriju (E) | ⚠️ `:51` privremeni tekst „Promet oslobodjen PDV", **bez šifre**, sa `TODO` u kodu (`:395-397`, `:444-446`) |
| Zbirni iznosi, avans (`PrepaidAmount`) | ✅ `:286-293` |
| **Jedinica mere stavke** | ⚠️ `:416` tvrdo ukucano `unitCode="H87"` (komad) za **svaku** stavku — dok papir štampa stvarnu j.m. (`kom`, `m`, `kg`…). Papir i XML se razilaze na svakoj stavci koja nije komad |
| `cac:PaymentMeans` (račun za uplatu, model i poziv na broj) | ❌ nema. 🟡 nije element iz čl. 42, ali kupac po e-fakturi plaća — 🔴 da li SEF/CIUS to traži, za potvrdu |
| `cbc:BuyerReference` | ❌ nema; `cac:OrderReference` se šalje samo kad je `poNumber` unet (`:212-217`). 🔴 Profil koji deklarišemo (`:41`, Peppol billing 3.0) po mom sećanju traži **jedno od to dvoje** — ako je tako, faktura bez narudžbenice može biti odbijena. Za potvrdu na SEF demo okruženju |
| PDV u dinarima kod fakture u stranoj valuti | ❌ nema `TaxCurrencyCode` ni PDV u RSD. Danas nije problem (izvoz ne ide na SEF), ali 🟢 `domaca-roba.ts:400` i `:436` podržavaju domaći račun u stranoj valuti (`Za uplatu (EUR)`) — čim se takav račun izda, XML nema dinarski PDV, a papir nema ni kurs |

**Sitniji nalaz** 🟢: PDF čita datume lokalnim geterima (`format.ts:83-91`), a UBL ih pretvara
u UTC (`ubl-builder.service.ts:514-516`), pri čemu su kolone `timestamptz`, a ne `date`
(`schema.prisma:3869`) — suprotno onome što tvrdi komentar u `format.ts:79-82`. Kontejner nema
podešen `TZ` (provereno u `backend/Dockerfile`), pa oba danas rade u UTC i slažu se. Ako se
ikad postavi `TZ=Europe/Belgrade`, račun kreiran između ponoći i 1–2 h dobiće **različit datum
na papiru i u SEF-u**. Verovatnoća mala, cena greške velika, ispravka trivijalna.

---

## 5. Potpis i pečat

### 5.1 Da li su obavezni

- 🟡 **Pečat: nije obavezan.** Obaveza upotrebe pečata u poslovnim pismima i dokumentima
  ukinuta je izmenama Zakona o privrednim društvima (koliko se sećam, primena od oktobra 2018),
  i punovažnost dokumenta se ne sme uslovljavati pečatom. Ovim sam prilično siguran, ali 🔴
  potvrditi.
- 🟡 **Svojeručni potpis: nije uslov punovažnosti računa.** Račun sastavljen u elektronskom
  obliku (a naš PDF to jeste — generiše ga program) umesto potpisa može nositi identifikaciju
  odgovornog lica. Umerena sigurnost. 🔴 Potvrditi tačnu formulaciju iz Zakona o računovodstvu.
- 🟡 **E-faktura na SEF-u ne traži elektronski potpis/pečat** — smatra se verodostojnom bez
  njega. Umerena sigurnost. 🔴 Potvrditi.

⚠️ Napomena uz `STAMPA_FAKTURA_ODLUKE.md` (odluka O-F3): tamo stoji rečenica „Račun je punovažan
sa imenom i pečatom". Zaključak odluke (ne štampati broj lične karte) je dobar, ali obrazloženje
ne treba čitati kao da je **pečat uslov punovažnosti** — nije.

### 5.2 Naše četiri potpisne linije — ne dirati ih

🟢 `domaca-roba.ts:499-540` štampa četiri kolone: `Robu primio`, `Preuzeo za prevoz`,
`Robu izdao`, `Odgovorno lice`. Ino roba nema nijednu (`ino-roba.ts:396-398`), ino usluga
takođe nema, uslužna domaća ima samo `Odgovorno lice` (`domaca-usluga.ts:438-471`).

Bitno razlikovanje: **prve tri kolone nisu „potpis računa" nego dokaz o izvršenoj isporuci.**
Račun ih ne traži, ali:

- kod spora oko isporuke potpis primaoca je jedini dokaz;
- 🟡 kod izvoznog oslobođenja poreska po pravilu traži dokaz da je roba stvarno otišla.

**Preporuka: zadržati ih na robnoj fakturi.** Nisu zakonska obaveza računa, ali su korisna
evidencija — i ništa ne košta. Ono što bi trebalo skinuti je natpis `Broj l.k.:_____` (§2.2).

---

## 6. Predlog izmena, po važnosti

### 6.1 MORA — bez ovoga račun ne stoji

| # | šta | zašto | gde |
|---|---|---|---|
| **M1** | **Uvesti unos datuma prometa** i učiniti ga obaveznim pre knjiženja fakture; odštampati ga na **sva četiri** obrasca i poslati ga u UBL kao `cac:Delivery/cbc:ActualDeliveryDate` | obavezan element računa koji danas **strukturno nedostaje** (N1) | DTO + `fakturisanje.service.ts`; `ino-roba.ts` (dodati red); `ubl-builder.service.ts` |
| **M2** | **Napomena o oslobođenju → podatak, ne konstanta.** Polje na fakturi + šifarnik osnova; isti podatak puni papir i SEF | „NEMA" se danas štampa i kad promet jeste oslobođen (N3); papir i XML se već razilaze (§3.1) | sva četiri šablona + `ubl-builder.service.ts:43-51` |
| **M3** | **Presuditi tačan osnov oslobođenja** za izvoz robe i za ino uslugu, pa uskladiti papir i XML na jedan tekst | tri različita člana u našem kodu za istu stvar; ino usluga možda uopšte nije „oslobođenje" nego promet van Srbije (§3.1, §3.2) | odluka knjigovođe → pa kod |
| **M4** | **Odbiti avans i na robnoj fakturi** (ili svesno odlučiti suprotno i za uslugu) | isti posao daje dva različita iznosa „za uplatu"; nedostaje obavezan podatak o avansu (N4) | `domaca-roba.ts:394-464` |
| **M5** | **Mesto izdavanja na ino robnoj fakturi**; na ino usluzi ga odvojiti od `Date of delivery` | obavezan element; na izvoznoj fakturi papir je jedini dokument (§3.4) | `ino-roba.ts:114-143`, `ino-usluga.ts:239-243` |
| **M6** | **Popraviti `TODO` za domaće oslobođenje u UBL-u** pre nego što se izda prva domaća faktura sa 0% | danas na SEF ide privremeni tekst bez šifre osnova | `ubl-builder.service.ts:51, 395-397, 444-446` |
| **M7** | **Doneti obrazac za avansni račun (AVR)** i vezati ga u `FORM_BY_DOCUMENT_TYPE` | AVR se danas štampa na robnom papiru (N5) | `invoice-pdf.service.ts:90-114` |
| **M8** | **Prava jedinica mere u UBL-u** umesto tvrdog `H87` | papir i e-faktura iskazuju različitu j.m. na istoj stavci | `ubl-builder.service.ts:416` |

### 6.2 MOŽE — poboljšanja, nisu prepreka

| # | šta | napomena |
|---|---|---|
| **P1** | Skloniti dupli „Način plaćanja" sa ino robne fakture; ostaviti jedan red i uvesti zasebno polje za uslov plaćanja | odgovor na vlasnikovo pitanje (§2.1) — **sme da se izbaci** |
| **P2** | Traka uslova (`Roba je FCO`, `Način otpreme`) — ili je popuniti, ili je ne štampati praznu | danas uvek prazna |
| **P3** | Skinuti natpis `Broj l.k.:_____` sa robne fakture | dosledno odluci O-F3; zaštita podataka |
| **P4** | „Trgovinski sud u Beogradu" → „Privredni sud" | taj sud ne postoji pod tim imenom |
| **P5** | Proveriti i osvežiti `ISO 9001:2008` znak | povučena verzija standarda; netačna tvrdnja prema kupcu |
| **P6** | `cac:PaymentMeans` (račun, model, poziv na broj) u UBL | kupac po e-fakturi treba da zna gde plaća |
| **P7** | `BuyerReference` kad nema narudžbenice | moguć uzrok odbijanja na SEF-u — prvo proveriti |
| **P8** | Država kupca iz `Customer.country` umesto tvrdog `RS` | `ubl-builder.service.ts:369` |
| **P9** | Domaći račun u stranoj valuti: kurs i PDV u dinarima na papiru, `TaxCurrencyCode` u XML | nije aktuelno dok se takav račun ne izda |
| **P10** | Datum: uskladiti `format.ts` i UBL na isti izvor (npr. oboje UTC), ili preći na `date` kolone | danas se slažu samo zato što kontejner radi u UTC |
| **P11** | `web::` sa dve dvotačke | otvoreno pitanje iz GAP §5 t.9 |
| **P12** | U `STAMPA_IZLAZNIH_FAKTURA.md` upisati da je MB u potpisnom bloku originala pogrešan | da neko kasnije „ne ispravi" naš tačan podatak nazad na BigBit grešku (N6) |

---

## 7. Za potvrdu knjigovođi — spisak pitanja

Poređano po ceni greške. Prvih pet su blokade: dok se ne odgovori, ne treba dirati tekstove
napomena u kodu.

1. **Koji je tačan osnov oslobođenja za izvoz robe?** Naš papir kaže „član 24. stav 1 tačka 2",
   naš SEF XML kaže „čl. 24 st. 1 tač. 5". Koji je tačan — i razlikuje li se osnov kad robu
   otpremamo mi od slučaja kad je kupac sam odvozi?
2. **Kako se poreski tretira „ino usluga" koju Servoteh fakturiše?** Da li je to oslobođenje po
   članu 24, ili promet čije mesto nije u Srbiji (pa PDV nije obračunat po pravilu o mestu
   prometa usluga)? Koja tačno rečenica mora da stoji na tom računu?
3. **Datum prometa** — sme li se izjednačiti sa datumom otpreme/izdavanja, ili se unosi zasebno?
   Šta je datum prometa kod usluge koja traje više meseci (zakup, montaža)?
4. **Postoji li kod nas promet sa domaćim oslobođenjem ili internim obračunom PDV-a**
   (npr. reverse charge kod građevinske delatnosti)? Ako da — koja napomena ide na račun i koja
   šifra osnova u SEF? Danas papir uvek tvrdi „oslobođenja: NEMA".
5. **Avansni račun:** koje elemente mora da sadrži i kako izgleda kod nas? I: mora li konačni
   račun da iskaže odbijeni avans i na koji način?
6. **Elektronsko evidentiranje obračuna PDV na SEF-u** za promet licima koja nisu subjekti
   e-fakturisanja (strani kupci, fizička lica) — postoji li obaveza? Kod nas takav tok ne postoji.
7. **Tačan i važeći spisak obaveznih elemenata računa** — potvrditi listu iz §1.1 i reći šta sam
   promašio.
8. **Pečat i potpis** — potvrditi da nisu uslov punovažnosti računa (ni papirnog ni SEF).
9. **Podaci u podnožju** (matični broj, registarski broj, šifra delatnosti, APR rečenica) —
   potvrditi da je spisak tačan i potpun po Zakonu o privrednim društvima.
10. **Račun u stranoj valuti prema domaćem kupcu** — mora li osnovica i PDV da budu iskazani i u
    dinarima, po kom kursu i na koji dan?
11. **Uslov plaćanja na izvoznoj fakturi** — traži li ga banka ili carina? (Od odgovora zavisi
    P1.)
12. **Rok čuvanja i način arhiviranja** izlaznih faktura — PDF-ovi se danas ne arhiviraju
    sistemski, generišu se na zahtev.

---

## 8. Šta ovaj dokument NIJE

- Nije pravno mišljenje i ne zamenjuje knjigovođu.
- Ne tvrdi da su fakture nezakonite. Tvrdi da **jedan obavezan element (datum prometa) u praksi
  ne izlazi ni na jednoj**, da je **napomena o oslobođenju tvrdo ukucana umesto da bude podatak**,
  i da **naš papir i naš SEF XML na jednom mestu govore različito** — a sve troje je provereno u
  kodu i može se potvrditi za pet minuta.
- Ne predlaže nijednu izmenu koda koja bi se izvela pre nego što knjigovođa odgovori na pitanja
  1–5 iz §7. Izmene M1, M4, M5, M7, M8 i sve iz §6.2 ne zavise od tih odgovora i mogu se raditi
  odmah; M2, M3 i M6 čekaju.

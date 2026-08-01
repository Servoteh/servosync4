# ZAPISNIK — Završni račun u ServoSync 4.0: šta traži zakon, kako to rade drugi, gde smo mi

**Za:** vlasnika/direktora Servoteha
**Datum:** 26.07.2026.
**Predmet:** može li Servoteh da preda finansijske izveštaje APR-u iz sopstvenog sistema (ServoSync 4.0), šta još treba, i koliko to košta u odnosu na kupovinu tuđeg ERP-a
**Izvor istine za tvrdnje o našem sistemu:** worktree `c:\Users\nenad.jarakovic\wt\bigbit-remedijacija`, stanje na commit `eeef21d`

**Kako čitati oznake:**
- *(procena)* — moja procena, nije provereno.
- **NEPOZNATO** — nismo uspeli da utvrdimo; ne nagađam.
- Svaka tvrdnja o propisu ima broj Službenog glasnika ili link. Svaka tvrdnja o našem sistemu ima ime fajla i, gde je bitno, broj linije.

---

## 1. ZAKLJUČAK NA JEDNOJ STRANI

**Odgovor na glavno pitanje: danas ne smemo da predamo finansijske izveštaje iz ServoSync 4.0 — ali ne zbog zakona.**

Zakon nam nije prepreka. Pravilnik po kojem se prave obrasci (**„Sl. glasnik RS" br. 89/2020**) je i dalje na snazi i AOP oznake nisu menjane. Nijedan propis ne kaže gde smeju da žive formule za obračun obrasca, ne postoji sertifikacija računovodstvenih programa u Srbiji, a zahtev zakona da se proknjižena stavka ne sme brisati ispunjavamo bolje nego stari BigBit (Access).

Prepreka smo mi, i to u pet konkretnih tačaka:

1. **Motor nikad nije video pravi broj.** Nijedna od 179 AOP formula nikad nije pokrenuta nad stvarnim knjiženjima. Provera je rađena olovkom — aritmetički, nad brojkama iz **predatih** obrazaca Servoteha za 2023. (`backend/docs/migration/ZR_AOP_FORMULE_AUTENTICNE.md` §2, „Nije provereno — iskreno").
2. **Iznosi nisu skalirani na hiljade.** Obrazac se predaje **u hiljadama dinara** (piše na predatom obrascu, `backend/reports/zr/bs.txt`), naša glavna knjiga je u dinarima, a u celom modulu `backend/src/modules/zavrsni/` **ne postoji nijedno deljenje sa 1000** (provereno pretragom). BigBit je imao prekidač za to (`BIGBIT_ZR_MOTOR.md:78-94`). Bez ispravke bi APR-u otišao broj 1.000 puta veći.
3. **Rezultat godine ne ulazi u kapital, pa bilans stanja ne zatvara.** Detaljno u §7, rizik R1. Za 2023. bi promašaj bio 34.636 od 868.293 hiljade dinara (4%).
4. **Imamo dva obrasca od šest.** Statistički izveštaj — obavezan za sve, rok isti 31. mart — nema ni jednu formulu **ni rutu** da se uopšte napravi (`backend/src/modules/zavrsni/zavrsni.controller.ts` ima samo `POST /bilans-stanja` i `POST /bilans-uspeha`).
5. **XML za APR nikad nije uvezen u APR-ovu aplikaciju.** Numeracija kolona je verovatno pogrešna, a blok sa podacima o obvezniku je u kodu označen kao „konzervativna rekonstrukcija" (`apr-xml.service.ts:62,204-209`).

**Šta od toga stvarno blokira, a šta nije strašno.** Blokiraju samo netačni brojevi (tačke 1–3) i pitanje da li se knjige uopšte vode u 4.0. Neispravan XML **nije** blokada: APR-ova aplikacija prima i ručni unos, pa se 117 pozicija bilansa stanja i 62 bilansa uspeha prekucaju za jedno popodne *(procena)*. Nema kazne, nema propuštenog roka.

**Pitanje koje moramo sebi da postavimo pre svega ostalog:** da li se **cela poslovna godina knjiži u 4.0**, ili se paralelno knjiži u BigBitu. Motor računa isključivo iz tabele `ledger_entries` (`gkeval.service.ts:390-417`) — nema uvoza bruto stanja, nema spajanja sa BigBitom. Ako je i jedan mesec knjižen samo u BigBitu, bilans iz 4.0 je matematički nemoguć, bez obzira koliko formula ispravimo. Po zabeleškama iz jula 2026. („4.0 moduli živi za menadžment krug, prod baza, tabele prazne") *(procena)* glavna knjiga 4.0 u 2026. **nije** bila u produkcionoj upotrebi — što bi značilo da se cela priča pomera na izveštaj za 2027. To je jedina stvar sa liste koja se **ne može** popraviti posle 31.12.

**Da li je bilo vredno graditi sopstveno.** Da, i to se može izračunati. Obrasci finansijskih izveštaja menjani su **dva puta u dvanaest godina** (95/2014 → 89/2020), sa najavom od godinu dana. Naš trošak održavanja je 3–5 radnih dana računovođe i programera po izmeni, u godinama bez izmene propisa nula *(procena)*. Pantheon za firmu naše veličine košta reda **16.500–23.000 EUR jednokratno + 3.500–5.000 EUR godišnje** *(procena, 10 licenci nivoa MF; nije ponuda)*, gde je godišnjih **21–22% vrednosti licence** izričito plaćanje za „usklađenost sa lokalnim zakonodavstvom". Microsoft Business Central je za 20 korisnika Premium oko **26.400 USD godišnje** samo za licence *(procena)*, a lokalizaciju za Srbiju Microsoft **ne isporučuje** — radi je domaći partner.

**Prava opasnost nije propis nego mi.** Ako za pet godina niko u firmi ne bude znao gde formule stoje i kako se proveravaju, sopstveni sistem postaje teret. To se rešava jednom stranom uputstva i verzionisanjem formula, ne kupovinom tuđeg ERP-a.

**Rezervna opcija koju treba držati u rukavu:** obrazac sastavi računovodstvena agencija iz našeg bruto bilansa. `GET /zavrsni/bruto-bilans` radi i kad je tabela formula prazna. Tada AOP motor nije obavezan, nego prednost. Napomena: ta opcija prebacuje samo posao **sastavljanja obrasca** — knjige i kontni plan i dalje moraju biti tačni kod nas.

---

## 2. ŠTA TRAŽI ZAKON

### 2.1 Propisi koji nas obavezuju

| Propis | Broj | Šta uređuje |
|---|---|---|
| Zakon o računovodstvu | „Sl. glasnik RS" **73/2019** i **44/2021** | ko vodi knjige, rokovi, odgovornost, čuvanje, elektronska predaja |
| Pravilnik o sadržini i formi obrazaca finansijskih izveštaja i obrasca Statističkog izveštaja za privredna društva, zadruge i preduzetnike | „Sl. glasnik RS" **89/2020** | sami obrasci i AOP oznake |
| Pravilnik o Kontnom okviru i sadržini računa za privredna društva, zadruge i preduzetnike | „Sl. glasnik RS" **89/2020** | konta na trocifrenom nivou |
| Zakon o reviziji | „Sl. glasnik RS" (važeći tekst) | ko mora imati reviziju |

Pravilnik 89/2020 objavljen je 25.06.2020, a po **članu 48** primenjuje se počev od finansijskih izveštaja koji se sastavljaju **na dan 31.12.2021**. Provereno na tri mesta (Pravno-informacioni sistem RS, sajt Ministarstva finansija, Paragraf): **nijedan izvor ne navodi izmenu, dopunu ni prestanak važenja** do jula 2026. Uz naziv stoji samo jedan broj glasnika.

Izvori:
- https://www.paragraf.rs/propisi/zakon-o-racunovodstvu-2020.html
- https://www.paragraf.rs/propisi/pravilnik-sadrzini-formi-obrazaca-finansijskih-izvestaja-za-privredna-drustva-zadruge.html
- https://mfin.gov.rs/sr/propisi-1/pravilnik-o-kontnom-okviru-i-sadrzini-racuna-u-kontnom-okviru-za-privredna-drustva-zadruge-i-preduzetnike-sluzbeni-glasnik-rs-br-892020-1

### 2.2 Šta se sve predaje

Pravilnik 89/2020 propisuje **šest obrazaca** (Prilozi): Bilans stanja, Bilans uspeha, Izveštaj o ostalom rezultatu, Izveštaj o tokovima gotovine, Izveštaj o promenama na kapitalu i **Statistički izveštaj**. Uz njih idu **Napomene uz finansijske izveštaje** — to nije obrazac nego tekstualni dokument.

> **Ispravka ranije formulacije:** u radnoj matrici je pisalo „od šest propisanih obrazaca imamo dva, fale pet" — dva plus pet je sedam. Tačno je: šest obrazaca, imamo dva, fale četiri obrasca **i** Napomene.

Statistički izveštaj je obavezan za **sve** obveznike bez obzira na veličinu, ima tabele I–XIII i AOP oznake od 9001 naviše (9001 = broj meseci poslovanja, 9002 = oznaka vlasništva; sadrži i prosečan broj zaposlenih i bruto zarade — dakle podatke kojih **nema u glavnoj knjizi**).

### 2.3 Rokovi

| Šta | Do kada |
|---|---|
| Redovni godišnji finansijski izveštaj **i Statistički izveštaj** | **31. mart** naredne godine |
| Konsolidovani izveštaj | 30. april |
| Revizorski izveštaj, godišnji izveštaj o poslovanju, odluka o usvajanju i raspodeli dobiti | **30. jun** (konsolidovani 31. jul) |
| APR otvara aplikaciju | krajem januara (za 2025. — 30.01.2026.) |

Izvor: https://www.apr.gov.rs/registri/finansijski-izvestaji.2069.html

### 2.4 Razvrstavanje po veličini (član 6) i obaveza revizije

Razvrstavanje ide po **dva od tri** kriterijuma na dan bilansa:

| Veličina | Zaposleni | Poslovni prihod | Ukupna aktiva |
|---|---|---|---|
| mikro | < 10 | < 700.000 EUR | < 350.000 EUR |
| malo | < 50 | < 8.000.000 EUR | < 4.000.000 EUR |
| srednje | < 250 | < 40.000.000 EUR | < 20.000.000 EUR |
| veliko | preko toga | | |

Servoteh po **predatom** obrascu za 2023 (`backend/reports/zr/bs.txt`, `bu.txt`): ukupna aktiva **868.293** hilj. RSD, poslovni prihodi **630.409** hilj. RSD, ukupni prihodi **653.419** hilj. RSD. Po kursu ~117 RSD/EUR to je oko **7,4 mil EUR aktive** i **5,4–5,6 mil EUR prihoda** *(procena — zvaničan srednji kurs na dan bilansa mora primeniti knjigovođa)*. Aktiva prelazi prag za „malo". Broj zaposlenih nije u BS/BU nego u Statističkom izveštaju — **NEPOZNATO**. Ako je preko 50, prelaze se dva kriterijuma i Servoteh je **srednje** pravno lice *(procena)*.

**Revizija je, međutim, obavezna nezavisno od razvrstavanja.** Zakon o reviziji propisuje obavezu za sva pravna lica čiji **poslovni prihod u prethodnoj godini prelazi 4.400.000 EUR**. Sa ~5,4 mil EUR smo iznad praga. (https://www.paragraf.rs/propisi/zakon_o_reviziji.html)

**U našem kodu veličina je nagađana:** `backend/src/modules/zavrsni/apr-xml.service.ts:69` — `const OBVEZNIK_VELICINA = process.env.ZR_OBVEZNIK_VELICINA ?? "MALO"`, uz TODO da veličina nije ni polje u Podešavanjima. Od te jedne promenljive zavisi koji se set obrazaca predaje.

### 2.5 Odgovornost i kazne (član 43)

Finansijski izveštaj potpisuje **zakonski zastupnik**. Za istinito i pošteno prikazivanje odgovaraju **kolektivno**: zakonski zastupnik, organ upravljanja, nadzorni organ i **lice odgovorno za vođenje poslovnih knjiga**.

**Zakon ne poznaje odgovornost proizvođača softvera.** Ako naša formula pogreši, kaznu plaća Servoteh i lično odgovorno lice:
- pravno lice **100.000–3.000.000** dinara
- odgovorno lice u pravnom licu **20.000–150.000** dinara
- nepredavanje **dve godine zaredom** → APR pokreće **prinudnu likvidaciju**

Praktična posledica za nas: nijedan obračun iz ServoSync-a ne sme u APR bez potvrde knjigovođe **zabeležene u sistemu**. Danas takvo polje ne postoji — model `FinancialStatement` (`backend/prisma/schema.prisma:4142-4157`) ima samo `id`, tip, godinu, status, `createdByUserId` i `finalizedAt`; **nema „proverio/odobrio", nema zapisa da je finalizacija forsirana**.

### 2.6 Elektronska predaja (član 44)

Izveštaji i izjava potpisuju se **kvalifikovanim elektronskim potpisom zakonskog zastupnika** i unose u informacioni sistem APR-a. Papirne predaje nema. Programi mogu pripremiti XML koji se **uvozi** u APR-ovu aplikaciju; potpisivanje se ipak radi u APR-ovoj aplikaciji. Elektronski potpis, dakle, **nije naš problem** — radi ga direktor kao i do sada.

### 2.7 Čuvanje (član 28)

| Šta | Koliko |
|---|---|
| finansijski izveštaji i godišnji izveštaj o poslovanju | 20 godina |
| dnevnik i glavna knjiga | 10 godina |
| pomoćne knjige | 5 godina |
| isprave na osnovu kojih se knjiži | 5 godina |
| isplatne liste | trajno |

Ključno za softver: ako se knjige vode na računaru, uz podatke se mora čuvati i **aplikativni softver** tako da podaci ostanu dostupni za kontrolu; ako to tehnički nije moguće, dokument se čuva u čitljivom tekstualnom obliku uz opis polja i znak razdvajanja. Kod nam je u gitu i verzionisan, ali **formalizovan godišnji arhivski paket** (izvoz dnevnika i glavne knjige u čitljiv format + opis kolona) ne postoji — to treba da postane deo zatvaranja godine.

### 2.8 Novine APR-a za izveštaje za 2025.

APR („Novine u finansijskom izveštavanju za 2025. godinu"): počev od izveštaja za 2025, obveznici **više ne unose ručno** vrednosti AOP pozicija koje se dobijaju formulom — **sistem sam izračunava sve pozicije koje nastaju sabiranjem ili oduzimanjem drugih AOP pozicija**. Uz to, na obrascima se od 2025. prikazuju i **potpisnici** izveštaja, a promenjen je i način provere uplate naknade (nova Odluka o naknadama, „Sl. glasnik RS" 95/2025, na snazi od 01.01.2026; od 08.01.2026. uplate na račun 840-1308664-17).

Šta to znači za nas: od naših 179 formula **41 je čista AOP-aritmetika** (22 zbirne u bilansu stanja + 19 u bilansu uspeha) — te APR sada preračunava sam. Naša odgovornost se sužava na ~138 „listova", tj. maski nad kontima. **Ne smanjuje** rizik iz §7 R1 (konto 341), jer je to greška u masci, ne u aritmetici.

Izvor: https://www.apr.gov.rs/registri/finansijski-izvestaji/uputstva-za-sastavljanje-i-dostavljanje-finansijskih-izvestaja-odnosno-dokumentacije-/novine-u-finansijskom-izvestavanju-za-2025-godinu.4735.html

### 2.9 Šta stiže

Ministarstvo finansija je **24.04.2026.** objavilo **Nacrt novog Zakona o računovodstvu** (javna rasprava 24.04–15.05.2026, prezentacija 11.05.2026. u PKS), a 27.04.2026. i Nacrt novog Zakona o reviziji. Najveća novina je obaveza **izveštavanja o održivosti (ESG/CSRD)**. Do 26.07.2026. **nema potvrde da je nacrt usvojen** u Skupštini.

Za nas: ako prođe, to je **nova gradnja, ne dorada** — ti podaci se ne dobijaju iz glavne knjige i naš motor formula ih ne pokriva. Preporuka: pratiti usvajanje, ne raditi ništa unapred (nacrt se u proceduri menja).

Izvor: https://mfin.gov.rs/sr/propisi-1/nacrt-zakona-o-raunovodstvu-1

---

## 3. KAKO TO RADE DRUGI

### 3.1 SAP

SAP završni račun rešava u **tri odvojena sloja**, i to je najvažnija stvar koju treba razumeti pre poređenja:

1. **Financial Statement Version (FSV, transakcija OB58)** — obrazac je **stablo** čvorova (do 20 nivoa). Kontima se dodeljuju **intervali „od konta – do konta"**, uz čekiranje D (dugovni) i C (potražni). Zbir čvora je **prost zbir dece** — **nema aritmetike, nema referenci na druge pozicije, nema oduzimanja tuđe pozicije**. FSV je namerno „glup" da bi bio proveriv.
2. **Report Painter / Report Writer** (i, u novijim izdanjima, Fiori aplikacije) — tu se rade izvedene veličine, procenti i aritmetika između redova. To je pravi pandan našim `A<aop>` referencama.
3. **SAP Document and Reporting Compliance (DRC)** — zakonski obrazac po zemlji, izlaz u XML/XBRL/TXT/JSON i elektronsko podnošenje.

Tri mehanizma iz SAP-a koja su nam relevantna:

- **„Accounts not assigned".** Izveštaj (program RFBILA00, transakcija F.01) **uvek** prikaže poseban čvor u koji padnu sva konta sa saldom koja nijedan interval nije pokupio. Konto ne može tiho da nestane. Postoji i formalna provera strukture FSV-a pre nego što se verzija pusti u rad.
- **Debit/credit shift.** Dve prazne stavke se vežu u par; po znaku ukupnog salda ceo iznos ide na jednu ili drugu. Isto važi za obavezan par „Net Result: Profit" / „Net Result: Loss" — SAP nikad ne prikazuje negativan iznos.
- **Balance Carry Forward (F.16 / FAGLGVTR).** Bilansna konta se prenose na početno stanje; konta uspeha se **ne prenose pojedinačno** — ukupan rezultat ide na konto rezultata definisan u OB53. **Ne pravi se nijedan knjigovodstveni dokument** („the balance carryforward cannot be carried out via the line item display"), i program je **ponovljiv koliko god puta** — pri svakom sledećem prolazu upiše samo razliku.

Uz to, u S/4HANA-i su ukinute tabele pred-izračunatih salda (GLT0, FAGLFLEXT…) i sve se računa **iz pojedinačnih stavki** tabele ACDOCA. To je isto što mi radimo nad `ledger_entries` — dakle SAP je 2015+ prešao na arhitekturu koju mi već imamo.

**Provereno:** sve navedene transakcije i programi postoje; adversarijalna provera nije našla nijednu izmišljenu oznaku (OB58, RFBILA00/F.01, F.16/FAGLGVTR, OB53, „accounts not assigned", debit/credit shift, 20 nivoa hijerarhije).

**Delimično nepotvrđeno:** SAP nota **3507420** („Serbia – Reports in the SAP Document and Reporting Compliance") **postoji**, ali je pun sadržaj iza SAP prijave. Dakle spisak izveštaja koje SAP isporučuje za Srbiju **nismo mogli da pročitamo**. Posebno ostaje **NEPOZNATO** da li SAP isporučuje same AOP šifre i strukturu obrasca po Pravilniku, ili samo tehnički okvir u koji struktura mora sama da se unese. Ako je ovo drugo, argument „kod SAP-a to održava SAP" slabi.

Izvori: https://help.sap.com/docs/SAP_S4HANA_ON-PREMISE/651d8af3ea974ad1a4d74449122c620e/ee7fd1538cdf4608e10000000a174cb4.html ; https://userapps.support.sap.com/sap/support/knowledge/en/3525986 ; https://community.sap.com/t5/enterprise-resource-planning-q-a/question-about-t-code-faglgvtr/qaq-p/9285774 ; https://userapps.support.sap.com/sap/support/knowledge/en/3507420

### 3.2 PANTHEON (Datalab)

PANTHEON ima poseban modul **„Bilance"** u kojem su formule obrasca **podaci u bazi**, a ne kod. Datalab ih isporučuje preko svog web servera („prenos predlog bilanc"), korisnik ih preuzme klikom; ručna ispravka postoji kao izuzetak za nestandardan kontni plan. Predaja ide izvozom XML-a (u Sloveniji „izvoz na Ajpes", u Srbiji uvoz na portal APR-a). Zatvaranje godine radi se dokumentom zaključka + dokumentom početnog stanja, uz „zatvaranje razreda 4 i 7" — dakle **prave se nalozi**, kao kod nas.

Cene (zvanični Datalab cenovnik, slovenačko tržište, bez PDV-a, po licenci): LX 279 €, LT 499 €, LT3 999 €, RE 1.199 €, SE 1.499 €, ME 1.699 €, **MF 2.299 €** (MF = proizvodnja — nivo koji bi Servotehu trebao). Godišnje održavanje **22% ukupne vrednosti aktivnih licenci**, i ono izričito pokriva „usklađenost sa lokalnim zakonodavstvom, planirani razvoj novih funkcionalnosti, kompatibilnost". Prekid pa obnova ugovora naplaćuje se „istorijskom vrednošću" **1,75% mesečno** za period bez ugovora — dakle ne može se preskočiti par godina pa vratiti. Partnerski cenovnik u Srbiji (Connect Software, Novi Sad) navodi niže cene licenci uz godišnju nadogradnju **21%**.

> **Poštena ograda:** cene su potvrđene u zvaničnom cenovniku. Ali **doslovne citate iz Datalab-ovog školskog materijala o modulu „Bilance" nismo uspeli da potvrdimo** — dokument postoji na navedenoj adresi (`SOLA_Letno_porocilo_AJPES_Bilance_DDPO…FY20.pdf`, datalab.si), ali je PDF iz kojeg se u našem okruženju tekst ne da izvući. Smer tvrdnje je verovatno tačan (potvrđen nezavisno kroz Calculus 12, §3.3), ali navodi nisu provereni.

Izvor: https://www.datalab.eu/pantheon-license-prices/ ; https://connectsoftware.rs/pantheon/cenovnik/cenovnik-licenci/

### 3.3 Domaći programi

**Calculus 12** — jedini domaći program čije smo uputstvo mogli da pročitamo u izvoru, i potvrđen je rečenicu po rečenicu:
- veza konto→AOP radi preko analitičkih konta iz inicijalnog kontnog plana (isti mehanizam kao naše maske),
- **„Nad svakim poljem koje ima belu pozadinu možete dvostrukim klikom miša otvoriti prozor za formiranje izraza"** — korisnik menja formulu bez programera,
- **verzija obrasca sa godinom** — „uz naziv tipa prikazuju se godina od koje se primenjuje i verzija unutar te godine (npr. 2014:1)",
- **„Ako nova verzija programa izmeni podrazumevani izveštaj, obaveštenje o tome će biti prikazano crvenim tekstom ispod filtera"**,
- eksport u XML za elektronsku predaju APR-u.

Ovo je najbolji uzor za ono što nama fali — posebno **verzija obrasca po godini**, koju mi nemamo (§4.4).

Izvor: https://uputstvo.calculus-portal.rs/help/srp_sr/fink/fink_C1.11.html

**BizniSoft** — uputstvo „Formiranje finansijskih izveštaja za 2025. godinu" (biznisoft.com, februar 2026) **postoji** na navedenoj adresi, ali je takođe PDF iz kojeg tekst nije bilo moguće izvući, pa **doslovni citati nisu potvrđeni**. Neproverene tvrdnje koje smo ranije navodili: da proizvođač isporučuje obrasce kao „šifarnik" koji korisnik uvozi; da korisnik sme ručno da prepravi bilo koji AOP iznos i klikne „Preračunaj"; da je Izveštaj o tokovima gotovine „samo delimično odrađen"; sintaksa kontrolnih pravila (`A90086 = A00036`); nazivi naloga FR-1 i FR-2. **Ako se ijedna od njih koristi kao argument u razgovoru sa knjigovođom, neka je neko prvo otvori u samom PDF-u.**

**Minimax (SaaS)** — druga krajnost: korisnik ne vidi nikakve formule, program sam formira obrasce i XML, a kad APR promeni šemu izmena se desi svima odjednom. Za nas nije upotrebljiv kao sistem (nema proizvodnje), ali je koristan kao mera cene alternative — reda 20 EUR mesečno *(procena)*.

**Logik, Sinhro, Wings, ABIT, GoPro** — javno su dostupne samo marketinške stranice; mehanizam veze konto→AOP i način isporuke ažuriranja **NEPOZNATO**. *(procena: rade kao BizniSoft — proizvođač isporučuje obrasce uz godišnju pretplatu.)* Ne menja odluku: nijedan ne rešava proizvodnju, radne naloge i predmete, pa bi u svakom slučaju bio drugi sistem pored 4.0, sa dvostrukim unosom.

### 3.4 Microsoft Dynamics 365 Business Central i Odoo

**Business Central:** Microsoft zvanično **ne isporučuje lokalizaciju za Srbiju** — rade je partneri kroz ekstenzije na AppSource-u (NPS d.o.o. Beograd, BE-terna/Adacta). Cena (Microsoft lista, od 01.11.2025): Essentials **80 USD**, Premium **110 USD** po korisniku mesečno, Team Members 8 USD. Cena partnerske lokalizacije i implementacije nije javna — **NEPOZNATO**. Za 20 korisnika Premium to je oko **26.400 USD godišnje** samo licence *(procena)*.

Rizik koji se lako previdi: AOP formule ne održava Microsoft, nego jedna domaća firma od nekoliko ljudi. Ako prestane da održava ekstenziju, ostajete sa međunarodnom verzijom bez srpskih obrazaca i bez izvornog koda lokalizacije.

**Odoo:** srpska lokalizacija (`l10n_rs`) donosi kontni plan, poreze i fiskalne pozicije. Da li pokriva APR obrasce — **izvori se razilaze**: naša ranija analiza je tvrdila da AOP pozicija, Pravilnika 89/2020 i XML-a za APR nema, ali javni opisi lokalizacije (Cybrosys, CandidRoot) tvrde da paket donosi „šablone i formate finansijskih izveštaja, uključujući bilans stanja i bilans uspeha, prilagođene srpskim računovodstvenim standardima". Nigde, međutim, nismo našli pomen AOP oznaka ni XML izvoza za APR. **Ne treba koristiti kao argument u odluci** dok se ne proveri.

---

## 4. GDE SMO MI — pošteno

### 4.1 Šta imamo i radi

- **Motor formula** `backend/src/modules/zavrsni/gkeval.service.ts` (500 linija). Jezik ima **pet vrsta izraza**: `D<konto>*` (dugovni promet svih konta sa datom maskom), `P<konto>*` (potražni), `PSD`/`PSP` (isto, ali samo sa naloga početnog stanja), `A<aop>` (vrednost druge pozicije istog obrasca; `AB`/`AC` = kolone 2 i 3) i običan broj. Operatori: **plus, minus, zagrade**. Nema množenja, deljenja, procenata, uslova ni funkcija. Zvezdica **nikad** ne znači množenje. Zbrajanje je levo-asocijativno (`A−B−C = (A−B)−C`) — bitno, jer je BigBit računao zdesna i na neto dobitku davao 38.668 umesto tačnih 34.636.
- **179 formula kao podaci u bazi** — migracija `backend/prisma/migrations/20260726090000_seed_balance_formulas_autenticne/migration.sql`: **117 bilans stanja** (AOP 0001–0060 i 0401–0457) + **62 bilans uspeha** (1001–1062). Od toga je **14 pozicija MANUAL** (BS: 0016, 0020, 0028, 0054, 0411, 0428, 0436; BU: 1054, 1057–1062).
- **Računamo iz stavki, ne iz pred-izračunatih salda** — `SUM(debit)/SUM(credit)` nad `ledger_entries` u trenutku traženja izveštaja. Salda se ne mogu raziđi sa stavkama. Isto što je SAP uveo tek sa S/4HANA-om.
- **Fallback bez formula:** `GET /zavrsni/bruto-bilans` radi i kad je tabela formula prazna. SAP bez ispravno konfigurisanog FSV-a ne daje obrazac uopšte.
- **Revizorski trag nad nalozima je dobar, i bolji od Accessa:** status naloga `draft → posted → locked`; proknjižen nalog se **ne briše**, ispravka isključivo stornom; masovno zaključavanje perioda sa dry-run prikazom; otključavanje se loguje sa ID-em korisnika (`backend/src/modules/gl/gl-write.service.ts`).
- **Svaka izračunata linija čuva formulu kojom je dobijena** (`FinancialStatementLine.formula`). Finalizovan obrazac za 2023. i posle pet godina pokazuje tačan izraz koji ga je proizveo, čak i ako se definicija u međuvremenu promeni. To je prava jaka strana.
- **Formule se ne mogu menjati kroz aplikaciju:** u celom backendu postoji **samo jedno čitanje** `balanceFormulaDefinition.findMany` (`balance-sheet.service.ts:199`) i **nijedan upis**. Menjaju se isključivo migracijom, koja je u gitu, sa autorom i datumom.

### 4.2 Šta ne radi — činjenice

| # | Šta | Dokaz |
|---|---|---|
| 1 | **Nema skaliranja na hiljade.** Obrazac se predaje u hiljadama dinara; u celom modulu nema nijednog deljenja sa 1000. BigBit je imao prekidač `ZaokruzenoNa1000` sa `Round([SumOfDuguje]/1000,0)`. | pretraga po `backend/src/modules/zavrsni/` i po ekranu — 0 pogodaka; `BIGBIT_ZR_MOTOR.md:78-94`; `bs.txt` zaglavlje „- у хиљадама динара -" |
| 2 | **Konto koje nijedna maska ne pokriva tiho ispada.** Upit završava sa `COALESCE(SUM(...),0)` — maska bez pogotka daje nulu, identično kao konto sa saldom nula. Postoji čak i test koji to ponašanje zaključava kao ispravno. | `gkeval.service.ts:404-416`; `gkeval.service.spec.ts` („maska koja ne uhvati nijedno konto daje nulu, ne grešku") |
| 3 | **23 konta iz plana ne hvata nijedna maska** (sintetičke „glave" klasa + `290` + `2990 PORSCHE LEASING NEDOSPELA KAMATA`). Ako ijedno nosi saldo, aktiva ≠ pasiva bez objašnjenja. | `ZR_AOP_FORMULE_AUTENTICNE.md` §7 R2 |
| 4 | **Šest od sedam kontrolnih pravila su tautologije** — proveravaju formulu protiv doslovno iste formule iz seed-a. Prava kontrola je tačno jedna: aktiva = pasiva. | `control-rules.service.ts:80-147` naspram `migration.sql:185,288,289,300,301,306,307,326` |
| 5 | **`force=true` se šalje automatski, i nigde se ne beleži.** Ekran sam izračuna `anyFail` i pošalje `finalize.mutate({ id, force: anyFail })`; jedina prepreka je `window.confirm`. U bazi nema kolone da je obračun forsiran. | `frontend/src/app/zavrsni-racun/page.tsx:259-267`; `backend/prisma/schema.prisma:4142-4157` |
| 6 | **Odsečene (clamped) pozicije se ne vide na ekranu.** Motor ih pamti i vraća u polju `clamped`, ali se to ne upisuje u bazu, ne vraća ga `listStatements`, i frontend tip `FinancialStatement` uopšte nema to polje. | `balance-sheet.service.ts:400`; `frontend/src/api/zavrsni.ts` |
| 7 | **Iteracija se ne smiri — niko ne sazna.** Najviše 7 prolaza (`MAX_ITER = 7`, isto kao BigBit); ako se posle toga vrednosti i dalje menjaju, kod tiho izađe iz petlje bez izuzetka i bez upozorenja. Referenca na nepostojeću AOP oznaku takođe vraća 0 bez reči. | `balance-sheet.service.ts:243-303` |
| 8 | **Uporedne kolone (prethodne dve godine) su nule.** `loadPriorYearAmounts` samo prepisuje iznose iz ranije **sačuvanog** obračuna; takvih nema. Gore: svaki ponovni obračun radi `deleteMany` pa `createMany`, pa bi i ručno ubačena vrednost nestala. | `balance-sheet.service.ts:357,373,421-442` |
| 9 | **14 MANUAL pozicija = trajna nula.** Kontroler ima samo GET i POST rute, **nijedan PATCH ni PUT**. Proverljiv primer: AOP 0436 je za 2022. predat sa **9.400**; naš sistem bi prikazao 0 i to se kroz aplikaciju ne može ispraviti. | `zavrsni.controller.ts:47-131`; `migration.sql` (14 MANUAL redova) |
| 10 | **Statistički izveštaj nema ni formule ni rutu.** Nijedna od tri migracije nema ni jedan red za tip `POPDV_ANNUAL` (naša oznaka za SI). Istovremeno, izvoz u APR XML za SI **već postoji** — izlaz je spreman za obrazac koji se ne može napraviti. | `migration.sql:79`; `zavrsni.controller.ts`; `apr-xml.service.ts:102-107` |
| 11 | **APR XML: pogrešna numeracija kolona.** `DEFAULT_START_COLUMN = 3` → emitujemo `aop-XXXX-3/-4/-5`. Predati obrazac ima kolone 1–7, gde je 3 = „АОП", 4 = „Напомена број" (tekst), a iznosi su u **5, 6, 7**. Naši brojevi bi upali u pogrešna polja. Model nema polja `start_column`/`column_count`. | `apr-xml.service.ts:62,168-169`; `backend/reports/zr/bs.txt` (red sa brojevima kolona) |
| 12 | **Blok `<Obveznik>` u XML-u je izmišljen.** U kodu piše „KONZERVATIVNA REKONSTRUKCIJA" i TODO „uskladiti sa pravom APR eFI FiForma šemom pre produkcije". | `apr-xml.service.ts:204-209` |
| 13 | **Veličina obveznika iz promenljive okruženja**, podrazumevano „MALO". | `apr-xml.service.ts:69` |
| 14 | **Motor ne filtrira po firmi.** `companyId` postoji u nalozima (podrazumevano 0), ali ga upiti u `gkeval` ne koriste. Danas bezopasno, brane nema. | `gkeval.service.ts` (aggregate) |
| 15 | **Formule nemaju godinu ni verziju.** Ključ je `@@unique([statementType, aop])`. Kad se Pravilnik promeni, nove formule fizički gaze stare i obračun za 2023. se više ne može ponoviti. | `backend/prisma/schema.prisma:4192-4202` |
| 16 | **Modul ima 7 testova, i svi rade nad lažnom bazom.** Proveravaju da sastavljeni SQL sadrži pravu reč, ne da broj izlazi tačan. Jedan od njih (NULL vrsta naloga) štiti stanje koje po šemi **ne može da postoji** — kolona `orderTypeCode` je NOT NULL. | `gkeval.service.spec.ts` (7 × `it(`); `schema.prisma:3011` |
| 17 | **Uvodni komentar u fajlu kontrolnih pravila protivreči samom sebi.** Redovi 14–17 navode `UKUPNA AKTIVA = 0001`, `NETO DOBITAK = 1068`, `1064`, `1066` — a isti fajl 45 redova niže te oznake proglašava nepostojećim. Upravo je taj razred greške već jednom proizveo pravilo koje je lažno prolazilo. | `control-rules.service.ts:14-17` vs `:62-79` |

### 4.3 Gde se naši sopstveni dokumenti ne slažu

Poštenja radi — dva broja u našoj dokumentaciji se razilaze i ne biramo tiho jedan:

- **165 ili 154 provere smera duguje/potražuje.** `ZR_AOP_FORMULE_AUTENTICNE.md:68` kaže „svih 165 listova ručno"; zaglavlje seed migracije za istu proveru kaže „svih 154 lista prošlo ručnu proveru". Jedan od ta dva broja je pogrešan i ne zna se koji.
- **19 ili 26 praznih maski.** Radna matrica je pisala 19; `ZR_AOP_FORMULE_AUTENTICNE.md` §9 nabraja **26 maski** (22 u bilansu stanja, 4 u bilansu uspeha), grupisanih u 18 stavki. Tačan broj je **26**.

### 4.4 Jedina prava rupa u modelu

Tabela formula nema **godinu / verziju**, ni „važi od – važi do", ni zapis ko je i kada menjao. Ko ima pristup bazi, promeni formulu jednim `UPDATE`-om i nema traga. Calculus 12 je taj problem rešio pre više od deset godina, jednim poljem („2014:1"). Kod nas se, doduše, formule menjaju samo migracijom u gitu — što je bolji trag nego ekran bez zapisa — ali **ponovni obračun za raniju godinu po tada važećem obrascu nije moguć**, a finansijski izveštaji se čuvaju 20 godina.

---

## 5. UPOREDNA TABELA (12 dimenzija)

**Ocene:** DOVOLJAN = može se predati bilans · RIZIČAN = radi, ali može tiho da pogreši · NEDOSTAJE = funkcije nema

| # | Dimenzija | SAP | Pantheon i region | Srpski propis traži | ServoSync 4.0 | Ocena |
|---|---|---|---|---|---|---|
| 1 | Gde žive formule | Konfiguracija (FSV/OB58), ne kod | Baza; vendor isporučuje, korisnik sme da menja | Ne propisuje | Baza (179 redova); menja se samo SQL migracijom; **bez godine/verzije** | RIZIČAN |
| 2 | Konto → pozicija | Intervali „od–do" + oznaka D/C | Maske / grupe konta | Pravilnik u obrascu navodi grupe konta | Maske `D204*`, `P60*` + reference `A0002`; 5 vrsta atoma, samo +/−/zagrade | DOVOLJAN |
| 3 | Konto koje nijedna maska ne pokriva | Čvor „Accounts not assigned" | Bruto bilans + kontrole | Ne propisuje izričito | **Tiha nula**; 23 konta bez maske | NEDOSTAJE |
| 4 | Debit/credit shift | Eksplicitan par stavki, provera pri konfiguraciji | Par pozicija u obrascu | Obrazac ima parove (1025/1026, 1055/1056) | Par pozicija + odsecanje na nulu | DOVOLJAN |
| 5 | Negativan iznos / clamp | Nikad negativan; prebaci na parnjaka | Odsecanje + ručna korekcija | Obrazac ne poznaje minus | Clamp u svakoj iteraciji; signal `clamped` **ne stiže do ekrana** | RIZIČAN |
| 6 | Zatvaranje godine | Prenos **bez dokumenata**, ponovljiv, rezultat na konto iz OB53 | Nalog zaključka + nalog početnog stanja | Ne propisuje mehaniku | ZAK kontra-nalog, izuzet iz motora → **rezultat ne ulazi u kapital** | RIZIČAN (blokira BS) |
| 7 | Kontrolna pravila | Tri sloja: unos (GGB0/OB28), period (OB52), struktura obrasca | Numerisan katalog sa svojom sintaksom | APR ima svoje kontrole pri uvozu | 7 pravila u kodu, **6 tautologija**; `force` automatski i bez traga | RIZIČAN |
| 8 | Više standarda paralelno | Ledgeri 0L / 2L | Delimično | Jedan standard za DOO | Nema — i ne treba | DOVOLJAN |
| 9 | Predaja državi | DRC, XML/XBRL | XML → uvoz na portal | Isključivo elektronski, kvalifikovan potpis zastupnika (čl. 44) | XML postoji, **nikad uvezen**; kolone 3/4/5 umesto 5/6/7; `<Obveznik>` rekonstruisan | NEDOSTAJE |
| 10 | Ko održava formule | SAP (u ceni održavanja) | Vendor, 21–22% licence godišnje | — | Mi sami; nema uputstva ni ekrana | RIZIČAN |
| 11 | Revizorski trag | Konfiguracija sa transportima | Verzija obrasca („2014:1") | Zabrana brisanja proknjiženog, uvid u hronologiju (čl. 28) | Nalozi: **odlično**. Formule: nema verzije, nema „ko je odobrio" | RIZIČAN |
| 12 | Prethodna godina u obrascu | RFBILA00 je stvarno izračuna | „Prenesi set" / uvoz XML / ručno | BS ima 3 kolone iznosa, BU 2 | **Nule**; ručni unos ne preživi ponovni obračun | NEDOSTAJE |

**Gde smo bolji nego što se očekuje:** jedan sloj umesto tri (manje mesta gde se konfiguracija razilazi); izražajniji jezik od SAP-ovog FSV-a (FSV ne ume da oduzme drugu poziciju — SAP-u za to treba drugi alat); rad bez seed-a (bruto bilans radi i sa praznom tabelom formula); i **regresione vrednosti iz predatog obrasca upisane uz kontrolna pravila** (868.293 / 638.633 / 34.636 / 41.817) — sigurnosna mreža koju SAP korisnik mora sam da napravi.

---

## 6. ŠTA SMO OTKRILI I ISPRAVILI

U julu 2026. (commit `9cafad5`, „authentic AOP formulas and three engine defects found by studying BigBit") urađene su četiri stvari. Sve su nastale iz proučavanja kako je BigBit stvarno radio i poređenja sa **predatim** obrascima Servoteha.

### 6.1 Zamenjene su izmišljene formule autentičnim

**Šta je bilo:** raniji skup formula bio je **rekonstrukcija** — neko je pogađao maske iz opšteg APR obrasca. Prave BigBit formule žive u vendorskoj Access tabeli `ZR_AOP_Modla`, koja je binarna u `.MDB` i **nije kod nas** (kod Slaviše, vendora).

**Šta je urađeno:** umesto čekanja na tu tabelu, formule su izvedene iz **predatih obrazaca Servoteha za 2023** (`backend/reports/zr/bs.txt`, `bu.txt`; originali u `_legacy/BigBit26/ZR_validacija/*.pdf`). Sam obrazac nosi formulu: leva kolona daje grupe konta za pojedinačne stavke, a naziv zbirne pozicije u zagradi daje aritmetiku (npr. „А. ПОСЛОВНИ ПРИХОДИ (1002 + 1005 + 1008 + 1009 − 1010 + 1011 + 1012)"). Uz to obrazac nosi i predate brojke — dakle sopstveni test.

**Šta bi se desilo da nije nađeno:** stari skup je, između ostalog, pisao `PSD01*+D01*` — što **broji početno stanje dvaput**, jer dugovni promet već sadrži naloge početnog stanja. Uz to su tokom rada nađene i ispravljene: pozicija 0406 koja je dvostruko brojala dugovni saldo klase 33; konto 039 koji nije imao nijednu poziciju; sintetike 411/412 koje su curele iz pasive; biološka sredstva u pogrešnoj poziciji.

**Šta je provereno, a šta nije:** potpunost 179/179; zbirne pozicije bilansa stanja 66/66 tačno, bilansa uspeha 38/38 tačno; bilans zatvara (868.293 za 2023, 638.633 za 2022, 447.059 za 2021); neto dobitak 34.636 / 41.817; nema preklapanja maski. **Nije** provereno pokretanjem motora nad podacima — o tome §7 R0.

### 6.2 Defekt 1 — odsecanje na nulu (clamp) nije postojalo

**Šta je bilo:** obrazac ne poznaje negativan iznos — znak nose parovi pozicija (1025 poslovni dobitak / 1026 poslovni gubitak). BigBit je odsecao **svaki** upis (`IIf(VrednostIzraza(...)>0, ..., 0)` u svih 8 UPDATE upita). Naš motor to nije radio nigde.

**Šta bi se desilo da nije nađeno — na predatim brojkama za 2023:**
- ukupna pasiva (AOP 0456) bi izašla **1.036.122** umesto **868.293**
- neto dobitak (AOP 1055) bi izašao **143.604** umesto **34.636**

**Kako je rešeno:** odsecanje je ugrađeno **unutar iterativne petlje** (`balance-sheet.service.ts:287`), ne na kraju — jer pozicije koje se pozivaju na drugu poziciju moraju videti **već odsečenu** vrednost. Da je odsecanje na kraju, neto dobitak bi izašao **70.794** umesto 34.636. Odsečene pozicije se pamte sa sirovom negativnom vrednošću i vraćaju u polju `clamped`.

**Šta ostaje:** taj signal se ne vidi na ekranu (§4.2, tačka 6). To je jedini način da se prepozna okrenut smer duguje/potražuje, jer je od 117 pozicija bilansa stanja njih preko 60 u predatom obrascu legitimno nula.

### 6.3 Defekt 2 — zaključni nalog nulirao je ceo bilans uspeha

**Šta je bilo:** naš `closeIncomeStatement` (`backend/src/modules/gl/year-open.service.ts`) knjiži zaključni nalog vrste **ZAK** sa kontra-stavkom **nazad na isto konto** klase 5/6, datiran 31.12., status POSTED. Motor je taj nalog uračunavao.

**Šta bi se desilo da nije nađeno:** `P602*-D602*` = **egzaktna nula**. Dakle **svaka maska bilansa uspeha davala bi nulu** za svaku godinu za koju je urađen prenos u novu godinu. Ceo bilans uspeha bi bio prazan — i to bi izgledalo potpuno „uredno", jer nula nije greška nego broj.

**Kako je rešeno:** svi ZAK nalozi se izuzimaju iz agregacije dugovnog i potražnog prometa (`gkeval.service.ts:402`). Kontrolni test: AOP 1003 na 31.12.2023. mora dati **178.421**; ako izađe 0, ZAK još uvek ulazi.

**Šta ostaje — i to je najteži nalaz celog zapisnika:** ta ista ispravka otvorila je novu rupu. Vidi §7 R1.

### 6.4 Defekt 3 — kontrolno pravilo koje je lažno prolazilo

**Šta je bilo:** stari katalog kontrolnih pravila sadržao je pravilo `1068 = 1064 − 1066`. **AOP oznake 1064, 1066 i 1068 u obrascu 89/2020 ne postoje.** Motor za nepostojeću oznaku vraća nulu, pa je pravilo poredilo `0 = 0` i **uvek prolazilo**. Kontrola koja ništa ne kontroliše opasnija je od kontrole koja pada. Uz to, pravilo `0001 = 0401` bi **tvrdo padalo** sa novim formulama, jer je AOP 0001 „уписани а неуплаћени капитал" (=0), a ne ukupna aktiva (to je 0059).

**Šta bi se desilo da nije nađeno:** ekran bi pokazivao zelenu kvačicu na kontroli neto rezultata i za bilans koji je potpuno pogrešan, a bilans stanja se ne bi mogao finalizovati bez forsiranja.

**Kako je rešeno:** katalog je prepisan na 7 pravila nad **postojećim** AOP oznakama, pisanih kao **parovi** (dobitak − gubitak) jer se radi nad odsečenim vrednostima, sa regresionim vrednostima iz predatog obrasca u komentaru (`control-rules.service.ts:80-147`).

**Šta ostaje:** šest od tih sedam pravila su tautologije (§7 R4), a uvodni komentar u istom fajlu i dalje navodi stare, nepostojeće oznake (§4.2, tačka 17).

---

## 7. RIZICI KOJI OSTAJU — poređani po ozbiljnosti

### R0 — Motor nikad nije pokrenut nad stvarnim podacima
**Posledica:** sve ostalo na ovoj listi je nagađanje, uključujući i tvrdnju da smo blizu. U glavnoj knjizi 4.0 nema knjiženja za 2021–2023, a bruto stanje iz BigBita nije izvezeno. Verifikacija je aritmetička i strukturna, ne izvršavanjem.
**Dokaz:** `ZR_AOP_FORMULE_AUTENTICNE.md` §2.
**Test koji sve rešava:** uvesti bruto stanje za 2023. i pustiti motor. Ako izađe **868.293** na AOP 0059 i 0456 i **34.636** na AOP 1055 — imamo dokaz.

### R1 — Rezultat godine ne ulazi u kapital; bilans stanja ne zatvara
**Lanac, provereno korak po korak:**
1. Seed: AOP 0410 „Neraspoređeni dobitak tekuće godine" = `P341*-D341*` (`migration.sql:198`).
2. `year-open.service.ts:403-407` rezultat godine knjiži na konto **341** (dobitak) odnosno **351** (gubitak) — i to **stavkom unutar zaključnog naloga vrste ZAK** (`:41`, `:299-301`).
3. `gkeval.service.ts:402` iz agregacije izbacuje **sve** ZAK naloge.

Dakle konto 341 u godini N puni isključivo ZAK nalog, koji motor ne vidi → **AOP 0410 = 0**. Aktiva je netaknuta (ZAK dodiruje samo klase 5/6 i konto rezultata), pa je **pasiva manja od aktive tačno za neto dobitak**. Za 2023. to bi bilo 34.636 od 868.293 — promašaj od 4%.

**Dopuna koju treba znati:** isti rezultat dobija se i ako se zatvaranje godine uopšte **ne uradi** — tada je konto 341 prazan, 0410 = 0, a prihodi/rashodi ionako ne ulaze u bilans stanja. Znači bilans stanja za **prvu godinu u sistemu ne zatvara ni u jednom scenariju**.

**Šta nas spasava:** kontrolno pravilo „aktiva = pasiva" ovo hvata i blokira finalizaciju. **Šta nas ne spasava:** ekran automatski nudi `force` (R4).

**Jeftino rešenje za sada:** dozvoliti ZAK nalog samo za konta klase 5/6, a stavku rezultata na 341/351 knjižiti **posebnim nalogom druge vrste**, koji motor ne izuzima. Pola dana posla, bez diranja arhitekture. **Ispravno rešenje kasnije:** preći na SAP-ov model — prenos bez kontra-stavki, konta uspeha kreću od nule, rezultat direktno na konto rezultata; time nestaje i potreba za ZAK filterom i ceo taj razred grešaka. Ali to menja već proknjižene naloge i nije posao za ovu godinu.

### R2 — Iznosi nisu u hiljadama dinara
**Posledica:** APR-u bi otišao broj **1.000 puta veći** — 868.293.000 tamo gde obrazac traži 868.293. Dokument potpisuje direktor kvalifikovanim elektronskim potpisom.
**Zašto ne bi bio uhvaćen:** nijedno kontrolno pravilo to ne vidi — i leva i desna strana bile bi 1.000× veće, pa jednakost i dalje važi. Uhvatio bi ga tek probni uvoz u APR ili knjigovođa koji pogleda broj.
**Dokaz:** nema nijednog `/1000` u `backend/src/modules/zavrsni/` ni na ekranu; BigBit ga je imao (`BIGBIT_ZR_MOTOR.md:78-94`).
**Odluka koja se mora doneti:** da li iznose čuvamo u dinarima pa delimo pri izvozu i prikazu, ili u hiljadama već pri obračunu.

### R3 — Konto van svih maski tiho ispada iz bilansa
**Posledica:** knjigovođa otvori novo konto (npr. 289x) i bilans se tiho iskrivi. Jedini signal je da aktiva ≠ pasiva — bez podatka **koje** konto fali. Danas je poznato **23 konta** iz plana koja ne hvata nijedna maska.
**Popravka (najbolji odnos koristi i troška na celoj listi):** uzeti `grossTrialBalance(asOf)` (već postoji i radi bez formula) i za svako konto sa saldom ≠ 0 proveriti da li ga hvata bar jedna maska; rezultat prikazati uz svaki obračun — SAP-ov „Accounts not assigned". Nekoliko desetina linija koda.

### R4 — `force=true` je jedino dugme, i ne ostavlja trag
**Posledica:** za šest meseci niko — ni knjigovođa, ni revizor, ni vi — ne može iz sistema saznati da je bilans zaključen preko oborene kontrole „aktiva = pasiva". A to je jedina prava kontrola koju imamo.
**Dokaz:** `page.tsx:259-267` (šalje `force: anyFail` automatski); `schema.prisma:4142-4157` (nema kolone).
**Popravka:** izbaciti automatsko forsiranje, tražiti tekstualni razlog, upisati u bazu ko je i kada forsirao i uz koja oborena pravila, i **zabraniti izvoz XML-a za forsiran obračun**.

### R5 — Šest od sedam kontrolnih pravila ne mogu da padnu
**Posledica:** ekran pokaže šest zelenih kvačica i one **ne znače ništa**. Lažna sigurnost.
**Dokaz, uparen red po red:**

| Pravilo | Formula u seed-u | |
|---|---|---|
| `0401 = 0402+0403+0404+0405+0406−0407+0408+0411−0412` | `A0402+A0403+A0404+A0405+A0406-A0407+A0408+A0411-A0412` (`:185`) | isto |
| `1043 = 1001+1027+1039+1041` | `A1001+A1027+A1039+A1041` (`:306`) | isto |
| `1044 = 1013+1032+1040+1042` | `A1013+A1032+A1040+A1042` (`:307`) | isto |
| `1025−1026 = 1001−1013` | `1025 = A1001-A1013`, `1026 = A1013-A1001` (`:288-289`) | isto |
| `1037−1038 = 1027−1032` | `1037 = A1027-A1032`, `1038 = A1032-A1027` (`:300-301`) | isto |
| `1055−1056 = 1049−1050−1051−1052+1053−1054` | `A1049-A1050-A1051-A1052+A1053-A1054` (`:326`) | isto |
| **`0059 = 0456`** | `0059 = A0001+A0002+A0029+A0030`, `0456 = A0401+A0415+A0429+A0430+A0431-A0455` | **dva nezavisna puta — jedina prava kontrola** |

**Popravka:** ne treba ih **više**, treba ih **drugačije**. Jedna prava kontrola — „zbir AOP listova = zbir salda iz bruto bilansa", dakle poređenje sa **nezavisnim izvorom** — vredi više od pedeset prepisanih.

### R6 — Uporedne kolone su nule i ne mogu se popuniti
**Posledica:** obrazac bez kolona 6 i 7 (BS) odnosno 6 (BU) nije potpun; to nije kozmetika. Prve godine korišćenja te kolone biće prazne i to niko neće primetiti dok se obrazac ne pošalje.
**Dokaz:** `balance-sheet.service.ts:421-442` (samo prepis iz sačuvanog obračuna), `:357,373` (`deleteMany` + `createMany` briše ručni unos).

### R7 — 14 MANUAL pozicija = trajna nula, bez načina da se ispravi
**Proverljiv primer:** AOP 0436 predat za 2022. sa **9.400**; naš sistem prikazuje 0. I BizniSoft i Calculus imaju ručnu korekciju AOP iznosa — tržište je smatra obaveznom.

### R8 — Statistički izveštaj se ne može ni napraviti
**Posledica:** obavezan obrazac za sve obveznike, isti rok 31. mart, a kod nas nema ni formula ni rute. Ni BigBit ga nije radio automatski — punio se ručno u APR aplikaciji — pa 4.0 nije korak unazad, ali tvrdnja „sve iz jednog sistema" ne stoji.

### R9 — APR XML: kolone i blok o obvezniku
**Posledica:** XML odbijen ili, gore, prihvaćen sa brojevima u pogrešnim poljima. **Nije blokada** — APR prima i ručni unos.

### R10 — Nekonvergencija prolazi tiho
**Posledica:** obrazac izgleda potpuno normalno, a nije konvergirao. Popravka je oko 10 linija: posle petlje proveriti da li je poslednji prolaz doneo promenu i, ako jeste, vratiti `notConverged` i tretirati kao oboreno kontrolno pravilo.

### R11 — Formule bez godine/verzije
**Posledica:** promena Pravilnika pregazi stare formule; obračun za 2023. se više ne može ponoviti. A izveštaji se čuvaju 20 godina.

### R12 — Motor ne filtrira po firmi
Danas bezopasno (jedno pravno lice), brane nema.

### R13 — Znanje u jednoj glavi
**Posledica:** za pet godina niko ne zna gde formule stoje ni kako se proveravaju. Ovo je jedini rizik koji se ne rešava kodom.

---

## 8. ŠTA TREBA URADITI

### 8.1 Do 31.12. tekuće godine — obavezno (posle toga se ne može popraviti bez retroaktivnog knjiženja)

| # | Šta | Ko | Napomena |
|---|---|---|---|
| 1 | **Utvrditi da li se cela godina knjiži u 4.0** ili paralelno u BigBitu | direktor + knjigovođa | Ako je BigBit — cela priča se pomera za godinu dana i tačke 4–8 mogu da čekaju. Ne traži programera. |
| 2 | **Presuditi veličinu obveznika i obim seta obrazaca** (i potvrditi obavezu revizije) | knjigovođa / revizor | Danas je nagađanje u `process.env`. Od toga zavisi da li ide 2 ili 6 obrazaca. |
| 3 | **Potvrditi da je kontni plan usklađen sa Pravilnikom 89/2020** | knjigovođa | Naš seed kontnog plana je po **starom** kontnom okviru (`ZR_AOP_FORMULE_AUTENTICNE.md` §1). Dok se knjiži u ista konta i bilans zatvara, praktične štete nema, ali svaka buduća izmena vraća nas na isto pitanje. |
| 4 | **Popraviti knjiženje rezultata godine** (R1) — stavka na 341/351 van ZAK naloga | programer, ~pola dana | Bez ovoga bilans stanja ne zatvara. ZAK nalog se knjiži 31.12. — zato je ovo rok, ne želja. |
| 5 | **Kontrola pokrivenosti konta** (R3) | programer, ~1 dan | Da nijedno konto sa saldom ne ostane van maski. Rezultat je lista za knjigovođu. |
| 6 | **Zameniti šest tautoloških pravila jednom pravom kontrolom** (R5) | programer, ~1 dan | Zbir AOP pozicija protiv zbira iz bruto bilansa. |
| 7 | **Skaliranje na hiljade** (R2) | programer, ~pola dana | Odluka + nekoliko linija. Mora pre nego što se bilo šta pošalje APR-u. |
| 8 | **Izbaciti automatsko forsiranje i dodati kolonu „forsirano"** (R4) | programer, ~pola dana | Plus polje „proverio/odobrio" na obračunu. |
| 9 | **Uvesti bruto stanje iz BigBita za 2023. i pustiti motor** (R0) | programer + knjigovođa, 2–3 dana | **Ovaj test vredi više od svih ostalih zajedno.** Ali ga raditi tek posle tačke 4 — inače garantovano pada iz razloga koji već znamo i ne naučimo ništa novo. |

### 8.2 Januar–mart naredne godine — poželjno (ne dira knjige, samo prikaz i izvoz)

| # | Šta | Zašto tada |
|---|---|---|
| 10 | **Probni uvoz našeg XML-a u APR aplikaciju** sa lanjskim brojkama | Aplikacija se otvara krajem januara. Jedan sat posla; ruši i pitanje kolona 5/6/7 i blok `<Obveznik>`. |
| 11 | Ručni unos 14 MANUAL pozicija i uporednih kolona, tako da **preživi ponovni obračun** | R6, R7 |
| 12 | Prikaz odsečenih (`clamped`) pozicija na ekranu | Jedini signal za okrenut smer duguje/potražuje |
| 13 | Upozorenje o nekonvergenciji i o praznoj uporednoj koloni umesto tihe nule | R10 |
| 14 | **Godina / verzija na formulama** | R11 — jedini pravi defekt modela |
| 15 | Očistiti uvodni komentar u `control-rules.service.ts` (navodi nepostojeće AOP oznake) | §4.2 t.17, sitno ali baš tu će sledeći čovek gledati |
| 16 | Godišnji **arhivski paket** — izvoz dnevnika i glavne knjige u čitljiv format sa opisom kolona | Član 28 Zakona; deo zatvaranja godine |
| 17 | **Jednostrana uputa „šta se radi kad se promeni Pravilnik"** | R13. Osiguranje protiv odlaska čoveka; vredi više od svega ostalog na listi. |
| 18 | Statistički izveštaj (formule + ruta) — **ako** obim seta to traži (tačka 2) | R8 |

### 8.3 Ne graditi — i zašto

| Šta | Zašto ne |
|---|---|
| **Paralelni ledgeri (IFRS + lokalni GAAP)** | Servoteh je jedno DOO sa jednim standardom. Čisto bacanje vremena. Tek ako se ikad ukaže potreba za drugim pogledom („bilans pre/posle revizije") — dodati `ledger_code` na naloge. Do tada ne. |
| **Financial Closing Cockpit kao poseban alat** | Za jednu firmu je lista koraka u dokumentu dovoljna. |
| **Prepisivanje celog APR kataloga kontrolnih pravila u našu bazu** | APR-ova aplikacija ionako pušta svoje kontrole pri uvozu i odbiće nas ako nešto ne štima. Duplikat tuđe kontrole je nekoliko dana posla za nula koristi. Jedna prava kontrola (R5) vredi više. |
| **Ekran za izmenu formule dvoklikom (Calculus model)** | Zvuči korisno, a za nas je korak **unazad** za reviziju: formule danas žive u git migraciji, sa autorom, datumom i mogućnošću vraćanja. Ekran koji dozvoljava izmenu bez traga to gubi. Ono što stvarno treba je **verzija/godina** na formuli (tačka 14), ne dugme za izmenu. |
| **Prelazak na SAP-ov model zatvaranja godine sada** | Ispravan u principu, ali dira već proknjižene naloge i traži novu migraciju. Isti problem se rešava za pola dana (tačka 4). Ostaviti za kad se bude dirala godišnja procedura. |
| **Kompatibilni pogledi, in-memory optimizacije, 20 nivoa hijerarhije** | SAP to ima jer opslužuje hiljade firmi. Naša glavna knjiga se meri desetinama hiljada stavki godišnje; PostgreSQL to radi bez napora. Jedina praktična obaveza su indeksi nad `ledger_entries(account_code)` i `journal_entries(posting_date, status)`. |

---

## 9. PITANJA ZA KNJIGOVOĐU I ZA APR

### 9.1 Za knjigovođu — odluke koje programer ne sme da donese

**Status i obim:**
1. Kako se Servoteh razvrstava po članu 6 (mikro/malo/srednje/veliko) za poslednju i tekuću godinu? Potreban je **prosečan broj zaposlenih** — nije u bilansu, nego u Statističkom izveštaju.
2. Potvrda da smo obveznik revizije (prihod preko 4.400.000 EUR). Ako jesmo — rok za revizorsku dokumentaciju je 30. jun, i treba nam put za ispravku obračuna **posle** finalizacije.
3. Koji tačno set obrazaca predajemo — samo BS i BU, ili pun set od šest plus Napomene?
4. Da li se cela poslovna godina knjiži u ServoSync 4.0, ili paralelno u BigBitu?
5. Da li Servoteh ima donet i ažuriran **opšti akt o organizaciji računovodstva** (član 8) koji opisuje interne kontrole i baš ovaj softver? Revizor ga traži prvog dana. **NEPOZNATO.**
6. Ko je formalno „lice odgovorno za vođenje poslovnih knjiga" — treba da bude polje u sistemu, jer po članu 43 deli odgovornost za bilans.

**Konkretna knjigovodstvena pitanja iz kojih zavise formule** (iz `ZR_AOP_FORMULE_AUTENTICNE.md` §8):

7. **Konto 2090** (Ispravka vrednosti potraživanja od kupaca) — obrazac ga ne pominje. Raspoređuje li se po podpozicijama ili ide cela u „kupci u zemlji"? *Privremeno: cela u AOP 0039.*
8. **Konto 20200 „Kupci u zemlji - analitika"** — povezano lice ili običan kupac? Od toga zavisi da li 97.762 ide u AOP 0039 ili 0041.
9. **Konto 723** — kod nas „Prenos dobitka ili gubitka". Postoji li uopšte konto za „Исплаћена лична примања послодавца" (AOP 1054)? *Privremeno MANUAL.*
10. **Konta 4200, 4210, 4211** — stoje pod 420/421 (povezana lica) iako su bankarski krediti. Kako su prijavljeni — 0434 ili 0437?
11. **AOP 0436 vs 0437 za 2022** — po kom kriterijumu je 9.400 razdvojeno od 11.731?
12. **Konta 2990 „PORSCHE LEASING NEDOSPELA KAMATA" i 290** — u kojoj AOP poziciji su prijavljeni? Danas ih ne hvata nijedna maska.
13. **Konto 0121 „Ispravka vrednosti goodwill-a"** — je li to zapravo ispravka softvera (stoji ispod 012 Softveri)?
14. **Konta 404 (rezervisanja za beneficije zaposlenih) i 467 (kratkoročna rezervisanja)** — ne postoje u našem planu. Ako se otpremnine/jubilarne rezervišu, gde se knjiže?
15. **Konta 6103 i 6042** — obrazac ih po broju konta svrstava u domaću prodaju (1006) odnosno prodaju robe (1003). Je li i knjigovođa tako predao?
16. **Konto 722** — sintetika se zove „Lična primanja poslodavca", a analitika 7220 je „ODLOŽENA PORESKA SREDSTVA-OBAVEZE". Knjiži li se na 722 išta osim odloženog poreza?

### 9.2 Za APR (ili za proveru u njihovoj aplikaciji)

17. **Koje tačno AOP pozicije aplikacija sada računa sama** (novina za izveštaje od 2025)? Da li naš XML sme te pozicije uopšte da šalje, ili ih mora izostaviti? Javni tekst ne daje spisak — **NEPOZNATO**.
18. **Koja je tačna XSD šema FiForma XML-a** za uvoz — konkretno nazivi elemenata u bloku sa podacima o obvezniku (PIB, matični broj, naziv, veličina, šifra delatnosti)? Naš blok je rekonstrukcija.
19. **Koji je tačan redni broj kolone** za iznos tekuće i prethodnih godina u XML atributu (`aop-XXXX-N`)? Iz predatog obrasca izgleda 5/6/7 za BS i 5/6 za BU, ali to nije potvrđeno uvozom.
20. **Prihvata li aplikacija delimičan uvoz** (samo BS i BU), pa se ostali obrasci popune ručno?

*Napomena: pitanja 17–20 najbrže se rešavaju **jednim probnim uvozom** našeg XML-a sa lanjskim brojkama u APR-ovu aplikaciju, čim se otvori krajem januara. Sat vremena, a ruši najveću tehničku nepoznanicu.*

---

## Prilog — spisak izvora

**Propisi i država:**
- Zakon o računovodstvu, „Sl. glasnik RS" 73/2019 i 44/2021 — https://www.paragraf.rs/propisi/zakon-o-racunovodstvu-2020.html
- Pravilnik o obrascima FI, „Sl. glasnik RS" 89/2020 — https://www.paragraf.rs/propisi/pravilnik-sadrzini-formi-obrazaca-finansijskih-izvestaja-za-privredna-drustva-zadruge.html
- Pravilnik o Kontnom okviru, „Sl. glasnik RS" 89/2020 — https://mfin.gov.rs/sr/propisi-1/pravilnik-o-kontnom-okviru-i-sadrzini-racuna-u-kontnom-okviru-za-privredna-drustva-zadruge-i-preduzetnike-sluzbeni-glasnik-rs-br-892020-1
- Zakon o reviziji — https://www.paragraf.rs/propisi/zakon_o_reviziji.html
- APR, finansijski izveštaji i rokovi — https://www.apr.gov.rs/registri/finansijski-izvestaji.2069.html
- APR, novine za 2025. — https://www.apr.gov.rs/registri/finansijski-izvestaji/uputstva-za-sastavljanje-i-dostavljanje-finansijskih-izvestaja-odnosno-dokumentacije-/novine-u-finansijskom-izvestavanju-za-2025-godinu.4735.html
- Nacrt novog Zakona o računovodstvu (24.04.2026) — https://mfin.gov.rs/sr/propisi-1/nacrt-zakona-o-raunovodstvu-1

**SAP:** help.sap.com (FSV/OB58), SAP note 3525986 i 3460840 („accounts not assigned"), note 1842452 (debit/credit shift), SAP Community (FAGLGVTR/F.16), SAP note 3507420 (Srbija u DRC — sadržaj iza prijave).

**Region:** https://www.datalab.eu/pantheon-license-prices/ · https://connectsoftware.rs/pantheon/cenovnik/cenovnik-licenci/ · https://uputstvo.calculus-portal.rs/help/srp_sr/fink/fink_C1.11.html · https://www.biznisoft.com/wp-content/uploads/2026/02/Formiranje_finansijskih_izvestaja_za_2025.pdf (citati nepotvrđeni) · https://help.minimax.rs/help/godisnje-obrade-ceo-postupak · https://learn.microsoft.com/en-us/dynamics365/business-central/about-localization

**Naš kod i dokumentacija** (worktree `c:\Users\nenad.jarakovic\wt\bigbit-remedijacija`):
- `backend/src/modules/zavrsni/{gkeval,balance-sheet,control-rules,apr-xml}.service.ts`, `zavrsni.controller.ts`, `statement-type.ts`, `gkeval.service.spec.ts`
- `backend/src/modules/gl/{year-open,gl-write}.service.ts`
- `backend/prisma/schema.prisma` (`FinancialStatement` :4142, `BalanceFormulaDefinition` :4192, `orderTypeCode` :3011)
- `backend/prisma/migrations/20260726090000_seed_balance_formulas_autenticne/migration.sql`
- `backend/docs/migration/{ZR_AOP_FORMULE_AUTENTICNE,ZR_ISPRAVKE_MOTORA,BIGBIT_ZR_MOTOR}.md`
- `backend/reports/zr/{bs,bu}.txt` — predati obrasci Servoteha za 2023.
- `frontend/src/app/zavrsni-racun/page.tsx`, `frontend/src/api/zavrsni.ts`

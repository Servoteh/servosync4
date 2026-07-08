# Analiza: Modul CARINA / carinjenje robe (legacy BigBit / SERVOTEH ERP)

Izvor: `Carina - 20 06 2023.docx`
Autor: Tatjana Jarakovic (adm nabavke/uvoza-izvoza) · Kreirano 2023-06-19, izmenjeno 2023-06-20 · revizija 4
Broj screenshotova (PNG): **9** (image1–image9); EMF/WMF: 0.

> **Ključna napomena o karakteru dokumenta.** Ovo NIJE tehnička specifikacija forme za carinu. To je narativno **uputstvo za rad** (radna procedura) referenta uvoza/izvoza koje opisuje *poslovni proces* carinjenja u Servotehu. Iz njega se vidi bitna arhitektonska činjenica: **sam obračun carine i PDV-a na uvoz (JCI/carinska deklaracija) NE radi se u BigBit ERP-u — radi ga špedicija.** BigBit se u ovom procesu koristi samo za izradu **profakture (Ino profaktura)**, **normativa** i **izjava** koji se šalju špediciji/carini. Carinski trošak i zavisni troškovi se naknadno, ručno, uračunavaju u nabavnu cenu kroz „završnu kalkulaciju“. Ovo je presudno za skoping ServoSync 4.0 (vidi §5).

---

## 1. Kompletan tok CARINJENJA (dokumenti, redosled, veze)

Dokument pokriva pet povezanih carinskih postupaka. Za svaki je opisan tok dokumenata.

### 1.1 Redovan UVOZ
1. **Najava nabavke** (npr. redovan uvoz pneumatike stiže ponedeljkom za avionske pošiljke). Fakture dobavljača stižu na mail (npr. Emerson šalje na `tatjana.jarakovic`), referent ih odmah prosleđuje špediciji jer originali često ne stignu uz robu.
2. **Prevod računa (fakture) za carinu** — radi se i šalje špediciji radi **tarifiranja robe** i **određivanja stope carine** (određuje se tarifni broj → carinska stopa).
3. **Dokazivanje porekla (za oslobođenje od carine):**
   - **EUR1** — traži se od dobavljača.
   - **EU statement / izjava o preferencijalnom poreklu** — dovoljna umesto EUR1 ako je vrednost pošiljke **< 6.000 EUR**; mora biti na fakturi, i to **na zadnjem delu fakture** (ne na vrhu/sredini). Servoteh dobavljaču šalje primer teksta izjave (vidi image1/image2).
   - Ako roba ne prati EUR1/izjava i to se ne može naknadno dostaviti → **plaća se carina na te stavke**.
   - Poreklo koje daje oslobođenje: **EU preferencijalno poreklo** i **tursko poreklo**.
4. **Dodatna dokumentacija po vrsti robe:**
   - Polovna roba: izjava da je u funkcionalnom stanju i da se koristi u proizvodnji + slike/serijski brojevi (za mašine).
   - Veći iznosi: **SWIFT** (dokaz plaćanja) ako carina traži.
5. **Plaćanje carinskog računa** — ako firma nema **bankarsku garanciju**, referent šalje adm prodaje da plati carinski račun; plaćanje se isprati.
6. **Zatvaranje / knjiženje:** posle završenog postupka štampa se carinska dokumentacija + fakture ino dobavljača i špedicije → sve se poveže → upiše se **broj porudžbine** → daje se **na knjiženje**.
7. **Prispeće robe:** koordinacija sa magacinom (praćenje prispeća, obaveštavanje). Ako špedicija ne dostavlja ili je hitno → šalje se vozač.

**Specifičnosti špedicije / transporta koje utiču na tok:**
- Za robu iz Kine brodski — Servoteh sam organizuje transport da izbegne lučke troškove.
- Fedex (=TnT) najjeftiniji za transport, ali traži da se **faktura za transport (stiže preko SEF-a) izmiri PRE uvoznog carinjenja**; ako je hitno → prebacuje se drugoj špediciji (najčešće Californija).
- Aventics: dokumentaciju šalje Gebruder uz robu, pa se korak štampe/povezivanja preskače.

### 1.2 Privremeni UVOZ
- Radi se kad se roba (uglavnom van garancije) šalje na **servis/doradu** u inostranstvo.
- **PDV:** ako roba nije u garantnom roku → **plaća se PDV**; ako jeste u garanciji → **ne plaća se**.
- Roba se šalje uz **Proformu (Ino profaktura)** sa obaveznim tekstom: **„Free of charge. The value is only for customs purpose. Returning parts.“** Cena se stavlja okvirno, **što niža moguća**.
- Proforma se snima kao PDF (desni klik → štampač → Ino prof → PDF). Za domaću carinu štampa se i **primerak na srpskom** — zato pri unosu artikala treba popuniti i **ino naziv** pored srpskog naziva.
- **Zatvaranje:** kad se roba vrati, zatvara se privremeni uvoz; poželjno da to radi **ista špedicija** koja je radila izvoz. Dobavljač fakturiše servis/popravku i time se postupak zatvara.
- RGB Electronic (remont): popunjava se njihov obrazac, šalje mailom + original uz robu; obavezno se upisuju **serijski brojevi** uređaja.

### 1.3 Aktivno oplemenjivanje (postupak s ekonomskim dejstvom)
Uvozna roba je sastavni deo gotovog proizvoda koji se ponovo izvozi; carinske povlastice (odlaganje/povraćaj uvoznih dažbina). Primer: izvoz kontejnera za Dedienne (Dubai, Francuska, Katar).

Dva sistema:
- **Sistem odlaganja** (koji je Servoteh primenjivao): na stranu robu namenjenu ponovnom izvozu u obliku gotovog proizvoda **ne plaća se carina** niti roba podleže merama trgovinske politike.
- **Sistem povraćaja:** roba se stavlja u slobodan promet uz plaćanje dažbina, a nosilac odobrenja ostvaruje **povraćaj carinskog duga / otpust carine** kad se roba izveze kao gotov proizvod.

Tok dokumenata (čuva se uz svaki radni nalog; vidi folder na image5):
1. **Ugovor sa kupcem** (sam se piše po primeru, prilagodi ponudi; obavezno potpisan primerak za carinu).
2. **Izjava** o nameni privremenog uvoza (opšta forma, prilagođava se svakoj porudžbenici; vidi image7).
3. **Normativ** (utrošak materijala) — pravi se u komunikaciji sa tehničkim licem/projektantom; artikli + količine + na koji deo tehničke dokumentacije se odnose (vidi image6).
4. Po okončanju postupka dobija se i čuva **JCI na kojem MORA da piše „UV 5“** — ako ne piše, nije taj postupak (treba proveriti jer se i carina prevari; vidi image8).
5. Carina određuje **datum do kog se postupak mora zatvoriti** (može se produžavati).
6. **Zatvaranje pri izvozu gotovog proizvoda:** špediciji se šalje sva uvozna dokumentacija (JCI + izjave), po potrebi normativi i tehnička dokumentacija (zavisi od tarifnog broja). Kad se roba izveze → špedicija šalje **razduženje**, Servoteh potpisuje njihov primerak.

### 1.4 Redovan IZVOZ
- Trgovačka roba uz odbranu porekla → dostavlja se **uvozni JCI**; za dalju prodaju robe od domaćih dobavljača traži se od njih **JCI ili izjava o poreklu**.
- Izvoz gotovog proizvoda → pravi se **normativ + izjava o utrošku materijala i radne snage**; ako je iznos **> 6.000 EUR** → sprema se **EUR1** + prilažu **ulazne fakture dobavljača**.
- Sve se čuva u folderu „izvoz“ po kupcu i godini (vidi image9).
- Za robu sa dozvolom → špediciji se šalje da zatvori postupak u celosti ili otpiše razdužene stavke.

### 1.5 Uticaj na nabavnu cenu (raspodela troškova) — sažetak pravila
- **EU preferencijalno / tursko poreklo** → nema carine, samo pripadajući **PDV**, a **PDV NE utiče na nabavnu cenu** pri završnoj kalkulaciji.
- **Carina** (kad se plaća) i **svi ostali zavisni troškovi** (transport, špedicija, lučki troškovi…) → **UTIČU na nabavnu cenu** i vode se u računu pri nabavci.
- Zato se pri traženju ino ponuda nastoji dobiti cena **sa ukalkulisanim troškovima transporta** (za manje pošiljke jeftinije nego kad Servoteh sam organizuje transport); za gabaritnu robu traži se i ponuda transporta od dobavljača i lokalno pa se bira najpovoljnija.

> **Kako se troškovi raspoređuju na nabavnu cenu:** dokument ne sadrži algoritam/formulu raspodele — proces je opisan poslovno. Carina + zavisni troškovi ulaze u **„završnu kalkulaciju“** nabavne cene (van BigBit forme prikazane u dokumentu). PDV se izuzima. Konkretan ključ raspodele (po vrednosti / težini / stavci) NIJE dokumentovan — to je otvorena stavka za razjašnjenje (§5).

---

## 2. Forme / ekrani (iz screenshotova)

### 2.1 FORMA: „Profakture" (BigBit / SERVOTEH 2023) — image3 (glavni ekran)
Access forma za izradu profakture/ino profakture; u dokumentu se koristi za **privremeni uvoz/izvoz (Returning parts)**.

**Zaglavlje / traka sa dugmadima:**
`Prepiši iz ulaza po predmetu` · `Novi dokument` · `Prepiši profakturu` · `Pregled artikla` · `Naručivanje robe` · `Nalog magacinu` · ikonica štampača · `STOP` · `Vezana profaktura` · `Dokument bez cena` · `Lager lista` · `Stanje u valuti` · `Raskin…`
- `Tekst na reportu:` (dropdown) = **Profaktura**
- `Tekući račun:` = 160-110610-83

**Polja zaglavlja dokumenta:**
- `Šifra` kupca = 1002206 · `Kupac/Prodavnica` · `Naziv` = DMG MORI Spare parts G… · `Mesto` = Geretsried · `K. osoba`
- `Datum knjiženja` = 07-04-21 · `Vrsta dok.` = **PROF** · `Broj dokumenta` = 0190 · `Datum dok.` = 07-04-21 · `Plaćanje u roku` · `Valuta` = **EUR** · `Potpisa…`
- `Radni nalog` = 0 · `Mesto` = Beograd · `Datum prometa` = 07-04-21 · `Način otpreme` · `Uslovi plaćanja`
- `Fco` = **DAP** (paritet isporuke) · `Opis dokumenta` · `Predmet` = 210407 · `Broj naloga` = 210407 · `Vrsta naloga` = **OTP** · `Prodavac` = Tatjana Jarakovic · `Izlaz iz magacina` = Magacin robe · `Pros. cene` (čekboks ✓)
- `Uzmi cene iz cenovnika` = **STDCN** · `Rezerviši količine` · `Kurs` = **1.00** · `Dev. valuta` = **EUR**
- Žuto polje (memo/napomena na reportu): **„Free of charge. The value is only for customs purpose. Returning parts. Delivery address: DMG MORI Spare Parts GmbH, Returns department, Lausitzer Straße 7, DE-82538 Geretsried, Germany; Phone…; Attn: Mr. Christian Hindinger"**

**Grid stavki (kolone):**
`Kat. broj` · `Naziv artikla` · `Odloženo` · `Količina` · `Mera` (Kom) · `Fakturna c.` (fakturna cena) · `R. %` (rabat %) · `K. %` · `VP cena` (veleprodajna) · `PP Proizv.` (=3, PDV/poreska grupa proizvod) · `PP Usluga` (=1, PDV/poreska grupa usluga)
(primer stavki: 2542704 „GS*20- 0*Mast*L- 800*900g", 27081739 „AX- S- KUG- LAG*40*115*42*DKLF 2"… — kataloški brojevi + ino nazivi)

**Podnožje — obračunske sume (desno):**
- `Mag.vred.` (magacinska vrednost) = 5.928,51
- `Rabat` = 0,00 · `Ekstra rabat` = 0,00
- `VP vrednost` = 5.928,51
- `Porez` = **1.185,70** (= 20% od 5.928,51 → **PDV 20%**)
- `Sa porezom` = **7.114,21**

**Podnožje — detalj tekuće stavke (levo):**
- `Magacin` = Magacin robe · `PC` (✓) · `Zalihe` · `BSM`
- `Kat. broj`/`Artikal` · `Tr.Pak.` · `Kutija` · `Količina`
- `Fakturna c.` = 44,83 · `R. %` · `exR %` · `Prod.VP cena` = 44,83 · `PP Proizv.` (3) · `PP Usluga` · `MP cena` = **53,80** (= VP × 1,20 → maloprodajna sa PDV)
- `Odl.pl.` · `Nab. cena` = 0,00 · `Mag.VPcena` = 0,00 · `KNG Cena` = 44,83 · `Uk. zalihe` · `Rez. kol.` · `Slobodno` · `Predmet`
- Dugmad: `Kartica artikla` · `Cenovnik` · `Nova stavka`
- Navigacija: `Record: 1 of 11`

> **Poslovna pravila iz forme:** dokument je vezan za `Predmet`/`Broj naloga` (case/predmet br. 210407) i `Radni nalog` — ključna veza carinskog predmeta ka nabavci/proizvodnji. Cene se preuzimaju iz cenovnika (`STDCN`), obračun poreza je 20% PDV (grupa `PP=3` za robu). `Kurs` i `Dev. valuta` na formi omogućavaju devizni dokument (EUR).

### 2.2 „Veza sa" — meni tipova reporta/dokumenata — image4
Dropdown pri štampi profakture, nudi izlazne dokumente:
`Profaktura` · `Profaktura bez rabata` · `Profaktura sa neto cenama` · `Narudžbina magacinu` · **`Ino Profaktura`** · **`Ino Profaktura - Engleski`** · **`Ino Ponuda - Engleski`** · `InoPonuda bez rabata - Engleski` · `KNG Profaktura` · `KNG2 Profaktura`
> Za carinu se koriste **Ino Profaktura** i **Ino Profaktura - Engleski** (dvojezično: srpski primerak za domaću carinu + engleski za ino dobavljača/špediciju).

### 2.3 Primeri izjava o poreklu (šablonski dokumenti, ne forme)
- **image1:** EU preferencijalno poreklo (EN) — „The exporter of the products covered by this document (customs authorization No. **DE/5100/EA/0402**) declares that… these products are of **European Community preferential origin**." (primer koji Servoteh šalje dobavljaču).
- **image2:** EU preferencijalno poreklo (EN) sa potpisom — Zofingen, Dec 1 2017, H. Trenner, **DIPECO LTD, CH-4800 Zofingen** (realan primer izjave na fakturi).

### 2.4 IZJAVA o nameni privremenog uvoza — image7
`IZJAVA br.03/2020` — namena privremenog uvoza komponenti za projekat izrade „SES STORAGE BOX – CONTAINER 1/2" za Dedienne. Referiše porudžbenice (orders DCF1900535, DCF1900591), opisuje da Servoteh proizvodi sklop (čelični kontejner za skladištenje/transport rastavljenih motora aviona), koje komponente nabavlja/uvozi sam a koje dostavlja naručilac, i navodi **adresu aktivnog oplemenjivanja: Ugrinovačka 163, 11272 Dobanovci**. → obrazac „Izjava aktivnog oplemenjivanja".

### 2.5 NORMATIV (tabela) — image6
Tabela normativa (utrošak materijala) sa kolonama:
`B` · **`Kataloški broj`** · **`Tarifni broj`** (carinska tarifa) · `Naziv` · `Jed. mere` (Kom) · `Kol.` · `Detalj` (referenca na deo tehničke dokumentacije)
Primeri redova: `15142 Size 6.4` / `73269098` / Okce za podizanje / 90 kom; `200-4703.03` / `39081` / Rucka / 3; `93715A635` / `84834090` / Navojni umetak / 3; `CHAMK-S75-N` / `39081` / Točak / 12.
> Normativ direktno nosi **tarifni broj po stavci** — spona artikla ka carinskoj tarifi.

### 2.6 JCI / carinska deklaracija (skenirani obrazac) — image8
Skenirana carinska deklaracija (PDF, čitač): polje `1. DEKLARACIJA` = **„UV 5"** (oznaka postupka aktivnog oplemenjivanja/privremenog uvoza — mora da piše UV 5), `A ODREDIŠNA CARINARNICA` = CI Aerodrom Beograd **11410 / 264**, `3. Obrasci` = 01/01, `5. Naimen.` = 001, `6. Broj paketa` = 1, `7. Referentni broj`. → potvrđuje da je JCI eksterni carinski dokument (od carine/špedicije), ne generisan u BigBit-u.

### 2.7 Struktura foldera (fajl-sistem, ne ERP) — image5 i image9
- **image5:** `srv\SHARES\Predmeti\Predmeti_2020\DEDIENNE AEROSPACE FZCO\Aktivno\Aktivno QCC200004-3 qcc200005-3` — dokumenti: Contract (doc+pdf), DCF2000127 SERVOTEH, **Izjava aktivnog oplemenjivanja**, **Normativ, privremeni uvoz -Kontejneri (korigovan / -2)**, servoteh c5-1775, Ugovor konacni za obe posiljke.
- **image9:** `SHARES\Predmeti\Predmeti_2023\TRB` — folder `Izvoz` + PDF-ovi (391-23, 395-23…).
> Carinska dokumentacija se čuva **po predmetu/kupcu/godini na deljenom disku (SHARES)**, van baze — vezano preko `Predmet`/broja naloga iz BigBit-a.

---

## 3. Veze ka drugim modulima (kako je danas)

| Modul | Veza / dodirna tačka |
|---|---|
| **Nabavka (uvozne porudžbine)** | Profaktura vezana za `Predmet`/`Broj naloga` (210407) i porudžbenice (npr. DCF…); prevod fakture → tarifiranje; poreklo (EUR1/izjava) traži se od dobavljača u nabavci. |
| **Magacin / zalihe** | `Izlaz iz magacina` = Magacin robe; koordinacija prispeća robe sa magacinom; polja `Uk. zalihe`, `Rez. kol.`, `Slobodno`, `Nalog magacinu`. |
| **Kalkulacija cene koštanja** | Carina + zavisni troškovi ulaze u „**završnu kalkulaciju**" nabavne cene; PDV se izuzima. Polja `Nab. cena`, `Mag.VPcena`, `KNG Cena`, `Fakturna c.` na formi. |
| **Finansije / knjiženje** | Posle carinjenja: povezivanje carinske dokumentacije + faktura ino dobavljača i špedicije → upis broja porudžbine → **„daje se na knjiženje"**; carinski račun se plaća (adm prodaje) osim kad postoji bankarska garancija. |
| **Kursne liste / devize** | Devizni dokument: `Valuta`/`Dev. valuta` = EUR, `Kurs` = 1,00; pragovi u EUR (6.000 EUR za EUR1 vs. EU statement). |
| **Proizvodnja / radni nalog** | Aktivno oplemenjivanje vezano za **radni nalog** (dokumentacija se čuva uz radni nalog); normativ prati proizvodni sastav; `Radni nalog` polje na formi. |
| **Špedicija (eksterno)** | JCI, obračun carine/PDV, razduženje postupka — **rade špediteri** (Gebruder, Schenker, Fedex/TnT, Californija); BigBit im samo isporučuje profakturu/normativ/izjave. |

---

## 4. Šifarnici i obračunska pravila

**Šifarnici (identifikovani):**
- **Carinska tarifa / tarifni broj** — po stavci normativa (`Tarifni broj`: 73269098, 39081, 84834090, 73181595, 73269098…); određuje carinsku stopu; utvrđuje se prevodom računa (tarifiranje).
- **Valute / devize** — EUR (Valuta, Dev. valuta), RSD; kurs na dokumentu.
- **Kursna lista** — polje `Kurs` (u primeru 1,00 jer je dokument u EUR).
- **Šifra kupca/dobavljača** — 1002206 (DMG MORI).
- **Cenovnik** — `STDCN` (standardni cenovnik, izvor cena stavki).
- **Poreske/PDV grupe** — `PP Proizv.` = 3 (roba), `PP Usluga` = 1 (usluga).
- **Vrsta dokumenta / naloga** — `PROF` (profaktura), `OTP` (otprema).
- **Paritet isporuke (Fco)** — DAP i sl. (Incoterms).
- **Oznaka carinskog postupka** — „UV 5" na JCI (aktivno oplemenjivanje / privremeni uvoz).
- **Špediteri** — Gebruder, Schenker (Šenker), Fedex/TnT, Californija.

**Obračunska pravila (iz dokumenta):**
- **PDV na uvoz = 20%** (Porez 1.185,70 = 20% × VP 5.928,51; MP cena 53,80 = VP 44,83 × 1,20).
- **PDV ne ulazi u nabavnu cenu**; carina i zavisni troškovi ulaze.
- **Carinska stopa** = funkcija tarifnog broja (nije tabelirana u dokumentu).
- **Prag 6.000 EUR:** ispod → EU statement/izjava na fakturi dovoljna; iznad → EUR1 + ulazne fakture dobavljača.
- **Oslobođenje od carine:** EU preferencijalno poreklo, tursko poreklo, aktivno oplemenjivanje (sistem odlaganja); privremeni uvoz u garanciji = bez PDV, van garancije = sa PDV.
- **Formula raspodele zavisnih troškova na artikle: NIJE dokumentovana** (radi se u „završnoj kalkulaciji" van prikazane forme).

---

## 5. Za ServoSync 4.0 — šta MORA da se prenese

### 5.1 Entiteti (domenski model)
- **CarinskiPredmet / CustomsCase** — vezan na `Predmet`/`Broj naloga`, radni nalog i nabavnu porudžbinu; tip postupka: redovan uvoz / privremeni uvoz / aktivno oplemenjivanje / redovan izvoz.
- **CarinskaDeklaracija (JCI)** — broj, carinarnica, oznaka postupka (npr. „UV 5"), datum, rok za zatvaranje, status (otvoren/razdužen), veza na predmet. (Podaci dolaze od špedicije — model mora podržati unos/uvoz eksternih JCI.)
- **Normativ / BOM za carinu** — stavke: kataloški broj, **tarifni broj**, naziv (srpski + ino), jed. mere, količina, detalj (referenca tehničke dokumentacije), veza na radni nalog/proizvod.
- **DokazPorekla** — tip (EUR1 / EU statement / izjava o poreklu / tursko poreklo), vrednost, prag 6.000 EUR, dobavljač, fajl.
- **Izjava** (privremeni uvoz / aktivno oplemenjivanje) — šablonski dokument po porudžbenici/predmetu.
- **ZavisniTrošak (landed cost)** — vrsta (carina, špedicija, transport, lučki, SWIFT/bankarski), iznos, valuta, veza na predmet, **flag „ulazi u nabavnu cenu" (carina=da, PDV=ne)**.
- **CarinskaTarifa (šifarnik)** — tarifni broj → carinska stopa (+ PDV grupa); danas nedostaje u ERP-u, treba ga uvesti.
- **Valuta / KursnaLista** — kurs po datumu, devizni dokumenti.
- **Špediter (dobavljač usluge)** — sa pravilima (Fedex plaća transport pre carinjenja preko SEF-a; ista špedicija zatvara privremeni uvoz).
- **Paritet (Incoterms/Fco)**, **PoreskaGrupa (PP)**.

### 5.2 Obračunska pravila (moraju u kalkulaciju)
- **Landed cost / završna kalkulacija nabavne cene:** carina + svi zavisni troškovi (osim PDV-a) raspoređuju se na artikle → nabavna cena. **KRITIČNO / OTVORENO:** definisati ključ raspodele (po vrednosti stavke / po težini / ravnomerno) — u legacy dokumentu nije zapisan; potrebna potvrda sa Negovanom/Nesom i referentom uvoza.
- **PDV na uvoz 20%**, ali **eksplicitno isključen iz nabavne cene** (samo poreska obaveza).
- **Carinska stopa iz tarifnog broja** (šifarnik carinske tarife po stavci normativa).
- **Poreklo → oslobođenje:** logika EU/tursko preferencijalno = bez carine; prag 6.000 EUR za EUR1 vs. izjava.
- **Postupci sa ekonomskim dejstvom:** aktivno oplemenjivanje (odlaganje/povraćaj), privremeni uvoz (PDV zavisi od garancije), sa **rokom zatvaranja** i statusom razduženja.
- **Dvojezičnost stavki:** obavezan **ino naziv** artikla uz srpski (za carinske reporte) — mora u model artikla.

### 5.3 Integracije
- **Nabavka ↔ Carina:** uvozna porudžbina generiše carinski predmet; prevod fakture/tarifiranje; automatski predlog dokaza porekla po pragu 6.000 EUR.
- **Carina ↔ Kalkulacija (landed cost):** zavisni troškovi iz carinskog predmeta ulaze u kalkulaciju nabavne cene po stavci.
- **Carina ↔ Magacin:** prijem robe tek po završenom carinjenju; rezervacije/razduženje kod aktivnog oplemenjivanja (otpis razduženih stavki).
- **Carina ↔ Finansije:** knjiženje carinskog računa, faktura špedicije i ino dobavljača, povezano preko broja porudžbine; PDV na uvoz.
- **Carina ↔ Proizvodnja/RN:** normativ (BOM) i radni nalog kao osnov za aktivno oplemenjivanje i izvoz gotovog proizvoda (izjava o utrošku materijala i radne snage).
- **Ino profaktura / reporti:** generisanje dvojezičnih dokumenata (srpski + engleski) — Ino Profaktura, izjave, normativ za špediciju; obavezan tekst za privremeni uvoz („Free of charge…").
- **Upravljanje dokumentima:** danas fajl-sistem (SHARES\Predmeti\godina\kupac) — u ServoSync-u vezati priloge (JCI, ugovor, izjava, normativ, EUR1, razduženje) direktno za carinski predmet.
- **Kursne liste:** integracija sa deviznim kursom po datumu dokumenta.

### 5.4 Napomene / rizici za skoping
- Legacy BigBit **NE radi carinski obračun** — radi ga špedicija. ServoSync 4.0 treba da odluči da li interno računa carinu/PDV (landed cost) ili samo evidentira eksterne troškove. (Otvorena arhitektonska odluka — potvrda Negovan/Neša, u duhu BACKEND_RULES §11.)
- **Ključ raspodele zavisnih troškova nije dokumentovan** — mora se izvući iz stvarne prakse (intervju sa Tatjanom Jarakovic) pre implementacije kalkulacije.
- Mnogo procesa je „ručno/po iskustvu" (izbor špedicije, okvirna cena za privremeni uvoz, provera „UV 5" na JCI) — kandidati za automatizaciju/validaciju u novom sistemu.

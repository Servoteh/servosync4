# Odgovori na 38 pitanja — šta se menja (05.08.2026)

Pregled svih odgovora naspram koda koji je već napisan i pušten. Svaka tvrdnja je merena na produkciji (samo čitanje) ili u kodu; gde je merenje oborilo raniju procenu, ovde stoji ispravljeni broj.

**Osnovna dobra vest:** na produkciji je `invoices = 0`, `stock_documents = 0`, `document_number_sequences = 0`, `tax_rates = 0`, `payment_accounts = 0` i nijedan nalog nije 4.0-nativni (svih 1.247 je iz noćnog BigBit uvoza). Dakle **sve što sledi menja se u kodu, bez ijednog papira koji bi se razišao sa istorijom.** Cena promene je danas najniža koja će ikad biti.

---

## 1. ŠTA SE MENJA U ODNOSU NA ONO ŠTO SMO VEĆ NAPRAVILI

Najvažnije prvo. Uz svaku stavku piše koju odluku odgovor obara.

### 1.1 · Nalog po vrsti dokumenta i danu (odgovor 16) — VELIKO
**Obara:** našu preporuku „jedan nalog po dokumentu" (`SEME_KONTIRANJA.md` §6/P8 opcija b, §5 K4.6).

Danas je nalog **po dokumentu** na oba puta: robni (`posting.service.ts:383-399`, broj = MAX+1) i prodajni (`fakturisanje.service.ts:1514-1534`, vrsta naloga je konstanta `"IF"`). Odgovor traži dnevni nalog po vrsti — kao dosad.

Ne menja se samo broj, nego **pet stvari**:

| šta | danas | posle |
|---|---|---|
| broj naloga | MAX+1 (`0001`, `0002`…) | `YYMMDD` |
| vrsta naloga | konstanta `IF` za sve račune | IFR / IFGP / IFUSL / IZVRO / IZVGP / IZVUS |
| idempotencija | po `journal_entries.source_goods_doc_id` | mora da siđe na `ledger_entries.source_goods_doc_id` — inače re-post jednog dokumenta **briše ceo dan** (`posting.service.ts:302`) |
| storno | obrće ceo nalog, a `reverses_entry_id` je `@unique` | storno JEDNE fakture danas bi obrnuo ceo dan i **zauvek zabranio storno svake druge fakture tog dana** |
| status / veze | nalog se odmah upisuje kao `POSTED` | dnevni nalog koji je već zaključan ne može da primi sledeći dokument; `invoices.journal_entry_id` postaje više-na-jedan |

Usput izmereno: današnji MAX+1 nad uvezenim IFR nalozima (raspon 260112–260804) izdao bi `260805` — dakle **lažan datum kao brojač**, što je znak da su dva sistema numeracije već pomešana. Dobit dnevnog naloga je merena nad uvezenom knjigom: prosečno 2,79 dokumenta po IFR nalogu, 3,00 po IFGP, 9,48 po UFROB → dnevnik 3–9× kraći.

### 1.2 · Usluge se knjiže ručno, a konto 6 se menja po vrsti usluge (odgovori 2 i 29)
**Obara:** preporuku da se uvede šema 30 (2040/6140/4703) za IFUSL (`SEME_KONTIRANJA.md` §6/P1).

Dve odvojene razlike:

**(a) PDV usluge danas ide na konto za ROBU.** `fakturisanje.service.ts:70` ima `ACC_VAT_OUT_20 = "4702"` kao konstantu, a mapa bira konto **samo po procentu** — prihod se grana na robu/uslugu (`:167-169`), PDV se ne grana. Izmereno na uvezenim IFUSL nalozima: **4703 = 45 redova / 3.654.711,50 RSD; na 4702 nula IFUSL redova.** Popravka je jedan uslov.

**(b) Konto prihoda je konstanta i nema ga gde uneti.** Kod bira izrazom `usluga ? 6140 : 6040` i pravi **tačno jednu liniju klase 6**. Izmereno na produkciji, 2026:

```
IFUSL | 6140 | 45 redova | 18.273.558
IFUSL | 6796 | 10 redova |  1.222.645
IZVUS | 6151 |  2 reda   |  2.490.466
```

Dakle promenljivost je stvarna i već u knjigama. Ni `invoices` ni `invoice_items` nemaju kolonu za konto prihoda; za slobodnu uslužnu stavku `itemId` je NULL, pa se konto ne može izvesti ni sa artikla. **Cena koja se ne vidi:** `popdv_account_map` ima red za 6151 (polje 11.1) i za 6796 (polje 3.4), a za **6140 nema reda** — sve što danas odemo na 6140 ostavlja ta polja POPDV-a na nuli.

⚠️ Ako se auto-knjiženje usluga isključi, uslužni račun do ručnog naloga **nema otvorenu stavku** — saldakonti, aging i opomene ga ne vide. To treba svesno prihvatiti.

### 1.3 · Osnov oslobođenja: četiri osnova umesto jednog izvedenog (odgovori 8, 9, 10)
**Obara:** izvođenje osnova iz dokumenta (`vat-exemption.ts:89-101`, komentar izričito kaže „namerno ne gleda `documentType` nego suštinu").

🔴 **Najhitniji nalaz u ovoj grupi: papir i e-faktura danas na istom dokumentu govore različito.** Za izvoz robe papir štampa „član 24. stav 1 tačka 2" (`vat-exemption.ts:69-70`), a SEF šifra i razlog u istom fajlu (`:71-72`) i tvrdo u `ubl-builder.service.ts:62-63` kažu `PDV-RS-24-1-5` / „Izvoz dobara (čl. 24 st. 1 tač. 5)". Po odgovoru je izvoz **24.1.2**, a 24.1.5 pripada **slobodnoj zoni**. Dve šifre se razmenjuju.

Dalje, izvođenje je sada nemoguće: ista situacija „izvoz robe" po odgovoru daje **tri** osnova (24.1.2 redovan izvoz, 24.1.5 slobodna zona, 24.1.7 oplemenjivanje). To se iz podataka o dokumentu ne može pogoditi — mora se **birati**.

Za ino uslugu kod danas štampa jedan te isti tekst „član 24. stav 2" na SVAKOJ IZVUS fakturi; odgovor traži **čl. 12 st. 3 u dve varijante** (sa i bez reči „van teritorije Republike Srbije"). Za domaći oslobođen promet papir danas štampa placeholder („osnov se utvrđuje po dokumentu"), a SEF šalje razlog **bez šifre BT-121** — odgovor 10 daje doslovan tekst (čl. 24 st. 1 tač. 5).

I još: odgovor 8 vezuje za osnov i **tok** — „24.1.2 … ne ide na sef", „24.1.5 … šalje se na SEF". Danas o tome odlučuje samo zastavica `isExport` (`sef.service.ts:132-136` odbija svaki izvoz). Kapija mora da presuđuje **po osnovu**, ne po zastavici.

Za slobodnu zonu danas ne postoji način da se dokument označi: `invoices` nema nijednu kolonu za osnov oslobođenja; `document_types.default_vat_exemption_code` postoji, prazan je za svih 15 vrsta i **nijedan kod ga ne čita**.

### 1.4 · Preuzimanje 01.04.2027 obara premisu odluke O-F1 (odgovori 27 i 4)
**Obara:** O-F1.

O-F1 doslovno kaže: brojač „kreće od 1 (… jer se na softver prelazi tek od nove godine)". Prelazi se **1. aprila**. Odgovor 4 („svake godine presek, uvek od 1") pokriva punu godinu; mi preuzimamo sredinom.

Izmereno: glavna knjiga već nosi izlazne fakture 2026. u **tačno našem obliku** `N/GG` bez vodeće nule — IFR 95 različitih brojeva (100/26–261/26), IFUSL 32, IFGP 21; od 2.453 reda oblika `N/26` njih 1.404 je bez vodeće nule. Time pada i tvrdnja u kodu da je „BigBit auto-broj UVEK zero-padovan" (`numbering.service.ts:145-153`) — brana vodećih nula pokriva 43 % zatečenih brojeva. Kanal je živ: poslednji uvoz 05.08.2026. u 01:47.

Tempo je 23–49 novih brojeva mesečno → januar–mart 2027. potroši ~90–110 brojeva **pre** 01.04. Ako 4.0 tada krene od 1, izdaje brojeve koje je BigBit u istoj godini već izdao, a otvorene stavke se grupišu po (konto, komitent, **broj**) bez vrste dokumenta (`open-items.service.ts:227,279,362`). Brane nema — nigde u kodu ni migracijama nema ni jednog `INSERT INTO document_number_sequences` ni provere „broj već postoji u knjizi". Isto važi i za robna dokumenta (`stock-document-numbering.service.ts:32-46` računa MAX samo nad našim redovima, kojih je 0).

**Posledica:** seed brojača (stavka S9) iz „treba pre puštanja u rad" postaje **tvrd uslov za 2027**, i uz njega ide brana „broj koji izdajem ne sme da postoji u knjizi za tu godinu".

### 1.5 · Prenos između sopstvenih magacina se knjiži (odgovor 23)
**Obara:** odluku upisanu u `transfer.service.ts:47-48` („prenos ne menja imovinu firme, pa vrste PREIZ/PREUL nemaju šemu kontiranja i ne knjiže se").

**Posao je manji nego što smo u pitanju procenili.** Pisali smo „evidencija konta po magacinu ne postoji" i „nedelju dana i više". Kolona **postoji i popunjena je** — izmereno: `1 Magacin robe → 1320`, `2 Repro → 1010`, `44 Gotovi proizvodi → 9600`. Sentinel `MAG` iz BigBit šema ima izvor.

Ostaju tri stvari: (1) motor mora da razreši `Konto = 'MAG'` u konto magacina — danas bi u knjigu ušao doslovan tekst `MAG`; (2) šeme 37/38 nisu uvezene i same ne balansiraju (protivstavka im je baš `MAG`); (3) naš prenos je **par** dokumenata (PREIZ + PREUL), a BigBit je imao jedan MMP — treba odlučiti daje li par jedan nalog ili dva. Ono što BigBit stvarno radi, mereno nad uvezenom knjigom (vrsta naloga MMP): protivstavka je konto izvornog magacina, **na dugovnoj strani sa minusom**.

### 1.6 · Ponuda i predračun dele jedan brojač (odgovor 5)
**Obara:** dopunu O-F7 od 02.08., tačku 1 („brojač ostaje razdvojen").

Danas su dva nezavisna brojača, jer se ključ brojača **izvodi iz prefiksa** (`sequenceKeyFor`, `numbering.service.ts:311-315`). Odgovor traži jedan niz, i to se poklapa sa papirom (`BIGBIT_IZLAZNE_FAKTURE_I_AVANSI.md:113` — „PON i PROF dele niz NNNN-YY") i sa planom unosa (grupa OFFER). Cena: `sequenceKeyFor` prestaje da bude izveden iz prefiksa, pa ekvivalencija „bez prefiksa ⇔ u nizu faktura" — danas jedina strukturna brana od spajanja sa fakturom — mora da preživi kao **poseban invariant i test**.

### 1.7 · „Ne uvodimo poziv na broj" (odgovor 22) se sudara sa onim što već šaljemo
Na **papiru** ga stvarno nema — provereno renderovanjem sva četiri obrasca sa namerno postavljenim pozivom na broj: 196 tekstualnih čvorova, nula pogodaka. (QR u podnožju je Google mapa, ne platni QR.)

Ali na **e-fakturi ga šaljemo na svakoj**: `ubl-builder.service.ts:703-704, 716` upisuje `cbc:PaymentID` (BT-83) = `paymentReference` ako postoji, inače **broj dokumenta** — a `payment_reference` se nikad ne popunjava. Polje je izmenjivo kroz DTO (`update-invoice.dto.ts:159`), a priprema plaćanja gradi model-97 poziv na broj (`payment-preparation.service.ts:401`).

Uz to: parser poziva na broj normalizuje avansnu seriju, pa uplata na `A-7/26` može da zatvori fakturu `7/26`. **To ostaje otvoreno pitanje (S6) — v. §5.**

Ispravka ranijeg merenja: nije 302 nego **4.778 grupa** (konto, komitent, broj) sa više od jednog naloga, 4.690 sa više od jedne vrste, od čega 49 sa nenultim saldom.

### 1.8 · Otpremnica — postoje DVE, a odgovor 34 obara onu drugu
Ona kroz šablon fakture jeste „isti obrazac bez cena" i to je potvrđeno merenjem (domaći robni obrazac gubi 17 čvorova: CENA / R% / VREDNOST / Rabat / zbir; ostaju memorandum, okvir kupca, traka uslova i četiri potpisa).

**Propušteno u ranijoj analizi:** `robno/print/stock-document-pdf.service.ts` je **druga** otpremnica — verna BigBit-ovoj „OtpremnicaBezCena", sa naslovom `OTPREMNICA`, barkodom i tri potpisa, i nudi se za **svaki izlaz robe** (`api/robno.ts:865`). To je papir koji fizički ide uz robu. Odgovor „treba da ima isti obrazac kao i faktura" je obara. Treba potvrditi na koju od dve se odgovor odnosi (v. §5).

Dve manje ispravke: na **uslužnom** obrascu bez cena otpada i kolona PDV (ne samo novčane); komentar u kodu tvrdi „2× štampa", a kod daje **jedan** primerak.

### 1.9 · „Ne mora biti totalna kopija" (odgovor 38)
**Obara:** pravilo „do odluke se papir prati doslovno", po kom je pisano sedam tipografskih vernosti.

Skidamo (7, svako je jedan string + test): `web::` sa dve dvotačke → `web:`; `Invoice  No.` sa dva razmaka; `IBAN : ` sa razmakom pred dvotačkom; „Ukupna brutto:" / „Ukupna Netto:" → „bruto" / „neto"; razmak u zagradi `( EUR)`; kilaža formatirana srpski (`1.720,00 kg`) na strani gde su svi iznosi engleski; prazna siva traka iznad zaglavlja trake uslova.

Zadržavamo (4, nisu kozmetika): separator hiljada zarezom na domaćem računu (BigBit i 4.0 rade paralelno do aprila 2027 — dva papira za istog kupca moraju da se čitaju isto); razmaknuta slova `K u p a c:` / `C E N A` (po njima ljudi prepoznaju papir); red „Rabat: 0.00" i kad je nula; kolona „Stat. goods No." i kad je prazna (carina).

⚠️ Napomena koja ublažava ovaj odgovor: red „Umanjenje za primljeni avans" na konačnom računu **ne postoji ni na jednom donetom obrascu** — to je naš dodatak. Obećani „konačni račun" (odgovor 13) mu je sudija.

### 1.10 · Datum prometa (odgovor 7)
Danas je `supplyDate` slobodno polje za sve vrste, a knjiženje ga **tiho popuni** datumom računa kad je prazno (`fakturisanje.service.ts:838-845`, samo WARN u logu). Odgovor: za robu **uvek** isti kao datum računa (bez izbora), za uslugu se **unosi ručno** (dakle knjiženje bez unetog datuma treba odbiti sa 422, ne izvesti tiho).

### 1.11 · Stopa 8 % izlazi iz programa (odgovor 26)
Zatvara otvoreni nalog O-PDV-8 po njegovoj trećoj opciji. Šifra „5" (8 %, POLJO) postoji u mapi stopa i prolazi kroz unos, ali knjiženje već pada sa 422 jer konta izlaznog PDV-a od 8 % u planu nema. Novac nikad nije bio u riziku; ostaje čišćenje. Bezbedno: nijedan od 92.620 artikala ne nosi šifru „5".

### 1.12 · Vrsta naloga za viškove (odgovor 24)
Šeme 41 (VISAM) i 46 (VISAR) nose `order_type = 'VISAM'` / `'VISAR'`, a registar `order_types` (117 vrsta) ima **samo VISAK**. Na koloni `journal_entries.order_type_code` **nema stranog ključa** → viseća šifra bi tiho ušla u dnevnik. Popravka su dva reda u migraciji. Da je VISAK ispravno potvrđuje i jedini uvezeni VISAK nalog (260119): `1320 duguje 190.168,91 / 6740 potražuje 190.168,91` — tačno obrazac šeme 46.

---

## 2. ŠTA JE ODGOVOR POTVRDIO (zatvoreno, nema posla)

- **Šeme za robu (1)** — 21 šema / 78 linija postoji i verna je; šema 33 daje 2040 / 4702 / 4710 / 6040 / 1320 / 5010, tačno kako odgovor kaže. (Potvrda je uslovna — v. §3.1.)
- **Nema 10 % na gotovom proizvodu (3)** — izmereno: šifru „3" (20 %) nosi 92.619 artikala, šifru „4" (10 %) tačno jedan, i to računarski deo, dakle roba. Kod već ispravno knjiži 10 % na 4710 (posebna stopa), pušteni test to pokriva.
- **Razlika od jedne pare na avansu (14)** — kod svesno bira da zaglavlje, papir i UBL kažu **isti broj**, uz odstupanje od 0,01 od EN 16931. Provereno iscrpno: za 20 % takvih iznosa ima 1.666.650 od 9.999.901 (16,67 %), maksimalno odstupanje 0,01; skeniranjem ~404.000 avansnih iznosa papir/UBL se od zaglavlja **nijednom** nisu razišli, a ista stavka pod IFR daje tačan porez — dakle izuzetak je stvarno samo za avans.
- **Reset brojača po godini (4, deo)** — radi sam od sebe; brojač je ključan po (vrsta, godina, firma), nova godina nema red pa kreće od 1. Pokriveno testom „prelaz godine 657/26 → 1/27".
- **Nema pravila kontiranja po vrsti robe (29, deo)** — kolona `origin` postoji, motor je **nikad ne čita**, i na produkciji svih 78 linija ima `origin = 'X'` („važi za sve"). Ne gradimo kofe po poreklu/magacinu.
- **Pet vrsta ostaje van sistema (19)** — REPRE, DONAC, MANJM, OTPIM, OTPIR nemaju vrstu dokumenta i ostaju na `posting_template = 0`. Time otpadaju i potpitanja o kontu 4700 vs 4702 i o prolazu kroz 6040/5010.
- **Rezervacije i utrošak za popravke (25)** — prihvaćena zamena strane umesto minusa; četiri šeme (44, 45, 48, 54) su već u tom obliku.
- **Ino otpremni podaci se unose ručno (37)** — dakle **ne** pravimo šifarnik špeditera niti obračun kilaže iz težine artikla.
- **Traka partnera ostaje (33)** — jedna slika sa šest logotipa, nema šta da se menja.
- **Nema kamate na avanse dobavljačima (15)** — v. §4, ovo je i popravka.
- **Prihvaćena e-faktura se samo stornira (21)** — potvrđuje našu analizu; brana postavljena 03.08. je bila ispravna.

---

## 3. NOV POSAO — poređan po tome šta blokira početak rada

### 3.1 🔴 Probno knjiženje + uključivanje šema — **preduslov svemu ostalom**
Potvrda iz odgovora 1 je uslovna: „tek posle probnog knjiženja po jednog dokumenta svake vrste i poređenja sa starim nalogom". Alata za probu **nema** — nijedna ruta ne vraća redove naloga bez upisa; robno ima samo `POST /documents/:id/post` koji odmah komituje. Uz to je `posting_template = 0` za **svih 15 vrsta**, pa auto-knjiženje danas ne stigne ni do registra šema.

Pre probe moraju tri stvari, inače proba nije čitljiva:
1. **Domenske greške moraju postati HTTP greške** — sve tri nasleđuju obični `Error`, a filter propušta samo `HttpException` → svaki pad knjiženja je danas „500 Neočekivana greška", a poruka o nebalansu se vidi samo u logu.
2. **Robna grana ne upisuje broj dokumenta / valutu / rok na red naloga** (ručna grana to radi) — a otvorene stavke grupišu baš po (konto, komitent, broj), pa bi sve fakture jednog kupca pale u jednu stavku bez broja.
3. **Nema zaokruživanja reda naloga na 2 decimale** pre upisa, a kolone su `numeric(19,4)`.

### 3.2 🔴 Registar poreskih stopa (odgovor 6)
`tax_rates = 0` i seed **nije napisan** (u repou nema nijednog `INSERT INTO tax_rates`). Dve merljive posledice: cenovnik ne može da primi nijedan red (tvrd strani ključ), i dijalog „Evidencija ulaznog avansa" puni padajuću listu iz tog registra pa se ne može poslati uopšte. Seed mora da nosi svih 8 redova iz BigBit tarifa (registar je ogledalo BigBita i meta stranog ključa cenovnika); odgovor sužava **izbor na novom dokumentu** na 20 % i 0 %, ne sam registar.

### 3.3 🔴 Šifarnik osnova oslobođenja (odgovori 8, 9, 10)
Šifarnik (tekst za papir + razlog i šifra za SEF) + kolona na fakturi + izbor na ekranu + podrazumevana vrednost iz `document_types.default_vat_exemption_code` (kolona postoji, prazna) + kapija SEF-a po osnovu umesto po zastavici. **Čeka:** doslovne tekstove za 24.1.7 i obe varijante čl. 12 st. 3.

### 3.4 Konto prihoda po vrsti usluge (odgovori 2, 29, 18)
Kolona + šifarnik „vrsta usluge → konto" + polje na ekranu + čitanje u ručnom knjiženju. Isti mehanizam traži i knjižno odobrenje (6141/6140/6796/6501/6040), pa mora biti **jedan, ne dva**. **Čeka:** knjigovođin spisak — bez njega se pravi prazan padajući meni.

### 3.5 Nalog po vrsti i danu (odgovor 16)
Pet izmena iz §1.1. Ne čeka nikoga, ali je najveći pojedinačni zahvat u knjiženju i treba ga uraditi **pre** probnog knjiženja iz 3.1, da se proba ne radi dvaput.

### 3.6 Ekran za pravila kontiranja + trag izmena (odgovor 28)
Danas se šeme mogu menjati **samo migracijom** — nema kontrolera, DTO-a ni permisije; registar vrsta dokumenata je izričito samo za čitanje, a baš u njemu stoji prekidač koji vezuje vrstu za šemu. Posao: CRUD + master-detail ekran + provera formule sa probnim izračunom + zaključavanje šeme koja je već knjižila.

Dve dobre vesti: „da se beleži izmena" je skoro besplatno (globalni audit već upisuje red za svaki upis — treba dodati samo **prethodnu vrednost**, jer se danas pamti isključivo nova); i „knjigovođa i administratori" se uklapa u pravo koje je upravo pušteno na ovoj grani. Jedna zamka: audit se briše posle **24 meseca**, pa bi trag o pravilu po kom je knjižen nalog iz 2026. nestao 2028 — trag o pravilima kontiranja mora van te retencije.

### 3.7 Pojedinačna evidencija PDV-a na SEF-u (odgovor 12) — VELIKO
Ne postoji ništa: SEF klijent zna pet putanja i nijedna nije evidencija; nema tabele, ekrana, ni podatka o tome ko **nije** u sistemu e-faktura (`customers.vat_status` se sinhronizuje iz BigBita i **nijedna logika ga ne čita**). **Čeka:** demo SEF ključ — oblik zahteva se ne sme pogađati.

### 3.8 Storno prihvaćene e-fakture (odgovor 21)
Ruta `/sales-invoice/storno` ne postoji nigde. Danas lokalni storno prođe (knjige, rezervacije), pa otkazivanje na SEF-u padne sa 409 i porukom „e-faktura je kod kupca i dalje važeća — storniraj je na portalu". **Čeka:** demo ključ (tri nepoznanice: oblik tela zahteva, koje statuse propušta, i da li je radnja sinhrona).

### 3.9 Arhiva izdatih dokumenata (odgovor 31)
Nijedna izlazna faktura se ne čuva: PDF se crta na zahtev i nestaje. Jedini trajno zapamćen primerak je prilog e-fakture, i to samo za dokumente koji odu na SEF — a izvozna faktura po odgovoru 8 na SEF ne ide, pa za nju ne ostaje **ništa**. Posledica koja se ne vidi dok ne zatreba: PDF se crta iz **trenutnih** podataka (naziv firme, logo, adresa, cene), pa isti račun odštampan za dve godine ne mora izgledati kao original. **Čeka:** rok čuvanja (v. §5).

### 3.10 Peti obrazac — avansni račun (odgovor 13)
Avansni račun danas ne ide kroz četiri nova obrasca nego kroz **zatečeni opšti crtač**: bez memoranduma, bez logotipa, bez TÜV znaka, bez trake partnera, sa dodatnim redom „Štampao:". Praktično — kupac za isti posao dobija avansni račun koji izgleda kao papir druge firme, pa konačni račun na Servoteh memorandumu. Isto važi i za knjižno odobrenje. **Čeka:** papir (odgovor ga obećava, ne daje).

### 3.11 Ino otpremni podaci — osam polja (odgovor 37)
Kolone postoje i šablon ih uredno štampa (paritet, koleta, dimenzije, bruto, neto, mesto istovara, kontakt špeditera, JCI), ali se **nijedno nigde ne upisuje** — nula pogodaka u celom backendu i frontendu van šablona. Dakle ino uslužna faktura se danas ne može odštampati sa otpremnim blokom ni na koji način. Posao: osam polja u DTO + jedna sekcija na ekranu. Sve je slobodan tekst — tačno kako odgovor traži.

### 3.12 FCO, način otpreme, način plaćanja (odgovori 32, 36)
Traka uslova na robnoj fakturi se štampa **uvek**, ali su joj prve tri ćelije prazne osim načina plaćanja koji se prepisuje sa kupca — `Invoice.fco` i `Invoice.shipmentMethod` se nijednom ne upisuju, a ni način plaćanja se ne može promeniti na samom dokumentu.

### 3.13 Domaći račun preko jedne strane (odgovor 35, papir 845/23)
Sa papira pročitano: BigBit na **svakoj** strani ponavlja tekući račun, okvir kupca, ceo blok broja i datuma, zaglavlje tabele i potpis; na drugu stranu padaju zbir, red „PO:", napomene i potpis. Broja strane nema ni na jednoj. Mi danas ponavljamo samo memorandum. **Mehanizam već postoji** — ino uslužni obrazac radi tačno to — pa je posao prenošenje istog obrasca na dva domaća šablona. Predlog: pustiti **prirodan prelom** (prelomi se kad ne stane), jer odgovor 38 kaže da ne mora biti totalna kopija.

### 3.14 Broj narudžbenice kupca na papiru (izvedeno sa 845/23)
Na drugoj strani stoji `PO: P79-0085104596`. Podatak postoji u bazi, unosi se, prepisuje se i ide u e-fakturu — a **nijedan od četiri obrasca ga ne štampa.** Kupac koji plaća po svojoj narudžbenici (Bosch, javni sektor) na našem papiru ne vidi njen broj, iako ga vidi u SEF-u. Popravka je jedan red iznad bloka napomena.

### 3.15 Knjiženje prenosa između magacina (odgovor 23) i vrsta VISAM (odgovor 24)
Opisano u §1.5 i §1.12.

---

## 4. ŠTA SE MOŽE ODMAH — bez ijedne nove odluke

Spisak spreman za izvođenje, redom po odnosu koristi i cene:

1. **PDV usluge sa 4702 na 4703** — jedan uslov u `fakturisanje.service.ts`. Danas porez usluge ide na konto za robu.
2. **Popuniti podatke firme.** Izmereno: jedini red u `companies` ima samo naziv „SERVOTEH", mesto izdavanja i poštanski broj — **adresa, grad, PIB, matični broj, registarski broj, šifra delatnosti, tekući račun, telefon, e-mail i APR rečenica su prazni**, logotipi su NULL. Kod namerno nema rezervne vrednosti, pa bi memorandum izašao bez adrese, bez telefona i bez registarskog reda, a domaći obrazac bez reda „Tekući račun". Podaci su na svih pet donetih papira (uključujući šifru delatnosti 3320). Uz to: naziv treba da bude `Servoteh d.o.o.`, kako O-F9 traži.
3. **Uneti devizni račun.** `payment_accounts = 0`. Kod ume da odštampa naziv i adresu banke primaoca, ali ih nema odakle da uzme — pa izvozna faktura danas štampa IBAN i SWIFT iz rezervne grane, **bez naziva i adrese banke**. Uneti jedan red: `RS35160005010003501186`, `DBDBRSBG`, „Banca Intesa a.d.", Milentija Popovića 7b / 11070 Novi Beograd, valuta EUR. *(Napomena: adresa u Novom Sadu iz odgovora je kontakt služba za loro doznake same banke, a `908-16001-87` je račun banke kod NBS — ne ide ni na jednu fakturu.)*
4. **Zatezna kamata: isključiti avanse dobavljačima.** Danas osnovica uzima **sva** potražna saldakonto konta, a registar ima i 1520/1521/1530 sa oznakom „dobavljač". Izmereno: 522 nezatvorene stavke; posle netiranja po dokumentu u obračun ulazi **46.689.255,50 RSD** (64 dokumenta) — kamata po 9,5 % na dan 05.08. bila bi **2.492.005 RSD** koju bismo poslali sopstvenim dobavljačima. Kvar je **latentan samo zato što je tabela stopa prazna** — budi ga prvi unos stope. Lek je jedan uslov, i mora ući **pre** stavke 3.2 iznad.
5. **Vrsta naloga za viškove** — dva reda migracije: `accounting_schemes.order_type = 'VISAK'` za šeme 41 i 46, plus vezivanje šeme 46 za vrstu VISAR.
6. **Izbaciti šifru „5" (8 %)** iz izbora na izlaznom dokumentu i zatvoriti nalog O-PDV-8.
7. **Datum prometa**: robni tipovi → datum računa bez izbora; uslužni → knjiženje bez unetog datuma odbiti sa 422 umesto WARN-a u logu.
8. **Opis reda naloga = opis dokumenta** — dva mesta upisa. Danas robna grana upisuje **opis linije šeme**, a od 78 linija samo dve imaju tekst i oba su besmislena na kartici („0" i „MATERIIJAL"); ostalih 76 redova bilo bi bez opisa. Ručna grana upisuje sklopljen tekst („Kupac 657/26"). Ciljno polje postoji na obe strane, i uvoz iz BigBita već puni baš to polje.
9. **Jedan brojač za PON i PROF** (prefiksi ostaju).
10. **Godina brojača na tri mesta** — predračun, ponuda i avans uzimaju godinu sirovo iz sistemskog datuma umesto poslovne godine; kontejner radi po UTC-u, pa bi dokument bez datuma napravljen **1. januara do 01h** pao u prošlogodišnji brojač. Knjiženje računa je već ispravno.
11. **Avansni račun u stranoj valuti nema na šta da se uplati** — mereno: na avansu u EUR ne izlazi ni IBAN ni SWIFT, natpisi su srpski, izvozne napomene nema. Isto je zatvoreno za predračun i ponudu 02.08.; avans je ostao. Popravlja se odmah, ne čeka papir.
12. **`PO:` broj na oba domaća obrasca** — jedan red, štampa se samo kad postoji.
13. **Sedam tipografskih sitnica** iz §1.9.
14. **Ino uslugu privremeno na čl. 12 st. 3** — jedan red, dok šifarnik iz 3.3 ne stigne. Bolje ispravan podrazumevani osnov nego pogrešan.

---

## 5. PITANJA KOJA SE VRAĆAJU

🔴 = blokira posao. Ostalo se može odgovoriti usput.

### 🔴 P-A · Od kog broja krećemo 01.04.2027?
> „U 2027. godini BigBit će do 31. marta već izdati oko 90–110 faktura, sa brojevima koji izgledaju **isto kao naši** (`1/27`, `2/27`…). Kad 4.0 preuzme 1. aprila — kreće li od 1, ili od prvog slobodnog broja iza poslednjeg BigBit-ovog? I ko nam **na dan prelaska** daje taj broj?"

Bez ovoga, dve fakture istog broja tiho se netuju u jednu otvorenu stavku i dug jednog kupca sakriva dug drugog. Isto pitanje važi i za robna dokumenta.

### 🔴 P-B · Kako se uplata vezuje za dokument (dopuna odgovora 22)?
> „Kad stigne izvod, po čemu knjigovođa **danas u BigBitu** zna koju fakturu uplata zatvara — po opisu, po iznosu, ili ručno bira sa spiska? Isto pravilo prepisujemo u 4.0."

Danas: prvo se traže kandidati iz poziva na broj, a ako toga nema — uparuje se po **tačno jednakom iznosu, bez ikakvog redosleda**. Kod kupca sa dve otvorene stavke istog iznosa baza vraća bilo koju. Ovo je najvažnije pitanje u grupi.

Uz to, dva potpitanja iz istog odgovora:
> „Na e-fakturu se u polje ‚poziv na broj' (BT-83) danas šalje **broj računa** — tako je radio i stari program. Ostaje tako, ili polje ostaje prazno?" *(Preporuka: ostaje kako jeste.)*

### 🔴 P-C · Knjižno odobrenje: minus bukvalno ili suprotna strana? (odgovori 18 i 25)
> „Mora li minus **bukvalno da stoji u knjizi** (`−1.000` na dugovnoj strani), ili je dovoljno da odobrenje stoji na suprotnoj strani (`1.000` potražuje)?"

Zašto pitamo: naši potrošači daju **isti rezultat** i bez minusa — PDV se računa kao razlika strana, otvorene stavke isto. Saldo, POPDV, KIF i otvorena stavka su identični; razlikuje se samo bruto promet i izgled reda. A odgovor 25 upravo **prihvata** tu zamenu strane za četiri šeme. Uz to: BigBit minus stvarno koristi (847 od 22.258 uvezenih redova ga nosi), i uvezeni redovi ga kod nas **smeju** — brana važi samo za nove, 4.0-nativne naloge.

Uz to, drugo pitanje iz istog odgovora:
> „Treba li knjižno odobrenje da se **izdaje kupcu** kao dokument (svoj broj, svoj obrazac)? Danas takva vrsta dokumenta kod nas ne postoji."

### 🔴 P-D · Manjak robe — odgovor 19 se sudara sa odgovorom 1
Pitanje 1 je nabrojalo šest vrsta uključujući „manjak robe", i potvrđeno je. Odgovor 19 kaže „nemamo takva dokumenta". A **popis u 4.0 sam pravi taj dokument**: kad zaključenje popisa nađe negativnu razliku, kod automatski otvara dokument vrste MANJR.
> „Šta se dešava kad popis nađe manjak — da li se dokument manjka uopšte ne pravi (pa se popis sa manjkom ne može zaključiti), ili se pravi i knjiži **ručno**?"

Dok se ovo ne odgovori, MANJR ostaje isključen.

### 🔴 P-E · Spisak vrsta usluge → konto (odgovori 2 i 29)
> „Treba nam spisak: koja vrsta usluge ide na koji konto klase 6. U knjigama vidimo 6140 (45 naloga), 6796 ‚Naknadno utvrđeni vanredni prihodi — OTPAD, čl. 10 st. 2 t. 1' (10 naloga) i 6151 na izvoznim uslugama. Da li je to ceo spisak, ili ima još?"

Bez spiska se pravi prazan padajući meni. Napomena: sve što ode na 6140 danas ostavlja polja POPDV-a prazna, jer 6140 nema red u mapi POPDV-a.

### 🔴 P-F · Doslovni tekstovi oslobođenja (odgovor 9)
> „Za tri osnova nemamo tekst kakav treba doslovno da stoji na papiru: (a) čl. 24 st. 1 t. 7 — oplemenjivanje; (b) čl. 12 st. 3 sa rečima ‚mesto prometa usluge je van teritorije Republike Srbije'; (c) ista rečenica **bez** tih reči, za uslugu izvršenu u Srbiji stranom poreskom obvezniku. Molimo tačan tekst za sva tri."

---

### P-G · Konta 27041 i 2790/4790 (odgovor 20 — vlasnik je pitao „o kojim kontima se radi")
Ponovo izmereno danas na produkciji. Konta sa prometom u glavnoj knjizi koja **nisu ni u jednom PDV registru** su tri:

| konto | naziv | promet |
|---|---|---|
| **27041** | Povećanje PDV prethodni koji se ne može koristiti 20 % | 3 stavke, 8.599,26 na obe strane, saldo 0 |
| 2790 | Potraživanja za preplaćeni PDV | 7 stavki, 97.311.213 duguje / 29.890.354 potražuje |
| 4790 | (protivstavka) | 4 stavke, 29.890.354 na obe strane |

**2790 i 4790 su namerno van registara** — to su tranzitna konta mesečnog PDV naloga i kod ih koristi kao kontrolnu tačku prema BigBitu. Dakle stvarno je otvoreno **samo jedno**:

> „Konto **27041** (nepriznati pretporez 20 %) — ide li u KUF i u koje polje POPDV-a, ili je namerno van registara kao 2790 i 4790 (koja su tranzitna i tako ih vodimo)?"

### P-H · Objašnjenje: ISO znak, traka partnera, QR kod (odgovor 33)
Vlasnik je tražio objašnjenje — evo ga, u tri tačke:

**(1) ISO znak, gore desno.** To je pečat TÜV Rheinland „CERTIFIED" sa natpisom **ISO 9001:2008**, brojem sertifikata **ID 9105082898** i adresom www.tuv.com. Slika nije precrtana nego izvučena iz samog BigBit PDF-a i štampa se na **svakoj strani sva četiri obrasca**. Standard ISO 9001:**2008** je povučen 2018. godine.
> **Treba nam:** nova slika znaka (ISO 9001:2015) od TÜV-a i, ako se promenio, nov broj sertifikata. Zamena je jedan fajl.

**(2) Traka partnera, dole.** AVENTICS · Rexroth Bosch Group · ABB · SKF · CASAPPA · MP FILTRI. **Ostaje kako je rečeno** — nema šta da se menja. Jedna napomena za ubuduće: to je **jedna slika sa svih šest logotipa**, ne šest zasebnih, pa svaka promena spiska partnera znači novu sliku.

**(3) QR kod — imamo ga, i radi.** Vlasnik je napisao „QR KOD NEMAMO?" — imamo. Nalazi se dole desno, sa natpisom „google mapa" iznad njega, i štampa se na svakoj strani. Pročitali smo ga iz same slike u donetom papiru: sadrži link `https://goo.gl/w9bnHq`. **Provereno danas pozivom — link i dalje radi** i vodi na `google.com/maps/place/Ugrinovačka+163,+Dobanovci,+Serbia`. Dakle to je **„mapa do nas"**, a ne poreski QR kod sa fiskalnog računa (taj na fakturi pravnom licu nije ni obavezan). Ako se adresa promeni, kod se pravi iz jedne konstante — zamena je trivijalna.

**Ono što odgovor 33 nije pokrio — naziv suda.** Danas domaći robni obrazac štampa „Za sve sporove nadležan je Privredni sud.", a uslužni „Trgovinski sud u Beogradu" — **dva različita naziva na papirima iste firme**, a „Trgovinski sud" u pravu više ne postoji.
> „Predlažemo **‚Privredni sud u Beogradu'** na oba obrasca. Potvrdi ili reci drugačije."

### P-I · Otpremnica (odgovor 34)
Tri stvari koje odgovor ne pokriva:
> „(a) Postoje **dve** otpremnice: jedna koja se štampa iz same fakture (isti obrazac bez cena) i druga koja ide uz robu iz magacina, sa barkodom i naslovom ‚OTPREMNICA' — verna starom programu. Odgovor ‚isti obrazac kao faktura' odnosi se na obe, ili samo na prvu?
> (b) Na otpremnici bez cena danas i dalje piše naslov **‚Račun br. 657/25'**. Sme li papir bez cena da nosi naslov ‚Račun', ili treba ‚Otpremnica'?
> (c) **Koliko primeraka** se štampa? (Pitanje 34 je to tražilo, odgovor ne kaže; kod danas daje jedan.)"

### P-J · Avansni i konačni račun — papir (odgovor 13)
> „Molimo da se avansni i konačni račun stvarno **donesu**, kao onih pet obrazaca 01.08. Bez papira ne možemo ni da proverimo, ni da napravimo obrazac — a avansni račun danas izlazi na sasvim drugom papiru nego faktura (bez memoranduma, bez logotipa, bez TÜV znaka)."

### P-K · Rok čuvanja izdatih dokumenata (odgovor 31)
Pitali smo „koliko i gde", dobili smo samo „gde".
> „Predlažemo da se dokument čuva **10 godina od kraja godine izdavanja** (isti rok koji SEF drži za e-fakture). Potvrdi ili reci drugi broj."

Rok je materijalan jer određuje sme li arhiva da se briše; danas nijedno pravilo brisanja ne postoji, ali audit-trag se briše posle 24 meseca i arhiva to pravilo **ne sme da nasledi**.

### P-L · Način plaćanja na izvoznoj fakturi za USLUGU (odgovor 36)
Na ino **robi** „Payment terms:" nosi način plaćanja — u redu. Na ino **usluzi** isti natpis nosi **datum dospeća**, tako je i na donetom papiru 060/26 — pa se način plaćanja ne štampa nigde.
> „Traži li banka ili carina na izvoznoj fakturi za **uslugu** i način plaćanja (npr. ‚avansno', ‚30 dana'), pored datuma dospeća? Ako da — dodajemo jedan red."

### P-M · Traka uslova na uslužnoj fakturi + pečat i potpis (odgovor 32)
Odgovor nabraja FCO, način otpreme i način plaćanja **bez izuzetka za usluge** — a na uslužnom obrascu te trake **uopšte nema**, i nemaju je ni oba donesena uslužna papira (653/25 i 845/23).
> „(a) Treba li na uslužnu fakturu dodati traku sa FCO / načinom plaćanja / načinom otpreme, iako je stari program tamo nema?
> (b) Pitanje 32 je tražilo i **pečat i potpis** i **podatke u podnožju** — odgovor ih ne pominje. Ostaje kako jeste?"

### P-N · Prenos između magacina — kako tačno (odgovor 23)
> „Je li knjiženje prosto konto na konto (1010 / 1320 / 9600 na obe strane), bez među-konta ‚roba u putu'? I da li **par** dokumenata (izlaz iz jednog + ulaz u drugi magacin) daje **jedan** nalog ili dva?"

### P-O · Višak materijala (odgovor 24)
Šema za višak materijala postoji, ali **vrsta dokumenta ne postoji** — višak materijala se danas ne može ni uneti.
> „Unosi li se višak **materijala** uopšte, ili samo višak robe?"

### P-P · Ko sme da menja pravila kontiranja — odgovoreno je KO, ne KADA (odgovor 28)
> „Ekran za pravila kontiranja je veliki posao. Predlažemo dve faze: **odmah** samo vezivanje šeme za vrstu dokumenta + štampa šema (da knjigovođa vidi po čemu se knjiži), a **puno uređivanje posle prvog meseca rada**. Prihvatljivo?"

### P-Q · Sitnice koje ne blokiraju
- **Opis dokumenta (odgovor 17):** polje u koje ćemo upisivati opis se u bazi zove „Napomena na dokumentu (slobodan tekst)".
> „Je li to isto polje koje knjigovođa na ekranu unosa vidi kao ‚Opis dokumenta'? Ako nije, opis reda naloga će ostajati prazan kao i danas."
- **Avansni račun i jedna para (odgovor 14):** računovodstveno je „nebitna greška" i to prihvatamo. Ali ako sistem e-faktura tu razliku odbije kao grešku validacije, jedini izlaz je **ograničiti iznos avansa** na one koji se dele bez ostatka.
> „Ako se ispostavi da SEF odbija takav avans — prihvatate li da se iznos avansa u tom slučaju mora zaokružiti?"
- **Devizni računi (odgovor 11):** pitanje je glasilo „po valutama", odgovor daje samo EUR.
> „Ima li devizni račun za neku valutu osim EUR? Ako se pojavi, dodaje se kad zatreba."
- **Evidencija PDV-a (odgovor 12):**
> „Podatak ‚kupac nije u sistemu e-faktura' — vodi se na **kupcu** (jednom, na kartici) ili se bira **na svakom dokumentu**?"

---

## 6. PREDLOG REDOSLEDA

### Korak 0 — odmah, ove nedelje (bez ijedne nove odluke)
Sve iz §4. Posebno hitno, jer su brane koje sprečavaju tihu grešku:
- **kamata: isključiti avanse dobavljačima** — pre nego što se unese prva kamatna stopa (2,49 mil RSD razlike);
- **PDV usluge 4702 → 4703**;
- **podaci firme + devizni račun** — bez toga svaka odštampana faktura izlazi bez PIB-a, MB-a i adrese.

### Korak 1 — dok čekamo odgovore (2–3 nedelje)
1. Registar poreskih stopa (§3.2) — odblokira cenovnik i ulazne avanse.
2. Nalog po vrsti i danu (§3.5, §1.1) — najveći zahvat, radi se **pre** probnog knjiženja da se proba ne radi dvaput.
3. Tri preduslova čitljivosti probe: greške kao HTTP odgovori, broj dokumenta na redu naloga, zaokruživanje.
4. Prelom domaćeg računa preko strane (§3.13) — mehanizam već postoji, prenosi se sa ino obrasca.

### Korak 2 — čim stignu odgovori
| čeka odgovor | odblokira |
|---|---|
| P-E (spisak vrsta usluge → konto) | ručno knjiženje usluga (§3.4) |
| P-F (tekstovi oslobođenja) | šifarnik osnova + SEF kapija po osnovu (§3.3) |
| P-C (minus ili suprotna strana) | knjižno odobrenje |
| P-D (manjak na popisu) | zaključenje popisa sa manjkom |
| P-N (prenos magacina) | knjiženje prenosa (§1.5) |
| P-J (papir avansnog računa) | peti obrazac (§3.10) |
| P-K (rok čuvanja) | arhiva dokumenata (§3.9) |

### Korak 3 — probno knjiženje (odgovor 1, uslovna potvrda)
Uključiti šeme, uneti po jedan dokument svake od šest vrsta, uporediti nalog sa starim. **Ovo je tačka u kojoj vlasnikova potvrda iz odgovora 1 postaje konačna.** Do tada se `posting_template` ne pali na produkciji.

### Korak 4 — traži demo SEF ključ
Pojedinačna evidencija PDV-a (§3.7) i storno prihvaćene e-fakture (§3.8). Oba su nedostupna dok ključa nema — oblik zahteva se **ne sme pogađati**. Do tada je jedini put ručno na portalu, kako se i danas radi.

### Korak 5 — ekran za pravila kontiranja (§3.6)
Posle prvog meseca stvarnog knjiženja, kad se vidi šta se stvarno menja. Predlog faznosti je u pitanju P-P.

### ⏳ Čeka 01.04.2027 — ali se priprema ranije
**Seed brojača (S9)** iz „lepo bi bilo" postaje **tvrd uslov**, i za izlazne fakture i za robna dokumenta. Uz njega ide brana „broj koji izdajem ne sme već da postoji u knjizi za tu godinu". Sam seed se radi na dan prelaska, ali kod i brana moraju biti gotovi i testirani **mnogo pre** — zajedno sa odgovorom na P-A. Ovo je jedina stavka na spisku koja, ako se propusti, ne pravi grešku odmah nego tek na dan cutover-a, i to tihu.
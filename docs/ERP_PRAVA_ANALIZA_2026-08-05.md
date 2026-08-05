# ERP prava pristupa — analiza i predlog pravila

Radna verzija za odluku. Sve brojke su izmerene na produkciji 03–05.08.2026 (samo čitanje). Gde nešto nije izmereno, izričito piše da nije.

---

## 1. STANJE DANAS

Glavnu knjigu, saldakonte, PDV, izvode, plaćanja, blagajnu, fakturisanje, SEF i završni račun danas vidi **24 od 69 aktivnih ljudi** — 5 administratora i svih 19 nosilaca role „menadzment"; traži se 7. Ti ekrani **nisu prazni**: noćni BigBit uvoz je u njih prelio 22.258 stavki glavne knjige (14,4 milijarde RSD prometa, 1.247 naloga, 01.01–31.08.2026), 845 otvorenih stavki na 223 komitenta (181,4 mil. potraživanja, 1,90 mlrd obaveza), a KIF/KUF i bruto bilans se izračunavaju iz istih tih stavki na klik.

Istovremeno, **artikle i lager listu vidi 67 od 69 ljudi** (svi osim jednog kiosk terminala u pogonu i servisnog naloga diktafona) — što je već ono što tražite. Ali kroz **isti** ključ prolazi i kartica artikla, koja po svakom dokumentu prikazuje **nabavnu cenu, ime dobavljača, ime kupca i odobreni rabat** (20.416 redova ulaza/izlaza, 228 dobavljača, 1,36 mlrd RSD nabavne vrednosti; 164.574 reda profaktura na 2.361 komitentu; marža vidljiva na 9.845 redova = 429,5 mil. RSD), uz dugme za izvoz u Excel.

Zaključak u jednoj rečenici: **rez koji tražite je tačan po iznosu, ali promašuje najveće curenje** — jer novac iz BigBita danas ne curi kroz Glavnu knjigu (nju vidi 24), nego kroz karticu artikla (nju vidi 67).

---

## 2. PREDLOG PRAVILA (tekst za usvajanje)

**Pravilo o pristupu poslovnim podacima u ServoSync 3.0**

**1. Tri kruga pristupa.** Podaci se dele u tri kruga i svaki ekran pripada tačno jednom:
- **K1 — Knjige i novac:** glavna knjiga, kontni plan, saldakonti, IOS, opomene, kompenzacije, kamata, naplata, PDV/POPDV/KIF/KUF/KEPU, završni račun i APR, izvodi, nalozi za plaćanje, blagajna, izlazni računi, SEF.
- **K2 — Roba i nabavka sa cenama:** zalihe i kalkulacija, popis, rezervacije, nabavni zahtevi/upiti/narudžbenice, poređenje narudžbenice sa prijemom i fakturom, i **kartice artikla** (robno kretanje, profakture, narudžbine) — jer nose nabavnu cenu, dobavljača, kupca i rabat.
- **K3 — Šifarnik i stanje:** spisak artikala, lager lista (stanje/rezervisano/slobodno), komitenti i predmeti kao imenik.

**2. K1 pripada isključivo administratorima sistema i imenovanom spisku.** Spisak danas: **Jelena Stanišić** i **Duško Kostić**. Ukupno 7 ljudi (5 administratora + 2). Nijedno radno mesto, nijedna titula i nijedna rola sama po sebi ne otvara K1.

**3. K2 pripada K1 krugu plus imenovanim nosiocima magacinskog i nabavnog posla.** Danas: **Radisav Radević** (roba). Nosilac nabavke nije imenovan — v. pitanje 4.

**4. K3 vide svi zaposleni sa nalogom.** To se ne sužava. Ostaje bez odluke samo da li lager lista sme da prikazuje veleprodajnu cenu (v. pitanje 1).

**5. Pravo se određuje rolom u ServoSync 3.0, ne u starom sistemu.** Rola u BigBit/1.0 sistemu **ne sme** da otvori nijedan ekran iz K1 ni K2. Ako se nekome u starom sistemu promeni rola, u 3.0 se ne dešava ništa.

**6. Podrazumevano za novog korisnika je NULA prava iz K1 i K2**, bez obzira na to ko ga otvara, koju rolu dobija i šta piše u starom sistemu. Ulazak u K1 ili K2 je uvek pojedinačna, imenovana odluka.

**7. Novi ekran, izveštaj ili izvoz koji se ubuduće napravi nad knjigama ulazi u K1 automatski**, a ne u širi krug. Isto važi za nove role: nijedna nova rola ne dobija K1 ni K2 dok se to izričito ne odobri. (Ovo se obezbeđuje testom koji pada ako se prekrši.)

**8. Ljude na spisak dodaje i skida isključivo administrator sistema, kroz Podešavanja → Korisnici.** Svaka takva izmena ostavlja trag: ko je izmenio, kad, sa čega na šta. Izmene direktno u bazi nisu dozvoljene jer ne ostavljaju trag i ne opstaju.

**9. Slanje podataka van kuće je posebno pravo.** Slanje IOS-a, PDV prijave, opomene ili bilo kog izveštaja na spoljnu adresu smeju samo ljudi iz K1, i svako slanje se evidentira sa adresom primaoca.

**10. Odlazak sa posla ili promena radnog mesta znači skidanje sa spiska**, i to je radnja koju neko mora da uradi — sistem je ne radi sam.

**11. Pravilo se preispituje na dan prelaska sa BigBita (planirano april 2027)**, kada K1 i K2 prestaju da budu prazni i postaju radni ekrani.

---

## 3. KAKO SE SPROVODI

### Izabran mehanizam: nova rola `finansije`, a roli `menadzment` se skida finansijski paket

**Šta se konkretno menja u sistemu:**

1. Iz role `menadzment` se uklanja ~32 finansijska ključa (glavna knjiga, saldakonti, PDV, izvodi, plaćanja, kamata, blagajna, prodaja, SEF, završni račun, robno, nabavka). Sve ostalo što ta rola nosi (sastanci, kadrovska, montaža, plan proizvodnje, praćenje, energetika, reversi, održavanje…) ostaje netaknuto.
2. Rola `finansije` **već postoji u katalogu** i **već stoji u padajućoj listi** na ekranu Podešavanja → Korisnici. Definiše se kao **nadskup role `menadzment` + finansijski paket**. To je obavezno, jer sistem priznaje **tačno jednu rolu po čoveku** — da nije nadskup, Duško bi dobio knjige a izgubio sastanke, kadrovsku, plan proizvodnje i sve ostalo.
3. Jelena i Duško se prebacuju na rolu `finansije` kroz postojeći ekran. Nema migracije baze — produkcijska baza nema nikakvo ograničenje nad poljem role.

### Zašto baš to, a ne pojedinačni izuzeci

Postoji i mehanizam pojedinačnog prava po korisniku (`user_permission_overrides`, 27 živih redova). **Odbačen je**, iz tri merena razloga:
- Ekran za njega **ne postoji** — korisnički interfejs poznaje samo 3 unapred zakucana ključa (Plan montaže read-only, pristup Kadrovskoj, sakrij ugovore). Finansijski ključevi se ne mogu dodeliti ni sa jednog ekrana. Dokaz da se to u praksi rešava ručno: na produkciji postoje redovi (npr. 3 granta za CAM prioritet) koje **nijedan kod ne ume da upiše** — ubačeni su SQL-om.
- Obim: 17 ljudi × 32 ključa = **544 reda ručnog SQL-a**, i prvi zaboravljeni red tiho ostavlja glavnu knjigu otvorenom.
- **Nema traga**: tabela ima 4 kolone (ko, koji ključ, da/ne) — bez vremena i bez toga ko je pravo dao. Posle se ne može rekonstruisati.

Rola, nasuprot tome: jedno mesto u sistemu, važi odmah po restartu, novi menadžer **automatski ne dobija** finansije, i promena se sama upisuje u dnevnik izmena.

### Kako preživljava sinhronizaciju rola (zamka iz istorije)

Ovo je proverena, ne pretpostavljena tačka. Pri svakoj prijavi (i lozinkom i preko starog sistema) 3.0 čita rolu iz stare baze i primenjuje pravila. Izmereno:

- Rola `menadzment` **postoji u katalogu starog sistema**, i **svih 19 ljudi** ima tamo aktivan red `menadzment`. Zato bi svako rešenje tipa „prebaci ih SQL-om na drugu rolu" **izdržalo do njihove sledeće prijave** — stara rola bi se tiho vratila, bez ijedne greške. To je isti kvar zbog kog su ljudima ranije „nestajale opcije", samo okrenut naopako.
- Rola `finansije` **ne postoji u katalogu starog sistema**, pa je štiti izričito pravilo koje 3.0-native role ne prepisuje. Isti mehanizam već drži rolu `tehnolog` u životu: tri tehnologa u starom sistemu stoje kao `viewer`, a u 3.0 zadržavaju `tehnolog`. Pokrenuo sam postojeći test tog pravila (29/29 prolazi).
- Skidanje finansija sa role `menadzment` je izmena u kodu, a sinhronizacija menja samo rolu čoveka — nikad spisak prava. Dakle preživljava po definiciji.

**Jedna sitna prepreka koju treba rešiti u istom potezu:** stari sistem ima ograničenje koje ne poznaje ime `finansije`. Ekran za izmenu korisnika šalje jednom komandom rolu, ime, tim i status u stari sistem — pa bi pri izmeni tog naloga stari sistem odbio ceo upis i ekran bi prijavio grešku „sy15 nije dozvolio izmenu" (prava u 3.0 bi ipak bila ispravna). Rešenje je jedan od dva poteza, oba mala: dopuniti spisak dozvoljenih rola u starom sistemu, ili u dual-write-u preskočiti slanje role kad je 3.0-native.

### Trag

Promena role kroz ekran Podešavanja → Korisnici automatski ulazi u dnevnik izmena (globalni presretač beleži svaku izmenu sa akterom, vremenom i sadržajem — proverio sam žive redove, npr. poziv korisnika od 25.07). Dodatno, stari sistem ima sopstveni dnevnik nad rolama koji Podešavanja prikazuju. Dakle: **rešenje kroz rolu dobija dvostruki trag besplatno.** Rešenje kroz pojedinačne izuzetke dalo bi trag — nula.

---

## 4. ŠTA ĆE SE PROMENITI LJUDIMA

### Ostaju sa punim uvidom (7)

Luka Tasić, Nenad Jaraković, Zoran Jaraković, Nevena Knežević, Veljko Mijajlović (administratori) + **Jelena Stanišić**, **Duško Kostić**.

### Gube uvid u knjige (17 imena)

Miljan Nikodijević · Nikola Ninković · Jovica Milošević · Nenad Nikolić · Slaviša Radosavljević · Milorad Jerotić · Igor Voštić · Strahinja Petrović · Ljubiša Simović · Nenad2 Jaraković (`jarakovic@gmail.com`) · Dijana Kastratović · Test Admin (`test@servoteh.com`) · Matić Jovan · **Marija Samardžić** · Jovašević Želimir · Bojana Trifunović (`bojana.trifunovic@hapfluid.rs`) · Branislav Stanojević

Svi oni gube istih 11 „čitalačkih" prava (glavna knjiga, saldakonti, PDV, izvodi, plaćanja, kamata, blagajna, završni račun, SEF, prodaja, robno) i sve što iz njih sledi (štampa, PDF, slanje mejlom).

### Šire od očekivanog: nabavka

| pravo | danas | ostaje | gubi |
|---|---:|---:|---:|
| glavna knjiga, saldakonti, PDV, izvodi, plaćanja, kamata, blagajna, ZR, SEF, prodaja, robno | 24 | 7 | **17** |
| **nabavka** | **48** | 7–8 | **41** |
| artikli / lager (šifarnik) | 67 | 67 | 0 |

Nabavka je danas **najšire otvoren ERP modul u firmi** — 48 ljudi, uključujući svih 13 inženjera i 7 „viewer" naloga, jer je to pravo ugrađeno u osnovni paket svakog prijavljenog korisnika. Zatvaranje je najveći pojedinačni rez.

*(MRP i plan proizvodnje se ovim ne diraju — to je proizvodni tok, ne BigBit knjigovodstvo.)*

### Radisav Radević

Za njega ovo **nije oduzimanje nego dodavanje**. Danas je `magacioner`, nema **nijedno** finansijsko pravo (dakle već je u skladu sa vašim zahtevom), a ima artikle, lager, sve tri kartice artikla, MRP, lokacije, reverse. Jedino nema ekrane Zalihe & kalkulacija / Popis / Rezervacije. **Ali ti ekrani su danas prazni** (0 dokumenata, 0 stanja, 0 rezervacija) — dodavanje bi mu donelo tri prazna ekrana. Preporuka: dodeliti mu to onog dana kad robno dobije podatke, ne sada.

### Koji poslovi bi stali

**Izmereno: nijedan koji se može izmeriti.** U 3.0 nikada nije nastao nijedan izlazni račun, narudžbenica, izvod, nalog za plaćanje, blagajnički dokument, PDV prijava, popis ni uparivanje — sve te tabele imaju 0 redova, a dnevnik izmena (31.846 redova od 25.04.) nema **nijedan** unos ni za jedan finansijski modul. SEF nije ni tehnički podešen (nema nijedne SEF/banka promenljive na serveru). Ceo taj posao je u BigBitu do prelaska.

**Ograničenje ovog merenja, izričito:** dnevnik beleži samo izmene, **ne i gledanje**. Ne postoji nijedan podatak o tome ko je i koliko puta **otvarao** glavnu knjigu ili saldakonte. Tvrdnja „ništa ne staje" dokazana je za rad, **nije dokazana za uvid**.

**Dve stvari koje bih zbog toga proverio ljudski, pre reza:**
- **Slaviša Radosavljević** — po dosadašnjem toku posla on isporučuje formule završnog računa (ZR/AOP). Gubi `zr.read` i bruto bilans. *Pretpostavka, nije izmereno.*
- **Marija Samardžić** — tim lider nabavke; gubi i nabavku i saldakonta dobavljača (v. pitanje 4).

### Kako to izgleda čoveku kome se pravo skine (ovo treba popraviti pre reza)

- Backend odbija **odmah**, ali frontend to **ne zna** — spisak dozvola se učita jednom po otvaranju kartice i nikad se ne osvežava. Čovek zato **i dalje vidi „Glavna knjiga" u meniju** dok mu server već odgovara odbijanjem.
- Klikne — i na Glavnoj knjizi dobije crvenu traku sa tekstom **„Forbidden resource"** (engleska sistemska poruka). Na Blagajni ne dobije ni to: strana se otvori **potpuno prazna**, kao da nema podataka.
- Posle osvežavanja (F5) stavke iz menija uredno nestanu, ali ko ima zabeleženu adresu ponovo sleti na istu poruku. Nijedan ERP ekran nema stranu „Nemate pristup" kakvu Kadrovska ima.

Bez ove popravke, 17 ljudi će prijaviti kvar istog dana.

---

## 5. RUPE KOJE PRAVILO NE POKRIVA

**5.1 Kartica artikla — najveća rupa, i to poznata.** Nabavna cena, dobavljač, kupac i rabat vide se kroz pravo za artikle, dakle 67 ljudi. **Brana je postojala i uklonjena je** — u ranijoj verziji taj deo je tražio pravo za robno (24 osobe), a jednom izmenom (PR #90) je skinut, čime se krug proširio sa 24 na 67. Predlažem povratak te brane.

**5.2 Izvoz u Excel ne ostavlja nikakav trag.** Dugme „Export" na artiklima i lageru **ne izvozi ono što je na ekranu** — ponovo poziva server i prolazi kroz sve strane (do 60 zahteva, do 5.000 redova po izvozu), sa kolonama VP cena, MP cena, devizna cena. Kapa nije brana: filtriranjem po grupama ceo cenovnik izlazi u više navrata (92.620 artikala, 21.760 sa cenom). Isti podatak se dobija i bez ekrana. **Gledanje i izvoz se ne beleže nigde** — dnevnik hvata samo izmene.

**5.3 Slanje van kuće pod pravom čitanja.** Dve rute pretvaraju „smem da gledam" u „smem da pošaljem": IOS bilo kog komitenta i PP-PDV prijava firme šalju se **na adresu koja se upiše u zahtev**, bez ograničenja domena i bez evidencije poslatog. (Opomena je urađena kako treba — traži pravo izmene i upisuje se u tabelu.)

**5.4 Stari sistem može da promoviše čoveka u administratora.** Sinhronizacija je namerno jednosmerna: administrator se ne skida, ali **se dodaje** — jedan red u staroj bazi i čovek u 3.0 dobija **sva** prava. Danas je ta rupa prazna (proverio sam: niko ko nije već administrator nema tu rolu u starom sistemu), ali je put od „prazna" do „otvorena glavna knjiga" jedan upis u drugom sistemu, koji radi neko ko o ERP pravima ne odlučuje.

**5.5 Baza nema drugi pojas.** Glavna baza ima **0 sigurnosnih politika na 224 tabele**. Brana je tačno onoliko jaka koliko je tačan spisak dozvola po rutama — nema rezervnog sloja. Dobra vest: proverio sam da je stroga provera **uključena** na produkciji (nije „tihi režim"), i da **nijedna** ERP ruta nije bez prava (skenirao sam svih 66 kontrolera / 1.257 ruta; bez prava su samo prijava, provera zdravlja, tipovi dokumenata i obaveštenja — a obaveštenja vraćaju isključivo redove primaoca i nijedan finansijski modul ne pravi obaveštenja).

**5.6 Pravo upisa u šifarnik ima 67 ljudi.** Postoji ugrađeno pravilo „ko sme da čita šifarnik, sme i da piše" (vaša odluka O-6 od 30.07). Danas ih zaustavlja poslovna brana koja vraća odbijanje — ali ta brana je **jedan prekidač daleko od otvaranja**, i onog dana kad se unos artikala otvori, otvoriće se svima odjednom, bez ijedne nove odluke.

**5.7 Ništa ne pinuje ovo pravilo.** Ne postoji nijedan test koji tvrdi ko sme u knjige. Vraćanje prava na `menadzment` danas bi prošlo neprimećeno.

**5.8 Gde nema rupe (provereno, da ne bismo trošili vreme):**
- **Mobilni** — ni /mob (3.0) ni /m (stari) nemaju nijedan ERP ekran ni iznos; stara baza uopšte ne sadrži knjigovodstvene tabele.
- **AI asistent i diktafon** — stroži su od ekrana: svaki alat nad glavnom bazom traži pravo, i to se proverava dvaput; slobodan SQL ide isključivo na staru bazu, kroz funkciju koja propušta samo kadrovsku i administratore.
- **Globalna pretraga (Ctrl+K) i „skoro otvoreno"** — pretražuju samo meni i filtriraju ga istim pravom kao bočna traka; ne dodiruju podatke.

**5.9 Šta NIJE utvrđeno:** ko sve danas ima pristup **samom BigBitu**. To je i dalje živi sistem do prelaska, i u njemu su svi ovi podaci u punom obimu. Zatvaranje 3.0 nema smisla ako je BigBit otvoren istom krugu ljudi — ali to nije mereno i ne može se meriti iz ovog sistema.

---

## 6. PLAN RADA

| # | Posao | Veličina |
|---|---|---|
| 1 | Skinuti finansijski paket sa role `menadzment`; definisati `finansije` kao nadskup; prebaciti Jelenu i Duška kroz postojeći ekran | **sitno** |
| 2 | Testovi koji zaključavaju nosioce (tačan spisak, ne „sadrži"), + slučaj „rola finansije preživljava sinhronizaciju" | **sitno** |
| 3 | Rešiti odbijanje role `finansije` u starom sistemu (dopuna spiska ili preskakanje role u dual-write-u) | **sitno** |
| 4 | Vratiti branu na kartice artikla (nabavna cena / dobavljač / kupac / rabat) — sa 67 na krug za robu | **sitno–srednje** |
| 5 | Izbaciti nabavku iz osnovnog paketa svakog korisnika (48 → krug za robu) | **srednje** |
| 6 | Poruka „Nemate pristup" na srpskom na ERP ekranima + osvežavanje dozvola da meni ne laže | **srednje** |
| 7 | Obavestiti 17 ljudi pre reza (inače prijavljuju kvar) | **sitno, ali obavezno pre 1** |
| 8 | Odvezati pravo upisa u šifarnik od prava čitanja (ako se O-6 povlači) | **srednje** |
| 9 | Ograničiti slanje IOS/PP-PDV na poslovne adrese + evidencija poslatog | **srednje** |
| 10 | Beleženje izvoza (ko je i kada izvezao cenovnik) | **srednje** |
| 11 | Tvrda brana po mejlu za knjige (drugi pojas, po ugledu na plate) — samo ako se odluči | **srednje** |
| 12 | Politike na nivou baze (drugi pojas za sve) — **ne sada**, tek uz prelazak 2027 | **veliko** |

Redosled izvođenja: **7 → 1 → 2 → 3** (jedan potez, isti dan), pa **4 → 5 → 6**, pa ostalo.

---

## 7. PITANJA ZA VLASNIKA

**1. Da li „lager lista svima" uključuje i cene?**
Lager lista sama prikazuje Stanje / Rezervisano / Slobodno **i veleprodajnu cenu**. Kartica artikla, jedan klik dalje, prikazuje **nabavnu cenu, dobavljača, kupca i rabat**.
- (a) **Preporuka:** artikli + lager ostaju svima (sa VP cenom), **kartice artikla idu u krug za robu**. Posledica: 67 → oko 10 ljudi vidi nabavne cene i marže. Niko ne gubi lager.
- (b) Ostaje sve kako jeste. Posledica: rez na knjigama ne zatvara najveće curenje — 67 ljudi i dalje vidi po čemu smo i od koga kupili, uz izvoz u Excel bez traga.
- (c) I lager bez cena. Posledica: čistije, ali magacin gubi podatak koji svakodnevno koristi pri izdavanju.

**2. Radisav sam ili svi magacioneri?**
Imenovali ste čoveka, ali obrazloženje („sve o robi i artiklima") opisuje posao koji rade svi.
- (a) **Preporuka:** cela rola `magacioner` (8 ljudi: Stamenić, Birovljev, Radević, Savić, Jančić, Cvetić, Anđić, Ilić). Posledica: svaki budući magacioner ga dobija sam, nema zaboravljenog koraka.
- (b) Samo Radisav. Posledica: održivo samo ručno, i vraća nas na mehanizam bez ekrana i bez traga.

**3. Tri naloga u finansijskom krugu koja verovatno nisu nameravana — potvrdite šta sa njima.**
`test@servoteh.com` (rola menadzment, poslednja prijava 24.07, vidi celu glavnu knjigu), `bojana.trifunovic@hapfluid.rs` (**tuđi domen**, aktivna 04.08, vidi glavnu knjigu, saldakonte i PDV Servoteha), `jarakovic@gmail.com` (vaš drugi nalog, nikad prijavljen).
- (a) **Preporuka:** svi gube ERP po pravilu, a testni nalog i nalog sa tuđeg domena se **deaktiviraju**.
- (b) Ostaju aktivni bez ERP-a. Posledica: prihvatljivo, ali testni nalog i dalje postoji sa punim menadžerskim paketom van finansija.

**4. Nabavka — ima li nosioca do prelaska?**
Marija Samardžić je tim lider nabavke i po ovom pravilu ostaje bez nabavke i bez saldakonta dobavljača. Modul je danas prazan i ona ga nije nijednom otvorila.
- (a) **Preporuka:** nabavka do prelaska ostaje u BigBitu; modul se zatvara svima osim administratora i K1. Posledica: 41 čovek gubi pristup, niko ne gubi posao (0 dokumenata).
- (b) Marija dobija nabavku sada. Posledica: kad modul proradi, ona vidi cene dobavljača — što je verovatno tačno, ali je treba imenovati odlukom, ne slučajno.

**5. Komitenti — pun karton svima?**
6.258 komitenata vidi 67 ljudi, i to **ceo slog**: pored naziva/PIB-a/adrese i bankovni računi (popunjeni kod 2.259), kreditni limit, rabat, fiktivni rabat, „proveri dug", napomena o saldu.
- (a) **Preporuka:** ekran ostaje svima, ali se **komercijalna polja sakriju** onome ko nije u K1. Presedan za tačno taj postupak već postoji u kući (plate). Posledica: niko ne gubi imenik, a uslovi ostaju u uskom krugu.
- (b) Ceo ekran u K1. Posledica: 67 ljudi gubi imenik kupaca i dobavljača, uključujući magacin i pogon — lomi svakodnevni rad.
- (c) Ne dirati. Posledica: uslovi saradnje ostaju vidljivi celoj firmi.

**6. Da li hoćete drugi pojas — tvrdu listu po mejlu za knjige?**
Danas allowlista stoji na pretpostavci da niko neće dodati red u staroj bazi (v. 5.4).
- (a) **Preporuka:** da, za glavnu knjigu i saldakonte, po ugledu na plate — presuđuje **pre** role, pa ni promocija u administratora preko starog sistema ne otvara knjige. Cena: dodavanje čoveka traži izmenu podešavanja servera i restart — **vi to ne možete sami**, i ne ostavlja trag.
- (b) Ne. Posledica: brzo i samouslužno, ali jedan upis u staroj bazi otvara sve.

**7. Odluka O-6 („svako može da menja šifarnik") — ostaje ili se povlači?**
Pravo upisa u artikle i komitente ima 67 ljudi; danas ga drži privremena brana koja se gasi jednim prekidačem, a otvaranje unosa artikala je najavljeno čim se počiste dupli kataloški brojevi.
- (a) **Preporuka:** povući — upis u šifarnik ide u isti krug kao roba. Posledica: kad se unos otvori, otvara se za oko 10 ljudi, ne za 67.
- (b) Ostaje. Posledica: prihvatljivo ako je namerno, ali se kosi sa duhom ovog zahteva i desiće se samo od sebe, bez nove odluke.

---

**Napomena o pouzdanosti:** sve brojke iz odeljaka 1, 4 i 5 su izmerene na produkciji ili izvršavanjem samog koda. Tri stvari su **pretpostavka, ne merenje**: (a) da Slaviši treba završni račun za posao, (b) da nabavka do prelaska nikome ne treba, (c) da niko od 17 ljudi ne koristi te ekrane za uvid — jer gledanje se nigde ne beleži. I jedna stvar **nije utvrđena uopšte**: ko sve ima pristup samom BigBitu.
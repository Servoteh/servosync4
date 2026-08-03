# Odluke o zaradama — živi registar

**Šta je ovo:** mesto na kojem se beleže **vlasničke odluke o obračunu zarada** — šta se plaća,
koliko i po kom pravilu. Nije uputstvo za korišćenje aplikacije i nije opis koda; ovo je **izvor
istine za pravila**, pa se kod po njemu proverava (a ne obrnuto).

**Zašto postoji:** pravila se menjaju kako firma raste. Dokument je u gitu, pa svaka izmena ima
datum, autora i obrazloženje — može se kasnije analizirati „kad smo i zašto ovo promenili".

**Kako se koristi:**
- nova odluka → nov red u §1 sa datumom i statusom (`ŽIVO U KODU` / `RUČNO` / `ODLUKA, NIJE U KODU`);
- promena postojeće → **ne briši stari tekst**, prepiši ga u §4 (istorijat) i upiši novu odluku;
- svaka odluka koja utiče na novac mora reći **kome** (tip ugovora) i **koliko**.

---

## 0. Od kada je mesečni grid izvor istine — ⚠️ PROČITAJ PRE ANALIZE STARIH PODATAKA

**Odluka/činjenica (Nenad, 30.07.2026):** mesečni grid (`work_hours`) se vodi **detaljno tek od
JUNA 2026**. Pre toga se zarada obračunavala iz **drugog izvora**, pa podaci u gridu za period
**do maja 2026 zaključno NISU merodavni** i ne smeju se koristiti za zaključke o plaćanju.

**Praktično:** svaka analiza „ko je koliko radio/dobio" počinje od **01.06.2026**. Rupe, nule i
neslaganja pre tog datuma su očekivani i **ne prijavljuju se kao greške**.

**Primer zašto ovo stoji ovde:** 30.07. je automatska provera našla da su 01.05.2026 (Praznik rada)
dva čoveka imala kucanje na kapiji (7,87 h i 7,32 h) a u gridu 0 — što bi ličilo na neplaćen rad na
praznik. Nenad: „to je sve davno prošlo vreme, nismo ni vodili u ovom gridu od maja već od juna sve
detaljno, imali smo drugi izvor istine za plate." Prijava je zato **odbačena, ne prosleđena kadrovskoj**.

---

## 1. Odluke na snazi

### O-1 · Rad na praznik = 8 sati + stvarno odrađeni sati
**Odluka (Nenad, 30.07.2026):** za rad na neradni praznik plaća se **duplo**: praznik ide kao
**8 h redovno** (kao da se nije radilo), a **pored toga** se plaća **koliko je sati stvarno odrađeno**
tog dana. Primer: 6 h rada na 1. maj → 8 h redovno **+** 6 h.

**Potvrda (Nenad, 01.08.2026):** obračun **sam** da primenjuje pravilo (zatvoreno pitanje Č-1).

**Status:** ✅ **ŽIVO U KODU** (`263a4db6`, grana `feat/obracun-praznik-8h-plus`, 01.08.2026). U
`backend/src/modules/kadrovska/payroll/payroll-calc.ts` (grana „Radni dan kalendarski", `if (isHol)`)
sada stoji `praznikRadSati += h` **i** `praznikPlaceniSati += 8`, uz istu kapiju prava
(`isAutoPaidHolidayEligible`) koju već koristi grana bez sati. Ogledalo na frontendu
(`frontend/src/lib/grid-payroll.ts`) promenjeno istovremeno, da živi prikaz Σ ne laže.

**Oba načina evidentiranja sada daju isti novac** — kadrovska bira šta joj je lakše:
- **automatski:** upiši stvarne sate u kolonu **„sati"** → obračun sam dodaje 8 h praznika;
- **ručno (zatečeni obrazac, i dalje ispravan):** **`sp`** + stvarni sati u **prekovremeno**.

Provereno testom za oba puta: 9 h rada → **17 h** kod satnice, **9 h** dodatnih kod fiksne plate,
identično bez obzira na to koji se put koristi. Živi primer zatečenog obrasca sa 01.05.2026:
Bulović Nenad → `sp` + `9,00` prekovremeno, kapija 08:30–17:35 (9,08 h).

**Rubni slučajevi (svesno odlučeni, popisani i u komentaru u kodu):**
- **vikend-praznik se NE menja** — rad ostaje samo „praznični rad", bez 8 h, jer za dan za koji
  čovek ionako nije bio raspoređen ne postoji pravo na plaćen praznik (v. O-3);
- **šifra odsustva + sati** na praznik → zatečeno ponašanje netaknuto: sati pobeđuju šifru i knjiže
  se kao praznični rad, **bez** 8 h;
- **praksa / dualno / penzioner i dani pre datuma zaposlenja** → samo odrađeni sati, bez 8 h
  (dvostruka brana: `isAutoPaidHolidayEligible` + `sanitizeHoursForWorkType`);
- `kadr_holidays.is_workday = true` (naložena radna subota) **nije praznik** i ne ulazi u obračun
  praznika (AUDIT-K1 filter `isWorkday: false` kod svih pozivalaca).

**Koga ovo košta:** samo **satnica/ugovor** (65 aktivnih ljudi) — kod njih 8 h ulazi u `payable_hours`
sa koeficijentom 1,0. Kod **fiksno/jednokratno** (68 ljudi) `praznikPlaceniSati` **nije** u
`payable_hours`, pa izmena **ne menja iznos** — samo prikaz. Penzioneri (4) i praksa (1) su izuzeti.

**Uticaj na već obračunate mesece: NIKAKAV.** Provera nad živom bazom 01.08.2026 (v. §4).

**Posledica za automatiku:** autofill iz kapije od **01.08.2026 upisuje i delimično** kucanje na
neradni praznik — vlasnik je presudio da je evidencija važnija od automatske brane (v. O-4 i
zatvoreno pitanje Č-5). Time automatika **sama može da napravi duplu isplatu** (8 h + odrađeni sati);
to je **namerno**, a brana je Nikolina mesečna kontrola grida.

### O-2 · Vikendom i praznikom ne radi niko osim portira
**Odluka (Nenad, 30.07.2026):** subotom/nedeljom kad je praznik **ne radi niko**; izuzetak je
**portir**, koji ima **poseban dogovor** (nije obuhvaćen pravilom O-1).

Živi primer sa **01.05.2026 (PETAK — praznik, ne vikend)**: Sarić Srećko, kapija 06:50–20:51 → u
gridu **14,00 h** (puna portirska smena, ne 8+6).
> ✏️ Ispravka 01.08.2026: prvobitno je ovaj primer stajao kao dokaz za VIKEND, što je bilo netačno —
> 1. maj 2026. pada u petak. Primer i dalje ilustruje portirski izuzetak, ali na PRAZNIK, ne na vikend.
> Za sam vikend nemamo zabeležen primer, što je u skladu sa odlukom (niko ne radi).

**Status:** ODLUKA — portirski dogovor **nije formalizovan u kodu** (nema tipa ugovora „portir").
U praksi ga sistem ipak razlikuje: Sarić je `work_type = penzioner`, a taj tip je isključen iz
automatskog priznavanja 8 h plaćenog praznika (`isAutoPaidHolidayEligible`) — dakle O-1 se na njega
ne primenjuje ni danas, bez ijedne posebne brane. Ako se portirski dogovor ikad bude formalizovao,
ovo je mesto gde treba zapisati šta tačno obuhvata.

### O-3 · Rad na praznik koji padne u subotu/nedelju knjiži se kao rad na praznik
**Odluka (Nenad, 30.07.2026):** takav dan **nije** običan vikend rad — knjiži se kao **rad na
praznik**. **Status:** ✅ **ŽIVO U KODU** (`main 98b33709`, 30.07): u `payroll-calc.ts` i u
ogledalu na frontendu (`frontend/src/lib/grid-payroll.ts`) grana praznika sada ide **pre** grane
vikenda. Praktično redak slučaj — vidi O-2.

⚠️ **Napomena o novcu:** u obračunu **ne postoji množilac** za rad na praznik (množi se **1,0**, isto
kao redovan rad); jedini množioci u kodu su za bolovanje (0,65 / 1,00). Zato ova izmena za ljude na
**satnici** ne menja iznos, samo naziv stavke; za **fiksne plate** ti sati postaju plaćeni (jer se
kod fiksnih plaća prekovremeno + rad na praznik + dve mašine, a redovni sati ne).

### O-4 · Vikend i praznik sa kucanjem na kapiji = evidencija za SVE
**Odluka (Nenad, 30.07.2026):** kucanje na kapiji je **dokaz da je čovek dolazio**, pa se vikend i
praznik **evidentiraju svima** — uključujući ljude na **fiksnoj plati**, kojima ti sati u obračunu
(za sada) ne donose novac. Plaćanje takvih sati je **odluka vlasnika po slučaju**, ne automatika.

**Status:** ✅ **ŽIVO U KODU** (`main e36554d0`, 30.07 — zahtev 044/26; dopuna 01.08.2026).
Vikend/praznik sa čistim kucanjem ulazi u grid kao **redovni sati**; ručni unosi i odsustva se
**nikad ne prepisuju** (`ON CONFLICT DO NOTHING`, oznaka `auto:kapija`).

**Dopuna (Nenad, 01.08.2026) — neradni praznik se više NE izuzima:** upisuje se **svako** kucanje u
opsegu, i **delimično** (npr. 2,5 h), po istim pravilima kao bilo koji drugi dan (O-5: naniže na pola
sata; od 03.08.2026 **doslovno, bez kape na 8 h** — v. revidirani O-5).
> ✏️ Ispravka 01.08.2026: prethodni tekst je glasio „na neradni praznik upisuje se **samo pun dan** —
> delimično kucanje se ostavlja kadrovskoj da unese ručno, upravo zbog O-1." **Taj razlog je bio
> tačan do 01.08.2026 i danas više ne važi:** dok je obračun na praznik sa upisanim satima *gutao*
> 8 h, delimičan automatski upis bi radniku tiho zamenio 8 h sa 2,5 h. Otkad O-1 živi u kodu, sati se
> **dodaju** na 8 h, pa te štete nema.

**Vlasnička presuda (Nenad, 01.08.2026):** *„nemoj da preskače, jednostavno nam treba evidencija iz
automatike ko je dodatno radio za praznik. Nikola Mrkajić u svakom slučaju radi kontrolu sati i
potvrdu za svaki mesec."*

⚠️ **Šta ovo znači za novac:** automatika sada **sama može da generiše duplu isplatu** za praznik
(8 h plaćenog praznika + odrađeni sati) **bez ijednog ljudskog klika u trenutku upisa**. To je
**namerno**. Brana više nije tehnička nego **ljudska** — Nikola Mrkajić mesečno kontroliše i
potvrđuje grid, a upis ostaje samo **predlog** (`auto:kapija`, nikad ne gazi ručni unos ni odsustvo).
Ko ovo bude čitao kasnije: **nije bug, ne „popravljati" nazad** bez nove vlasničke odluke ovde.

### O-5 · Sati iz kapije = STVARNI sati, sečeni NANIŽE na pola sata — BEZ kape na 8 h
**Odluka (Nenad, 30.07.2026; revidirana 03.08.2026):** automatski predlog sati je **doslovno
prisustvo sa kapije**, sečeno **naniže** na pola sata:

> `sati = floor(prisustvo × 2) / 2`, za prisustvo u opsegu **[1 h … 14 h]**;
> ispod 1 h ili preko 14 h se **ne upisuje** automatski (nepromenjeno).

**Nema kape ni u jednom smeru:** 9,08 h → **9,0** · 7,8 h → **7,5** · 6,52 h → **6,5** ·
12,3 h → **12,0**. Razdvajanje na redovne/prekovremene sate ostaje posao urednika grida.

**Povod (zahtev 012/26, Duško Kostić):** 21. i 22.07.2026 je po kapiji radio **9 h**, a grid je oba
dana dobio **8 h** — stara kapa („7,6 h i više = 8 h") je tiho pojela sat rada, a dan se posle upisa
više ne revidira.

**Merenje nad živim podacima (jun–jul 2026), pokazano vlasniku PRE odluke:**

| Smer | Dana | Ukupno sati | Ko su ti dani |
|------|------|-------------|----------------|
| **naviše** | **918** | **+1.046 h** | svi sa prisustvom preko 8 h |
| **naniže** | **1.087** | **−544 h** | **tačno** opseg prisustva **7,6–7,99 h** (stara kapa ih je dizala na 8 h) |

**Vlasnička presuda (Nenad, 03.08.2026), doneta uz svest o gubitku:** *„grid = ogledalo kapije;
Nikola Mrkajić normalizuje u mesečnoj kontroli."* Dakle **7,8 h → 7,5 h je NAMERAN ishod**, ne greška
zaokruživanja: filozofija je **dokaz umesto procene** — automatika prepisuje ono što kapija kaže, a
ispravku radi čovek koji ionako mesečno kontroliše i potvrđuje grid. Ko ovo bude čitao kasnije:
**ne vraćati kapu na 8 h** (ni „samo naviše", ni samo za opseg 7,6–8,0) bez **nove vlasničke odluke
upisane ovde**.

⚠️ **NIJE RETROAKTIVNO:** postojeći redovi grida se **ne diraju** (`ON CONFLICT DO NOTHING` ostaje) —
pravilo važi za upise **od isporuke naviše**. Brojevi iz tabele su **procena efekta**, ne izmena
prošlih meseci.

**Odnos prema prazniku (Č-5 + O-1):** na **neradni praznik** važi **isto doslovno pravilo** za upis
odrađenih sati (praznična kapija je ukinuta 01.08.2026, v. O-4/Č-5) — npr. 9,5 h prisustva na praznik
upisuje **9,5 h**. Onih **8 h plaćenog praznika** po **O-1** dodaje **obračun** (`payroll-calc`), a ne
autofill; sati se na njih **dodaju**, ne zamenjuju ih. Ljudska brana za oba pravila je ista: Nikolina
mesečna kontrola.

**Status:** ✅ **ŽIVO U KODU** — pravilo u `backend/src/modules/kadrovska/grid-autofill.service.ts`
(`proposeHoursFromPresence`, jedini izvor istine); dele ga **noćni auto-tik i ručno dugme „Popuni iz
kapije"**, pa se menjaju zajedno. Grana `feat/autofill-stvarni-sati` (03.08.2026).

### O-6 · Zarade vidi samo izričita lista ljudi
**Odluka (Nenad, 30.07.2026):** pristup zaradama **ne sme** da zavisi od toga da li je neko
„administrator" — vezuje se za **imenovanu listu**. Trenutno na listi: **Nenad Jaraković** i
**Nevena Knežević**.
**Status:** ✅ **ŽIVO** u obe baze: u 4.0 preko `KADROVSKA_SALARY_ALLOWLIST`
(`backend/src/common/authz/effective-permission.ts`, zabrana nadjačava sve), a u 1.0/sy15 preko
tabele `kadr_salary_viewer_allowlist` + funkcije `current_user_can_view_salary()` (30.07 prebačeno
sa provere „je li admin" na listu). Dodavanje/skidanje = jedan upis u tu tabelu, bez izmene koda.

---

## 2. Odluke koje čekaju

| # | Pitanje | Zašto čeka |
|---|---------|------------|
| ~~Č-1~~ | ~~Da li obračun sam da primenjuje O-1 (8 h + odrađeni sati)?~~ | ✅ **ZATVORENO 01.08.2026** — Nenad potvrdio „da"; izvedeno u kodu, v. O-1 i §4. |
| Č-2 | Uvećanje za **rad nedeljom** i **noćni rad** — postoji li i koliko? | U kodu **nema nijednog** takvog množioca. |
| Č-3 | Formalizovati **portirski dogovor** (O-2) kao tip ugovora? | Sada se rešava ručnim unosom. |
| Č-4 | Da li se vikend sati ljudima na **fiksnoj plati** ikad plaćaju, i po kom pravilu? | O-4 kaže „odluka po slučaju" — nije pravilo. |
| ~~Č-5~~ | ~~Sad kad obračun sam dodaje 8 h, da li autofill iz kapije sme da upisuje **delimično** kucanje na neradni praznik?~~ | ✅ **ZATVORENO 01.08.2026** — Nenad: **sme, i treba**; „nemoj da preskače, treba nam evidencija ko je dodatno radio za praznik", uz Nikolinu mesečnu kontrolu kao branu. Izvedeno u kodu, v. O-4 i §4. |

---

## 3. Zašto je ovo bitno za proveru koda

Pravila iz §1 su **merodavna**. Ako se kod i ovaj dokument raziđu, **dokument je u pravu** i kod se
ispravlja (ili se odluka svesno menja kroz §4). Od 03.08.2026 **nema poznatih razlika** — poslednje
dve (O-1: kod je na praznik sa upisanim satima pojeo 8 h plaćenog praznika; O-5: autofill je kapirao
prisustvo ≥ 7,6 h na 8 h) zatvorene su izmenom koda.

## 4. Istorijat izmena

| Datum | Šta je promenjeno | Ko |
|-------|-------------------|-----|
| 30.07.2026 | Registar osnovan; upisane odluke O-1…O-6 i pitanja Č-1…Č-4. | Nenad (odluke), zapisao Claude |
| 30.07.2026 | Dodat §0 — grid je merodavan tek **od juna 2026**; raniji period imao drugi izvor istine za plate. Povod: odbačena prijava o 01.05. | Nenad, zapisao Claude |
| 01.08.2026 | **O-1 prešao iz „RUČNO" u „ŽIVO U KODU"**; zatvoreno pitanje **Č-1**; otvoreno **Č-5** (autofill). | Nenad (odluka), izveo Claude |
| 01.08.2026 | **O-4 dopunjen: autofill iz kapije više NE preskače delimično kucanje na neradni praznik**; zatvoreno **Č-5**; ispravljeno zastarelo obrazloženje u O-4 (staro „pojelo bi 8 h" prepisano iznad) i posledica u O-1. | Nenad (odluka), izveo Claude |
| 03.08.2026 | **O-5 REVIDIRAN: ukinuta kapa „7,6 h i više = 8 h"** — predlog je sada doslovno prisustvo sečeno naniže na pola sata. Povod 012/26 (Duško: 9 h po kapiji → 8 h u gridu). Odluka doneta uz merenje jun–jul 2026 (**+1.046 h na 918 dana / −544 h na 1.087 dana**), **nije retroaktivna**. Stari tekst prepisan u §4.4. | Nenad (odluka), izveo Claude |

### 4.1 O-1 — prethodni tekst (važio 30.07.–01.08.2026)

> **Kako se to danas evidentira (ISPRAVNO, i tako treba nastaviti):** u mesečnom gridu se tom danu
> upiše **`sp`** (plaćeni praznik → obračun daje 8 h) **i** stvarni sati u koloni **prekovremeno**.
> Živi primer sa 01.05.2026: Bulović Nenad → `sp` + `9,00` prekovremeno, kapija 08:30–17:35 (9,08 h).
>
> **Status:** ⚠️ **RUČNO** — obračun sam po sebi ovo pravilo NE primenjuje. U
> `backend/src/modules/kadrovska/payroll/payroll-calc.ts` (grana „Radni dan kalendarski", `if (isHol)`)
> stoji `if (h > 0) { praznikRadSati += h; continue; }` — tj. **ako su sati upisani u kolonu „sati",
> 8 h plaćenog praznika se PRESKAČE** i čovek dobije samo odrađene sate. Zato je ručni obrazac
> `sp` + prekovremeno jedini tačan način dok se to ne promeni u kodu.
>
> **Posledica za automatiku:** zbog ovoga autofill iz kapije **ne upisuje** delimično kucanje na
> neradni praznik (upisao bi sate u „sati" i time pojeo 8 h). Vidi O-4.

Ručni obrazac iz gornjeg teksta **nije ukinut** — i dalje radi i daje isti iznos (v. O-1).

### 4.2 Zašto je izmena bila bezbedna — merenje nad živom bazom (01.08.2026)

Provera `work_hours × kadr_holidays (is_workday = false)`, samo čitanje:

| Period | Redova sa `hours > 0` na neradni praznik | Stvarno dodatih 8 h |
|--------|------------------------------------------|---------------------|
| od 01.01.2026 | **1** (01.05.2026, Srećko Sarić, 14,00 h) | **0 h** — Sarić je `penzioner`, nije eligibilan |
| od 01.06.2026 (merodavni period, §0) | **0** | **0 h** |

Dakle izmena **ne dira nijedan već obračunat mesec** — ni u nemerodavnom periodu, gde jedini
pogođeni red pripada čoveku koji po tipu ugovora ionako nema pravo na plaćen praznik. Prvi dan na
koji će se pravilo uopšte primeniti je **11.11.2026 (sreda)** — jedini preostali neradni praznik u
2026. U celoj 2026. **nema nijednog** reda `kadr_holidays` sa `is_workday = true`.

### 4.3 Ukidanje praznične kapije u autofill-u — merenje nad živom bazom (01.08.2026)

Koliko (radnik, dan) parova autofill **novo upisuje** posle ukidanja kapije = kandidati koji prođu
pun filter (`grid_covered = false`, `absence_code IS NULL`, teren 0, `open_intervals = 0`,
ulaz+izlaz, bez odobrenog `dan_odmora`) na **neradni praznik**, sa prisustvom u opsegu
[1 h … 14 h] ali **ispod punog dana** (< 7,6 h). Samo čitanje:

| Period | Novih upisa | Napomena |
|--------|-------------|----------|
| 2026. do danas | **44** | svi u **nemerodavnom periodu** (§0), i **samo** ako neko ručno pokrene backfill |
| od 01.06.2026 (merodavni period) | **0** | na neradni praznik od juna **nema nijednog kandidata** |

Raspored tih 44: **15.02. — 2**, **16.02. — 18**, **17.02. — 23**, **02.05. — 1**
(prisustvo 3,68–7,55 h). Svi su pre juna, pa po §0 **nisu merodavni**.

⚠️ **Zašto 44, a ne 0:** noćni tik obrađuje **isključivo „juče"**, pa sam od sebe **nikad** neće
dodirnuti te dane. Do upisa može doći **samo** ako čovek svesno pokrene backfill
(`POST /kadrovska/grid/autofill-run` sa `from`/`to` u februar/maj) ili otvori „Popuni iz kapije" za
te mesece i snimi predloge. **Ne raditi to** za period pre juna 2026.

**Prvi dan kad ovo može stvarno da opali: 11.11.2026 (sreda)** — jedini preostali neradni praznik u
2026. (`kadr_holidays`, `is_workday = false`).

### 4.4 O-5 — prethodni tekst (važio 30.07.–03.08.2026)

> ### O-5 · Sati iz kapije se zaokružuju NANIŽE na pola sata
> **Odluka (Nenad, 30.07.2026):** 6,52 h → **6,5 h** (naniže, ne na najbliže). Prisustvo od **7,6 h i
> više** = **8 h** (kapa na pun dan). Prisustvo < 1 h ili > 14 h se ne upisuje automatski.
> **Status:** ✅ **ŽIVO U KODU** (`main e36554d0`).

**Zašto je kapa postojala i zašto je pala:** postavljena je uz pretpostavku „ko je bio ceo dan,
odradio je pun dan" — pa je i 7,6 h i 9,5 h prisustva davalo istih 8 h redovnih, a prekovremeni je
dodavao urednik. Prijava 012/26 je pokazala drugu stranu te pretpostavke: dan sa **9 h** po kapiji
ulazio je u grid kao **8 h**, i taj sat se posle nije vraćao jer dan postaje `grid_covered` i
automatika ga više ne dira. Vlasnik je 03.08.2026 izabrao doslovno pravilo (v. revidirani O-5),
**znajući** da isti potez skida sate u opsegu 7,6–7,99 h.

**Zaostalo u kodu:** konstanta `REGULAR_FULL_MIN` (7,6) je **obrisana**; `FULL_DAY_HOURS` (8) je
**zadržana samo kao informativno polje** `rule.regularHours` u odgovoru dugmeta „Popuni iz kapije"
(API-kompatibilnost sa frontendom) — **nije više kapa** ni na jednom mestu.

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

**Posledica za automatiku:** autofill iz kapije **i dalje ne upisuje** delimično kucanje na neradni
praznik — ali razlog više nije „pojelo bi 8 h" (ne bi), nego to što bi automatski upis sada sam
generisao duplu isplatu bez pogleda kadrovske. Vidi O-4 i novo pitanje Č-5.

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

**Status:** ✅ **ŽIVO U KODU** (`main e36554d0`, 30.07 — zahtev 044/26). Vikend/praznik sa čistim
kucanjem ulazi u grid kao **redovni sati**; ručni unosi i odsustva se **nikad ne prepisuju**
(`ON CONFLICT DO NOTHING`, oznaka `auto:kapija`). Na **neradni praznik** upisuje se **samo pun dan**
— delimično kucanje se ostavlja kadrovskoj da unese ručno, upravo zbog O-1.

### O-5 · Sati iz kapije se zaokružuju NANIŽE na pola sata
**Odluka (Nenad, 30.07.2026):** 6,52 h → **6,5 h** (naniže, ne na najbliže). Prisustvo od **7,6 h i
više** = **8 h** (kapa na pun dan). Prisustvo < 1 h ili > 14 h se ne upisuje automatski.
**Status:** ✅ **ŽIVO U KODU** (`main e36554d0`).

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
| Č-5 | Sad kad obračun sam dodaje 8 h, da li autofill iz kapije sme da upisuje **delimično** kucanje na neradni praznik? | Stari razlog za preskakanje je otpao (v. O-1), ali bi upis sada sam pravio duplu isplatu bez pogleda kadrovske. **Namerno nije menjano** uz O-1. |

---

## 3. Zašto je ovo bitno za proveru koda

Pravila iz §1 su **merodavna**. Ako se kod i ovaj dokument raziđu, **dokument je u pravu** i kod se
ispravlja (ili se odluka svesno menja kroz §4). Od 01.08.2026 **nema poznatih razlika** — poslednja
(O-1: kod je na praznik sa upisanim satima pojeo 8 h plaćenog praznika) zatvorena je izmenom koda.

## 4. Istorijat izmena

| Datum | Šta je promenjeno | Ko |
|-------|-------------------|-----|
| 30.07.2026 | Registar osnovan; upisane odluke O-1…O-6 i pitanja Č-1…Č-4. | Nenad (odluke), zapisao Claude |
| 30.07.2026 | Dodat §0 — grid je merodavan tek **od juna 2026**; raniji period imao drugi izvor istine za plate. Povod: odbačena prijava o 01.05. | Nenad, zapisao Claude |
| 01.08.2026 | **O-1 prešao iz „RUČNO" u „ŽIVO U KODU"**; zatvoreno pitanje **Č-1**; otvoreno **Č-5** (autofill). | Nenad (odluka), izveo Claude |

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

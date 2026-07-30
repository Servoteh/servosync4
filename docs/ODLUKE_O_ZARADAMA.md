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

**Kako se to danas evidentira (ISPRAVNO, i tako treba nastaviti):** u mesečnom gridu se tom danu
upiše **`sp`** (plaćeni praznik → obračun daje 8 h) **i** stvarni sati u koloni **prekovremeno**.
Živi primer sa 01.05.2026: Bulović Nenad → `sp` + `9,00` prekovremeno, kapija 08:30–17:35 (9,08 h).

**Status:** ⚠️ **RUČNO** — obračun sam po sebi ovo pravilo NE primenjuje. U
`backend/src/modules/kadrovska/payroll/payroll-calc.ts` (grana „Radni dan kalendarski", `if (isHol)`)
stoji `if (h > 0) { praznikRadSati += h; continue; }` — tj. **ako su sati upisani u kolonu „sati",
8 h plaćenog praznika se PRESKAČE** i čovek dobije samo odrađene sate. Zato je ručni obrazac
`sp` + prekovremeno jedini tačan način dok se to ne promeni u kodu.

**Posledica za automatiku:** zbog ovoga autofill iz kapije **ne upisuje** delimično kucanje na
neradni praznik (upisao bi sate u „sati" i time pojeo 8 h). Vidi O-4.

### O-2 · Vikendom i praznikom ne radi niko osim portira
**Odluka (Nenad, 30.07.2026):** subotom/nedeljom kad je praznik **ne radi niko**; izuzetak je
**portir**, koji ima **poseban dogovor** (nije obuhvaćen pravilom O-1).

Živi primer sa 01.05.2026: Sarić Srećko, kapija 06:50–20:51 → u gridu **14,00 h** (puna portirska
smena, ne 8+6).

**Status:** ODLUKA — portirski dogovor **nije formalizovan u kodu** (nema tipa ugovora „portir");
obračun ga tretira po opštim pravilima za taj tip ugovora.

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
| Č-1 | Da li obračun sam da primenjuje O-1 (8 h + odrađeni sati), umesto ručnog `sp` + prekovremeno? | Menja novac; treba potvrda i provera nad postojećim mesecima. |
| Č-2 | Uvećanje za **rad nedeljom** i **noćni rad** — postoji li i koliko? | U kodu **nema nijednog** takvog množioca. |
| Č-3 | Formalizovati **portirski dogovor** (O-2) kao tip ugovora? | Sada se rešava ručnim unosom. |
| Č-4 | Da li se vikend sati ljudima na **fiksnoj plati** ikad plaćaju, i po kom pravilu? | O-4 kaže „odluka po slučaju" — nije pravilo. |

---

## 3. Zašto je ovo bitno za proveru koda

Pravila iz §1 su **merodavna**. Ako se kod i ovaj dokument raziđu, **dokument je u pravu** i kod se
ispravlja (ili se odluka svesno menja kroz §4). Konkretno, danas je razlika u **O-1**: kod bi na
praznik sa upisanim satima **pojeo 8 h plaćenog praznika**, pa se pravilo drži ručnim obrascem.

## 4. Istorijat izmena

| Datum | Šta je promenjeno | Ko |
|-------|-------------------|-----|
| 30.07.2026 | Registar osnovan; upisane odluke O-1…O-6 i pitanja Č-1…Č-4. | Nenad (odluke), zapisao Claude |
| 30.07.2026 | Dodat §0 — grid je merodavan tek **od juna 2026**; raniji period imao drugi izvor istine za plate. Povod: odbačena prijava o 01.05. | Nenad, zapisao Claude |

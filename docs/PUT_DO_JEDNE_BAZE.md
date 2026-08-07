# Put do jedne baze — šta je ostalo da 3.0 bude jedini sistem

> **Za koga je ovaj dokument:** za odluke, ne za programiranje. Tehnički detalji su u
> `PLAN_GASENJA_SY15_2026-08-03.md` i pojedinačnim runbook-ovima (`SEOBA_*.md`); ovde piše
> **šta se menja, koliko traje i šta se dobija.**
>
> Stanje na dan **07.08.2026.** — sve brojke su merene na produkciji tog dana.

---

## 1. Gde smo sada — jednom rečenicom

Stara baza (`sy15`) više ne drži nijedan ekran na staroj adresi (stara aplikacija ugašena 03.08),
a od 07.08. više ne prima ni merenja sa uređaja. Ali **podaci** za veći deo firme još žive tamo.
Cilj je da se presele, most ukine, a stara baza ugasi.

**Već preseljeno i živo na 3.0:**

| Domen | Kada | Potvrda merenjem |
|---|---|---|
| Sastanci, akcione tačke, teme, zapisnici | **06.08.2026** ✅ | stara baza zamrznuta 04.08, nova piše svakodnevno |
| **SCADA** (kotlarnice, solarne elektrane) | **07.08.2026** ✅ | svih 5 sistema online, komanda do uređaja za 3 s |
| Šifarnici (predmeti, komitenti, artikli) | **07.08.2026** ✅ | 7.633 / 6.259 / 92.638, sinhronizacija u 03:45 |
| Mrtav most ka staroj proizvodnji | **ugašen 07.08** ✅ | 647 prolaza u 7 dana, **0 izmena** — radio je u prazno |

**Pripremljeno, ali prekidač još nije prebačen:**

| Domen | Stanje |
|---|---|
| Održavanje | šema, podaci, pravila i prava — **gotovo**; ostaje ožičenje ekrana |
| Reversi + Lokacije | kreće |
| Kadrovska | kreće |
| Projektni biro | podaci preneti, ali **kopija je zastarela** — mora se osvežiti pred preklop |

---

## 2. Šta još drži staru bazu u životu

Ranija verzija ovog dokumenta ovde je imala **grešku** koju je merenje oborilo: pisalo je da most
ka BigBit-u upisuje ~262 hiljade izmena. To nije bio taj most. Ispravno stanje:

| Ko piše u staru bazu | Koliko (mereno) | Šta je to |
|---|---|---|
| **Živi korisnici — Lokacije** | stalno, kroz radni dan | 🔴 **jedino mesto gde ljudi još upisuju u staru bazu** |
| **Kapija (Katze)** | 2.297 zapisa / 7 dana | Dolasci i odlasci radnika |
| **Noćni uvoz iz BigBit-a** | 99.295 izmena / 7 dana, jednom dnevno | Artikli, kupci, radnici, mašine |
| ~~SCADA~~ | **0 od 07.08.** | Preseljena |
| ~~Most ka staroj proizvodnji~~ | **0 — bio mrtav** | Ugašen |

Uz to, tri stvari oko **naloga korisnika** i dalje idu preko stare baze: spisak korisnika u
Podešavanjima, resetovanje lozinke, i provera role pri svakoj prijavi.

**Zaključak:** stara baza više nije opterećena — ostala je zbog **podataka**, ne zbog saobraćaja.

---

## 3. Koliko je stvarno urađeno

Mereno kroz tri nezavisna metra, da brojka ne zavisi od načina brojanja:

| Metar | Ukupno | Gotovo | Udeo |
|---|---:|---:|---:|
| Pravila iz baze koja treba prepisati | 216 | 32 | 15 % |
| Mesta u kodu koja idu preko mosta | 358 | 76 | 21 % |
| Tabela preseljenih | 150 | 19 | 13 % |

**Iza nas je oko petine posla.** Zvuči malo, ali **prva petina je bila najskuplja**: na sastancima
je napravljen alat i postupak koji svi naredni koraci koriste besplatno — svaki domen se preklapa
jednim prekidačem, sa povratkom unazad za dva minuta ako nešto krene naopako. Održavanje je zato
za jedan dan dobilo ono što je sastancima trajalo četiri.

---

## 4. Redosled — šta ide kada i zašto tim redom

Redosled nije proizvoljan; svaka zavisnost dole je **izmerena**, ne pretpostavljena.

### 🔄 Korak 2 — Održavanje (U TOKU, najdalje odmaklo)
**Procena je pala sa 10–14 na 5–7 dana**, jer je najteži deo već isporučen: prepisano je svih
14 pravila iz baze, 15 pogleda i ceo sloj prava. Ostaje ožičenje ekrana na nove podatke.
Ne zavisi ni od čega — može ceo da prođe sam.

### Korak 3 — Reversi + Lokacije ZAJEDNO
**Procena: 8–12 dana.** Idu zajedno jer nisu razdvojivi: izdavanje alata u jednom potezu upisuje
i u reverse i u lokacije; razdvajanje bi značilo da se pola posla upiše a pola ne.

🔴 **Ovo bih stavio odmah iza održavanja, a ne na kraj** — lokacije su jedino mesto gde ljudi
i dalje uživo pišu u staru bazu. Svaki dan odlaganja je dan sa dva izvora istine.

⚠️ Najteži pojedinačni komad u celoj seobi je ovde: dva pravila o razduživanju alata postoje
**samo** kao logika u bazi i moraju se napisati iznova (5–8 dana od gornje procene).

### Korak 4 — Kadrovska
**Procena: 10–15 dana.** Najveći domen: 64 tabele, pola miliona zapisa o dolascima, i najviše
pravila o pravima u celoj bazi. Plate su pod posebnom bravom.

### Korak 4b — Projektni biro
**Procena: 2–3 dana.** Čeka isključivo kadrovsku, jer njegova prava kreću od pitanja „koji je ovo
zaposleni". 🔴 **Kopija podataka je zastarela** (stoji od 06.08. dok se u staroj bazi radilo) —
prenos se mora ponoviti neposredno pred preklop, inače se tiho gubi dan i po rada.

### Korak 4c — Nalozi i lozinke
**Procena: 2–3 dana.** Ide uporedo sa kadrovskom. **Danas 7 stvarnih ljudi nije vidljivo adminu**
i njima se ne može resetovati lozinka — ovo to rešava.

### Korak 5 — Noćni uvoz i kapija
**Procena: 2–3 dana.** Ne sme ranije: taj uvoz i dalje hrani mašine za održavanje.

### Korak 6 — Gašenje
Stara baza se prvo **zaključa za pisanje** na nedelju dana (da se vidi da niko ne pišti), pa se
napravi trajna kopija, pa se gasi.

---

## 5. Koliko ukupno

| Scenario | Procena |
|---|---|
| Redom, jedan po jedan korak | **2–3 meseca** |
| Paralelno, dve grane | **7–8 nedelja** |
| Paralelno, tri grane | **5–6 nedelja** |

Paralelno je izvodljivo jer se domeni ne preklapaju. Ograničenje nije mašina nego dve stvari:
sve izmene baze prolaze kroz istu proveru redosleda, i **svaki preklop traži da neko iz firme
potvrdi da modul radi**.

---

## 6. Šta se dobija

- **Jedna baza** umesto dve — kraj razilaženju podataka. Samo tokom ove seobe uhvaćeno je više
  mesta gde su se dve istine tiho razilazile (spisak predmeta koji je lagao o statusu, zastarela
  kopija Projektnog biroa, prioriteti iz dva izvora).
- **Kraj kašnjenju** — nema više „zašto se ovo nije osvežilo".
- **Prava na jednom mestu** — danas ista osoba ima zapis u dva sistema; dok stara baza živi,
  **51 od 71 naloga** je izložen tihoj promeni prava.
- **Manje troška** — stara baza nosi servise koji postoje samo zbog nje.

---

## 7. Šta traži tvoju odluku (ne moju)

1. **SCADA istorija** — 2,56 miliona merenja, 599 MB (dve trećine cele stare baze). Preseliti sve,
   zadržati skraćeno, ili arhivirati na disk? *Odluka može uštedeti nedelju dana.*
2. **Crteži** — 995 MB u starom skladištu. U novo skladište ili arhiva na disk?
3. **Veza mašina ↔ lokacija** — dok su mašine u novoj a lokacije u staroj bazi, ta veza je „meka":
   ako stara baza ne odgovori, nova mašina neće dobiti lokaciju i to se neće javiti kao greška.
   Prihvatljivo, ili upis mašine mora da padne?
4. **Pristup kontrole** — nalog `kontrola@servoteh.com` danas vidi pogon; u novom sistemu bi to
   izgubio. Zadržati?
5. **Tempo** — redom (sigurnije) ili paralelno (brže, ali više provere odjednom na tvojoj strani).

---

## 8. Usput nađeno — kvarovi koji nemaju veze sa seobom

Merenja su otkrila tri stvari koje žive na produkciji nezavisno od ovog posla:

- **Modul „Objekti" ne može da sačuva nijedan red** — fali kolona u staroj bazi, ekran vraća
  grešku otkad postoji (0 sačuvanih objekata).
- **Skeniranje nalepnice mašine** (`ZADU-M-*`) tiho puca iz istog razloga.
- **Stari spisak predmeta lagao je o statusu** — 1.861 predmet koji je BigBit vodio kao gotov
  prikazivan je kao „u toku".

Prva dva su popravljena na novoj strani; treći je rešen prelaskom na nov izvor.

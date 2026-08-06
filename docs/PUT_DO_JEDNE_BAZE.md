# Put do jedne baze — šta je ostalo da 3.0 bude jedini sistem

> **Za koga je ovaj dokument:** za odluke, ne za programiranje. Tehnički detalji su u
> `PLAN_GASENJA_SY15_2026-08-03.md` i pojedinačnim runbook-ovima; ovde piše **šta se menja,
> koliko traje i šta se dobija.**
>
> Stanje na dan **06.08.2026.**

---

## 1. Gde smo sada — jednom rečenicom

Stara baza (`sy15`) više **ne drži nijedan ekran koji korisnik otvara na staroj adresi** — stara
aplikacija je ugašena 03.08. Ali **podaci** za veći deo firme još uvek žive tamo, i 3.0 ih čita
preko mosta. Cilj je da se ti podaci presele, most ukine, a stara baza ugasi.

**Šta je već preseljeno (živo na 3.0):**

| Domen | Kada |
|---|---|
| Sastanci, akcione tačke, teme, zapisnici | **06.08.2026** ✅ |

**Šta je pripremljeno ali još nije prebačeno:**

| Domen | Stanje |
|---|---|
| Održavanje (mašine, vozila, kvarovi, radni nalozi) | podaci spremni, preklop u toku |
| Reversi (alati) | podaci spremni, čeka lokacije |
| Projektni biro | podaci već preneti, čeka kadrovsku |

---

## 2. Šta još drži staru bazu u životu

Ovo je ključno: **čak i kad se svi ekrani presele, stara baza ne može da se ugasi dok ovo troje ne
pređe.** Aplikacija je zapravo njen *najmanji* korisnik.

| Ko piše u staru bazu | Koliko | Šta je to |
|---|---|---|
| **SCADA** (kotlarnice, solarne) | ~4 miliona izmena | Merenja sa uređaja, svakih 5 sekundi |
| **Most ka BigBit-u** | ~262 hiljade | Noćni uvoz artikala, kupaca, radnika |
| **Sama aplikacija 3.0** | ~20 hiljada | Ono što ljudi rade kroz ekrane |

Uz to, tri stvari oko **naloga korisnika** još uvek idu preko stare baze: spisak korisnika u
Podešavanjima, resetovanje lozinke, i provera role pri svakoj prijavi.

---

## 3. Redosled — šta ide kada i zašto tim redom

Redosled nije proizvoljan; svaki korak otključava sledeći.

### ✅ Korak 1 — Sastanci (GOTOVO 06.08)
Najmanji domen sa najviše pravila — namerno prvi, da se postupak uvežba na nečemu bezopasnom.
Prošlo je čisto iz drugog pokušaja; prvi je oborio Projektni biro pa je vraćen za dva minuta.

### 🔄 Korak 2 — Održavanje (U TOKU)
**Procena: 10–14 radnih dana.** Najviše mehaničkog posla: 145 mesta u kodu, 14 pravila iz baze,
34 tabele, 469 MB fajlova (uputstva i slike mašina).
**Dobra vest:** ne zavisi ni od čega drugog — može ceo da prođe sam.
⚠️ Jedna odluka čeka: održavanje danas upisuje mašine u Lokacije. Dok Lokacije ne pređu (korak 3),
taj upis mora privremeno da ide u staru bazu.

### Korak 3 — Reversi + Lokacije ZAJEDNO
**Procena: 12–18 dana.** Idu zajedno jer nisu razdvojivi: izdavanje alata u jednom potezu upisuje
i u reverse i u lokacije. Razdvajanje bi značilo da se pola posla može upisati a pola ne.
Ovde se prvi put dodiruje i **most ka BigBit-u** (lokacije se pune iz njega na svakih 5 minuta).

### Korak 4 — Kadrovska
**Procena: 15–20 dana.** Najosetljivije: plate su pod posebnom bravom, postoji trag ko je šta
menjao, i pravila oko odmora su strogo određena. Namerno poslednja od poslovnih domena —
tek posle tri uvežbana kruga.

### Korak 4b — Projektni biro
**Procena: 3–5 dana.** Podaci su već preneti; čeka isključivo kadrovsku, jer njegova prava kreću
od pitanja „koji je ovo zaposleni".

### Korak 4c — Nalozi i lozinke
**Procena: 5–8 dana.** Ide uporedo sa kadrovskom. Spisak korisnika, reset lozinke i provera role
prelaze na 3.0. **Danas 7 stvarnih ljudi nije vidljivo adminu** i njima se ne može resetovati
lozinka — ovo to rešava.

### Korak 5 — SCADA i most
**Procena: 8–12 dana.** Najveći pisac u staru bazu. SCADA program je već naš i radi na našem
serveru — menja se samo gde upisuje. Most ka BigBit-u je vezan za BigBit, čije je gašenje
planirano za **februar 2027** — tu treba odluka: ili most piše u 3.0, ili stara baza živi do tada.

### Korak 6 — Gašenje
Kad prethodno prođe: prvo se stara baza **zaključa za pisanje** (nedelju dana, da se vidi da niko
ne pišti), pa se napravi trajna kopija, pa se gasi.

---

## 4. Koliko ukupno

| Scenario | Procena |
|---|---|
| **Ako se radi redom, jedan po jedan korak** | ~3 meseca |
| **Ako se radi paralelno gde je moguće** (održavanje ‖ nalozi, reversi ‖ kadrovska) | **~7–9 nedelja** |

Paralelno je izvodljivo jer koraci diraju različite delove sistema. Ograničenje nije mašina nego
provera — svaki preklop traži da neko iz firme potvrdi da modul radi.

**Najveća nepoznanica nije nijedan od ovih koraka nego most ka BigBit-u** (korak 5). Ako BigBit
ostaje do februara 2027, stara baza može da živi samo zbog njega — u tom slučaju se sve ostalo
preseli, a ona ostane kao prazna ljuska sa jednim jedinim poslom.

---

## 5. Šta se dobija

- **Jedna baza** umesto dve — kraj razilaženju podataka (dva puta smo večeras uhvatili mesta gde
  bi se dve istine tiho razišle).
- **Kraj mostu** — nema više kašnjenja od 5 minuta i „zašto se ovo nije osvežilo".
- **Prava na jednom mestu** — danas ista osoba ima zapis u dva sistema i oni mogu da se raziđu.
- **Manje troška** — stara baza nosi servise koji postoje samo zbog nje.

---

## 6. Šta traži tvoju odluku (ne moju)

1. **Most ka BigBit-u** — da li da piše direktno u 3.0 (pa stara baza može ranije), ili ostaje kako
   jeste do gašenja BigBit-a u februaru 2027.
2. **SCADA istorija** — 2,4 miliona merenja, 558 MB. Sve prebaciti, ili zadržati skraćeno
   (npr. godinu dana) pa staro arhivirati?
3. **Tempo** — da li idemo redom (sigurnije, ~3 meseca) ili paralelno (~7–9 nedelja, više provere
   odjednom na tvojoj strani).

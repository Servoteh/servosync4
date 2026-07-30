# Sync i prelaz na 4.0 — šta treba odlučiti

> Sažetak stanja i **spisak odluka za vlasnika**, 30.07.2026.
> Povod: „da ovaj sync osmislimo tako da ga iskoristimo i za jedan potpuni sync
> prelaska, a da do tada radimo u oba programa — BigBit otvara predmete i
> komitente, tehnologiju radimo u ServoSync-u; artikle pripremiti."

---

## 0. Suština: prelaz nije nov program nego OKRETANJE VLASNIŠTVA

Potpun prelazni sync i dnevni sync **ne razlikuju se po kodu**. Oba čitaju istu
kopiju BigBit baze, oba upisuju istim mapperom, oba ne brišu ništa. Razlikuju se
samo po tome **ko sme da piše u koju tabelu**.

Zato jedina prava arhitektonska odluka glasi: **vlasništvo se upisuje kao podatak,
po entitetu — nikad zakucano u kodu.** Posledice su konkretne:

- prelaz postaje **preklapanje prekidača**, ne prepisivanje koda pod pritiskom;
- prelaz se može **uvežbati** koliko god puta, jer je povratak isto preklapanje;
- „ko je vlasnik ovog reda" prestaje da bude usmeno znanje i postaje provera koja
  može da padne na testu.

Danas je vlasništvo delom zakucano (`table-ownership.ts`, `CUSTOMERS_WRITE_OPEN`,
`assertItemWritesAllowed()`), a delom podrazumevano. To radi, ali se ne može
uvežbati.

---

## 1. Šta je već dokazano (ne traži odluku)

| Činjenica | Dokaz |
|---|---|
| Kanal iz kopije BigBit baze radi | 6.241 komitent i 7.623 predmeta uvezeno 30.07; 0 odbijenih |
| Predmeti 10006–10014 su stigli | provereno u bazi, sa komitentima |
| Uvoz je ponovljiv | drugi prolaz: 0 upisa, 0 izmena |
| Uvoz **nikad ne briše** | godišnje pražnjenje BigBita je normalno, ne gubitak |
| 4.0-native red preživljava sync | rezervisan opseg ključeva 900.000.000 + `CHECK` u bazi |
| Sudar broja predmeta se odbija i **imenuje** | paritet-guard, sa oba broja u poruci |
| QBigTehn je mrtav od 22.07.2026 | BigBit 10014 / QBigTehn i 4.0 na 10005 |

---

## 2. ODLUKE

### O-1. Ko poseduje šta do prelaza

**Preporuka:**

| Oblast | Vlasnik do prelaza | Šta to znači |
|---|---|---|
| Komitenti | **BigBit** | 4.0 ih samo čita; unos u 4.0 ostaje zatvoren |
| Predmeti | **BigBit** | isto; 4.0 prestaje da dodeljuje brojeve |
| Artikli | **BigBit** | 4.0 čita; unos zatvoren dok se ne pripremi |
| Glavna knjiga, PDV | **BigBit** | 4.0 računa paralelno radi provere |
| **Tehnologija** | **4.0** | tehnološki postupci, radni nalozi — BigBit ih ne dira |
| Kvalitet, kadrovska, sastanci | **4.0** | već je tako |

**Zašto ovako:** jedan vlasnik po oblasti znači da nikad ne postoji pitanje čija
je verzija tačna. Dvojno vlasništvo nad istim redom je ono što je danas stvorilo
paritet-guard i sudare brojeva.

**Šta treba da potvrdiš:** da li je spisak tačan i da li nešto fali (npr. cenovnici,
magacini, radni nalozi — ko ih otvara?).

---

### O-2. Da li 4.0 PRESTAJE da otvara predmete

Danas je na snazi **dvojni unos**: 4.0 dodeli broj, pa se isti broj prekuca u
BigBit. Odatle i paritet-guard.

**Preporuka: DA, 4.0 prestaje da otvara predmete.** Predmete otvara isključivo
BigBit, kako si i rekao.

**Dobit:** nestaje cela klasa problema — nema više dva reda sa istim brojem, nema
guarda, nema „čiji je broj tačan". Uvoz postaje čisto preslikavanje.

**Cena:** ko radi u 4.0 mora da sačeka sledeći prolaz sync-a da vidi nov predmet.
Uz dnevni prolaz to je do 24 h; uz prolaz na svaka 2–4 h je zanemarljivo.

**Otvoreno pitanje uz ovo:** šta sa 4.0-native predmetima koji VEĆ postoje? Ostaju
i dalje rade, ili se prenose u BigBit da bi izvor bio jedan? *(Preporuka: preneti
ih, da posle prelaza ne ostane dvostruka istorija.)*

---

### O-3. Koliko često sync radi

**Preporuka: dva puta dnevno** — ujutru pre posla i posle podne.

Dostava iz BigBita traje oko tri minuta i pokreće se zadatkom na Windows mašini.
Uvoz traje ispod pet minuta. Češće od toga nema koristi jer se i sam izvoz pravi
periodično.

**Šta treba da potvrdiš:** termini, i **da li Windows zadatak stvarno radi
automatski** — u drop folderu su do danas bila samo dva fajla, jedan od 11.07 i
jedan koji si ručno pokrenuo. Ako zadatak ne okida sam, sve ostalo je uzalud.

---

### O-4. Šta znači „pripremiti artikle"

Artikli su najveći šifarnik (91.000) i najviše nedostaje.

**Preporuka — tri koraka, tim redom:**

1. **Šifarnici grupa, podgrupa i porekla** — izvoze se, ali im fali korak uvoza;
   danas su prazni, pa provera grupe artikla *propušta sve*. Bez toga se ne može
   proveriti ni jedan artikal.
2. **Raster = dimenzije lima** + obračun kilaže po komadu. Analiza je utvrdila da
   je to kod Servoteha suština artikla, a tabela `RasterDef*` u 4.0 ne postoji.
   Treba izmeriti koliko artikala uopšte ima raster, pa onda praviti.
3. **Prateće tabele** koje forma traži a nemamo: više barkodova (`MultiFaktor`),
   kvalitet artikla, mesta izdavanja, ino nazivi, više dobavljača po artiklu.

**Šta treba da odlučiš:** ide li ovo pre ili posle unosa dokumenata. *(Preporuka:
šifarnici odmah — jedan dan posla, a bez njih ništa ne valja; raster i prateće
tabele posle prvih proba unosa dokumenata.)*

---

### O-5. Kada se sync GASI

Na dan prelaza sync mora da stane, inače prepiše ono što se od tada unosi u 4.0.

**Preporuka:** gašenje je **isto preklapanje vlasništva** iz O-1, ne posebna
radnja. Uz to:

- **generalna proba prelaza** najmanje **dvaput** pre pravog — pun prolaz uz
  poređenje brojeva BigBit ↔ 4.0 po svakoj tabeli;
- posle gašenja sync **ostaje instaliran ali ugašen** mesec dana, da se može
  vratiti ako nešto fali;
- BigBit ostaje da radi read-only još najmanje jedan PDV period.

**Šta treba da odlučiš:** datum prelaza. Iz ranije odluke: **početak godine**, uz
najmanje tri paralelna PDV obračuna do aprila 2027.

---

### O-6. Ko sme da menja šifarnik u 4.0 posle prelaza

Danas upis komitenata visi na ključu za **čitanje** (`directory.read`), koji ima
skoro svaka rola. Dok je unos zatvoren to ne šteti; na dan otvaranja bi značilo da
šifarnik menja svako.

**Preporuka:** nov ključ `masters.write`, uzak krug — knjigovodstvo i komercijala,
imenom. **Odluči ko.**

---

### O-7. Dupli PIB

BigBit dupli PIB **toleriše** — ima samo izveštaj, ne branu. Ako 4.0 uvede tvrdu
zabranu, uvoz počne da odbija redove.

**Preporuka:** upozorenje koje **imenuje** zatečenog komitenta, bez zabrane —
kako je već napravljeno. **Potvrdi da je to prihvatljivo**, ili reci da hoćeš
tvrdu branu pa da se BigBit prvo očisti.

---

## 3. Šta NE traži tvoju odluku — radim po svom

- korak uvoza za četiri šifarnika (isti obrazac kao komitenti);
- razlika po vodenom žigu + sedmično usaglašavanje;
- zvonce kad izvor zastane (danas je osam dana stajao i niko nije video);
- alarm „nestalo iz BigBita" koji ćuti o godišnjem pražnjenju a zvoni na
  pojedinačno nestajanje.

---

## 4. ODLUKE VLASNIKA — donete 30.07.2026

| # | Odluka | Šta iz nje sledi |
|---|---|---|
| **O-1** | ✅ Spisak vlasništva **prihvaćen kako je predložen** | vlasništvo se upisuje kao podatak po entitetu, ne u kod |
| **O-2** | ✅ **4.0 PRESTAJE da otvara predmete.** BigBit predmeti su glavni. Uz to: **porediti da nešto ne nestane iz ServoSync-a** | gasi se dodela broja predmeta u 4.0; uvodi se **kontrola nestajanja** (v. O-2a) |
| **O-3** | ✅ **Jednom dnevno, 17:30 po beogradskom** — 30 min posle pravljenja backup fajla | tajmer `OnCalendar=*-*-* 15:30:00 UTC`; v. napomenu o vremenu |
| **O-4** | ✅ **Šifarnici odmah**, ostalo posle prvih proba | grupe/podgrupe/poreklo/magacini su sledeći posao |
| **O-5** | ✅ **Sync se gasi 01.02.2027** (ranije samo uz javljanje) | do tada dvojni rad; posle toga 4.0 je jedini |
| **O-6** | ✅ **Svako sme da menja šifarnik** | `masters.write` ide široko; v. napomenu o riziku |
| **O-7** | ✅ **Dupli PIB se toleriše**, ali uz **strogu napomenu timu** i **zabeležen da će se rešiti** | upozorenje + trajan spisak duplikata koji se prati |

### O-2a. Kontrola nestajanja (traženo uz O-2)

Pošto BigBit postaje jedini koji otvara predmete, mora da postoji provera da
**nijedan predmet ne nestane iz 4.0**. Uvoz ionako nikad ne briše, ali predmet
može da „nestane" i drugačije:

- BigBit ga obriše ili promeni broj → kod nas ostaje sa starim brojem;
- 4.0-native predmet iz ranijeg dvojnog režima nema parnjaka u BigBitu.

Zato posle svakog prolaza ide poređenje u **oba smera**, sa spiskom:
- predmeti u 4.0 kojih **nema** u BigBitu → imenovati (to su bivši 4.0-native);
- predmeti u BigBitu kojih **nema** u 4.0 → to je kvar uvoza, mora da zvoni.

### ⚠️ Napomena uz O-3 — vreme mora da se potvrdi na PRVOM automatskom fajlu

Termin 17:30 je tačan **ako se backup pravi u 17:00**. Današnji fajl je nastao u
**16:03** (nasleđen `mtime` od izvorne baze) a legao na server u **18:01** — ali
taj je pokretan **ručno**, pa nije merodavan.

Prvi fajl koji stigne **sam** treba proveriti: ako legne posle 17:30, sync bi
svakog dana čitao **jučerašnje stanje**, i to bez ijedne greške — najgori mogući
oblik kvara. Brana `BB_SETTLE_SECONDS` štiti od čitanja polupreseljenog fajla, ali
NE od čitanja starog. Zato uz tajmer ide i **provera svežine drop-a** (v. §3).

### ⚠️ Napomena uz O-6 — šta znači „svako"

Prihvaćeno i sprovodi se. Ali da bude zapisano šta se time otvara: kartica
komitenta danas vraća **kreditni limit i maržu**, a šifarnik je osnov fakturisanja.
„Svako" znači da svaka rola sa pristupom aplikaciji može da promeni žiro račun
kupca. Ako se to ikad pokaže kao problem, sužavanje je jedan red u mapi rola —
ne traži izmenu koda.

### O-7 — kako se sprovodi

1. Unos **ne zabranjuje** dupli PIB (kako je i traženo).
2. Upozorenje **imenuje** zatečenog komitenta, ne kaže samo „već postoji".
3. Uvodi se **trajan spisak duplikata** (izveštaj u Podešavanjima) da se zna
   koliko ih je i da broj pada — inače „rešićemo kasnije" ostane zauvek.
4. Kad spisak dođe na nulu, tvrda brana se sme uvesti bez rizika po uvoz.

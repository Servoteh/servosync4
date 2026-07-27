# ServoSync AI — izveštaj o urađenom i plan daljeg

**Datum:** 27.07.2026 · **Period rada:** 26–27.07.2026 (2 dana) · **Za:** Nenad
**Podloga:** tvoja „AI Manufacturing OS" vizija (26.07) → realan plan `docs/PLAN_AI_OS_2026-07.md`

Ovo je presek stanja u trenutku pauze (Nenad na odmoru). Sav AI rad je **zaključan** — svaka
isporuka je na `main`-u i živa na produkciji, prošla kroz adversarijalni review (10–31 nalaz po
paketu) i deploy sa zelenim post-deploy-verify.

---

## 1. Kako smo došli dovde

Tvoja vizija je velika i ispravna, ali pola nje pretpostavlja podatke kojih još nema. Zato pre
ijedne linije koda: **inventura stvarnog stanja** (7 paralelnih revizija nad kodom i živim bazama —
ne po pretpostavci nego po izmerenim brojkama). Zaključak inventure:

- **AI temelj već postoji** i zreliji je nego što vizija pretpostavlja (jedan gateway ka svim
  modelima, alati sa prava-kroz-bazu, modul Zahtevi = tvoj „Product Inbox" već živ).
- **Jedan skup podataka je jak** (proizvodno jezgro: 40.860 naloga, 99.000 prijava rada, cela
  tehnologija sinhronizovana iz BigTehn), **ostalo je prazno** (nabavka 4.0 = 0 transakcija,
  kvalitet <320 zapisa, nijedan signal sa proizvodnih mašina).

Iz toga je izveden plan: prvo higijena postojećeg, pa učiniti asistenta korisnim nad jezgrom, pa
proaktivne funkcije — a sve što zavisi od nepostojećih podataka svesno odloženo.

---

## 2. Šta je URAĐENO (živo na produ)

| # | Isporuka | Šta konkretno radi | Verzija |
|---|----------|--------------------|---------|
| 1 | **AI-0 — higijena gatewaya** | AI odgovori se ne seku tiho; svaki AI poziv se meri (tokeni + procena cene u dinarima); pao poziv se ponovi pa pređe na rezervni model; ograničenje po tokenima umesto po broju poruka; zaštita od „prompt injection" napada svuda; registar modela u Podešavanjima | `bef75fe` |
| 2 | **AI-1 — asistent vidi proizvodnju** | Asistent sada zna za radne naloge, nacrte, artikle, predmete, tehnološki postupak; **istorija crteža sa stvarnim vremenima**; pretraga radi i bez kvačica („zaptivac" nalazi „zaptivač", ranije promašaj do 88%) | `5800d89` |
| 3 | **Zatvorena bezbednosna rupa** | GET rute radnih naloga i šifarnika komitenata su bile otvorene svakom prijavljenom korisniku (uklj. PDF štampu) — sada poštuju role | `ae6feaa` |
| 4 | **Kvalitet — škart i dorada V1** | Kontrolor evidentira škart/doradu u modulu; radnik sa kioska šalje prijavu-signal koju kontrolor potvrđuje ili odbacuje; Pareto pregled po razlogu i mašini; izbor naloga po poslovnom broju (ne internom) | `d5a0623` |
| 5 | **AI-3 — dnevni brief direktoru** | Jutarnji mejl sa rangiranim pregledom: kašnjenja naloga, zahtevi koji čekaju odluku, sastanci danas, kritična odsustva; brojke iz upita (AI samo sklapa tekst), izvor uz svaku stavku; imena i zdravstveni status NE odlaze spoljnom AI-ju | `0acf744` |
| 6 | **AI-5 — procena vremena po radnom mestu** | Uz svaku operaciju: koliko slični poslovi STVARNO traju na tom radnom mestu (interval + veličina uzorka), plus istorija istog crteža; 25 radnih mesta ima preko 100 stvarnih merenja; pošteno označava mali uzorak i nov crtež | `f025752` |
| 7 | **BigBit noćni sync** | Automatsko povlačenje umesto ručnog — **napisan i na produ, ali UGAŠEN** (čeka tebe) | `7ee4d36` |

**Popravke usput** (nađene tokom rada, nisu bile u planu):
- `istorija_crteza` (alat iz AI-1) je čitao skoro prazan izvor podataka → prebačen na pravi
  (99.000 prijava). Bez toga bi asistent na „koliko je trajao ovaj crtež" davao prazan odgovor.
- Bezbednosna rupa na GET rutama (stavka 3) — svaki korisnik je mogao da čita sve naloge.

**Trošak celog AI-ja do sada:** manje od 1 USD (merljivo zanemarljiv — model nikad nije bio
ograničenje; problem je uvek bio podaci i usvajanje).

---

## 3. Šta je GOTOVO ali čeka TVOJ potez (aktivacije)

Sve ispod je izgrađeno, testirano i deployovano — samo je ugašeno iza prekidača dok ne odlučiš.

| Stavka | Šta treba | Zašto čeka tebe |
|--------|-----------|-----------------|
| **BigBit noćni sync** | `BIGBIT_NIGHTLY_SYNC=true` + restart + kopirati monitor skriptu na server | **Tvoj strah je opravdan** — loše napisan sync bi oborio ServoSync (obrisao tipove dokumenata, napravio viseće reference, pregazio flagove predmeta). Te putanje su zatvorene PRE nego što je išta otišlo na prod, ali prvi prolaz radimo **ručno, danju, zajedno** — ne nenadgledano dok si na odmoru. Artikli ostaju izuzeti dok ne preneseš jedinstvene kataloške brojeve u BigBit. |
| **Dnevni brief** | `DAILY_BRIEF_ENABLED=true` + `DAILY_BRIEF_TO=lista mejlova` | Ti biraš ko dobija brief; svaki primalac vidi samo ono na šta ima pravo. |
| **Kvalitet — pravi razlozi** | Pošalji kategorije škarta/dorade iz 2 Excel fajla | Seed je zasad podrazumevanih 12 razloga jer agent nije imao pristup Excelima. Skripta za uvoz 150 postojećih redova je spremna (ne pokrenuta). |

---

## 4. Šta ČEKA PODATKE (planirano — kreće kad izvor postane realan)

Ovo su ostali delovi tvoje vizije. Svaki je **svesno odložen** jer bi danas bio prazna ljuska.
Uz svaki je tačan uslov iz plana (§6) koji ga otključava.

| Funkcija iz vizije | Šta joj treba pre početka |
|--------------------|---------------------------|
| **AI za nabavku** (milestones, kašnjenja dobavljača, cash-flow) | ≥50 stvarnih nabavki u 4.0 sa datumima plaćanja — danas 0 transakcija (ekrani gotovi, prazni) |
| **Cena koštanja i profitabilnost projekata** | ≥1 kvartal stvarnih finansijskih transakcija u 4.0 |
| **Prediktivno održavanje** | bar jedan signal sa proizvodnih mašina — danas ga NEMA (SCADA pokriva samo kotlarnice/solar) |
| **AI predlog tehnologije / DFM / DFA** | AI-5 (procena vremena) živ ≥3 meseca + tehnolozi potvrde korisnost istorijskih prikaza |
| **Predlog pripremka iz lagera** | popunjen lager (danas 36 redova iz jednog ručnog sinca) |
| **AI vizuelna kontrola kvaliteta** | kvalitet modul živ + fotografije se sistematski prikupljaju |
| **Knowledge graph / Digital Twin** | posle semantičke pretrage jezgra + 2 kvartala punih podataka |
| **Autonomni agenti (izvršavanje bez potvrde)** | Action Center meri ≥70% prihvaćenih predloga na nivou „draft" |

**Poluput — semantička pretraga (AI-2):** deo znanja (5.739 nacrta sa čitljivim tekstom, uputstva)
može ranije. Traži jednokratnu zamenu baze (kratak planirani downtime) koju si načelno odobrio —
termin biramo kad krenemo, van radnog vremena.

---

## 5. Šta ostaje NA TEBI kad se vratiš (kratka lista)

1. **BigBit sync** — dogovoriti termin za nadgledani prvi prolaz (zajedno)
2. **Dnevni brief** — upaliti flag + reći ko su primaoci
3. **Kvalitet** — poslati prave kategorije razloga (+ odluka o uvozu 150 redova)
4. **pgvector** — termin za semantičku pretragu (kratak downtime)
5. **Tabla zahteva** — potvrditi 003, 010, 014, 016, 019 (svi na „Spremno za test") → prelaze u „Završeno"
6. **Kataloški brojevi** — prenos jedinstvenih u BigBit (otključava i tvrd UNIQUE i artikle u syncu)

---

## 6. Princip po kojem je rađeno (da ostane zapisano)

- **Nijedna izmena bez adversarijalnog review-a pre push-a** — svaki paket je pre nego što je otišao
  na prod prošao kroz nezavisne „skeptike" koji su tražili greške; review je uhvatio i stvari koje
  bi tiho slomile sistem (fajl za povratak na staro koji bi oborio zaključavanje sastanaka; noćni
  sync koji bi obrisao podatke; brief koji bi slao imena+zdravlje spoljnom AI-ju; procena vremena
  naduvana 7× zbog smeća u prijavama).
- **Sve rizično čeka tebe.** Read-only i bezopasno se radi i dok si odsutan; sve što piše u baze
  ili se okida automatski (BigBit sync) čeka da budeš tu.
- **Podaci pre modela.** Pola vizije ne gradi se dok izvori ne sazru — to nije odustajanje nego
  redosled: gradnja bez podataka je platforma bez sadržaja.

# Uputstvo (doc 12) vs code-analize (18–34) — unakrsna provera „da ništa ne promakne"

> **Status:** UNAKRSNA PROVERA (2026-07-18). Nenad pita da li su code-first dubinske analize uzele u
> obzir master uputstvo („Uputstvo za korišćenje BigBit-a (sve zajedno).docx" → [doc 12](12-bigbit-uputstvo-master.md)).
> **Odgovor: docx je POTPUNO obrađen u doc 12; ali nekoliko OPERATIVNIH pravila iz njega code-analize
> nisu absorbovale.** Ovaj doc mapira šta se slaže, a šta mora da se dopuni.

## A) Šta se SLAŽE (doc 12 potvrđuje code-analize)

| Doc 12 pravilo | Code-analiza | Status |
|---|---|---|
| Kupci = **2040** (dom.) / 2050 (ino); NE 220 | [30](30-glavna-knjiga-modul-dubinski.md) našao kupci=202/2020/2040/2050 | ✅ **potvrđuje ispravku** (220≠kupci) |
| Dobavljači = 4350 (dom.)/4360 (ino) | [30](30-glavna-knjiga-modul-dubinski.md) | ✅ |
| Izvod → auto raspored 2040/4350, uparivanje po TR, kartica→4390 | [21](21-banking-izvodi-nalozi-rekonstrukcija.md)/[25](25-priprema-placanja-virmani-tok.md) | ✅ |
| Šeme kontiranja (IFR→2040 auto, UFROB auto, IFUSL ručno) | [18](18-gl-pdv-kontiranje-rekonstrukcija.md)/[30](30-glavna-knjiga-modul-dubinski.md) | ✅ mehanizam |
| Predmet/RN kao vezni ključ kroz lanac | [31](31-predmet-kicma-rfq-lanac.md) | ✅ |
| Nabavka: PO→prijem→3-way, auto-mail | [24](24-nabavka-tok-iz-koda.md) | ✅ |
| Profaktura = PON/REZR/REZM, rezervacija | [26](26-profakture-tok-iz-koda.md) | ✅ (Level konvencija) |
| Uvoz/carina ZT kalkulacija | [14](14-bigbit-carina.md) | ✅ (uputstvo doc 14) |

**Ključno:** doc 12 nezavisno **potvrđuje najspornija dva nalaza** — kupci su 2040 (ne 220) i posting
ide „po šemi". To znači da code-analize i uputstvo daju istu sliku na velikim stvarima.

## B) Šta code-analize NISU pokupile (operativna pravila iz doc 12 — MORA se preneti u 4.0)

Ovo su pravila koja kod ne kaže (jer su „kako se koristi", ne „kako je programirano") — a kritična su:

1. **„Crvena sveska"** (doc 12 §4.6/§5.1) — fizička Knjiga izlaznih faktura = izvor sledećeg broja
   IFR/IFUSL/IFGP + evidencija poslatih na SEF. **Kritična ne-sistemska zavisnost.** → 4.0 mora imati
   pouzdane sekvence po vrsti dokumenta i godini (ovo docs 26/30 pominju numeraciju ali NE kao rizik-zavisnost).
2. **Mesečni PDV ciklus — 8 koraka** (doc 12 Proces 19) — brisanje+reknjiženje auto naloga, kontrole
   izlaznih/ulaznih, USLRO→5012, TREB/TREB1→5110, ULGP→9020/9600/9800, slaganje SEF↔BB (16,66667%),
   obračun **47−27−2790**. → **Nijedna code-analiza nema ovaj procesni ciklus** (doc 18/30 imaju posting,
   ne mesečno zatvaranje). Mora u GL/PDV modul kao workflow.
3. **RuC=0 pravilo** (doc 12 §Proces 10/18/§7) — **Mag.VP cena = Nab. cena**; ako nije → razlika u ceni
   → neslaganje robno↔finansijski (1320/1010 vs lager). → Kritična konzistentnost, nije u code-docs.
4. **Trebovanje = 50% vrednosti GP** (doc 12 Proces 12) — proizvodno costing pravilo. → nije u [23](23-backlog-nedokumentovane-cacke.md).
5. **Uvoz — struktura GL naloga** (doc 12 Proces 16b): `4630 (ino) / 4350 (carina) / 2740 (PDV uvoz) /
   4350 (špediter) / 2700 (PDV špediter) / 1320|1010`, kursne razlike **5630/6630**, „preračunaj ponovo".
   → doc 14 ima proces, ali konkretan nalog + kursne razlike nisu u [18](18-gl-pdv-kontiranje-rekonstrukcija.md)/[30](30-glavna-knjiga-modul-dubinski.md).
6. **SEF polu-ručni tokovi (10a–10f)** (doc 12) — export XML iz BB, **ručni unos na SEF** kad ne može,
   **Pojedinačna evidencija PDV** za kupce van SEF-a, **BMTS: PDV kategorija Z, osnov 24-1-5**, avansna
   faktura → „za plaćanje = 0". → [07](07-bigbit-sef-efaktura.md) ima API, ali NE ove poslovne slučajeve/PDV kategorije.
7. **Cenovno/otpremno:** FCO prag **5000 din** (magacin prodavca/kupca), kurs **125 din, Robert Bosch 118**,
   IFR → **2 otpremnice bez cena**, IFUSL → **Zapisnik umesto otpremnice**, standardni pravni tekstovi
   (poresko oslobođenje, reklamacije 5 dana, nadležni sud, zatezna kamata). → nije u code-docs.
8. **Blagajna (BLAG)** (doc 12 Proces 3): konto 2419 ulaz, 2430 GK, per-trošak temeljnica, PDV 2704/2714,
   katalog troškova (5130 gorivo, 5510 reprezentacija…). → zaseban tok, nije dokumentovan u code-analizama.
9. **AVR knjiženje** (doc 12 Proces 6): 4300 duguje / 4720 potražuje. → doc 18/26 pominju avanse, ne ovaj konkretan par.
10. **Skidanje avansa dobavljaču** (doc 12 Proces 14, nalog RAZNO): 1520/27200/4350. → nije u code-docs.

## C) Zaključak i akcija

- **Doc 12 = docx, potpuno obrađen** (429 linija + §5 migracioni čeklist od 12 tačaka). Uputstvo NIJE
  promaklo — obrađeno je, i **potvrđuje** code-analize na velikim stvarima.
- **Ali operativna pravila iz §B (1–10) su „kako se koristi" znanje koje code-first analize ne mogu da
  vide** — moraju se svesno preneti u 4.0. Ona su i najveći deo doc 12 §5 „šta preneti".
- **Preporuka:** kad se pravi implementacioni plan po modulu, **za svaki finansijski modul ukrstiti sa
  doc 12** (posebno GL ← §B2 mesečni PDV ciklus + §B3 RuC; uvoz ← §B5; SEF ← §B6; blagajna ← §B8).
  Doc 12 §5 (12 tačaka) je de-facto zahtevi-lista za 4.0 finansije — koristiti ga kao acceptance kriterijum.

> **Sažetak za Nenada:** da, uputstvo je uzeto u obzir (doc 12, temeljno) i slaže se sa analizom koda;
> ali sam izdvojio 10 operativnih pravila iz njega koja kod ne pokazuje (crvena sveska, mesečni PDV
> ciklus, RuC=0, 50% GP, uvoz nalog, SEF ručni tokovi, FCO/kurs/zapisnik, blagajna, avansi) — da ta ne
> promaknu, sad su eksplicitno popisana i vezana za module.

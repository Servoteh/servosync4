# ServoSync 3.0 (izgrađeno) vs 4.0 (predstoji) — poređenje obima i složenosti

> **Datum:** 2026-07-18. Okvirno poređenje: šta je više koda, šta je teže napraviti. Sinteza iz
> merenja repoa + celokupne 4.0 analize (migration docs 06–31, `ANALIZA_PROCENA_4.0`).
> **Kratka presuda: 4.0 ima MANJE koda ali je ZNATNO teži za napraviti.**

## 1. Šta poredimo

- **3.0 = sve što je izgrađeno** (ovaj repo): ServoSync 2.0 proizvodni core + svi 1.0 moduli
  objedinjeni (cutover gotov 17–18.07). Proizvodni/tehnološki MES/ERP.
- **4.0 = komercijalni/knjigovodstveni ERP** (zamena BigBit-a): GL, PDV/POPDV/KEPU, banking, nabavka,
  prodaja/fakturisanje, profakture, carina, SEF, predmeti/RFQ + presečna infra (carry-over, audit, UI).

## 2. Obim koda — 3.0 ima VIŠE

| | 3.0 (izmereno) | 4.0 (procena) |
|---|---|---|
| Backend moduli | 29 | ~12–15 |
| Prisma modeli | 96 | +~40–60 |
| Frontend rute | 48 | ~15–25 |
| Kod (ts+tsx) | **~241k LOC** | **~100–160k LOC** (≈40–65% od 3.0) |
| Vreme (istorijski/procena) | ~17 aktivnih dana (burst) | ~58–95 AI-aktivnih dana |

**Zaključak obima:** 3.0 ima **više koda i više modula** (širina — kadrovska, održavanje, reversi,
sastanci, PDM, TP, RN…). 4.0 je uži po broju domena i verovatno **manji po LOC-u**.

## 3. Složenost gradnje — 4.0 je TEŽI (uprkos manjem kodu)

Ključ: 3.0 je **širok ali plitak po jedinici** (svaki modul = CRUD + workflow + UI, uglavnom
samostalan, timski proverljiv, porto­van sa 1.0 reference). 4.0 je **uži ali dubok** — po jedinici koda
mnogo teži, iz 5 razloga:

| # | Faktor | 3.0 | 4.0 |
|---|---|---|---|
| 1 | **Regulatorna tačnost** | skoro nema | POPDV/KEPU/PDV/SEF/bilansi — mora TAČNO, zakonska odgovornost |
| 2 | **Računovodstvene invarijante** | nema | dvojno knjiženje MORA da štima; saldakonti, IOS, konto 220/4350 balans |
| 3 | **Međuzavisnost** | moduli labavo vezani | sve se veže: predmet→RFQ→profaktura→faktura→GK→plaćanje; redosled bitan, ne gradi se izolovano |
| 4 | **Imutabilnost/audit** | lokalno (handovers lock) | proknjižen dok = immutable, period-lock, storno-put (doc 29) |
| 5 | **Usko grlo validacije** | tim vidi RN i potvrdi | POPDV polje 8ђ.6 NIKO ne vidi na oko — traži knjigovođu + pun paralelni PDV period |

**Najbolja ilustracija #5:** radni nalog možeš da pogledaš i kažeš „radi". Da li je PDV prijava tačna
ne možeš da „pogledaš" — mora se voditi paralelno sa BigBit-om bar jedan pun period i uporediti do
dinara. To validaciju čini gejtom koji AI ne može sam da prođe (zato je knjigovođa-konsultant u planu).

**Ireverzibilnost:** greška u RN-u se ispravi; greška u proknjiženoj fakturi/PDV prijavi ima poresku/
pravnu posledicu. To diže cenu svake linije 4.0 koda.

## 4. Mapa gustine (gde je težina koncentrisana)

**3.0 — najveći moduli (širina):** kadrovska (7.5k), održavanje (6.2k), tech-processes (5.5k),
sync (5.5k), reversi (4.5k), handovers (4.3k). Težina = mnogo ekrana/tokova, ali poznata „app" složenost.

**4.0 — najteže tačke (dubina, ne LOC):**
- **GL posting engine + PDV/POPDV** — MALO koda, OGROMAN rizik (POPDV = 164-redni obrazac formula, doc 18/30).
- **Prodaja/fakturisanje + carry-over** — veliki, sve se ovde spaja (doc 26/27).
- **Inventory/costing** — kalkulacija, nivelacija (doc 23).
- **Presečna infra** (radi se JEDNOM pa reuse): carry-over servis ~2–3 nedelje (doc 27), audit+lock
  ~9–15 AI-dana (doc 29), skriveni UI standard (doc 28).

## 5. Zaključak i implikacija

| Pitanje | Odgovor |
|---|---|
| Ko ima više koda? | **3.0** (~241k vs ~100–160k) — širi je |
| Šta je teže napraviti? | **4.0** — regulatorno, računovodstveno, međuzavisno, validacijom-gejtovano |
| Zašto tempo neće biti isti? | 3.0 burst (15–20k LOC/dan) je bio moguć jer je bio **port sa 1.0 reference + timski proverljiv**. 4.0 je greenfield-regulatorni, sa validacijom kao usko grlo → **kalendarski može trajati DUŽE od 3.0 iako ima manje koda** |

**Implikacija za plan:** 4.0 se ne meri po LOC-u nego po **broju regulatornih/knjigovodstvenih tačaka
koje čovek mora da potvrdi**. Zato:
1. Presečnu infru (carry-over, audit+lock, UI standard) uraditi PRVO — diže sve module.
2. GL kao temelj (plaćanja/IOS/fakture vise o njemu — odluka „vučemo iz GK").
3. Validaciju (knjigovođa + paralelni PDV period) ugraditi kao gejt, ne kao naknadnu misao.
4. Nabavka + predmeti/RFQ + profakture su **najbolji rani „sprint" kandidati** — najzreliji u analizi,
   najmanje zavise od GL-a, dobra vežba pre nego što se uđe u regulatorno jezgro.

> **Jedna rečenica:** 3.0 je bio *veći ali lakši* (širok port sa referencom); 4.0 je *manji ali teži*
> (usko, tačno, međuzavisno, pod zakonom) — pa priprema koju sad radimo (docs 06–31) i jeste najveći
> deo posla, kako je Nenad i rekao: „priprema mora da traje, posle ide lagano".

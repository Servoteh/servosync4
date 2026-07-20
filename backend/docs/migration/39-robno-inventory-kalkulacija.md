# Robno / magacin / kalkulacija — costing, zalihe, popis, RuC

> **Status:** ANALIZA (2026-07-18). Poslednji nepokriveni MUST domen. Temelj marže i konzistentnosti
> zaliha↔GK. Veze: [30](30-glavna-knjiga-modul-dubinski.md) (GK kontiranje), [27](27-prepisivanje-dokumenata-carry-over.md)
> (popis carry-over), [14](14-bigbit-carina.md) (uvoz), [24](24-nabavka-tok-iz-koda.md) (PO).

**Ključni princip:** BigBit **nema perzistentnu tabelu stanja zaliha** — i stanje i cene se računaju
**„u letu" (as-of)** iz `T_Robna dokumenta`+`T_Robne stavke`, filtrirano po magacinu/datumu/`Level`, uz
isključenje `Vrsta dokumenta="KODJ"`. Sve ispod je izvedeni model.

## A) Kalkulacija ulaza (landed cost: nabavna → VP → MP)

Landed-cost slog po stavci (`T_Robne stavke`, schema:1917): `Nabavna cena-neto`, `Zavisni trošak
sopstveni` (ZTsop), `…dobavljač` (ZTdob), `Kalkulativna VP/MP`, `Stvarna VP/MP`, `Taksa/Akciza/FiksniPorez`,
`DevNabCena`, `CarStopa`. Zaglavlje nosi uvoz: `Kurs/ObrKurs/CarKurs`, `Carina`, `Spedicija`, `OstaliZavTros`, `DevVredFak`.

**Domaća kaskada** (`SracunajKalkulaciju`, `Ulazna faktura - Podforma.txt:918`):
```
Nabavna neto = Fakturna − Rabat − Kasa
KalkVP = NabNeto + ZTsop + ZTdob + RuC + Akciza
KalkMP = Taksa + FiksniPorez + KalkVP*(1 + ΣStopa/100)
RuC    = KalkVP − NabNeto − ZTsop − ZTdob − Akciza   (definicija)
```

**Uvoz — ZT raspodela po JM** (`Module__UVOZ.txt:4-58`, ključ `DevNabCena/DevVredFak`):
```
carosnjm = DevNabCena*CarKurs + (PovCarOsn/DevVredFak)*DevNabCena     ' carinska osnovica/JM
carinajm = carosnjm*(CarStopa/100)
brutonabcena = DevNabCena*(brutonabvred/DevVredFak) + carinajm        ' pun landed cost/JM
```
tako da `NabNeto + ZTsop + ZTdob = brutonabcena`. **CarKurs** za carinsku osnovicu, **ObrKurs** za
knjigovodstvenu nabavnu — razlika kurseva ide u ZTsop.

**Propagacija u artikal** (`PrenesiIzKalkulacijeUArtikal`): ako `Zalihe=0` → upiši nove cene; ako ima
zaliha i cena promenjena → dijalog „nivelacija?" (revalorizacija zatečenih zaliha — vidi §F).

## B) RuC i pravilo RuC=0 (Mag.VP = Nab.cena)

**Obezbeđeno na GK strani:** u šemi `UFROB` (Sema 3) konto zaliha **`1320 = A+B+C`** (nabavna+ZTsop+ZTdob,
**bez RuC-a**); materijal `UFMAT` → **`1010 = A`**. Zaliha se u GK vodi po **nabavnoj (landed)** vrednosti
→ ukalkulisana RuC u magacinu = 0 → **Mag.VP = Nab.cena**. Razlika nastaje samo ako operater na ulazu
ostavi `KalkVP > nabavna` (unese maržu).

**Kontrole (gotove):** `Ukalkulisana razlika u ceni.sql` (ulaz: `Σ Kol*(KalkVP−NabNeto−ZTsop−ZTdob)` mora
0), `ProveraRUC.sql` (izlaz: ostvarena marža %), `Artikli koji imaju fin bez kol` (NEISPRAVNA KARTICA:
vrednost bez količine = pukla kartica). Alat za „traženje pogrešnih faktura" (doc 12 §18).

## C) Lager / costing metod = ponderisana prosečna „na dan"

`KLProsecnaVPCenaZalihaNaDan1Korak.sql`:
```
ProsecnaKalkVPCena = Σ(±Kol*KalkVP) / Σ(±Kol)
ProsecnaNabCena    = Σ(±Kol*(NabNeto+ZTsop+ZTdob)) / Σ(±Kol)
```
Filtri: `Datum<=[dan]`, `Vrsta<>"KODJ"`, `IDMagacin`. Stanje 0 → fallback poslednja cena. Prekidač
`Magacini.ProsecneCene` (2.0 `Warehouse.averagePrices`) — magacin bira prosečne cene.
- **Na izlazu:** trošak = prosek (`Nabavna=ProsecnaNab`, `KalkVP=ProsecnaVP`); `Stvarna VP/MP`=prodajna.
  **Kalkulativna=knjigovodstvena, Stvarna=transakciona; ostvarena RuC = Stvarna − Kalkulativna.**
- **Lager lista** (`Lager lista.sql`): stanje + poslednja + prosečna cena + rezervacije (`SlobodnaKol=Kol−RezKol`)
  + flag **`RazKLiProsVP = |VPC−ProsecnaKalkVP|≥0.01`** (nekonzistentnost). Varijante: MATERIJAL, VP, MP, KNG.
  Negativne zalihe: `NZ_NegativneZalihe.sql`.

## D) Popis / inventura

`T_Popis zaglavlja` (schema:2982) + `T_Popis stavke` (schema:1718: `KolKng` knjigovodstveno, `KolPop`
popisano, cene). Tok: **predpunjenje** iz robnog (`POPIS_DopisiKolKNG…`, cena bira `CenaZaUpisUPopis`) →
**unos `KolPop`** → **razlika** (`RazlikaKol=KolPop−KolKng`, >0 višak/<0 manjak) → **knjiženje** (carry-over
doc 27): `ProknjiziStavkeIzPopisaUUlazni_VISKOVI/_MANJKOVI` → INSERT u robne stavke (manjak = negativna
količina). GK: vrste `VISAR/VISAM` (Sema 46/41), `MANJR/MANJM` (Sema 50/49) → 6740/5740/5741 (višak
prihod/manjak rashod), zaliha 1320/1010.

## E) Robno → zalihe → GK → KEPU (konzistentnost)

Vozač = `R_Vrste dokumenata` (`UticeNaZalihe`, `Sema za kontiranje`, `KEPUDefZaduzenje/Razduzenje`, `KODJ`).
GK (slova A–E/O–Q, doc 18/30):
- **UFROB (3):** `1320 Dug=A+B+C`, `2700/2710 Dug=D/E`, `4350 Pot=A+B+C+D+E`
- **UFMAT (34):** `1010 Dug=A`; roba→1320, materijal→1010, oba po nabavnoj (RuC=0)
- **IFR (33):** `2040 Dug=O+P+Q`, `6040 Pot=O`, `4702/4710 Pot=P/Q`, `1320 Pot=A` (razduženje), `5010 Dug=A`
  (COGS). **Marža = 6040−5010 = Stvarna − Kalkulativna.**
- **UVOZ (32):** `1320 Dug=A`, `2740 Dug=D`, `4360 Pot=A`

**KEPU (regulatorno, hrani se odavde):** `Vrednosti po dokumentima.sql`: `MagUlaz=Σ(Ulaz)Kol*(KalkVP+Taksa)`,
`MagKLizlaz`, `MagStvarniIzlaz=Σ(Izlaz)Kol*(StvarnaVP+Taksa)`. Rekoncilijacija robno↔KEPU (`TEST Razlike…`).
MP KEPU odvojen (van scope-a).

## F) Nivelacija — ✅ ODLUKA (Nenad, 18.07): RADI SE KAO U BIGBITU (MUST)

**„Nivelacija mora da se radi kao u BigBitu — moraju se uprosečiti cene, jer ista roba ima različite
cene i zavisne troškove uvoza."** Time je otvoreno pitanje iz §G REŠENO: **replicira se legacy model**
(jedna valuaciona cena po artiklu + nivelacija + uprosečavanje), NE alternativa bez nivelacije.

Mehanizam: BigBit drži jednu valuacionu cenu po artiklu (`R_Artikli.VP/MP`); kad nov ulaz stigne po
drugačijoj KalkVP a stanje>0 → nivelaciona stavka revalorizuje zatečeno stanje sa stare na novu cenu
(`Module__Nivelacija.txt`: `OdrediNeproknjizeneNivelacijeZaliha`, prag `|Stara−Nova|≥0.01`). Vrsta `NIV`
(`UticeNaZalihe=True`). Model: `Stavke nivelacije` (parovi Stara/Nova: NabNeto, ZTsop, ZTdob, VP, MP).
Uprosečavanje = ponderisana prosečna (§C) kao osnov nove cene. **Meni stavka „Nivelacija zaliha" ostaje
precrtana kao RUČNA operacija** (BB_T_26 §4) — ali automatska nivelacija pri ulazu (uprosečavanje) je MUST.

## G) 2.0 stanje + procena

**2.0 ima ljušku, ne logiku:** `GoodsDocument`/`GoodsDocumentItem` (schema:1056/1121) — **svi landed-cost
stupci već preslikani** (purchasePriceNet, dependentCostOwn/Supplier, calc/actual VP/MP, customs,
forwarding, fx). `Item`, `DocumentType` (`affectsStock`, `kepuDefault*`), `Warehouse` (`averagePrices`),
`PriceListEntry`, `TaxRate`. `MrpItemStock` = snapshot (`freeStock=inStock−reserved`, samo čita).
**Nema:** costing servis, kalkulacija write-path, uvoz ZT, lager, popis, nivelacija, KEPU, GK kontiranje robnog.

| Deo | MUST/SHOULD | AI-dani |
|---|---|---|
| Costing servis (weighted-average as-of po magacinu) | MUST | 3–4 |
| Kalkulacija ulaza (kaskada + uvoz ZT raspodela) | MUST | 4–5 |
| Lager lista (stanje+cene+rezervacije+RazKLiProsVP) | MUST | 2–3 |
| Popis (modeli + predpunjenje→unos→razlika→knjiženje) | MUST | 3–4 |
| GK kontiranje robnog (šeme 3/32/33/34) + **KEPU** + rekoncilijacija | MUST (regulatorno) | 4–6 |
| RuC kontrole (ukalkulisana/ostvarena, neispravna kartica, neg. zalihe) | MUST | 2 |
| **Nivelacija (kao BigBit, uprosečavanje)** | **MUST** (odluka 18.07) | 2–3 |
| Uvoz-carina modeli / međumagacinski prenos | SHOULD | 3–5 |
| **Ukupno MUST** | | **~20–27 AI-dana** |

**✅ Arhitektonska odluka REŠENA (Nenad, 18.07):** radi se **kao u BigBitu** — jedna valuaciona cena po
artiklu + automatska nivelacija sa uprosečavanjem (ista roba stiže po različitim cenama i zavisnim
troškovima uvoza → cene se uprosečuju). Alternativa „weighted-average bez nivelacije" odbačena.

**Regulatorno:** KEPU (veleprodaja) se puni iz ovog sloja — MUST za usklađenost. Veze: GL (30), carry-over
(27), nabavka (24), carina (14), terminologija (38: „Primka/Zalihe/Popis/Nivelacija").

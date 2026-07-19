# FAZA 7 — Završni račun / ZR (implementacioni dizajn, build-ready)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Verifikovano nad kodom.
> Preduslov: Faza 2 (LedgerEntry + izraz-parser). **OS van scope-a** (knjigovođa; OS-pozicije = ručni unos). **Ništa nije primenjeno.**

## Arhitektura — 4 sloja (definicija → snapshot → evaluator → obračun), modul `zavrsni-racun/`

### (1) Modeli (`/// Was:`, @map snake_case, Decimal)
- **`ZrDefLine`** (`/// Was: ZR_AOP_Modla + T_GK_IZV_Stavke`): `form` BS|BU|SI, `aop`, `section`, `label`, `formula`
  (GKEval def; null kod MANUAL/OS), `targetColumn`, `columnSpan`, **`sourceType` GL|AOP|MANUAL**, **`sizes[]`**
  (mikro|malo|srednje|veliko — koja veličina dobija AOP), `orderIndex`.
- **`ZrControlRule`** (`/// Was: ZR_AOP_Pravila`): `expression` (logička GKEval, npr. `A0071 = A0401`), `message`,
  `severity` error|warning.
- **`GrossBalanceSnapshot`** + **`GrossBalanceRow`** (`/// Was: tmp_APGK_BrutoStanje`): `konto`, `psDuguje/psPotrazuje`,
  `prometDuguje/Potrazuje` (**promet ISKLJUČUJE PS**), `saldo*`. Mapiranje GKEval: D→prometDuguje, P→prometPotrazuje,
  PSD→psDuguje, PSP→psPotrazuje.
- **`ZrRun`** + **`ZrLine`** (`/// Was: ZR_Zaglavlje/ZR_Stavke`): `year`, `form`, `companySize`, `status`
  draft|validated|exported|locked, `version`; `ZrLine.amount1/2/3` (amount3=prethodna godina), `source`, `isManual`.

### (2) GKEval engine (pravi parser sa prioritetom — ispravlja legacy bug)
- **Deljeno jezgro** `common/expr/` (reuse Faza-2 VredIzraza): Pratt/rekurzivno-descentni parser sa pluggable atom-resolverom.
- ⚠️ **`*` i `?` su Like-wildcard vezani za atom (konto/aop), NIKAD aritmetički** — lexer ih apsorbuje u atom. Aritmetika
  ima samo `+ − ( )`.
- **Gramatika po prioritetu** (nisko→visoko): OR/XOR → AND → NOT → poređenja → aditivno (**LEVO-ASOCIJATIVNO** —
  ispravlja legacy bug gde `a−b−c` daje `a−b+c`) → unarni minus → primary. Prefiks najduži-prvi PSD/PSP→AB/AC→D/P/A.
- **Evaluator:** atom `D<pat>`=Σ prometDuguje gde konto matchuje pat (wildcard→prekompajlirani regex, **bez N DB upita**);
  `A<aop>`=aopValues. Decimal (aritmetika) + boolean (kontrolna pravila). Sve `Prisma.Decimal`.
- **Zlatni testovi:** `D202* + P433* − D021*`; asocijativnost `a−b−c`; wildcard; pravila `A0071 = A0401`; nula.

### (3) BrutoStanjeService
Iz LedgerEntry GROUP BY konto (Decimal, ne zaokruženo): `psDuguje=Σ WHERE nalogVrsta LIKE 'PS%'`, `prometDuguje=Σ WHERE
NOT LIKE 'PS%'`, saldo=PS+promet. **Zaokruživanje na hiljade se NE radi po kontu nego na kraju na AOP** (izbegava
akumulaciju greške). Snapshot frozen/immutable (Faza 0 audit).

### (4) BS/BU/SI generisanje
(a) izaberi ZrDefLine po form+companySize → kopiraj u ZrLine (mikro/malo dobija manje AOP-a); (b) **MANUAL/OS linije NE
računaj** — učitaj ručni unos knjigovođe PRE evaluacije, ne prepisuj pri regeneraciji; (c) evaluiraj GL-formule pa
AOP-reference **topološkim sortom** (detekcija ciklusa, umesto legacy 3-prolaza); (d) prethodna godina → amount3; (e)
zaokruži svaku AOP na hiljade; (f) **ZrControlRule** (aktiva=pasiva) preko GKEval boolean → error blokira. BU: `D5*`
rashodi, `P6*` prihodi, `540` amortizacija; BS OS: `PSD022*+D022*−PSD0229*−D0229*` (bruto−ispravka), zemljište `021*` bez ispravke.

## APR eFI XML + zaključni + PS otvaranje (komponenta 2)
- **AprXmlExportService:** FiForma (namespace `schemas.datacontract.org`, `<NumerickoPolje><Naziv>aop-{AOP}-{kolona}
  </Naziv><Vrednosti>{zaokruženo}</Vrednosti>`, nule `i:nil="true"`) za BS/BU/SI iz ZrLine → XML za upload u APR.
- **Ručni unos OS-pozicija** (knjigovođa daje brojeve klase 0) u AOP-ove ZrLine (OS nije naš modul).
- **Zaključni nalozi klase 7** (opciono — rezultat se izvodi iz bruto stanja; ako se radi, protiv-nalog 5/6→710→720→34/35
  preko Faza-2).
- **Otvaranje nove godine = nalog vrste PS** (prenos otvorenih stavki 2040/2050/4350/4360/avansi/predmeti/profakture,
  doc 12 §1) — veza sa Cutover (Faza N).

## Redosled + Quick win
1. Deljeni expr parser + GKEval engine + testovi. 2. BrutoStanjeService + snapshot. 3. ZrDefLine seed (dump AOP šablona
+ pravila iz .MDB). 4. BS/BU/SI generisanje. 5. APR XML. 6. Ručni OS unos + PS otvaranje. **Quick win:** bruto bilans
iz GK + jedan AOP izračunat GKEval-om (npr. ukupna aktiva) — dokaz da engine radi.

## Odluke
- ✅ **Pravi parser sa prioritetom (levo-asocijativan)** — ispravlja legacy GKEval bug — mi-tehnicki.
- ✅ **`*/?` = Like wildcard, ne aritmetika** — mi-tehnicki.
- ✅ **OS-pozicije = ručni unos** (OS kod knjigovođe) — Nenad (odlučeno).
- ✅ **Zaokruživanje na AOP nivou** (ne po kontu) — mi-tehnicki.
- ⏳ **Dump ZR_AOP_Modla/T_GK_IZV_Stavke/ZR_AOP_Pravila iz .MDB** (formule nisu u CSV) — mi-tehnicki (isti DAO put).
- ⏳ **OS brojevi za AOP + potvrda bilansa** — Nesa/knjigovođa (K3).

## Rizici
- **Formule/AOP u binarnom .MDB** → dump pre seed-a (isti DAO put kao POPDV_DEF).
- **APR XML mora biti tačan** → kontrolna pravila (aktiva=pasiva) + knjigovođa validira.
- **GKEval bug replikacija** → 4.0 pravi parser; test na legacy primerima da rezultati štimaju semantički.

**Procena Faze 7:** ~11–16 AI-dana (OS modul izbačen — knjigovođa).

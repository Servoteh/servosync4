# ServoSync 4.0 — indeks implementacionih planova (build-ready)

> **Datum:** 2026-07-19. Master indeks svih faznih dizajna. Ceo BigBit je analiziran (migration docs 06–41),
> pa razrađen u fazne implementacione planove (verifikovano nad stvarnim 2.0/3.0 kodom, workflow po fazi).
> **Ništa nije primenjeno** — sve je spremno-za-gradnju. Redosled gradnje i zavisnosti u
> [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md).

## Fazni planovi

| Faza | Plan | Ključni deliverable | Procena (AI-dana) |
|---|---|---|---|
| **0** Presečna infra | [PLAN_FAZA_0](PLAN_FAZA_0_presecna-infra.md) | audit(field-diff/CLS)+lock+**undo**, carry-over servis, UX standard, Resend | ~15–22 |
| **1** Konsolidacija+šifarnici | [PLAN_FAZA_1](PLAN_FAZA_1_konsolidacija-sifarnici.md) | master+external_id+overlay, bigbit_raw, kontni plan+šeme admin | ~15–20 |
| **2** GL jezgro | [PLAN_FAZA_2](PLAN_FAZA_2_gl-jezgro.md) | JournalEntry/LedgerEntry, posting engine, balans-kontrola, storno | ~18–26 |
| **3** Robno/costing | [PLAN_FAZA_3](PLAN_FAZA_3_robno-costing.md) | kalkulacija+uvoz ZT, prosečna+**nivelacija**, lager, popis, KEPU | ~20–27 |
| **4** Saldakonti+plaćanja | [PLAN_FAZA_4](PLAN_FAZA_4_saldakonti-placanja.md) | otvorene stavke(izveden pogled), IOS, kompenzacija, izvodi, virmani | ~15–22 |
| **5** Fakturisanje+SEF | [PLAN_FAZA_5](PLAN_FAZA_5_fakturisanje-sef.md) | izlazni računi(dom+izvoz), carry-over, SEF, štampa/mail, reversi=REV | ~15–22 |
| **6** PDV/POPDV | [PLAN_FAZA_6](PLAN_FAZA_6_pdv-popdv-kepu.md) | PDV knjige, POPDV(deklarativni), mesečni ciklus, PPPDV | ~8–12 |
| **7** Završni račun | [PLAN_FAZA_7](PLAN_FAZA_7_zavrsni-racun.md) | GKEval engine, bruto stanje/PS, BS/BU/SI, APR XML (OS ručno) | ~11–16 |
| **B** Komercijala | [PLAN_TRAKA_B](PLAN_TRAKA_B_predmeti-nabavka.md) | predmeti write+RFQ, **nabavka(sprint, auto-mail RFQ)** | ~25–35 |
| **N** Cutover | [PLAN_FAZA_N](PLAN_FAZA_N_cutover.md) | migracija+PS otvorene stavke, paralelni rad, gašenje BigBit | ~8–14 |

## Kapija 0 — sve otvorene odluke (pre gradnje)
Detaljno u [PLAN_GRADNJE_4.0_FAZNI.md §Kapija 0](PLAN_GRADNJE_4.0_FAZNI.md). Po vlasniku:
- **Negovan:** magacin ID→tip, robne konvencije, **projects master (N3 — preporuka: 2.0 master)**, RBAC mapiranje,
  RadniNalozi scope, BB kredencijal, CustomerDiscount matrica.
- **Nesa/knjigovođa:** validacija POPDV/KEPU/GL/bilansi (paralelno, K1), kontni plan+šeme potvrda, OS brojevi za ZR,
  konto banke, saldakonto pod-konta.
- **Tatjana:** landed cost ključ raspodele (T1).
- **Nenad:** cutover timing MSSQL→BigBit, bigbit_raw da/ne, koliko godina istorije, period paralelnog rada, POS ne.

## Presečne odluke već rešene (tehnički)
audit dva-sloja + CLS bez nove zavisnosti · soft-delete eksplicitan filter · Decimal(19,4) svuda · Float→Decimal
migracija robnog · storno=protiv-nalog · otvorene stavke=izveden pogled · effective-dated PDV resolver · POPDV/GKEval
= deklarativni + safe parser (ispravlja legacy bug) · bigbit_raw jednokratni staging · items dual-key (opcija A).

## Redosled i kalendar
**Kapija 0 → (Faza 0 ∥ Faza 1) → Faza 2 GL → {3,4,5,6,7 sekvencijalno} ∥ Traka B → Cutover.**
Kalendarski **4–7 meseci** (procene se preklapaju — dele carry-over/GL/audit); najveći rizik = **validacija knjigovođe**
i **latenca odluka**, ne kod. Nabavka (Traka B) = rani nezavisni rezultat.

## Review (adversarni, 19.07)
[PLAN_REVIEW_4.0_nalazi.md](PLAN_REVIEW_4.0_nalazi.md) — verdikt **UZ-ISPRAVKE**: plan zreo i kod-verifikovan, ali 4
blokade pre gradnje (B1 goods_documents vlasništvo, B2 GL kanonska imena, B3 PS-po-fakturi, B4 prod migracija aditivna) +
1 autoritativna konto mapa. Sve rešivo na Kapiji 0 bez rušenja arhitekture. Unето u [Kapiju 0](PLAN_GRADNJE_4.0_FAZNI.md).

## Analitička podloga
Sve fazne odluke se oslanjaju na [migration docs 06–41](../backend/docs/migration/README.md) (rekonstrukcija BigBit-a
iz koda + izvučene formule/šeme/POPDV_DEF) i [procenu](ANALIZA_PROCENA_4.0_AGENTI_2026-07.md).

# ServoSync 4.0 — fazni plan gradnje (Fable)

> **Datum:** 2026-07-19. Izvod iz baze znanja (migration docs 06–41 + procena + harvest 145 pitanja).
> **Princip:** svaka faza ima (1) scope + izvore, (2) procenu u AI-aktivnim danima, (3) **otvorena pitanja
> koja se rešavaju PRE te faze** sa vlasnikom, (4) acceptance kriterijum. Ništa se ne gradi dok njegova
> blokirajuća pitanja nisu rešena.
>
> **Jedinice:** AI-aktivni dan = burst-tempo (ceo modul 1–4 dana, ~15–20k LOC/dan). Procene se **ne sabiraju
> naivno** — faze dele presečnu infru (carry-over, audit, GL). Kalendarski: **4–7 meseci** (procena Scenario B),
> uz knjigovođu kao validacioni gejt i period paralelnog rada.

---

## KAPIJA 0 — Sastanak odluka (PRE ijedne linije koda)

Sva blokirajuća pitanja iz baze znanja, grupisana po vlasniku. Održati JEDAN sastanak, doneti odluke, pa krenuti.

### ✅ DONETE ODLUKE (Nenad, 19.07)
- **Grana:** gradnja na `feat/4.0-faza1` (ne main); nav+docs prvo (bezbedno), migracije čekaju dev bazu.
- **B1 goods_documents:** izbaciti iz BigBit sync-a → **naš sistem (3.0/4.0) postaje vlasnik**; jednokratni
  seed BigBit robne istorije pa čista tabela. Mirror ostaje za MRP.
- **B4 Float→Decimal:** aditivno+swap (ne in-place); **zaokruživanje i računica 1:1 kao BigBit** (Round na
  istim tačkama), test na stvarnim fakturama do pare = acceptance.
- **N3 predmeti:** **naš sistem postaje vlasnik `projects`** (isključiti BigBit→projects sync); prelazni
  period **dupli ručni unos (BigBit + 3.0)** je OK — nema sudara jer **BigBit NE čita PG** (veza jednosmerna
  BigBit→PG). Ključno: „vlasnik" = naša app piše, sync za tu tabelu se gasi.
- **Terminologija:** 2.0/3.0/4.0 = faze istog sistema (jedan repo, jedna baza `servosync-pg`); „2.0" u kodu
  je nasleđe. „Vlasnik tabele" = jedini pisac. Infra: [INFRA_REFERENCA_4.0.md](INFRA_REFERENCA_4.0.md).

### ⚠️ 4 BLOKADE iz review-a (dodato 19.07 — [PLAN_REVIEW_4.0_nalazi.md](PLAN_REVIEW_4.0_nalazi.md))
| # | Blokada | Akcija | Owner |
|---|---|---|---|
| **B1** | `goods_documents` je AKTIVNA sync-cache (sync-map:3079/3505), NE „2.0 vlasnički" kako Faza 3/5 tvrde → dual-writer korupcija | odlučiti: izbaciti T_Robna dokumenta iz SYNC_MAP + preneti u 2.0, ILI overlay/dual-key kao items | **Negovan/Nenad** |
| **B2** | GL model-imena nekonzistentna (Account/ChartOfAccount, LedgerEntry/JournalLine) → cutover puni tabele koje GL ne čita | zaključati kanonska imena **Account/LedgerEntry** PRE Faze 2; F2 predviđa sve kolone (dueDate/documentNumber/reconciledAt/entryType) | **mi-tehnicki** |
| **B3** | PS prenos „neto po komitentu" vs F4 „po fakturi" → aging/IOS/plaćanja nemaju podatke | PS migrira **po pojedinačnoj fakturi** (documentNumber+dueDate, reconciledAt=NULL); V2 poredi po dokumentu+aging | **mi-tehnicki + Nesa** |
| **B4** | Deploy okida `prisma migrate deploy` na svaki push → Float→Decimal in-place ALTER lockuje prod | Float→Decimal **aditivna kolona+backfill+swap**, PRE prvog knjiženja (F0/1), prozor+rollback+snapshot | **Nenad + mi-tehnicki** |
| **VISOK** | Nema jedne autoritativne konto mape | Faza 1: **jedna `SaldakontoAccount`** + jedna PDV konto mapa; SVE faze je čitaju; ΣDug=ΣPot na svakom JournalEntry chokepoint-u | **Nesa + mi-tehnicki** |


### Negovan (proizvodni/robni master-podaci)
| # | Pitanje | Blokira fazu | Doc |
|---|---|---|---|
| N1 | **Magacin ID→tip** (gotova roba / poluproizvod / sirovina) — mapiranje nije u kodu | Faza 3 (robno) | 41 §E, 39, ODLUKE |
| N2 | **Robne konvencije:** Level 0=stanje, 250+Rezervisi=rezervacija, `KODJ` izuzeto | Faza 3 (robno/lager) | 39, 15 §4.1 |
| N3 | **projects/Predmeti — 2.0 master (write-back) ili ogledalo?** (§11.1) | Faza 1 + traka B | 22 §4, 41 §E |
| N4 | `BBPravaPristupa` → 2.0 RBAC mapiranje | Faza 0 (RBAC) | BB_T_26 #6 |
| N5 | BigBit `RadniNalozi` (servis/vozila, 2.588) — 4.0 scope ili van | fakturisanje servisa | BB_T_26 #2 |
| N6 | **BB ULS read-kredencijal** na Srv-all (nalog `Slavisa`) za direktan sync | Faza 1 (cutover izvora) | BB_T_26 #9 |

### Nesa / knjigovođa-konsultant (regulatorno)
| # | Pitanje | Blokira |
|---|---|---|
| K1 | **Validacija POPDV/KEPU/GL/bilansi** paralelnim vođenjem (≥1 pun PDV period) | Faze 2/6/7 acceptance |
| K2 | Potvrda **kontnog plana + šema za kontiranje** (DefDug/DefPot izvučene — proveriti) | Faza 1/2 |
| K3 | **OS pozicije u ZR** — knjigovođa daje brojeve (OS se vodi kod njega) | Faza 7 (ZR) |

### Tatjana (referent uvoza)
| T1 | **Landed cost ključ raspodele** zavisnih troškova na artikle (nedokumentovan) | Faza 3 (uvoz kalkulacija) | 14, 39, BB_T_26 #3 |

### Nenad (poslovne/scope odluke)
| # | Pitanje | Blokira |
|---|---|---|
| NE1 | **Cutover timing MSSQL→BigBit direktno** (dual-writer sudar na `items`) | Faza 1 |
| NE2 | **Graditi li `bigbit_raw` staging** za GL/PDV/carina migraciju | Faza 1 |
| NE3 | **Koliko godina istorije** migrirati (otvorene stavke / promet) | Cutover |
| NE4 | **Period paralelnog rada** BigBit + 4.0 (predlog ≥1 PDV period) | Cutover |
| NE5 | POS/fiskalizacija — potvrditi da NE (nije na meniju) | scope |

### Mi (tehnički — ne traži spoljnu odluku, ali uraditi prvo)
- Preduslovne migracije: parcijalni unique `items.external_item_id≠0`, `@@unique` na `price_list_entries`.
- Dump preostalog iz `.mdb`: `NSK_*` tela, sadržaj `Sema za kontiranje` (delom urađeno), spot-provera ID 1:1.

> **Napomena:** ~130 od 145 harvest-pitanja su **produkciona BOM/MRP** (predmeti/3.0 strana) i **već su u
> `ODLUKE.md`** — ne blokiraju 4.0 komercijalu. Gornja lista je 4.0-relevantni presek.

---

## Redosled faza (dijagram zavisnosti)

```
KAPIJA 0 (odluke)
   │
   ├─────────────────────────────────────────────┐
   ▼                                              ▼
FAZA 1: Konsolidacija baze + šifarnici      FAZA 0: Presečna infra
   (doc 41, 32)                                (doc 27,28,29,36)
   │  jedan master + external_id + overlay      │  carry-over, audit+lock+undo,
   │  bigbit_raw staging, kontni plan,          │  UX standard, Resend
   │  šeme za kontiranje, vrste dok/naloga      │  (diže i 3.0)
   └───────────────┬──────────────────────────┬─┘
                   ▼                          │
   ┌── TRAKA A (finansije, sekvencijalno) ──┐ │  TRAKA B (komercijala, paralelno)
   │ FAZA 2: GL jezgro (30,18)              │ │  ┌─ Predmeti/RFQ (22,31)
   │ FAZA 3: Robno/costing+nivelacija (39)  │ │  ├─ Nabavka (24) ← SPRINT kandidat
   │ FAZA 4: Saldakonti+plaćanja (25,21,23) │ │  └─ Profakture/predračun (26)
   │ FAZA 5: Fakturisanje+SEF (40,26,27,07) │ │     (ne zavise od GL — mogu ranije)
   │ FAZA 6: PDV/POPDV/KEPU (18)            │ │
   │ FAZA 7: Završni račun/ZR (37)          │ │
   └────────────────────────────────────────┘ │
                   │                            │
                   ▼                            ▼
              FAZA N: CUTOVER (migracija PS + paralelni rad + gašenje BigBit-a)
```

---

## FAZA 1 — Konsolidacija baze + šifarnici (TEMELJ)
**Scope:** [doc 41](../backend/docs/migration/41-konsolidacija-baze-dedup-polja.md) (data-model) +
[doc 32](../backend/docs/migration/32-razno-u-podesavanja-map.md) (šifarnici).
- Konsolidovan data-model: jedan master po entitetu + `external_*_id` samo za `items`; overlay za lokalna polja.
- `bigbit_raw` staging schema (jednokratni, ako NE2=da) — za GL/PDV/carina migraciju.
- Šifarnici admin UI: **kontni plan** (novi model!), **šeme za kontiranje** (izraz-engine), vrste dokumenata/naloga, poreske stope, magacini, cenovnik, grupe/poreklo.
- Preduslovne migracije (unique indexi), spot-provera ID 1:1.

**Procena:** ~15–20 AI-dana (konsolidacija ~4–6 + uski šifarnici ~11–12 + kontni plan/šeme ~5–8; kontni
plan+šeme su GL-preduslov).
**Otvorena pitanja PRE:** N1, N3, N6, NE1, NE2, K2. **Acceptance:** svi šifarnici imaju admin UI; kontni
plan+šeme uneti i potvrđeni od knjigovođe; nulti duplikat komitenata (dedupe PIB); spot-provera ID prošla.

## FAZA 0 — Presečna infra (paralelno sa Fazom 1, diže i 3.0)
**Scope:** [27](../backend/docs/migration/27-prepisivanje-dokumenata-carry-over.md) (carry-over servis),
[29](../backend/docs/migration/29-audit-zakljucavanje-predlog-4.0.md) (audit+lock+**undo**),
[28](../backend/docs/migration/28-skriveni-ui-desni-klik-stampa-precice.md) (UX standard),
[36](../backend/docs/migration/36-4.0-poboljsanja-preko-accessa.md) (Resend attachments, prevod za carinu).
- `DocumentCarryOverService` (jedan servis umesto ~25 ad-hoc), Prisma extension (field-level audit + CLS
  auto-stamp + soft-delete + **undo obrisane stavke**), lifecycle draft→posted→locked, grid-toolbar +
  štampa-varijante komponenta, Resend `send` sa attachments.

**Procena:** ~15–22 AI-dana. **Otvorena pitanja PRE:** N4 (RBAC). **Acceptance:** carry-over pokriva 4
glavna para; svaki entitet ima audit trag sa old→new; obrisana stavka se vraća; grid akcije na svakoj tabeli.
**Zašto prvo:** radi se JEDNOM pa svaki modul (i 3.0) dobija audit/lock/carry-over/UX „besplatno".

## FAZA 2 — GL jezgro (Glavna knjiga)
**Scope:** [30](../backend/docs/migration/30-glavna-knjiga-modul-dubinski.md), [18](../backend/docs/migration/18-gl-pdv-kontiranje-rekonstrukcija.md).
- `chart_of_accounts` + `journal_entry` + `ledger_entry` (Decimal, dev par, traceback); **`VredIzraza` port**
  (safe parser A–Z, NE eval); posting engine (auto iz dok, balans ΣDug=ΣPot); numeracija + ručni nalozi;
  izveštaji Dnevnik/Bruto bilans/Kartica konta/analitike.
**Procena:** ~18–26 AI-dana. **Preduslov:** Faza 1 + Faza 0. **Otvorena pitanja PRE:** K2. **Acceptance:**
ΣDug=ΣPot uvek; auto-knjiženje IFR→2040/UFROB→4350 tačno vs BigBit; bruto bilans se slaže; knjigovođa GO.

## FAZA 3 — Robno / costing + nivelacija
**Scope:** [39](../backend/docs/migration/39-robno-inventory-kalkulacija.md), [14](../backend/docs/migration/14-bigbit-carina.md).
- Kalkulacija ulaza (kaskada + uvoz ZT raspodela); costing = **ponderisana prosečna + nivelacija/uprosečavanje**
  (odluka Nenad); lager; popis (višak/manjak); **KEPU** (regulatorno); GK kontiranje robnog; RuC kontrole.
**Procena:** ~20–27 AI-dana. **Preduslov:** Faza 2 (kontiranje). **Otvorena pitanja PRE:** N1, N2, T1
(landed cost). **Acceptance:** zaliha↔GK bez drifta (RuC=0); KEPU se slaže sa robnim; nivelacija uprosečuje
cene kao BigBit.

## FAZA 4 — Saldakonti + plaćanja
**Scope:** [25](../backend/docs/migration/25-priprema-placanja-virmani-tok.md), [21](../backend/docs/migration/21-banking-izvodi-nalozi-rekonstrukcija.md), [23 §1.1–1.3](../backend/docs/migration/23-backlog-nedokumentovane-cacke.md).
- Otvorene stavke/IOS (kupci 2040 / dobavljači 4350), kompenzacija, aging; izvodi (TXT parser, auto-knjiženje);
  **priprema plaćanja** (dospelost `Valuta≤danas`, check-off, dedup) → nalozi za plaćanje (FX/Intesa export, već radi).
**Procena:** ~15–22 AI-dana. **Preduslov:** Faza 2 (GL — otvorene stavke iz GK). **Acceptance:** IOS se slaže
sa saldom; izvod se auto-knjiži; priprema plaćanja daje ispravne dospele obaveze; export prihvata banka.

## FAZA 5 — Fakturisanje + SEF
**Scope:** [40](../backend/docs/migration/40-fakturisanje-konsolidacija.md), [26](../backend/docs/migration/26-profakture-tok-iz-koda.md), [27](../backend/docs/migration/27-prepisivanje-dokumenata-carry-over.md), [07](../backend/docs/migration/07-bigbit-sef-efaktura.md).
- Predračun (Level 250) → izlazni račun **domaći (IFR/IFGP/IFUSL) + izvoz (IZVRO/IZVGP/IZVUS)** preko carry-over;
  reversi=`REV`; SEF (UBL, throttle 3/s, kategorije S20/Z, avans→0, pojedinačna evidencija); štampa varijante;
  auto-mail (Resend).
**Procena:** ~15–22 AI-dana. **Preduslov:** Faza 2, 3, Faza 0 (carry-over). **Otvorena pitanja PRE:** N5
(servis RN). **Acceptance:** račun se pravi iz predračuna; SEF demo prolazi; izvoz na 2050 bez PDV; PDF na mail.

## FAZA 6 — PDV / POPDV / KEPU
**Scope:** [18](../backend/docs/migration/18-gl-pdv-kontiranje-rekonstrukcija.md) (§3, POPDV_DEF izvučen).
- PDV knjige (KIF/KUF), POPDV (deklarativni `POPDV_DEF` engine), PPPDV, **mesečni ciklus** (doc 35: brisanje+
  reknjiženje, RuC kontrole, slaganje SEF↔BB, 47−27−2790).
**Procena:** ~5–8 AI-dana (+ mesečni ciklus workflow). **Preduslov:** Faza 2, 5. **Acceptance:** POPDV obrazac
se puni tačno; knjigovođa validira paralelno ≥1 period (K1); PDV prijava = BigBit do dinara.

## FAZA 7 — Završni račun (ZR)
**Scope:** [37](../backend/docs/migration/37-zavrsni-racun-os-bilansi.md) (OS van scope-a — knjigovođa).
- GKEval port (pravi parser), bruto stanje + PS separacija, BS/BU/SI, **APR eFI XML** (u hiljadama, AOP po
  veličini firme); OS-pozicije = ručni unos iz knjigovođinih brojeva.
**Procena:** ~11–16 AI-dana. **Preduslov:** Faza 2, 6. **Otvorena pitanja PRE:** K3 (OS brojevi). **Acceptance:**
BS aktiva=pasiva; APR XML validan; knjigovođa GO.

---

## TRAKA B — Komercijala (paralelno, NE zavisi od GL)
Može krenuti **odmah posle Faze 1**, dok Traka A gradi finansije. **Nabavka je najbolji „sprint" kandidat**
(auto-mail RFQ + status-tok kompletni u kodu, ne zavise od GL).
- **Predmeti/RFQ** ([22](../backend/docs/migration/22-predmeti-domen-rekonstrukcija.md), [31](../backend/docs/migration/31-predmet-kicma-rfq-lanac.md)) — ~9–12 dana. Pitanje: N3 (master).
- **Nabavka** ([24](../backend/docs/migration/24-nabavka-tok-iz-koda.md)) — MVP ~16–23 dana; auto-mail RFQ preko Resend.
- **Profakture/predračun** ([26](../backend/docs/migration/26-profakture-tok-iz-koda.md)) — ~14 dana (deli carry-over).

---

## FAZA N — Cutover
- Migracija PS/otvorenih stavki (2040/2050/4350/4360/avansi/predmeti — doc 12 §1), koliko godina (NE3).
- `bigbit_raw` jednokratni uvoz GL/PDV istorije (ako NE2=da).
- **Paralelni rad ≥1 pun PDV period** (NE4) — knjigovođa poredi 4.0 vs BigBit do dinara.
- Gašenje MSSQL sync-a → direktan BigBit izvor / potpuni prelaz; gašenje BigBit-a.
**Acceptance:** pun mesečni ciklus (fakturisanje→GL→PDV→plaćanja→ZR) u 4.0 = BigBit, potvrđeno od knjigovođe.

---

## Ukupno i kalendar
Faze se preklapaju (dele carry-over/GL/audit), pa se procene ne sabiraju linearno. Grubo: **Traka A ~85–120
AI-dana**, **Traka B ~40–50 AI-dana** (paralelno), **presečna infra ~15–22**. Uz validaciju kao gejt i
latencu odluka → **kalendarski 4–7 meseci** (procena Scenario B). **Najveći rizik nije kod nego validacija**
(knjigovođa) i **latenca odluka** (Kapija 0). Zato: **Kapija 0 prva, presečna infra i Faza 1 paralelno, pa
GL kao temelj, a komercijala (Traka B) teče nezavisno kao rani rezultat.**

# FAZA N — Cutover (migracija + paralelni rad + gašenje BigBit-a)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Verifikovano nad kodom.
> Poslednja faza — sve prethodne su preduslov. **Ništa nije primenjeno.**

## Migracija + PS — jednokratni servis `src/modules/migration/` (CLI, ne REST)

### (0) Staging `bigbit_raw`
Nova PG schema u prod bazi (Prisma je ne modeluje). `mdb-export` 1:1 iz `BB_T_26.mdb` (godina preseka) + istorijske
`.mdb` po odluci → `bigbit_raw.t_nalozi/t_glavna_knjiga/kontni_plan/r_tarife/komitenti/…`. **Nijedan FK iz `public` ne
gleda u nju.** Skripta `tools/migration/stage-bigbit.sh` (idempotentno: DROP+CREATE). Posle verifikacije → `DROP SCHEMA
bigbit_raw CASCADE`.

### (1) Matični (upserteri iz Faze 1, izvor bigbit_raw, klon `customer.syncer.ts`)
Redosled: Komitenti (id=Sifra, **dedup PIB**, pre-flight report duplih) → Magacini → Predmeti (**spot-provera
BrojPredmeta**) → Artikli (**UPDATE-only** external_item_id dok MSSQL živi; INSERT tek na cutover) → Cenovnik (remap
item_id preko external_item_id; nespojeni skip+log). **Preduslovne migracije** (parcijalni unique, @@unique) PRE run-a.

### (2) Finansijska istorija → 4.0 GL (vlasnički modeli, ne cache)
Dodati **`ChartOfAccount`** (account, name, class, isAnalytical — 1389 iz kontni_plan), **`JournalEntry`**+
**`JournalLine`** (Decimal; customerId=Analiticka sifra, `isOpenItem`=Povezan, projectId, docNumber). Per-godina INSERT
iz bigbit_raw.t_nalozi+t_glavna_knjiga. **Koliko godina = odluka Nenad** (preporuka: **pun GL tekuća+prethodna; starije
samo agregirani PS bez linija**).

### (3) PS nalog na dan preseka
Jedan `JournalEntry entryType='PS'` iz salda BigBit bruto-bilansa: bilansna konta 0–4 → PS linija; **saldakonti NE
zbirno nego PO OTVORENIM STAVKAMA** (2040/2050/4350/4360/4630 + avansi 4300/4302/1500/1520/1521/1530 — jedna linija PO
KOMITENTU sa neto otvorenim saldom, `isOpenItem=true`); klase 5/6/7 = NULA. Kontrola: **Σ debit = Σ credit**.

### (4) Verifikacija (exit 0 obavezan, `tools/migration/migration-verify.mjs`)
- **V1 Bruto bilans:** saldo(4.0) == saldo(bigbit_raw) po kontu, tolerancija 0,00.
- **V2 Otvorene stavke po komitentu** == BigBit `Otvorene stavke`.
- **V3 PS ravnoteža** Σ debit=Σ credit. **V4 Matični paritet** (count + dupli PIB=0).
Odstupanja se rešavaju PRE cutover-a.

## Runbook — paralelni rad + gašenje

### Paralelni rad (validacioni gejt)
**≥1 pun PDV period** 4.0 i BigBit uporedo; **knjigovođa poredi PDV prijavu / bilans / saldakonti do dinara**
(acceptance). Feature flags po modulu (fakturisanje/GL/PDV) za postepen prelaz.

### Redosled gašenja
1. **MSSQL sync** (SyncService/sync-map) se gasi → **bigbit-bridge preuzima INSERT** za matične (dual-writer rešenje
   iz Faze 1). 2. Kad je paralelni period čist → **gašenje BigBit-a**. 3. `DROP SCHEMA bigbit_raw`.

### Rollback
Ako 4.0 ne valja u periodu → **vrati se na BigBit bez gubitka** (zato paralelni rad — BigBit ostaje živ dok se ne
potvrdi). Nema tačke bez povratka do go-live potvrde.

### Checklist pre cutover-a
**Sve Kapija-0 odluke zatvorene** (N1–N6, K1–K3, T1, NE1–NE5); verifikacija V1–V4 exit 0; knjigovođa GO na paralelnom
periodu; feature flags spremni.

## Odluke
- ⏳ **Koliko godina istorije + dan preseka** — Nenad (NE3; preporuka: pun GL 2 godine, starije PS agregat; presek = kraj meseca).
- ⏳ **Kada se gasi BigBit / ko potvrđuje go-live** — Nenad + Nesa (posle čistog PDV perioda).
- ✅ **bigbit_raw jednokratni, briše se** — mi-tehnicki.
- ✅ **Saldakonti PS po otvorenim stavkama** (ne zbirno) — mi-tehnicki (potvrditi Nesa).

## Rizici
- **Otvorene stavke se ne slažu** → V2 mora exit 0 pre cutover-a; razlika = pogrešno uparivanje ili nezatvorena stavka.
- **Dual-writer na items tokom prelaza** → parcijalni unique + UPDATE-only (Faza 1).
- **Go-live bez paralelnog perioda** → zabranjeno; rollback zavisi od živog BigBit-a.

**Procena Faze N:** ~8–14 AI-dana (migracija+verifikacija) + kalendarski ≥1 PDV period paralelnog rada.

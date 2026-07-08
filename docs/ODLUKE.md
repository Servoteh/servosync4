# Registar odluka — ServoSync

> Donete odluke (ko/kada), da se §11 „otvorena pitanja" postepeno zatvaraju. Odluka postaje pravilo
> tek kad je ovde + primenjena u relevantnom docu ([BACKEND_RULES §11](BACKEND_RULES.md) / [RBAC_RLS_PREDLOG](design/RBAC_RLS_PREDLOG.md)).

## Sesija 2026-07-08 (Nenad)

| # | Pitanje | ODLUKA | Napomena / gde primenjeno |
|---|---|---|---|
| 1 | BigBit izvor posle gašenja QBigTehn-a | **Export (XML/CSV)** iz BigBit-a → ServoSync uvozi | Ne SQL Server. [BACKEND_RULES §11.2a](BACKEND_RULES.md), [MODULE_SPEC_bigbit_sync](design/MODULE_SPEC_bigbit_sync.md) |
| 2 | BigBit sync semantika (update/delete) | **Insert-only (kao legacy)** — samo novi redovi | Ne UPSERT. Napomena: promene adrese/PIB-a iz BigBit-a se NE propagiraju (svesno). §11.2b |
| 3 | PDM sync mehanizam | **Direktan SQL** (čitanje PDM MS SQL-a) | Podrazumeva da „PDM MS SQL" NIJE sirov SolidWorks nego Servoteh-ov međusloj — **potvrditi izvor** pre implementacije. §11.3 |
| 4 | Cache/overlay | **Potvrđeno** — BigBit matične = read-only cache; proizvodne = ServoSync vlasništvo | §11.1 zatvoreno |
| 5 | Timestamp politika | **ODLOŽENO** — Luka/Nesa odlučuju (tehnička sitnica) | Preporuka: `Timestamptz` za nove tabele. §11.4 ostaje otvoreno |
| 6 | Obim role ŠEF | **Pun rad + odobravanje** (RN/primopredaje/lokacije) + pregled ostalog | Jedan ŠEF (ne per-modul). [RBAC §7.1] |
| 7 | Ko potpisuje/završava TP | **Tehnolog (autor) + ŠEF + CNC programer** | CNC programer SME da potpiše/završi TP. [RBAC §7.2] |
| 8 | Tabela `cnc_programs` | **DA — uvodi se** (zasebna app-owned tabela) | CNC programer vlasnik write-a. [RBAC §7.3], [MODULE_SPEC_tehnologija] |
| 9 | MENADZMENT prava | **Uvid + write** (paritet sa 1.0) | Ne samo read. [RBAC §7.5] |
| 10 | PostgreSQL RLS | **Ne sada — samo NestJS guardovi + query-scoping** | Pravi PG RLS tek u 3.0 ako zatreba. [RBAC §7.4] |

## Zadaci koje je Nenad tražio (u toku)

- **Role/imenovanje (§6 RBAC):** iz sistematizacije — Miljan Nikodijević = *Rukovodilac proizvodnih operacija i
  tehnologije*; Nikola Ninković = *Šef mašinske obrade*; Milorad Jerotić = *Gl. mašinski inž. + Rukovodilac
  inženjeringa; finalni potpisnik*. **Predlog mapiranja** u [RBAC_RLS_PREDLOG §2/§6](design/RBAC_RLS_PREDLOG.md).
  U 1.0 su svi „menadzment" — može tako i da ostane u V1, pa se granulira u V2.
- **BOM/MRP logika (§11.3 dubinski):** ✅ **URAĐENO 2026-07-08** — 5-agent analiza ukrstila SQL tela sa VBA
  pozivima → [migration/15](migration/15-bom-mrp-odluka-bez-negovana.md). **13 od ~40 „POTVRDITI" tačaka
  razrešeno iz koda** (odlučujemo sami); ostaje samo 5 za Negovana (vidi ispod).

## Ostaje za sastanak / kasnije (SKRAĆENO)

**Za Nesu/Luku (tehnički):**
- Timestamp politika (`Timestamptz` preporuka) · potvrda da je PDM izvor međusloj (ne sirov SolidWorks).

**Za Negovana (poslovna/podatkovna semantika — 5 tačaka, [15 §6](migration/15-bom-mrp-odluka-bez-negovana.md)):**
1. Magacin `IDMagacin`/`VrstaMag` → tip (gotova roba / poluproizvod / sirovina).
2. Ciklus u sastavnici = **tvrda greška unosa** (preporuka) ili samo prekid eksplozije?
3. 23h auto-close — vrednost `komada` + KPI flag (nema u kodu, nov zahtev).
4. Šta je **predmet 4521** (i da li je 0 sentinel) → migrira se u flag `excludeFromReworkScrap`.
5. BB robne konvencije (`Level 0/250`, `Vrsta='KODJ'`) + domen `Revizija` (slovna / numerička ≥10).

**Ostalo (nije BOM/MRP):** TP vreme/„utrošeno", primopredaja status-matrica, lokacije — „POTVRDITI" tačke iz
[05 §4/§5/§6](migration/05-qbigtehn-sqlserver-logic.md) · 8 AMBIGUOUS granica scope-a iz [02](migration/02-qbigtehn-scope-triage.md).

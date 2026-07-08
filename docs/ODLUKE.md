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
- **BOM/MRP logika (§11.3 dubinski):** Nenad traži **detaljnu analizu iz izvučenog koda** (SP/UDF) da se
  odluči **bez Negovana**. Rezultat: [migration/05](migration/05-qbigtehn-sqlserver-logic.md) + nova analiza.

## Ostaje za sastanak / kasnije
- Timestamp politika (Luka/Nesa) · potvrda da je PDM izvor međusloj (ne sirov SolidWorks) · BOM/MRP odluka
  posle analize · ~40 „POTVRDITI" tačaka iz [migration/05](migration/05-qbigtehn-sqlserver-logic.md) · 8 AMBIGUOUS granica scope-a.

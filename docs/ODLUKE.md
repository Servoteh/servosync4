# Registar odluka — ServoSync

> Donete odluke (ko/kada), da se §11 „otvorena pitanja" postepeno zatvaraju. Odluka postaje pravilo
> tek kad je ovde + primenjena u relevantnom docu ([BACKEND_RULES §11](BACKEND_RULES.md) / [RBAC_RLS_PREDLOG](design/RBAC_RLS_PREDLOG.md)).

## Sesija 2026-07-08 (Nenad)

| # | Pitanje | ODLUKA | Napomena / gde primenjeno |
|---|---|---|---|
| 1 | BigBit izvor posle gašenja QBigTehn-a | **Export (XML/CSV)** iz BigBit-a → ServoSync uvozi | Ne SQL Server. [BACKEND_RULES §11.2a](BACKEND_RULES.md), [MODULE_SPEC_bigbit_sync](design/MODULE_SPEC_bigbit_sync.md) |
| 2 | BigBit sync semantika (update/delete) | **Insert-only (kao legacy)** — samo novi redovi | Ne UPSERT. Napomena: promene adrese/PIB-a iz BigBit-a se NE propagiraju (svesno). §11.2b |
| 3 | PDM sync mehanizam | **Direktan SQL** (čitanje PDM MS SQL-a) | ✅ Potvrđeno 8.7 (#12): „PDM MS SQL" = Servoteh-ov međusloj (SQL baza kojom mi upravljamo), ne sirov SolidWorks. §11.3 |
| 4 | Cache/overlay | **Potvrđeno** — BigBit matične = read-only cache; proizvodne = ServoSync vlasništvo | §11.1 zatvoreno |
| 5 | Timestamp politika | **ODLOŽENO** — Luka/Nesa odlučuju (tehnička sitnica) | Preporuka: `Timestamptz` za nove tabele. §11.4 ostaje otvoreno |
| 6 | Obim role ŠEF | **Pun rad + odobravanje** (RN/primopredaje/lokacije) + pregled ostalog | Jedan ŠEF (ne per-modul). [RBAC §7.1] |
| 7 | Ko potpisuje/završava TP | **Tehnolog (autor) + ŠEF + CNC programer** | CNC programer SME da potpiše/završi TP. [RBAC §7.2] |
| 8 | Tabela `cnc_programs` | **DA — uvodi se** (zasebna app-owned tabela) | CNC programer vlasnik write-a. [RBAC §7.3], [MODULE_SPEC_tehnologija] |
| 9 | MENADZMENT prava | **Uvid + write** (paritet sa 1.0) | Ne samo read. [RBAC §7.5] |
| 10 | PostgreSQL RLS | **Ne sada — samo NestJS guardovi + query-scoping** | Pravi PG RLS tek u 3.0 ako zatreba. [RBAC §7.4] |
| 11 | Konvencija imena rola | **lowercase snake_case** (`admin`/`sef`/`cnc_programer`) u oba repoa | Prevaziđeno UPPERCASE; paritet sa 1.0 prod. [BACKEND_RULES §2.2], [AUTHZ_UNIFIED](design/AUTHZ_UNIFIED.md) |
| 12 | Nativni PG RLS pravac | **„RLS-ready sada, nativni RLS u 3.0"** | Temelji (GUC `app.user_id`, `user_roles`, `worker_id`/`created_by_id` FK, predikat-funkcije) da 3.0 bude flip-a-switch. Skelet: [sql/authz_rls_ready.skeleton.sql](design/sql/authz_rls_ready.skeleton.sql) |
| 13 | Katalog rola — objedinjavanje | **Jedan katalog za 1.0+2.0+3.0** ([AUTHZ_UNIFIED](design/AUTHZ_UNIFIED.md), `roles.ts`) | `tim_lider`≠`sef`; `proizvodni_radnik`=`radnik`; `cnc_operater`≠`cnc_programer`; dodati `monter`/`tim_lider`/`proizvodni_radnik` |

## Sesija 2026-07-08 (nastavak) — potvrde Negovan Vasić („Vasa" = ista osoba)

| # | Pitanje | ODLUKA / POTVRDA | Primenjeno |
|---|---|---|---|
| 11 | BigBit export — format i obim | **XML**, i to **CEO katalog artikala** (ne samo korišćeni) | zatvara „potvrditi kod Vase" iz §11.2a; red #1 |
| 12 | PDM izvor | ✅ **Servoteh-ov međusloj — SQL baza kojom MI upravljamo**, NE sirov SolidWorks → **direktan SQL je siguran** | zatvara §11.3 caveat; red #3 |
| 13 | Prazne tabele iz sync-a (`tax_rates`/`warehouses`/`price_list_entries`/`goods_documents`…) | ✅ **Očekivano — prazne u samom izvoru.** Vasa je za QBigTehn koristio prilagođenu „BigBit-na-SQL" verziju, maskom sakrio forme koje ne treba da vidimo i adaptirao je na ono što nam treba → te tabele su **nepotrebne** (NIJE propuštena `EXT_` veza) | zatvara proveru A.3 |
| 14 | Ko validira/završava TP | Uz Tehnolog(autor)+ŠEF+CNC: **KONTROLOR finalnom kontrolom validira da je TP završen** — i ako sve operacije nisu otkucane („ako on kaže da je dobro, dobro je"); **isto mogu svi iz `MENADZMENT`**. **Obavezan audit: ime+prezime + kada.** | RBAC §7.2 prošireno, §3.1 |
| 15 | Nikola Ninković | **`MENADZMENT`** — šef CELE mašinske obrade; nema poseban scope (nije sporno) | RBAC §2.1 ispravljeno |
| 16 | BOM/MRP/RN **logika izračuna** | **Nema gotove legacy procedure** — u fazi razrade u Tehnologiji, **ne koristi se trenutno**; **ServoSync 2.0 je DIZAJNIRA** (Nenad+Luka), ne reverse-eng. Anti-ciklus guard obavezan kad se gradi. **Ne blokira** (nije u upotrebi) | reframe §11.4; migration/15 tačke se gledaju kroz ovu prizmu |

> Napomena: „Negovan" i „Vasa" u svim dokumentima = **Negovan Vasić, jedna osoba** (server `vasa-SQL` nazvan po njemu).

## Sesija 2026-07-09 (Nenad) — Kontrola/Kucanje + gap analiza + skop

| # | Pitanje | ODLUKA | Primenjeno |
|---|---|---|---|
| 17 | Nalepnica barkod | **RNZ** (`RNZ:projectId:identNumber:variant:revision`) — kiosk/telefon dekodabilan | [MODULE_SPEC_kontrola §6/§10], [MODULE_SPEC_stampa §3.1] |
| 18 | Mobilni UNOS sa telefona | **Faza 2** (priprema od P1: čist REST/JWT + telefon-čitljiv RNZ); ne gradi se u pilotu | [MODULE_SPEC_kontrola §8] |
| 19 | Gap QBigTehn→2.0 | **Gradimo sve što je bilo (i bolje)** — propust je iz nepotpunih uputstava, ne namere | [migration/16], backlog Tier A–D |
| 20 | Redosled gradnje | **Tier A prvo** (proizvodni core: TP authoring, RN izmena/stavke/brisanje, ispravke kucanja) | [migration/16 §4] |
| 21 | Start/stop evidencija vremena rada | **DA — dva skena** (start+stop po operaciji → stvarno utrošeno vreme); veći zahvat u kucanje model | Tier A-4; preduslov za vreme-analitike |
| 22 | MRP/nabavka obim | **Za sad read-only** (write/planning stack odložen) | [migration/16 §4 Tier D], §11.3 |
| 23 | Matični podaci (komitenti/predmeti/materijali) | **Read-only iz BigBit-a** — uređuju se u BigBit-u; 2.0 samo prikazuje (bez ekrana za izmenu) | [migration/16 §3.7] |

> Kontrola/Kucanje P1 (kiosk create-on-scan + nalepnica) je **na produkciji i verifikovan** (2026-07-09).

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
- Timestamp politika (`Timestamptz` preporuka). ~~potvrda PDM izvora~~ ✅ potvrđeno 8.7 (Servoteh međusloj).
- **BOM/MRP/RN logika izračuna = 2.0 dizajnira** (odluka #16) — nije reverse-eng iz legacy-ja; deo „5 tačaka za Negovana" ispod time postaje NAŠA odluka, a ne pitanje za Vasu.

**Za Negovana (poslovna/podatkovna semantika — 5 tačaka, [15 §6](migration/15-bom-mrp-odluka-bez-negovana.md)):**
1. Magacin `IDMagacin`/`VrstaMag` → tip (gotova roba / poluproizvod / sirovina).
2. Ciklus u sastavnici = **tvrda greška unosa** (preporuka) ili samo prekid eksplozije?
3. 23h auto-close — vrednost `komada` + KPI flag (nema u kodu, nov zahtev).
4. Šta je **predmet 4521** (i da li je 0 sentinel) → migrira se u flag `excludeFromReworkScrap`.
5. BB robne konvencije (`Level 0/250`, `Vrsta='KODJ'`) + domen `Revizija` (slovna / numerička ≥10).

**Ostalo (nije BOM/MRP):** TP vreme/„utrošeno", primopredaja status-matrica, lokacije — „POTVRDITI" tačke iz
[05 §4/§5/§6](migration/05-qbigtehn-sqlserver-logic.md) · 8 AMBIGUOUS granica scope-a iz [02](migration/02-qbigtehn-scope-triage.md).

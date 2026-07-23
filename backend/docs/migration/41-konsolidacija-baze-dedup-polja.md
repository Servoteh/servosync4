# Konsolidacija TRI sveta podataka — dedup polja za 4.0 (TEMELJ)

> **Status:** ANALIZA (2026-07-19). Najvažnije arhitektonsko pitanje (Nenad): spojiti baze bez
> dupliranja polja. Tri sveta: **2.0 Prisma šema** + **BigBit→PG** + **sy15/1.0**. Ovo je temelj celog
> 4.0 data-modela — mora se rešiti PRE bilo kog finansijskog modula.

## A) ⚠️ ISPRAVKA ZABLUDE: „ceo Access u PG" NIJE perzistentan

Nenad kaže „exportovali smo celu bazu Accessa u PostgreSQL". **Provereno — to NIJE tačno kao trajno stanje:**
- **Nema `bigbit_raw` schema ni raw dump-a 207 tabela.** 2.0 baza je **jedno-šemska** (`public`), bez
  multiSchema; grep migracija za `CREATE SCHEMA|bigbit_raw|raw_` = **0**. Jedine `bb_*` tabele su
  sync-metapodaci (`bb_sync_log`, `bb_sync_state`), ne podaci.
- **Šta se stvarno desilo:** jednokratni **analitički snapshot** `BB_T_26_11-07-26.mdb` (207 tabela, 358 MB)
  pročitan `mdb-tools`-om na ubuntusrv → izvučena **samo šema + brojevi redova** (`BB_T_26_schema.sql`,
  3171 linija); **serverska kopija PODATAKA je OBRISANA** (bez PII/finansija).
- **Šta trajno živi u PG:** `bigbit-bridge` (`mdb-tools` UPSERT) — **trenutno samo 4 tabele aktivne**
  (`R_Grupa/Podgrupa/Poreklo→item_*`, `Magacini→warehouses`). **Faza 2** (Komitenti/Predmeti/R_Artikli/
  Cenovnik) je **napisana ali DEAKTIVIRANA** do cutover-a (te 4 danas drži živi MSSQL sync).
- **Izvor danas:** 2.0 NE čita BigBit direktno — matične sinkuje iz **QBigTehn MSSQL kopije** (`vasa-SQL`)
  „na dugme". `bigbit-bridge` je novi, paralelan put (direktno iz `.mdb`) za rupu šifarnika + Fazu 2.

→ **Posledica za plan:** „ceo Access u PG" treba tek **napraviti** kao svesnu odluku (jednokratni
migracioni staging, NE aplikativni sloj — vidi §D). Trenutno postoji samo analiza + uzan most.

## B) Mapa dupliranja (glavni deliverable)

| Entitet | 2.0 (`schema.prisma`) | BigBit (`BB_T_26`) | sy15 / 1.0 | Master | Duplira? |
|---|---|---|---|---|---|
| **Komitenti** | `Customer` (`id`=Sifra, `taxId`=PIB) | `Komitenti` (6.669) | `bigtehn_customers_cache` (6.244) | **BigBit** | **3× keš** |
| **Artikli** | `Item` (92.357; `id`=QBigTehn, `externalItemId`=BB) | `R_Artikli` (91.199) | 0 (1.0 ne kešira) | **BigBit + QBigTehn** | **dual-key** (C1) |
| **Predmeti** | `Project` (7.602; `id`=IDPredmet) | `Predmeti` (7.736) | `projects`=**1.0 interni (23), drugi pojam** | **BigBit** | **3× + homonim** (C3) |
| **Magacini** | `Warehouse` | `Magacini` (3) | — | BigBit (bridge aktivan) | ne |
| **Cenovnik** | `PriceListEntry` (0, bez biz-key unique) | `Cenovnik` (82.855) | — | BigBit | treba remap item_id |
| **Vrste dok.** | `DocumentType` (posting template) | `R_Vrste dokumenata` | — | BigBit | ne |
| **Kontni plan** | **NE POSTOJI** (samo string kod-polja: `customer_account` 2040, `supplier_account` 4350 na companies) | `Kontni plan`+`Sema za kontiranje` | — | BigBit | **RUPA — gap GL** |
| **Robna dok.** | `GoodsDocument`+`_mirror` (SVE 0 redova) | `T_Robna dokumenta`+stavke | delimično `part_movements_cache` | BigBit | prazno u 2.0 |
| **Prodavci** | `Salesperson` (79; `password` plain!) | `Prodavci` (80, `[Password]` plain — NIKAD kopirati) | — | BigBit | ne |

**Dominantni obrazac:** **BigBit = master; isto polje se materijalizuje 2× (2.0 cache) ili 3× (2.0 +
1.0 `bigtehn_*_cache`).** sy15 nikad nije master matičnih — samo ravan keš (23 `bigtehn_*` tabele, ~328k)
+ referiše po ID-u (`RevTool.bigtehnSifraArtikla`…). Novo: 2.0 sad **puni** 1.0 keš za tehnologiju
(commit 4828f8a) — 2.0 postaje uzvodni za tehnološke podatke.

## C) Ključni sudari

- **C1 — `items.id` (REŠENO opcija A):** `id`=QBigTehn lokalna šifra; BigBit šifra samo u `external_item_id`.
  Migracija ključa **neizvodljiva** — **57.998 BigBit šifri = lokalni `id` DRUGOG artikla** (preklapanje
  opsega). Proizvodni lanac ne referiše `items.id` (veže se stringovima/preko projects/customers) → čistiji
  ključ ne kupuje ništa. **Blast opcije A = 0 redova.** Preduslov: parcijalni unique na `external_item_id≠0`.
- **C2 — Komitent po PIB-u:** `customers.id` je VEĆ u BigBit prostoru (`tRN.BBIDKomitent` 36.753/36.753) →
  Faza 2 radi `id=Sifra` bez remapa. **PIB = prirodni ključ za dedupe.** Ostaje Negovanova spot-provera.
- **C3 — Predmet TROSTRUKI homonim:** (a) `T_Predmeti` pisarnica, (b) `Predmeti` poslovni → 2.0 `projects`,
  (c) 1.0 `projects` = interni projekti (23, drugi pojam). `IDPredmet` = FK u ~25+ tabela (~145.700 redova)
  → spot-provera OBAVEZNA pre Faza-2 run-a.
- **C4 — Izvor sync-a se MENJA:** danas BigBit→QMegaTeh→MSSQL kopija→„na dugme"→PG; cilj 4.0 = **direktan
  BigBit izvor** → **šema-drift front-and-center** (širine kolona truncation, NOT NULL→NULL relaksacija).
  **Dual-writer sudar:** dok MSSQL radi, `bigbit-bridge` nad `items` sme SAMO UPDATE (INSERT bi se sudario
  sa QBigTehn IDENTITY). Validacija šeme na živom izvoru = preduslov.

## D) Predlog konsolidacione arhitekture

**Preporuka: (i) jedan master + `external_*_id` gde se prostori razilaze + (iii) overlay; BEZ perzistentnog
(ii) kao aplikativnog sloja.**

- **(i) Jedan master model po entitetu.** `items` zadržati (opcija A). `customers`/`projects`/`warehouses`:
  **NEMA potrebe za `external_*_id`** — `id` je već BigBit prostor (1:1), ne uvoditi suvišnu kolonu.
  `price_list_entries`: dodati `@@unique(item_id, doc_type)` + dvostepeni remap preko `external_item_id`.
  Posle cutover-a QBigTehn ID prostor postaje trajni 2.0 prostor; BigBit ključ živi u `external_*_id`.
- **(ii) `bigbit_raw` staging — SAMO jednokratni migracioni alat, NIKAD aplikativno.** Danas ne postoji;
  ako zatreba za završni uvoz GL/PDV/carina (gde 2.0 nema modele) → odvojen PG schema `bigbit_raw`,
  `mdb-export` 1:1, nijedan FK ne gleda u njega, aplikacija ga ne čita, briše se posle migracije.
  **Razdvaja „staging za migraciju" od „cache za rad".**
- **(iii) Overlay (§11.1, odlučeno):** matične cache tabele read-only; lokalno polje → overlay tabela
  (`customers_overlay`), ne kolona. Delete = nikad hard.

**Migracioni put (jedan pisac po tabeli):** Komitenti (id=Sifra, dedupe PIB) → Magacini → Predmeti
(spot-provera BrojPredmeta) → R_Artikli (UPDATE-only preko external_item_id, INSERT tek na cutover) →
Cenovnik (remap). **GL/kontni plan/PDV/banking/carina = novi 4.0 vlasnički modeli** (ne cache); BigBit
`Kontni plan`/`Sema za kontiranje` = izvor posting-rule podataka (jednokratno preko staging-a).

## E) Otvorena pitanja (PRE gradnje data modela)

**Blokirajuće:**
1. **`projects`/Predmeti — 2.0 master (write-back) ili ogledalo?** (§11.1) — blokira predmet write-path + RFQ.
2. **Cutover timing MSSQL→BigBit direktno** — dual-writer sudar na `items` INSERT; kada MSSQL gasimo?
3. **Izvor Faze 2** (WinServer ACE OLEDB vs ubuntusrv mdb-tools) + BigBit ULS read-kredencijal (odluka #9).
4. **Graditi li `bigbit_raw` staging** za GL/PDV/carina migraciju.

**Sadržinske:** 5. Landed-cost ključ raspodele (Tatjana, #3). 6. `BBPravaPristupa`→RBAC (#6). 7. BigBit
`RadniNalozi` servis scope (#2). + rekonsilijacija 1.0↔2.0 imena (`projects`, `departments`, `audit_log`).

**Tehnički preduslovi (migracije PRE prvog BigBit upisa):** (a) parcijalni unique `items.external_item_id≠0`;
(b) `@@unique` na `price_list_entries`; (c) živa spot-provera 1:1 ID za Komitente(PIB)/Predmete/Magacine.

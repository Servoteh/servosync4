# FAZA 1 — Konsolidacija baze + šifarnici (implementacioni dizajn, build-ready)

> **Datum:** 2026-07-19. Deo [PLAN_GRADNJE_4.0_FAZNI.md](PLAN_GRADNJE_4.0_FAZNI.md). Verifikovano nad
> STVARNIM kodom (workflow, 3 agenta + kritičar). **Ništa nije primenjeno.** Temelj — sve finansije zavise.

## A — Konsolidacija data-modela (bez dupliranja polja)

### Stanje (verifikovano)
- `schema.prisma` **jedno-šemski** (nema multiSchema, `bigbit_raw` ne postoji). `Item.externalItemId`
  (`@default(0)`, **bez unique**); `PriceListEntry` (itemId + documentTypeId, **bez @@unique**, 0 redova);
  `Customer.taxId` NOT NULL **bez unique**; `Project/Warehouse.id` = BigBit prostor 1:1 (nema external kolone);
  `Salesperson.password` plain — **nikad ne kopirati**.
- **Aktivni pisac danas = MSSQL „na dugme" sync** (`sync-map.generated.ts`, 33 tabele: items id←Sifra,
  externalItemId←BBSifra; customers id←Sifra, taxId←PIB; projects id←IDPredmet…).
- **bigbit-bridge**: aktivne samo grupe/poreklo/magacini; Komitenti/Predmeti/Artikli/Cenovnik **zakomentarisane**.
  `sql/items.sql` je **već UPDATE-only** (`external_item_id = sifra AND ≠0`, INSERT=0, nespojeni=missing) —
  **ali se oslanja na unique koji NE postoji** → rizik overwrite-a bez guard-a. `price_list_entries.sql` nije napisan.

### Dizajn — 4 odvojena mehanizma
1. **Preduslovne migracije (guard-ovi PRE prvog BigBit upisa):**
   - (a) **Parcijalni unique** (ručni SQL): `CREATE UNIQUE INDEX uq_items_external_item_id ON items(external_item_id)
     WHERE external_item_id<>0;` — prethodi dedupe-provera (migracija pada ako ima duplikata). Čini UPDATE-only
     deterministički jedan-red.
   - (b) **@@unique price_list_entries** `([itemId, documentTypeId])` — Prisma izrazivo, prazna tabela → bez rizika.
     Biz-ključ za Cenovnik remap.
   - (c) **PIB: NE tvrdi unique** (placeholderi, ino bez PIB-a) → parcijalni index `WHERE tax_id<>''` + rekonsilijacioni
     report (ulaz za Negovanovu spot-proveru).
2. **Overlay obrazac** (lokalno polje bez kolone u cache tabeli): `CustomerOverlay @@map("customers_overlay")`,
   `customerId Int @id` (FK na customers.id), + lokalna polja (`localNote`, `tags`, `archivedAt`, audit) — **nijedna
   kolona koja već postoji u customers**. Master+overlay preko Prisma relacije. Sync NE dira overlay. Isti šablon
   projects_overlay/items_overlay po potrebi.
3. **`bigbit_raw` staging** (jednokratna migracija finansija — Klaster C): **odvojena PG schema, VAN Prisma-e**
   (NE multiSchema — migrate bi je drop-ovao). `tools/bigbit-migrate/00_schema.sql` (`CREATE SCHEMA bigbit_raw`),
   `mdb-export` 1:1 puni `bigbit_raw.kontni_plan/sema_za_kontiranje/pdv_*/carina_*`. Nijedan FK/app ne gleda u nju;
   posle uvoza u 4.0 GL modele → `DROP SCHEMA bigbit_raw CASCADE`. Razdvaja „staging za migraciju" od „cache za rad".
4. **Migracioni put (jedan pisac po tabeli):** Komitenti (id=Sifra, dedup PIB) → Magacini (id=IDMagacin) →
   Predmeti (id=IDPredmet, spot-provera BrojPredmeta) → R_Artikli (**UPDATE-only** external_item_id) → Cenovnik
   (remap item_id preko external_item_id). Za customers/projects/warehouses **nema external kolone** (id=BigBit 1:1);
   items ostaje dual-key.
5. **Dual-writer rešenje:** dok MSSQL sync radi, on je jedini INSERT-pisac; bridge nad items **samo UPDATE**
   (external_item_id≠0); INSERT novih BigBit artikala **tek na cutover** (posle gašenja MSSQL sync-a). Parcijalni
   unique = guard. Na cutover bridge preuzima kao jedini pisac, MSSQL sync se briše iz SyncService. **U MSSQL se
   nikad ne piše** (§4.7 netaknuto — sav upis u PG).

## B — Šifarnici admin + Kontni plan + Šeme za kontiranje

### Stanje
`podesavanja` modul radi nad **sy15** (RBAC+HR); komercijalni šifarnici (TaxRate/DocumentType/Warehouse/OrderType/
ItemGroup/PriceListEntry) postoje kao **cache bez admin UI** u glavnoj šemi. **Kontni plan i Sema za kontiranje NE
POSTOJE** kao modeli.

### Dizajn
- **Novi Prisma modeli** (glavni PrismaService, ne sy15): `Account` (kontni plan: `konto`, `opis`,
  `dozvoljenaAnalitika`, `fajlSifara`, `inoKonto`); `AccountingScheme` + `AccountingSchemeLine` (`konto`, `defDug`,
  `defPot` izrazi, `analitika` bool, `kngSifra2`, `poreklo`); FK `DocumentType.postingSchemeId`.
- **Admin CRUD** (NestJS controller/service/dto) + **FE tabovi u podesavanja** vezani na glavni PrismaService
  (novi „Šifarnici/Finansije" grupa tabova, jer postojeći podesavanja je sy15). Magacini/TaxRate/DocumentType/
  OrderType/grupe/cenovnik dobijaju admin ekrane (šema postoji, fali UI).
- **SAFE izraz-parser** za `defDug`/`defPot` (`common/accounting/expr-parser.ts`): slova A–Z → vrednosti, `+ − * / ( )`,
  **BEZ `eval`** (rekurzivni descent, prioritet operatora — bolji od BigBit naivnog). Isti parser kasnije za GKEval (Faza 7).
- **Versioning poreskih stopa** (`validFrom/validTo` — TaxRate već ima; dodati admin ekran za istoriju).

## C — Migracioni staging + spot-provera
- `tools/bigbit-migrate/`: `bigbit_raw` load skripte (mdb-export → CSV → `\copy` u bigbit_raw); transform-upserteri
  (Komitenti dedup PIB, Artikli UPDATE-only, Cenovnik remap); **spot-provera 1:1** (verifikacioni upiti:
  Komitenti PIB / Predmeti BrojPredmeta / Magacini naziv); šema-drift zaštita (validacija širina/NOT NULL pre upisa);
  idempotencija (transakcija po tabeli, nikad delete).

## Redosled gradnje Faze 1
1. **Preduslovne migracije** (parcijalni unique items, @@unique cenovnik, index tax_id) — PRE svega.
2. **Novi modeli** Account/AccountingScheme + izraz-parser.
3. **Šifarnici admin** (CRUD + FE tabovi) — kontni plan i šeme uneti/potvrđeni.
4. **Overlay** modeli (customers_overlay…).
5. **bigbit_raw staging** skripte (ne dira Prisma).
6. **Migracioni upserteri + spot-provera** (spremni za cutover, ne pokreću se dok MSSQL radi).

## Quick win
**Kontni plan + Šeme za kontiranje uneti sa admin UI** (danas ne postoje) — odmah upotrebljivo kao temelj za GL;
knjigovođa može da potvrdi DefDug/DefPot formule kroz ekran.

## Odluke (rešene tehnički / za Kapiju 0)
- ✅ **bigbit_raw = odvojena PG schema van Prisma-e** (ne multiSchema) — mi-tehnicki.
- ✅ **PIB: index + report, ne hard unique** (nepouzdan) — mi-tehnicki; hard-dedupe = Negovanova spot-provera.
- ✅ **items dual-key ostaje** (opcija A, 57.998 kolizija) — potvrđeno #7.
- ⏳ **bigbit_raw da/ne + koliko godina finansijske istorije** — Nenad (Kapija 0, NE2/NE3).
- ⏳ **projects/Predmeti master vs ogledalo** (§11.1) — Negovan/Nenad (blokira write-path; preporuka: 2.0 postaje
  master za predmete posle cutover-a, BigBit read-back gasi se).
- ⏳ **Cutover timing MSSQL→bridge** — Nenad (NE1).

## Rizici
- **items.sql UPDATE bez unique = overwrite** → parcijalni unique MORA pre prvog bridge run-a na Artiklima.
- **Konsolidacija ne sme oboriti MSSQL sync** → Faza 1 NE aktivira bridge Fazu 2 (Komitenti/Artikli) dok MSSQL radi;
  bridge ostaje UPDATE-only; INSERT tek na cutover.
- **bigbit_raw van Prisma** → paziti da `prisma migrate` ne dira tu schemu (search_path/public only).

**Procena Faze 1:** ~15–20 AI-dana (preduslovne migracije+overlay ~3, šifarnici admin+kontni plan+šeme ~10–12,
staging+upserteri+spot-provera ~4–6).

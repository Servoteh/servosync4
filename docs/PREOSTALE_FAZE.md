# ServoSync — preostale faze (stanje 2026-07-12)

> Šta je urađeno zaključno sa danas i **šta konkretno ostaje** do 4.0. Autoritativni
> plan verzija ostaje [ROADMAP.md](ROADMAP.md); ovaj dokument je „operativni TODO" —
> radne linije koje su u toku, sa jasnim gate-ovima. Detalji BigBit sync-a:
> [migration/BB_T_26_ANALIZA_I_PLAN.md](migration/BB_T_26_ANALIZA_I_PLAN.md).

## 1. ServoSync 2.0 — modul „Tehnologija" (praktično završen)

Proizvodni core je **živ na produkciji** i spojen u 1.5 na `servosync.servoteh.com/tehnologija`.
Kraj-do-kraja rade: Radni nalozi, Tehnološki postupci (+ kartica po operaciji), PDM/Crteži
(rekurzivni BOM), Nacrti + Primopredaje (ceo tok odobravanja P0–P5), Lokacije delova, Proizvodne
strukture, MRP/Nabavka (uvid), Komitenti/Predmeti (pregled), barkod (RN dokument + kiosk).

**Živo od poslednjeg roadmap checkpointa (danas i prethodnih dana):**
- **Tehnolog tok (P0–P5):** dodela tehnologa pri **odobravanju** primopredaje (ne pri lansiranju),
  „Otkucaj TP" iz primopredaje, undo/vraćanje odobrenih, pretraga po tehnologu, notifikacije dorade.
- **Automatski uvoz PDM XML-a — ŽIV:** `pdm-bridge` na ubuntu serveru (systemd timer 5 min, CIFS mount
  ka PDM/BigBit share-ovima) čita XML i šalje u `POST /pdm/import`; PDF crtež se ne briše.
- **RBAC enforced na produkciji** (`AUTHZ_ENFORCE=true`); 5 kontrolora, SoD pravila.
- **Batch print** crteža sa izborom štampača (ploter/A4), zbir po operaciji, RN barkod verzioni guard.

**Preostalo za 2.0 = kozmetika, ne izgradnja:** UI dorade, sitni bugfix, poravnavanje naziva sa
QBigTehn-om. Nema više velikih modula — „imamo aplikaciju 2.0" je ispunjeno.

---

## 2. BigBit → 2.0 sync (nova radna linija, otvorena 11–12.07)

Trajni matični sync iz BigBit ERP-a (Access `.mdb`) u 2.0 PostgreSQL. **Odluka izvora (Nenad 11.07):
skripta na ubuntu serveru čita `mdb-tools`-om i piše direktno u PG** — NE XML export, NE preko NestJS
sync modula (menja stariju §11.2a odluku). Alat: [`tools/bigbit-bridge/`](../tools/bigbit-bridge/).
Mehanizam: BigBit noćni izvoz → SMB drop share `\\192.168.64.28\bigbit-incoming` (nalog `bbdrop`) →
`mdb-export` (ignoriše ULS, bez lozinke) → staging + `INSERT … ON CONFLICT DO UPDATE` (UPSERT, nikad
delete) preko lokalnog `docker exec servosync-pg psql`.

### Faza 1 — šifarnici artikala ✅ ŽIVO
`R_Grupa/R_Podgrupa/R_Poreklo` → `item_groups/item_subgroups/item_origins` (19/86/128). Artikli su
prvi put dobili nazive grupa/podgrupa/porekla. Idempotentno, dnevni ritam (timer 05:30 — ostaje uključiti).

### Faza 2 — matične tabele (pripremljeno, GATED do cutover-a)
ID-prostor rešen (Fable analiza §7.6, opcija A): `items.id` ostaje QBigTehn ključ, BigBit se veže
preko `items.external_item_id`.

| Tabela | Cilj | Stanje |
|---|---|---|
| **Magacini** | `warehouses` | ✅ **ŽIVO** (3, cilj bio prazan — nije MSSQL-sync tabela) |
| **Komitenti** | `customers` | 📝 napisano, dry-run čisto — **ISKLJUČENO do cutover-a** |
| **Predmeti** | `projects` | 📝 napisano, dry-run čisto — **ISKLJUČENO do cutover-a** |
| **R_Artikli** | `items` | 📝 napisano (UPDATE-only preko `external_item_id`) — **ISKLJUČENO do cutover-a** |
| **Cenovnik** | `price_list_entries` | ⏳ **TODO**: napisati `sql/`; treba `@@unique` poslovni ključ + remap artikla |

> ⚠️ **Zašto gated (Nenad 12.07):** ove tabele drži **živi MSSQL (QBigTehn) sync**. BigBit se ne sme
> prepisivati preko njega dok se ne uradi cutover („jedan pisac po tabeli"). U `tables.manifest` stoje
> zakomentarisane. Dry-run pokazuje da bi BigBit „ažurirao" skoro sve redove jer nosi polja koja MSSQL
> sync ostavlja prazna (`code_type_code`, `salesperson_id`) — bogatiji podatak koji stiže na cutover-u.

**Pre aktivacije Faze 2 (na cutover-u):**
1. Napisati `Cenovnik → price_list_entries` (+ migracija: `@@unique(item_id, document_type_code,
   tax_rate_code)` i parcijalni `uq_items_external_item_id WHERE external_item_id <> 0`).
2. **Field-level diff za `items`** — dry-run pokazuje 90.984 „update" bez FK razloga (verovatno
   reprezentacija: trailing space / NULL-vs-0), da gard hvata samo prave izmene, ne pun rewrite.
3. **Spot-provera 1:1 ID-a:** Komitenti (PIB), Predmeti (BrojPredmeta), Magacini (naziv).
4. Uključiti timer (`install-timer.sh`, 05:30) i BigBit noćni copy task na drop share.

### Faza 3 — ostatak KEEP-SYNC (~49 tabela, kad zatreba)
Dodavanje tabele = red u `tables.manifest` + `sql/<t>.sql`. Ide po potrebi modula koji je čita, ne
paušalno. EXCLUDE-TVRDO (55) se nikad ne kopira; ODLOŽI-4.0 (103) čeka 4.0 domene. Inventar:
[migration/BB_T_26-analiza-F3-inventar-207-tabela.md](migration/BB_T_26-analiza-F3-inventar-207-tabela.md).

---

## 3. Cutover — gašenje QBigTehn MSSQL sync-a (kritičan prelaz)

Kad proizvodnja pređe potpuno na 2.0 kao izvor istine:
1. **Aktivirati BigBit master sync** (Faza 2: customers/projects/items/Cenovnik) — BigBit postaje jedini
   pisac matičnih; `items` prelazi iz UPDATE-only u pun INSERT, park-lista novih artikala se prazni.
2. **1.0 Lokacije most** (`loc_*`) repointovati sa QBigTehn cache-a na 2.0 `tech_processes`, outbound
   `sp_ApplyLocationEvent` ugasiti/preusmeriti — vidi [ROADMAP „Sync tokom tranzicije"](ROADMAP.md).
   **Ne gasiti QBigTehn dok ovaj most nije prebačen.**
3. Ugasiti Sync A (QBigTehn MSSQL, `vasa-SQL:5765`); proizvodne tabele su već ServoSync vlasništvo.

---

## 4. Dalje — 3.0 i 4.0 (nepromenjen plan, vidi ROADMAP)

- **3.0** — prebacivanje ServoSync 1.0 (Supabase moduli) na stack 2.0 i spajanje u jednu aplikaciju.
  Najveći deo: 293 RLS + 238 SECURITY DEFINER → NestJS guardovi. Podaci već na on-prem PG (međukorak).
- **4.0** — apsorpcija BigBit ERP-a (GK/PDV/SEF/fakture/nabavka/carina). Bez roka, trigerima. Matične
  tabele iz Faze 2 tada prelaze iz cache → vlasništvo. Pun materijal spreman ([migration/09–14](migration/README.md)).

---

*Poslednji update: 2026-07-12 — otvorena BigBit sync radna linija (Faza 1 živa, Faza 2 gated do
cutover-a); 2.0 „Tehnologija" praktično završen (ostaje kozmetika).*

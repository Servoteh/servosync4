-- DETALJ POPISA: id-evi dokumenata razlike (VISAK/MANJAK) — 07.08.2026.
--
-- `InventoryService.get()` od 07.08.2026 čita vezu `stock_documents.inventory_count_id`
-- (`WHERE inventory_count_id = $1 AND kind IN ('VISAK','MANJAK')`), a nad tom kolonom
-- nije bilo NIJEDNOG indeksa — upit je Seq Scan po celoj tabeli robnih dokumenata.
--
-- Zašto SADA, kad je tabela prazna: mereno na produkciji 07.08.2026 —
--   SELECT count(*) FROM stock_documents;   -> 0
--   SELECT count(*) FROM inventory_counts;  -> 0
-- (4.0 robno se pušta u rad; BigBit je i dalje knjigovodstvo — v. odluku o cutoveru).
-- Indeks nad praznom tabelom je trenutan; nad tabelom u radu bi bio brava na `stock_documents`.
--
-- Cena bez indeksa nije jednokratna: `useUpdateCountItem` (FE) invalidira detalj popisa
-- posle SVAKOG unetog broja, pa komisija koja unese N stavki plaća N punih prolaza.
--
-- PARCIJALAN (`WHERE ... IS NOT NULL`): kolonu popunjavaju samo dokumenti nastali
-- zaključivanjem popisa — u redovnom robnom prometu je NULL. Isti obrazac i isto
-- obrazloženje kao `uq_stock_documents_po` (20260723140000_review_fixes_guards) i
-- `idx_stock_documents_transfer_pair` (20260727120000_prenos_izmedju_magacina); Prisma ne
-- modeluje parcijalne indekse, pa u `schema.prisma` stoji komentar-pokazivač uz ostala tri.
--
-- BEZ `CONCURRENTLY`: Prisma migracije idu u transakciji, gde `CONCURRENTLY` puca.
CREATE INDEX IF NOT EXISTS "idx_stock_documents_inventory_count"
  ON "stock_documents" ("inventory_count_id", "kind")
  WHERE "inventory_count_id" IS NOT NULL;

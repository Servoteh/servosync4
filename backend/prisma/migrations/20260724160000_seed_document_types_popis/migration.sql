-- E2 popis — vrste dokumenata VISAR (višak robe, ulaz) i MANJR (manjak robe, izlaz)
-- + NIV (nivelacija — konzistentnost šifarnika; kreira se iz nivelacija toka).
-- document_types je 4.0-owned šifarnik (BigBit „Vrste dokumenata", doc 12 RAZNO) —
-- NIJE QBigTehn sync-cache. Bez ovih redova popis finalize baca 422 (createStockDocument
-- validira documentTypeCode). ADITIVNO + IDEMPOTENTNO (guard po code — PK je id, code
-- nema unique pa se koristi WHERE NOT EXISTS).

INSERT INTO "document_types" ("code", "description", "is_inbound", "affects_stock")
SELECT 'VISAR', 'Višak robe (popis)', true, true
WHERE NOT EXISTS (SELECT 1 FROM "document_types" WHERE "code" = 'VISAR');

INSERT INTO "document_types" ("code", "description", "is_inbound", "affects_stock")
SELECT 'MANJR', 'Manjak robe (popis)', false, true
WHERE NOT EXISTS (SELECT 1 FROM "document_types" WHERE "code" = 'MANJR');

INSERT INTO "document_types" ("code", "description", "is_inbound", "affects_stock")
SELECT 'NIV', 'Nivelacija (revalorizacija zaliha)', true, false
WHERE NOT EXISTS (SELECT 1 FROM "document_types" WHERE "code" = 'NIV');

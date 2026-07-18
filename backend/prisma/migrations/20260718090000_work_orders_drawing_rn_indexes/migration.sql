-- R1 (PDM/Crteži — RN filter + kolona „RN"): indeksi za brzo poklapanje crtež↔RN.
-- Pravilo poklapanja (raw filter listDrawingsRaw + batch resolveWorkOrderRefs):
--   work_orders.drawing_id = drawings.id  OR  lower(work_orders.drawing_number) = lower(drawings.drawing_number)
--
-- Hand-authored (dev DB nedostupan pri generisanju; §3 odstupanje za prod-only okruženje).
-- IDEMPOTENTNO (IF NOT EXISTS) — bezbedno i na bazi gde su indeksi već kreirani ručno
-- (npr. CREATE INDEX CONCURRENTLY van pogona), i na svežoj/rebuild bazi.
--
-- (1) B-tree po drawing_id — pokriva EXISTS granu `w.drawing_id = d.id` i
--     resolveWorkOrderRefs `drawingId IN (...)`. Prati @@index u schema.prisma.
CREATE INDEX IF NOT EXISTS "idx_work_orders_drawing_id"
  ON "work_orders" ("drawing_id");

-- (2) Funkcionalni (izraz) indeks po lower(drawing_number) — pokriva granu
--     poklapanja po broju crteža (case-insensitive). Prisma @@index ne ume
--     izraz-indeks, pa je RAW-ONLY (nije u schema.prisma) — namerno.
CREATE INDEX IF NOT EXISTS "idx_work_orders_drawing_number_lower"
  ON "work_orders" (lower("drawing_number"));

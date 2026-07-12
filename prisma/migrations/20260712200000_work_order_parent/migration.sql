-- Poreklo dorada/škart naloga (Miljan t.2, ODLUKE #35): child RN → izvorni RN.
-- APP-ONLY kolona na ServoSync-owned tabeli; 0 = nema porekla.
ALTER TABLE "work_orders"
  ADD COLUMN "parent_work_order_id" INTEGER NOT NULL DEFAULT 0;

-- Reverse pretraga „deca ovog RN-a" (enrich + ?reworkOnly filter).
CREATE INDEX "idx_work_orders_parent" ON "work_orders" ("parent_work_order_id");

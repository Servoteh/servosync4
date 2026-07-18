-- CAM red (prioritizacija prevlačenjem) — Miljan/Nikola/Jovica ređaju redosled
-- pozicija za CAM programiranje. Aditivne kolone na app-owned `cnc_programs`.
-- Primena na prod: RUČNO psql (kao Paket B) — nema dev baze. DDL 1:1 sa @map.
ALTER TABLE "cnc_programs"
  ADD COLUMN "queue_order"            INTEGER,
  ADD COLUMN "queue_set_by_worker_id" INTEGER,
  ADD COLUMN "queue_set_at"          TIMESTAMPTZ(6);

-- Delimičan indeks: samo rangirani redovi (queue_order NOT NULL) učestvuju u
-- CAM redu; nerangirani (većina) se ne indeksiraju.
CREATE INDEX "ix_cnc_programs_queue_order"
  ON "cnc_programs" ("queue_order")
  WHERE "queue_order" IS NOT NULL;

-- Zahtev 016/26 (dopuna) — idempotencija obavestenja "primopredaja lansirana".
-- Lansiranje ima DVA ulaza (ekran Primopredaje i ekran Radni nalozi); pre slanja se
-- "claim-uje" red po work_order_launches.id (INSERT ... ON CONFLICT DO NOTHING), pa isti
-- launch nikad ne posalje dva mejla/zvonca. ADITIVNO, bez FK-ova (batch-resolve obrazac).

CREATE TABLE IF NOT EXISTS "work_order_launch_notifications" (
  "id" SERIAL NOT NULL,
  "work_order_launch_id" INTEGER NOT NULL,
  "work_order_id" INTEGER NOT NULL,
  "source" VARCHAR(20) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_work_order_launch_notifications" PRIMARY KEY ("id")
);

-- Kljuc idempotencije: jedno obavestenje po launch redu.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_work_order_launch_notifications_launch"
  ON "work_order_launch_notifications" ("work_order_launch_id");

CREATE INDEX IF NOT EXISTS "idx_work_order_launch_notifications_work_order"
  ON "work_order_launch_notifications" ("work_order_id");

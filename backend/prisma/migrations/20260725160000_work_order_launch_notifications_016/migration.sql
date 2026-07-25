-- Zahtev 016/26 (dopuna) — idempotencija obavestenja "primopredaja lansirana".
-- Lansiranje ima DVA ulaza (ekran Primopredaje i ekran Radni nalozi); pre slanja se
-- "claim-uje" red, pa isti dogadjaj nikad ne posalje dva mejla/zvonca. ADITIVNO, bez FK-ova
-- (batch-resolve obrazac).
--
-- KLJUC = drawing_handover_id, NE work_order_launches.id (review 25.07):
--   * work_order_launches.id se RECIKLIRA — alignIdSequence radi setval(seq, MAX(id)) pre
--     svakog insert-a, pa brisanje RN-a spusti sekvencu i sledece lansiranje dobije VEC
--     upotrebljen id -> claim bi ga tiho progutao i planer ne bi dobio nista;
--   * isti RN se moze ponovo lansirati (Otkljucaj -> Saglasan -> Lansiraj) i dobiti NOV
--     launch red -> planer bi dobio drugi identican mejl za isti dogadjaj.
-- Primopredaja je stabilan identitet dogadjaja "dokumentacija je lansirana u proizvodnju".

CREATE TABLE IF NOT EXISTS "work_order_launch_notifications" (
  "id" SERIAL NOT NULL,
  "drawing_handover_id" INTEGER NOT NULL,
  "work_order_launch_id" INTEGER,
  "work_order_id" INTEGER NOT NULL,
  "source" VARCHAR(20) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notified_at" TIMESTAMPTZ(6),
  CONSTRAINT "pk_work_order_launch_notifications" PRIMARY KEY ("id")
);

-- Kljuc idempotencije: jedno obavestenje po primopredaji.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_work_order_launch_notifications_handover"
  ON "work_order_launch_notifications" ("drawing_handover_id");

-- Cita se u deleteWorkOrderCascade (brisanje claim redova obrisanog RN-a).
CREATE INDEX IF NOT EXISTS "idx_work_order_launch_notifications_work_order"
  ON "work_order_launch_notifications" ("work_order_id");

-- Zahtev 038/26: otpremanje crteža (PDF) za RN koji je mašinska usluga bez PDM
-- crteža ("nema drawingId" — WorkOrder.drawing_id = 0). Isti bytea-u-bazi obrazac
-- kao `plan_proizvodnje_drawings` (M1: nema object storage). Dozvoljeno sa dva
-- ekrana:
--   • „radni nalozi" — RN već postoji → work_order_id
--   • primopredaje „na pisanju" PRE nego što RN nastane → handover_id
--     (work_order_id NULL dok RN ne nastane; servis ga tad backfilluje).
-- Oba ref-a su MEKI (bez DB FK-a) — isti obrazac kao plan_proizvodnje_drawings.
--
-- ADITIVNO i idempotentno (CREATE TABLE/INDEX IF NOT EXISTS): ne dira nijednu
-- postojeću tabelu. App-owned → Timestamptz(6) (BACKEND_RULES §2.3).

CREATE TABLE IF NOT EXISTS "work_order_drawing_pdfs" (
  "id"            SERIAL         NOT NULL,
  "work_order_id" INTEGER,                                          -- meki ref → work_orders; NULL dok RN ne postoji
  "handover_id"   INTEGER,                                           -- meki ref → drawing_handovers; NULL kad je work_order_id već poznat
  "file_name"     VARCHAR(255)   NOT NULL,
  "content_type"  VARCHAR(100),
  "pdf_binary"    BYTEA,                                             -- M1: bytea (glavna baza nema object storage)
  "size_bytes"    BIGINT,
  "uploaded_by"   TEXT,
  "uploaded_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at"    TIMESTAMPTZ(6),                                    -- soft-delete
  "deleted_by"    TEXT,
  CONSTRAINT "pk_work_order_drawing_pdfs" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "idx_work_order_drawing_pdfs_work_order" ON "work_order_drawing_pdfs" ("work_order_id");
CREATE INDEX IF NOT EXISTS "idx_work_order_drawing_pdfs_handover" ON "work_order_drawing_pdfs" ("handover_id");

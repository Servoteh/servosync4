-- Quality documents — QC dokumenti (skenirani nalozi, kontrolna dokumentacija, foto sa
-- tableta/telefona) — MODULE_SPEC_kontrola_kvaliteta §K4-UPLOAD. ODLUKA Nenad 15.07:
-- NEMA share/mount — sadržaj se UPLOADUJE kroz aplikaciju i čuva u koloni `content`
-- (BYTEA), presedan drawing_pdfs. App-owned 2.0 tabela (NIJE legacy sync).
--   report_id       — PRAVI FK → nonconformity_reports ON DELETE SET NULL (brisanje drafta
--                     ne briše arhivski dokument);
--   tech_process_id / work_order_id / ident_number — MEKI (bez FK, batch-resolve/pretraga
--                     po legacy lancu; dokument sme biti i NEVEZAN — arhivski).
-- Timestamptz kao ostale 2.0 app-owned tabele (BACKEND_RULES §11.5, presedan
-- nonconformity_reports / cnc_programs).
CREATE TABLE "quality_documents" (
  "id"                  SERIAL         NOT NULL,
  "report_id"           INTEGER,
  "tech_process_id"     INTEGER,
  "work_order_id"       INTEGER,
  "ident_number"        VARCHAR(50),
  "file_name"           VARCHAR(255)   NOT NULL,
  "content_type"        VARCHAR(100)   NOT NULL,
  "size_kb"             INTEGER        NOT NULL,
  "content"             BYTEA          NOT NULL,
  "uploaded_by_user_id" INTEGER,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_quality_documents" PRIMARY KEY ("id"),
  CONSTRAINT "fk_quality_documents_report" FOREIGN KEY ("report_id")
    REFERENCES "nonconformity_reports" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX "idx_quality_documents_report" ON "quality_documents" ("report_id");
CREATE INDEX "idx_quality_documents_tech_process" ON "quality_documents" ("tech_process_id");
CREATE INDEX "idx_quality_documents_ident" ON "quality_documents" ("ident_number");
CREATE INDEX "idx_quality_documents_created" ON "quality_documents" ("created_at");

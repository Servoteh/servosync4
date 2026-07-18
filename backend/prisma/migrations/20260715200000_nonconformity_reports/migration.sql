-- Nonconformity reports (škart + dorada) — digitalizacija Excel evidencija
-- (MODULE_SPEC_kontrola_kvaliteta §4). App-owned 2.0 tabele (NISU legacy sync).
-- Broj izveštaja (NNN/YY) se dodeljuje TEK pri potvrdi (draft: report_number = NULL) →
-- obrisan lažni draft ne pravi rupu u sekvenci. Meki FK-ovi ka work_orders/tech_processes/
-- workers su BEZ constrainta (batch-resolve, legacy orphan); jedini pravi FK je
-- nonconformity_workers.report_id (obe tabele 2.0 native). Timestamptz kao ostale 2.0
-- app-owned tabele (BACKEND_RULES §11.5, presedan cnc_programs / app_notifications).
CREATE TABLE "nonconformity_reports" (
  "id"                     SERIAL         NOT NULL,
  "type"                   SMALLINT       NOT NULL,           -- 1=dorada, 2=škart
  "report_number"          VARCHAR(20),                       -- NULL dok je draft
  "report_year"            INTEGER        NOT NULL,
  "report_date"            TIMESTAMPTZ(6) NOT NULL,
  "status"                 SMALLINT       NOT NULL DEFAULT 0, -- 0=draft, 1=potvrđen
  "work_order_id"          INTEGER,
  "ident_number"           VARCHAR(50),
  "source_tech_process_id" INTEGER,
  "drawing_number"         VARCHAR(100),
  "part_name"              VARCHAR(255),
  "customer_name"          VARCHAR(255),
  "quantity"               INTEGER        NOT NULL,
  "defect_description"     TEXT           NOT NULL DEFAULT '',
  "cause"                  TEXT,
  "work_unit"              VARCHAR(120),
  "culprit_text"           VARCHAR(255),
  "material_cost_note"     VARCHAR(255),
  "coop_cost_note"         VARCHAR(255),
  "spent_hours_text"       VARCHAR(50),
  "spent_hours"            DECIMAL(10,3),
  "note"                   TEXT,
  "preventive_measures"    TEXT,
  "extra"                  VARCHAR(255),
  "raised_by_worker_id"    INTEGER,
  "created_by_user_id"     INTEGER,
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "pk_nonconformity_reports" PRIMARY KEY ("id")
);

-- Partial UNIQUE (type, report_number) SAMO gde broj postoji: draftovi (report_number
-- NULL) se ne takmiče. Prisma šema ne može izraziti partial unique (WHERE) → constraint
-- živi samo ovde; model NonconformityReport ima /// komentar zašto @@unique izostaje.
CREATE UNIQUE INDEX "uq_nonconformity_reports_type_number"
  ON "nonconformity_reports" ("type", "report_number")
  WHERE "report_number" IS NOT NULL;

CREATE INDEX "idx_nonconformity_reports_type_status" ON "nonconformity_reports" ("type", "status");
CREATE INDEX "idx_nonconformity_reports_year" ON "nonconformity_reports" ("report_year");
CREATE INDEX "idx_nonconformity_reports_work_order" ON "nonconformity_reports" ("work_order_id");

-- Izvršioci-radnici (M:N) po izveštaju — puni „Moje neusaglašenosti" u Moj profil (K3).
-- worker_id = meki FK (batch-resolve); report_id = pravi FK (CASCADE) jer su obe 2.0 native.
CREATE TABLE "nonconformity_workers" (
  "id"        SERIAL  NOT NULL,
  "report_id" INTEGER NOT NULL,
  "worker_id" INTEGER NOT NULL,
  CONSTRAINT "pk_nonconformity_workers" PRIMARY KEY ("id"),
  CONSTRAINT "fk_nonconformity_workers_report" FOREIGN KEY ("report_id")
    REFERENCES "nonconformity_reports" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "uq_nonconformity_workers_report_worker" ON "nonconformity_workers" ("report_id", "worker_id");
CREATE INDEX "idx_nonconformity_workers_worker" ON "nonconformity_workers" ("worker_id");

-- Neusaglašenosti na montaži (zahtev 004/26) — app-owned 2.0-native tabele.
-- Zaseban modul (NIJE proširenje Kvaliteta, NIJE sy15): prijava sa terena/hale +
-- istraga; broj NM-NNN/YY po godini (advisory lock 'montaza:nm'); obaveštenje rolе
-- menadzment (in-app + mail). Meki ref-ovi (project_id/responsible_worker_id/RN) su BEZ
-- constrainta (batch-resolve, legacy orphan); pravi FK su photos/events → parent (CASCADE).
-- Timestamptz kao ostale 2.0 app-owned tabele (BACKEND_RULES §11.5).
-- Ručno pisana migracija (obrazac postojećih SQL fajlova): dev Postgres nedostupan u
-- okruženju agenta; primeniće se `migrate:dev`/`migrate:prod` na throwaway/dev bazi.

-- CreateTable
CREATE TABLE "montage_nonconformities" (
    "id" SERIAL NOT NULL,
    "report_number" VARCHAR(12) NOT NULL,        -- "NM-NNN/YY" (dodeljuje server pri kreiranju)
    "project_number" VARCHAR(20),                -- broj predmeta (obavezan u prijavi; slobodan tekst)
    "project_id" INTEGER,                        -- meki ref projects.id
    "description" TEXT NOT NULL,
    "severity" VARCHAR(10) NOT NULL,             -- MALA | SREDNJA | VISOKA
    "location_kind" VARCHAR(10) NOT NULL,        -- SERVOTEH | TEREN
    "location_note" VARCHAR(200),
    "drawing_number" VARCHAR(60),
    "work_order_code" VARCHAR(40),               -- RN broj (string, meki)
    "status" VARCHAR(15) NOT NULL DEFAULT 'CEKA_ANALIZU',  -- CEKA_ANALIZU | U_TOKU | ZAVRSENO
    "reported_by_user_id" INTEGER NOT NULL,
    "responsible_department" VARCHAR(60),        -- istraga
    "responsible_worker_id" INTEGER,             -- istraga (meki ref workers.id)
    "investigation_report" TEXT,                 -- istraga
    "preventive_measures" TEXT,                  -- istraga
    "investigated_by_user_id" INTEGER,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "pk_montage_nonconformities" PRIMARY KEY ("id")
);

-- CreateTable — foto prijave (bytea, magic-byte validacija PDF/PNG/JPG; presedan quality_documents).
CREATE TABLE "montage_nonconformity_photos" (
    "id" SERIAL NOT NULL,
    "nonconformity_id" INTEGER NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "content_type" VARCHAR(80) NOT NULL,
    "content" BYTEA NOT NULL,
    "created_by_user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "pk_montage_nonconformity_photos" PRIMARY KEY ("id")
);

-- CreateTable — insert-only timeline (obrazac change_request_events).
CREATE TABLE "montage_nonconformity_events" (
    "id" SERIAL NOT NULL,
    "nonconformity_id" INTEGER NOT NULL,
    "type" VARCHAR(30) NOT NULL,                 -- CREATED|STATUS_CHANGED|INVESTIGATION_UPDATED|PHOTO_ADDED|NOTE
    "actor_user_id" INTEGER,
    "data" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "pk_montage_nonconformity_events" PRIMARY KEY ("id")
);

-- CreateIndex — jedinstven broj prijave (advisory lock serijalizuje generisanje; ovo je safety-net).
CREATE UNIQUE INDEX "uq_montage_nonconformities_report_number" ON "montage_nonconformities"("report_number");

-- CreateIndex
CREATE INDEX "idx_montage_nonconformities_status" ON "montage_nonconformities"("status");
CREATE INDEX "idx_montage_nonconformities_severity" ON "montage_nonconformities"("severity");
CREATE INDEX "idx_montage_nonconformities_project_number" ON "montage_nonconformities"("project_number");
CREATE INDEX "idx_montage_nonconformities_created" ON "montage_nonconformities"("created_at");

-- CreateIndex
CREATE INDEX "idx_montage_nc_photos_nonconformity" ON "montage_nonconformity_photos"("nonconformity_id");
CREATE INDEX "idx_montage_nc_events_nonconformity" ON "montage_nonconformity_events"("nonconformity_id");

-- AddForeignKey
ALTER TABLE "montage_nonconformity_photos" ADD CONSTRAINT "fk_montage_nc_photos_nonconformity" FOREIGN KEY ("nonconformity_id") REFERENCES "montage_nonconformities"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "montage_nonconformity_events" ADD CONSTRAINT "fk_montage_nc_events_nonconformity" FOREIGN KEY ("nonconformity_id") REFERENCES "montage_nonconformities"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

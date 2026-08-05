-- Seoba sy15 -> 3.0, KORAK 1: SASTANCI + PROJEKTNI BIRO (05.08.2026)
-- Merenje i runbook: docs/SEOBA_SASTANCI_PB_2026-08-05.md
-- Plan: docs/PLAN_GASENJA_SY15_2026-08-03.md (korak 1).
--
-- Generisano OFFLINE: `prisma migrate diff` datamodel->datamodel (origin/main schema
-- -> ova grana), po BACKEND_RULES §12 v0.7. `migrate dev` na produkciji je zabranjen;
-- primenjuje se ISKLJUCIVO `migrate:prod` (deploy) uz prethodni `migrate status`.
--
-- ⚠️ Ova migracija SAMO KREIRA 27 praznih tabela. Podatke prenosi
-- backend/scripts/migrate-sastanci-pb-sy15.ts (dry-run po difoltu).
-- sy15 se ovim NE dira.

-- CreateTable
CREATE TABLE "sastanci" (
    "id" UUID NOT NULL,
    "tip" VARCHAR(20) NOT NULL DEFAULT 'sedmicni',
    "naslov" TEXT NOT NULL,
    "datum" DATE NOT NULL,
    "vreme" TIME(6),
    "mesto" TEXT DEFAULT '',
    "projekat_id" INTEGER,
    "vodio_email" VARCHAR(255),
    "vodio_label" TEXT,
    "zapisnicar_email" VARCHAR(255),
    "zapisnicar_label" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'planiran',
    "zakljucan_at" TIMESTAMPTZ(6),
    "zakljucan_by_email" VARCHAR(255),
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_email" VARCHAR(255),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pozivnice_poslate_at" TIMESTAMPTZ(6),
    "zapisnik_datum" DATE,
    "interval_days" INTEGER,
    "prethodni_sastanak_id" UUID,

    CONSTRAINT "pk_sastanci" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sastanak_ucesnici" (
    "sastanak_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "label" TEXT,
    "prisutan" BOOLEAN NOT NULL DEFAULT true,
    "pozvan" BOOLEAN NOT NULL DEFAULT true,
    "napomena" TEXT,
    "pripremljen" BOOLEAN NOT NULL DEFAULT false,
    "priprema" TEXT,
    "rsvp_status" VARCHAR(20),
    "rsvp_at" TIMESTAMPTZ(6),
    "rsvp_token" UUID NOT NULL,

    CONSTRAINT "pk_sastanak_ucesnici" PRIMARY KEY ("sastanak_id","email")
);

-- CreateTable
CREATE TABLE "sastanak_odluke" (
    "id" UUID NOT NULL,
    "sastanak_id" UUID NOT NULL,
    "rb" INTEGER,
    "naslov" TEXT NOT NULL,
    "opis" TEXT,
    "odlucio_email" VARCHAR(255),
    "odlucio_label" TEXT,
    "odluka_datum" DATE,
    "uticaj" TEXT,
    "veza_tema_id" UUID,
    "veza_akcija_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'na_snazi',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_sastanak_odluke" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sastanak_arhiva" (
    "id" UUID NOT NULL,
    "sastanak_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "zapisnik_storage_path" TEXT,
    "zapisnik_size_bytes" BIGINT,
    "zapisnik_generated_at" TIMESTAMPTZ(6),
    "arhivirao_email" VARCHAR(255),
    "arhivirao_label" TEXT,
    "arhivirano_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_sastanak_arhiva" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sastanci_templates" (
    "id" UUID NOT NULL,
    "naziv" TEXT NOT NULL,
    "tip" VARCHAR(20) NOT NULL,
    "mesto" TEXT,
    "vodio_email" VARCHAR(255),
    "zapisnicar_email" VARCHAR(255),
    "cadence" VARCHAR(20) NOT NULL,
    "cadence_dow" INTEGER,
    "cadence_dom" INTEGER,
    "vreme" TIME(6),
    "napomena" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_email" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_sastanci_templates" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sastanci_template_ucesnici" (
    "template_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "label" TEXT,

    CONSTRAINT "pk_sastanci_template_ucesnici" PRIMARY KEY ("template_id","email")
);

-- CreateTable
CREATE TABLE "sastanci_notification_log" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "channel" VARCHAR(20) NOT NULL DEFAULT 'email',
    "recipient_email" VARCHAR(255) NOT NULL,
    "recipient_label" TEXT,
    "subject" TEXT NOT NULL,
    "body_html" TEXT,
    "body_text" TEXT,
    "related_sastanak_id" UUID,
    "related_akcija_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "error" TEXT,
    "payload" JSONB,
    "created_by_email" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_sastanci_notification_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sastanci_notification_prefs" (
    "email" VARCHAR(255) NOT NULL,
    "on_new_akcija" BOOLEAN NOT NULL DEFAULT true,
    "on_change_akcija" BOOLEAN NOT NULL DEFAULT true,
    "on_meeting_invite" BOOLEAN NOT NULL DEFAULT true,
    "on_meeting_locked" BOOLEAN NOT NULL DEFAULT true,
    "on_action_reminder" BOOLEAN NOT NULL DEFAULT true,
    "on_meeting_reminder" BOOLEAN NOT NULL DEFAULT true,
    "email_address" VARCHAR(255),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_sastanci_notification_prefs" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "sastanci_ai_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "model" VARCHAR(80) NOT NULL,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_sastanci_ai_settings" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sast_weekly_skip" (
    "week_monday" DATE NOT NULL,
    "reason" TEXT,
    "created_by_email" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_sast_weekly_skip" PRIMARY KEY ("week_monday")
);

-- CreateTable
CREATE TABLE "sast_weekly_movers" (
    "email" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_sast_weekly_movers" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "akcioni_plan" (
    "id" UUID NOT NULL,
    "sastanak_id" UUID,
    "tema_id" UUID,
    "projekat_id" INTEGER,
    "rb" INTEGER,
    "naslov" TEXT NOT NULL,
    "opis" TEXT,
    "odgovoran_email" VARCHAR(255),
    "odgovoran_label" TEXT,
    "odgovoran_text" TEXT,
    "rok" DATE,
    "rok_text" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'otvoren',
    "prioritet" INTEGER NOT NULL DEFAULT 2,
    "zatvoren_at" TIMESTAMPTZ(6),
    "zatvoren_by_email" VARCHAR(255),
    "zatvoren_napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_email" VARCHAR(255),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_akcioni_plan" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "akcioni_plan_istorija" (
    "id" UUID NOT NULL,
    "akcija_id" UUID NOT NULL,
    "polje" VARCHAR(60) NOT NULL,
    "staro" TEXT,
    "novo" TEXT,
    "izmenio_email" VARCHAR(255),
    "izmenjeno_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_akcioni_plan_istorija" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pm_teme" (
    "id" UUID NOT NULL,
    "vrsta" VARCHAR(20) NOT NULL DEFAULT 'tema',
    "oblast" VARCHAR(20) NOT NULL DEFAULT 'opste',
    "naslov" TEXT NOT NULL,
    "opis" TEXT,
    "projekat_id" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'predlog',
    "prioritet" INTEGER NOT NULL DEFAULT 2,
    "sastanak_id" UUID,
    "predlozio_email" VARCHAR(255) NOT NULL,
    "predlozio_label" TEXT,
    "predlozio_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resio_email" VARCHAR(255),
    "resio_label" TEXT,
    "resio_at" TIMESTAMPTZ(6),
    "resio_napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hitno" BOOLEAN NOT NULL DEFAULT false,
    "za_razmatranje" BOOLEAN NOT NULL DEFAULT false,
    "admin_rang" INTEGER,
    "admin_rang_by_email" VARCHAR(255),
    "admin_rang_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_pm_teme" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presek_aktivnosti" (
    "id" UUID NOT NULL,
    "sastanak_id" UUID NOT NULL,
    "rb" INTEGER NOT NULL,
    "redosled" INTEGER NOT NULL DEFAULT 0,
    "naslov" TEXT NOT NULL,
    "pod_rn" VARCHAR(60),
    "sadrzaj_html" TEXT,
    "sadrzaj_text" TEXT,
    "odgovoran_email" VARCHAR(255),
    "odgovoran_label" TEXT,
    "odgovoran_text" TEXT,
    "rok" DATE,
    "rok_text" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'u_toku',
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tema_id" UUID,

    CONSTRAINT "pk_presek_aktivnosti" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presek_slike" (
    "id" UUID NOT NULL,
    "sastanak_id" UUID NOT NULL,
    "aktivnost_id" UUID,
    "storage_path" TEXT NOT NULL,
    "file_name" TEXT,
    "mime_type" VARCHAR(120),
    "size_bytes" BIGINT,
    "caption" TEXT,
    "redosled" INTEGER NOT NULL DEFAULT 0,
    "uploaded_by_email" VARCHAR(255),
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_presek_slike" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_tasks" (
    "id" UUID NOT NULL,
    "naziv" TEXT NOT NULL,
    "opis" TEXT,
    "problem" TEXT,
    "project_id" INTEGER,
    "employee_id" UUID,
    "vrsta" VARCHAR(40) NOT NULL DEFAULT 'Projektovanje 3D',
    "prioritet" VARCHAR(20) NOT NULL DEFAULT 'Srednji',
    "status" VARCHAR(20) NOT NULL DEFAULT 'Nije počelo',
    "datum_pocetka_plan" DATE,
    "datum_zavrsetka_plan" DATE,
    "datum_pocetka_real" DATE,
    "datum_zavrsetka_real" DATE,
    "procenat_zavrsenosti" INTEGER NOT NULL DEFAULT 0,
    "norma_sati_dan" INTEGER NOT NULL DEFAULT 4,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(255),
    "updated_by" VARCHAR(255),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_pb_tasks" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_task_comments" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(255),
    "created_by_user_id" INTEGER,
    "edited_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_pb_task_comments" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_task_deps" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "depends_on_task_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(255),

    CONSTRAINT "pk_pb_task_deps" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_task_files" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "mime_type" VARCHAR(120),
    "size_bytes" BIGINT,
    "category" VARCHAR(40),
    "description" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" INTEGER,
    "uploaded_by_email" VARCHAR(255),

    CONSTRAINT "pk_pb_task_files" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_work_reports" (
    "id" UUID NOT NULL,
    "employee_id" UUID,
    "datum" DATE NOT NULL,
    "sati" DECIMAL(4,1) NOT NULL,
    "opis" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(255),

    CONSTRAINT "pk_pb_work_reports" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_eng_tip_categories" (
    "id" UUID NOT NULL,
    "naziv" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "ikona" VARCHAR(80),
    "boja" VARCHAR(40),
    "redosled" INTEGER NOT NULL DEFAULT 0,
    "je_aktivna" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_pb_eng_tip_categories" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_eng_tips" (
    "id" UUID NOT NULL,
    "naslov" TEXT NOT NULL,
    "telo" TEXT NOT NULL,
    "category_id" UUID,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "vendor" TEXT,
    "url" TEXT,
    "project_id" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "author_id" UUID,
    "author_email" VARCHAR(255),
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(255),
    "updated_by" VARCHAR(255),
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_pb_eng_tips" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_eng_tip_files" (
    "id" UUID NOT NULL,
    "tip_id" UUID NOT NULL,
    "storage_path" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" VARCHAR(120),
    "size_bytes" BIGINT,
    "uploaded_by" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_pb_eng_tip_files" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_eng_tip_likes" (
    "tip_id" UUID NOT NULL,
    "user_id" INTEGER NOT NULL,
    "user_email" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_pb_eng_tip_likes" PRIMARY KEY ("tip_id","user_id")
);

-- CreateTable
CREATE TABLE "pb_notification_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "deadline_warning_days" INTEGER NOT NULL DEFAULT 3,
    "overload_threshold_pct" INTEGER NOT NULL DEFAULT 100,
    "email_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notify_on_blocked" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_overload" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_deadline_warning" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_deadline_overdue" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_no_engineer" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6),
    "updated_by" VARCHAR(255),
    "quiet_hours_start" TIME(6),
    "quiet_hours_end" TIME(6),
    "quiet_hours_tz" VARCHAR(60) NOT NULL DEFAULT 'Europe/Belgrade',
    "digest_mode" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pk_pb_notification_config" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pb_notification_log" (
    "id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "recipient" VARCHAR(255) NOT NULL,
    "recipient_user_id" INTEGER,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "trigger_type" VARCHAR(60) NOT NULL,
    "related_task_id" UUID,
    "related_employee_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_pb_notification_log" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_sastanci_datum" ON "sastanci"("datum" DESC);

-- CreateIndex
CREATE INDEX "idx_sastanci_projekat" ON "sastanci"("projekat_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sastanak_ucesnici_rsvp_token" ON "sastanak_ucesnici"("rsvp_token");

-- CreateIndex
CREATE INDEX "idx_sast_odluke_sastanak" ON "sastanak_odluke"("sastanak_id");

-- CreateIndex
CREATE INDEX "idx_sast_odluke_status" ON "sastanak_odluke"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_sastanak_arhiva_sastanak" ON "sastanak_arhiva"("sastanak_id");

-- CreateIndex
CREATE INDEX "idx_sa_arhivirano_at" ON "sastanak_arhiva"("arhivirano_at" DESC);

-- CreateIndex
CREATE INDEX "idx_sast_notif_recipient" ON "sastanci_notification_log"("recipient_email", "kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_ap_odgovoran" ON "akcioni_plan"("odgovoran_email");

-- CreateIndex
CREATE INDEX "idx_ap_projekat" ON "akcioni_plan"("projekat_id");

-- CreateIndex
CREATE INDEX "idx_ap_rok" ON "akcioni_plan"("rok");

-- CreateIndex
CREATE INDEX "idx_ap_sastanak" ON "akcioni_plan"("sastanak_id");

-- CreateIndex
CREATE INDEX "idx_ap_status" ON "akcioni_plan"("status");

-- CreateIndex
CREATE INDEX "idx_akcioni_plan_istorija_akcija" ON "akcioni_plan_istorija"("akcija_id", "izmenjeno_at" DESC);

-- CreateIndex
CREATE INDEX "idx_pm_teme_predlozio" ON "pm_teme"("predlozio_email");

-- CreateIndex
CREATE INDEX "idx_pm_teme_projekat" ON "pm_teme"("projekat_id");

-- CreateIndex
CREATE INDEX "idx_pm_teme_projekat_rang" ON "pm_teme"("projekat_id", "admin_rang");

-- CreateIndex
CREATE INDEX "idx_pm_teme_sastanak" ON "pm_teme"("sastanak_id");

-- CreateIndex
CREATE INDEX "idx_pm_teme_status" ON "pm_teme"("status");

-- CreateIndex
CREATE INDEX "idx_pa_sastanak" ON "presek_aktivnosti"("sastanak_id", "redosled");

-- CreateIndex
CREATE INDEX "idx_pa_status" ON "presek_aktivnosti"("status");

-- CreateIndex
CREATE INDEX "idx_ps_aktivnost" ON "presek_slike"("aktivnost_id");

-- CreateIndex
CREATE INDEX "idx_ps_sastanak" ON "presek_slike"("sastanak_id", "redosled");

-- CreateIndex
CREATE INDEX "idx_pb_tasks_employee" ON "pb_tasks"("employee_id");

-- CreateIndex
CREATE INDEX "idx_pb_tasks_project" ON "pb_tasks"("project_id");

-- CreateIndex
CREATE INDEX "idx_pb_tasks_status" ON "pb_tasks"("status");

-- CreateIndex
CREATE INDEX "idx_ptc_task_created" ON "pb_task_comments"("task_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_ptd_depends_on" ON "pb_task_deps"("depends_on_task_id");

-- CreateIndex
CREATE INDEX "idx_ptd_task" ON "pb_task_deps"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pb_task_deps_task_depends" ON "pb_task_deps"("task_id", "depends_on_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pb_task_files_storage_path" ON "pb_task_files"("storage_path");

-- CreateIndex
CREATE INDEX "idx_pb_work_reports_datum" ON "pb_work_reports"("datum");

-- CreateIndex
CREATE INDEX "idx_pb_work_reports_employee" ON "pb_work_reports"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pb_eng_tip_categories_naziv" ON "pb_eng_tip_categories"("naziv");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pb_eng_tip_categories_slug" ON "pb_eng_tip_categories"("slug");

-- CreateIndex
CREATE INDEX "idx_pb_eng_tip_files_tip" ON "pb_eng_tip_files"("tip_id");

-- AddForeignKey
ALTER TABLE "sastanci" ADD CONSTRAINT "fk_sastanci_project" FOREIGN KEY ("projekat_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanci" ADD CONSTRAINT "fk_sastanci_prethodni" FOREIGN KEY ("prethodni_sastanak_id") REFERENCES "sastanci"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanak_ucesnici" ADD CONSTRAINT "fk_sastanak_ucesnici_sastanak" FOREIGN KEY ("sastanak_id") REFERENCES "sastanci"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanak_odluke" ADD CONSTRAINT "fk_sastanak_odluke_sastanak" FOREIGN KEY ("sastanak_id") REFERENCES "sastanci"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanak_odluke" ADD CONSTRAINT "fk_sastanak_odluke_tema" FOREIGN KEY ("veza_tema_id") REFERENCES "pm_teme"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanak_odluke" ADD CONSTRAINT "fk_sastanak_odluke_akcija" FOREIGN KEY ("veza_akcija_id") REFERENCES "akcioni_plan"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanak_arhiva" ADD CONSTRAINT "fk_sastanak_arhiva_sastanak" FOREIGN KEY ("sastanak_id") REFERENCES "sastanci"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanci_template_ucesnici" ADD CONSTRAINT "fk_sastanci_template_ucesnici_template" FOREIGN KEY ("template_id") REFERENCES "sastanci_templates"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanci_notification_log" ADD CONSTRAINT "fk_sastanci_notification_log_sastanak" FOREIGN KEY ("related_sastanak_id") REFERENCES "sastanci"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanci_notification_log" ADD CONSTRAINT "fk_sastanci_notification_log_akcija" FOREIGN KEY ("related_akcija_id") REFERENCES "akcioni_plan"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sastanci_ai_settings" ADD CONSTRAINT "fk_sastanci_ai_settings_user" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "akcioni_plan" ADD CONSTRAINT "fk_akcioni_plan_sastanak" FOREIGN KEY ("sastanak_id") REFERENCES "sastanci"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "akcioni_plan" ADD CONSTRAINT "fk_akcioni_plan_tema" FOREIGN KEY ("tema_id") REFERENCES "pm_teme"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "akcioni_plan" ADD CONSTRAINT "fk_akcioni_plan_project" FOREIGN KEY ("projekat_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "akcioni_plan_istorija" ADD CONSTRAINT "fk_akcioni_plan_istorija_akcija" FOREIGN KEY ("akcija_id") REFERENCES "akcioni_plan"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pm_teme" ADD CONSTRAINT "fk_pm_teme_project" FOREIGN KEY ("projekat_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pm_teme" ADD CONSTRAINT "fk_pm_teme_sastanak" FOREIGN KEY ("sastanak_id") REFERENCES "sastanci"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "presek_aktivnosti" ADD CONSTRAINT "fk_presek_aktivnosti_sastanak" FOREIGN KEY ("sastanak_id") REFERENCES "sastanci"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "presek_slike" ADD CONSTRAINT "fk_presek_slike_sastanak" FOREIGN KEY ("sastanak_id") REFERENCES "sastanci"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "presek_slike" ADD CONSTRAINT "fk_presek_slike_aktivnost" FOREIGN KEY ("aktivnost_id") REFERENCES "presek_aktivnosti"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_tasks" ADD CONSTRAINT "fk_pb_tasks_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_task_comments" ADD CONSTRAINT "fk_pb_task_comments_task" FOREIGN KEY ("task_id") REFERENCES "pb_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_task_comments" ADD CONSTRAINT "fk_pb_task_comments_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_task_deps" ADD CONSTRAINT "fk_pb_task_deps_task" FOREIGN KEY ("task_id") REFERENCES "pb_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_task_deps" ADD CONSTRAINT "fk_pb_task_deps_depends_on" FOREIGN KEY ("depends_on_task_id") REFERENCES "pb_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_task_files" ADD CONSTRAINT "fk_pb_task_files_task" FOREIGN KEY ("task_id") REFERENCES "pb_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_task_files" ADD CONSTRAINT "fk_pb_task_files_user" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_eng_tips" ADD CONSTRAINT "fk_pb_eng_tips_category" FOREIGN KEY ("category_id") REFERENCES "pb_eng_tip_categories"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_eng_tips" ADD CONSTRAINT "fk_pb_eng_tips_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_eng_tip_files" ADD CONSTRAINT "fk_pb_eng_tip_files_tip" FOREIGN KEY ("tip_id") REFERENCES "pb_eng_tips"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_eng_tip_likes" ADD CONSTRAINT "fk_pb_eng_tip_likes_tip" FOREIGN KEY ("tip_id") REFERENCES "pb_eng_tips"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_eng_tip_likes" ADD CONSTRAINT "fk_pb_eng_tip_likes_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_notification_log" ADD CONSTRAINT "fk_pb_notification_log_task" FOREIGN KEY ("related_task_id") REFERENCES "pb_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pb_notification_log" ADD CONSTRAINT "fk_pb_notification_log_user" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;


-- ============================================================================
-- DEO 2 — SQL-ONLY (Prisma ovo ne ume da izrazi u datamodelu)
-- ============================================================================
-- Sve niže je 1:1 preslikano iz žive sy15 šeme (pg_dump --schema-only, 05.08.2026),
-- osim gde je izričito napisano zašto se razlikuje.
-- Redosled: CHECK-ovi -> generisane kolone -> parcijalni/funkcijski indeksi ->
--           tsvector + njegov trigger -> `updated_at` trigger.

-- ---------------------------------------------------------------------------
-- 2.1 CHECK ograničenja (u sy15 su delom bila PG enum tipovi; BACKEND_RULES §2.2
--     traži String + CHECK, pa su `pb_task_*`/`pb_prioritet`/`pb_eng_tip_status`
--     enumi ovde postali CHECK-ovi sa ISTIM skupom vrednosti).
-- ---------------------------------------------------------------------------

ALTER TABLE "sastanci"
  ADD CONSTRAINT "ck_sastanci_tip" CHECK ("tip" IN ('sedmicni','projektni','tematski','dnevni','periodicni')),
  ADD CONSTRAINT "ck_sastanci_status" CHECK ("status" IN ('planiran','u_toku','zavrsen','zakljucan','otkazan')),
  ADD CONSTRAINT "ck_sastanci_interval_days" CHECK ("interval_days" IS NULL OR ("interval_days" >= 1 AND "interval_days" <= 365));

ALTER TABLE "sastanak_ucesnici"
  ADD CONSTRAINT "ck_sastanak_ucesnici_rsvp_status" CHECK ("rsvp_status" IS NULL OR "rsvp_status" IN ('dolazim','ne_dolazim'));

ALTER TABLE "sastanak_odluke"
  ADD CONSTRAINT "ck_sastanak_odluke_status" CHECK ("status" IN ('na_snazi','opozvana'));

ALTER TABLE "sastanci_templates"
  ADD CONSTRAINT "ck_sastanci_templates_cadence" CHECK ("cadence" IN ('weekly','biweekly','monthly','daily','none')),
  ADD CONSTRAINT "ck_sastanci_templates_cadence_dow" CHECK ("cadence_dow" IS NULL OR ("cadence_dow" >= 0 AND "cadence_dow" <= 6)),
  ADD CONSTRAINT "ck_sastanci_templates_cadence_dom" CHECK ("cadence_dom" IS NULL OR ("cadence_dom" >= 1 AND "cadence_dom" <= 31));

ALTER TABLE "sastanci_notification_log"
  ADD CONSTRAINT "ck_sastanci_notification_log_channel" CHECK ("channel" IN ('email','whatsapp')),
  ADD CONSTRAINT "ck_sastanci_notification_log_kind" CHECK ("kind" IN ('akcija_new','akcija_changed','meeting_invite','meeting_locked','action_reminder','meeting_reminder','meeting_prep_reminder','meeting_cancel')),
  ADD CONSTRAINT "ck_sastanci_notification_log_status" CHECK ("status" IN ('queued','sent','failed','skipped'));

ALTER TABLE "sastanci_ai_settings"
  ADD CONSTRAINT "ck_sastanci_ai_settings_id" CHECK ("id" = 1);

ALTER TABLE "akcioni_plan"
  ADD CONSTRAINT "ck_akcioni_plan_status" CHECK ("status" IN ('otvoren','u_toku','zavrsen','kasni','odlozen','otkazan')),
  ADD CONSTRAINT "ck_akcioni_plan_prioritet" CHECK ("prioritet" IN (1,2,3));

ALTER TABLE "pm_teme"
  ADD CONSTRAINT "ck_pm_teme_vrsta" CHECK ("vrsta" IN ('tema','problem','predlog','rizik','pitanje')),
  ADD CONSTRAINT "ck_pm_teme_oblast" CHECK ("oblast" IN ('opste','proizvodnja','montaza','nabavka','kadrovi','finansije','kvalitet','klijent','ostalo')),
  ADD CONSTRAINT "ck_pm_teme_status" CHECK ("status" IN ('draft','predlog','usvojeno','odbijeno','odlozeno','zatvoreno')),
  ADD CONSTRAINT "ck_pm_teme_prioritet" CHECK ("prioritet" IN (1,2,3));

ALTER TABLE "presek_aktivnosti"
  ADD CONSTRAINT "ck_presek_aktivnosti_status" CHECK ("status" IN ('planiran','u_toku','zavrsen','blokirano','odlozeno'));

-- Bivši PG enumi `pb_task_vrsta` / `pb_prioritet` / `pb_task_status`.
ALTER TABLE "pb_tasks"
  ADD CONSTRAINT "ck_pb_tasks_vrsta" CHECK ("vrsta" IN ('Projektovanje 3D','Dokumentacija','Nabavka','Algoritam','Montaža')),
  ADD CONSTRAINT "ck_pb_tasks_prioritet" CHECK ("prioritet" IN ('Visok','Srednji','Nizak')),
  ADD CONSTRAINT "ck_pb_tasks_status" CHECK ("status" IN ('Nije počelo','U toku','Pregled','Završeno','Blokirano')),
  ADD CONSTRAINT "ck_pb_tasks_procenat" CHECK ("procenat_zavrsenosti" >= 0 AND "procenat_zavrsenosti" <= 100),
  ADD CONSTRAINT "ck_pb_tasks_norma_sati_dan" CHECK ("norma_sati_dan" >= 1 AND "norma_sati_dan" <= 7);

ALTER TABLE "pb_task_deps"
  ADD CONSTRAINT "ck_pb_task_deps_no_self" CHECK ("task_id" <> "depends_on_task_id");

ALTER TABLE "pb_work_reports"
  ADD CONSTRAINT "ck_pb_work_reports_sati" CHECK ("sati" > 0 AND "sati" <= 24);

-- Bivši PG enum `pb_eng_tip_status`.
ALTER TABLE "pb_eng_tips"
  ADD CONSTRAINT "ck_pb_eng_tips_status" CHECK ("status" IN ('draft','published')),
  ADD CONSTRAINT "ck_pb_eng_tips_naslov" CHECK (length("naslov") >= 3 AND length("naslov") <= 200),
  ADD CONSTRAINT "ck_pb_eng_tips_telo" CHECK (length("telo") >= 10),
  ADD CONSTRAINT "ck_pb_eng_tips_likes_count" CHECK ("likes_count" >= 0),
  ADD CONSTRAINT "ck_pb_eng_tips_views_count" CHECK ("views_count" >= 0);

ALTER TABLE "pb_notification_config"
  ADD CONSTRAINT "ck_pb_notification_config_id" CHECK ("id" = 1);

ALTER TABLE "pb_notification_log"
  ADD CONSTRAINT "ck_pb_notification_log_channel" CHECK ("channel" IN ('email','whatsapp')),
  ADD CONSTRAINT "ck_pb_notification_log_status" CHECK ("status" IN ('pending','processing','sent','failed','dead_letter'));

-- ---------------------------------------------------------------------------
-- 2.2 Generisana kolona (sy15: `pb_eng_tip_files.is_image`)
-- ---------------------------------------------------------------------------
ALTER TABLE "pb_eng_tip_files"
  ADD COLUMN "is_image" BOOLEAN GENERATED ALWAYS AS ("mime_type" LIKE 'image/%') STORED;

-- ---------------------------------------------------------------------------
-- 2.3 Parcijalni i funkcijski indeksi
-- ---------------------------------------------------------------------------

-- Lanac periodičnih sastanaka: jedan sledbenik po prethodniku (parcijalno —
-- NULL-ovi se ne takmiče). Zato je Prisma relacija modelovana kao 1:N.
CREATE UNIQUE INDEX "sastanci_prethodni_sastanak_uq"
  ON "sastanci" ("prethodni_sastanak_id") WHERE "prethodni_sastanak_id" IS NOT NULL;

-- Pretraga po mejlu je case-insensitive (RLS/servis porede lower(email)).
CREATE INDEX "idx_sast_vodio_email_lower" ON "sastanci" (lower("vodio_email"));
CREATE INDEX "idx_sast_zapisnicar_email_lower" ON "sastanci" (lower("zapisnicar_email"));
CREATE INDEX "idx_sast_created_by_email_lower" ON "sastanci" (lower("created_by_email"));
CREATE INDEX "idx_ap_odgovoran_email_lower" ON "akcioni_plan" (lower("odgovoran_email"));
CREATE INDEX "idx_pmt_predlozio_email_lower" ON "pm_teme" (lower("predlozio_email"));

-- Red čekanja obaveštenja sastanaka + brana od duplog podsetnika.
CREATE INDEX "idx_sast_notif_queue"
  ON "sastanci_notification_log" ("status", "next_attempt_at")
  WHERE "status" IN ('queued','failed');
CREATE INDEX "idx_sast_notif_sastanak"
  ON "sastanci_notification_log" ("related_sastanak_id") WHERE "related_sastanak_id" IS NOT NULL;
CREATE INDEX "idx_sast_notif_akcija"
  ON "sastanci_notification_log" ("related_akcija_id") WHERE "related_akcija_id" IS NOT NULL;
-- ⚠️ Ova dva unique-a su JEDINA brana od duplog mejla — bez njih bi ponovni
-- enqueue poslao isti podsetnik dvaput. Prenose se doslovno.
CREATE UNIQUE INDEX "uniq_sast_notif_queued_per_akcija"
  ON "sastanci_notification_log" ("kind", "recipient_email", "related_akcija_id")
  WHERE "status" IN ('queued','sent') AND "related_akcija_id" IS NOT NULL;
CREATE UNIQUE INDEX "uniq_sast_notif_queued_per_event"
  ON "sastanci_notification_log" ("kind", "recipient_email", "related_sastanak_id")
  WHERE "status" IN ('queued','sent') AND "related_akcija_id" IS NULL;

-- PM teme — parcijalni indeksi za tablu.
CREATE INDEX "idx_pm_teme_draft_projekat"
  ON "pm_teme" ("projekat_id", "status") WHERE "status" = 'draft';
CREATE INDEX "idx_pm_teme_hitno" ON "pm_teme" ("hitno") WHERE "hitno" = true;
CREATE INDEX "idx_pm_teme_razmatranje" ON "pm_teme" ("za_razmatranje") WHERE "za_razmatranje" = true;

-- Presek stanja — stavke povezane sa temom.
CREATE INDEX "idx_presek_aktivnosti_tema"
  ON "presek_aktivnosti" ("sastanak_id", "tema_id") WHERE "tema_id" IS NOT NULL;

-- Projektni biro — soft-delete i red čekanja.
CREATE INDEX "idx_ptf_task_active"
  ON "pb_task_files" ("task_id", "uploaded_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "pb_tasks_deleted_at_idx" ON "pb_tasks" ("deleted_at") WHERE "deleted_at" IS NULL;
CREATE INDEX "pb_eng_tips_author_idx" ON "pb_eng_tips" ("author_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "pb_eng_tips_category_idx" ON "pb_eng_tips" ("category_id") WHERE "deleted_at" IS NULL;
CREATE INDEX "pb_eng_tips_created_idx" ON "pb_eng_tips" ("created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "pb_eng_tips_likes_idx" ON "pb_eng_tips" ("likes_count" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "pb_eng_tips_status_idx" ON "pb_eng_tips" ("status") WHERE "deleted_at" IS NULL;
CREATE INDEX "pb_notification_log_scheduled_at_idx"
  ON "pb_notification_log" ("scheduled_at") WHERE "status" = 'pending';
CREATE INDEX "pb_notification_log_status_idx"
  ON "pb_notification_log" ("status") WHERE "status" IN ('pending','failed');

-- ---------------------------------------------------------------------------
-- 2.4 Puno-tekstualna pretraga saveta (`pb_eng_tips.search_tsv`)
--     Kolona + GIN indeks + trigger koji je puni — u sy15 je to radio
--     `pb_eng_tips_search_tsv_sync`; prenosi se doslovno jer je čisto
--     izvedeno stanje (nema poslovnog pravila u sebi).
-- ---------------------------------------------------------------------------
ALTER TABLE "pb_eng_tips" ADD COLUMN "search_tsv" tsvector;
CREATE INDEX "pb_eng_tips_search_idx" ON "pb_eng_tips" USING gin ("search_tsv");
CREATE INDEX "pb_eng_tips_tags_idx" ON "pb_eng_tips" USING gin ("tags");

CREATE OR REPLACE FUNCTION "pb_eng_tips_search_tsv_sync"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
      setweight(to_tsvector('simple', coalesce(NEW.naslov, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.telo, '')), 'B')
   || setweight(to_tsvector('simple', coalesce(array_to_string(NEW.tags, ' '), '')), 'C')
   || setweight(to_tsvector('simple', coalesce(NEW.vendor, '')), 'D');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pb_eng_tips_search_tsv_trg"
  BEFORE INSERT OR UPDATE ON "pb_eng_tips"
  FOR EACH ROW EXECUTE FUNCTION "pb_eng_tips_search_tsv_sync"();

-- ---------------------------------------------------------------------------
-- 2.5 `updated_at` trigeri
--     U sy15 ih drži zajednički `update_updated_at()`. 3.0 ga NEMA (Prisma
--     `@updatedAt` postoji, ali ove tabele pišu i skripta prenosa i sirov SQL),
--     pa se uvodi lokalna funkcija istog ponašanja.
--
--     ⚠️ NAMERNO IZOSTAVLJENI sy15 trigeri (logika, ne mehanika — prepisuje se u
--     NestJS, v. docs/SEOBA_SASTANCI_PB_2026-08-05.md §4):
--       - `sast_check_not_locked` (brana upisa u zaključan sastanak),
--       - `sast_trg_ucesnik_invite` / `_cleanup`, `sast_trg_meeting_locked`,
--         `sast_trg_akcija_new` / `_changed` (enqueue mejlova),
--       - `akcioni_plan_trg_istorija` (revizioni trag),
--       - `pb_task_deps_check_cycle_trg` (brana ciklusa),
--       - `pb_eng_tip_likes_count_sync` (brojač lajkova),
--       - `sast_pm_teme_draft_status_guard`,
--       - `audit_row_change` (opšti audit — 3.0 ima svoj `audit_log`).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "sastanci_pb_touch_updated_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_sastanci_updated" BEFORE UPDATE ON "sastanci"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_sastanak_odluke_updated" BEFORE UPDATE ON "sastanak_odluke"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_sastanci_templates_updated" BEFORE UPDATE ON "sastanci_templates"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_sast_prefs_updated" BEFORE UPDATE ON "sastanci_notification_prefs"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_akcioni_plan_updated" BEFORE UPDATE ON "akcioni_plan"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_pm_teme_updated" BEFORE UPDATE ON "pm_teme"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_presek_aktivnosti_updated" BEFORE UPDATE ON "presek_aktivnosti"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_pb_tasks_updated" BEFORE UPDATE ON "pb_tasks"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_pb_task_comments_updated" BEFORE UPDATE ON "pb_task_comments"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_pb_eng_tips_updated" BEFORE UPDATE ON "pb_eng_tips"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();
CREATE TRIGGER "trg_pb_eng_tip_categories_updated" BEFORE UPDATE ON "pb_eng_tip_categories"
  FOR EACH ROW EXECUTE FUNCTION "sastanci_pb_touch_updated_at"();

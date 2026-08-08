-- Seoba sy15 -> 3.0, KORAK 4: KADROVSKA (HR) (07–08.08.2026)
-- Merenje i runbook: docs/SEOBA_KADROVSKE_2026-08-07.md
-- Plan: docs/PLAN_GASENJA_SY15_2026-08-03.md (korak 4 — najveći preostali domen).
--
-- Generisano OFFLINE: `prisma migrate diff` datamodel->datamodel (origin/main schema
-- -> ova grana), po BACKEND_RULES §12 v0.7. `migrate dev` na produkciji je zabranjen;
-- primenjuje se ISKLJUČIVO `migrate:prod` (deploy) uz prethodni `migrate status`.
--
-- ⚠️ Ova migracija SAMO KREIRA 63 PRAZNE tabele. Podatke prenosi
-- backend/scripts/migrate-kadrovska-sy15.ts (dry-run po difoltu). sy15 se NE dira.
--
-- ⚠️ MODUL KADROVSKA JE ZAMRZNUT (docs/OTVORENI_POSLOVI.md §K). Zamrznute su
-- FUNKCIONALNE izmene; SAMA SEOBA je ono što zamrzavanje ukida i jeste dozvoljena.
-- Nijedan zatečen kvar ovde NIJE popravljen — popisani su u runbook-u §8.
--
-- ── 🔴 63 TABELE, A DOMEN IH IMA 64 ─────────────────────────────────────────
-- Domen je izmeren nad živom sy15 (`count(*)`, `pg_constraint`, `pg_indexes`,
-- `pg_policies`, `pg_trigger`, `pg_get_functiondef` — NIJEDAN broj iz `pg_stat`):
-- 64 tabele / 510.455 redova / 152 MB. U 3.0 nastaje 63 nove, jer:
--
--   1. `departments` (sy15 kadrovska, 13 redova) SUDARA SE po imenu sa BigBit
--      tabelom `departments` koja u 3.0 VEĆ POSTOJI (`model Department`,
--      „Was: BBOdeljenja", izmereno: 1 red — `id=0, code='0'`). To su DVE
--      RAZLIČITE stvari. sy15 verzija se u 3.0 zove `kadr_departments`.
--      🔴 Ovo je JEDINA preimenovana tabela domena i jedini razlog zbog kog
--      spisak „64 imena" ne može doslovno da se primeni na 3.0.
--
--   2. `worker_employee_map` u 3.0 VEĆ POSTOJI (`model WorkerEmployeeMap`,
--      izmereno 79 redova) i drži ISTU logičku vezu (radnik -> `employees.id`).
--      sy15 verzija ima 95 redova. Preklop je izmeren: 71 zajednički ključ,
--      **0 razlika u `employee_id`**, 24 samo u sy15, 8 samo u 3.0 (unija 103).
--      Zato se NE pravi druga tabela — prenosna skripta radi UPSERT u postojeću.
--      (Klasa greške „dva izvora istog podatka" — v. runbook §4.)

-- CreateTable
CREATE TABLE "absences" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'godisnji',
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "days_count" INTEGER,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "paid_reason" TEXT,
    "absence_subtype" TEXT,
    "slobodan_reason" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "archived_by" INTEGER,

    CONSTRAINT "pk_absences" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_answers" (
    "id" UUID NOT NULL,
    "rater_id" UUID NOT NULL,
    "question_code" TEXT NOT NULL,
    "answer_text" TEXT,

    CONSTRAINT "pk_assessment_answers" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_cycles" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "period_label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_assessment_cycles" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_raters" (
    "id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "rater_kind" TEXT NOT NULL,
    "rater_employee_id" UUID,
    "rater_email" TEXT,
    "token" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invited_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_assessment_raters" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_results" (
    "id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "scope_kind" TEXT NOT NULL,
    "ref_id" INTEGER NOT NULL,
    "self_avg" DECIMAL(4,2),
    "peer_avg" DECIMAL(4,2),
    "peer_count" INTEGER NOT NULL DEFAULT 0,
    "leader_val" DECIMAL(4,2),
    "target_val" DECIMAL(4,2),

    CONSTRAINT "pk_assessment_results" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_scores" (
    "id" UUID NOT NULL,
    "rater_id" UUID NOT NULL,
    "competence_id" INTEGER NOT NULL,
    "level" SMALLINT,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_assessment_scores" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_targets" (
    "id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "competence_id" INTEGER NOT NULL,
    "target_level" SMALLINT,

    CONSTRAINT "pk_assessment_targets" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessments" (
    "id" UUID NOT NULL,
    "cycle_id" UUID,
    "employee_id" UUID NOT NULL,
    "plan_id" UUID,
    "profile_id" INTEGER,
    "period_label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "visible_to_employee" BOOLEAN NOT NULL DEFAULT false,
    "opened_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_assessments" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "corrected_in" TIME(6),
    "corrected_out" TIME(6),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_for_self" BOOLEAN NOT NULL DEFAULT true,
    "event_ids" BIGINT[] DEFAULT ARRAY[]::BIGINT[],
    "cancelled_by" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_attendance_corrections" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_events" (
    "id" BIGSERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT,
    "badge_code" TEXT,
    "employee_id" UUID,
    "event_ts" TIMESTAMPTZ(6) NOT NULL,
    "event_ts_local" TIMESTAMP(6),
    "direction" TEXT NOT NULL DEFAULT 'unknown',
    "terminal_id" TEXT,
    "terminal_name" TEXT,
    "raw" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_attendance_events" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attendance_notify_extra" (
    "id" UUID NOT NULL,
    "sub_department_id" INTEGER,
    "email" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_attendance_notify_extra" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competence_groups" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name_sr" TEXT NOT NULL,
    "description_sr" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'strucna',
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "pk_competence_groups" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competence_levels" (
    "id" SERIAL NOT NULL,
    "competence_id" INTEGER NOT NULL,
    "level" SMALLINT NOT NULL,
    "descriptor_sr" TEXT NOT NULL,

    CONSTRAINT "pk_competence_levels" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competence_profiles" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name_sr" TEXT NOT NULL,
    "description_sr" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "pk_competence_profiles" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competence_questions" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER,
    "code" TEXT NOT NULL,
    "text_sr" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pk_competence_questions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competences" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name_sr" TEXT NOT NULL,
    "description_sr" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 100,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "pk_competences" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "contract_type" TEXT NOT NULL DEFAULT 'neodredjeno',
    "contract_number" TEXT DEFAULT '',
    "position" TEXT DEFAULT '',
    "date_from" DATE NOT NULL,
    "date_to" DATE,
    "is_active" BOOLEAN DEFAULT true,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),
    "archived_by" INTEGER,
    "probni_rad" BOOLEAN NOT NULL DEFAULT false,
    "probni_meseci" INTEGER,

    CONSTRAINT "pk_contracts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corrective_measures" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "description_md" TEXT NOT NULL,
    "due_date" DATE,
    "responsible_employee_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'otvoreno',
    "completed_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "escalated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_corrective_measures" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corrective_plans" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "talk_id" UUID,
    "closing_talk_id" UUID,
    "reason_md" TEXT,
    "status" TEXT NOT NULL DEFAULT 'otvoren',
    "followup_date" DATE,
    "followup_notified_at" TIMESTAMPTZ(6),
    "visible_to_employee" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_corrective_plans" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_departments" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "pk_kadr_departments" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "development_checkins" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "checkin_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "author_email" TEXT NOT NULL,
    "author_kind" TEXT NOT NULL DEFAULT 'upravljac',
    "note_md" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_development_checkins" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "development_plans" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_label" TEXT NOT NULL,
    "period_start" DATE,
    "period_end" DATE,
    "career_goal_md" TEXT,
    "target_position_id" INTEGER,
    "mentor_employee_id" UUID,
    "summary_md" TEXT,
    "self_assessment_md" TEXT,
    "status" TEXT NOT NULL DEFAULT 'aktivan',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "pk_development_plans" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_badges" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "badge_type" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "code_short" TEXT,
    "valid_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'katze',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_employee_badges" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_bank_cards" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "bank" TEXT NOT NULL DEFAULT 'Banca Intesa',
    "card_number" TEXT,
    "valid_thru" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_employee_bank_cards" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_children" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "birth_date" DATE,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_employee_children" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_documents" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL DEFAULT 'licna_karta',
    "file_name" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" BIGINT,
    "description" TEXT,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" INTEGER,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_employee_documents" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_expectations" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description_md" TEXT,
    "due_date" DATE,
    "priority" TEXT NOT NULL DEFAULT 'srednja',
    "status" TEXT NOT NULL DEFAULT 'aktivno',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "completion_note" TEXT,
    "plan_id" UUID,
    "category" TEXT NOT NULL DEFAULT 'ostalo',
    "progress" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "pk_employee_expectations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_foreign_docs" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "passport_number" TEXT,
    "passport_expiry" DATE,
    "visa_number" TEXT,
    "visa_expiry" DATE,
    "work_permit_number" TEXT,
    "work_permit_expiry" DATE,
    "residence_permit_number" TEXT,
    "residence_permit_expiry" DATE,
    "residence_address" TEXT,
    "bank_account" TEXT,
    "foreign_id_number" TEXT,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_employee_foreign_docs" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_personal_docs" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "lk_number" TEXT,
    "lk_expiry" DATE,
    "passport_number" TEXT,
    "passport_expiry" DATE,
    "driver_license_number" TEXT,
    "driver_license_expiry" DATE,
    "driver_license_categories" TEXT,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_employee_personal_docs" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_talks" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "talk_type" TEXT NOT NULL,
    "talk_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "title" TEXT,
    "zapisnik_md" TEXT,
    "status" TEXT NOT NULL DEFAULT 'nacrt',
    "conducted_by" TEXT,
    "plan_id" UUID,
    "raise_decision" TEXT,
    "raise_percent" DECIMAL(6,2),
    "raise_effective_from" DATE,
    "raise_note" TEXT,
    "shared_at" TIMESTAMPTZ(6),
    "acknowledged_at" TIMESTAMPTZ(6),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_employee_talks" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "position" TEXT DEFAULT '',
    "department" TEXT DEFAULT '',
    "phone" TEXT DEFAULT '',
    "email" TEXT DEFAULT '',
    "hire_date" DATE,
    "is_active" BOOLEAN DEFAULT true,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "first_name" TEXT,
    "last_name" TEXT,
    "personal_id" TEXT,
    "birth_date" DATE,
    "gender" TEXT,
    "address" TEXT,
    "city" TEXT,
    "postal_code" TEXT,
    "bank_name" TEXT,
    "bank_account" TEXT,
    "phone_private" TEXT,
    "emergency_contact_name" TEXT,
    "emergency_contact_phone" TEXT,
    "slava" TEXT,
    "slava_day" TEXT,
    "education_level" TEXT,
    "education_title" TEXT,
    "medical_exam_date" DATE,
    "medical_exam_expires" DATE,
    "team" TEXT,
    "work_type" TEXT NOT NULL DEFAULT 'ugovor',
    "department_id" INTEGER,
    "sub_department_id" INTEGER,
    "position_id" INTEGER,
    "emergency_contact_relation" TEXT,
    "emergency_contact_phone_alt" TEXT,
    "card_barcode" TEXT,

    CONSTRAINT "pk_employees" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_positions" (
    "id" SERIAL NOT NULL,
    "department_id" INTEGER NOT NULL,
    "sub_department_id" INTEGER,
    "name" TEXT NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "summary_md" TEXT,
    "expectations_md" TEXT,
    "responsibilities_md" TEXT,
    "duties_md" TEXT,
    "profile_updated_at" TIMESTAMPTZ(6),
    "profile_updated_by" TEXT,
    "reports_to_line" TEXT,
    "authority_md" TEXT,
    "kpi_md" TEXT,
    "qualifications_md" TEXT,
    "collaboration_md" TEXT,

    CONSTRAINT "pk_job_positions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_user_id" INTEGER,
    "actor_email" TEXT,
    "action" TEXT NOT NULL,
    "table_name" TEXT NOT NULL,
    "row_id" TEXT,
    "employee_id" UUID,
    "before_data" JSONB,
    "after_data" JSONB,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_audit_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_certificates" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "cert_type" TEXT NOT NULL,
    "cert_name" TEXT NOT NULL,
    "issuer" TEXT,
    "document_no" TEXT,
    "issued_on" DATE NOT NULL,
    "expires_on" DATE,
    "cost_rsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "document_url" TEXT,
    "note" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_certificates" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_document_ack" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "label" TEXT,
    "acked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acked_by" TEXT,

    CONSTRAINT "pk_kadr_document_ack" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_grid_editor_allowlist" (
    "email" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_grid_editor_allowlist" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "kadr_holidays" (
    "id" UUID NOT NULL,
    "holiday_date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "is_workday" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_holidays" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_medical_exams" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "exam_date" DATE NOT NULL,
    "valid_until" DATE,
    "exam_type" TEXT NOT NULL DEFAULT 'redovan',
    "institution" TEXT,
    "cost_rsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "document_url" TEXT,
    "note" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_medical_exams" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_notification_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "medical_lead_days" INTEGER NOT NULL DEFAULT 30,
    "contract_lead_days" INTEGER NOT NULL DEFAULT 30,
    "birthday_enabled" BOOLEAN NOT NULL DEFAULT false,
    "work_anniversary_enabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "email_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "child_birthday_enabled" BOOLEAN NOT NULL DEFAULT false,
    "birthday_oversight_enabled" BOOLEAN NOT NULL DEFAULT true,
    "birthday_digest_enabled" BOOLEAN NOT NULL DEFAULT true,
    "lk_lead_days" INTEGER NOT NULL DEFAULT 30,
    "passport_lead_days" INTEGER NOT NULL DEFAULT 180,
    "driver_license_lead_days" INTEGER NOT NULL DEFAULT 30,
    "medical_emp_lead_days" INTEGER NOT NULL DEFAULT 15,

    CONSTRAINT "pk_kadr_notification_config" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_notification_log" (
    "id" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL DEFAULT '',
    "related_entity_type" TEXT NOT NULL,
    "related_entity_id" TEXT,
    "employee_id" UUID,
    "notification_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "payload" JSONB DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_notification_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_onboarding_runs" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "template_id" UUID,
    "kind" TEXT NOT NULL DEFAULT 'onboarding',
    "start_date" DATE NOT NULL DEFAULT CURRENT_DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "pk_kadr_onboarding_runs" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_onboarding_tasks" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "due_date" DATE,
    "assignee_hint" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "done_at" TIMESTAMPTZ(6),
    "done_by" TEXT,
    "note" TEXT,

    CONSTRAINT "pk_kadr_onboarding_tasks" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_onboarding_template_items" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "offset_days" INTEGER NOT NULL DEFAULT 0,
    "assignee_hint" TEXT,

    CONSTRAINT "pk_kadr_onboarding_template_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_onboarding_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'onboarding',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "pk_kadr_onboarding_templates" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_salary_viewer_allowlist" (
    "email" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_salary_viewer_allowlist" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "kadr_vacation_editor_allowlist" (
    "email" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_vacation_editor_allowlist" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "katze_employee_map" (
    "katze_id" TEXT NOT NULL,
    "katze_ime" TEXT,
    "katze_prezime" TEXT,
    "katze_sektor" TEXT,
    "employee_id" UUID,
    "match_method" TEXT,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_katze_employee_map" PRIMARY KEY ("katze_id")
);

-- CreateTable
CREATE TABLE "makeup_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "absence_date" DATE NOT NULL,
    "absence_hours" DECIMAL(4,1) NOT NULL DEFAULT 8,
    "reason" TEXT NOT NULL DEFAULT '',
    "makeup_plan" TEXT NOT NULL DEFAULT '',
    "makeup_deadline" DATE,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "level1_by" TEXT,
    "level1_at" TIMESTAMPTZ(6),
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "completed_by" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "rejection_note" TEXT,
    "submitted_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "compensation_type" TEXT NOT NULL DEFAULT 'nadoknada',
    "weekend_work_date" DATE,
    "storno_by" TEXT,
    "storno_at" TIMESTAMPTZ(6),
    "storno_note" TEXT,

    CONSTRAINT "pk_makeup_requests" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nop_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_nop_requests" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paid_leave_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "leave_type" TEXT NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "days_count" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL DEFAULT '',
    "proof_note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "level1_by" TEXT,
    "level1_at" TIMESTAMPTZ(6),
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_note" TEXT,
    "submitted_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_paid_leave_requests" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_groups" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "group_id" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 100,

    CONSTRAINT "pk_profile_groups" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_positions" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "position_id" INTEGER NOT NULL,

    CONSTRAINT "pk_profile_positions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_payroll" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_year" INTEGER NOT NULL,
    "period_month" INTEGER NOT NULL,
    "salary_type" TEXT NOT NULL DEFAULT 'ugovor',
    "advance_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advance_paid_on" DATE,
    "advance_note" TEXT DEFAULT '',
    "fixed_salary" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "hours_worked" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "hourly_rate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "transport_rsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "domestic_days" INTEGER NOT NULL DEFAULT 0,
    "per_diem_rsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "foreign_days" INTEGER NOT NULL DEFAULT 0,
    "per_diem_eur" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "total_rsd" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_eur" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "second_part_rsd" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "final_paid_on" DATE,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "note" TEXT DEFAULT '',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "compensation_model" TEXT,
    "fond_sati_meseca" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "redovan_rad_sati" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "prekovremeni_sati" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "praznik_placeni_sati" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "praznik_rad_sati" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "godisnji_sati" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "slobodni_dani_sati" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "bolovanje_65_sati" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "bolovanje_100_sati" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "dve_masine_sati" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "teren_u_zemlji_count" INTEGER NOT NULL DEFAULT 0,
    "teren_u_inostranstvu_count" INTEGER NOT NULL DEFAULT 0,
    "payable_hours" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "ukupna_zarada" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "prvi_deo" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "preostalo_za_isplatu" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "warnings" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "pk_salary_payroll" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_terms" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "salary_type" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amount_type" TEXT NOT NULL DEFAULT 'neto',
    "currency" TEXT NOT NULL DEFAULT 'RSD',
    "hourly_rate" DECIMAL(12,2),
    "contract_ref" TEXT,
    "note" TEXT DEFAULT '',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "transport_allowance_rsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "per_diem_rsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "per_diem_eur" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "compensation_model" TEXT,
    "fixed_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fixed_transport_component" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fixed_extra_hour_rate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "first_part_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "split_hour_rate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "split_transport_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "hourly_transport_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "terrain_domestic_rate" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "terrain_foreign_rate" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "neto_rsd" DECIMAL,
    "bruto_rsd" DECIMAL,
    "approved_by" TEXT,
    "approved_at" DATE,
    "fixed_no_extra_hours" BOOLEAN NOT NULL DEFAULT false,
    "payment_window_override" TEXT,
    "payroll_group" TEXT NOT NULL DEFAULT 'standard',
    "cash_allowance_rsd" DECIMAL NOT NULL DEFAULT 0,

    CONSTRAINT "pk_salary_terms" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_departments" (
    "id" SERIAL NOT NULL,
    "department_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "pk_sub_departments" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacation_bonus_days" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "days" DECIMAL NOT NULL DEFAULT 1,
    "work_date" DATE,
    "reason" TEXT NOT NULL DEFAULT '',
    "makeup_request_id" UUID,
    "added_by" TEXT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_vacation_bonus_days" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacation_change_requests" (
    "id" UUID NOT NULL,
    "vacation_request_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "new_date_from" DATE,
    "new_date_to" DATE,
    "new_days_count" INTEGER,
    "old_date_from" DATE NOT NULL,
    "old_date_to" DATE NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "submitted_by" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_vacation_change_requests" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacation_entitlements" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "days_total" INTEGER NOT NULL DEFAULT 20,
    "days_carried_over" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "review_flag" TEXT,
    "source" TEXT,
    "opening_used" INTEGER NOT NULL DEFAULT 0,
    "accrual_model" BOOLEAN NOT NULL DEFAULT false,
    "accrual_base" INTEGER NOT NULL DEFAULT 20,
    "accrual_start" DATE,
    "advance_approved" BOOLEAN NOT NULL DEFAULT false,
    "advance_approved_by" TEXT,
    "advance_approved_at" TIMESTAMPTZ(6),
    "advance_note" TEXT,

    CONSTRAINT "pk_vacation_entitlements" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacation_go_days" (
    "employee_id" UUID NOT NULL,
    "used_date" DATE NOT NULL,
    "source_year" INTEGER,
    "comment" TEXT,

    CONSTRAINT "pk_vacation_go_days" PRIMARY KEY ("employee_id","used_date")
);

-- CreateTable
CREATE TABLE "vacation_history" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "entitled_days" INTEGER,
    "used_days" INTEGER,
    "remaining_days" INTEGER,
    "entries" JSONB NOT NULL DEFAULT '[]',
    "raw_block" TEXT,
    "source" TEXT NOT NULL DEFAULT 'excel_godisnji',
    "source_file" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_vacation_history" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacation_requests" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "days_count" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "rejection_note" TEXT,
    "submitted_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level1_by" TEXT,
    "level1_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_vacation_requests" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_hours" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "work_date" DATE NOT NULL,
    "hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "overtime_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "project_ref" TEXT DEFAULT '',
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "field_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "absence_code" TEXT,
    "two_machine_hours" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "field_subtype" TEXT,
    "absence_subtype" TEXT,
    "last_edited_by" TEXT,
    "field_predmet_broj" TEXT,
    "field_predmet_naziv" TEXT,

    CONSTRAINT "pk_work_hours" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_hours_remarks" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_work_hours_remarks" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "aa_uniq" ON "assessment_answers"("rater_id", "question_code");

-- CreateIndex
CREATE UNIQUE INDEX "assessment_raters_token_key" ON "assessment_raters"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ares_uniq" ON "assessment_results"("assessment_id", "scope_kind", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "asc_uniq" ON "assessment_scores"("rater_id", "competence_id");

-- CreateIndex
CREATE UNIQUE INDEX "at_uniq" ON "assessment_targets"("assessment_id", "competence_id");

-- CreateIndex
CREATE UNIQUE INDEX "competence_groups_code_key" ON "competence_groups"("code");

-- CreateIndex
CREATE UNIQUE INDEX "cl_uniq" ON "competence_levels"("competence_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "competence_profiles_code_key" ON "competence_profiles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "competence_questions_code_key" ON "competence_questions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "competences_code_key" ON "competences"("code");

-- CreateIndex
CREATE UNIQUE INDEX "employee_badges_badge_type_code_employee_id_key" ON "employee_badges"("badge_type", "code", "employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_documents_storage_path_key" ON "employee_documents"("storage_path");

-- CreateIndex
CREATE UNIQUE INDEX "employee_foreign_docs_employee_id_key" ON "employee_foreign_docs"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_personal_docs_employee_id_key" ON "employee_personal_docs"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_full_name_unique" ON "employees"("full_name");

-- CreateIndex
CREATE UNIQUE INDEX "kadr_document_ack_employee_id_ref_type_ref_id_key" ON "kadr_document_ack"("employee_id", "ref_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "kadr_holidays_date_unique" ON "kadr_holidays"("holiday_date");

-- CreateIndex
CREATE UNIQUE INDEX "pg_uniq" ON "profile_groups"("profile_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "pp_uniq" ON "profile_positions"("position_id");

-- CreateIndex
CREATE UNIQUE INDEX "salary_payroll_employee_id_period_year_period_month_key" ON "salary_payroll"("employee_id", "period_year", "period_month");

-- CreateIndex
CREATE UNIQUE INDEX "vacation_entitlements_uniq" ON "vacation_entitlements"("employee_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "vacation_history_uq" ON "vacation_history"("employee_id", "year", "source");

-- CreateIndex
CREATE UNIQUE INDEX "work_hours_emp_date_uq" ON "work_hours"("employee_id", "work_date");

-- CreateIndex
CREATE UNIQUE INDEX "work_hours_remarks_employee_id_year_month_key" ON "work_hours_remarks"("employee_id", "year", "month");

-- AddForeignKey
ALTER TABLE "absences" ADD CONSTRAINT "absences_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_answers" ADD CONSTRAINT "assessment_answers_rater_id_fkey" FOREIGN KEY ("rater_id") REFERENCES "assessment_raters"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_raters" ADD CONSTRAINT "assessment_raters_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_raters" ADD CONSTRAINT "assessment_raters_rater_employee_id_fkey" FOREIGN KEY ("rater_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_results" ADD CONSTRAINT "assessment_results_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_competence_id_fkey" FOREIGN KEY ("competence_id") REFERENCES "competences"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_scores" ADD CONSTRAINT "assessment_scores_rater_id_fkey" FOREIGN KEY ("rater_id") REFERENCES "assessment_raters"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_targets" ADD CONSTRAINT "assessment_targets_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_targets" ADD CONSTRAINT "assessment_targets_competence_id_fkey" FOREIGN KEY ("competence_id") REFERENCES "competences"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "assessment_cycles"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "development_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "competence_profiles"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competence_levels" ADD CONSTRAINT "competence_levels_competence_id_fkey" FOREIGN KEY ("competence_id") REFERENCES "competences"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competence_questions" ADD CONSTRAINT "competence_questions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "competence_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competences" ADD CONSTRAINT "competences_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "competence_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_measures" ADD CONSTRAINT "corrective_measures_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "corrective_plans"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_measures" ADD CONSTRAINT "corrective_measures_responsible_employee_id_fkey" FOREIGN KEY ("responsible_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_plans" ADD CONSTRAINT "corrective_plans_closing_talk_id_fkey" FOREIGN KEY ("closing_talk_id") REFERENCES "employee_talks"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_plans" ADD CONSTRAINT "corrective_plans_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_plans" ADD CONSTRAINT "corrective_plans_talk_id_fkey" FOREIGN KEY ("talk_id") REFERENCES "employee_talks"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_checkins" ADD CONSTRAINT "development_checkins_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_checkins" ADD CONSTRAINT "development_checkins_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "development_plans"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_mentor_employee_id_fkey" FOREIGN KEY ("mentor_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_plans" ADD CONSTRAINT "development_plans_target_position_id_fkey" FOREIGN KEY ("target_position_id") REFERENCES "job_positions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_badges" ADD CONSTRAINT "employee_badges_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_bank_cards" ADD CONSTRAINT "employee_bank_cards_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_children" ADD CONSTRAINT "employee_children_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_expectations" ADD CONSTRAINT "employee_expectations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_expectations" ADD CONSTRAINT "employee_expectations_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "development_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_foreign_docs" ADD CONSTRAINT "employee_foreign_docs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_personal_docs" ADD CONSTRAINT "employee_personal_docs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_talks" ADD CONSTRAINT "employee_talks_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_talks" ADD CONSTRAINT "employee_talks_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "development_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "kadr_departments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "job_positions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_sub_department_id_fkey" FOREIGN KEY ("sub_department_id") REFERENCES "sub_departments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_positions" ADD CONSTRAINT "job_positions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "kadr_departments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_positions" ADD CONSTRAINT "job_positions_sub_department_id_fkey" FOREIGN KEY ("sub_department_id") REFERENCES "sub_departments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_certificates" ADD CONSTRAINT "kadr_certificates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_document_ack" ADD CONSTRAINT "kadr_document_ack_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_medical_exams" ADD CONSTRAINT "kadr_medical_exams_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_notification_log" ADD CONSTRAINT "kadr_notification_log_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_onboarding_runs" ADD CONSTRAINT "kadr_onboarding_runs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_onboarding_runs" ADD CONSTRAINT "kadr_onboarding_runs_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "kadr_onboarding_templates"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_onboarding_tasks" ADD CONSTRAINT "kadr_onboarding_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "kadr_onboarding_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_onboarding_template_items" ADD CONSTRAINT "kadr_onboarding_template_items_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "kadr_onboarding_templates"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "katze_employee_map" ADD CONSTRAINT "katze_employee_map_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "nop_requests" ADD CONSTRAINT "nop_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "paid_leave_requests" ADD CONSTRAINT "paid_leave_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_groups" ADD CONSTRAINT "profile_groups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "competence_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_groups" ADD CONSTRAINT "profile_groups_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "competence_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_positions" ADD CONSTRAINT "profile_positions_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "job_positions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_positions" ADD CONSTRAINT "profile_positions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "competence_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "salary_payroll" ADD CONSTRAINT "salary_payroll_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "sub_departments" ADD CONSTRAINT "sub_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "kadr_departments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_bonus_days" ADD CONSTRAINT "vacation_bonus_days_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_change_requests" ADD CONSTRAINT "vacation_change_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_change_requests" ADD CONSTRAINT "vacation_change_requests_vacation_request_id_fkey" FOREIGN KEY ("vacation_request_id") REFERENCES "vacation_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_entitlements" ADD CONSTRAINT "vacation_entitlements_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_history" ADD CONSTRAINT "vacation_history_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vacation_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_hours_remarks" ADD CONSTRAINT "work_hours_remarks_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 4a. CHECK ograničenja (110 u sy15) — `prisma migrate diff` ih ne generiše.
--     Prepisana su DOSLOVNO sa žive baze (`pg_get_constraintdef`), bez tumačenja:
--     domen NEMA nijedan PG enum (izmereno: 0), sve vrednosti statusa čuva CHECK.
-- ---------------------------------------------------------------------------
ALTER TABLE "absences" ADD CONSTRAINT "absences_absence_subtype_chk" CHECK (((absence_subtype IS NULL) OR (absence_subtype = ANY (ARRAY['obicno'::text, 'povreda_na_radu'::text, 'odrzavanje_trudnoce'::text]))));
ALTER TABLE "absences" ADD CONSTRAINT "absences_dates_valid" CHECK ((date_to >= date_from));
ALTER TABLE "absences" ADD CONSTRAINT "absences_paid_reason_check" CHECK (((paid_reason IS NULL) OR (paid_reason = ANY (ARRAY['rodjenje'::text, 'svadba'::text, 'smrt'::text, 'selidba'::text, 'ostalo'::text]))));
ALTER TABLE "absences" ADD CONSTRAINT "absences_slobodan_reason_chk" CHECK (((slobodan_reason IS NULL) OR (slobodan_reason = ANY (ARRAY['brak'::text, 'rodjenje_deteta'::text, 'selidba'::text, 'smrt_clana_porodice'::text, 'dobrovoljno_davanje_krvi'::text, 'slava'::text, 'ostalo'::text]))));
ALTER TABLE "absences" ADD CONSTRAINT "absences_subtype_consistency_chk" CHECK ((((absence_subtype IS NULL) OR (type = 'bolovanje'::text)) AND ((slobodan_reason IS NULL) OR (type = ANY (ARRAY['slobodan'::text, 'placeno'::text])))));
ALTER TABLE "absences" ADD CONSTRAINT "absences_type_check_v2" CHECK ((type = ANY (ARRAY['godisnji'::text, 'bolovanje'::text, 'slobodan'::text, 'placeno'::text, 'neplaceno'::text, 'sluzbeno'::text, 'slava'::text, 'ostalo'::text])));
ALTER TABLE "assessment_cycles" ADD CONSTRAINT "ac_status_chk" CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'closed'::text])));
ALTER TABLE "assessment_raters" ADD CONSTRAINT "ar_kind_chk" CHECK ((rater_kind = ANY (ARRAY['self'::text, 'peer'::text, 'leader'::text])));
ALTER TABLE "assessment_raters" ADD CONSTRAINT "ar_status_chk" CHECK ((status = ANY (ARRAY['pending'::text, 'submitted'::text])));
ALTER TABLE "assessment_results" ADD CONSTRAINT "ares_scope_chk" CHECK ((scope_kind = ANY (ARRAY['group'::text, 'competence'::text])));
ALTER TABLE "assessment_scores" ADD CONSTRAINT "asc_level_chk" CHECK (((level IS NULL) OR ((level >= 0) AND (level <= 5))));
ALTER TABLE "assessment_targets" ADD CONSTRAINT "at_level_chk" CHECK (((target_level IS NULL) OR ((target_level >= 0) AND (target_level <= 5))));
ALTER TABLE "assessments" ADD CONSTRAINT "as_status_chk" CHECK ((status = ANY (ARRAY['draft'::text, 'collecting'::text, 'closed'::text, 'shared'::text])));
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_reason_check" CHECK ((length(btrim(reason)) >= 5));
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "attendance_corrections_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text])));
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_direction_check" CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text, 'break'::text, 'official_out'::text, 'other'::text, 'unknown'::text])));
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_source_check" CHECK ((source = ANY (ARRAY['katze'::text, 'katze_manual'::text, 'phone'::text, 'reader'::text, 'face'::text, 'manual'::text, 'kiosk'::text])));
ALTER TABLE "competence_groups" ADD CONSTRAINT "cg_scope_chk" CHECK ((scope = ANY (ARRAY['core'::text, 'strucna'::text, 'liderska'::text])));
ALTER TABLE "competence_levels" ADD CONSTRAINT "cl_level_chk" CHECK (((level >= 0) AND (level <= 5)));
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_contract_type_check" CHECK ((contract_type = ANY (ARRAY['neodredjeno'::text, 'odredjeno'::text, 'privremeno'::text, 'delo'::text, 'student'::text, 'praksa'::text, 'probni'::text, 'ostalo'::text])));
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_dates_valid" CHECK (((date_to IS NULL) OR (date_to >= date_from)));
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_probni_meseci_chk" CHECK (((probni_meseci IS NULL) OR ((probni_meseci >= 1) AND (probni_meseci <= 6))));
ALTER TABLE "corrective_measures" ADD CONSTRAINT "corrective_measures_status_check" CHECK ((status = ANY (ARRAY['otvoreno'::text, 'u_toku'::text, 'ispunjeno'::text, 'neispunjeno'::text])));
ALTER TABLE "corrective_plans" ADD CONSTRAINT "corrective_plans_status_check" CHECK ((status = ANY (ARRAY['otvoren'::text, 'u_toku'::text, 'zatvoren_uspesno'::text, 'zatvoren_neuspesno'::text])));
ALTER TABLE "development_checkins" ADD CONSTRAINT "dc_kind_chk" CHECK ((author_kind = ANY (ARRAY['upravljac'::text, 'zaposleni'::text])));
ALTER TABLE "development_checkins" ADD CONSTRAINT "dc_note_chk" CHECK ((length(TRIM(BOTH FROM note_md)) > 0));
ALTER TABLE "development_plans" ADD CONSTRAINT "dp_period_chk" CHECK ((length(TRIM(BOTH FROM period_label)) > 0));
ALTER TABLE "development_plans" ADD CONSTRAINT "dp_status_chk" CHECK ((status = ANY (ARRAY['nacrt'::text, 'aktivan'::text, 'zavrsen'::text, 'arhiviran'::text])));
ALTER TABLE "employee_badges" ADD CONSTRAINT "employee_badges_badge_type_check" CHECK ((badge_type = ANY (ARRAY['media'::text, 'card'::text, 'qr'::text, 'face'::text])));
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_doc_type_check" CHECK ((doc_type = ANY (ARRAY['licna_karta'::text, 'pasos'::text, 'vozacka'::text, 'diploma'::text, 'ugovor'::text, 'ugovor_skan'::text, 'lekarski'::text, 'other'::text, 'aneks'::text, 'resenje_go'::text, 'resenje_porodiljsko'::text, 'potvrda_zaposlenje'::text, 'potvrda_primanja'::text, 'karnet'::text, 'evidencija_go'::text, 'sporazumni_raskid'::text])));
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_file_name_nonempty" CHECK ((length(TRIM(BOTH FROM file_name)) > 0));
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_storage_path_nonempty" CHECK ((length(TRIM(BOTH FROM storage_path)) > 0));
ALTER TABLE "employee_expectations" ADD CONSTRAINT "ee_category_chk" CHECK ((category = ANY (ARRAY['strucni'::text, 'sertifikat'::text, 'soft_skill'::text, 'liderstvo'::text, 'ostalo'::text])));
ALTER TABLE "employee_expectations" ADD CONSTRAINT "ee_priority_chk" CHECK ((priority = ANY (ARRAY['niska'::text, 'srednja'::text, 'visoka'::text])));
ALTER TABLE "employee_expectations" ADD CONSTRAINT "ee_progress_chk" CHECK (((progress >= 0) AND (progress <= 100)));
ALTER TABLE "employee_expectations" ADD CONSTRAINT "ee_status_chk" CHECK ((status = ANY (ARRAY['aktivno'::text, 'u_toku'::text, 'ispunjeno'::text, 'otkazano'::text])));
ALTER TABLE "employee_expectations" ADD CONSTRAINT "ee_title_chk" CHECK ((length(TRIM(BOTH FROM title)) > 0));
ALTER TABLE "employee_talks" ADD CONSTRAINT "employee_talks_raise_decision_check" CHECK ((raise_decision = ANY (ARRAY['da'::text, 'ne'::text, 'odlozeno'::text])));
ALTER TABLE "employee_talks" ADD CONSTRAINT "employee_talks_status_check" CHECK ((status = ANY (ARRAY['nacrt'::text, 'podeljen'::text, 'potvrdjen'::text])));
ALTER TABLE "employee_talks" ADD CONSTRAINT "employee_talks_talk_type_check" CHECK ((talk_type = ANY (ARRAY['godisnji'::text, 'korektivni'::text, 'jedan_na_jedan'::text, 'ostalo'::text])));
ALTER TABLE "employees" ADD CONSTRAINT "employees_gender_check" CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['M'::text, 'Z'::text]))));
ALTER TABLE "employees" ADD CONSTRAINT "employees_personal_id_check" CHECK (((personal_id IS NULL) OR (personal_id ~ '^[0-9]{13}$'::text)));
ALTER TABLE "employees" ADD CONSTRAINT "employees_slava_day_check" CHECK (((slava_day IS NULL) OR (slava_day ~ '^[0-9]{4}$'::text)));
ALTER TABLE "employees" ADD CONSTRAINT "employees_work_type_check" CHECK ((work_type = ANY (ARRAY['ugovor'::text, 'praksa'::text, 'dualno'::text, 'penzioner'::text])));
ALTER TABLE "kadr_audit_log" ADD CONSTRAINT "kadr_audit_action_chk" CHECK ((action = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text])));
ALTER TABLE "kadr_certificates" ADD CONSTRAINT "kadr_certificates_cost_chk" CHECK ((cost_rsd >= (0)::numeric));
ALTER TABLE "kadr_certificates" ADD CONSTRAINT "kadr_certificates_dates_chk" CHECK (((expires_on IS NULL) OR (expires_on >= issued_on)));
ALTER TABLE "kadr_medical_exams" ADD CONSTRAINT "kadr_medical_exams_cost_chk" CHECK ((cost_rsd >= (0)::numeric));
ALTER TABLE "kadr_medical_exams" ADD CONSTRAINT "kadr_medical_exams_dates_chk" CHECK (((valid_until IS NULL) OR (valid_until >= exam_date)));
ALTER TABLE "kadr_medical_exams" ADD CONSTRAINT "kadr_medical_exams_type_chk" CHECK ((exam_type = ANY (ARRAY['redovan'::text, 'prethodni'::text, 'periodicni'::text, 'ciljani'::text, 'vanredni'::text])));
ALTER TABLE "kadr_notification_config" ADD CONSTRAINT "kadr_notification_config_id_check" CHECK ((id = 1));
ALTER TABLE "kadr_notification_log" ADD CONSTRAINT "kadr_notif_channel_chk" CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'email'::text, 'sms'::text])));
ALTER TABLE "kadr_notification_log" ADD CONSTRAINT "kadr_notif_status_chk" CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'failed'::text, 'canceled'::text])));
ALTER TABLE "kadr_notification_log" ADD CONSTRAINT "kadr_notif_type_chk" CHECK ((notification_type = ANY (ARRAY['medical_expiring'::text, 'contract_expiring'::text, 'contract_expiring_today'::text, 'birthday'::text, 'work_anniversary'::text, 'child_birthday'::text, 'birthday_oversight'::text, 'birthday_digest'::text, 'vacation_submitted'::text, 'vacation_approved'::text, 'vacation_rejected'::text, 'vacation_rescheduled'::text, 'vacation_sef_approved'::text, 'makeup_submitted'::text, 'makeup_sef_approved'::text, 'makeup_approved'::text, 'makeup_rejected'::text, 'paidleave_submitted'::text, 'paidleave_sef_approved'::text, 'paidleave_approved'::text, 'paidleave_rejected'::text, 'nop_requested'::text, 'nop_decided'::text, 'payroll_statement'::text, 'account_invite'::text, 'document_issued'::text, 'onboarding_due'::text, 'foreign_doc_expiring'::text, 'foreign_doc_expiring_today'::text, 'bank_card_expiring'::text, 'bank_card_expiring_today'::text, 'talk_shared'::text, 'corrective_overdue'::text, 'corrective_followup'::text, 'personal_doc_expiring'::text, 'personal_doc_expiring_today'::text, 'attendance_missing_punch'::text, 'attendance_correction'::text, 'attendance_weekly_digest'::text])));
ALTER TABLE "kadr_onboarding_runs" ADD CONSTRAINT "kadr_onboarding_runs_kind_check" CHECK ((kind = ANY (ARRAY['onboarding'::text, 'offboarding'::text])));
ALTER TABLE "kadr_onboarding_runs" ADD CONSTRAINT "kadr_onboarding_runs_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'done'::text, 'canceled'::text])));
ALTER TABLE "kadr_onboarding_tasks" ADD CONSTRAINT "kadr_onboarding_tasks_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'skipped'::text])));
ALTER TABLE "kadr_onboarding_templates" ADD CONSTRAINT "kadr_onboarding_templates_kind_check" CHECK ((kind = ANY (ARRAY['onboarding'::text, 'offboarding'::text])));
ALTER TABLE "katze_employee_map" ADD CONSTRAINT "katze_employee_map_match_method_check" CHECK ((match_method = ANY (ARRAY['auto_exact'::text, 'auto_fuzzy'::text, 'manual'::text])));
ALTER TABLE "makeup_requests" ADD CONSTRAINT "makeup_comp_type_chk" CHECK ((compensation_type = ANY (ARRAY['nadoknada'::text, 'dan_odmora'::text])));
ALTER TABLE "makeup_requests" ADD CONSTRAINT "mu_hours_chk" CHECK (((absence_hours > (0)::numeric) AND (absence_hours <= (24)::numeric)));
ALTER TABLE "makeup_requests" ADD CONSTRAINT "mu_status_chk" CHECK ((status = ANY (ARRAY['pending'::text, 'sef_approved'::text, 'approved'::text, 'completed'::text, 'rejected'::text, 'storniran'::text])));
ALTER TABLE "nop_requests" ADD CONSTRAINT "nop_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE "paid_leave_requests" ADD CONSTRAINT "pl_dates_chk" CHECK ((date_to >= date_from));
ALTER TABLE "paid_leave_requests" ADD CONSTRAINT "pl_days_chk" CHECK ((days_count >= 0));
ALTER TABLE "paid_leave_requests" ADD CONSTRAINT "pl_status_chk" CHECK ((status = ANY (ARRAY['pending'::text, 'sef_approved'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE "paid_leave_requests" ADD CONSTRAINT "pl_type_chk" CHECK ((leave_type = ANY (ARRAY['brak'::text, 'rodjenje_deteta'::text, 'bolest_uze'::text, 'porodjaj_drugi'::text, 'smrt_uze'::text, 'smrt_sire'::text, 'selidba'::text, 'selidba_drugo'::text, 'nepogoda'::text, 'ispit'::text, 'krv'::text, 'ostalo'::text])));
ALTER TABLE "salary_payroll" ADD CONSTRAINT "salary_payroll_month_chk" CHECK (((period_month >= 1) AND (period_month <= 12)));
ALTER TABLE "salary_payroll" ADD CONSTRAINT "salary_payroll_nonneg_chk" CHECK (((advance_amount >= (0)::numeric) AND (fixed_salary >= (0)::numeric) AND (hours_worked >= (0)::numeric) AND (hourly_rate >= (0)::numeric) AND (transport_rsd >= (0)::numeric) AND (domestic_days >= 0) AND (per_diem_rsd >= (0)::numeric) AND (foreign_days >= 0) AND (per_diem_eur >= (0)::numeric)));
ALTER TABLE "salary_payroll" ADD CONSTRAINT "salary_payroll_status_chk" CHECK ((status = ANY (ARRAY['draft'::text, 'advance_paid'::text, 'finalized'::text, 'paid'::text])));
ALTER TABLE "salary_payroll" ADD CONSTRAINT "salary_payroll_type_chk" CHECK ((salary_type = ANY (ARRAY['ugovor'::text, 'dogovor'::text, 'satnica'::text])));
ALTER TABLE "salary_payroll" ADD CONSTRAINT "salary_payroll_v2_comp_model_chk" CHECK (((compensation_model IS NULL) OR (compensation_model = ANY (ARRAY['fiksno'::text, 'dva_dela'::text, 'satnica'::text, 'jednokratno'::text, 'praksa'::text]))));
ALTER TABLE "salary_payroll" ADD CONSTRAINT "salary_payroll_v2_nonneg_chk" CHECK (((fond_sati_meseca >= (0)::numeric) AND (redovan_rad_sati >= (0)::numeric) AND (prekovremeni_sati >= (0)::numeric) AND (praznik_placeni_sati >= (0)::numeric) AND (praznik_rad_sati >= (0)::numeric) AND (godisnji_sati >= (0)::numeric) AND (slobodni_dani_sati >= (0)::numeric) AND (bolovanje_65_sati >= (0)::numeric) AND (bolovanje_100_sati >= (0)::numeric) AND (dve_masine_sati >= (0)::numeric) AND (teren_u_zemlji_count >= 0) AND (teren_u_inostranstvu_count >= 0) AND (payable_hours >= (0)::numeric)));
ALTER TABLE "salary_payroll" ADD CONSTRAINT "salary_payroll_year_chk" CHECK (((period_year >= 2000) AND (period_year <= 2100)));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_amount_chk" CHECK ((amount >= (0)::numeric));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_amount_type_chk" CHECK ((amount_type = ANY (ARRAY['neto'::text, 'bruto'::text])));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_cash_nonneg_chk" CHECK ((cash_allowance_rsd >= (0)::numeric));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_compensation_model_chk" CHECK (((compensation_model IS NULL) OR (compensation_model = ANY (ARRAY['fiksno'::text, 'dva_dela'::text, 'satnica'::text, 'jednokratno'::text, 'praksa'::text]))));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_currency_chk" CHECK ((currency = ANY (ARRAY['RSD'::text, 'EUR'::text, 'USD'::text])));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_dates_chk" CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_extras_nonneg_chk" CHECK (((transport_allowance_rsd >= (0)::numeric) AND (per_diem_rsd >= (0)::numeric) AND (per_diem_eur >= (0)::numeric)));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_pay_window_chk" CHECK (((payment_window_override IS NULL) OR (payment_window_override = ANY (ARRAY['01_05'::text, '15_20'::text]))));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_payroll_group_chk" CHECK ((payroll_group = ANY (ARRAY['standard'::text, 'olaksice'::text, 'razvoj'::text, 'stranci'::text, 'hapfluid'::text, 'kes'::text])));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_type_chk" CHECK ((salary_type = ANY (ARRAY['ugovor'::text, 'dogovor'::text, 'satnica'::text])));
ALTER TABLE "salary_terms" ADD CONSTRAINT "salary_terms_v2_nonneg_chk" CHECK (((fixed_amount >= (0)::numeric) AND (fixed_transport_component >= (0)::numeric) AND (fixed_extra_hour_rate >= (0)::numeric) AND (first_part_amount >= (0)::numeric) AND (split_hour_rate >= (0)::numeric) AND (split_transport_amount >= (0)::numeric) AND (hourly_transport_amount >= (0)::numeric) AND (terrain_domestic_rate >= (0)::numeric) AND (terrain_foreign_rate >= (0)::numeric)));
ALTER TABLE "vacation_bonus_days" ADD CONSTRAINT "vacation_bonus_days_days_check" CHECK (((days > (0)::numeric) AND (days <= (5)::numeric)));
ALTER TABLE "vacation_change_requests" ADD CONSTRAINT "vacation_change_requests_kind_check" CHECK ((kind = ANY (ARRAY['cancel'::text, 'revise'::text])));
ALTER TABLE "vacation_change_requests" ADD CONSTRAINT "vacation_change_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE "vacation_change_requests" ADD CONSTRAINT "vcr_revise_has_dates" CHECK (((kind <> 'revise'::text) OR ((new_date_from IS NOT NULL) AND (new_date_to IS NOT NULL) AND (new_date_to >= new_date_from) AND (COALESCE(new_days_count, 0) > 0))));
ALTER TABLE "vacation_entitlements" ADD CONSTRAINT "vac_ent_accrual_base_chk" CHECK (((accrual_base >= 0) AND (accrual_base <= 365)));
ALTER TABLE "vacation_entitlements" ADD CONSTRAINT "vac_ent_opening_used_chk" CHECK (((opening_used >= 0) AND (opening_used <= 365)));
ALTER TABLE "vacation_entitlements" ADD CONSTRAINT "vacation_entitlements_days_carried_over_check" CHECK (((days_carried_over >= '-365'::integer) AND (days_carried_over <= 365)));
ALTER TABLE "vacation_entitlements" ADD CONSTRAINT "vacation_entitlements_days_total_check" CHECK (((days_total >= 0) AND (days_total <= 365)));
ALTER TABLE "vacation_entitlements" ADD CONSTRAINT "vacation_entitlements_review_flag_chk" CHECK (((review_flag IS NULL) OR (review_flag = ANY (ARRAY['overdraw'::text, 'outlier'::text, 'unmatched'::text, 'missing'::text, 'corrected'::text]))));
ALTER TABLE "vacation_entitlements" ADD CONSTRAINT "vacation_entitlements_year_check" CHECK (((year >= 2000) AND (year <= 2100)));
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vacation_requests_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'sef_approved'::text, 'approved'::text, 'rejected'::text, 'canceled'::text])));
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vr_dates_chk" CHECK ((date_to >= date_from));
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vr_days_chk" CHECK ((days_count >= 0));
ALTER TABLE "vacation_requests" ADD CONSTRAINT "vr_status_chk" CHECK ((status = ANY (ARRAY['pending'::text, 'sef_approved'::text, 'approved'::text, 'rejected'::text, 'canceled'::text])));
ALTER TABLE "work_hours_remarks" ADD CONSTRAINT "work_hours_remarks_month_check" CHECK (((month >= 1) AND (month <= 12)));
ALTER TABLE "work_hours_remarks" ADD CONSTRAINT "work_hours_remarks_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])));
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_absence_code_check_v3" CHECK (((absence_code IS NULL) OR (absence_code = ANY (ARRAY['go'::text, 'bo'::text, 'sp'::text, 'np'::text, 'sl'::text, 'pr'::text, 'sv'::text, 'pl'::text, 'nop'::text]))));
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_absence_subtype_chk" CHECK (((absence_subtype IS NULL) OR (absence_subtype = ANY (ARRAY['obicno'::text, 'povreda_na_radu'::text, 'odrzavanje_trudnoce'::text]))));
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_field_hours_check" CHECK (((field_hours >= (0)::numeric) AND (field_hours <= (24)::numeric)));
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_field_subtype_check" CHECK (((field_subtype IS NULL) OR (field_subtype = ANY (ARRAY['domestic'::text, 'foreign'::text]))));
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_hours_check" CHECK (((hours >= (0)::numeric) AND (hours <= (24)::numeric)));
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_overtime_hours_check" CHECK (((overtime_hours >= (0)::numeric) AND (overtime_hours <= (24)::numeric)));
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_subtype_consistency_chk" CHECK (((absence_subtype IS NULL) OR (absence_code = 'bo'::text)));
ALTER TABLE "work_hours" ADD CONSTRAINT "work_hours_two_machine_hours_check" CHECK (((two_machine_hours >= (0)::numeric) AND (two_machine_hours <= (24)::numeric)));

-- ---------------------------------------------------------------------------
-- 4b. 🔴 DB-level DEFAULT za uuid ključeve — vraća se RUČNO.
--     Prisma `@default(uuid(4))` je KLIJENTSKI: u bazi kolona ostaje BEZ DEFAULT-a.
--     Pouka nalaza 5 iz koraka 2 (održavanje): bez ovoga svaki upis koji ne ide kroz
--     Prisma Client (prenosna skripta, ručni INSERT, DB trigger) pada na NOT NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE "absences"                       ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "assessment_answers"             ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "assessment_cycles"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "assessment_raters"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "assessment_results"             ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "assessment_scores"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "assessment_targets"             ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "assessments"                    ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "attendance_corrections"         ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "attendance_notify_extra"        ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "contracts"                      ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "corrective_measures"            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "corrective_plans"               ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "development_checkins"           ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "development_plans"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "employee_badges"                ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "employee_bank_cards"            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "employee_children"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "employee_documents"             ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "employee_expectations"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "employee_foreign_docs"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "employee_personal_docs"         ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "employee_talks"                 ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "employees"                      ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "kadr_certificates"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "kadr_document_ack"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "kadr_holidays"                  ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "kadr_medical_exams"             ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "kadr_notification_log"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "kadr_onboarding_runs"           ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "kadr_onboarding_tasks"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "kadr_onboarding_template_items" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "kadr_onboarding_templates"      ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "makeup_requests"                ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "nop_requests"                   ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "paid_leave_requests"            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "salary_payroll"                 ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "salary_terms"                   ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "vacation_bonus_days"            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "vacation_change_requests"       ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "vacation_entitlements"          ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "vacation_history"               ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "vacation_requests"              ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "work_hours"                     ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "work_hours_remarks"             ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- ---------------------------------------------------------------------------
-- 4c. Indeksi — prepisani DOSLOVNO sa žive sy15 (`pg_indexes.indexdef`).
--     Parcijalni, funkcijski i DESC indeksi Prisma šemu ne mogu da opišu, pa idu
--     ovde svi zajedno (izuzev PK-ova i onih koje `migrate diff` već pravi iz
--     `@@unique` constraint-a). `IF NOT EXISTS` čuva ponovljeno pokretanje.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS absences_archived_at_idx ON absences USING btree (archived_at) WHERE (archived_at IS NOT NULL);
-- 🔴 Jedini GiST indeks domena (zabrana preklapanja odsustva istog zaposlenog).
-- Traži `btree_gist` — bez njega PostgreSQL javi 42704 „uuid has no default
-- operator class for gist". sy15 tu ekstenziju ima; 3.0 je do sada nije tražila.
-- Uhvaćeno NA PROBNOJ BAZI, ne pretpostavljeno.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE INDEX IF NOT EXISTS absences_no_overlap_per_employee ON absences USING gist (employee_id, daterange(date_from, date_to, '[]'::text)) WHERE (archived_at IS NULL);
CREATE INDEX IF NOT EXISTS idx_absences_employee ON absences USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_absences_range ON absences USING btree (date_from, date_to);
CREATE INDEX IF NOT EXISTS idx_absences_slobodan ON absences USING btree (slobodan_reason) WHERE (slobodan_reason IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_absences_subtype ON absences USING btree (absence_subtype) WHERE (absence_subtype IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_absences_type ON absences USING btree (type);
CREATE INDEX IF NOT EXISTS ix_ar_assessment ON assessment_raters USING btree (assessment_id);
CREATE INDEX IF NOT EXISTS ix_ar_email ON assessment_raters USING btree (lower(rater_email));
CREATE INDEX IF NOT EXISTS ix_asc_rater ON assessment_scores USING btree (rater_id);
CREATE INDEX IF NOT EXISTS ix_as_cycle ON assessments USING btree (cycle_id);
CREATE INDEX IF NOT EXISTS ix_as_employee ON assessments USING btree (employee_id, period_label);
CREATE INDEX IF NOT EXISTS idx_attendance_corrections_day ON attendance_corrections USING btree (day DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_corrections_emp_day_active ON attendance_corrections USING btree (employee_id, day) WHERE (status = 'active'::text);
CREATE INDEX IF NOT EXISTS idx_attendance_events_emp_ts ON attendance_events USING btree (employee_id, event_ts DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_events_ts ON attendance_events USING btree (event_ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_events_source_ext ON attendance_events USING btree (source, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_notify_extra ON attendance_notify_extra USING btree (COALESCE(sub_department_id, '-1'::integer), lower(email));
CREATE INDEX IF NOT EXISTS ix_competences_group ON competences USING btree (group_id, sort_order);
CREATE INDEX IF NOT EXISTS contracts_archived_at_idx ON contracts USING btree (archived_at) WHERE (archived_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_contracts_active ON contracts USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_contracts_dateto ON contracts USING btree (date_to);
CREATE INDEX IF NOT EXISTS idx_contracts_employee ON contracts USING btree (employee_id);
CREATE INDEX IF NOT EXISTS corrective_measures_plan_idx ON corrective_measures USING btree (plan_id, sort);
CREATE INDEX IF NOT EXISTS corrective_plans_emp_idx ON corrective_plans USING btree (employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_dc_plan ON development_checkins USING btree (plan_id, checkin_date DESC);
CREATE INDEX IF NOT EXISTS ix_dp_employee ON development_plans USING btree (employee_id);
CREATE INDEX IF NOT EXISTS ix_dp_status ON development_plans USING btree (status, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_employee_badges_code_short ON employee_badges USING btree (code_short) WHERE (code_short IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_employee_badges_employee ON employee_badges USING btree (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_employee_badges_qr_code ON employee_badges USING btree (code) WHERE ((badge_type = 'qr'::text) AND (is_active = true));
CREATE INDEX IF NOT EXISTS idx_employee_children_birth ON employee_children USING btree (birth_date) WHERE (birth_date IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_employee_children_emp ON employee_children USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_documents_emp ON employee_documents USING btree (employee_id, uploaded_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX IF NOT EXISTS ix_ee_created_at ON employee_expectations USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ee_employee ON employee_expectations USING btree (employee_id);
CREATE INDEX IF NOT EXISTS ix_ee_plan ON employee_expectations USING btree (plan_id) WHERE (plan_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS ix_ee_status_active ON employee_expectations USING btree (status, due_date) WHERE (status = ANY (ARRAY['aktivno'::text, 'u_toku'::text]));
CREATE INDEX IF NOT EXISTS employee_talks_emp_idx ON employee_talks USING btree (employee_id, talk_date DESC);
CREATE INDEX IF NOT EXISTS idx_employees_active ON employees USING btree (is_active);
CREATE INDEX IF NOT EXISTS idx_employees_birth_date ON employees USING btree (birth_date) WHERE (birth_date IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees USING btree (department);
CREATE INDEX IF NOT EXISTS idx_employees_department_id ON employees USING btree (department_id);
CREATE INDEX IF NOT EXISTS idx_employees_first_name ON employees USING btree (lower(first_name)) WHERE ((first_name IS NOT NULL) AND (first_name <> ''::text));
CREATE INDEX IF NOT EXISTS idx_employees_last_first ON employees USING btree (last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_employees_last_name ON employees USING btree (lower(last_name)) WHERE ((last_name IS NOT NULL) AND (last_name <> ''::text));
CREATE INDEX IF NOT EXISTS idx_employees_med_expires ON employees USING btree (medical_exam_expires) WHERE (medical_exam_expires IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_employees_name ON employees USING btree (lower(full_name));
CREATE INDEX IF NOT EXISTS idx_employees_position ON employees USING btree ("position");
CREATE INDEX IF NOT EXISTS idx_employees_sub_department_id ON employees USING btree (sub_department_id);
CREATE INDEX IF NOT EXISTS idx_employees_team ON employees USING btree (team) WHERE ((team IS NOT NULL) AND (team <> ''::text));
CREATE INDEX IF NOT EXISTS idx_employees_work_type ON employees USING btree (work_type);
CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_card_barcode ON employees USING btree (card_barcode) WHERE ((card_barcode IS NOT NULL) AND (card_barcode <> ''::text));
CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_email ON employees USING btree (lower(email)) WHERE ((email IS NOT NULL) AND (email <> ''::text));
CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_personal_id ON employees USING btree (personal_id) WHERE ((personal_id IS NOT NULL) AND (personal_id <> ''::text));
CREATE INDEX IF NOT EXISTS idx_job_positions_dept ON job_positions USING btree (department_id);
CREATE INDEX IF NOT EXISTS idx_job_positions_subdept ON job_positions USING btree (sub_department_id);
CREATE INDEX IF NOT EXISTS idx_kadr_audit_actor_time ON kadr_audit_log USING btree (actor_user_id, changed_at DESC) WHERE (actor_user_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_kadr_audit_emp_time ON kadr_audit_log USING btree (employee_id, changed_at DESC) WHERE (employee_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_kadr_audit_table_time ON kadr_audit_log USING btree (table_name, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_kadr_certs_emp ON kadr_certificates USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_kadr_certs_expires ON kadr_certificates USING btree (expires_on) WHERE (expires_on IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_kadr_certs_type ON kadr_certificates USING btree (cert_type);
CREATE INDEX IF NOT EXISTS idx_kadr_doc_ack_emp ON kadr_document_ack USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_kadr_holidays_date ON kadr_holidays USING btree (holiday_date);
CREATE INDEX IF NOT EXISTS idx_kadr_holidays_year ON kadr_holidays USING btree (((EXTRACT(year FROM holiday_date))::integer));
CREATE INDEX IF NOT EXISTS idx_kadr_medical_exams_emp_date ON kadr_medical_exams USING btree (employee_id, exam_date DESC);
CREATE INDEX IF NOT EXISTS idx_kadr_medical_exams_valid ON kadr_medical_exams USING btree (valid_until) WHERE (valid_until IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_kadr_notif_dedup ON kadr_notification_log USING btree (related_entity_type, related_entity_id, notification_type, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_kadr_notif_emp ON kadr_notification_log USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_kadr_notif_status ON kadr_notification_log USING btree (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_kadr_onb_runs_emp ON kadr_onboarding_runs USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_kadr_onb_tasks_run ON kadr_onboarding_tasks USING btree (run_id);
CREATE INDEX IF NOT EXISTS idx_kadr_onb_tmpl_items_tmpl ON kadr_onboarding_template_items USING btree (template_id);
CREATE INDEX IF NOT EXISTS ix_mu_absence_date ON makeup_requests USING btree (absence_date);
CREATE INDEX IF NOT EXISTS ix_mu_employee ON makeup_requests USING btree (employee_id);
CREATE INDEX IF NOT EXISTS ix_mu_status ON makeup_requests USING btree (status);
CREATE INDEX IF NOT EXISTS ix_mu_submitted_by ON makeup_requests USING btree (lower(submitted_by));
CREATE UNIQUE INDEX IF NOT EXISTS nop_req_pending_uq ON nop_requests USING btree (employee_id, work_date) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS nop_req_status ON nop_requests USING btree (status) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS ix_pl_employee ON paid_leave_requests USING btree (employee_id);
CREATE INDEX IF NOT EXISTS ix_pl_status ON paid_leave_requests USING btree (status);
CREATE INDEX IF NOT EXISTS ix_pl_submitted_by ON paid_leave_requests USING btree (lower(submitted_by));
CREATE INDEX IF NOT EXISTS idx_salary_payroll_comp_model ON salary_payroll USING btree (compensation_model);
CREATE INDEX IF NOT EXISTS idx_salary_payroll_emp ON salary_payroll USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_salary_payroll_period ON salary_payroll USING btree (period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_salary_payroll_status ON salary_payroll USING btree (status);
CREATE INDEX IF NOT EXISTS idx_salary_terms_active ON salary_terms USING btree (employee_id) WHERE (effective_to IS NULL);
CREATE INDEX IF NOT EXISTS idx_salary_terms_comp_model ON salary_terms USING btree (compensation_model);
CREATE INDEX IF NOT EXISTS idx_salary_terms_emp ON salary_terms USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_salary_terms_period ON salary_terms USING btree (effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_sub_departments_dept ON sub_departments USING btree (department_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vacation_bonus_days_emp_workdate ON vacation_bonus_days USING btree (employee_id, work_date) WHERE (work_date IS NOT NULL);
CREATE INDEX IF NOT EXISTS vcr_employee_idx ON vacation_change_requests USING btree (employee_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS vcr_one_open_per_request ON vacation_change_requests USING btree (vacation_request_id) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_vacation_entitlements_year ON vacation_entitlements USING btree (year);
CREATE INDEX IF NOT EXISTS vacation_history_emp_idx ON vacation_history USING btree (employee_id, year);
CREATE INDEX IF NOT EXISTS ix_vr_employee ON vacation_requests USING btree (employee_id);
CREATE INDEX IF NOT EXISTS ix_vr_status ON vacation_requests USING btree (status);
CREATE INDEX IF NOT EXISTS ix_vr_submitted_by ON vacation_requests USING btree (lower(submitted_by));
CREATE INDEX IF NOT EXISTS ix_vr_year ON vacation_requests USING btree (year);
CREATE INDEX IF NOT EXISTS idx_whremarks_emp ON work_hours_remarks USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_whremarks_period ON work_hours_remarks USING btree (year, month);
CREATE INDEX IF NOT EXISTS idx_whremarks_status ON work_hours_remarks USING btree (status) WHERE (status = 'open'::text);
CREATE INDEX IF NOT EXISTS idx_work_hours_absence_subtype ON work_hours USING btree (absence_subtype);
CREATE INDEX IF NOT EXISTS idx_work_hours_date ON work_hours USING btree (work_date);
CREATE INDEX IF NOT EXISTS idx_work_hours_date_only ON work_hours USING btree (work_date);
CREATE INDEX IF NOT EXISTS idx_work_hours_emp_date ON work_hours USING btree (employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_work_hours_employee ON work_hours USING btree (employee_id);
CREATE INDEX IF NOT EXISTS idx_work_hours_field_subtype ON work_hours USING btree (field_subtype) WHERE (field_subtype IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_work_hours_subtype ON work_hours USING btree (absence_subtype) WHERE (absence_subtype IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 4d. 5 FK ka nalogu: sy15 `auth.users`(uuid) -> 3.0 `users`(id, Int).
--     ON DELETE je prepisan sa žive baze (3 × SET NULL, 2 × NO ACTION).
--     🔴 Kadrovska ima SAMO 5 takvih FK-ova (održavanje ih je imalo 46) — jer
--     njen identitet NIJE nalog nego `employees`, a `employees` NEMA `user_id`:
--     veza ka nalogu je MEJL. Šesta uuid kolona, `kadr_audit_log.actor_user_id`,
--     u sy15 NEMA FK (35 različitih vrednosti) — ni ovde ga ne dobija.
-- ---------------------------------------------------------------------------
ALTER TABLE "absences"
  ADD CONSTRAINT "fk_absences_archived_by" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "contracts"
  ADD CONSTRAINT "fk_contracts_archived_by" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "employee_documents"
  ADD CONSTRAINT "fk_employee_documents_uploaded_by" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "kadr_certificates"
  ADD CONSTRAINT "fk_kadr_certificates_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "kadr_medical_exams"
  ADD CONSTRAINT "fk_kadr_medical_exams_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- ---------------------------------------------------------------------------
-- 5. TRIGERI — MEHANIKA (prenosi se). LOGIKA se NE prenosi (v. §6).
--
--    sy15 ima TAČNO 59 trigera na ovih 64 tabele (`pg_trigger`, `tgisinternal=false`).
--    Podela je izmerena po TELU funkcije, ne po imenu:
--      • 36 mehanika (30 × `update_updated_at` + 6 imenovanih) — prenosi se ovde
--      • 23 logika (4 × `audit_row_change`, 10 × `kadr_audit_log_trigger`,
--        7 gejt/sync trigera, 2 × `set_created_by` iz `auth.jwt()`) — v. §6b
--    Sva tela su PREPISANA DOSLOVNO sa žive sy15 (`pg_get_functiondef`).
-- ---------------------------------------------------------------------------

-- 5a. `updated_at` — u sy15 to radi ZAJEDNIČKA funkcija `update_updated_at()`
--     (deli je cela baza). U 3.0 dobija prefiks domena, da ne gazi ništa tuđe.
CREATE OR REPLACE FUNCTION "kadr_touch_updated_at"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$;

-- 30 tabela — spisak je prepisan sa žive baze, IMENA TRIGERA UKLJUČENA.
-- ⚠️ `job_positions`, `vacation_history`, `vacation_go_days`, `kadr_document_ack`,
--    `attendance_events`, `assessment_*`, `corrective_*`, `development_checkins`,
--    `employee_documents`, `employee_talks`, `kadr_onboarding_*`, `profile_*`,
--    `departments`/`sub_departments`, `vacation_bonus_days`,
--    `vacation_change_requests`, `attendance_notify_extra`, 3 allowlist tabele i
--    `kadr_audit_log` NEMAJU `updated_at` triger ni u sy15 — ne dodajemo ga.
--    (Neke od njih nemaju ni kolonu; dodavanje bi bila promena ponašanja.)
CREATE TRIGGER "trg_absences_updated" BEFORE UPDATE ON "absences" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_assessments_updated_at" BEFORE UPDATE ON "assessments" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_attendance_corrections_updated" BEFORE UPDATE ON "attendance_corrections" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_competence_groups_updated_at" BEFORE UPDATE ON "competence_groups" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_competence_profiles_updated_at" BEFORE UPDATE ON "competence_profiles" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_competences_updated_at" BEFORE UPDATE ON "competences" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_contracts_updated" BEFORE UPDATE ON "contracts" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_dp_updated_at" BEFORE UPDATE ON "development_plans" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_employee_badges_updated" BEFORE UPDATE ON "employee_badges" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_bank_cards_updated" BEFORE UPDATE ON "employee_bank_cards" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_employee_children_updated" BEFORE UPDATE ON "employee_children" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_ee_updated_at" BEFORE UPDATE ON "employee_expectations" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_foreign_docs_updated" BEFORE UPDATE ON "employee_foreign_docs" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_personal_docs_updated" BEFORE UPDATE ON "employee_personal_docs" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_employees_updated" BEFORE UPDATE ON "employees" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_certs_updated_at" BEFORE UPDATE ON "kadr_certificates" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_holidays_updated" BEFORE UPDATE ON "kadr_holidays" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_medical_exams_updated_at" BEFORE UPDATE ON "kadr_medical_exams" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_notification_config_updated" BEFORE UPDATE ON "kadr_notification_config" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_notif_updated" BEFORE UPDATE ON "kadr_notification_log" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_katze_employee_map_updated" BEFORE UPDATE ON "katze_employee_map" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_mu_updated_at" BEFORE UPDATE ON "makeup_requests" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_nopreq_updated" BEFORE UPDATE ON "nop_requests" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_pl_updated_at" BEFORE UPDATE ON "paid_leave_requests" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_salary_payroll_updated" BEFORE UPDATE ON "salary_payroll" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_salary_terms_updated" BEFORE UPDATE ON "salary_terms" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_vacation_entitlements_updated" BEFORE UPDATE ON "vacation_entitlements" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_vr_updated_at" BEFORE UPDATE ON "vacation_requests" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_work_hours_updated" BEFORE UPDATE ON "work_hours" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_whremarks_updated" BEFORE UPDATE ON "work_hours_remarks" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();

-- 5b. `full_name` iz `first_name`+`last_name`.
--     🔴 REDOSLED JE „PREZIME IME", ne „ime prezime" — izmereno u telu sy15
--     funkcije (`concat_ws(' ', v_last, v_first)`). Pretpostavka bi ovde tiho
--     preokrenula sva imena. Bez ovog trigera `employees_full_name_unique`
--     nema šta da drži, jer je `full_name` NOT NULL.
CREATE OR REPLACE FUNCTION "kadr_employees_sync_full_name"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_first text := NULLIF(btrim(NEW."first_name"), '');
  v_last  text := NULLIF(btrim(NEW."last_name"), '');
BEGIN
  IF v_first IS NOT NULL OR v_last IS NOT NULL THEN
    NEW."full_name" := btrim(concat_ws(' ', v_last, v_first));
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "employees_full_name_sync" BEFORE INSERT OR UPDATE OF "first_name", "last_name", "full_name"
  ON "employees" FOR EACH ROW EXECUTE FUNCTION "kadr_employees_sync_full_name"();

-- 5c. `attendance_events` — vreme kucanja na kapiji.
--     🔴 SMER JE OBRNUT OD OČEKIVANOG: triger računa `event_ts` IZ
--     `event_ts_local` (ne obrnuto). Izmereno u telu; pretpostavka bi pomerila
--     svaki događaj za 1–2 sata. `event_ts_local` je `timestamp` BEZ zone, pa
--     konverzija MORA da imenuje zonu (pouka „Vremena u bazi su UTC bez zone").
CREATE OR REPLACE FUNCTION "kadr_attendance_fill_event_ts"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."event_ts_local" IS NOT NULL THEN
    NEW."event_ts" := NEW."event_ts_local" AT TIME ZONE 'Europe/Belgrade';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_attendance_fill_ts" BEFORE INSERT OR UPDATE ON "attendance_events"
  FOR EACH ROW EXECUTE FUNCTION "kadr_attendance_fill_event_ts"();

-- 5d. Zabrana preklapanja zahteva za godišnji (mehanika — provera nad podacima).
--     Doslovan prepis; SECURITY DEFINER je SKINUT jer 3.0 nema RLS koji bi ga
--     tražio. Statusi (`pending`/`sef_approved`/`approved`) su prepisani, NE
--     izmišljeni — u sy15 su baš ti.
CREATE OR REPLACE FUNCTION "kadr_vacation_requests_no_overlap"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_conf record;
BEGIN
  IF NEW."status" NOT IN ('pending', 'sef_approved', 'approved') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW."date_from" IS NOT DISTINCT FROM OLD."date_from"
     AND NEW."date_to"   IS NOT DISTINCT FROM OLD."date_to" THEN
    RETURN NEW;
  END IF;
  IF NEW."date_from" IS NULL OR NEW."date_to" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT vr."id", vr."date_from", vr."date_to", vr."status"
    INTO v_conf
    FROM "vacation_requests" vr
   WHERE vr."employee_id" = NEW."employee_id"
     AND vr."id" <> NEW."id"
     AND vr."status" IN ('pending', 'sef_approved', 'approved')
     AND vr."date_from" <= NEW."date_to"
     AND vr."date_to"   >= NEW."date_from"
   ORDER BY vr."date_from"
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Već postoji aktivan zahtev za godišnji odmor koji se preklapa sa tim danima (% – %, status: %). Prvo obriši ili otkaži prethodni pa podnesi ponovo.',
      to_char(v_conf.date_from, 'DD.MM.YYYY'), to_char(v_conf.date_to, 'DD.MM.YYYY'), v_conf.status
      USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_vr_no_overlap" BEFORE INSERT OR UPDATE ON "vacation_requests"
  FOR EACH ROW EXECUTE FUNCTION "kadr_vacation_requests_no_overlap"();

-- 5e. 🔴 ZARADE — dva trigera koja čuvaju NOVAC. Oba su čista mehanika i
--     prenose se doslovno; ako se ijedan izgubi, obračun tiho promeni rezultat.

-- 5e-1. Zbirovi obračuna (`total_rsd`, `total_eur`, `second_part_rsd`).
CREATE OR REPLACE FUNCTION "kadr_salary_payroll_compute_totals"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_base NUMERIC(14, 2);
BEGIN
  IF NEW."ukupna_zarada" IS NOT NULL AND NEW."ukupna_zarada" > 0 THEN
    NEW."total_rsd" := NEW."ukupna_zarada";
  ELSIF NEW."salary_type" = 'satnica' THEN
    v_base := COALESCE(NEW."hours_worked", 0) * COALESCE(NEW."hourly_rate", 0);
    NEW."total_rsd" := v_base + COALESCE(NEW."transport_rsd", 0)
                     + COALESCE(NEW."per_diem_rsd", 0) * COALESCE(NEW."domestic_days", 0);
  ELSE
    v_base := COALESCE(NEW."fixed_salary", 0);
    NEW."total_rsd" := v_base + COALESCE(NEW."transport_rsd", 0)
                     + COALESCE(NEW."per_diem_rsd", 0) * COALESCE(NEW."domestic_days", 0);
  END IF;
  NEW."total_eur" := COALESCE(NEW."per_diem_eur", 0) * COALESCE(NEW."foreign_days", 0);
  NEW."second_part_rsd" := NEW."total_rsd" - COALESCE(NEW."advance_amount", 0);
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_salary_payroll_totals" BEFORE INSERT OR UPDATE ON "salary_payroll"
  FOR EACH ROW EXECUTE FUNCTION "kadr_salary_payroll_compute_totals"();

-- 5e-2. Nepromenljivost zaključanog meseca. Prepisano doslovno, uključujući
--       `current_setting('payroll.unlock_ok')` — otključavanje ide isključivo
--       kroz `kadr_payroll_unlock` koji tu promenljivu postavlja u svojoj
--       transakciji (funkcija se prepisuje u servisu, v. §7 blokada 2).
CREATE OR REPLACE FUNCTION "kadr_salary_payroll_immutability_check"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'paid' THEN
    IF current_setting('payroll.unlock_ok', true) IS DISTINCT FROM 'on' THEN
      IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'salary_payroll_locked: mesec je zaključan (status=paid). Admin mora prvo da otključa preko kadr_payroll_unlock(id).'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Ime počinje sa `trg_0_` NAMERNO: PostgreSQL okida trigere po ABECEDI imena, pa
-- brana mora da se izvrši PRE `trg_salary_payroll_totals`. Prepisano iz sy15.
CREATE TRIGGER "trg_0_salary_payroll_immutability" BEFORE UPDATE ON "salary_payroll"
  FOR EACH ROW EXECUTE FUNCTION "kadr_salary_payroll_immutability_check"();

-- 5f. Zatvaranje prethodnih uslova rada pri unosu novog (mehanika).
CREATE OR REPLACE FUNCTION "kadr_salary_terms_close_previous"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."effective_to" IS NULL THEN
    UPDATE "salary_terms"
       SET "effective_to" = (NEW."effective_from" - INTERVAL '1 day')::date, "updated_at" = now()
     WHERE "employee_id" = NEW."employee_id"
       AND "id" <> NEW."id"
       AND "effective_to" IS NULL
       AND "effective_from" < NEW."effective_from";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_salary_terms_close_prev" AFTER INSERT ON "salary_terms"
  FOR EACH ROW EXECUTE FUNCTION "kadr_salary_terms_close_previous"();

-- ---------------------------------------------------------------------------
-- 6. ŠTA MIGRACIJA NAMERNO NE PRENOSI (i gde to živi umesto nje)
-- ---------------------------------------------------------------------------
-- a) 167 RLS politika na 63 od 64 tabele — najviše u celoj sy15 bazi. 3.0 nema
--    RLS (ODLUKE.md); row-scope se prepisuje u `KadrovskaAuthzService`, koji JOŠ
--    NE POSTOJI (v. runbook §7, blokada 1 — to je najveći preostali posao).
--    🔴 `vacation_go_days` je JEDINA tabela domena BEZ RLS-a (`relrowsecurity =
--    false`), a ima 5.269 redova iskorišćenih dana GO. Zatečeno stanje — modul je
--    zamrznut, pa NIJE popravljano; popisano u runbook-u §8.
-- b) 23 trigera koji su LOGIKA:
--      4 × `audit_row_change()`      — absences, employee_children, employees,
--          work_hours; piše u ZAJEDNIČKI `audit_log` (14.627 redova) koji NIJE
--          ovaj domen i deli ga cela sy15 (v. runbook §4, šav „d")
--     10 × `kadr_audit_log_trigger('employee_id')` — contracts,
--          employee_bank_cards, employee_foreign_docs, employee_personal_docs,
--          kadr_certificates, kadr_medical_exams, salary_payroll, salary_terms,
--          vacation_entitlements, vacation_requests (piše u `kadr_audit_log`,
--          1.239 redova — TO JESTE ovaj domen, ali zove `auth.jwt()`)
--      1 × `absences_archive_guard`        (zove `current_user_is_admin/hr`)
--      1 × `dp_self_update_guard`          (razvojni plan — zabrana samoocene)
--      1 × `ee_self_update_guard`          (očekivanja — isto)
--      1 × `employees_sensitive_guard`     (🔴 brana PII: JMBG/banka/adresa)
--      1 × `jp_guard_structural_columns`   (sistematizacija — strukturne kolone)
--      1 × `kadr_medical_exams_sync_employee` (denormalizacija u `employees`)
--      1 × `kadr_notify_push_trg`          (web-push; u 3.0 NE RADI)
--      2 × `*_set_created_by`              (`auth.jwt() ->> 'email'`)
-- c) 116 funkcija koje domen dodiruju (63 `SECURITY DEFINER`). 62 nose prefiks
--    domena, a **54 NE** — `hr_*` (11), `ai_chat_*` (12), `pb_*` (9),
--    `makeup_*`/`paid_leave_*`/`talk_*`, gejtovi (`current_user_can_view_salary`,
--    `current_user_manages_employee`, `can_edit_kadrovska_grid`, …),
--    `kiosk_record_punch`, `rev_current_employee_id`, `approve_nop_request`,
--    `go_ledger`, `sync_qbigtehn_operator_cards`.
--    🔴 Isti obrazac kao nalaz 2 u koraku 2: spisak po prefiksu PROMAŠI domen.
-- d) 19 view-ova koji čitaju domen (15 `security_invoker` + 4 DEFINER) —
--    spisak i posledice u runbook-u §7, blokada 4.
-- e) 3 allowlist tabele PRENOSE SE SA SADRŽAJEM (to su prava, ne šifarnik):
--    `kadr_salary_viewer_allowlist` (2 reda), `kadr_grid_editor_allowlist` (5),
--    `kadr_vacation_editor_allowlist` (4). 🔴 Bez njih zarade ne vidi NIKO.

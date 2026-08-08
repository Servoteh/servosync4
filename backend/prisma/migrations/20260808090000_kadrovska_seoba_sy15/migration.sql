-- Seoba sy15 → 3.0, KORAK 4: KADROVSKA — ŠEMA I MIGRACIJA (08.08.2026)
-- Plan gašenja sy15: docs/PLAN_GASENJA_SY15_2026-08-03.md (korak 4).
-- Prenosne odluke PO-1..PO-8: `prisma/schema.prisma`, zaglavlje bloka „KADROVSKA".
-- PO-9 (`vacation_go_days` bez FK) i PO-10 (dupli indeks nad `work_hours.work_date`)
-- stoje uz same modele — oba su ZATEČENA stanja sy15 koja se NE popravljaju.
--
-- Generisano OFFLINE: `prisma migrate diff` datamodel→datamodel
-- (`origin/main` schema → ova grana), po BACKEND_RULES §12 v0.7.
-- `migrate dev` na produkciji je ZABRANJEN; primenjuje se ISKLJUČIVO
-- `migrate:prod` (deploy) uz prethodni `migrate status` drift-check.
--
-- ⚠️ KADROVSKA JE ZAMRZNUTA za dorade (docs/OTVORENI_POSLOVI.md §K). Seoba je
--    izuzetak koji zamrzavanje ukida — ali SAMO kao PRENOS. Nijedan zatečen kvar
--    ovde nije popravljen; svi su popisani u opisu PR-a.
--
-- ⚠️ Ova migracija SAMO KREIRA 65 PRAZNIH tabela i njihova ograničenja.
--    NE prenosi podatke, NE dira sy15, NE menja nijedan postojeći red u 3.0 i NE
--    preusmerava nijedan servis (kadrovska i `moj-profil` i dalje čitaju sy15).
--    Katze most (kapija, na 10 min) i kiosk nastavljaju da pišu sy15
--    `attendance_events` — ovde se NE dodiruju.
--
-- IZMERENO 08.08.2026 pre pisanja (ne pretpostavljeno):
--   • Domen ima **66 tabela** u sy15, a NE 19 kako je stajalo u zatečenoj mapi
--     (prefiks `kadr*` hvata samo 12 od njih) — v. opis PR-a. Ovde se prenosi 65:
--     `worker_employee_map` se preskače (PO-7), `departments` se preimenuje (PO-1).
--   • `attendance_events`: `ANALYZE` pa `count(*)` = **491.278** redova
--     (`reltuples` je davao 491.271 — to NIJE broj redova). Broj RASTE dok ovo
--     čitaš: Katze most upisuje na 10 min, pa je svaka cifra tačna samo za svoj
--     trenutak. Most i kiosk se ovde NE diraju.
--   • 3.0 NEMA nijednu od 65 tabela (`information_schema.tables` = 0 pogodaka),
--     pa migracija ne može da pregazi zatečene podatke.
--   • 3.0 NEMA `btree_gist` (`pg_extension`: pg_trgm, plpgsql, unaccent) — §3.
--   • 3.0 `user_roles` VEĆ IMA `managed_sub_department_ids` — ne dira se.
--   • Nijedna od 73 sy15 funkcije domena ne koristi `ON CONFLICT ON CONSTRAINT`
--     (`pg_get_functiondef`, 0 pogodaka), pa je prevod imena ključeva na
--     `pk_/uq_/fk_/idx_` (BACKEND_RULES §3) bezbedan.
--
-- Redosled `migrate diff`-a poštuje FK. SQL-only dodaci (111 CHECK-ova, 38
-- parcijalnih/funkcijskih indeksa, EXCLUDE, NOT NULL nad nizovima, mehanički
-- trigeri) idu na kraj fajla, §1–§5. §6 popisuje šta se NAMERNO ne prenosi.

-- CreateTable
CREATE TABLE "kadr_departments" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT "pk_kadr_departments" PRIMARY KEY ("id")
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
CREATE TABLE "company_profile" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "mission_md" TEXT,
    "vision_md" TEXT,
    "values_md" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "pk_company_profile" PRIMARY KEY ("id")
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
CREATE TABLE "employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "contracts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
    "archived_by" UUID,
    "probni_rad" BOOLEAN NOT NULL DEFAULT false,
    "probni_meseci" INTEGER,

    CONSTRAINT "pk_contracts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_children" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "birth_date" DATE,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_employee_children" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_bank_cards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "employee_foreign_docs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "employee_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL DEFAULT 'licna_karta',
    "file_name" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" BIGINT,
    "description" TEXT,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_employee_documents" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_badges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "kadr_certificates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_certificates" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_medical_exams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "exam_date" DATE NOT NULL,
    "valid_until" DATE,
    "exam_type" TEXT NOT NULL DEFAULT 'redovan',
    "institution" TEXT,
    "cost_rsd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "document_url" TEXT,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_medical_exams" PRIMARY KEY ("id")
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
CREATE TABLE "device_push_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "endpoint" TEXT,
    "p256dh" TEXT,
    "auth" TEXT,
    "token" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_device_push_tokens" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "absences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
    "archived_by" UUID,

    CONSTRAINT "pk_absences" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vacation_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "vacation_entitlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "vacation_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "vacation_bonus_days" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "vacation_go_days" (
    "employee_id" UUID NOT NULL,
    "used_date" DATE NOT NULL,
    "source_year" INTEGER,
    "comment" TEXT,

    CONSTRAINT "pk_vacation_go_days" PRIMARY KEY ("employee_id","used_date")
);

-- CreateTable
CREATE TABLE "vacation_change_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "makeup_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "paid_leave_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "nop_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "work_hours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "attendance_corrections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "attendance_notify_extra" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sub_department_id" INTEGER,
    "email" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_attendance_notify_extra" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salary_terms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "salary_payroll" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "development_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "development_checkins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "employee_expectations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "employee_talks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "corrective_plans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "corrective_measures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "assessment_cycles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "assessments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "assessment_raters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "assessment_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rater_id" UUID NOT NULL,
    "competence_id" INTEGER NOT NULL,
    "level" SMALLINT,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_assessment_scores" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_answers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "rater_id" UUID NOT NULL,
    "question_code" TEXT NOT NULL,
    "answer_text" TEXT,

    CONSTRAINT "pk_assessment_answers" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_targets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assessment_id" UUID NOT NULL,
    "competence_id" INTEGER NOT NULL,
    "target_level" SMALLINT,

    CONSTRAINT "pk_assessment_targets" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assessment_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "kadr_onboarding_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'onboarding',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "pk_kadr_onboarding_templates" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_onboarding_template_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "template_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "offset_days" INTEGER NOT NULL DEFAULT 0,
    "assignee_hint" TEXT,

    CONSTRAINT "pk_kadr_onboarding_template_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_onboarding_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "kadr_document_ack" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" TEXT NOT NULL,
    "label" TEXT,
    "acked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acked_by" TEXT,

    CONSTRAINT "pk_kadr_document_ack" PRIMARY KEY ("id")
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
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
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
CREATE TABLE "kadr_holidays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "holiday_date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "is_workday" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT DEFAULT '',
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_holidays" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kadr_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "actor_user_id" UUID,
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
CREATE TABLE "kadr_grid_editor_allowlist" (
    "email" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_kadr_grid_editor_allowlist" PRIMARY KEY ("email")
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

-- CreateIndex
CREATE INDEX "idx_sub_departments_dept" ON "sub_departments"("department_id");

-- CreateIndex
CREATE INDEX "idx_job_positions_dept" ON "job_positions"("department_id");

-- CreateIndex
CREATE INDEX "idx_job_positions_subdept" ON "job_positions"("sub_department_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_competence_groups_code" ON "competence_groups"("code");

-- CreateIndex
CREATE INDEX "idx_competences_group" ON "competences"("group_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "uq_competences_code" ON "competences"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_competence_levels_competence_level" ON "competence_levels"("competence_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "uq_competence_profiles_code" ON "competence_profiles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_competence_questions_code" ON "competence_questions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_profile_groups_profile_group" ON "profile_groups"("profile_id", "group_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_profile_positions_position" ON "profile_positions"("position_id");

-- CreateIndex
CREATE INDEX "idx_employees_active" ON "employees"("is_active");

-- CreateIndex
CREATE INDEX "idx_employees_department" ON "employees"("department");

-- CreateIndex
CREATE INDEX "idx_employees_department_id" ON "employees"("department_id");

-- CreateIndex
CREATE INDEX "idx_employees_last_first" ON "employees"("last_name", "first_name");

-- CreateIndex
CREATE INDEX "idx_employees_position" ON "employees"("position");

-- CreateIndex
CREATE INDEX "idx_employees_sub_department_id" ON "employees"("sub_department_id");

-- CreateIndex
CREATE INDEX "idx_employees_work_type" ON "employees"("work_type");

-- CreateIndex
CREATE UNIQUE INDEX "uq_employees_full_name" ON "employees"("full_name");

-- CreateIndex
CREATE INDEX "idx_contracts_active" ON "contracts"("is_active");

-- CreateIndex
CREATE INDEX "idx_contracts_dateto" ON "contracts"("date_to");

-- CreateIndex
CREATE INDEX "idx_contracts_employee" ON "contracts"("employee_id");

-- CreateIndex
CREATE INDEX "idx_employee_children_emp" ON "employee_children"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_employee_foreign_docs_employee" ON "employee_foreign_docs"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_employee_personal_docs_employee" ON "employee_personal_docs"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_employee_documents_storage_path" ON "employee_documents"("storage_path");

-- CreateIndex
CREATE INDEX "idx_employee_badges_employee" ON "employee_badges"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_employee_badges_type_code_employee" ON "employee_badges"("badge_type", "code", "employee_id");

-- CreateIndex
CREATE INDEX "idx_kadr_certs_emp" ON "kadr_certificates"("employee_id");

-- CreateIndex
CREATE INDEX "idx_kadr_certs_type" ON "kadr_certificates"("cert_type");

-- CreateIndex
CREATE INDEX "idx_kadr_medical_exams_emp_date" ON "kadr_medical_exams"("employee_id", "exam_date" DESC);

-- CreateIndex
CREATE INDEX "idx_device_push_tokens_user" ON "device_push_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_device_push_tokens_endpoint" ON "device_push_tokens"("endpoint");

-- CreateIndex
CREATE UNIQUE INDEX "uq_device_push_tokens_token" ON "device_push_tokens"("token");

-- CreateIndex
CREATE INDEX "idx_absences_employee" ON "absences"("employee_id");

-- CreateIndex
CREATE INDEX "idx_absences_range" ON "absences"("date_from", "date_to");

-- CreateIndex
CREATE INDEX "idx_absences_type" ON "absences"("type");

-- CreateIndex
CREATE INDEX "idx_vacation_requests_employee" ON "vacation_requests"("employee_id");

-- CreateIndex
CREATE INDEX "idx_vacation_requests_status" ON "vacation_requests"("status");

-- CreateIndex
CREATE INDEX "idx_vacation_requests_year" ON "vacation_requests"("year");

-- CreateIndex
CREATE INDEX "idx_vacation_entitlements_year" ON "vacation_entitlements"("year");

-- CreateIndex
CREATE UNIQUE INDEX "uq_vacation_entitlements_employee_year" ON "vacation_entitlements"("employee_id", "year");

-- CreateIndex
CREATE INDEX "idx_vacation_history_emp" ON "vacation_history"("employee_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "uq_vacation_history_employee_year_source" ON "vacation_history"("employee_id", "year", "source");

-- CreateIndex
CREATE INDEX "idx_vacation_change_requests_employee" ON "vacation_change_requests"("employee_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_makeup_requests_absence_date" ON "makeup_requests"("absence_date");

-- CreateIndex
CREATE INDEX "idx_makeup_requests_employee" ON "makeup_requests"("employee_id");

-- CreateIndex
CREATE INDEX "idx_makeup_requests_status" ON "makeup_requests"("status");

-- CreateIndex
CREATE INDEX "idx_paid_leave_requests_employee" ON "paid_leave_requests"("employee_id");

-- CreateIndex
CREATE INDEX "idx_paid_leave_requests_status" ON "paid_leave_requests"("status");

-- CreateIndex
CREATE INDEX "idx_work_hours_date" ON "work_hours"("work_date");

-- CreateIndex
CREATE INDEX "idx_work_hours_emp_date" ON "work_hours"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "idx_work_hours_employee" ON "work_hours"("employee_id");

-- CreateIndex
CREATE INDEX "idx_work_hours_absence_subtype" ON "work_hours"("absence_subtype");

-- CreateIndex
CREATE UNIQUE INDEX "uq_work_hours_employee_date" ON "work_hours"("employee_id", "work_date");

-- CreateIndex
CREATE INDEX "idx_work_hours_remarks_emp" ON "work_hours_remarks"("employee_id");

-- CreateIndex
CREATE INDEX "idx_work_hours_remarks_period" ON "work_hours_remarks"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "uq_work_hours_remarks_employee_period" ON "work_hours_remarks"("employee_id", "year", "month");

-- CreateIndex
-- 🔴 BRANA OD DUPLIKATA za Katze most (kursor `attendance_katze_max_idreg`) i kiosk
-- (`kiosk_record_punch`). U sy15 postoji kao UNIQUE INDEX istog imena; IZMERENO da
-- nijedna sy15 funkcija ne radi `ON CONFLICT` nad `attendance_events`, pa je ovaj
-- indeks JEDINI branik od udvostručenih prolaza (ponovni upis pada na `23505`).
CREATE UNIQUE INDEX "ux_attendance_events_source_ext" ON "attendance_events"("source", "external_id");

-- CreateIndex
CREATE INDEX "idx_attendance_events_emp_ts" ON "attendance_events"("employee_id", "event_ts" DESC);

-- CreateIndex
CREATE INDEX "idx_attendance_events_ts" ON "attendance_events"("event_ts" DESC);

-- CreateIndex
CREATE INDEX "idx_attendance_corrections_day" ON "attendance_corrections"("day" DESC);

-- CreateIndex
CREATE INDEX "idx_salary_terms_comp_model" ON "salary_terms"("compensation_model");

-- CreateIndex
CREATE INDEX "idx_salary_terms_emp" ON "salary_terms"("employee_id");

-- CreateIndex
CREATE INDEX "idx_salary_terms_period" ON "salary_terms"("effective_from", "effective_to");

-- CreateIndex
CREATE INDEX "idx_salary_payroll_comp_model" ON "salary_payroll"("compensation_model");

-- CreateIndex
CREATE INDEX "idx_salary_payroll_emp" ON "salary_payroll"("employee_id");

-- CreateIndex
CREATE INDEX "idx_salary_payroll_period" ON "salary_payroll"("period_year", "period_month");

-- CreateIndex
CREATE INDEX "idx_salary_payroll_status" ON "salary_payroll"("status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_salary_payroll_employee_period" ON "salary_payroll"("employee_id", "period_year", "period_month");

-- CreateIndex
CREATE INDEX "idx_development_plans_employee" ON "development_plans"("employee_id");

-- CreateIndex
CREATE INDEX "idx_development_plans_status" ON "development_plans"("status", "period_start" DESC);

-- CreateIndex
CREATE INDEX "idx_development_checkins_plan" ON "development_checkins"("plan_id", "checkin_date" DESC);

-- CreateIndex
CREATE INDEX "idx_employee_expectations_created_at" ON "employee_expectations"("created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_employee_expectations_employee" ON "employee_expectations"("employee_id");

-- CreateIndex
CREATE INDEX "idx_employee_talks_emp" ON "employee_talks"("employee_id", "talk_date" DESC);

-- CreateIndex
CREATE INDEX "idx_corrective_plans_emp" ON "corrective_plans"("employee_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_corrective_measures_plan" ON "corrective_measures"("plan_id", "sort");

-- CreateIndex
CREATE INDEX "idx_assessments_cycle" ON "assessments"("cycle_id");

-- CreateIndex
CREATE INDEX "idx_assessments_employee" ON "assessments"("employee_id", "period_label");

-- CreateIndex
CREATE INDEX "idx_assessment_raters_assessment" ON "assessment_raters"("assessment_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_assessment_raters_token" ON "assessment_raters"("token");

-- CreateIndex
CREATE INDEX "idx_assessment_scores_rater" ON "assessment_scores"("rater_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_assessment_scores_rater_competence" ON "assessment_scores"("rater_id", "competence_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_assessment_answers_rater_question" ON "assessment_answers"("rater_id", "question_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_assessment_targets_assessment_competence" ON "assessment_targets"("assessment_id", "competence_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_assessment_results_scope" ON "assessment_results"("assessment_id", "scope_kind", "ref_id");

-- CreateIndex
CREATE INDEX "idx_kadr_onb_tmpl_items_tmpl" ON "kadr_onboarding_template_items"("template_id");

-- CreateIndex
CREATE INDEX "idx_kadr_onb_runs_emp" ON "kadr_onboarding_runs"("employee_id");

-- CreateIndex
CREATE INDEX "idx_kadr_onb_tasks_run" ON "kadr_onboarding_tasks"("run_id");

-- CreateIndex
CREATE INDEX "idx_kadr_doc_ack_emp" ON "kadr_document_ack"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_kadr_document_ack_employee_ref" ON "kadr_document_ack"("employee_id", "ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "idx_kadr_notif_dedup" ON "kadr_notification_log"("related_entity_type", "related_entity_id", "notification_type", "scheduled_at");

-- CreateIndex
CREATE INDEX "idx_kadr_notif_emp" ON "kadr_notification_log"("employee_id");

-- CreateIndex
CREATE INDEX "idx_kadr_notif_status" ON "kadr_notification_log"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "idx_kadr_holidays_date" ON "kadr_holidays"("holiday_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_kadr_holidays_date" ON "kadr_holidays"("holiday_date");

-- CreateIndex
CREATE INDEX "idx_kadr_audit_table_time" ON "kadr_audit_log"("table_name", "changed_at" DESC);

-- AddForeignKey
ALTER TABLE "sub_departments" ADD CONSTRAINT "fk_sub_departments_department" FOREIGN KEY ("department_id") REFERENCES "kadr_departments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_positions" ADD CONSTRAINT "fk_job_positions_department" FOREIGN KEY ("department_id") REFERENCES "kadr_departments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_positions" ADD CONSTRAINT "fk_job_positions_sub_department" FOREIGN KEY ("sub_department_id") REFERENCES "sub_departments"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competences" ADD CONSTRAINT "fk_competences_group" FOREIGN KEY ("group_id") REFERENCES "competence_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competence_levels" ADD CONSTRAINT "fk_competence_levels_competence" FOREIGN KEY ("competence_id") REFERENCES "competences"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "competence_questions" ADD CONSTRAINT "fk_competence_questions_group" FOREIGN KEY ("group_id") REFERENCES "competence_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_groups" ADD CONSTRAINT "fk_profile_groups_profile" FOREIGN KEY ("profile_id") REFERENCES "competence_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_groups" ADD CONSTRAINT "fk_profile_groups_group" FOREIGN KEY ("group_id") REFERENCES "competence_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_positions" ADD CONSTRAINT "fk_profile_positions_profile" FOREIGN KEY ("profile_id") REFERENCES "competence_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_positions" ADD CONSTRAINT "fk_profile_positions_position" FOREIGN KEY ("position_id") REFERENCES "job_positions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "fk_employees_department" FOREIGN KEY ("department_id") REFERENCES "kadr_departments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "fk_employees_sub_department" FOREIGN KEY ("sub_department_id") REFERENCES "sub_departments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "fk_employees_position" FOREIGN KEY ("position_id") REFERENCES "job_positions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "fk_contracts_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_children" ADD CONSTRAINT "fk_employee_children_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_bank_cards" ADD CONSTRAINT "fk_employee_bank_cards_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_foreign_docs" ADD CONSTRAINT "fk_employee_foreign_docs_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_personal_docs" ADD CONSTRAINT "fk_employee_personal_docs_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_documents" ADD CONSTRAINT "fk_employee_documents_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_badges" ADD CONSTRAINT "fk_employee_badges_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_certificates" ADD CONSTRAINT "fk_kadr_certificates_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_medical_exams" ADD CONSTRAINT "fk_kadr_medical_exams_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "katze_employee_map" ADD CONSTRAINT "fk_katze_employee_map_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "absences" ADD CONSTRAINT "fk_absences_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_requests" ADD CONSTRAINT "fk_vacation_requests_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_entitlements" ADD CONSTRAINT "fk_vacation_entitlements_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_history" ADD CONSTRAINT "fk_vacation_history_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_bonus_days" ADD CONSTRAINT "fk_vacation_bonus_days_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
-- 🔴 PO-9: `vacation_go_days` NAMERNO OSTAJE BEZ FK-a ka `employees`.
-- IZMERENO u sy15: tabela ima SAMO `vacation_go_days_pkey` (nema FK, nema RLS;
-- 5.269 redova, 0 siročadi). FK sa `ON DELETE CASCADE` bio bi PROMENA PONAŠANJA
-- (brisanje zaposlenog odnelo bi i GO istoriju koja u sy15 preživljava), a
-- kadrovska je zamrznuta za dorade. Nalaz je prijavljen, nije popravljen.

-- AddForeignKey
ALTER TABLE "vacation_change_requests" ADD CONSTRAINT "fk_vacation_change_requests_request" FOREIGN KEY ("vacation_request_id") REFERENCES "vacation_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vacation_change_requests" ADD CONSTRAINT "fk_vacation_change_requests_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "makeup_requests" ADD CONSTRAINT "fk_makeup_requests_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "paid_leave_requests" ADD CONSTRAINT "fk_paid_leave_requests_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "nop_requests" ADD CONSTRAINT "fk_nop_requests_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_hours" ADD CONSTRAINT "fk_work_hours_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_hours_remarks" ADD CONSTRAINT "fk_work_hours_remarks_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_events" ADD CONSTRAINT "fk_attendance_events_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attendance_corrections" ADD CONSTRAINT "fk_attendance_corrections_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "salary_terms" ADD CONSTRAINT "fk_salary_terms_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "salary_payroll" ADD CONSTRAINT "fk_salary_payroll_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_plans" ADD CONSTRAINT "fk_development_plans_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_plans" ADD CONSTRAINT "fk_development_plans_mentor" FOREIGN KEY ("mentor_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_plans" ADD CONSTRAINT "fk_development_plans_target_position" FOREIGN KEY ("target_position_id") REFERENCES "job_positions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_checkins" ADD CONSTRAINT "fk_development_checkins_plan" FOREIGN KEY ("plan_id") REFERENCES "development_plans"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "development_checkins" ADD CONSTRAINT "fk_development_checkins_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_expectations" ADD CONSTRAINT "fk_employee_expectations_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_expectations" ADD CONSTRAINT "fk_employee_expectations_plan" FOREIGN KEY ("plan_id") REFERENCES "development_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_talks" ADD CONSTRAINT "fk_employee_talks_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_talks" ADD CONSTRAINT "fk_employee_talks_plan" FOREIGN KEY ("plan_id") REFERENCES "development_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_plans" ADD CONSTRAINT "fk_corrective_plans_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_plans" ADD CONSTRAINT "fk_corrective_plans_talk" FOREIGN KEY ("talk_id") REFERENCES "employee_talks"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_plans" ADD CONSTRAINT "fk_corrective_plans_closing_talk" FOREIGN KEY ("closing_talk_id") REFERENCES "employee_talks"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_measures" ADD CONSTRAINT "fk_corrective_measures_plan" FOREIGN KEY ("plan_id") REFERENCES "corrective_plans"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "corrective_measures" ADD CONSTRAINT "fk_corrective_measures_responsible" FOREIGN KEY ("responsible_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "fk_assessments_cycle" FOREIGN KEY ("cycle_id") REFERENCES "assessment_cycles"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "fk_assessments_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "fk_assessments_plan" FOREIGN KEY ("plan_id") REFERENCES "development_plans"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessments" ADD CONSTRAINT "fk_assessments_profile" FOREIGN KEY ("profile_id") REFERENCES "competence_profiles"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_raters" ADD CONSTRAINT "fk_assessment_raters_assessment" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_raters" ADD CONSTRAINT "fk_assessment_raters_employee" FOREIGN KEY ("rater_employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_scores" ADD CONSTRAINT "fk_assessment_scores_rater" FOREIGN KEY ("rater_id") REFERENCES "assessment_raters"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_scores" ADD CONSTRAINT "fk_assessment_scores_competence" FOREIGN KEY ("competence_id") REFERENCES "competences"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_answers" ADD CONSTRAINT "fk_assessment_answers_rater" FOREIGN KEY ("rater_id") REFERENCES "assessment_raters"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_targets" ADD CONSTRAINT "fk_assessment_targets_assessment" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_targets" ADD CONSTRAINT "fk_assessment_targets_competence" FOREIGN KEY ("competence_id") REFERENCES "competences"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "assessment_results" ADD CONSTRAINT "fk_assessment_results_assessment" FOREIGN KEY ("assessment_id") REFERENCES "assessments"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_onboarding_template_items" ADD CONSTRAINT "fk_kadr_onboarding_template_items_template" FOREIGN KEY ("template_id") REFERENCES "kadr_onboarding_templates"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_onboarding_runs" ADD CONSTRAINT "fk_kadr_onboarding_runs_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_onboarding_runs" ADD CONSTRAINT "fk_kadr_onboarding_runs_template" FOREIGN KEY ("template_id") REFERENCES "kadr_onboarding_templates"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_onboarding_tasks" ADD CONSTRAINT "fk_kadr_onboarding_tasks_run" FOREIGN KEY ("run_id") REFERENCES "kadr_onboarding_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_document_ack" ADD CONSTRAINT "fk_kadr_document_ack_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "kadr_notification_log" ADD CONSTRAINT "fk_kadr_notification_log_employee" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- ---------------------------------------------------------------------------
-- 1. CHECK-ovi prepisani DOSLOVNO sa sy15 (111 komada, `pg_constraint.contype='c'`).
--    Imena su zadržana onakva kakva su u sy15 — u tekstu greške stoji ime
--    ograničenja, a frontend na nekim mestima poredi upravo to ime.
--    🔴 Zatečeni duplikat se PRENOSI kakav jeste (zamrzavanje): `vacation_requests`
--       ima dva istovetna CHECK-a (`vacation_requests_status_check` i `vr_status_chk`).
-- ---------------------------------------------------------------------------
ALTER TABLE absences ADD CONSTRAINT absences_absence_subtype_chk CHECK (((absence_subtype IS NULL) OR (absence_subtype = ANY (ARRAY['obicno'::text, 'povreda_na_radu'::text, 'odrzavanje_trudnoce'::text]))));
ALTER TABLE absences ADD CONSTRAINT absences_dates_valid CHECK ((date_to >= date_from));
ALTER TABLE absences ADD CONSTRAINT absences_paid_reason_check CHECK (((paid_reason IS NULL) OR (paid_reason = ANY (ARRAY['rodjenje'::text, 'svadba'::text, 'smrt'::text, 'selidba'::text, 'ostalo'::text]))));
ALTER TABLE absences ADD CONSTRAINT absences_slobodan_reason_chk CHECK (((slobodan_reason IS NULL) OR (slobodan_reason = ANY (ARRAY['brak'::text, 'rodjenje_deteta'::text, 'selidba'::text, 'smrt_clana_porodice'::text, 'dobrovoljno_davanje_krvi'::text, 'slava'::text, 'ostalo'::text]))));
ALTER TABLE absences ADD CONSTRAINT absences_subtype_consistency_chk CHECK ((((absence_subtype IS NULL) OR (type = 'bolovanje'::text)) AND ((slobodan_reason IS NULL) OR (type = ANY (ARRAY['slobodan'::text, 'placeno'::text])))));
ALTER TABLE absences ADD CONSTRAINT absences_type_check_v2 CHECK ((type = ANY (ARRAY['godisnji'::text, 'bolovanje'::text, 'slobodan'::text, 'placeno'::text, 'neplaceno'::text, 'sluzbeno'::text, 'slava'::text, 'ostalo'::text])));
ALTER TABLE assessment_cycles ADD CONSTRAINT ac_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'closed'::text])));
ALTER TABLE assessment_raters ADD CONSTRAINT ar_kind_chk CHECK ((rater_kind = ANY (ARRAY['self'::text, 'peer'::text, 'leader'::text])));
ALTER TABLE assessment_raters ADD CONSTRAINT ar_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'submitted'::text])));
ALTER TABLE assessment_results ADD CONSTRAINT ares_scope_chk CHECK ((scope_kind = ANY (ARRAY['group'::text, 'competence'::text])));
ALTER TABLE assessment_scores ADD CONSTRAINT asc_level_chk CHECK (((level IS NULL) OR ((level >= 0) AND (level <= 5))));
ALTER TABLE assessment_targets ADD CONSTRAINT at_level_chk CHECK (((target_level IS NULL) OR ((target_level >= 0) AND (target_level <= 5))));
ALTER TABLE assessments ADD CONSTRAINT as_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'collecting'::text, 'closed'::text, 'shared'::text])));
ALTER TABLE attendance_corrections ADD CONSTRAINT attendance_corrections_reason_check CHECK ((length(btrim(reason)) >= 5));
ALTER TABLE attendance_corrections ADD CONSTRAINT attendance_corrections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text])));
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text, 'break'::text, 'official_out'::text, 'other'::text, 'unknown'::text])));
ALTER TABLE attendance_events ADD CONSTRAINT attendance_events_source_check CHECK ((source = ANY (ARRAY['katze'::text, 'katze_manual'::text, 'phone'::text, 'reader'::text, 'face'::text, 'manual'::text, 'kiosk'::text])));
ALTER TABLE company_profile ADD CONSTRAINT company_profile_id_check CHECK ((id = 1));
ALTER TABLE competence_groups ADD CONSTRAINT cg_scope_chk CHECK ((scope = ANY (ARRAY['core'::text, 'strucna'::text, 'liderska'::text])));
ALTER TABLE competence_levels ADD CONSTRAINT cl_level_chk CHECK (((level >= 0) AND (level <= 5)));
ALTER TABLE contracts ADD CONSTRAINT contracts_contract_type_check CHECK ((contract_type = ANY (ARRAY['neodredjeno'::text, 'odredjeno'::text, 'privremeno'::text, 'delo'::text, 'student'::text, 'praksa'::text, 'probni'::text, 'ostalo'::text])));
ALTER TABLE contracts ADD CONSTRAINT contracts_dates_valid CHECK (((date_to IS NULL) OR (date_to >= date_from)));
ALTER TABLE contracts ADD CONSTRAINT contracts_probni_meseci_chk CHECK (((probni_meseci IS NULL) OR ((probni_meseci >= 1) AND (probni_meseci <= 6))));
ALTER TABLE corrective_measures ADD CONSTRAINT corrective_measures_status_check CHECK ((status = ANY (ARRAY['otvoreno'::text, 'u_toku'::text, 'ispunjeno'::text, 'neispunjeno'::text])));
ALTER TABLE corrective_plans ADD CONSTRAINT corrective_plans_status_check CHECK ((status = ANY (ARRAY['otvoren'::text, 'u_toku'::text, 'zatvoren_uspesno'::text, 'zatvoren_neuspesno'::text])));
ALTER TABLE development_checkins ADD CONSTRAINT dc_kind_chk CHECK ((author_kind = ANY (ARRAY['upravljac'::text, 'zaposleni'::text])));
ALTER TABLE development_checkins ADD CONSTRAINT dc_note_chk CHECK ((length(TRIM(BOTH FROM note_md)) > 0));
ALTER TABLE development_plans ADD CONSTRAINT dp_period_chk CHECK ((length(TRIM(BOTH FROM period_label)) > 0));
ALTER TABLE development_plans ADD CONSTRAINT dp_status_chk CHECK ((status = ANY (ARRAY['nacrt'::text, 'aktivan'::text, 'zavrsen'::text, 'arhiviran'::text])));
ALTER TABLE device_push_tokens ADD CONSTRAINT device_push_tokens_platform_check CHECK ((platform = ANY (ARRAY['web'::text, 'android'::text, 'ios'::text])));
ALTER TABLE employee_badges ADD CONSTRAINT employee_badges_badge_type_check CHECK ((badge_type = ANY (ARRAY['media'::text, 'card'::text, 'qr'::text, 'face'::text])));
ALTER TABLE employee_documents ADD CONSTRAINT employee_documents_doc_type_check CHECK ((doc_type = ANY (ARRAY['licna_karta'::text, 'pasos'::text, 'vozacka'::text, 'diploma'::text, 'ugovor'::text, 'ugovor_skan'::text, 'lekarski'::text, 'other'::text, 'aneks'::text, 'resenje_go'::text, 'resenje_porodiljsko'::text, 'potvrda_zaposlenje'::text, 'potvrda_primanja'::text, 'karnet'::text, 'evidencija_go'::text, 'sporazumni_raskid'::text])));
ALTER TABLE employee_documents ADD CONSTRAINT employee_documents_file_name_nonempty CHECK ((length(TRIM(BOTH FROM file_name)) > 0));
ALTER TABLE employee_documents ADD CONSTRAINT employee_documents_storage_path_nonempty CHECK ((length(TRIM(BOTH FROM storage_path)) > 0));
ALTER TABLE employee_expectations ADD CONSTRAINT ee_category_chk CHECK ((category = ANY (ARRAY['strucni'::text, 'sertifikat'::text, 'soft_skill'::text, 'liderstvo'::text, 'ostalo'::text])));
ALTER TABLE employee_expectations ADD CONSTRAINT ee_priority_chk CHECK ((priority = ANY (ARRAY['niska'::text, 'srednja'::text, 'visoka'::text])));
ALTER TABLE employee_expectations ADD CONSTRAINT ee_progress_chk CHECK (((progress >= 0) AND (progress <= 100)));
ALTER TABLE employee_expectations ADD CONSTRAINT ee_status_chk CHECK ((status = ANY (ARRAY['aktivno'::text, 'u_toku'::text, 'ispunjeno'::text, 'otkazano'::text])));
ALTER TABLE employee_expectations ADD CONSTRAINT ee_title_chk CHECK ((length(TRIM(BOTH FROM title)) > 0));
ALTER TABLE employee_talks ADD CONSTRAINT employee_talks_raise_decision_check CHECK ((raise_decision = ANY (ARRAY['da'::text, 'ne'::text, 'odlozeno'::text])));
ALTER TABLE employee_talks ADD CONSTRAINT employee_talks_status_check CHECK ((status = ANY (ARRAY['nacrt'::text, 'podeljen'::text, 'potvrdjen'::text])));
ALTER TABLE employee_talks ADD CONSTRAINT employee_talks_talk_type_check CHECK ((talk_type = ANY (ARRAY['godisnji'::text, 'korektivni'::text, 'jedan_na_jedan'::text, 'ostalo'::text])));
ALTER TABLE employees ADD CONSTRAINT employees_gender_check CHECK (((gender IS NULL) OR (gender = ANY (ARRAY['M'::text, 'Z'::text]))));
ALTER TABLE employees ADD CONSTRAINT employees_personal_id_check CHECK (((personal_id IS NULL) OR (personal_id ~ '^[0-9]{13}$'::text)));
ALTER TABLE employees ADD CONSTRAINT employees_slava_day_check CHECK (((slava_day IS NULL) OR (slava_day ~ '^[0-9]{4}$'::text)));
ALTER TABLE employees ADD CONSTRAINT employees_work_type_check CHECK ((work_type = ANY (ARRAY['ugovor'::text, 'praksa'::text, 'dualno'::text, 'penzioner'::text])));
ALTER TABLE kadr_audit_log ADD CONSTRAINT kadr_audit_action_chk CHECK ((action = ANY (ARRAY['INSERT'::text, 'UPDATE'::text, 'DELETE'::text])));
ALTER TABLE kadr_certificates ADD CONSTRAINT kadr_certificates_cost_chk CHECK ((cost_rsd >= (0)::numeric));
ALTER TABLE kadr_certificates ADD CONSTRAINT kadr_certificates_dates_chk CHECK (((expires_on IS NULL) OR (expires_on >= issued_on)));
ALTER TABLE kadr_medical_exams ADD CONSTRAINT kadr_medical_exams_cost_chk CHECK ((cost_rsd >= (0)::numeric));
ALTER TABLE kadr_medical_exams ADD CONSTRAINT kadr_medical_exams_dates_chk CHECK (((valid_until IS NULL) OR (valid_until >= exam_date)));
ALTER TABLE kadr_medical_exams ADD CONSTRAINT kadr_medical_exams_type_chk CHECK ((exam_type = ANY (ARRAY['redovan'::text, 'prethodni'::text, 'periodicni'::text, 'ciljani'::text, 'vanredni'::text])));
ALTER TABLE kadr_notification_config ADD CONSTRAINT kadr_notification_config_id_check CHECK ((id = 1));
ALTER TABLE kadr_notification_log ADD CONSTRAINT kadr_notif_channel_chk CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'email'::text, 'sms'::text])));
ALTER TABLE kadr_notification_log ADD CONSTRAINT kadr_notif_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'failed'::text, 'canceled'::text])));
ALTER TABLE kadr_notification_log ADD CONSTRAINT kadr_notif_type_chk CHECK ((notification_type = ANY (ARRAY['medical_expiring'::text, 'contract_expiring'::text, 'contract_expiring_today'::text, 'birthday'::text, 'work_anniversary'::text, 'child_birthday'::text, 'birthday_oversight'::text, 'birthday_digest'::text, 'vacation_submitted'::text, 'vacation_approved'::text, 'vacation_rejected'::text, 'vacation_rescheduled'::text, 'vacation_sef_approved'::text, 'makeup_submitted'::text, 'makeup_sef_approved'::text, 'makeup_approved'::text, 'makeup_rejected'::text, 'paidleave_submitted'::text, 'paidleave_sef_approved'::text, 'paidleave_approved'::text, 'paidleave_rejected'::text, 'nop_requested'::text, 'nop_decided'::text, 'payroll_statement'::text, 'account_invite'::text, 'document_issued'::text, 'onboarding_due'::text, 'foreign_doc_expiring'::text, 'foreign_doc_expiring_today'::text, 'bank_card_expiring'::text, 'bank_card_expiring_today'::text, 'talk_shared'::text, 'corrective_overdue'::text, 'corrective_followup'::text, 'personal_doc_expiring'::text, 'personal_doc_expiring_today'::text, 'attendance_missing_punch'::text, 'attendance_correction'::text, 'attendance_weekly_digest'::text])));
ALTER TABLE kadr_onboarding_runs ADD CONSTRAINT kadr_onboarding_runs_kind_check CHECK ((kind = ANY (ARRAY['onboarding'::text, 'offboarding'::text])));
ALTER TABLE kadr_onboarding_runs ADD CONSTRAINT kadr_onboarding_runs_status_check CHECK ((status = ANY (ARRAY['active'::text, 'done'::text, 'canceled'::text])));
ALTER TABLE kadr_onboarding_tasks ADD CONSTRAINT kadr_onboarding_tasks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'skipped'::text])));
ALTER TABLE kadr_onboarding_templates ADD CONSTRAINT kadr_onboarding_templates_kind_check CHECK ((kind = ANY (ARRAY['onboarding'::text, 'offboarding'::text])));
ALTER TABLE katze_employee_map ADD CONSTRAINT katze_employee_map_match_method_check CHECK ((match_method = ANY (ARRAY['auto_exact'::text, 'auto_fuzzy'::text, 'manual'::text])));
ALTER TABLE makeup_requests ADD CONSTRAINT makeup_comp_type_chk CHECK ((compensation_type = ANY (ARRAY['nadoknada'::text, 'dan_odmora'::text])));
ALTER TABLE makeup_requests ADD CONSTRAINT mu_hours_chk CHECK (((absence_hours > (0)::numeric) AND (absence_hours <= (24)::numeric)));
ALTER TABLE makeup_requests ADD CONSTRAINT mu_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'sef_approved'::text, 'approved'::text, 'completed'::text, 'rejected'::text, 'storniran'::text])));
ALTER TABLE nop_requests ADD CONSTRAINT nop_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE paid_leave_requests ADD CONSTRAINT pl_dates_chk CHECK ((date_to >= date_from));
ALTER TABLE paid_leave_requests ADD CONSTRAINT pl_days_chk CHECK ((days_count >= 0));
ALTER TABLE paid_leave_requests ADD CONSTRAINT pl_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'sef_approved'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE paid_leave_requests ADD CONSTRAINT pl_type_chk CHECK ((leave_type = ANY (ARRAY['brak'::text, 'rodjenje_deteta'::text, 'bolest_uze'::text, 'porodjaj_drugi'::text, 'smrt_uze'::text, 'smrt_sire'::text, 'selidba'::text, 'selidba_drugo'::text, 'nepogoda'::text, 'ispit'::text, 'krv'::text, 'ostalo'::text])));
ALTER TABLE salary_payroll ADD CONSTRAINT salary_payroll_month_chk CHECK (((period_month >= 1) AND (period_month <= 12)));
ALTER TABLE salary_payroll ADD CONSTRAINT salary_payroll_nonneg_chk CHECK (((advance_amount >= (0)::numeric) AND (fixed_salary >= (0)::numeric) AND (hours_worked >= (0)::numeric) AND (hourly_rate >= (0)::numeric) AND (transport_rsd >= (0)::numeric) AND (domestic_days >= 0) AND (per_diem_rsd >= (0)::numeric) AND (foreign_days >= 0) AND (per_diem_eur >= (0)::numeric)));
ALTER TABLE salary_payroll ADD CONSTRAINT salary_payroll_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'advance_paid'::text, 'finalized'::text, 'paid'::text])));
ALTER TABLE salary_payroll ADD CONSTRAINT salary_payroll_type_chk CHECK ((salary_type = ANY (ARRAY['ugovor'::text, 'dogovor'::text, 'satnica'::text])));
ALTER TABLE salary_payroll ADD CONSTRAINT salary_payroll_v2_comp_model_chk CHECK (((compensation_model IS NULL) OR (compensation_model = ANY (ARRAY['fiksno'::text, 'dva_dela'::text, 'satnica'::text, 'jednokratno'::text, 'praksa'::text]))));
ALTER TABLE salary_payroll ADD CONSTRAINT salary_payroll_v2_nonneg_chk CHECK (((fond_sati_meseca >= (0)::numeric) AND (redovan_rad_sati >= (0)::numeric) AND (prekovremeni_sati >= (0)::numeric) AND (praznik_placeni_sati >= (0)::numeric) AND (praznik_rad_sati >= (0)::numeric) AND (godisnji_sati >= (0)::numeric) AND (slobodni_dani_sati >= (0)::numeric) AND (bolovanje_65_sati >= (0)::numeric) AND (bolovanje_100_sati >= (0)::numeric) AND (dve_masine_sati >= (0)::numeric) AND (teren_u_zemlji_count >= 0) AND (teren_u_inostranstvu_count >= 0) AND (payable_hours >= (0)::numeric)));
ALTER TABLE salary_payroll ADD CONSTRAINT salary_payroll_year_chk CHECK (((period_year >= 2000) AND (period_year <= 2100)));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_amount_chk CHECK ((amount >= (0)::numeric));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_amount_type_chk CHECK ((amount_type = ANY (ARRAY['neto'::text, 'bruto'::text])));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_cash_nonneg_chk CHECK ((cash_allowance_rsd >= (0)::numeric));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_compensation_model_chk CHECK (((compensation_model IS NULL) OR (compensation_model = ANY (ARRAY['fiksno'::text, 'dva_dela'::text, 'satnica'::text, 'jednokratno'::text, 'praksa'::text]))));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_currency_chk CHECK ((currency = ANY (ARRAY['RSD'::text, 'EUR'::text, 'USD'::text])));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_dates_chk CHECK (((effective_to IS NULL) OR (effective_to >= effective_from)));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_extras_nonneg_chk CHECK (((transport_allowance_rsd >= (0)::numeric) AND (per_diem_rsd >= (0)::numeric) AND (per_diem_eur >= (0)::numeric)));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_pay_window_chk CHECK (((payment_window_override IS NULL) OR (payment_window_override = ANY (ARRAY['01_05'::text, '15_20'::text]))));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_payroll_group_chk CHECK ((payroll_group = ANY (ARRAY['standard'::text, 'olaksice'::text, 'razvoj'::text, 'stranci'::text, 'hapfluid'::text, 'kes'::text])));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_type_chk CHECK ((salary_type = ANY (ARRAY['ugovor'::text, 'dogovor'::text, 'satnica'::text])));
ALTER TABLE salary_terms ADD CONSTRAINT salary_terms_v2_nonneg_chk CHECK (((fixed_amount >= (0)::numeric) AND (fixed_transport_component >= (0)::numeric) AND (fixed_extra_hour_rate >= (0)::numeric) AND (first_part_amount >= (0)::numeric) AND (split_hour_rate >= (0)::numeric) AND (split_transport_amount >= (0)::numeric) AND (hourly_transport_amount >= (0)::numeric) AND (terrain_domestic_rate >= (0)::numeric) AND (terrain_foreign_rate >= (0)::numeric)));
ALTER TABLE vacation_bonus_days ADD CONSTRAINT vacation_bonus_days_days_check CHECK (((days > (0)::numeric) AND (days <= (5)::numeric)));
ALTER TABLE vacation_change_requests ADD CONSTRAINT vacation_change_requests_kind_check CHECK ((kind = ANY (ARRAY['cancel'::text, 'revise'::text])));
ALTER TABLE vacation_change_requests ADD CONSTRAINT vacation_change_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
ALTER TABLE vacation_change_requests ADD CONSTRAINT vcr_revise_has_dates CHECK (((kind <> 'revise'::text) OR ((new_date_from IS NOT NULL) AND (new_date_to IS NOT NULL) AND (new_date_to >= new_date_from) AND (COALESCE(new_days_count, 0) > 0))));
ALTER TABLE vacation_entitlements ADD CONSTRAINT vac_ent_accrual_base_chk CHECK (((accrual_base >= 0) AND (accrual_base <= 365)));
ALTER TABLE vacation_entitlements ADD CONSTRAINT vac_ent_opening_used_chk CHECK (((opening_used >= 0) AND (opening_used <= 365)));
ALTER TABLE vacation_entitlements ADD CONSTRAINT vacation_entitlements_days_carried_over_check CHECK (((days_carried_over >= '-365'::integer) AND (days_carried_over <= 365)));
ALTER TABLE vacation_entitlements ADD CONSTRAINT vacation_entitlements_days_total_check CHECK (((days_total >= 0) AND (days_total <= 365)));
ALTER TABLE vacation_entitlements ADD CONSTRAINT vacation_entitlements_review_flag_chk CHECK (((review_flag IS NULL) OR (review_flag = ANY (ARRAY['overdraw'::text, 'outlier'::text, 'unmatched'::text, 'missing'::text, 'corrected'::text]))));
ALTER TABLE vacation_entitlements ADD CONSTRAINT vacation_entitlements_year_check CHECK (((year >= 2000) AND (year <= 2100)));
ALTER TABLE vacation_requests ADD CONSTRAINT vacation_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sef_approved'::text, 'approved'::text, 'rejected'::text, 'canceled'::text])));
ALTER TABLE vacation_requests ADD CONSTRAINT vr_dates_chk CHECK ((date_to >= date_from));
ALTER TABLE vacation_requests ADD CONSTRAINT vr_days_chk CHECK ((days_count >= 0));
ALTER TABLE vacation_requests ADD CONSTRAINT vr_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'sef_approved'::text, 'approved'::text, 'rejected'::text, 'canceled'::text])));
ALTER TABLE work_hours ADD CONSTRAINT work_hours_absence_code_check_v3 CHECK (((absence_code IS NULL) OR (absence_code = ANY (ARRAY['go'::text, 'bo'::text, 'sp'::text, 'np'::text, 'sl'::text, 'pr'::text, 'sv'::text, 'pl'::text, 'nop'::text]))));
ALTER TABLE work_hours ADD CONSTRAINT work_hours_absence_subtype_chk CHECK (((absence_subtype IS NULL) OR (absence_subtype = ANY (ARRAY['obicno'::text, 'povreda_na_radu'::text, 'odrzavanje_trudnoce'::text]))));
ALTER TABLE work_hours ADD CONSTRAINT work_hours_field_hours_check CHECK (((field_hours >= (0)::numeric) AND (field_hours <= (24)::numeric)));
ALTER TABLE work_hours ADD CONSTRAINT work_hours_field_subtype_check CHECK (((field_subtype IS NULL) OR (field_subtype = ANY (ARRAY['domestic'::text, 'foreign'::text]))));
ALTER TABLE work_hours ADD CONSTRAINT work_hours_hours_check CHECK (((hours >= (0)::numeric) AND (hours <= (24)::numeric)));
ALTER TABLE work_hours ADD CONSTRAINT work_hours_overtime_hours_check CHECK (((overtime_hours >= (0)::numeric) AND (overtime_hours <= (24)::numeric)));
ALTER TABLE work_hours ADD CONSTRAINT work_hours_subtype_consistency_chk CHECK (((absence_subtype IS NULL) OR (absence_code = 'bo'::text)));
ALTER TABLE work_hours ADD CONSTRAINT work_hours_two_machine_hours_check CHECK (((two_machine_hours >= (0)::numeric) AND (two_machine_hours <= (24)::numeric)));
ALTER TABLE work_hours_remarks ADD CONSTRAINT work_hours_remarks_month_check CHECK (((month >= 1) AND (month <= 12)));
ALTER TABLE work_hours_remarks ADD CONSTRAINT work_hours_remarks_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])));

-- ---------------------------------------------------------------------------
-- 2. Parcijalni i funkcijski indeksi (Prisma ih ne ume izraziti) — prepis sa sy15.
--    Devet od njih je UNIQUE sa `WHERE`: to su STVARNA poslovna pravila, ne
--    ubrzanje — npr. `nop_req_pending_uq` (jedan otvoren NOP po danu),
--    `vcr_one_open_per_request` (jedna otvorena molba po GO terminu),
--    `ux_employees_email` (jedan nalog po mejlu). Bez njih baza pušta duplikate.
--
--    NE prenosi se `absences_no_overlap_per_employee` iz `pg_indexes` — to nije
--    samostalan indeks nego pozadina EXCLUDE ograničenja; pravi se u §3.
--    NE prenosi se ni `idx_work_hours_date_only` — u sy15 je BAJT-ZA-BAJT isti kao
--    `idx_work_hours_date` (oba `btree (work_date)`); dupli indeks je mrtav teret,
--    ne ponašanje. Zabeleženo u opisu PR-a kao zatečena redundansa.
-- ---------------------------------------------------------------------------
CREATE INDEX absences_archived_at_idx ON absences USING btree (archived_at) WHERE (archived_at IS NOT NULL);
CREATE INDEX idx_absences_slobodan ON absences USING btree (slobodan_reason) WHERE (slobodan_reason IS NOT NULL);
CREATE INDEX idx_absences_subtype ON absences USING btree (absence_subtype) WHERE (absence_subtype IS NOT NULL);
CREATE INDEX ix_ar_email ON assessment_raters USING btree (lower(rater_email));
CREATE UNIQUE INDEX ux_attendance_corrections_emp_day_active ON attendance_corrections USING btree (employee_id, day) WHERE (status = 'active'::text);
CREATE UNIQUE INDEX ux_attendance_notify_extra ON attendance_notify_extra USING btree (COALESCE(sub_department_id, '-1'::integer), lower(email));
CREATE INDEX contracts_archived_at_idx ON contracts USING btree (archived_at) WHERE (archived_at IS NOT NULL);
CREATE INDEX idx_employee_badges_code_short ON employee_badges USING btree (code_short) WHERE (code_short IS NOT NULL);
CREATE UNIQUE INDEX ux_employee_badges_qr_code ON employee_badges USING btree (code) WHERE ((badge_type = 'qr'::text) AND (is_active = true));
CREATE INDEX idx_employee_children_birth ON employee_children USING btree (birth_date) WHERE (birth_date IS NOT NULL);
CREATE INDEX idx_employee_documents_emp ON employee_documents USING btree (employee_id, uploaded_at DESC) WHERE (deleted_at IS NULL);
CREATE INDEX ix_ee_plan ON employee_expectations USING btree (plan_id) WHERE (plan_id IS NOT NULL);
CREATE INDEX ix_ee_status_active ON employee_expectations USING btree (status, due_date) WHERE (status = ANY (ARRAY['aktivno'::text, 'u_toku'::text]));
CREATE INDEX idx_employees_birth_date ON employees USING btree (birth_date) WHERE (birth_date IS NOT NULL);
CREATE INDEX idx_employees_first_name ON employees USING btree (lower(first_name)) WHERE ((first_name IS NOT NULL) AND (first_name <> ''::text));
CREATE INDEX idx_employees_last_name ON employees USING btree (lower(last_name)) WHERE ((last_name IS NOT NULL) AND (last_name <> ''::text));
CREATE INDEX idx_employees_med_expires ON employees USING btree (medical_exam_expires) WHERE (medical_exam_expires IS NOT NULL);
CREATE INDEX idx_employees_name ON employees USING btree (lower(full_name));
CREATE INDEX idx_employees_team ON employees USING btree (team) WHERE ((team IS NOT NULL) AND (team <> ''::text));
CREATE UNIQUE INDEX ux_employees_card_barcode ON employees USING btree (card_barcode) WHERE ((card_barcode IS NOT NULL) AND (card_barcode <> ''::text));
CREATE UNIQUE INDEX ux_employees_email ON employees USING btree (lower(email)) WHERE ((email IS NOT NULL) AND (email <> ''::text));
CREATE UNIQUE INDEX ux_employees_personal_id ON employees USING btree (personal_id) WHERE ((personal_id IS NOT NULL) AND (personal_id <> ''::text));
CREATE INDEX idx_kadr_audit_actor_time ON kadr_audit_log USING btree (actor_user_id, changed_at DESC) WHERE (actor_user_id IS NOT NULL);
CREATE INDEX idx_kadr_audit_emp_time ON kadr_audit_log USING btree (employee_id, changed_at DESC) WHERE (employee_id IS NOT NULL);
CREATE INDEX idx_kadr_certs_expires ON kadr_certificates USING btree (expires_on) WHERE (expires_on IS NOT NULL);
CREATE INDEX idx_kadr_holidays_year ON kadr_holidays USING btree (((EXTRACT(year FROM holiday_date))::integer));
CREATE INDEX idx_kadr_medical_exams_valid ON kadr_medical_exams USING btree (valid_until) WHERE (valid_until IS NOT NULL);
CREATE INDEX ix_mu_submitted_by ON makeup_requests USING btree (lower(submitted_by));
CREATE UNIQUE INDEX nop_req_pending_uq ON nop_requests USING btree (employee_id, work_date) WHERE (status = 'pending'::text);
CREATE INDEX nop_req_status ON nop_requests USING btree (status) WHERE (status = 'pending'::text);
CREATE INDEX ix_pl_submitted_by ON paid_leave_requests USING btree (lower(submitted_by));
CREATE INDEX idx_salary_terms_active ON salary_terms USING btree (employee_id) WHERE (effective_to IS NULL);
CREATE UNIQUE INDEX uq_vacation_bonus_days_emp_workdate ON vacation_bonus_days USING btree (employee_id, work_date) WHERE (work_date IS NOT NULL);
CREATE UNIQUE INDEX vcr_one_open_per_request ON vacation_change_requests USING btree (vacation_request_id) WHERE (status = 'pending'::text);
CREATE INDEX ix_vr_submitted_by ON vacation_requests USING btree (lower(submitted_by));
CREATE INDEX idx_work_hours_field_subtype ON work_hours USING btree (field_subtype) WHERE (field_subtype IS NOT NULL);
CREATE INDEX idx_work_hours_subtype ON work_hours USING btree (absence_subtype) WHERE (absence_subtype IS NOT NULL);
CREATE INDEX idx_whremarks_status ON work_hours_remarks USING btree (status) WHERE (status = 'open'::text);

-- ---------------------------------------------------------------------------
-- 3. EXCLUDE nad `absences` — brana od preklapajućih AKTIVNIH odsustava.
--
--    🔴 Traži `btree_gist` (poredjenje `employee_id WITH =` unutar GiST indeksa).
--    IZMERENO: 3.0 tu ekstenziju NEMA (`pg_extension` = pg_trgm, plpgsql, unaccent),
--    pa se pravi ovde. `IF NOT EXISTS` da ponovno puštanje ne padne.
--    Bez ovog ograničenja isti radnik može imati godišnji i bolovanje istog dana —
--    frontend hvata PG kod `23P01` i prikazuje toast, tj. oslanja se na bazu.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "absences"
  ADD CONSTRAINT "absences_no_overlap_per_employee"
  EXCLUDE USING gist ("employee_id" WITH =, daterange("date_from", "date_to", '[]'::text) WITH &&)
  WHERE ("archived_at" IS NULL);

-- ---------------------------------------------------------------------------
-- 4. 🔴 NOT NULL nad kolonama-nizovima — vraća se RUČNO.
--
--    Prisma za skalarne liste (`String[]`, `BigInt[]`) u PostgreSQL-u NIKAD ne
--    generiše `NOT NULL` — kolona ostaje nullable iako je u Prisma šemi obavezna.
--    sy15 te tri kolone ima kao `NOT NULL DEFAULT '{}'`, a kod ih čita bez
--    `COALESCE`-a (`event_ids` u `attendance_cancel_correction`, primaoci u
--    `kadr_schedule_*`), pa bi NULL pao kao „cannot iterate over null".
--    Isti obrazac kao §4b u migraciji Održavanja (uuid difoltovi).
-- ---------------------------------------------------------------------------
ALTER TABLE "attendance_corrections"     ALTER COLUMN "event_ids"           SET NOT NULL;
ALTER TABLE "kadr_notification_config"   ALTER COLUMN "whatsapp_recipients" SET NOT NULL;
ALTER TABLE "kadr_notification_config"   ALTER COLUMN "email_recipients"    SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. TRIGERI — SAMO MEHANIKA. Politika i računanje se NE prenose (v. §6).
-- ---------------------------------------------------------------------------

-- 5a. Osvežavanje `updated_at`. U sy15 to radi zajednička `public.update_updated_at()`
--     koju dele svi domeni; u 3.0 dobija svoje ime da ne gazi ništa zatečeno.
--     Trigeri se stavljaju SAMO na 31 tabelu koja ga u sy15 STVARNO ima (izmereno
--     `pg_trigger`). Tabele sa `updated_at` a BEZ trigera (`vacation_history`,
--     `employee_talks`, `corrective_plans`, `corrective_measures`) NE dobijaju ga —
--     dodavanje bi bila promena ponašanja, ne seoba.
CREATE OR REPLACE FUNCTION "kadr_touch_updated_at"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_absences_updated"                 BEFORE UPDATE ON "absences"                 FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_assessments_updated_at"           BEFORE UPDATE ON "assessments"              FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_attendance_corrections_updated"   BEFORE UPDATE ON "attendance_corrections"   FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_bank_cards_updated"               BEFORE UPDATE ON "employee_bank_cards"      FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_company_profile_updated_at"       BEFORE UPDATE ON "company_profile"          FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_competence_groups_updated_at"     BEFORE UPDATE ON "competence_groups"        FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_competence_profiles_updated_at"   BEFORE UPDATE ON "competence_profiles"      FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_competences_updated_at"           BEFORE UPDATE ON "competences"              FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_contracts_updated"                BEFORE UPDATE ON "contracts"                FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_dp_updated_at"                    BEFORE UPDATE ON "development_plans"        FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_ee_updated_at"                    BEFORE UPDATE ON "employee_expectations"    FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_employee_badges_updated"          BEFORE UPDATE ON "employee_badges"          FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_employee_children_updated"        BEFORE UPDATE ON "employee_children"        FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_employees_updated"                BEFORE UPDATE ON "employees"                FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_foreign_docs_updated"             BEFORE UPDATE ON "employee_foreign_docs"    FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_certs_updated_at"            BEFORE UPDATE ON "kadr_certificates"        FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_holidays_updated"            BEFORE UPDATE ON "kadr_holidays"            FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_medical_exams_updated_at"    BEFORE UPDATE ON "kadr_medical_exams"       FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_notif_updated"               BEFORE UPDATE ON "kadr_notification_log"    FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_kadr_notification_config_updated" BEFORE UPDATE ON "kadr_notification_config" FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_katze_employee_map_updated"       BEFORE UPDATE ON "katze_employee_map"       FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_mu_updated_at"                    BEFORE UPDATE ON "makeup_requests"          FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_nopreq_updated"                   BEFORE UPDATE ON "nop_requests"             FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_personal_docs_updated"            BEFORE UPDATE ON "employee_personal_docs"   FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_pl_updated_at"                    BEFORE UPDATE ON "paid_leave_requests"      FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_salary_payroll_updated"           BEFORE UPDATE ON "salary_payroll"           FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_salary_terms_updated"             BEFORE UPDATE ON "salary_terms"             FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_vacation_entitlements_updated"    BEFORE UPDATE ON "vacation_entitlements"    FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_vr_updated_at"                    BEFORE UPDATE ON "vacation_requests"        FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_whremarks_updated"                BEFORE UPDATE ON "work_hours_remarks"       FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();
CREATE TRIGGER "trg_work_hours_updated"               BEFORE UPDATE ON "work_hours"               FOR EACH ROW EXECUTE FUNCTION "kadr_touch_updated_at"();

-- 5b. Popuna `attendance_events.event_ts` iz lokalnog vremena kapije.
--
--     🔴 ZATEČENA MAPA GREŠI: piše da ovaj trigger „puni `event_ts_local`, bez njega
--        kapija upisuje NULL". Telo funkcije radi OBRNUTO — puni `event_ts`
--        (sa zonom) IZ `event_ts_local`. IZMERENO: `event_ts_local IS NULL` na
--        0 od 491.268 redova, tj. lokalno vreme šalje sam most, a baza iz njega
--        izvodi trenutak sa zonom. Prepisano DOSLOVNO, uključujući zonu.
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

-- 5c. Izvođenje `employees.full_name` iz `last_name + first_name`.
--     Čista derivacija (bez prava i bez JWT-a), a `full_name` je UNIQUE i NOT NULL
--     pa bez nje ime ume da se raziđe sa poljima iz kojih se računa.
--     🔴 Zatečeni redosled je „PREZIME IME" (`concat_ws(' ', v_last, v_first)`) —
--        prepisano doslovno, uključujući to što se pri praznom imenu i prezimenu
--        `full_name` NE dira (ostaje zatečena vrednost).
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

CREATE TRIGGER "trg_employees_full_name_sync"
  BEFORE INSERT OR UPDATE OF "first_name", "last_name", "full_name" ON "employees"
  FOR EACH ROW EXECUTE FUNCTION "kadr_employees_sync_full_name"();

-- ---------------------------------------------------------------------------
-- 6. ŠTA MIGRACIJA NAMERNO NE PRENOSI (i gde to živi umesto nje)
-- ---------------------------------------------------------------------------
-- 6.1 73 sy15 funkcije domena (`hr_*`, `kadr_*`, `makeup_*`, `paid_leave_*`,
--     `assessment_*`, `go_ledger`, `attendance_*`…) i 49 RLS politika →
--     posao „funkcije i RLS". Dok njih nema, ove tabele u 3.0 imaju SAMO
--     ograničenja iz ove migracije, a NE i prava. 🔴 To znači da su
--     `salary_terms`/`salary_payroll` u 3.0 privremeno BEZ ijedne brave —
--     jedina brava u sy15 je `current_user_can_view_salary()` (allowlist, 2 mejla),
--     a ona ovde ne postoji. Tabele su prazne, ali NE SMEJU se puniti pre nego
--     što brava stigne.
--
-- 6.2 Trigeri koji nose POLITIKU ili RAČUN — svi ostaju u onom poslu:
--       `employees_sensitive_guard`      (PII brana, zove `current_user_can_manage_employee_pii`)
--       `ee_self_update_guard`, `dp_self_update_guard`, `jp_guard_structural_columns`
--       `absences_archive_guard`
--       `salary_payroll_compute_totals`  (zbirovi obračuna)
--       `salary_payroll_immutability_check` (zaključan obračun)
--       `salary_payroll_set_created_by`, `salary_terms_set_created_by` (čitaju JWT)
--       `salary_terms_close_previous`    (zatvara prethodni period)
--       `vacation_requests_no_overlap`   (preklapanje GO termina)
--       `kadr_medical_exams_sync_employee` (denormalizacija u `employees`)
--       `audit_row_change`, `kadr_audit_log_trigger` (audit; čitaju JWT)
--       `kadr_notify_push_trg`           (web-push otprema)
--
-- 6.3 Podaci. Nijedan red se ne prenosi — to radi zasebna skripta, i tek posle
--     prava. `attendance_events` (~491 hiljada redova / 140 MB, i RASTE — Katze
--     most upisuje na 10 min) je najveći deo posla; prenos mora da računa na to
--     da tabela nije zamrznuta dok traje kopiranje.
--
-- 6.4 Prilozi. `employee_documents.storage_path` i dalje pokazuje na sy15 storage
--     bucket `employee-docs`; prenos binarnog sadržaja nije deo šeme.
--
-- 6.5 `COMMENT ON TABLE/COLUMN` iz sy15 nije prepisan u bazu — isti tekst stoji
--     kao `///` dokumentacija u `prisma/schema.prisma` (konvencija ovog repoa),
--     pa bi duplikat u bazi bio drugi izvor istine.
--
-- 6.6 Pogledi (`v_employees_safe`, `v_attendance_*`) NISU pravljeni: `v_employees_safe`
--     maskira 11 PII kolona pozivom `current_user_can_manage_employee_pii()`, a ta
--     funkcija je u poslu „funkcije i RLS". Pogled bez svoje brane bio bi gori od
--     nepostojećeg pogleda.

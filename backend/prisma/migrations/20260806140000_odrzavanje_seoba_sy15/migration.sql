-- Seoba sy15 -> 3.0, KORAK 2: ODRŽAVANJE (CMMS) (06.08.2026)
-- Merenje i runbook: docs/SEOBA_ODRZAVANJA_2026-08-06.md
-- Plan: docs/PLAN_GASENJA_SY15_2026-08-03.md (korak 2).
--
-- Generisano OFFLINE: `prisma migrate diff` datamodel->datamodel (origin/main schema
-- -> ova grana), po BACKEND_RULES §12 v0.7. `migrate dev` na produkciji je zabranjen;
-- primenjuje se ISKLJUCIVO `migrate:prod` (deploy) uz prethodni `migrate status`.
--
-- ⚠️ Ova migracija SAMO KREIRA 34 prazne tabele. Podatke prenosi
-- backend/scripts/migrate-odrzavanje-sy15.ts (dry-run po difoltu). sy15 se NE dira.
--
-- 🔴 34, a ne 33: `prisma/sy15.prisma` nema model za `maint_wo_number_counter`
-- (deny-all RLS), pa ga „spisak po modelima" promaši — a to je BROJAČ RADNIH
-- NALOGA (izmereno: year=2026, last_value=134, 134/134 naloga ima broj). Bez njega
-- numeracija posle preklopa kreće od nule i sudara se sa postojećim brojevima.
--
-- Redosled `migrate diff`-a poštuje FK; SQL-only dodaci (CHECK-ovi, parcijalni i
-- funkcijski indeksi, 46 FK ka `users`, mehanički trigeri) idu na kraj fajla.

-- CreateTable
CREATE TABLE "maint_assets" (
    "asset_id" UUID NOT NULL,
    "asset_code" TEXT NOT NULL,
    "asset_type" VARCHAR(20) NOT NULL,
    "name" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "location_id" UUID,
    "responsible_user_id" INTEGER,
    "manufacturer" TEXT,
    "model" TEXT,
    "serial_number" TEXT,
    "date_of_purchase" DATE,
    "warranty_until" DATE,
    "supplier" TEXT,
    "qr_token" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "notes" TEXT,
    "archive_reason" TEXT,
    "archived_by" INTEGER,

    CONSTRAINT "pk_maint_assets" PRIMARY KEY ("asset_id")
);

-- CreateTable
CREATE TABLE "maint_machines" (
    "machine_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "serial_number" TEXT,
    "year_of_manufacture" INTEGER,
    "year_commissioned" INTEGER,
    "location" TEXT,
    "department_id" TEXT,
    "power_kw" DECIMAL(6,2),
    "weight_kg" DECIMAL(10,2),
    "notes" TEXT,
    "tracked" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(6),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "responsible_user_id" INTEGER,
    "asset_id" UUID NOT NULL,

    CONSTRAINT "pk_maint_machines" PRIMARY KEY ("machine_code")
);

-- CreateTable
CREATE TABLE "maint_work_orders" (
    "wo_id" UUID NOT NULL,
    "wo_number" TEXT,
    "type" VARCHAR(20) NOT NULL,
    "asset_id" UUID NOT NULL,
    "asset_type" VARCHAR(20) NOT NULL,
    "source_incident_id" UUID,
    "source_preventive_task_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" VARCHAR(20) NOT NULL,
    "safety_marker" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL DEFAULT 'novi',
    "reported_by" INTEGER NOT NULL,
    "assigned_to" INTEGER,
    "due_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "downtime_from" TIMESTAMPTZ(6),
    "downtime_to" TIMESTAMPTZ(6),
    "labor_minutes" INTEGER,
    "cost_total" DECIMAL(10,2),
    "closure_comment" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "vehicle_service_category" VARCHAR(20),
    "odometer_km_at_service" INTEGER,
    "trigger_odometer_km" INTEGER,
    "estimated_cost" DECIMAL(10,2),
    "external_servicer_name" TEXT,
    "service_plan_id" UUID,
    "asset_service_plan_id" UUID,

    CONSTRAINT "pk_maint_work_orders" PRIMARY KEY ("wo_id")
);

-- CreateTable
CREATE TABLE "maint_wo_number_counter" (
    "year" INTEGER NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_maint_wo_number_counter" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "maint_incidents" (
    "id" UUID NOT NULL,
    "machine_code" TEXT NOT NULL,
    "reported_by" INTEGER NOT NULL,
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" VARCHAR(20) NOT NULL DEFAULT 'minor',
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "assigned_to" INTEGER,
    "resolved_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "resolution_notes" TEXT,
    "downtime_minutes" INTEGER,
    "attachment_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "work_order_id" UUID,
    "asset_id" UUID,
    "asset_type" VARCHAR(20),
    "safety_marker" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pk_maint_incidents" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_incident_events" (
    "id" UUID NOT NULL,
    "incident_id" UUID NOT NULL,
    "actor" INTEGER,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_type" TEXT NOT NULL,
    "from_value" TEXT,
    "to_value" TEXT,
    "comment" TEXT,

    CONSTRAINT "pk_maint_incident_events" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_wo_events" (
    "id" UUID NOT NULL,
    "wo_id" UUID NOT NULL,
    "actor" INTEGER,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_type" TEXT NOT NULL,
    "from_value" TEXT,
    "to_value" TEXT,
    "comment" TEXT,

    CONSTRAINT "pk_maint_wo_events" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_wo_labor" (
    "id" UUID NOT NULL,
    "wo_id" UUID NOT NULL,
    "technician_id" INTEGER,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "minutes" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_maint_wo_labor" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_wo_parts" (
    "id" UUID NOT NULL,
    "wo_id" UUID NOT NULL,
    "part_name" TEXT NOT NULL,
    "quantity" DECIMAL(12,4),
    "unit" TEXT,
    "unit_cost" DECIMAL(10,2),
    "supplier" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "part_id" UUID,

    CONSTRAINT "pk_maint_wo_parts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_parts" (
    "part_id" UUID NOT NULL,
    "part_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'kom',
    "supplier_id" UUID,
    "manufacturer" TEXT,
    "model" TEXT,
    "min_stock" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "current_stock" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(12,2),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_parts" PRIMARY KEY ("part_id")
);

-- CreateTable
CREATE TABLE "maint_suppliers" (
    "supplier_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_suppliers" PRIMARY KEY ("supplier_id")
);

-- CreateTable
CREATE TABLE "maint_part_stock_movements" (
    "movement_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "wo_id" UUID,
    "movement_type" VARCHAR(20) NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unit_cost" DECIMAL(12,2),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,

    CONSTRAINT "pk_maint_part_stock_movements" PRIMARY KEY ("movement_id")
);

-- CreateTable
CREATE TABLE "maint_part_vehicles" (
    "asset_id" UUID NOT NULL,
    "part_id" UUID NOT NULL,
    "qty_min" DECIMAL(12,4),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_part_vehicles" PRIMARY KEY ("asset_id","part_id")
);

-- CreateTable
CREATE TABLE "maint_vehicle_details" (
    "asset_id" UUID NOT NULL,
    "registration_plate" TEXT,
    "vin" TEXT,
    "odometer_km" INTEGER,
    "fuel_type" TEXT,
    "registration_expires_at" DATE,
    "insurance_expires_at" DATE,
    "service_due_at" DATE,
    "service_interval_km" INTEGER,
    "next_service_mileage_km" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "year_of_manufacture" SMALLINT,
    "vehicle_kind" VARCHAR(20),
    "payload_kg" INTEGER,
    "passenger_seats" SMALLINT,
    "usage_type" VARCHAR(20),
    "gps_provider" VARCHAR(20) NOT NULL DEFAULT 'nema',
    "gps_device_id" TEXT,
    "first_aid_kit_expires_at" DATE,
    "is_private_vehicle" BOOLEAN NOT NULL DEFAULT false,
    "owner_id" UUID,
    "primary_driver_id" UUID,
    "parts_shelf" TEXT,
    "has_parts_set" BOOLEAN NOT NULL DEFAULT false,
    "parts_notes" TEXT,
    "primary_photo_storage_path" TEXT,
    "toll_tag_serial" TEXT,
    "toll_tag_provider" TEXT,
    "toll_tag_notes" TEXT,

    CONSTRAINT "pk_maint_vehicle_details" PRIMARY KEY ("asset_id")
);

-- CreateTable
CREATE TABLE "maint_vehicle_owners" (
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "owner_type" VARCHAR(20) NOT NULL,
    "contact" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_vehicle_owners" PRIMARY KEY ("owner_id")
);

-- CreateTable
CREATE TABLE "maint_drivers" (
    "driver_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "is_internal" BOOLEAN NOT NULL DEFAULT true,
    "auth_user_id" INTEGER,
    "drivers_license_number" TEXT,
    "drivers_license_categories" TEXT[],
    "drivers_license_valid_until" DATE,
    "id_card_number" TEXT,
    "id_card_valid_until" DATE,
    "medical_check_valid_until" DATE,
    "phone" TEXT,
    "jmbg" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(6),
    "archive_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_drivers" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "maint_vehicle_bookings" (
    "booking_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "driver_id" UUID,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "purpose" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'planirana',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_vehicle_bookings" PRIMARY KEY ("booking_id")
);

-- CreateTable
CREATE TABLE "maint_vehicle_tires" (
    "tire_set_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "season" VARCHAR(20) NOT NULL,
    "dimension" TEXT NOT NULL,
    "count" SMALLINT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'koriscene',
    "shelf_code" TEXT,
    "installed_on_vehicle" BOOLEAN NOT NULL DEFAULT false,
    "purchased_at" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_vehicle_tires" PRIMARY KEY ("tire_set_id")
);

-- CreateTable
CREATE TABLE "maint_vehicle_service_plan" (
    "plan_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "vehicle_service_category" VARCHAR(20),
    "interval_km" INTEGER,
    "interval_months" INTEGER,
    "last_done_at" DATE,
    "last_done_km" INTEGER,
    "notes" TEXT,
    "planned_cost" DECIMAL(10,2),
    "priority" VARCHAR(20) NOT NULL DEFAULT 'p4_planirano',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_vehicle_service_plan" PRIMARY KEY ("plan_id")
);

-- CreateTable
CREATE TABLE "maint_asset_service_plan" (
    "plan_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "interval_months" INTEGER NOT NULL,
    "last_done_at" DATE,
    "notes" TEXT,
    "planned_cost" DECIMAL(10,2),
    "priority" VARCHAR(20) NOT NULL DEFAULT 'p4_planirano',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_asset_service_plan" PRIMARY KEY ("plan_id")
);

-- CreateTable
CREATE TABLE "maint_tasks" (
    "id" UUID NOT NULL,
    "machine_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "instructions" TEXT,
    "interval_value" INTEGER NOT NULL,
    "interval_unit" VARCHAR(20) NOT NULL,
    "severity" VARCHAR(20) NOT NULL DEFAULT 'normal',
    "required_role" VARCHAR(20) NOT NULL DEFAULT 'operator',
    "grace_period_days" INTEGER NOT NULL DEFAULT 3,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,
    "checklist_template" JSONB NOT NULL,
    "asset_id" UUID,

    CONSTRAINT "pk_maint_tasks" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_checks" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "machine_code" TEXT NOT NULL,
    "performed_by" INTEGER NOT NULL,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" VARCHAR(20) NOT NULL,
    "notes" TEXT,
    "attachment_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_checks" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_documents" (
    "document_id" UUID NOT NULL,
    "entity_type" VARCHAR(20) NOT NULL,
    "entity_id" UUID NOT NULL,
    "asset_id" UUID,
    "wo_id" UUID,
    "incident_id" UUID,
    "preventive_task_id" UUID,
    "file_name" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" BIGINT,
    "category" TEXT,
    "description" TEXT,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" INTEGER,
    "deleted_at" TIMESTAMPTZ(6),
    "valid_until" DATE,
    "driver_id" UUID,

    CONSTRAINT "pk_maint_documents" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "maint_machine_files" (
    "id" UUID NOT NULL,
    "machine_code" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_path" TEXT NOT NULL,
    "mime_type" TEXT,
    "size_bytes" BIGINT,
    "category" TEXT,
    "description" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_by" INTEGER,

    CONSTRAINT "pk_maint_machine_files" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_machine_notes" (
    "id" UUID NOT NULL,
    "machine_code" TEXT NOT NULL,
    "author" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_maint_machine_notes" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_machine_status_override" (
    "machine_code" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "reason" TEXT NOT NULL,
    "set_by" INTEGER NOT NULL,
    "set_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMPTZ(6),

    CONSTRAINT "pk_maint_machine_status_override" PRIMARY KEY ("machine_code")
);

-- CreateTable
CREATE TABLE "maint_machines_deletion_log" (
    "id" UUID NOT NULL,
    "machine_code" TEXT NOT NULL,
    "machine_name" TEXT,
    "snapshot" JSONB NOT NULL,
    "related_counts" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_by" INTEGER,
    "deleted_by_email" TEXT,

    CONSTRAINT "pk_maint_machines_deletion_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_locations" (
    "location_id" UUID NOT NULL,
    "parent_location_id" UUID,
    "location_type" TEXT NOT NULL DEFAULT 'lokacija',
    "code" TEXT,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_maint_locations" PRIMARY KEY ("location_id")
);

-- CreateTable
CREATE TABLE "maint_it_asset_details" (
    "asset_id" UUID NOT NULL,
    "device_type" TEXT,
    "hostname" TEXT,
    "ip_address" INET,
    "mac_address" TEXT,
    "operating_system" TEXT,
    "assigned_to" TEXT,
    "license_key" TEXT,
    "license_expires_at" DATE,
    "warranty_expires_at" DATE,
    "backup_required" BOOLEAN NOT NULL DEFAULT false,
    "last_backup_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "cpu" TEXT,
    "motherboard" TEXT,
    "ram" TEXT,
    "gpu" TEXT,
    "office_location" TEXT,
    "toner_cartridges" TEXT,
    "unifi_ports" TEXT,
    "power_rating" TEXT,
    "firmware_version" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_it_asset_details" PRIMARY KEY ("asset_id")
);

-- CreateTable
CREATE TABLE "maint_facility_details" (
    "asset_id" UUID NOT NULL,
    "facility_type" TEXT,
    "floor_area_m2" DECIMAL(12,2),
    "floor_or_zone" TEXT,
    "criticality" TEXT,
    "inspection_due_at" DATE,
    "fire_safety_due_at" DATE,
    "service_contract" TEXT,
    "service_provider" TEXT,
    "last_inspection_at" DATE,
    "cadastral_parcels" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_facility_details" PRIMARY KEY ("asset_id")
);

-- CreateTable
CREATE TABLE "maint_user_profiles" (
    "user_id" INTEGER NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'operator',
    "telegram_chat_id" TEXT,
    "assigned_machine_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phone" TEXT,

    CONSTRAINT "pk_maint_user_profiles" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "maint_notification_log" (
    "id" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "recipient" TEXT NOT NULL,
    "recipient_user_id" INTEGER,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "related_entity_type" TEXT,
    "related_entity_id" UUID,
    "machine_code" TEXT,
    "escalation_level" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,

    CONSTRAINT "pk_maint_notification_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maint_notification_rules" (
    "rule_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "severity" TEXT,
    "asset_type" VARCHAR(20),
    "target_role" VARCHAR(20),
    "channel" VARCHAR(20) NOT NULL,
    "delay_minutes" INTEGER NOT NULL DEFAULT 0,
    "escalation_level" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_notification_rules" PRIMARY KEY ("rule_id")
);

-- CreateTable
CREATE TABLE "maint_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "auto_create_wo_major" BOOLEAN NOT NULL DEFAULT true,
    "auto_create_wo_critical" BOOLEAN NOT NULL DEFAULT true,
    "safety_marker_requires_wo" BOOLEAN NOT NULL DEFAULT true,
    "default_wo_priority" VARCHAR(20) NOT NULL DEFAULT 'p4_planirano',
    "major_wo_due_hours" INTEGER NOT NULL DEFAULT 48,
    "critical_wo_due_hours" INTEGER NOT NULL DEFAULT 8,
    "preventive_due_warning_days" INTEGER NOT NULL DEFAULT 7,
    "notification_enabled" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_major_incident" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_critical_incident" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_overdue_preventive" BOOLEAN NOT NULL DEFAULT true,
    "notification_channels" TEXT[] DEFAULT ARRAY['in_app']::TEXT[],
    "status_labels" JSONB NOT NULL,
    "wo_status_labels" JSONB NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" INTEGER,

    CONSTRAINT "pk_maint_settings" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_maint_machines_asset" ON "maint_machines"("asset_id");

-- CreateIndex
CREATE INDEX "idx_maint_wo_asset" ON "maint_work_orders"("asset_id");

-- CreateIndex
CREATE INDEX "idx_maint_wo_assigned" ON "maint_work_orders"("assigned_to");

-- CreateIndex
CREATE INDEX "idx_maint_wo_due" ON "maint_work_orders"("due_at");

-- CreateIndex
CREATE INDEX "idx_maint_wo_status" ON "maint_work_orders"("status");

-- CreateIndex
CREATE INDEX "idx_maint_wo_source_incident" ON "maint_work_orders"("source_incident_id");

-- CreateIndex
CREATE INDEX "idx_maint_incidents_machine" ON "maint_incidents"("machine_code");

-- CreateIndex
CREATE INDEX "idx_maint_incident_events_incident" ON "maint_incident_events"("incident_id", "at");

-- CreateIndex
CREATE INDEX "idx_maint_wo_events_wo" ON "maint_wo_events"("wo_id", "at" DESC);

-- CreateIndex
CREATE INDEX "idx_maint_wo_labor_wo" ON "maint_wo_labor"("wo_id");

-- CreateIndex
CREATE INDEX "idx_maint_wo_parts_wo" ON "maint_wo_parts"("wo_id");

-- CreateIndex
CREATE INDEX "idx_maint_wo_parts_part" ON "maint_wo_parts"("part_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_maint_parts_code" ON "maint_parts"("part_code");

-- CreateIndex
CREATE INDEX "idx_maint_parts_supplier" ON "maint_parts"("supplier_id");

-- CreateIndex
CREATE INDEX "idx_maint_parts_active_name" ON "maint_parts"("active", "name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_maint_suppliers_name" ON "maint_suppliers"("name");

-- CreateIndex
CREATE INDEX "idx_maint_stock_movements_part" ON "maint_part_stock_movements"("part_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_maint_stock_movements_wo" ON "maint_part_stock_movements"("wo_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_maint_part_vehicles_part" ON "maint_part_vehicles"("part_id");

-- CreateIndex
CREATE INDEX "idx_maint_vehicle_details_registration_due" ON "maint_vehicle_details"("registration_expires_at");

-- CreateIndex
CREATE INDEX "idx_maint_vehicle_details_service_due" ON "maint_vehicle_details"("service_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_maint_vehicle_owners_name" ON "maint_vehicle_owners"("name");

-- CreateIndex
CREATE INDEX "idx_maint_vehicle_owners_type" ON "maint_vehicle_owners"("owner_type");

-- CreateIndex
CREATE INDEX "idx_maint_bookings_asset" ON "maint_vehicle_bookings"("asset_id", "start_at");

-- CreateIndex
CREATE INDEX "idx_maint_vehicle_tires_asset" ON "maint_vehicle_tires"("asset_id");

-- CreateIndex
CREATE INDEX "idx_maint_vehicle_tires_season" ON "maint_vehicle_tires"("asset_id", "season");

-- CreateIndex
CREATE INDEX "idx_maint_checks_machine_time" ON "maint_checks"("machine_code", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "idx_maint_checks_task_time" ON "maint_checks"("task_id", "performed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_maint_documents_storage_path" ON "maint_documents"("storage_path");

-- CreateIndex
CREATE UNIQUE INDEX "uq_maint_machine_files_storage_path" ON "maint_machine_files"("storage_path");

-- CreateIndex
CREATE INDEX "idx_maint_mmdl_code" ON "maint_machines_deletion_log"("machine_code");

-- CreateIndex
CREATE INDEX "idx_maint_mmdl_at" ON "maint_machines_deletion_log"("deleted_at" DESC);

-- CreateIndex
CREATE INDEX "idx_maint_it_asset_license_due" ON "maint_it_asset_details"("license_expires_at");

-- CreateIndex
CREATE INDEX "idx_maint_it_asset_warranty_due" ON "maint_it_asset_details"("warranty_expires_at");

-- CreateIndex
CREATE INDEX "idx_maint_facility_criticality" ON "maint_facility_details"("criticality");

-- CreateIndex
CREATE INDEX "idx_maint_facility_inspection_due" ON "maint_facility_details"("inspection_due_at");

-- CreateIndex
CREATE INDEX "idx_maint_facility_fire_safety_due" ON "maint_facility_details"("fire_safety_due_at");

-- CreateIndex
CREATE INDEX "idx_maint_notif_entity" ON "maint_notification_log"("related_entity_type", "related_entity_id");

-- CreateIndex
CREATE INDEX "idx_maint_notif_machine" ON "maint_notification_log"("machine_code", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_maint_notification_rules_match" ON "maint_notification_rules"("event_type", "severity", "asset_type", "enabled");

-- AddForeignKey
ALTER TABLE "maint_assets" ADD CONSTRAINT "fk_maint_assets_location" FOREIGN KEY ("location_id") REFERENCES "maint_locations"("location_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_machines" ADD CONSTRAINT "fk_maint_machines_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_work_orders" ADD CONSTRAINT "fk_maint_wo_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_work_orders" ADD CONSTRAINT "fk_maint_wo_source_incident" FOREIGN KEY ("source_incident_id") REFERENCES "maint_incidents"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_work_orders" ADD CONSTRAINT "fk_maint_wo_source_task" FOREIGN KEY ("source_preventive_task_id") REFERENCES "maint_tasks"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_work_orders" ADD CONSTRAINT "fk_maint_wo_service_plan" FOREIGN KEY ("service_plan_id") REFERENCES "maint_vehicle_service_plan"("plan_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_work_orders" ADD CONSTRAINT "fk_maint_wo_asset_service_plan" FOREIGN KEY ("asset_service_plan_id") REFERENCES "maint_asset_service_plan"("plan_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_incidents" ADD CONSTRAINT "fk_maint_incidents_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_incidents" ADD CONSTRAINT "fk_maint_incidents_work_order" FOREIGN KEY ("work_order_id") REFERENCES "maint_work_orders"("wo_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_incident_events" ADD CONSTRAINT "fk_maint_incident_events_incident" FOREIGN KEY ("incident_id") REFERENCES "maint_incidents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_wo_events" ADD CONSTRAINT "fk_maint_wo_events_wo" FOREIGN KEY ("wo_id") REFERENCES "maint_work_orders"("wo_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_wo_labor" ADD CONSTRAINT "fk_maint_wo_labor_wo" FOREIGN KEY ("wo_id") REFERENCES "maint_work_orders"("wo_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_wo_parts" ADD CONSTRAINT "fk_maint_wo_parts_wo" FOREIGN KEY ("wo_id") REFERENCES "maint_work_orders"("wo_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_wo_parts" ADD CONSTRAINT "fk_maint_wo_parts_part" FOREIGN KEY ("part_id") REFERENCES "maint_parts"("part_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_parts" ADD CONSTRAINT "fk_maint_parts_supplier" FOREIGN KEY ("supplier_id") REFERENCES "maint_suppliers"("supplier_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_part_stock_movements" ADD CONSTRAINT "fk_maint_stock_movements_part" FOREIGN KEY ("part_id") REFERENCES "maint_parts"("part_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_part_stock_movements" ADD CONSTRAINT "fk_maint_stock_movements_wo" FOREIGN KEY ("wo_id") REFERENCES "maint_work_orders"("wo_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_part_vehicles" ADD CONSTRAINT "fk_maint_part_vehicles_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_part_vehicles" ADD CONSTRAINT "fk_maint_part_vehicles_part" FOREIGN KEY ("part_id") REFERENCES "maint_parts"("part_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_vehicle_details" ADD CONSTRAINT "fk_maint_vehicle_details_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_vehicle_details" ADD CONSTRAINT "fk_maint_vehicle_details_owner" FOREIGN KEY ("owner_id") REFERENCES "maint_vehicle_owners"("owner_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_vehicle_details" ADD CONSTRAINT "fk_maint_vehicle_details_driver" FOREIGN KEY ("primary_driver_id") REFERENCES "maint_drivers"("driver_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_vehicle_bookings" ADD CONSTRAINT "fk_maint_bookings_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_vehicle_bookings" ADD CONSTRAINT "fk_maint_bookings_driver" FOREIGN KEY ("driver_id") REFERENCES "maint_drivers"("driver_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_vehicle_tires" ADD CONSTRAINT "fk_maint_vehicle_tires_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_vehicle_service_plan" ADD CONSTRAINT "fk_maint_vsp_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_asset_service_plan" ADD CONSTRAINT "fk_maint_asp_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_tasks" ADD CONSTRAINT "fk_maint_tasks_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_checks" ADD CONSTRAINT "fk_maint_checks_task" FOREIGN KEY ("task_id") REFERENCES "maint_tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_documents" ADD CONSTRAINT "fk_maint_documents_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_documents" ADD CONSTRAINT "fk_maint_documents_wo" FOREIGN KEY ("wo_id") REFERENCES "maint_work_orders"("wo_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_documents" ADD CONSTRAINT "fk_maint_documents_incident" FOREIGN KEY ("incident_id") REFERENCES "maint_incidents"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_documents" ADD CONSTRAINT "fk_maint_documents_task" FOREIGN KEY ("preventive_task_id") REFERENCES "maint_tasks"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_documents" ADD CONSTRAINT "fk_maint_documents_driver" FOREIGN KEY ("driver_id") REFERENCES "maint_drivers"("driver_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_locations" ADD CONSTRAINT "fk_maint_locations_parent" FOREIGN KEY ("parent_location_id") REFERENCES "maint_locations"("location_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_it_asset_details" ADD CONSTRAINT "fk_maint_it_details_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "maint_facility_details" ADD CONSTRAINT "fk_maint_facility_details_asset" FOREIGN KEY ("asset_id") REFERENCES "maint_assets"("asset_id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- ===========================================================================
-- SQL-only deo (Prisma ga ne ume izraziti) — sve prepisano sa ŽIVE sy15,
-- ne iz dokumentacije: `pg_constraint`, `pg_indexes`, `pg_trigger`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. CHECK-ovi umesto 23 PG enum tipa (BACKEND_RULES §2.2, prenosna odluka 3).
--    Skup vrednosti je IDENTIČAN sy15 enumima (`pg_enum`, izmereno 06.08.2026).
-- ---------------------------------------------------------------------------
ALTER TABLE "maint_assets"
  ADD CONSTRAINT "ck_maint_assets_asset_type" CHECK ("asset_type" IN ('machine','vehicle','it','facility')),
  ADD CONSTRAINT "ck_maint_assets_status" CHECK ("status" IN ('running','degraded','down','maintenance'));

ALTER TABLE "maint_work_orders"
  ADD CONSTRAINT "ck_maint_wo_type" CHECK ("type" IN ('kvar','preventiva','inspekcija','servis','administrativni','incident','preventive')),
  ADD CONSTRAINT "ck_maint_wo_asset_type" CHECK ("asset_type" IN ('machine','vehicle','it','facility')),
  ADD CONSTRAINT "ck_maint_wo_priority" CHECK ("priority" IN ('p1_zastoj','p2_smetnja','p3_manje','p4_planirano')),
  ADD CONSTRAINT "ck_maint_wo_status" CHECK ("status" IN ('novi','potvrden','dodeljen','u_radu','ceka_deo','ceka_dobavljaca','ceka_korisnika','kontrola','zavrsen','otkazan')),
  ADD CONSTRAINT "ck_maint_wo_vehicle_category" CHECK ("vehicle_service_category" IS NULL OR "vehicle_service_category" IN ('mali','veliki','kocnice','elektrika','oslanjanje','motor_transmisija','karoserija','odluka_o_zameni','ostalo'));

ALTER TABLE "maint_incidents"
  ADD CONSTRAINT "ck_maint_incidents_severity" CHECK ("severity" IN ('minor','major','critical')),
  ADD CONSTRAINT "ck_maint_incidents_status" CHECK ("status" IN ('open','acknowledged','in_progress','awaiting_parts','resolved','closed')),
  ADD CONSTRAINT "ck_maint_incidents_asset_type" CHECK ("asset_type" IS NULL OR "asset_type" IN ('machine','vehicle','it','facility'));

ALTER TABLE "maint_documents"
  ADD CONSTRAINT "ck_maint_documents_entity_type" CHECK ("entity_type" IN ('asset','work_order','incident','preventive_task','driver'));

ALTER TABLE "maint_checks"
  ADD CONSTRAINT "ck_maint_checks_result" CHECK ("result" IN ('ok','warning','fail','skipped'));

ALTER TABLE "maint_tasks"
  ADD CONSTRAINT "ck_maint_tasks_interval_unit" CHECK ("interval_unit" IN ('hours','days','weeks','months')),
  ADD CONSTRAINT "ck_maint_tasks_severity" CHECK ("severity" IN ('normal','important','critical')),
  ADD CONSTRAINT "ck_maint_tasks_required_role" CHECK ("required_role" IN ('operator','technician','chief','management','admin'));

ALTER TABLE "maint_user_profiles"
  ADD CONSTRAINT "ck_maint_user_profiles_role" CHECK ("role" IN ('operator','technician','chief','management','admin'));

ALTER TABLE "maint_notification_log"
  ADD CONSTRAINT "ck_maint_notif_log_channel" CHECK ("channel" IN ('telegram','email','in_app','whatsapp')),
  ADD CONSTRAINT "ck_maint_notif_log_status" CHECK ("status" IN ('queued','sent','failed'));

ALTER TABLE "maint_notification_rules"
  ADD CONSTRAINT "ck_maint_notif_rules_channel" CHECK ("channel" IN ('telegram','email','in_app','whatsapp')),
  ADD CONSTRAINT "ck_maint_notif_rules_asset_type" CHECK ("asset_type" IS NULL OR "asset_type" IN ('machine','vehicle','it','facility')),
  ADD CONSTRAINT "ck_maint_notif_rules_target_role" CHECK ("target_role" IS NULL OR "target_role" IN ('operator','technician','chief','management','admin'));

ALTER TABLE "maint_part_stock_movements"
  ADD CONSTRAINT "ck_maint_stock_movement_type" CHECK ("movement_type" IN ('in','out','adjustment','return'));

ALTER TABLE "maint_vehicle_details"
  ADD CONSTRAINT "ck_maint_vd_vehicle_kind" CHECK ("vehicle_kind" IS NULL OR "vehicle_kind" IN ('teretno','putnicko','kombi','radno','prikolica')),
  ADD CONSTRAINT "ck_maint_vd_usage_type" CHECK ("usage_type" IS NULL OR "usage_type" IN ('posao','posao_kuca','licne_potrebe')),
  ADD CONSTRAINT "ck_maint_vd_gps_provider" CHECK ("gps_provider" IN ('nema','smartivo','drugi'));

ALTER TABLE "maint_vehicle_owners"
  ADD CONSTRAINT "ck_maint_vehicle_owner_type" CHECK ("owner_type" IN ('firma','leasing','zaposleni','spoljni'));

ALTER TABLE "maint_vehicle_bookings"
  ADD CONSTRAINT "ck_maint_booking_status" CHECK ("status" IN ('planirana','u_toku','zavrsena','otkazana'));

ALTER TABLE "maint_vehicle_tires"
  ADD CONSTRAINT "ck_maint_tire_season" CHECK ("season" IN ('summer','winter','all_season')),
  ADD CONSTRAINT "ck_maint_tire_status" CHECK ("status" IN ('nove','koriscene','dotrajale','bacene'));

ALTER TABLE "maint_vehicle_service_plan"
  ADD CONSTRAINT "ck_maint_vsp_category" CHECK ("vehicle_service_category" IS NULL OR "vehicle_service_category" IN ('mali','veliki','kocnice','elektrika','oslanjanje','motor_transmisija','karoserija','odluka_o_zameni','ostalo')),
  ADD CONSTRAINT "ck_maint_vsp_priority" CHECK ("priority" IN ('p1_zastoj','p2_smetnja','p3_manje','p4_planirano'));

ALTER TABLE "maint_asset_service_plan"
  ADD CONSTRAINT "ck_maint_asp_priority" CHECK ("priority" IN ('p1_zastoj','p2_smetnja','p3_manje','p4_planirano'));

ALTER TABLE "maint_machine_status_override"
  ADD CONSTRAINT "ck_maint_override_status" CHECK ("status" IN ('running','degraded','down','maintenance'));

ALTER TABLE "maint_settings"
  ADD CONSTRAINT "ck_maint_settings_default_priority" CHECK ("default_wo_priority" IN ('p1_zastoj','p2_smetnja','p3_manje','p4_planirano')),
  ADD CONSTRAINT "ck_maint_settings_channels" CHECK ("notification_channels" <@ ARRAY['telegram','email','in_app','whatsapp']::text[]);

-- ---------------------------------------------------------------------------
-- 2. CHECK-ovi prepisani DOSLOVNO sa sy15 (53 komada, `pg_constraint.contype='c'`).
-- ---------------------------------------------------------------------------
ALTER TABLE "maint_asset_service_plan"
  ADD CONSTRAINT "maint_asp_interval_positive" CHECK ("interval_months" > 0),
  ADD CONSTRAINT "maint_asp_name_nonempty" CHECK (length(btrim("name")) > 0);

ALTER TABLE "maint_assets"
  ADD CONSTRAINT "maint_assets_code_nonempty" CHECK (length(btrim("asset_code")) > 0),
  ADD CONSTRAINT "maint_assets_name_nonempty" CHECK (length(btrim("name")) > 0);

-- ⚠️ ZATEČENA NEDOSLEDNOST 1.0, prenosi se DOSLOVNO (ne „popravlja se" u seobi):
--    `maint_documents_entity_fk_chk` DOZVOLJAVA `entity_type='driver'`, a
--    `maint_documents_entity_match` ga NE nabraja — pa dokument vozača ne može
--    da postoji iako ga UI nudi. Izmereno: `maint_documents` ima 3 reda
--    (asset 2, work_order 1), nijedan `driver` — dosledno sa strožim CHECK-om.
--    Popravka je odluka o proizvodu, ne o seobi (v. runbook, poznati repovi).
ALTER TABLE "maint_documents"
  ADD CONSTRAINT "maint_documents_entity_fk_chk" CHECK (
    ("entity_type" = 'asset' AND "asset_id" IS NOT NULL AND "entity_id" = "asset_id")
    OR ("entity_type" = 'work_order' AND "wo_id" IS NOT NULL AND "entity_id" = "wo_id")
    OR ("entity_type" = 'incident' AND "incident_id" IS NOT NULL AND "entity_id" = "incident_id")
    OR ("entity_type" = 'preventive_task' AND "preventive_task_id" IS NOT NULL AND "entity_id" = "preventive_task_id")
    OR ("entity_type" = 'driver' AND "driver_id" IS NOT NULL AND "entity_id" = "driver_id")),
  ADD CONSTRAINT "maint_documents_entity_match" CHECK (
    ("entity_type" = 'asset' AND "asset_id" = "entity_id")
    OR ("entity_type" = 'work_order' AND "wo_id" = "entity_id")
    OR ("entity_type" = 'incident' AND "incident_id" = "entity_id")
    OR ("entity_type" = 'preventive_task' AND "preventive_task_id" = "entity_id")),
  ADD CONSTRAINT "maint_documents_file_name_nonempty" CHECK (length(btrim("file_name")) > 0),
  ADD CONSTRAINT "maint_documents_storage_path_nonempty" CHECK (length(btrim("storage_path")) > 0);

ALTER TABLE "maint_drivers"
  ADD CONSTRAINT "maint_drivers_internal_implies_user" CHECK ("is_internal" = true OR "auth_user_id" IS NULL),
  ADD CONSTRAINT "maint_drivers_license_cats_nonempty" CHECK ("drivers_license_categories" IS NULL OR cardinality("drivers_license_categories") > 0),
  ADD CONSTRAINT "maint_drivers_name_nonempty" CHECK (length(btrim("full_name")) > 0);

ALTER TABLE "maint_facility_details"
  ADD CONSTRAINT "maint_facility_area_nonnegative" CHECK ("floor_area_m2" IS NULL OR "floor_area_m2" >= 0),
  ADD CONSTRAINT "maint_facility_criticality_valid" CHECK ("criticality" IS NULL OR "criticality" IN ('low','medium','high','critical'));

ALTER TABLE "maint_incidents"
  ADD CONSTRAINT "maint_incidents_machine_nonempty" CHECK (length(btrim("machine_code")) > 0);

ALTER TABLE "maint_locations"
  ADD CONSTRAINT "maint_locations_name_nonempty" CHECK (length(btrim("name")) > 0);

ALTER TABLE "maint_machine_notes"
  ADD CONSTRAINT "maint_notes_machine_nonempty" CHECK (length(btrim("machine_code")) > 0);

ALTER TABLE "maint_machine_status_override"
  ADD CONSTRAINT "maint_override_machine_nonempty" CHECK (length(btrim("machine_code")) > 0);

ALTER TABLE "maint_machines"
  ADD CONSTRAINT "maint_machines_source_chk" CHECK ("source" IN ('bigtehn','manual')),
  ADD CONSTRAINT "maint_machines_year_com_sane" CHECK ("year_commissioned" IS NULL OR ("year_commissioned" >= 1900 AND "year_commissioned" <= (EXTRACT(year FROM now()))::int + 1)),
  ADD CONSTRAINT "maint_machines_year_mfr_sane" CHECK ("year_of_manufacture" IS NULL OR ("year_of_manufacture" >= 1900 AND "year_of_manufacture" <= (EXTRACT(year FROM now()))::int + 1));

ALTER TABLE "maint_machines_deletion_log"
  ADD CONSTRAINT "mmdl_reason_not_blank" CHECK (length(btrim("reason")) >= 5);

ALTER TABLE "maint_notification_rules"
  ADD CONSTRAINT "maint_notification_rules_delay_nonnegative" CHECK ("delay_minutes" >= 0 AND "escalation_level" >= 0),
  ADD CONSTRAINT "maint_notification_rules_event_nonempty" CHECK (length(btrim("event_type")) > 0);

ALTER TABLE "maint_part_stock_movements"
  ADD CONSTRAINT "maint_part_stock_qty_valid" CHECK (
    ("movement_type" = 'adjustment' AND "quantity" <> 0)
    OR ("movement_type" <> 'adjustment' AND "quantity" > 0));

ALTER TABLE "maint_part_vehicles"
  ADD CONSTRAINT "maint_part_vehicles_qty_min_nonneg" CHECK ("qty_min" IS NULL OR "qty_min" >= 0);

ALTER TABLE "maint_parts"
  ADD CONSTRAINT "maint_parts_code_nonempty" CHECK (length(btrim("part_code")) > 0),
  ADD CONSTRAINT "maint_parts_min_stock_nonnegative" CHECK ("min_stock" >= 0),
  ADD CONSTRAINT "maint_parts_name_nonempty" CHECK (length(btrim("name")) > 0);

ALTER TABLE "maint_settings"
  ADD CONSTRAINT "maint_settings_due_hours_positive" CHECK ("major_wo_due_hours" > 0 AND "critical_wo_due_hours" > 0 AND "preventive_due_warning_days" >= 0),
  ADD CONSTRAINT "maint_settings_id_check" CHECK ("id" = 1);

ALTER TABLE "maint_suppliers"
  ADD CONSTRAINT "maint_suppliers_name_nonempty" CHECK (length(btrim("name")) > 0);

ALTER TABLE "maint_tasks"
  ADD CONSTRAINT "maint_tasks_grace_period_days_check" CHECK ("grace_period_days" >= 0),
  ADD CONSTRAINT "maint_tasks_interval_value_check" CHECK ("interval_value" > 0),
  ADD CONSTRAINT "maint_tasks_machine_code_nonempty" CHECK (length(btrim("machine_code")) > 0);

ALTER TABLE "maint_vehicle_bookings"
  ADD CONSTRAINT "maint_booking_end_after_start" CHECK ("end_at" > "start_at");

ALTER TABLE "maint_vehicle_details"
  ADD CONSTRAINT "maint_vehicle_details_payload_chk" CHECK ("payload_kg" IS NULL OR "payload_kg" >= 0),
  ADD CONSTRAINT "maint_vehicle_details_seats_chk" CHECK ("passenger_seats" IS NULL OR "passenger_seats" >= 0),
  ADD CONSTRAINT "maint_vehicle_details_year_chk" CHECK ("year_of_manufacture" IS NULL OR ("year_of_manufacture" >= 1900 AND "year_of_manufacture" <= (EXTRACT(year FROM now()))::int + 1)),
  ADD CONSTRAINT "maint_vehicle_next_service_nonnegative" CHECK ("next_service_mileage_km" IS NULL OR "next_service_mileage_km" >= 0),
  ADD CONSTRAINT "maint_vehicle_odometer_nonnegative" CHECK ("odometer_km" IS NULL OR "odometer_km" >= 0),
  ADD CONSTRAINT "maint_vehicle_service_interval_nonnegative" CHECK ("service_interval_km" IS NULL OR "service_interval_km" >= 0);

ALTER TABLE "maint_vehicle_owners"
  ADD CONSTRAINT "maint_vehicle_owners_name_nonempty" CHECK (length(btrim("name")) > 0);

ALTER TABLE "maint_vehicle_service_plan"
  ADD CONSTRAINT "maint_vsp_at_least_one_interval" CHECK ("interval_km" IS NOT NULL OR "interval_months" IS NOT NULL),
  ADD CONSTRAINT "maint_vsp_intervals_positive" CHECK (("interval_km" IS NULL OR "interval_km" > 0) AND ("interval_months" IS NULL OR "interval_months" > 0)),
  ADD CONSTRAINT "maint_vsp_last_done_km_nonneg" CHECK ("last_done_km" IS NULL OR "last_done_km" >= 0),
  ADD CONSTRAINT "maint_vsp_name_nonempty" CHECK (length(btrim("name")) > 0);

ALTER TABLE "maint_vehicle_tires"
  ADD CONSTRAINT "maint_vehicle_tires_count_positive" CHECK ("count" > 0),
  ADD CONSTRAINT "maint_vehicle_tires_dimension_nonempty" CHECK (length(btrim("dimension")) > 0);

ALTER TABLE "maint_work_orders"
  ADD CONSTRAINT "maint_wo_title_nonempty" CHECK (length(btrim("title")) > 0),
  ADD CONSTRAINT "maint_work_orders_estimated_cost_nonnegative_chk" CHECK ("estimated_cost" IS NULL OR "estimated_cost" >= 0),
  ADD CONSTRAINT "maint_work_orders_odometer_nonnegative_chk" CHECK (("odometer_km_at_service" IS NULL OR "odometer_km_at_service" >= 0) AND ("trigger_odometer_km" IS NULL OR "trigger_odometer_km" >= 0)),
  ADD CONSTRAINT "maint_work_orders_vehicle_cols_chk" CHECK ("asset_type" = 'vehicle' OR ("vehicle_service_category" IS NULL AND "odometer_km_at_service" IS NULL AND "trigger_odometer_km" IS NULL));

-- ---------------------------------------------------------------------------
-- 3. Parcijalni i funkcijski indeksi (Prisma ih ne ume izraziti) — prepis sa sy15.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "idx_maint_assets_asset_code_lower" ON "maint_assets" (lower("asset_code"));
CREATE UNIQUE INDEX "idx_maint_assets_qr_token" ON "maint_assets" ("qr_token");
CREATE INDEX "idx_maint_assets_type_active" ON "maint_assets" ("asset_type") WHERE ("active" = true AND "archived_at" IS NULL);

CREATE INDEX "idx_maint_asp_asset" ON "maint_asset_service_plan" ("asset_id") WHERE ("active" = true);
CREATE INDEX "idx_maint_vsp_asset" ON "maint_vehicle_service_plan" ("asset_id") WHERE ("active" = true);

CREATE INDEX "idx_maint_bookings_active" ON "maint_vehicle_bookings" ("status", "start_at") WHERE ("status" IN ('planirana','u_toku'));
CREATE INDEX "idx_maint_bookings_driver" ON "maint_vehicle_bookings" ("driver_id", "start_at") WHERE ("driver_id" IS NOT NULL);

CREATE INDEX "idx_maint_documents_asset" ON "maint_documents" ("asset_id", "uploaded_at" DESC) WHERE ("deleted_at" IS NULL);
CREATE INDEX "idx_maint_documents_driver" ON "maint_documents" ("driver_id") WHERE ("driver_id" IS NOT NULL AND "deleted_at" IS NULL);
CREATE INDEX "idx_maint_documents_incident" ON "maint_documents" ("incident_id", "uploaded_at" DESC) WHERE ("deleted_at" IS NULL);
CREATE INDEX "idx_maint_documents_task" ON "maint_documents" ("preventive_task_id", "uploaded_at" DESC) WHERE ("deleted_at" IS NULL);
CREATE INDEX "idx_maint_documents_valid_until" ON "maint_documents" ("valid_until") WHERE ("valid_until" IS NOT NULL AND "deleted_at" IS NULL);
CREATE INDEX "idx_maint_documents_wo" ON "maint_documents" ("wo_id", "uploaded_at" DESC) WHERE ("deleted_at" IS NULL);

CREATE INDEX "idx_maint_drivers_active" ON "maint_drivers" ("is_internal", "active") WHERE ("active" = true AND "archived_at" IS NULL);
CREATE INDEX "idx_maint_drivers_license_expiry" ON "maint_drivers" ("drivers_license_valid_until") WHERE ("active" = true AND "archived_at" IS NULL AND "drivers_license_valid_until" IS NOT NULL);
CREATE INDEX "idx_maint_drivers_user" ON "maint_drivers" ("auth_user_id") WHERE ("auth_user_id" IS NOT NULL);

CREATE INDEX "idx_maint_incidents_asset" ON "maint_incidents" ("asset_id") WHERE ("asset_id" IS NOT NULL);
CREATE INDEX "idx_maint_incidents_assigned" ON "maint_incidents" ("assigned_to") WHERE ("status" NOT IN ('resolved','closed'));
CREATE INDEX "idx_maint_incidents_open" ON "maint_incidents" ("status") WHERE ("status" NOT IN ('resolved','closed'));
CREATE INDEX "idx_maint_incidents_safety_open" ON "maint_incidents" ("safety_marker", "status") WHERE ("safety_marker" = true AND "status" NOT IN ('resolved','closed'));
CREATE INDEX "idx_maint_incidents_work_order" ON "maint_incidents" ("work_order_id") WHERE ("work_order_id" IS NOT NULL);

CREATE UNIQUE INDEX "idx_maint_it_asset_hostname" ON "maint_it_asset_details" (lower("hostname")) WHERE ("hostname" IS NOT NULL AND length(btrim("hostname")) > 0);

CREATE INDEX "idx_maint_locations_active" ON "maint_locations" ("active") WHERE ("active" = true);
CREATE INDEX "idx_maint_locations_parent" ON "maint_locations" ("parent_location_id") WHERE ("parent_location_id" IS NOT NULL);

CREATE INDEX "idx_maint_machines_active" ON "maint_machines" ("machine_code") WHERE ("archived_at" IS NULL AND "tracked" = true);
CREATE INDEX "idx_maint_machines_archived" ON "maint_machines" ("archived_at") WHERE ("archived_at" IS NOT NULL);
CREATE INDEX "idx_maint_machines_responsible" ON "maint_machines" ("responsible_user_id") WHERE ("responsible_user_id" IS NOT NULL);

CREATE INDEX "idx_maint_notes_machine" ON "maint_machine_notes" ("machine_code", "pinned" DESC, "created_at" DESC) WHERE ("deleted_at" IS NULL);
CREATE INDEX "idx_mmf_machine_active" ON "maint_machine_files" ("machine_code", "uploaded_at" DESC) WHERE ("deleted_at" IS NULL);

CREATE INDEX "idx_maint_notif_queue" ON "maint_notification_log" ("status", "next_attempt_at") WHERE ("status" IN ('queued','failed'));

CREATE INDEX "idx_maint_profiles_role" ON "maint_user_profiles" ("role") WHERE ("active" = true);

CREATE INDEX "idx_maint_tasks_asset" ON "maint_tasks" ("asset_id") WHERE ("asset_id" IS NOT NULL AND "active" = true);
CREATE INDEX "idx_maint_tasks_machine" ON "maint_tasks" ("machine_code") WHERE ("active" = true);

CREATE INDEX "idx_maint_vehicle_details_parts_shelf" ON "maint_vehicle_details" ("parts_shelf") WHERE ("parts_shelf" IS NOT NULL);
CREATE INDEX "idx_maint_vehicle_details_primary_driver" ON "maint_vehicle_details" ("primary_driver_id") WHERE ("primary_driver_id" IS NOT NULL);
CREATE UNIQUE INDEX "idx_maint_vehicle_details_registration" ON "maint_vehicle_details" (upper("registration_plate")) WHERE ("registration_plate" IS NOT NULL AND length(btrim("registration_plate")) > 0);
CREATE INDEX "maint_vehicle_details_first_aid_idx" ON "maint_vehicle_details" ("first_aid_kit_expires_at") WHERE ("first_aid_kit_expires_at" IS NOT NULL);
CREATE INDEX "maint_vehicle_details_gps_idx" ON "maint_vehicle_details" ("gps_provider") WHERE ("gps_provider" <> 'nema');
CREATE INDEX "maint_vehicle_details_owner_idx" ON "maint_vehicle_details" ("owner_id") WHERE ("owner_id" IS NOT NULL);

CREATE INDEX "maint_vehicle_owners_active_idx" ON "maint_vehicle_owners" ("active") WHERE ("active" = true);
CREATE INDEX "maint_vehicle_tires_installed_idx" ON "maint_vehicle_tires" ("asset_id", "installed_on_vehicle") WHERE ("installed_on_vehicle" = true);

CREATE UNIQUE INDEX "idx_maint_wo_wo_number" ON "maint_work_orders" ("wo_number") WHERE ("wo_number" IS NOT NULL AND length(btrim("wo_number")) > 0);
CREATE INDEX "idx_maint_wo_asset_service_plan" ON "maint_work_orders" ("asset_service_plan_id") WHERE ("asset_service_plan_id" IS NOT NULL);
CREATE INDEX "idx_maint_wo_service_plan" ON "maint_work_orders" ("service_plan_id") WHERE ("service_plan_id" IS NOT NULL);
CREATE INDEX "maint_work_orders_trigger_km_idx" ON "maint_work_orders" ("asset_id", "trigger_odometer_km") WHERE ("trigger_odometer_km" IS NOT NULL);
CREATE INDEX "maint_work_orders_vehicle_category_idx" ON "maint_work_orders" ("vehicle_service_category") WHERE ("asset_type" = 'vehicle');

-- ---------------------------------------------------------------------------
-- 4. FK ka `users` (46 kolona). U sy15 su gađale `auth.users(id)` (uuid);
--    ON DELETE semantika je PREPISANA sa žive baze (`pg_constraint.confdeltype`),
--    ne izmišljena: 40× SET NULL, 5× RESTRICT, 1× CASCADE.
--    SQL-only jer 46 Prisma relacija traži 46 povratnih polja na `User`
--    (prenosna odluka 2) — modul ih nikad ne džoinuje.
-- ---------------------------------------------------------------------------
ALTER TABLE "maint_asset_service_plan"
  ADD CONSTRAINT "fk_maint_asp_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_asp_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_assets"
  ADD CONSTRAINT "fk_maint_assets_archived_by" FOREIGN KEY ("archived_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_assets_responsible" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_assets_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_checks"
  ADD CONSTRAINT "fk_maint_checks_performed_by" FOREIGN KEY ("performed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_checks_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_documents"
  ADD CONSTRAINT "fk_maint_documents_uploaded_by" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_drivers"
  ADD CONSTRAINT "fk_maint_drivers_auth_user" FOREIGN KEY ("auth_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_drivers_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_drivers_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_facility_details"
  ADD CONSTRAINT "fk_maint_facility_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_incident_events"
  ADD CONSTRAINT "fk_maint_incident_events_actor" FOREIGN KEY ("actor") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_incidents"
  ADD CONSTRAINT "fk_maint_incidents_assigned_to" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_incidents_reported_by" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_incidents_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_it_asset_details"
  ADD CONSTRAINT "fk_maint_it_details_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_machine_files"
  ADD CONSTRAINT "fk_maint_machine_files_uploaded_by" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_machine_notes"
  ADD CONSTRAINT "fk_maint_machine_notes_author" FOREIGN KEY ("author") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "maint_machine_status_override"
  ADD CONSTRAINT "fk_maint_override_set_by" FOREIGN KEY ("set_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "maint_machines"
  ADD CONSTRAINT "fk_maint_machines_responsible" FOREIGN KEY ("responsible_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_machines_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_machines_deletion_log"
  ADD CONSTRAINT "fk_maint_mmdl_deleted_by" FOREIGN KEY ("deleted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_notification_log"
  ADD CONSTRAINT "fk_maint_notif_log_recipient" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_notification_rules"
  ADD CONSTRAINT "fk_maint_notif_rules_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_part_stock_movements"
  ADD CONSTRAINT "fk_maint_stock_movements_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_part_vehicles"
  ADD CONSTRAINT "fk_maint_part_vehicles_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_part_vehicles_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_parts"
  ADD CONSTRAINT "fk_maint_parts_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_settings"
  ADD CONSTRAINT "fk_maint_settings_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_suppliers"
  ADD CONSTRAINT "fk_maint_suppliers_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_tasks"
  ADD CONSTRAINT "fk_maint_tasks_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_tasks_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_user_profiles"
  ADD CONSTRAINT "fk_maint_user_profiles_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "maint_vehicle_bookings"
  ADD CONSTRAINT "fk_maint_bookings_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_bookings_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_vehicle_details"
  ADD CONSTRAINT "fk_maint_vehicle_details_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_vehicle_owners"
  ADD CONSTRAINT "fk_maint_vehicle_owners_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_vehicle_service_plan"
  ADD CONSTRAINT "fk_maint_vsp_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_vsp_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_vehicle_tires"
  ADD CONSTRAINT "fk_maint_vehicle_tires_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_wo_events"
  ADD CONSTRAINT "fk_maint_wo_events_actor" FOREIGN KEY ("actor") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_wo_labor"
  ADD CONSTRAINT "fk_maint_wo_labor_technician" FOREIGN KEY ("technician_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
ALTER TABLE "maint_work_orders"
  ADD CONSTRAINT "fk_maint_wo_assigned_to" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_wo_reported_by" FOREIGN KEY ("reported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "fk_maint_wo_updated_by" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 4b. 🔴 DB-level DEFAULT za uuid ključeve (26 kolona) — vraća se RUČNO.
--
--     Prisma `@default(uuid(4))` je KLIJENTSKI podrazumevana vrednost: generiše je
--     Prisma Client, a u bazi kolona ostaje BEZ `DEFAULT`. sy15 te kolone IMA sa
--     `DEFAULT gen_random_uuid()` (izmereno `pg_attrdef`, 26 kolona), i o tome zavisi
--     svaki upis koji NE ide kroz Prisma Client: prenosna skripta, ručni `INSERT` u
--     održavanju produkcije, i DB trigeri koji rade `INSERT` u drugu tabelu.
--     Bez ovoga takav upis pada sa „null value in column … violates not-null" —
--     uhvaćeno na probnoj bazi 06.08.2026, ne pretpostavljeno.
--
--     `maint_assets.qr_token` je poseban: u sy15 je `(gen_random_uuid())::text`
--     (token QR nalepnice je TEKST, ne uuid) — prepisuje se doslovno.
-- ---------------------------------------------------------------------------
ALTER TABLE "maint_asset_service_plan"    ALTER COLUMN "plan_id"     SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_assets"                ALTER COLUMN "asset_id"    SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_assets"                ALTER COLUMN "qr_token"    SET DEFAULT (gen_random_uuid())::text;
ALTER TABLE "maint_checks"                ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_documents"             ALTER COLUMN "document_id" SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_drivers"               ALTER COLUMN "driver_id"   SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_incident_events"       ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_incidents"             ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_locations"             ALTER COLUMN "location_id" SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_machine_files"         ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_machine_notes"         ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_machines_deletion_log" ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_notification_log"      ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_notification_rules"    ALTER COLUMN "rule_id"     SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_part_stock_movements"  ALTER COLUMN "movement_id" SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_parts"                 ALTER COLUMN "part_id"     SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_suppliers"             ALTER COLUMN "supplier_id" SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_tasks"                 ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_vehicle_bookings"      ALTER COLUMN "booking_id"  SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_vehicle_owners"        ALTER COLUMN "owner_id"    SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_vehicle_service_plan"  ALTER COLUMN "plan_id"     SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_vehicle_tires"         ALTER COLUMN "tire_set_id" SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_wo_events"             ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_wo_labor"              ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_wo_parts"              ALTER COLUMN "id"          SET DEFAULT gen_random_uuid();
ALTER TABLE "maint_work_orders"           ALTER COLUMN "wo_id"       SET DEFAULT gen_random_uuid();

-- ---------------------------------------------------------------------------
-- 5. TRIGERI — MEHANIKA (prenosi se). Logika se NE prenosi (v. §6).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "maint_touch_updated_at"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW."updated_at" = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_maint_assets_updated" BEFORE UPDATE ON "maint_assets" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_checks_updated" BEFORE UPDATE ON "maint_checks" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_facility_details_updated" BEFORE UPDATE ON "maint_facility_details" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_incidents_updated" BEFORE UPDATE ON "maint_incidents" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_it_asset_details_updated" BEFORE UPDATE ON "maint_it_asset_details" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_locations_updated" BEFORE UPDATE ON "maint_locations" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_machine_notes_updated" BEFORE UPDATE ON "maint_machine_notes" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_machines_updated" BEFORE UPDATE ON "maint_machines" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_notification_rules_updated" BEFORE UPDATE ON "maint_notification_rules" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_parts_updated" BEFORE UPDATE ON "maint_parts" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_settings_updated" BEFORE UPDATE ON "maint_settings" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_suppliers_updated" BEFORE UPDATE ON "maint_suppliers" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_tasks_updated" BEFORE UPDATE ON "maint_tasks" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_user_profiles_updated" BEFORE UPDATE ON "maint_user_profiles" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_vehicle_details_updated" BEFORE UPDATE ON "maint_vehicle_details" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_vehicle_owners_updated" BEFORE UPDATE ON "maint_vehicle_owners" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_vehicle_tires_updated" BEFORE UPDATE ON "maint_vehicle_tires" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
CREATE TRIGGER "trg_maint_work_orders_updated" BEFORE UPDATE ON "maint_work_orders" FOR EACH ROW EXECUTE FUNCTION "maint_touch_updated_at"();
-- ⚠️ sy15 ima `touch_updated_at` i na `maint_asset_service_plan`?  NEMA — izmereno
--    `pg_trigger`: te tabele nema u spisku, njen `updated_at` se pišе iz aplikacije.
--    Isto važi za `maint_vehicle_service_plan`, `maint_part_vehicles`,
--    `maint_drivers`, `maint_vehicle_bookings`, `maint_documents`. Ne dodajemo
--    trigere kojih u izvoru NEMA — to bi bila promena ponašanja, ne seoba.

-- Dodela broja radnog naloga (mehanika, `maint_work_orders_assign_wo_number`).
-- Atomični brojač po godini; `maint_wo_number_counter` u sy15 ima deny-all RLS
-- pa je JEDINI upis kroz ovaj trigger — u 3.0 to ostaje jedini upis po dogovoru
-- (aplikacija u tabelu ne piše; v. runbook §6, tri DENY-ALL tabele).
CREATE OR REPLACE FUNCTION "maint_assign_wo_number"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_year int := EXTRACT(year FROM COALESCE(NEW."created_at", now()))::int;
  v_next int;
BEGIN
  IF NEW."wo_number" IS NOT NULL AND length(btrim(NEW."wo_number")) > 0 THEN
    RETURN NEW;
  END IF;
  INSERT INTO "maint_wo_number_counter" ("year", "last_value")
  VALUES (v_year, 1)
  ON CONFLICT ("year") DO UPDATE SET "last_value" = "maint_wo_number_counter"."last_value" + 1
  RETURNING "last_value" INTO v_next;
  NEW."wo_number" := 'WO-' || v_year::text || '-' || lpad(v_next::text, 5, '0');
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_maint_wo_assign_number" BEFORE INSERT ON "maint_work_orders"
  FOR EACH ROW EXECUTE FUNCTION "maint_assign_wo_number"();

-- Guardovi tipa sredstva (mehanika — čist CHECK preko FK; kod ih hvata kao
-- 23514 -> 422, `odrzavanje.service.ts` rethrowSy15).
CREATE OR REPLACE FUNCTION "maint_assert_asset_type"() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_type text;
  v_want text := TG_ARGV[0];
BEGIN
  SELECT "asset_type" INTO v_type FROM "maint_assets" WHERE "asset_id" = NEW."asset_id";
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'Sredstvo % ne postoji', NEW."asset_id" USING ERRCODE = '23503';
  END IF;
  IF v_want = 'it_or_facility' THEN
    IF v_type NOT IN ('it','facility') THEN
      RAISE EXCEPTION 'Plan servisa sredstva važi samo za IT opremu i objekte (tip je %)', v_type USING ERRCODE = '23514';
    END IF;
  ELSIF v_type <> v_want THEN
    RAISE EXCEPTION 'Očekivan tip sredstva %, a red pokazuje na %', v_want, v_type USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_maint_asp_guard" BEFORE INSERT OR UPDATE ON "maint_asset_service_plan"
  FOR EACH ROW EXECUTE FUNCTION "maint_assert_asset_type"('it_or_facility');
CREATE TRIGGER "trg_maint_facility_details_guard" BEFORE INSERT OR UPDATE ON "maint_facility_details"
  FOR EACH ROW EXECUTE FUNCTION "maint_assert_asset_type"('facility');
CREATE TRIGGER "trg_maint_it_details_guard" BEFORE INSERT OR UPDATE ON "maint_it_asset_details"
  FOR EACH ROW EXECUTE FUNCTION "maint_assert_asset_type"('it');
CREATE TRIGGER "trg_maint_vehicle_details_guard" BEFORE INSERT OR UPDATE ON "maint_vehicle_details"
  FOR EACH ROW EXECUTE FUNCTION "maint_assert_asset_type"('vehicle');

-- ---------------------------------------------------------------------------
-- 6. ŠTA MIGRACIJA NAMERNO NE PRENOSI (i gde to živi umesto nje)
-- ---------------------------------------------------------------------------
-- a) 102 RLS politike — 3.0 nema RLS (ODLUKE.md). Row-scope se prepisuje u
--    `OdrzavanjeAuthzService` (30 netrivijalnih read-scope-ova + 17 write pravila).
-- b) 11 trigera koji su LOGIKA, ne mehanika — prepisuju se u NestJS:
--      `maint_incidents_autocreate_work_order`  (auto-nalog iz incidenta)
--      `maint_incidents_enqueue_notify`         (enqueue obaveštenja + delay)
--      `maint_incidents_log_changes`            (audit u maint_incident_events)
--      `maint_incidents_set_asset_fields`       (denormalizacija asset_id/asset_type)
--      `maint_machines_ensure_asset`            (kreiranje sredstva uz mašinu)
--      `maint_machines_sync_to_loc`             (🔴 PIŠE U `loc_locations` — tuđi domen)
--      `maint_apply_part_stock_movement`        (current_stock += delta)
--      `maint_wo_log_field_changes`             (audit u maint_wo_events)
--      `maint_wo_service_plan_completion`       (zatvara rok plana vozila)
--      `trg_maint_wo_asset_service_plan_completion` (isto za plan sredstva)
--      `maint_profiles_guard_role`              (🔴 brana eskalacije privilegija)
-- c) 14 DEFINER funkcija koje kod ZOVE + 9 gejt funkcija koje one koriste.
-- d) 13 view-ova `v_maint_*` (svi `security_invoker = true`, tj. RLS se
--    primenjivao I KROZ VIEW — u 3.0 scope mora eksplicitno u upit).
-- e) `v_rev_machines` — NIJE ovaj domen po imenu, ali JESTE po zavisnosti
--    (Reversi čitaju `maint_machines` kroz njega). Ostaje u sy15 do koraka 3.

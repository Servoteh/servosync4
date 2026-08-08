-- CreateTable
CREATE TABLE "rev_inventory_groups" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "applies_to" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 100,
    "icon" TEXT,
    "is_seeded" BOOLEAN NOT NULL DEFAULT true,
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rev_inventory_groups" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_inventory_subgroups" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 100,
    "is_seeded" BOOLEAN NOT NULL DEFAULT true,
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rev_inventory_subgroups" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_inventory_subsubgroups" (
    "id" UUID NOT NULL,
    "subgroup_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 100,
    "is_seeded" BOOLEAN NOT NULL DEFAULT false,
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rev_inventory_subsubgroups" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_tools" (
    "id" UUID NOT NULL,
    "oznaka" TEXT NOT NULL,
    "naziv" TEXT NOT NULL,
    "serijski_broj" TEXT,
    "datum_kupovine" DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "napomena" TEXT,
    "loc_item_ref_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bigtehn_sifra_artikla" INTEGER,
    "barcode" TEXT NOT NULL,
    "subgroup_id" UUID,
    "is_quantity" BOOLEAN NOT NULL DEFAULT false,
    "total_qty" INTEGER NOT NULL DEFAULT 1,
    "is_consumable" BOOLEAN NOT NULL DEFAULT false,
    "min_stock_qty" INTEGER,
    "max_stock_qty" INTEGER,
    "subsubgroup_id" UUID,
    "garancija_do" DATE,
    "garancija_napomena" TEXT,
    "ima_punjac" BOOLEAN NOT NULL DEFAULT false,
    "punjac_serijski" TEXT,
    "otpis_datum" DATE,
    "otpis_razlog" TEXT,
    "otpis_by_user_id" INTEGER,
    "nabavna_vrednost" DECIMAL(12,2),

    CONSTRAINT "pk_rev_tools" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_cutting_tool_catalog" (
    "id" UUID NOT NULL,
    "barcode" TEXT,
    "oznaka" TEXT NOT NULL,
    "naziv" TEXT NOT NULL,
    "compatible_machine_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unit" TEXT NOT NULL DEFAULT 'kom',
    "status" TEXT NOT NULL DEFAULT 'active',
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bigtehn_sifra_artikla" INTEGER,
    "min_stock_qty" INTEGER NOT NULL DEFAULT 0,
    "subgroup_id" UUID,
    "max_stock_qty" INTEGER,

    CONSTRAINT "pk_rev_cutting_tool_catalog" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_cutting_tool_stock" (
    "catalog_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "on_hand_qty" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rev_cutting_tool_stock" PRIMARY KEY ("catalog_id","location_id")
);

-- CreateTable
CREATE TABLE "rev_recipient_locations" (
    "id" UUID NOT NULL,
    "recipient_type" TEXT NOT NULL,
    "recipient_key" TEXT NOT NULL,
    "recipient_label" TEXT NOT NULL,
    "loc_location_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rev_recipient_locations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_documents" (
    "id" UUID NOT NULL,
    "doc_number" TEXT NOT NULL,
    "doc_type" TEXT NOT NULL,
    "recipient_type" TEXT NOT NULL,
    "recipient_employee_id" UUID,
    "recipient_employee_name" TEXT,
    "recipient_department" TEXT,
    "recipient_company_name" TEXT,
    "recipient_company_pib" TEXT,
    "recipient_loc_id" UUID,
    "expected_return_date" DATE,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by_user_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "return_confirmed_by_user_id" INTEGER,
    "return_confirmed_at" TIMESTAMPTZ(6),
    "return_notes" TEXT,
    "pdf_storage_path" TEXT,
    "pdf_generated_at" TIMESTAMPTZ(6),
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipient_machine_code" TEXT,
    "issued_to_employee_id" UUID,
    "issued_to_employee_name" TEXT,
    "bulk_import_legacy_key" TEXT,

    CONSTRAINT "pk_rev_documents" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_document_lines" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "line_type" TEXT NOT NULL,
    "tool_id" UUID,
    "drawing_no" TEXT,
    "work_order_ref_id" UUID,
    "part_name" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "unit" TEXT NOT NULL DEFAULT 'kom',
    "napomena" TEXT,
    "issue_movement_id" UUID,
    "returned_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "return_movement_id" UUID,
    "line_status" TEXT NOT NULL DEFAULT 'ISSUED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cutting_tool_catalog_id" UUID,

    CONSTRAINT "pk_rev_document_lines" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_document_cutting_assignees" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rev_document_cutting_assignees" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_machine_heads" (
    "id" UUID NOT NULL,
    "machine_code" TEXT NOT NULL,
    "oznaka" TEXT NOT NULL,
    "naziv" TEXT NOT NULL,
    "tip" TEXT,
    "serijski_broj" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rev_machine_heads" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_tool_batteries" (
    "id" UUID NOT NULL,
    "tool_id" UUID NOT NULL,
    "serijski_broj" TEXT,
    "kapacitet" TEXT,
    "datum_nabavke" DATE,
    "status" TEXT NOT NULL DEFAULT 'active',
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER,

    CONSTRAINT "pk_rev_tool_batteries" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_tool_service_log" (
    "id" UUID NOT NULL,
    "tool_id" UUID NOT NULL,
    "datum" DATE NOT NULL DEFAULT CURRENT_DATE,
    "tip" TEXT NOT NULL DEFAULT 'popravka',
    "opis" TEXT,
    "izvrsilac" TEXT,
    "trosak" DECIMAL(12,2),
    "status" TEXT NOT NULL DEFAULT 'zavrsen',
    "napomena" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER,

    CONSTRAINT "pk_rev_tool_service_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rev_tool_stock_ledger" (
    "id" UUID NOT NULL,
    "tool_id" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "ref_doc_id" UUID,
    "ref_line_id" UUID,
    "note" TEXT,
    "created_by_user_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rev_tool_stock_ledger" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loc_locations" (
    "id" UUID NOT NULL,
    "location_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location_type" TEXT NOT NULL,
    "parent_id" UUID,
    "path_cached" TEXT NOT NULL DEFAULT '',
    "depth" SMALLINT NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "capacity_note" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" INTEGER,

    CONSTRAINT "pk_loc_locations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loc_item_placements" (
    "id" UUID NOT NULL,
    "item_ref_table" TEXT NOT NULL,
    "item_ref_id" TEXT NOT NULL,
    "location_id" UUID NOT NULL,
    "placement_status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_movement_id" UUID,
    "placed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placed_by_user_id" INTEGER,
    "notes" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "order_no" TEXT NOT NULL DEFAULT '',
    "drawing_no" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "pk_loc_item_placements" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loc_location_movements" (
    "id" UUID NOT NULL,
    "item_ref_table" TEXT NOT NULL,
    "item_ref_id" TEXT NOT NULL,
    "from_location_id" UUID,
    "to_location_id" UUID,
    "movement_type" TEXT NOT NULL,
    "movement_reason" TEXT,
    "note" TEXT,
    "moved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "moved_by_user_id" INTEGER NOT NULL,
    "approved_by_user_id" INTEGER,
    "approved_at" TIMESTAMPTZ(6),
    "correction_of_movement_id" UUID,
    "sync_status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "order_no" TEXT NOT NULL DEFAULT '',
    "drawing_no" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "client_event_uuid" UUID,

    CONSTRAINT "pk_loc_location_movements" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loc_sync_outbound_events" (
    "id" UUID NOT NULL,
    "source_table" TEXT NOT NULL,
    "source_record_id" UUID NOT NULL,
    "target_procedure" TEXT NOT NULL DEFAULT 'dbo.sp_ApplyLocationEvent',
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "locked_by_worker" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "next_retry_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_loc_sync_outbound_events" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loc_sync_alerts_outbox" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "dedup_key" TEXT NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "payload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(6),

    CONSTRAINT "pk_loc_sync_alerts_outbox" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loc_sync_worker_heartbeat" (
    "worker_id" TEXT NOT NULL,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_loc_sync_worker_heartbeat" PRIMARY KEY ("worker_id")
);

-- CreateTable
CREATE TABLE "loc_bigtehn_ingest_state" (
    "worker_id" TEXT NOT NULL,
    "last_processed_signal_id" BIGINT NOT NULL DEFAULT 0,
    "armed" BOOLEAN NOT NULL DEFAULT false,
    "last_run_at" TIMESTAMPTZ(6),
    "last_run_summary" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_loc_bigtehn_ingest_state" PRIMARY KEY ("worker_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_inventory_groups_code" ON "rev_inventory_groups"("code");

-- CreateIndex
CREATE INDEX "idx_rev_inventory_groups_applies" ON "rev_inventory_groups"("applies_to");

-- CreateIndex
CREATE INDEX "idx_rev_inventory_subgroups_group" ON "rev_inventory_subgroups"("group_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_inventory_subgroups_group_code" ON "rev_inventory_subgroups"("group_id", "code");

-- CreateIndex
CREATE INDEX "idx_rev_inventory_subsubgroups_subgroup" ON "rev_inventory_subsubgroups"("subgroup_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_inventory_subsubgroups_subgroup_code" ON "rev_inventory_subsubgroups"("subgroup_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_tools_loc_item_ref_id" ON "rev_tools"("loc_item_ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_tools_barcode" ON "rev_tools"("barcode");

-- CreateIndex
CREATE INDEX "idx_rev_tools_status" ON "rev_tools"("status");

-- CreateIndex
CREATE INDEX "idx_rev_tools_oznaka" ON "rev_tools"("oznaka");

-- CreateIndex
CREATE INDEX "idx_rev_tools_subgroup" ON "rev_tools"("subgroup_id");

-- CreateIndex
CREATE INDEX "idx_rev_tools_subsubgroup" ON "rev_tools"("subsubgroup_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_cutting_tool_catalog_barcode" ON "rev_cutting_tool_catalog"("barcode");

-- CreateIndex
CREATE INDEX "idx_rev_cutting_tool_catalog_status" ON "rev_cutting_tool_catalog"("status");

-- CreateIndex
CREATE INDEX "idx_rev_cutting_tool_catalog_oznaka" ON "rev_cutting_tool_catalog"("oznaka");

-- CreateIndex
CREATE INDEX "idx_rev_cutting_tool_catalog_subgroup" ON "rev_cutting_tool_catalog"("subgroup_id");

-- CreateIndex
CREATE INDEX "idx_rev_cutting_tool_stock_location" ON "rev_cutting_tool_stock"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_recipient_locations_type_key" ON "rev_recipient_locations"("recipient_type", "recipient_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_documents_doc_number" ON "rev_documents"("doc_number");

-- CreateIndex
CREATE INDEX "idx_rev_documents_doc_type_status" ON "rev_documents"("doc_type", "status");

-- CreateIndex
CREATE INDEX "idx_rev_documents_status" ON "rev_documents"("status");

-- CreateIndex
CREATE INDEX "idx_rev_documents_issued_at" ON "rev_documents"("issued_at" DESC);

-- CreateIndex
CREATE INDEX "idx_rev_documents_issued_by" ON "rev_documents"("issued_by_user_id");

-- CreateIndex
CREATE INDEX "idx_rev_documents_employee" ON "rev_documents"("recipient_employee_id");

-- CreateIndex
CREATE INDEX "idx_rev_documents_issued_to_emp" ON "rev_documents"("issued_to_employee_id");

-- CreateIndex
CREATE INDEX "idx_rev_documents_machine_code" ON "rev_documents"("recipient_machine_code");

-- CreateIndex
CREATE INDEX "idx_rev_document_lines_doc" ON "rev_document_lines"("document_id");

-- CreateIndex
CREATE INDEX "idx_rev_document_lines_status" ON "rev_document_lines"("line_status");

-- CreateIndex
CREATE INDEX "idx_rev_document_lines_tool" ON "rev_document_lines"("tool_id");

-- CreateIndex
CREATE INDEX "idx_rev_document_lines_cts_catalog" ON "rev_document_lines"("cutting_tool_catalog_id");

-- CreateIndex
CREATE INDEX "idx_rev_document_cutting_assignees_doc" ON "rev_document_cutting_assignees"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_document_cutting_assignees_doc_emp" ON "rev_document_cutting_assignees"("document_id", "employee_id");

-- CreateIndex
CREATE INDEX "idx_rev_machine_heads_machine" ON "rev_machine_heads"("machine_code");

-- CreateIndex
CREATE INDEX "idx_rev_tool_batteries_tool" ON "rev_tool_batteries"("tool_id");

-- CreateIndex
CREATE INDEX "idx_rev_tool_service_log_tool" ON "rev_tool_service_log"("tool_id", "datum" DESC);

-- CreateIndex
CREATE INDEX "idx_rev_tool_stock_ledger_tool" ON "rev_tool_stock_ledger"("tool_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_loc_locations_parent" ON "loc_locations"("parent_id");

-- CreateIndex
CREATE INDEX "idx_loc_item_placements_item_lookup" ON "loc_item_placements"("item_ref_table", "item_ref_id");

-- CreateIndex
CREATE INDEX "idx_loc_item_placements_loc" ON "loc_item_placements"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loc_item_placements_item_order_loc" ON "loc_item_placements"("item_ref_table", "item_ref_id", "order_no", "location_id");

-- CreateIndex
CREATE INDEX "idx_loc_location_movements_item" ON "loc_location_movements"("item_ref_table", "item_ref_id", "moved_at" DESC);

-- CreateIndex
CREATE INDEX "idx_loc_location_movements_to" ON "loc_location_movements"("to_location_id", "moved_at" DESC);

-- CreateIndex
CREATE INDEX "idx_loc_sync_outbound_events_status" ON "loc_sync_outbound_events"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loc_sync_alerts_dedup" ON "loc_sync_alerts_outbox"("dedup_key", "recipient_email");

-- AddForeignKey
ALTER TABLE "rev_inventory_subgroups" ADD CONSTRAINT "fk_rev_inventory_subgroups_group" FOREIGN KEY ("group_id") REFERENCES "rev_inventory_groups"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_inventory_subsubgroups" ADD CONSTRAINT "fk_rev_inventory_subsubgroups_subgroup" FOREIGN KEY ("subgroup_id") REFERENCES "rev_inventory_subgroups"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tools" ADD CONSTRAINT "fk_rev_tools_subgroup" FOREIGN KEY ("subgroup_id") REFERENCES "rev_inventory_subgroups"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tools" ADD CONSTRAINT "fk_rev_tools_subsubgroup" FOREIGN KEY ("subsubgroup_id") REFERENCES "rev_inventory_subsubgroups"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tools" ADD CONSTRAINT "fk_rev_tools_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tools" ADD CONSTRAINT "fk_rev_tools_otpis_by" FOREIGN KEY ("otpis_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_cutting_tool_catalog" ADD CONSTRAINT "fk_rev_cutting_tool_catalog_subgroup" FOREIGN KEY ("subgroup_id") REFERENCES "rev_inventory_subgroups"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_cutting_tool_catalog" ADD CONSTRAINT "fk_rev_cutting_tool_catalog_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_cutting_tool_stock" ADD CONSTRAINT "fk_rev_cutting_tool_stock_catalog" FOREIGN KEY ("catalog_id") REFERENCES "rev_cutting_tool_catalog"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_cutting_tool_stock" ADD CONSTRAINT "fk_rev_cutting_tool_stock_location" FOREIGN KEY ("location_id") REFERENCES "loc_locations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_recipient_locations" ADD CONSTRAINT "fk_rev_recipient_locations_location" FOREIGN KEY ("loc_location_id") REFERENCES "loc_locations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_documents" ADD CONSTRAINT "fk_rev_documents_recipient_loc" FOREIGN KEY ("recipient_loc_id") REFERENCES "loc_locations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_documents" ADD CONSTRAINT "fk_rev_documents_issued_by" FOREIGN KEY ("issued_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_documents" ADD CONSTRAINT "fk_rev_documents_return_confirmed_by" FOREIGN KEY ("return_confirmed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_lines" ADD CONSTRAINT "fk_rev_document_lines_document" FOREIGN KEY ("document_id") REFERENCES "rev_documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_lines" ADD CONSTRAINT "fk_rev_document_lines_tool" FOREIGN KEY ("tool_id") REFERENCES "rev_tools"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_lines" ADD CONSTRAINT "fk_rev_document_lines_cutting_tool" FOREIGN KEY ("cutting_tool_catalog_id") REFERENCES "rev_cutting_tool_catalog"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_lines" ADD CONSTRAINT "fk_rev_document_lines_issue_movement" FOREIGN KEY ("issue_movement_id") REFERENCES "loc_location_movements"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_lines" ADD CONSTRAINT "fk_rev_document_lines_return_movement" FOREIGN KEY ("return_movement_id") REFERENCES "loc_location_movements"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_cutting_assignees" ADD CONSTRAINT "fk_rev_document_cutting_assignees_document" FOREIGN KEY ("document_id") REFERENCES "rev_documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_machine_heads" ADD CONSTRAINT "fk_rev_machine_heads_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_batteries" ADD CONSTRAINT "fk_rev_tool_batteries_tool" FOREIGN KEY ("tool_id") REFERENCES "rev_tools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_batteries" ADD CONSTRAINT "fk_rev_tool_batteries_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_service_log" ADD CONSTRAINT "fk_rev_tool_service_log_tool" FOREIGN KEY ("tool_id") REFERENCES "rev_tools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_service_log" ADD CONSTRAINT "fk_rev_tool_service_log_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "fk_rev_tool_stock_ledger_tool" FOREIGN KEY ("tool_id") REFERENCES "rev_tools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "fk_rev_tool_stock_ledger_ref_doc" FOREIGN KEY ("ref_doc_id") REFERENCES "rev_documents"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "fk_rev_tool_stock_ledger_ref_line" FOREIGN KEY ("ref_line_id") REFERENCES "rev_document_lines"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "fk_rev_tool_stock_ledger_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_locations" ADD CONSTRAINT "fk_loc_locations_parent" FOREIGN KEY ("parent_id") REFERENCES "loc_locations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_locations" ADD CONSTRAINT "fk_loc_locations_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_locations" ADD CONSTRAINT "fk_loc_locations_updated_by" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_item_placements" ADD CONSTRAINT "fk_loc_item_placements_location" FOREIGN KEY ("location_id") REFERENCES "loc_locations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_item_placements" ADD CONSTRAINT "fk_loc_item_placements_last_movement" FOREIGN KEY ("last_movement_id") REFERENCES "loc_location_movements"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_item_placements" ADD CONSTRAINT "fk_loc_item_placements_placed_by" FOREIGN KEY ("placed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_location_movements" ADD CONSTRAINT "fk_loc_location_movements_from_location" FOREIGN KEY ("from_location_id") REFERENCES "loc_locations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_location_movements" ADD CONSTRAINT "fk_loc_location_movements_to_location" FOREIGN KEY ("to_location_id") REFERENCES "loc_locations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_location_movements" ADD CONSTRAINT "fk_loc_location_movements_moved_by" FOREIGN KEY ("moved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_location_movements" ADD CONSTRAINT "fk_loc_location_movements_approved_by" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loc_location_movements" ADD CONSTRAINT "fk_loc_location_movements_correction_of" FOREIGN KEY ("correction_of_movement_id") REFERENCES "loc_location_movements"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SQL-only deo — ono što Prisma šema ne ume da izrazi.
--
-- Seoba sy15 korak 3 (Reversi + Lokacije). Runbook:
-- docs/SEOBA_REVERSI_LOKACIJE_2026-08-07.md
--
-- Sve vrednosti u CHECK-ovima su prepisane 1:1 iz produkcijskog sy15
-- (`pg_enum` + `pg_constraint`, mereno 07.08.2026) — ni jedna nije izmišljena.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. CHECK umesto PG enum tipova ──────────────────────────────────────────────
-- U sy15 su ovo bili pravi enum tipovi (`loc_type_enum`, `loc_movement_type_enum`,
-- `loc_placement_status_enum`, `loc_sync_status_enum`). BACKEND_RULES §2 traži String,
-- pa istu bravu ovde drži CHECK. Nova vrednost = migracija, isto kao i pre.

ALTER TABLE "loc_locations" ADD CONSTRAINT "ck_loc_locations_location_type"
  CHECK ("location_type" IN ('WAREHOUSE','RACK','SHELF','BIN','PROJECT','PRODUCTION',
    'ASSEMBLY','SERVICE','FIELD','TRANSIT','OFFICE','TEMP','SCRAPPED','OTHER','MACHINE','CAGE'));

ALTER TABLE "loc_location_movements" ADD CONSTRAINT "ck_loc_location_movements_movement_type"
  CHECK ("movement_type" IN ('INITIAL_PLACEMENT','TRANSFER','ASSIGN_TO_PROJECT',
    'RETURN_FROM_PROJECT','SEND_TO_SERVICE','RETURN_FROM_SERVICE','SEND_TO_FIELD',
    'RETURN_FROM_FIELD','SCRAP','CORRECTION','INVENTORY_ADJUSTMENT','REVERSAL_ISSUE','REVERSAL_RETURN'));

ALTER TABLE "loc_location_movements" ADD CONSTRAINT "ck_loc_location_movements_sync_status"
  CHECK ("sync_status" IN ('PENDING','IN_PROGRESS','SYNCED','FAILED','DEAD_LETTER'));

ALTER TABLE "loc_item_placements" ADD CONSTRAINT "ck_loc_item_placements_placement_status"
  CHECK ("placement_status" IN ('ACTIVE','IN_TRANSIT','PENDING_CONFIRMATION','UNKNOWN'));

ALTER TABLE "loc_sync_outbound_events" ADD CONSTRAINT "ck_loc_sync_outbound_events_status"
  CHECK ("status" IN ('PENDING','IN_PROGRESS','SYNCED','FAILED','DEAD_LETTER'));

-- ── 2. CHECK-ovi prepisani 1:1 iz sy15 `pg_constraint` ──────────────────────────

ALTER TABLE "loc_locations" ADD CONSTRAINT "ck_loc_locations_no_self_parent"
  CHECK ("parent_id" IS NULL OR "parent_id" <> "id");

ALTER TABLE "loc_item_placements" ADD CONSTRAINT "ck_loc_item_placements_qty_pos" CHECK ("quantity" > 0);
ALTER TABLE "loc_item_placements" ADD CONSTRAINT "ck_loc_item_placements_order_no_len" CHECK (char_length("order_no") <= 40);
ALTER TABLE "loc_item_placements" ADD CONSTRAINT "ck_loc_item_placements_drawing_no_len" CHECK (char_length("drawing_no") <= 40);

ALTER TABLE "loc_location_movements" ADD CONSTRAINT "ck_loc_location_movements_qty_pos" CHECK ("quantity" > 0);
ALTER TABLE "loc_location_movements" ADD CONSTRAINT "ck_loc_location_movements_order_no_len" CHECK (char_length("order_no") <= 40);
ALTER TABLE "loc_location_movements" ADD CONSTRAINT "ck_loc_location_movements_drawing_no_len" CHECK (char_length("drawing_no") <= 40);
ALTER TABLE "loc_location_movements" ADD CONSTRAINT "ck_loc_location_movements_source"
  CHECK ("source" IN ('manual','bigtehn','correction','reversi','api'));

ALTER TABLE "loc_sync_alerts_outbox" ADD CONSTRAINT "ck_loc_sync_alerts_outbox_kind"
  CHECK ("kind" IN ('worker_down','dead_letter_digest'));
ALTER TABLE "loc_sync_alerts_outbox" ADD CONSTRAINT "ck_loc_sync_alerts_outbox_status"
  CHECK ("status" IN ('queued','sent','failed','skipped'));

ALTER TABLE "rev_inventory_groups" ADD CONSTRAINT "ck_rev_inventory_groups_applies_to"
  CHECK ("applies_to" IN ('CUTTING','HAND','BOTH'));

ALTER TABLE "rev_tools" ADD CONSTRAINT "ck_rev_tools_status" CHECK ("status" IN ('active','scrapped','lost'));
ALTER TABLE "rev_tools" ADD CONSTRAINT "ck_rev_tools_min_stock_nonneg" CHECK ("min_stock_qty" IS NULL OR "min_stock_qty" >= 0);
ALTER TABLE "rev_tools" ADD CONSTRAINT "ck_rev_tools_max_stock_nonneg" CHECK ("max_stock_qty" IS NULL OR "max_stock_qty" >= 0);
ALTER TABLE "rev_tools" ADD CONSTRAINT "ck_rev_tools_min_le_max"
  CHECK ("min_stock_qty" IS NULL OR "max_stock_qty" IS NULL OR "max_stock_qty" >= "min_stock_qty");
ALTER TABLE "rev_tools" ADD CONSTRAINT "ck_rev_tools_total_qty_nonneg" CHECK ("is_consumable" OR "total_qty" >= 0);

ALTER TABLE "rev_cutting_tool_catalog" ADD CONSTRAINT "ck_rev_cutting_tool_catalog_status"
  CHECK ("status" IN ('active','scrapped'));
ALTER TABLE "rev_cutting_tool_catalog" ADD CONSTRAINT "ck_rev_cutting_max_stock_nonneg"
  CHECK ("max_stock_qty" IS NULL OR "max_stock_qty" >= 0);
ALTER TABLE "rev_cutting_tool_catalog" ADD CONSTRAINT "ck_rev_cutting_min_le_max"
  CHECK ("min_stock_qty" IS NULL OR "max_stock_qty" IS NULL OR "max_stock_qty" >= "min_stock_qty");

ALTER TABLE "rev_cutting_tool_stock" ADD CONSTRAINT "ck_rev_cutting_tool_stock_on_hand_qty" CHECK ("on_hand_qty" >= 0);

ALTER TABLE "rev_documents" ADD CONSTRAINT "ck_rev_documents_doc_type"
  CHECK ("doc_type" IN ('TOOL','COOPERATION_GOODS','CUTTING_TOOL'));
ALTER TABLE "rev_documents" ADD CONSTRAINT "ck_rev_documents_recipient_type"
  CHECK ("recipient_type" IN ('EMPLOYEE','DEPARTMENT','EXTERNAL_COMPANY','MACHINE'));
ALTER TABLE "rev_documents" ADD CONSTRAINT "ck_rev_documents_status"
  CHECK ("status" IN ('OPEN','PARTIALLY_RETURNED','RETURNED','CANCELLED'));

ALTER TABLE "rev_document_lines" ADD CONSTRAINT "ck_rev_document_lines_line_type"
  CHECK ("line_type" IN ('TOOL','PRODUCTION_PART','CUTTING_TOOL'));
ALTER TABLE "rev_document_lines" ADD CONSTRAINT "ck_rev_document_lines_line_status"
  CHECK ("line_status" IN ('ISSUED','RETURNED','LOST','SCRAPPED','CONSUMED'));

ALTER TABLE "rev_document_cutting_assignees" ADD CONSTRAINT "ck_rev_document_cutting_assignees_role"
  CHECK ("role" IN ('PRIMARY','SECONDARY'));

ALTER TABLE "rev_recipient_locations" ADD CONSTRAINT "ck_rev_recipient_locations_recipient_type"
  CHECK ("recipient_type" IN ('EMPLOYEE','DEPARTMENT','EXTERNAL_COMPANY','MACHINE'));

ALTER TABLE "rev_machine_heads" ADD CONSTRAINT "ck_rev_machine_heads_status"
  CHECK ("status" IN ('ACTIVE','SERVIS','OTPISANA'));

ALTER TABLE "rev_tool_batteries" ADD CONSTRAINT "ck_rev_tool_batteries_status"
  CHECK ("status" IN ('active','scrapped','lost'));

ALTER TABLE "rev_tool_service_log" ADD CONSTRAINT "ck_rev_tool_service_log_tip"
  CHECK ("tip" IN ('servis','popravka','zamena_baterije','kalibracija','ostalo'));
ALTER TABLE "rev_tool_service_log" ADD CONSTRAINT "ck_rev_tool_service_log_status"
  CHECK ("status" IN ('planiran','u_toku','zavrsen','otkazan'));

ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "ck_rev_tool_stock_ledger_delta_nonzero" CHECK ("delta" <> 0);
ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "ck_rev_tool_stock_ledger_reason"
  CHECK ("reason" IN ('RECEIPT','ISSUE','RETURN','ADJUST','WRITE_OFF'));

-- ── 3. Izrazni / parcijalni indeksi (Prisma ih ne ume) ──────────────────────────

-- 🔴 Šifra lokacije je jedinstvena U OKVIRU RODITELJA i BEZ OBZIRA NA VELIČINU SLOVA.
-- Bez ovoga bi „P-01" i „p-01" pod istom policom bile dve lokacije.
CREATE UNIQUE INDEX "uq_loc_locations_scope_code_ci"
  ON "loc_locations" (COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("location_code"));

CREATE INDEX "idx_loc_locations_type_active" ON "loc_locations" ("location_type") WHERE "is_active";

-- 🔴 Idempotencija sa mobilne: isti offline događaj poslat dvaput = jedan red.
-- Parcijalni je da bi NULL (upisi iz veb-a) i dalje bili dozvoljeni bez ograničenja.
CREATE UNIQUE INDEX "uq_loc_location_movements_client_event_uuid"
  ON "loc_location_movements" ("client_event_uuid") WHERE "client_event_uuid" IS NOT NULL;

CREATE INDEX "idx_loc_location_movements_order_no" ON "loc_location_movements" ("order_no") WHERE "order_no" <> '';
CREATE INDEX "idx_loc_location_movements_drawing_no" ON "loc_location_movements" ("drawing_no") WHERE "drawing_no" <> '';
CREATE INDEX "idx_loc_location_movements_sync_pending" ON "loc_location_movements" ("sync_status")
  WHERE "sync_status" IN ('PENDING','FAILED');
CREATE INDEX "idx_loc_location_movements_source_nonmanual" ON "loc_location_movements" ("source") WHERE "source" <> 'manual';

CREATE INDEX "idx_loc_item_placements_order_no" ON "loc_item_placements" ("order_no") WHERE "order_no" <> '';
CREATE INDEX "idx_loc_item_placements_drawing_no" ON "loc_item_placements" ("drawing_no") WHERE "drawing_no" <> '';

CREATE INDEX "idx_loc_sync_alerts_queue" ON "loc_sync_alerts_outbox" ("status", "next_attempt_at")
  WHERE "status" IN ('queued','failed');

-- 🔴 Idempotencija masovnog uvoza reversa (`rev_issue_reversal` je proverava PRE upisa).
CREATE UNIQUE INDEX "uq_rev_documents_bulk_import_legacy_key"
  ON "rev_documents" ("bulk_import_legacy_key")
  WHERE "bulk_import_legacy_key" IS NOT NULL AND btrim("bulk_import_legacy_key") <> '';

CREATE INDEX "idx_rev_cutting_tool_catalog_machines_gin"
  ON "rev_cutting_tool_catalog" USING gin ("compatible_machine_codes");
CREATE INDEX "idx_rev_cutting_tool_catalog_bigtehn_sifra"
  ON "rev_cutting_tool_catalog" ("bigtehn_sifra_artikla") WHERE "bigtehn_sifra_artikla" IS NOT NULL;
CREATE INDEX "idx_rev_tools_bigtehn_sifra"
  ON "rev_tools" ("bigtehn_sifra_artikla") WHERE "bigtehn_sifra_artikla" IS NOT NULL;
CREATE INDEX "idx_rev_cutting_tool_stock_nonzero"
  ON "rev_cutting_tool_stock" ("catalog_id") WHERE "on_hand_qty" > 0;

-- ── 4. Šta NAMERNO NIJE preneto iz sy15 ─────────────────────────────────────────
--
--  • 42 + 9 RLS politika (`rev_*` / `loc_*`, sve nad rolom `authenticated`). U 3.0
--    pravo se proverava u `PermissionsGuard`-u (AUTHZ_UNIFIED), ne u bazi; RLS nad
--    `authenticated` bi ovde bio prazna brava jer 3.0 backend ide kao vlasnik šeme.
--    Preslikavanje politika u dozvole je popisano u runbook-u §7 (ostaje da se uradi).
--
--  • 20 trigera. `loc_after_movement_insert` (održava `loc_item_placements` + puni
--    izlazni red) i `loc_locations_guard_and_path` (računa `path_cached`/`depth`)
--    NISU obična „touch" logika — to je poslovna logika i prepisuje se u TypeScript
--    unutar jedne Prisma transakcije. Dok nije prepisana, prekidač drži domen na sy15.
--
--  • 59 funkcija (48 SECURITY DEFINER). Dve najteže — `rev_issue_reversal` i
--    `rev_confirm_return` — su detaljno razložene u runbook-u §4.
--
--  • `bigtehn_work_orders_cache` (40.758 redova). Izmereno: `max(synced_at)` =
--    2026-07-14 — mrtav snimak. 3.0 `work_orders` (41.173) ga zamenjuje.

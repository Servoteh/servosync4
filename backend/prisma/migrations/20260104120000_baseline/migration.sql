-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "default_users" (
    "username" VARCHAR(20) NOT NULL,
    "default_year" INTEGER DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
    "default_org_unit_id" INTEGER DEFAULT 0,
    "default_department_id" INTEGER DEFAULT 0,
    "unlock_year" BOOLEAN DEFAULT false,
    "unlock_org_unit" BOOLEAN DEFAULT false,
    "unlock_department" BOOLEAN DEFAULT false,
    "level" SMALLINT DEFAULT 0,
    "max_level" SMALLINT DEFAULT 0,

    CONSTRAINT "pk_default_users" PRIMARY KEY ("username")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_departments" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizational_units" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_organizational_units" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_rights" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(20) NOT NULL,
    "form_name" VARCHAR(50) NOT NULL,
    "control_name" VARCHAR(50) NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "value" VARCHAR(250),
    "record_source" TEXT,
    "filter" VARCHAR(250),

    CONSTRAINT "pk_access_rights" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "global_config" (
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "parameter" VARCHAR(120) NOT NULL,
    "value" TEXT,
    "type" VARCHAR(20),
    "description" VARCHAR(100),

    CONSTRAINT "pk_global_config" PRIMARY KEY ("company_id","parameter")
);

-- CreateTable
CREATE TABLE "system_config" (
    "parameter" VARCHAR(120) NOT NULL,
    "value" VARCHAR(50),
    "type" VARCHAR(20),
    "description" VARCHAR(255),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_system_config" PRIMARY KEY ("parameter")
);

-- CreateTable
CREATE TABLE "price_list_entries" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL DEFAULT 0,
    "document_type_code" VARCHAR(5) NOT NULL,
    "price" DOUBLE PRECISION DEFAULT 0,
    "tax_rate_code" VARCHAR(5) NOT NULL,
    "price_without_vat" DECIMAL(19,4) DEFAULT 0,
    "fee" DOUBLE PRECISION DEFAULT 0,
    "print" BOOLEAN DEFAULT true,
    "price_with_vat" DECIMAL(19,4) DEFAULT 0,
    "check_price_with_vat" BOOLEAN DEFAULT false,
    "is_locked" BOOLEAN DEFAULT false,

    CONSTRAINT "pk_price_list_entries" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(5) NOT NULL,
    "base_rate" DOUBLE PRECISION DEFAULT 0,
    "railway_rate" DOUBLE PRECISION DEFAULT 0,
    "city_rate" DOUBLE PRECISION DEFAULT 0,
    "war_rate" DOUBLE PRECISION DEFAULT 0,
    "special_rate" DOUBLE PRECISION DEFAULT 0,
    "description" TEXT,
    "valid_from" TIMESTAMP(6),
    "valid_to" TIMESTAMP(6),
    "vat_group" VARCHAR(10) DEFAULT 'VISA',

    CONSTRAINT "pk_tax_rates" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(6),
    "sent_by" VARCHAR(250),
    "received" BOOLEAN DEFAULT false,
    "received_at" TIMESTAMP(6),
    "received_by" VARCHAR(250),

    CONSTRAINT "pk_notifications" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "branch" VARCHAR(50),
    "city" VARCHAR(30),
    "address" VARCHAR(50),
    "postal_code" VARCHAR(20),
    "bank_account_1" VARCHAR(30),
    "bank_account_2" VARCHAR(30),
    "bank_account_3" VARCHAR(30),
    "phone" VARCHAR(20),
    "fax" VARCHAR(20),
    "contact" VARCHAR(50),
    "note" TEXT,
    "country" VARCHAR(30),
    "region" INTEGER DEFAULT 0,
    "code_type_code" VARCHAR(10) DEFAULT 'KUPDOB',
    "email" VARCHAR(50),
    "mobile" VARCHAR(20),
    "birth_date" TIMESTAMP(6),
    "web_address" VARCHAR(50),
    "salesperson_id" INTEGER DEFAULT 0,
    "customer_discount" DOUBLE PRECISION DEFAULT 0,
    "buyer_protection_code" VARCHAR(50),
    "tax_id" VARCHAR(20) NOT NULL,
    "vat_status" INTEGER DEFAULT 0,
    "external_code" VARCHAR(10),
    "payment_term_days" SMALLINT DEFAULT 0,
    "route_id" INTEGER DEFAULT 0,
    "driver_id" INTEGER DEFAULT 0,
    "payment_account_id" INTEGER DEFAULT 0,
    "invoice_per_delivery_address" BOOLEAN DEFAULT true,
    "price_list_code" VARCHAR(5),
    "created_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6),
    "created_by" VARCHAR(20),
    "updated_by" VARCHAR(20),
    "commission_percent" DOUBLE PRECISION DEFAULT 0,
    "fictitious_discount" DOUBLE PRECISION DEFAULT 0,
    "payment_method" VARCHAR(50),
    "signature" VARCHAR(50),
    "short_name" VARCHAR(30),
    "record_created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "check_debt" BOOLEAN DEFAULT false,
    "credit_limit" DECIMAL(19,4) DEFAULT 0,
    "skip_tax_id_validation" BOOLEAN DEFAULT false,
    "pantheon_id" VARCHAR(30),
    "newsletter" BOOLEAN DEFAULT false,
    "mail_to_different_address" BOOLEAN DEFAULT false,
    "gln" VARCHAR(30),
    "manual_markup_percent" DECIMAL(19,4) DEFAULT 0,
    "balance_note" TEXT,
    "hide_in_overview" BOOLEAN DEFAULT false,
    "public_sector_id" VARCHAR(10),
    "registration_number" VARCHAR(20),
    "einvoice_xml_per_item_discount" BOOLEAN DEFAULT false,
    "central_invoice_registry" BOOLEAN DEFAULT false,

    CONSTRAINT "pk_customers" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_components" (
    "id" SERIAL NOT NULL,
    "parent_drawing_id" INTEGER NOT NULL,
    "child_drawing_id" INTEGER NOT NULL,
    "required_quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pk_drawing_components" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawings" (
    "id" SERIAL NOT NULL,
    "external_id" VARCHAR(20) NOT NULL,
    "transaction_date" TIMESTAMP(6),
    "design_date" TIMESTAMP(6),
    "designed_by" VARCHAR(50),
    "approved_date" TIMESTAMP(6),
    "approved_by" VARCHAR(50),
    "drawing_number" VARCHAR(20) NOT NULL,
    "revision" VARCHAR(3) NOT NULL DEFAULT 'A',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "catalog_number" VARCHAR(50) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "material" VARCHAR(255),
    "work_order_ref" VARCHAR(20),
    "dimensions" VARCHAR(255),
    "marking" VARCHAR(20) NOT NULL,
    "weight" DOUBLE PRECISION,
    "file_name" VARCHAR(500),
    "pdm_status" VARCHAR(20) NOT NULL,
    "comment" VARCHAR(255),
    "where_used" VARCHAR(255),
    "project_name" VARCHAR(255),
    "created_at" TIMESTAMP(6),
    "signature" VARCHAR(50),
    "status_id" INTEGER NOT NULL DEFAULT 0,
    "is_procurement" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pk_drawings" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_import_log" (
    "id" SERIAL NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_path" VARCHAR(1024) NOT NULL,
    "imported_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "status_message" VARCHAR(1000),
    "is_critical" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pk_drawing_import_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_pdfs" (
    "drawing_number" VARCHAR(100) NOT NULL,
    "revision" VARCHAR(10) NOT NULL,
    "file_name" VARCHAR(255),
    "uploaded_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "size_kb" INTEGER,
    "uploaded_by" VARCHAR(50) DEFAULT (SESSION_USER)::text,
    "pdf_binary" BYTEA,

    CONSTRAINT "pk_drawing_pdfs" PRIMARY KEY ("drawing_number","revision")
);

-- CreateTable
CREATE TABLE "drawing_plans" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "assembly_drawing_id" INTEGER,
    "quantity_to_produce" DECIMAL(18,4) NOT NULL,
    "planning_status" INTEGER NOT NULL DEFAULT 0,
    "planning_date" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "planning_worker_id" INTEGER NOT NULL,
    "note" VARCHAR(255),
    "signature" VARCHAR(30),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "is_locked" BOOLEAN,
    "plan_number" VARCHAR(30),
    "plan_drawing_number" VARCHAR(20),
    "plan_revision" VARCHAR(3),

    CONSTRAINT "pk_drawing_plans" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_plan_items" (
    "id" SERIAL NOT NULL,
    "plan_id" INTEGER NOT NULL,
    "procurement_drawing_id" INTEGER NOT NULL,
    "item_id" INTEGER,
    "quantity_per_assembly" DECIMAL(18,4) NOT NULL,
    "total_required" DECIMAL(18,4),
    "prev_check_plan_id" INTEGER,
    "decision_action" SMALLINT NOT NULL DEFAULT 0,
    "manual_quantity" DECIMAL(18,4),
    "reserved" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "to_procure" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "in_stock" DECIMAL(18,4),
    "item_name" VARCHAR(150),
    "item_catalog_number" VARCHAR(20),
    "item_unit" VARCHAR(5),
    "is_manual_item" BOOLEAN NOT NULL DEFAULT false,
    "exclude_from_procurement" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pk_drawing_plan_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_assemblies" (
    "id" SERIAL NOT NULL,
    "child_drawing_id" INTEGER NOT NULL,
    "parent_drawing_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "pk_drawing_assemblies" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_statuses" (
    "id" INTEGER NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "drawing_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mrp_demands" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "root_drawing_id" INTEGER,
    "worker_id" INTEGER,
    "source" SMALLINT NOT NULL,
    "explosion_type" SMALLINT,
    "status" SMALLINT NOT NULL DEFAULT 0,
    "demand_date" DATE NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(20),
    "updated_at" TIMESTAMP(6),
    "updated_by" VARCHAR(20),
    "planned_quantity" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "plan_id" INTEGER,

    CONSTRAINT "pk_mrp_demands" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mrp_demand_items" (
    "id" SERIAL NOT NULL,
    "demand_id" INTEGER NOT NULL,
    "source_drawing_id" INTEGER,
    "procurement_drawing_id" INTEGER,
    "item_id" INTEGER,
    "item_catalog_number" VARCHAR(100) NOT NULL,
    "item_name" VARCHAR(200) NOT NULL,
    "item_unit" VARCHAR(10) NOT NULL,
    "item_source" SMALLINT NOT NULL,
    "required_quantity" DECIMAL(19,6) NOT NULL,
    "demand_date" DATE NOT NULL,
    "lead_time_days" INTEGER,
    "procurement_date" DATE,
    "note" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(20),
    "updated_at" TIMESTAMP(6),
    "updated_by" VARCHAR(20),
    "supplier_id" INTEGER,
    "item_status" SMALLINT NOT NULL DEFAULT 0,
    "reserved_quantity" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "to_procure_quantity" DECIMAL(19,6) NOT NULL DEFAULT 0,

    CONSTRAINT "pk_mrp_demand_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mrp_item_stock" (
    "item_id" INTEGER NOT NULL,
    "in_stock" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "name" VARCHAR(200),
    "catalog_number" VARCHAR(100),
    "unit" VARCHAR(20),
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mrp_item_stock_pkey" PRIMARY KEY ("item_id")
);

-- CreateTable
CREATE TABLE "mrp_item_stock_tmp" (
    "item_id" INTEGER NOT NULL,
    "in_stock" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(19,6) NOT NULL DEFAULT 0,
    "name" VARCHAR(200),
    "catalog_number" VARCHAR(100),
    "unit" VARCHAR(20),

    CONSTRAINT "mrp_item_stock_tmp_pkey" PRIMARY KEY ("item_id")
);

-- CreateTable
CREATE TABLE "mrp_sync_status" (
    "sync_key" VARCHAR(50) NOT NULL,
    "last_synced_at" TIMESTAMP(6),
    "last_synced_by" VARCHAR(100),
    "note" VARCHAR(255),

    CONSTRAINT "mrp_sync_status_pkey" PRIMARY KEY ("sync_key")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "company_id" INTEGER DEFAULT 0,
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "street" VARCHAR(50),
    "city" VARCHAR(30),
    "average_prices" BOOLEAN DEFAULT false,
    "warehouse_type" VARCHAR(5),
    "account" VARCHAR(10),
    "manager_name" VARCHAR(30),
    "manager_id_number" VARCHAR(20),
    "signature_image_path" VARCHAR(250),

    CONSTRAINT "pk_warehouses" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_drafts" (
    "id" SERIAL NOT NULL,
    "designer_id" INTEGER NOT NULL,
    "draft_date" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "project_id" INTEGER NOT NULL,
    "piece_count" INTEGER NOT NULL,
    "status_id" INTEGER NOT NULL DEFAULT 0,
    "note" VARCHAR(250),
    "signature" VARCHAR(30),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "draft_number" VARCHAR(30) NOT NULL DEFAULT '',
    "is_locked" BOOLEAN DEFAULT false,
    "draft_type" SMALLINT NOT NULL DEFAULT 0,
    "main_drawing_id" INTEGER,

    CONSTRAINT "handover_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_draft_items" (
    "id" SERIAL NOT NULL,
    "draft_id" INTEGER NOT NULL,
    "drawing_id" INTEGER NOT NULL,
    "note" VARCHAR(250),
    "signature" VARCHAR(30),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "quantity_to_produce" INTEGER NOT NULL DEFAULT 1,
    "main_drawing_id" INTEGER,
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "pre_check_duplicate" BOOLEAN NOT NULL DEFAULT false,
    "pre_check_draft_id" INTEGER,
    "pre_check_work_order_id" INTEGER,
    "exclude_from_handover" BOOLEAN NOT NULL DEFAULT false,
    "decision_action" SMALLINT NOT NULL DEFAULT 0,
    "decision_date_time" TIMESTAMP(0),
    "quantity_defined_in_drawing" INTEGER DEFAULT 0,

    CONSTRAINT "handover_draft_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_draft_statuses" (
    "id" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "handover_draft_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_handovers" (
    "id" SERIAL NOT NULL,
    "drawing_id" INTEGER NOT NULL,
    "handover_date" TIMESTAMP(6) NOT NULL,
    "handover_worker_id" INTEGER NOT NULL,
    "status_id" INTEGER NOT NULL DEFAULT 0,
    "status_changed_at" TIMESTAMP(6),
    "status_changed_by_id" INTEGER,
    "status_change_comment" VARCHAR(250),
    "launched_at" TIMESTAMP(6),
    "launched_by_id" INTEGER,
    "note" VARCHAR(250),
    "signature" VARCHAR(30),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "is_locked" BOOLEAN DEFAULT false,

    CONSTRAINT "drawing_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drawing_handover_pdfs" (
    "id" SERIAL NOT NULL,
    "handover_id" INTEGER NOT NULL,
    "file_link" VARCHAR(1024) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,

    CONSTRAINT "drawing_handover_pdfs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handover_statuses" (
    "id" INTEGER NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_handover_statuses" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labels" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL,
    "tech_process_id" INTEGER NOT NULL,
    "ident_number" VARCHAR(20) NOT NULL,
    "bar_code" VARCHAR(20) NOT NULL,
    "project_name" VARCHAR(50) NOT NULL,
    "customer" VARCHAR(255) NOT NULL,
    "part_name" VARCHAR(250) NOT NULL,
    "drawing_number" VARCHAR(100) NOT NULL,
    "material" VARCHAR(250) NOT NULL,
    "entered_at" TIMESTAMP(6) NOT NULL,
    "quantity" SMALLINT NOT NULL,
    "total_quantity" SMALLINT,
    "print" BOOLEAN DEFAULT true,

    CONSTRAINT "pk_labels" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_parameters" (
    "username" VARCHAR(50) NOT NULL,
    "document_type" VARCHAR(10),
    "phone" VARCHAR(50),
    "last_invoice_number" INTEGER DEFAULT 0,
    "last_proforma_number" INTEGER DEFAULT 0,
    "invoice_through" VARCHAR(10),
    "proforma_through" VARCHAR(10),
    "invoice_prefix" VARCHAR(10),
    "proforma_prefix" VARCHAR(10),

    CONSTRAINT "pk_work_parameters" PRIMARY KEY ("username")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" SERIAL NOT NULL,
    "project_number" VARCHAR(20) NOT NULL,
    "description" VARCHAR(50),
    "opened_at" TIMESTAMP(6) DEFAULT (CURRENT_DATE)::timestamp without time zone,
    "salesperson_id" INTEGER NOT NULL DEFAULT 0,
    "customer_id" INTEGER NOT NULL,
    "next_action" VARCHAR(50),
    "closed_at" TIMESTAMP(6),
    "memo" TEXT,
    "status" VARCHAR(20),
    "our_ref" VARCHAR(20),
    "our_contact_1" VARCHAR(50),
    "our_contact_2" VARCHAR(50),
    "our_phone_1" VARCHAR(20),
    "our_phone_2" VARCHAR(20),
    "their_ref" VARCHAR(20),
    "their_contact_1" VARCHAR(50),
    "their_contact_2" VARCHAR(50),
    "their_phone_1" VARCHAR(20),
    "their_phone_2" VARCHAR(20),
    "procurement_value" DECIMAL(19,4) DEFAULT 0,
    "customs" DECIMAL(19,4) DEFAULT 0,
    "forwarding" DECIMAL(19,4) DEFAULT 0,
    "transport" DECIMAL(19,4) DEFAULT 0,
    "other" DECIMAL(19,4) DEFAULT 0,
    "foreign_supplier_id" INTEGER DEFAULT 0,
    "work_unit_code" VARCHAR(4),
    "currency" VARCHAR(3),
    "exchange_rate" DECIMAL(19,4) DEFAULT 0,
    "work_type_id" INTEGER DEFAULT 0,
    "project_name" VARCHAR(250),
    "deadline" TIMESTAMP(6),
    "signature" VARCHAR(50),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "contract_number" VARCHAR(100),
    "contract_date" TIMESTAMP(6),
    "order_number" VARCHAR(100),
    "order_date" TIMESTAMP(6),

    CONSTRAINT "pk_projects" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_work_types" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(20),
    "description" VARCHAR(150),

    CONSTRAINT "pk_project_work_types" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salespeople" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "region" INTEGER DEFAULT 0,
    "commission_percent" DOUBLE PRECISION DEFAULT 0,
    "split_in_team" BOOLEAN DEFAULT false,
    "first_name" VARCHAR(30),
    "id_number" VARCHAR(20),
    "login_account" VARCHAR(50),
    "password" VARCHAR(20),
    "active" BOOLEAN DEFAULT true,
    "non_fiscal_work_order" BOOLEAN DEFAULT false,
    "can_cancel" BOOLEAN DEFAULT false,
    "signature_image" VARCHAR(250),
    "team_code" VARCHAR(10) DEFAULT '000',
    "phone" VARCHAR(20),
    "email" VARCHAR(50),

    CONSTRAINT "pk_salespeople" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" SERIAL NOT NULL,
    "catalog_number" VARCHAR(20) NOT NULL DEFAULT '-',
    "bar_code" VARCHAR(50),
    "plu" INTEGER DEFAULT 0,
    "external_code" VARCHAR(20),
    "name" VARCHAR(50) NOT NULL,
    "unit" VARCHAR(5),
    "packaging" VARCHAR(10),
    "foreign_unit" VARCHAR(5),
    "box" DOUBLE PRECISION DEFAULT 0,
    "transport_packaging" DOUBLE PRECISION DEFAULT 0,
    "origin_code" VARCHAR(5) NOT NULL DEFAULT '0',
    "group_code" VARCHAR(10) NOT NULL,
    "subgroup_code" VARCHAR(10) NOT NULL DEFAULT '0',
    "goods_tax_rate_code" VARCHAR(5) NOT NULL DEFAULT '3',
    "service_tax_rate_code" VARCHAR(5) NOT NULL DEFAULT '1',
    "always_tax_goods" BOOLEAN DEFAULT true,
    "always_tax_services" BOOLEAN DEFAULT false,
    "wholesale_price" DOUBLE PRECISION DEFAULT 0,
    "retail_price" DOUBLE PRECISION DEFAULT 0,
    "fx_purchase_price" DOUBLE PRECISION DEFAULT 0,
    "fx_sale_price" DOUBLE PRECISION DEFAULT 0,
    "min_quantity" DOUBLE PRECISION DEFAULT 0,
    "item_fee" DOUBLE PRECISION DEFAULT 0,
    "payment_term_days" SMALLINT DEFAULT 0,
    "non_taxable_part" DOUBLE PRECISION DEFAULT 0,
    "max_discount_percent" DOUBLE PRECISION DEFAULT 100,
    "memo" TEXT,
    "accounting_code" VARCHAR(10) DEFAULT '0',
    "item_excise" DOUBLE PRECISION DEFAULT 0,
    "accounting_code_2" VARCHAR(10) DEFAULT '0',
    "final_processing_cost" DOUBLE PRECISION DEFAULT 0,
    "customs_rate" DOUBLE PRECISION DEFAULT 0,
    "raster_id" INTEGER DEFAULT 0,
    "customs_tariff" VARCHAR(20),
    "origin_country" VARCHAR(20),
    "shelf" VARCHAR(10),
    "foreign_name" VARCHAR(50),
    "supplier_id" INTEGER DEFAULT 1,
    "web_description" VARCHAR(255),
    "item_description" VARCHAR(50),
    "weight" DOUBLE PRECISION DEFAULT 0,
    "pdf_link" VARCHAR(255),
    "to_delete" BOOLEAN DEFAULT false,
    "active" BOOLEAN DEFAULT true,
    "price_to_write_pricelist" DOUBLE PRECISION DEFAULT 0,
    "issue_place_id" INTEGER DEFAULT 0,
    "manufacturer" VARCHAR(50),
    "hps" VARCHAR(50) DEFAULT 'O',
    "signature" VARCHAR(50),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "quantity_in_package" DOUBLE PRECISION DEFAULT 1,
    "manual_markup_percent" DECIMAL(19,4) DEFAULT 0,
    "base_unit" VARCHAR(5),
    "symbol_image_link" VARCHAR(250),
    "retail_loss_percent" DOUBLE PRECISION DEFAULT 0,
    "word_location" VARCHAR(250),
    "wholesale_loss_percent" DOUBLE PRECISION DEFAULT 0,
    "not_stock_tracked" BOOLEAN DEFAULT false,
    "weight_kg" DOUBLE PRECISION DEFAULT 0,
    "volume" DOUBLE PRECISION DEFAULT 0,
    "area" DOUBLE PRECISION DEFAULT 0,
    "sort_order" INTEGER DEFAULT 0,
    "promotion_discount" DOUBLE PRECISION DEFAULT 0,
    "note_2" VARCHAR(255),
    "quality_type_id" INTEGER DEFAULT 0,
    "thickness" DOUBLE PRECISION DEFAULT 0,
    "external_item_id" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_groups" (
    "code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_item_groups" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "item_subgroups" (
    "code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(50) NOT NULL,
    "parent_group" VARCHAR(10) DEFAULT '0',

    CONSTRAINT "pk_item_subgroups" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "item_origins" (
    "code" VARCHAR(5) NOT NULL,
    "description" VARCHAR(50) NOT NULL,
    "subgroup_code" VARCHAR(10) DEFAULT '0',
    "discount_percent" DECIMAL(19,4) DEFAULT 0,

    CONSTRAINT "pk_item_origins" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "document_types" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(5) NOT NULL,
    "description" VARCHAR(50) NOT NULL,
    "is_inbound" BOOLEAN NOT NULL DEFAULT false,
    "analytical_account" VARCHAR(10),
    "post_analytical" BOOLEAN DEFAULT false,
    "posting_template" INTEGER DEFAULT 0,
    "post_synthetic" BOOLEAN DEFAULT false,
    "sale_with_ppp" BOOLEAN DEFAULT false,
    "sale_with_ppu" BOOLEAN DEFAULT true,
    "post_retail_charge" BOOLEAN DEFAULT false,
    "post_retail_discharge" BOOLEAN DEFAULT false,
    "report_text" VARCHAR(50),
    "post_in_vat_ledger" BOOLEAN DEFAULT true,
    "kepu_default_charge" VARCHAR(30),
    "kepu_default_discharge" VARCHAR(30),
    "is_internal_document" BOOLEAN DEFAULT false,
    "numbering_start" INTEGER DEFAULT 0,
    "is_fiscal" BOOLEAN DEFAULT false,
    "document_number_prefix" VARCHAR(5),
    "default_warehouse_id" INTEGER DEFAULT 0,
    "is_departmental" BOOLEAN DEFAULT false,
    "is_fr" BOOLEAN DEFAULT false,
    "affects_stock" BOOLEAN DEFAULT true,

    CONSTRAINT "pk_document_types" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" INTEGER NOT NULL,
    "company_name" VARCHAR(150) NOT NULL,
    "database_name" VARCHAR(255),
    "logo" BYTEA,
    "city" VARCHAR(50),
    "address" VARCHAR(50),
    "phone" VARCHAR(50),
    "fax" VARCHAR(50),
    "bank_account" VARCHAR(50),
    "business_activity" VARCHAR(255),
    "business_activity_code" VARCHAR(50),
    "municipality" VARCHAR(50),
    "note" TEXT,
    "variant" VARCHAR(50) DEFAULT 'DEFAULT',
    "email" VARCHAR(30),
    "registration_number" VARCHAR(50),
    "registry_number" VARCHAR(50),
    "sub_accounts" VARCHAR(100),
    "pos_store_id" INTEGER DEFAULT 0,
    "pos_buyer_id" INTEGER DEFAULT 0,
    "pos_document_type_code" VARCHAR(5) DEFAULT 'MP1',
    "pos_work_order_id" INTEGER DEFAULT 0,
    "inbound_decimal_places" SMALLINT DEFAULT 2,
    "outbound_decimal_places" SMALLINT DEFAULT 2,
    "split_exchange_rate" BOOLEAN DEFAULT false,
    "check_warehouse_stock" BOOLEAN DEFAULT true,
    "auto_split_revenue" BOOLEAN DEFAULT false,
    "inbound_is_wholesale" BOOLEAN DEFAULT false,
    "kepu_at_purchase_price" BOOLEAN DEFAULT false,
    "retail_by_exchange_rate" BOOLEAN DEFAULT false,
    "kepu_by_exchange_rate" BOOLEAN DEFAULT false,
    "gk_by_exchange_rate" BOOLEAN DEFAULT false,
    "customer_account" VARCHAR(20) DEFAULT '2040',
    "supplier_account" VARCHAR(20) DEFAULT '4350',
    "post_retail_differences" BOOLEAN DEFAULT true,
    "post_kepu_differences" BOOLEAN DEFAULT true,
    "post_retail_kepu_differences" BOOLEAN DEFAULT true,
    "gk_by_exchange_rate_reverse" BOOLEAN DEFAULT false,
    "auto_lock_goods" BOOLEAN DEFAULT false,
    "auto_lock_gk" BOOLEAN DEFAULT false,
    "older_than_days_goods" INTEGER DEFAULT 7,
    "older_than_days_gk" INTEGER DEFAULT 7,
    "notification_check_interval" INTEGER DEFAULT 0,
    "decode_barcode" BOOLEAN DEFAULT false,
    "tax_id" VARCHAR(20),
    "warranty" TEXT,
    "kepu_at_cost_accounting_price" BOOLEAN DEFAULT false,
    "pepdv" VARCHAR(20),
    "owner" VARCHAR(50),
    "tax_code" VARCHAR(50),
    "galeb" BOOLEAN DEFAULT false,
    "raster" BOOLEAN DEFAULT false,
    "pg_database_name" VARCHAR(255),
    "is_galeb_server" BOOLEAN DEFAULT false,
    "is_galeb_client" BOOLEAN DEFAULT false,
    "fiscal_printer_name" VARCHAR(50) DEFAULT 'GALEB01',
    "invoice_issuing_place" VARCHAR(50) DEFAULT 'Beograd',
    "pos_cash_register_id" INTEGER DEFAULT 0,
    "web_address" VARCHAR(50),
    "apr_text" VARCHAR(250),
    "send_bosson" BOOLEAN DEFAULT false,
    "pos_price_list_code" VARCHAR(5) DEFAULT 'MP1',
    "wholesale_price_list_code" VARCHAR(5) DEFAULT 'STDCN',
    "footer_text" VARCHAR(255),
    "logo_footer" BYTEA,
    "report_header" VARCHAR(64) NOT NULL DEFAULT 'Memorandum_Header_STD',
    "report_footer" VARCHAR(64) NOT NULL DEFAULT 'Memorandum_Footer_STD',
    "logo_font_size" INTEGER NOT NULL DEFAULT 24,
    "vat_status" INTEGER NOT NULL DEFAULT 0,
    "public_sector_id" VARCHAR(20),
    "einvoice_api_key" VARCHAR(50),
    "unofficial_company_name" VARCHAR(150),

    CONSTRAINT "pk_companies" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_documents_mirror" (
    "id" INTEGER NOT NULL,
    "document_type" VARCHAR(5) NOT NULL,
    "document_date" DATE NOT NULL,

    CONSTRAINT "goods_documents_mirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_document_items_mirror" (
    "id" INTEGER NOT NULL,
    "document_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "catalog_number" VARCHAR(100),
    "warehouse_id" INTEGER NOT NULL,
    "quantity_in" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "quantity_out" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_document_items_mirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_entries" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "scheduled_date" TIMESTAMP(6) NOT NULL,
    "scheduled_time" TIMESTAMP(6) NOT NULL,
    "from_user" VARCHAR(50) NOT NULL,
    "to_user" VARCHAR(50) NOT NULL,
    "subject" VARCHAR(255) NOT NULL DEFAULT '-',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "repeat_code" VARCHAR(10) NOT NULL DEFAULT 'JEDNOM',
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "done_at" TIMESTAMP(6),
    "done_by" VARCHAR(50),
    "program_to_execute" VARCHAR(255),
    "auto_exec" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_planner_entries" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planner_user_groups" (
    "id" SERIAL NOT NULL,
    "group_name" VARCHAR(50) NOT NULL,
    "username" VARCHAR(50) NOT NULL,

    CONSTRAINT "planner_user_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_documents" (
    "id" SERIAL NOT NULL,
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "is_inbound" BOOLEAN NOT NULL DEFAULT false,
    "order_number" VARCHAR(20) NOT NULL,
    "order_type" VARCHAR(5) NOT NULL,
    "document_number" VARCHAR(20) NOT NULL,
    "document_type" VARCHAR(5) NOT NULL,
    "customer_id" INTEGER NOT NULL DEFAULT 0,
    "document_date" TIMESTAMP(6) NOT NULL,
    "posting_date" TIMESTAMP(6) NOT NULL,
    "due_date" TIMESTAMP(6) NOT NULL,
    "description" VARCHAR(30),
    "shipment_method" VARCHAR(30),
    "fco" VARCHAR(30),
    "statement_number" VARCHAR(20),
    "statement_date" TIMESTAMP(6),
    "salesperson_id" INTEGER DEFAULT 0,
    "payment_method" VARCHAR(50),
    "production_request_id" INTEGER DEFAULT 0,
    "warehouse_id" INTEGER NOT NULL DEFAULT 1,
    "memo" TEXT,
    "exchange_rate" DOUBLE PRECISION DEFAULT 1,
    "work_order_id" INTEGER DEFAULT 0,
    "accounting_exchange_rate" DOUBLE PRECISION DEFAULT 1,
    "customs" DOUBLE PRECISION DEFAULT 0,
    "forwarding" DOUBLE PRECISION DEFAULT 0,
    "other_dependent_costs" DOUBLE PRECISION DEFAULT 0,
    "fx_invoice_value" DOUBLE PRECISION DEFAULT 0,
    "level" SMALLINT DEFAULT 0,
    "project_id" INTEGER DEFAULT 0,
    "is_locked" BOOLEAN DEFAULT false,
    "linked_inbound_doc_id" INTEGER DEFAULT 0,
    "linked_invoice_doc_id" INTEGER DEFAULT 0,
    "reserve_stock" BOOLEAN DEFAULT false,
    "customs_exchange_rate" DOUBLE PRECISION DEFAULT 1,
    "linked_service_doc_id" INTEGER DEFAULT 0,
    "customs_refund_base" DOUBLE PRECISION DEFAULT 0,
    "currency" VARCHAR(3) DEFAULT 'DIN',
    "delivery_place_id" INTEGER DEFAULT 0,
    "route_id" INTEGER DEFAULT 0,
    "driver_id" INTEGER DEFAULT 0,
    "org_unit_id" INTEGER DEFAULT 0,
    "is_signed" BOOLEAN DEFAULT false,
    "department_id" INTEGER DEFAULT 0,
    "signature" VARCHAR(50),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "year" INTEGER DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer,
    "registered_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "contact_person_id" INTEGER DEFAULT 0,
    "cash_received" DECIMAL(19,4) DEFAULT 0,
    "payment_terms" VARCHAR(50),
    "checks_received" DECIMAL(19,4) DEFAULT 0,
    "card_received" DECIMAL(19,4) DEFAULT 0,
    "cash_register_id" INTEGER DEFAULT 0,
    "fiscal_printed" BOOLEAN DEFAULT false,
    "bank_transfer_received" DECIMAL(19,4) DEFAULT 0,
    "external_db_doc_id" INTEGER DEFAULT 0,
    "document_bar_code" VARCHAR(30),
    "document_box_count" SMALLINT DEFAULT 1,

    CONSTRAINT "pk_goods_documents" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_document_items" (
    "id" SERIAL NOT NULL,
    "document_id" INTEGER NOT NULL DEFAULT 0,
    "item_id" INTEGER NOT NULL DEFAULT 0,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "kg_quantity" DOUBLE PRECISION DEFAULT 0,
    "purchase_price_net" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dependent_cost_own" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dependent_cost_supplier" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "calculated_wholesale_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "calculated_retail_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actual_wholesale_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "actual_retail_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fee" DOUBLE PRECISION DEFAULT 0,
    "inbound_tax_calculated" BOOLEAN NOT NULL DEFAULT true,
    "inbound_goods_tax_rate" VARCHAR(5) NOT NULL DEFAULT '3',
    "services_tax_calculated" BOOLEAN NOT NULL DEFAULT true,
    "outbound_services_tax_rate" VARCHAR(5) NOT NULL DEFAULT '1',
    "goods_tax_calculated" BOOLEAN NOT NULL DEFAULT true,
    "outbound_goods_tax_rate" VARCHAR(5) NOT NULL DEFAULT '3',
    "discount_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cash_discount_percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payment_term_days" SMALLINT DEFAULT 0,
    "non_taxable_part" DOUBLE PRECISION DEFAULT 0,
    "excise" DOUBLE PRECISION DEFAULT 0,
    "fixed_tax" DOUBLE PRECISION DEFAULT 0,
    "fx_purchase_price" DOUBLE PRECISION DEFAULT 0,
    "warehouse_id" INTEGER NOT NULL DEFAULT 1,
    "accounting_price" DOUBLE PRECISION DEFAULT 0,
    "customs_rate" DOUBLE PRECISION DEFAULT 0,
    "project_item_id" INTEGER NOT NULL DEFAULT 0,
    "item_description" VARCHAR(50),
    "purchase_order_id" INTEGER DEFAULT 0,
    "package_per_base_unit" DOUBLE PRECISION DEFAULT 1,
    "copied_from_item_id" INTEGER,
    "posted_from_proforma_to_invoice" BOOLEAN DEFAULT false,
    "requisition_item_id" INTEGER DEFAULT 0,

    CONSTRAINT "pk_goods_document_items" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_accounts" (
    "company_id" INTEGER NOT NULL DEFAULT 0,
    "id" SERIAL NOT NULL,
    "account_number" VARCHAR(50) NOT NULL,
    "bank_name" VARCHAR(50),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" SMALLINT NOT NULL DEFAULT 0,
    "country_code" VARCHAR(20),
    "bank_code" VARCHAR(20),

    CONSTRAINT "pk_payment_accounts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "combo_values" (
    "column_name" VARCHAR(64) NOT NULL,
    "value" VARCHAR(255) NOT NULL,

    CONSTRAINT "pk_combo_values" PRIMARY KEY ("column_name","value")
);

-- CreateTable
CREATE TABLE "order_types" (
    "code" VARCHAR(5) NOT NULL,
    "description" VARCHAR(50),

    CONSTRAINT "pk_order_types" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "code_types" (
    "code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(50),

    CONSTRAINT "pk_code_types" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "journal" (
    "id" SERIAL NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_journal" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_access_log" (
    "id" SERIAL NOT NULL,
    "hardware_id" VARCHAR(100),
    "windows_user" VARCHAR(100),
    "computer_name" VARCHAR(100),
    "ip_address" VARCHAR(100),
    "program_name" VARCHAR(255),
    "connection_string" VARCHAR(255),
    "login_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_app_access_log" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registered_apps" (
    "database_name" VARCHAR(100),
    "app_name" VARCHAR(100) NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "app_file" VARCHAR(250) NOT NULL,
    "mdw_file" VARCHAR(250),
    "client_dir" VARCHAR(250),
    "download_dir" VARCHAR(1000),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_registered_apps" PRIMARY KEY ("app_name")
);

-- CreateTable
CREATE TABLE "registered_app_files" (
    "database_name" VARCHAR(100),
    "app_name" VARCHAR(100) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "client_dir" VARCHAR(255) NOT NULL,
    "install" BOOLEAN NOT NULL DEFAULT false,
    "update" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_registered_app_files" PRIMARY KEY ("app_name","file_name")
);

-- CreateTable
CREATE TABLE "registered_users" (
    "database_name" VARCHAR(100),
    "id" INTEGER NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "hardware_id" VARCHAR(100) NOT NULL,
    "windows_user" VARCHAR(100) NOT NULL,
    "computer_name" VARCHAR(100) NOT NULL,
    "ip_address" VARCHAR(100),
    "full_name" VARCHAR(100),
    "email" VARCHAR(100),
    "phone" VARCHAR(100),
    "description" VARCHAR(200),
    "valid_from" DATE,
    "valid_to" DATE,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_registered_users" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registered_user_apps" (
    "database_name" VARCHAR(100),
    "user_id" INTEGER NOT NULL,
    "app_name" VARCHAR(100) NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "bb_user_name" VARCHAR(50),
    "bb_password" VARCHAR(50),
    "bb_macro_name" VARCHAR(100),
    "excl" BOOLEAN NOT NULL DEFAULT false,
    "runtime" BOOLEAN NOT NULL DEFAULT false,
    "bb_extra_start_up" VARCHAR(100),
    "bb_cmd" VARCHAR(100),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_registered_user_apps" PRIMARY KEY ("user_id","app_name")
);

-- CreateTable
CREATE TABLE "app_revisions" (
    "id" SERIAL NOT NULL,
    "app" VARCHAR(20) NOT NULL DEFAULT 'DB',
    "version" VARCHAR(50) NOT NULL DEFAULT '-',
    "version_date" TIMESTAMP(6) NOT NULL DEFAULT (CURRENT_DATE)::timestamp without time zone,
    "topic" VARCHAR(100) NOT NULL DEFAULT '-',
    "description" TEXT,
    "is_done" BOOLEAN NOT NULL DEFAULT true,
    "company" VARCHAR(30) DEFAULT '-',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sub_revision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_app_revisions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_launches" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL DEFAULT 0,
    "is_launched" BOOLEAN DEFAULT false,
    "entered_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_worker_id" INTEGER NOT NULL DEFAULT 0,
    "created_by_signature" VARCHAR(50),
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_worker_id" INTEGER NOT NULL,
    "updated_by_signature" VARCHAR(50),

    CONSTRAINT "pk_work_order_launches" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_locations" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL DEFAULT 0,
    "project_id" INTEGER NOT NULL DEFAULT 0,
    "quality_type_id" INTEGER NOT NULL DEFAULT 0,
    "position_id" INTEGER NOT NULL DEFAULT 0,
    "worker_id" INTEGER NOT NULL DEFAULT 0,
    "record_date" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_part_locations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operations" (
    "work_center_code" VARCHAR(5) NOT NULL,
    "work_center_name" VARCHAR(50) NOT NULL,
    "note" VARCHAR(255),
    "work_unit_code" VARCHAR(5) NOT NULL,
    "without_process" BOOLEAN DEFAULT false,
    "significant_for_finishing" BOOLEAN DEFAULT false,
    "uses_priority" BOOLEAN NOT NULL DEFAULT false,
    "id" SERIAL NOT NULL,
    "is_skippable" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pk_operations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operations_fix" (
    "id" SERIAL NOT NULL,
    "work_center_code" VARCHAR(5) NOT NULL,
    "work_center_name" VARCHAR(50) NOT NULL,
    "note" VARCHAR(255),
    "work_unit_code" VARCHAR(5) NOT NULL,
    "without_process" BOOLEAN,
    "significant_for_finishing" BOOLEAN,
    "uses_priority" BOOLEAN NOT NULL
);

-- CreateTable
CREATE TABLE "work_order_machined_parts" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL DEFAULT 0,
    "position" VARCHAR(50) NOT NULL,
    "operation_id" INTEGER DEFAULT 0,
    "work_center_code" VARCHAR(5) NOT NULL,
    "part_name" VARCHAR(60),
    "drawing_number" VARCHAR(50),
    "quantity" INTEGER DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "worker_id" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_work_order_machined_parts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_blanks" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL DEFAULT 0,
    "position" VARCHAR(50) NOT NULL,
    "work_center_code" VARCHAR(5) NOT NULL,
    "material" VARCHAR(50),
    "material_dimension" VARCHAR(50),
    "unit" VARCHAR(5),
    "unit_weight" DOUBLE PRECISION DEFAULT 0,
    "quantity" INTEGER DEFAULT 0,
    "position_number" VARCHAR(50),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "worker_id" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_work_order_blanks" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_nonstandard_parts" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL DEFAULT 0,
    "position" VARCHAR(50) NOT NULL,
    "operation_id" INTEGER DEFAULT 0,
    "work_center_code" VARCHAR(5) NOT NULL,
    "part_name" VARCHAR(80) NOT NULL,
    "quantity" DOUBLE PRECISION DEFAULT 0,
    "note" VARCHAR(50),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "worker_id" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_work_order_nonstandard_parts" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" INTEGER NOT NULL,
    "position_code" VARCHAR(20) NOT NULL,
    "description" VARCHAR(250),

    CONSTRAINT "pk_positions" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_access" (
    "id" SERIAL NOT NULL,
    "worker_id" INTEGER NOT NULL,
    "work_center_code" VARCHAR(5) NOT NULL,
    "note" VARCHAR(250),

    CONSTRAINT "pk_machine_access" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL DEFAULT 0,
    "ident_number" VARCHAR(50) NOT NULL,
    "variant" INTEGER NOT NULL DEFAULT 0,
    "external_customer_id" INTEGER NOT NULL,
    "external_project_name" VARCHAR(250),
    "external_opened_at" TIMESTAMP(6) NOT NULL DEFAULT (CURRENT_DATE)::timestamp without time zone,
    "entered_at" TIMESTAMP(6) NOT NULL,
    "piece_count" INTEGER NOT NULL DEFAULT 1,
    "drawing_number" VARCHAR(100) NOT NULL,
    "product" VARCHAR(150),
    "unprocessed_part_weight" DOUBLE PRECISION DEFAULT 0,
    "part_name" VARCHAR(250) NOT NULL,
    "material_id" INTEGER DEFAULT 0,
    "material" VARCHAR(250) NOT NULL,
    "material_dimension" VARCHAR(150) NOT NULL,
    "unit" VARCHAR(50) NOT NULL,
    "processed_part_weight" DOUBLE PRECISION DEFAULT 0,
    "note" TEXT,
    "status" BOOLEAN DEFAULT false,
    "production_deadline" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "worker_id" INTEGER NOT NULL DEFAULT 0,
    "is_locked" BOOLEAN DEFAULT false,
    "signature" VARCHAR(50),
    "print_timer" INTEGER DEFAULT 0,
    "parent_drawing_ref" VARCHAR(100),
    "quality_type_id" INTEGER NOT NULL DEFAULT 0,
    "revision" VARCHAR(3) NOT NULL DEFAULT 'A',
    "drawing_handover_id" INTEGER NOT NULL DEFAULT 0,
    "drawing_id" INTEGER NOT NULL DEFAULT 0,
    "handover_status_id" INTEGER NOT NULL DEFAULT 3,
    "handover_worker_id" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pk_work_orders" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_components" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL,
    "component_work_order_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "note" VARCHAR(255),

    CONSTRAINT "work_order_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_item_components" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" VARCHAR(255),

    CONSTRAINT "work_order_item_components_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_item_groups" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(10) NOT NULL,
    "description" VARCHAR(50),

    CONSTRAINT "pk_production_item_groups" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_units" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(5) NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_work_units" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workers" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "commission_percent" DOUBLE PRECISION DEFAULT 0,
    "full_name" VARCHAR(50),
    "id_number" VARCHAR(20),
    "password" VARCHAR(20),
    "active" BOOLEAN DEFAULT true,
    "work_unit_code" VARCHAR(5) NOT NULL DEFAULT '0',
    "card_id" VARCHAR(50) NOT NULL,
    "login_account" VARCHAR(50),
    "worker_type_id" INTEGER NOT NULL DEFAULT 0,
    "signature_image" VARCHAR(150),
    "defines_approval" BOOLEAN DEFAULT false,
    "defines_launch" BOOLEAN DEFAULT false,
    "multi_account" BOOLEAN DEFAULT false,
    "worker_password" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_workers" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_approvals" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL DEFAULT 0,
    "is_approved" BOOLEAN DEFAULT false,
    "entered_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_worker_id" INTEGER NOT NULL DEFAULT 0,
    "created_by_signature" VARCHAR(50),
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_worker_id" INTEGER NOT NULL,
    "updated_by_signature" VARCHAR(50),

    CONSTRAINT "pk_work_order_approvals" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_operations" (
    "id" SERIAL NOT NULL,
    "work_order_id" INTEGER NOT NULL DEFAULT 0,
    "operation_number" INTEGER NOT NULL DEFAULT 0,
    "work_center_code" VARCHAR(5) NOT NULL,
    "work_description" TEXT NOT NULL,
    "tools_fixtures" VARCHAR(50),
    "setup_time" DOUBLE PRECISION DEFAULT 0,
    "cycle_time" DOUBLE PRECISION DEFAULT 0,
    "tool_weight" DOUBLE PRECISION DEFAULT 0,
    "worker_id" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "priority" INTEGER NOT NULL DEFAULT 100,

    CONSTRAINT "pk_work_order_operations" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_operation_images" (
    "id" SERIAL NOT NULL,
    "work_order_operation_id" INTEGER NOT NULL DEFAULT 0,
    "image_link" VARCHAR(250) NOT NULL,
    "file_name" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_work_order_operation_images" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_processes" (
    "id" SERIAL NOT NULL,
    "worker_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL DEFAULT 0,
    "ident_number" VARCHAR(50) NOT NULL,
    "variant" INTEGER NOT NULL DEFAULT 0,
    "print_timer" INTEGER DEFAULT 0,
    "entered_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operation_number" INTEGER NOT NULL,
    "work_center_code" VARCHAR(5) NOT NULL,
    "ident_mark" VARCHAR(50) NOT NULL,
    "piece_count" INTEGER NOT NULL,
    "signature" VARCHAR(50),
    "worker_symbol" BOOLEAN DEFAULT false,
    "process_symbol" BOOLEAN DEFAULT false,
    "operation_symbol" BOOLEAN DEFAULT false,
    "finished_at" TIMESTAMP(6),
    "is_process_finished" BOOLEAN DEFAULT false,
    "note" TEXT,
    "work_order_id" INTEGER NOT NULL DEFAULT 0,
    "quality_type_id" INTEGER NOT NULL DEFAULT 0,
    "rework_operation_id" INTEGER DEFAULT 0,

    CONSTRAINT "pk_tech_processes" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tech_processes_backup" (
    "id" SERIAL NOT NULL,
    "worker_id" INTEGER NOT NULL,
    "project_id" INTEGER NOT NULL,
    "ident_number" VARCHAR(50) NOT NULL,
    "variant" INTEGER NOT NULL,
    "print_timer" INTEGER,
    "entered_at" TIMESTAMP(6) NOT NULL,
    "operation_number" INTEGER NOT NULL,
    "work_center_code" VARCHAR(5) NOT NULL,
    "ident_mark" VARCHAR(50) NOT NULL,
    "piece_count" INTEGER NOT NULL,
    "signature" VARCHAR(50),
    "worker_symbol" BOOLEAN,
    "process_symbol" BOOLEAN,
    "operation_symbol" BOOLEAN,
    "finished_at" TIMESTAMP(6),
    "is_process_finished" BOOLEAN,
    "note" TEXT,
    "work_order_id" INTEGER NOT NULL,
    "quality_type_id" INTEGER NOT NULL,
    "rework_operation_id" INTEGER,
    "corrected_at" TIMESTAMP(6),
    "correction_note" VARCHAR(500)
);

-- CreateTable
CREATE TABLE "tech_process_documents" (
    "id" SERIAL NOT NULL,
    "tech_process_id" INTEGER NOT NULL,
    "file_link" VARCHAR(250) NOT NULL,
    "file_name" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_tech_process_documents" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "part_quality_types" (
    "id" INTEGER NOT NULL,
    "name" VARCHAR(50) NOT NULL,

    CONSTRAINT "pk_part_quality_types" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_types" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "additional_privileges" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pk_worker_types" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tmp_form_controls" (
    "form_name" VARCHAR(50) NOT NULL,
    "control_name" VARCHAR(50) NOT NULL,
    "control_type" VARCHAR(50),

    CONSTRAINT "pk_tmp_form_controls" PRIMARY KEY ("form_name","control_name")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_tax_rates_code" ON "tax_rates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_drawings_drawing_number_revision" ON "drawings"("drawing_number", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "uq_drawing_handover_pdfs_handover_link" ON "drawing_handover_pdfs"("handover_id", "file_link");

-- CreateIndex
CREATE UNIQUE INDEX "handover_statuses_name_key" ON "handover_statuses"("name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_operations_work_center_code" ON "operations"("work_center_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_work_order_components_parent_child" ON "work_order_components"("work_order_id", "component_work_order_id");

-- AddForeignKey
ALTER TABLE "default_users" ADD CONSTRAINT "fk_default_users_departments" FOREIGN KEY ("default_department_id") REFERENCES "departments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "default_users" ADD CONSTRAINT "fk_default_users_organizational_units" FOREIGN KEY ("default_org_unit_id") REFERENCES "organizational_units"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "fk_price_list_entries_items" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "price_list_entries" ADD CONSTRAINT "fk_price_list_entries_tax_rates" FOREIGN KEY ("tax_rate_code") REFERENCES "tax_rates"("code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "fk_customers_salespeople" FOREIGN KEY ("salesperson_id") REFERENCES "salespeople"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "fk_customers_driver" FOREIGN KEY ("driver_id") REFERENCES "customers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "fk_customers_code_types" FOREIGN KEY ("code_type_code") REFERENCES "code_types"("code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_components" ADD CONSTRAINT "fk_drawing_components_child" FOREIGN KEY ("child_drawing_id") REFERENCES "drawings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_components" ADD CONSTRAINT "fk_drawing_components_parent" FOREIGN KEY ("parent_drawing_id") REFERENCES "drawings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawings" ADD CONSTRAINT "fk_drawings_drawing_statuses" FOREIGN KEY ("status_id") REFERENCES "drawing_statuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_plans" ADD CONSTRAINT "fk_drawing_plans_assembly" FOREIGN KEY ("assembly_drawing_id") REFERENCES "drawings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_plan_items" ADD CONSTRAINT "fk_drawing_plan_items_drawing" FOREIGN KEY ("procurement_drawing_id") REFERENCES "drawings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_plan_items" ADD CONSTRAINT "fk_drawing_plan_items_plan" FOREIGN KEY ("plan_id") REFERENCES "drawing_plans"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_assemblies" ADD CONSTRAINT "fk_drawing_assemblies_child" FOREIGN KEY ("child_drawing_id") REFERENCES "drawings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_assemblies" ADD CONSTRAINT "fk_drawing_assemblies_parent" FOREIGN KEY ("parent_drawing_id") REFERENCES "drawings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "mrp_demand_items" ADD CONSTRAINT "fk_mrp_demand_items_demand" FOREIGN KEY ("demand_id") REFERENCES "mrp_demands"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "handover_drafts" ADD CONSTRAINT "fk_handover_drafts_main_drawing" FOREIGN KEY ("main_drawing_id") REFERENCES "drawings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "handover_drafts" ADD CONSTRAINT "fk_handover_drafts_projects" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "handover_drafts" ADD CONSTRAINT "fk_handover_drafts_designer" FOREIGN KEY ("designer_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "handover_drafts" ADD CONSTRAINT "fk_handover_drafts_status" FOREIGN KEY ("status_id") REFERENCES "handover_draft_statuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "handover_draft_items" ADD CONSTRAINT "fk_handover_draft_items_main_drawing" FOREIGN KEY ("main_drawing_id") REFERENCES "drawings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "handover_draft_items" ADD CONSTRAINT "fk_handover_draft_items_draft" FOREIGN KEY ("draft_id") REFERENCES "handover_drafts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_handovers" ADD CONSTRAINT "fk_drawing_handovers_drawing" FOREIGN KEY ("drawing_id") REFERENCES "drawings"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_handovers" ADD CONSTRAINT "fk_drawing_handovers_status" FOREIGN KEY ("status_id") REFERENCES "handover_statuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "drawing_handover_pdfs" ADD CONSTRAINT "fk_drawing_handover_pdfs_handover" FOREIGN KEY ("handover_id") REFERENCES "drawing_handovers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "goods_document_items_mirror" ADD CONSTRAINT "fk_goods_document_items_mirror_document" FOREIGN KEY ("document_id") REFERENCES "goods_documents_mirror"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_accounts" ADD CONSTRAINT "fk_payment_accounts_self" FOREIGN KEY ("id") REFERENCES "payment_accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "registered_app_files" ADD CONSTRAINT "fk_registered_app_files_app" FOREIGN KEY ("app_name") REFERENCES "registered_apps"("app_name") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "registered_user_apps" ADD CONSTRAINT "fk_registered_user_apps_app" FOREIGN KEY ("app_name") REFERENCES "registered_apps"("app_name") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "registered_user_apps" ADD CONSTRAINT "fk_registered_user_apps_user" FOREIGN KEY ("user_id") REFERENCES "registered_users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_launches" ADD CONSTRAINT "fk_work_order_launches_work_order" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "part_locations" ADD CONSTRAINT "fk_part_locations_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "part_locations" ADD CONSTRAINT "fk_part_locations_position" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "part_locations" ADD CONSTRAINT "fk_part_locations_worker" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_machined_parts" ADD CONSTRAINT "fk_work_order_machined_parts_worker" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_machined_parts" ADD CONSTRAINT "fk_work_order_machined_parts_operation" FOREIGN KEY ("work_center_code") REFERENCES "operations"("work_center_code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_machined_parts" ADD CONSTRAINT "fk_work_order_machined_parts_work_order" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_blanks" ADD CONSTRAINT "fk_work_order_blanks_worker" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_blanks" ADD CONSTRAINT "fk_work_order_blanks_operation" FOREIGN KEY ("work_center_code") REFERENCES "operations"("work_center_code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_blanks" ADD CONSTRAINT "fk_work_order_blanks_work_order" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_nonstandard_parts" ADD CONSTRAINT "fk_work_order_nonstandard_parts_worker" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_nonstandard_parts" ADD CONSTRAINT "fk_work_order_nonstandard_parts_operation" FOREIGN KEY ("work_center_code") REFERENCES "operations"("work_center_code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_nonstandard_parts" ADD CONSTRAINT "fk_work_order_nonstandard_parts_work_order" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "machine_access" ADD CONSTRAINT "fk_machine_access_operation" FOREIGN KEY ("work_center_code") REFERENCES "operations"("work_center_code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "machine_access" ADD CONSTRAINT "fk_machine_access_worker" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "fk_work_orders_handover_worker" FOREIGN KEY ("handover_worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "fk_work_orders_handover_status" FOREIGN KEY ("handover_status_id") REFERENCES "handover_statuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "fk_work_orders_worker" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "fk_work_orders_quality_type" FOREIGN KEY ("quality_type_id") REFERENCES "part_quality_types"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_components" ADD CONSTRAINT "fk_work_order_components_parent" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_item_components" ADD CONSTRAINT "fk_work_order_item_components_work_order" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_item_components" ADD CONSTRAINT "fk_work_order_item_components_item" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_approvals" ADD CONSTRAINT "fk_work_order_approvals_work_order" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_operations" ADD CONSTRAINT "fk_work_order_operations_worker" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_operations" ADD CONSTRAINT "fk_work_order_operations_operation" FOREIGN KEY ("work_center_code") REFERENCES "operations"("work_center_code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_operations" ADD CONSTRAINT "fk_work_order_operations_work_order" FOREIGN KEY ("work_order_id") REFERENCES "work_orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_order_operation_images" ADD CONSTRAINT "fk_work_order_operation_images_operation" FOREIGN KEY ("work_order_operation_id") REFERENCES "work_order_operations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tech_processes" ADD CONSTRAINT "fk_tech_processes_worker" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tech_process_documents" ADD CONSTRAINT "fk_tech_process_documents_tech_process" FOREIGN KEY ("tech_process_id") REFERENCES "tech_processes"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;


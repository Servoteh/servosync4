-- Seoba domena REVERSI iz sy15 u 3.0 bazu (priprema — NIJE primenjeno na produkciji).
-- Plan: docs/PLAN_GASENJA_SY15_2026-08-03.md korak 1; merenje i runbook: docs/SEOBA_REVERSA_2026-08-05.md
-- Prekidac izvora: REVERSI_IZVOR=sy15|3.0 (default sy15) — dok je `sy15`, ove tabele stoje prazne.
--
-- DEO 1 — generisano `prisma migrate diff` (datamodel->datamodel, offline; BACKEND_RULES §12 v0.7).

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
    "created_by" INTEGER,
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
    "otpis_by" INTEGER,
    "nabavna_vrednost" DECIMAL(12,2),

    CONSTRAINT "pk_rev_tools" PRIMARY KEY ("id")
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
    "issued_by" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "return_confirmed_by" INTEGER,
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
    "work_order_id" UUID,
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
    "created_by" INTEGER,
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
    "created_by" INTEGER,
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
    "created_by" INTEGER,

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
    "created_by" INTEGER,

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
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_rev_tool_stock_ledger" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_inventory_groups_code" ON "rev_inventory_groups"("code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_inventory_subgroups_group_code" ON "rev_inventory_subgroups"("group_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_inventory_subsubgroups_subgroup_code" ON "rev_inventory_subsubgroups"("subgroup_id", "code");

-- CreateIndex
CREATE INDEX "idx_rev_tools_subgroup" ON "rev_tools"("subgroup_id");

-- CreateIndex
CREATE INDEX "idx_rev_tools_status" ON "rev_tools"("status");

-- CreateIndex
CREATE INDEX "idx_rev_tools_oznaka" ON "rev_tools"("oznaka");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_tools_loc_item_ref_id" ON "rev_tools"("loc_item_ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_tools_barcode" ON "rev_tools"("barcode");

-- CreateIndex
CREATE INDEX "idx_rev_documents_doc_type_status" ON "rev_documents"("doc_type", "status");

-- CreateIndex
CREATE INDEX "idx_rev_documents_issued_at" ON "rev_documents"("issued_at");

-- CreateIndex
CREATE INDEX "idx_rev_documents_recipient_employee" ON "rev_documents"("recipient_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_documents_doc_number" ON "rev_documents"("doc_number");

-- CreateIndex
CREATE INDEX "idx_rev_document_lines_document" ON "rev_document_lines"("document_id");

-- CreateIndex
CREATE INDEX "idx_rev_document_lines_status" ON "rev_document_lines"("line_status");

-- CreateIndex
CREATE INDEX "idx_rev_document_lines_tool" ON "rev_document_lines"("tool_id");

-- CreateIndex
CREATE INDEX "idx_rev_document_lines_cutting_catalog" ON "rev_document_lines"("cutting_tool_catalog_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_recipient_locations_type_key" ON "rev_recipient_locations"("recipient_type", "recipient_key");

-- CreateIndex
CREATE INDEX "idx_rev_cutting_tool_catalog_oznaka" ON "rev_cutting_tool_catalog"("oznaka");

-- CreateIndex
CREATE INDEX "idx_rev_cutting_tool_catalog_status" ON "rev_cutting_tool_catalog"("status");

-- CreateIndex
CREATE INDEX "idx_rev_cutting_tool_catalog_subgroup" ON "rev_cutting_tool_catalog"("subgroup_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_cutting_tool_catalog_barcode" ON "rev_cutting_tool_catalog"("barcode");

-- CreateIndex
CREATE INDEX "idx_rev_cutting_tool_stock_location" ON "rev_cutting_tool_stock"("location_id");

-- CreateIndex
CREATE INDEX "idx_rev_document_cutting_assignees_document" ON "rev_document_cutting_assignees"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_rev_document_cutting_assignees_doc_employee" ON "rev_document_cutting_assignees"("document_id", "employee_id");

-- CreateIndex
CREATE INDEX "idx_rev_machine_heads_machine_code" ON "rev_machine_heads"("machine_code");

-- CreateIndex
CREATE INDEX "idx_rev_tool_batteries_tool" ON "rev_tool_batteries"("tool_id");

-- CreateIndex
CREATE INDEX "idx_rev_tool_service_log_tool" ON "rev_tool_service_log"("tool_id");

-- CreateIndex
CREATE INDEX "idx_rev_tool_stock_ledger_tool" ON "rev_tool_stock_ledger"("tool_id");

-- CreateIndex
CREATE INDEX "idx_rev_tool_stock_ledger_created_at" ON "rev_tool_stock_ledger"("created_at");

-- AddForeignKey
ALTER TABLE "rev_inventory_subgroups" ADD CONSTRAINT "fk_rev_inventory_subgroups_group" FOREIGN KEY ("group_id") REFERENCES "rev_inventory_groups"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_inventory_subsubgroups" ADD CONSTRAINT "fk_rev_inventory_subsubgroups_subgroup" FOREIGN KEY ("subgroup_id") REFERENCES "rev_inventory_subgroups"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tools" ADD CONSTRAINT "fk_rev_tools_subgroup" FOREIGN KEY ("subgroup_id") REFERENCES "rev_inventory_subgroups"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tools" ADD CONSTRAINT "fk_rev_tools_subsubgroup" FOREIGN KEY ("subsubgroup_id") REFERENCES "rev_inventory_subsubgroups"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tools" ADD CONSTRAINT "fk_rev_tools_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tools" ADD CONSTRAINT "fk_rev_tools_otpis_by" FOREIGN KEY ("otpis_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_documents" ADD CONSTRAINT "fk_rev_documents_issued_by" FOREIGN KEY ("issued_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_documents" ADD CONSTRAINT "fk_rev_documents_return_confirmed_by" FOREIGN KEY ("return_confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_lines" ADD CONSTRAINT "fk_rev_document_lines_document" FOREIGN KEY ("document_id") REFERENCES "rev_documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_lines" ADD CONSTRAINT "fk_rev_document_lines_tool" FOREIGN KEY ("tool_id") REFERENCES "rev_tools"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_lines" ADD CONSTRAINT "fk_rev_document_lines_cutting_catalog" FOREIGN KEY ("cutting_tool_catalog_id") REFERENCES "rev_cutting_tool_catalog"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_cutting_tool_catalog" ADD CONSTRAINT "fk_rev_cutting_tool_catalog_subgroup" FOREIGN KEY ("subgroup_id") REFERENCES "rev_inventory_subgroups"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_cutting_tool_catalog" ADD CONSTRAINT "fk_rev_cutting_tool_catalog_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_cutting_tool_stock" ADD CONSTRAINT "fk_rev_cutting_tool_stock_catalog" FOREIGN KEY ("catalog_id") REFERENCES "rev_cutting_tool_catalog"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_document_cutting_assignees" ADD CONSTRAINT "fk_rev_document_cutting_assignees_document" FOREIGN KEY ("document_id") REFERENCES "rev_documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_machine_heads" ADD CONSTRAINT "fk_rev_machine_heads_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_batteries" ADD CONSTRAINT "fk_rev_tool_batteries_tool" FOREIGN KEY ("tool_id") REFERENCES "rev_tools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_batteries" ADD CONSTRAINT "fk_rev_tool_batteries_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_service_log" ADD CONSTRAINT "fk_rev_tool_service_log_tool" FOREIGN KEY ("tool_id") REFERENCES "rev_tools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_service_log" ADD CONSTRAINT "fk_rev_tool_service_log_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "fk_rev_tool_stock_ledger_tool" FOREIGN KEY ("tool_id") REFERENCES "rev_tools"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "fk_rev_tool_stock_ledger_ref_doc" FOREIGN KEY ("ref_doc_id") REFERENCES "rev_documents"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "fk_rev_tool_stock_ledger_ref_line" FOREIGN KEY ("ref_line_id") REFERENCES "rev_document_lines"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rev_tool_stock_ledger" ADD CONSTRAINT "fk_rev_tool_stock_ledger_created_by" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;


-- ===========================================================================
-- DEO 2 — ono što Prisma ne ume da izrazi, a domen bez toga ne radi.
-- Verno preneseno iz sy15 (pg_get_functiondef / pg_get_triggerdef, 05.08.2026),
-- uz dve svesne izmene naspram sy15:
--   * funkcije su SECURITY INVOKER (3.0 nema RLS ni `auth.uid()`; granica je
--     PermissionsGuard u NestJS-u — BACKEND_RULES §7 / AUTHZ_UNIFIED),
--   * `touch_updated_at` trigeri se NE prenose — `updated_at` u 3.0 drži Prisma
--     kroz `@updatedAt`, pa bi trigger bio drugi izvor istine za isto polje.
-- ===========================================================================

-- --- Sekvence barkodova ----------------------------------------------------
-- Barkod je NOT NULL i kuje ga trigger. Sekvence kreću od 1; skripta prenosa
-- (backend/scripts/migrate-reversi-sy15.ts) ih posle uvoza pomera na
-- max(postojeci_broj) preko setval() da novi barkod ne bi udario u preneseni.
-- Izmereno u sy15 05.08: rev_tools_barcode_seq=99, rev_cutting_tool_barcode_seq=70.
CREATE SEQUENCE IF NOT EXISTS "rev_tools_barcode_seq" AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS "rev_cutting_tool_barcode_seq" AS bigint START WITH 1 INCREMENT BY 1;

-- --- Dodela barkoda / loc reference ----------------------------------------
CREATE OR REPLACE FUNCTION rev_tools_set_barcode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.barcode IS NULL OR btrim(NEW.barcode) = '' THEN
    NEW.barcode := 'ALAT-' || lpad(nextval('public.rev_tools_barcode_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

-- `loc_item_ref_id` je ključ kojim Lokacije (`loc_item_placements.item_ref_id`,
-- uz `item_ref_table='rev_tools'`) prate fizički smeštaj jedinice. Oblik se NE sme
-- menjati dok su Lokacije u sy15 — postojeći placement-i se vezuju po ovom stringu.
CREATE OR REPLACE FUNCTION rev_tools_set_item_ref() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.loc_item_ref_id := 'rev_tools:' || NEW.id::text;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rev_cutting_tool_set_barcode() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.barcode IS NULL OR btrim(NEW.barcode) = '' THEN
    NEW.barcode := 'RZN-' || lpad(nextval('public.rev_cutting_tool_barcode_seq')::text, 6, '0');
  END IF;
  RETURN NEW;
END;
$$;

-- --- Čuvari klasifikacije --------------------------------------------------
-- Rezni alat i ručni alat dele stablo klasifikacije, pa se grupa REZNI drži
-- odvojeno: rezni alat MORA u REZNI, ručni NE SME u REZNI.
CREATE OR REPLACE FUNCTION rev_check_tools_subgroup_group() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_code text;
BEGIN
  IF NEW.subgroup_id IS NULL THEN RETURN NEW; END IF;
  SELECT g.code INTO v_code
    FROM public.rev_inventory_subgroups s
    JOIN public.rev_inventory_groups g ON g.id = s.group_id
   WHERE s.id = NEW.subgroup_id;
  IF v_code = 'REZNI' THEN
    RAISE EXCEPTION 'rev_tools ne sme imati podgrupu iz grupe REZNI (rezni alat ide u rev_cutting_tool_catalog).'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rev_check_tools_subsubgroup() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_sg uuid;
BEGIN
  IF NEW.subsubgroup_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.subgroup_id IS NULL THEN
    RAISE EXCEPTION 'Podpodgrupa zahteva izabranu podgrupu.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT subgroup_id INTO v_sg FROM public.rev_inventory_subsubgroups WHERE id = NEW.subsubgroup_id;
  IF v_sg IS DISTINCT FROM NEW.subgroup_id THEN
    RAISE EXCEPTION 'Podpodgrupa ne pripada izabranoj podgrupi.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rev_check_cutting_subgroup_group() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_code text;
BEGIN
  IF NEW.subgroup_id IS NULL THEN RETURN NEW; END IF;
  SELECT g.code INTO v_code
    FROM public.rev_inventory_subgroups s
    JOIN public.rev_inventory_groups g ON g.id = s.group_id
   WHERE s.id = NEW.subgroup_id;
  IF v_code IS DISTINCT FROM 'REZNI' THEN
    RAISE EXCEPTION 'rev_cutting_tool_catalog mora imati podgrupu iz grupe REZNI (dobio: %).', v_code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- --- Kačenje trigera -------------------------------------------------------
DROP TRIGGER IF EXISTS rev_tools_before_insert_barcode ON "rev_tools";
CREATE TRIGGER rev_tools_before_insert_barcode
  BEFORE INSERT ON "rev_tools"
  FOR EACH ROW EXECUTE FUNCTION rev_tools_set_barcode();

DROP TRIGGER IF EXISTS rev_tools_before_insert ON "rev_tools";
CREATE TRIGGER rev_tools_before_insert
  BEFORE INSERT ON "rev_tools"
  FOR EACH ROW EXECUTE FUNCTION rev_tools_set_item_ref();

DROP TRIGGER IF EXISTS rev_tools_subgroup_guard ON "rev_tools";
CREATE TRIGGER rev_tools_subgroup_guard
  BEFORE INSERT OR UPDATE OF subgroup_id ON "rev_tools"
  FOR EACH ROW EXECUTE FUNCTION rev_check_tools_subgroup_group();

DROP TRIGGER IF EXISTS rev_tools_subsubgroup_guard ON "rev_tools";
CREATE TRIGGER rev_tools_subsubgroup_guard
  BEFORE INSERT OR UPDATE OF subgroup_id, subsubgroup_id ON "rev_tools"
  FOR EACH ROW EXECUTE FUNCTION rev_check_tools_subsubgroup();

DROP TRIGGER IF EXISTS rev_cutting_tool_catalog_before_insert ON "rev_cutting_tool_catalog";
CREATE TRIGGER rev_cutting_tool_catalog_before_insert
  BEFORE INSERT ON "rev_cutting_tool_catalog"
  FOR EACH ROW EXECUTE FUNCTION rev_cutting_tool_set_barcode();

DROP TRIGGER IF EXISTS rev_cutting_tool_catalog_subgroup_guard ON "rev_cutting_tool_catalog";
CREATE TRIGGER rev_cutting_tool_catalog_subgroup_guard
  BEFORE INSERT OR UPDATE OF subgroup_id ON "rev_cutting_tool_catalog"
  FOR EACH ROW EXECUTE FUNCTION rev_check_cutting_subgroup_group();

-- --- Brojčane invarijante --------------------------------------------------
-- Statusni CHECK-ovi iz sy15 se NAMERNO ne prenose (BACKEND_RULES §2 — katalog
-- vrednosti živi u `///` komentaru šeme). Ovo su poslovna pravila, ne katalozi.
ALTER TABLE "rev_tools"
  ADD CONSTRAINT "ck_rev_tools_min_stock_nonneg"  CHECK (min_stock_qty IS NULL OR min_stock_qty >= 0),
  ADD CONSTRAINT "ck_rev_tools_max_stock_nonneg"  CHECK (max_stock_qty IS NULL OR max_stock_qty >= 0),
  ADD CONSTRAINT "ck_rev_tools_min_le_max"        CHECK (min_stock_qty IS NULL OR max_stock_qty IS NULL OR max_stock_qty >= min_stock_qty),
  ADD CONSTRAINT "ck_rev_tools_total_qty_nonneg"  CHECK (is_consumable OR total_qty >= 0);

ALTER TABLE "rev_cutting_tool_catalog"
  ADD CONSTRAINT "ck_rev_cutting_max_stock_nonneg" CHECK (max_stock_qty IS NULL OR max_stock_qty >= 0),
  ADD CONSTRAINT "ck_rev_cutting_min_le_max"       CHECK (min_stock_qty IS NULL OR max_stock_qty IS NULL OR max_stock_qty >= min_stock_qty);

ALTER TABLE "rev_cutting_tool_stock"
  ADD CONSTRAINT "ck_rev_cutting_tool_stock_on_hand_nonneg" CHECK (on_hand_qty >= 0);

ALTER TABLE "rev_tool_stock_ledger"
  ADD CONSTRAINT "ck_rev_tool_stock_ledger_delta_nonzero" CHECK (delta <> 0);

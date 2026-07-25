-- ============================================================================
-- PERF: FK/hot-path indeksi + čišćenje redundantnih (DB audit DB-037 / DB-046)
-- ============================================================================
-- Prisma na PostgreSQL NE indeksira FK kolone automatski — na produ je izmereno
-- (25.07.2026) 58 FK constrainta bez pokrivajućeg indeksa; ovaj paket pokriva
-- vrući put proizvodnje (liste RN-ova, kiosk, BOM pretraga, lista tehnologa).
--
-- ⚠️ OPERATIVNA NAPOMENA (BACKEND_RULES presedan 20260716120000): na PRODU su svi
-- novi indeksi kreirani RUČNO kroz CREATE INDEX CONCURRENTLY pre merge-a ovog
-- fajla (žive tabele: work_orders 40k, tech_processes 99k, work_order_operations
-- 216k redova). Ovde je zato CREATE INDEX IF NOT EXISTS (plain): na produ je
-- no-op, na svežoj/dev bazi (male/prazne tabele) plain build je trenutan.
--
-- DROP sekcija: 10 redundantnih indeksa čiji je ključ prefiks postojećeg
-- unique/šireg indeksa (uklj. idx_stock_documents_po — dupli sa parcijalnim
-- uq_stock_documents_po iz 20260723140000_review_fixes_guards).
-- ============================================================================

-- ── 1) Novi indeksi — proizvodni core ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_part_locations_wo_record_date" ON "part_locations" ("work_order_id", "record_date");
CREATE INDEX IF NOT EXISTS "idx_part_locations_project" ON "part_locations" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_part_locations_position" ON "part_locations" ("position_id");
CREATE INDEX IF NOT EXISTS "idx_part_locations_worker" ON "part_locations" ("worker_id");

CREATE INDEX IF NOT EXISTS "idx_work_time_entries_worker" ON "work_time_entries" ("worker_id");
-- Parcijalni (SQL-only — Prisma ne ume WHERE): kiosk „moje otvorene sesije" +
-- session-auto-close skeniraju samo stopped_at IS NULL podskup.
CREATE INDEX IF NOT EXISTS "idx_work_time_entries_open" ON "work_time_entries" ("worker_id") WHERE "stopped_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_tp_worker" ON "tech_processes" ("worker_id");

CREATE INDEX IF NOT EXISTS "idx_work_orders_parent" ON "work_orders" ("parent_work_order_id");
CREATE INDEX IF NOT EXISTS "idx_work_orders_drawing_handover" ON "work_orders" ("drawing_handover_id");

CREATE INDEX IF NOT EXISTS "idx_womp_work_order" ON "work_order_machined_parts" ("work_order_id");
CREATE INDEX IF NOT EXISTS "idx_wob_work_order" ON "work_order_blanks" ("work_order_id");
CREATE INDEX IF NOT EXISTS "idx_wonp_work_order" ON "work_order_nonstandard_parts" ("work_order_id");
CREATE INDEX IF NOT EXISTS "idx_wol_work_order" ON "work_order_launches" ("work_order_id");
CREATE INDEX IF NOT EXISTS "idx_woa_work_order" ON "work_order_approvals" ("work_order_id");
CREATE INDEX IF NOT EXISTS "idx_woic_work_order" ON "work_order_item_components" ("work_order_id");
CREATE INDEX IF NOT EXISTS "idx_woc_component_work_order" ON "work_order_components" ("component_work_order_id");

CREATE INDEX IF NOT EXISTS "idx_machine_access_worker" ON "machine_access" ("worker_id");

-- ── 2) Novi indeksi — PDM / primopredaje ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_drawing_components_parent" ON "drawing_components" ("parent_drawing_id");
CREATE INDEX IF NOT EXISTS "idx_drawing_components_child" ON "drawing_components" ("child_drawing_id");
CREATE INDEX IF NOT EXISTS "idx_drawing_assemblies_parent" ON "drawing_assemblies" ("parent_drawing_id");
CREATE INDEX IF NOT EXISTS "idx_drawing_assemblies_child" ON "drawing_assemblies" ("child_drawing_id");

CREATE INDEX IF NOT EXISTS "idx_drawing_handovers_status_date" ON "drawing_handovers" ("status_id", "handover_date");
CREATE INDEX IF NOT EXISTS "idx_drawing_handovers_drawing" ON "drawing_handovers" ("drawing_id");
CREATE INDEX IF NOT EXISTS "idx_handover_drafts_project" ON "handover_drafts" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_handover_draft_items_draft" ON "handover_draft_items" ("draft_id");
CREATE INDEX IF NOT EXISTS "idx_handover_draft_items_drawing" ON "handover_draft_items" ("drawing_id");

-- ── 3) Novi indeksi — GL ─────────────────────────────────────────────────────
-- Otvorene stavke po komitentu BEZ konta (kamata): open_items (account, analytical,
-- reconciled) prefiks ne pokriva upit koji počinje od analytical_code.
CREATE INDEX IF NOT EXISTS "idx_ledger_entries_partner_open" ON "ledger_entries" ("analytical_code", "reconciled_at");

-- ── 4) DROP redundantnih (ključ = prefiks postojećeg unique/šireg indeksa) ───
DROP INDEX IF EXISTS "idx_woo_work_order";                    -- prefiks uq_woo_work_order_operation_number + idx_woo_routing
DROP INDEX IF EXISTS "idx_user_roles_user";                   -- prefiks uq_user_roles
DROP INDEX IF EXISTS "idx_pracenje_notes_project";            -- prefiks uq_pracenje_notes_project_work_order
DROP INDEX IF EXISTS "idx_predmet_planeri_project";           -- prefiks uq_predmet_planeri_project_user
DROP INDEX IF EXISTS "idx_ledger_entries_account_analytical"; -- prefiks idx_ledger_entries_open_items
DROP INDEX IF EXISTS "idx_popdv_account_map_account";         -- prefiks uq_popdv_account_map_acc_mark_col
DROP INDEX IF EXISTS "idx_vat_return_lines_return";           -- prefiks uq_vat_return_lines_return_aop
DROP INDEX IF EXISTS "idx_financial_statement_lines_statement"; -- prefiks uq_financial_statement_lines_statement_aop
DROP INDEX IF EXISTS "idx_balance_formula_definitions_type";  -- prefiks uq_balance_formula_definitions_type_aop
DROP INDEX IF EXISTS "idx_stock_documents_po";                -- duplikat parcijalnog uq_stock_documents_po (equality upiti impliciraju NOT NULL)

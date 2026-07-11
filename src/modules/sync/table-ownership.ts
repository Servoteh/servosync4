/**
 * ServoSync-owned production/technology tables (ODLUKE.md 2026-07-08 + BACKEND_RULES §3).
 *
 * Decision: the QBigTehn MSSQL sync is a TEMPORARY trial + one-time final import,
 * then it is retired. From first real use the technologist writes to these tables
 * directly, so a re-run of the sync must NOT wipe hand-entered data.
 *
 * The generic syncer therefore refuses to full-refresh (deleteMany + reinsert) any
 * of these once they already contain rows, unless the run is explicitly forced.
 * Everything else (BigBit master data, PDM drawings, legacy reference/config) is
 * read-only cache and safe to refresh.
 */
export const OWNED_PRODUCTION_TABLES = new Set<string>([
  // radni nalozi
  "work_orders",
  "work_order_operations",
  "work_order_components",
  "work_order_item_components",
  "work_order_launches",
  "work_order_operation_images",
  // stavke RN bez generisanog mapiranja (P4 §5.3 privremeni synceri) — 2.0 ih
  // već piše nativno (approve -> work_order_approvals, clone-variant -> parts),
  // pa full refresh bez force NE SME da ih obriše.
  "work_order_machined_parts",
  "work_order_blanks",
  "work_order_nonstandard_parts",
  "work_order_approvals",
  // tehnološki postupci
  "tech_processes",
  "tech_process_documents",
  // operacije / delovi / šifarnici proizvodnje
  "operations",
  "part_locations",
  "part_quality_types",
  "positions",
  "work_units",
  "workers",
  "worker_types",
  "machine_access",
  "production_item_groups",
  // primopredaje
  "handover_drafts",
  "handover_draft_items",
  "drawing_handovers",
  "drawing_handover_pdfs",
  // planiranje (PDM)
  "drawing_plan_items",
  // planer
  "planner_entries",
  "planner_user_groups",
]);

export function isOwnedProductionTable(entity: string): boolean {
  return OWNED_PRODUCTION_TABLES.has(entity);
}

/**
 * QBigTehn chain — the TEMPORARY part of the sync (P4 spec §7.2, ODLUKE
 * "QBigTehn sync privremen / BigBit trajan").
 *
 * Everything in this set is synced from QBigTehn only until the cutover
 * (docs/migration/17-cutover-runbook.md). On cutover day (runbook step 6) the
 * whole chain is REMOVED FROM REGISTRATION — its entries are dropped from
 * `sync-map.generated.ts` (regenerate) and the temporary §5.3 syncers plus the
 * handover derivation syncer are deleted from `SyncService`/`SyncModule`.
 * Deliberately NOT a runtime "skip" flag: dead code gets deleted, it does not
 * linger behind a switch.
 *
 * Everything mapped in `sync-map.generated.ts` that is NOT in this set is the
 * PERMANENT BigBit master-data sync (customers, projects, items, warehouses,
 * MRP_*, price list, goods documents, registry/CFG…) — vasa-SQL keeps feeding
 * those after the cutover.
 *
 * Derivation of the list (spec §7.2): cross-checked against
 * `sync-map.generated.ts` (29 mapped targets) + the six §5.3 chain-item tables
 * that have no generated mapping (tPDM, tPLP, tPND, tSaglasanRN,
 * PDM_PlaniranjeStavke, PrimopredajaPDFCrteza). The one-time seeded production
 * lookups (workers, worker_types, operations, …) are part of the chain: after
 * cutover they are ServoSync-owned and no longer refreshed from QBigTehn.
 */
export const QBIGTEHN_CHAIN_ENTITIES = new Set<string>([
  // PDM crteži / BOM / intake log / PDF-ovi / planiranje
  "drawings",
  "drawing_components",
  "drawing_assemblies",
  "drawing_import_log",
  "drawing_pdfs",
  "drawing_plans",
  "drawing_plan_items", // §5.3 (PDM_PlaniranjeStavke)
  // nacrti i primopredaje
  "handover_drafts",
  "handover_draft_items",
  "drawing_handovers", // derivacija iz tRN (handover-derivation.syncer.ts)
  "drawing_handover_pdfs", // §5.3 (PrimopredajaPDFCrteza)
  // radni nalozi + stavke
  "work_orders",
  "work_order_operations",
  "work_order_operation_images",
  "work_order_launches",
  "work_order_approvals", // §5.3 (tSaglasanRN)
  "work_order_machined_parts", // §5.3 (tPDM)
  "work_order_blanks", // §5.3 (tPLP)
  "work_order_nonstandard_parts", // §5.3 (tPND)
  "work_order_components",
  "work_order_item_components",
  // tehnološki postupci
  "tech_processes",
  "tech_process_documents",
  // nalepnice / lokacije delova
  "labels",
  "part_locations",
  // jednokratno seed-ovani šifarnici proizvodnje
  "workers",
  "worker_types",
  "operations",
  "work_units",
  "positions",
  "part_quality_types",
  "machine_access",
  "production_item_groups",
  // planer
  "planner_entries",
  "planner_user_groups",
]);

export function isQbigtehnChainEntity(entity: string): boolean {
  return QBIGTEHN_CHAIN_ENTITIES.has(entity);
}

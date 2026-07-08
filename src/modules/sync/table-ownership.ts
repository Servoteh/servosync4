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
  'work_orders',
  'work_order_operations',
  'work_order_components',
  'work_order_item_components',
  'work_order_launches',
  'work_order_operation_images',
  // tehnološki postupci
  'tech_processes',
  'tech_process_documents',
  // operacije / delovi / šifarnici proizvodnje
  'operations',
  'part_locations',
  'part_quality_types',
  'positions',
  'work_units',
  'workers',
  'worker_types',
  'machine_access',
  'production_item_groups',
  // primopredaje
  'handover_drafts',
  'handover_draft_items',
  'drawing_handovers',
  // planer
  'planner_entries',
  'planner_user_groups',
]);

export function isOwnedProductionTable(entity: string): boolean {
  return OWNED_PRODUCTION_TABLES.has(entity);
}

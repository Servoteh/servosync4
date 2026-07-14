import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SCHEMA-PIN test (bez žive baze) — hvata klasu grešaka „pogrešno ime view-a/kolone u
 * $queryRaw" koja je promakla e2e-ju (servis je mokovan, raw SQL nikad ne pogodi bazu).
 * Skenira izvor `odrzavanje.service.ts` i pinuje:
 *   (a) svako `FROM <maint tabela/view>` je REALAN objekat sa žive sy15 (allowlist ispod);
 *   (b) konkretne kolone koje su bile pogrešne (adversarni review 2026-07-13).
 * Allowlist = verifikovano Management API-jem (34 tabele + 16 view-ova + front RPC).
 */
describe("Održavanje — schema pin ($queryRaw imena protiv žive šeme)", () => {
  const raw = readFileSync(join(__dirname, "odrzavanje.service.ts"), "utf8");
  // Skini komentare — pinovi važe za STVARNI kod (komentari smeju pomenuti pogrešna imena).
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // Živi objekti (public) — sve što `FROM` sme da referiše u ovom servisu.
  const LIVE = new Set<string>([
    // 34 base tabele
    "maint_asset_service_plan",
    "maint_assets",
    "maint_checks",
    "maint_documents",
    "maint_drivers",
    "maint_facility_details",
    "maint_incident_events",
    "maint_incidents",
    "maint_it_asset_details",
    "maint_locations",
    "maint_machine_files",
    "maint_machine_notes",
    "maint_machine_status_override",
    "maint_machines",
    "maint_machines_deletion_log",
    "maint_notification_log",
    "maint_notification_rules",
    "maint_part_stock_movements",
    "maint_part_vehicles",
    "maint_parts",
    "maint_settings",
    "maint_suppliers",
    "maint_tasks",
    "maint_user_profiles",
    "maint_vehicle_bookings",
    "maint_vehicle_details",
    "maint_vehicle_owners",
    "maint_vehicle_service_plan",
    "maint_vehicle_tires",
    "maint_wo_events",
    "maint_wo_labor",
    "maint_wo_number_counter",
    "maint_wo_parts",
    "maint_work_orders",
    // 16 view-ova (svi security_invoker)
    "v_maint_asset_service_plan_due",
    "v_maint_cmms_daily_summary",
    "v_maint_documents_with_status",
    "v_maint_drivers_overview",
    "v_maint_facility_overview",
    "v_maint_it_overview",
    "v_maint_machine_current_status",
    "v_maint_machine_last_check",
    "v_maint_machines_importable",
    "v_maint_machines_with_responsible",
    "v_maint_parts_with_vehicles",
    "v_maint_task_due_dates",
    "v_maint_vehicle_bookings",
    "v_maint_vehicle_overview",
    "v_maint_vehicle_parts",
    "v_maint_vehicle_service_plan_due",
    // tabelno-vraćajuće fn (FROM public.<fn>())
    "maint_assignable_users",
    "maint_check_vehicle_deadlines",
  ]);

  // Žive fn koje servis zove (SELECT/FROM public.<fn>()) — 16(+1) front RPC (incl.
  // dinamički create/archive/restore preko `Prisma.raw(fn)`) + helper fn za `/me`.
  // Verifikovano protiv authz-snapshots/talasF-fn-defs-2026-07-12.sql (potpisi + RETURNS).
  const LIVE_FNS = new Set<string>([
    // 16(+1) front RPC
    "maint_assignable_users",
    "maint_create_preventive_work_order",
    "maint_machine_rename",
    "maint_machine_delete_hard",
    "maint_machines_import_from_cache",
    "maint_notification_retry",
    "maint_check_vehicle_deadlines",
    "create_maint_vehicle",
    "archive_maint_vehicle",
    "restore_maint_vehicle",
    "create_maint_it_asset",
    "create_maint_facility",
    "archive_maint_asset",
    "restore_maint_asset",
    "ensure_vehicle_service_wos",
    "ensure_asset_service_wos",
    "maint_attach_incident_files",
    // helper fn (dvoslojni authz — /me + interno)
    "maint_has_floor_read_access",
    "maint_is_erp_admin",
    "maint_is_erp_admin_or_management",
    "maint_profile_role",
    "maint_assigned_machine_codes",
  ]);

  // Živi enum tipovi (::cast u $executeRaw INSERT-ima) — prisma/sy15.prisma @@map.
  const LIVE_ENUMS = new Set<string>([
    "maint_asset_type",
    "maint_incident_severity",
    "maint_incident_status",
  ]);

  it("svaki FROM <maint/v_maint/RPC> referiše REALAN objekat sa žive sy15", () => {
    const refs = [
      ...src.matchAll(/FROM\s+(?:public\.)?((?:v_)?maint_[a-z0-9_]+)/gi),
    ].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(10); // sanity: skener nešto našao
    const unknown = [...new Set(refs)].filter((r) => !LIVE.has(r));
    expect(unknown).toEqual([]);
  });

  it("NE koristi nepostojeću kolonu `effective_status` (view izlaže `status`)", () => {
    expect(src).not.toMatch(/effective_status/);
  });

  it("v_maint_machine_current_status se čita preko `status` kolone", () => {
    expect(src).toMatch(/SELECT machine_code, status/);
    expect(src).toMatch(/SELECT status FROM v_maint_machine_current_status/);
  });

  it("v_maint_parts_with_vehicles se filtrira po `vehicle_codes` (NE nepostojeći asset_id)", () => {
    expect(src).toMatch(/= ANY\(vehicle_codes\)/);
    expect(src).not.toMatch(/v_maint_parts_with_vehicles WHERE asset_id/);
    expect(src).not.toMatch(/v_maint_parts_with_vehicles\s+WHERE asset_id/);
  });

  it("dashboard konvertuje int8 (bigint) redove kroz numRows (JSON-safe)", () => {
    expect(src).toMatch(/numRows\(\(dailySummary/);
  });

  // ── R2 mutacije: RPC potpisi / enum castovi / INSERT tabele (schema-pin) ──

  it("svaki public.<fn>() poziv referiše REALNU živu fn (16(+1) RPC + helperi)", () => {
    const refs = [...src.matchAll(/public\.([a-z_][a-z0-9_]*)\s*\(/gi)].map(
      (m) => m[1],
    );
    expect(refs.length).toBeGreaterThan(10); // sanity
    const unknown = [...new Set(refs)].filter((r) => !LIVE_FNS.has(r));
    expect(unknown).toEqual([]);
  });

  it("dinamički create/archive/restore RPC (string literali za Prisma.raw) su žive fn", () => {
    const lits = [
      ...src.matchAll(/"((?:create|archive|restore)_maint_[a-z_]+)"/g),
    ].map((m) => m[1]);
    expect(lits.length).toBeGreaterThan(0);
    const unknown = [...new Set(lits)].filter((r) => !LIVE_FNS.has(r));
    expect(unknown).toEqual([]);
  });

  it("svaki ::maint_* enum cast referiše REALAN enum tip", () => {
    const casts = [...src.matchAll(/::(maint_[a-z_]+)/g)].map((m) => m[1]);
    expect(casts.length).toBeGreaterThan(0);
    const unknown = [...new Set(casts)].filter((r) => !LIVE_ENUMS.has(r));
    expect(unknown).toEqual([]);
  });

  it("svaki INSERT INTO <tabela> referiše REALNU maint tabelu (raw $executeRaw)", () => {
    const tables = [
      ...src.matchAll(/INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/gi),
    ].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    const unknown = [...new Set(tables)].filter((t) => !LIVE.has(t));
    expect(unknown).toEqual([]);
  });

  it("reportIncident piše asset_id/asset_type/reported_by=auth.uid() bez RETURNING (F6)", () => {
    // F6: prijavilac možda ne vidi svoj red → INSERT bez RETURNING, id iz app-a.
    // reported_by = auth.uid() (WITH CHECK to traži) upisan u istom INSERT bloku.
    expect(src).toMatch(/INSERT INTO maint_incidents[\s\S]*?reported_by/);
    expect(src).toMatch(/INSERT INTO maint_incidents[\s\S]*?auth\.uid\(\)/);
  });
});

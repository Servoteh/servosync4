/**
 * One-off data migration: sy15 (1.0) Plan proizvodnje app data -> 2.0 app-owned tables
 * (F5b-1a of docs/PLAN_F5_GASENJE_MOSTA.md §4.2, decisions M1/M3/M8 §8).
 *
 * WHAT IT MOVES (source public.* -> 2.0 target):
 *   1. production_overlays                (~741) -> plan_proizvodnje_overlays
 *   2. production_urgency_overrides          (9) -> plan_proizvodnje_urgency_overrides
 *   3. production_auto_cooperation_groups    (3) -> plan_proizvodnje_auto_cooperation_groups
 *   4. production_drawings           (0 + meta) -> plan_proizvodnje_drawings   (see PDF NOTE)
 *   5. production_reassign_audit             (0) -> plan_proizvodnje_reassign_audit
 *   6. production_overlays_history         (112) -> 2.0 audit_log (M8, one-time)
 *
 * KEY MAPPINGS (plan §4.2 (b)/(c)/(e); proven by the feed loc-tp-feed.service.ts `wo.id AS id`,
 * `op.id AS id`): the sy15 id spaces are IDENTICAL to 2.0 — so this is a COPY without remap.
 *   - work_order_id (sy15 bigint, == bigtehn_work_orders_cache.id) == 2.0 work_orders.id.
 *   - line_id       (sy15 bigint, == bigtehn_work_order_lines_cache.id) == 2.0
 *                    work_order_operations.id (the "line"). Rows whose work order / operation
 *                    does not exist in 2.0 are SKIPPED + reported (task: "skip+report nepostojece").
 *   - The sy15 bigint values are down-cast to 2.0 int4 (toInt4); out-of-int4-range -> skip+report.
 *   - Legacy audit columns (created_by/updated_by/set_by/added_by/actor_email/changed_by) are sy15
 *     FREE TEXT (email/uid) and are carried VERBATIM — NOT remapped to users.id (unlike the pracenje
 *     import). This keeps the copy 1:1 and avoids a resolver.
 *   - Provenance: plan_proizvodnje_overlays.legacy_sy15_id = production_overlays.id (bigint);
 *     plan_proizvodnje_drawings.legacy_sy15_id = production_drawings.id (bigint). These are the
 *     exact idempotency anchors and (for overlays) the correlation key for the history import.
 *
 * PDF NOTE (M1, drawings): the sy15 `production_drawings` PDF bytes live in a storage BUCKET
 * (`production-drawings`), NOT in the table (the table holds `storage_path`). The 2.0 table holds
 * the PDF inline (`pdf_binary` bytea). This script imports the METADATA only (pdf_binary = NULL) and
 * REPORTS every row whose binary must be back-filled from the bucket. sy15 has 0 drawing rows today,
 * so this is a no-op in practice; the back-fill path is intentionally out of scope for F5b-1a.
 *
 * SAFETY / MODES:
 *   - Default is --dry-run: reads + resolves everything, prints per-table counts (insert/update split
 *     via the natural / provenance idempotency key) + unresolved references, and lists any
 *     local_status / cooperation_status value outside the 2.0 `///` catalog. Writes NOTHING.
 *   - --apply performs idempotent writes (upsert by natural key / legacy_sy15_id), so it may re-run.
 *   - Enum-ish labels (local_status, cooperation_status) are catalog-checked and REPORTED when out of
 *     catalog; they are copied verbatim (unguarded String columns) — never silently rewritten.
 *
 * CONNECTIONS (from existing env, see backend/.env.example):
 *   - 2.0 target: DATABASE_URL          (default datasource of @prisma/client)
 *   - sy15 source: SY15_DATABASE_URL    (default datasource of @prisma-sy15/client)
 *
 * RUN (ts-node; connects ONLY to whatever those two URLs point at):
 *   npx ts-node --transpile-only backend/scripts/migrate-plan-proizvodnje-sy15.ts            # dry-run
 *   npx ts-node --transpile-only backend/scripts/migrate-plan-proizvodnje-sy15.ts --apply    # write
 *
 * NOTE (dual Prisma runtimes): a Prisma.Sql built by one client cannot be executed by the other
 * (`instanceof Sql` fails cross-package). Every raw statement is built with the sy15 `Sy15Prisma.sql`
 * and run on the sy15 client; the 2.0 side uses only the typed client API — the two never mix.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma as Prisma20, PrismaClient } from "@prisma/client";
import {
  Prisma as Sy15Prisma,
  PrismaClient as Sy15PrismaClient,
} from "@prisma-sy15/client";

// ---------------------------------------------------------------------------
// Env bootstrap (no dotenv dependency): load backend/.env for keys not already set.
// ---------------------------------------------------------------------------
function loadEnv(): void {
  const envPath = resolve(__dirname, "..", ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Report accumulator — printed at the end (human operator, not machine-parsed).
// ---------------------------------------------------------------------------
interface StepReport {
  read: number;
  written: number; // "would write" in dry-run
  skipped: number;
  inserted?: number;
  updated?: number;
  unresolved: Record<string, string[]>; // category -> sample keys
}

const APPLY = process.argv.includes("--apply");
const report: Record<string, StepReport> = {};

function step(name: string): StepReport {
  const s: StepReport = { read: 0, written: 0, skipped: 0, unresolved: {} };
  report[name] = s;
  return s;
}

function note(s: StepReport, category: string, key: string): void {
  (s.unresolved[category] ??= []).push(key);
}

/** bigint (int4-range) -> number, guarded. Returns null when out of int4 range. */
function toInt4(v: bigint | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "bigint" ? Number(v) : v;
  if (!Number.isFinite(n) || n < -2147483648 || n > 2147483647) return null;
  return Math.trunc(n);
}

function trimOrNull(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
}

// ---------------------------------------------------------------------------
// Status catalogs (BACKEND_RULES §2: statuses are unguarded String columns whose allowed values
// live in the `///` schema comment). We only REPORT out-of-catalog values (never remap/drop) so a
// sy15 drift is visible before --apply. NULL is always allowed (auto).
// ---------------------------------------------------------------------------
const CATALOG = {
  local_status: new Set(["waiting", "in_progress", "blocked"]),
  cooperation_status: new Set([
    "none",
    "external",
    "external_in_progress",
    "external_done",
  ]),
} as const;
type CatalogField = keyof typeof CATALOG;
const CATALOG_FIELDS = Object.keys(CATALOG) as CatalogField[];
const outOfCatalog: Record<CatalogField, Map<string, number>> = {
  local_status: new Map(),
  cooperation_status: new Map(),
};

/** Catalog-check a label in the read phase (visible in dry-run). Returns the value unchanged. */
function checkLabel(
  field: CatalogField,
  raw: string | null | undefined,
): string | null {
  const v = trimOrNull(raw);
  if (v == null) return null;
  if (!CATALOG[field].has(v)) {
    outOfCatalog[field].set(v, (outOfCatalog[field].get(v) ?? 0) + 1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Raw row shapes (sy15 public.*). production_auto_cooperation_groups / _reassign_audit /
// _overlays_history are NOT modeled in prisma/sy15.prisma -> read raw. The three modeled ones
// (overlays/urgency/drawings) are also read raw here for a uniform bigint-safe path.
// ---------------------------------------------------------------------------
interface OverlayRow {
  id: bigint;
  work_order_id: bigint;
  line_id: bigint;
  shift_sort_order: number | null;
  local_status: string | null;
  shift_note: string | null;
  assigned_machine_code: string | null;
  cam_ready: boolean | null;
  cam_ready_at: Date | null;
  cam_ready_by: string | null;
  ready_override: boolean | null;
  ready_override_at: Date | null;
  ready_override_by: string | null;
  cooperation_status: string | null;
  cooperation_partner: string | null;
  cooperation_set_by: string | null;
  cooperation_set_at: Date | null;
  cooperation_expected_return: Date | null;
  archived_at: Date | null;
  archived_reason: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}
interface UrgencyRow {
  work_order_id: bigint;
  is_urgent: boolean | null;
  reason: string | null;
  set_by: string | null;
  set_at: Date | null;
  cleared_at: Date | null;
  cleared_by: string | null;
}
interface KoopRow {
  rj_group_code: string;
  group_label: string | null;
  notes: string | null;
  added_by: string | null;
  added_at: Date | null;
  removed_at: Date | null;
  removed_by: string | null;
}
interface DrawingRow {
  id: bigint;
  work_order_id: bigint;
  line_id: bigint | null;
  file_name: string;
  mime_type: string | null;
  size_bytes: bigint | null;
  storage_path: string | null;
  uploaded_by: string | null;
  uploaded_at: Date | null;
  deleted_at: Date | null;
  deleted_by: string | null;
}
interface ReassignRow {
  id: bigint;
  work_order_id: bigint;
  line_id: bigint;
  actor_email: string | null;
  source_machine: string | null;
  target_machine: string | null;
  source_group: string | null;
  target_group: string | null;
  force_reason: string | null;
  client_event_uuid: string | null; // ::text
  created_at: Date | null;
}
interface HistoryRow {
  id: string; // ::text
  overlay_id: bigint;
  work_order_id: bigint;
  line_id: bigint;
  field_name: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_at: Date | null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  loadEnv();

  if (!process.env.SY15_DATABASE_URL) {
    throw new Error(
      "SY15_DATABASE_URL is not set — cannot read the sy15 source. Aborting.",
    );
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — cannot reach the 2.0 target. Aborting.");
  }

  const prisma = new PrismaClient();
  const sy15 = new Sy15PrismaClient();

  console.log(
    `\n=== migrate-plan-proizvodnje-sy15 :: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"} ===\n`,
  );

  try {
    // -----------------------------------------------------------------------
    // Existence resolvers (2.0 target). A "line" == work_order_operations.id.
    // -----------------------------------------------------------------------
    const woExists = async (ids: number[]): Promise<Set<number>> => {
      const uniq = [...new Set(ids)].filter((n) => Number.isFinite(n));
      const out = new Set<number>();
      if (uniq.length === 0) return out;
      for (const r of await prisma.workOrder.findMany({
        where: { id: { in: uniq } },
        select: { id: true },
      })) {
        out.add(r.id);
      }
      return out;
    };
    const opExists = async (ids: number[]): Promise<Set<number>> => {
      const uniq = [...new Set(ids)].filter((n) => Number.isFinite(n));
      const out = new Set<number>();
      if (uniq.length === 0) return out;
      for (const r of await prisma.workOrderOperation.findMany({
        where: { id: { in: uniq } },
        select: { id: true },
      })) {
        out.add(r.id);
      }
      return out;
    };

    // =======================================================================
    // STEP 1: production_overlays -> plan_proizvodnje_overlays (upsert by wo+line)
    // =======================================================================
    const s1 = step("1_overlays");
    const overlayRows = await sy15.$queryRaw<OverlayRow[]>(
      Sy15Prisma.sql`
        SELECT id, work_order_id, line_id, shift_sort_order, local_status, shift_note,
               assigned_machine_code, cam_ready, cam_ready_at, cam_ready_by,
               ready_override, ready_override_at, ready_override_by,
               cooperation_status, cooperation_partner, cooperation_set_by, cooperation_set_at,
               cooperation_expected_return, archived_at, archived_reason,
               created_by, updated_by, created_at, updated_at
          FROM production_overlays`,
    );
    s1.read = overlayRows.length;
    {
      const woSet = await woExists(overlayRows.map((r) => toInt4(r.work_order_id) ?? -1));
      const opSet = await opExists(overlayRows.map((r) => toInt4(r.line_id) ?? -1));
      const existingByWoLine = new Set<string>();
      for (const row of await prisma.planProizvodnjeOverlay.findMany({
        select: { workOrderId: true, lineId: true },
      })) {
        existingByWoLine.add(`${row.workOrderId}:${row.lineId}`);
      }
      const seen = new Set<string>();
      for (const r of overlayRows) {
        const woId = toInt4(r.work_order_id);
        const lineId = toInt4(r.line_id);
        if (woId == null || lineId == null) {
          s1.skipped++;
          note(s1, "id_out_of_int4_range", `${r.work_order_id}/${r.line_id}`);
          continue;
        }
        if (!woSet.has(woId)) {
          s1.skipped++;
          note(s1, "work_order_missing", String(woId));
          continue;
        }
        if (!opSet.has(lineId)) {
          s1.skipped++;
          note(s1, "operation_line_missing", String(lineId));
          continue;
        }
        const key = `${woId}:${lineId}`;
        if (seen.has(key)) {
          s1.skipped++;
          note(s1, "duplicate_wo_line_in_source", key);
          continue;
        }
        seen.add(key);
        // Catalog-check in the read phase (visible in dry-run).
        const localStatus = checkLabel("local_status", r.local_status);
        const coopStatus = checkLabel("cooperation_status", r.cooperation_status);
        s1.written++;
        if (existingByWoLine.has(key)) s1.updated = (s1.updated ?? 0) + 1;
        else s1.inserted = (s1.inserted ?? 0) + 1;
        if (APPLY) {
          const data = {
            legacySy15Id: r.id,
            shiftSortOrder: r.shift_sort_order,
            localStatus,
            shiftNote: r.shift_note,
            assignedMachineCode: r.assigned_machine_code,
            camReady: r.cam_ready ?? false,
            camReadyAt: r.cam_ready_at,
            camReadyBy: r.cam_ready_by,
            readyOverride: r.ready_override ?? false,
            readyOverrideAt: r.ready_override_at,
            readyOverrideBy: r.ready_override_by,
            cooperationStatus: coopStatus,
            cooperationPartner: r.cooperation_partner,
            cooperationSetBy: r.cooperation_set_by,
            cooperationSetAt: r.cooperation_set_at,
            cooperationExpectedReturn: r.cooperation_expected_return,
            archivedAt: r.archived_at,
            archivedReason: r.archived_reason,
            createdBy: r.created_by,
            updatedBy: r.updated_by,
            ...(r.created_at ? { createdAt: r.created_at } : {}),
            ...(r.updated_at ? { updatedAt: r.updated_at } : {}),
          };
          await prisma.planProizvodnjeOverlay.upsert({
            where: { workOrderId_lineId: { workOrderId: woId, lineId } },
            create: { workOrderId: woId, lineId, ...data },
            update: data,
          });
        }
      }
    }

    // =======================================================================
    // STEP 2: production_urgency_overrides -> plan_proizvodnje_urgency_overrides
    // =======================================================================
    const s2 = step("2_urgency");
    const urgencyRows = await sy15.$queryRaw<UrgencyRow[]>(
      Sy15Prisma.sql`
        SELECT work_order_id, is_urgent, reason, set_by, set_at, cleared_at, cleared_by
          FROM production_urgency_overrides`,
    );
    s2.read = urgencyRows.length;
    {
      const woSet = await woExists(urgencyRows.map((r) => toInt4(r.work_order_id) ?? -1));
      const existing = new Set<number>();
      for (const row of await prisma.planProizvodnjeUrgency.findMany({
        select: { workOrderId: true },
      })) {
        existing.add(row.workOrderId);
      }
      const seen = new Set<number>();
      for (const r of urgencyRows) {
        const woId = toInt4(r.work_order_id);
        if (woId == null) {
          s2.skipped++;
          note(s2, "id_out_of_int4_range", String(r.work_order_id));
          continue;
        }
        if (!woSet.has(woId)) {
          s2.skipped++;
          note(s2, "work_order_missing", String(woId));
          continue;
        }
        if (seen.has(woId)) {
          s2.skipped++;
          note(s2, "duplicate_work_order_in_source", String(woId));
          continue;
        }
        seen.add(woId);
        s2.written++;
        if (existing.has(woId)) s2.updated = (s2.updated ?? 0) + 1;
        else s2.inserted = (s2.inserted ?? 0) + 1;
        if (APPLY) {
          const data = {
            isUrgent: r.is_urgent ?? true,
            reason: r.reason,
            setBy: r.set_by,
            clearedAt: r.cleared_at,
            clearedBy: r.cleared_by,
            ...(r.set_at ? { setAt: r.set_at } : {}),
          };
          await prisma.planProizvodnjeUrgency.upsert({
            where: { workOrderId: woId },
            create: { workOrderId: woId, ...data },
            update: data,
          });
        }
      }
    }

    // =======================================================================
    // STEP 3: production_auto_cooperation_groups -> plan_proizvodnje_auto_cooperation_groups
    // =======================================================================
    const s3 = step("3_auto_koop_groups");
    const koopRows = await sy15.$queryRaw<KoopRow[]>(
      Sy15Prisma.sql`
        SELECT rj_group_code, group_label, notes, added_by, added_at, removed_at, removed_by
          FROM production_auto_cooperation_groups`,
    );
    s3.read = koopRows.length;
    {
      const existing = new Set<string>();
      for (const row of await prisma.planProizvodnjeAutoKoopGroup.findMany({
        select: { rjGroupCode: true },
      })) {
        existing.add(row.rjGroupCode);
      }
      const seen = new Set<string>();
      for (const r of koopRows) {
        const code = trimOrNull(r.rj_group_code);
        if (code == null) {
          s3.skipped++;
          note(s3, "empty_rj_group_code", "(null)");
          continue;
        }
        if (seen.has(code)) {
          s3.skipped++;
          note(s3, "duplicate_code_in_source", code);
          continue;
        }
        seen.add(code);
        s3.written++;
        if (existing.has(code)) s3.updated = (s3.updated ?? 0) + 1;
        else s3.inserted = (s3.inserted ?? 0) + 1;
        if (APPLY) {
          const data = {
            groupLabel: r.group_label,
            notes: r.notes,
            addedBy: r.added_by,
            removedAt: r.removed_at,
            removedBy: r.removed_by,
            ...(r.added_at ? { addedAt: r.added_at } : {}),
          };
          await prisma.planProizvodnjeAutoKoopGroup.upsert({
            where: { rjGroupCode: code },
            create: { rjGroupCode: code, ...data },
            update: data,
          });
        }
      }
    }

    // =======================================================================
    // STEP 4: production_drawings -> plan_proizvodnje_drawings (metadata only; PDF NOTE above)
    // =======================================================================
    const s4 = step("4_drawings");
    const drawingRows = await sy15.$queryRaw<DrawingRow[]>(
      Sy15Prisma.sql`
        SELECT id, work_order_id, line_id, file_name, mime_type, size_bytes, storage_path,
               uploaded_by, uploaded_at, deleted_at, deleted_by
          FROM production_drawings`,
    );
    s4.read = drawingRows.length;
    {
      const woSet = await woExists(drawingRows.map((r) => toInt4(r.work_order_id) ?? -1));
      const opSet = await opExists(
        drawingRows.map((r) => (r.line_id == null ? -1 : (toInt4(r.line_id) ?? -1))),
      );
      const existing = new Set<string>();
      for (const row of await prisma.planProizvodnjeDrawing.findMany({
        where: { legacySy15Id: { not: null } },
        select: { legacySy15Id: true },
      })) {
        if (row.legacySy15Id != null) existing.add(String(row.legacySy15Id));
      }
      for (const r of drawingRows) {
        const woId = toInt4(r.work_order_id);
        if (woId == null || !woSet.has(woId)) {
          s4.skipped++;
          note(s4, "work_order_missing", String(r.work_order_id));
          continue;
        }
        let lineId: number | null = null;
        if (r.line_id != null) {
          lineId = toInt4(r.line_id);
          if (lineId == null || !opSet.has(lineId)) {
            note(s4, "operation_line_missing_kept_null", String(r.line_id));
            lineId = null; // keep the row; drop the dangling line ref.
          }
        }
        // PDF binary lives in a storage bucket, not the table — import meta only, report backfill.
        if (trimOrNull(r.storage_path)) note(s4, "pdf_binary_backfill_needed", String(r.id));
        const legacy = String(r.id);
        s4.written++;
        if (existing.has(legacy)) s4.updated = (s4.updated ?? 0) + 1;
        else s4.inserted = (s4.inserted ?? 0) + 1;
        if (APPLY) {
          const data = {
            workOrderId: woId,
            lineId,
            fileName: r.file_name,
            contentType: r.mime_type,
            // pdfBinary intentionally left null (M1 backfill out of scope for F5b-1a).
            sizeBytes: r.size_bytes,
            uploadedBy: r.uploaded_by,
            deletedAt: r.deleted_at,
            deletedBy: r.deleted_by,
            ...(r.uploaded_at ? { uploadedAt: r.uploaded_at } : {}),
          };
          await prisma.planProizvodnjeDrawing.upsert({
            where: { legacySy15Id: r.id },
            create: { legacySy15Id: r.id, ...data },
            update: data,
          });
        }
      }
    }

    // =======================================================================
    // STEP 5: production_reassign_audit -> plan_proizvodnje_reassign_audit
    // Idempotency: (client_event_uuid, line_id) when uuid present; else heuristic (0 rows today).
    // =======================================================================
    const s5 = step("5_reassign_audit");
    const reassignRows = await sy15.$queryRaw<ReassignRow[]>(
      Sy15Prisma.sql`
        SELECT id, work_order_id, line_id, actor_email, source_machine, target_machine,
               source_group, target_group, force_reason, client_event_uuid::text AS client_event_uuid,
               created_at
          FROM production_reassign_audit`,
    );
    s5.read = reassignRows.length;
    {
      const woSet = await woExists(reassignRows.map((r) => toInt4(r.work_order_id) ?? -1));
      const opSet = await opExists(reassignRows.map((r) => toInt4(r.line_id) ?? -1));
      const existingByUuidLine = new Set<string>();
      for (const row of await prisma.planProizvodnjeReassignAudit.findMany({
        where: { clientEventUuid: { not: null } },
        select: { clientEventUuid: true, lineId: true },
      })) {
        existingByUuidLine.add(`${row.clientEventUuid}:${row.lineId}`);
      }
      const seenReassign = new Set<string>();
      for (const r of reassignRows) {
        const woId = toInt4(r.work_order_id);
        const lineId = toInt4(r.line_id);
        if (woId == null || lineId == null) {
          s5.skipped++;
          note(s5, "id_out_of_int4_range", `${r.work_order_id}/${r.line_id}`);
          continue;
        }
        if (!woSet.has(woId)) {
          s5.skipped++;
          note(s5, "work_order_missing", String(woId));
          continue;
        }
        if (!opSet.has(lineId)) {
          s5.skipped++;
          note(s5, "operation_line_missing", String(lineId));
          continue;
        }
        const uuid = trimOrNull(r.client_event_uuid);
        // In-source dedup (parity with steps 1-3): two source rows sharing the same
        // (uuid, line) natural key collapse under the upsert on --apply, so dry-run
        // must not double-count the second as an insert.
        const natKey = `${uuid ?? "∅"}:${lineId}`;
        if (uuid != null && seenReassign.has(natKey)) {
          s5.skipped++;
          note(s5, "duplicate_uuid_line_in_source", natKey);
          continue;
        }
        if (uuid != null) seenReassign.add(natKey);
        s5.written++;
        if (uuid != null && existingByUuidLine.has(`${uuid}:${lineId}`)) {
          s5.updated = (s5.updated ?? 0) + 1;
        } else {
          s5.inserted = (s5.inserted ?? 0) + 1;
        }
        if (APPLY) {
          const data = {
            workOrderId: woId,
            lineId,
            actorEmail: r.actor_email,
            fromMachineCode: r.source_machine,
            toMachineCode: r.target_machine,
            sourceGroup: r.source_group,
            targetGroup: r.target_group,
            forced: true,
            forceReason: r.force_reason,
            clientEventUuid: uuid,
            ...(r.created_at ? { createdAt: r.created_at } : {}),
          };
          if (uuid != null) {
            await prisma.planProizvodnjeReassignAudit.upsert({
              where: { clientEventUuid_lineId: { clientEventUuid: uuid, lineId } },
              create: data,
              update: data,
            });
          } else {
            // No natural key (NULL uuid, like the older sy15 reassign path). Best-effort dedup on
            // (work_order_id, line_id, created_at) so a re-run does not duplicate.
            const found = r.created_at
              ? await prisma.planProizvodnjeReassignAudit.findFirst({
                  where: { workOrderId: woId, lineId, createdAt: r.created_at, clientEventUuid: null },
                  select: { id: true },
                })
              : null;
            if (found) {
              await prisma.planProizvodnjeReassignAudit.update({ where: { id: found.id }, data });
            } else {
              await prisma.planProizvodnjeReassignAudit.create({ data });
            }
          }
        }
      }
    }

    // =======================================================================
    // STEP 6: production_overlays_history (112) -> 2.0 audit_log (M8, one-time)
    // Idempotency: metadata.sy15_overlay_history_id (skip already-imported).
    // =======================================================================
    const s6 = step("6_overlays_history_audit");
    const historyRows = await sy15.$queryRaw<HistoryRow[]>(
      Sy15Prisma.sql`
        SELECT id::text AS id, overlay_id, work_order_id, line_id, field_name,
               old_value, new_value, changed_by, changed_at
          FROM production_overlays_history
         ORDER BY changed_at ASC`,
    );
    s6.read = historyRows.length;
    const alreadyImported = new Set<string>();
    if (APPLY) {
      const existing = await prisma.$queryRaw<{ sid: string }[]>(
        Prisma20.sql`SELECT metadata->>'sy15_overlay_history_id' AS sid FROM audit_log
                      WHERE metadata->>'source' = 'sy15-import'
                        AND metadata->>'sy15_overlay_history_id' IS NOT NULL`,
      );
      for (const e of existing) alreadyImported.add(e.sid);
    }
    const auditCreate: Prisma20.AuditLogCreateManyInput[] = [];
    for (const h of historyRows) {
      if (alreadyImported.has(h.id)) {
        s6.skipped++;
        continue;
      }
      s6.written++;
      if (APPLY) {
        const field = h.field_name ?? "_change";
        auditCreate.push({
          actorUserId: null, // sy15 changed_by is free text (email/uid), not a 2.0 users.id.
          actorUsername: h.changed_by?.slice(0, 255) ?? null,
          action: "sy15_overlay_history",
          entityType: "production_overlays",
          entityId: String(h.overlay_id).slice(0, 100), // sy15 overlay id == plan_proizvodnje_overlays.legacy_sy15_id
          beforeData: { [field]: h.old_value } as Prisma20.InputJsonValue,
          afterData: { [field]: h.new_value } as Prisma20.InputJsonValue,
          metadata: {
            source: "sy15-import",
            sy15_overlay_history_id: h.id,
            sy15_overlay_id: String(h.overlay_id),
            work_order_id: toInt4(h.work_order_id),
            line_id: toInt4(h.line_id),
            field_name: h.field_name,
            changed_by: h.changed_by,
            original_changed_at: h.changed_at ? h.changed_at.toISOString() : null,
          } as Prisma20.InputJsonValue,
          ...(h.changed_at ? { createdAt: h.changed_at } : {}),
        });
      }
    }
    if (APPLY && auditCreate.length > 0) {
      await prisma.auditLog.createMany({ data: auditCreate });
    }

    printReport();
  } finally {
    await prisma.$disconnect();
    await sy15.$disconnect();
  }
}

function printReport(): void {
  console.log("---------------------------------------------------------------");
  console.log(`RESULT (${APPLY ? "APPLIED" : "DRY-RUN"}):`);
  for (const [name, s] of Object.entries(report)) {
    const verb = APPLY ? "written" : "would-write";
    const io =
      s.inserted != null || s.updated != null
        ? ` (insert=${s.inserted ?? 0} update=${s.updated ?? 0})`
        : "";
    console.log(`\n  ${name}: read=${s.read} ${verb}=${s.written}${io} skipped=${s.skipped}`);
    for (const [cat, keys] of Object.entries(s.unresolved)) {
      const sample = keys.slice(0, 10).join(", ");
      const more = keys.length > 10 ? ` … (+${keys.length - 10})` : "";
      console.log(`      - ${cat}: ${keys.length}  [${sample}${more}]`);
    }
  }

  // Out-of-catalog gate: any sy15 label outside the 2.0 /// catalog is surfaced here — review
  // BEFORE --apply, because the target columns are unguarded Strings that accept anything.
  const flagged = CATALOG_FIELDS.filter((f) => outOfCatalog[f].size > 0);
  console.log("\nOUT-OF-CATALOG VALUES (sy15 labels not in the 2.0 /// catalog):");
  if (flagged.length === 0) {
    console.log("  none — every sy15 label maps into the 2.0 catalog.");
  } else {
    for (const f of flagged) {
      const parts = [...outOfCatalog[f].entries()].map(([v, n]) => `'${v}'×${n}`).join(", ");
      console.log(`  ${f}: ${parts}`);
    }
    console.log(
      "  ^ copied as-is (no silent drop) but NOT in the catalog — extend the /// list or clean the" +
        " source before trusting --apply.",
    );
  }

  console.log("\n---------------------------------------------------------------");
  if (!APPLY) {
    console.log("DRY-RUN only — nothing written. Re-run with --apply to persist.");
  }
}

main().catch((err: unknown) => {
  console.error("\nmigrate-plan-proizvodnje-sy15 FAILED:", err);
  process.exitCode = 1;
});

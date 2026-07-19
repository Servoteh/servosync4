/**
 * One-off data migration: sy15 (1.0) production/core pracenje data -> 2.0 app-owned
 * tables (F1 of docs/PLAN_PRACENJE_PROIZVODNJE_2026-07.md, decision O2 "living data +
 * one-time audit import").
 *
 * WHAT IT MOVES (source -> target):
 *   1. production.pracenje_manual_overrides      -> pracenje_overrides
 *   2. production.pracenje_parent_override       -> pracenje_structure_overrides
 *   3. production.pracenje_proizvodnje_napomene  -> pracenje_notes
 *   4. production.predmet_aktivacija (+ predmet_prioritet + predmet_plan_prioritet)
 *                                                -> predmet_aktivacije
 *   5. core.odeljenje                            -> odeljenja
 *   6. production.operativna_aktivnost (+ _blok_istorija)
 *                                                -> operativne_aktivnosti (+ _blokade)
 *   7. audit_log rows for the tables above       -> 2.0 audit_log (source='sy15-import')
 *
 * KEY MAPPINGS (from the plan + the sy15 SECURITY DEFINER fn bodies in
 * backend/docs/design/authz-snapshots/talasC-fn-defs-2026-07-12.sql):
 *   - RN key (plan fact + O4): production.pracenje_*.bigtehn_rn_id (bigint) == 2.0
 *     work_orders.id; production.radni_nalog.legacy_idrn (int4) == 2.0 work_orders.id.
 *     Rows whose work order does not exist in 2.0 are skipped/nulled + reported.
 *   - Predmet -> project (O1 + task heuristic): sy15 predmet_item_id ==
 *     public.bigtehn_items_cache.id; its `broj_predmeta` is matched against 2.0
 *     projects.project_number (trimmed, then case-insensitive). Ambiguous/none ->
 *     skipped + reported. (See resolveProjectByItemId for the exact cascade.)
 *   - odeljenje (O3): matched by code (sy15 core.odeljenje.kod -> 2.0 odeljenja.code).
 *   - users: sy15 auth.users.<uuid> -> email -> 2.0 users.id (created_by/updated_by/
 *     odgovoran_user_id/audit actor). Unresolved -> null.
 *   - workers: sy15 core.radnik.<uuid> -> email -> 2.0 users.email -> users.worker_id.
 *     Unresolved -> null (odgovoran_label free text is always preserved).
 *   - operativna_aktivnost.projekat_id (sy15 uuid) is NOT used; the 2.0 project_id is
 *     taken from the resolved work order's project_id (single 2.0 source of truth).
 *   - legacy provenance uuids without a 2.0 int equivalent (izvor_pozicija_id,
 *     izvor_tp_operacija_id, izvor_akcioni_plan_id) are dropped to null + reported.
 *
 * SAFETY / MODES:
 *   - Default is --dry-run: reads + resolves everything, prints counts (with an insert/update
 *     split where idempotency is exact) and unresolved references per category, and lists any
 *     enum/status label outside the 2.0 `///` catalog. Writes NOTHING.
 *   - --apply performs the writes. Writes are idempotent (upsert by natural / provenance key),
 *     so the script may be re-run. operativne_aktivnosti and operativne_aktivnosti_blokade have
 *     no business-natural unique in the 2.0 schema, so each carries a legacy_sy15_id column
 *     (the sy15 row uuid, @unique) and is upserted on it — EXACT idempotency. This replaces the
 *     earlier heuristic tuple (work_order_id, odeljenje_id, naziv_aktivnosti), which collapsed
 *     distinct null-RN activities and broke on NULL sy15 created_at. The heuristic remains ONLY
 *     as a defensive fallback for a (never-observed) activity row without a uuid.
 *   - Enum/status labels (aktivnost status/prioritet/status_mode/izvor, override status_override)
 *     are normalized through LABEL_MAP against the 2.0 catalog rather than copied verbatim;
 *     out-of-catalog values are reported, never silently written under a new label.
 *
 * CONNECTIONS (from existing env, see backend/.env.example):
 *   - 2.0 target: DATABASE_URL          (default datasource of @prisma/client)
 *   - sy15 source: SY15_DATABASE_URL    (default datasource of @prisma-sy15/client;
 *     same role Sy15Service uses — servosync2_app, BYPASSRLS — so direct reads of
 *     auth.users / core.* / production.* succeed without SET ROLE).
 *
 * RUN (ts-node; the script only ever connects to whatever those two URLs point at):
 *   npx ts-node --transpile-only backend/scripts/migrate-pracenje-sy15.ts            # dry-run
 *   npx ts-node --transpile-only backend/scripts/migrate-pracenje-sy15.ts --apply    # write
 *
 * NOTE: two Prisma runtimes are in play. A Prisma.Sql built by one client cannot be
 * executed by the other (`instanceof Sql` fails cross-package). Every raw statement here
 * is built with the sy15 `Sy15Prisma.sql` and run on the sy15 client; the 2.0 side uses
 * only the typed client API — so the two never mix.
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
  // insert vs update split for steps with exact (provenance-keyed) idempotency. Filled in
  // BOTH modes so the dry-run "would-write" is verifiable against apply (no merge surprise).
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

function normCode(s: string | null | undefined): string {
  return (s ?? "").trim();
}

// ---------------------------------------------------------------------------
// Raw row shapes (sy15). production.*/core.*/auth.* are not modeled in Prisma.
// ---------------------------------------------------------------------------
interface ManualOverrideRow {
  predmet_item_id: number;
  bigtehn_rn_id: bigint;
  status_override: string | null;
  masinska_done: boolean | null;
  povrsinska_done: boolean | null;
  created_by_email: string | null;
  updated_by_email: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}
interface ParentOverrideRow {
  predmet_item_id: number;
  bigtehn_rn_id: bigint;
  parent_override_rn_id: bigint | null;
  created_by_email: string | null;
  updated_by_email: string | null;
  created_at: Date | null;
}
interface NapomenaRow {
  predmet_item_id: number;
  bigtehn_rn_id: bigint;
  note: string | null;
  created_by_email: string | null;
  updated_by_email: string | null;
  created_at: Date | null;
}
interface AktivacijaRow {
  predmet_item_id: number;
  je_aktivan: boolean | null;
  azurirao_email: string | null;
  azurirano_at: Date | null;
}
interface PrioritetRow {
  predmet_item_id: number;
  sort_priority: number | null;
  updated_by_email: string | null;
}
interface PlanPrioritetRow {
  predmet_item_id: number;
  slot: number | null;
}
interface OdeljenjeRow {
  id: string; // uuid
  kod: string;
  naziv: string;
  boja: string | null;
  sort_order: number | null;
  aktivan: boolean | null;
  vodja_email: string | null; // resolved from auth.users
  vodja_radnik_email: string | null; // resolved from core.radnik
}
interface AktivnostRow {
  id: string; // uuid
  radni_nalog_id: string | null; // uuid
  odeljenje_id: string | null; // uuid
  rb: number | null;
  naziv_aktivnosti: string;
  opis: string | null;
  broj_tp: string | null;
  kolicina_text: string | null;
  planirani_pocetak: Date | null;
  planirani_zavrsetak: Date | null;
  odgovoran_user_email: string | null;
  odgovoran_radnik_email: string | null;
  odgovoran_label: string | null;
  zavisi_od_aktivnost_id: string | null; // uuid
  zavisi_od_text: string | null;
  status: string;
  prioritet: string;
  status_mode: string;
  manual_override_status: string | null;
  rizik_napomena: string | null;
  izvor: string;
  created_by_email: string | null;
  updated_by_email: string | null;
}
interface BlokIstorijaRow {
  id: string; // uuid
  aktivnost_id: string; // uuid
  old_manual_override_status: string | null;
  new_manual_override_status: string | null;
  old_blokirano_razlog: string | null;
  new_blokirano_razlog: string | null;
  changed_by_email: string | null;
  napomena: string | null;
  created_at: Date | null;
}
interface RadniNalogRow {
  id: string; // uuid
  legacy_idrn: number | null;
}
interface ItemsCacheRow {
  id: number;
  broj_predmeta: string | null;
}
interface AuditRow {
  id: string; // uuid
  table_name: string | null;
  record_id: string | null;
  action: string | null;
  actor_email: string | null;
  actor_uid: string | null;
  changed_at: Date | null;
  old_data: unknown;
  new_data: unknown;
  diff_keys: unknown;
}

// audit_log table_name values that belong to the pracenje/predmet domain (task step 7).
const AUDIT_TABLES = [
  "operativna_aktivnost",
  "operativna_aktivnost_blok_istorija",
  "operativna_aktivnost_pozicija",
  "predmet_aktivacija",
  "predmet_prioritet",
  "predmet_plan_prioritet",
  "pracenje_manual_overrides",
  "pracenje_parent_override",
  "pracenje_proizvodnje_napomene",
  "pracenje_proizvodnje_export",
];

// ---------------------------------------------------------------------------
// Status / enum catalogs (BACKEND_RULES §2: statuses are String columns whose allowed
// values live in the `///` schema comment, with NO DB-level guard). The sy15 source
// enums map 1:1 onto the 2.0 catalogs today — verified against the SECURITY DEFINER fn
// bodies in backend/docs/design/authz-snapshots/talasC-fn-defs-2026-07-12.sql:
//   production.aktivnost_status      = nije_krenulo | u_toku | zavrseno | blokirano
//   production.aktivnost_prioritet   = nizak | srednji | visok
//   production.aktivnost_status_mode = manual | auto_from_pozicija | auto_from_operacije
//   production.aktivnost_izvor       = rucno | iz_sastanka | akcioni_plan
//   pracenje_manual_overrides.status_override CHECK = u_radu | kompletirano | nije_zapoceto
// So LABEL_MAP is identity now; it exists so a future sy15 drift is (a) remapped when a
// translation is known, and (b) REPORTED as out-of-catalog before --apply — instead of
// being copied verbatim into an unguarded String column.
// ---------------------------------------------------------------------------
const CATALOG = {
  override_status: new Set(["u_radu", "kompletirano", "nije_zapoceto"]),
  aktivnost_status: new Set(["nije_krenulo", "u_toku", "zavrseno", "blokirano"]),
  aktivnost_prioritet: new Set(["nizak", "srednji", "visok"]),
  aktivnost_status_mode: new Set(["manual", "auto_from_pozicija", "auto_from_operacije"]),
  aktivnost_izvor: new Set(["rucno", "iz_sastanka", "akcioni_plan"]),
} as const;
type CatalogField = keyof typeof CATALOG;
const CATALOG_FIELDS = Object.keys(CATALOG) as CatalogField[];

// Known sy15 -> 2.0 relabelings (currently identity for every field; add entries here if
// a sy15 label ever diverges from the 2.0 catalog).
const LABEL_MAP: Record<CatalogField, Record<string, string>> = {
  override_status: {},
  aktivnost_status: {},
  aktivnost_prioritet: {},
  aktivnost_status_mode: {},
  aktivnost_izvor: {},
};

// Out-of-catalog accumulator: field -> mapped value -> occurrences (dry-run gate).
const outOfCatalog: Record<CatalogField, Map<string, number>> = {
  override_status: new Map(),
  aktivnost_status: new Map(),
  aktivnost_prioritet: new Map(),
  aktivnost_status_mode: new Map(),
  aktivnost_izvor: new Map(),
};

/**
 * Normalize a sy15 enum label to the 2.0 catalog. Applies the known relabeling, then
 * RECORDS (never drops) any value still outside the catalog so it surfaces in the report.
 * Must be called during the read phase (before the --apply guard) so out-of-catalog values
 * are visible in a dry-run. Returns the mapped value unchanged for out-of-catalog inputs —
 * the column is an unguarded String, so we flag rather than silently rewrite.
 */
function normalizeLabel(
  field: CatalogField,
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const mapped = LABEL_MAP[field][trimmed] ?? trimmed;
  if (!CATALOG[field].has(mapped)) {
    outOfCatalog[field].set(mapped, (outOfCatalog[field].get(mapped) ?? 0) + 1);
  }
  return mapped;
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
    `\n=== migrate-pracenje-sy15 :: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"} ===\n`,
  );

  try {
    // -----------------------------------------------------------------------
    // Shared resolvers.
    // -----------------------------------------------------------------------
    // 2.0 users: email(lower) -> { id, workerId }.
    const users = await prisma.user.findMany({
      select: { id: true, email: true, workerId: true },
    });
    const userByEmail = new Map<string, { id: number; workerId: number | null }>();
    for (const u of users) {
      userByEmail.set(u.email.toLowerCase(), { id: u.id, workerId: u.workerId });
    }
    const resolveUserId = (email: string | null): number | null =>
      email ? (userByEmail.get(email.toLowerCase())?.id ?? null) : null;
    const resolveWorkerIdByEmail = (email: string | null): number | null =>
      email ? (userByEmail.get(email.toLowerCase())?.workerId ?? null) : null;

    // sy15 radni_nalog uuid -> legacy_idrn (== 2.0 work_orders.id).
    const rnRows = await sy15.$queryRaw<RadniNalogRow[]>(
      Sy15Prisma.sql`SELECT id::text AS id, legacy_idrn FROM production.radni_nalog`,
    );
    const legacyIdrnByRnUuid = new Map<string, number | null>();
    for (const r of rnRows) legacyIdrnByRnUuid.set(r.id, toInt4(r.legacy_idrn));

    // -----------------------------------------------------------------------
    // STEP 5 (first — needed as FK parent for step 6): core.odeljenje -> odeljenja.
    // -----------------------------------------------------------------------
    const s5 = step("5_odeljenja");
    const odeljenjaRows = await sy15.$queryRaw<OdeljenjeRow[]>(
      Sy15Prisma.sql`
        SELECT o.id::text            AS id,
               o.kod                 AS kod,
               o.naziv               AS naziv,
               o.boja                AS boja,
               o.sort_order          AS sort_order,
               o.aktivan             AS aktivan,
               au.email              AS vodja_email,
               r.email               AS vodja_radnik_email
          FROM core.odeljenje o
          LEFT JOIN auth.users au ON au.id = o.vodja_user_id
          LEFT JOIN core.radnik r ON r.id = o.vodja_radnik_id`,
    );
    s5.read = odeljenjaRows.length;
    // sy15 odeljenje uuid -> 2.0 code (for step-6 department remap).
    const codeByOdeljenjeUuid = new Map<string, string>();
    const importedOdeljenjeCodes = new Set<string>();
    for (const o of odeljenjaRows) {
      const code = normCode(o.kod);
      if (!code) {
        s5.skipped++;
        note(s5, "empty_code", o.id);
        continue;
      }
      codeByOdeljenjeUuid.set(o.id, code);
      importedOdeljenjeCodes.add(code);
      const leadUserId = resolveUserId(o.vodja_email);
      const leadWorkerId = resolveWorkerIdByEmail(o.vodja_radnik_email);
      if (o.vodja_email && leadUserId == null) note(s5, "lead_user_unresolved", code);
      if (o.vodja_radnik_email && leadWorkerId == null)
        note(s5, "lead_worker_unresolved", code);
      s5.written++;
      if (APPLY) {
        await prisma.odeljenje.upsert({
          where: { code },
          create: {
            code,
            name: normCode(o.naziv) || code,
            color: o.boja ?? null,
            sortOrder: o.sort_order ?? 0,
            active: o.aktivan ?? true,
            leadUserId,
            leadWorkerId,
          },
          update: {
            name: normCode(o.naziv) || code,
            color: o.boja ?? null,
            sortOrder: o.sort_order ?? 0,
            active: o.aktivan ?? true,
            leadUserId,
            leadWorkerId,
          },
        });
      }
    }
    // 2.0 odeljenja code -> id. Built in BOTH modes so STEP 6 resolves departments
    // identically in dry-run and apply (finding: dry-run STEP 6 counts must be believable).
    // In a dry-run step 5 has not written yet, so any code it *would* create gets a synthetic
    // negative id — never persisted, it only keeps the resolution/skip path symmetric.
    const odeljenjaIdByCode = new Map<string, number>();
    for (const row of await prisma.odeljenje.findMany({
      select: { id: true, code: true },
    })) {
      odeljenjaIdByCode.set(row.code, row.id);
    }
    if (!APPLY) {
      let synthetic = -1;
      for (const code of importedOdeljenjeCodes) {
        if (!odeljenjaIdByCode.has(code)) odeljenjaIdByCode.set(code, synthetic--);
      }
    }

    // -----------------------------------------------------------------------
    // Project resolver (steps 3 + 4): predmet_item_id -> 2.0 projects.id.
    // Heuristic cascade, documented in the header. Cached per item id.
    // -----------------------------------------------------------------------
    // 2.0 projects: normalized project_number -> [ids].
    const projectRows = await prisma.project.findMany({
      select: { id: true, projectNumber: true },
    });
    const projectIdsByNumber = new Map<string, number[]>();
    const projectIdsByNumberLower = new Map<string, number[]>();
    for (const p of projectRows) {
      const n = normCode(p.projectNumber);
      if (!n) continue;
      (projectIdsByNumber.get(n) ?? projectIdsByNumber.set(n, []).get(n)!).push(p.id);
      const nl = n.toLowerCase();
      (
        projectIdsByNumberLower.get(nl) ??
        projectIdsByNumberLower.set(nl, []).get(nl)!
      ).push(p.id);
    }

    const itemCacheById = new Map<number, string | null>(); // itemId -> broj_predmeta
    const projectByItemId = new Map<number, number | null>(); // itemId -> projectId (or null)

    async function loadItemsCache(itemIds: number[]): Promise<void> {
      const missing = itemIds.filter((i) => !itemCacheById.has(i));
      if (missing.length === 0) return;
      const rows = await sy15.$queryRaw<ItemsCacheRow[]>(
        Sy15Prisma.sql`SELECT id, broj_predmeta FROM public.bigtehn_items_cache
                        WHERE id IN (${Sy15Prisma.join(missing)})`,
      );
      for (const r of rows) itemCacheById.set(r.id, r.broj_predmeta);
      for (const i of missing) if (!itemCacheById.has(i)) itemCacheById.set(i, null);
    }

    /** Returns { projectId, reason } — reason is set only when unresolved. */
    function resolveProjectByItemId(itemId: number): {
      projectId: number | null;
      reason: string | null;
    } {
      if (projectByItemId.has(itemId)) {
        return { projectId: projectByItemId.get(itemId)!, reason: null };
      }
      const broj = normCode(itemCacheById.get(itemId));
      let projectId: number | null = null;
      let reason: string | null = null;
      if (!broj) {
        reason = "no_broj_predmeta_in_items_cache";
      } else {
        let ids = projectIdsByNumber.get(broj);
        if (!ids || ids.length === 0) ids = projectIdsByNumberLower.get(broj.toLowerCase());
        if (!ids || ids.length === 0) reason = `no_project_for_number:${broj}`;
        else if (ids.length > 1) reason = `ambiguous_project_number:${broj}`;
        else projectId = ids[0];
      }
      projectByItemId.set(itemId, projectId);
      return { projectId, reason };
    }

    // Work-order existence + project map (built from all work-order ids referenced).
    async function loadWorkOrders(
      ids: number[],
    ): Promise<Map<number, { projectId: number }>> {
      const uniq = [...new Set(ids)].filter((n) => Number.isFinite(n));
      const map = new Map<number, { projectId: number }>();
      if (uniq.length === 0) return map;
      const rows = await prisma.workOrder.findMany({
        where: { id: { in: uniq } },
        select: { id: true, projectId: true },
      });
      for (const r of rows) map.set(r.id, { projectId: r.projectId });
      return map;
    }

    // =======================================================================
    // STEP 1: pracenje_manual_overrides -> pracenje_overrides
    // =======================================================================
    const s1 = step("1_pracenje_overrides");
    const ovrRows = await sy15.$queryRaw<ManualOverrideRow[]>(
      Sy15Prisma.sql`
        SELECT o.predmet_item_id, o.bigtehn_rn_id,
               o.status_override, o.masinska_done, o.povrsinska_done,
               cb.email AS created_by_email, ub.email AS updated_by_email,
               o.created_at, o.updated_at
          FROM production.pracenje_manual_overrides o
          LEFT JOIN auth.users cb ON cb.id = o.created_by
          LEFT JOIN auth.users ub ON ub.id = o.updated_by`,
    );
    s1.read = ovrRows.length;
    {
      const woMap = await loadWorkOrders(
        ovrRows.map((r) => toInt4(r.bigtehn_rn_id) ?? -1),
      );
      const seenWo = new Set<number>();
      for (const r of ovrRows) {
        const woId = toInt4(r.bigtehn_rn_id);
        if (woId == null || !woMap.has(woId)) {
          s1.skipped++;
          note(s1, "work_order_missing", String(r.bigtehn_rn_id));
          continue;
        }
        if (seenWo.has(woId)) {
          s1.skipped++;
          note(s1, "duplicate_work_order", String(woId));
          continue;
        }
        seenWo.add(woId);
        // Catalog-check the status in the read phase (visible in dry-run, finding 3).
        const manualStatus = normalizeLabel("override_status", r.status_override);
        s1.written++;
        if (APPLY) {
          await prisma.pracenjeOverride.upsert({
            where: { workOrderId: woId },
            create: {
              workOrderId: woId,
              manualStatus,
              manualMachining: r.masinska_done,
              manualSurface: r.povrsinska_done,
              // manual_qty / reason have no sy15 source (new 2.0 columns) -> null.
              createdByUserId: resolveUserId(r.created_by_email),
              updatedByUserId: resolveUserId(r.updated_by_email),
              ...(r.created_at ? { createdAt: r.created_at } : {}),
            },
            update: {
              manualStatus,
              manualMachining: r.masinska_done,
              manualSurface: r.povrsinska_done,
              updatedByUserId: resolveUserId(r.updated_by_email),
            },
          });
        }
      }
    }

    // =======================================================================
    // STEP 2: pracenje_parent_override -> pracenje_structure_overrides
    // =======================================================================
    const s2 = step("2_pracenje_structure_overrides");
    const parRows = await sy15.$queryRaw<ParentOverrideRow[]>(
      Sy15Prisma.sql`
        SELECT p.predmet_item_id, p.bigtehn_rn_id, p.parent_override_rn_id,
               cb.email AS created_by_email, ub.email AS updated_by_email, p.created_at
          FROM production.pracenje_parent_override p
          LEFT JOIN auth.users cb ON cb.id = p.created_by
          LEFT JOIN auth.users ub ON ub.id = p.updated_by`,
    );
    s2.read = parRows.length;
    {
      const woMap = await loadWorkOrders(
        parRows.flatMap((r) => [
          toInt4(r.bigtehn_rn_id) ?? -1,
          toInt4(r.parent_override_rn_id) ?? -1,
        ]),
      );
      const seenWo = new Set<number>();
      for (const r of parRows) {
        const woId = toInt4(r.bigtehn_rn_id);
        if (woId == null || !woMap.has(woId)) {
          s2.skipped++;
          note(s2, "work_order_missing", String(r.bigtehn_rn_id));
          continue;
        }
        if (seenWo.has(woId)) {
          s2.skipped++;
          note(s2, "duplicate_work_order", String(woId));
          continue;
        }
        seenWo.add(woId);
        let parentId = toInt4(r.parent_override_rn_id);
        if (parentId != null && !woMap.has(parentId)) {
          note(s2, "parent_work_order_missing", String(r.parent_override_rn_id));
          parentId = null; // keep the row; drop the dangling parent ref.
        }
        s2.written++;
        if (APPLY) {
          await prisma.pracenjeStructureOverride.upsert({
            where: { workOrderId: woId },
            create: {
              workOrderId: woId,
              parentWorkOrderId: parentId,
              createdByUserId: resolveUserId(r.created_by_email),
              updatedByUserId: resolveUserId(r.updated_by_email),
              ...(r.created_at ? { createdAt: r.created_at } : {}),
            },
            update: {
              parentWorkOrderId: parentId,
              updatedByUserId: resolveUserId(r.updated_by_email),
            },
          });
        }
      }
    }

    // =======================================================================
    // STEP 3: pracenje_proizvodnje_napomene -> pracenje_notes
    // =======================================================================
    const s3 = step("3_pracenje_notes");
    const napRows = await sy15.$queryRaw<NapomenaRow[]>(
      Sy15Prisma.sql`
        SELECT n.predmet_item_id, n.bigtehn_rn_id, n.note,
               cb.email AS created_by_email, ub.email AS updated_by_email, n.created_at
          FROM production.pracenje_proizvodnje_napomene n
          LEFT JOIN auth.users cb ON cb.id = n.created_by
          LEFT JOIN auth.users ub ON ub.id = n.updated_by`,
    );
    s3.read = napRows.length;
    {
      await loadItemsCache(napRows.map((r) => r.predmet_item_id));
      const woMap = await loadWorkOrders(
        napRows.map((r) => toInt4(r.bigtehn_rn_id) ?? -1),
      );
      const seen = new Set<string>();
      for (const r of napRows) {
        const woId = toInt4(r.bigtehn_rn_id);
        if (woId == null || !woMap.has(woId)) {
          s3.skipped++;
          note(s3, "work_order_missing", String(r.bigtehn_rn_id));
          continue;
        }
        const { projectId, reason } = resolveProjectByItemId(r.predmet_item_id);
        if (projectId == null) {
          s3.skipped++;
          note(s3, reason ?? "project_unresolved", String(r.predmet_item_id));
          continue;
        }
        const key = `${projectId}:${woId}`;
        if (seen.has(key)) {
          s3.skipped++;
          note(s3, "duplicate_project_work_order", key);
          continue;
        }
        seen.add(key);
        s3.written++;
        if (APPLY) {
          await prisma.pracenjeNote.upsert({
            where: { projectId_workOrderId: { projectId, workOrderId: woId } },
            create: {
              projectId,
              workOrderId: woId,
              note: r.note ?? "",
              createdByUserId: resolveUserId(r.created_by_email),
              updatedByUserId: resolveUserId(r.updated_by_email),
              ...(r.created_at ? { createdAt: r.created_at } : {}),
            },
            update: {
              note: r.note ?? "",
              updatedByUserId: resolveUserId(r.updated_by_email),
            },
          });
        }
      }
    }

    // =======================================================================
    // STEP 4: predmet_aktivacija + predmet_prioritet + predmet_plan_prioritet
    //         -> predmet_aktivacije (one merged row per project)
    // =======================================================================
    const s4 = step("4_predmet_aktivacije");
    const aktRows = await sy15.$queryRaw<AktivacijaRow[]>(
      Sy15Prisma.sql`
        SELECT a.predmet_item_id, a.je_aktivan, u.email AS azurirao_email, a.azurirano_at
          FROM production.predmet_aktivacija a
          LEFT JOIN auth.users u ON u.id = a.azurirao_user_id`,
    );
    const priRows = await sy15.$queryRaw<PrioritetRow[]>(
      Sy15Prisma.sql`
        SELECT p.predmet_item_id, p.sort_priority, u.email AS updated_by_email
          FROM production.predmet_prioritet p
          LEFT JOIN auth.users u ON u.id = p.updated_by`,
    );
    const planRows = await sy15.$queryRaw<PlanPrioritetRow[]>(
      Sy15Prisma.sql`SELECT predmet_item_id, slot FROM production.predmet_plan_prioritet`,
    );
    s4.read = aktRows.length;

    interface Merged {
      isActive: boolean;
      sortPriority: number | null;
      planPriority: number | null;
      updatedByEmail: string | null;
      azuriranoAt: Date | null;
      fromAktivacija: boolean;
    }
    const merged = new Map<number, Merged>();
    const ensure = (itemId: number): Merged => {
      let m = merged.get(itemId);
      if (!m) {
        m = {
          isActive: true,
          sortPriority: null,
          planPriority: null,
          updatedByEmail: null,
          azuriranoAt: null,
          fromAktivacija: false,
        };
        merged.set(itemId, m);
      }
      return m;
    };
    for (const a of aktRows) {
      const m = ensure(a.predmet_item_id);
      m.isActive = a.je_aktivan ?? true;
      m.updatedByEmail = a.azurirao_email;
      m.azuriranoAt = a.azurirano_at;
      m.fromAktivacija = true;
    }
    for (const p of priRows) {
      const m = ensure(p.predmet_item_id);
      m.sortPriority = p.sort_priority ?? null;
      if (m.updatedByEmail == null) m.updatedByEmail = p.updated_by_email;
    }
    for (const pl of planRows) ensure(pl.predmet_item_id).planPriority = pl.slot ?? null;

    await loadItemsCache([...merged.keys()]);
    const seenProject = new Set<number>();
    for (const [itemId, m] of merged) {
      if (!m.fromAktivacija) note(s4, "priority_without_aktivacija", String(itemId));
      const { projectId, reason } = resolveProjectByItemId(itemId);
      if (projectId == null) {
        s4.skipped++;
        note(s4, reason ?? "project_unresolved", String(itemId));
        continue;
      }
      if (seenProject.has(projectId)) {
        s4.skipped++;
        note(s4, "duplicate_project_collision", `${itemId}->${projectId}`);
        continue;
      }
      seenProject.add(projectId);
      const updatedByUserId = resolveUserId(m.updatedByEmail);
      s4.written++;
      if (APPLY) {
        await prisma.predmetAktivacija.upsert({
          where: { projectId },
          create: {
            projectId,
            isActive: m.isActive,
            sortPriority: m.sortPriority,
            planPriority: m.planPriority,
            createdByUserId: updatedByUserId,
            updatedByUserId,
            ...(m.azuriranoAt ? { createdAt: m.azuriranoAt } : {}),
          },
          update: {
            isActive: m.isActive,
            sortPriority: m.sortPriority,
            planPriority: m.planPriority,
            updatedByUserId,
          },
        });
      }
    }

    // =======================================================================
    // STEP 6: operativna_aktivnost (+ _blok_istorija)
    //         -> operativne_aktivnosti (+ _blokade)
    // Two passes: (a) upsert activities and build sy15-uuid -> 2.0-id map,
    // (b) resolve self-ref zavisi_od + import block history.
    // =======================================================================
    const s6 = step("6_operativne_aktivnosti");
    const s6b = step("6b_operativne_aktivnosti_blokade");
    const aktivnostiRows = await sy15.$queryRaw<AktivnostRow[]>(
      Sy15Prisma.sql`
        SELECT a.id::text                 AS id,
               a.radni_nalog_id::text     AS radni_nalog_id,
               a.odeljenje_id::text       AS odeljenje_id,
               a.rb, a.naziv_aktivnosti, a.opis, a.broj_tp, a.kolicina_text,
               a.planirani_pocetak, a.planirani_zavrsetak,
               ou.email                   AS odgovoran_user_email,
               orr.email                  AS odgovoran_radnik_email,
               a.odgovoran_label,
               a.zavisi_od_aktivnost_id::text AS zavisi_od_aktivnost_id,
               a.zavisi_od_text,
               a.status::text             AS status,
               a.prioritet::text          AS prioritet,
               a.status_mode::text        AS status_mode,
               a.manual_override_status::text AS manual_override_status,
               a.rizik_napomena,
               a.izvor::text              AS izvor,
               cb.email                   AS created_by_email,
               ub.email                   AS updated_by_email
          FROM production.operativna_aktivnost a
          LEFT JOIN auth.users ou  ON ou.id  = a.odgovoran_user_id
          LEFT JOIN core.radnik orr ON orr.id = a.odgovoran_radnik_id
          LEFT JOIN auth.users cb  ON cb.id  = a.created_by
          LEFT JOIN auth.users ub  ON ub.id  = a.updated_by`,
    );
    s6.read = aktivnostiRows.length;

    const woMap6 = await loadWorkOrders(
      aktivnostiRows.map((r) =>
        r.radni_nalog_id
          ? (legacyIdrnByRnUuid.get(r.radni_nalog_id) ?? -1)
          : -1,
      ),
    );
    // sy15 aktivnost uuid -> new 2.0 id (used for zavisi_od + blokade). In apply it is the
    // freshly upserted id; in dry-run it is the id of an already-imported row (if any).
    const newIdByAktivnostUuid = new Map<string, number>();
    // sy15 aktivnost uuids that pass resolution and would be written (imported). Drives the
    // blokade parent gate symmetrically in both modes (a dry-run has no fresh ids yet).
    const processedAktivnostUuids = new Set<string>();
    // Existing target rows keyed by sy15 provenance uuid — the EXACT idempotency anchor
    // (replaces the heuristic (workOrderId, odeljenjeId, naziv) key that collapsed distinct
    // null-RN activities) and the basis for a believable dry-run insert/update split.
    const existingAktByLegacy = new Map<string, number>();
    for (const row of await prisma.operativnaAktivnost.findMany({
      where: { legacySy15Id: { not: null } },
      select: { id: true, legacySy15Id: true },
    })) {
      if (row.legacySy15Id) existingAktByLegacy.set(row.legacySy15Id, row.id);
    }

    for (const a of aktivnostiRows) {
      // Department (FK, required). Resolvable in both modes (synthetic ids in dry-run).
      const odeljenjeCode = a.odeljenje_id
        ? codeByOdeljenjeUuid.get(a.odeljenje_id)
        : undefined;
      if (!odeljenjeCode || !importedOdeljenjeCodes.has(odeljenjeCode)) {
        s6.skipped++;
        note(s6, "odeljenje_unresolved", a.id);
        continue;
      }
      const odeljenjeId = odeljenjaIdByCode.get(odeljenjeCode);
      if (odeljenjeId == null) {
        s6.skipped++;
        note(s6, "odeljenje_id_missing", odeljenjeCode);
        continue;
      }

      // Work order (O4) — nullable: unresolved -> null + report, row still imported.
      let workOrderId: number | null = null;
      let projectId: number | null = null;
      if (a.radni_nalog_id) {
        const legacy = legacyIdrnByRnUuid.get(a.radni_nalog_id) ?? null;
        if (legacy != null && woMap6.has(legacy)) {
          workOrderId = legacy;
          projectId = woMap6.get(legacy)!.projectId;
        } else {
          note(s6, "work_order_unresolved", a.radni_nalog_id);
        }
      } else {
        note(s6, "no_radni_nalog", a.id);
      }

      const odgovoranUserId = resolveUserId(a.odgovoran_user_email);
      const odgovoranWorkerId = resolveWorkerIdByEmail(a.odgovoran_radnik_email);
      if (a.odgovoran_radnik_email && odgovoranWorkerId == null)
        note(s6, "odgovoran_worker_unresolved", a.id);
      // Catalog-check all enum labels in the read phase (visible in dry-run, finding 3).
      const baseStatus = normalizeLabel("aktivnost_status", a.status) ?? "nije_krenulo";
      const overrideStatus = normalizeLabel(
        "aktivnost_status",
        a.manual_override_status,
      );
      // manual_override_status = 'blokirano' overrides the base status.
      const status = overrideStatus === "blokirano" ? "blokirano" : baseStatus;
      const prioritet = normalizeLabel("aktivnost_prioritet", a.prioritet) ?? "srednji";
      const statusMode =
        normalizeLabel("aktivnost_status_mode", a.status_mode) ?? "manual";
      const izvor = normalizeLabel("aktivnost_izvor", a.izvor) ?? "rucno";

      const legacyId = a.id; // sy15 uuid PK — always present; the exact idempotency key.
      processedAktivnostUuids.add(legacyId);
      s6.written++;
      if (existingAktByLegacy.has(legacyId)) s6.updated = (s6.updated ?? 0) + 1;
      else s6.inserted = (s6.inserted ?? 0) + 1;

      if (APPLY) {
        const data = {
          workOrderId,
          projectId,
          odeljenjeId,
          nazivAktivnosti: a.naziv_aktivnosti,
          planiraniPocetak: a.planirani_pocetak,
          planiraniZavrsetak: a.planirani_zavrsetak,
          odgovoranUserId,
          odgovoranWorkerId,
          odgovoranLabel: a.odgovoran_label ?? null,
          status,
          prioritet,
          rb: a.rb ?? 0,
          opis: a.opis ?? null,
          brojTp: a.broj_tp ?? null,
          kolicinaText: a.kolicina_text ?? null,
          // zavisiOdAktivnostId resolved in pass (b); zavisi_od_text kept now.
          zavisiOdText: a.zavisi_od_text ?? null,
          statusMode,
          rizikNapomena: a.rizik_napomena ?? null,
          izvor,
          // Legacy provenance uuids have no 2.0 int equivalent -> dropped (reported).
          createdByUserId: resolveUserId(a.created_by_email),
          updatedByUserId: resolveUserId(a.updated_by_email),
        };
        let savedId: number;
        if (legacyId) {
          // EXACT idempotency: upsert on the sy15 provenance uuid. Re-runs update in place.
          const saved = await prisma.operativnaAktivnost.upsert({
            where: { legacySy15Id: legacyId },
            create: { ...data, legacySy15Id: legacyId },
            update: data,
            select: { id: true },
          });
          savedId = saved.id;
        } else {
          // Fallback (defensive only — sy15 activities always carry a uuid PK): no
          // provenance id, so dedup on the heuristic tuple. Documented as inexact: it can
          // collapse distinct null-RN activities that share (odeljenje, naziv).
          const existing = await prisma.operativnaAktivnost.findFirst({
            where: { workOrderId, odeljenjeId, nazivAktivnosti: a.naziv_aktivnosti },
            select: { id: true },
          });
          savedId = existing
            ? (
                await prisma.operativnaAktivnost.update({
                  where: { id: existing.id },
                  data,
                  select: { id: true },
                })
              ).id
            : (await prisma.operativnaAktivnost.create({ data, select: { id: true } }))
                .id;
        }
        newIdByAktivnostUuid.set(a.id, savedId);
      } else {
        // Dry-run: expose the predicted 2.0 id (only known for already-imported rows) so
        // pass (b) self-ref + blokade simulation can resolve against it.
        const predicted = existingAktByLegacy.get(legacyId);
        if (predicted != null) newIdByAktivnostUuid.set(a.id, predicted);
      }
    }

    // Pass (b): resolve zavisi_od self-ref (apply only — needs the id map).
    if (APPLY) {
      for (const a of aktivnostiRows) {
        if (!a.zavisi_od_aktivnost_id) continue;
        const selfId = newIdByAktivnostUuid.get(a.id);
        const depId = newIdByAktivnostUuid.get(a.zavisi_od_aktivnost_id);
        if (selfId == null) continue;
        if (depId == null) {
          note(s6, "zavisi_od_unresolved", a.id);
          continue;
        }
        await prisma.operativnaAktivnost.update({
          where: { id: selfId },
          data: { zavisiOdAktivnostId: depId },
        });
      }
    } else {
      for (const a of aktivnostiRows) {
        if (a.zavisi_od_aktivnost_id) note(s6, "zavisi_od_pending_pass_b", a.id);
      }
    }

    // Block history -> blokade (best-effort episode reconstruction; see header).
    const blokRows = aktivnostiRows.length
      ? await sy15.$queryRaw<BlokIstorijaRow[]>(
          Sy15Prisma.sql`
            SELECT b.id::text AS id, b.aktivnost_id::text AS aktivnost_id,
                   b.old_manual_override_status::text AS old_manual_override_status,
                   b.new_manual_override_status::text AS new_manual_override_status,
                   b.old_blokirano_razlog, b.new_blokirano_razlog,
                   u.email AS changed_by_email, b.napomena, b.created_at
              FROM production.operativna_aktivnost_blok_istorija b
              LEFT JOIN auth.users u ON u.id = b.changed_by
              ORDER BY b.created_at ASC`,
        )
      : [];
    s6b.read = blokRows.length;
    // Existing blokade keyed by sy15 provenance uuid — EXACT idempotency for the block-history
    // import (fixes: a NULL sy15 created_at fell back to new Date(), so the old
    // (aktivnost, blockedAt, razlog) dedup never matched and inserted a duplicate on every
    // --apply). Also the basis for the dry-run insert/update split.
    const existingBlokadaByLegacy = new Map<string, number>();
    if (blokRows.length) {
      for (const row of await prisma.operativnaAktivnostBlokada.findMany({
        where: { legacySy15Id: { not: null } },
        select: { id: true, legacySy15Id: true },
      })) {
        if (row.legacySy15Id) existingBlokadaByLegacy.set(row.legacySy15Id, row.id);
      }
    }
    for (const b of blokRows) {
      const isBlock = b.new_manual_override_status === "blokirano";
      const isUnblock =
        b.old_manual_override_status === "blokirano" &&
        b.new_manual_override_status == null;
      // Parent gate — symmetric across modes: skip iff the parent activity was not imported.
      if (!processedAktivnostUuids.has(b.aktivnost_id)) {
        s6b.skipped++;
        note(s6b, "aktivnost_unresolved", b.aktivnost_id);
        continue;
      }
      const aktivnostId = APPLY ? newIdByAktivnostUuid.get(b.aktivnost_id) : undefined;
      if (APPLY && aktivnostId == null) {
        s6b.skipped++;
        note(s6b, "aktivnost_id_missing", b.aktivnost_id);
        continue;
      }
      const changedByUserId = resolveUserId(b.changed_by_email);
      if (isBlock) {
        s6b.written++;
        if (existingBlokadaByLegacy.has(b.id)) s6b.updated = (s6b.updated ?? 0) + 1;
        else s6b.inserted = (s6b.inserted ?? 0) + 1;
        if (APPLY) {
          const razlog =
            normCode(b.new_blokirano_razlog) ||
            normCode(b.old_blokirano_razlog) ||
            "(migrirano — bez razloga)";
          const blockedAt = b.created_at ?? new Date();
          // EXACT idempotency by sy15 provenance uuid: re-runs update in place, never a copy.
          // blockedAt is written only on create, so a null-source fallback (new Date()) stays
          // stable across re-runs instead of minting a fresh timestamp each time.
          await prisma.operativnaAktivnostBlokada.upsert({
            where: { legacySy15Id: b.id },
            create: {
              aktivnostId: aktivnostId!,
              legacySy15Id: b.id,
              razlog,
              blockedAt,
              blockedByUserId: changedByUserId,
              napomena: b.napomena ?? null,
            },
            update: {
              razlog,
              blockedByUserId: changedByUserId,
              napomena: b.napomena ?? null,
            },
          });
        }
      } else if (isUnblock) {
        // Best-effort episode close: mark the most recent still-open blokade of this activity
        // as unblocked. Update-only (never inserts), so it cannot duplicate; on a re-run the
        // episode is already closed and this only re-notes, with no data change.
        if (APPLY) {
          const open = await prisma.operativnaAktivnostBlokada.findFirst({
            where: { aktivnostId: aktivnostId!, unblockedAt: null },
            orderBy: { blockedAt: "desc" },
            select: { id: true },
          });
          if (open) {
            await prisma.operativnaAktivnostBlokada.update({
              where: { id: open.id },
              data: {
                unblockedAt: b.created_at ?? new Date(),
                unblockedByUserId: changedByUserId,
                napomena: b.napomena ?? undefined,
              },
            });
          } else {
            note(s6b, "unblock_without_open_blokada", b.aktivnost_id);
          }
        }
      } else {
        note(s6b, "non_block_transition_skipped", b.id);
      }
    }

    // =======================================================================
    // STEP 7: audit_log (pracenje/predmet tables) -> 2.0 audit_log
    // =======================================================================
    const s7 = step("7_audit_log");
    const auditRows = await sy15.$queryRaw<AuditRow[]>(
      Sy15Prisma.sql`
        SELECT id::text AS id, table_name, record_id::text AS record_id, action,
               actor_email, actor_uid::text AS actor_uid, changed_at,
               old_data, new_data, diff_keys
          FROM audit_log
         WHERE table_name IN (${Sy15Prisma.join(AUDIT_TABLES)})
         ORDER BY changed_at ASC`,
    );
    s7.read = auditRows.length;
    // Idempotency: skip audit rows already imported (metadata.sy15_audit_id).
    const alreadyImported = new Set<string>();
    if (APPLY) {
      const existing = await prisma.$queryRaw<{ sid: string }[]>(
        Prisma20.sql`SELECT metadata->>'sy15_audit_id' AS sid FROM audit_log
                      WHERE metadata->>'source' = 'sy15-import'
                        AND metadata->>'sy15_audit_id' IS NOT NULL`,
      );
      for (const e of existing) alreadyImported.add(e.sid);
    }
    const auditCreate: Prisma20.AuditLogCreateManyInput[] = [];
    for (const a of auditRows) {
      if (alreadyImported.has(a.id)) {
        s7.skipped++;
        continue;
      }
      s7.written++;
      if (APPLY) {
        auditCreate.push({
          actorUserId: resolveUserId(a.actor_email),
          actorUsername: a.actor_email?.slice(0, 255) ?? null,
          action: (a.action ?? "UNKNOWN").slice(0, 100),
          entityType: a.table_name?.slice(0, 100) ?? null,
          entityId: a.record_id?.slice(0, 100) ?? null,
          beforeData:
            a.old_data == null
              ? Prisma20.DbNull
              : (a.old_data as Prisma20.InputJsonValue),
          afterData:
            a.new_data == null
              ? Prisma20.DbNull
              : (a.new_data as Prisma20.InputJsonValue),
          metadata: {
            source: "sy15-import",
            sy15_audit_id: a.id,
            actor_uid: a.actor_uid,
            diff_keys: (a.diff_keys as Prisma20.InputJsonValue) ?? null,
            original_changed_at: a.changed_at ? a.changed_at.toISOString() : null,
          } as Prisma20.InputJsonValue,
          ...(a.changed_at ? { createdAt: a.changed_at } : {}),
        });
      }
    }
    if (APPLY && auditCreate.length > 0) {
      await prisma.auditLog.createMany({ data: auditCreate });
    }

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
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
    // insert/update split (exact-idempotency steps only) makes the dry-run count verifiable.
    const io =
      s.inserted != null || s.updated != null
        ? ` (insert=${s.inserted ?? 0} update=${s.updated ?? 0})`
        : "";
    console.log(
      `\n  ${name}: read=${s.read} ${verb}=${s.written}${io} skipped=${s.skipped}`,
    );
    for (const [cat, keys] of Object.entries(s.unresolved)) {
      const sample = keys.slice(0, 10).join(", ");
      const more = keys.length > 10 ? ` … (+${keys.length - 10})` : "";
      console.log(`      - ${cat}: ${keys.length}  [${sample}${more}]`);
    }
  }

  // Out-of-catalog gate (finding: statuses/enum labels copied verbatim). Any sy15 label
  // outside the 2.0 /// catalog is surfaced here — review BEFORE --apply, because the target
  // columns are unguarded Strings that will accept whatever is written.
  const flagged = CATALOG_FIELDS.filter((f) => outOfCatalog[f].size > 0);
  console.log(
    "\nOUT-OF-CATALOG VALUES (sy15 labels not in the 2.0 /// catalog):",
  );
  if (flagged.length === 0) {
    console.log("  none — every sy15 label maps into the 2.0 catalog.");
  } else {
    for (const f of flagged) {
      const parts = [...outOfCatalog[f].entries()]
        .map(([v, n]) => `'${v}'×${n}`)
        .join(", ");
      console.log(`  ${f}: ${parts}`);
    }
    console.log(
      "  ^ written as-is (no silent drop) but NOT in the catalog — add a LABEL_MAP entry or" +
        " extend the /// list before trusting --apply.",
    );
  }

  console.log("\n---------------------------------------------------------------");
  if (!APPLY) {
    console.log("DRY-RUN only — nothing written. Re-run with --apply to persist.");
  }
}

main().catch((err: unknown) => {
  console.error("\nmigrate-pracenje-sy15 FAILED:", err);
  process.exitCode = 1;
});

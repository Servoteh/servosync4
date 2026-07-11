import { Logger } from "@nestjs/common";
import { alignIdSequence } from "../../../common/db-sequences";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import {
  EntitySyncer,
  SyncCursor,
  SyncEntityResult,
  SyncStrategy,
} from "../sync.types";

/** Minimal Prisma delegate surface the chain-item syncers use. */
export interface ChainItemDelegate {
  count(): Promise<number>;
  deleteMany(args: Record<string, never>): Promise<unknown>;
  upsert(args: {
    where: { id: number };
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * TEMPORARY (P4 spec §5.3): shared engine for the one-time final-import
 * syncers of QBigTehn chain-item tables that have NO generated mapping in
 * `sync-map.generated.ts`:
 *
 *   tPDM                  -> work_order_machined_parts
 *   tPLP                  -> work_order_blanks
 *   tPND                  -> work_order_nonstandard_parts
 *   tSaglasanRN           -> work_order_approvals
 *   PDM_PlaniranjeStavke  -> drawing_plan_items
 *   PrimopredajaPDFCrteza -> drawing_handover_pdfs
 *
 * Follows the `customer.syncer.ts` contract (exhaustive column mapping,
 * skip-ne-abort per row, cursor in `bb_sync_state`) with two deliberate
 * differences justified by the cutover role of these tables:
 *
 * - Every run is a FULL PASS (`defaultStrategy = full_refresh`; the sources
 *   have no `PoslednjaIzmena` watermark) and runs ONLY with `force:true`:
 *   without force the syncer is a no-op even over an EMPTY table (stricter
 *   than the GenericSyncer owned-table rule, per §5.3 "only the final run").
 *   Otherwise the first ordinary all-entities run on a fresh environment
 *   would import the whole legacy history ahead of the cutover freeze.
 *   The real import happens exactly once, during the cutover freeze
 *   (runbook step 3, force/full).
 * - A forced run first does `deleteMany` (all six are LEAF tables — nothing
 *   references them) so the result is an EXACT copy of legacy and the §7.3
 *   verification report can require COUNT/MAX(id) parity. It also removes the
 *   id-collision hazard: native 2.0 rows (autoincrement) may share ids with
 *   legacy rows, and an upsert into a non-empty table could silently
 *   overwrite them (same trap the handover derivation avoids via
 *   `legacy_rn_id`).
 *
 * Unlike the GenericSyncer bulk load, rows are written one by one with FK
 * constraints ENFORCED (no `session_replication_role = replica`): a row whose
 * required parent is missing is SKIPPED and reported, never inserted as an
 * orphan. There are no nullable FK relations on these six models — soft
 * references (e.g. `created_by_worker_id`) are plain Int columns and are
 * copied verbatim; the verification report checks them as soft-FK orphans.
 *
 * Registered in `SyncService` AFTER the map-driven syncers and the handover
 * derivation, so an "all entities" run imports the parents (work_orders,
 * drawing_plans, drawings, drawing_handovers) first. DELETED together with
 * the sync-map split at cutover — see `QBIGTEHN_CHAIN_ENTITIES` in
 * `table-ownership.ts`.
 */
export abstract class LegacyChainItemSyncer<TRefs> implements EntitySyncer {
  abstract readonly entity: string;
  readonly defaultStrategy: SyncStrategy = "full_refresh";
  protected readonly logger = new Logger(this.constructor.name);

  constructor(
    protected readonly mssql: MssqlClient,
    protected readonly prisma: PrismaService,
  ) {}

  /** Full SELECT over every mapped source column (bracket-quoted names). */
  protected abstract selectSql(): string;

  /** Prisma delegate of the target model. */
  protected abstract delegate(): ChainItemDelegate;

  /**
   * Batch pre-resolve of FK target ids (legacy-read rule: two cheap set
   * lookups instead of required JOINs that 500 on orphan references).
   */
  protected abstract resolveRefs(): Promise<TRefs>;

  /**
   * Map one source row to the Prisma shape. Throws -> that ROW is skipped
   * (and reported), the run continues.
   */
  protected abstract mapRow(
    row: Record<string, unknown>,
    refs: TRefs,
  ): { id: number; data: Record<string, unknown> };

  /** Source-side label for skip messages (e.g. `IDStavkePDM=42`). */
  protected abstract rowLabel(row: Record<string, unknown>): string;

  /** Optional per-run note appended to the sync log metadata. */
  protected note(rowsFetched: number): string | undefined {
    void rowsFetched;
    return undefined;
  }

  async sync(options: {
    strategy: SyncStrategy;
    cursor: SyncCursor | null;
    force?: boolean;
  }): Promise<SyncEntityResult> {
    const errors: string[] = [];
    const delegate = this.delegate();

    // §5.3 "only the final run": stricter than the GenericSyncer owned-table
    // protection — without an explicit force the run is a no-op even over an
    // EMPTY table, so an ordinary all-entities run never imports this legacy
    // history ahead of the cutover freeze (runbook step 3, force/full).
    if (!options.force) {
      return {
        entity: this.entity,
        rowsFetched: 0,
        rowsUpserted: 0,
        rowsSkipped: 0,
        newCursor: options.cursor ?? { strategy: "full_refresh" },
        errors: [],
        note: "Preskočeno (§5.3 privremeni syncer): uvozi SAMO uz force:true — jednokratni finalni uvoz na cutover-u.",
      };
    }

    const existing = await delegate.count();

    const rows = await this.mssql.query<Record<string, unknown>>(
      this.selectSql(),
    );
    const refs = await this.resolveRefs();

    // Forced re-import = exact legacy copy: wipe first (leaf table, safe),
    // otherwise colliding native autoincrement ids would be silently
    // overwritten and stale native rows would survive next to legacy ones.
    if (existing > 0) {
      await delegate.deleteMany({});
    }

    let rowsUpserted = 0;
    let rowsSkipped = 0;

    for (const row of rows) {
      try {
        const { id, data } = this.mapRow(row, refs);
        await delegate.upsert({ where: { id }, create: data, update: data });
        rowsUpserted++;
      } catch (err) {
        rowsSkipped++;
        const message = err instanceof Error ? err.message : String(err);
        if (errors.length < 20) {
          errors.push(`${this.rowLabel(row)}: ${message}`);
        }
        this.logger.warn(
          `Skipped ${this.entity} row ${this.rowLabel(row)}: ${message}`,
        );
      }
    }

    // Explicit legacy ids were just written — realign the autoincrement so a
    // native writer over the same table (e.g. work-orders approve() ->
    // work_order_approvals) does not collide on the next `create` (P2002).
    // Same invariant as runbook step 5 (setval) / work-orders alignSeq;
    // `entity` IS the target table name (class contract).
    await alignIdSequence(this.prisma, this.entity);

    return {
      entity: this.entity,
      rowsFetched: rows.length,
      rowsUpserted,
      rowsSkipped,
      newCursor: { strategy: "full_refresh" },
      errors,
      note: this.note(rows.length),
    };
  }

  // --------------------------------------------------------------------
  // Shared scalar coercers (same semantics as customer.syncer.ts).
  // --------------------------------------------------------------------

  protected num(v: unknown): number | null {
    return v === null || v === undefined ? null : Number(v);
  }

  protected str(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    // Not reached for nvarchar sources; defensive for exotic driver types.
    if (v instanceof Date) return v.toISOString();
    return JSON.stringify(v) ?? null;
  }

  protected bool(v: unknown): boolean | null {
    return v === null || v === undefined ? null : Boolean(v);
  }

  protected date(v: unknown): Date | null {
    return v ? new Date(v as string) : null;
  }

  /** Decimal columns: pass through (Prisma accepts number | string | Decimal). */
  protected decimal(v: unknown): unknown {
    return v === null || v === undefined ? null : v;
  }

  /** Assert a required FK parent exists; throws -> row skip. */
  protected requireRef(
    refSet: Set<number> | Set<string>,
    value: number | string,
    label: string,
  ): void {
    if (!(refSet as Set<number | string>).has(value)) {
      throw new Error(
        `${label} ${String(value)} does not exist (skipping row)`,
      );
    }
  }
}

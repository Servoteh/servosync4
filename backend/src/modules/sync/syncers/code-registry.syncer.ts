import { Logger } from "@nestjs/common";
import { MssqlClient } from "../mssql.client";
import {
  EntitySyncer,
  SyncCursor,
  SyncEntityResult,
  SyncStrategy,
} from "../sync.types";

/**
 * Shared behaviour for the tiny QBigTehn item code registries
 * (`R_Grupa` / `R_Podgrupa` / `R_Poreklo`).
 *
 * These three tables have no `PoslednjaIzmena` column, so there is no
 * incremental watermark: the default strategy is `full_refresh` and the
 * requested strategy is ignored (a partial read is impossible anyway).
 *
 * The refresh is a per-row `upsert` on the natural PK (`code`), NOT the generic
 * delete + reinsert: `items.group_code` / `subgroup_code` / `origin_code` carry
 * these codes as plain strings, and a wipe would leave every item pointing at a
 * missing code for the duration of the run. Codes the source dropped are kept —
 * removing them is a deliberate decision, not a sync side effect. Same
 * semantics as the CSV path in `tools/bigbit-bridge/sql/item_*.sql`.
 *
 * Per-row errors are skipped + reported (never abort the whole run), following
 * `customer.syncer.ts`.
 */
export abstract class CodeRegistrySyncer<
  TRow extends { code: string },
> implements EntitySyncer {
  /** Target Postgres table = `bb_sync_state.entity` key. */
  abstract readonly entity: string;
  readonly defaultStrategy: SyncStrategy = "full_refresh";
  protected readonly logger = new Logger(this.constructor.name);

  /** Source table in the QBigTehn `dbo` schema. */
  protected abstract readonly sourceTable: string;
  /** Source columns to select (bracket-quoted — QBigTehn names may have spaces). */
  protected abstract readonly sourceColumns: readonly string[];
  /** Source PK column: deterministic read order + error labels. */
  protected abstract readonly sourceKeyColumn: string;

  protected constructor(protected readonly mssql: MssqlClient) {}

  /** Map one source row to the Prisma shape of the target model. */
  protected abstract mapRow(r: Record<string, unknown>): TRow;

  /** Upsert one mapped row by `code`. */
  protected abstract upsert(data: TRow): Promise<unknown>;

  async sync(options: {
    strategy: SyncStrategy;
    cursor: SyncCursor | null;
  }): Promise<SyncEntityResult> {
    const errors: string[] = [];
    const cols = this.sourceColumns.map((c) => `[${c}]`).join(", ");
    const rows = await this.mssql.query<Record<string, unknown>>(
      `SELECT ${cols} FROM [dbo].[${this.sourceTable}] ORDER BY [${this.sourceKeyColumn}] ASC`,
    );

    let rowsUpserted = 0;
    let rowsSkipped = 0;

    for (const row of rows) {
      const label = `${this.sourceKeyColumn}=${CodeRegistrySyncer.reqStr(
        row[this.sourceKeyColumn],
      )}`;
      try {
        await this.upsert(this.mapRow(row));
        rowsUpserted++;
      } catch (err) {
        rowsSkipped++;
        const message = err instanceof Error ? err.message : String(err);
        if (errors.length < 20) errors.push(`${label}: ${message}`);
        this.logger.warn(`Skipped ${this.entity} ${label}: ${message}`);
      }
    }

    return {
      entity: this.entity,
      rowsFetched: rows.length,
      rowsUpserted,
      rowsSkipped,
      newCursor: { strategy: "full_refresh" },
      errors,
      // Ne ćuti kad neko zatraži inkrementalni prolaz: izvor nema watermark,
      // pa je odrađen pun prolaz — to mora da se vidi u `bb_sync_log`.
      ...(options.strategy === "incremental"
        ? {
            note: `Izvor (${this.sourceTable}) nema kolonu PoslednjaIzmena — traženi inkrementalni prolaz je izvršen kao pun refresh (upsert po šifri).`,
          }
        : {}),
    };
  }

  /**
   * Required source string. Source columns are NOT NULL nvarchar, so anything
   * else is a broken row; `''` keeps the mapper total and lets the per-row
   * guards (PK below) decide what to do about it.
   */
  protected static reqStr(v: unknown): string {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return "";
  }

  /**
   * Source primary key. An empty PK cannot be upserted meaningfully (it would
   * create a junk `''` code), so it throws: the row is skipped + reported like
   * any other bad row, and the rest of the registry still lands.
   */
  protected static reqCode(v: unknown, column: string): string {
    const s = CodeRegistrySyncer.reqStr(v).trim();
    if (s === "") throw new Error(`empty [${column}] in source row`);
    return s;
  }

  /**
   * Optional source code. BigBit stores "no parent" as the literal `'0'`, and
   * the Prisma defaults do the same — mirror that instead of writing NULL, so
   * both import paths (this syncer and the CSV bridge) agree.
   */
  protected static codeOrZero(v: unknown): string {
    const s = CodeRegistrySyncer.reqStr(v).trim();
    return s === "" ? "0" : s;
  }
}

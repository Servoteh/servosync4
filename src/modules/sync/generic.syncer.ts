import { PrismaService } from '../../prisma/prisma.service';
import { MssqlClient } from './mssql.client';
import {
  ColumnMapping,
  EntitySyncer,
  SyncCursor,
  SyncEntityResult,
  SyncStrategy,
  TableMapping,
} from './sync.types';

/**
 * Data-driven syncer for one QBigTehn table -> one Prisma model.
 *
 * Column names, types, PK and the incremental watermark all come from
 * `sync-map.generated.ts` (built from docs/schema-rename-map.md + Prisma DMMF),
 * so a single implementation covers every mapped table.
 *
 * - full_refresh: `deleteMany` + chunked `createMany`, wrapped in a transaction
 *   with `session_replication_role = replica` so FK constraints don't block the
 *   bulk load (order-independent; the source is the single source of truth).
 * - incremental: per-row `upsert` filtered by `PoslednjaIzmena > cursor`.
 */
export class GenericSyncer implements EntitySyncer {
  readonly entity: string;
  readonly defaultStrategy: SyncStrategy;
  private readonly delegateName: string;

  constructor(
    private readonly mapping: TableMapping,
    private readonly mssql: MssqlClient,
    private readonly prisma: PrismaService,
  ) {
    this.entity = mapping.targetDb;
    this.defaultStrategy = mapping.watermark ? 'incremental' : 'full_refresh';
    // Prisma client delegate = model name with a lower-cased first letter.
    this.delegateName = mapping.model[0].toLowerCase() + mapping.model.slice(1);
  }

  async sync(options: {
    strategy: SyncStrategy;
    cursor: SyncCursor | null;
  }): Promise<SyncEntityResult> {
    const errors: string[] = [];
    const incremental =
      options.strategy === 'incremental' &&
      !!this.mapping.watermark &&
      !!options.cursor?.lastModifiedAt;

    // Select only the mapped columns (bracket-quoted; QBigTehn names have spaces).
    const cols = this.mapping.columns.map((c) => `[${c.src}]`).join(', ');
    const where = incremental ? 'WHERE [PoslednjaIzmena] > @cursor' : '';
    const order = this.mapping.watermark ? 'ORDER BY [PoslednjaIzmena] ASC' : '';
    const rows = await this.mssql.query<Record<string, unknown>>(
      `SELECT ${cols} FROM [dbo].[${this.mapping.source}] ${where} ${order}`,
      incremental ? { cursor: new Date(options.cursor!.lastModifiedAt!) } : {},
    );

    const data = rows.map((r) => this.mapRow(r));

    // Track the newest watermark seen so the next run can go incremental.
    let maxModified: Date | null = options.cursor?.lastModifiedAt
      ? new Date(options.cursor.lastModifiedAt)
      : null;
    if (this.mapping.watermark) {
      for (const d of data) {
        const v = d[this.mapping.watermark] as Date | null;
        if (v && (!maxModified || v > maxModified)) maxModified = v;
      }
    }

    let rowsUpserted = 0;
    let rowsSkipped = 0;

    if (incremental) {
      const delegate = this.delegate();
      for (const d of data) {
        try {
          await delegate.upsert({
            where: this.pkWhere(d),
            create: d,
            update: d,
          });
          rowsUpserted++;
        } catch (err) {
          rowsSkipped++;
          const message = err instanceof Error ? err.message : String(err);
          if (errors.length < 20) errors.push(`${this.pkLabel(d)}: ${message}`);
        }
      }
    } else {
      // Full refresh: wipe + bulk insert with FK enforcement disabled.
      // Binary (Bytes) columns can be many MB each; a big chunk would serialize
      // into a query string past V8's max length, so cap those tables hard.
      const hasBytes = this.mapping.columns.some((c) => c.type === 'Bytes');
      const chunkSize = hasBytes
        ? 5
        : Math.max(
            1,
            Math.min(5000, Math.floor(60000 / Math.max(1, this.mapping.columns.length))),
          );
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            "SET LOCAL session_replication_role = 'replica'",
          );
          const del = (tx as Record<string, any>)[this.delegateName];
          await del.deleteMany({});
          for (let i = 0; i < data.length; i += chunkSize) {
            await del.createMany({ data: data.slice(i, i + chunkSize) });
          }
        },
        { timeout: 20 * 60 * 1000, maxWait: 30 * 1000 },
      );
      rowsUpserted = data.length;
    }

    const newCursor: SyncCursor = this.mapping.watermark
      ? { lastModifiedAt: (maxModified ?? new Date()).toISOString() }
      : { strategy: 'full_refresh' };

    return {
      entity: this.entity,
      rowsFetched: rows.length,
      rowsUpserted,
      rowsSkipped,
      newCursor,
      errors,
    };
  }

  private delegate(): any {
    return (this.prisma as unknown as Record<string, any>)[this.delegateName];
  }

  /** Build the Prisma `where` for an upsert from the mapped row's PK field(s). */
  private pkWhere(d: Record<string, unknown>): Record<string, unknown> {
    const pk = this.mapping.pk;
    if (!pk) throw new Error(`No primary key mapped for ${this.entity}`);
    if (pk.kind === 'single') return { [pk.field]: d[pk.field] };
    const composite: Record<string, unknown> = {};
    for (const f of pk.fields) composite[f] = d[f];
    return { [pk.name]: composite };
  }

  private pkLabel(d: Record<string, unknown>): string {
    const pk = this.mapping.pk;
    if (!pk) return '?';
    const fields = pk.kind === 'single' ? [pk.field] : pk.fields;
    return fields.map((f) => `${f}=${String(d[f])}`).join(',');
  }

  /** Map + type-coerce a single source row into the Prisma shape. */
  private mapRow(r: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of this.mapping.columns) out[c.field] = this.coerce(r[c.src], c);
    return out;
  }

  private coerce(value: unknown, col: ColumnMapping): unknown {
    if (value === null || value === undefined) return null;
    switch (col.type) {
      case 'Int':
        return typeof value === 'number' ? Math.trunc(value) : Number(value);
      case 'BigInt':
        return typeof value === 'bigint' ? value : BigInt(value as never);
      case 'Float':
        return Number(value);
      case 'Decimal':
        // Prisma accepts number | string | Decimal; pass through.
        return value;
      case 'Boolean':
        return typeof value === 'boolean' ? value : Boolean(value);
      case 'DateTime':
        return value instanceof Date ? value : new Date(value as string);
      case 'String':
        return typeof value === 'string' ? value : String(value);
      case 'Bytes':
      case 'Json':
      default:
        return value;
    }
  }
}

/** Per-entity sync strategy. */
export type SyncStrategy = 'incremental' | 'full_refresh';

/** One mapped column: source (QBigTehn) -> Prisma field, with scalar type info. */
export interface ColumnMapping {
  /** Source column name in QBigTehn (may contain spaces). */
  src: string;
  /** Prisma model field name. */
  field: string;
  /** Prisma scalar type (Int, String, Boolean, DateTime, Decimal, BigInt, ...). */
  type: string;
  nullable: boolean;
  isId: boolean;
}

/** Primary key of a target model — single `@id` or composite `@@id`. */
export type PkMapping =
  | { kind: 'single'; field: string }
  | { kind: 'composite'; fields: string[]; name: string };

/** One source table -> one Prisma model, fully described for the generic engine. */
export interface TableMapping {
  /** Source table name in QBigTehn (dbo schema). */
  source: string;
  /** Prisma model name (PascalCase). */
  model: string;
  /** Postgres table name (@@map) — also used as the sync entity key. */
  targetDb: string;
  pk: PkMapping | null;
  /** Prisma field mapped from `PoslednjaIzmena`, if the source has that column. */
  watermark: string | null;
  columns: ColumnMapping[];
}

/** Opaque cursor persisted in `bb_sync_state.cursor`. */
export interface SyncCursor {
  /** ISO timestamp of the last `PoslednjaIzmena` processed (incremental). */
  lastModifiedAt?: string;
  /** Marker for full-refresh entities. */
  strategy?: 'full_refresh';
}

/** Result of syncing a single entity. */
export interface SyncEntityResult {
  entity: string;
  rowsFetched: number;
  rowsUpserted: number;
  rowsSkipped: number;
  newCursor: SyncCursor | null;
  errors: string[];
}

/**
 * One entity syncer = one BigBit table -> one Postgres table.
 * Each syncer owns its column mapping, upsert key and cursor logic.
 */
export interface EntitySyncer {
  /** Stable key, also used as `bb_sync_state.entity` (e.g. "customers"). */
  readonly entity: string;
  readonly defaultStrategy: SyncStrategy;

  sync(options: {
    strategy: SyncStrategy;
    cursor: SyncCursor | null;
  }): Promise<SyncEntityResult>;
}

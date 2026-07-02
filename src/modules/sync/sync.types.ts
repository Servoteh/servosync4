/** Per-entity sync strategy. */
export type SyncStrategy = 'incremental' | 'full_refresh';

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

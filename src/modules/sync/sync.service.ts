import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MssqlClient } from './mssql.client';
import { CustomerSyncer } from './syncers/customer.syncer';
import { GenericSyncer } from './generic.syncer';
import { SYNC_MAP } from './sync-map.generated';
import { EntitySyncer, SyncCursor, SyncStrategy } from './sync.types';

export interface RunSyncOptions {
  entities?: string[];
  strategy?: SyncStrategy;
  trigger?: 'manual' | 'cron' | 'api';
  triggeredByUserId?: number;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly syncers = new Map<string, EntitySyncer>();

  /** Simple in-process guard so two sync runs never overlap. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mssql: MssqlClient,
    customerSyncer: CustomerSyncer,
  ) {
    // Hand-written syncers take precedence (e.g. customers has bespoke FK logic).
    this.register(customerSyncer);
    // Generic, map-driven syncers for every other mapped table.
    for (const mapping of SYNC_MAP) {
      if (this.syncers.has(mapping.targetDb)) continue;
      this.register(new GenericSyncer(mapping, this.mssql, this.prisma));
    }
  }

  private register(syncer: EntitySyncer): void {
    this.syncers.set(syncer.entity, syncer);
  }

  /** Compact `entity_scope` label — the column is VarChar(100). */
  private describeScope(requested: string[]): string {
    if (requested.length === this.availableEntities.length) {
      return `ALL (${requested.length})`;
    }
    const joined = requested.join(',');
    return joined.length <= 100 ? joined : `${joined.slice(0, 90)}… (${requested.length})`;
  }

  get availableEntities(): string[] {
    return [...this.syncers.keys()];
  }

  /**
   * Run a sync for the given entities (default: all registered).
   * Creates one `bb_sync_log` row and advances `bb_sync_state` per entity.
   */
  async run(options: RunSyncOptions = {}) {
    if (this.running) {
      throw new ConflictException('A sync run is already in progress');
    }

    const requested = options.entities?.length
      ? options.entities
      : this.availableEntities;

    const unknown = requested.filter((e) => !this.syncers.has(e));
    if (unknown.length) {
      throw new NotFoundException(`Unknown entities: ${unknown.join(', ')}`);
    }

    this.running = true;
    const log = await this.prisma.bbSyncLog.create({
      data: {
        status: 'running',
        trigger: options.trigger ?? 'manual',
        triggeredByUserId: options.triggeredByUserId ?? null,
        entityScope: this.describeScope(requested),
      },
    });

    let totalFetched = 0;
    let totalUpserted = 0;
    let totalSkipped = 0;
    let failures = 0;
    const perEntity: Record<string, unknown> = {};

    try {
      for (const entity of requested) {
        const syncer = this.syncers.get(entity)!;
        const strategy = options.strategy ?? syncer.defaultStrategy;
        const state = await this.prisma.bbSyncState.findUnique({
          where: { entity },
        });
        const cursor = (state?.cursor as SyncCursor | null) ?? null;

        try {
          const result = await syncer.sync({ strategy, cursor });
          totalFetched += result.rowsFetched;
          totalUpserted += result.rowsUpserted;
          totalSkipped += result.rowsSkipped;
          perEntity[entity] = {
            rowsFetched: result.rowsFetched,
            rowsUpserted: result.rowsUpserted,
            rowsSkipped: result.rowsSkipped,
          };

          await this.prisma.bbSyncState.upsert({
            where: { entity },
            create: {
              entity,
              cursor: result.newCursor as Prisma.InputJsonValue,
              lastAttemptAt: new Date(),
              lastSuccessAt: new Date(),
              lastSuccessSyncLogId: log.id,
              lastErrorMessage: null,
            },
            update: {
              cursor: result.newCursor as Prisma.InputJsonValue,
              lastAttemptAt: new Date(),
              lastSuccessAt: new Date(),
              lastSuccessSyncLogId: log.id,
              lastErrorMessage: null,
            },
          });

          if (result.rowsSkipped > 0) failures++;
        } catch (err) {
          failures++;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`Entity ${entity} failed: ${message}`);
          perEntity[entity] = { error: message };
          await this.prisma.bbSyncState.upsert({
            where: { entity },
            create: {
              entity,
              lastAttemptAt: new Date(),
              lastErrorMessage: message,
            },
            update: { lastAttemptAt: new Date(), lastErrorMessage: message },
          });
        }
      }

      const status =
        failures === 0
          ? 'success'
          : failures < requested.length
            ? 'partial'
            : 'failed';

      return this.prisma.bbSyncLog.update({
        where: { id: log.id },
        data: {
          status,
          finishedAt: new Date(),
          rowsFetched: totalFetched,
          rowsUpserted: totalUpserted,
          rowsSkipped: totalSkipped,
          metadata: perEntity as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.prisma.bbSyncLog.update({
        where: { id: log.id },
        data: { status: 'failed', finishedAt: new Date(), errorMessage: message },
      });
    } finally {
      this.running = false;
    }
  }

  getState() {
    return this.prisma.bbSyncState.findMany({ orderBy: { entity: 'asc' } });
  }

  async getEntityState(entity: string) {
    const state = await this.prisma.bbSyncState.findUnique({
      where: { entity },
    });
    if (!state) throw new NotFoundException(`No sync state for "${entity}"`);
    return state;
  }

  getLogs(limit = 50) {
    return this.prisma.bbSyncLog.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(limit, 200),
    });
  }

  async getLog(id: number) {
    const log = await this.prisma.bbSyncLog.findUnique({ where: { id } });
    if (!log) throw new NotFoundException(`Sync log ${id} not found`);
    return log;
  }

  async health() {
    const mssql = await this.mssql.healthCheck();
    return {
      source: mssql.ok ? 'up' : 'down',
      sqlServerVersion: mssql.version,
      error: mssql.error,
      entities: this.availableEntities,
    };
  }
}

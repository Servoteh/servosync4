import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as sql from 'mssql';

/**
 * Read-only client for the legacy BigBit / QBigTehn SQL Server.
 *
 * The sync direction is strictly one-way (QBigTehn -> Postgres); this client
 * therefore only ever issues SELECTs. Connection details come from the
 * `BIGBIT_DB_*` environment variables (see `.env.example`).
 */
@Injectable()
export class MssqlClient implements OnModuleDestroy {
  private readonly logger = new Logger(MssqlClient.name);
  private pool?: sql.ConnectionPool;
  private connecting?: Promise<sql.ConnectionPool>;

  private buildConfig(): sql.config {
    return {
      server: process.env.BIGBIT_DB_HOST ?? 'localhost',
      port: Number(process.env.BIGBIT_DB_PORT) || 1433,
      database: process.env.BIGBIT_DB_NAME ?? 'QBigTehn',
      user: process.env.BIGBIT_DB_USER,
      password: process.env.BIGBIT_DB_PASSWORD,
      requestTimeout: Number(process.env.BIGBIT_DB_REQUEST_TIMEOUT_MS) || 30000,
      connectionTimeout: 15000,
      pool: {
        max: Number(process.env.BIGBIT_DB_POOL_MAX) || 5,
        min: 0,
        idleTimeoutMillis: 30000,
      },
      options: {
        encrypt: process.env.BIGBIT_DB_ENCRYPT === 'true',
        trustServerCertificate:
          process.env.BIGBIT_DB_TRUST_SERVER_CERT !== 'false',
      },
    };
  }

  /** Lazily create (and reuse) a single connection pool. */
  private async getPool(): Promise<sql.ConnectionPool> {
    if (this.pool?.connected) return this.pool;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      try {
        const pool = new sql.ConnectionPool(this.buildConfig());
        pool.on('error', (err) =>
          this.logger.error(`MSSQL pool error: ${err.message}`),
        );
        await pool.connect();
        this.pool = pool;
        this.logger.log(
          `Connected to BigBit/QBigTehn at ${process.env.BIGBIT_DB_HOST}:${process.env.BIGBIT_DB_PORT}`,
        );
        return pool;
      } catch (err) {
        this.connecting = undefined;
        const message = err instanceof Error ? err.message : String(err);
        throw new ServiceUnavailableException(
          `Cannot connect to BigBit SQL Server: ${message}`,
        );
      }
    })();

    return this.connecting;
  }

  /**
   * Run a parameterised SELECT against the source DB.
   * Params are bound by name (e.g. `@cursor`) to avoid SQL injection.
   */
  async query<T = Record<string, unknown>>(
    sqlText: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const pool = await this.getPool();
    const request = pool.request();
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value);
    }
    const result = await request.query<T>(sqlText);
    return result.recordset;
  }

  /** Lightweight connectivity probe used by the /sync/health endpoint. */
  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const rows = await this.query<{ version: string }>(
        'SELECT @@VERSION AS version',
      );
      return { ok: true, version: rows[0]?.version };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = undefined;
    }
  }
}

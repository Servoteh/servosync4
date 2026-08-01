import sql from 'mssql';

import { config } from '../config.js';
import { logger } from '../logger.js';

let _pool = null;
let _connecting = null;

const sqlConfig = {
  server: config.bigtehn.server,
  port: config.bigtehn.port,
  database: config.bigtehn.database,
  user: config.bigtehn.user,
  password: config.bigtehn.password,
  options: {
    encrypt: config.bigtehn.encrypt,
    trustServerCertificate: config.bigtehn.trustServerCertificate,
    enableArithAbort: true,
  },
  requestTimeout: config.bigtehn.requestTimeout,
  connectionTimeout: config.bigtehn.connectionTimeout,
  pool: {
    min: config.bigtehn.poolMin,
    max: config.bigtehn.poolMax,
    idleTimeoutMillis: 30_000,
  },
};

/**
 * Vraća singleton pool. Ako pool nije konektovan, čeka konekciju.
 * Ako konekcija padne, sledeći poziv pravi novi pool.
 */
export async function getSqlPool() {
  if (_pool && _pool.connected) return _pool;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    try {
      logger.info(
        { server: config.bigtehn.server, db: config.bigtehn.database, user: config.bigtehn.user },
        '[sqlserver] connecting',
      );
      const pool = new sql.ConnectionPool(sqlConfig);
      pool.on('error', (err) => {
        logger.error({ err }, '[sqlserver] pool error');
      });
      await pool.connect();
      _pool = pool;
      logger.info('[sqlserver] connected');
      return pool;
    } catch (err) {
      logger.error({ err }, '[sqlserver] connection failed');
      _pool = null;
      throw err;
    } finally {
      _connecting = null;
    }
  })();

  return _connecting;
}

export async function closeSqlPool() {
  if (_pool) {
    try {
      await _pool.close();
      logger.info('[sqlserver] pool closed');
    } catch (err) {
      logger.warn({ err }, '[sqlserver] pool close failed');
    } finally {
      _pool = null;
    }
  }
}

/**
 * Helper: izvrši SELECT i vrati `recordset` (niz redova kao plain objekti).
 *
 * @param {string} text - SQL query string
 * @param {Record<string, {type: any, value: any}> | Record<string, any>} [params]
 *        Optional parametri za prepared statement. Dva oblika:
 *
 *        1) Eksplicitan tip:
 *           { watermark: { type: sql.DateTime, value: new Date() } }
 *
 *        2) Auto-detect (tip se izvodi iz JS tipa — preporučeno samo za
 *           jednostavne slučajeve):
 *           { watermark: new Date() }
 */
export async function runQuery(text, params) {
  const pool = await getSqlPool();
  const request = pool.request();
  if (params && typeof params === 'object') {
    for (const [name, raw] of Object.entries(params)) {
      if (raw && typeof raw === 'object' && 'type' in raw && 'value' in raw) {
        request.input(name, raw.type, raw.value);
      } else {
        request.input(name, raw);
      }
    }
  }
  const result = await request.query(text);
  return result.recordset || [];
}

export { sql };

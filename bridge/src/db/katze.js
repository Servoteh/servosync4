import sql from 'mssql';

import { config } from '../config.js';
import { logger } from '../logger.js';

/* Drugi MSSQL server: Katze (KatzeReports) evidencija radnog vremena na
   192.168.64.10, baza `Servoteh` (ŽIVA — KR7_Calc je kopija za proračun).
   Namerno odvojen singleton od db/sqlserver.js (BigTehn) da se postojeći
   jobovi ne diraju. Nalog: servosync_ro (db_datareader, samo čitanje). */

const katzeConfig = {
  server: config.katze.server,
  port: config.katze.port,
  database: config.katze.database,
  user: config.katze.user,
  password: config.katze.password,
  options: {
    encrypt: config.katze.encrypt,
    trustServerCertificate: config.katze.trustServerCertificate,
    enableArithAbort: true,
    /* SQL 2008 R2 čuva lokalno beogradsko vreme kao DATETIME bez zone;
       useUTC:true daje wall-time u UTC poljima JS Date-a (determinističko). */
    useUTC: true,
    readOnlyIntent: true,
  },
  requestTimeout: config.katze.requestTimeout,
  connectionTimeout: config.katze.connectionTimeout,
  pool: { min: config.katze.poolMin, max: config.katze.poolMax, idleTimeoutMillis: 30_000 },
};

let _pool = null;
let _connecting = null;

export async function getKatzePool() {
  if (_pool && _pool.connected) return _pool;
  if (_connecting) return _connecting;
  if (!config.katze.server) {
    throw new Error('[katze] KATZE_SQL_SERVER nije podešen (vidi .env.example, ENABLE_JOB_KATZE)');
  }
  _connecting = (async () => {
    try {
      logger.info(
        { server: config.katze.server, db: config.katze.database, user: config.katze.user },
        '[katze] connecting',
      );
      const pool = new sql.ConnectionPool(katzeConfig);
      pool.on('error', (err) => {
        logger.error({ err }, '[katze] pool error');
      });
      await pool.connect();
      _pool = pool;
      logger.info('[katze] connected');
      return pool;
    } catch (err) {
      logger.error({ err }, '[katze] connection failed');
      throw err;
    } finally {
      _connecting = null;
    }
  })();
  return _connecting;
}

export async function runKatzeQuery(text, params) {
  const pool = await getKatzePool();
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

export async function closeKatzePool() {
  if (!_pool) return;
  try {
    await _pool.close();
    _pool = null;
    logger.info('[katze] pool closed');
  } catch (err) {
    logger.warn({ err }, '[katze] pool close failed');
  }
}

export { sql };

import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncPositions');

/**
 * Katalog pozicija (polica/destinacija za smeštaj delova) iz BigTehn-a.
 * Sadrži kodove kao K-A1, K-A2, K-S (škart) itd.
 *
 * Mali katalog (~20-50 redova). Referenciran iz tLokacijeDelova.IDPozicija
 * (transakcioni log kretanja delova). U BIGTEHN_DATA_MAP.md sekcija 3.1
 * je netačno tvrdila da su K-A1/K-S kodovi u tLokacijeDelova — zapravo
 * su u tPozicije.
 *
 * tPozicije shema (potvrđeno discover-om):
 *   IDPozicije  int           PK
 *   Pozicija    nvarchar(20)        -- npr. "K-A1", "K-S"
 *   Opis        nvarchar(250)       -- npr. "FARBANJE", "ŠKART"
 */
const SQL = `
  SELECT
    IDPozicije                  AS id,
    LTRIM(RTRIM(Pozicija))      AS code,
    LTRIM(RTRIM(Opis))          AS description
  FROM tPozicije
  WHERE IDPozicije IS NOT NULL;
`;

function mapRow(row) {
  return {
    id: row.id,
    code: row.code || `(poz-${row.id})`,
    description: row.description || null,
    synced_at: new Date().toISOString(),
  };
}

export async function syncPositions() {
  const run = await startRun('catalog_positions');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    log.info({ count: rows.length }, 'fetched from BigTehn');

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_positions_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

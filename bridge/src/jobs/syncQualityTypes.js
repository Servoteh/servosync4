import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncQualityTypes');

/**
 * Katalog vrsta kvaliteta delova iz BigTehn-a.
 * Mali lookup (~10 redova). Referenciran iz:
 *   - tRN.IDVrstaKvaliteta
 *   - tTehPostupak.IDVrstaKvaliteta
 *   - tLokacijeDelova.IDVrstaKvaliteta (transakcioni log kretanja delova)
 *
 * tVrsteKvalitetaDelova shema (potvrđeno discover-om):
 *   IDVrstaKvaliteta  int           PK
 *   VrstaKvaliteta    nvarchar(50)
 */
const SQL = `
  SELECT
    IDVrstaKvaliteta                AS id,
    LTRIM(RTRIM(VrstaKvaliteta))    AS name
  FROM tVrsteKvalitetaDelova
  WHERE IDVrstaKvaliteta IS NOT NULL;
`;

function mapRow(row) {
  return {
    id: row.id,
    name: row.name || '(bez naziva)',
    synced_at: new Date().toISOString(),
  };
}

export async function syncQualityTypes() {
  const run = await startRun('catalog_quality_types');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    log.info({ count: rows.length }, 'fetched from BigTehn');

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_quality_types_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

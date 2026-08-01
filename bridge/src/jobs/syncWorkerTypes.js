import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncWorkerTypes');

/**
 * Katalog vrsta radnika iz BigTehn-a.
 * Mali lookup (~5 redova). Referenciran iz tRadnici.IDVrsteRadnika.
 *
 * tVrsteRadnika shema (potvrđeno discover-om):
 *   IDVrsteRadnika    int           PK
 *   VrstaRadnika      nvarchar(50)
 *   DodatnaOvlascenja bit           default 0
 */
const SQL = `
  SELECT
    IDVrsteRadnika                AS id,
    LTRIM(RTRIM(VrstaRadnika))    AS name,
    ISNULL(DodatnaOvlascenja, 0)  AS has_extra_auth
  FROM tVrsteRadnika
  WHERE IDVrsteRadnika IS NOT NULL;
`;

function mapRow(row) {
  return {
    id: row.id,
    name: row.name || '(bez naziva)',
    has_extra_auth: !!row.has_extra_auth,
    synced_at: new Date().toISOString(),
  };
}

export async function syncWorkerTypes() {
  const run = await startRun('catalog_worker_types');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    log.info({ count: rows.length }, 'fetched from BigTehn');

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_worker_types_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

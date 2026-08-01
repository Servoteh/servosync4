import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncDepartments');

const SQL = `
  SELECT
    LTRIM(RTRIM(IDRadneJedinice))  AS id,
    LTRIM(RTRIM(RadnaJedinica))    AS name
  FROM tRadneJedinice
  WHERE IDRadneJedinice IS NOT NULL
    AND LTRIM(RTRIM(IDRadneJedinice)) <> '';
`;

function mapRow(row) {
  return {
    id: row.id,
    name: row.name || '(bez naziva)',
    synced_at: new Date().toISOString(),
  };
}

export async function syncDepartments() {
  const run = await startRun('catalog_departments');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    log.info({ count: rows.length }, 'fetched from BigTehn');

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_departments_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncMachines');

/**
 * Napomena o RJgrupaRC: vrednosti tipa "2.5", "3.31", "6.1.1" su STRING (ne broj).
 * Sortiranje radimo u app sloju kasnije (natural sort), ovde ostavljamo redosled
 * iz baze.
 */
const SQL = `
  SELECT
    o.IDOperacije                          AS operation_id,
    LTRIM(RTRIM(o.RJgrupaRC))              AS rj_code,
    LTRIM(RTRIM(o.NazivGrupeRC))           AS name,
    LTRIM(RTRIM(o.IDRadneJedinice))        AS department_id,
    o.Napomena                             AS note,
    ISNULL(o.BezPostupka, 0)                       AS no_procedure,
    ISNULL(o.ZnacajneOperacijeZaZavrsen, 0)        AS significant_for_completion,
    ISNULL(o.KoristiPrioritet, 0)                  AS uses_priority,
    ISNULL(o.PreskocivaOperacija, 0)               AS skippable
  FROM tOperacije o
  WHERE o.RJgrupaRC IS NOT NULL
    AND LTRIM(RTRIM(o.RJgrupaRC)) <> '';
`;

function mapRow(row) {
  return {
    rj_code: row.rj_code,
    name: row.name || '(bez naziva)',
    department_id: row.department_id || null,
    operation_id: row.operation_id,
    note: row.note,
    no_procedure: !!row.no_procedure,
    significant_for_completion: !!row.significant_for_completion,
    uses_priority: !!row.uses_priority,
    skippable: !!row.skippable,
    synced_at: new Date().toISOString(),
  };
}

export async function syncMachines() {
  const run = await startRun('catalog_machines');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    log.info({ count: rows.length }, 'fetched from BigTehn');

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_machines_cache', payload, 'rj_code');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

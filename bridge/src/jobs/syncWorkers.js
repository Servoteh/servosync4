import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncWorkers');

/**
 * KRITIČNO (sekcija 6.6 BIGTEHN_DATA_MAP.md):
 *   tRadnici sadrži plaintext kolone Password i PasswordRadnika.
 *   Ovaj SELECT ih EKSPLICITNO NE čita. Nikada ne dodavati.
 */
/* department_id: BigTehn NEMA FK integritet — radnik može da nosi šifru radne
   jedinice koja ne postoji u tRadneJedinice (obarala je FK na
   bigtehn_workers_cache svakodnevno od 30.06). LEFT JOIN → NULL za nepostojeće. */
const SQL = `
  SELECT
    r.SifraRadnika                        AS id,
    LTRIM(RTRIM(r.ImeIPrezime))           AS full_name,
    LTRIM(RTRIM(r.Radnik))                AS short_name,
    CASE WHEN rj.IDRadneJedinice IS NULL THEN NULL
         ELSE LTRIM(RTRIM(r.IDRadneJedinice)) END AS department_id,
    CASE WHEN rj.IDRadneJedinice IS NULL
          AND LTRIM(RTRIM(ISNULL(r.IDRadneJedinice, ''))) <> '' THEN 1
         ELSE 0 END                       AS department_missing,
    LTRIM(RTRIM(r.IDKartice))             AS card_id,
    r.IDVrsteRadnika                      AS worker_type_id,
    ISNULL(r.Aktivan, 0)                  AS is_active
  FROM tRadnici r
  LEFT JOIN tRadneJedinice rj
    ON LTRIM(RTRIM(rj.IDRadneJedinice)) = LTRIM(RTRIM(r.IDRadneJedinice))
  WHERE r.SifraRadnika IS NOT NULL;
`;

function mapRow(row) {
  return {
    id: row.id,
    full_name: row.full_name || row.short_name || '(bez imena)',
    short_name: row.short_name || null,
    department_id: row.department_id || null,
    card_id: row.card_id || null,
    worker_type_id: row.worker_type_id ?? null,
    is_active: !!row.is_active,
    synced_at: new Date().toISOString(),
  };
}

export async function syncWorkers() {
  const run = await startRun('catalog_workers');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    const missingDept = rows.filter((r) => r.department_missing).length;
    log.info({ count: rows.length, active: rows.filter((r) => r.is_active).length, missingDept }, 'fetched');
    if (missingDept > 0) {
      log.warn({ missingDept }, 'radnici sa nepostojećom radnom jedinicom u BigTehn (department_id → NULL)');
    }

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_workers_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

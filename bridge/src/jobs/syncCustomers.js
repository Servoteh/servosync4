import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncCustomers');

/**
 * Po dokumentu: koristimo samo 5 kolona iz Komitenti tabele.
 * Filter: skidamo SVE komitente — komitent može biti referenciran sa starog RN-a
 * pa je sigurnije imati ceo katalog (~par hiljada redova maksimum).
 */
const SQL = `
  SELECT
    Sifra                       AS id,
    LTRIM(RTRIM(Naziv))         AS name,
    LTRIM(RTRIM(SkraceniNaziv)) AS short_name,
    LTRIM(RTRIM(Mesto))         AS city,
    LTRIM(RTRIM(PIB))           AS tax_id
  FROM Komitenti
  WHERE Sifra IS NOT NULL;
`;

function mapRow(row) {
  return {
    id: row.id,
    name: row.name || '(bez naziva)',
    short_name: row.short_name || null,
    city: row.city || null,
    tax_id: row.tax_id || null,
    synced_at: new Date().toISOString(),
  };
}

export async function syncCustomers() {
  const run = await startRun('catalog_customers');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    log.info({ count: rows.length }, 'fetched from BigTehn');

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_customers_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

import { runQuery, sql } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';
import { getWatermark } from './watermark.js';

const log = logJob('syncWorkOrderApprovals');
const JOB_NAME = 'production_work_order_approvals';

/**
 * Saglasnost na radne naloge (tSaglasanRN) — audit ko je i kad dao
 * saglasnost na RN. Incremental sync po DIVIspravke.
 *
 * Mali job (<10 redova po runu tipično). Bitno za UI da pokaže status
 * "saglasan" i ko ga je odobrio.
 *
 * tSaglasanRN shema (potvrđeno discover-om):
 *   IDSaglasan           int           PK
 *   IDRN                 int                       -- FK -> bigtehn_work_orders_cache
 *   Saglasan             bit
 *   DatumUnosa           datetime
 *   DIVUnos              datetime                  -- created_at
 *   SifraRadnikaUnos     int                       -- ko je dao saglasnost
 *   PotpisUnos           nvarchar(50)
 *   DIVIspravke          datetime                  -- ← WATERMARK
 *   SifraRadnikaIspravka int
 *   PotpisIspravka       nvarchar(50)
 */
const SQL = `
  SELECT
    IDSaglasan                          AS id,
    IDRN                                AS work_order_id,
    ISNULL(Saglasan, 0)                 AS saglasan,
    DatumUnosa                          AS datum_unosa,
    DIVUnos                             AS created_at,
    NULLIF(SifraRadnikaUnos, 0)         AS author_worker_id,
    LTRIM(RTRIM(PotpisUnos))            AS potpis_unos,
    DIVIspravke                         AS modified_at,
    NULLIF(SifraRadnikaIspravka, 0)     AS modifier_worker_id,
    LTRIM(RTRIM(PotpisIspravka))        AS potpis_ispravka
  FROM tSaglasanRN
  WHERE DIVIspravke > @watermark
  ORDER BY DIVIspravke ASC;
`;

function emptyToNull(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length === 0 ? null : t;
}

function cleanDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() <= 1901) return null;
  return dt.toISOString();
}

function mapRow(row) {
  return {
    id: row.id,
    work_order_id: row.work_order_id,
    saglasan: !!row.saglasan,
    datum_unosa: cleanDate(row.datum_unosa),
    created_at: cleanDate(row.created_at),
    author_worker_id: row.author_worker_id ?? null,
    potpis_unos: emptyToNull(row.potpis_unos),
    modified_at: cleanDate(row.modified_at),
    modifier_worker_id: row.modifier_worker_id ?? null,
    potpis_ispravka: emptyToNull(row.potpis_ispravka),
    synced_at: new Date().toISOString(),
  };
}

export async function syncWorkOrderApprovals() {
  const run = await startRun(JOB_NAME);
  log.info('start');
  try {
    const watermark = await getWatermark(JOB_NAME);
    const rows = await runQuery(SQL, {
      watermark: { type: sql.DateTime2, value: watermark },
    });
    log.info(
      { count: rows.length, watermark: watermark.toISOString() },
      'fetched delta from BigTehn',
    );

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_work_order_approvals_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

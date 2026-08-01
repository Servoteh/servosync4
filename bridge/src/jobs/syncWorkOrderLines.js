import { runQuery, sql } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';
import { getWatermark } from './watermark.js';

const log = logJob('syncWorkOrderLines');
const JOB_NAME = 'production_work_order_lines';

/**
 * Stavke radnih naloga (tStavkeRN) — operacije po RN-u — incremental sync
 * po DIVIspravke.
 *
 * Veličina: ukupno ~100k+ redova, ali svaki run vuče samo izmenjene redove
 * od poslednjeg uspešnog sync-a (watermark). Tipično <500 redova po runu
 * tokom radnog dana.
 *
 * tStavkeRN shema (potvrđeno discover-om):
 *   IDStavkeRN    int           PK
 *   IDRN          int                       -- FK -> bigtehn_work_orders_cache
 *   Operacija     int                       -- redni broj (5, 10, 15...)
 *   RJgrupaRC     nvarchar(5)               -- kod mašine ("8.3", "10.1") -> bigtehn_machines_cache.rj_code
 *   OpisRada      nvarchar
 *   AlatPribor    nvarchar(50)
 *   Tpz           float                     -- pripremno-završno vreme
 *   Tk            float                     -- komadno vreme
 *   TezinaTO      float
 *   SifraRadnika  int
 *   DIVUnosa      datetime                  -- created_at
 *   DIVIspravke   datetime                  -- ← WATERMARK (last modified)
 *   Prioritet     int                       -- default 100, 255 = najniži
 */
const SQL = `
  SELECT
    IDStavkeRN                          AS id,
    IDRN                                AS work_order_id,
    Operacija                           AS operacija,
    LTRIM(RTRIM(RJgrupaRC))             AS machine_code,
    CAST(OpisRada AS nvarchar(MAX))     AS opis_rada,
    LTRIM(RTRIM(AlatPribor))            AS alat_pribor,
    Tpz                                 AS tpz,
    Tk                                  AS tk,
    TezinaTO                            AS tezina_to,
    NULLIF(SifraRadnika, 0)             AS author_worker_id,
    DIVUnosa                            AS created_at,
    DIVIspravke                         AS modified_at,
    Prioritet                           AS prioritet
  FROM tStavkeRN
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
    operacija: row.operacija ?? 0,
    machine_code: emptyToNull(row.machine_code),
    opis_rada: emptyToNull(row.opis_rada),
    alat_pribor: emptyToNull(row.alat_pribor),
    tpz: row.tpz ?? 0,
    tk: row.tk ?? 0,
    tezina_to: row.tezina_to ?? 0,
    author_worker_id: row.author_worker_id ?? null,
    created_at: cleanDate(row.created_at),
    modified_at: cleanDate(row.modified_at),
    prioritet: row.prioritet ?? 100,
    synced_at: new Date().toISOString(),
  };
}

export async function syncWorkOrderLines() {
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
    const { total } = await upsertChunked('bigtehn_work_order_lines_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

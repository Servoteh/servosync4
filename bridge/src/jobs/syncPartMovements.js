import { runQuery, sql } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';
import { getWatermark } from './watermark.js';

const log = logJob('syncPartMovements');
const JOB_NAME = 'production_part_movements';

/**
 * Kretanje delova kroz fabriku (tLokacijeDelova) — incremental sync po
 * COALESCE(DatumIVremeUnosa, Datum). Svaki red predstavlja jedan transfer
 * delova: KO je (SifraRadnika), KOLIKO komada (Kolicina), KOG predmeta/RN-a,
 * NA KOJU poziciju (police K-A1, K-S=škart...), KOG kvaliteta (OK, škart...).
 *
 * Šema (potvrđeno discover-om 2026-04-19):
 *   IDLokacije        int    NO    PK
 *   IDRN              int    NO    -- FK -> tRN, "0" = bez RN-a
 *   IDPredmet         int    NO    -- FK -> Predmeti, "0" = bez predmeta
 *   IDVrstaKvaliteta  int    NO    -- FK -> tVrsteKvalitetaDelova, "0" = neodređeno
 *   IDPozicija        int    NO    -- FK -> tPozicije, "0" = bez police
 *   SifraRadnika      int    NO    -- FK -> tRadnici, "0" = sistem
 *   Datum             datetime NO     -- datum kretanja (samo dan, vreme = 00:00)
 *   Kolicina          int    NO    -- broj komada
 *   DatumIVremeUnosa  datetime YES    -- WATERMARK (može biti NULL u starim redovima)
 *
 * Watermark logika:
 *   - DatumIVremeUnosa MOŽE biti NULL → koristim COALESCE(DatumIVremeUnosa, Datum)
 *   - To zaokružuje na celokupan dan kada je vreme nepoznato (bezbedna opcija)
 *
 * Veličina:
 *   - prvi run sa fallback 30 dana: <2000 redova
 *   - tipičan 15-min run u radno vreme: 10–50 redova
 */
const SQL = `
  SELECT
    IDLokacije                    AS id,
    NULLIF(IDRN, 0)               AS work_order_id,
    NULLIF(IDPredmet, 0)          AS item_id,
    NULLIF(IDVrstaKvaliteta, 0)   AS quality_type_id,
    NULLIF(IDPozicija, 0)         AS position_id,
    NULLIF(SifraRadnika, 0)       AS worker_id,
    Datum                         AS datum,
    Kolicina                      AS kolicina,
    DatumIVremeUnosa              AS created_at
  FROM tLokacijeDelova
  WHERE COALESCE(DatumIVremeUnosa, Datum) > @watermark
  ORDER BY COALESCE(DatumIVremeUnosa, Datum) ASC;
`;

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
    work_order_id: row.work_order_id ?? null,
    item_id: row.item_id ?? null,
    quality_type_id: row.quality_type_id ?? null,
    position_id: row.position_id ?? null,
    worker_id: row.worker_id ?? null,
    datum: cleanDate(row.datum),
    kolicina: row.kolicina ?? 0,
    created_at: cleanDate(row.created_at),
    synced_at: new Date().toISOString(),
  };
}

export async function syncPartMovements() {
  const run = await startRun(JOB_NAME);
  log.info('start');
  try {
    const watermark = await getWatermark(JOB_NAME);
    const rows = await runQuery(SQL, {
      watermark: { type: sql.DateTime2, value: watermark },
    });
    log.info(
      {
        count: rows.length,
        watermark: watermark.toISOString(),
        scrap: rows.filter((r) => r.quality_type_id === 0 || r.quality_type_id === null).length,
      },
      'fetched delta from BigTehn',
    );

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_part_movements_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

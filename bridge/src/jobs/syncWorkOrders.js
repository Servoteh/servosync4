import { runQuery, sql } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';
import { getWatermark } from './watermark.js';

const log = logJob('syncWorkOrders');
const JOB_NAME = 'production_work_orders';

/**
 * Radni nalozi (tRN) iz BigTehn-a — incremental sync po DIVIspravkeRN.
 *
 * Veličina: ukupno ~30k+ redova, ali svaki run vuče samo izmenjene redove
 * od poslednjeg uspešnog sync-a (watermark). Tipično <100 redova po runu
 * tokom radnog dana.
 *
 * tRN shema (relevantne kolone, potvrđeno discover-om):
 *   IDRN                  int           PK
 *   IDPredmet             int                       -- FK -> bigtehn_items_cache
 *   BBIDKomitent          int                       -- FK -> bigtehn_customers_cache
 *   IdentBroj             nvarchar(50)              -- "1839/10-1"
 *   Varijanta             int
 *   BrojCrteza            nvarchar(100)             -- "RBST-40-03-01-01"
 *   NazivDela             nvarchar(250)             -- "ADAPTER -pos.1"
 *   Materijal             nvarchar(250)
 *   DimenzijaMaterijala   nvarchar(150)
 *   JM                    nvarchar(50)
 *   Komada                int
 *   TezinaNeobrDela       float
 *   TezinaObrDela         float
 *   StatusRN              bit                       -- 0=u radu, 1=završen
 *   Zakljucano            bit
 *   Revizija              nvarchar(3)               -- "A", "B"…
 *   IDVrstaKvaliteta      int                       -- FK -> bigtehn_quality_types
 *   IDStatusPrimopredaje  int
 *   Napomena              nvarchar
 *   RokIzrade             datetime
 *   DatumUnosa            datetime
 *   DIVUnosaRN            datetime                  -- created_at
 *   DIVIspravkeRN         datetime                  -- ← WATERMARK (last modified)
 *   SifraRadnika          int                       -- ko je upisao
 */
const SQL = `
  SELECT
    IDRN                                AS id,
    NULLIF(IDPredmet, 0)                AS item_id,
    NULLIF(BBIDKomitent, 0)             AS customer_id,
    LTRIM(RTRIM(IdentBroj))             AS ident_broj,
    Varijanta                           AS varijanta,
    LTRIM(RTRIM(BrojCrteza))            AS broj_crteza,
    LTRIM(RTRIM(NazivDela))             AS naziv_dela,
    LTRIM(RTRIM(Materijal))             AS materijal,
    LTRIM(RTRIM(DimenzijaMaterijala))   AS dimenzija_materijala,
    LTRIM(RTRIM(JM))                    AS jedinica_mere,
    Komada                              AS komada,
    TezinaNeobrDela                     AS tezina_neobr,
    TezinaObrDela                       AS tezina_obr,
    ISNULL(StatusRN, 0)                 AS status_rn,
    ISNULL(Zakljucano, 0)               AS zakljucano,
    LTRIM(RTRIM(Revizija))              AS revizija,
    NULLIF(IDVrstaKvaliteta, 0)         AS quality_type_id,
    IDStatusPrimopredaje                AS handover_status_id,
    CAST(Napomena AS nvarchar(MAX))     AS napomena,
    RokIzrade                           AS rok_izrade,
    DatumUnosa                          AS datum_unosa,
    DIVUnosaRN                          AS created_at,
    DIVIspravkeRN                       AS modified_at,
    NULLIF(SifraRadnika, 0)             AS author_worker_id
  FROM tRN
  WHERE DIVIspravkeRN > @watermark
  ORDER BY DIVIspravkeRN ASC;
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
    item_id: row.item_id ?? null,
    customer_id: row.customer_id ?? null,
    ident_broj: row.ident_broj || `(no-${row.id})`,
    varijanta: row.varijanta ?? 0,
    broj_crteza: emptyToNull(row.broj_crteza),
    naziv_dela: emptyToNull(row.naziv_dela),
    materijal: emptyToNull(row.materijal),
    dimenzija_materijala: emptyToNull(row.dimenzija_materijala),
    jedinica_mere: emptyToNull(row.jedinica_mere),
    komada: row.komada ?? 0,
    tezina_neobr: row.tezina_neobr ?? 0,
    tezina_obr: row.tezina_obr ?? 0,
    status_rn: !!row.status_rn,
    zakljucano: !!row.zakljucano,
    revizija: emptyToNull(row.revizija),
    quality_type_id: row.quality_type_id ?? null,
    handover_status_id: row.handover_status_id ?? null,
    napomena: emptyToNull(row.napomena),
    rok_izrade: cleanDate(row.rok_izrade),
    datum_unosa: cleanDate(row.datum_unosa),
    created_at: cleanDate(row.created_at),
    modified_at: cleanDate(row.modified_at),
    author_worker_id: row.author_worker_id ?? null,
    synced_at: new Date().toISOString(),
  };
}

export async function syncWorkOrders() {
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
        active: rows.filter((r) => !r.status_rn).length,
      },
      'fetched delta from BigTehn',
    );

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_work_orders_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

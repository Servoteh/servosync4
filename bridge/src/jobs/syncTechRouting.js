import { runQuery, sql } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';
import { getWatermark } from './watermark.js';

const log = logJob('syncTechRouting');
const JOB_NAME = 'production_tech_routing';

/**
 * Tehnološki postupak (tTehPostupak) — prijave rada operatera po
 * operaciji RN-a. Ovo je AUTORITATIVAN izvor istine za:
 *   - Da li je operacija završena? (ZavrsenPostupak)
 *   - Stvarno vreme rada (PrnTimer u sekundama)
 *   - Ko je radio (SifraRadnika), na čemu (IDPredmet/IDRN), kada
 *     (DatumIVremeUnosa, DatumIVremeZavrsetka)
 *
 * Veza sa stavkom RN-a (operacijom):
 *   JOIN ON (tech_routing.work_order_id = lines.work_order_id
 *            AND tech_routing.operacija = lines.operacija)
 *
 * Watermark logika:
 *   COALESCE(DatumIVremeZavrsetka, DatumIVremeUnosa)
 *   - Ako red ima DatumIVremeZavrsetka — koristimo ga (skoriji event)
 *   - Inače DatumIVremeUnosa (kreiranje)
 *   - Tako hvatamo i NOVE prijave i KOMPLETIRANJE postojećih
 *
 * Šema (potvrđeno discover-om 2026-04-19):
 *   IDPostupka            int          NO    PK
 *   SifraRadnika          int          NO          -- radnik
 *   IDPredmet             int          NO    (0)   -- predmet
 *   IdentBroj             nvarchar(50) NO
 *   Varijanta             int          NO    (0)
 *   PrnTimer              int          YES   (0)   -- STVARNO VREME u sekundama
 *   DatumIVremeUnosa      datetime     NO    getdate()
 *   Operacija             int          NO          -- usklađeno sa tStavkeRN
 *   RJgrupaRC             nvarchar(5)  NO          -- mašina (kod)
 *   Toznaka               nvarchar(50) NO
 *   Komada                int          NO
 *   Potpis                nvarchar(50) YES
 *   SimbolRadnik          bit          YES   (0)
 *   SimbolPostupak        bit          YES   (0)
 *   SimbolOperacija       bit          YES   (0)
 *   DatumIVremeZavrsetka  datetime     YES
 *   ZavrsenPostupak       bit          YES   (0)
 *   Napomena              ntext        YES
 *   IDRN                  int          NO    (0)
 *   IDVrstaKvaliteta      int          NO    (0)
 *   DoradaOperacije       int          YES   (0)
 *
 * Veličina:
 *   - prvi run sa fallback 30 dana: ~5000 redova (procena)
 *   - tipičan 15-min run u radno vreme: 5–30 redova
 */
const SQL = `
  SELECT
    IDPostupka                       AS id,
    NULLIF(IDRN, 0)                  AS work_order_id,
    NULLIF(IDPredmet, 0)             AS item_id,
    NULLIF(SifraRadnika, 0)          AS worker_id,
    NULLIF(IDVrstaKvaliteta, 0)      AS quality_type_id,
    Operacija                        AS operacija,
    LTRIM(RTRIM(RJgrupaRC))          AS machine_code,
    Komada                           AS komada,
    PrnTimer                         AS prn_timer_seconds,
    DatumIVremeUnosa                 AS started_at,
    DatumIVremeZavrsetka             AS finished_at,
    ISNULL(ZavrsenPostupak, 0)       AS is_completed,
    LTRIM(RTRIM(IdentBroj))          AS ident_broj,
    Varijanta                        AS varijanta,
    LTRIM(RTRIM(Toznaka))            AS toznaka,
    LTRIM(RTRIM(Potpis))             AS potpis,
    CAST(Napomena AS nvarchar(MAX))  AS napomena,
    ISNULL(DoradaOperacije, 0)       AS dorada_operacije
  FROM tTehPostupak
  WHERE COALESCE(DatumIVremeZavrsetka, DatumIVremeUnosa) > @watermark
  ORDER BY COALESCE(DatumIVremeZavrsetka, DatumIVremeUnosa) ASC;
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
    work_order_id: row.work_order_id ?? null,
    item_id: row.item_id ?? null,
    worker_id: row.worker_id ?? null,
    quality_type_id: row.quality_type_id ?? null,
    operacija: row.operacija,
    machine_code: emptyToNull(row.machine_code),
    komada: row.komada ?? 0,
    prn_timer_seconds: row.prn_timer_seconds ?? null,
    started_at: cleanDate(row.started_at),
    finished_at: cleanDate(row.finished_at),
    is_completed: !!row.is_completed,
    ident_broj: emptyToNull(row.ident_broj),
    varijanta: row.varijanta ?? 0,
    toznaka: emptyToNull(row.toznaka),
    potpis: emptyToNull(row.potpis),
    napomena: emptyToNull(row.napomena),
    dorada_operacije: row.dorada_operacije ?? 0,
    synced_at: new Date().toISOString(),
  };
}

export async function syncTechRouting() {
  const run = await startRun(JOB_NAME);
  log.info('start');
  try {
    const watermark = await getWatermark(JOB_NAME);
    const rows = await runQuery(SQL, {
      watermark: { type: sql.DateTime2, value: watermark },
    });

    const completed = rows.filter((r) => r.is_completed).length;
    const totalSeconds = rows.reduce(
      (acc, r) => acc + (Number(r.prn_timer_seconds) || 0),
      0,
    );

    log.info(
      {
        count: rows.length,
        completed,
        totalHours: Math.round((totalSeconds / 3600) * 10) / 10,
        watermark: watermark.toISOString(),
      },
      'fetched delta from BigTehn',
    );

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked(
      'bigtehn_tech_routing_cache',
      payload,
      'id',
    );

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

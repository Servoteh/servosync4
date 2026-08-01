import { runQuery } from '../db/sqlserver.js';
import { upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncItems');

/**
 * Predmeti (proizvodni predmeti / projekti) iz BigTehn-a.
 *
 * Predmet = "kontejner" za radne naloge. Jedan predmet ima više tRN-ova.
 * Status: 'OTVOREN' / 'GOTOVO' / itd.
 *
 * Veličina: ~10k+ redova. Full refresh dnevno u catalog jobu (06:00).
 *
 * Predmeti shema (relevantne kolone, potvrđeno discover-om — full sample):
 *   IDPredmet           int           PK
 *   BrojPredmeta        nvarchar(20)  NOT NULL    -- "1315"
 *   Opis                nvarchar(50)
 *   NazivPredmeta       nvarchar(250)
 *   Status              nvarchar(20)              -- "OTVOREN" / "GOTOVO"
 *   IDKomitent          int                       -- FK na Komitenti (može biti 0)
 *   IDProdavac          int
 *   IDVrstaPosla        int
 *   RJ                  nvarchar(4)               -- 4-char kod radne jedinice
 *   DatumOtvaranja      datetime
 *   DatumZakljucenja    datetime
 *   RokZavrsetka        datetime
 *   BrojUgovora         nvarchar(100)
 *   DatumUgovora        datetime
 *   BrojNarudzbenice    nvarchar(100)
 *   DatumNarudzbenice   datetime
 *   DatumIVreme         datetime    DEFAULT getdate()  -- last modified
 *
 * Napomena:
 *   - IDKomitent može biti 0 — mapiramo u NULL da bi FK / JOIN-ovi radili
 *   - DatumUgovora i DatumNarudzbenice su često 1900-01-01 (placeholder); mapiramo u NULL
 */
const SQL = `
  SELECT
    IDPredmet                                AS id,
    LTRIM(RTRIM(BrojPredmeta))               AS broj_predmeta,
    LTRIM(RTRIM(NazivPredmeta))              AS naziv_predmeta,
    LTRIM(RTRIM(Opis))                       AS opis,
    LTRIM(RTRIM(Status))                     AS status,
    NULLIF(IDKomitent, 0)                    AS customer_id,
    NULLIF(IDProdavac, 0)                    AS seller_id,
    NULLIF(IDVrstaPosla, 0)                  AS work_type_id,
    LTRIM(RTRIM(RJ))                         AS department_code,
    LTRIM(RTRIM(BrojUgovora))                AS broj_ugovora,
    LTRIM(RTRIM(BrojNarudzbenice))           AS broj_narudzbenice,
    DatumOtvaranja                           AS datum_otvaranja,
    DatumZakljucenja                         AS datum_zakljucenja,
    RokZavrsetka                             AS rok_zavrsetka,
    DatumUgovora                             AS datum_ugovora,
    DatumNarudzbenice                        AS datum_narudzbenice,
    DatumIVreme                              AS modified_at
  FROM Predmeti
  WHERE IDPredmet IS NOT NULL;
`;

/** Vraća null ako je datum 1900-01-01 (BigTehn placeholder) ili nevalidan. */
function cleanDate(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() <= 1901) return null;
  return dt.toISOString();
}

function emptyToNull(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t.length === 0 ? null : t;
}

function mapRow(row) {
  return {
    id: row.id,
    broj_predmeta: row.broj_predmeta || `(no-${row.id})`,
    naziv_predmeta: emptyToNull(row.naziv_predmeta),
    opis: emptyToNull(row.opis),
    status: emptyToNull(row.status),
    customer_id: row.customer_id ?? null,
    seller_id: row.seller_id ?? null,
    work_type_id: row.work_type_id ?? null,
    department_code: emptyToNull(row.department_code),
    broj_ugovora: emptyToNull(row.broj_ugovora),
    broj_narudzbenice: emptyToNull(row.broj_narudzbenice),
    datum_otvaranja: cleanDate(row.datum_otvaranja),
    datum_zakljucenja: cleanDate(row.datum_zakljucenja),
    rok_zavrsetka: cleanDate(row.rok_zavrsetka),
    datum_ugovora: cleanDate(row.datum_ugovora),
    datum_narudzbenice: cleanDate(row.datum_narudzbenice),
    modified_at: cleanDate(row.modified_at),
    synced_at: new Date().toISOString(),
  };
}

export async function syncItems() {
  const run = await startRun('catalog_items');
  log.info('start');
  try {
    const rows = await runQuery(SQL);
    log.info(
      {
        count: rows.length,
        open: rows.filter((r) => (r.status || '').toUpperCase() === 'OTVOREN').length,
      },
      'fetched from BigTehn',
    );

    const payload = rows.map(mapRow);
    const { total } = await upsertChunked('bigtehn_items_cache', payload, 'id');

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

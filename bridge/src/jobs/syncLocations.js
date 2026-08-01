import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncLocations');

/**
 * STATUS: DISABLED (Faza 2)
 * ---------------------------------------------------------------------------
 * Originalna pretpostavka iz BIGTEHN_DATA_MAP.md (police K-A1, K-B3, K-MG,
 * K-S=škart) bila je POGREŠNA. Stvarna shema `tLokacijeDelova` (potvrđeno
 * preko `npm run discover:columns -- tLokacijeDelova` 2026-04-18):
 *
 *   IDLokacije        int       NOT NULL   -- PK
 *   IDRN              int       NOT NULL   -- referenca na radni nalog
 *   IDPredmet         int       NOT NULL   -- referenca na predmet
 *   IDVrstaKvaliteta  int       NOT NULL   -- najverovatnije FK na katalog
 *                                              kvaliteta/destinacije (K-A1,
 *                                              K-S=škart…)
 *   IDPozicija        int       NOT NULL
 *   SifraRadnika      int       NOT NULL   -- ko je premestio
 *   Datum             datetime  NOT NULL
 *   Kolicina          int       NOT NULL
 *   DatumIVremeUnosa  datetime  NULL
 *
 * Ovo NIJE katalog — to je TRANSAKCIONI LOG kretanja delova kroz proizvodnju
 * (jedan red = "radnik X premestio Y komada predmeta Z, RN W, na destinaciju
 * IDVrstaKvaliteta, na datum D"). Ide u Fazu 2 (analitika/workflow).
 *
 * TODO Faza 2:
 *   1) Pronaći pravi katalog destinacija — verovatno `tVrsteKvalitetaDelova`
 *      (potvrditi preko `npm run discover:columns -- tVrsteKvalitetaDelova`).
 *   2) Sinhronizovati ga kao `bigtehn_quality_locations_cache`.
 *   3) `tLokacijeDelova` sinhronizovati kao transakcionu `bigtehn_part_movements`
 *      tabelu (incremental sync po `DatumIVremeUnosa`).
 */
export async function syncLocations() {
  const run = await startRun('catalog_locations');
  const msg =
    'syncLocations je ISKLJUČEN: tLokacijeDelova nije katalog već transakcioni log. ' +
    'Vidi NOTE u src/jobs/syncLocations.js — premešteno u Fazu 2.';
  log.warn(msg);
  const err = new Error(msg);
  await failRun(run, err);
  throw err;
}

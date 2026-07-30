import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';
import { syncCustomers } from './syncCustomers.js';
import { syncDepartments } from './syncDepartments.js';
import { syncItems } from './syncItems.js';
import { syncMachines } from './syncMachines.js';
import { syncPositions } from './syncPositions.js';
import { syncQualityTypes } from './syncQualityTypes.js';
import { syncWorkers } from './syncWorkers.js';
import { syncWorkerTypes } from './syncWorkerTypes.js';
// NOTE: syncLocations (tLokacijeDelova) je transakcioni log, ne katalog —
// premešten u Fazu 2 (incremental sync po DatumIVremeUnosa). Originalni
// BIGTEHN_DATA_MAP.md sekcija 3.1 ga je netačno opisala kao katalog polica;
// pravi katalog polica je tPozicije (sad sinhronizovan kao `positions`).

const log = logJob('syncCatalogs');

/**
 * Zbirni dnevni job: 8 kataloga (Faza 1B + B.1 + B.2.1 dopuna).
 *
 * Redosled je važan zbog FK-ova u Supabase-u:
 *   1) departments    (parent)
 *   2) machines       (FK -> departments.id)
 *   3) customers      (nezavisno; referenciran iz items)
 *   4) worker_types   (referenciran iz workers.worker_type_id)
 *   5) workers        (FK -> departments.id, worker_types.id)
 *   6) quality_types  (referenciran iz tRN/tTehPostupak — Faza 1C)
 *   7) positions      (referenciran iz tLokacijeDelova — Faza 2)
 *   8) items          (Predmeti; referenciran iz tRN — Faza 1C)
 *
 * Svaki underlying job ima svoj sync_log zapis. Ovaj wrapper takođe loguje
 * jedan composite zapis ('catalogs_daily') sa zbirnim rows_updated.
 */
export async function syncCatalogs() {
  const run = await startRun('catalogs_daily');
  log.info('start');
  let total = 0;
  try {
    const d = await syncDepartments();
    total += d.total;
    const m = await syncMachines();
    total += m.total;
    const c = await syncCustomers();
    total += c.total;
    const wt = await syncWorkerTypes();
    total += wt.total;
    const w = await syncWorkers();
    total += w.total;
    const qt = await syncQualityTypes();
    total += qt.total;
    const p = await syncPositions();
    total += p.total;
    const i = await syncItems();
    total += i.total;

    await finishRun(run, { rowsUpdated: total });
    log.info({ totalRows: total }, 'all 8 catalogs done');
    return { total };
  } catch (err) {
    log.error({ err }, 'catalogs job failed');
    await failRun(run, err);
    throw err;
  }
}

import { describeConfig } from './config.js';
import { closeKatzePool } from './db/katze.js';
import { closeSqlPool } from './db/sqlserver.js';
import { syncKatze } from './jobs/syncKatze.js';
import { syncCatalogs } from './jobs/syncCatalogs.js';
import { syncCustomers } from './jobs/syncCustomers.js';
import { syncDepartments } from './jobs/syncDepartments.js';
import { syncItems } from './jobs/syncItems.js';
import { syncLocations } from './jobs/syncLocations.js';
import { syncMachines } from './jobs/syncMachines.js';
import { syncPartMovements } from './jobs/syncPartMovements.js';
import { syncPositions } from './jobs/syncPositions.js';
import { syncProduction } from './jobs/syncProduction.js';
import { syncQualityTypes } from './jobs/syncQualityTypes.js';
import { syncBigtehnDrawings } from './jobs/syncBigtehnDrawings.js';
import { syncTechRouting } from './jobs/syncTechRouting.js';
import { syncWorkOrderApprovals } from './jobs/syncWorkOrderApprovals.js';
import { syncWorkOrderLaunches } from './jobs/syncWorkOrderLaunches.js';
import { syncWorkOrderLines } from './jobs/syncWorkOrderLines.js';
import { syncWorkOrders } from './jobs/syncWorkOrders.js';
import { syncWorkers } from './jobs/syncWorkers.js';
import { syncWorkerTypes } from './jobs/syncWorkerTypes.js';
import { scadaCommandsOnce } from './jobs/scadaCommands.js';
import { scadaSnapshotOnce } from './jobs/scadaSnapshot.js';
import { logger } from './logger.js';
import { startScheduler } from './scheduler.js';

function parseArgs(argv) {
  const args = { once: false, job: null };
  for (const a of argv.slice(2)) {
    if (a === '--once') args.once = true;
    else if (a.startsWith('--job=')) args.job = a.slice('--job='.length);
  }
  return args;
}

async function runOne(jobName) {
  switch (jobName) {
    case 'departments':
      await syncDepartments();
      return;
    case 'machines':
      await syncMachines();
      return;
    case 'customers':
      await syncCustomers();
      return;
    case 'workers':
      await syncWorkers();
      return;
    case 'worker_types':
    case 'worker-types':
      await syncWorkerTypes();
      return;
    case 'quality_types':
    case 'quality-types':
      await syncQualityTypes();
      return;
    case 'positions':
      await syncPositions();
      return;
    case 'items':
      await syncItems();
      return;
    case 'locations':
      await syncLocations();
      return;
    case 'work_orders':
    case 'work-orders':
      await syncWorkOrders();
      return;
    case 'work_order_lines':
    case 'work-order-lines':
    case 'lines':
      await syncWorkOrderLines();
      return;
    case 'work_order_launches':
    case 'work-order-launches':
    case 'launches':
      await syncWorkOrderLaunches();
      return;
    case 'work_order_approvals':
    case 'work-order-approvals':
    case 'approvals':
      await syncWorkOrderApprovals();
      return;
    case 'part_movements':
    case 'part-movements':
    case 'movements':
      await syncPartMovements();
      return;
    case 'tech_routing':
    case 'tech-routing':
    case 'routing':
      await syncTechRouting();
      return;
    case 'bigtehn_drawings':
    case 'bigtehn-drawings':
    case 'drawings':
      await syncBigtehnDrawings();
      return;
    case 'production':
      await syncProduction();
      return;
    case 'katze':
    case 'katze_attendance':
    case 'katze-attendance':
    case 'attendance':
      await syncKatze();
      return;
    case 'scada':
    case 'scada_snapshot':
    case 'scada-snapshot':
      await scadaSnapshotOnce({ withHistory: true, logRun: true });
      return;
    case 'scada_commands':
    case 'scada-commands':
      await scadaCommandsOnce();
      return;
    case 'catalogs':
    case null:
    case undefined:
    case '':
      await syncCatalogs();
      return;
    default:
      throw new Error(`Unknown --job=${jobName}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  logger.info(
    { args, config: describeConfig(), node: process.version, platform: process.platform },
    'bridge starting',
  );

  if (args.once) {
    try {
      await runOne(args.job);
      logger.info('one-shot run complete, exiting');
      await closeSqlPool();
      await closeKatzePool();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'one-shot run failed');
      await closeSqlPool();
      await closeKatzePool();
      process.exit(1);
    }
  }

  startScheduler();
  logger.info('bridge running (scheduled mode). Ctrl+C to stop.');

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down…');
    await closeSqlPool();
    await closeKatzePool();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down…');
    await closeSqlPool();
    await closeKatzePool();
    process.exit(0);
  });
}

main().catch(async (err) => {
  logger.fatal({ err }, 'bridge crashed in main');
  await closeSqlPool().catch(() => {});
  await closeKatzePool().catch(() => {});
  process.exit(1);
});

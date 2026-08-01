import cron from 'node-cron';

import { config } from './config.js';
import { syncBigtehnDrawings } from './jobs/syncBigtehnDrawings.js';
import { syncCatalogs } from './jobs/syncCatalogs.js';
import { syncKatze } from './jobs/syncKatze.js';
import { syncProduction } from './jobs/syncProduction.js';
import { logger } from './logger.js';
import { startScadaLoops } from './scada/loop.js';

let _registered = false;
let _runningCatalogs = false;
let _runningProduction = false;
let _runningDrawings = false;
let _runningKatze = false;

/**
 * Wraper koji sprečava preklapanje istog joba: ako je prethodni run još u toku
 * (npr. kasni > 24h iz nekog razloga), preskoči novi tick i samo loguj.
 */
async function safeCatalogs() {
  if (_runningCatalogs) {
    logger.warn('[scheduler] catalogs run still in progress, skipping this tick');
    return;
  }
  _runningCatalogs = true;
  try {
    await syncCatalogs();
  } catch (err) {
    logger.error({ err }, '[scheduler] catalogs run threw (will retry next tick)');
  } finally {
    _runningCatalogs = false;
  }
}

/**
 * Production wraper — radi se na svakih 15 minuta. Ako prethodni run još
 * traje (mreža/SQL spori), preskoči ovaj tick.
 */
async function safeProduction() {
  if (_runningProduction) {
    logger.warn('[scheduler] production run still in progress, skipping this tick');
    return;
  }
  _runningProduction = true;
  try {
    await syncProduction();
  } catch (err) {
    logger.error({ err }, '[scheduler] production run threw (will retry next tick)');
  } finally {
    _runningProduction = false;
  }
}

/**
 * BigTehn crteži wraper — default jednom dnevno (07:00). Inicijalni seed
 * može da traje 5–15 min za 700 MB; svi naredni run-ovi su ~par fajlova.
 */
async function safeDrawings() {
  if (_runningDrawings) {
    logger.warn('[scheduler] drawings run still in progress, skipping this tick');
    return;
  }
  _runningDrawings = true;
  try {
    await syncBigtehnDrawings();
  } catch (err) {
    logger.error({ err }, '[scheduler] drawings run threw (will retry next tick)');
  } finally {
    _runningDrawings = false;
  }
}

/**
 * Katze prolazi wraper — na 10 min. Inkrementalan po IDReg pa je i posle
 * dužeg prekida jedan run dovoljan da sve nadoknadi.
 */
async function safeKatze() {
  if (_runningKatze) {
    logger.warn('[scheduler] katze run still in progress, skipping this tick');
    return;
  }
  _runningKatze = true;
  try {
    await syncKatze();
  } catch (err) {
    logger.error({ err }, '[scheduler] katze run threw (will retry next tick)');
  } finally {
    _runningKatze = false;
  }
}

export function startScheduler() {
  if (_registered) {
    logger.warn('[scheduler] already started');
    return;
  }
  if (!config.scheduler.enabled) {
    logger.info('[scheduler] disabled via SCHEDULER_ENABLED=false (running in idle)');
    _registered = true;
    return;
  }

  if (config.jobs.catalogs) {
    if (!cron.validate(config.scheduler.catalogsCron)) {
      throw new Error(`[scheduler] Invalid catalogs cron expression: ${config.scheduler.catalogsCron}`);
    }
    cron.schedule(config.scheduler.catalogsCron, safeCatalogs, {
      timezone: config.scheduler.timezone,
    });
    logger.info(
      { cron: config.scheduler.catalogsCron, tz: config.scheduler.timezone },
      '[scheduler] catalogs job registered',
    );
  } else {
    logger.info('[scheduler] catalogs job disabled via ENABLE_JOB_CATALOGS=false');
  }

  if (config.jobs.production) {
    if (!cron.validate(config.scheduler.productionCron)) {
      throw new Error(`[scheduler] Invalid production cron expression: ${config.scheduler.productionCron}`);
    }
    cron.schedule(config.scheduler.productionCron, safeProduction, {
      timezone: config.scheduler.timezone,
    });
    logger.info(
      { cron: config.scheduler.productionCron, tz: config.scheduler.timezone },
      '[scheduler] production job registered',
    );
  } else {
    logger.info('[scheduler] production job disabled via ENABLE_JOB_PRODUCTION=false');
  }

  /* F.5a: BigTehn crteži (samo ako je BIGTEHN_DRAWINGS_DIR podešena) */
  if (config.bigtehnDrawingsDir) {
    if (!cron.validate(config.scheduler.drawingsCron)) {
      throw new Error(`[scheduler] Invalid drawings cron expression: ${config.scheduler.drawingsCron}`);
    }
    cron.schedule(config.scheduler.drawingsCron, safeDrawings, {
      timezone: config.scheduler.timezone,
    });
    logger.info(
      { cron: config.scheduler.drawingsCron, tz: config.scheduler.timezone, dir: config.bigtehnDrawingsDir },
      '[scheduler] bigtehn drawings job registered',
    );
  } else {
    logger.info('[scheduler] BIGTEHN_DRAWINGS_DIR nije postavljena — drawings job se preskače');
  }

  /* Katze evidencija radnog vremena (prolazi sa čitača) */
  if (config.jobs.katze) {
    if (!cron.validate(config.scheduler.katzeCron)) {
      throw new Error(`[scheduler] Invalid katze cron expression: ${config.scheduler.katzeCron}`);
    }
    cron.schedule(config.scheduler.katzeCron, safeKatze, {
      timezone: config.scheduler.timezone,
    });
    logger.info(
      { cron: config.scheduler.katzeCron, tz: config.scheduler.timezone },
      '[scheduler] katze job registered',
    );
  } else {
    logger.info('[scheduler] katze job disabled via ENABLE_JOB_KATZE=false');
  }

  /* SCADA relay (Energetika) — sekundne petlje van cron-a, samo ako je uključen */
  if (config.scada.enabled) {
    startScadaLoops();
  } else {
    logger.info('[scheduler] SCADA_ENABLED nije uključen — scada petlje se preskaču');
  }

  _registered = true;
}

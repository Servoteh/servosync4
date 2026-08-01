import { notifyError } from '../alerts/notifier.js';
import { config } from '../config.js';
import { scadaCommandsOnce } from '../jobs/scadaCommands.js';
import { scadaHistoryCleanup, scadaSnapshotOnce } from '../jobs/scadaSnapshot.js';
import { logger } from '../logger.js';

/**
 * SCADA petlje — za razliku od BigTehn jobova (node-cron, minutna rezolucija),
 * SCADA zahteva sekundne intervale:
 *   - snapshot:  SCADA_SNAPSHOT_MS (default 5 s)  → scada_snapshots + alarmi
 *   - history:   SCADA_HISTORY_MS  (default 60 s) → scada_history uzorci (throttle unutar snapshot passa)
 *   - komande:   SCADA_CMD_POLL_MS (default 2 s)  → scada_claim_commands + izvršenje
 *   - retencija: jednom dnevno (unutar snapshot petlje)
 * Overlap guard po petlji: ako prethodni tick još traje, preskoči.
 */

let _timers = [];
let _snapRunning = false;
let _cmdRunning = false;
let _lastHistoryAt = 0;
let _lastCleanupDay = '';
let _consecutiveSnapErrors = 0;

async function snapshotTick() {
  if (_snapRunning) return;
  _snapRunning = true;
  try {
    const now = Date.now();
    const withHistory = now - _lastHistoryAt >= config.scada.historyMs;
    await scadaSnapshotOnce({ withHistory });
    if (withHistory) _lastHistoryAt = now;
    _consecutiveSnapErrors = 0;

    const day = new Date().toISOString().slice(0, 10);
    if (day !== _lastCleanupDay) {
      _lastCleanupDay = day;
      scadaHistoryCleanup().catch(() => {});
    }
  } catch (err) {
    _consecutiveSnapErrors += 1;
    logger.error({ err, consecutive: _consecutiveSnapErrors }, '[scada] snapshot tick failed');
    // alert tek posle 5 uzastopnih grešaka (1 tranzijentna mreža ≠ uzbuna); throttle 1h u notifier-u
    if (_consecutiveSnapErrors === 5) {
      notifyError({ jobName: 'scada_snapshot', error: err, context: '5 uzastopnih grešaka' });
    }
  } finally {
    _snapRunning = false;
  }
}

async function commandsTick() {
  if (_cmdRunning) return;
  _cmdRunning = true;
  try {
    await scadaCommandsOnce();
  } catch (err) {
    logger.error({ err }, '[scada] commands tick failed');
  } finally {
    _cmdRunning = false;
  }
}

export function startScadaLoops() {
  if (_timers.length) {
    logger.warn('[scada] loops already started');
    return;
  }
  logger.info(
    {
      baseUrl: config.scada.baseUrl,
      snapshotMs: config.scada.snapshotMs,
      historyMs: config.scada.historyMs,
      cmdPollMs: config.scada.cmdPollMs,
      control: config.scada.control,
    },
    '[scada] starting loops',
  );
  _timers.push(setInterval(snapshotTick, config.scada.snapshotMs));
  _timers.push(setInterval(commandsTick, config.scada.cmdPollMs));
  // odmah prvi prolaz, bez čekanja prvog intervala
  snapshotTick();
  commandsTick();
}

export function stopScadaLoops() {
  for (const t of _timers) clearInterval(t);
  _timers = [];
}

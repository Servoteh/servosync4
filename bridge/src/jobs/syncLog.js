import { notifyError } from '../alerts/notifier.js';
import { getSupabase } from '../db/supabase.js';
import { logger } from '../logger.js';

/**
 * Životni ciklus jednog sync zapisa u bridge_sync_log.
 *
 *   const run = await startRun('catalogs_daily');
 *   try {
 *     ...
 *     await finishRun(run, { rowsInserted: 0, rowsUpdated: 12 });
 *   } catch (err) {
 *     await failRun(run, err);
 *   }
 *
 * Ako Supabase write padne (npr. mreža), greška NE prekida glavni sync —
 * samo se loguje i nastavlja se. Tabela bridge_sync_log je "best effort".
 */
export async function startRun(syncJob) {
  const startedAt = new Date();
  const supa = getSupabase();
  try {
    const { data, error } = await supa
      .from('bridge_sync_log')
      .insert({
        sync_job: syncJob,
        started_at: startedAt.toISOString(),
        status: 'running',
      })
      .select('id')
      .single();
    if (error) throw error;
    return { id: data?.id ?? null, syncJob, startedAt };
  } catch (err) {
    logger.warn({ err, syncJob }, '[sync_log] startRun failed (continuing)');
    return { id: null, syncJob, startedAt };
  }
}

export async function finishRun(
  run,
  { rowsInserted = 0, rowsUpdated = 0, rowsDeleted = 0 } = {},
) {
  if (!run) return;
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - run.startedAt.getTime();
  if (run.id == null) {
    logger.info(
      { syncJob: run.syncJob, durationMs, rowsInserted, rowsUpdated, rowsDeleted },
      '[sync_log] finished (no row id)',
    );
    return;
  }
  const supa = getSupabase();
  try {
    const { error } = await supa
      .from('bridge_sync_log')
      .update({
        finished_at: finishedAt.toISOString(),
        status: 'success',
        rows_inserted: rowsInserted,
        rows_updated: rowsUpdated,
        rows_deleted: rowsDeleted,
        duration_ms: durationMs,
      })
      .eq('id', run.id);
    if (error) throw error;
  } catch (err) {
    logger.warn({ err, syncJob: run.syncJob }, '[sync_log] finishRun failed');
  }
}

export async function failRun(run, error) {
  if (!run) return;
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - run.startedAt.getTime();
  const message = error?.message ? String(error.message).slice(0, 4000) : String(error);

  // Fire-and-forget alert. notifyError je throttle-ovan po jobName (1h),
  // pa neće spamovati ako isti job pukne svakih 15 min.
  notifyError({ jobName: run.syncJob, error, run });

  if (run.id == null) {
    logger.error(
      { syncJob: run.syncJob, durationMs, err: error },
      '[sync_log] failed (no row id)',
    );
    return;
  }
  const supa = getSupabase();
  try {
    const { error: writeErr } = await supa
      .from('bridge_sync_log')
      .update({
        finished_at: finishedAt.toISOString(),
        status: 'error',
        error_message: message,
        duration_ms: durationMs,
      })
      .eq('id', run.id);
    if (writeErr) throw writeErr;
  } catch (err) {
    logger.warn({ err, syncJob: run.syncJob }, '[sync_log] failRun update failed');
  }
}

import { getSupabase } from '../db/supabase.js';
import { logJob } from '../logger.js';

const log = logJob('watermark');

/**
 * Vraća `started_at` najnovijeg uspešnog runa za zadati job ime.
 *
 * Strategija "watermark - 1 min":
 *   - Vraćeni timestamp predstavlja "od kog trenutka treba povući izmene".
 *   - Oduzimamo `safetyOverlapSeconds` (default 60s) da pokrijemo race
 *     condition kada radnik upiše red u BigTehn između trenutka kad je
 *     prošli sync počeo i kad je `DIVIspravke` postavljen u istom redu.
 *     Bolje da povučemo nekoliko duplih redova (idempotent UPSERT) nego
 *     da nešto propustimo.
 *
 * @param {string} jobName  Ime joba u `bridge_sync_log.sync_job` (npr.
 *                           "production_work_orders").
 * @param {object} [opts]
 * @param {number} [opts.fallbackDays=30]    Ako joba još nije bilo, povuci
 *                                            poslednjih N dana.
 * @param {number} [opts.safetyOverlapSeconds=60] Oduzmi koliko sekundi od
 *                                            poslednjeg started_at-a.
 * @returns {Promise<Date>}                  Datum od koga povući izmene.
 */
export async function getWatermark(jobName, opts = {}) {
  const fallbackDays = opts.fallbackDays ?? 30;
  const overlapMs = (opts.safetyOverlapSeconds ?? 60) * 1000;
  const supabase = getSupabase();

  try {
    const { data, error } = await supabase
      .from('bridge_sync_log')
      .select('started_at')
      .eq('sync_job', jobName)
      .eq('status', 'success')
      .order('started_at', { ascending: false })
      .limit(1);

    if (error) {
      log.warn({ jobName, err: error.message }, 'watermark fetch failed, using fallback');
    } else if (data && data.length > 0 && data[0].started_at) {
      const last = new Date(data[0].started_at);
      const adjusted = new Date(last.getTime() - overlapMs);
      log.info({ jobName, lastStarted: last.toISOString(), watermark: adjusted.toISOString() }, 'watermark resolved');
      return adjusted;
    }
  } catch (err) {
    log.warn({ jobName, err: err?.message || err }, 'watermark fetch threw, using fallback');
  }

  // Fallback: today - fallbackDays
  const now = new Date();
  const fallback = new Date(now.getTime() - fallbackDays * 24 * 60 * 60 * 1000);
  log.warn(
    { jobName, fallbackDays, watermark: fallback.toISOString() },
    'no prior successful run — using fallback watermark',
  );
  return fallback;
}

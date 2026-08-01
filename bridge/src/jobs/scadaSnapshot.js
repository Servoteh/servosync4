import { config } from '../config.js';
import { getSupabase } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { NORMALIZERS } from '../scada/normalize.js';
import { getBluelog, getLoxone, getS7, getSigen, getState } from '../scada/scadaClient.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('scada_snapshot');

const FETCHERS = {
  kot1: getState,
  kot2: getS7,
  kot3: getLoxone,
  'solar-kaco': getBluelog,
  'solar-sigen': getSigen,
};

/**
 * Diff-sync aktivnih alarma za jedan sistem:
 *  - novi kod → INSERT (active=true)
 *  - postojeći kod → osveži text/severity ako se promenio
 *  - kod koji više nije aktivan → active=false + cleared_at
 * Jedan bridge = jedan pisac, pa je select→diff→write bezbedan.
 */
async function syncAlarms(supa, siteKey, activeAlarms) {
  const { data: dbRows, error } = await supa
    .from('scada_alarms')
    .select('id, code, severity, text')
    .eq('site_key', siteKey)
    .eq('active', true);
  if (error) throw new Error(`[scada] alarms select ${siteKey}: ${error.message}`);

  const wanted = new Map(activeAlarms.map((a) => [a.code, a]));
  const existing = new Map((dbRows || []).map((r) => [r.code, r]));

  const toInsert = activeAlarms
    .filter((a) => !existing.has(a.code))
    .map((a) => ({ site_key: siteKey, code: a.code, severity: a.severity, text: a.text }));
  const toClear = (dbRows || []).filter((r) => !wanted.has(r.code)).map((r) => r.id);
  // postojeći alarm sa promenjenim tekstom/ozbiljnošću → osveži (nalaz N5;
  // npr. INVERTER_OFFLINE nosi brojače u tekstu)
  const toUpdate = activeAlarms
    .map((a) => ({ a, db: existing.get(a.code) }))
    .filter(({ a, db }) => db && (db.text !== a.text || db.severity !== a.severity));

  for (const { a, db } of toUpdate) {
    const { error: updErr } = await supa
      .from('scada_alarms')
      .update({ text: a.text, severity: a.severity })
      .eq('id', db.id);
    if (updErr) throw new Error(`[scada] alarms update ${siteKey}: ${updErr.message}`);
  }

  if (toInsert.length) {
    const { error: insErr } = await supa.from('scada_alarms').insert(toInsert);
    if (insErr) throw new Error(`[scada] alarms insert ${siteKey}: ${insErr.message}`);
    log.warn({ siteKey, codes: toInsert.map((a) => a.code) }, 'novi alarmi');
  }
  if (toClear.length) {
    const { error: clrErr } = await supa
      .from('scada_alarms')
      .update({ active: false, cleared_at: new Date().toISOString() })
      .in('id', toClear);
    if (clrErr) throw new Error(`[scada] alarms clear ${siteKey}: ${clrErr.message}`);
    log.info({ siteKey, cleared: toClear.length }, 'alarmi očišćeni');
  }
}

/**
 * Jedan puni prolaz: povuci svih 5 sistema sa lokalnog SCADA API-ja,
 * normalizuj i upiši u Supabase. Sistem koji ne odgovori → online=false
 * (ostali nastavljaju — Promise.allSettled).
 *
 * @param {object} opts
 * @param {boolean} opts.withHistory  — upiši i scada_history uzorke (throttle-uje loop)
 * @param {boolean} opts.logRun       — upiši bridge_sync_log red (za one-shot CLI; loop NE loguje svaki tick)
 */
export async function scadaSnapshotOnce({ withHistory = true, logRun = false } = {}) {
  const run = logRun ? await startRun('scada_snapshot') : null;
  const supa = getSupabase();
  const now = new Date();
  // history ts poravnat na minut → PK (site,metric,ts) prirodno dedupuje uzorke
  const histTs = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();

  try {
    const siteKeys = Object.keys(FETCHERS);
    const results = await Promise.allSettled(siteKeys.map((k) => FETCHERS[k]()));

    let okCount = 0;
    let histCount = 0;
    const historyRows = [];

    for (let i = 0; i < siteKeys.length; i++) {
      const siteKey = siteKeys[i];
      const r = results[i];
      const norm =
        r.status === 'fulfilled'
          ? NORMALIZERS[siteKey](r.value)
          : { online: false, payload: { error: String(r.reason?.message || r.reason) }, history: [], alarms: [] };

      if (r.status === 'rejected') {
        log.warn({ siteKey, err: String(r.reason?.message || r.reason) }, 'sistem nedostupan');
      } else {
        okCount += 1;
      }

      const { error: snapErr } = await supa.from('scada_snapshots').upsert(
        {
          site_key: siteKey,
          payload: norm.payload,
          online: norm.online,
          updated_at: now.toISOString(),
        },
        { onConflict: 'site_key' },
      );
      if (snapErr) throw new Error(`[scada] snapshot upsert ${siteKey}: ${snapErr.message}`);

      const { error: siteErr } = await supa
        .from('scada_sites')
        .update({ online: norm.online, last_seen: now.toISOString() })
        .eq('key', siteKey);
      if (siteErr) throw new Error(`[scada] site update ${siteKey}: ${siteErr.message}`);

      if (withHistory && norm.history.length) {
        for (const h of norm.history) {
          historyRows.push({ site_key: siteKey, metric: h.metric, ts: histTs, value: h.value });
        }
      }

      await syncAlarms(supa, siteKey, norm.alarms);
    }

    if (historyRows.length) {
      const { error: histErr } = await supa
        .from('scada_history')
        .upsert(historyRows, { onConflict: 'site_key,metric,ts' });
      if (histErr) throw new Error(`[scada] history upsert: ${histErr.message}`);
      histCount = historyRows.length;
    }

    if (run) await finishRun(run, { rowsUpdated: siteKeys.length, rowsInserted: histCount });
    log.debug({ okCount, histCount, withHistory }, 'snapshot pass done');
    return { okCount, histCount };
  } catch (err) {
    if (run) await failRun(run, err);
    throw err;
  }
}

/**
 * Retencija istorije — briše uzorke starije od SCADA_HISTORY_RETENTION_DAYS.
 * Poziva se jednom dnevno iz loop-a.
 */
export async function scadaHistoryCleanup() {
  const days = config.scada.historyRetentionDays;
  if (!days || days <= 0) return;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const supa = getSupabase();
  const { error } = await supa.from('scada_history').delete().lt('ts', cutoff);
  if (error) {
    log.warn({ err: error.message }, 'history cleanup failed (nastavljamo)');
    return;
  }
  log.info({ cutoff, days }, 'history retention cleanup done');
}

import { config } from '../config.js';
import { getScadaStore } from '../db/scadaStore.js';
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
 *
 * 🔴 OVAJ DIFF GASI I `BRIDGE_STALE`: watchdog (pg_cron u sy15 / posao
 * `scada-watchdog` u 3.0) ume samo da UBACI alarm da se relej ne javlja, ali ne i
 * da ga skloni. Kad se relej vrati, taj kod nije u `activeAlarms` uređaja pa upada
 * u `toClear` i ovde se zatvori. Zato watchdog i relej NISU dva pisca nad istim
 * redom: jedan otvara, drugi zatvara.
 */
async function syncAlarms(store, siteKey, activeAlarms) {
  const dbRows = await store.listActiveAlarms(siteKey);

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
    await store.updateAlarm(db.id, { text: a.text, severity: a.severity });
  }

  if (toInsert.length) {
    await store.insertAlarms(toInsert);
    log.warn({ siteKey, codes: toInsert.map((a) => a.code) }, 'novi alarmi');
  }
  if (toClear.length) {
    await store.clearAlarms(toClear);
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
  // Store bira prekidač `SCADA_IZVOR` (sy15 PostgREST / 3.0 direktan Postgres).
  // `startRun`/`finishRun` NAMERNO ostaju na sy15: `bridge_sync_log` je dnevnik
  // releja, ne SCADA podatak (v. scadaStore.js).
  const store = getScadaStore();
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

      await store.upsertSnapshot({
        site_key: siteKey,
        payload: norm.payload,
        online: norm.online,
        updated_at: now.toISOString(),
      });

      await store.updateSite(siteKey, {
        online: norm.online,
        last_seen: now.toISOString(),
      });

      if (withHistory && norm.history.length) {
        for (const h of norm.history) {
          historyRows.push({ site_key: siteKey, metric: h.metric, ts: histTs, value: h.value });
        }
      }

      await syncAlarms(store, siteKey, norm.alarms);
    }

    if (historyRows.length) {
      await store.upsertHistory(historyRows);
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
 *
 * 🔴 POD `SCADA_IZVOR=3.0` OVO NE RADI NIŠTA — retenciju preuzima 3.0 scheduler
 * (posao `scada-retention`, isti rok od 90 dana, sa dnevnikom u `scheduled_job_runs`).
 * Da su ostala oba, brisala bi ista dva mehanizma istu tabelu; a scheduler je i
 * ispravnije mesto, jer relej o bazi ne zna ništa osim da u nju upisuje.
 * Pod `sy15` ostaje netaknuto (i to je putanja na koju se vraćamo pri povratku).
 */
export async function scadaHistoryCleanup() {
  const store = getScadaStore();
  if (store.izvor === '3.0') return;
  const days = config.scada.historyRetentionDays;
  if (!days || days <= 0) return;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    await store.deleteHistoryBefore(cutoff);
  } catch (err) {
    log.warn({ err: err.message }, 'history cleanup failed (nastavljamo)');
    return;
  }
  log.info({ cutoff, days }, 'history retention cleanup done');
}

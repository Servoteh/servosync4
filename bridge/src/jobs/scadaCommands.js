import { notifyError, notifyInfo } from '../alerts/notifier.js';
import { config } from '../config.js';
import { getSupabase } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { validateCommand } from '../scada/allowlist.js';
import { scadaSnapshotOnce } from './scadaSnapshot.js';

const log = logJob('scada_commands');

/* Posle primenjene komande UI treba ODMAH da vidi novu vrednost, a redovni
   snapshot ide tek na SCADA_SNAPSHOT_MS (5 s). Zato okinemo vanredni snapshot
   pass ~1.2 s posle primene (dovoljno da scada-app preko WS/poll-a preuzme
   novo stanje uređaja). Coalesce: jedan zakazan refresh po naletu komandi. */
let _refreshTimer = null;
function scheduleImmediateRefresh() {
  if (_refreshTimer) return;
  _refreshTimer = setTimeout(async () => {
    _refreshTimer = null;
    try {
      await scadaSnapshotOnce({ withHistory: false });
      log.debug('vanredni snapshot posle komande');
    } catch (err) {
      log.warn({ err }, 'vanredni snapshot posle komande nije uspeo');
    }
  }, 1200);
}

/* Rate-limit po sistemu: max N IZVRŠENIH komandi u kliznom minutu.
   Preko limita → rejected (audit ostaje), da se spreči "mašinsko" slanje. */
const _executedAt = new Map(); // site_key → [timestamps]

function rateLimited(siteKey) {
  const now = Date.now();
  const arr = (_executedAt.get(siteKey) || []).filter((t) => now - t < 60_000);
  _executedAt.set(siteKey, arr);
  return arr.length >= config.scada.cmdRatePerMin;
}

function markExecuted(siteKey) {
  const arr = _executedAt.get(siteKey) || [];
  arr.push(Date.now());
  _executedAt.set(siteKey, arr);
}

async function setOutcome(supa, id, status, result) {
  const patch = { status, result };
  if (status === 'applied' || status === 'failed') patch.applied_at = new Date().toISOString();
  const { error } = await supa.from('scada_commands').update(patch).eq('id', id);
  if (error) log.error({ id, status, err: error.message }, 'ne mogu da upišem ishod komande');
}

/**
 * Jedan poll prolaz komandi:
 *   1. RPC scada_claim_commands (pending → claimed, FOR UPDATE SKIP LOCKED,
 *      istekle automatski → expired)
 *   2. kill-switch (SCADA_CONTROL=false) → rejected
 *   3. allowlist validacija → rejected ako nije dozvoljeno
 *   4. rate-limit po sistemu → rejected
 *   5. izvršenje kroz SCADA app write endpoint → applied | failed (+result)
 * Svaki red u scada_commands je trajni audit — nikad se ne briše.
 */
export async function scadaCommandsOnce() {
  const supa = getSupabase();
  const { data: claimed, error } = await supa.rpc('scada_claim_commands', { p_limit: 10 });
  if (error) throw new Error(`[scada] claim_commands RPC: ${error.message}`);
  if (!claimed?.length) return { processed: 0 };

  let applied = 0;
  for (const cmd of claimed) {
    const ctx = { id: cmd.id, site: cmd.site_key, target: cmd.target, by: cmd.requested_by };

    if (!config.scada.control) {
      await setOutcome(supa, cmd.id, 'rejected', { error: 'SCADA_CONTROL=false (kill-switch)' });
      log.warn(ctx, 'komanda odbijena — kill-switch');
      continue;
    }

    const check = validateCommand(cmd);
    if (!check.ok) {
      await setOutcome(supa, cmd.id, 'rejected', { error: check.reason });
      log.warn({ ...ctx, reason: check.reason }, 'komanda van allowlist-a');
      continue;
    }

    if (rateLimited(cmd.site_key)) {
      await setOutcome(supa, cmd.id, 'rejected', {
        error: `rate-limit: max ${config.scada.cmdRatePerMin} komandi/min po sistemu`,
      });
      log.warn(ctx, 'komanda odbijena — rate-limit');
      continue;
    }

    try {
      const res = await check.exec();
      markExecuted(cmd.site_key);
      await setOutcome(supa, cmd.id, 'applied', { ok: true, response: res ?? null });
      applied += 1;
      log.info({ ...ctx, value: cmd.value }, 'komanda primenjena');
      // info alert (throttle 1h po jobu) — daljinska komanda je događaj vredan traga.
      // Escape Markdown znakova (_ * ` [) — inače Telegram odbija poruku.
      const mdSafe = (s) => String(s).replace(/([_*`[\]])/g, '\\$1');
      notifyInfo({
        title: 'SCADA komanda primenjena',
        body: mdSafe(`${cmd.site_key} > ${cmd.target} = ${JSON.stringify(cmd.value)} (${cmd.requested_by})`),
      });
    } catch (err) {
      if (err?.reject) {
        // validacija u exec fazi (npr. Loxone max po tagu) → rejected, ne failed
        await setOutcome(supa, cmd.id, 'rejected', { error: String(err.message) });
        log.warn({ ...ctx, reason: err.message }, 'komanda odbijena u exec validaciji');
        continue;
      }
      await setOutcome(supa, cmd.id, 'failed', { error: String(err?.message || err) });
      log.error({ ...ctx, err }, 'komanda neuspešna');
      notifyError({ jobName: 'scada_commands', error: err, context: `${cmd.site_key}/${cmd.target}` });
    }
  }
  if (applied > 0) scheduleImmediateRefresh();
  return { processed: claimed.length, applied };
}

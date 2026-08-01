import { config } from '../config.js';
import { logJob } from '../logger.js';

const log = logJob('notifier');

/**
 * Notifier — šalje alert kad neki sync job pukne.
 *
 * Podržani kanali (svi opcioni, kontrolisani env vars-ima):
 *   - Telegram bot   → ALERT_TELEGRAM_BOT_TOKEN + ALERT_TELEGRAM_CHAT_ID
 *   - Generic webhook → ALERT_WEBHOOK_URL (POST application/json)
 *                       Kompatibilan sa: Slack, Discord, MS Teams, Mattermost,
 *                       Cloudflare Worker, custom backend.
 *
 * Ako nijedan kanal nije konfigurisan, notifier "tiho" loguje upozorenje
 * jednom na startupu i kasnije nema overhead-a.
 *
 * Async + non-throwing: notifier NIKAD ne sme da ruši sync. Sve greške
 * hvata interno i loguje kao warn.
 *
 * Throttling: zaustavlja pozive ka istom kanalu ako se isti job ponavlja
 * sa istom greškom u zadnjih `RATE_LIMIT_MS`. Sprečava spam ako jedan job
 * pukne 96x dnevno (svakih 15 min).
 */

const RATE_LIMIT_MS = 60 * 60 * 1000; // 1h
const _lastSent = new Map(); // key = `${channel}:${jobName}` → timestamp

function _isRateLimited(channel, jobName) {
  const key = `${channel}:${jobName}`;
  const last = _lastSent.get(key);
  if (last && Date.now() - last < RATE_LIMIT_MS) return true;
  _lastSent.set(key, Date.now());
  return false;
}

function _truncate(s, n = 1000) {
  if (s == null) return '';
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…(truncated)` : str;
}

async function _sendTelegram(message) {
  const { telegramBotToken, telegramChatId } = config.alerts;
  if (!telegramBotToken || !telegramChatId) return;
  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn({ status: res.status, body: _truncate(body, 200) }, 'telegram send failed');
    } else {
      log.debug('telegram alert sent');
    }
  } catch (err) {
    log.warn({ err: err?.message || err }, 'telegram send threw');
  }
}

async function _sendWebhook(message, payload) {
  const url = config.alerts.webhookUrl;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // Slack/Mattermost koriste `text`; Discord koristi `content`. Šaljem oba.
        text: message,
        content: message,
        username: 'Servoteh Bridge',
        instance: config.instanceName,
        ...payload,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn({ status: res.status, body: _truncate(body, 200) }, 'webhook send failed');
    } else {
      log.debug('webhook alert sent');
    }
  } catch (err) {
    log.warn({ err: err?.message || err }, 'webhook send threw');
  }
}

let _startupLogged = false;
function _logStartupOnce() {
  if (_startupLogged) return;
  _startupLogged = true;
  const enabled = [];
  if (config.alerts.telegramBotToken && config.alerts.telegramChatId) enabled.push('telegram');
  if (config.alerts.webhookUrl) enabled.push('webhook');
  if (enabled.length === 0) {
    log.warn(
      'no alert channels configured (set ALERT_TELEGRAM_* and/or ALERT_WEBHOOK_URL in .env)',
    );
  } else {
    log.info({ channels: enabled }, 'alert channels active');
  }
}

/**
 * Pošalji alert da je job pukao. Non-blocking: vraća se ODMAH (`fire and forget`),
 * a Promise ide u pozadinu. Pozivaoci ne treba da `await` ovo — failRun u
 * syncLog.js radi `notifyError(...)` bez await-a.
 *
 * @param {object} args
 * @param {string} args.jobName     "production_work_orders" itd.
 * @param {Error|string} args.error
 * @param {object} [args.run]       { id, startedAt }
 * @param {string} [args.context]   dodatni kontekst (npr. "during fetch")
 */
export function notifyError({ jobName, error, run, context }) {
  _logStartupOnce();
  const errMsg = error?.message ? String(error.message) : String(error || 'unknown');
  const stack = error?.stack ? String(error.stack).split('\n').slice(0, 6).join('\n') : '';
  const duration = run?.startedAt
    ? Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000)
    : null;

  if (_isRateLimited('any', jobName)) {
    log.debug({ jobName }, 'alert rate-limited (same job within 1h)');
    return;
  }

  const message = [
    `🚨 *Servoteh Bridge — sync greška*`,
    '',
    `*Job:* \`${jobName}\``,
    `*Instance:* \`${config.instanceName}\``,
    context ? `*Kontekst:* ${context}` : null,
    duration != null ? `*Trajanje:* ${duration}s` : null,
    `*Greška:* \`${_truncate(errMsg, 300)}\``,
    stack ? `\n\`\`\`\n${_truncate(stack, 600)}\n\`\`\`` : null,
    '',
    `_Vreme: ${new Date().toISOString()}_`,
  ]
    .filter(Boolean)
    .join('\n');

  Promise.allSettled([
    _sendTelegram(message),
    _sendWebhook(message, {
      level: 'error',
      job: jobName,
      run_id: run?.id ?? null,
      duration_seconds: duration,
      error_message: _truncate(errMsg, 1000),
      stack: _truncate(stack, 2000),
      context: context || null,
      timestamp: new Date().toISOString(),
    }),
  ]).catch(() => {});
}

/**
 * Opcioni heartbeat (npr. dnevni sažetak da Bridge radi). Trenutno ne pozivaju
 * jobovi, ali ostavljam helper za buduća proširenja (Cloudflare Worker dashboard
 * koji periodično šalje "all OK" potvrdu).
 *
 * @param {object} args
 * @param {string} args.title
 * @param {string} args.body
 */
export function notifyInfo({ title, body }) {
  _logStartupOnce();
  if (_isRateLimited('info', title)) return;
  const message = `ℹ️ *${title}*\n\n${body}\n\n_${new Date().toISOString()}_`;
  Promise.allSettled([
    _sendTelegram(message),
    _sendWebhook(message, {
      level: 'info',
      title,
      timestamp: new Date().toISOString(),
    }),
  ]).catch(() => {});
}

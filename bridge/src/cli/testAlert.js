/**
 * CLI test za alerting kanale (Telegram, webhook).
 *
 * Šalje fake error alert pa info alert kroz `notifyError`/`notifyInfo`,
 * tako da možeš da proveriš da li su .env vars ispravno postavljeni i
 * da li poruke stižu — bez da praviš pravu sync grešku.
 *
 * Upotreba:
 *   npm run test:alert
 *
 * Šta očekivati u Telegramu (ako je Telegram konfigurisan):
 *   1) Poruka tipa "🚨 Servoteh Bridge — sync greška" sa fake job-om "test_alert"
 *   2) Poruka tipa "ℹ️ Test alert"
 *
 * Ako ne stigne ništa — vidi README.md → "Troubleshooting → Telegram alert
 * ne stiže iako je .env popunjen".
 */
import { config, describeConfig } from '../config.js';
import { logger } from '../logger.js';
import { notifyError, notifyInfo } from '../alerts/notifier.js';

async function main() {
  logger.info({ config: describeConfig() }, 'test:alert starting');

  const tg = !!(config.alerts.telegramBotToken && config.alerts.telegramChatId);
  const wh = !!config.alerts.webhookUrl;

  if (!tg && !wh) {
    logger.error(
      'Nijedan alert kanal nije konfigurisan. Setuj ALERT_TELEGRAM_BOT_TOKEN+ALERT_TELEGRAM_CHAT_ID i/ili ALERT_WEBHOOK_URL u .env i pokušaj ponovo.',
    );
    process.exit(2);
  }

  logger.info({ telegram: tg, webhook: wh }, 'sending fake error alert');
  notifyError({
    jobName: 'test_alert',
    error: new Error('Ovo je TEST poruka iz `npm run test:alert`. Sve OK ako vidiš ovo u Telegramu.'),
    run: { id: 0, startedAt: new Date(Date.now() - 1234) },
    context: 'CLI test (nije prava greška)',
  });

  // Mali delay pa info alert
  await new Promise((r) => setTimeout(r, 1500));

  logger.info('sending fake info alert');
  notifyInfo({
    title: 'Test alert',
    body: 'Ovo je test info poruka. Ako vidiš obe poruke (error + info) u Telegramu, alerting radi savršeno.',
  });

  // Sačekaj da fire-and-forget pozivi završe (HTTP request ka Telegram API-u
  // tipično traje 200–500ms; dajemo 4s da budemo sigurni).
  logger.info('waiting 4s for HTTP requests to complete…');
  await new Promise((r) => setTimeout(r, 4000));

  logger.info('done. Proveri Telegram chat / webhook destinaciju.');
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, 'test:alert crashed');
  process.exit(1);
});

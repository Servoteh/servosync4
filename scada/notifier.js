// Telegram alarm notifier (uzeto iz servoteh-bridge obrasca). Opciono — ako nema
// tokena, tiho ne radi nista. Rate-limit 1h po istom alarmu (bez spama).
const TOKEN = () => process.env.ALERT_TELEGRAM_BOT_TOKEN || '';
const CHAT = () => process.env.ALERT_TELEGRAM_CHAT_ID || '';
const RATE_MS = 60 * 60 * 1000;
const last = new Map();
const active = new Set();   // kljucevi za koje je alarm stvarno poslat (da `clear` ne salje lazni "OK")

async function send(text) {
  if (!TOKEN() || !CHAT()) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT(), text, disable_web_page_preview: true }),
    });
  } catch (e) { /* nikad ne ruši server */ }
}

// edge-triggered alarm (zove se samo na prelaz 0->1). `site` = postrojenje
// (KOTLARNICA podrazumevano; solarna elektrana salje "FNE SERVOTEH" itd.)
function alarm(key, label, site = 'KOTLARNICA') {
  const now = Date.now();
  if (last.get(key) && now - last.get(key) < RATE_MS) return;
  last.set(key, now);
  active.add(key);
  send(`🚨 ${site} — ALARM: ${label}\n${new Date().toLocaleString('sr-RS')}`);
}
// Salje "prošao" SAMO ako je za taj kljuc alarm ranije i poslat; ujedno oslobadja rate-limit,
// pa se ponovna pojava istog kvara odmah javlja (a ne tek posle sata).
function clear(key, label, site = 'KOTLARNICA') {
  if (!active.has(key)) return;
  active.delete(key);
  last.delete(key);
  send(`✅ ${site} — alarm prošao: ${label}\n${new Date().toLocaleString('sr-RS')}`);
}
function configured() { return !!(TOKEN() && CHAT()); }

module.exports = { send, alarm, clear, configured };

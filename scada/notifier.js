// Dojava alarma. Dva kanala, NAMERNO razdvojena po strogosti:
//
//   Telegram  — svaki alarm (radna grupa prati sve)
//   E-mail    — SAMO kriticno, uzak spisak (ALERT_MAIL_CODES u server.js)
//
// Zasto: 30.07.2026. mereno na zivim podacima — zastitne sklopke kotlarnice 2 podizu
// se ~68 puta DNEVNO po kodu (1839 puta od 02.07). Da je mejl vezan na "sve alarme",
// bile bi stotine poruka dnevno i niko ih ne bi citao. Mejl zato ide kroz dozvoljeni
// spisak kodova + uslov da kvar POTRAJE, a ne na svaku promenu stanja.
const TOKEN = () => process.env.ALERT_TELEGRAM_BOT_TOKEN || '';
const CHAT = () => process.env.ALERT_TELEGRAM_CHAT_ID || '';
const RESEND_KEY = () => process.env.RESEND_API_KEY || '';
const MAIL_FROM = () => process.env.ALERT_MAIL_FROM || 'obavestenja@servoteh.com';
const MAIL_TO = () => (process.env.ALERT_MAIL_TO || '').split(',').map(s => s.trim()).filter(Boolean);
const MAIL_MAX_PER_DAY = () => Math.max(1, parseInt(process.env.ALERT_MAIL_MAX_PER_DAY || '12', 10));
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

// ---- E-MAIL (Resend, isti nalog kao 4.0: from obavestenja@servoteh.com) ----
// Bez novih zavisnosti — obican fetch. Dnevna kapica je tvrda brana od poplave:
// i ako neki alarm pocne da trepce, ne moze poslati vise od ALERT_MAIL_MAX_PER_DAY.
let mailDay = '', mailCount = 0;
function mailConfigured() { return !!(RESEND_KEY() && MAIL_TO().length); }

async function mail(subject, lines) {
  if (!mailConfigured()) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== mailDay) { mailDay = today; mailCount = 0; }
  if (mailCount >= MAIL_MAX_PER_DAY()) return false;      // dnevna kapica
  const n = ++mailCount;   // zapamti redni broj OVDE — log ide posle await-a
  const text = [...lines, '', `Vreme: ${new Date().toLocaleString('sr-RS')}`,
                'Poruka je automatska — SCADA gateway (scada-app).'].join('\n');
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM(), to: MAIL_TO(), subject, text }),
    });
    if (!res.ok) { console.warn('[mail] Resend ' + res.status + ': ' + (await res.text().catch(() => ''))); return false; }
    console.log(`[mail] poslato (${n}/${MAIL_MAX_PER_DAY()} danas): ${subject}`);
    return true;
  } catch (e) { console.warn('[mail] ' + e.message); return false; }
}

// Kriticni alarm: Telegram ODMAH + mejl. Mejl ima svoj kljuc i svoj rate-limit,
// pa gasenje/paljenje Telegrama ne utice na njega.
function critical(key, subject, lines, site = 'KOTLARNICA') {
  alarm(key, subject, site);
  const now = Date.now();
  const mk = 'mail:' + key;
  if (last.get(mk) && now - last.get(mk) < RATE_MS) return;
  last.set(mk, now);   // NAMERNO se ne upisuje u `active` — "alarm prosao" NIKAD ne ide na mejl
  mail(subject, lines).catch(() => {});
}

module.exports = { send, alarm, clear, critical, mail, configured, mailConfigured };

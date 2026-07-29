// meteocontrol blue'Log X-series (XM/XC) — lokalni HTTP klijent (isti REST koji koristi web "cockpit").
// Solarna elektrana (FNE) @ 192.168.75.15.  Uredjaj: blue'Log X-Control, fw 30.x, web app v30.x.
//
// AUTH (rekonstruisano iz aplikacije):
//   1) GET /                      -> server postavi cookie  csrf-token (+ .sig) i koa.sess (+ .sig)
//   2) POST /login  {username, password: MD5(password)}   header  X-CSRF-Token: <csrf-token>
//      -> 200 + {username, accessLevel, ...}  (sesija u koa.sess cookie-ju)  |  401 = pogresni kredencijali
//   Lozinka se HESUJE na klijentu (standardni MD5 hex, mala slova) — plaintext daje 401.
//
// NAPOMENA: ovo je NEZVANICAN interfejs (privatni Angular backend). meteocontrol ga ne dokumentuje i
// menja kroz firmware — pri update-u loggera proveri rute/auth (vidi bluelog/discover.js).
// Zvanicna, robusna alternativa je SCADA licenca (Modbus TCP, item 557.009) — vidi memoriju projekta.

const crypto = require('crypto');

const md5hex = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

class BlueLog {
  constructor(host, user, pass, { timeoutMs = 8000 } = {}) {
    this.base = /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : `http://${host}`;
    this.user = user;
    this.pass = pass;
    this.timeoutMs = timeoutMs;
    this.cookies = new Map();   // name -> value (csrf-token, csrf-token.sig, koa.sess, koa.sess.sig)
    this.loggedIn = false;
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  _absorb(res) {
    // undici (Node 20): Headers.getSetCookie() vraca niz pojedinacnih Set-Cookie linija
    const sc = (typeof res.headers.getSetCookie === 'function' && res.headers.getSetCookie()) || [];
    for (const line of sc) {
      const m = line.match(/^\s*([^=;]+)=([^;]*)/);
      if (m) this.cookies.set(m[1].trim(), m[2]);
    }
  }
  async _fetch(p, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    const ck = this._cookieHeader();
    if (ck) headers['Cookie'] = ck;
    // CSRF token ide samo na mutirajuce zahteve (POST/PUT/DELETE)
    const method = opts.method || 'GET';
    if (method !== 'GET') {
      const csrf = this.cookies.get('csrf-token');
      if (csrf) headers['X-CSRF-Token'] = csrf;
      headers['Referer'] = this.base + '/';
    }
    const res = await fetch(this.base + p, {
      method,
      headers,
      body: opts.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this._absorb(res);
    return res;
  }

  // Prijava: seed sesije + csrf, pa POST /login sa MD5 lozinkom.
  async login() {
    await this._fetch('/');                                   // dobij csrf-token + koa.sess
    if (!this.cookies.get('csrf-token')) await this._fetch('/system/information'); // neki odgovori ne setuju csrf
    const res = await this._fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.user, password: md5hex(this.pass) }),
    });
    if (res.ok || res.status === 204) {
      this.loggedIn = true;
      return await res.json().catch(() => ({}));
    }
    const txt = await res.text().catch(() => '');
    const err = new Error(`login HTTP ${res.status}${txt ? ` — ${txt}` : ''}`);
    err.status = res.status;
    throw err;
  }

  // GET JSON sa auto-reloginom ako sesija istekne (401/403).
  async get(p) {
    let res = await this._fetch(p);
    if ((res.status === 401 || res.status === 403) && this.loggedIn) {
      this.loggedIn = false;
      await this.login();
      res = await this._fetch(p);
    }
    const ct = res.headers.get('content-type') || '';
    const body = ct.includes('json') ? await res.json().catch(() => null)
                                      : await res.text().catch(() => null);
    return { status: res.status, contentType: ct, body };
  }

  async info() { return (await this.get('/system/information')).body; }

  // Pregled postrojenja: {plantName, isAlarmActive, isActivePowerActive, isReactivePowerActive, ...}
  // isAlarmActive je zbirni "ima alarm" indikator loggera — jeftin poziv, cita se uz svaki poll.
  async overview() { return (await this.get('/overview/system-overview')).body; }

  // --- Solarna elektrana: uredjaji + zive vrednosti ---

  // Lista uredjaja (invertori, brojilo, sistem). [{id,type,name,vendor,model,address,driverName,...}]
  async getDevices() {
    const r = await this.get('/plant/scada-get-devices');
    return Array.isArray(r.body) ? r.body : [];
  }

  // POST /device/values — dateRange {min,max} su EPOCH MS (ne ISO!), deviceIds[] i abbreviations[].
  // Vraca {deviceId: {epochMs: {ABBR:value}}}.  minutes = koliko unazad (default 15).
  // (Podaci su rezolucije 1 min; poslednja ne-prazna tacka = trenutna vrednost.)
  async getDeviceValues(deviceIds, abbreviations, { minutes = 15 } = {}) {
    const ONE_MIN = 60000;
    const max = Math.floor(Date.now() / ONE_MIN) * ONE_MIN;
    const min = max - minutes * ONE_MIN;
    let res = await this._fetch('/device/values', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateRange: { min, max }, deviceIds, abbreviations }),
    });
    if ((res.status === 401 || res.status === 403) && this.loggedIn) {   // sesija istekla -> relogin
      this.loggedIn = false; await this.login();
      return this.getDeviceValues(deviceIds, abbreviations, { minutes });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`device/values HTTP ${res.status}${t ? ` — ${t}` : ''}`);
    }
    const raw = await res.json().catch(() => ({}));
    const out = {};
    for (const dev of Object.keys(raw)) {                                // raspakuj JSON-string vrednosti
      out[dev] = {};
      for (const ts of Object.keys(raw[dev])) {
        let v = {}; try { v = raw[dev][ts] ? JSON.parse(raw[dev][ts]) : {}; } catch (e) {}
        out[dev][ts] = v;
      }
    }
    return out;
  }

  // Lista dogadjaja (alarma) postrojenja. POST /alarm/alarms.
  // ZAMKA: telo MORA imati i `language` — bez njega logger vraca 400 WEB_SERVER_INVALID_REQUEST_DATA
  // (isto telo salje i cockpit: {dateRange:{min,max}, language}).  dateRange je EPOCH MS.
  // Zapis: {deviceId, deviceName, deviceAddress, devicePort, errorCode, errorMessage, start, end?}
  // Alarm je AKTIVAN dok nema `end` (npr. errorCode NOCOMM_RS485 = prekid RS485 komunikacije).
  async getAlarms({ days = 14, language = 'en' } = {}) {
    const max = Date.now();
    const min = max - days * 24 * 60 * 60 * 1000;
    const res = await this._fetch('/alarm/alarms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateRange: { min, max }, language }),
    });
    if ((res.status === 401 || res.status === 403) && this.loggedIn) {   // sesija istekla -> relogin
      this.loggedIn = false; await this.login();
      return this.getAlarms({ days, language });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`alarm/alarms HTTP ${res.status}${t ? ` — ${t}` : ''}`);
    }
    const body = await res.json().catch(() => []);
    return Array.isArray(body) ? body : [];
  }

  // Najnovija ne-prazna tacka po uredjaju: {deviceId: {ABBR:value, _ts}}
  async latestValues(deviceIds, abbreviations, opts) {
    const series = await this.getDeviceValues(deviceIds, abbreviations, opts);
    const latest = {};
    for (const dev of Object.keys(series)) {
      const tss = Object.keys(series[dev]).map(Number).sort((a, b) => a - b);
      latest[dev] = { _ts: null };
      for (let i = tss.length - 1; i >= 0; i--) {
        const v = series[dev][tss[i]];
        if (v && Object.keys(v).length) { latest[dev] = { ...v, _ts: tss[i] }; break; }
      }
    }
    return latest;
  }
}

module.exports = { BlueLog, md5hex };

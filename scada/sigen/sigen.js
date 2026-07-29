// Sigenergy Cloud OpenAPI klijent (solarna elektrana — PV + baterija + mreza).
// Zvanicni API: developer.sigencloud.com. Auth = AppKey/AppSecret (preporuka) ili
// mySigen username/password. Token Bearer ~12h. Region za Srbiju = "eu".
// VAZNO: rate-limit 1 zahtev po endpointu na 5 min -> poll na 300s (vidi server.js).
// Bez dependency-ja: koristi globalni fetch (Node >=20) kao loxone.js.

const REGION_URLS = {
  eu:  'https://openapi-eu.sigencloud.com',
  ap:  'https://openapi-apac.sigencloud.com',
  mea: 'https://openapi-eu.sigencloud.com',
  cn:  'https://openapi-cn.sigencloud.com',
  anz: 'https://openapi-aus.sigencloud.com',
  la:  'https://openapi-us.sigencloud.com',
  na:  'https://openapi-us.sigencloud.com',
  jp:  'https://openapi-jp.sigencloud.com',
};

// Operativni rezimi (energyStorageOperationMode)
// 9 = prilagodjeni profil samopotrosnje (mySigen: "SelfConsumption Copy") — potvrdio korisnik za Servoteh_110.
const OPERATING_MODES = {
  0: 'Maksimalna samopotrošnja',
  5: 'Pun izvoz u mrežu',
  6: 'VPP',
  8: 'Northbound',
  9: 'Samopotrošnja (prilagođeni profil)',
};
// Samo ova dva se mogu prebaciti komandom preko OpenAPI (NBI)
const SWITCHABLE_MODES = { 0: 'Maksimalna samopotrošnja', 5: 'Pun izvoz u mrežu' };

// Prolazne greske (cloud->uredjaj hikap) — zadrzi poslednju dobru vrednost
const TRANSIENT_CODES = new Set([1001, 1109, 13008]);
const TOKEN_BUFFER_S = 600; // osvezi token 10 min pre isteka

class SigenError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}
class SigenAuthError extends SigenError {}
class SigenRateLimit extends SigenError {}
class SigenTransient extends SigenError {}

class Sigen {
  // opts: { region, authMethod:'key'|'password', appKey, appSecret, username, password }
  constructor(opts = {}) {
    this.region = (opts.region || 'eu').toLowerCase();
    this.base = REGION_URLS[this.region] || REGION_URLS.eu;
    this.authMethod = opts.authMethod || (opts.appKey ? 'key' : 'password');
    this.appKey = opts.appKey;
    this.appSecret = opts.appSecret;
    this.username = opts.username;
    this.password = opts.password;
    this._token = null;
    this._tokenExp = 0; // unix sekunde
  }

  get tokenValid() {
    return this._token && (Date.now() / 1000) < (this._tokenExp - TOKEN_BUFFER_S);
  }

  async authenticate() {
    if (this.authMethod === 'key') {
      const enc = Buffer.from(`${this.appKey}:${this.appSecret}`).toString('base64');
      const d = await this._rawPost('/openapi/auth/login/key', { key: enc }, false);
      this._parseToken(d);
    } else {
      const d = await this._rawPost('/openapi/auth/login/password',
        { username: this.username, password: this.password }, false);
      this._parseToken(d);
    }
  }

  _parseToken(d) {
    const code = d.code ?? -1;
    if (code !== 0) {
      const msg = d.msg || 'nepoznata greška';
      if (code === 11002 || code === 11003) throw new SigenAuthError(msg, code);
      throw new SigenError(`${msg} (code ${code})`, code);
    }
    let td = d.data;
    if (typeof td === 'string') td = JSON.parse(td);
    this._token = td.accessToken;
    this._tokenExp = (Date.now() / 1000) + (td.expiresIn || 43199);
  }

  async _ensureToken() { if (!this.tokenValid) await this.authenticate(); }

  async _rawPost(path, payload, authenticated = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (authenticated) { await this._ensureToken(); headers.Authorization = `Bearer ${this._token}`; }
    const res = await fetch(this.base + path, {
      method: 'POST', headers, body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429) throw new SigenRateLimit('Rate limit (HTTP 429)');
    if (!res.ok) throw new SigenError(`HTTP ${res.status}`);
    return res.json();
  }

  async _rawGet(path, params) {
    await this._ensureToken();
    const url = new URL(this.base + path);
    if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this._token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429) throw new SigenRateLimit('Rate limit (HTTP 429)');
    if (!res.ok) throw new SigenError(`HTTP ${res.status}`);
    return res.json();
  }

  _check(d, path) {
    const code = d.code ?? -1;
    if (code === 1110) throw new SigenRateLimit('Interfejs rate-limited (1110)');
    if (code === 1201) throw new SigenRateLimit('Pristup ograničen (1201)');
    if (code === 11002 || code === 11003) throw new SigenAuthError(d.msg || 'Auth greška', code);
    if (TRANSIENT_CODES.has(code)) throw new SigenTransient(d.msg || 'prolazna greška', code);
    if (code !== 0) throw new SigenError(`${d.msg || 'greška'} (code ${code}) @ ${path}`, code);
    return d;
  }

  // data moze biti JSON-string -> parsiraj
  static _parse(v) {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
    return v;
  }

  async _get(path, params) { return this._check(await this._rawGet(path, params), path); }
  async _post(path, payload) { return this._check(await this._rawPost(path, payload), path); }

  // ── Inventar ───────────────────────────────────────────────
  async getSystemList() {
    const d = await this._get('/openapi/system');
    const r = Sigen._parse(d.data ?? []);
    return Array.isArray(r) ? r : [];
  }

  // ── Realtime ───────────────────────────────────────────────
  async getEnergyFlow(systemId) {
    const d = await this._get(`/openapi/systems/${systemId}/energyFlow`, { systemId });
    return Sigen._parse(d.data ?? {}) || {};
  }
  async getSummary(systemId) {
    const d = await this._get(`/openapi/systems/${systemId}/summary`, { systemId });
    return Sigen._parse(d.data ?? {}) || {};
  }

  // ── Operativni rezim ───────────────────────────────────────
  async getOperatingMode(systemId) {
    const d = await this._get(`/openapi/instruction/${systemId}/settings`, { systemId });
    const r = Sigen._parse(d.data ?? {});
    return (r && typeof r === 'object') ? (r.energyStorageOperationMode ?? null) : null;
  }
  async setOperatingMode(systemId, mode) {
    return this._post(`/openapi/instruction/${systemId}/settings`,
      { systemId, energyStorageOperationMode: mode });
  }

  async validate() { await this.authenticate(); }
}

module.exports = {
  Sigen, SigenError, SigenAuthError, SigenRateLimit, SigenTransient,
  OPERATING_MODES, SWITCHABLE_MODES, REGION_URLS,
};

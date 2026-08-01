// Siemens S7-1200 (CPU 1214C) — AWP web-server klijent za "Termoregulacija hala TIA" (HALA 5).
// FAZA 1: čita/piše DB "Web" SIMBOLIČKI preko ugrađenog web servera (port 443, admin/admin),
// bez ikakvih izmena na PLC-u (ne treba TIA, ni PUT/GET, ni OPC UA).
// READ  = GET /awp/Servoteh/{update_page,start}.html -> parsiraj žive vrednosti.
// WRITE = POST /awp/Servoteh/start.html  body  "Web".Tag=1/0  (kao forme u HMI-u).
// Login (reverse-engineered): GET /Default.mwsl (seed cookie) -> POST /FormLogin
//   (Login/Password/Redirection + Referer) -> siemens_ad_session(+secure). Bez sesije = redirect stub.
// Bez dependency-ja: čist https modul (PLC ima self-signed sertifikat -> rejectUnauthorized:false).

const https = require('https');

const AWP = '/awp/Servoteh/';

class S7Web {
  constructor(host, user = 'admin', pass = 'admin') {
    this.host = host;
    this.user = user;
    this.pass = pass;
    this.cookies = {};          // name -> value
    this.loggedIn = false;
  }

  _cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  _absorbCookies(res) {
    const sc = res.headers['set-cookie'];
    if (!sc) return;
    for (const line of sc) {
      const m = line.match(/^\s*([^=]+)=([^;]*)/);
      if (m) this.cookies[m[1].trim()] = m[2];
    }
  }

  // niskonivoski https zahtev; vraća {status, headers, body}
  _req(method, path, { body = null, headers = {}, type = null } = {}) {
    return new Promise((resolve, reject) => {
      const data = body == null ? null : Buffer.from(body);
      const opts = {
        host: this.host, port: 443, method, path,
        rejectUnauthorized: false,            // PLC self-signed
        headers: {
          ...(this._cookieHeader() ? { Cookie: this._cookieHeader() } : {}),
          ...(type ? { 'Content-Type': type } : {}),
          ...(data ? { 'Content-Length': data.length } : {}),
          ...headers,
        },
      };
      const req = https.request(opts, res => {
        this._absorbCookies(res);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('timeout')));
      if (data) req.write(data);
      req.end();
    });
  }

  async login() {
    this.cookies = {};
    // 1) seed cookie
    await this._req('GET', '/Default.mwsl');
    // 2) prijava
    const body =
      `Login=${encodeURIComponent(this.user)}` +
      `&Password=${encodeURIComponent(this.pass)}` +
      `&Redirection=${encodeURIComponent('/Portal/Portal.mwsl')}`;
    const res = await this._req('POST', '/FormLogin', {
      body, type: 'application/x-www-form-urlencoded',
      headers: { Referer: `https://${this.host}/Portal/Portal.mwsl?PriNav=Awp` },
    });
    // uspeh = 302 + nova sesija
    this.loggedIn = !!this.cookies['siemens_ad_session'];
    if (!this.loggedIn) throw new Error(`login neuspeo (HTTP ${res.status})`);
    return true;
  }

  _isStub(body) {
    return !body || body.length < 600 || /not automatically redirected/i.test(body);
  }

  async _getPage(name) {
    if (!this.loggedIn) await this.login();
    let r = await this._req('GET', AWP + name);
    if (this._isStub(r.body)) {          // sesija istekla -> ponovo login pa pokušaj još jednom
      await this.login();
      r = await this._req('GET', AWP + name);
      if (this._isStub(r.body)) throw new Error(`ne mogu da učitam ${name} (stub i posle login-a)`);
    }
    return r.body;
  }

  // Pročitaj kompletno živo stanje (oba AWP fajla).
  async readAll() {
    const upd = await this._getPage('update_page.html');
    const start = await this._getPage('start.html');
    const raw = {};
    // var X = '...'  iz OBE stranice: update_page.html (modovi/reči/alarmi/timeri) je primarni,
    // start.html dopunjava (raspored H*vreme, Temperature). update_page ima prednost kod preklapanja.
    for (const m of upd.matchAll(/var\s+([A-Za-z0-9_]+)\s*=\s*'([^']*)'/g)) raw[m[1]] = m[2];
    for (const m of start.matchAll(/var\s+([A-Za-z0-9_]+)\s*=\s*'([^']*)'/g))
      if (raw[m[1]] === undefined) raw[m[1]] = m[2];
    // start.html: temperature iz <div id="Temp_X">value</div>
    for (const m of start.matchAll(/<div id="(Temp_[A-Za-z0-9_]+)"[^>]*>([^<]*)<\/div>/g)) raw[m[1]] = m[2].trim();
    // setpoint: Temperature='NN'
    const sp = start.match(/Temperature\s*=\s*'(-?\d+)'/);
    if (sp) raw.Zeljena_temperatura = sp[1];
    return raw;
  }

  // WRITE: postavi jednu AWP promenljivu DB "Web" (npr. ('Web_P1', 1)).
  // POST na start.html sa poljem  "Web".<tag>=<value>  (kao HMI forme).
  async write(tag, value) {
    if (!this.loggedIn) await this.login();
    const field = encodeURIComponent(`"Web".${tag}`) + '=' + encodeURIComponent(String(value));
    let r = await this._req('POST', AWP + 'start.html', {
      body: field, type: 'application/x-www-form-urlencoded',
      headers: { Referer: `https://${this.host}${AWP}start.html` },
    });
    if (r.status === 401 || r.status === 403 || this._isStub(r.body)) {
      await this.login();
      r = await this._req('POST', AWP + 'start.html', {
        body: field, type: 'application/x-www-form-urlencoded',
        headers: { Referer: `https://${this.host}${AWP}start.html` },
      });
    }
    if (r.status >= 400) throw new Error(`upis ${tag}=${value} -> HTTP ${r.status}`);
    return true;
  }
}

module.exports = { S7Web };

// Loxone WebSocket klijent — živo stanje SVIH state-UUID-eva (temp, brzina, režim…).
// Auth: legacy getkey + HMAC-SHA1 (radi kad je Basic dozvoljen). Bin status updates.
const WebSocket = require('ws');
const crypto = require('crypto');

class LoxWS {
  constructor(host, user, pass) {
    this.host = host; this.user = user; this.pass = pass;
    this.values = {};         // uuid(string) -> number
    this.ws = null; this.ready = false; this.expectType = 0;
    this._pending = null;     // resolver za tekstualni odgovor
    this._stop = false;
  }
  start() { this._stop = false; this._connect(); }
  stop() { this._stop = true; if (this.ws) try { this.ws.close(); } catch (e) {} }

  _connect() {
    this.ready = false;
    this.ws = new WebSocket(`ws://${this.host}/ws/rfc6455`);
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('open', () => this._auth().catch(e => { console.warn('[loxws] auth greška: ' + e.message); this.ws.close(); }));
    this.ws.on('message', (data, isBinary) => this._onMsg(data, isBinary));
    this.ws.on('close', () => { this.ready = false; if (!this._stop) setTimeout(() => this._connect(), 4000); });
    this.ws.on('error', e => { /* close će rekonektovati */ });
  }
  _send(cmd) { return new Promise((res) => { this._pending = res; this.ws.send(cmd); }); }

  async _auth() {
    // TOKEN auth: getkey2 -> pwHash -> HMAC -> gettoken/getjwt
    const r = await this._send(`jdev/sys/getkey2/${this.user}`);
    let val = r && r.LL && r.LL.value;
    if (typeof val === 'string') { try { val = JSON.parse(val); } catch (e) {} }
    if (!val || !val.key) throw new Error('nema key2');
    const alg = (val.hashAlg && /256/.test(val.hashAlg)) ? 'sha256' : 'sha1';
    const pwHash = crypto.createHash(alg).update(`${this.pass}:${val.salt}`).digest('hex').toUpperCase();
    const hash = crypto.createHmac(alg, Buffer.from(val.key, 'hex')).update(`${this.user}:${pwHash}`).digest('hex');
    const uuid = '0bca1eee-02b4-603c-ffffaabbccddeeff', info = 'KotlarnicaSCADA';
    let t = await this._send(`jdev/sys/gettoken/${hash}/${this.user}/2/${uuid}/${info}`);
    let code = t && t.LL && (t.LL.Code || t.LL.code);
    if (String(code) !== '200') {
      t = await this._send(`jdev/sys/getjwt/${hash}/${this.user}/2/${uuid}/${info}`);
      code = t && t.LL && (t.LL.Code || t.LL.code);
    }
    if (String(code) !== '200') throw new Error('gettoken Code=' + code);
    await this._send('jdev/sps/enablebinstatusupdate');
    this.ready = true;
    console.log('[loxws] autentikovan (token), primam živo stanje');
    this._ka = setInterval(() => { if (this.ws && this.ws.readyState === 1) this.ws.send('keepalive'); }, 120000);
  }

  _onMsg(data, isBinary) {
    if (!isBinary) {
      const txt = data.toString();
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      if (this._pending) { const r = this._pending; this._pending = null; r(j); }
      return;
    }
    // binarni frame
    if (data.length === 8 && data[0] === 0x03) { this.expectType = data[1]; return; } // header
    if (this.expectType === 2) this._parseValues(data);   // value-states event table
    // tipovi 3 (text), 6 (keepalive) — ignorišemo
    this.expectType = 0;
  }
  _parseValues(buf) {
    for (let o = 0; o + 24 <= buf.length; o += 24) {
      this.values[this._uuid(buf, o)] = buf.readDoubleLE(o + 16);
    }
  }
  _uuid(b, o) {
    const d1 = b.readUInt32LE(o).toString(16).padStart(8, '0');
    const d2 = b.readUInt16LE(o + 4).toString(16).padStart(4, '0');
    const d3 = b.readUInt16LE(o + 6).toString(16).padStart(4, '0');
    const d4 = b.slice(o + 8, o + 16).toString('hex');
    return `${d1}-${d2}-${d3}-${d4}`;
  }
}
module.exports = { LoxWS };

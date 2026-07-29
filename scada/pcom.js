// Unitronics PCOM/ASCII klijent preko TCP (port 502) - isti protokol koji je koristio ZView (drvjazz).
// Frame:  / + UnitID(2) + CMD + Addr(4hex) + Len(2hex) [+ data] + Checksum(2hex) + CR
// Citanje:  RW=MI(16bit), RB=MB, RE=Inputs, RA=Outputs   (bitovi se vracaju kao '0'/'1' po operandu)
// Upis:     SW=MI,  SB=MB,  SA=Output
const net = require('net');

class Pcom {
  constructor(ip, port = 502, unit = 1) {
    this.ip = ip; this.port = port;
    this.unit = unit.toString().padStart(2, '0');
    this.sock = null; this.connected = false;
    this.queue = []; this.busy = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let done = false;
      this.sock = net.connect(this.port, this.ip, () => {
        done = true; clearTimeout(to); this.connected = true; this.sock.setTimeout(0); resolve();
      });
      // kratak connect-timeout: ne ostavljaj "SynSent" sokete da vise po 21s (da ne gusi Jazz)
      const to = setTimeout(() => { if (!done) { done = true; this.sock.destroy(); reject(new Error('connect timeout')); } }, 4000);
      this.sock.on('error', e => { this.connected = false; if (!done) { done = true; clearTimeout(to); reject(e); } });
      this.sock.on('close', () => { this.connected = false; });
    });
  }
  close() { if (this.sock) try { this.sock.destroy(); } catch (e) {} this.connected = false; }

  static ck(body) { let s = 0; for (const c of body) s = (s + c.charCodeAt(0)) & 0xff; return s.toString(16).toUpperCase().padStart(2, '0'); }
  _frame(cmd, addr, len, data = '') {
    const a = addr.toString(16).toUpperCase().padStart(4, '0');
    const l = len.toString(16).toUpperCase().padStart(2, '0');
    const body = this.unit + cmd + a + l + data;
    return '/' + body + Pcom.ck(body) + '\r';
  }

  // serijalizovan zahtev/odgovor (PCOM nema transaction id)
  _send(frame, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      this.queue.push({ frame, resolve, reject, timeoutMs });
      this._pump();
    });
  }
  _pump() {
    if (this.busy || !this.queue.length) return;
    if (!this.connected) { const j = this.queue.shift(); j.reject(new Error('nije povezan')); return this._pump(); }
    this.busy = true;
    const job = this.queue.shift();
    let buf = '';
    const onData = d => {
      buf += d.toString('latin1');
      if (buf.includes('\r')) { cleanup(); job.resolve(buf.trim()); }
    };
    const to = setTimeout(() => { cleanup(); job.reject(new Error('PCOM timeout')); }, job.timeoutMs);
    const cleanup = () => { clearTimeout(to); this.sock.removeListener('data', onData); this.busy = false; setImmediate(() => this._pump()); };
    this.sock.on('data', onData);
    this.sock.write(job.frame);
  }

  _payload(resp, cmd) {
    // /A + unit(2) + CMD(2) + data + ck(2)
    const m = resp.match(new RegExp('^/A..' + cmd + '(.*)..$'));
    if (!m) throw new Error('los odgovor: ' + JSON.stringify(resp));
    return m[1];
  }

  // ---- citanje ----
  async readWords(addr, len) {          // MI -> niz 16-bit (signed)
    const data = this._payload(await this._send(this._frame('RW', addr, len)), 'RW');
    const out = [];
    for (let i = 0; i + 4 <= data.length; i += 4) {
      let v = parseInt(data.substr(i, 4), 16);          // big-endian 4 hex
      if (v > 32767) v -= 65536;                          // signed
      out.push(v);
    }
    return out;
  }
  async readBits(cmd, addr, len) {       // RB/RE/RA -> niz 0/1
    const data = this._payload(await this._send(this._frame(cmd, addr, len)), cmd);
    return [...data].slice(0, len).map(c => (c === '1' ? 1 : 0));
  }

  // ---- upis ----
  async writeWord(addr, value) {         // SW (MI)
    const v = (value & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    return this._send(this._frame('SW', addr, 1, v));
  }
  async writeBit(cmd, addr, val) {       // SB (MB) / SA (Output)
    return this._send(this._frame(cmd, addr, 1, val ? '1' : '0'));
  }
}

module.exports = { Pcom };

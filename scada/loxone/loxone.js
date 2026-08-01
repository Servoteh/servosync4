// Loxone Miniserver klijent (HTTP). Za "Nova zgrada" — kotlarnica/grejanje/hladjenje.
// MVP: HTTP Basic auth (radi lokalno na vecini Miniservera). Ako Miniserver odbije
// Basic (401) -> treba token auth (dodajemo kad potvrdimo firmware).
// Loxone HTTP odgovori su umotani: { "LL": { "value": "...", "Code": "200" } }.
// LoxAPP3.json (struktura) je sirov JSON (bez LL omota).

class Loxone {
  constructor(host, user, pass) {
    this.host = host;
    this.auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  async _get(p) {
    const res = await fetch(`http://${this.host}${p}`, {
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(8000),
    });
    return res;
  }
  // Cela konfiguracija (sobe, kategorije, kontrole, UUID-evi) — = nasa tag-mapa
  async structure() {
    const res = await this._get('/data/LoxAPP3.json');
    if (res.status === 401) throw new Error('401 Unauthorized — Basic auth odbijen (verovatno treba token auth).');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  // Trenutna vrednost kontrole/state-a po UUID-u
  async state(uuid) {
    const res = await this._get(`/jdev/sps/io/${uuid}`);
    const j = await res.json().catch(() => null);
    return j && j.LL ? j.LL.value : null;
  }
  // Komanda (npr. "on", "off", "pulse", broj za setpoint)
  async command(uuid, cmd) {
    const res = await this._get(`/jdev/sps/io/${uuid}/${encodeURIComponent(cmd)}`);
    const j = await res.json().catch(() => null);
    return j && j.LL ? j.LL : { Code: String(res.status) };
  }
  // Identifikacija (bez auth-a radi na nekim fw): serijski + verzija
  async info() {
    const res = await this._get('/jdev/cfg/api');
    const j = await res.json().catch(() => null);
    return j && j.LL ? j.LL.value : null;
  }
}

module.exports = { Loxone };

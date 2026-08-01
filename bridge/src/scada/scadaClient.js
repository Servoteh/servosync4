import { config } from '../config.js';

/**
 * HTTP klijent za lokalnu Scada_PLC aplikaciju (ista mašina, LAN UI + API).
 * Bridge NE priča direktno sa PLC-ovima — sve ide kroz postojeće, validirane
 * endpointe SCADA aplikacije (drajveri + whitelist ostaju na jednom mestu).
 *
 * Čitanje:  GET  /api/state | /api/s7 | /api/loxone | /api/bluelog | /api/sigen
 * Upis:     POST /api/write | /api/s7/write | /api/loxone/write |
 *           /api/loxone/roomtemp | /api/sigen/write
 */

async function req(path, { method = 'GET', body } = {}) {
  const url = `${config.scada.baseUrl}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.scada.httpTimeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* ne-JSON odgovor */ }
    if (!res.ok) {
      const msg = json?.error || `${res.status} ${res.statusText}`;
      const err = new Error(`[scada] ${method} ${path} → ${msg}`);
      err.status = res.status;
      err.body = json ?? text;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// --- čitanje (snapshot izvori) ---
export const getState = () => req('/api/state');     // kot1 Unitronics
export const getS7 = () => req('/api/s7');           // kot2 Siemens
export const getLoxone = () => req('/api/loxone');   // kot3 Loxone
export const getBluelog = () => req('/api/bluelog'); // solar-kaco
export const getSigen = () => req('/api/sigen');     // solar-sigen

// --- upis (command executor; validacija opsega je u allowlist.js + SCADA app) ---
export const writeUnitronics = (name, value) => req('/api/write', { method: 'POST', body: { name, value } });
export const writeS7 = (tag, value) => req('/api/s7/write', { method: 'POST', body: { tag, value } });
export const writeLoxone = (key, value) => req('/api/loxone/write', { method: 'POST', body: { key, value } });
export const writeLoxoneRoomTemp = (key, mode, value) =>
  req('/api/loxone/roomtemp', { method: 'POST', body: { key, mode, value } });
export const writeSigen = (systemId, mode) => req('/api/sigen/write', { method: 'POST', body: { systemId, mode } });

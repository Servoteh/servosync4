import {
  getLoxone,
  writeLoxone,
  writeLoxoneRoomTemp,
  writeS7,
  writeSigen,
  writeUnitronics,
} from './scadaClient.js';

/** Greška validacije u exec fazi → komanda ide u 'rejected' (ne 'failed'). */
class RejectError extends Error {
  constructor(msg) { super(msg); this.reject = true; }
}
export { RejectError };

/**
 * ALLOWLIST komandi — jedini autoritet šta sme da se piše iz clouda.
 * UI ne može da ga zaobiđe: sve komande prolaze kroz validateCommand() pre
 * izvršenja, a SCADA aplikacija ima SVOJ drugi sloj validacije
 * (/api/write rw-check, /api/s7/write validateWrite, Loxone writable flag).
 *
 * Oblik komande (scada_commands red):
 *   { site_key, target, op, value }  — value je jsonb, standard: {"v": broj|bool}
 *   Loxone roomtemp: value {"v": 22, "mode": "heat"|"cool"}
 *   Sigen:           value {"systemId": "...", "mode": 0|5}
 *
 * NAMERNO VAN ALLOWLIST-a (bezbednost, v1):
 *   - kot2 `Web_Estop` — daljinski E-stop se NE dozvoljava iz clouda
 *   - solar-kaco — read-only (blue'Log nema kontrolni API)
 */

const bool01 = (v) => (v === true || v === 1 || v === '1' ? 1 : v === false || v === 0 || v === '0' ? 0 : null);
const numIn = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

// --- kot1 (Unitronics /api/write) ---
const KOT1_SETPOINT_RANGES = {
  SP_SPOLJA: [-10, 30],
  SP_SUDA_H: [20, 90],
  SP_SUDA_L: [20, 90],
  SP_MONTAZA: [5, 35],
  SP_CNC: [5, 35],
  SP_HIDRAULIKA: [5, 35],
  SP_ZAVAR: [5, 35],
};
const KOT1_BOOL_TAGS = new Set([
  'RK_K1', 'RK_K2', 'RK_K3', 'RK_K4', 'RK_K5',
  'RK_P1', 'RK_P2', 'RK_P3', 'RK_P4',
  'AUTO_MAN', 'GREJ_HLAD',
  'D_PON', 'D_UTO', 'D_SRE', 'D_CET', 'D_PET', 'D_SUB', 'D_NED',
]);
const KOT1_SCHEDTIME_TAGS = new Set(['T_PONPET_ON', 'T_PONPET_OFF', 'T_SUBNED_ON', 'T_SUBNED_OFF']);

function validateKot1(target, value) {
  const v = value?.v;
  if (KOT1_SETPOINT_RANGES[target]) {
    const [min, max] = KOT1_SETPOINT_RANGES[target];
    const n = numIn(v, min, max);
    if (n == null) return { ok: false, reason: `${target}: vrednost mora ${min}–${max} °C` };
    return { ok: true, exec: () => writeUnitronics(target, n) };
  }
  if (KOT1_BOOL_TAGS.has(target)) {
    const b = bool01(v);
    if (b == null) return { ok: false, reason: `${target}: vrednost mora 0/1` };
    return { ok: true, exec: () => writeUnitronics(target, b) };
  }
  if (KOT1_SCHEDTIME_TAGS.has(target)) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v))) {
      return { ok: false, reason: `${target}: vrednost mora "HH:MM"` };
    }
    return { ok: true, exec: () => writeUnitronics(target, String(v)) };
  }
  if (target === 'RESET_VFD') {
    return { ok: true, exec: () => writeUnitronics(target, 1) }; // puls, app sam vraća na 0
  }
  return { ok: false, reason: `kot1: tag '${target}' nije u allowlist-u` };
}

// --- kot2 (Siemens /api/s7/write) — ogledalo validateWrite whitelist-a MINUS Web_Estop ---
const KOT2_BOOL_CMDS = new Set([
  'Web_Automatski_Rezim', 'Web_Rucni_Rezim', 'Web_Grejanje', 'Web_Hladjenje',
  'Web_Ukljucenje_kotla_rucno',
  'Web_P1', 'Web_P2', 'Web_P3', 'Web_P4',
  ...Array.from({ length: 10 }, (_, i) => `Web_K${i + 1}`),
]);
const KOT2_RESET_CMDS = new Set([
  'Alarm_w1x2_reset', 'Alarm_w1x3_reset', 'Alarm_w1x4_reset', 'Alarm_w1x5_reset',
  ...Array.from({ length: 5 }, (_, i) => `Alarm_w3x${i}_reset`),
  ...Array.from({ length: 15 }, (_, i) => `Alarm_w6x${i + 1}_reset`),
]);

function validateKot2(target, value) {
  const v = value?.v;
  if (target === 'Zeljena_temperatura') {
    const n = numIn(v, 10, 30);
    if (n == null) return { ok: false, reason: 'Zeljena_temperatura mora 10–30 °C' };
    return { ok: true, exec: () => writeS7(target, Math.round(n)) };
  }
  if (/^Vreme_(Poc|Kraj)_H[3-6]$/.test(target)) {
    const n = numIn(v, 0, 23);
    if (n == null) return { ok: false, reason: `${target}: sat mora 0–23` };
    return { ok: true, exec: () => writeS7(target, Math.round(n)) };
  }
  if (KOT2_BOOL_CMDS.has(target)) {
    const b = bool01(v);
    if (b == null) return { ok: false, reason: `${target}: vrednost mora 0/1` };
    return { ok: true, exec: () => writeS7(target, b) };
  }
  if (KOT2_RESET_CMDS.has(target)) {
    return { ok: true, exec: () => writeS7(target, 1) };
  }
  if (target === 'Web_Estop') {
    return { ok: false, reason: 'Daljinski E-stop nije dozvoljen iz clouda (samo lokalno)' };
  }
  return { ok: false, reason: `kot2: tag '${target}' nije u allowlist-u` };
}

// --- kot3 (Loxone) — target: 'room:<key>' | '<key>:switch' | '<key>:value' ---
function validateKot3(target, value) {
  const v = value?.v;
  if (target.startsWith('room:')) {
    const key = target.slice('room:'.length);
    const mode = value?.mode === 'cool' ? 'cool' : 'heat';
    const n = numIn(v, 5, 35);
    if (!key || n == null) return { ok: false, reason: 'roomtemp: key + vrednost 5–35 °C' };
    return { ok: true, exec: () => writeLoxoneRoomTemp(key, mode, n) };
  }
  if (target.endsWith(':switch') || target.endsWith(':value')) {
    const key = target.replace(/:(switch|value)$/, '');
    const n = Number(v);
    if (!key || !Number.isFinite(n)) return { ok: false, reason: 'value: mora broj' };
    // stvarna validacija po TAGU iz živе strukture (nalaz N7): writable check,
    // Switch → 0/1, ValueSelector → 0..max (max iz live stanja ako postoji)
    return {
      ok: true,
      exec: async () => {
        const snap = await getLoxone();
        const tag = (snap?.tags || []).find((t) => t.key === key);
        if (!tag) throw new RejectError(`Loxone tag '${key}' ne postoji`);
        if (!tag.writable) throw new RejectError(`Loxone '${tag.name}' je read-only`);
        if (tag.kind === 'switch') {
          const b = bool01(v);
          if (b == null) throw new RejectError(`${tag.name}: vrednost mora 0/1`);
          return writeLoxone(key, b);
        }
        const live = snap?.live || {};
        const mxRaw = tag.states?.max != null ? Number(live[tag.states.max]) : NaN;
        const max = Number.isFinite(mxRaw) && mxRaw > 0 ? mxRaw : 100;
        if (n < 0 || n > max) throw new RejectError(`${tag.name}: opseg 0–${max}`);
        return writeLoxone(key, n);
      },
    };
  }
  return { ok: false, reason: `kot3: target '${target}' nije u allowlist-u` };
}

// --- solar-sigen (cloud OpenAPI) — samo promena režima, i to 0|5 ---
function validateSigen(target, value) {
  if (target !== 'operatingMode') {
    return { ok: false, reason: `solar-sigen: target '${target}' nije u allowlist-u` };
  }
  const systemId = String(value?.systemId || '').trim();
  const mode = Number(value?.mode ?? value?.v);
  if (!systemId) return { ok: false, reason: 'operatingMode: nedostaje systemId' };
  if (mode !== 0 && mode !== 5) return { ok: false, reason: 'operatingMode: mode mora 0 ili 5' };
  return { ok: true, exec: () => writeSigen(systemId, mode) };
}

const VALIDATORS = {
  kot1: validateKot1,
  kot2: validateKot2,
  kot3: validateKot3,
  'solar-sigen': validateSigen,
};

/**
 * validateCommand(cmd) → { ok:true, exec: () => Promise } | { ok:false, reason }
 */
export function validateCommand(cmd) {
  const validator = VALIDATORS[cmd?.site_key];
  if (!validator) {
    return { ok: false, reason: `sistem '${cmd?.site_key}' nema dozvoljene komande` };
  }
  const target = String(cmd?.target || '').trim();
  if (!target) return { ok: false, reason: 'prazan target' };
  return validator(target, cmd?.value ?? {});
}

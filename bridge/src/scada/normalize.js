/**
 * Normalizacija sirovih /api/* odgovora SCADA aplikacije u jedinstven oblik
 * za Supabase:
 *   { online: boolean,
 *     payload: object,                 → scada_snapshots.payload (ceo sirovi JSON)
 *     history: [{metric, value}],      → scada_history uzorci (long format)
 *     alarms:  [{code, severity, text}] → aktivni alarmi za scada_alarms diff-sync
 *   }
 *
 * payload čuvamo NEIZMENJEN (isti oblik kao lokalni UI), pa ServoSync ekrani
 * mogu da portuju postojeće rendere 1:1. history/alarms su izvedeni.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// kot1 (Unitronics /api/state): values = { TAG: {value, raw, ts} }
const KOT1_HISTORY_TAGS = [
  'T_SPOLJA', 'T_SUDA', 'T_CNC', 'T_ZAVAR', 'T_MONTAZA1', 'T_MONTAZA2', 'T_HIDRAULIKA',
  'SP_SPOLJA', 'SP_SUDA_H', 'SP_SUDA_L', 'SP_CNC', 'SP_HIDRAULIKA', 'SP_MONTAZA', 'SP_ZAVAR',
];
// ALARM_OUT (zbirni izlaz O16) se NE vodi kao poseban alarm — on je ON kad je
// bilo koji specifičan aktivan, pa bi samo duplirao redove (nalaz N4/NL-11).
const KOT1_ALARM_TAGS = [
  { tag: 'ALARM_PUMPE', severity: 2, text: 'Alarm toplotne pumpe' },
  { tag: 'ALARM_ZASTITE', severity: 2, text: 'Ispad zaštite' },
];

export function normalizeKot1(raw) {
  const values = raw?.values || {};
  const online = raw?.online === true;
  const history = [];
  if (online) {
    for (const tag of KOT1_HISTORY_TAGS) {
      const v = num(values[tag]?.value);
      if (v != null) history.push({ metric: tag, value: v });
    }
  }
  const alarms = [];
  if (online) {
    for (const a of KOT1_ALARM_TAGS) {
      if (Number(values[a.tag]?.value) === 1) {
        alarms.push({ code: a.tag, severity: a.severity, text: a.text });
      }
    }
  }
  return { online, payload: raw ?? {}, history, alarms };
}

// kot2 (Siemens /api/s7): temps[], setpoint, alarms[] (samo aktivni, dekodirani iz reči)
export function normalizeKot2(raw) {
  const online = raw?.online === true;
  const history = [];
  if (online) {
    for (const t of raw?.temps || []) {
      const v = num(t?.value);
      if (v != null && !t?.fault) history.push({ metric: t.key, value: v });
    }
    const sp = num(raw?.setpoint);
    if (sp != null) history.push({ metric: 'setpoint', value: sp });
  }
  // severity model (ISA-18.2 duh): alarm=2, warn=3, info=4 — informativne
  // poruke se ne mešaju sa realnim alarmima (nalaz N4)
  const sevMap = { alarm: 2, warn: 3, info: 4 };
  const alarms = (online ? raw?.alarms || [] : []).map((a) => ({
    code: `${a.word ?? 'W?'}.${a.bit ?? '?'}`,
    severity: sevMap[a.sev] ?? 3,
    text: a.text || `${a.word}.${a.bit}`,
  }));
  return { online, payload: raw ?? {}, history, alarms };
}

// kot3 (Loxone /api/loxone): tags[] (kind='room' ima states.tempActual uuid) + live {uuid: broj}
// online = ISKLJUČIVO wsReady: `tags` dolaze iz statičke strukture (uvek prisutni),
// pa bi tags.length>0 lažno prikazivao online i kad je Miniserver pao (nalaz B5).
export function normalizeKot3(raw) {
  const online = raw?.wsReady === true;
  const live = raw?.live || {};
  const values = raw?.values || {};
  const history = [];
  if (online) {
    let roomSum = 0;
    let roomCnt = 0;
    for (const tag of raw?.tags || []) {
      if (tag?.kind === 'room' && tag?.states?.tempActual) {
        // NAPOMENA: state-uuid postoji samo u `live` (WS); `values` je keširan po
        // control-uuid-u pa fallback tamo ne pogađa (nalaz NF-5) — live je izvor.
        const v = num(live[tag.states.tempActual]);
        if (v != null && tag.room) {
          history.push({ metric: `room:${tag.room}`, value: v });
          roomSum += v;
          roomCnt += 1;
        }
      } else if (tag?.type === 'Heatmixer' && tag?.states?.tempActual) {
        // mešači (Podno/Zidno mešanje) — ključne procesne temperature (nalaz NF-4)
        const v = num(live[tag.states.tempActual]);
        if (v != null) history.push({ metric: `mix:${tag.name}`, value: v });
      } else if (tag?.type === 'InfoOnlyAnalog' && tag?.states?.value) {
        // buffer tank i ostali analozi
        const v = num(live[tag.states.value]);
        if (v != null) history.push({ metric: `analog:${tag.name}`, value: v });
      }
    }
    if (roomCnt > 0) history.push({ metric: 'rooms_avg', value: roomSum / roomCnt });
  }
  return { online, payload: raw ?? {}, history, alarms: [] };
}

// solar-kaco (blue'Log /api/bluelog): plant agregat + inverters[] + meter
export function normalizeKaco(raw) {
  const online = raw?.online === true;
  const history = [];
  if (online) {
    const kw = num(raw?.plant?.kw);
    if (kw != null) history.push({ metric: 'pv', value: kw });
    const kwhDay = num(raw?.plant?.kwhDay);
    if (kwhDay != null) history.push({ metric: 'e_day', value: kwhDay });
    const gridKw = num(raw?.meter?.pActive);
    if (gridKw != null) history.push({ metric: 'grid', value: gridKw / 1000 });
  }
  const alarms = [];
  // reporting (pAc != null) se poredi sa UKUPNIM brojem invertora — poređenje sa
  // activeInverters (pAc > 0) je matematički nemoguće jer je active ⊆ reporting (nalaz B6)
  const count = num(raw?.plant?.count);
  const reporting = num(raw?.plant?.reportingInverters);
  // Alarmi koje javlja sam blue'Log su autoritativni (kod, poruka, port, tačan početak) —
  // npr. NOCOMM_RS485 = invertor otpao sa RS485 magistrale. Kod je jedinstven PO UREĐAJU
  // da diff-sync može da zatvori svaki pojedinačno kad se vrati.
  const fromLogger = online ? (raw?.alarms || []).filter((a) => a?.active) : [];
  if (fromLogger.length) {
    for (const a of fromLogger) {
      const who = a.address != null ? `INV${a.address}` : a.deviceId || 'PLANT';
      alarms.push({
        code: `${a.code || 'ALARM'}:${who}`,
        severity: 2,
        text: `${a.deviceName || who} — ${a.message || a.code}${a.port ? ` [${a.port}]` : ''}`,
      });
    }
  } else if (online && count != null && reporting != null && reporting < count) {
    // rezerva: lista alarma sa loggera nije stigla, a vidi se da neki invertor ne javlja
    alarms.push({
      code: 'INVERTER_OFFLINE',
      severity: 3,
      text: `Javlja se ${reporting}/${count} invertora`,
    });
  }
  return { online, payload: raw ?? {}, history, alarms };
}

// solar-sigen (/api/sigen): values = { systemId: { pvPower: {value,ts}, ... } }
const SIGEN_METRICS = [
  ['pvPower', 'pv'], ['loadPower', 'load'], ['gridPower', 'grid'],
  ['batteryPower', 'battery'], ['batterySoc', 'soc'],
];

export function normalizeSigen(raw) {
  const online = raw?.online === true;
  const history = [];
  if (online) {
    for (const [systemId, vals] of Object.entries(raw?.values || {})) {
      for (const [field, metric] of SIGEN_METRICS) {
        const v = num(vals?.[field]?.value);
        if (v != null) history.push({ metric: `${systemId}:${metric}`, value: v });
      }
    }
  }
  return { online, payload: raw ?? {}, history, alarms: [] };
}

export const NORMALIZERS = Object.freeze({
  kot1: normalizeKot1,
  kot2: normalizeKot2,
  kot3: normalizeKot3,
  'solar-kaco': normalizeKaco,
  'solar-sigen': normalizeSigen,
});

// Sigenergy tag-mapa: imena polja su TACNO kako ih vraca OpenAPI
// (/energyFlow, /summary, /instruction settings). Grupisano za UI.
const { OPERATING_MODES, SWITCHABLE_MODES } = require('./sigen');

// src: 'flow' = energyFlow, 'sum' = summary, 'mode' = operativni rezim
// kind: 'power' (kW), 'percent' (%), 'energy' (kWh), 'mode' (tekst)
const SIG_TAGS = [
  // ── Snaga (energyFlow, uzivo) ──
  { key: 'pvPower',         name: 'PV proizvodnja',   src: 'flow', field: 'pvPower',      unit: 'kW', kind: 'power', group: 'Snaga' },
  { key: 'loadPower',       name: 'Potrošnja',        src: 'flow', field: 'loadPower',    unit: 'kW', kind: 'power', group: 'Snaga' },
  { key: 'gridPower',       name: 'Mreža (±)',        src: 'flow', field: 'gridPower',    unit: 'kW', kind: 'power', group: 'Snaga' },
  { key: 'batteryPower',    name: 'Baterija (±)',     src: 'flow', field: 'batteryPower', unit: 'kW', kind: 'power', group: 'Snaga' },
  { key: 'evPower',         name: 'EV punjač',        src: 'flow', field: 'evPower',      unit: 'kW', kind: 'power', group: 'Snaga' },
  { key: 'heatPumpPower',   name: 'Toplotna pumpa',   src: 'flow', field: 'heatPumpPower',unit: 'kW', kind: 'power', group: 'Snaga' },
  { key: 'batterySoc',      name: 'Baterija SOC',     src: 'flow', field: 'batterySoc',   unit: '%',  kind: 'percent', group: 'Baterija' },

  // ── Proizvodnja (summary, kumulativno) ──
  { key: 'dailyPowerGeneration',    name: 'Danas',   src: 'sum', field: 'dailyPowerGeneration',    unit: 'kWh', kind: 'energy', group: 'Proizvodnja' },
  { key: 'monthlyPowerGeneration',  name: 'Mesec',   src: 'sum', field: 'monthlyPowerGeneration',  unit: 'kWh', kind: 'energy', group: 'Proizvodnja' },
  { key: 'annualPowerGeneration',   name: 'Godina',  src: 'sum', field: 'annualPowerGeneration',   unit: 'kWh', kind: 'energy', group: 'Proizvodnja' },
  { key: 'lifetimePowerGeneration', name: 'Ukupno',  src: 'sum', field: 'lifetimePowerGeneration', unit: 'kWh', kind: 'energy', group: 'Proizvodnja' },

  // ── Operativni rezim (citanje; upis preko /api/sigen/write) ──
  { key: 'operatingMode',   name: 'Režim rada',       src: 'mode', field: null, unit: '', kind: 'mode', group: 'Režim' },
];

// Spljosti odgovore API-ja u { key: value } prema gornjim definicijama.
// data = { flow:{...}, sum:{...}, mode:<int|null> }
function flattenSigen(data) {
  const out = {};
  const num = v => (v == null || v === '' || isNaN(Number(v))) ? v : Number(v);
  for (const t of SIG_TAGS) {
    let v = null;
    if (t.src === 'flow') v = num(data.flow?.[t.field]);
    else if (t.src === 'sum') v = num(data.sum?.[t.field]);
    else if (t.src === 'mode') v = (data.mode == null) ? null : (OPERATING_MODES[data.mode] ?? `Nepoznat (${data.mode})`);
    out[t.key] = { value: v ?? null, ts: Date.now() };
  }
  out._modeRaw = { value: data.mode ?? null, ts: Date.now() }; // sirovi mod za UI select
  return out;
}

// Opcije za kontrolu rezima (samo prebacivi)
function modeOptions() {
  return Object.entries(SWITCHABLE_MODES).map(([v, name]) => ({ value: Number(v), name }));
}

module.exports = { SIG_TAGS, flattenSigen, modeOptions, OPERATING_MODES, SWITCHABLE_MODES };

// HALA 5 (S7-1200) tag-mapa + dekodiranje sirovih AWP vrednosti.
// Izvor mapiranja: analiza UserFiles/{start,update_page}.html (DB "Web").
// VAŽNO (caveat iz analize): bit->pumpa za AlarmW1 ima protivrečne verzije u HMI kodu;
// ovde se prikaz vodi po TEKSTU alarma iz HMI-a, a RESET piše samo tačan Alarm_wNxM_reset
// (kao web HMI) — ne replicira klijentsku logiku "ugasi pumpu", pa je bezbedno.

const FAULT = 3276.7;                       // senzor neispravan/nepovezan (≈ max)
const b = (v) => v === '1' || v === 1 || v === true;
const w = (v) => { const n = parseInt(v, 10); return isNaN(n) ? 0 : n; };
const bit = (word, i) => ((w(word) >> i) & 1) === 1;
function tnum(v) {                          // temperatura -> broj ili null (fault)
  const n = parseFloat(v);
  if (isNaN(n) || Math.abs(n) >= 1000 || Math.abs(n - FAULT) < 0.05) return null;
  return Math.round(n * 10) / 10;
}

const TEMP_DEFS = [
  ['Temp_suda', 'Temperatura suda (buffer)'],
  ['Temp_Hala_4', 'Temperatura Hala 4'],
  ['Temp_Hala_5', 'Temperatura Hala 5'],
  ['Temp_Hala_3', 'Temperatura Hala 3'],
  ['Temp_spoljasnja', 'Spoljašnja temperatura'],
];

// PUMPE: Web_Pumpe bit0-3=P1-4, bit4-5=ToplotnaPumpa1-2; potvrde bit0-3; timeri Timer_Px
const PUMP_DEFS = [
  { key: 'P1', label: 'Pumpa 1', bit: 0, cmd: 'Web_P1', conf: 0, timer: 'Timer_P1' },
  { key: 'P2', label: 'Pumpa 2', bit: 1, cmd: 'Web_P2', conf: 1, timer: 'Timer_P2' },
  { key: 'P3', label: 'Pumpa 3', bit: 2, cmd: 'Web_P3', conf: 2, timer: 'Timer_P3' },
  { key: 'P4', label: 'Pumpa 4', bit: 3, cmd: 'Web_P4', conf: 3, timer: 'Timer_P4' },
  { key: 'TP1', label: 'Toplotna pumpa 1', bit: 4 },
  { key: 'TP2', label: 'Toplotna pumpa 2', bit: 5 },
];

// KALORIFERI K1-K10 (Web_Kaloriferi bit0-9; potvrde bit0-9; komanda Web_Kx)
const KAL_DEFS = Array.from({ length: 10 }, (_, i) => ({
  key: `K${i + 1}`, label: `Kalorifer ${i + 1}`, bit: i, cmd: `Web_K${i + 1}`,
}));

// ALARMI — MERODAVNO iz DEPLOYED AWP-a (živa start.html; novija/renumerisana u odnosu na repo).
// [bit] = {t, sev, reset?}. sev: alarm=crveno, info=plavo, warn=narandžasto.
const A1 = { // e-stop + sud + kontaktori pumpi + toplotne pumpe
  0: { t: 'Pritisnuta STOP pečurka (E-STOP)', sev: 'alarm' },
  1: { t: 'Neadekvatna temperatura u sudu', sev: 'info' },
  2: { t: 'Greška kontaktora P4', sev: 'alarm', reset: 'Alarm_w1x2_reset' },
  3: { t: 'Greška kontaktora P3', sev: 'alarm', reset: 'Alarm_w1x3_reset' },
  4: { t: 'Greška kontaktora P1', sev: 'alarm', reset: 'Alarm_w1x4_reset' },
  5: { t: 'Greška kontaktora P2', sev: 'alarm', reset: 'Alarm_w1x5_reset' },
  6: { t: 'Greška toplotne pumpe 1', sev: 'alarm' },
  7: { t: 'Greška toplotne pumpe 2', sev: 'alarm' },
};
const A2 = { 14: { t: 'PLC ne čita ispravno vreme', sev: 'alarm' } };
const A3 = { // procesna upozorenja (prekoračenje ručnog rada pumpi)
  0: { t: 'Pumpa 4 prekoračila vreme ručnog rada', sev: 'warn', reset: 'Alarm_w3x0_reset' },
  1: { t: 'Pumpa 3 prekoračila vreme ručnog rada', sev: 'warn', reset: 'Alarm_w3x1_reset' },
  2: { t: 'Pumpa 1 prekoračila vreme ručnog rada', sev: 'warn', reset: 'Alarm_w3x2_reset' },
  3: { t: 'Pumpa 2 prekoračila vreme ručnog rada', sev: 'warn', reset: 'Alarm_w3x3_reset' },
};
// W4: ispad zaštitne sklopke (motorna zaštita) — bit0-3=P4/P3/P1/P2, bit4-15=K1..K12. BEZ reseta (fizički).
const A4 = {
  0: { t: 'Ispad zaštitne sklopke P4', sev: 'alarm' }, 1: { t: 'Ispad zaštitne sklopke P3', sev: 'alarm' },
  2: { t: 'Ispad zaštitne sklopke P1', sev: 'alarm' }, 3: { t: 'Ispad zaštitne sklopke P2', sev: 'alarm' },
};
for (let i = 4; i <= 15; i++) A4[i] = { t: `Ispad zaštitne sklopke K${i - 3}`, sev: 'alarm' };  // bit4=K1..bit15=K12
// W5: ispad zaštitne sklopke K13-K15 (bez reseta)
const A5 = {
  0: { t: 'Ispad zaštitne sklopke K13', sev: 'alarm' }, 1: { t: 'Ispad zaštitne sklopke K14', sev: 'alarm' },
  2: { t: 'Ispad zaštitne sklopke K15', sev: 'alarm' },
};
// W6: greška kontaktora K1-K15 (bit1=K1..bit15=K15), reset w6x1..15
const A6 = {};
for (let i = 1; i <= 15; i++) A6[i] = { t: `Greška kontaktora K${i}`, sev: 'alarm', reset: `Alarm_w6x${i}_reset` };

const ALARM_WORDS = [['W1', 'AlarmWord1', A1], ['W2', 'AlarmWord2', A2], ['W3', 'AlarmWord3', A3],
                     ['W4', 'AlarmWord4', A4], ['W5', 'AlarmWord5', A5], ['W6', 'AlarmWord6', A6]];

function decodeAlarms(raw) {
  const out = [];
  for (const [wn, key, tbl] of ALARM_WORDS) {
    const num = w(raw[key]);
    for (let i = 0; i <= 15; i++) if (bit(num, i) && tbl[i])
      out.push({ word: wn, bit: i, text: tbl[i].t, sev: tbl[i].sev, reset: tbl[i].reset || null });
  }
  return out;
}

function flattenS7(raw) {
  return {
    temps: TEMP_DEFS.map(([key, label]) => ({ key, label, value: tnum(raw[key]),
      fault: tnum(raw[key]) === null })),
    setpoint: w(raw.Zeljena_temperatura),
    modes: {
      auto: b(raw.Automatski_rezim), manual: b(raw.Rucni_rezim),
      heating: b(raw.Rezim_grejanja), cooling: b(raw.Rezim_hladjenja),
      boiler: b(raw.Kotao), estopOk: b(raw.Estop), webEstop: b(raw.Web_Estop),
    },
    pumps: PUMP_DEFS.map(p => ({
      key: p.key, label: p.label, cmd: p.cmd || null,
      on: bit(raw.Web_Pumpe, p.bit),
      confirm: p.conf != null ? bit(raw.Potvrde_ukljucenja_pumpi, p.conf) : null,
      timer: p.timer ? b(raw[p.timer]) : null,
    })),
    kaloriferi: KAL_DEFS.map(k => ({
      key: k.key, label: k.label, cmd: k.cmd,
      on: bit(raw.Web_Kaloriferi, k.bit),
      confirm: bit(raw.Potvrde_ukljucenja_kalorifera, k.bit),
    })),
    // RASPORED (satnice po hali 3/4/5/6): Vreme_Poc_Hn (početak) / Vreme_Kraj_Hn (kraj), 0-23h.
    // NB: read za H6 početak je u JS var "H36vreme" (naziv nedosledan u HMI-u).
    schedule: [3, 4, 5, 6].map(h => ({
      hala: h,
      start: w(raw[h === 6 ? 'H36vreme' : `H${h}Pvreme`]),
      end: w(raw[`H${h}Kvreme`]),
      pocVar: `Vreme_Poc_H${h}`,
      krajVar: `Vreme_Kraj_H${h}`,
    })),
    alarms: decodeAlarms(raw),
    ts: Date.now(),
  };
}

// ---- WRITE whitelist (samo poznate komandne promenljive DB "Web") ----
const BOOL_CMDS = new Set([
  'Web_Automatski_Rezim', 'Web_Rucni_Rezim', 'Web_Grejanje', 'Web_Hladjenje',
  'Web_Ukljucenje_kotla_rucno', 'Web_Estop',
  'Web_P1', 'Web_P2', 'Web_P3', 'Web_P4',
  ...Array.from({ length: 10 }, (_, i) => `Web_K${i + 1}`),
]);
const RESET_CMDS = new Set([
  'Alarm_w1x2_reset', 'Alarm_w1x3_reset', 'Alarm_w1x4_reset', 'Alarm_w1x5_reset',  // kontaktori P4/P3/P1/P2
  ...Array.from({ length: 5 }, (_, i) => `Alarm_w3x${i}_reset`),        // w3x0..w3x4
  ...Array.from({ length: 15 }, (_, i) => `Alarm_w6x${i + 1}_reset`),   // w6x1..w6x15 (kontaktori K1-K15)
]);

// vrati {tag, value} ili baci grešku ako nije dozvoljeno
function validateWrite(tag, value) {
  if (tag === 'Zeljena_temperatura') {
    const v = parseInt(value, 10);
    if (isNaN(v) || v < 10 || v > 30) throw new Error('Zeljena_temperatura mora 10–30');
    return { tag, value: v };
  }
  if (/^Vreme_(Poc|Kraj)_H[3-6]$/.test(tag)) {       // raspored: sat 0–23
    const v = parseInt(value, 10);
    if (isNaN(v) || v < 0 || v > 23) throw new Error('sat mora 0–23');
    return { tag, value: v };
  }
  if (BOOL_CMDS.has(tag)) {
    const v = b(value) ? 1 : 0;
    return { tag, value: v };
  }
  if (RESET_CMDS.has(tag)) return { tag, value: 1 };   // reset = puls 1
  throw new Error('nedozvoljena komanda: ' + tag);
}

module.exports = { flattenS7, decodeAlarms, validateWrite };

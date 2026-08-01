// Tag-mapa solarne elektrane (FNE SERVOTEH) sa blue'Log-a.
// Plant: 6× KACO blueplanet 50.0 TL3 (invertori) + Janitza UMG 96RM (brojilo na mrežnom spoju).
// Snaga postrojenja = SUMA P_AC svih invertora; dnevni prinos = SUMA E_DAY.
// Vrednosti: POST /device/values  (epoch-ms dateRange; vidi bluelog.js).
//
// Abbreviation-i (POST /device/abbreviations):
//   INVERTOR (KACO): P_AC[W], P_DC[W], E_DAY[Wh], T[°C], U_DC1/I_DC1, U_AC1-3/I_AC1-3, COS_PHI, STATE1
//   BROJILO (Janitza UMG 96RM): M_AC_P[W] aktivna, M_AC_Q[var] reaktivna, M_AC_S[VA] prividna,
//     M_AC_PF_COSPHI faktor, M_AC_F[Hz], M_AC_U1-3[V], M_AC_I1-3[A], M_AC_E_EXP/E_IMP[Wh] brojači.

const INVERTER_ABBRS = ['P_AC', 'P_DC', 'E_DAY', 'T'];
const METER_ABBRS = [
  'M_AC_P', 'M_AC_Q', 'M_AC_S', 'M_AC_PF_COSPHI', 'M_AC_F',
  'M_AC_U1', 'M_AC_U2', 'M_AC_U3', 'M_AC_I1', 'M_AC_I2', 'M_AC_I3',
  'M_AC_E_EXP', 'M_AC_E_IMP',
];

// Iz liste uređaja (GET /plant/scada-get-devices) izvuci ono što pollujemo.
function buildBlueLogTags(devices) {
  const inverters = (devices || [])
    .filter(d => d.type === 'INVERTER')
    .map(d => ({ id: d.id, name: d.name, vendor: d.vendor, model: d.model, address: d.address }))
    .sort((a, b) => (a.address || 0) - (b.address || 0));
  const meterDev = (devices || []).find(d => d.type === 'METER') || null;
  return {
    inverters,
    inverterIds: inverters.map(d => d.id),
    meter: meterDev ? { id: meterDev.id, name: meterDev.name, vendor: meterDev.vendor, model: meterDev.model } : null,
    inverterAbbrs: INVERTER_ABBRS,
    meterAbbrs: METER_ABBRS,
  };
}

const num = (v) => (typeof v === 'number' ? v : null);

// Sirovi zapisi sa POST /alarm/alarms -> nas oblik. Aktivan alarm = nema `end`.
// Najcesci kod kod ove elektrane: NOCOMM_RS485 ("Communication failure (RS485)") — invertor
// je otpao sa magistrale, pa logger ne moze ni da mu posalje korekcionu vrednost (setpoint).
function normalizeAlarms(raw) {
  return (raw || []).map(a => ({
    deviceId: a.deviceId || null,
    deviceName: a.deviceName || null,
    address: (a.deviceAddress != null && a.deviceAddress !== '') ? Number(a.deviceAddress) : null,
    port: a.devicePort || null,
    code: a.errorCode || null,
    message: a.errorMessage || a.errorCode || null,
    start: a.start || null,
    end: a.end || null,
    active: a.end == null,
  })).sort((x, y) => (y.start || 0) - (x.start || 0));
}

// latestInv = {invId:{P_AC,P_DC,E_DAY,T,_ts}}   latestMeter = {meterId:{M_AC_*,_ts}}
// extra = {alarms: [sirovi /alarm/alarms], overview: {isAlarmActive, isActivePowerActive, ...}}
function normalize(map, latestInv, latestMeter, extra = {}) {
  const alarms = normalizeAlarms(extra.alarms);
  const activeByDevice = {};
  for (const a of alarms) if (a.active && a.deviceId) (activeByDevice[a.deviceId] ||= []).push(a);

  const inverters = map.inverters.map(d => {
    const v = (latestInv && latestInv[d.id]) || {};
    const pAc = num(v.P_AC);
    const al = (activeByDevice[d.id] || [])[0] || null;
    return {
      id: d.id, name: d.name, address: d.address, model: d.model,
      pAc,                                   // W (AC)
      pDc: num(v.P_DC),                      // W (DC)
      eDay: num(v.E_DAY),                    // Wh danas
      temp: num(v.T),                        // °C
      online: pAc !== null,
      ts: v._ts || null,
      alarm: al ? { code: al.code, message: al.message, start: al.start, port: al.port } : null,
    };
  });
  const withPower = inverters.filter(x => x.pAc !== null);
  const pPlant = withPower.reduce((s, x) => s + x.pAc, 0);
  const eDayPlant = inverters.reduce((s, x) => s + (x.eDay || 0), 0);

  let meter = null;
  if (map.meter) {
    const m = (latestMeter && latestMeter[map.meter.id]) || {};
    meter = {
      name: map.meter.name, model: map.meter.model,
      pActive: num(m.M_AC_P),                // W
      pReactive: num(m.M_AC_Q),              // var
      pApparent: num(m.M_AC_S),              // VA
      pf: num(m.M_AC_PF_COSPHI),
      freq: num(m.M_AC_F),                   // Hz
      u: [num(m.M_AC_U1), num(m.M_AC_U2), num(m.M_AC_U3)],   // V
      i: [num(m.M_AC_I1), num(m.M_AC_I2), num(m.M_AC_I3)],   // A
      eExp: num(m.M_AC_E_EXP),               // Wh (brojač)
      eImp: num(m.M_AC_E_IMP),               // Wh (brojač)
      online: num(m.M_AC_P) !== null,
      ts: m._ts || null,
    };
  }

  const ov = extra.overview || null;
  return {
    plant: {
      pAc: Math.round(pPlant),               // W (suma invertora)
      kw: Math.round(pPlant / 10) / 100,     // kW
      eDay: Math.round(eDayPlant),           // Wh danas
      kwhDay: Math.round(eDayPlant / 10) / 100,  // kWh danas
      unit: 'W',
      activeInverters: inverters.filter(x => (x.pAc || 0) > 0).length,
      reportingInverters: withPower.length,
      count: inverters.length,
      alarmsActive: alarms.filter(a => a.active).length,
      // zbirni indikator sa loggera + da li je regulacija aktivne snage ukljucena
      loggerAlarm: ov ? !!ov.isAlarmActive : null,
      activePowerControl: ov ? !!ov.isActivePowerActive : null,
      plantName: (ov && ov.plantName) || null,
    },
    inverters,
    meter,
    alarms,
  };
}

module.exports = { buildBlueLogTags, normalize, normalizeAlarms, INVERTER_ABBRS, METER_ABBRS };

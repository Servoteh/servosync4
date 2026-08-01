import { runKatzeQuery, sql } from '../db/katze.js';
import { getSupabase, upsertChunked } from '../db/supabase.js';
import { logJob } from '../logger.js';
import { failRun, finishRun, startRun } from './syncLog.js';

const log = logJob('syncKatze');

const JOB_NAME = 'katze_attendance';
const BATCH = 10_000;

/* Katze logičke aktivnosti → kanonski smer (LogickaAktivnost šifarnik):
   U=Ulaz, I=Izlaz, P=Pauza, SI/SL=Službeni izlaz. Ostalo/null → unknown. */
const DIRECTION_BY_LOGACT = Object.freeze({
  U: 'in',
  I: 'out',
  P: 'break',
  SI: 'official_out',
  SL: 'official_out',
});

/* Inkrementalno po IDReg (monotoni identity u tblReg) — watermark je
   MAX(external_id) već sinhronizovanih redova (RPC attendance_katze_max_idreg),
   pa je job idempotentan i sam se oporavlja od prekida. */
const SQL_BATCH = `
  SELECT TOP (${BATCH})
    r.IDReg,
    r.IDNo,
    r.IDHACT,
    r.KorisnickoIme,
    r.IDTerminala,
    t.OpisTerminala,
    r.TerminalskoVremeRegistracije,
    r.IDLogickeAktivnosti,
    r.RegKomentar,
    r.Nevidljiva,
    r.RegType
  FROM dbo.tblReg r
  LEFT JOIN dbo.Terminal t ON t.IDTerminala = r.IDTerminala
  WHERE r.IDReg > @fromIdReg
  ORDER BY r.IDReg ASC;
`;

/* Kartica (8 hex iz prolaza) → zaposleni. Ista kartica je kroz istoriju mogla
   biti dodeljena različitim ljudima — biramo poslednju dodelu čiji je
   valid_from <= vreme prolaza (Katze MediaID semantika). */
async function loadBadgeMap() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('employee_badges')
    .select('code_short, employee_id, valid_from')
    .eq('badge_type', 'media');
  if (error) throw new Error(`employee_badges load: ${error.message}`);
  const map = new Map();
  for (const b of data || []) {
    if (!b.code_short) continue;
    if (!map.has(b.code_short)) map.set(b.code_short, []);
    map.get(b.code_short).push({ employeeId: b.employee_id, validFrom: new Date(b.valid_from).getTime() });
  }
  for (const list of map.values()) list.sort((a, b) => a.validFrom - b.validFrom);
  return map;
}

function resolveEmployee(badgeMap, idNo, eventMs) {
  const list = badgeMap.get(idNo);
  if (!list || list.length === 0) return null;
  let picked = list[0];
  for (const cand of list) {
    if (cand.validFrom <= eventMs) picked = cand;
    else break;
  }
  return picked.employeeId;
}

async function getMaxIdReg() {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('attendance_katze_max_idreg');
  if (error) throw new Error(`attendance_katze_max_idreg: ${error.message}`);
  return Number(data) || 0;
}

function mapRow(row, badgeMap) {
  const d = row.TerminalskoVremeRegistracije;
  if (!d || Number.isNaN(d.getTime())) return null;
  /* useUTC:true → wall-time u UTC poljima; event_ts_local je naivno lokalno
     vreme, event_ts izvodi DB trigger (AT TIME ZONE 'Europe/Belgrade'). */
  const eventLocal = d.toISOString().slice(0, 19);
  const idNo = (row.IDNo || '').trim();
  const manual = row.IDTerminala == null || row.IDTerminala < 0 || !!row.KorisnickoIme;
  const raw = {
    idhact: row.IDHACT ?? null,
    regtype: row.RegType ?? null,
    nevidljiva: !!row.Nevidljiva,
  };
  if (row.RegKomentar) raw.komentar = String(row.RegKomentar).slice(0, 500);
  if (row.KorisnickoIme) raw.korisnik = String(row.KorisnickoIme).slice(0, 100);
  return {
    source: manual ? 'katze_manual' : 'katze',
    external_id: String(row.IDReg),
    badge_code: idNo || null,
    employee_id: idNo ? resolveEmployee(badgeMap, idNo, d.getTime()) : null,
    event_ts_local: eventLocal,
    direction: DIRECTION_BY_LOGACT[(row.IDLogickeAktivnosti || '').trim()] || 'unknown',
    terminal_id: row.IDTerminala != null ? String(row.IDTerminala) : null,
    terminal_name: row.OpisTerminala ? String(row.OpisTerminala).trim() : null,
    raw,
  };
}

export async function syncKatze() {
  const run = await startRun(JOB_NAME);
  log.info('start');
  try {
    const badgeMap = await loadBadgeMap();
    log.info({ badges: badgeMap.size }, 'badge map loaded');

    let fromIdReg = await getMaxIdReg();
    log.info({ fromIdReg }, 'watermark');

    let total = 0;
    for (;;) {
      const rows = await runKatzeQuery(SQL_BATCH, {
        fromIdReg: { type: sql.Numeric(18, 0), value: fromIdReg },
      });
      if (rows.length === 0) break;

      const payload = rows.map((r) => mapRow(r, badgeMap)).filter(Boolean);
      const { total: upserted } = await upsertChunked('attendance_events', payload, 'source,external_id');
      total += upserted;
      fromIdReg = Number(rows[rows.length - 1].IDReg);
      log.info({ upserted, lastIdReg: fromIdReg, totalSoFar: total }, 'batch done');

      if (rows.length < BATCH) break;
    }

    await finishRun(run, { rowsUpdated: total });
    log.info({ upserted: total }, 'done');
    return { total };
  } catch (err) {
    log.error({ err }, 'failed');
    await failRun(run, err);
    throw err;
  }
}

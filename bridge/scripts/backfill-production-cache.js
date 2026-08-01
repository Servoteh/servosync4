/**
 * Manual backfill za modul Planiranje proizvodnje.
 *
 * Puni Supabase cache bez vremenskog prozora:
 *   dbo.tRN            -> public.bigtehn_work_orders_cache
 *   dbo.tStavkeRN      -> public.bigtehn_work_order_lines_cache
 *   dbo.tTehPostupak   -> public.bigtehn_tech_routing_cache
 *   dbo.tTehPostupak   -> public.bigtehn_rework_scrap_cache (G4, kvalitet 1/2)
 *
 * Posle uspešnog sync-a `tech` (ako je u listi tabela) poziva Supabase RPC
 * `mark_in_progress_from_tech_routing` (G6) — vidi `servoteh-plan-montaze` SQL migracije.
 *
 * Default je --scope=open: svi nezavršeni RN-ovi, bez "poslednjih 30 dana".
 * Env: BIGTEHN_SQL_* (kako u .env.example) sa fallback-om na MSSQL_*.
 */

import 'dotenv/config';
import sql from 'mssql';
import { createClient } from '@supabase/supabase-js';

const TABLE_ORDER = ['work-orders', 'lines', 'tech', 'rework-scrap'];
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function log(level, msg, extra) {
  const min = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
  if ((LEVELS[level] ?? LEVELS.info) < min) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'production-backfill',
    msg,
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function envAny(names, fallback = null) {
  for (const name of names) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  if (fallback != null) return fallback;
  throw new Error(`Missing required env var: ${names.join(' or ')}`);
}

function intAny(names, fallback) {
  const v = envAny(names, String(fallback));
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolAny(names, fallback) {
  const v = envAny(names, fallback ? 'true' : 'false');
  return /^(1|true|yes|on)$/i.test(v);
}

function parseArgs(argv) {
  const out = { scope: 'open', tables: TABLE_ORDER, dryRun: false, batch: 500, limit: null };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--scope=')) {
      const scope = a.slice('--scope='.length).trim().toLowerCase();
      if (scope !== 'open' && scope !== 'all') throw new Error(`Invalid --scope=${scope}`);
      out.scope = scope;
    } else if (a.startsWith('--tables=')) {
      const tables = a.slice('--tables='.length).split(',').map(s => s.trim()).filter(Boolean);
      const bad = tables.filter(t => !TABLE_ORDER.includes(t));
      if (bad.length) {
        throw new Error(
          `Invalid --tables value(s): ${bad.join(', ')}; expected ${TABLE_ORDER.join(',')}`,
        );
      }
      out.tables = TABLE_ORDER.filter(t => tables.includes(t));
    } else if (a.startsWith('--batch=')) {
      const n = Number.parseInt(a.slice('--batch='.length), 10);
      if (Number.isFinite(n) && n > 0) out.batch = n;
    } else if (a.startsWith('--limit=')) {
      const n = Number.parseInt(a.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) out.limit = n;
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    } else {
      log('warn', 'unknown flag ignored', { flag: a });
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/backfill-production-cache.js [options]',
      '',
      'Options:',
      '  --scope=open       (default) svi nezavršeni RN-ovi, bez date filtera',
      '  --scope=all        cela istorija, bez status/date filtera',
      '  --tables=a,b       work-orders,lines,tech,rework-scrap (default: sve četiri)',
      '  --batch=500        veličina batch-a za select/upsert',
      '  --limit=N          test limit po tabeli',
      '  --dry-run          čita i broji, ne piše u Supabase',
      '  -h, --help         prikaži help',
      '',
    ].join('\n'),
  );
}

const iso = v => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const numOr = (v, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
const nullableNum = v => (v == null || v === '' ? null : numOr(v, null));
const textOrNull = v => (v == null ? null : String(v));
const boolOr = (v, def = false) => (v == null ? def : Boolean(v));

function mapWorkOrderRow(r) {
  return {
    id: Number(r.IDRN),
    item_id: nullableNum(r.IDPredmet),
    customer_id: nullableNum(r.BBIDKomitent),
    ident_broj: String(r.IdentBroj ?? '').trim(),
    varijanta: numOr(r.Varijanta),
    broj_crteza: r.BrojCrteza == null ? null : String(r.BrojCrteza).trim(),
    naziv_dela: textOrNull(r.NazivDela),
    materijal: textOrNull(r.Materijal),
    dimenzija_materijala: textOrNull(r.DimenzijaMaterijala),
    jedinica_mere: textOrNull(r.JM),
    komada: numOr(r.Komada),
    tezina_neobr: numOr(r.TezinaNeobrDela),
    tezina_obr: numOr(r.TezinaObrDela),
    status_rn: boolOr(r.StatusRN),
    zakljucano: boolOr(r.Zakljucano),
    revizija: textOrNull(r.Revizija),
    quality_type_id: nullableNum(r.IDVrstaKvaliteta),
    handover_status_id: nullableNum(r.IDStatusPrimopredaje),
    napomena: textOrNull(r.Napomena),
    rok_izrade: iso(r.RokIzrade),
    datum_unosa: iso(r.DatumUnosa),
    created_at: iso(r.DIVUnosaRN),
    modified_at: iso(r.DIVIspravkeRN),
    author_worker_id: nullableNum(r.SifraRadnika),
    synced_at: new Date().toISOString(),
  };
}

function mapLineRow(r) {
  return {
    id: Number(r.IDStavkeRN),
    work_order_id: Number(r.IDRN),
    operacija: numOr(r.Operacija),
    machine_code: textOrNull(r.RJgrupaRC),
    opis_rada: textOrNull(r.OpisRada),
    alat_pribor: textOrNull(r.AlatPribor),
    tpz: numOr(r.Tpz),
    tk: numOr(r.Tk),
    tezina_to: numOr(r.TezinaTO),
    author_worker_id: nullableNum(r.SifraRadnika),
    created_at: iso(r.DIVUnosa),
    modified_at: iso(r.DIVIspravke),
    prioritet: numOr(r.Prioritet),
    synced_at: new Date().toISOString(),
  };
}

function mapTechRow(r) {
  return {
    id: Number(r.IDPostupka),
    work_order_id: nullableNum(r.IDRN),
    item_id: nullableNum(r.IDPredmet),
    worker_id: nullableNum(r.SifraRadnika),
    quality_type_id: nullableNum(r.IDVrstaKvaliteta),
    operacija: numOr(r.Operacija),
    machine_code: textOrNull(r.RJgrupaRC),
    komada: numOr(r.Komada),
    prn_timer_seconds: nullableNum(r.PrnTimer),
    started_at: iso(r.DatumIVremeUnosa),
    finished_at: iso(r.DatumIVremeZavrsetka),
    is_completed: boolOr(r.ZavrsenPostupak),
    ident_broj: textOrNull(r.IdentBroj),
    varijanta: numOr(r.Varijanta),
    toznaka: textOrNull(r.Toznaka),
    potpis: textOrNull(r.Potpis),
    napomena: textOrNull(r.Napomena),
    dorada_operacije: numOr(r.DoradaOperacije),
    synced_at: new Date().toISOString(),
  };
}

function mapReworkScrapRow(r) {
  return {
    id: Number(r.IDPostupka),
    work_order_id: nullableNum(r.IDRN),
    item_id: nullableNum(r.IDPredmet),
    ident_broj: textOrNull(r.IdentBroj),
    varijanta: numOr(r.Varijanta),
    operacija: numOr(r.Operacija),
    machine_code: textOrNull(r.RJgrupaRC),
    worker_id: nullableNum(r.SifraRadnika),
    quality_type_id: nullableNum(r.IDVrstaKvaliteta),
    pieces: numOr(r.Komada),
    prn_timer_seconds: nullableNum(r.PrnTimer),
    started_at: iso(r.DatumIVremeUnosa),
    finished_at: iso(r.DatumIVremeZavrsetka),
    is_completed: boolOr(r.ZavrsenPostupak),
    dorada_operacije: numOr(r.DoradaOperacije),
    napomena: textOrNull(r.Napomena),
    synced_at: new Date().toISOString(),
  };
}

const SOURCES = {
  'work-orders': {
    target: 'bigtehn_work_orders_cache',
    idCol: 'IDRN',
    from: 'dbo.tRN src',
    selectCols: [
      'src.IDRN',
      'src.IDPredmet',
      'src.BBIDKomitent',
      'src.IdentBroj',
      'src.Varijanta',
      'src.BrojCrteza',
      'src.NazivDela',
      'src.Materijal',
      'src.DimenzijaMaterijala',
      'src.JM',
      'src.Komada',
      'src.TezinaNeobrDela',
      'src.TezinaObrDela',
      'src.StatusRN',
      'src.Zakljucano',
      'src.Revizija',
      'src.IDVrstaKvaliteta',
      'src.IDStatusPrimopredaje',
      'CAST(src.Napomena AS NVARCHAR(MAX)) AS Napomena',
      'src.RokIzrade',
      'src.DatumUnosa',
      'src.DIVUnosaRN',
      'src.DIVIspravkeRN',
      'src.SifraRadnika',
    ],
    openWhere: 'ISNULL(src.StatusRN, 0) = 0',
    map: mapWorkOrderRow,
  },
  lines: {
    target: 'bigtehn_work_order_lines_cache',
    idCol: 'IDStavkeRN',
    from: 'dbo.tStavkeRN src',
    selectCols: [
      'src.IDStavkeRN',
      'src.IDRN',
      'src.Operacija',
      'src.RJgrupaRC',
      'CAST(src.OpisRada AS NVARCHAR(MAX)) AS OpisRada',
      'src.AlatPribor',
      'src.Tpz',
      'src.Tk',
      'src.TezinaTO',
      'src.SifraRadnika',
      'src.DIVUnosa',
      'src.DIVIspravke',
      'src.Prioritet',
    ],
    joinForOpen: 'INNER JOIN dbo.tRN rn ON rn.IDRN = src.IDRN',
    openWhere: 'ISNULL(rn.StatusRN, 0) = 0',
    map: mapLineRow,
  },
  tech: {
    target: 'bigtehn_tech_routing_cache',
    idCol: 'IDPostupka',
    from: 'dbo.tTehPostupak src',
    selectCols: [
      'src.IDPostupka',
      'src.SifraRadnika',
      'src.IDPredmet',
      'src.IdentBroj',
      'src.Varijanta',
      'src.PrnTimer',
      'src.DatumIVremeUnosa',
      'src.Operacija',
      'src.RJgrupaRC',
      'src.Toznaka',
      'src.Komada',
      'src.Potpis',
      'src.DatumIVremeZavrsetka',
      'src.ZavrsenPostupak',
      'CAST(src.Napomena AS NVARCHAR(MAX)) AS Napomena',
      'src.IDRN',
      'src.IDVrstaKvaliteta',
      'src.DoradaOperacije',
    ],
    joinForOpen: 'INNER JOIN dbo.tRN rn ON rn.IDRN = src.IDRN',
    openWhere: 'ISNULL(rn.StatusRN, 0) = 0',
    map: mapTechRow,
  },
  'rework-scrap': {
    target: 'bigtehn_rework_scrap_cache',
    idCol: 'IDPostupka',
    from: 'dbo.tTehPostupak src',
    selectCols: [
      'src.IDPostupka',
      'src.SifraRadnika',
      'src.IDPredmet',
      'src.IdentBroj',
      'src.Varijanta',
      'src.PrnTimer',
      'src.DatumIVremeUnosa',
      'src.Operacija',
      'src.RJgrupaRC',
      'src.Komada',
      'src.DatumIVremeZavrsetka',
      'src.ZavrsenPostupak',
      'CAST(src.Napomena AS NVARCHAR(MAX)) AS Napomena',
      'src.IDRN',
      'src.IDVrstaKvaliteta',
      'src.DoradaOperacije',
    ],
    joinForOpen: 'INNER JOIN dbo.tRN rn ON rn.IDRN = src.IDRN',
    openWhere: 'ISNULL(rn.StatusRN, 0) = 0 AND src.IDVrstaKvaliteta IN (1, 2)',
    extraWhere: 'src.IDVrstaKvaliteta IN (1, 2)',
    map: mapReworkScrapRow,
  },
};

function createSupabaseServiceClient() {
  return createClient(envAny(['SUPABASE_URL']).replace(/\/+$/, ''), envAny(['SUPABASE_SERVICE_ROLE_KEY']), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-production-backfill': '1' } },
  });
}

async function createMssqlPool() {
  return await new sql.ConnectionPool({
    server: envAny(['BIGTEHN_SQL_SERVER', 'MSSQL_HOST']),
    port: intAny(['BIGTEHN_SQL_PORT', 'MSSQL_PORT'], 1433),
    user: envAny(['BIGTEHN_SQL_USER', 'MSSQL_USER']),
    password: envAny(['BIGTEHN_SQL_PASSWORD', 'MSSQL_PASSWORD']),
    database: envAny(['BIGTEHN_SQL_DATABASE', 'MSSQL_DATABASE']),
    options: {
      encrypt: boolAny(['BIGTEHN_SQL_ENCRYPT', 'MSSQL_ENCRYPT'], false),
      trustServerCertificate: boolAny(
        ['BIGTEHN_SQL_TRUST_SERVER_CERTIFICATE', 'MSSQL_TRUST_SERVER_CERT'],
        true,
      ),
    },
    pool: {
      max: intAny(['BIGTEHN_SQL_POOL_MAX', 'MSSQL_POOL_MAX'], 4),
      min: intAny(['BIGTEHN_SQL_POOL_MIN'], 0),
      idleTimeoutMillis: 30000,
    },
    requestTimeout: intAny(['BIGTEHN_SQL_REQUEST_TIMEOUT_MS', 'MSSQL_REQUEST_TIMEOUT_MS'], 120000),
    connectionTimeout: intAny(['BIGTEHN_SQL_CONNECTION_TIMEOUT_MS'], 15000),
  }).connect();
}

function fromClause(src, scope) {
  if (scope === 'open' && src.joinForOpen) {
    return `${src.from} ${src.joinForOpen}`;
  }
  return src.from;
}

function whereClause(src, scope) {
  const parts = [`src.${src.idCol} > @LastId`];
  if (scope === 'open' && src.openWhere) parts.push(src.openWhere);
  else if (src.extraWhere) parts.push(src.extraWhere);
  return parts.join(' AND ');
}

async function countRows(pool, src, scope) {
  const req = pool.request();
  req.input('LastId', sql.Int, 0);
  const q = `
    SELECT COUNT(*) AS n
    FROM ${fromClause(src, scope)}
    WHERE ${whereClause(src, scope)}
  `;
  const res = await req.query(q);
  return Number(res.recordset?.[0]?.n ?? 0);
}

async function* selectBatches(pool, src, { scope, batchSize, limit }) {
  let lastId = 0;
  let fetched = 0;
  while (true) {
    const effectiveBatchSize = limit ? Math.min(batchSize, Math.max(limit - fetched, 0)) : batchSize;
    if (effectiveBatchSize <= 0) return;
    const req = pool.request();
    req.input('LastId', sql.Int, lastId);
    req.input('BatchSize', sql.Int, effectiveBatchSize);
    const q = `
      SELECT TOP (@BatchSize) ${src.selectCols.join(',\n        ')}
      FROM ${fromClause(src, scope)}
      WHERE ${whereClause(src, scope)}
      ORDER BY src.${src.idCol} ASC
    `;
    const res = await req.query(q);
    const rows = res.recordset ?? [];
    if (!rows.length) return;
    lastId = Number(rows[rows.length - 1][src.idCol]);
    fetched += rows.length;
    yield rows;
    if (rows.length < batchSize) return;
    if (limit && fetched >= limit) return;
  }
}

async function upsertBatch(sb, table, rows) {
  if (!rows.length) return;
  const { error } = await sb.from(table).upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(`${table} upsert failed: ${error.message}`);
}

async function syncOneTable(pool, sb, tableKey, args) {
  const src = SOURCES[tableKey];
  log('info', 'table sync starting', {
    table: tableKey,
    target: src.target,
    scope: args.scope,
    batch: args.batch,
    limit: args.limit,
    dry_run: args.dryRun,
  });

  const totalRows = await countRows(pool, src, args.scope);
  log('info', 'mssql source size', { table: tableKey, total_rows: totalRows });

  let seen = 0;
  let upserted = 0;
  for await (const rows of selectBatches(pool, src, {
    scope: args.scope,
    batchSize: args.batch,
    limit: args.limit,
  })) {
    seen += rows.length;
    const mapped = rows.map(src.map);
    if (!args.dryRun) await upsertBatch(sb, src.target, mapped);
    upserted += mapped.length;
    log('info', 'batch done', { table: tableKey, seen, upserted, last_id: rows[rows.length - 1][src.idCol] });
    if (args.limit && seen >= args.limit) break;
  }

  log('info', 'table sync complete', { table: tableKey, seen, upserted, dry_run: args.dryRun });
  return { table: tableKey, seen, upserted };
}

async function runPostProductionSyncRpc(sb, args) {
  if (args.dryRun) return null;
  if (!args.tables.includes('tech')) return null;

  log('info', 'post-sync rpc starting', { rpc: 'mark_in_progress_from_tech_routing' });
  const { data, error } = await sb.rpc('mark_in_progress_from_tech_routing');
  if (error) throw new Error(`mark_in_progress_from_tech_routing failed: ${error.message}`);
  log('info', 'post-sync rpc complete', {
    rpc: 'mark_in_progress_from_tech_routing',
    result: data,
  });
  return data;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  log('info', 'production backfill starting', {
    scope: args.scope,
    tables: args.tables,
    batch: args.batch,
    limit: args.limit,
    dry_run: args.dryRun,
  });

  const sb = createSupabaseServiceClient();
  const pool = await createMssqlPool();
  try {
    const results = [];
    for (const tableKey of args.tables) {
      results.push(await syncOneTable(pool, sb, tableKey, args));
    }
    const postSync = await runPostProductionSyncRpc(sb, args);
    log('info', 'production backfill complete', { results, post_sync: postSync, dry_run: args.dryRun });
  } finally {
    await pool.close();
  }
}

main().catch(err => {
  log('error', 'fatal', { error: err?.message || String(err), stack: err?.stack });
  process.exit(1);
});

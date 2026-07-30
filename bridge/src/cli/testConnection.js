import { describeConfig } from '../config.js';
import { closeSqlPool, runQuery } from '../db/sqlserver.js';
import { getSupabase } from '../db/supabase.js';
import { logger } from '../logger.js';

async function main() {
  logger.info({ config: describeConfig() }, 'test:connection start');

  let sqlOk = false;
  let supaOk = false;

  try {
    const rows = await runQuery('SELECT @@VERSION AS version, GETDATE() AS now');
    logger.info({ result: rows[0] }, '✓ BigTehn SQL Server reachable');
    sqlOk = true;
  } catch (err) {
    logger.error({ err }, '✗ BigTehn SQL Server connection FAILED');
  }

  try {
    const supa = getSupabase();
    const { error, count } = await supa
      .from('bridge_sync_log')
      .select('id', { count: 'exact', head: true });
    if (error) throw error;
    logger.info({ syncLogRows: count }, '✓ Supabase reachable, bridge_sync_log accessible');
    supaOk = true;
  } catch (err) {
    logger.error(
      { err: err?.message || err },
      '✗ Supabase connection FAILED (proveri SUPABASE_URL/SERVICE_ROLE_KEY i da li bridge_sync_log tabela postoji)',
    );
  }

  await closeSqlPool();

  if (sqlOk && supaOk) {
    logger.info('all connections OK');
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch(async (err) => {
  logger.fatal({ err }, 'test:connection crashed');
  await closeSqlPool().catch(() => {});
  process.exit(1);
});

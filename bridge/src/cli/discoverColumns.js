/**
 * Helper za otkrivanje stvarnih kolona BigTehn tabele.
 * Korisno kad sync padne sa "Invalid column name 'X'" jer pretpostavljena
 * shema u syncLocations (i sl.) ne odgovara stvarnoj.
 *
 * Upotreba:
 *   npm run discover:columns -- tLokacijeDelova
 *   npm run discover:columns -- tRN
 *   npm run discover:columns -- tStavkeRN
 */
import { closeSqlPool, sql, getSqlPool } from '../db/sqlserver.js';
import { logger } from '../logger.js';

async function main() {
  const tableName = process.argv[2];
  if (!tableName) {
    console.error('Upotreba: npm run discover:columns -- <ImeTabele>');
    console.error('Primer:  npm run discover:columns -- tLokacijeDelova');
    process.exit(2);
  }

  try {
    const pool = await getSqlPool();
    const result = await pool
      .request()
      .input('table', sql.NVarChar(128), tableName)
      .query(`
        SELECT
          c.COLUMN_NAME,
          c.DATA_TYPE,
          c.CHARACTER_MAXIMUM_LENGTH AS max_len,
          c.IS_NULLABLE,
          c.COLUMN_DEFAULT
        FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_NAME = @table
        ORDER BY c.ORDINAL_POSITION;
      `);

    const cols = result.recordset || [];
    if (cols.length === 0) {
      console.error(
        `\n[discover] Tabela "${tableName}" ne postoji ili nemaš pristup.\n`,
      );
      process.exit(1);
    }

    console.log(`\n[discover] Tabela: ${tableName}  (${cols.length} kolona)\n`);
    console.log(
      'KOLONA'.padEnd(36) +
        'TIP'.padEnd(18) +
        'NULL?'.padEnd(8) +
        'DEFAULT',
    );
    console.log('-'.repeat(80));
    for (const c of cols) {
      const tip =
        c.max_len && c.max_len !== -1
          ? `${c.DATA_TYPE}(${c.max_len})`
          : c.DATA_TYPE;
      console.log(
        String(c.COLUMN_NAME).padEnd(36) +
          String(tip).padEnd(18) +
          String(c.IS_NULLABLE).padEnd(8) +
          (c.COLUMN_DEFAULT ?? ''),
      );
    }
    console.log('');

    // Za prvih 5 redova: dodatni SELECT TOP 5 (ako tabela nije prazna)
    try {
      const sample = await pool
        .request()
        .query(`SELECT TOP 5 * FROM ${tableName.replace(/[^a-zA-Z0-9_]/g, '')};`);
      if (sample.recordset && sample.recordset.length > 0) {
        console.log(`[discover] Sample TOP 5 redova:\n`);
        console.dir(sample.recordset, { depth: 2, maxArrayLength: 5 });
      } else {
        console.log('[discover] Tabela je prazna.');
      }
    } catch (sampleErr) {
      logger.warn({ err: sampleErr.message }, '[discover] sample fetch skipped');
    }
  } finally {
    await closeSqlPool();
  }
}

main().catch(async (err) => {
  console.error('[discover] crashed:', err.message || err);
  await closeSqlPool().catch(() => {});
  process.exit(1);
});

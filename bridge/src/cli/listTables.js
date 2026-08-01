import { closeSqlPool, getSqlPool, sql } from '../db/sqlserver.js';
import { logger } from '../logger.js';

/**
 * CLI helper: listuje sve TABELE i VIEW-ove iz `QBigTehn` baze.
 *
 * Koristi se kad ne znamo tačno ime tabele i hoćemo da pretražimo bazu.
 * Opcioni argument je SQL `LIKE` pattern (case-insensitive).
 *
 * Primeri:
 *   npm run list:tables
 *   npm run list:tables -- kvalitet
 *   npm run list:tables -- "%pozicij%"
 *   npm run list:tables -- lokacij
 */
async function main() {
  const arg = process.argv[2];
  let pattern = null;
  if (arg) {
    pattern = arg.includes('%') ? arg : `%${arg}%`;
  }

  try {
    const pool = await getSqlPool();
    const request = pool.request();

    let query;
    if (pattern) {
      request.input('pattern', sql.NVarChar, pattern);
      query = `
        SELECT
          TABLE_SCHEMA AS schema_name,
          TABLE_NAME   AS table_name,
          TABLE_TYPE   AS table_type
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_NAME LIKE @pattern
        ORDER BY TABLE_TYPE, TABLE_NAME;
      `;
    } else {
      query = `
        SELECT
          TABLE_SCHEMA AS schema_name,
          TABLE_NAME   AS table_name,
          TABLE_TYPE   AS table_type
        FROM INFORMATION_SCHEMA.TABLES
        ORDER BY TABLE_TYPE, TABLE_NAME;
      `;
    }

    const result = await request.query(query);
    const rows = result.recordset || [];

    if (!rows.length) {
      console.log(
        `\n[list-tables] Nema rezultata${pattern ? ` za pattern "${pattern}"` : ''}.\n`,
      );
      return;
    }

    console.log(
      `\n[list-tables] ${rows.length} rezultata${pattern ? ` (LIKE ${pattern})` : ''}\n`,
    );
    console.log(['NAZIV'.padEnd(50), 'TIP'.padEnd(15), 'SCHEMA'].join(''));
    console.log('-'.repeat(85));
    for (const r of rows) {
      console.log(
        [
          String(r.table_name || '').padEnd(50),
          String(r.table_type || '').padEnd(15),
          String(r.schema_name || ''),
        ].join(''),
      );
    }
    console.log('');
  } catch (err) {
    logger.error({ err }, '[list-tables] failed');
    process.exitCode = 1;
  } finally {
    await closeSqlPool();
  }
}

main();

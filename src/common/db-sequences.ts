import type { Prisma } from "@prisma/client";

/**
 * Poravnaj identity sekvencu tabele sa MAX(id) pre insert-a — sync/import mogu
 * da upišu eksplicitne (legacy) id-jeve, pa autoincrement inače kolidira.
 *
 * OBAVEZNO **3-arg `setval`** sa `is_called = EXISTS(rows)`: na PRAZNOJ tabeli
 * postavlja `is_called=false` (sledeći `nextval` = 1), dok stari 2-arg oblik
 * `setval(seq, 0)` puca sa SQLSTATE 22003 (minimum sekvence je 1) → 500 na
 * svežoj bazi. `table` je literal iz koda, nikad korisnički unos.
 */
export async function alignIdSequence(
  tx: Prisma.TransactionClient,
  table: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('${table}','id'), COALESCE((SELECT MAX(id) FROM ${table}),1), EXISTS(SELECT 1 FROM ${table}))`,
  );
}

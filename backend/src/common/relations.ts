/**
 * Batch razrešavanje FK-ova bez Prisma required-relation JOIN-a.
 *
 * Legacy 1:1 podaci imaju „orphan" FK-ove (npr. `worker_id = 0` bez radnika 0,
 * prazna `handover_statuses`). Prisma `include`/`select` nad **obaveznom** relacijom
 * baci `Inconsistent query result: Field is required to return data, got null`
 * → 500. Zato FK-ove razrešavamo zasebnim upitima i mapiramo (null ako fali).
 */
export function byId<T extends { id: number }>(rows: T[]): Map<number, T> {
  return new Map(rows.map((r) => [r.id, r]));
}

/** Jedinstveni pozitivni id-jevi (izbaci 0/null/duplikate) za `WHERE id IN (...)`. */
export function uniqueIds(ids: (number | null | undefined)[]): number[] {
  return [
    ...new Set(ids.filter((n): n is number => typeof n === "number" && n > 0)),
  ];
}

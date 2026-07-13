import { Prisma } from "@prisma/client";

/**
 * Single source of truth for the "technologist" criterion (P4 spec §6.3,
 * decision #2): a technologist is an ACTIVE worker whose worker type is named
 * 'Tehnolog' (`worker_types`; prod id 1, legacy parity
 * `tRadnici.IDVrsteRadnika=1`). Matched by NAME (case-insensitive) rather than
 * a hard-coded id so a reseeded lookup table keeps working; multiple matching
 * types are all included.
 *
 * `defines_approval` is deliberately NOT part of this criterion — it stays a
 * separate RN-level approve/launch gate (spec §6.2) and must not be touched
 * here. Consumers: `GET /handovers/technologists`, `approve()` technologist
 * validation, take-over actor gate (§6.4) and
 * `NotificationsService.resolveTechnologistWorkerIds()`.
 *
 * All lookups are batch queries without required JOINs (legacy-read rule:
 * an orphan `workerTypeId` must not 500).
 */
export const TECHNOLOGIST_TYPE_NAME = "Tehnolog";

/** Minimal Prisma surface the helpers need — PrismaService and `tx` both fit. */
export type TechnologistCriteriaDb = Pick<
  Prisma.TransactionClient,
  "workerType" | "worker"
>;

/** Worker fields needed to evaluate the criterion for a single worker. */
export const TECHNOLOGIST_CHECK_SELECT = {
  id: true,
  active: true,
  workerTypeId: true,
} satisfies Prisma.WorkerSelect;

/** Ids of `worker_types` matching 'Tehnolog' — `[]` when the lookup has no match. */
export async function resolveTechnologistTypeIds(
  db: TechnologistCriteriaDb,
): Promise<number[]> {
  const types = await db.workerType.findMany({
    where: { name: { equals: TECHNOLOGIST_TYPE_NAME, mode: "insensitive" } },
    select: { id: true },
  });
  return types.map((t) => t.id).filter((id) => id > 0);
}

/**
 * Prisma `where` filter for active technologist workers, or `null` when no
 * matching worker type exists (callers should then return an empty list
 * instead of querying with `in: []`).
 */
export async function technologistWorkerWhere(
  db: TechnologistCriteriaDb,
): Promise<Prisma.WorkerWhereInput | null> {
  const typeIds = await resolveTechnologistTypeIds(db);
  if (!typeIds.length) return null;
  return { active: true, workerTypeId: { in: typeIds } };
}

/** Active technologist worker ids (notification fan-out, list criterion §6.3). */
export async function resolveTechnologistWorkerIds(
  db: TechnologistCriteriaDb,
): Promise<number[]> {
  const where = await technologistWorkerWhere(db);
  if (!where) return [];
  const workers = await db.worker.findMany({ where, select: { id: true } });
  return workers.map((w) => w.id);
}

/**
 * Whether an already-loaded worker (`TECHNOLOGIST_CHECK_SELECT` shape)
 * satisfies the criterion: active + worker type named 'Tehnolog'. The caller
 * loads the worker itself so it can distinguish "does not exist" from
 * "not a technologist" in its error messages.
 */
export async function isActiveTechnologist(
  db: TechnologistCriteriaDb,
  worker: { active: boolean | null; workerTypeId: number },
): Promise<boolean> {
  if (worker.active !== true) return false;
  const typeIds = await resolveTechnologistTypeIds(db);
  return typeIds.includes(worker.workerTypeId);
}

// ---------------------------------------------------------------- inženjeri

/**
 * Paralelni kriterijum za PROJEKTANTE biroa (živa proba 13.07.2026: designer
 * picker je nudio bilo koju šifru, pa i neaktivnog operatera): projektant =
 * AKTIVAN radnik vrste 'Inženjeri' (worker_types; prod id 5). Ista mehanika
 * kao tehnolog kriterijum — po IMENU vrste, bez required JOIN-a. Potrošači:
 * `GET /handovers/engineers` (picker) — namerno NE hard-gate u create()
 * (admin/test nalozi bez inženjer-radnika moraju moći da vode nacrt), tamo se
 * proverava samo da je radnik AKTIVAN.
 */
export const ENGINEER_TYPE_NAME = "Inženjeri";

/** Ids of `worker_types` matching 'Inženjeri' — `[]` when no match. */
export async function resolveEngineerTypeIds(
  db: TechnologistCriteriaDb,
): Promise<number[]> {
  const types = await db.workerType.findMany({
    where: { name: { equals: ENGINEER_TYPE_NAME, mode: "insensitive" } },
    select: { id: true },
  });
  return types.map((t) => t.id).filter((id) => id > 0);
}

/** Prisma `where` za aktivne inženjere, ili `null` kad vrsta ne postoji. */
export async function engineerWorkerWhere(
  db: TechnologistCriteriaDb,
): Promise<Prisma.WorkerWhereInput | null> {
  const typeIds = await resolveEngineerTypeIds(db);
  if (!typeIds.length) return null;
  return { active: true, workerTypeId: { in: typeIds } };
}

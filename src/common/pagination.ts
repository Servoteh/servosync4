/**
 * Shared pagination helpers for read-only domain list endpoints.
 * Query params arrive as strings; parse + clamp here so services stay simple.
 */

export interface PageParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/** Parse `?page=&pageSize=` with sane defaults and an upper bound. */
export function parsePagination(
  page?: string,
  pageSize?: string,
  maxSize = 200,
): PageParams {
  const p = Math.max(1, Number.parseInt(page ?? "1", 10) || 1);
  const s = Math.min(
    maxSize,
    Math.max(1, Number.parseInt(pageSize ?? "50", 10) || 50),
  );
  return { page: p, pageSize: s, skip: (p - 1) * s, take: s };
}

/** Standard `meta.pagination` block for the `{ data, meta }` envelope. */
export function pageMeta(page: number, pageSize: number, total: number) {
  return {
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

/** Safe subset of `Worker` — NEVER expose `password` / `workerPassword`. */
export const SAFE_WORKER_SELECT = {
  id: true,
  fullName: true,
  username: true,
} as const;

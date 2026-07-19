'use client';

// Praćenje (F3) — konsolidovani upis override-a jednog reda (status / mašinska /
// površinska / RUČNA KOLIČINA + razlog) u JEDNOM PUT-u ka `/predmeti/:itemId/override`.
//
// Zašto lokalni hook, a ne `api/pracenje.ts` `useUpsertOverride`:
//   • `useUpsertOverride` ne nosi `manualQty`/`reason` (docx §4.6), a taj fajl je
//     vlasništvo BE agenta (ne dira se) — pa ista ruta ovde, sa punim payload-om.
//   • BE `pracenje_overrides` radi PUN upsert: SVAKI upis prepisuje CEO red. Zato svaki
//     upis MORA da nosi kompletno trenutno stanje override-a — inače bi izmena jednog
//     polja obrisala ostala (npr. ručna količina bi pala kad se prebaci mašinska DA/NE).
//   `buildOverridePayload` zato gradi pun payload iz reda + „patch" (izmenjeno polje).
//
// OGRANIČENJE: BE ne emituje `reason` uz red praćenja, pa se razlog NE može round-trip-ovati
// — čuva se samo dok se piše kroz modal ručne količine; izmena drugog polja (npr. mašinska)
// ga briše. Ručna KOLIČINA se čuva (BE je emituje kao `manual_qty`).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/api/client';
import type { IzvestajRow } from '@/api/pracenje';

const BASE = '/v1/pracenje';

export interface OverridePayload {
  itemId: number;
  bigtehnRnId: string;
  rnId?: string;
  status?: string;
  masinska?: boolean | null;
  povrsinska?: boolean | null;
  manualQty?: number | null;
  reason?: string;
}

/** Izmenjeno polje(a); ostalo se preuzima iz trenutnog stanja reda. */
export type OverridePatch = Partial<{
  status: string | null;
  masinska: boolean | null;
  povrsinska: boolean | null;
  manualQty: number | null;
  reason: string | null;
}>;

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Trenutna ručna količina reda (BE emit `manual_qty`, čita se preko index-potpisa). */
export function rowManualQty(r: IzvestajRow): number | null {
  return toNum((r as Record<string, unknown>).manual_qty);
}

/** Sastavi PUN override payload: postojeće stanje reda + izmenjeni „patch". */
export function buildOverridePayload(
  itemId: number,
  r: IzvestajRow,
  patch: OverridePatch,
): OverridePayload {
  const node = String(r.node_id ?? '');
  const curStatus = (r.status_override ?? '') as string;
  const status = patch.status !== undefined ? patch.status ?? '' : curStatus;
  const masinska =
    patch.masinska !== undefined ? patch.masinska : r.masinska_done_override ?? null;
  const povrsinska =
    patch.povrsinska !== undefined ? patch.povrsinska : r.povrsinska_done_override ?? null;
  const manualQty = patch.manualQty !== undefined ? patch.manualQty : rowManualQty(r);
  const reason = patch.reason != null && patch.reason !== '' ? patch.reason : undefined;
  return {
    itemId,
    bigtehnRnId: node,
    rnId: r.rn_id != null ? String(r.rn_id) : undefined,
    // '' → omit (auto); BE DTO `@IsOptional @IsIn([...])` odbija prazan string.
    status: status ? status : undefined,
    masinska,
    povrsinska,
    manualQty: manualQty ?? null,
    reason,
  };
}

/** PUT /v1/pracenje/predmeti/:itemId/override — pun payload (pracenje.manage). */
export function useOverrideUpsert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, ...body }: OverridePayload) =>
      apiFetch(`${BASE}/predmeti/${itemId}/override`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pracenje'] }),
  });
}

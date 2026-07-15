'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated } from './tech-processes';

/**
 * Kontrola kvaliteta — evidencija neusaglašenosti (škart + dorada).
 * Backend: /v1/kvalitet (MODULE_SPEC_kontrola_kvaliteta.md §3–§7). Digitalizacija
 * dva Excel fajla („Evidencija škartova/dorada 2026"). Draft izveštaji (status 0)
 * nastaju automatski iz kucanja kontrole; kontrolor ih dopuni i POTVRDI (status 1),
 * čime server dodeljuje broj `NNN/YY` po (tip, godina). Ručni „Novi izveštaj" je
 * ravnopravan tok. Endpoints:
 *   GET  /v1/kvalitet/reports        · paginirana lista (filteri type/status/from/to/q)
 *   GET  /v1/kvalitet/reports/:id    · detalj
 *   POST /v1/kvalitet/reports        · novi (draft/ručni)
 *   PATCH /v1/kvalitet/reports/:id   · izmena poslovnih polja + izvršioci
 *   POST /v1/kvalitet/reports/:id/confirm · potvrda → dodeljuje broj
 *   DELETE /v1/kvalitet/reports/:id  · brisanje (samo draft)
 *   GET  /v1/kvalitet/summary-mini   · brojači draft-ova po tipu (bedž na tabovima)
 */

// ─────────────────────────────────────────────────────────────── konstante

/** Tip neusaglašenosti (poklapa PART_QUALITY iz kucanja kontrole). */
export const NONCONFORMITY_TYPE = { REWORK: 1, SCRAP: 2 } as const;
export type NonconformityType = (typeof NONCONFORMITY_TYPE)[keyof typeof NONCONFORMITY_TYPE];

/** 0 = draft (auto iz kioska / nepotvrđen), 1 = potvrđen (ima broj). */
export const NONCONFORMITY_STATUS = { DRAFT: 0, CONFIRMED: 1 } as const;
export type NonconformityStatus =
  (typeof NONCONFORMITY_STATUS)[keyof typeof NONCONFORMITY_STATUS];

// ─────────────────────────────────────────────────────────────── tipovi

/** Kontrolor koji je istakao neusaglašenost („Neusaglašenost ističe"). */
export interface RaisedByRef {
  fullName: string | null;
}

/** Izvršilac-radnik (M:N) — ovo puni „Moj profil" (kasnija faza). */
export interface CulpritWorker {
  workerId: number;
  fullName: string | null;
}

/** Red liste / detalj izveštaja o neusaglašenosti — GET /v1/kvalitet/reports(/:id). */
export interface NonconformityReport {
  id: number;
  type: NonconformityType;
  /** „028/26" — null dok je draft (broj se dodeljuje tek pri potvrdi). */
  reportNumber: string | null;
  reportYear: number;
  reportDate: string;
  status: NonconformityStatus;
  // Veza na proizvodnju (meki FK-ovi; slobodan tekst uvek postoji).
  workOrderId: number | null;
  identNumber: string | null;
  sourceTechProcessId: number | null;
  drawingNumber: string | null;
  partName: string | null;
  customerName: string | null;
  quantity: number;
  defectDescription: string;
  cause: string | null;
  workUnit: string | null;
  /** Izvršilac — slobodan tekst (org jedinice / spoljni), dopuna M:N vezi. */
  culpritText: string | null;
  materialCostNote: string | null;
  coopCostNote: string | null;
  spentHoursText: string | null;
  /** Parsirano iz `spentHoursText` (best-effort) za izveštaje. */
  spentHours: number | null;
  note: string | null;
  preventiveMeasures: string | null;
  /** „Dodatno" — samo dorada (tip 1). */
  extra: string | null;
  raisedByWorkerId: number | null;
  raisedBy: RaisedByRef | null;
  culpritWorkers: CulpritWorker[];
  createdAt: string;
}

/**
 * Telo za POST/PATCH — poslovna polja + izvršioci-radnici. Sva su opciona:
 * PATCH šalje samo izmenjena, POST traži bar `type` + `quantity` + `defectDescription`
 * + `reportDate` (backend validira). `culpritWorkerIds` zamenjuje ceo M:N skup.
 */
export interface NonconformityReportInput {
  type?: NonconformityType;
  reportDate?: string;
  quantity?: number;
  defectDescription?: string;
  cause?: string | null;
  workUnit?: string | null;
  identNumber?: string | null;
  drawingNumber?: string | null;
  partName?: string | null;
  customerName?: string | null;
  culpritText?: string | null;
  materialCostNote?: string | null;
  coopCostNote?: string | null;
  spentHoursText?: string | null;
  note?: string | null;
  preventiveMeasures?: string | null;
  extra?: string | null;
  culpritWorkerIds?: number[];
}

/** Brojači draft-ova po tipu — bedž „na čekanju" na tabovima evidencija. */
export interface QualityMini {
  draftRework: number;
  draftScrap: number;
}

export interface NonconformityListParams {
  page?: number;
  /** Tab određuje tip (1 dorada / 2 škart) — uvek prosleđujemo. */
  type?: NonconformityType;
  /** '' = svi, '0' = samo nacrti, '1' = samo potvrđeni. */
  status?: '' | '0' | '1';
  /** ISO datum (yyyy-mm-dd) — period od/do po `reportDate`. */
  from?: string;
  to?: string;
  q?: string;
}

// ─────────────────────────────────────────────────────────────── hook-ovi

/** Invalidira ceo `kvalitet` namespace — sve mutacije osvežavaju liste + brojače. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['kvalitet'] });
}

/** Paginirana lista izveštaja (server-side filteri tip/status/period/pretraga). */
export function useNonconformityReports(params: NonconformityListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.type != null) qs.set('type', String(params.type));
  if (params.status) qs.set('status', params.status);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['kvalitet', 'reports', params],
    queryFn: () =>
      apiFetch<Paginated<NonconformityReport>>(
        `/v1/kvalitet/reports${query ? `?${query}` : ''}`,
      ),
  });
}

/** Jedan izveštaj sa svim poljima (učitava se po potrebi; lista već nosi pun oblik). */
export function useNonconformityReport(id: number | null) {
  return useQuery({
    queryKey: ['kvalitet', 'report', id],
    queryFn: () => apiFetch<{ data: NonconformityReport }>(`/v1/kvalitet/reports/${id}`),
    enabled: id != null,
  });
}

/** Novi izveštaj (ručni unos ili dopuna postojećeg draft-a). */
export function useCreateNonconformityReport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: NonconformityReportInput) =>
      apiFetch<{ data: NonconformityReport }>('/v1/kvalitet/reports', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Izmena poslovnih polja + izvršilaca (draft ili potvrđen). */
export function useUpdateNonconformityReport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: NonconformityReportInput }) =>
      apiFetch<{ data: NonconformityReport }>(`/v1/kvalitet/reports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: invalidate,
  });
}

/** Potvrda draft-a → server dodeljuje broj `NNN/YY` (vraća izveštaj sa brojem). */
export function useConfirmNonconformityReport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: NonconformityReport }>(`/v1/kvalitet/reports/${id}/confirm`, {
        method: 'POST',
      }),
    onSuccess: invalidate,
  });
}

/** Brisanje draft-a (lažna uzbuna) — backend dozvoljava samo status 0. */
export function useDeleteNonconformityReport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { id: number; deleted: boolean } }>(`/v1/kvalitet/reports/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

/** Brojači draft-ova po tipu (bedž na tabovima) — kratko keširano. */
export function useQualityMini() {
  return useQuery({
    queryKey: ['kvalitet', 'mini'],
    queryFn: () => apiFetch<{ data: QualityMini }>('/v1/kvalitet/summary-mini'),
    staleTime: 60_000,
  });
}

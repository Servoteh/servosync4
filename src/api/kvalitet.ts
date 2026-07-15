'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch, apiUpload } from './client';
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
  /**
   * Priloženi QC dokumenti (skenirani nalozi, kontrolna dokumentacija, fotke) —
   * nosi ih detalj izveštaja (report detalj). Opciono: lista izveštaja ne mora
   * da ih ugrađuje, sekcija „Dokumenti" u detalju ih dovlači i preko `useQualityDocs`.
   */
  documents?: QualityDoc[];
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

// ───────────────────────────────────────────────── izveštaji (agregati, tab K3)

/**
 * Osnova grupisanja agregata (§6 spec). Vremenske ose (dan/nedelja/mesec/godina)
 * i dimenzije (radnik / radna jedinica / uzrok / kupac). Izvor su NonconformityReport-i
 * (nose uzrok/sate/izvršioce), NE tech_processes agregat.
 */
export type QualityGroupBy =
  | 'day'
  | 'week'
  | 'month'
  | 'year'
  | 'worker'
  | 'workUnit'
  | 'cause'
  | 'customer';

/** Jedan red agregata — broj izveštaja, komada i suma sati po grupi. */
export interface QualitySummaryRow {
  /** Stabilan ključ grupe (period ISO / worker_id / naziv) — za React key. */
  key: string;
  /** Prikazni naziv grupe (npr. „Jul 2026", „CNC glodanje", ime radnika). */
  label: string;
  count: number;
  pieces: number;
  hours: number;
}

export interface QualitySummaryResponse {
  data: QualitySummaryRow[];
  meta: { draftCount: number };
}

export interface QualitySummaryParams {
  /** Svi tipovi kad je izostavljen; inače samo škart (2) ili dorada (1). */
  type?: NonconformityType;
  /** ISO datum (yyyy-mm-dd) — period od/do po `reportDate`. */
  from?: string;
  to?: string;
  groupBy: QualityGroupBy;
}

/** Agregati izveštaja o neusaglašenosti (tab „Izveštaji"). */
export function useQualitySummary(params: QualitySummaryParams) {
  const qs = new URLSearchParams();
  qs.set('groupBy', params.groupBy);
  if (params.type != null) qs.set('type', String(params.type));
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  return useQuery({
    queryKey: ['kvalitet', 'summary', params],
    queryFn: () => apiFetch<QualitySummaryResponse>(`/v1/kvalitet/summary?${qs.toString()}`),
  });
}

// ─────────────────────────────────────────────── dokumenti (upload, tab K4)

/**
 * QC dokument uskladišten U BAZI (PostgreSQL bytea, presedan `drawing_pdfs`) —
 * skenirani nalozi, kontrolna dokumentacija, fotke sa telefona. Nema share-a ni
 * mount-a (odluka 15.07): sve ide kroz upload iz aplikacije. Meki FK-ovi na
 * izveštaj / tech_process; slobodan `identNumber` (RN) uvek postoji.
 */
export interface QualityDoc {
  id: number;
  fileName: string;
  contentType: string;
  sizeKb: number;
  identNumber: string | null;
  reportId: number | null;
  techProcessId: number | null;
  createdAt: string;
  uploadedBy: string | null;
}

export interface QualityDocListParams {
  reportId?: number;
  techProcessId?: number;
  identNumber?: string;
  q?: string;
  /** ISO datum (yyyy-mm-dd) — period od/do po `createdAt`. */
  from?: string;
  to?: string;
  page?: number;
}

/** Telo za upload — jedan fajl po pozivu + opciono meko vezivanje. */
export interface UploadQualityDocInput {
  file: File;
  reportId?: number;
  techProcessId?: number;
  identNumber?: string;
}

/**
 * Paginirana lista QC dokumenata (filteri veza / pretraga / period). `enabled`
 * dozvoljava odloženo učitavanje (npr. sekcija u detalju izveštaja koja se veže
 * na `reportId` tek kad se red raširi).
 */
export function useQualityDocs(params: QualityDocListParams, opts: { enabled?: boolean } = {}) {
  const qs = new URLSearchParams();
  if (params.reportId != null) qs.set('reportId', String(params.reportId));
  if (params.techProcessId != null) qs.set('techProcessId', String(params.techProcessId));
  if (params.identNumber) qs.set('identNumber', params.identNumber);
  if (params.q) qs.set('q', params.q);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  const query = qs.toString();
  return useQuery({
    queryKey: ['kvalitet', 'docs', params],
    queryFn: () =>
      apiFetch<Paginated<QualityDoc>>(`/v1/kvalitet/docs${query ? `?${query}` : ''}`),
    enabled: opts.enabled ?? true,
  });
}

/**
 * Upload jednog QC dokumenta (multipart `file` + opciona veza). Kao PDM uvoz,
 * backend prima JEDAN fajl po pozivu — više fajlova pozivalac šalje sekvencijalno.
 */
export function useUploadQualityDoc() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: UploadQualityDocInput) => {
      const form = new FormData();
      form.append('file', input.file, input.file.name);
      if (input.reportId != null) form.append('reportId', String(input.reportId));
      if (input.techProcessId != null) form.append('techProcessId', String(input.techProcessId));
      if (input.identNumber) form.append('identNumber', input.identNumber);
      return apiUpload<{ data: { id: number; fileName: string; sizeKb: number } }>(
        '/v1/kvalitet/docs',
        form,
      );
    },
    onSuccess: invalidate,
  });
}

/** Brisanje QC dokumenta (KVALITET_WRITE) — invalidira ceo `kvalitet` namespace. */
export function useDeleteQualityDoc() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { id: number; deleted: boolean } }>(`/v1/kvalitet/docs/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Otvori uskladišten QC dokument u novom tabu (GET /kvalitet/docs/:id/content).
 * Endpoint traži JWT, pa se blob povlači kroz `apiBlob` (Authorization header) i
 * prikazuje preko `createObjectURL` (PDF u čitaču, slika u pregledaču).
 */
export async function openQualityDoc(id: number): Promise<void> {
  const blob = await apiBlob(`/v1/kvalitet/docs/${id}/content`);
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch, apiUpload } from './client';
import type { Paginated } from './tech-processes';
import type { Tone } from '@/components/ui-kit/status-badge';

/**
 * Neusaglašenosti na montaži — zaseban 2.0-native modul (zahtev 004/26).
 * Backend: /v1/montaza/neusaglasenosti (MODULE_SPEC_montaza_neusaglasenosti §3).
 * Prijavljuju svi sa pristupom Montaži; istragu/status vode menadžerske role
 * (montaza.neusaglasenosti.manage). Svaka prijava obaveštava menadžment (zvonce + mejl).
 *   GET  /v1/montaza/neusaglasenosti            · paginirana lista (status/severity/q/from/to)
 *   POST /v1/montaza/neusaglasenosti            · prijava
 *   GET  /v1/montaza/neusaglasenosti/:id        · detalj + fotke + timeline
 *   POST /v1/montaza/neusaglasenosti/:id/photos · upload fotki (multipart)
 *   PATCH /v1/montaza/neusaglasenosti/:id/istraga · polja istrage (manage)
 *   POST /v1/montaza/neusaglasenosti/:id/status   · prelaz statusa (manage)
 */

// ─────────────────────────────────────────────────────────────── konstante

export const NC_SEVERITIES = ['MALA', 'SREDNJA', 'VISOKA'] as const;
export type NcSeverity = (typeof NC_SEVERITIES)[number];

export const NC_LOCATION_KINDS = ['SERVOTEH', 'TEREN'] as const;
export type NcLocationKind = (typeof NC_LOCATION_KINDS)[number];

export const NC_STATUSES = ['CEKA_ANALIZU', 'U_TOKU', 'ZAVRSENO'] as const;
export type NcStatus = (typeof NC_STATUSES)[number];

/** Srpske labele (prikaz čipova/formi). */
export const NC_SEVERITY_LABEL: Record<NcSeverity, string> = {
  MALA: 'Mala',
  SREDNJA: 'Srednja',
  VISOKA: 'Visoka',
};
export const NC_LOCATION_LABEL: Record<NcLocationKind, string> = {
  SERVOTEH: 'Servoteh (hala)',
  TEREN: 'Teren',
};
export const NC_STATUS_LABEL: Record<NcStatus, string> = {
  CEKA_ANALIZU: 'Čeka analizu',
  U_TOKU: 'U toku',
  ZAVRSENO: 'Završeno',
};

/** Ton StatusBadge-a po statusu (DESIGN_SYSTEM §7): čeka=warn, u toku=info, završeno=success. */
export function ncStatusTone(s: NcStatus): Tone {
  return s === 'ZAVRSENO' ? 'success' : s === 'U_TOKU' ? 'info' : 'warn';
}

/** Ton čipa ozbiljnosti (DESIGN_SYSTEM §7): mala=info, srednja=warn, visoka=danger. */
export function ncSeverityTone(sev: NcSeverity): Tone {
  return sev === 'VISOKA' ? 'danger' : sev === 'SREDNJA' ? 'warn' : 'info';
}

// ─────────────────────────────────────────────────────────────── tipovi

export interface UserRef {
  id: number;
  fullName: string | null;
}
export interface WorkerRef {
  id: number;
  fullName: string | null;
}

export interface NcPhoto {
  id: number;
  fileName: string;
  contentType: string;
  createdAt: string;
  createdBy: { fullName: string | null } | null;
}

export interface NcEvent {
  id: number;
  type: string;
  data: Record<string, unknown> | null;
  createdAt: string;
  actorUserId: number | null;
  actorName: string | null;
}

/** Red liste / detalj neusaglašenosti. */
export interface Nonconformity {
  id: number;
  reportNumber: string;
  projectNumber: string | null;
  projectId: number | null;
  description: string;
  severity: NcSeverity;
  locationKind: NcLocationKind;
  locationNote: string | null;
  drawingNumber: string | null;
  workOrderCode: string | null;
  status: NcStatus;
  reportedByUserId: number;
  reportedBy: UserRef;
  responsibleDepartment: string | null;
  responsibleWorkerId: number | null;
  responsibleWorker: WorkerRef | null;
  investigationReport: string | null;
  preventiveMeasures: string | null;
  investigatedByUserId: number | null;
  investigatedBy: UserRef | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Samo u detalju:
  photos?: NcPhoto[];
  events?: NcEvent[];
}

/** Telo prijave (POST). */
export interface CreateNonconformityInput {
  projectNumber: string;
  projectId?: number | null;
  description: string;
  severity: NcSeverity;
  locationKind: NcLocationKind;
  locationNote?: string | null;
  drawingNumber?: string | null;
  workOrderCode?: string | null;
}

/** Telo istrage (PATCH). */
export interface InvestigationInput {
  responsibleDepartment?: string | null;
  responsibleWorkerId?: number | null;
  investigationReport?: string | null;
  preventiveMeasures?: string | null;
}

export interface NonconformityListParams {
  status?: NcStatus | '';
  severity?: NcSeverity | '';
  q?: string;
  from?: string;
  to?: string;
  page?: number;
}

// ─────────────────────────────────────────────────────────────── hook-ovi

/** Invalidira ceo `montaza-nc` namespace — sve mutacije osvežavaju liste + detalj. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['montaza-nc'] });
}

/** Paginirana lista (server-side filteri status/severity/period/pretraga). */
export function useNonconformities(params: NonconformityListParams) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.severity) qs.set('severity', params.severity);
  if (params.q) qs.set('q', params.q);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  const query = qs.toString();
  return useQuery({
    queryKey: ['montaza-nc', 'list', params],
    queryFn: () =>
      apiFetch<Paginated<Nonconformity>>(
        `/v1/montaza/neusaglasenosti${query ? `?${query}` : ''}`,
      ),
  });
}

/** Detalj jedne neusaglašenosti (fotke + timeline). */
export function useNonconformity(id: number | null) {
  return useQuery({
    queryKey: ['montaza-nc', 'detail', id],
    queryFn: () =>
      apiFetch<{ data: Nonconformity }>(`/v1/montaza/neusaglasenosti/${id}`),
    enabled: id != null,
  });
}

/** Prijava neusaglašenosti. */
export function useCreateNonconformity() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateNonconformityInput) =>
      apiFetch<{ data: Nonconformity }>('/v1/montaza/neusaglasenosti', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Upload fotki (multipart `files`, do 6 × 8 MB — backend validira magic bytes). */
export function useAddNonconformityPhotos() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, files }: { id: number; files: File[] }) => {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      return apiUpload<{ data: Array<{ id: number; fileName: string }> }>(
        `/v1/montaza/neusaglasenosti/${id}/photos`,
        form,
      );
    },
    onSuccess: invalidate,
  });
}

/** Izmena polja istrage (manage). */
export function useUpdateInvestigation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: InvestigationInput }) =>
      apiFetch<{ data: Nonconformity }>(
        `/v1/montaza/neusaglasenosti/${id}/istraga`,
        { method: 'PATCH', body: JSON.stringify(data) },
      ),
    onSuccess: invalidate,
  });
}

/** Prelaz statusa (manage). */
export function useChangeNonconformityStatus() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      status,
      note,
    }: {
      id: number;
      status: NcStatus;
      note?: string;
    }) =>
      apiFetch<{ data: Nonconformity }>(
        `/v1/montaza/neusaglasenosti/${id}/status`,
        { method: 'POST', body: JSON.stringify({ status, note }) },
      ),
    onSuccess: invalidate,
  });
}

/**
 * Otvori uskladištenu fotku u novom tabu (GET .../photos/:photoId). Endpoint traži JWT,
 * pa se blob povlači kroz `apiBlob` (Authorization header) i prikazuje preko createObjectURL.
 * Popup-blocker fix (obrazac reversi RowPdfButton): prazan tab se otvara SINHRONO u okviru
 * klika, pa mu se blob URL postavi tek posle await-a (inače browser blokira asinhroni open).
 */
export async function openNonconformityPhoto(id: number, photoId: number): Promise<void> {
  const win = window.open('about:blank', '_blank');
  if (win) win.opener = null;
  try {
    const blob = await apiBlob(`/v1/montaza/neusaglasenosti/${id}/photos/${photoId}`);
    const url = URL.createObjectURL(blob);
    if (win) win.location.href = url;
    else window.location.href = url; // popup blokiran → isti tab (fallback)
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    win?.close();
    throw e;
  }
}

/**
 * Dohvati blob fotke (za thumbnail/lightbox — object URL upravlja pozivalac). JWT ide
 * kroz `apiBlob`; ne može se `<img src>` direktno na endpoint (traži Authorization header).
 */
export function fetchNonconformityPhotoBlob(id: number, photoId: number): Promise<Blob> {
  return apiBlob(`/v1/montaza/neusaglasenosti/${id}/photos/${photoId}`);
}

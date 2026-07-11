'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface ProjectLookup {
  id: number;
  projectNumber: string;
  projectName: string | null;
  customerId: number;
  description: string | null;
  /**
   * Komitent predmeta (D9 prefill u „Novi RN"); null kad predmet nema komitenta
   * (customerId 0/orphan). Opciono jer lokalni konstruktori ProjectLookup-a
   * (npr. handover draft → predmet) ne nose komitenta.
   */
  customer?: { id: number; name: string } | null;
}

export interface CustomerLookup {
  id: number;
  name: string;
  city: string | null;
  taxId: string | null;
}

/** Predmeti za biranje iz liste (RN forma/filteri). */
export function useProjectsLookup(q: string) {
  return useQuery({
    queryKey: ['lookups', 'projects', q],
    queryFn: () =>
      apiFetch<{ data: ProjectLookup[] }>(
        `/v1/lookups/projects${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      ),
  });
}

/** Komitenti za biranje iz liste. */
export function useCustomersLookup(q: string) {
  return useQuery({
    queryKey: ['lookups', 'customers', q],
    queryFn: () =>
      apiFetch<{ data: CustomerLookup[] }>(
        `/v1/lookups/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      ),
  });
}

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

export interface WarehouseLookup {
  id: number;
  name: string;
  city: string | null;
  warehouseType: string | null;
}

/**
 * Magacini za biranje iz liste. Koriste ga i ekrani van robnog modula (KEP knjiga
 * u PDV-u, prenos između magacina), zato stoji u zajedničkim lookup-ovima —
 * šifarnik je mali pa nema paginacije ni pretrage sa odlaganjem.
 */
export function useWarehousesLookup() {
  return useQuery({
    queryKey: ['lookups', 'warehouses'],
    queryFn: () => apiFetch<{ data: WarehouseLookup[] }>('/v1/lookups/warehouses'),
    staleTime: 5 * 60_000,
  });
}

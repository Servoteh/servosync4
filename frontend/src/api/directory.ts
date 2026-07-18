'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated } from './tech-processes';

/**
 * Read-only pregled BigBit cache šifarnika (Komitenti + Predmeti).
 * Backend: src/modules/directory (BACKEND_RULES §3 — BigBit je vlasnik ovih tabela,
 * modul NEMA mutacija). Zato ovde postoje samo `useQuery` hook-ovi, bez mutacija.
 *   GET /v1/directory/customers      · lista (q: naziv/PIB/mesto)
 *   GET /v1/directory/customers/:id  · detalj
 *   GET /v1/directory/projects       · lista (q, customerId)
 *   GET /v1/directory/projects/:id   · detalj (+ broj RN-ova predmeta)
 */

/** Komercijalista (bezbedan podskup — backend nikad ne vraća lozinku/nalog). */
export interface SalespersonRef {
  id: number;
  name: string | null;
  firstName: string | null;
}

/** Sažeti komitent u listi predmeta. */
export interface CustomerRef {
  id: number;
  name: string | null;
  city: string | null;
}

/**
 * Komitent (BigBit cache `customers`) — poslovna polja. Backend NAMERNO izostavlja
 * finansijske kolone (računi, rabati, limiti…), tako da ih ni frontend ne poznaje.
 * Isti oblik vraćaju i lista i detalj (CUSTOMER_BUSINESS_SELECT).
 */
export interface Customer {
  id: number;
  name: string;
  shortName: string | null;
  branch: string | null;
  city: string | null;
  address: string | null;
  postalCode: string | null;
  country: string | null;
  taxId: string | null;
  registrationNumber: string | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  email: string | null;
  webAddress: string | null;
  contact: string | null;
  note: string | null;
  salespersonId: number | null;
  salesperson: SalespersonRef | null;
}

/** Predmet (BigBit cache `projects`) — polja liste. */
export interface Project {
  id: number;
  projectNumber: string;
  projectName: string | null;
  description: string | null;
  status: string | null;
  openedAt: string | null;
  closedAt: string | null;
  deadline: string | null;
  customerId: number;
  salespersonId: number | null;
  customer: CustomerRef | null;
  salesperson: SalespersonRef | null;
}

/** Detalj predmeta = polja liste + ugovor/porudžbenica/kontakti + broj RN-ova. */
export interface ProjectDetail extends Project {
  nextAction: string | null;
  memo: string | null;
  ourRef: string | null;
  ourContact1: string | null;
  ourContact2: string | null;
  ourPhone1: string | null;
  ourPhone2: string | null;
  theirRef: string | null;
  theirContact1: string | null;
  theirContact2: string | null;
  theirPhone1: string | null;
  theirPhone2: string | null;
  contractNumber: string | null;
  contractDate: string | null;
  orderNumber: string | null;
  orderDate: string | null;
  workUnitCode: string | null;
  workTypeId: number | null;
  createdAt: string | null;
  workOrdersCount: number;
}

export interface CustomerListParams {
  page?: number;
  q?: string;
}

export interface ProjectListParams {
  page?: number;
  q?: string;
  /** Filter po komitentu (id iz useCustomersLookup). */
  customerId?: number | '';
}

// -------------------------------------------------------------------- KOMITENTI

/** Paginirana lista komitenata (+ pretraga naziv/PIB/mesto). */
export function useCustomers(params: CustomerListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['directory', 'customers', params],
    queryFn: () =>
      apiFetch<Paginated<Customer>>(`/v1/directory/customers${query ? `?${query}` : ''}`),
  });
}

/** Jedan komitent (učitava se pri otvaranju reda). */
export function useCustomer(id: number | null) {
  return useQuery({
    queryKey: ['directory', 'customers', 'detail', id],
    queryFn: () => apiFetch<{ data: Customer }>(`/v1/directory/customers/${id}`),
    enabled: id != null,
  });
}

// --------------------------------------------------------------------- PREDMETI

/** Paginirana lista predmeta (+ pretraga i filter po komitentu). */
export function useProjects(params: ProjectListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  if (params.customerId !== '' && params.customerId != null)
    qs.set('customerId', String(params.customerId));
  const query = qs.toString();
  return useQuery({
    queryKey: ['directory', 'projects', params],
    queryFn: () =>
      apiFetch<Paginated<Project>>(`/v1/directory/projects${query ? `?${query}` : ''}`),
  });
}

/** Jedan predmet sa ugovorom/porudžbenicom/kontaktima + broj RN-ova. */
export function useProject(id: number | null) {
  return useQuery({
    queryKey: ['directory', 'projects', 'detail', id],
    queryFn: () => apiFetch<{ data: ProjectDetail }>(`/v1/directory/projects/${id}`),
    enabled: id != null,
  });
}

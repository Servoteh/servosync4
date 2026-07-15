'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { NonconformityStatus, NonconformityType } from './kvalitet';

/**
 * Moj profil → „Neusaglašenosti" (K3, MODULE_SPEC_kontrola_kvaliteta.md §6).
 * Radnik vidi SVOJE neusaglašenosti — izveštaje gde je među izvršiocima (M:N
 * `NonconformityWorker`); scope po worker_id iz JWT veze presuđuje SERVER, klijent
 * ne šalje id. Kad prijavljeni korisnik nema vezan `worker` red, backend vraća
 * `linked=false` (prazan prikaz — nema tuđih podataka). Read-only.
 *   GET /v1/kvalitet/mine → { data: { linked, reports[], monthly[] } }
 *
 * Zaseban fajl od `api/kvalitet.ts` (vlasnik drugi agent) — reuse-ujemo samo
 * njegove tip/status enumeracije radi doslednosti.
 */

/** Jedan izveštaj radnika — podskup `NonconformityReport` za Moj profil. */
export interface MyNonconformityReport {
  id: number;
  /** 1 = dorada, 2 = škart (PART_QUALITY). */
  type: NonconformityType;
  /** „028/26" — null dok je nacrt (broj se dodeljuje tek pri potvrdi). */
  reportNumber: string | null;
  reportDate: string;
  identNumber: string | null;
  drawingNumber: string | null;
  partName: string | null;
  quantity: number;
  defectDescription: string;
  status: NonconformityStatus;
}

/** Mesečni agregat po tipu — puni mini 6-mesečni pregled + stat kartice godine. */
export interface MyNonconformityMonth {
  /** „yyyy-MM". */
  month: string;
  type: NonconformityType;
  /** Broj izveštaja u mesecu (za tip). */
  count: number;
  /** Zbir komada (odbačeno/dorađeno) u mesecu (za tip). */
  pieces: number;
}

export interface MyNonconformities {
  /** Ima li prijavljeni korisnik vezan `worker` red (bez veze = prazan prikaz). */
  linked: boolean;
  reports: MyNonconformityReport[];
  monthly: MyNonconformityMonth[];
}

/**
 * Moje neusaglašenosti (škart + dorada). Scope se presuđuje server-side —
 * prazan/`linked:false` odgovor je normalno stanje, ne greška.
 */
export function useMyNonconformities() {
  return useQuery({
    queryKey: ['kvalitet', 'mine'],
    queryFn: () => apiFetch<{ data: MyNonconformities }>('/v1/kvalitet/mine'),
  });
}

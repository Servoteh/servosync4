'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * TALAS AI-5 — statistička procena vremena po radnom mestu (read-only).
 * Prikaz „slični poslovi na ovom RM: p25–p75 h/kom (n=…)" uz tehnološki postupak.
 * Bez izmene normativa — samo informacija (plan §2.2, human-in-the-loop).
 */

/** Procena po radnom mestu za jedan red operacije (h/kom, iz cele istorije RM). */
export interface RmProcena {
  /** Broj opservacija (nalog×radno mesto) u uzorku. */
  n: number;
  /** Kvantili h/kom (satni raspored je iskošen → interval, ne prosek). */
  p25: number | null;
  p50: number | null;
  p75: number | null;
  /** n < prag → uzorak mali, procena orijentaciona (označi u UI-ju). */
  malo_podataka: boolean;
}

/** Istorija baš ovog crteža na tom radnom mestu (sati PO NALOGU). */
export interface CrtezProcena {
  n_naloga: number;
  stvarno_h_p50: number | null;
  stvarno_h_min: number | null;
  stvarno_h_max: number | null;
}

export interface OperationEstimate {
  /** Redni broj operacije (poklapa se sa WorkOrderOperation.operationNumber). */
  rb: number;
  radno_mesto: string;
  naziv_radnog_mesta: string | null;
  opis: string | null;
  plan_h: number | null;
  rm_procena: RmProcena | null;
  crtez_procena: CrtezProcena | null;
}

export interface WorkOrderEstimate {
  nalog: {
    id: number;
    ident: string;
    varijanta: number;
    crtez: string | null;
    kolicina: number;
    naziv_dela: string | null;
  };
  crtez_istorija: { broj_naloga: number; drugi_nalozi: number } | null;
  jedinica: 'h';
  operacije: OperationEstimate[];
  napomena: string;
}

type EstimateResponse = WorkOrderEstimate | { greska: string; poruka: string };

function isEstimate(v: EstimateResponse): v is WorkOrderEstimate {
  return 'operacije' in v;
}

/**
 * Procena vremena za sve operacije jednog RN-a (plan + procena po RM + istorija
 * crteža), u jednom pozivu. Vraća mapu operationNumber → procena za tabelu TP-a.
 * Enabled samo kad je `id` poznat; greška/prazno → prazna mapa (panel se sakrije).
 */
export function useWorkOrderTimeEstimate(id: number | null) {
  return useQuery({
    queryKey: ['time-estimate', 'work-order', id],
    enabled: id != null,
    // Istorija se menja retko; ne troši pozive na svaki fokus.
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await apiFetch<{ data: EstimateResponse }>(
        `/v1/tehnologija/time-estimate/work-order/${id}`,
      );
      if (!isEstimate(res.data)) {
        return { byOp: new Map<number, OperationEstimate>(), drawing: null };
      }
      return {
        byOp: new Map(res.data.operacije.map((o) => [o.rb, o])),
        drawing: res.data.crtez_istorija,
      };
    },
  });
}

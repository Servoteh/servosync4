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
  /** Broj OPSERVACIJA (nalog×radno mesto) u uzorku. */
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

/** Jedan raniji nalog istog crteža — dokaz za drill-down (review [13]). */
export interface DrawingOrderRow {
  ident: string;
  varijanta: number;
  kolicina: number;
  naziv_dela: string | null;
  otvoren: string | null;
  predmet: string | null;
}

/** Sažetak istorije crteža uz nalog. `genericki` = „opšti" broj crteža. */
export interface CrtezIstorija {
  broj_naloga: number;
  /** Raniji nalozi istog crteža (0 = nov crtež, nema istorije — review [14]). */
  drugi_nalozi: number;
  genericki: boolean;
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
  crtez_istorija: CrtezIstorija | null;
  crtez_nalozi: DrawingOrderRow[];
  jedinica: 'h';
  operacije: OperationEstimate[];
  napomena: string;
}

type EstimateResponse = WorkOrderEstimate | { greska: string; poruka: string };

function isEstimate(v: EstimateResponse): v is WorkOrderEstimate {
  return 'operacije' in v;
}

export interface WorkOrderEstimateView {
  byOp: Map<number, OperationEstimate>;
  drawing: CrtezIstorija | null;
  nalozi: DrawingOrderRow[];
}

const EMPTY: WorkOrderEstimateView = { byOp: new Map(), drawing: null, nalozi: [] };

/**
 * Procena vremena za sve operacije jednog RN-a (plan + procena po RM + istorija
 * crteža), u jednom pozivu. Vraća mapu operationNumber → procena, sažetak istorije
 * crteža i listu ranijih naloga (dokazi). Greška/prazno → prazan pogled (panel se
 * sakrije). `staleTime` kratak jer izmena operacije/količine menja procenu.
 */
export function useWorkOrderTimeEstimate(id: number | null) {
  return useQuery({
    queryKey: ['time-estimate', 'work-order', id],
    enabled: id != null,
    staleTime: 60_000,
    queryFn: async (): Promise<WorkOrderEstimateView> => {
      const res = await apiFetch<{ data: EstimateResponse }>(
        `/v1/tehnologija/time-estimate/work-order/${id}`,
      );
      if (!isEstimate(res.data)) return EMPTY;
      return {
        byOp: new Map(res.data.operacije.map((o) => [o.rb, o])),
        drawing: res.data.crtez_istorija,
        nalozi: res.data.crtez_nalozi,
      };
    },
  });
}

'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * TALAS AI-6 — predlog tehnološkog postupka iz istorije crteža (read-only).
 * Kad je crtež naloga VEĆ RAĐEN, backend sklopi reprezentativan ruting iz prošlih
 * naloga (operacije + plan Tpz/Tk + stvarna procena po RM) kao PREDLOG. Ništa se
 * ne upisuje automatski (plan §2.2). Vidi backend `technology-suggest.service.ts`.
 */

/** Stvarna procena po radnom mestu (h/kom, cela istorija) — AI-5 kvantili. */
export interface SuggestRmProcena {
  n: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  malo_podataka: boolean;
}

/** Stvarni sati PO NALOGU baš ovog crteža na tom RM. */
export interface SuggestCrtezProcena {
  n_naloga: number;
  stvarno_h_p50: number | null;
  stvarno_h_min: number | null;
}

export interface SuggestedOperation {
  rb: number;
  radno_mesto: string;
  naziv_radnog_mesta: string | null;
  opis: string | null;
  plan_tpz: number | null;
  plan_tk: number | null;
  rm_procena: SuggestRmProcena | null;
  crtez_procena: SuggestCrtezProcena | null;
}

export interface RutingVarijanta {
  broj_naloga: number;
  operacija: number;
  radna_mesta: string[];
  najskoriji_ident: string;
  najskoriji_otvoren: string | null;
  izabran: boolean;
  /** RN te varijante koji „Prepiši ovu" kopira (produced-preferred). */
  kopiraj_id: number;
  kopiraj_ident: string;
}

export interface TechnologySuggestion {
  ima_istoriju: true;
  crtez: string;
  osnov_naloga: number;
  ukupno_naloga: number;
  konzistentno: boolean;
  broj_varijanti: number;
  varijante: RutingVarijanta[];
  reprezentativan_nalog: {
    id: number;
    ident: string;
    varijanta: number;
    kolicina: number;
    otvoren: string | null;
    proizveden: boolean;
  };
  operacije: SuggestedOperation[];
  poslednji_nalozi: {
    ident: string;
    varijanta: number;
    kolicina: number;
    naziv_dela: string | null;
    otvoren: string | null;
    predmet: string | null;
  }[];
  napomena: string;
}

export interface NemaTehnologije {
  ima_istoriju: false;
  crtez: string;
  genericki: boolean;
  ukupno_naloga: number;
  poruka: string;
}

type SuggestResponse =
  | TechnologySuggestion
  | NemaTehnologije
  | { greska: string; poruka: string };

export function isSuggestion(v: SuggestResponse): v is TechnologySuggestion {
  return 'ima_istoriju' in v && v.ima_istoriju === true;
}

export function isNoHistory(v: SuggestResponse): v is NemaTehnologije {
  return 'ima_istoriju' in v && v.ima_istoriju === false;
}

/**
 * Predlog tehnologije za crtež (izuzima tekući RN iz osnove). `enabled` gejt:
 * bez crteža se ne poziva, a pozivalac ga dodatno gasi kad panel nije relevantan
 * (review [12] — teška agregacija se ne pali dok je ruting popunjen/panel skupljen).
 * `staleTime` duži — istorija se sporo menja.
 */
export function useDrawingTechnologySuggestion(
  crtez: string | null | undefined,
  excludeWorkOrderId: number | null,
  enabled = true,
) {
  const q = (crtez ?? '').trim();
  return useQuery({
    queryKey: ['technology-suggest', 'drawing', q, excludeWorkOrderId],
    enabled: enabled && q.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<SuggestResponse> => {
      const params = new URLSearchParams({ crtez: q });
      if (excludeWorkOrderId != null) params.set('osim', String(excludeWorkOrderId));
      const res = await apiFetch<{ data: SuggestResponse }>(
        `/v1/tehnologija/suggest/drawing?${params.toString()}`,
      );
      return res.data;
    },
  });
}

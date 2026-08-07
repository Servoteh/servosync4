'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Popis / inventura -- data sloj (Talas E2). TanStack Query hooks nad NestJS
 * `/api/v1/robno/inventory-counts/*`. Tipovi 1:1 sa backend ugovorom (E2-BE) i
 * Prisma modelima InventoryCount / InventoryCountItem.
 *
 * Komponente NE zovu API direktno -- samo kroz ove hook-ove (frontend/CLAUDE.md 8).
 *
 * Envelope: sve rute vracaju `{ data }` (ne-paginirano). Decimal polja stizu kao
 * string (BACKEND_RULES 6) -- formatDecimal na prikazu, Number() za input.
 */

const BASE = '/v1/robno/inventory-counts';

// -------------------------------------------------------------- status

/**
 * Status popisa (`inventory_counts.status`) -- 1:1 sa backend servisom.
 * DRAFT (kreiran) -> COUNTING (popisivanje: unos popisanih kolicina) ->
 * POSTED (zakljucen: kreirani VISAK/MANJAK robni dokumenti). Ulazi u kanonsku
 * mapu statusa (DESIGN_SYSTEM 7) kao POPIS domen.
 */
export const POPIS_STATUS = {
  DRAFT: 'DRAFT',
  COUNTING: 'COUNTING',
  POSTED: 'POSTED',
} as const;

export type PopisStatus = (typeof POPIS_STATUS)[keyof typeof POPIS_STATUS];

// -------------------------------------------------------------- envelope tipovi

/** Ne-paginirani odgovor domenskog endpointa (`{ data }`). */
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Red master liste popisa -- GET /inventory-counts (zaglavlje bez stavki). */
export interface InventoryCountRow {
  id: number;
  countNumber: string;
  year: number;
  countDate: string;
  warehouseId: number;
  status: PopisStatus;
  /** Broj stavki popisa (opciono -- backend moze izostaviti). */
  itemCount?: number;
}

/**
 * Stavka popisa (`inventory_count_items`). Decimal polja kao string
 * (BACKEND_RULES 6): bookQuantity (knjigovodstveno, predpunjeno), countedQuantity
 * (popisano, unosi korisnik), price (cena za vrednovanje razlike).
 */
export interface InventoryCountItem {
  id: number;
  itemId: number;
  itemName?: string | null;
  itemCode?: string | null;
  bookQuantity: string;
  countedQuantity: string;
  price: string;
}

/**
 * Detalj popisa -- zaglavlje + stavke + id-evi dokumenata razlike (GET /:id).
 *
 * `visakDocId`/`manjakDocId` su isti podatak koji vraca i `finalize`, samo iz BAZE
 * (`stock_documents.inventory_count_id`) umesto iz odgovora jedne mutacije. Bez njih je
 * panel drzao id-eve u `useState`, pa je povratak sa dokumenta viska (remount strane)
 * brisao dugme za manjak -- popis sa oba dokumenta ostavljao je korisnika bez puta do
 * drugog. `null` = ta vrsta razlike nije ni postojala (ili popis jos nije zakljucen).
 */
export interface InventoryCountDetail extends InventoryCountRow {
  note?: string | null;
  items: InventoryCountItem[];
  visakDocId?: number | null;
  manjakDocId?: number | null;
}

/**
 * Jedna stavka razlike -- 1:1 sa backend oblikom (`differences.items[]`). Vrednosti
 * su Decimal-as-string (server racuna). Naziv/sifra/JM su meki ref na `items`.
 */
export interface DifferenceItem {
  itemId: number;
  /** Naziv artikla (meki ref items.name). */
  naziv: string | null;
  /** Sifra / kataloski broj artikla. */
  itemCode: string | null;
  /** Jedinica mere. */
  unit: string | null;
  /** Knjigovodstvena kolicina. */
  book: string;
  /** Popisana kolicina. */
  counted: string;
  /** counted - book (pozitivno = visak, negativno = manjak). */
  diff: string;
  price: string;
  /** diff * price. */
  diffValue: string;
}

/**
 * Rezultat razlika popisa (GET /:id/differences) -- 1:1 sa backend oblikom
 * `{ countId, status, items, summary }`. `items` su SVE stavke popisa (i one bez
 * razlike); `summary` nosi vrednosne zbirove i broj stavki sa viskom/manjkom.
 */
export interface DifferencesResult {
  countId: number;
  status: PopisStatus;
  items: DifferenceItem[];
  summary: {
    /** Zbir pozitivnih vrednosnih razlika (visak). */
    surplusValue: string;
    /** Zbir (negativnih) vrednosnih razlika (manjak). */
    shortageValue: string;
    /** Broj stavki sa viskom (diff > 0). */
    surplusCount: number;
    /** Broj stavki sa manjkom (diff < 0). */
    shortageCount: number;
  };
}

/**
 * Rezultat zakljucivanja -- id-evi kreiranih robnih dokumenata (POST /:id/finalize).
 *
 * `countId` je deo backend odgovora od pocetka, a FE ga deklarise zato sto panel drzi
 * ovaj odgovor u `useState`: bez provere kome pripada, prvi render posle klika na DRUGI
 * popis jos nosi stari `result` i ponudi dugme ka dokumentu TUDJEG popisa.
 */
export interface FinalizeResult {
  countId?: number;
  visakDocId?: number | null;
  manjakDocId?: number | null;
}

/** Telo POST /inventory-counts -- zaglavlje popisa. */
export interface CreateInventoryCountInput {
  warehouseId: number;
  countDate: string;
  note?: string;
}

// -------------------------------------------------------------- query keys

const KEYS = {
  all: ['inventory'] as const,
  list: ['inventory', 'counts'] as const,
  detail: (id: number) => ['inventory', 'counts', id] as const,
  differences: (id: number) => ['inventory', 'counts', id, 'differences'] as const,
};

// -------------------------------------------------------------- queries

/** Master lista popisa (GET /inventory-counts). Vraca `{ data: InventoryCountRow[] }`. */
export function useInventoryCounts() {
  return useQuery({
    queryKey: KEYS.list,
    queryFn: () => apiFetch<Envelope<InventoryCountRow[]>>(BASE),
  });
}

/**
 * Detalj jednog popisa (zaglavlje + stavke) -- GET /inventory-counts/:id.
 * `enabled` gasi upit dok id nije poznat (selekcija u master listi).
 */
export function useInventoryCount(id: number | null) {
  return useQuery({
    queryKey: id != null ? KEYS.detail(id) : [...KEYS.list, 'detail', null],
    queryFn: () => apiFetch<Envelope<InventoryCountDetail>>(`${BASE}/${id}`),
    enabled: id != null,
  });
}

/**
 * Razlike popisa (book vs counted, vrednosne razlike, zbirovi visak/manjak) --
 * GET /inventory-counts/:id/differences. `enabled` gate na id + eksplicitni flag
 * (racuna se lenjo, tek kad korisnik otvori tab Razlike).
 */
export function useInventoryDifferences(id: number | null, enabled = true) {
  return useQuery({
    queryKey: id != null ? KEYS.differences(id) : [...KEYS.list, 'differences', null],
    queryFn: () => apiFetch<Envelope<DifferencesResult>>(`${BASE}/${id}/differences`),
    enabled: id != null && enabled,
  });
}

// -------------------------------------------------------------- mutations

/** Kreiraj popis (POST /inventory-counts) -- status DRAFT/COUNTING (backend presudi). */
export function useCreateInventoryCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInventoryCountInput) =>
      apiFetch<Envelope<InventoryCountDetail>>(BASE, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.list }),
  });
}

/**
 * Izmena popisane kolicine jedne stavke (PATCH /inventory-counts/:id/items/:itemId).
 * Dozvoljeno samo u statusu COUNTING (backend guard). Menja stavku + izvedene
 * razlike, pa invalidira detalj i razlike tog popisa.
 */
export function useUpdateCountItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { countId: number; itemId: number; countedQuantity: number }) =>
      apiFetch<Envelope<InventoryCountItem>>(
        `${BASE}/${vars.countId}/items/${vars.itemId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ countedQuantity: vars.countedQuantity }),
        },
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: KEYS.detail(vars.countId) });
      qc.invalidateQueries({ queryKey: KEYS.differences(vars.countId) });
    },
  });
}

/**
 * Zakljuci popis (POST /inventory-counts/:id/finalize) -- COUNTING -> POSTED.
 * Kreira VISAK/MANJAK robne dokumente iz razlika i vraca njihove id-eve. Menja
 * status popisa + robno stanje, pa invalidira ceo `inventory` i `robno` kljuc.
 */
export function useFinalizeInventoryCount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Envelope<FinalizeResult>>(`${BASE}/${id}/finalize`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.all });
      qc.invalidateQueries({ queryKey: ['robno'] });
    },
  });
}

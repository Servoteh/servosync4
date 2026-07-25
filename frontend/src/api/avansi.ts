'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * AVANSI — data sloj (Batch C1b). TanStack Query hooks nad NestJS avansnim rutama.
 * Avansni račun je `Invoice` sa `documentType = 'AVR'` i smerom (`advanceDirection`):
 *   'out' = IZDAT kupcu     → KIF; PDV obaveza nastaje NAPLATOM (modul prodaje)
 *   'in'  = PRIMLJEN od dobavljača → KUF; pretporez nastaje PLAĆANJEM (modul PDV)
 *
 * Zato su rute razdvojene po smeru, a hook-ovi ovde biraju putanju po `direction`:
 *   GET  /v1/pdv/advances                              — lista avansa (OBA smera)
 *   POST /v1/sales/advance-invoices                     — napravi AVR iz predračuna (out)
 *   POST /v1/sales/advance-invoices/:id/paid            — označi naplatu izdatog avansa
 *   POST /v1/sales/invoices/:id/apply-advance           — odbij avans na konačnom računu
 *   POST /v1/pdv/advances/incoming                      — evidentiraj ulazni avans (in)
 *   POST /v1/pdv/advances/incoming/:id/mark-paid        — plaćanje ulaznog avansa → pretporez
 *   POST /v1/pdv/advances/incoming/:id/link-final       — veži ulazni avans na konačni račun
 *
 * ENVELOPE: lista vraća `{ data, meta: { total, page, pageSize } }`; mutacije `{ data }`.
 * Decimal polja stižu kao STRING (BACKEND_RULES §6) — `formatDecimal` na prikazu.
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 */

const PDV_BASE = '/v1/pdv/advances';
const SALES_BASE = '/v1/sales/advance-invoices';
// Odbijanje avansa ide na KONAČNI račun (id u putanji je id računa, ne avansa).
const SALES_INVOICES_BASE = '/v1/sales/invoices';

// ─────────────────────────────────────────────────────────────── smer + tipovi

/** Smer avansa (`Invoice.advanceDirection`). */
export const ADVANCE_DIRECTION = {
  /** Izdat kupcu — izlazni avans (KIF). */
  OUT: 'out',
  /** Primljen od dobavljača — ulazni avans (KUF, pretporez po plaćanju). */
  IN: 'in',
} as const;

export type AdvanceDirection = (typeof ADVANCE_DIRECTION)[keyof typeof ADVANCE_DIRECTION];

/** Srpska labela smera (UI). */
export const ADVANCE_DIRECTION_LABEL: Record<string, string> = {
  [ADVANCE_DIRECTION.OUT]: 'Izdat',
  [ADVANCE_DIRECTION.IN]: 'Primljen',
};

/** Ne-paginirani odgovor (`{ data }`). */
export interface Envelope<T> {
  data: T;
}

/** Paginirani odgovor liste avansa. */
export interface AdvanceListResponse {
  data: Advance[];
  meta: { total: number; page: number; pageSize: number };
}

/**
 * Red liste avansa — 1:1 sa backend `AdvanceRow` (advance-vat.service.ts).
 * Decimal polja su STRING; datumi ISO string.
 */
export interface Advance {
  id: number;
  documentNumber: string;
  documentDate: string;
  /** 'out' = izdat kupcu, 'in' = primljen od dobavljača; null za stare AVR bez smera. */
  direction: AdvanceDirection | string | null;
  /** Komitent (kupac ili dobavljač) — meki ref šifarnika komitenata. */
  partnerId: number | null;
  partnerName: string | null;
  currency: string;
  netTotal: string;
  vatTotal: string;
  grossTotal: string;
  /** Datum naplate/plaćanja (null = još nenaplaćen → nema poreskog efekta). */
  paidAt: string | null;
  paidAmount: string;
  status: string;
  /** Konačni račun na koji je avans već vezan (null = slobodan za vezivanje). */
  linkedFinalInvoiceId: number | null;
  linkedFinalDocumentNumber: string | null;
  note: string | null;
}

/**
 * Avansna polja koja `Invoice` nosi na KONAČNOM računu (`advance_*` kolone). Drže se
 * ovde jer je `@/api/sales` tip `Invoice` van granica ovog paketa — kad se avansi
 * spoje sa prodajom, ova polja treba preseliti u `sales.ts` i ovaj tip ukloniti.
 * Decimal polja stižu kao STRING.
 */
export interface InvoiceAdvanceFields {
  /** AVR čiji se avans odbija na ovom računu (null = nema vezanog avansa). */
  advanceInvoiceId?: number | null;
  /** Bruto iznos avansa odbijen na ovom računu (umanjuje iznos ZA UPLATU). */
  advanceAppliedAmount?: string | null;
  /**
   * Za uplatu = grossTotal − advanceAppliedAmount, izračunato Decimal-om NA
   * BACKEND-u. Prikaz uzima ovo polje, ne sopstveni Float račun.
   */
  payableAmount?: string | null;
  /** Broj vezanog avansnog računa (za prikaz „Umanjenje za avans br. …"). */
  advanceInvoiceNumber?: string | null;
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['avansi'] as const,
  list: ['avansi', 'list'] as const,
};

// ─────────────────────────────────────────────────────────────── filteri

export interface AdvanceFilters {
  /** 'out' | 'in'; prazno = oba smera. */
  direction?: AdvanceDirection | '';
  /** Komitent (kupac/dobavljač). */
  partnerId?: number | '';
  /** true = samo avansi bez upisane naplate. */
  unpaidOnly?: boolean;
  /** 1-bazna strana (server-side paginacija). */
  page?: number;
  /** Veličina strane (backend default 50, max 200). */
  pageSize?: number;
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || value === false) continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

// ─────────────────────────────────────────────────────────────── queries

/**
 * Lista avansa za OBA smera (GET /pdv/advances) sa server-side paginacijom.
 * Filteri: smer, komitent, „samo nenaplaćeni". Permisija PDV_READ.
 */
export function useAdvances(filters: AdvanceFilters = {}) {
  const query = buildQuery({
    direction: filters.direction === '' ? undefined : filters.direction,
    partnerId: filters.partnerId === '' ? undefined : filters.partnerId,
    unpaidOnly: filters.unpaidOnly === true ? true : undefined,
    page: filters.page && filters.page > 1 ? filters.page : undefined,
    pageSize: filters.pageSize,
  });
  return useQuery({
    queryKey: [...KEYS.list, filters],
    queryFn: () => apiFetch<AdvanceListResponse>(`${PDV_BASE}${query}`),
  });
}

// ─────────────────────────────────────────────────────────────── mutations

/**
 * Avansi menjaju i fakture (`Invoice`) i poresku evidenciju (KIF/KUF) — posle svake
 * mutacije se osvežava i `sales` i `pdv` keš, ne samo lista avansa.
 */
function useInvalidateAdvances() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: KEYS.all });
    void qc.invalidateQueries({ queryKey: ['sales'] });
    void qc.invalidateQueries({ queryKey: ['pdv'] });
  };
}

/** Telo POST /sales/advances/from-proforma — avansni račun iz predračuna (izlazni smer). */
export interface CreateAdvanceFromProformaInput {
  /** `Invoice.id` predračuna/ponude (PON/PROF) iz kog se pravi avans. */
  proformaId: number;
  /** Bruto iznos avansa; bez njega backend uzima ceo iznos predračuna. */
  amount?: number;
  /** Datum avansnog računa (ISO); bez njega danas. */
  documentDate?: string;
  note?: string;
}

/**
 * Napravi AVANSNI RAČUN iz predračuna (izlazni smer, KIF) — POST
 * /sales/advances/from-proforma. Vraća novi AVR. PDV obaveza po avansu nastaje
 * tek naplatom (`useMarkAdvancePaid`). Permisija SALES_WRITE.
 */
export function useCreateAdvanceFromProforma() {
  const invalidate = useInvalidateAdvances();
  return useMutation({
    mutationFn: (input: CreateAdvanceFromProformaInput) =>
      apiFetch<Envelope<Advance>>(`${SALES_BASE}`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Telo evidencije ULAZNOG avansnog računa dobavljača (POST /pdv/advances/incoming). */
export interface RecordIncomingAdvanceInput {
  /** Dobavljač — šifra komitenta. */
  partnerId: number;
  /** Broj avansnog računa dobavljača (max 30 znakova). */
  documentNumber: string;
  /** Datum dokumenta (ISO). */
  documentDate: string;
  /** Bruto iznos avansa (osnovica + PDV). */
  grossAmount: number;
  /** Šifra poreske stope (meki ref registra tarifa). */
  vatRateCode: string;
  /** Ako je avans već plaćen pri unosu — datum plaćanja (ISO). */
  paidAt?: string;
  note?: string;
}

/** Rezultat evidencije ulaznog avansa — `vatLedgerEntryId` null dok nije plaćen. */
export interface RecordIncomingAdvanceResult {
  id: number;
  documentNumber: string;
  netTotal: string;
  vatTotal: string;
  grossTotal: string;
  paidAt: string | null;
  vatLedgerEntryId: number | null;
}

/**
 * Evidentiraj ULAZNI avansni račun dobavljača — POST /pdv/advances/incoming.
 * PRETPOREZ SE NE PRIZNAJE dok avans nije plaćen: bez `paidAt` dokument samo stoji
 * evidentiran, KUF stavka ne postoji. Permisija PDV_COMPUTE.
 */
export function useRecordIncomingAdvance() {
  const invalidate = useInvalidateAdvances();
  return useMutation({
    mutationFn: (input: RecordIncomingAdvanceInput) =>
      apiFetch<Envelope<RecordIncomingAdvanceResult>>(`${PDV_BASE}/incoming`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Telo označavanja naplate/plaćanja avansa (oba smera). */
export interface MarkAdvancePaidInput {
  id: number;
  /** Smer bira rutu: 'in' → PDV (pretporez), 'out' → prodaja (PDV obaveza). */
  direction: AdvanceDirection | string | null;
  /** Datum naplate (ISO) — određuje PORESKI PERIOD stavke. */
  paidAt: string;
  /** Naplaćen bruto iznos (može biti delimičan). */
  amount: number;
}

/** Rezultat označavanja naplate — poreski period je po datumu naplate. */
/**
 * Rezultat naplate. Dva smera vraćaju RAZLIČITA polja, pa je sve osim `id`
 * opciono — ulazni smer daje poreski period KUF stavke, izlazni daje id naloga
 * glavne knjige. Bez `?` je prikaz pisao „u periodu undefined/undefined".
 */
export interface MarkAdvancePaidResult {
  id: number;
  paidAt?: string;
  paidAmount?: string;
  /** Ulazni smer (KUF stavka). */
  taxPeriodYear?: number;
  taxPeriodMonth?: number;
  vatBase?: string;
  vatAmount?: string;
  vatLedgerEntryId?: number;
  /** Izlazni smer (nalog GK po naplati avansa). */
  journalEntryId?: number;
  journalEntryNumber?: string;
}

/**
 * Označi naplatu avansa — tek tada nastaje poreski efekat (izlazni: obaveza po KIF-u;
 * ulazni: pretporez po KUF-u), i to u periodu po DATUMU NAPLATE, ne po datumu
 * dokumenta. Dvostruko označavanje backend odbija sa 409 (CAS). Ruta zavisi od
 * smera. Permisija: SALES_POST (izlazni) / PDV_COMPUTE (ulazni).
 */
export function useMarkAdvancePaid() {
  const invalidate = useInvalidateAdvances();
  return useMutation({
    mutationFn: ({ id, direction, paidAt, amount }: MarkAdvancePaidInput) => {
      const url =
        direction === ADVANCE_DIRECTION.IN
          ? `${PDV_BASE}/incoming/${id}/mark-paid`
          : `${SALES_BASE}/${id}/paid`;
      return apiFetch<Envelope<MarkAdvancePaidResult>>(url, {
        method: 'POST',
        body: JSON.stringify({ paidAt, amount }),
      });
    },
    onSuccess: invalidate,
  });
}

/** Telo vezivanja avansa na konačni račun (oba smera). */
export interface LinkAdvanceToFinalInput {
  advanceId: number;
  /** Smer bira rutu: 'in' → PDV, 'out' → prodaja. */
  direction: AdvanceDirection | string | null;
  /** `Invoice.id` konačnog računa na koji se avans odbija. */
  finalInvoiceId: number;
}

/** Rezultat vezivanja — `reversalEntryId` je storno stavka avansnog PDV-a. */
/**
 * Rezultat odbijanja avansa. Izlazni smer vraća ceo konačni račun sa
 * `payableAmount` i brojem naloga zatvaranja; ulazni smer (kad se otvori) vraća
 * `appliedAmount`/`reversalEntryId`. Sve opciono — v. `MarkAdvancePaidResult`.
 */
export interface LinkAdvanceToFinalResult {
  advanceId?: number;
  finalInvoiceId?: number;
  appliedAmount?: string;
  reversalEntryId?: number | null;
  /** Izlazni smer. */
  advanceInvoiceNumber?: string;
  advanceAppliedAmount?: string;
  payableAmount?: string;
  advanceClosingEntryNumber?: string;
}

/**
 * Veži avans na KONAČNI račun — konačni račun dobija „Umanjenje za primljeni avans"
 * (`advanceAppliedAmount`), a PDV avansa se STORNIRA suprotnom poreskom stavkom da
 * se isti porez ne prizna dvaput. Avans se sme iskoristiti samo jednom (409).
 * Permisija: SALES_POST (izlazni) / PDV_COMPUTE (ulazni).
 */
export function useLinkAdvanceToFinal() {
  const invalidate = useInvalidateAdvances();
  return useMutation({
    mutationFn: ({ advanceId, direction, finalInvoiceId }: LinkAdvanceToFinalInput) => {
      const url =
        direction === ADVANCE_DIRECTION.IN
          ? `${PDV_BASE}/incoming/${advanceId}/link-final`
          : `${SALES_INVOICES_BASE}/${finalInvoiceId}/apply-advance`;
      // Izlazni smer: id u putanji je KONAČNI račun, a avans ide u telu — obrnuto
      // od ulaznog smera, gde ruta visi na avansu.
      const body =
        direction === ADVANCE_DIRECTION.IN
          ? { finalInvoiceId }
          : { advanceInvoiceId: advanceId };
      return apiFetch<Envelope<LinkAdvanceToFinalResult>>(url, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: invalidate,
  });
}

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';

/**
 * PDV / POPDV — data sloj (Faza 6). TanStack Query hooks nad NestJS
 * `/api/v1/pdv/*`. Tipovi 1:1 sa backend servisima:
 *   backend/src/modules/pdv/pdv.controller.ts     (rute + envelope)
 *   backend/src/modules/pdv/vat-ledger.service.ts (KIF/KUF red, build rezultat)
 *   backend/src/modules/pdv/popdv.service.ts      (POPDV obračun + linije, VatReturn)
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 *
 * VAŽNO (envelope): PDV endpointi vraćaju `{ data, meta: { count } }` (lista) ili
 * `{ data }` (build/compute). Decimal polja stižu kao string (BACKEND_RULES §6) —
 * formatDecimal na prikazu. Permisije: read = PDV_READ; build/obračun = PDV_COMPUTE.
 */

const BASE = '/v1/pdv';

// ─────────────────────────────────────────────────────────────── envelope tipovi

/** Ne-paginirani odgovor domenskog endpointa (`{ data }` ili `{ data, meta }`). */
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Lista sa brojačem (`{ data, meta: { count } }`) — KIF/KUF/returns. */
export interface CountEnvelope<T> {
  data: T[];
  meta: { count: number };
}

// ─────────────────────────────────────────────────────────────── period

/** Poreski period — godina + mesec (mesečni obveznik; KIF/KUF su uvek mesečni). */
export interface VatPeriod {
  year: number;
  month: number;
}

// ─────────────────────────────────────────────────────────────── tipovi (BE 1:1)

/**
 * Jedan red KIF/KUF evidencije (`vat_ledger_entries`) — VatLedgerService.VatLedgerRow.
 * Decimal polja (`vatBase`, `vatAmount`) kao string (BACKEND_RULES §6). `direction`:
 * `output` = KIF (izlazne), `input` = KUF (ulazne).
 */
export interface VatLedgerRow {
  id: number;
  direction: string;
  documentNumber: string;
  partnerId: number | null;
  documentDate: string;
  taxPeriodYear: number;
  taxPeriodMonth: number;
  vatBase: string;
  vatAmount: string;
  vatRateCode: string | null;
  sourceJournalEntryId: number | null;
}

/** Rezultat punjenja KIF/KUF za period — VatLedgerService.BuildKifKufResult. */
export interface BuildKifKufResult {
  year: number;
  month: number;
  kifCount: number;
  kufCount: number;
  outputVat: string;
  inputVat: string;
}

/** Jedna AOP linija PDV obračuna (`vat_return_lines`) — amount Decimal-as-string. */
export interface VatReturnLine {
  id: number;
  vatReturnId: number;
  aop: string;
  amount: string;
}

/**
 * PDV obračun (`vat_returns`) — PopdvService rezultat / listReturns. Iznosi
 * (`outputVat`/`inputVat`/`vatLiability`) Decimal-as-string. `periodMonth` XOR
 * `periodQuarter` (mesečni ili kvartalni obveznik). `lines` popunjeno na listi.
 */
export interface VatReturn {
  id: number;
  periodYear: number;
  periodMonth: number | null;
  periodQuarter: number | null;
  status: string;
  outputVat: string;
  inputVat: string;
  vatLiability: string;
  lines?: VatReturnLine[];
}

/** Rezultat `POST /popdv/compute` — PopdvService.PopdvResult (sažetak + note). */
export interface PopdvResult {
  vatReturnId: number;
  periodYear: number;
  periodMonth: number | null;
  periodQuarter: number | null;
  outputVat: string;
  inputVat: string;
  vatLiability: string;
  lineCount: number;
  seededDefinition: boolean;
  note: string;
}

/**
 * KEPU red (`kepu_book_entries`) — veleprodajna knjiga evidencije prometa.
 * Punjenje iz robnog toka radi robno modul (#25); FE ovde samo prikazuje red:
 * rbr, datum, dokument, opis, zaduženje (charge), razduženje (discharge), saldo
 * (kumulativni). Decimal polja kao string (BACKEND_RULES §6).
 */
export interface KepuRow {
  id: number;
  rbr: number | null; // redni broj u knjizi (numeracija — robno)
  entryDate: string; // datum
  documentNumber: string | null; // dokument
  description: string | null; // opis prometa
  charge: string; // zaduženje (MagUlaz)
  discharge: string; // razduženje (MagStvarniIzlaz)
  balance: string; // saldo (kumulativni)
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['pdv'] as const,
  kif: (p: VatPeriod) => ['pdv', 'kif', p.year, p.month] as const,
  kuf: (p: VatPeriod) => ['pdv', 'kuf', p.year, p.month] as const,
  returns: (year: number) => ['pdv', 'returns', year] as const,
  kepu: (p: VatPeriod) => ['pdv', 'kepu', p.year, p.month] as const,
};

// ─────────────────────────────────────────────────────────────── queries

/**
 * KIF (izlazne fakture) za period — GET /pdv/kif?year=&month=. Vraća
 * `{ data, meta: { count } }`. read = PDV_READ.
 */
export function useKif(period: VatPeriod) {
  return useQuery({
    queryKey: KEYS.kif(period),
    queryFn: () =>
      apiFetch<CountEnvelope<VatLedgerRow>>(
        `${BASE}/kif?year=${period.year}&month=${period.month}`,
      ),
  });
}

/**
 * KUF (ulazne fakture) za period — GET /pdv/kuf?year=&month=. Vraća
 * `{ data, meta: { count } }`. read = PDV_READ.
 */
export function useKuf(period: VatPeriod) {
  return useQuery({
    queryKey: KEYS.kuf(period),
    queryFn: () =>
      apiFetch<CountEnvelope<VatLedgerRow>>(
        `${BASE}/kuf?year=${period.year}&month=${period.month}`,
      ),
  });
}

/**
 * Sačuvani PDV obračuni za godinu — GET /pdv/returns?year=. Vraća
 * `{ data, meta: { count } }`; svaki `VatReturn` nosi `lines[]`. read = PDV_READ.
 */
export function useVatReturns(year: number) {
  return useQuery({
    queryKey: KEYS.returns(year),
    queryFn: () =>
      apiFetch<CountEnvelope<VatReturn>>(`${BASE}/returns?year=${year}`),
  });
}

/**
 * KEPU knjiga za period — GET /pdv/kepu?year=&month=. Vraća `{ data, meta: { count } }`.
 * Punjenje knjige radi robno modul; ovde je samo prikaz. read = PDV_READ.
 */
export function useKepu(period: VatPeriod) {
  return useQuery({
    queryKey: KEYS.kepu(period),
    queryFn: () =>
      apiFetch<CountEnvelope<KepuRow>>(
        `${BASE}/kepu?year=${period.year}&month=${period.month}`,
      ),
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidatePdv() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/**
 * Napuni KIF/KUF iz glavne knjige za period — POST /pdv/kif-kuf/build
 * ({year, month}). Idempotentno (čist period pa reknjiži). Menja evidenciju,
 * pa invalidira ceo `pdv` ključ. Permisija PDV_COMPUTE.
 */
export function useBuildKifKuf() {
  const invalidate = useInvalidatePdv();
  return useMutation({
    mutationFn: (period: VatPeriod) =>
      apiFetch<Envelope<BuildKifKufResult>>(`${BASE}/kif-kuf/build`, {
        method: 'POST',
        body: JSON.stringify({ year: period.year, month: period.month }),
      }),
    onSuccess: invalidate,
  });
}

/** Ulaz POPDV obračuna — mesec (1..12) ILI kvartal (1..4), tačno jedan. */
export interface ComputePopdvInput {
  year: number;
  month?: number;
  quarter?: number;
}

/**
 * POPDV obračun za period (kreira/ažurira VatReturn + AOP linije) — POST
 * /pdv/popdv/compute ({year, month|quarter}). Idempotentno po periodu. Menja
 * obračune, pa invalidira ceo `pdv` ključ. Permisija PDV_COMPUTE.
 */
export function useComputePopdv() {
  const invalidate = useInvalidatePdv();
  return useMutation({
    mutationFn: (input: ComputePopdvInput) =>
      apiFetch<Envelope<PopdvResult>>(`${BASE}/popdv/compute`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Zaključaj (proknjiži) PDV obračun — POST /pdv/returns/:id/post (D3). Status
 * CALCULATED → POSTED; posle ovoga je period zaključan (build/compute/ručne
 * izmene se odbijaju). Permisija PDV_COMPUTE.
 */
export function usePostVatReturn() {
  const invalidate = useInvalidatePdv();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Envelope<VatReturn>>(`${BASE}/returns/${id}/post`, {
        method: 'POST',
      }),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────── ručne KIF/KUF stavke (D4)

/** Novi ručni KIF/KUF red (`source = manual`). direction: output=KIF, input=KUF. */
export interface CreateManualVatEntryInput {
  direction: 'input' | 'output';
  documentNumber: string;
  partnerId?: number | null;
  documentDate: string; // ISO
  taxPeriodYear: number;
  taxPeriodMonth: number;
  vatBase: number;
  vatAmount: number;
  vatRateCode?: string | null;
}

/** Izmena ručnog reda (parcijalno). */
export type UpdateManualVatEntryInput = Partial<CreateManualVatEntryInput>;

/** Kreiraj ručnu KIF/KUF stavku — POST /pdv/kif-kuf/entries. PDV_COMPUTE. */
export function useCreateManualVatEntry() {
  const invalidate = useInvalidatePdv();
  return useMutation({
    mutationFn: (input: CreateManualVatEntryInput) =>
      apiFetch<Envelope<VatLedgerRow>>(`${BASE}/kif-kuf/entries`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Izmeni ručnu KIF/KUF stavku — PATCH /pdv/kif-kuf/entries/:id. PDV_COMPUTE. */
export function useUpdateManualVatEntry() {
  const invalidate = useInvalidatePdv();
  return useMutation({
    mutationFn: (args: { id: number; input: UpdateManualVatEntryInput }) =>
      apiFetch<Envelope<VatLedgerRow>>(`${BASE}/kif-kuf/entries/${args.id}`, {
        method: 'PATCH',
        body: JSON.stringify(args.input),
      }),
    onSuccess: invalidate,
  });
}

/** Obriši ručnu KIF/KUF stavku — DELETE /pdv/kif-kuf/entries/:id. PDV_COMPUTE. */
export function useDeleteManualVatEntry() {
  const invalidate = useInvalidatePdv();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Envelope<{ id: number }>>(`${BASE}/kif-kuf/entries/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────── PDF štampa (D2)

/** Preuzmi PP-PDV obrazac (GET /pdv/print/pp-pdv?period=YYYY-MM|YYYY-Qn). read=PDV_READ. */
export function usePpPdvPdf() {
  return useMutation({
    mutationFn: (period: string) =>
      apiBlob(`${BASE}/print/pp-pdv?period=${encodeURIComponent(period)}`),
  });
}

/** Preuzmi KIF/KUF specifikaciju (GET /pdv/print/kif|kuf?year=&month=). read=PDV_READ. */
export function useLedgerSpecPdf() {
  return useMutation({
    mutationFn: (args: { book: 'kif' | 'kuf'; year: number; month: number }) =>
      apiBlob(`${BASE}/print/${args.book}?year=${args.year}&month=${args.month}`),
  });
}

/** Otvori PDF Blob u novom tabu (browser preview + download). */
export function openPdf(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

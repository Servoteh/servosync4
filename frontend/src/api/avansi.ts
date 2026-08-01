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

/** Jedna primena avansa na konačnom računu (N:M) — 1:1 sa `AdvanceApplicationRef`. */
export interface AdvanceApplicationRef {
  invoiceId: number;
  documentNumber: string;
  /** BRUTO iznos te primene (Decimal string). */
  appliedAmount: string;
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
  /** NENAPLAĆEN deo = bruto − naplaćeno (izlazni avans se naplaćuje u ratama). */
  unpaidAmount: string;
  /** ISKORIŠĆENO — zbir svih aktivnih primena na konačnim računima. */
  appliedAmount: string;
  /** OSTATAK = naplaćeno − iskorišćeno; > 0 → avans se još može odbiti. */
  remainingAmount: string;
  /** SVE primene (N:M) — prazan niz = avans još nije iskorišćen. */
  applications: AdvanceApplicationRef[];
  /**
   * PRVA primena (kompatibilnost). NE koristiti kao uslov za dugme „Veži na
   * konačni račun" — puni se već pri prvoj primeni, pa je ekran po njemu sakrivao
   * odbijanje OSTATKA avansa (nalaz K2 nezavisnog pregleda 27.07). Uslov je
   * `advanceRemainderCents(a) > 0`.
   */
  linkedFinalInvoiceId: number | null;
  linkedFinalDocumentNumber: string | null;
  note: string | null;
}

// ────────────────────────────────────────────────── novac bez Float aritmetike

/**
 * Decimal-as-string („17100.0000", „17100,50") → celobrojne PARE. Poređenja
 * iznosa se rade nad ovim, ne nad `Number` vrednostima: `0.1 + 0.2 > 0.3` je u
 * Float-u tačno, pa bi „iznos je veći od ostatka" umelo da opali na jednakim
 * iznosima. Vraća `NaN` za neparsiv unos (poziv mora to proveriti).
 */
export function decimalToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return NaN;
  const raw = String(value).trim().replace(',', '.');
  if (raw === '') return NaN;
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(raw);
  if (!m) return NaN;
  const sign = m[1] === '-' ? -1 : 1;
  // Treća decimala samo zaokružuje: baza drži Decimal(19,4), a dinar ima 2 decimale.
  const frac = (m[3] ?? '').padEnd(3, '0');
  const cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  return sign * (cents + (Number(frac[2]) >= 5 ? 1 : 0));
}

/** Pare → iznos za slanje backendu / za `<input>` („1710000" → „17100.00"). */
export function centsToAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** OSTATAK avansa u parama = naplaćeno − iskorišćeno. */
export function advanceRemainderCents(a: Advance): number {
  const rem = decimalToCents(a.remainingAmount);
  return Number.isNaN(rem) ? 0 : rem;
}

/** NENAPLAĆEN deo avansa u parama = bruto − naplaćeno. */
export function advanceUnpaidCents(a: Advance): number {
  const unpaid = decimalToCents(a.unpaidAmount);
  return Number.isNaN(unpaid) ? 0 : unpaid;
}

/**
 * Sme li se na avans upisati (još jedna) naplata?
 *   IZLAZNI — da, dok ima nenaplaćenog dela: backend prima naplatu u RATAMA
 *             (`markAdvancePaid`, kumulativni CAS nad `advancePaidAmount`).
 *   ULAZNI  — samo jednom: `markIncomingAdvancePaid` odbija drugi poziv sa 409
 *             (pretporez bi bio priznat dvaput), pa se gleda `paidAt`.
 */
export function canMarkAdvancePaid(a: Advance): boolean {
  if (a.status === 'CANCELLED') return false;
  if (a.direction === ADVANCE_DIRECTION.IN) return a.paidAt == null;
  return advanceUnpaidCents(a) > 0;
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

/**
 * Telo avansnog računa PO UGOVORU (bez predračuna) — ista ruta
 * `POST /sales/advance-invoices`, samo bez `proformaId`.
 *
 * Backend ovo podržava od početka (`validateCreateAdvanceInvoice`: bez predračuna
 * su obavezni `customerId`, `amount` i `basis`), i to sa razlogom — u BigBit
 * produkciji 2025. su DVA NAJVEĆA avansa izdata po Ugovoru, ne po predračunu. U
 * aplikaciji do sada nije postojao nijedan ekran koji taj oblik zahteva sastavlja:
 * jedini ulaz je bio „Napravi avansni račun" sa detalja PREDRAČUNA.
 */
export interface CreateAdvanceByContractInput {
  /** Kupac (obavezan — nema predračuna sa kog bi se preuzeo). */
  customerId: number;
  /** BRUTO iznos avansa (osnovica + PDV) kao string — bez Float aritmetike. */
  amount: string;
  /** OSNOV: broj ugovora ili opis („po Ugovoru br. 12/2026"). Obavezan. */
  basis: string;
  /** Datum avansnog računa (ISO); bez njega backend uzima danas. */
  documentDate?: string;
  /** Šifra PDV stope (podrazumevano '3' = opšta; izvoz uvek '0'). */
  vatRateCode?: string;
  /** Izvoz (bez PDV-a). */
  isExport?: boolean;
  currency?: string;
  note?: string;
}

/**
 * Napravi avansni račun PO UGOVORU (izlazni smer, KIF) — POST
 * /sales/advance-invoices bez `proformaId`. PDV obaveza nastaje tek naplatom.
 * Permisija SALES_WRITE.
 */
export function useCreateAdvanceByContract() {
  const invalidate = useInvalidateAdvances();
  return useMutation({
    mutationFn: (input: CreateAdvanceByContractInput) =>
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
  /**
   * Naplaćen bruto iznos (može biti delimičan — izlazni avans se plaća u ratama).
   * STRING je preporučen oblik: novac ne prolazi kroz Float ni ovde ni u DTO-u.
   */
  amount: string | number;
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
  /**
   * BRUTO iznos odbitka (delimično odbijanje, samo izlazni smer). Bez njega se
   * odbija ceo preostali naplaćen iznos avansa. Jedan avans se tako deli na više
   * računa (BigBit AVR-00013/2025 → 20.802 + 17.100).
   */
  amount?: string | number;
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
  /** Zbir SVIH primena na tom računu (ne samo ove). */
  advanceAppliedAmount?: string;
  payableAmount?: string;
  advanceClosingEntryNumber?: string;
  /** OSTATAK avansa POSLE ove primene — 0 = avans je potrošen. */
  advanceRemainingAmount?: string;
}

/**
 * Veži avans na KONAČNI račun — konačni račun dobija „Umanjenje za primljeni avans"
 * (`advanceAppliedAmount`), a PDV avansa se STORNIRA suprotnom poreskom stavkom da
 * se isti porez ne prizna dvaput.
 *
 * Veza je N:M: isti avans se deli na VIŠE računa dok se ne potroši naplaćen iznos
 * (`amount` po primeni), i jedan račun zatvara više avansa. Dvaput isti avans na
 * ISTOM računu → 409. Permisija: SALES_POST (izlazni) / PDV_COMPUTE (ulazni).
 */
export function useLinkAdvanceToFinal() {
  const invalidate = useInvalidateAdvances();
  return useMutation({
    mutationFn: ({
      advanceId,
      direction,
      finalInvoiceId,
      amount,
    }: LinkAdvanceToFinalInput) => {
      const url =
        direction === ADVANCE_DIRECTION.IN
          ? `${PDV_BASE}/incoming/${advanceId}/link-final`
          : `${SALES_INVOICES_BASE}/${finalInvoiceId}/apply-advance`;
      // Izlazni smer: id u putanji je KONAČNI račun, a avans ide u telu — obrnuto
      // od ulaznog smera, gde ruta visi na avansu.
      const body =
        direction === ADVANCE_DIRECTION.IN
          ? { finalInvoiceId }
          : amount !== undefined && amount !== null && `${amount}`.trim() !== ''
            ? { advanceInvoiceId: advanceId, amount }
            : { advanceInvoiceId: advanceId };
      return apiFetch<Envelope<LinkAdvanceToFinalResult>>(url, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: invalidate,
  });
}

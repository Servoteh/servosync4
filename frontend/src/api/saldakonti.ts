'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';

/**
 * SALDAKONTI — data sloj (Faza 4 §A). TanStack Query hooks nad NestJS
 * `/api/v1/saldakonti/*`. Tipovi 1:1 sa backend servisima:
 *   backend/src/modules/saldakonti/open-items.service.ts     (OpenItem, AgingByPartnerRow)
 *   backend/src/modules/saldakonti/reconciliation.service.ts (ReconcileResult)
 *   backend/src/modules/saldakonti/saldakonti.controller.ts  (rute, envelope)
 *
 * ENVELOPE: domenski endpointi vraćaju `{ data }` (open-items/aging dodaju
 * `meta.count`). Otvorene stavke se NE materijalizuju — izveden pogled nad
 * ledger_entries; nema paginacije (filter po kontu/komitentu sužava skup).
 *
 * NOVAC: Decimal u JSON-u je STRING (BACKEND_RULES §6) — `formatDecimal` na
 * prikazu, a sabiranje ide preko `Number(...)` (dovoljno za prikaz salda;
 * knjiženje presuđuje backend). Komponente NE zovu API direktno — samo kroz
 * ove hook-ove (frontend/CLAUDE.md §8).
 */

const BASE = '/v1/saldakonti';

// ─────────────────────────────────────────────────────────────── tipovi (envelope)

/** Ne-paginirani odgovor domenskog endpointa (`{ data }` ili `{ data, meta }`). */
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Lista + `meta.count` (open-items / aging). */
export interface ListWithCount<T> {
  data: T[];
  meta: { count: number };
}

/**
 * Otvorena stavka (izveden pogled nad `ledger_entries`) — 1:1 sa
 * `OpenItem` u open-items.service.ts. Decimal polja stižu kao STRING.
 * `side` = receivable | payable (iz saldakonto registra).
 */
export interface OpenItem {
  accountCode: string;
  /** Analitička = komitent (null = sintetika bez analitike). */
  analyticalCode: number | null;
  documentNumber: string | null;
  /** Σ debit − Σ credit; dugovni saldo pozitivan (Decimal-as-string). */
  balance: string;
  totalDebit: string;
  totalCredit: string;
  /** Najranije dospeće u grupi (ISO datum) ili null. */
  dueDate: string | null;
  /** asOf − dueDate (dana); null ako nema dospeća. */
  daysOverdue: number | null;
  currency: string | null;
  side: string; // receivable | payable
  /** Svi ledger_entries.id koji čine ovaj red — za uparivanje (reconcile) i kompenzaciju. */
  ledgerEntryIds: number[];
}

/** Aging red po komitentu — saldo raspoređen po dospelosti (Decimal-as-string). */
export interface AgingByPartnerRow {
  analyticalCode: number | null;
  bucket0_30: string;
  bucket31_60: string;
  bucket61_90: string;
  bucket90plus: string;
  total: string;
}

/** Rezultat uparivanja (reconcile) — 1:1 sa `ReconcileResult`. */
export interface ReconcileResult {
  groupId: number;
  entryIds: number[];
  totalDebit: string;
  totalCredit: string;
  /** Σdebit − Σcredit (kursna razlika/otpis; ≤ tolerancija za auto). */
  residual: string;
  balanced: boolean;
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['saldakonti'] as const,
  openItems: ['saldakonti', 'open-items'] as const,
  aging: ['saldakonti', 'aging'] as const,
};

// ─────────────────────────────────────────────────────────────── ulazni tipovi

export interface OpenItemsFilters {
  /** Tačan konto iz saldakonto registra (opciono; podrazumeva sve). */
  accountCode?: string;
  /** Analitička = komitent (opciono). */
  partnerId?: number | '';
  /** Presek na dan (ISO datum; default backend = danas). */
  asOf?: string;
}

export interface AgingFilters {
  accountCode?: string;
  asOf?: string;
}

/** Telo POST /saldakonti/reconcile — uparivanje datih ledger stavki. */
export interface ReconcileInput {
  entryIds: number[];
  /** auto (default) traži balans; manual je za ručno zatvaranje sa ostatkom. */
  mode?: 'auto' | 'manual';
  note?: string;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

// ─────────────────────────────────────────────────────────────── queries

/**
 * Lista otvorenih stavki (+ filter po kontu i komitentu). Bez filtera vraća sve
 * otvorene stavke svih saldakonto konta. Permisija SALDAKONTI_READ.
 */
export function useOpenItems(filters: OpenItemsFilters = {}) {
  const query = buildQuery({
    accountCode: filters.accountCode || undefined,
    partnerId: filters.partnerId === '' ? undefined : filters.partnerId,
    asOf: filters.asOf || undefined,
  });
  return useQuery({
    queryKey: [...KEYS.openItems, filters],
    queryFn: () => apiFetch<ListWithCount<OpenItem>>(`${BASE}/open-items${query}`),
  });
}

/**
 * Aging po komitentu za dati konto (default svi saldakonto konti). Bucketi
 * 0-30 / 31-60 / 61-90 / 90+ po dospelosti (asOf − dueDate). Permisija
 * SALDAKONTI_READ.
 */
export function useAging(accountCode?: string, asOf?: string) {
  const query = buildQuery({
    accountCode: accountCode || undefined,
    asOf: asOf || undefined,
  });
  return useQuery({
    queryKey: [...KEYS.aging, { accountCode: accountCode ?? '', asOf: asOf ?? '' }],
    queryFn: () => apiFetch<ListWithCount<AgingByPartnerRow>>(`${BASE}/aging${query}`),
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateSaldakonti() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/**
 * Upari (zatvori) otvorene stavke — POST /saldakonti/reconcile { entryIds, mode?, note? }.
 * `auto` (default) zahteva balans u granici tolerancije; sve stavke moraju biti
 * isti (kontrolni konto, komitent) i otvorene. Backend vraća 400 za <2 stavke ili
 * duplikate, 422 za nebalansirano/različit konto. Menja ledger stavke (reconciled_at),
 * pa invalidira ceo `saldakonti` ključ. Permisija SALDAKONTI_RECONCILE.
 */
export function useReconcile() {
  const invalidate = useInvalidateSaldakonti();
  return useMutation({
    mutationFn: (input: ReconcileInput) =>
      apiFetch<Envelope<ReconcileResult>>(`${BASE}/reconcile`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Razveži uparenu grupu — POST /saldakonti/reconcile/unreconcile { groupId }.
 * Backend čisti reconciled_at + group na svim redovima grupe (404 ako grupa ne
 * postoji). Permisija SALDAKONTI_RECONCILE.
 */
export function useUnreconcile() {
  const invalidate = useInvalidateSaldakonti();
  return useMutation({
    mutationFn: (groupId: number) =>
      apiFetch<Envelope<unknown>>(`${BASE}/reconcile/unreconcile`, {
        method: 'POST',
        body: JSON.stringify({ groupId }),
      }),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────── kompenzacije (BigBit paritet — FE nad postojećim BE)

export interface CompensationProposalLine {
  ledgerEntryId: number | null;
  accountCode: string;
  documentNumber: string | null;
  side: 'receivable' | 'payable';
  openAmount: string;
  suggestedOffset: string;
}

export interface CompensationProposal {
  partnerId: number;
  totalReceivable: string;
  totalPayable: string;
  offsetAmount: string;
  lines: CompensationProposalLine[];
}

export interface CompensationLineInput {
  ledgerEntryId: number;
  side: 'receivable' | 'payable';
  amount: string;
}

/** Predlog kompenzacije iz otvorenih stavki partnera (GET /saldakonti/compensation/proposal). */
export function useCompensationProposal(partnerId: number | null) {
  return useQuery({
    queryKey: ['saldakonti', 'compensation', 'proposal', partnerId],
    queryFn: () =>
      apiFetch<{ data: CompensationProposal | null; meta?: { error?: string } }>(
        `${BASE}/compensation/proposal?partnerId=${partnerId}`,
      ),
    enabled: partnerId != null && partnerId > 0,
  });
}

/** Kreiraj (i knjiži) kompenzaciju — POST /saldakonti/compensation. */
export function useCreateCompensation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      partnerId: number;
      date?: string;
      note?: string;
      lines: CompensationLineInput[];
      post?: boolean;
    }) =>
      apiFetch<Envelope<{ id: number; number: string; status: string }>>(`${BASE}/compensation`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saldakonti'] }),
  });
}

// ─────────────────────────────────── IOS/NIOS obrazac usaglašavanja (E3 — PDF)

/** Ulaz IOS štampe — komitent + opcioni datum preseka (default backend = danas). */
export interface IosPdfInput {
  partnerId: number;
  /** Datum preseka (ISO datum); bez njega backend uzima danas. */
  asOf?: string;
}

/**
 * Preuzmi IOS/NIOS obrazac usaglašavanja salda za komitenta — GET
 * /saldakonti/ios-pdf?partnerId=&asOf=. Zakonski godišnji obrazac: otvorene
 * stavke komitenta na dan preseka + polja za saglasnost/osporavanje i potpise.
 * NIOS = isti obrazac kad nema otvorenih stavki (saldo 0) — svejedno se štampa.
 * Vraća PDF Blob (otvori kroz `openPdf`). read = SALDAKONTI_READ.
 */
export function useIosPdf() {
  return useMutation({
    mutationFn: (input: IosPdfInput) => {
      const qs = new URLSearchParams({ partnerId: String(input.partnerId) });
      if (input.asOf) qs.set('asOf', input.asOf);
      return apiBlob(`${BASE}/ios-pdf?${qs.toString()}`);
    },
  });
}

/** Otvori PDF Blob u novom tabu (browser preview + download). */
export function openPdf(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ─────────────────────────────────── Slanje IOS obrasca mejlom (A6)

/** Odgovor mail rute: sent=false je DRY-RUN ili neuspeh (backend ne baca). */
export interface SendMailResult {
  sent: boolean;
  to: string;
  fileName: string;
}

/** Telo POST /saldakonti/ios-pdf/send-mail — komitent + adresa primaoca (+ opciono asOf). */
export interface SendIosMailInput {
  partnerId: number;
  to: string;
  asOf?: string;
}

/**
 * Pošalji IOS/NIOS obrazac komitentu mejlom sa PDF prilogom — POST
 * /saldakonti/ios-pdf/send-mail. Ne menja keširane podatke (bez server-side
 * mutacije), pa nema invalidacije. read = SALDAKONTI_READ.
 */
export function useSendIosMail() {
  return useMutation({
    mutationFn: (input: SendIosMailInput) =>
      apiFetch<{ data: SendMailResult }>(`${BASE}/ios-pdf/send-mail`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

// ─────────────────────────────── Dashboard naplate + MaxSaldo (Talas 3 §A7)

/** Aging raspodela (Decimal-as-string) — 1:1 sa backend `AgingBuckets`. */
export interface AgingBuckets {
  bucket0_30: string;
  bucket31_60: string;
  bucket61_90: string;
  bucket90plus: string;
  total: string;
}

/** Red top-liste dužnika: komitent + naziv + bucket raspodela salda. */
export interface TopDebtor extends AgingBuckets {
  partnerId: number | null;
  partnerName: string | null;
}

/**
 * Dashboard naplate (agregati nad otvorenim stavkama) — 1:1 sa
 * `CollectionDashboard` u collection-dashboard.service.ts. Decimal polja su STRING;
 * `dso` je metrika (broj dana) → number.
 */
export interface CollectionDashboard {
  asOf: string;
  totalReceivable: string;
  totalPayable: string;
  netReceivable: string;
  overdueReceivable: string;
  dso: number;
  receivableOpenCount: number;
  aging: AgingBuckets;
  topDebtors: TopDebtor[];
}

/** Rezultat MaxSaldo batch-a — 1:1 sa `SmallBalancesResult`. */
export interface SmallBalancesResult {
  closedGroups: number;
  totalAmount: string;
  threshold: string;
}

/**
 * Dashboard naplate — GET /saldakonti/collection-dashboard?asOf=. Agregati:
 * ukupno potraživanja/obaveze, DSO, aging bucketi ukupno, top 10 dužnika.
 * Permisija SALDAKONTI_READ.
 */
export function useCollectionDashboard(asOf?: string) {
  const query = buildQuery({ asOf: asOf || undefined });
  return useQuery({
    queryKey: ['saldakonti', 'collection-dashboard', { asOf: asOf ?? '' }],
    queryFn: () =>
      apiFetch<Envelope<CollectionDashboard>>(`${BASE}/collection-dashboard${query}`),
  });
}

/**
 * MaxSaldo — POST /saldakonti/reconcile/small-balances { threshold? }. Zatvara sve
 * otvorene grupe sa 0 < |saldo| ≤ prag (default 1.00) postojećim reconcile
 * mehanizmom (samo flag; otpis se ne knjiži). Menja ledger stavke → invalidira ceo
 * `saldakonti` ključ. Permisija SALDAKONTI_RECONCILE.
 */
export function useReconcileSmallBalances() {
  const invalidate = useInvalidateSaldakonti();
  return useMutation({
    mutationFn: (input: { threshold?: number | string }) =>
      apiFetch<Envelope<SmallBalancesResult>>(`${BASE}/reconcile/small-balances`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────── kartica komitenta (Talas 2 §A1 — ledger + running saldo)

/**
 * Jedan red kartice komitenta — 1:1 sa `PartnerCardRow` (partner-card.service.ts).
 * Decimal polja (debit/credit/balance) stižu kao STRING; datumi kao ISO string.
 * `balance` je running saldo (početno stanje + Σ duguje − potražuje do ovog reda).
 */
export interface PartnerCardRow {
  ledgerEntryId: number;
  postingDate: string;
  documentDate: string | null;
  accountCode: string;
  journalNumber: string;
  orderTypeCode: string;
  documentNumber: string | null;
  description: string | null;
  debit: string;
  credit: string;
  balance: string;
  dueDate: string | null;
  reconciledAt: string | null;
}

/** Podaci komitenta iz šifarnika (meki ref; null ako je obrisan/ne postoji). */
export interface PartnerCardPartner {
  id: number;
  name: string;
  address: string | null;
  postalCode: string | null;
  city: string | null;
  taxId: string | null;
  registrationNumber: string | null;
}

/** Kartica komitenta — 1:1 sa `PartnerCard` (partner-card.service.ts). */
export interface PartnerCard {
  partnerId: number;
  accountCode: string | null;
  from: string | null;
  to: string | null;
  /** Početno stanje (saldo pre `from`); 0 kad nema `from`. */
  opening: string;
  rows: PartnerCardRow[];
  totalDebit: string;
  totalCredit: string;
  /** Zatvaranje = opening + Σduguje − Σpotražuje (slaže se sa saldom otvorenih stavki). */
  closing: string;
  partner: PartnerCardPartner | null;
}

export interface PartnerCardFilters {
  /** Komitent (obavezan da bi se upit montirao). */
  partnerId: number | null;
  /** Tačan saldakonto konto (opciono; podrazumeva sve saldakonto konte). */
  accountCode?: string;
  /** Početak perioda (ISO datum); početno stanje = saldo pre ovog datuma. */
  from?: string;
  /** Kraj perioda (ISO datum; uključivo). */
  to?: string;
}

/**
 * Kartica komitenta — hronološke stavke glavne knjige partnera (posted/locked) sa
 * running saldo kolonom + početnim stanjem pre `from`. Upit se montira tek kad je
 * `partnerId` poznat. Permisija SALDAKONTI_READ.
 */
export function usePartnerCard(filters: PartnerCardFilters) {
  const { partnerId, accountCode, from, to } = filters;
  const query = buildQuery({
    partnerId: partnerId ?? undefined,
    accountCode: accountCode || undefined,
    from: from || undefined,
    to: to || undefined,
  });
  return useQuery({
    queryKey: ['saldakonti', 'partner-card', filters],
    queryFn: () => apiFetch<Envelope<PartnerCard>>(`${BASE}/partner-card${query}`),
    enabled: partnerId != null && partnerId > 0,
  });
}

/** Ulaz PDF štampe kartice — komitent + opcioni konto/period (kao za `usePartnerCard`). */
export interface PartnerCardPdfInput {
  partnerId: number;
  accountCode?: string;
  from?: string;
  to?: string;
}

/**
 * Preuzmi karticu komitenta kao PDF — GET /saldakonti/partner-card/pdf. Vraća PDF
 * Blob (otvori kroz `openPdf`). read = SALDAKONTI_READ.
 */
export function usePartnerCardPdf() {
  return useMutation({
    mutationFn: (input: PartnerCardPdfInput) => {
      const qs = new URLSearchParams({ partnerId: String(input.partnerId) });
      if (input.accountCode) qs.set('accountCode', input.accountCode);
      if (input.from) qs.set('from', input.from);
      if (input.to) qs.set('to', input.to);
      return apiBlob(`${BASE}/partner-card/pdf?${qs.toString()}`);
    },
  });
}

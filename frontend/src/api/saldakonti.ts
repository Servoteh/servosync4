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
  /** Devizni saldo grupe (C2; Decimal-as-string). null = stavka nije devizna. */
  fxAmount: string | null;
  /** Valuta deviznog salda (EUR, USD…); `balance` iznad je dinarska protivvrednost. */
  fxCurrency: string | null;
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

/** Jedan red spiska kompenzacija (GET /saldakonti/compensation). */
export interface CompensationRow {
  id: number;
  compensationNumber: string;
  partnerId: number;
  partnerName: string | null;
  date: string;
  status: string;
  totalAmount: string;
  journalEntryId: number | null;
  lineCount: number;
}

/**
 * Spisak kompenzacija — bez njega se izjava mogla odštampati samo iz prolazne
 * trake odmah po kreiranju, pa je proknjižen dokument ostajao bez papira.
 */
export function useCompensations(partnerId: number | null) {
  return useQuery({
    queryKey: ['saldakonti', 'compensation', 'list', partnerId],
    queryFn: () =>
      apiFetch<{ data: CompensationRow[]; meta: { total: number } }>(
        `${BASE}/compensation${partnerId != null && partnerId > 0 ? `?partnerId=${partnerId}` : ''}`,
      ),
  });
}

/**
 * Štampa IZJAVE O KOMPENZACIJI — GET /saldakonti/compensation/:id/pdf. Obrazac
 * prebijanja: dve tabele (naša potraživanja / naše obaveze), zbir svake strane,
 * prebijeni iznos brojem i slovima i dva potpisa sa M.P. Vraća PDF Blob (otvori
 * kroz `openPdf`). read = SALDAKONTI_READ.
 */
export function useCompensationPdf() {
  return useMutation({
    mutationFn: (compensationId: number) =>
      apiBlob(`${BASE}/compensation/${compensationId}/pdf`),
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
export { openPdf } from '@/lib/open-pdf';

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
  /** Devizni par stavke (C2) — dinarske kolone su protivvrednost. null = nije devizna. */
  fxDebit: string | null;
  fxCredit: string | null;
  fxAmount: string | null;
  fxCurrency: string | null;
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

// ─────────────────────────────────── Opomene / dunning (Talas 3 B6)

/**
 * Kandidat za opomenu — 1:1 sa `DunningCandidate` (dunning.service.ts). Decimal
 * polja stižu kao STRING; nivo je 1|2|3 izveden iz najstarijeg kašnjenja aging-a.
 */
export interface DunningCandidate {
  partnerId: number;
  partnerName: string | null;
  /** Mejl komitenta iz šifarnika (prefill primaoca); null ako ga nema. */
  email: string | null;
  /** Dospelo (Σ dugovnih salda dospelih stavki) — Decimal-as-string. */
  overdueAmount: string;
  /** Najstarije kašnjenje u danima. */
  daysOverdue: number;
  /** Izvedeni nivo 1|2|3. */
  level: number;
  /** Poslednja opomena bilo kog nivoa (ISO) ili null. */
  lastSentAt: string | null;
  lastSentLevel: number | null;
  /** Da li je opomena OVOG nivoa već poslata danas. */
  alreadySentToday: boolean;
}

/** Rezultat pojedinačnog slanja opomene — 1:1 sa `DunningSendResult`. */
export interface DunningSendResult {
  noticeId: number;
  partnerId: number;
  level: number;
  to: string;
  /** false = DRY-RUN (Resend nije podešen) ili neuspeh; red je ipak upisan. */
  sentOk: boolean;
  fileName: string;
  daysOverdue: number;
  overdueAmount: string;
}

/** Rezultat masovnog slanja — 1:1 sa `DunningBatchResult`. */
export interface DunningBatchResult {
  sent: number;
  skipped: number;
  failed: number;
}

/** Telo POST /saldakonti/dunning/send — komitent + opcioni nivo/primalac. */
export interface DunningSendInput {
  partnerId: number;
  /** Nivo 1|2|3; bez njega backend izvodi iz aging-a. */
  level?: number;
  /** Primalac; bez njega backend uzima mejl komitenta (422 ako ga nema). */
  to?: string;
}

const DUNNING_KEY = ['saldakonti', 'dunning', 'candidates'] as const;

/**
 * Kandidati za opomenu (dospela potraživanja + izvedeni nivo + istorija).
 * `asOf` presek na dan (default backend = danas). Permisija SALDAKONTI_READ.
 */
export function useDunningCandidates(asOf?: string) {
  const query = buildQuery({ asOf: asOf || undefined });
  return useQuery({
    queryKey: [...DUNNING_KEY, { asOf: asOf ?? '' }],
    queryFn: () =>
      apiFetch<ListWithCount<DunningCandidate>>(`${BASE}/dunning/candidates${query}`),
  });
}

/**
 * Pošalji opomenu jednom komitentu — POST /saldakonti/dunning/send. Backend vraća
 * 409 ako je isti nivo već poslat danas, 422 ako nema primaoca/dospelog duga.
 * Upisuje DunningNotice → invalidira listu kandidata. Permisija SALDAKONTI_RECONCILE.
 */
export function useDunningSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DunningSendInput) =>
      apiFetch<Envelope<DunningSendResult>>(`${BASE}/dunning/send`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saldakonti', 'dunning'] }),
  });
}

/** Ulaz štampe opomene — komitent + nivo (default 1) + opcioni datum preseka. */
export interface DunningPdfInput {
  partnerId: number;
  /** Nivo 1|2|3; bez njega backend uzima 1. */
  level?: number;
  /** Datum preseka (ISO datum); bez njega backend uzima danas. */
  asOf?: string;
}

/**
 * ŠTAMPA OPOMENE — GET /saldakonti/dunning/pdf?partnerId=&level=&asOf=. Isti
 * obrazac koji ide u prilogu mejla, samo za ruku (dosad se opomena mogla samo
 * poslati mejlom — PDF servis je postojao bez GET rute). Vraća PDF Blob (otvori
 * kroz `openPdf`). read = SALDAKONTI_READ.
 */
export function useDunningPdf() {
  return useMutation({
    mutationFn: (input: DunningPdfInput) => {
      const qs = new URLSearchParams({ partnerId: String(input.partnerId) });
      if (input.level != null) qs.set('level', String(input.level));
      if (input.asOf) qs.set('asOf', input.asOf);
      return apiBlob(`${BASE}/dunning/pdf?${qs.toString()}`);
    },
  });
}

/**
 * Masovno slanje opomena — POST /saldakonti/dunning/send-batch { asOf?, maxLevel? }.
 * Šalje svima koji danas nisu dobili opomenu tog nivoa (najviše 50 po pozivu).
 * Vraća { sent, skipped, failed }. Permisija SALDAKONTI_RECONCILE.
 */
export function useDunningSendBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { asOf?: string; maxLevel?: number }) =>
      apiFetch<Envelope<DunningBatchResult>>(`${BASE}/dunning/send-batch`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saldakonti', 'dunning'] }),
  });
}

// ────────────────── Kursne razlike / revalorizacija deviznih stavki (C2)

/**
 * Jedna revalorizovana otvorena stavka — 1:1 sa `FxRevaluationItem`
 * (fx-revaluation.service.ts). Decimal polja stižu kao STRING.
 */
export interface FxRevaluationItem {
  accountCode: string;
  analyticalCode: number | null;
  documentNumber: string | null;
  side: string; // receivable | payable
  /** Devizni saldo (+ potraživanje, − obaveza). */
  fxAmount: string;
  /** Knjigovodstvena protivvrednost u RSD. */
  bookedAmount: string;
  /** Nova protivvrednost = fxAmount × kurs na dan preseka. */
  revaluedAmount: string;
  /** revaluedAmount − bookedAmount (+ dobitak = 663, − gubitak = 563). */
  difference: string;
  ledgerEntryIds: number[];
}

/**
 * Grupa koju obračun NE knjiži (ili knjiži samo uz „uključi sporne") — 1:1 sa
 * `FxRevaluationFlaggedItem`. Prikazuje se korisniku kao greška podataka; tiho
 * ispadanje bi značilo izgubljen deo bilansa.
 *   MIXED_CURRENCY | NO_FX_PAIR | FX_SIGN_MISMATCH | RATE_MISMATCH
 */
export interface FxRevaluationFlaggedItem {
  accountCode: string;
  analyticalCode: number | null;
  documentNumber: string | null;
  code: string;
  /** Srpska poruka sa uzrokom i uputstvom. */
  message: string;
  fxAmount: string | null;
  bookedAmount: string;
  impliedRate: string | null;
  currencies?: string[];
  included: boolean;
}

/** Pregled revalorizacije (bez upisa) — 1:1 sa `FxRevaluationPreview`. */
export interface FxRevaluationPreview {
  asOfDate: string;
  currency: string;
  companyId: number;
  /** Srednji kurs upotrebljen za preračun. */
  rate: string;
  /** Datum kursne liste koja je stvarno upotrebljena (vikend/praznik → raniji dan). */
  rateDate: string;
  /** true kad kursna lista za dan preseka nije uneta (obračun po zastarelom kursu). */
  staleRate: boolean;
  rateType: string;
  items: FxRevaluationItem[];
  itemsCount: number;
  gainTotal: string;
  lossTotal: string;
  netAmount: string;
  /** Grupe sa više valuta u istoj grupi — isključene iz obračuna. */
  mixedCurrencyGroups: FxRevaluationFlaggedItem[];
  /** Sporne grupe (devizni i dinarski saldo se ne slažu) — knjiže se samo uz `force`. */
  flagged: FxRevaluationFlaggedItem[];
  /** Da li su sporne grupe uključene u prikazane zbirove. */
  forced: boolean;
}

/** Red liste obračuna — 1:1 sa `FxRevaluationRun` (tabela fx_revaluation_runs). */
export interface FxRevaluationRun {
  id: number;
  asOfDate: string;
  currency: string;
  companyId: number;
  rateUsed: string;
  /** Dan kursne liste koja je upotrebljena (revizorski trag; null za stare obračune). */
  rateDate: string | null;
  gainAmount: string;
  lossAmount: string;
  itemsCount: number;
  journalEntryId: number | null;
  /** POSTED | REVERSED. */
  status: string;
  note: string | null;
  createdAt: string;
}

/** Rezultat obračuna — 1:1 sa `FxRevaluationRunResult`. */
export interface FxRevaluationRunResult {
  runId: number;
  asOfDate: string;
  currency: string;
  companyId: number;
  rateUsed: string;
  rateDate: string | null;
  gainAmount: string;
  lossAmount: string;
  itemsCount: number;
  journalEntryId: number;
  journalNumber: string;
  status: string;
  mixedCurrencyGroups: FxRevaluationFlaggedItem[];
  flagged: FxRevaluationFlaggedItem[];
}

export interface FxRevaluationFilters {
  /** Datum preseka (ISO); prazno → upit se ne montira. */
  asOfDate: string;
  /** Devizna valuta (EUR, USD…); prazno → upit se ne montira. */
  currency: string;
  companyId?: number;
  /** Svesno dozvoli kurs sa ranijeg dana (bez ovoga backend vraća 409). */
  allowStaleRate?: boolean;
  /** Svesno uključi sporne grupe u zbirove pregleda. */
  force?: boolean;
}

const FX_KEY = ['saldakonti', 'fx-revaluation'] as const;

/**
 * Pregled kursnih razlika na dan preseka („Proveri") — GET
 * /saldakonti/fx-revaluation/preview?asOfDate=&currency=. Ne upisuje ništa: lista
 * otvorenih deviznih stavki, kurs na dan, knjigovodstvena vs. nova protivvrednost i
 * razlika po stavci. Backend vraća 404 kad nema kursne liste za taj dan, 409 kad je
 * presek u budućnosti I kad kursna lista za dan preseka nije uneta (tada se ponavlja
 * uz `allowStaleRate`). Permisija SALDAKONTI_READ.
 */
export function useFxRevaluationPreview(filters: FxRevaluationFilters | null) {
  const query = filters
    ? buildQuery({
        asOfDate: filters.asOfDate,
        currency: filters.currency,
        companyId: filters.companyId,
        allowStaleRate: filters.allowStaleRate ? '1' : undefined,
        force: filters.force ? '1' : undefined,
      })
    : '';
  return useQuery({
    queryKey: [...FX_KEY, 'preview', filters],
    queryFn: () =>
      apiFetch<Envelope<FxRevaluationPreview>>(`${BASE}/fx-revaluation/preview${query}`),
    enabled: filters != null && filters.asOfDate !== '' && filters.currency !== '',
  });
}

/** Lista ranijih obračuna (najnoviji presek prvi) — GET /saldakonti/fx-revaluation. */
export function useFxRevaluationList(params: { year?: number; currency?: string } = {}) {
  const query = buildQuery({
    year: params.year,
    currency: params.currency || undefined,
  });
  return useQuery({
    queryKey: [...FX_KEY, 'list', params],
    queryFn: () => apiFetch<ListWithCount<FxRevaluationRun>>(`${BASE}/fx-revaluation${query}`),
  });
}

/**
 * Obračunaj i proknjiži kursne razlike — POST /saldakonti/fx-revaluation/run
 * { asOfDate, currency, companyId?, note? }. Kreira nalog kursnih razlika (663/563)
 * i zapis obračuna. Backend vraća 409 kad je isti presek već obračunat (storniraj pa
 * ponovi) i 422 kad nema nijedne razlike. Menja glavnu knjigu → invalidira ceo
 * `saldakonti` ključ. Permisija SALDAKONTI_RECONCILE.
 *
 * `expectedRate`/`expectedNetAmount` su vrednosti IZ PREGLEDA koji je korisnik video —
 * ako se u međuvremenu ispravi kursna lista ili proknjiži devizni nalog, backend vraća
 * 409 umesto da proknjiži iznos koji niko nije odobrio. Šalju se uvek kad pregled postoji.
 */
export function useFxRevaluationRun() {
  const invalidate = useInvalidateSaldakonti();
  return useMutation({
    mutationFn: (input: {
      asOfDate: string;
      currency: string;
      companyId?: number;
      note?: string;
      force?: boolean;
      allowStaleRate?: boolean;
      expectedRate?: string;
      expectedNetAmount?: string;
    }) =>
      apiFetch<Envelope<FxRevaluationRunResult>>(`${BASE}/fx-revaluation/run`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Storniraj obračun — POST /saldakonti/fx-revaluation/reverse { runId, reason? }.
 * Stornira nalog kursnih razlika i oslobađa presek za ponovni obračun. Backend vraća
 * 409 kad je nalog zaključan (prvo otključaj) ili obračun već storniran.
 * Permisija SALDAKONTI_RECONCILE.
 */
export function useFxRevaluationReverse() {
  const invalidate = useInvalidateSaldakonti();
  return useMutation({
    mutationFn: (input: { runId: number; reason?: string }) =>
      apiFetch<Envelope<{ runId: number; status: string; stornoEntryId: number | null }>>(
        `${BASE}/fx-revaluation/reverse`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: invalidate,
  });
}

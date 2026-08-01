'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';

/**
 * NACRT — data sloj modula Nabavka (Traka B §B). TanStack Query hooks nad NestJS
 * `/api/v1/nabavka/*`. Tipovi 1:1 sa backend nacrtom:
 *   backend/src/modules/nabavka/nabavka.controller.ts.nacrt (rute)
 *   backend/src/modules/nabavka/nabavka.service.ts.nacrt      (status-mašina, envelope)
 *   backend/src/modules/nabavka/dto/create-purchase-request.dto.ts.nacrt (create ulaz)
 *
 * `*.ts.nacrt` = van TypeScript kompilacije (kao i backend nacrt), da referentna
 * skela ne obori build dok Prisma modeli / permisije nisu aktivirani. Aktivacija:
 * vidi src/app/nabavka/README.nacrt.md.
 *
 * VAŽNO (envelope): backend `listRequests` vraća `{ data, meta: { total } }` i
 * paginira preko `skip`/`take` (NE `page`/`meta.pagination` kao tech-processes/
 * handovers). Ovaj sloj to verno prati; UI računa strane iz `total` + `take`.
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 */

const BASE = '/v1/nabavka';

// ─────────────────────────────────────────────────────────────── status-mašina

/**
 * Status zahteva za nabavku (`purchase_requests.status`) — 1:1 sa backend
 * servisom (DRAFT→SUBMITTED→APPROVED). SENT/RECEIVED su statusi NAREDNIH entiteta
 * (upit/narudžbenica) u istoj status-mašini modula; ulaze u kanonsku mapu statusa
 * (DESIGN_SYSTEM §7) kao NABAVKA domen. Vrednosti su stringovi (BACKEND_RULES §2).
 */
export const NABAVKA_REQUEST_STATUS = {
  DRAFT: 'DRAFT', // U pripremi — inženjer još sastavlja zahtev
  SUBMITTED: 'SUBMITTED', // Predat — čeka odobrenje nabavke
  APPROVED: 'APPROVED', // Odobren — može upit dobavljaču
  SENT: 'SENT', // Upit poslat dobavljaču (RFQ sentAt)
  RECEIVED: 'RECEIVED', // Roba primljena (narudžbenica → prijem)
} as const;

export type NabavkaStatus =
  (typeof NABAVKA_REQUEST_STATUS)[keyof typeof NABAVKA_REQUEST_STATUS];

// ─────────────────────────────────────────────────────────────── tipovi (envelope)

/** Ne-paginirani odgovor domenskog endpointa (`{ data }` ili `{ data, meta }`). */
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Paginirani odgovor `listRequests` — backend šalje `meta.total` (skip/take model). */
export interface PaginatedTotal<T> {
  data: T[];
  meta: { total: number };
}

/** Stavka zahteva (`purchase_request_items`) — 1:1 sa Prisma create u servisu. */
export interface PurchaseRequestItem {
  id: number;
  lineNo: number;
  articleId: number | null;
  description: string | null;
  /** Decimal-as-string u JSON-u (BACKEND_RULES §6) — formatDecimal na prikazu. */
  quantity: string;
  unit: string | null;
  /** Označena za auto-mail upit dobavljaču (KreirajUpit). */
  createRfq: boolean;
  suggestedSupplierId: number | null;
}

/** Red radne liste zahteva — GET /nabavka/requests (include: { items }). */
export interface PurchaseRequest {
  id: number;
  /** Broj zahteva „NNNN/god" (server generiše). */
  requestNumber: string;
  projectId: number;
  workOrderId: number | null;
  /** Inicijator (radnik/korisnik koji je preuzeo i uneo zahtev). */
  initiatorUserId: number;
  createdByUserId: number;
  updatedByUserId: number | null;
  status: NabavkaStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string | null;
  items: PurchaseRequestItem[];
}

// ─────────────────────────────────────────────────────────────── upit (RFQ)

/**
 * Upit dobavljaču (`supplier_rfqs`) — 1:1 sa Prisma modelom `SupplierRfq`.
 * Nastaje iz odobrenog zahteva (`createAndSendRfq`); `sentAt` je log slanja
 * auto-maila (BigBit „Poslato" → timestamp). CENA se NE drži ovde (tek u
 * narudžbenici — BigBit pravilo, doc 24).
 */
export interface SupplierRfq {
  id: number;
  /** Broj upita „predmet-N" (server generiše). */
  rfqNumber: string;
  requestId: number | null;
  supplierId: number;
  status: string; // DRAFT | SENT | QUOTED | CLOSED
  /** ISO timestamp slanja auto-maila; null dok nije poslato (DRY-RUN). */
  sentAt: string | null;
  emailMessageId: string | null;
  note: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string | null;
  items?: SupplierRfqItem[];
}

/** Stavka upita (`supplier_rfq_items`) — bez cene (cena tek u narudžbenici). */
export interface SupplierRfqItem {
  id: number;
  rfqId: number;
  requestItemId: number | null;
  articleId: number | null;
  description: string | null;
  /** Decimal-as-string u JSON-u (BACKEND_RULES §6) — formatDecimal na prikazu. */
  quantity: string;
  unit: string | null;
  offeredLeadTimeDays: number | null;
  isAccepted: boolean;
  lineNo: number;
}

// ─────────────────────────────────────────────────────────────── narudžbenica

/**
 * Narudžbenica dobavljaču (`purchase_orders`) — 1:1 sa Prisma modelom
 * `PurchaseOrder`. Nastaje iz prihvaćene ponude; cena se drži na stavkama.
 * Status-mašina: DRAFT→ORDERED→SIGNED→LOCKED→RECEIVED→CLOSED. Prijem (3-way
 * match) je moguć tek od ORDERED/SIGNED/LOCKED (backend guard).
 */
export interface PurchaseOrder {
  id: number;
  /** Broj narudžbenice „NNNN/god" (server generiše). */
  orderNumber: string;
  rfqId: number | null;
  supplierId: number;
  projectId: number | null;
  status: string; // DRAFT | ORDERED | SIGNED | LOCKED | RECEIVED | CLOSED
  /** ISO timestamp poručivanja (BigBit „Poruceno"); null u DRAFT-u. */
  orderedAt: string | null;
  currency: string;
  note: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string | null;
  items: PurchaseOrderItem[];
}

/**
 * Stavka narudžbenice (`purchase_order_items`) — naručeno vs primljeno (3-way
 * match). `receivedQuantity` default = `orderedQuantity` pri prijemu (BigBit
 * „IsporucenaKolicina"). Cena (`unitPrice`) se drži OVDE, ne u upitu.
 */
export interface PurchaseOrderItem {
  id: number;
  orderId: number;
  rfqItemId: number | null;
  requestItemId: number | null;
  articleId: number | null;
  description: string | null;
  /** Decimal-as-string u JSON-u (BACKEND_RULES §6). */
  orderedQuantity: string;
  /** Decimal-as-string; 0 dok prijem nije proknjižen. */
  receivedQuantity: string;
  /** Cena po jedinici (Decimal-as-string) — null dok nije uneta. */
  unitPrice: string | null;
  unit: string | null;
  lineNo: number;
}

// ────────────────────────────────────── 3-way match (naručeno/primljeno/fakturisano)

/**
 * Poređenje naručeno ↔ primljeno ↔ fakturisano — 1:1 sa backend
 * `nabavka/dto/three-way-match.dto.ts`.
 *
 * ⚠️ POSLOVNO PRAVILO: odstupanje je **UPOZORENJE, nikad blokada.** Nalazi se
 * prikazuju uz stavku, ali nijedno dugme (prijem, kreiranje/potpis/izvoz naloga)
 * se zbog njih NE onemogućava.
 */
export const MATCH_FINDING_CODE = {
  /** Fakturisano više nego primljeno. */
  QTY_OVER_RECEIPT: 'QTY_OVER_RECEIPT',
  /** Primljeno više nego fakturisano (faktura možda tek stiže). */
  QTY_UNDER_RECEIPT: 'QTY_UNDER_RECEIPT',
  /** Jedinična cena na fakturi odstupa od naručene preko tolerancije. */
  PRICE_VARIANCE: 'PRICE_VARIANCE',
  /** Primljeno više nego naručeno. */
  QTY_OVER_ORDER: 'QTY_OVER_ORDER',
  /** Faktura bez prijema. */
  NO_RECEIPT: 'NO_RECEIPT',
} as const;

export type MatchFindingCode =
  (typeof MATCH_FINDING_CODE)[keyof typeof MATCH_FINDING_CODE];

export type MatchFindingLevel = 'INFO' | 'WARNING';

/** Kratka srpska oznaka nalaza za pilulu/legendu (puni tekst je u `message`). */
export const MATCH_FINDING_LABEL: Record<MatchFindingCode, string> = {
  QTY_OVER_RECEIPT: 'Fakturisano > primljeno',
  QTY_UNDER_RECEIPT: 'Fakturisano < primljeno',
  PRICE_VARIANCE: 'Odstupanje cene',
  QTY_OVER_ORDER: 'Primljeno > naručeno',
  NO_RECEIPT: 'Faktura bez prijema',
};

export interface MatchFinding {
  code: MatchFindingCode;
  level: MatchFindingLevel;
  /** Srpski opis (tooltip / traka upozorenja). */
  message: string;
  orderItemId: number | null;
  lineNo: number | null;
}

/** Poređenje po stavci narudžbenice; sve količine/iznosi su Decimal-as-string. */
export interface ThreeWayMatchLine {
  orderItemId: number;
  lineNo: number;
  articleId: number | null;
  description: string | null;
  unit: string | null;
  orderedQty: string;
  receivedQty: string;
  invoicedQty: string;
  orderedUnitPrice: string | null;
  invoicedUnitPrice: string | null;
  orderedAmount: string;
  invoicedAmount: string;
  varianceAmount: string;
  /** false = stavka bez artikla (usluga) — ne uparuje se sa robnim dokumentom. */
  matchable: boolean;
  findings: MatchFinding[];
}

/** Robni ulaz (primka) vezan za narudžbenicu — nosilac primljeno/fakturisano. */
export interface MatchedStockDocument {
  id: number;
  documentNumber: string;
  status: string;
  documentDate: string;
  journalEntryId: number | null;
}

/** KUF trag (ulazna faktura) izveden iz GL naloga robnog ulaza — kontrola zbira. */
export interface MatchedVatLedger {
  entryIds: number[];
  documentNumbers: string[];
  vatBase: string;
  vatAmount: string;
}

export interface ThreeWayMatchResult {
  orderId: number;
  orderNumber: string;
  supplierId: number;
  supplierName: string | null;
  status: string;
  currency: string;
  orderedAt: string | null;
  stockDocuments: MatchedStockDocument[];
  vatLedger: MatchedVatLedger | null;
  totals: {
    orderedAmount: string;
    invoicedAmount: string;
    varianceAmount: string;
  };
  lines: ThreeWayMatchLine[];
  findings: MatchFinding[];
  hasFindings: boolean;
  hasWarnings: boolean;
}

/** Red pregleda 3-way match-a po više narudžbenica. */
export interface ThreeWayMatchSummaryRow {
  orderId: number;
  orderNumber: string;
  supplierId: number;
  supplierName: string | null;
  status: string;
  currency: string;
  orderedAt: string | null;
  orderedAmount: string;
  invoicedAmount: string;
  varianceAmount: string;
  findingCount: number;
  warningCount: number;
  hasWarnings: boolean;
  codes: MatchFindingCode[];
}

export interface MatchSummaryFilters {
  from?: string;
  to?: string;
  supplierId?: number;
  onlyWithFindings?: boolean;
  skip?: number;
  take?: number;
}

export interface MatchSummaryResponse {
  data: ThreeWayMatchSummaryRow[];
  meta: {
    total: number;
    returned: number;
    skip: number;
    take: number;
    withFindings: number;
    withWarnings: number;
  };
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['nabavka'] as const,
  requests: ['nabavka', 'requests'] as const,
  orders: ['nabavka', 'orders'] as const,
  rfqs: ['nabavka', 'rfqs'] as const,
  match: ['nabavka', 'match'] as const,
};

// ─────────────────────────────────────────────────────────────── ulazni tipovi

export interface CreatePurchaseRequestItemInput {
  articleId?: number;
  description?: string;
  quantity: number;
  unit?: string;
  createRfq?: boolean;
  suggestedSupplierId?: number;
}

/** Telo POST /nabavka/requests — 1:1 sa create-purchase-request.dto.ts.nacrt. */
export interface CreatePurchaseRequestInput {
  projectId: number; // kičma — obavezno
  workOrderId?: number;
  note?: string;
  items: CreatePurchaseRequestItemInput[];
}

export interface NabavkaRequestFilters {
  /** 1-bazna strana (UI); prevodi se u `skip = (page-1)*take`. */
  page?: number;
  /** Veličina strane (backend default 50). */
  take?: number;
  status?: NabavkaStatus | '';
  projectId?: number | '';
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
 * Radna lista zahteva za nabavku (+ filter po statusu i predmetu, server-side
 * paginacija). Backend paginira preko `skip`/`take` i vraća `{ data, meta:{total} }`
 * — page (1-bazan) se ovde prevodi u `skip`. `take` podrazumevano 50.
 */
export function useNabavkaRequests(filters: NabavkaRequestFilters = {}) {
  const take = filters.take && filters.take > 0 ? filters.take : 50;
  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const query = buildQuery({
    status: filters.status === '' ? undefined : filters.status,
    projectId: filters.projectId === '' ? undefined : filters.projectId,
    skip: page > 1 ? (page - 1) * take : undefined,
    take: take !== 50 ? take : undefined,
  });
  return useQuery({
    queryKey: [...KEYS.requests, filters],
    queryFn: () => apiFetch<PaginatedTotal<PurchaseRequest>>(`${BASE}/requests${query}`),
  });
}

/**
 * Detalj jednog zahteva (zaglavlje + stavke) — `GET /nabavka/requests/:id`.
 *
 * Ranije se izvodio klijentski iz prvih 500 redova radne liste. To je radilo dok
 * se detalj uopšte nije mogao otvoriti; čim je otvaranje po linku postalo redovan
 * put, zahtev van prvih 500 se VIDEO u listi a nije se otvarao — uz poruku
 * „možda je obrisan", koja nije tačna. `enabled` gasi upit dok id nije poznat,
 * pa se nikad ne šalje zahtev na `/requests/null`.
 */
export function useNabavkaRequest(id: number | null) {
  const query = useQuery({
    queryKey: [...KEYS.requests, 'detail', id],
    queryFn: () => apiFetch<PurchaseRequest>(`${BASE}/requests/${id}`),
    enabled: id != null,
  });
  const err = query.error as (Error & { status?: number }) | null;
  // 404 sa servera je „ne postoji", sve ostalo je greška veze/prava i NE sme se
  // prikazati kao „dokument je obrisan".
  const isMissing = err != null && err.status === 404;
  return {
    request: query.data ?? null,
    isLoading: query.isLoading,
    error: isMissing ? null : err,
    notFound: id != null && !query.isLoading && (isMissing || (!err && query.data == null)),
  };
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateRequests() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/**
 * Kreiraj zahtev za nabavku (zaglavlje + stavke) — POST /nabavka/requests.
 * Broj „NNNN/god" generiše server; status kreće od DRAFT. Backend validira ulaz
 * (400 sa srpskim porukama iz `validateCreatePurchaseRequest`) i predmet (404 ako
 * ne postoji). Permisija NABAVKA_WRITE.
 */
export function useCreateRequest() {
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: (input: CreatePurchaseRequestInput) =>
      apiFetch<Envelope<PurchaseRequest>>(`${BASE}/requests`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Predaj zahtev na odobrenje (DRAFT → SUBMITTED) — POST /nabavka/requests/:id/submit.
 * Backend vraća 422 za nedozvoljen tekući status. Permisija NABAVKA_WRITE.
 */
export function useSubmitRequest() {
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Envelope<PurchaseRequest>>(`${BASE}/requests/${id}/submit`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Odobri zahtev (SUBMITTED → APPROVED) — POST /nabavka/requests/:id/approve.
 * Odobrava nabavka → posebna permisija NABAVKA_APPROVE (operativni tok, Nenad).
 * 422 za nedozvoljen tekući status.
 */
export function useApproveRequest() {
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Envelope<PurchaseRequest>>(`${BASE}/requests/${id}/approve`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/** Rezultat slanja upita — upit + da li je auto-mail stvarno poslat (DRY-RUN bez ključa). */
export interface SendRfqResult {
  rfq: { id: number; rfqNumber: string; status: string; sentAt: string | null };
  emailSent: boolean;
}

/**
 * Napravi upit dobavljaču iz odobrenog zahteva i pošalji auto-mail — POST
 * /nabavka/requests/:id/send-rfq { supplierId, supplierEmail }. Uzima samo stavke
 * sa `createRfq=true` (KreirajUpit). Slanje NIKAD ne obara radnju: bez
 * RESEND_API_KEY je DRY-RUN (upit ostaje DRAFT, `emailSent=false`). 422 ako zahtev
 * nije APPROVED ili nema stavki za upit. Permisija NABAVKA_WRITE.
 */
export function useSendRfq() {
  const invalidate = useInvalidateRequests();
  return useMutation({
    mutationFn: ({
      id,
      supplierId,
      supplierEmail,
    }: {
      id: number;
      supplierId: number;
      supplierEmail: string;
    }) =>
      apiFetch<Envelope<SendRfqResult>>(`${BASE}/requests/${id}/send-rfq`, {
        method: 'POST',
        body: JSON.stringify({ supplierId, supplierEmail }),
      }),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────────────────────────────────── prijem robe

/** Jedna linija prijema — `receivedQuantity` opciono (default = naručeno na backendu). */
export interface ReceiveOrderLineInput {
  itemId: number;
  receivedQuantity?: number;
}

/**
 * Prijem robe po narudžbenici (3-way match) — POST /nabavka/orders/:id/receive
 * { lines: [{ itemId, receivedQuantity? }] }. Za svaku stavku bez eksplicitne
 * količine backend uzima naručenu (`orderedQuantity`, BigBit „IsporucenaKolicina").
 * Narudžbenica prelazi u RECEIVED. Backend vraća 409 ako je već primljena/zatvorena,
 * 422 ako još nije poručena. Menja narudžbenice (status/količine), pa invalidira
 * ceo `nabavka` ključ. Permisija NABAVKA_WRITE.
 */
export function useReceiveOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, lines }: { orderId: number; lines: ReceiveOrderLineInput[] }) =>
      apiFetch<Envelope<PurchaseOrder>>(`${BASE}/orders/${orderId}/receive`, {
        method: 'POST',
        body: JSON.stringify({ lines }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

// ─────────────────────────────────── narudžbenice: kreiranje + status (BigBit paritet)

/** Stavka nove narudžbenice — 1:1 sa backend create-purchase-order.dto. */
export interface CreateOrderItemInput {
  articleId?: number | null;
  description?: string | null;
  orderedQuantity: number;
  unitPrice?: number | null;
  unit?: string | null;
  rfqItemId?: number | null;
  requestItemId?: number | null;
}

export interface CreateOrderInput {
  supplierId: number;
  rfqId?: number | null;
  projectId?: number | null;
  currency?: string;
  note?: string | null;
  items: CreateOrderItemInput[];
}

/** Pregled narudžbenica (GET /nabavka/orders). */
export function usePurchaseOrders(filters: { status?: string; supplierId?: number; skip?: number; take?: number } = {}) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.supplierId != null) params.set('supplierId', String(filters.supplierId));
  if (filters.skip != null) params.set('skip', String(filters.skip));
  if (filters.take != null) params.set('take', String(filters.take));
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['nabavka', 'orders', filters],
    queryFn: () => apiFetch<PaginatedTotal<PurchaseOrder>>(`${BASE}/orders${query}`),
  });
}

/** Kreiraj narudžbenicu (POST /nabavka/orders) — status ORDERED, broj NNNN/god. */
export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrderInput) =>
      apiFetch<Envelope<PurchaseOrder>>(`${BASE}/orders`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

// ────────────────────────────────── 3-way match: detalj narudžbenice + pregled

/**
 * Poređenje naručeno/primljeno/fakturisano za jednu narudžbenicu —
 * GET /nabavka/orders/:id/match. `enabled` gasi upit dok id nije poznat
 * (npr. dok red nije razvijen u listi narudžbenica).
 *
 * ⚠️ Rezultat je informativan: nalazi se PRIKAZUJU, ne blokiraju nijednu akciju.
 * Permisija NABAVKA_READ (klasna na kontroleru).
 */
export function useOrderMatch(orderId: number | null) {
  return useQuery({
    queryKey: [...KEYS.match, 'order', orderId],
    queryFn: () =>
      apiFetch<Envelope<ThreeWayMatchResult>>(`${BASE}/orders/${orderId}/match`),
    enabled: orderId != null,
    staleTime: 15_000,
  });
}

/**
 * Pregled 3-way match-a po više narudžbenica (lista/izveštaj) —
 * GET /nabavka/match-summary. `onlyWithFindings=true` vraća samo narudžbenice
 * sa bar jednim nalazom. Permisija NABAVKA_READ.
 */
export function useMatchSummary(filters: MatchSummaryFilters = {}, enabled = true) {
  const query = buildQuery({
    from: filters.from,
    to: filters.to,
    supplierId: filters.supplierId,
    onlyWithFindings: filters.onlyWithFindings ? 'true' : undefined,
    skip: filters.skip,
    take: filters.take,
  });
  return useQuery({
    queryKey: [...KEYS.match, 'summary', filters],
    queryFn: () => apiFetch<MatchSummaryResponse>(`${BASE}/match-summary${query}`),
    enabled,
  });
}

/** Status prelaz narudžbenice: sign (ORDERED→SIGNED) ili lock (→LOCKED). */
export function usePurchaseOrderTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'sign' | 'lock' }) =>
      apiFetch<Envelope<PurchaseOrder>>(`${BASE}/orders/${id}/${action}`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

// ─────────────────────────────────── upiti (RFQ): lista / detalj / prihvatanje

/**
 * Status upita dobavljaču (`supplier_rfqs.status`) — 1:1 sa backend šemom.
 * Mapiranje na kanonske tonove radi UI (rfq-panel `rfqStatusMeta`).
 */
export const SUPPLIER_RFQ_STATUS = {
  DRAFT: 'DRAFT', // U pripremi (kreiran, nije poslat / DRY-RUN)
  SENT: 'SENT', // Poslat dobavljaču (auto-mail sentAt)
  QUOTED: 'QUOTED', // Ponuda prihvaćena (isAccepted na stavkama)
  CLOSED: 'CLOSED', // Zatvoren
} as const;

/** Red liste upita — GET /nabavka/rfqs (dobavljač enrich + broj stavki). */
export interface SupplierRfqListRow extends SupplierRfq {
  /** Naziv dobavljača (meki ref na šifarnik komitenata); null ako je obrisan. */
  supplierName: string | null;
  _count: { items: number };
}

/** Detalj upita — GET /nabavka/rfqs/:id (zaglavlje + stavke + dobavljač). */
export interface SupplierRfqDetail extends SupplierRfq {
  items: SupplierRfqItem[];
  supplier: { id: number; name: string; city: string | null; taxId: string | null } | null;
}

/** Jedna stavka prihvatanja ponude — cena/rok su opcioni po stavci. */
export interface AcceptQuoteLineInput {
  rfqItemId: number;
  offeredPrice?: number;
  offeredLeadTimeDays?: number;
}

/** Rezultat prihvatanja: ažuriran upit + createOrderDraft za narudžbenicu. */
export interface AcceptQuoteResult {
  rfq: SupplierRfq & { items: SupplierRfqItem[] };
  /** Spreman ulaz za `useCreateOrder` (cena → unitPrice; predmet nasleđen). */
  createOrderDraft: CreateOrderInput;
}

/** Lista upita dobavljačima (GET /nabavka/rfqs) — filter status/dobavljač. */
export function useSupplierRfqs(
  filters: { status?: string; supplierId?: number; skip?: number; take?: number } = {},
) {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.supplierId != null) params.set('supplierId', String(filters.supplierId));
  if (filters.skip != null) params.set('skip', String(filters.skip));
  if (filters.take != null) params.set('take', String(filters.take));
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: [...KEYS.rfqs, filters],
    queryFn: () => apiFetch<PaginatedTotal<SupplierRfqListRow>>(`${BASE}/rfqs${query}`),
  });
}

/** Detalj upita sa stavkama (GET /nabavka/rfqs/:id). `enabled` dok id nije poznat. */
export function useSupplierRfq(id: number | null) {
  return useQuery({
    queryKey: [...KEYS.rfqs, 'detail', id],
    queryFn: () => apiFetch<Envelope<SupplierRfqDetail>>(`${BASE}/rfqs/${id}`),
    enabled: id != null,
  });
}

/**
 * Prihvati ponudu po upitu — POST /nabavka/rfqs/:id/accept { items }. Upisuje rok
 * isporuke + `isAccepted` na stavke, upit → QUOTED. Cena se NE drži na upitu
 * (BigBit pravilo) — vraća se u `createOrderDraft` za sledeći korak (narudžbenica).
 * Backend vraća 409 ako je ponuda već prihvaćena. Permisija NABAVKA_WRITE.
 */
export function useAcceptQuote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, items }: { id: number; items: AcceptQuoteLineInput[] }) =>
      apiFetch<Envelope<AcceptQuoteResult>>(`${BASE}/rfqs/${id}/accept`, {
        method: 'POST',
        body: JSON.stringify({ items }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

// ─────────────────────────────────────────────────────────────── štampa (PDF)
//
// Sve štampe modula idu kroz JWT-zaštićene GET rute koje vraćaju `application/pdf`
// inline, pa se povlače kroz `apiBlob` (Authorization header) i otvaraju
// `openPdf`-om u novom tabu. Permisija je NABAVKA_READ (klasna na kontroleru) —
// ko vidi dokument, sme i da ga odštampa.

/** Otvori PDF Blob u novom tabu (pregled u browseru + preuzimanje). */
export { openPdf } from '@/lib/open-pdf';

/**
 * Štampa upita za ponudu — GET /nabavka/rfqs/:id/pdf. Opcioni `deadline` (ISO
 * datum) ispisuje rok za dostavu ponude na dokumentu.
 */
export function useRfqPdf() {
  return useMutation({
    mutationFn: ({ id, deadline }: { id: number; deadline?: string }) =>
      apiBlob(`${BASE}/rfqs/${id}/pdf${buildQuery({ deadline })}`),
  });
}

/**
 * Štampa narudžbenice dobavljaču — GET /nabavka/orders/:id/pdf.
 * `variant: 'bezCena'` daje primerak za magacin (bez cena i iznosa).
 */
export function usePurchaseOrderPdf() {
  return useMutation({
    mutationFn: ({ id, variant }: { id: number; variant?: 'bezCena' }) =>
      apiBlob(`${BASE}/orders/${id}/pdf${buildQuery({ variant })}`),
  });
}

/** Štampa poređenja naručeno/primljeno/fakturisano — GET /nabavka/orders/:id/match/pdf. */
export function useOrderMatchPdf() {
  return useMutation({
    mutationFn: (id: number) => apiBlob(`${BASE}/orders/${id}/match/pdf`),
  });
}

/**
 * Štampa pregleda odstupanja — GET /nabavka/match-summary/pdf. Prima ISTE filtere
 * kao ekran; `skip` se namerno ne šalje (izveštaj pokriva period, ne stranu ekrana).
 */
export function useMatchSummaryPdf() {
  return useMutation({
    mutationFn: (filters: MatchSummaryFilters = {}) =>
      apiBlob(
        `${BASE}/match-summary/pdf${buildQuery({
          from: filters.from,
          to: filters.to,
          supplierId: filters.supplierId,
          onlyWithFindings: filters.onlyWithFindings ? 'true' : undefined,
          take: filters.take,
        })}`,
      ),
  });
}

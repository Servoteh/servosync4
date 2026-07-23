'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * SEF e-fakture (izlazne) — data sloj (Faza 5 §B). TanStack Query hooks nad NestJS
 * `/api/v1/sef/*`. Tipovi 1:1 sa backend modelima:
 *   backend/src/modules/sales/sef/sef.controller.ts (rute, RBAC)
 *   backend/src/modules/sales/sef/sef.service.ts     (status-mašina, envelope)
 *   Prisma SefOutbox                                  (polja)
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 *
 * VAŽNO (envelope): `GET /sef/outbox` vraća GOL `{ data: SefOutbox[] }` — bez
 * `meta` (paginira preko `skip`/`take`, NE `page`/`pageSize` kao robno, i NE vraća
 * `total`). Zato paginacija radi „ima li još": strana je puna → verovatno postoji
 * sledeća. Mutacije (enqueue/send/refresh/cancel) vraćaju `{ data: SefOutbox }`.
 * `createdAt`/`sentAt`/`statusPolledAt` su ISO stringovi; Decimal polja ovde nema.
 */

const BASE = '/v1/sef';

// ─────────────────────────────────────────────────────────────── status-mašina

/**
 * Status SEF outbox reda (`sef_outbox.status`) — 1:1 sa backend servisom.
 * PENDING (enqueue) → SENT (poslato na SEF) → DELIVERED (primalac video/odobrio);
 * REJECTED (odbijeno/greška), CANCELLED (storno). Ulaze u kanonsku mapu statusa
 * (DESIGN_SYSTEM §7) kao SEF domen. Vrednosti su stringovi (BACKEND_RULES §2).
 */
export const SEF_STATUS = {
  PENDING: 'PENDING', // U redu — UBL sagrađen, čeka slanje
  SENT: 'SENT', // Poslato na SEF (sefInvoiceId dodeljen)
  DELIVERED: 'DELIVERED', // Isporučeno/viđeno/odobreno kod primaoca
  REJECTED: 'REJECTED', // Odbijeno (greška ili primalac odbio)
  CANCELLED: 'CANCELLED', // Stornirano/otkazano
} as const;

export type SefStatus = (typeof SEF_STATUS)[keyof typeof SEF_STATUS];

/** Statusi iz kojih je storno/otkazivanje dozvoljeno — 1:1 sa backend CANCELLABLE_LOCAL_STATUSES. */
const CANCELLABLE = new Set<SefStatus>([SEF_STATUS.PENDING, SEF_STATUS.SENT, SEF_STATUS.DELIVERED]);

/** True ako outbox u datom statusu sme da se stornira (guard-uslovljena afordansa). */
export function canCancel(status: string): boolean {
  return CANCELLABLE.has(status as SefStatus);
}

/** True ako outbox u datom statusu sme da se (ponovo) pošalje na SEF (nije otkazan). */
export function canSend(status: string): boolean {
  return status !== SEF_STATUS.CANCELLED;
}

// ─────────────────────────────────────────────────────────────── envelope tipovi

/** Ne-paginirani odgovor domenskog endpointa (`{ data }`). */
export interface Envelope<T> {
  data: T;
}

/**
 * Red SEF outbox-a (`sef_outbox`) — 1:1 sa Prisma modelom. `ublXml` i
 * `pdfAttachmentBase64` su velika tela (ne prikazuju se u listi), ostavljena
 * opciono radi vernosti tipa.
 */
export interface SefOutbox {
  id: number;
  invoiceId: number;
  /** UBL RequestID — idempotencija slanja. */
  requestId: string;
  ublXml?: string | null;
  status: SefStatus;
  /** SalesInvoiceId vraćen od SEF-a (posle slanja). */
  sefInvoiceId: string | null;
  pdfAttachmentBase64?: string | null;
  /** ResponseText / greška poslednjeg poziva. */
  errorMessage: string | null;
  sentAt: string | null;
  statusPolledAt: string | null;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['sef'] as const,
  outbox: ['sef', 'outbox'] as const,
};

// ─────────────────────────────────────────────────────────────── filteri

export interface SefFilters {
  status?: SefStatus | '';
  invoiceId?: number | '';
  /** Preskoči N redova (server-side, skip/take model). */
  skip?: number;
  /** Veličina strane (backend clamp 1..200, default 50). */
  take?: number;
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
 * Lista SEF outbox-a (filter po statusu / invoiceId, server-side skip/take).
 * Vraća GOL `{ data: SefOutbox[] }` (bez `total`) — UI izvodi „ima li sledeća"
 * iz toga da li je stigla puna strana. `take` podrazumevano 50.
 */
export function useSefOutbox(filters: SefFilters = {}) {
  const take = filters.take && filters.take > 0 ? filters.take : 50;
  const skip = filters.skip && filters.skip > 0 ? filters.skip : 0;
  const query = buildQuery({
    status: filters.status === '' ? undefined : filters.status,
    invoiceId: filters.invoiceId === '' ? undefined : filters.invoiceId,
    skip: skip > 0 ? skip : undefined,
    take: take !== 50 ? take : undefined,
  });
  return useQuery({
    queryKey: [...KEYS.outbox, filters],
    queryFn: () => apiFetch<Envelope<SefOutbox[]>>(`${BASE}/outbox${query}`),
  });
}

/**
 * SEF outbox redovi za JEDNU fakturu — status-prikaz na detalju fakture
 * (fakturisanje/[id]). Odvojen keš-ključ od radne liste da paginacija liste ne
 * meša ovaj pogled. Rezultat je sortiran po `id` desc (najnoviji red = `data[0]`).
 * `enabled` gasi upit dok faktura nije poznata / korisnik nema SEF_READ.
 */
export function useSefOutboxForInvoice(invoiceId: number | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.outbox, 'invoice', invoiceId],
    queryFn: () =>
      apiFetch<Envelope<SefOutbox[]>>(
        `${BASE}/outbox${buildQuery({ invoiceId: invoiceId ?? undefined })}`,
      ),
    enabled: enabled && invoiceId != null,
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateSef() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/**
 * Enqueue — sagradi UBL + kreiraj outbox red (PENDING) za fakturu.
 * POST /sef/enqueue/:invoiceId. Permisija SEF_SEND. Odbija izvoz/draft (BadRequest).
 */
export function useEnqueue() {
  const invalidate = useInvalidateSef();
  return useMutation({
    mutationFn: (invoiceId: number) =>
      apiFetch<Envelope<SefOutbox>>(`${BASE}/enqueue/${invoiceId}`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Pošalji UBL na SEF (idempotencija po requestId). POST /sef/send/:outboxId.
 * Uspeh: PENDING → SENT (+ sefInvoiceId). Mrežna greška: ostaje PENDING + errorMessage.
 * Permisija SEF_SEND.
 */
export function useSend() {
  const invalidate = useInvalidateSef();
  return useMutation({
    mutationFn: (outboxId: number) =>
      apiFetch<Envelope<SefOutbox>>(`${BASE}/send/${outboxId}`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Osveži status sa SEF-a (polling; mapira SEF status u lokalni).
 * POST /sef/refresh/:outboxId. Permisija SEF_READ.
 */
export function useRefresh() {
  const invalidate = useInvalidateSef();
  return useMutation({
    mutationFn: (outboxId: number) =>
      apiFetch<Envelope<SefOutbox>>(`${BASE}/refresh/${outboxId}`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Storno/otkazivanje na SEF-u. POST /sef/cancel/:outboxId. GUARD: dozvoljeno samo
 * iz PENDING/SENT/DELIVERED (REJECTED/CANCELLED → 409 Conflict). Permisija SEF_CANCEL.
 */
export function useCancel() {
  const invalidate = useInvalidateSef();
  return useMutation({
    mutationFn: (outboxId: number) =>
      apiFetch<Envelope<SefOutbox>>(`${BASE}/cancel/${outboxId}`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

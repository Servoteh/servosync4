'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';

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
 * Odgovor enqueue-a: outbox red + eventualno ne-blokirajuće upozorenje
 * (npr. javni sektor bez broja narudžbenice, D6). `warning` je null kad ga nema.
 */
export interface EnqueueResponse extends Envelope<SefOutbox> {
  warning?: string | null;
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
  incoming: ['sef', 'incoming'] as const,
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
 * (fakturisanje/detalj?id=N). Odvojen keš-ključ od radne liste da paginacija liste ne
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
      apiFetch<EnqueueResponse>(`${BASE}/enqueue/${invoiceId}`, {
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

// ═══════════════════════════════════════════════════════════ SEF ULAZNE (inbox)
//
// Ulazne (dobavljačke) e-fakture preuzete sa SEF-a — Talas 1E stavka E1
// (docs/PLAN_TALAS_1C-1E §3, odluka O3). Odvojen keš-podprostor `['sef','incoming']`
// od outbox-a (izlazne), ali deli `['sef']` prefiks za invalidaciju. Backend ugovor:
//   GET  /api/v1/sef/incoming            — lista (filter status)      → { data: SefIncoming[] }
//   POST /api/v1/sef/incoming/pull       — sinhronizacija sa SEF-a    → { data: PullSummary }
//   POST /api/v1/sef/incoming/:id/accept — prihvatanje (odgovor SEF-u)→ { data: SefIncoming }
//   POST /api/v1/sef/incoming/:id/reject — odbijanje sa razlogom      → { data: SefIncoming }
//
// RBAC (paralela izlaznog toka): pregled + pull = SEF_READ (kao poll/refresh);
// accept = SEF_SEND (afirmativni odgovor SEF-u, kao slanje); reject = SEF_CANCEL
// (negativni odgovor sa obaveznim razlogom, kao storno). Backend presuđuje.

/**
 * Status ulazne fakture (`sef_incoming.status`). NEW (netaknuta, tek preuzeta) →
 * SEEN (pregledana, čeka odluku) → ACCEPTED / REJECTED (terminalno). Vrednosti su
 * stringovi (BACKEND_RULES §2).
 */
export const SEF_INCOMING_STATUS = {
  NEW: 'NEW', // Preuzeta sa SEF-a, još nije pregledana
  SEEN: 'SEEN', // Pregledana, čeka prihvatanje/odbijanje
  ACCEPTED: 'ACCEPTED', // Prihvaćena (odgovor poslat SEF-u)
  REJECTED: 'REJECTED', // Odbijena (razlog upisan, odgovor poslat SEF-u)
} as const;

export type SefIncomingStatus = (typeof SEF_INCOMING_STATUS)[keyof typeof SEF_INCOMING_STATUS];

/** Statusi iz kojih je odluka (prihvati/odbij) još moguća — terminalni se ne diraju. */
const INCOMING_ACTIONABLE = new Set<SefIncomingStatus>([
  SEF_INCOMING_STATUS.NEW,
  SEF_INCOMING_STATUS.SEEN,
]);

/** True ako ulazna faktura u datom statusu sme da se prihvati/odbije (guard-afordansa). */
export function canDecideIncoming(status: string): boolean {
  return INCOMING_ACTIONABLE.has(status as SefIncomingStatus);
}

/**
 * Ulazna (dobavljačka) e-faktura preuzeta sa SEF-a — 1:1 sa backend modelom.
 * `totalAmount`/`vatAmount` su Decimal-as-string (BACKEND_RULES §6) → `formatDecimal`.
 * `daysLeft` = preostalo dana do `acceptDeadline` (zakonski rok 15 dana; negativno =
 * istekao). `alreadyExists` = dedup protiv KUF evidencije (BigBit paritet, odluka O3):
 * faktura je već proknjižena — `matchedKufEntryId` pokazuje na tu stavku.
 */
export interface SefIncoming {
  id: number;
  /** SEF PurchaseInvoiceId — idempotencija preuzimanja. */
  sefPurchaseId: string;
  supplierPib: string;
  supplierName: string;
  invoiceNumber: string;
  issueDate: string;
  /**
   * Datum PRIJEMA fakture na SEF (osnov roka od 15 dana). Do 02.08.2026. se zvao
   * `deliveryDate` — preimenovan zajedno sa kolonom, jer to ime u ostatku sistema
   * znači „datum prometa" (Invoice.deliveryDate), što je suprotan pojam.
   */
  sefReceivedAt: string | null;
  totalAmount: string;
  vatAmount: string;
  currency: string;
  status: SefIncomingStatus;
  acceptDeadline: string | null;
  daysLeft: number | null;
  /** Faktura je već u KUF evidenciji (dedup) — akcije treba upozoriti. */
  alreadyExists: boolean;
  matchedKufEntryId: number | null;
  rejectComment: string | null;
}

/**
 * Rezultat sinhronizacije sa SEF-a — 1:1 sa backend `PullSummary` (sef-incoming.service).
 * `dryRun` = probni prolaz (ništa nije sačuvano; `note` nosi razlog). `totalIds` = koliko
 * je ID-jeva vraćeno sa SEF-a, `created` = koliko novih redova upisano, `skipped` = već
 * postojali (idempotencija), `failed` = XML/parse nije uspeo (preskočeno, ne obara pull).
 */
export interface PullIncomingResult {
  dryRun: boolean;
  totalIds: number;
  created: number;
  skipped: number;
  failed: number;
  note?: string;
}

export interface SefIncomingFilters {
  status?: SefIncomingStatus | '';
}

/**
 * Lista ulaznih e-faktura (filter po statusu). Vraća GOL `{ data: SefIncoming[] }`
 * (bez `meta`/`total`) — isti oblik kao outbox lista.
 */
export function useSefIncoming(filters: SefIncomingFilters = {}) {
  const query = buildQuery({
    status: filters.status === '' ? undefined : filters.status,
  });
  return useQuery({
    queryKey: [...KEYS.incoming, filters],
    queryFn: () => apiFetch<Envelope<SefIncoming[]>>(`${BASE}/incoming${query}`),
  });
}

/**
 * Preuzmi (pull) nove ulazne fakture sa SEF-a. POST /sef/incoming/pull. Permisija
 * SEF_READ (sinhronizacija, kao poll statusa). Odgovor nosi broj preuzetih i eventualnu
 * DRY-RUN naznaku. Invalidira ceo `['sef']` prefiks.
 */
export function usePullIncoming() {
  const invalidate = useInvalidateSef();
  return useMutation({
    mutationFn: () =>
      apiFetch<Envelope<PullIncomingResult>>(`${BASE}/incoming/pull`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Prihvati ulaznu fakturu (afirmativni odgovor SEF-u). POST /sef/incoming/:id/accept.
 * Permisija SEF_SEND. NEW/SEEN → ACCEPTED. Invalidira `['sef']` prefiks.
 */
export function useAcceptIncoming() {
  const invalidate = useInvalidateSef();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Envelope<SefIncoming>>(`${BASE}/incoming/${id}/accept`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Odbij ulaznu fakturu sa obaveznim razlogom. POST /sef/incoming/:id/reject { comment }.
 * Permisija SEF_CANCEL. NEW/SEEN → REJECTED. Invalidira `['sef']` prefiks.
 */
export function useRejectIncoming() {
  const invalidate = useInvalidateSef();
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment: string }) =>
      apiFetch<Envelope<SefIncoming>>(`${BASE}/incoming/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ comment }),
      }),
    onSuccess: invalidate,
  });
}

// ═══════════════════════════════════════════════════════ SEF STATUS-ISTORIJA (T3/A8)
//
// Append-only istorija status-toka jednog SEF reda — izlaznog (outbox) ili ulaznog
// (incoming). Puni je backend (enqueue/send/refresh/cancel i pull/accept/reject).
// FE je čita za timeline prikaz na /sef (dugme „Istorija" po redu). Deli `['sef']`
// prefiks pa se invalidira zajedno sa svakom SEF mutacijom.

/**
 * Zapis SEF status-istorije (`sef_status_log`) — 1:1 sa backend modelom. `status` je
 * događaj/status (PENDING, SENT, DELIVERED, REJECTED, CANCELLED, DRY_RUN, ERROR, NEW,
 * ACCEPTED…), `note` slobodan detalj (SEF poruka, razlog, DRY-RUN), `userId` ko je
 * izazvao (null = sistem/poll). `createdAt` ISO string.
 */
export interface SefStatusLogEntry {
  id: number;
  outboxId: number | null;
  incomingId: number | null;
  status: string;
  note: string | null;
  userId: number | null;
  createdAt: string;
}

/**
 * Status-istorija (timeline) jednog SEF reda — prosledi `outboxId` (izlazni) ILI
 * `incomingId` (ulazni). GET /sef/status-log. Hronološki (najstariji prvo). Permisija
 * SEF_READ. `enabled` gasi upit dok red nije poznat (npr. dijalog zatvoren).
 */
export function useSefStatusLog(
  ref: { outboxId?: number | null; incomingId?: number | null },
  enabled = true,
) {
  const outboxId = ref.outboxId ?? undefined;
  const incomingId = ref.incomingId ?? undefined;
  const query = buildQuery({ outboxId, incomingId });
  return useQuery({
    queryKey: [...KEYS.all, 'status-log', outboxId ?? null, incomingId ?? null],
    queryFn: () =>
      apiFetch<Envelope<SefStatusLogEntry[]>>(`${BASE}/status-log${query}`),
    enabled: enabled && (outboxId != null || incomingId != null),
  });
}

// ─────────────────────────────────────────────────────────── štampa e-faktura (PDF)
//
// Ljudski čitljiv prikaz UBL dokumenta: ono što je STVARNO poslato na SEF (izlazna)
// odnosno primljeno sa SEF-a (ulazna). Do sada se poslati dokument mogao videti samo
// kao XML u bazi. Rute vraćaju `application/pdf` inline; permisija SEF_READ.

/** Otvori PDF Blob u novom tabu (pregled u browseru + preuzimanje). */
export { openPdf } from '@/lib/open-pdf';

/** Štampa izlazne e-fakture (prikaz UBL-a) — GET /sef/outbox/:id/pdf. */
export function useSefOutboxPdf() {
  return useMutation({
    mutationFn: (outboxId: number) => apiBlob(`${BASE}/outbox/${outboxId}/pdf`),
  });
}

/** Štampa ulazne e-fakture (prikaz UBL-a + rok od 15 dana) — GET /sef/incoming/:id/pdf. */
export function useSefIncomingPdf() {
  return useMutation({
    mutationFn: (incomingId: number) => apiBlob(`${BASE}/incoming/${incomingId}/pdf`),
  });
}

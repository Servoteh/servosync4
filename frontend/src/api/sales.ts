'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiBlob } from './client';

/**
 * Sales / Fakturisanje — data sloj (Faza 5 §A). TanStack Query hooks nad NestJS
 * `/api/v1/sales/*`. Tipovi 1:1 sa backend modelima:
 *   backend/src/modules/sales/sales.controller.ts        (rute)
 *   backend/src/modules/sales/fakturisanje.service.ts    (envelope, status-mašina)
 *   Prisma Invoice / InvoiceItem                          (polja)
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 *
 * VAŽNO (envelope): lista računa paginira preko `skip`/`take` (NE page/pageSize kao
 * robno) i vraća `{ data, meta: { total, skip, take } }`. Detalj i mutacije vraćaju
 * SIROV Invoice objekat (bez `{ data }` omotača — servis ne obmotava). Decimal polja
 * stižu kao string (BACKEND_RULES §6) — formatDecimal na prikazu.
 */

const BASE = '/v1/sales';

// ─────────────────────────────────────────────────────────────── status + tip

/**
 * Status računa (`invoices.status`) — 1:1 sa backend servisom. DRAFT (predračun /
 * pre knjiženja) → POSTED (proknjižen, definitivan broj + nalog GK); SENT (poslat
 * kupcu/SEF), PAID (plaćen), CANCELLED (storniran). Ulaze u kanonsku mapu statusa
 * (DESIGN_SYSTEM §7) kao SALES domen.
 */
export const SALES_STATUS = {
  DRAFT: 'DRAFT', // U pripremi — predračun ili račun pre knjiženja
  POSTED: 'POSTED', // Proknjižen — rezervisan broj + nalog u glavnoj knjizi
  SENT: 'SENT', // Poslat — kupcu / na SEF
  PAID: 'PAID', // Plaćen — zatvorena stavka
  CANCELLED: 'CANCELLED', // Storniran / otkazan
} as const;

export type SalesStatus = (typeof SALES_STATUS)[keyof typeof SALES_STATUS];

/**
 * Vrsta dokumenta (`invoices.document_type`) — 1:1 sa backend `documentType`.
 * PON/PROF = draft predračun/ponuda (level 250); IFR/IFGP/IFUSL = domaći račun
 * (level 0); IZVRO/IZVGP/IZVUS = izvoz; AVR = avansni; REV = revers.
 */
export const SALES_DOCUMENT_TYPE = {
  PON: 'PON', // Ponuda (draft)
  PROF: 'PROF', // Predračun (draft)
  IFR: 'IFR', // Izlazni račun — roba
  IFGP: 'IFGP', // Izlazni račun — gotov proizvod
  IFUSL: 'IFUSL', // Izlazni račun — usluga
  IZVRO: 'IZVRO', // Izvozni račun — roba
  IZVGP: 'IZVGP', // Izvozni račun — gotov proizvod
  IZVUS: 'IZVUS', // Izvozni račun — usluga
  AVR: 'AVR', // Avansni račun
  REV: 'REV', // Revers
} as const;

export type SalesDocumentType =
  (typeof SALES_DOCUMENT_TYPE)[keyof typeof SALES_DOCUMENT_TYPE];

// ─────────────────────────────────────────────────────────────── envelope tipovi

/** Paginirani odgovor liste računa — backend šalje `meta: { total, skip, take }`. */
export interface SalesListResponse<T> {
  data: T[];
  meta: {
    total: number;
    skip: number;
    take: number;
  };
}

// ─────────────────────────────────────────────────────────────── entiteti

/**
 * Stavka izlaznog računa (`invoice_items`) — Decimal polja kao string
 * (BACKEND_RULES §6). `unitPrice` = transakciona VP (PricingService); `vatBase` =
 * osnovica posle rabata/kase; `lineTotal` = osnovica + PDV.
 */
export interface InvoiceItem {
  id: number;
  invoiceId: number;
  lineNo: number;
  itemId: number | null;
  description: string | null;
  /** Decimal-as-string. */
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  cashDiscountPercent: string;
  vatRateCode: string;
  vatBase: string;
  vatAmount: string;
  lineTotal: string;
  copiedFromItemId: number | null;
}

/** Red radne liste računa — GET /sales/invoices (zaglavlje bez stavki). */
export interface Invoice {
  id: number;
  documentType: SalesDocumentType | string;
  documentNumber: string;
  /** 250 = draft/predračun; 0 = knjižen račun. */
  level: number;
  companyId: number;
  customerId: number | null;
  documentDate: string;
  dueDate: string | null;
  currency: string;
  /** Zbirni iznosi (Decimal-as-string, denormalizovano iz stavki). */
  netTotal: string;
  vatTotal: string;
  grossTotal: string;
  status: SalesStatus | string;
  isExport: boolean;
  /** Broj narudžbenice kupca → UBL cac:OrderReference (SEF javni sektor, D6). */
  poNumber: string | null;
  /** Tehnička brava proknjiženog dokumenta (D8): true → izmene/storno blokirani. */
  isLocked: boolean;
  journalEntryId: number | null;
  stockDocumentId: number | null;
  salespersonId: number | null;
  workOrderId: number | null;
  linkedInvoiceDocId: number | null;
  copiedFromDocId: number | null;
  note: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * VRSTA USLUGE — red šifarnika `service_revenue_types` (05.08.2026).
 *
 * Komercijala sa ove liste bira ŠTA PRODAJE; konto prihoda i poreski tretman stižu uz
 * taj izbor i NE biraju se posebno. Zato `revenueAccountCode` postoji u tipu (koristi
 * ga knjigovođa u Podešavanjima), ali se komercijali NE prikazuje — v.
 * `backend/src/modules/sales/service-revenue-type.ts`.
 */
export interface ServiceRevenueType {
  id: number;
  /** USL | USL-INO | OTPAD | ZAKUP (šifarnik uređuje knjigovođa). */
  code: string;
  /** Naziv za padajuću listu, npr. „Prodaja otpada". */
  name: string;
  /** Konto prihoda (6140 / 6151 / 6796 / 6501…) — informativno, ne za izbor. */
  revenueAccountCode: string;
  /** TAXED | REVERSE_CHARGE | OUTSIDE_SCOPE — ko obračunava PDV. */
  vatTreatment: string;
  /** Napomena koja izlazi na papir; `null` = vrsta je nema. */
  paperNote: string | null;
  sortOrder: number;
}

/**
 * Jedan red šifarnika osnova poreskog oslobođenja (`vat_exemption_bases`).
 *
 * Osnov određuje TRI stvari: tekst na papiru, šifru na e-fakturi i to da li dokument
 * uopšte ide na SEF. Poslednje je jedini način da se razlikuju izvoz (čl. 24 st. 1 t. 2,
 * NE ide na SEF) i unos u slobodnu zonu (t. 5, IDE) — na dokumentu su identični.
 */
export interface VatExemptionBasis {
  id: number;
  code: string;
  name: string;
  /** Doslovan tekst koji izlazi na papir — prikazuje se kao pomoć pri izboru. */
  paperText: string;
  /** `PDV-RS-…`; `null` = šifra za taj osnov nije utvrđena (čl. 12 st. 3). */
  sefCode: string | null;
  /** Da li dokument sa ovim osnovom ide na SEF. */
  goesToSef: boolean;
  sortOrder: number;
}

/** Detalj računa — zaglavlje + stavke (GET /sales/invoices/:id). */
export interface InvoiceDetail extends Invoice {
  items: InvoiceItem[];
  /**
   * Izabrana vrsta usluge (`invoices.service_revenue_type_id`); `null` = nije izabrana,
   * pa važi zatečeno ponašanje (konto 6140, PDV po stopi stavke).
   */
  serviceRevenueTypeId?: number | null;
  /**
   * Izabran osnov oslobođenja (`invoices.vat_exemption_basis_id`); `null` = nije izabran,
   * pa se osnov izvodi iz dokumenta kao dosad.
   */
  vatExemptionBasisId?: number | null;
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['sales'] as const,
  invoices: ['sales', 'invoices'] as const,
  invoice: (id: number) => ['sales', 'invoices', id] as const,
};

// ─────────────────────────────────────────────────────────────── filteri

export interface InvoiceFilters {
  /** 1-bazna strana (UI); prevodi se u `skip`/`take`. */
  page?: number;
  /** Veličina strane (backend default 50, max 200). */
  pageSize?: number;
  documentType?: SalesDocumentType | '';
  status?: SalesStatus | '';
  level?: number | '';
  customerId?: number | '';
  isExport?: boolean;
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
 * Radna lista računa (filter po tipu/statusu/nivou/kupcu/izvozu, server-side
 * paginacija preko `skip`/`take`). Vraća `{ data, meta: { total, skip, take } }`.
 * `pageSize` podrazumevano 50.
 */
export function useInvoices(filters: InvoiceFilters = {}) {
  const pageSize = filters.pageSize && filters.pageSize > 0 ? filters.pageSize : 50;
  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const skip = (page - 1) * pageSize;
  const query = buildQuery({
    skip: skip > 0 ? skip : undefined,
    take: pageSize !== 50 ? pageSize : undefined,
    documentType: filters.documentType === '' ? undefined : filters.documentType,
    status: filters.status === '' ? undefined : filters.status,
    level: filters.level === '' ? undefined : filters.level,
    customerId: filters.customerId === '' ? undefined : filters.customerId,
    isExport: filters.isExport === undefined ? undefined : String(filters.isExport),
  });
  return useQuery({
    queryKey: [...KEYS.invoices, filters],
    queryFn: () => apiFetch<SalesListResponse<Invoice>>(`${BASE}/invoices${query}`),
  });
}

/**
 * Detalj jednog računa (zaglavlje + stavke) — GET /sales/invoices/:id. Vraća SIROV
 * Invoice (bez `{ data }` omotača). `enabled` gasi upit dok id nije poznat.
 */
export function useInvoice(id: number | null) {
  return useQuery({
    queryKey: id != null ? KEYS.invoice(id) : [...KEYS.invoices, 'detail', null],
    queryFn: () => apiFetch<InvoiceDetail>(`${BASE}/invoices/${id}`),
    enabled: id != null,
  });
}

/**
 * Šifarnik vrsta usluge (GET /sales/service-revenue-types) — SAMO AKTIVNE, redom kojim
 * ih knjigovođa poređa. Kratka, stabilna lista (danas 4 reda), pa `staleTime` od 5
 * minuta: račun se otvara često, a šifarnik se menja retko.
 */
export function useServiceRevenueTypes() {
  return useQuery({
    queryKey: ['sales', 'service-revenue-types'],
    queryFn: () =>
      apiFetch<{ data: ServiceRevenueType[] }>(`${BASE}/service-revenue-types`),
    staleTime: 5 * 60_000,
  });
}

/**
 * Šifarnik osnova poreskog oslobođenja (GET /sales/vat-exemption-bases) — SAMO AKTIVNI.
 * Isti `staleTime` kao vrste usluge: kratka lista (danas 6 redova) koja se menja retko.
 */
export function useVatExemptionBases() {
  return useQuery({
    queryKey: ['sales', 'vat-exemption-bases'],
    queryFn: () =>
      apiFetch<{ data: VatExemptionBasis[] }>(`${BASE}/vat-exemption-bases`),
    staleTime: 5 * 60_000,
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateSales() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/**
 * Izmena zaglavlja nacrta (PATCH /sales/documents/:id).
 *
 * ⚠️ ENVELOPE JE DRUGAČIJI OD OSTALIH HOOK-OVA U OVOM FAJLU: ova ruta vraća
 * `{ data }`, dok detalj i ostale mutacije vraćaju SIROV `Invoice`
 * (`sales.controller.ts`, `updateDocument`). Zato je `apiFetch<{ data: … }>` i
 * `.then(r => r.data)` — bez toga bi ekran dobio omotač umesto računa.
 */
export interface UpdateInvoiceHeaderInput {
  documentDate?: string;
  dueDate?: string | null;
  supplyDate?: string | null;
  customerId?: number;
  currency?: string;
  note?: string | null;
  poNumber?: string | null;
  paymentReference?: string | null;
  lineProfile?: string | null;
  /** Vrsta usluge iz šifarnika; `null` briše izbor. */
  serviceRevenueTypeId?: number | null;
  /** Osnov poreskog oslobođenja iz šifarnika; `null` briše izbor. */
  vatExemptionBasisId?: number | null;
}

export function useUpdateInvoiceHeader() {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateInvoiceHeaderInput }) =>
      apiFetch<{ data: InvoiceDetail }>(`${BASE}/documents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }).then((r) => r.data),
    onSuccess: invalidate,
  });
}

/** Ulazna stavka predračuna (POST /sales/proformas) — 1:1 sa `CreateProformaItemInput`. */
export interface CreateProformaItemInput {
  itemId?: number;
  description?: string;
  quantity: number;
  unitPrice?: number;
  discountPercent?: number;
  cashDiscountPercent?: number;
  vatRateCode?: string;
}

/** Telo za kreiranje predračuna/ponude (POST /sales/proformas) — 1:1 sa `CreateProformaDto`. */
export interface CreateProformaInput {
  /** PON | PROF — draft (level 250). Default PROF. */
  documentType?: 'PON' | 'PROF';
  companyId?: number;
  customerId: number;
  documentDate?: string;
  dueDate?: string;
  currency?: string;
  isExport?: boolean;
  /** Broj narudžbenice kupca (opciono, max 50) → UBL OrderReference (D6). */
  poNumber?: string;
  note?: string;
  /** T3/A8: preskoči kreditni-limit guard (svesno kreiranje uprkos prekoračenju). */
  force?: boolean;
  items: CreateProformaItemInput[];
}

/**
 * Kreiraj predračun/ponudu (PON/PROF, level 250, DRAFT) — POST /sales/proformas.
 * Vraća SIROV Invoice sa stavkama. Permisija SALES_WRITE. Invalidira `sales` ključ.
 */
export function useCreateProforma() {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: (input: CreateProformaInput) =>
      apiFetch<InvoiceDetail>(`${BASE}/proformas`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Carry-over predračun → račun (PROF → IFR/IFGP/IFUSL/IZVRO…) — POST
 * /sales/invoices/:id/from-proforma. `targetType` = ciljna level-0 vrsta.
 * Vraća SIROV novi Invoice (level-0 draft). Permisija SALES_WRITE.
 */
export function useCreateInvoiceFromProforma() {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: (args: { id: number; targetType: string }) =>
      apiFetch<InvoiceDetail>(`${BASE}/invoices/${args.id}/from-proforma`, {
        method: 'POST',
        body: JSON.stringify({ targetType: args.targetType }),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Knjiženje računa (DRAFT → POSTED: rezerviši definitivan broj + nalog GK) —
 * POST /sales/invoices/:id/post. Vraća SIROV proknjižen Invoice. Permisija
 * SALES_POST. Invalidira `sales` ključ. `force` (T3/A8) preskače kreditni-limit
 * guard (svesno knjiženje uprkos prekoračenju) — koristi se na 422 CREDIT_LIMIT_EXCEEDED.
 */
export function usePostInvoice() {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: ({ id, force }: { id: number; force?: boolean }) =>
      apiFetch<InvoiceDetail>(`${BASE}/invoices/${id}/post`, {
        method: 'POST',
        body: JSON.stringify(force ? { force: true } : {}),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Rezultat storna fakture (A5) — proknjižen dokument u statusu CANCELLED + id
 * storno-naloga GK + spisak otkazanih SEF outbox redova (SENT/DELIVERED).
 */
export interface StornoResult extends InvoiceDetail {
  /** Id novog storno-naloga glavne knjige (null ako faktura nije imala nalog). */
  stornoEntryId: number | null;
  /** Outbox redovi otkazani na SEF-u u sklopu storna. */
  sefCancelledOutboxIds: number[];
}

/**
 * Storno proknjižene fakture (A5) — POST /sales/invoices/:id/storno { reason }.
 * Guard: samo zaključan (isLocked) proknjižen dokument (D8: storno je jedini put).
 * Backend obrne GL nalog + otkaže SEF outbox (SENT/DELIVERED). Razlog je OBAVEZAN.
 * Permisija SALES_POST. Invalidira i `sales` i `sef` ključeve (outbox se menja).
 */
export function useStornoInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      apiFetch<StornoResult>(`${BASE}/invoices/${id}/storno`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.all });
      qc.invalidateQueries({ queryKey: ['sef'] });
    },
  });
}

// ─────────────────────────────────── Slanje fakture mejlom (BigBit paritet, A6)

/** Odgovor mail rute: sent=false je DRY-RUN ili neuspeh (backend ne baca). */
export interface SendMailResult {
  sent: boolean;
  to: string;
  fileName: string;
}

/** Telo POST /sales/invoices/:id/send-mail. `to` prazno → email kupca sa računa. */
export interface SendInvoiceMailInput {
  id: number;
  to?: string;
  note?: string;
}

/**
 * Pošalji fakturu kupcu mejlom sa PDF prilogom — POST /sales/invoices/:id/send-mail.
 * `to` prazno → backend šalje na email kupca. Ne menja keširane podatke (slanje je
 * bez server-side mutacije nad računom), pa nema invalidacije. Permisija SALES_WRITE.
 */
export function useSendInvoiceMail() {
  return useMutation({
    mutationFn: ({ id, to, note }: SendInvoiceMailInput) =>
      apiFetch<{ data: SendMailResult }>(`${BASE}/invoices/${id}/send-mail`, {
        method: 'POST',
        body: JSON.stringify({ to: to ?? '', note: note ?? '' }),
      }),
  });
}

// ─────────────────────────────────── PDF štampa fakture (BigBit paritet)

/**
 * Varijante štampe računa (GET /sales/invoices/:id/pdf?variant) — 1:1 sa
 * `SalesController.invoicePdfDownload`. Izostavljena varijanta = račun (za AVR
 * backend sam bira avansni obrazac).
 */
export const INVOICE_PRINT_VARIANT = {
  /** Račun / avansni račun (backend bira po vrsti dokumenta). */
  STANDARD: '',
  /** Otpremnica — bez cena, tri potpisna mesta. */
  DELIVERY: 'delivery',
  /** Ino faktura (engleski, izvoz). */
  EXPORT: 'export',
  /** Avansni račun — osnov avansa + stanje naplate. */
  ADVANCE: 'advance',
  /** Knjižno odobrenje — vrednosni dokument (umanjenje). */
  CREDIT_NOTE: 'credit-note',
  /** Knjižno zaduženje — vrednosni dokument (uvećanje). */
  DEBIT_NOTE: 'debit-note',
} as const;

export type InvoicePrintVariant =
  (typeof INVOICE_PRINT_VARIANT)[keyof typeof INVOICE_PRINT_VARIANT];

/** Preuzmi PDF fakture (GET /sales/invoices/:id/pdf?variant). */
export function useInvoicePdf() {
  return useMutation({
    mutationFn: (args: { id: number; variant?: InvoicePrintVariant }) => {
      const q = args.variant ? `?variant=${args.variant}` : '';
      return apiBlob(`${BASE}/invoices/${args.id}/pdf${q}`);
    },
  });
}

/** Otvori PDF Blob u novom tabu (browser preview + download). */
export { openPdf } from '@/lib/open-pdf';

/**
 * DTO-ovi za rezervaciju zaliha (`stock_reservations`, C3).
 *
 * Predračun/porudžbina „drži" robu dok se ne izda ili otkaže — da se ista roba ne obeća dvaput.
 * IZVOR ISTINE za „rezervisano" je agregat OTVORENIH (`status='OPEN'`) redova ove tabele; kolona
 * `StockLevel.reserved` je mrtav legacy snapshot i NIKO je ne piše (ne koristi se u obračunu).
 *
 * Količine su STRING u JSON-u (BACKEND_RULES §6: Decimal kao string); servis ih parsira u
 * `Prisma.Decimal`. Datumi ISO 8601.
 */

// ─────────────────────────────────────────────────────────── domenski skupovi

/** Izvor rezervacije (`stock_reservations.source_type`). */
export const RESERVATION_SOURCE_TYPES = ["invoice", "order", "manual"] as const;
export type ReservationSourceType = (typeof RESERVATION_SOURCE_TYPES)[number];

/** Status rezervacije (`stock_reservations.status`) — samo OPEN ulazi u raspoloživo. */
export const RESERVATION_STATUS = {
  OPEN: "OPEN",
  RELEASED: "RELEASED",
  CONSUMED: "CONSUMED",
} as const;
export type ReservationStatus =
  (typeof RESERVATION_STATUS)[keyof typeof RESERVATION_STATUS];

export const RESERVATION_STATUSES = [
  RESERVATION_STATUS.OPEN,
  RESERVATION_STATUS.RELEASED,
  RESERVATION_STATUS.CONSUMED,
] as const;

/**
 * Tipovi `Invoice.documentType` iz kojih se rezerviše (ponuda / predračun) — uz `level` 250
 * (nacrt; knjižen račun ima level 0 i više ne rezerviše, on RAZDUŽUJE kroz izdatnicu).
 */
export const PROFORMA_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "PON",
  "PROF",
]);
export const PROFORMA_LEVEL = 250;

/** Razlog automatskog oslobađanja isteklih rezervacija (`expireDue`). */
export const EXPIRY_RELEASE_REASON = "istekla rezervacija";

// ─────────────────────────────────────────────────────────── ulazni DTO-ovi

/**
 * (artikal, magacin) ključ — jedinica po kojoj se računa raspoloživo.
 * Definicija je u `stock-movements.ts` (grain pogleda `v_stock_movements`);
 * ovde stoji re-eksport da postojeći `import { StockKey } from "./dto/reservation.dto"` radi.
 */
export type { StockKey } from "../stock-movements";

/** Referenca na izvorni dokument rezervacije (jedinstveni ključ reda uz `sourceLine`). */
export interface ReservationSourceRef {
  sourceType: ReservationSourceType;
  sourceId: number;
  /** Redni broj stavke izvora; izostavljen = cela grupa (svi redovi tog izvora). */
  sourceLine?: number | null;
}

/**
 * Rezerviši zalihu po predračunu (`Invoice` PON/PROF, level 250) — jedna rezervacija po
 * stavci sa artiklom. Idempotentno po `(source_type, source_id, source_line)`.
 */
export interface ReserveForProformaDto {
  invoiceId: number;
  /** Magacin iz kog se drži roba; podrazumevano 1 (kao carry-over/izdatnica). */
  warehouseId?: number;
  note?: string;
}

/** Ručna rezervacija (`sourceType='manual'`) — van dokumenta (npr. odvojeno za montažu). */
export interface CreateReservationDto {
  itemId: number;
  warehouseId: number;
  /** Rezervisana količina > 0 (string ili number). */
  quantity: string | number;
  /** Podrazumevano `manual`. */
  sourceType?: ReservationSourceType;
  /** Meki ref izvora; za `manual` podrazumevano 0 (bez dokumenta). */
  sourceId?: number;
  sourceLine?: number | null;
  /** ISO datum automatskog isteka; izostavljen = bez isteka. */
  expiresAt?: string;
  note?: string;
}

/** Oslobađanje (OPEN → RELEASED) po izvoru; bez `sourceLine` oslobađa sve redove izvora. */
export interface ReleaseReservationDto extends ReservationSourceRef {
  /** Razlog (npr. „otkazan predračun") — upisuje se u `release_reason`. */
  reason?: string;
}

/** Potrošnja (OPEN → CONSUMED) — poziva se kad izdatnica stvarno razduži robu. */
export interface ConsumeReservationDto extends ReservationSourceRef {
  /** Razlog / trag (npr. broj izdatnice) — upisuje se u `release_reason`. */
  reason?: string;
}

/** Filteri liste rezervacija (`GET /robno/reservations`) — query, sve kao string. */
export interface ListReservationsQuery {
  page?: string;
  pageSize?: string;
  itemId?: string;
  warehouseId?: string;
  /** OPEN | RELEASED | CONSUMED */
  status?: string;
  /** invoice | order | manual */
  sourceType?: string;
  sourceId?: string;
}

// ─────────────────────────────────────────────────────────── izlazni oblici

/** Jedan red liste rezervacija (Decimal kao string, naziv artikla pridružen mekim ref-om). */
export interface ReservationRow {
  id: number;
  itemId: number;
  warehouseId: number;
  itemName: string | null;
  itemCode: string | null;
  unit: string | null;
  sourceType: string;
  sourceId: number;
  sourceLine: number | null;
  quantity: string;
  status: string;
  releasedAt: string | null;
  releaseReason: string | null;
  expiresAt: string | null;
  note: string | null;
  createdByUserId: number | null;
  createdAt: string;
}

/** Raspoloživo po (artikal, magacin): `available = onHand − Σ(OPEN rezervacije)`. */
export interface AvailabilityRow {
  itemId: number;
  warehouseId: number;
  onHand: string;
  reserved: string;
  available: string;
}

/** Jedan manjak pri pokušaju rezervacije (payload 422 greške). */
export interface ReservationShortage {
  itemId: number;
  warehouseId: number;
  itemName: string | null;
  itemCode: string | null;
  requested: string;
  available: string;
}

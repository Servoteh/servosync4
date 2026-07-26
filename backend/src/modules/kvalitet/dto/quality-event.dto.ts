import { BadRequestException } from "@nestjs/common";

/**
 * DTO-i za evidenciju škarta i dorade (MODULE_SPEC_kvalitet_skart_dorada §2–§4,
 * presuda 26.07). class-validator još nije uveden (BACKEND_RULES §6) — ručna
 * provera, isti obrazac kao montaza-neusaglasenosti / kvalitet DTO. Enum vrednosti
 * su String liste (NE DB CHECK, BACKEND_RULES §2); nevalidno → 400/422.
 */

/** Tip događaja — fiksna lista (String, ne Prisma enum). */
export const QUALITY_EVENT_TYPES = ["SKART", "DORADA"] as const;
export type QualityEventType = (typeof QUALITY_EVENT_TYPES)[number];

/** Status događaja — PRIJAVLJEN (kiosk) → POTVRDJEN (kontrolor) / ODBACEN. */
export const QUALITY_EVENT_STATUSES = [
  "PRIJAVLJEN",
  "POTVRDJEN",
  "ODBACEN",
] as const;
export type QualityEventStatus = (typeof QUALITY_EVENT_STATUSES)[number];

/** Zajednička polja koja opisuju vezu na proizvodnju + mašinu (create/prijava/potvrdi). */
interface ProductionRefFields {
  workOrderId?: number;
  techProcessId?: number | null;
  machineId?: number | null;
  workUnitCode?: string | null;
  note?: string | null;
  photoPath?: string | null;
}

/** Kanonski unos kontrolora — nastaje odmah kao POTVRDJEN (§3). Sva ključna polja + razlog. */
export interface CreateQualityEventDto extends ProductionRefFields {
  /** SKART | DORADA. */
  type: string;
  /** RN (work_orders.id) — obavezno (§2). */
  workOrderId: number;
  /** Količina > 0. */
  qty: number;
  /** Jedinica (default 'kom'). */
  unit?: string;
  /** Razlog (quality_reason_codes.id) — obavezan za kontrolorski unos (POTVRDJEN). */
  reasonCodeId: number;
  /** Radnik čiji je rad (workers.id) — opciono; default = JWT worker kontrolora. */
  reportedByWorkerId?: number | null;
}

/** Kiosk prijava-signal radnika — nastaje kao PRIJAVLJEN, minimalno (§3). */
export interface PrijavaQualityEventDto extends ProductionRefFields {
  /** SKART | DORADA. */
  type: string;
  /** RN (work_orders.id) — iz konteksta poziva (obavezno). */
  workOrderId: number;
  /** Količina > 0. */
  qty: number;
  unit?: string;
  /** Razlog (opciono na prijavi — kontrolor ga dopuni pri potvrdi). */
  reasonCodeId?: number | null;
  /** ID kartica radnika (workers.cardId) — identifikuje prijavioca na deljenom kiosku. */
  workerCard: string;
}

/** Kontrolorska potvrda prijave (PRIJAVLJEN → POTVRDJEN) — dopuna razloga/količine/operacije. */
export interface ConfirmQualityEventDto {
  /** Razlog (obavezan da bi događaj postao POTVRDJEN). */
  reasonCodeId: number;
  /** Korekcija količine (opciono). */
  qty?: number;
  unit?: string;
  techProcessId?: number | null;
  machineId?: number | null;
  workUnitCode?: string | null;
  note?: string | null;
}

/** Kontrolorsko odbacivanje prijave (PRIJAVLJEN → ODBACEN) — razlog je obavezan podatak (§3). */
export interface RejectQualityEventDto {
  rejectReason: string;
}

function checkType(type: unknown, errors: string[]): void {
  if (!(QUALITY_EVENT_TYPES as readonly unknown[]).includes(type))
    errors.push(`Polje 'type' mora biti: ${QUALITY_EVENT_TYPES.join(", ")}.`);
}

function checkQtyRequired(qty: unknown, errors: string[]): void {
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0)
    errors.push("Polje 'qty' (količina) mora biti broj > 0.");
}

function checkQtyOptional(qty: unknown, errors: string[]): void {
  if (qty === undefined) return;
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0)
    errors.push("Polje 'qty' (količina) mora biti broj > 0.");
}

function checkOptId(value: unknown, name: string, errors: string[]): void {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || (value as number) < 1)
    errors.push(`Polje '${name}' mora biti ceo broj ≥ 1.`);
}

function checkRequiredId(value: unknown, name: string, errors: string[]): void {
  if (!Number.isInteger(value) || (value as number) < 1)
    errors.push(`Polje '${name}' je obavezno i mora biti ceo broj ≥ 1.`);
}

function checkNote(note: unknown, errors: string[]): void {
  if (note === undefined || note === null) return;
  if (typeof note !== "string" || note.length > 2000)
    errors.push("Polje 'note' mora biti tekst do 2000 karaktera.");
}

export function validateCreateQualityEvent(dto: CreateQualityEventDto): void {
  const errors: string[] = [];
  checkType(dto?.type, errors);
  checkRequiredId(dto?.workOrderId, "workOrderId", errors);
  checkQtyRequired(dto?.qty, errors);
  checkRequiredId(dto?.reasonCodeId, "reasonCodeId", errors);
  checkOptId(dto?.techProcessId, "techProcessId", errors);
  checkOptId(dto?.machineId, "machineId", errors);
  checkOptId(dto?.reportedByWorkerId, "reportedByWorkerId", errors);
  checkNote(dto?.note, errors);
  if (errors.length) throw new BadRequestException(errors);
}

export function validatePrijavaQualityEvent(dto: PrijavaQualityEventDto): void {
  const errors: string[] = [];
  checkType(dto?.type, errors);
  checkRequiredId(dto?.workOrderId, "workOrderId", errors);
  checkQtyRequired(dto?.qty, errors);
  checkOptId(dto?.reasonCodeId, "reasonCodeId", errors);
  checkOptId(dto?.techProcessId, "techProcessId", errors);
  checkOptId(dto?.machineId, "machineId", errors);
  checkNote(dto?.note, errors);
  if (typeof dto?.workerCard !== "string" || !dto.workerCard.trim())
    errors.push("Polje 'workerCard' (ID kartica radnika) je obavezno.");
  if (errors.length) throw new BadRequestException(errors);
}

export function validateConfirmQualityEvent(dto: ConfirmQualityEventDto): void {
  const errors: string[] = [];
  checkRequiredId(dto?.reasonCodeId, "reasonCodeId", errors);
  checkQtyOptional(dto?.qty, errors);
  checkOptId(dto?.techProcessId, "techProcessId", errors);
  checkOptId(dto?.machineId, "machineId", errors);
  checkNote(dto?.note, errors);
  if (errors.length) throw new BadRequestException(errors);
}

export function validateRejectQualityEvent(dto: RejectQualityEventDto): void {
  if (typeof dto?.rejectReason !== "string" || !dto.rejectReason.trim())
    throw new BadRequestException(
      "Polje 'rejectReason' (razlog odbacivanja) je obavezno.",
    );
  if (dto.rejectReason.length > 2000)
    throw new BadRequestException(
      "Polje 'rejectReason' mora biti tekst do 2000 karaktera.",
    );
}

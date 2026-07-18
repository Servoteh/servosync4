import { BadRequestException } from "@nestjs/common";

/**
 * Ledger mutacije lokacija napravljenih delova (MODULE_SPEC_lokacije §3.1/§3.2).
 *
 * 🔴 KONVENCIJA PREDZNAKA: `part_locations.quantity` je `Int` koji SME biti
 * negativan → ledger sa PREDZNAKOM. Postavljanje (placement) = **+qty**,
 * uklanjanje (removal) = **−qty**. Neto stanje dela na poziciji = `SUM(quantity)`.
 * (Postojeći synced zapisi su pozitivni placement-i.) Zapisi su append-only —
 * korekcija je kontra-zapis, ne izmena/brisanje (§4).
 *
 * Ručne provere (class-validator se uvodi globalno kasnije — BACKEND_RULES §6,
 * isti obrazac kao `dto/position.dto.ts`).
 */

/** Unos lokacije — placement (+quantity) iskontrolisanog dela (§3.7: tek posle završne kontrole). */
export interface CreatePartLocationDto {
  /** Radni nalog (deo) — obavezno. `projectId` zapisa se izvodi iz RN-a (§3.6), ne šalje se. */
  workOrderId: number;
  /** Pozicija/polica — obavezno (FK `positions`). */
  positionId: number;
  /** Vrsta kvaliteta: 0=OK, 1=dorada, 2=škart (§3.4). */
  qualityTypeId: number;
  /** Radnik koji je uneo/postavio (izvršilac završne kontrole) — obavezno (FK `workers`). */
  workerId: number;
  /** Količina koja se postavlja — ceo broj ≥ 1 (upisuje se kao +quantity). */
  quantity: number;
}

/** Prenos dela sa police na policu — transakcioni par (−qty na izvoru, +qty na cilju), §3.2. */
export interface TransferPartLocationDto {
  /** Radni nalog (deo) — obavezno. */
  workOrderId: number;
  /** Izvorna pozicija (odakle se skida) — obavezno; ≠ ciljna. */
  fromPositionId: number;
  /** Ciljna pozicija (gde se postavlja) — obavezno; ≠ izvorna. */
  toPositionId: number;
  /** Količina za prenos — ceo broj ≥ 1; ≤ neto stanje na izvornoj poziciji. */
  quantity: number;
  /** Vrsta kvaliteta: 0=OK, 1=dorada, 2=škart (§3.4). */
  qualityTypeId: number;
}

/** Trebovanje/uklanjanje dela sa police — removal (−qty), §3.2. */
export interface RequisitionPartLocationDto {
  /** Radni nalog (deo) — obavezno. */
  workOrderId: number;
  /** Pozicija sa koje se trebuje — obavezno. */
  positionId: number;
  /** Količina za trebovanje — ceo broj ≥ 1; ≤ neto stanje na poziciji. */
  quantity: number;
  /** Vrsta kvaliteta: 0=OK, 1=dorada, 2=škart (§3.4). */
  qualityTypeId: number;
}

function reqPosInt(errors: string[], v: unknown, name: string): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    errors.push(`${name} mora biti ceo broj ≥ 1.`);
}

function reqNonNegInt(errors: string[], v: unknown, name: string): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    errors.push(`${name} mora biti ceo broj ≥ 0.`);
}

export function validateCreatePartLocation(dto: CreatePartLocationDto): void {
  const errors: string[] = [];
  reqPosInt(errors, dto?.workOrderId, "Radni nalog");
  reqPosInt(errors, dto?.positionId, "Pozicija");
  reqPosInt(errors, dto?.workerId, "Radnik");
  reqPosInt(errors, dto?.quantity, "Količina");
  reqNonNegInt(errors, dto?.qualityTypeId, "Vrsta kvaliteta");
  if (errors.length) throw new BadRequestException(errors);
}

export function validateTransferPartLocation(
  dto: TransferPartLocationDto,
): void {
  const errors: string[] = [];
  reqPosInt(errors, dto?.workOrderId, "Radni nalog");
  reqPosInt(errors, dto?.fromPositionId, "Izvorna pozicija");
  reqPosInt(errors, dto?.toPositionId, "Ciljna pozicija");
  reqPosInt(errors, dto?.quantity, "Količina");
  reqNonNegInt(errors, dto?.qualityTypeId, "Vrsta kvaliteta");
  if (
    Number.isInteger(dto?.fromPositionId) &&
    Number.isInteger(dto?.toPositionId) &&
    dto.fromPositionId === dto.toPositionId
  ) {
    errors.push("Izvorna i ciljna pozicija ne smeju biti iste.");
  }
  if (errors.length) throw new BadRequestException(errors);
}

export function validateRequisitionPartLocation(
  dto: RequisitionPartLocationDto,
): void {
  const errors: string[] = [];
  reqPosInt(errors, dto?.workOrderId, "Radni nalog");
  reqPosInt(errors, dto?.positionId, "Pozicija");
  reqPosInt(errors, dto?.quantity, "Količina");
  reqNonNegInt(errors, dto?.qualityTypeId, "Vrsta kvaliteta");
  if (errors.length) throw new BadRequestException(errors);
}

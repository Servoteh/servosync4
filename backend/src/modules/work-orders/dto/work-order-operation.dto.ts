import { BadRequestException } from "@nestjs/common";

/**
 * Unos/izmena reda operacije tehnološkog postupka (`work_order_operations`, Was:
 * tStavkeRN) — legacy `Form_UnosStavkiRN`. Ovo je TP-authoring: dodavanje/izmena
 * operacije na radnom nalogu (RC, norme Tpz/Tk, opis, alat, prioritet).
 *
 * Pravilo prioriteta (legacy `BeforeUpdate`): ako se `priority` ne zada, izvodi se iz
 * `operations.usesPriority` — 100 (koristi prioritet) ili 255 (skinuto s prioriteta).
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — ručna validacija.
 */
export interface CreateWorkOrderOperationDto {
  /** Redni broj operacije (npr. 10, 20). Izostavljen → auto `MAX(operationNumber)+10`. */
  operationNumber?: number;
  /** Radni centar (RJgrupaRC) — FK ka `operations`; obavezno. */
  workCenterCode: string;
  /** Opis rada (OpisRada) — obavezno. */
  workDescription: string;
  /** Alat/pribor (AlatPribor). */
  toolsFixtures?: string;
  /** Priprema-završno vreme Tpz (h/min po dogovoru), ≥ 0. */
  setupTime?: number;
  /** Vreme po komadu Tk, ≥ 0. */
  cycleTime?: number;
  /** Težina TO. */
  toolWeight?: number;
  /** Prioritet; izostavljen → iz `operations.usesPriority` (100/255). */
  priority?: number;
  /** Tehnolog/radnik (FK workers). */
  workerId?: number;
}

export type UpdateWorkOrderOperationDto = Partial<CreateWorkOrderOperationDto>;

function optNonNegNum(errors: string[], v: unknown, name: string): void {
  if (v !== undefined && (typeof v !== "number" || Number.isNaN(v) || v < 0))
    errors.push(`${name} mora biti broj ≥ 0.`);
}
function optInt(errors: string[], v: unknown, name: string): void {
  if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v)))
    errors.push(`${name} mora biti ceo broj.`);
}
function optNonNegInt(errors: string[], v: unknown, name: string): void {
  if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < 0))
    errors.push(`${name} mora biti ceo broj ≥ 0.`);
}

function sharedOpChecks(errors: string[], dto: UpdateWorkOrderOperationDto): void {
  if (
    dto?.operationNumber !== undefined &&
    (typeof dto.operationNumber !== "number" ||
      !Number.isInteger(dto.operationNumber) ||
      dto.operationNumber < 0)
  )
    errors.push("Broj operacije mora biti ceo broj ≥ 0.");
  optNonNegNum(errors, dto?.setupTime, "Tpz");
  optNonNegNum(errors, dto?.cycleTime, "Tk");
  optNonNegNum(errors, dto?.toolWeight, "Težina TO");
  optInt(errors, dto?.priority, "Prioritet");
  optNonNegInt(errors, dto?.workerId, "Radnik");
}

export function validateCreateOperation(dto: CreateWorkOrderOperationDto): void {
  const errors: string[] = [];
  if (typeof dto?.workCenterCode !== "string" || !dto.workCenterCode.trim())
    errors.push("Radni centar (RJgrupaRC) je obavezan.");
  if (typeof dto?.workDescription !== "string" || !dto.workDescription.trim())
    errors.push("Opis rada je obavezan.");
  sharedOpChecks(errors, dto);
  if (errors.length) throw new BadRequestException(errors);
}

export function validateUpdateOperation(dto: UpdateWorkOrderOperationDto): void {
  const errors: string[] = [];
  if (
    dto?.workCenterCode !== undefined &&
    (typeof dto.workCenterCode !== "string" || !dto.workCenterCode.trim())
  )
    errors.push("Radni centar ne sme biti prazan.");
  if (
    dto?.workDescription !== undefined &&
    (typeof dto.workDescription !== "string" || !dto.workDescription.trim())
  )
    errors.push("Opis rada ne sme biti prazan.");
  sharedOpChecks(errors, dto);
  if (errors.length) throw new BadRequestException(errors);
}

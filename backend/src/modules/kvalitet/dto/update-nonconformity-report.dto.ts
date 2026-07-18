import { BadRequestException } from "@nestjs/common";
import { validateResponsibleParty } from "./create-nonconformity-report.dto";

/**
 * `PATCH /kvalitet/reports/:id` — izmena poslovnih polja izveštaja + izvršilaca
 * (`culpritWorkerIds` = replace set). Sva polja opciona (parcijalna izmena).
 * Dozvoljena i za POTVRĐENE izveštaje (naknadna dopuna troškova/sati) — servis to
 * dopušta; jedino se `type` potvrđenog ne sme menjati (menja prostor numeracije).
 */
export interface UpdateNonconformityReportDto {
  type?: number;
  quantity?: number;
  defectDescription?: string;
  reportDate?: string;
  workOrderId?: number | null;
  identNumber?: string | null;
  sourceTechProcessId?: number | null;
  drawingNumber?: string | null;
  partName?: string | null;
  customerName?: string | null;
  cause?: string | null;
  workUnit?: string | null;
  culpritText?: string | null;
  /** „Odgovoran" — jedna od `RESPONSIBLE_PARTIES`; null briše vrednost. */
  responsibleParty?: string | null;
  materialCostNote?: string | null;
  coopCostNote?: string | null;
  spentHoursText?: string | null;
  spentHours?: number | null;
  /** Trošak materijala (kg) — nenegativan broj; ručna korekcija auto-vrednosti. */
  materialKg?: number | null;
  note?: string | null;
  preventiveMeasures?: string | null;
  extra?: string | null;
  raisedByWorkerId?: number | null;
  culpritWorkerIds?: number[];
}

const OPTIONAL_ID_FIELDS = [
  "workOrderId",
  "sourceTechProcessId",
  "raisedByWorkerId",
] as const;

export function validateUpdateNonconformityReport(
  dto: UpdateNonconformityReportDto,
): void {
  const errors: string[] = [];

  if (dto?.type !== undefined && dto.type !== 1 && dto.type !== 2)
    errors.push("Polje 'type' mora biti 1 (dorada) ili 2 (škart).");

  if (
    dto?.quantity !== undefined &&
    (typeof dto.quantity !== "number" ||
      !Number.isInteger(dto.quantity) ||
      dto.quantity < 1)
  )
    errors.push("Polje 'quantity' mora biti ceo broj ≥ 1.");

  if (dto?.defectDescription !== undefined && typeof dto.defectDescription !== "string")
    errors.push("Polje 'defectDescription' mora biti tekst.");

  if (dto?.reportDate !== undefined) {
    if (
      typeof dto.reportDate !== "string" ||
      Number.isNaN(new Date(dto.reportDate).getTime())
    )
      errors.push("Polje 'reportDate' nije ispravan datum (ISO 8601).");
  }

  if (dto?.culpritWorkerIds !== undefined) {
    if (
      !Array.isArray(dto.culpritWorkerIds) ||
      dto.culpritWorkerIds.some((w) => !Number.isInteger(w) || w < 1)
    )
      errors.push("Polje 'culpritWorkerIds' mora biti niz celih brojeva ≥ 1.");
  }

  if (
    dto?.spentHours !== undefined &&
    dto.spentHours !== null &&
    (typeof dto.spentHours !== "number" ||
      !Number.isFinite(dto.spentHours) ||
      dto.spentHours < 0)
  )
    errors.push("Polje 'spentHours' mora biti nenegativan broj.");

  if (
    dto?.materialKg !== undefined &&
    dto.materialKg !== null &&
    (typeof dto.materialKg !== "number" ||
      !Number.isFinite(dto.materialKg) ||
      dto.materialKg < 0)
  )
    errors.push("Polje 'materialKg' mora biti nenegativan broj.");

  for (const f of OPTIONAL_ID_FIELDS) {
    const v = dto?.[f];
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1))
      errors.push(`Polje '${f}' mora biti ceo broj ≥ 1.`);
  }

  validateResponsibleParty(dto?.responsibleParty, errors);

  if (errors.length) throw new BadRequestException(errors);
}

import { BadRequestException } from "@nestjs/common";

/**
 * `POST /kvalitet/reports` — ručni draft izveštaja o neusaglašenosti
 * (MODULE_SPEC_kontrola_kvaliteta §4/§5). Obavezno: `type`, `quantity`,
 * `defectDescription`; `reportDate` default = danas. Sva ostala polja opciona
 * (paritet Excel evidencije). Draft se kreira sa `status=0`, `reportNumber=NULL`
 * (broj dodeljuje tek potvrda). class-validator još nije uveden (BACKEND_RULES §6) — ručno.
 */
export interface CreateNonconformityReportDto {
  /** 1 = dorada, 2 = škart. */
  type: number;
  /** Odbačeni/dorađeni komadi — ceo broj ≥ 1. */
  quantity: number;
  /** Opis greške — obavezan (Excel „Opis greške"). */
  defectDescription: string;
  /** Datum izveštaja (ISO 8601); default = danas. */
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
  materialCostNote?: string | null;
  coopCostNote?: string | null;
  spentHoursText?: string | null;
  /** Utrošeni sati (parsirano) — nenegativan broj. */
  spentHours?: number | null;
  note?: string | null;
  preventiveMeasures?: string | null;
  extra?: string | null;
  /** Kontrolor / „Neusaglašenost ističe". */
  raisedByWorkerId?: number | null;
  /** Izvršioci-radnici (M:N) — puni „Moje neusaglašenosti" u Moj profil. */
  culpritWorkerIds?: number[];
}

const OPTIONAL_ID_FIELDS = [
  "workOrderId",
  "sourceTechProcessId",
  "raisedByWorkerId",
] as const;

export function validateCreateNonconformityReport(
  dto: CreateNonconformityReportDto,
): void {
  const errors: string[] = [];

  if (dto?.type !== 1 && dto?.type !== 2)
    errors.push("Polje 'type' mora biti 1 (dorada) ili 2 (škart).");

  if (
    typeof dto?.quantity !== "number" ||
    !Number.isInteger(dto.quantity) ||
    dto.quantity < 1
  )
    errors.push("Polje 'quantity' mora biti ceo broj ≥ 1.");

  if (typeof dto?.defectDescription !== "string" || !dto.defectDescription.trim())
    errors.push("Polje 'defectDescription' (opis greške) je obavezno.");

  if (dto?.reportDate !== undefined && dto.reportDate !== null) {
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

  for (const f of OPTIONAL_ID_FIELDS) {
    const v = dto?.[f];
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1))
      errors.push(`Polje '${f}' mora biti ceo broj ≥ 1.`);
  }

  if (errors.length) throw new BadRequestException(errors);
}

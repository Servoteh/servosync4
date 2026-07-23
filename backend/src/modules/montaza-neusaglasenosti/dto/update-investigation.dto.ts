import { BadRequestException } from "@nestjs/common";

/**
 * `PATCH /montaza/neusaglasenosti/:id/istraga` — polja istrage (manage).
 * Sva polja opciona (PATCH šalje samo izmenjena); `null` briše vrednost.
 * MODULE_SPEC_montaza_neusaglasenosti §2/§3.
 */
export interface UpdateInvestigationDto {
  /** Odgovorno odeljenje (slobodan tekst uz predloge). */
  responsibleDepartment?: string | null;
  /** Izvršilac — meki ref workers.id (opciono). */
  responsibleWorkerId?: number | null;
  /** Nalaz istrage. */
  investigationReport?: string | null;
  /** Preventivne mere. */
  preventiveMeasures?: string | null;
}

export function validateUpdateInvestigation(dto: UpdateInvestigationDto): void {
  const errors: string[] = [];

  if (
    dto?.responsibleWorkerId !== undefined &&
    dto.responsibleWorkerId !== null &&
    (!Number.isInteger(dto.responsibleWorkerId) || dto.responsibleWorkerId < 1)
  )
    errors.push("Polje 'responsibleWorkerId' mora biti ceo broj ≥ 1.");

  const stringFields = [
    "responsibleDepartment",
    "investigationReport",
    "preventiveMeasures",
  ] as const;
  for (const f of stringFields) {
    const v = dto?.[f];
    if (v !== undefined && v !== null && typeof v !== "string")
      errors.push(`Polje '${f}' mora biti tekst ili null.`);
  }

  // Bar jedno polje mora stići (prazan PATCH nema smisla).
  const touched =
    dto?.responsibleDepartment !== undefined ||
    dto?.responsibleWorkerId !== undefined ||
    dto?.investigationReport !== undefined ||
    dto?.preventiveMeasures !== undefined;
  if (!touched) errors.push("Nijedno polje istrage nije prosleđeno.");

  if (errors.length) throw new BadRequestException(errors);
}

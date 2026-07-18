import { BadRequestException } from "@nestjs/common";

/** Radna jedinica (MODULE_SPEC_structures §6.2). */
export interface CreateWorkUnitDto {
  /** Šifra RJ ("00" = NN, "01" = Sečenje, ...) — obavezno. */
  code: string;
  /** Naziv RJ — obavezno. */
  name: string;
}

export type UpdateWorkUnitDto = Partial<CreateWorkUnitDto>;

// Dužine po schema.prisma (WorkUnit: code VarChar(5), name VarChar(50)) —
// bez provere duži unos puca kao PG 22001 / Prisma P2000 → goli 500.
export function validateCreateWorkUnit(dto: CreateWorkUnitDto): void {
  const errors: string[] = [];
  if (typeof dto?.code !== "string" || !dto.code.trim())
    errors.push("Šifra radne jedinice je obavezna.");
  else if (dto.code.trim().length > 5)
    errors.push("Šifra radne jedinice sme imati najviše 5 karaktera.");
  if (typeof dto?.name !== "string" || !dto.name.trim())
    errors.push("Naziv radne jedinice je obavezan.");
  else if (dto.name.trim().length > 50)
    errors.push("Naziv radne jedinice sme imati najviše 50 karaktera.");
  if (errors.length) throw new BadRequestException(errors);
}

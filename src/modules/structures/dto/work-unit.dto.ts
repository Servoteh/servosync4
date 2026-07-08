import { BadRequestException } from "@nestjs/common";

/** Radna jedinica (MODULE_SPEC_structures §6.2). */
export interface CreateWorkUnitDto {
  /** Šifra RJ ("00" = NN, "01" = Sečenje, ...) — obavezno. */
  code: string;
  /** Naziv RJ — obavezno. */
  name: string;
}

export type UpdateWorkUnitDto = Partial<CreateWorkUnitDto>;

export function validateCreateWorkUnit(dto: CreateWorkUnitDto): void {
  const errors: string[] = [];
  if (typeof dto?.code !== "string" || !dto.code.trim())
    errors.push("Šifra radne jedinice je obavezna.");
  if (typeof dto?.name !== "string" || !dto.name.trim())
    errors.push("Naziv radne jedinice je obavezan.");
  if (errors.length) throw new BadRequestException(errors);
}

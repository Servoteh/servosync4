import { BadRequestException } from "@nestjs/common";

/** Operacija (MODULE_SPEC_structures §6.3). Prirodni ključ = workCenterCode. */
export interface CreateOperationDto {
  /** Šifra operacije (prirodni ključ, npr. "1.10") — obavezno, jedinstveno. */
  workCenterCode: string;
  /** Naziv operacije — obavezno. */
  workCenterName: string;
  /** Šifra radne jedinice (logički FK work_units.code) — obavezno. */
  workUnitCode: string;
  /** Napomena. */
  note?: string;
  /** Bez tehnološkog postupka ("Opšti nalog"). */
  withoutProcess?: boolean;
  /** Kraj postupka (završna kontrola). */
  significantForFinishing?: boolean;
  /** Koristi prioritet (100/255) u planiranju. */
  usesPriority?: boolean;
  /** Može se preskočiti u tehnologiji. */
  isSkippable?: boolean;
}

/** workCenterCode je prirodni ključ i ne menja se PATCH-om — zato je izostavljen. */
export type UpdateOperationDto = Partial<
  Omit<CreateOperationDto, "workCenterCode">
>;

export function validateCreateOperation(dto: CreateOperationDto): void {
  const errors: string[] = [];
  if (typeof dto?.workCenterCode !== "string" || !dto.workCenterCode.trim())
    errors.push("Šifra operacije (workCenterCode) je obavezna.");
  if (typeof dto?.workCenterName !== "string" || !dto.workCenterName.trim())
    errors.push("Naziv operacije je obavezan.");
  if (typeof dto?.workUnitCode !== "string" || !dto.workUnitCode.trim())
    errors.push("Šifra radne jedinice (workUnitCode) je obavezna.");
  if (errors.length) throw new BadRequestException(errors);
}

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

// Dužine po schema.prisma (Operation) — bez ovih provera duži unos puca kao
// PG 22001 / Prisma P2000 → goli 500 umesto 400 (obrazac iz position.dto.ts).
export function validateCreateOperation(dto: CreateOperationDto): void {
  const errors: string[] = [];
  if (typeof dto?.workCenterCode !== "string" || !dto.workCenterCode.trim())
    errors.push("Šifra operacije (workCenterCode) je obavezna.");
  else if (dto.workCenterCode.trim().length > 5)
    errors.push("Šifra operacije sme imati najviše 5 karaktera.");
  if (typeof dto?.workCenterName !== "string" || !dto.workCenterName.trim())
    errors.push("Naziv operacije je obavezan.");
  else if (dto.workCenterName.trim().length > 50)
    errors.push("Naziv operacije sme imati najviše 50 karaktera.");
  if (typeof dto?.workUnitCode !== "string" || !dto.workUnitCode.trim())
    errors.push("Šifra radne jedinice (workUnitCode) je obavezna.");
  else if (dto.workUnitCode.trim().length > 5)
    errors.push("Šifra radne jedinice sme imati najviše 5 karaktera.");
  if (
    dto?.note !== undefined &&
    dto.note !== null &&
    (typeof dto.note !== "string" || dto.note.length > 255)
  )
    errors.push("Napomena sme imati najviše 255 karaktera.");
  if (errors.length) throw new BadRequestException(errors);
}

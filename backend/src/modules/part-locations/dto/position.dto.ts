import { BadRequestException } from "@nestjs/common";

/** Pozicija/polica (MODULE_SPEC_lokacije §1, Was: tPozicije). */
export interface CreatePositionDto {
  /** Šifra pozicije/police — obavezno, max 20 karaktera (position_code VARCHAR(20)). */
  positionCode: string;
  /** Opis pozicije/police — opciono, max 250 karaktera (description VARCHAR(250)). */
  description?: string;
}

export type UpdatePositionDto = Partial<CreatePositionDto>;

export function validateCreatePosition(dto: CreatePositionDto): void {
  const errors: string[] = [];
  if (typeof dto?.positionCode !== "string" || !dto.positionCode.trim()) {
    errors.push("Šifra pozicije je obavezna.");
  } else if (dto.positionCode.trim().length > 20) {
    errors.push("Šifra pozicije sme imati najviše 20 karaktera.");
  }
  if (dto?.description !== undefined && dto.description !== null) {
    if (typeof dto.description !== "string")
      errors.push("Opis pozicije mora biti tekst.");
    else if (dto.description.length > 250)
      errors.push("Opis pozicije sme imati najviše 250 karaktera.");
  }
  if (errors.length) throw new BadRequestException(errors);
}

export function validateUpdatePosition(dto: UpdatePositionDto): void {
  const errors: string[] = [];
  if (dto?.positionCode !== undefined) {
    if (typeof dto.positionCode !== "string" || !dto.positionCode.trim())
      errors.push("Šifra pozicije ne sme biti prazna.");
    else if (dto.positionCode.trim().length > 20)
      errors.push("Šifra pozicije sme imati najviše 20 karaktera.");
  }
  if (dto?.description !== undefined && dto.description !== null) {
    if (typeof dto.description !== "string")
      errors.push("Opis pozicije mora biti tekst.");
    else if (dto.description.length > 250)
      errors.push("Opis pozicije sme imati najviše 250 karaktera.");
  }
  if (errors.length) throw new BadRequestException(errors);
}

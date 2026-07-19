import { BadRequestException } from "@nestjs/common";

/**
 * NACRT — DTO za kreiranje predmeta (write-path, Traka B §A).
 * Obrazac: interface + ručna validate*() (kao handovers/kvalitet/nabavka dto;
 * class-validator nije uveden — BACKEND_RULES §6). Kod engleski, poruke srpski.
 *
 * NAPOMENA: `workTypeId ≠ 0` je POSLOVNA validacija sa specifičnom BigBit porukom
 * („Niste definisali vrstu posla!!!") — nju baca SERVIS kao UnprocessableEntityException,
 * ne ovaj DTO (422 ≠ 400). Ovde samo osnovni oblik/tipovi.
 */
export interface CreateProjectDto {
  customerId: number; // kupac — obavezno (meki ref, postojanje proverava servis)
  workTypeId: number; // vrsta posla — obavezno ≠ 0 (poslovni guard u servisu)
  description?: string;
  projectName?: string;
  deadline?: string; // ISO datum (opciono)
  memo?: string;
  // openedAt / salespersonId / status / projectNumber postavlja SERVIS (ne klijent).
}

export function validateCreateProject(dto: CreateProjectDto): void {
  const errors: string[] = [];

  const reqPosInt = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
      errors.push(`${name} je obavezan.`);
  };

  reqPosInt(dto.customerId, "Komitent");
  // workTypeId mora biti prisutan i broj; ≠0 poslovni guard je u servisu (422 sa BigBit porukom).
  if (typeof dto.workTypeId !== "number" || !Number.isInteger(dto.workTypeId))
    errors.push("Vrsta posla je obavezna.");

  if (
    dto.description !== undefined &&
    typeof dto.description !== "string"
  )
    errors.push("Opis mora biti tekst.");
  if (dto.projectName !== undefined && typeof dto.projectName !== "string")
    errors.push("Naziv predmeta mora biti tekst.");
  if (dto.deadline !== undefined && Number.isNaN(Date.parse(dto.deadline)))
    errors.push("Rok mora biti validan datum.");

  if (errors.length) throw new BadRequestException(errors);
}

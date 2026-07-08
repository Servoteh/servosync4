import { BadRequestException } from "@nestjs/common";

/** Vrsta posla (MODULE_SPEC_structures §6.4). */
export interface CreateWorkerTypeDto {
  /** Naziv vrste posla — obavezno. */
  name: string;
  /** Ima dodatna prava (npr. zatvaranje tuđih naloga). */
  additionalPrivileges?: boolean;
}

export type UpdateWorkerTypeDto = Partial<CreateWorkerTypeDto>;

export function validateCreateWorkerType(dto: CreateWorkerTypeDto): void {
  const errors: string[] = [];
  if (typeof dto?.name !== "string" || !dto.name.trim())
    errors.push("Naziv vrste posla je obavezan.");
  if (errors.length) throw new BadRequestException(errors);
}

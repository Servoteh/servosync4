import { BadRequestException } from "@nestjs/common";

/** Vrsta posla (MODULE_SPEC_structures §6.4). */
export interface CreateWorkerTypeDto {
  /** Naziv vrste posla — obavezno. */
  name: string;
  /**
   * Ovlašćeni kontrolor (završna kontrola) — signal za A-5 završnu kontrolu /
   * kiosk (legacy „dodatna prava", npr. zatvaranje tuđih naloga).
   */
  additionalPrivileges?: boolean;
}

export type UpdateWorkerTypeDto = Partial<CreateWorkerTypeDto>;

// Dužina po schema.prisma (WorkerType.name VarChar(50)) — bez provere duži
// unos puca kao PG 22001 / Prisma P2000 → goli 500.
export function validateCreateWorkerType(dto: CreateWorkerTypeDto): void {
  const errors: string[] = [];
  if (typeof dto?.name !== "string" || !dto.name.trim())
    errors.push("Naziv vrste posla je obavezan.");
  else if (dto.name.trim().length > 50)
    errors.push("Naziv vrste posla sme imati najviše 50 karaktera.");
  if (errors.length) throw new BadRequestException(errors);
}

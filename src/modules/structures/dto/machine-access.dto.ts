import { BadRequestException } from "@nestjs/common";

/** Pristup mašini — par (radnik, operacija) (MODULE_SPEC_structures §6.5). */
export interface CreateMachineAccessDto {
  /** Radnik (FK workers.id) — obavezno. */
  workerId: number;
  /** Operacija (FK operations.work_center_code) — obavezno. */
  workCenterCode: string;
  /** Napomena. */
  note?: string;
}

/** Batch dodela/oduzimanje operacija jednom radniku (atomarno). */
export interface BatchMachineAccessDto {
  /** Radnik kome se menja matrica — obavezno. */
  workerId: number;
  /** Šifre operacija koje treba dodati. */
  add?: string[];
  /** Šifre operacija koje treba ukloniti. */
  remove?: string[];
}

export function validateCreateMachineAccess(dto: CreateMachineAccessDto): void {
  const errors: string[] = [];
  if (
    typeof dto?.workerId !== "number" ||
    !Number.isInteger(dto.workerId) ||
    dto.workerId <= 0
  )
    errors.push("Radnik (workerId) je obavezan.");
  if (typeof dto?.workCenterCode !== "string" || !dto.workCenterCode.trim())
    errors.push("Šifra operacije (workCenterCode) je obavezna.");
  if (errors.length) throw new BadRequestException(errors);
}

export function validateBatchMachineAccess(dto: BatchMachineAccessDto): void {
  const errors: string[] = [];
  if (
    typeof dto?.workerId !== "number" ||
    !Number.isInteger(dto.workerId) ||
    dto.workerId <= 0
  )
    errors.push("Radnik (workerId) je obavezan.");
  if (dto?.add !== undefined && !Array.isArray(dto.add))
    errors.push("Polje 'add' mora biti niz šifara operacija.");
  if (dto?.remove !== undefined && !Array.isArray(dto.remove))
    errors.push("Polje 'remove' mora biti niz šifara operacija.");
  if (errors.length) throw new BadRequestException(errors);
}

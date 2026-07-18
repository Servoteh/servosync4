import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/work/start` — START skena („dva skena", A-4).
 * Radnik skenira ID karticu + nalog + operaciju; otvara vremensku sesiju
 * (`work_time_entries`, `stopped_at = NULL`). `workerCard` je OBAVEZNA — identitet
 * ključa sesiju (2.0 analogon legacy `DefinisiIDPostupkaZaRadnika`).
 * `revision` (polje 5) mora biti ista u oba barkoda — isti otisak (provera u servisu).
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna.
 */
export interface StartWorkDto {
  /** Nalog barkod: `RNZ:projectId:identNumber:variant:revision`. */
  orderBarcode: string;
  /** Operacija barkod: `S:operationNumber:workCenterCode:0:revision`. */
  operationBarcode: string;
  /** ID kartica radnika (`workers.cardId`) — obavezno. */
  workerCard: string;
}

export function validateStartWork(dto: StartWorkDto): void {
  const errors: string[] = [];
  if (typeof dto?.orderBarcode !== "string" || !dto.orderBarcode.trim())
    errors.push("Polje 'orderBarcode' je obavezno.");
  if (typeof dto?.operationBarcode !== "string" || !dto.operationBarcode.trim())
    errors.push("Polje 'operationBarcode' je obavezno.");
  if (typeof dto?.workerCard !== "string" || !dto.workerCard.trim())
    errors.push("Polje 'workerCard' (ID kartica) je obavezno.");
  if (errors.length) throw new BadRequestException(errors);
}

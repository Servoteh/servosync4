import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/scan` — barkod prijava rada (kiosk). Radnik skenira
 * DVA barkoda (nalog + operacija) i unosi broj napravljenih komada.
 * `revision` (polje 5) mora biti ista u oba barkoda — isti otisak (provera u servisu).
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna.
 */
export interface ScanTechProcessDto {
  /** Nalog barkod: `RNZ:projectId:identNumber:variant:revision`. */
  orderBarcode: string;
  /** Operacija barkod: `S:operationNumber:workCenterCode:0:revision`. */
  operationBarcode: string;
  /** Broj napravljenih komada u ovoj prijavi (ceo broj ≥ 1). */
  pieceCount: number;
  /**
   * ID kartica radnika (`workers.cardId`) koji prijavljuje rad — opciono.
   * Ako je zadata, radnik se razrešava i upisuje na `tech_processes.workerId`
   * (audit: ko je radio; legacy `SifraRadnika`). MODULE_SPEC_kontrola §4/§5.
   */
  workerCard?: string;
  /**
   * Napomena uz prijavu rada (opciono) — upisuje se na `tech_processes.note`
   * (kumulativni red; poslednja napomena prepisuje). K0.1 (MODULE_SPEC_kvaliteta §9).
   */
  note?: string;
}

export function validateScan(dto: ScanTechProcessDto): void {
  const errors: string[] = [];
  if (typeof dto?.orderBarcode !== "string" || !dto.orderBarcode.trim())
    errors.push("Polje 'orderBarcode' je obavezno.");
  if (typeof dto?.operationBarcode !== "string" || !dto.operationBarcode.trim())
    errors.push("Polje 'operationBarcode' je obavezno.");
  if (
    typeof dto?.pieceCount !== "number" ||
    !Number.isInteger(dto.pieceCount) ||
    dto.pieceCount < 1
  )
    errors.push("Polje 'pieceCount' mora biti ceo broj ≥ 1.");
  if (
    dto?.workerCard !== undefined &&
    (typeof dto.workerCard !== "string" || !dto.workerCard.trim())
  )
    errors.push("Polje 'workerCard' mora biti neprazan string (ID kartica).");
  if (
    dto?.note !== undefined &&
    (typeof dto.note !== "string" || dto.note.trim().length > 500)
  )
    errors.push("Polje 'note' mora biti string do 500 karaktera.");
  if (errors.length) throw new BadRequestException(errors);
}

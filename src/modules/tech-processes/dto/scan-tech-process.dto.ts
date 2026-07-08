import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/scan` — barkod prijava rada (kiosk). Radnik skenira
 * DVA barkoda (nalog + operacija) i unosi broj napravljenih komada.
 * `PrnTimer` mora biti isti u oba barkoda (vezni ključ, provera u servisu).
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna.
 */
export interface ScanTechProcessDto {
  /** Nalog barkod: `RNZ:IDPredmet:IdentBroj:Varijanta:PrnTimer`. */
  orderBarcode: string;
  /** Operacija barkod: `S:Operacija:RJgrupaRC:Toznaka:PrnTimer`. */
  operationBarcode: string;
  /** Broj napravljenih komada u ovoj prijavi (ceo broj ≥ 1). */
  pieceCount: number;
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
  if (errors.length) throw new BadRequestException(errors);
}

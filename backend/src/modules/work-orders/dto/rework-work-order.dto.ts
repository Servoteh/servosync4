import { BadRequestException } from "@nestjs/common";

/**
 * Kreiranje DORADA/ŠKART child naloga (`KreirajNalogDoradeIliSkarta`,
 * MODULE_SPEC_radni_nalozi §3.4 / migration/08 §2). Iz postojećeg RN-a nastaje
 * novi child: `identNumber` dobija sufiks `-D`n (dorada, `qualityTypeId=1`) ili
 * `-S`n (škart, `qualityTypeId=2`); kopira zaglavlje + sve 4 vrste stavki.
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna dole.
 */
export interface ReworkWorkOrderDto {
  /** Dorađena/škartirana količina (Komada child naloga) — ceo broj ≥ 1. */
  pieceCount: number;
  /** 1 = DORADA (sufiks `-D`), 2 = ŠKART (sufiks `-S`). */
  qualityTypeId: number;
  /** Napomena child naloga (prazno → preuzima napomenu izvora). */
  note?: string;
}

export function validateReworkWorkOrder(dto: ReworkWorkOrderDto): void {
  const errors: string[] = [];
  if (
    typeof dto?.pieceCount !== "number" ||
    !Number.isInteger(dto.pieceCount) ||
    dto.pieceCount < 1
  ) {
    errors.push("Količina mora biti ceo broj ≥ 1.");
  }
  if (dto?.qualityTypeId !== 1 && dto?.qualityTypeId !== 2) {
    errors.push("qualityTypeId mora biti 1 (dorada) ili 2 (škart).");
  }
  if (errors.length) throw new BadRequestException(errors);
}

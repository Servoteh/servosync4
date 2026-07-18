import { BadRequestException } from "@nestjs/common";

/**
 * Ručno kreiranje DORADA/ŠKART child naloga (`POST /work-orders/:id/quality-child`).
 * Isti legacy recept kao automatska derivacija iz kontrole
 * (`KreirajNalogDoradeIliSkarta`, RN_Modul.bas:607), samo ručno pokrenut:
 * fallback za međufazne škartove bez kioska i retroaktivni data-fix
 * (npr. 9000/131-S1). `:id` je izvorni (parent) RN; sufiks `-D`/`-S` + kopija
 * celog TP-a rešava servis.
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna dole.
 */
export interface QualityChildWorkOrderDto {
  /** 1 = DORADA (sufiks `-D`), 2 = ŠKART (sufiks `-S`). */
  qualityTypeId: number;
  /** Dorađena/škartirana količina (Komada child naloga) — ceo broj ≥ 1. */
  quantity: number;
  /** Napomena child naloga (prazno → preuzima napomenu izvora). */
  note?: string;
}

export function validateQualityChildWorkOrder(
  dto: QualityChildWorkOrderDto,
): void {
  const errors: string[] = [];
  if (dto?.qualityTypeId !== 1 && dto?.qualityTypeId !== 2) {
    errors.push("qualityTypeId mora biti 1 (dorada) ili 2 (škart).");
  }
  if (
    typeof dto?.quantity !== "number" ||
    !Number.isInteger(dto.quantity) ||
    dto.quantity < 1
  ) {
    errors.push("Količina mora biti ceo broj ≥ 1.");
  }
  if (
    dto?.note !== undefined &&
    (typeof dto.note !== "string" || dto.note.trim().length > 500)
  ) {
    errors.push("Napomena mora biti string do 500 karaktera.");
  }
  if (errors.length) throw new BadRequestException(errors);
}

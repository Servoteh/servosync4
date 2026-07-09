import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/:id/storno` — STORNIRANJE otkucane operacije (legacy
 * `StornirajTehPostupak`): ne briše, nego upisuje KONTRA-red sa negativnim brojem
 * komada (neto se poništava). Radnik na kontra-redu ostaje izvorni (kao legacy INSERT
 * SELECT). Guard: ne može se stornirati više nego što je evidentirano.
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — ručna validacija.
 */
export interface StornoTechProcessDto {
  /** Broj komada za storno — ceo broj ≥ 1 (≤ evidentiranom na redu). */
  pieceCount: number;
  /** Napomena uz storno. */
  note?: string;
}

export function validateStorno(dto: StornoTechProcessDto): void {
  const errors: string[] = [];
  if (
    typeof dto?.pieceCount !== "number" ||
    !Number.isInteger(dto.pieceCount) ||
    dto.pieceCount < 1
  )
    errors.push("Polje 'pieceCount' mora biti ceo broj ≥ 1.");
  if (dto?.note !== undefined && typeof dto.note !== "string")
    errors.push("Napomena mora biti tekst.");
  if (errors.length) throw new BadRequestException(errors);
}

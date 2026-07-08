import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/:id/finish` — zatvaranje postupka (§3 pravilo 2).
 * Oba polja opciona: bez `pieceCount` zatvara sa trenutnom evidentiranom
 * količinom; `note` se dopisuje uz zatvaranje.
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna.
 */
export interface FinishTechProcessDto {
  /** Konačan broj napravljenih komada (ceo broj ≥ 0). Bez njega → koristi postojeći. */
  pieceCount?: number;
  /** Napomena uz zatvaranje. */
  note?: string;
}

export function validateFinish(dto: FinishTechProcessDto | undefined): void {
  if (dto?.pieceCount !== undefined) {
    if (!Number.isInteger(dto.pieceCount) || dto.pieceCount < 0)
      throw new BadRequestException("Polje 'pieceCount' mora biti ceo broj ≥ 0.");
  }
}

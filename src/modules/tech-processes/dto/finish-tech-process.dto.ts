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
  /**
   * ID kartica radnika (`workers.cardId`) koji zatvara postupak — opciono.
   * Ako je zadata → upis na `tech_processes.workerId` (audit ko+kada). §4/§5.
   */
  workerCard?: string;
  /**
   * Overshoot potvrda (K0.2): kada bi napravljeno prešlo plan, FE prvo pokaže dijalog
   * pa ponovi zahtev sa `confirmOvershoot: true` — tada se dozvoljava zatvaranje preko
   * plana. Bez flag-a premašaj = 422.
   */
  confirmOvershoot?: boolean;
}

export function validateFinish(dto: FinishTechProcessDto | undefined): void {
  if (dto?.pieceCount !== undefined) {
    if (!Number.isInteger(dto.pieceCount) || dto.pieceCount < 0)
      throw new BadRequestException("Polje 'pieceCount' mora biti ceo broj ≥ 0.");
  }
  if (
    dto?.workerCard !== undefined &&
    (typeof dto.workerCard !== "string" || !dto.workerCard.trim())
  )
    throw new BadRequestException(
      "Polje 'workerCard' mora biti neprazan string (ID kartica).",
    );
  if (
    dto?.confirmOvershoot !== undefined &&
    typeof dto.confirmOvershoot !== "boolean"
  )
    throw new BadRequestException(
      "Polje 'confirmOvershoot' mora biti boolean.",
    );
}

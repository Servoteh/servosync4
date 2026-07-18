import { UnprocessableEntityException } from "@nestjs/common";

/**
 * Čekiranje „CAM završen" po poziciji (RN) — Miljan t.7. `isDone=true` upisuje
 * audit ko/kada (JWT worker) u `cnc_programs`; `false` ih briše. `note` opciono.
 */
export interface SetCncProgramDoneDto {
  isDone: boolean;
  note?: string;
}

export function validateSetCncProgramDone(dto: SetCncProgramDoneDto): void {
  if (typeof dto?.isDone !== "boolean")
    throw new UnprocessableEntityException(
      "Polje 'isDone' je obavezno (boolean).",
    );
  if (dto.note !== undefined && dto.note !== null) {
    if (typeof dto.note !== "string")
      throw new UnprocessableEntityException("Napomena mora biti tekst.");
    if (dto.note.length > 500)
      throw new UnprocessableEntityException(
        "Napomena može imati najviše 500 karaktera.",
      );
  }
}

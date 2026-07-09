import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/work/stop` — STOP skena („dva skena", A-4).
 * Zatvara otvorenu sesiju radnika za tu operaciju (`stopped_at = now`, `piece_count`)
 * i AKUMULIRA komade na `tech_processes` (isti efekat kao `scan`). Ako otvorena sesija
 * ne postoji (radnik nije skenirao START), servis kreira trenutnu sesiju
 * (`started_at = stopped_at`) — jednokratni fallback. `workerCard` obavezna (isti radnik
 * koji je započeo — legacy `ZavrsiNalogDrugogRadnika` je P2).
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna.
 */
export interface StopWorkDto {
  /** Nalog barkod: `RNZ:projectId:identNumber:variant:revision`. */
  orderBarcode: string;
  /** Operacija barkod: `S:operationNumber:workCenterCode:0:revision`. */
  operationBarcode: string;
  /** ID kartica radnika (`workers.cardId`) — obavezno. */
  workerCard: string;
  /** Broj napravljenih komada u ovoj sesiji (ceo broj ≥ 1). */
  pieceCount: number;
  /** Napomena (opciono). */
  note?: string;
}

export function validateStopWork(dto: StopWorkDto): void {
  const errors: string[] = [];
  if (typeof dto?.orderBarcode !== "string" || !dto.orderBarcode.trim())
    errors.push("Polje 'orderBarcode' je obavezno.");
  if (typeof dto?.operationBarcode !== "string" || !dto.operationBarcode.trim())
    errors.push("Polje 'operationBarcode' je obavezno.");
  if (typeof dto?.workerCard !== "string" || !dto.workerCard.trim())
    errors.push("Polje 'workerCard' (ID kartica) je obavezno.");
  if (
    typeof dto?.pieceCount !== "number" ||
    !Number.isInteger(dto.pieceCount) ||
    dto.pieceCount < 1
  )
    errors.push("Polje 'pieceCount' mora biti ceo broj ≥ 1.");
  if (
    dto?.note !== undefined &&
    (typeof dto.note !== "string" || dto.note.length > 2000)
  )
    errors.push("Polje 'note' mora biti string do 2000 karaktera.");
  if (errors.length) throw new BadRequestException(errors);
}

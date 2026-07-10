import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/labels/print` — RAW TSPL2 štampa na mrežni termalni štampač
 * (TSC ML340P). Server šalje direktno na TCP 9100 — browser NE dira localhost (Chrome
 * „Local Network Access" blokira HTTPS stranu → localhost; zato štampa ide kroz backend).
 * Payload je isti TSPL2 koji front generiše (`frontend/src/lib/tspl2.ts`).
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna.
 */
export interface PrintLabelDto {
  /** Kompletan TSPL2 program (CLS/TEXT/BARCODE/PRINT...). */
  tspl2: string;
  /** Broj kopija — informativno (kopije su već u TSPL2 `PRINT n,1`). */
  copies?: number;
}

export function validatePrintLabel(dto: PrintLabelDto): void {
  const errors: string[] = [];
  if (typeof dto?.tspl2 !== "string" || !dto.tspl2.trim())
    errors.push("Polje 'tspl2' je obavezno (RAW TSPL2 program).");
  else if (dto.tspl2.length > 200_000)
    errors.push("Polje 'tspl2' je predugačko (max 200000 karaktera).");
  if (errors.length) throw new BadRequestException(errors);
}

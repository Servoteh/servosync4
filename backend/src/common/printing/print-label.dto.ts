import { BadRequestException } from "@nestjs/common";

/**
 * RAW TSPL2 payload za mrežnu termalnu štampu (TSC ML340P). Deljeno između
 * Tehnologije (`/tech-processes/labels/print`) i Lokacija (`/locations/labels/print`
 * — police + TP nalepnice, MODULE_SPEC_lokacije_30.md §3 t.12). Front generiše ceo
 * TSPL2 program (`frontend/src/lib/tspl2.*`); backend ga samo prosleđuje na TCP 9100.
 *
 * class-validator se namerno NE koristi (BACKEND_RULES §6, paritet 1.0 label-proxy) —
 * validacija je ručna (`validatePrintLabel`), a `LabelPrintService` je odbrana od
 * konfiguracionih komandi štampača.
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

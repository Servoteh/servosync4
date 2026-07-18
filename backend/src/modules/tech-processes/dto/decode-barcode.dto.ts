import { BadRequestException } from "@nestjs/common";

/**
 * `POST /tech-processes/barcode/decode` — parsira/validira JEDAN barkod
 * (nalog ili operacija) i vraća tip + polja (+ za nalog razrešen RN).
 *
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna.
 */
export interface DecodeBarcodeDto {
  /** Sirov skenirani barkod (`RNZ:...` ili `S:...`). */
  barcode: string;
}

export function validateDecodeBarcode(dto: DecodeBarcodeDto): void {
  if (typeof dto?.barcode !== "string" || !dto.barcode.trim())
    throw new BadRequestException("Polje 'barcode' je obavezno.");
}

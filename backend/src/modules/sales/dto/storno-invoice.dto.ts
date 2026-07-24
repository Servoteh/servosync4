import { BadRequestException } from "@nestjs/common";

/**
 * DTO za storno proknjižene fakture (D8: storno je JEDINI dozvoljeni put za
 * zaključan dokument). Obrazac: interface + ručna validate*() (kao create-proforma,
 * BACKEND_RULES §6). Razlog storna je obavezan (BigBit ER paritet — svaki storno se
 * beleži uz obrazloženje). Poruke na srpskom, kod na engleskom.
 */
export interface StornoInvoiceDto {
  /** Obavezan razlog storna (upisuje se u napomenu fakture + SEF cancel poziv). */
  reason?: string;
}

const MAX_REASON_LEN = 500;

/** Validira i vraća očišćen (trim) razlog; baca BadRequest ako je prazan/predugačak. */
export function validateStornoInvoice(dto: StornoInvoiceDto): string {
  const reason = typeof dto?.reason === "string" ? dto.reason.trim() : "";
  if (reason.length === 0) {
    throw new BadRequestException("Razlog storna je obavezan.");
  }
  if (reason.length > MAX_REASON_LEN) {
    throw new BadRequestException(
      `Razlog storna sme imati najviše ${MAX_REASON_LEN} karaktera.`,
    );
  }
  return reason;
}

import { BadRequestException } from "@nestjs/common";

/**
 * DTO — izvoz naloga za plaćanje u banku (fiksni TXT FX / Banca Intesa).
 * Ulaz: ID-jevi naloga za izvoz + podaci platioca za VODEĆI slog (doc 21 §B).
 */
export interface ExportPaymentsDto {
  /** ID-jevi PaymentOrder redova koje treba izvesti (vodeći slog agregira Σ). */
  orderIds: number[];
  /** VODEĆI slog: žiro račun platioca (NaTeretRacun), sa/bez crtica. */
  debitAccount: string;
  /** VODEĆI slog: naziv platioca (NaTeretNaziv), 35 znakova. */
  debitName: string;
  /** VODEĆI slog: mesto platioca (NaTeretMesto), 20 znakova. */
  debitPlace?: string;
  /** datum na virmanu (ddmmyyyy); default = danas. ISO ("2026-07-19") ili Date. */
  orderDate?: string;
}

export function validateExportPayments(dto: ExportPaymentsDto): void {
  const errors: string[] = [];

  if (!Array.isArray(dto.orderIds) || dto.orderIds.length === 0) {
    errors.push("Nije izabran nijedan nalog za izvoz.");
  } else if (
    dto.orderIds.some((id) => typeof id !== "number" || !Number.isInteger(id))
  ) {
    errors.push("Lista naloga sadrži neispravan ID.");
  }

  if (typeof dto.debitAccount !== "string" || dto.debitAccount.trim() === "") {
    errors.push("Žiro račun platioca (na teret) je obavezan za vodeći slog.");
  }
  if (typeof dto.debitName !== "string" || dto.debitName.trim() === "") {
    errors.push("Naziv platioca (na teret) je obavezan za vodeći slog.");
  }

  if (errors.length) throw new BadRequestException(errors);
}

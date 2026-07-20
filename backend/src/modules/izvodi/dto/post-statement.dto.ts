import { BadRequestException } from "@nestjs/common";

/**
 * DTO za auto-knjiženje izvoda u GK.
 * `bankAccountCode` = sintetički/analitički konto banke na koji ide protivstavka (doc 21 §A:
 * FX_HALCOM_ProknjiziPrometUGK — konto banke). Ako se ne prosledi, servis pokušava iz
 * PaymentAccount.bankCode / parametra (⏳ konačan izvor konta banke — doc 21 §D t.3 / PLAN §B TODO).
 */
export interface PostStatementDto {
  bankAccountCode?: string; // konto banke (protivstavka); opcioni override
}

export function validatePostStatement(dto: PostStatementDto): void {
  const errors: string[] = [];
  if (
    dto.bankAccountCode !== undefined &&
    (typeof dto.bankAccountCode !== "string" ||
      dto.bankAccountCode.trim().length === 0)
  )
    errors.push("Konto banke, ako se prosleđuje, mora biti ne-prazan string.");
  if (errors.length) throw new BadRequestException(errors);
}

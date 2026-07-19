import { BadRequestException } from "@nestjs/common";

/**
 * DTO za uvoz bankovnog izvoda (TXT fiksne kolone, FX format).
 * Obrazac: interface + ručna validate*() (kao nabavka/robno; class-validator još nije
 * uveden — BACKEND_RULES §6). Poruke na srpskom, kod na engleskom.
 */
export interface ImportStatementDto {
  bankAccount: string; // naš žiro račun (PaymentAccount.accountNumber)
  statementNumber: string; // broj izvoda (idempotencija: uq bankAccount+statementNumber)
  statementDate: string; // ISO datum izvoda
  txtContent: string; // sirov TXT sadržaj (fiksne kolone)
  fileName?: string; // originalni naziv fajla (audit)
  openingBalance?: number;
  closingBalance?: number;
  currency?: string;
}

export function validateImportStatement(dto: ImportStatementDto): void {
  const errors: string[] = [];

  const reqStr = (v: unknown, name: string) => {
    if (typeof v !== "string" || v.trim().length === 0)
      errors.push(`${name} je obavezan.`);
  };

  reqStr(dto.bankAccount, "Žiro račun");
  reqStr(dto.statementNumber, "Broj izvoda");
  reqStr(dto.txtContent, "Sadržaj izvoda (TXT)");

  if (typeof dto.statementDate !== "string" || Number.isNaN(Date.parse(dto.statementDate)))
    errors.push("Datum izvoda mora biti validan datum.");

  const optNum = (v: unknown, name: string) => {
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || Number.isNaN(v))
      errors.push(`${name} mora biti broj.`);
  };
  optNum(dto.openingBalance, "Početno stanje");
  optNum(dto.closingBalance, "Krajnje stanje");

  if (
    dto.currency !== undefined &&
    (typeof dto.currency !== "string" || dto.currency.length > 3)
  )
    errors.push("Valuta mora biti oznaka do 3 znaka (npr. RSD).");

  if (errors.length) throw new BadRequestException(errors);
}

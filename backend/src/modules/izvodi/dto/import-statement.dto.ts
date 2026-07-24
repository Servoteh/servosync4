import { BadRequestException } from "@nestjs/common";

/**
 * DTO za uvoz bankovnog izvoda (TXT fiksne kolone, FX format).
 * Obrazac: interface + ručna validate*() (kao nabavka/robno; class-validator još nije
 * uveden — BACKEND_RULES §6). Poruke na srpskom, kod na engleskom.
 */
/**
 * Dozvoljene valute izvoda (E6, O2 presuda). RSD = dinarski izvod (default, FX polja
 * na stavkama ostaju null). EUR/USD/CHF = devizni izvod (stavke nose devizni iznos +
 * prodajni kurs; `amount` je uvek RSD protivvrednost — doc 09 §banking).
 */
export const STATEMENT_CURRENCIES = ["RSD", "EUR", "USD", "CHF"] as const;
export type StatementCurrency = (typeof STATEMENT_CURRENCIES)[number];

export interface ImportStatementDto {
  bankAccount: string; // naš žiro račun (PaymentAccount.accountNumber)
  statementNumber: string; // broj izvoda (idempotencija: uq bankAccount+statementNumber)
  statementDate: string; // ISO datum izvoda
  // Sirov TXT sadržaj (fiksne kolone). OPCIONO: bez TXT-a se kreira PRAZAN izvod za
  // ručni unos stavki (E6 devizni izvod — parser je RSD-only, pa se devizne stavke
  // unose ručno preko addLine). Ako je zadat, mora dati bar jednu parsabilnu stavku.
  txtContent?: string;
  fileName?: string; // originalni naziv fajla (audit)
  openingBalance?: number;
  closingBalance?: number;
  currency?: string; // RSD (default) | EUR | USD | CHF — vidi STATEMENT_CURRENCIES
}

export function validateImportStatement(dto: ImportStatementDto): void {
  const errors: string[] = [];

  const reqStr = (v: unknown, name: string) => {
    if (typeof v !== "string" || v.trim().length === 0)
      errors.push(`${name} je obavezan.`);
  };

  reqStr(dto.bankAccount, "Žiro račun");
  reqStr(dto.statementNumber, "Broj izvoda");

  // txtContent je opcion (prazan izvod za ručni unos); ako je zadat, mora biti string.
  if (dto.txtContent !== undefined && typeof dto.txtContent !== "string")
    errors.push("Sadržaj izvoda (TXT) mora biti tekst.");

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
    dto.currency !== null &&
    !(STATEMENT_CURRENCIES as readonly string[]).includes(dto.currency)
  )
    errors.push(
      `Valuta mora biti jedna od: ${STATEMENT_CURRENCIES.join(", ")}.`,
    );

  // Devizni izvod + TXT je zabranjen (review E6 SREDNJI): parser je RSD-only pa bi
  // sirovi devizni brojevi ušli u `amount` kao RSD bez konverzije (~117× potcenjeno,
  // tiho). Devizni izvod se kreira PRAZAN i puni ručno (FX preračun po prodajnom kursu).
  if (
    dto.currency !== undefined &&
    dto.currency !== null &&
    dto.currency !== "RSD" &&
    typeof dto.txtContent === "string" &&
    dto.txtContent.trim() !== ""
  )
    errors.push(
      "Devizni izvod se unosi ručno — TXT uvoz podržava samo dinarske (RSD) izvode.",
    );

  if (errors.length) throw new BadRequestException(errors);
}

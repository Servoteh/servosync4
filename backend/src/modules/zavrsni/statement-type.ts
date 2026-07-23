/**
 * Tipovi obrazaca završnog računa (schema.prisma FinancialStatement.statementType).
 * Izdvojeno u zaseban fajl da se prekine kružni import balance-sheet ↔ control-rules
 * (D9: balance-sheet injektuje ControlRulesService, a pravila referišu tip obrasca —
 * pod CommonJS ciklusom bi STATEMENT_TYPE bio undefined pri module-load evaluaciji).
 */
export const STATEMENT_TYPE = {
  BALANCE_SHEET: "BALANCE_SHEET", // BS / bilans stanja
  INCOME_STATEMENT: "INCOME_STATEMENT", // BU / bilans uspeha
  POPDV_ANNUAL: "POPDV_ANNUAL", // SI / statistički
} as const;

export type StatementType = (typeof STATEMENT_TYPE)[keyof typeof STATEMENT_TYPE];

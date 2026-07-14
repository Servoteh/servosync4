// HR PDF generatori (ćirilica) + QR bedževi — R3 TEŽIŠTE Talasa G.
// Fontovi: /public/fonts/Roboto-*.ttf (bundlovan jsPDF, offline). Logo:
// /public/logo-servoteh.jpg. Latinica→ćirilica: toCyrillic.

export { toCyrillic } from './cyrillic';
export {
  generateVacationDecisionPdf,
  generateEmploymentCertificatePdf,
  generateSalaryCertificatePdf,
  generateAnnexPdf,
  generateMaternityDecisionPdf,
  generateMutualTerminationPdf,
} from './hr-documents';
export type {
  PdfResult,
  VacationDecisionInput,
  EmploymentCertInput,
  SalaryCertInput,
  AnnexInput,
  MaternityInput,
  MutualTerminationInput,
} from './hr-documents';
export { generateContractPdf } from './contract';
export type { ContractInput } from './contract';
export { generateKarnetPdf } from './karnet';
export type { KarnetInput, KarnetEmployee, KarnetDay, KarnetRow, KarnetTotals } from './karnet';
export { generateBadgeSheetPdf, generateBadgeToken, downloadBlob, openBlob } from './badges';
export type { BadgeItem } from './badges';

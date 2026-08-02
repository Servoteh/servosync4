// HR PDF generatori (ćirilica) + QR bedževi — R3 TEŽIŠTE Talasa G.
// Fontovi: /public/fonts/Roboto-*.ttf (bundlovan jsPDF, offline). Logo:
// /public/logo-servoteh.jpg. Latinica→ćirilica: toCyrillic; ćirilica→latinica:
// toLatin (Ugovor o radu je od 27.07.2026. latinični, ostala dokumenta ćirilica).

export { toCyrillic, toLatin } from './cyrillic';
export {
  generateVacationDecisionPdf,
  generateEmploymentCertificatePdf,
  generateSalaryCertificatePdf,
  generateAnnexPdf,
  generateMaternityDecisionPdf,
  generateMutualTerminationPdf,
  generateEmploymentDecisionPdf,
} from './hr-documents';
export type {
  PdfResult,
  VacationDecisionInput,
  EmploymentCertInput,
  SalaryCertInput,
  AnnexInput,
  MaternityInput,
  MutualTerminationInput,
  EmploymentDecisionInput,
} from './hr-documents';
export { generateVacationRecordPdf } from './vacation-record';
export type { VacationRecordInput, VacationLedgerBlock } from './vacation-record';
export { generateContractPdf } from './contract';
export type { ContractInput } from './contract';
export { generateJobPositionPdf } from './job-position';
export type { JobPositionEmployee } from './job-position';
export { generateSistematizacijaPdf } from './sistematizacija';
export type { SistematizacijaOptions } from './sistematizacija';
export { generateSistematizacijaDoc } from './sistematizacija-doc';
export type { SistematizacijaDocOptions } from './sistematizacija-doc';
export { generateKarnetPdf } from './karnet';
export type { KarnetInput, KarnetEmployee, KarnetDay, KarnetRow, KarnetTotals } from './karnet';
export { generateSelfKarnetPdf } from './karnet-self';
export type { SelfKarnetInput } from './karnet-self';
export { generateBadgeSheetPdf, generateBadgeToken, downloadBlob, openBlob } from './badges';
export type { BadgeItem } from './badges';
export { exportAssessmentPdf } from './assessment';
export type { AssessmentPdfInput, AssessmentPdfGroup, AssessmentPdfComp } from './assessment';

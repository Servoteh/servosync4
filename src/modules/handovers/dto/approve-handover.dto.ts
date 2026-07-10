/**
 * Odobravanje primopredaje (§6.4 + P1 "izbor tehnologa"): šef tehnologije pri
 * odobravanju OBAVEZNO bira tehnologa koji piše tehnološki postupak (TP).
 * `technologistId` mora biti radnik sa `defines_approval=true` (isti izvor kao
 * `GET /handovers/technologists`). Validacija u servisu (kao reject).
 */
export interface ApproveHandoverDto {
  /** Tehnolog koji piše TP (FK workers, bez DB constraint-a) — OBAVEZAN. */
  technologistId: number;
  comment?: string;
}

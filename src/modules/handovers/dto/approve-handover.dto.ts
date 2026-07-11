/**
 * Odobravanje primopredaje (§6.4 + P1 "izbor tehnologa" + P4 §6.5.1 "rok pri
 * odobravanju"): šef tehnologije pri odobravanju OBAVEZNO bira tehnologa koji
 * piše tehnološki postupak (TP). `technologistId` mora biti AKTIVAN radnik
 * vrste "Tehnolog" (worker_types po imenu — zajednički kriterijum iz
 * `common/workers/technologist-criteria.ts`, isti izvor kao
 * `GET /handovers/technologists`; `defines_approval` je napušten za ovaj
 * kriterijum). Validacija u servisu (kao reject).
 */
export interface ApproveHandoverDto {
  /** Tehnolog koji piše TP (FK workers, bez DB constraint-a) — OBAVEZAN. */
  technologistId: number;
  comment?: string;
  /**
   * ISO datum roka izrade (§6.5.1, legacy: rok unosi inženjer koji odobrava) →
   * `drawing_handovers.production_deadline`; propagira se u RN pri kreiranju
   * (eksplicitni launch dueDate ima prednost). Opcion dok Miljan ne potvrdi
   * obaveznost (spec §8 #8).
   */
  dueDate?: string;
}

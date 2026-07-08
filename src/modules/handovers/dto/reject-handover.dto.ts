/**
 * Odbijanje primopredaje (§6.4) — `reason` je OBAVEZAN (razlika od approve,
 * gde je komentar opcionalan). Validacija dužine/praznine u servisu.
 */
export interface RejectHandoverDto {
  reason: string;
}

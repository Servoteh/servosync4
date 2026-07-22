import { BadRequestException } from "@nestjs/common";

/**
 * Telo za POST /zahtevi/:id/score (MODULE_SPEC §12.2) — admin potvrda/korekcija ocene.
 * `score` 0–5: 0 → REJECTED + rewardStatus=NONE; ≥1 → snapshot iznosa iz važeće tarife
 * u rewardAmount + rewardStatus=CONFIRMED + rewardMonth. Radi i bez AI ocene (ručno).
 */
export interface ScoreDto {
  score: number;
}

export function validateScore(dto: ScoreDto): void {
  if (
    typeof dto?.score !== "number" ||
    !Number.isInteger(dto.score) ||
    dto.score < 0 ||
    dto.score > 5
  )
    throw new BadRequestException("Ocena mora biti ceo broj 0–5.");
}

/**
 * Telo za POST /zahtevi/:id/exclude (MODULE_SPEC §12.3) — admin isključi predlog iz
 * nagrađivanja (validan, ali bez novca; npr. iz redovnog radnog zadatka). Razlog opciono.
 */
export interface ExcludeDto {
  reason?: string;
}

export function validateExclude(dto: ExcludeDto): void {
  if (dto?.reason !== undefined && typeof dto.reason !== "string")
    throw new BadRequestException("Razlog mora biti tekst.");
  if (typeof dto?.reason === "string" && dto.reason.length > 500)
    throw new BadRequestException("Razlog može imati najviše 500 znakova.");
}

import { BadRequestException } from "@nestjs/common";

/**
 * Telo za POST /zahtevi/:id/decision (MODULE_SPEC §7) — admin presuda (odobrenje #2
 * i ostale odluke iz inbox-a). Status-prelaze validira status mašina u servisu.
 */
export const DECISION_ACTIONS = [
  "approve", // → APPROVED (odobri realizaciju; iz SUBMITTED preskače analizu, iz ANALYZED redovno)
  "reject", // → REJECTED
  "needs-info", // → NEEDS_INFO (vrati podnosiocu na dopunu)
  "merge", // → MERGED (mergeIntoId obavezan)
  "defer", // → DEFERRED (backlog)
  "archive", // → ARCHIVED
] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export interface DecisionDto {
  action: string;
  note?: string;
  mergeIntoId?: number;
  /** true = uz odluku zabeleži zapis u Decision Log (F4 prečica; F1 prima ali NE realizuje). */
  logDecision?: boolean;
}

export function validateDecision(dto: DecisionDto): void {
  const errors: string[] = [];
  if (!DECISION_ACTIONS.includes(dto.action as DecisionAction))
    errors.push(`Akcija: dozvoljeno ${DECISION_ACTIONS.join(" | ")}.`);
  if (dto.action === "merge") {
    if (
      typeof dto.mergeIntoId !== "number" ||
      !Number.isInteger(dto.mergeIntoId) ||
      dto.mergeIntoId <= 0
    )
      errors.push(
        "Za spajanje je obavezan ID kanonskog zahteva (mergeIntoId).",
      );
  }
  if (errors.length) throw new BadRequestException(errors);
}

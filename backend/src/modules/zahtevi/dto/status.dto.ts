import { BadRequestException } from "@nestjs/common";

/**
 * Telo za POST /zahtevi/:id/status (MODULE_SPEC §7) — realizacioni prelazi (admin) +
 * opciona link polja (grana/PR/verzija/commit/ko je radio). Prelaz validira status mašina.
 */
export const REALIZATION_STATUS_ACTIONS = [
  "planned", // → PLANNED
  "in-progress", // → IN_PROGRESS
  "ready-for-test", // → READY_FOR_TEST
  "testing", // → TESTING
  "done", // → DONE
] as const;
export type RealizationStatusAction =
  (typeof REALIZATION_STATUS_ACTIONS)[number];

export interface StatusDto {
  action: string;
  branchName?: string;
  prUrl?: string;
  commitSha?: string;
  deliveredVersion?: string;
  implementedBy?: string;
  note?: string;
}

export function validateStatus(dto: StatusDto): void {
  const errors: string[] = [];
  if (
    !REALIZATION_STATUS_ACTIONS.includes(dto.action as RealizationStatusAction)
  )
    errors.push(
      `Akcija: dozvoljeno ${REALIZATION_STATUS_ACTIONS.join(" | ")}.`,
    );
  const optStr = (v: unknown, name: string, max: number) => {
    if (v === undefined || v === null) return;
    if (typeof v !== "string") errors.push(`${name} mora biti tekst.`);
    else if (v.length > max)
      errors.push(`${name} može imati najviše ${max} znakova.`);
  };
  optStr(dto.branchName, "Grana", 120);
  optStr(dto.prUrl, "PR URL", 300);
  optStr(dto.commitSha, "Commit", 64);
  optStr(dto.deliveredVersion, "Verzija", 60);
  optStr(dto.implementedBy, "Izvršilac", 120);
  if (errors.length) throw new BadRequestException(errors);
}

import { BadRequestException } from "@nestjs/common";

/**
 * DTO za kreiranje zahteva (MODULE_SPEC_zahtevi §7 POST /zahtevi).
 * Obrazac: interface + ručna validate*() (kao nabavka/kvalitet; class-validator nije
 * uveden — BACKEND_RULES §6). Poruke na srpskom, kod na engleskom.
 */
export const REQUEST_KINDS = [
  "BUG",
  "MISSING_1_0",
  "IMPROVEMENT_3_0",
  "FEATURE_4_0",
  "UI_UX",
  "BUSINESS_RULE",
  "OTHER",
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_AREAS = [
  "DATABASE",
  "BACKEND",
  "FRONTEND",
  "MOBILE",
] as const;
export type RequestArea = (typeof REQUEST_AREAS)[number];

export const REQUEST_PRIORITIES = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

export interface CreateChangeRequestDto {
  title: string;
  description: string;
  expectedBehavior?: string;
  currentBehavior?: string;
  kind?: string;
  module?: string;
  areas?: string[];
  priorityUser?: string;
  /** true = kreiraj i odmah podnesi (DRAFT→SUBMITTED + trijaža). */
  submit?: boolean;
  /** FE idempotencija (postojeći obrazac); servis ga za sada samo prima. */
  clientEventId?: string;
}

export function validateCreateChangeRequest(dto: CreateChangeRequestDto): void {
  const errors: string[] = [];

  if (typeof dto.title !== "string" || dto.title.trim().length === 0)
    errors.push("Naslov je obavezan.");
  else if (dto.title.trim().length > 200)
    errors.push("Naslov može imati najviše 200 znakova.");

  if (
    typeof dto.description !== "string" ||
    dto.description.trim().length === 0
  )
    errors.push("Opis je obavezan.");

  const optEnum = (v: unknown, allowed: readonly string[], name: string) => {
    if (v === undefined || v === null || v === "") return;
    if (typeof v !== "string" || !allowed.includes(v))
      errors.push(`${name}: dozvoljeno ${allowed.join(" | ")}.`);
  };
  optEnum(dto.kind, REQUEST_KINDS, "Tip");
  optEnum(dto.priorityUser, REQUEST_PRIORITIES, "Prioritet");

  if (dto.areas !== undefined) {
    if (!Array.isArray(dto.areas)) errors.push("Oblasti moraju biti lista.");
    else
      for (const a of dto.areas)
        if (!REQUEST_AREAS.includes(a as RequestArea))
          errors.push(
            `Oblast "${a}": dozvoljeno ${REQUEST_AREAS.join(" | ")}.`,
          );
  }

  if (
    dto.module !== undefined &&
    dto.module !== null &&
    typeof dto.module === "string" &&
    dto.module.length > 40
  )
    errors.push("Modul može imati najviše 40 znakova.");

  if (errors.length) throw new BadRequestException(errors);
}

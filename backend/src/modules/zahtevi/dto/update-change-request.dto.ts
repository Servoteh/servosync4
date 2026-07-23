import { BadRequestException } from "@nestjs/common";
import {
  REQUEST_KINDS,
  REQUEST_AREAS,
  REQUEST_PRIORITIES,
  type RequestArea,
} from "./create-change-request.dto";

/**
 * DTO za PATCH /zahtevi/:id (MODULE_SPEC §7).
 * Owner: sadržaj samo u DRAFT (title/description/expected/current/kind/module/areas/priorityUser).
 * Admin: meta bilo kad (module/kind/priorityFinal) → event META_CHANGED (servis odlučuje šta sme).
 * DTO validira SAMO oblik prosleđenih polja; koja su dozvoljena po ulozi/statusu = servis.
 */
export interface UpdateChangeRequestDto {
  title?: string;
  description?: string;
  expectedBehavior?: string | null;
  currentBehavior?: string | null;
  kind?: string | null;
  module?: string | null;
  areas?: string[];
  priorityUser?: string | null;
  priorityFinal?: string | null;
}

export function validateUpdateChangeRequest(dto: UpdateChangeRequestDto): void {
  const errors: string[] = [];

  if (dto.title !== undefined) {
    if (typeof dto.title !== "string" || dto.title.trim().length === 0)
      errors.push("Naslov ne može biti prazan.");
    else if (dto.title.trim().length > 200)
      errors.push("Naslov može imati najviše 200 znakova.");
  }
  if (dto.description !== undefined) {
    if (
      typeof dto.description !== "string" ||
      dto.description.trim().length === 0
    )
      errors.push("Opis ne može biti prazan.");
  }

  const optEnum = (v: unknown, allowed: readonly string[], name: string) => {
    if (v === undefined || v === null || v === "") return;
    if (typeof v !== "string" || !allowed.includes(v))
      errors.push(`${name}: dozvoljeno ${allowed.join(" | ")}.`);
  };
  optEnum(dto.kind, REQUEST_KINDS, "Tip");
  optEnum(dto.priorityUser, REQUEST_PRIORITIES, "Prioritet (podnosilac)");
  optEnum(dto.priorityFinal, REQUEST_PRIORITIES, "Prioritet (finalni)");

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

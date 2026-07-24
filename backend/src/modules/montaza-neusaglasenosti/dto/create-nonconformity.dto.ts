import { BadRequestException } from "@nestjs/common";

/**
 * `POST /montaza/neusaglasenosti` — prijava neusaglašenosti na montaži
 * (MODULE_SPEC_montaza_neusaglasenosti §3). Obavezno: `projectNumber`, `description`,
 * `severity`, `locationKind` (+ `locationNote` za TEREN). class-validator još nije uveden
 * (BACKEND_RULES §6) — ručna provera, isti obrazac kao kvalitet DTO.
 */

/** Ozbiljnost — fiksna lista (String, ne Prisma enum; BACKEND_RULES §2). */
export const SEVERITIES = ["MALA", "SREDNJA", "VISOKA"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Mesto neusaglašenosti. */
export const LOCATION_KINDS = ["SERVOTEH", "TEREN"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

export interface CreateNonconformityDto {
  /** Broj predmeta (obavezan; lookup kroz montaza/lookups/predmeti). */
  projectNumber: string;
  /** Meki ref projects.id kad ga picker razreši (opciono). */
  projectId?: number | null;
  /** Opis problema (obavezan). */
  description: string;
  /** MALA | SREDNJA | VISOKA. */
  severity: string;
  /** SERVOTEH | TEREN. */
  locationKind: string;
  /** Za TEREN: koja lokacija (obavezno kad je TEREN). */
  locationNote?: string | null;
  drawingNumber?: string | null;
  /** RN broj (slobodan tekst, meki). */
  workOrderCode?: string | null;
}

export function validateCreateNonconformity(dto: CreateNonconformityDto): void {
  const errors: string[] = [];

  if (typeof dto?.projectNumber !== "string" || !dto.projectNumber.trim())
    errors.push("Polje 'projectNumber' (broj predmeta) je obavezno.");

  if (typeof dto?.description !== "string" || !dto.description.trim())
    errors.push("Polje 'description' (opis problema) je obavezno.");

  if (!(SEVERITIES as readonly string[]).includes(dto?.severity))
    errors.push(`Polje 'severity' mora biti: ${SEVERITIES.join(", ")}.`);

  if (!(LOCATION_KINDS as readonly string[]).includes(dto?.locationKind))
    errors.push(
      `Polje 'locationKind' mora biti: ${LOCATION_KINDS.join(", ")}.`,
    );

  // Za TEREN je lokacija obavezna (gde se desilo) — SERVOTEH je podrazumevana lokacija.
  if (
    dto?.locationKind === "TEREN" &&
    (typeof dto?.locationNote !== "string" || !dto.locationNote.trim())
  )
    errors.push(
      "Za lokaciju TEREN obavezno je polje 'locationNote' (koja lokacija).",
    );

  if (
    dto?.projectId !== undefined &&
    dto.projectId !== null &&
    (!Number.isInteger(dto.projectId) || dto.projectId < 1)
  )
    errors.push("Polje 'projectId' mora biti ceo broj ≥ 1.");

  if (errors.length) throw new BadRequestException(errors);
}

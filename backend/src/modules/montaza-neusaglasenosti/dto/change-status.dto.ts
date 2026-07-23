import { BadRequestException } from "@nestjs/common";

/**
 * `POST /montaza/neusaglasenosti/:id/status` — prelaz statusa (manage).
 * Ciljni status; dozvoljeni prelazi presuđuje servis (§2 status mašina).
 */
export const NC_STATUSES = ["CEKA_ANALIZU", "U_TOKU", "ZAVRSENO"] as const;
export type NcStatus = (typeof NC_STATUSES)[number];

export interface ChangeStatusDto {
  /** Ciljni status: CEKA_ANALIZU | U_TOKU | ZAVRSENO. */
  status: string;
  /** Opciona napomena (upisuje se u event data). */
  note?: string | null;
}

export function validateChangeStatus(dto: ChangeStatusDto): void {
  const errors: string[] = [];
  if (!(NC_STATUSES as readonly string[]).includes(dto?.status))
    errors.push(`Polje 'status' mora biti: ${NC_STATUSES.join(", ")}.`);
  if (
    dto?.note !== undefined &&
    dto.note !== null &&
    typeof dto.note !== "string"
  )
    errors.push("Polje 'note' mora biti tekst ili null.");
  if (errors.length) throw new BadRequestException(errors);
}

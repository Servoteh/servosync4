import { BadRequestException } from "@nestjs/common";

/**
 * DTO-ovi za ulazne (purchase) e-fakture — SEF ulazni tok (doc 07 §5).
 * Obrazac: interface + ručna validate*() (kao create-proforma / nabavka;
 * class-validator još nije uveden — BACKEND_RULES §6). Poruke na srpskom.
 */

/** Dozvoljeni lokalni statusi ulazne fakture (SefIncomingInvoice.status). */
export const SEF_INCOMING_STATUSES = ["NEW", "SEEN", "ACCEPTED", "REJECTED"] as const;

/** Query za listu ulaznih faktura (GET /sef/incoming). */
export interface ListSefIncomingQuery {
  status?: string; // NEW | SEEN | ACCEPTED | REJECTED
  deadlineSoon?: boolean; // samo one kojima ističe rok (15 dana) uskoro
}

export function normalizeListSefIncomingQuery(raw: {
  status?: string;
  deadlineSoon?: string;
}): ListSefIncomingQuery {
  const bool = (v?: string) =>
    v === undefined ? undefined : v === "true" || v === "1";
  const status = raw.status ? raw.status.trim().toUpperCase() : undefined;
  if (
    status !== undefined &&
    !SEF_INCOMING_STATUSES.includes(status as (typeof SEF_INCOMING_STATUSES)[number])
  ) {
    throw new BadRequestException(
      `Nepoznat status "${raw.status}" — dozvoljeno: ${SEF_INCOMING_STATUSES.join(", ")}.`,
    );
  }
  return { status, deadlineSoon: bool(raw.deadlineSoon) };
}

/** Telo za povlačenje ulaznih faktura sa SEF-a (POST /sef/incoming/pull). */
export interface PullSefIncomingDto {
  /** Opcioni ISO datum od kog se povlače fakture (dateFrom). */
  dateFrom?: string;
}

export function validatePullSefIncoming(dto: PullSefIncomingDto): void {
  if (dto.dateFrom !== undefined) {
    if (typeof dto.dateFrom !== "string" || Number.isNaN(Date.parse(dto.dateFrom))) {
      throw new BadRequestException("Datum (dateFrom) nije ispravan.");
    }
  }
}

/** Telo za odbijanje ulazne fakture (POST /sef/incoming/:id/reject). */
export interface RejectSefIncomingDto {
  comment: string;
}

/**
 * Validira i vraća očišćen razlog odbijanja (obavezan, max 500 — kolona
 * SefIncomingInvoice.rejectComment @db.VarChar(500)).
 */
export function validateRejectSefIncoming(dto: RejectSefIncomingDto): string {
  const comment = typeof dto?.comment === "string" ? dto.comment.trim() : "";
  if (comment.length === 0) {
    throw new BadRequestException("Razlog odbijanja (comment) je obavezan.");
  }
  if (comment.length > 500) {
    throw new BadRequestException(
      "Razlog odbijanja sme imati najviše 500 karaktera.",
    );
  }
  return comment;
}

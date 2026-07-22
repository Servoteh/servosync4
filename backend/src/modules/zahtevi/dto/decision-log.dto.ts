import { BadRequestException } from "@nestjs/common";

/**
 * Telo za POST /zahtevi/odluke (MODULE_SPEC §6) — nova odluka u Decision Log.
 * Supersede se radi zasebnim endpointom; ovde je čisti unos (retroaktivan datum dozvoljen).
 */
export interface CreateDecisionLogDto {
  title: string;
  decision: string;
  context?: string;
  consequences?: string;
  tags?: string[];
  relatedRequestId?: number;
  /** "YYYY-MM-DD"; podrazumeva se današnji datum ako se izostavi. */
  decidedOn?: string;
}

/** Telo za PATCH /zahtevi/odluke/:id — sitne ispravke (supersede za suštinske promene). */
export interface UpdateDecisionLogDto {
  title?: string;
  decision?: string;
  context?: string | null;
  consequences?: string | null;
  tags?: string[];
  relatedRequestId?: number | null;
  decidedOn?: string;
}

/** Telo za POST /zahtevi/odluke/:id/supersede — nova odluka koja zamenjuje staru. */
export interface SupersedeDecisionLogDto {
  title: string;
  decision: string;
  context?: string;
  consequences?: string;
  tags?: string[];
  relatedRequestId?: number;
  decidedOn?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateTags(tags: unknown, errors: string[]): void {
  if (tags === undefined) return;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string"))
    errors.push("Tagovi moraju biti niz tekstova.");
  else if (tags.length > 20) errors.push("Najviše 20 tagova.");
}

function validateDecidedOn(v: unknown, errors: string[]): void {
  if (v === undefined) return;
  if (typeof v !== "string" || !DATE_RE.test(v) || Number.isNaN(Date.parse(v)))
    errors.push("Datum odluke mora biti oblika YYYY-MM-DD.");
}

function validateRelated(v: unknown, errors: string[]): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    errors.push("Veza na zahtev mora biti pozitivan ceo broj.");
}

export function validateCreateDecisionLog(dto: CreateDecisionLogDto): void {
  const errors: string[] = [];
  if (typeof dto?.title !== "string" || !dto.title.trim())
    errors.push("Naslov je obavezan.");
  else if (dto.title.length > 200)
    errors.push("Naslov može imati najviše 200 znakova.");
  if (typeof dto?.decision !== "string" || !dto.decision.trim())
    errors.push("Odluka (ŠTA je odlučeno) je obavezna.");
  validateTags(dto?.tags, errors);
  validateDecidedOn(dto?.decidedOn, errors);
  validateRelated(dto?.relatedRequestId, errors);
  if (errors.length) throw new BadRequestException(errors);
}

export function validateUpdateDecisionLog(dto: UpdateDecisionLogDto): void {
  const errors: string[] = [];
  if (dto?.title !== undefined) {
    if (typeof dto.title !== "string" || !dto.title.trim())
      errors.push("Naslov ne može biti prazan.");
    else if (dto.title.length > 200)
      errors.push("Naslov može imati najviše 200 znakova.");
  }
  if (dto?.decision !== undefined) {
    if (typeof dto.decision !== "string" || !dto.decision.trim())
      errors.push("Odluka ne može biti prazna.");
  }
  validateTags(dto?.tags, errors);
  validateDecidedOn(dto?.decidedOn, errors);
  validateRelated(dto?.relatedRequestId, errors);
  if (errors.length) throw new BadRequestException(errors);
}

export function validateSupersedeDecisionLog(
  dto: SupersedeDecisionLogDto,
): void {
  // Ista pravila kao create (nova odluka je pun zapis).
  validateCreateDecisionLog(dto);
}

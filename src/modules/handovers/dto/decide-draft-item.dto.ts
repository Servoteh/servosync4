import { BadRequestException } from "@nestjs/common";

/**
 * Odluka projektanta nad SPORNOM stavkom nacrta (`pre_check_duplicate=true`) —
 * legacy `OdlukaAkcija` (viewOdlukePredProvera / MODULE_SPEC_nacrti_primopredaje
 * §7.2), P4_SPEC_pdm_intake_PREDLOG §0 t.4 + §6.5.4 (odluka Nenad 11.07).
 */
export const DRAFT_ITEM_DECISION = {
  /** 0 — nerešeno; sporna stavka sa ovom vrednošću blokira submit(). */
  NONE: 0,
  /** 1 — Isključi stavku iz primopredaje (`exclude_from_handover=true`). */
  EXCLUDE: 1,
  /** 2 — Predaj ponovo (svesno prihvata duplikat, količina ostaje). */
  RESUBMIT: 2,
  /** 3 — Dopuni razliku (koriguje količinu — traži `newQuantity`). */
  ADJUST: 3,
} as const;

/** POST /handover-drafts/:id/items/:itemId/decision */
export interface DecideDraftItemDto {
  /** 1=Isključi | 2=Predaj ponovo | 3=Dopuni (koriguj količinu). */
  action: number;
  /** Nova količina za izradu — obavezno uz `action=3`, zabranjeno inače. */
  newQuantity?: number;
}

export function validateDecideDraftItem(dto: DecideDraftItemDto): void {
  const errors: string[] = [];
  const allowed: number[] = [
    DRAFT_ITEM_DECISION.EXCLUDE,
    DRAFT_ITEM_DECISION.RESUBMIT,
    DRAFT_ITEM_DECISION.ADJUST,
  ];
  if (typeof dto?.action !== "number" || !allowed.includes(dto.action)) {
    errors.push(
      "Akcija mora biti 1 (Isključi stavku), 2 (Predaj ponovo) ili 3 (Dopuni).",
    );
  }
  if (dto?.action === DRAFT_ITEM_DECISION.ADJUST) {
    if (
      typeof dto.newQuantity !== "number" ||
      !Number.isInteger(dto.newQuantity) ||
      dto.newQuantity < 1
    ) {
      errors.push(
        "Uz akciju Dopuni (3) obavezna je nova količina — ceo broj ≥ 1.",
      );
    }
  } else if (dto?.newQuantity !== undefined) {
    // Ne ignoriši tiho — količina se koriguje SAMO kroz akciju 3.
    errors.push("Nova količina se šalje samo uz akciju Dopuni (3).");
  }
  if (errors.length) throw new BadRequestException(errors);
}

import { BadRequestException } from "@nestjs/common";

/**
 * Parcijalni update zaglavlja nacrta (§6.1). Immutable polja (namerno
 * izostavljena ovde): `designerId`, `draftNumber`, `createdAt`. Stavke se NE
 * menjaju kroz ovaj DTO (nema item-level PATCH/POST endpointa ovog talasa —
 * samo osnovni unos, vidi zadatak).
 */
export interface UpdateHandoverDraftDto {
  /** Ne može se menjati ako nacrt već ima stavke (§6.1 pravilo). */
  projectId?: number;
  mainDrawingId?: number | null;
  draftType?: number;
  pieceCount?: number;
  note?: string | null;
  /** Mora postojati u `handover_draft_statuses` — proverava se u servisu. */
  statusId?: number;
}

export function validateUpdateHandoverDraft(dto: UpdateHandoverDraftDto): void {
  const errors: string[] = [];
  if (dto?.projectId !== undefined) {
    if (!Number.isInteger(dto.projectId) || dto.projectId <= 0)
      errors.push("Predmet mora biti ispravan ID.");
  }
  if (dto?.mainDrawingId !== undefined && dto.mainDrawingId !== null) {
    if (!Number.isInteger(dto.mainDrawingId) || dto.mainDrawingId <= 0)
      errors.push("Glavni crtež sklopa mora biti ispravan ID.");
  }
  if (dto?.draftType !== undefined) {
    if (!Number.isInteger(dto.draftType) || dto.draftType < 0)
      errors.push("Tip nacrta mora biti ceo broj ≥ 0.");
  }
  if (dto?.pieceCount !== undefined) {
    if (!Number.isInteger(dto.pieceCount) || dto.pieceCount < 1)
      errors.push("Broj komada mora biti ceo broj ≥ 1.");
  }
  if (dto?.note !== undefined && dto.note !== null && dto.note.length > 250) {
    errors.push("Napomena može imati najviše 250 karaktera.");
  }
  if (dto?.statusId !== undefined) {
    if (!Number.isInteger(dto.statusId) || dto.statusId < 0)
      errors.push("Status mora biti ceo broj ≥ 0.");
  }
  if (errors.length) throw new BadRequestException(errors);
}

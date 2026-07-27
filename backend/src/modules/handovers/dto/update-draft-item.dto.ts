import { BadRequestException } from "@nestjs/common";

/**
 * Izmena POSTOJEĆE stavke nacrta (zahtev 027/26, Igor 26.07): „izmeni dugme ne
 * dozvoljava da se menja broj komada". Namerno UZAK skup polja — menja se samo
 * ono što projektant ispravlja nad radnim nacrtom:
 *   - `quantityToProduce` — broj komada za izradu (ceo broj ≥ 1),
 *   - `note` — napomena stavke (≤ 250, kao `handover_draft_items.note`).
 *
 * NE menjaju se ovim putem: `drawingId` (zamena crteža = obriši stavku pa
 * dodaj novu — inače bi se zaobišli §6.5.3 preduslovi i §6.5.4 pre-check koji
 * se računaju NAD CRTEŽOM pri dodavanju), `pre_check_*` i `decision_*`
 * (provenance/odluka — pišu ih `preCheckItems` i `decideItem`),
 * `excludeFromHandover` (isključenje ide kroz odluku §6.5.4).
 */
export interface UpdateDraftItemDto {
  /** Broj komada za izradu — ceo broj ≥ 1. */
  quantityToProduce?: number;
  /** Napomena stavke; `null`/prazno briše napomenu. */
  note?: string | null;
}

export function validateUpdateDraftItem(dto: UpdateDraftItemDto): void {
  const errors: string[] = [];
  const hasQuantity = dto?.quantityToProduce !== undefined;
  const hasNote = dto?.note !== undefined;

  if (!hasQuantity && !hasNote)
    errors.push("Nema šta da se izmeni — pošaljite količinu i/ili napomenu.");

  if (hasQuantity) {
    if (
      !Number.isInteger(dto.quantityToProduce) ||
      (dto.quantityToProduce as number) < 1
    )
      errors.push("Količina za izradu mora biti ceo broj ≥ 1.");
  }
  if (hasNote && dto.note != null && dto.note.length > 250)
    errors.push("Napomena može imati najviše 250 karaktera.");

  if (errors.length) throw new BadRequestException(errors);
}

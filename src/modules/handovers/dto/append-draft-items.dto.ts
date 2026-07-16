import { BadRequestException } from "@nestjs/common";

/**
 * Dodavanje stavki u POSTOJEĆI (nezaključan) nacrt iz PDM-a — „Dodaj u nacrt"
 * (Nenad 16.07). Namerno UŽE od `CreateHandoverDraftItemInput`: klijent šalje
 * samo crtež (iz BOM stabla) i opcionu količinu; ostala polja stavke
 * (mainDrawingId/isMain/note/…) servis puni default-ima kao u `create()`.
 * Preduslove stavke (§6.5.3) i pre-check duplikata (§6.5.4) servis računa sam
 * (isti helperi kao `create()`) — klijent NE šalje pre_check_* polja.
 */
export interface AppendDraftItemInput {
  /** Crtež stavke — obavezno (`drawing_id` nema DB FK, validira se u servisu). */
  drawingId: number;
  /** Broj komada za izradu — opciono (default kao u `create()`: 1). */
  quantity?: number;
}

/** POST /handover-drafts/:id/items — batch dodavanje (1..50 stavki). */
export interface AppendDraftItemsDto {
  items: AppendDraftItemInput[];
}

/** Gornja granica batch-a — paritet legacy „dodaj sve iz sastavnice" (ograniči DoS). */
const MAX_APPEND_ITEMS = 50;

export function validateAppendDraftItems(dto: AppendDraftItemsDto): void {
  const errors: string[] = [];
  const items = dto?.items;
  if (!Array.isArray(items) || items.length === 0) {
    errors.push("Stavke moraju biti neprazan niz.");
  } else {
    if (items.length > MAX_APPEND_ITEMS)
      errors.push(`Najviše ${MAX_APPEND_ITEMS} stavki po zahtevu.`);
    items.forEach((item, idx) => {
      if (
        typeof item?.drawingId !== "number" ||
        !Number.isInteger(item.drawingId) ||
        item.drawingId <= 0
      ) {
        errors.push(`Stavka #${idx + 1}: crtež je obavezan.`);
      }
      if (
        item?.quantity !== undefined &&
        (!Number.isInteger(item.quantity) || item.quantity < 1)
      ) {
        errors.push(
          `Stavka #${idx + 1}: količina za izradu mora biti ceo broj ≥ 1.`,
        );
      }
    });
  }
  if (errors.length) throw new BadRequestException(errors);
}

import { BadRequestException } from "@nestjs/common";

/**
 * Dodavanje stavki u POSTOJEĆI (nezaključan) nacrt iz PDM-a — „Dodaj u nacrt"
 * (Nenad 16.07). Namerno UŽE od `CreateHandoverDraftItemInput`: klijent šalje
 * crtež (iz BOM stabla), opcionu količinu i — od dopune 027/26 (Igor 30.07,
 * „pita da li hoću sve pozicije iz sklopa") — opcionu BOM provenance pozicije
 * (`mainDrawingId` = sklop iz čije sastavnice stavka dolazi,
 * `quantityDefinedInDrawing` = potreba po 1 komadu tog sklopa). Ostala polja
 * stavke (isMain/note/…) servis puni default-ima kao u `create()`.
 * Preduslove stavke (§6.5.3) i pre-check duplikata (§6.5.4) servis računa sam
 * (isti helperi kao `create()`) — klijent NE šalje pre_check_* polja.
 */
export interface AppendDraftItemInput {
  /** Crtež stavke — obavezno (`drawing_id` nema DB FK, validira se u servisu). */
  drawingId: number;
  /** Broj komada za izradu — opciono (default kao u `create()`: 1). */
  quantity?: number;
  /**
   * Vodeći sklop pozicije (027/26 dopuna): kad se u nacrt ubacuje sklop SA
   * pozicijama, svaka pozicija nosi id sklopa — kolona „Vodeći sklop" u detalju
   * nacrta + tačniji §6.5.4 pre-check količine (poredi se sa sastavnicom OVOG
   * sklopa, ne zaglavlja nacrta). Postojanje validira servis (kao `create()`).
   */
  mainDrawingId?: number;
  /** Količina po sastavnici za 1 komad vodećeg sklopa — opciono (default 0). */
  quantityDefinedInDrawing?: number;
}

/** POST /handover-drafts/:id/items — batch dodavanje (1..500 stavki). */
export interface AppendDraftItemsDto {
  items: AppendDraftItemInput[];
}

/**
 * Gornja granica batch-a — paritet legacy „dodaj sve iz sastavnice" (ograniči
 * DoS). Podignuto 50 → 500 uz dopunu 027/26 („ubaci i sve pozicije sklopa"):
 * izmereno na produ 04.08.2026 — najveća rekurzivna sastavnica ima 223
 * jedinstvene pozicije (crtež 1139290 „Merna stanica"), najviše direktne dece
 * 113 (1110817) — 50 bi obaralo legitiman „Da — ubaci i pozicije" batch.
 */
const MAX_APPEND_ITEMS = 500;

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
      if (
        item?.mainDrawingId !== undefined &&
        (!Number.isInteger(item.mainDrawingId) || item.mainDrawingId <= 0)
      ) {
        errors.push(`Stavka #${idx + 1}: vodeći sklop mora biti ispravan ID.`);
      }
      if (
        item?.quantityDefinedInDrawing !== undefined &&
        (!Number.isInteger(item.quantityDefinedInDrawing) ||
          item.quantityDefinedInDrawing < 0)
      ) {
        errors.push(
          `Stavka #${idx + 1}: količina po sastavnici mora biti ceo broj ≥ 0.`,
        );
      }
    });
  }
  if (errors.length) throw new BadRequestException(errors);
}

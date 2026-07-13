import { BadRequestException } from "@nestjs/common";

/**
 * Jedna stavka nacrta pri kreiranju (MODULE_SPEC_nacrti_primopredaje §6.2).
 * Bez BOM auto-populate wizarda (van skopa). Pre-check duplikata (§7.2 /
 * P4_SPEC §6.5.4) i preduslove stavke (§6.5.3) servis računa sam — klijent
 * NE šalje pre_check_* polja.
 */
export interface CreateHandoverDraftItemInput {
  /** Crtež stavke — obavezno (`drawing_id` nema DB FK, validira se ovde). */
  drawingId: number;
  quantityToProduce?: number;
  mainDrawingId?: number;
  isMain?: boolean;
  note?: string;
  quantityDefinedInDrawing?: number;
}

/**
 * Kreiranje nacrta primopredaje (`handover_drafts` + `handover_draft_items`).
 * `draftNumber` generiše server (DraftNumberingService); `statusId`/`isLocked`
 * kreću od inicijalnih vrednosti (0 / false) — predaja u primopredaju (submit)
 * NIJE deo ovog talasa (van skopa zadatka).
 */
export interface CreateHandoverDraftDto {
  /**
   * Projektant (FK workers) — OPCION od 13.07.2026 (proba): kad se izostavi,
   * servis uzima ULOGOVANOG korisnika (JWT workerId). Radnik mora biti AKTIVAN
   * (validira servis).
   */
  designerId?: number;
  /** Predmet — obavezno (FK projects); tačka dodele predmeta crtežima. */
  projectId: number;
  /** Glavni crtež sklopa — opciono (FK drawings). */
  mainDrawingId?: number;
  /** 0=Glavni sklop, 1=Pojedinačni sklop, 2=Podsklopovi (§3.1, nepotvrđeno). */
  draftType?: number;
  /** Broj komada za proizvodnju — obavezno. */
  pieceCount: number;
  note?: string;
  items?: CreateHandoverDraftItemInput[];
}

export function validateCreateHandoverDraft(dto: CreateHandoverDraftDto): void {
  const errors: string[] = [];
  const reqPosInt = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
      errors.push(`${name} je obavezan.`);
  };
  // designerId je opcion (default = ulogovani u servisu); kad JESTE poslat,
  // mora biti pozitivan ceo broj.
  if (dto?.designerId !== undefined) reqPosInt(dto.designerId, "Projektant");
  reqPosInt(dto?.projectId, "Predmet");
  if (
    typeof dto?.pieceCount !== "number" ||
    !Number.isInteger(dto.pieceCount) ||
    dto.pieceCount < 1
  ) {
    errors.push("Broj komada mora biti ceo broj ≥ 1.");
  }
  if (dto?.mainDrawingId !== undefined) {
    if (!Number.isInteger(dto.mainDrawingId) || dto.mainDrawingId <= 0)
      errors.push("Glavni crtež sklopa mora biti ispravan ID.");
  }
  if (dto?.draftType !== undefined) {
    if (!Number.isInteger(dto.draftType) || dto.draftType < 0)
      errors.push("Tip nacrta mora biti ceo broj ≥ 0.");
  }
  if (dto?.note !== undefined && dto.note !== null && dto.note.length > 250) {
    errors.push("Napomena može imati najviše 250 karaktera.");
  }

  const items = dto?.items ?? [];
  if (!Array.isArray(items)) {
    errors.push("Stavke moraju biti niz.");
  } else {
    items.forEach((item, idx) => {
      if (
        typeof item?.drawingId !== "number" ||
        !Number.isInteger(item.drawingId) ||
        item.drawingId <= 0
      ) {
        errors.push(`Stavka #${idx + 1}: crtež je obavezan.`);
      }
      if (
        item?.quantityToProduce !== undefined &&
        (!Number.isInteger(item.quantityToProduce) ||
          item.quantityToProduce < 1)
      ) {
        errors.push(
          `Stavka #${idx + 1}: količina za izradu mora biti ceo broj ≥ 1.`,
        );
      }
      if (
        item?.mainDrawingId !== undefined &&
        (!Number.isInteger(item.mainDrawingId) || item.mainDrawingId <= 0)
      ) {
        errors.push(
          `Stavka #${idx + 1}: glavni crtež sklopa mora biti ispravan ID.`,
        );
      }
    });
  }

  if (errors.length) throw new BadRequestException(errors);
}

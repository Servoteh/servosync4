import { UnprocessableEntityException } from "@nestjs/common";

/**
 * Premeštanje pozicije u CAM redu (prevlačenje) — Miljan/Nikola/Jovica.
 *
 * TAČNO JEDNA semantika po zahtevu:
 *  - `afterWorkOrderId`: ubaci prevučenu poziciju NEPOSREDNO ISPOD tog reda;
 *    `null` = na vrh reda. Vrednost (kad nije null) mora biti trenutno RANGIRAN
 *    red (queue_order NOT NULL) — validira servis.
 *  - `remove: true`: skini poziciju iz rangiranja (queue_order → NULL).
 *
 * Oba prisutna ili nijedno = 422 (dvosmislen zahtev).
 */
export interface MoveCncQueueDto {
  afterWorkOrderId?: number | null;
  remove?: boolean;
}

export function validateMoveCncQueue(dto: MoveCncQueueDto): void {
  const hasAfter = dto != null && "afterWorkOrderId" in dto;
  const hasRemove = dto != null && "remove" in dto && dto.remove !== undefined;

  // Tačno jedna semantika: ubacivanje (afterWorkOrderId) ILI uklanjanje (remove).
  if (hasAfter && hasRemove)
    throw new UnprocessableEntityException(
      "Navedi ili 'afterWorkOrderId' ili 'remove', ne oba.",
    );
  if (!hasAfter && !hasRemove)
    throw new UnprocessableEntityException(
      "Zahtev mora imati 'afterWorkOrderId' (broj ili null) ili 'remove: true'.",
    );

  if (hasRemove && dto.remove !== true)
    throw new UnprocessableEntityException(
      "Polje 'remove' sme biti samo true.",
    );

  if (hasAfter) {
    const v = dto.afterWorkOrderId;
    if (v !== null) {
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
        throw new UnprocessableEntityException(
          "Polje 'afterWorkOrderId' mora biti pozitivan ceo broj ili null.",
        );
    }
  }
}

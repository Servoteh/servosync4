import { BadRequestException } from "@nestjs/common";

/**
 * DTO za prihvatanje ponude po upitu (SupplierRfq → QUOTED). Po stavci opciono:
 * ponuđena cena (`offeredPrice`) i rok isporuke (`offeredLeadTimeDays`).
 *
 * VAŽNO (šema): CENA se NE upisuje na stavku upita — model `SupplierRfqItem` nema
 * kolonu za cenu (BigBit pravilo: cena tek u narudžbenici, doc 24). Ponuđena cena
 * se zato prosleđuje u `createOrderDraft` (spreman za postojeći `createOrder`), a
 * na upitu se čuva samo rok isporuke + `isAccepted`. Obrazac: interface + ručna
 * validate*() (kao ostatak nabavka DTO-a; class-validator još nije uveden).
 */
export interface AcceptQuoteLineInput {
  /** Stavka upita (`supplier_rfq_items.id`). `itemId` je prihvaćen kao alias. */
  rfqItemId?: number;
  itemId?: number;
  /** Ponuđena cena po jedinici — ide u narudžbenicu (unitPrice), ne na upit. */
  offeredPrice?: number;
  /** Ponuđeni rok isporuke u danima (upisuje se na stavku upita). */
  offeredLeadTimeDays?: number;
}

export interface AcceptQuoteDto {
  items?: AcceptQuoteLineInput[];
}

export function validateAcceptQuote(dto: AcceptQuoteDto): void {
  const errors: string[] = [];

  if (dto.items !== undefined) {
    if (!Array.isArray(dto.items)) {
      errors.push("Stavke moraju biti niz.");
    } else {
      dto.items.forEach((it, i) => {
        const key = it.rfqItemId ?? it.itemId;
        if (key !== undefined && (!Number.isInteger(key) || key <= 0))
          errors.push(`Stavka ${i + 1}: neispravan identifikator stavke.`);
        if (
          it.offeredPrice != null &&
          (typeof it.offeredPrice !== "number" ||
            Number.isNaN(it.offeredPrice) ||
            it.offeredPrice < 0)
        )
          errors.push(`Stavka ${i + 1}: cena mora biti nenegativan broj.`);
        if (
          it.offeredLeadTimeDays != null &&
          (!Number.isInteger(it.offeredLeadTimeDays) ||
            it.offeredLeadTimeDays < 0)
        )
          errors.push(
            `Stavka ${i + 1}: rok isporuke mora biti nenegativan ceo broj.`,
          );
      });
    }
  }

  if (errors.length) throw new BadRequestException(errors);
}

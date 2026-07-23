import { BadRequestException } from "@nestjs/common";

/**
 * DTO za kreiranje narudžbenice (PurchaseOrder). BigBit „Naručivanje robe" —
 * cena se unosi tek ovde (ne u upitu). Može nastati iz prihvaćenog upita (rfqId)
 * ili direktno. Obrazac: interface + validate*() (BACKEND_RULES §6).
 */
export interface CreatePurchaseOrderItemInput {
  articleId?: number | null;
  description?: string | null;
  orderedQuantity: number; // TrebKol (> 0)
  unitPrice?: number | null; // cena (Decimal)
  unit?: string | null;
  rfqItemId?: number | null;
  requestItemId?: number | null;
}

export interface CreatePurchaseOrderDto {
  supplierId: number; // IDUKorist — dobavljač (meki ref customers.id)
  rfqId?: number | null; // iz kog upita (opciono)
  projectId?: number | null; // nasleđen predmet
  currency?: string;
  note?: string | null;
  items: CreatePurchaseOrderItemInput[];
}

export function validateCreatePurchaseOrder(dto: CreatePurchaseOrderDto): void {
  const errors: string[] = [];

  if (!Number.isInteger(dto.supplierId) || dto.supplierId <= 0)
    errors.push("Dobavljač (supplierId) je obavezan.");

  if (!Array.isArray(dto.items) || dto.items.length === 0)
    errors.push("Narudžbenica mora imati bar jednu stavku.");
  else
    dto.items.forEach((it, i) => {
      if (
        typeof it.orderedQuantity !== "number" ||
        Number.isNaN(it.orderedQuantity) ||
        it.orderedQuantity <= 0
      )
        errors.push(`Stavka ${i + 1}: količina mora biti pozitivan broj.`);
      if (
        it.unitPrice != null &&
        (typeof it.unitPrice !== "number" || Number.isNaN(it.unitPrice) || it.unitPrice < 0)
      )
        errors.push(`Stavka ${i + 1}: cena mora biti nenegativan broj.`);
      if (
        (it.articleId == null || it.articleId <= 0) &&
        (!it.description || it.description.trim() === "")
      )
        errors.push(`Stavka ${i + 1}: navedi artikal ili opis.`);
    });

  if (dto.currency !== undefined && (typeof dto.currency !== "string" || dto.currency.length > 3))
    errors.push("Valuta mora biti oznaka do 3 znaka.");

  if (errors.length) throw new BadRequestException(errors);
}

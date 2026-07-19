import { BadRequestException } from "@nestjs/common";

/**
 * NACRT — DTO za kreiranje zahteva za nabavku.
 * Obrazac: interface + ručna validate*() (kao handovers/kvalitet dto; class-validator
 * još nije uveden — BACKEND_RULES §6). Vrednosti na srpskom (poruke), kod na engleskom.
 */
export interface CreatePurchaseRequestItemInput {
  articleId?: number;
  description?: string;
  quantity: number;
  unit?: string;
  createRfq?: boolean;
  suggestedSupplierId?: number;
}

export interface CreatePurchaseRequestDto {
  projectId: number; // IDPredmetDok — obavezno (kičma)
  workOrderId?: number;
  note?: string;
  items: CreatePurchaseRequestItemInput[];
}

export function validateCreatePurchaseRequest(
  dto: CreatePurchaseRequestDto,
): void {
  const errors: string[] = [];

  const reqPosInt = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
      errors.push(`${name} je obavezan.`);
  };
  const optPosInt = (v: unknown, name: string) => {
    if (v === undefined || v === null) return;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
      errors.push(`${name} mora biti pozitivan ceo broj.`);
  };

  reqPosInt(dto.projectId, "Predmet"); // ProjectRequired — "Niste definisali predmet!!!"
  optPosInt(dto.workOrderId, "Radni nalog");

  if (!Array.isArray(dto.items) || dto.items.length === 0) {
    errors.push("Zahtev mora imati bar jednu stavku.");
  } else {
    dto.items.forEach((it, i) => {
      const hasArticle =
        typeof it.articleId === "number" && Number.isInteger(it.articleId);
      const hasDesc =
        typeof it.description === "string" && it.description.trim().length > 0;
      if (!hasArticle && !hasDesc)
        errors.push(`Stavka ${i + 1}: artikal ili opis je obavezan.`);
      if (typeof it.quantity !== "number" || !(it.quantity > 0))
        errors.push(`Stavka ${i + 1}: količina mora biti veća od 0.`);
      optPosInt(it.suggestedSupplierId, `Stavka ${i + 1}: dobavljač`);
    });
  }

  if (errors.length) throw new BadRequestException(errors);
}

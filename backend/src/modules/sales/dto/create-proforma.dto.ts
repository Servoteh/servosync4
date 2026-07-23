import { BadRequestException } from "@nestjs/common";

/**
 * DTO za kreiranje predračuna/ponude (PON/PROF, draft level 250).
 * Obrazac: interface + ručna validate*() (kao nabavka/handovers/kvalitet; class-validator
 * još nije uveden — BACKEND_RULES §6). Poruke na srpskom, kod na engleskom.
 */
export interface CreateProformaItemInput {
  itemId?: number; // artikal iz šifarnika (null za slobodnu uslužnu stavku)
  description?: string; // opis stavke (obavezan ako nema itemId)
  quantity: number;
  /** eksplicitna VP cena (za slobodnu uslužnu stavku); inače iz PricingService. */
  unitPrice?: number;
  /** eksplicitni rabat %; inače iz rabatne politike (CustomerDiscount). */
  discountPercent?: number;
  cashDiscountPercent?: number;
  vatRateCode?: string;
}

export interface CreateProformaDto {
  /** PON | PROF — draft predračun/ponuda (level 250). Default PROF. */
  documentType?: string;
  companyId?: number; // firma izdavalac (default 0)
  customerId: number; // kupac (meki ref customers.id)
  documentDate?: string; // ISO datum; default danas
  dueDate?: string; // valuta / rok plaćanja (ISO)
  currency?: string; // RSD (domaći) | EUR (izvoz)
  isExport?: boolean; // izvoz (ExportInvoicePolicy)
  /** Broj narudžbenice kupca → UBL cac:OrderReference (SEF javni sektor, D6). Max 50. */
  poNumber?: string;
  note?: string;
  items: CreateProformaItemInput[];
}

const DRAFT_TYPES = new Set(["PON", "PROF"]);

export function validateCreateProforma(dto: CreateProformaDto): void {
  const errors: string[] = [];

  if (
    dto.documentType !== undefined &&
    !DRAFT_TYPES.has(dto.documentType)
  ) {
    errors.push("Vrsta predračuna mora biti PON ili PROF.");
  }

  if (
    typeof dto.customerId !== "number" ||
    !Number.isInteger(dto.customerId) ||
    dto.customerId <= 0
  ) {
    errors.push("Kupac je obavezan.");
  }

  if (dto.documentDate !== undefined && Number.isNaN(Date.parse(dto.documentDate))) {
    errors.push("Datum izdavanja nije ispravan.");
  }
  if (dto.dueDate !== undefined && Number.isNaN(Date.parse(dto.dueDate))) {
    errors.push("Valuta (rok plaćanja) nije ispravna.");
  }

  if (dto.poNumber !== undefined) {
    if (typeof dto.poNumber !== "string") {
      errors.push("Broj narudžbenice mora biti tekst.");
    } else if (dto.poNumber.trim().length > 50) {
      errors.push("Broj narudžbenice sme imati najviše 50 karaktera.");
    }
  }

  if (!Array.isArray(dto.items) || dto.items.length === 0) {
    errors.push("Predračun mora imati bar jednu stavku.");
  } else {
    dto.items.forEach((it, i) => {
      const hasItem =
        typeof it.itemId === "number" && Number.isInteger(it.itemId);
      const hasDesc =
        typeof it.description === "string" && it.description.trim().length > 0;
      if (!hasItem && !hasDesc)
        errors.push(`Stavka ${i + 1}: artikal ili opis je obavezan.`);
      if (typeof it.quantity !== "number" || !(it.quantity > 0))
        errors.push(`Stavka ${i + 1}: količina mora biti veća od 0.`);
      if (
        it.discountPercent !== undefined &&
        (typeof it.discountPercent !== "number" ||
          it.discountPercent < 0 ||
          it.discountPercent > 100)
      )
        errors.push(`Stavka ${i + 1}: rabat mora biti 0–100%.`);
    });
  }

  if (errors.length) throw new BadRequestException(errors);
}

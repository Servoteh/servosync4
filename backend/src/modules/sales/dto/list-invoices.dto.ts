/**
 * Query za listu računa (GET /sales/invoices). Sve opciono; server normalizuje.
 */
export interface ListInvoicesQuery {
  documentType?: string; // PON | PROF | IFR | …
  status?: string; // DRAFT | POSTED | SENT | PAID | CANCELLED
  level?: number; // 250 draft | 0 knjižen
  customerId?: number;
  companyId?: number;
  isExport?: boolean;
  skip?: number;
  take?: number;
}

export function normalizeListInvoicesQuery(raw: {
  documentType?: string;
  status?: string;
  level?: string;
  customerId?: string;
  companyId?: string;
  isExport?: string;
  skip?: string;
  take?: string;
}): ListInvoicesQuery {
  const num = (v?: string) => (v !== undefined && v !== "" ? Number(v) : undefined);
  const bool = (v?: string) =>
    v === undefined ? undefined : v === "true" || v === "1";
  return {
    documentType: raw.documentType || undefined,
    status: raw.status || undefined,
    level: num(raw.level),
    customerId: num(raw.customerId),
    companyId: num(raw.companyId),
    isExport: bool(raw.isExport),
    skip: num(raw.skip),
    take: num(raw.take),
  };
}

/**
 * DTO za carry-over predračun → račun (POST /sales/invoices/:id/from-proforma).
 * targetType = ciljna vrsta level-0 dokumenta (IFR/IFGP/IFUSL/IZVRO/…).
 */
export interface CreateInvoiceFromProformaDto {
  targetType: string;
}

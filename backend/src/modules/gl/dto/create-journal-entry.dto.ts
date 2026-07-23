import { BadRequestException } from "@nestjs/common";

/**
 * DTO za ručni unos naloga glavne knjige (temeljnica). BigBit „Unos naloga glavne
 * knjige". Balans (ΣDug=ΣPot) proverava PostingEngine; ovde validiramo strukturu.
 * Obrazac: interface + validate*() (BACKEND_RULES §6).
 */
export interface CreateJournalEntryLineInput {
  accountCode: string; // konto (FK Account.code)
  analyticalCode?: number | null; // analitika (komitent) — opciono
  debit?: number; // duguje
  credit?: number; // potražuje
  description?: string;
  documentNumber?: string | null;
  dueDate?: string | null; // ISO
  currency?: string | null;
}

export interface CreateJournalEntryDto {
  orderType: string; // vrsta naloga (npr. TEMELJ, IZV, KMP)
  documentDate: string; // ISO datum dokumenta
  companyId?: number;
  description?: string;
  lines: CreateJournalEntryLineInput[];
}

export function validateCreateJournalEntry(dto: CreateJournalEntryDto): void {
  const errors: string[] = [];

  if (typeof dto.orderType !== "string" || dto.orderType.trim() === "")
    errors.push("Vrsta naloga je obavezna.");

  if (typeof dto.documentDate !== "string" || Number.isNaN(Date.parse(dto.documentDate)))
    errors.push("Datum dokumenta mora biti validan datum.");

  if (!Array.isArray(dto.lines) || dto.lines.length < 2)
    errors.push("Nalog mora imati bar dve stavke (dvojno knjiženje).");
  else {
    let anyDebit = false;
    let anyCredit = false;
    dto.lines.forEach((l, i) => {
      if (typeof l.accountCode !== "string" || l.accountCode.trim() === "")
        errors.push(`Stavka ${i + 1}: konto je obavezan.`);
      const d = Number(l.debit ?? 0);
      const c = Number(l.credit ?? 0);
      if (Number.isNaN(d) || Number.isNaN(c) || d < 0 || c < 0)
        errors.push(`Stavka ${i + 1}: duguje/potražuje moraju biti nenegativni brojevi.`);
      if (d > 0 && c > 0)
        errors.push(`Stavka ${i + 1}: stavka ne može imati i duguje i potražuje.`);
      if (d > 0) anyDebit = true;
      if (c > 0) anyCredit = true;
    });
    if (!anyDebit || !anyCredit)
      errors.push("Nalog mora imati bar jednu dugovnu i jednu potražnu stavku.");
  }

  if (errors.length) throw new BadRequestException(errors);
}

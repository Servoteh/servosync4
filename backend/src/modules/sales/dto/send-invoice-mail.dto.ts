import { BadRequestException } from "@nestjs/common";

/**
 * Telo POST /sales/invoices/:id/send-mail — slanje PDF fakture kupcu mejlom.
 *
 * `to`   opciono: kad se izostavi ili je prazno, backend šalje na email kupca sa
 *        računa (InvoiceMailService fallback); kad je dat, validira se format.
 * `note` opciona propratna poruka koja ulazi u telo mejla iznad potpisa.
 */
export interface SendInvoiceMailDto {
  to?: string;
  note?: string;
}

/** Osnovna provera email formata (jedan primalac; bez razmaka, jedan @, TLD). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalizovana adresa primaoca (validirana) ili `undefined` (fallback na kupca). */
export function normalizeInvoiceMailTo(to: unknown): string | undefined {
  const email = typeof to === "string" ? to.trim() : "";
  if (!email) return undefined;
  if (!EMAIL_RE.test(email)) {
    throw new BadRequestException(`Neispravna email adresa primaoca: ${email}.`);
  }
  return email;
}

/** Očišćena propratna poruka ili `undefined` kad je prazna. */
export function normalizeMailNote(note: unknown): string | undefined {
  const trimmed = typeof note === "string" ? note.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

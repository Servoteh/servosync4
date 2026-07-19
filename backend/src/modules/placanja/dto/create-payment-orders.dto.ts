import { BadRequestException } from "@nestjs/common";

/**
 * DTO — kreiranje naloga za plaćanje (virmana) iz selekcije dospelih obaveza.
 * Obrazac: interface + ručna validate*() (kao nabavka/robno; class-validator još
 * nije uveden — BACKEND_RULES §6). Poruke na srpskom, kod na engleskom.
 *
 * Svaka stavka je jedna otvorena obaveza (potražni saldo klase 4 po dobavljaču/
 * dokumentu) koju korisnik štiklira za plaćanje na pripremnom ekranu (`Stampati`).
 */
export interface CreatePaymentOrderLineInput {
  /** meki ref ledger_entries.id — izvorna otvorena stavka (traceback). */
  sourceLedgerEntryId?: number;
  /** IDUKorist — primalac/dobavljač (meki ref customers.id). */
  supplierId: number;
  /** žiro račun dobavljača (UKoristZiroRacun) — u korist. */
  supplierAccount?: string;
  /** iznos za plaćanje (može se editovati na pripremi; default = otvoreni saldo). */
  amount: number;
  /** valuta (default RSD). */
  currency?: string;
  /** broj dokumenta (fakture) — osnova poziva na broj u korist. */
  documentNumber?: string;
  /** PNB model u korist (primalac): "97" | "11" | "99" (default "97"). */
  referenceModelCredit?: string;
  /**
   * Osnova poziva na broj u korist (PNBOdobBroj bez kontrolne cifre). Ako je
   * prazna, servis pokušava da je izvede iz documentNumber. Kontrolni broj
   * dodaje servis preko mod97.util po `referenceModelCredit`.
   */
  referenceBaseCredit?: string;
  /** svrha doznake (default "UPLATA ZA ROBU"). */
  purpose?: string;
  /** dospeće (DatumValute) — informativno na nalogu. */
  dueDate?: string;
}

export interface CreatePaymentOrdersDto {
  /** IDNaTeret — platilac (naša firma / TR firme). */
  companyId?: number;
  /** RedniBrojSerije — broj serije naloga (ako se ne šalje, servis dodeljuje). */
  seriesNumber?: string;
  /** PNB na teret (platilac): "97" | "11" | "99" (default "99"). */
  referenceModelDebit?: string;
  /** žiro račun na teret (NaTeretZiroRacun). */
  debitAccount?: string;
  lines: CreatePaymentOrderLineInput[];
}

export function validateCreatePaymentOrders(dto: CreatePaymentOrdersDto): void {
  const errors: string[] = [];

  if (!Array.isArray(dto.lines) || dto.lines.length === 0) {
    errors.push("Selekcija za plaćanje mora imati bar jednu stavku.");
  } else {
    dto.lines.forEach((l, i) => {
      if (
        typeof l.supplierId !== "number" ||
        !Number.isInteger(l.supplierId) ||
        l.supplierId <= 0
      ) {
        errors.push(`Stavka ${i + 1}: dobavljač (primalac) je obavezan.`);
      }
      if (typeof l.amount !== "number" || !(l.amount > 0)) {
        errors.push(`Stavka ${i + 1}: iznos mora biti veći od 0.`);
      }
      if (l.currency !== undefined && typeof l.currency !== "string") {
        errors.push(`Stavka ${i + 1}: valuta mora biti tekst.`);
      }
    });
  }

  if (errors.length) throw new BadRequestException(errors);
}

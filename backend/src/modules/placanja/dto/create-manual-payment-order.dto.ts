import { BadRequestException } from "@nestjs/common";
import { isValidAccountNumber } from "../mod97.util";

/**
 * DTO — RUČNI pojedinačni nalog za plaćanje (BigBit `UnosVirmana`).
 * =========================================================================
 * Forma bez izvora iz saldakonta: knjigovođa unosi virman „na ruke" (npr.
 * porez, doprinos, jednokratna uplata) koji NEMA otvorenu stavku GK
 * (`sourceLedgerEntryId = null`). Nalog ulazi u isti pregled/potpis/izvoz tok
 * kao i nalozi kreirani iz dospelih obaveza (status-mašina CREATED→SIGNED→PAID).
 *
 * Obrazac: interface + ručna validate*() (kao create-payment-orders.dto; class-
 * validator još nije uveden — BACKEND_RULES §6). Poruke na srpskom, kod engleski.
 *
 * DobarTR (BigBit `ProveriTkRnPreKreiranjaVirmana`, doc 25 §C): žiro račun
 * primaoca MORA biti struktura-i-MOD97 validan (banka(3)-partija-KK(2)) PRE
 * upisa — inače ga banka odbija posle izvoza. Validira se `isValidAccountNumber`
 * (mod97.util) već na ulazu; servis dodatno ponavlja proveru (odbrana u dubini).
 */
export interface CreateManualPaymentOrderDto {
  /** IDUKorist — primalac (meki ref customers.id). */
  supplierId: number;
  /** žiro račun primaoca (UKoristZiroRacun) — DobarTR validacija (banka(3)-partija-KK(2)). */
  supplierAccount: string;
  /** iznos za plaćanje (mora biti > 0). */
  amount: number;
  /** svrha doznake (SvrhaDoznake) — obavezna kod ručnog unosa. */
  purpose: string;
  /**
   * poziv na broj u korist (PNBOdobBroj) — kod ručnog unosa knjigovođa upisuje
   * KOMPLETAN poziv na broj (sa kontrolnom cifrom); servis ga ne preračunava.
   * Opciono (mnoga plaćanja nemaju poziv na broj).
   */
  referenceNumber?: string;
  /** valuta (default RSD). */
  currency?: string;
  /** dospeće (DatumValute) — informativno na nalogu. ISO datum. */
  dueDate?: string;
}

export function validateCreateManualPaymentOrder(
  dto: CreateManualPaymentOrderDto,
): void {
  const errors: string[] = [];

  if (
    typeof dto.supplierId !== "number" ||
    !Number.isInteger(dto.supplierId) ||
    dto.supplierId <= 0
  ) {
    errors.push("Primalac (komitent) je obavezan.");
  }

  const acct =
    typeof dto.supplierAccount === "string" ? dto.supplierAccount.trim() : "";
  if (acct === "") {
    errors.push("Žiro račun primaoca je obavezan.");
  } else if (!isValidAccountNumber(acct)) {
    errors.push(
      `Neispravan tekući račun (DobarTR): ${acct}. Format: banka(3)-partija-kontrolni(2).`,
    );
  }

  if (typeof dto.amount !== "number" || !(dto.amount > 0)) {
    errors.push("Iznos mora biti veći od 0.");
  }

  if (typeof dto.purpose !== "string" || dto.purpose.trim() === "") {
    errors.push("Svrha plaćanja je obavezna.");
  }

  if (dto.currency !== undefined && typeof dto.currency !== "string") {
    errors.push("Valuta mora biti tekst.");
  }

  if (
    dto.dueDate !== undefined &&
    dto.dueDate !== "" &&
    Number.isNaN(Date.parse(dto.dueDate))
  ) {
    errors.push("Datum dospeća nije ispravan datum.");
  }

  if (errors.length) throw new BadRequestException(errors);
}

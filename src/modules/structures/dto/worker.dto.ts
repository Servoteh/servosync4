import { BadRequestException } from "@nestjs/common";

/**
 * Kreiranje radnika (MODULE_SPEC_structures §6.1).
 *
 * Legacy lozinke (`password` / `workerPassword`) se NIKAD ne primaju niti vraćaju
 * (spec §5.5 — deprecated, sva auth ide kroz `users.password_hash`). Zato ih DTO
 * uopšte nema — čak i ako klijent pošalje ta polja, servis ih ignoriše.
 */
export interface CreateWorkerDto {
  /** Korisničko ime (skraćeno ime) — obavezno. */
  username: string;
  /** Ime i prezime. */
  fullName?: string;
  /** Šifra radnika (legacy). */
  idNumber?: string;
  /** Bar-kod ID kartice. */
  cardId?: string;
  /** Login account za web aplikaciju. */
  loginAccount?: string;
  /** Šifra radne jedinice (FK work_units.code). */
  workUnitCode?: string;
  /** Vrsta posla (FK worker_types.id). */
  workerTypeId?: number;
  /** Putanja do slike potpisa. */
  signatureImage?: string;
  /** Može odobravati primopredaje (uslovljeno vrstom posla). */
  definesApproval?: boolean;
  /** Može lansirati RN (zahteva definesApproval=true). */
  definesLaunch?: boolean;
  /** Može imati više login account-a. */
  multiAccount?: boolean;
  /** Procenat provizije (legacy). */
  commissionPercent?: number;
  /** Soft-delete flag; default true. */
  active?: boolean;
}

export type UpdateWorkerDto = Partial<CreateWorkerDto>;

export function validateCreateWorker(dto: CreateWorkerDto): void {
  const errors: string[] = [];
  if (typeof dto?.username !== "string" || !dto.username.trim())
    errors.push("Korisničko ime (username) je obavezno.");
  if (
    dto?.workerTypeId !== undefined &&
    (!Number.isInteger(dto.workerTypeId) || dto.workerTypeId < 0)
  )
    errors.push("Vrsta posla (workerTypeId) mora biti nenegativan ceo broj.");
  if (errors.length) throw new BadRequestException(errors);
}

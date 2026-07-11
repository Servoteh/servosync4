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

// Dužine po schema.prisma (Worker) — bez ovih provera duži unos puca kao
// PG 22001 / Prisma P2000 → goli 500 umesto 400 (obrazac iz position.dto.ts).
const WORKER_MAX_LENGTHS: [
  keyof CreateWorkerDto,
  number,
  string, // labela za poruku
][] = [
  ["username", 50, "Korisničko ime"],
  ["fullName", 50, "Ime i prezime"],
  ["idNumber", 20, "Šifra radnika"],
  ["cardId", 50, "ID kartice"],
  ["loginAccount", 50, "Login account"],
  ["workUnitCode", 5, "Šifra radne jedinice"],
  ["signatureImage", 150, "Putanja do slike potpisa"],
];

export function validateCreateWorker(dto: CreateWorkerDto): void {
  const errors: string[] = [];
  if (typeof dto?.username !== "string" || !dto.username.trim())
    errors.push("Korisničko ime (username) je obavezno.");
  if (
    dto?.workerTypeId !== undefined &&
    (!Number.isInteger(dto.workerTypeId) || dto.workerTypeId < 0)
  )
    errors.push("Vrsta posla (workerTypeId) mora biti nenegativan ceo broj.");
  for (const [field, max, label] of WORKER_MAX_LENGTHS) {
    const v = dto?.[field];
    if (typeof v === "string" && v.trim().length > max)
      errors.push(`${label} sme imati najviše ${max} karaktera.`);
  }
  if (errors.length) throw new BadRequestException(errors);
}

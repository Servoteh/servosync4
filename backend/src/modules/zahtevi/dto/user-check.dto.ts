import { BadRequestException } from "@nestjs/common";

/**
 * Tela za proveru isporuke od strane PODNOSIOCA (03.08.2026):
 *   POST /zahtevi/:id/confirm  — „radi" → DONE   (komentar OPCIONO)
 *   POST /zahtevi/:id/reopen   — „ne radi" → SUBMITTED (komentar OBAVEZAN)
 *
 * Razlog postojanja: do sada je jedini prelaz statusa bio admin-only `POST :id/status`,
 * pa je korisnikova potvrda bila samo komentar „RADI" u koji se moralo verovati da će ga
 * neko pročitati. Zahtevi su se gomilali u READY_FOR_TEST (40 komada 03.08.2026).
 *
 * Prazan komentar na `reopen` je 422 (ne 400): telo je sintaksno ispravno, ali radnja
 * poslovno nema smisla — vraćanje u rad BEZ opisa šta ne radi je isto što i ćutanje.
 */

/** POST /zahtevi/:id/confirm — telo je opciono; `comment` je opciona propratna poruka. */
export interface UserConfirmDto {
  comment?: string;
}

/** POST /zahtevi/:id/reopen — `comment` (šta ne radi) je OBAVEZAN. */
export interface UserReopenDto {
  comment?: string;
}

/** Najveća dužina propratnog komentara (isti red veličine kao opis zahteva). */
export const USER_CHECK_COMMENT_MAX = 4000;

/** Zajednička provera oblika polja `comment` (tip + dužina). Ne presuđuje praznost. */
function assertCommentShape(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string")
    throw new BadRequestException("Komentar mora biti tekst.");
  if (value.length > USER_CHECK_COMMENT_MAX)
    throw new BadRequestException(
      `Komentar može imati najviše ${USER_CHECK_COMMENT_MAX} znakova.`,
    );
}

/** Validacija tela `confirm` — komentar je opcion; vraća očišćen tekst ili null. */
export function validateUserConfirm(
  dto: UserConfirmDto | undefined,
): string | null {
  assertCommentShape(dto?.comment);
  const text = (dto?.comment ?? "").trim();
  return text || null;
}

/** Validacija tela `reopen` — komentar je OBAVEZAN; vraća očišćen tekst. */
export function validateUserReopen(dto: UserReopenDto | undefined): string {
  assertCommentShape(dto?.comment);
  return (dto?.comment ?? "").trim();
}

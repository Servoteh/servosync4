import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/** „Na koga se misli" — `users.id` ILI e-mail; tačno jedno od dva. */
export interface UserRef {
  userId?: number | null;
  email?: string | null;
}

/** Razrešen nalog — `active` nosi pozivalac dalje (deaktiviran nalog ne sme da radi). */
export interface ResolvedUser {
  id: number;
  active: boolean;
}

/**
 * Razreši `{ userId | email }` u nalog (`users.id` + `active`).
 *
 * `null` = nije prosleđeno ništa (pozivalac neka odluči šta je podrazumevano).
 * `undefined` NIKAD se ne vraća — nepoznat e-mail je `NOT_FOUND` sentinel, da bi
 * pozivalac mogao da bira odgovor: admin ruta sme reći „nema takvog korisnika"
 * (404), a `claim` NE sme — tamo je isti odgovor kao „nemaš dozvolu" (403), da
 * ruta ne postane orakl za nabrajanje naloga.
 *
 * ⚠️ E-MAIL SE POREDI TAČNO, NIKAD KROZ `ILIKE`. Prva verzija je koristila
 * `email: { equals, mode: "insensitive" }`, što Prisma prevodi u `ILIKE $1` sa
 * NEescape-ovanim parametrom — a `%` i `_` su u `ILIKE` džokeri. Posledica je bila
 * da `ownerEmail = "%@servoteh.com"` prolazi validaciju `@IsEmail` (jeste validan
 * oblik) i pogađa PROIZVOLJAN nalog: mereno nad živom bazom 59 od 68 naloga, a
 * `findFirst` bez `orderBy` ne garantuje ni koji. Za sanduče koje je KOMANDNI KANAL
 * (agent radi po tekstu koji povuče) to je bio put do tuđih instrukcija.
 *
 * Zato: `email.trim().toLowerCase()` + `findUnique` po unique indeksu
 * `uq_users_email`. Mala slova su invarijanta ove baze, ne pretpostavka: i upis
 * (`podesavanja-users` `normEmail`) i prijava (`auth.service.validate` →
 * `findUnique({ email: email.toLowerCase().trim() })`) rade nad malim slovima —
 * nalog sa velikim slovom ne bi mogao ni da se prijavi. Provereno 02.08.2026 nad
 * `servosync-pg`: 68 naloga, 0 sa `email <> lower(email)`.
 */
export const USER_REF_NOT_FOUND = Symbol("USER_REF_NOT_FOUND");

export async function resolveUserRef(
  prisma: PrismaService,
  ref: UserRef,
  label: string,
): Promise<ResolvedUser | null | typeof USER_REF_NOT_FOUND> {
  const id = ref.userId ?? null;
  const email = (ref.email ?? "").trim().toLowerCase();

  if (id === null && !email) return null;
  if (id !== null && email) {
    throw new BadRequestException(
      `Prosledi ${label}UserId ILI ${label}Email — ne oba.`,
    );
  }
  if (id !== null) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException(`Neispravan ${label}UserId.`);
    }
    const byId = await prisma.user.findUnique({
      where: { id },
      select: { id: true, active: true },
    });
    return byId ?? USER_REF_NOT_FOUND;
  }

  // TAČNO poređenje po unique indeksu — bez `mode: "insensitive"` (= ILIKE = džokeri).
  const byEmail = await prisma.user.findUnique({
    where: { email },
    select: { id: true, active: true },
  });
  return byEmail ?? USER_REF_NOT_FOUND;
}

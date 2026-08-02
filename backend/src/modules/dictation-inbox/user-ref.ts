import { BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

/** „Na koga se misli" — `users.id` ILI e-mail; tačno jedno od dva. */
export interface UserRef {
  userId?: number | null;
  email?: string | null;
}

/**
 * Razreši `{ userId | email }` u `users.id`.
 *
 * `null` = nije prosleđeno ništa (pozivalac neka odluči šta je podrazumevano).
 * `undefined` NIKAD se ne vraća — nepoznat e-mail je `NOT_FOUND` sentinel, da bi
 * pozivalac mogao da bira odgovor: admin ruta sme reći „nema takvog korisnika"
 * (404), a `claim` NE sme — tamo je isti odgovor kao „nemaš dozvolu" (403), da
 * ruta ne postane orakl za nabrajanje naloga.
 */
export const USER_REF_NOT_FOUND = Symbol("USER_REF_NOT_FOUND");

export async function resolveUserRef(
  prisma: PrismaService,
  ref: UserRef,
  label: string,
): Promise<number | null | typeof USER_REF_NOT_FOUND> {
  const id = ref.userId ?? null;
  const email = (ref.email ?? "").trim();

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
      select: { id: true },
    });
    return byId ? byId.id : USER_REF_NOT_FOUND;
  }

  const byEmail = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  return byEmail ? byEmail.id : USER_REF_NOT_FOUND;
}

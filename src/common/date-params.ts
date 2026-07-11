import { BadRequestException } from "@nestjs/common";

/**
 * Parsiraj opcioni datumski parametar (query filter ili body polje): odsutan/
 * prazan → `undefined`, nevalidan → 400. Bez ovoga `new Date("bilo šta")` daje
 * `Invalid Date` koji uđe u Prisma filter/data → `PrismaClientValidationError`
 * → goli 500 (nema globalnog exception filtera). Izvučeno iz
 * tech-processes.service.ts (isti tekst greške).
 */
export function parseDateParam(
  value: string | undefined,
  name: string,
): Date | undefined {
  if (value === undefined || value === "") return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime()))
    throw new BadRequestException(
      `Parametar '${name}' nije ispravan datum (ISO 8601).`,
    );
  return d;
}

import { registerDecorator, type ValidationOptions } from "class-validator";

/**
 * Strogi kalendarski datum `YYYY-MM-DD`. Zamena za labavi `@IsISO8601`/regex koji su propuštali
 * `2026-W30` / `2026-07` / `2026-200` (ISO-8601 varijante bez punog datuma) i `2026-02-31`
 * (sintaksno ispravan, kalendarski nepostojeći) — takvi literali stižu do Postgresa i pucaju kao
 * 22007/22008 → 500, iako DTO obećava 400. Ova provera: (1) tačan format `\d{4}-\d{2}-\d{2}`,
 * (2) kalendarski round-trip (UTC Date se vraća na iste Y/M/D). Bez novih zavisnosti.
 */
export function isCalendarDateString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/** class-validator dekorator za strogi kalendarski `YYYY-MM-DD` (v. `isCalendarDateString`). */
export function IsCalendarDate(
  options?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: "isCalendarDate",
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate: (value: unknown) => isCalendarDateString(value),
        defaultMessage: () =>
          `${String(propertyName)} mora biti validan datum u formatu YYYY-MM-DD`,
      },
    });
  };
}

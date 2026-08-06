import { registerDecorator, type ValidationOptions } from "class-validator";
import { jeUuid } from "../sastanci-predmet";

/**
 * Referenca na PREDMET (`projekatId`) u PRELAZNOM obliku — blokada 5.
 *
 * Prima OBA oblika dok FE ne pređe na `Int`:
 *   - sy15 `uuid` (`"de6e7d4d-…"`) — ono što stari klijent i danas šalje,
 *   - 3.0 `Int` (`10349`) ili numerički string (`"10349"`) — novi oblik.
 *
 * `null` je dozvoljen i ZNAČI „obriši vezu" (FE ga tako šalje kad se predmet
 * skine sa akcije). Zato polje NE sme biti samo `@IsOptional()` — razlika
 * između „nije poslato" i „poslato kao null" je nosilac ponašanja.
 *
 * ZAŠTO NIJE `@IsUUID()` KAO PRE: pod `SASTANCI_PB_IZVOR=3.0` kolona je `Int`.
 * Da je validacija ostala samo na uuid-u, novi FE ne bi mogao da pošalje broj;
 * da je postala samo broj, stari FE bi dobijao 400 na svaki filter po predmetu.
 * Prevod radi `SastanciPredmetService`.
 *
 * ⚠️ Ovaj dekorator NESTAJE zajedno sa uuid granom kad se FE uskladi.
 */
export function isPredmetRef(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0;
  }
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "") return true; // prazan string = isto što i null (obriši/bez filtera)
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0;
  }
  return jeUuid(v);
}

export function IsPredmetRef(options?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: "isPredmetRef",
      target: object.constructor,
      propertyName: propertyName as string,
      options,
      validator: {
        validate: (value: unknown) => isPredmetRef(value),
        defaultMessage: () =>
          `${String(propertyName)} mora biti id predmeta (ceo broj) ili sy15 uuid predmeta`,
      },
    });
  };
}

import { BadRequestException } from "@nestjs/common";

/**
 * Parsiranje BROJČANIH query/param vrednosti — parnjak `date-params.ts`.
 *
 * ZAŠTO POSTOJI: kontroleri su brojeve iz query stringa vadili sa
 * `x ? Number(x) : undefined`. `Number("abc")` je `NaN`, a `NaN` prolazi svaku naivnu
 * proveru (`NaN != null` je `true`, i `NaN < 1 || NaN > 12` je `false`), pa je odlazio
 * pravo u Prisma `where` ili u `$queryRaw` parametar. Rezultat je goli 500 iz drajvera
 * na banalno pogrešan unos — što krši BACKEND_RULES („500 samo za neočekivano").
 *
 * Isti obrazac je izmeren na više mesta u `robno` i `pdv` kontrolerima, zato helper
 * stoji u `common/`, a ne u modulu.
 *
 * NAPOMENA: za TELA zahteva (`@Body`) ovo NIJE pravi alat — tamo idu `class-validator`
 * DTO klase i globalni `ValidationPipe`. Ovo je za `@Query`/`@Param` stringove.
 */

/**
 * Opcioni ceo broj iz query-ja: odsutan/prazan → `undefined`, nevalidan → 400.
 *
 * `opts.min`/`opts.max` su INKLUZIVNE granice; prekoračenje je takođe 400 (ne tiho
 * odsecanje, jer bi korisnik dobio rezultat za drugi opseg od traženog).
 */
export function parseIntParam(
  value: string | undefined | null,
  name: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null || value.trim() === "")
    return undefined;
  const n = Number(value);
  if (!Number.isInteger(n))
    throw new BadRequestException(`Parametar '${name}' mora biti ceo broj.`);
  if (opts.min !== undefined && n < opts.min)
    throw new BadRequestException(
      `Parametar '${name}' mora biti najmanje ${opts.min}.`,
    );
  if (opts.max !== undefined && n > opts.max)
    throw new BadRequestException(
      `Parametar '${name}' sme biti najviše ${opts.max}.`,
    );
  return n;
}

/**
 * Obavezan ceo broj iz query-ja: odsutan ili nevalidan → 400.
 * Koristi se kad ruta bez tog parametra nema smisla (npr. kartica artikla bez artikla).
 */
export function requireIntParam(
  value: string | undefined | null,
  name: string,
  opts: { min?: number; max?: number } = {},
): number {
  const n = parseIntParam(value, name, opts);
  if (n === undefined)
    throw new BadRequestException(`Parametar '${name}' je obavezan.`);
  return n;
}

/**
 * „Da li je uključeno" iz query-ja. Prihvata `true/1/da/yes` (bez obzira na veličinu
 * slova); sve ostalo je `false`. Odsutan → `false`.
 *
 * Postoji da se ne ponavlja `x === "true"` po kontrolerima — koje tiho tretira
 * `?onlyInStock=1` kao isključeno, iako je korisnik očekivao uključeno.
 */
export function parseBoolParam(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "da" || v === "yes";
}

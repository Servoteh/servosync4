/**
 * GLN (Global Location Number) validation — legacy length/numeric check.
 * =========================================================================
 * Faithful port of `DobarGLN` from `_legacy/QBigTehn_APL/modules/LIB_PIB.bas`
 * (DobarPIB/DobarGLN). Analysis: `backend/docs/migration/BIGBIT_KOMITENTI.md` §3.2.
 *
 * NOTE — bank account validator: `DobarTr`, the third validator referenced by the
 * same BigBit form, is NOT part of `LIB_PIB.bas`. Its implementation does exist in
 * the legacy export (`_legacy/QBigTehn_APL/modules/KontrolniBrojevi.bas:127`) and is
 * ALREADY ported as `isValidAccountNumber` in `src/modules/placanja/mod97.util.ts`,
 * so it is deliberately not duplicated here. (`BIGBIT_KOMITENTI.md` §3.3 still claims
 * the implementation was not found in the export; that note is stale.)
 */

/**
 * Validate a GLN the way BigBit does (`LIB_PIB.bas:84-110`):
 *   empty → false; `Len <= 5` → false; `Len > 14` → false; not numeric → false;
 *   otherwise true. Effective accepted range: 6..14 digits.
 *
 * ⚠️ NO GS1 check-digit verification — the legacy validator has none, and a real GLN
 * is 13 digits with a mod-10 GS1 check digit. This function therefore only rejects
 * obvious garbage; it does NOT prove the GLN exists or is well-formed per GS1. Do not
 * add the check digit here without a product decision: legacy data validated by this
 * rule would start failing.
 *
 * Legacy quirks kept on purpose:
 *   - No trimming (`DobarGLN` uses raw `Len(Nz(GLN, ""))`), so surrounding whitespace
 *     counts toward the length and makes the value non-numeric → callers trim.
 *   - VBA `IsNumeric` also accepts signs, decimal separators and exponents; this port
 *     requires digits only, since a GLN is a plain digit string.
 *
 * @param gln  GLN as stored/entered
 * @returns    `true` for a 6..14 digit numeric string
 */
export function isValidGln(gln: string): boolean {
  // VBA: Nz(GLN, "") — null/undefined behaves like an empty string.
  const value = gln ?? "";
  if (typeof value !== "string") return false;
  if (value === "") return false;
  if (value.length <= 5 || value.length > 14) return false;
  return /^\d+$/.test(value);
}

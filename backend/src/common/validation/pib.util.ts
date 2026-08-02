/**
 * Serbian tax id (PIB) checksum validation.
 * =========================================================================
 * Faithful port of `DobarPIB` from `_legacy/QBigTehn_APL/modules/LIB_PIB.bas`
 * (DobarPIB/DobarGLN), the validator BigBit runs on the "Unos komitenata" form
 * (computed column `DobarPIB(Nz([PIB],""))`). Analysis:
 * `backend/docs/migration/BIGBIT_KOMITENTI.md` §3.1.
 *
 * The legacy chain (mod-10 accumulate → mod-11 double) is the standard Serbian
 * PIB check-digit algorithm; it is transcribed here line by line rather than
 * rewritten from the published spec. Anchor: PIB `100002887` (Telekom Srbija)
 * validates, which matches the legacy chain exactly.
 *
 * NOTE — bank account validator: `DobarTr`, the third validator referenced by the
 * same BigBit form, is NOT part of `LIB_PIB.bas`. Its implementation does exist in
 * the legacy export (`_legacy/QBigTehn_APL/modules/KontrolniBrojevi.bas:127`, and
 * identically in `_legacy/BigbitRaznoNenad/_extracted/OnLine_BigBit_VBA/
 * Module__KontrolniBrojevi.txt:57`) and is ALREADY ported as `isValidAccountNumber`
 * in `src/modules/placanja/mod97.util.ts` — so it is deliberately not duplicated
 * here. (`BIGBIT_KOMITENTI.md` §3.3 still says the implementation was not found;
 * that note is stale.)
 */

/**
 * Validate a Serbian PIB (9-digit tax id) using the legacy mod-11 check digit.
 *
 * Legacy algorithm (`LIB_PIB.bas:4-83`), step by step:
 *   1. `Trim` the input; if it starts with `"SR"`, drop the prefix and trim again.
 *   2. `zadnji = Right(PIB, 1)` — the control digit is the LAST character of the
 *      remaining string, taken BEFORE the base is truncated.
 *   3. `PIB = Left(PIB, 8)` — the first 8 characters are the base; if fewer than
 *      8 characters remain, `Len(PIB) <> 8` and the result is `False`.
 *   4. Chain `c8..c1`, starting from a seed of 10:
 *      `c = (digit + c) Mod 10`; if `c = 0` then `c = 10`; `c = (c * 2) Mod 11`.
 *   5. `c0 = (11 - c1) Mod 10` must equal the control digit.
 *
 * Legacy quirks kept on purpose (do not "fix" without a product decision):
 *   - Length is only bounded from below. An input longer than 9 characters is NOT
 *     rejected: the base is still the first 8 characters and the control digit is
 *     still the last character, so e.g. a 12-character string can validate. Callers
 *     that need a strict 9-digit tax id must check the length themselves.
 *   - An 8-character input is accepted if its 8th digit happens to be the check
 *     digit of all 8 digits (it acts as both base digit and control digit).
 *   - The `"SR"` prefix is matched case-insensitively, because the legacy module
 *     runs under `Option Compare Database` (Access text comparison is case-insensitive).
 *
 * Deliberate hardening over the legacy code: VBA runs under `On Error Resume Next`,
 * so `CInt` on a non-digit silently skipped a step and left stale state; here a base
 * or control character that is not a digit is a plain `false`.
 *
 * @param pib  tax id as entered, with or without the `"SR"` prefix and surrounding spaces
 * @returns    `true` when the check digit matches
 */
export function isValidPib(pib: string): boolean {
  if (typeof pib !== "string") return false;

  // VBA: PIB = Trim(stPIB) / If Left(PIB, 2) = "SR" Then PIB = Trim(Right(PIB, Len(PIB) - 2))
  let value = pib.trim();
  if (value.slice(0, 2).toUpperCase() === "SR") {
    value = value.slice(2).trim();
  }

  // VBA: zadnji = Right(PIB, 1) — read before the base is cut to 8 characters.
  const controlChar = value.slice(-1);
  // VBA: PIB = Left(PIB, 8) / If Len(PIB) <> 8 Then DobarPIB = False
  const base = value.slice(0, 8);
  if (base.length !== 8) return false;
  if (!/^\d{8}$/.test(base) || !/^\d$/.test(controlChar)) return false;

  // VBA: c8 = (Mid(PIB,1,1) + 10) Mod 10 ... c1 = (Mid(PIB,8,1) + c2) Mod 10
  let c = 10;
  for (let i = 0; i < 8; i++) {
    c = (Number(base[i]) + c) % 10;
    if (c === 0) c = 10;
    c = (c * 2) % 11;
  }

  // VBA: c0 = (11 - c1) Mod 10 / If c0 <> zadnji Then False Else True
  const control = (11 - c) % 10;
  return control === Number(controlChar);
}

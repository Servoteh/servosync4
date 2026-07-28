import { isValidPib } from "./pib.util";

/**
 * Port parity for `DobarPIB` (_legacy/QBigTehn_APL/modules/LIB_PIB.bas).
 *
 * Test vectors are produced by the legacy chain itself (seed 10 → per digit:
 * `(digit + c) mod 10`, `0 → 10`, `(c * 2) mod 11`; check digit `(11 - c) mod 10`),
 * and anchored on a real Serbian PIB: `100002887` (Telekom Srbija) — base `10000288`
 * yields check digit 7, which was also verified by hand against the VBA source.
 */

/** base (8 digits) → check digit, derived from the legacy chain. */
const CHECK_DIGITS: Array<[string, string]> = [
  ["10000288", "7"], // real PIB 100002887 — anchor
  ["00000000", "3"],
  ["12345678", "8"],
  ["11111111", "7"],
  ["98765432", "8"],
  ["10203040", "0"],
  ["99999999", "5"],
  ["10052012", "3"],
  ["20000000", "5"],
];

describe("isValidPib", () => {
  describe("valid check digits", () => {
    it.each(CHECK_DIGITS)("base %s + check digit %s is valid", (base, check) => {
      expect(isValidPib(base + check)).toBe(true);
    });
  });

  describe("wrong check digit", () => {
    it.each(CHECK_DIGITS)("base %s rejects every digit other than %s", (base, check) => {
      for (let d = 0; d <= 9; d++) {
        const candidate = base + String(d);
        expect(isValidPib(candidate)).toBe(String(d) === check);
      }
    });
  });

  describe('"SR" prefix', () => {
    it("strips the prefix before validating", () => {
      expect(isValidPib("SR100002887")).toBe(true);
      expect(isValidPib("SR123456788")).toBe(true);
    });

    it("matches the prefix case-insensitively (Option Compare Database)", () => {
      expect(isValidPib("sr100002887")).toBe(true);
      expect(isValidPib("Sr100002887")).toBe(true);
    });

    it("trims around and after the prefix (legacy Trim(Right(...)))", () => {
      expect(isValidPib("  100002887  ")).toBe(true);
      expect(isValidPib("SR 100002887")).toBe(true);
      expect(isValidPib("  SR  100002887 ")).toBe(true);
    });

    it("still applies the checksum to the stripped value", () => {
      expect(isValidPib("SR100002886")).toBe(false);
    });

    it("rejects a prefix with nothing usable behind it", () => {
      expect(isValidPib("SR")).toBe(false);
      expect(isValidPib("SR1234")).toBe(false);
    });
  });

  describe("too short", () => {
    it("rejects an empty or whitespace-only input", () => {
      expect(isValidPib("")).toBe(false);
      expect(isValidPib("   ")).toBe(false);
    });

    it("rejects fewer than 8 characters (legacy Len(Left(PIB, 8)) <> 8)", () => {
      expect(isValidPib("1")).toBe(false);
      expect(isValidPib("1000028")).toBe(false); // 7 chars
      expect(isValidPib("00000003")).toBe(false); // 8 chars, 8th digit is not its own check digit
    });
  });

  describe("non-numeric input", () => {
    it("rejects letters in the 8-digit base", () => {
      expect(isValidPib("1000A2887")).toBe(false);
      expect(isValidPib("abcdefghi")).toBe(false);
    });

    it("rejects a non-digit control character", () => {
      expect(isValidPib("10000288X")).toBe(false);
      expect(isValidPib("10000288 ")).toBe(false); // trailing space is trimmed → 8 chars, no match
    });

    it("rejects separators and signs", () => {
      expect(isValidPib("100-002-887")).toBe(false);
      expect(isValidPib("+100002887")).toBe(false);
    });

    it("rejects a non-string input", () => {
      expect(isValidPib(null as unknown as string)).toBe(false);
      expect(isValidPib(undefined as unknown as string)).toBe(false);
      expect(isValidPib(100002887 as unknown as string)).toBe(false);
    });
  });

  /**
   * Documented legacy behaviour, NOT a recommendation. `DobarPIB` never bounds the
   * length from above and reads the control digit as `Right(PIB, 1)`, so longer
   * strings and bare 8-digit strings can pass. Callers that need a strict 9-digit
   * PIB must check the length themselves. See pib.util.ts JSDoc.
   */
  describe("legacy quirks (length is only bounded from below)", () => {
    it("accepts a longer string whose LAST character matches the base check digit", () => {
      expect(isValidPib("1000028899997")).toBe(true); // base 10000288, control 7
      expect(isValidPib("10000288000007")).toBe(true);
    });

    it("rejects a longer string whose last character does not match", () => {
      expect(isValidPib("1000028870")).toBe(false);
      expect(isValidPib("100002887123")).toBe(false);
    });

    it("accepts an 8-digit string whose 8th digit is the check digit of all 8", () => {
      expect(isValidPib("10000018")).toBe(true);
      expect(isValidPib("10000026")).toBe(true);
    });
  });
});

import { isValidGln } from "./gln.util";

/**
 * Port parity for `DobarGLN` (_legacy/QBigTehn_APL/modules/LIB_PIB.bas:84-110):
 * empty → false, `Len <= 5` → false, `Len > 14` → false, non-numeric → false.
 * Accepted range is therefore 6..14 digits, with NO GS1 check digit.
 */
describe("isValidGln", () => {
  describe("length boundaries", () => {
    it("rejects 5 digits and shorter (Len <= 5)", () => {
      expect(isValidGln("1")).toBe(false);
      expect(isValidGln("1234")).toBe(false);
      expect(isValidGln("12345")).toBe(false);
    });

    it("accepts 6 digits (first accepted length)", () => {
      expect(isValidGln("123456")).toBe(true);
      expect(isValidGln("000000")).toBe(true);
    });

    it("accepts 14 digits (last accepted length)", () => {
      expect(isValidGln("12345678901234")).toBe(true);
    });

    it("rejects 15 digits and longer (Len > 14)", () => {
      expect(isValidGln("123456789012345")).toBe(false);
      expect(isValidGln("1234567890123456789")).toBe(false);
    });

    it("accepts the common 13-digit GLN length", () => {
      expect(isValidGln("8600000000001")).toBe(true);
    });
  });

  describe("empty input", () => {
    it("rejects empty, null and undefined (legacy Nz(GLN, \"\"))", () => {
      expect(isValidGln("")).toBe(false);
      expect(isValidGln(null as unknown as string)).toBe(false);
      expect(isValidGln(undefined as unknown as string)).toBe(false);
    });
  });

  describe("non-numeric input", () => {
    it("rejects letters", () => {
      expect(isValidGln("12345A")).toBe(false);
      expect(isValidGln("ABCDEFG")).toBe(false);
    });

    it("rejects separators, signs and decimals", () => {
      expect(isValidGln("123-456")).toBe(false);
      expect(isValidGln("+123456")).toBe(false);
      expect(isValidGln("-123456")).toBe(false);
      expect(isValidGln("123456.7")).toBe(false);
      expect(isValidGln("1,234567")).toBe(false);
    });

    it("rejects surrounding whitespace (legacy does not trim → callers must)", () => {
      expect(isValidGln(" 123456")).toBe(false);
      expect(isValidGln("123456 ")).toBe(false);
      expect(isValidGln("      ")).toBe(false);
    });

    it("rejects a non-string input", () => {
      expect(isValidGln(123456 as unknown as string)).toBe(false);
    });
  });

  /**
   * Documented legacy gap: there is no GS1 mod-10 check digit here, so a
   * structurally wrong GLN still passes. See gln.util.ts JSDoc.
   */
  it("accepts a 13-digit value with an invalid GS1 check digit (no checksum in legacy)", () => {
    expect(isValidGln("8600000000000")).toBe(true);
    expect(isValidGln("8600000000009")).toBe(true);
  });
});

import { sanitizeDrawingNo } from "./drawings";

/**
 * Paritet 1.0 `drawings.js` sanitizeDrawingNo (MODULE_SPEC_planovi_pracenje_30.md §2-14).
 * Deli ga Plan proizvodnje (skice/TP crteži) i Praćenje (RN side-panel crteži).
 */
describe("sanitizeDrawingNo (paritet 1.0)", () => {
  it("trim + skini vodeće/prateće tačke i razmake", () => {
    expect(sanitizeDrawingNo("  9400/2 ")).toBe("9400/2");
    expect(sanitizeDrawingNo(".9400/2.")).toBe("9400/2");
    expect(sanitizeDrawingNo("9400/2 . ")).toBe("9400/2");
  });
  it("čisto-tačka placeholder → null", () => {
    expect(sanitizeDrawingNo(".")).toBeNull();
    expect(sanitizeDrawingNo("...")).toBeNull();
  });
  it("prazno/whitespace → null", () => {
    expect(sanitizeDrawingNo("")).toBeNull();
    expect(sanitizeDrawingNo("   ")).toBeNull();
  });
  it("revizija sufiks se čuva (fallback traži {broj}_A/B)", () => {
    expect(sanitizeDrawingNo("1061228_B")).toBe("1061228_B");
  });
  it("slash kanon (dash NIJE normalizovan ovde — samo trim tačaka)", () => {
    expect(sanitizeDrawingNo("9400-2")).toBe("9400-2");
    expect(sanitizeDrawingNo("9400/2")).toBe("9400/2");
  });
});

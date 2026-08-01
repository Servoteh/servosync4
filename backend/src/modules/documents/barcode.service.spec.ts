import "reflect-metadata";
import { BarcodeService } from "./barcode.service";

/**
 * Zakljucava ono sto skener cita: simbologiju (Code 128), odsustvo ljudskog teksta
 * i — od 01.08.2026 — `preserveAspectRatio="none"`, bez kojeg odstampani barkod ne
 * moze imati KONSTANTNU visinu (bwip-js ne upisuje width/height, samo viewBox, pa
 * odnos stranica zavisi od broja modula tj. od duzine sadrzaja).
 */

/** bwip-js crta u jedinicama gde je JEDAN modul (uzak element) = 2 jedinice. */
const UNITS_PER_MODULE = 2;

function viewBox(svg: string): { w: number; h: number } {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!m) throw new Error(`SVG nema viewBox: ${svg.slice(0, 80)}`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

describe("BarcodeService", () => {
  const service = new BarcodeService();

  it("prazna vrednost puca", () => {
    expect(() => service.code128Svg("")).toThrow(/prazna vrednost/i);
    expect(() => service.code128Svg("   ")).toThrow(/prazna vrednost/i);
  });

  it("Code 128 simbologija: broj modula = 11*(start+znakovi+kontrolni)+13, bez teksta", () => {
    // Cist Code B sadrzaj (bez dugackih cifrenih nizova koje bwip pakuje u Code C).
    for (const text of ["A", "AB", "RNZ:10354:9811-3/77:0:A"]) {
      const svg = service.code128Svg(text);
      const modules = 11 * (1 + text.length + 1) + 13;
      expect(viewBox(svg).w).toBe(modules * UNITS_PER_MODULE);
      expect(svg).not.toContain("<text"); // includetext: false
    }
  });

  it("bez `stretch`: nema preserveAspectRatio (zateceno ponasanje ostaje)", () => {
    const svg = service.code128Svg("RNZ:10354:9811-3/77:0:A", { height: 11 });
    expect(svg).not.toContain("preserveAspectRatio");
  });

  it('`stretch`: preserveAspectRatio="none" na korenu, viewBox i crte netaknuti', () => {
    const text = "RNZ:10354:9811-3/77:0:A";
    const plain = service.code128Svg(text, { height: 11 });
    const stretched = service.code128Svg(text, { height: 11, stretch: true });

    expect(stretched).toMatch(/^<svg[^>]*\spreserveAspectRatio="none"/);
    expect(viewBox(stretched)).toEqual(viewBox(plain));
    // Jedina razlika je atribut na korenu — sadrzaj (crte) je identican.
    expect(stretched.replace(' preserveAspectRatio="none"', "")).toBe(plain);
  });

  it("`stretch` je idempotentan (jedan atribut, ne dva)", () => {
    const svg = service.code128Svg("S:20:8.4:0:A", { stretch: true });
    expect(svg.match(/preserveAspectRatio/g)).toHaveLength(1);
  });

  it("`height` menja SAMO viewBox visinu, ne sirinu (tj. ne odnos crta)", () => {
    const a = service.code128Svg("S:20:8.4:0:A", { height: 9 });
    const b = service.code128Svg("S:20:8.4:0:A", { height: 11 });
    expect(viewBox(a).w).toBe(viewBox(b).w);
    expect(viewBox(a).h).toBeLessThan(viewBox(b).h);
  });
});

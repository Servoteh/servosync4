import { parseReference } from "./reference-parser.util";

/**
 * FX_OdrediBrojDokumenta port — kandidati broja dokumenta iz poziva na broj.
 * Invarijanta koju svi slučajevi drže: prvi kandidat je UVEK sirov trim (egzaktan
 * pogodak ne sme da regresira). Ostali kandidati su BigBit-nivo fuzzy varijante.
 */
describe("reference-parser.util — parseReference", () => {
  it("sirov trim je uvek PRVI kandidat (egzaktan match očuvan)", () => {
    expect(parseReference("12345").candidates[0]).toBe("12345");
    expect(parseReference("  123-456  ").candidates[0]).toBe("123-456");
  });

  it("čist broj bez separatora → jedan kandidat (sirov)", () => {
    expect(parseReference("12345").candidates).toEqual(["12345"]);
  });

  it("model 97 INLINE (PNB počinje 97+KK) skida 97+kontrolni prefiks (4 znaka)", () => {
    const { candidates } = parseReference("9732001234");
    expect(candidates[0]).toBe("9732001234"); // egzaktan ostaje prvi
    expect(candidates).toContain("001234"); // skinut 97 + kontrolni broj
    expect(candidates).toContain("1234"); // + bez vodećih nula
  });

  it("model 97 RAZDVOJEN (FX kolona Model=97, PNB nosi KK+osnovu) → skinut 2-cifreni KK", () => {
    const { candidates } = parseReference("32001234", "97");
    expect(candidates[0]).toBe("32001234");
    expect(candidates).toContain("001234");
    expect(candidates).toContain("1234");
  });

  it("model 99 (bez kontrole) → NE skida ništa", () => {
    expect(parseReference("1234", "99").candidates).toEqual(["1234"]);
  });

  it("segmentacija po crticama → svaki segment + kombinacije susednih", () => {
    const { candidates } = parseReference("123-456");
    expect(candidates).toContain("123");
    expect(candidates).toContain("456");
    expect(candidates).toContain("123456"); // spojena susedna
  });

  it("FX separatori zagrade i obrnuta kosa crta → izolovan broj dokumenta", () => {
    // (1234)\5678 — legacy „(brojDok)\" obrazac
    const { candidates } = parseReference("(1234)\\5678");
    expect(candidates).toContain("1234");
    expect(candidates).toContain("5678");
  });

  it("kose crte → segmenti", () => {
    const { candidates } = parseReference("123/456");
    expect(candidates).toContain("123");
    expect(candidates).toContain("456");
  });

  it("varijante bez vodećih nula", () => {
    const { candidates } = parseReference("00123");
    expect(candidates[0]).toBe("00123");
    expect(candidates).toContain("123");
  });

  it("broj/godina (kosa crta) → goli broj kao kandidat", () => {
    const { candidates } = parseReference("123/2026");
    expect(candidates[0]).toBe("123/2026");
    expect(candidates).toContain("123");
  });

  it("broj-godina (crtica) → normalizovan broj/godina i goli broj", () => {
    const { candidates } = parseReference("123-2026");
    expect(candidates[0]).toBe("123-2026");
    expect(candidates).toContain("123/2026");
    expect(candidates).toContain("123");
  });

  it("kombinacije susednih segmenata (3 segmenta)", () => {
    const { candidates } = parseReference("12 34 56");
    expect(candidates).toContain("1234"); // susedni 12+34
    expect(candidates).toContain("3456"); // susedni 34+56
    expect(candidates).toContain("123456"); // sva tri
  });

  it("prazan / null / samo razmaci → nema kandidata", () => {
    expect(parseReference("").candidates).toEqual([]);
    expect(parseReference(null).candidates).toEqual([]);
    expect(parseReference(undefined).candidates).toEqual([]);
    expect(parseReference("     ").candidates).toEqual([]);
  });

  it("predugačak PNB bez separatora → nijedan kandidat (documentNumber je VarChar(30))", () => {
    expect(parseReference("1".repeat(45)).candidates).toEqual([]);
  });

  it("bez duplikata i uz očuvan prioritet (prvi = sirov)", () => {
    const { candidates } = parseReference("123-456");
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates[0]).toBe("123-456");
  });
});

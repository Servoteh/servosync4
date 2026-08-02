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

  it("broj-DVOCIFRENA godina (novi format O-F1) → normalizovan broj/GG", () => {
    // Uplata na naš račun `657/25`: kupac u PNB kuca „657-25" ili „657/25".
    const { candidates } = parseReference("657-25");
    expect(candidates[0]).toBe("657-25");
    expect(candidates).toContain("657/25");
    expect(candidates).toContain("657");
  });

  it("četvorocifrena godina daje i skraćeni oblik broja (123/2026 → 123/26)", () => {
    // Kupac kuca punu godinu, a naš dokument je u obliku `123/26` — mora se naći.
    const { candidates } = parseReference("123-2026");
    expect(candidates).toContain("123/2026");
    expect(candidates).toContain("123/26");
    expect(candidates[0]).toBe("123-2026"); // egzaktan ostaje prvi
  });

  it("model 97 + broj/GG → skinut kontrolni broj pa rekonstruisan broj/GG", () => {
    const { candidates } = parseReference("97 12 657 25");
    expect(candidates[0]).toBe("97 12 657 25");
    expect(candidates).toContain("657/25");
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

  /**
   * PNB KOJI JE DATUM — česta pojava kad platilac nema broj fakture pri ruci.
   * Kvar: od `12-08-26` parser je pravio „broj/godina" `08/26`, pa i `8/26` bez
   * vodeće nule — a to je od odluke O-F1 oblik NAŠIH brojeva, pa je uplata sletala
   * na tuđu fakturu 8/26. Ranije nemoguće: broj je nosio slovni prefiks.
   */
  describe("poziv na broj koji je DATUM ne sme da dâ broj fakture", () => {
    it("SCENARIO 12-08-26 → nema ni 08/26 ni 8/26 (samo sirov trim)", () => {
      const { candidates } = parseReference("12-08-26");

      expect(candidates).toEqual(["12-08-26"]); // egzaktan ostaje, izvedenih nema
      expect(candidates).not.toContain("8/26");
      expect(candidates).not.toContain("08/26");
      // Ni goli komadi datuma ne smeju da postanu kandidati.
      expect(candidates).not.toContain("08");
      expect(candidates).not.toContain("8");
      expect(candidates).not.toContain("26");
    });

    it("ostali zapisi datuma: tačke, kosa crta, puna godina, ISO", () => {
      for (const raw of [
        "12.08.26",
        "12/08/26",
        "12-08-2026",
        "12.8.2026",
        "2026-08-12",
        "31.12.2025",
      ]) {
        expect(parseReference(raw).candidates).toEqual([raw]);
      }
    });

    it("model ispred datuma (97 12-08-26) → i dalje bez izmišljenog 08/26", () => {
      const { candidates } = parseReference("97 12-08-26");
      expect(candidates[0]).toBe("97 12-08-26");
      expect(candidates).not.toContain("08/26");
      expect(candidates).not.toContain("8/26");
    });

    it("nemoguć datum NIJE datum (32-13-26 je i dalje običan PNB)", () => {
      const { candidates } = parseReference("32-13-26");
      expect(candidates).toContain("13/26"); // dan 32 / mesec 13 ne postoje
    });
  });

  describe("legitimni pozivi na broj se NE kvare datumskim pravilom", () => {
    it("657-25 i 657/25 i dalje daju 657/25", () => {
      expect(parseReference("657-25").candidates).toContain("657/25");
      expect(parseReference("657/25").candidates[0]).toBe("657/25");
      expect(parseReference("657/25").candidates).toContain("657");
    });

    it("model 97 + broj + godina (97 657 25) → 657/25", () => {
      const { candidates } = parseReference("97 657 25");
      expect(candidates[0]).toBe("97 657 25");
      expect(candidates).toContain("657/25");
    });

    it("model 97 razdvojen (Model=97, PNB 657-25) → 657/25", () => {
      const { candidates } = parseReference("657-25", "97");
      expect(candidates).toContain("657/25");
    });

    it("četvorocifreni PNB + godina (9712 657-25) nije datum", () => {
      const { candidates } = parseReference("9712 657-25");
      expect(candidates).toContain("657/25");
    });

    it("dan/mesec bez vodeće nule uz dvocifrenu godinu ostaje broj (11 5 26)", () => {
      // Realno je to model 11 + broj 5 + godina 26, ne 11. maj 2026 — datum ljudi
      // kucaju dopunjen (`11-05-26`). Pravilo je namerno usko.
      const { candidates } = parseReference("11 5 26");
      expect(candidates).toContain("5/26");
    });

    it("broj/puna godina (123-2026) i dalje daje 123/2026 i 123/26", () => {
      const { candidates } = parseReference("123-2026");
      expect(candidates).toContain("123/2026");
      expect(candidates).toContain("123/26");
    });
  });
});

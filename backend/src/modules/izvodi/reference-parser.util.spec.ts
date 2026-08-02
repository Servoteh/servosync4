import { parseReference, SERIES_PREFIXES } from "./reference-parser.util";
import { seriesPrefixFor } from "../sales/numbering.service";

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

  /**
   * PREFIKS SERIJE (`A-`, odluka O-F6) NE SME DA ISCURI.
   * ─────────────────────────────────────────────────────────────────────────────
   * Prefiks postoji zato što avansni račun i faktura završavaju na istom kupčevom
   * kontu, a otvorene stavke se grupišu samo po BROJU (`ledger_entries` nema vrstu).
   * Parser ga je na kraju skidao: `A-7/26` → i kandidat `7/26`, dakle broj KONAČNE
   * FAKTURE. Dok je avansna stavka otvorena, egzaktan kandidat je prvi i sve radi;
   * čim se avans zatvori, uplata pozvana na avans sedne na fakturu.
   */
  describe("poziv na broj sa prefiksom serije ne sme da dâ broj bez prefiksa", () => {
    it("SCENARIO A-7/26 → svi kandidati nose `A-`, nijedan nije goli 7/26", () => {
      const { candidates } = parseReference("A-7/26");

      expect(candidates[0]).toBe("A-7/26"); // egzaktan ostaje prvi
      expect(candidates).toEqual(["A-7/26", "A-7", "A-726", "A-26"]);
      // Broj konačne fakture i njegovi komadi ne smeju da postoje kao kandidati.
      expect(candidates).not.toContain("7/26");
      expect(candidates).not.toContain("7");
      expect(candidates).not.toContain("726");
      expect(candidates).not.toContain("26");
      // Ni goli prefiks (poklopio bi se sa bilo čim što tako počinje).
      expect(candidates).not.toContain("A");
    });

    it("PNB bez crtice ili sa razmakom i dalje pogađa upisani broj `A-7/26`", () => {
      // Numeracija upisuje `A-7/26`; kupac kuca kako mu dođe, pa se prefiks vraća u
      // KANONSKOM obliku. Bez ovoga bi legitimna avansna uplata izgubila i egzaktan pogodak.
      for (const raw of ["A7/26", "A 7/26", "a-7/26", "A/7/26"]) {
        const { candidates } = parseReference(raw);
        expect(candidates[0]).toBe(raw.trim());
        expect(candidates).toContain("A-7/26");
        expect(candidates).not.toContain("7/26");
      }
    });

    it("prefiks + puna godina (A-7/2026) daje i skraćeni oblik, sve sa prefiksom", () => {
      const { candidates } = parseReference("A-7/2026");
      expect(candidates).toContain("A-7/2026");
      expect(candidates).toContain("A-7/26");
      expect(candidates).not.toContain("7/2026");
      expect(candidates).not.toContain("7/26");
    });

    it("datumska brana važi i unutar serije (A-12-08-26 ne daje A-8/26 ni 8/26)", () => {
      const { candidates } = parseReference("A-12-08-26");
      expect(candidates).toEqual(["A-12-08-26"]);
      expect(candidates).not.toContain("A-8/26");
      expect(candidates).not.toContain("8/26");
    });

    it("slovo bez broja iza sebe NIJE serija (A, ABC123 se ne kljukaju prefiksom)", () => {
      expect(parseReference("ABC123").candidates).toEqual(["ABC123"]);
      expect(parseReference("A").candidates).toEqual(["A"]);
    });

    it("numerički PNB nije dotaknut pravilom (657-25, 97 657 25, 12-08-26)", () => {
      expect(parseReference("657-25").candidates).toContain("657/25");
      expect(parseReference("97 657 25").candidates).toContain("657/25");
      expect(parseReference("12-08-26").candidates).toEqual(["12-08-26"]);
      expect(parseReference("7/26").candidates).toContain("7/26");
    });

    /**
     * MODEL ISPRED SERIJE — ista rupa, jedan zapis dalje (treći krug pregleda 02.08.2026).
     * Brana je gledala samo POČETAK sirovog PNB-a, pa je bilo dovoljno da platilac ispred
     * serije otkuca model ili kontrolni broj da bi `7/26` (broj KONAČNE fakture) opet
     * iscurio. Izmereno na starom kodu: `97 A-7/26` → […,"7","726","26","7/26"].
     */
    it("SCENARIO 97 A-7/26 (model ispred serije) → nijedan kandidat bez `A-`", () => {
      const { candidates } = parseReference("97 A-7/26");

      expect(candidates[0]).toBe("97 A-7/26"); // egzaktan ostaje prvi
      expect(candidates).toEqual([
        "97 A-7/26",
        "A-7/26",
        "A-7",
        "A-726",
        "A-26",
      ]);
      expect(candidates).not.toContain("7/26");
      expect(candidates).not.toContain("7");
      expect(candidates).not.toContain("726");
      expect(candidates).not.toContain("26");
    });

    it("model + kontrolni broj ispred serije, u sva tri zapisa", () => {
      // Slepljeno („97124"), razdvojeno („97 12") i bez razmaka do serije — sve tri
      // varijante stižu iz banke, i nijedna ne sme da probije branu.
      for (const raw of [
        "97124 A-7/26",
        "97 12 A-7/26",
        "97A-7/26",
        "9712-A-7/26",
      ]) {
        const { candidates } = parseReference(raw);
        expect(candidates[0]).toBe(raw);
        expect(candidates).toContain("A-7/26");
        expect(candidates).not.toContain("7/26");
        expect(candidates).not.toContain("726");
      }
    });

    it("datumska brana važi i kad model gura seriju (97 A-12-08-26)", () => {
      const { candidates } = parseReference("97 A-12-08-26");
      expect(candidates).toEqual(["97 A-12-08-26", "A-12-08-26"]);
      expect(candidates).not.toContain("8/26");
      expect(candidates).not.toContain("A-8/26");
    });

    it("slovo koje NIJE serija ostaje netaknuto i iza modela (97 B-7/26 → 7/26)", () => {
      // Brana važi samo za serije iz numeracije; svako drugo slovo je i dalje običan
      // separator-šum, pa se `7/26` legitimno rekonstruiše.
      expect(parseReference("B-7/26").candidates).toContain("7/26");
      expect(parseReference("97 B-7/26").candidates).toContain("7/26");
    });

    it("svesno odstupanje ostaje: `A 657/25` ne daje goli broj fakture", () => {
      // Slovo „A" kao šum ispred broja fakture i dalje odvodi uparivanje na fallback
      // po iznosu — pošten promašaj je jeftiniji od zatvaranja pogrešne stavke.
      const { candidates } = parseReference("A 657/25");
      expect(candidates[0]).toBe("A 657/25");
      expect(candidates).toContain("A-657/25");
      expect(candidates).not.toContain("657/25");
    });

    it("čisto numerički PNB sa modelom nije dotaknut (97 657 25 i dalje daje 657/25)", () => {
      // Glava se odbacuje SAMO kad iza nje stoji oznaka serije; bez slova se ne menja ništa.
      expect(parseReference("97 657 25").candidates).toContain("657/25");
      expect(parseReference("9712 657-25").candidates).toContain("657/25");
      expect(parseReference("123-2026").candidates).toContain("123/2026");
      expect(parseReference("12-08-26").candidates).toEqual(["12-08-26"]);
    });

    it("prefiks serije je isti kao u numeraciji (jedna istina za AVR)", () => {
      // Kad bi se razišli, parser bi opet propuštao goli broj — i to tiho.
      expect(SERIES_PREFIXES).toContain(seriesPrefixFor("AVR"));
      expect(seriesPrefixFor("IFR")).toBe(""); // faktura nema seriju
    });
  });
});

import {
  normalizeRacunOut,
  RACUN_AI_TOOL,
  RACUN_MAX_FAJLOVA,
} from "./odrzavanje-racun-ai";

/**
 * Čitanje računa servisa — normalizacija tool izlaza. Izlaz je NOVČANI iznos koji
 * ulazi u trošak vozila, pa se ovde brani ono što model ume da promaši: tip broja,
 * negativne vrednosti i lažno „pročitano" kad polje zapravo fali.
 */
describe("normalizeRacunOut", () => {
  it("mapira pun račun u camelCase i brojeve", () => {
    const out = normalizeRacunOut({
      ukupan_iznos: 42800,
      iznos_bez_pdv: 35666.67,
      valuta: "rsd",
      datum: "28.07.2026",
      serviser: "  Auto Čačak d.o.o.  ",
      broj_racuna: "2026-1183",
      kilometraza: 148320,
      registracija: "bg2884xa",
      opis_radova: "Mali servis, zamena EGR ventila.",
      stavke: [
        {
          naziv: "EGR ventil",
          kolicina: 1,
          jedinica: "kom",
          jedinicna_cena: 24000,
          iznos: 24000,
        },
        { naziv: "Ulje 5W30", kolicina: 5, jedinica: "l", iznos: 7500 },
      ],
    });
    expect(out.ukupanIznos).toBe(42800);
    expect(out.iznosBezPdv).toBeCloseTo(35666.67);
    expect(out.valuta).toBe("RSD");
    expect(out.serviser).toBe("Auto Čačak d.o.o.");
    expect(out.registracija).toBe("BG2884XA"); // tablice uvek velikim
    expect(out.kilometraza).toBe(148320);
    expect(out.stavke).toHaveLength(2);
    expect(out.stavke[1].jedinicnaCena).toBeNull(); // nije bila na računu
    expect(out.necitljivo).toEqual([]);
  });

  it("prijavljuje polja koja model NIJE pročitao (ne veruje mu na reč)", () => {
    const out = normalizeRacunOut({
      ukupan_iznos: null,
      datum: "",
      serviser: "   ",
      stavke: [],
      necitljivo: [], // model tvrdi da je sve pročitao — server presuđuje
    });
    expect(out.necitljivo).toEqual(["ukupan_iznos", "datum", "serviser"]);
  });

  it("prihvata broj kao string i odbacuje besmislice", () => {
    const out = normalizeRacunOut({
      ukupan_iznos: "42800.00",
      iznos_bez_pdv: "nečitko",
      kilometraza: "148320.7",
      datum: "28.07.2026",
      serviser: "X",
      stavke: [{ naziv: "Rad", kolicina: "2", iznos: "-500" }],
    });
    expect(out.ukupanIznos).toBe(42800);
    expect(out.iznosBezPdv).toBeNull();
    expect(out.kilometraza).toBe(148321); // km je ceo broj
    expect(out.stavke[0].kolicina).toBe(2);
    expect(out.stavke[0].iznos).toBeNull(); // negativan iznos se ne upisuje
  });

  it("izbacuje stavke bez naziva i podnosi izostale nizove", () => {
    const out = normalizeRacunOut({
      ukupan_iznos: 1000,
      datum: "01.08.2026",
      serviser: "Y",
      stavke: [{ naziv: "" }, { naziv: "Filter" }, null],
    });
    expect(out.stavke.map((s) => s.naziv)).toEqual(["Filter"]);
  });

  it("ne pada na praznom objektu (model je odbio/vratio smeće)", () => {
    const out = normalizeRacunOut({});
    expect(out.ukupanIznos).toBeNull();
    expect(out.stavke).toEqual([]);
    expect(out.valuta).toBe("RSD");
    expect(out.necitljivo).toHaveLength(3);
  });

  it("alat traži iznos, datum, servisera i stavke", () => {
    expect(RACUN_AI_TOOL.name).toBe("racun");
    expect(RACUN_AI_TOOL.input_schema.required).toEqual([
      "ukupan_iznos",
      "datum",
      "serviser",
      "stavke",
    ]);
    expect(RACUN_MAX_FAJLOVA).toBe(8);
  });
});

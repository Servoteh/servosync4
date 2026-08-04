import {
  periodicniNaslov,
  sledeciPeriodicniTermin,
} from "./periodicni-rollover";

/**
 * Periodična serija (zahtev 024/26, predlog d1) — čiste fn, bez mockova.
 * Isto pravilo koriste automatika (`sast-periodicni-auto`) i najava u listi,
 * pa ovi testovi brane oba mesta odjednom.
 */
describe("sledeciPeriodicniTermin (024/26 d1)", () => {
  it("osnovni korak: datum + interval (7 dana)", () => {
    expect(
      sledeciPeriodicniTermin({
        datum: "2026-08-03",
        intervalDays: 7,
        danas: "2026-08-04",
        praznici: [],
      }),
    ).toBe("2026-08-10");
  });

  it("interval 30 preko granice meseca", () => {
    expect(
      sledeciPeriodicniTermin({
        datum: "2026-07-20",
        intervalDays: 30,
        danas: "2026-07-21",
        praznici: [],
      }),
    ).toBe("2026-08-19");
  });

  it("catch-up: serija koja je stajala NE ispaljuje zaostale termine, nego prvi >= danas (korak čuva ritam)", () => {
    // 01.07 + 7k dana: 08.07, 15.07, 22.07, 29.07, 05.08 — prvi koji nije prošao.
    expect(
      sledeciPeriodicniTermin({
        datum: "2026-07-01",
        intervalDays: 7,
        danas: "2026-08-04",
        praznici: [],
      }),
    ).toBe("2026-08-05");
  });

  it("termin sme da padne na danas (catch-up staje na >= danas)", () => {
    expect(
      sledeciPeriodicniTermin({
        datum: "2026-07-28",
        intervalDays: 7,
        danas: "2026-08-04",
        praznici: [],
      }),
    ).toBe("2026-08-04");
  });

  it("neradni praznik pomera termin napred na prvi dan koji nije praznik (paritet sast_adjust_for_holiday)", () => {
    expect(
      sledeciPeriodicniTermin({
        datum: "2026-08-03",
        intervalDays: 7,
        danas: "2026-08-04",
        praznici: ["2026-08-10", "2026-08-11"],
      }),
    ).toBe("2026-08-12");
  });

  it("praznik koji NIJE na terminu ne pomera ništa", () => {
    expect(
      sledeciPeriodicniTermin({
        datum: "2026-08-03",
        intervalDays: 14,
        danas: "2026-08-04",
        praznici: ["2026-08-10"],
      }),
    ).toBe("2026-08-17");
  });
});

describe("periodicniNaslov (024/26 d1 — naslov novog termina serije)", () => {
  it("skida postojeći datum-rep i dodaje novi (obrazac sedmične automatike)", () => {
    expect(
      periodicniNaslov("Kolegijum nabavke — 20.07.2026.", "2026-08-03"),
    ).toBe("Kolegijum nabavke — 03.08.2026.");
  });

  it("naslov bez datuma dobija datum-rep", () => {
    expect(periodicniNaslov("Kolegijum nabavke", "2026-08-03")).toBe(
      "Kolegijum nabavke — 03.08.2026.",
    );
  });

  it("podnosi i crticu/kratke datume bez tačke na kraju", () => {
    expect(periodicniNaslov("Sastanak - 3.8.2026", "2026-09-01")).toBe(
      "Sastanak — 01.09.2026.",
    );
  });

  it("prazan naslov → podrazumevana osnova", () => {
    expect(periodicniNaslov("", "2026-08-03")).toBe(
      "Periodični sastanak — 03.08.2026.",
    );
  });
});

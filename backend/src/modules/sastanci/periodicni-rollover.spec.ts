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

  it("MAJOR-2: pomeranje za praznik NE ulazi u ritam — serija petkom se posle praznika VRAĆA na petak", () => {
    const praznici = ["2026-08-14"]; // petak-praznik usred serije
    // Korak 1: baza 07.08 (petak) + 7 = 14.08 → praznik → termin 15.08 (subota).
    expect(
      sledeciPeriodicniTermin({
        datum: "2026-08-07",
        intervalDays: 7,
        danas: "2026-08-08",
        praznici,
      }),
    ).toBe("2026-08-15");
    // Korak 2: ulaz je BAZA pomerenog repa (14.08, izvedena lancem — v.
    // bazaLancaUpit), NIKAD upisani 15.08 → 21.08, opet petak. `posle` (upisani
    // 15.08) garantuje da naslednik ne padne pre samog repa.
    expect(
      sledeciPeriodicniTermin({
        datum: "2026-08-14",
        intervalDays: 7,
        danas: "2026-08-16",
        praznici,
        posle: "2026-08-15",
      }),
    ).toBe("2026-08-21");
  });

  it("posle: rep pomeren DALEKO unapred ne dobija naslednika pre sebe (korak ostaje na rešetki)", () => {
    expect(
      sledeciPeriodicniTermin({
        datum: "2026-08-07",
        intervalDays: 7,
        danas: "2026-08-01",
        praznici: [],
        posle: "2026-08-20",
      }),
    ).toBe("2026-08-21"); // 14.08 ≤ posle → 21.08 (i dalje petak-rešetka)
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

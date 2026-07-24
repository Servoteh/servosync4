import { belgradeParts, belgradeTimeToUtc, shiftBelgradeDate } from "./belgrade-time";

describe("belgrade-time — Europe/Belgrade bez zavisnosti", () => {
  it("letnje računanje (CEST, +2h): 07:00Z = 09:00 lokalno", () => {
    const p = belgradeParts(new Date("2026-07-24T07:00:00Z"));
    expect(p).toMatchObject({ year: 2026, month: 7, day: 24, hour: 9, minute: 0 });
    expect(p.isoDow).toBe(5); // petak
  });

  it("zimsko računanje (CET, +1h): 07:00Z = 08:00 lokalno", () => {
    const p = belgradeParts(new Date("2026-01-15T07:00:00Z"));
    expect(p).toMatchObject({ year: 2026, month: 1, day: 15, hour: 8 });
  });

  it("belgradeTimeToUtc: leto 09:00 lokalno → 07:00Z; zima 08:00 lokalno → 07:00Z", () => {
    expect(belgradeTimeToUtc(2026, 7, 24, 9, 0).toISOString()).toBe(
      "2026-07-24T07:00:00.000Z",
    );
    expect(belgradeTimeToUtc(2026, 1, 15, 8, 0).toISOString()).toBe(
      "2026-01-15T07:00:00.000Z",
    );
  });

  it("ponoć lokalno (Intl '24' normalizacija) — 2026-07-24 00:00 lokalno = 23. 22:00Z", () => {
    expect(belgradeTimeToUtc(2026, 7, 24, 0, 0).toISOString()).toBe(
      "2026-07-23T22:00:00.000Z",
    );
    expect(belgradeParts(new Date("2026-07-23T22:00:00Z")).hour).toBe(0);
  });

  it("DST prolećni preskok (29.03.2026): nepostojeće 02:30 mapira SAT KASNIJE (posao se ne guta)", () => {
    const utc = belgradeTimeToUtc(2026, 3, 29, 2, 30);
    const back = belgradeParts(utc);
    expect(back).toMatchObject({ year: 2026, month: 3, day: 29, hour: 3, minute: 30 });
  });

  it("DST jesenje vraćanje (25.10.2026): dvosmisleno 02:30 daje DETERMINISTIČKI trenutak", () => {
    const utc = belgradeTimeToUtc(2026, 10, 25, 2, 30);
    const back = belgradeParts(utc);
    expect(back).toMatchObject({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 });
  });

  it("okolo DST-a raspored 06:00 lokalno postoji SVAKOG dana (28–30.03)", () => {
    for (const day of [28, 29, 30]) {
      const utc = belgradeTimeToUtc(2026, 3, day, 6, 0);
      expect(belgradeParts(utc)).toMatchObject({ day, hour: 6, minute: 0 });
    }
  });

  it("shiftBelgradeDate preko granice meseca i DST-a", () => {
    expect(shiftBelgradeDate({ year: 2026, month: 8, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 7,
      day: 31,
    });
    expect(shiftBelgradeDate({ year: 2026, month: 3, day: 29 }, -1)).toEqual({
      year: 2026,
      month: 3,
      day: 28,
    });
  });
});

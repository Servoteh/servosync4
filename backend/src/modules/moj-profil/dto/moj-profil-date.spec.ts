import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AttendanceRangeQueryDto } from "./moj-profil-query.dto";
import { AttendanceEventsQueryDto } from "./moj-profil-profile.dto";
import { isCalendarDateString } from "./is-calendar-date";

/**
 * Strogi kalendarski datumi (zahtev 011/26, review nalaz #2). Ovi DTO-ovi su DELJENI između
 * self ruta (`/profile/attendance`, `/profile/attendance/events`) i timskih
 * (`/profile/team/:id/attendance*`) — validacija ovde pokriva OBE rute. Cilj: labavi ISO-8601 /
 * regex (koji su propuštali `2026-W30`/`2026-07`/`2026-200`/`2026-02-31` do Postgresa → 22007/22008
 * → 500) više NE prolaze — DTO baca 400 pre baze.
 */
describe("moj-profil — strogi kalendarski datum (nalaz #2)", () => {
  describe("isCalendarDateString", () => {
    it.each([
      ["2026-07-15", true],
      ["2026-02-28", true],
      ["2024-02-29", true], // prestupna
      ["2026-02-31", false], // kalendarski nepostojeći
      ["2026-13-01", false], // mesec 13
      ["2026-00-10", false], // mesec 0
      ["2026-07-00", false], // dan 0
      ["2026-07-32", false], // dan 32
      ["2026-W30", false], // ISO week
      ["2026-07", false], // samo mesec
      ["2026-200", false], // ordinal
      ["2026-7-5", false], // bez padding-a
      ["", false],
    ])("%s → %s", (val, expected) => {
      expect(isCalendarDateString(val)).toBe(expected);
    });

    it("ne-string → false", () => {
      expect(isCalendarDateString(undefined)).toBe(false);
      expect(isCalendarDateString(20260715)).toBe(false);
      expect(isCalendarDateString(null)).toBe(false);
    });
  });

  const errs = (cls: unknown, obj: Record<string, unknown>) =>
    validateSync(
      plainToInstance(cls as new () => object, obj) as object,
    );

  describe("AttendanceRangeQueryDto (self + team /attendance)", () => {
    it("prazan opseg = OK (from/to opcioni)", () => {
      expect(errs(AttendanceRangeQueryDto, {})).toHaveLength(0);
    });
    it("validni from/to = OK", () => {
      expect(
        errs(AttendanceRangeQueryDto, { from: "2026-07-01", to: "2026-07-31" }),
      ).toHaveLength(0);
    });
    it("from=2026-02-31 (kalendarski loš) = greška", () => {
      expect(
        errs(AttendanceRangeQueryDto, { from: "2026-02-31" }).length,
      ).toBeGreaterThan(0);
    });
    it.each(["2026-W30", "2026-07", "2026-200"])("to=%s = greška", (to) => {
      expect(errs(AttendanceRangeQueryDto, { to }).length).toBeGreaterThan(0);
    });
  });

  describe("AttendanceEventsQueryDto (self + team /attendance/events)", () => {
    it("validan day = OK", () => {
      expect(
        errs(AttendanceEventsQueryDto, { day: "2026-07-15" }),
      ).toHaveLength(0);
    });
    it.each(["2026-02-31", "2026-07", "2026-W30", ""])(
      "day=%s = greška",
      (day) => {
        expect(errs(AttendanceEventsQueryDto, { day }).length).toBeGreaterThan(
          0,
        );
      },
    );
  });
});

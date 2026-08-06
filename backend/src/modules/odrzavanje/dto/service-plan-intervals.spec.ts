import { UnprocessableEntityException } from "@nestjs/common";
import {
  assertAtLeastOneInterval,
  AT_LEAST_ONE_INTERVAL_MSG,
  normalizeAssetIntervalMonths,
  normalizeInterval,
} from "./service-plan-intervals";

/**
 * Zahtev 073/26 (Duško Kostić, BUG/HIGH): „Ne mogu da sačuvam servisni plan,
 * izbacuje mi grešku 'interval u mesecima mora biti pozitivan'."
 *
 * Servis automobila se vodi po kilometraži, po vremenu ili po oba. Pravilo koje
 * ostaje je JEDNO — bar jedan interval (isto što čuva i DB CHECK
 * `maint_vsp_at_least_one_interval`); sve ostalo što je odbijalo unos je ovde
 * prevedeno u „nije zadato".
 */
describe("Intervali servisnog plana (073/26)", () => {
  describe("normalizeInterval — 0 i null znače nije zadato, ne greška", () => {
    it("0 → null (tako korisnik kaže: ne vodi se po mesecima)", () => {
      expect(normalizeInterval(0, "months")).toBeNull();
      expect(normalizeInterval(0, "km")).toBeNull();
    });

    it("null → null (eksplicitno brisanje već upisanog intervala)", () => {
      expect(normalizeInterval(null, "months")).toBeNull();
    });

    it("undefined → undefined (PATCH bez ključa NE dira postojeću vrednost)", () => {
      expect(normalizeInterval(undefined, "months")).toBeUndefined();
      expect(normalizeInterval(undefined, "km")).toBeUndefined();
    });

    it("pozitivan ceo broj prolazi nedirnut", () => {
      expect(normalizeInterval(12, "months")).toBe(12);
      expect(normalizeInterval(15000, "km")).toBe(15000);
    });

    it("negativna vrednost = 422 sa uputstvom šta da se uradi", () => {
      expect(() => normalizeInterval(-3, "months")).toThrow(
        UnprocessableEntityException,
      );
      try {
        normalizeInterval(-3, "months");
        throw new Error("nije bacio");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("Interval — meseci");
        expect(msg).toContain("ostavi prazno");
      }
    });

    it("decimala = 422 (kolona je integer), poruka nudi ceo broj", () => {
      expect(() => normalizeInterval(1.5, "months")).toThrow(/unesi ceo broj/);
    });
  });

  describe("assertAtLeastOneInterval — jedina preživela zabrana", () => {
    it("samo km (auto-servis po kilometraži) prolazi", () => {
      expect(() =>
        assertAtLeastOneInterval({ intervalKm: 15000, intervalMonths: null }),
      ).not.toThrow();
    });

    it("samo meseci prolazi", () => {
      expect(() =>
        assertAtLeastOneInterval({ intervalKm: null, intervalMonths: 12 }),
      ).not.toThrow();
    });

    it("oba zadata prolaze (dospeva šta pre dođe)", () => {
      expect(() =>
        assertAtLeastOneInterval({ intervalKm: 15000, intervalMonths: 12 }),
      ).not.toThrow();
    });

    it("nijedan → 422 sa porukom koja nudi oba primera", () => {
      expect(() =>
        assertAtLeastOneInterval({ intervalKm: null, intervalMonths: null }),
      ).toThrow(UnprocessableEntityException);
      expect(AT_LEAST_ONE_INTERVAL_MSG).toContain("15000");
      expect(AT_LEAST_ONE_INTERVAL_MSG).toContain("12");
    });

    it("IZMENA imena (oba ključa izostavljena) NE traži ponovni unos intervala", () => {
      expect(() =>
        assertAtLeastOneInterval({}, { intervalKm: null, intervalMonths: 12 }),
      ).not.toThrow();
    });

    it("brisanje meseci na planu koji ima km prolazi", () => {
      expect(() =>
        assertAtLeastOneInterval(
          { intervalMonths: null },
          { intervalKm: 15000, intervalMonths: 12 },
        ),
      ).not.toThrow();
    });

    it("brisanje POSLEDNJEG intervala → 422 (isto pravilo kao DB CHECK)", () => {
      expect(() =>
        assertAtLeastOneInterval(
          { intervalMonths: null },
          { intervalKm: null, intervalMonths: 12 },
        ),
      ).toThrow(UnprocessableEntityException);
    });
  });

  describe("normalizeAssetIntervalMonths — IT/objekti nemaju kilometražu", () => {
    it("meseci ostaju obavezni na create (kolona je NOT NULL)", () => {
      expect(() =>
        normalizeAssetIntervalMonths(undefined, { required: true }),
      ).toThrow(UnprocessableEntityException);
      expect(() => normalizeAssetIntervalMonths(0, { required: true })).toThrow(
        UnprocessableEntityException,
      );
    });

    it("0/null na PATCH-u = 422 sa porukom, NE sirovi NOT NULL iz baze", () => {
      expect(() =>
        normalizeAssetIntervalMonths(null, { required: false }),
      ).toThrow(/obavezan/);
    });

    it("izostavljen ključ na PATCH-u ne dira vrednost", () => {
      expect(
        normalizeAssetIntervalMonths(undefined, { required: false }),
      ).toBeUndefined();
    });

    it("pozitivan ceo broj prolazi", () => {
      expect(normalizeAssetIntervalMonths(12, { required: true })).toBe(12);
    });
  });
});

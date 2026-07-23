import {
  computeReferenceNumber,
  digitsOnly,
  isValidAccountNumber,
  kBroj22,
  kBroj97,
} from "./mod97.util";

/**
 * Kontrolni brojevi (MOD97 / MOD11) + DobarTR validacija računa.
 * Primeri su IZRAČUNATI iz algoritma u fajlu (ne pogađani): validan žiro račun
 * koristi format 3-13-2 gde je KK == kBroj97(banka+partija). Ključna invarijanta
 * MOD97 (ISO 7064 MOD 97-10): za izračunat poziv na broj važi (broj) mod 97 == 1.
 */
describe("mod97.util", () => {
  describe("digitsOnly", () => {
    it("izbacuje sve nenumeričke znakove", () => {
      expect(digitsOnly("160-0000000000123-95")).toBe("160000000000012395");
      expect(digitsOnly("")).toBe("");
      expect(digitsOnly("ABC")).toBe("");
    });
  });

  describe("kBroj97 (MOD97)", () => {
    it("prazan ulaz → prazan string (guard)", () => {
      expect(kBroj97("")).toBe("");
      expect(kBroj97("abc")).toBe("");
    });

    it("dvocifreni kontrolni broj — poznat primer 160+partija", () => {
      expect(kBroj97("1600000000000123")).toBe("95");
    });

    it("invarijanta: (osnova·100 + KBroj97) mod 97 == 1", () => {
      for (const base of ["1234", "9", "1600000000000123", "555555"]) {
        const kb = kBroj97(base);
        const full = BigInt(base + kb);
        expect(full % 97n).toBe(1n);
      }
    });
  });

  describe("kBroj22 (MOD11, težine 7..2)", () => {
    it("standardni 7-cifreni ulaz", () => {
      expect(kBroj22("1234567")).toBe("6");
    });

    it("ulaz koji počinje 0 → rotacija prve cifre na kraj (kbroj 11→1 grana)", () => {
      expect(kBroj22("0123456")).toBe("1");
    });

    it("kbroj 10 se mapira na 0", () => {
      expect(kBroj22("1234568")).toBe("0");
    });

    it("ulaz koji nije tačno 7 cifara → prazan string", () => {
      expect(kBroj22("123456")).toBe("");
      expect(kBroj22("12345678")).toBe("");
    });
  });

  describe("computeReferenceNumber", () => {
    it('model "99" (bez kontrole) → osnova netaknuta (samo cifre)', () => {
      expect(computeReferenceNumber("99", "1234")).toBe("1234");
    });

    it('model "97" → osnova + KBroj97, i rezultat je MOD97-konzistentan', () => {
      const ref = computeReferenceNumber("97", "1234");
      expect(ref).toBe("1234" + kBroj97("1234"));
      expect(BigInt(digitsOnly(ref)) % 97n).toBe(1n);
    });

    it('model "11" → osnova + kBroj22', () => {
      expect(computeReferenceNumber("11", "1234567")).toBe("1234567" + kBroj22("1234567"));
    });

    it("nepoznat model → tretira se kao bez kontrole", () => {
      expect(computeReferenceNumber("", "1234")).toBe("1234");
    });
  });

  describe("isValidAccountNumber (DobarTR)", () => {
    // Validan primer izračunat iz algoritma: KK = kBroj97("160" + "0000000000123") = "95".
    const bank = "160";
    const middle = "0000000000123"; // 13 cifara
    const kk = kBroj97(bank + middle);
    const validTr = `${bank}-${middle}-${kk}`;

    it("kontrolni broj primera je zaista 95 (self-check)", () => {
      expect(kk).toBe("95");
      expect(validTr).toBe("160-0000000000123-95");
    });

    it("ispravan račun (format 3-13-2 + tačan KK) → true", () => {
      expect(isValidAccountNumber(validTr)).toBe(true);
    });

    it("pogrešan kontrolni broj → false", () => {
      const wrongKk = kk === "00" ? "01" : "00";
      expect(isValidAccountNumber(`${bank}-${middle}-${wrongKk}`)).toBe(false);
    });

    it("bez crtica → false", () => {
      expect(isValidAccountNumber(digitsOnly(validTr))).toBe(false);
    });

    it("prazan / nedostajući ulaz → false", () => {
      expect(isValidAccountNumber("")).toBe(false);
      expect(isValidAccountNumber(undefined as unknown as string)).toBe(false);
    });
  });
});

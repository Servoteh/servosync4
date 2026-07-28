import "reflect-metadata";
import {
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  normalizeCustomerInput,
  validateCreateCustomer,
  validateUpdateCustomer,
  CUSTOMER_TEXT_LIMITS,
} from "./dto/upsert-customer.dto";
import {
  assertTaxIdAcceptable,
  describeCustomer,
  duplicateTaxIdWarning,
  isDriverCodeType,
  isPlaceholderTaxId,
  softValidationWarnings,
  taxIdPlaceholder,
} from "./customers.validation";

/**
 * Fiksture:
 *   `100002887` — Telekom Srbija, sidro iz `common/validation/pib.util.ts` (prolazi
 *                 legacy `DobarPIB` lanac).
 *   `123456789` — ne prolazi kontrolnu cifru.
 *   `160-123-95` — prolazi `DobarTR` (MOD97 nad `160` + `0000000000123`).
 */
const PIB_OK = "100002887";
const PIB_LOS = "123456789";
const RACUN_OK = "160-123-95";
const RACUN_LOS = "160-123-11";

describe("normalizeCustomerInput — whitelisting i tipovi", () => {
  it("odbacuje nepoznata polja i polja koja vodi server (`id`, `createdAt`, …)", () => {
    const { data, errors } = normalizeCustomerInput({
      name: "Servoteh",
      id: 7,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      createdBy: "haker",
      recordCreatedAt: "2026-01-01",
      nepostojece: "x",
    });

    expect(errors).toEqual([]);
    expect(data).toEqual({ name: "Servoteh" });
    expect("id" in data).toBe(false);
    expect("createdBy" in data).toBe(false);
  });

  it("trimuje tekst, prazan string tretira kao brisanje (`null`)", () => {
    const { data, errors } = normalizeCustomerInput({
      name: "  Servoteh  ",
      city: "   ",
      address: null,
    });

    expect(errors).toEqual([]);
    expect(data.name).toBe("Servoteh");
    expect(data.city).toBeNull();
    expect(data.address).toBeNull();
  });

  it("prekoračenje dužine kolone je greška sa imenovanim poljem i brojem znakova", () => {
    const { errors } = normalizeCustomerInput({
      name: "x".repeat(CUSTOMER_TEXT_LIMITS.name + 3),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("name");
    expect(errors[0]).toContain("najviše 50");
    expect(errors[0]).toContain("53");
  });

  it("novac postaje Prisma.Decimal (nikad float) i seče se na 4 decimale", () => {
    const { data, errors } = normalizeCustomerInput({
      creditLimit: "250000.123456",
      manualMarkupPercent: 12.5,
    });

    expect(errors).toEqual([]);
    expect(data.creditLimit).toBeInstanceOf(Prisma.Decimal);
    expect(data.creditLimit?.toString()).toBe("250000.1235");
    expect(data.manualMarkupPercent).toBeInstanceOf(Prisma.Decimal);
    expect(data.manualMarkupPercent?.toString()).toBe("12.5");
  });

  it("`paymentTermDays` je SmallInt — vrednost van opsega je greška, ne 22003 iz baze", () => {
    const { errors } = normalizeCustomerInput({ paymentTermDays: 40000 });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("paymentTermDays");
  });

  it("pogrešni tipovi daju srpsku poruku po polju", () => {
    const { errors } = normalizeCustomerInput({
      name: 5,
      salespersonId: "3",
      checkDebt: "da",
      birthDate: "ne-datum",
      creditLimit: "abc",
    });
    expect(errors).toHaveLength(5);
    expect(errors.join(" ")).toContain("mora biti tekst");
    expect(errors.join(" ")).toContain("mora biti ceo broj");
    expect(errors.join(" ")).toContain("mora biti true/false");
    expect(errors.join(" ")).toContain("ISO");
    expect(errors.join(" ")).toContain("nije ispravan iznos");
  });

  it("datum se pretvara u Date; `null` ostaje brisanje", () => {
    const { data } = normalizeCustomerInput({
      birthDate: "1980-05-17T00:00:00.000Z",
    });
    expect(data.birthDate).toBeInstanceOf(Date);
    expect((data.birthDate as Date).toISOString()).toBe(
      "1980-05-17T00:00:00.000Z",
    );
  });
});

describe("validateCreateCustomer / validateUpdateCustomer", () => {
  it("unos bez naziva je 400 (Komitenti.Naziv je NOT NULL)", () => {
    expect(() => validateCreateCustomer({ city: "Čačak" })).toThrow(
      BadRequestException,
    );
  });

  it("unos sa nazivom prolazi", () => {
    expect(validateCreateCustomer({ name: "Servoteh" })).toEqual({
      name: "Servoteh",
    });
  });

  it("izmena bez ijednog poznatog polja je 400", () => {
    expect(() => validateUpdateCustomer({ nepostojece: 1 })).toThrow(
      BadRequestException,
    );
  });

  it("naziv se sme menjati, ali ne obrisati", () => {
    expect(validateUpdateCustomer({ name: "Novi" })).toEqual({ name: "Novi" });
    expect(() => validateUpdateCustomer({ name: "" })).toThrow(
      BadRequestException,
    );
  });
});

describe("PIB — polu-tvrda brana, verna BigBit dijalogu (§3.1)", () => {
  const base = { skipTaxIdValidation: false, confirmInvalidTaxId: false };

  it("ispravan PIB prolazi bez pitanja", () => {
    expect(() =>
      assertTaxIdAcceptable({ ...base, taxId: PIB_OK }),
    ).not.toThrow();
  });

  it("prefiks „SR“ prolazi (legacy DobarPIB ga skida)", () => {
    expect(() =>
      assertTaxIdAcceptable({ ...base, taxId: `SR${PIB_OK}` }),
    ).not.toThrow();
  });

  it("pogrešan PIB → 422 `PIB_NIJE_DOBAR`, ne tiho propuštanje", () => {
    try {
      assertTaxIdAcceptable({ ...base, taxId: PIB_LOS });
      fail("očekivan izuzetak");
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      const body = (e as UnprocessableEntityException).getResponse() as {
        code: string;
        message: string;
        taxId: string | null;
      };
      expect(body.code).toBe("PIB_NIJE_DOBAR");
      expect(body.taxId).toBe(PIB_LOS);
      expect(body.message).toContain("confirmInvalidTaxId");
    }
  });

  it("`confirmInvalidTaxId` je BigBit-ov odgovor Yes preko podrazumevanog No — propušta", () => {
    expect(() =>
      assertTaxIdAcceptable({
        ...base,
        taxId: PIB_LOS,
        confirmInvalidTaxId: true,
      }),
    ).not.toThrow();
  });

  it("prazan PIB pada isto kao pogrešan (DobarPIB(\"\") = False), ali poruka to kaže", () => {
    try {
      assertTaxIdAcceptable({ ...base, taxId: null });
      fail("očekivan izuzetak");
    } catch (e) {
      const body = (e as UnprocessableEntityException).getResponse() as {
        message: string;
        taxId: string | null;
      };
      expect(body.message).toContain("PIB nije unet");
      expect(body.taxId).toBeNull();
    }
  });

  it("`skipTaxIdValidation` (NeProveravajPIB) preskače proveru — i za prazan PIB", () => {
    expect(() =>
      assertTaxIdAcceptable({
        ...base,
        taxId: null,
        skipTaxIdValidation: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertTaxIdAcceptable({
        ...base,
        taxId: PIB_LOS,
        skipTaxIdValidation: true,
      }),
    ).not.toThrow();
  });

  it("zatečen placeholder `XX_<Sifra>` ne traži potvrdu (nije korisnikov unos)", () => {
    expect(() =>
      assertTaxIdAcceptable({ ...base, taxId: "XX_4821" }),
    ).not.toThrow();
  });
});

describe("PIB placeholder (`XX_<Sifra>`, §5.1)", () => {
  it("gradi se iz šifre komitenta, isto kao BigBit IIf klauzula", () => {
    expect(taxIdPlaceholder(4821)).toBe("XX_4821");
  });

  it("prepoznaje se samo tačan oblik", () => {
    expect(isPlaceholderTaxId("XX_4821")).toBe(true);
    expect(isPlaceholderTaxId(" XX_4821 ")).toBe(true);
    expect(isPlaceholderTaxId("XX_")).toBe(false);
    expect(isPlaceholderTaxId("XXA_1")).toBe(false);
    expect(isPlaceholderTaxId(PIB_OK)).toBe(false);
    expect(isPlaceholderTaxId(null)).toBe(false);
  });
});

describe("Dupli PIB — upozorenje koje IMENUJE zatečenog komitenta (§3.3)", () => {
  it("jedan duplikat: šifra, naziv i mesto su u poruci", () => {
    const w = duplicateTaxIdWarning(PIB_OK, [
      { id: 4821, name: "Servoteh d.o.o.", city: "Čačak" },
    ]);
    expect(w).toContain("4821");
    expect(w).toContain("Servoteh d.o.o.");
    expect(w).toContain("Čačak");
    expect(w).toContain(PIB_OK);
    // BigBit duplikat DOZVOLJAVA — poruka mora reći da unos nije zaustavljen.
    expect(w).toContain("nije zaustavljen");
  });

  it("bez mesta poruka i dalje imenuje komitenta", () => {
    expect(describeCustomer({ id: 9, name: "Ino Kupac", city: null })).toBe(
      '9 — „Ino Kupac"',
    );
  });

  it("više od tri duplikata: prva tri imenovana + „i još N“", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      name: `K${i + 1}`,
      city: null,
    }));
    const w = duplicateTaxIdWarning(PIB_OK, many) ?? "";
    expect(w).toContain("K1");
    expect(w).toContain("K3");
    expect(w).not.toContain("K4");
    expect(w).toContain("i još 2");
  });

  it("nema duplikata / placeholder / prazan PIB → nema upozorenja", () => {
    expect(duplicateTaxIdWarning(PIB_OK, [])).toBeNull();
    expect(
      duplicateTaxIdWarning("XX_5", [{ id: 6, name: "X", city: null }]),
    ).toBeNull();
    expect(
      duplicateTaxIdWarning(null, [{ id: 6, name: "X", city: null }]),
    ).toBeNull();
  });
});

describe("GLN i žiro računi — SAMO upozorenja (§3.2, §3.4)", () => {
  it("neispravan GLN upozorava, ne obara zahtev", () => {
    const w = softValidationWarnings({ gln: "12345" });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("GLN");
    expect(w[0]).toContain("sačuvana");
  });

  it("ispravan GLN (6–14 cifara) ne daje upozorenje", () => {
    expect(softValidationWarnings({ gln: "1234567890123" })).toEqual([]);
  });

  it("žiro račun koji pada na MOD97 upozorava po broju polja", () => {
    const w = softValidationWarnings({
      bankAccount1: RACUN_OK,
      bankAccount2: RACUN_LOS,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("Žiro račun 2");
    expect(w[0]).toContain(RACUN_LOS);
  });

  it("polja koja zahtev NIJE poslao se ne proveravaju (PATCH ne buni tuđe podatke)", () => {
    expect(softValidationWarnings({ phone: "011/123" })).toEqual([]);
  });
});

describe("Automatika vozača (§4 :212-219)", () => {
  it("vrsta šifre koja počinje na „Voza“ (bez obzira na mala/velika slova)", () => {
    expect(isDriverCodeType("Vozac")).toBe(true);
    expect(isDriverCodeType("VOZAC1")).toBe(true);
    expect(isDriverCodeType(" vozaci ")).toBe(true);
    expect(isDriverCodeType("KUPDOB")).toBe(false);
    expect(isDriverCodeType(null)).toBe(false);
  });
});

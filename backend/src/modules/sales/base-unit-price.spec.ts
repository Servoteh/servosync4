import { Prisma } from "@prisma/client";
import { validatePricePreview } from "./pricing.controller";
import { resolveBaseUnitPrice } from "./sales.service";
import {
  DEFAULT_STOCK_CHECK,
  parseStockCheck,
} from "../../common/document-types/stock-check";

const D = Prisma.Decimal;

/**
 * REGRESIJE IZ ADVERSARNOG PREGLEDA 28.07.2026 — sva tri nalaza.
 * ===========================================================================
 * Svaki test ovde je napisan tako da NA STAROM KODU PADA. Bez toga bi bio samo
 * opis zatečenog ponašanja, a ne brana.
 */

/**
 * NALAZ 1 (KRITIČNO) — koeficijent i izmena stavke nulirali su cenu.
 *
 * `base_unit_price` je `NOT NULL DEFAULT 0`, a upisivao ga je samo novi servis.
 * Dokument napravljen bilo kojim drugim putem (`createProforma`, prepis) imao je
 * stvarnu `unitPrice` i baznu cenu 0, pa je prvi dodir stavke izvodio cenu iz
 * nule: 2 kom × 1.000 din → dokument 2.400 → izmena količine → 0.
 *
 * Popravka ima tri sloja i ovde se proverava onaj koji važi za SVAKOG budućeg
 * pisca: čitanje pada na zatečenu cenu kad bazna nije upisana.
 */
describe("resolveBaseUnitPrice — bazna cena preživljava pisca koji je ne zna", () => {
  // NAMERNO se zove PRAVA funkcija iz servisa, ne njena kopija. Bag je i prošao
  // zato što je `sales.service.spec.ts` sam sebi sejao `baseUnitPrice: 1000` —
  // test koji prepisuje logiku proverava sopstveni prepis, ne isporučeni kod.
  const resolve = resolveBaseUnitPrice;

  it("bazna cena 0 uz stvarnu cenu → uzima se stvarna (inače dokument padne na nulu)", () => {
    // Tačno stanje koje pravi `createProforma`: unitPrice upisan, base ostao na DEFAULT 0.
    const base = resolve(new D(0), new D("1000"));
    expect(base.toFixed(2)).toBe("1000.00");

    // Koeficijent 1,10 nad tim redom mora dati 1.100, ne 0.
    expect(base.mul(new D("1.10")).toFixed(2)).toBe("1100.00");
  });

  it("upisana bazna cena ima prednost nad zatečenom (koeficijent ostaje ponovljiv)", () => {
    // Red koji je koeficijent već dotakao: base 1.000, unitPrice 1.100.
    const base = resolve(new D("1000"), new D("1100"));
    expect(base.toFixed(2)).toBe("1000.00");

    // Ponovna primena istog koeficijenta daje ISTI rezultat — ne 1.210.
    expect(base.mul(new D("1.10")).toFixed(2)).toBe("1100.00");
  });

  it("stavka koja stvarno košta nula ostaje nula", () => {
    expect(resolve(new D(0), new D(0)).toFixed(2)).toBe("0.00");
    expect(resolve(null, null).toFixed(2)).toBe("0.00");
  });

  it("vraćanje koeficijenta na 1 vraća izvornu cenu", () => {
    const base = resolve(new D("1000"), new D("1100"));
    expect(base.mul(new D(1)).toFixed(2)).toBe("1000.00");
  });
});

/**
 * NALAZ 2 (VISOK) — dva suprotna podrazumevana `stock_check`.
 * Registar je padao na OFF („vrsta ne proverava zalihe"), robna ruta na BLOCK
 * („nema dovoljno zalihe") — ekran i brana su korisniku govorili suprotno.
 */
describe("stock_check — jedna podrazumevana vrednost za registar i za rutu", () => {
  it("nepopunjena kolona daje BLOCK — isto što ruta i danas radi", () => {
    // Poravnava se PRIJAVA sa SPROVOĐENJEM. `WARN`/`OFF` bi ovde tiho ugasili
    // branu od prekoračenja na 47 od 57 vrsta (migracija je posejala 10, nijednu
    // robnu izlaznu).
    expect(DEFAULT_STOCK_CHECK).toBe("BLOCK");
    expect(parseStockCheck(null)).toBe("BLOCK");
    expect(parseStockCheck(undefined)).toBe("BLOCK");
    expect(parseStockCheck("")).toBe("BLOCK");
    expect(parseStockCheck("   ")).toBe("BLOCK");
  });

  it("nepoznata vrednost iz uvoza se tretira kao nepopunjena, ne kao dozvola", () => {
    expect(parseStockCheck("DA")).toBe("BLOCK");
    expect(parseStockCheck("iskljuceno")).toBe("BLOCK");
  });

  it("podešene vrednosti se poštuju, bez obzira na slova i razmake", () => {
    expect(parseStockCheck("BLOCK")).toBe("BLOCK");
    expect(parseStockCheck(" off ")).toBe("OFF");
    expect(parseStockCheck("warn")).toBe("WARN");
  });
});

/**
 * NALAZ 3 (VISOK) — price-preview je odbijao novac kao tekst i gurao ga kroz float.
 * Susedna ruta istog modula (`POST /sales/documents/:id/items`) tekst prima, pa
 * ista forma nije mogla istim telom da pita za cenu i da upiše stavku.
 */
describe("price-preview — novac ulazi kao tekst, bez gubitka cifara", () => {
  it("cena kao string se prihvata — ranije je vraćala 400 „mora biti broj”", () => {
    const args = validatePricePreview({
      quantity: "2",
      itemId: 42,
      overrideUnitPrice: "1234.5678",
    });
    expect(args.overrideUnitPrice?.toFixed(4)).toBe("1234.5678");
    expect(args.quantity.toFixed(2)).toBe("2.00");
  });

  it("preciznost preživljava ulaz — cifre koje Number gubi ostaju", () => {
    const args = validatePricePreview({
      quantity: "1",
      itemId: 1,
      overrideUnitPrice: "12345678901234.5678",
    });
    // Kroz Number bi ovo postalo 12345678901234.568.
    expect(args.overrideUnitPrice?.toFixed(4)).toBe("12345678901234.5678");
  });

  it("broj i dalje radi — stari pozivaoci se ne lome", () => {
    const args = validatePricePreview({
      quantity: 3,
      itemId: 7,
      overrideUnitPrice: 250.5,
    });
    expect(args.quantity.toFixed(0)).toBe("3");
    expect(args.overrideUnitPrice?.toFixed(2)).toBe("250.50");
  });

  it("negativna cena i količina 0 se i dalje odbijaju", () => {
    expect(() =>
      validatePricePreview({ quantity: "1", itemId: 1, overrideUnitPrice: "-5" }),
    ).toThrow();
    expect(() =>
      validatePricePreview({ quantity: "0", itemId: 1 }),
    ).toThrow();
  });

  it("rabat preko 100% se odbija i kad stigne kao tekst", () => {
    expect(() =>
      validatePricePreview({ quantity: "1", itemId: 1, discountPercent: "120" }),
    ).toThrow();
  });
});

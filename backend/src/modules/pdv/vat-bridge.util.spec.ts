import { Prisma } from "@prisma/client";
import {
  grossToNet,
  netToGross,
  VatBridgeError,
} from "./vat-bridge.util";

/**
 * Spec za bruto↔neto most (B4). Fokus: tačnost po stopama 20/10/0 i GRANIČNA
 * zaokruženja gde zbir mora da zatvara (PDV = bruto − neto do na cent).
 */

const money = (d: Prisma.Decimal): string => d.toFixed(2);

describe("vat-bridge grossToNet", () => {
  it("20% — 1200 → 1000.00 / 200.00 (čist slučaj)", () => {
    const r = grossToNet(1200, 20);
    expect(money(r.net)).toBe("1000.00");
    expect(money(r.vat)).toBe("200.00");
  });

  it("20% — 1000 → 833.33 / 166.67 (granično zaokruženje, zbir zatvara)", () => {
    const r = grossToNet(1000, 20);
    expect(money(r.net)).toBe("833.33");
    expect(money(r.vat)).toBe("166.67");
    // Invarijanta: neto + PDV === bruto
    expect(money(r.net.add(r.vat))).toBe("1000.00");
  });

  it("10% — 1100 → 1000.00 / 100.00", () => {
    const r = grossToNet(1100, 10);
    expect(money(r.net)).toBe("1000.00");
    expect(money(r.vat)).toBe("100.00");
  });

  it("10% — 1000 → 909.09 / 90.91 (zbir zatvara)", () => {
    const r = grossToNet(1000, 10);
    expect(money(r.net)).toBe("909.09");
    expect(money(r.vat)).toBe("90.91");
    expect(money(r.net.add(r.vat))).toBe("1000.00");
  });

  it("0% — 1000 → 1000.00 / 0.00 (bez PDV)", () => {
    const r = grossToNet(1000, 0);
    expect(money(r.net)).toBe("1000.00");
    expect(money(r.vat)).toBe("0.00");
  });

  it("prihvata string i Prisma.Decimal ulaz", () => {
    const r = grossToNet(new Prisma.Decimal("1200"), "20");
    expect(money(r.net)).toBe("1000.00");
    expect(money(r.vat)).toBe("200.00");
  });
});

describe("vat-bridge netToGross", () => {
  it("20% — 1000 → 1200.00 / 200.00 (čist slučaj)", () => {
    const r = netToGross(1000, 20);
    expect(money(r.gross)).toBe("1200.00");
    expect(money(r.vat)).toBe("200.00");
  });

  it("20% — 833.33 → 1000.00 / 166.67 (obrnuto od graničnog gross slučaja)", () => {
    const r = netToGross("833.33", 20);
    expect(money(r.gross)).toBe("1000.00");
    expect(money(r.vat)).toBe("166.67");
    // Invarijanta: neto + PDV === bruto
    expect(money(r.gross.sub(r.vat))).toBe("833.33");
  });

  it("10% — 1000 → 1100.00 / 100.00", () => {
    const r = netToGross(1000, 10);
    expect(money(r.gross)).toBe("1100.00");
    expect(money(r.vat)).toBe("100.00");
  });

  it("0% — 1000 → 1000.00 / 0.00", () => {
    const r = netToGross(1000, 0);
    expect(money(r.gross)).toBe("1000.00");
    expect(money(r.vat)).toBe("0.00");
  });
});

describe("vat-bridge round-trip", () => {
  it("grossToNet pa netToGross vraća isti bruto (20%, granični)", () => {
    const a = grossToNet(1000, 20); // net 833.33, vat 166.67
    const b = netToGross(a.net, 20); // gross 1000.00
    expect(money(b.gross)).toBe("1000.00");
    expect(money(b.vat)).toBe(money(a.vat));
  });
});

describe("vat-bridge validacija", () => {
  it("negativna stopa baca VatBridgeError", () => {
    expect(() => grossToNet(1200, -5)).toThrow(VatBridgeError);
    expect(() => netToGross(1000, -5)).toThrow(VatBridgeError);
  });

  it("nevalidan iznos baca VatBridgeError", () => {
    expect(() => grossToNet("abc", 20)).toThrow(VatBridgeError);
    expect(() => netToGross("x", 20)).toThrow(VatBridgeError);
  });
});

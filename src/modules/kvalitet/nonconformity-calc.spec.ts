import { computeScrapHours, computeMaterialKg } from "./nonconformity-calc";
import type { ScrapHoursOp } from "./nonconformity-calc";

describe("computeScrapHours", () => {
  const ops: ScrapHoursOp[] = [
    { operationNumber: 10, setupTime: 1, cycleTime: 0.5 },
    { operationNumber: 20, setupTime: 2, cycleTime: 0.25 },
    { operationNumber: 30, setupTime: 4, cycleTime: 1 },
  ];

  it("granica UKLJUČIVA: op == scrap ulazi u zbir", () => {
    // qty=3, do op 20 (uključivo): (1 + 0.5*3) + (2 + 0.25*3) = 2.5 + 2.75 = 5.25
    expect(computeScrapHours(ops, 20, 3)).toBe(5.25);
  });

  it("op iznad opsega se NE računa", () => {
    // do op 10: 1 + 0.5*3 = 2.5 (op 20 i 30 izostaju)
    expect(computeScrapHours(ops, 10, 3)).toBe(2.5);
  });

  it("Tpz se broji JEDNOM po operaciji (ne × količina)", () => {
    // qty=10, samo op 10: 1 (Tpz jednom) + 0.5*10 = 6, NE 1*10 + 0.5*10
    expect(computeScrapHours(ops, 10, 10)).toBe(6);
  });

  it("Tk se množi količinom", () => {
    const one: ScrapHoursOp[] = [
      { operationNumber: 5, setupTime: 0, cycleTime: 2 },
    ];
    expect(computeScrapHours(one, 5, 4)).toBe(8);
  });

  it("prazan routing → null", () => {
    expect(computeScrapHours([], 20, 3)).toBeNull();
  });

  it("nijedna operacija u opsegu (sve iznad) → null", () => {
    expect(computeScrapHours(ops, 5, 3)).toBeNull();
  });

  it("null/negativna vremena tretiraju se kao 0", () => {
    const weird: ScrapHoursOp[] = [
      { operationNumber: 10, setupTime: null, cycleTime: null },
      { operationNumber: 20, setupTime: -5, cycleTime: -1 },
    ];
    // sve → 0; ali OPERACIJE POSTOJE u opsegu → zbir 0 (ne null)
    expect(computeScrapHours(weird, 20, 3)).toBe(0);
  });

  it("mešano: negativan Tpz uz validan Tk", () => {
    const mixed: ScrapHoursOp[] = [
      { operationNumber: 10, setupTime: -1, cycleTime: 2 },
    ];
    // Tpz(-1)→0, Tk 2*3 = 6
    expect(computeScrapHours(mixed, 10, 3)).toBe(6);
  });

  it("zaokružuje na 3 decimale", () => {
    const frac: ScrapHoursOp[] = [
      { operationNumber: 1, setupTime: 0, cycleTime: 0.3333 },
    ];
    // 0.3333 * 3 = 0.9999 → 3 decimale
    expect(computeScrapHours(frac, 1, 3)).toBe(1);
    expect(computeScrapHours(frac, 1, 1)).toBe(0.333);
  });
});

describe("computeMaterialKg", () => {
  it("qty × masa", () => {
    expect(computeMaterialKg(5, 2.5)).toBe(12.5);
  });

  it("masa 0 (prazan XML) → null", () => {
    expect(computeMaterialKg(5, 0)).toBeNull();
  });

  it("masa -1 (nenumerički XML) → null", () => {
    expect(computeMaterialKg(5, -1)).toBeNull();
  });

  it("masa null → null", () => {
    expect(computeMaterialKg(5, null)).toBeNull();
    expect(computeMaterialKg(5, undefined)).toBeNull();
  });

  it("zaokružuje na 3 decimale", () => {
    expect(computeMaterialKg(3, 0.3333)).toBe(1);
    expect(computeMaterialKg(1, 0.12345)).toBe(0.123);
  });
});

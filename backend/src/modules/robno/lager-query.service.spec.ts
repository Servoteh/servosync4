import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { LagerQueryService } from "./lager-query.service";
import { makeCostingDouble } from "../../../test/fixtures/costing-double";

/**
 * Kartica artikla (`LagerQueryService.getItemCard`) — čista logika running stanja bez baze:
 * `$queryRaw` vraća fiksni set kretanja, `costing.stateAsOf` je nezavisni kontrolni izvor.
 * Verifikuje smoke §2 („krajnje stanje == stateAsOf danas") + početno stanje pre `from`.
 *
 * Testovi su 04.08.2026. preseljeni iz `robno.service.spec.ts` zajedno sa metodom: čitanje
 * izveštaja je izdvojeno iz `RobnoService` (koji je od tada samo upis pod transakcijom).
 */

const D = (v: string | number) => new Prisma.Decimal(v);

describe("LagerQueryService.getItemCard (kartica artikla)", () => {
  /**
   * Kretanja (artikal 1, magacin 5): +100 (UL), −30 (IZ), +10 (UL) → running 100, 70, 80.
   *
   * Redovi su oblika pogleda `v_stock_movements`, uključujući `signed_quantity` (±Kol,
   * `CASE WHEN is_inbound THEN quantity ELSE -quantity END` — v. migraciju
   * `20260804100000_v_stock_movements`). Kartica sabira BAŠ `signed_quantity`, ne izvodi
   * znak ponovo iz `is_inbound`; fiksture koje nose samo `quantity` bi je hranile
   * `undefined`-om i merile nešto što produkcija nikad ne vidi.
   */
  const movements = [
    {
      item_line_id: 11,
      document_id: 1,
      document_number: "0001/2026",
      kind: "UL",
      document_type_code: "UFROB",
      document_date: new Date("2026-06-01T00:00:00.000Z"),
      quantity: D(100),
      signed_quantity: D(100),
      is_inbound: true,
    },
    {
      item_line_id: 22,
      document_id: 2,
      document_number: "0002/2026",
      kind: "IZ",
      document_type_code: "IFR",
      document_date: new Date("2026-07-10T00:00:00.000Z"),
      quantity: D(30),
      signed_quantity: D(-30),
      is_inbound: false,
    },
    {
      item_line_id: 33,
      document_id: 3,
      document_number: "0003/2026",
      kind: "UL",
      document_type_code: "UFROB",
      document_date: new Date("2026-07-20T00:00:00.000Z"),
      quantity: D(10),
      signed_quantity: D(10),
      is_inbound: true,
    },
  ];

  /** LagerQueryService sa mock prisma ($queryRaw + item.findUnique) i costing dublerom. */
  function makeCardService(stateAsOf: Prisma.Decimal) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(movements),
      item: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          name: "Artikal A",
          catalogNumber: "A-001",
          unit: "kom",
        }),
      },
    };
    // Isti deljeni dubler kao u ostalim spec-ovima: kartica zove `stateAsOf`, ali obe
    // metode izlaze iz istog izvora, pa ne mogu da se raziđu ako kartica ikad pređe
    // na grupni upit.
    const costing = makeCostingDouble(() => stateAsOf);
    const service = new LagerQueryService(prisma as never, costing as never);
    return { service, prisma, costing };
  }

  it("running stanje se slaže i krajnje stanje == stateAsOf (smoke §2)", async () => {
    const { service } = makeCardService(D(80));
    const { data } = await service.getItemCard({ itemId: 1, warehouseId: 5 });

    expect(data.lines.map((l) => l.balance)).toEqual([
      "100.000000",
      "70.000000",
      "80.000000",
    ]);
    expect(data.lines[0]).toMatchObject({
      direction: "IN",
      in: "100.000000",
      out: "0.000000",
    });
    expect(data.lines[1]).toMatchObject({
      direction: "OUT",
      in: "0.000000",
      out: "30.000000",
    });
    // Krajnje stanje (running) == nezavisno izračunat stateAsOf (costing).
    expect(data.closingBalance).toBe("80.000000");
    expect(data.stateAsOf).toBe("80.000000");
    expect(data.closingBalance).toBe(data.stateAsOf);
    expect(data.openingBalance).toBe("0.000000");
    expect(data.totalIn).toBe("110.000000");
    expect(data.totalOut).toBe("30.000000");
  });

  it("početno stanje pre `from` isključuje ranije redove iz prikaza", async () => {
    const { service } = makeCardService(D(80));
    // from = 2026-07-01 → prvi red (01.06, +100) je pre; ide u openingBalance, ne u lines.
    const { data } = await service.getItemCard({
      itemId: 1,
      warehouseId: 5,
      from: "2026-07-01",
    });

    expect(data.openingBalance).toBe("100.000000");
    expect(data.lines).toHaveLength(2);
    expect(data.lines.map((l) => l.balance)).toEqual([
      "70.000000",
      "80.000000",
    ]);
    // Krajnje stanje ostaje puno stanje (from seče samo prikaz, ne obračun) == stateAsOf.
    expect(data.closingBalance).toBe("80.000000");
    expect(data.stateAsOf).toBe("80.000000");
  });

  it("odbija nevalidan itemId/warehouseId (422)", async () => {
    const { service } = makeCardService(D(0));
    await expect(
      service.getItemCard({ itemId: 0, warehouseId: 5 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      service.getItemCard({ itemId: 1, warehouseId: -1 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

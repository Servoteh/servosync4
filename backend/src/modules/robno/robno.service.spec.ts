import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { RobnoService, type StockDocumentKind } from "./robno.service";
import type { CreateStockDocumentDto } from "./dto/create-stock-document.dto";

/**
 * Guard negativnog stanja (C11) — čista logika `assertSufficientStock` bez baze.
 * CostingService.stateAsOf i tx.item.findMany su mockovani (izvodljivo bez teškog mock-a).
 */

const D = (v: string | number) => new Prisma.Decimal(v);
const DATE = new Date("2026-07-23T00:00:00.000Z");

/** RobnoService sa mockovanim costing-om; stanje po ključu `itemId:warehouseId`. */
function makeService(stateByKey: Record<string, Prisma.Decimal>) {
  const costing = {
    stateAsOf: jest.fn(
      (itemId: number, warehouseId: number): Promise<Prisma.Decimal> =>
        Promise.resolve(stateByKey[`${itemId}:${warehouseId}`] ?? D(0)),
    ),
  };
  const service = new RobnoService(
    {} as never,
    {} as never,
    costing as never,
  );
  return { service, costing };
}

/** Minimalni tx sa item.findMany (nazivi artikala za poruku). */
const fakeTx = {
  item: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, name: "Artikal A", catalogNumber: "A-001" },
      { id: 2, name: "Artikal B", catalogNumber: "B-002" },
    ]),
  },
} as never;

function callGuard(
  service: RobnoService,
  kind: StockDocumentKind,
  dto: CreateStockDocumentDto,
): Promise<void> {
  return (
    service as unknown as {
      assertSufficientStock: (
        tx: unknown,
        kind: StockDocumentKind,
        dto: CreateStockDocumentDto,
        date: Date,
      ) => Promise<void>;
    }
  ).assertSufficientStock(fakeTx, kind, dto, DATE);
}

describe("RobnoService.assertSufficientStock (C11)", () => {
  it("propušta IZ kad je stanje dovoljno", async () => {
    const { service, costing } = makeService({ "1:5": D(100) });
    const dto: CreateStockDocumentDto = {
      documentTypeCode: "IFR",
      warehouseId: 5,
      items: [{ itemId: 1, quantity: 30 }],
    };
    await expect(callGuard(service, "IZ", dto)).resolves.toBeUndefined();
    expect(costing.stateAsOf).toHaveBeenCalledWith(1, 5, DATE, { tx: fakeTx });
  });

  it("odbija IZ kad je traženo > raspoloživo (422 + STOCK_INSUFFICIENT)", async () => {
    const { service } = makeService({ "1:5": D(10) });
    const dto: CreateStockDocumentDto = {
      documentTypeCode: "IFR",
      warehouseId: 5,
      items: [{ itemId: 1, quantity: 30 }],
    };
    expect.assertions(4);
    try {
      await callGuard(service, "IZ", dto);
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      const res = (e as UnprocessableEntityException).getResponse() as {
        code: string;
        shortages: Array<{ itemId: number; requested: string; available: string }>;
      };
      expect(res.code).toBe("STOCK_INSUFFICIENT");
      expect(res.shortages).toHaveLength(1);
      expect(res.shortages[0]).toMatchObject({
        itemId: 1,
        requested: "30.000",
        available: "10.000",
      });
    }
  });

  it("agregira više stavki istog artikla/magacina pre poređenja", async () => {
    const { service } = makeService({ "1:5": D(40) });
    const dto: CreateStockDocumentDto = {
      documentTypeCode: "IFR",
      warehouseId: 5,
      items: [
        { itemId: 1, quantity: 30 },
        { itemId: 1, quantity: 20 }, // 30+20=50 > 40 → manjak
      ],
    };
    await expect(callGuard(service, "IZ", dto)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it("primenjuje guard i na MANJAK", async () => {
    const { service, costing } = makeService({ "2:5": D(1) });
    const dto: CreateStockDocumentDto = {
      documentTypeCode: "MANJR",
      warehouseId: 5,
      items: [{ itemId: 2, quantity: 5 }],
    };
    await expect(callGuard(service, "MANJAK", dto)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(costing.stateAsOf).toHaveBeenCalled();
  });

  it("ne dira stanje za ULAZ (UL) — guard se preskače", async () => {
    const { service, costing } = makeService({});
    const dto: CreateStockDocumentDto = {
      documentTypeCode: "UFROB",
      warehouseId: 5,
      items: [{ itemId: 1, quantity: 999 }],
    };
    await expect(callGuard(service, "UL", dto)).resolves.toBeUndefined();
    expect(costing.stateAsOf).not.toHaveBeenCalled();
  });

  it("koristi warehouseId stavke kad je zadat (fallback na header)", async () => {
    const { service, costing } = makeService({ "1:7": D(100) });
    const dto: CreateStockDocumentDto = {
      documentTypeCode: "IFR",
      warehouseId: 5,
      items: [{ itemId: 1, quantity: 10, warehouseId: 7 }],
    };
    await expect(callGuard(service, "IZ", dto)).resolves.toBeUndefined();
    expect(costing.stateAsOf).toHaveBeenCalledWith(1, 7, DATE, { tx: fakeTx });
  });
});

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

/**
 * R3 (review 25.07): guard je od stvarnog stanja oduzimao otvorene rezervacije i za MANJAK,
 * pa se popis nije mogao zaključiti kad je preostala roba rezervisana (stanje 10, rezervisano
 * 10, brojanje nađe 8 → MANJAK 2 vs raspoloživo 0 → 422). MANJAK NIJE obećanje kupcu.
 */
describe("RobnoService.loadOpenReserved (R3 — popis se mora zaključiti)", () => {
  /** tx dvojnik koji beleži da li je agregat rezervacija uopšte tražen. */
  function makeTx(sum: Prisma.Decimal) {
    return {
      groupBy: jest.fn().mockResolvedValue([
        { itemId: 2, warehouseId: 5, _sum: { quantity: sum } },
      ]),
    };
  }

  function callLoad(
    service: RobnoService,
    tx: unknown,
    kind: StockDocumentKind,
    dto: CreateStockDocumentDto,
    source?: { sourceType: "invoice"; sourceId: number }[],
  ): Promise<Map<string, Prisma.Decimal>> {
    return (
      service as unknown as {
        loadOpenReserved: (
          tx: unknown,
          kind: StockDocumentKind,
          dto: CreateStockDocumentDto,
          source?: unknown,
        ) => Promise<Map<string, Prisma.Decimal>>;
      }
    ).loadOpenReserved(tx, kind, dto, source);
  }

  const dto: CreateStockDocumentDto = {
    documentTypeCode: "MANJR",
    warehouseId: 5,
    items: [{ itemId: 2, quantity: 2 }],
  };

  it("MANJAK ne oduzima rezervacije (agregat se i ne traži)", async () => {
    const { service } = makeService({});
    const groupBy = makeTx(D(10));
    const reserved = await callLoad(
      service,
      { stockReservation: groupBy },
      "MANJAK",
      dto,
    );
    expect(reserved.size).toBe(0);
    expect(groupBy.groupBy).not.toHaveBeenCalled();
  });

  it("IZ i dalje oduzima rezervacije, uz izuzimanje SVIH svojih izvora (R1)", async () => {
    const { service } = makeService({});
    const groupBy = makeTx(D(10));
    const reserved = await callLoad(
      service,
      { stockReservation: groupBy },
      "IZ",
      { ...dto, documentTypeCode: "IFR" },
      [
        { sourceType: "invoice", sourceId: 200 },
        { sourceType: "invoice", sourceId: 100 },
      ],
    );
    expect(reserved.get("2:5")?.toString()).toBe("10");
    const args = groupBy.groupBy.mock.calls[0][0] as {
      where: { AND?: Array<{ NOT: { sourceId: number } }> };
    };
    expect(args.where.AND?.map((c) => c.NOT.sourceId)).toEqual([200, 100]);
  });

  it("MANJAK i dalje pada na golom stanju (popis ne otpisuje više nego što knjigovodstveno postoji)", async () => {
    const { service } = makeService({ "2:5": D(1) });
    await expect(callGuard(service, "MANJAK", dto)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});

/**
 * Kartica artikla (getItemCard) — čista logika running stanja bez baze: `$queryRaw` vraća
 * fiksni set kretanja, `costing.stateAsOf` je nezavisni kontrolni izvor. Verifikuje smoke §2
 * („krajnje stanje == stateAsOf danas") + početno stanje pre `from`.
 */
describe("RobnoService.getItemCard (kartica artikla)", () => {
  /** Kretanja (artikal 1, magacin 5): +100 (UL), −30 (IZ), +10 (UL) → running 100, 70, 80. */
  const movements = [
    {
      item_line_id: 11,
      document_id: 1,
      document_number: "0001/2026",
      kind: "UL",
      document_type_code: "UFROB",
      document_date: new Date("2026-06-01T00:00:00.000Z"),
      quantity: D(100),
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
      is_inbound: true,
    },
  ];

  /** RobnoService sa mock prisma ($queryRaw + item.findUnique) i costing.stateAsOf. */
  function makeCardService(stateAsOf: Prisma.Decimal) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(movements),
      item: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 1, name: "Artikal A", catalogNumber: "A-001", unit: "kom" }),
      },
    };
    const costing = { stateAsOf: jest.fn().mockResolvedValue(stateAsOf) };
    const service = new RobnoService(
      prisma as never,
      {} as never,
      costing as never,
    );
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
    expect(data.lines[0]).toMatchObject({ direction: "IN", in: "100.000000", out: "0.000000" });
    expect(data.lines[1]).toMatchObject({ direction: "OUT", in: "0.000000", out: "30.000000" });
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
    expect(data.lines.map((l) => l.balance)).toEqual(["70.000000", "80.000000"]);
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

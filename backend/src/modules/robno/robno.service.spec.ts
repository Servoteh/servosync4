import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { RobnoService, type StockDocumentKind } from "./robno.service";
import type { CreateStockDocumentDto } from "./dto/create-stock-document.dto";
import {
  makeCostingDouble,
  makeCostingDoubleFromTable,
} from "../../../test/fixtures/costing-double";

/**
 * Guard negativnog stanja (C11) — čista logika `assertSufficientStock` bez baze.
 * CostingService i tx.item.findMany su mockovani (izvodljivo bez teškog mock-a).
 *
 * Dubler costing-a implementira OBE metode (`stateAsOf` + `stateAsOfMany`) iz istog izvora
 * stanja — guard od 04.08.2026. čita `stateAsOfMany` (jedan upit za sve parove umesto petlje
 * unutar transakcije koja drži advisory lock), a kartica artikla i dalje `stateAsOf`.
 */

const D = (v: string | number) => new Prisma.Decimal(v);
const DATE = new Date("2026-07-23T00:00:00.000Z");

/** RobnoService sa mockovanim costing-om; stanje po ključu `itemId:warehouseId`. */
function makeService(stateByKey: Record<string, Prisma.Decimal>) {
  const costing = makeCostingDoubleFromTable(stateByKey);
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
    expect(costing.stateAsOfMany).toHaveBeenCalledWith(
      [{ itemId: 1, warehouseId: 5 }],
      DATE,
      { tx: fakeTx, excludeDocId: undefined },
    );
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
    expect(costing.stateAsOfMany).toHaveBeenCalledWith(
      [{ itemId: 2, warehouseId: 5 }],
      DATE,
      { tx: fakeTx, excludeDocId: undefined },
    );
  });

  it("ne dira stanje za ULAZ (UL) — guard se preskače", async () => {
    const { service, costing } = makeService({});
    const dto: CreateStockDocumentDto = {
      documentTypeCode: "UFROB",
      warehouseId: 5,
      items: [{ itemId: 1, quantity: 999 }],
    };
    await expect(callGuard(service, "UL", dto)).resolves.toBeUndefined();
    // NIJEDAN ulaz u costing — ni pojedinačni ni grupni (inače bi test prestao da hvata
    // ono zbog čega postoji čim guard promeni metodu).
    expect(costing.stateAsOf).not.toHaveBeenCalled();
    expect(costing.stateAsOfMany).not.toHaveBeenCalled();
  });

  it("koristi warehouseId stavke kad je zadat (fallback na header)", async () => {
    const { service, costing } = makeService({ "1:7": D(100) });
    const dto: CreateStockDocumentDto = {
      documentTypeCode: "IFR",
      warehouseId: 5,
      items: [{ itemId: 1, quantity: 10, warehouseId: 7 }],
    };
    await expect(callGuard(service, "IZ", dto)).resolves.toBeUndefined();
    expect(costing.stateAsOfMany).toHaveBeenCalledWith(
      [{ itemId: 1, warehouseId: 7 }],
      DATE,
      { tx: fakeTx, excludeDocId: undefined },
    );
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

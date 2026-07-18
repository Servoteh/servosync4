import { Prisma } from "@prisma/client";
import { PartLocationsService } from "./part-locations.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Unit — PartLocationsService.list() pretraga (PL-01 regresija).
 *
 * BLOCKER koji se ovde brani: za širok `q` (npr. "a") stara implementacija je
 * sakupljala OGROMNE nizove work_order/project/position id-jeva i prosleđivala
 * ih kao `{ in: [...] }` bind-parametre → PG bind-limit (65535) overflow → 500.
 *
 * Kanon posle fix-a: pretraga ostaje U SQL-u (EXISTS podupiti sa ILIKE); iz
 * baze izlaze SAMO id-jevi tekuće stranice (≤ pageSize), koji se hidriraju kroz
 * Prisma. Nijedan veliki id-niz ne sme napustiti bazu.
 */
describe("PartLocationsService.list — PL-01 (širok q ne pravi bind-overflow)", () => {
  let queryRaw: jest.Mock;
  let findMany: jest.Mock;
  let $transaction: jest.Mock;
  let prisma: PrismaService;
  let service: PartLocationsService;

  beforeEach(() => {
    queryRaw = jest.fn();
    findMany = jest.fn().mockResolvedValue([]);

    // $transaction([p1, p2]) — u list() prosleđujemo niz Promise-a
    // ($queryRaw za id-jeve + $queryRaw za count); vrati njihove razrešene vrednosti.
    $transaction = jest.fn((arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      throw new Error("neočekivan oblik $transaction");
    });

    prisma = {
      $queryRaw: queryRaw,
      $transaction,
      partLocation: { findMany },
      // resolveri u attachRelations — svi vraćaju prazno (nema redova za hidrat.)
      workOrder: { findMany: jest.fn().mockResolvedValue([]) },
      project: { findMany: jest.fn().mockResolvedValue([]) },
      position: { findMany: jest.fn().mockResolvedValue([]) },
      worker: { findMany: jest.fn().mockResolvedValue([]) },
      partQualityType: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    service = new PartLocationsService(prisma);
  });

  /** Skupi sve string-fragmente iz Prisma.Sql (i ugnježdenih join-ova). */
  function sqlText(sql: Prisma.Sql): string {
    return sql.strings.join(" ");
  }

  it("širok q ('a') filtrira kroz EXISTS/ILIKE — bez velikih IN nizova, id-jevi ostaju u SQL-u", async () => {
    // Simuliraj DB: 3 id-ja na stranici + total 40000 (kao da q='a' pogađa masu redova).
    queryRaw
      .mockResolvedValueOnce([{ id: 101 }, { id: 102 }, { id: 103 }]) // id stranica
      .mockResolvedValueOnce([{ total: 40000n }]); // count

    const res = await service.list({ q: "a", page: "1", pageSize: "50" });

    // 1) tačno dva raw upita (id-stranica + count), oba sa Prisma.Sql payload-om.
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const idSql = queryRaw.mock.calls[0][0] as Prisma.Sql;
    const countSql = queryRaw.mock.calls[1][0] as Prisma.Sql;
    // Prisma.Sql je tip (ne runtime konstruktor u ovoj verziji) — proveri oblik.
    expect(Array.isArray(idSql.strings)).toBe(true);
    expect(Array.isArray(idSql.values)).toBe(true);
    expect(Array.isArray(countSql.values)).toBe(true);

    // 2) pretraga je U SQL-u: EXISTS + ILIKE nad sva tri izvora.
    const idText = sqlText(idSql);
    expect(idText).toContain("EXISTS");
    expect(idText.toUpperCase()).toContain("ILIKE");
    expect(idText).toContain("work_orders");
    expect(idText).toContain("projects");
    expect(idText).toContain("positions");

    // 3) NIJEDAN bind-parametar nije veliki niz id-jeva (koren PL-01 500).
    //    Dozvoljeni bindovi: like-string(i) + LIMIT/OFFSET. Nikad Array.
    for (const v of idSql.values) {
      expect(Array.isArray(v)).toBe(false);
    }
    // like param mora biti prisutan sa % omotačem.
    expect(idSql.values).toContain("%a%");

    // 4) hidracija kroz Prisma nosi SAMO id-jeve stranice (≤ pageSize).
    expect(findMany).toHaveBeenCalledTimes(1);
    const hydrateArg = findMany.mock.calls[0][0];
    expect(hydrateArg.where).toEqual({ id: { in: [101, 102, 103] } });
    expect(hydrateArg.where.id.in.length).toBeLessThanOrEqual(50);

    // 5) meta.total dolazi iz count upita (bigint → Number).
    expect(res.meta.pagination.total).toBe(40000);
  });

  it("prazna stranica (0 id-jeva) ne zove Prisma findMany za hidrataciju", async () => {
    queryRaw
      .mockResolvedValueOnce([]) // nema id-jeva
      .mockResolvedValueOnce([{ total: 0n }]);

    const res = await service.list({ q: "zzz-nepostoji", pageSize: "50" });

    expect(findMany).not.toHaveBeenCalled();
    expect(res.data).toEqual([]);
    expect(res.meta.pagination.total).toBe(0);
  });

  it("egzaktni filteri se dodaju kao skalarni bindovi, i dalje bez nizova", async () => {
    queryRaw
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([{ total: 1n }]);

    await service.list({ workOrderId: "555", positionId: "9" });

    const idSql = queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(idSql.values).toContain(555);
    expect(idSql.values).toContain(9);
    for (const v of idSql.values) {
      expect(Array.isArray(v)).toBe(false);
    }
  });
});

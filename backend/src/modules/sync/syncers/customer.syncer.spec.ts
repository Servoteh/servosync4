import "reflect-metadata";
import { Logger } from "@nestjs/common";

import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import { NATIVE_ID_BASE } from "../table-ownership";
import { CustomerSyncer } from "./customer.syncer";

/**
 * ZAŠTITA 4.0-NATIVE KOMITENTA (adversarni pregled 28.07.2026, nalaz [1]).
 *
 * `CustomerSyncer` upsert-uje po `id` i u `update` šalje SVIH 56 mapiranih
 * kolona. `customers.id` I JESTE BigBit `Sifra`, pa bi sudar ključeva prepisao
 * 4.0-native komitenta tuđom firmom — bez greške, bez traga, bez ijednog reda u
 * logu. Ovaj spec pinuje da se takav red PRESKAČE i da se to VIDI u rezultatu
 * prolaza (`rowsSkipped` + `note`, jer `errors` ne stižu u `bb_sync_log`).
 */
describe("CustomerSyncer — 4.0-native red se ne prepisuje", () => {
  /** Minimalan `Komitenti` red — mapRow čita mnogo kolona, ali null je legalan. */
  function sourceRow(sifra: number, naziv: string): Record<string, unknown> {
    return {
      Sifra: sifra,
      Naziv: naziv,
      PIB: "100000000",
      PoslednjaIzmena: new Date("2026-07-28T10:00:00.000Z"),
    };
  }

  function setup(
    rows: Record<string, unknown>[],
    nativeCustomerIds: number[] = [],
  ) {
    const upsert = jest.fn().mockResolvedValue({});
    const customerFindMany = jest
      .fn()
      .mockResolvedValue(nativeCustomerIds.map((id) => ({ id })));

    const prisma = {
      salesperson: { findMany: jest.fn().mockResolvedValue([]) },
      codeType: { findMany: jest.fn().mockResolvedValue([]) },
      customer: { findMany: customerFindMany, upsert },
    } as unknown as PrismaService;

    const mssql = {
      query: jest.fn().mockResolvedValue(rows),
    } as unknown as MssqlClient;

    return {
      syncer: new CustomerSyncer(mssql, prisma),
      upsert,
      customerFindMany,
      mssql,
    };
  }

  /** Šifre koje su stvarno završile u `upsert`. */
  function upsertedIds(upsert: jest.Mock): number[] {
    const calls = upsert.mock.calls as unknown as [{ where: { id: number } }][];
    return calls.map((c) => c[0].where.id);
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("izvorni red sa šifrom iz rezervisanog opsega se PRESKAČE (nema upsert-a)", async () => {
    const { syncer, upsert } = setup([
      sourceRow(1_006_068, "Legitiman BigBit komitent"),
      sourceRow(NATIVE_ID_BASE + 7, "Šifra iz 4.0 opsega"),
    ]);

    const result = await syncer.sync({
      strategy: "full_refresh",
      cursor: null,
    });

    expect(upsertedIds(upsert)).toEqual([1_006_068]);
    expect(result.rowsUpserted).toBe(1);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain("rezervisanom 4.0 opsegu");
    // `note` je JEDINI kanal koji stiže u `bb_sync_log.metadata`.
    expect(result.note).toContain("PRESKOČENO");
    expect(result.note).toContain(String(NATIVE_ID_BASE));
  });

  it("marker porekla iz šeme (source='NATIVE') štiti red i kad je id u BigBit prostoru", async () => {
    // Rezerva za slučaj da `chk_customers_native_id_range` ikad padne ili da red
    // uđe zaobilazno: poreklo se čita iz kolone, ne samo iz opsega ključeva.
    const { syncer, upsert, customerFindMany } = setup(
      [sourceRow(4242, "BigBit firma koja bi prepisala 4.0 red")],
      [4242],
    );

    const result = await syncer.sync({ strategy: "incremental", cursor: null });

    expect(customerFindMany).toHaveBeenCalledWith({
      where: { source: "NATIVE" },
      select: { id: true },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain("source='NATIVE'");
    expect(result.note).toContain("4.0-native komitentima");
  });

  it("običan BigBit red se normalno osvežava (zaštita ne koči redovan tok)", async () => {
    const { syncer, upsert } = setup([
      sourceRow(1, "Servoteh d.o.o."),
      sourceRow(1_006_067, "Poslednja BigBit šifra"),
    ]);

    const result = await syncer.sync({ strategy: "incremental", cursor: null });

    expect(upsertedIds(upsert)).toEqual([1, 1_006_067]);
    expect(result.rowsSkipped).toBe(0);
    expect(result.note).toBeUndefined();
  });

  it("preskočen red NE pomera kursor sam za sebe (anomalija se prijavi ponovo)", async () => {
    const { syncer } = setup([
      {
        ...sourceRow(NATIVE_ID_BASE + 1, "4.0 opseg"),
        PoslednjaIzmena: new Date("2026-07-28T23:00:00.000Z"),
      },
    ]);

    const before = new Date("2026-07-01T00:00:00.000Z").toISOString();
    const result = await syncer.sync({
      strategy: "incremental",
      cursor: { lastModifiedAt: before },
    });

    // Kursor ostaje na zatečenoj vrednosti — preskočeni red ga ne odnosi sa sobom.
    expect(result.newCursor?.lastModifiedAt).toBe(before);
  });

  it("id = 0 (Servoteh d.o.o., sentinel) NIJE native — falsy vrednost ne sme da zbuni", async () => {
    // Zamka iz izveštaja o šemi: `customers.id = 0` je Servoteh, `bbSifra = 0`.
    const { syncer, upsert } = setup([sourceRow(0, "Servoteh d.o.o.")]);
    const result = await syncer.sync({ strategy: "incremental", cursor: null });
    expect(upsertedIds(upsert)).toEqual([0]);
    expect(result.rowsSkipped).toBe(0);
  });
});

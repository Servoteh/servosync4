import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import { ItemGroupSyncer } from "./item-group.syncer";
import { ItemOriginSyncer } from "./item-origin.syncer";
import { ItemSubgroupSyncer } from "./item-subgroup.syncer";

/**
 * Registri artikala: R_Grupa / R_Podgrupa / R_Poreklo -> item_groups /
 * item_subgroups / item_origins.
 *
 * Nemaju watermark kolonu, pa je jedina strategija full refresh — ali kroz
 * upsert po šifri, bez brisanja (artikli nose ove šifre kao obične stringove).
 */
type Row = Record<string, unknown>;

function setup(rows: Row[], failOn?: (data: Row) => boolean) {
  const upsert = jest.fn().mockImplementation(({ create }: { create: Row }) => {
    if (failOn?.(create)) return Promise.reject(new Error("boom"));
    return Promise.resolve(create);
  });
  const prisma = {
    itemGroup: { upsert },
    itemSubgroup: { upsert },
    itemOrigin: { upsert },
  } as unknown as PrismaService;
  const mssql = {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as MssqlClient;
  return { prisma, mssql, upsert };
}

interface UpsertArgs {
  where: { code: string };
  create: Row;
  update: Row;
}

/** Argumenti svakog `upsert` poziva, tipizirano (mock.calls je `any[]`). */
function upsertCalls(upsert: jest.Mock): UpsertArgs[] {
  return (upsert.mock.calls as [UpsertArgs][]).map((c) => c[0]);
}

/** Vrednosti prosleđene u `create` (create i update su isti objekat). */
function created(upsert: jest.Mock): Row[] {
  return upsertCalls(upsert).map((c) => c.create);
}

/** SQL prvog (i jedinog) poziva ka MSSQL-u. */
function queriedSql(mssql: MssqlClient): string {
  const calls = (mssql.query as jest.Mock).mock.calls as [string][];
  return calls[0][0];
}

describe("ItemGroupSyncer (R_Grupa -> item_groups)", () => {
  it("mapira Grupa -> code, Opis -> description", async () => {
    const { prisma, mssql, upsert } = setup([
      { Grupa: "AL", Opis: "Aluminijum" },
      { Grupa: "FE", Opis: "Crni metali" },
    ]);
    const syncer = new ItemGroupSyncer(mssql, prisma);
    const result = await syncer.sync({
      strategy: "full_refresh",
      cursor: null,
    });

    expect(created(upsert)).toEqual([
      { code: "AL", description: "Aluminijum" },
      { code: "FE", description: "Crni metali" },
    ]);
    expect(upsertCalls(upsert)[0].where).toEqual({ code: "AL" });
    expect(result).toMatchObject({
      entity: "item_groups",
      rowsFetched: 2,
      rowsUpserted: 2,
      rowsSkipped: 0,
      newCursor: { strategy: "full_refresh" },
    });
  });

  it("čita samo mapirane kolone, u [zagradama], uz ORDER BY po izvornom PK", async () => {
    const { prisma, mssql } = setup([]);
    await new ItemGroupSyncer(mssql, prisma).sync({
      strategy: "full_refresh",
      cursor: null,
    });
    const sql = queriedSql(mssql);
    expect(sql).toContain("SELECT [Grupa], [Opis] FROM [dbo].[R_Grupa]");
    expect(sql).toContain("ORDER BY [Grupa] ASC");
    // Bez watermarka nema ni WHERE — inkrementalni prolaz ne postoji.
    expect(sql).not.toContain("WHERE");
  });

  it("greška na jednom redu = skip + poruka, ostali redovi prolaze", async () => {
    const { prisma, mssql, upsert } = setup(
      [
        { Grupa: "AL", Opis: "Aluminijum" },
        { Grupa: "XX", Opis: "Loš red" },
        { Grupa: "FE", Opis: "Crni metali" },
      ],
      (d) => d.code === "XX",
    );
    const result = await new ItemGroupSyncer(mssql, prisma).sync({
      strategy: "full_refresh",
      cursor: null,
    });

    expect(upsert).toHaveBeenCalledTimes(3);
    expect(result.rowsUpserted).toBe(2);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors).toEqual(["Grupa=XX: boom"]);
  });

  it("prazna šifra u izvoru se PRESKAČE (ne pravi se red sa praznim code)", async () => {
    const { prisma, mssql, upsert } = setup([
      { Grupa: "  ", Opis: "Bez šifre" },
      { Grupa: "AL", Opis: "Aluminijum" },
    ]);
    const result = await new ItemGroupSyncer(mssql, prisma).sync({
      strategy: "full_refresh",
      cursor: null,
    });

    expect(created(upsert)).toEqual([
      { code: "AL", description: "Aluminijum" },
    ]);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain("empty [Grupa]");
  });

  it("podrazumevana strategija je full_refresh (nema PoslednjaIzmena kolone)", () => {
    const { prisma, mssql } = setup([]);
    expect(new ItemGroupSyncer(mssql, prisma).defaultStrategy).toBe(
      "full_refresh",
    );
  });

  // Ako neko ručno zatraži `incremental`, prolaz je i dalje pun — to mora da se
  // vidi u `bb_sync_log.metadata`, a ne da tiho izgleda kao inkrementalni sync.
  it("traženi incremental daje pun prolaz + napomenu u rezultatu", async () => {
    const { prisma, mssql } = setup([{ Grupa: "AL", Opis: "Aluminijum" }]);
    const result = await new ItemGroupSyncer(mssql, prisma).sync({
      strategy: "incremental",
      cursor: { lastModifiedAt: new Date().toISOString() },
    });

    expect(result.rowsUpserted).toBe(1);
    expect(result.newCursor).toEqual({ strategy: "full_refresh" });
    expect(result.note).toContain("PoslednjaIzmena");
  });
});

describe("ItemSubgroupSyncer (R_Podgrupa -> item_subgroups)", () => {
  it("mapira Podgrupa/Opis/GrupaVeza -> code/description/parentGroup", async () => {
    const { prisma, mssql, upsert } = setup([
      { Podgrupa: "AL-P", Opis: "Aluminijumski profili", GrupaVeza: "AL" },
    ]);
    const result = await new ItemSubgroupSyncer(mssql, prisma).sync({
      strategy: "full_refresh",
      cursor: null,
    });

    expect(created(upsert)).toEqual([
      {
        code: "AL-P",
        description: "Aluminijumski profili",
        parentGroup: "AL",
      },
    ]);
    expect(result.entity).toBe("item_subgroups");
  });

  // BigBit „nema roditelja" piše kao '0' (isto radi i CSV most u
  // tools/bigbit-bridge/sql/item_subgroups.sql) — NULL se ne prosleđuje dalje.
  it("prazan/NULL GrupaVeza postaje '0'", async () => {
    const { prisma, mssql, upsert } = setup([
      { Podgrupa: "A", Opis: "Bez grupe", GrupaVeza: null },
      { Podgrupa: "B", Opis: "Razmaci", GrupaVeza: "   " },
      { Podgrupa: "C", Opis: "Sa grupom", GrupaVeza: " FE " },
    ]);
    await new ItemSubgroupSyncer(mssql, prisma).sync({
      strategy: "full_refresh",
      cursor: null,
    });
    expect(created(upsert).map((d) => d.parentGroup)).toEqual(["0", "0", "FE"]);
  });
});

describe("ItemOriginSyncer (R_Poreklo -> item_origins)", () => {
  it("mapira Poreklo/Opis/PodgrupaVeza/PopustProc na sva četiri polja", async () => {
    const { prisma, mssql, upsert } = setup([
      {
        Poreklo: "UVOZ",
        Opis: "Uvozna roba",
        PodgrupaVeza: "AL-P",
        PopustProc: 12.5,
      },
    ]);
    const result = await new ItemOriginSyncer(mssql, prisma).sync({
      strategy: "full_refresh",
      cursor: null,
    });

    const [data] = created(upsert);
    expect(data).toMatchObject({
      code: "UVOZ",
      description: "Uvozna roba",
      subgroupCode: "AL-P",
    });
    expect(data.discountPercent).toBeInstanceOf(Prisma.Decimal);
    expect((data.discountPercent as Prisma.Decimal).toString()).toBe("12.5");
    expect(result).toMatchObject({
      entity: "item_origins",
      rowsFetched: 1,
      rowsUpserted: 1,
    });
  });

  it("NULL PopustProc postaje 0 (Decimal), NULL PodgrupaVeza postaje 0", async () => {
    const { prisma, mssql, upsert } = setup([
      {
        Poreklo: "D",
        Opis: "Domaća roba",
        PodgrupaVeza: null,
        PopustProc: null,
      },
    ]);
    await new ItemOriginSyncer(mssql, prisma).sync({
      strategy: "full_refresh",
      cursor: null,
    });

    const [data] = created(upsert);
    expect(data.subgroupCode).toBe("0");
    expect((data.discountPercent as Prisma.Decimal).toString()).toBe("0");
  });

  it("čita sve četiri izvorne kolone", async () => {
    const { prisma, mssql } = setup([]);
    await new ItemOriginSyncer(mssql, prisma).sync({
      strategy: "full_refresh",
      cursor: null,
    });
    expect(queriedSql(mssql)).toContain(
      "SELECT [Poreklo], [Opis], [PodgrupaVeza], [PopustProc] FROM [dbo].[R_Poreklo]",
    );
  });
});

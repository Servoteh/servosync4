import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import { EntitySyncer } from "../sync.types";
import { HandoverDerivationSyncer } from "./handover-derivation.syncer";

/**
 * Test mapiranja reda (BACKEND_RULES §4.5 obrazac) za derivacioni syncer
 * tRN -> drawing_handovers + remap post-korak. Bez baze — mock mssql + prisma.
 */

const D_UNOSA = new Date("2026-01-05T08:00:00Z"); // DatumUnosa
const D_CREATED = new Date("2026-01-05T08:01:00Z"); // DIVUnosaRN
const D_UPDATED = new Date("2026-02-01T10:00:00Z"); // DIVIspravkeRN
const D_SAGLASAN = new Date("2026-01-20T09:00:00Z"); // tSaglasanRN.DIVUnos
const D_LANSIRAN = new Date("2026-01-25T11:00:00Z"); // tLansiranRN.DIVUnos

/** Kompletan lansiran (status 3) tRN red sa oba OUTER APPLY pogotka. */
function launchedRow(overrides: Record<string, unknown> = {}) {
  return {
    IDRN: 101,
    IDCrtez: 10,
    IDPrimopredaje: 7,
    IDStatusPrimopredaje: 3,
    SifraRadnikaPrimopredaje: 8,
    SifraRadnika: 9,
    DatumUnosa: D_UNOSA,
    DIVUnosaRN: D_CREATED,
    DIVIspravkeRN: D_UPDATED,
    SaglasanAt: D_SAGLASAN,
    SaglasanBy: 12,
    LansiranAt: D_LANSIRAN,
    LansiranBy: 13,
    ...overrides,
  };
}

function buildMocks(rows: Record<string, unknown>[]) {
  const mssql = { query: jest.fn().mockResolvedValue(rows) };
  const prisma = {
    drawing: {
      findMany: jest.fn().mockResolvedValue([{ id: 10 }, { id: 11 }]),
    },
    drawingHandover: {
      // Derivirani id = nativni autoincrement — u testu deterministički 500+IDRN.
      upsert: jest
        .fn()
        .mockImplementation(({ where }: { where: { legacyRnId: number } }) =>
          Promise.resolve({ id: 500 + where.legacyRnId }),
        ),
      deleteMany: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  // Tipizovano kroz interfejs: sync() implementacija namerno ignoriše options
  // (uvek pun prolaz), a pozivalac (SyncService) ga zove kroz EntitySyncer.
  const syncer: EntitySyncer = new HandoverDerivationSyncer(
    mssql as unknown as MssqlClient,
    prisma as unknown as PrismaService,
  );
  return { mssql, prisma, syncer };
}

const containing = (obj: Record<string, unknown>): unknown =>
  expect.objectContaining(obj) as unknown;

describe("HandoverDerivationSyncer", () => {
  it("lansiran red (status 3): puno mapiranje, upsert po legacyRnId, isLocked", async () => {
    const { prisma, syncer } = buildMocks([launchedRow()]);

    const result = await syncer.sync({
      strategy: "full_refresh",
      cursor: null,
    });

    expect(result.rowsFetched).toBe(1);
    expect(result.rowsUpserted).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    expect(prisma.drawingHandover.upsert).toHaveBeenCalledWith({
      where: { legacyRnId: 101 },
      create: containing({
        legacyRnId: 101,
        drawingId: 10,
        statusId: 3,
        handoverWorkerId: 8,
        technologistId: 9, // status 3 -> SifraRadnika
        handoverDate: D_UNOSA,
        createdAt: D_CREATED,
        updatedAt: D_UPDATED,
        statusChangedAt: D_SAGLASAN,
        statusChangedById: 12,
        launchedAt: D_LANSIRAN,
        launchedById: 13,
        isLocked: true,
        note: null,
        signature: null,
        statusChangeComment: null,
      }),
      update: containing({ legacyRnId: 101, statusId: 3 }),
    });
    // Derivacija NIKAD ne briše (table-ownership štiti od generic full refresh-a).
    expect(prisma.drawingHandover.deleteMany).not.toHaveBeenCalled();
  });

  it("red na čekanju (status 0): tehnolog 0, bez statusChanged/launched, otključan", async () => {
    const { prisma, syncer } = buildMocks([
      launchedRow({
        IDRN: 102,
        IDStatusPrimopredaje: 0,
        SaglasanAt: null,
        SaglasanBy: null,
        LansiranAt: null,
        LansiranBy: null,
      }),
    ]);

    await syncer.sync({ strategy: "full_refresh", cursor: null });

    expect(prisma.drawingHandover.upsert).toHaveBeenCalledWith(
      containing({
        where: { legacyRnId: 102 },
        create: containing({
          statusId: 0,
          technologistId: 0, // status 0 -> SifraRadnika se NE koristi
          statusChangedAt: null,
          statusChangedById: null,
          launchedAt: null,
          launchedById: null,
          isLocked: false,
        }),
      }),
    );
  });

  it("SAGLASAN (status 1) bez tSaglasanRN reda: statusChangedAt pada na DIVIspravkeRN", async () => {
    const { prisma, syncer } = buildMocks([
      launchedRow({
        IDRN: 103,
        IDStatusPrimopredaje: 1,
        SaglasanAt: null,
        SaglasanBy: null,
        LansiranAt: null,
        LansiranBy: null,
      }),
    ]);

    await syncer.sync({ strategy: "full_refresh", cursor: null });

    expect(prisma.drawingHandover.upsert).toHaveBeenCalledWith(
      containing({
        create: containing({
          statusId: 1,
          technologistId: 9, // status 1 -> SifraRadnika
          statusChangedAt: D_UPDATED,
          statusChangedById: null,
          launchedAt: null,
          isLocked: false,
        }),
      }),
    );
  });

  it("LANSIRAN bez tLansiranRN reda: launchedAt pada na DIVIspravkeRN, launchedById null", async () => {
    const { prisma, syncer } = buildMocks([
      launchedRow({ IDRN: 104, LansiranAt: null, LansiranBy: null }),
    ]);

    await syncer.sync({ strategy: "full_refresh", cursor: null });

    expect(prisma.drawingHandover.upsert).toHaveBeenCalledWith(
      containing({
        create: containing({
          launchedAt: D_UPDATED,
          launchedById: null,
          isLocked: true,
        }),
      }),
    );
  });

  it("skip-ne-abort: nepostojeći crtež → red preskočen sa greškom, bez upserta i remapa", async () => {
    const { prisma, syncer } = buildMocks([
      launchedRow({ IDRN: 105, IDCrtez: 999 }),
    ]);

    const result = await syncer.sync({
      strategy: "full_refresh",
      cursor: null,
    });

    expect(result.rowsUpserted).toBe(0);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain("IDRN=105");
    expect(prisma.drawingHandover.upsert).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("skip-ne-abort: status van 0-3 → red preskočen", async () => {
    const { prisma, syncer } = buildMocks([
      launchedRow({ IDRN: 106, IDStatusPrimopredaje: 4 }),
      launchedRow({ IDRN: 107 }), // validan red iza — run se ne prekida
    ]);

    const result = await syncer.sync({
      strategy: "full_refresh",
      cursor: null,
    });

    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsUpserted).toBe(1);
    expect(prisma.drawingHandover.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.drawingHandover.upsert).toHaveBeenCalledWith(
      containing({ where: { legacyRnId: 107 } }),
    );
  });

  it("remap post-korak: UPDATE work_orders sa (IDRN, IDPrimopredaje, dh.id) torkama i IN uslovom", async () => {
    const { prisma, syncer } = buildMocks([
      launchedRow({ IDRN: 101, IDPrimopredaje: 7 }),
      launchedRow({ IDRN: 102, IDPrimopredaje: 7, IDCrtez: 11 }),
    ]);

    await syncer.sync({ strategy: "full_refresh", cursor: null });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [[sqlArg]] = prisma.$executeRaw.mock.calls as unknown as [
      [{ sql: string; values: unknown[] }],
    ];
    expect(sqlArg.sql).toContain("UPDATE work_orders");
    expect(sqlArg.sql).toContain("drawing_handover_id = v.handover_id");
    // Uslov "još drži legacy vrednost ILI je već remapovan" — štiti nativne RN-ove.
    expect(sqlArg.sql).toContain(
      "wo.drawing_handover_id IN (v.legacy_group_id, v.handover_id)",
    );
    // Torke: (IDRN, IDPrimopredaje, derivirani id = 500+IDRN).
    expect(sqlArg.values).toEqual([101, 7, 601, 102, 7, 602]);
  });

  it("ignoriše nasleđeni kursor: uvek pun prolaz, newCursor = derived_full_pass", async () => {
    const { mssql, syncer } = buildMocks([launchedRow()]);

    const result = await syncer.sync({
      strategy: "incremental",
      cursor: { lastModifiedAt: "2026-06-01T00:00:00.000Z" },
    });

    const sqlText = (mssql.query.mock.calls as unknown as [string][])[0][0];
    expect(sqlText).not.toContain("@cursor");
    expect(sqlText).toContain("WHERE rn.[IDPrimopredaje] > 0");
    expect(result.newCursor).toEqual({ strategy: "derived_full_pass" });
  });
});

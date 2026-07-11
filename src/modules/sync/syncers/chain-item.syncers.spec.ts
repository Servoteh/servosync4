import { PrismaService } from "../../../prisma/prisma.service";
import { MssqlClient } from "../mssql.client";
import { DrawingHandoverPdfSyncer } from "./drawing-handover-pdf.syncer";
import { DrawingPlanItemSyncer } from "./drawing-plan-item.syncer";
import { WorkOrderApprovalSyncer } from "./work-order-approval.syncer";
import { WorkOrderBlankSyncer } from "./work-order-blank.syncer";
import { WorkOrderMachinedPartSyncer } from "./work-order-machined-part.syncer";
import { WorkOrderNonstandardPartSyncer } from "./work-order-nonstandard-part.syncer";

/**
 * Testovi mapiranja (BACKEND_RULES §4.5 obrazac) za PRIVREMENE §5.3 chain-item
 * syncere (tabele lanca bez generisanog mapiranja). Bez baze — mock mssql +
 * prisma. Zajednička ponašanja baze (zaštita owned tabele, force wipe,
 * skip-ne-abort) testirana na tPDM synceru; puno mapiranje na svih šest.
 */

const D_UNOSA = new Date("2026-01-05T08:00:00Z");
const D_ISPRAVKE = new Date("2026-02-01T10:00:00Z");

interface MockDelegate {
  count: jest.Mock;
  deleteMany: jest.Mock;
  upsert: jest.Mock;
}

function delegateMock(existing = 0): MockDelegate {
  return {
    count: jest.fn().mockResolvedValue(existing),
    deleteMany: jest.fn().mockResolvedValue({ count: existing }),
    upsert: jest.fn().mockResolvedValue({}),
  };
}

function buildPrisma(existing = 0) {
  const delegates = {
    workOrderMachinedPart: delegateMock(existing),
    workOrderBlank: delegateMock(existing),
    workOrderNonstandardPart: delegateMock(existing),
    workOrderApproval: delegateMock(existing),
    drawingPlanItem: delegateMock(existing),
    drawingHandoverPdf: delegateMock(existing),
  };
  const prisma = {
    ...delegates,
    // alignIdSequence (poravnanje autoincrement-a posle uvoza legacy id-jeva)
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    workOrder: {
      findMany: jest.fn().mockResolvedValue([{ id: 101 }, { id: 102 }]),
    },
    worker: { findMany: jest.fn().mockResolvedValue([{ id: 9 }]) },
    operation: {
      findMany: jest.fn().mockResolvedValue([{ workCenterCode: "RJ1" }]),
    },
    drawingPlan: { findMany: jest.fn().mockResolvedValue([{ id: 11 }]) },
    drawing: { findMany: jest.fn().mockResolvedValue([{ id: 10 }]) },
  };
  return { prisma, delegates };
}

function mssqlMock(rows: Record<string, unknown>[]) {
  return { query: jest.fn().mockResolvedValue(rows) };
}

const containing = (obj: Record<string, unknown>): unknown =>
  expect.objectContaining(obj) as unknown;

// §5.3 "samo finalni run": uvoz radi ISKLJUČIVO uz force:true.
const RUN = { strategy: "full_refresh" as const, cursor: null };
const FORCED = { ...RUN, force: true };

function pdmRow(overrides: Record<string, unknown> = {}) {
  return {
    IDStavkePDM: 1,
    IDRN: 101,
    PozicijaPDM: "P-1",
    OperacijaPDM: 4,
    RJgrupaRC: "RJ1",
    NazivP: "Vratilo",
    BrojCrtezaP: "1126982",
    Komada: 3,
    DIVUnosa: D_UNOSA,
    DIVIspravke: D_ISPRAVKE,
    SifraRadnika: 9,
    ...overrides,
  };
}

describe("WorkOrderMachinedPartSyncer (tPDM)", () => {
  it("puno mapiranje svih 11 kolona, upsert po id-u", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new WorkOrderMachinedPartSyncer(
      mssqlMock([pdmRow()]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsFetched).toBe(1);
    expect(result.rowsUpserted).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    // Posle uvoza eksplicitnih legacy id-jeva sekvenca se poravnava, da
    // nativni pisci nad istom tabelom ne kolidiraju (P2002).
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining(
        "pg_get_serial_sequence('work_order_machined_parts','id')",
      ),
    );
    expect(delegates.workOrderMachinedPart.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: {
        id: 1,
        workOrderId: 101,
        position: "P-1",
        operationId: 4,
        workCenterCode: "RJ1",
        partName: "Vratilo",
        drawingNumber: "1126982",
        quantity: 3,
        createdAt: D_UNOSA,
        updatedAt: D_ISPRAVKE,
        workerId: 9,
      },
      update: containing({ id: 1, workOrderId: 101 }),
    });
    expect(result.newCursor).toEqual({ strategy: "full_refresh" });
  });

  it("bez force → no-op i nad PRAZNOM tabelom (§5.3 samo finalni run)", async () => {
    const { prisma, delegates } = buildPrisma(0);
    const mssql = mssqlMock([pdmRow()]);
    const syncer = new WorkOrderMachinedPartSyncer(
      mssql as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(RUN);

    expect(result.note).toContain("force:true");
    expect(result.rowsUpserted).toBe(0);
    expect(mssql.query).not.toHaveBeenCalled();
    expect(delegates.workOrderMachinedPart.deleteMany).not.toHaveBeenCalled();
    expect(delegates.workOrderMachinedPart.upsert).not.toHaveBeenCalled();
  });

  it("force nad ne-praznom tabelom: deleteMany PRE upserta (tačna legacy kopija)", async () => {
    const { prisma, delegates } = buildPrisma(5);
    const syncer = new WorkOrderMachinedPartSyncer(
      mssqlMock([pdmRow()]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync({ ...RUN, force: true });

    expect(delegates.workOrderMachinedPart.deleteMany).toHaveBeenCalledWith({});
    expect(delegates.workOrderMachinedPart.upsert).toHaveBeenCalledTimes(1);
    expect(result.rowsUpserted).toBe(1);
  });

  it("skip-ne-abort: nepostojeći RN / radnik / RC → red preskočen, run ide dalje", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new WorkOrderMachinedPartSyncer(
      mssqlMock([
        pdmRow({ IDStavkePDM: 2, IDRN: 999 }),
        pdmRow({ IDStavkePDM: 3, SifraRadnika: 999 }),
        pdmRow({ IDStavkePDM: 4, RJgrupaRC: "XX" }),
        pdmRow({ IDStavkePDM: 5 }),
      ]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsSkipped).toBe(3);
    expect(result.rowsUpserted).toBe(1);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("IDStavkePDM=2");
    expect(result.errors[0]).toContain("work order 999");
    expect(delegates.workOrderMachinedPart.upsert).toHaveBeenCalledWith(
      containing({ where: { id: 5 } }),
    );
  });
});

describe("WorkOrderBlankSyncer (tPLP)", () => {
  it("puno mapiranje svih 13 kolona", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new WorkOrderBlankSyncer(
      mssqlMock([
        {
          IDStavkePLP: 7,
          IDRN: 102,
          PozicijaPLP: "P-2",
          RJgrupaRC: "RJ1",
          Materijal: "Č1530",
          DimenzijaMaterijala: "fi 60x120",
          JM: "kom",
          TezinaJed: 2.5,
          Komada: 4,
          BrojPozicije: "12",
          DIVUnosa: D_UNOSA,
          DIVIspravke: D_ISPRAVKE,
          SifraRadnika: 9,
        },
      ]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsUpserted).toBe(1);
    expect(delegates.workOrderBlank.upsert).toHaveBeenCalledWith({
      where: { id: 7 },
      create: {
        id: 7,
        workOrderId: 102,
        position: "P-2",
        workCenterCode: "RJ1",
        material: "Č1530",
        materialDimension: "fi 60x120",
        unit: "kom",
        unitWeight: 2.5,
        quantity: 4,
        positionNumber: "12",
        createdAt: D_UNOSA,
        updatedAt: D_ISPRAVKE,
        workerId: 9,
      },
      update: containing({ id: 7 }),
    });
  });
});

describe("WorkOrderNonstandardPartSyncer (tPND)", () => {
  it("puno mapiranje svih 11 kolona (Komada je float)", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new WorkOrderNonstandardPartSyncer(
      mssqlMock([
        {
          IDStavkePND: 8,
          IDRN: 101,
          PozicijaPND: "P-3",
          OperacijaPND: null,
          RJgrupaRC: "RJ1",
          NazivDela: "Nestandardni deo",
          Komada: 1.5,
          Napomena: "hitno",
          DIVUnosa: D_UNOSA,
          DIVIspravke: D_ISPRAVKE,
          SifraRadnika: 9,
        },
      ]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsUpserted).toBe(1);
    expect(delegates.workOrderNonstandardPart.upsert).toHaveBeenCalledWith({
      where: { id: 8 },
      create: {
        id: 8,
        workOrderId: 101,
        position: "P-3",
        operationId: null,
        workCenterCode: "RJ1",
        partName: "Nestandardni deo",
        quantity: 1.5,
        note: "hitno",
        createdAt: D_UNOSA,
        updatedAt: D_ISPRAVKE,
        workerId: 9,
      },
      update: containing({ id: 8 }),
    });
  });
});

describe("WorkOrderApprovalSyncer (tSaglasanRN)", () => {
  it("puno mapiranje svih 10 kolona (ogledalo tLansiranRN mapiranja)", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new WorkOrderApprovalSyncer(
      mssqlMock([
        {
          IDSaglasan: 21,
          IDRN: 101,
          Saglasan: true,
          DatumUnosa: D_UNOSA,
          DIVUnos: D_UNOSA,
          SifraRadnikaUnos: 12,
          PotpisUnos: "MJ",
          DIVIspravke: D_ISPRAVKE,
          SifraRadnikaIspravka: 13,
          PotpisIspravka: "NJ",
        },
      ]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsUpserted).toBe(1);
    expect(delegates.workOrderApproval.upsert).toHaveBeenCalledWith({
      where: { id: 21 },
      create: {
        id: 21,
        workOrderId: 101,
        isApproved: true,
        enteredAt: D_UNOSA,
        createdAt: D_UNOSA,
        createdByWorkerId: 12,
        createdBySignature: "MJ",
        updatedAt: D_ISPRAVKE,
        updatedByWorkerId: 13,
        updatedBySignature: "NJ",
      },
      update: containing({ id: 21 }),
    });
  });

  it("meke reference radnika se prepisuju i kad radnik ne postoji (bez FK)", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new WorkOrderApprovalSyncer(
      mssqlMock([
        {
          IDSaglasan: 22,
          IDRN: 101,
          Saglasan: false,
          DatumUnosa: D_UNOSA,
          DIVUnos: D_UNOSA,
          SifraRadnikaUnos: 999, // ne postoji u workers — plain Int kolona
          PotpisUnos: null,
          DIVIspravke: D_ISPRAVKE,
          SifraRadnikaIspravka: 999,
          PotpisIspravka: null,
        },
      ]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsUpserted).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    expect(delegates.workOrderApproval.upsert).toHaveBeenCalledWith(
      containing({
        create: containing({ createdByWorkerId: 999, updatedByWorkerId: 999 }),
      }),
    );
  });
});

describe("DrawingPlanItemSyncer (PDM_PlaniranjeStavke)", () => {
  it("puno mapiranje svih 17 kolona (Decimal pass-through)", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new DrawingPlanItemSyncer(
      mssqlMock([
        {
          IDPlanStavka: 31,
          IDPlan: 11,
          IDCrtezNabavke: 10,
          SifraArtikla: 555,
          KolicinaPoSklopu: 2.5,
          PotrebnoUkupno: 10,
          PredProveraIDPlan: null,
          OdlukaAkcija: 0,
          RucnaKolicina: null,
          Rezervisano: 0,
          ZaNabavku: 10,
          Zalihe: 1.25,
          NazivArtiklaStavke: "Vijak M8",
          KataloskiBrojStavke: "V-M8",
          JMStavke: "kom",
          JeRucnaStavka: false,
          IskljuciNabavku: true,
        },
      ]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsUpserted).toBe(1);
    expect(delegates.drawingPlanItem.upsert).toHaveBeenCalledWith({
      where: { id: 31 },
      create: {
        id: 31,
        planId: 11,
        procurementDrawingId: 10,
        itemId: 555,
        quantityPerAssembly: 2.5,
        totalRequired: 10,
        prevCheckPlanId: null,
        decisionAction: 0,
        manualQuantity: null,
        reserved: 0,
        toProcure: 10,
        inStock: 1.25,
        itemName: "Vijak M8",
        itemCatalogNumber: "V-M8",
        itemUnit: "kom",
        isManualItem: false,
        excludeFromProcurement: true,
      },
      update: containing({ id: 31 }),
    });
  });

  it("nepostojeći plan/crtež → red preskočen", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new DrawingPlanItemSyncer(
      mssqlMock([
        {
          IDPlanStavka: 32,
          IDPlan: 999,
          IDCrtezNabavke: 10,
          KolicinaPoSklopu: 1,
          OdlukaAkcija: 0,
          Rezervisano: 0,
          ZaNabavku: 0,
          JeRucnaStavka: false,
          IskljuciNabavku: false,
        },
      ]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain("IDPlanStavka=32");
    expect(delegates.drawingPlanItem.upsert).not.toHaveBeenCalled();
  });
});

describe("DrawingHandoverPdfSyncer (PrimopredajaPDFCrteza)", () => {
  it("prazan izvor (očekivano): 0 redova + nota o praznom parentu", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new DrawingHandoverPdfSyncer(
      mssqlMock([]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsFetched).toBe(0);
    expect(result.rowsUpserted).toBe(0);
    expect(result.note).toContain("prazna na izvoru");
    expect(delegates.drawingHandoverPdf.upsert).not.toHaveBeenCalled();
  });

  it("ne-prazan izvor: NIŠTA se ne upisuje (id-jevi nemapirljivi), PAŽNJA nota", async () => {
    const { prisma, delegates } = buildPrisma();
    const syncer = new DrawingHandoverPdfSyncer(
      mssqlMock([
        {
          ID: 1,
          IDPrimopredaje: 601,
          LinkFajla: "\\\\srv\\a.pdf",
          NazivFajla: "a.pdf",
        },
      ]) as unknown as MssqlClient,
      prisma as unknown as PrismaService,
    );

    const result = await syncer.sync(FORCED);

    expect(result.rowsFetched).toBe(1);
    expect(result.rowsUpserted).toBe(0);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain("mapping decision required");
    expect(result.note).toContain("PAŽNJA");
    expect(delegates.drawingHandoverPdf.upsert).not.toHaveBeenCalled();
  });
});

import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { ScopeService } from "../../common/authz/scope.service";
import { TechProcessesService } from "./tech-processes.service";

/** Mock PrismaService — samo modeli koje `card()` dodiruje (batch resolveri). */
function prismaMock() {
  return {
    techProcess: { findMany: jest.fn().mockResolvedValue([]) },
    worker: { findMany: jest.fn().mockResolvedValue([]) },
    partQualityType: { findMany: jest.fn().mockResolvedValue([]) },
    operation: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

let nextId = 1;

/** Red `tech_processes` (jedno kucanje) sa razumnim podrazumevanim vrednostima. */
function tpRow(over: Record<string, unknown> = {}) {
  return {
    id: nextId++,
    workerId: 10,
    projectId: 2597,
    identNumber: "06/93-4",
    variant: 0,
    printTimer: 0,
    enteredAt: new Date("2026-07-01T08:00:00Z"),
    operationNumber: 10,
    workCenterCode: "0102",
    identMark: "0",
    pieceCount: 0,
    signature: null,
    workerSymbol: false,
    processSymbol: false,
    operationSymbol: false,
    finishedAt: null,
    isProcessFinished: false,
    note: null,
    workOrderId: 0,
    qualityTypeId: 0,
    reworkOperationId: 0,
    documents: [],
    ...over,
  };
}

const CARD_QUERY = { projectId: "2597", identNumber: "06/93-4", variant: "0" };

describe("TechProcessesService — card (agregat po operaciji)", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        TechProcessesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ScopeService, useValue: {} },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
  });

  it("grupise po (OP, RC): ista operacija na dva radna centra = dve grupe, redosled pojavljivanja", async () => {
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ operationNumber: 10, workCenterCode: "0102", pieceCount: 3 }),
      tpRow({ operationNumber: 10, workCenterCode: "0205", pieceCount: 2 }),
      tpRow({ operationNumber: 10, workCenterCode: "0102", pieceCount: 4 }),
      tpRow({ operationNumber: 20, workCenterCode: "0102", pieceCount: 1 }),
    ]);
    prisma.operation.findMany.mockResolvedValue([
      {
        workCenterCode: "0102",
        workCenterName: "Glodalica",
        workUnitCode: "01",
      },
    ]);

    const { data } = await service.card(CARD_QUERY);

    expect(
      data.operations.map((o) => [o.operationNumber, o.workCenterCode]),
    ).toEqual([
      [10, "0102"],
      [10, "0205"],
      [20, "0102"],
    ]);
    const first = data.operations[0];
    expect(first.entryCount).toBe(2);
    expect(first.pieces.total).toBe(7);
    // Resolved ref — isti oblik kao na redovima; null kad je RC nerazrešiv.
    expect(first.operation).toEqual({
      workCenterCode: "0102",
      workCenterName: "Glodalica",
      workUnitCode: "01",
    });
    expect(data.operations[1].operation).toBeNull();
  });

  it("netuje storno: kontra-red sa negativnim pieceCount poništava kucanje", async () => {
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ pieceCount: 10, qualityTypeId: 0 }),
      tpRow({ pieceCount: -10, qualityTypeId: 0 }), // storno kontra-red
      tpRow({ pieceCount: 5, qualityTypeId: 1 }),
      tpRow({ pieceCount: 2, qualityTypeId: 2 }),
    ]);

    const { data } = await service.card(CARD_QUERY);

    expect(data.operations).toHaveLength(1);
    const op = data.operations[0];
    expect(op.entryCount).toBe(4); // storno je i dalje kucanje
    expect(op.pieces).toEqual({ total: 7, good: 0, rework: 5, scrap: 2 });
    expect(data.summary.totalPieces).toBe(7);
    expect(data.summary.piecesByQuality).toEqual({
      good: 0,
      rework: 5,
      scrap: 2,
    });
  });

  it("KOM=0 red (sesija samo-vreme) ulazi u entryCount, ne u komade; vreme se sabira", async () => {
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({
        pieceCount: 0, // KOM=0 — količina se upisuje pri zatvaranju
        enteredAt: new Date("2026-07-01T08:00:00Z"),
        finishedAt: new Date("2026-07-01T08:30:00Z"),
      }),
      tpRow({
        pieceCount: 8,
        qualityTypeId: 0,
        enteredAt: new Date("2026-07-01T09:00:00Z"),
        finishedAt: new Date("2026-07-01T09:15:00Z"),
        isProcessFinished: true,
      }),
    ]);

    const { data } = await service.card(CARD_QUERY);

    expect(data.operations).toHaveLength(1);
    const op = data.operations[0];
    expect(op.entryCount).toBe(2);
    expect(op.pieces.total).toBe(8);
    expect(op.pieces.good).toBe(8);
    expect(op.isFinished).toBe(true);
    expect(op.firstEnteredAt).toEqual(new Date("2026-07-01T08:00:00Z"));
    expect(op.lastFinishedAt).toEqual(new Date("2026-07-01T09:15:00Z"));
    expect(op.elapsedMinutes).toBe(45); // 30 + 15
  });

  it("elapsedMinutes je null dok nijedan red grupe nema oba vremena", async () => {
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ pieceCount: 3, finishedAt: null }),
    ]);

    const { data } = await service.card(CARD_QUERY);

    expect(data.operations[0].elapsedMinutes).toBeNull();
    expect(data.operations[0].lastFinishedAt).toBeNull();
  });

  it("summary broji DISTINCT (OP, RC) parove, ne redove: operationCount/finishedCount/entryCount", async () => {
    prisma.techProcess.findMany.mockResolvedValue([
      // Grupa A (OP10, RC 0102): dva kucanja, jedno zatvoreno.
      tpRow({ operationNumber: 10, workCenterCode: "0102", pieceCount: 5 }),
      tpRow({
        operationNumber: 10,
        workCenterCode: "0102",
        pieceCount: 5,
        isProcessFinished: true,
        finishedAt: new Date("2026-07-01T10:00:00Z"),
      }),
      // Grupa B (OP10, RC 0205): jedno kucanje, otvoreno.
      tpRow({ operationNumber: 10, workCenterCode: "0205", pieceCount: 1 }),
    ]);

    const { data } = await service.card(CARD_QUERY);

    expect(data.operationCount).toBe(2); // distinct parovi, NE 3 reda
    expect(data.finishedCount).toBe(1); // samo grupa A ima zatvoren red
    expect(data.summary.entryCount).toBe(3); // ukupan broj kucanja
    expect(data.operations.map((o) => o.isFinished)).toEqual([true, false]);
  });
});

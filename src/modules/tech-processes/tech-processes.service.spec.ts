import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { ScopeService } from "../../common/authz/scope.service";
import { NotificationsService } from "../notifications/notifications.service";
import { TechProcessesService } from "./tech-processes.service";

/** Mock PrismaService — modeli koje dodiruju `card()`, `scan()` i D8 emit helperi. */
function prismaMock() {
  const m = {
    techProcess: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    worker: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    partQualityType: { findMany: jest.fn().mockResolvedValue([]) },
    operation: { findMany: jest.fn().mockResolvedValue([]) },
    // D8 emit: lanac RN → primopredaja → stavka nacrta → projektant
    // (+ fallback `drawings.designedBy`); scan: tekući RN po (predmet, ident).
    workOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    workOrderOperation: { findFirst: jest.fn().mockResolvedValue(null) },
    drawingHandover: { findUnique: jest.fn().mockResolvedValue(null) },
    handoverDraftItem: { findFirst: jest.fn().mockResolvedValue(null) },
    handoverDraft: { findUnique: jest.fn().mockResolvedValue(null) },
    drawing: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
  m.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(m),
  );
  return m;
}

/** Mock NotificationsService — D8 emit (control() dorada/škart). */
function notificationsMock() {
  return {
    notifyWorkers: jest.fn().mockResolvedValue(0),
    resolveTechnologistWorkerIds: jest.fn().mockResolvedValue([]),
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
        { provide: NotificationsService, useValue: notificationsMock() },
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

// ================================================================== SCAN × D5 klon-varijanta

/** `expect.objectContaining` tipizovan kao `unknown` (smiruje no-unsafe-assignment). */
const containing = (obj: Record<string, unknown>): unknown =>
  expect.objectContaining(obj) as unknown;

describe("TechProcessesService — scan pinuje TEKUĆU varijantu RN-a (D5 klon = novi red)", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;

  /** Tekući RN = klon-varijanta 1 (D5: novi red sa MAX+1, stara varijanta 0 ostaje). */
  const currentWo = {
    id: 900,
    projectId: 2597,
    identNumber: "06/93-4",
    variant: 1,
    pieceCount: 10,
    revision: "A",
  };

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        TechProcessesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ScopeService, useValue: {} },
        { provide: NotificationsService, useValue: notificationsMock() },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.workOrder.findFirst.mockResolvedValue(currentWo);
  });

  it("sken NOVOG otiska otvara red na NOVOJ varijanti (create-on-scan pinovan na RN)", async () => {
    // Nova varijanta još nema kucanja — red za variant=1 ne postoji.
    prisma.techProcess.findFirst.mockResolvedValue(null);
    prisma.workOrderOperation.findFirst.mockResolvedValue({
      operationNumber: 10,
    });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({ variant: 1, pieceCount: 0, workOrderId: 900 }),
    );
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ variant: 1, pieceCount: 2, workOrderId: 900 }),
    );

    const { data } = await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:1:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 2,
    });

    // Lookup je PINOVAN na varijantu tekućeg RN-a — ne sme da pogodi red var. 0.
    expect(prisma.techProcess.findFirst).toHaveBeenCalledWith(
      containing({ where: containing({ variant: 1 }) }),
    );
    expect(prisma.techProcess.create).toHaveBeenCalledWith(
      containing({ data: containing({ variant: 1, workOrderId: 900 }) }),
    );
    expect(data.staleWorkOrder).toBe(false);
    expect(data.currentVariant).toBe(1);
  });

  it("sken STAROG otiska (var. 0) → staleWorkOrder=true, rad knjižen na tekuću varijantu", async () => {
    // Red tekuće varijante postoji (već kucano posle klona).
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({ variant: 1, pieceCount: 3, workOrderId: 900 }),
    );
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ variant: 1, pieceCount: 5, workOrderId: 900 }),
    );

    const { data } = await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:0:A", // star otisak (pre klona)
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 2,
    });

    expect(data.staleWorkOrder).toBe(true);
    expect(data.printedVariant).toBe(0);
    expect(data.currentVariant).toBe(1);
    expect(prisma.techProcess.create).not.toHaveBeenCalled();
  });

  it("404 kad RN za (predmet, ident) ne postoji", async () => {
    prisma.workOrder.findFirst.mockResolvedValue(null);

    await expect(
      service.scan({
        orderBarcode: "RNZ:2597:06/93-4:0:A",
        operationBarcode: "S:10:0102:0:A",
        pieceCount: 1,
      }),
    ).rejects.toThrow("RN za predmet 2597, ident 06/93-4 nije nađen.");
  });
});

// ================================================================== D8 emit (dorada/škart)

/** Privatni emit helperi — tipizirani pogled bez `any` (obrazac `as unknown as`). */
interface EmitView {
  notifyQualityIssue(input: {
    workOrderId: number;
    identNumber: string;
    operationNumber: number;
    workCenterCode: string;
    qualityTypeId: number;
    pieceCount: number;
    controllerName: string | null;
  }): Promise<void>;
  resolveWorkOrderDesignerId(workOrderId: number): Promise<number | null>;
}

const QUALITY_INPUT = {
  workOrderId: 42,
  identNumber: "06/93-4",
  operationNumber: 60,
  workCenterCode: "8.5",
  qualityTypeId: 2, // ŠKART
  pieceCount: 3,
  controllerName: "Pera Kontrolor",
};

describe("TechProcessesService — D8 emit notifikacija (control dorada/škart)", () => {
  let emit: EmitView;
  let prisma: ReturnType<typeof prismaMock>;
  let notifications: ReturnType<typeof notificationsMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    notifications = notificationsMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        TechProcessesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ScopeService, useValue: {} },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    emit = mod.get(TechProcessesService);
  });

  it("ŠKART: poruka srpski + type kontrola.skart + ref na work_orders; primaoci = tehnolozi", async () => {
    notifications.resolveTechnologistWorkerIds.mockResolvedValue([7, 9]);

    await emit.notifyQualityIssue(QUALITY_INPUT);

    expect(notifications.notifyWorkers).toHaveBeenCalledWith([7, 9], {
      type: "kontrola.skart",
      message:
        "ŠKART na RN 06/93-4 op 60 (8.5) — kontrolor Pera Kontrolor, 3 kom",
      refTable: "work_orders",
      refId: 42,
    });
  });

  it("DORADA: type kontrola.dorada + DORADA label (odluka Nenad: i dorada šalje)", async () => {
    await emit.notifyQualityIssue({ ...QUALITY_INPUT, qualityTypeId: 1 });

    const [, payload] = notifications.notifyWorkers.mock.calls[0] as [
      number[],
      { type: string; message: string },
    ];
    expect(payload.type).toBe("kontrola.dorada");
    expect(payload.message).toContain("DORADA na RN 06/93-4");
  });

  it("projektant crteža se dodaje primaocima kad lanac RN→primopredaja→nacrt postoji", async () => {
    notifications.resolveTechnologistWorkerIds.mockResolvedValue([7]);
    prisma.workOrder.findUnique.mockResolvedValue({ drawingHandoverId: 11 });
    prisma.drawingHandover.findUnique.mockResolvedValue({ drawingId: 500 });
    prisma.handoverDraftItem.findFirst.mockResolvedValue({ draftId: 3 });
    prisma.handoverDraft.findUnique.mockResolvedValue({ designerId: 55 });

    await emit.notifyQualityIssue(QUALITY_INPUT);

    const [recipients] = notifications.notifyWorkers.mock.calls[0] as [
      number[],
    ];
    expect(recipients).toEqual([7, 55]);
  });

  it("pukao lanac (RN bez primopredaje) i bez crteža → preskoči projektanta BEZ greške", async () => {
    prisma.workOrder.findUnique.mockResolvedValue({
      drawingHandoverId: 0,
      drawingId: 0,
    });

    await expect(emit.resolveWorkOrderDesignerId(42)).resolves.toBeNull();
  });

  it("FALLBACK (odluka #6): pukao lanac → drawings.designedBy se upari sa workers.fullName", async () => {
    prisma.workOrder.findUnique.mockResolvedValue({
      drawingHandoverId: 0, // legacy RN bez primopredaje
      drawingId: 500,
    });
    prisma.drawing.findUnique.mockResolvedValue({
      designedBy: "Marko Marković",
    });
    prisma.worker.findFirst.mockResolvedValue({ id: 61 });

    await expect(emit.resolveWorkOrderDesignerId(42)).resolves.toBe(61);
    // Tačan (case-insensitive) match nad AKTIVNIM radnicima — string nije ključ.
    expect(prisma.worker.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          fullName: { equals: "Marko Marković", mode: "insensitive" },
          active: true,
        },
      }),
    );
  });

  it("FALLBACK bez poklapanja imena → null (fuzzy se namerno ne radi)", async () => {
    prisma.workOrder.findUnique.mockResolvedValue({
      drawingHandoverId: 0,
      drawingId: 500,
    });
    prisma.drawing.findUnique.mockResolvedValue({ designedBy: "Nepoznat Ime" });
    prisma.worker.findFirst.mockResolvedValue(null);

    await expect(emit.resolveWorkOrderDesignerId(42)).resolves.toBeNull();
  });

  it("designerId=0 na nacrtu (orphan) → null, ne 0 kao primalac", async () => {
    prisma.workOrder.findUnique.mockResolvedValue({ drawingHandoverId: 11 });
    prisma.drawingHandover.findUnique.mockResolvedValue({ drawingId: 500 });
    prisma.handoverDraftItem.findFirst.mockResolvedValue({ draftId: 3 });
    prisma.handoverDraft.findUnique.mockResolvedValue({ designerId: 0 });

    await expect(emit.resolveWorkOrderDesignerId(42)).resolves.toBeNull();
  });

  it("pad notifikacije se guta (best-effort) — kucanje kontrole ne sme pasti", async () => {
    notifications.resolveTechnologistWorkerIds.mockRejectedValue(
      new Error("db down"),
    );

    await expect(
      emit.notifyQualityIssue(QUALITY_INPUT),
    ).resolves.toBeUndefined();
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
  });
});

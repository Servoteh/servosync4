import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { ScopeService } from "../../common/authz/scope.service";
import { NotificationsService } from "../notifications/notifications.service";
import { LabelPrintService } from "../../common/printing/label-print.service";
import { TechProcessesService } from "./tech-processes.service";

/** Mock PrismaService — modeli koje dodiruju `card()`, `scan()` i D8 emit helperi. */
function prismaMock() {
  const m = {
    techProcess: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      // control(): kumulativ svih kontrola te operacije + kaskada potvrde.
      aggregate: jest.fn().mockResolvedValue({ _sum: { pieceCount: 0 } }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    worker: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // control(): kontrolor-auth (workerType.additionalPrivileges).
    workerType: { findUnique: jest.fn().mockResolvedValue(null) },
    partQualityType: { findMany: jest.fn().mockResolvedValue([]) },
    // control()/opšti nalog: findUnique (significantForFinishing / withoutProcess).
    operation: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    // D8 emit: lanac RN → primopredaja → stavka nacrta → projektant
    // (+ fallback `drawings.designedBy`); scan: tekući RN po (predmet, ident).
    workOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    workOrderOperation: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // control(): knjiženje lokacija iskontrolisanih delova (part_locations).
    position: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    partLocation: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    // control(): buildLabelData (RN → predmet → komitent).
    project: { findUnique: jest.fn().mockResolvedValue(null) },
    customer: { findUnique: jest.fn().mockResolvedValue(null) },
    // openForWorker: otvorene sesije radnika + svež users.worker_id fallback.
    workTimeEntry: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
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
        { provide: LabelPrintService, useValue: { printRawTspl: jest.fn() } },
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
        { provide: LabelPrintService, useValue: { printRawTspl: jest.fn() } },
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
        { provide: LabelPrintService, useValue: { printRawTspl: jest.fn() } },
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

describe("TechProcessesService — openForWorker (Moji otvoreni, proba 13.07 Jovica)", () => {
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
        { provide: LabelPrintService, useValue: { printRawTspl: jest.fn() } },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    // Kartica → radnik 74 (Jovica).
    prisma.worker.findFirst.mockResolvedValue({
      id: 74,
      fullName: "Jovica Milosevic",
      username: "jovica",
      workerTypeId: 1,
    });
  });

  it("vraća red DELJENE operacije sa mojom otvorenom sesijom iako tp.workerId NIJE moj (workerId=0)", async () => {
    // Jovicin slučaj: START sken otvorio red sa workerId=0, sesija njegova.
    prisma.workTimeEntry.findMany.mockResolvedValue([
      { techProcessId: 117084 },
    ]);
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ id: 117084, workerId: 0 }),
    ]);

    const { data, meta } = await service.openForWorker("CARD74", undefined);

    expect(meta.workerId).toBe(74);
    expect(data).toHaveLength(1);
    expect(data[0].hasOpenSession).toBe(true);
    // Upit mora da traži: moje redove ILI redove mojih otvorenih sesija.
    expect(prisma.techProcess.findMany).toHaveBeenCalledWith(
      containing({
        where: containing({
          isProcessFinished: { not: true },
          OR: [{ workerId: 74 }, { id: { in: [117084] } }],
        }),
      }),
    );
  });

  it("moji redovi bez otvorene sesije i dalje ulaze (vlasništvo), hasOpenSession=false", async () => {
    prisma.workTimeEntry.findMany.mockResolvedValue([]);
    prisma.techProcess.findMany.mockResolvedValue([tpRow({ workerId: 74 })]);

    const { data } = await service.openForWorker("CARD74", undefined);

    expect(data).toHaveLength(1);
    expect(data[0].hasOpenSession).toBe(false);
  });

  it("bez kartice: nalog bez vezanog radnika → 400 sa jasnom porukom", async () => {
    prisma.user.findUnique.mockResolvedValue({ workerId: null });

    await expect(
      service.openForWorker(undefined, {
        userId: 5,
        email: "x@y",
        role: "proizvodni_radnik",
        workerId: null,
      }),
    ).rejects.toThrow("Radnik nije prepoznat");
  });
});

describe("TechProcessesService — create-on-scan štancuje kreatora (proba 13.07 Jovica)", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        TechProcessesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ScopeService,
          useValue: {
            workerMachineViolation: jest.fn().mockResolvedValue(null),
            isEnforced: jest.fn().mockReturnValue(false),
          },
        },
        { provide: NotificationsService, useValue: notificationsMock() },
        { provide: LabelPrintService, useValue: { printRawTspl: jest.fn() } },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      projectId: 2597,
      identNumber: "06/93-4",
      variant: 1,
      pieceCount: 10,
      revision: "A",
    });
    prisma.worker.findFirst.mockResolvedValue({
      id: 74,
      fullName: "Jovica Milosevic",
      username: "jovica",
      workerTypeId: 1,
    });
  });

  it("startWork: novi red operacije dobija workerId radnika sa kartice (NE 0)", async () => {
    prisma.techProcess.findFirst.mockResolvedValue(null); // red ne postoji → create
    prisma.workOrderOperation.findFirst.mockResolvedValue({
      operationNumber: 10,
    });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({ id: 555, workerId: 74, variant: 1, workOrderId: 900 }),
    );
    // startWork: multitasking findFirst (druga otvorena sesija) → null; create sesije.
    (prisma.workTimeEntry as Record<string, jest.Mock>).findFirst = jest
      .fn()
      .mockResolvedValue(null);
    (prisma.workTimeEntry as Record<string, jest.Mock>).create = jest
      .fn()
      .mockResolvedValue({ id: 1, startedAt: new Date() });

    await service.startWork({
      workerCard: "CARD74",
      orderBarcode: "RNZ:2597:06/93-4:1:A",
      operationBarcode: "S:10:0102:0:A",
    });

    expect(prisma.techProcess.create).toHaveBeenCalledWith(
      containing({ data: containing({ workerId: 74 }) }),
    );
  });
});

// ============================================================ CONTROL akumulacija do plana

describe("TechProcessesService — control akumulira do plana (parcijala ne zatvara)", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;

  /** RN sa planom 50 kom; findWorkOrderByTriple + markWorkOrderIfComplete čitaju isti red. */
  const CONTROL_WO = {
    id: 900,
    projectId: 2597,
    identNumber: "06/93-4",
    variant: 0,
    partName: "Osovina",
    drawingNumber: "CRT-1",
    pieceCount: 50,
    productionDeadline: null,
    handoverStatusId: 0,
    status: false,
    revision: "A",
    material: "C45",
  };

  /** Kontrola (dobar kvalitet → bez child RN / notifikacije). */
  const CONTROL_DTO = {
    orderBarcode: "RNZ:2597:06/93-4:0:A",
    operationBarcode: "S:60:8.5:0:A",
    workerCard: "CTRL1",
    qualityTypeId: 0,
    pieceCount: 10,
    locations: [{ positionId: 1, quantity: 10 }],
  };

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        TechProcessesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ScopeService,
          useValue: { isEnforced: jest.fn().mockReturnValue(false) },
        },
        { provide: NotificationsService, useValue: notificationsMock() },
        { provide: LabelPrintService, useValue: { printRawTspl: jest.fn() } },
      ],
    }).compile();
    service = mod.get(TechProcessesService);

    // Kontrolor sa kartice + ovlašćen tip radnika (additionalPrivileges).
    prisma.worker.findFirst.mockResolvedValue({
      id: 88,
      fullName: "Pera Kontrolor",
      username: "pera",
      workerTypeId: 5,
    });
    prisma.workerType.findUnique.mockResolvedValue({
      additionalPrivileges: true,
    });
    prisma.workOrder.findFirst.mockResolvedValue(CONTROL_WO);
    prisma.workOrder.findUnique.mockResolvedValue(CONTROL_WO); // buildLabelData
    prisma.operation.findUnique.mockResolvedValue({
      significantForFinishing: true,
    });
    prisma.workOrderOperation.findFirst.mockResolvedValue({ id: 1 });
  });

  it("parcijala (10/50): red ostaje otvoren, bez kaskade i skidanja sa prioriteta", async () => {
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 0 } });
    prisma.techProcess.findFirst.mockResolvedValue(null); // create grana
    prisma.techProcess.create.mockResolvedValue(
      tpRow({
        id: 700,
        pieceCount: 10,
        isProcessFinished: false,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
      }),
    );

    const { data } = await service.control(CONTROL_DTO);

    expect(data.operationFinished).toBe(false);
    expect(data.controlledCumulative).toBe(10);
    expect(data.confirmedOperations).toBe(0);
    expect(data.operationsPrioritized).toBe(0);

    // Novi red se NE zatvara na parcijali; pieceCount = ova prijava.
    const createArg = prisma.techProcess.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.pieceCount).toBe(10);
    expect(createArg.data.isProcessFinished).toBeUndefined();

    // Kaskada (potvrda prethodnih) i skidanje sa prioriteta se NE pale.
    expect(prisma.techProcess.updateMany).not.toHaveBeenCalled();
    expect(prisma.workOrderOperation.updateMany).not.toHaveBeenCalled();
  });

  it("akumulacija 10+40=50: zatvara red + pali kaskadu i skidanje sa prioriteta", async () => {
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 10 } });
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({ id: 701, pieceCount: 10, isProcessFinished: false }),
    ); // otvoren red → update grana (akumulacija)
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 701, pieceCount: 50, isProcessFinished: true }),
    );
    prisma.techProcess.updateMany.mockResolvedValue({ count: 2 });
    prisma.workOrderOperation.updateMany.mockResolvedValue({ count: 3 });

    const { data } = await service.control({
      ...CONTROL_DTO,
      pieceCount: 40,
      locations: [{ positionId: 1, quantity: 40 }],
    });

    expect(data.operationFinished).toBe(true);
    expect(data.controlledCumulative).toBe(50);
    expect(data.confirmedOperations).toBe(2);
    expect(data.operationsPrioritized).toBe(3);

    // Akumulacija: postojeći otvoreni red (10) + ova prijava (40) = 50; zatvoren.
    const updateArg = prisma.techProcess.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.pieceCount).toBe(50);
    expect(updateArg.data.isProcessFinished).toBe(true);
    expect(prisma.techProcess.updateMany).toHaveBeenCalled();
    expect(prisma.workOrderOperation.updateMany).toHaveBeenCalled();
  });

  it("kumulativni premašaj (20+40=60 > 50): 422, ništa se ne knjiži", async () => {
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 20 } });

    await expect(
      service.control({
        ...CONTROL_DTO,
        pieceCount: 40,
        locations: [{ positionId: 1, quantity: 40 }],
      }),
    ).rejects.toThrow("Ukupno iskontrolisano (60) premašuje planirano (50)");

    // Guard je PRE knjiženja lokacija i PRE create/update reda kontrole.
    expect(prisma.partLocation.create).not.toHaveBeenCalled();
    expect(prisma.techProcess.create).not.toHaveBeenCalled();
    expect(prisma.techProcess.update).not.toHaveBeenCalled();
  });
});

// ============================================================ OPŠTI NALOG (withoutProcess)

describe("TechProcessesService — opšti nalog (Operation.withoutProcess) zaobilazi routing", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;

  const GEN_WO = {
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
        { provide: LabelPrintService, useValue: { printRawTspl: jest.fn() } },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.workOrder.findFirst.mockResolvedValue(GEN_WO);
    prisma.techProcess.findFirst.mockResolvedValue(null); // red još ne postoji
  });

  it("withoutProcess=true: otvara red BEZ routing lookup-a i BEZ 422", async () => {
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: true });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({ id: 555, variant: 1, pieceCount: 0, workOrderId: 900 }),
    );
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 555, variant: 1, pieceCount: 3, workOrderId: 900 }),
    );

    await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:1:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 3,
    });

    // Red je otvoren direktno; routing (work_order_operations) se NE proverava.
    expect(prisma.workOrderOperation.findFirst).not.toHaveBeenCalled();
    expect(prisma.techProcess.create).toHaveBeenCalledWith(
      containing({
        data: containing({
          workCenterCode: "0102",
          workOrderId: 900,
          pieceCount: 0,
        }),
      }),
    );
  });

  it("obična operacija (withoutProcess != true) bez reda u routingu i dalje pada 422", async () => {
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: false });
    prisma.workOrderOperation.findFirst.mockResolvedValue(null); // nije u routingu

    await expect(
      service.scan({
        orderBarcode: "RNZ:2597:06/93-4:1:A",
        operationBarcode: "S:10:0102:0:A",
        pieceCount: 3,
      }),
    ).rejects.toThrow("nije u tehnološkom postupku RN 06/93-4");

    expect(prisma.techProcess.create).not.toHaveBeenCalled();
  });
});

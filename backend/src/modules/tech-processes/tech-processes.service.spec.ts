import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { ScopeService } from "../../common/authz/scope.service";
import { NotificationsService } from "../notifications/notifications.service";
import { LabelPrintService } from "../../common/printing/label-print.service";
import { QualityService } from "../kvalitet/kvalitet.service";
import { WorkOrdersService } from "../work-orders/work-orders.service";
import { TechProcessesService } from "./tech-processes.service";
import { validateStopWork } from "./dto/stop-work.dto";

/** Mock PrismaService — modeli koje dodiruju `card()`, `scan()` i D8 emit helperi. */
function prismaMock() {
  const m = {
    techProcess: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      // finish()/reopen(): učitavanje jednog reda po id.
      findUnique: jest.fn().mockResolvedValue(null),
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
      // reopen(): skidanje „RN završen" ako je bio postavljen.
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    workOrderOperation: {
      findFirst: jest.fn().mockResolvedValue(null),
      // card(): routing tekućeg RN-a (SVE operacije postupka, i neotkucane).
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // control(): knjiženje lokacija iskontrolisanih delova (part_locations).
    position: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    partLocation: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    // control(): buildLabelData (RN → predmet → komitent).
    project: { findUnique: jest.fn().mockResolvedValue(null) },
    customer: { findUnique: jest.fn().mockResolvedValue(null) },
    // openForWorker: otvorene sesije radnika + svež users.worker_id fallback.
    // stopWorkById: nalaženje/zatvaranje moje otvorene sesije (findFirst/update).
    workTimeEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      create: jest.fn(),
      // Deljeni red (22.07): higijena sesija pri gašenju + dismiss zatvaranje svojih.
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      // openForWorker: othersOpenCount po redu (tuđe otvorene sesije).
      groupBy: jest.fn().mockResolvedValue([]),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    // dismissEntry: audit snapshot pre zatvaranja reda.
    auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    drawingHandover: { findUnique: jest.fn().mockResolvedValue(null) },
    handoverDraftItem: { findFirst: jest.fn().mockResolvedValue(null) },
    handoverDraft: { findUnique: jest.fn().mockResolvedValue(null) },
    // card().drawing: crtež po (drawingNumber, revision) + hasPdf iz drawing_pdfs.
    drawing: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    drawingPdf: { findFirst: jest.fn().mockResolvedValue(null) },
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

/** Mock QualityService — K2 auto-draft (control() dorada/škart). Best-effort, ne baca. */
function qualityMock() {
  return { createDraftFromControl: jest.fn().mockResolvedValue(undefined) };
}

/**
 * Mock WorkOrdersService — A3 child RN (-D/-S) hook. Default: uspeh
 * (`createQualityChildOrder` vrati { id, identNumber }); testovi po potrebi
 * `mockRejectedValue` da provere pending granu (childOrderPending=true).
 */
function workOrdersMock() {
  return {
    createQualityChildOrder: jest
      .fn()
      .mockResolvedValue({ id: 5001, identNumber: "06/93-4-D1" }),
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
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

  it("vraća routing tekućeg RN-a (SVE operacije postupka, i neotkucane); orphan RC → naziv null", async () => {
    // Samo OP10 ima kucanje; routing ima i OP20/OP30 bez kucanja (prazne u UI).
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ operationNumber: 10, workCenterCode: "0102", pieceCount: 5 }),
    ]);
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      drawingHandoverId: 0,
    });
    prisma.workOrderOperation.findMany.mockResolvedValue([
      { operationNumber: 10, workCenterCode: "0102" },
      { operationNumber: 20, workCenterCode: "0205" },
      { operationNumber: 30, workCenterCode: "8.5" }, // namerno nerazrešen RC
    ]);
    prisma.operation.findMany.mockResolvedValue([
      { workCenterCode: "0102", workCenterName: "Glodalica", workUnitCode: "01" },
      { workCenterCode: "0205", workCenterName: "Strug", workUnitCode: "02" },
    ]);

    const { data } = await service.card(CARD_QUERY);

    expect(data.routing).toEqual([
      { operationNumber: 10, workCenterCode: "0102", workCenterName: "Glodalica" },
      { operationNumber: 20, workCenterCode: "0205", workCenterName: "Strug" },
      { operationNumber: 30, workCenterCode: "8.5", workCenterName: null },
    ]);
    // Routing se traži po id-ju tekućeg RN-a, sortiran po broju operacije.
    expect(prisma.workOrderOperation.findMany).toHaveBeenCalledWith(
      containing({
        where: { workOrderId: 900 },
        orderBy: { operationNumber: "asc" },
      }),
    );
    // Postojeći agregati (rows/operations) i dalje rade — routing ih ne dira.
    expect(data.operations).toHaveLength(1);
    expect(data.operations[0].pieces.total).toBe(5);
  });

  it("routing je prazan kad RN za trojku ne postoji (workOrder.findFirst = null)", async () => {
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ operationNumber: 10, workCenterCode: "0102", pieceCount: 3 }),
    ]);
    // workOrder.findFirst nije mock-ovan → null; routing lookup se preskače.

    const { data } = await service.card(CARD_QUERY);

    expect(data.routing).toEqual([]);
    expect(prisma.workOrderOperation.findMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------- card().drawing (#6)

  it("drawing: crtež (tačna revizija = najviša) + PDF → nije zastareo (revisionStale=false)", async () => {
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ operationNumber: 10, workCenterCode: "0102", pieceCount: 3 }),
    ]);
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      drawingHandoverId: 0,
      drawingNumber: "CRT-1",
      revision: "A",
    });
    // Najviša revizija (findFirst orderBy desc) i tačna revizija su ista → RN na najvišoj.
    prisma.drawing.findFirst.mockResolvedValue({
      id: 42,
      drawingNumber: "CRT-1",
      revision: "A",
    });
    prisma.drawingPdf.findFirst.mockResolvedValue({ drawingNumber: "CRT-1" });

    const { data } = await service.card(CARD_QUERY);

    expect(data.drawing).toEqual({
      id: 42,
      hasPdf: true,
      revision: "A",
      latestRevision: "A",
      revisionStale: false,
    });
    // Tačna (drawingNumber, revision) sa RN-a je jedan od upita (drugi je najviša revizija).
    expect(prisma.drawing.findFirst).toHaveBeenCalledWith(
      containing({ where: containing({ drawingNumber: "CRT-1", revision: "A" }) }),
    );
  });

  it("drawing: crtež postoji, PDF ne (pdf_binary NULL) → { id, hasPdf: false }", async () => {
    prisma.techProcess.findMany.mockResolvedValue([tpRow({ pieceCount: 3 })]);
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      drawingHandoverId: 0,
      drawingNumber: "CRT-1",
      revision: "A",
    });
    prisma.drawing.findFirst.mockResolvedValue({
      id: 42,
      drawingNumber: "CRT-1",
      revision: "A",
    });
    prisma.drawingPdf.findFirst.mockResolvedValue(null);

    const { data } = await service.card(CARD_QUERY);

    expect(data.drawing).toEqual({
      id: 42,
      hasPdf: false,
      revision: "A",
      latestRevision: "A",
      revisionStale: false,
    });
    // hasPdf filtrira na pdf_binary NOT NULL i NE učitava sam binarni sadržaj.
    const pdfArg = prisma.drawingPdf.findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(pdfArg.where.pdfBinary).toEqual({ not: null });
    expect(pdfArg.select).not.toHaveProperty("pdfBinary");
  });

  it("drawing: RN na starijoj reviziji od najviše u bazi → fallback na najvišu + revisionStale=true", async () => {
    prisma.techProcess.findMany.mockResolvedValue([tpRow({ pieceCount: 3 })]);
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      drawingHandoverId: 0,
      drawingNumber: "CRT-1",
      revision: "A", // RN na "A"; najviša u bazi je "B" — tačna "A" nema reda
    });
    // Nov redosled upita: PRVO najviša revizija (orderBy desc), PA tačna (broj+revizija).
    prisma.drawing.findFirst
      .mockResolvedValueOnce({ id: 42, drawingNumber: "CRT-1", revision: "B" }) // najviša
      .mockResolvedValueOnce(null); // tačan (CRT-1, A) nema reda
    prisma.drawingPdf.findFirst.mockResolvedValue({ drawingNumber: "CRT-1" });

    const { data } = await service.card(CARD_QUERY);

    // RN je na "A", najviša u bazi je "B" → zastarelo (UPOZORENJE, ne blokira rad).
    expect(data.drawing).toEqual({
      id: 42,
      hasPdf: true,
      revision: "A",
      latestRevision: "B",
      revisionStale: true,
    });
    // Najviša revizija se traži PRVA, sortirano po reviziji opadajuće.
    const latestArg = prisma.drawing.findFirst.mock.calls[0][0] as {
      orderBy: unknown;
    };
    expect(latestArg.orderBy).toEqual({ revision: "desc" });
    // hasPdf koristi reviziju NAĐENOG (fallback) reda (B).
    const pdfArg = prisma.drawingPdf.findFirst.mock.calls[0][0] as {
      where: { revision: string };
    };
    expect(pdfArg.where.revision).toBe("B");
  });

  it("drawing: null kad crtež ne postoji (ni tačna ni najviša revizija)", async () => {
    prisma.techProcess.findMany.mockResolvedValue([tpRow({ pieceCount: 3 })]);
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      drawingHandoverId: 0,
      drawingNumber: "CRT-1",
      revision: "A",
    });
    prisma.drawing.findFirst.mockResolvedValue(null); // ni exact ni fallback

    const { data } = await service.card(CARD_QUERY);

    expect(data.drawing).toBeNull();
    expect(prisma.drawingPdf.findFirst).not.toHaveBeenCalled();
  });

  it("drawing: null kad RN za trojku ne postoji (nema broja crteža)", async () => {
    prisma.techProcess.findMany.mockResolvedValue([tpRow({ pieceCount: 3 })]);
    // workOrder.findFirst nije mock-ovan → null → nema RN → nema crteža.

    const { data } = await service.card(CARD_QUERY);

    expect(data.drawing).toBeNull();
    expect(prisma.drawing.findFirst).not.toHaveBeenCalled();
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
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

// ================================================================== A1 TVRDI guard kucanja preko plana

describe("TechProcessesService — A1 TVRDI guard kucanja preko plana (scan/stopWork)", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;

  /** RN plan 5 (uzrok: OP45 6/5 prošao pre guarda). */
  const WO = {
    id: 900,
    projectId: 2597,
    identNumber: "06/93-4",
    variant: 0,
    pieceCount: 5,
    revision: "A",
  };

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        TechProcessesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ScopeService,
          useValue: {
            isEnforced: jest.fn().mockReturnValue(false),
            workerMachineViolation: jest.fn().mockResolvedValue(null),
            checkMachineAccess: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: NotificationsService, useValue: notificationsMock() },
        { provide: LabelPrintService, useValue: { printRawTspl: jest.fn() } },
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.workOrder.findFirst.mockResolvedValue(WO);
    // Radnik sa kartice (stopWork traži karticu; scan je opciona).
    prisma.worker.findFirst.mockResolvedValue({
      id: 10,
      fullName: "Milan Radnik",
      username: "milan",
      workerTypeId: 3,
    });
    // Otvoren red operacije sa 4 već otkucana komada (findOrOpenRoutingTp → existing).
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({ id: 700, pieceCount: 4, operationNumber: 45, workCenterCode: "0102" }),
    );
  });

  it("scan preko plana (4+2=6 > 5) → 422, red se ne ažurira", async () => {
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 4 } });

    await expect(
      service.scan({
        orderBarcode: "RNZ:2597:06/93-4:0:A",
        operationBarcode: "S:45:0102:0:A",
        pieceCount: 2,
      }),
    ).rejects.toThrow("kucanje preko plana nije dozvoljeno");
    expect(prisma.techProcess.update).not.toHaveBeenCalled();
  });

  it("scan do plana (4+1=5 = 5) prolazi i zatvara operaciju", async () => {
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 4 } });
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 700, pieceCount: 5, isProcessFinished: true, operationNumber: 45 }),
    );

    const { data } = await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:0:A",
      operationBarcode: "S:45:0102:0:A",
      pieceCount: 1,
    });

    expect(data.operationFinished).toBe(true);
    expect(prisma.techProcess.update).toHaveBeenCalled();
  });

  it("scan bez plana (OPŠTI NALOG withoutProcess) preskače guard i prolazi preko", async () => {
    // withoutProcess → guard se preskače iako plan nije poznat na toj operaciji.
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: true });
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 99 } });
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 700, pieceCount: 199, operationNumber: 45 }),
    );

    const { data } = await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:0:A",
      operationBarcode: "S:45:0102:0:A",
      pieceCount: 100,
    });

    expect(data.techProcess.pieceCount).toBe(199);
    expect(prisma.techProcess.update).toHaveBeenCalled();
  });

  it("stopWork preko plana (4+2=6 > 5) → 422, red se ne akumulira", async () => {
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 4 } });

    await expect(
      service.stopWork({
        orderBarcode: "RNZ:2597:06/93-4:0:A",
        operationBarcode: "S:45:0102:0:A",
        workerCard: "CARD10",
        pieceCount: 2,
      }),
    ).rejects.toThrow("kucanje preko plana nije dozvoljeno");
    expect(prisma.techProcess.update).not.toHaveBeenCalled();
  });

  it("stopWork sa 0 komada (borverk, samo vreme) prolazi i preko plana", async () => {
    // 0 kom → guard preskače (samo vreme se evidentira).
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 5 } });
    prisma.workTimeEntry.create.mockResolvedValue({
      id: 1,
      startedAt: new Date(),
    });
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 700, pieceCount: 4, operationNumber: 45 }),
    );

    const { data } = await service.stopWork({
      orderBarcode: "RNZ:2597:06/93-4:0:A",
      operationBarcode: "S:45:0102:0:A",
      workerCard: "CARD10",
      pieceCount: 0,
    });

    expect(data.reportedPieces).toBe(0);
    expect(prisma.techProcess.update).toHaveBeenCalled();
  });
});

// ============================================== BUG-P1-01 Faza 1: atomska akumulacija (lost update)

describe("TechProcessesService — BUG-P1-01 atomska akumulacija komada ({ increment })", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;

  /** RN plan 10 (deljen red operacije — konkurentne prijave realne). */
  const WO = {
    id: 900,
    projectId: 2597,
    identNumber: "06/93-4",
    variant: 0,
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.workOrder.findFirst.mockResolvedValue(WO);
  });

  it("scan: update piše pieceCount kao { increment: n }, NE apsolutnu vrednost", async () => {
    // Otvoren red sa 3 komada; aggregate (guard) vraća 3 → 3+2=5 <= 10 prolazi.
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({ id: 700, pieceCount: 3, operationNumber: 10, workCenterCode: "0102" }),
    );
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 3 } });
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 700, pieceCount: 5 }),
    );

    await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:0:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 2,
    });

    // DOKAZ atomskog inkrementa: data.pieceCount je { increment: 2 }, ne 5.
    const updArg = prisma.techProcess.update.mock.calls[0][0] as {
      data: { pieceCount: unknown };
    };
    expect(updArg.data.pieceCount).toEqual({ increment: 2 });
  });

  it("scan: reachedPlan/zatvaranje se donosi iz VRAĆENE vrednosti update-a (updated.pieceCount)", async () => {
    // Red 8 kom; prijava 2 → post-inkrement 10 = plan. VRAĆENA vrednost (10) diktira
    // zatvaranje; drugi update postavlja isProcessFinished (u istoj transakciji).
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({ id: 700, pieceCount: 8, operationNumber: 10, workCenterCode: "0102" }),
    );
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 8 } });
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 700, pieceCount: 10, isProcessFinished: true }),
    );

    const { data } = await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:0:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 2,
    });

    expect(data.operationFinished).toBe(true);
    // Prvi update = atomski increment (bez isProcessFinished); drugi = zatvaranje.
    const incArg = prisma.techProcess.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(incArg.data.pieceCount).toEqual({ increment: 2 });
    expect(incArg.data.isProcessFinished).toBeUndefined();
    const finArg = prisma.techProcess.update.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect(finArg.data.isProcessFinished).toBe(true);
    expect(finArg.data.finishedAt).toBeInstanceOf(Date);
  });

  it("dve UZASTOPNE prijave na istom redu ne gube komade (increment je aditivan)", async () => {
    // Stateful mock: red čuva stvarno stanje; update primenjuje { increment }.
    // Da je akumulacija bila apsolutna (tp.pieceCount + n čitan iz starog snapshot-a),
    // druga prijava bi pregazila prvu. Sa { increment } stanje se sabira: 0→2→5.
    const row = tpRow({ id: 700, pieceCount: 0, operationNumber: 10, workCenterCode: "0102" });
    prisma.techProcess.findFirst.mockImplementation(() =>
      Promise.resolve({ ...row }),
    );
    prisma.techProcess.aggregate.mockImplementation(() =>
      Promise.resolve({ _sum: { pieceCount: row.pieceCount } }),
    );
    prisma.techProcess.update.mockImplementation((args: unknown) => {
      const a = args as { data: { pieceCount?: { increment: number } } };
      if (a.data.pieceCount?.increment !== undefined)
        row.pieceCount += a.data.pieceCount.increment;
      return Promise.resolve({ ...row });
    });

    await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:0:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 2,
    });
    const second = await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:0:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 3,
    });

    // 0 + 2 + 3 = 5 — nijedna prijava nije izgubljena.
    expect(row.pieceCount).toBe(5);
    expect(second.data.techProcess.pieceCount).toBe(5);
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
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

  it("zahtev 015/26: deljeni/opšti nalog — nemam svoju sesiju a DRUGI radnik radi → red se NE prikazuje", async () => {
    // A (74) je kreator/vlasnik reda (opšti nalog RN 4698), ali je „Kraj rada —
    // samo moj rad" zatvorio SVOJU sesiju; radnik 33 i dalje radi → red ostaje
    // globalno otvoren, ali NE sme više da bude u „Moji otvoreni" radnika 74
    // (ranije je ostajao zbog `tech_processes.worker_id == 74`).
    prisma.workTimeEntry.findMany.mockResolvedValue([]); // 74 nema otvorenu sesiju
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ id: 4698, workerId: 74 }),
    ]);
    prisma.workTimeEntry.groupBy.mockResolvedValue([
      { techProcessId: 4698, workerId: 33 }, // drugi radnik i dalje radi
    ]);

    const { data } = await service.openForWorker("CARD74", undefined);

    expect(data).toHaveLength(0);
  });

  it("zahtev 015/26: deljeni nalog — imam SVOJU otvorenu sesiju uz druge → red OSTAJE (othersOpenCount>0)", async () => {
    // Aktivno radim: red se prikazuje uz badge „+N radi" (izbor „samo moj / za sve").
    prisma.workTimeEntry.findMany.mockResolvedValue([{ techProcessId: 4698 }]);
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ id: 4698, workerId: 74 }),
    ]);
    prisma.workTimeEntry.groupBy.mockResolvedValue([
      { techProcessId: 4698, workerId: 33 },
      { techProcessId: 4698, workerId: 44 },
    ]);

    const { data } = await service.openForWorker("CARD74", undefined);

    expect(data).toHaveLength(1);
    expect(data[0].hasOpenSession).toBe(true);
    expect(data[0].othersOpenCount).toBe(2);
  });

  it("zahtev 015/26: filtrira SAMO deljeni red — moj solo red (bez tuđih sesija) ostaje (običan nalog netaknut)", async () => {
    // 100 = moj solo red bez tuđih sesija (jednosken/ispod-plana — vlasništvo);
    // 200 = deljeni red na kome radnik 33 radi, ja bez sesije. 100 ostaje, 200 ispada.
    prisma.workTimeEntry.findMany.mockResolvedValue([]); // 74 nema nijednu otvorenu
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ id: 100, workerId: 74 }),
      tpRow({ id: 200, workerId: 74 }),
    ]);
    prisma.workTimeEntry.groupBy.mockResolvedValue([
      { techProcessId: 200, workerId: 33 },
    ]);

    const { data } = await service.openForWorker("CARD74", undefined);

    expect(data.map((r) => r.id)).toEqual([100]);
    expect(data[0].hasOpenSession).toBe(false);
  });

  it("red nosi drawing { id, hasPdf, revizioni status } sa RN-a (reuse resolveCardDrawing)", async () => {
    prisma.workTimeEntry.findMany.mockResolvedValue([]);
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({
        id: 500,
        workerId: 74,
        projectId: 2597,
        identNumber: "06/93-4",
        variant: 0,
      }),
    ]);
    // RN za trojku nosi (drawingNumber, revision) — čita ga resolveDrawingByTriple.
    prisma.workOrder.findMany.mockResolvedValue([
      {
        projectId: 2597,
        identNumber: "06/93-4",
        variant: 0,
        drawingNumber: "CRT-1",
        revision: "A",
        pieceCount: 10,
      },
    ]);
    prisma.drawing.findFirst.mockResolvedValue({
      id: 42,
      drawingNumber: "CRT-1",
      revision: "A",
    });
    prisma.drawingPdf.findFirst.mockResolvedValue({ drawingNumber: "CRT-1" });

    const { data } = await service.openForWorker("CARD74", undefined);

    expect(data).toHaveLength(1);
    expect(data[0].drawing).toEqual({
      id: 42,
      hasPdf: true,
      revision: "A",
      latestRevision: "A",
      revisionStale: false,
    });
  });

  it("drawing je null kad RN/crtež za trojku ne postoji", async () => {
    prisma.workTimeEntry.findMany.mockResolvedValue([]);
    prisma.techProcess.findMany.mockResolvedValue([tpRow({ workerId: 74 })]);
    // workOrder.findMany default [] → nema (drawingNumber, revision) → drawing null.

    const { data } = await service.openForWorker("CARD74", undefined);

    expect(data[0].drawing).toBeNull();
    expect(prisma.drawing.findFirst).not.toHaveBeenCalled();
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
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
    // BUG-P1-01 Faza 1: akumulacija je sada ATOMSKA — update piše
    // `pieceCount: { increment: 40 }` (ne apsolutnu vrednost 50). Odluka o
    // zatvaranju (`isProcessFinished`) i dalje dolazi iz kumulativnog SUM-a.
    const updateArg = prisma.techProcess.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.pieceCount).toEqual({ increment: 40 });
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

// ================================================ Q4 (BUG-P1-02): razdvajanje kontrole po kvalitetu

describe("TechProcessesService — Q4 control razdvaja redove po kvalitetu (BUG-P1-02)", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;

  // RN plan 10 kom; 8 DOBAR + 2 ŠKART = 10 → plan pun preko SVIH kvaliteta.
  const WO = {
    id: 900,
    projectId: 2597,
    identNumber: "06/93-4",
    variant: 0,
    partName: "Osovina",
    drawingNumber: "CRT-1",
    pieceCount: 10,
    productionDeadline: null,
    handoverStatusId: 0,
    status: false,
    revision: "A",
    material: "C45",
  };

  const DTO = {
    orderBarcode: "RNZ:2597:06/93-4:0:A",
    operationBarcode: "S:60:8.5:0:A",
    workerCard: "CTRL1",
    locations: [{ positionId: 1, quantity: 1 }],
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.worker.findFirst.mockResolvedValue({
      id: 88,
      fullName: "Pera Kontrolor",
      username: "pera",
      workerTypeId: 5,
    });
    prisma.workerType.findUnique.mockResolvedValue({
      additionalPrivileges: true,
    });
    prisma.workOrder.findFirst.mockResolvedValue(WO);
    prisma.workOrder.findUnique.mockResolvedValue(WO);
    prisma.operation.findUnique.mockResolvedValue({
      significantForFinishing: true,
      workCenterName: "Ravno brušenje",
    });
    prisma.workOrderOperation.findFirst.mockResolvedValue({ id: 1 });
    prisma.techProcess.updateMany.mockResolvedValue({ count: 0 });
    prisma.workOrderOperation.updateMany.mockResolvedValue({ count: 0 });
    // Culprit predlog (K2) — nebitno za ovaj describe, ali findMany se poziva.
    prisma.techProcess.findMany.mockResolvedValue([]);
  });

  /**
   * Simulira bazu sa najviše jednim OTVORENIM redom po kvalitetu: `existingOpen`
   * findFirst vraća red SAMO ako `where.qualityTypeId` odgovara nekom od zadatih
   * otvorenih redova. Dokaz da Q4 filter po kvalitetu bira pravi red (ili nijedan).
   */
  function mockOpenByQuality(open: Record<number, ReturnType<typeof tpRow>>) {
    prisma.techProcess.findFirst.mockImplementation((args: unknown) => {
      const where = (args as { where?: { qualityTypeId?: number } }).where ?? {};
      const q = where.qualityTypeId;
      return Promise.resolve(
        typeof q === "number" && open[q] ? open[q] : null,
      );
    });
  }

  it("8 DOBAR pa 2 ŠKART: dobar red ostaje 8/quality=0, škart ide u NOV red 2/quality=2 (nema prepisa)", async () => {
    // Baza: dobar red (id 700, 8 kom, quality 0) već otvoren; škart reda NEMA.
    const goodRow = tpRow({
      id: 700,
      pieceCount: 8,
      qualityTypeId: 0,
      isProcessFinished: false,
      operationNumber: 60,
      workCenterCode: "8.5",
      workOrderId: 900,
    });
    mockOpenByQuality({ 0: goodRow });
    // Kumulativ SVIH kvaliteta = 8; +2 škart = 10 = plan → reachedPlan.
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 8 } });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({
        id: 701,
        pieceCount: 2,
        qualityTypeId: 2,
        isProcessFinished: true,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
      }),
    );

    const { data } = await service.control({
      ...DTO,
      qualityTypeId: 2,
      pieceCount: 2,
      locations: [{ positionId: 1, quantity: 2 }],
    });

    // existingOpen je tražen filtrirano po qualityTypeId=2 (Q4 filter).
    const findArg = prisma.techProcess.findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(findArg.where.qualityTypeId).toBe(2);

    // Škart NIJE našao otvoren red tog kvaliteta → KREIRA nov red (quality 2).
    expect(prisma.techProcess.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.techProcess.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.qualityTypeId).toBe(2);
    expect(createArg.data.pieceCount).toBe(2);
    // Dobar red se NE dira update-om (nije prepisan škartom).
    expect(prisma.techProcess.update).not.toHaveBeenCalled();

    // Plan (svi kvaliteti) dostignut 8+2=10 → operacija zatvorena.
    expect(data.controlledCumulative).toBe(10);
    expect(data.operationFinished).toBe(true);
    expect(data.qualityTypeId).toBe(2);
  });

  it("obrnut redosled — 2 ŠKART pa 8 DOBAR: dobar ide u NOV red, škart red netaknut", async () => {
    // Baza: škart red (id 710, 2 kom, quality 2) otvoren; dobrog reda NEMA.
    const scrapRow = tpRow({
      id: 710,
      pieceCount: 2,
      qualityTypeId: 2,
      isProcessFinished: false,
      operationNumber: 60,
      workCenterCode: "8.5",
      workOrderId: 900,
    });
    mockOpenByQuality({ 2: scrapRow });
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 2 } });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({
        id: 711,
        pieceCount: 8,
        qualityTypeId: 0,
        isProcessFinished: true,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
      }),
    );

    const { data } = await service.control({
      ...DTO,
      qualityTypeId: 0,
      pieceCount: 8,
      locations: [{ positionId: 1, quantity: 8 }],
    });

    const findArg = prisma.techProcess.findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(findArg.where.qualityTypeId).toBe(0);

    // Dobar NIJE našao otvoren red kvaliteta 0 → KREIRA nov red (quality 0).
    expect(prisma.techProcess.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.techProcess.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.qualityTypeId).toBe(0);
    expect(createArg.data.pieceCount).toBe(8);
    // Škart red se NE prepisuje dobrim.
    expect(prisma.techProcess.update).not.toHaveBeenCalled();

    expect(data.controlledCumulative).toBe(10);
    expect(data.operationFinished).toBe(true);
    expect(data.qualityTypeId).toBe(0);
  });

  it("ista kvaliteta dvaput (5 ŠKART pa još 3 ŠKART): AKUMULIRA na isti red, NE pravi drugi", async () => {
    const scrapRow = tpRow({
      id: 720,
      pieceCount: 5,
      qualityTypeId: 2,
      isProcessFinished: false,
      operationNumber: 60,
      workCenterCode: "8.5",
      workOrderId: 900,
    });
    mockOpenByQuality({ 2: scrapRow });
    // Kumulativ svih = 5; +3 = 8 < plan 10 → parcijala, ostaje otvoren.
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 5 } });
    prisma.techProcess.update.mockResolvedValue(
      tpRow({
        id: 720,
        pieceCount: 8,
        qualityTypeId: 2,
        isProcessFinished: false,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
      }),
    );

    const { data } = await service.control({
      ...DTO,
      qualityTypeId: 2,
      pieceCount: 3,
      locations: [{ positionId: 1, quantity: 3 }],
    });

    // Našao otvoren red ISTOG kvaliteta → UPDATE (increment), bez create.
    expect(prisma.techProcess.create).not.toHaveBeenCalled();
    expect(prisma.techProcess.update).toHaveBeenCalledTimes(1);
    const updateArg = prisma.techProcess.update.mock.calls[0][0] as {
      where: { id: number };
      data: Record<string, unknown>;
    };
    expect(updateArg.where.id).toBe(720);
    // Atomski increment (BUG-P1-01), ne apsolutna vrednost.
    expect(updateArg.data.pieceCount).toEqual({ increment: 3 });
    // Ispod plana → red ostaje otvoren.
    expect(updateArg.data.isProcessFinished).toBeUndefined();
    expect(data.controlledCumulative).toBe(8);
    expect(data.operationFinished).toBe(false);
  });

  it("reachedPlan iz kumulativa SVIH redova: 2 DOBAR uz postojećih 8 (bilo kog kvaliteta) → zatvara na 10", async () => {
    // Dobrog otvorenog reda NEMA (npr. prethodnih 8 su bili škart/dorada) → nov red;
    // ali kumulativ svih kvaliteta = 8 pa +2 = plan → operacija se svejedno zatvara.
    mockOpenByQuality({});
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 8 } });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({
        id: 730,
        pieceCount: 2,
        qualityTypeId: 0,
        isProcessFinished: true,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
      }),
    );

    const { data } = await service.control({
      ...DTO,
      qualityTypeId: 0,
      pieceCount: 2,
      locations: [{ positionId: 1, quantity: 2 }],
    });

    expect(data.controlledCumulative).toBe(10);
    expect(data.operationFinished).toBe(true);
    const createArg = prisma.techProcess.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArg.data.isProcessFinished).toBe(true);
  });

  /**
   * Q4 REGRESIJA (verifikator 16.07): kad razdvajanje po kvalitetu ostavi raniji
   * otvoren red (8 DOBAR, quality 0) a plan se dostigne DRUGIM kvalitetom (2 ŠKART),
   * pri dostizanju plana OVA (značajna) kontrolna operacija mora zatvoriti i taj
   * raniji red — inače `markWorkOrderIfComplete` (traži da SVI značajni redovi budu
   * finished) vraća false i RN se NIKAD ne zavede kao „Završen". Ovaj test dokazuje
   * da (a) postoji updateMany koji zatvara preostale otvorene redove ISTE operacije
   * bez obzira na kvalitet i (b) da je `workOrderCompleted=true`.
   */
  it("8 DOBAR (otvoren) pa 2 ŠKART = plan: zatvara raniji dobar red iste operacije i zavodi RN kao Završen", async () => {
    const goodRow = tpRow({
      id: 700,
      pieceCount: 8,
      qualityTypeId: 0,
      isProcessFinished: false,
      operationNumber: 60,
      workCenterCode: "8.5",
      workOrderId: 900,
    });
    mockOpenByQuality({ 0: goodRow });
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 8 } });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({
        id: 701,
        pieceCount: 2,
        qualityTypeId: 2,
        isProcessFinished: true,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
      }),
    );
    // 8.5 je značajna kontrolna operacija (i za `significant` u control() i za
    // `markWorkOrderIfComplete`).
    prisma.operation.findMany.mockResolvedValue([{ workCenterCode: "8.5" }]);
    // Stanje redova POSLE popravke: raniji dobar red je zatvoren novim updateMany-jem,
    // pa `markWorkOrderIfComplete` vidi SVE značajne redove finished, kumulativ 8+2=10=plan.
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({
        id: 700,
        pieceCount: 8,
        qualityTypeId: 0,
        isProcessFinished: true,
        operationNumber: 60,
        workCenterCode: "8.5",
      }),
      tpRow({
        id: 701,
        pieceCount: 2,
        qualityTypeId: 2,
        isProcessFinished: true,
        operationNumber: 60,
        workCenterCode: "8.5",
      }),
    ]);

    const { data } = await service.control({
      ...DTO,
      qualityTypeId: 2,
      pieceCount: 2,
      locations: [{ positionId: 1, quantity: 2 }],
    });

    expect(data.operationFinished).toBe(true);
    // KLJUČNA regresija: RN je zaveden kao „Završen".
    expect(data.workOrderCompleted).toBe(true);
    expect(prisma.workOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 900 },
        data: { status: true },
      }),
    );

    // Postoji updateMany koji cilja SVE otvorene redove ISTE operacije (svi kvaliteti,
    // bez qualityTypeId filtera) da zatvori raniji dobar red.
    const opScopedClose = prisma.techProcess.updateMany.mock.calls.find(
      (c) => {
        const where = (c[0] as { where?: Record<string, unknown> }).where ?? {};
        return (
          where.operationNumber === 60 &&
          where.workCenterCode === "8.5" &&
          where.qualityTypeId === undefined &&
          (where.isProcessFinished as { not?: boolean } | undefined)?.not ===
            true
        );
      },
    );
    expect(opScopedClose).toBeDefined();
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
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

  it("withoutProcess sa SVIM zatvorenim redovima: otvara NOV red (istorija se preskače, ne 422)", async () => {
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: true });
    // Opšti nalog: svi redovi su is_process_finished=true (legacy) — findRoutingTp
    // vraća zatvoren red, koji se za withoutProcess tretira kao istorija.
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({
        id: 400,
        variant: 1,
        isProcessFinished: true,
        finishedAt: new Date("2026-07-01T10:00:00Z"),
        workOrderId: 900,
      }),
    );
    prisma.techProcess.create.mockResolvedValue(
      tpRow({
        id: 555,
        variant: 1,
        pieceCount: 0,
        isProcessFinished: false,
        workOrderId: 900,
      }),
    );
    prisma.techProcess.update.mockResolvedValue(
      tpRow({
        id: 555,
        variant: 1,
        pieceCount: 3,
        isProcessFinished: false,
        workOrderId: 900,
      }),
    );

    const { data } = await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:1:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 3,
    });

    expect(prisma.techProcess.create).toHaveBeenCalled(); // nov otvoren red
    expect(prisma.workOrderOperation.findFirst).not.toHaveBeenCalled();
    expect(data.techProcess.id).toBe(555);
  });

  it("withoutProcess sa OTVORENIM redom: koristi njega (bez novog reda)", async () => {
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: true });
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({
        id: 401,
        variant: 1,
        pieceCount: 2,
        isProcessFinished: false,
        workOrderId: 900,
      }),
    );
    prisma.techProcess.update.mockResolvedValue(
      tpRow({
        id: 401,
        variant: 1,
        pieceCount: 5,
        isProcessFinished: false,
        workOrderId: 900,
      }),
    );

    const { data } = await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:1:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 3,
    });

    expect(prisma.techProcess.create).not.toHaveBeenCalled();
    expect(data.techProcess.id).toBe(401);
  });

  it("obična operacija SVI redovi zatvoreni + kumulativ >= plan: i dalje 422 (već zatvorena)", async () => {
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: false });
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({
        id: 402,
        variant: 1,
        isProcessFinished: true,
        finishedAt: new Date("2026-07-01T10:00:00Z"),
        workOrderId: 900,
      }),
    );
    // Kumulativ (svi redovi te operacije) == plan (GEN_WO.pieceCount=10) → gotovo.
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 10 } });

    await expect(
      service.scan({
        orderBarcode: "RNZ:2597:06/93-4:1:A",
        operationBarcode: "S:10:0102:0:A",
        pieceCount: 3,
      }),
    ).rejects.toThrow("već zatvorena");

    expect(prisma.techProcess.create).not.toHaveBeenCalled();
  });

  it("FIX A: obična operacija SVI redovi zatvoreni + kumulativ < plan → NOV red (ne 422)", async () => {
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: false });
    // Zatvoren red, ali kumulativ ispod plana → operacija je i dalje RADNA.
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({
        id: 403,
        variant: 1,
        operationNumber: 10,
        isProcessFinished: true,
        finishedAt: new Date("2026-07-01T10:00:00Z"),
        workOrderId: 900,
      }),
    );
    // Kumulativ 4 < plan 10 → belowPlan → otvara se NOV red.
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 4 } });
    // BUG-P1-05 (Q2): belowPlan sada proverava da operacija JOŠ postoji u routingu.
    // Ovde postoji → nov red se kreira (postojeće ponašanje očuvano).
    prisma.workOrderOperation.findFirst.mockResolvedValue({ operationNumber: 10 });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({
        id: 556,
        variant: 1,
        operationNumber: 10,
        pieceCount: 0,
        isProcessFinished: false,
        workOrderId: 900,
      }),
    );
    prisma.techProcess.update.mockResolvedValue(
      tpRow({
        id: 556,
        variant: 1,
        operationNumber: 10,
        pieceCount: 3,
        isProcessFinished: false,
        workOrderId: 900,
      }),
    );

    const { data } = await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:1:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 3,
    });

    // Nov otvoren red; routing lookup JESTE pozvan (belowPlan guard) i našao je red.
    expect(prisma.techProcess.create).toHaveBeenCalled();
    expect(prisma.workOrderOperation.findFirst).toHaveBeenCalled();
    expect(data.techProcess.id).toBe(556);
  });

  it("BUG-P1-05 (Q2): belowPlan a operacija VIŠE nije u routingu → 422, NE kreira red", async () => {
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: false });
    // Zatvoren red ispod plana → belowPlan grana; ali operacija je naknadno
    // izbačena iz tehnološkog postupka (fantom-red scenario, 137 slučajeva).
    prisma.techProcess.findFirst.mockResolvedValue(
      tpRow({
        id: 404,
        variant: 1,
        operationNumber: 10,
        isProcessFinished: true,
        finishedAt: new Date("2026-07-01T10:00:00Z"),
        workOrderId: 900,
      }),
    );
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 4 } });
    // Routing lookup vraća null → operacija više nije u postupku.
    prisma.workOrderOperation.findFirst.mockResolvedValue(null);

    await expect(
      service.scan({
        orderBarcode: "RNZ:2597:06/93-4:1:A",
        operationBarcode: "S:10:0102:0:A",
        pieceCount: 3,
      }),
    ).rejects.toThrow("više nije u tehnološkom postupku");

    expect(prisma.workOrderOperation.findFirst).toHaveBeenCalled();
    expect(prisma.techProcess.create).not.toHaveBeenCalled();
  });

  it("finish() na withoutProcess RC → 422 (se ne zatvara, uvek otvoren)", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({ id: 700, workCenterCode: "0102", isProcessFinished: false }),
    );
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: true });

    await expect(service.finish(700)).rejects.toThrow("se ne zatvara");
    expect(prisma.techProcess.update).not.toHaveBeenCalled();
  });
});

// ============================================================ stopWork prihvata 0 komada

describe("validateStopWork — 0 komada (borverk višednevni rad)", () => {
  const base = {
    orderBarcode: "RNZ:2597:06/93-4:1:A",
    operationBarcode: "S:10:0102:0:A",
    workerCard: "CARD1",
  };

  it("pieceCount 0 prolazi (evidentira se samo vreme)", () => {
    expect(() => validateStopWork({ ...base, pieceCount: 0 })).not.toThrow();
  });

  it("pieceCount -1 pada (negativan broj komada)", () => {
    expect(() => validateStopWork({ ...base, pieceCount: -1 })).toThrow();
  });

  it("pieceCount ≥ 1 i dalje prolazi", () => {
    expect(() => validateStopWork({ ...base, pieceCount: 5 })).not.toThrow();
  });
});

// ============================================================ REOPEN (dorada)

describe("TechProcessesService — reopen zatvorene operacije (dorada)", () => {
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
  });

  it("otvara SVE redove operacije: updateMany sa isProcessFinished:false, finishedAt:null", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({
        id: 700,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
        isProcessFinished: true,
        finishedAt: new Date("2026-07-10T10:00:00Z"),
      }),
    );
    prisma.operation.findUnique.mockResolvedValue({ usesPriority: false });
    prisma.techProcess.updateMany.mockResolvedValue({ count: 2 });

    const { data } = await service.reopen(700);

    expect(data).toEqual({
      id: 700,
      operationNumber: 60,
      workCenterCode: "8.5",
      reopened: 2,
    });
    // Cilja redove te operacije (trojka + OP + RC), samo zatvorene, i ih otvara.
    expect(prisma.techProcess.updateMany).toHaveBeenCalledWith(
      containing({
        where: containing({
          projectId: 2597,
          identNumber: "06/93-4",
          variant: 0,
          operationNumber: 60,
          workCenterCode: "8.5",
          isProcessFinished: true,
        }),
        data: { isProcessFinished: false, finishedAt: null },
      }),
    );
    // Skidanje „RN završen" (ako je bio) — status:true → false.
    expect(prisma.workOrder.updateMany).toHaveBeenCalledWith(
      containing({
        where: { id: 900, status: true },
        data: { status: false },
      }),
    );
  });

  it("usesPriority=true: vraća operaciju na listu (255 → 100)", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({
        id: 701,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
        isProcessFinished: true,
      }),
    );
    prisma.operation.findUnique.mockResolvedValue({ usesPriority: true });
    prisma.techProcess.updateMany.mockResolvedValue({ count: 1 });

    await service.reopen(701);

    expect(prisma.workOrderOperation.updateMany).toHaveBeenCalledWith(
      containing({
        where: containing({
          workOrderId: 900,
          operationNumber: 60,
          workCenterCode: "8.5",
          priority: 255,
        }),
        data: { priority: 100 },
      }),
    );
  });

  it("usesPriority=false: NE dira priority (operacija ionako nije na listi)", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({
        id: 702,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
        isProcessFinished: true,
      }),
    );
    prisma.operation.findUnique.mockResolvedValue({ usesPriority: false });
    prisma.techProcess.updateMany.mockResolvedValue({ count: 1 });

    await service.reopen(702);

    expect(prisma.workOrderOperation.updateMany).not.toHaveBeenCalled();
  });

  it("404 kad tehnološki postupak ne postoji", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(null);

    await expect(service.reopen(999)).rejects.toThrow(
      "Tehnološki postupak 999 ne postoji",
    );
    expect(prisma.techProcess.updateMany).not.toHaveBeenCalled();
  });
});

// ============================================================ stop-work po ID-ju (#7)

describe("TechProcessesService — stopWorkById (Kraj rada iz Moji otvoreni)", () => {
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
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
    // RN plan 50 (findWorkOrderByTriple).
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      projectId: 2597,
      identNumber: "06/93-4",
      variant: 0,
      pieceCount: 50,
      revision: "A",
    });
  });

  it("zatvara MOJU otvorenu sesiju, akumulira komade, vraća reportedPieces", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({
        id: 500,
        pieceCount: 2,
        operationNumber: 10,
        workCenterCode: "0102",
        workOrderId: 900,
      }),
    );
    prisma.workTimeEntry.findFirst.mockResolvedValue({
      id: 11,
      startedAt: new Date("2026-07-14T08:00:00Z"),
    });
    prisma.workTimeEntry.update.mockResolvedValue({
      id: 11,
      startedAt: new Date("2026-07-14T08:00:00Z"),
      stoppedAt: new Date("2026-07-14T08:30:00Z"),
      pieceCount: 3,
    });
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 500, pieceCount: 5, workerId: 74 }),
    );

    const { data } = await service.stopWorkById(
      500,
      { workerCard: "CARD74", pieceCount: 3 },
      undefined,
    );

    expect(data.reportedPieces).toBe(3);
    expect(data.operationFinished).toBe(false); // 5 < 50
    expect(data.techProcess.pieceCount).toBe(5);
    // Sesija se traži i zatvara po MOM workerId + tom postupku + stoppedAt:null.
    expect(prisma.workTimeEntry.findFirst).toHaveBeenCalledWith(
      containing({
        where: containing({
          workerId: 74,
          techProcessId: 500,
          stoppedAt: null,
        }),
      }),
    );
    const updArg = prisma.workTimeEntry.update.mock.calls[0][0] as {
      where: { id: number };
      data: { pieceCount: number };
    };
    expect(updArg.where.id).toBe(11);
    expect(updArg.data.pieceCount).toBe(3);
    // BUG-P1-01 Faza 1: akumulacija je ATOMSKA — update piše { increment: 3 }
    // (ne apsolutnu vrednost 5). Odluka o zatvaranju ide u drugom update-u.
    expect(prisma.techProcess.update).toHaveBeenCalledWith(
      containing({
        where: { id: 500 },
        data: containing({ pieceCount: { increment: 3 }, workerId: 74 }),
      }),
    );
  });

  it("0 komada: evidentira SAMO vreme (pieceCount reda nepromenjen, sesija zatvorena)", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({ id: 500, pieceCount: 2, workCenterCode: "0102", workOrderId: 900 }),
    );
    prisma.workTimeEntry.findFirst.mockResolvedValue({
      id: 11,
      startedAt: new Date("2026-07-14T08:00:00Z"),
    });
    prisma.workTimeEntry.update.mockResolvedValue({
      id: 11,
      startedAt: new Date("2026-07-14T08:00:00Z"),
      stoppedAt: new Date("2026-07-14T08:30:00Z"),
      pieceCount: 0,
    });
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 500, pieceCount: 2, workerId: 74 }),
    );

    const { data } = await service.stopWorkById(
      500,
      { workerCard: "CARD74", pieceCount: 0 },
      undefined,
    );

    expect(data.reportedPieces).toBe(0);
    // BUG-P1-01 Faza 1: prvi update je ATOMSKI increment (0 kom → increment:0).
    const updArg = prisma.techProcess.update.mock.calls[0][0] as {
      data: { pieceCount: unknown };
    };
    expect(updArg.data.pieceCount).toEqual({ increment: 0 });
    expect(prisma.workTimeEntry.update).toHaveBeenCalled();
  });

  it("FIX B: bez sesije, ispod plana — Kraj rada ZATVARA taj red (is_process_finished:true), akumulira komade", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({
        id: 500,
        pieceCount: 23,
        operationNumber: 10,
        workCenterCode: "0102",
        workOrderId: 900,
      }),
    );
    // RN plan 100 → 23 + 5 = 28 < 100 (plan NIJE dostignut), ali FIX B: „Kraj
    // rada" svejedno zatvara TAJ red (radnik ga završava/čisti). Operacija ostaje
    // radna preko FIX A — sledeći sken otvara NOV red.
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      projectId: 2597,
      identNumber: "06/93-4",
      variant: 0,
      pieceCount: 100,
      revision: "A",
    });
    prisma.workTimeEntry.findFirst.mockResolvedValue(null); // nema sesije
    prisma.techProcess.update.mockResolvedValue(
      tpRow({
        id: 500,
        pieceCount: 28,
        isProcessFinished: true,
        finishedAt: new Date("2026-07-15T09:00:00Z"),
        workerId: 74,
      }),
    );

    const { data } = await service.stopWorkById(
      500,
      { workerCard: "CARD74", pieceCount: 5 },
      undefined,
    );

    expect(data.reportedPieces).toBe(5);
    // reachedPlan je plan-based (28 < 100) → operationFinished ostaje false,
    // iako je red zatvoren silom (forceFinish).
    expect(data.operationFinished).toBe(false);
    expect(data.session).toBeNull(); // nema sesije za zatvaranje
    expect(data.techProcess.pieceCount).toBe(28);
    // Sesija se NE zatvara (nema je), ali se komadi akumuliraju na red operacije.
    expect(prisma.workTimeEntry.update).not.toHaveBeenCalled();
    // BUG-P1-01 Faza 1: akumulacija je sada dva update-a u istoj transakciji —
    // (1) atomski increment komada, (2) uslovno zatvaranje reda. FIX B (forceFinish)
    // i dalje zatvara ispod plana; samo se zatvaranje sada dešava u DRUGOM update-u.
    const incArg = prisma.techProcess.update.mock.calls[0][0] as {
      where: { id: number };
      data: Record<string, unknown>;
    };
    expect(incArg.where.id).toBe(500);
    expect(incArg.data.pieceCount).toEqual({ increment: 5 });
    expect(incArg.data.workerId).toBe(74);
    const finArg = prisma.techProcess.update.mock.calls[1][0] as {
      where: { id: number };
      data: Record<string, unknown>;
    };
    expect(finArg.where.id).toBe(500);
    expect(finArg.data.isProcessFinished).toBe(true);
    expect(finArg.data.finishedAt).toBeInstanceOf(Date);
  });

  it("bez sesije, stari 0/1 red (uneto 1 = plan): zatvara operaciju prirodno", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({
        id: 501,
        pieceCount: 0,
        operationNumber: 10,
        workCenterCode: "0102",
        workOrderId: 900,
      }),
    );
    // RN plan 1 → 0 + 1 = 1 >= 1 → reachedPlan → zatvara.
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      projectId: 2597,
      identNumber: "06/93-4",
      variant: 0,
      pieceCount: 1,
      revision: "A",
    });
    prisma.workTimeEntry.findFirst.mockResolvedValue(null);
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 501, pieceCount: 1, isProcessFinished: true, workerId: 74 }),
    );

    const { data } = await service.stopWorkById(
      501,
      { workerCard: "CARD74", pieceCount: 1 },
      undefined,
    );

    expect(data.operationFinished).toBe(true); // dostignut plan (1/1)
    expect(data.session).toBeNull();
    // BUG-P1-01 Faza 1: zatvaranje reda je u DRUGOM update-u (posle atomskog inkrementa).
    const finArg = prisma.techProcess.update.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect(finArg.data.isProcessFinished).toBe(true);
  });

  it("tuđa otvorena sesija se NE zatvara (izolacija po mom workerId), komadi akumulirani", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({ id: 500, pieceCount: 2, workCenterCode: "0102", workOrderId: 900 }),
    );
    // Otvorena sesija postoji, ali je tuđa → filter po workerId:74 je ne vraća.
    prisma.workTimeEntry.findFirst.mockResolvedValue(null);
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 500, pieceCount: 5, workerId: 74 }),
    );

    const { data } = await service.stopWorkById(
      500,
      { workerCard: "CARD74", pieceCount: 3 },
      undefined,
    );

    // Dokaz izolacije: sesija se traži isključivo po mom workerId + stoppedAt:null.
    expect(prisma.workTimeEntry.findFirst).toHaveBeenCalledWith(
      containing({ where: containing({ workerId: 74, stoppedAt: null }) }),
    );
    // Tuđa sesija se NE zatvara, ali su komadi svejedno akumulirani (5 = 2 + 3).
    expect(prisma.workTimeEntry.update).not.toHaveBeenCalled();
    expect(data.session).toBeNull();
    expect(data.techProcess.pieceCount).toBe(5);
  });

  it("404 kad tehnološki postupak ne postoji", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(null);

    await expect(
      service.stopWorkById(999, { workerCard: "CARD74", pieceCount: 1 }, undefined),
    ).rejects.toThrow("Tehnološki postupak 999 ne postoji");
  });
});

// ============================================================ Deljeni red — više radnika (Nenad 22.07)
// Bag iz pogona: R1 „Kraj rada" na operaciji koju kuca i R2 gasio je red svima
// (FIX B forceFinish na DELJENOM redu). Guard: bez `finishForAll` red ostaje
// otvoren dok drugi imaju otvorene sesije; higijena čisti sesije pri gašenju.

describe("TechProcessesService — deljeni red: više radnika na istoj operaciji (22.07)", () => {
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.worker.findFirst.mockResolvedValue({
      id: 74,
      fullName: "Jovica Milosevic",
      username: "jovica",
      workerTypeId: 1,
    });
    // RN plan 100 — forceFinish scenariji su ispod plana.
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      projectId: 2597,
      identNumber: "06/93-4",
      variant: 0,
      pieceCount: 100,
      revision: "A",
    });
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({ id: 500, pieceCount: 2, workCenterCode: "0102", workOrderId: 900 }),
    );
    prisma.workTimeEntry.findFirst.mockResolvedValue({
      id: 11,
      startedAt: new Date("2026-07-22T08:00:00Z"),
    });
    prisma.workTimeEntry.update.mockResolvedValue({
      id: 11,
      startedAt: new Date("2026-07-22T08:00:00Z"),
      stoppedAt: new Date("2026-07-22T09:00:00Z"),
      pieceCount: 3,
    });
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 500, pieceCount: 5, workerId: 74 }),
    );
  });

  it("Kraj rada BEZ finishForAll uz tuđu otvorenu sesiju: moja sesija zatvorena, red OSTAJE otvoren (finishSkipped)", async () => {
    // Radnik 33 ima otvorenu sesiju na istom (deljenom) redu.
    prisma.workTimeEntry.findMany.mockResolvedValue([{ workerId: 33 }]);

    const { data } = await service.stopWorkById(
      500,
      { workerCard: "CARD74", pieceCount: 3 },
      undefined,
    );

    expect(data.finishSkipped).toBe(true);
    expect(data.operationFinished).toBe(false);
    expect(data.otherOpenWorkers).toEqual([containing({ id: 33 })]);
    // Moja sesija JESTE zatvorena (update reda 11 sa komadima).
    expect(prisma.workTimeEntry.update).toHaveBeenCalled();
    // Red NIJE ugašen: jedini techProcess.update je atomski increment komada.
    expect(prisma.techProcess.update).toHaveBeenCalledTimes(1);
    const incArg = prisma.techProcess.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(incArg.data.pieceCount).toEqual({ increment: 3 });
    expect(incArg.data.isProcessFinished).toBeUndefined();
    // Higijena sesija NIJE tekla (red ostaje otvoren).
    expect(prisma.workTimeEntry.updateMany).not.toHaveBeenCalled();
  });

  it("Kraj rada SA finishForAll: red zatvoren + tuđe otvorene sesije počišćene (autoClosed)", async () => {
    prisma.workTimeEntry.findMany.mockResolvedValue([{ workerId: 33 }]);

    const { data } = await service.stopWorkById(
      500,
      { workerCard: "CARD74", pieceCount: 3, finishForAll: true },
      undefined,
    );

    expect(data.finishSkipped).toBe(false);
    const finArg = prisma.techProcess.update.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect(finArg.data.isProcessFinished).toBe(true);
    // Higijena: preostale otvorene sesije reda zatvorene uz autoClosed marker.
    expect(prisma.workTimeEntry.updateMany).toHaveBeenCalledWith(
      containing({
        where: containing({ techProcessId: 500, stoppedAt: null }),
        data: containing({ autoClosed: true }),
      }),
    );
  });

  it("FIX B regresija: jedan radnik (bez tuđih sesija) — Kraj rada i dalje zatvara red", async () => {
    // Default findMany → [] (nema tuđih otvorenih sesija).
    const { data } = await service.stopWorkById(
      500,
      { workerCard: "CARD74", pieceCount: 3 },
      undefined,
    );

    expect(data.finishSkipped).toBe(false);
    const finArg = prisma.techProcess.update.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect(finArg.data.isProcessFinished).toBe(true);
  });

  it("reachedPlan uz tuđu otvorenu sesiju: red se zatvara (plan je plan) + higijena sesija", async () => {
    // Plan 5: 2 + 3 = 5 → reachedPlan. Radnik 33 i dalje ima otvorenu sesiju.
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      projectId: 2597,
      identNumber: "06/93-4",
      variant: 0,
      pieceCount: 5,
      revision: "A",
    });
    prisma.workTimeEntry.findMany.mockResolvedValue([{ workerId: 33 }]);

    const { data } = await service.stopWorkById(
      500,
      { workerCard: "CARD74", pieceCount: 3 },
      undefined,
    );

    expect(data.operationFinished).toBe(true);
    expect(data.finishSkipped).toBe(false);
    const finArg = prisma.techProcess.update.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect(finArg.data.isProcessFinished).toBe(true);
    expect(prisma.workTimeEntry.updateMany).toHaveBeenCalledWith(
      containing({
        where: containing({ techProcessId: 500, stoppedAt: null }),
        data: containing({ autoClosed: true }),
      }),
    );
  });

  it("Odustani (dismiss) uz tuđu otvorenu sesiju: red OSTAJE otvoren, zatvoreno samo svoje učešće", async () => {
    // Guard upit (findFirst po workerId != moj) vraća tuđu sesiju.
    prisma.workTimeEntry.findFirst.mockResolvedValue({ id: 77 });

    const { data } = await service.dismissEntry(
      500,
      { workerCard: "CARD74", pieceCount: 0 },
      undefined,
    );

    expect(data.dismissed).toBe(true);
    expect(data.finishSkipped).toBe(true);
    // Svoje otvorene sesije zatvorene (updateMany po MOM workerId)…
    expect(prisma.workTimeEntry.updateMany).toHaveBeenCalledWith(
      containing({
        where: containing({ workerId: 74, techProcessId: 500, stoppedAt: null }),
      }),
    );
    // …a red NIJE ugašen.
    expect(prisma.techProcess.update).not.toHaveBeenCalled();
  });

  it("Odustani bez tuđih sesija: red se gasi kao i do sada", async () => {
    prisma.workTimeEntry.findFirst.mockResolvedValue(null);

    const { data } = await service.dismissEntry(
      500,
      { workerCard: "CARD74", pieceCount: 0 },
      undefined,
    );

    expect(data.finishSkipped).toBe(false);
    expect(prisma.techProcess.update).toHaveBeenCalledWith(
      containing({
        where: { id: 500 },
        data: containing({ isProcessFinished: true }),
      }),
    );
  });

  it("openForWorker vraća othersOpenCount (broj DRUGIH radnika sa otvorenom sesijom po redu)", async () => {
    // Radnik 74 AKTIVNO radi red 500 (svoja otvorena sesija) — inače bi ga zahtev
    // 015/26 filter izbacio (vlasništvo bez učešća uz tuđi rad ≠ „moj otvoren").
    prisma.workTimeEntry.findMany.mockResolvedValue([{ techProcessId: 500 }]);
    prisma.techProcess.findMany.mockResolvedValue([
      tpRow({ id: 500, workerId: 74, workCenterCode: "0102" }),
    ]);
    prisma.workTimeEntry.groupBy.mockResolvedValue([
      { techProcessId: 500, workerId: 33 },
      { techProcessId: 500, workerId: 44 },
    ]);

    const { data } = await service.openForWorker("CARD74", undefined);

    expect(data).toHaveLength(1);
    expect(data[0].othersOpenCount).toBe(2);
    // groupBy filtrira TUĐE otvorene sesije (workerId != moj, stoppedAt null).
    expect(prisma.workTimeEntry.groupBy).toHaveBeenCalledWith(
      containing({
        where: containing({ stoppedAt: null, workerId: { not: 74 } }),
      }),
    );
  });
});

// ============================================================ Kratki barkod nalepnice (IDPredmet=0, 22.07)
// Nalepnica nosi `RNZ:0:{ident}:0:0` (Code128 gustina — incident „skener ne čita").
// Servis razrešava predmet po identu (resolveScanProjectId): jedinstven → nastavlja
// sa realnim projectId; nepoznat → 404; u više predmeta → 422 (radnik skenira RN papir).

describe("TechProcessesService — kratki barkod nalepnice (IDPredmet=0)", () => {
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.worker.findFirst.mockResolvedValue({
      id: 74,
      fullName: "Jovica Milosevic",
      username: "jovica",
      workerTypeId: 1,
    });
    prisma.workOrder.findFirst.mockResolvedValue({
      id: 900,
      projectId: 2597,
      identNumber: "06/93-4",
      variant: 0,
      pieceCount: 100,
      revision: "A",
    });
  });

  it("STOP sa nalepnice: predmet razrešen po identu, tok nastavlja sa realnim projectId", async () => {
    // Resolver: ident postoji u tačno jednom predmetu.
    prisma.workOrder.findMany.mockResolvedValue([{ projectId: 2597 }]);
    // Routing postoji (create-on-scan otvara nov red).
    prisma.workOrderOperation.findFirst.mockResolvedValue({
      operationNumber: 10,
      workCenterCode: "0102",
    });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({ id: 700, projectId: 2597, pieceCount: 0, workOrderId: 900 }),
    );
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 700, projectId: 2597, pieceCount: 3, workerId: 74 }),
    );
    prisma.workTimeEntry.create.mockResolvedValue({
      id: 51,
      startedAt: new Date("2026-07-22T10:00:00Z"),
      stoppedAt: new Date("2026-07-22T10:00:00Z"),
      pieceCount: 3,
    });

    const { data } = await service.stopWork({
      orderBarcode: "RNZ:0:06/93-4:0:0",
      operationBarcode: "S:10:0102:0:0",
      workerCard: "CARD74",
      pieceCount: 3,
    });

    expect(data.reportedPieces).toBe(3);
    // Resolver upit: distinct predmeti po identu.
    expect(prisma.workOrder.findMany).toHaveBeenCalledWith(
      containing({
        where: { identNumber: "06/93-4" },
        distinct: ["projectId"],
      }),
    );
    // Tekući RN se traži sa RAZREŠENIM projectId (2597), ne sa 0.
    expect(prisma.workOrder.findFirst).toHaveBeenCalledWith(
      containing({
        where: containing({ projectId: 2597, identNumber: "06/93-4" }),
      }),
    );
    // Nov red operacije se otvara sa realnim projectId.
    expect(prisma.techProcess.create).toHaveBeenCalledWith(
      containing({ data: containing({ projectId: 2597 }) }),
    );
  });

  it("nepoznat ident sa nalepnice → 404", async () => {
    prisma.workOrder.findMany.mockResolvedValue([]);

    await expect(
      service.stopWork({
        orderBarcode: "RNZ:0:NEMA/OVOG:0:0",
        operationBarcode: "S:10:0102:0:0",
        workerCard: "CARD74",
        pieceCount: 1,
      }),
    ).rejects.toThrow("RN za ident NEMA/OVOG nije nađen.");
  });

  it("ident u više predmeta → 422 (skeniraj RN papir)", async () => {
    prisma.workOrder.findMany.mockResolvedValue([
      { projectId: 1111 },
      { projectId: 2222 },
    ]);

    await expect(
      service.stopWork({
        orderBarcode: "RNZ:0:06/93-4:0:0",
        operationBarcode: "S:10:0102:0:0",
        workerCard: "CARD74",
        pieceCount: 1,
      }),
    ).rejects.toThrow(/više predmeta/);
  });

  it("pun barkod (projectId > 0) prolazi BEZ resolver upita", async () => {
    prisma.workOrderOperation.findFirst.mockResolvedValue({
      operationNumber: 10,
      workCenterCode: "0102",
    });
    prisma.techProcess.create.mockResolvedValue(
      tpRow({ id: 701, projectId: 2597, pieceCount: 0, workOrderId: 900 }),
    );
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 701, projectId: 2597, pieceCount: 1, workerId: 74 }),
    );
    prisma.workTimeEntry.create.mockResolvedValue({
      id: 52,
      startedAt: new Date("2026-07-22T10:00:00Z"),
      stoppedAt: new Date("2026-07-22T10:00:00Z"),
      pieceCount: 1,
    });

    await service.stopWork({
      orderBarcode: "RNZ:2597:06/93-4:0:A",
      operationBarcode: "S:10:0102:0:A",
      workerCard: "CARD74",
      pieceCount: 1,
    });

    expect(prisma.workOrder.findMany).not.toHaveBeenCalled();
  });
});

// ============================================================ K0.1 napomena na prijavi rada (scan)

describe("TechProcessesService — K0.1 napomena na scan (upis na tech_processes)", () => {
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
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
    // Opšti nalog (withoutProcess) → scan otvara red bez routing lookup-a; posle
    // create-a scan radi update (akumulacija) na koji se upisuje napomena.
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: true });
    prisma.techProcess.findFirst.mockResolvedValue(null);
    prisma.techProcess.create.mockResolvedValue(
      tpRow({ id: 555, variant: 1, pieceCount: 0, workOrderId: 900 }),
    );
    prisma.techProcess.update.mockResolvedValue(
      tpRow({ id: 555, variant: 1, pieceCount: 2, note: "ogrebotina" }),
    );
  });

  it("scan sa note: napomena (trim) upisana na tech_processes red", async () => {
    await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:1:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 2,
      note: "  ogrebotina  ",
    });

    const updArg = prisma.techProcess.update.mock.calls[0][0] as {
      data: { note?: string };
    };
    expect(updArg.data.note).toBe("ogrebotina");
  });

  it("scan bez note: note se NE dira (data bez note)", async () => {
    await service.scan({
      orderBarcode: "RNZ:2597:06/93-4:1:A",
      operationBarcode: "S:10:0102:0:A",
      pieceCount: 2,
    });

    const updArg = prisma.techProcess.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updArg.data.note).toBeUndefined();
  });
});

// ============================================================ overshoot: control potvrda / finish TVRDO

describe("TechProcessesService — overshoot (control uz potvrdu, finish TVRDO)", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;

  /** RN plan 50; kontrola preko plana traži confirmOvershoot, finish je TVRDO (bez bypass-a). */
  const WO = {
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

  const CONTROL_DTO = {
    orderBarcode: "RNZ:2597:06/93-4:0:A",
    operationBarcode: "S:60:8.5:0:A",
    workerCard: "CTRL1",
    qualityTypeId: 0,
    pieceCount: 40,
    locations: [{ positionId: 1, quantity: 40 }],
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
        { provide: QualityService, useValue: qualityMock() },
        { provide: WorkOrdersService, useValue: workOrdersMock() },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.worker.findFirst.mockResolvedValue({
      id: 88,
      fullName: "Pera Kontrolor",
      username: "pera",
      workerTypeId: 5,
    });
    prisma.workerType.findUnique.mockResolvedValue({
      additionalPrivileges: true,
    });
    prisma.workOrder.findFirst.mockResolvedValue(WO);
    prisma.workOrder.findUnique.mockResolvedValue(WO);
    prisma.operation.findUnique.mockResolvedValue({
      significantForFinishing: true,
    });
    prisma.workOrderOperation.findFirst.mockResolvedValue({ id: 1 });
    // Kumulativ 20 + 40 = 60 > plan 50.
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 20 } });
  });

  it("control: premašaj bez confirmOvershoot → 422, ništa se ne knjiži", async () => {
    await expect(service.control(CONTROL_DTO)).rejects.toThrow(
      "potvrdite unos preko plana",
    );
    expect(prisma.partLocation.create).not.toHaveBeenCalled();
    expect(prisma.techProcess.create).not.toHaveBeenCalled();
  });

  it("control: confirmOvershoot=true → dozvoljeno, operacija zatvorena (60 > 50)", async () => {
    prisma.techProcess.findFirst.mockResolvedValue(null);
    prisma.techProcess.create.mockResolvedValue(
      tpRow({
        id: 700,
        pieceCount: 40,
        isProcessFinished: true,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
      }),
    );
    prisma.techProcess.updateMany.mockResolvedValue({ count: 0 });
    prisma.workOrderOperation.updateMany.mockResolvedValue({ count: 0 });

    const { data } = await service.control({
      ...CONTROL_DTO,
      confirmOvershoot: true,
    });

    expect(data.operationFinished).toBe(true);
    expect(data.controlledCumulative).toBe(60);
    // Guard preskočen → lokacije se knjiže (dokaz da je overshoot dozvoljen).
    expect(prisma.partLocation.create).toHaveBeenCalled();
  });

  it("finish: premašaj → 422 TVRDO, red se ne zatvara (A2, bez bypass-a)", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({ id: 700, workCenterCode: "0102", pieceCount: 0, workOrderId: 900 }),
    );
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: false });

    await expect(service.finish(700, { pieceCount: 60 })).rejects.toThrow(
      "kucanje preko plana nije dozvoljeno",
    );
    expect(prisma.techProcess.update).not.toHaveBeenCalled();
  });

  it("finish: premašaj + confirmOvershoot=true → i dalje 422 (flag uklonjen, A2)", async () => {
    prisma.techProcess.findUnique.mockResolvedValue(
      tpRow({ id: 700, workCenterCode: "0102", pieceCount: 0, workOrderId: 900 }),
    );
    prisma.operation.findUnique.mockResolvedValue({ withoutProcess: false });

    // `confirmOvershoot` više ne postoji u DTO-u — prosleđen kao višak polja, ignoriše se;
    // finish je TVRDO i dalje baca 422.
    await expect(
      service.finish(700, {
        pieceCount: 60,
        ...({ confirmOvershoot: true } as unknown as Record<string, never>),
      }),
    ).rejects.toThrow("kucanje preko plana nije dozvoljeno");
    expect(prisma.techProcess.update).not.toHaveBeenCalled();
  });
});

// ============================================================ K2 auto-draft neusaglašenosti

describe("TechProcessesService — K2 auto-draft neusaglašenosti (control dorada/škart)", () => {
  let service: TechProcessesService;
  let prisma: ReturnType<typeof prismaMock>;
  let quality: ReturnType<typeof qualityMock>;
  let workOrders: ReturnType<typeof workOrdersMock>;

  const WO = {
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

  const DTO = {
    orderBarcode: "RNZ:2597:06/93-4:0:A",
    operationBarcode: "S:60:8.5:0:A",
    workerCard: "CTRL1",
    pieceCount: 10,
    locations: [{ positionId: 1, quantity: 10 }],
  };

  beforeEach(async () => {
    prisma = prismaMock();
    quality = qualityMock();
    workOrders = workOrdersMock();
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
        { provide: QualityService, useValue: quality },
        { provide: WorkOrdersService, useValue: workOrders },
      ],
    }).compile();
    service = mod.get(TechProcessesService);
    prisma.worker.findFirst.mockResolvedValue({
      id: 88,
      fullName: "Pera Kontrolor",
      username: "pera",
      workerTypeId: 5,
    });
    prisma.workerType.findUnique.mockResolvedValue({
      additionalPrivileges: true,
    });
    prisma.workOrder.findFirst.mockResolvedValue(WO);
    prisma.workOrder.findUnique.mockResolvedValue(WO);
    prisma.operation.findUnique.mockResolvedValue({
      significantForFinishing: true,
      workCenterName: "Ravno brušenje",
    });
    prisma.workOrderOperation.findFirst.mockResolvedValue({ id: 1 });
    prisma.techProcess.aggregate.mockResolvedValue({ _sum: { pieceCount: 0 } });
    prisma.techProcess.findFirst.mockResolvedValue(null);
    prisma.techProcess.create.mockResolvedValue(
      tpRow({
        id: 700,
        pieceCount: 10,
        operationNumber: 60,
        workCenterCode: "8.5",
        workOrderId: 900,
      }),
    );
    // Culprit predlog: distinct radnici (>0) sa postojećih redova te operacije.
    prisma.techProcess.findMany.mockResolvedValue([
      { workerId: 10 },
      { workerId: 0 },
      { workerId: 10 },
      { workerId: 22 },
    ]);
  });

  it("kvalitet=2 (škart): createDraftFromControl pozvan sa type=2 + prefill; nonconformityDraftCreated=true", async () => {
    const { data } = await service.control({
      ...DTO,
      qualityTypeId: 2,
      note: "  prslina  ",
    });

    expect(quality.createDraftFromControl).toHaveBeenCalledTimes(1);
    expect(quality.createDraftFromControl).toHaveBeenCalledWith(
      containing({
        qualityTypeId: 2,
        sourceTechProcessId: 700,
        workOrderId: 900,
        identNumber: "06/93-4",
        drawingNumber: "CRT-1",
        partName: "Osovina",
        customerName: null,
        quantity: 10,
        workUnit: "8.5 · Ravno brušenje",
        defectDescription: "prslina",
        raisedByWorkerId: 88,
        culpritWorkerIds: [10, 22],
      }),
    );
    expect(data.nonconformityDraftCreated).toBe(true);
  });

  it("kvalitet=0 (dobar): draft se NE kreira, nonconformityDraftCreated=false", async () => {
    const { data } = await service.control({ ...DTO, qualityTypeId: 0 });

    expect(quality.createDraftFromControl).not.toHaveBeenCalled();
    expect(data.nonconformityDraftCreated).toBe(false);
  });

  it("pad createDraftFromControl NE obara kontrolu (best-effort → false)", async () => {
    quality.createDraftFromControl.mockRejectedValue(new Error("kvalitet down"));

    const { data } = await service.control({ ...DTO, qualityTypeId: 1 });

    expect(data.qualityTypeId).toBe(1);
    // Child RN (A3) je i dalje uspešno kreiran (workOrdersMock default) → pending false;
    // pada SAMO K2 draft (nezavisna best-effort grana).
    expect(data.childOrderPending).toBe(false);
    expect(data.nonconformityDraftCreated).toBe(false);
  });

  it("A3: kvalitet=1 (dorada) poziva createQualityChildOrder i vraća childOrder", async () => {
    const { data } = await service.control({
      ...DTO,
      qualityTypeId: 1,
      note: "  dorada  ",
    });

    expect(workOrders.createQualityChildOrder).toHaveBeenCalledTimes(1);
    expect(workOrders.createQualityChildOrder).toHaveBeenCalledWith(
      containing({
        parentWorkOrderId: 900,
        qualityTypeId: 1,
        quantity: 10,
        note: "dorada",
        actorWorkerId: 88,
      }),
    );
    expect(data.childOrder).toEqual({ id: 5001, identNumber: "06/93-4-D1" });
    expect(data.childOrderPending).toBe(false);
  });

  it("A3: pad createQualityChildOrder NE obara kontrolu (childOrderPending=true)", async () => {
    workOrders.createQualityChildOrder.mockRejectedValue(
      new Error("child RN down"),
    );

    const { data } = await service.control({ ...DTO, qualityTypeId: 2 });

    // Kontrola i dalje uspeva; child RN pending → ručno kreiranje (endpoint Agenta B).
    expect(data.qualityTypeId).toBe(2);
    expect(data.childOrder).toBeNull();
    expect(data.childOrderPending).toBe(true);
  });

  it("A3: kvalitet=0 (dobar) NE zove createQualityChildOrder, childOrder=null", async () => {
    const { data } = await service.control({ ...DTO, qualityTypeId: 0 });

    expect(workOrders.createQualityChildOrder).not.toHaveBeenCalled();
    expect(data.childOrder).toBeNull();
    expect(data.childOrderPending).toBe(false);
  });
});

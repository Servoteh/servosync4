import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { DraftNumberingService } from "./draft-numbering.service";
import { HandoverDraftsService } from "./handover-drafts.service";

/**
 * D8 emit 2 — `submit()` šalje „Kreirana nova primopredaja…" grupi TEHNOLOG.
 * Testira se emit helper (`notifySubmitted`) direktno: sam submit() tok
 * (advisory lock, kreiranje drawing_handovers…) je integraciona priča.
 */

/** Privatni emit helper — tipizirani pogled bez `any` (obrazac `as unknown as`). */
interface EmitView {
  notifySubmitted(
    draft: {
      id: number;
      draftNumber: string;
      designerId: number;
      designer: { fullName: string | null; username: string } | null;
    },
    itemCount: number,
  ): Promise<void>;
}

function notificationsMock() {
  return {
    notifyWorkers: jest.fn().mockResolvedValue(0),
    resolveTechnologistWorkerIds: jest.fn().mockResolvedValue([]),
  };
}

const DRAFT = {
  id: 15,
  draftNumber: "D-2026-15",
  designerId: 33,
  designer: { fullName: "Mika Projektant", username: "mika" },
};

describe("HandoverDraftsService — D8 emit notifikacija (submit)", () => {
  let emit: EmitView;
  let notifications: ReturnType<typeof notificationsMock>;

  beforeEach(async () => {
    notifications = notificationsMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        HandoverDraftsService,
        { provide: PrismaService, useValue: {} },
        { provide: DraftNumberingService, useValue: {} },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    emit = mod.get(HandoverDraftsService);
  });

  it("šalje grupi TEHNOLOG: type primopredaja.nova + srpska poruka + ref na handover_drafts", async () => {
    notifications.resolveTechnologistWorkerIds.mockResolvedValue([7, 9]);

    await emit.notifySubmitted(DRAFT, 4);

    expect(notifications.notifyWorkers).toHaveBeenCalledWith([7, 9], {
      type: "primopredaja.nova",
      message:
        "Kreirana nova primopredaja D-2026-15 — 4 stavki (projektant Mika Projektant)",
      refTable: "handover_drafts",
      refId: 15,
    });
  });

  it("projektant bez fullName → username; bez reda radnika → #designerId", async () => {
    await emit.notifySubmitted(
      { ...DRAFT, designer: { fullName: null, username: "mika" } },
      1,
    );
    await emit.notifySubmitted({ ...DRAFT, designer: null }, 1);

    const calls = notifications.notifyWorkers.mock.calls as unknown as [
      number[],
      { message: string },
    ][];
    const messages = calls.map(([, payload]) => payload.message);
    expect(messages[0]).toContain("(projektant mika)");
    expect(messages[1]).toContain("(projektant #33)");
  });

  it("pad notifikacije se guta (best-effort) — predaja nacrta je već uspela", async () => {
    notifications.resolveTechnologistWorkerIds.mockRejectedValue(
      new Error("db down"),
    );

    await expect(emit.notifySubmitted(DRAFT, 2)).resolves.toBeUndefined();
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// P4_SPEC §0 t.3+t.4 — §6.5.3 preduslovi stavke + §6.5.4 pre-check duplikata
// ---------------------------------------------------------------------------

/** Red `drawings` fixture-a (vraća se za SVAKI select — višak polja ne smeta). */
interface DrawingRow {
  id: number;
  drawingNumber: string;
  revision: string;
  name: string;
  pdmStatus: string;
  isProcurement: boolean;
}

const drawingRow = (
  over: Partial<DrawingRow> & { id: number },
): DrawingRow => ({
  drawingNumber: `D-${over.id}`,
  revision: "A",
  name: "Deo",
  pdmStatus: "Odobreno",
  isProcurement: false,
  ...over,
});

/** Odobren crtež, jedina revizija, PDF postoji (default mock). */
const APPROVED = drawingRow({
  id: 10,
  drawingNumber: "1126982",
  revision: "B",
});
const UNAPPROVED = drawingRow({
  id: 11,
  drawingNumber: "K00693",
  pdmStatus: "U izradi",
});

/** `expect.objectContaining` tipizovan kao `unknown` (smiruje no-unsafe-assignment). */
const containing = (obj: Record<string, unknown>): unknown =>
  expect.objectContaining(obj) as unknown;

/**
 * Mock PrismaService: `$transaction(cb)` prosleđuje ISTI mock kao `tx`;
 * `drawing.findMany` filtrira fixture po `where.id.in`; `drawing.groupBy`
 * računa MAX(revision) po broju iz fixture-a; PDF default = postoji za sve.
 */
function fullPrismaMock(drawings: DrawingRow[]) {
  const m = {
    // create() od 13.07 traži i AKTIVNOG projektanta (proba: neaktivan operater).
    worker: {
      findUnique: jest.fn().mockResolvedValue({ id: 33, active: true }),
    },
    project: { findUnique: jest.fn().mockResolvedValue({ id: 4 }) },
    drawing: { findMany: jest.fn(), groupBy: jest.fn() },
    drawingPdf: { findMany: jest.fn() },
    drawingComponent: { findMany: jest.fn().mockResolvedValue([]) },
    workOrder: { findMany: jest.fn().mockResolvedValue([]) },
    handoverDraft: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 15 }),
      update: jest.fn().mockResolvedValue({}),
    },
    handoverDraftItem: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    handoverDraftStatus: { findUnique: jest.fn().mockResolvedValue(null) },
    drawingHandover: {
      create: jest.fn().mockResolvedValue({ id: 100 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
  m.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(m),
  );
  m.drawing.findMany.mockImplementation((args: unknown) => {
    const ids = (args as { where?: { id?: { in?: number[] } } }).where?.id?.in;
    return Promise.resolve(
      ids ? drawings.filter((d) => ids.includes(d.id)) : drawings,
    );
  });
  m.drawing.groupBy.mockImplementation(() => {
    const max = new Map<string, string>();
    for (const d of drawings) {
      const cur = max.get(d.drawingNumber);
      if (cur === undefined || d.revision > cur)
        max.set(d.drawingNumber, d.revision);
    }
    return Promise.resolve(
      [...max].map(([drawingNumber, revision]) => ({
        drawingNumber,
        _max: { revision },
      })),
    );
  });
  m.drawingPdf.findMany.mockResolvedValue(
    drawings.map((d) => ({
      drawingNumber: d.drawingNumber,
      revision: d.revision,
    })),
  );
  return m;
}

/** Payload nested item create-a (za asertacije pre_check_* upisa). */
interface DraftCreateArg {
  data: { items?: { create: Record<string, unknown>[] } };
}

async function makeFullService(drawings: DrawingRow[]) {
  const prisma = fullPrismaMock(drawings);
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      HandoverDraftsService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: DraftNumberingService,
        useValue: { next: jest.fn().mockResolvedValue("2026-0001") },
      },
      { provide: NotificationsService, useValue: notificationsMock() },
    ],
  }).compile();
  const service = mod.get(HandoverDraftsService);
  // Završni read-back (enrich) nije predmet ovih testova — mock-uje se.
  jest.spyOn(service, "findOne").mockResolvedValue({
    data: { id: 15, draftNumber: "2026-0001", designerId: 33, designer: null },
  } as never);
  return { service, prisma };
}

const BASE_DTO = {
  designerId: 33,
  projectId: 4,
  pieceCount: 3,
  items: [{ drawingId: 10, quantityToProduce: 6 }],
};

const errorOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e,
  );

describe("HandoverDraftsService — §6.5.3 preduslovi stavke (create)", () => {
  it("ne-odobren pdm_status → HARD 422 sa spiskom spornih crteža, bez upisa", async () => {
    const { service, prisma } = await makeFullService([APPROVED, UNAPPROVED]);

    const err = await errorOf(
      service.create({
        ...BASE_DTO,
        items: [{ drawingId: 10 }, { drawingId: 11 }],
      }),
    );

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain("K00693");
    expect((err as Error).message).toContain('"U izradi"');
    expect((err as Error).message).not.toContain("1126982");
    expect(prisma.handoverDraft.create).not.toHaveBeenCalled();
  });

  it("nema PDF-a + nije poslednja revizija → SOFT meta.warnings, nacrt SE kreira", async () => {
    const oldRev = drawingRow({ id: 12, drawingNumber: "555", revision: "A" });
    const newRev = drawingRow({ id: 13, drawingNumber: "555", revision: "B" });
    const { service, prisma } = await makeFullService([oldRev, newRev]);
    prisma.drawingPdf.findMany.mockResolvedValue([]);

    const res = await service.create({
      ...BASE_DTO,
      items: [{ drawingId: 12, quantityToProduce: 1 }],
    });

    const types = res.meta.warnings.map((w) => w.type);
    expect(types).toEqual(
      expect.arrayContaining(["missing_pdf", "not_latest_revision"]),
    );
    const notLatest = res.meta.warnings.find(
      (w) => w.type === "not_latest_revision",
    );
    expect(notLatest?.message).toContain("poslednja: B");
    expect(prisma.handoverDraft.create).toHaveBeenCalledTimes(1);
  });

  it("odobren (case-insensitive, i 'izmena bez revizije') + PDF + poslednja revizija → bez upozorenja", async () => {
    const a = drawingRow({ id: 10, pdmStatus: "ODOBRENO" });
    const b = drawingRow({ id: 11, pdmStatus: "Izmena bez revizije" });
    const { service } = await makeFullService([a, b]);

    const res = await service.create({
      ...BASE_DTO,
      items: [{ drawingId: 10 }, { drawingId: 11 }],
    });

    expect(res.meta.warnings).toEqual([]);
  });
});

describe("HandoverDraftsService — §6.5.4 pre-check duplikata (create)", () => {
  it("raniji RN istog predmeta → preCheckDuplicate + preCheckWorkOrderId + duplicate warning", async () => {
    const { service, prisma } = await makeFullService([APPROVED]);
    prisma.workOrder.findMany.mockResolvedValue([
      { id: 900, drawingId: 10, drawingNumber: "1126982" },
    ]);

    const res = await service.create(BASE_DTO);

    const arg = (
      prisma.handoverDraft.create.mock.calls as [DraftCreateArg][]
    )[0][0];
    expect(arg.data.items?.create[0]).toEqual(
      containing({
        preCheckDuplicate: true,
        preCheckWorkOrderId: 900,
        preCheckDraftId: null,
      }),
    );
    const dup = res.meta.warnings.find((w) => w.type === "duplicate");
    expect(dup?.message).toContain("RN #900");
  });

  it("stavka RANIJEG nacrta istog predmeta → preCheckDraftId", async () => {
    const { service, prisma } = await makeFullService([APPROVED]);
    prisma.handoverDraft.findMany.mockResolvedValue([{ id: 70 }]);
    prisma.handoverDraftItem.findMany.mockResolvedValue([
      { id: 5, draftId: 70, drawingId: 10 },
    ]);

    const res = await service.create(BASE_DTO);

    const arg = (
      prisma.handoverDraft.create.mock.calls as [DraftCreateArg][]
    )[0][0];
    expect(arg.data.items?.create[0]).toEqual(
      containing({
        preCheckDuplicate: true,
        preCheckDraftId: 70,
        preCheckWorkOrderId: null,
      }),
    );
    const dup = res.meta.warnings.find((w) => w.type === "duplicate");
    expect(dup?.message).toContain("nacrtu #70");
  });

  it("količinsko neslaganje sa PDM sastavnicom ulazi u razlog upozorenja", async () => {
    const parent = drawingRow({ id: 50, drawingNumber: "SKLOP-1" });
    const { service, prisma } = await makeFullService([APPROVED, parent]);
    prisma.workOrder.findMany.mockResolvedValue([
      { id: 900, drawingId: 10, drawingNumber: "1126982" },
    ]);
    prisma.drawingComponent.findMany.mockResolvedValue([
      { parentDrawingId: 50, childDrawingId: 10, requiredQuantity: 2 },
    ]);

    // pieceCount=3 × requiredQuantity=2 = 6 ≠ traženo 4.
    const res = await service.create({
      ...BASE_DTO,
      mainDrawingId: 50,
      items: [{ drawingId: 10, quantityToProduce: 4 }],
    });

    const dup = res.meta.warnings.find((w) => w.type === "duplicate");
    expect(dup?.message).toContain(
      "tražena količina 4 ≠ količina po PDM sastavnici 6",
    );
  });

  it("nabavni crtež (is_procurement) je izuzet iz pre-check-a (legacy Nabavka=0)", async () => {
    const proc = drawingRow({
      id: 14,
      drawingNumber: "P-1",
      isProcurement: true,
    });
    const { service, prisma } = await makeFullService([proc]);
    prisma.workOrder.findMany.mockResolvedValue([
      { id: 901, drawingId: 14, drawingNumber: "P-1" },
    ]);

    const res = await service.create({
      ...BASE_DTO,
      items: [{ drawingId: 14 }],
    });

    const arg = (
      prisma.handoverDraft.create.mock.calls as [DraftCreateArg][]
    )[0][0];
    expect(arg.data.items?.create[0]).toEqual(
      containing({ preCheckDuplicate: false }),
    );
    expect(res.meta.warnings.filter((w) => w.type === "duplicate")).toEqual([]);
  });
});

describe("HandoverDraftsService — §6.5.4 gate na submit()", () => {
  it("sporna stavka BEZ odluke (decision_action=0) → 422, transakcija se ne otvara", async () => {
    const { service, prisma } = await makeFullService([APPROVED]);
    prisma.handoverDraft.findUnique.mockResolvedValue({
      id: 8,
      isLocked: false,
      designerId: 33,
    });
    prisma.handoverDraftItem.findMany.mockResolvedValue([
      { id: 1, drawingId: 10, preCheckDuplicate: true, decisionAction: 0 },
    ]);

    const err = await errorOf(service.submit(8));

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toContain("sporne stavke bez odluke");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("sporna stavka SA odlukom (2 — Predaj ponovo) prolazi gate i predaje se", async () => {
    const { service, prisma } = await makeFullService([APPROVED]);
    prisma.handoverDraft.findUnique.mockResolvedValue({
      id: 8,
      isLocked: false,
      designerId: 33,
    });
    prisma.handoverDraftItem.findMany.mockResolvedValue([
      { id: 1, drawingId: 10, preCheckDuplicate: true, decisionAction: 2 },
    ]);
    prisma.drawingHandover.findMany.mockResolvedValue([
      {
        id: 100,
        drawingId: 10,
        handoverDate: new Date(),
        handoverWorkerId: 33,
        statusId: 0,
        isLocked: false,
        createdAt: null,
      },
    ]);

    const res = await service.submit(8);

    expect(res.data.handoversCreated).toBe(1);
    expect(prisma.drawingHandover.create).toHaveBeenCalledTimes(1);
  });
});

describe("HandoverDraftsService — decideItem (§6.5.4 odluka projektanta)", () => {
  async function decideSetup(
    itemOver: Record<string, unknown> = {},
    draftOver: Record<string, unknown> = {},
  ) {
    const { service, prisma } = await makeFullService([APPROVED]);
    prisma.handoverDraft.findUnique.mockResolvedValue({
      id: 8,
      isLocked: false,
      ...draftOver,
    });
    prisma.handoverDraftItem.findUnique.mockResolvedValue({
      id: 21,
      draftId: 8,
      preCheckDuplicate: true,
      ...itemOver,
    });
    prisma.handoverDraftItem.update.mockResolvedValue({
      id: 21,
      draftId: 8,
      drawingId: 10,
      mainDrawingId: null,
    });
    return { service, prisma };
  }

  it("akcija 1 (Isključi) → excludeFromHandover=true + decision_action + decision_date_time", async () => {
    const { service, prisma } = await decideSetup();

    await service.decideItem(8, 21, { action: 1 });

    expect(prisma.handoverDraftItem.update).toHaveBeenCalledWith({
      where: { id: 21 },
      data: containing({
        decisionAction: 1,
        excludeFromHandover: true,
        decisionDateTime: expect.any(Date) as unknown,
      }),
    });
  });

  it("akcija 2 (Predaj ponovo) → prihvata duplikat, stavka OSTAJE u predaji", async () => {
    const { service, prisma } = await decideSetup();

    const res = await service.decideItem(8, 21, { action: 2 });

    expect(prisma.handoverDraftItem.update).toHaveBeenCalledWith({
      where: { id: 21 },
      data: containing({ decisionAction: 2, excludeFromHandover: false }),
    });
    expect(res.data.drawing).toEqual(containing({ id: 10 }));
  });

  it("akcija 3 (Dopuni) → koriguje quantity_to_produce na newQuantity", async () => {
    const { service, prisma } = await decideSetup();

    await service.decideItem(8, 21, { action: 3, newQuantity: 7 });

    expect(prisma.handoverDraftItem.update).toHaveBeenCalledWith({
      where: { id: 21 },
      data: containing({
        decisionAction: 3,
        quantityToProduce: 7,
        excludeFromHandover: false,
      }),
    });
  });

  it("akcija 3 BEZ newQuantity → 400, bez upisa", async () => {
    const { service, prisma } = await decideSetup();

    const err = await errorOf(service.decideItem(8, 21, { action: 3 }));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(prisma.handoverDraftItem.update).not.toHaveBeenCalled();
  });

  it("stavka koja NIJE sporna (pre_check_duplicate=false) → 422", async () => {
    const { service, prisma } = await decideSetup({ preCheckDuplicate: false });

    const err = await errorOf(service.decideItem(8, 21, { action: 2 }));

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.handoverDraftItem.update).not.toHaveBeenCalled();
  });

  it("zaključan (predat) nacrt → 422", async () => {
    const { service, prisma } = await decideSetup({}, { isLocked: true });

    const err = await errorOf(service.decideItem(8, 21, { action: 1 }));

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.handoverDraftItem.update).not.toHaveBeenCalled();
  });
});

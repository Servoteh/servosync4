import { Test, TestingModule } from "@nestjs/testing";
import { UnprocessableEntityException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ScopeService } from "../../common/authz/scope.service";
import { NotificationsService } from "../notifications/notifications.service";
import { LabelPrintService } from "../../common/printing/label-print.service";
import { QualityService } from "../kvalitet/kvalitet.service";
import { WorkOrdersService } from "../work-orders/work-orders.service";
import { TechProcessesService } from "./tech-processes.service";

/**
 * REGRESSION BASELINE — Faza 0 analize modula „Tehnologija".
 *
 * Ovi testovi NAMERNO dokumentuju TRENUTNO ponašanje jezgra na origin/main,
 * UKLJUČUJUĆI potvrđene bagove iz analize (BUG-P1-01 lost update, BUG-P1-03
 * deleteEntry sesije, BUG-P2-09 dvostruki storno). Cilj NIJE da testovi „prođu
 * jer je ispravno", nego da uhvate zatečeno ponašanje pre Faze 1 — kada se bag
 * popravi, ODGOVARAJUĆI test ovde MORA da se promeni (i to je signal da je
 * ponašanje namerno izmenjeno, ne slučajno). Svaki `it` nosi oznaku nalaza.
 *
 * READ-ONLY nad kodom: ništa u servisu se ne dira; menja se samo test-sloj.
 */

let nextId = 1;

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

/**
 * Prošireni Prisma mock — dodaje `auditLog`, `techProcessDocument` i
 * `$executeRaw` koje storno()/deleteEntry() koriste (nisu u osnovnom spec mock-u).
 */
function prismaMock() {
  const m: Record<string, unknown> = {
    techProcess: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: { data: unknown }) => ({
        id: nextId++,
        ...(data as Record<string, unknown>),
      })),
      update: jest.fn().mockImplementation(({ data }: { data: unknown }) => ({
        id: 999,
        ...(data as Record<string, unknown>),
      })),
      delete: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { pieceCount: 0 } }),
    },
    techProcessDocument: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    workTimeEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    worker: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(),
    // alignTechProcessSequence koristi raw setval — bezopasan no-op u mock-u.
    $executeRaw: jest.fn().mockResolvedValue(0),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  (m.$transaction as jest.Mock).mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(m),
  );
  return m;
}

async function buildService(prisma: ReturnType<typeof prismaMock>) {
  const moduleRef: TestingModule = await Test.createTestingModule({
    providers: [
      TechProcessesService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: ScopeService,
        useValue: {
          isEnforced: jest.fn().mockReturnValue(false),
          techProcessScope: jest.fn().mockResolvedValue({}),
          workerMachineViolation: jest.fn().mockResolvedValue(null),
        },
      },
      {
        provide: NotificationsService,
        useValue: {
          notifyWorkers: jest.fn().mockResolvedValue(0),
          resolveTechnologistWorkerIds: jest.fn().mockResolvedValue([]),
        },
      },
      { provide: LabelPrintService, useValue: { printRaw: jest.fn() } },
      {
        provide: QualityService,
        useValue: { createDraftFromControl: jest.fn().mockResolvedValue(undefined) },
      },
      {
        provide: WorkOrdersService,
        useValue: {
          createQualityChildOrder: jest
            .fn()
            .mockResolvedValue({ id: 5001, identNumber: "06/93-4-D1" }),
        },
      },
    ],
  }).compile();
  return moduleRef.get(TechProcessesService);
}

describe("REGRESSION — storno() (BUG-P2-09: guard poredi samo izvorni red)", () => {
  it("storno > pieceCount izvornog reda → 422 (postojeći guard)", async () => {
    const prisma = prismaMock();
    (prisma.techProcess.findUnique as jest.Mock).mockResolvedValue(
      tpRow({ id: 500, pieceCount: 10 }),
    );
    const svc = await buildService(prisma);
    await expect(
      svc.storno(500, { pieceCount: 11 } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("FAZA P2 (BUG-P2-09 popravljeno): DVOSTRUKI storno — prvi prolazi, drugi 422 (neto-guard)", async () => {
    // Izvorni red se NE menja pri stornu (kontra-red je nov red), ali neto-guard
    // sada gleda ZBIR svih redova operacije (aggregate). Prvi storno: neto=10 ≥ 10 →
    // prolazi. Posle njega neto=0, pa drugi storno od 10 baca 422 („već storniran").
    const prisma = prismaMock();
    (prisma.techProcess.findUnique as jest.Mock).mockResolvedValue(
      tpRow({ id: 500, pieceCount: 10 }),
    );
    // 1. poziv: neto 10; 2. poziv: neto 0 (prvi kontra-red -10 već upisan).
    (prisma.techProcess.aggregate as jest.Mock)
      .mockResolvedValueOnce({ _sum: { pieceCount: 10 } })
      .mockResolvedValueOnce({ _sum: { pieceCount: 0 } });
    const svc = await buildService(prisma);

    const r1 = await svc.storno(500, { pieceCount: 10 } as never);
    expect(r1.data.storniranoKomada).toBe(10);
    expect(
      (prisma.techProcess.create as jest.Mock).mock.calls[0][0].data.pieceCount,
    ).toBe(-10);

    // Drugi storno mora da padne — neto stanje operacije je već 0.
    await expect(
      svc.storno(500, { pieceCount: 10 } as never),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    // Nijedan drugi kontra-red nije kreiran (samo onaj iz prvog storna).
    expect((prisma.techProcess.create as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("storno upisuje audit_log beforeData snapshot (kontra-red, ne briše izvorni)", async () => {
    const prisma = prismaMock();
    (prisma.techProcess.findUnique as jest.Mock).mockResolvedValue(
      tpRow({ id: 501, pieceCount: 7 }),
    );
    // Neto stanje operacije = 7 (BUG-P2-09 guard) — storno od 3 prolazi.
    (prisma.techProcess.aggregate as jest.Mock).mockResolvedValue({
      _sum: { pieceCount: 7 },
    });
    const svc = await buildService(prisma);
    await svc.storno(501, { pieceCount: 3 } as never);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = (prisma.auditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(audit.action).toBe("STORNO");
    expect(audit.beforeData).toMatchObject({ id: 501, pieceCount: 7 });
    // izvorni red NIJE obrisan/menjan — samo dodat kontra-red
    expect(prisma.techProcess.delete).not.toHaveBeenCalled();
    expect((prisma.techProcess.create as jest.Mock).mock.calls[0][0].data.pieceCount).toBe(-3);
  });
});

describe("REGRESSION — deleteEntry() (BUG-P1-03: ne briše work_time_entries)", () => {
  it("FAZA 1 (BUG-P1-03 popravljeno): deleteEntry briše work_time_entries pre reda", async () => {
    // Ranije baseline bug: sesija na redu → FK NO ACTION → P2003 → 500. Popravka:
    // pre techProcess.delete se briše workTimeEntry.deleteMany({ techProcessId }).
    const prisma = prismaMock();
    (prisma.techProcess.findUnique as jest.Mock).mockResolvedValue(
      tpRow({ id: 600, pieceCount: 5, documents: [] }),
    );
    const svc = await buildService(prisma);
    await svc.deleteEntry(600, { note: "loše otkucano" });

    expect(prisma.workTimeEntry.deleteMany).toHaveBeenCalledWith({
      where: { techProcessId: 600 },
    });
    expect(prisma.techProcess.delete).toHaveBeenCalledWith({ where: { id: 600 } });
  });

  it("deleteEntry snapshot ide u audit PRE brisanja + briše dokumente ako postoje", async () => {
    const prisma = prismaMock();
    (prisma.techProcess.findUnique as jest.Mock).mockResolvedValue(
      tpRow({ id: 601, pieceCount: 5, documents: [{ id: 1 }] }),
    );
    const svc = await buildService(prisma);
    await svc.deleteEntry(601);

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = (prisma.auditLog.create as jest.Mock).mock.calls[0][0].data;
    expect(audit.action).toBe("DELETE tech-processes");
    expect(audit.beforeData).toMatchObject({ id: 601 });
    expect(prisma.techProcessDocument.deleteMany).toHaveBeenCalledWith({
      where: { techProcessId: 601 },
    });
  });
});

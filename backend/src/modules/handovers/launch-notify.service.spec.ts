import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  LaunchNotifyService,
  type LaunchNotifyInput,
} from "./launch-notify.service";

/**
 * Obaveštenje planerima o lansiranju (zahtev 016/26 + dopuna): mejl + zvonce,
 * idempotencija po `work_order_launches.id`, i „nikad ne obori lansiranje".
 */
function prismaMock() {
  return {
    workOrderLaunchNotification: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    predmetPlaner: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    project: { findUnique: jest.fn().mockResolvedValue(null) },
    customer: { findUnique: jest.fn().mockResolvedValue(null) },
    drawing: { findUnique: jest.fn().mockResolvedValue(null) },
    drawingHandover: { findUnique: jest.fn().mockResolvedValue(null) },
    worker: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

const WO = {
  id: 42,
  identNumber: "P100/7",
  variant: 0,
  projectId: 3,
  drawingNumber: "D-10",
  pieceCount: 4,
};

const INPUT: LaunchNotifyInput = {
  workOrder: WO,
  handoverId: 5,
  drawingId: 10,
  launchId: 900,
  actorWorkerId: 77,
  source: "work_order",
};

describe("LaunchNotifyService", () => {
  let service: LaunchNotifyService;
  let prisma: ReturnType<typeof prismaMock>;
  let mail: { send: jest.Mock };
  let notifications: { notifyWorkers: jest.Mock };

  beforeEach(async () => {
    prisma = prismaMock();
    mail = { send: jest.fn().mockResolvedValue(true) };
    notifications = { notifyWorkers: jest.fn().mockResolvedValue(2) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        LaunchNotifyService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailService, useValue: mail },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(LaunchNotifyService);
  });

  /** Dva planera: jedan sa vezanim radnikom (zvonce + mejl), jedan bez (samo mejl). */
  function mockTwoPlanners() {
    prisma.predmetPlaner.findMany.mockResolvedValue([
      { plannerUserId: 55 },
      { plannerUserId: 56 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      {
        id: 55,
        email: "planer@servoteh.com",
        fullName: "Planer Predmeta",
        workerId: 501,
      },
      {
        id: 56,
        email: "global@servoteh.com",
        fullName: "Global Planer",
        workerId: null,
      },
    ]);
    prisma.project.findUnique.mockResolvedValue({
      projectNumber: "9000",
      description: "Perun",
      customerId: 7,
    });
    prisma.drawing.findUnique.mockResolvedValue({
      name: "Ploča",
      drawingNumber: "D-10",
    });
    prisma.worker.findMany.mockResolvedValue([
      { id: 77, fullName: "Pera Tehnolog", username: "pera" },
    ]);
  }

  it("mejl + zvonce istim primaocima (predmet ∪ globalni); bez worker_id samo mejl", async () => {
    mockTwoPlanners();

    await service.notifyLaunch(INPUT);

    // OR filter = planeri predmeta 3 ∪ globalni (project_id IS NULL).
    expect(prisma.predmetPlaner.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ projectId: 3 }, { projectId: null }] },
      }) as unknown,
    );
    // Mejl: OBA planera.
    expect(mail.send).toHaveBeenCalledTimes(2);
    const mailCalls = mail.send.mock.calls as unknown as [{ to: string }][];
    const to = mailCalls.map((c) => c[0].to);
    expect(to).toEqual(
      expect.arrayContaining(["planer@servoteh.com", "global@servoteh.com"]),
    );
    // Zvonce: SAMO planer sa users.worker_id (kanal je worker-scoped).
    expect(notifications.notifyWorkers).toHaveBeenCalledTimes(1);
    const [workerIds, payload] = notifications.notifyWorkers.mock.calls[0] as [
      number[],
      { type: string; message: string; refTable: string; refId: number },
    ];
    expect(workerIds).toEqual([501]);
    expect(payload.type).toBe("primopredaja.lansirana");
    expect(payload.refTable).toBe("work_orders");
    expect(payload.refId).toBe(42);
    // Sadržaj = predmet (broj + naziv), RN, ko je lansirao + datum.
    expect(payload.message).toContain("P100/7");
    expect(payload.message).toContain("9000 — Perun");
    expect(payload.message).toContain("Pera Tehnolog");
  });

  it("ista primopredaja drugi put → ništa se ne šalje (idempotencija)", async () => {
    mockTwoPlanners();
    // Claim nije upisan (ON CONFLICT DO NOTHING) = neko je već poslao.
    prisma.workOrderLaunchNotification.createMany.mockResolvedValue({
      count: 0,
    });

    await service.notifyLaunch(INPUT);

    expect(prisma.predmetPlaner.findMany).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
  });

  it("claim se piše po ključu PRIMOPREDAJE (drawing_handover_id) sa skipDuplicates", async () => {
    mockTwoPlanners();

    await service.notifyLaunch(INPUT);

    // Ključ NIJE work_order_launches.id — taj SERIAL se reciklira (alignIdSequence
    // spušta sekvencu posle brisanja RN-a) i ponovno lansiranje istog RN-a dobija nov
    // red, pa bi zaštita čas gutala legitimno obaveštenje, čas puštala duplo.
    expect(prisma.workOrderLaunchNotification.createMany).toHaveBeenCalledWith({
      data: [
        {
          drawingHandoverId: INPUT.handoverId,
          workOrderLaunchId: 900,
          workOrderId: 42,
          source: "work_order",
        },
      ],
      skipDuplicates: true,
    });
  });

  it("posle uspešnog slanja upisuje notified_at (rupa ostaje vidljiva)", async () => {
    mockTwoPlanners();

    await service.notifyLaunch(INPUT);

    expect(prisma.workOrderLaunchNotification.updateMany).toHaveBeenCalledWith({
      where: { drawingHandoverId: INPUT.handoverId, notifiedAt: null },
      data: { notifiedAt: expect.any(Date) },
    });
  });

  it("pad mejla i pad zvonca ne bacaju (lansiranje je već komitovano)", async () => {
    mockTwoPlanners();
    mail.send.mockRejectedValue(new Error("smtp down"));
    notifications.notifyWorkers.mockRejectedValue(new Error("db down"));

    await expect(service.notifyLaunch(INPUT)).resolves.toBeUndefined();
    // Pad prvog mejla ne preskače drugog primaoca.
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it("pad claim upisa NE guta obaveštenje — šalje se svejedno", async () => {
    // Bolje jedan duplikat nego tiho izgubljeno obaveštenje: lansiranje se stvarno
    // desilo, a claim je samo zaštita od duplog slanja.
    mockTwoPlanners();
    prisma.workOrderLaunchNotification.createMany.mockRejectedValue(
      new Error("relation does not exist"),
    );

    await expect(service.notifyLaunch(INPUT)).resolves.toBeUndefined();
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it("bez dodeljenih planera ne šalje ništa", async () => {
    prisma.predmetPlaner.findMany.mockResolvedValue([]);

    await service.notifyLaunch(INPUT);

    expect(mail.send).not.toHaveBeenCalled();
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
  });

  it("bez prosleđenog drawingId dočitava crtež primopredaje", async () => {
    mockTwoPlanners();
    prisma.drawingHandover.findUnique.mockResolvedValue({ drawingId: 10 });

    await service.notifyLaunch({ ...INPUT, drawingId: undefined });

    expect(prisma.drawingHandover.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { drawingId: true },
    });
    expect(prisma.drawing.findUnique).toHaveBeenCalledWith({
      where: { id: 10 },
      select: { name: true, drawingNumber: true },
    });
  });
});

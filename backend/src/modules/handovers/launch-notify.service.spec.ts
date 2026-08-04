import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  LaunchNotifyService,
  type LaunchNotifyInput,
} from "./launch-notify.service";

/**
 * Obaveštenje o lansiranju NACRTA primopredaje (016/26 ČETVRTI krug — Strahinja
 * 04.08: „samo obaveštenje kad se lansira primopredaja za projekat i to je to").
 * `notifyLaunch` samo upisuje claim red sa razrešenim nacrtom; sweep šalje TAČNO
 * JEDNO obaveštenje po nacrtu — i to jednom zauvek, ne jednom po talasu.
 *
 * `work_order_launch_notifications` je mockovan kao DELJENI in-memory store — to
 * je ono što preživljava „restart" u testu (novi service nad ISTIM store-om =
 * novi proces nad istom bazom). Šta unit test NE pokriva: stvarnu DB
 * perzistenciju (migracija + prod), tajmer na 30 s (sweep se zove direktno) i
 * višeinstančni konkurentni sweep (prod je jedna instanca).
 */

interface StoreRow {
  id: number;
  drawingHandoverId: number;
  workOrderLaunchId: number | null;
  workOrderId: number;
  source: string;
  actorWorkerId: number | null;
  handoverDraftId: number | null;
  createdAt: Date;
  notifiedAt: Date | null;
}

function makeStore() {
  return { rows: [] as StoreRow[], nextId: 1 };
}
type Store = ReturnType<typeof makeStore>;

// ------------------------------------------------------------------ fixtures

/** primopredaja → crtež */
const HANDOVERS: Record<number, number> = { 5: 10, 6: 11, 7: 12, 8: 13, 9: 14 };
/** crtež → nacrt (drawing 13 NEMA stavku nacrta = nerazrešiva veza) */
const DRAW2DRAFT: Record<number, number> = { 10: 1, 11: 1, 12: 2, 14: 1 };
const DRAFTS: Record<number, { draftNumber: string; projectId: number }> = {
  1: { draftNumber: "G-260724-010", projectId: 3 },
  2: { draftNumber: "G-260729-012", projectId: 4 },
};
const WOS: Record<number, { projectId: number }> = {
  42: { projectId: 3 },
  43: { projectId: 3 },
  44: { projectId: 4 },
  45: { projectId: 3 },
};
const PROJECTS: Record<
  number,
  { projectNumber: string; customerId: number | null }
> = {
  3: { projectNumber: "9400/7", customerId: 7 },
  4: { projectNumber: "9010", customerId: null },
};
const CUSTOMERS: Record<number, { name: string }> = {
  7: { name: "14. OKTOBAR d.o.o. Kruševac" },
};

function prismaMock(store: Store) {
  const pending = (draftId: number | null) =>
    store.rows
      .filter((r) => r.notifiedAt === null && r.handoverDraftId === draftId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return {
    workOrderLaunchNotification: {
      createMany: jest.fn(
        (args: {
          data: {
            drawingHandoverId: number;
            workOrderLaunchId: number | null;
            workOrderId: number;
            source: string;
            actorWorkerId: number | null;
            handoverDraftId: number | null;
          }[];
        }) => {
          let count = 0;
          for (const d of args.data) {
            // skipDuplicates po UNIQUE(drawing_handover_id) — kao u bazi.
            if (
              store.rows.some(
                (r) => r.drawingHandoverId === d.drawingHandoverId,
              )
            )
              continue;
            store.rows.push({
              id: store.nextId++,
              drawingHandoverId: d.drawingHandoverId,
              workOrderLaunchId: d.workOrderLaunchId ?? null,
              workOrderId: d.workOrderId,
              source: d.source,
              actorWorkerId: d.actorWorkerId ?? null,
              handoverDraftId: d.handoverDraftId ?? null,
              createdAt: new Date(),
              notifiedAt: null,
            });
            count++;
          }
          return Promise.resolve({ count });
        },
      ),
      groupBy: jest.fn(() => {
        const groups = new Map<number | null, { min: Date; max: Date }>();
        for (const r of store.rows) {
          if (r.notifiedAt !== null) continue;
          const g = groups.get(r.handoverDraftId);
          if (!g)
            groups.set(r.handoverDraftId, {
              min: r.createdAt,
              max: r.createdAt,
            });
          else {
            if (r.createdAt < g.min) g.min = r.createdAt;
            if (r.createdAt > g.max) g.max = r.createdAt;
          }
        }
        return Promise.resolve(
          [...groups.entries()].map(([handoverDraftId, g]) => ({
            handoverDraftId,
            _min: { createdAt: g.min },
            _max: { createdAt: g.max },
          })),
        );
      }),
      findMany: jest.fn((args: { where: { handoverDraftId: number | null } }) =>
        Promise.resolve(
          pending(args.where.handoverDraftId).map((r) => ({
            id: r.id,
            drawingHandoverId: r.drawingHandoverId,
            workOrderId: r.workOrderId,
            actorWorkerId: r.actorWorkerId,
            createdAt: r.createdAt,
          })),
        ),
      ),
      count: jest.fn((args: { where: { handoverDraftId: number } }) =>
        Promise.resolve(
          store.rows.filter(
            (r) =>
              r.handoverDraftId === args.where.handoverDraftId &&
              r.notifiedAt !== null,
          ).length,
        ),
      ),
      updateMany: jest.fn(
        (args: {
          where: { id?: { in?: number[] } };
          data: { notifiedAt: Date };
        }) => {
          let count = 0;
          for (const r of store.rows) {
            if (args.where.id?.in && !args.where.id.in.includes(r.id)) continue;
            if (r.notifiedAt !== null) continue;
            r.notifiedAt = args.data.notifiedAt;
            count++;
          }
          return Promise.resolve({ count });
        },
      ),
    },
    drawingHandover: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(
          HANDOVERS[args.where.id] != null
            ? { drawingId: HANDOVERS[args.where.id] }
            : null,
        ),
      ),
    },
    handoverDraftItem: {
      findFirst: jest.fn((args: { where: { drawingId: number } }) =>
        Promise.resolve(
          DRAW2DRAFT[args.where.drawingId] != null
            ? { draftId: DRAW2DRAFT[args.where.drawingId] }
            : null,
        ),
      ),
    },
    handoverDraft: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(DRAFTS[args.where.id] ?? null),
      ),
    },
    workOrder: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(WOS[args.where.id] ?? null),
      ),
    },
    project: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(PROJECTS[args.where.id] ?? null),
      ),
    },
    customer: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(CUSTOMERS[args.where.id] ?? null),
      ),
    },
    predmetPlaner: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    worker: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 77, fullName: "Dragan Ristanić", username: "dragan" },
        ]),
    },
  };
}

const INPUT: LaunchNotifyInput = {
  workOrderId: 42,
  handoverId: 5,
  launchId: 900,
  actorWorkerId: 77,
  source: "work_order",
};

describe("LaunchNotifyService", () => {
  let store: Store;
  let service: LaunchNotifyService;
  let prisma: ReturnType<typeof prismaMock>;
  let mail: { send: jest.Mock };
  let notifications: { notifyWorkers: jest.Mock };

  async function buildService(sharedStore: Store): Promise<{
    service: LaunchNotifyService;
    prisma: ReturnType<typeof prismaMock>;
    mail: { send: jest.Mock };
    notifications: { notifyWorkers: jest.Mock };
  }> {
    const p = prismaMock(sharedStore);
    const m = { send: jest.fn().mockResolvedValue(true) };
    const n = { notifyWorkers: jest.fn().mockResolvedValue(1) };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        LaunchNotifyService,
        { provide: PrismaService, useValue: p },
        { provide: MailService, useValue: m },
        { provide: NotificationsService, useValue: n },
      ],
    }).compile();
    return {
      service: mod.get(LaunchNotifyService),
      prisma: p,
      mail: m,
      notifications: n,
    };
  }

  beforeEach(async () => {
    delete process.env.LAUNCH_NOTIFY_SILENCE_MS;
    delete process.env.LAUNCH_NOTIFY_MAX_WAIT_MS;
    store = makeStore();
    ({ service, prisma, mail, notifications } = await buildService(store));
    mockTwoPlanners();
  });

  /** Dva planera: predmetni sa vezanim radnikom (55) + globalni bez (56). */
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
  }

  /** „Ostari" sve pending redove za `ms` — kao da je vreme proteklo. */
  function age(ms: number) {
    for (const r of store.rows)
      if (r.notifiedAt === null)
        r.createdAt = new Date(r.createdAt.getTime() - ms);
  }

  function mailFor(to: string): { subject: string; html: string } {
    const calls = mail.send.mock.calls as unknown as [
      { to: string; subject: string; html: string },
    ][];
    const hit = calls.find((c) => c[0].to === to);
    expect(hit).toBeDefined();
    return hit![0];
  }

  it("claim nosi razrešen NACRT i ništa se ne šalje odmah", async () => {
    await service.notifyLaunch(INPUT);

    expect(prisma.workOrderLaunchNotification.createMany).toHaveBeenCalledWith({
      data: [
        {
          drawingHandoverId: 5,
          workOrderLaunchId: 900,
          workOrderId: 42,
          source: "work_order",
          actorWorkerId: 77,
          handoverDraftId: 1,
        },
      ],
      skipDuplicates: true,
    });
    expect(mail.send).not.toHaveBeenCalled();
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
    expect(store.rows[0].notifiedAt).toBeNull();
  });

  it("mejl nosi SAMO nacrt/predmet/komitent/lansirao — bez RN-a, pozicija i količina", async () => {
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();

    const m = mailFor("planer@servoteh.com");
    expect(m.subject).toBe(
      "Lansirana primopredaja — nacrt G-260724-010, predmet 9400/7",
    );
    expect(m.html).toContain("Primopredaja je lansirana u proizvodnju:");
    expect(m.html).toContain(
      "<strong>Nacrt primopredaje:</strong> G-260724-010",
    );
    expect(m.html).toContain("<strong>Predmet:</strong> 9400/7");
    expect(m.html).toContain(
      "<strong>Komitent:</strong> 14. OKTOBAR d.o.o. Kruševac",
    );
    expect(m.html).toContain("<strong>Lansirao:</strong> Dragan Ristanić");
    // „Ništa drugo" (04.08): nema RN broja, pozicije ni količine.
    expect(m.html).not.toContain("Radni nalog");
    expect(m.html).not.toContain("Pozicija");
    expect(m.html).not.toContain("kom<");
  });

  it("N pozicija istog nacrta → TAČNO jedan mejl po planeru", async () => {
    await service.notifyLaunch(INPUT); // nacrt 1
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 }); // nacrt 1

    await service.sweep(); // prozor još traje
    expect(mail.send).not.toHaveBeenCalled();

    age(200_000);
    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2); // 2 planera × 1 nacrt
    expect(notifications.notifyWorkers).toHaveBeenCalledTimes(1); // samo 55 ima radnika
    const [workerIds, payload] = notifications.notifyWorkers.mock.calls[0] as [
      number[],
      { type: string; message: string; refTable: string; refId: number },
    ];
    expect(workerIds).toEqual([501]);
    expect(payload.type).toBe("primopredaja.lansirana");
    expect(payload.refTable).toBe("work_orders");
    expect(payload.refId).toBe(42);
    expect(payload.message).toContain("nacrt G-260724-010");
    expect(store.rows.every((r) => r.notifiedAt !== null)).toBe(true);
  });

  it("JEZGRO 4. KRUGA: pozicije istog nacrta lansirane KASNIJE ne šalju drugi mejl", async () => {
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();
    expect(mail.send).toHaveBeenCalledTimes(2);

    // Dan kasnije, još pozicija ISTOG nacrta (izmereno: 32% nacrta se lansira
    // duže od dana — zato dedup mora da važi i van prozora tišine).
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 });
    await service.notifyLaunch({ ...INPUT, workOrderId: 45, handoverId: 9 });
    age(200_000);
    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2); // NIJEDAN novi mejl
    expect(store.rows).toHaveLength(3);
    expect(store.rows.every((r) => r.notifiedAt !== null)).toBe(true);
  });

  it("različiti nacrti → svaki svoje obaveštenje (i kad je isti akter)", async () => {
    await service.notifyLaunch(INPUT); // nacrt 1, predmet 9400/7
    await service.notifyLaunch({ ...INPUT, workOrderId: 44, handoverId: 7 }); // nacrt 2, predmet 9010
    age(200_000);

    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(4); // 2 nacrta × 2 planera
    const subjects = (
      mail.send.mock.calls as unknown as [{ subject: string }][]
    ).map((c) => c[0].subject);
    expect(subjects.filter((s) => s.includes("G-260724-010")).length).toBe(2);
    expect(subjects.filter((s) => s.includes("G-260729-012")).length).toBe(2);
  });

  it("isti akter NIJE ključ: dva aktera na istom nacrtu = jedan mejl", async () => {
    await service.notifyLaunch(INPUT); // akter 77
    await service.notifyLaunch({
      ...INPUT,
      workOrderId: 43,
      handoverId: 6,
      actorWorkerId: 88,
    });
    age(200_000);

    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2); // jedan nacrt → jedno obaveštenje
  });

  it("rutira se po predmetu NACRTA (∪ globalni planeri)", async () => {
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();

    expect(prisma.predmetPlaner.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ projectId: 3 }, { projectId: null }] },
      }),
    );
  });

  it("ista primopredaja drugi put (drugi ekran/retry) → jedan red, jedan mejl", async () => {
    await service.notifyLaunch(INPUT);
    await service.notifyLaunch({ ...INPUT, source: "handover", launchId: 950 });

    expect(store.rows).toHaveLength(1);
    age(200_000);
    await service.sweep();
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it("restart usred prozora ne gubi obaveštenje (pending redovi žive u bazi)", async () => {
    await service.notifyLaunch(INPUT);
    expect(mail.send).not.toHaveBeenCalled();

    // „Restart": NOVI service (novi proces) nad ISTIM store-om (ista baza).
    const b = await buildService(store);
    b.prisma.predmetPlaner.findMany.mockResolvedValue([{ plannerUserId: 55 }]);
    b.prisma.user.findMany.mockResolvedValue([
      {
        id: 55,
        email: "planer@servoteh.com",
        fullName: "Planer Predmeta",
        workerId: 501,
      },
    ]);
    age(200_000);
    await b.service.sweep();

    expect(b.mail.send).toHaveBeenCalledTimes(1);
    const bCalls = b.mail.send.mock.calls as unknown as [{ html: string }][];
    expect(bCalls[0][0].html).toContain("G-260724-010");
  });

  it("nalet koji ne prestaje se ipak šalje kad najstariji red probije kapu", async () => {
    process.env.LAUNCH_NOTIFY_MAX_WAIT_MS = "300000";
    await service.notifyLaunch(INPUT);
    age(400_000); // stari red preko kape…
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 }); // …svež drži tišinu

    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it("nerazrešiv nacrt → obaveštenje po POZICIJI (degradacija), ne spojeno", async () => {
    // primopredaja 8 → crtež 13 → nema stavke nacrta; predmet iz RN-a.
    await service.notifyLaunch({ ...INPUT, workOrderId: 45, handoverId: 8 });
    expect(store.rows[0].handoverDraftId).toBeNull();
    age(200_000);

    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2);
    const m = mailFor("planer@servoteh.com");
    expect(m.html).toContain("<strong>Nacrt primopredaje:</strong> —");
    expect(m.html).toContain("<strong>Predmet:</strong> 9400/7"); // iz work_orders
  });

  it("pad claim upisa NE guta obaveštenje — šalje se odmah (fail-open)", async () => {
    prisma.workOrderLaunchNotification.createMany.mockRejectedValueOnce(
      new Error("relation does not exist"),
    );

    await expect(service.notifyLaunch(INPUT)).resolves.toBeUndefined();

    expect(mail.send).toHaveBeenCalledTimes(2);
    expect(
      prisma.workOrderLaunchNotification.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("pad mejla i zvonca ne baca; redovi se markiraju", async () => {
    mail.send.mockRejectedValue(new Error("smtp down"));
    notifications.notifyWorkers.mockRejectedValue(new Error("db down"));
    await service.notifyLaunch(INPUT);
    age(200_000);

    await expect(service.sweep()).resolves.toBeUndefined();

    expect(mail.send).toHaveBeenCalledTimes(2); // pad prvog ne preskače drugog
    expect(store.rows[0].notifiedAt).not.toBeNull();
  });

  it("bez dodeljenih planera redovi se markiraju bez slanja", async () => {
    prisma.predmetPlaner.findMany.mockResolvedValue([]);
    await service.notifyLaunch(INPUT);
    age(200_000);

    await service.sweep();

    expect(mail.send).not.toHaveBeenCalled();
    expect(store.rows[0].notifiedAt).not.toBeNull();
  });

  it("nerazrešiv nacrt I obrisan RN → red se markira, sweep ne puca", async () => {
    await service.notifyLaunch({ ...INPUT, workOrderId: 999, handoverId: 8 });
    age(200_000);

    await expect(service.sweep()).resolves.toBeUndefined();

    expect(mail.send).not.toHaveBeenCalled();
    expect(store.rows[0].notifiedAt).not.toBeNull();
  });
});

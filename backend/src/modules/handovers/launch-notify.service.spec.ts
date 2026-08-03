import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  LaunchNotifyService,
  type LaunchNotifyInput,
} from "./launch-notify.service";

/**
 * Zbirno obaveštenje planerima o lansiranju (016/26 treći krug — Strahinja:
 * „samo za nacrt kad se lansira, ne po pozicijama"): notifyLaunch SAMO upisuje
 * claim red (idempotencija po primopredaji ostaje), a sweep šalje JEDAN mejl +
 * zvonce po planeru kad talas utihne.
 *
 * `work_order_launch_notifications` je mockovan kao DELJENI in-memory store —
 * to je ono što preživljava „restart" u testu (novi service nad ISTIM store-om
 * = novi proces nad istom bazom). Šta unit test NE pokriva: stvarnu DB
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
  createdAt: Date;
  notifiedAt: Date | null;
}

function makeStore() {
  return { rows: [] as StoreRow[], nextId: 1 };
}
type Store = ReturnType<typeof makeStore>;

/** `findMany` koji poštuje `where.id.in` (dovoljno za lookup-ove servisa). */
function listByIds(rows: { id: number }[]) {
  return jest.fn((args?: { where?: { id?: { in?: number[] } } }) => {
    const ids = args?.where?.id?.in;
    return Promise.resolve(ids ? rows.filter((r) => ids.includes(r.id)) : rows);
  });
}

// ------------------------------------------------------------------ fixtures

const WOS = [
  {
    id: 42,
    identNumber: "P100/7",
    variant: 0,
    projectId: 3,
    drawingNumber: "D-10",
    pieceCount: 4,
  },
  {
    id: 43,
    identNumber: "P100/8",
    variant: 0,
    projectId: 3,
    drawingNumber: "D-11",
    pieceCount: 2,
  },
  {
    id: 44,
    identNumber: "P200/1",
    variant: 0,
    projectId: 4,
    drawingNumber: "D-20",
    pieceCount: 1,
  },
];
const HANDOVERS = [
  { id: 5, drawingId: 10 },
  { id: 6, drawingId: 11 },
  { id: 7, drawingId: 12 },
];
const DRAWINGS = [
  { id: 10, name: "Ploča", drawingNumber: "D-10" },
  { id: 11, name: "Osovina", drawingNumber: "D-11" },
  { id: 12, name: "Nosač", drawingNumber: "D-20" },
];
const PROJECTS = [
  { id: 3, projectNumber: "9000", description: "Perun", customerId: 7 },
  { id: 4, projectNumber: "9010", description: "Vila", customerId: null },
];
const CUSTOMERS = [{ id: 7, name: "Komitent X" }];

function prismaMock(store: Store) {
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
          const g = groups.get(r.actorWorkerId);
          if (!g)
            groups.set(r.actorWorkerId, { min: r.createdAt, max: r.createdAt });
          else {
            if (r.createdAt < g.min) g.min = r.createdAt;
            if (r.createdAt > g.max) g.max = r.createdAt;
          }
        }
        return Promise.resolve(
          [...groups.entries()].map(([actorWorkerId, g]) => ({
            actorWorkerId,
            _min: { createdAt: g.min },
            _max: { createdAt: g.max },
          })),
        );
      }),
      findMany: jest.fn((args: { where: { actorWorkerId: number | null } }) => {
        const rows = store.rows
          .filter(
            (r) =>
              r.notifiedAt === null &&
              r.actorWorkerId === args.where.actorWorkerId,
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((r) => ({
            id: r.id,
            drawingHandoverId: r.drawingHandoverId,
            workOrderId: r.workOrderId,
          }));
        return Promise.resolve(rows);
      }),
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
    workOrder: { findMany: listByIds(WOS) },
    predmetPlaner: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    drawingHandover: { findMany: listByIds(HANDOVERS) },
    project: { findMany: listByIds(PROJECTS) },
    drawing: { findMany: listByIds(DRAWINGS) },
    customer: { findMany: listByIds(CUSTOMERS) },
    worker: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 77, fullName: "Pera Tehnolog", username: "pera" },
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
      { plannerUserId: 55, projectId: 3 },
      { plannerUserId: 56, projectId: null },
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

  it("claim se piše po ključu primopredaje sa akterom (agregacija), bez trenutnog slanja", async () => {
    await service.notifyLaunch(INPUT);

    expect(prisma.workOrderLaunchNotification.createMany).toHaveBeenCalledWith({
      data: [
        {
          drawingHandoverId: 5,
          workOrderLaunchId: 900,
          workOrderId: 42,
          source: "work_order",
          actorWorkerId: 77,
        },
      ],
      skipDuplicates: true,
    });
    // 016/26 treći krug: NIŠTA ne izlazi dok talas ne utihne.
    expect(mail.send).not.toHaveBeenCalled();
    expect(notifications.notifyWorkers).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].notifiedAt).toBeNull();
  });

  it("talas od N primopredaja istog aktera → TAČNO jedan mejl po planeru sa svih N pozicija", async () => {
    await service.notifyLaunch(INPUT);
    await service.notifyLaunch({
      ...INPUT,
      workOrderId: 43,
      handoverId: 6,
      launchId: 901,
    });

    // Prozor tišine još traje → sweep ne šalje ništa.
    await service.sweep();
    expect(mail.send).not.toHaveBeenCalled();

    age(200_000); // > default 180 s tišine
    await service.sweep();

    // JEDAN mejl po planeru (2 planera), NE po poziciji.
    expect(mail.send).toHaveBeenCalledTimes(2);
    const planerMail = mailFor("planer@servoteh.com");
    expect(planerMail.subject).toBe("Lansirano 2 RN — predmet 9000");
    expect(planerMail.html).toContain("P100/7");
    expect(planerMail.html).toContain("P100/8");
    expect(planerMail.html).toContain("Ploča");
    expect(planerMail.html).toContain("4 kom");
    expect(planerMail.html).toContain("Pera Tehnolog");
    // JEDNO zvonce (samo planer 55 ima vezanog radnika), zbirni tekst.
    expect(notifications.notifyWorkers).toHaveBeenCalledTimes(1);
    const [workerIds, payload] = notifications.notifyWorkers.mock.calls[0] as [
      number[],
      { type: string; message: string; refTable: string; refId: number },
    ];
    expect(workerIds).toEqual([501]);
    expect(payload.type).toBe("primopredaja.lansirana");
    expect(payload.refTable).toBe("work_orders");
    expect(payload.refId).toBe(42); // prvi RN talasa
    expect(payload.message).toContain("Lansirano 2 RN");
    // Redovi markirani; ponovni sweep ne šalje ništa.
    expect(store.rows.every((r) => r.notifiedAt !== null)).toBe(true);
    await service.sweep();
    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  it("dva odvojena talasa → dva mejla", async () => {
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();
    expect(mail.send).toHaveBeenCalledTimes(2); // talas 1 × 2 planera

    // Novi talas posle tišine — svež red se NE šalje odmah…
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 });
    await service.sweep();
    expect(mail.send).toHaveBeenCalledTimes(2);
    // …nego kad i njegov prozor istekne.
    age(200_000);
    await service.sweep();
    expect(mail.send).toHaveBeenCalledTimes(4);
  });

  it("pojedinačno lansiranje → mejl u dosadašnjem formatu (poznat korisnicima)", async () => {
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();

    const m = mailFor("planer@servoteh.com");
    expect(m.subject).toBe("Lansiran RN P100/7 — predmet 9000");
    expect(m.html).toContain("<strong>Radni nalog:</strong> P100/7");
    expect(m.html).toContain("<strong>Predmet:</strong> 9000 — Perun");
    expect(m.html).toContain("<strong>Komitent:</strong> Komitent X");
    expect(m.html).toContain("<strong>Pozicija:</strong> Ploča, D-10");
    expect(m.html).toContain("<strong>Količina:</strong> 4 kom");
    const [, payload] = notifications.notifyWorkers.mock.calls[0] as [
      number[],
      { message: string; refId: number },
    ];
    expect(payload.message).toContain("Lansiran RN P100/7");
    expect(payload.refId).toBe(42);
  });

  it("ista primopredaja drugi put (drugi ekran/retry) → jedan red, jedna pozicija u mejlu", async () => {
    await service.notifyLaunch(INPUT);
    await service.notifyLaunch({ ...INPUT, source: "handover", launchId: 950 });

    expect(store.rows).toHaveLength(1); // idempotencija claim-a netaknuta
    age(200_000);
    await service.sweep();
    expect(mail.send).toHaveBeenCalledTimes(2); // po planeru, ne po pozivu
    expect(mailFor("planer@servoteh.com").subject).toMatch(
      /^Lansiran RN P100\/7/,
    );
  });

  it("restart usred prozora ne gubi obaveštenje (pending redovi žive u bazi)", async () => {
    await service.notifyLaunch(INPUT);
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 });
    expect(mail.send).not.toHaveBeenCalled();

    // „Restart": NOVI service (novi proces) nad ISTIM store-om (ista baza).
    const b = await buildService(store);
    b.prisma.predmetPlaner.findMany.mockResolvedValue([
      { plannerUserId: 55, projectId: 3 },
    ]);
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
    const html = bCalls[0][0].html;
    expect(html).toContain("P100/7");
    expect(html).toContain("P100/8");
  });

  it("talas koji ne prestaje se ipak šalje kad najstariji red probije kapu", async () => {
    process.env.LAUNCH_NOTIFY_MAX_WAIT_MS = "300000";
    await service.notifyLaunch(INPUT);
    age(400_000); // stari red preko kape…
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 }); // …svež red drži tišinu

    await service.sweep();

    // Tišina NIJE istekla (poslednji red je svež), ali kapa jeste → šalje se SVE.
    expect(mail.send).toHaveBeenCalledTimes(2);
    expect(mailFor("planer@servoteh.com").subject).toBe(
      "Lansirano 2 RN — predmet 9000",
    );
  });

  it("preko 30 pozicija: prikaz prvih 30 plus rep sa brojem ostalih", async () => {
    const many = Array.from({ length: 35 }, (_, i) => ({
      id: 1000 + i,
      identNumber: `P100/${i + 1}`,
      variant: 0,
      projectId: 3,
      drawingNumber: `D-${i}`,
      pieceCount: 1,
    }));
    prisma.workOrder.findMany = listByIds(many);
    for (let i = 0; i < 35; i++)
      await service.notifyLaunch({
        ...INPUT,
        workOrderId: 1000 + i,
        handoverId: 500 + i,
      });

    age(200_000);
    await service.sweep();

    const html = mailFor("planer@servoteh.com").html;
    expect(html).toContain("Lansirano je 35 radnih naloga");
    expect(html).toContain("i još 5 pozicija");
    expect(html).toContain("<strong>P100/30</strong>"); // 30. pozicija prikazana
    expect(html).not.toContain("<strong>P100/31</strong>"); // 31. isečena iz liste
  });

  it("planer predmeta dobija SAMO svoje pozicije; globalni planer sve", async () => {
    prisma.predmetPlaner.findMany.mockResolvedValue([
      { plannerUserId: 55, projectId: 3 },
      { plannerUserId: 57, projectId: 4 },
      { plannerUserId: 56, projectId: null },
    ]);
    prisma.user.findMany.mockResolvedValue([
      {
        id: 55,
        email: "planer@servoteh.com",
        fullName: "Planer 9000",
        workerId: 501,
      },
      {
        id: 57,
        email: "planer2@servoteh.com",
        fullName: "Planer 9010",
        workerId: null,
      },
      {
        id: 56,
        email: "global@servoteh.com",
        fullName: "Global",
        workerId: null,
      },
    ]);
    await service.notifyLaunch(INPUT); // proj 3
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 }); // proj 3
    await service.notifyLaunch({ ...INPUT, workOrderId: 44, handoverId: 7 }); // proj 4

    age(200_000);
    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(3);
    const m55 = mailFor("planer@servoteh.com");
    expect(m55.subject).toBe("Lansirano 2 RN — predmet 9000");
    expect(m55.html).toContain("P100/7");
    expect(m55.html).not.toContain("P200/1");
    const m57 = mailFor("planer2@servoteh.com");
    expect(m57.subject).toBe("Lansiran RN P200/1 — predmet 9010");
    expect(m57.html).not.toContain("P100/7");
    const m56 = mailFor("global@servoteh.com");
    expect(m56.subject).toBe("Lansirano 3 RN — predmeti 9000, 9010");
    expect(m56.html).toContain("P100/7");
    expect(m56.html).toContain("P200/1");
    expect(m56.html).toContain("(predmet 9000)"); // više predmeta → sufiks po poziciji
  });

  it("pad claim upisa NE guta obaveštenje — šalje se odmah pojedinačno (fail-open)", async () => {
    prisma.workOrderLaunchNotification.createMany.mockRejectedValueOnce(
      new Error("relation does not exist"),
    );

    await expect(service.notifyLaunch(INPUT)).resolves.toBeUndefined();

    // Bolje jedan (potencijalno dupli) mejl nego tiho izgubljen.
    expect(mail.send).toHaveBeenCalledTimes(2);
    // Nema claim reda → nema šta da se markira.
    expect(
      prisma.workOrderLaunchNotification.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("pad mejla i zvonca ne baca; redovi se markiraju (kao i do sada posle pokušaja)", async () => {
    mail.send.mockRejectedValue(new Error("smtp down"));
    notifications.notifyWorkers.mockRejectedValue(new Error("db down"));
    await service.notifyLaunch(INPUT);
    age(200_000);

    await expect(service.sweep()).resolves.toBeUndefined();

    // Pad prvog mejla ne preskače drugog primaoca.
    expect(mail.send).toHaveBeenCalledTimes(2);
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

  it("RN obrisan pre flush-a → red se markira, sweep ne puca", async () => {
    await service.notifyLaunch({ ...INPUT, workOrderId: 999, handoverId: 66 });
    age(200_000);

    await expect(service.sweep()).resolves.toBeUndefined();

    expect(mail.send).not.toHaveBeenCalled();
    expect(store.rows[0].notifiedAt).not.toBeNull();
  });

  it("različiti akteri su različiti talasi (svako svoj zbirni mejl)", async () => {
    await service.notifyLaunch(INPUT); // akter 77
    await service.notifyLaunch({
      ...INPUT,
      workOrderId: 43,
      handoverId: 6,
      actorWorkerId: 88,
    });
    age(200_000);

    await service.sweep();

    // 2 grupe × 2 planera = 4 mejla, svaki sa JEDNOM pozicijom.
    expect(mail.send).toHaveBeenCalledTimes(4);
    const subjects = (
      mail.send.mock.calls as unknown as [{ subject: string }][]
    ).map((c) => c[0].subject);
    expect(
      subjects.filter((s) => s.startsWith("Lansiran RN P100/7")),
    ).toHaveLength(2);
    expect(
      subjects.filter((s) => s.startsWith("Lansiran RN P100/8")),
    ).toHaveLength(2);
  });
});

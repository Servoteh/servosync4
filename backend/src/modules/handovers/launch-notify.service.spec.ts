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
 *
 * Testovi pinuju i tri REVIEW-BLOKERA (veza crtež→nacrt nema FK i dvosmislena je
 * za 9,8% crteža, pa dedup sme SAMO na sigurnom):
 *   • dvosmislen crtež → NEMA dedupa po nacrtu (ide po poziciji);
 *   • nacrt drugog predmeta → ne ruta tuđim planerima;
 *   • neuspela isporuka → red ostaje na čekanju, sledeći tik pokušava ponovo.
 *
 * `work_order_launch_notifications` je mockovan kao DELJENI in-memory store — to
 * je ono što preživljava „restart" u testu. Šta unit test NE pokriva: stvarnu DB
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
  sentAt: Date | null;
}

function makeStore() {
  return { rows: [] as StoreRow[], nextId: 1 };
}
type Store = ReturnType<typeof makeStore>;

// ------------------------------------------------------------------ fixtures

/** primopredaja → crtež */
const HANDOVERS: Record<number, number> = {
  5: 10,
  6: 11,
  7: 12,
  8: 13, // crtež bez ijedne stavke nacrta
  9: 14,
  20: 30, // DVOSMISLEN crtež (u dva nacrta)
  21: 31, // nacrt DRUGOG predmeta
};
/** crtež → SVI ne-isključeni nacrti koji ga sadrže (veza nema FK!) */
const DRAW2DRAFTS: Record<number, number[]> = {
  10: [1],
  11: [1],
  12: [2],
  14: [1],
  30: [1, 2], // dvosmisleno
  31: [3], // jednoznačno, ali nacrt je na predmetu 5, a RN na 3
};
const DRAFTS: Record<number, { draftNumber: string; projectId: number }> = {
  1: { draftNumber: "G-260724-010", projectId: 3 },
  2: { draftNumber: "G-260729-012", projectId: 4 },
  3: { draftNumber: "G-0001/20", projectId: 5 },
};
const WO_REFS: Record<
  number,
  {
    id: number;
    identNumber: string;
    variant: number;
    projectId: number;
    drawingNumber: string | null;
    pieceCount: number | null;
  }
> = {
  42: {
    id: 42,
    identNumber: "P100/7",
    variant: 0,
    projectId: 3,
    drawingNumber: "D-10",
    pieceCount: 4,
  },
  43: {
    id: 43,
    identNumber: "P100/8",
    variant: 0,
    projectId: 3,
    drawingNumber: "D-11",
    pieceCount: 2,
  },
  44: {
    id: 44,
    identNumber: "P200/1",
    variant: 0,
    projectId: 4,
    drawingNumber: "D-12",
    pieceCount: 1,
  },
  45: {
    id: 45,
    identNumber: "P100/9",
    variant: 0,
    projectId: 3,
    drawingNumber: "D-14",
    pieceCount: 3,
  },
  60: {
    id: 60,
    identNumber: "P100/30",
    variant: 0,
    projectId: 3,
    drawingNumber: "D-30",
    pieceCount: 5,
  },
  61: {
    id: 61,
    identNumber: "P100/31",
    variant: 0,
    projectId: 3,
    drawingNumber: "D-31",
    pieceCount: 6,
  },
};
const PROJECTS: Record<
  number,
  {
    projectNumber: string;
    description: string | null;
    customerId: number | null;
  }
> = {
  3: {
    projectNumber: "9400/7",
    description: "Konvejer",
    customerId: 7,
  },
  4: { projectNumber: "9010", description: null, customerId: null },
  5: { projectNumber: "9970", description: "Tuđi predmet", customerId: null },
};
const CUSTOMERS: Record<number, { name: string }> = {
  7: { name: "14. OKTOBAR d.o.o. Kruševac" },
};
const DRAWINGS: Record<
  number,
  { name: string | null; drawingNumber: string | null }
> = {
  10: { name: "Ploča", drawingNumber: "D-10" },
  13: { name: "Nosač", drawingNumber: "D-13" },
  30: { name: "Poklopac", drawingNumber: "D-30" },
  31: { name: "Osovina", drawingNumber: "D-31" },
};

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
              sentAt: null,
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
          store.rows
            .filter(
              (r) =>
                r.notifiedAt === null &&
                r.handoverDraftId === args.where.handoverDraftId,
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((r) => ({
              id: r.id,
              drawingHandoverId: r.drawingHandoverId,
              workOrderId: r.workOrderId,
              actorWorkerId: r.actorWorkerId,
              createdAt: r.createdAt,
            })),
        ),
      ),
      // Dedup broji SAMO isporučene redove (sent_at), nikad „obrađene".
      count: jest.fn((args: { where: { handoverDraftId: number } }) =>
        Promise.resolve(
          store.rows.filter(
            (r) =>
              r.handoverDraftId === args.where.handoverDraftId &&
              r.sentAt !== null,
          ).length,
        ),
      ),
      updateMany: jest.fn(
        (args: {
          where: { id?: { in?: number[] } };
          data: { notifiedAt: Date; sentAt?: Date };
        }) => {
          let count = 0;
          for (const r of store.rows) {
            if (args.where.id?.in && !args.where.id.in.includes(r.id)) continue;
            if (r.notifiedAt !== null) continue;
            r.notifiedAt = args.data.notifiedAt;
            if (args.data.sentAt) r.sentAt = args.data.sentAt;
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
      findMany: jest.fn((args: { where: { drawingId: number } }) =>
        Promise.resolve(
          (DRAW2DRAFTS[args.where.drawingId] ?? []).map((draftId) => ({
            draftId,
          })),
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
        Promise.resolve(
          WO_REFS[args.where.id]
            ? { projectId: WO_REFS[args.where.id].projectId }
            : null,
        ),
      ),
      findMany: jest.fn((args: { where: { id: { in: number[] } } }) =>
        Promise.resolve(
          args.where.id.in.map((id) => WO_REFS[id]).filter(Boolean),
        ),
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
    drawing: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(DRAWINGS[args.where.id] ?? null),
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

  /** Dva planera predmeta 3: sa vezanim radnikom (55) + globalni bez (56). */
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

  // ────────────────────────────────────────────── osnovno ponašanje (nacrt)

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
    await service.notifyLaunch(INPUT);
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 });

    await service.sweep(); // prozor još traje
    expect(mail.send).not.toHaveBeenCalled();

    age(200_000);
    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2); // 2 planera × 1 nacrt
    expect(notifications.notifyWorkers).toHaveBeenCalledTimes(1);
    const [workerIds, payload] = notifications.notifyWorkers.mock.calls[0] as [
      number[],
      { type: string; message: string; refTable: string; refId: number },
    ];
    expect(workerIds).toEqual([501]);
    expect(payload.type).toBe("primopredaja.lansirana");
    expect(payload.refId).toBe(42);
    expect(payload.message).toContain("nacrt G-260724-010");
    expect(store.rows.every((r) => r.sentAt !== null)).toBe(true);
  });

  it("JEZGRO 4. KRUGA: pozicije istog nacrta lansirane KASNIJE ne šalju drugi mejl", async () => {
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();
    expect(mail.send).toHaveBeenCalledTimes(2);

    // Dan kasnije, još pozicija ISTOG nacrta (izmereno: 32% nacrta se lansira
    // duže od dana — dedup mora da važi i van prozora tišine).
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 });
    await service.notifyLaunch({ ...INPUT, workOrderId: 45, handoverId: 9 });
    age(200_000);
    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2); // NIJEDAN novi mejl
    expect(store.rows).toHaveLength(3);
    expect(store.rows.every((r) => r.notifiedAt !== null)).toBe(true);
  });

  it("različiti nacrti → svaki svoje obaveštenje (i kad je isti akter)", async () => {
    prisma.predmetPlaner.findMany.mockResolvedValue([{ plannerUserId: 55 }]);
    prisma.user.findMany.mockResolvedValue([
      { id: 55, email: "planer@servoteh.com", fullName: "P", workerId: null },
    ]);
    await service.notifyLaunch(INPUT); // nacrt 1
    await service.notifyLaunch({ ...INPUT, workOrderId: 44, handoverId: 7 }); // nacrt 2
    age(200_000);

    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2);
    const subjects = (
      mail.send.mock.calls as unknown as [{ subject: string }][]
    ).map((c) => c[0].subject);
    expect(subjects.some((s) => s.includes("G-260724-010"))).toBe(true);
    expect(subjects.some((s) => s.includes("G-260729-012"))).toBe(true);
  });

  it("isti akter NIJE ključ: dva aktera na istom nacrtu = jedan mejl", async () => {
    await service.notifyLaunch(INPUT);
    await service.notifyLaunch({
      ...INPUT,
      workOrderId: 43,
      handoverId: 6,
      actorWorkerId: 88,
    });
    age(200_000);

    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2);
  });

  // ───────────────────────────────── REVIEW-BLOKERI: dedup samo na sigurnom

  it("BLOKER 1: DVOSMISLEN crtež (u dva nacrta) → NEMA dedupa po nacrtu", async () => {
    // Crtež 30 je u nacrtima 1 i 2 — pogrešan pogodak bi TRAJNO ućutkao tuđi
    // nacrt, pa se claim upisuje BEZ nacrta i obaveštenje ide po poziciji.
    await service.notifyLaunch({ ...INPUT, workOrderId: 60, handoverId: 20 });

    expect(store.rows[0].handoverDraftId).toBeNull();
    age(200_000);
    await service.sweep();

    const m = mailFor("planer@servoteh.com");
    expect(m.subject).toBe("Lansiran RN P100/30 — predmet 9400/7");
    // Kad nacrt NIJE siguran, o nacrtu se ni ne govori (nikad „Nacrt: —").
    expect(m.html).not.toContain("Nacrt primopredaje");
    expect(m.html).toContain("<strong>Radni nalog:</strong> P100/30");
    expect(m.html).toContain("<strong>Pozicija:</strong> Poklopac, D-30");
  });

  it("BLOKER 1b: dvosmislen crtež NE zapečaćuje nacrt u koji bi pogrešno pao", async () => {
    await service.notifyLaunch({ ...INPUT, workOrderId: 60, handoverId: 20 });
    age(200_000);
    await service.sweep();
    expect(mail.send).toHaveBeenCalledTimes(2);

    // Nacrt 1 i dalje ima pravo na SVOJE obaveštenje.
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(4);
    const subjects = (
      mail.send.mock.calls as unknown as [{ subject: string }][]
    ).map((c) => c[0].subject);
    expect(subjects.some((s) => s.includes("G-260724-010"))).toBe(true);
  });

  it("BLOKER 2: nacrt DRUGOG predmeta → ne ruta tuđim planerima, predmet iz RN-a", async () => {
    // Crtež 31 jednoznačno vodi u nacrt 3, ali taj nacrt je na predmetu 5 (9970),
    // a RN je na predmetu 3 (9400/7) — veza se ne poklapa → bez dedupa.
    await service.notifyLaunch({ ...INPUT, workOrderId: 61, handoverId: 21 });

    expect(store.rows[0].handoverDraftId).toBeNull();
    age(200_000);
    await service.sweep();

    // Rutiranje po RN-u: predmet 3, NIKAD 5.
    expect(prisma.predmetPlaner.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ projectId: { in: [3] } }, { projectId: null }] },
      }),
    );
    const m = mailFor("planer@servoteh.com");
    expect(m.html).toContain("9400/7");
    expect(m.html).not.toContain("9970");
    expect(m.html).not.toContain("Tuđi predmet");
  });

  it("BLOKER 3: neuspela isporuka NE markira redove — sledeći tik pokušava ponovo", async () => {
    // ⚠️ `MailService.send` NIKAD NE BACA — vraća `false` (DRY-RUN bez API
    // ključa, Resend non-2xx, mrežni pad/timeout). Mock MORA da bude
    // `mockResolvedValue(false)`: sa `mockRejectedValue` test bi prošao i kad
    // kod ignoriše povratnu vrednost, pa ne bi hvatao pravi produkcijski bug.
    mail.send.mockResolvedValue(false);
    notifications.notifyWorkers.mockResolvedValue(0);
    await service.notifyLaunch(INPUT);
    age(200_000);

    await expect(service.sweep()).resolves.toBeUndefined();

    // Primaoci postoje, ali ništa nije prošlo → red OSTAJE na čekanju.
    expect(store.rows[0].notifiedAt).toBeNull();
    expect(store.rows[0].sentAt).toBeNull();

    // Resend se oporavio — sledeći tik isporučuje.
    mail.send.mockResolvedValue(true);
    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(4); // 2 pala + 2 uspela
    expect(store.rows[0].sentAt).not.toBeNull();
  });

  it("BLOKER 3c: mejl koji vrati FALSE ne sme da zapečati nacrt (send ne baca!)", async () => {
    // Tačan produkcijski scenario: RESEND_API_KEY nije podešen → DRY-RUN →
    // `send` resolve-uje `false`. Bez provere povratne vrednosti kod bi upisao
    // sent_at i nacrt bi zauvek ostao nem, a nijedan mejl nije otišao.
    mail.send.mockResolvedValue(false);
    notifications.notifyWorkers.mockResolvedValue(0);
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();

    expect(store.rows[0].sentAt).toBeNull();

    // Ključni dokaz: nacrt NIJE zapečaćen — kad kanal proradi, obaveštenje ide.
    mail.send.mockResolvedValue(true);
    notifications.notifyWorkers.mockResolvedValue(1);
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 });
    age(200_000);
    await service.sweep();

    expect(mailFor("planer@servoteh.com").subject).toContain("G-260724-010");
    expect(store.rows.some((r) => r.sentAt !== null)).toBe(true);
  });

  it("zvonce sa 0 upisanih redova se NE broji kao isporuka", async () => {
    // `notifyWorkers` vraća BROJ upisanih redova; 0 = niko nije obavešten.
    mail.send.mockResolvedValue(false);
    notifications.notifyWorkers.mockResolvedValue(0);
    await service.notifyLaunch(INPUT);
    age(200_000);

    await service.sweep();

    expect(store.rows[0].sentAt).toBeNull();
    expect(store.rows[0].notifiedAt).toBeNull(); // ostaje za sledeći pokušaj
  });

  it("BLOKER 3b: obrađeno-bez-isporuke NE pečati nacrt (nema planera, pa ih dobije)", async () => {
    prisma.predmetPlaner.findMany.mockResolvedValue([]);
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();

    expect(mail.send).not.toHaveBeenCalled();
    expect(store.rows[0].notifiedAt).not.toBeNull(); // obrađeno…
    expect(store.rows[0].sentAt).toBeNull(); // …ali NIJE isporučeno

    // Planeri su u međuvremenu dodeljeni; sledeća pozicija istog nacrta JAVLJA.
    mockTwoPlanners();
    await service.notifyLaunch({ ...INPUT, workOrderId: 43, handoverId: 6 });
    age(200_000);
    await service.sweep();

    expect(mail.send).toHaveBeenCalledTimes(2);
    expect(mailFor("planer@servoteh.com").subject).toContain("G-260724-010");
  });

  // ───────────────────────────────────────────────────────────── ostalo

  it("rutira se po predmetu RN-a (∪ globalni planeri)", async () => {
    await service.notifyLaunch(INPUT);
    age(200_000);
    await service.sweep();

    expect(prisma.predmetPlaner.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ projectId: { in: [3] } }, { projectId: null }] },
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

  it("crtež bez ijednog nacrta → obaveštenje po poziciji, bez pominjanja nacrta", async () => {
    await service.notifyLaunch({ ...INPUT, workOrderId: 45, handoverId: 8 });
    expect(store.rows[0].handoverDraftId).toBeNull();
    age(200_000);

    await service.sweep();

    const m = mailFor("planer@servoteh.com");
    expect(m.subject).toBe("Lansiran RN P100/9 — predmet 9400/7");
    expect(m.html).not.toContain("Nacrt primopredaje");
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

  it("delimičan uspeh (mejl vratio false, zvonce prošlo) se broji kao isporuka", async () => {
    // `send` vraća false, ne baca — zvonce je jedini uspeli kanal.
    mail.send.mockResolvedValue(false);
    notifications.notifyWorkers.mockResolvedValue(1);
    await service.notifyLaunch(INPUT);
    age(200_000);

    await service.sweep();

    expect(notifications.notifyWorkers).toHaveBeenCalledTimes(1);
    expect(store.rows[0].sentAt).not.toBeNull();
  });

  it("obrisan RN → red se markira, sweep ne puca", async () => {
    await service.notifyLaunch({ ...INPUT, workOrderId: 999, handoverId: 8 });
    age(200_000);

    await expect(service.sweep()).resolves.toBeUndefined();

    expect(mail.send).not.toHaveBeenCalled();
    expect(store.rows[0].notifiedAt).not.toBeNull();
    expect(store.rows[0].sentAt).toBeNull();
  });
});

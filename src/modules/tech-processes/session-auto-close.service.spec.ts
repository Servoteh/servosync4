import { ServiceUnavailableException } from "@nestjs/common";
import { SessionAutoCloseService } from "./session-auto-close.service";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15Service } from "../../common/sy15/sy15.service";
import { MailService } from "../../common/mail/mail.service";

/** Jedna viseća sesija (oblik koji `run()` čita). */
function session(
  over: Partial<{
    id: number;
    workerId: number;
    startedAt: Date;
    identNumber: string;
    operationNumber: number;
    workCenterCode: string;
    fullName: string | null;
  }> = {},
) {
  return {
    id: over.id ?? 1,
    workerId: over.workerId ?? 100,
    startedAt: over.startedAt ?? new Date("2026-07-16T06:00:00.000Z"),
    identNumber: over.identNumber ?? "9000/238",
    operationNumber: over.operationNumber ?? 10,
    workCenterCode: over.workCenterCode ?? "M1",
    worker: { fullName: over.fullName ?? "Pera Perić" },
  };
}

/** Mock PrismaService — samo modeli koje `run()` dodiruje. */
function prismaMock(opts: {
  sessions: ReturnType<typeof session>[];
  maps: { workerId: number; employeeId: string }[];
}) {
  return {
    workTimeEntry: {
      findMany: jest.fn().mockResolvedValue(opts.sessions),
      update: jest.fn().mockResolvedValue({}),
    },
    workerEmployeeMap: {
      findMany: jest.fn().mockResolvedValue(opts.maps),
    },
  };
}

/**
 * Mock Sy15Service — `db` getter vraća objekat sa `$queryRawUnsafe` koji rutira po SQL-u.
 * `available:false` → getter baca (kao kad SY15_DATABASE_URL nije podešen).
 */
function sy15Mock(opts: {
  available?: boolean;
  lastOut?: Date | null;
  position?: string | null;
  reportsTo?: string | null;
  bossEmail?: string | null;
  bossName?: string | null;
}) {
  const queryRawUnsafe = jest.fn(
    async (sql: string, ..._params: unknown[]): Promise<unknown> => {
      if (sql.includes("attendance_events")) {
        return [{ stopped_at: opts.lastOut ?? null }];
      }
      if (sql.includes("FROM employees WHERE id")) {
        return [{ position: opts.position ?? null }];
      }
      if (sql.includes("reports_to_line")) {
        return [{ reports_to_line: opts.reportsTo ?? null }];
      }
      if (sql.includes("FROM employees") && sql.includes("WHERE position")) {
        return opts.bossEmail
          ? [{ email: opts.bossEmail, full_name: opts.bossName ?? "Šef Šefović" }]
          : [];
      }
      return [];
    },
  );
  const svc = {
    __queryRawUnsafe: queryRawUnsafe,
    get db() {
      if (opts.available === false) {
        throw new ServiceUnavailableException("sy15 nije konfigurisana");
      }
      return { $queryRawUnsafe: queryRawUnsafe };
    },
  };
  return svc;
}

function mailMock() {
  return { send: jest.fn().mockResolvedValue(true) };
}

/** Poziv slanja BOSS-notifikacije (neispravno kucanje) — po subject-u. */
function bossCalls(mail: ReturnType<typeof mailMock>) {
  return mail.send.mock.calls.filter((c) =>
    String(c[0].subject).includes("Neispravno kucanje"),
  );
}
/** Poziv slanja ZBIRNOG izveštaja o prolazu — po subject-u. */
function reportCalls(mail: ReturnType<typeof mailMock>) {
  return mail.send.mock.calls.filter((c) =>
    String(c[0].subject).includes("Auto-close sesija"),
  );
}

function make(
  prisma: ReturnType<typeof prismaMock>,
  sy15: ReturnType<typeof sy15Mock>,
  mail: ReturnType<typeof mailMock>,
) {
  return new SessionAutoCloseService(
    prisma as unknown as PrismaService,
    sy15 as unknown as Sy15Service,
    mail as unknown as MailService,
  );
}

describe("SessionAutoCloseService.run", () => {
  const EMP = "11111111-1111-1111-1111-111111111111";

  it("izlaz na kapiji → stopped_at = event_ts_local (vreme izlaska), note izlaz", async () => {
    const out = new Date("2026-07-16T14:03:00.000Z");
    const prisma = prismaMock({
      sessions: [session({ id: 7, workerId: 100 })],
      maps: [{ workerId: 100, employeeId: EMP }],
    });
    const mail = mailMock();
    const svc = make(prisma, sy15Mock({ lastOut: out }), mail);

    const res = await svc.run(12);

    expect(prisma.workTimeEntry.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        stoppedAt: out,
        autoClosed: true,
        note: "auto-close: izlaz na kapiji",
      },
    });
    // Izlaz na kapiji → šef se NE obaveštava (nema neispravnog kucanja)...
    expect(bossCalls(mail)).toHaveLength(0);
    // ...ali zbirni izveštaj o prolazu ide.
    expect(reportCalls(mail)).toHaveLength(1);
    expect(res.data).toMatchObject({
      total: 1,
      closedByGate: 1,
      closedNeispravno: 0,
      unmapped: 0,
    });
  });

  it("bez izlaza → stopped_at = started_at (0 trajanje), note NEISPRAVNO + e-mail šefu", async () => {
    const startedAt = new Date("2026-07-16T06:00:00.000Z");
    const prisma = prismaMock({
      sessions: [session({ id: 9, workerId: 100, startedAt })],
      maps: [{ workerId: 100, employeeId: EMP }],
    });
    const mail = mailMock();
    const svc = make(
      prisma,
      sy15Mock({
        lastOut: null,
        position: "Mašinski monter",
        reportsTo: "Tim lider – mašinska montaža",
        bossEmail: "sef@servoteh.com",
      }),
      mail,
    );

    const res = await svc.run(12);

    expect(prisma.workTimeEntry.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: {
        stoppedAt: startedAt,
        autoClosed: true,
        note: "NEISPRAVNO KUCANJE: sesija bez izlaza na kapiji",
      },
    });
    const boss = bossCalls(mail);
    expect(boss).toHaveLength(1);
    expect(boss[0][0].to).toBe("sef@servoteh.com");
    expect(boss[0][0].subject).toContain("Neispravno kucanje");
    // Zbirni izveštaj o prolazu takođe ide.
    expect(reportCalls(mail)).toHaveLength(1);
    expect(res.data).toMatchObject({
      total: 1,
      closedByGate: 0,
      closedNeispravno: 1,
      unmapped: 0,
    });
  });

  it("bez izlaza a šef nerazrešen → sesija svejedno zatvorena, e-mail šefu preskočen", async () => {
    const prisma = prismaMock({
      sessions: [session({ id: 11, workerId: 100 })],
      maps: [{ workerId: 100, employeeId: EMP }],
    });
    const mail = mailMock();
    const svc = make(
      prisma,
      sy15Mock({ lastOut: null, position: "Mašinski monter", reportsTo: null }),
      mail,
    );

    const res = await svc.run(12);

    expect(prisma.workTimeEntry.update).toHaveBeenCalledTimes(1);
    // Šef nerazrešen → boss-mejl preskočen; izveštaj o prolazu i dalje ide.
    expect(bossCalls(mail)).toHaveLength(0);
    expect(reportCalls(mail)).toHaveLength(1);
    expect(res.data).toMatchObject({ closedNeispravno: 1 });
  });

  it("nemapiran radnik → 0 trajanje + note 'nije mapiran', bez kapije upita", async () => {
    const startedAt = new Date("2026-07-16T06:00:00.000Z");
    const prisma = prismaMock({
      sessions: [session({ id: 3, workerId: 200, startedAt })],
      maps: [], // nema mapiranja za 200
    });
    const mail = mailMock();
    const sy15 = sy15Mock({ lastOut: new Date() });
    const svc = make(prisma, sy15, mail);

    const res = await svc.run(12);

    expect(prisma.workTimeEntry.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: {
        stoppedAt: startedAt,
        autoClosed: true,
        note: "auto-close: radnik nije mapiran na kapiju",
      },
    });
    // Nemapiran → kapija se ne pita.
    expect(sy15.__queryRawUnsafe).not.toHaveBeenCalled();
    // Nemapiran → nema boss-mejla; izveštaj o prolazu i dalje ide.
    expect(bossCalls(mail)).toHaveLength(0);
    expect(reportCalls(mail)).toHaveLength(1);
    expect(res.data).toMatchObject({ total: 1, unmapped: 1, closedByGate: 0 });
  });

  it("Sy15 nedostupan (client null) → graceful: sve zatvoreno 0-trajanje bez pucanja", async () => {
    const startedAt = new Date("2026-07-16T06:00:00.000Z");
    const prisma = prismaMock({
      sessions: [
        session({ id: 1, workerId: 100, startedAt }),
        session({ id: 2, workerId: 101, startedAt }),
      ],
      maps: [
        { workerId: 100, employeeId: EMP },
        { workerId: 101, employeeId: EMP },
      ],
    });
    const mail = mailMock();
    const svc = make(prisma, sy15Mock({ available: false }), mail);

    const res = await svc.run(12);

    expect(prisma.workTimeEntry.update).toHaveBeenCalledTimes(2);
    for (const call of prisma.workTimeEntry.update.mock.calls) {
      expect(call[0].data.stoppedAt).toEqual(startedAt);
      expect(call[0].data.note).toContain("kapija nedostupna");
    }
    // Bez kapije → nema boss-mejlova; jedan zbirni izveštaj o prolazu.
    expect(bossCalls(mail)).toHaveLength(0);
    expect(reportCalls(mail)).toHaveLength(1);
    expect(res.data).toMatchObject({ total: 2, unmapped: 2, closedByGate: 0 });
  });

  it("nema visećih sesija → prazan sažetak, ništa se ne zatvara, izveštaj se NE šalje", async () => {
    const prisma = prismaMock({ sessions: [], maps: [] });
    const mail = mailMock();
    const svc = make(prisma, sy15Mock({}), mail);

    const res = await svc.run(12);

    expect(prisma.workTimeEntry.update).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ total: 0 });
  });

  it("šef bez e-maila na prvom nivou → penje se nivo gore (reports_to_line)", async () => {
    // 1. nivo: 'Tim lider' nema nosioca sa e-mailom (bossEmail null za prvi upit),
    //    ali reports_to_line vodi dalje. Simuliramo tako što prvi employees/position
    //    upit vrati [], a drugi (viši) vrati šefa — rutiramo po pozivu.
    const prisma = prismaMock({
      sessions: [session({ id: 5, workerId: 100 })],
      maps: [{ workerId: 100, employeeId: EMP }],
    });
    const mail = mailMock();

    let posCall = 0;
    const queryRawUnsafe = jest.fn(
      async (sql: string): Promise<unknown> => {
        if (sql.includes("attendance_events")) return [{ stopped_at: null }];
        if (sql.includes("FROM employees WHERE id")) {
          return [{ position: "Mašinski monter" }];
        }
        if (sql.includes("reports_to_line")) {
          // Prvi nivo → Tim lider; drugi nivo → Direktor.
          return posCall === 0
            ? [{ reports_to_line: "Tim lider" }]
            : [{ reports_to_line: "Direktor" }];
        }
        if (sql.includes("WHERE position")) {
          const isFirst = posCall === 0;
          posCall++;
          return isFirst
            ? [] // Tim lider bez e-maila
            : [{ email: "direktor@servoteh.com", full_name: "Direktor D." }];
        }
        return [];
      },
    );
    const sy15 = {
      get db() {
        return { $queryRawUnsafe: queryRawUnsafe };
      },
    };
    const svc = make(prisma, sy15 as unknown as ReturnType<typeof sy15Mock>, mail);

    await svc.run(12);

    const boss = bossCalls(mail);
    expect(boss).toHaveLength(1);
    expect(boss[0][0].to).toBe("direktor@servoteh.com");
  });

  it("zbirni izveštaj: primalac iz AUTOCLOSE_REPORT_EMAIL, subject i tabela sa radnikom", async () => {
    const prev = process.env.AUTOCLOSE_REPORT_EMAIL;
    process.env.AUTOCLOSE_REPORT_EMAIL = "izvestaj@servoteh.com, sef2@servoteh.com";
    try {
      const out = new Date("2026-07-16T14:03:00.000Z");
      const prisma = prismaMock({
        sessions: [session({ id: 7, workerId: 100, fullName: "Marko Vasić" })],
        maps: [{ workerId: 100, employeeId: EMP }],
      });
      const mail = mailMock();
      const svc = make(prisma, sy15Mock({ lastOut: out }), mail);

      await svc.run(12);

      const rep = reportCalls(mail);
      expect(rep).toHaveLength(1);
      const arg = rep[0][0];
      expect(arg.to).toEqual(["izvestaj@servoteh.com", "sef2@servoteh.com"]);
      expect(arg.subject).toContain("Auto-close sesija");
      expect(arg.html).toContain("Marko Vasić");
      expect(arg.html).toContain("izlaz na kapiji");
    } finally {
      if (prev === undefined) delete process.env.AUTOCLOSE_REPORT_EMAIL;
      else process.env.AUTOCLOSE_REPORT_EMAIL = prev;
    }
  });
});

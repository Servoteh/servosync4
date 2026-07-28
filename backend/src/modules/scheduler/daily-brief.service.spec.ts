import { DailyBriefService, DAILY_BRIEF_JOB_KEY } from "./daily-brief.service";
import type { BriefSection } from "./daily-brief.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { MailService } from "../../common/mail/mail.service";
import type { AiProviderService } from "../../common/ai/ai-provider.service";
import { PERMISSIONS } from "../../common/authz/permissions";

/*
 * Talas AI-3 — dnevni brief. Pinuje: registraciju iza prekidača (flag off → nema
 * posla), DETERMINISTIČKE stavke iz upita (bez LLM-a), filtriranje po permisiji,
 * IDEMPOTENCIJU (drugi poziv istog dana ne šalje), best-effort (pad jednog primaoca
 * ne ruši ostale), DRY-RUN paritet i da LLM SAMO formuliše (mokovan, ne troši API).
 */

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

interface FakeOpts {
  overdueCount?: number;
  overdueRows?: unknown[];
  blockedCount?: number;
  blockedRows?: unknown[];
  requestsCount?: number;
  requestsRows?: unknown[];
  qualityCount?: number;
  qualityRows?: unknown[];
  montazaCount?: number;
  montazaRows?: unknown[];
}

interface WhereArg {
  where?: { productionDeadline?: unknown; handoverStatusId?: unknown };
}

function fakePrisma(opts: FakeOpts = {}) {
  const isOverdue = (a: WhereArg) => a.where?.productionDeadline != null;
  const isBlocked = (a: WhereArg) => a.where?.handoverStatusId === 2;
  const claim = jest.fn().mockResolvedValue([{ id: 1 }]);
  const update = jest.fn().mockResolvedValue({});
  const del = jest.fn().mockResolvedValue({});
  return {
    prisma: {
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 10, role: "admin" }),
      },
      userPermissionOverride: { findMany: jest.fn().mockResolvedValue([]) },
      workOrder: {
        count: jest.fn((a: WhereArg) =>
          Promise.resolve(
            isOverdue(a)
              ? (opts.overdueCount ?? 0)
              : isBlocked(a)
                ? (opts.blockedCount ?? 0)
                : 0,
          ),
        ),
        findMany: jest.fn((a: WhereArg) =>
          Promise.resolve(
            isOverdue(a)
              ? (opts.overdueRows ?? [])
              : isBlocked(a)
                ? (opts.blockedRows ?? [])
                : [],
          ),
        ),
      },
      changeRequest: {
        count: jest.fn().mockResolvedValue(opts.requestsCount ?? 0),
        findMany: jest.fn().mockResolvedValue(opts.requestsRows ?? []),
      },
      qualityEvent: {
        count: jest.fn().mockResolvedValue(opts.qualityCount ?? 0),
        findMany: jest.fn().mockResolvedValue(opts.qualityRows ?? []),
      },
      montageNonconformity: {
        count: jest.fn().mockResolvedValue(opts.montazaCount ?? 0),
        findMany: jest.fn().mockResolvedValue(opts.montazaRows ?? []),
      },
      dailyBriefSend: { update, delete: del },
      $queryRaw: claim,
    } as unknown as PrismaService,
    claim,
    update,
    del,
  };
}

/** sy15 koji uvek padne → sy15 sekcije se fail-soft izostave (fokus na glavnu bazu). */
const sy15Down = {
  withUserRls: jest.fn().mockRejectedValue(new Error("sy15 off")),
} as unknown as Sy15Service;

/** sy15 koji izvršava callback nad datim tx mockom (za sastanci/odsustva testove). */
function sy15WithTx(tx: unknown): Sy15Service {
  return {
    withUserRls: jest.fn(
      (_email: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    ),
  } as unknown as Sy15Service;
}

function fakeMail(configured = true, sendOk = true) {
  const send = jest.fn().mockResolvedValue(sendOk);
  return {
    mail: {
      get configured() {
        return configured;
      },
      send,
    } as unknown as MailService,
    send,
  };
}

function fakeAi() {
  const summarize = jest.fn().mockResolvedValue({
    summary: "AI sažetak dana.",
    model: "claude-sonnet-5",
    usage: null,
  });
  return { ai: { summarize } as unknown as AiProviderService, summarize };
}

function make(
  prisma: PrismaService,
  mail: MailService,
  ai: AiProviderService,
  sy15: Sy15Service = sy15Down,
) {
  return new DailyBriefService(prisma, sy15, mail, ai);
}

describe("DailyBriefService — registracija", () => {
  it("flag OFF → posao se NE registruje", () => {
    withEnv({ DAILY_BRIEF_ENABLED: undefined }, () => {
      const svc = make(fakePrisma().prisma, fakeMail().mail, fakeAi().ai);
      expect(svc.enabled).toBe(false);
      expect(svc.buildJobs()).toEqual([]);
    });
  });

  it("flag ON → jedan posao sa stabilnim ključem, daily 07:00", () => {
    withEnv({ DAILY_BRIEF_ENABLED: "true", DAILY_BRIEF_TO: "a@x.com" }, () => {
      const svc = make(fakePrisma().prisma, fakeMail().mail, fakeAi().ai);
      const jobs = svc.buildJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].key).toBe(DAILY_BRIEF_JOB_KEY);
      expect(jobs[0].schedule).toEqual({ kind: "daily", at: "07:00" });
    });
  });

  it("parseRecipients: lowercase, dedup, bez praznih/nevalidnih", () => {
    withEnv({ DAILY_BRIEF_TO: " A@x.com , a@x.com ,bad, b@y.com " }, () => {
      const svc = make(fakePrisma().prisma, fakeMail().mail, fakeAi().ai);
      expect(svc.parseRecipients().sort()).toEqual(["a@x.com", "b@y.com"]);
    });
  });
});

describe("DailyBriefService — deterministički upiti (bez LLM-a)", () => {
  it("gatherMainSections: tačan broj + stavke iz mokovanih upita", async () => {
    const { prisma } = fakePrisma({
      overdueCount: 3,
      overdueRows: [
        {
          id: 1,
          identNumber: "9400/2",
          partName: "Osovina",
          productionDeadline: new Date("2026-07-20T00:00:00Z"),
          externalProjectName: "Projekat X",
        },
      ],
      blockedCount: 1,
      blockedRows: [
        {
          id: 2,
          identNumber: "9500/1",
          partName: "Ploča",
          externalProjectName: null,
        },
      ],
      requestsCount: 2,
      requestsRows: [
        {
          id: 5,
          reqNo: "023/26",
          title: "Bug u nalozima",
          status: "SUBMITTED",
          priorityUser: "HIGH",
          submittedAt: new Date("2026-07-24T00:00:00Z"),
          createdAt: new Date("2026-07-24T00:00:00Z"),
        },
      ],
      qualityCount: 4,
      qualityRows: [
        {
          id: 9,
          type: "SKART",
          workOrderId: 77,
          qty: { toString: () => "2" },
          unit: "kom",
        },
      ],
      montazaCount: 0,
    });
    const svc = make(prisma, fakeMail().mail, fakeAi().ai);
    const sections = await svc.gatherMainSections("2026-07-27");

    const byKey = Object.fromEntries(sections.map((s) => [s.key, s]));
    expect(byKey.rn_kasnjenja.count).toBe(3);
    expect(byKey.rn_kasnjenja.items[0].metric).toContain("kasni");
    expect(byKey.rn_kasnjenja.items[0].metric).toContain("rok 20.07.2026");
    expect(byKey.rn_kasnjenja.requiredPermission).toBe(PERMISSIONS.RN_READ);
    expect(byKey.rn_blokirani.count).toBe(1);
    expect(byKey.zahtevi_odluka.count).toBe(2);
    expect(byKey.zahtevi_odluka.requiredPermission).toBe(
      PERMISSIONS.ZAHTEVI_DECISIONS_READ,
    );
    expect(byKey.kvalitet_red.count).toBe(4);
    expect(byKey.montaza_nc.count).toBe(0);
    // Svaka stavka nosi izvor (bez halucinacija).
    for (const s of sections) expect(s.source.length).toBeGreaterThan(0);
  });
});

describe("DailyBriefService — personalizacija po permisiji", () => {
  const svc = make(fakePrisma().prisma, fakeMail().mail, fakeAi().ai);
  const sections: BriefSection[] = [
    {
      key: "rn_kasnjenja",
      requiredPermission: PERMISSIONS.RN_READ,
      title: "RN",
      count: 1,
      items: [],
      severity: "high",
      source: "x",
      origin: "main",
    },
    {
      key: "zahtevi_odluka",
      requiredPermission: PERMISSIONS.ZAHTEVI_DECISIONS_READ,
      title: "Zahtevi",
      count: 1,
      items: [],
      severity: "high",
      source: "x",
      origin: "main",
    },
  ];

  it("vidi SAMO sekcije za koje ima pravo", () => {
    const perms = new Set<string>([PERMISSIONS.RN_READ]);
    const visible = svc.filterByPermission(sections, perms);
    expect(visible.map((s) => s.key)).toEqual(["rn_kasnjenja"]);
  });

  it("bez ijedne relevantne permisije → nijedna sekcija glavne baze", () => {
    const visible = svc.filterByPermission(
      sections,
      new Set<string>(["nesto.drugo"]),
    );
    expect(visible).toEqual([]);
  });

  it("rankSections: prazne na dno, high pre medium", () => {
    const ranked = svc.rankSections([
      { ...sections[0], count: 0, severity: "high" },
      { ...sections[1], count: 2, severity: "medium" },
      { ...sections[0], key: "x", count: 5, severity: "high" },
    ]);
    expect(ranked.map((s) => s.count)).toEqual([5, 2, 0]);
  });
});

describe("DailyBriefService — composeProse (LLM samo formuliše)", () => {
  it("miran dan (0 stavki) → kratak tekst, LLM se NE zove", async () => {
    const { ai, summarize } = fakeAi();
    const svc = make(fakePrisma().prisma, fakeMail().mail, ai);
    const text = await svc.composeProse([], "2026-07-27");
    expect(text.toLowerCase()).toContain("miran dan");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("ima stavki → LLM zvan sa sistemskim ctx (userId null), vraća njegov tekst", async () => {
    const { ai, summarize } = fakeAi();
    const svc = make(fakePrisma().prisma, fakeMail().mail, ai);
    const sections: BriefSection[] = [
      {
        key: "k",
        requiredPermission: null,
        title: "RN",
        count: 2,
        items: [{ label: "RN 1", metric: "kasni 3 d", severity: "high" }],
        severity: "high",
        source: "x",
        origin: "main",
      },
    ];
    const text = await svc.composeProse(sections, "2026-07-27");
    expect(text).toBe("AI sažetak dana.");
    expect(summarize).toHaveBeenCalledTimes(1);
    const ctx = (summarize.mock.calls[0] as unknown[])[3] as {
      module: string;
      userId: number | null;
    };
    expect(ctx).toEqual({ module: "daily-brief", userId: null });
  });

  it("LLM padne → deterministički fallback (brief svejedno ide)", async () => {
    const summarize = jest.fn().mockRejectedValue(new Error("no key"));
    const ai = { summarize } as unknown as AiProviderService;
    const svc = make(fakePrisma().prisma, fakeMail().mail, ai);
    const sections: BriefSection[] = [
      {
        key: "k",
        requiredPermission: null,
        title: "RN u kašnjenju",
        count: 2,
        items: [],
        severity: "high",
        source: "x",
        origin: "main",
      },
    ];
    const text = await svc.composeProse(sections, "2026-07-27");
    expect(text).toContain("RN u kašnjenju: 2");
  });
});

describe("DailyBriefService — slanje + idempotencija", () => {
  it("happy path: claim → mejl → upis traga", async () => {
    const { prisma, claim, update } = fakePrisma({ overdueCount: 1 });
    const { mail, send } = fakeMail(true, true);
    const svc = make(prisma, mail, fakeAi().ai);
    const main = await svc.gatherMainSections("2026-07-27");
    const r = await svc.sendToRecipient("dir@x.com", main, "2026-07-27");
    expect(r.status).toBe("sent");
    expect(claim).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const arg = (send.mock.calls[0] as unknown[])[0] as {
      subject: string;
      html: string;
    };
    expect(arg.subject).toContain("Dnevni brief");
    expect(arg.html).toContain("AI sažetak");
    expect(update).toHaveBeenCalled(); // trag zabeležen
  });

  it("idempotencija: drugi poziv istog dana (claim prazan) → NE šalje", async () => {
    const { prisma, claim } = fakePrisma();
    claim.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValueOnce([]);
    const { mail, send } = fakeMail(true, true);
    const svc = make(prisma, mail, fakeAi().ai);
    const main = await svc.gatherMainSections("2026-07-27");
    const r1 = await svc.sendToRecipient("dir@x.com", main, "2026-07-27");
    const r2 = await svc.sendToRecipient("dir@x.com", main, "2026-07-27");
    expect(r1.status).toBe("sent");
    expect(r2.status).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("DRY-RUN (RESEND nekonfigurisan): ne poziva send, upis dry_run", async () => {
    const { prisma, update } = fakePrisma();
    const { mail, send } = fakeMail(false, true);
    const svc = make(prisma, mail, fakeAi().ai);
    const main = await svc.gatherMainSections("2026-07-27");
    const r = await svc.sendToRecipient("dir@x.com", main, "2026-07-27");
    expect(r.status).toBe("dry_run");
    expect(send).not.toHaveBeenCalled();
    const updArg = (update.mock.calls[0] as unknown[])[0] as {
      data: { status: string };
    };
    expect(updArg.data.status).toBe("dry_run");
  });

  it("tvrdi pad slanja → oslobodi claim (delete) da catch-up sme ponovo", async () => {
    const { prisma, del } = fakePrisma();
    const { mail } = fakeMail(true, false); // send vraća false
    const svc = make(prisma, mail, fakeAi().ai);
    const main = await svc.gatherMainSections("2026-07-27");
    const r = await svc.sendToRecipient("dir@x.com", main, "2026-07-27");
    expect(r.status).toBe("failed");
    expect(del).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("nepoznat primalac (nema u users) → no_user, ne šalje", async () => {
    const { prisma, claim } = fakePrisma();
    (prisma.user.findUnique as jest.Mock).mockResolvedValue(null);
    const { mail, send } = fakeMail(true, true);
    const svc = make(prisma, mail, fakeAi().ai);
    const r = await svc.sendToRecipient("ghost@x.com", [], "2026-07-27");
    expect(r.status).toBe("no_user");
    expect(claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("DailyBriefService — run() best-effort", () => {
  it("vikend → ne šalje", async () => {
    const svc = withEnv(
      { DAILY_BRIEF_ENABLED: "true", DAILY_BRIEF_TO: "a@x.com" },
      () => make(fakePrisma().prisma, fakeMail().mail, fakeAi().ai),
    );
    // 2026-07-25 = subota (isoDow 6).
    const out = await withEnv(
      { DAILY_BRIEF_ENABLED: "true", DAILY_BRIEF_TO: "a@x.com" },
      () => svc.run(new Date("2026-07-25T09:00:00Z")),
    );
    expect(out).toContain("vikend");
  });

  it("nema primalaca → jasan izlaz", async () => {
    const out = await withEnv(
      { DAILY_BRIEF_ENABLED: "true", DAILY_BRIEF_TO: "" },
      () =>
        make(fakePrisma().prisma, fakeMail().mail, fakeAi().ai).run(
          new Date("2026-07-27T05:00:00Z"),
        ),
    );
    expect(out).toContain("nema primalaca");
  });

  it("pad jednog primaoca: drugi se svejedno pošalje, run BACA (FAILED slot → retry)", async () => {
    const { prisma, claim } = fakePrisma({ overdueCount: 1 });
    claim
      .mockRejectedValueOnce(new Error("db hiccup")) // prvi primalac padne
      .mockResolvedValueOnce([{ id: 2 }]); // drugi prođe
    const { mail, send } = fakeMail(true, true);
    // Review [2]: run() BACA kad ima pad — scheduler upiše FAILED i retry-uje.
    // Poruka izuzetka nosi rezime (poslato=1 / palo=1); drugi primalac je poslat.
    await withEnv(
      { DAILY_BRIEF_ENABLED: "true", DAILY_BRIEF_TO: "a@x.com,b@y.com" },
      async () => {
        await expect(
          make(prisma, mail, fakeAi().ai).run(new Date("2026-07-27T05:00:00Z")),
        ).rejects.toThrow(/palo=1/);
      },
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("svi poslati (bez pada) → run VRAĆA rezime (DONE, ne baca)", async () => {
    const { prisma } = fakePrisma();
    const { mail } = fakeMail(true, true);
    const out = await withEnv(
      { DAILY_BRIEF_ENABLED: "true", DAILY_BRIEF_TO: "a@x.com" },
      () =>
        make(prisma, mail, fakeAi().ai).run(new Date("2026-07-27T05:00:00Z")),
    );
    expect(out).toContain("poslato=1");
    expect(out).toContain("palo=0");
  });

  it("TZ: 'danas' je Europe/Belgrade, ne UTC (22:30Z → sutradan lokalno)", async () => {
    const { prisma } = fakePrisma();
    const svc = make(prisma, fakeMail().mail, fakeAi().ai);
    const spy = jest.spyOn(svc, "gatherMainSections").mockResolvedValue([]);
    jest.spyOn(svc, "sendToRecipient").mockResolvedValue({
      email: "a@x.com",
      status: "sent",
      sections: 0,
      items: 0,
    });
    // 2026-07-27 22:30 UTC = 2026-07-28 00:30 Europe/Belgrade (CEST +2) → forDate 28.
    await withEnv(
      { DAILY_BRIEF_ENABLED: "true", DAILY_BRIEF_TO: "a@x.com" },
      () => svc.run(new Date("2026-07-27T22:30:00Z")),
    );
    expect(spy).toHaveBeenCalledWith("2026-07-28");
  });
});

describe("DailyBriefService — PII van LLM ulaza (review [0])", () => {
  it("sectionsToText redaktuje sy15 sekcije: BROJ da, imena/teme NE", async () => {
    const { ai, summarize } = fakeAi();
    const svc = make(fakePrisma().prisma, fakeMail().mail, ai);
    const sections: BriefSection[] = [
      {
        key: "odsustva_danas",
        requiredPermission: "kadrovska.read",
        title: "Odsustva danas",
        count: 3,
        items: [
          {
            label: "Petar Petrović",
            metric: "bolovanje",
            severity: "info",
          },
        ],
        severity: "medium",
        source: "sy15 …",
        origin: "sy15",
      },
    ];
    await svc.composeProse(sections, "2026-07-27");
    // userContent (LLM ulaz) je 3. argument summarize-a.
    const userContent = (summarize.mock.calls[0] as unknown[])[2] as string;
    expect(userContent).toContain("ukupno 3"); // broj ostaje
    expect(userContent).toContain("izostavljene iz AI ulaza");
    expect(userContent).not.toContain("Petar"); // ime NE ide LLM-u
    expect(userContent.toLowerCase()).not.toContain("bolovanje"); // zdravlje NE
  });
});

describe("DailyBriefService — count vs length + dry_run re-claim", () => {
  it("sastanci: count je pravi COUNT(*), ne items.length (review [7])", async () => {
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: "a",
            naslov: "S1",
            vreme: "09:00:00",
            mesto: null,
            tip: null,
            status: null,
          },
          {
            id: "b",
            naslov: "S2",
            vreme: "10:00:00",
            mesto: null,
            tip: null,
            status: null,
          },
        ])
        .mockResolvedValueOnce([{ n: 15n }]),
    };
    const svc = make(
      fakePrisma().prisma,
      fakeMail().mail,
      fakeAi().ai,
      sy15WithTx(tx),
    );
    const recipient = {
      email: "dir@x.com",
      userId: 1,
      role: "admin",
      permissions: new Set<string>([PERMISSIONS.SASTANCI_READ]),
    };
    const sections = await svc.gatherSy15SectionsFor(recipient, "2026-07-27");
    const sast = sections.find((s) => s.key === "sastanci_danas")!;
    expect(sast.count).toBe(15); // pravi total
    expect(sast.items).toHaveLength(2); // kapirano
    expect(sast.moreCount).toBe(13); // 15 − 2 skriveno
  });

  it("claimSend SQL: re-claim samo pending/dry_run (sent zaštićen)", async () => {
    const { prisma, claim } = fakePrisma();
    const svc = make(prisma, fakeMail().mail, fakeAi().ai);
    await svc.claimSend("2026-07-27", "dir@x.com");
    const sql = (claim.mock.calls[0] as unknown[])[0] as string[];
    const joined = sql.join("?");
    expect(joined).toContain("ON CONFLICT");
    expect(joined).toContain("DO UPDATE");
    expect(joined).toContain("'pending', 'dry_run'");
  });
});

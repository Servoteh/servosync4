import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ZahteviDecisionsService } from "./zahtevi-decisions.service";
import type { AuthUser } from "../auth/jwt.strategy";

const ADMIN: AuthUser = {
  userId: 1,
  email: "admin@servoteh.com",
  role: "admin",
  workerId: null,
};
const MANAGER: AuthUser = {
  userId: 5,
  email: "m@servoteh.com",
  role: "menadzment",
  workerId: null,
};

function calls(mock: jest.Mock): unknown[][] {
  return mock.mock.calls as unknown[][];
}
function firstArg<T>(mock: jest.Mock, i = 0): T {
  return calls(mock)[i][0] as T;
}

interface PrismaMock {
  decisionLogEntry: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  $transaction: jest.Mock;
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    decisionLogEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation((a: { data: unknown }) =>
        Promise.resolve({ id: 100, ...(a.data as object) }),
      ),
      update: jest.fn().mockImplementation((a: { where: { id: number }; data: unknown }) =>
        Promise.resolve({ id: a.where.id, ...(a.data as object) }),
      ),
    },
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: PrismaMock) => unknown)(mock),
  );
  return mock;
}

describe("ZahteviDecisionsService", () => {
  let service: ZahteviDecisionsService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = prismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZahteviDecisionsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(ZahteviDecisionsService);
  });

  // ── CREATE ────────────────────────────────────────────────────────────────
  describe("create", () => {
    it("prazan naslov → 400", async () => {
      await expect(
        service.create({ title: "", decision: "x" }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it("menadzment (decisions.read ali NE write) → 403", async () => {
      await expect(
        service.create({ title: "T", decision: "D" }, MANAGER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
    it("admin kreira → upisano sa datumom (retroaktivan dozvoljen)", async () => {
      await service.create(
        { title: "Odluka", decision: "Radimo X", decidedOn: "2026-01-15", tags: ["authz"] },
        ADMIN,
      );
      const arg = firstArg<{ data: { title: string; tags: string[]; decidedOn: Date } }>(
        prisma.decisionLogEntry.create,
      );
      expect(arg.data.title).toBe("Odluka");
      expect(arg.data.tags).toEqual(["authz"]);
      expect(arg.data.decidedOn.toISOString().slice(0, 10)).toBe("2026-01-15");
    });
    it("nevalidan datum → 400", async () => {
      await expect(
        service.create({ title: "T", decision: "D", decidedOn: "15.01.2026" }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ── SUPERSEDE ────────────────────────────────────────────────────────────────
  describe("supersede", () => {
    it("nova odluka + stara SUPERSEDED/supersededById", async () => {
      prisma.decisionLogEntry.findUnique.mockResolvedValue({
        id: 7,
        status: "ACTIVE",
        tags: ["storage"],
        relatedRequestId: null,
      });
      const res = await service.supersede(
        7,
        { title: "Nova", decision: "Menjamo pristup" },
        ADMIN,
      );
      // create nove
      expect(prisma.decisionLogEntry.create).toHaveBeenCalled();
      // update stare u SUPERSEDED sa supersededById
      const updArg = firstArg<{ where: { id: number }; data: { status: string; supersededById: number } }>(
        prisma.decisionLogEntry.update,
      );
      expect(updArg.where.id).toBe(7);
      expect(updArg.data.status).toBe("SUPERSEDED");
      expect(updArg.data.supersededById).toBe(100); // id nove (iz create mock-a)
      expect(res.data.created.id).toBe(100);
    });

    it("supersede već zamenjene → 422", async () => {
      prisma.decisionLogEntry.findUnique.mockResolvedValue({
        id: 7,
        status: "SUPERSEDED",
        tags: [],
      });
      await expect(
        service.supersede(7, { title: "N", decision: "D" }, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("supersede nepostojeće → 404", async () => {
      prisma.decisionLogEntry.findUnique.mockResolvedValue(null);
      await expect(
        service.supersede(7, { title: "N", decision: "D" }, ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ── PATCH ────────────────────────────────────────────────────────────────
  describe("update (sitne ispravke)", () => {
    it("SUPERSEDED red se ne menja → 422", async () => {
      prisma.decisionLogEntry.findUnique.mockResolvedValue({
        id: 7,
        status: "SUPERSEDED",
      });
      await expect(
        service.update(7, { title: "X" }, ADMIN),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
    it("ACTIVE red → izmena prolazi", async () => {
      prisma.decisionLogEntry.findUnique.mockResolvedValue({
        id: 7,
        status: "ACTIVE",
      });
      await service.update(7, { title: "Ispravljen naslov" }, ADMIN);
      const arg = firstArg<{ data: { title: string } }>(
        prisma.decisionLogEntry.update,
      );
      expect(arg.data.title).toBe("Ispravljen naslov");
    });
  });

  // ── FROM REQUEST (logDecision prečica §6) ────────────────────────────────────
  describe("createFromRequest (prečica sa zahteva)", () => {
    it("kreira prefilovan zapis (reject) sa relatedRequestId + tag zahtev", async () => {
      await service.createFromRequest(prisma as never, {
        requestId: 10,
        reqNo: "001/26",
        requestTitle: "Bug u nabavci",
        requestDescription: "Detaljan opis buga...",
        action: "reject",
        note: "duplikat",
        actorUserId: 1,
      });
      const arg = firstArg<{
        data: { relatedRequestId: number; tags: string[]; decision: string };
      }>(prisma.decisionLogEntry.create);
      expect(arg.data.relatedRequestId).toBe(10);
      expect(arg.data.tags).toContain("zahtev");
      expect(arg.data.decision).toContain("Odbijeno");
    });

    it("ne duplira postojeći ACTIVE zapis za isti zahtev/naslov", async () => {
      prisma.decisionLogEntry.findFirst.mockResolvedValue({ id: 55 });
      await service.createFromRequest(prisma as never, {
        requestId: 10,
        reqNo: "001/26",
        requestTitle: "Bug",
        requestDescription: "opis",
        action: "approve",
        actorUserId: 1,
      });
      expect(prisma.decisionLogEntry.create).not.toHaveBeenCalled();
    });
  });

  // ── LIST ────────────────────────────────────────────────────────────────
  describe("list filteri", () => {
    it("tag filter → tags has; q → OR nad title/decision/context", async () => {
      await service.list({ tag: "authz", q: "storage" });
      const arg = firstArg<{
        where: {
          tags?: { has: string };
          OR?: Array<{ title?: unknown }>;
        };
      }>(prisma.decisionLogEntry.findMany);
      expect(arg.where.tags?.has).toBe("authz");
      expect(arg.where.OR?.length).toBe(3);
    });
  });
});

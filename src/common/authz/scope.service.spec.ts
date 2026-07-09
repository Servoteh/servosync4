import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { ScopeService } from "./scope.service";
import type { AuthUser } from "../../modules/auth/jwt.strategy";

const user = (over: Partial<AuthUser>): AuthUser => ({
  userId: 1,
  email: "u@x",
  role: "tehnolog",
  workerId: null,
  ...over,
});

describe("ScopeService", () => {
  let scope: ScopeService;
  let findMany: jest.Mock;

  beforeEach(async () => {
    findMany = jest.fn();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ScopeService,
        { provide: PrismaService, useValue: { machineAccess: { findMany } } },
      ],
    }).compile();
    scope = mod.get(ScopeService);
  });

  it("does not restrict non-radnik roles (see all)", async () => {
    for (const role of ["admin", "sef", "tehnolog", "cnc_programer", "menadzment"]) {
      const where = await scope.techProcessScope(user({ role }));
      expect(where).toEqual({});
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it("restricts proizvodni_radnik to their machine_access work centers", async () => {
    findMany.mockResolvedValue([
      { workCenterCode: "CNC1" },
      { workCenterCode: "BRV" },
    ]);
    const where = await scope.techProcessScope(
      user({ role: "proizvodni_radnik", workerId: 42 }),
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { workerId: 42 },
      select: { workCenterCode: true },
    });
    expect(where).toEqual({ workCenterCode: { in: ["CNC1", "BRV"] } });
  });

  it("fails closed: radnik with no worker link sees nothing", async () => {
    const where = await scope.techProcessScope(
      user({ role: "proizvodni_radnik", workerId: null }),
    );
    expect(findMany).not.toHaveBeenCalled(); // no workerId → no query
    expect(where).toEqual({ workCenterCode: { in: [] } });
  });

  it("is case-insensitive on the role value (legacy uppercase)", async () => {
    findMany.mockResolvedValue([]);
    const where = await scope.techProcessScope(
      user({ role: "PROIZVODNI_RADNIK", workerId: 7 }),
    );
    expect(where).toEqual({ workCenterCode: { in: [] } });
  });

  it("withTechProcessScope ANDs base filter with scope for radnik", async () => {
    findMany.mockResolvedValue([{ workCenterCode: "CNC1" }]);
    const base = { identNumber: { contains: "24" } };
    const where = await scope.withTechProcessScope(
      user({ role: "proizvodni_radnik", workerId: 42 }),
      base,
    );
    expect(where).toEqual({
      AND: [base, { workCenterCode: { in: ["CNC1"] } }],
    });
  });

  it("withTechProcessScope returns base unchanged for non-radnik", async () => {
    const base = { projectId: 5 };
    const where = await scope.withTechProcessScope(user({ role: "sef" }), base);
    expect(where).toBe(base);
  });

  describe("workerMachineViolation", () => {
    it("returns null when worker has NO defined machine access (unseeded-safe)", async () => {
      findMany.mockResolvedValue([]);
      expect(await scope.workerMachineViolation(5, "CNC1")).toBeNull();
    });

    it("returns null when the work center is among the worker's machines", async () => {
      findMany.mockResolvedValue([{ workCenterCode: "CNC1" }, { workCenterCode: "BRV" }]);
      expect(await scope.workerMachineViolation(5, "CNC1")).toBeNull();
    });

    it("returns a reason when worker has access but NOT to this work center", async () => {
      findMany.mockResolvedValue([{ workCenterCode: "BRV" }]);
      const reason = await scope.workerMachineViolation(5, "CNC1");
      expect(reason).toContain("CNC1");
      expect(reason).toContain("machine_access");
    });
  });

  describe("isEnforced", () => {
    const prev = process.env.AUTHZ_ENFORCE;
    afterEach(() => {
      if (prev === undefined) delete process.env.AUTHZ_ENFORCE;
      else process.env.AUTHZ_ENFORCE = prev;
    });
    it("is false unless AUTHZ_ENFORCE === 'true'", () => {
      delete process.env.AUTHZ_ENFORCE;
      expect(scope.isEnforced()).toBe(false);
      process.env.AUTHZ_ENFORCE = "false";
      expect(scope.isEnforced()).toBe(false);
      process.env.AUTHZ_ENFORCE = "true";
      expect(scope.isEnforced()).toBe(true);
    });
  });
});

import { Test, type TestingModule } from "@nestjs/testing";
import { UnprocessableEntityException } from "@nestjs/common";
import { PredmetPlaneriService } from "./predmet-planeri.service";
import { PrismaService } from "../../prisma/prisma.service";

/** Prisma mock: predmet_planeri overlay + users lookup + prolazni $transaction. */
function prismaMock() {
  const m = {
    predmetPlaner: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    // Advisory lock u replace() (serijalizacija scope-a) ide kroz $executeRaw.
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(),
  };
  m.$transaction.mockImplementation((arg: unknown) =>
    (arg as (tx: unknown) => unknown)(m),
  );
  return m;
}

describe("PredmetPlaneriService", () => {
  let service: PredmetPlaneriService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PredmetPlaneriService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(PredmetPlaneriService);
  });

  describe("overview", () => {
    it("grupiše po predmetu i izdvaja globalne (project_id NULL)", async () => {
      prisma.predmetPlaner.findMany.mockResolvedValue([
        { projectId: 9068, plannerUserId: 1 },
        { projectId: 9068, plannerUserId: 2 },
        { projectId: null, plannerUserId: 3 },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 1, fullName: "A", email: "a@x" },
        { id: 2, fullName: "B", email: "b@x" },
        { id: 3, fullName: "C", email: "c@x" },
      ]);

      const res = await service.overview();

      expect(res.data.assignments[9068].map((p) => p.userId)).toEqual([1, 2]);
      expect(res.data.globals.map((p) => p.userId)).toEqual([3]);
      expect(res.data.candidates).toHaveLength(3);
    });

    it("dodeljeni neaktivni planer se prikazuje sa active=false (bez soft-lock-a)", async () => {
      prisma.predmetPlaner.findMany.mockResolvedValue([
        { projectId: 9068, plannerUserId: 1 },
        { projectId: 9068, plannerUserId: 9 },
      ]);
      // candidates lookup (active:true) vraća samo 1; assigned lookup vraća oba (9 neaktivan).
      prisma.user.findMany
        .mockResolvedValueOnce([{ id: 1, fullName: "A", email: "a@x" }])
        .mockResolvedValueOnce([
          { id: 1, fullName: "A", email: "a@x", active: true },
          { id: 9, fullName: "Bivši", email: "b@x", active: false },
        ]);

      const res = await service.overview();

      const p9 = res.data.assignments[9068].find((p) => p.userId === 9);
      expect(p9).toMatchObject({ userId: 9, fullName: "Bivši", active: false });
      expect(res.data.candidates).toHaveLength(1); // picker = samo aktivni
    });
  });

  describe("setForProject", () => {
    it("replace semantika — obriše postojeće pa upiše novi set za predmet", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);

      await service.setForProject(9068, [1, 2, 2], 77); // dup 2 se dedup-uje

      expect(prisma.predmetPlaner.deleteMany).toHaveBeenCalledWith({
        where: { projectId: 9068 },
      });
      expect(prisma.predmetPlaner.createMany).toHaveBeenCalledWith({
        data: [
          { projectId: 9068, plannerUserId: 1, createdByUserId: 77 },
          { projectId: 9068, plannerUserId: 2, createdByUserId: 77 },
        ],
        skipDuplicates: true,
      });
    });

    it("prazan set samo briše (uklanja sve planere predmeta)", async () => {
      await service.setForProject(9068, [], 77);
      expect(prisma.predmetPlaner.deleteMany).toHaveBeenCalledWith({
        where: { projectId: 9068 },
      });
      expect(prisma.predmetPlaner.createMany).not.toHaveBeenCalled();
    });

    it("422 samo kad nalog NE POSTOJI (nepoznat) — ne blokira transakciju za postojeće", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 1 }]); // 2 ne postoji
      await expect(
        service.setForProject(9068, [1, 2], 77),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.predmetPlaner.deleteMany).not.toHaveBeenCalled();
      // Validacija NE zahteva active:true (postojeći-neaktivni planer sme ostati — bez soft-lock-a).
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: [1, 2] } },
        select: { id: true },
      });
    });

    it("422 na neispravan ID predmeta", async () => {
      await expect(service.setForProject(0, [1], 77)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  describe("setGlobals", () => {
    it("gađa globalne redove (project_id NULL)", async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 5 }]);

      const res = await service.setGlobals([5], 77);

      expect(prisma.predmetPlaner.deleteMany).toHaveBeenCalledWith({
        where: { projectId: null },
      });
      expect(prisma.predmetPlaner.createMany).toHaveBeenCalledWith({
        data: [{ projectId: null, plannerUserId: 5, createdByUserId: 77 }],
        skipDuplicates: true,
      });
      expect(res.data.global).toBe(true);
    });
  });
});

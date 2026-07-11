import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { OperationsService } from "./operations.service";

/** Mock PrismaService — `$transaction(cb)` prosleđuje isti mock kao `tx`. */
function prismaMock() {
  const m = {
    operation: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    workOrderOperation: { count: jest.fn().mockResolvedValue(0) },
    machineAccess: { count: jest.fn().mockResolvedValue(0) },
    techProcess: { count: jest.fn().mockResolvedValue(0) },
    workTimeEntry: { count: jest.fn().mockResolvedValue(0) },
    workUnit: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
  m.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(m),
  );
  return m;
}

describe("OperationsService (delete guard)", () => {
  let service: OperationsService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        OperationsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(OperationsService);
  });

  describe("remove", () => {
    it("404 kad operacija ne postoji", async () => {
      prisma.operation.findUnique.mockResolvedValue(null);
      await expect(service.remove("9.99")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.operation.delete).not.toHaveBeenCalled();
    });

    it("409 kad je referišu RN stavke (postojeći guard)", async () => {
      prisma.operation.findUnique.mockResolvedValue({ id: 3 });
      prisma.workOrderOperation.count.mockResolvedValue(4);

      await expect(service.remove("1.10")).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.operation.delete).not.toHaveBeenCalled();
    });

    it("409 kad postoje kucanja u tech_processes (tabela BEZ FK ka operations)", async () => {
      prisma.operation.findUnique.mockResolvedValue({ id: 3 });
      prisma.techProcess.count.mockResolvedValue(12);

      await expect(service.remove("1.10")).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.techProcess.count).toHaveBeenCalledWith({
        where: { workCenterCode: "1.10" },
      });
      expect(prisma.operation.delete).not.toHaveBeenCalled();
    });

    it("409 kad postoji evidencija vremena u work_time_entries (BEZ FK ka operations)", async () => {
      prisma.operation.findUnique.mockResolvedValue({ id: 3 });
      prisma.workTimeEntry.count.mockResolvedValue(2);

      await expect(service.remove("1.10")).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.workTimeEntry.count).toHaveBeenCalledWith({
        where: { workCenterCode: "1.10" },
      });
      expect(prisma.operation.delete).not.toHaveBeenCalled();
    });

    it("409 poruka nabraja SVE brojače", async () => {
      prisma.operation.findUnique.mockResolvedValue({ id: 3 });
      prisma.workOrderOperation.count.mockResolvedValue(1);
      prisma.machineAccess.count.mockResolvedValue(2);
      prisma.techProcess.count.mockResolvedValue(3);
      prisma.workTimeEntry.count.mockResolvedValue(4);

      await expect(service.remove("1.10")).rejects.toThrow(
        "radni nalozi: 1, pristup mašinama: 2, kucanja: 3, evidencija vremena: 4",
      );
    });

    it("briše nereferenciranu operaciju", async () => {
      prisma.operation.findUnique.mockResolvedValue({ id: 3 });

      const res = await service.remove("1.10");

      expect(prisma.operation.delete).toHaveBeenCalledWith({
        where: { workCenterCode: "1.10" },
      });
      expect(res).toEqual({
        data: { workCenterCode: "1.10", deleted: true },
      });
    });
  });
});

import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { WorkUnitsService } from "./work-units.service";

/** Mock PrismaService — `$transaction(cb)` prosleđuje isti mock kao `tx`. */
function prismaMock() {
  const m = {
    workUnit: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    operation: { count: jest.fn().mockResolvedValue(0) },
    worker: { count: jest.fn().mockResolvedValue(0) },
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

describe("WorkUnitsService (delete guard)", () => {
  let service: WorkUnitsService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        WorkUnitsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(WorkUnitsService);
  });

  describe("remove", () => {
    it("404 kad RJ ne postoji", async () => {
      prisma.workUnit.findUnique.mockResolvedValue(null);
      await expect(service.remove(99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.workUnit.delete).not.toHaveBeenCalled();
    });

    it("409 za sistemsku RJ code='0' (default za workers.workUnitCode)", async () => {
      prisma.workUnit.findUnique.mockResolvedValue({ id: 1, code: "0" });
      await expect(service.remove(1)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.operation.count).not.toHaveBeenCalled();
      expect(prisma.workUnit.delete).not.toHaveBeenCalled();
    });

    it("409 kad je referišu operacije/radnici (polja bez FK) — poruka nosi brojače", async () => {
      prisma.workUnit.findUnique.mockResolvedValue({ id: 4, code: "05" });
      prisma.operation.count.mockResolvedValue(2);
      prisma.worker.count.mockResolvedValue(7);

      await expect(service.remove(4)).rejects.toBeInstanceOf(ConflictException);
      await expect(service.remove(4)).rejects.toThrow("operacije: 2");
      await expect(service.remove(4)).rejects.toThrow("radnici: 7");
      // Count po code vrednosti RJ (workUnitCode je string polje, ne FK po id).
      expect(prisma.operation.count).toHaveBeenCalledWith({
        where: { workUnitCode: "05" },
      });
      expect(prisma.worker.count).toHaveBeenCalledWith({
        where: { workUnitCode: "05" },
      });
      expect(prisma.workUnit.delete).not.toHaveBeenCalled();
    });

    it("briše nereferenciranu RJ i vraća {id, deleted}", async () => {
      prisma.workUnit.findUnique.mockResolvedValue({ id: 4, code: "05" });

      const res = await service.remove(4);

      expect(prisma.workUnit.delete).toHaveBeenCalledWith({
        where: { id: 4 },
      });
      expect(res).toEqual({ data: { id: 4, deleted: true } });
    });
  });
});

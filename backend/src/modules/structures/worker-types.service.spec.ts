import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { WorkerTypesService } from "./worker-types.service";

/** Mock PrismaService — `$transaction(cb)` prosleđuje isti mock kao `tx`. */
function prismaMock() {
  const m = {
    workerType: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
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

describe("WorkerTypesService (delete guard)", () => {
  let service: WorkerTypesService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        WorkerTypesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(WorkerTypesService);
  });

  describe("remove", () => {
    it("409 za sistemski zapis id=0 (NN) — bez ikakvog upita", async () => {
      await expect(service.remove(0)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.workerType.findUnique).not.toHaveBeenCalled();
      expect(prisma.workerType.delete).not.toHaveBeenCalled();
    });

    it("404 kad vrsta ne postoji", async () => {
      prisma.workerType.findUnique.mockResolvedValue(null);
      await expect(service.remove(99)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.workerType.delete).not.toHaveBeenCalled();
    });

    it("409 kad IJEDAN radnik referiše vrstu — count BEZ filtera po active", async () => {
      prisma.workerType.findUnique.mockResolvedValue({ id: 5 });
      prisma.worker.count.mockResolvedValue(3);

      await expect(service.remove(5)).rejects.toBeInstanceOf(ConflictException);
      // Uključuje i neaktivne radnike — where NE sme sadržati `active`.
      expect(prisma.worker.count).toHaveBeenCalledWith({
        where: { workerTypeId: 5 },
      });
      expect(prisma.workerType.delete).not.toHaveBeenCalled();
    });

    it("briše vrstu bez radnika i vraća {id, deleted}", async () => {
      prisma.workerType.findUnique.mockResolvedValue({ id: 5 });
      prisma.worker.count.mockResolvedValue(0);

      const res = await service.remove(5);

      expect(prisma.workerType.delete).toHaveBeenCalledWith({
        where: { id: 5 },
      });
      expect(res).toEqual({ data: { id: 5, deleted: true } });
    });
  });
});

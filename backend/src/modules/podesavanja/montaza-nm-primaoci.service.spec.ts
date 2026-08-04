import { ConflictException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MontazaNmPrimaociService } from "./montaza-nm-primaoci.service";

/**
 * Admin CRUD nad `montaza_nm_primaoci` (034/26 — „Nenad može da koriguje").
 * Pokriva: (1) normalizacija mejla (trim+lower — DB CHECK bi sirov unos odbio),
 * (2) aktivan duplikat → 409, (3) ugašen red se REAKTIVIRA (ne pravi duplikat),
 * (4) remove je SOFT (active=FALSE), (5) remove nepostojećeg/ugašenog → 404.
 */
function prismaMock() {
  return {
    montazaNmPrimalac: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function makeService(prisma: ReturnType<typeof prismaMock>) {
  return new MontazaNmPrimaociService(prisma as unknown as PrismaService);
}

describe("MontazaNmPrimaociService (Podešavanja → Notifikacije, 034/26)", () => {
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(() => {
    prisma = prismaMock();
    jest.clearAllMocks();
  });

  it("list: samo aktivni, redosled unosa", async () => {
    prisma.montazaNmPrimalac.findMany.mockResolvedValue([
      { email: "a@servoteh.com", fullName: "A", note: null, createdAt: new Date() },
    ]);
    const out = await makeService(prisma).list();
    expect(out.data).toHaveLength(1);
    expect(prisma.montazaNmPrimalac.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { active: true },
        orderBy: { id: "asc" },
      }),
    );
  });

  it("add: nov mejl → create, normalizovan (trim+lower) + actor u created_by", async () => {
    prisma.montazaNmPrimalac.create.mockResolvedValue({
      email: "novi@servoteh.com",
      fullName: "Novi",
      note: null,
      createdAt: new Date(),
    });
    const out = await makeService(prisma).add(2, "  Novi@Servoteh.COM ", "Novi");
    expect(prisma.montazaNmPrimalac.findUnique).toHaveBeenCalledWith({
      where: { email: "novi@servoteh.com" },
    });
    expect(prisma.montazaNmPrimalac.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: "novi@servoteh.com",
        fullName: "Novi",
        createdByUserId: 2,
      }),
    });
    expect(out.data.email).toBe("novi@servoteh.com");
  });

  it("add: aktivan duplikat → 409 (bez upisa)", async () => {
    prisma.montazaNmPrimalac.findUnique.mockResolvedValue({
      email: "x@servoteh.com",
      active: true,
    });
    await expect(
      makeService(prisma).add(2, "x@servoteh.com"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.montazaNmPrimalac.create).not.toHaveBeenCalled();
    expect(prisma.montazaNmPrimalac.update).not.toHaveBeenCalled();
  });

  it("add: ugašen red se REAKTIVIRA (update, ne create) — unique po mejlu", async () => {
    prisma.montazaNmPrimalac.findUnique.mockResolvedValue({
      email: "vraceni@servoteh.com",
      active: false,
    });
    prisma.montazaNmPrimalac.update.mockResolvedValue({
      email: "vraceni@servoteh.com",
      fullName: "Vraćeni",
      note: null,
      createdAt: new Date(),
    });
    await makeService(prisma).add(2, "vraceni@servoteh.com", "Vraćeni");
    expect(prisma.montazaNmPrimalac.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "vraceni@servoteh.com" },
        data: expect.objectContaining({ active: true }),
      }),
    );
    expect(prisma.montazaNmPrimalac.create).not.toHaveBeenCalled();
  });

  it("remove: SOFT gašenje (active=FALSE), normalizovan mejl", async () => {
    prisma.montazaNmPrimalac.updateMany.mockResolvedValue({ count: 1 });
    const out = await makeService(prisma).remove(2, " Zoran.Jarakovic@Servoteh.com ");
    expect(prisma.montazaNmPrimalac.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: "zoran.jarakovic@servoteh.com", active: true },
        data: expect.objectContaining({ active: false }),
      }),
    );
    expect(out.data.removed).toBe(true);
  });

  it("remove: nepostojeći/već ugašen → 404", async () => {
    prisma.montazaNmPrimalac.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      makeService(prisma).remove(2, "nema@servoteh.com"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

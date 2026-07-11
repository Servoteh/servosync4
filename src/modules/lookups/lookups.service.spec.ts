import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { LookupsService } from "./lookups.service";

/** Mock PrismaService — samo modeli koje lookups čita. */
function prismaMock() {
  return {
    project: { findMany: jest.fn().mockResolvedValue([]) },
    customer: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe("LookupsService (D9: komitent uz predmet)", () => {
  let service: LookupsService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [LookupsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(LookupsService);
  });

  it("projects() vraća `customer {id, name}` batch-resolve-om; 0/orphan → null", async () => {
    prisma.project.findMany.mockResolvedValue([
      {
        id: 1,
        projectNumber: "100",
        projectName: "A",
        customerId: 9,
        description: null,
      },
      {
        id: 2,
        projectNumber: "101",
        projectName: "B",
        customerId: 0,
        description: null,
      },
      {
        id: 3,
        projectNumber: "102",
        projectName: "C",
        customerId: 77,
        description: null,
      },
      {
        id: 4,
        projectNumber: "103",
        projectName: "D",
        customerId: 9,
        description: null,
      },
    ]);
    // customerId 77 je orphan (nema ga u cache tabeli) → null, ne 500.
    prisma.customer.findMany.mockResolvedValue([{ id: 9, name: "Servoteh" }]);

    const res = await service.projects();

    // Batch upit: samo pozitivni id-jevi, bez duplikata.
    expect(prisma.customer.findMany).toHaveBeenCalledWith({
      where: { id: { in: [9, 77] } },
      select: { id: true, name: true },
    });
    expect(res.data.map((p) => p.customer)).toEqual([
      { id: 9, name: "Servoteh" },
      null, // customerId = 0 → prazno polje na frontu (ne upisuje se 0)
      null, // orphan FK
      { id: 9, name: "Servoteh" },
    ]);
  });

  it("projects() bez ijednog komitenta ne pogađa customers tabelu", async () => {
    prisma.project.findMany.mockResolvedValue([
      {
        id: 2,
        projectNumber: "101",
        projectName: "B",
        customerId: 0,
        description: null,
      },
    ]);

    const res = await service.projects();

    expect(prisma.customer.findMany).not.toHaveBeenCalled();
    expect(res.data[0].customer).toBeNull();
  });
});

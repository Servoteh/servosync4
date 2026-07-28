import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { PrismaService } from "../../prisma/prisma.service";
import { LookupsService } from "./lookups.service";
import { LookupsController } from "./lookups.controller";
import { DirectoryController } from "../directory/directory.controller";
import { PERMISSION_KEY_METADATA } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";

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

  it("projects() vraća `customer {id, name}` batch-resolve-om; id=0=Servoteh, orphan → null", async () => {
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
    // id=0 = Servoteh d.o.o. (interni komitent) — VALIDAN, uključuje se u lookup.
    prisma.customer.findMany.mockResolvedValue([
      { id: 9, name: "Servoteh" },
      { id: 0, name: "Servoteh d.o.o." },
    ]);

    const res = await service.projects();

    // Batch upit: svi id-jevi ≥ 0 (uklj. 0=Servoteh), bez duplikata.
    expect(prisma.customer.findMany).toHaveBeenCalledWith({
      where: { id: { in: [9, 0, 77] } },
      select: { id: true, name: true },
    });
    expect(res.data.map((p) => p.customer)).toEqual([
      { id: 9, name: "Servoteh" },
      { id: 0, name: "Servoteh d.o.o." }, // customerId = 0 → Servoteh (interni)
      null, // orphan FK (77 ne postoji)
      { id: 9, name: "Servoteh" },
    ]);
  });

  it("projects() sa komitentom 0 (Servoteh) ga razrešava iz customers tabele", async () => {
    prisma.project.findMany.mockResolvedValue([
      {
        id: 2,
        projectNumber: "101",
        projectName: "B",
        customerId: 0,
        description: null,
      },
    ]);
    prisma.customer.findMany.mockResolvedValue([
      { id: 0, name: "Servoteh d.o.o." },
    ]);

    const res = await service.projects();

    expect(prisma.customer.findMany).toHaveBeenCalledWith({
      where: { id: { in: [0] } },
      select: { id: true, name: true },
    });
    expect(res.data[0].customer).toEqual({ id: 0, name: "Servoteh d.o.o." });
  });
});

// ============================================================ Guard (bezbednosni dug, 26.07)

/**
 * Regresija: `/v1/lookups/*` je vraćalo ISTI šifarnik kao `/v1/directory/*`
 * (komitenti + predmeti) uz SAMO JWT, pa je bilo zaobilaznica za `directory.read` —
 * `proizvodni_radnik` (kome je taj ključ NAMERNO uskraćen: „matrica §3: RADNIK nema
 * komitente/predmete") dobijao je 403 na `/directory/customers`, a naziv/mesto/PIB
 * je uredno čitao sa `/lookups/customers`. Ključ MORA ostati identičan onom na
 * `DirectoryController` — ako se ovaj test sruši, rupa je vraćena.
 */
describe("LookupsController — permisija", () => {
  it("klasa je iza `directory.read` — istog ključa kao DirectoryController", () => {
    expect(
      Reflect.getMetadata(PERMISSION_KEY_METADATA, LookupsController),
    ).toBe(PERMISSIONS.DIRECTORY_READ);
    expect(
      Reflect.getMetadata(PERMISSION_KEY_METADATA, LookupsController),
    ).toBe(Reflect.getMetadata(PERMISSION_KEY_METADATA, DirectoryController));
  });

  it("nijedna GET ruta nema svoj (širi) ključ — sve nasleđuju klasni", () => {
    for (const name of ["projects", "customers"]) {
      const handler = Object.getOwnPropertyDescriptor(
        LookupsController.prototype,
        name,
      )?.value as object;
      expect(
        Reflect.getMetadata(PERMISSION_KEY_METADATA, handler),
      ).toBeUndefined();
    }
  });
});

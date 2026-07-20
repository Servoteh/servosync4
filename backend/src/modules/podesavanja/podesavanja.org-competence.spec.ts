import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { PodesavanjaService } from "./podesavanja.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * Drop 3 WRITE Podešavanja — P8 org CRUD (struktura + opisi pozicija) + P10 kompetencije editor.
 * Jedinični testovi (bez žive baze). Pinuju: (1) struktura CRUD kroz Prisma (camelCase paritet sa
 * GET org/structure), 0 redova → 404; (2) opis pozicije PATCH 4 md sekcije + profile_updated_by,
 * RLS 0 → 403, nepostojeći → 404; (3) bulk profil sekvencijalno → {ok,fail,results}; (4) kompetencije
 * editor: auto `code`, nivoi upsert/prazan-descriptor-DELETE, DELETE komp. briše nivoe pre, pitanje
 * groupId null=opšte. Sve pod withUserRls (RLS admin/org_profile autoritativan).
 */

function makeTx() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    department: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 1, name: "Proizvodnja", sortOrder: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 1, name: "Proizvodnja" }),
    },
    subDepartment: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 5, departmentId: 1, name: "CNC" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 5 }),
    },
    jobPosition: {
      create: jest.fn().mockResolvedValue({ id: 9, name: "Operater" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 9, name: "Operater" }),
    },
    competenceGroup: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 2, code: "grp_x", nameSr: "Osa" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 2 }),
    },
    competence: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 7, code: "cmp_x", nameSr: "Komp" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 7 }),
    },
    competenceLevel: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    competenceQuestion: {
      create: jest.fn().mockResolvedValue({ id: 3, code: "q_x", textSr: "P?" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 3 }),
    },
  };
}

function makeSvc() {
  const tx = makeTx();
  const sy15 = {
    withUserRls: jest.fn((_e: string, fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  // 2.0 prisma se u ovim testovima ne dira (mirror je samo za grid urednike) — prazan stub.
  const svc = new PodesavanjaService(
    sy15 as unknown as Sy15Service,
    {} as import("../../prisma/prisma.service").PrismaService,
  );
  return { svc, tx };
}

describe("PodesavanjaService P8 — org struktura CRUD", () => {
  it("createDepartment: Prisma create sa trim(name) + sortOrder default 0", async () => {
    const { svc, tx } = makeSvc();
    await svc.createDepartment("a@x", { name: "  Proizvodnja  " });
    const arg = tx.department.create.mock.calls[0][0];
    expect(arg.data.name).toBe("Proizvodnja");
    expect(arg.data.sortOrder).toBe(0);
  });

  it("updateDepartment: 0 redova → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.department.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.updateDepartment("a@x", 99, { name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("deleteDepartment: deleteMany, 0 → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.department.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.deleteDepartment("a@x", 99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("createSubDepartment: prosleđuje departmentId", async () => {
    const { svc, tx } = makeSvc();
    await svc.createSubDepartment("a@x", { departmentId: 1, name: "CNC" });
    expect(tx.subDepartment.create.mock.calls[0][0].data.departmentId).toBe(1);
  });

  it("createJobPosition: subDepartmentId undefined → null", async () => {
    const { svc, tx } = makeSvc();
    await svc.createJobPosition("a@x", { departmentId: 1, name: "Operater" });
    expect(
      tx.jobPosition.create.mock.calls[0][0].data.subDepartmentId,
    ).toBeNull();
  });

  it("updateJobPosition: samo prosleđena polja (name izostavljen)", async () => {
    const { svc, tx } = makeSvc();
    await svc.updateJobPosition("a@x", 9, { sortOrder: 3 });
    const data = tx.jobPosition.updateMany.mock.calls[0][0].data;
    expect(data.sortOrder).toBe(3);
    expect(data.name).toBeUndefined();
  });
});

describe("PodesavanjaService P8 — opis pozicije (org_profile)", () => {
  it("updateJobPositionProfile: 4 md sekcije + profile_updated_by=email", async () => {
    const { svc, tx } = makeSvc();
    await svc.updateJobPositionProfile("Sef@X", 9, {
      summaryMd: "S",
      dutiesMd: "D",
    });
    const data = tx.jobPosition.updateMany.mock.calls[0][0].data;
    expect(data.summaryMd).toBe("S");
    expect(data.expectationsMd).toBeNull(); // nedato = null (paritet 1.0)
    expect(data.responsibilitiesMd).toBeNull();
    expect(data.dutiesMd).toBe("D");
    expect(data.profileUpdatedBy).toBe("sef@x");
    expect(data.profileUpdatedAt).toBeInstanceOf(Date);
  });

  it("updateJobPositionProfile: nepostojeća pozicija → 404 (pre update)", async () => {
    const { svc, tx } = makeSvc();
    tx.jobPosition.findUnique.mockResolvedValueOnce(null);
    await expect(
      svc.updateJobPositionProfile("a@x", 999, { summaryMd: "S" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("updateJobPositionProfile: postoji ali RLS 0 redova → 403", async () => {
    const { svc, tx } = makeSvc();
    tx.jobPosition.findUnique.mockResolvedValueOnce({ id: 9 }); // exists
    tx.jobPosition.updateMany.mockResolvedValueOnce({ count: 0 }); // RLS blok
    await expect(
      svc.updateJobPositionProfile("a@x", 9, { summaryMd: "S" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("bulkJobPositionProfiles: sekvencijalno → {ok,fail,results}", async () => {
    const { svc, tx } = makeSvc();
    tx.jobPosition.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 }); // drugi ne postoji
    const out = await svc.bulkJobPositionProfiles("a@x", {
      items: [
        { id: 1, summaryMd: "A" },
        { id: 2, summaryMd: "B" },
      ],
    });
    expect(out.data).toEqual({
      ok: 1,
      fail: 1,
      results: [
        { id: 1, ok: true },
        { id: 2, ok: false, error: "not found" },
      ],
    });
  });
});

describe("PodesavanjaService P10 — kompetencije editor", () => {
  it("createCompetenceGroup: auto code (grp_) + isActive true + scope", async () => {
    const { svc, tx } = makeSvc();
    await svc.createCompetenceGroup("a@x", {
      nameSr: "Saradnja",
      scope: "core",
    });
    const data = tx.competenceGroup.create.mock.calls[0][0].data;
    expect(data.code).toMatch(/^grp_/);
    expect(data.isActive).toBe(true);
    expect(data.scope).toBe("core");
    expect(data.nameSr).toBe("Saradnja");
  });

  it("createCompetence: nivoi upsert (ispunjen) + prazan descriptor = DELETE nivoa", async () => {
    const { svc, tx } = makeSvc();
    await svc.createCompetence("a@x", {
      groupId: 2,
      nameSr: "Timski rad",
      levels: [
        { level: 0, descriptorSr: "opis 0" },
        { level: 1, descriptorSr: "   " }, // prazan → delete
      ],
    });
    expect(tx.competence.create.mock.calls[0][0].data.code).toMatch(/^cmp_/);
    expect(tx.competenceLevel.upsert).toHaveBeenCalledTimes(1); // samo level 0
    expect(tx.competenceLevel.deleteMany).toHaveBeenCalledTimes(1); // level 1 prazan
  });

  it("updateCompetence: 0 redova → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.competence.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.updateCompetence("a@x", 999, { nameSr: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("deleteCompetence: prvo briše nivoe pa kompetenciju (FK)", async () => {
    const { svc, tx } = makeSvc();
    await svc.deleteCompetence("a@x", 7);
    const lvlOrder = tx.competenceLevel.deleteMany.mock.invocationCallOrder[0];
    const compOrder = tx.competence.deleteMany.mock.invocationCallOrder[0];
    expect(lvlOrder).toBeLessThan(compOrder); // nivoi pre kompetencije
  });

  it("createCompetenceQuestion: groupId izostavljen → null (opšte)", async () => {
    const { svc, tx } = makeSvc();
    await svc.createCompetenceQuestion("a@x", { textSr: "Pitanje?" });
    const data = tx.competenceQuestion.create.mock.calls[0][0].data;
    expect(data.groupId).toBeNull();
    expect(data.code).toMatch(/^q_/);
    expect(data.isActive).toBe(true);
  });

  it("updateCompetenceQuestion: 0 redova → 404", async () => {
    const { svc, tx } = makeSvc();
    tx.competenceQuestion.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      svc.updateCompetenceQuestion("a@x", 999, { textSr: "X" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

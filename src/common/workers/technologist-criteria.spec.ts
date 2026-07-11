import {
  isActiveTechnologist,
  resolveTechnologistTypeIds,
  resolveTechnologistWorkerIds,
  technologistWorkerWhere,
  TECHNOLOGIST_TYPE_NAME,
  type TechnologistCriteriaDb,
} from "./technologist-criteria";

/** Minimalni mock db (samo workerType/worker findMany koje helperi diraju). */
function dbMock() {
  return {
    workerType: { findMany: jest.fn().mockResolvedValue([]) },
    worker: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

/** Cast na strukturni tip helpera (mock ne implementira ceo Prisma delegate). */
const asDb = (m: ReturnType<typeof dbMock>) =>
  m as unknown as TechnologistCriteriaDb;

describe("technologist-criteria (zajednički kriterijum §6.3)", () => {
  it("resolveTechnologistTypeIds: ILIKE po imenu 'Tehnolog', bez hardkodovanog id-a", async () => {
    const db = dbMock();
    db.workerType.findMany.mockResolvedValue([{ id: 1 }, { id: 4 }]);

    const ids = await resolveTechnologistTypeIds(asDb(db));

    expect(ids).toEqual([1, 4]);
    expect(db.workerType.findMany).toHaveBeenCalledWith({
      where: {
        name: { equals: TECHNOLOGIST_TYPE_NAME, mode: "insensitive" },
      },
      select: { id: true },
    });
  });

  it("resolveTechnologistTypeIds: izbacuje id<=0 (defanzivno)", async () => {
    const db = dbMock();
    db.workerType.findMany.mockResolvedValue([{ id: 0 }, { id: 2 }]);
    await expect(resolveTechnologistTypeIds(asDb(db))).resolves.toEqual([2]);
  });

  it("technologistWorkerWhere: active:true + workerTypeId IN typeIds", async () => {
    const db = dbMock();
    db.workerType.findMany.mockResolvedValue([{ id: 1 }]);

    await expect(technologistWorkerWhere(asDb(db))).resolves.toEqual({
      active: true,
      workerTypeId: { in: [1] },
    });
  });

  it("technologistWorkerWhere: nema vrste 'Tehnolog' → null (bez in:[])", async () => {
    const db = dbMock();
    await expect(technologistWorkerWhere(asDb(db))).resolves.toBeNull();
  });

  it("resolveTechnologistWorkerIds: dva batch upita bez required JOIN-a", async () => {
    const db = dbMock();
    db.workerType.findMany.mockResolvedValue([{ id: 1 }]);
    db.worker.findMany.mockResolvedValue([{ id: 7 }, { id: 9 }]);

    const ids = await resolveTechnologistWorkerIds(asDb(db));

    expect(ids).toEqual([7, 9]);
    expect(db.worker.findMany).toHaveBeenCalledWith({
      where: { active: true, workerTypeId: { in: [1] } },
      select: { id: true },
    });
  });

  it("resolveTechnologistWorkerIds: nema vrste 'Tehnolog' → [], radnici se ne traže", async () => {
    const db = dbMock();
    await expect(resolveTechnologistWorkerIds(asDb(db))).resolves.toEqual([]);
    expect(db.worker.findMany).not.toHaveBeenCalled();
  });

  it("isActiveTechnologist: true samo za aktivnog radnika vrste 'Tehnolog'", async () => {
    const db = dbMock();
    db.workerType.findMany.mockResolvedValue([{ id: 1 }]);

    await expect(
      isActiveTechnologist(asDb(db), { active: true, workerTypeId: 1 }),
    ).resolves.toBe(true);
    await expect(
      isActiveTechnologist(asDb(db), { active: true, workerTypeId: 2 }),
    ).resolves.toBe(false);
  });

  it("isActiveTechnologist: neaktivan/null active → false BEZ upita ka worker_types", async () => {
    const db = dbMock();

    await expect(
      isActiveTechnologist(asDb(db), { active: false, workerTypeId: 1 }),
    ).resolves.toBe(false);
    await expect(
      isActiveTechnologist(asDb(db), { active: null, workerTypeId: 1 }),
    ).resolves.toBe(false);
    expect(db.workerType.findMany).not.toHaveBeenCalled();
  });
});

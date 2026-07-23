import {
  MANAGEMENT_ROLE,
  resolveManagementRecipients,
  resolveManagementWorkerIds,
  type ManagementCriteriaDb,
} from "./management-criteria";

/** Minimalni mock db (samo user.findMany koji helperi diraju). */
function dbMock() {
  return { user: { findMany: jest.fn().mockResolvedValue([]) } };
}
const asDb = (m: ReturnType<typeof dbMock>) =>
  m as unknown as ManagementCriteriaDb;

describe("management-criteria (COO krug, zahtev 004/26 §2)", () => {
  it("kriterijum je rola 'menadzment'", () => {
    expect(MANAGEMENT_ROLE).toBe("menadzment");
  });

  it("resolveManagementWorkerIds: aktivni menadžment sa vezanim radnikom → distinct workerId", async () => {
    const db = dbMock();
    db.user.findMany.mockResolvedValue([
      { workerId: 5 },
      { workerId: 8 },
      { workerId: 5 }, // duplikat (dva naloga isti radnik)
    ]);

    const ids = await resolveManagementWorkerIds(asDb(db));

    expect(ids.sort()).toEqual([5, 8]);
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { role: "menadzment", active: true, workerId: { not: null } },
      select: { workerId: true },
    });
  });

  it("resolveManagementWorkerIds: prazan skup kad niko nema radnika → []", async () => {
    const db = dbMock();
    db.user.findMany.mockResolvedValue([]);
    expect(await resolveManagementWorkerIds(asDb(db))).toEqual([]);
  });

  it("resolveManagementRecipients: samo validni email-ovi, dedup case-insensitive", async () => {
    const db = dbMock();
    db.user.findMany.mockResolvedValue([
      { email: "coo@servoteh.com", fullName: "Direktor" },
      { email: "COO@servoteh.com", fullName: "Direktor (drugi nalog)" }, // dedup
      { email: "", fullName: "Bez mejla" }, // odbačen
      { email: "not-an-email", fullName: "Loš" }, // odbačen (nema @)
    ]);

    const recips = await resolveManagementRecipients(asDb(db));

    expect(recips).toHaveLength(1);
    expect(recips[0].email).toBe("coo@servoteh.com");
  });
});

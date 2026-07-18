import {
  resolveActorWorkerId,
  type ResolveActorWorkerDb,
} from "./resolve-actor-worker";

/** Minimalni db mock — samo `user.findUnique` koji helper dira. */
function dbMock(freshWorkerId: number | null = null) {
  const findUnique = jest
    .fn()
    .mockResolvedValue(
      freshWorkerId === undefined ? null : { workerId: freshWorkerId },
    );
  return { m: { user: { findUnique } }, findUnique };
}

const asDb = (m: { user: { findUnique: jest.Mock } }) =>
  m as unknown as ResolveActorWorkerDb;

describe("resolveActorWorkerId", () => {
  it("token IMA workerId → vrati ga i NE dira bazu", async () => {
    const { m, findUnique } = dbMock(999);
    const id = await resolveActorWorkerId(asDb(m), {
      userId: 37,
      workerId: 77,
    });
    expect(id).toBe(77);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("token nema workerId (null) → svež users.worker_id iz baze po userId", async () => {
    const { m, findUnique } = dbMock(197);
    const id = await resolveActorWorkerId(asDb(m), {
      userId: 37,
      workerId: null,
    });
    expect(id).toBe(197);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 37 },
      select: { workerId: true },
    });
  });

  it("token nema workerId i baza takođe NULL → null", async () => {
    const { m } = dbMock(null);
    const id = await resolveActorWorkerId(asDb(m), {
      userId: 37,
      workerId: null,
    });
    expect(id).toBeNull();
  });

  it("actor undefined → null bez upita", async () => {
    const { m, findUnique } = dbMock(197);
    const id = await resolveActorWorkerId(asDb(m), undefined);
    expect(id).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("actor bez userId (i bez workerId) → null bez upita", async () => {
    const { m, findUnique } = dbMock(197);
    const id = await resolveActorWorkerId(asDb(m), { workerId: null });
    expect(id).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("token workerId <= 0 tretira se kao 'nema' → ide na svež lookup", async () => {
    const { m, findUnique } = dbMock(197);
    const id = await resolveActorWorkerId(asDb(m), { userId: 37, workerId: 0 });
    expect(id).toBe(197);
    expect(findUnique).toHaveBeenCalled();
  });

  it("baza vrati workerId 0 → tretira se kao nema veze → null", async () => {
    const { m } = dbMock(0);
    const id = await resolveActorWorkerId(asDb(m), {
      userId: 37,
      workerId: null,
    });
    expect(id).toBeNull();
  });
});

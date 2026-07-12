import { SastanciService } from "./sastanci.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * RLS most + serializacija (review 12.07): pinuje da row-scoped read-ovi idu kroz
 * `withUserRls` (NE `withUser` — BYPASSRLS leak) i da BigInt kolone izlaze kao Number.
 * Row-ishod (koji red RLS vraća) dokazuje živi smoke u R2 — ovde samo ruta mosta.
 */
describe("SastanciService — withUserRls most + BigInt out", () => {
  function makeSvc() {
    const tx = {
      sastanak: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
      sastanciNotificationLog: { findMany: jest.fn().mockResolvedValue([]) },
      presekSlika: { findMany: jest.fn().mockResolvedValue([]) },
      sastanakArhiva: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const sy15 = {
      withUser: jest.fn(),
      withUserRls: jest.fn(
        (_email: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
      ),
    };
    const svc = new SastanciService(sy15 as unknown as Sy15Service);
    return { svc, sy15, tx };
  }

  it("notifications (RLS: svoje∨mgmt) ide kroz withUserRls, NIKAD withUser", async () => {
    const { svc, sy15 } = makeSvc();
    await svc.notifications("test@servoteh.com", {});
    expect(sy15.withUserRls).toHaveBeenCalledTimes(1);
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("listTeme (RLS: pm_teme vidljivost) ide kroz withUserRls", async () => {
    const { svc, sy15 } = makeSvc();
    await svc.listTeme("test@servoteh.com", {});
    expect(sy15.withUserRls).toHaveBeenCalledTimes(1);
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("list (SELECT true politika) TAKOĐE ide kroz withUserRls (jednoobrazan most)", async () => {
    const { svc, sy15 } = makeSvc();
    await svc.list("test@servoteh.com", {});
    expect(sy15.withUserRls).toHaveBeenCalled();
    expect(sy15.withUser).not.toHaveBeenCalled();
  });

  it("akcijeWeeklyDiff — paritet loadWeeklyDiffStats: {novo, zavrsenoOveNedelje, kasni, aktivnih}", async () => {
    const { svc, tx } = makeSvc();
    tx.$queryRaw.mockResolvedValueOnce([
      {
        novo: BigInt(2),
        zavrseno: BigInt(1),
        kasni: BigInt(3),
        aktivnih: BigInt(7),
      },
    ]);
    const out = await svc.akcijeWeeklyDiff("test@servoteh.com", {
      since: "2026-07-01T00:00:00Z",
    });
    expect(out.data).toEqual({
      novo: 2,
      zavrsenoOveNedelje: 1,
      kasni: 3,
      aktivnih: 7,
    });
  });

  it("search ispod 2 karaktera → prazno BEZ upita (paritet searchSastanciGlobal)", async () => {
    const { svc, sy15 } = makeSvc();
    const out = await svc.search("test@servoteh.com", "a");
    expect(out.data).toEqual({ akcije: [], sastanci: [] });
    expect(sy15.withUserRls).not.toHaveBeenCalled();
  });

  it("slike: sizeBytes BigInt → Number (res.json ne ume BigInt)", async () => {
    const { svc, tx } = makeSvc();
    tx.presekSlika.findMany.mockResolvedValueOnce([
      { id: "s1", sizeBytes: BigInt(123456) },
      { id: "s2", sizeBytes: null },
    ]);
    const out = await svc.slike(
      "test@servoteh.com",
      "3b241101-e2bb-4255-8caf-4136c566a962",
    );
    expect(out.data[0].sizeBytes).toBe(123456);
    expect(out.data[1].sizeBytes).toBeNull();
  });

  it("listArhive: zapisnikSizeBytes BigInt → Number", async () => {
    const { svc, tx } = makeSvc();
    tx.sastanakArhiva.findMany.mockResolvedValueOnce([
      { id: "a1", zapisnikSizeBytes: BigInt(987654321) },
    ]);
    const out = await svc.listArhive("test@servoteh.com");
    expect(out.data[0].zapisnikSizeBytes).toBe(987654321);
  });
});

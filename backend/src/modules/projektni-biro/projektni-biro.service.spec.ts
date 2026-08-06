import { ProjektniBiroService } from "./projektni-biro.service";
import { PbSourceService } from "../../common/sy15/pb-source.service";
import type { Sy15Service, Sy15Tx } from "../../common/sy15/sy15.service";

/**
 * Pin za HIGH nalaz (adversarni review R1): `listTips` MORA mapirati DTO na TAČNE
 * `pb_list_eng_tips(p_filter jsonb)` ključeve (`search`/`category_ids`/`tags`/`my_only`/
 * `include_drafts`/`sort`/`limit`/`offset`). Ranija verzija je slala `q`/`category_id`/
 * `status`/`project_id` → svaki filter TIH no-op (RPC ih ignoriše). Ovaj test hvata regresiju
 * tako što presreće `$queryRaw` i čita prosleđeni JSON iz `Prisma.Sql.values`.
 */
describe("ProjektniBiroService.listTips — mapiranje filtera (paritet pb_list_eng_tips)", () => {
  const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  const makeSvc = () => {
    const calls: unknown[] = [];
    const tx = {
      $queryRaw: jest.fn((sql: unknown) => {
        calls.push(sql);
        return Promise.resolve([]);
      }),
    } as unknown as Sy15Tx;
    const sy15 = {
      withUserRls: (_email: string, fn: (tx: Sy15Tx) => Promise<unknown>) =>
        fn(tx),
    } as unknown as Sy15Service;
    const storage =
      {} as unknown as import("../../common/sy15/sy15-storage.service").Sy15StorageService;
    return {
      svc: new ProjektniBiroService(sy15, storage, new PbSourceService()),
      calls,
    };
  };

  /** Izvuci prosleđeni p_filter JSON iz zabeleženog Prisma.Sql (jedini string value). */
  const filterOf = (calls: unknown[]): Record<string, unknown> => {
    const sql = calls[0] as { values: unknown[] };
    const jsonStr = sql.values.find((v) => typeof v === "string") as string;
    return JSON.parse(jsonStr) as Record<string, unknown>;
  };

  const ALLOWED = new Set([
    "search",
    "category_ids",
    "tags",
    "my_only",
    "include_drafts",
    "sort",
    "limit",
    "offset",
  ]);

  it("q → `search` (NE prosleđuje 'q')", async () => {
    const { svc, calls } = makeSvc();
    await svc.listTips("e@x", { q: "hidraulika" });
    const f = filterOf(calls);
    expect(f.search).toBe("hidraulika");
    expect(f).not.toHaveProperty("q");
  });

  it("categoryId (skalar) → `category_ids` niz; NEMA 'category_id'/'project_id'/'status'", async () => {
    const { svc, calls } = makeSvc();
    await svc.listTips("e@x", { categoryId: UUID });
    const f = filterOf(calls);
    expect(f.category_ids).toEqual([UUID]);
    expect(f).not.toHaveProperty("category_id");
    expect(f).not.toHaveProperty("project_id");
    expect(f).not.toHaveProperty("status");
  });

  it("tags CSV → text[] (trim, drop praznih); myOnly/includeDrafts/sort → RPC ključevi", async () => {
    const { svc, calls } = makeSvc();
    await svc.listTips("e@x", {
      tags: "cnc, hidraulika ,",
      myOnly: "true",
      includeDrafts: "true",
      sort: "popular",
    });
    const f = filterOf(calls);
    expect(f.tags).toEqual(["cnc", "hidraulika"]);
    expect(f.my_only).toBe(true);
    expect(f.include_drafts).toBe(true);
    expect(f.sort).toBe("popular");
  });

  it("defaulti = 1.0 paritet (search null, sort recent, limit 200, offset 0, flagovi false)", async () => {
    const { svc, calls } = makeSvc();
    await svc.listTips("e@x", {});
    expect(filterOf(calls)).toMatchObject({
      search: null,
      category_ids: null,
      tags: null,
      my_only: false,
      include_drafts: false,
      sort: "recent",
      limit: 200,
      offset: 0,
    });
  });

  it("limit se clampuje na [1,500] (RPC granice)", async () => {
    const { svc, calls } = makeSvc();
    await svc.listTips("e@x", { limit: "9999" });
    expect(filterOf(calls).limit).toBe(500);
  });

  it("SVI prosleđeni ključevi ∈ dozvoljeni RPC skup (tripwire za pogrešan ključ)", async () => {
    const { svc, calls } = makeSvc();
    await svc.listTips("e@x", {
      q: "x",
      categoryId: UUID,
      tags: "a",
      myOnly: "true",
      includeDrafts: "true",
      sort: "recent",
      limit: "10",
      offset: "5",
    });
    for (const k of Object.keys(filterOf(calls))) {
      expect({ key: k, allowed: ALLOWED.has(k) }).toEqual({
        key: k,
        allowed: true,
      });
    }
  });

  /*
   * 🔴 INCIDENT 06.08.2026: zajednički prekidač `SASTANCI_PB_IZVOR=3.0` je oborio
   * CEO ovaj modul u 503 iako se selio samo domen sastanaka. Od razdvajanja PB
   * gleda isključivo `PB_IZVOR`.
   */
  describe("prekidač PB_IZVOR je nezavisan od sastanaka", () => {
    const ENVS = ["SASTANCI_IZVOR", "PB_IZVOR", "SASTANCI_PB_IZVOR"] as const;
    const ORIG = Object.fromEntries(ENVS.map((k) => [k, process.env[k]]));
    beforeEach(() => {
      for (const k of ENVS) delete process.env[k];
    });
    afterEach(() => {
      for (const k of ENVS) {
        const o = ORIG[k];
        if (o === undefined) delete process.env[k];
        else process.env[k] = o;
      }
    });

    it("🔴 SASTANCI_IZVOR=3.0: PB rute rade normalno (scenario koji je pao)", async () => {
      process.env.SASTANCI_IZVOR = "3.0";
      const { svc, calls } = makeSvc();
      await expect(svc.listTips("e@x", {})).resolves.toBeDefined();
      expect(calls).toHaveLength(1);
    });

    it("zastareli SASTANCI_PB_IZVOR=3.0 ne obara PB (ne čita ga)", async () => {
      process.env.SASTANCI_PB_IZVOR = "3.0";
      const { svc, calls } = makeSvc();
      await expect(svc.listTips("e@x", {})).resolves.toBeDefined();
      expect(calls).toHaveLength(1);
    });

    it("PB_IZVOR=3.0: modul pada sa 503 PRE ijednog sy15 poziva (čeka kadrovsku)", async () => {
      process.env.PB_IZVOR = "3.0";
      const { svc, calls } = makeSvc();
      await expect(svc.listTips("e@x", {})).rejects.toThrow(
        /projektni biro: čitanje\/upis kroz sy15/,
      );
      expect(calls).toHaveLength(0);
    });
  });
});

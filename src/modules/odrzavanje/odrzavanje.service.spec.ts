import { OdrzavanjeService } from "./odrzavanje.service";
import { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * OdrzavanjeService (TALAS F, R1) unit — dva invarijanta bez žive baze:
 *  1) SVAKI read ide kroz `withUserRls` (GUC + SET LOCAL ROLE authenticated), NIKAD
 *     `db.*` direktno (BYPASSRLS) ni `withUser` (bez SET ROLE) → 102 RLS politike
 *     enforce-uju operator machine-scope/technician/chief/management **po konstrukciji**
 *     i za SINTETIČKE korisnike (nema živih operator/technician naloga — presuda F7).
 *  2) `/maintenance/me` FE-gate derivacija (paritet §2.4) za sintetički
 *     operator/technician/chief/management + „chief-bez-globalne-role" (floor-read).
 */
describe("OdrzavanjeService (R1 read sloj)", () => {
  type Tx = Record<string, unknown>;
  const makeTx = (over: Partial<Tx> = {}): Tx => ({
    $queryRaw: jest.fn().mockResolvedValue([]),
    maintMachine: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    maintIncident: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    maintWorkOrder: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    maintWoPart: { findMany: jest.fn().mockResolvedValue([]) },
    maintWoLabor: { findMany: jest.fn().mockResolvedValue([]) },
    maintPart: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    maintUserProfile: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ...over,
  });

  const makeSy15 = (tx: Tx) => {
    const withUserRls = jest.fn(
      (_email: string, fn: (t: Tx) => Promise<unknown>) => fn(tx),
    );
    const sy15 = {
      withUserRls,
      // db i withUser NE smeju da se koriste u read sloju (BYPASSRLS / bez SET ROLE).
      get db(): never {
        throw new Error("RLS bypass: db.* korišćen umesto withUserRls");
      },
      withUser: jest.fn(() => {
        throw new Error("withUser korišćen umesto withUserRls (nema SET ROLE)");
      }),
    } as unknown as Sy15Service;
    return { sy15, withUserRls };
  };

  it("listMachines ide kroz withUserRls sa email-om pozivaoca (RLS enforce, ne db.*)", async () => {
    const tx = makeTx();
    const { sy15, withUserRls } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15);
    await svc.listMachines("monter@servoteh.com", {});
    expect(withUserRls).toHaveBeenCalledTimes(1);
    expect(withUserRls.mock.calls[0][0]).toBe("monter@servoteh.com");
    // read je izvršen nad tx (RLS), a maint_machines je čitan kroz Prisma delegat.
    expect(
      (tx.maintMachine as { findMany: jest.Mock }).findMany,
    ).toHaveBeenCalledTimes(1);
  });

  it("listIncidents (prijava kvara vidljivost) takođe ide kroz withUserRls", async () => {
    const tx = makeTx();
    const { sy15, withUserRls } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15);
    await svc.listIncidents("operator@servoteh.com", {});
    expect(withUserRls).toHaveBeenCalledTimes(1);
    expect(withUserRls.mock.calls[0][0]).toBe("operator@servoteh.com");
  });

  // ------- /me gate derivacija (sintetički maint profili — F7) -------

  const meFor = async (row: {
    uid: string | null;
    maint_role: string | null;
    floor_read?: boolean;
    erp_admin?: boolean;
    erp_admin_or_management?: boolean;
  }) => {
    const helper = {
      uid: row.uid,
      maint_role: row.maint_role,
      floor_read: row.floor_read ?? false,
      erp_admin: row.erp_admin ?? false,
      erp_admin_or_management: row.erp_admin_or_management ?? false,
    };
    const tx = makeTx({
      $queryRaw: jest.fn().mockResolvedValue([helper]),
      maintUserProfile: {
        findUnique: jest
          .fn()
          .mockResolvedValue(
            row.uid
              ? { userId: row.uid, role: row.maint_role, active: true }
              : null,
          ),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });
    const { sy15 } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15);
    const res = (await svc.me("x@servoteh.com")) as {
      data: {
        maintRole: string | null;
        floorRead: boolean;
        erpAdminOrManagement: boolean;
        gates: Record<string, boolean>;
      };
    };
    return res.data;
  };

  it("sintetički OPERATOR (assigned machine-scope): bez katalog/WO/task prava", async () => {
    const d = await meFor({ uid: "u1", maint_role: "operator" });
    expect(d.maintRole).toBe("operator");
    expect(d.gates.canManageMaintCatalog).toBe(false);
    expect(d.gates.canEditWorkOrder).toBe(false);
    expect(d.gates.canManageMaintTasks).toBe(false);
    expect(d.gates.canCreateWo).toBe(false);
    expect(d.gates.canMoveInventory).toBe(false);
  });

  it("sintetički TECHNICAN: edit WO + kreiraj WO + move zaliha, ali NE katalog/tasks/override", async () => {
    const d = await meFor({ uid: "u2", maint_role: "technician" });
    expect(d.gates.canEditWorkOrder).toBe(true);
    expect(d.gates.canCreateWo).toBe(true);
    expect(d.gates.canMoveInventory).toBe(true);
    expect(d.gates.canManageMaintCatalog).toBe(false);
    expect(d.gates.canManageMaintTasks).toBe(false);
    expect(d.gates.canManageMaintOverride).toBe(false);
  });

  it("sintetički CHIEF: pun katalog/tasks/override/WO/inventar/notifikacije", async () => {
    const d = await meFor({ uid: "u3", maint_role: "chief" });
    expect(d.gates.canManageMaintCatalog).toBe(true);
    expect(d.gates.canManageMaintTasks).toBe(true);
    expect(d.gates.canManageMaintOverride).toBe(true);
    expect(d.gates.canEditWorkOrder).toBe(true);
    expect(d.gates.canManageInventory).toBe(true);
    expect(d.gates.canAccessMaintNotifications).toBe(true);
  });

  it("chief-bez-globalne-role (floor-read=false, bez erp, ali chief profil) i dalje upravlja (§2.5.1)", async () => {
    const d = await meFor({
      uid: "u4",
      maint_role: "chief",
      floor_read: false,
      erp_admin_or_management: false,
    });
    expect(d.floorRead).toBe(false);
    expect(d.erpAdminOrManagement).toBe(false);
    // chief profil sam po sebi otvara katalog (paritet §2.4/§2.5.1) — ne zavisi od ERP role.
    expect(d.gates.canManageMaintCatalog).toBe(true);
  });

  it("MANAGEMENT/magacioner (erp adm/mgmt), bez maint profila: katalog+notifikacije, WO edit, ali NE tasks (chief/admin-only)", async () => {
    const d = await meFor({
      uid: null,
      maint_role: null,
      erp_admin_or_management: true,
    });
    expect(d.maintRole).toBeNull();
    expect(d.gates.canManageMaintCatalog).toBe(true);
    expect(d.gates.canEditWorkOrder).toBe(true);
    expect(d.gates.canAccessMaintNotifications).toBe(true);
    expect(d.gates.canManageMaintTasks).toBe(false); // ⚠ BEZ erp kruga (§2.4)
  });

  it("korisnik bez ijednog sloja (ni profil ni floor-read): sva gate-a false (ali read/report guard opšte pravo)", async () => {
    const d = await meFor({ uid: "u9", maint_role: null });
    for (const g of Object.values(d.gates)) expect(g).toBe(false);
  });

  // ------- adversarni review fix-evi (2026-07-13) -------

  it("dashboard konvertuje int8 (bigint) sažetak u Number (JSON-safe, #4)", async () => {
    const tx = makeTx({
      $queryRaw: jest
        .fn()
        // redosled poziva: machineStatus, dailySummary, categoryCounts
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { active_work_orders: 5n, open_incidents: 2n, open_wo_p1: 1n },
        ])
        .mockResolvedValueOnce([]),
      maintIncident: { count: jest.fn().mockResolvedValue(2) },
      maintWorkOrder: { count: jest.fn().mockResolvedValue(5) },
    });
    const { sy15 } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15);
    const res = (await svc.dashboard("x@servoteh.com")) as unknown as {
      data: { dailySummary: Record<string, unknown> };
    };
    const s = res.data.dailySummary;
    for (const v of Object.values(s)) expect(typeof v).toBe("number");
    expect(s.active_work_orders).toBe(5);
  });

  it("listIncidents ugnježđuje WO summary po work_order_id (#6, paritet 1.0)", async () => {
    const tx = makeTx({
      maintIncident: {
        findMany: jest.fn().mockResolvedValue([
          { id: "i1", workOrderId: "w1" },
          { id: "i2", workOrderId: null },
        ]),
        count: jest.fn().mockResolvedValue(2),
      },
      maintWorkOrder: {
        findMany: jest.fn().mockResolvedValue([
          {
            woId: "w1",
            woNumber: "WO-2026-00001",
            status: "novi",
            title: "T",
            priority: "p1_zastoj",
          },
        ]),
      },
    });
    const { sy15 } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15);
    const res = (await svc.listIncidents("x@servoteh.com", {})) as {
      data: { id: string; workOrder: { woNumber: string } | null }[];
    };
    expect(res.data[0].workOrder?.woNumber).toBe("WO-2026-00001");
    expect(res.data[1].workOrder).toBeNull();
  });

  it("reportWorkOrderCosts agregira LINE-ITEM-e (wo_parts×unit_cost + fallback, wo_labor min) — #5", async () => {
    const tx = makeTx({
      maintWorkOrder: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { woId: "w1", type: "kvar", assetType: "machine" },
          ]),
      },
      maintWoPart: {
        findMany: jest.fn().mockResolvedValue([
          { woId: "w1", partId: null, quantity: 2, unitCost: 10 }, // 20
          { woId: "w1", partId: "p1", quantity: 3, unitCost: null }, // fallback 5 → 15
        ]),
      },
      maintWoLabor: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ minutes: 30 }, { minutes: 45 }]),
      },
      maintPart: {
        findMany: jest.fn().mockResolvedValue([{ partId: "p1", unitCost: 5 }]),
      },
    });
    const { sy15 } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15);
    const res = (await svc.reportWorkOrderCosts("x@servoteh.com", "90")) as {
      data: {
        partsCost: number;
        laborMinutes: number;
        costByAssetType: Record<string, number>;
      };
    };
    expect(res.data.partsCost).toBe(35); // 2*10 + 3*5(fallback)
    expect(res.data.laborMinutes).toBe(75);
    expect(res.data.costByAssetType.machine).toBe(35);
  });
});

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { OdrzavanjeService } from "./odrzavanje.service";
import { Sy15Service } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { MasinaOtpisNotifyService } from "./masina-otpis-notify.service";

/** Storage proxy nikad ne sme da se dodirne u read sloju — svaki poziv = greška. */
const storageStub = {
  upload: jest.fn(() => {
    throw new Error("storage.upload korišćen u read sloju");
  }),
  signUrl: jest.fn(() => {
    throw new Error("storage.signUrl korišćen u read sloju");
  }),
  remove: jest.fn(() => {
    throw new Error("storage.remove korišćen u read sloju");
  }),
} as unknown as Sy15StorageService;

/**
 * Obaveštenje o otpisu mašine (037/26) je fire-and-forget sporedni efekat — u testovima
 * koji ga ne proveravaju dovoljan je nem stub. Testovi otpisa prave svoj i asertuju nad njim.
 */
const makeNotify = () => ({
  notifyOtpis: jest.fn().mockResolvedValue(undefined),
});
const notifyStub = () => makeNotify() as unknown as MasinaOtpisNotifyService;

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
    const runIdempotentRls = jest.fn(
      async (
        _email: string,
        _cid: string,
        _action: string,
        fn: (t: Tx) => Promise<unknown>,
      ) => ({ result: await fn(tx), idempotent: false }),
    );
    const sy15 = {
      withUserRls,
      runIdempotentRls,
      // db i withUser NE smeju da se koriste u read sloju (BYPASSRLS / bez SET ROLE).
      get db(): never {
        throw new Error("RLS bypass: db.* korišćen umesto withUserRls");
      },
      withUser: jest.fn(() => {
        throw new Error("withUser korišćen umesto withUserRls (nema SET ROLE)");
      }),
    } as unknown as Sy15Service;
    return { sy15, withUserRls, runIdempotentRls };
  };

  it("listMachines ide kroz withUserRls sa email-om pozivaoca (RLS enforce, ne db.*)", async () => {
    const tx = makeTx();
    const { sy15, withUserRls } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
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
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
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
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
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

  it("MANAGEMENT/magacioner (erp adm/mgmt), bez maint profila: katalog+notifikacije, WO edit, I tasks (1.0 paritet)", async () => {
    const d = await meFor({
      uid: null,
      maint_role: null,
      erp_admin_or_management: true,
    });
    expect(d.maintRole).toBeNull();
    expect(d.gates.canManageMaintCatalog).toBe(true);
    expect(d.gates.canEditWorkOrder).toBe(true);
    expect(d.gates.canAccessMaintNotifications).toBe(true);
    expect(d.gates.canManageMaintTasks).toBe(true); // 1.0 maintTasksTab.js:32-35 — erp krug UKLJUČEN (audit 17.07 oborio spec §2.4)
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
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
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
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
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
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
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

  it("reportWorkOrderCosts: faktura servisa (cost_total) se NE sabira sa delovima — uzima se veći (03.08.2026)", async () => {
    const tx = makeTx({
      maintWorkOrder: {
        findMany: jest.fn().mockResolvedValue([
          // w1: faktura 5000 > delovi 200 → 5000 (servis fakturisao i te delove)
          { woId: "w1", type: "servis", assetType: "vehicle", costTotal: 5000 },
          // w2: delovi 900 > faktura 100 → 900 (sopstveni rad, faktura sitna)
          { woId: "w2", type: "servis", assetType: "vehicle", costTotal: 100 },
          // w3: samo faktura, bez ijedne stavke → 1500
          { woId: "w3", type: "servis", assetType: "machine", costTotal: 1500 },
          // w4: bez ičega → ne ulazi u zbir
          { woId: "w4", type: "servis", assetType: "machine", costTotal: null },
        ]),
      },
      maintWoPart: {
        findMany: jest.fn().mockResolvedValue([
          { woId: "w1", partId: null, quantity: 2, unitCost: 100 }, // 200
          { woId: "w2", partId: null, quantity: 3, unitCost: 300 }, // 900
        ]),
      },
      maintWoLabor: { findMany: jest.fn().mockResolvedValue([]) },
      maintPart: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const { sy15 } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
    const res = (await svc.reportWorkOrderCosts("x@servoteh.com", "90")) as {
      data: { partsCost: number; costByAssetType: Record<string, number> };
    };
    // 5000 + 900 + 1500 = 7400 (a NE 5000+200+900+100+1500 = 7700)
    expect(res.data.partsCost).toBe(7400);
    expect(res.data.costByAssetType.vehicle).toBe(5900);
    expect(res.data.costByAssetType.machine).toBe(1500);
  });

  // ------- R2 mutacije — adversarni fix-evi (2026-07-17) -------

  it("updateWorkOrder: ponovljeni 'zavrsen' NE pregazi postojeći completed_at (#1 skriveno pravilo 9)", async () => {
    const past = new Date("2026-07-16T10:00:00Z");
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = makeTx({
      $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
      maintWorkOrder: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ startedAt: past, completedAt: past })
          .mockResolvedValueOnce({ woId: "w1", status: "zavrsen" }),
        updateMany,
        count: jest.fn().mockResolvedValue(1),
      },
    });
    const { sy15 } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
    await svc.updateWorkOrder("x@servoteh.com", "w1", {
      status: "zavrsen",
    } as never);
    // completed_at se NE dira (ni DTO ni pečat) → originalni završetak očuvan.
    expect(updateMany.mock.calls[0][0].data.completedAt).toBeUndefined();
  });

  it("updateWorkOrder: prvi prelaz u 'zavrsen' PEČATIRA completed_at", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = makeTx({
      $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
      maintWorkOrder: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({ startedAt: null, completedAt: null })
          .mockResolvedValueOnce({ woId: "w1", status: "zavrsen" }),
        updateMany,
        count: jest.fn().mockResolvedValue(1),
      },
    });
    const { sy15 } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
    await svc.updateWorkOrder("x@servoteh.com", "w1", {
      status: "zavrsen",
    } as never);
    expect(updateMany.mock.calls[0][0].data.completedAt).toBeInstanceOf(Date);
  });

  it("createWoPart: kataloški deo — naziv i cena IZ KATALOGA (DTO unit_cost ignorisan), ledger = katalog (#4)", async () => {
    const CID2 = "3b241101-e2bb-4255-8caf-4136c566a963";
    const woPartCreate = jest.fn().mockResolvedValue({ id: "wp1" });
    const stockCreate = jest.fn().mockResolvedValue({});
    const tx = makeTx({
      $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
      maintPart: {
        findUnique: jest.fn().mockResolvedValue({
          name: "Ležaj 6203",
          unit: "kom",
          unitCost: 12.5,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      maintWoPart: {
        create: woPartCreate,
        findMany: jest.fn().mockResolvedValue([]),
      },
      maintWorkOrder: {
        findUnique: jest.fn().mockResolvedValue({ woNumber: "WO-2026-00001" }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      maintPartStockMovement: { create: stockCreate },
      maintWoEvent: { create: jest.fn().mockResolvedValue({}) },
    });
    const { sy15 } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
    await svc.createWoPart("x@servoteh.com", "w1", {
      clientEventId: CID2,
      partName: "slobodan (pogrešan) naziv",
      partId: "p1",
      quantity: 2,
      unitCost: 999, // ručni DTO — MORA biti ignorisan za kataloški deo
    } as never);
    const partData = woPartCreate.mock.calls[0][0].data;
    expect(partData.partName).toBe("Ležaj 6203"); // katalog pobeđuje (1.0 :686)
    expect(Number(partData.unitCost)).toBe(12.5); // katalog, ne 999 (1.0 :689)
    const mvData = stockCreate.mock.calls[0][0].data;
    expect(Number(mvData.unitCost)).toBe(12.5); // ledger cena = katalog (1.0 :702)
    expect(String(mvData.note)).toContain("Ležaj 6203");
  });

  it("createWoPart: slobodan unos (bez partId) zadržava DTO polja i NE dira ledger", async () => {
    const CID3 = "3b241101-e2bb-4255-8caf-4136c566a964";
    const woPartCreate = jest.fn().mockResolvedValue({ id: "wp2" });
    const stockCreate = jest.fn().mockResolvedValue({});
    const partFindUnique = jest.fn();
    const tx = makeTx({
      $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
      maintPart: {
        findUnique: partFindUnique,
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      maintWoPart: {
        create: woPartCreate,
        findMany: jest.fn().mockResolvedValue([]),
      },
      maintPartStockMovement: { create: stockCreate },
      maintWoEvent: { create: jest.fn().mockResolvedValue({}) },
    });
    const { sy15 } = makeSy15(tx);
    const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
    await svc.createWoPart("x@servoteh.com", "w1", {
      clientEventId: CID3,
      partName: "Zaptivka (ručno)",
      quantity: 1,
      unitCost: 7,
    } as never);
    expect(partFindUnique).not.toHaveBeenCalled(); // nema katalog razrešenja
    const partData = woPartCreate.mock.calls[0][0].data;
    expect(partData.partName).toBe("Zaptivka (ručno)");
    expect(Number(partData.unitCost)).toBe(7); // DTO zadržan (2.0 nadogradnja)
    expect(stockCreate).not.toHaveBeenCalled(); // bez partId → bez kretanja zaliha
  });

  // ------- Foto vozila (F2-P4a: upload/sign/delete, storage proxy, 1.0 putanje) -------
  describe("Foto vozila (storage proxy, 1.0-kompatibilne putanje)", () => {
    const makeStorage = () => ({
      upload: jest.fn().mockResolvedValue(undefined),
      signUrl: jest
        .fn()
        .mockResolvedValue({ url: "https://sy15/sign", expiresIn: 3600 }),
      remove: jest.fn().mockResolvedValue(undefined),
    });
    const asStorage = (s: ReturnType<typeof makeStorage>) =>
      s as unknown as Sy15StorageService;

    const VEH = "3b241101-e2bb-4255-8caf-4136c566a970";
    // Format presuđuje SADRŽAJ (`common/attachments`) — fixture nosi pravo JPEG zaglavlje.
    const imgFile = (over: Partial<Express.Multer.File> = {}) =>
      ({
        originalname: "vozilo.jpg",
        mimetype: "image/jpeg",
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
        ...over,
      }) as Express.Multer.File;

    it("upload: maint_documents (vehicle_photo, 1.0 putanja) → bajtovi u bucket → upsert pointer", async () => {
      const docCreate = jest
        .fn()
        .mockResolvedValue({ documentId: "d1", sizeBytes: 3n });
      const detUpsert = jest.fn().mockResolvedValue({});
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintAsset: {
          findFirst: jest.fn().mockResolvedValue({ assetId: VEH }),
        },
        maintDocument: { create: docCreate, deleteMany: jest.fn() },
        maintVehicleDetails: { upsert: detUpsert },
      });
      const { sy15, withUserRls } = makeSy15(tx);
      const storage = makeStorage();
      const svc = new OdrzavanjeService(sy15, asStorage(storage), notifyStub());
      const res = (await svc.uploadVehiclePhoto(
        "chief@servoteh.com",
        VEH,
        imgFile(),
      )) as { data: { primaryPhotoStoragePath: string } };
      // (1) meta PRE bajtova, 1.0-kompatibilna putanja + category
      expect(docCreate).toHaveBeenCalledTimes(1);
      const docData = docCreate.mock.calls[0][0].data;
      expect(docData.category).toBe("vehicle_photo");
      expect(docData.entityType).toBe("asset");
      expect(String(docData.storagePath)).toMatch(
        new RegExp(`^documents/asset/${VEH}/`),
      );
      // (2) bajtovi u bucket maint-machine-files na ISTU putanju
      expect(storage.upload).toHaveBeenCalledTimes(1);
      expect(storage.upload.mock.calls[0][0]).toBe("maint-machine-files");
      expect(storage.upload.mock.calls[0][1]).toBe(docData.storagePath);
      // (3) pointer upsert = ta putanja
      expect(detUpsert).toHaveBeenCalledTimes(1);
      expect(detUpsert.mock.calls[0][0].update.primaryPhotoStoragePath).toBe(
        docData.storagePath,
      );
      expect(res.data.primaryPhotoStoragePath).toBe(docData.storagePath);
      expect(withUserRls).toHaveBeenCalled();
    });

    it("upload: nepoznat/nije vozilo → 404, bez document.create i bez storage.upload", async () => {
      const docCreate = jest.fn();
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintAsset: { findFirst: jest.fn().mockResolvedValue(null) },
        maintDocument: { create: docCreate, deleteMany: jest.fn() },
        maintVehicleDetails: { upsert: jest.fn() },
      });
      const { sy15 } = makeSy15(tx);
      const storage = makeStorage();
      const svc = new OdrzavanjeService(sy15, asStorage(storage), notifyStub());
      await expect(
        svc.uploadVehiclePhoto("x@servoteh.com", VEH, imgFile()),
      ).rejects.toThrow(NotFoundException);
      expect(docCreate).not.toHaveBeenCalled();
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("upload: PDF (magic bytes) → 422 pre ijednog upisa/storage poziva", async () => {
      const tx = makeTx({
        maintAsset: { findFirst: jest.fn() },
        maintDocument: { create: jest.fn() },
      });
      const { sy15 } = makeSy15(tx);
      const storage = makeStorage();
      const svc = new OdrzavanjeService(sy15, asStorage(storage), notifyStub());
      await expect(
        svc.uploadVehiclePhoto(
          "x@servoteh.com",
          VEH,
          // Karton vozila prikazuje foto kroz `<img>` — PDF nema gde da se vidi.
          imgFile({
            originalname: "saobracajna.pdf",
            mimetype: "image/jpeg",
            buffer: Buffer.from("%PDF-1.7\n", "latin1"),
          }),
        ),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("🔴 upload: HEIC etiketiran kao image/jpeg → 422 (ranije je prolazio i ostajao nevidljiv)", async () => {
      const tx = makeTx({
        maintAsset: { findFirst: jest.fn() },
        maintDocument: { create: jest.fn() },
      });
      const { sy15 } = makeSy15(tx);
      const storage = makeStorage();
      const svc = new OdrzavanjeService(sy15, asStorage(storage), notifyStub());
      let msg = "";
      try {
        await svc.uploadVehiclePhoto(
          "x@servoteh.com",
          VEH,
          imgFile({
            originalname: "IMG_0007.HEIC",
            mimetype: "image/jpeg",
            buffer: Buffer.concat([
              Buffer.from([0x00, 0x00, 0x00, 0x18]),
              Buffer.from("ftypheic", "latin1"),
            ]),
          }),
        );
      } catch (e) {
        expect(e).toBeInstanceOf(UnprocessableEntityException);
        msg = (e as Error).message;
      }
      expect(msg).toContain("IMG_0007.HEIC");
      expect(msg).toContain("HEIC");
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("sign URL: bez foto → 404 čisto, storage.signUrl netaknut", async () => {
      const tx = makeTx({
        maintAsset: {
          findFirst: jest.fn().mockResolvedValue({ assetId: VEH }),
        },
        maintVehicleDetails: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ primaryPhotoStoragePath: null }),
        },
      });
      const { sy15 } = makeSy15(tx);
      const storage = makeStorage();
      const svc = new OdrzavanjeService(sy15, asStorage(storage), notifyStub());
      await expect(svc.vehiclePhotoUrl("x@servoteh.com", VEH)).rejects.toThrow(
        NotFoundException,
      );
      expect(storage.signUrl).not.toHaveBeenCalled();
    });

    it("sign URL: sa foto → signUrl(bucket, path, 3600)", async () => {
      const path = `documents/asset/${VEH}/abc_vozilo.jpg`;
      const tx = makeTx({
        maintAsset: {
          findFirst: jest.fn().mockResolvedValue({ assetId: VEH }),
        },
        maintVehicleDetails: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ primaryPhotoStoragePath: path }),
        },
      });
      const { sy15 } = makeSy15(tx);
      const storage = makeStorage();
      const svc = new OdrzavanjeService(sy15, asStorage(storage), notifyStub());
      await svc.vehiclePhotoUrl("x@servoteh.com", VEH);
      expect(storage.signUrl).toHaveBeenCalledWith(
        "maint-machine-files",
        path,
        3600,
      );
    });

    it("delete: skida pointer (updateMany → null) + best-effort storage.remove", async () => {
      const path = `documents/asset/${VEH}/abc_vozilo.jpg`;
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintVehicleDetails: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ primaryPhotoStoragePath: path }),
          updateMany,
        },
      });
      const { sy15 } = makeSy15(tx);
      const storage = makeStorage();
      const svc = new OdrzavanjeService(sy15, asStorage(storage), notifyStub());
      await svc.deleteVehiclePhoto("x@servoteh.com", VEH);
      expect(
        updateMany.mock.calls[0][0].data.primaryPhotoStoragePath,
      ).toBeNull();
      expect(storage.remove).toHaveBeenCalledWith("maint-machine-files", path);
    });

    it("delete: bez foto → idempotentno ok, bez updateMany i bez storage.remove", async () => {
      const updateMany = jest.fn();
      const tx = makeTx({
        maintVehicleDetails: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ primaryPhotoStoragePath: null }),
          updateMany,
        },
      });
      const { sy15 } = makeSy15(tx);
      const storage = makeStorage();
      const svc = new OdrzavanjeService(sy15, asStorage(storage), notifyStub());
      const res = (await svc.deleteVehiclePhoto("x@servoteh.com", VEH)) as {
        data: { ok: boolean };
      };
      expect(res.data.ok).toBe(true);
      expect(updateMany).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });

  // ------- Foto incidenta: format se presuđuje PRE ijednog bajta u bucketu -------
  // Ranije ovde nije bilo NIKAKVE provere formata: sirov HEIC sa telefona odlazio je
  // u bucket i ostajao trajno nevidljiv (prikaz je `<img>`). Sada validacija cele
  // serije prethodi prvom upload-u → nema ni orphan fajlova ni nevidljivog dokaza.
  describe("Foto incidenta (attachIncidentFiles) — validacija pre upload-a", () => {
    const INC = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const makeStorage = () => ({
      upload: jest.fn().mockResolvedValue(undefined),
      signUrl: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    });
    const asStorage = (s: ReturnType<typeof makeStorage>) =>
      s as unknown as Sy15StorageService;
    const jpeg = (name = "kvar.jpg") =>
      ({
        originalname: name,
        mimetype: "image/jpeg",
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      }) as Express.Multer.File;
    const heic = (name = "IMG_3311.HEIC") =>
      ({
        originalname: name,
        mimetype: "image/jpeg", // klijent laže — presuđuje sadržaj
        buffer: Buffer.concat([
          Buffer.from([0x00, 0x00, 0x00, 0x18]),
          Buffer.from("ftypheic", "latin1"),
        ]),
      }) as Express.Multer.File;

    const svcWith = (storage: ReturnType<typeof makeStorage>) => {
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ ok: true }]),
        maintIncident: {
          findUnique: jest.fn().mockResolvedValue({ machineCode: "M-01" }),
        },
      });
      const { sy15 } = makeSy15(tx);
      return new OdrzavanjeService(sy15, asStorage(storage), notifyStub());
    };

    it("🔴 HEIC → 422 i NIJEDAN bajt ne ode u bucket", async () => {
      const storage = makeStorage();
      let msg = "";
      try {
        await svcWith(storage).attachIncidentFiles("x@servoteh.com", INC, [
          heic(),
        ]);
      } catch (e) {
        expect(e).toBeInstanceOf(UnprocessableEntityException);
        msg = (e as Error).message;
      }
      expect(msg).toContain("IMG_3311.HEIC");
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("🔴 jedan loš u seriji obara CELU seriju pre prvog upload-a", async () => {
      const storage = makeStorage();
      await expect(
        svcWith(storage).attachIncidentFiles("x@servoteh.com", INC, [
          jpeg("dobra.jpg"),
          heic("losa.heic"),
        ]),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it("validne fotke → upload sa KANONSKIM content-type-om (ne klijentovim)", async () => {
      const storage = makeStorage();
      await svcWith(storage).attachIncidentFiles("x@servoteh.com", INC, [
        jpeg(),
      ]);
      expect(storage.upload).toHaveBeenCalledTimes(1);
      const call = storage.upload.mock.calls[0] as unknown[];
      expect(call[3]).toBe("image/jpeg");
    });
  });

  // ------- SoD granica profila (assertErpAdmin — H19/H20) -------
  // App-nivo brana: mutacije profila SME SAMO ERP admin. Coarse WRITE guard (kontroler)
  // pušta ceo admin_ui krug (menadzment/magacioner sa odrzavanje.write) → BEZ ovog
  // servisnog assert-a bi ne-erp WRITE-holder eskalirao sebi CMMS rolu. `maint_is_erp_admin()`
  // se mokuje kroz $queryRaw ([{ ok }]); false → Forbidden"(403), true → prolaz.
  describe("SoD granica profila (assertErpAdmin blokira admin_ui krug)", () => {
    const profileTx = (erpAdmin: boolean) =>
      makeTx({
        // assertErpAdmin: SELECT maint_is_erp_admin() → [{ ok }]; uid(): [{ uid }].
        $queryRaw: jest.fn().mockResolvedValue([{ ok: erpAdmin, uid: "u1" }]),
        maintUserProfile: {
          findUnique: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(1),
          create: jest.fn().mockResolvedValue({ userId: "u2" }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
    const CID = "3b241101-e2bb-4255-8caf-4136c566a962";

    it("listProfiles: NE-erp-admin (WRITE-holder) → 403 (ne curi ceo registar)", async () => {
      const { sy15 } = makeSy15(profileTx(false));
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(svc.listProfiles("magacioner@servoteh.com")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("createProfile: NE-erp-admin → 403 PRE ijednog upisa (privilege-escalation blok)", async () => {
      const tx = profileTx(false);
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(
        svc.createProfile("menadzment@servoteh.com", {
          clientEventId: CID,
          userId: "u2",
          fullName: "X",
          role: "technician",
        } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(
        (tx.maintUserProfile as { create: jest.Mock }).create,
      ).not.toHaveBeenCalled();
    });

    it("updateProfile: NE-erp-admin → 403 PRE updateMany", async () => {
      const tx = profileTx(false);
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(
        svc.updateProfile("magacioner@servoteh.com", "u2", {
          fullName: "X",
        } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(
        (tx.maintUserProfile as { updateMany: jest.Mock }).updateMany,
      ).not.toHaveBeenCalled();
    });

    it("erp-admin: listProfiles prolazi (registar dostupan)", async () => {
      const { sy15 } = makeSy15(profileTx(true));
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      const res = (await svc.listProfiles("erp@servoteh.com")) as {
        data: unknown[];
      };
      expect(Array.isArray(res.data)).toBe(true);
    });

    it("erp-admin: createProfile upisuje (assertErpAdmin propušta)", async () => {
      const tx = profileTx(true);
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.createProfile("erp@servoteh.com", {
        clientEventId: CID,
        userId: "u2",
        fullName: "X",
        role: "technician",
      } as never);
      expect(
        (tx.maintUserProfile as { create: jest.Mock }).create,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("RLS violacija (42501) iz Prisma poruke → 403, ne 500", () => {
    /* Prisma vraća RLS violaciju kao PrismaClientUnknownRequestError sa 42501 SAMO u tekstu
       poruke (bez strukturnog `code`/`meta.code`). rethrowSy15 mora to uhvatiti (soft-delete
       napomene/fajla/dokumenta = pre-postojeći 1.0 defekt; 1.0 CUTOVER_AUDIT_odrzavanje §4.2). */
    const noteTx = (updateMany: jest.Mock) =>
      makeTx({
        maintMachineNote: {
          count: jest.fn().mockResolvedValue(1),
          updateMany,
        },
      } as never);

    it("updateNote soft-delete: 42501 u poruci → ForbiddenException (403)", async () => {
      const rlsErr = new Error(
        "Invalid `prisma.maintMachineNote.updateMany()` invocation: ConnectorError " +
          '(PostgresError { code: "42501", message: "new row violates row-level security ' +
          'policy for table \\"maint_machine_notes\\"" })',
      );
      const tx = noteTx(jest.fn().mockRejectedValue(rlsErr));
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(
        svc.updateNote("erp@servoteh.com", "note-1", {
          deleted: true,
        } as never),
      ).rejects.toThrow(ForbiddenException);
    });

    it("updateNote pinned (bez RLS greške) → prolazi { ok: true }", async () => {
      const tx = noteTx(jest.fn().mockResolvedValue({ count: 1 }));
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      const res = (await svc.updateNote("erp@servoteh.com", "note-1", {
        pinned: true,
      } as never)) as { data: { ok: boolean } };
      expect(res).toEqual({ data: { ok: true } });
    });

    it("ne-RLS greška se NE maskira u 403 (propagira se dalje)", async () => {
      const other = new Error("neka druga DB greška (npr. konekcija/timeout)");
      const tx = noteTx(jest.fn().mockRejectedValue(other));
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(
        svc.updateNote("erp@servoteh.com", "note-1", {
          deleted: true,
        } as never),
      ).rejects.not.toThrow(ForbiddenException);
    });
  });

  // ------- Otpis mašine (zahtev 037/26) -------

  describe("otpisMachine — arhiviranje umesto brisanja + obaveštenje šefu", () => {
    const ASSET = "a1111111-1111-4111-8111-111111111111";

    /**
     * `$queryRaw` u toku otpisa/restore-a opslužuje TRI različita upita, a razlikuju
     * se po broju vezanih vrednosti: `auth.uid()` (0), izbor prve slobodne šifre (1)
     * i `maint_machine_rename` RPC (2). `free: null` = nijedan kandidat nije slobodan.
     */
    const smartQueryRaw = (free?: string | null) =>
      jest.fn((sql: { values?: unknown[] }) => {
        const values = sql?.values ?? [];
        if (values.length === 1)
          return Promise.resolve(
            free === null ? [] : [{ code: free ?? String(values[0]) }],
          );
        if (values.length === 2) return Promise.resolve([{ result: {} }]);
        return Promise.resolve([{ uid: "u1" }]);
      });

    /** tx sa mašinom, ogledalom u maint_assets i (opciono) otvorenim nalozima. */
    const otpisTx = (over: {
      archivedAt?: Date | null;
      openWos?: Array<{
        woNumber: string | null;
        title: string;
        status: string;
      }>;
      machineUpdate?: jest.Mock;
      assetUpdate?: jest.Mock;
      /** `null` → nema slobodne šifre (svih 50 kandidata zauzeto). */
      freeCode?: string | null;
    }) => {
      const machineUpdate =
        over.machineUpdate ?? jest.fn().mockResolvedValue({ count: 1 });
      const assetUpdate =
        over.assetUpdate ?? jest.fn().mockResolvedValue({ count: 1 });
      const tx = makeTx({
        $queryRaw: smartQueryRaw(over.freeCode),
        maintMachine: {
          findUnique: jest.fn().mockResolvedValue({
            machineCode: "M-01",
            name: "Presa 100t",
            assetId: ASSET,
            archivedAt: over.archivedAt ?? null,
          }),
          updateMany: machineUpdate,
          count: jest.fn().mockResolvedValue(1),
        },
        maintAsset: { updateMany: assetUpdate, findUnique: jest.fn() },
        maintWorkOrder: {
          findMany: jest.fn().mockResolvedValue(over.openWos ?? []),
          count: jest.fn().mockResolvedValue(0),
        },
      });
      return { tx, machineUpdate, assetUpdate };
    };

    it("arhivira mašinu (archived_at + tracked=false) — NE briše je", async () => {
      const { tx, machineUpdate } = otpisTx({});
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.otpisMachine("sef@servoteh.com", "M-01", "rashodovana 2026");
      const data = machineUpdate.mock.calls[0][0].data;
      expect(data.archivedAt).toBeInstanceOf(Date);
      expect(data.tracked).toBe(false);
      // Nigde nema delete — istorija (kontrole/kvarovi/nalozi) ostaje netaknuta.
      expect(
        (tx.maintMachine as Record<string, unknown>).delete,
      ).toBeUndefined();
    });

    it("PROPAGIRA otpis na maint_assets (active=false + razlog + ko) → ispada iz aktivnih pickera", async () => {
      const { tx, assetUpdate } = otpisTx({});
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.otpisMachine(
        "sef@servoteh.com",
        "M-01",
        "  rashodovana 2026  ",
      );
      const call = assetUpdate.mock.calls[0][0];
      expect(call.where).toEqual({ assetId: ASSET });
      expect(call.data.active).toBe(false);
      expect(call.data.archivedAt).toBeInstanceOf(Date);
      // Razlog se trimuje, a `archived_by` nosi auth.uid() pozivaoca (RLS WITH CHECK).
      expect(call.data.archiveReason).toBe("rashodovana 2026");
      expect(call.data.archivedBy).toBe("u1");
    });

    it("obaveštava šefa proizvodnje i NAVODI zatečene otvorene naloge", async () => {
      const openWos = [
        { woNumber: "RN-12", title: "Zamena ležaja", status: "potvrden" },
        { woNumber: "RN-13", title: "Podmazivanje", status: "novi" },
      ];
      const { tx } = otpisTx({ openWos });
      const { sy15 } = makeSy15(tx);
      const notify = makeNotify();
      const svc = new OdrzavanjeService(
        sy15,
        storageStub,
        notify as unknown as MasinaOtpisNotifyService,
      );
      const res = (await svc.otpisMachine(
        "sef@servoteh.com",
        "M-01",
        "rashodovana",
      )) as { data: { openWorkOrders: number } };

      expect(notify.notifyOtpis).toHaveBeenCalledTimes(1);
      const arg = notify.notifyOtpis.mock.calls[0][0];
      expect(arg.machineCode).toBe("M-01");
      expect(arg.machineName).toBe("Presa 100t");
      expect(arg.reason).toBe("rashodovana");
      expect(arg.openWorkOrders).toHaveLength(2);
      expect(arg.openWorkOrders[0].woNumber).toBe("RN-12");
      // Broj otvorenih naloga se vraća i pozivaocu (FE ga prikazuje u potvrdi).
      expect(res.data.openWorkOrders).toBe(2);
    });

    it("čita SAMO otvorene naloge (zavrsen/otkazan se ne broje kao posao za preraspodelu)", async () => {
      const { tx } = otpisTx({});
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.otpisMachine("sef@servoteh.com", "M-01", "rashodovana");
      const where = (
        (tx.maintWorkOrder as { findMany: jest.Mock }).findMany.mock
          .calls[0][0] as { where: Record<string, unknown> }
      ).where;
      expect(where.assetId).toBe(ASSET);
      expect(where.status).toEqual({ notIn: ["zavrsen", "otkazan"] });
    });

    it("ponovljeni otpis već otpisane mašine NE šalje obaveštenje ponovo", async () => {
      const { tx } = otpisTx({ archivedAt: new Date("2026-07-01T10:00:00Z") });
      const { sy15 } = makeSy15(tx);
      const notify = makeNotify();
      const svc = new OdrzavanjeService(
        sy15,
        storageStub,
        notify as unknown as MasinaOtpisNotifyService,
      );
      const res = (await svc.otpisMachine(
        "sef@servoteh.com",
        "M-01",
        "rashodovana",
      )) as { data: { alreadyArchived: boolean } };
      expect(notify.notifyOtpis).not.toHaveBeenCalled();
      expect(res.data.alreadyArchived).toBe(true);
    });

    it("nepostojeća mašina → 404 (i bez obaveštenja)", async () => {
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintMachine: {
          findUnique: jest.fn().mockResolvedValue(null),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          count: jest.fn().mockResolvedValue(0),
        },
        maintAsset: { updateMany: jest.fn(), findUnique: jest.fn() },
      });
      const { sy15 } = makeSy15(tx);
      const notify = makeNotify();
      const svc = new OdrzavanjeService(
        sy15,
        storageStub,
        notify as unknown as MasinaOtpisNotifyService,
      );
      await expect(
        svc.otpisMachine("sef@servoteh.com", "NEMA", "rashodovana"),
      ).rejects.toThrow(NotFoundException);
      expect(notify.notifyOtpis).not.toHaveBeenCalled();
    });

    it("restoreMachine vraća u upotrebu i ČISTI ogledalo (active=true, razlog obrisan)", async () => {
      const assetUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintMachine: {
          findUnique: jest.fn().mockResolvedValue({ assetId: ASSET }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(1),
        },
        maintAsset: { updateMany: assetUpdate, findUnique: jest.fn() },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.restoreMachine("sef@servoteh.com", "M-01");
      const data = assetUpdate.mock.calls[0][0].data;
      expect(data.active).toBe(true);
      expect(data.archivedAt).toBeNull();
      expect(data.archiveReason).toBeNull();
    });

    /**
     * Zahtev 047/26 — otpisana mašina NE sme da drži šifru zauvek: `machine_code` je PK,
     * pa bi bez oslobađanja nova mašina sa istom oznakom padala na P2002.
     */
    const rpcCalls = (tx: Tx) =>
      ($queryRawOf(tx).mock.calls as { 0: { values?: unknown[] } }[])
        .map((c) => c[0]?.values ?? [])
        .filter((v) => v.length === 2);
    const $queryRawOf = (tx: Tx) => tx.$queryRaw as jest.Mock;

    it("otpis OSLOBAĐA šifru: PK se kroz RPC preimenuje u code#ARH-YYYYMMDD (047/26)", async () => {
      const { tx } = otpisTx({});
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      const res = (await svc.otpisMachine(
        "sef@servoteh.com",
        "M-01",
        "rashodovana",
      )) as { data: { machineCode: string } };
      const rename = rpcCalls(tx).find((v) => v[0] === "M-01");
      expect(rename).toBeDefined();
      expect(String(rename![1])).toMatch(/^M-01#ARH-\d{8}$/);
      // Nova šifra ide i pozivaocu — FE po njoj repointuje karton.
      expect(res.data.machineCode).toBe(rename![1]);
    });

    it("ponovljeni otpis već otpisane mašine NE preimenuje šifru drugi put", async () => {
      const { tx } = otpisTx({ archivedAt: new Date("2026-07-01T10:00:00Z") });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      const res = (await svc.otpisMachine(
        "sef@servoteh.com",
        "M-01",
        "rashodovana",
      )) as { data: { machineCode: string } };
      expect(rpcCalls(tx)).toHaveLength(0);
      expect(res.data.machineCode).toBe("M-01");
    });

    it("restore SKIDA #ARH- sufiks i vraća baznu šifru (kad je slobodna)", async () => {
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1", code: "M-01" }]),
        maintMachine: {
          findUnique: jest.fn().mockResolvedValue({ assetId: ASSET }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(1),
        },
        maintAsset: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn(),
        },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      const res = (await svc.restoreMachine(
        "sef@servoteh.com",
        "M-01#ARH-20260730",
      )) as { data: { machineCode: string } };
      expect(rpcCalls(tx)).toContainEqual(["M-01#ARH-20260730", "M-01"]);
      expect(res.data.machineCode).toBe("M-01");
    });

    it("restore kad je bazna šifra u međuvremenu ZAUZETA → 409 (bez rename-a)", async () => {
      // Prva slobodna je „M-01-2" → znači da „M-01" drži neko drugi.
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1", code: "M-01-2" }]),
        maintMachine: {
          findUnique: jest.fn().mockResolvedValue({ assetId: ASSET }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(1),
        },
        maintAsset: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn(),
        },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(
        svc.restoreMachine("sef@servoteh.com", "M-01#ARH-20260730"),
      ).rejects.toThrow(ConflictException);
      expect(rpcCalls(tx)).toHaveLength(0);
    });

    it("createMachine na zauzetu šifru → 409 sa jasnom porukom (nikad sirova P2002)", async () => {
      const insert = jest.fn();
      const mk = (archivedAt: Date | null) =>
        makeTx({
          $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
          $executeRaw: insert,
          maintMachine: {
            findUnique: jest.fn().mockResolvedValue({
              machineCode: "3.10",
              name: "Stara presa",
              archivedAt,
            }),
            count: jest.fn().mockResolvedValue(1),
          },
        });
      const dto = {
        clientEventId: "ev-1",
        machineCode: "3.10",
        name: "Nova presa",
      } as never;

      const aktivna = mk(null);
      const svcA = new OdrzavanjeService(
        makeSy15(aktivna).sy15,
        storageStub,
        notifyStub(),
      );
      await expect(svcA.createMachine("sef@servoteh.com", dto)).rejects.toThrow(
        /već postoji/,
      );

      const otpisana = mk(new Date("2026-07-30T10:00:00Z"));
      const svcB = new OdrzavanjeService(
        makeSy15(otpisana).sy15,
        storageStub,
        notifyStub(),
      );
      await expect(svcB.createMachine("sef@servoteh.com", dto)).rejects.toThrow(
        /otpisanoj mašini/,
      );
      // INSERT se NIKAD nije ni pokušao → nema P2002 iz baze.
      expect(insert).not.toHaveBeenCalled();
    });

    /**
     * Review PR #64 — otpis mora da arhivira sredstvo PRE nego što rename premesti
     * mašinu: popravljen `maint_machine_rename` (ZAHTEV_047_MASINA_RENAME_FIX.sql)
     * nosi `asset_id` u kopiju reda, pa razlog/„ko je otpisao" ostaju na sredstvu
     * koje mašina i dalje drži (a ne na osirotelom redu).
     */
    it("razlog otpisa se upisuje na sredstvo PRE rename-a (sredstvo prati mašinu)", async () => {
      const assetUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const { tx } = otpisTx({ assetUpdate });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.otpisMachine("sef@servoteh.com", "M-01", "rashodovana");
      const q = $queryRawOf(tx);
      const renameIdx = q.mock.calls.findIndex(
        (c) => ((c[0] as { values?: unknown[] })?.values ?? []).length === 2,
      );
      expect(renameIdx).toBeGreaterThanOrEqual(0);
      expect(assetUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        q.mock.invocationCallOrder[renameIdx],
      );
    });

    it("otpis kad je SVIH 50 kandidat-šifri zauzeto → 409, a ne rename na zauzetu šifru", async () => {
      const { tx } = otpisTx({ freeCode: null });
      const { sy15 } = makeSy15(tx);
      const notify = makeNotify();
      const svc = new OdrzavanjeService(
        sy15,
        storageStub,
        notify as unknown as MasinaOtpisNotifyService,
      );
      await expect(
        svc.otpisMachine("sef@servoteh.com", "M-01", "rashodovana"),
      ).rejects.toThrow(ConflictException);
      // Nema poziva RPC-a sa zauzetom šifrom (koji bi pao unutar transakcije),
      // i nema obaveštenja šefu za otpis koji se nije desio.
      expect(rpcCalls(tx)).toHaveLength(0);
      expect(notify.notifyOtpis).not.toHaveBeenCalled();
    });

    it("restore kad je SVIH 50 kandidat-šifri zauzeto → 409 (fallback ne vraća zauzetu baznu)", async () => {
      const tx = makeTx({
        $queryRaw: smartQueryRaw(null),
        maintMachine: {
          findUnique: jest.fn().mockResolvedValue({ assetId: ASSET }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          count: jest.fn().mockResolvedValue(1),
        },
        maintAsset: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn(),
        },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(
        svc.restoreMachine("sef@servoteh.com", "M-01#ARH-20260730"),
      ).rejects.toThrow(ConflictException);
      expect(rpcCalls(tx)).toHaveLength(0);
    });

    /**
     * `#ARH-` je rezervisan marker arhive: ručno unet u šifru, otpis bi ga skinuo
     * (`baseMachineCode`) i mašina se posle restore-a NE bi vratila pod svojom
     * oznakom. Zato se odbija na ulazu — i pri unosu i pri ručnom preimenovanju.
     */
    it("createMachine sa rezervisanim '#ARH-' u šifri → 422 (bez ijednog upita/upisa)", async () => {
      const insert = jest.fn();
      const findUnique = jest.fn();
      const tx = makeTx({
        $queryRaw: jest.fn(),
        $executeRaw: insert,
        maintMachine: { findUnique, count: jest.fn().mockResolvedValue(0) },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(
        svc.createMachine("sef@servoteh.com", {
          clientEventId: "ev-arh",
          machineCode: "PRESA#ARH-20250101",
          name: "Presa",
        } as never),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(insert).not.toHaveBeenCalled();
      expect(findUnique).not.toHaveBeenCalled();
    });

    it("renameMachine na šifru sa '#ARH-' → 422 (RPC se ne zove)", async () => {
      const q = jest.fn();
      const tx = makeTx({ $queryRaw: q });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(
        svc.renameMachine("sef@servoteh.com", "M-01", " m-01#arh-20260101 "),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(q).not.toHaveBeenCalled();
    });

    it("renameMachine na običnu šifru i dalje prolazi (guard ne lomi normalan tok)", async () => {
      const tx = makeTx({ $queryRaw: smartQueryRaw() });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.renameMachine("sef@servoteh.com", "M-01", "  M-02  ");
      // Trim se dešava pre RPC-a — u bazu ide čista šifra.
      expect(rpcCalls(tx)).toContainEqual(["M-01", "M-02"]);
    });

    it("createWorkOrder na OTPISANOM sredstvu → 422 (nalog se ne kreira)", async () => {
      const create = jest.fn();
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintAsset: {
          findUnique: jest.fn().mockResolvedValue({
            archivedAt: new Date("2026-07-01T10:00:00Z"),
            name: "Presa 100t",
          }),
          updateMany: jest.fn(),
        },
        maintWorkOrder: { create, count: jest.fn().mockResolvedValue(0) },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await expect(
        svc.createWorkOrder("sef@servoteh.com", {
          clientEventId: "3b241101-e2bb-4255-8caf-4136c566a963",
          assetId: ASSET,
          assetType: "machine",
          type: "korektivni",
          title: "Test",
          priority: "p3_manje",
        } as never),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(create).not.toHaveBeenCalled();
    });

    it("createWorkOrder na AKTIVNOM sredstvu i dalje prolazi (guard ne lomi normalan tok)", async () => {
      const create = jest.fn().mockResolvedValue({ woId: "w1" });
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintAsset: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ archivedAt: null, name: "Presa 100t" }),
          updateMany: jest.fn(),
        },
        maintWorkOrder: { create, count: jest.fn().mockResolvedValue(0) },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.createWorkOrder("sef@servoteh.com", {
        clientEventId: "3b241101-e2bb-4255-8caf-4136c566a963",
        assetId: ASSET,
        assetType: "machine",
        type: "korektivni",
        title: "Test",
        priority: "p3_manje",
      } as never);
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("createWorkOrder upisuje trošak ODMAH pri kreiranju (03.08.2026)", async () => {
      // Servis se evidentira unazad, sa računom u ruci. Bez ovoga je jedini put bio
      // „kreiraj → nađi u listi → otvori → upiši cenu" i cena se nije ni unosila.
      const create = jest.fn().mockResolvedValue({ woId: "w1" });
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintAsset: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ archivedAt: null, name: "Caddy Beli novi" }),
          updateMany: jest.fn(),
        },
        maintWorkOrder: { create, count: jest.fn().mockResolvedValue(0) },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.createWorkOrder("sef@servoteh.com", {
        clientEventId: "3b241101-e2bb-4255-8caf-4136c566a964",
        assetId: ASSET,
        assetType: "vehicle",
        type: "servis",
        title: "Mali servis",
        priority: "p4_planirano",
        costTotal: 42800,
        externalServicerName: "  Auto Čačak  ",
        odometerKmAtService: 148320,
      } as never);
      const data = create.mock.calls[0][0].data;
      expect(Number(data.costTotal)).toBe(42800);
      expect(data.externalServicerName).toBe("Auto Čačak"); // trim
      expect(data.odometerKmAtService).toBe(148320);
    });

    it("createWorkOrder bez troška ne upisuje nule (ostaje null, da izveštaj ne broji prazno)", async () => {
      const create = jest.fn().mockResolvedValue({ woId: "w1" });
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintAsset: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ archivedAt: null, name: "Presa 100t" }),
          updateMany: jest.fn(),
        },
        maintWorkOrder: { create, count: jest.fn().mockResolvedValue(0) },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.createWorkOrder("sef@servoteh.com", {
        clientEventId: "3b241101-e2bb-4255-8caf-4136c566a965",
        assetId: ASSET,
        assetType: "machine",
        type: "kvar",
        title: "Test",
        priority: "p3_manje",
      } as never);
      const data = create.mock.calls[0][0].data;
      expect(data.costTotal).toBeNull();
      expect(data.externalServicerName).toBeNull();
      expect(data.odometerKmAtService).toBeNull();
    });
  });

  // ------- IT oprema — polja po tipu uređaja (zahtevi 065/066/067, 04.08) -------

  describe("upsertItDetails (065/066/067 nova polja)", () => {
    const IT_ASSET = "b2222222-2222-4222-8222-222222222222";

    it("mapira snake_case details u Prisma kolone (uklj. novih 7) i NE propušta nepoznate ključeve", async () => {
      const upsert = jest.fn().mockResolvedValue({ assetId: IT_ASSET });
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintItAssetDetails: { upsert },
      });
      const { sy15, withUserRls } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.upsertItDetails("veljko@servoteh.com", IT_ASSET, {
        details: {
          device_type: "laptop",
          hostname: "SRV-LPT-042",
          // 065 računar
          cpu: "Intel i7-13700H",
          motherboard: "Lenovo LNVNB161216",
          ram: "32 GB DDR5",
          gpu: "RTX 4060 8GB",
          // 066 štampač / 067 switch
          office_location: "Kancelarija 12",
          toner_cartridges: "HP 415A (crna + 3 boje)",
          unifi_ports: "24 (PoE 16)",
          // nepoznat ključ — allowlist ga NE sme propustiti u upsert
          zlonamerni_kljuc: "x",
        },
      } as never);
      expect(withUserRls).toHaveBeenCalledTimes(1); // RLS put, ne db.*
      const arg = upsert.mock.calls[0][0];
      expect(arg.where).toEqual({ assetId: IT_ASSET });
      expect(arg.update.cpu).toBe("Intel i7-13700H");
      expect(arg.update.motherboard).toBe("Lenovo LNVNB161216");
      expect(arg.update.ram).toBe("32 GB DDR5");
      expect(arg.update.gpu).toBe("RTX 4060 8GB");
      expect(arg.update.officeLocation).toBe("Kancelarija 12");
      expect(arg.update.tonerCartridges).toBe("HP 415A (crna + 3 boje)");
      expect(arg.update.unifiPorts).toBe("24 (PoE 16)");
      expect(arg.create.cpu).toBe("Intel i7-13700H"); // create grana = isti allowlist
      expect("zlonamerni_kljuc" in arg.update).toBe(false);
      expect("zlonamerni_kljuc" in arg.create).toBe(false);
    });

    it("prazan string → NULL (brisanje vrednosti), izostavljen ključ → NULL (PUT je pun replace)", async () => {
      const upsert = jest.fn().mockResolvedValue({ assetId: IT_ASSET });
      const tx = makeTx({
        $queryRaw: jest.fn().mockResolvedValue([{ uid: "u1" }]),
        maintItAssetDetails: { upsert },
      });
      const { sy15 } = makeSy15(tx);
      const svc = new OdrzavanjeService(sy15, storageStub, notifyStub());
      await svc.upsertItDetails("veljko@servoteh.com", IT_ASSET, {
        details: { device_type: "printer", toner_cartridges: "" },
      } as never);
      const arg = upsert.mock.calls[0][0];
      expect(arg.update.tonerCartridges).toBeNull();
      expect(arg.update.unifiPorts).toBeNull();
      expect(arg.update.cpu).toBeNull();
    });
  });
});

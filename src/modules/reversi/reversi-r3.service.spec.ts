import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { ReversiService } from "./reversi.service";
import type { Sy15Service, Sy15Tx } from "../../common/sy15/sy15.service";
import type { LabelPrintService } from "../../common/printing/label-print.service";

/**
 * Unit — Reversi R3 paritet (PLAN_PARITET_reversi_2026-07-17.md, Drop R3).
 * Fokus (BE deo 21 stavke):
 *   - RB-04: findOneTool obogaćen — klasifikacija (group/subgroup/subsubgroup),
 *     trenutna lokacija (currentLocationCode) i otvoreno zaduženje (issuedHolder),
 *   - RB-10: toolDocuments — linije alata + resolve dokumenta,
 *   - RB-07/09: baterije/servis CRUD (create kroz withUser=auth.uid; P2025→404 na PATCH/DELETE),
 *   - RB-52/53: reportMachines obogaćen (cuttingToolSkus/Qty + headsCount),
 *   - RB-57/58: glave CRUD + machineDocuments (limit clamp).
 * Bez sy15 baze — tx/db su mokovani.
 */
/** Prvi argument prvog poziva sa `data` payload-om — typed, bez no-unsafe-* na mock.calls. */
function callData(mock: jest.Mock): { data: Record<string, unknown> } {
  return (mock.mock.calls[0] as unknown[])[0] as {
    data: Record<string, unknown>;
  };
}
/** Prvi argument prvog poziva kao proizvoljan zapis (Prisma findMany args). */
function callArg(mock: jest.Mock): Record<string, unknown> {
  return (mock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
}

describe("ReversiService — R3 paritet", () => {
  const EMAIL = "test@servoteh.com";
  const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";
  const P2025 = new Prisma.PrismaClientKnownRequestError("missing", {
    code: "P2025",
    clientVersion: "6.19.3",
  });

  let tx: {
    revToolBattery: { create: jest.Mock };
    revToolServiceLog: { create: jest.Mock };
    revMachineHead: { create: jest.Mock };
  };
  let sy15: {
    withUser: jest.Mock;
    db: {
      revTool: { findUnique: jest.Mock };
      revToolBattery: {
        findMany: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
      revToolServiceLog: {
        findMany: jest.Mock;
        update: jest.Mock;
        delete: jest.Mock;
      };
      revInventoryGroup: { findUnique: jest.Mock };
      revInventorySubgroup: { findUnique: jest.Mock };
      revInventorySubsubgroup: { findUnique: jest.Mock };
      locItemPlacement: { findFirst: jest.Mock };
      locLocation: { findUnique: jest.Mock };
      revDocument: { findFirst: jest.Mock; findMany: jest.Mock };
      revDocumentLine: { findMany: jest.Mock };
      revMachineHead: { update: jest.Mock; delete: jest.Mock };
      $queryRaw: jest.Mock;
    };
  };
  let service: ReversiService;

  beforeEach(() => {
    tx = {
      revToolBattery: { create: jest.fn() },
      revToolServiceLog: { create: jest.fn() },
      revMachineHead: { create: jest.fn() },
    };
    sy15 = {
      withUser: jest.fn((_email: string, fn: (t: Sy15Tx) => Promise<unknown>) =>
        fn(tx as unknown as Sy15Tx),
      ),
      db: {
        revTool: { findUnique: jest.fn() },
        revToolBattery: {
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn(),
          delete: jest.fn(),
        },
        revToolServiceLog: {
          findMany: jest.fn().mockResolvedValue([]),
          update: jest.fn(),
          delete: jest.fn(),
        },
        revInventoryGroup: { findUnique: jest.fn() },
        revInventorySubgroup: { findUnique: jest.fn() },
        revInventorySubsubgroup: { findUnique: jest.fn() },
        locItemPlacement: { findFirst: jest.fn() },
        locLocation: { findUnique: jest.fn() },
        revDocument: { findFirst: jest.fn(), findMany: jest.fn() },
        revDocumentLine: { findMany: jest.fn() },
        revMachineHead: { update: jest.fn(), delete: jest.fn() },
        $queryRaw: jest.fn(),
      },
    };
    service = new ReversiService(
      sy15 as unknown as Sy15Service,
      {} as unknown as LabelPrintService,
    );
  });

  // ---------- RB-04: findOneTool obogaćen ----------

  describe("findOneTool (RB-04)", () => {
    it("razrešava klasifikaciju, trenutnu lokaciju i otvoreno zaduženje", async () => {
      sy15.db.revTool.findUnique.mockResolvedValue({
        id: UUID,
        oznaka: "ALAT-1",
        naziv: "Bušilica",
        subgroupId: "sg1",
        subsubgroupId: "ss1",
        locItemRefId: "ref1",
        garancijaDo: "2027-01-01",
        nabavnaVrednost: "12000",
        status: "active",
      });
      sy15.db.revInventorySubgroup.findUnique.mockResolvedValue({
        id: "sg1",
        code: "AKU",
        label: "Akumulatorski",
        groupId: "g1",
      });
      sy15.db.revInventorySubsubgroup.findUnique.mockResolvedValue({
        id: "ss1",
        code: "BUS",
        label: "Bušilice",
      });
      sy15.db.revInventoryGroup.findUnique.mockResolvedValue({
        code: "HAND",
        label: "Ručni alat",
      });
      sy15.db.locItemPlacement.findFirst.mockResolvedValue({
        locationId: "loc1",
      });
      sy15.db.locLocation.findUnique.mockResolvedValue({
        locationCode: "ALAT-MAG-01",
      });
      sy15.db.revDocumentLine.findMany.mockResolvedValue([
        { documentId: "d1" },
      ]);
      sy15.db.revDocument.findFirst.mockResolvedValue({
        docNumber: "REV-2026-0001",
        recipientType: "EMPLOYEE",
        recipientEmployeeName: "Pera Perić",
        recipientDepartment: null,
        recipientCompanyName: null,
      });

      const res = await service.findOneTool(UUID);

      expect(res.data.group).toEqual({ code: "HAND", label: "Ručni alat" });
      expect(res.data.subgroup).toEqual({
        id: "sg1",
        code: "AKU",
        label: "Akumulatorski",
      });
      expect(res.data.subsubgroup).toEqual({
        id: "ss1",
        code: "BUS",
        label: "Bušilice",
      });
      expect(res.data.currentLocationCode).toBe("ALAT-MAG-01");
      expect(res.data.issuedHolder).toEqual({
        docNumber: "REV-2026-0001",
        recipientType: "EMPLOYEE",
        recipientEmployeeName: "Pera Perić",
        recipientDepartment: null,
        recipientCompanyName: null,
      });
      // master polja + garancija (RB-05) prolaze u payload-u (FE računa badž).
      expect(res.data.garancijaDo).toBe("2027-01-01");
      expect(res.data.batteries).toEqual([]);
      expect(res.data.services).toEqual([]);
    });

    it("nesvrstan alat bez placementa/zaduženja → null klase/lokacija/holder", async () => {
      sy15.db.revTool.findUnique.mockResolvedValue({
        id: UUID,
        oznaka: "ALAT-2",
        naziv: "Čekić",
        subgroupId: null,
        subsubgroupId: null,
        locItemRefId: null,
        status: "active",
      });
      sy15.db.revDocumentLine.findMany.mockResolvedValue([]);

      const res = await service.findOneTool(UUID);

      expect(res.data.group).toBeNull();
      expect(res.data.subgroup).toBeNull();
      expect(res.data.subsubgroup).toBeNull();
      expect(res.data.currentLocationCode).toBeNull();
      expect(res.data.issuedHolder).toBeNull();
      // Bez locItemRefId — nema placement lookupa.
      expect(sy15.db.locItemPlacement.findFirst).not.toHaveBeenCalled();
      expect(sy15.db.revDocument.findFirst).not.toHaveBeenCalled();
    });

    it("ISSUED linija ali dokument nije OPEN/PARTIALLY → issuedHolder null", async () => {
      sy15.db.revTool.findUnique.mockResolvedValue({
        id: UUID,
        oznaka: "ALAT-3",
        naziv: "Ključ",
        subgroupId: null,
        subsubgroupId: null,
        locItemRefId: null,
        status: "active",
      });
      sy15.db.revDocumentLine.findMany.mockResolvedValue([
        { documentId: "d9" },
      ]);
      // findFirst sa status IN (OPEN,PARTIALLY) ne nalazi red (dokument RETURNED).
      sy15.db.revDocument.findFirst.mockResolvedValue(null);

      const res = await service.findOneTool(UUID);
      expect(res.data.issuedHolder).toBeNull();
      expect(sy15.db.revDocument.findFirst).toHaveBeenCalled();
    });

    it("nepostojeći alat → 404", async () => {
      sy15.db.revTool.findUnique.mockResolvedValue(null);
      await expect(service.findOneTool(UUID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ---------- RB-10: toolDocuments ----------

  describe("toolDocuments (RB-10)", () => {
    it("linije alata + resolve dokumenta po id-u", async () => {
      sy15.db.revDocumentLine.findMany.mockResolvedValue([
        { id: "l1", documentId: "d1", lineStatus: "RETURNED" },
        { id: "l2", documentId: "d1", lineStatus: "ISSUED" },
      ]);
      sy15.db.revDocument.findMany.mockResolvedValue([
        {
          id: "d1",
          docNumber: "REV-1",
          issuedAt: "2026-07-01",
          returnConfirmedAt: null,
        },
      ]);

      const res = await service.toolDocuments(UUID);
      expect(res.data).toHaveLength(2);
      expect(res.data[0].document).toMatchObject({ docNumber: "REV-1" });
      expect(res.data[1].document).toMatchObject({ docNumber: "REV-1" });
      // Jedan distinct doc id → jedan findMany where in.
      expect(sy15.db.revDocument.findMany).toHaveBeenCalledTimes(1);
    });

    it("alat bez zaduženja → prazna lista, bez doc lookupa", async () => {
      sy15.db.revDocumentLine.findMany.mockResolvedValue([]);
      const res = await service.toolDocuments(UUID);
      expect(res.data).toEqual([]);
      expect(sy15.db.revDocument.findMany).not.toHaveBeenCalled();
    });
  });

  // ---------- RB-07: baterije CRUD ----------

  describe("baterije CRUD (RB-07)", () => {
    it("addToolBattery — withUser create sa mapiranim poljima + status", async () => {
      tx.revToolBattery.create.mockResolvedValue({ id: "b1" });
      const res = await service.addToolBattery(EMAIL, UUID, {
        serijskiBroj: " 527100599 ",
        kapacitet: "5.0Ah",
        datumNabavke: "2026-01-15",
        status: "active",
        napomena: null,
      });
      expect(res.data).toEqual({ id: "b1" });
      expect(sy15.withUser).toHaveBeenCalled();
      const arg = callData(tx.revToolBattery.create);
      expect(arg.data.toolId).toBe(UUID);
      expect(arg.data.serijskiBroj).toBe("527100599");
      expect(arg.data.status).toBe("active");
      expect(arg.data.datumNabavke).toBeInstanceOf(Date);
    });

    it("addToolBattery bez statusa → DB default (status izostavljen iz data)", async () => {
      tx.revToolBattery.create.mockResolvedValue({ id: "b2" });
      await service.addToolBattery(EMAIL, UUID, {});
      const arg = callData(tx.revToolBattery.create);
      expect(arg.data).not.toHaveProperty("status");
      expect(arg.data.serijskiBroj).toBeNull();
    });

    it("updateToolBattery — P2025 → 404", async () => {
      sy15.db.revToolBattery.update.mockRejectedValue(P2025);
      await expect(
        service.updateToolBattery(UUID, { status: "scrapped" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("updateToolBattery — parcijalni patch (samo prosleđena polja)", async () => {
      sy15.db.revToolBattery.update.mockResolvedValue({ id: "b1" });
      await service.updateToolBattery(UUID, { status: "lost" });
      expect(sy15.db.revToolBattery.update).toHaveBeenCalledWith({
        where: { id: UUID },
        data: { status: "lost" },
      });
    });

    it("deleteToolBattery — uspeh → {id}; P2025 → 404", async () => {
      sy15.db.revToolBattery.delete.mockResolvedValue({ id: UUID });
      expect(await service.deleteToolBattery(UUID)).toEqual({
        data: { id: UUID },
      });
      sy15.db.revToolBattery.delete.mockRejectedValue(P2025);
      await expect(service.deleteToolBattery(UUID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ---------- RB-09: servis CRUD ----------

  describe("servis CRUD (RB-09)", () => {
    it("addToolService — datum/tip/status izostavljeni → DB default", async () => {
      tx.revToolServiceLog.create.mockResolvedValue({ id: "s1" });
      await service.addToolService(EMAIL, UUID, {
        opis: "zamena",
        trosak: 3000,
      });
      const arg = callData(tx.revToolServiceLog.create);
      expect(arg.data.toolId).toBe(UUID);
      expect(arg.data).not.toHaveProperty("datum");
      expect(arg.data).not.toHaveProperty("tip");
      expect(arg.data).not.toHaveProperty("status");
      expect(arg.data.trosak).toBe(3000);
    });

    it("addToolService — sa datum/tip/status → mapirano", async () => {
      tx.revToolServiceLog.create.mockResolvedValue({ id: "s2" });
      await service.addToolService(EMAIL, UUID, {
        datum: "2026-07-10",
        tip: "popravka",
        status: "zavrsen",
      });
      const arg = callData(tx.revToolServiceLog.create);
      expect(arg.data.datum).toBeInstanceOf(Date);
      expect(arg.data.tip).toBe("popravka");
      expect(arg.data.status).toBe("zavrsen");
    });

    it("updateToolService — P2025 → 404", async () => {
      sy15.db.revToolServiceLog.update.mockRejectedValue(P2025);
      await expect(
        service.updateToolService(UUID, { status: "otkazan" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("deleteToolService — P2025 → 404", async () => {
      sy15.db.revToolServiceLog.delete.mockRejectedValue(P2025);
      await expect(service.deleteToolService(UUID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ---------- RB-52/53: reportMachines obogaćen ----------

  describe("reportMachines (RB-52/53)", () => {
    it("dodaje cuttingToolSkus/Qty (v_rev_cts_by_machine) + headsCount", async () => {
      sy15.db.$queryRaw
        .mockResolvedValueOnce([
          { machine_code: "M12", name: "Glodalica", archived_at: null },
          { machine_code: "M99", name: "Strug", archived_at: "2026-01-01" },
        ])
        .mockResolvedValueOnce([{ machine_code: "M12", skus: 3, qty: 27 }])
        .mockResolvedValueOnce([{ machine_code: "M12", n: 2 }]);

      const res = await service.reportMachines();
      expect(sy15.db.$queryRaw).toHaveBeenCalledTimes(3);
      const m12 = (res.data as Record<string, unknown>[]).find(
        (m) => m.machine_code === "M12",
      )!;
      expect(m12.cuttingToolSkus).toBe(3);
      expect(m12.cuttingToolQty).toBe(27);
      expect(m12.headsCount).toBe(2);
      // Arhivirana ostaje u payload-u (RB-52 „Samo aktivne" FE filtrira; archived_at nosi).
      const m99 = (res.data as Record<string, unknown>[]).find(
        (m) => m.machine_code === "M99",
      )!;
      expect(m99.archived_at).toBe("2026-01-01");
      expect(m99.cuttingToolSkus).toBe(0);
      expect(m99.headsCount).toBe(0);
    });

    it("prazan katalog mašina → prazna lista bez agregata", async () => {
      sy15.db.$queryRaw.mockResolvedValueOnce([]);
      const res = await service.reportMachines();
      expect(res.data).toEqual([]);
      expect(sy15.db.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- RB-58: machineDocuments ----------

  describe("machineDocuments (RB-58)", () => {
    it("filtrira po recipientMachineCode, clamp limit ≤200", async () => {
      sy15.db.revDocument.findMany.mockResolvedValue([{ id: "d1" }]);
      await service.machineDocuments("M12", "999");
      const arg = callArg(sy15.db.revDocument.findMany);
      expect(arg.where).toEqual({ recipientMachineCode: "M12" });
      expect(arg.take).toBe(200);
      expect(arg.orderBy).toEqual({ issuedAt: "desc" });
    });

    it("default limit 50 kad nije zadat", async () => {
      sy15.db.revDocument.findMany.mockResolvedValue([]);
      await service.machineDocuments("M12");
      expect(callArg(sy15.db.revDocument.findMany).take).toBe(50);
    });
  });

  // ---------- RB-57: glave CRUD ----------

  describe("glave CRUD (RB-57)", () => {
    it("addMachineHead — withUser create sa machineCode + trim", async () => {
      tx.revMachineHead.create.mockResolvedValue({ id: "h1" });
      const res = await service.addMachineHead(EMAIL, "M12", {
        oznaka: " GL-1 ",
        naziv: " Ugaona ",
        status: "ACTIVE",
      });
      expect(res.data).toEqual({ id: "h1" });
      const arg = callData(tx.revMachineHead.create);
      expect(arg.data.machineCode).toBe("M12");
      expect(arg.data.oznaka).toBe("GL-1");
      expect(arg.data.naziv).toBe("Ugaona");
      expect(arg.data.status).toBe("ACTIVE");
    });

    it("updateMachineHead — postavlja updatedAt + P2025 → 404", async () => {
      sy15.db.revMachineHead.update.mockResolvedValue({ id: "h1" });
      await service.updateMachineHead(UUID, { status: "SERVIS" });
      const arg = callData(sy15.db.revMachineHead.update);
      expect(arg.data.status).toBe("SERVIS");
      expect(arg.data.updatedAt).toBeInstanceOf(Date);

      sy15.db.revMachineHead.update.mockRejectedValue(P2025);
      await expect(
        service.updateMachineHead(UUID, { naziv: "X" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("deleteMachineHead — P2025 → 404", async () => {
      sy15.db.revMachineHead.delete.mockRejectedValue(P2025);
      await expect(service.deleteMachineHead(UUID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

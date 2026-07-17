import { NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { ReversiService } from "./reversi.service";
import type { Sy15Service, Sy15Tx } from "../../common/sy15/sy15.service";

/**
 * Unit — Reversi R0 paritet (PLAN_PARITET_reversi_2026-07-17.md, Drop R0).
 * Fokus:
 *   - RC-06: katalog reznog vraća RAZDVOJENO stanje (inWarehouseQty / onMachinesQty / onHandQty),
 *   - open-lines: `v_rev_my_issued_cutting_tools` kroz withUser (GUC scope) → camelCase + FIFO,
 *   - PR-01: updateCuttingTool na nepostojeći id → 404 (P2025 mapping),
 *   - PR-02: signature-pdf sa objektom koji fali u bucketu → čist 404 (ne 422).
 * Bez sy15 baze — tx/db/fetch su mokovani.
 */
describe("ReversiService — R0 paritet", () => {
  const EMAIL = "test@servoteh.com";
  const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

  let tx: { $queryRaw: jest.Mock };
  let sy15: {
    withUser: jest.Mock;
    db: {
      revCuttingToolCatalog: { findMany: jest.Mock; update: jest.Mock };
      revDocument: { findUnique: jest.Mock };
      $queryRaw: jest.Mock;
    };
  };
  let service: ReversiService;

  beforeEach(() => {
    tx = { $queryRaw: jest.fn() };
    sy15 = {
      withUser: jest.fn((_email: string, fn: (t: Sy15Tx) => Promise<unknown>) =>
        fn(tx as unknown as Sy15Tx),
      ),
      db: {
        revCuttingToolCatalog: { findMany: jest.fn(), update: jest.fn() },
        revDocument: { findUnique: jest.fn() },
        $queryRaw: jest.fn(),
      },
    };
    service = new ReversiService(sy15 as unknown as Sy15Service);
  });

  // ---------- RC-06: stock split ----------

  describe("listCuttingTools — razdvojeno stanje (RC-06)", () => {
    it("vraća inWarehouseQty (samo WAREHOUSE) + onMachinesQty (view) + onHandQty=zbir", async () => {
      sy15.db.revCuttingToolCatalog.findMany.mockResolvedValue([
        { id: "c1", oznaka: "RZN-1", naziv: "Glodalo" },
        { id: "c2", oznaka: "RZN-2", naziv: "Burgija" },
      ]);
      // 1. poziv = magacin (WAREHOUSE), 2. poziv = mašine (v_rev_cts_machine_stock)
      sy15.db.$queryRaw
        .mockResolvedValueOnce([{ catalog_id: "c1", qty: 5 }])
        .mockResolvedValueOnce([{ catalog_id: "c1", qty: 3 }]);

      const res = await service.listCuttingTools();

      expect(sy15.db.$queryRaw).toHaveBeenCalledTimes(2);
      const c1 = res.data.find((d) => d.id === "c1")!;
      expect(c1.inWarehouseQty).toBe(5);
      expect(c1.onMachinesQty).toBe(3);
      expect(c1.onHandQty).toBe(8);
      // c2 nema stanje ni u magacinu ni na mašinama → 0/0/0 (nije „tiho pun").
      const c2 = res.data.find((d) => d.id === "c2")!;
      expect(c2.inWarehouseQty).toBe(0);
      expect(c2.onMachinesQty).toBe(0);
      expect(c2.onHandQty).toBe(0);
    });

    it("magacin prazan a alat izdat po mašinama → inWarehouseQty=0 (semafor okida)", async () => {
      sy15.db.revCuttingToolCatalog.findMany.mockResolvedValue([
        { id: "c1", oznaka: "RZN-1", naziv: "Glodalo", minStockQty: 4 },
      ]);
      sy15.db.$queryRaw
        .mockResolvedValueOnce([]) // magacin prazan
        .mockResolvedValueOnce([{ catalog_id: "c1", qty: 10 }]); // sve na mašinama

      const res = await service.listCuttingTools();
      const c1 = res.data[0];
      expect(c1.inWarehouseQty).toBe(0);
      expect(c1.onMachinesQty).toBe(10);
      expect(c1.onHandQty).toBe(10);
    });

    it("prazan katalog → prazna lista bez agregacionih upita", async () => {
      sy15.db.revCuttingToolCatalog.findMany.mockResolvedValue([]);
      const res = await service.listCuttingTools("nema");
      expect(res.data).toEqual([]);
      expect(sy15.db.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ---------- open-lines za povraćaj ----------

  describe("cuttingOpenLines — otvorene linije za povraćaj", () => {
    it("mapira view redove u camelCase i ide kroz withUser (GUC scope)", async () => {
      tx.$queryRaw.mockResolvedValue([
        {
          line_id: "l1",
          document_id: "d1",
          doc_number: "REV-TOOL-2026-0001",
          catalog_id: "c1",
          barcode: "RZN-000123",
          oznaka: "RZN-1",
          naziv: "Glodalo",
          quantity: 5,
          returned_quantity: 2,
          remaining_quantity: 3,
          unit: "kom",
          recipient_machine_code: "M-07",
          issued_at: new Date("2026-07-01T08:00:00Z"),
          expected_return_date: null,
          line_status: "ISSUED",
          document_status: "PARTIALLY_RETURNED",
        },
      ]);

      const res = await service.cuttingOpenLines(EMAIL, "*RZN-000123*");

      expect(sy15.withUser).toHaveBeenCalledWith(EMAIL, expect.any(Function));
      expect(res.data).toEqual([
        {
          lineId: "l1",
          documentId: "d1",
          docNumber: "REV-TOOL-2026-0001",
          catalogId: "c1",
          barcode: "RZN-000123",
          oznaka: "RZN-1",
          naziv: "Glodalo",
          issuedQty: 5,
          returnedQty: 2,
          remainingQty: 3,
          unit: "kom",
          machineCode: "M-07",
          issuedAt: new Date("2026-07-01T08:00:00Z"),
          expectedReturnDate: null,
          lineStatus: "ISSUED",
          documentStatus: "PARTIALLY_RETURNED",
        },
      ]);
    });

    it("bez barkoda → i dalje kroz withUser (sve otvorene linije korisnika)", async () => {
      tx.$queryRaw.mockResolvedValue([]);
      const res = await service.cuttingOpenLines(EMAIL);
      expect(sy15.withUser).toHaveBeenCalledTimes(1);
      expect(res.data).toEqual([]);
    });
  });

  // ---------- PR-01: updateCuttingTool 404 ----------

  describe("updateCuttingTool", () => {
    it("uspešna izmena → { data }", async () => {
      sy15.db.revCuttingToolCatalog.update.mockResolvedValue({
        id: UUID,
        naziv: "Novo",
      });
      const res = await service.updateCuttingTool(EMAIL, UUID, {
        naziv: " Novo ",
      });
      expect(res.data).toEqual({ id: UUID, naziv: "Novo" });
      expect(sy15.db.revCuttingToolCatalog.update).toHaveBeenCalledWith({
        where: { id: UUID },
        data: { naziv: "Novo" },
      });
    });

    it("PR-01: P2025 (nepostojeći id) → 404 (ne 500)", async () => {
      sy15.db.revCuttingToolCatalog.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("missing", {
          code: "P2025",
          clientVersion: "6.19.3",
        }),
      );
      await expect(
        service.updateCuttingTool(EMAIL, UUID, { naziv: "X" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---------- PR-02: signature-pdf graceful 404 ----------

  describe("getSignaturePdfUrl (PR-02)", () => {
    const OLD_ENV = { ...process.env };
    beforeEach(() => {
      process.env.SY15_STORAGE_URL = "http://storage.local/storage/v1";
      process.env.SY15_SERVICE_KEY = "svc-key";
    });
    afterEach(() => {
      process.env = { ...OLD_ENV };
      jest.restoreAllMocks();
    });

    it("objekat fali u bucketu (storage 404) → čist 404, ne 422", async () => {
      sy15.db.revDocument.findUnique.mockResolvedValue({
        id: UUID,
        docNumber: "REV-TOOL-2026-0004",
        pdfStoragePath: "REV-TOOL-2026-0004.pdf",
      });
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => '{"error":"not_found","message":"Object not found"}',
      } as unknown as Response);

      await expect(service.getSignaturePdfUrl(UUID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("storage 400 „Object not found\" → 404", async () => {
      sy15.db.revDocument.findUnique.mockResolvedValue({
        id: UUID,
        docNumber: "REV-TOOL-2026-0004",
        pdfStoragePath: "REV-TOOL-2026-0004.pdf",
      });
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "Object not found",
      } as unknown as Response);

      await expect(service.getSignaturePdfUrl(UUID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("prava greška skladišta (500) → ostaje 422", async () => {
      sy15.db.revDocument.findUnique.mockResolvedValue({
        id: UUID,
        docNumber: "REV-TOOL-2026-0004",
        pdfStoragePath: "REV-TOOL-2026-0004.pdf",
      });
      jest.spyOn(global, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "internal",
      } as unknown as Response);

      await expect(service.getSignaturePdfUrl(UUID)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("dokument bez pdf_storage_path → 404", async () => {
      sy15.db.revDocument.findUnique.mockResolvedValue({
        id: UUID,
        docNumber: "REV-TOOL-2026-0004",
        pdfStoragePath: null,
      });
      await expect(service.getSignaturePdfUrl(UUID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

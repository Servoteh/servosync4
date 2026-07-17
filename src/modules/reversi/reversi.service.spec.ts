import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { ReversiService } from "./reversi.service";
import type { Sy15Service, Sy15Tx } from "../../common/sy15/sy15.service";
import type { LabelPrintService } from "../../common/printing/label-print.service";

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

  let tx: {
    $queryRaw: jest.Mock;
    $queryRawUnsafe: jest.Mock;
    revTool: { create: jest.Mock };
  };
  let sy15: {
    withUser: jest.Mock;
    runIdempotent: jest.Mock;
    db: {
      revCuttingToolCatalog: { findMany: jest.Mock; update: jest.Mock };
      revDocument: {
        findUnique: jest.Mock;
        findMany: jest.Mock;
        count: jest.Mock;
      };
      revDocumentLine: { groupBy: jest.Mock; findMany: jest.Mock };
      revTool: { create: jest.Mock; update: jest.Mock; findFirst: jest.Mock };
      revInventorySubgroup: { findUnique: jest.Mock; delete: jest.Mock };
      revInventorySubsubgroup: { findUnique: jest.Mock; delete: jest.Mock };
      $queryRaw: jest.Mock;
    };
  };
  let labelPrint: { printRawTspl: jest.Mock };
  let service: ReversiService;

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(),
      $queryRawUnsafe: jest.fn(),
      revTool: { create: jest.fn() },
    };
    sy15 = {
      withUser: jest.fn((_email: string, fn: (t: Sy15Tx) => Promise<unknown>) =>
        fn(tx as unknown as Sy15Tx),
      ),
      // runIdempotent izvrši akciju odmah (svež ključ) i vrati njen rezultat.
      runIdempotent: jest.fn(
        async (
          _email: string,
          _cid: string,
          _action: string,
          fn: (t: Sy15Tx) => Promise<unknown>,
        ) => ({ idempotent: false, result: await fn(tx as unknown as Sy15Tx) }),
      ),
      db: {
        revCuttingToolCatalog: { findMany: jest.fn(), update: jest.fn() },
        revDocument: {
          findUnique: jest.fn(),
          findMany: jest.fn(),
          count: jest.fn(),
        },
        revDocumentLine: { groupBy: jest.fn(), findMany: jest.fn() },
        revTool: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
        revInventorySubgroup: { findUnique: jest.fn(), delete: jest.fn() },
        revInventorySubsubgroup: { findUnique: jest.fn(), delete: jest.fn() },
        $queryRaw: jest.fn(),
      },
    };
    labelPrint = { printRawTspl: jest.fn() };
    service = new ReversiService(
      sy15 as unknown as Sy15Service,
      labelPrint as unknown as LabelPrintService,
    );
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

    it('storage 400 „Object not found" → 404', async () => {
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

  // ---------- R1: izmena artikla (RB-11) ----------

  describe("updateTool (RB-11)", () => {
    it("gradi PATCH samo iz prosleđenih polja; null briše klasifikaciju", async () => {
      sy15.db.revTool.update.mockResolvedValue({ id: UUID, naziv: "Bušilica" });
      await service.updateTool(UUID, {
        naziv: " Bušilica ",
        subgroupId: null,
        datumKupovine: "2026-01-15",
      });
      expect(sy15.db.revTool.update).toHaveBeenCalledWith({
        where: { id: UUID },
        data: {
          naziv: "Bušilica",
          subgroupId: null,
          datumKupovine: new Date("2026-01-15"),
        },
      });
    });

    it("P2025 (nepostojeći id) → 404", async () => {
      sy15.db.revTool.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("missing", {
          code: "P2025",
          clientVersion: "6.19.3",
        }),
      );
      await expect(
        service.updateTool(UUID, { naziv: "X" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---------- R1: nova jedinica (RB-46) ----------

  describe("createTool (RB-46 · R1-ADV-02/03 · R1-BE-IDEMP-01)", () => {
    it("ne-količinska jedinica → default početni smeštaj u ALAT-MAG-01 (paritet 1.0)", async () => {
      tx.revTool.create.mockResolvedValue({
        id: UUID,
        oznaka: "ALAT-1",
        naziv: "Ključ",
        barcode: "ALAT-000123",
        locItemRefId: "ref-1",
      });
      // (1) lookup ALAT-MAG-01, (2) loc_create_movement.
      tx.$queryRaw.mockResolvedValue([{ id: "mag-1" }]);
      tx.$queryRawUnsafe.mockResolvedValue([{ result: { ok: true } }]);

      const res = await service.createTool(EMAIL, {
        oznaka: "ALAT-1",
        naziv: "Ključ",
      });

      // Ceo tok ide kroz runIdempotent (idempotentan create — R1-BE-IDEMP-01).
      expect(sy15.runIdempotent).toHaveBeenCalledWith(
        EMAIL,
        expect.any(String),
        "reversi.create-tool",
        expect.any(Function),
      );
      // total_qty=1 za ne-količinsku; INSERT ide kroz tx (unutar idempotentne tx).
      expect(tx.revTool.create.mock.calls[0][0].data.totalQty).toBe(1);
      const call = tx.$queryRawUnsafe.mock.calls[0] as [string, string];
      expect(call[0]).toContain("loc_create_movement($1::jsonb)");
      const payload = JSON.parse(call[1]) as {
        movement_type: string;
        item_ref_id: string;
        to_location_id: string;
      };
      expect(payload.movement_type).toBe("INITIAL_PLACEMENT");
      expect(payload.item_ref_id).toBe("ref-1");
      expect(payload.to_location_id).toBe("mag-1");
      expect(res.data.barcode).toBe("ALAT-000123");
      expect(res.data.placement).toEqual({ ok: true });
    });

    it("ALAT-MAG-01 ne postoji → jedinica kreirana, placement=null (paritet 1.0 bez smeštaja)", async () => {
      tx.revTool.create.mockResolvedValue({
        id: UUID,
        oznaka: "ALAT-1",
        naziv: "Ključ",
        barcode: "ALAT-000123",
        locItemRefId: "ref-1",
      });
      tx.$queryRaw.mockResolvedValue([]); // magacin nije nađen

      const res = await service.createTool(EMAIL, {
        oznaka: "ALAT-1",
        naziv: "Ključ",
      });
      expect(res.data.placement).toBeNull();
      expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it("neuspeo početni smeštaj (ok≠true) → 422 (ne prolazi kao uspeh — R1-BE-IDEMP-01)", async () => {
      tx.revTool.create.mockResolvedValue({
        id: UUID,
        oznaka: "ALAT-1",
        naziv: "Ključ",
        barcode: "ALAT-000123",
        locItemRefId: "ref-1",
      });
      tx.$queryRawUnsafe.mockResolvedValue([
        { result: { ok: false, error: "already_placed" } },
      ]);
      await expect(
        service.createTool(EMAIL, {
          oznaka: "ALAT-1",
          naziv: "Ključ",
          initialPlacementLocationId: UUID,
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("količinska stavka → total_qty=0 + RECEIPT Početno stanje u ledger (RA-20 / R1-ADV-03)", async () => {
      tx.revTool.create.mockResolvedValue({
        id: UUID,
        oznaka: "POTR-1",
        naziv: "Burgija",
        barcode: "ALAT-000200",
        locItemRefId: "ref-2",
      });
      tx.$queryRaw.mockResolvedValue([{ result: 5 }]);

      const res = await service.createTool(EMAIL, {
        oznaka: "POTR-1",
        naziv: "Burgija",
        isQuantity: true,
        totalQty: 5,
      });

      // Jedinica se kreira sa total_qty=0 (zaliha se knjiži kroz ledger).
      expect(tx.revTool.create.mock.calls[0][0].data.totalQty).toBe(0);
      // RECEIPT delta = 5 kroz rev_hand_tool_apply_delta.
      const rcpt = tx.$queryRaw.mock.calls.find((c: unknown[]) =>
        (c[0] as string[]).join(" ").includes("rev_hand_tool_apply_delta"),
      ) as [string[], string, number] | undefined;
      expect(rcpt).toBeTruthy();
      expect(rcpt![1]).toBe(UUID);
      expect(rcpt![2]).toBe(5);
      // Količinska stavka se NE smešta pojedinačno (prati se kroz ledger/dokumente).
      expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(res.data.placement).toBeNull();
    });
  });

  // ---------- R1: klasifikacija (RA-26/27/28) ----------

  describe("addInventorySubgroup (RA-26)", () => {
    it("zove rev_add_inventory_subgroup kroz withUser (GUC scope)", async () => {
      tx.$queryRaw.mockResolvedValue([{ id: "sg1", label: "Nova" }]);
      const res = await service.addInventorySubgroup(EMAIL, {
        groupCode: "AKU",
        label: "Nova",
      });
      expect(sy15.withUser).toHaveBeenCalledWith(EMAIL, expect.any(Function));
      expect(res.data).toEqual({ id: "sg1", label: "Nova" });
    });

    it("42501 (bez prava) → 403", async () => {
      sy15.withUser.mockRejectedValue({
        meta: { code: "42501", message: "nem" },
      });
      await expect(
        service.addInventorySubgroup(EMAIL, { groupCode: "AKU", label: "N" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("23503 (grupa ne postoji) → 422", async () => {
      sy15.withUser.mockRejectedValue({
        meta: { code: "23503", message: "no" },
      });
      await expect(
        service.addInventorySubgroup(EMAIL, { groupCode: "X", label: "N" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe("deleteInventorySubgroup (RA-28)", () => {
    it("sistemska (is_seeded) → 422 bez brisanja", async () => {
      sy15.db.revInventorySubgroup.findUnique.mockResolvedValue({
        isSeeded: true,
      });
      await expect(
        service.deleteInventorySubgroup(UUID),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(sy15.db.revInventorySubgroup.delete).not.toHaveBeenCalled();
    });

    it("nepostojeća → 404", async () => {
      sy15.db.revInventorySubgroup.findUnique.mockResolvedValue(null);
      await expect(
        service.deleteInventorySubgroup(UUID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("korisnička sa podpodgrupama (P2003) → 409", async () => {
      sy15.db.revInventorySubgroup.findUnique.mockResolvedValue({
        isSeeded: false,
      });
      sy15.db.revInventorySubgroup.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("fk", {
          code: "P2003",
          clientVersion: "6.19.3",
        }),
      );
      await expect(
        service.deleteInventorySubgroup(UUID),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("korisnička bez dece → obrisana", async () => {
      sy15.db.revInventorySubgroup.findUnique.mockResolvedValue({
        isSeeded: false,
      });
      sy15.db.revInventorySubgroup.delete.mockResolvedValue({});
      const res = await service.deleteInventorySubgroup(UUID);
      expect(res.data).toEqual({ deleted: true });
    });
  });

  describe("renameClassification (RA-27)", () => {
    it("nevažeći kind → 422", async () => {
      await expect(
        service.renameClassification("bogus", UUID, "X"),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  // ---------- R1: štampa nalepnica (RA-22/RB-47) ----------

  describe("printLabel (RA-22/RB-47)", () => {
    it("delegira na LabelPrintService.printRawTspl (reuse transporta)", async () => {
      labelPrint.printRawTspl.mockResolvedValue({
        ok: true,
        bytes: 42,
        printer: "x",
      });
      const dto = { tspl2: "CLS\nPRINT 1,1\n" };
      const res = await service.printLabel(dto);
      expect(labelPrint.printRawTspl).toHaveBeenCalledWith(dto);
      expect(res.data.bytes).toBe(42);
    });
  });

  // ---------- R4: Zaduženja lista — filteri + lineCount (RB-16/19/20/22/25) ----------

  describe("listDocuments — filteri + lineCount (RB-16/19/20/22/25)", () => {
    // Typed pogled na uhvaćeni `where` (izbegava no-unsafe-member-access na mock.calls).
    type CapturedWhere = {
      status?: unknown;
      expectedReturnDate?: { lt?: Date };
      issuedAt?: { gte?: Date; lte?: Date };
    };
    const lastWhere = (): CapturedWhere =>
      (
        sy15.db.revDocument.findMany.mock.calls as [{ where: CapturedWhere }][]
      )[0][0].where;

    it("dodaje lineCount po dokumentu; 0 kad dokument nema stavki", async () => {
      sy15.db.revDocument.findMany.mockResolvedValue([
        { id: "d1", docNumber: "REV-1" },
        { id: "d2", docNumber: "REV-2" },
      ]);
      sy15.db.revDocument.count.mockResolvedValue(2);
      sy15.db.revDocumentLine.groupBy.mockResolvedValue([
        { documentId: "d1", _count: { _all: 3 } },
      ]);
      const res = await service.listDocuments({});
      expect(res.data.find((d) => d.id === "d1")!.lineCount).toBe(3);
      expect(res.data.find((d) => d.id === "d2")!.lineCount).toBe(0);
      expect(res.meta.pagination.total).toBe(2);
    });

    it("overdue=true → status IN (OPEN,PARTIALLY_RETURNED) + expectedReturnDate < danas (RB-20)", async () => {
      sy15.db.revDocument.findMany.mockResolvedValue([]);
      sy15.db.revDocument.count.mockResolvedValue(0);
      await service.listDocuments({ overdue: "true", status: "RETURNED" });
      const where = lastWhere();
      expect(where.status).toEqual({ in: ["OPEN", "PARTIALLY_RETURNED"] });
      expect(where.expectedReturnDate?.lt).toBeInstanceOf(Date);
    });

    it("statuses (CSV) ima prednost nad status; status=ALL → bez filtera statusa", async () => {
      sy15.db.revDocument.findMany.mockResolvedValue([]);
      sy15.db.revDocument.count.mockResolvedValue(0);
      await service.listDocuments({
        statuses: "OPEN,PARTIALLY_RETURNED",
        status: "RETURNED",
      });
      expect(lastWhere().status).toEqual({
        in: ["OPEN", "PARTIALLY_RETURNED"],
      });

      sy15.db.revDocument.findMany.mockClear();
      await service.listDocuments({ status: "ALL" });
      expect(lastWhere().status).toBeUndefined();
    });

    it("issuedFrom/issuedTo → issued_at gte/lte (RB-19)", async () => {
      sy15.db.revDocument.findMany.mockResolvedValue([]);
      sy15.db.revDocument.count.mockResolvedValue(0);
      await service.listDocuments({
        issuedFrom: "2026-07-01T00:00:00.000Z",
        issuedTo: "2026-07-31T23:59:59.999Z",
      });
      const where = lastWhere();
      expect(where.issuedAt?.gte).toBeInstanceOf(Date);
      expect(where.issuedAt?.lte).toBeInstanceOf(Date);
    });

    it("prazna strana → groupBy stavki se ne poziva", async () => {
      sy15.db.revDocument.findMany.mockResolvedValue([]);
      sy15.db.revDocument.count.mockResolvedValue(0);
      await service.listDocuments({});
      expect(sy15.db.revDocumentLine.groupBy).not.toHaveBeenCalled();
    });

    it("RA-47/48: pageSize do 500 dozvoljen; >500 klampovan (Mapa/workbench)", async () => {
      const takeArg = (): number =>
        (sy15.db.revDocument.findMany.mock.calls as [{ take: number }][])[0][0]
          .take;
      sy15.db.revDocument.findMany.mockResolvedValue([]);
      sy15.db.revDocument.count.mockResolvedValue(0);
      await service.listDocuments({ pageSize: "500" });
      expect(takeArg()).toBe(500);

      sy15.db.revDocument.findMany.mockClear();
      await service.listDocuments({ pageSize: "999" });
      expect(takeArg()).toBe(500);
    });
  });

  // ---------- R4: recipient cardinality (RB-16 KPI „Primaoci aktivno") ----------

  describe("recipientCardinality (RB-16)", () => {
    it("mapira COUNT(DISTINCT) u { count, truncated:false }", async () => {
      sy15.db.$queryRaw.mockResolvedValue([{ count: 7 }]);
      const res = await service.recipientCardinality({});
      expect(res.data).toEqual({ count: 7, truncated: false });
      expect(sy15.db.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- R2: izveštaj potrošnje (RA-39/40/41) ----------

  describe("reportConsumption — izveštaj potrošnje (RA-39/40/41)", () => {
    // Vezani parametri iz `Prisma.sql` (redosled: from, to, reason, limit).
    const boundValues = (): unknown[] =>
      (sy15.db.$queryRaw.mock.calls as [{ values: unknown[] }][])[0][0].values;

    it("bez filtera → samo LIMIT (default 2000) vezan; vraća redove ledgera", async () => {
      sy15.db.$queryRaw.mockResolvedValue([{ ledger_id: "L1", delta: 3 }]);
      const res = await service.reportConsumption({});
      expect(sy15.db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(boundValues()).toEqual([2000]);
      expect(res.data).toEqual([{ ledger_id: "L1", delta: 3 }]);
    });

    it("from/to/reason → svi filteri vezani redom; `to` je kraj dana", async () => {
      sy15.db.$queryRaw.mockResolvedValue([]);
      await service.reportConsumption({
        from: "2026-07-01",
        to: "2026-07-17",
        reason: "ISSUE",
        limit: "5000",
      });
      expect(boundValues()).toEqual([
        "2026-07-01",
        "2026-07-17T23:59:59",
        "ISSUE",
        5000,
      ]);
    });

    it("reason=ALL → bez filtera tipa (samo LIMIT)", async () => {
      sy15.db.$queryRaw.mockResolvedValue([]);
      await service.reportConsumption({ reason: "ALL" });
      expect(boundValues()).toEqual([2000]);
    });

    it("limit se klampuje na 1..5000 (preko max → 5000)", async () => {
      sy15.db.$queryRaw.mockResolvedValue([]);
      await service.reportConsumption({ limit: "99999" });
      expect(boundValues()).toEqual([5000]);
    });
  });

  // ---------- R4: Quick Return HAND — open-line lookup (RB-43/44) ----------

  describe("openHandLineByBarcode — Quick Return HAND (RB-43/44)", () => {
    it("prazan barkod → data:null bez upita", async () => {
      const res = await service.openHandLineByBarcode("");
      expect(res.data).toBeNull();
      expect(sy15.db.revTool.findFirst).not.toHaveBeenCalled();
    });

    it("alat ne postoji → null", async () => {
      sy15.db.revTool.findFirst.mockResolvedValue(null);
      const res = await service.openHandLineByBarcode("ALAT-000123");
      expect(res.data).toBeNull();
    });

    it("bira NAJSTARIJI otvoren revers (FIFO) i vraća SVE preostalo (bilo koji primalac)", async () => {
      sy15.db.revTool.findFirst.mockResolvedValue({
        id: "t1",
        oznaka: "ALAT-1",
        naziv: "Ključ",
        barcode: "ALAT-000123",
        serijskiBroj: null,
      });
      sy15.db.revDocumentLine.findMany.mockResolvedValue([
        { id: "lNew", documentId: "dNew", quantity: 2, returnedQuantity: 0 },
        { id: "lOld", documentId: "dOld", quantity: 5, returnedQuantity: 1 },
      ]);
      sy15.db.revDocument.findMany.mockResolvedValue([
        {
          id: "dNew",
          docNumber: "REV-9",
          issuedAt: new Date("2026-07-10T08:00:00Z"),
          recipientEmployeeName: "Nov",
          recipientDepartment: null,
          recipientCompanyName: null,
        },
        {
          id: "dOld",
          docNumber: "REV-1",
          issuedAt: new Date("2026-07-01T08:00:00Z"),
          recipientEmployeeName: "Stari",
          recipientDepartment: null,
          recipientCompanyName: null,
        },
      ]);
      const res = await service.openHandLineByBarcode("*ALAT-000123*");
      expect(res.data).toEqual({
        lineId: "lOld",
        documentId: "dOld",
        docNumber: "REV-1",
        recipientLabel: "Stari",
        issuedQty: 5,
        returnedQty: 1,
        remainingQty: 4,
        tool: {
          id: "t1",
          oznaka: "ALAT-1",
          naziv: "Ključ",
          barcode: "ALAT-000123",
          serijskiBroj: null,
        },
      });
    });

    it("ISSUED linija ali nijedan dokument nije OPEN/PARTIALLY_RETURNED → null", async () => {
      sy15.db.revTool.findFirst.mockResolvedValue({
        id: "t1",
        oznaka: "A",
        naziv: "N",
        barcode: "ALAT-000123",
        serijskiBroj: null,
      });
      sy15.db.revDocumentLine.findMany.mockResolvedValue([
        { id: "l1", documentId: "d1", quantity: 1, returnedQuantity: 0 },
      ]);
      sy15.db.revDocument.findMany.mockResolvedValue([]);
      const res = await service.openHandLineByBarcode("ALAT-000123");
      expect(res.data).toBeNull();
    });
  });

  // ---------- R4: lookup primaoca/lokacija (RB-35/45) ----------

  describe("lookupEmployees (RB-35) / lookupLocations (RB-45)", () => {
    it("lookupEmployees vraća i is_active (neaktivni ostaju u pickeru)", async () => {
      sy15.db.$queryRaw.mockResolvedValue([
        { id: "e1", full_name: "Neaktivni", is_active: false },
      ]);
      const res = await service.lookupEmployees("nea");
      expect(res.data).toEqual([
        { id: "e1", full_name: "Neaktivni", is_active: false },
      ]);
    });

    it("lookupLocations vraća aktivne lokacije za dropdown povraćaja", async () => {
      sy15.db.$queryRaw.mockResolvedValue([
        { id: "l1", location_code: "ALAT-MAG-01", name: "Magacin" },
      ]);
      const res = await service.lookupLocations();
      expect(res.data).toEqual([
        { id: "l1", location_code: "ALAT-MAG-01", name: "Magacin" },
      ]);
    });
  });
});

import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DocumentTypesService } from "./document-types.service";
import { normalizeListQuery } from "./document-types.controller";

/**
 * Registar vrsta dokumenata kao konfiguracija ekrana (PLAN_UNOS_DOKUMENATA §5.1/§5.7).
 *
 * Ključ paketa: ekran NE sme da se sruši ni da tiho blokira magacin zbog vrste koja još
 * nije konfigurisana (`screen_kind`/`stock_check` su NULL na 46 od 57 vrsta) — zato uz
 * sirovu vrednost ide i `effective*`, a nepoznata vrednost u koloni pada na podrazumevanu
 * i prijavi se.
 */

function prismaMock() {
  return {
    documentType: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

/** Red registra sa svim kolonama koje servis bira. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    code: "IFR",
    description: "Izlazna faktura roba",
    isInbound: false,
    isInternalDocument: false,
    isFiscal: false,
    isDepartmental: false,
    numberingGroup: "INVOICE_OUT",
    numberingMode: "MAX",
    documentNumberPrefix: "IFR",
    numberingStart: 0,
    screenKind: "GOODS",
    stockCheck: "BLOCK",
    reservesStock: false,
    affectsStock: true,
    defaultWarehouseId: 1,
    writesPriceList: false,
    defaultPriceListCode: null,
    defaultVatExemptionCode: null,
    postInVatLedger: true,
    saleWithPpp: false,
    saleWithPpu: true,
    requiresProject: false,
    requiresWorkOrder: false,
    requiresPoNumber: false,
    allowedPrintVariants: ["invoice", "delivery"],
    carryOverTargets: ["KNO"],
    ...overrides,
  };
}

describe("DocumentTypesService", () => {
  let service: DocumentTypesService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentTypesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(DocumentTypesService);
  });

  it("vraća { data, meta } sa konfiguracijom ekrana za vrstu", async () => {
    prisma.documentType.findMany.mockResolvedValue([row()]);

    const res = await service.list();

    expect(res.meta).toEqual({ count: 1, configured: 1 });
    const d = res.data[0];
    expect(d.code).toBe("IFR");
    expect(d.screenKind).toBe("GOODS");
    expect(d.effectiveScreenKind).toBe("GOODS");
    expect(d.stockCheck).toBe("BLOCK");
    expect(d.numberingGroup).toBe("INVOICE_OUT");
    expect(d.numberingMode).toBe("MAX");
    expect(d.allowedPrintVariants).toEqual(["invoice", "delivery"]);
    expect(d.carryOverTargets).toEqual(["KNO"]);
    expect(d.isConfigured).toBe(true);
    expect(d.warnings).toEqual([]);
  });

  it("NEkonfigurisana vrsta: profil pada na GOODS, provera zaliha na BLOCK", async () => {
    // 46 od 57 vrsta danas nema `screen_kind` — ekran mora da radi i nad njima.
    prisma.documentType.findMany.mockResolvedValue([
      row({ code: "NIV", screenKind: null, stockCheck: null }),
    ]);

    const [d] = (await service.list()).data;

    expect(d.isConfigured).toBe(false);
    expect(d.screenKind).toBeNull();
    expect(d.effectiveScreenKind).toBe("GOODS"); // više kolona, ne manje
    expect(d.stockCheck).toBeNull();
    // BLOCK, ne OFF: registar PRIJAVLJUJE ono što robna ruta stvarno SPROVODI.
    // Ranije je ovde stajalo OFF pa je ekran javljao „ne proveravam zalihe" a ruta
    // isti unos odbijala sa 422 (nalaz adversarnog pregleda 28.07).
    expect(d.effectiveStockCheck).toBe("BLOCK");
  });

  it("nepoznata vrednost u koloni ne curi na ekran — pada na podrazumevanu i prijavi se", async () => {
    prisma.documentType.findMany.mockResolvedValue([
      row({ screenKind: "ROBA", stockCheck: "HARD" }),
    ]);

    const [d] = (await service.list()).data;

    expect(d.screenKind).toBeNull();
    expect(d.effectiveScreenKind).toBe("GOODS");
    expect(d.effectiveStockCheck).toBe("BLOCK");
    expect(d.warnings).toHaveLength(2);
    expect(d.warnings.join(" ")).toContain("screen_kind");
    expect(d.warnings.join(" ")).toContain("stock_check");
  });

  it("nizovi štampe/prepisa su UVEK niz (prazan = nije konfigurisano)", async () => {
    prisma.documentType.findMany.mockResolvedValue([
      row({ allowedPrintVariants: [], carryOverTargets: [] }),
    ]);

    const [d] = (await service.list()).data;

    expect(d.allowedPrintVariants).toEqual([]);
    expect(d.carryOverTargets).toEqual([]);
  });

  it("`saleWithPpp/Ppu` izlaze pod tačnim značenjem (obračun poreza, ne bruto/neto — §4.4c)", async () => {
    prisma.documentType.findMany.mockResolvedValue([
      row({ saleWithPpp: true, saleWithPpu: false }),
    ]);

    const [d] = (await service.list()).data;

    expect(d.chargesGoodsVat).toBe(true);
    expect(d.chargesServiceVat).toBe(false);
  });

  describe("filteri", () => {
    it("šifra i grupa idu velikim slovima u upit", async () => {
      await service.list({ code: " ifr ", numberingGroup: "invoice_out" });

      expect(prisma.documentType.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            code: "IFR",
            numberingGroup: "INVOICE_OUT",
          }),
          orderBy: { code: "asc" },
        }),
      );
    });

    it("`configuredOnly` traži popunjen screen_kind", async () => {
      await service.list({ configuredOnly: true });

      const arg = prisma.documentType.findMany.mock.calls[0][0];
      expect(arg.where.screenKind).toEqual({ not: null });
    });

    it("`configuredOnly` NE gazi uži filter po profilu", async () => {
      await service.list({ configuredOnly: true, screenKind: "service" });

      const arg = prisma.documentType.findMany.mock.calls[0][0];
      expect(arg.where.screenKind).toBe("SERVICE");
    });

    it("`q` traži po šifri ili opisu", async () => {
      await service.list({ q: "faktura" });

      const arg = prisma.documentType.findMany.mock.calls[0][0];
      expect(arg.where.OR).toHaveLength(2);
    });
  });

  describe("byCode", () => {
    it("normalizuje šifru na velika slova", async () => {
      prisma.documentType.findUnique.mockResolvedValue(row());

      const res = await service.byCode(" ifr ");

      expect(prisma.documentType.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { code: "IFR" } }),
      );
      expect(res.data.code).toBe("IFR");
    });

    it("nepostojeća vrsta → 404 sa porukom na srpskom", async () => {
      prisma.documentType.findUnique.mockResolvedValue(null);

      await expect(service.byCode("XXX")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.byCode("XXX")).rejects.toThrow(
        /Vrsta dokumenta .* ne postoji/,
      );
    });

    it("prazna šifra → 404, ne upit u bazu", async () => {
      await expect(service.byCode("  ")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.documentType.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("normalizeListQuery (query stiže kao string)", () => {
    it("`inbound=false` je filter, ne izostavljanje filtera", () => {
      expect(normalizeListQuery({ inbound: "false" }).isInbound).toBe(false);
      expect(normalizeListQuery({ inbound: "true" }).isInbound).toBe(true);
      expect(normalizeListQuery({}).isInbound).toBeUndefined();
    });

    it("`configured` je uključen samo na eksplicitno true/1", () => {
      expect(normalizeListQuery({ configured: "1" }).configuredOnly).toBe(true);
      expect(normalizeListQuery({ configured: "false" }).configuredOnly).toBe(
        false,
      );
      expect(normalizeListQuery({}).configuredOnly).toBe(false);
    });

    it("prazan string nije filter", () => {
      const q = normalizeListQuery({ code: "", group: "", q: "" });
      expect(q.code).toBeUndefined();
      expect(q.numberingGroup).toBeUndefined();
      expect(q.q).toBeUndefined();
    });
  });
});

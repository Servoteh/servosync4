import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PDFDocument } from "pdf-lib";
import { PrismaService } from "../../prisma/prisma.service";
import { PrintBundleService } from "./print-bundle.service";

/** mm → PDF point (1 pt = 1/72 inča). */
const MM_TO_PT = 72 / 25.4;

/** Minimalan pravi PDF sa stranama zadatih dimenzija u mm (pdf-lib, kao i produkcija). */
async function makePdf(
  widthMm: number,
  heightMm: number,
  pages = 1,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++)
    doc.addPage([widthMm * MM_TO_PT, heightMm * MM_TO_PT]);
  return Buffer.from(await doc.save());
}

interface PdfWhere {
  where: {
    drawingNumber_revision: { drawingNumber: string; revision: string };
  };
}

/** Mock PrismaService — isti obrazac kao handovers.service.spec.ts. */
function prismaMock() {
  return {
    handoverDraft: { findUnique: jest.fn() },
    handoverDraftItem: { findMany: jest.fn().mockResolvedValue([]) },
    drawingHandover: { findUnique: jest.fn() },
    drawing: { findMany: jest.fn().mockResolvedValue([]) },
    drawingPdf: { findUnique: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

describe("PrintBundleService", () => {
  let service: PrintBundleService;
  let prisma: ReturnType<typeof prismaMock>;

  // Test blobovi (razne MediaBox dimenzije) — generisani jednom.
  let a4TwoPages: Buffer; // 210×297 mm, 2 strane
  let a1Portrait: Buffer; // 594×841 mm
  let a4Landscape: Buffer; // 297×210 mm (pejzaž — isti format)
  let customSize: Buffer; // 500×500 mm — nije ISO A
  const garbage = Buffer.from("ovo nije PDF sadržaj");

  beforeAll(async () => {
    a4TwoPages = await makePdf(210, 297, 2);
    a1Portrait = await makePdf(594, 841);
    a4Landscape = await makePdf(297, 210);
    customSize = await makePdf(500, 500);
  });

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PrintBundleService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(PrintBundleService);
  });

  /**
   * Standardni nacrt 1 (G-260710-001):
   *   - stavka 1: crtež 10 (D-10, A4 PDF sa 2 strane)
   *   - stavka 2: crtež 11 (D-11, A1 PDF)
   *   - stavka 3: crtež 10 PONOVO, isključena → dedup (crtež ostaje ne-isključen)
   *   - stavka 4: crtež 12 (D-12) ISKLJUČENA (ima PDF, ali se preskače)
   *   - stavka 5: crtež 13 (D-13) bez PDF-a → missing
   */
  function setupDraft(blobs: Record<string, Buffer> = defaultBlobs()) {
    prisma.handoverDraft.findUnique.mockResolvedValue({
      id: 1,
      draftNumber: "G-260710-001",
    });
    prisma.handoverDraftItem.findMany.mockResolvedValue([
      { id: 1, drawingId: 10, excludeFromHandover: false },
      { id: 2, drawingId: 11, excludeFromHandover: false },
      { id: 3, drawingId: 10, excludeFromHandover: true },
      { id: 4, drawingId: 12, excludeFromHandover: true },
      { id: 5, drawingId: 13, excludeFromHandover: false },
    ]);
    prisma.drawing.findMany.mockResolvedValue([
      { id: 10, drawingNumber: "D-10", revision: "A", name: "Ploča" },
      { id: 11, drawingNumber: "D-11", revision: "B", name: "Sklop" },
      { id: 12, drawingNumber: "D-12", revision: "A", name: "Isključen" },
      { id: 13, drawingNumber: "D-13", revision: "A", name: "Bez PDF-a" },
    ]);
    prisma.$queryRaw.mockResolvedValue([
      { drawing_number: "D-10", revision: "A", has_binary: true, size_kb: 12 },
      { drawing_number: "D-11", revision: "B", has_binary: true, size_kb: 34 },
      { drawing_number: "D-12", revision: "A", has_binary: true, size_kb: 5 },
    ]);
    prisma.drawingPdf.findUnique.mockImplementation((args: PdfWhere) => {
      const blob = blobs[args.where.drawingNumber_revision.drawingNumber];
      return Promise.resolve(blob ? { pdfBinary: blob } : null);
    });
  }

  function defaultBlobs(): Record<string, Buffer> {
    return { "D-10": a4TwoPages, "D-11": a1Portrait, "D-12": a4TwoPages };
  }

  /** Brojevi crteža čiji je blob stvarno tražen iz baze. */
  function requestedBlobNumbers(): string[] {
    return (prisma.drawingPdf.findUnique.mock.calls as [PdfWhere][]).map(
      (c) => c[0].where.drawingNumber_revision.drawingNumber,
    );
  }

  // ------------------------------------------------------------ DRAFT BUNDLE

  describe("draftBundle", () => {
    it("404 kad nacrt ne postoji", async () => {
      prisma.handoverDraft.findUnique.mockResolvedValue(null);
      await expect(service.draftBundle(1)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("dedup crteža, grupe po formatu (A1 pre A4), excluded preskočen, missingCount", async () => {
      setupDraft();

      const { data } = await service.draftBundle(1);

      // Dedup: crtež 10 jednom (i ne-isključen jer je prva pojava ne-isključena).
      expect(data.items.map((i) => i.drawingId)).toEqual([10, 11, 12, 13]);

      const byId = new Map(data.items.map((i) => [i.drawingId, i]));
      expect(byId.get(10)).toMatchObject({
        drawingNumber: "D-10",
        excluded: false,
        hasPdf: true,
        sizeKb: 12,
        pageFormat: "A4",
      });
      expect(byId.get(11)).toMatchObject({ hasPdf: true, pageFormat: "A1" });
      // Isključena stavka: prijavljena u items, ali blob se NE učitava i ne ulazi u grupe.
      expect(byId.get(12)).toMatchObject({
        excluded: true,
        hasPdf: true,
        pageFormat: null,
      });
      expect(requestedBlobNumbers()).not.toContain("D-12");
      // Bez PDF-a → hasPdf false, sizeKb/pageFormat null.
      expect(byId.get(13)).toMatchObject({
        hasPdf: false,
        sizeKb: null,
        pageFormat: null,
      });

      // Grupe: veliki formati prvo (A0→A4→custom), samo ne-isključene sa PDF-om.
      expect(data.groups).toEqual([
        { format: "A1", count: 1, drawingIds: [11] },
        { format: "A4", count: 1, drawingIds: [10] },
      ]);
      expect(data.missingCount).toBe(1);
    });

    it("pejzažni A4 se klasifikuje kao A4 (orijentaciono-agnostično), 500×500 kao custom", async () => {
      setupDraft({
        "D-10": a4Landscape,
        "D-11": customSize,
        "D-12": a4TwoPages,
      });

      const { data } = await service.draftBundle(1);
      const byId = new Map(data.items.map((i) => [i.drawingId, i]));
      expect(byId.get(10)?.pageFormat).toBe("A4");
      expect(byId.get(11)?.pageFormat).toBe("custom");
      expect(data.groups).toEqual([
        { format: "A4", count: 1, drawingIds: [10] },
        { format: "custom", count: 1, drawingIds: [11] },
      ]);
    });

    it("nečitljiv PDF → pageFormat 'custom', hasPdf ostaje true", async () => {
      setupDraft({ "D-10": garbage, "D-11": a1Portrait, "D-12": a4TwoPages });

      const { data } = await service.draftBundle(1);
      const item = data.items.find((i) => i.drawingId === 10);
      expect(item).toMatchObject({ hasPdf: true, pageFormat: "custom" });
    });
  });

  // -------------------------------------------------------- DRAFT BUNDLE PDF

  describe("draftBundlePdf", () => {
    it("spaja SVE crteže sa PDF-om, redosled kao u items; excluded i missing preskočeni", async () => {
      setupDraft();

      const { buffer, fileName } = await service.draftBundlePdf(1, {});

      expect(fileName).toBe("nacrt-G-260710-001-sve.pdf");
      const merged = await PDFDocument.load(buffer);
      // 2 strane D-10 (A4) + 1 strana D-11 (A1); D-12 (excluded) i D-13 (missing) nisu tu.
      expect(merged.getPageCount()).toBe(3);
      expect(merged.getPage(0).getSize().width).toBeCloseTo(210 * MM_TO_PT, 0);
      expect(merged.getPage(2).getSize().width).toBeCloseTo(594 * MM_TO_PT, 0);
      expect(requestedBlobNumbers()).not.toContain("D-12");
    });

    it("?format=A4 spaja samo A4 crteže", async () => {
      setupDraft();

      const { buffer, fileName } = await service.draftBundlePdf(1, {
        format: "A4",
      });

      expect(fileName).toBe("nacrt-G-260710-001-A4.pdf");
      const merged = await PDFDocument.load(buffer);
      expect(merged.getPageCount()).toBe(2); // samo D-10
      expect(merged.getPage(0).getSize().width).toBeCloseTo(210 * MM_TO_PT, 0);
    });

    it("?drawingIds= spaja samo izabrane (redosled kao u items)", async () => {
      setupDraft();

      const { buffer, fileName } = await service.draftBundlePdf(1, {
        drawingIds: "11,10",
      });

      expect(fileName).toBe("nacrt-G-260710-001-izbor.pdf");
      const merged = await PDFDocument.load(buffer);
      expect(merged.getPageCount()).toBe(3);
      // Redosled prati items (crtež 10 pre 11), ne redosled iz query-ja.
      expect(merged.getPage(0).getSize().width).toBeCloseTo(210 * MM_TO_PT, 0);
    });

    it("422 za drawingId koji ne pripada nacrtu", async () => {
      setupDraft();
      await expect(
        service.draftBundlePdf(1, { drawingIds: "999" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("422 za isključen drawingId (ne štampa se kroz bundle)", async () => {
      setupDraft();
      await expect(
        service.draftBundlePdf(1, { drawingIds: "12" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("422 za crtež bez PDF-a u eksplicitnom izboru", async () => {
      setupDraft();
      await expect(
        service.draftBundlePdf(1, { drawingIds: "13" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("422 kad su prosleđeni i format i drawingIds", async () => {
      setupDraft();
      await expect(
        service.draftBundlePdf(1, { format: "A4", drawingIds: "10" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("422 za nepoznat format", async () => {
      setupDraft();
      await expect(
        service.draftBundlePdf(1, { format: "B5" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it("422 kad nijedan crtež nema PDF (prazan izbor)", async () => {
      prisma.handoverDraft.findUnique.mockResolvedValue({
        id: 2,
        draftNumber: "G-260710-002",
      });
      prisma.handoverDraftItem.findMany.mockResolvedValue([
        { id: 9, drawingId: 13, excludeFromHandover: false },
      ]);
      prisma.drawing.findMany.mockResolvedValue([
        { id: 13, drawingNumber: "D-13", revision: "A", name: "Bez PDF-a" },
      ]);
      prisma.$queryRaw.mockResolvedValue([]);

      await expect(service.draftBundlePdf(2, {})).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it("422 kad nijedan crtež nije u traženom formatu", async () => {
      setupDraft();
      await expect(
        service.draftBundlePdf(1, { format: "A0" }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  // -------------------------------------------------------- HANDOVER NIVO

  describe("handoverBundle / handoverBundlePdf", () => {
    function setupHandover() {
      prisma.drawingHandover.findUnique.mockResolvedValue({
        id: 7,
        drawingId: 10,
      });
      prisma.drawing.findMany.mockResolvedValue([
        { id: 10, drawingNumber: "D-10", revision: "A", name: "Ploča" },
      ]);
      prisma.$queryRaw.mockResolvedValue([
        {
          drawing_number: "D-10",
          revision: "A",
          has_binary: true,
          size_kb: 12,
        },
      ]);
      prisma.drawingPdf.findUnique.mockImplementation((args: PdfWhere) =>
        Promise.resolve(
          args.where.drawingNumber_revision.drawingNumber === "D-10"
            ? { pdfBinary: a4TwoPages }
            : null,
        ),
      );
    }

    it("404 kad primopredaja ne postoji", async () => {
      prisma.drawingHandover.findUnique.mockResolvedValue(null);
      await expect(service.handoverBundle(7)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("bundle od JEDNOG crteža primopredaje — isti oblik odgovora", async () => {
      setupHandover();

      const { data } = await service.handoverBundle(7);

      expect(data.items).toHaveLength(1);
      expect(data.items[0]).toMatchObject({
        drawingId: 10,
        drawingNumber: "D-10",
        excluded: false,
        hasPdf: true,
        pageFormat: "A4",
      });
      expect(data.groups).toEqual([
        { format: "A4", count: 1, drawingIds: [10] },
      ]);
      expect(data.missingCount).toBe(0);
    });

    it("PDF primopredaje: sve strane crteža, filename primopredaja-{id}-sve.pdf", async () => {
      setupHandover();

      const { buffer, fileName } = await service.handoverBundlePdf(7, {});

      expect(fileName).toBe("primopredaja-7-sve.pdf");
      const merged = await PDFDocument.load(buffer);
      expect(merged.getPageCount()).toBe(2);
    });
  });
});

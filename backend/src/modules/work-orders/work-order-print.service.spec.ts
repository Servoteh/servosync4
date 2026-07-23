import "reflect-metadata";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { BarcodeService } from "../documents/barcode.service";
import { WorkOrderPrintService } from "./work-order-print.service";

/**
 * Pokriva mapiranje Predmet polja na RN dokumentu (zahtev 006/26). Bug je bio:
 * stampalo se `projects.id` (interni PK, npr. 10354) umesto broja predmeta
 * (`projects.project_number`, npr. 9400 — prefiks RN broja). Ove grane su
 * tihe (docDefinition, ne HTTP), pa stite od regresije pri buducem sirenju
 * Promise.all batch-a. `pdf.render` je mock-ovan da uhvati docDefinition.
 */

/** RN mock — samo polja koja `buildRnPdf` cita; komitent/tehnolog/primopredaja iskljuceni. */
function makeWo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    projectId: 10354, // interni projects.id (NE sme se pojaviti u Predmet celiji)
    identNumber: "9400/7/30",
    variant: 0,
    revision: "A",
    externalCustomerId: 0,
    workerId: 0,
    drawingHandoverId: 0,
    drawingNumber: "1125923",
    partName: "Prskalice 2 zav.",
    material: "Zav. sklop",
    materialDimension: "Zav. sklop",
    pieceCount: 3,
    productionDeadline: null,
    operations: [] as unknown[],
    ...overrides,
  };
}

/** Sveze mock-ove + servis po testu (bez cross-test curenja poziva). */
function setup() {
  const prisma = {
    workOrder: { findUnique: jest.fn() },
    customer: { findUnique: jest.fn() },
    worker: { findUnique: jest.fn() },
    project: { findUnique: jest.fn() },
    operation: { findMany: jest.fn().mockResolvedValue([]) },
    drawingHandover: { findUnique: jest.fn() },
  };
  const pdf = { render: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4")) };
  const barcode = { code128Svg: jest.fn().mockReturnValue("<svg/>") };
  const service = new WorkOrderPrintService(
    prisma as unknown as PrismaService,
    pdf as unknown as PdfService,
    barcode as unknown as BarcodeService,
  );
  return { service, prisma, pdf, barcode };
}

/** Vrednost Predmet celije: nadji red sa labelom "Predmet" u info tabeli, vrati susednu celiju. */
function predmetCell(docDef: TDocumentDefinitions): string | undefined {
  const content = docDef.content as Array<{ table?: { body?: unknown[][] } }>;
  for (const node of content) {
    const body = node?.table?.body;
    if (!Array.isArray(body)) continue;
    for (const row of body) {
      if (!Array.isArray(row)) continue;
      for (let i = 0; i < row.length - 1; i++) {
        const cell = row[i] as { text?: unknown } | undefined;
        if (cell?.text === "Predmet") {
          return (row[i + 1] as { text?: string } | undefined)?.text;
        }
      }
    }
  }
  throw new Error("Predmet celija nije nadjena u docDefinition-u");
}

describe("WorkOrderPrintService — Predmet mapiranje (006/26)", () => {
  it("projectId>0: stampa projects.project_number (9400), ne interni id (10354)", async () => {
    const { service, prisma, pdf } = setup();
    prisma.workOrder.findUnique.mockResolvedValue(makeWo({ projectId: 10354 }));
    prisma.project.findUnique.mockResolvedValue({ projectNumber: "9400" });

    await service.buildRnPdf(1);

    const docDef = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(predmetCell(docDef)).toBe("9400");
    expect(predmetCell(docDef)).not.toBe("10354");
    expect(prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: 10354 },
      select: { projectNumber: true },
    });
  });

  it("projectId=0 (legacy): Predmet prazno, project.findUnique se NE poziva", async () => {
    const { service, prisma, pdf } = setup();
    prisma.workOrder.findUnique.mockResolvedValue(makeWo({ projectId: 0, identNumber: "0/1" }));

    await service.buildRnPdf(1);

    const docDef = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(predmetCell(docDef)).toBe("—");
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it("projectId>0 ali predmet obrisan (findUnique vraca null): prazno, nikad id", async () => {
    const { service, prisma, pdf } = setup();
    prisma.workOrder.findUnique.mockResolvedValue(makeWo({ projectId: 10354 }));
    prisma.project.findUnique.mockResolvedValue(null);

    await service.buildRnPdf(1);

    const docDef = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(predmetCell(docDef)).toBe("—");
    expect(predmetCell(docDef)).not.toBe("10354");
  });
});

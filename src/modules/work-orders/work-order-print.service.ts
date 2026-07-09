import { Injectable, NotFoundException } from "@nestjs/common";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { SAFE_WORKER_SELECT } from "../../common/pagination";
import { PdfService } from "../documents/pdf.service";
import { BarcodeService } from "../documents/barcode.service";
import { formatOrderBarcode, formatOperationBarcode } from "../tech-processes/barcode";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";

export type RnPrintVariant = "std" | "bez-barkoda";

/**
 * Štampa radnog naloga (RN dokument) u PDF — legacy `rRN` (MODULE_SPEC_stampa §4).
 * Zaglavlje iz `work_orders` (+ komitent/tehnolog) sa `RNZ` barkodom; tabela operacija
 * iz `work_order_operations` (Was `tStavkeRN`), svaka sa svojim `S` barkodom. Sva polja
 * barkoda nose `revision` RN-a (verzioni pečat, §5) — isti kod za štampu i za kiosk-dekoder.
 */
@Injectable()
export class WorkOrderPrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly barcode: BarcodeService,
  ) {}

  async buildRnPdf(
    id: number,
    variant: RnPrintVariant = "std",
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      include: { operations: { orderBy: [{ operationNumber: "asc" }, { id: "asc" }] } },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji.`);

    // Batch-resolve imena (bez required-relation JOIN-a — orphan FK pravilo).
    const [customer, tehnolog, opCatalog] = await Promise.all([
      wo.externalCustomerId > 0
        ? this.prisma.customer.findUnique({
            where: { id: wo.externalCustomerId },
            select: { name: true },
          })
        : Promise.resolve(null),
      wo.workerId > 0
        ? this.prisma.worker.findUnique({
            where: { id: wo.workerId },
            select: SAFE_WORKER_SELECT,
          })
        : Promise.resolve(null),
      this.resolveWorkCenterNames(wo.operations.map((o) => o.workCenterCode)),
    ]);

    const withBarcode = variant !== "bez-barkoda";

    // Nalog-barkod (zaglavlje). Best-effort: legacy RN sa projectId=0 nema barkod.
    let orderBarcodeSvg: string | null = null;
    if (withBarcode && wo.projectId > 0 && wo.identNumber.trim()) {
      try {
        orderBarcodeSvg = this.barcode.code128Svg(
          formatOrderBarcode({
            projectId: wo.projectId,
            identNumber: wo.identNumber,
            variant: wo.variant,
            revision: wo.revision,
          }),
          { height: 11 },
        );
      } catch {
        orderBarcodeSvg = null;
      }
    }

    const docDefinition = this.buildDocDefinition({
      wo,
      customerName: customer?.name ?? "",
      tehnologName: tehnolog?.fullName ?? tehnolog?.username ?? "",
      opCatalog,
      withBarcode,
      orderBarcodeSvg,
    });

    const buffer = await this.pdf.render(docDefinition);
    const safeIdent = wo.identNumber.replace(/[\\/:*?"<>|]+/g, "-");
    return { buffer, fileName: `RN-${safeIdent}-rev-${wo.revision}.pdf` };
  }

  /** Mapa workCenterCode → workCenterName iz `operations` šifarnika. */
  private async resolveWorkCenterNames(codes: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(codes.map((c) => (c ?? "").trim()).filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await this.prisma.operation.findMany({
      where: { workCenterCode: { in: unique } },
      select: { workCenterCode: true, workCenterName: true },
    });
    return new Map(rows.map((r) => [r.workCenterCode, r.workCenterName]));
  }

  private buildDocDefinition(args: {
    wo: {
      projectId: number;
      identNumber: string;
      variant: number;
      revision: string;
      drawingNumber: string;
      partName: string;
      material: string;
      pieceCount: number;
      productionDeadline: Date | null;
      operations: Array<{
        operationNumber: number;
        workCenterCode: string;
        workDescription: string;
        toolsFixtures: string | null;
        setupTime: number | null;
        cycleTime: number | null;
      }>;
    };
    customerName: string;
    tehnologName: string;
    opCatalog: Map<string, string>;
    withBarcode: boolean;
    orderBarcodeSvg: string | null;
  }): TDocumentDefinitions {
    const { wo, customerName, tehnologName, opCatalog, withBarcode, orderBarcodeSvg } = args;

    // Zaglavlje (parity sa legacy rRN): logo Servoteha gore-levo, naziv u sredini,
    // RNZ barkod desno.
    const headerColumns: Content = {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 128 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            { text: "RADNI NALOG", style: "title" },
            {
              text: `${wo.identNumber}   ·   revizija ${wo.revision}`,
              style: "subtitle",
            },
          ],
        },
        orderBarcodeSvg
          ? { svg: orderBarcodeSvg, fit: [190, 46], alignment: "right" }
          : { text: "", width: "auto" },
      ],
      columnGap: 8,
    };

    const infoRow = (l1: string, v1: string, l2: string, v2: string): Content[] => [
      { text: l1, style: "lbl" },
      { text: v1 || "—", style: "val" },
      { text: l2, style: "lbl" },
      { text: v2 || "—", style: "val" },
    ];
    const info: Content = {
      margin: [0, 10, 0, 10],
      table: {
        widths: ["auto", "*", "auto", "*"],
        body: [
          infoRow("Komitent", customerName, "Predmet", String(wo.projectId)),
          infoRow("Crtež", wo.drawingNumber, "Naziv dela", wo.partName),
          infoRow("Materijal", wo.material, "Varijanta", String(wo.variant)),
          infoRow(
            "Rok izrade",
            fmtDate(wo.productionDeadline),
            "Planirano",
            `${wo.pieceCount} kom`,
          ),
          infoRow("Tehnolog", tehnologName, "Revizija", wo.revision),
        ],
      },
      layout: "lightHorizontalLines",
    };

    const head = ["Op.", "Radni centar", "Opis rada", "Tpz", "Tk", "Alat/pribor"];
    const widths: (string | number)[] = ["auto", "auto", "*", "auto", "auto", "auto"];
    if (withBarcode) {
      head.push("Barkod");
      widths.push(140);
    }
    const headerCells: Content[] = head.map((t) => ({ text: t, style: "th" }));

    const bodyRows: Content[][] = wo.operations.map((o) => {
      const rcName = opCatalog.get(o.workCenterCode) ?? "";
      const cells: Content[] = [
        { text: String(o.operationNumber), style: "td" },
        { text: [o.workCenterCode, rcName].filter(Boolean).join(" · "), style: "td" },
        { text: o.workDescription ?? "", style: "td" },
        { text: fmtNum(o.setupTime), style: "tdNum" },
        { text: fmtNum(o.cycleTime), style: "tdNum" },
        { text: o.toolsFixtures ?? "", style: "td" },
      ];
      if (withBarcode) {
        let opSvg: string | null = null;
        if (o.workCenterCode?.trim()) {
          try {
            opSvg = this.barcode.code128Svg(
              formatOperationBarcode({
                operationNumber: o.operationNumber,
                workCenterCode: o.workCenterCode,
                revision: wo.revision,
              }),
              { height: 7 },
            );
          } catch {
            opSvg = null;
          }
        }
        cells.push(opSvg ? { svg: opSvg, fit: [136, 26] } : { text: "—", style: "td" });
      }
      return cells;
    });

    const opsTable: Content = wo.operations.length
      ? {
          table: { headerRows: 1, widths, body: [headerCells, ...bodyRows] },
          layout: "lightHorizontalLines",
        }
      : { text: "Nema operacija na ovom nalogu.", italics: true, margin: [0, 6, 0, 0] };

    return {
      pageSize: "A4",
      pageMargins: [28, 28, 28, 36],
      content: [headerColumns, info, opsTable],
      styles: {
        title: { fontSize: 18, bold: true },
        subtitle: { fontSize: 11, color: "#555", margin: [0, 2, 0, 0] },
        lbl: { fontSize: 8, bold: true, color: "#555" },
        val: { fontSize: 9 },
        th: { fontSize: 8, bold: true, fillColor: "#f0f0f0" },
        td: { fontSize: 8 },
        tdNum: { fontSize: 8, alignment: "right" },
      },
      defaultStyle: { font: "Roboto", fontSize: 9 },
      footer: (currentPage: number, pageCount: number): Content => ({
        text: `RN ${wo.identNumber} · rev ${wo.revision} · strana ${currentPage}/${pageCount}`,
        alignment: "center",
        fontSize: 7,
        color: "#888",
        margin: [0, 8, 0, 0],
      }),
    };
  }
}

/** Datum dd.MM.yyyy. (prazno ako null). */
function fmtDate(d: Date | null): string {
  if (!d) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}.`;
}

/** Broj sa decimalnim zarezom (prazno za null/0). */
function fmtNum(n: number | null): string {
  if (n == null || n === 0) return "";
  return String(n).replace(".", ",");
}

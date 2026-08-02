import { Injectable, NotFoundException } from "@nestjs/common";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { SAFE_WORKER_SELECT } from "../../common/pagination";
import { PdfService } from "../documents/pdf.service";
import { BarcodeService } from "../documents/barcode.service";
import {
  formatOrderBarcode,
  formatOperationBarcode,
} from "../tech-processes/barcode";
import { SERVOTEH_LOGO_DATA_URL } from "../documents/servoteh-logo";

export type RnPrintVariant = "std" | "bez-barkoda";

/** mm → PDF tačke (1 pt = 25.4/72 mm). */
export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

/**
 * Odštampane dimenzije barkoda na RN-u — KONSTANTNE, nezavisne od dužine sadržaja
 * (odluka vlasnika 01.08.2026, mera sa papira + legacy `rRN.txt` iz Access dump-a).
 *
 * Ranije su barkodi bili postavljani sa `fit: [š, v]`, a `fit` čuva odnos stranica.
 * Pošto je širina uvek bila ograničavajući faktor, visina je ISPADALA iz broja modula
 * — duži identNumber = niži barkod. Izmereno na starom kodu (širina fiksnih 67.0 mm):
 * `RNZ:100:9400/12:0:A` → 8.65 mm, `RNZ:10354:9811-3/77:0:A` → 7.33 mm,
 * `RNZ:999999:9999-99/9999:0:A-1` → 6.16 mm. Kratke crte su razlog zbog kojeg
 * operateri promašuju sken. Sada se zadaju i `width` i `height`, a SVG se generiše sa
 * `preserveAspectRatio="none"` (vidi `BarcodeService`), pa je veličina uvek tačno ova.
 *
 * Legacy QBigTehn mere (twips iz `rRN.txt`, potvrđene HIMETRIC zapisom u OLE objektu
 * ActiveBarcode kontrole, `SizeMode = 1` = stretch na okvir):
 *   - zaglavlje `Barcode0`: 3552 × 734 tw = 62.65 × 12.95 mm
 *     (varijante `rRN_STD` / `rRN_BezBarKoda`: 3120 × 734 tw = 55.03 × 12.95 mm)
 *   - red operacije `BarKod`: 2340 × 389 tw = 41.28 × 6.86 mm
 *
 * Zašto 62.65 a ne 55/57: merodavan je `rRN`, jedini legacy izveštaj koji ima I
 * barkodove operacija (kao naš); `rRN_STD` (55.03 mm) ih uopšte nema. Širina je
 * bitna jer određuje X-dimenziju (širinu najuže crte) = širina / broj modula, a
 * broj modula raste sa dužinom sadržaja. Nad svih 40.942 naloga u živoj bazi
 * (01.08.2026): na 57 mm 228 naloga (0.56%) padne ispod praga čitljivosti od
 * 0.19 mm, na 62.65 mm samo 30 (0.07%); najčešća dužina (21 znak, 34% naloga)
 * ide sa 0.214 na 0.236 mm.
 */
/** Nalog-barkod u zaglavlju: 62.65 × 13 mm (legacy `Barcode0`; visina 12.95 → 13). */
export const RN_ORDER_BARCODE_MM = { width: 62.65, height: 13 } as const;
/** Barkod u redu operacije: 41.3 × 6.9 mm (legacy 41.28 × 6.86, zaokruženo na 0.1 mm). */
export const RN_OPERATION_BARCODE_MM = { width: 41.3, height: 6.9 } as const;

const RN_ORDER_BARCODE_PT = {
  width: mmToPt(RN_ORDER_BARCODE_MM.width),
  height: mmToPt(RN_ORDER_BARCODE_MM.height),
} as const;
const RN_OPERATION_BARCODE_PT = {
  width: mmToPt(RN_OPERATION_BARCODE_MM.width),
  height: mmToPt(RN_OPERATION_BARCODE_MM.height),
} as const;

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
      include: {
        operations: { orderBy: [{ operationNumber: "asc" }, { id: "asc" }] },
      },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji.`);

    // Batch-resolve imena (bez required-relation JOIN-a — orphan FK pravilo).
    const [customer, tehnolog, project, opCatalog, handover] = await Promise.all([
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
      // „Predmet" na dokumentu = BROJ predmeta (projects.project_number, npr. 9400 —
      // isti prefiks kao RN broj), a NE interni projects.id (bio je bug 006/26: RN
      // 9400/7/30 je prikazivao 10354). Orphan/legacy (projectId=0 ili obrisan
      // predmet) → null → prazno na dokumentu, nikad ID.
      wo.projectId > 0
        ? this.prisma.project.findUnique({
            where: { id: wo.projectId },
            select: { projectNumber: true },
          })
        : Promise.resolve(null),
      this.resolveWorkCenterNames(wo.operations.map((o) => o.workCenterCode)),
      // HITNO (Miljan t.10): flag sa vezane primopredaje — na dokumentu menja
      // crvenu nalepnicu koja se do sada ručno lepila na odštampani TP.
      wo.drawingHandoverId > 0
        ? this.prisma.drawingHandover.findUnique({
            where: { id: wo.drawingHandoverId },
            select: { isUrgent: true },
          })
        : Promise.resolve(null),
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
          // `height` je samo unutrašnja geometrija (viewBox) — odštampanu visinu
          // određuje `RN_ORDER_BARCODE_PT` zajedno sa `stretch`.
          { height: 11, stretch: true },
        );
      } catch {
        orderBarcodeSvg = null;
      }
    }

    const docDefinition = this.buildDocDefinition({
      wo,
      customerName: customer?.name ?? "",
      tehnologName: tehnolog?.fullName ?? tehnolog?.username ?? "",
      projectNumber: project?.projectNumber ?? "",
      opCatalog,
      withBarcode,
      orderBarcodeSvg,
      isUrgent: handover?.isUrgent === true,
    });

    const buffer = await this.pdf.render(docDefinition);
    const safeIdent = wo.identNumber.replace(/[\\/:*?"<>|]+/g, "-");
    return { buffer, fileName: `RN-${safeIdent}-rev-${wo.revision}.pdf` };
  }

  /** Mapa workCenterCode → workCenterName iz `operations` šifarnika. */
  private async resolveWorkCenterNames(
    codes: string[],
  ): Promise<Map<string, string>> {
    const unique = [
      ...new Set(codes.map((c) => (c ?? "").trim()).filter(Boolean)),
    ];
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
      materialDimension: string;
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
    /** Broj predmeta (projects.project_number) — prazno ako predmet ne postoji. */
    projectNumber: string;
    opCatalog: Map<string, string>;
    withBarcode: boolean;
    orderBarcodeSvg: string | null;
    isUrgent: boolean;
  }): TDocumentDefinitions {
    const {
      wo,
      customerName,
      tehnologName,
      projectNumber,
      opCatalog,
      withBarcode,
      orderBarcodeSvg,
      isUrgent,
    } = args;

    // Zaglavlje (parity sa legacy rRN): logo Servoteha gore-levo, naziv u sredini,
    // RNZ barkod desno.
    const headerColumns: Content = {
      columns: [
        { image: SERVOTEH_LOGO_DATA_URL, width: 128 },
        {
          width: "*",
          margin: [12, 4, 0, 0],
          stack: [
            {
              text: isUrgent
                ? [
                    { text: "RADNI NALOG" },
                    { text: "   HITNO", style: "urgent" },
                  ]
                : "RADNI NALOG",
              style: "title",
            },
            {
              text: `${wo.identNumber}   ·   revizija ${wo.revision}`,
              style: "subtitle",
            },
          ],
        },
        orderBarcodeSvg
          ? {
              svg: orderBarcodeSvg,
              // NE `fit` — `fit` čuva odnos stranica pa visina varira sa dužinom
              // sadržaja. Eksplicitni width+height daju konstantnih 62.65 × 13 mm.
              width: RN_ORDER_BARCODE_PT.width,
              height: RN_ORDER_BARCODE_PT.height,
              alignment: "right",
            }
          : { text: "", width: "auto" },
      ],
      columnGap: 8,
    };

    const infoRow = (
      l1: string,
      v1: string,
      l2: string,
      v2: string,
    ): Content[] => [
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
          infoRow("Komitent", customerName, "Predmet", projectNumber),
          infoRow("Crtež", wo.drawingNumber, "Naziv dela", wo.partName),
          infoRow("Materijal", wo.material, "Dimenzija", wo.materialDimension),
          infoRow(
            "Rok izrade",
            fmtDate(wo.productionDeadline),
            "Planirano",
            `${wo.pieceCount} kom`,
          ),
          infoRow("Tehnolog", tehnologName, "Revizija", wo.revision),
          infoRow("Varijanta", String(wo.variant), "", ""),
        ],
      },
      layout: "lightHorizontalLines",
    };

    const head = [
      "Op.",
      "Radni centar",
      "Opis rada",
      "Tpz",
      "Tk",
      "Alat/pribor",
    ];
    const widths: (string | number)[] = [
      "auto",
      "auto",
      "*",
      "auto",
      "auto",
      "auto",
    ];
    if (withBarcode) {
      head.push("Barkod");
      widths.push(140);
    }
    // Prostor za potpis kontrolora — poslednja kolona, desno od barkoda; jedan
    // potpisni prostor po operaciji (parity sa legacy rRN „Kontrola" kolonom, §4).
    head.push("Kontrola");
    widths.push(92);
    const headerCells: Content[] = head.map((t) => ({ text: t, style: "th" }));

    const bodyRows: Content[][] = wo.operations.map((o) => {
      const rcName = opCatalog.get(o.workCenterCode) ?? "";
      const cells: Content[] = [
        { text: String(o.operationNumber), style: "td" },
        {
          text: [o.workCenterCode, rcName].filter(Boolean).join(" · "),
          style: "td",
        },
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
              { height: 9, stretch: true },
            );
          } catch {
            opSvg = null;
          }
        }
        cells.push(
          opSvg
            ? {
                svg: opSvg,
                // Isto kao u zaglavlju: konstantnih 41.3 × 6.9 mm (legacy mera),
                // bez `fit`, da visina ne varira sa dužinom šifre radnog centra.
                width: RN_OPERATION_BARCODE_PT.width,
                height: RN_OPERATION_BARCODE_PT.height,
              }
            : { text: "—", style: "td" },
        );
      }
      // Prazan prostor — kontrolor overava (potpisuje) svaku operaciju.
      cells.push({ text: "", style: "td" });
      return cells;
    });

    const opsTable: Content = wo.operations.length
      ? {
          table: { headerRows: 1, widths, body: [headerCells, ...bodyRows] },
          // Vertikalni razmak po redu da se S-barkodovi jasno odvoje — operateri
          // su se žalili da su preblizu i da omaše sken (Nenad 15.07).
          layout: {
            hLineWidth: (i: number) => (i <= 1 ? 0.8 : 0.5),
            // Vertikalna linija samo levo od kolone „Kontrola" (poslednja) —
            // vizuelno odvaja potpisni prostor.
            vLineWidth: (i: number) => (i === widths.length - 1 ? 0.5 : 0),
            hLineColor: () => "#cccccc",
            vLineColor: () => "#aaaaaa",
            paddingTop: (i: number) => (i === 0 ? 2 : 7),
            paddingBottom: (i: number) => (i === 0 ? 2 : 7),
            paddingLeft: () => 4,
            paddingRight: () => 4,
          },
        }
      : {
          text: "Nema operacija na ovom nalogu.",
          italics: true,
          margin: [0, 6, 0, 0],
        };

    // Zbir vremena (paritet legacy printa): Σ Tpz (pripremno-završno, jednokratno)
    // + Σ Tk (po komadu) × planirana količina.
    const sumTpz = wo.operations.reduce((s, o) => s + (o.setupTime ?? 0), 0);
    const sumTk = wo.operations.reduce((s, o) => s + (o.cycleTime ?? 0), 0);
    const totalTime = sumTpz + sumTk * wo.pieceCount;
    const totals: Content = wo.operations.length
      ? {
          margin: [0, 10, 0, 0],
          alignment: "right",
          text: [
            { text: "Ukupno vreme  ", bold: true },
            {
              text: `(Σ Tpz ${fmtTot(sumTpz)} + Σ Tk ${fmtTot(sumTk)} × ${
                wo.pieceCount
              } kom)  =  `,
              fontSize: 8,
              color: "#555",
            },
            { text: fmtTot(totalTime), bold: true },
          ],
        }
      : { text: "" };

    return {
      pageSize: "A4",
      pageMargins: [28, 28, 28, 36],
      content: [headerColumns, info, opsTable, totals],
      styles: {
        title: { fontSize: 18, bold: true },
        // Digitalna zamena za crvenu HITNO nalepnicu (Miljan t.10).
        urgent: { fontSize: 18, bold: true, color: "#c00000" },
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

/** Zbir vremena — uvek prikazuje vrednost (i 0), do 4 decimale, zarez. */
function fmtTot(n: number): string {
  const r = Math.round(n * 10000) / 10000;
  return String(r).replace(".", ",");
}

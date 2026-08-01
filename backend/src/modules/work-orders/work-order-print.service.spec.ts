import "reflect-metadata";
import { inflateSync } from "zlib";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { BarcodeService } from "../documents/barcode.service";
import {
  WorkOrderPrintService,
  mmToPt,
  RN_ORDER_BARCODE_MM,
  RN_OPERATION_BARCODE_MM,
} from "./work-order-print.service";

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

/** Operacija RN-a — samo polja koja `buildDocDefinition` cita. */
function makeOp(operationNumber: number, workCenterCode: string) {
  return {
    operationNumber,
    workCenterCode,
    workDescription: "Struganje prema crtezu",
    toolsFixtures: "Stega 3",
    setupTime: 0.5,
    cycleTime: 0.25,
  };
}

/** Tipican nalog iz pogona: 6 operacija (referentni RN 9811-3/77). */
const SIX_OPS = [
  makeOp(10, "8.4"),
  makeOp(20, "8.4"),
  makeOp(30, "5.11"),
  makeOp(40, "8.4"),
  makeOp(50, "5.11"),
  makeOp(60, "8.4"),
];

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

/** Kao `setup()`, ali sa PRAVIM `BarcodeService` + `PdfService` (pravi PDF na izlazu). */
function setupReal(wo: Record<string, unknown>) {
  const prisma = {
    workOrder: { findUnique: jest.fn().mockResolvedValue(wo) },
    customer: {
      findUnique: jest.fn().mockResolvedValue({ name: "ACME d.o.o." }),
    },
    worker: {
      findUnique: jest.fn().mockResolvedValue({ fullName: "Tehnolog Test" }),
    },
    project: {
      findUnique: jest.fn().mockResolvedValue({ projectNumber: "9811" }),
    },
    operation: { findMany: jest.fn().mockResolvedValue([]) },
    drawingHandover: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  return new WorkOrderPrintService(
    prisma as unknown as PrismaService,
    new PdfService(),
    new BarcodeService(),
  );
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
    prisma.workOrder.findUnique.mockResolvedValue(
      makeWo({ projectId: 0, identNumber: "0/1" }),
    );

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

/* -------------------------------------------------------------------------- */
/*  Dimenzije barkoda na RN-u (odluka vlasnika 01.08.2026)                     */
/* -------------------------------------------------------------------------- */

/** SVG cvor iz `docDefinition`-a (samo polja koja proveravamo). */
interface SvgNode {
  svg?: string;
  fit?: number[];
  width?: number;
  height?: number;
  alignment?: string;
}

/** Rekurzivno pokupi sve `svg` cvorove iz docDefinition-a, redom kojim se crtaju. */
function svgNodes(node: unknown, out: SvgNode[] = []): SvgNode[] {
  if (Array.isArray(node)) {
    for (const n of node) svgNodes(n, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const o = node as Record<string, unknown>;
  if (typeof o.svg === "string") out.push(o as SvgNode);
  for (const key of ["content", "columns", "stack", "body", "table"]) {
    if (key in o) svgNodes(o[key], out);
  }
  return out;
}

describe("WorkOrderPrintService — dimenzije barkoda (docDefinition)", () => {
  const ORDER_PT = {
    width: mmToPt(RN_ORDER_BARCODE_MM.width),
    height: mmToPt(RN_ORDER_BARCODE_MM.height),
  };
  const OP_PT = {
    width: mmToPt(RN_OPERATION_BARCODE_MM.width),
    height: mmToPt(RN_OPERATION_BARCODE_MM.height),
  };

  it("cilj je 62.65 x 13 mm (nalog) i 41.3 x 6.9 mm (operacija)", () => {
    expect(RN_ORDER_BARCODE_MM).toEqual({ width: 62.65, height: 13 });
    expect(RN_OPERATION_BARCODE_MM).toEqual({ width: 41.3, height: 6.9 });
    expect(mmToPt(25.4)).toBeCloseTo(72, 10);
  });

  // Kratak vs. dug sadrzaj: geometrija MORA biti identicna. Da se neko vrati na
  // `fit`, visina bi opet zavisila od broja modula i ovi testovi bi pali.
  const payloads: Array<[string, Record<string, unknown>]> = [
    ["kratak ident", { projectId: 100, identNumber: "9400/12", revision: "A" }],
    [
      "dug ident",
      { projectId: 999999, identNumber: "9999-99/9999", revision: "A-1" },
    ],
  ];

  it.each(payloads)(
    "%s: nalog-barkod je fiksnih 62.65 x 13 mm, bez `fit`",
    async (_l, o) => {
      const { service, prisma, pdf } = setup();
      prisma.workOrder.findUnique.mockResolvedValue(
        makeWo({ ...o, operations: SIX_OPS }),
      );
      prisma.project.findUnique.mockResolvedValue({ projectNumber: "9400" });

      await service.buildRnPdf(1);

      const [header] = svgNodes(
        (pdf.render.mock.calls[0][0] as TDocumentDefinitions).content,
      );
      expect(header.fit).toBeUndefined();
      expect(header.width).toBeCloseTo(ORDER_PT.width, 9);
      expect(header.height).toBeCloseTo(ORDER_PT.height, 9);
      expect(header.alignment).toBe("right");
    },
  );

  it.each(payloads)(
    "%s: barkodi operacija su fiksnih 41.3 x 6.9 mm, bez `fit`",
    async (_l, o) => {
      const { service, prisma, pdf } = setup();
      prisma.workOrder.findUnique.mockResolvedValue(
        makeWo({ ...o, operations: SIX_OPS }),
      );
      prisma.project.findUnique.mockResolvedValue({ projectNumber: "9400" });

      await service.buildRnPdf(1);

      const rows = svgNodes(
        (pdf.render.mock.calls[0][0] as TDocumentDefinitions).content,
      ).slice(1);
      expect(rows).toHaveLength(SIX_OPS.length);
      for (const cell of rows) {
        expect(cell.fit).toBeUndefined();
        expect(cell.width).toBeCloseTo(OP_PT.width, 9);
        expect(cell.height).toBeCloseTo(OP_PT.height, 9);
      }
    },
  );

  it("barkod se trazi sa `stretch` (bez toga pdfmake uklapa uz letterbox)", async () => {
    const { service, prisma, barcode } = setup();
    prisma.workOrder.findUnique.mockResolvedValue(
      makeWo({ operations: SIX_OPS }),
    );
    prisma.project.findUnique.mockResolvedValue({ projectNumber: "9400" });

    await service.buildRnPdf(1);

    expect(barcode.code128Svg).toHaveBeenCalledTimes(1 + SIX_OPS.length);
    for (const call of barcode.code128Svg.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ stretch: true }));
    }
  });

  it("varijanta `bez-barkoda` nema nijedan svg cvor (nepromenjeno)", async () => {
    const { service, prisma, pdf, barcode } = setup();
    prisma.workOrder.findUnique.mockResolvedValue(
      makeWo({ operations: SIX_OPS }),
    );
    prisma.project.findUnique.mockResolvedValue({ projectNumber: "9400" });

    await service.buildRnPdf(1, "bez-barkoda");

    expect(
      svgNodes((pdf.render.mock.calls[0][0] as TDocumentDefinitions).content),
    ).toHaveLength(0);
    expect(barcode.code128Svg).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/*  Merenje STVARNOG PDF-a                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Minimalni citac PDF content stream-a — meri gde su crte barkoda STVARNO
 * odstampane. Cvor u `docDefinition`-u nije dovoljan dokaz: ako se izgubi
 * `preserveAspectRatio="none"`, okvir ostaje 62.65 x 13 mm ali se simbol u njemu
 * uklapa uz ocuvanje odnosa stranica (letterbox) i odstampana visina opet pada.
 */
interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
}

function inflateContentStreams(buf: Buffer): string[] {
  const s = buf.toString("latin1");
  const out: string[] = [];
  let idx = 0;
  for (;;) {
    const i = s.indexOf("stream", idx);
    if (i < 0) break;
    let j = i + 6;
    if (s[j] === "\r") j++;
    if (s[j] === "\n") j++;
    const e = s.indexOf("endstream", j);
    if (e < 0) break;
    try {
      const t = inflateSync(buf.subarray(j, e)).toString("latin1");
      if (/\bcm\b/.test(t)) out.push(t);
    } catch {
      /* nije flate tekst (slika/font) */
    }
    idx = e + 9;
  }
  return out;
}

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/** Vertikalne crte (potezi) iz content stream-a, u tackama prostora stranice. */
function strokedBars(content: string): Bar[] {
  const toks =
    content.match(
      /\([^)\\]*\)|<[0-9A-Fa-f\s]*>|\/[^\s/[\]<>()]+|[^\s/[\]<>()]+/g,
    ) ?? [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  let lw = 1;
  const ctmStack: M[] = [];
  const lwStack: number[] = [];
  let ops: number[] = [];
  let sub: Array<[number, number]> = [];
  const paths: Array<Array<[number, number]>> = [];
  const bars: Bar[] = [];
  const stroke = () => {
    for (const p of [...paths, sub]) {
      for (let k = 0; k + 1 < p.length; k++) {
        const [x0, y0] = p[k];
        const [x1, y1] = p[k + 1];
        if (Math.abs(x1 - x0) > 1e-9) continue; // samo vertikalne crte barkoda
        const xs = [x0 - lw / 2, x0 + lw / 2].map((x) => ctm[0] * x + ctm[4]);
        const ys = [Math.min(y0, y1), Math.max(y0, y1)].map(
          (y) => ctm[3] * y + ctm[5],
        );
        bars.push({
          x: Math.min(...xs),
          y: Math.min(...ys),
          w: Math.abs(xs[1] - xs[0]),
          h: Math.abs(ys[1] - ys[0]),
        });
      }
    }
    paths.length = 0;
    sub = [];
  };
  for (const t of toks) {
    const n = Number(t);
    if (t !== "" && Number.isFinite(n)) {
      ops.push(n);
      continue;
    }
    switch (t) {
      case "q":
        ctmStack.push([...ctm] as M);
        lwStack.push(lw);
        break;
      case "Q":
        ctm = ctmStack.pop() ?? ctm;
        lw = lwStack.pop() ?? lw;
        break;
      case "cm":
        if (ops.length >= 6) ctm = mul(ops.slice(-6) as M, ctm);
        break;
      case "w":
        if (ops.length) lw = ops[ops.length - 1];
        break;
      case "m":
        if (sub.length) paths.push(sub);
        sub = [[ops[ops.length - 2], ops[ops.length - 1]]];
        break;
      case "l":
        if (ops.length >= 2)
          sub.push([ops[ops.length - 2], ops[ops.length - 1]]);
        break;
      // bwip-js crta <path stroke=...> bez fill="none" → svg-to-pdfkit zavrsava sa
      // `B` (fill+stroke); za segmente nulte povrsine vidljiv je samo potez.
      case "S":
      case "s":
      case "B":
      case "B*":
      case "b":
      case "b*":
        stroke();
        break;
      case "n":
      case "f":
      case "F":
      case "f*":
        paths.length = 0;
        sub = [];
        break;
      default:
        break;
    }
    ops = [];
  }
  return bars;
}

const pt2mm = (pt: number): number => (pt * 25.4) / 72;

/** Grupise crte po identicnom y-opsegu → jedan barkod po grupi, odozgo nadole. */
function measureBarcodes(buf: Buffer) {
  const bars = inflateContentStreams(buf)
    .flatMap(strokedBars)
    .filter((b) => b.h > 5 && b.w > 0.01 && b.w < 6);
  const groups = new Map<string, Bar[]>();
  for (const b of bars) {
    const key = `${b.y.toFixed(2)}|${b.h.toFixed(2)}`;
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 15) // pojedinacne linije tabele nisu barkod
    .map((g) => ({
      bars: g.length,
      y: g[0].y,
      widthMm: pt2mm(
        Math.max(...g.map((b) => b.x + b.w)) - Math.min(...g.map((b) => b.x)),
      ),
      heightMm: pt2mm(g[0].h),
      moduleMm: pt2mm(Math.min(...g.map((b) => b.w))),
    }))
    .sort((a, b) => b.y - a.y); // stranica ima y nagore → zaglavlje je prvo
}

function pdfPageCount(buf: Buffer): number {
  return (buf.toString("latin1").match(/\/Type\s*\/Page(?![sA-Za-z])/g) ?? [])
    .length;
}

describe("WorkOrderPrintService — izmereno na stvarnom PDF-u", () => {
  jest.setTimeout(60_000);

  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "kratak (244 modula)",
      { projectId: 100, identNumber: "9400/12", revision: "A" },
    ],
    [
      "srednji (288 modula)",
      { projectId: 10354, identNumber: "9811-3/77", revision: "A" },
    ],
    [
      "dug (343 modula)",
      { projectId: 999999, identNumber: "9999-99/9999", revision: "A-1" },
    ],
  ];

  it.each(cases)(
    "%s: zaglavlje 62.65 x 13 mm, operacije 41.3 x 6.9 mm",
    async (_l, o) => {
      const service = setupReal(makeWo({ ...o, operations: SIX_OPS }));
      const { buffer } = await service.buildRnPdf(1);
      const found = measureBarcodes(buffer);

      expect(found).toHaveLength(1 + SIX_OPS.length);
      const [header, ...rows] = found;
      // Tolerancija 0.01 mm — ispod razdvojne moci bilo kog stampaca.
      expect(header.widthMm).toBeCloseTo(RN_ORDER_BARCODE_MM.width, 2);
      expect(header.heightMm).toBeCloseTo(RN_ORDER_BARCODE_MM.height, 2);
      for (const row of rows) {
        expect(row.widthMm).toBeCloseTo(RN_OPERATION_BARCODE_MM.width, 2);
        expect(row.heightMm).toBeCloseTo(RN_OPERATION_BARCODE_MM.height, 2);
      }
      // Tipican nalog (6 operacija) i dalje staje na jednu stranu.
      expect(pdfPageCount(buffer)).toBe(1);
    },
  );

  it("visina NE zavisi od duzine sadrzaja (brana za povratak na `fit`)", async () => {
    const heights: number[] = [];
    for (const [, o] of cases) {
      const service = setupReal(makeWo({ ...o, operations: SIX_OPS }));
      const { buffer } = await service.buildRnPdf(1);
      heights.push(measureBarcodes(buffer)[0].heightMm);
    }
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(0.01);
  });

  it("x-skala je uniformna → odnosi sirina crta (jedino sto skener cita) ostaju", async () => {
    const service = setupReal(
      makeWo({
        projectId: 10354,
        identNumber: "9811-3/77",
        operations: SIX_OPS,
      }),
    );
    const { buffer } = await service.buildRnPdf(1);
    const header = measureBarcodes(buffer)[0];
    // `RNZ:10354:9811-3/77:0:A` = 23 znaka → 11*(1+23+1)+13 = 288 modula.
    // Najuza crta mora biti tacno 1 modul = sirina / 288.
    expect(header.moduleMm).toBeCloseTo(RN_ORDER_BARCODE_MM.width / 288, 3);
  });

  it("varijanta `bez-barkoda` ne crta nijedan barkod", async () => {
    const service = setupReal(makeWo({ operations: SIX_OPS }));
    const { buffer } = await service.buildRnPdf(1, "bez-barkoda");
    expect(measureBarcodes(buffer)).toHaveLength(0);
    expect(pdfPageCount(buffer)).toBe(1);
  });
});

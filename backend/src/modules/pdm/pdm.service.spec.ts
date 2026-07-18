import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { PdmService } from "./pdm.service";

/**
 * PDM BOM — hidracija `hasPdf` po čvoru + zbirni `pdfSummary` (X/Y).
 * Pinuje: (1) svaki čvor stabla i flat reda nosi hasPdf iz JEDNOG batch upita
 * nad drawing_pdfs (obrazac resolvePdfPresence), (2) meta.pdfSummary broji
 * JEDINSTVENE komponentne crteže (total = u šifarniku, withPdf = sa PDF-om),
 * (3) čvor čije dete NIJE u šifarniku → drawing null → hasPdf false, ne ulazi u
 * total. Presence upit se pokreće JEDNOM (batch), ne po čvoru.
 */

// ---- tagged-template ruter za $queryRaw (obrazac iz sy15.service.spec.ts) ----
// PdmService zove $queryRaw DIREKTNO kao tagged template, pa mock dobija
// TemplateStringsArray kao prvi argument (ne Prisma.sql objekat sa .strings).
const sqlText = (strings: TemplateStringsArray): string => strings.join("?");

/** DRAWING_SUMMARY_SELECT oblik — samo polja koja bom() koristi u testu. */
function drawing(id: number, drawingNumber: string, revision = "A") {
  return {
    id,
    drawingNumber,
    revision,
    catalogNumber: null,
    name: `Deo ${drawingNumber}`,
    material: null,
    isProcurement: false,
    weight: null,
    pdmStatus: null,
  };
}

/** Red rekurzivnog CTE (queryDescendants) — bigint total_quantity kao u SQL-u. */
function edge(opts: {
  componentId: number;
  parentId: number;
  childId: number;
  requiredQuantity?: number;
  totalQuantity?: number;
  depth: number;
  path: number[];
  isCycle?: boolean;
}) {
  return {
    component_id: opts.componentId,
    parent_drawing_id: opts.parentId,
    child_drawing_id: opts.childId,
    required_quantity: opts.requiredQuantity ?? 1,
    total_quantity: BigInt(opts.totalQuantity ?? opts.requiredQuantity ?? 1),
    depth: opts.depth,
    path: opts.path,
    is_cycle: opts.isCycle ?? false,
  };
}

/**
 * PrismaService mock. `$queryRaw` rutira po SQL tekstu: recursive CTE
 * (drawing_components) vraća `descendants`, presence upit (drawing_pdfs) vraća
 * `{drawing_number, revision}` parove iz `pdfPairs`. `drawing.findMany` hidrira
 * DRAWING_SUMMARY po id-ju iz `catalog`.
 */
function prismaMock(opts: {
  root?: ReturnType<typeof drawing> | null;
  descendants: ReturnType<typeof edge>[];
  catalog: ReturnType<typeof drawing>[];
  /** (drawing_number, revision) parovi sa uskladištenim PDF-om. */
  pdfPairs: { drawingNumber: string; revision: string }[];
}) {
  const rootDrawing =
    opts.root === undefined ? drawing(1, "1000") : opts.root;
  const catalogById = new Map(opts.catalog.map((d) => [d.id, d]));

  const presenceCalls: string[] = [];
  const descendantsCalls: string[] = [];

  const m = {
    drawing: {
      findUnique: jest.fn().mockResolvedValue(rootDrawing),
      findMany: jest.fn((args: { where: { id: { in: number[] } } }) =>
        Promise.resolve(
          args.where.id.in
            .map((id) => catalogById.get(id))
            .filter((d): d is ReturnType<typeof drawing> => d !== undefined),
        ),
      ),
    },
    drawingComponent: {
      count: jest.fn().mockResolvedValue(0),
    },
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const text = sqlText(strings);
      if (text.includes("drawing_pdfs")) {
        presenceCalls.push(text);
        return Promise.resolve(
          opts.pdfPairs.map((p) => ({
            drawing_number: p.drawingNumber,
            revision: p.revision,
          })),
        );
      }
      // WITH RECURSIVE bom ... drawing_components
      descendantsCalls.push(text);
      return Promise.resolve(opts.descendants);
    }),
  };
  return { m, presenceCalls, descendantsCalls };
}

async function makeService(prisma: unknown): Promise<PdmService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [PdmService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return mod.get(PdmService);
}

describe("PdmService — bom() hasPdf + pdfSummary", () => {
  it("hidrira hasPdf po čvoru (tree + flat) iz JEDNOG batch upita; pdfSummary tačan", async () => {
    // Root 1 → deca: 2 (ima PDF), 3 (ima PDF), 4 (nema PDF); pod 2 → 5 (nema PDF).
    const descendants = [
      edge({ componentId: 10, parentId: 1, childId: 2, depth: 1, path: [1, 2] }),
      edge({ componentId: 11, parentId: 1, childId: 3, depth: 1, path: [1, 3] }),
      edge({ componentId: 12, parentId: 1, childId: 4, depth: 1, path: [1, 4] }),
      edge({
        componentId: 13,
        parentId: 2,
        childId: 5,
        depth: 2,
        path: [1, 2, 5],
      }),
    ];
    const catalog = [
      drawing(2, "C-2"),
      drawing(3, "C-3"),
      drawing(4, "C-4"),
      drawing(5, "C-5"),
    ];
    const { m, presenceCalls } = prismaMock({
      descendants,
      catalog,
      // Samo C-2 i C-3 imaju uskladišten PDF.
      pdfPairs: [
        { drawingNumber: "C-2", revision: "A" },
        { drawingNumber: "C-3", revision: "A" },
      ],
    });
    const service = await makeService(m);

    const res = (await service.bom(1, {})) as {
      data: {
        tree: {
          drawing: { drawingNumber: string } | null;
          hasPdf: boolean;
          children: { drawing: { drawingNumber: string } | null; hasPdf: boolean }[];
        }[];
        flat: { drawing: { drawingNumber: string } | null; hasPdf: boolean }[];
      };
      meta: { pdfSummary: { total: number; withPdf: number } };
    };

    // Presence upit ide TAČNO JEDNOM (batch), ne po čvoru.
    expect(presenceCalls.length).toBe(1);

    // Stablo: hasPdf po neposrednoj deci + po ugnježdenom čvoru.
    const byNumber = new Map(
      res.data.tree.map((n) => [n.drawing?.drawingNumber, n]),
    );
    expect(byNumber.get("C-2")!.hasPdf).toBe(true);
    expect(byNumber.get("C-3")!.hasPdf).toBe(true);
    expect(byNumber.get("C-4")!.hasPdf).toBe(false);
    const nested = byNumber.get("C-2")!.children[0];
    expect(nested.drawing?.drawingNumber).toBe("C-5");
    expect(nested.hasPdf).toBe(false);

    // Flat: isti hasPdf po jedinstvenom crtežu.
    const flatByNumber = new Map(
      res.data.flat.map((f) => [f.drawing?.drawingNumber, f.hasPdf]),
    );
    expect(flatByNumber.get("C-2")).toBe(true);
    expect(flatByNumber.get("C-3")).toBe(true);
    expect(flatByNumber.get("C-4")).toBe(false);
    expect(flatByNumber.get("C-5")).toBe(false);

    // Zbirno: 4 jedinstvena komponentna crteža u šifarniku, 2 sa PDF-om.
    expect(res.meta.pdfSummary).toEqual({ total: 4, withPdf: 2 });
  });

  it("čvor čije dete NIJE u šifarniku → drawing null, hasPdf false, van pdfSummary.total", async () => {
    // Root 1 → 2 (ima PDF) i 999 (van šifarnika → badge, drawing null).
    const descendants = [
      edge({ componentId: 20, parentId: 1, childId: 2, depth: 1, path: [1, 2] }),
      edge({
        componentId: 21,
        parentId: 1,
        childId: 999,
        depth: 1,
        path: [1, 999],
      }),
    ];
    const { m } = prismaMock({
      descendants,
      catalog: [drawing(2, "C-2")], // 999 se NE razrešava
      pdfPairs: [{ drawingNumber: "C-2", revision: "A" }],
    });
    const service = await makeService(m);

    const res = (await service.bom(1, {})) as {
      data: {
        tree: { drawing: unknown | null; hasPdf: boolean }[];
        flat: { drawing: unknown | null; hasPdf: boolean }[];
      };
      meta: { pdfSummary: { total: number; withPdf: number } };
    };

    const orphan = res.data.tree.find((n) => n.drawing === null)!;
    expect(orphan).toBeDefined();
    expect(orphan.hasPdf).toBe(false);

    // pdfSummary broji SAMO crteže u šifarniku: total 1 (C-2), withPdf 1.
    expect(res.meta.pdfSummary).toEqual({ total: 1, withPdf: 1 });
  });

  it("nijedan komponentni crtež nema PDF → pdfSummary.withPdf 0, svi čvorovi hasPdf false", async () => {
    const descendants = [
      edge({ componentId: 30, parentId: 1, childId: 2, depth: 1, path: [1, 2] }),
      edge({ componentId: 31, parentId: 1, childId: 3, depth: 1, path: [1, 3] }),
    ];
    const { m } = prismaMock({
      descendants,
      catalog: [drawing(2, "C-2"), drawing(3, "C-3")],
      pdfPairs: [], // nijedan PDF
    });
    const service = await makeService(m);

    const res = (await service.bom(1, {})) as {
      data: { tree: { hasPdf: boolean }[]; flat: { hasPdf: boolean }[] };
      meta: { pdfSummary: { total: number; withPdf: number } };
    };

    expect(res.data.tree.every((n) => n.hasPdf === false)).toBe(true);
    expect(res.data.flat.every((f) => f.hasPdf === false)).toBe(true);
    expect(res.meta.pdfSummary).toEqual({ total: 2, withPdf: 0 });
  });

  it("prazna sastavnica → pdfSummary {0,0}, presence upit se preskače (nema crteža)", async () => {
    const { m, presenceCalls } = prismaMock({
      descendants: [],
      catalog: [],
      pdfPairs: [],
    });
    const service = await makeService(m);

    const res = (await service.bom(1, {})) as {
      data: { tree: unknown[]; flat: unknown[] };
      meta: { pdfSummary: { total: number; withPdf: number } };
    };

    expect(res.data.flat).toEqual([]);
    expect(res.meta.pdfSummary).toEqual({ total: 0, withPdf: 0 });
    // resolvePdfPresence rano izlazi na praznom skupu → nula raw upita.
    expect(presenceCalls.length).toBe(0);
  });

  it("expandAll=true → tree null, ali flat i dalje nosi hasPdf + pdfSummary", async () => {
    const descendants = [
      edge({ componentId: 40, parentId: 1, childId: 2, depth: 1, path: [1, 2] }),
    ];
    const { m } = prismaMock({
      descendants,
      catalog: [drawing(2, "C-2")],
      pdfPairs: [{ drawingNumber: "C-2", revision: "A" }],
    });
    const service = await makeService(m);

    const res = (await service.bom(1, { expandAll: "true" })) as {
      data: { tree: unknown | null; flat: { hasPdf: boolean }[] };
      meta: { expandAll: boolean; pdfSummary: { total: number; withPdf: number } };
    };

    expect(res.data.tree).toBeNull();
    expect(res.meta.expandAll).toBe(true);
    expect(res.data.flat[0].hasPdf).toBe(true);
    expect(res.meta.pdfSummary).toEqual({ total: 1, withPdf: 1 });
  });

  it("crtež ne postoji → 404 (findUnique null)", async () => {
    const { m } = prismaMock({
      root: null,
      descendants: [],
      catalog: [],
      pdfPairs: [],
    });
    const service = await makeService(m);

    await expect(service.bom(1, {})).rejects.toThrow(NotFoundException);
  });
});

/**
 * PDM listDrawings — RN filter (R1). Pinuje: (1) `rn` (ili `hasPdf`) rutira na
 * raw putanju (listDrawingsRaw) sa EXISTS nad work_orders po pravilu poklapanja
 * crtež↔RN + legacy fallback work_order_ref; obična Prisma `$transaction`
 * putanja se NE koristi. (2) resolveWorkOrderRefs grupiše RN-ove po crtežu po
 * ISTOM pravilu (id-match ILI lower(number)-match, sve revizije), dedupe po
 * identNumber (varijante dele broj), attach do 5 + workOrderCount.
 */

// Prisma.sql interpolira ugnježdene fragmente kao VALUES (ne u `.strings`), pa
// za asertacije na WHERE moramo rekonstruisati pun tekst (statika + vrednosti).
function flattenSql(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "strings" in value &&
    "values" in value
  ) {
    const v = value as { strings: string[]; values: unknown[] };
    let out = "";
    v.strings.forEach((s, i) => {
      out += s;
      if (i < v.values.length) out += flattenSql(v.values[i]);
    });
    return out;
  }
  return "";
}

function fullSql(strings: TemplateStringsArray, values: unknown[]): string {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += flattenSql(values[i]);
  });
  return out;
}

/** DRAWING_LIST_SELECT oblik za hidraciju liste (samo polja koja listDrawings dira). */
function listRow(id: number, drawingNumber: string, revision = "A") {
  return {
    id,
    drawingNumber,
    revision,
    catalogNumber: `KAT-${id}`,
    name: `Crtež ${drawingNumber}`,
    material: null,
    dimensions: null,
    weight: null,
    marking: "",
    isProcurement: false,
    pdmStatus: "",
    statusId: 0,
    designedBy: null,
    designDate: null,
    approvedBy: null,
    approvedDate: null,
    fileName: null,
    projectName: null,
    workOrderRef: null,
    createdAt: null,
  };
}

/** WorkOrder red (select iz resolveWorkOrderRefs). */
function wo(opts: {
  id: number;
  identNumber: string;
  variant?: number;
  drawingId?: number;
  drawingNumber?: string;
}) {
  return {
    id: opts.id,
    identNumber: opts.identNumber,
    variant: opts.variant ?? 0,
    drawingId: opts.drawingId ?? 0,
    drawingNumber: opts.drawingNumber ?? "",
  };
}

/**
 * PrismaService mock za listDrawings raw putanju. `$queryRaw` rutira po
 * rekonstruisanom tekstu: drawing_pdfs → pdfPairs; COUNT(*) → total; ostalo →
 * idRows (stranica). `drawing.findMany` hidrira po id-ju; `workOrder.findMany`
 * vraća `workOrders` (i beleži args radi asertacije OR grana).
 */
function listPrismaMock(opts: {
  idRows: { id: number }[];
  count: number;
  hydrate: ReturnType<typeof listRow>[];
  workOrders: ReturnType<typeof wo>[];
  pdfPairs?: { drawingNumber: string; revision: string }[];
}) {
  const rawSqls: string[] = [];
  let transactionCalled = false;
  let woArgs: { where?: { OR?: unknown[] } } | null = null;
  const byRowId = new Map(opts.hydrate.map((r) => [r.id, r]));

  const m = {
    $transaction: jest.fn(() => {
      transactionCalled = true;
      return Promise.resolve([[], 0]);
    }),
    drawing: {
      findMany: jest.fn((args: { where: { id: { in: number[] } } }) =>
        Promise.resolve(
          args.where.id.in
            .map((id) => byRowId.get(id))
            .filter((r): r is ReturnType<typeof listRow> => r !== undefined),
        ),
      ),
      count: jest.fn().mockResolvedValue(opts.count),
    },
    drawingStatus: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    workOrder: {
      findMany: jest.fn((args: { where?: { OR?: unknown[] } }) => {
        woArgs = args;
        return Promise.resolve(opts.workOrders);
      }),
    },
    $queryRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = fullSql(strings, values);
        rawSqls.push(text);
        if (text.includes("FROM drawing_pdfs")) {
          return Promise.resolve(
            (opts.pdfPairs ?? []).map((p) => ({
              drawing_number: p.drawingNumber,
              revision: p.revision,
            })),
          );
        }
        if (text.includes("COUNT(*)")) {
          return Promise.resolve([{ count: BigInt(opts.count) }]);
        }
        return Promise.resolve(opts.idRows);
      },
    ),
  };
  return {
    m,
    rawSqls,
    getWoArgs: () => woArgs,
    wasTransactionCalled: () => transactionCalled,
  };
}

type ListData = {
  data: {
    id: number;
    workOrders: { id: number; identNumber: string }[];
    workOrderCount: number;
  }[];
};

describe("PdmService — listDrawings RN filter (R1)", () => {
  it("rn → raw putanja sa EXISTS nad work_orders; ne koristi Prisma $transaction", async () => {
    const { m, rawSqls, wasTransactionCalled } = listPrismaMock({
      idRows: [{ id: 1 }],
      count: 1,
      hydrate: [listRow(1, "9400")],
      workOrders: [wo({ id: 100, identNumber: "9400/3", drawingId: 1 })],
    });
    const service = await makeService(m);

    await service.listDrawings({ rn: "9400/3" });

    // Obična (nefiltrirana) Prisma putanja NIJE korišćena.
    expect(wasTransactionCalled()).toBe(false);

    // Neki raw upit nosi EXISTS nad work_orders sa pravilom poklapanja + ILIKE
    // po ident_number, plus legacy fallback work_order_ref.
    const joined = rawSqls.join("\n---\n");
    expect(joined).toContain("work_orders");
    expect(joined).toContain(
      "w.drawing_id = d.id OR lower(w.drawing_number) = lower(d.drawing_number)",
    );
    expect(joined).toContain("ident_number ILIKE");
    expect(joined).toContain("work_order_ref ILIKE");
  });

  it("resolver: id-match + number-match (sve revizije, case-insensitive) + varijanta dedupe", async () => {
    // Stranica: dva crteža istog broja (razne revizije) + jedan K-crtež.
    const hydrate = [
      listRow(1, "9400", "A"),
      listRow(2, "9400", "B"),
      listRow(3, "K500", "A"),
    ];
    const { m, getWoArgs } = listPrismaMock({
      idRows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      count: 3,
      hydrate,
      // orderBy id desc (kao pravi upit): najviši id prvi.
      workOrders: [
        // id-match SAMO (broj se razlikuje) → dokazuje granu drawing_id.
        wo({
          id: 300,
          identNumber: "OTHER/1",
          drawingId: 1,
          drawingNumber: "ZZZ",
        }),
        // number-match (dorada dete -D) → broj "9400".
        wo({
          id: 102,
          identNumber: "9400/3-D",
          drawingId: 0,
          drawingNumber: "9400",
        }),
        // varijanta (isti identNumber "9400/3") → number-match.
        wo({
          id: 101,
          identNumber: "9400/3",
          variant: 1,
          drawingId: 0,
          drawingNumber: "9400",
        }),
        // id-match (drawingId 1) I number-match — isti identNumber kao gore.
        wo({
          id: 100,
          identNumber: "9400/3",
          variant: 0,
          drawingId: 1,
          drawingNumber: "9400",
        }),
        // K-crtež: id-match (3) + number-match case-insensitive ("k500" vs "K500").
        wo({
          id: 200,
          identNumber: "K500/1",
          drawingId: 3,
          drawingNumber: "k500",
        }),
      ],
    });
    const service = await makeService(m);

    const res = (await service.listDrawings({ rn: "x" })) as ListData;
    const byId = new Map(res.data.map((r) => [r.id, r]));

    // Upit ka work_orders ima OBE grane (drawingId IN + drawingNumber IN insensitive).
    const orArr = getWoArgs()?.where?.OR ?? [];
    expect(orArr.length).toBe(2);

    // D1 (id 1, broj 9400): id-match (OTHER/1 preko drawingId=1, 9400/3 preko
    // drawingId=1) + number-match (9400/3-D). Varijanta 9400/3 se dedupe-uje na 1.
    const d1 = byId.get(1)!;
    const d1Idents = d1.workOrders.map((w) => w.identNumber).sort();
    expect(d1Idents).toEqual(["9400/3", "9400/3-D", "OTHER/1"]);
    expect(d1.workOrderCount).toBe(3);
    // Dedupe: tačno jedan unos za "9400/3" iako postoje dve varijante.
    expect(
      d1.workOrders.filter((w) => w.identNumber === "9400/3"),
    ).toHaveLength(1);

    // D2 (id 2, broj 9400): SAMO number-match (drugačija revizija istog broja) —
    // OTHER/1 (id-match na D1) se NE prenosi ovamo.
    const d2 = byId.get(2)!;
    expect(d2.workOrders.map((w) => w.identNumber).sort()).toEqual([
      "9400/3",
      "9400/3-D",
    ]);
    expect(d2.workOrderCount).toBe(2);

    // D3 (id 3, broj K500): id-match + case-insensitive number-match.
    const d3 = byId.get(3)!;
    expect(d3.workOrders.map((w) => w.identNumber)).toEqual(["K500/1"]);
    expect(d3.workOrderCount).toBe(1);
  });

  it("cap 5: workOrders odsečen na 5, workOrderCount = ukupan broj distinct RN-ova", async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      wo({
        id: 500 + i,
        identNumber: `RN/${i}`,
        drawingId: 1,
        drawingNumber: "9400",
      }),
    );
    const { m } = listPrismaMock({
      idRows: [{ id: 1 }],
      count: 1,
      hydrate: [listRow(1, "9400")],
      workOrders: many,
    });
    const service = await makeService(m);

    const res = (await service.listDrawings({ rn: "RN" })) as ListData;
    const row = res.data[0];
    expect(row.workOrders).toHaveLength(5);
    expect(row.workOrderCount).toBe(7);
  });
});

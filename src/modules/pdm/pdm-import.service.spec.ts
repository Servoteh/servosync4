import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  parsePdfFileName,
  PdmImportService,
  type UploadedMultipartFile,
} from "./pdm-import.service";
import { XML_STRUCTURE_ERROR } from "./pdm-xml-parser";

const user: AuthUser = {
  userId: 1,
  email: "sef@servoteh.com",
  role: "sef",
  workerId: null,
};

// ---- tipovi argumenata mock poziva (obrazac iz print-bundle.service.spec.ts) ----

interface UniqueDrawingWhere {
  drawingNumber_revision: { drawingNumber: string; revision: string };
}

interface DrawingRowData {
  drawingNumber: string;
  revision: string;
  createdAt?: Date;
  signature: string;
  statusId: number;
  externalId: string;
  isProcurement: boolean;
  name: string;
}

interface DrawingCreateArg {
  data: DrawingRowData;
}

interface DrawingUpdateArg {
  where: { id: number };
  data: DrawingRowData;
}

interface DrawingPdfUpsertArg {
  where: UniqueDrawingWhere;
  create: { pdfBinary: Uint8Array; uploadedBy: string };
  update: { pdfBinary: Uint8Array };
}

interface LogCreateArg {
  data: {
    fileName: string;
    filePath: string;
    success: boolean;
    statusMessage: string;
    isCritical: boolean;
  };
}

/** Podaci POSLEDNJEG upisa u drawing_import_log. */
function lastLogData(prisma: ReturnType<typeof prismaMock>) {
  const calls = prisma.drawingImportLog.create.mock.calls as [LogCreateArg][];
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].data;
}

/** Minimalan validan <document> (isti oblik kao u parser spec-u). */
function docXml(
  id: string,
  opts: {
    rev?: string;
    oznaka?: string;
    state?: string;
    rc?: string;
    weight?: string;
  } = {},
  refs = "",
): string {
  const attrs: Record<string, string> = {
    Revision: opts.rev ?? "A",
    Oznaka: opts.oznaka ?? id,
    State: opts.state ?? "Odobreno",
    "Reference Count": opts.rc ?? "1.000000",
    Weight: opts.weight ?? "1.00",
    Naziv: `Deo ${id}`,
  };
  const attrXml = Object.entries(attrs)
    .map(([name, value]) => `<attribute name="${name}" value="${value}"/>`)
    .join("");
  const refsXml = refs ? `<references>${refs}</references>` : "";
  return (
    `<document id="${id}" pdmweid="9${id.replace(/\D/g, "")}">` +
    `<configuration name="Default" quantity="1">${attrXml}${refsXml}` +
    `</configuration></document>`
  );
}

function fileXml(docs: string): string {
  return (
    `<xml><transactions><transaction date="1783676510" ` +
    `type="wf_export_document_attributes" vaultname="Servoteh">${docs}` +
    `</transaction></transactions></xml>`
  );
}

function makeFile(
  content: string | Buffer,
  originalname = "1000_B.xml",
): UploadedMultipartFile {
  const buffer =
    typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return {
    originalname,
    mimetype: "application/octet-stream",
    size: buffer.length,
    buffer,
  };
}

/**
 * Mock PrismaService: `$transaction(cb)` prosleđuje ISTI mock kao `tx`
 * (obrazac iz handovers.service.spec.ts); `drawing.create` deli
 * autoinkrement od 1000.
 */
function prismaMock() {
  let nextId = 1000;
  const m = {
    drawing: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation(() => Promise.resolve({ id: nextId++ })),
      update: jest.fn().mockResolvedValue({}),
    },
    drawingComponent: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    drawingAssembly: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    drawingImportLog: {
      create: jest.fn().mockResolvedValue({ id: 42 }),
    },
    drawingPdf: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    // alignIdSequence (setval poravnanje pre nativnih insert-a) ide kroz raw SQL.
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  m.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: unknown) => unknown)(m),
  );
  return m;
}

describe("PdmImportService — XML", () => {
  let service: PdmImportService;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PdmImportService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(PdmImportService);
  });

  it("bez fajla → 400", async () => {
    await expect(service.importXml(undefined, undefined, user)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("root (broj, revizija) već postoji → CEO FAJL SKIP, uspešan ne-kritičan log", async () => {
    prisma.drawing.findUnique.mockResolvedValueOnce({ id: 7 }); // root pre-check
    const xml = fileXml(docXml("1000", { rev: "B" }, docXml("200")));

    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.success).toBe(true);
    expect(res.data.statusMessage).toBe("Crtež već postoji — fajl preskočen");
    expect(res.data.stats.skippedExisting).toBe(true);
    expect(res.data.stats.drawingsSkipped).toBe(2);
    expect(res.data.importId).toBe(42);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(lastLogData(prisma)).toMatchObject({
      success: true,
      isCritical: false,
    });
  });

  it("novi crteži: create sa createdAt, NABAVKA flag po Oznaci, BOM ivice iz fajla", async () => {
    // Root 1000 (cifre → nije nabavka) sa decom K1 (slovo → nabavka, rc 2.4→2) i 200.
    const xml = fileXml(
      docXml(
        "1000",
        { rev: "B" },
        docXml("K1", { rc: "2.400000" }) + docXml("200"),
      ),
    );

    const res = await service.importXml(
      makeFile(xml),
      "\\\\pdm\\export\\1000_B.xml",
      user,
    );

    expect(res.data.success).toBe(true);
    expect(res.data.stats).toMatchObject({
      documentsInFile: 3,
      drawingsCreated: 3,
      drawingsUpdated: 0,
      bomEdgesCreated: 2,
      skippedExisting: false,
    });

    // Create podaci: createdAt postavljen, signature = email, statusId 0.
    const createCalls = (
      prisma.drawing.create.mock.calls as [DrawingCreateArg][]
    ).map((c) => c[0].data);
    const rootData = createCalls.find((d) => d.drawingNumber === "1000")!;
    expect(rootData.createdAt).toBeInstanceOf(Date);
    expect(rootData.signature).toBe("sef@servoteh.com");
    expect(rootData.statusId).toBe(0);
    expect(rootData.revision).toBe("B");
    expect(rootData.externalId).toBe("91000");
    expect(rootData.isProcurement).toBe(false); // "1000" = samo cifre
    const k1Data = createCalls.find((d) => d.drawingNumber === "K1")!;
    expect(k1Data.isProcurement).toBe(true); // slovo u oznaci
    expect(k1Data.name).toBe("Deo K1");

    // §6.6: delete SAMO za roditelje iz fajla (root, id 1000 iz mock niza).
    expect(prisma.drawingComponent.deleteMany).toHaveBeenCalledWith({
      where: { parentDrawingId: { in: [1000] } },
    });
    // Ivice: (root→K1, qty 2), (root→200, qty 1).
    expect(prisma.drawingComponent.createMany).toHaveBeenCalledWith({
      data: [
        { parentDrawingId: 1000, childDrawingId: 1001, requiredQuantity: 2 },
        { parentDrawingId: 1000, childDrawingId: 1002, requiredQuantity: 1 },
      ],
    });

    // Log: filePath = sourcePath od bridge-a.
    expect(lastLogData(prisma)).toMatchObject({
      filePath: "\\\\pdm\\export\\1000_B.xml",
      success: true,
      isCritical: false,
    });
  });

  it("ponovljeno podstablo pod više roditelja → JEDNA ivica po (parent, child, rev)", async () => {
    // Kao u stvarnom fajlu (K16725): sklop 300 sa detetom 400 se javlja i
    // pod root-om i pod 500 — ivica 300→400 se upisuje samo jednom.
    const sub = (rc: string) => docXml("300", { rc }, docXml("400"));
    const xml = fileXml(
      docXml("100", {}, sub("1.000000") + docXml("500", {}, sub("3.000000"))),
    );

    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.stats.documentsInFile).toBe(6);
    expect(res.data.stats.drawingsCreated).toBe(4); // 100, 300, 400, 500
    expect(res.data.stats.bomEdgesCreated).toBe(4);
    expect(res.data.stats.errors).toEqual([]);
    // ids po redosledu kreiranja: 100→1000, 300→1001, 400→1002, 500→1003.
    expect(prisma.drawingComponent.createMany).toHaveBeenCalledWith({
      data: [
        { parentDrawingId: 1000, childDrawingId: 1001, requiredQuantity: 1 },
        { parentDrawingId: 1001, childDrawingId: 1002, requiredQuantity: 1 },
        { parentDrawingId: 1000, childDrawingId: 1003, requiredQuantity: 1 },
        { parentDrawingId: 1003, childDrawingId: 1001, requiredQuantity: 3 },
      ],
    });
  });

  it("§6.6: postojeći crtež → UPDATE bez createdAt + recreate komponenti", async () => {
    // Root 1000 rev B je NOV (root pre-check null); dete 200 rev A POSTOJI (id 12).
    prisma.drawing.findUnique.mockImplementation(
      (args: { where: Partial<UniqueDrawingWhere> }) => {
        const key = args.where.drawingNumber_revision;
        if (key?.drawingNumber === "200" && key?.revision === "A")
          return Promise.resolve({ id: 12 });
        return Promise.resolve(null);
      },
    );
    const xml = fileXml(docXml("1000", { rev: "B" }, docXml("200")));

    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.stats).toMatchObject({
      drawingsCreated: 1,
      drawingsUpdated: 1,
      bomEdgesCreated: 1,
    });
    expect(prisma.drawing.update).toHaveBeenCalledTimes(1);
    const updateArg = (
      prisma.drawing.update.mock.calls as [DrawingUpdateArg][]
    )[0][0];
    expect(updateArg.where).toEqual({ id: 12 });
    expect(updateArg.data).not.toHaveProperty("createdAt"); // original ostaje
    expect(updateArg.data.signature).toBe("sef@servoteh.com");

    // Ivica pokazuje na POSTOJEĆI id deteta.
    expect(prisma.drawingComponent.createMany).toHaveBeenCalledWith({
      data: [
        { parentDrawingId: 1000, childDrawingId: 12, requiredQuantity: 1 },
      ],
    });
    // Log: bez sourcePath → upload:{email}.
    expect(lastLogData(prisma)).toMatchObject({
      filePath: "upload:sef@servoteh.com",
    });
  });

  it("relink starih revizija: UPDATE ivice na novi id, DELETE kad par već postoji", async () => {
    // Stara revizija root-a: (1000, A) sa id 77; nova (1000, B) se kreira.
    prisma.drawing.findMany.mockImplementation(
      (args: { where: { drawingNumber?: string } }) =>
        args.where.drawingNumber === "1000"
          ? Promise.resolve([{ id: 77, revision: "A" }])
          : Promise.resolve([]),
    );
    // Dve ivice van ovog fajla pokazuju na staru reviziju.
    prisma.drawingComponent.findMany.mockResolvedValue([
      { id: 5, parentDrawingId: 99 },
      { id: 6, parentDrawingId: 88 },
    ]);
    // Za parent 88 par (88, noviId) VEĆ postoji → DELETE; za 99 ne → UPDATE.
    prisma.drawingComponent.findFirst.mockImplementation(
      (args: { where: { parentDrawingId?: number } }) =>
        args.where.parentDrawingId === 88
          ? Promise.resolve({ id: 61 })
          : Promise.resolve(null),
    );

    const xml = fileXml(docXml("1000", { rev: "B" }));
    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.stats.oldRevisionRelinks).toBe(2);
    expect(prisma.drawingComponent.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { childDrawingId: 1000 },
    });
    expect(prisma.drawingComponent.delete).toHaveBeenCalledWith({
      where: { id: 6 },
    });
  });

  it("prazna revizija u BAZI se poredi normalizovano ('' == 'A' → NIJE stara revizija)", async () => {
    // U bazi (1000, "") — normalizovano "A" == nova revizija "A" → nema relinka.
    prisma.drawing.findMany.mockResolvedValue([{ id: 77, revision: "" }]);
    const xml = fileXml(docXml("1000", { rev: "" }));

    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.stats.oldRevisionRelinks).toBe(0);
    expect(prisma.drawingComponent.findMany).not.toHaveBeenCalled();
  });

  it("nova najviša revizija → relink i drawing_components i drawing_assemblies na novi id (sklop netaknut)", async () => {
    // Stara revizija (1000, A) id 77; uvozi se viša (1000, B), kreira id 1000.
    prisma.drawing.findMany.mockImplementation(
      (args: { where: { drawingNumber?: string } }) =>
        args.where.drawingNumber === "1000"
          ? Promise.resolve([{ id: 77, revision: "A" }])
          : Promise.resolve([]),
    );
    // Po jedna stara veza u svakoj tabeli, bez postojećeg dupla (findFirst null).
    prisma.drawingComponent.findMany.mockResolvedValue([
      { id: 5, parentDrawingId: 99 },
    ]);
    prisma.drawingAssembly.findMany.mockResolvedValue([
      { id: 8, parentDrawingId: 70 },
    ]);

    const xml = fileXml(docXml("1000", { rev: "B" }));
    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.stats.oldRevisionRelinks).toBe(2); // 1 komponenta + 1 sklop
    // childDrawingId → novi id; parentDrawingId (revizija sklopa) se NE dira.
    expect(prisma.drawingComponent.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { childDrawingId: 1000 },
    });
    expect(prisma.drawingAssembly.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { childDrawingId: 1000 },
    });
    expect(prisma.drawingAssembly.delete).not.toHaveBeenCalled();
  });

  it("uvezena revizija NIJE najviša (stigla starija) → ništa se ne preusmerava", async () => {
    // U bazi postoji viša (1000, B) id 77; uvozi se starija (1000, A).
    prisma.drawing.findMany.mockImplementation(
      (args: { where: { drawingNumber?: string } }) =>
        args.where.drawingNumber === "1000"
          ? Promise.resolve([{ id: 77, revision: "B" }])
          : Promise.resolve([]),
    );

    const xml = fileXml(docXml("1000", { rev: "A" }));
    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.stats.oldRevisionRelinks).toBe(0);
    expect(prisma.drawingComponent.findMany).not.toHaveBeenCalled();
    expect(prisma.drawingAssembly.findMany).not.toHaveBeenCalled();
  });

  it("crtež bez starijih revizija → ništa se ne preusmerava", async () => {
    // drawing.findMany default vraća [] → nema drugih revizija tog broja.
    const xml = fileXml(docXml("1000", { rev: "B" }));
    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.stats.oldRevisionRelinks).toBe(0);
    expect(prisma.drawingComponent.findMany).not.toHaveBeenCalled();
    expect(prisma.drawingAssembly.findMany).not.toHaveBeenCalled();
  });

  it("dupli-guard za drawing_assemblies: UPDATE kad par ne postoji, DELETE kad već postoji", async () => {
    prisma.drawing.findMany.mockImplementation(
      (args: { where: { drawingNumber?: string } }) =>
        args.where.drawingNumber === "1000"
          ? Promise.resolve([{ id: 77, revision: "A" }])
          : Promise.resolve([]),
    );
    // Dva stara sklopa: parent 70 (bez dupla → UPDATE), parent 71 (par postoji → DELETE).
    prisma.drawingAssembly.findMany.mockResolvedValue([
      { id: 8, parentDrawingId: 70 },
      { id: 9, parentDrawingId: 71 },
    ]);
    prisma.drawingAssembly.findFirst.mockImplementation(
      (args: { where: { parentDrawingId?: number } }) =>
        args.where.parentDrawingId === 71
          ? Promise.resolve({ id: 61 })
          : Promise.resolve(null),
    );

    const xml = fileXml(docXml("1000", { rev: "B" }));
    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.stats.oldRevisionRelinks).toBe(2);
    expect(prisma.drawingAssembly.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { childDrawingId: 1000 },
    });
    expect(prisma.drawingAssembly.delete).toHaveBeenCalledWith({
      where: { id: 9 },
    });
  });

  it("validaciona greška → SVE-ILI-NIŠTA: kritičan log, bez upisa, HTTP 200 + success:false", async () => {
    const xml = fileXml(docXml("1000", { oznaka: " " }, docXml("200")));

    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.success).toBe(false);
    expect(res.data.statusMessage).toContain("Oznaka");
    expect(res.data.stats.errors.length).toBeGreaterThan(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.drawing.create).not.toHaveBeenCalled();
    expect(lastLogData(prisma)).toMatchObject({
      success: false,
      isCritical: true,
    });
  });

  it("nevalidan XML → legacy poruka + kritičan log", async () => {
    const res = await service.importXml(
      makeFile("ovo nije xml <"),
      undefined,
      user,
    );

    expect(res.data.success).toBe(false);
    expect(res.data.statusMessage).toBe(XML_STRUCTURE_ERROR);
    expect(lastLogData(prisma)).toMatchObject({
      statusMessage: XML_STRUCTURE_ERROR,
      success: false,
      isCritical: true,
    });
  });

  it("neočekivana DB greška → log + rethrow (500), log ide VAN transakcije", async () => {
    prisma.drawing.create.mockRejectedValue(new Error("DB down"));
    const xml = fileXml(docXml("1000", { rev: "B" }));

    await expect(
      service.importXml(makeFile(xml), undefined, user),
    ).rejects.toThrow("DB down");
    expect(lastLogData(prisma)).toMatchObject({
      success: false,
      isCritical: true,
    });
  });

  it("konkurentan uvoz istog fajla (P2002 u transakciji) → poslovni skip, ne 500", async () => {
    // Root dedup je VAN transakcije: paralelni uvoz je već upisao (broj, rev),
    // pa create pada na uq constraint — očekivan poslovni ishod, ne kritičan log.
    prisma.drawing.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`drawing_number`,`revision`)",
        { code: "P2002", clientVersion: "6" },
      ),
    );
    const xml = fileXml(docXml("1000", { rev: "B" }));

    const res = await service.importXml(makeFile(xml), undefined, user);

    expect(res.data.success).toBe(true);
    expect(res.data.statusMessage).toContain("već postoji");
    expect(res.data.stats.skippedExisting).toBe(true);
    expect(lastLogData(prisma)).toMatchObject({
      success: true,
      isCritical: false,
    });
  });
});

describe("parsePdfFileName", () => {
  it("{Broj}_{Rev}.pdf → (broj, rev) za sufiks 1–3 znaka", () => {
    expect(parsePdfFileName("1126982_B.pdf")).toEqual({
      drawingNumber: "1126982",
      revision: "B",
    });
    expect(parsePdfFileName("K00693_A2.PDF")).toEqual({
      drawingNumber: "K00693",
      revision: "A2",
    });
  });

  it("{Broj}.pdf → revizija 'A'", () => {
    expect(parsePdfFileName("1126982.pdf")).toEqual({
      drawingNumber: "1126982",
      revision: "A",
    });
  });

  it("sufiks duži od 3 znaka NIJE revizija — ceo naziv je broj", () => {
    expect(parsePdfFileName("ABC_LONG.pdf")).toEqual({
      drawingNumber: "ABC_LONG",
      revision: "A",
    });
  });

  it("podvlaka na početku ne seče prazan broj", () => {
    expect(parsePdfFileName("_B.pdf")).toEqual({
      drawingNumber: "_B",
      revision: "A",
    });
  });
});

describe("PdmImportService — PDF", () => {
  let service: PdmImportService;
  let prisma: ReturnType<typeof prismaMock>;

  const pdfBuffer = Buffer.concat([
    Buffer.from("%PDF-1.4\n"),
    Buffer.alloc(3000, 1),
  ]);

  beforeEach(async () => {
    prisma = prismaMock();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        PdmImportService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = mod.get(PdmImportService);
  });

  it("bez fajla / bez %PDF- magic bytes → 400", async () => {
    await expect(service.importPdf(undefined, {}, user)).rejects.toThrow(
      BadRequestException,
    );
    await expect(
      service.importPdf(makeFile("nije pdf", "x.pdf"), {}, user),
    ).rejects.toThrow(BadRequestException);
  });

  it("upsert po (broj, rev) iz imena fajla; crtež NE MORA postojati; log sa 'PDF: '", async () => {
    const res = await service.importPdf(
      makeFile(pdfBuffer, "1126982_B.pdf"),
      { sourcePath: "\\\\pdm-pdf\\VASADATA\\1126982_B.pdf" },
      user,
    );

    // KONTRAKT (paritet XML toka): bridge čita `data.success === true`, UI
    // `!r.success` — uspešan PDF uvoz MORA nositi success + statusMessage.
    expect(res.data).toEqual({
      importId: 42,
      fileName: "1126982_B.pdf",
      success: true,
      statusMessage: "PDF: 1126982 rev B, 3 KB",
      drawingNumber: "1126982",
      revision: "B",
      sizeKb: 3,
      replaced: false,
      drawingExists: false,
    });
    const upsertArg = (
      prisma.drawingPdf.upsert.mock.calls as [DrawingPdfUpsertArg][]
    )[0][0];
    expect(upsertArg.where).toEqual({
      drawingNumber_revision: { drawingNumber: "1126982", revision: "B" },
    });
    // Prisma Bytes = ArrayBuffer-backed Uint8Array (kopija buffera).
    expect(upsertArg.create.pdfBinary).toEqual(new Uint8Array(pdfBuffer));
    expect(upsertArg.create.uploadedBy).toBe("sef@servoteh.com");
    expect(upsertArg.update.pdfBinary).toEqual(new Uint8Array(pdfBuffer));

    const logData = lastLogData(prisma);
    expect(logData).toMatchObject({
      fileName: "1126982_B.pdf",
      filePath: "\\\\pdm-pdf\\VASADATA\\1126982_B.pdf",
      success: true,
      isCritical: false,
    });
    expect(logData.statusMessage).toMatch(/^PDF: /);
  });

  it("eksplicitna form polja imaju PREDNOST nad parsiranjem imena", async () => {
    await service.importPdf(
      makeFile(pdfBuffer, "1126982_B.pdf"),
      { drawingNumber: "999", revision: "C" },
      user,
    );
    const upsertArg = (
      prisma.drawingPdf.upsert.mock.calls as [DrawingPdfUpsertArg][]
    )[0][0];
    expect(upsertArg.where).toEqual({
      drawingNumber_revision: { drawingNumber: "999", revision: "C" },
    });
  });

  it("postojeći PDF → replaced:true; postojeći crtež → drawingExists:true", async () => {
    prisma.drawingPdf.findUnique.mockResolvedValue({
      drawingNumber: "1126982",
    });
    prisma.drawing.findUnique.mockResolvedValue({ id: 5 });

    const res = await service.importPdf(
      makeFile(pdfBuffer, "1126982_B.pdf"),
      {},
      user,
    );
    expect(res.data.replaced).toBe(true);
    expect(res.data.drawingExists).toBe(true);
    expect(res.data.success).toBe(true);
    expect(res.data.statusMessage).toContain("(zamenjen postojeći)");
  });

  it("mojibake originalname (multer latin1) se normalizuje u UTF-8 ime", async () => {
    // "šarka_Č.pdf" poslat bez UTF-8 flaga: busboy latin1-dekodira bajtove.
    const mojibake = Buffer.from("šarka_Č.pdf", "utf8").toString("latin1");

    const res = await service.importPdf(
      makeFile(pdfBuffer, mojibake),
      {},
      user,
    );

    expect(res.data.fileName).toBe("šarka_Č.pdf");
    // Parsiranje (broj, rev) ide nad NORMALIZOVANIM imenom.
    expect(res.data.drawingNumber).toBe("šarka");
    expect(res.data.revision).toBe("Č");
    expect(lastLogData(prisma).fileName).toBe("šarka_Č.pdf");
  });

  it("broj > 100 ili revizija > 10 znakova → 400 (kolone drawing_pdfs)", async () => {
    await expect(
      service.importPdf(
        makeFile(pdfBuffer, "x.pdf"),
        {
          drawingNumber: "X".repeat(101),
        },
        user,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.importPdf(
        makeFile(pdfBuffer, "x.pdf"),
        {
          revision: "R".repeat(11),
        },
        user,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

import { NotFoundException } from "@nestjs/common";
import { PlanMontazeService, splitDrawingCode } from "./plan-montaze.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import type { AiProviderService } from "../../common/ai/ai-provider.service";
import type { AiModelPolicyService } from "../../common/ai/ai-model-policy.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Crteži Plana montaže — prelaz sa sy15 `bigtehn_drawings_cache` + storage bucket-a
 * na 3.0 `drawing_pdfs` (bytea u bazi), 07.08.2026.
 *
 * Testovi brane tri stvari koje su bile stvarni rizik prelaza:
 *   1. mapiranje broja i revizije (`1029486_C` ↔ `1029486` + `C`) — uklj. PRAZNU reviziju;
 *   2. da liste/exists-check NIKAD ne selektuju `pdf_binary` (bytea, po više MB po redu);
 *   3. da se sy15 na ovom putu VIŠE NE DODIRUJE (nijedan poziv Sy15Service-a).
 */

/**
 * Prvi argument prvog poziva mocka. Mock je deklarisan bez parametara (`jest.fn(async () => [])`),
 * pa mu TS izvodi praznu tuple za `calls` — cast kroz `unknown[]` je jedini način da se
 * pročita stvarni argument bez menjanja potpisa mocka.
 */
const firstSqlArg = (m: jest.Mock): unknown => (m.mock.calls[0] as unknown[])[0];

/** Tekst kompozitnog Prisma.Sql (literal fragmenti, bez vrednosti) za asercije. */
const sqlText = (sql: unknown): string => {
  const s = sql as { strings?: string[]; sql?: string };
  if (Array.isArray(s?.strings)) return s.strings.join(" ");
  return typeof s?.sql === "string" ? s.sql : String(sql);
};

/** sy15 sloj sa SVIM ulazima kao špijunima — svaki poziv je regresija prelaza. */
const sy15Spy = () => ({
  db: jest.fn(),
  withUserRls: jest.fn(),
  runIdempotentRls: jest.fn(),
  read: jest.fn(),
});

const makeService = (queryRaw: jest.Mock) => {
  const sy15 = sy15Spy();
  const svc = new PlanMontazeService(
    sy15 as unknown as Sy15Service,
    {} as Sy15StorageService,
    {} as AiProviderService,
    {} as AiModelPolicyService,
    { $queryRaw: queryRaw } as unknown as PrismaService,
  );
  return { svc, sy15, queryRaw };
};

describe("splitDrawingCode (mapiranje broj + revizija)", () => {
  it("deli `broj_REVIZIJA` na 3.0 ključ (izmereno: svih 5.426 kodova ima tačno jednu `_`)", () => {
    expect(splitDrawingCode("1029486_C")).toEqual({
      drawingNumber: "1029486",
      revision: "C",
    });
    expect(splitDrawingCode("1083726_D")).toEqual({
      drawingNumber: "1083726",
      revision: "D",
    });
  });

  it("PRAZNA revizija je legitimna (209 redova u 3.0) — `1029554_` → revizija ''", () => {
    expect(splitDrawingCode("1029554_")).toEqual({
      drawingNumber: "1029554",
      revision: "",
    });
  });

  it("nenumerički broj sa prazno revizijom (`Pumpna grupa 4kW_`) prolazi isto pravilo", () => {
    expect(splitDrawingCode("Pumpna grupa 4kW_")).toEqual({
      drawingNumber: "Pumpna grupa 4kW",
      revision: "",
    });
  });

  it("kod bez donje crte nije ključ `drawing_pdfs` → null (pozivalac daje 404/exists:false)", () => {
    expect(splitDrawingCode("1029486")).toBeNull();
    expect(splitDrawingCode("")).toBeNull();
    expect(splitDrawingCode("_C")).toBeNull(); // prazan broj nije validan ključ
  });
});

describe("PlanMontazeService.lookupDrawings (3.0 drawing_pdfs)", () => {
  it("vraća exists po paru broj+revizija i NE vraća storage_path", async () => {
    const queryRaw = jest.fn(async () => [
      { drawing_number: "1029486", revision: "C", file_name: "1029486_C.pdf" },
    ]);
    const { svc, sy15 } = makeService(queryRaw);

    const res = await svc.lookupDrawings(
      "pm@servoteh.com",
      "1029486_C,1111111_A",
    );

    expect(res.data).toEqual([
      { drawing_no: "1029486_C", exists: true, file_name: "1029486_C.pdf" },
      { drawing_no: "1111111_A", exists: false, file_name: null },
    ]);
    // storage_path je bio sy15 pojam — ne sme se vratiti ni kao null ključ.
    expect(res.data[0]).not.toHaveProperty("storage_path");
    // sy15 se ne dodiruje.
    for (const spy of Object.values(sy15)) expect(spy).not.toHaveBeenCalled();
  });

  it("exists-check NE učitava pdf_binary (samo meta) i traži sadržaj kroz IS NOT NULL", async () => {
    const queryRaw = jest.fn(async () => []);
    const { svc } = makeService(queryRaw);

    await svc.lookupDrawings("pm@servoteh.com", "1029486_C");

    const sql = sqlText(firstSqlArg(queryRaw));
    expect(sql).toContain("drawing_pdfs");
    expect(sql).toContain("pdf_binary IS NOT NULL");
    // Bytea se NIKAD ne selektuje u listi (DRAWING_PDF_SELECT doktrina).
    expect(sql).not.toMatch(/SELECT[^;]*\bpdf_binary\s*(,|FROM)/i);
    expect(sql).not.toContain("bigtehn_drawings_cache");
  });

  it("prazan ulaz ne pravi upit", async () => {
    const queryRaw = jest.fn(async () => []);
    const { svc } = makeService(queryRaw);
    await expect(svc.lookupDrawings("pm@servoteh.com", "")).resolves.toEqual({
      data: [],
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe("PlanMontazeService.drawingSignUrl (content ruta umesto sy15 signed URL)", () => {
  it("vraća auth-gated content rutu modula sa expiresIn 0", async () => {
    const queryRaw = jest.fn(async () => [{ ok: true }]);
    const { svc, sy15 } = makeService(queryRaw);

    const res = await svc.drawingSignUrl("pm@servoteh.com", "1029486_C");

    expect(res.data.url).toBe(
      "/api/v1/montaza/lookups/drawings/pdf/content?code=1029486_C",
    );
    expect(res.data.expiresIn).toBe(0);
    for (const spy of Object.values(sy15)) expect(spy).not.toHaveBeenCalled();
  });

  it("404 kad broja nema u drawing_pdfs (bez fallback-a na sy15)", async () => {
    const queryRaw = jest.fn(async () => []);
    const { svc } = makeService(queryRaw);
    await expect(
      svc.drawingSignUrl("pm@servoteh.com", "9999999_Z"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("postojanje se proverava BEZ čitanja bajtova", async () => {
    const queryRaw = jest.fn(async () => [{ ok: true }]);
    const { svc } = makeService(queryRaw);
    await svc.drawingSignUrl("pm@servoteh.com", "1029486_C");
    const sql = sqlText(firstSqlArg(queryRaw));
    expect(sql).toContain("(pdf_binary IS NOT NULL) AS ok");
  });
});

describe("PlanMontazeService.streamDrawingPdf (bajtovi samo ovde)", () => {
  it("vraća buffer i ime fajla iz drawing_pdfs", async () => {
    const queryRaw = jest.fn(async () => [
      { pdf_binary: Buffer.from("%PDF-1.4 test"), file_name: "1029486_C.pdf" },
    ]);
    const { svc, sy15 } = makeService(queryRaw);

    const out = await svc.streamDrawingPdf("1029486_C");

    expect(out.fileName).toBe("1029486_C.pdf");
    expect(out.buffer.toString()).toBe("%PDF-1.4 test");
    for (const spy of Object.values(sy15)) expect(spy).not.toHaveBeenCalled();
  });

  it("fallback ime kad file_name nedostaje", async () => {
    const queryRaw = jest.fn(async () => [
      { pdf_binary: Buffer.from("x"), file_name: null },
    ]);
    const { svc } = makeService(queryRaw);
    await expect(svc.streamDrawingPdf("1029554_")).resolves.toMatchObject({
      fileName: "1029554_.pdf",
    });
  });

  it("404 kad red postoji ali nema sadržaja", async () => {
    const queryRaw = jest.fn(async () => [
      { pdf_binary: null, file_name: "x.pdf" },
    ]);
    const { svc } = makeService(queryRaw);
    await expect(svc.streamDrawingPdf("1029486_C")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

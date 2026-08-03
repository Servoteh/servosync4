import {
  buildDrawingIdentCandidates,
  pickBestDrawingRow,
  sanitizeDrawingNo,
} from "./drawing-lookup";
import { LocationsService } from "./locations.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { LabelPrintService } from "../../common/printing/label-print.service";
import type { PrismaService } from "../../prisma/prisma.service";

/**
 * Unit — dočitavanje broja crteža za (nalog, TP) — port 1.0
 * `resolveDrawingNoForPredmetTp`/`fetchBigtehnOpSnapshotByRnAndTp`/`sanitizeDrawingNo`.
 * Povod: prijava 03.08.2026 — sken `RNZ:10305:9811-5/121:0:B` popuni nalog i TP,
 * a „Broj crteža" ostane prazan (RNZ format crtež NE NOSI — vidi barcode.spec).
 */

describe("sanitizeDrawingNo — BigTehn placeholder tačke", () => {
  it("čist broj prolazi netaknut", () => {
    expect(sanitizeDrawingNo("1128816")).toBe("1128816");
  });
  it("skida vodeće/prateće tačke i razmake (`..1133219.` → `1133219`)", () => {
    expect(sanitizeDrawingNo("..1133219.")).toBe("1133219");
    expect(sanitizeDrawingNo("1109245.")).toBe("1109245");
    expect(sanitizeDrawingNo("  1109245  ")).toBe("1109245");
  });
  it("placeholder vrednosti (`.`, `..`, prazno, null) → prazan string", () => {
    expect(sanitizeDrawingNo(".")).toBe("");
    expect(sanitizeDrawingNo("..")).toBe("");
    expect(sanitizeDrawingNo("   ")).toBe("");
    expect(sanitizeDrawingNo("")).toBe("");
    expect(sanitizeDrawingNo(null)).toBe("");
    expect(sanitizeDrawingNo(undefined)).toBe("");
  });
});

describe("buildDrawingIdentCandidates — redosled kandidata (paritet 1.0)", () => {
  it("prijava 03.08: (9811-5, 121) → jedini kandidat 9811-5/121", () => {
    expect(buildDrawingIdentCandidates("9811-5", "121")).toEqual({
      candidates: ["9811-5/121"],
      opForIdent: "121",
    });
  });

  it("numerički TP se normalizuje (0088 → 88)", () => {
    expect(buildDrawingIdentCandidates("7351", "0088").candidates).toEqual([
      "7351/88",
    ]);
  });

  it("alfanumerički TP ostaje doslovan (9400, 7-5-S1)", () => {
    expect(buildDrawingIdentCandidates("9400", "7-5-S1").candidates).toEqual([
      "9400/7-5-S1",
    ]);
  });

  it("9400 par: kanonska kosa crta PRE legacy dash forme", () => {
    // Dash redovi u kešu predmeta 9400 nose ZASTARELI crtež (1.0 komentar) —
    // redosled kandidata je zato deo ugovora, ne detalj.
    expect(buildDrawingIdentCandidates("9400", "2/334").candidates).toEqual([
      "9400/2/334",
      "9400-2/334",
    ]);
  });

  it("9400 sa vodećim '-': preskače generični ident, ide na dash formu", () => {
    expect(buildDrawingIdentCandidates("9400", "-2/334").candidates).toEqual([
      "9400-2/334",
    ]);
  });

  it("nalog sa vodećim nulama dobija i normalizovan kandidat", () => {
    expect(buildDrawingIdentCandidates("09000", "568").candidates).toEqual([
      "09000/568",
      "9000/568",
    ]);
  });

  it("bez TP ref-a: fallback na sam nalog (sa TP ref-om ga NEMA)", () => {
    expect(buildDrawingIdentCandidates("9000", "").candidates).toEqual([
      "9000",
    ]);
    expect(buildDrawingIdentCandidates("9000", "488").candidates).not.toContain(
      "9000",
    );
  });

  it("prazan nalog → nema kandidata", () => {
    expect(buildDrawingIdentCandidates("", "121").candidates).toEqual([]);
  });
});

describe("pickBestDrawingRow — više redova za isti upit", () => {
  const rows = [
    { identBroj: "9811-5", drawingNo: "X" },
    { identBroj: "9811-5/121", drawingNo: "1128816" },
    { identBroj: "9811-5/12", drawingNo: "Y" },
  ];
  it("tačan `nalog/tp` pobeđuje", () => {
    expect(pickBestDrawingRow(rows, "9811-5", "121")?.drawingNo).toBe(
      "1128816",
    );
  });
  it("jedan red → taj red (bez poklapanja)", () => {
    expect(pickBestDrawingRow([rows[0]], "9811-5", "121")).toBe(rows[0]);
  });
  it("bez TP-a: tačan ident pobeđuje", () => {
    expect(pickBestDrawingRow(rows, "9811-5", "")?.identBroj).toBe("9811-5");
  });
  it("prazna lista → null", () => {
    expect(pickBestDrawingRow([], "9811-5", "121")).toBeNull();
  });
});

describe("LocationsService.lookupDrawing — work_orders pa sy15 keš", () => {
  let prisma: { workOrder: { findMany: jest.Mock } };
  let sy15: { db: { $queryRaw: jest.Mock } };
  let service: LocationsService;

  beforeEach(() => {
    prisma = { workOrder: { findMany: jest.fn().mockResolvedValue([]) } };
    sy15 = { db: { $queryRaw: jest.fn().mockResolvedValue([]) } };
    service = new LocationsService(
      sy15 as unknown as Sy15Service,
      {} as unknown as LabelPrintService,
      prisma as unknown as PrismaService,
    );
  });

  it("prijava 03.08: (9811-5, 121) nađe crtež u glavnoj bazi work_orders", async () => {
    prisma.workOrder.findMany.mockResolvedValueOnce([
      {
        identNumber: "9811-5/121",
        drawingNumber: "1128816",
        revision: "B",
        partName: "Nosač",
      },
    ]);
    const out = await service.lookupDrawing("9811-5", "121", "0");
    expect(out.data).toEqual({
      found: true,
      drawingNo: "1128816",
      revision: "B",
      nazivDela: "Nosač",
      source: "work_orders",
    });
    // varijanta iz RNZ barkoda sužava pogodak (variant filter u where).
    expect(prisma.workOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          identNumber: "9811-5/121",
          variant: 0,
        }) as unknown,
      }),
    );
    // Glavna baza je pogodila — sy15 keš se NE dira.
    expect(sy15.db.$queryRaw).not.toHaveBeenCalled();
  });

  it("legacy RN kog glavna baza nema → fallback na sy15 bigtehn keš", async () => {
    sy15.db.$queryRaw.mockResolvedValueOnce([
      {
        ident_broj: "7351/1088",
        broj_crteza: "..1091063.",
        revizija: "39757",
        naziv_dela: null,
      },
    ]);
    const out = await service.lookupDrawing("7351", "1088", undefined);
    expect(out.data).toEqual({
      found: true,
      drawingNo: "1091063", // sanitizovan (placeholder tačke skinute)
      revision: "39757",
      nazivDela: null,
      source: "bigtehn_cache",
    });
    // M2 (verify 03.08): dupli ident_broj u kešu (npr. 9400/3/193) — izbor mora
    // biti DETERMINISTIČKI i preferirati MES-aktivan red (1.0 je aktivni view
    // čitao pre punog keša): čita se view sa is_mes_active + čvrst ORDER BY.
    const call = sy15.db.$queryRaw.mock.calls[0] as unknown as [
      { strings?: readonly string[] },
    ];
    const sqlText = (call[0].strings ?? []).join(" ");
    expect(sqlText).toContain("v_bigtehn_work_orders_with_mes_active");
    expect(sqlText).toContain("ORDER BY (is_mes_active IS TRUE) DESC, id ASC");
  });

  it("placeholder crtež (samo tačka) → found ali PRAZAN drawingNo (ne autofill-uje 'tačku')", async () => {
    sy15.db.$queryRaw.mockResolvedValueOnce([
      {
        ident_broj: "9000/1",
        broj_crteza: ".",
        revizija: null,
        naziv_dela: null,
      },
    ]);
    const out = await service.lookupDrawing("9000", "1", undefined);
    expect(out.data.found).toBe(true);
    expect(out.data.drawingNo).toBe("");
  });

  it("nigde nema → found:false (kandidati se troše redom)", async () => {
    const out = await service.lookupDrawing("9400", "2/334", undefined);
    expect(out.data.found).toBe(false);
    // Dva kandidata (9400/2/334, 9400-2/334) × 2 izvora.
    expect(prisma.workOrder.findMany).toHaveBeenCalledTimes(2);
    expect(sy15.db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("ključevi se kanonizuju pre lookup-a (9400-2 / 415 → 9400/2/415)", async () => {
    prisma.workOrder.findMany.mockResolvedValueOnce([
      {
        identNumber: "9400/2/415",
        drawingNumber: "1129456",
        revision: "A",
        partName: null,
      },
    ]);
    const out = await service.lookupDrawing("9400-2", "415", undefined);
    expect(out.data.drawingNo).toBe("1129456");
    expect(prisma.workOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          identNumber: "9400/2/415",
        }) as unknown,
      }),
    );
  });

  it("prazan nalog → found:false bez ijednog upita", async () => {
    const out = await service.lookupDrawing("", "121", undefined);
    expect(out.data.found).toBe(false);
    expect(prisma.workOrder.findMany).not.toHaveBeenCalled();
    expect(sy15.db.$queryRaw).not.toHaveBeenCalled();
  });
});

import "reflect-metadata";
import {
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { HandoverDraftPrintService } from "./handover-draft-print.service";
import { HANDOVER_STATUS } from "./handovers.service";

/**
 * Zahtev 055/26 — „Primopredaja — lista pozicija po nacrtu" (PDF).
 *
 * Mock deo: kapija „samo odobrene" (nepredat / U OBRADI / ODBIJENO / bez
 * primopredaje → 422 srpska poruka) + sadržaj docDefinition-a (zaglavlje,
 * kolone tabele, `headerRows: 1`, footer N/M, izbor datuma odobrenja).
 *
 * Realni render (presedan work-order-print.service.spec — „izmereno, ne
 * pretpostavljeno"): pravi `PdfService` (pdfmake), pa se broj strana čita iz
 * samog PDF-a — 7 pozicija (izmeren prod primer G-260803-002) staje na jednu
 * stranu, 80 pozicija se prelama na više.
 */

/** Izmeren prod primer (03.08.2026): nacrt G-260803-002, 7 pozicija, predmet 9400/1. */
const DRAFT = {
  id: 3539,
  draftNumber: "G-260803-002",
  draftDate: new Date("2026-08-03T12:31:29"),
  projectId: 10348,
  isLocked: true,
  statusId: 2, // Predat
};

const PROJECT = {
  id: 10348,
  projectNumber: "9400/1",
  projectName: "Presa za izvlačenje 350t",
};

interface ItemFix {
  id: number;
  drawingId: number;
  quantityToProduce: number;
}
const ITEMS: ItemFix[] = [
  { id: 8828, drawingId: 16634, quantityToProduce: 2 },
  { id: 8829, drawingId: 16627, quantityToProduce: 2 },
  { id: 8830, drawingId: 16628, quantityToProduce: 2 },
  { id: 8831, drawingId: 16629, quantityToProduce: 2 },
  { id: 8832, drawingId: 16630, quantityToProduce: 2 },
  { id: 8833, drawingId: 16631, quantityToProduce: 2 },
  { id: 8834, drawingId: 16635, quantityToProduce: 1 },
];

const DRAWINGS = [
  {
    id: 16634,
    drawingNumber: "1131319",
    revision: "A",
    name: "Sklop alata za izvlačenje M107",
  },
  {
    id: 16627,
    drawingNumber: "1131302",
    revision: "A",
    name: "Trn alat za izvlačenje M107",
  },
  {
    id: 16628,
    drawingNumber: "1131307",
    revision: "A",
    name: "Produžnik 2 - alat izvlačenje M107",
  },
  {
    id: 16629,
    drawingNumber: "1131314",
    revision: "A",
    name: "Produžnik 1 - alat izvlačenje M107",
  },
  {
    id: 16630,
    drawingNumber: "1131316",
    revision: "A",
    name: "Produžnik 3 - alat izvlačenje M107",
  },
  {
    id: 16631,
    drawingNumber: "1131318",
    revision: "A",
    name: "Produžnik 4 - alat izvlačenje M107",
  },
  {
    id: 16635,
    drawingNumber: "1131321",
    revision: "A",
    name: "Prsten za izvlačenje - alat M107",
  },
];

const APPROVED_AT = new Date("2026-08-03T12:41:54");

/** Primopredaje 1:1 sa prod primerom — svih 7 SAGLASAN, isti trenutak odobrenja. */
function approvedHandovers() {
  return ITEMS.map((it, idx) => ({
    id: 13944 + idx,
    drawingId: it.drawingId,
    statusId: HANDOVER_STATUS.APPROVED,
    statusChangedAt: APPROVED_AT,
  }));
}

interface PrismaMock {
  handoverDraft: { findUnique: jest.Mock };
  handoverDraftItem: { findMany: jest.Mock };
  drawing: { findMany: jest.Mock };
  project: { findUnique: jest.Mock };
  drawingHandover: { findMany: jest.Mock };
}

function makePrisma(): PrismaMock {
  return {
    handoverDraft: { findUnique: jest.fn().mockResolvedValue(DRAFT) },
    handoverDraftItem: { findMany: jest.fn().mockResolvedValue(ITEMS) },
    drawing: { findMany: jest.fn().mockResolvedValue(DRAWINGS) },
    project: { findUnique: jest.fn().mockResolvedValue(PROJECT) },
    drawingHandover: {
      findMany: jest.fn().mockResolvedValue(approvedHandovers()),
    },
  };
}

/** Servis sa mokovanim pdf.render — hvata docDefinition. */
function setup() {
  const prisma = makePrisma();
  const pdf = { render: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4")) };
  const service = new HandoverDraftPrintService(
    prisma as unknown as PrismaService,
    pdf as unknown as PdfService,
  );
  return { service, prisma, pdf };
}

/** Servis sa PRAVIM PdfService (realan render — broj strana se meri iz PDF-a). */
function setupReal(prisma: PrismaMock) {
  return new HandoverDraftPrintService(
    prisma as unknown as PrismaService,
    new PdfService(),
  );
}

function capturedDocDef(pdf: { render: jest.Mock }): TDocumentDefinitions {
  const calls = pdf.render.mock.calls as [TDocumentDefinitions][];
  return calls[0][0];
}

/** Vrednost ćelije desno od zadate labele u info tabeli (obrazac iz 006/26 spec-a). */
function infoCell(docDef: TDocumentDefinitions, label: string): string {
  const content = docDef.content as Array<{ table?: { body?: unknown[][] } }>;
  for (const node of content) {
    const body = node?.table?.body;
    if (!Array.isArray(body)) continue;
    for (const row of body) {
      if (!Array.isArray(row)) continue;
      for (let i = 0; i < row.length - 1; i++) {
        const cell = row[i] as { text?: unknown } | undefined;
        if (cell?.text === label)
          return (row[i + 1] as { text?: string } | undefined)?.text ?? "";
      }
    }
  }
  throw new Error(`Ćelija "${label}" nije nađena u docDefinition-u`);
}

/** Tabela pozicija = jedini table čvor sa `headerRows`. */
function positionsTable(docDef: TDocumentDefinitions): {
  headerRows?: number;
  widths?: unknown[];
  body: Content[][];
} {
  const content = docDef.content as Array<{
    table?: { headerRows?: number; widths?: unknown[]; body?: Content[][] };
  }>;
  for (const node of content) {
    if (node?.table?.headerRows) {
      return node.table as { headerRows: number; body: Content[][] };
    }
  }
  throw new Error("Tabela pozicija (headerRows) nije nađena");
}

/** Broj /Type /Page objekata u serijalizovanom PDF-u (isti helper kao RN spec). */
function pdfPageCount(buf: Buffer): number {
  return (buf.toString("latin1").match(/\/Type\s*\/Page(?![sA-Za-z])/g) ?? [])
    .length;
}

describe("HandoverDraftPrintService — kapija 'samo odobrene' (055/26)", () => {
  it("nepostojeći nacrt → 404", async () => {
    const { service, prisma } = setup();
    prisma.handoverDraft.findUnique.mockResolvedValue(null);
    await expect(service.buildDraftPositionsPdf(999)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("nepredat nacrt (isLocked=false) → 422 sa srpskom porukom", async () => {
    const { service, prisma } = setup();
    prisma.handoverDraft.findUnique.mockResolvedValue({
      ...DRAFT,
      isLocked: false,
      statusId: 0,
    });
    await expect(service.buildDraftPositionsPdf(DRAFT.id)).rejects.toThrow(
      UnprocessableEntityException,
    );
    await expect(service.buildDraftPositionsPdf(DRAFT.id)).rejects.toThrow(
      /nije predat u primopredaju.*samo za odobrene/,
    );
  });

  it("pozicija U OBRADI → 422; poruka nosi broj crteža i stanje", async () => {
    const { service, prisma } = setup();
    const rows = approvedHandovers();
    rows[2].statusId = HANDOVER_STATUS.PENDING; // crtež 16628 = 1131307/A
    prisma.drawingHandover.findMany.mockResolvedValue(rows);

    await expect(service.buildDraftPositionsPdf(DRAFT.id)).rejects.toThrow(
      /nije odobrena.*1131307 \/ A \(U OBRADI\)/,
    );
  });

  it("pozicija ODBIJENO → 422 (odbijena nije odobrena)", async () => {
    const { service, prisma } = setup();
    const rows = approvedHandovers();
    rows[0].statusId = HANDOVER_STATUS.REJECTED;
    prisma.drawingHandover.findMany.mockResolvedValue(rows);

    await expect(service.buildDraftPositionsPdf(DRAFT.id)).rejects.toThrow(
      /1131319 \/ A \(ODBIJENO\)/,
    );
  });

  it("pozicija bez primopredaje → 422 (bez primopredaje)", async () => {
    const { service, prisma } = setup();
    prisma.drawingHandover.findMany.mockResolvedValue(
      approvedHandovers().slice(0, 6), // poslednja (16635) nema red
    );
    await expect(service.buildDraftPositionsPdf(DRAFT.id)).rejects.toThrow(
      /1131321 \/ A \(bez primopredaje\)/,
    );
  });

  it("LANSIRAN se računa kao odobren (delimično lansiran nacrt se štampa)", async () => {
    const { service, prisma, pdf } = setup();
    const rows = approvedHandovers();
    rows[0].statusId = HANDOVER_STATUS.LAUNCHED;
    rows[0].statusChangedAt = new Date("2026-08-04T09:00:00"); // trenutak lansiranja
    prisma.drawingHandover.findMany.mockResolvedValue(rows);

    await expect(
      service.buildDraftPositionsPdf(DRAFT.id),
    ).resolves.toMatchObject({
      fileName: "primopredaja-G-260803-002-pozicije.pdf",
    });
    expect(pdf.render).toHaveBeenCalledTimes(1);
  });

  it("sve stavke isključene iz primopredaje → 422", async () => {
    const { service, prisma } = setup();
    prisma.handoverDraftItem.findMany.mockResolvedValue([]);
    await expect(service.buildDraftPositionsPdf(DRAFT.id)).rejects.toThrow(
      /nema pozicija za štampu/,
    );
  });

  it("po crtežu se gleda NAJSKORIJA primopredaja (max id) — stariji odbijeni red ne smeta", async () => {
    const { service, prisma, pdf } = setup();
    // Stariji ODBIJEN red istog crteža (manji id) + noviji SAGLASAN: servis
    // dobija redove sortirane id desc (orderBy u upitu) — prvi pogodak pobedi.
    const older = {
      id: 13000,
      drawingId: 16634,
      statusId: HANDOVER_STATUS.REJECTED,
      statusChangedAt: new Date("2026-07-01T08:00:00"),
    };
    prisma.drawingHandover.findMany.mockResolvedValue([
      ...approvedHandovers(),
      older,
    ]);

    await expect(
      service.buildDraftPositionsPdf(DRAFT.id),
    ).resolves.toBeTruthy();
    expect(pdf.render).toHaveBeenCalledTimes(1);
  });
});

describe("HandoverDraftPrintService — sadržaj docDefinition-a", () => {
  it("zaglavlje: broj nacrta, projekat (broj · naziv), oba datuma, broj pozicija", async () => {
    const { service, pdf } = setup();
    await service.buildDraftPositionsPdf(DRAFT.id);

    const docDef = capturedDocDef(pdf);
    expect(infoCell(docDef, "Broj nacrta")).toBe("G-260803-002");
    expect(infoCell(docDef, "Projekat")).toBe(
      "9400/1 · Presa za izvlačenje 350t",
    );
    expect(infoCell(docDef, "Datum nacrta")).toBe("03.08.2026.");
    expect(infoCell(docDef, "Datum odobrenja")).toBe("03.08.2026.");
    expect(infoCell(docDef, "Broj pozicija")).toBe("7");
  });

  it("tabela: headerRows=1, kolone R. br./Broj crteža/Naziv pozicije/Količina, 7 redova", async () => {
    const { service, pdf } = setup();
    await service.buildDraftPositionsPdf(DRAFT.id);

    const table = positionsTable(capturedDocDef(pdf));
    expect(table.headerRows).toBe(1); // prelom ponavlja zaglavlje
    const header = table.body[0].map((c) => (c as { text?: string }).text);
    expect(header).toEqual([
      "R. br.",
      "Broj crteža",
      "Naziv pozicije",
      "Količina",
    ]);
    expect(table.body).toHaveLength(1 + ITEMS.length);

    // Prvi i poslednji red 1:1 sa izmerenim prod primerom G-260803-002.
    const row = (i: number) =>
      table.body[i].map((c) => (c as { text?: string }).text);
    expect(row(1)).toEqual([
      "1",
      "1131319 / A",
      "Sklop alata za izvlačenje M107",
      "2",
    ]);
    expect(row(7)).toEqual([
      "7",
      "1131321 / A",
      "Prsten za izvlačenje - alat M107",
      "1",
    ]);
  });

  it("footer: Nacrt {broj} · strana N/M", async () => {
    const { service, pdf } = setup();
    await service.buildDraftPositionsPdf(DRAFT.id);

    const docDef = capturedDocDef(pdf);
    const footer = docDef.footer as (c: number, t: number) => { text: string };
    expect(footer(2, 3).text).toBe("Nacrt G-260803-002 · strana 2/3");
  });

  it("datum odobrenja = MAX status_changed_at SAGLASAN pozicija; lansirane se ignorišu", async () => {
    const { service, prisma, pdf } = setup();
    const rows = approvedHandovers();
    rows[1].statusChangedAt = new Date("2026-08-05T10:30:00"); // najskorije odobrenje
    rows[0].statusId = HANDOVER_STATUS.LAUNCHED;
    rows[0].statusChangedAt = new Date("2026-08-06T07:00:00"); // lansiranje — NE sme u max
    prisma.drawingHandover.findMany.mockResolvedValue(rows);

    await service.buildDraftPositionsPdf(DRAFT.id);
    expect(infoCell(capturedDocDef(pdf), "Datum odobrenja")).toBe(
      "05.08.2026.",
    );
  });

  it("orphan crtež (nema ga u drawings) → #id i prazan naziv, bez pada", async () => {
    const { service, prisma, pdf } = setup();
    prisma.drawing.findMany.mockResolvedValue(DRAWINGS.slice(1)); // 16634 fali
    await service.buildDraftPositionsPdf(DRAFT.id);

    const table = positionsTable(capturedDocDef(pdf));
    const firstRow = table.body[1].map((c) => (c as { text?: string }).text);
    expect(firstRow[1]).toBe("#16634");
  });
});

describe("HandoverDraftPrintService — realan render (višestraničje izmereno)", () => {
  jest.setTimeout(60_000);

  it("prod primer (7 pozicija, G-260803-002): validan PDF, jedna strana", async () => {
    const service = setupReal(makePrisma());
    const { buffer, fileName } = await service.buildDraftPositionsPdf(DRAFT.id);

    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPageCount(buffer)).toBe(1);
    expect(fileName).toBe("primopredaja-G-260803-002-pozicije.pdf");
  });

  it("80 pozicija: prelama se na više strana (headerRows tabela + footer N/M)", async () => {
    const prisma = makePrisma();
    const many: ItemFix[] = Array.from({ length: 80 }, (_, i) => ({
      id: 20000 + i,
      drawingId: 30000 + i,
      quantityToProduce: (i % 5) + 1,
    }));
    prisma.handoverDraftItem.findMany.mockResolvedValue(many);
    prisma.drawing.findMany.mockResolvedValue(
      many.map((m, i) => ({
        id: m.drawingId,
        drawingNumber: `1131${300 + i}`,
        revision: "A",
        name: `Pozicija dugačkog naziva za prelom strane broj ${i + 1}`,
      })),
    );
    prisma.drawingHandover.findMany.mockResolvedValue(
      many.map((m, i) => ({
        id: 50000 + i,
        drawingId: m.drawingId,
        statusId: HANDOVER_STATUS.APPROVED,
        statusChangedAt: APPROVED_AT,
      })),
    );

    const service = setupReal(prisma);
    const { buffer } = await service.buildDraftPositionsPdf(DRAFT.id);
    expect(pdfPageCount(buffer)).toBeGreaterThanOrEqual(2);
  });
});

import "reflect-metadata";
import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { CompensationPdfService } from "./compensation-pdf.service";

/**
 * Izjava o kompenzaciji — testira se `docDefinition` (pdfmake ulaz), `pdf.render`
 * je mock. Invarijante: obe strane prebijanja sa zbirovima, prebijeni iznos brojem
 * I SLOVIMA, kontrola bilateralnog bilansa (nesaglasne strane moraju da vrište),
 * prazna kompenzacija ne puca, 404 za nepostojeću.
 */

const D = Prisma.Decimal;

function texts(dd: TDocumentDefinitions): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (typeof o.text === "string") out.push(o.text);
      for (const [k, v] of Object.entries(o)) {
        if (k === "text") continue;
        walk(v);
      }
    }
  };
  walk(dd.content as unknown);
  return out;
}

const COMPANY = {
  companyName: "Servoteh d.o.o.",
  address: "Vojvođanska 297",
  city: "Dobanovci",
  taxId: "101017443",
  registrationNumber: "17400169",
  bankAccount: "160-000",
  phone: null,
  email: null,
};

const PARTNER = {
  id: 7,
  name: "Metalprodukt d.o.o.",
  address: "Karađorđeva 118",
  postalCode: "11000",
  city: "Beograd",
  taxId: "100200300",
  registrationNumber: "20123456",
};

const LEDGER = [
  {
    id: 11,
    accountCode: "2040",
    documentNumber: "IFR-0001/2026",
    dueDate: new Date(Date.UTC(2026, 3, 13)),
    description: "Faktura za robu",
    journalEntry: { documentDate: new Date(Date.UTC(2026, 2, 14)) },
  },
  {
    id: 22,
    accountCode: "4350",
    documentNumber: "UF-0007",
    dueDate: new Date(Date.UTC(2026, 4, 2)),
    description: "Ulazni račun",
    journalEntry: { documentDate: new Date(Date.UTC(2026, 3, 2)) },
  },
];

function makeOrder(lines: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    partnerId: 7,
    compensationNumber: "0001/2026",
    date: new Date(Date.UTC(2026, 4, 10)),
    status: "POSTED",
    totalAmount: new D("480000"),
    journalEntryId: 91,
    lines,
    ...overrides,
  };
}

function setup(order: unknown) {
  const prisma = {
    compensationOrder: { findUnique: jest.fn().mockResolvedValue(order) },
    customer: { findUnique: jest.fn().mockResolvedValue(PARTNER) },
    ledgerEntry: { findMany: jest.fn().mockResolvedValue(LEDGER) },
    company: { findFirst: jest.fn().mockResolvedValue(COMPANY) },
  };
  const pdf = { render: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4")) };
  const service = new CompensationPdfService(
    prisma as unknown as PrismaService,
    pdf as unknown as PdfService,
  );
  return { service, pdf };
}

const BALANCED_LINES = [
  { ledgerEntryId: 11, side: "receivable", amount: new D("480000"), lineNo: 1 },
  { ledgerEntryId: 22, side: "payable", amount: new D("480000"), lineNo: 2 },
];

describe("CompensationPdfService", () => {
  it("štampa obe strane prebijanja, zbirove i iznos u slovima", async () => {
    const { service, pdf } = setup(makeOrder(BALANCED_LINES));
    const res = await service.buildCompensationPdf(5, "knjigovodja@servoteh.com");
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    const t = texts(dd);

    expect(t).toContain("IZJAVA O KOMPENZACIJI");
    expect(t).toContain("Kompenzacija broj 0001/2026");
    expect(t).toContain("I  NAŠA POTRAŽIVANJA OD DRUGE STRANE (zatvaraju se prebijanjem)");
    expect(t).toContain("II  NAŠE OBAVEZE PREMA DRUGOJ STRANI (zatvaraju se prebijanjem)");
    expect(t).toContain("Metalprodukt d.o.o.");
    expect(t).toContain("IFR-0001/2026");
    expect(t).toContain("UF-0007");
    // dva reda „SVEGA" (po jedan po strani) + prebijeni iznos
    expect(t.filter((s) => s === "SVEGA")).toHaveLength(2);
    expect(t).toContain("Prebijeni (kompenzirani) iznos: 480.000,00 RSD");
    expect(t).toContain("Slovima: četiristo osamdeset hiljada dinara i 00/100");
    expect(t.some((s) => s.includes("bilateralno usklađeno"))).toBe(true);
    expect(res.fileName).toBe("Kompenzacija-0001_2026.pdf");
  });

  it("nesaglasne strane → NEUSKLAĐENO (izjava se ne sme potpisati)", async () => {
    const { service, pdf } = setup(
      makeOrder([
        { ledgerEntryId: 11, side: "receivable", amount: new D("480000"), lineNo: 1 },
        { ledgerEntryId: 22, side: "payable", amount: new D("300000"), lineNo: 2 },
      ]),
    );
    await service.buildCompensationPdf(5);
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(texts(dd).some((s) => s.includes("NEUSKLAĐENO"))).toBe(true);
  });

  it("kompenzacija bez linija se štampa sa napomenom (ne puca)", async () => {
    const { service, pdf } = setup(makeOrder([]));
    await service.buildCompensationPdf(5);
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    const t = texts(dd);
    expect(t.filter((s) => s === "Nema stavki na ovoj strani prebijanja.")).toHaveLength(2);
  });

  it("nepostojeća kompenzacija → 404", async () => {
    const { service } = setup(null);
    await expect(service.buildCompensationPdf(999)).rejects.toMatchObject({ status: 404 });
  });
});

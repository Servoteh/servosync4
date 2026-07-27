import "reflect-metadata";
import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../prisma/prisma.service";
import { PdfService } from "../documents/pdf.service";
import { BankStatementPrintService } from "./bank-statement-print.service";

/**
 * Štampa bankovnog izvoda — testira se `docDefinition` (pdfmake ulaz), `pdf.render`
 * je mock. Ključne invarijante: naslov i kolone, priliv/odliv u ispravnim kolonama,
 * rekapitulacija i kontrola salda (ista formula kao traka na ekranu), devizne
 * kolone samo za devizni izvod, prazan izvod ne puca, 404 za nepostojeći.
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

function makeStatement(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    bankAccount: "160-0000000000000-00",
    statementNumber: "042",
    statementDate: new Date(Date.UTC(2026, 3, 15)),
    status: "IMPORTED",
    currency: "RSD",
    openingBalance: new D("1500000"),
    closingBalance: new D("2154567.89"),
    importedFileName: "izvod-042.txt",
    lines: [
      {
        lineNo: 1,
        partnerAccount: "205-1234567890-11",
        partnerName: "Metalprodukt d.o.o.",
        amount: new D("1234567.89"),
        direction: "CREDIT",
        referenceNumber: "97 12-3456",
        documentDate: new Date(Date.UTC(2026, 3, 15)),
        matchedCustomerId: 7,
        status: "MATCHED",
        currency: null,
        foreignAmount: null,
        exchangeRate: null,
      },
      {
        lineNo: 2,
        partnerAccount: "160-9999999999999-88",
        partnerName: "Elektrodistribucija",
        amount: new D("580000"),
        direction: "DEBIT",
        referenceNumber: "97 55-1122",
        documentDate: new Date(Date.UTC(2026, 3, 15)),
        matchedCustomerId: null,
        status: "UNMATCHED",
        currency: null,
        foreignAmount: null,
        exchangeRate: null,
      },
    ],
    ...overrides,
  };
}

function setup(statement: unknown) {
  const prisma = {
    bankStatement: { findUnique: jest.fn().mockResolvedValue(statement) },
    customer: { findMany: jest.fn().mockResolvedValue([{ id: 7, name: "Metalprodukt d.o.o." }]) },
    company: { findFirst: jest.fn().mockResolvedValue(COMPANY) },
  };
  const pdf = { render: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4")) };
  const service = new BankStatementPrintService(
    prisma as unknown as PrismaService,
    pdf as unknown as PdfService,
  );
  return { service, pdf };
}

describe("BankStatementPrintService", () => {
  it("štampa naslov, kolone, stavke i rekapitulaciju sa kontrolom salda", async () => {
    const { service, pdf } = setup(makeStatement());
    const res = await service.buildStatementPdf(1, "knjigovodja@servoteh.com");
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    const t = texts(dd);

    expect(t).toContain("IZVOD POSLOVNOG RAČUNA");
    expect(t.some((s) => s.includes("Izvod broj 042"))).toBe(true);
    for (const col of [
      "R.br.",
      "Datum dok.",
      "Komitent",
      "Žiro računa",
      "Poziv na broj",
      "Odliv (RSD)",
      "Priliv (RSD)",
    ]) {
      expect(t).toContain(col);
    }
    // Rekapitulacija: prethodno 1.500.000 + priliv 1.234.567,89 − odliv 580.000 = 2.154.567,89
    expect(t).toContain("Prethodno stanje");
    expect(t).toContain("1.500.000,00");
    expect(t).toContain("1.234.567,89");
    expect(t).toContain("580.000,00");
    expect(t).toContain("2.154.567,89");
    expect(t.some((s) => s.includes("Kontrola salda:"))).toBe(true);
    expect(t.some((s) => s.startsWith("Slovima (novo stanje):"))).toBe(true);
    expect(res.fileName).toBe("Izvod-042-1.pdf");
  });

  it("neslaganje salda se ispisuje kao NEUSKLAĐENO", async () => {
    const { service, pdf } = setup(makeStatement({ closingBalance: new D("999999") }));
    await service.buildStatementPdf(1);
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(texts(dd).some((s) => s.includes("NEUSKLAĐENO"))).toBe(true);
  });

  it("izvod bez stavki se štampa sa napomenom (ne puca)", async () => {
    const { service, pdf } = setup(
      makeStatement({ lines: [], openingBalance: new D("0"), closingBalance: new D("0") }),
    );
    await service.buildStatementPdf(1);
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    const t = texts(dd);
    expect(t).toContain("IZVOD NEMA STAVKI (dan bez prometa)");
    expect(t.some((s) => s.includes("Kontrola salda nije dostupna"))).toBe(true);
  });

  it("devizni izvod dodaje kolone valute i kursa i ide položeno", async () => {
    const { service, pdf } = setup(
      makeStatement({
        currency: "EUR",
        lines: [
          {
            lineNo: 1,
            partnerAccount: "DE00 1234",
            partnerName: "Kunde GmbH",
            amount: new D("117200"),
            direction: "CREDIT",
            referenceNumber: null,
            documentDate: new Date(Date.UTC(2026, 3, 15)),
            matchedCustomerId: null,
            status: "UNMATCHED",
            currency: "EUR",
            foreignAmount: new D("1000"),
            exchangeRate: new D("117.2"),
          },
        ],
      }),
    );
    await service.buildStatementPdf(1);
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    const t = texts(dd);
    expect(dd.pageOrientation).toBe("landscape");
    expect(t).toContain("Valuta");
    expect(t).toContain("Devizni iznos (EUR)");
    // Dinarske kolone moraju nositi RSD i na deviznom izvodu.
    expect(t).toContain("Odliv (RSD)");
    expect(t).toContain("Kurs");
    expect(t).toContain("117,200000");
  });

  it("nepostojeći izvod → 404", async () => {
    const { service } = setup(null);
    await expect(service.buildStatementPdf(999)).rejects.toMatchObject({ status: 404 });
  });
});

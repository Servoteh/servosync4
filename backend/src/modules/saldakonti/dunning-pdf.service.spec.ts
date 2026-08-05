import "reflect-metadata";
import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import type { PrismaService } from "../../prisma/prisma.service";
import type { PdfService } from "../documents/pdf.service";
import type { OpenItem, OpenItemsService } from "./open-items.service";
import { DunningPdfService } from "./dunning-pdf.service";

/**
 * OPOMENA (PDF) NE SME DA ŠTAMPA DATI AVANS DOBAVLJAČU (D1, 04.08.2026).
 * ============================================================================
 * ŠTA SE DEŠAVALO PRE POPRAVKE: tabela dospelih stavki se filtrirala samo po
 * `side === "receivable"`, pa je kod partnera koji nam je i kupac i dobavljač
 * (uobičajeno) na opomenu ulazio i avans koji smo MI njemu platili (konto 1520,
 * dugovni saldo) — dug od 12.000 se štampao kao 512.000 i tako potpisivao.
 *
 * Testira se `docDefinition` (ulaz pdfmake-a); `pdf.render` je mock — isti
 * obrazac kao `compensation-pdf.service.spec.ts`.
 */

const D = Prisma.Decimal;
const AS_OF = new Date("2026-08-02T00:00:00.000Z");

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

function item(over: Partial<OpenItem>): OpenItem {
  return {
    accountCode: "2040",
    analyticalCode: 77,
    documentNumber: "7/26",
    balance: new D("12000"),
    totalDebit: new D("12000"),
    totalCredit: new D("0"),
    dueDate: new Date("2026-06-01T00:00:00.000Z"),
    daysOverdue: 62,
    currency: "RSD",
    side: "receivable",
    partnerScope: "customer",
    fxAmount: null,
    fxCurrency: null,
    ledgerEntryIds: [1],
    ...over,
  };
}

/** Isti partner: naša faktura njemu (2040) i avans koji smo mi njemu platili (1520). */
const ITEMS: OpenItem[] = [
  item({}),
  item({
    accountCode: "1520",
    documentNumber: "AV-3/26",
    balance: new D("500000"),
    totalDebit: new D("500000"),
    dueDate: new Date("2026-03-01T00:00:00.000Z"),
    daysOverdue: 154,
    side: "receivable",
    partnerScope: "supplier",
    ledgerEntryIds: [9],
  }),
];

function setup(items: OpenItem[]) {
  const prisma = {
    company: {
      findFirst: jest.fn().mockResolvedValue({
        companyName: "Servoteh d.o.o.",
        address: "Vojvođanska 297",
        city: "Dobanovci",
        postalCode: "11272",
        taxId: "101017443",
        registrationNumber: "17400169",
        bankAccount: "160-000",
        phone: null,
        email: null,
      }),
    },
    customer: {
      findUnique: jest.fn().mockResolvedValue({
        id: 77,
        name: "Metalprodukt d.o.o.",
        address: "Karađorđeva 118",
        postalCode: "11000",
        city: "Beograd",
        taxId: "100200300",
        registrationNumber: "20123456",
      }),
    },
  };
  const pdf = { render: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4")) };
  const openItems = { listOpenItems: jest.fn().mockResolvedValue(items) };
  const service = new DunningPdfService(
    prisma as unknown as PrismaService,
    pdf as unknown as PdfService,
    openItems as unknown as OpenItemsService,
  );
  return { service, pdf };
}

describe("DunningPdfService — na opomeni je samo kupčev dug", () => {
  it("dati avans dobavljaču (1520) ne ulazi u tabelu ni u zbir", async () => {
    const { service, pdf } = setup(ITEMS);

    await service.buildDunningPdf(77, 3, AS_OF);
    const t = texts(pdf.render.mock.calls[0][0] as TDocumentDefinitions);

    expect(t).toContain("7/26");
    expect(t).not.toContain("AV-3/26");
    expect(t.some((s) => s.includes("12.000,00 RSD"))).toBe(true);
    expect(t.some((s) => s.includes("512.000,00"))).toBe(false);
    // Najstarije kašnjenje je kupčevih 62 dana, ne 154 sa avansa.
    expect(t).toContain("Najstarije kašnjenje: 62 dana.");
  });

  it("kad partner ima SAMO dati avans, opomena je prazna (ne štampa se tuđi dug)", async () => {
    const { service, pdf } = setup([ITEMS[1]]);

    await service.buildDunningPdf(77, 3, AS_OF);
    const t = texts(pdf.render.mock.calls[0][0] as TDocumentDefinitions);

    expect(t).toContain("Nema dospelih neizmirenih stavki na dan preseka.");
    expect(t).not.toContain("AV-3/26");
  });
});

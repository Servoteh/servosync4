import "reflect-metadata";
import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { JournalBookPrintService } from "./journal-book-print.service";
import { AccountCardPrintService } from "./account-card-print.service";
import { TrialBalancePrintService } from "./trial-balance-print.service";

/**
 * Štampe knjiga glavne knjige (dnevnik / kartica konta / bruto bilans). Testira se
 * `docDefinition` (pdfmake ulaz), ne sam PDF — `pdf.render` je mock. Pokriva ono
 * što je najlakše tiho polomiti: naslov, SVE kolone, zbirni red, ponovljeno
 * zaglavlje (`headerRows`), grupisanje hiljada i prazan izveštaj.
 */

const D = Prisma.Decimal;

/** Svi tekstovi iz docDefinition-a (rekurzivno) — za `toContain` provere. */
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

/**
 * Tabela DOKUMENTA (ne traka filtera, koja je takođe `table`) — prepoznaje se po
 * zaglavlju kolona u prvom redu (ćelije sa stilom `th`).
 */
function firstTable(dd: TDocumentDefinitions): {
  headerRows?: number;
  body: unknown[][];
} {
  const content = dd.content as Array<{
    table?: { headerRows?: number; body: unknown[][] };
  }>;
  const node = content.find((c) => {
    const head = c?.table?.body?.[0];
    return (
      Array.isArray(head) &&
      head.some(
        (cell) => (cell as { style?: string } | undefined)?.style === "th",
      )
    );
  });
  if (!node?.table) throw new Error("docDefinition nema tabelu dokumenta");
  return node.table;
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

function pdfMock() {
  return { render: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4")) };
}

describe("JournalBookPrintService (dnevnik knjiženja)", () => {
  function setup(rows: unknown[]) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      customer: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 7, name: "Metalprodukt" }]),
      },
      company: { findFirst: jest.fn().mockResolvedValue(COMPANY) },
    };
    const pdf = pdfMock();
    const service = new JournalBookPrintService(
      prisma as unknown as PrismaService,
      pdf as unknown as PdfService,
    );
    return { service, pdf };
  }

  const row = {
    journal_number: "0002",
    order_type_code: "IFR",
    posting_date: new Date(Date.UTC(2026, 2, 14)),
    document_date: new Date(Date.UTC(2026, 2, 14)),
    account_code: "2040",
    analytical_code: 7,
    document_number: "IFR-0001/2026",
    description: "Faktura",
    debit: new D("1234567.89"),
    credit: new D("0"),
  };

  it("štampa naslov, sve kolone, zbir i grupisane hiljade", async () => {
    const { service, pdf } = setup([row]);
    await service.buildJournalBookPdf({ year: 2026 });
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    const t = texts(dd);

    expect(t).toContain("DNEVNIK KNJIŽENJA");
    for (const col of [
      "R.br.",
      "Nalog",
      "Vrsta",
      "Datum naloga",
      "Konto",
      "Šifra kom.",
      "Komitent",
      "Broj dokumenta",
      "Datum dok.",
      "Opis",
      "Duguje",
      "Potražuje",
    ]) {
      expect(t).toContain(col);
    }
    expect(t).toContain("UKUPNO");
    expect(t).toContain("1.234.567,89"); // tačka za hiljade, zarez za decimalu
    expect(t).toContain("14.03.2026."); // dd.MM.yyyy.
    expect(t).toContain("Metalprodukt");
  });

  it("ponavlja zaglavlje tabele na svakoj strani i ide položeno", async () => {
    const { service, pdf } = setup([row]);
    await service.buildJournalBookPdf({ year: 2026 });
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(firstTable(dd).headerRows).toBe(1);
    expect(dd.pageOrientation).toBe("landscape");
  });

  it("prazan dnevnik se štampa sa napomenom (ne puca)", async () => {
    const { service, pdf } = setup([]);
    const res = await service.buildJournalBookPdf({ year: 1999 });
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(texts(dd)).toContain("NEMA STAVKI ZA ZADATE USLOVE");
    expect(res.fileName).toBe("Dnevnik-knjizenja-1999.pdf");
  });

  it("kontrolni red prijavljuje neuravnotežen zbir", async () => {
    const { service, pdf } = setup([row]); // duguje 1.234.567,89 vs potražuje 0
    await service.buildJournalBookPdf({ year: 2026 });
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(texts(dd).some((s) => s.includes("NEUSKLAĐENO"))).toBe(true);
  });
});

describe("AccountCardPrintService (kartica konta)", () => {
  function setup(rows: unknown[]) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      account: {
        findUnique: jest.fn().mockResolvedValue({ name: "Kupci u zemlji" }),
      },
      customer: { findMany: jest.fn().mockResolvedValue([]) },
      company: { findFirst: jest.fn().mockResolvedValue(COMPANY) },
    };
    const pdf = pdfMock();
    const service = new AccountCardPrintService(
      prisma as unknown as PrismaService,
      pdf as unknown as PdfService,
    );
    return { service, pdf };
  }

  const mk = (debit: string, credit: string) => ({
    journal_number: "0002",
    order_type_code: "IFR",
    posting_date: new Date(Date.UTC(2026, 2, 14)),
    document_date: new Date(Date.UTC(2026, 2, 14)),
    document_number: "IFR-0001/2026",
    analytical_code: null,
    cost_center: null,
    due_date: null,
    description: "Faktura",
    debit: new D(debit),
    credit: new D(credit),
  });

  it("prikazuje naziv konta, sve kolone i tekući saldo", async () => {
    const { service, pdf } = setup([mk("1000", "0"), mk("0", "400")]);
    await service.buildAccountCardPdf({ accountCode: "2040" });
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    const t = texts(dd);

    expect(t).toContain("KARTICA KONTA");
    expect(t).toContain("Konto 2040 — Kupci u zemlji");
    for (const col of ["Duguje", "Potražuje", "Saldo", "Nalog", "Vrsta"]) {
      expect(t).toContain(col);
    }
    // running saldo posle druge stavke = 1000 − 400
    expect(t).toContain("600,00");
    expect(firstTable(dd).headerRows).toBe(1);
  });

  it("nepostojeći konto → prazna kartica sa napomenom, bez greške", async () => {
    const { service, pdf } = setup([]);
    const res = await service.buildAccountCardPdf({ accountCode: "9999" });
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(texts(dd)).toContain("NEMA STAVKI ZA ZADATE USLOVE");
    expect(res.fileName).toBe("Kartica-konta-9999.pdf");
  });
});

describe("TrialBalancePrintService (bruto bilans)", () => {
  function setup(rows: unknown[]) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      account: {
        findMany: jest.fn().mockResolvedValue([
          { code: "2040", name: "Kupci u zemlji" },
          { code: "4350", name: "Dobavljači u zemlji" },
        ]),
      },
      company: { findFirst: jest.fn().mockResolvedValue(COMPANY) },
    };
    const pdf = pdfMock();
    const service = new TrialBalancePrintService(
      prisma as unknown as PrismaService,
      pdf as unknown as PdfService,
    );
    return { service, pdf };
  }

  const rows = [
    {
      account_code: "2040",
      ps_debit: new D("250000"),
      ps_credit: new D("0"),
      turn_debit: new D("1000"),
      turn_credit: new D("0"),
    },
    {
      account_code: "4350",
      ps_debit: new D("0"),
      ps_credit: new D("250000"),
      turn_debit: new D("0"),
      turn_credit: new D("1000"),
    },
  ];

  it("štampa PS/promet/saldo kolone, međuzbir klase i veliki zbir", async () => {
    const { service, pdf } = setup(rows);
    await service.buildTrialBalancePdf({ year: 2026 });
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    const t = texts(dd);

    expect(t).toContain("BRUTO BILANS");
    for (const col of [
      "PS duguje",
      "PS potražuje",
      "Promet duguje",
      "Promet potražuje",
      "Saldo duguje",
      "Saldo potražuje",
    ]) {
      expect(t).toContain(col);
    }
    expect(t).toContain("Σ KLASA 2");
    expect(t).toContain("Σ KLASA 4");
    expect(t).toContain("VELIKI ZBIR");
    // Σ saldo duguje == Σ saldo potražuje → usklađeno
    expect(t.some((s) => s.includes("bilans je usklađen"))).toBe(true);
  });

  it("nesaglasan saldo se prijavljuje kao NEUSKLAĐENO", async () => {
    const { service, pdf } = setup([rows[0]]);
    await service.buildTrialBalancePdf({ year: 2026 });
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(texts(dd).some((s) => s.includes("NEUSKLAĐENO"))).toBe(true);
  });

  it("godina bez prometa → napomena umesto neme nule", async () => {
    const { service, pdf } = setup([]);
    const res = await service.buildTrialBalancePdf({ year: 1999 });
    const dd = pdf.render.mock.calls[0][0] as TDocumentDefinitions;
    expect(texts(dd)).toContain("NEMA PROKNJIŽENIH STAVKI ZA ZADATU GODINU");
    expect(res.fileName).toBe("Bruto-bilans-1999.pdf");
  });
});

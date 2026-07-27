import "reflect-metadata";
import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { BlagajnaService } from "../blagajna.service";
import { CashJournalPdfService } from "./cash-journal-pdf.service";
import { amountInWords, fmtMoney } from "../../documents/doc-layout";

/**
 * BLAGAJNIČKI IZVEŠTAJ — test lanca salda i poštenja obrasca.
 * =========================================================================
 * Jezgro dokumenta je lanac: prethodni saldo + primitak − izdatak = novi saldo.
 * Ako se taj lanac razmakne, papir i dalje izgleda ispravno — zato test.
 * Uz to se tvrdi ono što obrazac NE sme da izmisli: apoenska specifikacija mora
 * ostati prazna, a NACRT stavke moraju biti prijavljene.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

function allText(node: unknown, acc: string[] = []): string[] {
  if (node == null) return acc;
  if (typeof node === "string") {
    acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) allText(n, acc);
    return acc;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>))
      allText(v, acc);
  }
  return acc;
}

interface EntryStub {
  entryNumber: string;
  direction: string;
  amount: Prisma.Decimal;
  entryDate: Date;
  partnerId: number | null;
  contraAccount: string;
  description: string | null;
  status: string;
  journalEntryId: number | null;
}

function setup(entries: EntryStub[], opening: Prisma.Decimal) {
  let docDef: TDocumentDefinitions = {} as TDocumentDefinitions;
  const pdf = {
    render: jest.fn((d: TDocumentDefinitions) => {
      docDef = d;
      return Promise.resolve(Buffer.from("%PDF-proba"));
    }),
  } as unknown as PdfService;

  const prisma = {
    cashJournal: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        companyId: 0,
        name: "Glavna blagajna",
        accountCode: "2430",
        currency: "RSD",
      }),
    },
    cashEntry: { findMany: jest.fn().mockResolvedValue(entries) },
    company: {
      findFirst: jest.fn().mockResolvedValue({
        companyName: "SERVOTEH d.o.o.",
        address: "Dobanovački put 1",
        city: "Zemun",
        taxId: "101017443",
        registrationNumber: "17400169",
      }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
    customer: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 7, name: "TERMOELEKTRO a.d." }]),
    },
  } as unknown as PrismaService;

  const blagajna = {
    balanceOf: jest.fn().mockResolvedValue(opening),
  } as unknown as BlagajnaService;

  const service = new CashJournalPdfService(prisma, pdf, blagajna);
  return { service, getDocDef: () => docDef, prisma };
}

function makeEntry(over: Partial<EntryStub> = {}): EntryStub {
  return {
    entryNumber: "0001/2026",
    direction: "IN",
    amount: D("1000"),
    entryDate: new Date("2026-07-15T10:00:00"),
    partnerId: 7,
    contraAccount: "2040",
    description: "Naplata gotovinskog računa",
    status: "POSTED",
    journalEntryId: 501,
    ...over,
  };
}

describe("CashJournalPdfService — blagajnički izveštaj", () => {
  it("lanac salda: prethodni + primitak − izdatak = novi saldo, i to u slovima", async () => {
    const entries = [
      makeEntry({ amount: D("68300.00") }),
      makeEntry({
        entryNumber: "0002/2026",
        direction: "OUT",
        amount: D("25000.00"),
      }),
      makeEntry({
        entryNumber: "0003/2026",
        direction: "OUT",
        amount: D("9450.75"),
      }),
    ];
    const { service, getDocDef } = setup(entries, D("150000.00"));
    await service.buildPdf({ journalId: 1, from: "2026-07-15" });

    const text = allText(getDocDef().content).join("|");
    const closing = D("150000.00").add(D("68300.00")).sub(D("34450.75"));

    expect(text).toContain(fmtMoney(D("150000.00"))); // prethodni saldo
    expect(text).toContain(fmtMoney(D("68300.00"))); // ukupni primitak
    expect(text).toContain(fmtMoney(D("34450.75"))); // odbija se izdatak
    expect(text).toContain(fmtMoney(closing)); // novi saldo
    expect(text).toContain(amountInWords(closing, "dinara"));
  });

  it("prijavljuje NACRT stavke — one ulaze u saldo, a glavna knjiga ih ne vidi", async () => {
    const entries = [
      makeEntry(),
      makeEntry({
        entryNumber: "0002/2026",
        status: "DRAFT",
        journalEntryId: null,
      }),
    ];
    const { service, getDocDef } = setup(entries, D("0"));
    await service.buildPdf({ journalId: 1, from: "2026-07-15" });

    const text = allText(getDocDef().content).join(" ");
    expect(text).toContain("1 stavki u statusu NACRT");
    // Stavka bez GK naloga ima crticu u koloni „Temeljnica", ne izmišljen broj.
    expect(text).toContain("—");
  });

  it("apoenska specifikacija se štampa PRAZNA (aplikacija apoene ne evidentira)", async () => {
    const { service, getDocDef } = setup([makeEntry()], D("0"));
    await service.buildPdf({ journalId: 1, from: "2026-07-15" });

    const text = allText(getDocDef().content).join("|");
    expect(text).toContain("APOENSKA SPECIFIKACIJA");
    expect(text).toContain("5000");
    expect(text).toContain("ČEKOVI Din.");
    expect(text).toContain("Broj priloga:");
    // Kontrolna rečenica mora da postoji — inače prazna mreža izgleda kao kvar.
    expect(text).toContain("prazna polja su namerna");
  });

  it("dan bez prometa se štampa sa napomenom i prenetim stanjem, ne puca", async () => {
    const { service, getDocDef } = setup([], D("150000.00"));
    const res = await service.buildPdf({ journalId: 1, from: "2026-02-03" });
    expect(res.fileName).toContain("2026-02-03");
    const text = allText(getDocDef().content).join("|");
    expect(text).toContain("ZA IZABRANI PERIOD NEMA PROMETA U BLAGAJNI");
    expect(text).toContain(fmtMoney(D("150000.00")));
  });

  it("kraj perioda je UKLJUČIV (stavka uneta popodne ne ispada iz dana)", async () => {
    const { service, prisma } = setup([makeEntry()], D("0"));
    await service.buildPdf({ journalId: 1, from: "2026-07-15" });
    const where = (prisma.cashEntry.findMany as unknown as jest.Mock).mock
      .calls[0][0].where as { entryDate: { gte: Date; lte: Date } };
    expect(where.entryDate.gte.getHours()).toBe(0);
    expect(where.entryDate.lte.getHours()).toBe(23);
    expect(where.entryDate.lte.getMinutes()).toBe(59);
  });

  it("odbija period kome je kraj pre početka", async () => {
    const { service } = setup([], D("0"));
    await expect(
      service.buildPdf({ journalId: 1, from: "2026-07-15", to: "2026-07-01" }),
    ).rejects.toThrow(/Kraj perioda ne može biti pre početka/);
  });
});

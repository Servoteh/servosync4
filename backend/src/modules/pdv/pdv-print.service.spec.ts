import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PdvPrintService } from "./pdv-print.service";
import { VatSanityException } from "./vat-sanity";

/**
 * Spec PDV štampe. Zaključava:
 *   1) da se NEISPRAVAN period NE štampa tiho (409 sa srpskom porukom),
 *   2) da `force` izdaje PDF isključivo sa vodenim žigom „NIJE ZA PREDAJU",
 *   3) da se pozicije PP-PDV grade iz SVIH stopa u evidenciji (ne samo 20/10),
 *      pa je Σ pozicija jednak zbirnoj poziciji 005/105,
 *   4) da neslaganje Σ pozicija sa zbirnom pozicijom takođe zaustavi štampu.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** Presretnut `PdfService` — čuva definiciju dokumenta umesto da renderuje. */
function makePdf() {
  const docs: TDocumentDefinitions[] = [];
  return {
    docs,
    service: {
      render: jest.fn().mockImplementation((doc: TDocumentDefinitions) => {
        docs.push(doc);
        return Promise.resolve(Buffer.from("%PDF-mock"));
      }),
    },
  };
}

interface RateGroup {
  direction: string;
  vatRateCode: string | null;
  base: string;
  vat: string;
}

function makePrisma(opts: {
  vatReturn?: { outputVat: string; inputVat: string; vatLiability: string; status?: string } | null;
  groups?: RateGroup[];
  /** Zbirovi knjiga koje čita provera ispravnosti. */
  books?: { direction: string; n: number; base: string; vat: string; rateCode?: string | null }[];
  control?: string | null;
  entries?: {
    documentNumber: string;
    documentDate: Date;
    partnerId: number | null;
    vatRateCode: string | null;
    vatBase: string;
    vatAmount: string;
  }[];
}) {
  const groups = opts.groups ?? [];
  const books = opts.books ?? [];
  return {
    vatReturn: {
      findFirst: jest.fn().mockResolvedValue(
        opts.vatReturn
          ? {
              id: 1,
              periodYear: 2026,
              periodMonth: 3,
              periodQuarter: null,
              status: opts.vatReturn.status ?? "CALCULATED",
              outputVat: D(opts.vatReturn.outputVat),
              inputVat: D(opts.vatReturn.inputVat),
              vatLiability: D(opts.vatReturn.vatLiability),
            }
          : null,
      ),
    },
    vatLedgerEntry: {
      groupBy: jest.fn().mockImplementation(({ where }: { where: { direction: string } }) =>
        Promise.resolve(
          groups
            .filter((g) => g.direction === where.direction)
            .map((g) => ({
              vatRateCode: g.vatRateCode,
              _sum: { vatBase: D(g.base), vatAmount: D(g.vat) },
            })),
        ),
      ),
      findMany: jest.fn().mockResolvedValue(
        (opts.entries ?? []).map((e, i) => ({
          id: i + 1,
          ...e,
          vatBase: D(e.vatBase),
          vatAmount: D(e.vatAmount),
        })),
      ),
    },
    company: { findFirst: jest.fn().mockResolvedValue(null) },
    customer: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockImplementation((q: Prisma.Sql) => {
      const text = q.strings.join("?");
      if (text.includes("FROM vat_ledger_entries")) {
        return Promise.resolve(
          books.map((b) => ({
            direction: b.direction,
            rate_code: b.rateCode ?? null,
            is_manual: false,
            n: BigInt(b.n),
            base: D(b.base),
            vat: D(b.vat),
          })),
        );
      }
      if (text.includes("le.account_code IN (")) {
        return opts.control == null
          ? Promise.resolve([{ n: BigInt(0), net: D(0) }])
          : Promise.resolve([{ n: BigInt(1), net: D(opts.control) }]);
      }
      return Promise.resolve([]);
    }),
  };
}

/** Skupi sav tekst iz pdfmake definicije (rekurzivno). */
function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node + " ";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") {
    return Object.values(node as Record<string, unknown>).map(textOf).join("");
  }
  return "";
}

/** ISPRAVAN mart 2026 (posle ispravke): povraćaj 21.602.289,89 vs BigBit 21.602.291. */
const MART_OK = {
  vatReturn: {
    outputVat: "5086854.53",
    inputVat: "26689144.42",
    vatLiability: "-21602289.89",
  },
  groups: [
    { direction: "output", vatRateCode: "20", base: "25465063.95", vat: "5086854.53" },
    { direction: "input", vatRateCode: "20", base: "193494716.15", vat: "26678543.93" },
    { direction: "input", vatRateCode: "10", base: "106004.90", vat: "10600.49" },
  ],
  // Osnovica je tačno 5× PDV (stopa 20%) — provera P5 traži da se slažu.
  books: [
    { direction: "output", n: 43, base: "25434272.65", vat: "5086854.53", rateCode: "20" },
    { direction: "input", n: 666, base: "133445722.10", vat: "26689144.42", rateCode: "20" },
  ],
  control: "21602291.00",
};

describe("PdvPrintService.buildPpPdvPdf", () => {
  it("ispravan period se štampa bez žiga i sa tačnim povraćajem", async () => {
    const pdf = makePdf();
    const svc = new PdvPrintService(makePrisma(MART_OK) as never, pdf.service as never);
    const res = await svc.buildPpPdvPdf("2026-03");

    expect(res.fileName).toBe("pp-pdv-2026-03.pdf");
    expect(res.sanity.ok).toBe(true);
    const doc = pdf.docs[0];
    expect(doc.watermark).toBeUndefined();
    const text = textOf(doc.content);
    // pozicija 110 (povraćaj) mora nositi 21.602.289,89 — ne 1.236.156,30
    expect(text).toContain("21.602.289,89");
    expect(text).not.toContain("1.236.156,30");
  });

  it("pozicije se grade iz SVIH stopa u evidenciji (i 8%), ne samo 20/10", async () => {
    const pdf = makePdf();
    const svc = new PdvPrintService(
      makePrisma({
        ...MART_OK,
        vatReturn: { outputVat: "5186854.53", inputVat: "26689144.42", vatLiability: "-21502289.89" },
        groups: [
          ...MART_OK.groups,
          { direction: "output", vatRateCode: "8", base: "1250000.00", vat: "100000.00" },
        ],
        books: [
          { direction: "output", n: 44, base: "26715063.95", vat: "5186854.53" },
          { direction: "input", n: 666, base: "193600721.05", vat: "26689144.42" },
        ],
        control: "21502291.00",
      }) as never,
      pdf.service as never,
    );
    await svc.buildPpPdvPdf("2026-03");
    const text = textOf(pdf.docs[0].content);
    expect(text).toContain("8%"); // grupa dobija svoj red iako nema zvaničnu poziciju
    expect(text).toContain("100.000,00"); // PDV grupe koja bi ranije tiho ispala
  });

  it("Σ pozicija po stopama ≠ zbirna pozicija 005/105 → 409, ne tiha štampa", async () => {
    const pdf = makePdf();
    const svc = new PdvPrintService(
      makePrisma({
        ...MART_OK,
        // VatReturn kaže 5.186.854,53, a grupe po stopama daju 5.086.854,53
        vatReturn: { outputVat: "5186854.53", inputVat: "26689144.42", vatLiability: "-21502289.89" },
        control: "21502291.00",
      }) as never,
      pdf.service as never,
    );
    await expect(svc.buildPpPdvPdf("2026-03")).rejects.toThrow(
      /zbir obračunatog PDV po stopama .* ne odgovara ukupnom iznosu u poziciji 005 \/ 105/s,
    );
    expect(pdf.service.render).not.toHaveBeenCalled();
  });

  it("force izdaje PDF, ali OBAVEZNO sa crvenim vodenim žigom", async () => {
    const pdf = makePdf();
    const svc = new PdvPrintService(
      makePrisma({
        ...MART_OK,
        vatReturn: { outputVat: "-1236156.30", inputVat: "0", vatLiability: "-1236156.30" },
        books: [
          { direction: "output", n: 34, base: "0", vat: "-1236156.30" },
          { direction: "input", n: 625, base: "0", vat: "0" },
        ],
        groups: [{ direction: "output", vatRateCode: "20", base: "0", vat: "-1236156.30" }],
      }) as never,
      pdf.service as never,
    );
    const res = await svc.buildPpPdvPdf("2026-03", { force: true });
    expect(res.sanity.ok).toBe(false);
    const doc = pdf.docs[0];
    expect((doc.watermark as { text: string }).text).toContain("NIJE ZA PREDAJU");
    expect(textOf(doc.content)).toContain("PDV EVIDENCIJA NIJE ISPRAVNA");
  });
});

describe('PdvPrintService — „van PDV" ulazni račun (bez prava na odbitak)', () => {
  /**
   * Reprodukovan otkaz: `sumByRate` je brojala i VP stavke, a `VatReturn.inputVat`
   * ih po pravilu obračuna NE sadrži — pa je provera „Σ pozicija = ukupno" pucala
   * tačno za iznos VP stavke i PP-PDV se NIJE MOGAO odštampati. Reč je o sasvim
   * običnom slučaju (reprezentacija, putnički automobil).
   */
  const withVp = {
    ...MART_OK,
    groups: [
      ...MART_OK.groups,
      { direction: "input", vatRateCode: "VP", base: "100000.00", vat: "20000.00" },
    ],
  };

  it("VP stavka NE obara štampu PP-PDV obrasca", async () => {
    const pdf = makePdf();
    const svc = new PdvPrintService(makePrisma(withVp) as never, pdf.service as never);
    const res = await svc.buildPpPdvPdf("2026-03");
    expect(res.sanity.ok).toBe(true);
    expect(pdf.docs[0].watermark).toBeUndefined();
  });

  it("VP se prikazuje kao zaseban red ISPOD 008/108, van zbira pretporeza", async () => {
    const pdf = makePdf();
    const svc = new PdvPrintService(makePrisma(withVp) as never, pdf.service as never);
    await svc.buildPpPdvPdf("2026-03");
    const text = textOf(pdf.docs[0].content);
    expect(text).toContain("BEZ prava na odbitak");
    expect(text).toContain("20.000,00");
    // ...ali marker se NE sme štampati kao poreska stopa („VP%")
    expect(text).not.toContain("VP%");
  });

  it('u KIF/KUF specifikaciji marker je „bez odbitka", nikad „VP%"', async () => {
    const pdf = makePdf();
    const svc = new PdvPrintService(
      makePrisma({
        ...MART_OK,
        entries: [
          {
            documentNumber: "UF-REPR-1/2026",
            documentDate: new Date("2026-03-11T00:00:00.000Z"),
            partnerId: null,
            vatRateCode: "VP",
            vatBase: "100000.00",
            vatAmount: "20000.00",
          },
        ],
      }) as never,
      pdf.service as never,
    );
    await svc.buildLedgerSpecPdf("input", 2026, 3);
    const text = textOf(pdf.docs[0].content);
    expect(text).toContain("bez odbitka");
    expect(text).not.toContain("VP%");
  });
});

describe("PdvPrintService.buildLedgerSpecPdf", () => {
  it("KUF sa 625 stavki i ukupnim zbirom 0,00 se NE štampa (409)", async () => {
    const pdf = makePdf();
    const svc = new PdvPrintService(
      makePrisma({
        books: [{ direction: "input", n: 625, base: "0", vat: "0" }],
        control: "21602291.00",
        entries: [],
      }) as never,
      pdf.service as never,
    );
    await expect(svc.buildLedgerSpecPdf("input", 2026, 3)).rejects.toBeInstanceOf(
      VatSanityException,
    );
    await expect(svc.buildLedgerSpecPdf("input", 2026, 3)).rejects.toThrow(
      /Zaustavljeno: Štampa KUF specifikacije za 03\/2026/,
    );
    expect(pdf.service.render).not.toHaveBeenCalled();
  });

  it("ispravan KIF se štampa; podnožje UKUPNO se slaže sa zbirom redova", async () => {
    const pdf = makePdf();
    const svc = new PdvPrintService(
      makePrisma({
        ...MART_OK,
        entries: [
          {
            documentNumber: "IF-1/2026",
            documentDate: new Date("2026-03-10T00:00:00.000Z"),
            partnerId: null,
            vatRateCode: "20",
            vatBase: "20000000.00",
            vatAmount: "4000000.00",
          },
          {
            documentNumber: "IF-2/2026",
            documentDate: new Date("2026-03-20T00:00:00.000Z"),
            partnerId: null,
            vatRateCode: "20",
            vatBase: "5465063.95",
            vatAmount: "1086854.53",
          },
        ],
      }) as never,
      pdf.service as never,
    );
    const res = await svc.buildLedgerSpecPdf("output", 2026, 3);
    expect(res.fileName).toBe("kif-2026-03.pdf");
    const text = textOf(pdf.docs[0].content);
    expect(text).toContain("UKUPNO");
    expect(text).toContain("25.465.063,95"); // Σ osnovica redova
    expect(text).toContain("5.086.854,53"); // Σ PDV redova
    expect(pdf.docs[0].watermark).toBeUndefined();
  });
});

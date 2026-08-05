/**
 * POSTING ENGINE — robna grana (`postFromStockDocument`), tri dokazana kvara.
 * =========================================================================
 * Nalazi su izmereni probnim knjiženjem na test bazi `servosync_probno`
 * (`scripts/proof-knjizenje-po-semama.ts`, 05.08.2026), a ovde su zaključani bez baze:
 *
 *   §1  red naloga NIJE nosio `document_number` / `due_date` / `currency` (svi NULL) →
 *       otvorene stavke se u `GROUP BY (konto, komitent, document_number)` slile u jednu;
 *   §2  dokument BEZ STAVKI je davao nalog bez ijednog reda, dobijao broj i zaključavao
 *       dokument (`POSTED`) — tiha rupa bez greške i bez traga;
 *   §3  linija se nije zaokruživala pre upisa, pa je nalog balansirao u memoriji a NE u
 *       koloni `numeric(19,4)` (izmereno ΣDug 0,0006 ≠ ΣPot 0,0007).
 *
 * Prisma je stubovana (obrazac `gl-write.service.spec.ts`) — testira se motor, ne baza.
 * Šema u stubu je verna kopija BigBit šeme 33 (IFR) sa produkcije.
 */
import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../../prisma/prisma.service";
import {
  LedgerNotBalancedException,
  PostingEngineService,
} from "./posting.service";

const D = Prisma.Decimal;

interface CreatedLine {
  accountCode: string;
  analyticalCode: number | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  description: string | null;
  documentNumber: string | null;
  dueDate: Date | null;
  currency: string | null;
  sourceGoodsDocId: number | null;
}

/** Stavka robnog dokumenta — samo kolone koje motor čita. */
function stockItem(over: Partial<Record<string, unknown>> = {}) {
  return {
    quantity: new D(1),
    purchasePriceNet: new D(6000),
    dependentCostOwn: new D(0),
    dependentCostSupplier: new D(0),
    calculatedWholesalePrice: new D(10000),
    actualWholesalePrice: new D(10000),
    fee: new D(0),
    goodsTaxRateCode: "3", // 20 % (VISA)
    ...over,
  };
}

/**
 * Šema 33 „Izlazna faktura — roba" (BigBit, prepisana sa produkcije):
 * kupac O+P+Q duguje, izlazni PDV P potražuje, prihod O potražuje,
 * zaliha A potražuje, nabavna vrednost prodate robe A duguje.
 */
const SEMA_33 = [
  {
    lineNo: 1,
    accountCode: "2040",
    defDebit: "O+P+Q",
    defCredit: null,
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 2,
    accountCode: "4702",
    defDebit: null,
    defCredit: "P",
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 3,
    accountCode: "6040",
    defDebit: null,
    defCredit: "O",
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 4,
    accountCode: "1320",
    defDebit: null,
    defCredit: "A",
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 5,
    accountCode: "5010",
    defDebit: "A",
    defCredit: null,
    postsAnalytics: true,
    description: null,
  },
];

const DATUM = new Date("2026-08-05T10:00:00.000Z");
const DOSPECE = new Date("2026-09-04T00:00:00.000Z");

function makeEngine(
  over: {
    items?: Array<ReturnType<typeof stockItem>>;
    schemeLines?: typeof SEMA_33;
    postingTemplate?: number;
    /** Prodajni dokument vezan za izdatnicu (`invoices.stock_document_id`). */
    salesDoc?: { dueDate: Date | null; currency: string } | null;
    customerId?: number | null;
  } = {},
) {
  const doc = {
    id: 77,
    companyId: 0,
    kind: "IZ",
    documentTypeCode: "IFR",
    documentNumber: "9001/2026",
    year: 2026,
    warehouseId: 1,
    supplierId: null,
    customerId: over.customerId === undefined ? 11568 : over.customerId,
    documentDate: DATUM,
    postingDate: DATUM,
    isImport: false,
    workOrderId: null,
    projectId: null,
    status: "DRAFT",
  };

  const created: Array<{ lines: { create: CreatedLine[] } }> = [];
  const journalEntry = {
    findFirst: jest.fn(() => Promise.resolve(null)),
    findMany: jest.fn(() => Promise.resolve([])), // nextJournalNumber → "0001"
    delete: jest.fn(() => Promise.resolve({})),
    create: jest.fn((args: { data: { lines: { create: CreatedLine[] } } }) => {
      created.push(args.data);
      return Promise.resolve({ id: 501, lines: args.data.lines.create });
    }),
  };
  const stockDocumentUpdate = jest.fn(() => Promise.resolve(doc));

  const tx = {
    $executeRaw: jest.fn(() => Promise.resolve(1)),
    stockDocument: {
      findUniqueOrThrow: jest.fn(() => Promise.resolve(doc)),
      update: stockDocumentUpdate,
    },
    stockDocumentItem: {
      findMany: jest.fn(() => Promise.resolve(over.items ?? [stockItem()])),
    },
    documentType: {
      findFirstOrThrow: jest.fn(() =>
        Promise.resolve({
          code: "IFR",
          postingTemplate: over.postingTemplate ?? 33,
          isInbound: false,
        }),
      ),
    },
    accountingScheme: {
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({
          id: 33,
          orderType: "IFR",
          description: "Izlazna faktura - roba",
          lines: over.schemeLines ?? SEMA_33,
        }),
      ),
    },
    invoice: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          over.salesDoc === undefined
            ? { dueDate: DOSPECE, currency: "RSD" }
            : over.salesDoc,
        ),
      ),
    },
    journalEntry,
  };

  const prisma = {
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  return {
    engine: new PostingEngineService(prisma),
    tx,
    created,
    journalEntry,
    stockDocumentUpdate,
    doc,
  };
}

describe("PostingEngineService.postFromStockDocument", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // §1 — broj dokumenta / dospeće / valuta na SVAKOM redu
  // ───────────────────────────────────────────────────────────────────────────
  describe("§1 polja otvorene stavke", () => {
    it("svaki red nosi broj dokumenta, dospeće i valutu (ne NULL)", async () => {
      const h = makeEngine();

      await h.engine.postFromStockDocument(77);

      const lines = h.created[0].lines.create;
      expect(lines).toHaveLength(5);
      for (const l of lines) {
        expect(l.documentNumber).toBe("9001/2026"); // broj ROBNOG dokumenta
        expect(l.dueDate).toEqual(DOSPECE); // dospeće sa prodajnog dokumenta
        expect(l.currency).toBe("RSD");
      }
      // Bez ovoga bi se sve fakture istom kupcu na 2040 slile u jednu otvorenu stavku.
      const kupac = lines.find((l) => l.accountCode === "2040");
      expect(kupac?.documentNumber).toBe("9001/2026");
      expect(kupac?.analyticalCode).toBe(11568);
    });

    it("valuta i dospeće prodajnog dokumenta se prenose (izvoz u EUR)", async () => {
      const h = makeEngine({
        salesDoc: { dueDate: DOSPECE, currency: "EUR" },
      });

      await h.engine.postFromStockDocument(77);

      for (const l of h.created[0].lines.create) {
        expect(l.currency).toBe("EUR");
        expect(l.dueDate).toEqual(DOSPECE);
      }
    });

    it("popis (bez prodajnog dokumenta): broj ostaje, dospeće null, valuta RSD", async () => {
      const h = makeEngine({ salesDoc: null, customerId: null });

      await h.engine.postFromStockDocument(77);

      for (const l of h.created[0].lines.create) {
        expect(l.documentNumber).toBe("9001/2026");
        expect(l.dueDate).toBeNull();
        expect(l.currency).toBe("RSD");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §2 — dokument bez stavki / nalog bez ijedne ne-nulte linije
  // ───────────────────────────────────────────────────────────────────────────
  describe("§2 prazan nalog", () => {
    it("dokument BEZ STAVKI se odbija i NE zaključava se", async () => {
      const h = makeEngine({ items: [] });

      await expect(h.engine.postFromStockDocument(77)).rejects.toThrow(
        UnprocessableEntityException,
      );
      await expect(h.engine.postFromStockDocument(77)).rejects.toThrow(
        /nema nijednu stavku/,
      );
      // Ni nalog ni prelaz u POSTED — dokument ostaje promenjiv.
      expect(h.journalEntry.create).not.toHaveBeenCalled();
      expect(h.stockDocumentUpdate).not.toHaveBeenCalled();
    });

    it("dokument sa stavkama na NULU se odbija (sve linije šeme nula)", async () => {
      const h = makeEngine({
        items: [
          stockItem({
            purchasePriceNet: new D(0),
            calculatedWholesalePrice: new D(0),
            actualWholesalePrice: new D(0),
          }),
        ],
      });

      await expect(h.engine.postFromStockDocument(77)).rejects.toThrow(
        /sve linije šeme su nula/,
      );
      expect(h.journalEntry.create).not.toHaveBeenCalled();
      expect(h.stockDocumentUpdate).not.toHaveBeenCalled();
    });

    it("iznos ispod pare (0,00004) je u koloni nula → nalog se ne upisuje", async () => {
      // A = O = 0,00004 → svaka linija zaokružena na numeric(19,4) daje 0,0000.
      const h = makeEngine({
        items: [
          stockItem({
            quantity: new D("0.00004"),
            purchasePriceNet: new D(1),
            calculatedWholesalePrice: new D(1),
            actualWholesalePrice: new D(1),
            goodsTaxRateCode: "1", // 0 % — bez PDV linije
          }),
        ],
      });

      await expect(h.engine.postFromStockDocument(77)).rejects.toThrow(
        /sve linije šeme su nula/,
      );
      expect(h.journalEntry.create).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §3 — zaokruživanje linije PRE upisa i PRE balans-kontrole
  // ───────────────────────────────────────────────────────────────────────────
  describe("§3 zaokruživanje na skalu kolone", () => {
    it("nalog koji balansira u memoriji a NE u bazi se ODBIJA", async () => {
      // Izmereno na test bazi: kol 0,0005 × cena 0,50 → u memoriji ΣDug = ΣPot = 0,00055,
      // a u koloni numeric(19,4) ΣDug 0,0006 ≠ ΣPot 0,0007 (svaka linija se zaokruži sama).
      const h = makeEngine({
        items: [
          stockItem({
            quantity: new D("0.0005"),
            purchasePriceNet: new D("0.5"),
            calculatedWholesalePrice: new D("0.5"),
            actualWholesalePrice: new D("0.5"),
          }),
        ],
      });

      await expect(h.engine.postFromStockDocument(77)).rejects.toThrow(
        LedgerNotBalancedException,
      );
      // Ništa nije upisano i dokument nije zaključan (rollback bi to i inače vratio,
      // ali se ovde vidi da motor odustane PRE upisa).
      expect(h.journalEntry.create).not.toHaveBeenCalled();
      expect(h.stockDocumentUpdate).not.toHaveBeenCalled();
    });

    it("iznos se upisuje ZAOKRUŽEN na 4 decimale (kolona numeric(19,4))", async () => {
      // A = 6.000,00005 → linije 1320/5010 moraju u bazu kao 6.000,0001, ne 6.000,00005.
      const h = makeEngine({
        items: [stockItem({ purchasePriceNet: new D("6000.00005") })],
      });

      const vracene = await h.engine.postFromStockDocument(77);

      const lines = h.created[0].lines.create;
      const zaliha = lines.find((l) => l.accountCode === "1320");
      const nabavna = lines.find((l) => l.accountCode === "5010");
      expect(zaliha?.credit.toString()).toBe("6000.0001");
      expect(nabavna?.debit.toString()).toBe("6000.0001");
      // Kupac i prihod ostaju netaknuti (već su na 4 decimale).
      expect(
        lines.find((l) => l.accountCode === "2040")?.debit.toString(),
      ).toBe("12000");
      // Povratna vrednost = ono što je upisano (motor je vraćao nezaokružene iznose).
      expect(
        vracene.find((l) => l.accountCode === "1320")?.credit.toString(),
      ).toBe("6000.0001");
    });

    it("nalog bez sitniša prolazi nepromenjen (regresija: iznosi se ne pomeraju)", async () => {
      const h = makeEngine();

      await h.engine.postFromStockDocument(77);

      const iznosi = h.created[0].lines.create.map((l) => [
        l.accountCode,
        l.debit.toFixed(2),
        l.credit.toFixed(2),
      ]);
      expect(iznosi).toEqual([
        ["2040", "12000.00", "0.00"],
        ["4702", "0.00", "2000.00"],
        ["6040", "0.00", "10000.00"],
        ["1320", "0.00", "6000.00"],
        ["5010", "6000.00", "0.00"],
      ]);
    });
  });
});

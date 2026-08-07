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
 *       koloni `numeric(19,4)` (izmereno ΣDug 0,0006 ≠ ΣPot 0,0007);
 *   §4  (07.08.2026) dokument je nosio PDV po stopi za koju ŠEMA NEMA RED — porez je nestajao
 *       bez traga, a nalog je pri tom balansirao. Izmereno na šemi 36 (IFGP, gotov proizvod):
 *       stavka na 10 % daje 2040 duguje SAMO osnovicu, PDV od 1.000 ni na jednom kontu,
 *       ΣDug 16.000 = ΣPot 16.000 → ni kontrola ravnoteže ne reaguje.
 *
 * Prisma je stubovana (obrazac `gl-write.service.spec.ts`) — testira se motor, ne baza.
 * Šeme u stubu su verne kopije BigBit šema 33 (IFR) i 36 (IFGP) sa produkcije.
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
 * Šema 33 „Izlazna faktura — roba" (BigBit, prepisana sa produkcije — `accounting_scheme_lines`,
 * ponovo izmerena 07.08.2026): kupac `O+P+Q` duguje, izlazni PDV 20 % `P` potražuje na 4702,
 * izlazni PDV 10 % `Q` potražuje na **4710**, prihod `O` potražuje, zaliha `A` potražuje,
 * nabavna vrednost prodate robe `A` duguje.
 *
 * ⚠️ Red `4710 / Q` je ovde do 07.08.2026. NEDOSTAJAO iako stub tvrdi da je kopija produkcije.
 * Na stavci od 20 % se to ne vidi (`Q` = 0 → red se ionako odbaci kao nula), pa je nedostatak
 * bio nevidljiv — ali je stub time lažno prikazivao šemu 33 kao šemu bez snižene stope, tj.
 * kao istu rupu koju šema 36 stvarno ima. Razlika između te dve šeme je poenta §4.
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
    accountCode: "4710",
    defDebit: null,
    defCredit: "Q",
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 4,
    accountCode: "6040",
    defDebit: null,
    defCredit: "O",
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 5,
    accountCode: "1320",
    defDebit: null,
    defCredit: "A",
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 6,
    accountCode: "5010",
    defDebit: "A",
    defCredit: null,
    postsAnalytics: true,
    description: null,
  },
];

/**
 * Šema 36 „IZLAZ GOT.PROIZVODA" (BigBit, prepisana sa produkcije — `accounting_scheme_lines`,
 * merenje 07.08.2026). ⚠️ NEMA REDA ZA SNIŽENU STOPU: slot `Q` (izlazni PDV 10 %) se ne
 * pominje ni u jednom `defDebit`/`defCredit`. Kupac se zadužuje sa `O+P`, ne `O+P+Q`.
 */
const SEMA_36 = [
  {
    lineNo: 1,
    accountCode: "2040",
    defDebit: "O+P",
    defCredit: null,
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 2,
    accountCode: "6141",
    defDebit: null,
    defCredit: "O",
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 3,
    accountCode: "4701",
    defDebit: null,
    defCredit: "P",
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 4,
    accountCode: "9600",
    defDebit: null,
    defCredit: "A",
    postsAnalytics: true,
    description: null,
  },
  {
    lineNo: 5,
    accountCode: "9800",
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
    /** Vrsta dokumenta + šema (default IFR/33; za gotov proizvod IFGP/36). */
    documentTypeCode?: string;
    schemeId?: number;
    orderType?: string;
    isInbound?: boolean;
    /** Predmet na zaglavlju izdatnice (`stock_documents.project_id`) i njegov broj. */
    projectId?: number | null;
    projectNumber?: string | null;
    /** Naziv komitenta (`customers.name`); `null` = komitent ne postoji u šifarniku. */
    customerName?: string | null;
  } = {},
) {
  const documentTypeCode = over.documentTypeCode ?? "IFR";
  const schemeId = over.schemeId ?? 33;
  const doc = {
    id: 77,
    companyId: 0,
    kind: "IZ",
    documentTypeCode,
    documentNumber: "9001/2026",
    year: 2026,
    warehouseId: 1,
    supplierId: null,
    customerId: over.customerId === undefined ? 11568 : over.customerId,
    documentDate: DATUM,
    postingDate: DATUM,
    isImport: false,
    workOrderId: null,
    projectId: over.projectId ?? null,
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
          code: documentTypeCode,
          postingTemplate: over.postingTemplate ?? schemeId,
          isInbound: over.isInbound ?? false,
        }),
      ),
    },
    accountingScheme: {
      findUniqueOrThrow: jest.fn(() =>
        Promise.resolve({
          id: schemeId,
          orderType: over.orderType ?? documentTypeCode,
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
    // Naziv komitenta i broj predmeta idu u OPIS reda naloga (§5). Oba se čitaju samo
    // kad zaglavlje dokumenta nosi šifru — stub to verno prati (`null` → motor ne pita).
    customer: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          over.customerName === null
            ? null
            : { name: over.customerName ?? "FMB d.o.o." },
        ),
      ),
    },
    project: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          over.projectNumber == null
            ? null
            : { projectNumber: over.projectNumber },
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

  // ───────────────────────────────────────────────────────────────────────────
  // §4 — PDV po stopi za koju šema NEMA red (odluka knjigovođe 07.08.2026)
  // ───────────────────────────────────────────────────────────────────────────
  describe("§4 stopa koju šema ne knjiži", () => {
    /** Gotov proizvod na 10 % — šema 36 nema slot `Q`, pa PDV nema gde da legne. */
    const gpNa10 = () =>
      makeEngine({
        documentTypeCode: "IFGP",
        schemeId: 36,
        orderType: "IFGP",
        schemeLines: SEMA_36,
        items: [stockItem({ goodsTaxRateCode: "4" })], // NIZA = 10 %
      });

    it("🔴 IFGP sa stavkom na sniženu stopu (10 %) se ODBIJA — PDV bi nestao a nalog bi balansirao", async () => {
      // Zatečeno ponašanje (bez brane): 2040 duguje 10.000 (samo osnovica), 6141 potražuje
      // 10.000, PDV od 1.000 nigde, 9600/9800 po 6.000 → ΣDug 16.000 = ΣPot 16.000. Nalog
      // prolazi kontrolu ravnoteže i dokument se ZAKLJUČAVA sa knjigom bez poreza.
      const h = gpNa10();

      await expect(h.engine.postFromStockDocument(77)).rejects.toThrow(
        UnprocessableEntityException,
      );
      // Ni nalog ni prelaz u POSTED — dokument ostaje promenjiv da se tarifa ispravi.
      expect(h.journalEntry.create).not.toHaveBeenCalled();
      expect(h.stockDocumentUpdate).not.toHaveBeenCalled();
    });

    it("poruka kaže KOJA stopa, KOLIKO poreza bi nestalo i ZAŠTO", async () => {
      // Poruka je jedino što magacioner/knjigovođa vidi — mora sama da objasni šta da uradi.
      for (const ocekivano of [
        /sniženom stopom \(10 %\)/, // KOJA stopa
        /šema za kontiranje 36 \(IFGP\) NEMA red za tu stopu/, // ZAŠTO ne prolazi
        /1000\.00/, // KOLIKO poreza bi ispalo (10.000 × 10 %)
        /iz glavne knjige i iz PDV prijave/, // POSLEDICA
        /07\.08\.2026/, // odluka knjigovođe
        /Ispravi poresku tarifu/, // ŠTA DALJE
      ]) {
        await expect(gpNa10().engine.postFromStockDocument(77)).rejects.toThrow(
          ocekivano,
        );
      }
    });

    it("isti gotov proizvod na OPŠTOJ stopi (20 %) prolazi nepromenjen", async () => {
      // Kontrolna grupa: brana ne sme da dira ono što danas legitimno prolazi. Izmereno na
      // produkciji — svih 28 stavki IFGP naloga u 2026. je po 20 % (4701/6141 = 0,200000).
      const h = makeEngine({
        documentTypeCode: "IFGP",
        schemeId: 36,
        orderType: "IFGP",
        schemeLines: SEMA_36,
      });

      await h.engine.postFromStockDocument(77);

      const iznosi = h.created[0].lines.create.map((l) => [
        l.accountCode,
        l.debit.toFixed(2),
        l.credit.toFixed(2),
      ]);
      expect(iznosi).toEqual([
        ["2040", "12000.00", "0.00"],
        ["6141", "0.00", "10000.00"],
        ["4701", "0.00", "2000.00"],
        ["9600", "0.00", "6000.00"],
        ["9800", "6000.00", "0.00"],
      ]);
    });

    it("oslobođen promet (stopa 0 %) prolazi — brana se okida SAMO na ne-nulti porez", async () => {
      const h = makeEngine({
        documentTypeCode: "IFGP",
        schemeId: 36,
        orderType: "IFGP",
        schemeLines: SEMA_36,
        items: [stockItem({ goodsTaxRateCode: "1" })], // BEZPDV = 0 %
      });

      await h.engine.postFromStockDocument(77);

      expect(h.journalEntry.create).toHaveBeenCalled();
      // Bez PDV reda (4701 = 0 → odbačen), kupac duguje samo osnovicu.
      const lines = h.created[0].lines.create;
      expect(lines.map((l) => l.accountCode)).toEqual([
        "2040",
        "6141",
        "9600",
        "9800",
      ]);
      expect(lines[0].debit.toFixed(2)).toBe("10000.00");
    });

    it("šema 33 (IFR) knjiži i sniženu stopu — roba na 10 % i dalje prolazi", async () => {
      // Dokaz da brana gleda ŠEMU, a ne stopu: ista stavka na 10 % pod šemom koja ima slot
      // `Q` (4710) prolazi i porez legne na konto. Da je brana vezana za „stopa 10 % = stop",
      // ovaj test bi pao i oborila bi prodaju robe po sniženoj stopi.
      const h = makeEngine({
        items: [stockItem({ goodsTaxRateCode: "4" })],
      });

      await h.engine.postFromStockDocument(77);

      const lines = h.created[0].lines.create;
      expect(
        lines.find((l) => l.accountCode === "4710")?.credit.toFixed(2),
      ).toBe("1000.00");
      // Kupac je zadužen za osnovicu + PDV (10.000 + 1.000), a ne samo za osnovicu.
      expect(
        lines.find((l) => l.accountCode === "2040")?.debit.toFixed(2),
      ).toBe("11000.00");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // §5 — OPIS reda naloga (`ledger_entries.description`)
  //
  // Zatečeno stanje (07.08.2026, dan paljenja prekidača): opis se uzimao ISKLJUČIVO iz
  // `accounting_scheme_lines.description`, a tamo je na produkciji 76 od 78 linija prazno
  // → svaki novi nalog nosi prazan opis. Knjigovođa taj podatak popunjava ručno
  // („broj RN za koji je izlazna faktura vezana"), pa bi se posao gomilao od prvog naloga.
  // ───────────────────────────────────────────────────────────────────────────
  describe("§5 opis reda naloga", () => {
    it("🔴 SVAKI red nosi opis izveden iz dokumenta (ne prazan, ne iz šeme)", async () => {
      const h = makeEngine();

      await h.engine.postFromStockDocument(77);

      const lines = h.created[0].lines.create;
      expect(lines).toHaveLength(5);
      for (const l of lines) {
        expect(l.description).toBe("IFR 9001/2026 · FMB d.o.o.");
      }
    });

    it("dokument SA predmetom nosi i broj predmeta (ono što je knjigovođa kucao rukom)", async () => {
      // Izmereno nad uvezenom knjigom 2026: 106 od 118 opisa je doslovno
      // `projects.project_number`; 0 od 118 je `work_orders.ident_number`.
      const h = makeEngine({ projectId: 10466, projectNumber: "9997" });

      await h.engine.postFromStockDocument(77);

      for (const l of h.created[0].lines.create) {
        expect(l.description).toBe("IFR 9001/2026 · predmet 9997 · FMB d.o.o.");
      }
    });

    it("popis (bez komitenta i bez predmeta): opis je vrsta + broj, nikad prazan", async () => {
      const h = makeEngine({ salesDoc: null, customerId: null });

      await h.engine.postFromStockDocument(77);

      for (const l of h.created[0].lines.create) {
        expect(l.description).toBe("IFR 9001/2026");
      }
      // Komitenta nema → šifarnik se i ne pita (nema šta da se traži).
      expect(h.tx.customer.findUnique).not.toHaveBeenCalled();
    });

    it("komitent koji ne postoji u šifarniku ne obara knjiženje — opis ostane bez naziva", async () => {
      const h = makeEngine({ customerName: null });

      await h.engine.postFromStockDocument(77);

      for (const l of h.created[0].lines.create) {
        expect(l.description).toBe("IFR 9001/2026");
      }
    });

    it("opis iz ŠEME se više ne prepisuje u red (na produkciji je to doslovna nula)", async () => {
      // `IFGP`/`2040` na produkciji nosi `description = "0"` — jedina popunjena linija među
      // upaljenim vrstama. Da se prepisuje, taj red bi i dalje glasio „0".
      const h = makeEngine({
        documentTypeCode: "IFGP",
        schemeId: 36,
        orderType: "IFGP",
        schemeLines: SEMA_36.map((l) =>
          l.accountCode === "2040" ? { ...l, description: "0" } : l,
        ),
      });

      await h.engine.postFromStockDocument(77);

      const kupac = h.created[0].lines.create.find(
        (l) => l.accountCode === "2040",
      );
      expect(kupac?.description).toBe("IFGP 9001/2026 · FMB d.o.o.");
    });

    it("predugačak naziv komitenta se seče na 255 znakova (kolona VarChar(255))", async () => {
      const h = makeEngine({ customerName: "К".repeat(300) });

      await h.engine.postFromStockDocument(77);

      for (const l of h.created[0].lines.create) {
        expect(l.description).not.toBeNull();
        expect(l.description!.length).toBe(255);
        expect(l.description!.startsWith("IFR 9001/2026 · ")).toBe(true);
        expect(l.description!.endsWith("…")).toBe(true);
      }
    });

    it("iznosi i konta ostaju NEDIRNUTI kad se opis doda (regresija)", async () => {
      const h = makeEngine({ projectId: 10466, projectNumber: "9997" });

      await h.engine.postFromStockDocument(77);

      expect(
        h.created[0].lines.create.map((l) => [
          l.accountCode,
          l.debit.toFixed(2),
          l.credit.toFixed(2),
        ]),
      ).toEqual([
        ["2040", "12000.00", "0.00"],
        ["4702", "0.00", "2000.00"],
        ["6040", "0.00", "10000.00"],
        ["1320", "0.00", "6000.00"],
        ["5010", "6000.00", "0.00"],
      ]);
    });
  });
});

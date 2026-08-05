import { UnprocessableEntityException } from "@nestjs/common";
import type { PrismaService } from "../../prisma/prisma.service";
import { DocumentSequencesService } from "./document-sequences.service";
import { INVOICE_SEQUENCE_KEY } from "../sales/numbering.service";

/**
 * EKRAN „BROJAČI DOKUMENATA" (odluka O-F11, 05.08.2026).
 * =============================================================================
 * Vlasnik: „Startni broj moramo da možemo da unesemo negde u podešavanju… i IFR i
 * profaktura i ponuda itd."
 *
 * Testira se četvoro, i svako od njih je nastalo iz konkretnog kvara:
 *  1. PRAZAN REGISTAR NIJE PRAZNA STRANA — na produkciji `document_number_sequences`
 *     ima 0 redova; ekran građen iz baze bi bio prazan baš tamo gde se startni broj
 *     upisuje, i O-F11 ne bi imala gde da se sprovede.
 *  2. SLEDEĆI BROJ se vidi unapred — čovek ne proverava `last_number`, nego kako će
 *     izgledati sledeći dokument (`PROF-12/26`).
 *  3. BRANA pri upisu: vrednost niža od onoga što knjiga već ima se ODBIJA. Bez toga
 *     polje rešava samo prvi dan.
 *  4. TRAG IZMENE ide u istoj transakciji sa izmenom, sa obe strane („sa čega na šta").
 */

/** Šta je „u knjizi": `measureBookUsageAll` (ceo ekran) i `measureBookUsage` (jedna serija). */
interface BookSeed {
  /** Za ceo ekran: `{prefix, yy, max_seq, entry_count}`. */
  all?: Array<{
    prefix: string;
    yy: string;
    max_seq: number | null;
    entry_count: number;
  }>;
  /** Za jednu seriju (poziv iz `setLastNumber`). */
  one?: { max_seq: number | null; entry_count: number };
}

function makePrisma(
  seed: {
    sequences?: Array<{
      documentType: string;
      year: number;
      lastNumber: number;
    }>;
    book?: BookSeed;
    audit?: Array<Record<string, unknown>>;
  } = {},
) {
  const auditRows = seed.audit ?? [];
  const created: Array<Record<string, unknown>> = [];
  const upserted: Array<Record<string, unknown>> = [];

  const tx = {
    documentNumberSequence: {
      findUnique: jest.fn(
        (args: {
          where: {
            documentType_year_companyId: {
              documentType: string;
              year: number;
              companyId: number;
            };
          };
        }) => {
          const k = args.where.documentType_year_companyId;
          const row = (seed.sequences ?? []).find(
            (r) => r.documentType === k.documentType && r.year === k.year,
          );
          return Promise.resolve(
            row ? { id: 1, lastNumber: row.lastNumber } : null,
          );
        },
      ),
      upsert: jest.fn(
        (args: {
          where: {
            documentType_year_companyId: {
              documentType: string;
              year: number;
              companyId: number;
            };
          };
          update: { lastNumber: number };
        }) => {
          const k = args.where.documentType_year_companyId;
          const row = {
            id: 1,
            documentType: k.documentType,
            year: k.year,
            companyId: k.companyId,
            lastNumber: args.update.lastNumber,
          };
          upserted.push(row);
          return Promise.resolve(row);
        },
      ),
    },
    auditLog: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve(args.data);
      }),
    },
  };

  const prisma = {
    documentNumberSequence: {
      findMany: jest.fn(() =>
        Promise.resolve(
          (seed.sequences ?? []).map((r) => ({
            documentType: r.documentType,
            year: r.year,
            lastNumber: r.lastNumber,
          })),
        ),
      ),
    },
    auditLog: {
      findMany: jest.fn(() => Promise.resolve(auditRows)),
    },
    // Jedan `$queryRaw` opslužuje oba merenja; razlikuju se po obliku rezultata.
    // `measureBookUsageAll` traži redove sa `prefix`/`yy`, `measureBookUsage` jedan red.
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = strings.join(" ");
      if (sql.includes("GROUP BY"))
        return Promise.resolve(seed.book?.all ?? []);
      return Promise.resolve([
        seed.book?.one ?? { max_seq: null, entry_count: 0 },
      ]);
    }),
    $transaction: jest.fn(
      async (fn: (t: typeof tx) => Promise<unknown>) => await fn(tx),
    ),
  };

  return { prisma, tx, created, upserted };
}

function makeService(prisma: ReturnType<typeof makePrisma>["prisma"]) {
  return new DocumentSequencesService(prisma as unknown as PrismaService);
}

describe(`DocumentSequencesService — ekran „Brojači dokumenata" (O-F11)`, () => {
  describe("pregled", () => {
    it(`PRAZAN REGISTAR nije prazna strana — sve serije se vide kao „još nije izdat nijedan broj"`, async () => {
      // Na produkciji je tabela imala 0 redova. Ovo je test koji brani da se ekran ikad
      // ne veže za bazu: bez serija na ekranu, startni broj se nema gde upisati.
      const { prisma } = makePrisma();
      const res = await makeService(prisma).overview();

      const serije = new Set(res.data.rows.map((r) => r.seriesKey));
      expect(serije).toEqual(
        new Set([INVOICE_SEQUENCE_KEY, "AVR", "PROF", "PON", "REV"]),
      );
      for (const r of res.data.rows) {
        expect(r.neverIssued).toBe(true);
        expect(r.lastNumber).toBeNull();
      }
    });

    it("prikazuje KAKO ĆE IZGLEDATI SLEDEĆI BROJ, ne samo brojač", async () => {
      const { prisma } = makePrisma({
        sequences: [{ documentType: "PROF", year: 2026, lastNumber: 11 }],
      });
      const res = await makeService(prisma).overview(0, 2026);

      const prof = res.data.rows.find((r) => r.seriesKey === "PROF");
      expect(prof?.lastNumber).toBe(11);
      expect(prof?.nextNumber).toBe("PROF-12/26");

      // Serija bez reda kreće od 1 — i to se vidi, ne pogađa.
      const pon = res.data.rows.find((r) => r.seriesKey === "PON");
      expect(pon?.nextNumber).toBe("PON-1/26");
      // Izlazne fakture nemaju prefiks (O-F1/O-F5) — papir, SEF i knjiga nose isti broj.
      const fakture = res.data.rows.find(
        (r) => r.seriesKey === INVOICE_SEQUENCE_KEY,
      );
      expect(fakture?.nextNumber).toBe("1/26");
    });

    it("UPOZORAVA kad brojač zaostaje za knjigom, umesto da obori ekran", async () => {
      // Ekran mora da se otvori i onda (naročito onda) kad je stanje loše — inače čovek
      // koji dolazi da to popravi dobije grešku umesto ekrana na kom se popravlja.
      const { prisma } = makePrisma({
        book: {
          all: [{ prefix: "", yy: "26", max_seq: 261, entry_count: 2453 }],
        },
      });
      const res = await makeService(prisma).overview(0, 2026);

      const fakture = res.data.rows.find(
        (r) => r.seriesKey === INVOICE_SEQUENCE_KEY,
      );
      expect(fakture?.book.maxNumber).toBe("261/26");
      expect(fakture?.warning).toContain("261/26");
      expect(fakture?.warning).toContain("261");

      // Druge serije nisu dirnute — knjiga o njima ne zna ništa.
      expect(
        res.data.rows.find((r) => r.seriesKey === "PON")?.warning,
      ).toBeNull();
    });

    it("🔴 meri SAMO kupčevu stranu knjige (dobavljačevi brojevi se ne broje)", async () => {
      // IZMERENO NA PRODUKCIJI 05.08.2026: `ledger_entries.document_number` drži i
      // DOBAVLJAČEVE brojeve sa ulaznih faktura. Brojevi oblika `N/26` bez prefiksa:
      //   konto 435 (dobavljači) → najveći 14.630 · konto 270 (PDV ulazni) → 138.030
      //   konto 204 (KUPCI)      → najveći      261  ← jedini koji je NAŠ niz
      // Bez ograničenja na klasu 20, ekran bi tražio startni broj 138.030, a brana bi
      // odbijala tačnu vrednost 261 — alat protiv greške postao bi alat koji tačan
      // unos ne dozvoljava. Zato se ograničenje proverava kao ugovor, ne kao detalj.
      const { prisma } = makePrisma();
      await makeService(prisma).overview(0, 2026);
      await makeService(prisma).setLastNumber(
        { userId: 1, email: "admin@servoteh.com" },
        { seriesKey: INVOICE_SEQUENCE_KEY, year: 2026, lastNumber: 261 },
      );

      const sqls = prisma.$queryRaw.mock.calls.map((c: unknown[]) =>
        (c[0] as TemplateStringsArray).join(" "),
      );
      expect(sqls.length).toBeGreaterThanOrEqual(2); // pregled + provera pri upisu
      for (const sql of sqls) expect(sql).toContain("account_code LIKE");
    });

    it("kad je brojač podešen na visinu knjige, nema upozorenja", async () => {
      const { prisma } = makePrisma({
        sequences: [
          { documentType: INVOICE_SEQUENCE_KEY, year: 2026, lastNumber: 261 },
        ],
        book: {
          all: [{ prefix: "", yy: "26", max_seq: 261, entry_count: 2453 }],
        },
      });
      const res = await makeService(prisma).overview(0, 2026);
      const fakture = res.data.rows.find(
        (r) => r.seriesKey === INVOICE_SEQUENCE_KEY,
      );
      expect(fakture?.warning).toBeNull();
      expect(fakture?.nextNumber).toBe("262/26");
    });
  });

  describe("upis startnog broja", () => {
    it("upisuje poslednji izdati broj i vraća sledeći", async () => {
      const { prisma, upserted } = makePrisma();
      const res = await makeService(prisma).setLastNumber(
        { userId: 65, email: "jelena.stanisic@servoteh.com" },
        { seriesKey: INVOICE_SEQUENCE_KEY, year: 2027, lastNumber: 110 },
      );

      expect(upserted[0]).toMatchObject({
        documentType: INVOICE_SEQUENCE_KEY,
        year: 2027,
        companyId: 0,
        lastNumber: 110,
      });
      expect(res.data.nextNumber).toBe("111/27");
    });

    it("🔴 BRANA: broj niži od onoga što knjiga već ima se ODBIJA", async () => {
      // Bez ovoga polje rešava samo prvi dan: greška u kucanju („16" umesto „261")
      // isplivala bi mesecima kasnije, mid-knjiženje, i to nekom drugom.
      const { prisma, upserted } = makePrisma({
        book: { one: { max_seq: 261, entry_count: 2453 } },
      });

      await expect(
        makeService(prisma).setLastNumber(
          { userId: 1, email: "admin@servoteh.com" },
          { seriesKey: INVOICE_SEQUENCE_KEY, year: 2026, lastNumber: 16 },
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      // Ništa nije upisano — brana staje PRE izmene.
      expect(upserted).toHaveLength(0);
    });

    it("poruka brane imenuje izmereni broj i kaže šta da se upiše", async () => {
      const { prisma } = makePrisma({
        book: { one: { max_seq: 261, entry_count: 2453 } },
      });
      await expect(
        makeService(prisma).setLastNumber(
          { userId: 1, email: "admin@servoteh.com" },
          { seriesKey: INVOICE_SEQUENCE_KEY, year: 2026, lastNumber: 16 },
        ),
      ).rejects.toThrow(/261\/26/);
    });

    it("upis TAČNO na visinu knjige PROLAZI (261 → sledeći 262/26)", async () => {
      // `last_number` je POSLEDNJI IZDATI broj: 261 znači da je `261/26` već izdat, pa
      // je sledeći `262/26` — prvi slobodan. Da je brana `<=`, tačan unos bi bio odbijen.
      const { prisma } = makePrisma({
        book: { one: { max_seq: 261, entry_count: 2453 } },
      });
      const res = await makeService(prisma).setLastNumber(
        { userId: 1, email: "admin@servoteh.com" },
        { seriesKey: INVOICE_SEQUENCE_KEY, year: 2026, lastNumber: 261 },
      );
      expect(res.data.nextNumber).toBe("262/26");
    });

    it("nepoznata serija se odbija i nabraja dozvoljene", async () => {
      const { prisma } = makePrisma();
      await expect(
        makeService(prisma).setLastNumber(
          { userId: 1, email: "admin@servoteh.com" },
          { seriesKey: "IFR", year: 2026, lastNumber: 5 },
        ),
      ).rejects.toThrow(/@FAKTURA/);
    });

    it("negativan broj se odbija", async () => {
      const { prisma } = makePrisma();
      await expect(
        makeService(prisma).setLastNumber(
          { userId: 1, email: "admin@servoteh.com" },
          { seriesKey: "PON", year: 2026, lastNumber: -1 },
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe("trag izmene", () => {
    it("upisuje KO, KAD i SA ČEGA NA ŠTA — u istoj transakciji sa izmenom", async () => {
      const { prisma, created } = makePrisma({
        sequences: [
          { documentType: INVOICE_SEQUENCE_KEY, year: 2027, lastNumber: 40 },
        ],
      });
      await makeService(prisma).setLastNumber(
        { userId: 65, email: "jelena.stanisic@servoteh.com" },
        {
          seriesKey: INVOICE_SEQUENCE_KEY,
          year: 2027,
          lastNumber: 110,
          note: "preuzimanje 01.04.2027",
        },
      );

      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        actorUserId: 65,
        actorUsername: "jelena.stanisic@servoteh.com",
        action: "SET_LAST_NUMBER",
        entityType: "document_number_sequences",
        entityId: `${INVOICE_SEQUENCE_KEY}|2027|0`,
        beforeData: { lastNumber: 40 },
        afterData: { lastNumber: 110 },
      });
      expect(created[0].metadata).toMatchObject({
        note: "preuzimanje 01.04.2027",
        nextNumber: "111/27",
      });
    });

    it("`updated_at` NE služi kao trag — zato postoji audit red", async () => {
      // Numeracija menja `updated_at` pri SVAKOM knjiženju, pa bi svaka faktura
      // izgledala kao da je neko dirao podešavanje. Trag mora da bude zaseban upis.
      const { prisma, created } = makePrisma();
      await makeService(prisma).setLastNumber(
        { userId: 1, email: "admin@servoteh.com" },
        { seriesKey: "PON", year: 2026, lastNumber: 3 },
      );
      expect(created[0].beforeData).toEqual({ lastNumber: null });
      expect(created[0].afterData).toEqual({ lastNumber: 3 });
    });

    it("pregled vraća poslednju izmenu uz red serije", async () => {
      const { prisma } = makePrisma({
        audit: [
          {
            actorUserId: 65,
            actorUsername: "jelena.stanisic@servoteh.com",
            beforeData: { lastNumber: 0 },
            afterData: { lastNumber: 261 },
            metadata: {
              seriesKey: INVOICE_SEQUENCE_KEY,
              year: 2026,
              companyId: 0,
              note: "startno stanje",
            },
            createdAt: new Date("2026-08-05T10:00:00Z"),
            entityId: `${INVOICE_SEQUENCE_KEY}|2026|0`,
          },
        ],
      });
      const res = await makeService(prisma).overview(0, 2026);
      const fakture = res.data.rows.find(
        (r) => r.seriesKey === INVOICE_SEQUENCE_KEY,
      );
      expect(fakture?.lastChange).toMatchObject({
        byEmail: "jelena.stanisic@servoteh.com",
        from: 0,
        to: 261,
        note: "startno stanje",
      });
    });
  });
});

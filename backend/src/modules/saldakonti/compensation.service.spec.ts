/**
 * KOMPENZACIJA — autorizacija podataka nad reprezentativnim stavkama (D1) i
 * osnova za pun/delimičan offset (D2).
 * =========================================================================
 * Testovi brane dva defekta koja su proizvodila PROKNJIŽEN I POTPISAN nalog:
 *   D1 — `ledgerEntryId` se nije proveravao ni po vlasništvu ni po statusu, pa je
 *        poslat tuđi id zatvarao fakturu trećeg komitenta (ispravka = storno +
 *        ručna rekonstrukcija saldakonta dva komitenta).
 *   D2 — upit članova grupe je bio jedino mesto u domenu bez predikata „proknjižen
 *        nalog", pa su NACRTI ulazili u `openBalanceAbs` i klasifikacija
 *        pun/delimičan offset je izlazila pogrešna.
 *
 * Prisma se mockuje sa STVARNIM filterima (`in`, `not`, nested `journalEntry.status`)
 * nad malim skladištem stavki — inače bi test prošao i bez dodatog predikata.
 */

import { Prisma } from "@prisma/client";
import type { PrismaService } from "../../prisma/prisma.service";
import type { PostingEngineService } from "../gl/posting/posting.service";
import type { OpenItemsService } from "./open-items.service";
import type { ReconciliationService } from "./reconciliation.service";
import { CompensationService } from "./compensation.service";
import {
  CompensationEntryRejectedException,
  type RejectedCompensationEntry,
} from "./compensation-entry-guard";
import type { CreateCompensationDto } from "./dto/saldakonti.dto";

const D = Prisma.Decimal;

/** KMP nalog koji knjižni motor kreira u toku testa. */
const KMP_JOURNAL_ID = 900;

const PARTNER = 100;
const OTHER_PARTNER = 88;

interface LedgerRow {
  id: number;
  accountCode: string;
  analyticalCode: number | null;
  documentNumber: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  reconciledAt: Date | null;
  journalEntryId: number;
}

/** Nalozi GK — samo status, to je sve što upiti gledaju. */
type JournalStore = Map<number, { id: number; status: string }>;

function ledgerRow(over: Partial<LedgerRow> & { id: number }): LedgerRow {
  return {
    accountCode: "2040",
    analyticalCode: PARTNER,
    documentNumber: "F-1/26",
    debit: new D(0),
    credit: new D(0),
    reconciledAt: null,
    journalEntryId: 800,
    ...over,
  };
}

/** Jedan filter polja: skalar, `{ in: [...] }` ili `{ not: v }`. */
function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if ("in" in c) return (c.in as unknown[]).includes(value);
    if ("not" in c) return value !== c.not;
    throw new Error(`Mock ne zna filter: ${JSON.stringify(cond)}`);
  }
  return value === cond;
}

function rowMatches(
  row: LedgerRow,
  where: Record<string, unknown>,
  journals: JournalStore,
): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "journalEntry") {
      // Nested relacija — jedini uslov koji kod koristi je status naloga.
      const je = journals.get(row.journalEntryId);
      const sub = cond as { status?: unknown };
      if (sub.status !== undefined && !fieldMatches(je?.status, sub.status)) {
        return false;
      }
      continue;
    }
    if (!fieldMatches((row as unknown as Record<string, unknown>)[key], cond)) {
      return false;
    }
  }
  return true;
}

interface Harness {
  service: CompensationService;
  ledger: Map<number, LedgerRow>;
  journals: JournalStore;
  postManualEntry: jest.Mock;
  /** Linije prosleđene knjižnom motoru (za proveru konta/komitenta). */
  lastLines: () => Array<Record<string, unknown>>;
}

function makeService(
  rows: LedgerRow[],
  journalStatuses: Record<number, string>,
): Harness {
  const ledger = new Map(rows.map((r) => [r.id, { ...r }]));
  const journals: JournalStore = new Map(
    Object.entries(journalStatuses).map(([id, status]) => [
      Number(id),
      { id: Number(id), status },
    ]),
  );
  let nextLedgerId = 1000;

  const ledgerEntry = {
    findMany: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        [...ledger.values()]
          .filter((r) => rowMatches(r, where, journals))
          .map((r) => ({
            ...r,
            journalEntry: journals.get(r.journalEntryId) ?? {
              id: r.journalEntryId,
              status: "DRAFT",
            },
          })),
      ),
    ),
    updateMany: jest.fn(
      ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: { reconciledAt?: Date };
      }) => {
        let count = 0;
        for (const r of ledger.values()) {
          if (!rowMatches(r, where, journals)) continue;
          if (data.reconciledAt !== undefined)
            r.reconciledAt = data.reconciledAt;
          count++;
        }
        return Promise.resolve({ count });
      },
    ),
  };

  interface OrderLine {
    id: number;
    ledgerEntryId: number | null;
    side: string;
    amount: Prisma.Decimal;
    lineNo: number;
  }
  interface OrderRow {
    id: number;
    partnerId: number;
    compensationNumber: string;
    date: Date;
    status: string;
    totalAmount: Prisma.Decimal;
    journalEntryId: number | null;
    lines: OrderLine[];
  }
  const orders = new Map<number, OrderRow>();
  let nextOrderId = 1;
  let nextLineId = 1;

  const compensationOrder = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const linesInput = (
        data.lines as { create: Array<Record<string, unknown>> }
      ).create;
      const row: OrderRow = {
        id: nextOrderId++,
        partnerId: data.partnerId as number,
        compensationNumber: data.compensationNumber as string,
        date: data.date as Date,
        status: data.status as string,
        totalAmount: data.totalAmount as Prisma.Decimal,
        journalEntryId: null,
        lines: linesInput.map((l) => ({
          id: nextLineId++,
          ledgerEntryId: (l.ledgerEntryId as number | null) ?? null,
          side: l.side as string,
          amount: l.amount as Prisma.Decimal,
          lineNo: l.lineNo as number,
        })),
      };
      orders.set(row.id, row);
      return Promise.resolve(row);
    }),
    findUniqueOrThrow: jest.fn(({ where }: { where: { id: number } }) => {
      const row = orders.get(where.id);
      if (!row) throw new Error(`Kompenzacija ${where.id} ne postoji (mock).`);
      return Promise.resolve(row);
    }),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { id: number };
        data: Record<string, unknown>;
      }) => {
        const row = orders.get(where.id);
        Object.assign(row as object, data);
        return Promise.resolve(row);
      },
    ),
    findFirst: jest.fn(() => Promise.resolve(null)),
  };

  const tx = { ledgerEntry, compensationOrder };
  const prisma = {
    ledgerEntry,
    compensationOrder,
    customer: {
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve({ id: where.id }),
      ),
    },
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  // Knjižni motor: upisuje KMP protivstavke u isto skladište (proknjižen nalog),
  // tačno kao produkcijski `postManualEntry` — inače isključivanje sopstvene
  // protivstavke iz `openBalanceAbs` ne bi bilo provereno.
  const postManualEntry = jest.fn(
    (
      _tx: unknown,
      params: { lines: Array<Record<string, unknown>> },
    ): Promise<{
      journalEntryId: number;
      number: string;
      lineCount: number;
    }> => {
      journals.set(KMP_JOURNAL_ID, { id: KMP_JOURNAL_ID, status: "POSTED" });
      for (const l of params.lines) {
        const id = nextLedgerId++;
        ledger.set(
          id,
          ledgerRow({
            id,
            accountCode: l.accountCode as string,
            analyticalCode: (l.analyticalCode as number | null) ?? null,
            documentNumber: (l.documentNumber as string | null) ?? null,
            debit: new D((l.debit as number) ?? 0),
            credit: new D((l.credit as number) ?? 0),
            journalEntryId: KMP_JOURNAL_ID,
          }),
        );
      }
      return Promise.resolve({
        journalEntryId: KMP_JOURNAL_ID,
        number: "0001",
        lineCount: params.lines.length,
      });
    },
  );

  const service = new CompensationService(
    prisma,
    {} as unknown as OpenItemsService,
    {} as unknown as ReconciliationService,
    { postManualEntry } as unknown as PostingEngineService,
  );

  return {
    service,
    ledger,
    journals,
    postManualEntry,
    lastLines: () =>
      (
        postManualEntry.mock.calls.at(-1)?.[1] as {
          lines: Array<Record<string, unknown>>;
        }
      ).lines,
  };
}

function dto(
  lines: Array<{
    ledgerEntryId: number;
    side: "receivable" | "payable";
    amount: string;
  }>,
  over: Partial<CreateCompensationDto> = {},
): CreateCompensationDto {
  return {
    partnerId: PARTNER,
    compensationNumber: "0001/2026",
    date: "2026-08-04",
    post: true,
    lines,
    ...over,
  };
}

/** Odbijena greška + njen mašinski čitljiv spisak. */
async function expectRejected(
  promise: Promise<unknown>,
): Promise<{ message: string; rejected: RejectedCompensationEntry[] }> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CompensationEntryRejectedException);
  const ex = err as CompensationEntryRejectedException;
  const res = ex.getResponse() as {
    message: string;
    details: { rejected: RejectedCompensationEntry[] };
  };
  return { message: res.message, rejected: res.details.rejected };
}

describe("CompensationService — autorizacija stavki (D1)", () => {
  it("odbija ledgerEntryId DRUGOG komitenta i IMENUJE ga u poruci", async () => {
    const h = makeService(
      [
        ledgerRow({ id: 1, debit: new D(1000) }),
        // Stavka tuđeg komitenta — proknjižena i otvorena, razlika je SAMO vlasništvo.
        ledgerRow({
          id: 77,
          accountCode: "4350",
          analyticalCode: OTHER_PARTNER,
          documentNumber: "R-9/26",
          credit: new D(1000),
          journalEntryId: 802,
        }),
      ],
      { 800: "POSTED", 802: "POSTED" },
    );

    const { message, rejected } = await expectRejected(
      h.service.create(
        dto([
          { ledgerEntryId: 1, side: "receivable", amount: "1000.00" },
          { ledgerEntryId: 77, side: "payable", amount: "1000.00" },
        ]),
      ),
    );

    expect(message).toContain("stavka 77");
    expect(message).toContain(`komitentu ${OTHER_PARTNER}`);
    expect(message).toContain(`komitenta ${PARTNER}`);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].ledgerEntryId).toBe(77);
    expect(rejected[0].reason).toContain("pripada komitentu 88");
    // Ceo zahtev pada — nijedan nalog nije proknjižen i nijedna stavka zatvorena.
    expect(h.postManualEntry).not.toHaveBeenCalled();
    expect(h.ledger.get(1)?.reconciledAt).toBeNull();
    expect(h.ledger.get(77)?.reconciledAt).toBeNull();
  });

  it("odbija stavku na DRAFT nalogu (nacrt se ne prebija)", async () => {
    const h = makeService(
      [
        ledgerRow({ id: 1, debit: new D(1000) }),
        ledgerRow({
          id: 4,
          accountCode: "4350",
          documentNumber: "R-9/26",
          credit: new D(1000),
          journalEntryId: 803,
        }),
      ],
      { 800: "POSTED", 803: "DRAFT" },
    );

    const { message, rejected } = await expectRejected(
      h.service.create(
        dto([
          { ledgerEntryId: 1, side: "receivable", amount: "1000.00" },
          { ledgerEntryId: 4, side: "payable", amount: "1000.00" },
        ]),
      ),
    );

    expect(message).toContain("stavka 4");
    expect(message).toContain("nije proknjižen");
    expect(message).toContain("DRAFT");
    expect(rejected).toHaveLength(1);
    expect(h.postManualEntry).not.toHaveBeenCalled();
  });

  it("odbija VEĆ ZATVORENU stavku (dvostruko prebijanje istog duga)", async () => {
    const h = makeService(
      [
        ledgerRow({ id: 1, debit: new D(1000) }),
        ledgerRow({
          id: 5,
          accountCode: "4350",
          documentNumber: "R-9/26",
          credit: new D(1000),
          journalEntryId: 802,
          reconciledAt: new Date("2026-07-01T10:00:00Z"),
        }),
      ],
      { 800: "POSTED", 802: "POSTED" },
    );

    const { message, rejected } = await expectRejected(
      h.service.create(
        dto([
          { ledgerEntryId: 1, side: "receivable", amount: "1000.00" },
          { ledgerEntryId: 5, side: "payable", amount: "1000.00" },
        ]),
      ),
    );

    expect(message).toContain("stavka 5");
    expect(message).toContain("već je zatvorena 2026-07-01");
    expect(rejected).toHaveLength(1);
    expect(h.postManualEntry).not.toHaveBeenCalled();
  });

  it("nepostojeći ledgerEntryId se ne preskače tiho nego odbija", async () => {
    const h = makeService(
      [
        ledgerRow({ id: 1, debit: new D(1000) }),
        ledgerRow({
          id: 2,
          accountCode: "4350",
          documentNumber: "R-9/26",
          credit: new D(1000),
          journalEntryId: 802,
        }),
      ],
      { 800: "POSTED", 802: "POSTED" },
    );

    const { message } = await expectRejected(
      h.service.create(
        dto([
          { ledgerEntryId: 1, side: "receivable", amount: "1000.00" },
          { ledgerEntryId: 999, side: "payable", amount: "1000.00" },
        ]),
      ),
    );

    expect(message).toContain("stavka 999");
    expect(message).toContain("ne postoji u glavnoj knjizi");
    expect(h.postManualEntry).not.toHaveBeenCalled();
  });

  it("skuplja SVE razloge u jednoj poruci (ne staje na prvom)", async () => {
    const h = makeService(
      [
        ledgerRow({
          id: 6,
          analyticalCode: OTHER_PARTNER,
          journalEntryId: 803,
          debit: new D(1000),
        }),
        ledgerRow({
          id: 7,
          accountCode: "4350",
          documentNumber: "R-9/26",
          credit: new D(1000),
          journalEntryId: 802,
          reconciledAt: new Date("2026-07-01T10:00:00Z"),
        }),
      ],
      { 802: "POSTED", 803: "DRAFT" },
    );

    const { rejected } = await expectRejected(
      h.service.create(
        dto([
          { ledgerEntryId: 6, side: "receivable", amount: "1000.00" },
          { ledgerEntryId: 7, side: "payable", amount: "1000.00" },
        ]),
      ),
    );

    // stavka 6: tuđi komitent + nacrt; stavka 7: već zatvorena → 3 razloga.
    expect(rejected.map((r) => r.ledgerEntryId)).toEqual([6, 6, 7]);
  });

  it("ispravna kompenzacija se knjiži (kontrolni slučaj)", async () => {
    const h = makeService(
      [
        ledgerRow({ id: 1, debit: new D(1000) }),
        ledgerRow({
          id: 2,
          accountCode: "4350",
          documentNumber: "R-9/26",
          credit: new D(1000),
          journalEntryId: 802,
        }),
      ],
      { 800: "POSTED", 802: "POSTED" },
    );

    const res = (await h.service.create(
      dto([
        { ledgerEntryId: 1, side: "receivable", amount: "1000.00" },
        { ledgerEntryId: 2, side: "payable", amount: "1000.00" },
      ]),
    )) as { status: string; journalEntryId: number | null };

    expect(res.status).toBe("POSTED");
    expect(res.journalEntryId).toBe(KMP_JOURNAL_ID);
    // Protivstavke nose konto+komitenta+broj reprezentativne stavke (ista grupa).
    expect(h.lastLines()).toEqual([
      expect.objectContaining({
        accountCode: "2040",
        analyticalCode: PARTNER,
        documentNumber: "F-1/26",
        credit: 1000,
      }),
      expect.objectContaining({
        accountCode: "4350",
        analyticalCode: PARTNER,
        documentNumber: "R-9/26",
        debit: 1000,
      }),
    ]);
  });
});

describe("CompensationService — openBalanceAbs i nacrti (D2)", () => {
  /**
   * Grupa (2040, komitent 100, F-1/26) ima proknjiženu stavku 1.000 i NACRT od 500.
   * Prebija se 1.000 = ceo PROKNJIŽENI saldo → pun offset, grupa se zatvara. Bez
   * predikata „proknjižen nalog" `openBalanceAbs` je bio 1.500, pa je pun offset
   * bio klasifikovan kao delimičan i grupa je ostajala otvorena.
   */
  it("NE uračunava DRAFT nalog u otvoreni saldo grupe (pun offset zatvara grupu)", async () => {
    const h = makeService(
      [
        ledgerRow({ id: 1, debit: new D(1000), journalEntryId: 800 }),
        ledgerRow({ id: 3, debit: new D(500), journalEntryId: 801 }), // NACRT, ista grupa
        ledgerRow({
          id: 2,
          accountCode: "4350",
          documentNumber: "R-9/26",
          credit: new D(1000),
          journalEntryId: 802,
        }),
      ],
      { 800: "POSTED", 801: "DRAFT", 802: "POSTED" },
    );

    await h.service.create(
      dto([
        { ledgerEntryId: 1, side: "receivable", amount: "1000.00" },
        { ledgerEntryId: 2, side: "payable", amount: "1000.00" },
      ]),
    );

    expect(h.ledger.get(1)?.reconciledAt).not.toBeNull();
    expect(h.ledger.get(2)?.reconciledAt).not.toBeNull();
    // Nacrt ostaje otvoren — zatvara se tek kad se nalog proknjiži.
    expect(h.ledger.get(3)?.reconciledAt).toBeNull();
  });

  /**
   * Kontrolna grupa: isti brojevi, ali je stavka od 500 PROKNJIŽENA → otvoreni saldo
   * grupe je 1.500, prebija se 1.000 = delimičan offset i ne zatvara se NIŠTA.
   * Ovim se dokazuje da predikat menja samo OSNOVU, a ne semantiku pun/delimičan.
   */
  it("proknjižen član grupe ostaje u osnovi (delimičan offset ne zatvara ništa)", async () => {
    const h = makeService(
      [
        ledgerRow({ id: 1, debit: new D(1000), journalEntryId: 800 }),
        ledgerRow({ id: 3, debit: new D(500), journalEntryId: 801 }),
        ledgerRow({
          id: 2,
          accountCode: "4350",
          documentNumber: "R-9/26",
          credit: new D(1000),
          journalEntryId: 802,
        }),
      ],
      { 800: "POSTED", 801: "POSTED", 802: "POSTED" },
    );

    await h.service.create(
      dto([
        { ledgerEntryId: 1, side: "receivable", amount: "1000.00" },
        { ledgerEntryId: 2, side: "payable", amount: "1000.00" },
      ]),
    );

    expect(h.ledger.get(1)?.reconciledAt).toBeNull();
    expect(h.ledger.get(3)?.reconciledAt).toBeNull();
    // Payable grupa je pokrivena u celini → ona se i dalje zatvara.
    expect(h.ledger.get(2)?.reconciledAt).not.toBeNull();
  });
});

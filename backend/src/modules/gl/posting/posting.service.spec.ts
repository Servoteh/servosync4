import { ConflictException, HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  AlreadyPostedException,
  LedgerNotBalancedException,
  NoPostingSchemeException,
  PostingEngineService,
} from "./posting.service";
import { ExpressionError } from "./expression-parser";

/**
 * DOMENSKE GREŠKE GL KNJIŽENJA MORAJU STIĆI DO KORISNIKA (defekt 04.08.2026).
 * =========================================================================
 * `AllExceptionsFilter` (common/http-exception.filter.ts) propušta ISKLJUČIVO
 * `HttpException`; sve ostalo namerno postaje 500 sa generičkom porukom
 * („Neočekivana greška na serveru…") da Prisma/SQL greške ne cure detalje šeme.
 * Dok su `LedgerNotBalancedException` / `NoPostingSchemeException` /
 * `AlreadyPostedException` / `ExpressionError` nasleđivale goli `Error`, njihove
 * tačne srpske poruke NIKAD nisu stizale do knjigovođe.
 *
 * Ovaj spec zaključava dve stvari:
 *   1) STATUS: svaka klasa je `HttpException` sa namerno izabranim kodom
 *      (422 = poslovno nevalidno / fali konfiguracija, 409 = stanje sistema);
 *   2) SERVISNI PUT: ista greška, bačena iz `PostingEngineService`, nosi
 *      ORIGINALNU poruku i `details` — dokaz da korisnik ne dobija generičku 500.
 *
 * Bez ispravke test 1 pada na `toBeInstanceOf(HttpException)`, a test 2 na
 * `statusOf()` (grešku bi filter pretvorio u 500 sa drugom porukom).
 *
 * Prisma je mockovana — knjiženje ne dira bazu; sve provere koje testiramo se
 * dešavaju pre ijednog upisa.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** Presretni bačenu grešku i vrati je (bez `expect(...).rejects`, da vidimo telo). */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("Očekivana greška nije bačena.");
}

/** HTTP status greške; usput tvrdi da JE `HttpException` (inače filter daje 500). */
function statusOf(e: unknown): number {
  expect(e).toBeInstanceOf(HttpException);
  return (e as HttpException).getStatus();
}

/** Telo odgovora (ono što filter prosleđuje klijentu) kao objekat. */
function bodyOf(e: unknown): Record<string, unknown> {
  return (e as HttpException).getResponse() as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) UGOVOR O STATUSU — po klasi, sa obrazloženjem izbora u imenu testa
// ─────────────────────────────────────────────────────────────────────────────

describe("GL posting — domenske greške su HttpException sa izabranim statusom", () => {
  it("LedgerNotBalancedException = 422 (poslovno nevalidna celina, ne loš sintaksni ulaz)", () => {
    const e = new LedgerNotBalancedException(D("1000.0000"), D("900.0000"));
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(e.message).toBe(
      "Nalog ne balansira: ΣDug=1000.0000 ≠ ΣPot=900.0000",
    );
    expect(bodyOf(e)).toEqual({
      message: "Nalog ne balansira: ΣDug=1000.0000 ≠ ΣPot=900.0000",
      code: "GL_NOT_BALANCED",
      details: {
        totalDebit: "1000.0000",
        totalCredit: "900.0000",
        difference: "100.0000",
      },
    });
    // Polja klase ostaju (year-open.service.ts računa razliku iz njih).
    expect(e.totalDebit.toFixed(4)).toBe("1000.0000");
    expect(e.totalCredit.toFixed(4)).toBe("900.0000");
  });

  it("NoPostingSchemeException = 422 (fali konfiguracija šeme, dokument POSTOJI pa nije 404)", () => {
    const e = new NoPostingSchemeException(4711);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(e.message).toBe(
      "Robni dokument 4711: DocumentType nema posting šablon (postingTemplate 0/null).",
    );
    expect(bodyOf(e).code).toBe("GL_NO_SCHEME");
    expect(bodyOf(e).details).toEqual({ docId: 4711 });
  });

  it("AlreadyPostedException = 409 (stanje sistema / konkurencija — osveži, ne menjaj podatke)", () => {
    const e = new AlreadyPostedException(4711, 88);
    expect(e).toBeInstanceOf(ConflictException);
    expect(statusOf(e)).toBe(HttpStatus.CONFLICT);
    expect(e.message).toBe(
      "Robni dokument 4711 je već proknjižen (nalog 88, posted/locked).",
    );
    // Front vodi link na TAČAN nalog.
    expect(bodyOf(e).details).toEqual({ docId: 4711, journalEntryId: 88 });
  });

  it("ExpressionError = 422 (formula je podatak iz šeme kontiranja = konfiguracija)", () => {
    const e = new ExpressionError('Nepoznat znak "@" na poziciji 1', 1);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(e.message).toBe('Nepoznat znak "@" na poziciji 1');
    expect(e.position).toBe(1);
    expect(bodyOf(e)).toEqual({
      message: 'Nepoznat znak "@" na poziciji 1',
      code: "GL_EXPRESSION_INVALID",
      details: { position: 1 },
    });
  });

  it("sve četiri ostaju `Error` (postojeći `catch (e) { e instanceof … }` i logovi rade)", () => {
    const svi = [
      new LedgerNotBalancedException(D(1), D(0)),
      new NoPostingSchemeException(1),
      new AlreadyPostedException(1, 2),
      new ExpressionError("x"),
    ];
    for (const e of svi) {
      expect(e).toBeInstanceOf(Error);
      expect(typeof e.stack).toBe("string");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) SERVISNI PUT — greška iz `PostingEngineService`, kroz mockovanu Prismu
// ─────────────────────────────────────────────────────────────────────────────

/** Robni dokument onako kako ga `postFromStockDocument` čita. */
function stockDoc(over: Record<string, unknown> = {}) {
  return {
    id: 4711,
    kind: "UF",
    documentTypeCode: "UFROB",
    isImport: false,
    companyId: 0,
    supplierId: 501,
    customerId: null,
    documentDate: new Date("2026-03-15T00:00:00.000Z"),
    postingDate: new Date("2026-03-15T00:00:00.000Z"),
    year: 2026,
    workOrderId: null,
    projectId: null,
    ...over,
  };
}

/**
 * Mock Prisma za `postFromStockDocument`: `$transaction(cb)` prosleđuje isti
 * objekat kao `tx`. Popunjava se samo ono što put do TESTIRANE provere pročita.
 */
function makePrisma(opts: {
  doc?: ReturnType<typeof stockDoc>;
  existingEntry?: { id: number; status: string } | null;
  postingTemplate?: number | null;
  schemeLines?: Array<{
    lineNo: number;
    accountCode: string;
    defDebit: string | null;
    defCredit: string | null;
    postsAnalytics: boolean;
    description: string | null;
  }>;
}) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    stockDocument: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(opts.doc ?? stockDoc()),
      update: jest.fn().mockResolvedValue({}),
    },
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(opts.existingEntry ?? null),
      delete: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 999, lines: [] }),
    },
    stockDocumentItem: { findMany: jest.fn().mockResolvedValue([]) },
    documentType: {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        code: "UFROB",
        postingTemplate: opts.postingTemplate ?? 5,
        isInbound: true,
      }),
    },
    accountingScheme: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 5,
        orderType: "UF",
        lines: opts.schemeLines ?? [],
      }),
    },
  };
  return {
    tx,
    prisma: {
      $transaction: jest.fn((cb: (t: typeof tx) => unknown) => cb(tx)),
    },
  };
}

describe("PostingEngineService — poruka stiže do korisnika (nije generička 500)", () => {
  it("postManualEntry: ΣDug ≠ ΣPot → 422 sa iznosima u poruci i razlikom u `details`", async () => {
    const service = new PostingEngineService({} as never);
    const e = await caught(() =>
      service.postManualEntry({} as never, {
        orderType: "KMP",
        documentDate: new Date("2026-03-15T00:00:00.000Z"),
        lines: [
          { accountCode: "2040", debit: "1200.00", credit: "0" },
          { accountCode: "4330", debit: "0", credit: "1000.00" },
        ],
      }),
    );

    expect(e).toBeInstanceOf(LedgerNotBalancedException);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    // Ovo je tekst koji knjigovođa vidi — pre ispravke je bio
    // „Neočekivana greška na serveru. Prijavi administratoru šifru greške."
    expect((e as Error).message).toBe(
      "Nalog ne balansira: ΣDug=1200.0000 ≠ ΣPot=1000.0000",
    );
    expect(bodyOf(e).details).toEqual({
      totalDebit: "1200.0000",
      totalCredit: "1000.0000",
      difference: "200.0000",
    });
  });

  it("postFromStockDocument: već proknjižen dokument → 409 sa brojem naloga", async () => {
    const { prisma, tx } = makePrisma({
      existingEntry: { id: 88, status: "POSTED" },
    });
    const service = new PostingEngineService(prisma as never);

    const e = await caught(() => service.postFromStockDocument(4711));

    expect(e).toBeInstanceOf(AlreadyPostedException);
    expect(statusOf(e)).toBe(HttpStatus.CONFLICT);
    expect((e as Error).message).toBe(
      "Robni dokument 4711 je već proknjižen (nalog 88, posted/locked).",
    );
    expect(bodyOf(e).details).toEqual({ docId: 4711, journalEntryId: 88 });
    // Guard je odbio PRE brisanja/upisa — proknjižen nalog se ne dira.
    expect(tx.journalEntry.delete).not.toHaveBeenCalled();
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });

  it("postFromStockDocument: DocumentType bez šeme (postingTemplate 0) → 422", async () => {
    const { prisma } = makePrisma({ postingTemplate: 0 });
    const service = new PostingEngineService(prisma as never);

    const e = await caught(() => service.postFromStockDocument(4711));

    expect(e).toBeInstanceOf(NoPostingSchemeException);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((e as Error).message).toBe(
      "Robni dokument 4711: DocumentType nema posting šablon (postingTemplate 0/null).",
    );
  });

  it("postFromStockDocument: neispravna DefDug formula u šemi → 422 sa pozicijom znaka", async () => {
    const { prisma } = makePrisma({
      schemeLines: [
        {
          lineNo: 1,
          accountCode: "1320",
          defDebit: "A;DROP",
          defCredit: null,
          postsAnalytics: false,
          description: null,
        },
      ],
    });
    const service = new PostingEngineService(prisma as never);

    const e = await caught(() => service.postFromStockDocument(4711));

    expect(e).toBeInstanceOf(ExpressionError);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(bodyOf(e).code).toBe("GL_EXPRESSION_INVALID");
    // Poruka imenuje sporni znak, a `details.position` ga lokalizuje u formuli.
    expect((e as Error).message).toContain(";");
    expect((bodyOf(e).details as { position: number }).position).toBe(1);
  });
});

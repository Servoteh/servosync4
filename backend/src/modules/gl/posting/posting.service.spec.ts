import { ConflictException, HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  AlreadyPostedException,
  LedgerNotBalancedException,
  NoPostingSchemeException,
  PostingEngineService,
  VatPeriodLockedException,
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

/** `VatReturn` red kako ga brava perioda čita (samo POSTED obračuni se dovlače). */
interface PostedVatReturn {
  id: number;
  periodMonth: number | null;
  periodQuarter: number | null;
}

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
  /** Predati (POSTED) PDV obračuni koje brava perioda vidi; podrazumevano nijedan. */
  postedVatReturns?: PostedVatReturn[];
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
    // Brava predatog PDV perioda + trag force-a (04.08.2026).
    vatReturn: {
      findMany: jest.fn().mockResolvedValue(opts.postedVatReturns ?? []),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
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

// ─────────────────────────────────────────────────────────────────────────────
// 3) BRAVA PREDATOG PDV PERIODA U DELJENOM MOTORU (04.08.2026)
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ ŠTA SE DEŠAVALO PRE ISPRAVKE: brava `pdv/vat-period-lock.ts` je štitila samo
// PDV evidencije (KIF/KUF, POPDV) i nekoliko `sales` puteva. Deljeni motor
// (`postManualEntry`) je NIJE zvao uopšte, pa je nijedan pisac glavne knjige nije
// nasleđivao — izmereno 2 od ~18 ulaznih točaka; ni jedan uvoz brave nije bio u
// `gl/`, `robno/`, `izvodi/`, `nabavka/`, `blagajna/`. Posle predate PDV prijave se
// i dalje knjižilo u taj mesec: GK i PP-PDV se tiho raziđu, a taj red potom ne može
// ući ni u jedan PDV obračun (POPDV i KIF/KUF za predat mesec su blokirani).
//
// OSA MERENJA je `posting_date`, jer po njoj PDV obračun kupi stavke
// (`VatLedgerService.buildKifKuf`, `PopdvService.sumVatAccounts`:
// `EXTRACT(YEAR/MONTH FROM je.posting_date)`).
//
// BEZ IZMENE MOTORA ovi testovi padaju: brave nema, pa (a) i (d) ne dobiju nikakvu
// grešku („Očekivana greška nije bačena."), a (b) ne nađe ni marker u opisu naloga
// ni red u `audit_log`. Test (c) je REGRESIONI — mora proći i pre i posle.

/** Mart 2026 predat (mesečni obveznik) — period 03/2026 je zaključan. */
const MART_2026_PREDAT: PostedVatReturn[] = [
  { id: 12, periodMonth: 3, periodQuarter: null },
];

/** Datum knjiženja u martu 2026 (UTC — ista osa kao `EXTRACT` nad timestamptz). */
const MART = new Date("2026-03-15T00:00:00.000Z");
/** Datum knjiženja u avgustu 2026 — period nije predat. */
const AVGUST = new Date("2026-08-04T00:00:00.000Z");

/** Mock `tx` za `postManualEntry` (numeracija + upis + brava + audit). */
function manualTx(postedVatReturns: PostedVatReturn[] = []) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    journalEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 4242 }),
    },
    vatReturn: { findMany: jest.fn().mockResolvedValue(postedVatReturns) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

/** Balansiran ručni nalog (ΣDug = ΣPot) — balans nije predmet ovih testova. */
const BALANSIRANE_LINIJE = [
  { accountCode: "2040", debit: "1000.00", credit: "0" },
  { accountCode: "4330", debit: "0", credit: "1000.00" },
];

/** `data` prvog `create` poziva mock-a (obrazac `firstArg` iz sales spec-ova). */
function createdData(mock: jest.Mock): Record<string, unknown> {
  return (
    mock.mock.calls as unknown as [{ data: Record<string, unknown> }][]
  )[0][0].data;
}

describe("Brava predatog PDV perioda — deljeni motor (postManualEntry)", () => {
  it("(a) knjiženje u PREDAT period → 409 koji IMENUJE period i prijavu", async () => {
    const tx = manualTx(MART_2026_PREDAT);
    const service = new PostingEngineService({} as never);

    const e = await caught(() =>
      service.postManualEntry(tx as never, {
        orderType: "KMP",
        documentDate: MART,
        lines: BALANSIRANE_LINIJE,
      }),
    );

    expect(e).toBeInstanceOf(VatPeriodLockedException);
    expect(statusOf(e)).toBe(HttpStatus.CONFLICT);
    // Poruka imenuje period i nudi DVA ispravna izlaza (odluka vlasnika 04.08.2026).
    expect((e as Error).message).toContain("03/2026");
    expect((e as Error).message).toContain("je predat");
    expect((e as Error).message).toContain(
      "knjiži u tekući period ili otključaj prijavu",
    );
    expect(bodyOf(e).code).toBe("GL_VAT_PERIOD_LOCKED");
    expect(bodyOf(e).details).toEqual({
      vatReturnId: 12,
      period: "03/2026",
      year: 2026,
      month: 3,
    });
    // NIŠTA nije ušlo u glavnu knjigu — ni broj naloga nije rezervisan.
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
    // Brava se meri po datumu KNJIŽENJA i po GODINI naloga (jedan upit, bez skeniranja).
    expect(tx.vatReturn.findMany).toHaveBeenCalledWith({
      where: { periodYear: 2026, status: "POSTED" },
      select: { id: true, periodMonth: true, periodQuarter: true },
    });
  });

  it("(b) isto uz `force` → PROLAZI i ostavlja trag (opis naloga + audit_log)", async () => {
    const tx = manualTx(MART_2026_PREDAT);
    const service = new PostingEngineService({} as never);

    const res = await service.postManualEntry(tx as never, {
      orderType: "KMP",
      documentDate: MART,
      description: "Kompenzacija 7/2026",
      createdByUserId: 9,
      force: { reason: "ispravka pogrešnog konta iz predate prijave" },
      lines: BALANSIRANE_LINIJE,
    });

    expect(res.journalEntryId).toBe(4242);

    // TRAG 1 — na samom nalogu (AuditInterceptor je HTTP-only, servisni sloj ne pokriva).
    const opis = createdData(tx.journalEntry.create).description as string;
    expect(opis).toContain("FORCE PDV 03/2026"); // u koji period
    expect(opis).toContain("korisnik 9"); // ko
    expect(opis).toContain("ispravka pogrešnog konta"); // zašto
    expect(opis).toContain("Kompenzacija 7/2026"); // izvorni opis se ne gubi
    expect(opis.length).toBeLessThanOrEqual(255); // VarChar(255)
    // KADA: ISO vremenska oznaka u markeru.
    expect(opis).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);

    // TRAG 2 — red u `audit_log`, u ISTOJ transakciji kao knjiženje.
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = createdData(tx.auditLog.create);
    expect(audit.action).toBe("FORCE POST U PREDAT PDV PERIOD");
    expect(audit.entityType).toBe("gl_journal_entry");
    expect(audit.entityId).toBe("4242");
    expect(audit.actorUserId).toBe(9);
    expect(audit.afterData).toMatchObject({
      journal_entry_id: 4242,
      order_type: "KMP",
      vat_period: "03/2026",
      vat_return_id: 12,
      reason: "ispravka pogrešnog konta iz predate prijave",
      posting_date: MART.toISOString(),
    });
  });

  it("(b2) `force` bez smislenog obrazloženja → 400 (escape hatch nije tihi prekidač)", async () => {
    const tx = manualTx(MART_2026_PREDAT);
    const service = new PostingEngineService({} as never);

    const e = await caught(() =>
      service.postManualEntry(tx as never, {
        orderType: "KMP",
        documentDate: MART,
        force: { reason: "  ok " },
        lines: BALANSIRANE_LINIJE,
      }),
    );

    expect(statusOf(e)).toBe(HttpStatus.BAD_REQUEST);
    expect((e as Error).message).toContain("03/2026");
    expect((e as Error).message).toContain("obrazloženje");
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
  });

  it("(c) REGRESIJA: nezaključan period se knjiži nepromenjeno (bez markera i audita)", async () => {
    const tx = manualTx([]); // nijedna prijava nije predata
    const service = new PostingEngineService({} as never);

    const res = await service.postManualEntry(tx as never, {
      orderType: "BLG",
      documentDate: AVGUST,
      description: "Blagajna — uplatnica 1",
      createdByUserId: 9,
      lines: BALANSIRANE_LINIJE,
    });

    expect(res).toEqual({ journalEntryId: 4242, number: "0001", lineCount: 2 });
    const data = createdData(tx.journalEntry.create);
    // Opis naloga OSTAJE null kao i do sada (motor ga nikad nije upisivao) — samo
    // forsirano knjiženje ga koristi za trag.
    expect(data.description).toBeNull();
    expect(data.status).toBe("POSTED");
    expect(data.postingDate).toBe(AVGUST);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("(c2) REGRESIJA: predat DRUGI mesec ne blokira knjiženje (brava nije opšta)", async () => {
    const tx = manualTx(MART_2026_PREDAT); // predat je 03/2026, knjižimo u 08/2026
    const service = new PostingEngineService({} as never);

    const res = await service.postManualEntry(tx as never, {
      orderType: "BLG",
      documentDate: AVGUST,
      lines: BALANSIRANE_LINIJE,
    });

    expect(res.journalEntryId).toBe(4242);
    expect(createdData(tx.journalEntry.create).description).toBeNull();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("(c3) REGRESIJA: OBRAČUNAT (CALCULATED) obračun NIJE brava — samo predat (POSTED)", async () => {
    // Brava dovlači samo `status: POSTED`; mock koji vraća prazno za taj filter
    // dokazuje da nezaključan (CALCULATED) obračun ne staje na put knjiženju.
    const tx = manualTx([]);
    const service = new PostingEngineService({} as never);

    await service.postManualEntry(tx as never, {
      orderType: "KMP",
      documentDate: MART,
      lines: BALANSIRANE_LINIJE,
    });

    const filter = (
      tx.vatReturn.findMany.mock.calls as unknown as [
        { where: { status: string } },
      ][]
    )[0][0];
    expect(filter.where.status).toBe("POSTED");
    expect(tx.journalEntry.create).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) (d) BRAVU NASLEĐUJE I PISAC KOJI JE DO SADA NIJE IMAO — robni put
// ─────────────────────────────────────────────────────────────────────────────
//
// `postFromStockDocument` NE ide kroz `postManualEntry` (upisuje nalog sam), i do
// 04.08.2026 nije imao nikakvu bravu perioda: ulaz robe se mirno knjižio u mesec sa
// predatom PDV prijavom, sa punim ulaznim PDV-om (27x) koji u tu prijavu ne može ući.
// Ovaj blok dokazuje da bravu naslede SVI pisci, ne samo motor ručnog naloga.

describe("(d) Brava perioda u robnom putu (postFromStockDocument)", () => {
  it("robni dokument u PREDAT period → 409 sa periodom, vrstom i brojem dokumenta", async () => {
    const { prisma, tx } = makePrisma({ postedVatReturns: MART_2026_PREDAT });
    const service = new PostingEngineService(prisma as never);

    const e = await caught(() => service.postFromStockDocument(4711));

    expect(e).toBeInstanceOf(VatPeriodLockedException);
    expect(statusOf(e)).toBe(HttpStatus.CONFLICT);
    expect((e as Error).message).toContain("03/2026");
    expect((e as Error).message).toContain("Robni dokument 4711");
    expect((bodyOf(e).details as { period: string }).period).toBe("03/2026");
    // Ni nalog ni veza dokument→nalog ne nastaju.
    expect(tx.journalEntry.create).not.toHaveBeenCalled();
    expect(tx.stockDocument.update).not.toHaveBeenCalled();
  });

  it("robni dokument uz `force` → prolazi, nalog nosi marker i audit red", async () => {
    const { prisma, tx } = makePrisma({ postedVatReturns: MART_2026_PREDAT });
    const service = new PostingEngineService(prisma as never);

    await service.postFromStockDocument(4711, {
      force: {
        reason: "dobavljačeva ispravka fakture za predat mart",
        actorUserId: 9,
      },
    });

    const data = createdData(tx.journalEntry.create);
    expect(data.description as string).toContain("FORCE PDV 03/2026");
    expect(data.description as string).toContain("dobavljačeva ispravka");
    expect(tx.stockDocument.update).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(createdData(tx.auditLog.create).afterData).toMatchObject({
      journal_entry_id: 999,
      order_type: "UF",
      vat_period: "03/2026",
      vat_return_id: 12,
    });
  });

  it("REGRESIJA: robni dokument u nezaključan period ide kao do sada", async () => {
    const { prisma, tx } = makePrisma({
      doc: stockDoc({
        documentDate: AVGUST,
        postingDate: AVGUST,
        year: 2026,
      }),
      postedVatReturns: MART_2026_PREDAT,
    });
    const service = new PostingEngineService(prisma as never);

    await service.postFromStockDocument(4711);

    expect(tx.journalEntry.create).toHaveBeenCalledTimes(1);
    expect(createdData(tx.journalEntry.create).description).toBeNull();
    expect(createdData(tx.journalEntry.create).status).toBe("DRAFT");
    expect(tx.stockDocument.update).toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("NIV (nivelacija) u predat period PROLAZI — ne piše u GK, ne može razići PDV", async () => {
    const { prisma, tx } = makePrisma({
      doc: stockDoc({ kind: "NIV" }),
      postedVatReturns: MART_2026_PREDAT,
    });
    // `postNivLeveling` traži stavke nivelacije i menja im `isPosted`.
    const txNiv = tx as typeof tx & Record<string, unknown>;
    txNiv.stockLevelingItem = {
      count: jest.fn().mockResolvedValue(3),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    };
    const service = new PostingEngineService(prisma as never);

    const lines = await service.postFromStockDocument(4711);

    expect(lines).toEqual([]);
    expect(tx.stockDocument.update).toHaveBeenCalled();
    // Brava se za NIV ni ne konsultuje — inače bi blokirala zatvaranje dokumenta i KEPU.
    expect(tx.vatReturn.findMany).not.toHaveBeenCalled();
  });
});

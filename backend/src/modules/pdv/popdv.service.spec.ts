import { HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  PopdvCycleException,
  PopdvFormulaException,
  PopdvPeriodException,
  PopdvService,
} from "./popdv.service";
import { InvalidVatPeriodException } from "./vat-ledger.service";

/**
 * DOMENSKE GREŠKE POPDV OBRAČUNA MORAJU STIĆI DO KORISNIKA (defekt 04.08.2026).
 * =========================================================================
 * `AllExceptionsFilter` propušta samo `HttpException`; dok su ove klase nasleđivale
 * goli `Error`, knjigovođa je na pogrešno izabran period dobijao „Neočekivana greška
 * na serveru" umesto „Navedi tačno jedan period: mesec (1..12) ILI kvartal (1..4).".
 *
 * Testovi ne diraju bazu: `resolvePeriod` se izvršava PRE ijednog upita, a
 * `evaluateDefinitions` je čista funkcija nad prosleđenim definicijama i saldima.
 */

const D = (v: string | number) => new Prisma.Decimal(v);
const ZERO = D(0);

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("Očekivana greška nije bačena.");
}

function caughtSync(fn: () => unknown): unknown {
  try {
    fn();
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

function bodyOf(e: unknown): Record<string, unknown> {
  return (e as HttpException).getResponse() as Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) UGOVOR O STATUSU
// ─────────────────────────────────────────────────────────────────────────────

describe("POPDV — domenske greške su HttpException sa izabranim statusom", () => {
  it("PopdvPeriodException = 422 (poslovno isključivo-ili koje DTO ne ume da izrazi)", () => {
    const e = new PopdvPeriodException(
      "Navedi tačno jedan period: mesec (1..12) ILI kvartal (1..4).",
    );
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(e.message).toBe(
      "Navedi tačno jedan period: mesec (1..12) ILI kvartal (1..4).",
    );
    expect(bodyOf(e)).toEqual({
      message: "Navedi tačno jedan period: mesec (1..12) ILI kvartal (1..4).",
      code: "PDV_POPDV_PERIOD",
    });
  });

  it("PopdvCycleException = 422 (ciklus u seed-ovanoj AOP definiciji = konfiguracija)", () => {
    const e = new PopdvCycleException("5.1");
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(e.message).toBe('Ciklus u POPDV formulama kod AOP "5.1".');
    expect(e.aop).toBe("5.1");
    expect(bodyOf(e).code).toBe("PDV_POPDV_CYCLE");
    expect(bodyOf(e).details).toEqual({ aop: "5.1" });
  });

  it("PopdvFormulaException = 422 (formula je podatak iz popdv_* tabela)", () => {
    const e = new PopdvFormulaException("3.2K1:D;DROP", 'Nepoznat znak ";"');
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(e.message).toBe(
      'Neispravna POPDV formula "3.2K1:D;DROP": Nepoznat znak ";"',
    );
    expect(e.formula).toBe("3.2K1:D;DROP");
    expect(e.reason).toBe('Nepoznat znak ";"');
    expect(bodyOf(e).details).toEqual({
      formula: "3.2K1:D;DROP",
      reason: 'Nepoznat znak ";"',
    });
  });

  it("InvalidVatPeriodException = 422 (poslovni horizont 2000–2100 / mesec 1..12)", () => {
    const e = new InvalidVatPeriodException(1999, 3);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(e.message).toBe("Nevalidan PDV period: godina=1999, mesec=3.");
    expect(bodyOf(e).code).toBe("PDV_INVALID_PERIOD");
    expect(bodyOf(e).details).toEqual({ year: 1999, month: 3 });
  });

  it("sve ostaju `Error` (postojeći `instanceof` i logovi rade nepromenjeno)", () => {
    for (const e of [
      new PopdvPeriodException("x"),
      new PopdvCycleException("1"),
      new PopdvFormulaException("f", "r"),
      new InvalidVatPeriodException(1, 1),
    ]) {
      expect(e).toBeInstanceOf(Error);
      expect(typeof e.stack).toBe("string");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) SERVISNI PUT — `PopdvService.compute` i `evaluateDefinitions`
// ─────────────────────────────────────────────────────────────────────────────

/** `evaluateDefinitions` je privatan; spec ga zove strukturno (bez izmene vidljivosti). */
type EvaluateDefinitions = (
  definitions: { aop: string; formula: string | null }[],
  outputVat: Prisma.Decimal,
  inputVat: Prisma.Decimal,
  accountMap: {
    account: string;
    popdvMark: string;
    columnDef: string;
    columnIndex: number;
  }[],
  balances: Map<string, { debit: Prisma.Decimal; credit: Prisma.Decimal }>,
) => { values: Map<string, Prisma.Decimal>; unsupportedCount: number };

function evaluator(service: PopdvService): EvaluateDefinitions {
  const holder = service as unknown as {
    evaluateDefinitions: EvaluateDefinitions;
  };
  return holder.evaluateDefinitions.bind(service);
}

describe("PopdvService — poruka stiže do korisnika (nije generička 500)", () => {
  /** Prisma nije potrebna: obe provere se dese pre ijednog upita. */
  const service = new PopdvService({} as never);

  it("compute bez meseca i bez kvartala → 422 sa uputstvom šta uneti", async () => {
    const e = await caught(() => service.compute({ year: 2026 }));
    expect(e).toBeInstanceOf(PopdvPeriodException);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((e as Error).message).toBe(
      "Navedi tačno jedan period: mesec (1..12) ILI kvartal (1..4).",
    );
  });

  it("compute sa mesecom I kvartalom → isto 422 (obveznik je jedno ili drugo)", async () => {
    const e = await caught(() =>
      service.compute({ year: 2026, month: 3, quarter: 1 }),
    );
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(bodyOf(e).code).toBe("PDV_POPDV_PERIOD");
  });

  it("compute sa kvartalom 7 → 422 sa spornom vrednošću u poruci", async () => {
    const e = await caught(() => service.compute({ year: 2026, quarter: 7 }));
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((e as Error).message).toBe("Nevalidan kvartal: 7.");
  });

  it("compute sa godinom 1999 → 422 InvalidVatPeriodException (poreski horizont)", async () => {
    const e = await caught(() => service.compute({ year: 1999, month: 3 }));
    expect(e).toBeInstanceOf(InvalidVatPeriodException);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((e as Error).message).toBe(
      "Nevalidan PDV period: godina=1999, mesec=3.",
    );
  });

  it("evaluateDefinitions: dve AOP definicije koje referišu jedna drugu → 422 sa AOP-om", () => {
    const e = caughtSync(() =>
      evaluator(service)(
        [
          { aop: "5.1", formula: "[5.2]" },
          { aop: "5.2", formula: "[5.1]" },
        ],
        ZERO,
        ZERO,
        [],
        new Map(),
      ),
    );
    expect(e).toBeInstanceOf(PopdvCycleException);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((e as Error).message).toBe(
      'Ciklus u POPDV formulama kod AOP "5.1".',
    );
    expect(bodyOf(e).details).toEqual({ aop: "5.1" });
  });

  it("evaluateDefinitions: neispravan columnDef u konto→AOP mapi → 422 imenuje formulu", () => {
    const e = caughtSync(() =>
      evaluator(service)(
        [{ aop: "3.2K1", formula: "[3.2K1]" }], // self-ref = punjenje iz mape
        ZERO,
        ZERO,
        [
          {
            account: "2700",
            popdvMark: "3.2",
            columnDef: "D;DROP",
            columnIndex: 1,
          },
        ],
        new Map([["2700", { debit: D(2000), credit: ZERO }]]),
      ),
    );
    expect(e).toBeInstanceOf(PopdvFormulaException);
    expect(statusOf(e)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    // Poruka nosi i AOP i sporni columnDef — knjigovođa vidi ŠTA je pokvareno.
    expect((e as Error).message).toContain(
      'Neispravna POPDV formula "3.2K1:D;DROP"',
    );
    expect((bodyOf(e).details as { formula: string }).formula).toBe(
      "3.2K1:D;DROP",
    );
  });
});

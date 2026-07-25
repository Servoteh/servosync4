import { Prisma } from "@prisma/client";
import { GkEvalService } from "./gkeval.service";

/**
 * Spec motora bilansnih formula (BigBit DSL). Modul do sada nije imao NIJEDAN test,
 * a studija BigBita je otkrila dva defekta koja se vide tek na pravim podacima:
 *
 *   1) zaključni nalog (ZAK) je ulazio u D/P, pa je bilans uspeha svake PRENETE
 *      godine izlazio u EGZAKTNIM nulama — `year-open.service.ts` knjiži kontra-stavku
 *      nazad na isto konto klase 5/6, datiranu 31.12., pa je ni donja granica datuma
 *      ne bi izbacila;
 *   2) formule oblika `PSD01*+D01*` broje početno stanje DVAPUT, jer D/P već
 *      uključuju PS naloge (PSD/PSP su njihov podskup).
 *
 * Ovi testovi zaključavaju oba pravila na nivou SQL-a koji motor sastavlja.
 */

const D = Prisma.Decimal;

/** Hvata `Prisma.sql` upite i pamti sastavljen tekst + vezane vrednosti. */
function makePrisma(rows: Array<{ total: Prisma.Decimal }> = [{ total: new D(0) }]) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  return {
    queries,
    $queryRaw: jest.fn((q: Prisma.Sql) => {
      queries.push({ text: q.strings.join("?"), values: q.values });
      return Promise.resolve(rows);
    }),
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new GkEvalService(prisma as never);
}

const ASOF = new Date("2023-12-31T00:00:00.000Z");

describe("GkEvalService — izuzimanje zaključnog naloga (ZAK)", () => {
  it("D maska NE sme da uračuna zaključni nalog", async () => {
    const prisma = makePrisma([{ total: new D("178421") }]);
    const service = makeService(prisma);

    await service.evalFormula("D600*", ASOF, () => new D(0));

    const sql = prisma.queries[0];
    expect(sql.text).toContain("order_type_code");
    // Uslov mora biti ISKLJUČUJUĆI (<>), ne uključujući (LIKE 'PS%').
    expect(sql.text).toContain("<>");
    expect(sql.values).toContain("ZAK");
  });

  it("P maska takođe izuzima ZAK", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.evalFormula("P602*", ASOF, () => new D(0));

    expect(prisma.queries[0].values).toContain("ZAK");
  });

  it("PSD/PSP filtriraju PS naloge i NE izuzimaju ZAK (početno stanje je drugi upit)", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.evalFormula("PSD022*", ASOF, () => new D(0));

    const sql = prisma.queries[0];
    expect(sql.values).toContain("PS%");
    expect(sql.values).not.toContain("ZAK");
  });

  it("NULL vrsta naloga ostaje uključena u promet (stari nalozi bez vrste)", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.evalFormula("D204*", ASOF, () => new D(0));

    expect(prisma.queries[0].text).toContain("IS NULL");
  });
});

describe("GkEvalService — aritmetika izraza", () => {
  it("sabira i oduzima članove istim redosledom kao obrazac", async () => {
    // Svaki atom vraća 100 → 100 + 100 - 100 = 100.
    const prisma = makePrisma([{ total: new D("100") }]);
    const service = makeService(prisma);

    const v = await service.evalFormula("D600*+P602*-D604*", ASOF, () => new D(0));

    expect(v.toFixed(2)).toBe("100.00");
  });

  it("A<aop> referenca se rešava kroz prosleđeni resolver, bez upita u bazu", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    const v = await service.evalFormula("A1002+A1005", ASOF, (aop) =>
      aop === "1002" ? new D("179944") : new D("450321"),
    );

    expect(v.toFixed(0)).toBe("630265");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("maska koja ne uhvati nijedno konto daje nulu, ne grešku", async () => {
    const prisma = makePrisma([{ total: new D(0) }]);
    const service = makeService(prisma);

    const v = await service.evalFormula("D9999*", ASOF, () => new D(0));

    expect(v.toFixed(2)).toBe("0.00");
  });
});

import { HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { GkEvalError, GkEvalService, fiscalYearPeriod } from "./gkeval.service";

/**
 * Spec motora bilansnih formula (BigBit DSL).
 *
 * Do 28.07.2026. je ovaj spec testirao SAMO JEDNU godinu u knjizi i time kodifikovao
 * grešku: `aggregate()` je imao jedinu vremensku granicu `je.posting_date <= asOf`,
 * dakle kumulativ od početka knjige. Sa dve i više godina to proizvodi DVA kvara:
 *
 *   (a) BILANS USPEHA sabira sve ranije godine — konto 6010 (prihod 100/250/300 po
 *       godinama) daje 100 / 350 / 650 umesto 100 / 250 / 300;
 *   (b) BILANS STANJA broji POČETNO STANJE DVAPUT — konto 2410 daje 60 / 110 / 165
 *       umesto 60 / 50 / 55, jer PS nalog restatira saldo prethodne godine koja je
 *       istovremeno i sama u prozoru.
 *
 * Zato ovde postoji TRO-GODIŠNJA knjiga i mali interpreter koji SASTAVLJENI SQL vozi
 * nad tom knjigom u memoriji. Interpreter razume i stari (`posting_date <=`) i novi
 * (`je.year =`) predikat — ako neko vrati staru semantiku, brojevi ispod se menjaju u
 * 110/350 i test pada, umesto da tiho prođe.
 */

const D = Prisma.Decimal;

// ─────────────────────────────────────────────────────────────────────────────
// Knjiga u memoriji — TRI godine, sa PS i ZAK nalozima kakve pravi
// `gl/year-open.service.ts` (ZAK 31.12.Y zatvara klase 5/6 i knjiži rezultat na
// 341; PS 01.01.Y+1 prenosi klase 0–4).
// ─────────────────────────────────────────────────────────────────────────────

interface Row {
  year: number;
  orderType: string;
  date: string; // document_date = posting_date u fixture-u
  account: string;
  debit: number;
  credit: number;
}

function entry(
  year: number,
  orderType: string,
  date: string,
  lines: Array<[account: string, debit: number, credit: number]>,
): Row[] {
  return lines.map(([account, debit, credit]) => ({
    year,
    orderType,
    date,
    account,
    debit,
    credit,
  }));
}

/**
 * 2022: prihod 100 (6010), rashod 40 (5110), kupac 2410 D100/P40 → saldo 60, dobit 60.
 * 2023: prihod 250, rashod 20, 2410 D10/P20 → saldo 50, dobit 230.
 * 2024: prihod 300, bez rashoda, 2410 D5 → saldo 55, dobit 300.
 * 2020 je protivkonto (klasa 2) da bi svaki nalog balansirao.
 */
const LEDGER: Row[] = [
  // ── 2022 ──────────────────────────────────────────────────────────────────
  ...entry(2022, "NALOG", "2022-03-01", [
    ["2410", 100, 0],
    ["6010", 0, 100],
  ]),
  ...entry(2022, "NALOG", "2022-06-01", [
    ["5110", 40, 0],
    ["2410", 0, 40],
  ]),
  // ZAK 31.12.2022 — zatvara 5/6, rezultat 60 na 341 (klasa 3 OSTAJE u D/P)
  ...entry(2022, "ZAK", "2022-12-31", [
    ["6010", 100, 0],
    ["5110", 0, 40],
    ["3410", 0, 60],
  ]),

  // ── 2023 ──────────────────────────────────────────────────────────────────
  // PS 01.01.2023 — prenos klasa 0–4 (2410 = 60, 341 = 60)
  ...entry(2023, "PS", "2023-01-01", [
    ["2410", 60, 0],
    ["3410", 0, 60],
  ]),
  ...entry(2023, "NALOG", "2023-04-01", [
    ["2410", 10, 0],
    ["6010", 0, 10],
  ]),
  ...entry(2023, "NALOG", "2023-05-01", [
    ["5110", 20, 0],
    ["2410", 0, 20],
  ]),
  ...entry(2023, "NALOG", "2023-09-01", [
    ["2020", 240, 0],
    ["6010", 0, 240],
  ]),
  ...entry(2023, "ZAK", "2023-12-31", [
    ["6010", 250, 0],
    ["5110", 0, 20],
    ["3410", 0, 230],
  ]),

  // ── 2024 ──────────────────────────────────────────────────────────────────
  // PS 01.01.2024 — 2410 = 50, 2020 = 240, 341 = 290 (60 iz 2022 + 230 iz 2023)
  ...entry(2024, "PS", "2024-01-01", [
    ["2410", 50, 0],
    ["2020", 240, 0],
    ["3410", 0, 290],
  ]),
  ...entry(2024, "NALOG", "2024-02-01", [
    ["2410", 5, 0],
    ["6010", 0, 5],
  ]),
  ...entry(2024, "NALOG", "2024-08-01", [
    ["2020", 295, 0],
    ["6010", 0, 295],
  ]),
  ...entry(2024, "ZAK", "2024-12-31", [
    ["6010", 300, 0],
    ["3410", 0, 300],
  ]),
];

// ─────────────────────────────────────────────────────────────────────────────
// Interpreter sastavljenog SQL-a nad knjigom u memoriji.
//
// `Prisma.Sql` čuva `strings[i]` NEPOSREDNO PRE `values[i]`, pa se svaki vezani
// parametar prepoznaje po repu teksta ispred njega. Nepoznat parametar je GREŠKA —
// tako izmena upita ne može tiho da promeni značenje testa.
// ─────────────────────────────────────────────────────────────────────────────

interface Predicates {
  like?: string;
  fiscalYear?: number;
  /** Stara semantika (kumulativ) — podržana da bi test umeo da je razlikuje. */
  postingDateMax?: Date;
  /** Novi opcioni presek unutar godine. */
  documentDateMax?: Date;
  /** PSD/PSP: vrsta naloga početnog stanja („PS" ili staro „PS%"). */
  psOrderType?: string;
  closingOrderType?: string;
  closedClasses: string[];
}

function readPredicates(q: Prisma.Sql): Predicates {
  const p: Predicates = { closedClasses: [] };
  let inClassList = false;

  q.values.forEach((value, i) => {
    const tail = q.strings[i].replace(/\s+/g, " ").trimEnd();

    if (tail.endsWith("account_code LIKE")) {
      p.like = String(value);
      inClassList = false;
    } else if (tail.endsWith("je.year =")) {
      p.fiscalYear = Number(value);
      inClassList = false;
    } else if (tail.endsWith("je.posting_date <=")) {
      p.postingDateMax = value as Date;
      inClassList = false;
    } else if (tail.endsWith("je.document_date <=")) {
      p.documentDateMax = value as Date;
      inClassList = false;
    } else if (
      tail.endsWith("order_type_code LIKE") ||
      tail.endsWith("je.order_type_code =")
    ) {
      p.psOrderType = String(value);
      inClassList = false;
    } else if (tail.endsWith("'') =")) {
      p.closingOrderType = String(value);
      inClassList = false;
    } else if (tail.endsWith("IN (")) {
      p.closedClasses.push(String(value));
      inClassList = true;
    } else if (inClassList && tail.endsWith(",")) {
      p.closedClasses.push(String(value));
    } else {
      throw new Error(
        `Neprepoznat vezani parametar u SQL-u motora: "…${tail.slice(-40)}" = ${String(value)}`,
      );
    }
  });

  return p;
}

/**
 * SQL LIKE obrazac → RegExp. `%` i `_` su wildcard-i; obrnuta kosa crta uvodi
 * doslovan znak (motor tako escape-uje `%`, `_` i samu kosu crtu u `toLikePattern`).
 */
function likeToRegExp(pattern: string): RegExp {
  const escapeLiteral = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      body += escapeLiteral(pattern[++i]);
    } else if (ch === "%") {
      body += ".*";
    } else if (ch === "_") {
      body += ".";
    } else {
      body += escapeLiteral(ch);
    }
  }
  return new RegExp(`^${body}$`);
}

/** Izvrši sastavljeni `aggregate()` upit nad knjigom u memoriji. */
function runAggregate(q: Prisma.Sql, ledger: Row[]): Prisma.Decimal {
  const text = q.strings.join("");
  const isDebit = text.includes("SUM(le.debit)");
  const p = readPredicates(q);
  if (p.like === undefined) {
    throw new Error("Upit nema masku konta.");
  }
  const mask = likeToRegExp(p.like);

  let total = new D(0);
  for (const r of ledger) {
    if (!mask.test(r.account)) continue;
    if (p.fiscalYear !== undefined && r.year !== p.fiscalYear) continue;
    if (p.postingDateMax && new Date(r.date) > p.postingDateMax) continue;
    if (p.documentDateMax && new Date(r.date) > p.documentDateMax) continue;

    if (p.psOrderType !== undefined) {
      // PSD/PSP grana: samo nalozi početnog stanja.
      const ok = p.psOrderType.endsWith("%")
        ? r.orderType.startsWith(p.psOrderType.slice(0, -1))
        : r.orderType === p.psOrderType;
      if (!ok) continue;
    } else if (
      p.closingOrderType !== undefined &&
      r.orderType === p.closingOrderType &&
      p.closedClasses.includes(r.account.slice(0, 1))
    ) {
      // D/P grana: kontra-stavke ZAK naloga na klasama koje on zatvara ispadaju.
      continue;
    }

    total = total.add(new D(isDebit ? r.debit : r.credit));
  }
  return total;
}

function makeLedgerService(ledger: Row[] = LEDGER) {
  const queries: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: jest.fn((q: Prisma.Sql) => {
      queries.push(q);
      return Promise.resolve([{ total: runAggregate(q, ledger) }]);
    }),
  };
  return { service: new GkEvalService(prisma as never), prisma, queries };
}

/** Hvata `Prisma.sql` upite i pamti sastavljen tekst + vezane vrednosti (SQL-oblik testovi). */
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

const PERIOD_2023 = fiscalYearPeriod(2023);

// ─────────────────────────────────────────────────────────────────────────────
// REGRESIJA — TRI GODINE U KNJIZI (bez ovoga se ispravka ne sme proglasiti gotovom)
// ─────────────────────────────────────────────────────────────────────────────

describe("GkEvalService — prozor je JEDNA fiskalna godina (tri godine u knjizi)", () => {
  /** Bilans uspeha: samo promet te godine, bez ijedne ranije. */
  it.each([
    [2022, "100"],
    [2023, "250"],
    [2024, "300"],
  ])(
    "BILANS USPEHA %i: P6010*-D6010* = %s (stari kumulativ je davao 100/350/650)",
    async (year, expected) => {
      const { service } = makeLedgerService();
      const v = await service.evalFormula(
        "P6010*-D6010*",
        fiscalYearPeriod(year),
        () => new D(0),
      );
      expect(v.toFixed(0)).toBe(expected);
    },
  );

  /** Bilans stanja: PS godine + promet godine, bez dvostrukog početnog stanja. */
  it.each([
    [2022, "60"],
    [2023, "50"],
    [2024, "55"],
  ])(
    "BILANS STANJA %i: D2410*-P2410* = %s (stari kumulativ je davao 60/110/165)",
    async (year, expected) => {
      const { service } = makeLedgerService();
      const v = await service.evalFormula(
        "D2410*-P2410*",
        fiscalYearPeriod(year),
        () => new D(0),
      );
      expect(v.toFixed(0)).toBe(expected);
    },
  );

  it("rezultat godine OSTAJE u kapitalu — AOP 0410 (P341*-D341*) nije nula ni u jednoj godini", async () => {
    for (const year of [2022, 2023, 2024]) {
      const { service } = makeLedgerService();
      const v = await service.evalFormula(
        "P341*-D341*",
        fiscalYearPeriod(year),
        () => new D(0),
      );
      expect(v.isZero()).toBe(false);
    }
  });

  /**
   * ⚠️ ŽIVI DEFEKT IZVAN OVOG MOTORA (`gl/year-open.service.ts`): PS nalog prenosi
   * rezultat sa 341 na 341, umesto na 340 („ranijih godina"). Pod prozorom godine
   * zbir 0408 = 0409 + 0410 i dalje zatvara, ali je podela pogrešna: 0409 je trajna
   * nula, a 0410 višegodišnji zbir. Test to ZAKLJUČAVA kao zatečeno stanje da se ne
   * bi propustilo — kad se year-open ispravi, prelazi u varijantu ispod.
   */
  it("zatečeno: PS prenosi 341→341, pa je AOP 0410 za 2023 = 290 (60 + 230), a 0409 = 0", async () => {
    const { service } = makeLedgerService();
    const a0410 = await service.evalFormula(
      "P341*-D341*",
      PERIOD_2023,
      () => new D(0),
    );
    const a0409 = await service.evalFormula(
      "P340*-D340*",
      PERIOD_2023,
      () => new D(0),
    );
    expect(a0410.toFixed(0)).toBe("290");
    expect(a0409.toFixed(0)).toBe("0");
  });

  it("posle reklasifikacije 341→340 u PS nalogu: 0409 = 60 (2022), 0410 = 230 (2023)", async () => {
    // Ista knjiga, samo PS-2023 nosi preneti rezultat na 3400 umesto na 3410.
    const reclassified = LEDGER.map((r) =>
      r.orderType === "PS" && r.account === "3410"
        ? { ...r, account: "3400" }
        : r,
    );
    const { service } = makeLedgerService(reclassified);

    const a0409 = await service.evalFormula(
      "P340*-D340*",
      PERIOD_2023,
      () => new D(0),
    );
    const a0410 = await service.evalFormula(
      "P341*-D341*",
      PERIOD_2023,
      () => new D(0),
    );
    expect(a0409.toFixed(0)).toBe("60");
    expect(a0410.toFixed(0)).toBe("230");
  });

  it("PSD/PSP čitaju SAMO PS nalog te godine (početno stanje, ne promet)", async () => {
    const { service } = makeLedgerService();
    const psd = await service.evalFormula(
      "PSD2410*",
      PERIOD_2023,
      () => new D(0),
    );
    const d = await service.evalFormula("D2410*", PERIOD_2023, () => new D(0));
    // PSD je PODSKUP D (BigBit: PSDuguje ⊂ UkPrometDuguje) — zato se ne sabiraju.
    expect(psd.toFixed(0)).toBe("60");
    expect(d.toFixed(0)).toBe("70");
  });

  it("presek unutar godine (asOf) seče promet te godine, ne ranije godine", async () => {
    const { service } = makeLedgerService();
    // 30.04.2023: PS (01.01.) + nalog od 01.04., bez naloga od 01.05. i 01.09.
    const v = await service.evalFormula(
      "D2410*-P2410*",
      { fiscalYear: 2023, asOf: new Date("2023-04-30T23:59:59Z") },
      () => new D(0),
    );
    expect(v.toFixed(0)).toBe("70");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OBLIK SASTAVLJENOG SQL-a — brana od tihog povratka stare semantike
// ─────────────────────────────────────────────────────────────────────────────

describe("GkEvalService — oblik prozora u SQL-u", () => {
  it("prozor je je.year, a posting_date se NE pojavljuje nigde", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.evalFormula("D600*", PERIOD_2023, () => new D(0));

    const sql = prisma.queries[0];
    expect(sql.text).toContain("je.year =");
    expect(sql.values).toContain(2023);
    expect(sql.text).not.toContain("posting_date");
  });

  it("bez asOf nema nijednog datumskog filtera (cela fiskalna godina)", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.evalFormula("D600*", fiscalYearPeriod(2024), () => new D(0));

    expect(prisma.queries[0].text).not.toContain("document_date");
  });

  it("uz asOf presek ide po document_date (ne posting_date)", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);
    const asOf = new Date("2024-06-30T00:00:00.000Z");

    await service.evalFormula("D600*", { fiscalYear: 2024, asOf }, () => new D(0));

    const sql = prisma.queries[0];
    expect(sql.text).toContain("je.document_date <=");
    expect(sql.values).toContain(asOf);
    expect(sql.text).not.toContain("posting_date");
  });

  it("bruto bilans koristi ISTI prozor kao AOP obrazac", async () => {
    const prisma = makePrisma([]);
    const service = makeService(prisma);

    await service.grossTrialBalance(fiscalYearPeriod(2024));

    const sql = prisma.queries[0];
    expect(sql.text).toContain("je.year =");
    expect(sql.values).toContain(2024);
    expect(sql.text).not.toContain("posting_date");
  });

  it("prozor bez fiskalne godine se ODBIJA (inače bi je.year = NULL tiho dalo nulu)", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await expect(
      service.evalFormula("D600*", {} as never, () => new D(0)),
    ).rejects.toThrow(/fiskalnu godinu/);
    // Stari poziv sa golim Date-om mora pući, ne tiho vratiti nulu.
    await expect(
      service.evalFormula("D600*", new Date() as never, () => new D(0)),
    ).rejects.toThrow(/fiskalnu godinu/);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("GkEvalService — zaključni nalog (ZAK): izuzeti klase 5/6, zadržati rezultat", () => {
  it("D maska izuzima zaključni nalog SAMO za klase koje on zatvara", async () => {
    const prisma = makePrisma([{ total: new D("178421") }]);
    const service = makeService(prisma);

    await service.evalFormula("D600*", PERIOD_2023, () => new D(0));

    const sql = prisma.queries[0];
    expect(sql.text).toContain("order_type_code");
    expect(sql.values).toContain("ZAK");
    // Izuzimanje je vezano za KLASU konta, ne za nalog u celini — inače bi ispala i
    // stavka rezultata na klasi 3 i pasiva bi bila manja od aktive za iznos dobiti.
    expect(sql.text).toContain("LEFT(le.account_code, 1)");
    expect(sql.values).toContain("5");
    expect(sql.values).toContain("6");
  });

  it("klasa 3 NIJE u izuzetim klasama — rezultat godine ostaje u kapitalu", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    // AOP 0410 „Neraspoređeni dobitak tekuće godine" = P341*-D341*; konto 341 puni
    // ISKLJUČIVO zaključni nalog, pa bi izuzimanje celog ZAK-a dalo nulu.
    await service.evalFormula("P341*", PERIOD_2023, () => new D(0));

    expect(prisma.queries[0].values).not.toContain("3");
  });

  it("P maska klase 6 takođe izuzima zaključne kontra-stavke", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.evalFormula("P602*", PERIOD_2023, () => new D(0));

    expect(prisma.queries[0].values).toContain("ZAK");
  });

  it("PSD/PSP filtriraju PS naloge EGZAKTNO (ne LIKE) i ne izuzimaju ZAK", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.evalFormula("PSD022*", PERIOD_2023, () => new D(0));

    const sql = prisma.queries[0];
    expect(sql.values).toContain("PS");
    expect(sql.values).not.toContain("PS%");
    expect(sql.values).not.toContain("ZAK");
  });

  it("NULL vrsta naloga ostaje uključena u promet (stari nalozi bez vrste)", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.evalFormula("D204*", PERIOD_2023, () => new D(0));

    // Bez COALESCE bi `NULL = 'ZAK'` dalo NULL, `NOT (NULL AND TRUE)` opet NULL, a
    // WHERE odbacuje redove sa NULL uslovom — stari nalozi bi tiho nestali.
    expect(prisma.queries[0].text).toContain("COALESCE(je.order_type_code");
  });
});

describe("GkEvalService — aritmetika izraza", () => {
  it("sabira i oduzima članove istim redosledom kao obrazac", async () => {
    // Svaki atom vraća 100 → 100 + 100 - 100 = 100.
    const prisma = makePrisma([{ total: new D("100") }]);
    const service = makeService(prisma);

    const v = await service.evalFormula(
      "D600*+P602*-D604*",
      PERIOD_2023,
      () => new D(0),
    );

    expect(v.toFixed(2)).toBe("100.00");
  });

  it("A<aop> referenca se rešava kroz prosleđeni resolver, bez upita u bazu", async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    const v = await service.evalFormula("A1002+A1005", PERIOD_2023, (aop) =>
      aop === "1002" ? new D("179944") : new D("450321"),
    );

    expect(v.toFixed(0)).toBe("630265");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("maska koja ne uhvati nijedno konto daje nulu, ne grešku", async () => {
    const prisma = makePrisma([{ total: new D(0) }]);
    const service = makeService(prisma);

    const v = await service.evalFormula("D9999*", PERIOD_2023, () => new D(0));

    expect(v.toFixed(2)).toBe("0.00");
  });
});

/**
 * GREŠKA U BILANSNOJ FORMULI MORA BITI OBJAŠNJENA (defekt 04.08.2026).
 * =========================================================================
 * `AllExceptionsFilter` (common/http-exception.filter.ts) propušta ISKLJUČIVO
 * `HttpException`; sve ostalo namerno postaje 500 sa generičkom porukom. Dok je
 * `GkEvalError` nasleđivala goli `Error`, računovođa je umesto „Nepoznat prefiks u
 * atomu …" dobijao „Neočekivana greška na serveru" i nije imao šta da javi.
 *
 * 422 je izabran jer su formule AOP pozicija (`balance_formulas`) KONFIGURACIJA
 * obrasca, seed-ovana migracijom: obračun se ne može izvesti dok se seed ne ispravi.
 * Nije 500 (uzrok je poznat i imenovan) ni 400 (korisnik ne šalje formulu).
 *
 * Bez ispravke ovi testovi padaju na `toBeInstanceOf(HttpException)`.
 */
describe("GkEvalError je HttpException 422 (a bio je 500)", () => {
  const caught = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn();
    } catch (e) {
      return e;
    }
    throw new Error("Očekivana greška nije bačena.");
  };

  it("prazna formula kroz evalFormula → 422 sa originalnom porukom i `code`", async () => {
    const service = makeService(makePrisma());
    const e = await caught(() =>
      service.evalFormula("", PERIOD_2023, () => new D(0)),
    );

    expect(e).toBeInstanceOf(GkEvalError);
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect((e as Error).message).toBe("Prazna formula");
    expect((e as HttpException).getResponse()).toEqual({
      message: "Prazna formula",
      code: "ZR_FORMULA_INVALID",
      details: { position: -1 },
    });
  });

  it("nepoznat znak u formuli → 422, `details.position` lokalizuje sporni znak", async () => {
    const service = makeService(makePrisma());
    const e = await caught(() =>
      service.evalFormula("D600*@P602*", PERIOD_2023, () => new D(0)),
    );

    expect((e as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect((e as Error).message).toContain("@");
    const details = (e as HttpException).getResponse() as {
      details: { position: number };
    };
    expect(details.details.position).toBeGreaterThanOrEqual(0);
    expect((e as GkEvalError).position).toBe(details.details.position);
  });

  it("ostaje `Error` (postojeći `instanceof` i logovi rade nepromenjeno)", async () => {
    const service = makeService(makePrisma());
    const e = await caught(() =>
      service.evalFormula("", PERIOD_2023, () => new D(0)),
    );
    expect(e).toBeInstanceOf(Error);
    expect(typeof (e as Error).stack).toBe("string");
  });
});

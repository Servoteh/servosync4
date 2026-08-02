/**
 * KONTROLNA PRAVILA ZAVRŠNOG RAČUNA — testovi.
 * =========================================================================
 * PRAVILO OVOG FAJLA: svaki test mora pokazati da pravilo PADA kad je nešto stvarno
 * pogrešno. Tautologija ne pada nikad — zato uz svaki „pada" test stoji i provera da
 * bi STARO (tautološko) pravilo na istom ulazu i dalje bilo zeleno. Bez tog para se
 * ne vidi razlika između kontrole i ukrasa.
 *
 * Podloga je SINTETIČKA GLAVNA KNJIGA u memoriji (`buildBook`), a lažni Prisma iz nje
 * računa iste agregate koje bi vratio Postgres. Zahvaljujući tome test menja KNJIGU
 * (npr. doda drugu godinu, pokvari nalog) i gleda kako pravila reaguju — ne podmeće
 * gotove brojeve pravilima.
 */

import { Prisma } from "@prisma/client";
import {
  ControlRulesService,
  accountMasksOf,
  isBlockingFailure,
  parseAggregateFormula,
} from "./control-rules.service";
import { STATEMENT_TYPE } from "./statement-type";

const D = Prisma.Decimal;

// ─────────────────────────────────────────────────────────────────────────────
// Sintetička glavna knjiga + lažni Prisma
// ─────────────────────────────────────────────────────────────────────────────

interface FakeLine {
  account: string;
  debit?: string;
  credit?: string;
}
interface FakeEntry {
  id: number;
  orderTypeCode: string;
  number: string;
  year: number;
  status?: string;
  description?: string | null;
  lines: FakeLine[];
}
interface FakeStatementLine {
  aop: string;
  amount: string;
  formula: string | null;
  label?: string | null;
}
interface FakeStatement {
  id: number;
  statementType: string;
  periodYear: number;
  status?: string;
  lines: FakeStatementLine[];
}

const POSTED = ["POSTED", "LOCKED"];

class FakePrisma {
  /**
   * Sirovi SQL svakog upita — lažni Prisma ne izvršava telo upita, pa bi mutacija
   * unutar SQL-a (obrisan izuzetak ZAK-a, obrisan filter prenosnih konta) prošla
   * neprimećeno. Test niže tvrdi ŠTA U SQL-u MORA da stoji.
   */
  readonly seenSql: string[] = [];

  constructor(
    private readonly entries: FakeEntry[],
    private readonly statements: FakeStatement[],
    private readonly overrides: Array<Record<string, unknown>> = [],
  ) {}

  private live(year: number) {
    return this.entries.filter(
      (e) => e.year === year && POSTED.includes(e.status ?? "POSTED"),
    );
  }

  financialStatement = {
    // eslint-disable-next-line @typescript-eslint/require-await
    findUnique: async (args: {
      where: {
        id?: number;
        statementType_periodYear?: {
          statementType: string;
          periodYear: number;
        };
      };
    }) => {
      const key = args.where.statementType_periodYear;
      const found = args.where.id
        ? this.statements.find((s) => s.id === args.where.id)
        : this.statements.find(
            (s) =>
              s.statementType === key!.statementType &&
              s.periodYear === key!.periodYear,
          );
      if (!found) return null;
      return {
        ...found,
        status: found.status ?? "DRAFT",
        lines: found.lines.map((l) => ({
          aop: l.aop,
          label: l.label ?? null,
          amount: new D(l.amount),
          formula: l.formula,
        })),
      };
    },
  };

  statementControlOverride = {
    // eslint-disable-next-line @typescript-eslint/require-await
    findMany: async () => this.overrides,
  };

  journalEntry = {
    // eslint-disable-next-line @typescript-eslint/require-await
    count: async (args: { where: { year: number; orderTypeCode: string } }) =>
      this.live(args.where.year).filter(
        (e) => e.orderTypeCode === args.where.orderTypeCode,
      ).length,
  };

  /**
   * Razlikuje tri upita servisa po potpisu SQL-a i računa isto što bi vratio Postgres.
   * Godina se čita iz prve interpolirane vrednosti (svi upiti je stavljaju prvu ili
   * je nose u `values`) — u testovima je uvek tačno jedna godina u pitanju po pozivu.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  $queryRaw = async (query: Prisma.Sql) => {
    const sql = query.sql;
    this.seenSql.push(sql);
    const year = query.values.find(
      (v): v is number => typeof v === "number" && v > 1900 && v < 2200,
    )!;
    const live = this.live(year);

    if (sql.includes("HAVING")) {
      return live
        .map((e) => {
          let diff = new D(0);
          for (const l of e.lines) {
            diff = diff.add(l.debit ?? 0).sub(l.credit ?? 0);
          }
          return { entry: e, diff };
        })
        .filter((r) => !r.diff.isZero())
        .sort(
          (a, b) =>
            b.diff.abs().comparedTo(a.diff.abs()) || a.entry.id - b.entry.id,
        )
        .map((r) => ({
          id: r.entry.id,
          order_type_code: r.entry.orderTypeCode,
          number: r.entry.number,
          description: r.entry.description ?? null,
          diff: r.diff.toFixed(4),
        }));
    }

    if (sql.includes("AS revenue")) {
      let revenue = new D(0);
      let expense = new D(0);
      let tax = new D(0);
      for (const e of live) {
        for (const l of e.lines) {
          const cls = l.account.slice(0, 1);
          const isTax =
            l.account.startsWith("721") || l.account.startsWith("722");
          // Zaključni nalog zatvara i klase 5/6 I poreska konta — njegove kontra-stavke
          // ispadaju sa obe strane (isto kao u pravom SQL-u).
          const isClosingContra =
            e.orderTypeCode === "ZAK" && (cls === "5" || cls === "6" || isTax);
          if (isClosingContra) continue;
          const debit = new D(l.debit ?? 0);
          const credit = new D(l.credit ?? 0);
          const isTransfer =
            l.account.startsWith("599") || l.account.startsWith("699");
          if (cls === "6" && !isTransfer)
            revenue = revenue.add(credit).sub(debit);
          if (cls === "5" && !isTransfer)
            expense = expense.add(debit).sub(credit);
          if (isTax) {
            tax = tax.add(debit).sub(credit);
          }
        }
      }
      return [
        {
          revenue: revenue.toFixed(4),
          expense: expense.toFixed(4),
          tax: tax.toFixed(4),
        },
      ];
    }

    // promet po kontu
    const totals = new Map<string, { d: Prisma.Decimal; c: Prisma.Decimal }>();
    for (const e of live) {
      for (const l of e.lines) {
        const acc = totals.get(l.account) ?? { d: new D(0), c: new D(0) };
        acc.d = acc.d.add(l.debit ?? 0);
        acc.c = acc.c.add(l.credit ?? 0);
        totals.set(l.account, acc);
      }
    }
    return [...totals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([account_code, v]) => ({
        account_code,
        total_debit: v.d.toFixed(4),
        total_credit: v.c.toFixed(4),
      }));
  };
}

function service(
  entries: FakeEntry[],
  statements: FakeStatement[],
  overrides: Array<Record<string, unknown>> = [],
): ControlRulesService {
  return new ControlRulesService(
    new FakePrisma(entries, statements, overrides) as never,
  );
}

const byCode = <T extends { code: string }>(results: T[], code: string): T =>
  results.find((r) => r.code === code)!;

// ─────────────────────────────────────────────────────────────────────────────
// Osnovna, ISPRAVNA knjiga i njeni obrasci
// ─────────────────────────────────────────────────────────────────────────────
//
//   0210 oprema        D 1.000
//   2410 kupci         D   600 / P 100
//   3010 kapital                P 500
//   4330 dobavljači              P 900
//   5100 troškovi      D   300
//   6010 prihodi                P 400
//   Σ D = 1.900 = Σ P  → knjiga je uravnotežena
//   Saldo klasa 0–4 = 1.000 + 500 − 500 − 900 = 100 = neto rezultat (400 − 300)

const YEAR = 2024;

function book(): FakeEntry[] {
  return [
    {
      id: 1,
      orderTypeCode: "NALOG",
      number: "0001",
      year: YEAR,
      lines: [
        { account: "0210", debit: "1000" },
        { account: "4330", credit: "500" },
        { account: "3010", credit: "500" },
      ],
    },
    {
      id: 2,
      orderTypeCode: "IF",
      number: "0002",
      year: YEAR,
      lines: [
        { account: "2410", debit: "600" },
        { account: "6010", credit: "400" },
        { account: "4330", credit: "200" },
      ],
    },
    {
      id: 3,
      orderTypeCode: "UFROB",
      number: "0003",
      year: YEAR,
      lines: [
        { account: "5100", debit: "300" },
        { account: "4330", credit: "200" },
        { account: "2410", credit: "100" },
      ],
    },
  ];
}

/** Bilans stanja PRE zaključnog naloga (rezultat još nije prenet na kapital). */
function balanceSheet(
  over: Partial<Record<string, string>> = {},
): FakeStatement {
  const amount = (aop: string, fallback: string) => over[aop] ?? fallback;
  return {
    id: 10,
    statementType: STATEMENT_TYPE.BALANCE_SHEET,
    periodYear: YEAR,
    lines: [
      { aop: "0010", amount: amount("0010", "1000"), formula: "D021*-P021*" },
      { aop: "0040", amount: amount("0040", "500"), formula: "D241*-P241*" },
      { aop: "0059", amount: amount("0059", "1500"), formula: "A0010+A0040" },
      { aop: "0402", amount: amount("0402", "500"), formula: "P301*-D301*" },
      { aop: "0410", amount: amount("0410", "0"), formula: "P341*-D341*" },
      { aop: "0414", amount: amount("0414", "0"), formula: "D351*-P351*" },
      {
        aop: "0401",
        amount: amount("0401", "500"),
        formula: "A0402+A0410-A0414",
      },
      { aop: "0431", amount: amount("0431", "900"), formula: "P433*-D433*" },
      { aop: "0455", amount: amount("0455", "0"), formula: "A0431-A0059" },
      {
        aop: "0456",
        amount: amount("0456", "1400"),
        formula: "A0401+A0431-A0455",
      },
    ],
  };
}

function incomeStatement(
  over: Partial<Record<string, string>> = {},
): FakeStatement {
  const amount = (aop: string, fallback: string) => over[aop] ?? fallback;
  return {
    id: 11,
    statementType: STATEMENT_TYPE.INCOME_STATEMENT,
    periodYear: YEAR,
    lines: [
      { aop: "1003", amount: amount("1003", "400"), formula: "P601*-D601*" },
      { aop: "1014", amount: amount("1014", "300"), formula: "D510*-P510*" },
      { aop: "1043", amount: amount("1043", "400"), formula: "A1003" },
      { aop: "1044", amount: amount("1044", "300"), formula: "A1014" },
      { aop: "1054", amount: amount("1054", "0"), formula: null },
      { aop: "1055", amount: amount("1055", "100"), formula: "A1043-A1044" },
      { aop: "1056", amount: amount("1056", "0"), formula: "A1044-A1043" },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("ControlRulesService — zdrava knjiga", () => {
  it("bilans stanja: nijedno blokirajuće pravilo ne pada", async () => {
    const res = await service(book(), [
      balanceSheet(),
      incomeStatement(),
    ]).evaluateControls(10);

    expect(byCode(res, "GK_URAVNOTEZENA").status).toBe("PROLAZI");
    expect(byCode(res, "GK_VAN_OBRASCA").status).toBe("PROLAZI");
    expect(byCode(res, "AOP_POKRIVENOST").status).toBe("PROLAZI");
    expect(byCode(res, "BS_GK_SAGLASNOST").status).toBe("PROLAZI");
    expect(byCode(res, "REZULTAT_BS_BU").status).toBe("PROLAZI");
    expect(res.filter((r) => r.blocking && !r.passed)).toHaveLength(0);
  });

  it("bilans uspeha: neto rezultat obrasca = sirovi saldo klasa 5/6", async () => {
    const res = await service(book(), [
      balanceSheet(),
      incomeStatement(),
    ]).evaluateControls(11);
    const rule = byCode(res, "BU_GK_SAGLASNOST");
    expect(rule.status).toBe("PROLAZI");
    expect(rule.left).toBe("100.0000");
    expect(rule.right).toBe("100.0000");
  });

  it("kontrola NIJE tautologija: obe strane dolaze iz različitih izvora", async () => {
    // Desna strana pravila BS_GK_SAGLASNOST je ravan zbir po klasi iz knjige i ne
    // menja se ni kad se OBRAZAC promeni — dokaz da nije prepis leve strane.
    const res = await service(book(), [
      balanceSheet({ "0059": "1500", "0456": "1400" }),
      incomeStatement(),
    ]).evaluateControls(10);
    expect(byCode(res, "BS_GK_SAGLASNOST").right).toBe("100.0000");

    const skewed = await service(book(), [
      balanceSheet({ "0059": "1700", "0010": "1200" }),
      incomeStatement(),
    ]).evaluateControls(10);
    expect(byCode(skewed, "BS_GK_SAGLASNOST").right).toBe("100.0000"); // ista knjiga
    expect(byCode(skewed, "BS_GK_SAGLASNOST").left).toBe("300.0000"); // drugi obrazac
    expect(byCode(skewed, "BS_GK_SAGLASNOST").status).toBe("PADA");
  });
});

describe("ControlRulesService — pravilo PADA kad je formula pogrešna", () => {
  it("konto ispalo iz obrasca (maska ga ne hvata) → pokrivenost pada", async () => {
    // 0431 sada gleda 439* umesto 433* — konto 4330 nije više ni u jednoj maski.
    const bs = balanceSheet();
    bs.lines = bs.lines.map((l) =>
      l.aop === "0431" ? { ...l, formula: "P439*-D439*" } : l,
    );
    const res = await service(book(), [bs, incomeStatement()]).evaluateControls(
      10,
    );
    const rule = byCode(res, "AOP_POKRIVENOST");
    expect(rule.status).toBe("PADA");
    expect(rule.blocking).toBe(true);
    expect(rule.details.join(" ")).toContain("4330");
  });

  it("konto ispalo iz obrasca (i iznos) → obrazac se razilazi sa knjigom, a STARO tautološko pravilo bi i dalje bilo zeleno", async () => {
    // Kao da maska 433* ne postoji: pozicija 0431 je 0, pa je i pasiva manja.
    const bs = balanceSheet({ "0431": "0", "0456": "500" });
    bs.lines = bs.lines.map((l) =>
      l.aop === "0431" ? { ...l, formula: "P439*-D439*" } : l,
    );
    const res = await service(book(), [bs, incomeStatement()]).evaluateControls(
      10,
    );

    expect(byCode(res, "BS_GK_SAGLASNOST").status).toBe("PADA");
    expect(byCode(res, "BS_GK_SAGLASNOST").left).toBe("1000.0000"); // 1500 − 500
    expect(byCode(res, "BS_GK_SAGLASNOST").right).toBe("100.0000"); // knjiga

    // Dokaz da tautologija ne pada: staro pravilo je bilo `0456 == 0401+0431-0455`,
    // a to je DOSLOVNO formula pozicije 0456 — pa je i sa pogrešnom maskom tačno.
    const amounts = new Map(bs.lines.map((l) => [l.aop, new D(l.amount)]));
    const tautology = amounts
      .get("0401")!
      .add(amounts.get("0431")!)
      .sub(amounts.get("0455")!);
    expect(tautology.equals(amounts.get("0456")!)).toBe(true);
  });

  it("maska duplo broji konto → obrazac se razilazi sa knjigom", async () => {
    // 0040 (kupci) upisan dvaput; aktiva naduvana za 500.
    const res = await service(book(), [
      balanceSheet({ "0040": "1000", "0059": "2000" }),
      incomeStatement(),
    ]).evaluateControls(10);
    const rule = byCode(res, "BS_GK_SAGLASNOST");
    expect(rule.status).toBe("PADA");
    expect(rule.diff).toBe("500.0000");
    expect(rule.message).toContain("duplo broji");
  });

  it("pogrešan prozor agregacije (K1: sabrane ranije godine) → pravilo pada", async () => {
    // Knjiga sada ima i 2023. godinu. Prozor obračuna je 2024, ali obrazac je
    // izračunat kumulativno (defekt K1) — aktiva nosi i prošlogodišnjih 700.
    const twoYears = book().concat([
      {
        id: 99,
        orderTypeCode: "NALOG",
        number: "0099",
        year: YEAR - 1,
        lines: [
          { account: "0210", debit: "700" },
          { account: "3010", credit: "700" },
        ],
      },
    ]);
    const res = await service(twoYears, [
      balanceSheet({ "0010": "1700", "0059": "2200" }),
      incomeStatement(),
    ]).evaluateControls(10);
    const rule = byCode(res, "BS_GK_SAGLASNOST");
    expect(rule.status).toBe("PADA");
    expect(rule.right).toBe("100.0000"); // knjiga za 2024. je netaknuta
    expect(rule.diff).toBe("700.0000"); // tačno prošlogodišnji promet
  });

  it("prihod izgubljen iz bilansa uspeha → BU pravilo pada", async () => {
    const res = await service(book(), [
      balanceSheet(),
      incomeStatement({ "1043": "250", "1055": "0", "1056": "50" }),
    ]).evaluateControls(11);
    const rule = byCode(res, "BU_GK_SAGLASNOST");
    expect(rule.status).toBe("PADA");
    expect(rule.left).toBe("-50.0000");
    expect(rule.right).toBe("100.0000");
  });

  it("saldo na klasi van obrasca (7/8/9) → pravilo pada iako bilans zatvara", async () => {
    const withClass7 = book().concat([
      {
        id: 50,
        orderTypeCode: "RAZNO",
        number: "0050",
        year: YEAR,
        lines: [
          { account: "7000", debit: "80" },
          { account: "4330", credit: "80" },
        ],
      },
    ]);
    // Obrazac se prilagodio (obaveze +80) — aktiva/pasiva i dalje „zatvara".
    const res = await service(withClass7, [
      balanceSheet({ "0431": "980", "0456": "1480" }),
      incomeStatement(),
    ]).evaluateControls(10);
    const rule = byCode(res, "GK_VAN_OBRASCA");
    expect(rule.status).toBe("PADA");
    expect(rule.blocking).toBe(true);
    expect(rule.details.join(" ")).toContain("7000");
  });

  it("rezultat sa bilansa stanja ≠ rezultat sa bilansa uspeha → ukrsno pravilo pada", async () => {
    const res = await service(book(), [
      balanceSheet(),
      incomeStatement({ "1055": "160" }),
    ]).evaluateControls(10);
    const rule = byCode(res, "REZULTAT_BS_BU");
    expect(rule.status).toBe("PADA");
    expect(rule.diff).toBe("-60.0000");
  });
});

describe("ControlRulesService — neuravnotežen IZVOR se imenuje, ne gura na force", () => {
  /** Knjiga sa jednim zatečenim neuravnoteženim nalogom (razlika 0,10 na aktivi). */
  function skewedBook(): FakeEntry[] {
    const b = book();
    b.push({
      id: 77,
      orderTypeCode: "AVANS",
      number: "0011",
      year: YEAR,
      description: "zatečeno iz BigBita",
      lines: [
        { account: "2410", debit: "10.10" },
        { account: "4330", credit: "10" },
      ],
    });
    return b;
  }

  it("prijavljuje razliku, imenuje nalog i NE blokira finalizaciju", async () => {
    const res = await service(skewedBook(), [
      balanceSheet({
        "0040": "510.10",
        "0059": "1510.10",
        "0431": "910",
        "0456": "1410",
      }),
      incomeStatement(),
    ]).evaluateControls(10);

    const rule = byCode(res, "GK_URAVNOTEZENA");
    expect(rule.status).toBe("UPOZORENJE");
    expect(rule.blocking).toBe(false);
    expect(rule.left).toBe("0.1000");
    expect(rule.message).toContain("KVAR JE U ULAZNIM PODACIMA");
    expect(rule.details[0]).toContain("AVANS 0011");
    expect(rule.details[0]).toContain("0,10");
    // Nijedno BLOKIRAJUĆE pravilo ne pada — dakle force=true nije potreban.
    expect(res.filter((r) => r.blocking && !r.passed)).toHaveLength(0);
  });

  it("bilansna ravnoteža posle zaključnog naloga prolazi, a razliku pripisuje izvoru", async () => {
    const b = skewedBook();
    b.push({
      id: 78,
      orderTypeCode: "ZAK",
      number: "0001",
      year: YEAR,
      lines: [
        { account: "6010", debit: "400" },
        { account: "5100", credit: "300" },
        { account: "3410", credit: "100" },
      ],
    });
    const bs = balanceSheet({
      "0040": "510.10",
      "0059": "1510.10",
      "0410": "100",
      "0401": "600",
      "0431": "910",
      "0456": "1510",
    });
    const res = await service(b, [bs, incomeStatement()]).evaluateControls(10);

    const rule = byCode(res, "BS_AKTIVA_PASIVA");
    expect(rule.status).toBe("PROLAZI");
    expect(rule.message).toContain("neuravnoteženošću same glavne knjige");
    expect(rule.message).toContain("0,10");
    expect(byCode(res, "REZULTAT_BS_BU").status).toBe("PROLAZI");
  });

  it("razlika koja NIJE objašnjena izvorom i dalje pada", async () => {
    const b = skewedBook();
    b.push({
      id: 78,
      orderTypeCode: "ZAK",
      number: "0001",
      year: YEAR,
      lines: [
        { account: "6010", debit: "400" },
        { account: "5100", credit: "300" },
        { account: "3410", credit: "100" },
      ],
    });
    const bs = balanceSheet({
      "0040": "510.10",
      "0059": "1510.10",
      "0410": "100",
      "0401": "600",
      "0431": "910",
      "0456": "1450", // 60 premalo na pasivi — nema veze sa 0,10 iz izvora
    });
    const res = await service(b, [bs, incomeStatement()]).evaluateControls(10);
    const rule = byCode(res, "BS_AKTIVA_PASIVA");
    expect(rule.status).toBe("PADA");
    expect(rule.message).toContain("NIJE");
  });
});

describe("ControlRulesService — pre zaključnog naloga", () => {
  it("bilansna ravnoteža je NEPRIMENLJIVA (ne pad) i objašnjava zašto", async () => {
    const res = await service(book(), [
      balanceSheet(),
      incomeStatement(),
    ]).evaluateControls(10);
    const rule = byCode(res, "BS_AKTIVA_PASIVA");
    expect(rule.status).toBe("NEPRIMENLJIVO");
    // ZELENO JE SAMO „PROLAZI": ranije je NEPRIMENLJIVO nosilo passed=true, pa je
    // štampani obrazac iznad aktive i pasive koje se razlikuju za 110,8 miliona pisao
    // zeleno „PROLAZI". Nije zeleno — i ne blokira (knjigovođa to ne može popraviti).
    expect(rule.passed).toBe(false);
    expect(rule.blocking).toBe(false);
    expect(isBlockingFailure(rule)).toBe(false);
    expect(rule.message).toContain("Zaključni nalog");
    expect(rule.message).toContain("341");
  });

  it("ukrsna kontrola rezultata ipak radi — razlika aktive i pasive JESTE rezultat", async () => {
    const res = await service(book(), [
      balanceSheet(),
      incomeStatement(),
    ]).evaluateControls(10);
    const rule = byCode(res, "REZULTAT_BS_BU");
    expect(rule.status).toBe("PROLAZI");
    expect(rule.left).toBe("100.0000");
    expect(rule.right).toBe("100.0000");
  });
});

describe("ControlRulesService — nepostojeća pozicija nije nula", () => {
  it('obračun bez AOP 0456 daje NEPRIMENLJIVO, nikad „prošlo"', async () => {
    const bs = balanceSheet();
    bs.lines = bs.lines.filter((l) => l.aop !== "0456");
    const res = await service(book(), [bs, incomeStatement()]).evaluateControls(
      10,
    );
    const rule = byCode(res, "BS_GK_SAGLASNOST");
    expect(rule.status).toBe("NEPRIMENLJIVO");
    expect(rule.message).toContain("AOP 0456");
    // Stara implementacija je čitala nedostajući AOP kao 0 — 0 == 0 − 0 je prolazilo.
    expect(rule.status).not.toBe("PROLAZI");
  });

  it("bilans uspeha koji nije izračunat → ukrsno pravilo je NEPRIMENLJIVO", async () => {
    const res = await service(book(), [balanceSheet()]).evaluateControls(10);
    const rule = byCode(res, "REZULTAT_BS_BU");
    expect(rule.status).toBe("NEPRIMENLJIVO");
    expect(rule.message).toContain("Bilans uspeha");
  });
});

describe("ControlRulesService — odsecanje na nulu se vidi", () => {
  it("prijavljuje SIROVI iznos pozicije odsečene na nulu", async () => {
    const res = await service(book(), [
      balanceSheet(),
      incomeStatement(),
    ]).evaluateControls(10);
    const rule = byCode(res, "ODSECANJE_NA_NULU");
    // 0455 = A0431 − A0059 = 900 − 1500 = −600, upisano 0.
    expect(rule.status).toBe("UPOZORENJE");
    expect(rule.blocking).toBe(false);
    expect(rule.details.join(" ")).toContain("AOP 0455");
    expect(rule.details.join(" ")).toContain("-600,00");
  });

  it("bez odsecanja prijavljuje PROLAZI i kaže šta NE proverava", async () => {
    const bs = balanceSheet({ "0431": "1600", "0455": "100", "0456": "2000" });
    const res = await service(book(), [bs, incomeStatement()]).evaluateControls(
      10,
    );
    const rule = byCode(res, "ODSECANJE_NA_NULU");
    expect(rule.status).toBe("PROLAZI");
    expect(rule.message).toContain("maskom konta se ovim putem ne vidi");
  });
});

describe("ControlRulesService — trag forsirane finalizacije", () => {
  it("forsiran obračun nosi pseudo-pravilo sa imenom, vremenom i palim pravilima", async () => {
    const res = await service(
      book(),
      [balanceSheet(), incomeStatement()],
      [
        {
          id: 1,
          statementId: 10,
          forcedByUserId: 7,
          forcedByEmail: "knjigovodja@servoteh.com",
          forcedAt: new Date("2026-07-28T09:15:00.000Z"),
          failedRules: [
            {
              code: "BS_GK_SAGLASNOST",
              name: "Bilans stanja odgovara glavnoj knjizi (klase 0–4)",
            },
          ],
          controlSnapshot: [],
          reason: "predaja APR-u istog dana",
        },
      ],
    ).evaluateControls(10);

    const trail = byCode(res, "FORSIRANA_FINALIZACIJA");
    expect(trail).toBeDefined();
    expect(trail.blocking).toBe(false);
    expect(trail.passed).toBe(false);
    expect(trail.message).toContain("knjigovodja@servoteh.com");
    expect(trail.message).toContain("2026-07-28 09:15:00");
    expect(trail.details.join(" ")).toContain("BS_GK_SAGLASNOST");
    expect(trail.details.join(" ")).toContain("predaja APR-u istog dana");
    expect(res[0].code).toBe("FORSIRANA_FINALIZACIJA"); // prvi u odgovoru
  });

  it("neforsiran obračun nema pseudo-pravilo", async () => {
    const res = await service(book(), [
      balanceSheet(),
      incomeStatement(),
    ]).evaluateControls(10);
    expect(
      res.find((r) => r.code === "FORSIRANA_FINALIZACIJA"),
    ).toBeUndefined();
  });
});

describe("pomoćnici — maske i zbirne formule", () => {
  it("izvlači maske konta, a AOP reference preskače", () => {
    expect(accountMasksOf("D021*-P021*")).toEqual(["021*", "021*"]);
    expect(accountMasksOf("A0002+A0044")).toEqual([]);
    expect(accountMasksOf("PSD01*+AB0002-AC0002+P433*")).toEqual([
      "01*",
      "433*",
    ]);
  });

  it("prepoznaje zbirnu formulu, a formulu sa maskom odbija", () => {
    expect(parseAggregateFormula("A0010+A0040")).toEqual([
      { aop: "0010", sign: 1 },
      { aop: "0040", sign: 1 },
    ]);
    expect(parseAggregateFormula("A0431-A0059")).toEqual([
      { aop: "0431", sign: 1 },
      { aop: "0059", sign: -1 },
    ]);
    expect(parseAggregateFormula("D021*-P021*")).toBeNull();
    expect(parseAggregateFormula("A0002+(A0044-A0045)")).toBeNull();
    expect(parseAggregateFormula("AB0002-AC0002")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// REGRESIJE IZ DRUGOG KRUGA NEZAVISNOG PREGLEDA (28.07.2026)
// ─────────────────────────────────────────────────────────────────────────────

/** Nalog kojim se knjiži porez na dobit: D 7210 / P 4810. */
function taxEntry(id: number, amount: string): FakeEntry {
  return {
    id,
    orderTypeCode: "NALOG",
    number: "TAX",
    year: YEAR,
    lines: [
      { account: "7210", debit: amount },
      { account: "4810", credit: amount },
    ],
  };
}

describe('poreska konta 721/722 nisu „van obrasca"', () => {
  it("proknjižen porez na dobit NE obara nijedno blokirajuće pravilo", async () => {
    // Obrazac: porez 60 smanjuje neto dobitak (1055) i povećava obaveze (0431/0456).
    const b = book();
    b.push(taxEntry(90, "60"));
    const bs = balanceSheet({
      "0431": "960",
      "0455": "0",
      "0456": "1460",
    });
    // Obaveza za porez (481) mora imati masku, inače pada pokrivenost — to je drugo
    // pravilo i drugi nalaz; ovde se meri samo ponašanje poreskih konta klase 7.
    bs.lines = bs.lines.map((l) =>
      l.aop === "0431" ? { ...l, formula: "P433*-D433*+P481*-D481*" } : l,
    );
    const bu = incomeStatement({ "1055": "40" });
    bu.lines.push({ aop: "1051", amount: "60", formula: "D721*-P721*" });

    const res = await service(b, [bs, bu]).evaluateControls(10);

    // Ranije: GK_VAN_OBRASCA je sabirao 7210 u „saldo van obrasca" (pa PADA kao
    // BLOKIRAJUĆE) i to sa PRAZNOM listom konta, jer je iz spiska izbacivao ista ta
    // konta. Uz njega je padao i REZULTAT_BS_BU.
    expect(byCode(res, "GK_VAN_OBRASCA").status).toBe("PROLAZI");
    expect(byCode(res, "GK_VAN_OBRASCA").left).toBe("0.0000");
    expect(byCode(res, "REZULTAT_BS_BU").status).toBe("PROLAZI");
    expect(res.filter(isBlockingFailure)).toHaveLength(0);
  });

  it("porez zatvoren zaključnim nalogom ne obara bilans uspeha", async () => {
    // ZAK zatvara 6010/5100 I poresko 7210 — sirova strana mora izuzeti te kontra-
    // stavke, inače BU_GK_SAGLASNOST pada tačno za iznos poreza.
    const b = book();
    b.push(taxEntry(90, "60"));
    b.push({
      id: 91,
      orderTypeCode: "ZAK",
      number: "0001",
      year: YEAR,
      lines: [
        { account: "6010", debit: "400" },
        { account: "5100", credit: "300" },
        { account: "7210", credit: "60" },
        { account: "3410", credit: "40" },
      ],
    });
    const bu = incomeStatement({ "1055": "40" });
    bu.lines.push({ aop: "1051", amount: "60", formula: "D721*-P721*" });

    const res = await service(b, [balanceSheet(), bu]).evaluateControls(11);
    const rule = byCode(res, "BU_GK_SAGLASNOST");
    expect(rule.status).toBe("PROLAZI");
    expect(rule.left).toBe("40.0000"); // obrazac: 400 − 300 − 60
    expect(rule.right).toBe("40.0000"); // knjiga: isto, bez ZAK kontra-stavki
  });

  it("stvaran saldo van obrasca (klasa 8) i dalje PADA i IMENUJE konto", async () => {
    const b = book();
    b.push({
      id: 92,
      orderTypeCode: "NALOG",
      number: "VAN",
      year: YEAR,
      lines: [
        { account: "8100", debit: "70" },
        { account: "4330", credit: "70" },
      ],
    });
    const res = await service(b, [
      balanceSheet({ "0431": "970", "0456": "1470" }),
      incomeStatement(),
    ]).evaluateControls(10);
    const rule = byCode(res, "GK_VAN_OBRASCA");
    expect(rule.status).toBe("PADA");
    expect(rule.blocking).toBe(true);
    expect(isBlockingFailure(rule)).toBe(true);
    // Poruka kaže „proveri navedena konta" — spisak NE sme biti prazan.
    expect(rule.details.length).toBeGreaterThan(0);
    expect(rule.details.join(" ")).toContain("8100");
  });
});

describe("zeleno je samo PROLAZI", () => {
  it("nijedan rezultat sa statusom različitim od PROLAZI nema passed=true", async () => {
    const bs = balanceSheet();
    bs.lines = bs.lines.filter((l) => l.aop !== "0456");
    const res = await service(bs ? book() : [], [
      bs,
      incomeStatement(),
    ]).evaluateControls(10);
    for (const r of res) {
      expect(r.passed).toBe(r.status === "PROLAZI");
    }
  });

  it("nepostojeća pozicija BLOKIRA finalizaciju (ranije je bila zelena i bez dejstva)", async () => {
    const bs = balanceSheet();
    bs.lines = bs.lines.filter((l) => l.aop !== "0456");
    const res = await service(book(), [bs, incomeStatement()]).evaluateControls(
      10,
    );
    const rule = byCode(res, "BS_GK_SAGLASNOST");
    expect(rule.status).toBe("NEPRIMENLJIVO");
    expect(rule.passed).toBe(false);
    expect(isBlockingFailure(rule)).toBe(true);
  });

  it("upozorenja NIKAD ne blokiraju finalizaciju", async () => {
    // Zatečena neuravnoteženost izvora (0,10) — kao 13 BigBit naloga na dev bazi.
    const b = book();
    b.push({
      id: 77,
      orderTypeCode: "AVANS",
      number: "0011",
      year: YEAR,
      lines: [
        { account: "2410", debit: "0.10" },
        { account: "2410", credit: "0" },
      ],
    });
    const res = await service(b, [
      balanceSheet({ "0040": "510.10", "0059": "1510.10" }),
      incomeStatement(),
    ]).evaluateControls(10);
    const warn = byCode(res, "GK_URAVNOTEZENA");
    expect(warn.status).toBe("UPOZORENJE");
    expect(warn.passed).toBe(false);
    expect(isBlockingFailure(warn)).toBe(false);
  });
});

describe("brojači se ne prikazuju kao iznosi", () => {
  it("pokrivenost i odsecanje nose valueKind=BROJ, ukrsna pravila IZNOS", async () => {
    const res = await service(book(), [
      balanceSheet(),
      incomeStatement(),
    ]).evaluateControls(10);
    expect(byCode(res, "AOP_POKRIVENOST").valueKind).toBe("BROJ");
    expect(byCode(res, "ODSECANJE_NA_NULU").valueKind).toBe("BROJ");
    expect(byCode(res, "BS_GK_SAGLASNOST").valueKind).toBe("IZNOS");
    expect(byCode(res, "GK_URAVNOTEZENA").valueKind).toBe("IZNOS");
  });
});

describe("SQL sirove strane nosi pretpostavke na kojima pravila stoje", () => {
  /**
   * Lažni Prisma ne izvršava telo upita, pa mutacija UNUTAR SQL-a (obrisan izuzetak
   * ZAK kontra-stavki, obrisan filter prenosnih konta 599/699) ne bi oborila nijedan
   * test. Ovaj test tvrdi šta u SQL-u MORA da stoji.
   */
  it("izuzima ZAK kontra-stavke (klase 5/6 i poreska) i prenosna konta 599/699", async () => {
    const prisma = new FakePrisma(book(), [balanceSheet(), incomeStatement()]);
    await new ControlRulesService(prisma as never).evaluateControls(11);
    const resultSql = prisma.seenSql.find((s) => s.includes("AS revenue"))!;
    expect(resultSql).toBeDefined();
    // ZAK izuzimanje mora postojati i mora pokrivati i klase i poreska konta.
    expect(resultSql).toContain("order_type_code");
    expect(resultSql.replace(/\s+/g, " ")).toMatch(
      /NOT \( COALESCE\(je\.order_type_code, ''\) = \? AND \( LEFT\(le\.account_code, 1\) IN \(\?,\?\) OR le\.account_code LIKE \? OR le\.account_code LIKE \? \) \)/,
    );
    // Prenosna konta se izuzimaju i iz prihoda i iz rashoda (dva puta po dva LIKE),
    // plus dva za poreska konta u `tax` i dva u ZAK izuzimanju.
    expect(
      (resultSql.match(/le\.account_code LIKE \?/g) ?? []).length,
    ).toBeGreaterThanOrEqual(8);
    // Prozor je JEDNA fiskalna godina (nalaz K1) i samo proknjiženi nalozi.
    for (const sql of prisma.seenSql) {
      expect(sql).toContain("je.year =");
      expect(sql).toContain("je.status IN");
    }
  });
});

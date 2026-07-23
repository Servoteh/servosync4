/**
 * BALANCE SHEET SERVICE — završni račun / bilansi (Faza 7).
 * =========================================================================
 * Generiše bilans stanja (BS), bilans uspeha (BU) i statistički izveštaj (SI)
 * iz bruto stanja glavne knjige (ledger_entries) preko `GkEvalService` formula-
 * engine-a, i snima ih kao `FinancialStatement` + `FinancialStatementLine`.
 *
 * TOK (doc 37 §C/§D):
 *   BalanceFormulaDefinition (po statementType, deklarativno, seed iz .MDB)
 *     ──► za svaku AOP pozicija: GkEvalService.evalFormula(formula, asOf, resolveAop)
 *        (A<aop> reference se rešavaju iz već izračunatih linija istog obrasca)
 *       ──► FinancialStatement(DRAFT) + FinancialStatementLine[] po AOP-u
 *
 * BEZ SEED-a (doc 37 §C, KRITIČNO): ako je BalanceFormulaDefinition za taj tip
 * prazna, `computeBalanceSheet`/`computeIncomeStatement` padaju na SIROVI BRUTO
 * BILANS — svako konto (Σdebit/Σcredit/saldo) kao jedna linija (formula=null),
 * uz upozorenje da pun AOP-bilans traži seed formula. `getGrossTrialBalance`
 * (GET /zavrsni/bruto-bilans) uvek radi, potpuno nezavisno od seed-a.
 *
 * OS POZICIJE (doc 37 §A/scope, Nenad 18.07): klasa 0 (zemljište/objekti/oprema)
 * se vode KOD KNJIGOVOĐE — te AOP linije se u obrascu čuvaju sa formula=null i
 * ručno unetim `amount` (MANUAL). Ovaj servis ih NE računa; ako u definiciji
 * pozicija ima formula="" ili "MANUAL", tretira se kao ručni unos (amount 0,
 * knjigovođa dopunjuje).
 *
 * DECIMAL, NIKAD FLOAT (BACKEND_RULES §2). Svi iznosi Prisma.Decimal.
 */

import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { GkEvalService } from "./gkeval.service";

const D = Prisma.Decimal;

/** Tipovi obrazaca (schema.prisma FinancialStatement.statementType). */
export const STATEMENT_TYPE = {
  BALANCE_SHEET: "BALANCE_SHEET", // BS / bilans stanja
  INCOME_STATEMENT: "INCOME_STATEMENT", // BU / bilans uspeha
  POPDV_ANNUAL: "POPDV_ANNUAL", // SI / statistički
} as const;

/** Ručni-unos marker u BalanceFormulaDefinition.formula (OS pozicije kod knjigovođe). */
const MANUAL_FORMULA_MARKERS = new Set(["", "MANUAL", "OS", "RUCNO"]);

export interface StatementLineResult {
  aop: string;
  label: string | null;
  amount: string; // Decimal → string (BACKEND_RULES §6)
  formula: string | null;
}

export interface StatementResult {
  id: number;
  statementType: string;
  periodYear: number;
  status: string;
  seeded: boolean; // false = pao na sirovi bruto bilans (nema AOP definicija)
  note?: string;
  lines: StatementLineResult[];
}

@Injectable()
export class BalanceSheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gkEval: GkEvalService,
  ) {}

  /**
   * Sirovi bruto bilans za godinu — svako konto Σdebit/Σcredit/saldo.
   * Uvek radi, bez ikakvog seed-a (doc 37 §C). asOf = 31.12. te godine.
   */
  async getGrossTrialBalance(year: number): Promise<{
    year: number;
    asOf: string;
    rows: Array<{
      accountCode: string;
      accountName: string | null;
      totalDebit: string;
      totalCredit: string;
      balance: string;
    }>;
    totals: { totalDebit: string; totalCredit: string; balance: string };
  }> {
    const asOf = endOfYear(year);
    const rows = await this.gkEval.grossTrialBalance(asOf);

    let sumDebit = new D(0);
    let sumCredit = new D(0);
    for (const r of rows) {
      sumDebit = sumDebit.add(r.totalDebit);
      sumCredit = sumCredit.add(r.totalCredit);
    }

    return {
      year,
      asOf: asOf.toISOString(),
      rows: rows.map((r) => ({
        accountCode: r.accountCode,
        accountName: r.accountName,
        totalDebit: r.totalDebit.toFixed(4),
        totalCredit: r.totalCredit.toFixed(4),
        balance: r.balance.toFixed(4),
      })),
      totals: {
        totalDebit: sumDebit.toFixed(4),
        totalCredit: sumCredit.toFixed(4),
        balance: sumDebit.sub(sumCredit).toFixed(4),
      },
    };
  }

  /** Bilans stanja (BS) za godinu. */
  async computeBalanceSheet(
    year: number,
    userId?: number,
  ): Promise<StatementResult> {
    return this.computeStatement(STATEMENT_TYPE.BALANCE_SHEET, year, userId);
  }

  /** Bilans uspeha (BU) za godinu. */
  async computeIncomeStatement(
    year: number,
    userId?: number,
  ): Promise<StatementResult> {
    return this.computeStatement(STATEMENT_TYPE.INCOME_STATEMENT, year, userId);
  }

  /** Lista sačuvanih obračuna (filtriranje po tipu/godini). */
  async listStatements(filter: {
    statementType?: string;
    year?: number;
  }): Promise<StatementResult[]> {
    const statements = await this.prisma.financialStatement.findMany({
      where: {
        statementType: filter.statementType,
        periodYear: filter.year,
      },
      orderBy: [{ periodYear: "desc" }, { statementType: "asc" }],
      include: { lines: { orderBy: { ordinal: "asc" } } },
    });

    return statements.map((s) => ({
      id: s.id,
      statementType: s.statementType,
      periodYear: s.periodYear,
      status: s.status,
      seeded: s.lines.some((l) => l.formula !== null),
      lines: s.lines.map((l) => ({
        aop: l.aop,
        label: l.label,
        amount: l.amount.toFixed(4),
        formula: l.formula,
      })),
    }));
  }

  // ── interno ────────────────────────────────────────────────────────────────

  /**
   * Generiše obračun za dati tip: učita AOP definicije; ako ih ima → GkEval po
   * svakoj (uz A<aop> reference); ako nema → sirovi bruto bilans po kontu.
   * Upsert-uje FinancialStatement (jedan po tip+godina) i re-kreira linije.
   */
  private async computeStatement(
    statementType: string,
    year: number,
    userId?: number,
  ): Promise<StatementResult> {
    const asOf = endOfYear(year);

    const definitions = await this.prisma.balanceFormulaDefinition.findMany({
      where: { statementType },
      orderBy: { ordinal: "asc" },
    });

    const seeded = definitions.length > 0;

    // Linije koje ćemo upisati: (aop, label, amount, formula, ordinal)
    const linesToWrite: Array<{
      aop: string;
      label: string | null;
      amount: Prisma.Decimal;
      formula: string | null;
      ordinal: number;
    }> = [];

    let note: string | undefined;

    if (seeded) {
      // Kešuj izračunate AOP vrednosti radi A/AB/AC<aop> referenci (isti obrazac).
      // BalanceSheetService trenutno drži JEDNU vrednost po AOP-u (kolona 1 =
      // `amount`); kolone 2/3 (AB/AC → Iznos_2/Iznos_3) nisu još modelovane u
      // financial_statement_lines, pa ih tretiramo kao 0 dok se ne dodaju (doc 44 §8 t.1).
      // Callback prima `column` (A→1, AB→2, AC→3) da bi motor mogao da razlikuje
      // AB/AC atome; ovde koristimo samo kolonu 1.
      const aopValues = new Map<string, Prisma.Decimal>();
      const resolveAop = (aop: string, column: 1 | 2 | 3): Prisma.Decimal =>
        column === 1 ? (aopValues.get(aop) ?? new D(0)) : new D(0);

      // ── ITERATIVNA KONVERGENCIJA (fixed-point) ──────────────────────────────
      // AOP formule sadrže FORWARD reference: npr. UKUPNA AKTIVA (0001 = A0002+A0044)
      // je prva po ordinalu, ali zavisi od pozicija koje se računaju kasnije. Jedan
      // prolaz po ordinalu bi te reference video kao 0 → UKUPNA AKTIVA = 0 (defekt B3).
      // Zato ponavljamo prolaze dok se mapa vrednosti ne stabilizuje (poređenje po
      // Decimal.equals), najviše MAX_ITER puta (BigBit ZR motor radi 7 prolaza, doc 44).
      // Isti put koristi i BILANS USPEHA (computeIncomeStatement → computeStatement),
      // pa i njegove A-reference (npr. NETO DOBITAK 1068 = A1064-A1066) konvergiraju.
      const MAX_ITER = 7;

      // Ručne (OS/knjigovođa) pozicije su fiksna 0 — upiši ih odmah da A-reference
      // na njih rade od prvog prolaza; formula-pozicije idu u iterativni skup.
      const formulaDefs: typeof definitions = [];
      for (const def of definitions) {
        if (MANUAL_FORMULA_MARKERS.has(def.formula.trim().toUpperCase())) {
          aopValues.set(def.aop, new D(0));
        } else {
          formulaDefs.push(def);
        }
      }

      for (let iter = 0; iter < MAX_ITER; iter++) {
        let changed = false;
        for (const def of formulaDefs) {
          // evalFormula rešava D/P/PSD/PSP iz baze (isto u svakom prolazu) i
          // A/AB/AC<aop> iz `aopValues` (menja se između prolaza dok ne konvergira).
          const next = await this.gkEval.evalFormula(def.formula, asOf, resolveAop);
          const prev = aopValues.get(def.aop);
          if (prev === undefined || !prev.equals(next)) {
            changed = true;
          }
          aopValues.set(def.aop, next);
        }
        // Stabilno — nema više promena; dalji prolazi bi dali isti rezultat.
        if (!changed) {
          break;
        }
      }

      // Emituj linije u redosledu obrasca (ordinal), sa konvergiranim vrednostima.
      for (const def of definitions) {
        const isManual = MANUAL_FORMULA_MARKERS.has(
          def.formula.trim().toUpperCase(),
        );
        linesToWrite.push({
          aop: def.aop,
          label: def.label,
          amount: aopValues.get(def.aop) ?? new D(0),
          formula: isManual ? null : def.formula,
          ordinal: def.ordinal,
        });
      }
    } else {
      // Fallback: sirovi bruto bilans, jedna linija po kontu (formula=null).
      note =
        "Nema seed-ovanih AOP formula (BalanceFormulaDefinition prazna za ovaj tip) — " +
        "vraćen sirovi bruto bilans po kontu. Pun AOP-bilans traži seed formula (doc 37 §F).";
      const rows = await this.gkEval.grossTrialBalance(asOf);
      let ordinal = 0;
      for (const r of rows) {
        linesToWrite.push({
          aop: r.accountCode, // AOP = konto u sirovom modu
          label: r.accountName,
          amount: r.balance,
          formula: null,
          ordinal: ordinal++,
        });
      }
    }

    // Persist: upsert zaglavlje + re-kreiraj linije u transakciji.
    const statement = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.financialStatement.findUnique({
        where: {
          statementType_periodYear: { statementType, periodYear: year },
        },
      });

      let statementId: number;
      if (existing) {
        // Ne diramo FINALIZED obračun (immutable posle predaje, doc 37 audit veza).
        if (existing.status === "FINALIZED") {
          throw new StatementFinalizedException(statementType, year);
        }
        statementId = existing.id;
        await tx.financialStatementLine.deleteMany({
          where: { statementId },
        });
      } else {
        const created = await tx.financialStatement.create({
          data: {
            statementType,
            periodYear: year,
            status: "DRAFT",
            createdByUserId: userId ?? null,
          },
        });
        statementId = created.id;
      }

      if (linesToWrite.length > 0) {
        await tx.financialStatementLine.createMany({
          data: linesToWrite.map((l) => ({
            statementId,
            aop: l.aop,
            label: l.label,
            amount: l.amount,
            formula: l.formula,
            ordinal: l.ordinal,
          })),
        });
      }

      return tx.financialStatement.findUniqueOrThrow({
        where: { id: statementId },
        include: { lines: { orderBy: { ordinal: "asc" } } },
      });
    });

    return {
      id: statement.id,
      statementType: statement.statementType,
      periodYear: statement.periodYear,
      status: statement.status,
      seeded,
      note,
      lines: statement.lines.map((l) => ({
        aop: l.aop,
        label: l.label,
        amount: l.amount.toFixed(4),
        formula: l.formula,
      })),
    };
  }
}

/** Obračun je FINALIZED (predat) — ne sme se ponovo generisati (doc 37 audit). */
export class StatementFinalizedException extends NotFoundException {
  readonly code = "ZR_STATEMENT_FINALIZED";
  constructor(statementType: string, year: number) {
    super(
      `Obračun ${statementType} za ${year} je FINALIZED (predat) — ponovno generisanje nije dozvoljeno.`,
    );
    this.name = "StatementFinalizedException";
  }
}

/** 31.12. HH:MM te godine (kraj poslovne godine, gornja granica postingDate). */
function endOfYear(year: number): Date {
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
}

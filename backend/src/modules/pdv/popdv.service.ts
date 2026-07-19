/**
 * POPDV SERVICE — obračun PDV prijave za period (Faza 6 §B).
 * =========================================================================
 * POPDV obrazac je DEKLARATIVAN (doc 18 §3.3): tabela `popdv_definitions`
 * (seed = 164 reda iz BB_POPDV_T.mdb) nosi za svaki AOP polje ILI direktnu
 * vrednost ILI formulu (`KxDef`) koja se evaluira nad drugim AOP-ovima /
 * PDV kontima. Engine: učitaj definiciju → evaluiraj formule → agregacija.
 *
 * FORMULA EVAL (kad seed postoji):
 *   Formula može referisati druge AOP-ove (npr. `1.5 = [1.1]+[1.2]+[1.3]+[1.4]`).
 *   Reference `[AOP]` se rekurzivno razrešavaju do direktnih vrednosti, pa se
 *   izraz evaluira Faza-1 safe parserom (`evaluateExpression` + Decimal adapter).
 *   Ciklusi se detektuju (throw). Direktna vrednost AOP (formula=null) = 0 dok
 *   se ne uveže punjenje POPDV kolona iz GK (POPDV_SemeKontaZaKnjizenje, Faza 6+).
 *
 * OSNOVNI OBRAČUN (uvek radi, i kad je definicija tabela prazna):
 *   outputVat = Σ izlazni PDV konta (VatAccountMap direction='output': 4700/4702/4710…)
 *   inputVat  = Σ ulazni PDV konta  (VatAccountMap direction='input':  2700/2710…)
 *   vatLiability = outputVat − inputVat  (obaveza za uplatu / povraćaj)
 *   → kreira VatReturn zaglavlje. Pun POPDV (164 AOP linije) traži seed
 *     `popdv_definitions` (dolazi kasnije) — dok je prazan, obračun je bez linija.
 *
 * Idempotentno po periodu: postojeći VatReturn za (godina, mesec/kvartal) se
 * ažurira (linije se rekreiraju), ne duplira (uq_vat_returns_period).
 */

import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { evaluateExpression } from "../gl/posting/expression-parser";
import { prismaDecimalArith } from "../gl/posting/prisma-decimal-arith";
import { InvalidVatPeriodException } from "./vat-ledger.service";

const D = Prisma.Decimal;
const ZERO = new D(0);

/** Ulaz obračuna: mesec (1..12) ILI kvartal (1..4), tačno jedan. */
export interface ComputePopdvInput {
  year: number;
  month?: number; // mesečni obveznik
  quarter?: number; // kvartalni obveznik
}

/** Rezultat obračuna (zaglavlje + linije). */
export interface PopdvResult {
  vatReturnId: number;
  periodYear: number;
  periodMonth: number | null;
  periodQuarter: number | null;
  outputVat: Prisma.Decimal;
  inputVat: Prisma.Decimal;
  vatLiability: Prisma.Decimal;
  lineCount: number;
  seededDefinition: boolean; // true = pun POPDV (linije iz popdv_definitions)
  note: string;
}

interface VatSumRow {
  direction: string;
  vat_amount: Prisma.Decimal | null;
}

@Injectable()
export class PopdvService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Obračun PDV za period. Vraća zaglavlje (output/input/obaveza) + linije po
   * AOP-u (ako je `popdv_definitions` seed-ovana). Osnovni obračun radi uvek.
   */
  async compute(input: ComputePopdvInput): Promise<PopdvResult> {
    const { year } = input;
    const { month, quarter } = this.resolvePeriod(input);

    // Meseci koji čine period (mesec = [m]; kvartal = 3 meseca).
    const months = this.periodMonths(month, quarter);

    // 1) Osnovni obračun — Σ PDV konta iz GK po smeru za period.
    const { outputVat, inputVat } = await this.sumVatAccounts(year, months);
    const vatLiability = outputVat.sub(inputVat);

    // 2) Pun POPDV (ako je definicija seed-ovana) — eval AOP formula.
    const definitions = await this.prisma.popdvDefinition.findMany({
      orderBy: { ordinal: "asc" },
    });
    const seeded = definitions.length > 0;

    return this.prisma.$transaction(async (tx) => {
      // Upsert zaglavlja po periodu (idempotentno; uq_vat_returns_period).
      const existing = await tx.vatReturn.findFirst({
        where: {
          periodYear: year,
          periodMonth: month ?? null,
          periodQuarter: quarter ?? null,
        },
      });

      const returnData = {
        periodYear: year,
        periodMonth: month ?? null,
        periodQuarter: quarter ?? null,
        status: "CALCULATED",
        outputVat,
        inputVat,
        vatLiability,
      };

      let vatReturn;
      if (existing) {
        await tx.vatReturnLine.deleteMany({
          where: { vatReturnId: existing.id },
        });
        vatReturn = await tx.vatReturn.update({
          where: { id: existing.id },
          data: returnData,
        });
      } else {
        vatReturn = await tx.vatReturn.create({ data: returnData });
      }

      // POPDV linije — samo ako je definicija seed-ovana.
      let lineCount = 0;
      if (seeded) {
        const aopValues = this.evaluateDefinitions(
          definitions,
          outputVat,
          inputVat,
        );
        const lines: Prisma.VatReturnLineCreateManyInput[] = definitions.map(
          (def) => ({
            vatReturnId: vatReturn.id,
            aop: def.aop,
            amount: aopValues.get(def.aop) ?? ZERO,
          }),
        );
        if (lines.length > 0) {
          await tx.vatReturnLine.createMany({ data: lines });
          lineCount = lines.length;
        }
      }

      const note = seeded
        ? `Pun POPDV obračun: ${lineCount} AOP linija iz popdv_definitions.`
        : "Osnovni obračun (Σ izlazni PDV − Σ ulazni PDV). Pun POPDV (164 AOP) " +
          "traži seed popdv_definitions — nije još učitan.";

      return {
        vatReturnId: vatReturn.id,
        periodYear: year,
        periodMonth: month ?? null,
        periodQuarter: quarter ?? null,
        outputVat,
        inputVat,
        vatLiability,
        lineCount,
        seededDefinition: seeded,
        note,
      };
    });
  }

  /** Lista sačuvanih PDV obračuna (opciono filter po godini). */
  async listReturns(year?: number) {
    return this.prisma.vatReturn.findMany({
      where: year != null ? { periodYear: year } : undefined,
      orderBy: [
        { periodYear: "desc" },
        { periodQuarter: "desc" },
        { periodMonth: "desc" },
      ],
      include: { lines: { orderBy: { aop: "asc" } } },
    });
  }

  // ── interno ────────────────────────────────────────────────────────────────

  /**
   * Σ PDV konta iz glavne knjige po smeru za period (osnovni obračun).
   *   output = Σ(kredit − debit) na 'output' kontima (47x — obaveza)
   *   input  = Σ(debit − kredit) na 'input'  kontima (27x — pretporez)
   * Samo proknjižen nalog (status = 'posted'), period po posting_date.
   */
  private async sumVatAccounts(
    year: number,
    months: number[],
  ): Promise<{ outputVat: Prisma.Decimal; inputVat: Prisma.Decimal }> {
    const rows = await this.prisma.$queryRaw<VatSumRow[]>(
      Prisma.sql`
        SELECT
          vam.direction AS direction,
          CASE
            WHEN vam.direction = 'output'
              THEN COALESCE(SUM(le.credit) - SUM(le.debit), 0)
            ELSE COALESCE(SUM(le.debit) - SUM(le.credit), 0)
          END AS vat_amount
        FROM ledger_entries le
        JOIN journal_entries je ON je.id = le.journal_entry_id
        JOIN vat_account_map vam ON vam.account = le.account_code
        WHERE je.status = 'posted'
          AND EXTRACT(YEAR FROM je.posting_date) = ${year}
          AND EXTRACT(MONTH FROM je.posting_date) IN (${Prisma.join(months)})
        GROUP BY vam.direction
      `,
    );

    let outputVat = ZERO;
    let inputVat = ZERO;
    for (const r of rows) {
      const v = new D(r.vat_amount ?? ZERO);
      if (r.direction === "output") outputVat = outputVat.add(v);
      else inputVat = inputVat.add(v);
    }
    return { outputVat, inputVat };
  }

  /**
   * Evaluira sve AOP definicije. Direktna vrednost (formula=null) je 0 dok se ne
   * uveže POPDV punjenje iz GK — izuzetak su dva markera koje popunjava osnovni
   * obračun ako ih formula referiše: [OUTPUT] i [INPUT] (Σ izlazni/ulazni PDV).
   * Formule se razrešavaju rekurzivno uz detekciju ciklusa.
   */
  private evaluateDefinitions(
    definitions: { aop: string; formula: string | null }[],
    outputVat: Prisma.Decimal,
    inputVat: Prisma.Decimal,
  ): Map<string, Prisma.Decimal> {
    const byAop = new Map<string, string | null>();
    for (const d of definitions) byAop.set(d.aop, d.formula);

    const resolved = new Map<string, Prisma.Decimal>();
    const inProgress = new Set<string>();

    const resolve = (aop: string): Prisma.Decimal => {
      if (resolved.has(aop)) return resolved.get(aop)!;
      if (inProgress.has(aop)) {
        throw new PopdvCycleException(aop);
      }
      inProgress.add(aop);

      const formula = byAop.get(aop) ?? null;
      let value: Prisma.Decimal;
      if (formula == null || formula.trim() === "") {
        // Direktna vrednost — bez POPDV GK punjenja je 0.
        value = ZERO;
      } else {
        value = this.evalFormula(formula, resolve, outputVat, inputVat);
      }

      inProgress.delete(aop);
      resolved.set(aop, value);
      return value;
    };

    for (const d of definitions) resolve(d.aop);
    return resolved;
  }

  /**
   * Evaluira jednu KxDef formulu. Reference `[AOP]` (i markeri [OUTPUT]/[INPUT])
   * se zamene numeričkim vrednostima preko jednoslovnih promenljivih, pa se
   * ostatak (+ − ( ) i brojevi) evaluira Faza-1 safe parserom nad Decimal-om.
   */
  private evalFormula(
    formula: string,
    resolve: (aop: string) => Prisma.Decimal,
    outputVat: Prisma.Decimal,
    inputVat: Prisma.Decimal,
  ): Prisma.Decimal {
    // Skupi sve reference [..] i dodeli im jednoslovne promenljive A, B, C…
    const vars: Record<string, Prisma.Decimal> = {};
    let nextVar = 65; // 'A'
    const substituted = formula.replace(/\[([^\]]+)\]/g, (_m, ref: string) => {
      if (nextVar > 90) {
        // > 'Z' — previše referenci za jednoslovni parser; deli formulu.
        throw new PopdvFormulaException(
          formula,
          "Formula ima više od 26 referenci (parser podržava A–Z).",
        );
      }
      const letter = String.fromCharCode(nextVar++);
      const key = ref.trim();
      const upper = key.toUpperCase();
      if (upper === "OUTPUT") vars[letter] = outputVat;
      else if (upper === "INPUT") vars[letter] = inputVat;
      else vars[letter] = resolve(key);
      return letter;
    });

    try {
      return evaluateExpression<Prisma.Decimal>(
        substituted,
        vars,
        prismaDecimalArith,
      );
    } catch (e) {
      throw new PopdvFormulaException(
        formula,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  /** Meseci koje period pokriva. Mesec → [m]; kvartal → 3 meseca. */
  private periodMonths(month: number | null, quarter: number | null): number[] {
    if (month != null) return [month];
    const q = quarter!;
    const start = (q - 1) * 3 + 1;
    return [start, start + 1, start + 2];
  }

  /** Normalizuj period: tačno jedan od month/quarter, u opsegu. */
  private resolvePeriod(input: ComputePopdvInput): {
    month: number | null;
    quarter: number | null;
  } {
    const { year, month, quarter } = input;
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new InvalidVatPeriodException(year, month ?? quarter ?? 0);
    }
    const hasMonth = month != null;
    const hasQuarter = quarter != null;
    if (hasMonth === hasQuarter) {
      throw new PopdvPeriodException(
        "Navedi tačno jedan period: mesec (1..12) ILI kvartal (1..4).",
      );
    }
    if (hasMonth && (month! < 1 || month! > 12)) {
      throw new InvalidVatPeriodException(year, month!);
    }
    if (hasQuarter && (quarter! < 1 || quarter! > 4)) {
      throw new PopdvPeriodException(`Nevalidan kvartal: ${quarter}.`);
    }
    return { month: hasMonth ? month! : null, quarter: hasQuarter ? quarter! : null };
  }
}

/** Nevalidan POPDV period (izbor mesec/kvartal). */
export class PopdvPeriodException extends Error {
  readonly code = "PDV_POPDV_PERIOD";
  constructor(message: string) {
    super(message);
    this.name = "PopdvPeriodException";
  }
}

/** Ciklus u POPDV AOP formulama (npr. 1.5 referiše sam sebe). */
export class PopdvCycleException extends Error {
  readonly code = "PDV_POPDV_CYCLE";
  constructor(public readonly aop: string) {
    super(`Ciklus u POPDV formulama kod AOP "${aop}".`);
    this.name = "PopdvCycleException";
  }
}

/** Neispravna POPDV formula (parser/eval greška). */
export class PopdvFormulaException extends Error {
  readonly code = "PDV_POPDV_FORMULA";
  constructor(
    public readonly formula: string,
    public readonly reason: string,
  ) {
    super(`Neispravna POPDV formula "${formula}": ${reason}`);
    this.name = "PopdvFormulaException";
  }
}
